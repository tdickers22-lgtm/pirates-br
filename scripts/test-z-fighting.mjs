#!/usr/bin/env node
// Z-FIGHTING GATE — the number of pixels standing on a depth-buffer tie, per
// stand, per time of day, and it has to be zero.
//
// See scripts/lib/zfight-probe.mjs for why the instrument is a depth-comparison
// flip rather than a frame diff: in one sentence, a frame diff of a moving
// camera in a game where the water, the foliage and the clouds all move reports
// the whole screen, while a tie count is exact, needs no motion, and reads
// exactly 0 on a clean frame.
//
// Each stand is measured at several poses a few centimetres apart along the view
// direction. That is the motion the artifact needs: a coplanar pair one depth
// level apart at one pose is TIED at the next, so a stand's score is the worst
// of its poses, not the first.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8093 PIRATES_BR_URL=http://127.0.0.1:3103 \
//     node scripts/test-z-fighting.mjs --quality low
//
// It never starts or stops a game server; stand one up yourself on a spare port
// with PIRATES_BR_MAP_SEED pinned. A Vite it has to start, it owns and stops.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { readWorld, sessionQuery, planScenes, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import {
  PIN_PROBE_RESOLUTION, PLACE_AND_SETTLE, DEPTH_TIE_CENSUS, PIERCE_TIE_PIXELS,
} from './lib/zfight-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const OUT = arg('out', `test-results/zfight-${QUALITY}`);
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
const POSES = parseInt(arg('poses', '3'), 10);
const MASKS = flag('masks');
const PIERCE = flag('pierce');
const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const TOD_FILTER = arg('tod', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

const VIEWPORT = { width: 960, height: 540 };
const TIME_OF_DAY = { noon: 854, night: 374 };

/**
 * THE DOLLY. Metres along the view direction, from the stand's own position.
 *
 * They are deliberately not round numbers and deliberately sub-metre. Depth
 * quantisation is a grid; a coplanar pair drifts across it as the eye moves, so
 * what these have to do is land on DIFFERENT PHASES of that grid, and stepping
 * by a round 0.5 m at 100 m lands on the same phase over and over. Sub-metre
 * because the point is to re-measure the SAME view, not a different one.
 */
const DOLLY = [0, 0.17, 0.41, 0.83, 1.29];

let failures = 0;
const fail = (label, detail = '') => {
  console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
  failures += 1;
};
const pass = (label) => console.log(`  ✓ ${label}`);

/**
 * THE STANDS. Every one is a place where two surfaces are coplanar or nearly so
 * by construction — which is the only place the artifact can live.
 */
function planStands(world) {
  const shared = planScenes(world);
  const byName = (n) => world.islands.find((i) => i.name === n) ?? null;
  const dockIsland = byName('Castaway Reach') ?? world.islands.find((i) => i.hasDock) ?? world.islands[0];
  const biggest = [...world.islands].sort((a, b) => b.radius - a.radius)[0];

  const stands = [
    // The shared perf stands, so a tie count and a draw count describe the same
    // frames. dock-vista and island-far are the DISTANCE cases — depth precision
    // falls off with the square of the distance and these are where it lands.
    { id: 'dock-vista', label: 'dock vista (island at 95 m + dock planks)', cam: shared['dock-vista'] },
    { id: 'island-interior', label: 'island interior, eye level in the scatter', cam: shared['island-interior'] },
    { id: 'cave-interior', label: 'cave interior (shell vs terrain, mouth cutout)', cam: shared['cave-interior'] },
    { id: 'deck-aft', label: 'on-deck aft (planking, patches, hull decals)', cam: shared['deck-aft'] },
    { id: 'open-sea', label: 'open sea (ocean plane + horizon)', cam: shared['open-sea'] },
  ];

  // THE WATERLINE, at eye height, from the water. Shore band, wet-sand band,
  // shallow disc and sand shelf are all authored as overlapping ramps against
  // the ocean plane, and this is the only stand that looks straight down the
  // seam where they meet.
  stands.push({
    id: 'shore-waterline',
    label: 'shore waterline (shore band / wet sand / ocean seam)',
    cam: {
      x: dockIsland.x + (dockIsland.radius + 26),
      y: 1.7,
      z: dockIsland.z,
      pitch: -0.06,
      aimAt: { x: dockIsland.x, z: dockIsland.z },
    },
  });

  // THE DISTANCE CASE, and the reason the near plane matters. A whole island at
  // 520 m: every coplanar pair on it is being resolved by the tail of the depth
  // buffer, where the levels are ~100x coarser than they are at the dock.
  stands.push({
    id: 'island-far',
    label: 'island at 520 m (the far tail of the depth buffer)',
    cam: {
      x: biggest.x + (biggest.radius + 520) * 0.707,
      y: 26,
      z: biggest.z + (biggest.radius + 520) * 0.707,
      pitch: -0.03,
      aimAt: { x: biggest.x, z: biggest.z },
    },
  });

  // LOOKING DOWN ON TERRAIN from above: terrace lips, contact shadows, ground
  // decals and the detail/proxy crossfade band all present their coplanar face
  // to a top-down eye and hide it from a level one.
  stands.push({
    id: 'island-overlook',
    label: 'island overlook (terraces, contact shadows, ground decals)',
    cam: {
      x: biggest.x + biggest.radius * 0.9,
      y: 96,
      z: biggest.z + biggest.radius * 0.9,
      pitch: -0.62,
      aimAt: { x: biggest.x, z: biggest.z },
    },
  });

  // ALONGSIDE THE HULL at water level: the waterline collar against the ocean
  // surface, plus the hole decals and plank patches at the distance a boarder
  // sees them.
  if (world.ship) {
    stands.push({
      id: 'hull-alongside',
      label: 'alongside the hull at water level (collar vs ocean, hole decals)',
      cam: {
        x: world.ship.x + Math.cos(world.ship.rot ?? 0) * 15,
        y: world.ship.y + 1.2,
        z: world.ship.z - Math.sin(world.ship.rot ?? 0) * 15,
        pitch: 0.02,
        aimAt: { x: world.ship.x, z: world.ship.z },
      },
    });
  }

  return stands.filter((s) => s.cam && (!SCENE_FILTER || SCENE_FILTER.includes(s.id)));
}

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const waitFrames = (page, n) => page.evaluate(
  (count) => new Promise((resolve) => {
    let i = 0;
    const step = () => { if (++i >= count) resolve(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }),
  n,
);

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port:\n`
      + '  PORT=8093 PIRATES_BR_MAP_SEED=20260801 npx tsx src/server/index.ts');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`Z-fighting gate — GL: ${describeGl()}  quality=${QUALITY}  seed ${h.mapSeed ?? 'UNPINNED'}`);

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const report = { quality: QUALITY, seed: h.mapSeed ?? null, stands: [] };

  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(PIN_PROBE_RESOLUTION);

    const world = await readWorld(page);
    const stands = planStands(world);
    const tods = Object.entries(TIME_OF_DAY).filter(([k]) => !TOD_FILTER || TOD_FILTER.includes(k));
    console.log(`  ${stands.length} stands x ${tods.length} times of day x ${POSES} poses\n`);

    for (const stand of stands) {
      for (const [todName, todSec] of tods) {
        const placed = await page.evaluate(PLACE_AND_SETTLE, { ...stand.cam, tod: todSec });
        // Let the warmer finish paying for whatever this view newly needs before
        // the pair is taken: a material released BETWEEN the two renders is a
        // difference the flip did not cause, and would land in the tie count.
        await waitFrames(page, 3);
        const poses = [];
        for (let i = 0; i < Math.min(POSES, DOLLY.length); i++) {
          const d = DOLLY[i];
          const cam = {
            ...stand.cam,
            x: placed.x + Math.sin(placed.yaw) * d,
            y: placed.y,
            z: placed.z + Math.cos(placed.yaw) * d,
            yaw: placed.yaw,
            aimAt: null,
            tod: todSec,
          };
          await page.evaluate(PLACE_AND_SETTLE, cam);
          const census = await page.evaluate(DEPTH_TIE_CENSUS, { mask: MASKS });
          if (census.maskPng) {
            writeFileSync(
              `${OUT}/${stand.id}-${todName}-p${i}.png`,
              Buffer.from(census.maskPng.split(',')[1], 'base64'),
            );
          }
          delete census.maskPng;
          census.dolly = d;
          if (PIERCE && census.clusters.length) {
            census.pierced = await page.evaluate(
              PIERCE_TIE_PIXELS,
              census.clusters.slice(0, 5).map((c) => ({
                x: c.x, y: c.y, width: census.width, height: census.height,
              })),
            );
          }
          poses.push(census);
          console.log(`    ${stand.id.padEnd(17)} ${todName.padEnd(5)} +${d.toFixed(2)}m  `
            + `ties ${String(census.ties).padStart(7)}  visible ${String(census.tiesVisible).padStart(7)}  `
            + `loud ${String(census.tiesLoud).padStart(7)}  self-noise ${census.selfNoise}`);
        }
        const worst = poses.reduce((a, b) => (b.ties > a.ties ? b : a));
        report.stands.push({ id: stand.id, label: stand.label, tod: todName, poses, worst: worst.ties });
      }
    }

    // ── the assertions ────────────────────────────────────────────────
    console.log('');
    const noisy = report.stands.filter((s) => s.poses.some((p) => p.selfNoise > 0));
    if (noisy.length) {
      fail(
        'the probe is quiet: two renders of the same state with nothing changed differ nowhere',
        `${noisy.length} stand(s) reported self-noise; every tie count in this run is unreliable — `
        + noisy.map((s) => `${s.id}/${s.tod}=${Math.max(...s.poses.map((p) => p.selfNoise))}`).join(', '),
      );
    } else {
      pass('the probe is quiet: self-noise is 0 at every stand, pose and time of day');
    }

    for (const s of report.stands) {
      const worstLoud = Math.max(...s.poses.map((p) => p.tiesLoud));
      const worstAll = Math.max(...s.poses.map((p) => p.ties));
      const label = `${s.id} @ ${s.tod}: no pixel stands on a depth tie`;
      if (worstAll === 0) pass(label);
      else {
        const c = s.poses.find((p) => p.ties === worstAll).clusters[0];
        fail(
          label,
          `${worstAll} tie pixels (${worstLoud} of them loud) — worst cluster ${c.pixels}px at `
          + `(${c.x},${c.y}) flipping rgb(${c.colA}) <-> rgb(${c.colB})`,
        );
      }
    }

    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}/report.json`);
  } finally {
    await browser.close();
    stopDevClient(client);
  }

  if (failures) {
    console.error(`\n✗ ${failures} z-fighting assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nAll z-fighting assertions passed.');
}

await main();
