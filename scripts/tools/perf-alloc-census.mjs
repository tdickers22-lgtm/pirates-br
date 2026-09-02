#!/usr/bin/env node
// WHAT A FRAME ALLOCATES, AND WHICH LINE ALLOCATED IT.
//
// A garbage collection is a hitch the player feels exactly the way they feel a
// shader stall: the frame stops. The cost model measured the rate (207-233 KB of
// steady garbage per second at 'low', GC 1.2-8.3 ms/s with a worst pause of
// 125 ms) and could not say what was making it, for two reasons this rig fixes.
//
// 1. IT COULD NOT MEASURE PER FRAME. The old probe waited N rAF callbacks and
//    divided the heap delta by N. On the software rasteriser a frame is
//    0.15-1.2 s long, so every 10 Hz snapshot and every timed subsystem lands
//    inside a FRACTION of the frames and is charged to them: two captures of the
//    same build disagreed 5x per frame and only agreed per second, and per
//    second is not a number anyone can act on (frame-driven garbage scales with
//    frame rate, time-driven garbage does not). So this drives
//    `Game.benchFrameCpu(n, dt)` instead — the per-frame CPU work of the real
//    loop, minus the draw, run a pinned number of times at a pinned dt. No GL is
//    in it, so the answer is the same on Metal and on SwiftShader, and every
//    amortised subsystem is charged exactly its share of a 60 fps frame.
//
// 2. IT COULD NOT NAME A SITE. A CPU profile shows where TIME goes; garbage is
//    invisible in it. This takes a CDP sampling HEAP profile over the same bench
//    loop, so every kilobyte comes back with the function that allocated it.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-alloc-census.mjs --quality low --frames 600 --out /tmp/alloc-low.json
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from '../perf-probe.mjs';
import { ensureDevClient, stopDevClient } from '../lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const FRAMES = parseInt(arg('frames', '600'), 10);
const REPEATS = parseInt(arg('repeats', '3'), 10);
const OUT = arg('out', null);
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const VIEWPORT = { width: 960, height: 540 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function startServer(port) {
  const child = spawn('npm', ['run', 'dev:server'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BROWSER: 'none', PORT: String(port), PIRATES_BR_MAP_SEED: MAP_SEED },
  });
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
}

// ── in-page: the measurement itself ────────────────────────────────────────

/**
 * BYTES PER CPU FRAME, SAMPLED ONE FRAME AT A TIME.
 *
 * The obvious measurement — heap before a long window, heap after, divide — is
 * the one this rig started with and it does not work, because a garbage
 * collection inside the window collects part of what the window allocated and
 * the delta then under-reports it by however much was swept. That is not a small
 * effect: the same build read 4.68, 4.86, 5.73, 6.74, 7.21 and 8.68 KB/frame
 * that way, and the per-method ledger below (which never spans a collection)
 * showed the true figure was several times higher.
 *
 * So the heap is read either side of ONE frame at a time. A collection shows up
 * as a single negative sample instead of contaminating the whole window, the
 * MEDIAN of the positive samples is immune to it, and the distribution comes out
 * as a bonus — a frame that allocates 2 KB with a p99 of 300 KB is a different
 * animal from one that allocates 8 KB flat, and only the first is a hitch.
 *
 * The instrument's own cost (one `performance.memory` access allocates a
 * MemoryInfo object) is measured here and subtracted rather than waved away.
 */
export const MEASURE_ALLOC = async (frames) => {
  const g = window.__piratesBR;
  if (!g?.benchFrameCpu) return { error: 'benchFrameCpu missing — old client bundle?' };
  if (!window.gc) return { error: 'window.gc unavailable — launch with --js-flags=--expose-gc' };
  if (!performance.memory) return { error: 'performance.memory unavailable — launch with --enable-precise-memory-info' };
  const mem = () => performance.memory.usedJSHeapSize;

  // WARM, AND WARM PROPERLY. First-call lazy paths (a Map reaching its steady
  // size, a shader string built once) are not steady-state allocation — but
  // neither is the island-detail warmer, which compiles a chunk of materials a
  // FRAME and takes hundreds of frames to drain. Warmed for 120 the first
  // sample read 185 KB/frame against a settled 44; this is the load, measured,
  // and it does not belong in a steady-state figure.
  g.benchFrameCpu(Math.max(600, frames), 1 / 60);
  window.gc(); window.gc();
  await new Promise((r) => setTimeout(r, 40));
  window.gc(); window.gc();

  const CAL = 20000;
  const c0 = mem();
  for (let i = 0; i < CAL; i++) mem();
  const bytesPerRead = Math.max(0, (mem() - c0) / CAL);
  const overhead = bytesPerRead * 2;

  const per = new Float64Array(frames);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    const before = mem();
    g.benchFrameCpu(1, 1 / 60);
    per[i] = mem() - before - overhead;
  }
  const wallMs = performance.now() - t0;

  const positive = Array.from(per).filter((v) => v >= 0).sort((a, b) => a - b);
  const collections = frames - positive.length;
  const pct = (p) => positive[Math.min(positive.length - 1, Math.floor(positive.length * p))] ?? 0;
  return {
    frames,
    wallMs,
    bytesPerRead,
    collections,
    medianBytesPerFrame: pct(0.5),
    meanBytesPerFrame: positive.reduce((s, v) => s + v, 0) / Math.max(1, positive.length),
    p90BytesPerFrame: pct(0.9),
    p99BytesPerFrame: pct(0.99),
    maxBytesPerFrame: positive[positive.length - 1] ?? 0,
    cpuMsPerFrame: wallMs / frames,
  };
};

