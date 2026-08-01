// LONG-RUN VITALS PROBE — the freeze hunter.
//
// perf-probe.mjs answers "how expensive is one frame of this scene". It cannot
// answer the question a player actually asked ("the game freezes after a few
// minutes"), because it parks a free-cam in seven fixed scenes for six seconds
// each and never plays. A freeze that arrives at minute two is not a frame-cost
// problem at all — it is something that GROWS: shader programs recompiled during
// play (three.js compiles synchronously on the main thread, so one late program
// is a multi-hundred-millisecond hitch), geometries/textures never disposed, or
// JS heap climbing until a major GC stops the world.
//
// So this probe joins a match, PLAYS for a few minutes with the real input path
// (?forceinput opens the gate a pointer-locked patrol cannot), and every 5s
// samples the three counters that are trustworthy even on the software
// rasteriser this machine is restricted to:
//
//   • renderer.info.programs — with their CACHE KEYS. Frame cost under
//     SwiftShader is meaningless, but "a program that did not exist at t=60s
//     exists at t=180s" is a fact about the material graph, and the key names
//     the culprit. This is the smoking-gun channel.
//   • renderer.info.memory.{geometries,textures} — monotonic growth here is a
//     leak, and a leak on this machine ends as a stall.
//   • performance.memory.usedJSHeapSize + the worst rAF gap in the interval.
//
// Frame RATE is deliberately not graded (see lib/browser-args.mjs): software GL
// makes it advisory. Counts, keys and heap are not advisory.
//
// Usage:
//   PIRATES_GL=swiftshader node scripts/perf-vitals-probe.mjs --minutes 4
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// :8090 is the lobby server, and it serves the LAST BUILD out of dist/client —
// which on this branch was six days stale, so a probe pointed there profiled a
// bundle nobody was editing. Vite serves the working tree; default there, and
// keep --url for deliberately profiling a production build.
const URL = arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const MINUTES = parseFloat(arg('minutes', '4'));
const QUALITY = arg('quality', 'balanced');
const SAMPLE_MS = parseInt(arg('sample', '5000'), 10);
const OUT = arg('out', null);

// The machine safety rail: never larger than this, never a visible window.
const VIEWPORT = { width: 960, height: 540 };

