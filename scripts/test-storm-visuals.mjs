#!/usr/bin/env node
// STORMVIS-01 — THE STORM IS ONE PIECE OF WEATHER, IN ONE PLACE, PAID FOR ONCE.
//
// Ten defects that all live in the same squall and none of which had a suite
// that could fail on them (storm-18: every storm gate we own tests spawn safety
// and outrun distance, never a pixel or a decibel of the weather itself).
// Everything here is graded with no browser and no stack: pure functions the
// renderer and the audio engine actually call, plus the shipped source of the
// two shaders and the two call sites that cannot be reduced to a function.
//
//   storm-14  weather came from the LOCAL PLAYER's position while the
//     wall-nearness term came from the CAMERA, so a spectator watching the
//     endgame from the ring centre got the downpour of a corpse 300 m outside.
//     Graded on the anchored function: same storm, two anchors, two answers.
//   storm-15  the hull-leak submersion test fed the WEATHER number to
//     gerstnerHeight as a sea-state. Graded on the call site: it reads the
//     drawn surface (ocean.getSurfaceY) instead.
//   storm-11  stormHalo — a 47 m dark ribbon at 9 m altitude, never culled,
//     drawn at >= 0.08 alpha every frame of every match — and the stormRing
//     LineLoop at y=0.55, under the crests. Graded: neither exists.
//   storm-16  a full-screen fixed 2D canvas overlay created every match that
//     draws nothing since rain became 3D. Graded: gone, flash div kept.
//   storm-10  random thunder every 6-14 s with no flash and no bolt, on top of
//     the strike-synced thunder EnvironmentFx already plays. Graded: the
//     scheduler is gone and the only caller is a real strike.
//   storm-21  thunder for a 900 m strike arrived 1.5 s after the flash because
//     the delay was clamped there. Graded: 900 m -> 2.62 s, ceiling 1500 m.
//   storm-13  three fbm fetches per fragment before the range attenuation that
//     makes most far-side fragments invisible. Graded on the GLSL: the range
//     bound is computed and discarded on BEFORE the first noise fetch.
//   storm-03  one zero-thickness shell: a grey rectangle with a straight top
//     from any elevation. Graded on the tier table: low 1 shell, balanced 2,
//     high 2 + anvil, and the outer shell is offset and darker.
//   storm-05  the slate closed evenly in every direction: the storm had no
//     bearing in the sky. Graded on the CPU mirror of the sky term: facing the
//     wall vs facing away differs by >= 12%.
//   graphics-10  rain as 1-device-pixel GL lines. Graded on the width solver:
//     a streak never subtends less than 1.5 px, at any range or pixel ratio.
//
// RED ON HEAD: src/client/rendering/stormWeather.ts does not exist, Game.ts
// still owns stormHalo/stormRing, SoundEngine still schedules random thunder.
//
// Run: node --import tsx scripts/test-storm-visuals.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a, b, eps) => Number.isFinite(a) && Math.abs(a - b) <= eps;

const gameSrc = read('src/client/core/Game.ts');
const envSrc = read('src/client/rendering/EnvironmentFx.ts');
const soundSrc = read('src/client/audio/SoundEngine.ts');

// ── storm-14: one weather anchor ──────────────────────────────────────────
// The endgame case from the finding: ring centre at the origin, radius 500,
// phase 4 of 6, the body 300 m OUTSIDE (dist 800) and the spectate camera at
// the centre. One function, two anchors; the camera's answer is the inside one.
let sw = null;
try {
  sw = await import('../src/client/rendering/stormWeather.ts');
} catch (err) {
  expect('src/client/rendering/stormWeather.ts imports', false, String(err?.message ?? err).slice(0, 120));
}

