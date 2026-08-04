#!/usr/bin/env node
// NO SHADER PROGRAM MAY LINK IN A FRAME THE PLAYER IS MOVING THROUGH.
//
// Lever 1 of docs/FRAME_COST_MODEL.md is the largest hitch source the game has:
// three r160 defers a program's uniform reflection to the first DRAW that uses
// it, so a material that comes into view mid-match takes its whole link inside
// that frame. Measured at `high` before this gate existed: 56 of 87 hitches and
// 93,523 ms — 77.0% of ALL hitched time in a 120 s capture — and eleven of the
// twelve worst individual hitches.
//
// `ProgramWarmer` exists to pay that bill early. This suite is the thing that
// says whether it did, and it counts rather than times: a link taken inside a
// draw is exact, one increment per program per session, and it means the same
// thing on SwiftShader as it does on Metal. Milliseconds are printed for shape
// and never asserted on — on the software rasteriser they are the machine's
// mood, not the build's.
//
//   node scripts/test-program-warm.mjs --quality high
//   node scripts/test-program-warm.mjs --quality low
//   node scripts/test-program-warm.mjs --mutate          # the gate must FAIL
//   node scripts/test-program-warm.mjs --mutate-lights   # …and so must this
//
// THE SECOND THING THIS GATE COUNTS, added after the first one missed it: a
// program that is linked TWICE because a light entered or left the scene.
// three folds every light COUNT into the program cache key, so one light
// appearing re-links every material the frame draws — material the warmer has
// already paid for, at a moment it can do nothing about. Measured at `high`
// over 90 s: 31 of 135 keys were duplicates differing only in numHemiLights,
// and 28 of the 40 links taken during play were them, all inside one 600 ms
// window at the instant the spectate camera rose. The tour now dies on purpose,
// because nine islands of sightseeing found none of it.
//
// MUTATION (`--mutate`) neuters `ProgramWarmer` the moment the game object is
// created — before a single island streams — so nothing is ever paid for outside
// a draw and every program links in the frame that first draws it. A run with the
// mutation armed inverts the verdict: green means the gate is blind.
//
// WHAT EACH ASSERTION CAN AND CANNOT CATCH, because a gate that overstates its
// reach is worse than none. The count of programs linking during PLAY is the
// lever's own claim and is asserted as a ratchet — but on the pinned map this
// scripted tour is not by itself sensitive enough to separate a warmed build
// from an unwarmed one (4 links against 5), because the load pays for almost
// everything either way and only what arrives afterwards is left to differ. What
// separates them unmistakably is WHERE the joins were taken: with the warmer
// alive a third of them are paid outside any draw, and with it disabled that
// number is zero. Both are asserted. The first is the budget that must ratchet
// down; the second is the tripwire that fails the instant the mechanism stops
// running at all.
import { chromium } from 'playwright';
import process from 'node:process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { PROGRAM_CENSUS_SOURCE } from './lib/program-census.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };
const MUTATE = argv.includes('--mutate');
/**
 * The second mutation, and it exists because the first cannot reach the new
 * assertion. Disabling the warmer proves the warmer runs; it says nothing about
 * a light count that moves mid-match, because no warmer can defend against
 * that. `--mutate-lights` puts the defect back exactly as it was found: one
 * extra HemisphereLight added to the scene after first control. The gate must
 * go red, and specifically on the light-count line.
 */
const MUTATE_LIGHTS = argv.includes('--mutate-lights');
const MUTATING = MUTATE || MUTATE_LIGHTS;

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3101')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const FRAMES_PER_STOP = parseInt(arg('frames', '14'), 10);
const MAX_ISLANDS = parseInt(arg('islands', '8'), 10);
const VIEWPORT = { width: 960, height: 540 };

