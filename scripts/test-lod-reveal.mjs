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
// Needs the dev stack (vite 3000 + game server 8090).
//   node scripts/test-lod-reveal.mjs
//
// ORIGIN. This suite was written against :8090, and :8090 is the LOBBY server —
// it serves `dist/client`, a bundle only as fresh as the last `npm run build`.
// The checked-in one was six days and a whole content wave old, so the suite
// graded code that did not contain the mechanism it exists to prove and failed
// with a straight face. Every other browser suite in the repo reads
// PIRATES_BR_URL and points at vite, which serves the working tree; this one now
// does too. The guard below makes the mistake impossible to repeat quietly.
import { chromium } from 'playwright';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';

const URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const VIEWPORT = { width: 960, height: 540 };
/** Pass-1 stall allowed against the same waypoint's pass-3 stall. */
const RATIO_LIMIT = 2.0;
/** Below this a "stall" is ambient frame noise and a ratio off it means nothing. */
const NOISE_FLOOR_MS = 220;
/** New geometries a single frame may hand the driver. The chunked reveal lets
 *  out a bounded number of drawable units a frame, but a unit is a mesh and its
 *  children, so one unit can carry several geometries — this is the budget on
 *  the OUTCOME, which is what the player's frame actually pays. The unfixed
 *  reveal put 662 on one frame. */
const GEO_BURST_LIMIT = 96;
/** …and shader links, which are far more expensive apiece. */
const PROG_BURST_LIMIT = 4;

let failures = 0;
/** Assertions actually taken about the REVEAL. Both of this suite's grading
 *  paths — the per-frame burst counts and the pass-1/pass-3 ratio — stand down
 *  under a software rasteriser, for reasons argued at each site. What was left
 *  was a run that asserted "no page errors" and printed "checks passed", which
 *  reads in a suite log exactly like a graded green. Counted, so the last line
 *  can say which of the two it was. */
