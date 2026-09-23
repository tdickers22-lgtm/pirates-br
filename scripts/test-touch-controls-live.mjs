#!/usr/bin/env node
/**
 * TOUCH CONTROLS, DRIVEN BY REAL TOUCHES IN A REAL MATCH (b1.4b2; crossdevice-01/04,
 * liveplay-03). The browser half of test-touch-controls.mjs.
 *
 * One headless SwiftShader Chromium with hasTouch + isMobile, fingers delivered
 * through CDP Input.dispatchTouchEvent (the same pipeline a phone's touches take:
 * the page sees pointerType 'touch' pointer events, never a mouse). At 844x390
 * (a landscape phone) it must show:
 *
 *   1. the overlay mounts and shows in a match on the touch scheme;
 *   2. a thumb held on the left-45% stick for 2 s moves the pirate >= 1.5 m
 *      (server-authoritative position, read back from the snapshot);
 *   3. a 150 px drag on the right 55% turns the view 0.35-1.2 rad;
 *   4. a Fire tap puts fire=true into a built input (the wire the server reads);
 *   5. holding .tc-interact 1.5 s gives interactHeld=true on EVERY input built
 *      during the hold, and false once the finger lifts;
 *   6. a touchCancel (pointercancel) on the chip releases the hold.
 *
 * At 1024x768 (iPad landscape) the look drag and the Fire tap run again, and
 * both sizes check that every button is inside the window and clear of the
 * others. Overlap with HUD regions (minimap, objective, feed) is printed as
 * ADVISORY evidence: the phone HUD layout belongs to b1.5e.
 *
 * Enter the match with a TAP: page.click would send a mouse pointer and flip
 * the scheme back to mouse, which hides the overlay by design.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs } from './lib/browser-args.mjs';

const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const OUT = process.argv[2] ?? process.env.PIRATES_TOUCH_OUT ?? '/tmp/pbr-touch-controls';
mkdirSync(OUT, { recursive: true });

const SUITE_BUDGET_MS = Number(process.env.PIRATES_TOUCH_BUDGET_MS ?? 300_000);
const DEADLINE = Date.now() + SUITE_BUDGET_MS;
const budget = (want) => Math.max(1_000, Math.min(want, DEADLINE - Date.now()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const PHONE = { width: 844, height: 390 };
const IPAD = { width: 1024, height: 768 };

const browser = await chromium.launch({ args: browserArgs() });
let context;
try {
  context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.setDefaultTimeout(60_000);

  // HMR stubbed so a concurrent edit cannot full-reload the tab mid-assertion.
  // updateStyle must be REAL: touch.css is a dynamic import, and in dev Vite
  // delivers CSS through updateStyle; a no-op leaves .tc-zone with no size.
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
  });

  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })),
  });
  const rectOf = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
  }, sel);
  // On a miss, name what the finger actually landed on (a HUD panel above the
  // overlay is how this suite first went red at 844x390).
  const hitAt = (x, y) => page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}` : 'nothing';
  }, [x, y]);
  const snapPos = () => page.evaluate(() => {
    const p = window.__piratesBR?.getLocalPlayer?.();
    return p ? { x: p.position.x, y: p.position.y, z: p.position.z } : null;
  });
  const yaw = () => page.evaluate(() => window.__piratesBR.input.getYaw());
  // Every input the client builds (what goes on the wire) is logged here.
  const startLog = () => page.evaluate(() => {
    const inp = window.__piratesBR.input;
    if (!inp.__tcWrapped) {
      const orig = inp.buildInput.bind(inp);
      inp.buildInput = () => { const r = orig(); window.__tcLog?.push({ fire: r.fire, ih: r.interactHeld, i: r.interact }); return r; };
      inp.__tcWrapped = true;
    }
    window.__tcLog = [];
  });
  const readLog = () => page.evaluate(() => window.__tcLog.slice());

  async function lookDrag(label, vp) {
    const x0 = Math.round(vp.width * 0.62);
    const y0 = Math.round(vp.height * 0.45);
    const before = await yaw();
    await touch('touchStart', [[x0, y0, 7]]);
    for (let i = 1; i <= 10; i += 1) {
      await touch('touchMove', [[x0 + 15 * i, y0, 7]]);
      await sleep(16);
    }
    await touch('touchEnd', []);
    await sleep(150);
    const turned = Math.abs((await yaw()) - before);
    expect(`${label}: a 150 px drag on the right 55% turns 0.35-1.2 rad`, turned >= 0.35 && turned <= 1.2,
      `${turned.toFixed(3)} rad; finger landed on ${await hitAt(x0, y0)}`);
  }

  async function fireTap(label) {
    const r = await rectOf('#touch-controls .tc-fire');
    await startLog();
    await touch('touchStart', [[r.cx, r.cy, 3]]);
    await sleep(60);
    await touch('touchEnd', []);
    await page.waitForFunction(() => (window.__tcLog?.length ?? 0) >= 3, null, { timeout: budget(20_000) }).catch(() => {});
    const log = await readLog();
    expect(`${label}: a Fire tap puts fire=true into a built input`, log.some((e) => e.fire),
      `${log.filter((e) => e.fire).length}/${log.length} inputs; finger landed on ${await hitAt(r.cx, r.cy)}`);
  }

  async function checkLayout(vp, name) {
    const L = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, x: r.left, y: r.top, w: r.width, h: r.height }; };
      const btns = [...document.querySelectorAll('#touch-controls .tc-btn')].map(box);
      const hud = ['minimap-shell', 'objective-line', 'hud-feed', 'kill-feed', 'interact-prompt', 'health-bar', 'hud-bottom']
        .map((id) => document.getElementById(id))
        .filter((el) => el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
        .map(box);
      return { btns, hud };
    });
    const overlap = (a, b) => {
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return ox > 1 && oy > 1 ? Math.round(ox * oy) : 0;
    };
    const outside = L.btns.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > vp.width || b.y + b.h > vp.height || b.w < 40);
    expect(`${name}: all ${L.btns.length} touch buttons are inside the window and >= 40 px`, L.btns.length === 6 && outside.length === 0,
      outside.map((b) => `${b.id} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; '));
    const clash = [];
    for (let i = 0; i < L.btns.length; i += 1) for (let j = i + 1; j < L.btns.length; j += 1) {
      const px = overlap(L.btns[i], L.btns[j]);
      if (px) clash.push(`${L.btns[i].id} x ${L.btns[j].id} ${px}px²`);
    }
    expect(`${name}: no two touch buttons overlap`, clash.length === 0, clash.join('; '));
    const hudClash = [];
    for (const b of L.btns) for (const h of L.hud) { const px = overlap(b, h); if (px) hudClash.push(`${b.id} x #${h.id} ${px}px²`); }
    console.log(`    ADVISORY (b1.5e owns the HUD layout) ${name}: arc vs HUD overlaps: ${hudClash.length ? hudClash.join('; ') : 'none'}`);
  }

  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: budget(60_000) });
  await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: budget(60_000) });
  await page.tap('#menu-solo-btn', { noWaitAfter: true });

  const playing = await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing' && !!window.__piratesBR.getLocalPlayer?.(),
    null, { timeout: budget(150_000) }).then(() => true, () => false);
  expect('a solo match reaches phase playing with a local player', playing);
  if (!playing) throw new Error('no match');

  const mounted = await page.waitForFunction(() => {
    const tc = window.__piratesBR?.input?.getTouchControls?.();
    const zone = document.querySelector('#touch-controls .tc-zone')?.getBoundingClientRect();
    return !!tc && tc.isActive() && document.documentElement.dataset.inputScheme === 'touch' && zone && zone.width > 100;
  }, null, { timeout: budget(30_000) }).then(() => true, () => false);
  const state = await page.evaluate(() => ({
    scheme: document.documentElement.dataset.inputScheme,
    tc: !!window.__piratesBR.input.getTouchControls?.(),
    active: window.__piratesBR.input.getTouchControls?.()?.isActive?.() ?? null,
    zoneW: document.querySelector('#touch-controls .tc-zone')?.getBoundingClientRect().width ?? null,
  }));
  expect('the touch overlay is mounted, active and sized on the touch scheme in a match', mounted, JSON.stringify(state));
  if (!mounted) throw new Error('overlay not active');
  // Let the start ceremony settle so the pirate can walk.
  await sleep(6_000);

  console.log(`\n${PHONE.width}x${PHONE.height} (landscape phone)`);
  // ── 2. the stick ──────────────────────────────────────────────────────────
  async function stickWalk(dy) {
    const sx = Math.round(PHONE.width * 0.2);
    const sy = Math.round(PHONE.height * 0.65);
    const p0 = await snapPos();
    await touch('touchStart', [[sx, sy, 1]]);
    await touch('touchMove', [[sx, sy + dy / 2, 1]]);
    await touch('touchMove', [[sx, sy + dy, 1]]);
    const held = await page.evaluate(() => {
      const s = window.__piratesBR.input.getTouchControls().source;
      return { fwd: s.isHeld('moveForward'), back: s.isHeld('moveBack'), shown: document.querySelector('.tc-stick')?.classList.contains('shown') };
    });
    await sleep(2_000);
    await page.screenshot({ path: `${OUT}/touch-${PHONE.width}x${PHONE.height}-stick.png`, timeout: budget(30_000) }).catch((e) => console.log(`    (screenshot skipped: ${e.message.split('\n')[0]})`));
    await touch('touchEnd', []);
    await sleep(900); // the last snapshots of the walk arrive
    const p1 = await snapPos();
    const moved = p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : 0;
    const released = await page.evaluate(() => {
      const s = window.__piratesBR.input.getTouchControls().source;
      return !s.isHeld('moveForward') && !s.isHeld('moveBack') && !s.isHeld('moveLeft') && !s.isHeld('moveRight');
    });
    return { moved, held, released };
  }
  let walk = await stickWalk(-56);
  expect('a thumb pushed up on the left stick holds moveForward and shows the stick', walk.held.fwd && walk.held.shown, JSON.stringify(walk.held));
  if (walk.moved < 1.5) {
    console.log(`    (forward walk moved ${walk.moved.toFixed(2)} m; a rail or mast may be ahead, trying the stick pulled back)`);
    const back = await stickWalk(56);
    if (back.moved > walk.moved) walk = back;
  }
  expect('the stick held 2 s moves the pirate >= 1.5 m on the server', walk.moved >= 1.5, `${walk.moved.toFixed(2)} m`);
  expect('lifting the thumb releases every move row', walk.released);

  // ── 3/4. look and fire ────────────────────────────────────────────────────
  await lookDrag('phone', PHONE);
  await fireTap('phone');

  // ── 5. the interact hold ──────────────────────────────────────────────────
  const chip = await rectOf('#touch-controls .tc-interact');
  await sleep(300);
  await touch('touchStart', [[chip.cx, chip.cy, 4]]);
  await startLog();
  await sleep(1_500);
  const ring = await page.evaluate(() => Number(getComputedStyle(document.querySelector('#touch-controls .tc-interact')).getPropertyValue('--tc-hold') || 0));
  await page.screenshot({ path: `${OUT}/touch-${PHONE.width}x${PHONE.height}.png`, timeout: budget(30_000) }).catch((e) => console.log(`    (screenshot skipped: ${e.message.split('\n')[0]})`));
  const during = await readLog();
  await touch('touchEnd', []);
  await startLog();
  await page.waitForFunction(() => (window.__tcLog?.length ?? 0) >= 2, null, { timeout: budget(20_000) }).catch(() => {});
  const after = await readLog();
  expect('holding the Interact chip 1.5 s: interactHeld on every built input', during.length >= 2 && during.every((e) => e.ih),
    `${during.filter((e) => e.ih).length}/${during.length} inputs; finger landed on ${await hitAt(chip.cx, chip.cy)}`);
  expect('the hold ring advances on the swing clock while held', ring > 0 && ring < 1, `--tc-hold ${ring}`);
  expect('lifting the finger drops interactHeld', after.length > 0 && after.every((e) => !e.ih), `${after.filter((e) => e.ih).length}/${after.length} still held`);

  // ── 6. pointercancel ──────────────────────────────────────────────────────
  await touch('touchStart', [[chip.cx, chip.cy, 5]]);
  await sleep(400);
  const heldBefore = await page.evaluate(() => window.__piratesBR.input.getTouchControls().source.isHeld('interact'));
  await touch('touchCancel', []);
  await sleep(150);
  await startLog();
  await page.waitForFunction(() => (window.__tcLog?.length ?? 0) >= 2, null, { timeout: budget(20_000) }).catch(() => {});
  const cancelLog = await readLog();
  const cancel = await page.evaluate(() => ({
    held: window.__piratesBR.input.getTouchControls().source.isHeld('interact'),
    pressed: document.querySelector('#touch-controls .tc-interact').classList.contains('pressed'),
  }));
  expect('a pointercancel on the held chip releases interact', heldBefore && !cancel.held && !cancel.pressed
    && cancelLog.length > 0 && cancelLog.every((e) => !e.ih), `before ${heldBefore}, after ${JSON.stringify(cancel)}, ${cancelLog.length} inputs`);

  await checkLayout(PHONE, 'phone');

  // ── iPad landscape ────────────────────────────────────────────────────────
  console.log(`\n${IPAD.width}x${IPAD.height} (iPad landscape)`);
  await page.setViewportSize(IPAD);
  await sleep(1_500);
  await lookDrag('iPad', IPAD);
  await fireTap('iPad');
  await checkLayout(IPAD, 'iPad');
  await page.screenshot({ path: `${OUT}/touch-${IPAD.width}x${IPAD.height}.png`, timeout: budget(30_000) }).catch((e) => console.log(`    (screenshot skipped: ${e.message.split('\n')[0]})`));
} catch (err) {
  expect('suite ran to completion', false, err.message.split('\n')[0]);
} finally {
  await context?.close().catch(() => {});
  await browser.close().catch(() => {});
}

console.log(`\nshots: ${OUT}`);
if (failures) { console.error(`FAIL test-touch-controls-live (${failures})`); process.exit(1); }
console.log('PASS test-touch-controls-live');