/**
 * THE ALLOWLIST, and the reason each line is on it.
 *
 * Every entry is a shader TYPE — the first field of three's program cache key —
 * not a material, so nothing can be quietly added to it by naming a new
 * material. There is one entry.
 *
 *   depth / distance
 *     The shadow pass does not draw an object's own material. `getDepthMaterial`
 *     keeps a single `MeshDepthMaterial`, restamps it per object immediately
 *     before the draw and renders that, with an EMPTY scene, a render state
 *     holding no lights, and a bound render target. Nothing in the scene graph
 *     owns those programs, so no warm walk can find them, and `renderer.compile`
 *     cannot produce their cache key — an attempt to mirror the material by hand
 *     was built, measured (137 → 167 live programs, draw-time links 26 → 32) and
 *     reverted; see the note in src/client/rendering/ProgramWarmup.ts. Paying
 *     these means driving `shadowMap.render` itself, which collides with the
 *     shadow update gate, and it is named as remaining work rather than hidden.
 *     `low` has no shadow map at all and so has none of these.
 */
const ALLOWED_SHADER_TYPES = new Set(['depth', 'distance']);

/**
 * How many programs may still link inside a drawn frame during play.
 *
 * A budget, not a permission. The number is what this build measures with margin
 * — it is a ratchet, and the only correct direction for it is down. Baseline
 * before the warm walk was fixed: 36 at `high` over 90 s (27,964 ms of joins),
 * with the load guard nominally up the whole time.
 */
const BUDGET = { high: 22, low: 14 };
// Measured on this tour, pinned map, software ANGLE: high 3-4, low 10. The high
// budget is deliberately far above what it measures because it is inherited from
// the free-roam census that produced the lever's own baseline (36 links / 27,964
// ms over 90 s of sailing) and is meant to catch a REGRESSION of that shape, not
// to fence in this tour. The low budget is close to its measurement because the
// low tier streams less during the load, so the tour reaches more first-time
// material and there is genuinely more to catch. Both ratchet down, never up.

/** Joins that must be paid outside any draw for the mechanism to count as
 *  running at all. Clean build: 15. Warmer disabled from construction: 0. */
const WARMED_JOIN_FLOOR = 8;

/**
 * A TOUR, NOT A WALK, and the difference is the whole gate.
 *
 * The first version of this suite drove the pirate around with the keys for
 * sixty seconds, which is what the profiling rigs do — and it could not tell a
 * warmed build from an unwarmed one, because in sixty seconds of walking the
 * player reaches almost nothing he has not already seen: the mutation run linked
 * four programs against a clean run's one, and both were nowhere near any budget
 * worth writing down. A gate that cannot separate the two builds proves nothing,
 * however green it is.
 *
 * So the session visits the WORLD: every island in turn, from an offshore vista
 * and again from above its interior, on the pinned map, through the debug free
 * cam. That is the "walk round a corner" case the cost model names, performed
 * deliberately and in the same order every run — each stop drags a new island's
 * terrain, strata, decor, foliage and props into the frustum, which is exactly
 * the material whose programs have not been linked yet.
 *
 * Stops are counted in FRAMES, never in milliseconds: on the software rasteriser
 * a wall-clock stop measures how busy the machine is, and this suite is supposed
 * to measure the build.
 */
const DRIVE = `
window.__tour = {
  stops: 0,
  async frames(n) { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); },
  async run(framesPerStop, maxIslands) {
    const g = window.__piratesBR;
    const islands = (g.state?.islands ?? []).slice(0, maxIslands);
    for (const isl of islands) {
      const r = isl.radius ?? 60;
      // Offshore vista: the whole island silhouette, its shore skirt, its decor.
      const vx = isl.x - (r + 80), vz = isl.z - (r + 80);
      g.enableFreeCam(vx, 34, vz, Math.atan2(isl.x - vx, isl.z - vz), -0.18);
      this.stops += 1;
      await this.frames(framesPerStop);
      // And from above the middle, looking down: interior props, caves' mouths,
      // terrain features, ground cover — none of which the vista resolves.
      g.enableFreeCam(isl.x + r * 0.30, 26, isl.z + r * 0.20, 2.35, -0.55);
      this.stops += 1;
      await this.frames(framesPerStop);
    }
    g.disableFreeCam();
    await this.frames(framesPerStop);
    // ── AND THEN DIE ──────────────────────────────────────────────────────
    // A tour that only ever LOOKS at the world cannot reach the frames that
    // cost the most. Death is a state change that touches the scene's LIGHTING,
    // and every light count is a field of three's program cache key: the
    // spectate fill used to be a second HemisphereLight built on first death,
    // and it re-linked 31 of the session's 135 programs in one 600 ms window
    // with the player watching. Nine islands of sightseeing found none of it.
    try {
      const p = g.getLocalPlayer();
      if (p) {
        p.state = 'eliminated';
        const until = performance.now() + 30000;
        while (g.spectateLift < 0.995 && performance.now() < until) await this.frames(2);
        await this.frames(framesPerStop);
        p.state = 'alive';
        while (g.spectateLift > 0.005 && performance.now() < until + 10000) await this.frames(2);
        await this.frames(framesPerStop);
      }
    } catch (e) { window.__tourDeathError = String(e && e.message); }
    return this.stops;
  },
};
`;

