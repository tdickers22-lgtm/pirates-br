// hold-water-probe (b2.3a, holes-01 / liveplay-01). HEAVY: one headless
// SwiftShader Chromium, its OWN stack (server :8091 seed 20260801, Vite :3101),
// both killed in `finally`.
//
// A GATE (exit 1 on any FAIL). Joins a solo match, pins the drawn fill (and
// attitude) of every hull through ShipRenderer.setHoldWaterDebug, parks the
// free camera at the STANDARD HOLD CAMERA (hull-local eye 0.3 m under the deck
// beams, above the water at every graded fill, 30% of the hold aft of
// amidships, looking at the bow 0.65 rad down; re-staged every 150 ms so the
// hull cannot sail out from under it) and grades:
//   - water pixels (fixed classifier: teal, g > 1.12 r, b > 1.05 r, g + b > 60)
//     in the lower half of the frame >= 15 / 35 / 55 % at fill 0.25 / 0.5 / 0.75
//   - roll 0.2: port and starboard waterlines on the lining differ >= 0.3 m
//     (read from the live renderer's plane, not recomputed)
//   - mean frame luminance at fill 0.5 >= 0.12 at noon, >= 0.06 at night
// PNGs + JSON go to test-results/hold-water/.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { readPng } from '../lib/png-read.mjs';

