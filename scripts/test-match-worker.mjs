#!/usr/bin/env node
// MATCH WORKER HOST (b2.0b, critique-01, D8 lever 3).
//
// The sim is single-threaded Node: a second vCPU buys nothing until matches
// run in worker_threads. MatchWorkerHost moves each Match into a worker and
// hands LobbyServer a MatchProxy with the same synchronous surface. This gate
// proves the move is invisible to a client and safe for the other matches:
//
//  1. DETERMINISM: the same seed and the same scripted inputs give a
//     bit-identical byte stream (every frame, in order) in-process vs through
//     the host over 60 s of sim (3750 ticks at 16 ms). Both sides preload the
//     same seeded id source and stepped clock, so the only difference left is
//     the worker boundary itself.
//  2. SEAT LIFECYCLE across the boundary: createCrew + join send, markDisconnected,
//     resumeClient on a NEW socket (frames move to it), resumeReplay,
//     detachClient, removeClient(closeWs) closing the real socket.
//  3. FAULT ISOLATION re-run through the host (test-match-fault-isolation's
//     contract): a throwing tick quarantines only its own match (onFault once,
//     match_ended{server_fault}), the neighbour in the SAME worker keeps
//     ticking; a worker thread that dies faults only the matches it hosts.
//
//  5. SHUTDOWN: a drained LobbyServer.shutdown() terminates its worker threads.
//
// No browser. Worker threads (one Match each, a few seconds); section 5 binds
// an ephemeral port (init(0)) for a real LobbyServer.
import { readFileSync } from 'node:fs';

