#!/usr/bin/env node
// STORM WALL FRAME GATE — the boundary of the ring, graded from pixels.
//
// WHY. This file used to be storm-wall-probe.mjs: it took shots and asserted
// nothing, and the only storm suites with a FAIL path grade spawn safety and
// outrun. Every storm LOOK regression in the 2026-09-01 audit — the night
// inversion (sea brighter than the sky under the wall), the blue sea under a
// slate front — survived eight campaigns because no gate ever read a storm
// frame (storm-18).
//
// WHAT. One ?stormdemo session at ?quality=low, 960x540, pinned map. The camera
// stands inside the ring near the wall and looks out at it, the way the player
// meets it. Two times of day, two band reads per frame (rows 8-32% = sky/wall,
// rows 68-92% = sea, columns 5-95%):
//   • NIGHT (374): sea luma ≤ 1.05 × sky luma — water reflects the sky, it
//     cannot be brighter than what lights it;
//   • NOON storm (854): sea chroma ≤ 1.3 × sky chroma — a slate front does not
//     sit over a blue-saturated sea.
// Ratios, not absolutes, so SwiftShader's tone curve does not move the verdict.
// Thresholds are deliberately generous (verifier note on storm-18).
// PIRATES_BR_STORM_WALL_SHOTS=1 also writes the frames to test-results/storm-wall/.
//
// EVERY READ IS THE MEDIAN OF FIVE CONVERGED, FLASH-FREE FRAMES — see
// gradedFrame. Before that (P.0b), one flat 2,500 ms settle and one shot made
// the verdict a coin flip: gate-0 read 1.26 / 2.65 / 2.50 / 2.43 on the noon
// row at ONE commit. Pinned, two runs of one commit read 2.00× and 2.01×.
//
// RED ON HEAD (2026-09-02, overlays cleared): noon storm sea chroma 39.3 vs sky
// 5.9 (6.67×) — the blue sea under a slate front. Pinned and re-measured
// 2026-09-09 it is 27.9 vs 13.9 (2.01×): improved, still red, still the
// storm-look lane's job. The night row is green at 0.83-0.91× and stays as the
// guard against the inversion.
//
// KNOWN, NOT FIXED HERE: t=854 is labelled "noon" but renders as a dark hour
// (see test-results/storm-wall/noon-inside-near-out.png). The clause it grades
// — sea chroma against sky chroma under the front — is meaningful at any hour,
// but whoever closes the row should check the stand actually shows the wall:
// at 0.9 x r with pitch +0.06 the bank fills the upper half and a bright band
// of open horizon survives underneath it, which is its own coherence question.
//
//   node scripts/run-all-tests.mjs --only storm-wall
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { readPng, bandStats } from './lib/png-read.mjs';

const URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const VIEWPORT = { width: 960, height: 540 };
const SHOTS = process.env.PIRATES_BR_STORM_WALL_SHOTS === '1';
const OUT = 'test-results/storm-wall';
const NIGHT_SEA_OVER_SKY_MAX = 1.05;
const NOON_SEA_CHROMA_RATIO_MAX = 1.3;
const SKY_BAND = [0.08, 0.32];
const SEA_BAND = [0.68, 0.92];

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

async function health() {
  const port = SERVER_PORT ?? '8091';
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}

