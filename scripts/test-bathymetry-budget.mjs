#!/usr/bin/env node
// THE BATHYMETRY BUILD MUST NOT OWN THE FRAME.
//
// OceanBathymetry samples the shared terrain into a 1024² depth texture a few
// rows per frame after the join, on a `step(budgetMs = 2)` the ocean renderer
// calls from `update()`. A budget is only a budget if the deadline is READ
// often enough: a row of a large island is ~300 samples of the full relief
// field (ridges, cays, cave-relief blending) and cost ~1.5 ms on this Air, so a
// deadline checked once per row let most frames run 1-4 ms PAST the 2 ms it
// was given — for ~2,000 frames after every join, at the exact moment the
// first-draw reveal and the program warmer are also spending their allowances.
//
// RED ON 48bac595 (the pass that added the texture; per-row deadline):
//   steps 1956, overshoot p50 0.92 p90 2.52 p95 3.89 max 46.18 ms
// GREEN once the deadline is read every DEADLINE_STRIDE samples inside a row:
//   overshoot p50 0.08 p90 0.32 ms
//
// SINCE I.4 THE BAKE RUNS ON A WORKER (bathymetry.worker.ts) wherever a module
// worker can be constructed, so in a real client the main thread pays a
// postMessage and one texture upload and nothing else. What is exercised here
// is the FALLBACK — node has no global Worker, so `new OceanBathymetry(...)`
// takes the sliced main-thread path, which is exactly the path a locked-down
// CSP would take. It still has to hold its budget.
//
// AND THE BUILD'S SIZE IS NOW PINNED, not merely printed. The old gate bounded
// per-step overshoot and asserted `steps > 100`, which is a FLOOR: a sampler
// twice as heavy, or a 2048² texture, doubled the time the shoreline spends on
// the fallback estimate without turning anything red. `plannedSamples` is a
// pure function of the roster and the resolution — no timing, nothing a busy
// machine can move — so it is the thing to pin.
//
// WHAT IS ASSERTED AND WHY IT IS ROBUST TO A BUSY MACHINE. The build runs in
// this process at wall-clock speed, so interference (another suite, a headless
// Chromium, GC) can only make a step SLOWER. The median and the 90th percentile
// of the overshoot are therefore graded; the tail (p99, max) is printed as
// advisory because a pre-empted process cannot tell a stride overshoot from a
// scheduler stall. A per-row deadline fails the median by ~10x, so the gate
// cannot be fooled by noise in the direction that matters.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { OceanBathymetry } from '../src/client/rendering/OceanBathymetry.ts';

const MAP_SEED = Number.parseInt(process.env.PIRATES_BR_MAP_SEED ?? '20260801', 10) >>> 0;
const BUDGET_MS = 2;
/** Median overshoot ceiling: the cost of one deadline stride plus timer grain. */
const P50_MAX_MS = 0.25;
/** p90 ceiling: leaves room for a GC pause or two out of ~2,000 steps. */
const P90_MAX_MS = 1.0;

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
};

/** The full-resolution bake, measured on seed 20260801: 590,262 texels. */
const MAX_SAMPLES = 700_000;

const islands = new MapGenerator(MAP_SEED).generateIslands();
const bathy = new OceanBathymetry(islands);
const low = new OceanBathymetry(islands, 512);
// Warm the JIT on a couple of steps so the first-call compile does not sit in
// the graded distribution (it is a one-off the real client pays too, once).
for (let i = 0; i < 3 && !bathy.complete; i++) bathy.step(BUDGET_MS);

const over = [];
const t0 = performance.now();
while (!bathy.complete) {
  const s = performance.now();
  bathy.step(BUDGET_MS);
  over.push(performance.now() - s - BUDGET_MS);
}
const buildMs = performance.now() - t0;
const sorted = [...over].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const p50 = q(0.5), p90 = q(0.9), p99 = q(0.99), max = sorted[sorted.length - 1];

console.log(`Bathymetry build budget — seed ${MAP_SEED}, ${islands.length} islands, budget ${BUDGET_MS} ms/step`);
console.log(`  ${over.length} steps, ${buildMs.toFixed(0)} ms of build; overshoot p50 ${p50.toFixed(2)}  p90 ${p90.toFixed(2)}  p99 ${p99.toFixed(2)}  max ${max.toFixed(2)} ms (p99/max advisory)`);
check(over.length > 100, `the build is time-sliced over many frames (${over.length} steps)`, 'a build that finishes in a handful of steps is not sliced at all');
console.log(`  planned samples: ${bathy.plannedSamples.toLocaleString()} at 1024\u00b2, ${low.plannedSamples.toLocaleString()} at 512\u00b2 (low tier)`);
check(bathy.plannedSamples <= MAX_SAMPLES,
  `the bake evaluates ${bathy.plannedSamples.toLocaleString()} texels \u2264 ${MAX_SAMPLES.toLocaleString()}`,
  'the shoreline spends the whole bake on the ellipse estimate; doubling it doubles that');
check(low.plannedSamples <= bathy.plannedSamples * 0.30,
  `the low tier bakes ${(low.plannedSamples / bathy.plannedSamples * 100).toFixed(0)}% of the full-resolution texels`,
  'the tier that can least afford the bake is paying the same as the tier that can');
check(bathy.offThread === false, 'node has no module Worker, so this run graded the main-thread fallback');
check(bathy.complete, 'the build reports complete');
check(p50 <= P50_MAX_MS, `median overshoot ${p50.toFixed(2)} ms ≤ ${P50_MAX_MS} ms`, 'the deadline is not being read inside a row');
check(p90 <= P90_MAX_MS, `p90 overshoot ${p90.toFixed(2)} ms ≤ ${P90_MAX_MS} ms`, 'most frames pay well past the budget');

if (failures) { console.log(`\n${failures} bathymetry budget check(s) FAILED`); process.exit(1); }
console.log('\nBathymetry budget checks passed.');