const SEED = '20260801';
process.env.PIRATES_BR_MAP_SEED = SEED;
const T0 = 1_790_000_000_000;
const TICKS = 3750; // 60 s at SERVER_TICK_MS = 16
// Test-only preload, evaluated before Match (and uuid) load on BOTH sides.
const PRELOAD = `import crypto from 'node:crypto';
let n = 0; crypto.randomUUID = () => '00000000-0000-4000-8000-' + (++n).toString(16).padStart(12, '0');
let t = ${T0}; Date.now = () => t; globalThis.__pbrClockStep = (ms) => { t += ms; };`;
const PRELOAD_URL = `data:text/javascript,${encodeURIComponent(PRELOAD)}`;
await import(PRELOAD_URL);
const { Match } = await import('../src/server/core/Match.ts');
const { MatchWorkerHost, matchWorkerCountFromEnv } = await import('../src/server/core/MatchWorkerHost.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
let uncaught = 0;
process.on('uncaughtException', (e) => { uncaught += 1; console.error('uncaught:', e); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function recordingWs() {
  const closeHandlers = [];
  const ws = { frames: [], readyState: 1, bufferedAmount: 0, closedWith: null,
    send(d) { this.frames.push(typeof d === 'string' ? d : Buffer.from(d).toString('base64')); },
    close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = { code, reason }; for (const h of closeHandlers) h(); },
    on(ev, h) { if (ev === 'close') closeHandlers.push(h); return this; }, once(ev, h) { return this.on(ev, h); },
    removeListener() { return this; }, ping() {}, terminate() { this.close(1006); } };
  return ws;
}
const input = (i) => ({ type: 'player_input', ts: 0, payload: {
  seq: i + 1, yaw: Math.sin(i / 90) * 2, pitch: 0, forward: (i % 400) < 260, back: false,
  left: (i % 700) > 600, right: false, jump: i % 331 === 0, jumpPressed: i % 331 === 0,
  fire: false, aim: false, interact: false } });

console.log('Match worker host (a match in a worker_thread is invisible to its clients)');
expect('PIRATES_BR_MATCH_WORKERS: unset/0 -> in-process, 2 -> 2, auto -> vCPU count or 0 on one vCPU',
  matchWorkerCountFromEnv({}) === 0 && matchWorkerCountFromEnv({ PIRATES_BR_MATCH_WORKERS: '0' }) === 0
  && matchWorkerCountFromEnv({ PIRATES_BR_MATCH_WORKERS: '2' }) === 2 && matchWorkerCountFromEnv({ PIRATES_BR_MATCH_WORKERS: 'x' }) === 0);

// ── 1. determinism ────────────────────────────────────────────────────────
const t1 = Date.now;
const local = new Match({ matchId: 'det-1', botCount: 3, mode: 'solo' });
const lws = recordingWs();
const lj = local.addHumanClient(lws, 'Crew-det');
local.state.phase = 'playing'; local.countdownRemaining = 0; local.state.countdownRemaining = 0;
for (let i = 0; i < TICKS; i++) { local.handleClientMessage(lj.playerId, input(i)); globalThis.__pbrClockStep(16); local.tick(); }
local.stop();
void t1;

const host = new MatchWorkerHost(1, { testHooks: true, preload: PRELOAD_URL });
try {
  const proxy = host.createMatch({ matchId: 'det-1', botCount: 3, mode: 'solo' });
  const wws = recordingWs();
  const wj = proxy.debug('addHuman', proxy.socketId(wws), 'Crew-det');
  proxy.debug('forcePlaying');
  const w0 = performance.now();
  for (let i = 0; i < TICKS; i++) { proxy.handleClientMessage(wj.playerId, input(i)); proxy.debug('step', 1); }
  const wallMs = performance.now() - w0;
  expect('the join snapshot is identical (same playerId, same world)', JSON.stringify(wj) === JSON.stringify(lj),
    `${wj.playerId} vs ${lj.playerId}`);
  let firstDiff = -1;
  for (let i = 0; i < Math.max(lws.frames.length, wws.frames.length); i++) if (lws.frames[i] !== wws.frames[i]) { firstDiff = i; break; }
  const bytes = (f) => f.reduce((n, s) => n + s.length, 0);
  expect(`60 s byte stream bit-identical in-process vs worker (${lws.frames.length} frames, ${bytes(lws.frames)} bytes)`,
    lws.frames.length > 1000 && firstDiff === -1,
    firstDiff === -1 ? `only ${lws.frames.length} frames` : `frame ${firstDiff}/${lws.frames.length} vs ${wws.frames.length}: ${String(lws.frames[firstDiff]).slice(0, 160)} | ${String(wws.frames[firstDiff]).slice(0, 160)}`);
  expect('the mirror follows the worker (tickCount, humanCount)', proxy.mirror.tickCount === local.tickCount && proxy.humanCount() === 1,
    `tick ${proxy.mirror.tickCount} vs ${local.tickCount}, humans ${proxy.humanCount()}`);
  console.log(`    (worker drive: ${TICKS} cast+sync round trips in ${wallMs.toFixed(0)} ms)`);

  // ── 2. seat lifecycle across the boundary ────────────────────────────────
  const a = recordingWs(); const b = recordingWs();
  const crew = proxy.createCrew([{ ws: a, name: 'Anne' }, { ws: b, name: 'Bonny' }]);
  const joined = crew?.joins.map((j) => j.send()) ?? [];
  expect('createCrew over the port: two joins, send() returns each snapshot', crew && joined.length === 2
    && joined.every((j, k) => j.playerId === crew.joins[k].playerId && j.snapshot?.players?.length > 0));
  const [ja, jb] = joined;
  proxy.debug('step', 5);
  const aBefore = a.frames.length;
  expect('the crew receives the stream on its real sockets', aBefore > 0 && b.frames.length > 0);
  expect('markDisconnected answers synchronously', proxy.markDisconnected(ja.playerId) === true);
  a.close(1006); // the lobby's socket drops; the worker must stop writing to it
  const a2 = recordingWs();
  const resumed = proxy.resumeClient(ja.playerId, a2);
  expect('resumeClient on a NEW socket returns the seat and a snapshot', resumed?.playerId === ja.playerId && !!resumed.snapshot);
  expect('resumeReplay crosses the boundary (array of frames)', Array.isArray(proxy.resumeReplay(ja.playerId)));
  proxy.debug('step', 5);
  expect('after resume the frames go to the new socket, not the dead one', a2.frames.length > 0 && a.frames.length === aBefore,
    `new ${a2.frames.length}, old ${a.frames.length - aBefore} extra`);
  proxy.detachClient(ja.playerId);
  proxy.removeClient(jb.playerId, true);
  proxy.debug('step', 1);
  expect('detachClient + removeClient leave only the first human (mirror humanCount 1)', proxy.humanCount() === 1, `${proxy.humanCount()}`);
  expect('removeClient(closeWs) closes the real socket', b.readyState === 3 && b.closedWith?.reason === 'removed from match',
    JSON.stringify(b.closedWith));
  proxy.stop();
} finally { await host.close(); }

// ── 3. fault isolation through the host ───────────────────────────────────
const fh = new MatchWorkerHost(2, { testHooks: true });
try {
  const A = fh.createMatch({ matchId: 'fault-A', botCount: 2, mode: 'solo' });
  const C = fh.createMatch({ matchId: 'fault-C', botCount: 2, mode: 'solo' });
  const B = fh.createMatch({ matchId: 'fault-B', botCount: 2, mode: 'solo' });
  expect('matches spread across workers (A, C on different workers; B shares A\'s)',
    A.workerIndex !== C.workerIndex && B.workerIndex === A.workerIndex, `${A.workerIndex}/${C.workerIndex}/${B.workerIndex}`);
  const aws = recordingWs(); const bws = recordingWs();
  A.debug('addHuman', A.socketId(aws), 'Crew-A'); B.debug('addHuman', B.socketId(bws), 'Crew-B');
  let aFaults = 0; let cFaults = 0; let bFaults = 0;
  A.onFault = () => { aFaults += 1; }; B.onFault = () => { bFaults += 1; }; C.onFault = () => { cFaults += 1; };
  A.start(); B.start(); C.start();
  A.debug('forcePlaying'); B.debug('forcePlaying');
  A.debug('injectTickFault');
  const b0 = B.debug('tickCount');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (aFaults === 0 || B.mirror.tickCount - b0 < 20)) await wait(20);
  await wait(150);
  expect('a throwing tick quarantines ONLY its match: A onFault once, quarantined', aFaults === 1 && A.isQuarantined(), `${aFaults} faults`);
  expect("A's client got match_ended{server_fault}", aws.frames.some((f) => /"type":"match_ended"[\s\S]*"server_fault"/.test(f)));
  expect('B, in the SAME worker, kept ticking and was never faulted', B.mirror.tickCount - b0 >= 20 && bFaults === 0 && !B.isQuarantined(),
    `B +${B.mirror.tickCount - b0} ticks, ${bFaults} faults`);
  expect("B's client got no match_ended", !bws.frames.some((f) => f.includes('"type":"match_ended"')));
  // A worker THREAD that dies takes only its own matches.
  const c0 = C.mirror.tickCount;
  try { C.debug('crashWorker'); } catch {}
  const d2 = Date.now() + 3000;
  while (Date.now() < d2 && cFaults === 0) await wait(20);
  const bt = B.mirror.tickCount;
  await wait(300);
  expect('a dead worker faults its match (onFault once, quarantined)', cFaults === 1 && C.isQuarantined(), `${cFaults}, ticks ${c0}`);
  expect('the other worker\'s match keeps ticking after the crash', B.mirror.tickCount > bt && bFaults === 0, `${bt} -> ${B.mirror.tickCount}`);
  expect('a new match avoids the dead worker', fh.createMatch({ matchId: 'after', botCount: 1, mode: 'solo' }).workerIndex === B.workerIndex);
  expect('nothing reached process uncaughtException', uncaught === 0, `${uncaught}`);
} finally { await fh.close(); }

// ── 4. wiring ─────────────────────────────────────────────────────────────
const LOBBY = readFileSync(new URL('../src/server/core/LobbyServer.ts', import.meta.url), 'utf8');
expect('LobbyServer.matchFactory builds through MatchWorkerHost when PIRATES_BR_MATCH_WORKERS is set',
  /matchFactory[\s\S]{0,400}matchWorkerHost\(\)[\s\S]{0,120}createMatch\(opts\)/.test(LOBBY));
expect('LobbyServer holds matches as MatchHandle (proxy or Match), not Match', /Map<string, MatchHandle>/.test(LOBBY) && !/:\s*Match\b(?!Handle)/.test(LOBBY));

// ── 5. shutdown ends the worker threads ───────────────────────────────────
// A live worker keeps the event loop alive: a drained LobbyServer.shutdown()
// must terminate them, or the deploy's SIGTERM path (and any test that shuts
// a worker lobby down without process.exit) hangs on the threads.
console.log('\n5  LobbyServer.shutdown() terminates its match workers');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
  const { StatsStore } = await import('../src/server/core/StatsStore.ts');
  const TMP = mkdtempSync(path.join(tmpdir(), 'pbr-mw-'));
  const prev = process.env.PIRATES_BR_MATCH_WORKERS;
  process.env.PIRATES_BR_MATCH_WORKERS = '1';
  const server = new LobbyServer();
  server.stats = new StatsStore(path.join(TMP, 'stats.json'));
  server.init(0);
  let exited = 0;
  try {
    const lh = LobbyServer.matchWorkerHost();
    expect('PIRATES_BR_MATCH_WORKERS=1 gives the lobby a host with one worker', lh?.workerCount === 1);
    for (const w of lh?.workers ?? []) w.worker.once('exit', () => { exited += 1; });
    await Promise.race([server.shutdown('test-match-worker', 0), wait(8000)]);
    // performance.now(): the section-1 preload froze Date.now to a stepped clock.
    const d = performance.now() + 3000;
    while (performance.now() < d && exited === 0) await wait(20);
    expect('shutdown() terminated the worker thread', exited === 1, `${exited} exits`);
    expect('the lobby dropped its host (a later matchWorkerHost() starts fresh)', LobbyServer.workerHost === undefined);
  } finally {
    if (prev === undefined) delete process.env.PIRATES_BR_MATCH_WORKERS; else process.env.PIRATES_BR_MATCH_WORKERS = prev;
    if (exited === 0) { try { await LobbyServer.workerHost?.close(); } catch {} }
    LobbyServer.workerHost = undefined;
    rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nPASS match worker host' : `\nFAIL match worker host (${failures})`);
process.exit(failures === 0 ? 0 : 1);
