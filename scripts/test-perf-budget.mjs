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
  DEVICE_PROFILES, DEVICE_EXPECTED_VERDICT, newDeviceContext, deviceQuery, PIN_DEVICE_PIXEL_RATIO, READ_DEVICE_VERDICT,
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
// A targeted rerun never silently becomes a full pass: log the selected tiers
// and skip comparisons whose other tier was not measured. Default stays full.
// 'phone' and 'ipad' are DEVICE rows (b1.5d): the session is an emulated
// device with no tier pin, graded at what the detector gives it.
const ALL_TIERS = ['high', 'balanced', 'low', 'phone', 'ipad'];
const PERF_TIERS = (process.env.PIRATES_PERF_TIERS ?? ALL_TIERS.join(',')).split(',');
if (!PERF_TIERS.length || PERF_TIERS.some((tier) => !ALL_TIERS.includes(tier))) {
  throw new Error('PIRATES_PERF_TIERS must contain high, balanced, low, phone and/or ipad');
}
/** MUTATION KNOB for the device rows' proof (b1.5d): `--mutate` (or
 *  PIRATES_BR_MUTATE_DEVICE_TIER=balanced) opens the phone and iPad sessions
 *  with `?quality=balanced`, the tier a phone would get if the mobile verdict
 *  were lost. The verdict check and the draw/triangle rows must then FAIL. */
const MUTATE_DEVICE_TIER = process.env.PIRATES_BR_MUTATE_DEVICE_TIER
  ?? (process.argv.includes('--mutate') ? 'balanced' : '');

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

// Ceilings live in scripts/lib/budgets.mjs (b1.7a, PLAN rule 13); test-budget-ratchet
// fails any of them looser than at f5fee97e, on release or in the PLAN tables.
import { PERF_BUDGETS as BUDGETS, WRECK_BUDGET, LOW_TIER_MAX_RATIO, MID_TIER_MAX_RATIO, midRatioFor, SHADOW_PASS_MAX_SHARE, SHADOW_POLICY_MAX_KEEP } from './lib/budgets.mjs';
/** Seconds after the horn the dev server raises her for this measurement. */
const WRECK_RAISE_SEC = 12;
/** How long to wait for her after the join before giving up and skipping. */
const WRECK_WAIT_MS = 90_000;

let failures = 0;
/** MUTATION KNOB for this gate's own proof. PIRATES_BR_MUTATE_DROP_SCENE=dock-vista
 *  deletes that placement after planScenes, and the row-count assertion below
 *  must then FAIL. A gate that cannot fail is a bug; this shows it can. */
const MUTATE_DROP_SCENE = process.env.PIRATES_BR_MUTATE_DROP_SCENE ?? '';
/** MUTATION KNOB for the shadow rows (b3.1h): PIRATES_BR_MUTATE_SHADOW_LOD0=1
 *  (or --mutate-shadow) puts the shadow proxy in 'lod0' mode, so every caster
 *  renders its LOD0 (near) geometry into the depth map whatever it displays:
 *  LOD0 casting everywhere. The share row and the policy-saving row must FAIL. */
const MUTATE_SHADOW_LOD0 = process.env.PIRATES_BR_MUTATE_SHADOW_LOD0 === '1' || process.argv.includes('--mutate-shadow');

/**
 * SHADOW SPLIT — the sun's depth pass against the main pass, in triangles, plus
 * which casters the depth pass paid for.
 *
 * Driven the way PASS_SPLIT (lib/cost-model-probes) drives it: one
 * renderer.render(scene, camera) with the counter reset, the renderer's OWN
 * shadowMap.render wrapped for that one call (it is the Renderer's gated
 * wrapper, so the proxy swap inside it is what gets measured), and
 * renderBufferDirect wrapped inside the pass so every depth draw is charged to
 * the named builder root it came from. The gate is told to run this pass
 * (shadowSkipFrames = 0) so an empty-pass skip cannot read as a free shadow.
 */
