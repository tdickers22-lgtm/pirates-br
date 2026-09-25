#!/usr/bin/env node
// PACK STEP (b3.1a; performance-01, assets-03, vm:performance:7).
//
// Every GLB the Blender scripts export into public/assets/models/ is the
// SOURCE. This step writes the SHIPPED copy of each one into
// public/assets/models/packed/<name>.glb:
//   - KHR_mesh_quantization on NORMAL/TANGENT (int8), COLOR_n (uint8) and
//     TEXCOORD_n (uint16 when the set sits in [0,1]; out-of-range sets stay
//     float, which gltf-transform refuses to quantise without a texture
//     transform);
//   - POSITION stays float32 on every family unless it is listed in
//     QUANTISED_POSITION_FAMILIES (empty today): quantised positions come with
//     a dequantising node transform and int16 arrays, and the client reads
//     position arrays in StaticBatcher (applyMatrix4 then mergeGeometries),
//     AssetMaterialCollapse (per-vertex bake), the prop-collider and bounds
//     paths and every node-side GLB parser under scripts/. A family joins the
//     list only once nothing reads its arrays (test-model-transport proves the
//     bounds and node transforms of every other family unchanged);
//   - reorder (vertex cache + fetch) and EXT_meshopt_compression (required,
//     FILTER method: octahedral normals). All 125 GLBs, measured 2026-09-25:
//     38.79 MB raw / 13.02 MB brotli -> 13.00 MB packed / 8.47 MB brotli;
//   - node names, node transforms, material names/count, meshes and animations
//     are untouched (no prune, no dedup, no join, no weld);
//   - asset.extras.source = { script, commit, srcSha256 } stamps where the
//     source came from (D37: the PROVENANCE.json row) and which bytes were
//     packed, so test-model-transport can fail a stale packed file.
//
// Client: src/client/assets/modelManifest.ts resolves a key to its packed URL
// and wires the MeshoptDecoder into every GLTFLoader that loads one.
// Node consumers of the source files (glb-census, test-asset-*, build_far_lods)
// keep reading the sources; scripts/lib/packed-glb-hook.mjs re-runs them on
// the packed bytes (test-model-transport --consumers).
//
// Usage:
//   node scripts/pack-models.mjs            pack every stale or missing file
//   node scripts/pack-models.mjs --force    repack everything
//   node scripts/pack-models.mjs --check    exit 1 when a packed file is stale/missing
//   node scripts/pack-models.mjs barrel palm_a   only these names
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, quantize, reorder } from '@gltf-transform/functions';
import { PropertyType } from '@gltf-transform/core';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(ROOT, 'public/assets/models');
export const PACKED_DIR = path.join(SRC_DIR, 'packed');

/** Families whose POSITION may be quantised (nothing reads their arrays). */
export const QUANTISED_POSITION_FAMILIES = new Set([]);

/** Attribute semantics quantised on every family. */
const ATTR_PATTERN = /^(NORMAL|TANGENT|COLOR_\d+|TEXCOORD_\d+)$/;
const ATTR_AND_POSITION_PATTERN = /^(POSITION|NORMAL|TANGENT|COLOR_\d+|TEXCOORD_\d+)$/;

export const PACK_OPTIONS = Object.freeze({ quantizeNormal: 8, quantizeColor: 8, quantizeTexcoord: 12, quantizePosition: 14 });

let ioPromise = null;
/** A NodeIO that reads and writes meshopt (encoder and decoder ready). */
export function packIO() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  })();
  return ioPromise;
}

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

export function listSources() {
  return fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.glb')).sort().map((f) => f.slice(0, -4));
}

function provenanceScripts() {
  const map = new Map();
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'PROVENANCE.json'), 'utf8'));
    for (const r of doc.rows ?? []) map.set(r.glb, r.script ?? r.source ?? r.url ?? r.kind ?? null);
  } catch { /* no provenance file: stamp null, test-asset-provenance fails it */ }
  return map;
}

function headCommit() {
  try { return execSync('git rev-parse --short=8 HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; }
}

/** Is the packed file present and packed from exactly these source bytes? */
export function packedIsFresh(name) {
  const src = path.join(SRC_DIR, `${name}.glb`);
  const out = path.join(PACKED_DIR, `${name}.glb`);
  if (!fs.existsSync(out)) return false;
  const json = readGlbJson(fs.readFileSync(out));
  return json?.asset?.extras?.source?.srcSha256 === sha256(fs.readFileSync(src));
}

/** The JSON chunk of a GLB (no decode). */
export function readGlbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
}

/** Does any primitive carry an attribute core glTF 2.0 only allows under
 *  KHR_mesh_quantization (non-float POSITION/NORMAL/TANGENT, or a TEXCOORD
 *  that is neither float nor normalised u8/u16)? */
export function hasQuantisedAttribute(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const t of [prim, ...prim.listTargets()]) {
        for (const sem of t.listSemantics()) {
          const a = t.getAttribute(sem);
          const size = a.getComponentSize();
          if (size >= 4) continue;
          if (sem === 'POSITION' || sem === 'NORMAL' || sem === 'TANGENT') return true;
          if (sem.startsWith('TEXCOORD_') && !(a.getNormalized() && (a.getComponentType() === 5121 || a.getComponentType() === 5123))) return true;
          if (sem.startsWith('TEXCOORD_') && t !== prim) return true;
        }
      }
    }
  }
  return false;
}

