#!/usr/bin/env node
/**
 * THE GOVERNOR, IN A REAL BROWSER, WITH A REAL GL CONTEXT.
 *
 * scripts/test-frame-governor.mjs proves the CONTROLLER — step response,
 * hysteresis, clamps, recovery, floor mode — against simulated machines, which
 * is the only way to grade a time-domain response on a rasteriser that draws
 * this scene at one to five frames a second. It cannot prove the two things
 * that only exist once there is a canvas underneath:
 *
 *   1. that the controller is actually WIRED — that a frame time going over
 *      budget in the game loop reaches the scalar and comes back out as a
 *      renderer setting, rather than being computed and dropped;
 *   2. that `setPixelRatio` does what everyone assumes it does — that changing
 *      the ratio changes the DRAWING BUFFER, which is the only reason the whole
 *      resolution lever is worth anything. A ratio that moves while the
 *      framebuffer does not is a number in a status line.
 *
 * …and one thing it must prove NEGATIVELY: that an unchanged ratio does not
 * re-enter `setSize`. That reallocation is §9 lever 7 of the cost model —
 * 19,488 ms of `WebGLRenderer.setSize` in a 180-second capture in which no
 * window was ever resized. A guard against it is invisible in every other test
 * in this repo, because nothing else counts the calls.
 *
 * …and one it could not prove at all until the clamp was found:
 *
 *   3. that the controller can SEE A HITCH. `Game.frame` clamps dt to 50 ms for
 *      the integrator and used to hand that same clamped number to the
 *      governor, which put a hard 50 ms ceiling on the median and the p95 of the
 *      one thing in the build that exists to react to stalls. Nothing was
 *      broken-looking about it: the ratios still fired, the ladder still
 *      stepped, the status line still printed. It just could not tell a 50 ms
 *      frame from a three-second one. So the last phase here injects long
 *      frames of a KNOWN length and asks the governor what it saw, against what
 *      the page independently measured. See THE HITCH IS VISIBLE below.
 *
 * SYNTHETIC LOAD, ON PURPOSE. The gate must engage the same way on a machine
 * that would otherwise hold 60fps, so it burns a fixed slice of every animation
 * frame from an init script. That is a load with a known sign — over budget —
 * which is what an engagement assertion needs; measuring whether THIS machine
 * happens to be slow enough today is not a test.
 *
 * MUTATION PROOF: `--mutate` loads the same session with the governor pinned
 * off. Every engagement assertion must go red. A gate that cannot fail is not
 * a gate.
 *
 * Requires the dev stack up (vite :3000, server :8090). Never :8080 — this
 * machine's content filter corrupts every websocket on that port.
 *
 *   node scripts/test-frame-governor-live.mjs
 *   node scripts/test-frame-governor-live.mjs --mutate        # must FAIL
 */
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const ROOT_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/').replace(/\/$/, '');
const MUTATE = has('mutate');
/** Milliseconds of synchronous work injected into every animation frame. Well
 *  over the 16.67 ms budget on its own, so the sign of the load is not in
 *  question on any backend. */
const LOAD_MS = parseInt(arg('load', '30'), 10);
/** The injected stall, in ms. Comfortably above the 50 ms simulation clamp on
 *  any backend, so a governor reading the clamped dt cannot produce it and one
 *  reading real time cannot miss it. */
const HITCH_MS = parseInt(arg('hitch', '400'), 10);
/** …on one frame in this many, so the hitches land in the p95 tail rather than
 *  becoming the median. The window is 45 frames; 1-in-5 puts roughly nine of
 *  them in it, which is well clear of the top 5%. */
const HITCH_EVERY = 5;
const VIEWPORT = { width: 960, height: 540 };
/** The `low` tier's resolution floor (Renderer.minPixelRatio). Written out
 *  rather than read from the app so a regression that lowers the floor is a
 *  failure here and not a silently-agreeing pair of numbers. */