const SHADOW_SPLIT = (mutate) => {
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const info = renderer.info;
  if (!renderer.shadowMap.enabled) return null;
  if (R.shadowProxy) R.shadowProxy.setMode(mutate ? 'lod0' : 'policy');
  const bucketFor = (node) => {
    for (let c = node; c; c = c.parent) {
      const n = c.name;
      if (!n) continue;
      if (n.startsWith('props-') || n.startsWith('island-') || n.startsWith('decor-') || n.startsWith('sea-rock')
        || n.startsWith('ship') || n.startsWith('hull') || n.startsWith('cave') || n.startsWith('landmark')
        || n.startsWith('dock') || n.startsWith('story')) return n;
      if (c.parent === R.scene) return n;
    }
    return node.name || '(unnamed)';
  };
  const wasAuto = info.autoReset;
  info.autoReset = false;
  const shadowMap = renderer.shadowMap;
  const origShadow = shadowMap.render;
  const origRbd = renderer.renderBufferDirect;
  const by = new Map();
  let shadow = { calls: 0, tris: 0 };
  let inShadow = false;
  renderer.renderBufferDirect = function wrappedRbd(camera, scene, geometry, material, object, group) {
    if (!inShadow) return origRbd.apply(this, arguments);
    const t0 = info.render.triangles;
    const out = origRbd.apply(this, arguments);
    const k = bucketFor(object);
    by.set(k, (by.get(k) ?? 0) + (info.render.triangles - t0));
    return out;
  };
  shadowMap.render = function wrapped(...args) {
    const c0 = info.render.calls, t0 = info.render.triangles;
    inShadow = true;
    try { return origShadow.apply(this, args); } finally {
      inShadow = false;
      shadow = { calls: info.render.calls - c0, tris: info.render.triangles - t0 };
    }
  };
  let total;
  // The same frame twice: as shipped (or mutated), then with the policy OFF
  // (every caster renders the LOD it displays: the pre-b3.1h cost). The
  // second number is what the policy is graded as saving.
  let offShadowTris = null;
  let topOn = null;
  try {
    R.shadowSkipFrames = 0;
    R.lastShadowPassAt = 0;
    info.reset();
    renderer.render(R.scene, R.camera);
    total = { calls: info.render.calls, tris: info.render.triangles };
    if (R.shadowProxy) {
      const keep = shadow;
      const mode = R.shadowProxy.getMode();
      R.shadowProxy.setMode('off');
      topOn = [...by.entries()];
      R.shadowSkipFrames = 0;
      R.lastShadowPassAt = 0;
      info.reset();
      renderer.render(R.scene, R.camera);
      offShadowTris = shadow.tris;
      shadow = keep;
      R.shadowProxy.setMode(mode);
    }
  } finally {
    shadowMap.render = origShadow;
    renderer.renderBufferDirect = origRbd;
    info.reset();
    info.autoReset = wasAuto;
  }
  const proxy = R.shadowProxy?.stats?.() ?? null;
  return {
    shadowTris: shadow.tris, shadowCalls: shadow.calls, offShadowTris,
    mainTris: total.tris - shadow.tris, mainCalls: total.calls - shadow.calls,
    top: (topOn ?? [...by.entries()]).sort((a, b) => b[1] - a[1]).slice(0, 10),
    proxy,
    proxyEnabled: R.shadowProxy ? R.shadowProxy.isEnabled() : null,
  };
};
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
  const profile = DEVICE_PROFILES[quality] ?? null;
  // A device row is its own context (UA, touch, dpr, screen): a page in the
  // default context would be a desktop with a small window.
  const context = profile
    ? await newDeviceContext(browser, profile)
    : await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const results = {};
  const query = profile
    // fps=uncapped: the phone pacer (30 fps) must not thin the capture window.
    ? sessionQuery(deviceQuery(['debug', 'fps=uncapped'], MUTATE_DEVICE_TIER))
    : sessionQuery(['debug', `quality=${quality}`]);
  if (profile) console.log(`  [${quality}] ${profile.label}${MUTATE_DEVICE_TIER ? `  [MUTATED: ?quality=${MUTATE_DEVICE_TIER}]` : ''}`);
  try {
    await page.goto(
      `${ROOT_URL.replace(/\/$/, '')}/?${query}`,
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
    if (profile) {
      // The row grades a PHONE only if the session is the tier a phone gets.
      const v = await page.evaluate(READ_DEVICE_VERDICT);
      expect(
        `[${quality}] ${profile.label} detected as ${DEVICE_EXPECTED_VERDICT.quality} (reason '${DEVICE_EXPECTED_VERDICT.reason}')`,
        v.quality === DEVICE_EXPECTED_VERDICT.quality && v.reason === DEVICE_EXPECTED_VERDICT.reason,
        `got ${v.quality} (reason ${v.reason})`,
      );
    }

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
      // A device row pins the profile's OWN open ratio instead (see perf-scenes).
      const fill = profile ? await page.evaluate(PIN_DEVICE_PIXEL_RATIO) : await page.evaluate(PIN_PIXEL_RATIO);
      // settle: true — see the header. A count taken mid-reveal is a lie.
      const r = await measureScene(page, plan[budget.scene], { warmupMs: 2500, captureMs: 3000, settle: true });
      const sources = await page.evaluate(TALLY_DRAW_SOURCES).catch(() => []);
      results[budget.scene] = { draws: Math.round(r.draws), tris: Math.round(r.tris), peakDraws: r.peakDraws, programs: r.programs, sources };
      report(quality, budget, results[budget.scene], r);
      const shadowShare = SHADOW_PASS_MAX_SHARE[quality];
      if (shadowShare !== undefined) {
        const sp = await page.evaluate(SHADOW_SPLIT, MUTATE_SHADOW_LOD0);
        if (!sp) {
          expect(`[${quality}] ${budget.label}: shadow map enabled`, false, 'shadowMap.enabled is false on a tier with a shadow-share row');
        } else {
          const share = sp.mainTris > 0 ? sp.shadowTris / sp.mainTris : Infinity;
          console.log(`      shadow pass ${Math.round(sp.shadowTris / 1000)}k tris / ${sp.shadowCalls} draws vs main ${Math.round(sp.mainTris / 1000)}k / ${sp.mainCalls} = ${(share * 100).toFixed(1)}%`
            + `  proxy ${sp.proxyEnabled === null ? 'ABSENT' : sp.proxyEnabled ? 'on' : 'OFF (mutated)'}${sp.proxy ? ` ${JSON.stringify(sp.proxy)}` : ''}`);
          console.log(`      shadow by caster: ${sp.top.map(([k, v]) => `${k}=${Math.round(v / 1000)}k`).join('  ')}`);
          results[budget.scene].shadow = sp;
          expect(
            `[${quality}] ${budget.label}: shadow pass <= ${Math.round(shadowShare * 100)}% of main-pass triangles`,
            share <= shadowShare,
            `shadow ${Math.round(sp.shadowTris / 1000)}k vs main ${Math.round(sp.mainTris / 1000)}k (${(share * 100).toFixed(1)}%)`,
          );
        }
      }
      if (profile) {
        console.log(`      framebuffer ${fill?.width}x${fill?.height} = ${fill?.mpx?.toFixed(3)} Mpx at ratio ${fill?.ratio?.toFixed(4)}`);
        expect(
          `[${quality}] ${budget.label} links no more than ${budget.programs} programs`,
          r.programs <= budget.programs,
          `measured ${r.programs}, ceiling ${budget.programs}`,
        );
      }
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

    // THE POLICY MUST BUY SOMETHING. Summed over the graded scenes, the depth
    // pass as shipped against the same frames with the policy off (every
    // caster at its displayed LOD). A proxy that silently stopped swapping
    // passes the share row on a light scene; it cannot pass this.
    const keep = SHADOW_POLICY_MAX_KEEP[quality];
    if (keep !== undefined) {
      const rows = Object.values(results).filter((x) => x.shadow && x.shadow.offShadowTris !== null);
      const on = rows.reduce((a, x) => a + x.shadow.shadowTris, 0);
      const off = rows.reduce((a, x) => a + x.shadow.offShadowTris, 0);
      expect(
        `[${quality}] shadow proxy policy keeps <= ${Math.round(keep * 100)}% of the display-LOD depth pass (${rows.length} scenes)`,
        rows.length > 0 && off > 0 && on <= off * keep,
        `policy ${Math.round(on / 1000)}k vs display-LOD ${Math.round(off / 1000)}k tris (${off > 0 ? Math.round((on / off) * 100) : 'n/a'}%)`,
      );
    }

    expect(`No page errors at quality=${quality}`, errors.length === 0, errors.join('\n'));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
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
    const byTris = [...got.sources].sort((a, b) => (b.tris ?? 0) - (a.tris ?? 0)).slice(0, 8);
    console.log(`      by tris:   ${byTris.map((s) => `${s.source}=${Math.round((s.tris ?? 0) / 1000)}k`).join('  ')}`);
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

    console.log(`  Grading tiers: ${PERF_TIERS.join(', ')}${PERF_TIERS.length < 3 ? ' (targeted run; cross-tier comparisons only where measured)' : ''}`);
    const high = PERF_TIERS.includes('high') ? await measureTier(browser, 'high', { wantWreck }) : {};
    const balanced = PERF_TIERS.includes('balanced') ? await measureTier(browser, 'balanced', { wantWreck: false }) : {};
    const low = PERF_TIERS.includes('low') ? await measureTier(browser, 'low', { wantWreck: false }) : {};
    if (PERF_TIERS.includes('phone')) await measureTier(browser, 'phone', { wantWreck: false });
    if (PERF_TIERS.includes('ipad')) await measureTier(browser, 'ipad', { wantWreck: false });

    for (const budget of BUDGETS.balanced) {
      const a = high[budget.scene];
      const b = balanced[budget.scene];
      if (!a || !b) continue;
      const ratio = midRatioFor(budget.scene);
      expect(
        `balanced tier draws no more than ${Math.round(ratio.draws * 100)}% of high at ${budget.scene}`,
        b.draws <= a.draws * ratio.draws,
        `balanced ${b.draws} vs high ${a.draws} (${Math.round((b.draws / a.draws) * 100)}%)`,
      );
      expect(
        `balanced tier draws no more than ${Math.round(ratio.tris * 100)}% of high's triangles at ${budget.scene}`,
        b.tris <= a.tris * ratio.tris,
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
