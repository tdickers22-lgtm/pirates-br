// FAUNA CENSUS — the shark is the most-watched mesh in the game, and the gate
// that says so (FAUNAGLB-01, assets-12).
//
// WHY THIS EXISTS. A player meets a shark at arm's length, in the water, in the
// dodge window: it is the closest a creature ever gets to the camera. It was
// also the lowest-fidelity thing we shipped — 1,972 tris, twelve rigid parts, a
// white belly sphere pushed through the grey hull (two interpenetrating
// surfaces = a moving z-fight), and a swim cycle that was three node rotations.
// scripts/blender/build_fauna_v2.py replaces it with a lofted, SKINNED body.
//
// WHAT IS GRADED, and each line is a thing a player or the frame budget feels:
//   1. shark.glb is >= 8,000 tris                     — the fidelity floor
//   2. shark.glb carries a skin, >= 8 joints, and every drawn primitive is
//      skinned                                        — a skeleton nothing is
//      bound to would export "fine" and animate nothing
//   3. it carries the `swim` and `bite` actions       — the mixer has clips
//   4. shark_far.glb exists, is <= 3,200 tris, is NOT skinned, and carries the
//      four pivot node names the fallback animator drives  — THE TIER GATE.
//      SHARK.MAX_WORLD is 4, so the hero is +28k tris in a low-tier frame if
//      nothing swaps it out; this file is what FaunaMeshFactory takes on `low`.
//   5. neither file grew: the world AABB stays within 0.10 m of the shark the
//      colliders, the hull-avoidance radius and Match's seating were cut from.
//
// RED ON HEAD (before build_fauna_v2.py runs): shark.glb is 1,972 tris with 0
// skins, 0 animations, and shark_far.glb does not exist.
//
//   node scripts/test-fauna-census.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('public/assets/models');
let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function quatMat(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]; }
function nodeMat(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const m = quatMat(r);
  return [m[0] * s[0], m[1] * s[0], m[2] * s[0], 0, m[3] * s[1], m[4] * s[1], m[5] * s[1], 0, m[6] * s[2], m[7] * s[2], m[8] * s[2], 0, t[0], t[1], t[2], 1];
}
function mul(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
function xf(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]; }
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Parse a GLB: tris, skin/animation facts, world-space AABB (node TRS applied,
 *  bind pose — a skinned primitive's POSITION accessor IS its rest pose). */
function readGlb(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bl = buf.readUInt32LE(20 + jl);
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  const view = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const stride = bv.byteStride || 12;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = [];
    for (let k = 0; k < a.count; k++) {
      const o = base + k * stride;
      out.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
    }
    return out;
  };
  let tris = 0, skinnedPrims = 0, rigidPrims = 0;
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const names = new Set();
  const walk = (ni, parent) => {
    const n = json.nodes[ni];
    if (n.name) names.add(n.name);
    const m = mul(parent, nodeMat(n));
    if (n.mesh !== undefined) {
      for (const p of json.meshes[n.mesh].primitives) {
        if (p.attributes.JOINTS_0 !== undefined) skinnedPrims++; else rigidPrims++;
        tris += p.indices !== undefined
          ? json.accessors[p.indices].count / 3
          : json.accessors[p.attributes.POSITION].count / 3;
        // A skinned primitive's node carries the skin's own transform, which
        // glTF says to IGNORE (skinned geometry lives in world space already).
        const wm = p.attributes.JOINTS_0 !== undefined ? ID : m;
        for (const v of view(p.attributes.POSITION)) {
          const w = xf(wm, v);
          for (let i = 0; i < 3; i++) {
            if (w[i] < bb.min[i]) bb.min[i] = w[i];
            if (w[i] > bb.max[i]) bb.max[i] = w[i];
          }
        }
      }
    }
    for (const c of n.children || []) walk(c, m);
  };
  for (const ni of json.scenes[json.scene || 0].nodes) walk(ni, ID);
  return {
    tris: Math.round(tris), skinnedPrims, rigidPrims, names,
    skins: json.skins || [], animations: (json.animations || []).map((a) => a.name),
    bb, bytes: buf.length,
  };
}

