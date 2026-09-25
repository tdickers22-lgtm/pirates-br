// test-model-transport (b3.1a; performance-01, assets-03, vm:performance:7).
//
// Every GLB the client fetches is the packed sibling of a Blender export
// (public/assets/models/packed/<name>.glb, written by scripts/pack-models.mjs):
//   1. it exists, was packed from exactly today's source bytes (srcSha256),
//      declares + requires EXT_meshopt_compression, and KHR_mesh_quantization
//      wherever a NORMAL exists (quantised normals/colours/UVs);
//   2. decoded, it is the same model: node names in order, node TRS, material
//      names, primitive count/mode, triangle count per primitive, POSITION
//      still float32 (outside QUANTISED_POSITION_FAMILIES) and world bounds
//      within 2^-15 of the extent (the pack step rounds 8 mantissa bits);
//   3. brotli per download set (AssetLibrary sets; far = *_far): boot <= 0.6,
//      world <= 6, lazy <= 12, far <= 1 MB (PLAN 3.4 / b3.1a; MODEL_SET_BUDGETS_MB);
//   3b. (b3.1g, D27, critique gap 4) brotli PER FAMILY per set: every key has a
//      family (modelManifest.modelFamily), the world set (boot + world + far
//      siblings + story proxies + the basis transcoder, charged to `shared`) and
//      the streamed set (story LOD0) are summed per family and each family is
//      graded on its OWN row of FAMILY_WIRE_MB, desktop and mobile (phones fetch
//      the desktop sets today, so both columns grade the same bytes until a lane
//      gives phones their own set). Declared deviations may only shrink; every
//      column of the table must sum exactly to its D27 total (a [realloc] moves
//      bytes between rows, never raises a sum).
//   4. the client fetches the packed tree (modelManifest.modelUrl) and wires
//      the meshopt decoder into AssetLibrary's loader.
// --mutate: one packed file replaced by its raw source -> must FAIL.
// --mutate-family <fam>: that family's world bytes grow to 200 KB over its
//   desktop row -> its rows FAIL and every other family row keeps its verdict.
// PIRATES_BR_MUTATE_FAMILY_ROW=<fam>.<column>: +0.1 MB on one allocation row ->
//   the column-sum check FAILS (a row raised without lowering another).
// --consumers: also runs test-asset-merge, test-far-lod-integrity,
//   test-asset-bounds and test-hero-assets on the packed bytes
//   (scripts/lib/packed-glb-hook.mjs) and requires them green.
//   node --import tsx scripts/test-model-transport.mjs [--mutate] [--consumers]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { getBounds } from '@gltf-transform/core';
import { packIO, SRC_DIR, listSources, readGlbJson, sha256, QUANTISED_POSITION_FAMILIES, packedFile, readManifest, hashedName } from './pack-models.mjs';
import { BOOT_ASSET_NAMES, LAZY_ASSET_NAMES, STORY_PROXY_NAMES } from '../src/client/assets/AssetLibrary.ts';
import { MODEL_FAMILIES as CLIENT_FAMILIES, modelFamily } from '../src/client/assets/modelManifest.ts';
import { MODEL_SET_BUDGETS_MB, MODEL_FAMILIES, FAMILY_WIRE_MB, FAMILY_WIRE_TOTALS_MB, FAMILY_WIRE_DEVIATIONS_MB } from './lib/budgets.mjs';

const ROOT = path.resolve(SRC_DIR, '../../..');
const MUTATE = process.argv.includes('--mutate');
const CONSUMERS = process.argv.includes('--consumers');
const BUDGET_MB = MODEL_SET_BUDGETS_MB;
const famArg = process.argv.indexOf('--mutate-family');
const MUTATE_FAMILY = famArg > 0 ? process.argv[famArg + 1] : null;
/** D27 column totals (PLAN section 2, critique gap 4): the allocation's sums may never exceed these. */
const D27_TOTALS = { worldDesktop: 6.0, worldMobile: 4.5, streamedDesktop: 12.0, streamedMobile: 6.0 };
const COLUMNS = Object.keys(D27_TOTALS);
const fails = [];
const fail = (m) => { fails.push(m); console.log(`FAIL ${m}`); };
const io = await packIO();
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
const boot = new Set(BOOT_ASSET_NAMES); const lazy = new Set(LAZY_ASSET_NAMES);
// A story scene's `_far` proxy rides the world set (AssetLibrary STORY_PROXY_NAMES).
const proxy = new Set(STORY_PROXY_NAMES.map((n) => `${n}_far`));
const setOf = (n) => proxy.has(n) ? 'world' : n.endsWith('_far') ? 'far' : boot.has(n) ? 'boot' : lazy.has(n) ? 'lazy' : 'world';

