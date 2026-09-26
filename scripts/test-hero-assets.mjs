#!/usr/bin/env node
// HERO GLB CENSUS — the contract for the atlas-textured assets (WEAPON-01,
// HWGLB-01). The island's 63 GLBs are graded by test-asset-bounds and
// glb-census; neither of them knows anything about the things that make a HERO
// asset a hero asset, and every one of those is load-bearing:
//
//   [a] TRIANGLE BAND. SPEC CHANGE (b3.4a, 2026-09-26): the band is no longer
//       hard-coded here; it is the D27 / PLAN 3.12 family band read from the
//       TIERS table in test-asset-tiers.mjs (FP weapons 18-30k, cannon 14-20k,
//       wheel 10-14k, capstan 8-12k, lantern 3-5k), so the two suites cannot
//       disagree. The old bands (guns 3.5-9k, eye 4-11k, cannon 2.5-7k, wheel
//       2-5k, capstan 1.8-4.5k, lantern 0.6-2.5k) were the 2026-09 atlas pass,
//       not a budget; the upper bounds all RISE because the spec moved (D6: higher
//       poly through LOD chains), which is declared, not a loosening. While a
//       file's `<key>:band` row is still in the test-asset-tiers RATCHET (not yet
//       rebuilt), [a] grades the D27 ceiling plus the OLD floor as a no-regress
//       floor, so a pre-rebuild file can neither shrink toward a primitive nor
//       outgrow the D27 ceiling. Both ends fail.
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
//   [k] SINGLE-SIDED (assets-15, b3.4c). Every hero is a closed solid, so a
//       doubleSided material rasterises and shades its back faces for nothing,
//       on the viewmodel that covers a third of a phone screen. Only a CARD
//       material (a pane, a sail, a flag: name matches CARD_MATERIAL) may be
//       doubleSided. The 2026-09 atlas pass exported every hero doubleSided, so
//       the files still to be rebuilt (b3.4e-h, through _pbr.apply_baked /
//       _atlas v2, which set backface culling) are listed in DOUBLE_SIDED_PENDING.
//       The list only shrinks: a listed file that is already single-sided FAILS
//       as stale (drop the row in the rebuild commit), an unlisted doubleSided
//       hero fails, and a name that is not in the roster fails.
//
//   [b'] SPEC CHANGE (b3.4f, 2026-09-26, declared per the b3.4a handoff): a file that has been
//       REBUILT (it left DOUBLE_SIDED_PENDING) is graded as PBR: one material with baseColor +
//       normal + ORM (metallicRoughness and occlusion textures) and at most 3 images. A pending
//       file keeps the old one-image rule until its rebuild lands.
//   [l] CUTLASS BLADE CONTINUITY (assets-04). The v1 blade was three tilted boxes, a kinked,
//       stair-stepped silhouette. The `blade` node must be ONE connected component (positions
//       welded) with >= 600 vertices, >= 95% of its 1 cm stations (bins along +Y) populated, and
//       no lateral step (centre of the station's x extent) > 2 mm per 1 cm station.
//   [m] METAL READS AS METAL (assets-02). Sampling the ORM texture at the UVs of an all-metal
//       node (cutlass `blade`, gun `muzzle`): >= 90% of the samples have ORM.b > 0.8.
//   [n] FIT SCALE (assets-05). The SHIPPED heroWeaponFit formula (fitBoxOnto onto
//       primitiveWeaponBox) must scale every weapon by 0.85-1.15: a hero authored at the wrong
//       size (the v1 flintknock was a 1.14 m musket fitted at 0.50) fails here. The flintknock is
//       also graded as a one-handed pistol: authored length 0.46-0.60 m.
//
// Mutation proof: PIRATES_BR_MUTATE_HERO=cutlass:tris tightens the cutlass band
// to an impossible window (ratchet ignored), and the gate must go red.
//
//   node scripts/test-hero-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { TIERS, RATCHET, tierOf } from './test-asset-tiers.mjs';

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

