#!/usr/bin/env node
// FLOOD-LOOP TOOL GLBs (b2.3h, assets-06) — pure node, no GL, < 0.1 s.
//
// The bucket, the plank bundle and the claw hammer are held in front of the
// camera for minutes per match while the ship fills; they were primitive unions.
// scripts/blender/build_tools.py now ships them as atlas GLBs with three LODs
// each. This grades what the client relies on:
//   * each file exists, and its LOD0 / LOD1 / LOD2 triangle counts sit in the
//     D27 row (LOD0 3-10k, LOD1 1.5-3k third person, LOD2 <= 700);
//   * the node names are an API: bucket-water, hammer-head, hammer-haft (and
//     their _lod1/_lod2 twins, which cloneToolGlb renames back);
//   * the pivots match the primitive frame: hammer grip at the origin with the
//     head UP (+Y) and the striking face toward -Z (the viewmodel's blow lands
//     that face on the plank), bucket bottom at y -0.10 with the rim UP (+Y)
//     and the water disc inside the rim, planks 0.24 x 0.40 flat;
//   * one baked atlas material per tool (the water keeps its own);
//   * the factories actually clone them (a GLB nothing loads is not shipped).
//
//   node scripts/test-tool-assets.mjs [--models <dir>]   (red run: an empty dir)
import fs from 'node:fs';
import path from 'node:path';

const argi = process.argv.indexOf('--models');
const DIR = path.resolve(argi > 0 ? process.argv[argi + 1] : 'public/assets/models');
let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function readGlb(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  return { json: JSON.parse(buf.subarray(20, 20 + jl).toString()), bytes: buf.length };
}

/** name -> { tris, box } (node translation/scale applied; builders bake rotation). */
function nodes(g) {
  const out = new Map();
  const walk = (ni, t, sc) => {
    const n = g.json.nodes[ni];
    const tr = n.translation || [0, 0, 0], s = n.scale || [1, 1, 1];
    const nt = [0, 1, 2].map((i) => t[i] + tr[i] * sc[i]);
    const ns = [0, 1, 2].map((i) => sc[i] * s[i]);
    if (n.mesh != null) {
      let tris = 0;
      const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const prim of g.json.meshes[n.mesh].primitives) {
        const a = g.json.accessors[prim.attributes.POSITION];
        tris += prim.indices != null ? g.json.accessors[prim.indices].count / 3 : a.count / 3;
        for (let i = 0; i < 3; i++) {
          box.min[i] = Math.min(box.min[i], a.min[i] * ns[i] + nt[i]);
          box.max[i] = Math.max(box.max[i], a.max[i] * ns[i] + nt[i]);
        }
      }
      out.set(n.name || `node${ni}`, { tris, box });
    }
    for (const c of n.children || []) walk(c, nt, ns);
  };
  for (const ni of g.json.scenes[g.json.scene || 0].nodes) walk(ni, [0, 0, 0], [1, 1, 1]);
  return out;
}

const lodOf = (name) => { const m = /_lod(\d)$/.exec(name); return m ? Number(m[1]) : 0; };
const BANDS = [[3000, 10000], [1500, 3000], [150, 700]];
const NAMED = {
  tool_bucket: ['bucket-water'], tool_planks: [], tool_hammer: ['hammer-head', 'hammer-haft'],
  // b3.4g: the rest of the held kit (named nodes are the animation/material API)
  tool_spyglass: ['spyglass-eyepiece', 'spyglass-body', 'spyglass-tube-1', 'spyglass-tube-2'],
  tool_compass: ['compass-body', 'compass-needle', 'compass-glass'],
  tool_lantern: ['lantern-body', 'lantern-glass', 'lantern-flame'],
  tool_shovel: ['shovel-body'],
  tool_axe: ['axe-head', 'axe-haft'],
  tool_food: ['food-banana', 'food-coconut', 'food-mango', 'food-meat'],
  tool_keg: ['keg-body', 'keg-fuse'],
  tool_chest: ['chest-body', 'chest-lid'],
};
const MAX_BYTES = 800 * 1024; // unpacked v1; b3.1a (meshopt + KTX2) shrinks them

const parsed = {};
for (const name of Object.keys(NAMED)) {
  const file = `${name}.glb`;
  const exists = fs.existsSync(path.join(DIR, file));
  expect(`${file} exists`, exists, exists ? '' : `missing in ${DIR}`);
  if (!exists) continue;
  const g = readGlb(file);
  const ns = nodes(g);
  parsed[name] = ns;
  expect(`${file}: <= ${MAX_BYTES / 1024} KB before the pack step`, g.bytes <= MAX_BYTES, `${(g.bytes / 1024).toFixed(0)} KB`);
  for (let lod = 0; lod < 3; lod++) {
    const tris = [...ns].filter(([n]) => lodOf(n) === lod).reduce((s, [, v]) => s + v.tris, 0);
    const [lo, hi] = BANDS[lod];
    expect(`${file}: LOD${lod} ${lo}-${hi} tris`, tris >= lo && tris <= hi, `${tris} tris`);
  }
  for (const n of NAMED[name]) {
    for (const suf of ['', '_lod1', '_lod2']) expect(`${file}: node ${n}${suf}`, ns.has(n + suf));
  }
  const atlas = (g.json.materials || []).filter((m) => /^Atlas_/.test(m.name) && m.pbrMetallicRoughness?.baseColorTexture);
  expect(`${file}: one baked atlas material with a texture`, atlas.length === 1, (g.json.materials || []).map((m) => m.name).join(', '));
}

