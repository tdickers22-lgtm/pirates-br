#!/usr/bin/env node
// OCEAN HULL MASK GATE (WATER-01 / ships-02) — is the sea kept out of the hold?
//
// THE DEFECT. Nothing masked the exterior ocean against a ship. The world's one
// water sheet was drawn straight through the planking, so the hold floor
// (0.35 m above the hull origin) had open sea across it: measured on the pinned
// map, 23% of calm samples on a sloop, 66% on a galleon, 71%/89% in a storm, and
// PERMANENTLY once waterLevel passes 0.44 because FREEBOARD_DROP settles the
// hull 0.8·waterLevel below the surface. evidence/liveplay/18-hold-interior.png
// is half flat cyan where the floor and walls should be.
//
// WHAT THIS GRADES, AND WHAT IT DOES NOT. The cut-out lives in the ocean's
// fragment shader, so the last word belongs to a rendered frame (the hold-cyan
// probe in the lane's gate list). What is gradeable here, deterministically and
// without a stack, is everything the frame depends on:
//
//   1. the GLSL outline the sea is cut out of IS the shared swim-hull outline —
//      the mix chain is parsed back out of the shipped fragment source and
//      compared against getSwimHullHalfWidth at 41 stations on all three hull
//      classes. Two outlines that disagree by 30 cm is a visible slit.
//   2. the cut-out box reaches high enough and low enough to cover the measured
//      worst-case rise of the sea inside a hull's own footprint (2.03 m,
//      galleon, storm — evidence/ships/wave_dev_tilted.txt).
//   3. a point on the hold floor is inside the mask and a point a metre outboard
//      of the widest station is not — the sea must still be drawn AROUND the
//      hull, or every ship gets a hole in the ocean.
//   4. setHullMasks culls to HULL_MASK_RANGE, keeps the NEAREST hulls, packs
//      cos/sin of the rendered yaw, and allocates nothing per frame.
//
// RED ON HEAD: OceanRenderer has no setHullMasks and OCEAN_FRAG has no
// insideHull — checks 1-4 all fail.
//
// Run: node --import tsx scripts/test-ocean-hull-mask.mjs
import * as THREE from 'three';
import { OceanRenderer, OCEAN_FRAG, HULL_MASK_RANGE, HULL_MASK_ARM_RANGE, HULL_MASK_DISARM_RANGE } from '../src/client/rendering/OceanRenderer.ts';
import { getSwimHullHalfWidth } from '../src/shared/utils/index.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};

// ── 1. The GLSL outline, parsed out of the shipped fragment source ──────────
const fracSrc = OCEAN_FRAG.slice(OCEAN_FRAG.indexOf('float hullHalfFrac'), OCEAN_FRAG.indexOf('bool insideHull'));
if (!fracSrc || !/float h = /.test(fracSrc)) {
  console.error('  ✗ FAIL: OCEAN_FRAG has no hullHalfFrac() — the ocean does not know what a hull is (RED ON HEAD)');
  process.exit(1);
}
const h0 = Number((fracSrc.match(/float h = ([0-9.]+);/) ?? [])[1]);
const steps = [...fracSrc.matchAll(/h = mix\(h, ([0-9.]+), clamp\(\(zf - \((-?[0-9.]+)\)\) \/ ([0-9.]+), 0\.0, 1\.0\)\);/g)]
  .map((m) => ({ half: Number(m[1]), z0: Number(m[2]), span: Number(m[3]) }));
