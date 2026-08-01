#!/usr/bin/env node
// LOD REVEAL BAND — the freeze the player actually reported.
//
// An island's detail tier used to go from invisible to visible in ONE frame,
// and nothing reaches the GL driver until a mesh is drawn, so that frame paid
// every geometry upload and every program link for the island synchronously on
// the main thread. The signature is an asymmetry, not a slow frame: the FIRST
// approach to an island stalls, the second and third are cheap because the
// driver already holds everything. Measured before the fix, on identical
// sweeps: 7917ms on pass 1 against 227ms on pass 3 at the same waypoint.
//
// So the assertion here is a RATIO, deliberately. Frame times under the
// software rasteriser this machine is restricted to are meaningless in
// absolute terms; "the first approach costs the same as the third" is not.
//
// Free-cam steps in from 1000m to 400m off each island's EDGE, three times
// over, and records the worst rAF gap parked at each waypoint.
//
// Needs the dev stack (game server on 8090).
//   node scripts/test-lod-reveal.mjs
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';

const URL = (process.env.PIRATES_BR_GAME_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
const VIEWPORT = { width: 960, height: 540 };
/** Pass-1 stall allowed against the same waypoint's pass-3 stall. */
const RATIO_LIMIT = 2.0;
/** Below this a "stall" is ambient frame noise and a ratio off it means nothing. */
const NOISE_FLOOR_MS = 220;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const INSTALL = () => {
  const w = window;
  w.__lod = { worst: 0, last: performance.now(), frames: 0 };
  const step = () => {
    const now = performance.now();
    const dt = now - w.__lod.last;
    w.__lod.last = now;
    w.__lod.frames++;
    if (dt > w.__lod.worst) w.__lod.worst = dt;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

const SAMPLE = () => {
  const game = window.__piratesBR;
  const info = game?.renderer?.renderer?.info;
  const v = window.__lod;
  const worst = v.worst; v.worst = 0;
  const frames = v.frames; v.frames = 0;
  return {
    programs: info?.programs?.length ?? -1,
    geometries: info?.memory?.geometries ?? -1,
    calls: info?.render?.calls ?? -1,
    worstGapMs: Math.round(worst),
    frames,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  args: browserArgs([
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--enable-precise-memory-info',
  ]),
});
const page = await browser.newPage({ viewport: VIEWPORT });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  console.log(`LOD reveal band — ${describeGl()}`);
  await page.addInitScript(INSTALL);
  await page.goto(`${URL}/?debug&forceinput&quality=balanced`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
  // Every island GROUP exists after this, so what follows is first-DRAW cost,
  // never first-build cost.
  await page.waitForFunction(() => window.__piratesBR?.getWorldBuildBacklog?.() === 0, undefined, { timeout: 120_000 });
  await sleep(4000);

  const islands = await page.evaluate(() => (window.__piratesBR.state.islands ?? []).map((i) => ({
    id: i.id, x: i.position.x, z: i.position.z, r: i.radius,
  })));
  // Two islands far apart, so each is crossed from clean open water.
  const targets = [islands[0], islands[Math.floor(islands.length / 2)]].filter(Boolean);
  const edges = [1000, 900, 800, 700, 600, 500, 400];
  /** worst[islandId][edge] = [pass1, pass2, pass3] */
  const worst = new Map();

  for (let pass = 0; pass < 3; pass++) {
    for (const island of targets) {
      console.log(`\n  ── approach ${island.id}${pass ? ` (pass ${pass + 1})` : ''} ──`);
      // Start every pass from the same patch of open water, and throw the
      // sample away. The free-cam jump that gets there is a teleport across the
      // whole Reach — a different event from crossing one island's band, and
      // the only one this rig would otherwise fold into its first waypoint.
      await page.evaluate(([x, z]) => {
        window.__piratesBR.enableFreeCam(x + 4000, 40, z, -Math.PI / 2, -0.05);
      }, [island.x, island.z]);
      await sleep(2000);
      await page.evaluate(SAMPLE);
      for (const edge of edges) {
        await page.evaluate(([x, z, d]) => {
          window.__piratesBR.enableFreeCam(x + d, 40, z, -Math.PI / 2, -0.05);
        }, [island.x, island.z, island.r + edge]);
        await sleep(1600);
        const s = await page.evaluate(SAMPLE);
        const key = `${island.id}@${edge}`;
        if (!worst.has(key)) worst.set(key, []);
        worst.get(key).push(s.worstGapMs);
        console.log(
          `    edge ${String(edge).padStart(4)}m  geo ${String(s.geometries).padStart(5)}` +
          `  prog ${String(s.programs).padStart(3)}  draws ${String(s.calls).padStart(5)}` +
          `  worstGap ${String(s.worstGapMs).padStart(5)}ms  frames ${s.frames}`,
        );
      }
    }
  }
  await page.evaluate(() => window.__piratesBR.disableFreeCam());

  console.log('\n  waypoint            pass1    pass3   ratio');
  const offenders = [];
  let worstRatio = 0;
  let graded = 0;
  let worstStall = 0;
  let worstStallAt = '';
  for (const [key, passes] of worst) {
    const [first, , third] = passes;
    const ratio = first / Math.max(1, third);
    const isGraded = first > NOISE_FLOOR_MS;
    if (isGraded) { graded += 1; worstRatio = Math.max(worstRatio, ratio); }
    for (const ms of passes) {
      if (ms > worstStall) { worstStall = ms; worstStallAt = key; }
    }
    console.log(
      `  ${key.padEnd(22)}${String(first).padStart(5)}ms ${String(third).padStart(6)}ms` +
      `  ${ratio.toFixed(2)}x${isGraded ? '' : '  (under the noise floor)'}`,
    );
    if (isGraded && ratio > RATIO_LIMIT) offenders.push(`${key} ${first}ms vs ${third}ms (${ratio.toFixed(1)}x)`);
  }

  expect(
    'a first approach costs no more than twice a third approach',
    offenders.length === 0,
    offenders.join('\n     '),
  );
  console.log(
    graded > 0
      ? `    worst graded ratio ${worstRatio.toFixed(2)}x over ${graded}/${worst.size} waypoints above the ${NOISE_FLOOR_MS}ms floor`
      : `    no waypoint reached the ${NOISE_FLOOR_MS}ms floor — the ratio check had nothing to grade, which is the point`,
  );
  // The ratio goes quiet exactly when the fix works, so it cannot be the only
  // assertion: with every waypoint under the noise floor it grades nothing and
  // passes vacuously. This one is absolute and would have caught the original
  // 7917ms on its own.
  expect(
    'no waypoint on any pass stalls past 250ms',
    worstStall <= 250,
    `worst ${worstStall}ms at ${worstStallAt}`,
  );
  expect('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join('\n     '));
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nLOD reveal band checks passed.');
