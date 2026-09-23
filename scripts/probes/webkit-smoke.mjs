#!/usr/bin/env node
// PROBE (live-block step, rule 11): WEBKIT SMOKE (b1.7d; critique gap 13, vm:crossdevice:7).
//
// Every other browser gate runs Chromium, so nothing proved the game even boots in the engine
// every iPhone and iPad uses. This one drives Playwright WebKit (headless, webkit-2336) through
// the real BUILT client, one device at a time:
//   1. iPhone 14 landscape descriptor (Mobile Safari UA, touch, isMobile) at 844x390
//   2. iPad landscape descriptor at 1024x768
// deviceScaleFactor forced to 1 on both (the Air's GPU pays for every pixel).
//
// Per device: boot, tap Solo Voyage, reach phase 'playing', then 90 s of scripted touch input
// (stick holds in four directions, look drags, Fire taps) delivered as pointerType 'touch'
// pointer events on the overlay. Graded:
//   - 0 page errors, 0 unhandled rejections, 0 '[Net] error handling server message'
//   - the touch overlay is active and a 2.5 s stick-forward hold moves the pirate >= 1.5 m more
//     than 2.9 s with no finger down does (server-authoritative position, getLocalPlayer)
//   - frames advance: the game's renderer frame counter moves in every 10 s window
// The rejection detector proves itself before Play in every context: a marked rejection is raised
// through page.evaluate and MUST be seen (then discarded), or the run fails as blind.
// `--inject-rejection` raises an UNMARKED one mid-match: the run must then FAIL (the RED leg).
//
// Stack: its own LobbyServer on 8091 serving dist/client (never 3000/8090/8080), ONE Playwright
// WebKit, both killed in finally. WebKit renders through Metal, so while it runs it IS the one
// heavy process (PLAN rule 1): it refuses to start at load1 >= 4, with another headless browser
// or Blender alive, or with 8091 taken. Runtime budget 4 min. Exit 0 pass, 1 fail, 2 refused.
//
// Run from the repo root AFTER a build:
//   npx vite build && node scripts/postbuild-compress.mjs && node scripts/probes/webkit-smoke.mjs
// Flags: --inject-rejection (RED leg), --only phone|ipad, --play-seconds N (default 90).
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { loadavg, homedir } from 'node:os';
import { webkit, devices } from 'playwright';

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = '/tmp/pbr-webkit-smoke';
const RUN_BUDGET_MS = 240_000;
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const INJECT = flag('--inject-rejection');
const ONLY = opt('--only', null);
const PLAY_S = Number(opt('--play-seconds', '90'));
const MARK = '__webkit_smoke_selftest__';

const DEVICES = [
  { id: 'phone', descriptor: 'iPhone 14 landscape', viewport: { width: 844, height: 390 } },
  { id: 'ipad', descriptor: 'iPad (gen 7) landscape', viewport: { width: 1024, height: 768 } },
].filter((d) => !ONLY || d.id === ONLY);