const shaderTypeOf = (cacheKey) => String(cacheKey).split(',')[0];

/**
 * THE SAME PROGRAM, LINKED TWICE, BECAUSE A LIGHT CAME OR WENT.
 *
 * three folds the scene's light COUNTS into every program's cache key
 * (`WebGLPrograms.getProgramCacheKeyParameters` — numDirLights, numPointLights,
 * numSpotLights, numHemiLights, the shadow counts and numLightProbes). So one
 * light entering or leaving the scene does not cost one program: it costs a
 * fresh link of EVERY MATERIAL THE FRAME DRAWS, taken inside that frame,
 * however thoroughly the warmer paid for the same GLSL a minute earlier.
 *
 * `LightBudget` exists because of this and pins the point-light count; nothing
 * was enforcing it for the rest. Measured before this check, `high`, 90 s: 31 of
 * 135 keys were duplicates differing in numHemiLights alone, and 28 of the 40
 * links taken during play were them.
 *
 * The check is EXACT and needs no clock: normalise every key by blanking the
 * light-count fields, and any normalised key that maps to more than one real key
 * is a pair of programs that are the same shader compiled for different light
 * counts. Counting from the END is what makes it robust — the head of a cache
 * key is the shader id plus a material's own `defines`, which varies in length.
 */
const CACHE_KEY_TAIL = [
  'precision', 'outputColorSpace', 'envMapMode', 'envMapCubeUVHeight', 'mapUv', 'alphaMapUv',
  'lightMapUv', 'aoMapUv', 'bumpMapUv', 'normalMapUv', 'displacementMapUv', 'emissiveMapUv',
  'metalnessMapUv', 'roughnessMapUv', 'anisotropyMapUv', 'clearcoatMapUv', 'clearcoatNormalMapUv',
  'clearcoatRoughnessMapUv', 'iridescenceMapUv', 'iridescenceThicknessMapUv', 'sheenColorMapUv',
  'sheenRoughnessMapUv', 'specularMapUv', 'specularColorMapUv', 'specularIntensityMapUv',
  'transmissionMapUv', 'thicknessMapUv', 'combine', 'fogExp2', 'sizeAttenuation',
  'morphTargetsCount', 'morphAttributeCount', 'numDirLights', 'numPointLights', 'numSpotLights',
  'numSpotLightMaps', 'numHemiLights', 'numRectAreaLights', 'numDirLightShadows',
  'numPointLightShadows', 'numSpotLightShadows', 'numSpotLightShadowsWithMaps', 'numLightProbes',
  'shadowMapType', 'toneMapping', 'numClippingPlanes', 'numClipIntersection', 'depthPacking',
  'booleanMaskA', 'booleanMaskB', 'outputColorSpaceTail', 'customProgramCacheKey',
];
/** The fields a light entering or leaving the scene moves. */
const LIGHT_COUNT_FIELDS = new Set([
  'numDirLights', 'numPointLights', 'numSpotLights', 'numSpotLightMaps', 'numHemiLights',
  'numRectAreaLights', 'numDirLightShadows', 'numPointLightShadows', 'numSpotLightShadows',
  'numSpotLightShadowsWithMaps', 'numLightProbes',
]);