const LOW_TIER_PIXEL_RATIO_FLOOR = 0.44;
const LOW_TIER_PIXEL_RATIO_CEILING = 0.62;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function url() {
  const params = new URLSearchParams();
  params.set('debug', '1');
  params.set('quality', 'low');
  // `?quality=` pins the tier and therefore turns the governor OFF by default
  // (a census must not have its resolution moved underneath it). This gate is
  // the one that wants it back.
  params.set('governor', MUTATE ? 'off' : 'on');
  return `${ROOT_URL}/?${params.toString()}`;
}

async function main() {
  console.log(`GL backend: ${describeGl()}`);
  console.log(`URL: ${url()}`);
  if (MUTATE) console.log('MUTATION: governor pinned off — every engagement assertion below must fail.\n');

  const browser = await chromium.launch({
    headless: true,
    args: browserArgs(['--mute-audio', '--autoplay-policy=no-user-gesture-required']),
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

    // The synthetic load, armed before any application code runs. A fresh rAF
    // is scheduled from inside the callback so it survives the app installing
    // its own loop.
    //
    // It also keeps an INDEPENDENT record of how long each animation frame
    // really was — the same quantity `Game.frame` computes as `now -
    // lastFrameTime`, measured by something that has never heard of the
    // governor. That witness is what turns "the governor reports 400 ms" from a
    // number into a claim that can be wrong.
    //
    // The stall injector is armed but idle (`__hitchEvery = 0`): every
    // assertion before the last phase is about the STEADY frame, and dropping
    // 400 ms stalls into the engagement window would be grading two things at
    // once.
    await page.addInitScript(({ ms, hitchMs }) => {
      window.__hitchEvery = 0;
      window.__hitchMs = hitchMs;
      window.__rafMs = [];
      let frames = 0;
      let last = performance.now();
      const spin = (until) => { while (performance.now() < until) { Math.sqrt(Math.random()); } };
      const burn = () => {
        const t = performance.now();
        // Recorded BEFORE this frame's burn: the delta is the length of the
        // frame that just finished, burn included.
        window.__rafMs.push(t - last);
        if (window.__rafMs.length > 400) window.__rafMs.shift();
        last = t;
        frames += 1;
        spin(t + ms);
        if (window.__hitchEvery > 0 && frames % window.__hitchEvery === 0) {
          spin(performance.now() + window.__hitchMs);
        }
        requestAnimationFrame(burn);
      };
      requestAnimationFrame(burn);
    }, { ms: LOAD_MS, hitchMs: HITCH_MS });

    await page.goto(url(), { waitUntil: 'commit', timeout: 120_000 });
    await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 240_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true, timeout: 120_000 });
    await page.waitForFunction(
      () => window.__piratesBR?.state?.phase === 'playing',
      undefined,
      { timeout: 300_000 },
    );

    // The load guard suspends sampling until the world has arrived plus a tail,
    // by design — a frame spent building an island measures the build. So wait
    // out the suspension before asking whether the governor engaged.
    await page.waitForFunction(
      () => window.__piratesBR?.renderer?.getGovernorStatus?.() != null,
      undefined,
      { timeout: 60_000 },
    );

    const opening = await page.evaluate(() => {
      const r = window.__piratesBR.renderer;
      const gl = r.renderer.getContext();
      return {
        status: r.getGovernorStatus(),
        drawingBufferWidth: gl.drawingBufferWidth,
        drawingBufferHeight: gl.drawingBufferHeight,
        cssWidth: r.renderer.domElement.clientWidth,
      };
    });

    console.log('\nCONTRACT — the governor is running and can say so');
    expect(
      MUTATE ? 'the governor reports itself OFF under the mutation' : 'the governor is enabled',
      opening.status.enabled === !MUTATE,
      JSON.stringify(opening.status),
    );
    expect('…and prints a label naming the tier and the resolution it is running',
      /^(Auto — )?(low|balanced|high)( \(pinned\))?, \d\.\d\d× resolution/.test(opening.status.label),
      opening.status.label);
    expect('the drawing buffer matches the pixel ratio it claims to be running',
      Math.abs(opening.drawingBufferWidth - Math.round(opening.cssWidth * opening.status.pixelRatio)) <= 1,
      `buffer ${opening.drawingBufferWidth}px, css ${opening.cssWidth}px × ratio ${opening.status.pixelRatio}`);

    // ── ENGAGEMENT ─────────────────────────────────────────────────────────
    // Poll until the scalar moves, or the window runs out. Polling rather than
    // sleeping a fixed time because a settled scalar is the event, and on a
    // rasteriser a frame can be seconds long.
    console.log('\nENGAGEMENT — a frame over budget reaches the renderer');
    const startedAt = Date.now();
    let engaged = null;
    while (Date.now() - startedAt < 90_000) {
      const s = await page.evaluate(() => {
        const r = window.__piratesBR.renderer;
        const gl = r.renderer.getContext();
        return {
          status: r.getGovernorStatus(),
          budgetScale: r.getFrameBudgetScale(),
          drawingBufferWidth: gl.drawingBufferWidth,
          cssWidth: r.renderer.domElement.clientWidth,
        };
      });
      if (s.status.scalar < opening.status.scalar - 1e-6) { engaged = s; break; }
      await sleep(1000);
    }
    const settled = engaged ?? await page.evaluate(() => {
      const r = window.__piratesBR.renderer;
      const gl = r.renderer.getContext();
      return {
        status: r.getGovernorStatus(),
        budgetScale: r.getFrameBudgetScale(),
        drawingBufferWidth: gl.drawingBufferWidth,
        cssWidth: r.renderer.domElement.clientWidth,
      };
    });

    expect('a sustained over-budget frame moves the quality scalar down',
      settled.status.scalar < opening.status.scalar - 1e-6,
      `scalar ${settled.status.scalar} (opened at ${opening.status.scalar}), `
      + `median ${settled.status.medianMs?.toFixed?.(1) ?? '?'}ms`);
    expect('…and the pixel ratio it produces actually resized the DRAWING BUFFER',
      settled.drawingBufferWidth < opening.drawingBufferWidth,
      `${opening.drawingBufferWidth}px → ${settled.drawingBufferWidth}px`);
    expect('…to exactly the ratio the status line claims',
      Math.abs(settled.drawingBufferWidth - Math.round(settled.cssWidth * settled.status.pixelRatio)) <= 1,
      `buffer ${settled.drawingBufferWidth}px vs css ${settled.cssWidth} × ${settled.status.pixelRatio}`);
    expect('…and the shared streaming signal backed off with it',
      settled.budgetScale < 1,
      `frame budget scale ${settled.budgetScale}`);

    console.log('\nCLAMPS — the picture is never taken apart to reach a number');
    expect(`resolution never goes below the tier floor (${LOW_TIER_PIXEL_RATIO_FLOOR})`,
      settled.status.pixelRatio >= LOW_TIER_PIXEL_RATIO_FLOOR - 1e-6,
      `ratio ${settled.status.pixelRatio}`);
    expect(`…and never above the tier ceiling (${LOW_TIER_PIXEL_RATIO_CEILING})`,
      settled.status.pixelRatio <= LOW_TIER_PIXEL_RATIO_CEILING + 1e-6,
      `ratio ${settled.status.pixelRatio}`);
    expect('the HUD is still on screen — nothing legible is a lever',
      await page.evaluate(() => {
        const hud = document.getElementById('hud');
        return !!hud && getComputedStyle(hud).display !== 'none';
      }));

    // ── THE REALLOCATION GUARD (§9 lever 7) ────────────────────────────────
    // Count the calls, not the effect: a redundant setPixelRatio has no visible
    // effect at all, which is exactly why it survived for months.
    console.log('\nNO REDUNDANT SWAPCHAIN REALLOCATION');
    await page.evaluate(() => {
      const r = window.__piratesBR.renderer.renderer;
      window.__ratioCalls = 0;
      const original = r.setPixelRatio.bind(r);
      r.setPixelRatio = (v) => { window.__ratioCalls += 1; return original(v); };
    });
    // Let a run of frames go by. The governor is settled or settling; either
    // way, the calls it makes must be exactly the steps it takes, and never one
    // per frame.
    const before = await page.evaluate(() => window.__piratesBR.renderer.getGovernorStatus().scalar);
    await sleep(12_000);
    const after = await page.evaluate(() => ({
      calls: window.__ratioCalls,
      scalar: window.__piratesBR.renderer.getGovernorStatus().scalar,
    }));
    const steps = Math.abs(after.scalar - before) > 1e-9 ? 'some' : 'no';
    expect('the ratio is written only when it changes, never once per frame',
      after.calls <= 6,
      `${after.calls} setPixelRatio calls in 12s with ${steps} scalar movement`);

    // ── THE HITCH IS VISIBLE ───────────────────────────────────────────────
    // Arm the injector, throw away both windows, and let a fresh 45 frames go
    // by with one frame in five deliberately HITCH_MS long. Then ask the two
    // witnesses the same question.
    //
    // A governor fed the simulation's clamped dt answers "50 ms" here whatever
    // is injected — that is the failure this phase exists to catch, and it is
    // invisible to every other assertion in this file, all of which pass just
    // as happily against a ceiling as against a measurement.
    console.log('\nTHE HITCH IS VISIBLE — the controller reads real frame time, not the sim clamp');
    await page.evaluate((every) => {
      window.__rafMs.length = 0;
      window.__hitchEvery = every;
    }, HITCH_EVERY);

    const hitchDeadline = Date.now() + 180_000;
    let hitch = null;
    while (Date.now() < hitchDeadline) {
      await sleep(2000);
      const s = await page.evaluate(() => {
        const raf = window.__rafMs.slice(-45);
        const sorted = raf.slice().sort((a, b) => a - b);
        const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0);
        return {
          status: window.__piratesBR.renderer.getGovernorStatus(),
          rafSamples: raf.length,
          rafMedian: at(0.5),
          rafP95: at(0.95),
          rafMax: sorted.length ? sorted[sorted.length - 1] : 0,
        };
      });
      // Both windows full, and both describing the same 45 frames.
      if (s.rafSamples >= 45 && s.status.samples >= 40) { hitch = s; break; }
    }

    const detail = hitch
      ? `governor: ${hitch.status.samples} samples, median ${hitch.status.medianMs.toFixed(1)}ms, `
        + `p95 ${hitch.status.p95Ms.toFixed(1)}ms | page rAF: median ${hitch.rafMedian.toFixed(1)}ms, `
        + `p95 ${hitch.rafP95.toFixed(1)}ms, max ${hitch.rafMax.toFixed(1)}ms`
      : 'the governor window never filled — no reading was taken';

    // Printed on the way past, not only on failure: this is the reading the
    // whole phase is about, and a green tick that hides its own numbers is how
    // a 50 ms ceiling survived two passes.
    console.log(`    ${detail}`);
    expect('the governor filled a window while stalls were being injected',
      hitch != null, detail);
    // 55 > the 50 ms clamp. Not a threshold about this machine: it is the exact
    // number a clamped feed can never exceed.
    expect(`its p95 is above the 50ms simulation clamp (injected stall ${HITCH_MS}ms)`,
      hitch != null && hitch.status.p95Ms > 55, detail);
    // The page measured the same frames. Half is a wide band on purpose — the
    // two windows are 45 frames each but not the same 45 — and it is still an
    // order of magnitude tighter than the gap between 50 ms and a real stall.
    expect('…and it agrees with what the page independently measured',
      hitch != null && hitch.status.p95Ms >= hitch.rafP95 * 0.5 && hitch.status.p95Ms <= hitch.rafP95 * 2,
      detail);
    // The whole reason there are two statistics: a spiky machine and a
    // uniformly slow one want opposite responses. Under the clamp both numbers
    // saturate at 50 and the p95 stops carrying any information at all.
    // The whole reason there are two statistics: a spiky machine and a
    // uniformly slow one want opposite responses. Under the clamp both numbers
    // saturate at 50 and the p95 stops carrying any information at all. Graded
    // against the INJECTED stall rather than a ratio, so it does not quietly
    // become a reading of how fast this laptop happens to be.
    expect('…and the p95 separates from the median by the stall that was injected',
      hitch != null && hitch.status.p95Ms - hitch.status.medianMs >= HITCH_MS * 0.5,
      detail);

    expect('no page errors', pageErrors.length === 0, pageErrors.join('\n'));
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nLive frame-governor checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
