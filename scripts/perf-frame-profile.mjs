#!/usr/bin/env node
// WHERE THE CPU SIDE OF A FRAME GOES, AND WHAT MAKES IT HITCH.
//
// A companion to perf-cost-model.mjs, which prices the GPU side. This one takes
// a CDP CPU profile over real play, attributes self time by subsystem, measures
// what a frame ALLOCATES, and runs a hitch census: every rAF gap over the
// threshold, with the stack that was on the CPU while it lasted.
//
// WHY IT PROFILES TWICE, AND WHY THE SECOND ONE COLLAPSES THE FRAMEBUFFER.
//
// On the software rasteriser this repo is limited to, a full-resolution frame is
// seconds long and essentially all of it is SwiftShader shading pixels. That
// profile is worth having — it says what fraction of the frame is fill, which is
// the whole argument for the overdraw work — but it drowns every JS subsystem
// under one native symbol, and at two frames a second a sixty-second capture is
// a hundred and twenty frames of gameplay logic. Nothing about netcode,
// animation, HUD or LOD can be read out of it.
//
// So the second pass pins the pixel ratio to 0.1 (a 96x54 framebuffer). The
// rasteriser's share collapses to nothing; every line of JS the frame runs is
// unchanged, and the frame rate becomes realistic, so three minutes is thousands
// of frames instead of a few hundred. THAT is the pass the subsystem table and
// the hitch census come from, and its numbers are the ones that carry to a real
// GPU: a shader link, a buffer upload, an island build and a garbage collection
// cost what they cost regardless of how many pixels the frame covered.
//
// The two are reported separately and never averaged together.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-frame-profile.mjs --quality low --minutes 3 --out /tmp/frame-low.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { COST_PRELUDE } from './lib/cost-model-prelude.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', null);
const CENSUS_MIN = parseFloat(arg('minutes', '3'));
const FULLRES_SEC = parseInt(arg('fullres', '60'), 10);
const HITCH_MS = parseFloat(arg('hitch', '50'));
const COLLAPSED_RATIO = parseFloat(arg('collapsed', '0.1'));
/** Skip the full-resolution pass. It is the expensive one (a frame is seconds)
 *  and it answers a question — how much of a frame is fill — that only has to be
 *  asked once per tier. */
