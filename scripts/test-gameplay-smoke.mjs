#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? 'http://127.0.0.1:8090/health';
const GAME_URL = `${ROOT_URL.replace(/\/$/, '')}/?debug&quality=low`;
const READY_TIMEOUT_MS = 35_000;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
    if (child && child.exitCode !== null) {
      throw new Error(`dev server exited early with code ${child.exitCode}`);
    }
    await sleep(350);
  }
  throw new Error(`dev server did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`);
}

function startNpmScript(scriptName) {
  const logs = [];
  const child = spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER: 'none',
    },
  });

  const record = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.join('').length > 16_000) logs.splice(0, Math.max(1, logs.length - 20));
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  return { child, logs, scriptName };
}

function stopDevServer(processHandle) {
  const child = processHandle?.child ?? processHandle;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      child.kill('SIGINT');
    } else {
      process.kill(-child.pid, 'SIGINT');
    }
  } catch {
    try { child.kill('SIGINT'); } catch {}
  }
}

/**
 * Wait until the frame pipeline is actually delivering frames, then say so.
 *
 * THE COLD BOOT COSTS ONE ENORMOUS FRAME. Measured with the counts below: a first
 * page load after a Vite restart (cold module transform, cold shader compile)
 * spends 4662 ms inside a SINGLE frame, starting after `phase === 'playing'` and
 * running well past the fixed 2500 ms settle. A 1400 ms sample that lands inside
 * that one frame counts one frame in 4.7 s and reports 0 fps — which is a true
 * statement about the window and a false one about the frame rate. Warm loads
 * never see it, which is why it read as an every-other-run flake.
 *
 * So the window is chosen instead of assumed: sample only once frames are landing
 * back to back. The assertion downstream is unchanged and unwidened — if the
 * client never settles at all, this gives up and the measurement fails on the
 * merits with the counts to prove it.
 */
async function waitForSteadyFrames(page, { need = 8, frameBudgetMs = 220, giveUpMs = 25_000 } = {}) {
  return page.evaluate(async ({ need, frameBudgetMs, giveUpMs }) => {
    const start = performance.now();
    let prev = start;
    let streak = 0;
    let worst = 0;
    return await new Promise((resolve) => {
      function step() {
        const now = performance.now();
        const frameMs = now - prev;
        prev = now;
        worst = Math.max(worst, frameMs);
        streak = frameMs <= frameBudgetMs ? streak + 1 : 0;
        if (streak >= need) {
          resolve({ settled: true, waitedMs: Math.round(now - start), worstFrameMs: Math.round(worst) });
        } else if (now - start >= giveUpMs) {
          resolve({ settled: false, waitedMs: Math.round(now - start), worstFrameMs: Math.round(worst) });
        } else {
          requestAnimationFrame(step);
        }
      }
      requestAnimationFrame(step);
    });
  }, { need, frameBudgetMs, giveUpMs });
}

/**
 * Frames delivered over a window, plus the raw counts behind the number.
 *
 * The counts are not decoration. `fps: 0` cannot mean "no frames" — the counter
 * increments inside the callback that resolves it, so the floor is one — it means
 * ONE frame arrived and it took longer than two seconds. That is a completely
 * different defect from a low-but-steady frame rate, and reporting the rounded
 * rate alone made the two indistinguishable in the failure line.
 */
async function measureFps(page, durationMs = 1400) {
  return page.evaluate(async (ms) => {
    let frames = 0;
    let worst = 0;
    let prev = performance.now();
    const start = prev;
    return await new Promise((resolve) => {
      function step() {
        const now = performance.now();
        frames++;
        worst = Math.max(worst, now - prev);
        prev = now;
        const elapsed = now - start;
        if (elapsed >= ms) {
          resolve({
            fps: Math.round((frames * 1000) / Math.max(1, elapsed)),
            frames,
            elapsed: Math.round(elapsed),
            worstFrameMs: Math.round(worst),
          });
        } else {
          requestAnimationFrame(step);
        }
      }
      requestAnimationFrame(step);
    });
  }, durationMs);
}

