#!/usr/bin/env node
/**
 * test-responsive-hud (b1.5e; crossdevice-07, crossdevice-08, mechanicshud-11, liveplay-03).
 *
 * Browser gate. The HUD, the main menu and the onboarding cards are measured at
 * the phone, tablet and laptop sizes a player actually brings:
 *
 *   touch (hasTouch + isMobile): 667x375, 844x390, 932x430 (phone landscape),
 *     390x844 (phone portrait: the rotate card), 1024x768, 1180x820, 1366x1024 (iPad)
 *   desktop (mouse): 960x540
 *
 * In a match, at every size:
 *   - no two visible HUD widgets overlap by more than 4x4 px,
 *   - no widget leaves the viewport,
 *   - no visible touch control overlaps a HUD widget (thumbs cover what sits there),
 *   - the minimap is drawn at least 90x90 (after its ancestors' clipping),
 *   - on touch, no visible string says WASD / LMB / RMB / "Click to".
 * On the menu: at 844x390 and 667x375 neither #menu-screen nor the main panel
 * scrolls (scrollHeight <= clientHeight + 4) and every main-panel button sits
 * inside the viewport; every text input computes >= 16 px (iOS zooms the page
 * on focus below that). The onboarding cards at 844x390, 667x375 and 1024x768:
 * panel inside the viewport, Skip and Next inside it and hittable
 * (elementFromPoint at their centres lands on them).
 *
 * A "widget" is a child of a HUD region (#hud-top-left/-center/-right,
 * #hud-right-tactical, #hud-center-prompt, #hud-bottom-left/-mid/-right) or a
 * direct child of #hud that is not a region; full-screen layers, modals and the
 * world-projected own-ship marker are excluded by name below.
 *
 * Usage: node scripts/test-responsive-hud.mjs [--stack] [--json=path] [--shots=dir]
 *   --stack  boot a private stack on 3101/8091 (seed 20260801) and kill it after.
 *   Without it PIRATES_BR_URL (default http://127.0.0.1:3101) must already serve.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OWN_STACK = args.includes('--stack');
const JSON_OUT = (args.find((a) => a.startsWith('--json=')) ?? '').slice(7) || resolve(ROOT, 'test-results/responsive-hud.json');
const SHOTS = (args.find((a) => a.startsWith('--shots=')) ?? '').slice(8);
const shot = async (pg, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {}); } };
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');

let failures = 0;
const report = { rows: [] };
function expect(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

const TOUCH_MATCH = [[667, 375], [844, 390], [932, 430], [1024, 768], [1180, 820], [1366, 1024]];
const MENU_GRADED = [[844, 390], [667, 375]];
const MENU_REPORTED = [[932, 430], [1024, 768], [1180, 820], [1366, 1024]];
const ONBOARD = [[844, 390], [667, 375], [1024, 768]];

// ── Stack ────────────────────────────────────────────────────────────────
const children = [];
function start(cmd, env) {
  const c = spawn(cmd, { cwd: ROOT, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  children.push(c);
}
async function waitUp(url, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`stack did not come up: ${url}`);
}
function stopStack() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }
}

// ── In-page measurement (serialised into the page) ───────────────────────
function measureHud() {
  const EXCLUDE = new Set(['own-ship-marker', 'hit-marker', 'damage-indicator-layer', 'scope-overlay', 'damage-vignette',
    'knockback-flash', 'barrel-panel', 'controls-hint', 'pocket-wheel', 'map-wheel', 'shop-wheel', 'downed-banner']);
  const REGIONS = ['hud-top-left', 'hud-top-center', 'hud-top-right', 'hud-right-tactical', 'hud-center-prompt',
    'hud-bottom-left', 'hud-bottom-mid', 'hud-bottom-right'];
  const W = innerWidth, H = innerHeight;
  const shown = (el) => {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) < 0.05) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  // Rect after every overflow-clipping ancestor (what the player can see).
  const clipped = (el) => {
    const r = el.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflow !== 'visible' || ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
        const q = p.getBoundingClientRect();
        x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
      }
    }
    return { x0, y0, x1, y1, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };
  const hud = document.getElementById('hud');
  const els = [];
  for (const id of REGIONS) for (const c of document.getElementById(id)?.children ?? []) els.push(c);
  for (const c of hud?.children ?? []) {
    if (['hud-top-nav', 'hud-right-tactical', 'hud-center-prompt', 'hud-bottom-combat'].includes(c.id)) continue;
    els.push(c);
  }
  const widgets = [];
  for (const el of els) {
    if (EXCLUDE.has(el.id) || !shown(el)) continue;
    const raw = el.getBoundingClientRect();
    if (raw.width * raw.height > 0.4 * W * H) continue; // full-screen layer
    const name = el.id ? `#${el.id}` : `${el.parentElement?.id ? '#' + el.parentElement.id + ' > ' : ''}${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`;
    const c = clipped(el);
    if (c.w < 2 || c.h < 2) continue;
    widgets.push({ name, raw: { x0: raw.left, y0: raw.top, x1: raw.right, y1: raw.bottom }, vis: c });
  }
  const touch = [];
  for (const el of document.querySelectorAll('#touch-controls.active .tc-btn, #touch-controls.active .tc-helm-box')) {
    if (el.hidden || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    touch.push({ name: `.${String(el.className).split(' ').find((k) => k.startsWith('tc-') && k !== 'tc-btn' && k !== 'tc-ring') ?? 'tc-btn'}`, vis: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } });
  }
  const mm = document.getElementById('minimap');
  const minimap = mm && shown(mm) ? clipped(mm) : null;
  const text = document.body.innerText;
  const kb = (text.match(/\b(WASD|LMB|RMB|Click to)\b[^\n]{0,40}/gi) ?? []);
  const rot = document.getElementById('rotate-card');
  const rr = rot?.getBoundingClientRect();
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.right > screen.width + 2 && r.width > 0 && getComputedStyle(el).display !== 'none') wide.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.right)}`);
  }
  const rotateShown = !!rot && getComputedStyle(rot).display !== 'none' && rr.width >= W - 1 && rr.height >= H - 1;
  return { W, H, wide: wide.slice(0, 12), widgets, touch, minimap, kb, rotateShown, scheme: document.documentElement.dataset.inputScheme ?? null };
}

function inter(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 4 && h > 4 ? `${Math.round(w)}x${Math.round(h)}` : null;
}

function gradeHud(tag, m, { touch, w, h }) {
  // A page wider than the glass makes a phone zoom OUT (the layout viewport
  // grows): measured at HEAD, 667x375 laid out at 1024x576 and every widget
  // shrank by a third. Graded first; the rest is meaningless without it.
  expect(`${tag}: layout viewport is the device viewport (no zoom-out)`, m.W === w && m.H === h, `${m.W}x${m.H}`);
  const overlaps = [];
  for (let i = 0; i < m.widgets.length; i++) for (let j = i + 1; j < m.widgets.length; j++) {
    const o = inter(m.widgets[i].vis, m.widgets[j].vis);
    if (o) overlaps.push(`${m.widgets[i].name} x ${m.widgets[j].name} (${o})`);
  }
  expect(`${tag}: no two HUD widgets overlap > 4x4 px`, overlaps.length === 0, overlaps.join('; ') || `${m.widgets.length} widgets`);
  const out = m.widgets.filter((w) => w.raw.x0 < -1 || w.raw.y0 < -1 || w.raw.x1 > m.W + 1 || w.raw.y1 > m.H + 1)
    .map((w) => `${w.name} [${Math.round(w.raw.x0)},${Math.round(w.raw.y0)} ${Math.round(w.raw.x1)},${Math.round(w.raw.y1)}]`);
  expect(`${tag}: every widget inside the viewport`, out.length === 0, out.join('; '));
  if (touch) {
    expect(`${tag}: touch controls are on (scheme touch)`, m.scheme === 'touch' && m.touch.length > 0, `scheme ${m.scheme}, ${m.touch.length} controls`);
    const hits = [];
    for (const t of m.touch) for (const w of m.widgets) { const o = inter(t.vis, w.vis); if (o) hits.push(`${t.name} x ${w.name} (${o})`); }
    expect(`${tag}: no touch control overlaps a HUD widget`, hits.length === 0, hits.join('; '));
    expect(`${tag}: no keyboard/mouse words on touch`, m.kb.length === 0, m.kb.join(' | '));
  }
  expect(`${tag}: minimap drawn >= 90x90`, !!m.minimap && m.minimap.w >= 90 && m.minimap.h >= 90,
    m.minimap ? `${Math.round(m.minimap.w)}x${Math.round(m.minimap.h)}` : 'hidden');
}

function measureMenu() {
  const scr = document.getElementById('menu-screen');
  const pan = document.getElementById('menu-panel-main');
  const W = innerWidth, H = innerHeight;
  const outside = [];
  for (const b of pan?.querySelectorAll('button, input') ?? []) {
    const cs = getComputedStyle(b);
    if (cs.display === 'none' || cs.visibility === 'hidden' || b.offsetParent === null) continue;
    const r = b.getBoundingClientRect();
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) outside.push(`#${b.id || b.textContent.trim().slice(0, 16)} [${Math.round(r.top)}..${Math.round(r.bottom)}]`);
  }
  const small = [];
  for (const i of document.querySelectorAll('input[type=text], input:not([type]), input[type=search], textarea')) {
    const px = parseFloat(getComputedStyle(i).fontSize);
    if (!(px >= 16)) small.push(`#${i.id} ${px}px`);
  }
  const title = document.querySelector('#menu-screen h1, #menu-title, .menu-title');
  return {
    screen: scr ? { sh: scr.scrollHeight, ch: scr.clientHeight } : null,
    panel: pan ? { sh: pan.scrollHeight, ch: pan.clientHeight } : null,
    outside, small, W, H,
    titlePx: title ? parseFloat(getComputedStyle(title).fontSize) : null,
  };
}

function measureCards() {
  const W = innerWidth, H = innerHeight;
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el) return { id, missing: true };
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return { id, hidden: true };
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return { id, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, inside: r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1, hit: !!hit && (hit === el || el.contains(hit)) };
  };
  return { W, H, open: document.getElementById('onboard-cards')?.classList.contains('visible') ?? false, panel: box('oc-panel'), skip: box('oc-skip'), next: box('oc-next') };
}

// ── Run ──────────────────────────────────────────────────────────────────
const { chromium } = await import('playwright');
const { browserArgs } = await import('./lib/browser-args.mjs');
let browser;
try {
  if (OWN_STACK) {
    start('npx tsx src/server/index.ts', { PORT: '8091', PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV: '1' });
    await waitUp('http://127.0.0.1:8091/health');
    start('npx vite --port 3101 --strictPort', { PIRATES_BR_SERVER_PORT: '8091' });
    await waitUp('http://127.0.0.1:3101/');
  }
  browser = await chromium.launch({ args: browserArgs() });

  // 1. Touch: menu, onboarding, then a match resized through every size.
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('    PAGEERROR', e.message));
  // Veteran storage: no countdown card, and every first-time tip already seen, so
// the HUD rows measure the HUD; the tip rows below raise one on purpose.
await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); const all = ['wheel', 'hole', 'cannon', 'storm']; localStorage.setItem('piratesBR.tipsSeen', JSON.stringify({ mouse: all, gamepad: all, touch: all })); } catch { /* private */ } });
  const openMenu = async () => {
    await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 90_000 });
    await page.waitForTimeout(500);
  };
  await openMenu();
  console.log('\nMenu (touch)');
  for (const [w, h] of [...MENU_GRADED, ...MENU_REPORTED]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
    const m = await page.evaluate(measureMenu);
    report.rows.push({ kind: 'menu', w, h, m });
    await shot(page, `menu-${w}x${h}`);
    const graded = MENU_GRADED.some(([a, b]) => a === w && b === h);
    expect(`menu ${w}x${h}: layout viewport is the device viewport`, m.W === w && m.H === h, `${m.W}x${m.H}`);
    const scroll = `screen ${m.screen?.sh}/${m.screen?.ch}, panel ${m.panel?.sh}/${m.panel?.ch}, title ${m.titlePx}px`;
    if (graded) {
      expect(`menu ${w}x${h}: no nested scroll`, !!m.screen && !!m.panel && m.screen.sh <= m.screen.ch + 4 && m.panel.sh <= m.panel.ch + 4, scroll);
      expect(`menu ${w}x${h}: every main-panel control inside the viewport`, m.outside.length === 0, m.outside.join('; '));
    } else {
      expect(`menu ${w}x${h}: every main-panel control reachable (inside, or the screen scrolls)`, m.outside.length === 0 || (m.screen && m.screen.sh > m.screen.ch), `${scroll}; ${m.outside.join('; ')}`);
    }
    expect(`menu ${w}x${h}: text inputs >= 16 px`, m.small.length === 0, m.small.join('; '));
  }
  console.log('\nOnboarding cards (touch)');
  for (const [w, h] of ONBOARD) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => { document.getElementById('menu-howto-btn')?.click(); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { document.getElementById('howto-cards-btn')?.click(); });
    await page.waitForTimeout(500);
    const c = await page.evaluate(measureCards);
    report.rows.push({ kind: 'cards', w, h, c });
    await shot(page, `cards-${w}x${h}`);
    const fmt = (b) => b.missing ? 'missing' : `[${Math.round(b.y0)}..${Math.round(b.y1)}] hit ${b.hit}`;
    expect(`cards ${w}x${h}: open`, c.open);
    expect(`cards ${w}x${h}: layout viewport is the device viewport`, c.W === w && c.H === h, `${c.W}x${c.H}`);
    expect(`cards ${w}x${h}: panel inside the viewport`, c.panel.inside, fmt(c.panel));
    // One card now (b1.5g): Skip is hidden beside a button that already closes it.
    expect(`cards ${w}x${h}: Skip hidden or inside and hittable`, c.skip.missing || c.skip.hidden || (c.skip.inside && c.skip.hit), fmt(c.skip));
    expect(`cards ${w}x${h}: its button inside and hittable`, c.next.inside && c.next.hit, fmt(c.next));
    await openMenu();
  }

  console.log('\nMatch (touch)');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.tap('#menu-solo-btn', { noWaitAfter: true });
  const playing = await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing' && !!window.__piratesBR.getLocalPlayer?.(),
    null, { timeout: 150_000 }).then(() => true, () => false);
  if (!expect('touch: a solo match reaches phase playing', playing)) throw new Error('no match');
  await page.evaluate(() => document.fullscreenElement && document.exitFullscreen?.()).catch(() => {});
  await page.waitForTimeout(2500);
  for (const [w, h] of TOUCH_MATCH) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    const m = await page.evaluate(measureHud);
    report.rows.push({ kind: 'hud', w, h, touch: true, m });
    await shot(page, `hud-touch-${w}x${h}`);
    gradeHud(`hud ${w}x${h}`, m, { touch: true, w, h });
  }
  // FIRST-TIME TIP ROWS (b1.5g): the one-line tip at the centre prompt fits the
  // glass and its dismiss control is reachable by a finger (elementFromPoint at
  // its centre lands on it; touch.css lets touches through the other centre
  // children), at the phone and the iPad sizes.
  console.log('\nFirst-time tip (touch)');
  for (const [w, h] of [[844, 390], [1024, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__piratesBR.hud.firstTips.show('wheel'); });
    await page.waitForTimeout(350);
    const t = await page.evaluate(() => {
      const W = innerWidth, H = innerHeight;
      const box = (id) => {
        const el = document.getElementById(id);
        if (!el) return { id, missing: true };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return { id, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, w: r.width, h: r.height,
          inside: r.width > 1 && r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1,
          hit: !!hit && (hit === el || el.contains(hit)), hitId: hit?.id ?? hit?.tagName ?? '' };
      };
      return { W, H, shown: !!document.getElementById('first-tip')?.classList.contains('visible'), tip: box('first-tip'), dismiss: box('first-tip-dismiss'),
        text: document.querySelector('#first-tip .ft-text')?.textContent ?? '' };
    });
    const m = await page.evaluate(measureHud);
    report.rows.push({ kind: 'tip', w, h, t });
    await shot(page, `tip-${w}x${h}`);
    const fmt = (b) => b.missing ? 'missing' : `[${Math.round(b.x0)},${Math.round(b.y0)}..${Math.round(b.x1)},${Math.round(b.y1)}] hit ${b.hit} (${b.hitId})`;
    expect(`tip ${w}x${h}: shown with touch copy`, t.shown && /‹[^›]+›/.test(t.text), t.text);
    expect(`tip ${w}x${h}: box inside the viewport`, !t.tip.missing && t.tip.inside, fmt(t.tip));
    expect(`tip ${w}x${h}: dismiss inside and hittable`, !t.dismiss.missing && t.dismiss.inside && t.dismiss.hit, fmt(t.dismiss));
    expect(`tip ${w}x${h}: dismiss is a finger-sized target (>= 40 px)`, (t.dismiss.w ?? 0) >= 40 && (t.dismiss.h ?? 0) >= 40, `${t.dismiss.w}x${t.dismiss.h}`);
    gradeHud(`hud ${w}x${h} with a tip up`, m, { touch: true, w, h });
    await page.tap('#first-tip-dismiss').catch(() => {});
    await page.waitForTimeout(250);
    const gone = await page.evaluate(() => !document.getElementById('first-tip')?.classList.contains('visible'));
    expect(`tip ${w}x${h}: a tap on dismiss closes it`, gone);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const port = await page.evaluate(measureHud);
  report.rows.push({ kind: 'hud', w: 390, h: 844, touch: true, rotateShown: port.rotateShown });
  expect('hud 390x844: the rotate card covers the screen', port.rotateShown);
  await ctx.close();

  // 2. Desktop mouse, 960x540.
  console.log('\nMatch (desktop mouse)');
  const dctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => console.log('    PAGEERROR', e.message));
  await dp.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
  await dp.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dp.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 90_000 });
  const dm = await dp.evaluate(measureMenu);
  expect('menu 960x540: text inputs >= 16 px', dm.small.length === 0, dm.small.join('; '));
  await dp.click('#menu-solo-btn', { noWaitAfter: true });
  const dplay = await dp.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing' && !!window.__piratesBR.getLocalPlayer?.(),
    null, { timeout: 150_000 }).then(() => true, () => false);
  if (expect('desktop: a solo match reaches phase playing', dplay)) {
    await dp.waitForTimeout(2500);
    const m = await dp.evaluate(measureHud);
    report.rows.push({ kind: 'hud', w: 960, h: 540, touch: false, m });
    await shot(dp, 'hud-mouse-960x540');
    gradeHud('hud 960x540', m, { touch: false, w: 960, h: 540 });
  }
  await dctx.close();
} catch (e) {
  expect('run completed', false, String(e?.message ?? e).split('\n')[0]);
} finally {
  await browser?.close().catch(() => {});
  if (OWN_STACK) stopStack();
  try { mkdirSync(dirname(JSON_OUT), { recursive: true }); writeFileSync(JSON_OUT, JSON.stringify(report, null, 1)); } catch { /* best effort */ }
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ responsive HUD holds');
process.exit(failures ? 1 : 0);
