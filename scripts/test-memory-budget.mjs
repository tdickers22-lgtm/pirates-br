#!/usr/bin/env node
// RESIDENT MEMORY BUDGET — phone and iPad rows (b1.7b, critique gap 9), desktop low row (b3.1b).
//
// An iPhone does not slow a tab that holds too much; it kills it and reloads
// the page, mid-match. SwiftShader cannot see that, and neither can a Mac. What
// the harness CAN measure honestly is the bytes the game pins: every unique
// buffer and texture source reachable from the scene, every render target, the
// drawing buffer, and the JS heap. `window.__piratesBR.memoryCensus()`
// (src/client/debug/memoryCensus.ts) counts them; this gate grades them after a
// scripted 60 s tour of the world on the emulated device, against the rows in
// scripts/lib/budgets.mjs (MEMORY_BUDGETS; the ratchet keeps them tightening).
//
// THE TOUR. A census at the spawn grades nothing: the story scenes stream in at
// LOD0 only within 400 m (phone) and a phone must EVICT them past 1500 m. So the
// camera stands off every island in nearest-neighbour order for 60 s total and
// the census is taken where the tour ends, after the eviction line has had its
// chance. A leak on that path is exactly what the rows exist to catch.
//
// MUTATION (`--mutate`): after the phone tour every lazy story scene is made
// resident at LOD0 twice more, with fresh buffers and texture sources (the shape
// of an evict/re-ensure leak). The phone row MUST then fail; the run exits 1.
//
// Stack: its own 3101 (vite) / 8091 (server, map seed 20260801) unless one is
// already answering there. ONE headless SwiftShader Chromium, closed in finally.
// Run: node scripts/run-all-tests.mjs --only memory-budget   (or directly).
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { DEVICE_PROFILES, newDeviceContext, READ_DEVICE_VERDICT, DEVICE_EXPECTED_VERDICT } from './lib/perf-scenes.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import { MEMORY_BUDGETS } from './lib/budgets.mjs';

const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const TOUR_MS = Number(process.env.PIRATES_MEMORY_TOUR_MS ?? 60_000);
const MUTATE = process.argv.includes('--mutate') || process.env.PIRATES_BR_MUTATE_MEMORY === '1';
/** --prod grades the production bundle (vite build + vite preview on 3101), which is what a
 *  phone actually runs; the dev server's unbundled module graph is heap a phone never pays.
 *  The mutation needs the dev server (it imports the census module by source path). */
const PROD = process.argv.includes('--prod') && !MUTATE;
const PROD_DIR = '/tmp/pbr-memory-dist';
const PROFILES = (process.env.PIRATES_MEMORY_PROFILES ?? (MUTATE ? 'phone' : 'phone,ipad,desktopLow')).split(',');
/** b3.1b: an Air-class desktop pinned to the low tier at the harness's 960x540 @1 window (no
 *  device emulation: desktop UA, fine pointer). Graded against MEMORY_BUDGETS.desktopLow. */
const DESKTOP_PROFILES = {
  desktopLow: { label: 'desktop 960x540 @1, ?quality=low', query: '&quality=low', quality: 'low', viewport: { width: 960, height: 540 } },
};
if ([SERVER_PORT, new URL(CLIENT_URL).port].some((p) => ['3000', '8090', '8080'].includes(p))) {
  throw new Error('test-memory-budget never runs on 3000/8090 (the owner plays there) or 8080');
}

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; }
}

function startServer() {
  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV: '1', PIRATES_BR_DEV_HOOKS: '1' },
  });
  return { child };
}

/** Nearest-neighbour stops standing off every island, then the camera tour. */
const TOUR = async ([tourMs]) => {
  const g = window.__piratesBR;
  const islands = g.state.islands.map((i) => ({ x: i.position.x, z: i.position.z, r: i.radius }));
  const mine = (g.state.ships ?? []).find((s) => s.ownerId === g.localPlayerId) ?? g.state.ships?.[0];
  let at = { x: mine?.position.x ?? 0, z: mine?.position.z ?? 0 };
  const left = [...islands];
  const order = [];
  while (left.length) {
    left.sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z));
    const next = left.shift();
    order.push(next);
    at = next;
  }
  const dwell = Math.max(2500, Math.floor(tourMs / Math.max(1, order.length)));
  const t0 = performance.now();
  let visited = 0;
  for (const isl of order) {
    if (performance.now() - t0 > tourMs) break;
    const x = isl.x - (isl.r + 60) * Math.SQRT1_2;
    const z = isl.z - (isl.r + 60) * Math.SQRT1_2;
    g.enableFreeCam(x, 28, z, Math.atan2(isl.x - x, isl.z - z), -0.14);
    await new Promise((r) => setTimeout(r, dwell));
    visited += 1;
  }
  return { visited, islands: order.length, ms: Math.round(performance.now() - t0) };
};

