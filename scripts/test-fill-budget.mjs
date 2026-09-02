#!/usr/bin/env node
// FILL / OVERDRAW BUDGET — the stencil census as a gate, at the low tier.
//
// WHY. The two largest fill wins in this repo's history are a boolean and a
// comparator: the sky dome drawn depth-tested at the far plane (Renderer.ts
// `depthTest: true`, renderOrder 100, gl_Position.z = w) and the opaque
// front-to-back sort (setOpaqueSort). Flipping either back changes ZERO draws
// and ZERO triangles, so test-perf-budget cannot see it, and the census that
// would (scripts/tools/perf-cost-model.mjs) is a probe nobody runs in npm test
// (perf-08). This runs that census on three pinned placements and grades it.
//
// WHAT. One solo session at ?quality=low on the pinned map (seed 20260801),
// 960x540, pixel ratio pinned to 1. For dock-vista, deck-aft and open-sea:
//   • sky layers  (stencil census restricted to renderer.skyMesh) ≤ 0.55
//                 — measured 0.40-0.49 after the pass, 1.000 before it;
//   • whole-frame mean layers ≤ 1.9 (dock-vista, open-sea) / ≤ 2.2 (deck-aft)
//                 — measured 1.34 / 1.35 / 1.75 at low, bot hulls drift ±15%;
//   • blended layers ≤ 0.9 outside a storm — measured 0.43-0.79.
// Counts, not timing: the census is exact on SwiftShader, which is the backend
// the runner uses on this machine.
//
// --mutate (or PIRATES_BR_MUTATE_SKY=1) sets skyMesh.material.depthTest=false
// and renderOrder -1 before the census: sky layers read 1.000 and this gate
// must FAIL. That is its proof it can.
//
//   node scripts/test-fill-budget.mjs            (needs PIRATES_BR_URL + server)
//   node scripts/run-all-tests.mjs --only fill-budget
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { planScenes, readWorld, measureScene, sessionQuery, SERVER_PORT, PIN_PIXEL_RATIO } from './perf-probe.mjs';
import { COST_PRELUDE } from './lib/cost-model-prelude.mjs';

const URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const MUTATE = process.argv.includes('--mutate') || process.env.PIRATES_BR_MUTATE_SKY === '1';
const VIEWPORT = { width: 960, height: 540 };
const MAX_LAYERS = 24;
const QUALITY = 'low';

const BUDGET = {
  'dock-vista': { sky: 0.55, whole: 1.9, blended: 0.9 },
  'deck-aft': { sky: 0.55, whole: 2.2, blended: 0.9 },
  'open-sea': { sky: 0.55, whole: 1.9, blended: 0.9 },
};

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

async function health() {
  const port = SERVER_PORT ?? '8091';
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}

async function main() {
  const h = await health();
  if (!h) { console.error(`  ✗ FAIL: no game server on :${SERVER_PORT ?? '8091'} (run through scripts/run-all-tests.mjs --only fill-budget)`); process.exit(1); }
  console.log(`Fill budget — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}${MUTATE ? '  [MUTATED: sky depthTest=false]' : ''}`);
  if (h.mapSeed == null) console.log('  ! unpinned map: the ceilings were measured on seed 20260801');

  const browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit']) });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace?.(true));
    await page.evaluate((src) => { (0, eval)(src); }, COST_PRELUDE);
    const three = await page.evaluate(() => window.__cost.loadThree());
    if (!three) throw new Error('could not load THREE into the page');
    await page.evaluate(() => window.__cost.tagBuckets({}));
    const skyKey = await page.evaluate(() => {
      const sky = window.__piratesBR.renderer.skyMesh;
      return sky?.userData?.__costBucket ?? null;
    });
    expect(`renderer.skyMesh reachable and tagged (${skyKey})`, !!skyKey);
    if (MUTATE) {
      await page.evaluate(() => {
        const sky = window.__piratesBR.renderer.skyMesh;
        sky.material.depthTest = false; sky.renderOrder = -1;
      });
      console.log('  ! mutation applied: skyMesh depthTest=false, renderOrder=-1');
    }
    const tier = await page.evaluate(() => window.__piratesBR.renderer.getQuality());
    expect(`session runs at quality=${QUALITY} (got ${tier})`, tier === QUALITY);

    const plan = planScenes(await readWorld(page));
    for (const [scene, budget] of Object.entries(BUDGET)) {
      if (!plan[scene]) { expect(`${scene}: placement exists in this world`, false); continue; }
      await page.evaluate(PIN_PIXEL_RATIO);
      await measureScene(page, plan[scene], { warmupMs: 1200, captureMs: 400, settle: true });
      const whole = await page.evaluate((l) => window.__cost.stencilOverdraw({ maxLayers: l }), MAX_LAYERS);
      const blended = await page.evaluate((l) => window.__cost.stencilOverdraw({ maxLayers: l, blendedOnly: true }), MAX_LAYERS);
      const sky = skyKey ? await page.evaluate(([l, k]) => window.__cost.stencilOverdraw({ maxLayers: l, only: k }), [MAX_LAYERS, skyKey]) : null;
      console.log(`  [${scene}] whole ${whole.meanAll.toFixed(3)} layers (p95 ${whole.p95}, ${whole.sceneDraws} draws)  blended ${blended.meanAll.toFixed(3)}  sky ${sky ? sky.meanAll.toFixed(3) : 'n/a'} over ${sky ? (sky.coveredFraction * 100).toFixed(1) : '?'}% of the frame`);
      expect(`${scene}: sky layers ${sky ? sky.meanAll.toFixed(3) : 'n/a'} ≤ ${budget.sky}`, !!sky && sky.meanAll <= budget.sky,
        'the dome is being shaded on pixels the world paints over (depthTest off / drawn first)');
      expect(`${scene}: whole-frame mean ${whole.meanAll.toFixed(3)} ≤ ${budget.whole}`, whole.meanAll <= budget.whole);
      expect(`${scene}: blended mean ${blended.meanAll.toFixed(3)} ≤ ${budget.blended}`, blended.meanAll <= budget.blended);
    }
    expect('no page errors', errors.length === 0, errors.join(' | '));
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
  if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(`  ✗ FAIL: ${e?.stack ?? e}`); process.exit(1); });
