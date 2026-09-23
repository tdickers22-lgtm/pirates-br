#!/usr/bin/env node
// CPU-COPY RELEASE (b1.7b, moved forward from b3.1b): only render-only static
// batches lose their CPU arrays, only AFTER upload, bounds precomputed, and the
// census still counts their GPU bytes. Logic only (no GL): the upload is the
// attribute's onUploadCallback, which is exactly what WebGLAttributes calls.
//   node --import tsx scripts/test-cpu-copy-release.mjs
import * as THREE from 'three';

globalThis.location = { search: '?cpurelease=1' };
const { releaseRenderOnlyCpuCopies, releasedGpuBytes, cpuCopyReleaseStats } = await import('../src/client/rendering/CpuCopyRelease.ts');

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
};
const upload = (g) => { for (const a of [g.index, ...Object.values(g.attributes)]) if (a) a.onUploadCallback(); };

function world() {
  const root = new THREE.Group();
  const mk = (name, geo, Ctor = THREE.Mesh) => { const m = new Ctor(geo, new THREE.MeshBasicMaterial()); m.name = name; root.add(m); return m; };
  const batch = mk('prop-fort-batch', new THREE.BoxGeometry(2, 3, 4));
  const batch2 = mk('static-batch1', new THREE.BoxGeometry(1, 1, 1));
  const shared = mk('prop-dock-batch', new THREE.BoxGeometry(1, 1, 1));
  const plain = mk('crate', new THREE.BoxGeometry(1, 1, 1));
  const points = mk('steam-batch', new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(30), 3)), THREE.Points);
  const dyn = mk('wake-batch', new THREE.BoxGeometry(1, 1, 1));
  dyn.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const keep = mk('keep-batch', new THREE.BoxGeometry(1, 1, 1));
  keep.userData.keepCpu = true;
  return { root, batch, batch2, shared, plain, points, dyn, keep, sharedSet: new Set([shared.geometry]) };
}

const w = world();
const bytesBefore = w.batch.geometry.attributes.position.array.byteLength;
const armed = releaseRenderOnlyCpuCopies(w.root, (o) => w.sharedSet.has(o));
expect('arms bytes for the two batches', armed > 0 && armed === cpuCopyReleaseStats().armedBytes, `${armed}`);
expect('nothing is dropped before upload', w.batch.geometry.attributes.position.array.length > 0);
expect('bounds precomputed at arm time', !!w.batch.geometry.boundingSphere && !!w.batch.geometry.boundingBox);
for (const k of ['batch', 'batch2', 'shared', 'plain', 'points', 'dyn', 'keep']) upload(w[k].geometry);
const pos = w.batch.geometry.attributes.position;
expect('batch position array dropped after upload', pos.array.length === 0 && pos.array instanceof Float32Array);
expect('batch index dropped too', w.batch.geometry.index.array.length === 0);
expect('count kept (draw range survives)', pos.count === 24, `${pos.count}`);
expect('GPU bytes recorded for the census', releasedGpuBytes(pos) === bytesBefore, `${releasedGpuBytes(pos)} vs ${bytesBefore}`);
expect('stats count the released bytes', cpuCopyReleaseStats().releasedBytes === armed, JSON.stringify(cpuCopyReleaseStats()));
expect('second batch released', w.batch2.geometry.attributes.position.array.length === 0);
for (const k of ['shared', 'plain', 'points', 'dyn', 'keep']) {
  expect(`${k} keeps its CPU array`, w[k].geometry.attributes.position.array.length > 0 && releasedGpuBytes(w[k].geometry.attributes.position) === undefined);
}
// Vacuity: the shared guard is what protects library geometry.
const w2 = world();
releaseRenderOnlyCpuCopies(w2.root, () => false);
upload(w2.shared.geometry);
expect('without the isShared guard the library mesh WOULD be released (guard is load-bearing)', w2.shared.geometry.attributes.position.array.length === 0);
const again = releaseRenderOnlyCpuCopies(w.root, (o) => w.sharedSet.has(o));
expect('re-arming a released subtree arms nothing', again === 0, `${again}`);