let substantive = 0;
function expect(label, condition, detail = '', counts = true) {
  if (counts) substantive += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// The burst, counted directly. `info.memory.geometries` is incremented by
// WebGLGeometries the first time a geometry is handed to the driver for a draw,
// and `info.programs.length` by the first link — so the per-FRAME delta of each
// is exactly "what this frame paid to the GL driver that no earlier frame had".
// That is the quantity the whole diagnosis is about (662 geometries and 5 links
// inside one 2654ms gap), and unlike a millisecond it means the same thing on a
// discrete GPU and on SwiftShader. Frame times here are advisory; these are not.
const INSTALL = () => {
  const w = window;
  w.__lod = { worst: 0, last: performance.now(), frames: 0, maxGeo: 0, maxProg: 0, prevGeo: -1, prevProg: -1 };
  const step = () => {
    const now = performance.now();
    const v = w.__lod;
    const dt = now - v.last;
    v.last = now;
    v.frames++;
    if (dt > v.worst) v.worst = dt;
    const info = w.__piratesBR?.renderer?.renderer?.info;
    if (info) {
      const geo = info.memory.geometries;
      const prog = info.programs?.length ?? 0;
      if (v.prevGeo >= 0) {
        if (geo - v.prevGeo > v.maxGeo) v.maxGeo = geo - v.prevGeo;
        if (prog - v.prevProg > v.maxProg) v.maxProg = prog - v.prevProg;
      }
      v.prevGeo = geo;
      v.prevProg = prog;
    }
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
  const maxGeo = v.maxGeo; v.maxGeo = 0;
  const maxProg = v.maxProg; v.maxProg = 0;
  return {
    programs: info?.programs?.length ?? -1,
    geometries: info?.memory?.geometries ?? -1,
    calls: info?.render?.calls ?? -1,
    worstGapMs: Math.round(worst),
    maxGeoPerFrame: maxGeo,
    maxProgPerFrame: maxProg,
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
  // Refuse to grade a client that has no warmer in it. Without this the suite
  // measures whatever the origin happens to serve and reports the verdict as if
  // it were about the working tree.
  const hasWarmer = await page.evaluate(() => !!window.__piratesBR?.lodWarmer);
  if (!hasWarmer) {
    throw new Error(
      `${URL} serves a client with no lodWarmer — this is a stale or pre-fix bundle, `
      + 'not the working tree. Point PIRATES_BR_URL at the vite dev server.',
    );
  }
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
  let burstGeo = { n: 0, at: '' };
  let burstProg = { n: 0, at: '' };
  let leanestWaypoint = Infinity;

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
        if (s.maxGeoPerFrame > burstGeo.n) burstGeo = { n: s.maxGeoPerFrame, at: `${key} pass ${pass + 1}` };
        if (s.maxProgPerFrame > burstProg.n) burstProg = { n: s.maxProgPerFrame, at: `${key} pass ${pass + 1}` };
        leanestWaypoint = Math.min(leanestWaypoint, s.frames);
        console.log(
          `    edge ${String(edge).padStart(4)}m  geo ${String(s.geometries).padStart(5)}` +
          `  prog ${String(s.programs).padStart(3)}  draws ${String(s.calls).padStart(5)}` +
          `  worstGap ${String(s.worstGapMs).padStart(5)}ms  frames ${s.frames}` +
          `  burst ${String(s.maxGeoPerFrame).padStart(3)}geo/${s.maxProgPerFrame}prog`,
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

  // ── the burst, counted ────────────────────────────────────────────────
  // These two are the real assertions. They count the thing the bug IS — work
  // handed to the GL driver on a single frame — so they are worth the same on
  // any backend, and they do not go vacuous when the machine happens to be fast.
  console.log(
    `\n  worst single frame: ${burstGeo.n} new geometries (${burstGeo.at || 'none'})`
    + `, ${burstProg.n} new programs (${burstProg.at || 'none'})`,
  );
  // The amortiser spreads a group of arrivals over consecutive FRAMES, so
  // grading it needs frames. SwiftShader draws this scene at one to five a
  // second: a waypoint parked at for 1.6s gets two or three, and "what landed on
  // one frame" then depends mostly on where the frame boundaries fell — on
  // identical code this read 143 and then 439. Rather than widen a limit to
  // cover that (it would stay widened on the GPU, where the limit is the whole
  // point), the check says plainly that it cannot be taken here. The contract it
  // would have enforced is held deterministically by
  // scripts/test-first-draw-budget.mjs, which needs no GL at all.
  const GRADEABLE_FRAMES = 20;
  if (leanestWaypoint < GRADEABLE_FRAMES) {
    console.log(
      `  ~ burst checks not graded: the leanest waypoint saw ${leanestWaypoint} frames, `
      + `under the ${GRADEABLE_FRAMES} a per-frame budget needs to be observable`,
    );
    console.log('    (the per-frame allowance is proven in scripts/test-first-draw-budget.mjs)');
  } else {
    expect(
      `no single frame uploads more than ${GEO_BURST_LIMIT} new geometries`,
      burstGeo.n <= GEO_BURST_LIMIT,
      `${burstGeo.n} at ${burstGeo.at} (the unfixed reveal put 662 on one frame)`,
    );
    expect(
      `no single frame links more than ${PROG_BURST_LIMIT} new programs`,
      burstProg.n <= PROG_BURST_LIMIT,
      `${burstProg.n} at ${burstProg.at}`,
    );
  }

  // ── the wall clock, where it means anything ───────────────────────────
  console.log(
    graded > 0
      ? `    worst graded ratio ${worstRatio.toFixed(2)}x over ${graded}/${worst.size} waypoints above the ${NOISE_FLOOR_MS}ms floor`
      : `    no waypoint reached the ${NOISE_FLOOR_MS}ms floor — the ratio check had nothing to grade, which is the point`,
  );
  // SwiftShader draws this scene at one to five frames a second, so a "worst rAF
  // gap" parked at a waypoint is mostly raster time and the pass-1/pass-3 ratio
  // is comparing two numbers made of noise — third passes measured 1972ms with
  // nothing left to upload at all. Grading it there would be reading tea leaves,
  // and widening the limit to make it pass would leave it widened on the GPU
  // path, where it is the assertion that matters. So it is graded on the GPU and
  // reported on software, and the burst counts above carry the suite either way.
  if (IS_SOFTWARE_GL) {
    console.log(`  ~ frame-time checks not graded under ${describeGl()}`);
    console.log(`    (advisory: worst ratio ${worstRatio.toFixed(2)}x, worst stall ${worstStall}ms at ${worstStallAt})`);
  } else {
    expect(
      'a first approach costs no more than twice a third approach',
      offenders.length === 0,
      offenders.join('\n     '),
    );
    expect(
      'no waypoint on any pass stalls past 250ms',
      worstStall <= 250,
      `worst ${worstStall}ms at ${worstStallAt}`,
    );
  }
  expect('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join('\n     '), false);
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  substantive > 0
    ? `\nLOD reveal band checks passed (${substantive} graded).`
    : '\nLOD reveal band NOT GRADED on this backend — the numbers above are advisory only,'
      + ' and the run is green because nothing was asserted about the reveal, not because'
      + ' the reveal was proved. The per-frame allowance is graded GL-free in'
      + ' scripts/test-first-draw-budget.mjs; the ratio needs the GPU path.',
);
