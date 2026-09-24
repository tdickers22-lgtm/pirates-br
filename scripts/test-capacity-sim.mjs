#!/usr/bin/env node
/**
 * CAPACITY SIM on the REAL dispatch code (b1.2h, critique gap 1, D8/D10).
 *
 * The planner's queue model ($D/plan/capsim.py, capsim2.py) said late join +
 * the pressure window is what lets ONE machine at MAX_MATCHES 4 hold a
 * sustained 1 lone player/min at p95 wait <= 30 s, and MAX_MATCHES 6 carry
 * ~20 concurrent humans at 3/min. This suite re-derives that on the shipped
 * LobbyServer: its queue clocks, countdown swap, late join, capacity ceiling
 * and match GC all run for real; only the Match is a stub (LobbyServer.matchFactory)
 * whose humans leave 45 s after an elimination drawn from the pacing survival
 * curve (same curve as capsim.py: every hull alive to the truce at 150 s, 8 %
 * to the end of the 755 s arc). A stub hull is always eligible for late join
 * while >= 2 bot hulls remain; the REAL eligibility rules (holes, ring, enemy
 * range, quiet window, human range) are graded on the real Match by
 * test-queue-latency.
 *
 * Fake clock (Date.now), 1 s steps, 60 min of Poisson arrivals (70 % Solo /
 * 30 % Duos) per seed, 7 seeds per cell, no port, no timers.
 *
 * Gates:
 *   1/min at MAX_MATCHES=4 -> pooled p95 wait <= 30 s and 0 lobby_error
 *   3/min at MAX_MATCHES=6 -> pooled p95 wait <= 30 s and >= 18 mean concurrent humans
 *   MUTATION: pressure window off (lateJoinPressureSec = truce) -> the 1/min row FAILS
 * Prints the MAX_MATCHES x arrival-rate table for DEPLOY.md.
 *
 * --deployed [N] (b2.0c): grade the MAX_MATCHES that ships instead of the
 * table: N, else fly.toml's PIRATES_BR_MAX_MATCHES. FAILS unless 1 lone
 * player/min at that value waits <= 30 s at p95 with 0 lobby_error (the D8
 * bar), and prints the DEPLOY.md capacity-row figure: mean concurrent humans
 * at the highest arrival rate (1-3/min) that still meets p95 <= 30 s.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
const { MODES } = await import('../src/shared/constants/index.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── pacing survival curve (capsim.py) ─────────────────────────────────
const ARC = 755, COUNTDOWN = 8, LEAVE = 45, MINUTES = 60;
const CURVE = [[0, 1.0], [150, 1.0], [300, 0.83], [480, 0.63], [600, 0.4], [720, 0.17], [ARC, 0.08]];
function surv(t) {
  for (let i = 0; i + 1 < CURVE.length; i++) {
    const [t0, f0] = CURVE[i], [t1, f1] = CURVE[i + 1];
    if (t <= t1) return f0 + (f1 - f0) * (t - t0) / (t1 - t0);
  }
  return 0.08;
}
function deathTime(start, rng) {
  const u = rng() * surv(start);
  if (u < 0.08) return ARC;
  let lo = start, hi = ARC;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (surv(mid) > u) lo = mid; else hi = mid; }
  return lo;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── fake clock ────────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let clock = 1_800_000_000_000;
Date.now = () => clock;
const realLog = console.log;

let rng = Math.random;
/** playerId -> ms at which that human leaves (45 s after his elimination). */
const leaveAt = new Map();

