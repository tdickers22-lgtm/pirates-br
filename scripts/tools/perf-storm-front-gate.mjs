#!/usr/bin/env node
// IS THERE A FREE GATE ON THE STORM FRONT? — the measurement, not the argument.
//
// The boundary's cloud bank is a 320 m DoubleSide cylinder of radius
// `storm.safeRadius`, transparent, `depthWrite:false`, `frustumCulled = false`,
// and it is UP IN ORDINARY PLAY: 0.266 stencil-counted layers at dock-vista and
// 0.432 at waterfall-deck, in weather nobody would call a storm. Two obvious
// gates get proposed for it every time somebody reads that number:
//
//   A. skip it when the bank is not in frame
//   B. skip it when the camera is far from the ring
//
// Both are arguments about VERTICES. The cost is FILL. So the question this
// answers is the only one that decides either: WHEN THE BANK IS NOT IN FRAME,
// WHAT DOES IT ALREADY COST? If the answer is zero layers, then every fragment
// it ever shades is a fragment that was on screen, an in-frame gate can only
// remove work that is already not being done, and the fill is the picture.
//
// Three readings per scene, each a paired stencil census taken in the same task:
//
//   1. `envFx.stormFront` layers as the scene stands            (the number)
//   2. …with the camera pitched straight down at the deck       (gate A's best case)
//   3. …with the whole front hidden                             (the ceiling on any gate)
//
// (3) is the upper bound on what ANY gate can ever be worth, free or not.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8092 PIRATES_BR_URL=http://127.0.0.1:3102 \
//     node scripts/perf-storm-front-gate.mjs --quality low --scenes dock-vista,waterfall-deck
//
// It never starts or stops a game server. Pin PIRATES_BR_MAP_SEED on the one you
// stand up, or two runs measure two different worlds.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from '../lib/browser-args.mjs';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, sessionQuery, SERVER_PORT } from '../perf-probe.mjs';
import { FIND_WATERFALL_ISLAND, planWaterfallDeck } from '../lib/perf-scenes.mjs';
import { COST_PRELUDE } from '../lib/cost-model-prelude.mjs';
import { ensureDevClient, stopDevClient } from '../lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const SCENES = (arg('scenes', 'dock-vista,waterfall-deck') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = arg('out', null);
const MAX_LAYERS = parseInt(arg('layers', '16'), 10);
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
const BUCKET = 'envFx.stormFront';
const VIEWPORT = { width: 960, height: 540 };

const pct = (v) => `${(v * 100).toFixed(1)}%`;

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Pitch the camera at the deck without moving it. The bank is a band around the
 *  horizon; looking at your own boots is the cheapest state in which "the bank
 *  is not in frame" is unambiguously true, and it is a pose a player reaches
 *  every time they look at what they are standing on. */
const LOOK_DOWN = () => {
  const cam = window.__piratesBR.renderer.camera;
  cam.rotation.order = 'YXZ';
  cam.rotation.x = -Math.PI / 2 + 0.12;
  cam.updateMatrixWorld(true);
};

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port.`);
    process.exit(2);
  }
  console.log(`Storm-front gate — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio']),
  });
  const report = {
    at: new Date().toISOString(), quality: QUALITY, gl: describeGl(), softwareGl: IS_SOFTWARE_GL,
    viewport: VIEWPORT, mapSeed: h.mapSeed, bucket: BUCKET, scenes: [],
  };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 240)}`));
  try {
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate((src) => { (0, eval)(src); }, COST_PRELUDE);
    if (!await page.evaluate(() => window.__cost.loadThree())) throw new Error('no THREE in page');

    const world = await readWorld(page);
    const plan = planScenes(world);
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) {
      plan['waterfall-deck'] = planWaterfallDeck(waterfall);
      plan['worst-case'] = planWaterfallDeck(waterfall);
    }
    await page.evaluate(PIN_PIXEL_RATIO);

    for (const scene of SCENES) {
      if (!plan[scene]) { console.log(`\n  ! no placement for ${scene} in this world — skipped`); continue; }
      console.log(`\n  ── ${scene} ──────────────────────────────────────────────`);
      await measureScene(page, plan[scene], { warmupMs: 1500, captureMs: 1200, settle: true });
      await page.evaluate(() => window.__cost.tagBuckets({}));

      // (1) the number. Paired: the bucket and the whole frame, same task.
      const facing = await page.evaluate(async ([b, m]) => {
        const part = await window.__cost.stencilOverdraw({ maxLayers: m, only: b });
        const frame = await window.__cost.stencilOverdraw({ maxLayers: m });
        return { part, frame, share: frame.meanAll > 0 ? part.meanAll / frame.meanAll : 0 };
      }, [BUCKET, MAX_LAYERS]);
      console.log(`    facing       front ${facing.part.meanAll.toFixed(3)} layers over ${pct(facing.part.coveredFraction)}`
        + `  (frame ${facing.frame.meanAll.toFixed(3)}, ${pct(facing.share)} of it)  p95 ${facing.part.p95} max ${facing.part.max}`);

      // (2) gate A's best case: the bank is definitively not in frame.
      const down = await page.evaluate(async ([b, m, lookDown]) => {
        (0, eval)(`(${lookDown})`)();
        const part = await window.__cost.stencilOverdraw({ maxLayers: m, only: b });
        const frame = await window.__cost.stencilOverdraw({ maxLayers: m });
        return { part, frame };
      }, [BUCKET, MAX_LAYERS, LOOK_DOWN.toString()]);
      console.log(`    looking down front ${down.part.meanAll.toFixed(3)} layers over ${pct(down.part.coveredFraction)}`
        + `  (frame ${down.frame.meanAll.toFixed(3)})`);

      // (3) the ceiling on any gate whatsoever, back in the facing pose.
      await measureScene(page, plan[scene], { warmupMs: 800, captureMs: 800, settle: true });
      const hidden = await page.evaluate(async ([b, m]) => window.__cost.whatIf({
        maxLayers: m, mutations: [{ op: 'hideBucket', bucket: b }],
      }), [BUCKET, MAX_LAYERS]);
      console.log(`    what-if hidden entirely  frame ${hidden.base.meanAll.toFixed(3)} -> ${hidden.meanAll.toFixed(3)}  `
        + `${(hidden.deltaMean >= 0 ? '+' : '') + hidden.deltaMean.toFixed(3)} layers  p95 ${hidden.base.p95}->${hidden.p95}  [${hidden.touched} touched]`);

      report.scenes.push({
        scene,
        facing: { meanAll: facing.part.meanAll, coveredFraction: facing.part.coveredFraction, p95: facing.part.p95, max: facing.part.max, frameMean: facing.frame.meanAll, share: facing.share },
        lookingDown: { meanAll: down.part.meanAll, coveredFraction: down.part.coveredFraction, frameMean: down.frame.meanAll },
        hidden: { base: hidden.base, meanAll: hidden.meanAll, deltaMean: hidden.deltaMean, touched: hidden.touched },
      });
    }
  } catch (error) {
    console.error(`  ✗ ${String(error?.stack ?? error).slice(0, 800)}`);
    report.error = String(error?.message ?? error).slice(0, 500);
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    stopDevClient(client);
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
