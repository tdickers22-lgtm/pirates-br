#!/usr/bin/env node
/**
 * A STANDARD GAMEPAD IN A REAL MATCH (b1.4e; crossdevice-05, vm:liveplay:1).
 * Browser tier: one headless SwiftShader Chromium at 960x540 on the runner's
 * 3101/8091 stack. navigator.getGamepads is stubbed by an init script with a
 * scripted W3C standard-mapping pad (axes + 17 buttons + a vibrationActuator
 * that records every playEffect), so the page runs the SAME poll path a real
 * Xbox / DualSense / Switch Pro pad takes. No mouse or keyboard event is sent.
 *
 *  1. menu: the first press only wakes the pad and rings the public Play
 *     button (nothing is pressed); A then presses the ringed Play; D-pad down
 *     moves the ring; A on Solo starts a match;
 *  2. left stick 2 s moves the pirate >= 1.5 m (server snapshot position);
 *  3. right stick full right 1 s turns 3.0-4.6 rad (220 deg/s at sens 1);
 *  4. RT puts fire=true into a built input and rumbles the pad with the
 *     haptics table's fire pulse (12 ms dual-rumble);
 *  5. LB opens the supply wheel, the right stick picks the right-hand wedge
 *     (slot 3) and letting go of LB takes it (wheelIndex 3 on the wire).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs } from './lib/browser-args.mjs';

const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const OUT = process.argv[2] ?? process.env.PIRATES_GAMEPAD_OUT ?? '/tmp/pbr-gamepad';
mkdirSync(OUT, { recursive: true });
const DEADLINE = Date.now() + Number(process.env.PIRATES_GAMEPAD_BUDGET_MS ?? 240_000);
const budget = (want) => Math.max(1_000, Math.min(want, DEADLINE - Date.now()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const browser = await chromium.launch({ args: browserArgs() });
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.setDefaultTimeout(60_000);
  await page.route('**/@vite/client*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: [
      `globalThis.__GAME_SERVER_PORT__ = ${JSON.stringify(process.env.PIRATES_BR_SERVER_PORT ?? '8091')};`,
      'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
      'const sheets = new Map();',
      'export const updateStyle = (id, css) => { let s = sheets.get(id); if (!s) { s = document.createElement("style"); s.setAttribute("data-vite-dev-id", id); document.head.appendChild(s); sheets.set(id, s); } s.textContent = css; };',
      'export const removeStyle = (id) => { sheets.get(id)?.remove(); sheets.delete(id); };',
      'export const injectQuery = (u) => u;',
      'export default {};',
    ].join('\n'),
  }));
  await page.addInitScript(() => {
    try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
    window.__rumble = [];
    const pad = {
      id: 'Scripted Pad (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      vibrationActuator: { type: 'dual-rumble', playEffect: (type, params) => { window.__rumble.push({ type, ...params }); return Promise.resolve('complete'); }, reset: () => Promise.resolve('complete') },
    };
    window.__pad = pad;
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [window.__pad, null, null, null] });
  });

  const setButton = (i, on) => page.evaluate(([idx, v]) => { const b = window.__pad.buttons[idx]; b.pressed = v; b.touched = v; b.value = v ? 1 : 0; window.__pad.timestamp = performance.now(); }, [i, on]);
  const setAxes = (a) => page.evaluate((ax) => { window.__pad.axes = ax; window.__pad.timestamp = performance.now(); }, a);
  const press = async (i, ms = 120) => { await setButton(i, true); await sleep(ms); await setButton(i, false); await sleep(200); };
  const ringed = () => page.evaluate(() => document.querySelector('.pad-focus')?.id ?? null);
  const snapPos = () => page.evaluate(() => { const p = window.__piratesBR?.getLocalPlayer?.(); return p ? { x: p.position.x, z: p.position.z } : null; });
  const startLog = () => page.evaluate(() => {
    const inp = window.__piratesBR.input;
    if (!inp.__gpWrapped) {
      const orig = inp.buildInput.bind(inp);
      inp.buildInput = () => { const r = orig(); window.__gpLog?.push({ fire: r.fire, wi: r.useWheelItem ? r.wheelIndex : null }); return r; };
      inp.__gpWrapped = true;
    }
    window.__gpLog = [];
  });
  const readLog = () => page.evaluate(() => window.__gpLog.slice());

  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: budget(60_000) });
  await page.waitForSelector('#menu-play-btn', { state: 'visible', timeout: budget(60_000) });
  await sleep(800);

  console.log('menu');
  // Swallow the public-queue click so pressing Play is observed without queueing.
  await page.evaluate(() => {
    window.__playClicks = 0;
    window.__playTrap = (e) => { window.__playClicks += 1; e.stopImmediatePropagation(); e.preventDefault(); };
    document.getElementById('menu-play-btn').addEventListener('click', window.__playTrap, true);
  });
  await press(0);
  const wake = await page.evaluate(() => ({ scheme: document.documentElement.dataset.inputScheme, clicks: window.__playClicks }));
  const ring0 = await ringed();
  expect('the first press wakes the pad: scheme gamepad, ring on the public Play, nothing pressed', wake.scheme === 'gamepad' && ring0 === 'menu-play-btn' && wake.clicks === 0, `${JSON.stringify(wake)} ring=${ring0}`);
  await page.screenshot({ path: `${OUT}/gamepad-menu-ring.png` }).catch(() => {});
  await press(0);
  const clicks = await page.evaluate(() => window.__playClicks);
  expect('A presses the focused Play button', clicks === 1, `clicks=${clicks}`);
  await page.evaluate(() => document.getElementById('menu-play-btn').removeEventListener('click', window.__playTrap, true));
  await press(13);
  const ring1 = await ringed();
  expect('D-pad down moves the ring to Solo', ring1 === 'menu-solo-btn', `ring=${ring1}`);
  if (ring1 !== 'menu-solo-btn') await page.evaluate(() => document.getElementById('menu-solo-btn').focus());
  await press(0);
  const playing = await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing' && !!window.__piratesBR.getLocalPlayer?.(),
    null, { timeout: budget(150_000) }).then(() => true, () => false);
  expect('A on Solo starts a match that reaches phase playing', playing);
  if (!playing) throw new Error('no match');
  await sleep(6_000);

  console.log('match');
  async function walk(y) {
    const p0 = await snapPos();
    await setAxes([0, y, 0, 0]);
    await sleep(400);
    const held = await page.evaluate(() => window.__piratesBR.input.pad.isHeld('moveForward') || window.__piratesBR.input.pad.isHeld('moveBack'));
    await sleep(1_600);
    await setAxes([0, 0, 0, 0]);
    await sleep(900);
    const p1 = await snapPos();
    return { moved: p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : 0, held };
  }
  let w = await walk(-1);
  if (w.moved < 1.5) { console.log(`    (forward moved ${w.moved.toFixed(2)} m; trying back)`); const b = await walk(1); if (b.moved > w.moved) w = b; }
  expect('left stick 2 s moves the pirate >= 1.5 m on the server', w.held && w.moved >= 1.5, `${w.moved.toFixed(2)} m, held=${w.held}`);

  // SwiftShader stalls the main thread (a 1 s timer measured 4.9 s here), and
  // the pad clamps one frame's dt to 0.25 s so a resumed tab cannot spin the
  // view. So the stick is held for 1 s of the PAD'S OWN integrated clock
  // (input.pad.lookClock) and the turn is normalised to exactly 1 stick-second;
  // the wall-clock window is printed for the record.
  const turn = await page.evaluate(async () => {
    const inp = window.__piratesBR.input;
    const y0 = inp.getYaw();
    const c0 = inp.pad.lookClock;
    const t0 = performance.now();
    window.__pad.axes = [0, 0, 1, 0];
    while (inp.pad.lookClock - c0 < 1.0 && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    window.__pad.axes = [0, 0, 0, 0];
    const secs = inp.pad.lookClock - c0;
    return { turned: y0 - inp.getYaw(), secs, ms: performance.now() - t0 };
  });
  const perSecond = turn.secs > 0 ? turn.turned / turn.secs : 0;
  expect('right stick full right for 1 s of stick time turns 3.0-4.6 rad (to the right: yaw decreases)', turn.secs >= 1.0 && perSecond >= 3.0 && perSecond <= 4.6,
    `${perSecond.toFixed(3)} rad per stick-second (${turn.turned.toFixed(3)} rad over ${turn.secs.toFixed(3)} s pad clock, ${turn.ms.toFixed(0)} ms wall)`);

  await startLog();
  await page.evaluate(() => { window.__rumble.length = 0; });
  // Held like a player holds a trigger: until the pad's poll has seen it and a
  // built input has gone out (a SwiftShader frame can outlast a 350 ms pull,
  // which is how the first green attempt sampled 0/3).
  await setButton(7, true);
  await page.waitForFunction(() => window.__piratesBR.input.pad.isHeld('fire') && (window.__gpLog ?? []).some((e) => e.fire), null, { timeout: budget(20_000) }).catch(() => {});
  await setButton(7, false);
  await page.waitForFunction(() => !window.__piratesBR.input.pad.isHeld('fire'), null, { timeout: budget(10_000) }).catch(() => {});
  const log = await readLog();
  const rumble = await page.evaluate(() => window.__rumble.slice());
  expect('RT puts fire=true into a built input', log.some((e) => e.fire), `${log.filter((e) => e.fire).length}/${log.length} inputs`);
  expect('RT rumbles the pad with the fire pulse (dual-rumble 12 ms)', rumble.some((r) => r.type === 'dual-rumble' && r.duration === 12), JSON.stringify(rumble));

  await startLog();
  await setButton(4, true);
  await sleep(300);
  const open = await page.evaluate(() => window.__piratesBR.input.isSupplyWheelOpen());
  await setAxes([0, 0, 1, 0]);
  await sleep(400);
  const hover = await page.evaluate(() => window.__piratesBR.supplyWheel?.hoverSlot ?? null);
  await page.screenshot({ path: `${OUT}/gamepad-wheel.png` }).catch(() => {});
  await setAxes([0, 0, 0, 0]);
  await setButton(4, false);
  await page.waitForFunction(() => (window.__gpLog ?? []).some((e) => e.wi !== null), null, { timeout: budget(5_000) }).catch(() => {});
  const wlog = await readLog();
  const after = await page.evaluate(() => window.__piratesBR.input.isSupplyWheelOpen());
  expect('LB opens the wheel, RS right picks slot 3, releasing LB takes it (wheelIndex 3) and closes', open && wlog.some((e) => e.wi === 3) && !after,
    `open=${open} hover=${hover} wi=${JSON.stringify(wlog.filter((e) => e.wi !== null))} closedAfter=${!after}`);
} finally {
  await browser.close().catch(() => {});
}

if (failures) { console.error(`FAIL test-gamepad (${failures})`); process.exit(1); }
console.log('PASS test-gamepad');