const SKIP_FULLRES = argv.includes('--skip-fullres');
const VIEWPORT = { width: 960, height: 540 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep a pirate doing pirate things: walk, look about, sprint, fire. Driven
 *  through the real listeners (the input manager's own keydown/mousemove path
 *  is part of the per-frame cost being measured), with `locked` forced because
 *  a headless tab cannot take pointer lock and the look handler gates on it. */
const DRIVE = `
window.__drive = {
  stop: false,
  async run(ms) {
    const g = window.__piratesBR;
    try { g.input.locked = true; } catch {}
    const key = (type, code) => document.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const look = (dx, dy) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }));
    const click = (down) => document.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: 0, bubbles: true }));
    const t0 = performance.now();
    let phase = 0;
    const held = new Set();
    const press = (code) => { if (!held.has(code)) { held.add(code); key('keydown', code); } };
    const release = (code) => { if (held.has(code)) { held.delete(code); key('keyup', code); } };
    while (!this.stop && performance.now() - t0 < ms) {
      const t = performance.now() - t0;
      // A slow yaw sweep every frame: this is what makes the LOD gates, the
      // culler and the shadow frustum do work, and a camera that never turns
      // measures a game nobody is playing.
      look(Math.sin(t / 900) * 9, Math.sin(t / 2300) * 2.2);
      const seg = Math.floor(t / 4000) % 6;
      if (seg !== phase) {
        phase = seg;
        for (const c of [...held]) release(c);
        if (seg === 0) press('KeyW');
        if (seg === 1) { press('KeyW'); press('ShiftLeft'); }
        if (seg === 2) { press('KeyA'); }
        if (seg === 3) { press('KeyS'); }
        if (seg === 4) { press('KeyD'); press('Space'); }
        if (seg === 5) { press('KeyW'); }
      }
      if (Math.floor(t / 1500) % 4 === 0) { click(true); setTimeout(() => click(false), 140); }
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (const c of [...held]) release(c);
    return true;
  },
};
`;

/** Which subsystem a profiler frame belongs to. Keyed on the module URL first —
 *  this codebase's directories ARE its subsystems — and on the function name
 *  where the URL cannot say (three's own bundle, and V8's native frames). */
function classify(fn, url) {
  const f = fn || '(anonymous)';
  const u = url || '';
  if (f === '(garbage collector)') return 'gc';
  if (f === '(idle)') return 'idle';
  if (f === '(program)') return 'native/gl-and-compile';
  if (f === '(root)' || f === '(metadata)') return 'idle';
  // The WebGL entry points arrive with no URL, and lumping them together as
  // "native" is true and useless: getProgramInfoLog and uniformMatrix4fv are two
  // different problems in one label — one is a shader link the load was supposed
  // to have paid for, the other is the per-draw-call bill. Split them.
  if (/getProgramInfoLog|getShaderInfoLog|getProgramParameter|linkProgram|compileShader|attachShader|createProgram|shaderSource/.test(f)) return 'gl:shader-link';
  if (/setSize|setPixelRatio/.test(f)) return 'gl:swapchain-resize';
  if (/^uniform|useProgram/.test(f)) return 'gl:uniform-upload';
  if (/^draw(Elements|Arrays)/.test(f)) return 'gl:draw-submit';
  if (/bufferData|bufferSubData|vertexAttribPointer|bindVertexArray|bindBuffer/.test(f)) return 'gl:geometry-upload';
  if (/texImage|texSubImage|generateMipmap|bindTexture|texParameter/.test(f)) return 'gl:texture-upload';
  if (/readPixels|bindFramebuffer|framebufferTexture|^clear|viewport|scissor|blitFramebuffer/.test(f)) return 'gl:framebuffer';
  if (u.includes('/client/rendering/OceanRenderer')) return 'render:ocean';
  if (u.includes('/client/rendering/EnvironmentFx')) return 'render:environment-fx';
  if (u.includes('/client/rendering/CombatFx')) return 'render:combat-fx';
  if (u.includes('/client/rendering/ShipRenderer')) return 'render:ship';
  if (u.includes('/client/rendering/ViewmodelController')) return 'render:viewmodel';
  if (u.includes('/client/rendering/PlayerAnimator')) return 'animation';
  if (u.includes('/client/rendering/')) return 'render:core';
  if (u.includes('/client/world/')) return 'world/island-build';
  if (u.includes('/client/ui/') || u.includes('/client/menu/')) return 'hud/dom';
  if (u.includes('/client/audio/')) return 'audio';
  if (u.includes('/client/network/')) return 'netcode';
  if (u.includes('/client/input/')) return 'input';
  if (u.includes('/client/systems/')) return 'systems';
  if (u.includes('/client/core/ClientState')) return 'netcode';
  if (u.includes('/client/core/Game')) return 'game-loop';
  if (u.includes('/shared/')) return 'shared-sim';
  if (u.includes('three')) return 'three';
  if (u.includes('simplex-noise')) return 'noise';
  if (!u) return 'native/other';
  return 'other';
}

/** What a hitch was DOING. Read off the heaviest frames sampled inside it. */
function classifyHitch(topFrames) {
  const names = topFrames.map((f) => `${f.functionName} ${f.url}`).join(' ').toLowerCase();
  if (/garbage collector/.test(names)) return 'gc';
  if (/linkprogram|getprograminfolog|getshaderinfolog|getprogramparameter|onfirstuse|acquireprogram|initprogram|setprogram|compileshader|webglprogram/.test(names)) return 'shader-link';
  if (/setsize|setpixelratio/.test(names)) return 'swapchain-resize';
  if (/teximage|texsubimage|uploadtexture|generatemipmap|settexture2d/.test(names)) return 'texture-upload';
  if (/bufferdata|buffersubdata|updatebuffer|setupvertexattributes|bindingstates|uploadgeometry/.test(names)) return 'geometry-upload';
  if (/islandbuilder|buildisland|island-|terrain|scatterprops|buildprop/.test(names)) return 'island-build';
  if (/chart|minimap|map\.ts|drawmap/.test(names)) return 'chart';
  if (/network|socket|onmessage|parsesnapshot|json\.parse|decode/.test(names)) return 'net-burst';
  if (/computeboundingsphere|updatematrixworld|projectobject|rendersceneobjects|renderbufferdirect/.test(names)) return 'render-traversal';
  if (/uniformmatrix|uniform\d|useprogram|drawelements|drawarrays/.test(names)) return 'draw-submission';
  return 'other';
}

/** Turn a raw CDP profile into self-time-by-function and self-time-by-subsystem,
 *  plus the sample timeline a hitch census needs to ask "what was on the CPU at
 *  time T". */
function digest(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const timeline = []; // { at (µs from profile start), nodeId, dt }
  let t = profile.startTime;
  let total = 0;
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = deltas[i] ?? 0;
    t += dt;
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + dt);
    timeline.push({ at: t - profile.startTime, id, dt });
    total += dt;
  }
  const rows = [];
  const bySubsystem = new Map();
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame ?? {};
    const key = classify(cf.functionName, cf.url);
    bySubsystem.set(key, (bySubsystem.get(key) ?? 0) + us);
    rows.push({
      functionName: cf.functionName || '(anonymous)',
      url: (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0],
      line: (cf.lineNumber ?? -1) + 1,
      selfUs: us,
      hits: n.hitCount ?? 0,
      subsystem: key,
    });
  }
  rows.sort((a, b) => b.selfUs - a.selfUs);

  // GC pauses: contiguous runs of samples inside a collector frame.
  const gcIds = new Set([...byId.values()].filter((n) => n.callFrame?.functionName === '(garbage collector)').map((n) => n.id));
  const pauses = [];
  let run = null;
  for (const s of timeline) {
    if (gcIds.has(s.id)) {
      if (!run) run = { start: s.at, us: 0 };
      run.us += s.dt;
    } else if (run) { pauses.push(run); run = null; }
  }
  if (run) pauses.push(run);

  return {
    totalUs: total,
    wallUs: profile.endTime - profile.startTime,
    rows,
    bySubsystem: [...bySubsystem.entries()].map(([k, us]) => ({ subsystem: k, selfUs: us, pct: (us / total) * 100 }))
      .sort((a, b) => b.selfUs - a.selfUs),
    gc: {
      pauseCount: pauses.length,
      totalUs: pauses.reduce((s, p) => s + p.us, 0),
      longestUs: pauses.reduce((m, p) => Math.max(m, p.us), 0),
      pauses: pauses.map((p) => ({ atMs: p.start / 1000, ms: p.us / 1000 })).sort((a, b) => b.ms - a.ms).slice(0, 40),
    },
    byId,
    timeline,
  };
}

