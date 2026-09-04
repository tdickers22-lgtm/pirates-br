#!/usr/bin/env node
// PACING CURVE GATE (RNG-01) — opt-in, PACING=1. Can the pacing constants fail?
//
// Before this gate test-game-balance asserted constants against themselves and
// pacing-sim was an instrument nobody graded. This runs the seeded sim for
// RUNS (default 2) whole matches (MAX_MATCH_SECONDS each) and grades:
//   • PACING_TARGETS.BANDS on the mean crews afloat (150 s ∈ [9, 9], 360 s ∈ [4.5, 7]);
//     the 150 s band is a POINT on purpose — with the early-peace window every
//     crew is still afloat at 150 s, and [8, 9] let the no-window mutation
//     (one early sinking → 8.x) pass, so the gate could not fail,
//   • per-run end reason is printed (not graded: see the note below),
//   • the whole arc is printed so the later marks can be pinned once stable.
//
// Can it fail? BOT_EARLY_PEACE_SECONDS=0 PACING=1 node --import tsx scripts/test-pacing-curve.mjs
// removes the early-peace window (bots fight from the horn): the 150 s band must go red.
//
// Cost: minutes of CPU (a 13-minute match at full tick rate). Skipped unless
// PACING=1, and the runner reports that as SKIPPED, never PASS.
if (process.env.PACING !== '1') {
  console.log('SKIPPED test-pacing-curve: opt-in (PACING=1), minutes of sim');
  process.exit(0);
}
const { runPacing, gradeBands, MARKS } = await import('./pacing-sim.mjs');
const { PACING_TARGETS, BOT_EARLY_PEACE_SECONDS } = await import('../src/shared/constants/index.ts');

const RUNS = Number(process.env.RUNS ?? 2);
const minutes = PACING_TARGETS.MAX_MATCH_SECONDS / 60;
console.log(`test-pacing-curve: ${RUNS} seeded run(s) x ${minutes} min, seed ${process.env.PIRATES_BR_MAP_SEED}, `
  + `BOT_EARLY_PEACE_SECONDS=${BOT_EARLY_PEACE_SECONDS}`);
const t0 = performance.now();
const { rows, mean } = runPacing({ runs: RUNS, minutes });
console.log(`arc (mean afloat): ` + MARKS.map((m) => `${m}s=${mean[m].toFixed(1)}`).join('  ')
  + `  (${((performance.now() - t0) / 1000).toFixed(0)} s wall)`);

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
for (const g of gradeBands(mean, PACING_TARGETS.BANDS)) {
  ok(g.ok, `${g.mark}s: mean ${g.value.toFixed(2)} crews afloat in [${g.lo}, ${g.hi}]`);
}
// End reason is REPORTED, not graded. That note used to say no seeded bot-only
// match ever ends (3 crews still afloat at 1500 s); measured at 6acbc37a, seed
// 20260801, both runs END by last_ship at 779 s and 767 s, so the closed ring
// does finish a bot fleet now. Still not graded here: WHEN a match ends is the
// endgame lane's number, and grading it in the pacing gate would make one lane's
// re-band turn another lane's gate red. Grade it once END-01 lands.
for (const r of rows) {
  console.log(`  – ${r.matchId}: ${r.endReason === 'timeout' ? 'did not end' : `ended by ${r.endReason}`}`
    + ` at ${r.endT.toFixed(0)} s, ${r.endAlive} afloat`);
}
ok(rows.length === RUNS && RUNS >= 1, `${rows.length} run(s) graded`);
console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-pacing-curve');
process.exit(fails ? 1 : 0);
