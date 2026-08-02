#!/usr/bin/env node
// THE COST MODEL OF A FRAME — every scene, both tiers, one pinned map.
//
// perf-census.mjs answers "what does each view cost in draws". This answers the
// question a governor actually needs: WHERE DOES THE FRAME GO. Per scene it
// reports the pass split (shadow map / main pass / post chain, separately), the
// resident bytes behind the counts, and — the reading nothing in this repo has
// ever taken — the DEPTH COMPLEXITY of the frame, counted in the stencil buffer
// by the rasteriser, whole-frame and blended-layers-only, attributed to the
// content wave that paid for it.
//
// Why overdraw and not more draw calls. A fanless integrated GPU is not short of
// draw-call submission; it is short of fill rate and bandwidth. A scene at 1,100
// draws that shades every pixel eleven times is slower than one at 3,000 draws
// that shades each pixel twice, and no counter in this repo could tell those two
// apart. See lib/cost-model-probes.mjs for how the count is taken without
// swapping a single material.
//
// IT MEASURES, IT NEVER GRADES. There are no ceilings here on purpose: this is
// the survey the governor and the fixes get built on top of, and a survey that
// fails is a survey nobody reruns.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-cost-model.mjs --quality high --out /tmp/cost-high.json
//
// It never starts or stops a server. Stand one up yourself on a port that is not
// :8090 with PIRATES_BR_MAP_SEED pinned, so a run cannot evict a live match — and
// so the world is the same world every time (unpinned, the same build reads 1165,
// 1581 and 2742 draws at the SAME scene).
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
const OUT = arg('out', null);
const MAX_LAYERS = parseInt(arg('layers', '24'), 10);
const VIEWPORT = { width: 960, height: 540 };
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
const WARMUP_MS = parseInt(arg('warmup', '2000'), 10);
const CAPTURE_MS = parseInt(arg('capture', '2500'), 10);

/** Scenes whose blended layers get a PER-SOURCE stencil census. Each source
 *  costs a whole extra scene render, which on a CPU rasteriser is seconds, so
 *  they are spent on the views where the answer changes a decision. */
