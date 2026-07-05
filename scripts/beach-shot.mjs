// Compare a white-sand island (Smuggler's Rest) with a muted-tan one (Castaway
// Reach) via the dev free-cam. Requires the dev server.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/beach';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const sleep = (ms) => page.waitForTimeout(ms);
async function viewFrom(c, t) {
  await page.evaluate(([cc, tt]) => {
    const g = window.__piratesBR;
    const dx = tt[0] - cc[0], dy = tt[1] - cc[1], dz = tt[2] - cc[2];
    g.enableFreeCam(cc[0], cc[1], cc[2], Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, [c, t]);
}

await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await sleep(5500);

const spots = await page.evaluate(() => {
  const g = window.__piratesBR;
  const pick = (name) => {
    const i = (g.state?.islands ?? []).find((s) => s.name === name);
    return i ? { name, x: i.position.x, z: i.position.z, r: i.radius, white: !!i.profile?.whiteSand } : null;
  };
  return [pick("Smuggler's Rest"), pick('Castaway Reach')].filter(Boolean);
});
console.log('spots:', JSON.stringify(spots));

let idx = 0;
for (const s of spots) {
  const tag = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + (s.white ? '-WHITE' : '-tan');
  // Low oblique over the water at the shore, looking at the beach berm.
  await viewFrom([s.x + s.r * 1.2, 22, s.z + s.r * 1.2], [s.x, 3, s.z]);
  await sleep(1100);
  await page.screenshot({ path: `${OUT}/${String(++idx).padStart(2, '0')}-${tag}.png`, timeout: 60000 });
}
await page.evaluate(() => window.__piratesBR.disableFreeCam());
await browser.close();
console.log(`beach shots in ${OUT}/`);
