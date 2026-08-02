#!/usr/bin/env node
// EYE-LEVEL SHOT SHEET FOR THE FILL-RATE PASS.
//
// Every change in the fill/shader pass is a claim that the frame got cheaper and
// the picture did not change. The counts prove the first half. This proves the
// second: the same six eye-level stands, on the same PINNED map, at four times
// of day, at a tier you name — so a before set and an after set are the same
// frames and can be read side by side.
//
// It is deliberately NOT a gate. Nothing here passes or fails; it writes PNGs a
// person looks at. The things this pass can break are all things a number cannot
// see — a sky with a hole in it where the far ocean should be, a shadow that
// went soft, a grade that moved, a storm wall with a seam in it — and the only
// instrument for those is an eye.
//
// Camera placements come from perf-probe's `planScenes`, so the shots frame
// exactly what the cost model measures.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/fill-pass-shots.mjs --quality high --out test-results/fill-before
//
// It never starts or stops a game server; stand one up yourself on a spare port
// with PIRATES_BR_MAP_SEED pinned. A Vite it has to start, it owns and stops.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { planScenes, readWorld, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { FIND_WATERFALL_ISLAND, planWaterfallDeck } from './lib/perf-scenes.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', `test-results/fill-shots-${QUALITY}`);
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
/** Frames to let the LOD reveal and the ripple/cloud clocks settle after a move.
 *  Counted in FRAMES, not milliseconds: a frame here is most of a second. */
const FRAMES_AFTER_MOVE = parseInt(arg('frames', '6'), 10);

/** The day-cycle seconds the rest of the repo's shot rigs use for these words. */
const TIME_OF_DAY = { noon: 854, dusk: 240, night: 374 };

/** Which stands are shot, and in which session. `storm` reuses the noon clock —
 *  a storm demo at night is two changes in one frame and neither can be read. */
const SHOTS = [
  // A CLOSE STAND ON A DRESSED ISLAND, and the only reason it exists is the
  // shadow map. Every other stand here is a vista, and a vista at 95 m cannot
  // show what a shadow-map resolution change did: the shadows in it are a few
  // pixels across. This one is at eye level inside the prop scatter, where a
  // palm's shadow is a metre wide and its edge is the thing the texel size
  // decides. Shot at noon (short, hard) and at dusk (long, raking), which are
  // the two ways a shadow can go wrong.
  { id: 'island-props', session: 'main', tod: ['noon', 'dusk'] },
  { id: 'dock-vista', session: 'main', tod: ['noon', 'dusk', 'night'] },
  { id: 'island-interior', session: 'main', tod: ['noon', 'dusk', 'night'] },
  { id: 'deck-aft', session: 'main', tod: ['noon', 'dusk', 'night'] },
  { id: 'cave-interior', session: 'main', tod: ['noon'] },
  { id: 'open-sea', session: 'main', tod: ['noon', 'dusk', 'night'] },
  { id: 'storm-sea', session: 'storm', tod: ['storm'] },
  { id: 'waterfall-deck', session: 'storm', tod: ['storm'] },
];

/** Re-shoot a subset. A stand added after a set was taken needs its own before
 *  and after, and re-running thirteen views to get one of them is an hour. */
const ONLY = (arg('only', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const WANTED = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.id)) : SHOTS;

const SESSION_PARAMS = {
  main: ['debug', `quality=${QUALITY}`],
  storm: ['debug', `quality=${QUALITY}`, 'stormdemo'],
};