/** Low mantissa bits zeroed on float POSITION (round-to-nearest). Keeps 15 of
 *  23 significand bits: relative error <= 2^-16 (1 mm on a 60 m hull), arrays
 *  stay Float32 in world units (no node transform), and the zero low byte is
 *  what lets the meshopt vertex codec and brotli shrink float positions
 *  (the gltfpack -vpf idea without its restructuring). Unrounded float32
 *  positions made the meshopt+brotli file LARGER than raw+brotli
 *  (all 125: 13.02 MB raw br -> 18.62 MB packed br, measured 2026-09-25). */
export const POSITION_DROP_BITS = 8;

function floatPositionAccessors(doc) {
  const out = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const t of [prim, ...prim.listTargets()]) {
        const a = t.getAttribute('POSITION');
        if (a && a.getComponentType() === 5126) out.add(a);
      }
    }
  }
  return out;
}

/** Round each float32 to its top (23 - drop) significand bits, in place. */
export function roundMantissa(f32, drop) {
  const u = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
  const half = 1 << (drop - 1);
  const mask = ~((1 << drop) - 1) >>> 0;
  for (let i = 0; i < u.length; i++) {
    const e = u[i] & 0x7f800000;
    if (e === 0 || e === 0x7f800000) continue; // zero/denormal/inf/nan untouched
    u[i] = ((u[i] + half) & mask) >>> 0;
  }
  return f32;
}

/** Pack one source GLB into bytes (does not write). */
export async function packOne(name, { provenance = provenanceScripts(), commit = headCommit() } = {}) {
  const io = await packIO();
  const srcBytes = fs.readFileSync(path.join(SRC_DIR, `${name}.glb`));
  const doc = await io.readBinary(new Uint8Array(srcBytes));
  const hasSkin = doc.getRoot().listSkins().length > 0;
  const quantisePosition = QUANTISED_POSITION_FAMILIES.has(name) && !hasSkin;
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'performance' }),
    quantize({ ...PACK_OPTIONS, pattern: quantisePosition ? ATTR_AND_POSITION_PATTERN : ATTR_PATTERN, cleanup: false }),
    // quantize() swaps in new accessors and leaves the float originals behind
    // (cleanup:false, because its own cleanup also prunes and dedups
    // MATERIALS); drop only the orphaned accessors.
    prune({ propertyTypes: [PropertyType.ACCESSOR], keepAttributes: true, keepIndices: true, keepLeaves: true }),
  );
  // quantize() only registers KHR_mesh_quantization when POSITION is
  // quantised (its isQuantizedPrimitive tests every semantic against the
  // POSITION accessor), so int8 normals under float positions would ship
  // without the extension that makes them legal. Decide it here instead.
  if (!quantisePosition) for (const acc of floatPositionAccessors(doc)) roundMantissa(acc.getArray(), POSITION_DROP_BITS);
  if (hasQuantisedAttribute(doc)) doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const asset = doc.getRoot().getAsset();
  asset.extras = { ...(asset.extras ?? {}), source: { script: provenance.get(`${name}.glb`) ?? null, commit, srcSha256: sha256(srcBytes) } };
  return Buffer.from(await io.writeBinary(doc));
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const check = args.includes('--check');
  const only = args.filter((a) => !a.startsWith('--'));
  const names = only.length ? only : listSources();
  fs.mkdirSync(PACKED_DIR, { recursive: true });
  if (check) {
    const stale = names.filter((n) => !packedIsFresh(n));
    for (const n of stale) console.log(`STALE ${n}.glb (run node scripts/pack-models.mjs)`);
    console.log(stale.length ? `pack-models --check: ${stale.length} stale/missing` : `pack-models --check: ${names.length} fresh`);
    process.exit(stale.length ? 1 : 0);
  }
  const provenance = provenanceScripts();
  const commit = headCommit();
  let raw = 0; let packed = 0; let n = 0;
  for (const name of names) {
    if (!force && packedIsFresh(name)) continue;
    const bytes = await packOne(name, { provenance, commit });
    fs.writeFileSync(path.join(PACKED_DIR, `${name}.glb`), bytes);
    raw += fs.statSync(path.join(SRC_DIR, `${name}.glb`)).size; packed += bytes.length; n += 1;
  }
  // A packed file whose source is gone is dead weight.
  const live = new Set(listSources());
  for (const f of fs.readdirSync(PACKED_DIR)) {
    if (f.endsWith('.glb') && !live.has(f.slice(0, -4))) { fs.unlinkSync(path.join(PACKED_DIR, f)); console.log(`removed orphan packed/${f}`); }
  }
  console.log(`pack-models: packed ${n} (${(raw / 1e6).toFixed(2)} MB raw -> ${(packed / 1e6).toFixed(2)} MB)`);
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