class StubMatch {
  constructor({ matchId, botCount, mode }) {
    this.id = matchId; this.mode = mode; this.bots = botCount;
    this.clients = new Map(); this.hornAt = null; this.endedAt = null;
    this.onMatchEnd = null; this.onFault = null; this.n = 0;
  }
  start() { this.hornAt = Date.now() + COUNTDOWN * 1000; }
  stop() { this.stopped = true; }
  interrupt() {
    if (this.endedAt || !this.isPlaying()) return false;
    this.endedAt = Date.now();
    this.onMatchEnd?.({ reason: 'interrupted', humans: [] });
    return true;
  }
  isAwaitingHorn() { return !this.endedAt && Date.now() < this.hornAt; }
  isPlaying() { return !this.endedAt && Date.now() >= this.hornAt; }
  isEnded() { return !!this.endedAt; }
  endedAtMs() { return this.endedAt; }
  isQuarantined() { return false; }
  humanCount() { return this.clients.size; }
  botCrewCount() { return this.bots; }
  modeId() { return this.mode; }
  crewSize() { return MODES[this.mode].crewSize; }
  sinceHornSec() { return this.isPlaying() ? (Date.now() - this.hornAt) / 1000 : null; }
  stormPhase() { return 1; }
  retireBotHullBeforeHorn() {
    if (!this.isAwaitingHorn() || this.bots <= 0) return false;
    this.bots -= 1; return true;
  }
  createCrew(members) { return this.crew(members); }
  takeOverBotHull(members) {
    if (!this.isPlaying() || this.bots <= 1) return null;
    this.bots -= 1;
    return { ...this.crew(members), stormPhase: 1, sinceHornSec: this.sinceHornSec() };
  }
  crew(members) {
    const shipId = `${this.id}-s${this.n++}`;
    const since = Math.max(0, (Date.now() - this.hornAt) / 1000);
    const death = deathTime(since, rng);
    return {
      crewId: shipId, shipId,
      joins: members.map((mem, i) => {
        const playerId = `${shipId}-p${i}`;
        return {
          playerId, shipId,
          send: () => {
            this.clients.set(playerId, { ws: mem.ws });
            leaveAt.set(playerId, this.hornAt + (death + LEAVE) * 1000);
            return { playerId, shipId, snapshot: null };
          },
        };
      }),
    };
  }
  detachClient(playerId) { this.clients.delete(playerId); }
  removeClient(playerId) { this.clients.delete(playerId); }
  resumeClient() { return null; }
  resumeReplay() { return []; }
  markDisconnected() { return false; }
  handleClientMessage() {}
  simLagSeconds() { return 0; }
  droppedTickCount() { return 0; }
  step() {
    if (!this.endedAt && this.hornAt !== null && Date.now() > this.hornAt + (ARC + 30) * 1000) {
      this.endedAt = Date.now();
      this.onMatchEnd?.({ reason: 'ranked', humans: [] });
    }
  }
}

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.ping = () => {};
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  ws.terminate = ws.close;
  return ws;
}

