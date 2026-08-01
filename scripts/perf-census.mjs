#!/usr/bin/env node
// THE BUDGET CENSUS — every scene's COUNTS, on whatever GL backend is available.
//
// perf-probe.mjs answers "which build is faster"; this answers "what does each
// view COST", and it deliberately reports only the figures that are exact on a
// software rasteriser: draw calls, triangles, programs, and the geometry/texture
// residency out of renderer.info.memory. Those numbers come out of three's own
// bookkeeping — they are decided by the scene graph, the frustum and the LOD
// gates, none of which know or care which GL backend is underneath. Frame times
// are reported too but marked ADVISORY under SwiftShader, and nothing here
// grades them.
//
// It also reports the pixel ratio the CLIENT chose for itself, unpinned, before
// any measurement pins it — because "what tier did this machine land in and how
// many fragments is it asking for" is the other half of a budget and no draw
// count will ever show it.
//
//   PIRATES_GL=swiftshader node scripts/perf-census.mjs --url http://127.0.0.1:3000
//   node scripts/perf-census.mjs --out /tmp/census-before.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, sessionQuery } from './perf-probe.mjs';
import {
  READ_CLIENT_TIER, READ_AUTO_TIER, FIND_WATERFALL_ISLAND, planWaterfallDeck, TALLY_DRAW_SOURCES,
} from './lib/perf-scenes.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg('url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const SERVER_HEALTH_URL = arg('health', 'http://127.0.0.1:8090/health');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', null);
const LABEL = arg('label', 'HEAD');
// Small on purpose: the machine this runs on is fanless, SwiftShader is a CPU
// rasteriser, and a 16:9 viewport of any size produces the SAME frustum — so
// the counts at 960x540 are the counts at 1600x900.
const VIEWPORT = { width: 960, height: 540 };
const WARMUP_MS = parseInt(arg('warmup', IS_SOFTWARE_GL ? '2500' : '3500'), 10);
const CAPTURE_MS = parseInt(arg('capture', IS_SOFTWARE_GL ? '3500' : '3500'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch { return false; }
}

async function waitForReady(url, child, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReady(url)) return;
    if (child && child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
    await sleep(400);
  }
  throw new Error(`not ready at ${url} within ${timeoutMs}ms`);
}

function startNpmScript(scriptName) {
  return spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BROWSER: 'none' },
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
}

const CENSUS_SCENES = [
  { id: 'dock-vista', session: 'main', label: 'dock vista (wide)' },
  { id: 'deck-aft', session: 'main', label: 'on-deck aft look' },
  { id: 'island-interior', session: 'main', label: 'island interior eye-level' },
  { id: 'cave-interior', session: 'main', label: 'cave interior' },
  { id: 'open-sea', session: 'main', label: 'open-sea sail view' },
  { id: 'waterfall-deck', session: 'main', label: 'deck view of a waterfall island' },
  { id: 'combat-burst', session: 'combat', label: 'combat burst (cannon + keg FX)' },
  { id: 'storm-sea', session: 'storm', label: 'storm at sea (?stormdemo)' },
];

const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const activeScenes = CENSUS_SCENES.filter((s) => !SCENE_FILTER || SCENE_FILTER.includes(s.id));

const SESSION_PARAMS = {
  main: ['debug', `quality=${QUALITY}`],
  combat: ['debug', `quality=${QUALITY}`, 'forceinput'],
  storm: ['debug', `quality=${QUALITY}`, 'stormdemo'],
};

