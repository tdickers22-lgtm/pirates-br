#!/usr/bin/env node
/**
 * DOES THE CHEAPEST TIER HAVE ANY ANTI-ALIASING AT ALL? (AA-01: graphics-16,
 * perf-18)
 *
 * `low` renders at 0.44-0.62 of CSS pixels, built no post chain and asked the
 * context for `antialias: false`, so it had no MSAA, no FXAA and no
 * supersampling of any kind — and it is the tier an Apple-silicon Air in
 * Chrome, every phone and every Intel laptop is given. The artifact is a
 * staircase on the geometry the eye tracks: the horizon line, rigging, rails.
 *
 * THE INSTRUMENT. A staircase is a run of HARD steps: adjacent pixels whose
 * luma differs by more than a threshold, along the axis the edge is shallow in.
 * Anti-aliasing does not remove the edge, it SPREADS it — the same contrast is
 * paid over two or three pixels, so each individual step falls under the
 * threshold and the count collapses while the picture keeps its contrast. So
 * the score is "how many hard luma steps are there", counted:
 *
 *   - down COLUMNS across the horizon band (a near-horizontal edge steps
 *     vertically), and
 *   - across ROWS over the deck/rigging band (masts, rails and shrouds are
 *     near-vertical and step horizontally).
 *
 * The frame is read back from the drawing buffer itself (`toDataURL` on the
 * game's own canvas), so what is graded is the framebuffer the player sees,
 * upscale and all.
 *
 * IT IS A COMPARISON, so it needs a baseline: run it once with `--baseline`
 * against a build with `antialias: false` (or with the one-line mutation) to
 * record the un-antialiased counts, then as a gate. The gate asserts the hard-
 * step count dropped by at least MIN_DROP, and — the other half of "can it
 * fail" — that the frame did not simply go flat: mean absolute luma gradient
 * must stay within 25% of the baseline, so blurring the whole picture is not a
 * way to pass.
 *
 * It also grades perf-v-02 in the same page, because it already has one: thirty
 * synthetic `resize` events carrying the size the swapchain already has must
 * produce at most ONE `setSize` call.
 *
 *   PIRATES_BR_SERVER_PORT=8091 PIRATES_BR_URL=http://127.0.0.1:3101 \
 *     node scripts/edge-shimmer-probe.mjs [--baseline]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { readPng } from './lib/png-read.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT_URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const BASELINE_PATH = arg('baseline-file', 'test-results/edge-shimmer-baseline.json');
const WRITE_BASELINE = flag('baseline');
const VIEWPORT = { width: 960, height: 540 };
/** A step this big between neighbours is a staircase, not a gradient. */
const STEP = 0.15;
/** The gate: the hard-step count must fall by at least this fraction. */
const MIN_DROP = 0.5;
/** …without the picture going flat: the mean gradient may not drop further. */
const MAX_CONTRAST_LOSS = 0.25;
/** Pin the drawing buffer to the CSS size so the screenshot IS the framebuffer.
 *  0 leaves the tier's own ratio (and the pixel half becomes advisory). */
const PIN_RATIO = parseFloat(arg('ratio', '0'));

let failures = 0;
const pass = (l) => console.log(`  ✓ ${l}`);
const fail = (l, d = '') => { console.error(`  ✗ FAIL: ${l}${d ? `\n     ${d}` : ''}`); failures += 1; };

/**
 * Count hard luma steps in a band, plus the mean |gradient| in the same band.
 *
 * From a PLAYWRIGHT SCREENSHOT, not from `drawImage(canvas)`: the game's
 * context has no `preserveDrawingBuffer`, so a 2D copy of it reads back a
 * cleared buffer and every band scores a flawless, meaningless zero. A
 * screenshot goes through the compositor, which is the frame the player saw.
 */
function measure(png, bands, step) {
  const { width: w, height: h, channels, data } = png;
  const luma = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * channels;
    luma[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  const out = {};
  let flat = true;
  for (const band of bands) {
    const y0 = Math.max(1, Math.floor(band.y0 * h));
    const y1 = Math.min(h - 1, Math.floor(band.y1 * h));
    const x0 = Math.max(1, Math.floor(band.x0 * w));
    const x1 = Math.min(w - 1, Math.floor(band.x1 * w));
    let steps = 0, grad = 0, n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const here = luma[y * w + x];
        const d = band.axis === 'y' ? Math.abs(here - luma[(y - 1) * w + x]) : Math.abs(here - luma[y * w + x - 1]);
        if (d > step) steps += 1;
        grad += d;
        n += 1;
      }
    }
    if (n > 0 && grad / n > 1e-4) flat = false;
    out[band.name] = { steps, meanGrad: n > 0 ? grad / n : 0, pixels: n };
  }
  return { width: w, height: h, bands: out, flat };
}

