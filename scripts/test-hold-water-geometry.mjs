#!/usr/bin/env node
// b2.3a (holes-01 / liveplay-01): the hold water is a WORLD-LEVEL surface
// clipped to the hull, its height from the shared fill table.
//
// Pure, no browser. Graded on the real client module (ship/holdWater.ts):
//   1. 200 random (fill, roll, pitch) per class: every point the clip says is
//      water lies inside the TRUE loft (hullSurfacePointAt at that z and at the
//      surface height), at every station and between them, and inside the
//      sole/deck band.
//   2. the clipped surface is not empty: at every fill in 0.1..0.9 on a level
//      hull most of the hold centreline carries water.
//   3. height = shared fill table: plane y0 == fillToLocalY, full EXACTLY at
//      fill 1 (deck underside), and the level tilt equals the shared
//      holdWaterSurfaceLocalY (the wading sampler) away from the clamps.
//   4. world-level: at roll 0.2 the port and starboard waterlines on the
//      lining differ by >= 0.3 m, the low side is the side roll lowers.
//   5. the client slosh re-sim oscillates after a roll step and decays; a
//      still hull adds no slope.
//   6. no literal 0.8 in the water code (the old fill-then-awash threshold).
//   7. grids 24x12 / 12x6 / 6x4.
// Logic tier.
import { readFileSync } from 'node:fs';
import {
  buildHoldWaterClip, clipHalfWidth, holdWaterPlane, holdWaterCovers, planeY, holdWaterGrid,
  newHoldSloshSim, stepHoldSlosh,
} from '../src/client/rendering/ship/holdWater.ts';
import { getHullProfile, hullSurfacePointAt } from '../src/shared/hull.ts';
import { fillToLocalY, holdWaterSurfaceLocalY, getHullVolumeTable } from '../src/shared/flooding/hullVolume.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

// Seeded RNG (mulberry32) so a red run reproduces.
let seed = 0x5eed2a3a;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