/** rAF gap sampler + a per-interval reset, so each 5s row owns its worst stall. */
const INSTALL_SAMPLER = () => {
  const w = window;
  w.__vitals = { worst: 0, last: performance.now(), stalls: [], t0: performance.now(), frames: 0 };
  const step = () => {
    const now = performance.now();
    const dt = now - w.__vitals.last;
    w.__vitals.last = now;
    w.__vitals.frames++;
    if (dt > w.__vitals.worst) w.__vitals.worst = dt;
    // Anything over 250ms is a freeze a human notices, not a slow frame.
    if (dt > 250) w.__vitals.stalls.push({ at: Math.round(now - w.__vitals.t0), ms: Math.round(dt) });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** One sample: counters + program cache keys + heap. Resets the interval worst.
 *
 *  The heap read is taken AFTER an explicit gc(). Without it the number is
 *  retained garbage as much as live data, and "is the heap climbing" — the
 *  whole point of the channel — cannot be answered from it. --expose-gc is
 *  already on the command line; this is the call site it was added for. */
const SAMPLE = () => {
  const g = window.__piratesBR;
  const info = g?.renderer?.renderer?.info;
  const v = window.__vitals;
  const worst = v.worst; v.worst = 0;
  const frames = v.frames; v.frames = 0;
  if (typeof window.gc === 'function') { try { window.gc(); } catch { /* not exposed */ } }
  const mem = performance.memory;
  const progs = info?.programs ?? [];
  return {
    t: Math.round((performance.now() - v.t0) / 1000),
    programs: progs.length,
    // The key is what names the churning material. three.js builds it from the
    // material's own customProgramCacheKey plus its parameter fingerprint.
    keys: progs.map((p) => String(p.cacheKey ?? '')).sort(),
    geometries: info?.memory?.geometries ?? -1,
    textures: info?.memory?.textures ?? -1,
    calls: info?.render?.calls ?? -1,
    triangles: info?.render?.triangles ?? -1,
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1,
    worstGapMs: Math.round(worst),
    frames,
    phase: g?.state?.phase ?? '?',
    alive: (g?.state?.players ?? []).filter((p) => p.alive !== false).length,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`vitals probe — ${describeGl()}`);
  console.log(`url=${URL} minutes=${MINUTES} quality=${QUALITY} viewport=${VIEWPORT.width}x${VIEWPORT.height}`);

  const browser = await chromium.launch({
    headless: true,
    // --enable-precise-memory-info is not optional for this probe. Without it
    // Chrome quantizes performance.memory and caches the value for ~20 minutes,
    // so a four-minute run reports the SAME heap figure for every sample (a run
    // printed 124.9MB forty-six times) and the leak channel is dead while
    // looking healthy.
    args: browserArgs([
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ]),
  });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message.slice(0, 300)); console.error(`  [pageerror] ${e.message.slice(0, 200)}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

  try {
    await page.addInitScript(INSTALL_SAMPLER);
    await page.goto(`${URL}/?debug&forceinput&quality=${QUALITY}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    const joinStart = Date.now();
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', {}, { timeout: 180_000 });
    console.log(`  joined in ${((Date.now() - joinStart) / 1000).toFixed(1)}s`);

    // Let the streamed island build queue drain before the baseline sample, so
    // build-time program compiles are not mistaken for in-play churn.
    await sleep(8000);
    await page.evaluate(() => { window.__vitals.t0 = performance.now(); window.__vitals.stalls = []; window.__vitals.worst = 0; });

    const samples = [];
    const total = MINUTES * 60_000;
    const started = Date.now();
    let baselineKeys = null;
    let tick = 0;

    while (Date.now() - started < total) {
      // ── representative activity ──────────────────────────────────────────
      // Sail with the wind, work the helm, swing the trim, and fire — the paths
      // the regression report touched. Keys are held across the interval rather
      // than tapped, because a hitch that only shows while the hull is moving
      // through island LOD bands will not show at anchor.
      const phase = tick % 6;
      try {
        if (phase === 0) { await page.keyboard.down('KeyW'); }
        if (phase === 1) { await page.keyboard.down('KeyA'); await sleep(900); await page.keyboard.up('KeyA'); }
        if (phase === 2) { await page.keyboard.press('KeyF'); await page.keyboard.press('KeyF'); }
        if (phase === 3) { await page.keyboard.down('KeyD'); await sleep(900); await page.keyboard.up('KeyD'); }
        if (phase === 4) { await page.keyboard.press('KeyQ'); await page.keyboard.press('KeyL'); await page.keyboard.press('KeyL'); }
        if (phase === 5) { await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2); }
      } catch { /* input is best-effort; the sample is the measurement */ }

      await sleep(SAMPLE_MS);
      const s = await page.evaluate(SAMPLE);
      samples.push(s);
      baselineKeys ??= new Set(s.keys);
      const fresh = s.keys.filter((k) => !baselineKeys.has(k));
      console.log(
        `  t=${String(s.t).padStart(3)}s progs ${String(s.programs).padStart(3)}` +
        `${fresh.length ? ` (+${fresh.length} NEW)` : ''}` +
        `  geo ${String(s.geometries).padStart(5)} tex ${String(s.textures).padStart(4)}` +
        `  draws ${String(s.calls).padStart(5)}  heap ${String(s.heapMB).padStart(6)}MB` +
        `  worstGap ${String(s.worstGapMs).padStart(5)}ms  phase=${s.phase}`,
      );
      if (fresh.length) {
        // The WHOLE key, never a slice. Real three cache keys here run 238 to
        // 1342 characters and the part that distinguishes two materials is
        // routinely past character 220 — truncating printed several different
        // programs as the same line, which is how a churning material hides.
        for (const k of fresh) console.log(`      NEW PROGRAM: ${k}`);
        // Fold in so each key is reported once, at the moment it appeared.
        for (const k of fresh) baselineKeys.add(k);
      }
      tick++;
    }
    await page.keyboard.up('KeyW').catch(() => {});

    const stalls = await page.evaluate(() => window.__vitals.stalls);
    const first = samples[0], last = samples[samples.length - 1];
    const mid = samples[Math.floor(samples.length / 2)];

    console.log('\n── verdict ──');
    console.log(`  programs   ${first.programs} -> ${last.programs}  (${last.programs - first.programs >= 0 ? '+' : ''}${last.programs - first.programs})`);
    console.log(`  geometries ${first.geometries} -> ${last.geometries}  (${last.geometries - first.geometries >= 0 ? '+' : ''}${last.geometries - first.geometries})`);
    console.log(`  textures   ${first.textures} -> ${last.textures}`);
    console.log(`  heap       ${first.heapMB}MB -> ${mid.heapMB}MB -> ${last.heapMB}MB`);
    console.log(`  stalls>250ms: ${stalls.length}`);
    for (const s of stalls.slice(0, 40)) console.log(`      at ${(s.at / 1000).toFixed(1)}s  ${s.ms}ms`);
    if (errors.length) {
      console.log(`  page errors: ${errors.length}`);
      for (const e of [...new Set(errors)].slice(0, 15)) console.log(`      ${e}`);
    }

    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify({ url: URL, minutes: MINUTES, samples, stalls, errors }, null, 2));
      console.log(`  wrote ${OUT}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
