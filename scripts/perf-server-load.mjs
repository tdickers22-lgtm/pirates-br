#!/usr/bin/env node
// N MATCHES ON ONE PROCESS, MID-MATCH — does the sim still make its tick, and
// is the (N+1)th crew TOLD, or quietly served a broken game? (ONLINE-01 phase
// 2, netcode-24, correctness-09.)
//
// A host degrades by dropping ticks, and it drops them for EVERYBODY at once:
// the thirteenth match does not make the thirteenth game bad, it makes all
// thirteen slow. This drives a real LobbyServer over real sockets: N full solo
// matches (16 ships: one idle human + 15 bots), each FAST-FORWARDED to t=300 s
// of real sim (bots sailed, fighting, holes, projectiles: the expensive part;
// the old 12 s window right after the build sampled berthed bots), then a
// measurement window with per-match tick ms (p50/p99) and /health's
// worstSimLagSec, then one more crew that must be refused with a message.
//
//   node --import tsx scripts/perf-server-load.mjs            # N = fly.toml PIRATES_BR_MAX_MATCHES (the shipped ceiling)
//   node --import tsx scripts/perf-server-load.mjs --report   # add matches one by one; print the max N with worstSimLagSec < 0.1
//   PIRATES_BR_LOAD_MATCHES=4      override N
//   PIRATES_BR_LOAD_SECONDS=12     measurement window (s)
//   PIRATES_BR_LOAD_FF_SECONDS=300 sim seconds each match is fast-forwarded to
//   PIRATES_BR_LOAD_MAX=12         --report ceiling
//
// On Fly (owner or deploy gate): fly ssh console -C "node --import tsx scripts/perf-server-load.mjs --report"
// Server-side only: no browser, no GPU. The fast-forward blocks the event loop
// (~10-30 s per match), then every match's wall clock is rebased so the blocked
// time is not counted as lag.
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const REPORT = process.argv.includes('--report');
const flyMax = (() => {
  try { return Number(readFileSync(new URL('../fly.toml', import.meta.url), 'utf8').match(/PIRATES_BR_MAX_MATCHES\s*=\s*"(\d+)"/)?.[1]); } catch { return NaN; }
})();
const N = Number(process.env.PIRATES_BR_LOAD_MATCHES ?? (Number.isFinite(flyMax) && flyMax > 0 ? flyMax : 2));
const N_MAX = Number(process.env.PIRATES_BR_LOAD_MAX ?? 12);
const WINDOW_SEC = Number(process.env.PIRATES_BR_LOAD_SECONDS ?? (REPORT ? 10 : 12));
const FF_SEC = Number(process.env.PIRATES_BR_LOAD_FF_SECONDS ?? 300);
/** The whole point of the ceiling: above this the sim is not keeping up. */
const WORST_SIM_LAG_BUDGET_SEC = 0.1;

// Read BEFORE importing the server: the ceiling is a module-load constant.
process.env.PIRATES_BR_MAX_MATCHES = String(REPORT ? N_MAX : N);
const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = new LobbyServer();
// A throwaway stats file: load matches must never land in data/stats.json.
const { StatsStore } = await import('../src/server/core/StatsStore.ts');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
server.stats = new StatsStore(`${mkdtempSync(`${tmpdir()}/pbr-load-`)}/stats.json`);
server.init(0);
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) throw new Error('LobbyServer never reported a bound port');
const PORT = server.boundPort;

function open(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  const errors = [];
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      seen.push(msg.type);
      if (msg.type === 'lobby_error') errors.push(msg.payload?.reason ?? '');
    } catch { seen.push('<unparsed>'); }
  });
  ws.on('error', () => {});
  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} };
  return {
    ws, seen, errors, name,
    ready: new Promise((resolve) => ws.once('open', resolve)),
    send,
    async joinSolo(bots) {
      send({ type: 'set_name', ts: Date.now(), payload: { name } });
      await sleep(30);
      send({ type: 'solo_start', ts: Date.now(), payload: { botCount: bots } });
    },
  };
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return { status: res.status, body: await res.json() };
}

