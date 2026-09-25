#!/usr/bin/env node
// TEXTURE BUDGET (b3.1c; performance-02, vm:assets:5, vm:characters:3).
//
// Grades what the client actually fetches (public/assets/models/packed/, via
// src/client/assets/model-manifest.json), not the Blender sources:
//   1. no image/png or image/jpeg texture ships inside a packed GLB outside
//      TEXTURE_ALLOWLIST (empty: every textured GLB is in the world or lazy
//      set, where the basis transcoder is already paid; D27 keeps decoders out
//      of the menu, so a boot-set GLB may only ship a JPEG when allowlisted);
//   2. every KTX2 texture is KHR_texture_basisu with a full mip chain inside
//      the GLB; colour/emissive/ORM slots are ETC1S (BasisLZ), normal slots
//      are UASTC with zstd supercompression;
//   3. GPU bytes per tier, after AssetLibrary's top-mip drop (the caps are read
//      out of AssetLibrary.ts so the gate and the client cannot drift), stay
//      within the D27 texture residency column (low/phone/iPad rows from
//      scripts/lib/budgets.mjs MEMORY_BUDGETS; high/balanced from D27 inline
//      until b3.1g moves them into budgets.mjs). A transcoded ETC1S/UASTC
//      texel costs 1 byte (BC7/ETC2 RGBA/ASTC 4x4) and a mip chain 4/3;
//   4. ETC1S visual diff: every ETC1S colour texture transcoded (three's own
//      basis_transcoder.wasm, the one the client ships under public/basis/) to
//      RGBA8 vs the JPEG in the Blender source GLB: mean CIE76 deltaE < 3.
//   5. public/basis/ carries the transcoder three's KTX2Loader loads, byte-
//      identical to node_modules/three, with brotli + gzip siblings.
//
// --mutate: pretend one texture is still a JPEG (must FAIL).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { read as readKtx, KHR_SUPERCOMPRESSION_BASISLZ, KHR_SUPERCOMPRESSION_ZSTD } from 'ktx-parse';
import sharp from 'sharp';
import { MEMORY_BUDGETS } from './lib/budgets.mjs';
import { TEXTURE_ALLOWLIST } from './pack-models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public/assets/models');
const PACKED = path.join(SRC, 'packed');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/client/assets/model-manifest.json'), 'utf8'));
const MUTATE = process.argv.includes('--mutate');

/** Packed GLBs allowed to ship a PNG/JPEG texture, with the reason. */
// TEXTURE_ALLOWLIST (pack-models.mjs): packed GLBs allowed a PNG/JPEG texture, with the reason.
/** D27 texture residency (MB, 2^20) per tier. */
const RESIDENCY_MB = {
  high: 256, // D27 (move to budgets.mjs: b3.1g)
  balanced: 128, // D27 (move to budgets.mjs: b3.1g)
  low: MEMORY_BUDGETS.desktopLow.texturesMB,
  phone: MEMORY_BUDGETS.phone.texturesMB,
  ipad: MEMORY_BUDGETS.ipad.texturesMB,
};
/** GLB-texture share of a tier's residency: the rest is canvas signs, render targets, ocean, UI. */
const GLB_TEXTURE_SHARE = 0.5;
const DELTA_E_MAX = 3;

let fails = 0;
const fail = (m) => { fails += 1; console.log(`FAIL: ${m}`); };

function glbParts(buf) {
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const binStart = 20 + jl + 8;
  return { json, bin: buf.subarray(binStart) };
}
function imageBytes({ json, bin }, i) {
  const bv = json.bufferViews[json.images[i].bufferView];
  return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
}
/** image index -> slots ('baseColor', 'normal', ...) it feeds. */
function imageSlots(json) {
  const slots = new Map();
  const add = (info, slot) => {
    if (!info) return;
    const tex = json.textures[info.index];
    const src = tex.extensions?.KHR_texture_basisu?.source ?? tex.source;
    if (!slots.has(src)) slots.set(src, new Set());
    slots.get(src).add(slot);
  };
  for (const m of json.materials ?? []) {
    add(m.pbrMetallicRoughness?.baseColorTexture, 'baseColor');
    add(m.pbrMetallicRoughness?.metallicRoughnessTexture, 'orm');
    add(m.occlusionTexture, 'orm');
    add(m.emissiveTexture, 'emissive');
    add(m.normalTexture, 'normal');
  }
  return slots;
}