async function censusFor(browser, id) {
  const desktop = DESKTOP_PROFILES[id];
  const profile = desktop ?? DEVICE_PROFILES[id];
  const budget = MEMORY_BUDGETS[id];
  if (!profile || !budget) throw new Error(`no profile/budget row for ${id}`);
  const context = desktop
    ? await browser.newContext({ viewport: desktop.viewport, deviceScaleFactor: 1 })
    : await newDeviceContext(browser, profile);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    console.log(`\n  [${id}] ${profile.label}${MUTATE ? '  [MUTATED: every story scene at LOD0 twice]' : ''}`);
    await page.goto(`${CLIENT_URL}/?debug&fps=uncapped&server=${SERVER_PORT}${desktop?.query ?? ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace?.(true));
    const v = await page.evaluate(READ_DEVICE_VERDICT);
    if (desktop) expect(`[${id}] session runs the ${desktop.quality} tier`, v.quality === desktop.quality, `got ${v.quality} (${v.reason})`);
    else expect(`[${id}] session runs the mobile verdict (${DEVICE_EXPECTED_VERDICT.quality}/${DEVICE_EXPECTED_VERDICT.reason})`,
      v.quality === DEVICE_EXPECTED_VERDICT.quality && v.reason === DEVICE_EXPECTED_VERDICT.reason, `got ${v.quality} (${v.reason})`);
    const tour = await page.evaluate(TOUR, [TOUR_MS]);
    console.log(`      tour: ${tour.visited}/${tour.islands} islands in ${(tour.ms / 1000).toFixed(1)} s`);
    expect(`[${id}] the tour ran >= ${Math.round(TOUR_MS / 1000) - 1} s and visited islands`, tour.ms >= TOUR_MS - 1000 && tour.visited >= 2,
      JSON.stringify(tour));
    if (MUTATE) {
      const forced = await page.evaluate(async () => {
        const mod = await import('/src/client/debug/memoryCensus.ts');
        const g = window.__piratesBR;
        return mod.forceStoryLod0({ gl: g.renderer.renderer, scene: g.renderer.scene, root: g }, 2);
      });
      console.log(`      ! mutation: ${forced} story scenes forced resident at LOD0 x2`);
    }
    await page.waitForTimeout(4_000); // let the last stop (or the mutation) draw and upload
    // Collect first: usedJSHeapSize counts garbage the next GC would free, and iOS
    // kills on what survives a collection, not on what is merely unswept.
    const before = await page.evaluate(() => window.__piratesBR.memoryCensus().mb.heap);
    const c = await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) { window.gc?.(); await new Promise((r) => setTimeout(r, 250)); }
      // The loop lets finalizers and the array-buffer sweeper run; the reading itself
      // is taken right after one more synchronous gc(), before the census walk and
      // before another uncapped frame allocates (b1.gate: 250 ms of frames plus the
      // walk's own maps swung the reading ~25 MB, after-GC > before-GC in 3 of 5).
      return window.__piratesBR.memoryCensus({ collect: true });
    });
    console.log(`      heap before GC ${before} MB, after ${c.mb.heap} MB${c.gcExposed === false ? ' (gc not exposed)' : ''}`);
    console.log(`      GPU ${c.mb.gpu} MB = geometry ${c.mb.geometry} + textures ${c.mb.textures} + targets/drawing buffer ${c.mb.renderTargets}`);
    console.log(`      heap ${c.mb.heap} MB (${c.heapSource}), of which typed arrays ${c.mb.heapTypedArrays} MB; library-retained CPU geometry ${c.mb.library} MB`);
    console.log(`      CPU copies released after upload ${c.mb.cpuReleased} MB (${c.cpuRelease?.enabled ? 'release on' : 'release OFF'}; armed ${(c.cpuRelease?.armedBytes / 1e6).toFixed(1)} MB; still queued ${c.cpuRelease?.pendingCount ?? '?'} geometries ${((c.cpuRelease?.pendingBytes ?? 0) / 1e6).toFixed(1)} MB; eager pass ran ${c.cpuRelease?.eagerPasses ?? '?'} frames, ${((c.cpuRelease?.eagerBytes ?? 0) / 1e6).toFixed(1)} MB)`);
    console.log(`      counts ${JSON.stringify(c.counts)}`);
    console.log(`      scene objects ${c.objects}; CPU-retained geometry by family: ${(c.topRetained ?? []).map((t) => `${t.name} ${t.mb}MB x${t.n} (index ${t.indexMb}MB, ${t.uploaded} uploaded)`).join(', ')}`);
    console.log(`      materials ${c.materials}: ${(c.topMaterials ?? []).map((t) => `${t.key} x${t.n}`).join(', ')}`);
    console.log(`      top textures ${c.topTextures.slice(0, 5).map((t) => `${t.name} ${t.w}x${t.h} ${t.mb}MB`).join(', ')}`);
    // The census must have SEEN something, or every row below passes vacuously.
    expect(`[${id}] census is not vacuous (geometry, textures and targets all counted)`,
      // (render targets: 0 is honest on the low tier a device gets: no post-fx, no shadow map)
      c.counts.geometries > 50 && c.counts.textures > 3 && c.drawingBufferBytes > 0 && c.geometryBytes > 1e6,
      JSON.stringify(c.counts));
    expect(`[${id}] GPU resident ${c.mb.gpu} MB <= ${budget.gpuMB} MB`, c.mb.gpu <= budget.gpuMB);
    expect(`[${id}] textures ${c.mb.textures} MB <= ${budget.texturesMB} MB`, c.mb.textures <= budget.texturesMB);
    expect(`[${id}] JS heap ${c.mb.heap} MB <= ${budget.heapMB} MB (${c.heapSource})`, c.mb.heap <= budget.heapMB);
    expect(`[${id}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    return c;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  console.log(`Resident memory budget (${PROFILES.join('/')}) — GL: ${describeGl()}`);
  const started = [];
  let browser;
  try {
    if (!(await up(HEALTH_URL))) {
      const s = startServer();
      started.push(s);
      const t0 = Date.now();
      while (!(await up(HEALTH_URL))) {
        if (Date.now() - t0 > 60_000 || s.child.exitCode !== null) throw new Error(`server did not answer ${HEALTH_URL}`);
        await sleep(400);
      }
    }
    if (PROD) {
      if (await up(`${CLIENT_URL}/`)) throw new Error(`--prod needs ${CLIENT_URL} free for vite preview`);
      console.log('  · building the production bundle (vite build) ...');
      await new Promise((res, rej) => {
        const b = spawn('npx', ['vite', 'build', '--outDir', PROD_DIR, '--emptyOutDir'], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit'] });
        b.on('exit', (code) => (code === 0 ? res() : rej(new Error(`vite build exited ${code}`))));
      });
      const port = new URL(CLIENT_URL).port || '3101';
      const child = spawn('npx', ['vite', 'preview', '--outDir', PROD_DIR, '--port', port, '--strictPort'], {
        cwd: process.cwd(), detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      });
      started.push({ child });
      const t0 = Date.now();
      while (!(await up(`${CLIENT_URL}/`))) {
        if (Date.now() - t0 > 60_000 || child.exitCode !== null) throw new Error('vite preview did not come up');
        await sleep(400);
      }
    } else {
      const client = await ensureDevClient(`${CLIENT_URL}/`);
      if (client) started.push(client);
    }
    console.log(`  · client: ${PROD ? 'production bundle (vite preview)' : 'vite dev server'} at ${CLIENT_URL}`);
    browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--enable-precise-memory-info', '--js-flags=--expose-gc']) });
    const rows = {};
    for (const id of PROFILES) rows[id] = await censusFor(browser, id);
    console.log(`\n  FRAME_COST_MODEL row: ${Object.entries(rows).map(([k, c]) => `${k} gpu ${c.mb.gpu} / tex ${c.mb.textures} / heap ${c.mb.heap} MB`).join('; ')}`);
  } finally {
    await browser?.close().catch(() => {});
    for (const h of started.reverse()) {
      if (h.child?.exitCode === null) {
        stopDevClient(h);
        await sleep(800);
        try { process.kill(-h.child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  }
  if (failures > 0) { console.error(`\nMemory budget: ${failures} failure(s).`); process.exit(1); }
  console.log('\nMemory budget passed.');
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