// ── Mid-match machinery ───────────────────────────────────────────────────
const quantile = (xs, q) => { if (!xs.length) return NaN; const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(q * v.length))]; };
const known = new Set();
/** One more full solo match, fast-forwarded to FF_SEC; returns its row. */
async function addMatch(i) {
  const c = open(`Load${i}`);
  clients.push(c);
  await c.ready;
  await c.joinSolo(null);
  for (let k = 0; k < 150 && !c.seen.includes('join'); k += 1) await sleep(100);
  const m = [...server.matches.values()].find((x) => !known.has(x));
  if (!m) throw new Error(`match ${i} never started (${c.seen.slice(-5).join(',')}; ${c.errors.join(';')})`);
  known.add(m);
  // Mute the wire while fast-forwarding: ~9k snapshots queued to a blocked
  // local socket would be graded as window CPU afterwards.
  const muted = ['broadcast', 'broadcastVolatile', 'send'].filter((f) => typeof m[f] === 'function');
  for (const f of muted) m[f] = () => {};
  const t0 = performance.now();
  const cap = Math.ceil((FF_SEC + 60) * 1000 / 16);
  let n = 0;
  while (n < cap && !(m.state.phase === 'playing' && m.t >= FF_SEC) && m.state.phase !== 'ended') { m.tick(); n += 1; }
  for (const f of muted) delete m[f];
  const ffMs = performance.now() - t0;
  const ships = m.state.ships?.length ?? 0;
  const alive = m.state.shipsAlive ?? ships;
  return { i, t: m.t, phase: m.state.phase, ffMs, ticks: n, ships, alive };
}
/** The fast-forward blocked every other match's timer too: forget that time. */
function rebaseAll() {
  const wall = Date.now(); const perf = performance.now();
  for (const m of server.matches.values()) {
    if (m.state.phase === 'playing') m.playingSinceWallMs = wall - m.t * 1000;
    m.tickBacklogSec = 0; m.lastTickWallMs = perf; m.droppedTicks = 0;
    if (!m.__timed) {
      const tick = m.tick.bind(m);
      m.__tickMs = [];
      m.tick = (...args) => { const s0 = performance.now(); try { return tick(...args); } finally { m.__tickMs.push(performance.now() - s0); } };
      m.__timed = true;
    }
    m.__tickMs.length = 0;
    m.__lag0 = m.simLagSeconds();
  }
  for (const sess of server.clients?.values?.() ?? []) sess.lastSeenAt = wall;
}
async function measureWindow() {
  rebaseAll();
  await sleep(WINDOW_SEC * 1000);
  const h = await health();
  const per = [...server.matches.values()].map((m) => ({ p50: quantile(m.__tickMs, 0.5), p99: quantile(m.__tickMs, 0.99), n: m.__tickMs.length }));
  // Lag GROWN during the window, per match. The absolute /health value carried
  // a stale offset on the newest match in the first --report run (28.12 s at
  // N=4 = its own fast-forward time, with 0 dropped ticks and p99 5.2 ms), so
  // the budget grades what the window itself added; /health's value is printed.
  const lagGrowth = Math.max(0, ...[...server.matches.values()].map((m) => m.simLagSeconds() - (m.__lag0 ?? 0)));
  h.body.healthWorstSimLagSec = h.body.worstSimLagSec;
  h.body.worstSimLagSec = Number(lagGrowth.toFixed(3));
  return { h, per, p50: Math.max(...per.map((p) => p.p50)), p99: Math.max(...per.map((p) => p.p99)) };
}
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

