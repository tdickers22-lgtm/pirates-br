#!/usr/bin/env node
// Draw-call and triangle budget guard.
//
// Draw calls are the one renderer cost that creeps silently: every new prop
// type, every un-merged decoration, every light that stops being culled adds a
// few, nothing looks slower on the machine that added them, and six months
// later the wide shots cost twice what they did. This pins the views where that
// creep shows to ceilings a modest margin above what they measure today.
//
// WHY THIS RUNS ON THE SOFTWARE RASTERISER TOO.
//
// It used to `return` the moment it saw SwiftShader, on the reasoning that "the
// numbers are meaningless". Half of that was right and it threw the other half
// away. Frame TIMES on a CPU rasteriser are meaningless. Draw calls, triangles,
// programs and renderer.info.memory are not: they come out of three's own
// bookkeeping, decided by the scene graph, the frustum and the LOD gates, none
// of which know which GL backend is underneath. So this suite exits 0 in zero
// seconds on the only machine the game is built on — and a whole week of content
// (a 96x48 sky dome, terrain macro-noise and cave-cutout octaves, waterfall
// sheets, ~3,545 scattered props, grass, storm cloud deck) shipped against a
// tripwire that was never armed. The wide vista had drifted from 2206 draws to
// 2588 and the cave view to 4517 with nothing to say so.
//
// Now the COUNTS are graded on every backend, and only the timing report is
// gated to the GPU path. Choose the backend with PIRATES_GL (see
// lib/browser-args.mjs); the assertions are identical either way.
//
// WHY IT SETTLES BEFORE COUNTING. The LOD reveal and the shared first-draw
// allowance are paced per FRAME, so at a rasteriser's two-to-seven seconds a
// frame a fixed wall-clock warmup measures how much of the world has ARRIVED,
// not what the view costs. Counts taken that way read 687 draws at a dock vista
// that settles at 2057 — a lie in the cheap direction, which is the direction a
// budget must never be wrong in. measureScene's `settle` flag drives the world
// to its steady state first.
//
// WHY TWO TIERS. 'high' is the ceiling nobody should quietly raise. 'low' is
// what the fanless machines actually get after the tier detector landed, and a
// 'low' that is not markedly cheaper than 'high' is a bug that no single-tier
// gate can see.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import {
  FIND_WATERFALL_ISLAND, planWaterfallDeck, planWreckScene, TALLY_DRAW_SOURCES,
} from './lib/perf-scenes.mjs';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
/**
 * PIRATES_BR_SERVER_PORT is how this gate runs BESIDE a live match instead of
 * refusing to. A server somebody else started rolls a world these ceilings were
 * not measured on, and the check below rightly fails on it — but the only
 * remedies were "stop their game" or "grade nothing". Naming a port here makes
 * the runner stand up its own pinned server there, join it through the client's
 * `?server=` override, and leave :8090 alone. The health URL follows the port so
 * the two can never disagree about which server is being graded.
 */
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL
  ?? `http://127.0.0.1:${SERVER_PORT ?? '8090'}/health`;
const READY_TIMEOUT_MS = 45_000;
const VIEWPORT = { width: 960, height: 540 };