/**
 * For each recorded rAF gap, the functions that were actually on the CPU while
 * it lasted — the difference between "a hitch happened" and a hitch census.
 *
 * TWO CLOCKS, ONE ORIGIN. The gaps are stamped in `performance.now()`; the
 * profile's samples are microseconds from `profile.startTime`. The only instant
 * both clocks name is the moment Profiler.start returned, so `profileStartedAt`
 * is the perf.now reading taken there and every gap is shifted by it — and by
 * NOTHING ELSE. Folding in the sampler's own install time as well (which the
 * first version of this did) slides the whole census several seconds early, so
 * every window lands in a stretch of profile that has not been recorded yet,
 * every hitch comes back with an empty stack, and 271 real stalls are all
 * reported as cause "other".
 */
function attributeHitches(gaps, dig, profileStartedAt) {
  const out = [];
  for (const gap of gaps) {
    const startUs = (gap.startAt - profileStartedAt) * 1000;
    const endUs = (gap.endAt - profileStartedAt) * 1000;
    const inWindow = new Map();
    for (const s of dig.timeline) {
      if (s.at < startUs) continue;
      if (s.at > endUs) break;
      inWindow.set(s.id, (inWindow.get(s.id) ?? 0) + s.dt);
    }
    const frames = [...inWindow.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, us]) => {
        const cf = dig.byId.get(id)?.callFrame ?? {};
        return {
          functionName: cf.functionName || '(anonymous)',
          url: (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0],
          selfMs: us / 1000,
          subsystem: classify(cf.functionName, cf.url),
        };
      });
    out.push({ atMs: Math.round(gap.startAt), ms: Math.round(gap.ms * 10) / 10, cause: classifyHitch(frames), frames });
  }
  return out;
}

