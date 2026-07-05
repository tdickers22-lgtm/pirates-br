// Vegetation verification: fly the free-cam over lush islands to confirm the
// new dense flower patches / thickets read as flourishing clusters (not an even
// sprinkle). Requires the dev server. Usage: node scripts/veg-tour.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/veg';
const GAME_URL = 'http://127.0.0.1:3000/?debug&quality=high';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
const sleep = (ms) => page.waitForTimeout(ms);
async function viewFrom(c, t) {
  await page.evaluate(([cc, tt]) => {
    const g = window.__piratesBR;
    const dx = tt[0] - cc[0], dy = tt[1] - cc[1], dz = tt[2] - cc[2];
    g.enableFreeCam(cc[0], cc[1], cc[2], Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, [c, t]);
}

await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await sleep(5500);

const isles = await page.evaluate(() => {
  const g = window.__piratesBR;
  const flora = new Set(['flower_patch', 'wildflowers', 'flower_bush', 'bush', 'fern_plant', 'bush_berry']);
  return (g.state?.islands ?? [])
    .filter((i) => ['lush', 'palm_atoll'].includes(i.profile?.biome))
    .map((i) => {
      const props = i.props ?? [];
      const flowerBeds = props.filter((p) => p.type === 'flower_patch' || p.type === 'wildflowers');
      const anyFlora = props.filter((p) => flora.has(p.type));
      // Densest bed = the flower prop with the most flora neighbours within 7m.
      let best = null;
      for (const p of flowerBeds.length ? flowerBeds : anyFlora) {
        const n = anyFlora.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 7).length;
        if (!best || n > best.n) best = { x: p.x, z: p.z, n };
      }
      return {
        name: i.name, x: i.position.x, z: i.position.z, radius: i.radius,
        floraCount: anyFlora.length, flowerBeds: flowerBeds.length,
        dense: best ?? { x: i.position.x, z: i.position.z, n: 0 },
      };
    })
    .sort((a, b) => b.flowerBeds - a.flowerBeds);
});
console.log('Lush islands (flora / beds / densest-cluster):', isles.map((i) => `${i.name}:${i.floraCount}/${i.flowerBeds}/${i.dense.n}`).join('  '));

let idx = 0;
for (const isle of isles.slice(0, 2)) {
  const tag = isle.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const d = isle.dense;
  const gy = await page.evaluate(([x, z]) => window.__piratesBR.sampleGroundY(x, z), [d.x, d.z]);
  console.log(`${isle.name}: densest cluster at (${d.x.toFixed(0)},${d.z.toFixed(0)}) groundY=${gy.toFixed(1)} neighbours=${d.n}`);
  // Elevated overview to see the clustering across the island.
  await viewFrom([isle.x + isle.radius * 0.7, 60, isle.z + isle.radius * 0.7], [isle.x, 6, isle.z]);
  await sleep(1100);
  await shot(`${String(++idx).padStart(2, '0')}-${tag}-overview`);
  // Oblique from ~22m away, angled down onto the densest bed (same geometry as
  // the working overview so the terrain mesh stays in frustum).
  await viewFrom([d.x + 16, gy + 14, d.z + 16], [d.x, gy + 0.8, d.z]);
  await sleep(1100);
  await shot(`${String(++idx).padStart(2, '0')}-${tag}-cluster`);
  // Low, close oblique skimming the flowers.
  await viewFrom([d.x + 7, gy + 3.2, d.z + 7], [d.x, gy + 1.0, d.z]);
  await sleep(1100);
  await shot(`${String(++idx).padStart(2, '0')}-${tag}-eye`);
}

await page.evaluate(() => window.__piratesBR.disableFreeCam());
await browser.close();
console.log(`screenshots in ${OUT}/`);
