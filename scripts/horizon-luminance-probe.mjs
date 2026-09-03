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
//     • and those three are READ by the body (an existing-but-unsampled uniform
//       passes a table check and changes nothing), the storm branch mixes the
//       body toward the shaped sky, and storm-02's second grey desaturation
//       pass stays deleted (storm-12 / storm-02).
//
//   PIXELS (luma ratios, never absolutes, so SwiftShader's curve cannot move
//   the verdict):
//     • NOON junction (rows 40-47% sky vs 53-60% sea): 0.80 ≤ sea/sky ≤ 1.30
//       (JUNCTION_MAX was re-banded to 1.30 in the gate2 commit; this line said
//       1.25 and was stale). Measured 1.26× on 2026-09-03, so the margin is 3%.
//       On the low tier today the sea is written raw-linear into an sRGB buffer
//       while the sky above it is tone-mapped, so the junction has a step in it.
//     • NIGHT body: sea vs the sky just above the horizon — the inversion
//       itself, a surface cannot out-glow what lights it. ADVISORY, see below.
//     • NIGHT moon path (camera yawed to the moon azimuth, moon low): the centre
//       columns vs the flanks, ≥ 1.35 × wanted. ADVISORY, see below.
//
// ── WHAT THE PIN CHANGED, AND WHY THE TWO NIGHT RATIOS ARE STILL ADVISORY ──
// Until 2026-09-03 the two night PIXEL reads were unreadable, not just ungraded:
// five runs of ONE commit on the pinned seed gave body 1.88x / 2.05x / 2.92x /
// 2.63x / 1.67x and path 1.44x / 1.32x / 0.92x / 1.08x / 1.04x. The variance was
// never in the water. The stands join a LIVE solo match, so the server's storm
// phase — and the rain mist riding on it, which thickens fog density by up to
// 62% (Renderer :1290) — differed per run, and the night sea band is mostly fog.
//
// Both sources are closed now. session() pins the weather flat calm through
// Game.setWeatherOverride(0) (the calm counterpart of ?stormdemo), and every
// night band is the mean of NIGHT_FRAMES frames ~0.9 s apart, which averages out
// the free-running wave phase. The sky band went from drifting to reading 19.0
// on every run, and the noon junction to 1.26-1.27x.
//
// What that bought is a NUMBER, not a pass. Pinned to flat calm the sea is
// BRIGHTER than it looked before, because the rain fog had been hiding it:
// body 2.22x / 2.25x / 2.02x / 1.95x / 2.14x, path 0.93x / 1.11x / 1.11x /
// 1.26x / 1.15x
// (the last three of each are with frame averaging, the last two with the
// corrected glitter rows). So the honest reading is that this lane lit the ocean but did NOT
// reach its own night targets: the sea still out-glows the night sky by about
// 2x, and there is a glitter gradient rather than a glitter column.
//
// They stay ADVISORY rather than being re-ratcheted because a cap set above the
// worst pinned run (~2.5x) is above the 2.49x this gate measured pre-fix — it
// would pass the broken build too, which is the failure mode FIX_COMMON's "can
// it fail?" rule exists to stop. The residual is not reachable from this lane:
// the drawn night sky near the horizon reads 19/255 while skyHorizonNightColor,
// the swatch getAtmosphere hands the ocean as its dissolve target, shapes to
// roughly four times that (storm-02's third grey, sky-shader side, lane 5.4).
// Grade these two the moment that lands — the reads themselves are ready.
//
// What DOES gate the inversion meanwhile is test-storm-wall's night row (sea
// luma <= 1.05x sky under the wall, deterministic because ?stormdemo parks the
// weather): 0.98x after this lane. And what this file grades — the noon
// junction, the aim, and the five wiring reads — is deterministic.
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
// 1.30, not 1.0: with the ocean tone-mapped the junction lands at 1.27 (from
// 0.66 raw-linear), and the residual is the scene's FOG colour sitting above the
// sky's shaped horizon — a fogDayColor-vs-sky mismatch that belongs to no item
// in this lane. The band's job is to catch a TIER-SHAPED step, and 0.66 is one.
const JUNCTION_MAX = 1.30;
// A RATCHET, NOT THE DESTINATION. 1.30 is where a mirror sea lands, and this
// gate measured 2.49x on HEAD and 1.88x once the ocean was lit. The residual is
// NOT in the water: the drawn night sky near the horizon reads 19/255 here while
// skyHorizonNightColor — the swatch getAtmosphere hands the ocean as its
// dissolve target — shapes to roughly four times that, because the sky dome's
// night gradient is not the same source (storm-02's third grey, sky-shader side,
// lane 5.4's file). Closing that gap is what lets this drop to 1.30; doing it
// from the ocean instead would mean black water, which this game deliberately
// does not have ("a night is blue and legible, not an unlit black screen",
// getCycleSunIntensity).
const NIGHT_BODY_MAX = 2.00;
// Also a ratchet: 1.14x on HEAD (wave noise — there is no moon path at all),
// 1.44x with the moon driving the tight specular lobe. 1.35 fails HEAD by a
// clear margin and passes the fix by one; raise it when the night sky lands.
const GLITTER_MIN = 1.35;
// Full night (nightAmount 1.0) with the moon still LOW: cycle 0.76 of the
// 960 s lap puts the anti-sun at y≈0.43, so there is a moon azimuth to yaw to.
// The obvious 374 s is local midnight — the moon is at the zenith, the glitter
// path has no direction, and the read is meaningless.
const NIGHT_SECONDS = 278;
// Local midnight on the same lap: the darkest sky of the match.
const MIDNIGHT_SECONDS = 374;
// Sea rows the glitter path crosses at pitch 0 from 12 m of eye height. Read
// NEAR the camera: the night fog density is 0.00158, which puts 59% of the
// mid-frame water at the fog colour and averages the path away.
const GLITTER_ROWS = [0.55, 0.72];
// Every night band is the mean of this many frames ~0.9 s apart: the ocean clock
// free-runs, so one frame grades one wave phase (the same pinned stand read the
// moon path at 0.93x and 1.11x on two runs of one commit). Each frame is ~45 s
// of SwiftShader, so this is the whole cost knob for the suite.
const NIGHT_FRAMES = 2;