/** Node's first primitive (hero nodes are one primitive each). */
function nodePrim(g, name) {
  const n = g.json.nodes.find((x) => x.name === name && x.mesh != null);
  return n ? { prim: g.json.meshes[n.mesh].primitives[0], t: n.translation || [0, 0, 0] } : null;
}

// [l] one welded component, 1 cm stations, lateral steps.
function gradeBlade(g, h) {
  const { prim, t } = nodePrim(g, 'blade');
  const pos = readAccessor(g, prim.attributes.POSITION).map((p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]]);
  if (h.mutate === 'kink') for (const p of pos) if (p[1] > 0.6) p[0] += 0.005;
  const ia = g.json.accessors[prim.indices], iv = g.json.bufferViews[ia.bufferView];
  const ioff = (iv.byteOffset || 0) + (ia.byteOffset || 0), isz = COMP[ia.componentType][0];
  const idx = Array.from({ length: ia.count }, (_, i) => (isz === 4 ? g.bin.readUInt32LE(ioff + i * 4)
    : isz === 2 ? g.bin.readUInt16LE(ioff + i * 2) : g.bin.readUInt8(ioff + i)));
  const key = (p) => p.map((c) => Math.round(c * 1e5)).join(',');
  const weld = new Map(), id = pos.map((p) => { const k = key(p); if (!weld.has(k)) weld.set(k, weld.size); return weld.get(k); });
  const parent = Array.from({ length: weld.size }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < idx.length; i += 3) for (const j of [1, 2]) parent[find(id[idx[i + j]])] = find(id[idx[i]]);
  const comps = new Set(parent.map((_, i) => find(i))).size;
  expect(`[l] cutlass blade: ${comps} connected component(s), ${weld.size} welded vertices (one piece, >= 600)`,
    comps === 1 && weld.size >= 600, 'the blade must be one lofted mesh, not boxes');
  const y0 = Math.min(...pos.map((p) => p[1])), y1 = Math.max(...pos.map((p) => p[1]));
  const bins = Math.floor((y1 - y0) / 0.01) + 1, lo = new Array(bins).fill(Infinity), hi = new Array(bins).fill(-Infinity);
  for (const p of pos) { const b = Math.min(bins - 1, Math.floor((p[1] - y0) / 0.01)); lo[b] = Math.min(lo[b], p[0]); hi[b] = Math.max(hi[b], p[0]); }
  let filled = 0, worst = 0, at = -1, prev = -1;
  for (let b = 0; b < bins; b++) {
    if (!Number.isFinite(lo[b])) continue;
    filled += 1;
    const c = (lo[b] + hi[b]) / 2;
    if (prev >= 0) { const step = Math.abs(c - (lo[prev] + hi[prev]) / 2) / (b - prev); if (step > worst) { worst = step; at = b; } }
    prev = b;
  }
  expect(`[l] cutlass blade: ${filled}/${bins} 1 cm stations populated (>= 95%)`, filled >= bins * 0.95);
  expect(`[l] cutlass blade: worst lateral step ${(worst * 1000).toFixed(2)} mm per 1 cm station (<= 2 mm, at y=${(y0 + at * 0.01).toFixed(2)})`,
    worst <= 0.002, 'a kink or a stair step in the blade silhouette');
}

// [m] ORM.b sampled at an all-metal node's UVs.
async function gradeMetal(g, h, node) {
  const { prim } = nodePrim(g, node);
  const mat = g.json.materials[prim.material];
  const ti = mat?.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
  if (ti == null || prim.attributes.TEXCOORD_0 == null) { expect(`[m] ${h.file}: ${node} has an ORM texture and UVs`, false); return; }
  const img = g.json.images[g.json.textures[ti].source];
  const view = g.json.bufferViews[img.bufferView];
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(g.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength)).raw().toBuffer({ resolveWithObject: true });
  const uv = readAccessor(g, prim.attributes.TEXCOORD_0);
  const thr = h.mutate === 'nometal' ? 1.01 : 0.8;
  let metal = 0;
  for (const [u, v] of uv) {
    const x = Math.min(info.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * info.height)));
    if (data[(y * info.width + x) * info.channels + 2] / 255 > thr) metal += 1;
  }
  const frac = metal / Math.max(1, uv.length);
  expect(`[m] ${h.file}: ${(frac * 100).toFixed(1)}% of the ${node} samples read ORM.b > ${thr} (>= 90%)`, frac >= 0.9,
    'metal charts must bake metalness 1.0 (metal_material), or steel reads as plastic');
}

