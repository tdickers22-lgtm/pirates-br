import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/cave';
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
const AVOID_VOLCANIC = process.argv[3] === 'nonvolcanic';
const WANT_NAME = process.argv[4] ?? '';
const info = await page.evaluate(([avoidVolc, wantName]) => {
  const g = window.__piratesBR;
  const score = (isl) => (isl.profile?.terrainStyle === 'mountain' ? 2 : 0)
    + (avoidVolc && (isl.profile?.biome === 'volcanic') ? -3 : 0)
    + (wantName && (isl.name ?? '').toLowerCase().includes(wantName.toLowerCase()) ? 100 : 0);
  const isls = (g.state.islands ?? []).slice().sort((a, b) => score(b) - score(a));
  for (const isl of isls) {
    const mouth = (isl.caves ?? []).find((c) => c.hasMouth);
    if (mouth) return {
      style: isl.profile?.terrainStyle, biome: isl.profile?.biome,
      name: isl.name, ix: isl.position.x, iz: isl.position.z, ir: isl.radius,
      cx: mouth.position.x, cy: mouth.position.y, cz: mouth.position.z,
      rot: mouth.rotation, floorY: mouth.floorY, width: mouth.width, height: mouth.height, length: mouth.length,
      caveCount: (isl.caves ?? []).length,
    };
  }
  return null;
}, [AVOID_VOLCANIC, WANT_NAME]);
console.log(JSON.stringify(info));
if (info) {
  const ox = Math.sin(info.rot), oz = Math.cos(info.rot);      // outward (+z-local)
  // 1) mountain wide view (see the mountain + where the mouth is)
  await freeLook([info.ix + ox*(info.ir*1.4), info.floorY + info.ir*0.7, info.iz + oz*(info.ir*1.4)], [info.ix, info.floorY + 8, info.iz]);
  await wait(600); await page.screenshot({ path: `${OUT}/mountain.png`, timeout: 60000 });
  // 1b) HERO 3/4 — ground level, cave mouth set into the mountain flank behind it
  await freeLook([info.cx + ox*26 + oz*16, info.floorY + 7, info.cz + oz*26 - ox*16], [info.cx, info.floorY + 3.0, info.cz]);
  await wait(600); await page.screenshot({ path: `${OUT}/hero.png`, timeout: 60000 });
  // 1c) FAR — ~95m back (well past the 45m interior gate): the rock PORTAL must
  // still be visible so the entrance reads from across the island.
  await freeLook([info.cx + ox*95, info.floorY + 26, info.cz + oz*95], [info.cx, info.floorY + 2, info.cz]);
  await wait(600); await page.screenshot({ path: `${OUT}/far.png`, timeout: 60000 });
  // 2) entrance exterior (stand outside the mouth)
  await freeLook([info.cx + ox*14, info.floorY + 4.0, info.cz + oz*14], [info.cx, info.floorY + 2.6, info.cz]);
  await wait(600); await page.screenshot({ path: `${OUT}/entrance.png`, timeout: 60000 });
  // 3) inside the tunnel looking in
  await freeLook([info.cx - ox*2, info.floorY + 1.6, info.cz - oz*2], [info.cx - ox*info.length, info.floorY + 1.2, info.cz - oz*info.length]);
  await wait(600); await page.screenshot({ path: `${OUT}/interior.png`, timeout: 60000 });
  // 4) inside looking back out toward the mouth
  await freeLook([info.cx - ox*(info.length*0.5), info.floorY + 1.6, info.cz - oz*(info.length*0.5)], [info.cx + ox*4, info.floorY + 2, info.cz + oz*4]);
  await wait(600); await page.screenshot({ path: `${OUT}/interior-back.png`, timeout: 60000 });
}
await browser.close();
console.log('cave shots done');
