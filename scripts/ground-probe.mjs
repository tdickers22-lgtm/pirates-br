// Low ground-level shots on an island: vegetation + buildings up close.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/ground';
const WANT = process.argv[3] ?? 'Castaway';
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
const isl = await page.evaluate((want) => {
  const g = window.__piratesBR;
  const a = (g.state.islands ?? []).find((i)=>i.name.includes(want)) ?? g.state.islands[0];
  const gy = g.sampleGroundY(a.position.x, a.position.z);
  return { name:a.name, x:a.position.x, z:a.position.z, r:a.radius, gy,
    tavern: a.tavern ? {x:a.tavern.x ?? a.position.x, z:a.tavern.z ?? a.position.z} : null };
}, WANT);
console.log('island', isl.name, 'r', isl.r.toFixed(0), 'gy', isl.gy.toFixed(1));
const g = (x,z) => 0; // placeholder
// eye-level walk across interior (4 headings), camera ~2.6m above ground near center
const cx = isl.x, cz = isl.z;
const gy = await page.evaluate(([x,z]) => window.__piratesBR.sampleGroundY(x,z), [cx, cz]);
for (const [i, ang] of [0, Math.PI*0.5, Math.PI, Math.PI*1.5].entries()) {
  const ox = cx + Math.sin(ang) * isl.r * 0.45;
  const oz = cz + Math.cos(ang) * isl.r * 0.45;
  const oy = await page.evaluate(([x,z]) => window.__piratesBR.sampleGroundY(x,z), [ox, oz]);
  await freeLook([ox, oy + 2.4, oz], [cx, gy + 3.5, cz]);
  await wait(600);
  await page.screenshot({ path: `${OUT}/interior-${i}.png`, timeout: 60000 });
}
// close vegetation macro: very low, looking along the ground
const vx = cx + isl.r * 0.3, vz = cz + isl.r * 0.3;
const vy = await page.evaluate(([x,z]) => window.__piratesBR.sampleGroundY(x,z), [vx, vz]);
await freeLook([vx, vy + 1.3, vz], [cx, gy + 1.6, cz]);
await wait(600);
await page.screenshot({ path: `${OUT}/veg-macro.png`, timeout: 60000 });
await browser.close();
console.log('ground shots done');