async function main() {
  console.log(`GL backend: ${describeGl()}`);
  console.log(`URL: ${ROOT_URL}`);
  const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio', '--autoplay-policy=no-user-gesture-required']) });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
    await page.goto(`${ROOT_URL}/?debug&quality=low&governor=off`, { waitUntil: 'commit', timeout: 120_000 });
    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 240_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true, timeout: 120_000 });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    // Settle: the LOD ladder and the shoreline bake both change what is on
    // screen, and a staircase count taken mid-reveal is a count of the reveal.
    await page.evaluate(() => window.__piratesBR?.settleLod?.());
    await page.waitForTimeout(9000);

    // Look flat at the horizon: it puts the sea/sky edge across the middle of
    // the frame and the ship's rigging in the lower third.
    await page.evaluate(() => { window.__piratesBR?.input?.setLook?.(0, 0); });
    if (PIN_RATIO > 0) {
      await page.evaluate((r) => {
        const rend = window.__piratesBR?.renderer;
        if (!rend) return;
        rend.minPixelRatio = r;
        rend.maxPixelRatio = r;
        rend.applyPixelRatio(r, true);
      }, PIN_RATIO);
    }
    await page.waitForTimeout(2500);

    // TWO DIFFERENT FACTS, and the gate needs both. `antialias` is what the
    // client ASKED the context for — that is the fix, and it is graded always.
    // `SAMPLES` is what the backend GRANTED, and a software rasteriser grants
    // 1 no matter what was asked: ANGLE/SwiftShader reports antialias:true and
    // multisamples nothing. There is no staircase to remove on such a backend,
    // so the pixel half of this probe is SKIPPED rather than failed there —
    // failing it would be reporting a fact about the rasteriser as a fact about
    // the game.
    const ctxInfo = await page.evaluate(() => {
      const r = window.__piratesBR?.renderer?.renderer;
      const gl = r?.getContext?.();
      if (!gl) return { antialias: null, samples: null };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { antialias: gl.getContextAttributes?.()?.antialias ?? null, samples: gl.getParameter(gl.SAMPLES) };
    });
    const antialiasOn = ctxInfo.antialias;
    const samples = ctxInfo.samples;
    const bands = [
      { name: 'horizon', axis: 'y', x0: 0.1, x1: 0.9, y0: 0.36, y1: 0.58 },
      { name: 'rigging', axis: 'x', x0: 0.15, x1: 0.85, y0: 0.58, y1: 0.95 },
    ];
    const shot = await page.screenshot({ type: 'png' });
    const now = measure(readPng(shot), bands, STEP);
    if (now.flat) {
      // A blank or uniform frame has no staircase and would pass every drop
      // test ever written. Fail loudly in BOTH modes.
      fail('the frame is flat: no gradient anywhere, so nothing was measured (VACUOUS)');
      return;
    }

    // perf-v-02, in the page we already have.
    const resizeCalls = await page.evaluate(() => {
      const r = window.__piratesBR?.renderer?.renderer;
      if (!r) return null;
      let calls = 0;
      const real = r.setSize.bind(r);
      r.setSize = (...a) => { calls += 1; return real(...a); };
      for (let i = 0; i < 30; i += 1) window.dispatchEvent(new Event('resize'));
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        r.setSize = real;
        resolve(calls);
      })));
    });

    mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    const record = { antialias: antialiasOn, samples, ratio: PIN_RATIO, width: now.width, bands: now.bands, at: new Date().toISOString() };
    if (WRITE_BASELINE) {
      writeFileSync(BASELINE_PATH, JSON.stringify(record, null, 2));
      console.log(`\nBaseline written to ${BASELINE_PATH} (antialias=${antialiasOn}, SAMPLES=${samples}):`);
      for (const [name, b] of Object.entries(now.bands)) {
        console.log(`  ${name}: ${b.steps} hard steps over ${b.pixels} px, mean |grad| ${b.meanGrad.toFixed(4)}`);
      }
      return;
    }

    console.log(`\nEdge shimmer at ?quality=low (context antialias=${antialiasOn}, SAMPLES=${samples})`);
    if (!existsSync(BASELINE_PATH)) {
      fail(`no baseline at ${BASELINE_PATH}`, 'record one on a build with antialias:false — node scripts/edge-shimmer-probe.mjs --baseline');
      return;
    }
    const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    if (base.antialias === true) {
      fail('the baseline was recorded WITH anti-aliasing on', 'a baseline that already has the fix cannot witness it');
    }
    // MEASURED 2026-09-07 and left here so nobody re-derives it: at `low` the
    // drawing buffer is 0.62 of the CSS size and the compositor upscales it,
    // and that bilinear upscale is a stronger low-pass than 4x MSAA. Counted
    // through the composite the staircase barely moves (4775 -> 4774) even with
    // SAMPLES=4 genuinely granted. So the pixel half is graded ONLY against a
    // baseline taken at the same drawing-buffer scale AND at ratio 1, where the
    // screenshot is the framebuffer; otherwise its numbers are printed and the
    // graded rows are the ones that are honest at any ratio — that the tier
    // asked for AA and the backend granted it.
    const oneToOne = base.ratio === 1 && now.width === (base.width ?? -1);
    const multisampled = typeof samples === 'number' && samples > 1 && oneToOne;
    if (!multisampled) {
      console.log(`  ~ SKIPPED (advisory): SAMPLES=${samples}, baseline ratio=${base.ratio ?? 'n/a'}.`);
      console.log('    The staircase count is only meaningful 1:1 with the framebuffer; record a');
      console.log('    baseline with --baseline --ratio 1 on a build with antialias:false to grade it.');
      for (const band of bands) {
        const b = base.bands?.[band.name];
        const n = now.bands[band.name];
        if (b) console.log(`  ~ ${band.name}: ${b.steps} → ${n.steps} hard steps (ungraded, SAMPLES=${samples})`);
      }
    }
    for (const band of multisampled ? bands : []) {
      const b = base.bands?.[band.name];
      const n = now.bands[band.name];
      if (!b) { fail(`baseline has no '${band.name}' band`); continue; }
      if (b.steps < 200) { fail(`baseline '${band.name}' had only ${b.steps} hard steps`, 'too few to grade a 50% drop'); continue; }
      const drop = 1 - n.steps / b.steps;
      const contrastLoss = 1 - n.meanGrad / Math.max(1e-6, b.meanGrad);
      if (drop >= MIN_DROP) pass(`${band.name}: ${b.steps} → ${n.steps} hard steps (−${(drop * 100).toFixed(0)}%)`);
      else fail(`${band.name}: ${b.steps} → ${n.steps} hard steps (−${(drop * 100).toFixed(0)}%, want −${MIN_DROP * 100}%)`);
      if (contrastLoss <= MAX_CONTRAST_LOSS) pass(`${band.name}: the picture kept its contrast (mean |grad| ${b.meanGrad.toFixed(4)} → ${n.meanGrad.toFixed(4)})`);
      else fail(`${band.name}: the edges were blurred away, not resolved (mean |grad| −${(contrastLoss * 100).toFixed(0)}%)`);
    }
    // THE ROW THAT WITNESSES THE FIX AT ANY RATIO: on HEAD this was
    // antialias=false / SAMPLES=1 on every tier.
    if (antialiasOn === true) pass("the 'low' context asked for anti-aliasing");
    else fail("the 'low' context did not ask for anti-aliasing", `getContextAttributes().antialias === ${antialiasOn}`);
    if (typeof samples === 'number' && samples > 1) pass(`…and the backend granted it (SAMPLES=${samples})`);
    else fail(`the backend granted no multisampling (SAMPLES=${samples})`, 'on a real GPU this is the whole fix');

    console.log('\nResize coalescing (perf-v-02)');
    if (resizeCalls === null) fail('no renderer to spy on');
    else if (resizeCalls <= 1) pass(`30 same-size resize events → ${resizeCalls} setSize call(s)`);
    else fail(`30 same-size resize events → ${resizeCalls} setSize calls`, 'want at most 1');

    writeFileSync('test-results/edge-shimmer-latest.json', JSON.stringify(record, null, 2));
    if (errors.length) console.warn(`  (page errors: ${errors.slice(0, 3).join(' | ')})`);
  } finally {
    await browser.close();
  }
}

await main();
if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log('\nEdge shimmer checks passed.');
