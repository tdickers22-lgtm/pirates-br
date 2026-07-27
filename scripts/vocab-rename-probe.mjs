// VOCABULARY PROBE — every surface the rename touched, photographed live.
//
// node scripts/vocab-rename-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/vocab-rename';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

// Other agents editing this tree make vite full-reload mid-probe.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

const readings = {};
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await wait(600);
readings.menuSubtitle = await page.evaluate(() =>
  document.querySelector('#menu-screen .subtitle')?.textContent ?? '');
readings.loadingSubtitle = await page.evaluate(() =>
  document.querySelector('#loading-screen .subtitle')?.textContent ?? '');
readings.loadingMode = await page.evaluate(() => document.getElementById('loading-mode')?.textContent ?? '');
await shot('01-menu');

await page.click('#menu-howto-btn', { noWaitAfter: true });
await wait(400);
readings.howto = await page.evaluate(() =>
  (document.getElementById('menu-panel-howto')?.textContent ?? '').replace(/\s+/g, ' ').trim());
await shot('02-how-to-play');
// Reload rather than clicking Back: the panel swap is animated and a probe that
// races it clicks a hidden Solo button and waits forever for a match.
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 30_000 });
await wait(700);
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.network?.isJoined?.() === true, null, { timeout: 90_000 });
console.log('joined');
// Sample the ceremony hint every 250 ms so BOTH beats are caught: the crew-found
// card (which names the Black Fin) and the countdown (which names the Reach).
readings.ceremonyLines = await page.evaluate(async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = document.getElementById('ms-hint')?.textContent ?? '';
    if (t) seen.add(t);
    if (window.__piratesBR?.state?.phase === 'playing') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...seen];
});
// Catch the start ceremony (crew-found card names the Black Fin).
await page.waitForFunction(() => {
  const el = document.getElementById('ms-hint');
  return !!el && (el.textContent ?? '').length > 0
    && getComputedStyle(document.getElementById('match-start-seq')).display !== 'none';
}, null, { timeout: 120_000 }).catch(() => {});
readings.ceremonyHint = await page.evaluate(() => document.getElementById('ms-hint')?.textContent ?? '');
await shot('03-start-ceremony');

await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
await wait(3000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(800);

readings.weaponSlots = await page.evaluate(() =>
  [...document.querySelectorAll('#weapon-slots .wname')].map((e) => e.textContent));
// A long name must not overflow its tile nor break the row's alignment.
readings.slotBoxes = await page.evaluate(() => [...document.querySelectorAll('.weapon-slot')].map((el) => {
  const r = el.getBoundingClientRect();
  return { h: Math.round(r.height), top: Math.round(r.top), clipped: el.scrollHeight > el.clientHeight + 1 };
}));
readings.shipStatusTitle = await page.evaluate(() =>
  document.getElementById('ship-status-title')?.textContent ?? '');
readings.shipStores = await page.evaluate(() =>
  [...document.querySelectorAll('.ship-inventory-label')].map((e) => e.textContent).join(' · '));
readings.minimapTitle = await page.evaluate(() => document.getElementById('minimap-title')?.textContent ?? '');
readings.pocketStrip = await page.evaluate(() => document.getElementById('pocket-strip')?.textContent ?? '');
await shot('04-hud');

// Supply wheel — the PLANTAIN slice.
await page.keyboard.down('KeyI');
await wait(900);
readings.wheelLabels = await page.evaluate(() =>
  [...document.querySelectorAll('#pocket-wheel-svg .wheel-label')].map((e) => e.textContent).join(' · '));
await shot('05-supply-wheel');
await page.keyboard.up('KeyI');
await wait(400);

// The chart panel (route line) — force it visible to photograph its copy.
readings.chartRoute = await page.evaluate(() => {
  document.getElementById('treasure-chart')?.classList.add('visible');
  return document.getElementById('treasure-chart-route')?.textContent ?? '';
});
await shot('06-treasure-chart');

// Kill feed carries the Tallyman payout line.
readings.feed = await page.evaluate(async () => {
  const g = window.__piratesBR;
  g.hud.resetForMatch();
  g.hud.pushFeed('Chest stowed aboard: base 690 gold before Tallyman payout.', '#d9c17e');
  g.hud.pushFeed("Tallyman's chart: Booty Bay (3 X marks).", '#d9c17e');
  await new Promise((r) => requestAnimationFrame(r));
  const el = document.getElementById('kill-feed');
  return [...el.children].map((c) => c.textContent).join(' | ');
});
await shot('07-kill-feed');

// Fullscreen chart.
await page.keyboard.press('KeyM');
await wait(1400);
readings.mapTitle = await page.evaluate(() => document.getElementById('map-title')?.textContent ?? '');
await shot('08-map');
await page.keyboard.press('KeyM');
await wait(400);

// Controls card ([L]) — the win-condition copy names the Tallyman.
await page.keyboard.press('KeyL');
await wait(600);
readings.legend = await page.evaluate(() =>
  (document.getElementById('legend-body')?.textContent ?? '').replace(/\s+/g, ' ').trim());
await shot('09-controls-card');

console.log(JSON.stringify(readings, null, 2));
await browser.close();