// ── the roster ──────────────────────────────────────────────────────────────
// nodes: names that must survive the build. pivot: extra assertions in glTF
// space (x right, y up, z forward — the same frame the client uses).
const HERO = [
  { file: 'cutlass', tris: [3500, 9000], nodes: ['cutlass_body', 'blade'],
    pivot: (b) => [['blade above the grip', b.get('blade').max[1] > 0.9],
      ['grip at the origin', Math.abs(b.get('cutlass_body').min[1]) < 0.30]] },
  ...['flintlock', 'flintknock', 'blunderbuss'].map((f) => ({
    file: f, tris: [3500, 9000], nodes: [`${f}_body`, 'hammer', 'trigger', 'muzzle'],
    pivot: (b) => [['muzzle forward of the grip', b.get('muzzle').min[2] > 0.25],
      ['hammer above the grip', b.get('hammer').max[1] > 0.05]] })),
  { file: 'eye_of_reach', tris: [4000, 11000],
    nodes: ['eye_of_reach_body', 'hammer', 'trigger', 'muzzle', 'scope'],
    pivot: (b) => [['muzzle forward of the grip', b.get('muzzle').min[2] > 0.9],
      ['scope sits over the bore', b.get('scope').min[1] > 0.04 && b.get('scope').max[1] > 0.17]] },
  // Ship hardware (HWGLB-01). These are the pieces a pirate stands beside, and
  // the only hero family that is MULTIPLIED (eight cannons a galleon, six
  // hulls) — so every one of them carries a far LOD.
  { file: 'cannon', tris: [2500, 7000], far: true, nodes: ['cannon_body', 'barrel'],
    pivot: (b) => [['carriage base on the deck', Math.abs(b.get('cannon_body').min[1]) < 0.04],
      ['barrel points forward (+Z)', b.get('barrel').max[2] > 0.9],
      ['barrel node pivots on the trunnions, not the origin', b.get('barrel').min[1] > 0.35]] },
  { file: 'wheel', tris: [2000, 5000], far: true, nodes: ['wheel_body'],
    pivot: (b) => [['origin on the axle', Math.abs(b.get('wheel_body').min[1] + b.get('wheel_body').max[1]) < 0.06
      && Math.abs(b.get('wheel_body').min[0] + b.get('wheel_body').max[0]) < 0.06],
      ['the disc lies in XY so rotation.z spins it', (b.get('wheel_body').max[2] - b.get('wheel_body').min[2]) < 0.4]] },
  { file: 'capstan', tris: [1800, 4500], far: true, nodes: ['capstan_body', 'drum'],
    pivot: (b) => [['base on the deck', Math.abs(b.get('capstan_body').min[1]) < 0.04],
      ['drum above the deck', b.get('drum').min[1] > 0.05]] },
  { file: 'ship_lantern', tris: [600, 2500], far: true, mats: 2,
    nodes: ['ship_lantern_body', 'glass'],
    pivot: (b) => [['the hook is at y=0 and the body hangs below it',
      Math.abs(b.get('ship_lantern_body').max[1]) < 0.04 && b.get('ship_lantern_body').min[1] < -0.4]] },
];

// [k] files still exported doubleSided by the 2026-09 atlas pass. SHRINK ONLY (see the header).
export const DOUBLE_SIDED_PENDING = ['cannon', 'wheel', 'capstan', 'ship_lantern'];
export const CARD_MATERIAL = /(glass|pane|card|sail|canvas|flag|leaf|flame)/i;
const pending = new Set(DOUBLE_SIDED_PENDING);

