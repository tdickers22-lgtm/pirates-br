#!/usr/bin/env node
// COAST WOBBLE CONTRACT.
//
// The island cap, the shore skirt and the LOD proxy are three meshes sampled at
// three different resolutions off ONE curve — `coastWobble`, which bends the
// ring radius by angle so the shallow shelf stops ending on a perfect circle
// and the heightfield's terraces stop landing as concentric arcs.
//
// Three ways that curve can wreck the world, all of them silent:
//
//   1. RING INVERSION. The wobble is a function of distRatio as well as angle
//      (it ramps in), so if its slope ever exceeds 1 an outer ring crosses
//      inside its neighbour and the cap folds through itself. The amplitudes
//      and the ramp width are a budget; this is the invariant that budget buys.
//   2. A SEAM. The skirt has 44 segments and the proxy 30 against the cap's
//      176: if the curve carries frequencies those cannot resolve, the meshes
//      trace different coasts and daylight opens between them.
//   3. A MOVED INTERIOR. Props are seated and the player walks on ground that
//      must not shift, so nothing inside the ramp's foot may move at all.
//
// Plus: the curve must be periodic in angle (segment 0 and segment N are the
// SAME vertex — disagree and the coast splits along a meridian) and pure.
//
//   node --import tsx scripts/test-coast-wobble.mjs
import { coastWobble } from '../src/client/world/island/TerrainMeshBuilder.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

/** A spread of profiles wide enough that no single phase can pass by luck. */
const ISLANDS = [];
for (let a = 0; a < 12; a++) {
  for (let b = 0; b < 5; b++) {
    ISLANDS.push({
      profile: {
        ridgeAxis: (a / 12) * Math.PI * 2,
        primaryHillAngle: (b / 5) * Math.PI * 2 + 0.37,
      },
    });
  }
}
const TAU = Math.PI * 2;

console.log('Coast wobble contract');

// ── 1. RINGS STAY ORDERED ──
// Walk distRatio finer than the densest ring spacing the cap ever uses
// (shoreRingSpan 0.16 over 5 rings = 0.032) and demand strict growth.
{
  let worstStep = Infinity;
  let worstAt = null;
  for (const island of ISLANDS) {
    for (let s = 0; s < 96; s++) {
      const angle = (s / 96) * TAU;
      let prev = coastWobble(island, 0, angle);
      for (let d = 0.004; d <= 1.24; d += 0.004) {
        const cur = coastWobble(island, d, angle);
        const step = cur - prev;
        if (step < worstStep) {
          worstStep = step;
          worstAt = { ridge: island.profile.ridgeAxis.toFixed(2), angle: angle.toFixed(2), d: d.toFixed(3) };
        }
        prev = cur;
      }
    }
  }
  expect(
    'every ring lands outside the one inside it (no fold-through)',
    worstStep > 0,
    `tightest advance ${worstStep.toFixed(5)} at ${JSON.stringify(worstAt)}`,
  );
  // Not merely positive — with headroom, so a later amplitude tweak that eats
  // the budget fails here rather than in a screenshot.
  expect(
    '…with margin left in the amplitude budget',
    worstStep > 0.0008,
    `tightest advance ${worstStep.toFixed(5)} on a 0.004 step (${(worstStep / 0.004 * 100).toFixed(0)}% of nominal)`,
  );
}

// ── 2. PERIODIC IN ANGLE ──
{
  let worst = 0;
  for (const island of ISLANDS) {
    for (const d of [0.5, 0.8, 1.0, 1.155, 1.16]) {
      worst = Math.max(worst, Math.abs(coastWobble(island, d, 0) - coastWobble(island, d, TAU)));
    }
  }
  expect('θ=0 and θ=2π give the identical radius (no split meridian)', worst < 1e-12, `worst ${worst}`);
}

// ── 3. COARSE MESHES CAN TRACE IT ──
// The curve's highest term is 7 cycles per turn. The proxy samples 30 times per
// turn; Nyquist wants at least 2, and a shape needs ~4 to keep its form. Assert
// it directly: the 30-sample polyline must stay within a small fraction of an
// island radius of the true curve everywhere between its samples.
{
  const PROXY_SEGMENTS = 30;
  let worst = 0;
  for (const island of ISLANDS) {
    const d = 1.155;
    for (let s = 0; s < PROXY_SEGMENTS; s++) {
      const a0 = (s / PROXY_SEGMENTS) * TAU;
      const a1 = ((s + 1) / PROXY_SEGMENTS) * TAU;
      const r0 = coastWobble(island, d, a0);
      const r1 = coastWobble(island, d, a1);
      for (let t = 0; t <= 1; t += 0.05) {
        const chord = r0 + (r1 - r0) * t;
        const truth = coastWobble(island, d, a0 + (a1 - a0) * t);
        worst = Math.max(worst, Math.abs(chord - truth));
      }
    }
  }
  // 0.02 of distRatio ≈ 1.2m on a 60m island: under a single quad, so the
  // skirt and the proxy meet the cap without daylight.
  expect(
    'a 30-segment mesh traces the same coast (skirt/proxy seam stays shut)',
    worst < 0.02,
    `worst chord error ${worst.toFixed(4)} distRatio`,
  );
}

// ── 4. THE INTERIOR DOES NOT MOVE ──
{
  let moved = 0;
  for (const island of ISLANDS) {
    for (let s = 0; s < 64; s++) {
      const angle = (s / 64) * TAU;
      for (const d of [0, 0.1, 0.25, 0.4, 0.42]) {
        if (coastWobble(island, d, angle) !== d) moved += 1;
      }
    }
  }
  expect('nothing inside distRatio 0.42 is displaced at all', moved === 0, `${moved} interior samples moved`);
}

// ── 5. BOUNDED ──
{
  let worst = 0;
  for (const island of ISLANDS) {
    for (let s = 0; s < 256; s++) {
      const angle = (s / 256) * TAU;
      for (let d = 0.42; d <= 1.24; d += 0.01) {
        worst = Math.max(worst, Math.abs(coastWobble(island, d, angle) / d - 1));
      }
    }
  }
  expect('the coast never moves more than 19% of its radius', worst <= 0.19, `worst ${(worst * 100).toFixed(2)}%`);
  expect('…and it moves enough to be worth doing', worst > 0.08, `worst ${(worst * 100).toFixed(2)}%`);
}

// ── 6. PURE ──
{
  const island = ISLANDS[7];
  let stable = true;
  for (let k = 0; k < 5000; k++) {
    const d = 0.3 + (k % 90) / 100;
    const a = (k % 360) * (Math.PI / 180);
    if (coastWobble(island, d, a) !== coastWobble(island, d, a)) stable = false;
  }
  expect('same island, same ring, same angle → same radius, every time', stable);
}

// ── 7. ISLANDS DIFFER ──
// One shared phase would give every island in the map the same lobed outline,
// which is a new signature to replace the circle that was there before.
{
  const sig = (island) => Array.from({ length: 16 }, (_, k) => coastWobble(island, 1.155, (k / 16) * TAU).toFixed(4)).join(',');
  const seen = new Set(ISLANDS.map(sig));
  expect('different islands wear different coasts', seen.size >= ISLANDS.length * 0.9, `${seen.size} distinct of ${ISLANDS.length}`);
}

console.log(failures === 0 ? '\nThe coast bends, and nothing folds.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
