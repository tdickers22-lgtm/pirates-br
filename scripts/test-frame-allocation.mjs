#!/usr/bin/env node
/**
 * STEADY-STATE ALLOCATION BUDGET — bytes a CPU frame is allowed to throw away.
 *
 * A garbage collection is a hitch the player feels exactly the way they feel a
 * shader stall: the frame stops. It is not a fixed tax either — the pause comes
 * when the nursery fills, so the allocation RATE is the dial that decides how
 * often play is interrupted and by how much. Measured before this gate existed,
 * a frame of this client allocated **287 KB**: at 60 fps that is 17 MB/s, a
 * scavenge every thirty frames, and the cost model's hitch census attributed 20
 * of 657 hitches and 4.7% of hitched time to collection with a worst pause of
 * 125 ms.
 *
 * WHY THIS MEASURES A SYNTHETIC FRAME AND NOT A rAF WINDOW. Two reasons, and
 * both of them cost a whole phase of measurement to learn:
 *
 *  1. A GC INSIDE THE WINDOW SWEEPS WHAT THE WINDOW ALLOCATED. Heap-before minus
 *     heap-after over 300 frames does not measure allocation, it measures
 *     allocation MINUS whatever was collected — the same build read 4.68, 5.22,
 *     6.74 and 8.68 KB/frame that way while its true figure was 287. So the heap
 *     is read either side of ONE frame at a time and the median of the positive
 *     samples is taken: a collection becomes a single negative sample instead of
 *     a silent refund.
 *  2. A SOFTWARE-RASTERISED FRAME IS 0.15-1.2 s LONG. Every 10 Hz snapshot and
 *     every timed subsystem then lands inside a fraction of the frames and is
 *     charged to them, which is why the cost model could only ever report a
 *     per-SECOND figure. `Game.benchFrameCpu(n, dt)` runs the real per-frame CPU
 *     path — everything `frame()` does except the draw — n times at a pinned
 *     1/60, so every amortised subsystem is charged exactly its share of a 60 fps
 *     frame. No GL is in it, so the number is the same on Metal and SwiftShader.
 *
 * WHAT IT DOES NOT COVER: the draw itself. three's own per-frame allocation
 * (render lists, uniform refreshes) is outside `benchFrameCpu` by construction.
 * This gate is about the game's own code.
 *
 *   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 node scripts/test-frame-allocation.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const ROOT_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const VIEWPORT = { width: 960, height: 540 };

/** Frames per sample, and how many samples. The verdict is the MEDIAN of the
 *  sample medians — one sample can catch a snapshot burst, three cannot. */
const FRAMES = 500;
const SAMPLES = 3;
/**
 * FRAMES OF WARM BEFORE THE FIRST SAMPLE, and this number is not padding.
 *
 * The island-detail warmer compiles a chunk of materials PER FRAME and takes
 * hundreds of frames to drain; the first-draw allowance and the build queues are
 * paced the same way. Warmed for 120 frames the first sample read 185 KB against
 * a settled 44 on the same build. That is the LOAD, it is real, and it is
 * measured elsewhere (test-load-responsiveness, test-first-draw-budget). A
 * steady-state budget that includes it is grading the join.
 */
const WARM_FRAMES = 2400;

/**
 * THE BUDGETS, in bytes per CPU frame, at the scene a player spends most of a
 * match in: sitting on their own ship with the world settled and the bots at
 * peace. Measured 2026-08-03 on the pinned map, SwiftShader, after the
 * allocation pass — median of three 500-frame samples, across two full runs:
 *
 *   low    31.9 and 44.8 KB/frame   (p90 52.4 and 65.3)
 *   high   67.6 and 62.0 KB/frame   (p90 135.4 and ~103)
 *
 * BEFORE THE PASS, `low` READ 287 KB/frame. The ceilings below are roughly
 * 1.6x the higher of the two runs, which is far wider than the draw-call table's
 * 1.12x, and the reason is named rather than hidden: THE FLEET DRIFTS. A pinned
 * map fixes the islands, not where ten hulls are lying an hour into a match, and
 * this figure scales with how many of them are inside the ship renderer's detail
 * radius and how many islands are holding detail. The same build read 31.9 and
 * 44.8 at `low` on two consecutive runs for that reason alone.
 *
 * A 1.6x ceiling still grades the thing it is for. Every single lever this pass
 * removed was worth more than the whole margin: `gerstnerHeight`'s four object
 * literals alone were 186 KB/frame, the LOD pass's tuple destructuring 30 KB at
 * `high`. Anything that puts a per-entity object, a template-literal key or a
 * for-of over a per-frame collection back into the loop clears these long before
 * the margin absorbs it.
 *
 * RAISING A NUMBER HERE IS A DECISION, NOT A FIX.
 */
