#!/usr/bin/env node
// MOBILE SHELL (b1.5a; crossdevice-03, crossdevice-06, crossdevice-10).
//
// Logic half (default, no ports, < 1 s):
//  • viewport meta has width=device-width, initial-scale=1 AND viewport-fit=cover
//    (without cover, env(safe-area-inset-*) reads 0 on iOS and the notch eats
//    the gold display).
//  • public/manifest.webmanifest parses, has name/short_name/start_url/scope,
//    display fullscreen (+ display_override), orientation landscape, colours,
//    and icons 192 + 512 + a maskable 512, every one on disk at its declared
//    pixel size (PNG IHDR read, not trusted from the file name).
//  • index.html links the manifest and an apple-touch-icon 180 that exists at
//    180x180, carries apple-mobile-web-app-capable, mobile-web-app-capable,
//    apple-mobile-web-app-status-bar-style, apple-mobile-web-app-title and
//    theme-color, links mobile.css AFTER hud.css, loads MobileShell.
//  • every #hud-* region in index.html sits inside a region whose rule in
//    mobile.css uses env(safe-area-inset-*), and each outer region pads every
//    edge it is anchored to.
//  • mobile.css: html/body/canvas touch-action none, menu scroll panels pan-y.
//  • MobileShell's pure rules: gestures blocked on touch devices and in a match
//    only; ctrl-wheel blocked in a match only; rotate card only for a phone in
//    portrait in a match; fullscreen only on a touch device from a Play press.
//
// Browser half (`--browser`, needs the 3101/8091 stack; PIRATES_BR_URL):
// one headless SwiftShader Chromium, 390x844 isMobile+hasTouch.
//  • CDP two-finger pinch and a double-tap in a match leave visualViewport.scale
//    == 1 (5 at f5fee97e); the same pinch on the menu leaves it at 1.
//  • a cancelable ctrl-wheel on window is defaultPrevented in a match and NOT on
//    the menu (desktop accessibility zoom stays).
//  • the rotate card is visible at 390x844 in a match and hidden at 844x390.
//  • pressing Play on a touch device asks for fullscreen (Android path).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.argv.includes('--browser');
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const read = (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return ''; } };
function pngSize(p) {
  try {
    const b = readFileSync(resolve(ROOT, p));
    if (b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { return null; }
}
const html = read('index.html');
const css = read('src/client/styles/mobile.css');
const metaContent = (name) => {
  const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'i'));
  return m ? (m[0].match(/content=["']([^"']*)["']/i)?.[1] ?? '') : null;
};
const linkHref = (rel) => {
  const m = html.match(new RegExp(`<link[^>]+rel=["']${rel}["'][^>]*>`, 'i'));
  return m ? (m[0].match(/href=["']([^"']*)["']/i)?.[1] ?? '') : null;
};
const publicPath = (href) => `public${href.startsWith('/') ? '' : '/'}${href.split('?')[0]}`;

