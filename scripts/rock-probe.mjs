import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/rock';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx=t[0]-p[0], dy=t[1]-p[1], dz=t[2]-p[2]; const len=Math.hypot(dx,dy,dz)||1;
    g.enableFreeCam(p[0],p[1],p[2], Math.atan2(dx/len,dz/len), Math.asin(dy/len));
  }, [pos, target]);
}
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await wait(3500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { const e=document.createElement('style'); e.textContent='#hud{visibility:hidden!important;}'; document.head.appendChild(e); });
await wait(500);
const rocks = await page.evaluate(() => (window.__piratesBR.state.seaRocks ?? []).map((r)=>({id:r.id,x:r.position.x,y:r.position.y,z:r.position.z,radius:r.radius,height:r.height,variant:r.variant})));
rocks.sort((a,b)=>b.height-a.height);
console.log('rocks:', rocks.length, 'tallest h=', rocks[0]?.height?.toFixed(1));
for (const [i, r] of [rocks[0], rocks[1], rocks[Math.floor(rocks.length/2)]].filter(Boolean).entries()) {
  await freeLook([r.x + r.radius*2.2, r.height*0.55, r.z + r.radius*2.2], [r.x, r.height*0.45, r.z]);
  await wait(600);
  await page.screenshot({ path: `${OUT}/rock-${i}-h${Math.round(r.height)}.png`, timeout: 60000 });
}
await browser.close();
console.log('rock shots done');