/** Drive the bench with a heap profiler running — the same loop, so the byte
 *  totals below and the KB/frame above describe the same work. */
export const RUN_BENCH = (frames) => window.__piratesBR.benchFrameCpu(frames, 1 / 60);

/**
 * EXACT BYTES PER METHOD PER FRAME — the instrument the sampling heap profiler
 * could not be.
 *
 * V8's sampling heap profiler was tried here first and it does not answer this
 * question: calibrated against 200,000 retained two-field objects (>6.1 MB) at
 * `samplingInterval: 256` it reported **0.03 MB**, a 200x under-read, because it
 * is built to find retention in old space and almost all of a frame's garbage
 * dies in the nursery. Its ranking is kept in this rig as a hint and its
 * magnitudes are not to be quoted.
 *
 * So this measures instead, and it measures the only quantity that is exact
 * here: `performance.memory.usedJSHeapSize`, sampled either side of ONE wrapped
 * method at a time, over a bench window short enough (and a semi-space large
 * enough, see --max-semi-space-size) that no scavenge lands inside it. Two
 * passes:
 *
 *   1. COUNT — wrap every method of every per-frame owner with a counter and run
 *      the bench once. Anything with zero calls is not in the frame and is never
 *      measured. The counting wrapper allocates (rest args), which is why it
 *      never reports bytes.
 *   2. BYTES — for each surviving method, one bench run with ONE fixed-arity
 *      wrapper installed, so the instrument's own footprint is two heap reads
 *      per call and is calibrated and subtracted rather than assumed away.
 *
 * The figure is INCLUSIVE (a method is charged what its callees allocate), which
 * is what makes the table readable top-down: `updateScene` is the sum of the
 * subsystems under it, and the interesting rows are the ones whose parent does
 * not explain them.
 */
export const ALLOC_LEDGER = async (frames) => {
  const g = window.__piratesBR;
  if (!performance.memory) return { error: 'performance.memory unavailable' };
  const mem = () => performance.memory.usedJSHeapSize;

  const owners = [
    ['game', g], ['renderer', g.renderer], ['ocean', g.ocean], ['ship', g.shipRenderer],
    ['spoils', g.spoilsRenderer], ['seaEvents', g.seaEvents], ['combatFx', g.combatFx],
    ['envFx', g.envFx], ['interactions', g.interactions], ['viewmodel', g.viewmodel],
    ['map', g.map], ['hud', g.hud], ['anim', g.anim], ['lodWarmer', g.lodWarmer],
    ['network', g.network], ['input', g.input],
  ].filter(([, o]) => o && typeof o === 'object');

  // ── pass 1: which methods does a frame actually call, and how often ──
  const counts = new Map();
  const undo = [];
  for (const [label, obj] of owners) {
    const proto = Object.getPrototypeOf(obj);
    if (!proto || proto === Object.prototype) continue;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name === 'benchFrameCpu') continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== 'function' || !d.writable) continue;
      const orig = d.value;
      const key = `${label}.${name}`;
      counts.set(key, 0);
      proto[name] = function (...a) { counts.set(key, counts.get(key) + 1); return orig.apply(this, a); };
      undo.push(() => { proto[name] = orig; });
    }
  }
  g.benchFrameCpu(frames, 1 / 60);
  for (const f of undo) f();
  const called = [...counts.entries()].filter(([, c]) => c > 0)
    .map(([key, c]) => ({ key, perFrame: c / frames }))
    .sort((a, b) => b.perFrame - a.perFrame);

  // ── the instrument's own cost, in bytes per heap read ──
  const CAL = 20000;
  const c0 = mem();
  for (let i = 0; i < CAL; i++) mem();
  const bytesPerRead = Math.max(0, (mem() - c0) / CAL);

  // ── pass 2: bytes, one wrapper at a time ──
  const rows = [];
  const ownerByLabel = new Map(owners);
  for (const { key, perFrame } of called) {
    const [label, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const obj = ownerByLabel.get(label);
    const proto = Object.getPrototypeOf(obj);
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    const deltas = [];
    // Fixed arity, not rest args: a `...a` wrapper allocates an array per call
    // and would charge every method its own instrument. Nine covers every
    // per-frame signature in this client; default parameters still resolve,
    // because they trigger on `undefined`.
    proto[name] = function (a, b, c, d, e, f, h, i, j) {
      const before = mem();
      const out = orig.call(this, a, b, c, d, e, f, h, i, j);
      deltas.push(mem() - before);
      return out;
    };
    window.gc?.(); window.gc?.();
    g.benchFrameCpu(frames, 1 / 60);
    proto[name] = orig;
    // MEDIAN OF THE POSITIVE DELTAS, not the sum. A collection landing inside a
    // call makes that one call's delta hugely negative; summing charges the
    // method a refund it did not earn and reported `updateScene` at 65 KB in a
    // frame that measures 270. Dropping the collections and taking the middle of
    // what is left is the same estimator the per-frame figure above uses, so the
    // two tables are commensurable.
    const pos = deltas.filter((v) => v >= 0).sort((x, y) => x - y);
    const perCall = Math.max(0, (pos[Math.floor(pos.length / 2)] ?? 0) - 2 * bytesPerRead);
    const callsPerFrame = deltas.length / frames;
    rows.push({ key, perFrame, bytesPerFrame: perCall * callsPerFrame, bytesPerCall: perCall, callsPerFrame });
  }
  rows.sort((a, b) => b.bytesPerFrame - a.bytesPerFrame);
  return { frames, bytesPerRead, rows };
};