function lightCountChurn(entries) {
  const groups = new Map();
  for (const e of entries) {
    const parts = String(e.cacheKey).split(',');
    if (parts.length < CACHE_KEY_TAIL.length) continue; // RawShaderMaterial &c: no parameter tail
    const cut = parts.length - CACHE_KEY_TAIL.length;
    const normal = parts.slice(0, cut).join(',') + '|'
      + parts.slice(cut).map((v, i) => (LIGHT_COUNT_FIELDS.has(CACHE_KEY_TAIL[i]) ? '*' : v)).join(',');
    let row = groups.get(normal);
    if (!row) groups.set(normal, (row = { keys: new Map(), name: e.materialName || e.object || e.material }));
    if (!row.keys.has(e.cacheKey)) row.keys.set(e.cacheKey, parts.slice(cut));
  }
  const churn = [];
  for (const row of groups.values()) {
    if (row.keys.size < 2) continue;
    const variants = [...row.keys.values()];
    const fields = [...LIGHT_COUNT_FIELDS].filter((f) => {
      const i = CACHE_KEY_TAIL.indexOf(f);
      return new Set(variants.map((v) => v[i])).size > 1;
    });
    churn.push({ name: row.name, copies: row.keys.size, fields, values: fields.map((f) => variants.map((v) => v[CACHE_KEY_TAIL.indexOf(f)]).join('/')) });
  }
  return churn;
}

