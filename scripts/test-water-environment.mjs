#!/usr/bin/env node
// b2.3f (holes-07): underwater in the flooded hold.
//
// Before this slice Game.updateWaterEnvironment only asked the OUTSIDE sea
// (gerstnerHeight - camera.y), so a camera under the hold water rendered and
// sounded dry. Pure, no browser. Graded on the real client module
// (rendering/waterEnvironment.ts) against the real hold-water clip and plane
// (ship/holdWater.ts):
//   1. a camera below the hold surface inside the hull footprint reads depth
//      > 0 (and == surface - eye); outside the footprint (beyond the lining,
//      beyond the hold's length, under the keel, above the surface, dry hold)
//      it reads 0. Every class, level and rolled.
//   2. the combined depth is max(outside, hold); the hold palette only takes
//      over when the hold is the deeper water.
//   3. the hold palette is murky: 95% fog between 4 and 6 m at every fill
//      and agitation, murkier when fuller/rougher, darker at night.
//   4. hatch caustic flicker: > 0 and moving in time under the companionway
//      by day, 0 far from it, 0 at night.
//   5. Game.updateWaterEnvironment wires it: the muffle depth
//      (cameraSubmergeDepth) is the combined depth, the ocean's underside stays
//      on the OUTSIDE depth, the hold palette is applied, getCameraWaterState
//      is the breath HUD hook.
//   6. program census: the module creates no material/shader (0 new programs);
//      it only moves the existing FogExp2 colour/density and exposure.
// Logic tier.
import { readFileSync } from 'node:fs';
import { buildHoldWaterClip, holdWaterPlane, planeY } from '../src/client/rendering/ship/holdWater.ts';
import {
  holdEyeDepth, eyeInsideHold, combineWaterDepth, holdVisibilityMeters, holdFogDensity, hatchCausticFlicker,
  holdUnderwaterPalette, HOLD_FOG_VISIBILITY_MIN, HOLD_FOG_VISIBILITY_MAX,
} from '../src/client/rendering/waterEnvironment.ts';
import { getShipCompanionwayConfig } from '../src/shared/utils/index.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}

const TYPES = ['sloop', 'brigantine', 'galleon'];

console.log('1. hold eye depth: > 0 inside the hull footprint under the surface, 0 outside it');
for (const type of TYPES) {
  const clip = buildHoldWaterClip(type);
  for (const [roll, pitch] of [[0, 0], [0.15, 0], [0, -0.06], [-0.12, 0.05]]) {
    const plane = holdWaterPlane(type, 0.85, roll, pitch);
    const tag = `${type} roll ${roll} pitch ${pitch}`;
    const x = 0; const z = 0;
    const surf = planeY(plane, x, z);
    const eyeY = Math.max(clip.soleY + 0.3, surf - 0.6);
    const d = holdEyeDepth(clip, plane, { x, y: eyeY, z });
    check(`${tag}: eye under the hold surface on the centreline -> depth > 0`, d > 0.05 && Math.abs(d - (surf - eyeY)) < 1e-6, `depth ${d.toFixed(3)}, surface - eye ${(surf - eyeY).toFixed(3)}`);
    const outX = holdEyeDepth(clip, plane, { x: clip.maxHalfWidth + 0.6, y: eyeY, z });
    check(`${tag}: same height beyond the lining (x ${(clip.maxHalfWidth + 0.6).toFixed(2)}) -> 0`, outX === 0, `depth ${outX}`);
    const outZ = holdEyeDepth(clip, plane, { x: 0, y: eyeY, z: clip.halfL + 1 });
    check(`${tag}: beyond the hold's length -> 0`, outZ === 0, `depth ${outZ}`);
    const keel = holdEyeDepth(clip, plane, { x: 0, y: clip.soleY - 1.2, z: 0 });
    check(`${tag}: swimmer under the keel -> 0 (the sea, not the hold)`, keel === 0, `depth ${keel}`);
    const above = holdEyeDepth(clip, plane, { x, y: surf + 0.2, z });
    check(`${tag}: eye above the surface -> 0`, above === 0, `depth ${above}`);
  }
  const dryEye = { x: 0, y: clip.soleY + 0.5, z: 0 };
  check(`${type}: a dry hold's eye 0.5 m over the sole is INSIDE the hull (the sea is outside the planking)`, eyeInsideHold(clip, dryEye));
  check(`${type}: beyond the lining / under the keel / over the deck is not inside`,
    !eyeInsideHold(clip, { x: clip.maxHalfWidth + 0.6, y: dryEye.y, z: 0 }) && !eyeInsideHold(clip, { x: 0, y: clip.soleY - 1.2, z: 0 })
    && !eyeInsideHold(clip, { x: 0, y: clip.deckY + 0.5, z: 0 }));
  check(`${type}: dry hold -> 0`, holdEyeDepth(clip, holdWaterPlane(type, 0, 0, 0), { x: 0, y: clip.soleY + 0.2, z: 0 }) === 0);
}

console.log('2. combined depth = max(outside, hold); the hold palette only when the hold is deeper');
{
  const a = combineWaterDepth(0, 0.7);
  check('dry sea, 0.7 m hold -> 0.7, source hold, full mix', a.depth === 0.7 && a.source === 'hold' && a.holdMix === 1, JSON.stringify(a));
  const b = combineWaterDepth(1.4, 0.7);
  check('1.4 m sea, 0.7 m hold -> 1.4, source sea, no hold mix', b.depth === 1.4 && b.source === 'sea' && b.holdMix === 0, JSON.stringify(b));
  const c = combineWaterDepth(0, 0);
  check('dry both -> 0, source dry', c.depth === 0 && c.source === 'dry' && c.holdMix === 0, JSON.stringify(c));
  const d = combineWaterDepth(0, 0.04);
  check('a 4 cm dip blends in (0 < mix < 1), no pop', d.holdMix > 0 && d.holdMix < 1, JSON.stringify(d));
  const e = combineWaterDepth(Number.NaN, 0.5);
  check('NaN outside depth is treated as dry', e.depth === 0.5 && e.source === 'hold', JSON.stringify(e));
}

