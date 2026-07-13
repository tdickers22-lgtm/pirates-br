// Story-scene tour: one framed shot per island story vignette + a night shot of
// the widow's lantern. node scripts/story-tour.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/story-tour';
mkdirSync(OUT, { recursive: true });
const STORY = ['smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
  'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp', 'kraken_wreck',
  'dig_site', 'gallows', 'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage'];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
  }, [pos, target]);
}
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(4000);
await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), 854); // noon
await page.evaluate(() => { const e = document.createElement('style'); e.textContent = '#hud{opacity:0!important;visibility:hidden!important;}'; document.head.appendChild(e); });
await wait(400);

const scenes = await page.evaluate((types) => {
  const out = [];
  for (const isl of window.__piratesBR.state.islands ?? []) {
    for (const p of isl.props ?? []) {
      if (!types.includes(p.type)) continue;
      out.push({ island: isl.name, type: p.type, x: p.x, z: p.z, yaw: p.yaw,
        gY: window.__piratesBR.sampleGroundY(p.x, p.z) });
    }
  }
  return out;
}, STORY);
console.log(`found ${scenes.length} story scenes`);

for (const s of scenes) {
  // Approach from the facing direction (yaw 0 = +Z), slightly high, looking back.
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  const d = s.type === 'whale_skeleton' || s.type === 'kraken_wreck' ? 22 : 14;
  const cam = [s.x + fx * d, Math.max(s.gY, 0.5) + 5.5, s.z + fz * d];
  const tgt = [s.x, Math.max(s.gY, 0.5) + 1.6, s.z];
  await freeLook(cam, tgt);
  await wait(1400); // give island detail + GLBs time to stream in
  const tag = `${s.island.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}--${s.type}`;
  await shot(tag);
  console.log(`shot ${tag} at (${s.x.toFixed(0)},${s.z.toFixed(0)}) y=${s.gY.toFixed(1)}`);
}

// Night beacon check: the widow's lantern must read from the sea.
const widow = scenes.find((s) => s.type === 'widow_memorial');
if (widow) {
  await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), 374); // night
  await wait(900);
  const fx = Math.sin(widow.yaw), fz = Math.cos(widow.yaw);
  await freeLook([widow.x + fx * 55, widow.gY + 9, widow.z + fz * 55], [widow.x, widow.gY + 3, widow.z]);
  await wait(1200);
  await shot('night--widow-beacon');
}
// Gallows silhouette from the sea at dusk.
const gal = scenes.find((s) => s.type === 'gallows');
if (gal) {
  await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), 240); // dusk
  await wait(900);
  const fx = Math.sin(gal.yaw), fz = Math.cos(gal.yaw);
  await freeLook([gal.x + fx * 70, 6, gal.z + fz * 70], [gal.x, gal.gY + 3, gal.z]);
  await wait(1200);
  await shot('dusk--gallows-silhouette');
}
await browser.close();
console.log('story tour complete');
