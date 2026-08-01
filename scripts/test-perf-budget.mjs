#!/usr/bin/env node
// Draw-call and triangle budget guard.
//
// Draw calls are the one renderer cost that creeps silently: every new prop
// type, every un-merged decoration, every light that stops being culled adds a
// few, nothing looks slower on the machine that added them, and six months
// later the wide shots cost twice what they did. This pins the views where that
// creep shows to ceilings a modest margin above what they measure today.
//
// WHY THIS RUNS ON THE SOFTWARE RASTERISER TOO.
//
// It used to `return` the moment it saw SwiftShader, on the reasoning that "the
// numbers are meaningless". Half of that was right and it threw the other half
// away. Frame TIMES on a CPU rasteriser are meaningless. Draw calls, triangles,
// programs and renderer.info.memory are not: they come out of three's own
// bookkeeping, decided by the scene graph, the frustum and the LOD gates, none
// of which know which GL backend is underneath. So this suite exits 0 in zero
// seconds on the only machine the game is built on — and a whole week of content
// (a 96x48 sky dome, terrain macro-noise and cave-cutout octaves, waterfall
// sheets, ~3,545 scattered props, grass, storm cloud deck) shipped against a
// tripwire that was never armed. The wide vista had drifted from 2206 draws to
// 2588 and the cave view to 4517 with nothing to say so.
//
// Now the COUNTS are graded on every backend, and only the timing report is
// gated to the GPU path. Choose the backend with PIRATES_GL (see
// lib/browser-args.mjs); the assertions are identical either way.
//
// WHY IT SETTLES BEFORE COUNTING. The LOD reveal and the shared first-draw
// allowance are paced per FRAME, so at a rasteriser's two-to-seven seconds a
// frame a fixed wall-clock warmup measures how much of the world has ARRIVED,
// not what the view costs. Counts taken that way read 687 draws at a dock vista
// that settles at 2057 — a lie in the cheap direction, which is the direction a
// budget must never be wrong in. measureScene's `settle` flag drives the world
// to its steady state first.
//
// WHY TWO TIERS. 'high' is the ceiling nobody should quietly raise. 'low' is
// what the fanless machines actually get after the tier detector landed, and a
// 'low' that is not markedly cheaper than 'high' is a bug that no single-tier
// gate can see.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene } from './perf-probe.mjs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import {
  FIND_WATERFALL_ISLAND, planWaterfallDeck, planWreckScene, TALLY_DRAW_SOURCES,
} from './lib/perf-scenes.mjs';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? 'http://127.0.0.1:8090/health';
const READY_TIMEOUT_MS = 45_000;
const VIEWPORT = { width: 960, height: 540 };

// A 16:9 viewport of any size produces the same frustum, so counts at 960x540
// are counts at 1600x900 — and the smaller one is kinder to the machine.

/**
 * THE TRIPWIRES.
 *
 * `measured` is what the scene read on the count-grading rig after the distant-
 * dressing diet landed (2026-08, SwiftShader, quality pinned, pixel ratio 1).
 * `draws`/`tris` are ceilings a modest margin above that — roughly 1.12x, not
 * the 1.3x the July table used, because a 30% allowance is a whole content wave
 * of silent drift.
 *
 * RAISING A NUMBER HERE IS A DECISION, NOT A FIX. If a change is worth the
 * draws, say so in the commit that raises it; if it is not, the change is what
 * needs adjusting. Widening the ceiling to fit a regression is how the July
 * table came to be 30% above a reality nobody had measured in a month.
 */
const BUDGETS = {
  high: [
    // draws: 2588 -> 1671 across the diet;  tris: 2082k -> 1995k.
    { scene: 'dock-vista', label: 'wide island vista', measured: 1671, draws: 1900, tris: 2_250_000 },
    // 2766 -> 1165 / 2481k -> 800k. The widest ceiling in the table on purpose:
    // this is the only scene whose FRAME moves — the camera rides the hull, and
    // which islands are behind it is a fact about where the ship is lying. Set
    // well under the pre-diet reading so a return to per-plank drawing still
    // fails, without grading ordinary drift as a regression.
    { scene: 'deck-aft', label: 'on-deck aft look', measured: 1165, draws: 2000, tris: 2_400_000 },
    // 2003 -> 1360 / 1281k -> 1256k.
    { scene: 'open-sea', label: 'open water', measured: 1360, draws: 1550, tris: 1_450_000 },
    // 2802 -> 2521 / 2902k -> 2907k. The waterfall wave's own view, which the
    // July table never had.
    { scene: 'waterfall-deck', label: 'deck view of a waterfall island', measured: 2521, draws: 2850, tris: 3_250_000 },
    // 4517 -> 3250 / 3571k -> 3525k. The dearest view in the game and the one
    // nobody had ever measured: standing in a hole in the ground still pays for
    // every island on the map.
    { scene: 'cave-interior', label: 'cave interior', measured: 3250, draws: 3650, tris: 3_900_000 },
  ],
  // 'low' has no measured column yet — these are the TARGETS the tier is
  // supposed to hit, and the ratio checks below are the real assertion. If the
  // first wired run comes in under them, tighten these to what it read.
  low: [
    { scene: 'dock-vista', label: 'wide island vista (low tier)', measured: 0, draws: 1200, tris: 1_400_000 },
    { scene: 'open-sea', label: 'open water (low tier)', measured: 0, draws: 1000, tris: 900_000 },
  ],
};

