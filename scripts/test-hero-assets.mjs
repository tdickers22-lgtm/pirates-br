#!/usr/bin/env node
// HERO GLB CENSUS — the contract for the atlas-textured assets (WEAPON-01,
// HWGLB-01). The island's 63 GLBs are graded by test-asset-bounds and
// glb-census; neither of them knows anything about the things that make a HERO
// asset a hero asset, and every one of those is load-bearing:
//
//   [a] TRIANGLE BAND. A weapon the player stares at from 40 cm needs 4-8k; a
//       weapon at 40k would cost the viewmodel layer its budget on the low tier.
//       Both ends fail.
//   [b] ONE MATERIAL, WITH A TEXTURE. The whole point of the authored atlas
//       (PLAN 2.4b) is that a five-material union collapses to one draw with
//       one baseColorTexture. A file that comes back with the palette materials
//       and no image means the bake silently no-oped.
//   [c] COLOR_0 PRESENT AND WHITE. AssetLibrary.mergedGeometry needs uniform
//       attributes (all-or-nothing COLOR_0), and the client multiplies
//       vertexColors into the albedo — which now already contains the AO. Any
//       channel below 0.94 is the AO being applied twice.
//   [d] NODE NAMES. `hammer`, `trigger`, `muzzle`, `barrel`, `drum`, `axle`
//       are addressed by name by the viewmodel, the cannon aim rig and the
//       station arbiter. A rebuild that joins them away breaks aiming silently.
//   [e] PIVOTS. Grip at the origin and muzzle toward +Z for a gun; blade up for
//       the cutlass; carriage base at y=0 for the cannon. A GLB whose origin
//       moved puts the weapon through the player's hand.
//   [f] NO SKINS, NO ANIMATIONS. These are rigidly posed props; a skin would
//       silently double their vertex cost in the merge path.
//   [g] DRAW SPLIT. primitives ≤ the named-node count + 1: the atlas exists so
//       the file is a handful of draws.
//   [h] FAR LOD. Ship hardware is instanced on every hull, so each piece ships a
//       `<name>_far.glb` under 45% of its triangles (LOD1 at 60 m).
//
// Mutation proof: PIRATES_BR_MUTATE_HERO=cutlass:tris tightens the cutlass band
// to an impossible window, and the gate must go red.
//
//   node scripts/test-hero-assets.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('public/assets/models');
let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function readGlb(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bl = buf.readUInt32LE(20 + jl);
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  return { json, bin, bytes: buf.length };
}