// ── the client's top-mip caps, read out of AssetLibrary.ts ──────────────────
const libSrc = fs.readFileSync(path.join(ROOT, 'src/client/assets/AssetLibrary.ts'), 'utf8');
const capMatch = libSrc.match(/TEXTURE_TOP_MIP_CAP\s*=\s*\{\s*family:\s*(\d+),\s*heroViewmodel:\s*(\d+)\s*\}/);
const heroMatch = libSrc.match(/HERO_VIEWMODEL_TEXTURE_ASSETS[^=]*=\s*new Set<string>\(\[([^\]]*)\]\)/);
if (!capMatch || !heroMatch) fail('AssetLibrary.ts has no TEXTURE_TOP_MIP_CAP / HERO_VIEWMODEL_TEXTURE_ASSETS (per-tier top-mip drop missing)');
const CAP = capMatch ? { family: Number(capMatch[1]), hero: Number(capMatch[2]) } : { family: Infinity, hero: Infinity };
const HERO = new Set(heroMatch ? [...heroMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
const CAPPED_TIERS = new Set(['low', 'phone', 'ipad']);
if (capMatch && (CAP.family > 512 || CAP.hero > 1024)) fail(`top-mip caps ${CAP.family}/${CAP.hero} looser than 512 family / 1024 hero viewmodel`);

// ── basis transcoder (the shipped copy) ─────────────────────────────────────
const threeBasis = path.join(ROOT, 'node_modules/three/examples/jsm/libs/basis');
const pubBasis = path.join(ROOT, 'public/basis');
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  const p = path.join(pubBasis, f);
  if (!fs.existsSync(p)) { fail(`public/basis/${f} missing (KTX2Loader transcoder path)`); continue; }
  const bytes = fs.readFileSync(p);
  if (!bytes.equals(fs.readFileSync(path.join(threeBasis, f)))) fail(`public/basis/${f} differs from three's (transcoder/loader version skew)`);
  for (const [ext, dec] of [['.br', zlib.brotliDecompressSync], ['.gz', zlib.gunzipSync]]) {
    if (!fs.existsSync(p + ext)) fail(`public/basis/${f}${ext} precompressed sibling missing`);
    else if (!dec(fs.readFileSync(p + ext)).equals(bytes)) fail(`public/basis/${f}${ext} does not decompress to ${f}`);
  }
}
let BASIS = null;
async function transcoder() {
  if (BASIS) return BASIS;
  const js = fs.readFileSync(path.join(threeBasis, 'basis_transcoder.js'), 'utf8');
  // Emscripten's node branch wants CommonJS require/__dirname (this file is ESM).
  const factory = new Function('require', '__dirname', '__filename', `${js}; return BASIS;`)(
    createRequire(import.meta.url), threeBasis, path.join(threeBasis, 'basis_transcoder.js'));
  BASIS = await factory({ wasmBinary: fs.readFileSync(path.join(threeBasis, 'basis_transcoder.wasm')) });
  BASIS.initializeBasis();
  return BASIS;
}
async function transcodeTop(ktxBytes) {
  const B = await transcoder();
  const f = new B.KTX2File(new Uint8Array(ktxBytes));
  try {
    if (!f.isValid() || !f.startTranscoding()) throw new Error('invalid KTX2');
    const RGBA32 = 13;
    const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!f.transcodeImage(dst, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error('transcode failed');
    return { data: dst, width: f.getWidth(), height: f.getHeight() };
  } finally { f.close(); f.delete(); }
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function lab(r, g, b) {
  const R = lin(r); const G = lin(g); const Bl = lin(b);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * Bl) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * Bl);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * Bl) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function meanDeltaE(a, b) {
  let s = 0; const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const p = lab(a[i], a[i + 1], a[i + 2]); const q = lab(b[i], b[i + 1], b[i + 2]);
    s += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }
  return s / n;
}