const exists = (f) => fs.existsSync(path.join(DIR, f));

console.log('FAUNA CENSUS');
console.log('── shark.glb (hero, skinned) ──────────────────────────────────');
if (!exists('shark.glb')) {
  expect('shark.glb exists', false, 'public/assets/models/shark.glb is missing');
} else {
  const hero = readGlb('shark.glb');
  console.log(`  shark.glb: ${hero.tris} tris, ${(hero.bytes / 1024).toFixed(0)} KB, ` +
    `${hero.skins.length} skin(s), ${hero.skinnedPrims} skinned prim(s), ` +
    `animations [${hero.animations.join(', ')}]`);
  expect('shark.glb >= 8000 tris', hero.tris >= 8000, `is ${hero.tris}`);
  expect('shark.glb carries a skin', hero.skins.length >= 1, `${hero.skins.length} skins`);
  const joints = hero.skins.reduce((n, s) => n + (s.joints || []).length, 0);
  expect('shark skeleton has >= 8 joints (6 body + 2 pectorals)', joints >= 8, `${joints} joints`);
  expect('every drawn primitive of shark.glb is skinned',
    hero.skinnedPrims > 0 && hero.rigidPrims === 0,
    `${hero.skinnedPrims} skinned, ${hero.rigidPrims} rigid`);
  for (const clip of ['swim', 'bite']) {
    expect(`shark.glb carries the '${clip}' action`, hero.animations.includes(clip),
      `has [${hero.animations.join(', ')}]`);
  }
  // Size is load-bearing: SHARK colliders, hull avoidance and Match seating were
  // all cut from the 3.4 m body. glTF is Y-up / -Z forward.
  const half = [0, 1, 2].map((i) => (hero.bb.max[i] - hero.bb.min[i]) / 2);
  console.log(`  hero AABB half-extents ${half.map((v) => v.toFixed(2)).join(' x ')} ` +
    `(minY ${hero.bb.min[1].toFixed(2)})`);
  expect('shark body length unchanged (half-extent Z 1.70 ± 0.10)',
    Math.abs(half[2] - 1.70) <= 0.10, `is ${half[2].toFixed(3)}`);
  expect('shark width unchanged (half-extent X <= 0.95)', half[0] <= 0.95, `is ${half[0].toFixed(3)}`);
  expect('shark keel unchanged (minY -0.48 ± 0.06)',
    Math.abs(hero.bb.min[1] + 0.48) <= 0.06, `is ${hero.bb.min[1].toFixed(3)}`);
}

console.log('── shark_far.glb (low tier / far, rigid pivots) ───────────────');
if (!exists('shark_far.glb')) {
  expect('shark_far.glb exists (the low-tier swap)', false,
    'public/assets/models/shark_far.glb is missing — SHARK.MAX_WORLD=4 heroes ' +
    'would cost ~+28k tris in a low-tier frame with nothing to swap in');
} else {
  const far = readGlb('shark_far.glb');
  console.log(`  shark_far.glb: ${far.tris} tris, ${(far.bytes / 1024).toFixed(0)} KB, ` +
    `nodes [${[...far.names].join(', ')}]`);
  expect('shark_far.glb <= 3200 tris', far.tris <= 3200, `is ${far.tris}`);
  expect('shark_far.glb is NOT skinned (no skinning shader variant on low)',
    far.skins.length === 0 && far.skinnedPrims === 0,
    `${far.skins.length} skins / ${far.skinnedPrims} skinned prims`);
  for (const node of ['shark_tail', 'shark_jaw', 'shark_pec_l', 'shark_pec_r']) {
    expect(`shark_far.glb carries the '${node}' pivot node`, far.names.has(node),
      `nodes are [${[...far.names].join(', ')}]`);
  }
  const half = [0, 1, 2].map((i) => (far.bb.max[i] - far.bb.min[i]) / 2);
  expect('shark_far matches the hero silhouette (half-extent Z 1.70 ± 0.10)',
    Math.abs(half[2] - 1.70) <= 0.10, `is ${half[2].toFixed(3)}`);
}

console.log(`\ntest-fauna-census: ${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`FAIL (${failures})`); process.exit(1); }
console.log('PASS');
