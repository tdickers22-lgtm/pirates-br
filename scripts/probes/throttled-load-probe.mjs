// THE 4G LAUNCH GATE (b1.5d; vm:online:4, vm:performance:2, vm:performance:3).
//
// A phone on 4G opening the public URL for the first time is the launch's front
// door, and until this probe nothing measured it: every perf gate ran a warm
// Vite dev server on loopback at full CPU. This loads the REAL built client
// (dist/client, brotli siblings, served by the game server exactly as on Fly)
// into an emulated iPhone 14 (lib/perf-scenes.mjs DEVICE_PROFILES.phone) under
// the section-3 throttle profile, cold cache:
//
//     9 Mbit/s down, 9 Mbit/s up, 70 ms RTT, CPU 4x slower (CDP)
//
// and grades two things.
//
//   A  PLAY CLICKABLE <= 3.5 s from navigation start. "Clickable" means a tap
//      would DO something: the menu is showing (Game.init shows it only after
//      the socket connected; MenuController refuses Play while it is not), the
//      loading veil is gone, and #menu-play-btn is laid out, enabled and the
//      element under its own centre. Bytes and requests up to that moment are
//      printed for the bundle lane (b3.1f tightens this row).
//   B  MAIN THREAD AFTER THE HORN, same phone, same throttle, a solo match:
//      long tasks with > 50 ms OUTSIDE WebGLRenderer.render() over 20 s of
//      play <= 3 (graded; the raw long-task count is printed advisory, because
//      on SwiftShader the rasteriser runs inside render() on this thread and
//      makes every frame a long task). stepFrameCpu p95 via
//      Game.benchFrameCpu(1) x 90 <= 12 ms is printed ADVISORY: on SwiftShader
//      the CPU rasteriser shares the cores, so a millisecond here is not a
//      phone's millisecond. The long-task count is the graded form.
//
// Mutations (the gate's proof it can fail, rule 5):
//   --mutate=bloat   the document gains blocking <script>s naming the heaviest
//                    files in the build (>= 3 MB on the wire in total, ~2.7 s at
//                    9 Mbit/s on their own): row A must FAIL / move by >= 2.5 s.
//   --mutate=busy    a 70 ms busy loop every 8th frame after the horn:
//                    row B must FAIL.
//
// Rows (OD1): --rows A | B | A,B, default A,B. Batch gates b1-b3 grade
// `--rows A`; from b4 (lane b4.1's static-world worker) `--rows A,B`.
//
// Run from the repo root AFTER a build (never 3000/8090/8080; own 8091 server,
// ONE headless SwiftShader Chromium, both killed in finally; ~2-3 minutes):
//   npx vite build && node scripts/postbuild-compress.mjs && node scripts/probes/throttled-load-probe.mjs [--rows A]
// Writes test-results/throttled-load.json.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { DEVICE_PROFILES, newDeviceContext } from '../lib/perf-scenes.mjs';

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length);
// --rows A | B | A,B (default A,B) picks the graded rows (orchestrator decision
// OD1: row B's fix is the b4.1 static-world worker, so batch gates b1-b3 run
// `--rows A` and b4-b5 `--rows A,B`; neither row's ceiling moves). `--rows=X`
// works too; the older `--only=A|B` is the same switch. A mutation whose row is
// not selected is refused (it could not fail), so both proofs still fail their row.
function parseRows(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--rows') raw = argv[i + 1] ?? '';
    else if (a.startsWith('--rows=')) raw = a.slice('--rows='.length);
    else if (a.startsWith('--only=')) raw = a.slice('--only='.length);
  }
  if (raw == null) return ['A', 'B'];
  const rows = raw.toUpperCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (!rows.length || rows.some((r) => r !== 'A' && r !== 'B')) {
    console.error(`  ✗ FAIL: --rows takes A, B or A,B (got '${raw}')`);
    process.exit(2);
  }
  return [...new Set(rows)].sort();
}
const ROWS = parseRows(process.argv.slice(2));
const ONLY = ROWS.length === 1 ? ROWS[0] : '';
const MUTATION_ROW = { bloat: 'A', busy: 'B' };
if (MUTATE && !MUTATION_ROW[MUTATE]) { console.error(`  ✗ FAIL: unknown --mutate=${MUTATE} (bloat | busy)`); process.exit(2); }
if (MUTATE && !ROWS.includes(MUTATION_ROW[MUTATE])) {
  console.error(`  ✗ FAIL: --mutate=${MUTATE} proves row ${MUTATION_ROW[MUTATE]}, which --rows ${ROWS.join(',')} does not run (a mutation that cannot fail proves nothing)`);
  process.exit(2);
}
// --calibrate: same device, same build, NO network or CPU throttle. Not the
// gate: it proves both rows CAN pass on this rig (a gate that cannot pass is as
// broken as one that cannot fail), so a RED under the throttle is the product.
const CALIBRATE = process.argv.includes('--calibrate');
const THROTTLE = Object.freeze({ downMbit: 9, upMbit: 9, rttMs: 70, cpuRate: 4 });
const BUDGET = Object.freeze({ playClickableMs: 3500, longTasksAfterHorn: 3, longTaskMs: 50, stepFrameCpuP95Ms: 12 });
const PLAY_WINDOW_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