if (sw) {
  const storm = { centerX: 0, centerZ: 0, safeRadius: 500, phase: 4, shrinking: false, shrinkProgress: 0 };
  const maxPhase = 6;
  // wallNearness is a function of the SAME anchor's distance to the wall, so
  // the spectate camera at the centre is 500 m off the wall: nowhere near it.
  const nearnessAt = (x, z) => sw.stormWallNearness01(Math.abs(Math.hypot(x, z) - storm.safeRadius));
  const atCamera = sw.stormWeatherIntensityAt(0, 0, storm, maxPhase, nearnessAt(0, 0));
  const atCorpse = sw.stormWeatherIntensityAt(800, 0, storm, maxPhase, nearnessAt(800, 0));
  expect('storm-14 spectate camera at the ring centre reads inside weather (<= 0.24)',
    atCamera <= 0.24 + 1e-6, `got ${atCamera.toFixed(3)}`);
  expect('storm-14 the same function 300 m outside reads storm weather (>= 0.52)',
    atCorpse >= 0.52, `got ${atCorpse.toFixed(3)}`);
  expect('storm-14 wall nearness is 1 at the boundary and 0 far inside',
    near(sw.stormWallNearness01(0), 1, 1e-6) && sw.stormWallNearness01(400) === 0,
    `got ${sw.stormWallNearness01(0)} / ${sw.stormWallNearness01(400)}`);
  expect('storm-14 rain never outruns the cloud that makes it',
    sw.stormRainIntensityAt(800, 0, storm, maxPhase, nearnessAt(800, 0))
      <= sw.stormWeatherIntensityAt(800, 0, storm, maxPhase, nearnessAt(800, 0)) * 1.3 + 1e-6);
}

// The renderer must ASK for the anchor rather than reach for the corpse.
expect('storm-14 computeStormWeatherIntensity anchors on the weather anchor, not getLocalPlayer',
  /computeStormWeatherIntensity\(\)[\s\S]{0,600}?getWeatherAnchor\(\)/.test(envSrc)
  && !/computeStormWeatherIntensity\(\)[\s\S]{0,400}?getLocalPlayer\(\)/.test(envSrc));
expect('storm-14 lightning gating uses the same anchor',
  /updateLightning[\s\S]{0,2600}?getWeatherAnchor\(\)/.test(envSrc));
expect('storm-14 Game hands over the CAMERA while spectating or in free cam',
  /getWeatherAnchor\s*\(\)[\s\S]{0,500}?(spectateLift|freeCam)/.test(gameSrc)
  && /getWeatherAnchor:/.test(gameSrc));

