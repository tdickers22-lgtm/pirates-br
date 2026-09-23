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
//      would DO something: #menu-play-btn is laid out, enabled, is the element
//      under its own centre (no card or loading veil over it), AND the game
//      socket is open (MenuController refuses Play while it is not). The later
//      of the two is the reading. Bytes and requests up to that moment are
//      printed for the bundle lane (b3.1f tightens this row).
//   B  MAIN THREAD AFTER THE HORN, same phone, same throttle, a solo match:
//      long tasks > 50 ms over 20 s of play <= 3 (graded). stepFrameCpu p95 via
//      Game.benchFrameCpu(1) x 90 <= 12 ms is printed ADVISORY: on SwiftShader
//      the CPU rasteriser shares the cores, so a millisecond here is not a
//      phone's millisecond. The long-task count is the graded form.
//
// Mutations (the gate's proof it can fail, rule 5):
//   --mutate=bloat   the document gains a blocking <script> naming the heaviest
//                    file in the build (>= 3 MB on the wire, ~2.7 s at 9 Mbit/s
//                    on its own): row A must FAIL.
//   --mutate=busy    a 70 ms busy loop every 12th frame after the horn:
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

/** Recorded in the page from the first byte of script: when Play became tappable
 *  and when the game socket opened, both on the page's own clock (performance.now
 *  is wall time; the CPU throttle slows the code, not the clock). */