/**
 * THE WORLD HAS TO BE THE SAME WORLD.
 *
 * Every join rolls a fresh map, and these scenes are fixed points in it: the
 * dock vista stands off whichever island drew the dock, the deck look rides the
 * hull and frames whatever happens to be behind it. Graded against three
 * different worlds the same build read 1165, 1581 and 2742 draws at deck-aft —
 * a 2.4x spread that is entirely the map and not at all the renderer. A
 * tripwire cannot live on top of that: it either sits above the luckiest roll
 * and grades nothing, or it fails honest builds at random.
 *
 * So the runner pins PIRATES_BR_MAP_SEED on the server it starts. It cannot pin
 * a server somebody else already started — the seed is read once at match
 * generation — so it ASKS that server which world it rolls (/health carries
 * `mapSeed`) and grades it when the answer is this seed.
 *
 * WHEN THE ANSWER IS THE WRONG WORLD IT FAILS, and that is the whole point of
 * the change that put it here. This used to print a skip and `return`, which
 * exits 0 — so on the normal state of a developer's machine, with `npm run dev`
 * already up, `npm run test:perf` graded nothing and reported success in two
 * seconds. That is the exact failure this suite's own header was written about
 * ("it used to `return` the moment it saw SwiftShader"), rebuilt out of a
 * different material. A gate that cannot measure has not passed; it has failed
 * to run, and the two must not share an exit code. PIRATES_BR_ANY_MAP=1 is the
 * escape hatch for someone who knowingly wants a reading off an unpinned world.
 */
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
/** The seed as the server normalises it, for comparing against /health. */
const MAP_SEED_N = Number.parseInt(MAP_SEED, 10) >>> 0;
const ALLOW_ANY_MAP = process.env.PIRATES_BR_ANY_MAP === '1';

// A 16:9 viewport of any size produces the same frustum, so counts at 960x540
// are counts at 1600x900 — and the smaller one is kinder to the machine.

/**
 * THE TRIPWIRES.
 *
 * `measured` is the HIGHEST this scene read across consecutive runs of this
 * suite on the pinned map (2026-08-02, SwiftShader, quality pinned, pixel ratio
 * 1). `draws`/`tris` are ceilings a modest margin above that — roughly 1.12x,
 * not the 1.3x the July table used, because a 30% allowance is a whole content
 * wave of silent drift.
 *
 * RE-DERIVED 2026-08-02 AFTER THE GEOMETRY PASS, over four consecutive runs.
 * Every triangle ceiling in this table came down, some of them a long way: the
 * pebble scatter, the cave portal frames and the ocean's outer ring together
 * took 74k to 198k triangles a frame out of these views, and a ceiling left
 * where it was is a blind spot the exact width of the saving. Open water was the
 * worst of them — 1,150k against a reality of 828k, a 39% gap, which is the same
 * mistake this table's previous note was written about.
 *
 * AND WHAT THIS TABLE STILL CANNOT SEE, said plainly so nobody trusts it for
 * more than it does. A ceiling at 1.12x of a whole frame cannot catch the loss
 * of ONE geometry lever: reverting all three of the above at once puts ~104k
 * triangles back on a dock vista that measures 1,784k, which is 5.8% and well
 * inside the margin — and tightening the margin to 1.06 would put it inside this
 * scene's own run-to-run spread (1,646-1,727 draws over four runs) and start
 * failing honest builds. Those levers are guarded one at a time, on themselves,
 * in scripts/test-geometry-lod.mjs. This table guards the SUM.
 *
 * WHY EVERY NUMBER HERE MOVED ONCE. The first version of this table was written
 * before the map was pinned, so every `measured` in it was a reading from a
 * world these scenes will never see again, and the ceilings inherited that
 * world's luck. On the pinned map the errors ran both ways and neither was
 * harmless: open water was set at 1600 against a reality of 1110 (a 44% blind
 * spot — the batcher could be deleted outright and open water would not
 * notice), while the wide vista was set at 1900 against readings that reached
 * 1827, four percent of headroom on a scene whose own run-to-run spread is six.
 * A ceiling is only worth what the reading under it is worth, and a reading from
 * a different world is worth nothing. These are re-derived from the pinned one.
 *
 * RAISING A NUMBER HERE IS A DECISION, NOT A FIX. If a change is worth the
 * draws, say so in the commit that raises it; if it is not, the change is what
 * needs adjusting. Widening the ceiling to fit a regression is how the July
 * table came to be 30% above a reality nobody had measured in a month.
 */