// ── storm-15: the leak gate is a sea-state, not a weather number ───────────
expect('storm-15 hull-leak submersion reads the DRAWN surface',
  /const waveY = this\.ocean\.getSurfaceY\(/.test(gameSrc));
expect('storm-15 no gerstnerHeight call in Game is fed the weather number',
  !/gerstnerHeight\([\s\S]{0,200}?storminess\s*\)/.test(gameSrc));

// ── storm-11: no mid-air ribbon, no ring under the crests ─────────────────
expect('storm-11 stormHalo is gone from Game.ts',
  !/stormHalo/.test(gameSrc), `${(gameSrc.match(/stormHalo/g) || []).length} references left`);
expect('storm-11 stormRing LineLoop is gone from Game.ts',
  !/stormRing\b/.test(gameSrc), `${(gameSrc.match(/stormRing\b/g) || []).length} references left`);

// ── storm-16: the dead 2D rain canvas ────────────────────────────────────
expect('storm-16 stormRainCtx / stormRainCanvas are gone',
  !/stormRainCtx|stormRainCanvas/.test(envSrc));
expect('storm-16 #storm-rain-canvas is no longer created',
  !/storm-rain-canvas/.test(envSrc));
expect('storm-16 the soft-light flash div is KEPT (it is live)',
  /storm-lightning-flash/.test(envSrc));

// ── storm-10 / storm-21: thunder ─────────────────────────────────────────
expect('storm-10 no random thunder scheduler in the ambience tick',
  !/nextThunderAt/.test(soundSrc), `${(soundSrc.match(/nextThunderAt/g) || []).length} references left`);
expect('storm-10 playThunder has exactly one caller, the real strike',
  (soundSrc.match(/this\.playThunder\(/g) || []).length === 0);
expect('storm-10 the strike still sounds', /audio\.playThunder\(/.test(envSrc));

let se = null;
try {
  se = await import('../src/client/audio/SoundEngine.ts');
} catch (err) {
  expect('SoundEngine imports', false, String(err?.message ?? err).slice(0, 120));
}
if (se) {
  const d900 = se.thunderArrivalDelay?.(900);
  const d1500 = se.thunderArrivalDelay?.(1500);
  const d80 = se.thunderArrivalDelay?.(80);
  expect('storm-21 thunder for a 900 m strike starts at now + 2.62 s',
    near(d900, 900 / 343, 0.01), `got ${d900}`);
  expect('storm-21 the delay ceiling is the audible ceiling (1500 m), not 1.5 s',
    near(d1500, 1500 / 343, 0.01) && near(se.thunderArrivalDelay?.(4000), 1500 / 343, 0.01),
    `got ${d1500}`);
  expect('storm-21 a near strike is still nearly instant',
    Number.isFinite(d80) && d80 < 0.3, `got ${d80}`);
  expect('storm-21 the distance ceiling is exported and audible',
    se.THUNDER_MAX_DISTANCE_M === 1500, `got ${se.THUNDER_MAX_DISTANCE_M}`);
}

// ── storm-13: the far side of the ring stops paying for noise it cannot show ─
// The front is a full-ring transparent surface measured at 27-43% of frame
// layers in FAIR WEATHER (scripts/perf-storm-front-gate.mjs). Everything that
// attenuates a fragment by range is knowable before the first noise fetch, so
// that is where the bound and its discard have to be.
const frag = envSrc.slice(envSrc.indexOf('const STORM_FRONT_FRAG'), envSrc.indexOf('// Lightning channel budget'));
const mainBody = frag.slice(frag.indexOf('void main()'));
const iRange = mainBody.indexOf('float rangeAtt');
const iDiscard = mainBody.indexOf('if (rangeAtt <');
const iFirstFbm = mainBody.indexOf('fFbm(');
expect('storm-13 the range/intensity bound is computed before any fbm fetch',
  iRange > 0 && iFirstFbm > 0 && iRange < iFirstFbm, `rangeAtt@${iRange} fbm@${iFirstFbm}`);
expect('storm-13 an invisible fragment is discarded before any fbm fetch',
  iDiscard > 0 && iDiscard < iFirstFbm, `discard@${iDiscard} fbm@${iFirstFbm}`);
expect('storm-13 the bound is an EXACT upper bound (alpha is only ever scaled by it once)',
  (mainBody.match(/smoothstep\(380\.0, 1500\.0, d\)/g) || []).length === 1
  && /a \*= rangeAtt/.test(mainBody)
  && !/a \*= u_intensity;/.test(mainBody));
expect('storm-13 the two detail fields are range-faded, so far fragments pay one fbm',
  /float detail = 1\.0 - smoothstep\(/.test(mainBody)
  && (mainBody.match(/if \(detail > 0\.001\) \{/g) || []).length === 2
  && mainBody.indexOf('float detail') < iFirstFbm);
expect('storm-13/liveplay-14 the bank dissolves into the SCENE fog, not its own curve',
  /uniform float u_fogDensity;/.test(frag)
  && /exp\(-d \* u_fogDensity/.test(mainBody)
  && /u_fogDensity: \{ value:/.test(envSrc)
  && /u\.u_fogDensity\.value = Math\.max\(0\.0002, atmosphere\.fogDensity\)/.test(envSrc),
  'the front still runs off a hand-picked 0.0013/m');

// ── storm-03: the bank has a body, and the bottom tier does not pay for it ──
if (sw) {
  expect('storm-03 low keeps ONE shell, balanced and high get the parallax pair',
    sw.stormFrontShellCount?.('low') === 1
    && sw.stormFrontShellCount?.('balanced') === 2
    && sw.stormFrontShellCount?.('high') === 2,
    `${sw.stormFrontShellCount?.('low')}/${sw.stormFrontShellCount?.('balanced')}/${sw.stormFrontShellCount?.('high')}`);
}
expect('storm-03 the renderer builds its shells from that table',
  /stormFrontShellCount\(this\.view\.renderer\.getQuality\(\)\)/.test(envSrc));
expect('storm-03 the outer shell stands further out, samples offset noise, and is darker and thinner',
  /uniform float u_shell;/.test(frag)
  && /v_world\.xz \+ u_shell \* /.test(frag)
  && /col \*= mix\(1\.0, 0\.74, u_shell\);/.test(frag)
  && /a \*= rangeAtt \* mix\(1\.0, 0\.58, u_shell\);/.test(frag)
  && /shell\.outer \? 1\.06 : 1\.006/.test(envSrc));
expect('storm-03 the outer shell is range-gated even on the tiers that have it',
  /const OUTER_SHELL_RANGE = \d+;/.test(envSrc)
  && /wallDist < OUTER_SHELL_RANGE/.test(envSrc)
  && /!shell\.outer \|\| outerWanted/.test(envSrc));
expect('storm-03 both shells share one program (same source, same defines)',
  (envSrc.match(/defines: cheap \? \{ FRONT_CHEAP: '' \} : \{\}/g) || []).length === 1
  && /const build = \(outer: boolean\)/.test(envSrc)
  && /mesh\.renderOrder = outer \? 2 : 3;/.test(envSrc));

// ── storm-05: the storm has a bearing in the sky ─────────────────────────────
const rendererSrc = read('src/client/rendering/Renderer.ts');
if (sw) {
  const facing = sw.stormSkySideMask?.(1, 0);
  const away = sw.stormSkySideMask?.(-1, 0);
  expect('storm-05 inside the ring the slate is at least 12% heavier toward the wall',
    Number.isFinite(facing) && Number.isFinite(away) && facing - away >= 0.12,
    `facing ${facing} vs away ${away}`);
  expect('storm-05 outside the ring the storm is all around and the sky closes evenly',
    sw.stormSkySideMask?.(1, 1) === 1 && sw.stormSkySideMask?.(-1, 1) === 1);
  expect('storm-05 the inside/outside crossover is a band at the wall, not a step',
    sw.stormSkyNear01?.(-200) === 0 && sw.stormSkyNear01?.(200) === 1
    && near(sw.stormSkyNear01?.(0), 0.5, 1e-6));
}
expect('storm-05 the sky shader carries the storm bearing and uses it on the slate',
  /uniform vec2  u_stormDir;/.test(rendererSrc)
  && /uniform float u_stormNear;/.test(rendererSrc)
  && /mix\(mix\(0\.35, 1\.0, smoothstep\(-0\.2, 0\.6, bearing\)\), 1\.0, u_stormNear\)/.test(rendererSrc)
  && /max\(u_stormIntensity, oc \* 0\.80\) \* stormSide/.test(rendererSrc)
  && /scud \* scudBand \* oc \* 0\.85 \* stormSide/.test(rendererSrc));
expect('storm-05 the rotating anvil is a tier gate, masked to the storm sector',
  // The sky material's `defines` grew a second entry in wave 8.2 (the cloud
  // octave ladder), so the anvil's tier gate moved from being the whole object
  // literal to a spread inside it. What is graded is unchanged: on 'low' the
  // define is absent, so the anvil block is not even compiled.
  /\.\.\.\(this\.quality === 'low' \? \{\} : \{ SKY_ANVIL: '' \}\)/.test(rendererSrc)
  && /#ifdef SKY_ANVIL/.test(rendererSrc)
  && /float anvilMask = smoothstep\(0\.05, 0\.75, bearing\)/.test(rendererSrc)
  && /if \(anvilMask > 0\.004\) \{/.test(rendererSrc)
  && /cos\(u_time \* 0\.020\)/.test(rendererSrc));
expect('storm-05 the bearing is fed from the ring, every frame the front updates',
  /this\.view\.renderer\.setStormBearing\(/.test(envSrc)
  && /stormSkyNear01\(Math\.hypot\(toCentreX, toCentreZ\) - radius\)/.test(envSrc));

console.log(failures === 0 ? `\nPASS storm visuals (${failures} failures)` : `\nFAIL storm visuals (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
