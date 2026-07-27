#!/usr/bin/env node
// Draw-call budget guard.
//
// Draw calls are the one renderer cost that creeps silently: every new prop
// type, every un-merged decoration, every light that stops being culled adds a
// few, nothing looks slower on the machine that added them, and six months
// later the wide shots cost twice what they did. This pins the two views where
// that creep shows first — the wide island vista and open water — to a ceiling
// roughly 1.3x what they measure today. It is a tripwire, not a target: if a
// change is worth the draws, raise the number here deliberately.
//
// Needs a real GPU. Under SwiftShader the numbers are meaningless, so the test
// SKIPS rather than failing or lying.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { PROBE_BROWSER_ARGS, PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, VIEWPORT } from './perf-probe.mjs';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? 'http://127.0.0.1:8090/health';
const READY_TIMEOUT_MS = 35_000;

/** Measured 2025-07 on an M1 at 1600x900, pixel ratio pinned to 1, quality=high,
 *  after the point-light budget landed. Ceilings are ~1.3x those readings. */
const BUDGETS = [
  { scene: 'dock-vista', label: 'wide island vista', measured: 2206, ceiling: 2900 },
  { scene: 'open-sea', label: 'open water', measured: 1718, ceiling: 2250 },
];

/** THE GILDED WRECK gets its OWN ceiling, and it is not the dock's.
 *
 *  She only exists for one storm phase in the middle of a match, so she never
 *  showed up in either scene above — and near-wreck frames were measured at
 *  2888-2971 draws against a 2900 ceiling that was never meant to cover her.
 *  Grading her by the dock's number is grading two different views with one
 *  ruler: nobody looking at the wreck is also looking at a dock, a tavern and
 *  a full island of props. Her own scene, her own budget, so a regression in
 *  the event is attributable to the event.
 *
 *  Needs a wreck up: the runner hands PIRATES_WRECK_SEC to any server it starts
 *  itself, and SKIPS this one scene (never fails) against a server that was
 *  already running without it. */
const WRECK_BUDGET = { label: 'the Gilded Wreck alongside', measured: 1763, ceiling: 2400 };
/** Seconds after the horn the dev server raises her for this measurement. */
const WRECK_RAISE_SEC = 12;
/** How long to wait for her after the join before giving up and skipping. */
const WRECK_WAIT_MS = 90_000;

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

/** Frame her from off her quarter and ABOVE — a boarding look down onto her
 *  deck, her rig and the water she lies in.
 *
 *  Down, not level, on purpose: she rises at a different ring centre every
 *  match, so a horizon-level shot grades whatever island happens to be behind
 *  her that game. Measured in one world at eye level the same event cost 1214,
 *  1526 and 2283 draws from three stands; looking down onto her it was 1752,
 *  1763 and 1745. A budget has to measure the thing it names. */
function planWreckScene(wreck) {
  const bearing = (wreck.rotation ?? 0) + Math.PI * 0.42;
  const stand = 70;
  return {
    x: wreck.position.x + Math.sin(bearing) * stand,
    y: 34,
    z: wreck.position.z + Math.cos(bearing) * stand,
    yaw: 0,
    pitch: -0.42,
    aimAt: { x: wreck.position.x, z: wreck.position.z },
  };
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

/** Real GPU, or a software rasteriser pretending to be one? */
async function detectGpu(browser) {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
        ?? document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  console.log('Draw-call budget');

  let browser;
  try {
    browser = await chromium.launch({ args: PROBE_BROWSER_ARGS });
  } catch (error) {
    console.log(`  – skipped: could not launch a browser (${error?.message ?? error})`);
    return;
  }

  const renderer = await detectGpu(browser);
  if (!renderer || /swiftshader|software|llvmpipe|basic render/i.test(renderer)) {
    console.log(`  – skipped: no GPU available (renderer: ${renderer ?? 'none'})`);
    await browser.close().catch(() => {});
    return;
  }
  console.log(`  GPU: ${renderer}`);

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

    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${ROOT_URL.replace(/\/$/, '')}/?debug&quality=high`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    // The options bag is waitForFunction's THIRD argument. Passed as the second
    // it is silently taken as the page-function's ARG, the 30s default applies,
    // and a loaded box then reports "the join timed out" 90 seconds early — a
    // lie about the game told by the instrument.
    await page.waitForFunction(
      () => window.__piratesBR?.state?.phase === 'playing',
      null,
      { timeout: 120_000 },
    );
    // Let the streamed island/sea-rock build queues finish before counting.
    await page.waitForTimeout(9000);
    // Resolution is pinned so the budget measures geometry, not screen area.
    await page.evaluate(PIN_PIXEL_RATIO);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    const plan = planScenes(await readWorld(page));
    for (const budget of BUDGETS) {
      await page.evaluate(PIN_PIXEL_RATIO);
      const result = await measureScene(page, plan[budget.scene], { warmupMs: 3500, captureMs: 3500 });
      const draws = Math.round(result.draws);
      console.log(
        `  ${budget.scene}: ${draws} draws (peak ${result.peakDraws}, ${Math.round(result.tris / 1000)}k tris, `
        + `${result.programs} programs, ${(1000 / result.medianMs).toFixed(1)} fps)`,
      );
      expect(
        `${budget.label} stays under ${budget.ceiling} draw calls`,
        draws <= budget.ceiling,
        `measured ${draws}, ceiling ${budget.ceiling} (was ${budget.measured} when the ceiling was set)`,
      );
    }

    // ── The Gilded Wreck ──────────────────────────────────────────────────
    const wreck = await page
      .waitForFunction(() => window.__piratesBR?.state?.wreck ?? null, null, { timeout: WRECK_WAIT_MS })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    if (!wreck) {
      console.log('  – wreck scene skipped: no Gilded Wreck rose '
        + '(a server started outside this runner has no PIRATES_WRECK_SEC hook)');
    } else {
      await page.evaluate(PIN_PIXEL_RATIO);
      const result = await measureScene(page, planWreckScene(wreck), { warmupMs: 3500, captureMs: 3500 });
      const draws = Math.round(result.draws);
      console.log(
        `  wreck: ${draws} draws (peak ${result.peakDraws}, ${Math.round(result.tris / 1000)}k tris, `
        + `${result.programs} programs, ${(1000 / result.medianMs).toFixed(1)} fps)`,
      );
      expect(
        `${WRECK_BUDGET.label} stays under ${WRECK_BUDGET.ceiling} draw calls`,
        draws <= WRECK_BUDGET.ceiling,
        `measured ${draws}, ceiling ${WRECK_BUDGET.ceiling} (was ${WRECK_BUDGET.measured} when the ceiling was set)`,
      );
    }

    expect('No page errors', errors.length === 0, errors.join('\n'));
    await page.close().catch(() => {});
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
