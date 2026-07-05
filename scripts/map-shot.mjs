// Open the full map (M), screenshot it, then scroll-zoom and screenshot again.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/map';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await page.waitForTimeout(4500);

await page.keyboard.press('m'); // open map
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/01-map-full.png`, timeout: 60000 });

// Scroll to zoom in over the map centre.
await page.mouse.move(800, 450);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(120); }
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-map-zoomed.png`, timeout: 60000 });
await browser.close();
console.log(`map shots in ${OUT}/`);