async function main() {
  console.log(`Budget census — GL: ${describeGl()}`);
  const started = [];
  let browser;
  const rows = [];
  let tier = null;

  try {
    const hadClient = await isReady(`${URL}/`);
    const hadServer = await isReady(SERVER_HEALTH_URL);
    if (!hadClient) { const c = startNpmScript('dev:client'); started.push(c); await waitForReady(`${URL}/`, c); }
    if (!hadServer) { const s = startNpmScript('dev:server'); started.push(s); await waitForReady(SERVER_HEALTH_URL, s); }

    browser = await chromium.launch({ args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio']) });

    // ONE PAGE AT A TIME. A session's page is closed before the next opens: two
    // live rAF loops on a fanless CPU rasteriser is exactly the concurrency this
    // repo's crash history is made of, and it would also make both sets of
    // numbers a measurement of the other page.
    const sessions = [...new Set(activeScenes.map((s) => s.session))];
    for (const session of sessions) {
      const params = sessionQuery(SESSION_PARAMS[session]);
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 300)}`));
      page.on('console', (m) => { if (m.type() === 'error') console.error(`  [console] ${m.text().slice(0, 300)}`); });
      try {
        await page.goto(`${URL}/?${params}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
        await page.click('#menu-solo-btn', { noWaitAfter: true });
        await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
        await page.waitForTimeout(12_000); // streamed island / sea-rock build queues

        if (!tier) {
          tier = await page.evaluate(READ_CLIENT_TIER);
          // …and what the DETECTOR would have said with nothing pinning it. The
          // session above passes ?quality= on purpose (a budget graded at
          // whatever tier the runner earns is not a budget), which is exactly
          // why the tier it reports says nothing about auto-detection. Asking
          // the module directly is the only reading that does.
          tier.auto = await page.evaluate(READ_AUTO_TIER).catch(() => null);
          console.log('\n  client tier (as measured, PINNED by the session URL):');
          console.log(`    quality=${tier.quality}  devicePixelRatio=${tier.devicePixelRatio}  running dPR=${tier.rendererPixelRatio}`);
          console.log(`    min/max dPR=${tier.minPixelRatio}/${tier.maxPixelRatio}  shadows=${tier.shadowsEnabled}`);
          console.log(`    cores=${tier.hardwareConcurrency} deviceMemory=${tier.deviceMemory} cssPixels=${tier.cssPixels} fragments/frame=${tier.fragments}`);
          if (tier.auto) {
            console.log('  auto tier (what a PLAYER opening this build on this machine gets):');
            console.log(`    quality=${tier.auto.quality}  because=${tier.auto.reason}  gpu=${tier.auto.rendererString ?? '(masked)'}`);
            console.log(`    air-class=${tier.auto.airClass}  stored=${tier.auto.storedPreference}  auditionCeiling=${tier.auto.auditionCeiling ?? 'none'}`);
          }
        }

        await page.evaluate(() => window.__piratesBR.setBotPeace(true));
        const plan = planScenes(await readWorld(page));
        const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
        if (waterfall) {
          plan['waterfall-deck'] = planWaterfallDeck(waterfall);
          if (session === 'main') console.log(`    waterfall island: ${waterfall.name}\n`);
        }

        for (const scene of activeScenes.filter((s) => s.session === session)) {
          if (!plan[scene.id]) { console.log(`  ${scene.id}: (no placement)`); continue; }
          await page.evaluate(PIN_PIXEL_RATIO);
          const r = await measureScene(page, plan[scene.id], { warmupMs: WARMUP_MS, captureMs: CAPTURE_MS, settle: true });
          const sources = await page.evaluate(TALLY_DRAW_SOURCES).catch(() => []);
          const row = {
            sources: sources.slice(0, 14),
            scene: scene.id,
            label: scene.label,
            draws: Math.round(r.draws),
            peakDraws: r.peakDraws,
            tris: Math.round(r.tris),
            programs: r.programs,
            geometries: r.geometries,
            textures: r.textures,
            frames: r.frames,
            medianMs: r.medianMs,
            pixelRatio: r.pixelRatio,
          };
          rows.push(row);
          console.log(
            `  ${scene.id.padEnd(17)} draws ${String(row.draws).padStart(5)} (peak ${String(row.peakDraws).padStart(5)})  `
            + `tris ${String(Math.round(row.tris / 1000)).padStart(5)}k  progs ${String(row.programs).padStart(3)}  `
            + `geos ${String(row.geometries).padStart(5)}  texs ${String(row.textures).padStart(4)}  `
            + `[${row.frames} frames, med ${row.medianMs.toFixed(0)}ms${IS_SOFTWARE_GL ? ' ADVISORY' : ''}]`,
          );
          if (row.sources.length > 0) {
            console.log(`      by source: ${row.sources.slice(0, 9).map((s) => `${s.source}=${s.calls}`).join('  ')}`);
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    for (const c of started.reverse()) { stopChild(c); await sleep(900); try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* gone */ } }
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), label: LABEL, quality: QUALITY, gl: describeGl(), tier, rows }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