const COMP = { 5120: [1, (b, o) => b.readInt8(o) / 127], 5121: [1, (b, o) => b.readUInt8(o) / 255], 5122: [2, (b, o) => b.readInt16LE(o) / 32767], 5123: [2, (b, o) => b.readUInt16LE(o) / 65535], 5125: [4, (b, o) => b.readUInt32LE(o)], 5126: [4, (b, o) => b.readFloatLE(o)] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(g, ai, limit = Infinity) {
  const a = g.json.accessors[ai];
  const [size, get] = COMP[a.componentType];
  const n = NCOMP[a.type];
  const view = g.json.bufferViews[a.bufferView];
  const stride = view.byteStride || size * n;
  const off = (view.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  const count = Math.min(a.count, limit);
  for (let i = 0; i < count; i++) {
    const b = off + i * stride;
    const v = [];
    for (let c = 0; c < n; c++) v.push(get(g.bin, b + c * size));
    out.push(v);
  }
  return out;
}

/** Per-node world AABB from accessor min/max (node TRS applied). */
function nodeBoxes(g) {
  const out = new Map();
  const walk = (ni, t) => {
    const n = g.json.nodes[ni];
    const tr = n.translation || [0, 0, 0];
    const nt = [t[0] + tr[0], t[1] + tr[1], t[2] + tr[2]];
    if (n.mesh != null) {
      const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const prim of g.json.meshes[n.mesh].primitives) {
        const a = g.json.accessors[prim.attributes.POSITION];
        for (let i = 0; i < 3; i++) {
          box.min[i] = Math.min(box.min[i], a.min[i] + nt[i]);
          box.max[i] = Math.max(box.max[i], a.max[i] + nt[i]);
        }
      }
      out.set(n.name || `node${ni}`, box);
    }
    for (const c of n.children || []) walk(c, nt);
  };
  for (const ni of g.json.scenes[g.json.scene || 0].nodes) walk(ni, [0, 0, 0]);
  return out;
}

function stats(g) {
  let tris = 0, prims = 0, color0 = 0, colorMin = 1;
  for (const mesh of g.json.meshes || []) {
    for (const prim of mesh.primitives) {
      prims += 1;
      tris += prim.indices != null
        ? g.json.accessors[prim.indices].count / 3
        : g.json.accessors[prim.attributes.POSITION].count / 3;
      if (prim.attributes.COLOR_0 != null) {
        color0 += 1;
        for (const c of readAccessor(g, prim.attributes.COLOR_0, 400)) {
          colorMin = Math.min(colorMin, c[0], c[1], c[2]);
        }
      }
    }
  }
  const textured = (g.json.materials || []).filter((m) => m.pbrMetallicRoughness?.baseColorTexture);
  return { tris, prims, color0, colorMin, mats: (g.json.materials || []).length, textured: textured.length,
    skins: (g.json.skins || []).length, anims: (g.json.animations || []).length,
    images: (g.json.images || []).length };
}

// ── the roster ──────────────────────────────────────────────────────────────
// nodes: names that must survive the build. pivot: extra assertions in glTF
// space (x right, y up, z forward — the same frame the client uses).
const HERO = [
  { file: 'cutlass', tris: [3500, 9000], nodes: ['cutlass_body'],
    pivot: (b) => [['blade above the grip', b.get('cutlass_body').max[1] > 0.9],
      ['grip at the origin', Math.abs(b.get('cutlass_body').min[1]) < 0.30]] },
  ...['flintlock', 'flintknock', 'blunderbuss'].map((f) => ({
    file: f, tris: [3500, 9000], nodes: [`${f}_body`, 'hammer', 'trigger', 'muzzle'],
    pivot: (b) => [['muzzle forward of the grip', b.get('muzzle').min[2] > 0.25],
      ['hammer above the grip', b.get('hammer').max[1] > 0.05]] })),
  { file: 'eye_of_reach', tris: [4000, 11000],
    nodes: ['eye_of_reach_body', 'hammer', 'trigger', 'muzzle', 'scope'],
    pivot: (b) => [['muzzle forward of the grip', b.get('muzzle').min[2] > 0.9],
      ['scope sits over the bore', b.get('scope').min[1] > 0.04 && b.get('scope').max[1] > 0.17]] },
];

const mutate = process.env.PIRATES_BR_MUTATE_HERO ?? '';
if (mutate) {
  const [file, what] = mutate.split(':');
  const row = HERO.find((h) => h.file === file);
  if (row && what === 'tris') { row.tris = [row.tris[1] + 1, row.tris[1] + 2]; console.log(`  ! mutation: ${file} triangle band -> ${row.tris}`); }
}

console.log(`HERO GLB census — ${HERO.length} files\n`);
for (const h of HERO) {
  const file = `${h.file}.glb`;
  if (!fs.existsSync(path.join(DIR, file))) { expect(`${file}: present`, false, 'built by scripts/blender/build_weapons.py / build_ship_hardware.py'); continue; }
  const g = readGlb(file);
  const s = stats(g);
  const boxes = nodeBoxes(g);
  console.log(`  ${h.file.padEnd(16)} ${String(s.tris).padStart(6)} tris  ${s.prims} prims  ${s.mats} mat  ${s.images} img  ${(g.bytes / 1024).toFixed(0)} KB`);
  expect(`[a] ${h.file}: ${s.tris} tris in [${h.tris[0]}, ${h.tris[1]}]`, s.tris >= h.tris[0] && s.tris <= h.tris[1],
    s.tris < h.tris[0] ? 'too coarse for a hero asset' : 'blows the viewmodel budget on the low tier');
  expect(`[b] ${h.file}: one atlas material with a baseColorTexture`, s.mats === 1 && s.textured === 1 && s.images === 1,
    `${s.mats} materials, ${s.textured} textured, ${s.images} images — the Cycles bake did not land`);
  expect(`[c] ${h.file}: COLOR_0 on every primitive and white (min ${s.colorMin.toFixed(3)})`,
    s.color0 === s.prims && s.colorMin >= 0.94, 'AO is in the atlas; a non-white COLOR_0 applies it twice');
  for (const n of h.nodes) expect(`[d] ${h.file}: node '${n}' survives the build`, boxes.has(n), `nodes: ${[...boxes.keys()].join(', ')}`);
  if (h.nodes.every((n) => boxes.has(n))) for (const [label, ok] of h.pivot(boxes)) expect(`[e] ${h.file}: ${label}`, ok);
  expect(`[f] ${h.file}: no skins, no animations`, s.skins === 0 && s.anims === 0);
  expect(`[g] ${h.file}: ${s.prims} primitives ≤ ${h.nodes.length + 1}`, s.prims <= h.nodes.length + 1,
    'the atlas exists so the file draws in a handful of calls');
  if (h.far) {
    const farFile = `${h.file}_far.glb`;
    if (!fs.existsSync(path.join(DIR, farFile))) { expect(`[h] ${farFile}: present (LOD1 at 60 m)`, false); continue; }
    const fs2 = stats(readGlb(farFile));
    expect(`[h] ${h.file}_far: ${fs2.tris} tris ≤ 45% of ${s.tris}`, fs2.tris <= s.tris * 0.45,
      'a far LOD that saves nothing is a second upload for nothing');
  }
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
