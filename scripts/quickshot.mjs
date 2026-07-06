// Fast iteration probe: 4 framed shots (tropical aerial+shore, mountain aerial,
// mountain shore) at a fixed time of day. node scripts/quickshot.mjs [outDir] [tod]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/quick';
const TOD = process.argv[3] ?? 'noon';
const TOD_SEC = { noon: 854, dusk: 240, night: 374, storm: 854 };
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
const stormFlag = TOD === 'storm' ? '&stormdemo' : '';
await page.goto(`http://127.0.0.1:3000/?debug&quality=high${stormFlag}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3200);
await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), TOD_SEC[TOD]);
await page.evaluate(() => { const e=document.createElement('style'); e.textContent='#hud{opacity:0!important;visibility:hidden!important;}'; document.head.appendChild(e); });
await wait(500);
const world = await page.evaluate(() => (window.__piratesBR.state.islands ?? []).map((i)=>({name:i.name,x:i.position.x,z:i.position.z,radius:i.radius,gY:window.__piratesBR.sampleGroundY(i.position.x,i.position.z),style:i.profile?.terrainStyle})));
const pick = (want) => world.find((i)=>i.name.includes(want)) ?? world[0];
const trop = pick('Castaway');
const mtn = pick('Crow');
for (const [isl, tag] of [[trop, 'tropical'], [mtn, 'mountain']]) {
  const r = Math.max(30, isl.radius), peak = Math.max(isl.gY, 12);
  await freeLook([isl.x + r*1.7, peak + r*0.85 + 34, isl.z + r*1.7], [isl.x, peak*0.45, isl.z]);
  await wait(600); await shot(`${tag}-aerial`);
  await freeLook([isl.x, 6.5, isl.z + r*1.85], [isl.x, peak*0.5 + 4, isl.z]);
  await wait(600); await shot(`${tag}-shore`);
}
await browser.close();
console.log(`quickshots in ${OUT}/ (trop=${trop.name} mtn=${mtn.name})`);
