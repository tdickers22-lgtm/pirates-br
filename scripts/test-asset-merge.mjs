#!/usr/bin/env node
// Asset merge guard — runs the REAL AssetLibrary (preload + mergedGeometry)
// over every shipped GLB and asserts the merge stays sound.
//
// This is the net under the "black props" class of bug: mergedGeometry
// flattens a GLB's meshes into ONE geometry with per-material groups, and the
// three ways that silently goes wrong on screen are
//   1. a material with vertexColors=true landing on a merged geometry that has
//      NO color attribute  → three multiplies by an undefined attribute and the
//      prop renders BLACK,
//   2. a merged geometry that HAS COLOR_0 under a material with
//      vertexColors=false → the authored Blender vertex paint is thrown away
//      and the prop renders as flat untinted grey,
//   3. group bookkeeping drift (group count ≠ material count, groups not
//      covering every vertex, a materialIndex past the end of the array) →
//      whole chunks of the mesh draw with the wrong material or not at all.
// None of those throw. They only show up as a wrong-looking prop in game, so
// they need an assertion.
//
// Runs headless: THREE + GLTFLoader work fine in Node, and a small fetch shim
// serves /assets/models/*.glb off disk so preload() takes its real code path.
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

// ── Browser-URL shim. AssetLibrary asks for the site-absolute path
// `/assets/models/<name>.glb`; Node's Request/fetch reject a relative URL, so
// give them an origin to resolve against and serve the bytes off disk. The
// library itself runs unmodified — this only stands in for the web server.
const ORIGIN = 'http://assets.test';
// three's FileLoader emits download-progress events; Node has no ProgressEvent.
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

// Loader failures inside preload() are logged and tolerated by design (callers
// keep a procedural fallback), so capture them rather than let them scroll past.
const loadWarnings = [];
const realWarn = console.warn;
console.warn = (...args) => { loadWarnings.push(args.map(String).join(' ')); };
await assets.preload();
console.warn = realWarn;

console.log(`asset merge guard — ${ASSET_NAMES.length} assets\n`);

expect('every GLB loaded (no procedural fallbacks)', loadWarnings.length === 0,
  loadWarnings.join('\n     '));

let merged = 0;
const problems = [];
for (const name of ASSET_NAMES) {
  const issues = [];

  if (!assets.has(name)) {
    problems.push(`${name}: GLB missing or failed to parse`);
    continue;
  }

  const m = assets.mergedGeometry(name);
  if (!m) {
    problems.push(`${name}: mergedGeometry returned null (no meshes in the GLB)`);
    continue;
  }
  merged += 1;

  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const geom = m.geometry;
  const pos = geom.getAttribute('position');
  const color = geom.getAttribute('color');
  const groups = geom.groups;

  if (!pos || pos.count === 0) issues.push('merged geometry has no vertices');

  // 1. vertexColors materials MUST have a COLOR_0 attribute to multiply against.
  const vcMats = mats.filter((x) => x.vertexColors);
  if (!color && vcMats.length > 0) {
    issues.push(`BLACK-RISK: ${vcMats.length}/${mats.length} materials have vertexColors=true but the merged geometry has no COLOR_0`);
  }
  // 2. …and the converse: COLOR_0 present but a material ignoring it throws the
  //    authored Blender paint away.
  if (color) {
    const unlit = mats.filter((x) => !x.vertexColors);
    if (unlit.length > 0) {
      issues.push(`UNLIT-VC: merged geometry has COLOR_0 but ${unlit.length}/${mats.length} materials have vertexColors=false`);
    }
    if (color.count !== pos.count) {
      issues.push(`COLOR_0 count ${color.count} != position count ${pos.count}`);
    }
    // A merged geometry whose paint is essentially all-black renders as a
    // silhouette regardless of the material colour.
    let dark = 0;
    let minLum = Infinity;
    for (let i = 0; i < color.count; i++) {
      const lum = 0.299 * color.getX(i) + 0.587 * color.getY(i) + 0.114 * color.getZ(i);
      if (lum < minLum) minLum = lum;
      if (lum < 0.02) dark += 1;
    }
    if (dark > color.count * 0.5) {
      issues.push(`DARK-VC: ${dark}/${color.count} vertices have luminance < 0.02 (min ${minLum.toFixed(3)})`);
    }
  }

  // 3. Group bookkeeping: one group per material, covering every vertex, with
  //    in-range material indices.
  if (mats.length > 1) {
    if (groups.length !== mats.length) {
      issues.push(`GROUP-COUNT: ${groups.length} groups for ${mats.length} materials`);
    }
    const covered = groups.reduce((sum, g) => sum + g.count, 0);
    if (covered !== pos.count) {
      issues.push(`GROUP-COVERAGE: groups cover ${covered} of ${pos.count} vertices`);
    }
    for (const g of groups) {
      if ((g.materialIndex ?? 0) >= mats.length) {
        issues.push(`GROUP-MATIDX: materialIndex ${g.materialIndex} >= ${mats.length} materials`);
      }
    }
  }

  // 4. Non-finite vertices poison bounding spheres (and every frustum cull).
  const arr = pos?.array;
  if (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) { issues.push(`non-finite vertex at component ${i}`); break; }
    }
  }

  if (issues.length) problems.push(`${name}: ${issues.join(' | ')}`);
}

expect(`all ${ASSET_NAMES.length} assets produced a merged geometry`, merged === ASSET_NAMES.length,
  `${merged}/${ASSET_NAMES.length} merged`);
expect('no asset has a merge defect (groups / materials / COLOR_0)', problems.length === 0,
  problems.join('\n     '));

// mergedGeometry caches: the second call must hand back the SAME geometry, or
// every InstancedMesh rebuild leaks a full copy of the asset.
const first = assets.mergedGeometry(ASSET_NAMES[0]);
const second = assets.mergedGeometry(ASSET_NAMES[0]);
expect('mergedGeometry is cached (same object on re-request)',
  !!first && first.geometry === second?.geometry);
expect('merged geometry is registered as a shared resource (never disposed by callers)',
  !!first && assets.isShared(first.geometry));

console.log(failures === 0 ? '\nAll asset merge assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
