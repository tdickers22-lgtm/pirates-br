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
// It opens with the STORY phase (b1.1g, see storyPhase below):
//   node scripts/test-lod-reveal.mjs --story-only       the story cases alone
//   node scripts/test-lod-reveal.mjs --mutate-eager     eager ensure: MUST fail
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
// ── STORY SCENES LAZY FOR REAL (b1.1g, performance-09) ───────────────────
// The fifteen 25-48k story tableaux used to be ensured at build time, so all
// of them were fetched within 20 s of the horn wherever you were. Now a 2-4k
// `<name>_far.glb` proxy rides the world set and LOD0 is fetched only when the
// island EDGE comes inside 600 m (400 m on a phone); a phone disposes LOD0
// beyond 1.5 km and fetches it again on the next approach. Graded here:
//   1. 20 s parked where no island edge is inside 600 m: <= 3 story GLBs fetched;
//   2. crossing 600 m swaps proxy -> LOD0 within 2 s, and no poll ever sees
//      neither of them drawn (no pop gap);
//   3. ?profile=mobile: LOD0 goes beyond 1.5 km (proxy back) and is fetched
//      again on approach.
// `--story-only` runs just this phase; `--mutate-eager` rewrites the served
// PropScatterer so every story slot ensures at any distance (the old bug) and
// case 1 MUST fail. Requests are counted off the wire with routing on, which
// disables the HTTP cache, so a re-fetch after eviction is a real request.
const STORY_NAMES = ['smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton', 'rum_still', 'crow_roost',
  'mermaid_shrine', 'castaway_camp', 'kraken_wreck', 'dig_site', 'gallows', 'parley_table', 'mine_head',
  'widow_memorial', 'gibbet_cage'];
const CLI = new Set(process.argv.slice(2));
const STORY_ONLY = CLI.has('--story-only');
const MUTATE_EAGER = CLI.has('--mutate-eager');
const STORY_SWAP_LIMIT_MS = 2000;