// ── library templates (AssetLibrary.releaseCpuCopies / rehydrate gating) ──
{
  const { AssetLibrary } = await import('../src/client/assets/AssetLibrary.ts');
  const { trackUpload } = await import('../src/client/rendering/CpuCopyRelease.ts');
  const lib = new AssetLibrary();
  const tpl = (key) => {
    const g = new THREE.Group();
    const box = new THREE.BoxGeometry(1, 2, 3); box.clearGroups();
    const m = new THREE.Mesh(box, new THREE.MeshStandardMaterial());
    g.add(m);
    trackUpload(m.geometry);
    lib.scenes.set(key, g);
    return m;
  };
  const palm = tpl('palm_a');        // merged-only world asset: never drawn as a template
  const boulder = tpl('boulder_a');  // cloned into the scene, not drawn yet
  const fort = tpl('fort');          // cloned and already drawn
  const barrel = tpl('barrel');      // boot asset
  const cutlass = tpl('cutlass');    // runtime-cloned world asset
  const palmMerged = lib.mergedGeometry('palm_a');
  expect('merge served before the release', !!palmMerged && palmMerged.geometry.attributes.position.array.length > 0);
  trackUpload(palmMerged.geometry);
  const scene = new THREE.Scene();
  scene.add(lib.clone('boulder_a'), lib.clone('fort'));
  upload(fort.geometry);
  const bytes = lib.releaseCpuCopies(scene);
  expect('library release armed/dropped bytes', bytes > 0, `${bytes}`);
  expect('undrawn, unreferenced template dropped outright', palm.geometry.attributes.position.array.length === 0);
  expect('...and clone() answers null for it (fallback, never an empty mesh)', lib.clone('palm_a') === null);
  expect('undrawn merged copy dropped from the cache (mergedGeometry null, no re-merge from empty arrays)', lib.mergedGeometry('palm_a') === null);
  expect('in-scene template keeps its arrays until its upload', boulder.geometry.attributes.position.array.length > 0);
  upload(boulder.geometry);
  expect('...and drops them inside the upload', boulder.geometry.attributes.position.array.length === 0);
  expect('...with its GPU bytes recorded for the census', releasedGpuBytes(boulder.geometry.attributes.position) > 0);
  expect('drawn template dropped at once, clone still served', fort.geometry.attributes.position.array.length === 0 && lib.clone('fort') !== null);
  expect('bounds precomputed before the drop', !!fort.geometry.boundingBox && !lib.bounds('fort').isEmpty());
  expect('boot asset untouched', barrel.geometry.attributes.position.array.length > 0 && lib.clone('barrel') !== null);
  expect('runtime-cloned world asset never dropped outright', cutlass.geometry.attributes.position.array.length > 0 && lib.clone('cutlass') !== null);
  expect('a released key is never merged again', lib.mergedGeometry('fort') === null);
  expect('release is idempotent within a match', lib.releaseCpuCopies(scene) === 0);

  // b1-device-03: next match's rehydrate is BOUNDED (a phone must not refetch
  // and re-parse every released GLB at once on its main thread).
  const { REHYDRATE_CONCURRENCY } = await import('../src/client/assets/AssetLibrary.ts');
  const released = lib.cpuReleased.size;
  let inFlight = 0; let peak = 0; let loads = 0;
  lib.loadOne = async (_name, key) => {
    inFlight += 1; loads += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    lib.scenes.set(key, g);
    inFlight -= 1;
  };
  const job = lib.rehydrateReleased(scene);
  expect('rehydrate gates island builds while it runs', lib.rehydrating === true);
  await job;
  expect(`rehydrate refetched every released key (${loads}/${released}) and cleared the set`, released >= 3 && loads === released && lib.cpuReleased.size === 0 && !lib.rehydrating);
  expect(`rehydrate concurrency bounded (peak ${peak} <= ${REHYDRATE_CONCURRENCY} of ${released} keys)`,
    typeof REHYDRATE_CONCURRENCY === 'number' && REHYDRATE_CONCURRENCY >= 1 && peak <= REHYDRATE_CONCURRENCY);
}

if (failures) { console.error(`\nCPU-copy release: ${failures} failure(s).`); process.exit(1); }
console.log('\nCPU-copy release passed.');
