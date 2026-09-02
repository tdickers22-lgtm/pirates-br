#!/usr/bin/env node
// WHICH KNOB BUYS THE MOST, PER UNIT OF VISUAL LOSS.
//
// A governor has four things it can turn: resolution, tier, how much world is in
// frame, and how many entities are in it. This measures the slope of each one so
// the choice between them is arithmetic instead of taste.
//
//  1. PIXEL RATIO. The only sweep on this list whose answer is a TIME, and the
//     one place a software rasteriser is a good instrument rather than a bad
//     one: SwiftShader is fill-bound in exactly the way the fanless GPU this
//     game targets is fill-bound, so ms-per-megafragment measured here has real
//     shape. The absolute ms does not transfer; the exponent does, and so does
//     the ratio between two ratios on the same machine.
//
//  2. ISLANDS AND ENTITIES IN FRAME. Counted, not timed, and therefore exact:
//     draw calls and triangles are decided by the scene graph and the frustum.
//     A 36-step yaw sweep from three stands gives enough samples to fit a slope
//     to each regressor instead of quoting the difference between two views.
//
//  3. TIER. Read out of the two perf-cost-model.mjs runs; nothing extra to do
//     here, and doing it here would measure it with a different instrument.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-scaling.mjs --quality high --out /tmp/scaling-high.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { planScenes, readWorld, sessionQuery, SERVER_PORT } from '../perf-probe.mjs';
import { FIND_WATERFALL_ISLAND, planWaterfallDeck } from '../lib/perf-scenes.mjs';
import { COST_PRELUDE } from '../lib/cost-model-prelude.mjs';
import { ensureDevClient, stopDevClient } from '../lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', null);
const RATIOS = (arg('ratios', '0.75,1,1.25,1.5')).split(',').map(Number);
const YAW_STEPS = parseInt(arg('yawsteps', '36'), 10);
const VIEWPORT = { width: 960, height: 540 };

/** Least squares for y = c0 + c1 x1 + … , by normal equations. Small enough that
 *  a dependency would cost more than it saves. */
function fit(rows, xKeys, yKey) {
  const n = xKeys.length + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const r of rows) {
    const x = [1, ...xKeys.map((k) => r[k])];
    const y = r[yKey];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j];
      b[i] += x[i] * y;
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += 1e-6; // ridge: yaw sweeps produce collinear columns
  // Gaussian elimination with partial pivoting.
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) continue;
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const c = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * c[j];
    c[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : s / A[i][i];
  }
  // R^2 so a coefficient nobody should trust says so.
  const ybar = rows.reduce((s, r) => s + r[yKey], 0) / rows.length;
  let ssTot = 0, ssRes = 0;
  for (const r of rows) {
    const pred = c[0] + xKeys.reduce((s, k, i) => s + c[i + 1] * r[k], 0);
    ssRes += (r[yKey] - pred) ** 2;
    ssTot += (r[yKey] - ybar) ** 2;
  }
  return {
    intercept: c[0],
    coefficients: Object.fromEntries(xKeys.map((k, i) => [k, c[i + 1]])),
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    samples: rows.length,
  };
}