async function bootStoryPage(query) {
  const p = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  const fetched = [];
  let mutated = false;
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (req) => {
    const m = req.url().match(/\/assets\/models\/([a-z0-9_]+)\.glb/);
    if (m && STORY_NAMES.includes(m[1])) fetched.push({ name: m[1], t: Date.now() });
  });
  await p.route(/\/assets\/models\/[a-z0-9_]+\.glb/, (route) => route.continue());
  if (MUTATE_EAGER) {
    await p.route(/\/src\/client\/world\/island\/PropScatterer\.ts/, async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      const next = body.replace(/if \(edgeMetres < fetchM\) \{/, 'if (edgeMetres < Infinity) {');
      mutated = next !== body;
      await route.fulfill({ response: res, body: next });
    });
  }
  await p.goto(`${URL}/?debug&forceinput&quality=balanced${query}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await p.click('#menu-solo-btn', { noWaitAfter: true });
  await p.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
  // Park at the open-water point farthest from every island edge, first thing.
  const park = await p.evaluate(() => {
    const g = window.__piratesBR;
    const isl = (g.state.islands ?? []).map((i) => ({ x: i.position.x, z: i.position.z, r: i.radius }));
    const edge = (x, z) => Math.min(...isl.map((i) => Math.hypot(x - i.x, z - i.z) - i.r));
    const me = g.state.players?.find?.((pl) => pl.id === g.state.localPlayerId) ?? null;
    const cam = g.renderer?.camera?.position;
    const spawnEdge = cam ? edge(cam.x, cam.z) : (me ? edge(me.position.x, me.position.z) : NaN);
    const xs = isl.map((i) => i.x); const zs = isl.map((i) => i.z);
    let best = { x: 0, z: 0, e: -Infinity };
    for (let x = Math.min(...xs) - 1500; x <= Math.max(...xs) + 1500; x += 100) {
      for (let z = Math.min(...zs) - 1500; z <= Math.max(...zs) + 1500; z += 100) {
        const e = edge(x, z);
        if (e > best.e && e < 2500) best = { x, z, e };
      }
    }
    g.enableFreeCam(best.x, 40, best.z, 0, -0.05);
    return { spawnEdge, ...best };
  });
  return { p, errors, fetched, park, mutated: () => mutated };
}

/** Story slots in the scene: the proxy (InstancedMesh, 'prop-<name>' or
 *  'story-proxy-prop-<name>' once LOD0 stands) with its world position. */
const LIST_STORY_SLOTS = (names) => {
  const out = [];
  const v = new window.__piratesBR.renderer.camera.position.constructor();
  window.__piratesBR.renderer.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const m = o.name.match(/^(?:story-proxy-)?prop-([a-z0-9_]+)$/);
    if (!m || !names.includes(m[1])) return;
    o.getWorldPosition(v);
    out.push({ name: m[1], x: v.x, z: v.z, uuid: o.uuid });
  });
  return out;
};
/** Is the slot's LOD0 standing, and is anything drawn there? */
const SLOT_STATE = (uuid) => {
  let proxy = null;
  window.__piratesBR.renderer.scene.traverse((o) => { if (o.uuid === uuid) proxy = o; });
  if (!proxy) return { gone: true };
  const name = proxy.name.replace(/^story-proxy-/, '');
  const real = proxy.parent?.children.find((c) => c !== proxy && c.name === name && !c.isInstancedMesh) ?? null;
  return { real: !!real, proxyVisible: proxy.visible };
};

async function approachSlot(p, slot, edge) {
  return p.evaluate(([s, e]) => {
    const g = window.__piratesBR;
    const isl = (g.state.islands ?? []).map((i) => ({ x: i.position.x, z: i.position.z, r: i.radius }));
    const home = isl.reduce((a, b) => (Math.hypot(b.x - s.x, b.z - s.z) < Math.hypot(a.x - s.x, a.z - s.z) ? b : a));
    // Come in along the line from the island centre through the slot.
    const dx = s.x - home.x; const dz = s.z - home.z; const len = Math.hypot(dx, dz) || 1;
    const d = home.r + e;
    g.enableFreeCam(home.x + (dx / len) * d, 40, home.z + (dz / len) * d, 0, -0.05);
    // Every OTHER island must be farther than this one, or the crossing is not ours.
    const cx = home.x + (dx / len) * d; const cz = home.z + (dz / len) * d;
    return Math.min(...isl.filter((i) => i !== home).map((i) => Math.hypot(cx - i.x, cz - i.z) - i.r));
  }, [slot, edge]);
}

async function waitSlot(p, uuid, want, limitMs) {
  const t0 = Date.now();
  let gap = false;
  while (Date.now() - t0 < limitMs) {
    const st = await p.evaluate(SLOT_STATE, uuid);
    if (!st.gone && !st.real && !st.proxyVisible) gap = true;
    if (!st.gone && st.real === want) return { ms: Date.now() - t0, gap };
    await sleep(100);
  }
  return { ms: Infinity, gap };
}

async function storyPhase() {
  console.log(`\n  ── story scenes lazy (desktop)${MUTATE_EAGER ? ' — MUTATION: eager ensure' : ''} ──`);
  const d = await bootStoryPage('');
  try {
    if (MUTATE_EAGER) expect('mutation applied to the served PropScatterer', d.mutated(), 'anchor not found', false);
    const parkedAt = Date.now();
    await sleep(20_000);
    const slots = await d.p.evaluate(LIST_STORY_SLOTS, STORY_NAMES);
    const since = d.park.spawnEdge >= 600 ? 0 : parkedAt;
    const names = [...new Set(d.fetched.filter((f) => f.t >= since).map((f) => f.name))];
    console.log(`    spawn edge ${Math.round(d.park.spawnEdge)} m, parked ${Math.round(d.park.e)} m from every island edge; ${slots.length} story slot(s) in the match`);
    console.log(`    story GLBs fetched ${since ? 'since parking' : 'since load'}: ${names.length} [${names.join(', ')}]`);
    expect('a spawn with no island inside 600 m fetches <= 3 story GLBs in 20 s', d.park.e >= 600 && names.length <= 3,
      `${names.length} fetched: ${names.join(', ')} (parked ${Math.round(d.park.e)} m out)`);
    if (MUTATE_EAGER) return;
    const slot = slots.find((s) => !d.fetched.some((f) => f.name === s.name)) ?? slots[0];
    expect('the match stands at least one story slot to approach', !!slot, `${slots.length} slots`);
    if (!slot) return;
    const other = await approachSlot(d.p, slot, 800);
    await sleep(3000);
    const outside = await d.p.evaluate(SLOT_STATE, slot.uuid);
    expect(`${slot.name}: the proxy stands alone at 800 m from the edge`, outside.proxyVisible && !outside.real,
      JSON.stringify(outside));
    await approachSlot(d.p, slot, 540);
    const swap = await waitSlot(d.p, slot.uuid, true, 15_000);
    console.log(`    ${slot.name}: proxy -> LOD0 ${swap.ms} ms after crossing 600 m (nearest other island edge ${Math.round(other)} m)`);
    expect(`${slot.name}: proxy -> LOD0 within ${STORY_SWAP_LIMIT_MS} ms of crossing 600 m`, swap.ms <= STORY_SWAP_LIMIT_MS, `${swap.ms} ms`);
    expect(`${slot.name}: no poll saw neither proxy nor LOD0 drawn (no pop gap)`, !swap.gap);
    expect('no page errors (story, desktop)', d.errors.length === 0, d.errors.slice(0, 3).join('\n     '), false);
  } finally {
    await d.p.close();
  }

  console.log('\n  ── story scenes lazy (?profile=mobile) ──');
  const m = await bootStoryPage('&profile=mobile');
  try {
    await sleep(3000);
    const slots = await m.p.evaluate(LIST_STORY_SLOTS, STORY_NAMES);
    const slot = slots[0];
    expect('the phone match stands a story slot', !!slot);
    if (!slot) return;
    const count = () => m.fetched.filter((f) => f.name === slot.name).length;
    await approachSlot(m.p, slot, 350);
    const in1 = await waitSlot(m.p, slot.uuid, true, 20_000);
    const n1 = count();
    await approachSlot(m.p, slot, 1650);
    const out = await waitSlot(m.p, slot.uuid, false, 10_000);
    const back = await m.p.evaluate(SLOT_STATE, slot.uuid);
    await sleep(1500);
    await approachSlot(m.p, slot, 350);
    const in2 = await waitSlot(m.p, slot.uuid, true, 20_000);
    const n2 = count();
    console.log(`    ${slot.name}: LOD0 at 350 m after ${in1.ms} ms (${n1} fetch), gone at 1650 m after ${out.ms} ms, back after ${in2.ms} ms (${n2} fetches)`);
    expect(`phone: ${slot.name} LOD0 stands inside 400 m`, in1.ms < Infinity);
    expect(`phone: ${slot.name} LOD0 evicted beyond 1.5 km, proxy drawn again`, out.ms < Infinity && back.proxyVisible, JSON.stringify(back));
    expect(`phone: ${slot.name} LOD0 fetched again on the next approach`, in2.ms < Infinity && n2 > n1, `fetches ${n1} -> ${n2}`);
    expect('no pop gap on the phone', !in1.gap && !out.gap && !in2.gap);
    expect('no page errors (story, phone)', m.errors.length === 0, m.errors.slice(0, 3).join('\n     '), false);
  } finally {
    await m.p.close();
  }
}

try {
  await storyPhase();
} catch (err) {
  expect('story phase ran', false, String(err?.stack ?? err));
}
if (STORY_ONLY || MUTATE_EAGER) {
  await browser.close();
  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log(`\nStory-lazy checks passed (${substantive} graded).`);
  process.exit(0);
}

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
  // A WAIT, not a grade: islands build one per frame and reveal over several
  // more, and on the software rasteriser a balanced frame is 5-10 s, so 14
  // islands plus their reveals did not fit in 120 s (26e17d6b included). The
  // elapsed time is printed so a slower build still shows up in the log.
  const backlogWaitStart = Date.now();
  await page.waitForFunction(() => window.__piratesBR?.getWorldBuildBacklog?.() === 0, undefined, { timeout: 420_000 });
  console.log(`  world backlog drained after ${((Date.now() - backlogWaitStart) / 1000).toFixed(1)}s (advisory on a software rasteriser)`);
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
