#!/usr/bin/env node
// Material-floor guard — runs the REAL AssetLibrary over every shipped GLB and
// asserts no prop can render as a featureless black box.
//
// The bug class this pins (story-tour audit, fix wave 2/3): gibbet cages,
// watchtower cabins, door/window panels, chalkboard signs and hanging lanterns
// all rendered as flat black silhouettes at NOON. Two independent causes, both
// invisible in Blender:
//   1. near-black authored albedo (Char_Black/Tar_Black/Crow_Black ~0.03–0.05
//      linear) — under AgX's toe times baked vertex AO there is no shading
//      gradient left, so the surface stops reading as a surface;
//   2. metalness authored for an environment-mapped renderer (Metal_Iron 0.9,
//      Gold 1.0) while this scene has NO envMap — diffuse is multiplied out and
//      nothing comes back, so the surface goes black whatever its albedo is.
// AssetLibrary.preload() runs src/client/assets/materialAudit.ts over every
// material to correct both. This asserts the corrected state, so a future GLB
// rebuild that reintroduces a 0.03 char material still cannot ship a black prop.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'public/assets/models');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// ── Browser-URL shim (same standing-in-for-the-web-server trick as
// test-asset-merge.mjs; the library itself runs unmodified). ──
const ORIGIN = 'http://assets.test';
if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init);
  }
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const match = /\/assets\/models\/([^/?#]+)$/.exec(url);
  if (match) {
    const file = path.join(MODELS_DIR, match[1]);
    if (!existsSync(file)) return new Response(null, { status: 404, statusText: 'Not Found' });
    const buf = await readFile(file);
    return new Response(buf, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  }
  return realFetch(input, init);
};

const { ASSET_NAMES, assets } = await import('../src/client/assets/AssetLibrary.ts');
const {
  MIN_ALBEDO_VALUE, MAX_METALNESS_NO_ENV, SHIP_HULL_DARK, auditAssetMaterial,
} = await import('../src/client/assets/materialAudit.ts');
const THREE = await import('three');

const realWarn = console.warn;
const loadWarnings = [];
console.warn = (...args) => { loadWarnings.push(args.map(String).join(' ')); };
await assets.preload();
console.warn = realWarn;

console.log(`material floor guard — ${ASSET_NAMES.length} assets\n`);
expect('every GLB loaded', loadWarnings.length === 0, loadWarnings.join('\n     '));

const tooDark = [];
const tooMetal = [];
const seen = new Set();
let materials = 0;
for (const name of ASSET_NAMES) {
  const root = assets.clone(name);
  if (!root) continue;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.isMeshStandardMaterial) continue;
      const key = `${name}:${m.uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      materials += 1;
      const peak = Math.max(m.color.r, m.color.g, m.color.b);
      // rounded: THREE stores colours as float32, so a value set exactly to the
      // floor can come back a hair under it.
      if (peak < MIN_ALBEDO_VALUE - 1e-5) {
        tooDark.push(`${name}/${m.name || '?'} peak=${peak.toFixed(4)}`);
      }
      if (m.metalness > MAX_METALNESS_NO_ENV + 1e-6) {
        tooMetal.push(`${name}/${m.name || '?'} metalness=${m.metalness.toFixed(2)}`);
      }
    }
  });
}

expect(`inspected materials across every shipped GLB (${materials})`, materials > 150,
  `only ${materials} standard materials found`);
expect(`no material below the albedo floor (${MIN_ALBEDO_VALUE})`, tooDark.length === 0,
  tooDark.join('\n     '));
expect(`no material above the no-envMap metalness cap (${MAX_METALNESS_NO_ENV})`, tooMetal.length === 0,
  tooMetal.join('\n     '));

// ── unit checks on the rule itself ──
const black = new THREE.MeshStandardMaterial({ color: 0x000000, metalness: 1 });
black.color.setRGB(0.03, 0.026, 0.024);
auditAssetMaterial(black);
const bpeak = Math.max(black.color.r, black.color.g, black.color.b);
expect('a 0.03 char material is lifted onto the floor',
  bpeak >= MIN_ALBEDO_VALUE, `peak=${bpeak.toFixed(4)}`);
expect('a lifted material stays dark (never brighter than ship-hull brown)',
  bpeak <= SHIP_HULL_DARK.r + 1e-4, `peak=${bpeak.toFixed(4)}`);
expect('a lifted material keeps a warm (brown) cast',
  black.color.r > black.color.b,
  `rgb=${black.color.r.toFixed(3)},${black.color.g.toFixed(3)},${black.color.b.toFixed(3)}`);
expect('metalness is capped', black.metalness === MAX_METALNESS_NO_ENV);

// A material already above the floor must be left exactly alone — the audit is
// a floor, not a global brightener.
const wood = new THREE.MeshStandardMaterial({ metalness: 0 });
wood.color.setRGB(0.196, 0.118, 0.058);
const woodChanged = auditAssetMaterial(wood);
expect('a material above the floor is untouched',
  !woodChanged && Math.abs(wood.color.r - 0.196) < 1e-6);

console.log(failures === 0 ? '\nAll material floor assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
