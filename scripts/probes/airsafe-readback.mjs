#!/usr/bin/env node
// PROBE, not a gate: what does a `?quality=high` session actually OPEN at on an
// Air-class part versus a part with a fan? (airsafe)
//
// The pure gate (test-frame-governor § fill ceiling) proves the arithmetic on
// the owner's 1470x956@2 panel; this reads the SIDE EFFECT back from a live
// renderer — the drawing buffer's real pixel count, the sun's real shadow map,
// the composer's sample count — with the GPU's name spoofed, so it runs on the
// software rasteriser and cannot lock anything up. Two loads in one browser:
// "Apple M2" (apple-base: the cap binds) and "Apple M2 Max" (apple-pro: today's
// numbers). The settings note and the tier option labels are read too.
//
// Boots its OWN stack (server :8091 seed 20260801, Vite :3101), ONE headless
// Chromium at 960x540 CSS on whatever `scripts/lib/browser-args.mjs` decides
// (the software rasteriser by default) at deviceScaleFactor 2 — the cap is a
// pixel-ratio cap and only shows on a HiDPI panel — and kills both in `finally`.
// Never :3000 or :8090.
//
//   node scripts/probes/airsafe-readback.mjs [outJson]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/airsafe-readback.json';
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const ROOT = process.cwd();
mkdirSync(path.dirname(OUT), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; }
}

const started = [];
async function ensure(name, command, url, env, timeoutMs = 120_000) {
  if (await isUp(url)) { console.log(`[probe] ${name} already up at ${url} — reusing`); return; }
  console.log(`[probe] starting ${name} → ${url}`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  started.push({ name, child });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
async function teardown() {
  for (const { name, child } of started.splice(0).reverse()) {
    console.log(`[probe] stopping ${name}`);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(900);
    try { if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Patch WEBGL_debug_renderer_info's answer before any module runs. */
const SPOOF_RENDERER = (name) => {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const patch = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === UNMASKED_RENDERER_WEBGL) return name;
      return orig.call(this, p);
    };
  };
  patch(globalThis.WebGLRenderingContext?.prototype);
  patch(globalThis.WebGL2RenderingContext?.prototype);
};

const READ_MENU = () => ({
  note: document.getElementById('settings-quality-note')?.textContent ?? null,
  options: Array.from(document.querySelectorAll('#settings-quality option')).map((o) => o.textContent),
});

const READ_RENDERER = () => {
  const r = window.__piratesBR?.renderer;
  if (!r?.getGovernorStatus) return null;
  const s = r.getGovernorStatus();
  const verdict = r.getQualityVerdict?.() ?? null;
  const canvas = r.renderer?.domElement ?? null;
  return {
    quality: r.getQuality?.() ?? null,
    verdictReason: verdict?.reason ?? null,
    rendererString: verdict?.rendererString ?? null,
    gpuClass: s.gpuClass,
    governor: { enabled: s.enabled, mode: s.mode, scalar: s.scalar, label: s.label },
    pixelRatio: s.pixelRatio,
    minPixelRatio: r.minPixelRatio ?? null,
    maxPixelRatio: r.maxPixelRatio ?? null,
    drawingBuffer: canvas ? { width: canvas.width, height: canvas.height } : null,
    framebufferPixels: s.framebufferPixels,
    shadowMapSize: s.shadowMapSize,
    composerSamples: r.postFx?.composer?.renderTarget1?.samples ?? null,
    fillCap: s.fillCap,
    devicePixelRatio: window.devicePixelRatio,
    css: { width: window.innerWidth, height: window.innerHeight },
  };
};

async function readback(browser, label, rendererName) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(SPOOF_RENDERER, rendererName);
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err}`));
  await page.route('**/@vite/client*', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export default {};',
  }));
  try {
    await page.goto(`${CLIENT_URL}/?debug&quality=high&server=${SERVER_PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    const menu = await page.evaluate(READ_MENU);
    // The renderer may only exist once a match starts.
    let renderer = await page.evaluate(READ_RENDERER);
    if (!renderer) {
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => !!window.__piratesBR?.renderer?.getGovernorStatus, null, { timeout: 240_000 });
      await page.waitForTimeout(3000);
      renderer = await page.evaluate(READ_RENDERER);
    }
    const result = { label, rendererName, menu, renderer };
    console.log(`\n[${label}] renderer=${JSON.stringify(rendererName)}`);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

async function main() {
  console.log(`airsafe readback — GL: ${describeGl()}`);
  let browser;
  const results = {};
  try {
    await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: SEED, PIRATES_BR_DEV_HOOKS: '1' });
    await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, `${CLIENT_URL}/`, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
    results.m2 = await readback(browser, 'Apple M2 (apple-base)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)');
    results.m2max = await readback(browser, 'Apple M2 Max (apple-pro)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)');
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`\n→ ${OUT}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await teardown();
  }
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
