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
import { readWorld, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import {
  PIN_PROBE_RESOLUTION, PLACE_AND_SETTLE, DEPTH_TIE_CENSUS, PIERCE_TIE_PIXELS,
  DETACH_POST_CHAIN,
} from './lib/zfight-probe.mjs';
import { planStands, DOLLY, TIME_OF_DAY, VIEWPORT } from './lib/zfight-stands.mjs';

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
/** Also count the COMPOSED frame at the tiers that have a post chain, so the
 *  smear the chain adds to a tie is a measured number in the report. */
const PRESENTED = flag('presented');
const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const TOD_FILTER = arg('tod', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

let failures = 0;
const fail = (label, detail = '') => {
  console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
  failures += 1;
};
const pass = (label) => console.log(`  ✓ ${label}`);

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
    // Detached for the SESSION, not just for the census: the three settling
    // frames after every placement are game frames, and at `balanced` and `high`
    // three of those through the bloom chain is ten minutes on SwiftShader.
    const detached = PRESENTED ? false : await page.evaluate(DETACH_POST_CHAIN);
    if (detached) console.log('  post chain detached for this run (it can smear a tie, not create one)');

    const world = await readWorld(page);
    const stands = planStands(world, SCENE_FILTER);
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
          const census = await page.evaluate(DEPTH_TIE_CENSUS, { mask: MASKS, bypassPost: true, presented: PRESENTED });
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
            + `ties ${String(census.ties).padStart(6)}  patch ${String(census.patchPixels).padStart(6)}  `
            + `loud ${String(census.tiesLoud).padStart(6)}  self-noise ${census.selfNoise}`
            + (census.presented ? `  [composed ${census.presented.ties} / noise ${census.presented.selfNoise}]` : '')
            + (census.postBypassed ? '  (post chain bypassed)' : ''));
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
      const worstPatch = Math.max(...s.poses.map((p) => p.patchPixels));
      const worstAll = Math.max(...s.poses.map((p) => p.ties));
      const label = `${s.id} @ ${s.tod}: no coplanar patch fights `
        + `(${worstAll} tie px at worst pose, all of it intersection line)`;
      if (worstPatch === 0) pass(label);
      else {
        const p = s.poses.find((q) => q.patchPixels === worstPatch);
        const c = p.clusters[0];
        fail(
          label,
          `${worstPatch} tie pixels have a tied neighbour on all four sides, so they are inside a `
          + `coplanar patch and not on an intersection line — worst cluster ${c.pixels}px at `
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
