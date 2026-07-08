// Regression sweep: a 3/4 aerial of EVERY island, labelled by style+biome, so a
// vision pass can spot colour/terrain regressions after the cave/peak/magma work.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/sweep';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const wait = (ms) => page.waitForTimeout(ms);
async function look(pos, target) {
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
await wait(400);
const list = await page.evaluate(() => (window.__piratesBR.state.islands ?? []).map((i, idx) => ({
  idx, name: i.name, style: i.profile?.terrainStyle, biome: i.profile?.biome,
  x: i.position.x, z: i.position.z, r: i.radius,
  peakY: window.__piratesBR.sampleGroundY(i.position.x, i.position.z),
})));
console.log(JSON.stringify(list.map(i => `${i.idx}:${i.style}/${i.biome}`)));
for (const i of list) {
  const d = i.r * 1.7;
  await look([i.x + d, Math.max(40, i.r * 0.9), i.z + d], [i.x, i.r * 0.18, i.z]);
  await wait(350);
  const tag = `${String(i.idx).padStart(2,'0')}-${i.style}-${i.biome}`;
  await page.screenshot({ path: `${OUT}/${tag}.png`, timeout: 60000 });
}
await browser.close();
console.log('sweep done');