const BUDGETS = {
  high: [
    // Four pinned runs after the geometry pass: 1646-1727 draws, 1694-1784k
    // tris. The draw ceiling STAYS at 1950 and is the one number here that was
    // not re-derived downward — it is set by a different failure. 1950 is the
    // smallest value that clears this scene's own ~5% spread and still fails a
    // return to per-plank drawing, which reads 2043 here (measured, batcher
    // removed); taking it to 1934 to honour the 1.12x rule would buy nothing and
    // put the batcher's tripwire inside the noise. The triangle ceiling did come
    // down, 2,250k -> 2,000k, against a reading that fell 1,885k -> 1,784k.
    { scene: 'dock-vista', label: 'wide island vista', measured: 1727, draws: 1950, tris: 2_000_000 },
    // THE ONE SCENE WHOSE FRAME MOVES, and the widest ceiling in the table
    // because of it. The camera rides the hull, so which islands are behind it
    // is a fact about where the ship is lying when the measurement lands — and
    // the ship is still drifting an hour into a run. Read 1165, 1581, 2742 and
    // 2660 across unpinned worlds; pinning removed most of that spread and the
    // rest is the hull's own position: 2455-2653 over five pinned runs.
    //
    // No before/after is claimed here: the pre-diet 2766/2481k was taken in a
    // DIFFERENT world, so the two numbers are not comparable and pretending
    // otherwise would credit the diet with a scene it barely touched. What the
    // ceiling is for is a return to per-plank drawing, which would clear it.
    { scene: 'deck-aft', label: 'on-deck aft look', measured: 2329, draws: 2650, tris: 2_900_000 },
    // 983-996 draws / 826-828k tris across four pinned runs — still the
    // steadiest scene in the table, and still the one its ceiling is blindest
    // at. It was 1,600 draws against 1,115 in July; the pass before this one cut
    // it to 1,250/1,150k; the sea's outer ring, the pebbles and the portal
    // frames then took the reading to 828k, at which point a 1,150k ceiling was
    // a 39% blind spot — wide enough to hide the whole of this pass twice.
    { scene: 'open-sea', label: 'open water', measured: 996, draws: 1120, tris: 930_000 },
    // 2337-2360 / 2435-2438k over four pinned runs, down from 2,395/2,576k
    // before the geometry pass. The waterfall wave's own view, which the July
    // table never had.
    { scene: 'waterfall-deck', label: 'deck view of a waterfall island', measured: 2360, draws: 2650, tris: 2_750_000 },
    // 2762-2911 / 2744-2769k over FIVE pinned runs, down from 2,803/2,944k. The
    // dearest view in the game, and still the proof that standing in a hole in
    // the ground pays for every island on the map: the cave frame carries twelve
    // portal frames, which is why it gained the most triangles from thinning
    // them (216k -> 195k) and still costs more than any view above it.
    //
    // The first cut of this row said 2777/3120/3100k off four runs. A fifth run
    // read 2911 draws — inside the same build, the same seed and the same
    // camera, so it is this scene's spread and not a regression — and a 3120
    // ceiling over a 2911 reading is 7%, not the 12% this table claims for
    // itself. Widened to the rule, with the sample that moved it named: five
    // samples of a 5% spread is not many, and a ceiling that quietly means half
    // what its header says is the thing this table keeps being rewritten about.
    { scene: 'cave-interior', label: 'cave interior', measured: 2911, draws: 3250, tris: 3_150_000 },
  ],
  // 'low' came in far under the targets it was written against (~1800 dock,
  // ~1400 open sea), so these are its MEASURED cost plus a margin rather than
  // the aspiration — a ceiling nothing has ever approached grades nothing. The
  // ratio checks below are the other half of the assertion.
  //
  // AND 'low' BARELY MOVED IN THE GEOMETRY PASS: 528k -> 515k at the dock vista
  // and 156k -> 156k at sea. That is not the pass underperforming, it is where
  // the pass landed — the pebble scatter is never built at 'low' (lowDetail
  // skips it), the ocean's outer ring at 'low' was already the coarse one the
  // other tiers were moved onto, and a 'low' portal frame is half the stones to
  // begin with. The only thing 'low' gained is the group cull, which is CPU and
  // shows up in no column here. A tier whose ceiling does not move when the
  // frame gets cheaper is a tier that was not made cheaper, and this table
  // should say so rather than let the high-tier numbers speak for both.
  low: [
    // 591-601 draws / 515k tris over five pinned runs; 601 came from the fifth.
    { scene: 'dock-vista', label: 'wide island vista (low tier)', measured: 601, draws: 680, tris: 580_000 },
    { scene: 'open-sea', label: 'open water (low tier)', measured: 283, draws: 320, tris: 180_000 },
  ],
  // 'balanced' IS THE DEFAULT VERDICT FOR MOST MACHINES — every Intel laptop,
  // every phone, every Safari Air and every 8-thread desktop lands here — and
  // until wave 0.4 it was the one tier no row graded and no census had ever
  // read (perf-09). A regression that touched only balanced (its 1536² shadow
  // map, its FXAA path, its 300 m full-detail radius) passed this suite.
  //
  // PROVISIONAL CEILINGS: ONE pinned SwiftShader run (2026-09-02, HEAD
  // 62f29387, seed 20260801) at the +12% rule, not the four runs the high
  // table earned. Same run read high at 1212/1783k dock, 652/825k sea,
  // 1837/2777k cave, so balanced sits at 71/72%, 68/43% and 75/59% of high.
  // Lane 2.6 (PERF-01) re-pins these off four runs when it lands the tier
  // rules; until then a red row here is a reading to check, not a verdict.
  // Mutation proof (run 2026-09-02): InstanceLod PROP_DENSITY_RAMP.balanced
  // never thinning + MIN_INSTANCE_PIXELS.balanced 0.1 → open-sea 396k and
  // cave-interior 1944k triangles, both rows FAIL; dock-vista only rose 6%
  // (its props sit inside the 300 m full-detail radius), so it is the two
  // far-prop scenes that guard the ramp, not the vista.
  balanced: [
    { scene: 'dock-vista', label: 'wide island vista (balanced tier)', measured: 864, draws: 970, tris: 1_430_000 },
    { scene: 'open-sea', label: 'open water (balanced tier)', measured: 442, draws: 495, tris: 395_000 },
    { scene: 'cave-interior', label: 'cave interior (balanced tier)', measured: 1374, draws: 1540, tris: 1_835_000 },
  ],
};