/** THE GILDED WRECK gets her OWN ceiling, and it is not the dock's.
 *
 *  She only exists for one storm phase in the middle of a match, so she never
 *  showed up in either scene above — and near-wreck frames were measured at
 *  2888-2971 draws against a 2900 ceiling that was never meant to cover her.
 *  Grading her by the dock's number is grading two different views with one
 *  ruler: nobody looking at the wreck is also looking at a dock, a tavern and
 *  a full island of props.
 *
 *  Needs a wreck up: the runner hands PIRATES_WRECK_SEC to any server it starts
 *  itself, and SKIPS this one scene (never fails) against a server that was
 *  already running without it. */
const WRECK_BUDGET = { label: 'the Gilded Wreck alongside', measured: 1763, draws: 2400, tris: 2_600_000 };
/** Seconds after the horn the dev server raises her for this measurement. */
const WRECK_RAISE_SEC = 12;
/** How long to wait for her after the join before giving up and skipping. */
const WRECK_WAIT_MS = 90_000;

/** The low tier exists to be CHEAPER. These are the ratios it must beat against
 *  the same scene at 'high' — a 'low' that saves nothing is a menu entry that
 *  lies to the player about what it will do for their frame rate. */
const LOW_TIER_MAX_RATIO = { draws: 0.72, tris: 0.68 };

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReady(url, child) {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await isReady(url)) return;
    if (child && child.exitCode !== null) throw new Error(`dev server exited early with code ${child.exitCode}`);
    await sleep(350);
  }
  throw new Error(`dev server did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`);
}

function startNpmScript(scriptName) {
  const child = spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    // The wreck is a mid-match event: without this hook she rises at the first
    // ring shrink, four minutes after the join, and the scene below would time
    // out waiting for a hull that is coming but not yet.
    env: { ...process.env, BROWSER: 'none', PIRATES_WRECK_SEC: String(WRECK_RAISE_SEC) },
  });
  return { child, scriptName };
}

function stopDevServer(handle) {
  const child = handle?.child ?? handle;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch {
    try { child.kill('SIGINT'); } catch { /* already gone */ }
  }
}

/** Join a solo match at a pinned tier and measure every budgeted scene in it.
 *  One page per tier, closed before the next opens: two live rAF loops on a CPU
 *  rasteriser is exactly the concurrency this repo's crash history is made of. */
