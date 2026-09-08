#!/usr/bin/env node
// THE HERO WEAPON LANDS IN THE FRAME IT REPLACES — pure node, no GL.
//
// WHY. WeaponMeshFactory's own docstring promises the five authored weapon GLBs
// arrive "in the SAME frame as the primitive fallback … so the viewmodel does
// not move when the file lands". They did not. The viewmodel turns the weapon
// by rotation.y = PI, so a butt that reaches further BEHIND the grip reaches
// toward the eye: measured against the primitives they replace, the flintknock
// GLB is 1.142 m long where the primitive is 0.569, and the flintlock's stock
// sits 0.442 m behind the grip where the primitive's sits 0.310. With the
// primitive-era 1.2 scale still applied, test-near-plane-clearance opened a
// 140,583 px hole and put the aiming hand 0.0506 m from the eye — inside the
// 0.1 near plane PLAN section 7 pins (review-4 P0).
//
// WHAT. Read the real GLB bounds straight out of the glTF (accessor min/max
// through the node TRS chain — 7 of the roster's files carry transforms, so
// ignoring TRS is how assets-18/25 false-passed), build the real primitive
// union with the real factory, and run the SHIPPED fit (fitBoxOnto) on the two.
// Then grade the thing the near plane actually cares about: after the fit, no
// authored weapon may reach further back toward the player's eye than the
// primitive whose constants the viewmodel still uses.
//
// This is the LOGIC-tier half. test-near-plane-clearance is the pixel truth and
// stays the gate of record; this one fails in 0.3 s on a rebuild that moves a
// pivot, without a browser.
//
//   node --import tsx scripts/test-viewmodel-envelope.mjs
//   PIRATES_BR_MUTATE_VIEWMODEL=nofit  → grade the UNFITTED hero (must go red)
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const { makeHeldWeaponMesh, fitBoxOnto, primitiveWeaponBox } =
  await import('../src/client/rendering/factories/WeaponMeshFactory.ts');

const DIR = path.resolve('public/assets/models');
const MUTATE = process.env.PIRATES_BR_MUTATE_VIEWMODEL ?? '';

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function readGlbJson(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jl).toString());
}

/** World-space bounds of a GLB, honouring every node's TRS. */
function glbBox(json) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const walk = (ni, parent) => {
    const n = json.nodes[ni];
    const local = new THREE.Matrix4();
    if (n.matrix) local.fromArray(n.matrix);
    else {
      local.compose(
        new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
      );
    }
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      for (const prim of json.meshes[n.mesh].primitives) {
        const a = json.accessors[prim.attributes.POSITION];
        for (let corner = 0; corner < 8; corner += 1) {
          v.set(
            (corner & 1) ? a.max[0] : a.min[0],
            (corner & 2) ? a.max[1] : a.min[1],
            (corner & 4) ? a.max[2] : a.min[2],
          ).applyMatrix4(world);
          box.expandByPoint(v);
        }
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const ni of json.scenes[json.scene ?? 0].nodes) walk(ni, new THREE.Matrix4());
  return box;
}

/** Every weapon in HERO_WEAPON_FILES, with the file it clones. */
const HERO = {
  cutlass: 'cutlass.glb',
  flintlock: 'flintlock.glb',
  flintknock: 'flintknock.glb',
  eye_of_reach: 'eye_of_reach.glb',
  blunderbuss: 'blunderbuss.glb',
};

console.log('Every authored weapon lands in the envelope its primitive-era constants were measured against');

for (const [weaponId, file] of Object.entries(HERO)) {
  const primBox = primitiveWeaponBox(weaponId);
  const heroBox = glbBox(readGlbJson(file));
  const fit = MUTATE === 'nofit'
    ? { scale: 1, offset: new THREE.Vector3(), axis: 'z' }
    : fitBoxOnto(heroBox, primBox);
  const fitted = heroBox.clone();
  fitted.min.multiplyScalar(fit.scale).add(fit.offset);
  fitted.max.multiplyScalar(fit.scale).add(fit.offset);

  // The viewmodel turns the weapon by rotation.y = PI, so the weapon's OWN −Z
  // is what points at the eye. "Overhang" is how much further back than the
  // primitive the authored file reaches, in metres, before the viewmodel's own
  // per-weapon scale multiplies it.
  const overhang = primBox.min.z - fitted.min.z;
  const longMiss = Math.max(
    Math.abs(fitted.min[fit.axis] - primBox.min[fit.axis]),
    Math.abs(fitted.max[fit.axis] - primBox.max[fit.axis]),
  );
  console.log(`  ${weaponId.padEnd(13)} scale ${fit.scale.toFixed(3)}  long axis ${fit.axis}  butt z ${fitted.min.z.toFixed(3)} (primitive ${primBox.min.z.toFixed(3)})  overhang ${(overhang * 1000).toFixed(1)} mm`);
  expect(`${weaponId}: the authored file fills the primitive's long axis exactly (${(longMiss * 1000).toFixed(2)} mm)`,
    longMiss < 1e-3);
  expect(`${weaponId}: nothing reaches further back toward the eye than the primitive did`,
    overhang <= 0.005, `overhang ${(overhang * 1000).toFixed(1)} mm behind the primitive butt`);
}

// Not vacuous, and not a tautology: the primitives really are what the factory
// hands back while the GLBs are still in flight, and they really are the frame
// muzzleTipFor and the hand grips were measured in.
{
  const built = makeHeldWeaponMesh('flintlock');
  built.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(built);
  expect('with no GLB loaded the factory still hands back the primitive union it is fitted to',
    Math.abs(box.min.z - primitiveWeaponBox('flintlock').min.z) < 1e-9);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