const H = parsed.tool_hammer;
if (H?.has('hammer-head') && H.has('hammer-haft')) {
  const head = H.get('hammer-head').box, haft = H.get('hammer-haft').box;
  const hy = (head.min[1] + head.max[1]) / 2;
  expect('hammer pivot: grip at the origin (the haft spans y 0)', haft.min[1] < -0.1 && haft.max[1] > 0.1, `haft y ${haft.min[1].toFixed(3)}..${haft.max[1].toFixed(3)}`);
  expect('hammer pivot: head UP (+Y), centred ~0.16 above the grip', hy > 0.12 && hy < 0.2 && Math.abs(head.min[0] + head.max[0]) < 0.01, `head centre y ${hy.toFixed(3)}`);
  expect('hammer: striking face toward -Z (0.074), claw toward +Z', head.min[2] < -0.066 && head.min[2] > -0.085 && head.max[2] > 0.05, `head z ${head.min[2].toFixed(3)}..${head.max[2].toFixed(3)}`);
}
const B = parsed.tool_bucket;
if (B?.has('bucket-body') && B.has('bucket-water')) {
  const body = B.get('bucket-body').box, water = B.get('bucket-water').box;
  const wy = (water.min[1] + water.max[1]) / 2, wr = (water.max[0] - water.min[0]) / 2;
  expect('bucket pivot: bottom at y -0.10 (same frame as the primitive)', Math.abs(body.min[1] + 0.1) < 0.006, `bottom ${body.min[1].toFixed(3)}`);
  expect('bucket pivot: rim UP (+Y), water disc inside the body above centre', wy > 0 && wy < 0.1 && body.max[1] > 0.1, `water y ${wy.toFixed(3)}, top ${body.max[1].toFixed(3)}`);
  expect('bucket: water disc sits inside the staves (radius < 0.1)', wr > 0.07 && wr < 0.1, `r ${wr.toFixed(3)}`);
}
const P = parsed.tool_planks;
if (P?.has('planks-body')) {
  const b = P.get('planks-body').box;
  const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], l = b.max[2] - b.min[2];
  expect('planks: 0.24 x 0.40 bundle lying flat (primitive frame)', w > 0.22 && w < 0.28 && l > 0.38 && l < 0.46 && h < 0.1, `${w.toFixed(3)} x ${h.toFixed(3)} x ${l.toFixed(3)}`);
}