const names = listSources();
const MANIFEST = readManifest();
if (names.length < 100) fail(`only ${names.length} source GLBs found (vacuous)`);
const setBytes = { boot: 0, world: 0, lazy: 0, far: 0 };
const famBytes = Object.fromEntries(MODEL_FAMILIES.map((f) => [f, { world: 0, streamed: 0 }]));
let meshoptFiles = 0; let tris = 0;
for (const [i, name] of names.entries()) {
  const srcBytes = fs.readFileSync(path.join(SRC_DIR, `${name}.glb`));
  const packedPath = packedFile(name, MANIFEST);
  if (!packedPath || !fs.existsSync(packedPath)) { fail(`${name}: no packed file in model-manifest.json (run node scripts/pack-models.mjs)`); continue; }
  const bytes = MUTATE && i === 0 ? srcBytes : fs.readFileSync(packedPath);
  // b3.1b: the name IS the content (served immutable), so it must match the bytes.
  if (path.basename(packedPath) !== hashedName(name, bytes)) fail(`${name}: ${path.basename(packedPath)} does not name its bytes (${hashedName(name, bytes)})`);
  const json = readGlbJson(bytes);
  const used = json.extensionsUsed ?? []; const req = json.extensionsRequired ?? [];
  if (!used.includes('EXT_meshopt_compression') || !req.includes('EXT_meshopt_compression')) { fail(`${name}: not EXT_meshopt_compression (raw GLB shipped)`); continue; }
  meshoptFiles += 1;
  if (json.asset?.extras?.source?.srcSha256 !== sha256(srcBytes)) fail(`${name}: packed from different source bytes (stale; rerun pack-models)`);
  const hasNormal = (json.meshes ?? []).some((m) => m.primitives.some((p) => 'NORMAL' in p.attributes));
  if (hasNormal && !used.includes('KHR_mesh_quantization')) fail(`${name}: normals present but no KHR_mesh_quantization`);
  const nb = br(bytes);
  setBytes[setOf(name)] += nb;
  const fam = modelFamily(name);
  if (!fam || !famBytes[fam]) fail(`${name}: no D27 family in modelManifest MODEL_FAMILY_OF (every GLB is charged to one)`);
  else famBytes[fam][setOf(name) === 'lazy' ? 'streamed' : 'world'] += nb;
  const [a, b] = [await io.readBinary(new Uint8Array(srcBytes)), await io.readBinary(new Uint8Array(bytes))];
  const [ra, rb] = [a.getRoot(), b.getRoot()];
  const nn = (r) => r.listNodes().map((n) => n.getName()).join('|');
  if (nn(ra) !== nn(rb)) fail(`${name}: node names differ`);
  const trs = (r) => r.listNodes().map((n) => [...n.getTranslation(), ...n.getRotation(), ...n.getScale()].map((v) => v.toFixed(6)).join(',')).join('|');
  if (trs(ra) !== trs(rb)) fail(`${name}: node transforms differ`);
  const mats = (r) => r.listMaterials().map((m) => m.getName()).join('|');
  if (mats(ra) !== mats(rb)) fail(`${name}: materials differ`);
  const primTris = (r) => r.listMeshes().flatMap((m) => m.listPrimitives().map((p) => `${p.getMode()}:${(p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3}`)).join('|');
  const [ta, tb] = [primTris(ra), primTris(rb)];
  if (ta !== tb) fail(`${name}: primitive/triangle counts differ`);
  tris += tb.split('|').reduce((s, x) => s + Number(x.split(':')[1] || 0), 0);
  if (!QUANTISED_POSITION_FAMILIES.has(name)) {
    for (const m of rb.listMeshes()) for (const p of m.listPrimitives()) if (p.getAttribute('POSITION').getComponentType() !== 5126) fail(`${name}: POSITION quantised but ${name} is not in QUANTISED_POSITION_FAMILIES`);
  }
  const [ba, bb] = [getBounds(ra.getDefaultScene() ?? ra.listScenes()[0]), getBounds(rb.getDefaultScene() ?? rb.listScenes()[0])];
  const ext = Math.max(...[0, 1, 2].map((k) => ba.max[k] - ba.min[k]), 1e-3);
  const err = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(ba.min[k] - bb.min[k]), Math.abs(ba.max[k] - bb.max[k])]));
  if (!(err <= ext * 2 ** -15)) fail(`${name}: bounds moved ${err.toExponential(2)} m (extent ${ext.toFixed(2)} m)`);
}
for (const [set, n] of Object.entries(setBytes)) {
  const mb = n / 1e6;
  console.log(`${mb <= BUDGET_MB[set] ? 'ok  ' : 'FAIL'} ${set} set ${mb.toFixed(2)} MB brotli (<= ${BUDGET_MB[set]})`);
  if (mb > BUDGET_MB[set]) fails.push(`${set} set over budget`);
}