// ── heap profile digest ────────────────────────────────────────────────────

/**
 * Walk the sampling profile's node tree, summing self bytes per call site and
 * keeping the stack that reached the heaviest ones.
 *
 * ONLY WHAT THE BENCH ALLOCATED. The profiler samples the whole renderer for as
 * long as it is armed, and a CDP round-trip either side of the bench call leaves
 * the page's real rAF loop running for a few hundred milliseconds — which on the
 * first cut of this rig put three's `cloneUniforms` and `unrollLoops` at the top
 * of a table that claims to be a census of the CPU FRAME. Those are shader links
 * from the live draw and they belong to lever 1, not here. So the walk only
 * counts nodes with `benchFrameCpu` above them, and reports what it discarded so
 * the discarding is on the record rather than silent.
 */
function digestHeap(head, { onlyUnder = 'benchFrameCpu' } = {}) {
  const rows = new Map();
  let outsideBytes = 0;
  const walk = (node, stack, inside) => {
    const cf = node.callFrame ?? {};
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const name = cf.functionName || '(anonymous)';
    const here = [...stack, `${name} ${url.split('/').pop()}:${(cf.lineNumber ?? -1) + 1}`];
    const within = inside || !onlyUnder || name === onlyUnder;
    if (node.selfSize > 0) {
      if (!within) outsideBytes += node.selfSize;
      else {
        const key = `${name}|${url}:${(cf.lineNumber ?? -1) + 1}`;
        const row = rows.get(key)
          ?? { functionName: name, url, line: (cf.lineNumber ?? -1) + 1, selfBytes: 0, stacks: [] };
        row.selfBytes += node.selfSize;
        if (row.stacks.length < 3) row.stacks.push(here.slice(-7).reverse().join(' ← '));
        rows.set(key, row);
      }
    }
    for (const c of node.children ?? []) walk(c, here, within);
  };
  walk(head, [], false);
  const out = [...rows.values()].sort((a, b) => b.selfBytes - a.selfBytes);
  const total = out.reduce((s, r) => s + r.selfBytes, 0);
  return { total, outsideBytes, rows: out };
}