/** THE GILDED WRECK gets her OWN ceiling, and it is not the dock's.
 *
 *  She only exists for one storm phase in the middle of a match, so she never
 *  showed up in either scene above — and near-wreck frames were measured at
 *  2888-2971 draws against a 2900 ceiling that was never meant to cover her.
 *  Re-derived after the geometry pass over four pinned runs: 1576-1845 draws,
 *  1627-1688k tris. Hers is the widest DRAW spread left in the suite (17%) and
 *  the reason is hers alone — she rises at a ring centre that moves, so what is
 *  behind her is a different set of islands each run.
 *  Grading her by the dock's number is grading two different views with one
 *  ruler: nobody looking at the wreck is also looking at a dock, a tavern and
 *  a full island of props.
 *
 *  Needs a wreck up: the runner hands PIRATES_WRECK_SEC to any server it starts
 *  itself, and SKIPS this one scene (never fails) against a server that was
 *  already running without it. */
const WRECK_BUDGET = { label: 'the Gilded Wreck alongside', measured: 1845, draws: 2100, tris: 1_900_000 };
/** Seconds after the horn the dev server raises her for this measurement. */
const WRECK_RAISE_SEC = 12;
/** How long to wait for her after the join before giving up and skipping. */
const WRECK_WAIT_MS = 90_000;

/** The low tier exists to be CHEAPER. These are the ratios it must beat against
 *  the same scene at 'high' — a 'low' that saves nothing is a menu entry that
 *  lies to the player about what it will do for their frame rate.
 *
 *  Measured on the pinned map, low comes in at 30-34% of high's draws and
 *  18-30% of its triangles, so the 0.72/0.68 these started at could have been
 *  met by a 'low' twice as expensive as the one that ships. */
const LOW_TIER_MAX_RATIO = { draws: 0.50, tris: 0.45 };
/** And 'balanced' exists to be cheaper than 'high' by a margin a player can
 *  feel: at most 80% of high's draws and triangles at the same placement. */
