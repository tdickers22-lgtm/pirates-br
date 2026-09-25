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

/** b2.3f (holes-07): park the eye UNDER the hold water (0.5 m over the sole,
 *  aft of the hatch) and read what the game made of it: the camera water
 *  state (breath HUD hook), the muffle depth, the scene fog and the program
 *  count. */
const STAGE_UNDER = ({ fill, tod }) => {
  const g = window.__piratesBR;
  g.setDayNightOverride(tod);
  const sr = g.shipRenderer;
  sr.setHoldWaterDebug({ fill, roll: 0, pitch: 0 });
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const mesh = sr.shipMeshes.get(me?.shipId);
  if (!mesh) return { error: `no ship mesh for ${me?.shipId}` };
  const h = sr.getHoldWater(me.shipId);
  const root = mesh.root;
  root.updateMatrixWorld(true);
  const eye = root.localToWorld(new root.position.constructor(0, h.clip.soleY + 0.5, -0.3 * h.clip.halfL));
  const ahead = root.localToWorld(new root.position.constructor(0, h.clip.soleY + 0.5, 2)).sub(eye);
  g.enableFreeCam(eye.x, eye.y, eye.z, Math.atan2(ahead.x, ahead.z), -0.1);
  const ws = g.getCameraWaterState?.() ?? null;
  const fog = g.renderer.scene.fog;
  return {
    ws: ws ? { ...ws } : null, muffle: g.cameraSubmergeDepth, fogDensity: fog?.density ?? null,
    fogColor: fog ? [fog.color.r, fog.color.g, fog.color.b] : null,
    programs: g.renderer.renderer.info.programs?.length ?? -1, plane: h.plane,
  };
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

/** b2.3c (holes-06): stage probe-only breaches on the local hull and aim the
 *  free camera from under the deck beams, down and outboard at the breach's
 *  INBOARD seat (the bilge-board face for a hole above the sole, the sole edge
 *  for one below it). Returns pending until the hole's vis is built: on the
 *  software rasteriser one frame is seconds, so a fixed wait is not a frame. */
const STAGE_BREACH = ({ holes, tod }) => {
  const g = window.__piratesBR;
  g.setDayNightOverride(tod);
  const sr = g.shipRenderer;
  sr.setHoldWaterDebug({ fill: 0, roll: 0, pitch: 0 });
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const mesh = sr.shipMeshes.get(me?.shipId);
  if (!mesh) return { error: 'no ship mesh' };
  sr.setBreachDebug(me.shipId, holes);
  const vis = mesh.holeVis.get(holes[0].id);
  if (!vis || vis.patched !== !!holes[0].patched) return { pending: true };
  const V = mesh.root.position.constructor;
  mesh.root.updateMatrixWorld(true);
  const s = vis.inner;
  const deckY = sr.getHoldWater(me.shipId)?.clip?.deckY ?? 2.4;
  const target = mesh.root.localToWorld(new V(s.x, s.y, s.z));
  // Outboard of the centreline stairwell and its handrail, which otherwise
  // stand between a mid-hold eye and any breach amidships.
  const eye = mesh.root.localToWorld(new V(0.55 * s.x, deckY - 0.45, s.z - 0.7));
  const d = target.clone().sub(eye);
  g.enableFreeCam(eye.x, eye.y, eye.z, Math.atan2(d.x, d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
  return { seat: { x: s.x, y: s.y, z: s.z }, hasSeat: vis.hasSeat, belowSole: vis.belowSole, inboard: vis.inboard.visible, patched: vis.patched };
};

/** Where the seat lands on screen through the GAME camera (not assumed centre). */
const PROJECT_SEAT = ({ id }) => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const mesh = g.shipRenderer.shipMeshes.get(me?.shipId);
  const vis = mesh?.holeVis.get(id);
  if (!vis) return null;
  mesh.root.updateMatrixWorld(true);
  const w = mesh.root.localToWorld(vis.inner.clone());
  const cam = g.renderer.camera;
  cam.updateMatrixWorld(true);
  const n = w.clone().project(cam);
  return { x: (n.x * 0.5 + 0.5) * innerWidth, y: (0.5 - n.y * 0.5) * innerHeight, z: n.z };
};
const nextFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Box pixel census around the projected seat. Lining, sole, bilge board and
 *  plank patch are brown (r >= g >= 0.9 b, r > 1.2 b); anything else that is
 *  not near-black is the opening (sea, daylight, welling water). */
function seatBox(png, cx, cy, half = 10) {
  const { width, height, data, channels } = png;
  let open = 0; let n = 0;
  const x0 = Math.max(0, Math.round(cx) - half), x1 = Math.min(width, Math.round(cx) + half);
  const y0 = Math.max(0, Math.round(cy) - half), y1 = Math.min(height, Math.round(cy) + half);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i]; const gg = data[i + 1]; const b = data[i + 2];
      n += 1;
      const brown = r >= gg && gg >= 0.9 * b && r > 1.2 * b;
      if (!brown && r + gg + b > 30) open += 1;
    }
  }
  return n > 0 ? open / n : 0;
}

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

    // b2.3f (holes-07): underwater in the hold. Control first (dry hold, same
    // eye), then the flooded hold at noon; the program count must not move.
    let dry = null; let under = null;
    for (let k = 0; k < 6; k += 1) { dry = await page.evaluate(STAGE_UNDER, { fill: 0, tod: 854 }); await page.waitForTimeout(150); }
    for (let k = 0; k < 8; k += 1) { under = await page.evaluate(STAGE_UNDER, { fill: 0.9, tod: 854 }); await page.waitForTimeout(150); }
    await page.screenshot({ path: `${OUT}/under-hold.png`, timeout: 60_000 });
    const underShot = classify(readPng(readFileSync(`${OUT}/under-hold.png`)));
    console.log(`  under-hold: ${JSON.stringify({ dry: dry?.ws, under: under?.ws, muffle: under?.muffle, fog: under?.fogDensity, dryFog: dry?.fogDensity, fogColor: under?.fogColor, programs: [dry?.programs, under?.programs], lum: underShot.meanLum })}`);
    check('dry hold, eye 0.5 m over the sole: water state dry, sea fog', dry?.ws?.source === 'dry' && dry?.ws?.depth === 0 && dry?.fogDensity < 0.05,
      JSON.stringify({ ws: dry?.ws, fog: dry?.fogDensity }));
    check('flooded hold 0.9, same eye: source hold, depth > 0.3 m, muffle == depth', under?.ws?.source === 'hold' && under.ws.holdDepth > 0.3
      && Math.abs(under.muffle - under.ws.depth) < 1e-6, JSON.stringify({ ws: under?.ws, muffle: under?.muffle }));
    check('flooded hold: 95% fog inside 4-6 m (FogExp2 density 0.28..0.44)', under?.fogDensity >= 0.28 && under?.fogDensity <= 0.44, String(under?.fogDensity));
    check('flooded hold: 0 new programs (program count unchanged)', dry?.programs > 0 && under?.programs === dry?.programs, `${dry?.programs} -> ${under?.programs}`);
    check('flooded hold: the frame is murky, not black (mean luminance >= 0.03)', underShot.meanLum >= 0.03, underShot.meanLum.toFixed(3));

    for (let k = 0; k < 6; k += 1) { await page.evaluate(STAGE, { fill: 0.5, roll: 0.2, tod: 854 }); await page.waitForTimeout(250); }
    await page.screenshot({ path: `${OUT}/roll20.png`, timeout: 60_000 });
    const lining = await page.evaluate(READ_LINING);
    check('roll 0.2: port and starboard waterlines differ >= 0.3 m (live renderer plane)',
      !!lining && lining.visible && Math.abs(lining.port - lining.stbd) >= 0.3,
      lining ? `port ${lining.port.toFixed(3)} stbd ${lining.stbd.toFixed(3)}` : 'no hold-water readback');
    // b2.3c: the breach seen from inside. Open rows must show non-lining pixels
    // at the seat; the PATCHED control (same pose, inboard planks nailed on)
    // must not, so the row can fail.
    const breach = {};
    const breachRows = [
      { key: 'breach-above', holes: [{ id: 901, x: 1, y: 0.44, z: 0, patched: false }] },
      { key: 'breach-below', holes: [{ id: 902, x: -1, y: 0.14, z: 0.5, patched: false }] },
      { key: 'breach-patched', holes: [{ id: 903, x: 1, y: 0.44, z: 0, patched: true }] },
    ];
    for (const row of breachRows) {
      let staged = null;
      const until = Date.now() + 90_000;
      do {
        staged = await page.evaluate(STAGE_BREACH, { ...row, tod: 854 });
        if (staged?.error) throw new Error(staged.error);
        await page.evaluate(nextFrames);
      } while (staged?.pending && Date.now() < until);
      if (staged?.pending) throw new Error(`${row.key}: breach vis never built`);
      // Two more staged frames so the free camera and the uniforms settle.
      for (let k = 0; k < 2; k += 1) { staged = await page.evaluate(STAGE_BREACH, { ...row, tod: 854 }); await page.evaluate(nextFrames); }
      const at = await page.evaluate(PROJECT_SEAT, { id: row.holes[0].id });
      const path = `${OUT}/${row.key}.png`;
      await page.screenshot({ path, timeout: 60_000 });
      const onScreen = !!at && at.z < 1 && at.x > 10 && at.x < 950 && at.y > 10 && at.y < 530;
      breach[row.key] = { openFrac: onScreen ? seatBox(readPng(readFileSync(path)), at.x, at.y) : 0, at, staged };
      console.log(`  ${row.key}: non-lining at the seat ${(breach[row.key].openFrac * 100).toFixed(1)}% at ${at ? `${at.x.toFixed(0)},${at.y.toFixed(0)}` : '-'} ${JSON.stringify(staged)}`);
    }
    await page.evaluate(() => window.__piratesBR.shipRenderer.setBreachDebug(null));
    check('breach above the sole: the opening shows through the lining (>= 60% non-lining at the seat)',
      breach['breach-above'].openFrac >= 0.6, `${(breach['breach-above'].openFrac * 100).toFixed(1)}%`);
    check('breach below the sole: water shows through the cut sole (>= 60% non-lining at the seat)',
      breach['breach-below'].openFrac >= 0.6, `${(breach['breach-below'].openFrac * 100).toFixed(1)}%`);
    check('control, patched: the inboard planks cover the seat (<= 30% non-lining, seat on screen)',
      !!breach['breach-patched'].at && breach['breach-patched'].at.z < 1 && breach['breach-patched'].openFrac <= 0.3, `${(breach['breach-patched'].openFrac * 100).toFixed(1)}%`);
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ shots, lining, breach, results }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await teardown();
  }
  if (failures > 0) { console.log(`\n${failures} hold-water probe check(s) FAILED`); process.exitCode = 1; }
  else console.log('\nhold-water-probe: all checks passed');
}
main().catch(async (e) => { console.error(e?.stack ?? e); await teardown(); process.exitCode = 1; });