// ── 3b. per-family allocation (b3.1g) ─────────────────────────────────────────
const basisBr = ['basis_transcoder.wasm.br', 'basis_transcoder.js.br'].reduce((s, f) => s + fs.statSync(path.join(ROOT, 'public/basis', f)).size, 0);
famBytes.shared.world += basisBr; // decoders are paid in the world stage, never the menu (D27)
if (JSON.stringify([...CLIENT_FAMILIES]) !== JSON.stringify(MODEL_FAMILIES)) fail(`modelManifest MODEL_FAMILIES ${CLIENT_FAMILIES.join(',')} != budgets.mjs MODEL_FAMILIES`);
const rows = JSON.parse(JSON.stringify(FAMILY_WIRE_MB));
const rowMut = process.env.PIRATES_BR_MUTATE_FAMILY_ROW;
if (rowMut) { const [f, c] = rowMut.split('.'); if (rows[f]?.[c] == null) throw new Error(`no allocation row ${rowMut}`); rows[f][c] += 0.1; console.log(`  [MUTATED: ${rowMut} -> ${rows[f][c]}]`); }
for (const c of COLUMNS) {
  const sum = MODEL_FAMILIES.reduce((s, f) => s + (rows[f]?.[c] ?? NaN), 0);
  const ok = Math.abs(sum - FAMILY_WIRE_TOTALS_MB[c]) < 1e-9 && FAMILY_WIRE_TOTALS_MB[c] <= D27_TOTALS[c];
  console.log(`${ok ? 'ok  ' : 'FAIL'} allocation column ${c}: rows sum ${sum.toFixed(2)} = total ${FAMILY_WIRE_TOTALS_MB[c]} <= D27 ${D27_TOTALS[c]}`);
  if (!ok) fails.push(`allocation column ${c} does not sum to its D27 total`);
}
const reading = (bytesByFam) => {
  const r = {};
  for (const f of MODEL_FAMILIES) {
    const b = bytesByFam[f];
    // Phones fetch the desktop sets today: the mobile columns grade the same bytes.
    Object.assign(r, { [`${f}.worldDesktop`]: b.world, [`${f}.worldMobile`]: b.world, [`${f}.streamedDesktop`]: b.streamed, [`${f}.streamedMobile`]: b.streamed });
  }
  for (const c of COLUMNS) r[`total.${c}`] = MODEL_FAMILIES.reduce((s, f) => s + r[`${f}.${c}`], 0);
  return r;
};
/** Row id -> 'ok' | 'dev' (inside a declared deviation) | reason string (FAIL). */
const grade = (r) => {
  const v = {};
  for (const [id, bytes] of Object.entries(r)) {
    const [f, c] = id.split('.');
    const row = f === 'total' ? FAMILY_WIRE_TOTALS_MB[c] : rows[f][c];
    const dev = FAMILY_WIRE_DEVIATIONS_MB[id];
    const mb = bytes / 1e6;
    if (mb <= row) v[id] = dev ? `inside its D27 row ${row} MB at ${mb.toFixed(3)}: delete the declared deviation (the list only shrinks)` : 'ok';
    else if (dev && mb <= dev.upTo) v[id] = 'dev';
    else v[id] = `${mb.toFixed(3)} MB > ${dev ? `declared deviation ${dev.upTo}` : `D27 row ${row}`} MB`;
  }
  return v;
};
for (const id of Object.keys(FAMILY_WIRE_DEVIATIONS_MB)) if (!(id in reading(famBytes))) fail(`declared deviation ${id} names no family row`);
const base = grade(reading(famBytes));
let graded = base;
if (MUTATE_FAMILY) {
  if (!famBytes[MUTATE_FAMILY]) throw new Error(`--mutate-family: no family ${MUTATE_FAMILY}`);
  const mut = JSON.parse(JSON.stringify(famBytes));
  const pad = Math.max(0, rows[MUTATE_FAMILY].worldDesktop * 1e6 - mut[MUTATE_FAMILY].world) + 200_000;
  mut[MUTATE_FAMILY].world += pad;
  console.log(`  [MUTATED: ${MUTATE_FAMILY} world +${(pad / 1e3).toFixed(0)} KB, 200 KB over its desktop row]`);
  graded = grade(reading(mut));
  const moved = Object.keys(graded).filter((id) => !id.startsWith('total.') && graded[id] !== base[id]);
  const others = moved.filter((id) => !id.startsWith(`${MUTATE_FAMILY}.`));
  if (!moved.includes(`${MUTATE_FAMILY}.worldDesktop`) || others.length) console.log(`MUTATION NOT ISOLATED: moved ${moved.join(', ') || 'nothing'}`);
  else console.log(`  mutation isolated: only ${moved.join(', ')} changed verdict`);
}
for (const [id, v] of Object.entries(graded)) {
  const mb = (reading(famBytes)[id] / 1e6).toFixed(3);
  if (v === 'ok') console.log(`ok   family ${id} ${mb} MB`);
  else if (v === 'dev') console.log(`!    family ${id} ${mb} MB: declared deviation up to ${FAMILY_WIRE_DEVIATIONS_MB[id].upTo} MB (owner ${FAMILY_WIRE_DEVIATIONS_MB[id].owner})`);
  else fail(`family ${id}: ${v}`);
}
if (MODEL_FAMILIES.filter((f) => famBytes[f].world + famBytes[f].streamed > 0).length < 8) fail('fewer than 8 families carry bytes (vacuous family grading)');
const lib = fs.readFileSync(path.join(ROOT, 'src/client/assets/AssetLibrary.ts'), 'utf8');
if (!/withMeshopt\(new GLTFLoader\(\)\)/.test(lib)) fail('AssetLibrary loader has no meshopt decoder');
if (/`\/assets\/models\/\$\{/.test(lib)) fail('AssetLibrary still fetches the raw tree');
if (!/userData\.assetFamily = assetFamily/.test(lib) || !/tex\.userData\.assetFamily \?\?= assetFamily/.test(lib)) fail('AssetLibrary does not tag userData.assetFamily on loaded objects and textures (b3.1g)');
console.log(`${meshoptFiles}/${names.length} packed GLBs meshopt, ${tris} tris identical to source`);

if (CONSUMERS && !MUTATE) {
  for (const suite of ['test-asset-merge', 'test-far-lod-integrity', 'test-asset-bounds', 'test-hero-assets']) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', './scripts/lib/packed-glb-hook.mjs', `scripts/${suite}.mjs`], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-2).join(' / ');
    console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${suite} on packed bytes: ${tail.slice(0, 220)}`);
    if (r.status !== 0) fails.push(`${suite} red on packed bytes`);
  }
}
console.log(fails.length ? `test-model-transport: ${fails.length} FAIL` : 'test-model-transport: PASS');
process.exit(fails.length ? 1 : 0);