async function main() {
  const h = await health();
  if (!h) { console.error(`  ✗ FAIL: no game server on :${SERVER_PORT ?? '8091'} (run through scripts/run-all-tests.mjs --only storm-wall)`); process.exit(1); }
  console.log(`Storm wall — GL: ${describeGl()}  quality=low  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  if (SHOTS) mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit']) });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(`${URL}/?${sessionQuery(['debug', 'quality=low', 'stormdemo'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(6_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace?.(true));
    // EVERY OVERLAY OFF, AND THE ONBOARDING CARD DISMISSED (same block as
    // scripts/tools/fill-pass-shots.mjs). The first run of this gate graded the
    // SHIP'S ORDERS card, a dim overlay and the debug panel: "sea > sky" was the
    // panel's white text over the card's dark scrim. A band read is only a
    // storm read when nothing but the world is in the frame.
    await page.evaluate(() => {
      document.getElementById('oc-skip')?.click();
      const style = document.createElement('style');
      style.textContent = '#hud{opacity:0!important;visibility:hidden!important;}'
        + '#onboard-cards,#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}'
        + '#debug-perf-panel{display:none!important;}'
        // THE LIGHTNING SCRIM IS NOT THE WORLD EITHER. #storm-lightning-flash is
        // a full-viewport soft-light div over the canvas whose opacity spikes on
        // every strike; a band read taken during one is a read of the div. It
        // was worth up to +170% on the sky band and +220% on the sea band across
        // the polls that produced this settle (see gradedFrame).
        + '#storm-lightning-flash{display:none!important;}'
        + '#disconnect-overlay,#server-load-chip,[id*="overload"],[class*="overload"]{display:none!important;}';
      document.head.appendChild(style);
    });
    await page.waitForTimeout(800);
    const overlays = await page.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.01;
      return ['oc-card', 'onboarding-card', 'onboard-cards', 'debug-perf-panel', 'hud', 'disconnect-overlay', 'storm-lightning-flash'].filter((id) => vis(document.getElementById(id)));
    });
    expect(`no UI overlay left in the frame (${overlays.length ? overlays.join(', ') : 'clean'})`, overlays.length === 0);
    const storm = await page.evaluate(() => {
      const st = window.__piratesBR.state.storm;
      return { cx: st.centerX, cz: st.centerZ, r: st.safeRadius, phase: st.phase };
    });
    expect(`storm state readable (centre ${storm.cx?.toFixed(0)},${storm.cz?.toFixed(0)} r ${storm.r?.toFixed(0)} phase ${storm.phase})`, Number.isFinite(storm.r) && storm.r > 50);

    // Inside the ring on the +X radius, looking +X: the wall is dead ahead and
    // its tangent runs across the frame. Same placement as the old probe's
    // '02-inside-near-out', where the inversion was reported.
    const OUTWARD = Math.PI * 0.5;
    const look = async (mult, y, yaw, pitch) => page.evaluate(([p, ya, pi]) => window.__piratesBR.enableFreeCam(p[0], p[1], p[2], ya, pi), [[storm.cx + storm.r * mult, y, storm.cz], yaw, pitch]);
    const shot = async (name) => {
      await page.evaluate(() => document.getElementById('disconnect-overlay')?.remove());
      const buf = await page.screenshot({ type: 'png', timeout: 180_000 });
      if (SHOTS && name) writeFileSync(`${OUT}/${name}.png`, buf);
      const png = readPng(buf);
      return { sky: bandStats(png, SKY_BAND[0], SKY_BAND[1]), sea: bandStats(png, SEA_BAND[0], SEA_BAND[1]) };
    };
    const bolt = () => page.evaluate(() => Number(window.__piratesBR.envFx?.debugBoltEnvelope?.() ?? 0));

    // ── NO STRIKES WHILE THE SHUTTER IS OPEN ──────────────────────────────
    // ?stormdemo rolls its own bolt every 0.56-1.92 s (EnvironmentFx keeps the
    // local roll because the preview has no server behind it), and a screenshot
    // on the software rasteriser is seconds. Rejecting flashed frames alone was
    // therefore not enough: 13 of 18 attempts at this stand were rejected and
    // the read never converged. So the demo's own countdown is pinned past the
    // end of the run — the branch fires only when lightningTimer falls through
    // zero — and the strike already in flight is allowed its 0.45 s to finish.
    // Nothing about the STORM is pinned by this; only the strobe on top of it,
    // which is not what either cap grades.
    const pinned = await page.evaluate(() => {
      const fx = window.__piratesBR.envFx;
      if (!fx || typeof fx.lightningTimer !== 'number') return false;
      const hold = () => { fx.lightningTimer = 1e6; requestAnimationFrame(hold); };
      hold();
      return true;
    });
    await page.waitForTimeout(1_500);
    expect('lightning pinned off for the read (envFx.lightningTimer held) and no strike burning',
      pinned && (await bolt()) === 0,
      'a strobe frame would be graded as the storm look — this is what made the gate a coin flip');
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    /**
     * ONE GRADED READ = THE MEDIAN OF FIVE CONVERGED, FLASH-FREE FRAMES.
     *
     * The old settle was setDayNightOverride + settleLod + a flat 2,500 ms, and
     * one shot. Both halves of that were wrong, and gate-0 recorded the result
     * as a coin flip (night sea/sky 1.49 / 1.02 / 1.34 / 1.08 on ONE commit;
     * noon chroma 1.26 / 2.65 / 2.50 / 2.43) without being able to say why.
     * Polled at this exact placement on 2026-09-09 it is both of these:
     *   • LIGHTNING. Strikes fire continuously under ?stormdemo. A frame taken
     *     during one read sky 89.1 luma against 32.2 unflashed and sea 118.4
     *     against 28.6 — the shader flash on the bank AND the soft-light div
     *     (now hidden above). Two of six polls at each hour were flashed.
     *   • THE SETTLE HAS NOT LANDED AT 2,500 ms. On SwiftShader at single-digit
     *     fps the sea band read 98.2, then 30.1, then 27.5 luma over the three
     *     polls after the override; the storm/light lerps need ~4 s of frames.
     * So: reject any frame with a strike burning either side of the shutter,
     * wait for two consecutive accepted frames to agree on the sky band, then
     * take five more and grade the median of each statistic. A median over
     * accepted frames cannot be carried by one lucky frame in either direction,
     * which is the property the thresholds below have never had. Thresholds are
     * untouched; this changes what is measured, not what is allowed.
     */
    const gradedFrame = async (name, sec) => {
      await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
      await page.evaluate(() => window.__piratesBR.settleLod?.());
      await page.waitForTimeout(2_500);
      const accepted = [];
      let converged = false;
      let prevSky = null;
      let flashed = 0;
      for (let i = 0; i < 18 && accepted.length < 5; i++) {
        const before = await bolt();
        const f = await shot(accepted.length === 0 ? name : null);
        const after = await bolt();
        if (before > 0.001 || after > 0.001) { flashed += 1; await page.waitForTimeout(400); continue; }
        if (!converged) {
          if (prevSky !== null && Math.abs(f.sky.luma - prevSky) <= Math.max(0.6, prevSky * 0.04)) converged = true;
          prevSky = f.sky.luma;
          if (!converged) { await page.waitForTimeout(700); continue; }
        }
        accepted.push(f);
        await page.waitForTimeout(400);
      }
      expect(`${name}: ${accepted.length} converged flash-free frames graded (${flashed} rejected for lightning)`,
        converged && accepted.length >= 3,
        'the storm look never held still long enough to be graded — do not read a verdict off this run');
      const at = (pick) => median(accepted.map(pick));
      return {
        n: accepted.length,
        sky: { luma: at((f) => f.sky.luma), chroma: at((f) => f.sky.chroma) },
        sea: { luma: at((f) => f.sea.luma), chroma: at((f) => f.sea.chroma) },
      };
    };

    await look(0.9, 7, OUTWARD, 0.06);
    const night = await gradedFrame('night-inside-near-out', 374);
    console.log(`  night (median of ${night.n}): sky luma ${night.sky.luma.toFixed(1)} chroma ${night.sky.chroma.toFixed(1)} | sea luma ${night.sea.luma.toFixed(1)} chroma ${night.sea.chroma.toFixed(1)}`);
    expect(`night: sea luma ${night.sea.luma.toFixed(1)} ≤ ${NIGHT_SEA_OVER_SKY_MAX}× sky luma ${night.sky.luma.toFixed(1)} (${(night.sea.luma / Math.max(1, night.sky.luma)).toFixed(2)}×)`,
      night.sea.luma <= NIGHT_SEA_OVER_SKY_MAX * night.sky.luma, 'inversion: the sea under the storm wall is brighter than the sky that lights it');

    const noon = await gradedFrame('noon-inside-near-out', 854);
    console.log(`  noon (median of ${noon.n}):  sky luma ${noon.sky.luma.toFixed(1)} chroma ${noon.sky.chroma.toFixed(1)} | sea luma ${noon.sea.luma.toFixed(1)} chroma ${noon.sea.chroma.toFixed(1)}`);
    expect(`noon storm: sea chroma ${noon.sea.chroma.toFixed(1)} ≤ ${NOON_SEA_CHROMA_RATIO_MAX}× sky chroma ${noon.sky.chroma.toFixed(1)} (${(noon.sea.chroma / Math.max(1, noon.sky.chroma)).toFixed(2)}×)`,
      noon.sea.chroma <= NOON_SEA_CHROMA_RATIO_MAX * Math.max(1, noon.sky.chroma), 'a saturated blue sea under a slate front');
    expect('frames are not blank (sky or sea band has signal)', night.sky.luma + night.sea.luma + noon.sky.luma + noon.sea.luma > 8);

    expect('no page errors', errors.length === 0, errors.join(' | '));
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(`  ✗ FAIL: ${e?.stack ?? e}`); process.exit(1); });