for (const type of ['sloop', 'brigantine', 'galleon']) {
  console.log(`\n${type}`);
  const clip = buildHoldWaterClip(type);
  const profile = getHullProfile(type);
  const vt = getHullVolumeTable(type);

  // 1. inside the loft
  let worst = -Infinity; let covered = 0; let where = '';
  for (let n = 0; n < 200; n += 1) {
    const fill = 0.03 + rnd() * 0.97;
    const roll = (rnd() * 2 - 1) * 0.45;
    const pitch = (rnd() * 2 - 1) * 0.3;
    const plane = holdWaterPlane(type, fill, roll, pitch, (rnd() * 2 - 1) * 0.3, (rnd() * 2 - 1) * 0.3);
    if (!plane) continue;
    for (let iz = 0; iz <= 90; iz += 1) {
      const z = -clip.halfL + (2 * clip.halfL * iz) / 90;
      for (let ix = 0; ix <= 40; ix += 1) {
        const x = -clip.maxHalfWidth + (2 * clip.maxHalfWidth * ix) / 40;
        if (!holdWaterCovers(clip, plane, x, z)) continue;
        covered += 1;
        const y = planeY(plane, x, z);
        const loft = hullSurfacePointAt(profile, z, y).x;
        const over = Math.abs(x) - loft;
        if (y < vt.soleY - 1e-6 || y > vt.deckY + 1e-6) { worst = Infinity; where = `y ${y.toFixed(3)} outside band`; }
        if (over > worst) { worst = over; where = `fill ${fill.toFixed(2)} roll ${roll.toFixed(2)} pitch ${pitch.toFixed(2)} x ${x.toFixed(2)} z ${z.toFixed(2)}`; }
      }
    }
  }
  check('200 random (fill, roll, pitch): the clipped surface lies inside the loft at every station', worst <= 0 && covered > 0,
    `max overshoot ${worst.toFixed(4)} m at ${where}, ${covered} covered samples`);

  // 2. not empty
  let thin = null;
  for (let f = 0.1; f <= 0.91; f += 0.1) {
    const plane = holdWaterPlane(type, f, 0, 0);
    let on = 0; let total = 0;
    for (let iz = 0; iz <= 40; iz += 1) {
      const z = -clip.halfL * 0.8 + (1.6 * clip.halfL * iz) / 40;
      total += 1; if (holdWaterCovers(clip, plane, 0, z)) on += 1;
    }
    if (on / total < 0.9) thin = `fill ${f.toFixed(1)}: ${on}/${total}`;
  }
  check('a level hold carries water over >= 90% of the centreline at fills 0.1..0.9', thin === null, thin ?? '');

  // 3. fill table
  let maxDiff = 0;
  for (let n = 0; n < 50; n += 1) {
    const fill = 0.05 + rnd() * 0.9; const roll = (rnd() * 2 - 1) * 0.3; const pitch = (rnd() * 2 - 1) * 0.2;
    const x = (rnd() * 2 - 1) * 0.5; const z = (rnd() * 2 - 1) * clip.halfL * 0.5;
    const plane = holdWaterPlane(type, fill, roll, pitch);
    const shared = holdWaterSurfaceLocalY(type, fill, x, z, roll, pitch);
    const mine = planeY(plane, x, z);
    if (mine > vt.soleY + 0.01 && mine < vt.deckY - 0.01) maxDiff = Math.max(maxDiff, Math.abs(mine - shared));
  }
  check('surface == shared holdWaterSurfaceLocalY (the wading sampler)', maxDiff < 1e-9, `max diff ${maxDiff.toExponential(2)}`);
  const p05 = holdWaterPlane(type, 0.5, 0, 0);
  check('fill 0.5 height == shared fill table', Math.abs(p05.y0 - fillToLocalY(type, 0.5)) < 1e-12, `${p05.y0.toFixed(3)}`);
  const p1 = holdWaterPlane(type, 1, 0, 0);
  check('full EXACTLY at fill 1.0 (deck underside)', p1.y0 === vt.deckY, `${p1.y0} vs ${vt.deckY}`);
  const p095 = holdWaterPlane(type, 0.95, 0, 0);
  check('fill 0.95 is still below the deck (no early awash jump)', p095.y0 < vt.deckY - 0.02, `${p095.y0.toFixed(3)} < ${vt.deckY}`);

  // 4. world-level: port vs starboard waterline at roll 0.2
  const pr = holdWaterPlane(type, 0.5, 0.2, 0);
  const hw = clipHalfWidth(clip, 0, pr.y0);
  const port = planeY(pr, hw, 0); const stbd = planeY(pr, -hw, 0);
  check('roll 0.2: port and starboard waterlines on the lining differ >= 0.3 m', Math.abs(port - stbd) >= 0.3,
    `port ${port.toFixed(3)} stbd ${stbd.toFixed(3)}`);
  check('roll +0.2 lifts +x, so the water is deeper at -x', stbd > port);
  const pp = holdWaterPlane(type, 0.5, 0, 0.1);
  check('pitch +0.1 dips the bow, so the water is deeper at +z', planeY(pp, 0, 3) > planeY(pp, 0, -3));

  // 5. slosh re-sim
  const sim = newHoldSloshSim();
  let still = 0;
  for (let i = 0; i < 120; i += 1) still = Math.max(still, Math.abs(stepHoldSlosh(sim, type, 0.5, 0, 0, 1 / 60).sx));
  check('a still hull sloshes nothing', still < 1e-9, `${still}`);
  let peak = 0; let late = 0; let signs = 0; let prev = 0;
  for (let i = 0; i < 60 * 12; i += 1) {
    const s = stepHoldSlosh(sim, type, 0.5, 0.15, 0, 1 / 60).sx;
    if (i < 240) peak = Math.max(peak, Math.abs(s));
    if (i >= 60 * 11) late = Math.max(late, Math.abs(s));
    if (i > 0 && Math.sign(s) !== Math.sign(prev) && s !== 0) signs += 1;
    prev = s;
  }
  check('a roll step sets the surface sloshing (it overshoots, reverses and decays)',
    peak > 0.01 && signs >= 2 && late < peak * 0.5, `peak ${peak.toFixed(4)} reversals ${signs} late ${late.toFixed(4)}`);
}

// 6. no literal 0.8
const src = readFileSync(new URL('../src/client/rendering/ship/holdWater.ts', import.meta.url), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const sr = readFileSync(new URL('../src/client/rendering/ShipRenderer.ts', import.meta.url), 'utf8');
const a = sr.indexOf('// Hold water (b2.3a)');
const block = a >= 0 ? sr.slice(a, sr.indexOf('// Fire visual', a)) : sr;
const lit = /(^|[^0-9.])0\.80*(?![0-9])/;
check('no literal 0.8 in the hold-water code (holdWater.ts + the ShipRenderer update block)',
  !lit.test(src) && !lit.test(block) && a >= 0);

// 7. grids
const g = ['high', 'balanced', 'low'].map((q) => holdWaterGrid(q)).map((x) => `${x.along}x${x.across}`).join(' / ');
check('grids 24x12 / 12x6 / 6x4', g === '24x12 / 12x6 / 6x4', g);

if (failures > 0) { console.log(`\n${failures} hold-water geometry check(s) FAILED`); process.exit(1); }
console.log('\nAll hold-water geometry checks passed');