const BUDGETS = {
  low: { medianBytes: 72_000, p90Bytes: 115_000 },
  high: { medianBytes: 108_000, p90Bytes: 200_000 },
};

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function startServer(port) {
  return spawn('npm', ['run', 'dev:server'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BROWSER: 'none', PORT: String(port), PIRATES_BR_MAP_SEED: MAP_SEED },
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
}

/**
 * IS THERE STILL A WORLD TO MEASURE.
 *
 * The first run of this gate passed `high` at 0.4 KB/frame — a seventieth of
 * what `low` read on the same build — and the number was real: the match had
 * ENDED while the page sat at one frame a second on the software rasteriser, so
 * `this.state` was gone, `updateScene` returned on its first line, and the
 * "steady-state CPU frame" being measured was an empty function. A budget that
 * cannot see the world has not passed, it has failed to run, and the two must
 * not share an exit code. Checked immediately before and after every sample.
 */
const WORLD_ALIVE = () => {
  const st = window.__piratesBR?.state;
  if (!st) return { ok: false, why: 'the client has no match state (the match ended or the socket dropped)' };
  if (st.phase !== 'playing') return { ok: false, why: `match phase is '${st.phase}', not 'playing'` };
  const ships = st.ships?.length ?? 0;
  const players = st.players?.length ?? 0;
  const islands = st.islands?.length ?? 0;
  if (ships === 0 || players === 0 || islands === 0) {
    return { ok: false, why: `empty world: ${players} players, ${ships} ships, ${islands} islands` };
  }
  return { ok: true, players, ships, islands, wildlife: st.wildlife?.length ?? 0 };
};

/** One sample: heap read either side of each of `frames` single CPU frames. */
const SAMPLE = async ({ frames, warm }) => {
  const g = window.__piratesBR;
  if (!g?.benchFrameCpu) return { error: 'benchFrameCpu missing — the client bundle is older than this gate' };
  if (!window.gc) return { error: 'window.gc unavailable — launch with --js-flags=--expose-gc' };
  if (!performance.memory) return { error: 'performance.memory unavailable — launch with --enable-precise-memory-info' };
  const mem = () => performance.memory.usedJSHeapSize;

  if (warm > 0) g.benchFrameCpu(warm, 1 / 60);
  window.gc(); window.gc();
  await new Promise((r) => setTimeout(r, 40));
  window.gc(); window.gc();

  // The instrument's own footprint: `performance.memory` hands back a fresh
  // MemoryInfo on every access. Measured here and subtracted, never assumed.
  const CAL = 20000;
  const c0 = mem();
  for (let i = 0; i < CAL; i++) mem();
  const overhead = Math.max(0, (mem() - c0) / CAL) * 2;

  const per = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const before = mem();
    g.benchFrameCpu(1, 1 / 60);
    per[i] = mem() - before - overhead;
  }
  const positive = Array.from(per).filter((v) => v >= 0).sort((a, b) => a - b);
  const pct = (p) => positive[Math.min(positive.length - 1, Math.floor(positive.length * p))] ?? 0;
  return {
    frames,
    collections: frames - positive.length,
    median: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: positive[positive.length - 1] ?? 0,
  };
};

