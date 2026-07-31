#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, IS_SOFTWARE_GL } from './lib/browser-args.mjs';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? 'http://127.0.0.1:8090/health';
const GAME_URL = `${ROOT_URL.replace(/\/$/, '')}/?debug&quality=low`;
const READY_TIMEOUT_MS = 35_000;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
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
  const child = spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  return { child };
}

function stopDevServer(processHandle) {
  const child = processHandle?.child ?? processHandle;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch {
    try { child.kill('SIGINT'); } catch {}
  }
}

async function ensureGame(page) {
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 12_000 });
  await page.fill('#menu-name-input', `Map${Math.floor(Math.random() * 9000 + 1000)}`);
  await page.click('#menu-solo-btn');
  // THIRD argument, not the second — as the second it is the page function's
  // ARG and the 30s default silently replaces this budget. (Here the default
  // was the more generous of the two, so the mistake hid as a pass; that is
  // worse, not better: the number in the file was never the number in force.)
  // 18s never covered a cold world build on a loaded box either, so make the
  // budget both real and honest about what it is waiting for.
  await page.waitForFunction(() => {
    const game = window.__piratesBR;
    return !!game?.state && game.state.phase === 'playing' && game.state.ships?.length >= 10;
  }, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
}

async function canvasStats(page, canvasId) {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const buckets = new Set();
    let nonblank = 0;
    let island = 0;
    let storm = 0;
    let enemy = 0;
    let local = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 0 && (r + g + b) > 18) nonblank += 1;
      if (r > 150 && g > 115 && b > 60 && r > b * 1.35) island += 1;
      if (r > 80 && b > 120 && g < 130) storm += 1;
      if (r > 190 && g > 80 && g < 180 && b < 140) enemy += 1;
      if ((r > 220 && g > 220 && b > 220) || (b > 180 && g > 120 && r < 140)) local += 1;
      buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
    }
    return { width, height, pixels: width * height, nonblank, island, storm, enemy, local, colors: buckets.size };
  }, canvasId);
}

async function localMarkerStats(page, canvasId) {
  return page.evaluate((id) => {
    const game = window.__piratesBR;
    const canvas = document.getElementById(id);
    const ctx = canvas?.getContext('2d');
    if (!game?.state || !canvas || !ctx) return null;
    const local = game.state.players.find((p) => p.id === game.localPlayerId) ?? null;
    const ship = local?.shipId ? game.state.ships.find((s) => s.id === local.shipId) ?? null : null;
    const xw = ship?.position.x ?? local?.position.x ?? 0;
    const zw = ship?.position.z ?? local?.position.z ?? 0;
    const scale = Math.min(canvas.width, canvas.height) / 2000;
    const x = Math.round(canvas.width * 0.5 + xw * scale);
    const y = Math.round(canvas.height * 0.5 + zw * scale);
    const radius = 14;
    const data = ctx.getImageData(
      Math.max(0, x - radius),
      Math.max(0, y - radius),
      Math.min(canvas.width, radius * 2 + 1),
      Math.min(canvas.height, radius * 2 + 1),
    ).data;
    let bright = 0;
    let cyan = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 220 && g > 220 && b > 220) bright += 1;
      if (b > 175 && g > 120 && r < 170) cyan += 1;
    }
    return { x, y, bright, cyan };
  }, canvasId);
}

async function main() {
  console.log('Battle-map/minimap browser contract');

  const started = [];
  const hadClient = await isReady(ROOT_URL);
  const hadGameServer = await isReady(SERVER_HEALTH_URL);
  if (!hadClient && !hadGameServer) {
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
    if (!hadGameServer) {
      const server = startNpmScript('dev:server');
      started.push(server);
      await waitForReady(SERVER_HEALTH_URL, server.child);
    }
  }

  const browserEvents = [];
  // This suite never asked for a GL backend — it takes Chromium's default, which is
  // the right call for a minimap drawn on a 2D canvas. But "default" on macOS is a
  // real GPU process, and PIRATES_GL=swiftshader has to mean NO GPU anywhere in the
  // battery or it does not mean anything. Only the software case overrides.
  const browser = await chromium.launch({ headless: true, args: IS_SOFTWARE_GL ? browserArgs() : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.on('console', (msg) => {
      if (msg.type() === 'error' || /uncaught|error/i.test(msg.text())) {
        browserEvents.push({ type: msg.type(), text: msg.text() });
      }
    });
    page.on('pageerror', (error) => browserEvents.push({ type: 'pageerror', text: error.message }));

    await ensureGame(page);
    await page.waitForTimeout(600);

    const mini = await canvasStats(page, 'minimap-canvas');
    const miniLocal = await localMarkerStats(page, 'minimap-canvas');
    expect('Minimap canvas exists and has size', !!mini && mini.width >= 140 && mini.height >= 140, JSON.stringify(mini));
    expect('Minimap is nonblank and color-rich', !!mini && mini.nonblank > mini.pixels * 0.45 && mini.colors > 20, JSON.stringify(mini));
    expect('Minimap draws islands, storm, enemies, and local marker', !!mini && mini.island > 60 && mini.storm > 100 && mini.enemy > 40 && mini.local > 40, JSON.stringify(mini));
    expect('Local marker is near expected world coordinate on minimap', !!miniLocal && miniLocal.bright + miniLocal.cyan > 8, JSON.stringify(miniLocal));

    await page.keyboard.press('KeyM');
    await page.waitForTimeout(350);
    const fullVisible = await page.locator('#map-overlay').evaluate((el) => getComputedStyle(el).display !== 'none');
    const full = await canvasStats(page, 'map-canvas');
    const fullLocal = await localMarkerStats(page, 'map-canvas');
    expect('M opens fullscreen battle map', fullVisible, `visible=${fullVisible}`);
    expect('Fullscreen map is nonblank and richer than minimap', !!full && full.nonblank > full.pixels * 0.35 && full.colors > 24, JSON.stringify(full));
    expect('Fullscreen map draws logical marker layers', !!full && full.island > 400 && full.storm > 1500 && full.enemy > 120 && full.local > 80, JSON.stringify(full));
    expect('Local marker is near expected world coordinate on fullscreen map', !!fullLocal && fullLocal.bright + fullLocal.cyan > 12, JSON.stringify(fullLocal));
    expect('No browser errors', browserEvents.length === 0, JSON.stringify(browserEvents, null, 2));
  } finally {
    await browser.close().catch(() => {});
    for (const proc of started.reverse()) {
      stopDevServer(proc);
      await sleep(900);
      if (proc.child.exitCode === null) {
        try { proc.child.kill('SIGKILL'); } catch {}
      }
    }
  }

  if (failures > 0) process.exit(1);
  console.log('\nBattle-map/minimap checks passed.');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