const HW_FLOOR = Number((OCEAN_FRAG.match(/float hw = max\(([0-9.]+),/) ?? [])[1]);
expect(`hullHalfFrac() parsed out of the shipped GLSL (${steps.length + 1} stations, floor ${HW_FLOOR} m)`,
  Number.isFinite(h0) && steps.length >= 6 && Number.isFinite(HW_FLOOR));
/** The shader's own function, evaluated in JS from its own parsed constants. */
const hullHalfFrac = (zf) => {
  let h = h0;
  for (const s of steps) {
    const t = Math.max(0, Math.min(1, (zf - s.z0) / s.span));
    h = h + (s.half - h) * t;
  }
  return h;
};

let worst = { d: 0, type: '', z: 0 };
for (const [type, st] of Object.entries(SHIP_STATS)) {
  for (let i = 0; i <= 40; i++) {
    const localZ = -st.length * 0.52 + (i / 40) * st.length * 1.04;
    const zf = Math.max(-0.52, Math.min(0.52, localZ / st.length));
    const glsl = Math.max(HW_FLOOR, st.width * hullHalfFrac(zf));
    const shared = getSwimHullHalfWidth(st, localZ);
    const d = Math.abs(glsl - shared);
    if (d > worst.d) worst = { d, type, z: localZ };
  }
}
expect(`the GLSL taper IS getSwimHullHalfWidth (worst ${worst.d.toFixed(3)} m on the ${worst.type} at z=${worst.z.toFixed(1)} <= 0.050 m)`,
  worst.d <= 0.05, 'the sea would be cut out of a different outline than the one the hull is lofted to: a slit or an apron along the waterline');

// ── 2/3. The cut-out volume, driven through the real API ───────────────────
const ocean = new OceanRenderer();
ocean.init(new THREE.Scene(), 'low');
const u = ocean.material?.uniforms ?? null;
const uniforms = u ?? ocean['material'].uniforms;
const galleon = SHIP_STATS.galleon;
const HULL = {
  x: 120, y: 3, z: -40, yaw: 0.7,
  width: galleon.width, length: galleon.length,
  // Rail height and keel depth of the mask box.
  top: 4.0, bottom: 3.0,
};
const cam = new THREE.Vector3(122, 4, -38);
ocean.setHullMasks([HULL], cam);
expect('setHullMasks put the hull on the wire (u_hullCount 1)', uniforms.u_hullCount.value === 1);
const A = uniforms.u_hullA.value[0], B = uniforms.u_hullB.value[0];
expect(`u_hullA packs cos/sin of the RENDERED yaw (${A.z.toFixed(4)}, ${A.w.toFixed(4)})`,
  Math.abs(A.z - Math.cos(HULL.yaw)) < 1e-6 && Math.abs(A.w - Math.sin(HULL.yaw)) < 1e-6);
expect(`the cut-out box covers the measured worst-case rise (top ${(B.w - HULL.y).toFixed(2)} m >= 2.03 m, wave_dev_tilted galleon storm)`,
  B.w - HULL.y >= 2.03, `box top is ${(B.w - HULL.y).toFixed(2)} m over the hull origin; the sea reaches 2.03 m in a storm`);
expect(`the cut-out box reaches below the keel (bottom ${(HULL.y - B.z).toFixed(2)} m >= ${(galleon.height * 0.6).toFixed(2)} m)`,
  HULL.y - B.z >= galleon.height * 0.6);

/** insideHull(), mirrored from the uniforms the shader is actually given and
 *  the outline parsed from its own source — not a second hand-written copy. */
const insideHull = (p) => {
  if (uniforms.u_hullCount.value <= 0) return false;
  for (let i = 0; i < uniforms.u_hullCount.value; i++) {
    const a = uniforms.u_hullA.value[i], b = uniforms.u_hullB.value[i];
    if (p.y < b.z || p.y > b.w) continue;
    const dx = p.x - a.x, dz = p.z - a.y;
    const lx = a.z * dx - a.w * dz, lz = a.w * dx + a.z * dz;
    if (Math.abs(lz) > b.y * 0.52) continue;
    if (Math.abs(lx) <= Math.max(HW_FLOOR, b.x * hullHalfFrac(Math.max(-0.52, Math.min(0.52, lz / b.y))))) return true;
  }
  return false;
};
const toWorld = (lx, lz, y) => ({
  x: HULL.x + Math.cos(HULL.yaw) * lx + Math.sin(HULL.yaw) * lz,
  y,
  z: HULL.z - Math.sin(HULL.yaw) * lx + Math.cos(HULL.yaw) * lz,
});
// The hold floor sits 0.35 m over the hull origin (ShipRenderer :1263).
expect('the sea is cut out at the hold floor, amidships', insideHull(toWorld(0, 0, HULL.y + 0.35)));
expect('the sea is cut out at the hold floor, three quarters aft', insideHull(toWorld(0, -galleon.length * 0.35, HULL.y + 0.35)));
expect('the sea is cut out at the worst measured storm rise (+2.03 m)', insideHull(toWorld(0, 0, HULL.y + 2.03)));
expect('the sea is STILL DRAWN a metre outboard of the widest station',
  !insideHull(toWorld(galleon.width * 0.599 + 1.0, 0, HULL.y + 0.35)),
  'a mask wider than the hull punches a hole in the ocean around every ship');
expect('the sea is STILL DRAWN a metre ahead of the stem', !insideHull(toWorld(0, galleon.length * 0.52 + 1.0, HULL.y + 0.35)));
expect('the sea is STILL DRAWN above the rail', !insideHull(toWorld(0, 0, HULL.y + 4.5)));

// ── 4. Culling, ordering and allocation ────────────────────────────────────
const far = { ...HULL, x: cam.x + HULL_MASK_RANGE + 5, z: cam.z };
ocean.setHullMasks([far], cam);
expect(`a hull past HULL_MASK_RANGE (${HULL_MASK_RANGE} m) is dropped, so open water pays one comparison`,
  uniforms.u_hullCount.value === 0);

const fleet = [];
for (let i = 0; i < 14; i++) fleet.push({ ...HULL, x: cam.x + (14 - i) * 4, z: cam.z });
ocean.setHullMasks(fleet, cam);
expect(`a crowded berth is capped and the NEAREST hulls win (count ${uniforms.u_hullCount.value} = 10, first at ${uniforms.u_hullA.value[0].x - cam.x} m)`,
  uniforms.u_hullCount.value === 10 && Math.abs(uniforms.u_hullA.value[0].x - cam.x - 4) < 1e-6);

const before = uniforms.u_hullA.value.map((v) => v);
ocean.setHullMasks(fleet, cam);
expect('setHullMasks reuses its uniform vectors (no per-frame allocation in the render loop)',
  uniforms.u_hullA.value.every((v, i) => v === before[i]));

expect('the ocean fragment discards on insideHull BEFORE it shades anything',
  /if \(insideHull\(v_worldPos\)\) discard;/.test(OCEAN_FRAG)
  && OCEAN_FRAG.indexOf('discard;') < OCEAN_FRAG.indexOf('float camDist = distance'),
  'shading a fragment and then throwing it away pays for it twice');

// ── 5. OPEN WATER PAYS NOTHING FOR IT (review-2 P1) ────────────────────────
//
// A discard costs the whole PROGRAM its early-depth test — a property of the
// compiled shader, not of the frame, paid on empty sea, in a storm and on the
// low tier alike, on the surface that covers 45-55% of the picture. So the
// clause lives in a HULL_MASK variant and the rings run the maskless program
// until a hull is close enough to matter. test-fill-budget censuses shader ops
// and full-screen passes; it cannot see early-Z, so this is what grades it.
{
  const discardAt = OCEAN_FRAG.indexOf('if (insideHull(v_worldPos)) discard;');
  const ifdefAt = OCEAN_FRAG.lastIndexOf('#ifdef HULL_MASK', discardAt);
  const endifAt = OCEAN_FRAG.indexOf('#endif', discardAt);
  expect('the discard is inside #ifdef HULL_MASK, so the default program has no discard at all',
    ifdefAt >= 0 && endifAt > discardAt && OCEAN_FRAG.slice(ifdefAt, discardAt).indexOf('#endif') < 0,
    'an unconditional discard in OCEAN_FRAG is early-Z gone on every tier');

  const rings = ocean['surfaceMeshes'];
  const plain = ocean['material'];
  const masked = ocean['maskMaterial'];
  expect('the two programs share ONE uniforms object (every setter writes once)',
    plain.uniforms === masked.uniforms && masked.defines?.HULL_MASK === '1');
  expect(`arming is wider than masking (${HULL_MASK_ARM_RANGE} > ${HULL_MASK_RANGE} m), so the link is paid before the cut-out is needed`,
    HULL_MASK_ARM_RANGE > HULL_MASK_RANGE && HULL_MASK_DISARM_RANGE > HULL_MASK_ARM_RANGE);

  const at = (d) => ({ ...HULL, x: cam.x + d, z: cam.z });
  ocean.setHullMasks([], cam, 0);
  expect('open water runs the MASKLESS program (early-Z intact)',
    !ocean.isHullMaskProgramActive() && rings.length > 0 && rings.every((m) => m.material === plain),
    `rings=${rings.length} active=${ocean.isHullMaskProgramActive()}`);

  ocean.setHullMasks([at(HULL_MASK_ARM_RANGE + 30)], cam);
  expect('a hull hull-down over the horizon does not arm it',
    !ocean.isHullMaskProgramActive() && rings.every((m) => m.material === plain));

  ocean.setHullMasks([at(HULL_MASK_ARM_RANGE - 5)], cam);
  expect('she arms the mask program while still OUTSIDE masking range (u_hullCount 0)',
    ocean.isHullMaskProgramActive() && rings.every((m) => m.material === masked)
    && uniforms.u_hullCount.value === 0,
    `active=${ocean.isHullMaskProgramActive()} count=${uniforms.u_hullCount.value}`);

  ocean.setHullMasks([at(HULL_MASK_ARM_RANGE + 5)], cam);
  expect('and the hysteresis holds it through a hull loitering at the boundary (no per-frame swap)',
    ocean.isHullMaskProgramActive());

  ocean.setHullMasks([at(HULL_MASK_DISARM_RANGE + 5)], cam);
  expect('once she is well clear the sea goes back to the maskless program',
    !ocean.isHullMaskProgramActive() && rings.every((m) => m.material === plain));

  ocean.setHullMasks([at(10)], cam);
  expect('alongside, the mask program is on AND the hull is on the wire',
    ocean.isHullMaskProgramActive() && uniforms.u_hullCount.value === 1);
}

console.log(failures ? `\nFAIL: ${failures} check(s)` : '\nPASS: ocean hull mask');
process.exit(failures ? 1 : 0);
