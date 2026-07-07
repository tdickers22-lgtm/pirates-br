import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/building';
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
const info = await page.evaluate(() => {
  const g = window.__piratesBR;
  const withTav = (g.state.islands ?? []).find((i)=>i.tavern);
  const withFort = (g.state.islands ?? []).find((i)=>(i.props ?? []).some((p)=>p.type==='fort'));
  const out = {};
  if (withTav) out.tavern = { x: withTav.tavern.position.x, z: withTav.tavern.position.z, gy: g.sampleGroundY(withTav.tavern.position.x, withTav.tavern.position.z) };
  if (withFort) { const f = withFort.props.find((p)=>p.type==='fort'); out.fort = { x: f.x, z: f.z, gy: g.sampleGroundY(f.x, f.z) }; }
  return out;
});
console.log(JSON.stringify(info));
if (info.tavern) {
  const { x, z, gy } = info.tavern;
  await freeLook([x + 9, gy + 4, z + 9], [x, gy + 2.5, z]);
  await wait(600); await page.screenshot({ path: `${OUT}/tavern.png`, timeout: 60000 });
}
if (info.fort) {
  const { x, z, gy } = info.fort;
  await freeLook([x + 16, gy + 9, z + 16], [x, gy + 4, z]);
  await wait(600); await page.screenshot({ path: `${OUT}/fort.png`, timeout: 60000 });
}
await browser.close();
console.log('building shots done');