const ATTRIBUTE_SCENES = (arg('attribute', 'worst-case,storm-sea,waterfall-deck,dock-vista') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ATTRIBUTED_SOURCES = parseInt(arg('maxsources', '8'), 10);
/** Name the sources to attribute instead of letting the projected-area ranking
 *  choose. The ranking is an upper BOUND, and a bound is exactly wrong about the
 *  two shapes that matter most here: a camera-facing disc whose box straddles
 *  the near plane scores a full screen and shades nothing, while a mist cloud of
 *  seven hundred points projects to almost nothing and shades a quarter of the
 *  view. When the answer is already known, say it. */
/** Run ONLY the sky-occlusion reading (see SKY_OCCLUSION): what fraction of the
 *  dome's unconditional full-screen shade the player can actually see. Cheap
 *  enough to take on every scene, and it is the single largest fill item in the
 *  model, so it gets its own pass rather than riding a thirty-minute battery. */
const SKY_ONLY = argv.includes('--only-sky');
const FORCED_SOURCES = arg('sources', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

const SCENES = [
  { id: 'dock-vista', session: 'main', label: 'wide island vista' },
  { id: 'deck-aft', session: 'main', label: 'on-deck aft look (sailing)' },
  { id: 'island-interior', session: 'main', label: 'island interior, eye level' },
  { id: 'cave-interior', session: 'main', label: 'cave interior' },
  { id: 'waterfall-deck', session: 'main', label: 'deck view of a waterfall island' },
  { id: 'open-sea', session: 'main', label: 'open water' },
  { id: 'combat-burst', session: 'combat', label: 'combat burst (cannon + keg FX)' },
  { id: 'storm-sea', session: 'storm', label: 'storm at sea' },
  // THE WORST CASE, built rather than found: the storm session's rain and cloud
  // deck, standing off the one island that has a waterfall on it, with the
  // combat FX burst firing. Every blended layer the game owns in one frustum.
  { id: 'worst-case', session: 'storm', label: 'WORST CASE: storm + waterfall island + combat FX' },
];

const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const active = SCENES.filter((s) => !SCENE_FILTER || SCENE_FILTER.includes(s.id));

const SESSION_PARAMS = {
  main: ['debug', `quality=${QUALITY}`],
  combat: ['debug', `quality=${QUALITY}`, 'forceinput'],
  storm: ['debug', `quality=${QUALITY}`, 'stormdemo'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Emit the scripted combat burst around the camera, in the SAME task as the
 *  census that follows it. Particles are advanced by the game loop, and a
 *  stencil census on a CPU rasteriser blocks the loop for seconds — so a burst
 *  fired from its own evaluate would be a dead cloud by the time it is counted. */
const FX_BURST = `
async function fxBurst(rounds) {
  const g = window.__piratesBR;
  const fx = g.combatFx;
  const cam = g.renderer.camera;
  cam.updateMatrixWorld();
  // -Z column of the camera's world matrix IS its forward, already unit length
  // for a rotation basis — read it rather than borrowing getWorldDirection,
  // which wants a real Vector3 with .floor()/.normalize() on it.
  const e = cam.matrixWorld.elements;
  const fwd = { x: -e[8], y: -e[9], z: -e[10] };
  const base = { x: cam.position.x + fwd.x * 14, y: cam.position.y + fwd.y * 14 - 1.5, z: cam.position.z + fwd.z * 14 };
  for (let r = 0; r < rounds; r++) {
    const a = r * 1.3;
    const p = { x: base.x + Math.cos(a) * 7, y: base.y + (r % 3), z: base.z + Math.sin(a) * 7 };
    try { fx.emitKegExplosion(p, cam.position); } catch {}
    for (let k = 0; k < 4; k++) {
      const q = { x: p.x + (k - 2) * 1.6, y: p.y + 0.6 + k * 0.4, z: p.z + (k - 2) * 1.1 };
      try { fx.emitImpact('cannonball', q, cam.position); } catch {}
      try { fx.emitWoodChips(q); } catch {}
      try { fx.emitTrail(q, 0x9fd0ff); } catch {}
    }
  }
  return true;
}
`;

async function installProbes(page) {
  await page.evaluate((src) => { (0, eval)(src); }, `${COST_PRELUDE}\n${FX_BURST}\nwindow.__cost.fxBurst = fxBurst;`);
  const three = await page.evaluate(() => window.__cost.loadThree());
  if (!three) throw new Error('could not load a THREE namespace into the page');
  return three;
}

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port:\n`
      + '  PORT=8091 PIRATES_BR_MAP_SEED=20260801 npx tsx src/server/index.ts');
    process.exit(2);
  }
  console.log(`Frame cost model — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  if (h.mapSeed == null) console.log('  ! the server is on an UNPINNED map: these numbers describe one roll of the world, not the world.');

  // The client server this run measures against. If the developer already has
  // one up it is used and never touched; otherwise the runner starts its OWN and
  // owns its lifetime, because a Vite borrowed from a shell has twice now exited
  // in the middle of a half-hour survey.
  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs([
      '--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio',
      '--js-flags=--expose-gc', '--enable-precise-memory-info',
    ]),
  });

  const rows = [];
  const failures = [];
  let tierMeta = null;
  try {
    const sessions = [...new Set(active.map((s) => s.session))];
    for (const session of sessions) {
      const params = sessionQuery(SESSION_PARAMS[session]);
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page.setDefaultTimeout(0);
      page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 240)}`));
      try {
        console.log(`\n── session ${session} ──`);
        await page.goto(`${URL}/?${params}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
        await page.click('#menu-solo-btn', { noWaitAfter: true });
        await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate(() => window.__piratesBR.setBotPeace(true));

        const where = await installProbes(page);
        console.log(`  probes installed (three from ${where})`);

        const world = await readWorld(page);
        const plan = planScenes(world);
        const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
        if (waterfall) {
          plan['waterfall-deck'] = planWaterfallDeck(waterfall);
          plan['worst-case'] = { ...planWaterfallDeck(waterfall), fx: true };
        }
        if (!tierMeta) {
          tierMeta = await page.evaluate(() => {
            const r = window.__piratesBR.renderer;
            return {
              quality: r.getQuality(), shadows: r.areShadowsEnabled(),
              minPixelRatio: r.minPixelRatio, maxPixelRatio: r.maxPixelRatio,
              effectScale: r.getEffectScale?.() ?? null,
              devicePixelRatio: window.devicePixelRatio,
              cores: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
              islands: window.__piratesBR.state.islands.length,
              ships: window.__piratesBR.state.ships.length,
              players: window.__piratesBR.state.players.length,
            };
          });
          console.log(`  tier=${tierMeta.quality} shadows=${tierMeta.shadows} islands=${tierMeta.islands} ships=${tierMeta.ships} players=${tierMeta.players}`);
        }

        for (const scene of active.filter((s) => s.session === session)) {
          if (!plan[scene.id]) { console.log(`  ${scene.id}: (no placement in this world)`); continue; }
          const t0 = Date.now();
          await page.evaluate(PIN_PIXEL_RATIO);
          if (SKY_ONLY) {
            await measureScene(page, plan[scene.id], { warmupMs: 0, captureMs: 1, settle: true });
            const sky = await page.evaluate(() => window.__cost.skyOcclusion({}));
            rows.push({ scene: scene.id, label: scene.label, quality: QUALITY, sky, tookSec: Math.round((Date.now() - t0) / 100) / 10 });
            console.log(`  ${scene.id.padEnd(16)} sky as shipped covers ${(sky.shippedCoverage * 100).toFixed(1)}% of the frame; `
              + `depth-tested and drawn last it would cover ${(sky.depthTestedCoverage * 100).toFixed(1)}% `
              + `— ${(sky.wastedFraction * 100).toFixed(1)}% (${sky.wastedFragments} fragments) is shaded and thrown away  [${Math.round((Date.now() - t0) / 1000)}s]`);
            continue;
          }
          const counts = await measureScene(page, plan[scene.id], { warmupMs: WARMUP_MS, captureMs: CAPTURE_MS, settle: true });
          // Re-tag every scene: islands and their FX stream in, and a node that
          // arrived after the last tagging pass would report as anonymous.
          const tags = await page.evaluate(() => window.__cost.tagBuckets({}));
          const inventory = await page.evaluate(() => window.__cost.frameInventory());
          const passes = await page.evaluate(() => window.__cost.passSplit());
          const resources = await page.evaluate(() => window.__cost.resourceCensus());

          const wantsFx = !!plan[scene.id].fx;
          const overdrawAll = await page.evaluate(async ([layers, fx]) => {
            if (fx) await window.__cost.fxBurst(3);
            return window.__cost.stencilOverdraw({ maxLayers: layers });
          }, [MAX_LAYERS, wantsFx]);
          const overdrawBlended = await page.evaluate(async ([layers, fx]) => {
            if (fx) await window.__cost.fxBurst(3);
            return window.__cost.stencilOverdraw({ maxLayers: layers, blendedOnly: true });
          }, [MAX_LAYERS, wantsFx]);

          // Per-source blended attribution, on the scenes worth the renders.
          let bySource = [];
          if (ATTRIBUTE_SCENES.includes(scene.id)) {
            // Rank by projected coverage first — the analytic upper bound is a
            // good guide to which layer is worth a whole render — but never let
            // a source with real blended calls and a zero bound fall off the
            // list: a sparse particle cloud projects to nothing and can still
            // shade the screen four times over.
            const known = new Set(inventory.map((s) => s.source));
            const candidates = FORCED_SOURCES
              ? FORCED_SOURCES.filter((s) => known.has(s))
              : inventory
                .filter((s) => s.blendedCalls > 0)
                .sort((a, b) => (b.coverage * 1000 + b.blendedCalls) - (a.coverage * 1000 + a.blendedCalls))
                .slice(0, MAX_ATTRIBUTED_SOURCES)
                .map((s) => s.source);
            for (const source of candidates) {
              const r = await page.evaluate(async ([layers, fx, only]) => {
                if (fx) await window.__cost.fxBurst(3);
                return window.__cost.stencilOverdraw({ maxLayers: layers, blendedOnly: true, only });
              }, [MAX_LAYERS, wantsFx, source]);
              bySource.push({
                source,
                meanAll: r.meanAll,
                coveredFraction: r.coveredFraction,
                p95: r.p95,
                max: r.max,
                layerSum: r.layerSum,
              });
              console.log(`      overdraw[${source}] mean ${r.meanAll.toFixed(3)} covers ${(r.coveredFraction * 100).toFixed(1)}% p95 ${r.p95}`);
            }
            bySource.sort((a, b) => b.meanAll - a.meanAll);
          }

          const row = {
            scene: scene.id, label: scene.label, quality: QUALITY,
            counts: {
              draws: Math.round(counts.draws), peakDraws: counts.peakDraws,
              tris: Math.round(counts.tris), programs: counts.programs,
              geometries: counts.geometries, textures: counts.textures,
              frames: counts.frames, medianMs: counts.medianMs, p95Ms: counts.p95Ms, maxMs: counts.maxMs,
              pixelRatio: counts.pixelRatio,
            },
            passes,
            resources,
            tags,
            // Everything that draws more than a couple of calls, plus every
            // blended source however small — a rain layer is two draws and half
            // the fill, and a table sorted by draw calls would never show it.
            inventory: inventory.filter((s) => s.calls >= 3 || s.blendedCalls > 0 || s.tris > 5000).slice(0, 45),
            overdraw: { all: overdrawAll, blended: overdrawBlended, bySource },
            tookSec: Math.round((Date.now() - t0) / 100) / 10,
          };
          rows.push(row);
          console.log(
            `  ${scene.id.padEnd(16)} draws ${String(row.counts.draws).padStart(5)}  tris ${String(Math.round(row.counts.tris / 1000)).padStart(5)}k  `
            + `progs ${String(row.counts.programs).padStart(3)}  `
            + `shadow ${String(passes.shadow.calls).padStart(4)}d/${String(Math.round(passes.shadow.tris / 1000)).padStart(4)}kt  `
            + `post ${String(passes.post.calls).padStart(3)}d  `
            + `overdraw ${overdrawAll.meanAll.toFixed(2)} (blended ${overdrawBlended.meanAll.toFixed(2)}, p95 ${overdrawAll.p95}, max ${overdrawAll.max})  `
            + `[${row.tookSec}s]`,
          );
        }
      } catch (error) {
        // A SESSION THAT DIED MUST NOT TAKE THE HOURS BEFORE IT.
        // Six scenes of this survey are twenty-five minutes of a fanless
        // machine's afternoon, and the first version of this rig threw the lot
        // away when the third session could not reach a dev server that had
        // exited. Record what broke and write what was already measured.
        console.error(`  ✗ session ${session} failed: ${String(error?.message ?? error).slice(0, 300)}`);
        failures.push({ session, error: String(error?.message ?? error).slice(0, 500) });
      } finally {
        await page.close().catch(() => {});
        await sleep(500);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    stopDevClient(client);
  }

  const report = {
    at: new Date().toISOString(), quality: QUALITY, gl: describeGl(),
    softwareGl: IS_SOFTWARE_GL, viewport: VIEWPORT, mapSeed: h.mapSeed, tier: tierMeta, rows, failures,
  };
  if (failures.length) process.exitCode = 1;
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