const MID_TIER_MAX_RATIO = { draws: 0.80, tris: 0.80 };

let failures = 0;
/** MUTATION KNOB for this gate's own proof. PIRATES_BR_MUTATE_DROP_SCENE=dock-vista
 *  deletes that placement after planScenes, and the row-count assertion below
 *  must then FAIL. A gate that cannot fail is a bug; this shows it can. */
const MUTATE_DROP_SCENE = process.env.PIRATES_BR_MUTATE_DROP_SCENE ?? '';
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The map seed a server that this runner did NOT start is rolling, or null
 *  when it is unpinned (or too old to say). */
async function readMapSeed(healthUrl) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.mapSeed === 'number' ? body.mapSeed : null;
  } catch {
    return null;
  }
}

async function waitForReady(url, child) {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await isReady(url)) return;
    if (child && child.exitCode !== null) throw new Error(`dev server exited early with code ${child.exitCode}`);
    await sleep(350);
  }
  throw new Error(`dev server did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`);
}

function startNpmScript(scriptName) {
  const child = spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    // The wreck is a mid-match event: without this hook she rises at the first
    // ring shrink, four minutes after the join, and the scene below would time
    // out waiting for a hull that is coming but not yet.
    env: {
      ...process.env,
      BROWSER: 'none',
      PIRATES_WRECK_SEC: String(WRECK_RAISE_SEC),
      // …and the same map every run. See MAP_SEED.
      PIRATES_BR_MAP_SEED: MAP_SEED,
      // …on its own port when one was named, so a graded run does not have to
      // evict the person playing on :8090.
      ...(SERVER_PORT ? { PORT: String(SERVER_PORT) } : {}),
    },
  });
  return { child, scriptName };
}

function stopDevServer(handle) {
  const child = handle?.child ?? handle;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch {
    try { child.kill('SIGINT'); } catch { /* already gone */ }
  }
}

/** Join a solo match at a pinned tier and measure every budgeted scene in it.
 *  One page per tier, closed before the next opens: two live rAF loops on a CPU
 *  rasteriser is exactly the concurrency this repo's crash history is made of. */