async function main() {
  const port = SERVER_PORT ?? '8090';
  let ownServer = null;
  let h = await health(port);
  if (!h) {
    console.log(`  starting a game server on :${port} (map seed ${MAP_SEED})`);
    ownServer = startServer(port);
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && !h) { await sleep(500); h = await health(port); }
    if (!h) { stopServer(ownServer); console.error(`server never came up on :${port}`); process.exit(2); }
  }
  console.log(`Allocation census — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  console.log(`  ${FRAMES} CPU frames per sample, ${REPEATS} samples`);

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs([
      // A 64MB semi-space so a whole measurement window fits in the nursery
      // without a scavenge. A scavenge inside the window collects part of what
      // the window allocated, and the heap delta then UNDER-reports it — which
      // is how the first cut of this rig read 5.15, 5.22, 5.73, 6.11 and 8.81
      // KB/frame for the same build.
      '--mute-audio', '--js-flags=--expose-gc --max-semi-space-size=64', '--enable-precise-memory-info',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ]),
  });

  const report = { at: new Date().toISOString(), quality: QUALITY, gl: describeGl(), mapSeed: h.mapSeed, frames: FRAMES };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  try {
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    // Settle the world so the bench is measuring STEADY STATE and not the
    // island build queues draining — a build allocates by the megabyte and it
    // is not what a sailing frame costs.
    await page.evaluate(() => window.__piratesBR.settleLod(2));
    await page.waitForTimeout(4000);

    console.log('\n── bytes per CPU frame (nothing happening; bots at peace) ──');
    const samples = [];
    for (let i = 0; i < REPEATS; i++) {
      const r = await page.evaluate(MEASURE_ALLOC, FRAMES);
      if (r.error) { console.error(`  ${r.error}`); process.exit(2); }
      samples.push(r);
      console.log(
        `  sample ${i + 1}: median ${(r.medianBytesPerFrame / 1024).toFixed(2)} KB/frame  `
        + `mean ${(r.meanBytesPerFrame / 1024).toFixed(2)}  p90 ${(r.p90BytesPerFrame / 1024).toFixed(2)}  `
        + `p99 ${(r.p99BytesPerFrame / 1024).toFixed(1)}  max ${(r.maxBytesPerFrame / 1024).toFixed(1)} KB  `
        + `(${r.collections} collections, ${r.cpuMsPerFrame.toFixed(2)} ms/frame ADVISORY)`,
      );
    }
    const meds = samples.map((s) => s.medianBytesPerFrame).sort((a, b) => a - b);
    const median = meds[Math.floor(meds.length / 2)];
    console.log(`  MEDIAN OF MEDIANS ${(median / 1024).toFixed(2)} KB/frame  → ${(median * 60 / 1024).toFixed(0)} KB/s at 60fps`
      + `  (spread ${(meds[0] / 1024).toFixed(2)}-${(meds[meds.length - 1] / 1024).toFixed(2)})`);
    report.samples = samples;
    report.medianBytesPerFrame = median;

    // ── who allocated it ────────────────────────────────────────────────
    console.log('\n── allocation sites (sampling heap profile over the same loop) ──');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256 });
    await page.evaluate(RUN_BENCH, FRAMES);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    await cdp.send('HeapProfiler.disable');
    const dig = digestHeap(profile.head);
    console.log(`  sampled ${(dig.total / 1024 / 1024).toFixed(2)} MB inside the CPU frame over ${FRAMES} frames `
      + `(${(dig.total / FRAMES / 1024).toFixed(2)} KB/frame sampled; `
      + `${(dig.outsideBytes / 1024 / 1024).toFixed(2)} MB discarded as the live rAF loop)`);
    for (const r of dig.rows.slice(0, 28)) {
      console.log(
        `    ${(r.selfBytes / 1024).toFixed(0).padStart(8)} KB  ${((r.selfBytes / dig.total) * 100).toFixed(1).padStart(5)}%  `
        + `${r.functionName.slice(0, 34).padEnd(36)} ${r.url.slice(-44)}:${r.line}`,
      );
    }
    console.log('\n  stacks for the top 8:');
    for (const r of dig.rows.slice(0, 8)) {
      console.log(`    ${(r.selfBytes / 1024).toFixed(0)} KB  ${r.functionName}  ${r.url}:${r.line}`);
      for (const s of r.stacks.slice(0, 1)) console.log(`        ${s}`);
    }
    report.heap = { totalBytes: dig.total, rows: dig.rows.slice(0, 60) };

    // ── exact, per method ───────────────────────────────────────────────
    console.log('\n── bytes per frame per method (exact; inclusive of callees) ──');
    const ledger = await page.evaluate(ALLOC_LEDGER, Math.min(FRAMES, 400));
    if (ledger.error) console.log(`  ${ledger.error}`);
    else {
      console.log(`  instrument cost ${ledger.bytesPerRead.toFixed(1)} bytes per heap read (subtracted)`);
      for (const r of ledger.rows.filter((r) => r.bytesPerFrame > 24).slice(0, 40)) {
        console.log(
          `    ${r.bytesPerFrame.toFixed(0).padStart(8)} B/frame  ${r.callsPerFrame.toFixed(1).padStart(7)} calls/frame  ${r.key}`,
        );
      }
      report.ledger = ledger;
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    stopDevClient(client);
    stopServer(ownServer);
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