// ── Preflight: this probe is the heavy process or it does not run ──────────
function refuse(why) {
  console.log(`webkit-smoke REFUSED: ${why}`);
  process.exit(2);
}
const load1 = loadavg()[0];
if (load1 >= 4) refuse(`load1 ${load1.toFixed(2)} >= 4 (PLAN rule 1: WebKit renders through Metal)`);
{
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const heavy = ps.split('\n').filter((l) => {
    const pid = Number(l.trim().split(/\s+/, 1)[0]);
    if (!pid || pid === process.pid) return false;
    return /ms-playwright\/(chromium|webkit|firefox)|chrome-headless-shell|headless_shell|--headless|Blender\.app\/Contents\/MacOS\/Blender|\bblender\b.*\s-b\b/i.test(l)
      && !/webkit-smoke\.mjs/.test(l);
  });
  if (heavy.length) refuse(`another heavy process is alive:\n  ${heavy.map((l) => l.trim().slice(0, 160)).join('\n  ')}`);
  let busy = '';
  try { busy = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }); } catch { /* free */ }
  if (busy.trim()) refuse(`port ${PORT} is already listening`);
}
let distBuildId;
try { distBuildId = readFileSync('dist/build-id.txt', 'utf8').trim(); } catch {
  console.log('webkit-smoke FAIL no dist/build-id.txt: build first (npx vite build && node scripts/postbuild-compress.mjs)');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// ── Stack ───────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: {
    ...process.env, PORT: String(PORT), PIRATES_BR_MAP_SEED: '20260801',
    PIRATES_BR_STATS_PATH: `/tmp/pbr-webkit-smoke-stats-${process.pid}.json`,
    BEACON_STORE_PATH: `/tmp/pbr-webkit-smoke-beacons-${process.pid}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut = (serverOut + d).slice(-20_000); });
server.stderr.on('data', (d) => { serverOut = (serverOut + d).slice(-20_000); });

let browser;
const out = { engine: 'webkit', distBuildId, buildIdServed: null, injectRejection: INJECT, playSeconds: PLAY_S, devices: {}, runtimeMs: null };
const fails = [];
const left = () => RUN_BUDGET_MS - (Date.now() - T0);

// The repo's Playwright (1.59) wants webkit-2272; this Mac has webkit-2336 (Playwright 1.62's
// build, the one PLAN names). Order: PIRATES_WEBKIT_EXECUTABLE, the pinned build if installed,
// else the newest ms-playwright/webkit-* on disk (2336 speaks 1.59's protocol for everything used
// here: contexts, touch descriptors, evaluate, screenshots). Printed in the report.
function webkitExecutable() {
  if (process.env.PIRATES_WEBKIT_EXECUTABLE) return (out.webkitExecutable = process.env.PIRATES_WEBKIT_EXECUTABLE);
  const pinned = webkit.executablePath();
  if (existsSync(pinned)) return (out.webkitExecutable = pinned);
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || `${homedir()}/Library/Caches/ms-playwright`;
  const builds = (existsSync(cache) ? readdirSync(cache) : [])
    .map((d) => /^webkit-(\d+)$/.exec(d)).filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => `${cache}/${m[0]}/pw_run.sh`).filter((f) => existsSync(f));
  if (!builds.length) throw new Error(`no Playwright WebKit build under ${cache} (npx playwright install webkit)`);
  return (out.webkitExecutable = builds[0]);
}

async function runDevice(dev) {
  const r = {
    descriptor: dev.descriptor, viewport: dev.viewport, pageErrors: [], rejections: [], netErrors: [],
    consoleErrors: 0, consoleErrorTexts: [], selfTestSeen: false, entered: null, bootToMenuMs: null, joinToPlayingMs: null,
    overlayActive: null, stickMove: null, frames: [], checks: {},
  };
  out.devices[dev.id] = r;
  const base = devices[dev.descriptor];
  if (!base) { fails.push(`${dev.id}: Playwright has no '${dev.descriptor}' descriptor`); return; }
  const ctx = await browser.newContext({ ...base, viewport: dev.viewport, screen: { width: dev.viewport.width, height: dev.viewport.height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    // WebKit's Error.stack carries frames only (no message line): grade on message + stack.
    page.on('pageerror', (e) => { const s = `${e?.message ?? e} ${e?.stack ?? ''}`.slice(0, 400); if (!s.includes(MARK)) r.pageErrors.push(s); });
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error') { r.consoleErrors += 1; if (r.consoleErrorTexts.length < 5) r.consoleErrorTexts.push(t.slice(0, 300)); }
      if (t.includes('[Net] error handling server message')) r.netErrors.push(t.slice(0, 400));
    });
    await page.addInitScript((mark) => {
      try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
      window.__wkRejections = [];
      window.__wkSelfTest = 0;
      window.addEventListener('unhandledrejection', (e) => {
        const s = `${e.reason?.message ?? e.reason} ${e.reason?.stack ?? ''}`.slice(0, 400);
        if (s.includes(mark)) window.__wkSelfTest += 1; else window.__wkRejections.push(s);
      });
    }, MARK);

    const tBoot = Date.now();
    await page.goto(`${BASE}/?server=${PORT}&debug`, { waitUntil: 'load', timeout: Math.min(90_000, left()) });
    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: Math.min(90_000, left()) });
    r.bootToMenuMs = Date.now() - tBoot;

    // Detector self-test: an unhandled rejection raised through page.evaluate must be seen.
    await page.evaluate((mark) => { Promise.reject(new Error(mark)); }, MARK);
    await sleep(300);
    r.selfTestSeen = (await page.evaluate(() => window.__wkSelfTest)) > 0;
    if (!r.selfTestSeen) fails.push(`${dev.id}: detector self-test: an injected unhandled rejection was not seen, the probe is blind`);

    await page.fill('#menu-name-input', `Wk${dev.id}`).catch(() => {});
    // Enter with a TAP, as a phone does (a mouse click would flip the scheme to mouse).
    const tJoin = Date.now();
    const btn = await page.locator('#menu-solo-btn').boundingBox();
    await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
    r.entered = 'tap';
    const started = () => page.evaluate(() => {
      const g = window.__piratesBR; const ph = g?.state?.phase;
      return !!ph && ph !== 'menu';
    }).catch(() => false);
    for (let i = 0; i < 10 && !(await started()); i += 1) await sleep(300);
    if (!(await started())) {
      // WebKit on macOS may not turn a synthetic touchscreen tap into a click: fall back to a
      // touch pointerdown (scheme = touch) + element click, and say so in the report.
      await page.evaluate(() => {
        const b = document.getElementById('menu-solo-btn');
        b.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 90, isPrimary: true, bubbles: true }));
        b.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 90, isPrimary: true, bubbles: true }));
        b.click();
      });
      r.entered = 'touch-pointer+click';
    }
    await page.waitForFunction(() => {
      const g = window.__piratesBR;
      return !!g?.state && g.state.phase === 'playing' && g.state.ships?.length >= 10;
    }, null, { timeout: Math.max(1_000, Math.min(120_000, left() - PLAY_S * 1000 - 10_000)) });
    r.joinToPlayingMs = Date.now() - tJoin;
    await sleep(2_000);

    const frame = () => page.evaluate(() => {
      const g = window.__piratesBR;
      return g?.renderer?.renderer?.info?.render?.frame ?? g?.renderer?.info?.render?.frame ?? null;
    }).catch(() => null);
    const pos = () => page.evaluate(() => {
      const p = window.__piratesBR?.getLocalPlayer?.();
      return p ? { x: p.position.x, y: p.position.y, z: p.position.z } : null;
    }).catch(() => null);
    // One finger on the overlay: pointer events with pointerType 'touch', the events a phone's
    // touches arrive as. Synthetic, so setPointerCapture throws; TouchControls tolerates that.
    const finger = (type, sel, x, y, id) => page.evaluate(([t, s, px, py, pid]) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.dispatchEvent(new PointerEvent(t, {
        pointerType: 'touch', pointerId: pid, isPrimary: true, bubbles: true, cancelable: true,
        clientX: px, clientY: py, width: 16, height: 16, pressure: t === 'pointerup' ? 0 : 0.5,
      }));
      return true;
    }, [type, sel, x, y, id]);
    const W = dev.viewport.width; const H = dev.viewport.height;
    const stickHold = async (dx, dy, ms) => {
      const x0 = Math.round(W * 0.2); const y0 = Math.round(H * 0.65);
      await finger('pointerdown', '#touch-controls .tc-zone', x0, y0, 11);
      for (let i = 1; i <= 4; i += 1) { await finger('pointermove', '#touch-controls .tc-zone', x0 + (dx * i) / 4, y0 + (dy * i) / 4, 11); await sleep(30); }
      await sleep(ms);
      await finger('pointerup', '#touch-controls .tc-zone', x0 + dx, y0 + dy, 11);
    };
    const lookDrag = async (dx) => {
      const x0 = Math.round(W * 0.62); const y0 = Math.round(H * 0.45);
      await finger('pointerdown', '#touch-controls .tc-zone', x0, y0, 12);
      for (let i = 1; i <= 10; i += 1) { await finger('pointermove', '#touch-controls .tc-zone', x0 + (dx * i) / 10, y0, 12); await sleep(16); }
      await finger('pointerup', '#touch-controls .tc-zone', x0 + dx, y0, 12);
    };
    const fireTap = async () => {
      const b = await page.locator('#touch-controls .tc-fire').boundingBox().catch(() => null);
      if (!b) return false;
      await finger('pointerdown', '#touch-controls .tc-fire', b.x + b.width / 2, b.y + b.height / 2, 13);
      await sleep(60);
      await finger('pointerup', '#touch-controls .tc-fire', b.x + b.width / 2, b.y + b.height / 2, 13);
      return true;
    };

    r.overlayActive = await page.evaluate(() => {
      const root = document.getElementById('touch-controls');
      if (!root) return { mounted: false };
      const cs = getComputedStyle(root);
      const zone = root.querySelector('.tc-zone')?.getBoundingClientRect();
      return { mounted: true, display: cs.display, visibility: cs.visibility, zone: zone ? [Math.round(zone.width), Math.round(zone.height)] : null };
    });

    // Control: the same 2.5 s with no finger down. A deck under way or a slide would move the
    // pirate too, so the stick is credited only with what it adds over this drift.
    const q0 = await pos();
    await sleep(2_900);
    const q1 = await pos();
    const drift = q0 && q1 ? Math.hypot(q1.x - q0.x, q1.z - q0.z) : null;
    // The graded move: stick forward 2.5 s.
    const p0 = await pos();
    await stickHold(0, -70, 2_500);
    await sleep(400);
    const p1 = await pos();
    const moved = p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : null;
    r.stickMove = { from: p0, to: p1, metres: moved == null ? null : Number(moved.toFixed(2)), idleDriftMetres: drift == null ? null : Number(drift.toFixed(2)) };
    await page.screenshot({ path: `${OUT}/${dev.id}-after-stick.png` }).catch(() => {});

    // The rest of the 90 s: scripted touch play, frames sampled every 10 s.
    const script = [
      () => lookDrag(150), () => stickHold(-70, 0, 1_500), () => fireTap(), () => stickHold(0, 70, 1_500),
      () => lookDrag(-150), () => stickHold(70, -40, 2_000), () => fireTap(), () => sleep(800),
    ];
    const playEnd = Date.now() + PLAY_S * 1000 - 3_300;
    let nextSample = Date.now();
    let step = 0;
    if (INJECT) setTimeout(() => { page.evaluate(() => { Promise.reject(new Error('webkit-smoke --inject-rejection')); }).catch(() => {}); }, 5_000);
    while (Date.now() < playEnd && left() > 5_000) {
      if (Date.now() >= nextSample) { r.frames.push({ t: Math.round((Date.now() - tJoin) / 1000), frame: await frame() }); nextSample += 10_000; }
      await script[step % script.length]();
      step += 1;
      await sleep(250);
    }
    r.frames.push({ t: Math.round((Date.now() - tJoin) / 1000), frame: await frame() });
    r.scriptSteps = step;
    r.phaseAfter = await page.evaluate(() => window.__piratesBR?.state?.phase ?? null).catch(() => null);
    r.rejections = await page.evaluate(() => window.__wkRejections.slice()).catch(() => ['<evaluate failed>']);
    await page.screenshot({ path: `${OUT}/${dev.id}-end.png` }).catch(() => {});

    // ── Grading ───────────────────────────────────────────────────────────
    const f = r.frames.map((s) => s.frame);
    const stalls = f.slice(1).filter((v, i) => !(typeof v === 'number' && typeof f[i] === 'number' && v > f[i])).length;
    r.framesAdvanced = typeof f[0] === 'number' && typeof f.at(-1) === 'number' ? f.at(-1) - f[0] : null;
    r.checks = {
      pageErrors: r.pageErrors.length === 0,
      unhandledRejections: r.rejections.length === 0,
      netHandlerErrors: r.netErrors.length === 0,
      overlayActive: !!r.overlayActive?.mounted && r.overlayActive.display !== 'none' && r.overlayActive.visibility !== 'hidden',
      stickMovesPirate: moved != null && drift != null && moved - drift >= 1.5,
      framesAdvancing: f.length >= 2 && stalls === 0 && (r.framesAdvanced ?? 0) > 0,
      stillPlaying: r.phaseAfter === 'playing',
    };
    for (const [k, ok] of Object.entries(r.checks)) if (!ok) fails.push(`${dev.id}: ${k}`);
  } catch (e) {
    fails.push(`${dev.id}: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

try {
  for (let i = 0; i < 80 && out.buildIdServed == null; i += 1) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok) out.buildIdServed = (await h.json()).buildId ?? '?'; } catch { /* booting */ }
    if (out.buildIdServed == null) await sleep(500);
  }
  if (out.buildIdServed == null) throw new Error(`server on ${PORT} never answered /health`);
  if (out.buildIdServed !== distBuildId) fails.push(`server buildId ${out.buildIdServed} != dist ${distBuildId}`);
  browser = await webkit.launch({ headless: true, executablePath: webkitExecutable() });
  out.webkitVersion = browser.version();
  for (const dev of DEVICES) {
    if (left() < 30_000) { fails.push(`${dev.id}: skipped, run budget exhausted`); continue; }
    await runDevice(dev);
  }
} catch (e) {
  fails.push(`probe error: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  server.kill('SIGKILL');
}
out.runtimeMs = Date.now() - T0;
if (out.runtimeMs > RUN_BUDGET_MS + 15_000) fails.push(`runtime ${Math.round(out.runtimeMs / 1000)} s > 4 min`);
out.fails = fails;
writeFileSync(`${OUT}/result.json`, JSON.stringify(out, null, 1));
if (fails.length) console.log(`server tail:\n${serverOut.slice(-1500)}`);
console.log(JSON.stringify(out, null, 1));
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `webkit-smoke FAIL (${fails.length})` : 'webkit-smoke PASS');
process.exit(fails.length ? 1 : 0);
