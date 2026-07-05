// Quick check: join solo and open the supply wheel (hold I) to screenshot the
// 8-slot tool+supply wheel. Requires the dev server.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/wheel';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await page.waitForTimeout(3500);

// Open the supply wheel: hold KeyI.
await page.keyboard.down('i');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/01-wheel-open.png`, timeout: 60000 });
// Equip the bucket (slot 2 = Digit3) and re-open to see the highlight.
await page.keyboard.press('Digit3');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/02-bucket-equipped.png`, timeout: 60000 });
await page.keyboard.up('i');
await browser.close();
console.log(`wheel shots in ${OUT}/`);
