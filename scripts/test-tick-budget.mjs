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

process.env.PIRATES_BR_MAP_SEED ??= '20260801';
process.env.BOT_EARLY_PEACE_SECONDS ??= '0';
const { Match } = await import('../src/server/core/Match.ts');
const { SERVER_TICK_MS } = await import('../src/shared/constants/index.ts');
const { stormSeaState } = await import('../src/server/systems/PhysicsSystem.ts');

const HULLS = 12;
const SECONDS = Number(process.env.SECONDS ?? 30);
const FF_SECONDS = Number(process.env.FF_SECONDS ?? 60);
const STORM_PHASE = 5;
const P99_LIMIT = 4.0;
const P50_LIMIT = 2.0;
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

console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-tick-budget');
process.exit(fails ? 1 : 0);