// [a] band source: the `tris` literals above are the pre-D27 bands, kept ONLY as the no-regress
// floor for files the test-asset-tiers ratchet still lists as off-band (see the header).
const ratchet = new Set(RATCHET);
for (const h of HERO) {
  const tier = tierOf(h.file);
  if (!tier || !TIERS[tier].band) throw new Error(`${h.file}: no D27 tier band in test-asset-tiers.mjs TIERS`);
  const d27 = TIERS[tier].band;
  h.bandNote = `D27 ${tier} [${d27[0]}, ${d27[1]}]`;
  if (ratchet.has(`${h.file}:band`)) { h.tris = [h.tris[0], d27[1]]; h.bandNote += `, ratcheted: pre-D27 floor ${h.tris[0]}`; }
  else h.tris = d27;
}

const mutate = process.env.PIRATES_BR_MUTATE_HERO ?? '';
if (mutate) {
  const [file, what] = mutate.split(':');
  const row = HERO.find((h) => h.file === file);
  if (row && what === 'tris') { row.tris = [1, 2]; console.log(`  ! mutation: ${file} triangle band -> ${row.tris}`); }
  if (row && what === 'twosided') { pending.delete(file); console.log(`  ! mutation: ${file} dropped from DOUBLE_SIDED_PENDING`); }
  if (what === 'stale') { pending.add(file); console.log(`  ! mutation: ${file} added to DOUBLE_SIDED_PENDING`); }
  if (row && ['kink', 'nometal', 'fit'].includes(what)) { row.mutate = what; console.log(`  ! mutation: ${file} ${what}`); }
}

console.log(`HERO GLB census — ${HERO.length} files\n`);
for (const h of HERO) {
  const file = `${h.file}.glb`;
  if (!fs.existsSync(path.join(DIR, file))) { expect(`${file}: present`, false, 'built by scripts/blender/build_weapons.py / build_ship_hardware.py'); continue; }
  const g = readGlb(file);
  const s = stats(g);
  const boxes = nodeBoxes(g);
  console.log(`  ${h.file.padEnd(16)} ${String(s.tris).padStart(6)} tris  ${s.prims} prims  ${s.mats} mat  ${s.images} img  ${(g.bytes / 1024).toFixed(0)} KB`);
  expect(`[a] ${h.file}: ${s.tris} tris in [${h.tris[0]}, ${h.tris[1]}] (${h.bandNote})`, s.tris >= h.tris[0] && s.tris <= h.tris[1],
    s.tris < h.tris[0] ? 'too coarse for a hero asset' : 'blows the viewmodel budget on the low tier');
  // `mats: 2` is the lantern: its glass is emissive, and an emissive pane baked
  // flat into an albedo atlas is just a yellow sticker.
  const wantMats = h.mats ?? 1;
  if (pending.has(h.file)) {
    expect(`[b] ${h.file}: ${wantMats} material(s), one of them the atlas with a baseColorTexture`,
      s.mats === wantMats && s.textured === 1 && s.images === 1,
      `${s.mats} materials, ${s.textured} textured, ${s.images} images — the Cycles bake did not land`);
  } else {
    const pbr = (g.json.materials || []).filter((m) => m.pbrMetallicRoughness?.baseColorTexture && m.normalTexture
      && m.occlusionTexture && m.pbrMetallicRoughness?.metallicRoughnessTexture);
    expect(`[b'] ${h.file}: ${wantMats} material(s), one PBR (baseColor + normal + ORM), ${s.images} images <= 3`,
      s.mats === wantMats && pbr.length === 1 && s.images >= 2 && s.images <= 3,
      `${s.mats} materials, ${pbr.length} with the full PBR set, ${s.images} images`);
  }
  expect(`[c] ${h.file}: COLOR_0 on every primitive and white (min ${s.colorMin.toFixed(3)})`,
    s.color0 === s.prims && s.colorMin >= 0.94, 'AO is in the atlas; a non-white COLOR_0 applies it twice');
  for (const n of h.nodes) expect(`[d] ${h.file}: node '${n}' survives the build`, boxes.has(n), `nodes: ${[...boxes.keys()].join(', ')}`);
  if (h.nodes.every((n) => boxes.has(n))) for (const [label, ok] of h.pivot(boxes)) expect(`[e] ${h.file}: ${label}`, ok);
  expect(`[f] ${h.file}: no skins, no animations`, s.skins === 0 && s.anims === 0);
  expect(`[g] ${h.file}: ${s.prims} primitives ≤ ${h.nodes.length + 1}`, s.prims <= h.nodes.length + 1,
    'the atlas exists so the file draws in a handful of calls');
  {
    const two = (g.json.materials || []).filter((m) => m.doubleSided && !CARD_MATERIAL.test(m.name || ''));
    if (pending.has(h.file)) {
      expect(`[k] ${h.file}: still doubleSided, so its DOUBLE_SIDED_PENDING row is live (rebuild pending)`, two.length > 0,
        'the file is single-sided now: drop it from DOUBLE_SIDED_PENDING in the rebuild commit (the list only shrinks)');
    } else {
      expect(`[k] ${h.file}: every non-card material single-sided (doubleSided false)`, two.length === 0,
        `doubleSided: ${two.map((m) => m.name).join(', ')} — closed solids cull back faces (use_backface_culling)`);
    }
  }
  if (h.file === 'cutlass' && boxes.has('blade')) gradeBlade(g, h);
  if (!pending.has(h.file) && (boxes.has('blade') || boxes.has('muzzle'))) await gradeMetal(g, h, boxes.has('blade') ? 'blade' : 'muzzle');
  if (h.far) {
    const farFile = `${h.file}_far.glb`;
    if (!fs.existsSync(path.join(DIR, farFile))) { expect(`[h] ${farFile}: present (LOD1 at 60 m)`, false); continue; }
    const fs2 = stats(readGlb(farFile));
    expect(`[h] ${h.file}_far: ${fs2.tris} tris ≤ 45% of ${s.tris}`, fs2.tris <= s.tris * 0.45,
      'a far LOD that saves nothing is a second upload for nothing');
  }
}

