// Verify no "red water" appears over a combat-heavy multi-minute session.
import { chromium } from 'playwright';
const OUT = process.argv[2] ?? 'test-results/redcheck';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
for (const t of [25, 55, 90, 125]) {
  await page.waitForTimeout(t === 25 ? 25000 : 30000);
  await page.evaluate(() => window.__piratesBR.enableFreeCam(0, 14, 0, 0.7, -0.12));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/red-${t}s.png` });
  console.log(`shot t=${t}s`);
}
await browser.close();
