#!/usr/bin/env node
// ENV-METAL PROBE (b3.1d, assets-13): does a metal read as metal?
//
// WHY. A PBR metal has no diffuse term; without an environment map the only
// light it can show is the sun's single specular highlight, so a metalness-1
// surface renders near black and every GLB builder had set metalness 0 to hide
// it. This probe grades the fix where the player sees it: in the real scene,
// under the real sky, with the real lights.
//
// WHAT, per tier (default high and low; --quality X for one):
//   1. A metal chart (MeshStandardMaterial, metalness 1.0 = ORM.b 1.0 > 0.8,
//      roughness 0.45 = forged iron) is put 3 m in front of the camera under the
//      NOON sky, and the frame is drawn twice in one task: with
//      scene.environment as shipped and with it set to null. The mean sRGB
//      luminance of the chart's upper half (which mirrors the sky) must be
//      > 1.5x brighter with the env map.
//   2. The env map is the LIVE sky and never per frame: holding noon for 3 s of
//      rendered frames adds 0 captures; moving to night adds >= 1 capture and
//      changes the phase key; the texture bound to scene.environment is the
//      one SkyEnvironment owns; the path is 'pmrem' (128) on high/balanced and
//      'baked' (32) on low.
//
// --mutate: sets scene.environment = null for the whole run (the pre-b3.1d
// state). The gate must FAIL.
//
// usage: node scripts/probes/env-metal-probe.mjs [--url http://127.0.0.1:3101] [--quality high|balanced|low] [--mutate]
// Needs a running stack (server 8091 with PIRATES_BR_DEV_HOOKS=1, vite 3101).
// Never 3000/8090/8080. ONE headless SwiftShader Chromium, 960x540, closed in finally.
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const URL = arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const MUTATE = argv.includes('--mutate');
const QUALITIES = arg('quality', null) ? [arg('quality')] : ['high', 'low'];
const MIN_RATIO = 1.5;
const EXPECT = { high: { path: 'pmrem', cubeSize: 128 }, balanced: { path: 'pmrem', cubeSize: 128 }, low: { path: 'baked', cubeSize: 32 } };

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); failures += 1; };