// ── Viewport + metas ──────────────────────────────────────────────────────
console.log('\nViewport and web-app metas');
const vp = metaContent('viewport') ?? '';
expect('viewport has width=device-width and initial-scale=1', /width=device-width/.test(vp) && /initial-scale=1(\.0)?\b/.test(vp), vp);
expect('viewport has viewport-fit=cover', /viewport-fit=cover/.test(vp), vp);
expect('apple-mobile-web-app-capable = yes', metaContent('apple-mobile-web-app-capable') === 'yes');
expect('mobile-web-app-capable = yes', metaContent('mobile-web-app-capable') === 'yes');
expect('apple-mobile-web-app-status-bar-style = black-translucent', metaContent('apple-mobile-web-app-status-bar-style') === 'black-translucent');
expect('apple-mobile-web-app-title set', !!metaContent('apple-mobile-web-app-title'));
expect('theme-color is a colour', /^#[0-9a-f]{6}$/i.test(metaContent('theme-color') ?? ''), metaContent('theme-color') ?? 'missing');
const apple = linkHref('apple-touch-icon');
const appleSize = apple ? pngSize(publicPath(apple)) : null;
expect('apple-touch-icon exists at 180x180', appleSize?.w === 180 && appleSize?.h === 180, `${apple} ${JSON.stringify(appleSize)}`);
const hudIdx = html.indexOf('styles/hud.css');
const mobIdx = html.indexOf('styles/mobile.css');
expect('mobile.css is linked AFTER hud.css (it adds to the HUD regions)', hudIdx > 0 && mobIdx > hudIdx);
expect('MobileShell is loaded by index.html', /<script[^>]+src=["'][^"']*MobileShell\.ts["']/.test(html));
expect('the portrait rotate card is in the DOM', /id=["']rotate-card["']/.test(html));

// ── Manifest ──────────────────────────────────────────────────────────────
console.log('\nManifest');
const mHref = linkHref('manifest');
expect('index.html links a manifest', !!mHref, String(mHref));
let manifest = null;
try { manifest = JSON.parse(read(mHref ? publicPath(mHref) : 'public/manifest.webmanifest')); } catch (e) { expect('manifest parses as JSON', false, String(e)); }
if (manifest) {
  expect('name + short_name', !!manifest.name && !!manifest.short_name && manifest.short_name.length <= 12, `${manifest.name} / ${manifest.short_name}`);
  expect('start_url and scope are same-origin paths', /^\//.test(manifest.start_url ?? '') && manifest.scope === '/');
  expect('display fullscreen with a standalone fallback', manifest.display === 'fullscreen'
    && Array.isArray(manifest.display_override) && manifest.display_override.includes('standalone'));
  expect('orientation landscape', manifest.orientation === 'landscape');
  expect('background + theme colours', /^#[0-9a-f]{6}$/i.test(manifest.background_color ?? '') && /^#[0-9a-f]{6}$/i.test(manifest.theme_color ?? ''));
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const has = (px, purpose) => icons.some((i) => i.sizes === `${px}x${px}` && (i.purpose ?? 'any').split(/\s+/).includes(purpose));
  expect('icons 192 + 512 (any) and 512 maskable declared', has(192, 'any') && has(512, 'any') && has(512, 'maskable'));
  for (const icon of icons) {
    const size = pngSize(publicPath(icon.src));
    const [w, h] = String(icon.sizes).split('x').map(Number);
    expect(`icon ${icon.src} is a PNG at its declared ${icon.sizes}`, icon.type === 'image/png' && size?.w === w && size?.h === h, JSON.stringify(size));
  }
}

// ── Safe areas ────────────────────────────────────────────────────────────
console.log('\nSafe-area insets on every HUD region');
// Outer HUD regions and the edges each one is anchored to (hud.css).
const OUTER = {
  'hud-top-nav': ['top', 'left', 'right'],
  'hud-right-tactical': ['top', 'right', 'bottom'],
  'hud-center-prompt': ['bottom'],
  'hud-bottom-combat': ['left', 'right', 'bottom'],
};
const ruleFor = (id) => {
  const m = css.match(new RegExp(`(^|[\\s,}])#${id}\\s*[,{][^}]*}`, 'm'));
  return m ? m[0] : '';
};
for (const [id, edges] of Object.entries(OUTER)) {
  const rule = ruleFor(id);
  const missing = edges.filter((e) => !new RegExp(`env\\(safe-area-inset-${e}`).test(rule));
  expect(`#${id} pads ${edges.join('/')} with env(safe-area-inset-*)`, rule && missing.length === 0, rule ? `missing ${missing.join(',')}` : 'no rule in mobile.css');
}
// Every id="hud-*" element must be an outer region or live inside one.
function spans(id) {
  const open = html.search(new RegExp(`<([a-z]+)[^>]*\\bid=["']${id}["']`));
  if (open < 0) return null;
  const tag = html.slice(open + 1).match(/^[a-z]+/)[0];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let m; (m = re.exec(html));) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return [open, m.index];
  }
  return null;
}
const outerSpans = Object.keys(OUTER).map((id) => [id, spans(id)]);
const hudIds = [...html.matchAll(/\bid=["'](hud-[a-z0-9-]+)["']/g)].map((m) => [m[1], m.index]);
expect('index.html has #hud-* regions to check', hudIds.length >= 4, String(hudIds.length));
const orphans = hudIds.filter(([id, at]) => !OUTER[id] && !outerSpans.some(([, s]) => s && at > s[0] && at < s[1])).map(([id]) => id);
expect('no #hud-* element sits outside a safe-area-padded region', orphans.length === 0, orphans.join(', '));

// ── Touch-action ──────────────────────────────────────────────────────────
console.log('\nTouch-action');
const ta = (sel) => new RegExp(`${sel.replace(/[.#[\]"=]/g, (c) => `\\${c}`)}[^{]*{[^}]*touch-action:\\s*none`).test(css);
expect('html/body touch-action none (no pinch or double-tap zoom anywhere)', /html,\s*body\s*{[^}]*touch-action:\s*none/.test(css));
expect('canvas touch-action none', ta('canvas'));
const panY = css.match(/([^{}]+){[^}]*touch-action:\s*pan-y/)?.[1] ?? '';
for (const sel of ['.menu-panel', '#menu-panel-howto', '#stats-panel', '.lobby-roster', '#endmatch-board', '#death-panel']) {
  expect(`${sel} scrolls with a finger (pan-y)`, panY.includes(sel));
}

// ── MobileShell rules (pure) ──────────────────────────────────────────────
console.log('\nMobileShell rules');
let MS = null;
try { MS = await import('../src/client/input/MobileShell.ts'); } catch (e) { expect('import MobileShell.ts', false, String(e?.message ?? e).split('\n')[0]); }
if (MS) {
  const s = (o) => ({ inMatch: false, coarse: false, phone: false, portrait: false, ...o });
  expect('desktop menu: gestures and ctrl-wheel pass through (accessibility zoom)',
    !MS.blockGesture(s({})) && !MS.blockCtrlWheel(s({})) && !MS.blockTouchMove(2, s({})));
  expect('desktop match: gestures and ctrl-wheel blocked', MS.blockGesture(s({ inMatch: true })) && MS.blockCtrlWheel(s({ inMatch: true })));
  expect('touch device: gestures and 2-finger touchmove blocked even on the menu',
    MS.blockGesture(s({ coarse: true })) && MS.blockTouchMove(2, s({ coarse: true })));
  expect('one-finger touchmove never blocked by the shell (menu scroll, stick)', !MS.blockTouchMove(1, s({ coarse: true, inMatch: true })));
  expect('isPhone: 390x844 coarse = phone, 1024x768 coarse = tablet, 390x844 fine = no',
    MS.isPhone(390, 844, true) && !MS.isPhone(1024, 768, true) && !MS.isPhone(390, 844, false));
  expect('rotate card only for a phone, portrait, in a match',
    MS.showRotateCard(s({ phone: true, portrait: true, inMatch: true }))
    && !MS.showRotateCard(s({ phone: true, portrait: false, inMatch: true }))
    && !MS.showRotateCard(s({ phone: true, portrait: true, inMatch: false }))
    && !MS.showRotateCard(s({ phone: false, portrait: true, inMatch: true })));
  expect('fullscreen on Play only for touch devices, not in an installed app',
    MS.wantsFullscreen({ coarse: true, standalone: false, fullscreenEnabled: true, isFullscreen: false })
    && !MS.wantsFullscreen({ coarse: false, standalone: false, fullscreenEnabled: true, isFullscreen: false })
    && !MS.wantsFullscreen({ coarse: true, standalone: true, fullscreenEnabled: true, isFullscreen: false }));
}

// ── Browser half ──────────────────────────────────────────────────────────
if (BROWSER) {
  const { chromium } = await import('playwright');
  const { browserArgs } = await import('./lib/browser-args.mjs');
  const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
  const browser = await chromium.launch({ args: browserArgs() });
  let context;
  try {
    console.log('\nBrowser: 390x844 phone (isMobile + hasTouch)');
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('    PAGEERROR', e.message));
    await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
    const cdp = await context.newCDPSession(page);
    const scale = () => page.evaluate(() => window.visualViewport?.scale ?? -1);
    const pinch = async (x, y) => {
      await cdp.send('Input.synthesizePinchGesture', { x, y, scaleFactor: 3, relativeSpeed: 600, gestureSourceType: 'touch' }).catch((e) => console.log('    pinch err', e.message));
      await page.waitForTimeout(400);
      return scale();
    };
    const doubleTap = async (x, y) => {
      await cdp.send('Input.synthesizeTapGesture', { x, y, tapCount: 2, gestureSourceType: 'touch' }).catch((e) => console.log('    tap err', e.message));
      await page.waitForTimeout(500);
      return scale();
    };
    const ctrlWheel = () => page.evaluate(() => {
      const ev = new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true, bubbles: true, clientX: 100, clientY: 100 });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 90_000 });
    expect('menu: ctrl-wheel is NOT prevented (desktop accessibility zoom)', (await ctrlWheel()) === false);
    const fsBefore = await page.evaluate(() => window.__mobileShell?.fullscreenRequests ?? -1);
    await page.tap('#menu-solo-btn', { noWaitAfter: true });
    const playing = await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing' && !!window.__piratesBR.getLocalPlayer?.(),
      null, { timeout: 150_000 }).then(() => true, () => false);
    expect('a solo match reaches phase playing', playing);
    if (!playing) throw new Error('no match');
    const fsAfter = await page.evaluate(() => window.__mobileShell?.fullscreenRequests ?? -1);
    expect('Play on a touch device asks for fullscreen', fsBefore >= 0 && fsAfter > fsBefore, `${fsBefore} -> ${fsAfter}`);
    const fsEl = await page.evaluate(() => document.fullscreenElement?.tagName ?? null);
    console.log(`    fullscreen element after Play: ${fsEl ?? 'none (headless may refuse; the request is what is graded)'}`);
    await page.waitForTimeout(600);
    const card = () => page.evaluate(() => {
      const el = document.getElementById('rotate-card');
      if (!el) return { shown: false, why: 'missing' };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width >= innerWidth - 1 && r.height >= innerHeight - 1, w: r.width, h: r.height };
    });
    const portrait = await card();
    expect('390x844 in a match: the rotate card covers the screen', portrait.shown, JSON.stringify(portrait));
    // A fullscreen window cannot be resized; leave it as a player rotating would.
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen?.()).catch(() => {});
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(600);
    const landscape = await card();
    expect('844x390 in a match: the rotate card is gone', !landscape.shown, JSON.stringify(landscape));
    const matchPinch = await pinch(422, 195);
    expect('match: a two-finger pinch on the canvas leaves scale 1', matchPinch === 1, `scale ${matchPinch}`);
    const hudTap = await doubleTap(60, 30);
    expect('match: a double-tap on the HUD leaves scale 1', hudTap === 1, `scale ${hudTap}`);
    expect('match: ctrl-wheel (trackpad pinch) is prevented', (await ctrlWheel()) === true);
    // The menu pinch runs LAST, on a fresh page: a page left zoomed (HEAD:
    // scale 3) swallows every later tap, which would hide the match checks.
    await page.close();
    const menu = await context.newPage();
    const cdp2 = await context.newCDPSession(menu);
    await menu.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await menu.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 90_000 });
    await cdp2.send('Input.synthesizePinchGesture', { x: 195, y: 300, scaleFactor: 3, relativeSpeed: 600, gestureSourceType: 'touch' }).catch((e) => console.log('    pinch err', e.message));
    await menu.waitForTimeout(400);
    const menuPinch = await menu.evaluate(() => window.visualViewport?.scale ?? -1);
    expect('menu (390x844): a pinch leaves visualViewport.scale at 1', menuPinch === 1, `scale ${menuPinch}`);
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ mobile shell holds');
process.exit(failures ? 1 : 0);
