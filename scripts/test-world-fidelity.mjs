#!/usr/bin/env node
// Actual high-tier shader compilation and repeatable views of the fidelity pass.
// One page/context, serial shots; software GL is valid evidence, not an FPS test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const url = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const out = 'test-results/nature-fidelity/live';
await mkdir(out, { recursive: true });
const client = await ensureDevClient(`${url}/`);
const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
const errors = [];
const views = [];
try {
  console.log(`World fidelity — ${describeGl()}`);
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(300_000);
  page.on('pageerror', (e) => { errors.push(e.message); console.error(e.message); });
  page.on('console', (m) => {
    if (/Shader Error|VALIDATE_STATUS|GL_INVALID|WebGL:.*error|failed to build island/i.test(m.text())) {
      errors.push(m.text()); console.error(m.text());
    }
  });
  await page.goto(`${url}/?${sessionQuery(['debug', 'peace', 'quality=high'])}`, { waitUntil: 'domcontentloaded' });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing');
  console.log('PASS: joined a live match');
  await page.evaluate(() => {
    const g = window.__piratesBR;
    g.setBotPeace(true);
    g.setDayNightOverride(854);
    g.setWeatherOverride(0);
    // Let the incremental build finish while looking at the sky. On software
    // GL, rasterising the dock between every 2ms atlas slice adds minutes of
    // irrelevant fill cost. The graded views below still draw the whole scene.
    g.enableFreeCam(0, 350, 0, 0, 1.3);
    document.querySelector('#oc-skip')?.click();
    if (g.debugPerfPanel) g.debugPerfPanel.style.visibility = 'hidden';
  });
  // Grade the completed atlas, not an arbitrary number of slow software frames.
  await page.setViewportSize({ width: 320, height: 180 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const progress = await page.evaluate(() => {
      const g = window.__piratesBR;
      return { built: g.islandMeshes.size, islands: g.state.islands.length,
        atlasReady: g.ocean.material.uniforms.u_bathymetryReady.value,
        atlasIsland: g.ocean.bathymetry.next, atlasJobs: g.ocean.bathymetry.jobs.length };
    });
    if (attempt % 6 === 0) console.log('World build:', JSON.stringify(progress));
    ready = progress.atlasReady === 1 && progress.built === progress.islands;
    if (ready) break;
    assert.deepEqual(errors, [], 'world build/runtime errors');
    await page.waitForTimeout(5000);
  }
  assert.ok(ready, 'world and shoreline atlas failed to finish');
  await page.setViewportSize({ width: 960, height: 540 });
  console.log('PASS: all islands built and the shared-terrain shoreline atlas reached the GPU');
  const plan = await page.evaluate(() => {
    const g = window.__piratesBR;
    const islands = g.state.islands;
    const bay = islands.find((i) => i.name === 'Booty Bay');
    const mountain = islands.find((i) => i.name === "Crow's Perch" && i.bridges?.length)
      ?? islands.find((i) => i.bridges?.length);
    const b = mountain.bridges[0];
    const mx = (b.ax + b.bx) / 2, mz = (b.az + b.bz) / 2;
    const span = Math.hypot(b.bx - b.ax, b.bz - b.az);
    const shrubIsland = islands.find((i) => i.props?.some((p) => p.type === 'bush'));
    const shrub = shrubIsland.props.find((p) => p.type === 'bush');
    const sx = shrub.x, sz = shrub.z;
    return [
      { id: 'bay-and-cays', x: bay.position.x, y: bay.radius * 2.9, z: bay.position.z - bay.radius * 0.7,
        target: { x: bay.position.x, y: 0, z: bay.position.z } },
      { id: 'peak-bridge', x: mx - (b.bz - b.az) / span * 26, y: Math.max(b.ay, b.by) + 14,
        z: mz + (b.bx - b.ax) / span * 26, target: { x: mx, y: (b.ay + b.by) / 2 - 1, z: mz } },
      { id: 'understory', x: sx - 1.8,
        y: Math.max(g.sampleGroundY(sx - 1.8, sz - 2.2), g.sampleGroundY(sx, sz)) + 1.0, z: sz - 2.2,
        target: { x: sx, y: g.sampleGroundY(sx, sz) + 0.45, z: sz } },
      { id: 'calm-water', x: 310, y: 2.8, z: -220, target: { x: 470, y: -12, z: -140 } },
      { id: 'storm-water', x: 310, y: 4.5, z: -220, target: { x: 470, y: -12, z: -140 }, weather: 1 },
    ];
  });
  // The first-voyage cards can open after the initial join frame. Close them
  // after loading too, and make the capture immune to a deferred reopen.
  await page.evaluate(() => document.querySelector('#oc-skip')?.click());
  await page.addStyleTag({ content: '#hud, #onboard-cards, #minimap, #crosshair { visibility: hidden !important; }' });
  assert.equal(await page.locator('#onboard-cards').isVisible(), false, 'onboarding obscures the captured world');
  for (const cam of plan) {
    await page.evaluate((c) => {
      const g = window.__piratesBR;
      const dx = c.target.x - c.x, dz = c.target.z - c.z;
      g.setWeatherOverride(c.weather ?? 0);
      // Weather tint alone deliberately does not relocate the real storm.
      // Use the existing storm-demo hook to exercise the storm wave geometry.
      g.debugStormDemo = (c.weather ?? 0) > 0;
      g.enableFreeCam(c.x, c.y, c.z, Math.atan2(dx, dz), Math.atan2(c.target.y - c.y, Math.hypot(dx, dz)));
      g.settleLod(3);
    }, cam);
    const stats = await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const tick = () => {
        if (++frames < 5) return requestAnimationFrame(tick);
        const info = window.__piratesBR.renderer.renderer.info;
        resolve({ calls: info.render.calls, triangles: info.render.triangles, programs: info.programs.length,
          stormPhase: window.__piratesBR.ocean.material.uniforms.u_stormPhase01.value });
      };
      requestAnimationFrame(tick);
    }));
    const png = await page.screenshot({ path: `${out}/${cam.id}.png` });
    assert.ok(png.length > 20_000, `${cam.id}: empty/flat screenshot`);
    assert.ok(stats.calls > 10 && stats.triangles > 1000, `${cam.id}: no rendered world`);
    if (cam.weather) assert.equal(stats.stormPhase, 1, 'storm view must include full storm swell, not just weather tint');
    views.push({ ...cam, ...stats, bytes: png.length });
    console.log(`PASS: ${cam.id} rendered (${stats.calls} draws, ${stats.triangles} triangles)`);
  }
  assert.deepEqual(errors, [], 'runtime/shader errors');
  console.log('PASS: ocean and foliage shaders compile and render without WebGL/runtime errors');
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ views, errors }, null, 2));
  await browser.close();
  stopDevClient(client);
}