let distBuildId;
try { distBuildId = readFileSync('dist/build-id.txt', 'utf8').trim(); } catch {
  console.error('  ✗ FAIL: no dist/build-id.txt: build first (npx vite build && node scripts/postbuild-compress.mjs)');
  process.exit(1);
}

/** Recorded in the page from the first byte of script, on the page's own clock
 *  (performance.now is wall time; the CPU throttle slows the code, not the clock).
 *
 *  Why not "the socket opened": the game socket lives in a Web Worker
 *  (src/client/network/socket.worker.ts), so neither a page-side WebSocket
 *  wrapper nor the page's CDP Network domain ever sees it (the first two runs
 *  read null from both). The DOM carries the same fact: Game.init calls
 *  menu.show() only after connectToServer() resolved, so #menu-screen.visible
 *  with the loading veil gone IS "connected and in the menu". The button alone
 *  is not enough: it is static HTML, hit-testable at 269 ms before one line of
 *  the game has run. Loading-text phases are stamped too, so the report says
 *  where the time went (asset preload vs connect). */
const INIT = () => {
  const w = window;
  w.__load = { playReadyAt: null, menuVisibleAt: null, phases: [] };
  let lastText = '';
  // Socket-worker milestones (row A diagnosis): spawn, first message (the
  // socket is open), first 'msg' (welcome) as seen by the main thread.
  const W = w.Worker;
  if (W) {
    w.Worker = function (...a) {
      const wk = new W(...a);
      const mark = (k) => w.__load.phases.push([Math.round(performance.now()), `(worker ${k})`]);
      mark('spawned');
      let seen = 0;
      wk.addEventListener('message', (e) => { if (seen < 2) { seen += 1; mark(`message ${e.data?.k ?? '?'}`); } });
      return wk;
    };
    w.Worker.prototype = W.prototype;
  }
  // Long tasks >= 250 ms before Play is tappable (row A diagnosis): start + duration.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (w.__load.playReadyAt == null && e.duration >= 250) w.__load.phases.push([Math.round(e.startTime), `(long task ${Math.round(e.duration)} ms)`]);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no longtask API */ }
  const rafWrap = w.requestAnimationFrame;
  let rafMarks = 0;
  w.requestAnimationFrame = (cb) => rafWrap.call(w, (ts) => {
    const t0 = performance.now(); cb(ts); const d = performance.now() - t0;
    if (d >= 250 && rafMarks < 4 && w.__load.playReadyAt == null) { rafMarks += 1; w.__load.phases.push([Math.round(t0), `(rAF callback ${Math.round(d)} ms)`]); }
  });
  const poll = () => {
    if (w.__load.playReadyAt != null) return;
    const now = performance.now();
    const lt = document.getElementById('loading-text')?.textContent?.trim() ?? '';
    const phase = lt.replace(/\d+\/\d+/, 'n/N');
    if (phase && phase !== lastText) { lastText = phase; w.__load.phases.push([Math.round(now), lt.slice(0, 60)]); }
    const menu = document.getElementById('menu-screen');
    const veil = document.getElementById('loading-screen');
    const el = document.getElementById('menu-play-btn');
    const menuUp = !!menu && menu.classList.contains('visible') && getComputedStyle(menu).display !== 'none';
    const veilGone = !veil || veil.classList.contains('hidden') || getComputedStyle(veil).display === 'none';
    if (menuUp && w.__load.menuVisibleAt == null) w.__load.menuVisibleAt = now;
    if (menuUp && veilGone && el && !el.disabled) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && (hit === el || el.contains(hit))) w.__load.playReadyAt = now;
      }
    }
    if (w.__load.playReadyAt == null) setTimeout(poll, 20);
  };
  setTimeout(poll, 0);
};

