#!/usr/bin/env node
// performance-13 / vm:physics:5: the per-match server tick has a BUDGET.
//
// perf-server-load grades sim lag (the symptom); this grades ms/tick (the
// cost), so a feature that doubles the tick fails here before matches stack
// up on the VM. Harness pattern = test-match-determinism: a real Match, no
// sockets, match.tick() driven in a loop, timed by the Match's own
// TickProfiler (the same numbers /health reports behind HEALTH_KEY).
//
// Scenario: solo, 12 bot hulls, seed 20260801, bot early peace off, a
// fast-forward (not graded) until the fleet is out and shooting, then the
// storm is forced to a late phase (storm sea state everywhere) and 30 s of sim
// are graded: p99 <= 4.0 ms, p50 <= 2.0 ms per tick on this Air.
// The 1.5x noise allowance is PRINTED for the reader, never applied.
//
// Control (the gate is not blind): the same scenario with a 3 ms busy loop
// injected into updateWildlife must fail both limits. MUTATE=wildlife3ms runs
// the graded window itself mutated (the RED demonstration).

import { TICK_BUDGET } from './lib/budgets.mjs';

process.env.PIRATES_BR_MAP_SEED ??= '20260801';
process.env.BOT_EARLY_PEACE_SECONDS ??= '0';
const { Match } = await import('../src/server/core/Match.ts');
const { SERVER_TICK_MS } = await import('../src/shared/constants/index.ts');
const { stormSeaState } = await import('../src/server/systems/PhysicsSystem.ts');

const HULLS = 12;
const SECONDS = Number(process.env.SECONDS ?? 30);
const FF_SECONDS = Number(process.env.FF_SECONDS ?? 60);
const STORM_PHASE = 5;
const { p99Ms: P99_LIMIT, p50Ms: P50_LIMIT } = TICK_BUDGET;
const ALLOWANCE = 1.5;
const dt = SERVER_TICK_MS / 1000;

function spin(ms) { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } }

function run({ matchId, seconds, mutate }) {
  const match = new Match({ matchId, botCount: HULLS, mode: 'solo' });
  const state = match['state'];
  state.phase = 'playing';
  // No sockets: nothing to broadcast to, but the snapshot is still BUILT
  // every snapshot tick (buildWireSnapshot runs before broadcastVolatile).
  let shotsBefore = 0;
  const seen = new Set();
  const countShots = () => {
    for (const p of state.projectiles ?? []) if (!seen.has(p.id)) { seen.add(p.id); shotsBefore++; }
  };
  const ffTicks = Math.ceil(FF_SECONDS / dt);
  for (let i = 0; i < ffTicks && state.phase === 'playing'; i++) { match['tick'](); countShots(); }
  // Storm sea state: a late phase puts the ambient chop on every hull.
  state.storm.phase = STORM_PHASE;
  if (mutate) {
    const orig = match['updateWildlife'].bind(match);
    match['updateWildlife'] = (d) => { spin(3); return orig(d); };
  }
  const hullsAtStart = state.ships.filter((s) => s.alive && !s.sinking).length;
  const ffShots = shotsBefore;
  match.tickProfiler.reset();
  const steps = Math.ceil(seconds / dt);
  let seaSum = 0; let seaN = 0;
  const w0 = performance.now();
  for (let i = 0; i < steps && state.phase === 'playing'; i++) {
    match['tick']();
    countShots();
    if (i % 60 === 0) {
      for (const s of state.ships) {
        if (!s.alive || s.sinking) continue;
        seaSum += stormSeaState(state.storm, s.position.x, s.position.z); seaN++;
      }
    }
  }
  const wall = performance.now() - w0;
  match.stop?.();
  return {
    cost: match.tickCost(),
    hulls: state.ships.length,
    hullsAtStart,
    hullsAtEnd: state.ships.filter((s) => s.alive && !s.sinking).length,
    shotsInWindow: shotsBefore - ffShots,
    sea: seaN ? seaSum / seaN : 0,
    stormPhase: state.storm.phase,
    phase: state.phase,
    wall,
  };
}

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const fmt = (c) => `p50 ${c.p50Ms.toFixed(3)} ms, p99 ${c.p99Ms.toFixed(3)} ms, max ${c.maxMs.toFixed(2)} ms over ${c.n} ticks`;

const mutateMain = process.env.MUTATE === 'wildlife3ms';
const r = run({ matchId: 'tick-budget-A', seconds: SECONDS, mutate: mutateMain });
console.log(`scenario: seed ${process.env.PIRATES_BR_MAP_SEED}, ${r.hulls} hulls (${r.hullsAtStart} afloat at the window start, ${r.hullsAtEnd} at the end), `
  + `${r.shotsInWindow} projectiles fired in the window, storm phase ${r.stormPhase}, mean hull sea state ${r.sea.toFixed(2)}, `
  + `${SECONDS} s sim in ${(r.wall / 1000).toFixed(1)} s wall${mutateMain ? ' [MUTATED: 3 ms busy loop in wildlife]' : ''}`);
