#!/usr/bin/env node
// WHICH SURFACE OF THE SHIP IS THE OPAQUE OVERDRAW — the part-level census.
//
// The cost model's lever 9 is the largest number it never attributed: standing
// on your own deck the frame carries 1.56 opaque layers at `high` and 1.97 at
// `low`, p95 6-7, with a fifth to a third of the framebuffer shaded four times
// or more. The bucket census answered it with the word "ship" (1.662 layers over
// 46% of the frame, ~87% of the opaque half), which names a boat and no fix.
//
// This goes one level finer, to the SURFACE. It reports, for one scene and one
// tier:
//
//   1. the whole-frame stencil census (the number being explained)
//   2. every part of the bucket WITHOUT rendering — draw calls, triangles, world
//      height band, and the three flags that make a surface cost twice what it
//      looks like: `side`, `depthWrite`, `renderOrder`
//   3. the exact stencil layers of the top parts, one scene render each
//   4. counterfactuals: what the frame would cost with the opaque DoubleSide
//      materials front-faced, and with a named part hidden
//
// (2) is free, (3) and (4) are seconds each on a CPU rasteriser, so the part
// list is ranked first and only the head of it is measured.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-deck-overdraw.mjs --quality low --scene deck-aft \
//       --out /tmp/deck-low.json
//
// It never starts or stops a game server. Pin PIRATES_BR_MAP_SEED on the one you
// stand up, or two runs measure two different worlds.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { FIND_WATERFALL_ISLAND, planWaterfallDeck } from './lib/perf-scenes.mjs';
import { COST_PRELUDE } from './lib/cost-model-prelude.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const SCENE = arg('scene', 'deck-aft');
const BUCKET = arg('bucket', 'ship');
const OUT = arg('out', null);
const MAX_LAYERS = parseInt(arg('layers', '16'), 10);
const TOP_PARTS = parseInt(arg('parts', '8'), 10);
const HIDE = arg('hide', null); // extra counterfactual: hide this exact part key
const NO_WHATIF = argv.includes('--no-whatif');
const VIEWPORT = { width: 960, height: 540 };
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);

