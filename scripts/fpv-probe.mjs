// First-person gameplay views: each weapon's viewmodel + HUD, hip & ADS.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/fpv';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:3000/?debug&quality=high&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await wait(3500);
// look toward the horizon (level)
const look = (yaw, pitch = -0.02) => page.evaluate(([y,p]) => window.__piratesBR?.input?.setLook(y, p), [yaw, pitch]);
await look(Math.PI * 0.25);
await wait(400);
// cycle weapons 1..4 and shoot hip + ads for each
for (const [slot, name] of [['1','blunderbuss'],['2','sniper'],['3','flintlock'],['4','cutlass']]) {
  await page.keyboard.press(slot);
  await wait(500);
  await page.screenshot({ path: `${OUT}/${slot}-${name}-hip.png`, timeout: 60000 });
  await page.mouse.down({ button: 'right' });   // aim
  await wait(500);
  await page.screenshot({ path: `${OUT}/${slot}-${name}-ads.png`, timeout: 60000 });
  await page.mouse.up({ button: 'right' });
  await wait(200);
}
await browser.close();
console.log('fpv shots done');