function runCell(lambdaPerMin, maxMatches, seed) {
  rng = mulberry32(seed * 7919 + lambdaPerMin * 131 + maxMatches);
  const arrRng = mulberry32(seed * 104729 + lambdaPerMin);
  leaveAt.clear();
  LobbyServer.tunables.maxMatches = maxMatches;
  const stubs = new Set();
  LobbyServer.matchFactory = (opts) => { const m = new StubMatch(opts); stubs.add(m); return m; };
  const server = new LobbyServer();
  const T0 = clock;
  const arrivals = [];
  for (let t = 0; ;) {
    t += -Math.log(1 - arrRng()) * 60 / lambdaPerMin;
    if (t > MINUTES * 60) break;
    arrivals.push({ at: T0 + t * 1000, mode: arrRng() < 0.3 ? 'duos' : 'solo' });
  }
  const waits = [];
  let lobbyErrors = 0;
  let concSum = 0, concN = 0, peak = 0;
  const players = [];
  let ai = 0;
  const end = T0 + (MINUTES * 60 + 3000) * 1000;
  while (clock < end && (ai < arrivals.length || players.some((p) => p.waitingSince !== null))) {
    clock += 1000;
    while (ai < arrivals.length && arrivals[ai].at <= clock) {
      const a = arrivals[ai++];
      const ws = fakeSocket();
      const p = { ws, waitingSince: clock, left: false, playerId: null };
      ws.send = (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'lobby_error') lobbyErrors += 1;
        if (msg.type === 'match_start' && p.waitingSince !== null) { waits.push((clock - p.waitingSince) / 1000); p.waitingSince = null; }
      };
      server.onConnect(ws);
      const say = (type, payload = {}) => ws.emit('message', Buffer.from(JSON.stringify({ type, ts: clock, payload })), false);
      p.say = say;
      say('set_name', { name: `Cap${ai}` });
      say('queue_join', { mode: a.mode });
      players.push(p);
    }
    for (const m of stubs) m.step();
    // Humans leave 45 s after their elimination (or after the match ended).
    for (const p of players) {
      if (p.left || p.waitingSince !== null) continue;
      const s = [...server.clients.values()].find((c) => c.ws === p.ws);
      const id = s?.matchPlayerId;
      const due = id ? leaveAt.get(id) : undefined;
      if (s && (s.state === 'in_match' || s.state === 'match_ended') && due !== undefined && clock < due) continue;
      if (s && s.state === 'queue') continue;
      p.say('return_to_menu');
      p.ws.readyState = WebSocket.CLOSED;
      p.ws.emit('close', 1000, Buffer.alloc(0));
      p.left = true;
    }
    server.tick();
    for (const m of [...stubs]) if (m.stopped) stubs.delete(m);
    if (clock - T0 <= MINUTES * 60 * 1000) {
      let n = 0;
      for (const c of server.clients.values()) if (c.state === 'in_match') n += 1;
      concSum += n; concN += 1; peak = Math.max(peak, n);
    }
  }
  for (const p of players) if (p.waitingSince !== null) waits.push((clock - p.waitingSince) / 1000);
  for (const m of stubs) m.stop();
  return { waits, lobbyErrors, meanHumans: concSum / Math.max(1, concN), peak };
}

function cell(lambdaPerMin, maxMatches) {
  const all = [];
  let errors = 0, mean = 0, peak = 0;
  for (let seed = 0; seed < 7; seed++) {
    const r = runCell(lambdaPerMin, maxMatches, seed);
    all.push(...r.waits); errors += r.lobbyErrors; mean += r.meanHumans / 7; peak = Math.max(peak, r.peak);
  }
  all.sort((a, b) => a - b);
  const p95 = all.length ? all[Math.min(all.length - 1, Math.floor(0.95 * (all.length - 1)))] : 0;
  return { p95, errors, mean, peak, n: all.length };
}