const SESSION_OF = {
  'deck-aft': 'main', 'dock-vista': 'main', 'island-interior': 'main',
  'cave-interior': 'main', 'waterfall-deck': 'main', 'open-sea': 'main',
  'combat-burst': 'combat', 'storm-sea': 'storm', 'worst-case': 'storm',
};
const SESSION_PARAMS = {
  main: ['debug', `quality=${QUALITY}`],
  combat: ['debug', `quality=${QUALITY}`, 'forceinput'],
  storm: ['debug', `quality=${QUALITY}`, 'stormdemo'],
};

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port:\n`
      + '  PIRATES_BR_SERVER_PORT=8091 PORT=8091 PIRATES_BR_MAP_SEED=20260801 npx tsx src/server/index.ts');
    process.exit(2);
  }
  const session = SESSION_OF[SCENE] ?? 'main';
  console.log(`Part census — GL: ${describeGl()}  quality=${QUALITY}  scene=${SCENE}  bucket=${BUCKET}  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  if (h.mapSeed == null) console.log('  ! UNPINNED map: this describes one roll of the world, not the world.');

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio']),
  });

  const report = {
    at: new Date().toISOString(), quality: QUALITY, scene: SCENE, bucket: BUCKET,
    gl: describeGl(), softwareGl: IS_SOFTWARE_GL, viewport: VIEWPORT, mapSeed: h.mapSeed,
  };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 240)}`));
  try {
    await page.goto(`${URL}/?${sessionQuery(SESSION_PARAMS[session])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    await page.evaluate((src) => { (0, eval)(src); }, COST_PRELUDE);
    const three = await page.evaluate(() => window.__cost.loadThree());
    if (!three) throw new Error('could not load a THREE namespace into the page');

    const world = await readWorld(page);
    const plan = planScenes(world);
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) {
      plan['waterfall-deck'] = planWaterfallDeck(waterfall);
      plan['worst-case'] = planWaterfallDeck(waterfall);
    }
    if (!plan[SCENE]) throw new Error(`no placement for scene ${SCENE} in this world`);

    await page.evaluate(PIN_PIXEL_RATIO);
    await measureScene(page, plan[SCENE], { warmupMs: 1500, captureMs: 1200, settle: true });
    await page.evaluate(() => window.__cost.tagBuckets({}));

    // EVERY counting render re-anchors first, in its own task, immediately
    // before it renders. `measureScene` follows the hull for the length of its
    // capture window and then stops; each census after it is seconds of software
    // rasterisation during which the ship sails out from under a camera that no
    // longer follows. Unanchored, the same what-if read -0.552 layers and -0.098
    // on the same pinned seed, and the ship's own share of the framebuffer read
    // 35.4% and 57.6%. See ANCHOR_SHIP.
    const anchor = plan[SCENE].ship
      ? { dy: plan[SCENE].dy ?? 4.2, yawOffset: plan[SCENE].yawOffset ?? Math.PI, pitch: plan[SCENE].pitch ?? -0.05, dside: plan[SCENE].dside ?? 0 }
      : null;
    const census = (opts) => page.evaluate(async ([a, o]) => {
      if (a) window.__cost.anchorShip(a);
      return window.__cost.stencilOverdraw(o);
    }, [anchor, opts]);
    const counterfactual = (opts) => page.evaluate(async ([a, o]) => {
      if (a) window.__cost.anchorShip(a);
      return window.__cost.whatIf(o);
    }, [anchor, opts]);

    report.tier = await page.evaluate(() => {
      const r = window.__piratesBR.renderer;
      return { quality: r.getQuality(), shadows: r.areShadowsEnabled(), effectScale: r.getEffectScale?.() ?? null };
    });
    console.log(`  tier=${report.tier.quality} shadows=${report.tier.shadows} effectScale=${report.tier.effectScale}`);

    // ── 1. the number being explained ────────────────────────────────────────
    const all = await census({ maxLayers: MAX_LAYERS });
    const blended = await census({ maxLayers: MAX_LAYERS, blendedOnly: true });
    const bucketOnly = await census({ maxLayers: MAX_LAYERS, only: BUCKET });
    report.frame = { all, blended, bucketOnly };
    console.log(`\n  frame        mean ${all.meanAll.toFixed(3)}  p95 ${all.p95}  max ${all.max}`);
    console.log(`  blended      mean ${blended.meanAll.toFixed(3)}`);
    console.log(`  opaque       mean ${(all.meanAll - blended.meanAll).toFixed(3)}`);
    console.log(`  ${BUCKET.padEnd(12)} mean ${bucketOnly.meanAll.toFixed(3)} over ${pct(bucketOnly.coveredFraction)}  p95 ${bucketOnly.p95}  max ${bucketOnly.max}`);

    // ── 2. every surface, free ───────────────────────────────────────────────
    const parts = await page.evaluate(async ([a, b]) => {
      if (a) window.__cost.anchorShip(a);
      return window.__cost.bucketParts({ bucket: b, maxParts: 80 });
    }, [anchor, BUCKET]);
    report.parts = parts;
    console.log(`\n  ${parts.length} parts in "${BUCKET}"  (calls = in the graph, drawn = survived the frustum)`);
    console.log('     cover  drawn  calls     tris  side   dW dT  order      y-band  part');
    for (const p of parts.slice(0, 30)) {
      console.log(
        `    ${String(p.coverage.toFixed(3)).padStart(6)}  ${String(p.drawnCalls).padStart(5)}  ${String(p.calls).padStart(5)}  `
        + `${String(Math.round(p.tris / 100) / 10).padStart(7)}k  `
        + `${p.side.padEnd(6)} ${p.depthWrite ? ' Y' : ' n'} ${p.depthTest ? 'Y' : 'n'}  ${JSON.stringify(p.renderOrder).padEnd(9)} `
        + `${String(p.yMin ?? '-').padStart(6)}..${String(p.yMax ?? '-').padEnd(6)} ${p.part}`,
      );
    }
    const doubles = parts.filter((p) => p.side === 'double' && !p.blended);
    console.log(`\n  opaque DoubleSide parts: ${doubles.length} of ${parts.length}`
      + `  (${doubles.reduce((s, p) => s + p.drawnCalls, 0)} drawn calls, `
      + `${Math.round(doubles.reduce((s, p) => s + p.tris, 0) / 1000)}k tris)`);

    // ── 3. exact layers per part ─────────────────────────────────────────────
    const ranked = parts.filter((p) => p.drawnCalls > 0).slice(0, TOP_PARTS);
    const byPart = [];
    for (const p of ranked) {
      const r = await census({ maxLayers: MAX_LAYERS, only: p.part, keyBy: 'part' });
      byPart.push({ part: p.part, side: p.side, drawnCalls: p.drawnCalls, tris: p.tris,
        meanAll: r.meanAll, coveredFraction: r.coveredFraction, p95: r.p95, max: r.max, layerSum: r.layerSum });
      console.log(`    layers[${p.part}] mean ${r.meanAll.toFixed(3)} over ${pct(r.coveredFraction)} p95 ${r.p95} max ${r.max}`);
    }
    byPart.sort((a, b) => b.meanAll - a.meanAll);
    report.byPart = byPart;

    // ── 4. counterfactuals ───────────────────────────────────────────────────
    if (!NO_WHATIF) {
      const whatIf = [];
      const run = async (label, mutations) => {
        const r = await counterfactual({ maxLayers: MAX_LAYERS, mutations });
        whatIf.push({ label, mutations, touched: r.touched, meanAll: r.meanAll, base: r.base, deltaMean: r.deltaMean, p95: r.p95, max: r.max, coveredFraction: r.coveredFraction });
        console.log(`    what-if ${label.padEnd(34)} ${r.base.meanAll.toFixed(3)} -> ${r.meanAll.toFixed(3)}  `
          + `${(r.deltaMean >= 0 ? '+' : '') + r.deltaMean.toFixed(3)} layers   p95 ${r.base.p95}->${r.p95}  [${r.touched} touched]`);
      };
      console.log('');
      await run(`${BUCKET}: DoubleSide→FrontSide`, [{ op: 'frontside', bucket: BUCKET }]);
      await run(`${BUCKET}: hidden entirely`, [{ op: 'hideBucket', bucket: BUCKET }]);
      // PER SURFACE, because the bucket-wide answer is not a fix. Culling the
      // back faces of a closed shell is free; culling them off a sail is a sail
      // that vanishes when you look aft at it. The two cannot be told apart by
      // one number covering both, so each double-sided surface is priced alone.
      for (const p of doubles.filter((d) => d.drawnCalls > 0).slice(0, TOP_PARTS)) {
        await run(`frontside ${p.part}`, [{ op: 'frontside', part: p.part }]);
      }
      if (HIDE) await run(`hide ${HIDE}`, [{ op: 'hide', part: HIDE }]);
      report.whatIf = whatIf;
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