const SERVER_PORT = '8091';
const CLIENT_PORT = '3101';
const SEED = '20260801';
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const OUT = 'test-results/hold-water';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; }
}
const started = [];
async function ensure(name, command, url, env, timeoutMs = 120_000) {
  if (await isUp(url)) { console.log(`[probe] ${name} already up at ${url}, reusing`); return; }
  const child = spawn(command, { shell: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  started.push(child);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
async function teardown() {
  for (const child of started.splice(0).reverse()) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(900);
    try { if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

/** Pin the water, park the camera at the standard hold pose. Returns the plane readback. */
const STAGE = ({ fill, roll, tod }) => {
  const g = window.__piratesBR;
  g.setDayNightOverride(tod);
  const sr = g.shipRenderer;
  sr.setHoldWaterDebug({ fill, roll, pitch: 0 });
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const shipId = me?.shipId;
  const mesh = sr.shipMeshes.get(shipId);
  if (!mesh) return { error: `no ship mesh for ${shipId}` };
  const h = sr.getHoldWater(shipId);
  const root = mesh.root;
  root.updateMatrixWorld(true);
  const soleY = h.clip.soleY;
  const eye = root.localToWorld(new root.position.constructor(0, h.clip.deckY - 0.3, -0.3 * h.clip.halfL));
  const ahead = root.localToWorld(new root.position.constructor(0, h.clip.deckY - 0.3, 2)).sub(eye);
  const yaw = Math.atan2(ahead.x, ahead.z);
  g.enableFreeCam(eye.x, eye.y, eye.z, yaw, -0.65);
  return { shipId, plane: h.plane, halfL: h.clip.halfL, soleY, deckY: h.clip.deckY };
};

const READ_LINING = () => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const h = g.shipRenderer.getHoldWater(me.shipId);
  if (!h?.plane) return null;
  // Lining half-width at amidships at the mean surface height, from the same
  // table the fragment clip reads.
  const c = h.clip; const S = 16; const Lv = 6;
  const fl = ((h.plane.y0 - c.soleY) / (c.deckY - c.soleY)) * (Lv - 1);
  const l0 = Math.min(Lv - 2, Math.floor(fl)); const s0 = Math.floor((S - 1) / 2);
  const w = c.halfWidth;
  const hw = w[s0 * Lv + l0] + (w[s0 * Lv + l0 + 1] - w[s0 * Lv + l0]) * (fl - l0);
  return { port: h.plane.y0 + h.plane.sx * hw, stbd: h.plane.y0 - h.plane.sx * hw, plane: h.plane, visible: h.mesh.visible };
};

function classify(png) {
  const { width, height, data, channels } = png;
  let water = 0; let n = 0; let lum = 0; let all = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i]; const gg = data[i + 1]; const b = data[i + 2];
      lum += (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255; all += 1;
      if (y < height / 2) continue;
      n += 1;
      if (gg > 1.12 * r && b > 1.05 * r && gg + b > 60) water += 1;
    }
  }
  return { waterFrac: water / n, meanLum: lum / all };
}

async function main() {
  console.log(`hold-water-probe, GL: ${describeGl()}`);
  let browser;
  try {
    await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: SEED, PIRATES_BR_DEV_HOOKS: '1' });
    await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, `${CLIENT_URL}/`, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.log(`  [pageerror] ${err}`));
    await page.route('**/@vite/client*', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export default {};',
    }));
    await page.goto(`${CLIENT_URL}/?debug&forceinput&peace&quality=balanced&server=${SERVER_PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await page.waitForTimeout(4000);
    await page.evaluate(() => { try { window.__piratesBR.setBotPeace?.(true); } catch { /* optional */ } });
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });

    const shots = {};
    const rows = [
      { key: 'f25', fill: 0.25, roll: 0, tod: 854 },
      { key: 'f50', fill: 0.5, roll: 0, tod: 854 },
      { key: 'f75', fill: 0.75, roll: 0, tod: 854 },
      { key: 'night50', fill: 0.5, roll: 0, tod: 374 },
    ];
    for (const row of rows) {
      let staged = null;
      for (let k = 0; k < 8; k += 1) { staged = await page.evaluate(STAGE, row); await page.waitForTimeout(150); }
      if (staged?.error) throw new Error(staged.error);
      const path = `${OUT}/${row.key}.png`;
      await page.screenshot({ path, timeout: 60_000 });
      shots[row.key] = { ...classify(readPng(readFileSync(path))), staged };
      console.log(`  ${row.key}: water ${(shots[row.key].waterFrac * 100).toFixed(1)}% lum ${shots[row.key].meanLum.toFixed(3)}`);
    }
    check('fill 0.25: water pixels >= 15% of the lower frame', shots.f25.waterFrac >= 0.15, `${(shots.f25.waterFrac * 100).toFixed(1)}%`);
    check('fill 0.5: water pixels >= 35%', shots.f50.waterFrac >= 0.35, `${(shots.f50.waterFrac * 100).toFixed(1)}%`);
    check('fill 0.75: water pixels >= 55%', shots.f75.waterFrac >= 0.55, `${(shots.f75.waterFrac * 100).toFixed(1)}%`);
    check('hold luminance at noon >= 0.12', shots.f50.meanLum >= 0.12, shots.f50.meanLum.toFixed(3));
    check('hold luminance at night >= 0.06', shots.night50.meanLum >= 0.06, shots.night50.meanLum.toFixed(3));

    for (let k = 0; k < 6; k += 1) { await page.evaluate(STAGE, { fill: 0.5, roll: 0.2, tod: 854 }); await page.waitForTimeout(250); }
    await page.screenshot({ path: `${OUT}/roll20.png`, timeout: 60_000 });
    const lining = await page.evaluate(READ_LINING);
    check('roll 0.2: port and starboard waterlines differ >= 0.3 m (live renderer plane)',
      !!lining && lining.visible && Math.abs(lining.port - lining.stbd) >= 0.3,
      lining ? `port ${lining.port.toFixed(3)} stbd ${lining.stbd.toFixed(3)}` : 'no hold-water readback');
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ shots, lining, results }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await teardown();
  }
  if (failures > 0) { console.log(`\n${failures} hold-water probe check(s) FAILED`); process.exitCode = 1; }
  else console.log('\nhold-water-probe: all checks passed');
}
main().catch(async (e) => { console.error(e?.stack ?? e); await teardown(); process.exitCode = 1; });