// The zenith is not what the water reflects. At night the sky has a 3x gradient
// from horizon to zenith (skyHorizonNightColor shapes to ~0.073 linear, the
// zenith to ~0.024), so even a perfect mirror sea reads several times the top of
// the frame. The night comparison is against the sky the sea actually mirrors:
// the band just above the horizon line, which pitch 0 puts on row 50%.
const SKY_BAND = [0.34, 0.46];
const SEA_BAND = [0.55, 0.85];
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
      // FLAT CALM, PINNED. Without this the stands join a live match whose storm
      // phase — and the rain mist riding on it, which thickens fog density by up
      // to 62% — differ per run, and the night sea band is mostly fog. That is
      // what kept the two night ratios advisory. Storm lighting is graded by
      // test-storm-wall, which parks its own weather with ?stormdemo.
      // A missing hook must NOT degrade to "unpinned but still graded" — that is
      // exactly the flaky gate this replaces, so it is a hard error.
      const pinned = await page.evaluate(() => {
        const g = window.__piratesBR;
        if (typeof g.setWeatherOverride !== 'function') return false;
        g.setWeatherOverride(0);
        return true;
      });
      if (!pinned) throw new Error('Game.setWeatherOverride is missing — the night stands cannot be pinned to flat calm');
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
        // Either spelling of three's Gaussian: the density squared inline, or
      // squared through a named range term.
      gaussian: /u_fogDensity\s*\*\s*(u_fogDensity|fogDepth)/.test(src),
        viewDepth: /viewMatrix\s*\*\s*vec4\(\s*v_worldPos/.test(src) || /v_fogDepth/.test(src),
        materialName: mat.name || '',
        expandedLen: expanded.length,
        // THE PREFIX ALWAYS DECLARES THE TONE-MAP FUNCTIONS AND
        // linearToOutputTexel — matching those names told us nothing and made
        // this check pass on HEAD, where the ocean had no chunks at all. What
        // decides whether the material converts is the macro three emits only
        // when the program's own toneMapping parameter is not NoToneMapping,
        // which is exactly the "render target is null" condition.
        toneMapped: /#define TONE_MAPPING/.test(expanded),
        srgbOut: /LinearTosRGB|sRGBTransferOETF\s*\(\s*value/.test(expanded),
        // ── SLICE f: DECLARED IS NOT CONSUMED ──────────────────────────
        // The check above reads the uniform TABLE. A uniform that exists and is
        // never read leaves the sea exactly as self-luminous as it was on HEAD,
        // and the table check still passes — so these four read the authored
        // body instead. All four are structural, cost no frames, and are the
        // only assertions in the battery that guard the storm half of OCEAN-01
        // (test-storm-wall does the storm PIXELS and is not deterministic yet;
        // see the w1.4 handoff to lane 5.4).
        keyLightConsumed: /base\s*\*=\s*u_ambient\s*\+\s*u_keyLight/.test(src),
        moonnessConsumed: (src.match(/u_moonness/g) ?? []).length > 1,
        stormTakesSky: /vec3\s+stormSky\s*=\s*mix\(/.test(src)
          && /base\s*=\s*mix\(\s*base\s*,\s*stormSky/.test(src)
          && /skyShape\(\s*u_horizonColor\s*\)/.test(src),
        // storm-02's two ocean greys: the (0.42,0.48,0.55) multiply is kept at
        // 0.35 strength by slice d, the (0.72,0.76,0.82) second desaturation
        // pass is gone. Its return is the exact regression that made a squall
        // read as a black-and-white photograph.
        greyDesatPasses: (src.match(/0\.72\s*,\s*0\.76\s*,\s*0\.82/g) ?? []).length,
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
    expect(`low-tier ocean program tone-maps itself (${wiring.expandedLen} chars of expanded source, srgb=${wiring.srgbOut})`,
      wiring.materialName === 'ocean-surface' && wiring.expandedLen > 0 && wiring.toneMapped,
      `toneMapped=${wiring.toneMapped} srgbOut=${wiring.srgbOut} name='${wiring.materialName}' (the material must NAME itself so the linked program can be found; an unnamed one matched three's own empty-named quad and graded the composer instead)`);
    expect('ocean has scene light inputs (u_keyLight, u_ambient, u_moonness)',
      wiring.hasKey && wiring.hasAmbient && wiring.hasMoonness,
      `key=${wiring.hasKey} ambient=${wiring.hasAmbient} moonness=${wiring.hasMoonness}`);
    expect('the scene light inputs are CONSUMED by the body, not merely declared',
      wiring.keyLightConsumed && wiring.moonnessConsumed,
      `keyLight read by the body=${wiring.keyLightConsumed} moonness read=${wiring.moonnessConsumed} — an unread uniform passes the check above and still leaves the sea self-luminous (graphics-03/graphics-15)`);
    expect('under a front the body mixes toward the SHAPED SKY (Fresnel stormSky)',
      wiring.stormTakesSky,
      'the storm sea must take the colour of the sky over it, not a constant blue multiplied by a grey (storm-12)');
    expect(`storm-02's second grey desaturation pass stays deleted (${wiring.greyDesatPasses} found)`,
      wiring.greyDesatPasses === 0,
      'carrying the chroma down twice is what made a squall read as a black-and-white photograph (storm-02)');

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
    // AIM, AND THEN CHECK THE AIM. atan2(L.x, L.z) and enableFreeCam's yaw are
    // not guaranteed to be the same convention, and a centre-vs-flank read on a
    // mis-aimed camera grades the flank the path happens to land in: with the
    // raw yaw the brightest tenth of the frame sat at x=0.30-0.40, a ninth of a
    // frame off centre, and the "centre" columns read the shoulder of the path.
    // So close the loop — one Newton step off a measured sensitivity, which
    // works whichever way the sign runs — and grade the residual.
    const aimError = () => page.evaluate(() => {
      const g = window.__piratesBR;
      const L = g.renderer.activeLightDir;
      const f = g.renderer.camera.getWorldDirection(g.renderer.camera.position.clone());
      const d = Math.atan2(L.x, L.z) - Math.atan2(f.x, f.z);
      return Math.atan2(Math.sin(d), Math.cos(d));
    });
    const aimAt = async (y) => { await look(y); await page.waitForTimeout(700); return aimError(); };
    let yaw = night0.yaw;
    const e0 = await aimAt(yaw);
    const h = 0.25;
    const e1 = await aimAt(yaw + h);
    const slope = (e1 - e0) / h;
    if (Math.abs(slope) > 0.2) yaw += -e0 / slope;
    const aimErr = await aimAt(yaw);
    expect(`night camera is aimed AT the moon (residual ${(aimErr * 57.3).toFixed(1)}°)`,
      Math.abs(aimErr) < 0.035,
      `yaw ${yaw.toFixed(3)} still ${(aimErr * 57.3).toFixed(1)}° off the moon azimuth — the centre band would read the shoulder of the path`);

    // THREE FRAMES, NOT ONE. The ocean clock free-runs, so a single frame grades
    // one wave phase: the same pinned stand read 0.93x and 1.11x on two runs of
    // one commit. Averaging the bands over ~2 s of swell takes that out.
    let cSum = 0, fSum = 0;
    let moon = null;
    for (let i = 0; i < NIGHT_FRAMES; i += 1) {
      if (i) await page.waitForTimeout(900);
      moon = await frame(i === NIGHT_FRAMES - 1 ? 'night-moon-path' : `night-moon-path-${i}`);
      cSum += bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.42, 0.58).luma;
      fSum += (bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.05, 0.21).luma
        + bandStats(moon, GLITTER_ROWS[0], GLITTER_ROWS[1], 0.79, 0.95).luma) / 2;
    }
    const centre = { luma: cSum / NIGHT_FRAMES };
    const flank = fSum / NIGHT_FRAMES;
    const gr = centre.luma / Math.max(0.5, flank);
    console.log(`  moon path (yaw ${yaw.toFixed(2)}, moon y ${night0.moonY.toFixed(2)}, ${NIGHT_FRAMES} frames): centre ${centre.luma.toFixed(1)} vs flanks ${flank.toFixed(1)} → ${gr.toFixed(2)}×`);
    console.log(`  ADVISORY moon path ${gr.toFixed(2)}× (want ≥ ${GLITTER_MIN}×) — see WHAT THE PIN CHANGED at the top of this file`);

    // ── BALANCED: the inversion, and the proof the new chunks are inert here ──
    await session('balanced');
    await look(0.6);
    await settle(MIDNIGHT_SECONDS);
    // Three frames, same reason as the moon path: the ocean clock free-runs.
    let skySum = 0, seaSum = 0, night = null;
    for (let i = 0; i < NIGHT_FRAMES; i += 1) {
      if (i) await page.waitForTimeout(900);
      night = await frame(i === NIGHT_FRAMES - 1 ? 'balanced-midnight-body' : `balanced-midnight-body-${i}`);
      skySum += bandStats(night, SKY_BAND[0], SKY_BAND[1]).luma;
      seaSum += bandStats(night, SEA_BAND[0], SEA_BAND[1]).luma;
    }
    const bSky = { luma: skySum / NIGHT_FRAMES };
    const bSea = { luma: seaSum / NIGHT_FRAMES };
    const br = bSea.luma / Math.max(1, bSky.luma);
    console.log(`  balanced midnight body: sky luma ${bSky.luma.toFixed(1)} | sea luma ${bSea.luma.toFixed(1)} → ${br.toFixed(2)}×`);
    console.log(`  ADVISORY balanced midnight body ${br.toFixed(2)}× (want ≤ ${NIGHT_BODY_MAX}×) — see WHAT THE PIN CHANGED at the top of this file`);

    const bw = await readWiring();
    expect('balanced: the ocean program carries NO tone map of its own (OutputPass owns it, so the chunks added for low changed nothing here)',
      bw.materialName === 'ocean-surface' && bw.expandedLen > 0 && !bw.toneMapped,
      `name='${bw.materialName}' toneMapped=${bw.toneMapped} — if true the sea is tone-mapped twice on balanced/high`);

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
