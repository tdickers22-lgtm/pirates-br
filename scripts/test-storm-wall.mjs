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
// RED ON HEAD (2026-09-02, overlays cleared): noon storm sea chroma 39.3 vs sky
// 5.9 (6.67×) — the blue sea under a slate front. The night row reads 0.56× at
// this placement and is green; it stays as the guard against the inversion.
// Green on the noon row is the storm-look lane's job.
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
        + '#disconnect-overlay,#server-load-chip,[id*="overload"],[class*="overload"]{display:none!important;}';
      document.head.appendChild(style);
    });
    await page.waitForTimeout(800);
    const overlays = await page.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.01;
      return ['oc-card', 'onboarding-card', 'onboard-cards', 'debug-perf-panel', 'hud', 'disconnect-overlay'].filter((id) => vis(document.getElementById(id)));
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
    const settle = async (sec) => {
      await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
      await page.evaluate(() => window.__piratesBR.settleLod?.());
      await page.waitForTimeout(2_500);
    };
    const frame = async (name) => {
      await page.evaluate(() => document.getElementById('disconnect-overlay')?.remove());
      const buf = await page.screenshot({ type: 'png', timeout: 180_000 });
      if (SHOTS) writeFileSync(`${OUT}/${name}.png`, buf);
      const png = readPng(buf);
      return { sky: bandStats(png, SKY_BAND[0], SKY_BAND[1]), sea: bandStats(png, SEA_BAND[0], SEA_BAND[1]) };
    };

    await look(0.9, 7, OUTWARD, 0.06);
    await settle(374);
    const night = await frame('night-inside-near-out');
    console.log(`  night: sky luma ${night.sky.luma.toFixed(1)} chroma ${night.sky.chroma.toFixed(1)} | sea luma ${night.sea.luma.toFixed(1)} chroma ${night.sea.chroma.toFixed(1)}`);
    expect(`night: sea luma ${night.sea.luma.toFixed(1)} ≤ ${NIGHT_SEA_OVER_SKY_MAX}× sky luma ${night.sky.luma.toFixed(1)} (${(night.sea.luma / Math.max(1, night.sky.luma)).toFixed(2)}×)`,
      night.sea.luma <= NIGHT_SEA_OVER_SKY_MAX * night.sky.luma, 'inversion: the sea under the storm wall is brighter than the sky that lights it');

    await settle(854);
    const noon = await frame('noon-inside-near-out');
    console.log(`  noon:  sky luma ${noon.sky.luma.toFixed(1)} chroma ${noon.sky.chroma.toFixed(1)} | sea luma ${noon.sea.luma.toFixed(1)} chroma ${noon.sea.chroma.toFixed(1)}`);
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