// b3.4g pivots: the same frames as the primitives in makePocketPreviewMesh
const box = (g, n) => g?.get(n)?.box;
const cz = (b) => (b.min[2] + b.max[2]) / 2, cy = (b) => (b.min[1] + b.max[1]) / 2;
const SG = parsed.tool_spyglass;
if (SG?.has('spyglass-eyepiece') && SG.has('spyglass-tube-2')) {
  const eye = box(SG, 'spyglass-eyepiece'), obj = box(SG, 'spyglass-tube-2'), t1 = box(SG, 'spyglass-tube-1'), body = box(SG, 'spyglass-body');
  expect('spyglass: eyepiece toward -Z (faces the camera after rotation.y = PI), objective toward +Z',
    eye.max[2] < obj.min[2] && eye.min[2] < -0.15 && obj.max[2] > 0.24, `eye z ${eye.min[2].toFixed(3)}..${eye.max[2].toFixed(3)}, objective ..${obj.max[2].toFixed(3)}`);
  expect('spyglass: tubes stack eyepiece < body < tube-1 < tube-2 along +Z on the axis',
    cz(eye) < cz(body) && cz(body) < cz(t1) && cz(t1) < cz(obj) && Math.abs(eye.min[0] + eye.max[0]) < 0.004 && Math.abs(obj.min[1] + obj.max[1]) < 0.004);
}
const CP = parsed.tool_compass;
if (CP?.has('compass-needle') && CP.has('compass-body')) {
  const n = box(CP, 'compass-needle'), c = box(CP, 'compass-body');
  expect('compass: needle centred on the spin axis (origin), north +Y, in front of the dial (-Z)',
    Math.abs(n.min[0] + n.max[0]) < 0.004 && Math.abs(n.min[1] + n.max[1]) < 0.004 && n.max[1] > 0.04 && n.max[2] < -0.005 && n.min[2] > c.min[2],
    `needle x ${n.min[0].toFixed(3)}..${n.max[0].toFixed(3)} y ${n.min[1].toFixed(3)}..${n.max[1].toFixed(3)} z ${n.min[2].toFixed(3)}..${n.max[2].toFixed(3)}`);
}
const LT = parsed.tool_lantern;
if (LT?.has('lantern-body') && LT.has('lantern-flame')) {
  const b = box(LT, 'lantern-body'), f = box(LT, 'lantern-flame'), gl = box(LT, 'lantern-glass');
  expect('lantern: Y up, base y ~-0.155, flame inside the glass', Math.abs(b.min[1] + 0.155) < 0.01 && b.max[1] > 0.2 && f.min[1] > gl.min[1] && f.max[1] < gl.max[1], `base ${b.min[1].toFixed(3)} top ${b.max[1].toFixed(3)}`);
}
const SH = parsed.tool_shovel;
if (SH?.has('shovel-body')) {
  const b = box(SH, 'shovel-body');
  expect('shovel: grip at -Z, blade toward +Z (primitive frame -0.45..0.50)', b.min[2] < -0.43 && b.max[2] > 0.47 && b.max[0] - b.min[0] > 0.16, `z ${b.min[2].toFixed(3)}..${b.max[2].toFixed(3)}`);
}
const AX = parsed.tool_axe;
if (AX?.has('axe-head') && AX.has('axe-haft')) {
  const h = box(AX, 'axe-head'), f = box(AX, 'axe-haft');
  expect('axe: head at z ~0.19 on the haft end, bit DOWN (-Y) to ~-0.17', Math.abs(cz(h) - 0.2) < 0.03 && h.min[1] < -0.15 && f.min[2] < -0.28, `head z ${cz(h).toFixed(3)} y ${h.min[1].toFixed(3)}`);
}
const KG = parsed.tool_keg;
if (KG?.has('keg-body') && KG.has('keg-fuse')) {
  const b = box(KG, 'keg-body'), f = box(KG, 'keg-fuse');
  expect('keg: body y -0.125..0.125 (radius <= 0.135), fuse out of the top (+Y)', Math.abs(b.min[1] + 0.125) < 0.006 && b.max[0] < 0.136 && f.max[1] > 0.18, `body y ${b.min[1].toFixed(3)}..${b.max[1].toFixed(3)}, fuse top ${f.max[1].toFixed(3)}`);
}
const CH = parsed.tool_chest;
if (CH?.has('chest-body') && CH.has('chest-lid')) {
  const b = box(CH, 'chest-body'), l = box(CH, 'chest-lid');
  expect('chest: body 0.46 x 0.30 from y ~-0.19, lid dome above it', Math.abs(b.min[1] + 0.19) < 0.012 && cy(l) > cy(b) && l.max[1] > 0.2 && b.max[0] - b.min[0] > 0.44 && b.max[0] - b.min[0] < 0.5, `body y ${b.min[1].toFixed(3)}, lid top ${l.max[1].toFixed(3)}`);
}
const FD = parsed.tool_food;
if (FD) for (const n of NAMED.tool_food) {
  const b = box(FD, n);
  if (b) expect(`food: ${n} centred near the origin, hand-sized (<= 0.42 m, the primitive meat is 0.40)`, Math.max(...[0, 1, 2].map((i) => b.max[i] - b.min[i])) <= 0.42 && [0, 1, 2].every((i) => Math.abs(b.min[i] + b.max[i]) / 2 < 0.08));
}

const wmf = fs.readFileSync('src/client/rendering/factories/WeaponMeshFactory.ts', 'utf8');
const mmf = fs.readFileSync('src/client/rendering/factories/MiscMeshFactory.ts', 'utf8');
expect('WeaponMeshFactory clones tool_bucket / tool_planks for the bucket and wood kinds',
  /bucket: 'tool_bucket'/.test(wmf) && /wood: 'tool_planks'/.test(wmf) && /cloneToolGlb\(entry, lod\)/.test(wmf));
expect('MiscMeshFactory: the carpenter\'s hammer is tool_hammer.glb', /cloneToolGlb\('tool_hammer', lod\)/.test(mmf));
for (const [kind, file] of [['spyglass', 'tool_spyglass'], ['compass', 'tool_compass'], ['lantern', 'tool_lantern'], ['shovel', 'tool_shovel'], ['axe', 'tool_axe'],
  ['banana', 'tool_food'], ['coconut', 'tool_food'], ['mango', 'tool_food'], ['meat', 'tool_food'], ['powder_keg', 'tool_keg'], ['chest', 'tool_chest']]) {
  expect(`WeaponMeshFactory: pocket kind ${kind} clones ${file}`, new RegExp(`${kind}: \\[?'${file}'`).test(wmf));
}
expect('MiscMeshFactory: ToolGlbName covers the b3.4g kit, clones can keep one food node', /'tool_chest'/.test(mmf) && /only\?: string/.test(mmf));
expect('keg / chest keep the carrying hands when the GLB replaces the primitive', /pocketKeep/.test(wmf));

console.log(`\n${checks - failures}/${checks} checks`);
if (failures) { console.error(`FAIL: ${failures} tool asset check(s)`); process.exit(1); }
console.log('PASS: tool GLBs (flood loop + b3.4g kit) in band, named, pivoted, wired');
