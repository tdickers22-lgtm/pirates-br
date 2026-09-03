#!/usr/bin/env node
// HORIZON LUMINANCE GATE — is the ocean lit by the same sky it dissolves into?
//
// WHY. The ocean is the one large surface outside three's light system: its
// palette is a set of noon albedo constants with scalar dims bolted on for
// night, twilight and storm (OCEAN-01 / graphics-03). Every re-tune of the
// "white sea under a black sky" inversion moved a constant, and the inversion
// came back, because nothing in the battery ever read the sea and the sky in
// the same frame and compared them. test-storm-wall does that for the STORM
// wall; this gate does it for fair weather, for the low tier, and for the
// wiring that makes the sea a lit surface instead of a lantern.
//
// WHAT. ONE headless browser, 960x540, two sessions on the pinned map, run one
// after the other in the same browser (machine protection: never two at once).
// The camera stands on open water — the grid point furthest from every island
// centre, so nothing but sea and sky is in frame — with pitch 0, which puts the
// horizon on the middle row.
//
//   ?quality=low      the Air's own tier, and the one with no composer: the
//                     material has to tone-map and sRGB-encode itself or it
//                     writes raw linear next to a tone-mapped sky.
//   ?quality=balanced the tier with PostFx, where OutputPass tone-maps
//                     everything uniformly. TWO things are graded only here:
//                     the night inversion (on low the missing tone map DARKENS
//                     the sea and hides it — measured 0.92x on HEAD at low
//                     against the r3-85 inversion at balanced), and the proof
//                     that the chunks added for the low tier expand to NOTHING
//                     here, i.e. balanced pixels are unchanged by them.
//
//   WIRING (read off the live material, no pixels):
//     • u_fogDensity exists and EQUALS scene.fog.density — land and sea cannot
//       agree on fog while each owns its own curve (graphics-21);
//     • the authored fragment source uses three's Gaussian form
//       (u_fogDensity*u_fogDensity*d*d) and a view-space depth, not a private
//       exponential over Euclidean distance (graphics-21 + graphics-27);
//     • the EXPANDED fragment source (gl.getShaderSource of the linked
//       program) tone-maps and sRGB-encodes on the low tier, where there is no
//       composer to do it for the material (graphics-26);
//     • u_keyLight / u_ambient / u_moonness exist, and after dark u_sunDir is
//       the ACTIVE light (the moon), not the below-horizon sun (graphics-15).
//
//   PIXELS (luma ratios, never absolutes, so SwiftShader's curve cannot move
//   the verdict):
//     • NOON junction (rows 40-47% sky vs 53-60% sea): 0.80 ≤ sea/sky ≤ 1.25.
//       On the low tier today the sea is written raw-linear into an sRGB buffer
//       while the sky above it is tone-mapped, so the junction has a step in it.
//     • NIGHT body (rows 8-32% sky vs 68-92% sea): sea ≤ 1.30 × sky. This is
//       the inversion itself: a surface cannot out-glow what lights it.
//     • NIGHT moon path (camera yawed to the moon azimuth, moon low): the centre
//       columns of the sea band ≥ 1.50 × the flanks. Today the ocean is handed
//       the sun after dark, so sunUp is 0 and there is no glitter at all.
//
// PIRATES_BR_HORIZON_SHOTS=1 also writes the frames to test-results/horizon/.
//
//   node scripts/run-all-tests.mjs --only horizon-luminance
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { readPng, bandStats } from './lib/png-read.mjs';

const URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const VIEWPORT = { width: 960, height: 540 };
const SHOTS = process.env.PIRATES_BR_HORIZON_SHOTS === '1';
const OUT = 'test-results/horizon';

const JUNCTION_MIN = 0.80;
const JUNCTION_MAX = 1.25;
const NIGHT_BODY_MAX = 1.30;
const GLITTER_MIN = 1.50;
// Full night (nightAmount 1.0) with the moon still LOW: cycle 0.76 of the
// 960 s lap puts the anti-sun at y≈0.43, so there is a moon azimuth to yaw to.
// The obvious 374 s is local midnight — the moon is at the zenith, the glitter
// path has no direction, and the read is meaningless.
const NIGHT_SECONDS = 278;
// Local midnight on the same lap: the darkest sky of the match.
const MIDNIGHT_SECONDS = 374;
// Sea rows the glitter path crosses at pitch 0 from 12 m of eye height.
const GLITTER_ROWS = [0.55, 0.75];

