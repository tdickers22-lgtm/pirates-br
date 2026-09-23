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

if (failures) { console.error(`\nCPU-copy release: ${failures} failure(s).`); process.exit(1); }
console.log('\nCPU-copy release passed.');