async function measureTier(browser, quality) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${ROOT_URL}/?${sessionQuery(['debug', `quality=${quality}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    // Settled world: a frame that is still building an island allocates by the
    // megabyte and is not what a sailing frame costs.
    await page.evaluate(() => window.__piratesBR.settleLod(2));
    await page.waitForTimeout(4000);

    const before = await page.evaluate(WORLD_ALIVE);
    if (!before.ok) throw new Error(`[${quality}] nothing to measure before sampling — ${before.why}`);
    console.log(`  [${quality}] world: ${before.players} players, ${before.ships} ships, `
      + `${before.islands} islands, ${before.wildlife} animals`);

    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = await page.evaluate(SAMPLE, { frames: FRAMES, warm: i === 0 ? WARM_FRAMES : 0 });
      if (r.error) throw new Error(r.error);
      const alive = await page.evaluate(WORLD_ALIVE);
      if (!alive.ok) throw new Error(`[${quality}] the world went away during sample ${i + 1} — ${alive.why}`);
      samples.push(r);
      console.log(
        `  [${quality}] sample ${i + 1}: median ${(r.median / 1024).toFixed(1)} KB  p90 ${(r.p90 / 1024).toFixed(1)}  `
        + `p99 ${(r.p99 / 1024).toFixed(1)}  max ${(r.max / 1024).toFixed(1)} KB  (${r.collections} collections in ${r.frames} frames)`,
      );
    }
    const mid = (key) => {
      const v = samples.map((s) => s[key]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    expect(`No page errors at quality=${quality}`, errors.length === 0, errors.join('\n'));
    return { median: mid('median'), p90: mid('p90'), samples };
  } finally {
    await page.close().catch(() => {});
  }
}

/** A game server on `port`, started here if there isn't one, with its health
 *  payload. Returns `{ child }` only when this runner owns it. */
async function ensureServer(port) {
  let h = await health(port);
  if (h) return { child: null, health: h };
  const child = startServer(port);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !h) { await sleep(500); h = await health(port); }
  if (!h) { stopServer(child); throw new Error(`no game server came up on :${port}`); }
  return { child, health: h };
}

async function main() {
  console.log(`Frame allocation budget — GL: ${describeGl()}`);
  const port = SERVER_PORT ?? '8090';
  const probe = await ensureServer(port);
  console.log(`  map seed ${probe.health.mapSeed ?? 'UNPINNED'} — the world does not set this budget, but a dead match would`);
  // ONE MATCH PER TIER WHEN WE OWN THE SERVER. The match lives on the SERVER, so
  // the second tier used to join whatever was left of the first tier's game —
  // and on the software rasteriser a tier takes minutes, so `high` joined a
  // match that ended under it and reported 0.4 KB/frame for an empty
  // `updateScene`. Restarting between tiers is the only thing that makes the two
  // readings the same measurement.
  let ownServer = probe.child;
  const restartForNextTier = probe.child !== null;

  let browser;
  try {
    browser = await chromium.launch({
      args: browserArgs([
        '--mute-audio', '--js-flags=--expose-gc', '--enable-precise-memory-info',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      ]),
    });
  } catch (error) {
    stopServer(ownServer);
    console.log(`  – skipped: could not launch a browser (${error?.message ?? error})`);
    return;
  }

  const client = await ensureDevClient(`${ROOT_URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  try {
    // PIRATES_ALLOC_TIERS=low grades one tier. Every tier is a full join, a
    // settle and a server restart on a machine that must never run two heavy
    // things at once; when the question is "does this change move the number",
    // one tier answers it in half the time.
    const tiers = (process.env.PIRATES_ALLOC_TIERS ?? 'low,high').split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < tiers.length; i++) {
      const quality = tiers[i];
      if (i > 0 && restartForNextTier) {
        stopServer(ownServer);
        await sleep(1500);
        ownServer = (await ensureServer(port)).child;
        await sleep(1000);
      }
      const budget = BUDGETS[quality];
      const got = await measureTier(browser, quality);
      console.log(`  [${quality}] VERDICT median ${(got.median / 1024).toFixed(1)} KB/frame `
        + `→ ${((got.median * 60) / 1024 / 1024).toFixed(2)} MB/s at 60fps`);
      expect(
        `[${quality}] a settled CPU frame allocates under ${(budget.medianBytes / 1024).toFixed(0)} KB`,
        got.median <= budget.medianBytes,
        `measured ${(got.median / 1024).toFixed(1)} KB, ceiling ${(budget.medianBytes / 1024).toFixed(0)} KB`,
      );
      expect(
        `[${quality}] and its 90th-percentile frame under ${(budget.p90Bytes / 1024).toFixed(0)} KB`,
        got.p90 <= budget.p90Bytes,
        `measured ${(got.p90 / 1024).toFixed(1)} KB, ceiling ${(budget.p90Bytes / 1024).toFixed(0)} KB`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
    stopDevClient(client);
    stopServer(ownServer);
  }

  if (failures > 0) process.exit(1);
  console.log('\nFrame allocation budget passed.');
}

main().catch((error) => { console.error(error?.stack ?? error); process.exit(1); });