console.log('3. murky hold palette: 95% fog between 4 and 6 m');
{
  check('visibility band constants are 4..6 m', HOLD_FOG_VISIBILITY_MIN === 4 && HOLD_FOG_VISIBILITY_MAX === 6);
  let ok = true; let worst = '';
  for (let f = 0; f <= 1.0001; f += 0.1) {
    for (const ag of [0, 0.5, 1]) {
      const v = holdVisibilityMeters(f, ag);
      const dens = holdFogDensity(v);
      const fog95 = 1 - Math.exp(-((dens * v) ** 2));
      if (!(v >= 4 - 1e-9 && v <= 6 + 1e-9) || Math.abs(fog95 - 0.95) > 1e-6) { ok = false; worst = `fill ${f.toFixed(1)} ag ${ag}: vis ${v}, fog at vis ${fog95}`; }
    }
  }
  check('every fill x agitation: visibility in [4, 6] m and the FogExp2 density puts 95% fog exactly there', ok, worst);
  check('fuller and rougher is murkier', holdVisibilityMeters(1, 1) < holdVisibilityMeters(0.3, 0) - 1);
  const noon = holdUnderwaterPalette(0.8, 0.3, 0, 0);
  const night = holdUnderwaterPalette(0.8, 0.3, 1, 0);
  const lum = (p) => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
  check('night palette darker than noon', lum(night) < lum(noon) * 0.6, `noon ${lum(noon).toFixed(3)} night ${lum(night).toFixed(3)}`);
  check('palette is murky green-brown, not the sea teal (g >= b, r < g)', noon.g >= noon.b && noon.r < noon.g, JSON.stringify(noon));
  check('fog density is the 4-6 m band (0.28..0.44), 50x the sea underwater fog', noon.density >= 0.28 && noon.density <= 0.44, `density ${noon.density}`);
  check('exposure dims under the hold water', noon.exposureScale < 1 && noon.exposureScale > 0.6, `scale ${noon.exposureScale}`);
  const lit = holdUnderwaterPalette(0.8, 0.3, 0, 1);
  check('caustic flicker brightens the palette', lum(lit) > lum(noon), `lit ${lum(lit).toFixed(3)} vs ${lum(noon).toFixed(3)}`);
}

console.log('4. hatch caustic flicker');
for (const type of TYPES) {
  const cw = getShipCompanionwayConfig(SHIP_STATS[type]);
  const hatch = { cx: cw.cx, cz: cw.cz, halfX: cw.halfX, halfZ: cw.halfZ };
  let min = Infinity; let max = -Infinity;
  for (let t = 0; t < 4; t += 0.05) {
    const v = hatchCausticFlicker(cw.cx, cw.cz, hatch, t, 0);
    if (v < min) min = v; if (v > max) max = v;
  }
  check(`${type}: under the hatch by day the flicker moves (max ${max.toFixed(2)} min ${min.toFixed(2)})`, max > 0.35 && max - min > 0.2 && max <= 1 && min >= 0);
  let far = 0;
  for (let t = 0; t < 4; t += 0.1) far = Math.max(far, hatchCausticFlicker(cw.cx, cw.cz + cw.halfZ + 6, hatch, t, 0));
  check(`${type}: 6 m beyond the hatch -> 0`, far === 0, `max ${far}`);
  let nightMax = 0;
  for (let t = 0; t < 4; t += 0.1) nightMax = Math.max(nightMax, hatchCausticFlicker(cw.cx, cw.cz, hatch, t, 1));
  check(`${type}: night -> 0`, nightMax === 0, `max ${nightMax}`);
}

console.log('5. Game.updateWaterEnvironment wiring');
{
  const src = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  const start = src.indexOf('private updateWaterEnvironment()');
  const end = src.indexOf('\n  }\n', start);
  const body = start >= 0 ? src.slice(start, end) : '';
  check('updateWaterEnvironment exists', body.length > 0);
  check('it reads the hold (sampleCameraHoldDepth / holdEyeDepth)', /sampleCameraHoldDepth|holdEyeDepth/.test(body));
  check('it combines with combineWaterDepth (max of outside and hold)', /combineWaterDepth\(/.test(body));
  check('the audio muffle depth is the COMBINED depth', /this\.cameraSubmergeDepth\s*=\s*water\.depth/.test(body));
  check('the ocean underside stays on the OUTSIDE depth', /this\.ocean\.setUnderwaterDepth\(outsideDepth\)/.test(body));
  check('inside a hold the outside sea depth is 0 (a dry hold under the waterline is dry)', /const outsideDepth = hold\.inside \? 0 :/.test(body));
  check('the hold palette is applied', /applyHoldUnderwater\(/.test(body));
  check('getCameraWaterState() is the breath HUD hook', /getCameraWaterState\(\)\s*(:[^{]+)?\{/.test(src));
}

console.log('6. program census: 0 new programs');
{
  const mod = readFileSync(new URL('../src/client/rendering/waterEnvironment.ts', import.meta.url), 'utf8');
  const code = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('waterEnvironment.ts constructs no Material / ShaderMaterial / Fog', !/new\s+THREE\.\w*(Material|Fog)\b|onBeforeCompile|customProgramCacheKey/.test(code));
}

if (failures) { console.log(`\n${failures} FAIL`); process.exit(1); }
console.log('\nAll water-environment checks passed');