const SKY_BAND = [0.08, 0.32];
const SEA_BAND = [0.68, 0.92];
const SKY_JUNCTION = [0.40, 0.47];
const SEA_JUNCTION = [0.53, 0.60];

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
  if (!h) { console.error(`  ✗ FAIL: no game server on :${SERVER_PORT ?? '8091'} (run through scripts/run-all-tests.mjs --only horizon-luminance)`); process.exit(1); }
  console.log(`Horizon luminance — GL: ${describeGl()}  quality=low  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  if (SHOTS) mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit']) });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

    /** Join a solo match at `quality` and strip everything that is not world. */
    const session = async (quality) => {
      await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${quality}`])}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
      await page.waitForTimeout(6_000);
      await page.evaluate(() => window.__piratesBR.setBotPeace?.(true));
      // Every overlay off and the onboarding card dismissed — a band read is only
      // a sea/sky read when nothing but the world is in the frame (the same block
      // test-storm-wall uses, for the same reason: its first run graded a scrim).
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
      expect(`[${quality}] no UI overlay left in the frame (${overlays.length ? overlays.join(', ') : 'clean'})`, overlays.length === 0);
    };

    await session('low');

    // Open water: the coarse grid point whose nearest island edge is furthest
    // away. Deterministic on the pinned seed, and it keeps land out of the sea
    // band so the read is water, not a coastline. THE FIRST RUN OF THIS GATE
    // stood at (0,0) — inside an island — and read a terrain silhouette as
    // "sky", which turned a 0.92x sea/sky ratio into a 10.1x inversion that was
    // not there.
    const stand = await page.evaluate(() => {
      const islands = window.__piratesBR.state?.islands ?? [];
      let best = { x: 0, z: 0, clear: -1 };
      for (let x = -900; x <= 900; x += 60) {
        for (let z = -900; z <= 900; z += 60) {
          let clear = 1e9;
          for (const i of islands) clear = Math.min(clear, Math.hypot(i.position.x - x, i.position.z - z) - (i.radius ?? 60));
          if (clear > best.clear) best = { x, z, clear };
        }
      }
      return best;
    });
    expect(`open-water stand found (${stand.x}, ${stand.z}), nearest land ${stand.clear.toFixed(0)} m`, stand.clear > 300);

    const settle = async (sec) => {
      await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
      await page.evaluate(() => window.__piratesBR.settleLod?.());
      await page.waitForTimeout(2_500);
    };
    const look = async (yaw) => page.evaluate(([p, ya]) => window.__piratesBR.enableFreeCam(p[0], p[1], p[2], ya, 0), [[stand.x, 12, stand.z], yaw]);
    const frame = async (name) => {
      await page.evaluate(() => document.getElementById('disconnect-overlay')?.remove());
      const buf = await page.screenshot({ type: 'png', timeout: 180_000 });
      if (SHOTS) writeFileSync(`${OUT}/${name}.png`, buf);
      return readPng(buf);
    };

    // ── NOON, low tier: the sea/sky junction must not have a step in it ──────
    await look(0.6);
    await settle(854);
    const noon = await frame('noon-open-sea');
    const nSky = bandStats(noon, SKY_JUNCTION[0], SKY_JUNCTION[1]);
    const nSea = bandStats(noon, SEA_JUNCTION[0], SEA_JUNCTION[1]);
    const jr = nSea.luma / Math.max(1, nSky.luma);
    console.log(`  noon junction: sky luma ${nSky.luma.toFixed(1)} | sea luma ${nSea.luma.toFixed(1)} → ${jr.toFixed(2)}×`);
    expect(`noon low tier: sea/sky junction ${jr.toFixed(2)}× within ${JUNCTION_MIN}-${JUNCTION_MAX}`,
      jr >= JUNCTION_MIN && jr <= JUNCTION_MAX,
      'the low tier has no composer, so an un-tone-mapped ocean steps away from the sky it must dissolve into');

    // ── WIRING: read the live material and its linked program ───────────────
    const readWiring = () => page.evaluate(() => {
      const g = window.__piratesBR;
      const mat = g.ocean?.material;
      if (!mat) return { error: 'no ocean material' };
      const u = mat.uniforms;
      const src = String(mat.fragmentShader ?? '');
      const renderer = g.renderer;
      const gl = renderer.renderer?.getContext?.() ?? null;
      const programs = renderer.renderer?.info?.programs ?? [];
      const prog = programs.find?.((p) => p.name === mat.name);
      let expanded = '';
      try { if (gl && prog?.fragmentShader) expanded = String(gl.getShaderSource(prog.fragmentShader) ?? ''); } catch { /* ignore */ }
      const fog = renderer.scene?.fog ?? null;
      const L = renderer.activeLightDir;
      const sd = u.u_sunDir?.value;
      return {
        hasFogDensity: !!u.u_fogDensity,
        fogDensity: u.u_fogDensity?.value ?? null,
        sceneFogDensity: fog?.density ?? null,
        gaussian: /u_fogDensity\s*\*\s*u_fogDensity/.test(src),
        viewDepth: /viewMatrix\s*\*\s*vec4\(\s*v_worldPos/.test(src) || /v_fogDepth/.test(src),
        materialName: mat.name || '',
        expandedLen: expanded.length,
        toneMapped: /toneMapping\s*\(|ACESFilmic|LinearToneMapping|CineonToneMapping/.test(expanded),
        srgbOut: /sRGBTransferOETF|LinearTosRGB|linearToOutputTexel/.test(expanded),
        hasKey: !!u.u_keyLight, hasAmbient: !!u.u_ambient, hasMoonness: !!u.u_moonness,
        moonness: u.u_moonness?.value ?? null,
        sunDir: sd ? [sd.x, sd.y, sd.z] : null,
        activeLightDir: L ? [L.x, L.y, L.z] : null,
      };
    });
    const wiring = await readWiring();
    expect('ocean material reachable', !wiring.error, wiring.error ?? '');
    expect(`ocean fog density is the SCENE's (${wiring.fogDensity} vs ${wiring.sceneFogDensity})`,
      wiring.hasFogDensity && wiring.sceneFogDensity !== null && Math.abs(wiring.fogDensity - wiring.sceneFogDensity) < 1e-9,
      'land and sea cannot agree on fog while each owns its own curve');
    expect('ocean fog uses three\'s Gaussian form over a view depth',
      wiring.gaussian && wiring.viewDepth,
      `gaussian=${wiring.gaussian} viewDepth=${wiring.viewDepth}`);
    expect(`low-tier ocean program tone-maps and sRGB-encodes itself (${wiring.expandedLen} chars of expanded source)`,
      wiring.materialName === 'ocean-surface' && wiring.expandedLen > 0 && wiring.toneMapped && wiring.srgbOut,
      `toneMapped=${wiring.toneMapped} srgbOut=${wiring.srgbOut} name='${wiring.materialName}' (the material must NAME itself so the linked program can be found; an unnamed one matched three's own empty-named quad and graded the composer instead)`);
    expect('ocean has scene light inputs (u_keyLight, u_ambient, u_moonness)',
      wiring.hasKey && wiring.hasAmbient && wiring.hasMoonness,
      `key=${wiring.hasKey} ambient=${wiring.hasAmbient} moonness=${wiring.hasMoonness}`);

    // ── MOON PATH: a low moon dead ahead must lay a glitter column ────────
    // Centre-vs-flanks, not peak-vs-median: with the camera yawed AT the moon the
    // path runs up the middle of the frame, so a column read that ignores WHERE
    // the bright columns are grades wave noise (1.46× on HEAD, four hundredths
    // under the threshold, for no reason anyone could point at).
    await settle(NIGHT_SECONDS);
    const night0 = await page.evaluate(() => {
      const L = window.__piratesBR.renderer.activeLightDir;
      return { yaw: Math.atan2(L.x, L.z), moonY: L.y };
    });
    await look(night0.yaw);
    await page.waitForTimeout(2_500);
    const moon = await frame('night-moon-path');
    const centre = bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.42, 0.58);
    const flankL = bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.05, 0.21);
    const flankR = bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.79, 0.95);
    const flank = (flankL.luma + flankR.luma) / 2;
    const gr = centre.luma / Math.max(0.5, flank);
    console.log(`  moon path (yaw ${night0.yaw.toFixed(2)}, moon y ${night0.moonY.toFixed(2)}): centre ${centre.luma.toFixed(1)} vs flanks ${flank.toFixed(1)} → ${gr.toFixed(2)}×`);
    expect(`moon path: centre column ${centre.luma.toFixed(1)} ≥ ${GLITTER_MIN}× flanks ${flank.toFixed(1)} (${gr.toFixed(2)}×)`,
      gr >= GLITTER_MIN,
      'the ocean is handed the below-horizon SUN after dark, so sunUp is 0 and there is no glitter anywhere');

    // ── BALANCED: the inversion, and the proof the new chunks are inert here ──
    await session('balanced');
    await look(0.6);
    await settle(MIDNIGHT_SECONDS);
    const night = await frame('balanced-midnight-body');
    const bSky = bandStats(night, SKY_BAND[0], SKY_BAND[1]);
    const bSea = bandStats(night, SEA_BAND[0], SEA_BAND[1]);
    const br = bSea.luma / Math.max(1, bSky.luma);
    console.log(`  balanced midnight body: sky luma ${bSky.luma.toFixed(1)} | sea luma ${bSea.luma.toFixed(1)} → ${br.toFixed(2)}×`);
    expect(`balanced midnight: sea body ${bSea.luma.toFixed(1)} ≤ ${NIGHT_BODY_MAX}× sky ${bSky.luma.toFixed(1)} (${br.toFixed(2)}×)`,
      bSea.luma <= NIGHT_BODY_MAX * Math.max(1, bSky.luma),
      'the inversion: an unlit ocean carrying noon albedo out-glows the night sky');

    const bw = await readWiring();
    expect('balanced: the ocean program carries NO tone map / transfer of its own (OutputPass owns it, so the low-tier chunks changed nothing here)',
      bw.expandedLen > 0 && !bw.toneMapped && !bw.srgbOut,
      `name='${bw.materialName}' toneMapped=${bw.toneMapped} srgbOut=${bw.srgbOut} — if either is true the sea is tone-mapped twice on balanced/high`);

    expect('frames are not blank (some band carries signal)',
      nSky.luma + nSea.luma + bSky.luma + bSea.luma > 8);
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