// The verdict is ms on THIS Air, so say how busy the Air was. Measured on the
// same code 2026-09-24: load1 1.78 -> p50 1.07 / p99 1.96 ms (green); a Swift
// build alongside, load1 4.85 -> p50 4.02 / p99 12.9 ms (the fanless Air
// throttles and the tick lands on an efficiency core). The flag is printed,
// the limits are never relaxed for it.
{
  const { loadavg, availableParallelism } = await import('node:os');
  const l1 = loadavg()[0]; const cores = availableParallelism();
  const busy = l1 > Math.max(2, cores / 4);
  console.log(`host load1 ${l1.toFixed(2)} on ${cores} cores${busy ? ' -- BUSY HOST: re-run on a quiet Air before reading these numbers' : ''}`);
}
console.log(`phases (mean ms/tick): ${Object.entries(r.cost.phasesMs).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`);
console.log(`noise allowance ${ALLOWANCE}x (printed, NOT applied): p99 would be allowed ${(P99_LIMIT * ALLOWANCE).toFixed(1)} ms, p50 ${(P50_LIMIT * ALLOWANCE).toFixed(1)} ms`);

ok(r.hulls === HULLS && r.hullsAtStart >= 10, `the scenario is a ${HULLS}-hull match with >= 10 afloat when grading starts (${r.hullsAtStart})`);
ok(r.shotsInWindow > 0, `the fleet is in combat during the window (${r.shotsInWindow} projectiles)`);
ok(r.sea >= 0.3, `storm sea state on the hulls (mean ${r.sea.toFixed(2)} >= 0.30)`);
ok(r.cost.n >= Math.floor(SECONDS / dt) - 1, `the profiler timed every playing tick (${r.cost.n})`);
ok(r.cost.p99Ms <= P99_LIMIT, `p99 ${r.cost.p99Ms.toFixed(3)} ms <= ${P99_LIMIT} ms (${fmt(r.cost)})`);
ok(r.cost.p50Ms <= P50_LIMIT, `p50 ${r.cost.p50Ms.toFixed(3)} ms <= ${P50_LIMIT} ms`);

if (!mutateMain) {
  const c = run({ matchId: 'tick-budget-A', seconds: 5, mutate: true });
  const blind = c.cost.p50Ms <= P50_LIMIT || c.cost.p99Ms <= P99_LIMIT;
  ok(!blind, `control: a 3 ms busy loop in wildlife breaks both limits (${fmt(c.cost)}, wildlife ${c.cost.phasesMs.wildlife.toFixed(2)} ms)`);
}

// /health detail (performance-13): the same TickProfiler numbers reach the
// keyed /health sims[] rows, including for a match living in a worker thread
// (b2.0b), where the lobby only sees it through MatchProxy's mirror.
if (process.env.HEALTH !== '0') {
  const { MatchWorkerHost } = await import('../src/server/core/MatchWorkerHost.ts');
  const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const host = new MatchWorkerHost(1, { testHooks: true });
  const server = new LobbyServer();
  try {
    const proxy = host.createMatch({ matchId: 'tick-budget-W', botCount: 3, mode: 'solo' });
    proxy.debug('forcePlaying');
    proxy.debug('step', 160);
    const cost = () => (typeof proxy.tickCost === 'function' ? proxy.tickCost() : null);
    for (let i = 0; i < 40 && !(cost()?.n > 0); i++) await sleep(50);
    const wc = cost();
    ok(!!wc && wc.n >= 64 && wc.p50Ms > 0 && wc.p99Ms >= wc.p50Ms,
      `a worker match's tick cost crosses the mirror (MatchProxy.tickCost: ${wc ? fmt(wc) : 'missing'})`);
    delete process.env.HEALTH_KEY;
    server.init(0);
    for (let i = 0; i < 50 && server.boundPort == null; i++) await sleep(100);
    server['matches'].set('tick-budget-W', proxy);
    const body = await (await fetch(`http://127.0.0.1:${server.boundPort}/health`)).json();
    server['matches'].delete('tick-budget-W');
    const row = Array.isArray(body.sims) ? body.sims[0] : undefined;
    ok(!!row && row.tickP50Ms > 0 && row.tickP99Ms >= row.tickP50Ms && row.tickP50Ms === proxy.tickCost?.()?.p50Ms,
      `/health detail sims[] carries tickP50Ms / tickP99Ms from the worker match (${JSON.stringify(row)})`);
  } finally {
    await server.shutdown?.('test', 0).catch(() => {});
    await host.close();
  }
}

console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-tick-budget');
process.exit(fails ? 1 : 0);
