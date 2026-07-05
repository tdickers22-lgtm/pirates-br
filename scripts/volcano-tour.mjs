// Volcanic verification tour: joins a solo match, waits for the world to stream,
// then flies the dev free-cam to the volcanic islands (Old Maw Caldera, Kraken
// Tooth) to photograph magma cracks, the caldera lava/ash/smoke, and erupting
// geyser plumes. Requires the dev server (npm run dev). GPU (ANGLE→Metal) so the
// heavy-scene canvas readback doesn't time out.
// Usage: node scripts/volcano-tour.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/volcano';
const GAME_URL = 'http://127.0.0.1:3000/?debug&quality=high';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
const sleep = (ms) => page.waitForTimeout(ms);

// Fly the free-cam to camPos looking at target [x,y,z].
async function viewFrom(camPos, target) {
  await page.evaluate(([c, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - c[0], dy = t[1] - c[1], dz = t[2] - c[2];
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    g.enableFreeCam(c[0], c[1], c[2], yaw, pitch);
  }, [camPos, target]);
}

await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
// Let the whole world stream in (one island builds per frame).
await sleep(5000);

const volcanic = await page.evaluate(() => {
  const g = window.__piratesBR;
  return (g.state?.islands ?? [])
    .filter((i) => i.profile?.biome === 'volcanic')
    .map((i) => ({
      id: i.id,
      name: i.name,
      x: i.position.x,
      z: i.position.z,
      radius: i.radius,
      style: i.profile.terrainStyle,
      geysers: (i.geysers ?? []).map((gg) => ({ x: gg.x, y: gg.y, z: gg.z, radius: gg.radius, period: gg.period })),
    }));
});
console.log('Volcanic islands:', JSON.stringify(volcanic, null, 1));

let idx = 0;
for (const isle of volcanic) {
  const tag = isle.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Wide establishing shot of the whole cone from an elevated 3/4 angle.
  const peakY = 42;
  await viewFrom([isle.x + isle.radius * 1.7, peakY + 55, isle.z + isle.radius * 1.7], [isle.x, peakY, isle.z]);
  await sleep(1200);
  await shot(`${String(++idx).padStart(2, '0')}-${tag}-wide`);

  // Lower, closer 3/4 to read magma cracks + ash on the flanks.
  await viewFrom([isle.x + isle.radius * 1.05, 26, isle.z + isle.radius * 1.05], [isle.x, 24, isle.z]);
  await sleep(1000);
  await shot(`${String(++idx).padStart(2, '0')}-${tag}-flank`);

  // Hover over a geyser vent and hold to catch an eruption (period 7.5-11s).
  const g0 = isle.geysers[0];
  if (g0) {
    await viewFrom([g0.x + 15, g0.y + 7, g0.z + 15], [g0.x, g0.y + 5, g0.z]);
    for (let s = 0; s < 8; s++) {
      await sleep(1600);
      await shot(`${String(++idx).padStart(2, '0')}-${tag}-geyser-${s}`);
    }
  }
}

await page.evaluate(() => window.__piratesBR.disableFreeCam());
await browser.close();
console.log(`screenshots in ${OUT}/`);
