#!/usr/bin/env node
// WEBKIT KTX2 PROBE (b3.1c; performance-02). Safari is a first-class target
// (D2), and KTX2 is where WebKit differs most (no BC formats on iOS, ASTC or
// ETC2 instead; a transcoder that fails there leaves black or untextured props).
//
// One headless browser at a time, NO port: every request goes to the fake
// origin http://ktx2.probe/ and page.route() answers it from disk (three's
// modules, public/basis/ exactly as shipped, the packed GLB from the manifest).
// The page loads the packed GLB through GLTFLoader + meshopt + the KTX2Loader
// pointed at /basis/, asserts every map is a CompressedTexture with its mip
// chain, draws it unlit (MeshBasicMaterial with the same map, so the texture
// itself is graded, not the lighting) and reads the pixels back.
//
// PASS per engine: the GLB decodes, every map is compressed with its mips,
// >= 5% of the frame is textured, and the frame matches the SAME model drawn
// from its Blender source (JPEG) by the same engine and camera: mean colour
// within MEAN_DIST_MAX and mean per-pixel RGB distance within PIXEL_DIFF_MAX. Engines: webkit (the gate), plus
// chromium (SwiftShader via scripts/lib/browser-args.mjs) with --chromium.
// --mutate: serve an empty transcoder wasm (must FAIL: nothing decodes).
//
//   node scripts/probes/webkit-ktx2-probe.mjs [--chromium] [--asset capstan] [--mutate]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium } from 'playwright';
import { browserArgs } from '../lib/browser-args.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const ASSET = args.includes('--asset') ? args[args.indexOf('--asset') + 1] : 'capstan';
const MUTATE = args.includes('--mutate');
const ENGINES = args.includes('--chromium') ? ['webkit', 'chromium'] : ['webkit'];
const ORIGIN = 'http://ktx2.probe';
/** KTX2 render vs the Blender source's JPEG render, same engine, same camera. */
const MEAN_DIST_MAX = 8;
const PIXEL_DIFF_MAX = 24;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/client/assets/model-manifest.json'), 'utf8'));
const packed = path.join(ROOT, 'public/assets/models/packed', manifest[ASSET]);

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
window.__result = (async () => {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(256, 256, false); document.body.appendChild(renderer.domElement);
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  const scene = new THREE.Scene(); let cam = null; const gl = renderer.getContext();
  // One camera for both renders, framed on the packed model.
  async function draw(url) {
    const gltf = await loader.loadAsync(url);
    const maps = [];
    gltf.scene.traverse((o) => { if (o.isMesh) { const m = o.material; if (m.map) maps.push(m.map); o.material = new THREE.MeshBasicMaterial({ map: m.map ?? null, color: m.map ? 0xffffff : 0x000000 }); } });
    if (!cam) {
      const box = new THREE.Box3().setFromObject(gltf.scene); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(size.x, size.y, size.z);
      cam = new THREE.OrthographicCamera(-r / 2, r / 2, r / 2, -r / 2, 0.01, r * 10);
      // Face the largest silhouette: look along the smallest extent.
      const axis = size.x <= size.y && size.x <= size.z ? new THREE.Vector3(1, 0, 0) : size.y <= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      cam.position.copy(c).addScaledVector(axis, r * 3); if (axis.y === 1) cam.up.set(0, 0, 1); cam.lookAt(c);
    }
    scene.add(gltf.scene); renderer.render(scene, cam); scene.remove(gltf.scene);
    const px = new Uint8Array(256 * 256 * 4);
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { maps, px };
  }
  const ktx = await draw('/model.glb');
  const ref = await draw('/source.glb');
  let lit = 0; let diff = 0; const sum = [0, 0, 0]; const refSum = [0, 0, 0];
  for (let i = 0; i < ktx.px.length; i += 4) {
    const a = ktx.px; const b = ref.px;
    if (a[i] + a[i + 1] + a[i + 2] > 24 || b[i] + b[i + 1] + b[i + 2] > 24) {
      lit++; diff += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
      for (let k = 0; k < 3; k++) { sum[k] += a[i + k]; refSum[k] += b[i + k]; }
    }
  }
  const maps = ktx.maps;
  const ext = ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc'].filter((e) => gl.getExtension(e));
  return { maps: maps.length, compressed: maps.filter((t) => t.isCompressedTexture).length, refCompressed: ref.maps.filter((t) => t.isCompressedTexture).length,
    mips: maps.map((t) => t.mipmaps?.length ?? 0), formats: [...new Set(maps.map((t) => t.format))], litFrac: lit / (256 * 256),
    mean: lit ? sum.map((v) => v / lit) : [0, 0, 0], refMean: lit ? refSum.map((v) => v / lit) : [0, 0, 0], pixelDiff: lit ? diff / lit : 999, ext,
    gl: gl.getParameter(gl.VERSION) };
})().catch((e) => ({ error: String(e && e.stack || e) }));
</script></body></html>`;

function body(url) {
  const p = new URL(url).pathname;
  if (p === '/' || p === '/index.html') return { body: PAGE, contentType: 'text/html' };
  if (p === '/source.glb') return { body: fs.readFileSync(path.join(ROOT, `public/assets/models/${ASSET}.glb`)), contentType: 'model/gltf-binary' };
  if (p === '/model.glb') return { body: fs.readFileSync(packed), contentType: 'model/gltf-binary' };
  if (p.startsWith('/basis/')) {
    const f = path.join(ROOT, 'public', p);
    if (MUTATE && p.endsWith('.wasm')) return { body: Buffer.alloc(0), contentType: 'application/wasm' };
    return { body: fs.readFileSync(f), contentType: p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' };
  }
  if (p.startsWith('/three/')) return { body: fs.readFileSync(path.join(ROOT, 'node_modules', p)), contentType: 'text/javascript' };
  return null;
}

let failures = 0;
for (const engine of ENGINES) {
  let browser = null;
  try {
    browser = engine === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.route(`${ORIGIN}/**`, (route) => {
      const r = body(route.request().url());
      return r ? route.fulfill({ status: 200, ...r }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${ORIGIN}/`);
    const res = await page.waitForFunction(() => window.__result, null, { timeout: 60000 }).then(() => page.evaluate(() => window.__result));
    const dist = res.error ? 999 : Math.hypot(...res.mean.map((v, i) => v - res.refMean[i]));
    const ok = !res.error && res.maps > 0 && res.compressed === res.maps && res.mips.every((n) => n > 1) && res.litFrac >= 0.05
      && dist <= MEAN_DIST_MAX && res.pixelDiff <= PIXEL_DIFF_MAX;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${engine} ${ASSET}: ${res.error ? res.error.split('\n')[0] : `${res.compressed}/${res.maps} maps compressed (formats ${res.formats.join(',')}, mips ${res.mips.join(',')}), ${(res.litFrac * 100).toFixed(1)}% of frame textured, mean rgb ${res.mean.map((v) => v.toFixed(0)).join(',')} vs JPEG render ${res.refMean.map((v) => v.toFixed(0)).join(',')} (dist ${dist.toFixed(1)} <= ${MEAN_DIST_MAX}), per-pixel ${res.pixelDiff.toFixed(1)} <= ${PIXEL_DIFF_MAX}; ${res.gl}; ext ${res.ext.join(',')}`}`);
    if (!ok) failures += 1;
  } catch (e) {
    console.log(`FAIL ${engine}: ${e.message.split('\n')[0]}`); failures += 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}
console.log(failures ? `webkit-ktx2-probe: ${failures} FAIL` : 'webkit-ktx2-probe: PASS');
process.exit(failures ? 1 : 0);
