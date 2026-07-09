// Beauty shots of a ship (bow-quarter, broadside, stern, deck) + a sea stack.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/ship';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60000 });
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
// pick the galleon (biggest) nearest origin
const ships = await page.evaluate(() => (window.__piratesBR.state.ships ?? []).map((s)=>({id:s.id,type:s.type,x:s.position.x,z:s.position.z,rot:s.rotation})));
const galleon = ships.find((s)=>s.type==='galleon') ?? ships[0];
console.log('ship', galleon.type, Math.round(galleon.x), Math.round(galleon.z), 'rot', galleon.rot.toFixed(2));
const { x, z, rot } = galleon;
// bow-quarter beauty (ahead + to starboard, low)
const fwd = [Math.sin(rot), Math.cos(rot)]; const rightv = [Math.cos(rot), -Math.sin(rot)];
const bq = [x + fwd[0]*20 + rightv[0]*14, 9, z + fwd[1]*20 + rightv[1]*14];
await freeLook(bq, [x, 5, z]); await wait(700); await shot('bow-quarter');
// broadside
const bs = [x + rightv[0]*26, 8, z + rightv[1]*26];
await freeLook(bs, [x, 5, z]); await wait(600); await shot('broadside');
// stern
const st = [x - fwd[0]*22 + rightv[0]*8, 9, z - fwd[1]*22 + rightv[1]*8];
await freeLook(st, [x, 5, z]); await wait(600); await shot('stern');
// on-deck (above midship looking to bow)
await freeLook([x, 9, z], [x + fwd[0]*14, 4.5, z + fwd[1]*14]); await wait(600); await shot('deck');
// helm close-up (low + side-on off the stern quarter, at ~deck level, so the RAISED quarterdeck dais reads)
await freeLook([x - fwd[0]*6 + rightv[0]*9, 5.6, z - fwd[1]*6 + rightv[1]*9], [x - fwd[0]*7, 5.0, z - fwd[1]*7]); await wait(600); await shot('helm');
// bow close-up (ahead + to the side, low — sees the jib on the forestay + bowsprit)
await freeLook([x + fwd[0]*15 + rightv[0]*7, 6.5, z + fwd[1]*15 + rightv[1]*7], [x + fwd[0]*7, 5, z + fwd[1]*7]); await wait(600); await shot('bow');
await browser.close();
console.log('ship shots done');