console.log(`GL backend: ${describeGl()}  url ${URL}${MUTATE ? '  (MUTATED: env map off)' : ''}`);
const browser = await chromium.launch({ args: browserArgs(['--ignore-gpu-blocklist']) });
try {
  for (const quality of QUALITIES) {
    console.log(`\n[${quality}]`);
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.route('**/@vite/client', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export {};' }));
    await page.goto(`${URL}/?debug&forceinput&quality=${quality}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 240_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      document.getElementById('oc-skip')?.click();
      window.__piratesBR.enableFreeCam(0, 24, 260, Math.PI, 0.05);
    });
    if (MUTATE) await page.evaluate(() => { window.__piratesBR.renderer.scene.environment = null; });

    // Noon = the override with the highest sun; night = the lowest.
    const sunAt = async (sec) => {
      await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
      await page.waitForTimeout(350);
      return page.evaluate(() => window.__piratesBR.renderer.getSunDirection().y);
    };
    let noon = { sec: 0, y: -2 };
    for (const sec of [-240, -120, 0, 120, 240, 345]) { const y = await sunAt(sec); if (y > noon.y) noon = { sec, y }; }
    let night = { sec: 0, y: 2 };
    for (const sec of [700, 780, 854, 920]) { const y = await sunAt(sec); if (y < night.y) night = { sec, y }; }
    console.log(`  noon override ${noon.sec}s (sunY ${noon.y.toFixed(2)}), night ${night.sec}s (sunY ${night.y.toFixed(2)})`);

    await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), noon.sec);
    await page.waitForTimeout(2500);
    const readout = await page.evaluate(() => {
      const r = window.__piratesBR.renderer;
      const env = typeof r.getEnvironmentStats === 'function' ? r.getEnvironmentStats() : null;
      const scene = r.scene;
      const camera = r.camera;
      const gl3 = r.renderer;
      let Std = null;
      scene.traverse((o) => { if (!Std && o.material?.isMeshStandardMaterial) Std = o.material.constructor; });
      const Mesh = r.skyMesh.constructor;
      const Sphere = r.skyMesh.geometry.constructor;
      const dir = camera.position.clone();
      camera.getWorldDirection(dir);
      const at = camera.position.clone().addScaledVector(dir, 3);
      const chart = new Mesh(new Sphere(0.6, 48, 24), new Std({ color: 0xc8c8c8, metalness: 1.0, roughness: 0.45 }));
      chart.position.copy(at);
      chart.renderOrder = 999;
      scene.add(chart);
      chart.updateMatrixWorld(true);
      const probe = at.clone().addScaledVector(camera.up, 0.3).project(camera);
      const gl = gl3.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const cx = Math.round((probe.x * 0.5 + 0.5) * W), cy = Math.round((probe.y * 0.5 + 0.5) * H);
      const box = Math.max(8, Math.round(H * 0.04));
      const lum = () => {
        chart.visible = true;
        gl3.setRenderTarget(null);
        gl3.render(scene, camera);
        const px = new Uint8Array(box * box * 4);
        gl.readPixels(cx - box / 2, cy - box / 2, box, box, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0;
        for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        return s / (box * box);
      };
      const shipped = scene.environment;
      const on = lum();
      scene.environment = null;
      const off = lum();
      scene.environment = shipped;
      scene.remove(chart);
      chart.geometry.dispose();
      chart.material.dispose();
      return { env, on, off, box, cx, cy };
    });
    const { env, on, off } = readout;
    console.log(`  env ${JSON.stringify(env)}`);
    console.log(`  metal chart luminance: env on ${on.toFixed(1)}, env off ${off.toFixed(1)} (box ${readout.box}px at ${readout.cx},${readout.cy})`);
    const ratio = on / Math.max(off, 0.5);
    if (ratio > MIN_RATIO) pass(`metal chart ${ratio.toFixed(2)}x brighter with the env map (> ${MIN_RATIO}x)`);
    else fail(`metal chart only ${ratio.toFixed(2)}x brighter with the env map (need > ${MIN_RATIO}x): metals still read dark`);

    if (!env) { fail('renderer.getEnvironmentStats() missing: no SkyEnvironment'); await page.close(); continue; }
    const want = EXPECT[quality];
    if (env.path === want.path && env.cubeSize === want.cubeSize) pass(`path ${env.path}, ${env.cubeSize}px cube`);
    else fail(`path ${env.path}/${env.cubeSize} on ${quality}, expected ${want.path}/${want.cubeSize}`);
    if (env.bound) pass('scene.environment is the SkyEnvironment texture'); else fail('scene.environment is not bound to the sky env map');
    if (env.chunkPatched) pass('IBL chunk patched (radiance only)'); else fail('lights_fragment_maps patch did not apply');

    // Never per frame.
    const held = await page.evaluate(async () => {
      const r = window.__piratesBR.renderer;
      const before = r.getEnvironmentStats().refreshes;
      let frames = 0;
      await new Promise((res) => {
        const t0 = performance.now();
        const tick = () => { frames += 1; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(); };
        requestAnimationFrame(tick);
      });
      return { before, after: r.getEnvironmentStats().refreshes, frames };
    });
    if (held.frames >= 3 && held.after === held.before) pass(`${held.frames} frames at a held noon, 0 captures`);
    else fail(`held noon: ${held.after - held.before} captures over ${held.frames} frames (must be 0 over >= 3)`);

    // Phase change refreshes.
    await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), night.sec);
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => window.__piratesBR.renderer.getEnvironmentStats());
    if (after.refreshes > held.after && after.key !== env.key) pass(`night re-captured (${env.key} -> ${after.key}, ${after.refreshes - held.after} capture(s), last ${after.lastCaptureCostMs.toFixed(1)} ms)`);
    else fail(`day -> night did not re-capture (key ${env.key} -> ${after.key}, refreshes ${held.after} -> ${after.refreshes})`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
}
if (failures) { console.error(`\nenv-metal-probe: ${failures} FAIL`); process.exit(1); }
console.log('\nenv-metal-probe: PASS');