async function measureTier(browser, quality, { wantWreck }) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const results = {};
  try {
    await page.goto(
      `${ROOT_URL.replace(/\/$/, '')}/?${sessionQuery(['debug', `quality=${quality}`])}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    // The options bag is waitForFunction's THIRD argument. Passed as the second
    // it is silently taken as the page-function's ARG, the 30s default applies,
    // and a loaded box then reports "the join timed out" 90 seconds early — a
    // lie about the game told by the instrument.
    await page.waitForFunction(
      () => window.__piratesBR?.state?.phase === 'playing',
      null,
      { timeout: 240_000 },
    );
    // Let the streamed island/sea-rock build queues finish before counting.
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    const plan = planScenes(await readWorld(page));
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) plan['waterfall-deck'] = planWaterfallDeck(waterfall);
    if (MUTATE_DROP_SCENE && plan[MUTATE_DROP_SCENE]) {
      delete plan[MUTATE_DROP_SCENE];
      console.log(`  ! mutation: dropped the ${MUTATE_DROP_SCENE} placement (PIRATES_BR_MUTATE_DROP_SCENE)`);
    }

    let graded = 0;
    const skipped = [];
    for (const budget of BUDGETS[quality]) {
      if (!plan[budget.scene]) {
        console.log(`  – ${budget.scene}: no placement in this world, skipped`);
        skipped.push(budget.scene);
        continue;
      }
      // Resolution is pinned so the budget measures geometry, not screen area.
      await page.evaluate(PIN_PIXEL_RATIO);
      // settle: true — see the header. A count taken mid-reveal is a lie.
      const r = await measureScene(page, plan[budget.scene], { warmupMs: 2500, captureMs: 3000, settle: true });
      const sources = await page.evaluate(TALLY_DRAW_SOURCES).catch(() => []);
      results[budget.scene] = { draws: Math.round(r.draws), tris: Math.round(r.tris), peakDraws: r.peakDraws, sources };
      report(quality, budget, results[budget.scene], r);
      graded += 1;
    }
    // EVERY ROW OR NO PASS. A placement that went missing (a readWorld or
    // planScenes change, a world without the feature) used to drop its row from
    // the table behind a one-line "skipped" and the suite still said PASS with
    // a smaller table. The wreck row below is the only optional one, and only
    // because a server this runner did not start has no PIRATES_WRECK_SEC hook.
    expect(
      `all ${BUDGETS[quality].length} ${quality} scenes graded`,
      graded === BUDGETS[quality].length,
      `graded ${graded}, skipped: ${skipped.join(', ') || 'none'}`,
    );

    if (wantWreck) {
      const wreck = await page
        .waitForFunction(() => window.__piratesBR?.state?.wreck ?? null, null, { timeout: WRECK_WAIT_MS })
        .then((handle) => handle.jsonValue())
        .catch(() => null);
      if (!wreck) {
        console.log('  – wreck scene skipped: no Gilded Wreck rose '
          + '(a server started outside this runner has no PIRATES_WRECK_SEC hook)');
      } else {
        await page.evaluate(PIN_PIXEL_RATIO);
        const r = await measureScene(page, planWreckScene(wreck), { warmupMs: 2500, captureMs: 3000, settle: true });
        results.wreck = { draws: Math.round(r.draws), tris: Math.round(r.tris), peakDraws: r.peakDraws, sources: [] };
        report(quality, { scene: 'wreck', ...WRECK_BUDGET }, results.wreck, r);
      }
    }

    expect(`No page errors at quality=${quality}`, errors.length === 0, errors.join('\n'));
  } finally {
    await page.close().catch(() => {});
  }
  return results;
}

function report(quality, budget, got, raw) {
  const timing = IS_SOFTWARE_GL
    ? `${raw.frames} frames, med ${raw.medianMs.toFixed(0)}ms ADVISORY`
    : `${(1000 / raw.medianMs).toFixed(1)} fps`;
  console.log(
    `  [${quality}] ${budget.scene}: ${got.draws} draws (peak ${got.peakDraws}), `
    + `${Math.round(got.tris / 1000)}k tris, ${raw.programs} programs (${timing})`,
  );
  if (got.sources?.length) {
    console.log(`      by source: ${got.sources.slice(0, 8).map((s) => `${s.source}=${s.calls}`).join('  ')}`);
  }
  expect(
    `[${quality}] ${budget.label} stays under ${budget.draws} draw calls`,
    got.draws <= budget.draws,
    `measured ${got.draws}, ceiling ${budget.draws} (was ${budget.measured} when the ceiling was set)`,
  );
  expect(
    `[${quality}] ${budget.label} stays under ${Math.round(budget.tris / 1000)}k triangles`,
    got.tris <= budget.tris,
    `measured ${Math.round(got.tris / 1000)}k, ceiling ${Math.round(budget.tris / 1000)}k`,
  );
}

async function main() {
  console.log(`Draw-call budget — GL: ${describeGl()}`);

  let browser;
  try {
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  } catch (error) {
    console.log(`  – skipped: could not launch a browser (${error?.message ?? error})`);
    return;
  }

  const started = [];
  try {
    const hadClient = await isReady(ROOT_URL);
    const hadServer = await isReady(SERVER_HEALTH_URL);
    if (!hadClient && !hadServer) {
      const stack = startNpmScript('dev');
      started.push(stack);
      await waitForReady(ROOT_URL, stack.child);
      await waitForReady(SERVER_HEALTH_URL, stack.child);
    } else {
      if (!hadClient) {
        const client = startNpmScript('dev:client');
        started.push(client);
        await waitForReady(ROOT_URL, client.child);
      }
      if (!hadServer) {
        const server = startNpmScript('dev:server');
        started.push(server);
        await waitForReady(SERVER_HEALTH_URL, server.child);
      }
    }
    // Both hooks — the pinned map and the early wreck — reach only a server
    // THIS runner started. Against one that was already up, the world is a
    // different world and the ceilings below do not describe it.
    const ownServer = started.some((h) => h.scriptName === 'dev' || h.scriptName === 'dev:server');
    if (!ownServer) {
      const seed = await readMapSeed(SERVER_HEALTH_URL);
      if (seed === MAP_SEED_N) {
        console.log(`  · grading against a server started elsewhere on the same map (seed ${MAP_SEED}).`);
      } else if (ALLOW_ANY_MAP) {
        console.log(
          `  · PIRATES_BR_ANY_MAP=1: grading against map seed ${seed ?? 'unpinned'}, which is NOT `
          + `${MAP_SEED}.\n     These ceilings do not describe this world; read the numbers, not the verdict.`,
        );
      } else {
        console.error(
          '  ✗ FAIL: cannot grade — a game server was already running and it rolls '
          + `map seed ${seed ?? 'unpinned (a fresh world every join)'}, not the ${MAP_SEED} these\n`
          + '     ceilings were measured on. The same build reads anywhere from 1165 to 2742 draws\n'
          + '     at the same scene across worlds, so a reading from that one grades nothing.\n'
          + `     Stop it and re-run, or start it with PIRATES_BR_MAP_SEED=${MAP_SEED}.`,
        );
        // NOT `failures += 1; return` — this return is inside the try, so the
        // `if (failures > 0) process.exit(1)` after the finally never runs and
        // the process would exit 0 with FAIL on the screen.
        process.exitCode = 1;
        return;
      }
    }
    const wantWreck = ownServer;

    const high = await measureTier(browser, 'high', { wantWreck });
    const balanced = await measureTier(browser, 'balanced', { wantWreck: false });
    const low = await measureTier(browser, 'low', { wantWreck: false });

    for (const budget of BUDGETS.balanced) {
      const a = high[budget.scene];
      const b = balanced[budget.scene];
      if (!a || !b) continue;
      expect(
        `balanced tier draws no more than ${Math.round(MID_TIER_MAX_RATIO.draws * 100)}% of high at ${budget.scene}`,
        b.draws <= a.draws * MID_TIER_MAX_RATIO.draws,
        `balanced ${b.draws} vs high ${a.draws} (${Math.round((b.draws / a.draws) * 100)}%)`,
      );
      expect(
        `balanced tier draws no more than ${Math.round(MID_TIER_MAX_RATIO.tris * 100)}% of high's triangles at ${budget.scene}`,
        b.tris <= a.tris * MID_TIER_MAX_RATIO.tris,
        `balanced ${Math.round(b.tris / 1000)}k vs high ${Math.round(a.tris / 1000)}k (${Math.round((b.tris / a.tris) * 100)}%)`,
      );
    }

    // ── 'low' must actually be low ───────────────────────────────────────
    for (const budget of BUDGETS.low) {
      const a = high[budget.scene];
      const b = low[budget.scene];
      if (!a || !b) continue;
      expect(
        `low tier draws no more than ${Math.round(LOW_TIER_MAX_RATIO.draws * 100)}% of high at ${budget.scene}`,
        b.draws <= a.draws * LOW_TIER_MAX_RATIO.draws,
        `low ${b.draws} vs high ${a.draws} (${Math.round((b.draws / a.draws) * 100)}%)`,
      );
      expect(
        `low tier draws no more than ${Math.round(LOW_TIER_MAX_RATIO.tris * 100)}% of high's triangles at ${budget.scene}`,
        b.tris <= a.tris * LOW_TIER_MAX_RATIO.tris,
        `low ${Math.round(b.tris / 1000)}k vs high ${Math.round(a.tris / 1000)}k (${Math.round((b.tris / a.tris) * 100)}%)`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
    for (const handle of started.reverse()) {
      stopDevServer(handle);
      await sleep(900);
      if (handle.child.exitCode === null) {
        try { handle.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  }

  if (failures > 0) process.exit(1);
  console.log('\nDraw-call budget passed.');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
