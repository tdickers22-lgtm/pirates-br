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
//      world <= 6, lazy <= 12, far <= 1 MB (PLAN 3.4 / b3.1a);
//   4. the client fetches the packed tree (modelManifest.modelUrl) and wires
//      the meshopt decoder into AssetLibrary's loader.
// --mutate: one packed file replaced by its raw source -> must FAIL.
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

const ROOT = path.resolve(SRC_DIR, '../../..');
const MUTATE = process.argv.includes('--mutate');
const CONSUMERS = process.argv.includes('--consumers');
const BUDGET_MB = { boot: 0.6, world: 6, lazy: 12, far: 1 };
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
  setBytes[setOf(name)] += br(bytes);
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
const lib = fs.readFileSync(path.join(ROOT, 'src/client/assets/AssetLibrary.ts'), 'utf8');
if (!/withMeshopt\(new GLTFLoader\(\)\)/.test(lib)) fail('AssetLibrary loader has no meshopt decoder');
if (/`\/assets\/models\/\$\{/.test(lib)) fail('AssetLibrary still fetches the raw tree');
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