async function main() {
  const port = SERVER_PORT ?? '8090';
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!h) { console.error(`[program-gate] no game server on :${port}`); process.exit(2); }
  console.log(`[program-gate] GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}  ${MAX_ISLANDS} islands x 2 vantage points x ${FRAMES_PER_STOP} frames`);
  if (!h.mapSeed) console.error('[program-gate] the map is UNPINNED — this gate counts programs against a fixed world; set PIRATES_BR_MAP_SEED');
  if (MUTATE) console.log('[program-gate] MUTATION ARMED: ProgramWarmer.prepare() is a no-op from first control — this run MUST fail');
  if (MUTATE_LIGHTS) console.log('[program-gate] MUTATION ARMED: one extra HemisphereLight joins the scene after first control — this run MUST fail on the light-count line');

  const client = await ensureDevClient(`${URL}/`);
  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  const shaderErrors = [];
  page.on('console', (m) => {
    const text = m.text();
    // GLSL only. A looser test ("error" plus "ERROR:") caught a TypeError from
    // the audio engine and failed a clean shader run on somebody else's bug.
    if (/THREE\.WebGLProgram|THREE\.WebGLShader|ERROR: 0:/.test(text)) shaderErrors.push(text.slice(0, 300));
  });

  let failures = 0;
  const failed = [];
  const fail = (msg) => { failures += 1; failed.push(msg); console.error(`  ✗ ${msg}`); };
  const pass = (msg) => console.log(`  ✓ ${msg}`);

  try {
    await page.addInitScript(PROGRAM_CENSUS_SOURCE);
    // Armed BEFORE the game exists, because a warmer disabled at first control
    // has already paid for the whole loaded world and the two builds are then
    // indistinguishable — which is exactly how the first version of this suite
    // came back green with the mutation in place.
    if (MUTATE) {
      await page.addInitScript(() => {
        // The census already owns this property (it installs its draw wrapper
        // the moment the game is published), so this CHAINS onto whatever is
        // there rather than replacing it — a mutation that quietly uninstalls
        // the instrument would prove even less than one that does nothing.
        const prev = Object.getOwnPropertyDescriptor(window, '__piratesBR');
        let game;
        Object.defineProperty(window, '__piratesBR', {
          configurable: true,
          get: () => (prev && prev.get ? prev.get() : game),
          set: (value) => {
            const warmer = value?.renderer?.programWarmer;
            if (warmer) {
              warmer.prepare = () => {};
              warmer.release = () => {};
              window.__mutatedWarmer = true;
            }
            if (prev && prev.set) prev.set(value); else game = value;
          },
        });
      });
    }
    await page.goto(`${URL}/?${sessionQuery(['debug', 'forceinput', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.evaluate(() => window.__programCensus.setPhase('load'));
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.evaluate(() => window.__programCensus.installDraw());
    // The load is allowed its links — that is what the load guard and the
    // ceremony boost are for, and test-load-responsiveness.mjs grades it. This
    // suite starts counting where the player starts playing.
    await page.waitForTimeout(10_000);
    await page.evaluate(() => {
      const r = window.__piratesBR?.renderer;
      if (!r) return;
      r.minPixelRatio = 0.1; r.maxPixelRatio = 0.1; r.applyPixelRatio(0.1);
    });
    await page.waitForTimeout(3000);

    await page.evaluate((src) => { (0, eval)(src); }, DRIVE);
    if (MUTATE) {
      const alive = await page.evaluate(() => window.__mutatedWarmer === true);
      if (!alive) throw new Error('the mutation never took — nothing was disabled, so this run proves nothing');
      console.log('  mutation confirmed: the warmer has been a no-op since the game was built');
    }
    await page.evaluate(() => window.__programCensus.markControl());
    if (MUTATE_LIGHTS) {
      const added = await page.evaluate(() => {
        const scene = window.__piratesBR?.renderer?.scene;
        if (!scene) return false;
        let source = null;
        scene.traverse((o) => { if (o.isHemisphereLight && !source) source = o; });
        if (!source) return false;
        // Cloned rather than constructed: the suite has no import of three, and
        // a clone is the same class the renderer is already lighting with.
        const extra = source.clone();
        extra.intensity = 0.85;
        extra.name = 'mutation-extra-hemi';
        scene.add(extra);
        return true;
      });
      if (!added) throw new Error('the light mutation never took — no hemisphere light to clone, so this run proves nothing');
      console.log('  mutation confirmed: a second HemisphereLight is in the scene from first control');
    }
    const stops = await page.evaluate(
      ([frames, islands]) => window.__tour.run(frames, islands),
      [FRAMES_PER_STOP, MAX_ISLANDS],
    );
    console.log(`  toured ${stops} vantage points, ${FRAMES_PER_STOP} frames each`);

    const deathError = await page.evaluate(() => window.__tourDeathError ?? null);
    const summary = await page.evaluate(() => window.__programCensus.summary());
    const warmerStats = await page.evaluate(() => {
      const s = window.__piratesBR?.renderer?.programWarmer?.stats;
      return s ? { ...s } : null;
    });

    const play = summary.play;
    const shadow = play.filter((e) => ALLOWED_SHADER_TYPES.has(shaderTypeOf(e.cacheKey)));
    const counted = play.filter((e) => !ALLOWED_SHADER_TYPES.has(shaderTypeOf(e.cacheKey)));
    const budget = BUDGET[QUALITY] ?? BUDGET.high;

    console.log(`\n  program keys this session: ${summary.totalKeys}   live programs: ${summary.livePrograms}`);
    console.log(`  joins: ${summary.counters.joins} total, ${summary.counters.joinsOutsideDraw} warmed, ${summary.counters.joinsInDraw} taken inside a draw`);
    console.log(`  during play: ${play.length} links inside a draw — ${counted.length} counted, ${shadow.length} allowlisted (shadow pass)`);
    console.log(`  ms of joins during play (advisory, software rasteriser): ${Math.round(play.reduce((s, e) => s + e.ms, 0))}ms, worst ${Math.round(Math.max(0, ...play.map((e) => e.ms)))}ms`);
    if (warmerStats) console.log(`  warmer: paid ${warmerStats.paid}, kicked ${warmerStats.kicked}, forced-through-unpaid ${warmerStats.forced}, worst slice ${warmerStats.worstMs}ms`);
    for (const e of counted.slice(0, 12)) {
      console.log(`    ${String(Math.round(e.ms)).padStart(6)}ms  t+${String(e.atMs).padStart(6)}ms  ${(e.material + ' ' + (e.materialName || '')).slice(0, 34).padEnd(35)} ${(e.object || '').slice(0, 24)}`);
    }

    if (counted.length > budget) fail(`${counted.length} programs linked inside a drawn frame during play (budget ${budget} at ${QUALITY})`);
    else pass(`${counted.length} programs linked during play, budget ${budget}`);

    // The census has to have SEEN something, or a silent instrument would pass
    // this suite by measuring nothing at all.
    if (summary.counters.joins < 20) fail(`census recorded only ${summary.counters.joins} joins in a whole session — the instrument did not attach`);
    else pass(`census attached (${summary.counters.joins} joins recorded across the session)`);

    // THE TRIPWIRE, and it is a COUNT rather than a share on purpose.
    //
    // Nothing but the warmer takes a join outside a draw, so a build whose warmer
    // has stopped running reads exactly zero here — measured, with the mutation
    // armed from construction: 0 of 58. This build reads 15 of 69. A share would
    // be the wrong shape: most of a session's joins are taken during the MENU and
    // the LOAD, where a draw legitimately gets there first and where
    // test-load-responsiveness.mjs is the suite that grades the cost, so the
    // denominator says more about how long the load was than about the warmer.
    // The floor is set at half of what this build measures.
    const warmed = summary.counters.joinsOutsideDraw;
    if (warmed < WARMED_JOIN_FLOOR) {
      fail(`only ${warmed} of ${summary.counters.joins} joins were paid outside a draw `
        + `(floor ${WARMED_JOIN_FLOOR}) — the warmer is not warming`);
    } else {
      pass(`${warmed} of ${summary.counters.joins} joins paid outside a draw (floor ${WARMED_JOIN_FLOOR})`);
    }

    if (process.env.PIRATES_BR_DUMP) {
      const out = process.env.PIRATES_BR_DUMP;
      const outOfDraw = summary.all.filter((e) => !e.why || e.why.startsWith('warmer'));
      require('node:fs').writeFileSync(out, JSON.stringify(outOfDraw.slice(0, 40), null, 2));
      console.log(`  dumped ${outOfDraw.length} out-of-draw joins to ${out}`);
    }
    // NO PROGRAM MAY BE LINKED TWICE BECAUSE A LIGHT MOVED. See lightCountChurn.
    // This is a hard zero, not a budget: a light count that changes after the
    // scene is built is a defect with no legitimate form, and the warmer cannot
    // defend against it — it re-links material the warmer has already paid for.
    const churn = lightCountChurn(summary.all);
    for (const c of churn.slice(0, 8)) {
      console.error(`    ${c.copies} copies of ${c.name || '(unnamed)'} — ${c.fields.join(',')} = ${c.values.join(' ')}`);
    }
    if (churn.length > 0) {
      fail(`${churn.length} program(s) were linked more than once because a light count changed `
        + `(${[...new Set(churn.flatMap((c) => c.fields))].join(', ')}) — every material the frame draws re-links`);
    } else {
      pass(`no program was re-linked by a light count change across ${summary.totalKeys} keys`);
    }

    if (deathError) fail(`the tour's death leg threw (${deathError}) — the spectate lighting path was never reached`);
    else pass('the tour died and came back, so the spectate lighting path was exercised');

    if (shaderErrors.length > 0) fail(`${shaderErrors.length} shader errors: ${shaderErrors[0]}`);
    else pass('no shader errors (the warmer links with checkShaderErrors on)');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    stopDevClient(client);
  }

  if (MUTATING) {
    // A mutation is only proof if it reddens the line it was written for. A run
    // that fails on some other assertion has shown the suite is noisy, not that
    // it can see the defect.
    const wanted = MUTATE_LIGHTS ? /light count/ : /linked inside a drawn frame|paid outside a draw/;
    const onTarget = failed.filter((m) => wanted.test(m));
    if (onTarget.length > 0) {
      console.log(`\n✓ MUTATION CAUGHT — ${onTarget.length} assertion(s) red on the intended line: ${onTarget[0]}`);
      process.exit(0);
    }
    console.error(`\n✗ MUTATION SURVIVED — ${failures} failure(s), none on the intended line. This gate proves nothing.`);
    for (const m of failed) console.error(`    (off-target) ${m}`);
    process.exit(1);
  }
  if (failures > 0) { console.error(`\n[program-gate] FAILED — ${failures} assertion(s)`); process.exit(1); }
  console.log('\n[program-gate] PASSED');
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