async function main() {
  const port = SERVER_PORT ?? '8090';
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!h) { console.error(`no game server on :${port}`); process.exit(2); }
  console.log(`Frame CPU profile — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);

  // The client server this run measures against. If the developer already has
  // one up it is used and never touched; otherwise the runner starts its OWN and
  // owns its lifetime, because a Vite borrowed from a shell has twice now exited
  // in the middle of a half-hour survey.
  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs([
      '--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio',
      '--js-flags=--expose-gc', '--enable-precise-memory-info',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ]),
  });

  const report = { at: new Date().toISOString(), quality: QUALITY, gl: describeGl(), mapSeed: h.mapSeed, phases: {} };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  try {
    await page.goto(`${URL}/?${sessionQuery(['debug', 'forceinput', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate((src) => { (0, eval)(src); }, `${COST_PRELUDE}\n${DRIVE}`);
    await page.evaluate(() => window.__cost.loadThree());

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');

    const runPhase = async ({ name, ratio, seconds, intervalUs, hitchMs }) => {
      console.log(`\n── ${name}: ratio ${ratio}, ${seconds}s ──`);
      const pin = await page.evaluate((r) => window.__cost.pinRatio(r), ratio);
      console.log(`  framebuffer ${pin.drawingBuffer.join('x')} (asked ${ratio}, got ${pin.got})`);
      await page.waitForTimeout(2500);
      await page.evaluate((t) => window.__cost.installHitch(t), hitchMs);
      await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });
      await cdp.send('Profiler.start');
      const startedAt = await page.evaluate(() => performance.now());
      await page.evaluate((ms) => window.__drive.run(ms), seconds * 1000);
      const { profile } = await cdp.send('Profiler.stop');
      const hitch = await page.evaluate(() => ({
        frames: window.__hitch.frames,
        gaps: window.__hitch.gaps,
        all: window.__hitch.all,
        threshold: window.__hitch.threshold,
      }));
      const dig = digest(profile);
      const gaps = attributeHitches(hitch.gaps, dig, startedAt);
      const sorted = [...hitch.all].sort((a, b) => a - b);
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const causeTotals = {};
      for (const g of gaps) {
        const c = (causeTotals[g.cause] ??= { count: 0, ms: 0, worstMs: 0 });
        c.count += 1; c.ms += g.ms; c.worstMs = Math.max(c.worstMs, g.ms);
      }
      console.log(`  frames ${hitch.frames} over ${seconds}s — median ${pct(0.5).toFixed(1)}ms p95 ${pct(0.95).toFixed(1)}ms p99 ${pct(0.99).toFixed(1)}ms max ${sorted[sorted.length - 1]?.toFixed(1)}ms`);
      console.log(`  hitches over ${hitchMs}ms: ${hitch.gaps.length}  (${Object.entries(causeTotals).map(([k, v]) => `${k}=${v.count}/${Math.round(v.ms)}ms`).join(' ')})`);
      console.log(`  GC: ${dig.gc.pauseCount} pauses, ${(dig.gc.totalUs / 1000).toFixed(0)}ms total, longest ${(dig.gc.longestUs / 1000).toFixed(1)}ms`);
      console.log('  top subsystems: ' + dig.bySubsystem.slice(0, 8).map((s) => `${s.subsystem}=${s.pct.toFixed(1)}%`).join('  '));
      console.log('  top self time:');
      for (const r of dig.rows.slice(0, 15)) {
        console.log(`    ${(r.selfUs / 1000).toFixed(0).padStart(7)}ms  ${r.subsystem.padEnd(22)} ${r.functionName.slice(0, 40).padEnd(42)} ${r.url.slice(-46)}:${r.line}`);
      }
      return {
        ratio, seconds, framebuffer: pin.drawingBuffer,
        frames: hitch.frames,
        frameMs: { median: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), max: sorted[sorted.length - 1] ?? 0 },
        frameHistogram: sorted.filter((_, i) => i % Math.max(1, Math.floor(sorted.length / 200)) === 0),
        hitchThresholdMs: hitchMs,
        hitchCount: hitch.gaps.length,
        hitchCauses: causeTotals,
        hitches: gaps.sort((a, b) => b.ms - a.ms).slice(0, 60),
        gc: dig.gc,
        bySubsystem: dig.bySubsystem,
        topFunctions: dig.rows.slice(0, 40),
        profileWallSec: dig.wallUs / 1e6,
      };
    };

    if (!SKIP_FULLRES) report.phases.fullResolution = await runPhase({
      name: 'full resolution (fill in frame — this is the fill share, not the JS table)',
      ratio: 1, seconds: FULLRES_SEC, intervalUs: 1000, hitchMs: 250,
    });

    report.phases.collapsed = await runPhase({
      name: 'framebuffer collapsed (the JS table and the hitch census)',
      ratio: COLLAPSED_RATIO, seconds: Math.round(CENSUS_MIN * 60), intervalUs: 400, hitchMs: HITCH_MS,
    });

    // Allocation, measured with the profiler OFF so its own sampling is not in
    // the reading, and with the framebuffer still collapsed so a hundred frames
    // take seconds rather than minutes.
    //
    // SUPERSEDED — DO NOT QUOTE THESE PER-FRAME NUMBERS. This is the rAF-window
    // probe, and a window that spans a garbage collection measures allocation
    // MINUS whatever was swept inside it: the same build reads 196.5 KB/frame
    // over 120 frames and 60.3 over 300, and neither is the answer. It is kept
    // because the retained column is still a useful leak signal at this
    // timescale. For bytes per frame use scripts/perf-alloc-census.mjs, which
    // reads the heap either side of ONE frame at a time and drives the CPU path
    // with no GL in it (docs/FRAME_COST_MODEL.md §6.3.1).
    console.log('\n── allocation (rAF window — SUPERSEDED, see perf-alloc-census.mjs) ──');
    const alloc = [];
    for (const frames of [120, 300]) {
      const r = await page.evaluate(async (n) => {
        const driving = window.__drive.run(60_000);
        const out = await window.__cost.allocationRate(n);
        window.__drive.stop = true;
        await driving;
        window.__drive.stop = false;
        return out;
      }, frames);
      alloc.push(r);
      if (r.error) console.log(`  ${frames} frames: ${r.error}`);
      else {
        console.log(`  ${frames} frames in ${(r.elapsedMs / 1000).toFixed(1)}s — gross ${(r.grossPerFrame / 1024).toFixed(1)} KB/frame, net retained ${(r.netPerFrame / 1024).toFixed(2)} KB/frame`);
      }
    }
    report.phases.allocation = alloc;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    stopDevClient(client);
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