const clients = [];
if (REPORT) {
  console.log(`Server load --report: up to ${N_MAX} full matches, each at t=${FF_SEC}s, ${WINDOW_SEC}s windows (budget worstSimLagSec < ${WORST_SIM_LAG_BUDGET_SEC})`);
  console.log('   N  ships  ff s  worstSimLagSec  dropped  tick p50 ms  tick p99 ms  (/health abs)');
  let maxOk = 0;
  for (let i = 0; i < N_MAX; i += 1) {
    const row = await addMatch(i);
    const w = await measureWindow();
    const lag = w.h.body.worstSimLagSec;
    console.log(`  ${String(i + 1).padStart(2)}  ${String(row.alive).padStart(5)}  ${(row.ffMs / 1000).toFixed(1).padStart(4)}  ${fmt(lag).padStart(14)}  ${String(w.h.body.droppedTicks).padStart(7)}  ${fmt(w.p50).padStart(11)}  ${fmt(w.p99).padStart(11)}  ${fmt(w.h.body.healthWorstSimLagSec)}`);
    if (!(typeof lag === 'number' && lag < WORST_SIM_LAG_BUDGET_SEC)) break;
    maxOk = i + 1;
  }
  const headroom = Math.max(1, Math.floor(maxOk / 1.3));
  console.log(`\nREPORT maxMatches=${maxOk} (worstSimLagSec < ${WORST_SIM_LAG_BUDGET_SEC}, full solo matches at t=${FF_SEC}s, ${WINDOW_SEC}s window${maxOk === N_MAX ? `, capped at PIRATES_BR_LOAD_MAX=${N_MAX}` : ''})`);
  console.log(`REPORT suggested PIRATES_BR_MAX_MATCHES=${headroom} (30% headroom)`);
  expect(`at least one mid-match full match holds the budget on this host`, maxOk >= 1);
  for (const c of clients) { try { c.ws.close(); } catch {} }
  await server.shutdown?.();
  console.log(failures === 0 ? '\nPASS server load report' : `\nFAIL server load report (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log(`Server load: ${N} full matches on one process, each fast-forwarded to t=${FF_SEC}s, ${WINDOW_SEC}s window`);
const buildStart = Date.now();
for (let i = 0; i < N; i += 1) {
  const row = await addMatch(i);
  console.log(`  match ${i + 1}: ${row.alive}/${row.ships} ships afloat at t=${row.t.toFixed(0)}s (${row.phase}), fast-forward ${(row.ffMs / 1000).toFixed(1)}s for ${row.ticks} ticks`);
  expect(`match ${i + 1} reached mid-match (t >= ${FF_SEC}s, still playing, >= 8 ships afloat)`, row.phase === 'playing' && row.t >= FF_SEC && row.alive >= 8, JSON.stringify(row));
}
const built = await health();
console.log(`  built ${built.body.matches}/${N} matches in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
expect(`${N} matches are live on one process`, built.body.matches === N, JSON.stringify(built.body));

// ── Let them run mid-match, then read the sim ──────────────────────────────
const w = await measureWindow();
const loaded = w.h;
const worst = loaded.body.worstSimLagSec;
const dropped = loaded.body.droppedTicks;
console.log(`  worstSimLagSec ${worst}  droppedTicks ${dropped}  clients ${loaded.body.clients}  tick p50 ${fmt(w.p50)} ms  p99 ${fmt(w.p99)} ms (worst match)`);
expect('every match ticked through the window (the timer was measured, not idle)', w.per.every((p) => p.n >= WINDOW_SEC * 30), JSON.stringify(w.per.map((p) => p.n)));
expect(`worstSimLagSec < ${WORST_SIM_LAG_BUDGET_SEC} at ${N} mid-match matches`,
  typeof worst === 'number' && worst < WORST_SIM_LAG_BUDGET_SEC,
  `worst=${worst} — this host cannot carry ${N} matches; lower PIRATES_BR_MAX_MATCHES`);
expect('/health answers 200 while healthy', loaded.status === 200);

// ── The ceiling refuses, and says so ───────────────────────────────────────
expect('/health reports the ceiling', loaded.body.maxMatches === N, `${loaded.body.maxMatches}`);
expect('/health says the host has stopped accepting', loaded.body.accepting === false,
  JSON.stringify({ accepting: loaded.body.accepting, matches: loaded.body.matches }));

const overflow = open('Overflow');
await overflow.ready;
await overflow.joinSolo(3);
await sleep(800);
expect('the crew above the ceiling is told, not silently dropped',
  overflow.errors.some((m) => /full/i.test(m)), JSON.stringify(overflow.errors));
expect('the refused crew never got a match', !overflow.seen.includes('join'), overflow.seen.join(','));
expect('the refused crew keeps its socket', overflow.ws.readyState === WebSocket.OPEN);
const after = await health();
expect('a refusal starts no match', after.body.matches === N, `${after.body.matches}`);

// ── The wire validator is visible from outside ─────────────────────────────
const before = after.body.rejectedFrames;
overflow.send({ type: 'state_snapshot', ts: Date.now(), payload: {} });
overflow.send({ type: 'solo_start', ts: Date.now(), payload: [] });
await sleep(300);
const counted = await health();
expect('/health counts refused frames', counted.body.rejectedFrames >= before + 2,
  `${before} → ${counted.body.rejectedFrames}`);

for (const c of [...clients, overflow]) { try { c.ws.close(); } catch {} }
await server.shutdown?.();
console.log(failures === 0 ? '\nPASS server load' : `\nFAIL server load (${failures})`);
process.exit(failures === 0 ? 0 : 1);
