import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/char';
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
const npc = await page.evaluate(() => {
  const g = window.__piratesBR;
  for (const i of g.state.islands ?? []) {
    if ((i.npcs ?? []).length) { const n = i.npcs[0]; return { x: n.position.x, y: n.position.y, z: n.position.z }; }
  }
  return null;
});
console.log('npc', JSON.stringify(npc));
if (npc) {
  const gy = await page.evaluate(([x,z]) => window.__piratesBR.sampleGroundY(x,z), [npc.x, npc.z]);
  await freeLook([npc.x + 2.4, gy + 1.7, npc.z + 2.4], [npc.x, gy + 1.3, npc.z]);
  await wait(700);
  await page.screenshot({ path: `${OUT}/npc.png`, timeout: 60000 });
}
await browser.close();
console.log('char shot done');