const VIEWPORT = { width: 960, height: 540 };

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Wait a fixed number of RENDERED frames. A wall-clock wait on a CPU
 *  rasteriser photographs whatever half-built state the clock landed in. */
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
      + '  PORT=8091 PIRATES_BR_MAP_SEED=20260801 npx tsx src/server/index.ts');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`Fill-pass shot sheet — GL: ${describeGl()}  quality=${QUALITY}  seed ${h.mapSeed ?? 'UNPINNED'}  → ${OUT}/`);
  if (h.mapSeed == null) console.log('  ! UNPINNED map: a before and an after set will not be the same world.');

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });

  let taken = 0;
  try {
    for (const session of ['main', 'storm']) {
      const shots = WANTED.filter((s) => s.session === session);
      if (!shots.length) continue;
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page.setDefaultTimeout(0);
      page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
      try {
        console.log(`\n── session ${session} ──`);
        await page.goto(`${URL}/?${sessionQuery(SESSION_PARAMS[session])}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
        await page.click('#menu-solo-btn', { noWaitAfter: true });
        await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate(() => window.__piratesBR.setBotPeace(true));
        // EVERY OVERLAY OFF, AND THE ONBOARDING CARD DISMISSED. None of them is
        // what this pass changes, and between them they cover the middle of the
        // frame and both bottom corners — which is where a vignette shift, a
        // grade shift or a sky seam would show first. The first version of this
        // rig photographed the SHIP'S ORDERS card and a debug panel.
        await page.evaluate(() => {
          document.getElementById('oc-skip')?.click();
          const style = document.createElement('style');
          style.textContent = '#hud{opacity:0!important;visibility:hidden!important;}'
            + '#onboard-cards,#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}'
            + '#debug-perf-panel{display:none!important;}'
            + '#disconnect-overlay,#server-load-chip,[id*="overload"],[class*="overload"]{display:none!important;}';
          document.head.appendChild(style);
        });

        const world = await readWorld(page);
        const plan = planScenes(world);
        const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
        if (waterfall) plan['waterfall-deck'] = planWaterfallDeck(waterfall);

        // Standing among the props on the dressed island, looking across its
        // middle. `planScenes`' own island-interior stand is picked for COST
        // (the biggest island in the world) and on this seed it lands on a bare
        // dune facing the sea, which has nothing in it to cast a shadow.
        const dressed = world.islands.find((i) => i.hasDock) ?? world.islands[0];
        if (dressed) {
          const off = dressed.radius * 0.42;
          plan['island-props'] = {
            x: dressed.x + off, y: null, z: dressed.z + off * 0.55,
            groundOffset: 1.7, pitch: -0.09,
            aimAt: { x: dressed.x - off * 0.4, z: dressed.z - off * 0.3 },
          };
        }

        for (const shot of shots) {
          const cam = plan[shot.id];
          if (!cam) { console.log(`  ${shot.id}: (no placement in this world)`); continue; }
          for (const tod of shot.tod) {
            await page.evaluate(
              ([c, seconds]) => {
                const g = window.__piratesBR;
                let y = c.y;
                if (y === null || y === undefined) {
                  y = (g.sampleGroundY(c.x, c.z) ?? 0) + (c.groundOffset ?? 1.7);
                }
                let yaw = c.yaw;
                if (c.aimAt) yaw = Math.atan2(c.aimAt.x - c.x, c.aimAt.z - c.z);
                g.enableFreeCam(c.x, y, c.z, yaw, c.pitch);
                g.setDayNightOverride(seconds);
                g.settleLod?.();
              },
              [cam, TIME_OF_DAY[tod] ?? TIME_OF_DAY.noon],
            );
            // Twice, on purpose: an island revealed by the first settle pass
            // gets its micro tier graded by the second.
            await waitFrames(page, FRAMES_AFTER_MOVE);
            await page.evaluate(() => window.__piratesBR.settleLod?.());
            await waitFrames(page, FRAMES_AFTER_MOVE);
            const name = `${shot.id}-${tod}-${QUALITY}.png`;
            await page.screenshot({ path: `${OUT}/${name}`, timeout: 180_000 });
            taken += 1;
            console.log(`  ${name}`);
          }
        }
      } catch (error) {
        console.error(`  ✗ session ${session} failed: ${String(error?.message ?? error).slice(0, 300)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    stopDevClient(client);
  }
  console.log(`\n${taken} shots in ${OUT}/`);
}

main().catch((error) => { console.error(error); process.exit(1); });
