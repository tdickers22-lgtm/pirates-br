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
// PER-FAMILY TEXTURE ROWS (b3.1g, D27, critique gap 4): every texture reachable
// from a scene material is charged to the family AssetLibrary tagged on it
// (texture.userData.assetFamily); untagged ones (terrain, ocean, sky, env map,
// UI) are `shared`. Each family is graded on its OWN row of FAMILY_TEXTURE_MB in
// the tier column the profile runs (high / balanced / low + iPad / phone), and
// the table's columns must sum to FAMILY_TEXTURE_TOTALS_MB. The desktopHigh and
// desktopBalanced profiles carry only these rows and the texture total.
// PIRATES_BR_MUTATE_FAMILY_TEX=<family>: that family's reading goes 1 MB over
// its row -> that row (and only it) FAILS. Dev server only (the walk imports
// memoryCensus.ts by source path); --prod prints a loud skip.
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
import { MEMORY_BUDGETS, MODEL_FAMILIES, FAMILY_TEXTURE_MB, FAMILY_TEXTURE_ROW_OF, FAMILY_TEXTURE_TOTALS_MB, FAMILY_TEXTURE_DEVIATIONS_MB } from './lib/budgets.mjs';

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
const PROFILES = (process.env.PIRATES_MEMORY_PROFILES ?? (MUTATE ? 'phone' : 'phone,ipad,desktopLow,desktopBalanced,desktopHigh')).split(',');
const MUTATE_FAMILY_TEX = process.env.PIRATES_BR_MUTATE_FAMILY_TEX ?? null;
/** The D27 texture column each profile is graded in (iPad grades the low column). */
const TEX_COLUMN = { phone: 'phone', ipad: 'low', desktopLow: 'low', desktopBalanced: 'balanced', desktopHigh: 'high' };
/** b3.1b: an Air-class desktop pinned to the low tier at the harness's 960x540 @1 window (no
 *  device emulation: desktop UA, fine pointer). Graded against MEMORY_BUDGETS.desktopLow. */
const DESKTOP_PROFILES = {
  desktopLow: { label: 'desktop 960x540 @1, ?quality=low', query: '&quality=low', quality: 'low', viewport: { width: 960, height: 540 } },
  // b3.1g: graded on the per-family texture rows and the texture column total only.
  desktopBalanced: { label: 'desktop 960x540 @1, ?quality=balanced', query: '&quality=balanced', quality: 'balanced', viewport: { width: 960, height: 540 } },
  desktopHigh: { label: 'desktop 960x540 @1, ?quality=high', query: '&quality=high', quality: 'high', viewport: { width: 960, height: 540 } },
};

/** In the page: resident texture bytes per D27 family (unique texture sources on scene materials). */
const FAMILY_TEXTURES = async () => {
  const mod = await import('/src/client/debug/memoryCensus.ts');
  const scene = window.__piratesBR.renderer.scene;
  const seen = new Map();
  const add = (t) => { if (t?.isTexture && !t.isRenderTargetTexture) { const k = t.source ?? t; if (!seen.has(k)) seen.set(k, t); } };
  add(scene.background); add(scene.environment);
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const k of Object.keys(m)) add(m[k]);
    for (const u of mats.flatMap((m) => Object.values(m.uniforms ?? {}))) add(u?.value);
  });
  const bytes = {}; let tagged = 0;
  for (const t of seen.values()) {
    const fam = t.userData?.assetFamily ?? 'shared';
    if (t.userData?.assetFamily) tagged += 1;
    bytes[fam] = (bytes[fam] ?? 0) + mod.textureBytes(t).bytes;
  }
  return { bytes, tagged, textures: seen.size };
};

