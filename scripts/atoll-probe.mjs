import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/atoll';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await wait(3200);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { const e=document.createElement('style'); e.textContent='#hud{visibility:hidden!important;}'; document.head.appendChild(e); });
const isl = await page.evaluate(() => {
  const g = window.__piratesBR;
  const a = (g.state.islands ?? []).find((i)=>i.name.includes('Atoll')) ?? g.state.islands[0];
  return { x:a.position.x, z:a.position.z, r:a.radius, gY:g.sampleGroundY(a.position.x,a.position.z) };
});
await page.evaluate(([x,z,r,gY]) => {
  const g = window.__piratesBR;
  const px=x+r*1.7, py=Math.max(gY,12)+r*0.85+34, pz=z+r*1.7;
  const dx=x-px, dy=Math.max(gY,12)*0.45-py, dz=z-pz; const len=Math.hypot(dx,dy,dz);
  g.enableFreeCam(px,py,pz, Math.atan2(dx/len,dz/len), Math.asin(dy/len));
}, [isl.x, isl.z, isl.r, isl.gY]);
await wait(700);
await page.screenshot({ path: `${OUT}/atoll.png`, timeout: 60000 });
await browser.close();
console.log('atoll shot done');
