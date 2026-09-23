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
// Run from the repo root AFTER a build (never 3000/8090/8080; own 8091 server,
// ONE headless SwiftShader Chromium, both killed in finally; ~2-3 minutes):
//   npx vite build && node scripts/postbuild-compress.mjs && node scripts/probes/throttled-load-probe.mjs
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
// --only=A / --only=B runs one row (the mutation proofs each need only theirs).
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).toUpperCase();
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

const out = { gl: describeGl(), distBuildId, profile: DEVICE_PROFILES.phone.label, throttle: THROTTLE, budget: BUDGET, mutate: MUTATE || null, calibrate: CALIBRATE, only: ONLY || null };
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
  console.log(`4G launch gate — GL ${out.gl}, ${out.profile}, ${THROTTLE.downMbit} Mbit/s, ${THROTTLE.rttMs} ms RTT, CPU ${THROTTLE.cpuRate}x, cold cache${MUTATE ? `  [MUTATED: ${MUTATE}]` : ''}${CALIBRATE ? '  [CALIBRATION: throttle OFF, not the gate]' : ''}${ONLY ? `  [row ${ONLY} only]` : ''}`);

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
    await page.goto(`${BASE}/?server=${PORT}`, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForFunction(() => window.__load?.playReadyAt != null, null, { timeout: 60_000, polling: 100 })
      .catch(() => null);
    const t = await page.evaluate(() => window.__load);
    const snap = { ...net };
    const clickable = t.playReadyAt;
    out.load = { playClickableMs: clickable && Math.round(clickable), menuVisibleMs: t.menuVisibleAt && Math.round(t.menuVisibleAt), requests: snap.requests, encodedKB: Math.round(snap.bytes / 1024), phases: t.phases };
    console.log(`  A  menu up (connected) at ${out.load.menuVisibleMs ?? 'never'} ms, Play tappable at ${out.load.playClickableMs ?? 'never'} ms; ${snap.requests} requests, ${out.load.encodedKB} KB on the wire by then (or by the 60 s timeout)`);
    for (const [ms, text] of t.phases) console.log(`       ${String(ms).padStart(6)} ms  ${text}`);
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