async function main() {
  console.log('Browser gameplay smoke');

  const startedProcesses = [];
  const hadClient = await isReady(ROOT_URL);
  const hadGameServer = await isReady(SERVER_HEALTH_URL);
  if (!hadClient && !hadGameServer) {
    const stack = startNpmScript('dev');
    startedProcesses.push(stack);
    await waitForReady(ROOT_URL, stack.child);
    await waitForReady(SERVER_HEALTH_URL, stack.child);
  } else {
    if (!hadClient) {
      const client = startNpmScript('dev:client');
      startedProcesses.push(client);
      await waitForReady(ROOT_URL, client.child);
    }
    if (!hadGameServer) {
      const server = startNpmScript('dev:server');
      startedProcesses.push(server);
      await waitForReady(SERVER_HEALTH_URL, server.child);
    }
  }

  const browserEvents = [];
  // Same GPU-headless args every other browser script in this repo uses
  // (scripts/screenshot-tour.mjs). Without them Chromium falls back to
  // SwiftShader, where the join freezes the main thread for ~48s instead of the
  // measured 2.2s — so the smoke test was grading a software rasteriser rather
  // than the renderer players actually run, and its fps number meant nothing.
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' || /uncaught|error/i.test(text)) {
        browserEvents.push({ type, text });
      }
    });
    page.on('pageerror', (error) => browserEvents.push({ type: 'pageerror', text: error.message }));

    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 12_000 });
    await page.fill('#menu-name-input', `Smoke${Math.floor(Math.random() * 9000 + 1000)}`);
    // noWaitAfter: the synchronous world build freezes the main thread long
    // enough that Playwright's post-click wait can time out even though the
    // click landed and the join succeeded.
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    // Budget: 8s countdown + world build + the horn, with room for a cold cache.
    // The options bag is waitForFunction's THIRD argument; passed as the second
    // it is silently the page function's ARG and the 30s default applies. This
    // budget was written and never took effect — on a contended box the suite
    // failed at 30s flat and blamed the join.
    await page.waitForFunction(() => {
      const game = window.__piratesBR;
      return !!game?.state && game.state.phase === 'playing' && game.state.players?.length >= 10;
    }, null, { timeout: 45_000 });

    await page.waitForTimeout(2500);
    // The world build is a synchronous freeze; do not sample across it.
    const settle = await waitForSteadyFrames(page);
    const frameStats = await measureFps(page);
    const fps = frameStats.fps;
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/latest-game-smoke.png', fullPage: false });

    const data = await page.evaluate(() => {
      const game = window.__piratesBR;
      const state = game.state;
      const local = state.players.find((p) => p.id === game.localPlayerId) ?? null;
      const rendererInfo = game.renderer?.renderer?.info ?? null;
      const botSpawnIssues = state.players
        .filter((p) => p.isBot)
        .filter((p) => !p.shipId || p.onShipId !== p.shipId || p.state !== 'alive')
        .length;

      return {
        phase: state.phase,
        players: state.players.length,
        bots: state.players.filter((p) => p.isBot).length,
        ships: state.ships.length,
        shipsAlive: state.shipsAlive,
        islands: state.islands.length,
        chests: state.islands.reduce((sum, island) => sum + island.chests.length, 0),
        wildlife: state.wildlife?.length ?? 0,
        seaRocks: state.seaRocks?.length ?? 0,
        botSpawnIssues,
        local: local && {
          health: local.health,
          state: local.state,
          shipId: local.shipId,
          onShipId: local.onShipId,
          kegs: local.kegs,
          weapons: local.weapons.filter(Boolean).map((w) => w.weaponId),
        },
        hud: {
          crews: document.querySelector('#ships-alive')?.textContent?.trim() ?? '',
          kills: document.querySelector('#kill-count')?.textContent?.trim() ?? '',
          stormPhase: document.querySelector('#storm-phase')?.textContent?.trim() ?? '',
          stormTimer: document.querySelector('#storm-timer')?.textContent?.trim() ?? '',
        },
        debugPanelVisible: Boolean(document.querySelector('#debug-perf-panel')),
        canvas: {
          count: document.querySelectorAll('canvas').length,
          width: document.querySelector('canvas')?.clientWidth ?? 0,
          height: document.querySelector('canvas')?.clientHeight ?? 0,
        },
        render: rendererInfo && {
          calls: rendererInfo.render.calls,
          triangles: rendererInfo.render.triangles,
          geometries: rendererInfo.memory.geometries,
          textures: rendererInfo.memory.textures,
        },
      };
    });

    expect('Match phase is playing', data.phase === 'playing', JSON.stringify(data));
    expect('Solo bot match has 10 ships', data.ships === 10, JSON.stringify(data));
    expect('Solo bot match has 9 bots plus the player', data.players === 10 && data.bots === 9, JSON.stringify(data));
    expect('All ships are alive at spawn', data.shipsAlive === 10, JSON.stringify(data));
    expect('Bots spawn alive on their ships', data.botSpawnIssues === 0, JSON.stringify(data));
    expect('World content is present', data.islands >= 8 && data.chests > 0 && data.wildlife > 0 && data.seaRocks > 0, JSON.stringify(data));
    expect('Local player spawned with weapons and kegs', !!data.local && data.local.health > 0 && data.local.weapons.length >= 4 && data.local.kegs >= 1, JSON.stringify(data));
    expect('HUD shows BR state', data.hud.crews === '10' && data.hud.stormPhase.length > 0 && data.hud.stormTimer.length > 0, JSON.stringify(data.hud));
    expect('Debug/perf panel exists behind ?debug', data.debugPanelVisible, JSON.stringify(data));
    expect('Canvas is visible', data.canvas.count > 0 && data.canvas.width > 0 && data.canvas.height > 0, JSON.stringify(data.canvas));
    expect('The frame pipeline settles after the world build', settle.settled,
      `still stalling after ${settle.waitedMs}ms (worst frame ${settle.worstFrameMs}ms)`);
    expect('Browser produced frames', fps > 0,
      `fps=${fps} (${frameStats.frames} frames in ${frameStats.elapsed}ms,`
      + ` worst frame ${frameStats.worstFrameMs}ms; settled after ${settle.waitedMs}ms`
      + ` with a ${settle.worstFrameMs}ms worst boot frame)`);
    expect('No page errors', browserEvents.length === 0, JSON.stringify(browserEvents, null, 2));

    console.log(`\nSmoke metrics: ${fps} fps (${frameStats.frames} frames/${frameStats.elapsed}ms,`
      + ` worst ${frameStats.worstFrameMs}ms; boot settled in ${settle.waitedMs}ms after a`
      + ` ${settle.worstFrameMs}ms worst frame), ${data.render?.calls ?? '?'} draw calls,`
      + ` ${data.render?.triangles ?? '?'} triangles.`);
  } finally {
    await browser.close().catch(() => {});
    for (const proc of startedProcesses.reverse()) {
      stopDevServer(proc);
      await sleep(900);
      if (proc.child.exitCode === null) {
        try { proc.child.kill('SIGKILL'); } catch {}
      }
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
  console.log('\nBrowser gameplay smoke passed.');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