// [n] the shipped fit, on the real bounds.
{
  let api = null, why = '';
  try {
    const { tsImport } = await import('tsx/esm/api');
    const { installCanvasStub } = await import('./lib/canvas-stub.mjs');
    installCanvasStub();
    api = await tsImport('../src/client/rendering/factories/WeaponMeshFactory.ts', import.meta.url);
  } catch (e) { why = String(e?.message ?? e).split('\n')[0]; }
  expect('[n] WeaponMeshFactory (fitBoxOnto, primitiveWeaponBox) loads for the fit check', !!api, why);
  if (api) {
    const THREE = await import('three');
    for (const h of HERO.filter((x) => ['cutlass', 'flintlock', 'flintknock', 'blunderbuss', 'eye_of_reach'].includes(x.file))) {
      const boxes = nodeBoxes(readGlb(`${h.file}.glb`));
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const b of boxes.values()) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
      const fit = api.fitBoxOnto(new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), api.primitiveWeaponBox(h.file));
      const lo = h.mutate === 'fit' ? 0.999 : 0.85, hi = h.mutate === 'fit' ? 1.0 : 1.15;
      expect(`[n] ${h.file}: heroWeaponFit scale ${fit.scale.toFixed(3)} in [${lo}, ${hi}] (long axis ${fit.axis})`,
        fit.scale >= lo && fit.scale <= hi, 'author the file at the size of the envelope it replaces');
      if (h.file === 'flintknock') {
        const len = max[2] - min[2];
        expect(`[n] flintknock: authored length ${len.toFixed(3)} m in [0.46, 0.60] (a one-handed pistol, not a shrunken musket)`,
          len >= 0.46 && len <= 0.60);
      }
    }
  }
}

for (const f of pending) {
  expect(`[k] DOUBLE_SIDED_PENDING row '${f}' names a hero in the roster`, HERO.some((h) => h.file === f));
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