const INIT = () => {
  const w = window;
  w.__load = { wsOpenAt: null, playReadyAt: null };
  const NativeWS = w.WebSocket;
  w.WebSocket = function PatchedWS(...args) {
    const ws = new NativeWS(...args);
    ws.addEventListener('open', () => { if (w.__load.wsOpenAt == null) w.__load.wsOpenAt = performance.now(); });
    return ws;
  };
  w.WebSocket.prototype = NativeWS.prototype;
  Object.assign(w.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const poll = () => {
    if (w.__load.playReadyAt != null) return;
    const el = document.getElementById('menu-play-btn');
    // The button is in the static HTML, hit-testable before one line of the
    // game has run (measured: 269 ms), so it only counts once the socket is up
    // and it is STILL the element under its centre at that moment.
    if (w.__load.wsOpenAt != null && el && !el.disabled) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && (hit === el || el.contains(hit))) w.__load.playReadyAt = performance.now();
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

/** The file in dist/client with the most bytes on the wire (its .br sibling
 *  when there is one, since the server content-negotiates). */
function heaviestDistFile() {
  let best = null;
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (/\.(br|gz)$/.test(d.name)) continue;
      const br = `${full}.br`;
      const wire = existsSync(br) ? statSync(br).size : statSync(full).size;
      if (!best || wire > best.wire) best = { url: `/${relative('dist/client', full).split(sep).join('/')}`, wire };
    }
  };
  walk('dist/client');
  if (!best || best.wire < 3 * 1024 * 1024) throw new Error(`bloat mutation needs a >= 3 MB file in dist/client (largest ${best?.wire ?? 0} B)`);
  return best;
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), PIRATES_BR_STATS_PATH: `/tmp/pbr-4g-probe-stats-${process.pid}.json`, PIRATES_BR_MAP_SEED: '20260801' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const out = { gl: describeGl(), distBuildId, profile: DEVICE_PROFILES.phone.label, throttle: THROTTLE, budget: BUDGET, mutate: MUTATE || null };
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
  console.log(`4G launch gate — GL ${out.gl}, ${out.profile}, ${THROTTLE.downMbit} Mbit/s, ${THROTTLE.rttMs} ms RTT, CPU ${THROTTLE.cpuRate}x, cold cache${MUTATE ? `  [MUTATED: ${MUTATE}]` : ''}`);

  // ── A: cold load to a tappable Play ────────────────────────────────────
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
      const heavy = heaviestDistFile();
      console.log(`  ! mutation: blocking fetch of ${heavy.url} (${Math.round(heavy.wire / 1024)} KB on the wire) ahead of the entry`);
      await page.route((url) => url.pathname === '/', async (route) => {
        const res = await route.fetch();
        const html = (await res.text()).replace('<head>', `<head><script src="${heavy.url}"></script>`);
        const headers = { ...res.headers() };
        delete headers['content-encoding']; delete headers['content-length'];
        await route.fulfill({ status: res.status(), headers, body: html });
      });
    }
    const cdp = await throttle(page);
    const net = { requests: 0, bytes: 0 };
    cdp.on('Network.loadingFinished', (e) => { net.requests += 1; net.bytes += e.encodedDataLength ?? 0; });
    // The socket's handshake as the BROWSER sees it (a page-side WebSocket
    // wrapper read null on the first run), handed to the page's clock.
    cdp.on('Network.webSocketHandshakeResponseReceived', () => {
      const at = Date.now();
      page.evaluate((wall) => { if (window.__load && window.__load.wsOpenAt == null) window.__load.wsOpenAt = wall - performance.timeOrigin; }, at).catch(() => {});
    });
    await page.goto(`${BASE}/?server=${PORT}`, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForFunction(() => window.__load?.playReadyAt != null && window.__load?.wsOpenAt != null, null, { timeout: 60_000, polling: 100 })
      .catch(() => null);
    const t = await page.evaluate(() => window.__load);
    const snap = { ...net };
    const clickable = t.playReadyAt != null && t.wsOpenAt != null ? Math.max(t.playReadyAt, t.wsOpenAt) : null;
    out.load = { playReadyMs: t.playReadyAt && Math.round(t.playReadyAt), wsOpenMs: t.wsOpenAt && Math.round(t.wsOpenAt), playClickableMs: clickable && Math.round(clickable), requests: snap.requests, encodedKB: Math.round(snap.bytes / 1024) };
    console.log(`  A  Play laid out + hit-testable at ${out.load.playReadyMs} ms, socket open at ${out.load.wsOpenMs} ms; ${snap.requests} requests, ${out.load.encodedKB} KB on the wire by then`);
    expect(`Play clickable within ${BUDGET.playClickableMs} ms on the throttled 4G phone (${out.load.playClickableMs ?? 'never'} ms)`,
      clickable != null && clickable <= BUDGET.playClickableMs);
    expect('no page errors during the cold load', errors.length === 0, errors.join(' | '));
  } finally {
    await ctxA.close().catch(() => {});
  }

  // ── B: main thread after the horn, same phone, same throttle ───────────
  const ctxB = await newDeviceContext(browser, DEVICE_PROFILES.phone);
  try {
    const page = await ctxB.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
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
      const tasks = [];
      const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > longMs) tasks.push(Math.round(e.duration)); });
      obs.observe({ type: 'longtask', buffered: false });
      let frames = 0;
      let stop = false;
      const tick = () => {
        frames += 1;
        if (busy && frames % 12 === 0) { const t0 = performance.now(); while (performance.now() - t0 < 70) { /* mutation */ } }
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, windowMs));
      stop = true;
      obs.disconnect();
      // stepFrameCpu, one frame at a time, at the phone pacer's 30 fps dt.
      const g = window.__piratesBR;
      const cpu = [];
      for (let i = 0; i < 90; i += 1) cpu.push(g.benchFrameCpu(1, 1 / 30));
      cpu.sort((a, c) => a - c);
      return { tasks, frames, p50: cpu[Math.floor(cpu.length * 0.5)], p95: cpu[Math.floor(cpu.length * 0.95)] };
    }, { windowMs: PLAY_WINDOW_MS, longMs: BUDGET.longTaskMs, busy: MUTATE === 'busy' });
    out.play = { longTasks: b.tasks.length, longTaskMs: b.tasks.slice(0, 20), rafFrames: b.frames, stepFrameCpuP50: +b.p50.toFixed(2), stepFrameCpuP95: +b.p95.toFixed(2) };
    console.log(`  B  ${b.frames} rAF frames in ${PLAY_WINDOW_MS / 1000} s; long tasks > ${BUDGET.longTaskMs} ms: ${b.tasks.length} [${b.tasks.slice(0, 12).join(', ')}]`);
    console.log(`     stepFrameCpu p50 ${b.p50.toFixed(2)} ms, p95 ${b.p95.toFixed(2)} ms at 4x CPU (ADVISORY on ${out.gl}; target <= ${BUDGET.stepFrameCpuP95Ms} ms on a phone)`);
    expect(`long tasks > ${BUDGET.longTaskMs} ms after the horn <= ${BUDGET.longTasksAfterHorn} in ${PLAY_WINDOW_MS / 1000} s (${b.tasks.length})`,
      b.tasks.length <= BUDGET.longTasksAfterHorn);
    expect('the play window actually ran (>= 10 rAF frames)', b.frames >= 10, `${b.frames} frames`);
    expect('no page errors in the match', errors.length === 0, errors.join(' | '));
  } finally {
    await ctxB.close().catch(() => {});
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
writeFileSync('test-results/throttled-load.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
