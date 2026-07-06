import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = 'test-results/audit-noon';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0]-p[0], dy = t[1]-p[1], dz = t[2]-p[2];
    const len = Math.hypot(dx,dy,dz)||1;
    g.enableFreeCam(p[0],p[1],p[2], Math.atan2(dx/len,dz/len), Math.asin(dy/len));
  }, [pos, target]);
}
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { const e=document.createElement('style'); e.textContent='#hud{opacity:0!important;visibility:hidden!important;}'; document.head.appendChild(e); });
await wait(500);
const world = await page.evaluate(() => (window.__piratesBR.state.islands ?? []).map((i)=>({name:i.name,x:i.position.x,z:i.position.z,radius:i.radius,gY:window.__piratesBR.sampleGroundY(i.position.x,i.position.z),style:i.profile?.terrainStyle})));
const want = ['Gallows','Parley','Old Maw','Widow'];
let n = 10;
for (const w of want) {
  const isl = world.find((i)=>i.name.includes(w));
  if (!isl) continue;
  n++;
  const label = `${String(n).padStart(2,'0')}-${isl.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}`;
  const r = Math.max(30, isl.radius), peak = Math.max(isl.gY, 12);
  try {
    await freeLook([isl.x + r*1.7, peak + r*0.85 + 34, isl.z + r*1.7], [isl.x, peak*0.45, isl.z]);
    await wait(650); await shot(`${label}-aerial`);
  } catch(e){ console.log('fail', label, String(e).slice(0,80)); }
}
// diag topdown of the volcano (Old Maw Caldera) and the tallest mountain
const mtn = [...world].sort((a,b)=>b.gY-a.gY)[0];
try {
  await freeLook([mtn.x + 1, mtn.gY + mtn.radius*1.6 + 60, mtn.z + 1], [mtn.x, mtn.gY, mtn.z]);
  await wait(700); await shot(`diag-topdown-${mtn.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}`);
} catch(e){ console.log('topdown fail', String(e).slice(0,80)); }
// also a topdown of a tropical island for terrain-shape read
const trop = world.find((i)=>i.style==='tropical');
try {
  await freeLook([trop.x + 1, trop.gY + trop.radius*1.6 + 60, trop.z + 1], [trop.x, trop.gY, trop.z]);
  await wait(700); await shot(`diag-topdown-${trop.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}`);
} catch(e){ console.log('topdown2 fail', String(e).slice(0,80)); }
await browser.close();
console.log('done');
