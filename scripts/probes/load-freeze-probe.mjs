// PROBE, not a gate: LOAD-FREEZE PROBE — where the client stops answering between navigation and first control.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// LOAD-FREEZE PROBE — where the client stops answering between navigation and first control.
//
// The perf probes in this repo all measure a world that has already arrived: they
// wait for the menu, join, wait out a fixed settle, and then time frames. None of
// them measures the interval the player actually complains about, which is the one
// where nothing on screen moves and the tab will not answer a click.
//
// So this one measures RESPONSIVENESS, not frame rate:
//
//   * a CDP sampling profile runs across the whole load, so every stall can be
//     attributed to the JS frames that were on the stack while it lasted;
//   * a heartbeat loop asks the page for `Date.now()` every 100ms — that call is
//     queued on the main thread, so the time it takes to come back IS the length
//     of the task in front of it. This is the only number that answers "was the
//     tab responsive", and it is measured from outside the tab on purpose;
//   * milestones (first paint, menu interactive, join click, countdown, first
//     control) are timestamped so a stall can be named by the segment it lands in.
//
// Feature flags for the A/B, read by the client from the URL — see --off:
//   nowarmboost   join/countdown warm boost off (IslandDetailWarmer.setBoosted)
//   nobatch       StaticBatcher off (collapseIslandDecor)
//   noaudition    runtime quality audition off
//
// Usage:
//   node scripts/load-freeze-probe.mjs --url http://127.0.0.1:3000 --quality low
//   node scripts/load-freeze-probe.mjs --off nobatch --label no-staticbatcher
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const URL_BASE = arg('url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const QUALITY = arg('quality', null);        // null = let the detector decide
const OFF = (arg('off', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = arg('label', OFF.length ? OFF.join('+') : 'baseline');
const OUT = arg('out', null);
const JOIN = !flag('nojoin');
const AFTER_JOIN_MS = parseInt(arg('after', '75000'), 10);
const HEARTBEAT_MS = 100;

const VIEWPORT = { width: 960, height: 540 };

function url() {
  const params = new URLSearchParams();
  // `?debug` only publishes the Game instance on window (see main.ts) and opens a
  // perf panel — it changes no LOD, budget or build path, so a run that reads the
  // warmer's own cost log is still the normal load path.
  if (flag('debug')) params.set('debug', '1');
  if (QUALITY) params.set('quality', QUALITY);
  for (const f of OFF) params.set(f, '1');
  const q = params.toString();
  return `${URL_BASE}/${q ? `?${q}` : ''}`;
}

// ─── sampled-profile attribution ────────────────────────────────
// Chrome hands back nodes + a flat sample array + per-sample time deltas. To say
// "this 4-second gap was spent in X" the samples have to be walked in TIME order
// and bucketed into the gap, which is what this does.
function buildProfileIndex(profile) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const stackOf = (id) => {
    const out = [];
    let n = byId.get(id);
    let guard = 0;
    while (n && guard++ < 64) {
      const f = n.callFrame;
      const name = f.functionName || '(anonymous)';
      const file = (f.url || '').split('/').slice(-1)[0];
      out.push(file ? `${name} @${file}:${f.lineNumber + 1}` : name);
      n = n.parent !== undefined ? byId.get(n.parent) : undefined;
    }
    return out;
  };
  // parent links: Chrome gives children, not parents
  for (const node of profile.nodes) {
    for (const child of node.children || []) {
      const c = byId.get(child);
      if (c) c.parent = node.id;
    }
  }
  // absolute microsecond timestamp per sample
  const times = [];
  let t = profile.startTime;
  for (let i = 0; i < profile.timeDeltas.length; i++) { t += profile.timeDeltas[i]; times.push(t); }
  return { samples: profile.samples, times, stackOf, byId };
}

/** Top self-time functions inside an absolute-microsecond window. */
function attribute(index, fromUs, toUs, topN = 6) {
  const self = new Map();
  const stacks = new Map();
  let n = 0;
  for (let i = 0; i < index.samples.length; i++) {
    const ts = index.times[i];
    if (ts < fromUs || ts > toUs) continue;
    n += 1;
    const id = index.samples[i];
    const node = index.byId.get(id);
    if (!node) continue;
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} @${(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + 1);
    if (!stacks.has(key)) stacks.set(key, index.stackOf(id).slice(0, 12));
  }
  const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  return { samples: n, top: ranked.map(([k, c]) => ({ fn: k, pct: n ? +(100 * c / n).toFixed(1) : 0, stack: stacks.get(k) })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`[load-probe] ${LABEL} — ${url()}  gl=${describeGl()}  viewport=${VIEWPORT.width}x${VIEWPORT.height}`);
  const browser = await chromium.launch({
    headless: true,
    args: browserArgs(['--mute-audio', '--autoplay-policy=no-user-gesture-required']),
  });
  const result = { label: LABEL, url: url(), milestones: {}, stalls: [], console: [], failedRequests: [], pageErrors: [] };
  let page;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page = await context.newPage();

    page.on('console', (m) => {
      const text = `${m.type()}: ${m.text()}`.slice(0, 400);
      result.console.push({ at: Date.now(), text });
      if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console] ${text}`);
    });
    page.on('pageerror', (e) => { result.pageErrors.push(String(e).slice(0, 500)); console.log(`  [pageerror] ${e}`); });
    page.on('requestfailed', (r) => {
      result.failedRequests.push(`${r.url().slice(0, 160)} — ${r.failure()?.errorText}`);
      console.log(`  [reqfail] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`);
    });

    // In-page recorders. Installed before any app script runs.
    await page.addInitScript(() => {
      const w = window;
      w.__loadProbe = { longTasks: [], rafGaps: [], marks: {}, frames: 0 };
      w.__loadProbe.marks.scriptStart = performance.now();
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            w.__loadProbe.longTasks.push({ at: +e.startTime.toFixed(1), ms: +e.duration.toFixed(1) });
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch { /* no longtask support */ }
      // Clock anchor. The sampling profiler stamps its samples in microseconds
      // from an epoch that is neither Date.now() nor performance.now(), so a
      // stall measured from outside cannot be looked up in the profile without
      // one point where both clocks are known. This function is easy to find in
      // the samples (unique name, spins long enough to be sampled repeatedly)
      // and reports the page clock it started on.
      w.__probeAnchor = () => {
        const t = performance.now();
        while (performance.now() - t < 80) { /* spin so the sampler catches it */ }
        return t;
      };
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        const gap = now - last;
        w.__loadProbe.frames += 1;
        if (gap > 250) w.__loadProbe.rafGaps.push({ at: +last.toFixed(1), ms: +gap.toFixed(1) });
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); // 0.5ms
    await cdp.send('Profiler.start');

    // ─── heartbeat: the only honest responsiveness measure ───────
    // Runs on its own CDP session so Playwright's own queue is not the thing
    // being measured; each call is a main-thread task, so its round trip is the
    // length of whatever was in front of it.
    const beat = await context.newCDPSession(page);
    await beat.send('Runtime.enable');
    const stalls = result.stalls;
    let beating = true;
    const heartbeat = (async () => {
      while (beating) {
        const t0 = Date.now();
        try {
          await beat.send('Runtime.evaluate', { expression: '1', returnByValue: true, timeout: 300_000 });
        } catch { /* page navigating */ }
        const dt = Date.now() - t0;
        if (dt > 400) {
          stalls.push({ startedAt: t0, ms: dt });
          if (dt > 900) console.log(`  [stall] main thread unavailable ${(dt / 1000).toFixed(2)}s`);
        }
        await sleep(HEARTBEAT_MS);
      }
    })();

    const T0 = Date.now();
    const mark = (name) => { result.milestones[name] = Date.now() - T0; console.log(`  [mark] ${name.padEnd(20)} +${((Date.now() - T0) / 1000).toFixed(2)}s`); };

    result.navStartWall = T0;
    await page.goto(url(), { waitUntil: 'commit', timeout: 120_000 });
    mark('navCommit');

    // first paint of the loading screen
    await page.waitForFunction(() => !!document.getElementById('loading-screen'), undefined, { timeout: 120_000 });
    mark('loadingScreenInDom');

    await page.waitForFunction(() => {
      const el = document.getElementById('loading-screen');
      return !!el && (el.classList.contains('hidden') || getComputedStyle(el).opacity === '0');
    }, undefined, { timeout: 180_000 }).catch(() => console.log('  [warn] loading screen never hid'));
    mark('loadingScreenHidden');

    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 180_000 });
    mark('menuVisible');

    // Menu INTERACTIVE is not the same as menu visible: measure how long a real
    // click takes to be acknowledged.
    const clickT0 = Date.now();
    await page.hover('#menu-solo-btn', { timeout: 60_000 }).catch(() => {});
    result.milestones.menuHoverMs = Date.now() - clickT0;
    mark('menuInteractive');

    if (JOIN) {
      await page.click('#menu-solo-btn', { noWaitAfter: true, timeout: 60_000 });
      mark('joinClicked');

      await page.waitForFunction(() => {
        const el = document.getElementById('match-start-seq');
        return !!el && el.classList.contains('visible');
      }, undefined, { timeout: 180_000 }).catch(() => console.log('  [warn] countdown card never appeared'));
      mark('countdownVisible');

      // First control = the ceremony has cleared and the HUD is live.
      const deadline = Date.now() + AFTER_JOIN_MS;
      let controlled = false;
      while (Date.now() < deadline) {
        try {
          const state = await page.evaluate(() => {
            const seq = document.getElementById('match-start-seq');
            return {
              ceremony: !!seq && seq.classList.contains('visible'),
              hint: document.getElementById('match-start-hint')?.textContent || '',
              count: document.getElementById('match-start-count')?.textContent || '',
              frames: window.__loadProbe?.frames ?? 0,
            };
          });
          if (!state.ceremony && state.frames > 0) { controlled = true; break; }
        } catch { /* blocked */ }
        await sleep(500);
      }
      if (controlled) mark('firstControl');
      else console.log(`  [warn] never reached first control within ${AFTER_JOIN_MS}ms`);
    }

    beating = false;
    await heartbeat.catch(() => {});

    // Drop the clock anchor now that the load is over — it is looked up in the
    // profile below to tie page milliseconds to profiler microseconds.
    const anchorPageMs = await page.evaluate(() => window.__probeAnchor()).catch(() => null);

    const inPage = await page.evaluate(() => window.__loadProbe).catch(() => null);
    result.inPage = inPage;
    result.game = await page.evaluate(() => {
      const g = window.__piratesBR;
      if (!g) return null;
      return {
        quality: g.renderer?.getQuality?.() ?? null,
        warmCostLog: (g.lodWarmer?.costLog ?? []).slice(-60),
        warmState: g.lodWarmer?.debugState?.() ?? null,
        buildBacklog: g.getWorldBuildBacklog?.() ?? null,
        rendererInfo: g.renderer?.renderer?.info
          ? { programs: g.renderer.renderer.info.programs?.length, ...g.renderer.renderer.info.render, ...g.renderer.renderer.info.memory }
          : null,
      };
    }).catch(() => null);

    const { profile } = await cdp.send('Profiler.stop');
    const index = buildProfileIndex(profile);

    // profiler µs = page ms * 1000 + offset, solved at the anchor.
    let offsetUs = null;
    if (anchorPageMs !== null) {
      for (let i = 0; i < index.samples.length; i++) {
        const node = index.byId.get(index.samples[i]);
        // The name Chrome infers for the anchor is 'w.__probeAnchor', not the
        // bare identifier — match on the substring or the offset stays null and
        // every attribution window comes back empty.
        if ((node?.callFrame?.functionName || '').includes('__probeAnchor')) { offsetUs = index.times[i] - anchorPageMs * 1000; break; }
      }
    }
    result.clockOffsetUs = offsetUs;
    const toUs = (pageMs) => (offsetUs ?? 0) + pageMs * 1000;

    // The in-page rAF gaps are already on the page clock and are the same events
    // the heartbeat sees from outside, so they are what gets attributed.
    const gaps = [...(inPage?.rafGaps ?? [])].sort((a, b) => b.ms - a.ms).slice(0, 10);
    result.worstStalls = gaps.map((g) => ({ atMs: g.at, ms: g.ms, ...attribute(index, toUs(g.at), toUs(g.at + g.ms)) }));

    // Whole-load attribution as a backstop.
    result.wholeLoad = attribute(index, profile.startTime, profile.endTime, 12);

    console.log('\n──── milestones (ms from navigation) ────');
    for (const [k, v] of Object.entries(result.milestones)) console.log(`  ${k.padEnd(22)} ${v}`);
    const totalStall = result.stalls.reduce((a, s) => a + s.ms, 0);
    console.log(`\n──── responsiveness ────`);
    console.log(`  stalls >400ms: ${result.stalls.length}   total unresponsive: ${(totalStall / 1000).toFixed(1)}s`);
    console.log(`  longest single stall: ${(Math.max(0, ...result.stalls.map((s) => s.ms)) / 1000).toFixed(2)}s`);
    console.log(`  rAF gaps >250ms: ${inPage?.rafGaps?.length ?? '?'}  frames: ${inPage?.frames ?? '?'}`);

    console.log(`\n──── worst rAF gaps, attributed (page clock) ────`);
    for (const s of result.worstStalls) {
      console.log(`\n  +${(s.atMs / 1000).toFixed(2)}s  frame gap ${(s.ms / 1000).toFixed(2)}s  (${s.samples} samples)`);
      for (const t of s.top) console.log(`     ${String(t.pct).padStart(5)}%  ${t.fn}`);
      if (s.top[0]) console.log(`       stack: ${s.top[0].stack.slice(0, 9).join(' < ')}`);
    }

    if (result.game) {
      console.log(`\n──── game state ────`);
      console.log(`  quality=${result.game.quality}  backlog=${result.game.buildBacklog}`);
      console.log(`  renderer: ${JSON.stringify(result.game.rendererInfo)}`);
      console.log(`  warm: ${JSON.stringify(result.game.warmState)?.slice(0, 400)}`);
      const log = result.game.warmCostLog ?? [];
      const heavy = [...log].sort((a, b) => (b.warmMs + b.revealMs) - (a.warmMs + a.revealMs)).slice(0, 10);
      console.log(`  warmer cost log — worst frames (warmMs/revealMs/chunk/released/id):`);
      for (const e of heavy) console.log(`     warm ${String(e.warmMs).padStart(8)}ms  reveal ${String(e.revealMs).padStart(7)}ms  chunk=${e.warmChunk} released=${e.released} ${e.warmId ?? ''}`);
    }

    console.log(`\n──── whole load, top self time ────`);
    for (const t of result.wholeLoad.top) console.log(`   ${String(t.pct).padStart(5)}%  ${t.fn}`);

    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(result, null, 2)); console.log(`\n  wrote ${OUT}`); }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