async function measureTier(browser, quality, { wantWreck }) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const results = {};
  try {
    await page.goto(`${ROOT_URL.replace(/\/$/, '')}/?debug&quality=${quality}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    // The options bag is waitForFunction's THIRD argument. Passed as the second
    // it is silently taken as the page-function's ARG, the 30s default applies,
    // and a loaded box then reports "the join timed out" 90 seconds early — a
    // lie about the game told by the instrument.
    await page.waitForFunction(
      () => window.__piratesBR?.state?.phase === 'playing',
      null,
      { timeout: 240_000 },
    );
    // Let the streamed island/sea-rock build queues finish before counting.
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    const plan = planScenes(await readWorld(page));
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) plan['waterfall-deck'] = planWaterfallDeck(waterfall);

    for (const budget of BUDGETS[quality]) {
      if (!plan[budget.scene]) {
        console.log(`  – ${budget.scene}: no placement in this world, skipped`);
        continue;
      }
      // Resolution is pinned so the budget measures geometry, not screen area.
      await page.evaluate(PIN_PIXEL_RATIO);
      // settle: true — see the header. A count taken mid-reveal is a lie.
      const r = await measureScene(page, plan[budget.scene], { warmupMs: 2500, captureMs: 3000, settle: true });
      const sources = await page.evaluate(TALLY_DRAW_SOURCES).catch(() => []);
      results[budget.scene] = { draws: Math.round(r.draws), tris: Math.round(r.tris), peakDraws: r.peakDraws, sources };
      report(quality, budget, results[budget.scene], r);
    }

    if (wantWreck) {
      const wreck = await page
        .waitForFunction(() => window.__piratesBR?.state?.wreck ?? null, null, { timeout: WRECK_WAIT_MS })
        .then((handle) => handle.jsonValue())
        .catch(() => null);
      if (!wreck) {
        console.log('  – wreck scene skipped: no Gilded Wreck rose '
          + '(a server started outside this runner has no PIRATES_WRECK_SEC hook)');
      } else {
        await page.evaluate(PIN_PIXEL_RATIO);
        const r = await measureScene(page, planWreckScene(wreck), { warmupMs: 2500, captureMs: 3000, settle: true });
        results.wreck = { draws: Math.round(r.draws), tris: Math.round(r.tris), peakDraws: r.peakDraws, sources: [] };
        report(quality, { scene: 'wreck', ...WRECK_BUDGET }, results.wreck, r);
      }
    }

    expect(`No page errors at quality=${quality}`, errors.length === 0, errors.join('\n'));
  } finally {
    await page.close().catch(() => {});
  }
  return results;
}

function report(quality, budget, got, raw) {
  const timing = IS_SOFTWARE_GL
    ? `${raw.frames} frames, med ${raw.medianMs.toFixed(0)}ms ADVISORY`
    : `${(1000 / raw.medianMs).toFixed(1)} fps`;
  console.log(
    `  [${quality}] ${budget.scene}: ${got.draws} draws (peak ${got.peakDraws}), `
    + `${Math.round(got.tris / 1000)}k tris, ${raw.programs} programs (${timing})`,
  );
  if (got.sources?.length) {
    console.log(`      by source: ${got.sources.slice(0, 8).map((s) => `${s.source}=${s.calls}`).join('  ')}`);
  }
  expect(
    `[${quality}] ${budget.label} stays under ${budget.draws} draw calls`,
    got.draws <= budget.draws,
    `measured ${got.draws}, ceiling ${budget.draws} (was ${budget.measured} when the ceiling was set)`,
  );
  expect(
    `[${quality}] ${budget.label} stays under ${Math.round(budget.tris / 1000)}k triangles`,
    got.tris <= budget.tris,
    `measured ${Math.round(got.tris / 1000)}k, ceiling ${Math.round(budget.tris / 1000)}k`,
  );
}

async function main() {
  console.log(`Draw-call budget — GL: ${describeGl()}`);

  let browser;
  try {
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  } catch (error) {
    console.log(`  – skipped: could not launch a browser (${error?.message ?? error})`);
    return;
  }

  const started = [];
  try {
    const hadClient = await isReady(ROOT_URL);
    const hadServer = await isReady(SERVER_HEALTH_URL);
    if (!hadClient && !hadServer) {
      const stack = startNpmScript('dev');
      started.push(stack);
      await waitForReady(ROOT_URL, stack.child);
      await waitForReady(SERVER_HEALTH_URL, stack.child);
    } else {
      if (!hadClient) {
        const client = startNpmScript('dev:client');
        started.push(client);
        await waitForReady(ROOT_URL, client.child);
      }
      if (!hadServer) {
        const server = startNpmScript('dev:server');
        started.push(server);
        await waitForReady(SERVER_HEALTH_URL, server.child);
      }
    }
    // The wreck only rises on a server THIS runner started with the hook.
    const wantWreck = started.some((h) => h.scriptName === 'dev' || h.scriptName === 'dev:server');

    const high = await measureTier(browser, 'high', { wantWreck });
    const low = await measureTier(browser, 'low', { wantWreck: false });

    // ── 'low' must actually be low ───────────────────────────────────────
    for (const budget of BUDGETS.low) {
      const a = high[budget.scene];
      const b = low[budget.scene];
      if (!a || !b) continue;
      expect(
        `low tier draws no more than ${Math.round(LOW_TIER_MAX_RATIO.draws * 100)}% of high at ${budget.scene}`,
        b.draws <= a.draws * LOW_TIER_MAX_RATIO.draws,
        `low ${b.draws} vs high ${a.draws} (${Math.round((b.draws / a.draws) * 100)}%)`,
      );
      expect(
        `low tier draws no more than ${Math.round(LOW_TIER_MAX_RATIO.tris * 100)}% of high's triangles at ${budget.scene}`,
        b.tris <= a.tris * LOW_TIER_MAX_RATIO.tris,
        `low ${Math.round(b.tris / 1000)}k vs high ${Math.round(a.tris / 1000)}k (${Math.round((b.tris / a.tris) * 100)}%)`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
    for (const handle of started.reverse()) {
      stopDevServer(handle);
      await sleep(900);
      if (handle.child.exitCode === null) {
        try { handle.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  }

  if (failures > 0) process.exit(1);
  console.log('\nDraw-call budget passed.');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