if (typeof LobbyServer.matchFactory !== 'function' || typeof LobbyServer.tunables.lateJoinPressureSec !== 'number'
  || typeof LobbyServer.tunables.maxMatches !== 'number') {
  // Never fall through to real Matches here: an hour of real dispatch would
  // build dozens of full worlds.
  Date.now = realNow;
  console.error('  ✗ FAIL: LobbyServer has no matchFactory / late-join tunables / maxMatches: the dispatch cannot be driven');
  process.exit(1);
}
const DEPLOYED = process.argv.includes('--deployed');
if (DEPLOYED) {
  const { readFileSync } = await import('node:fs');
  const arg = Number(process.argv[process.argv.indexOf('--deployed') + 1]);
  const fly = Number(readFileSync(new URL('../fly.toml', import.meta.url), 'utf8').match(/PIRATES_BR_MAX_MATCHES\s*=\s*"(\d+)"/)?.[1]);
  const M = Number.isFinite(arg) && arg > 0 ? arg : fly;
  const started = realNow();
  let rowsD = [];
  try {
    if (!(M > 0)) { console.error('  ✗ FAIL: no MAX_MATCHES (fly.toml PIRATES_BR_MAX_MATCHES missing)'); process.exit(1); }
    console.log = () => {};
    for (const lam of [1, 2, 3]) {
      const r = cell(lam, M);
      rowsD.push({ lam, M, ...r });
      if (r.p95 > 30) break; // a higher rate cannot pass where a lower one failed
    }
  } finally {
    console.log = realLog;
    Date.now = realNow;
  }
  console.log(`deployed MAX_MATCHES ${M} (${Number.isFinite(arg) && arg > 0 ? '--deployed N' : 'fly.toml'})\n`);
  console.log('| arrivals/min | MAX_MATCHES | p95 wait (s) | mean humans | peak humans | lobby_error |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rowsD) console.log(`| ${r.lam} | ${r.M} | ${r.p95.toFixed(0)} | ${r.mean.toFixed(1)} | ${r.peak} | ${r.errors} |`);
  const passing = rowsD.filter((r) => r.p95 <= 30 && r.errors === 0);
  const humans = passing.length ? passing[passing.length - 1].mean : 0;
  console.log(`\nCAPACITY maxMatches=${M} humansAtP95Le30=${humans.toFixed(1)}`);
  const r1 = rowsD[0];
  expect(`D8 bar at the deployed MAX_MATCHES=${M}: 1 lone player/min waits <= 30 s at p95`, r1.p95 <= 30,
    `p95=${r1.p95.toFixed(1)} s over ${r1.n} crews: the queue shows position + ETA at peaks; lever ladder in DEPLOY.md (measured MAX_MATCHES >= 4 meets it)`);
  expect('  ...and 0 lobby_error', r1.errors === 0, `errors=${r1.errors}`);
  console.log(`(${((realNow() - started) / 1000).toFixed(1)} s)`);
  console.log(failures === 0 ? '\nAll capacity-sim --deployed assertions passed.' : `\n${failures} capacity-sim --deployed assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
const PRESSURE = LobbyServer.tunables.lateJoinPressureSec;
const TRUCE = LobbyServer.tunables.lateJoinTruceSec;
const started = realNow();
const rows = [];
try {
  console.log = () => {}; // the lobby logs every dispatch; keep the table readable
  for (const lam of [1, 2, 3]) {
    for (const M of [2, 4, 6]) rows.push({ lam, M, ...cell(lam, M) });
  }
  LobbyServer.tunables.lateJoinPressureSec = TRUCE;
  const mutant = cell(1, 4);
  LobbyServer.tunables.lateJoinPressureSec = PRESSURE;
  console.log = realLog;

  console.log(`late join: truce ${TRUCE} s, pressure ${PRESSURE} s; 60 min x 7 seeds per cell, 70/30 Solo/Duos\n`);
  console.log('| arrivals/min | MAX_MATCHES | p95 wait (s) | mean humans | peak humans | lobby_error |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.lam} | ${r.M} | ${r.p95.toFixed(0)} | ${r.mean.toFixed(1)} | ${r.peak} | ${r.errors} |`);
  console.log(`\nmutation (pressure window off) 1/min @ 4: p95 ${mutant.p95.toFixed(0)} s\n`);

  const r14 = rows.find((r) => r.lam === 1 && r.M === 4);
  const r36 = rows.find((r) => r.lam === 3 && r.M === 6);
  expect('1 lone player/min at MAX_MATCHES=4: p95 wait <= 30 s', r14.p95 <= 30, `p95=${r14.p95.toFixed(1)} s over ${r14.n} crews`);
  expect('  ...and 0 lobby_error', r14.errors === 0, `errors=${r14.errors}`);
  expect('3/min at MAX_MATCHES=6: p95 wait <= 30 s', r36.p95 <= 30, `p95=${r36.p95.toFixed(1)} s`);
  expect('  ...with >= 18 mean concurrent humans', r36.mean >= 18, `mean=${r36.mean.toFixed(1)}`);
  expect('  ...and 0 lobby_error', r36.errors === 0, `errors=${r36.errors}`);
  expect('no cell ever sent a lobby_error', rows.every((r) => r.errors === 0));
  expect('MUTATION: with the pressure window off the 1/min @ 4 row FAILS the bar (the gate can fail)', mutant.p95 > 30,
    `mutant p95=${mutant.p95.toFixed(1)} s`);
} finally {
  console.log = realLog;
  Date.now = realNow;
}
console.log(`(${((realNow() - started) / 1000).toFixed(1)} s)`);
if (failures > 0) {
  console.error(`\n${failures} capacity-sim assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll capacity-sim assertions passed.');
process.exit(0);