function gradeFamilyTextures(id, fam) {
  const col = TEX_COLUMN[id];
  const byRow = {};
  for (const [f, b] of Object.entries(fam.bytes)) {
    const row = FAMILY_TEXTURE_ROW_OF[f] ?? f;
    byRow[row] = (byRow[row] ?? 0) + b / 2 ** 20;
  }
  if (MUTATE_FAMILY_TEX) {
    const row = FAMILY_TEXTURE_ROW_OF[MUTATE_FAMILY_TEX] ?? MUTATE_FAMILY_TEX;
    if (!FAMILY_TEXTURE_MB[row]) throw new Error(`PIRATES_BR_MUTATE_FAMILY_TEX: no family ${MUTATE_FAMILY_TEX}`);
    byRow[row] = FAMILY_TEXTURE_MB[row][col] + 1;
    console.log(`      [MUTATED: ${row} textures -> ${byRow[row]} MB, 1 MB over its ${col} row]`);
  }
  console.log(`      family textures (${col} column, ${fam.textures} textures, ${fam.tagged} tagged): ${Object.entries(byRow).map(([f, mb]) => `${f} ${mb.toFixed(1)}`).join(', ')} MB`);
  expect(`[${id}] family texture census is not vacuous (>= 1 GLB texture tagged with its family)`, fam.tagged > 0 && fam.textures > 3, JSON.stringify(fam));
  for (const f of Object.keys(byRow)) expect(`[${id}] texture family ${f} has a D27 row`, !!FAMILY_TEXTURE_MB[f]);
  for (const [f, row] of Object.entries(FAMILY_TEXTURE_MB)) {
    const mb = byRow[f] ?? 0;
    const dev = MUTATE_FAMILY_TEX ? null : FAMILY_TEXTURE_DEVIATIONS_MB[`${f}.${col}`];
    if (dev && mb > row[col]) {
      console.log(`      ! textures ${f} ${mb.toFixed(1)} MB over its ${col} row ${row[col]} MB: declared deviation up to ${dev.upTo} MB (owner ${dev.owner})`);
      expect(`[${id}] textures ${f} ${mb.toFixed(1)} MB <= declared deviation ${dev.upTo} MB (${col})`, mb <= dev.upTo);
    } else expect(`[${id}] textures ${f} ${mb.toFixed(1)} MB <= ${row[col]} MB (${col})`, mb <= row[col]);
  }
}
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
  const budget = MEMORY_BUDGETS[id] ?? null; // desktopBalanced / desktopHigh: family rows + texture total only
  if (!profile || !TEX_COLUMN[id] || (!budget && !desktop)) throw new Error(`no profile/budget row for ${id}`);
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
    if (budget) {
      expect(`[${id}] GPU resident ${c.mb.gpu} MB <= ${budget.gpuMB} MB`, c.mb.gpu <= budget.gpuMB);
      expect(`[${id}] textures ${c.mb.textures} MB <= ${budget.texturesMB} MB`, c.mb.textures <= budget.texturesMB);
      expect(`[${id}] JS heap ${c.mb.heap} MB <= ${budget.heapMB} MB (${c.heapSource})`, c.mb.heap <= budget.heapMB);
    } else {
      const cap = FAMILY_TEXTURE_TOTALS_MB[TEX_COLUMN[id]];
      expect(`[${id}] textures ${c.mb.textures} MB <= ${cap} MB (D27 ${TEX_COLUMN[id]} residency)`, c.mb.textures <= cap);
    }
    if (PROD) console.log('      ! per-family texture rows SKIPPED under --prod (the walk imports memoryCensus.ts by source path; run without --prod)');
    else gradeFamilyTextures(id, await page.evaluate(FAMILY_TEXTURES));
    expect(`[${id}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    return c;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  console.log(`Resident memory budget (${PROFILES.join('/')}) — GL: ${describeGl()}`);
  // b3.1g: the allocation table must sum to the D27 residency column (a [realloc] never raises a sum).
  for (const [col, total] of Object.entries(FAMILY_TEXTURE_TOTALS_MB)) {
    const sum = Object.values(FAMILY_TEXTURE_MB).reduce((s, r) => s + r[col], 0);
    expect(`family texture rows sum to the ${col} total (${sum} = ${total} MB)`, sum === total);
  }
  expect('every model family has a texture row', MODEL_FAMILIES.every((f) => FAMILY_TEXTURE_MB[FAMILY_TEXTURE_ROW_OF[f] ?? f]));
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