async function main() {
  const port = SERVER_PORT ?? '8090';
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!h) { console.error(`no game server on :${port}`); process.exit(2); }
  console.log(`Scaling laws — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);

  // The client server this run measures against. If the developer already has
  // one up it is used and never touched; otherwise the runner starts its OWN and
  // owns its lifetime, because a Vite borrowed from a shell has twice now exited
  // in the middle of a half-hour survey.
  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio']),
  });
  const report = { at: new Date().toISOString(), quality: QUALITY, gl: describeGl(), mapSeed: h.mapSeed };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  try {
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`, 'stormdemo'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate((src) => { (0, eval)(src); }, COST_PRELUDE);
    await page.evaluate(() => window.__cost.loadThree());
    await page.evaluate(() => window.__cost.tagBuckets({}));

    const world = await readWorld(page);
    const plan = planScenes(world);
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) plan['worst-case'] = planWaterfallDeck(waterfall);

    // ── 1. pixel ratio ───────────────────────────────────────────────────
    console.log('\n── pixel ratio sweep ──');
    const ratioRows = [];
    for (const sceneId of ['dock-vista', 'worst-case']) {
      const cam = plan[sceneId];
      if (!cam) continue;
      for (const ratio of RATIOS) {
        const r = await page.evaluate(async ([c, rat]) => {
          const g = window.__piratesBR;
          let yaw = c.yaw;
          if (c.aimAt) yaw = Math.atan2(c.aimAt.x - c.x, c.aimAt.z - c.z);
          const y = c.y ?? (g.sampleGroundY(c.x, c.z) + (c.groundOffset ?? 1.7));
          g.enableFreeCam(c.x, y, c.z, yaw, c.pitch ?? -0.05);
          g.setDayNightOverride(854);
          g.settleLod(2);
          window.__cost.pinRatio(rat);
          return window.__cost.timeFrames({ warmFrames: 2, frames: 4 });
        }, [cam, ratio]);
        ratioRows.push({ scene: sceneId, ratio, ...r });
        console.log(`  ${sceneId.padEnd(12)} ratio ${String(ratio).padStart(5)}  ${r.drawingBuffer.join('x').padStart(11)}  ${(r.fragments / 1e6).toFixed(2)}Mfrag  median ${r.medianMs.toFixed(0)}ms  draws ${Math.round(r.draws)}`);
      }
    }
    // Fit ms = a * fragments^k per scene: the exponent says whether the frame is
    // fill-bound (k -> 1) or bound by work that does not care about resolution
    // (k -> 0).
    const ratioFits = {};
    for (const sceneId of [...new Set(ratioRows.map((r) => r.scene))]) {
      const rows = ratioRows.filter((r) => r.scene === sceneId && r.medianMs > 0 && r.fragments > 0)
        .map((r) => ({ lx: Math.log(r.fragments), ly: Math.log(r.medianMs) }));
      if (rows.length < 2) continue;
      const f = fit(rows, ['lx'], 'ly');
      const base = ratioRows.find((r) => r.scene === sceneId && r.ratio === 1);
      ratioFits[sceneId] = {
        exponent: f.coefficients.lx,
        r2: f.r2,
        msAtRatio1: base?.medianMs ?? null,
        fragmentsAtRatio1: base?.fragments ?? null,
        msPerMegafragment: base ? base.medianMs / (base.fragments / 1e6) : null,
        table: ratioRows.filter((r) => r.scene === sceneId)
          .map((r) => ({ ratio: r.ratio, fragments: r.fragments, medianMs: r.medianMs, relToRatio1: base ? r.medianMs / base.medianMs : null })),
      };
      console.log(`  fit ${sceneId}: ms ∝ fragments^${f.coefficients.lx.toFixed(2)} (R²=${f.r2.toFixed(3)})`);
    }
    report.pixelRatio = { rows: ratioRows, fits: ratioFits };

    // ── 2. islands / entities in frame ───────────────────────────────────
    console.log('\n── yaw sweep (islands and entities in frame) ──');
    const stands = [];
    const dock = plan['dock-vista'];
    if (dock) stands.push({ name: 'offshore-of-dock-island', x: dock.x, y: dock.y, z: dock.z });
    stands.push({ name: 'open-water', x: 980, y: 8, z: 960 });
    if (world.ship) stands.push({ name: 'on-own-deck', x: world.ship.x, y: world.ship.y + 4.2, z: world.ship.z });
    const sweep = [];
    for (const stand of stands) {
      // Two laps: the first reveals, the second measures the steady state.
      for (let lap = 0; lap < 2; lap++) {
        for (let i = 0; i < YAW_STEPS; i++) {
          const yaw = (i / YAW_STEPS) * Math.PI * 2;
          const r = await page.evaluate(([s, y]) => window.__cost.frustumEntities({ x: s.x, y: s.y, z: s.z, yaw: y }), [stand, yaw]);
          if (lap === 1) sweep.push({ stand: stand.name, ...r });
        }
      }
      const mine = sweep.filter((s) => s.stand === stand.name);
      console.log(`  ${stand.name.padEnd(24)} draws ${Math.min(...mine.map((m) => m.calls))}–${Math.max(...mine.map((m) => m.calls))}  `
        + `tris ${Math.round(Math.min(...mine.map((m) => m.tris)) / 1000)}k–${Math.round(Math.max(...mine.map((m) => m.tris)) / 1000)}k  `
        + `islands in cone ${Math.min(...mine.map((m) => m.islandsInCone))}–${Math.max(...mine.map((m) => m.islandsInCone))}`);
    }
    report.yawSweep = {
      rows: sweep,
      fits: {
        callsAll: fit(sweep, ['islandsInCone', 'shipsInCone', 'playersInCone'], 'calls'),
        trisAll: fit(sweep, ['islandsInCone', 'shipsInCone', 'playersInCone'], 'tris'),
        callsPerIslandOnly: fit(sweep, ['islandsInCone'], 'calls'),
        trisPerIslandOnly: fit(sweep, ['islandsInCone'], 'tris'),
        callsPerShipOnly: fit(sweep, ['shipsInCone'], 'calls'),
        blendedPerIsland: fit(sweep, ['islandsInCone', 'shipsInCone'], 'blendedCalls'),
      },
    };
    for (const [k, v] of Object.entries(report.yawSweep.fits)) {
      console.log(`  ${k.padEnd(20)} intercept ${Math.round(v.intercept)}  ${Object.entries(v.coefficients).map(([a, b]) => `${a}=${b.toFixed(1)}`).join('  ')}  R²=${v.r2.toFixed(3)}`);
    }
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
