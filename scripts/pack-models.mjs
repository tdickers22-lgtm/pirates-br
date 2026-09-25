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
// CONTENT-HASHED NAMES (b3.1b, performance-14): the shipped file is
// packed/<name>.<hash8>.glb (hash8 = the first 8 hex of sha256 over the packed
// bytes) and src/client/assets/model-manifest.json maps every name to it. The
// manifest is imported by the client bundle (so it rides inside a Vite-hashed
// chunk) and LobbyServer serves a hashed packed name `immutable` for a year: a
// repeat visit revalidates 0 models, and a re-export changes the name, so a
// returning player can never hold a stale model.
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
//
// KTX2 TEXTURES (b3.1c, performance-02): every PNG/JPEG texture inside a
// packed GLB is re-encoded as KHR_texture_basisu with its full mip chain in
// the file, by the PINNED npm wasm Basis encoder (ktx2-encoder 0.6.0, exact
// version in package.json; no toktx/admin install needed): ETC1S (BasisLZ)
// for baseColor / emissive (sRGB, perceptual) and ORM (linear), UASTC + zstd
// for normal maps. The client transcodes with three's basis_transcoder
// (public/basis/, precompressed, fetched with the world set by the one shared
// KTX2Loader in AssetLibrary). A packed GLB still carrying PNG/JPEG outside
// TEXTURE_ALLOWLIST is STALE (--check fails it). test-texture-budget grades
// the result (mips, modes, GPU bytes per tier, ETC1S deltaE vs the source).
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
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(ROOT, 'public/assets/models');
export const PACKED_DIR = path.join(SRC_DIR, 'packed');
/** name -> '<name>.<hash8>.glb' (the client imports this file). */
export const MANIFEST_PATH = path.join(ROOT, 'src/client/assets/model-manifest.json');
/** A packed file name: <name>.<8 lowercase hex>.glb. */
export const HASHED_NAME = /^(.+)\.([0-9a-f]{8})\.glb$/;

/** The manifest on disk ({} when missing). */
export function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}
function writeManifest(m) {
  const sorted = Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
}
/** The packed file name for these packed bytes. */
export function hashedName(name, bytes) { return `${name}.${sha256(bytes).slice(0, 8)}.glb`; }
/** Absolute path of the shipped file for a source name (null when the manifest has none). */
export function packedFile(name, manifest = readManifest()) {
  return manifest[name] ? path.join(PACKED_DIR, manifest[name]) : null;
}

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
/** Packed GLBs allowed to keep a PNG/JPEG texture (name -> reason). Empty:
 *  no textured GLB is in the boot set, the only stage before the transcoder. */
export const TEXTURE_ALLOWLIST = new Map([]);

/** Encoder settings per texture slot (b3.1c). ETC1S quality 255 keeps the
 *  512 atlases under mean deltaE 3 vs the Blender JPEG (test-texture-budget). */
export const KTX2_OPTIONS = Object.freeze({
  color: { isUASTC: false, qualityLevel: 255, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true, generateMipmap: true },
  data: { isUASTC: false, qualityLevel: 255, compressionLevel: 2, isPerceptual: false, isSetKTX2SRGBTransferFunc: false, generateMipmap: true },
  normal: { isUASTC: true, needSupercompression: true, isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false, generateMipmap: true },
});

async function decodeImage(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Re-encode every PNG/JPEG texture of `doc` as KTX2 (slot-aware). */
export async function encodeTexturesKtx2(doc) {
  const root = doc.getRoot();
  let n = 0;
  for (const tex of root.listTextures()) {
    const mime = tex.getMimeType();
    if (mime !== 'image/png' && mime !== 'image/jpeg') continue;
    const slots = new Set(tex.getGraph().listParentEdges(tex).filter((e) => e.getParent() !== root).map((e) => e.getName()));
    const mode = slots.has('normalTexture') ? 'normal'
      : (slots.has('baseColorTexture') || slots.has('emissiveTexture')) ? 'color' : 'data';
    const ktx = await encodeToKTX2(tex.getImage(), { ...KTX2_OPTIONS[mode], imageDecoder: decodeImage });
    tex.setImage(ktx).setMimeType('image/ktx2');
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.(png|jpe?g)$/i, '.ktx2'));
    n += 1;
  }
  if (n) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return n;
}

/** PNG/JPEG images a packed GLB still ships (JSON only, no decode). */
export function legacyImageCount(json) {
  return (json?.images ?? []).filter((im) => im.mimeType === 'image/png' || im.mimeType === 'image/jpeg').length;
}

export function packedIsFresh(name, manifest = readManifest()) {
  const src = path.join(SRC_DIR, `${name}.glb`);
  const out = packedFile(name, manifest);
  if (!out || !fs.existsSync(out)) return false;
  const bytes = fs.readFileSync(out);
  if (path.basename(out) !== hashedName(name, bytes)) return false; // name no longer matches its bytes
  const json = readGlbJson(bytes);
  if (legacyImageCount(json) && !TEXTURE_ALLOWLIST.has(name)) return false; // pre-KTX2 pack
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
  if (!TEXTURE_ALLOWLIST.has(name)) await encodeTexturesKtx2(doc);
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
  const manifest = readManifest();
  if (check) {
    const stale = names.filter((n) => !packedIsFresh(n, manifest));
    for (const n of stale) console.log(`STALE ${n}.glb (run node scripts/pack-models.mjs)`);
    console.log(stale.length ? `pack-models --check: ${stale.length} stale/missing` : `pack-models --check: ${names.length} fresh`);
    process.exit(stale.length ? 1 : 0);
  }
  const provenance = provenanceScripts();
  const commit = headCommit();
  let raw = 0; let packed = 0; let n = 0;
  let adopted = 0;
  for (const name of names) {
    // Adopt a fresh pre-hash packed/<name>.glb (b3.1a layout) under its hashed name.
    const legacy = path.join(PACKED_DIR, `${name}.glb`);
    if (!force && !packedIsFresh(name, manifest) && fs.existsSync(legacy)) {
      const bytes = fs.readFileSync(legacy);
      if (readGlbJson(bytes)?.asset?.extras?.source?.srcSha256 === sha256(fs.readFileSync(path.join(SRC_DIR, `${name}.glb`)))) {
        manifest[name] = hashedName(name, bytes);
        fs.renameSync(legacy, path.join(PACKED_DIR, manifest[name]));
        adopted += 1;
      }
    }
    if (!force && packedIsFresh(name, manifest)) continue;
    const bytes = await packOne(name, { provenance, commit });
    manifest[name] = hashedName(name, bytes);
    fs.writeFileSync(path.join(PACKED_DIR, manifest[name]), bytes);
    raw += fs.statSync(path.join(SRC_DIR, `${name}.glb`)).size; packed += bytes.length; n += 1;
  }
  // A manifest row whose source is gone, and a packed file no row names, are dead weight.
  const live = new Set(listSources());
  for (const k of Object.keys(manifest)) if (!live.has(k)) delete manifest[k];
  writeManifest(manifest);
  const named = new Set(Object.values(manifest));
  for (const f of fs.readdirSync(PACKED_DIR)) {
    if (f.endsWith('.glb') && !named.has(f)) { fs.unlinkSync(path.join(PACKED_DIR, f)); console.log(`removed orphan packed/${f}`); }
  }
  if (adopted) console.log(`pack-models: adopted ${adopted} pre-hash packed files under hashed names`);
  console.log(`pack-models: packed ${n} (${(raw / 1e6).toFixed(2)} MB raw -> ${(packed / 1e6).toFixed(2)} MB)`);
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
