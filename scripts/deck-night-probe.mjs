// Night-readability probe for the OWN ship's deck and the lagoon shallows: the
// two frames the "night is a blackout" and "grazing water is a flat cyan sheet"
// defects live in. Requires the dev stack (vite :3000 + ws :8090). GPU-headless,
// so pointer lock never engages and the camera is driven through enableFreeCam.
//   node --import tsx scripts/deck-night-probe.mjs <outDir> [deck|graze|under]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/deck-night';
const WANT = process.argv.slice(3);
const want = (name) => WANT.length === 0 || WANT.includes(name);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

async function session(query, attempts = 4) {
  for (let n = 1; n <= attempts; n++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    try {
      await page.goto(`http://127.0.0.1:3000/${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#menu-solo-btn', { timeout: 25_000 });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 45_000 });
      await page.waitForTimeout(3200);
      return page;
    } catch (err) {
      console.log(`  join attempt ${n} failed: ${err.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      if (n === attempts) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw new Error('unreachable');
}

const clean = (page) => page.evaluate(() => document.getElementById('disconnect-overlay')?.remove());
const shot = async (page, name) => {
  await clean(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
};
const wait = (page, ms) => page.waitForTimeout(ms);
const look = (page, [x, y, z], yaw, pitch) => page.evaluate(
  ([p, ya, pi]) => window.__piratesBR.enableFreeCam(p[0], p[1], p[2], ya, pi),
  [[x, y, z], yaw, pitch],
);
const time = (page, sec) => page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);

// The renderer runs without preserveDrawingBuffer, so the canvas cannot be read
// back mid-frame — every readback comes out black. Judge these frames from the
// PNGs (that is the point of the probe); the log only records where each cam sat.

const page = await session('?debug&quality=high');
const info = await page.evaluate(() => {
  const g = window.__piratesBR;
  const ship = g.getTrackedShip?.() ?? null;
  const player = g.getLocalPlayer?.() ?? null;
  const own = ship ? { x: ship.position.x, y: ship.position.y, z: ship.position.z, rot: ship.rotation, type: ship.type } : null;
  return {
    ship: own,
    player: player ? { x: player.position.x, y: player.position.y, z: player.position.z } : null,
    islands: (g.state.islands ?? []).map((i) => ({ name: i.name, x: i.position.x, z: i.position.z, r: i.radius, biome: i.profile?.biome })),
  };
});
console.log('ship', JSON.stringify(info.ship), 'player', JSON.stringify(info.player));

if (want('deck') && info.ship) {
  const s = info.ship;
  // Deck cams: stern (where the helm and the lantern are), midships looking aft,
  // and a first-person height look down at the planking.
  const views = [
    ['deck-01-helm', s.x, 4.6, s.z - 2.0, Math.PI, -0.18],
    ['deck-02-midships-aft', s.x, 4.4, s.z + 6.0, Math.PI, -0.10],
    ['deck-03-planks', s.x + 1.0, 4.2, s.z + 1.0, Math.PI * 0.75, -0.62],
    ['deck-04-bow', s.x, 4.6, s.z - 8.0, 0, -0.12],
  ];
  for (const [tag, sec] of [['night', 374], ['noon', 854]]) {
    await time(page, sec);
    await wait(page, 900);
    for (const [name, x, y, z, yaw, pitch] of views) {
      await look(page, [x, y, z], yaw, pitch);
      await wait(page, 800);
      await shot(page, `${tag}-${name}`);
    }
  }
}

if (want('graze') || want('under')) {
  // A white-sand lagoon: the biggest tropical island's windward shelf.
  const lagoon = info.islands.filter((i) => i.biome === 'lush' || i.biome === 'palm_atoll')
    .sort((a, b) => b.r - a.r)[0] ?? info.islands[0];
  console.log('lagoon', lagoon.name, lagoon.x, lagoon.z, lagoon.r);
  for (const [tag, sec] of [['noon', 854], ['night', 374], ['dusk', 240]]) {
    await time(page, sec);
    await wait(page, 900);
    if (want('graze')) {
      // Eye at swimming height just off the sand, looking along the shelf.
      const yaw = Math.PI * 0.5;
      for (const [name, mult, y, pitch] of [
        ['graze-a', 1.06, 0.30, 0.0],
        ['graze-b', 1.06, 0.18, 0.03],
        ['graze-c', 1.10, 0.75, -0.05],
        ['graze-d', 1.02, 0.35, -0.02],
      ]) {
        await look(page, [lagoon.x + lagoon.r * mult, y, lagoon.z], yaw, pitch);
        await wait(page, 700);
        await shot(page, `${tag}-${name}`);
      }
    }
    if (want('under')) {
      for (const [name, mult, y, pitch] of [
        ['under-a', 1.10, -1.4, 0.10],
        ['under-b', 1.18, -3.6, 0.06],
      ]) {
        await look(page, [lagoon.x + lagoon.r * mult, y, lagoon.z], Math.PI * 1.5, pitch);
        await wait(page, 700);
        await shot(page, `${tag}-${name}`);
      }
    }
  }
}

await page.close();
await browser.close();
console.log(`shots in ${OUT}/`);