async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  if (CALIBRATE) return cdp;
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE.rttMs,
    downloadThroughput: (THROTTLE.downMbit * 1e6) / 8,
    uploadThroughput: (THROTTLE.upMbit * 1e6) / 8,
    connectionType: 'cellular4g',
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuRate });
  return cdp;
}

/** The heaviest files in dist/client by bytes on the wire (their .br sibling
 *  when there is one, since the server content-negotiates), enough of them to
 *  total >= 3 MB (the largest single file is ~0.9 MB). */
function heaviestDistFiles() {
  const all = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (/\.(br|gz)$/.test(d.name)) continue;
      const br = `${full}.br`;
      all.push({ url: `/${relative('dist/client', full).split(sep).join('/')}`, wire: existsSync(br) ? statSync(br).size : statSync(full).size });
    }
  };
  walk('dist/client');
  all.sort((x, y) => y.wire - x.wire);
  const pick = [];
  let total = 0;
  for (const f of all) { if (total >= 3 * 1024 * 1024) break; pick.push(f); total += f.wire; }
  if (total < 3 * 1024 * 1024) throw new Error(`bloat mutation needs >= 3 MB in dist/client (all files ${total} B)`);
  return { files: pick, wire: total };
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), PIRATES_BR_STATS_PATH: `/tmp/pbr-4g-probe-stats-${process.pid}.json`, PIRATES_BR_MAP_SEED: '20260801' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const out = { gl: describeGl(), distBuildId, profile: DEVICE_PROFILES.phone.label, throttle: THROTTLE, budget: BUDGET, mutate: MUTATE || null, calibrate: CALIBRATE, rows: ROWS.join(','), only: ONLY || null };
let browser;
try {
  let served = null;
  for (let i = 0; i < 80 && served == null; i += 1) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok) served = (await h.json()).buildId ?? '?'; } catch { /* not yet */ }
    if (served == null) await sleep(500);
  }
  if (served == null) throw new Error(`server on ${PORT} never answered /health\n${serverOut.slice(-800)}`);
  expect(`server serves the fresh build (${served} == dist ${distBuildId})`, served === distBuildId);

  browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  console.log(`4G launch gate — GL ${out.gl}, ${out.profile}, ${THROTTLE.downMbit} Mbit/s, ${THROTTLE.rttMs} ms RTT, CPU ${THROTTLE.cpuRate}x, cold cache${MUTATE ? `  [MUTATED: ${MUTATE}]` : ''}${CALIBRATE ? '  [CALIBRATION: throttle OFF, not the gate]' : ''}  [rows ${ROWS.join(',')}]`);

  // ── A: cold load to a tappable Play ────────────────────────────────────
  if (ONLY !== 'B') {
  const ctxA = await newDeviceContext(browser, DEVICE_PROFILES.phone);
  try {
    const page = await ctxA.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.addInitScript(INIT);
    if (MUTATE === 'bloat') {
      // The bytes must cross the THROTTLED network (a route-fulfilled body
      // would skip it), so the mutation rewrites only the document: a blocking
      // classic <script> in <head> naming the heaviest real file in the build,
      // which the parser must download before the entry module may run.
      // A query string keeps the bytes EXTRA (the preload's own fetch of the
      // same file would otherwise be a cache hit, not a cost).
      const heavy = heaviestDistFiles();
      console.log(`  ! mutation: ${heavy.files.length} blocking fetches (${Math.round(heavy.wire / 1024)} KB on the wire) ahead of the entry`);
      const tags = heavy.files.map((f) => `<script src="${f.url}?bloat=1"></script>`).join('');
      await page.route((url) => url.pathname === '/', async (route) => {
        const res = await route.fetch();
        const html = (await res.text()).replace('<head>', `<head>${tags}`);
        const headers = { ...res.headers() };
        delete headers['content-encoding']; delete headers['content-length'];
        await route.fulfill({ status: res.status(), headers, body: html });
      });
    }
    const cdp = await throttle(page);
    const net = { requests: 0, bytes: 0 };
    cdp.on('Network.loadingFinished', (e) => { net.requests += 1; net.bytes += e.encodedDataLength ?? 0; });
    // Request timeline (diagnosis for row A variance): url, start, end, KB,
    // relative to the navigation's first request, printed for every fetch
    // that STARTED before Play was tappable.
    const reqs = new Map();
    let t0 = null;
    cdp.on('Network.requestWillBeSent', (e) => {
      if (t0 == null) t0 = e.timestamp;
      reqs.set(e.requestId, { url: e.request.url.replace(BASE, ''), start: e.timestamp, end: null, kb: 0 });
    });
    cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.kb = (e.encodedDataLength ?? 0) / 1024; } });
    cdp.on('Network.webSocketCreated', (e) => { if (t0 != null) reqs.set(e.requestId, { url: `WS ${e.url.replace(/^ws:\/\/[^/]+/, '')}`, start: null, end: null, kb: 0, wsCreated: true }); });
    cdp.on('Network.webSocketWillSendHandshakeRequest', (e) => { const r = reqs.get(e.requestId); if (r) r.start = e.timestamp; });
    cdp.on('Network.webSocketHandshakeResponseReceived', (e) => { const r = reqs.get(e.requestId); if (r) r.end = e.timestamp; });
    await page.goto(`${BASE}/?server=${PORT}`, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForFunction(() => window.__load?.playReadyAt != null, null, { timeout: 60_000, polling: 100 })
      .catch(() => null);
    const t = await page.evaluate(() => window.__load);
    const snap = { ...net };
    const clickable = t.playReadyAt;
    out.load = { playClickableMs: clickable && Math.round(clickable), menuVisibleMs: t.menuVisibleAt && Math.round(t.menuVisibleAt), requests: snap.requests, encodedKB: Math.round(snap.bytes / 1024), phases: t.phases };
    console.log(`  A  menu up (connected) at ${out.load.menuVisibleMs ?? 'never'} ms, Play tappable at ${out.load.playClickableMs ?? 'never'} ms; ${snap.requests} requests, ${out.load.encodedKB} KB on the wire by then (or by the 60 s timeout)`);
    for (const [ms, text] of t.phases) console.log(`       ${String(ms).padStart(6)} ms  ${text}`);
    if (t0 != null) {
      const rel = (x) => (x == null ? '     -' : String(Math.round((x - t0) * 1000)).padStart(6));
      const rows = [...reqs.values()].filter((r) => r.start != null && (clickable == null || (r.start - t0) * 1000 <= clickable))
        .sort((a, b) => a.start - b.start);
      out.load.timeline = rows.map((r) => ({ url: r.url, startMs: Math.round((r.start - t0) * 1000), endMs: r.end == null ? null : Math.round((r.end - t0) * 1000), kb: Math.round(r.kb) }));
      console.log(`     requests started before Play was tappable (${rows.length}; ms from the first request):`);
      for (const r of rows) console.log(`       ${rel(r.start)} -> ${rel(r.end)}  ${String(Math.round(r.kb)).padStart(5)} KB  ${r.url.slice(0, 90)}`);
    }
    expect(`Play clickable within ${BUDGET.playClickableMs} ms on the throttled 4G phone (${out.load.playClickableMs ?? 'never'} ms)`,
      clickable != null && clickable <= BUDGET.playClickableMs);
    expect('no page errors during the cold load', errors.length === 0, errors.join(' | '));
  } finally {
    await ctxA.close().catch(() => {});
  }
  }

  // ── B: main thread after the horn, same phone, same throttle ───────────
  if (ONLY !== 'A') {
  const ctxB = await newDeviceContext(browser, DEVICE_PROFILES.phone);
  try {
    const page = await ctxB.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('crash', () => { errors.push('RENDERER CRASHED'); console.error('  ! the phone page crashed (renderer process gone)'); });
    await throttle(page);
    await page.goto(`${BASE}/?server=${PORT}&debug`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => {
      const b = document.getElementById('menu-solo-btn');
      return b && !b.disabled && window.__piratesBR?.network?.isConnected?.() !== false;
    }, null, { timeout: 90_000 });
    await page.tap('#menu-solo-btn');
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000, polling: 500 });
    const tier = await page.evaluate(() => ({ q: window.__piratesBR.renderer.getQuality(), reason: window.__piratesBR.renderer.getQualityVerdict?.()?.reason }));
    expect(`phone session detected as low / 'mobile' (got ${tier.q} / ${tier.reason})`, tier.q === 'low' && tier.reason === 'mobile');
    await page.evaluate(() => window.__piratesBR.setBotPeace?.(true));
    // Let the horn-time island reveal land before the window opens: the gate is
    // about steady play, and the reveal has its own budget (first-draw).
    await page.waitForTimeout(8_000);
    const b = await page.evaluate(async ({ windowMs, longMs, busy }) => {
      // GL submission is timed separately: on SwiftShader the rasteriser and
      // the synchronous program links run inside WebGLRenderer.render() on
      // this thread, so on the first green attempt EVERY frame was a long task
      // (11 in 20 s, 123-1718 ms) while stepFrameCpu p95 was 7.7 ms. A long
      // task's time outside render() is what a phone's main thread pays for
      // game logic, DOM and the rest; that residual is the graded count, the
      // raw count is printed advisory.
      const gl = window.__piratesBR.renderer.renderer;
      const nativeRender = gl.render;
      const spans = [];
      let depth = 0;
      gl.render = function timedRender(...args) {
        const t0 = depth === 0 ? performance.now() : 0;
        depth += 1;
        try { return nativeRender.apply(this, args); } finally {
          depth -= 1;
          if (depth === 0) spans.push([t0, performance.now()]);
        }
      };
      const tasks = [];
      const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > longMs) tasks.push([e.startTime, e.duration]); });
      obs.observe({ type: 'longtask', buffered: false });
      let frames = 0;
      let stop = false;
      const tick = () => {
        frames += 1;
        if (busy && frames % 8 === 0) { const t0 = performance.now(); while (performance.now() - t0 < 70) { /* mutation */ } }
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, windowMs));
      stop = true;
      await new Promise((r) => setTimeout(r, 200)); // let the last entries land
      obs.disconnect();
      gl.render = nativeRender;
      const residual = tasks.map(([start, dur]) => {
        let inRender = 0;
        for (const [a, z] of spans) inRender += Math.max(0, Math.min(z, start + dur) - Math.max(a, start));
        return Math.round(dur - inRender);
      });
      return { raw: tasks.map(([, d]) => Math.round(d)), residual, frames, renders: spans.length };
    }, { windowMs: PLAY_WINDOW_MS, longMs: BUDGET.longTaskMs, busy: MUTATE === 'busy' });
    b.tasks = b.residual.filter((ms) => ms > BUDGET.longTaskMs);
    // stepFrameCpu, one frame at a time, at the phone pacer's 30 fps dt, in
    // short evaluates (the first run lost the page inside one long evaluate
    // that did the window and 90 bench frames together, with no way to tell
    // which half; a crash now names itself via the 'crash' listener).
    const cpu = [];
    for (let i = 0; i < 9; i += 1) {
      cpu.push(...await page.evaluate(() => { const g = window.__piratesBR; const r = []; for (let k = 0; k < 10; k += 1) r.push(g.benchFrameCpu(1, 1 / 30)); return r; }));
    }
    cpu.sort((x, y) => x - y);
    b.p50 = cpu[Math.floor(cpu.length * 0.5)];
    b.p95 = cpu[Math.floor(cpu.length * 0.95)];
    out.play = { longTasks: b.tasks.length, longTaskMs: b.tasks.slice(0, 20), rawLongTasks: b.raw.length, rawLongTaskMs: b.raw.slice(0, 20), renders: b.renders, rafFrames: b.frames, stepFrameCpuP50: +b.p50.toFixed(2), stepFrameCpuP95: +b.p95.toFixed(2) };
    console.log(`  B  ${b.frames} rAF frames, ${b.renders} render() calls in ${PLAY_WINDOW_MS / 1000} s; raw long tasks > ${BUDGET.longTaskMs} ms: ${b.raw.length} [${b.raw.slice(0, 12).join(', ')}] (ADVISORY on SwiftShader: GL runs on this thread)`);
    console.log(`     their time OUTSIDE render(): [${b.residual.slice(0, 12).join(', ')}] -> ${b.tasks.length} over ${BUDGET.longTaskMs} ms (graded)`);
    console.log(`     stepFrameCpu p50 ${b.p50.toFixed(2)} ms, p95 ${b.p95.toFixed(2)} ms at 4x CPU (ADVISORY on ${out.gl}; target <= ${BUDGET.stepFrameCpuP95Ms} ms on a phone)`);
    expect(`long tasks with > ${BUDGET.longTaskMs} ms outside render() after the horn <= ${BUDGET.longTasksAfterHorn} in ${PLAY_WINDOW_MS / 1000} s (${b.tasks.length})`,
      b.tasks.length <= BUDGET.longTasksAfterHorn);
    expect('the play window actually ran (>= 10 rAF frames, >= 10 timed renders)', b.frames >= 10 && b.renders >= 10, `${b.frames} frames, ${b.renders} renders`);
    expect('no page errors in the match', errors.length === 0, errors.join(' | '));
  } finally {
    await ctxB.close().catch(() => {});
  }
  }
} catch (e) {
  failures += 1;
  console.error(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
}

out.failures = failures;
mkdirSync('test-results', { recursive: true });
writeFileSync(`test-results/throttled-load${MUTATE ? `-${MUTATE}` : ''}${CALIBRATE ? '-calibrate' : ''}.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
