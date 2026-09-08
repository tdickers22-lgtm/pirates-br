#!/usr/bin/env node
// FLORA DENSITY + COVER BUDGET — the two things that made every island read
// wrong before you ever counted a triangle.
//
// 1. POLAR SAMPLING. Every scatter loop in the world drew its distance from
//    the island centre as `dMin + u * (dMax - dMin)`: uniform in RADIUS. That
//    is uniform in the wrong variable. The expected count per annulus is then
//    flat, but an annulus's AREA grows linearly with r, so per-square-metre
//    density falls off as 1/r — the middle of every island came out roughly an
//    order of magnitude denser than its rim. A player walks out of a thicket
//    onto a bald coastal apron on every island at every seed (islandworld-13,
//    islandworld-14). `radialFill` maps the same single draw through the
//    inverse area CDF; this file measures the resulting histogram.
//
// 2. BALD LOW TIER. Ground cover hung off `if (!lowDetail)`, so the tier the
//    owner's north star cares most about — an integrated-GPU laptop — got
//    islands with NO grass at all while every other tier had a lawn. A ceiling
//    is a reason to draw less, not nothing. `coverBudget` replaces the gate;
//    this file asserts low is non-zero AND still cheaper than balanced.
//
// Pure logic: no stack, no browser, sub-second.
import { radialFill } from '../src/shared/props.ts';
import { coverBudget } from '../src/client/world/island/FoliageGeometry.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

/** Deterministic uniform stream, so a red run reproduces exactly. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Areal density per annulus for a radial sampler, normalised so a perfectly
 * area-uniform sampler reads 1.0 in every bin. Returns the per-bin values plus
 * the max/min ratio across them, which is the number that matters: it is the
 * factor by which the centre of the island out-vegetates the rim.
 */
function arealHistogram(sample, dMin, dMax, bins = 8, draws = 400_000) {
  const rng = mulberry32(0x5eed_1a11);
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < draws; i++) {
    const d = sample(rng(), dMin, dMax);
    let bin = Math.floor(((d - dMin) / (dMax - dMin)) * bins);
    if (bin < 0) bin = 0;
    if (bin >= bins) bin = bins - 1;
    counts[bin] += 1;
  }
  const density = counts.map((c, b) => {
    const r0 = dMin + ((dMax - dMin) * b) / bins;
    const r1 = dMin + ((dMax - dMin) * (b + 1)) / bins;
    const area = Math.PI * (r1 * r1 - r0 * r0);
    return c / draws / area;
  });
  const mean = density.reduce((a, b) => a + b, 0) / bins;
  const norm = density.map((d) => d / mean);
  return { norm, ratio: Math.max(...norm) / Math.min(...norm) };
}

const uniformRadius = (u, dMin, dMax) => dMin + u * (dMax - dMin);

console.log('\n── radial sampling: density must not pile into the middle ──');
// The two bands the world actually samples: the ground-cover lawn (0.06..0.92)
// and the server's biome scatter (widest spec band, 0.08..0.95).
for (const [label, dMin, dMax] of [
  ['ground cover 0.06..0.92', 0.06, 0.92],
  ['biome scatter 0.08..0.95', 0.08, 0.95],
  ['clutter band 0.2..0.8', 0.2, 0.8],
]) {
  const fixed = arealHistogram(radialFill, dMin, dMax);
  const old = arealHistogram(uniformRadius, dMin, dMax);
  const row = fixed.norm.map((v) => v.toFixed(2)).join(' ');
  expect(
    `${label}: centre/rim areal density within 1.5x (radialFill ${fixed.ratio.toFixed(2)}x, radius-uniform was ${old.ratio.toFixed(2)}x)`,
    fixed.ratio <= 1.5,
    `per-annulus normalised density: ${row}`,
  );
  // The control: if this ever stops being an improvement, the assertion above
  // is measuring nothing.
  expect(
    `${label}: the old radius-uniform draw really was lopsided (${old.ratio.toFixed(2)}x)`,
    old.ratio > 3,
  );
}

console.log('\n── radialFill contract ──');
expect('u=0 lands on dMin', Math.abs(radialFill(0, 0.06, 0.92) - 0.06) < 1e-9);
expect('u=1 lands on dMax', Math.abs(radialFill(1, 0.06, 0.92) - 0.92) < 1e-9);
expect('out-of-range draws are clamped, never NaN', Number.isFinite(radialFill(-1, 0.1, 0.9)) && Number.isFinite(radialFill(2, 0.1, 0.9)));
{
  let monotone = true;
  let prev = -1;
  for (let i = 0; i <= 200; i++) {
    const v = radialFill(i / 200, 0.08, 0.95);
    if (v < prev - 1e-12) monotone = false;
    prev = v;
  }
  expect('monotone in u (one draw in, one draw out — the seeded stream keeps its order)', monotone);
}

console.log('\n── cover budget: the low tier gets a lawn, and it is cheaper ──');
// Radii of the real roster's extremes: the smallest cay and the biggest isle.
for (const radius of [22, 42, 88]) {
  const low = coverBudget(radius, true);
  const balanced = coverBudget(radius, false);
  expect(`r=${radius}: low tier grass count > 0 (was 0 — bald islands)`, low.grassCap > 0, `low=${low.grassCap}`);
  expect(`r=${radius}: low tier is a budget, not parity (<=30% of balanced seeds)`, low.grassCap <= balanced.grassCap * 0.3 + 1, `low=${low.grassCap} balanced=${balanced.grassCap}`);
  expect(`r=${radius}: low tier tufts are cheaper per instance (${low.grassBlades} blades vs ${balanced.grassBlades})`, low.grassBlades < balanced.grassBlades);
  // 5 triangles a blade. The low dock-vista row in test-perf-budget measures
  // 515k triangles against a 580k ceiling: one island's lawn must stay a small
  // slice of that 65k of headroom.
  const lowTris = low.grassCap * low.grassBlades * 5;
  expect(`r=${radius}: low tier lawn <= 20k triangles per island (${(lowTris / 1000).toFixed(1)}k)`, lowTris <= 20_000);
  expect(`r=${radius}: low tier builds no fern rosettes or shell flecks`, low.fernCap === 0 && !low.shells);
  expect(`r=${radius}: balanced keeps its ferns and flecks`, balanced.fernCap > 0 && balanced.shells);
}

console.log(failures === 0 ? '\nPASS test-flora-density' : `\nFAIL test-flora-density (${failures})`);
process.exit(failures === 0 ? 0 : 1);