// ── census ──────────────────────────────────────────────────────────────────
const gpu = Object.fromEntries(Object.keys(RESIDENCY_MB).map((t) => [t, 0]));
let ktxCount = 0; let worstDE = 0;
const seen = new Set();
for (const [name, file] of Object.entries(manifest).sort()) {
  const p = path.join(PACKED, file);
  if (!fs.existsSync(p)) { fail(`${name}: packed file ${file} missing`); continue; }
  const glb = glbParts(fs.readFileSync(p));
  const { json } = glb;
  if (!json.images?.length) continue;
  const slots = imageSlots(json);
  for (let i = 0; i < json.images.length; i++) {
    let mime = json.images[i].mimeType;
    if (MUTATE && name === 'cutlass') mime = 'image/jpeg';
    const sl = [...(slots.get(i) ?? [])];
    if (mime !== 'image/ktx2') {
      if (!TEXTURE_ALLOWLIST.has(name)) fail(`${name}: image ${i} (${sl.join('/')}) ships as ${mime}, not KTX2`);
      continue;
    }
    if (!json.extensionsUsed?.includes('KHR_texture_basisu')) fail(`${name}: KTX2 image without KHR_texture_basisu`);
    const bytes = imageBytes(glb, i);
    const ktx = readKtx(new Uint8Array(bytes));
    ktxCount += 1;
    const w = ktx.pixelWidth; const h = ktx.pixelHeight;
    const fullChain = Math.floor(Math.log2(Math.max(w, h))) + 1;
    if (ktx.levels.length !== fullChain) fail(`${name}: image ${i} ${w}x${h} has ${ktx.levels.length} mips, want ${fullChain}`);
    const isNormal = sl.includes('normal');
    if (isNormal && ktx.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZSTD) fail(`${name}: normal map not UASTC+zstd (scheme ${ktx.supercompressionScheme})`);
    if (!isNormal && ktx.supercompressionScheme !== KHR_SUPERCOMPRESSION_BASISLZ) fail(`${name}: ${sl.join('/')} not ETC1S (scheme ${ktx.supercompressionScheme})`);
    // GPU bytes per tier (unique image bytes: a _far twin with the same JPEG counts once).
    const key = `${bytes.length}:${bytes.subarray(0, 64).toString('hex')}:${bytes.subarray(-64).toString('hex')}`;
    if (!seen.has(key)) {
      seen.add(key);
      for (const tier of Object.keys(gpu)) {
        let top = Math.max(w, h);
        if (CAPPED_TIERS.has(tier)) top = Math.min(top, HERO.has(name.replace(/_far$/, '')) ? CAP.hero : CAP.family);
        const scale = top / Math.max(w, h);
        gpu[tier] += (w * scale) * (h * scale) * (4 / 3);
      }
    }
    // Visual diff vs the Blender source's JPEG/PNG (colour ETC1S only).
    if (!isNormal && sl.some((s) => s === 'baseColor' || s === 'emissive')) {
      const srcGlb = glbParts(fs.readFileSync(path.join(SRC, `${name}.glb`)));
      const srcImg = await sharp(imageBytes(srcGlb, i)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = await transcodeTop(bytes);
      if (out.width !== srcImg.info.width || out.height !== srcImg.info.height) { fail(`${name}: KTX2 ${out.width}x${out.height} vs source ${srcImg.info.width}x${srcImg.info.height}`); continue; }
      const de = meanDeltaE(out.data, srcImg.data);
      worstDE = Math.max(worstDE, de);
      if (de >= DELTA_E_MAX) fail(`${name}: ETC1S mean deltaE ${de.toFixed(2)} >= ${DELTA_E_MAX} vs the source JPEG`);
    }
  }
}
for (const [tier, bytes] of Object.entries(gpu)) {
  const mb = bytes / 2 ** 20; const cap = RESIDENCY_MB[tier] * GLB_TEXTURE_SHARE;
  console.log(`  ${tier.padEnd(8)} GLB textures ${mb.toFixed(2)} MB GPU (ceiling ${cap} MB = ${GLB_TEXTURE_SHARE} x D27 ${RESIDENCY_MB[tier]} MB)`);
  if (mb > cap) fail(`${tier}: GLB textures ${mb.toFixed(2)} MB > ${cap} MB`);
}
console.log(`  ${ktxCount} KTX2 textures, worst ETC1S mean deltaE ${worstDE.toFixed(2)} (< ${DELTA_E_MAX})`);
if (ktxCount === 0 && !fails) fail('no KTX2 texture found: the gate graded nothing');
console.log(fails ? `test-texture-budget: ${fails} FAIL` : 'test-texture-budget: PASS');
process.exit(fails ? 1 : 0);
