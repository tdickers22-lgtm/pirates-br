#!/usr/bin/env node
// THE WEATHER IS ONE SET OF FIELDS, NOT TWO SETS OF SCALARS (STORMUP-01 / storm-17).
//
// Before this, getStormWaveIntensity was the only part of the storm the server
// and the client agreed on. Overcast, rain and visibility lived in
// src/client/rendering/stormWeather.ts as client-local scalars derived from the
// local player's distance — so the server could not know it was pouring on a
// burning hull, and a bot saw as far through a squall as at noon.
//
// This suite is the parity gate for the move. Two things must hold:
//
//   1. THE LOOK DID NOT MOVE. stormCloudDensity/stormRain in src/shared/utils
//      must return exactly what the client functions returned, at every point
//      the ring can put a player. If they drift, the sky changes and this fails.
//   2. THE GUST FIELD IS A FIELD, NOT A LATTICE. Bounded ±35° and 0.70..1.40,
//      zero-mean (so the tailwind still gets a hull home), continuous in x, z
//      and t (a hashed cell grid would snap the yard crossing a cell border and
//      would be exactly the kind of visible lattice the north star forbids),
//      and it must actually reach the blow-out threshold sometimes.
//
//   node --import tsx scripts/test-storm-fields.mjs
import { STORM_PHASES } from '../src/shared/constants/index.ts';
import {
  STORM_FIELD_PHASES,
  STORM_GUST_BLOWOUT_PULSE,
  STORM_GUST_MAX_YAW,
  STORM_GUST_PULSE_MID,
  STORM_GUST_PULSE_SWING,
  STORM_VISIBILITY_FLOOR,
  stormCloudDensity,
  stormGustPulse,
  stormGustYaw,
  stormRain,
  stormVisibility,
  stormWallNearness,
} from '../src/shared/utils/index.ts';
import {
  stormRainIntensityAt,
  stormWallNearness01,
  stormWeatherIntensityAt,
} from '../src/client/rendering/stormWeather.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const ring = (phase, safeRadius, shrinking, shrinkProgress) => ({
  centerX: 120, centerZ: -80, safeRadius, phase, shrinking, shrinkProgress,
});

// ── 1. The client's numbers, to the last bit ────────────────────────────────
{
  expect('the shared field normalises phase against the real phase table',
    STORM_FIELD_PHASES === STORM_PHASES.length,
    `STORM_FIELD_PHASES ${STORM_FIELD_PHASES} vs STORM_PHASES.length ${STORM_PHASES.length}`);

  const rings = [
    ring(0, 950, false, 0), ring(2, 520, true, 0.4),
    ring(4, 240, false, 0), ring(6, 35, true, 0.9),
  ];
  let worstCloud = 0, worstRain = 0, samples = 0;
  let worstAt = '';
  for (const storm of rings) {
    // 64 points sweeping from deep inside the eye to well out in the weather.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2 * 3.1;
      const r = storm.safeRadius * (0.05 + (i / 63) * 1.9);
      const x = storm.centerX + Math.cos(a) * r;
      const z = storm.centerZ + Math.sin(a) * r;
      const near = stormWallNearness01(
        Math.abs(Math.hypot(x - storm.centerX, z - storm.centerZ) - Math.max(1, storm.safeRadius)),
      );
      const dc = Math.abs(
        stormCloudDensity(storm, x, z)
        - stormWeatherIntensityAt(x, z, storm, STORM_PHASES.length, near),
      );
      const dr = Math.abs(
        stormRain(storm, x, z)
        - stormRainIntensityAt(x, z, storm, STORM_PHASES.length, near),
      );
      if (dc > worstCloud) { worstCloud = dc; worstAt = `phase ${storm.phase} r/R ${(r / storm.safeRadius).toFixed(2)}`; }
      if (dr > worstRain) worstRain = dr;
      samples += 1;
      // The nearness term the client passed in is now derived internally.
      if (Math.abs(stormWallNearness(storm, x, z) - near) > 1e-12) {
        worstCloud = Math.max(worstCloud, 1);
      }
    }
  }
  expect(`the shared overcast is the client overcast at all ${samples} points`,
    worstCloud <= 1e-12, `max |shared - client| = ${worstCloud.toExponential(3)} at ${worstAt}`);
  expect(`the shared rain is the client rain at all ${samples} points`,
    worstRain <= 1e-12, `max |shared - client| = ${worstRain.toExponential(3)}`);
}

// ── 2. Visibility is a real multiplier on sight ─────────────────────────────
{
  const storm = ring(4, 240, false, 0);
  const fair = stormVisibility(storm, storm.centerX, storm.centerZ);
  const thick = stormVisibility(storm, storm.centerX + 900, storm.centerZ);
  expect('a bot inside the eye sees its full range',
    Math.abs(fair - 1) < 1e-9, `visibility ${fair.toFixed(4)}`);
  expect('deep in the weather a bot loses most of its sight',
    thick <= 0.6 && thick >= STORM_VISIBILITY_FLOOR,
    `visibility ${thick.toFixed(4)} (floor ${STORM_VISIBILITY_FLOOR})`);
  expect('visibility never leaves [floor, 1] and is never NaN',
    (() => {
      for (let i = -1200; i <= 1200; i += 37) {
        const v = stormVisibility(storm, storm.centerX + i, storm.centerZ + i * 0.5);
        if (!Number.isFinite(v) || v < STORM_VISIBILITY_FLOOR - 1e-9 || v > 1 + 1e-9) return false;
      }
      return Number.isFinite(stormVisibility(storm, NaN, 0)) && stormVisibility(null, 0, 0) === 1;
    })());
}

// ── 3. The gust is bounded, zero-mean, continuous and reaches blow-out ──────
{
  let maxYaw = 0, minPulse = Infinity, maxPulse = -Infinity;
  let sumYaw = 0, sumPulse = 0, n = 0, squalls = 0;
  for (let ti = 0; ti < 40; ti++) {
    const t = ti * 3.7;
    for (let xi = 0; xi < 24; xi++) {
      for (let zi = 0; zi < 24; zi++) {
        const x = -1000 + xi * 83.3;
        const z = -1000 + zi * 83.3;
        const yaw = stormGustYaw(t, x, z);
        const pulse = stormGustPulse(t, x, z);
        maxYaw = Math.max(maxYaw, Math.abs(yaw));
        minPulse = Math.min(minPulse, pulse);
        maxPulse = Math.max(maxPulse, pulse);
        sumYaw += yaw; sumPulse += pulse; n += 1;
        if (pulse >= STORM_GUST_BLOWOUT_PULSE) squalls += 1;
      }
    }
  }
  expect('the gust yaw never swings past ±35°',
    maxYaw <= STORM_GUST_MAX_YAW + 1e-9,
    `max |yaw| ${maxYaw.toFixed(4)} rad (cap ${STORM_GUST_MAX_YAW})`);
  expect('the strength pulse stays inside 0.70 .. 1.40',
    minPulse >= STORM_GUST_PULSE_MID - STORM_GUST_PULSE_SWING - 1e-9
    && maxPulse <= STORM_GUST_PULSE_MID + STORM_GUST_PULSE_SWING + 1e-9,
    `pulse ${minPulse.toFixed(3)} .. ${maxPulse.toFixed(3)}`);
  expect('the gust is zero-mean, so the tailwind still gets a hull home',
    Math.abs(sumYaw / n) < 0.02 && Math.abs(sumPulse / n - STORM_GUST_PULSE_MID) < 0.02,
    `mean yaw ${(sumYaw / n).toFixed(4)} rad, mean pulse ${(sumPulse / n).toFixed(4)}`);
  const squallFraction = squalls / n;
  expect('a squall strong enough to blow canvas out happens, but is not the norm',
    squallFraction > 0.02 && squallFraction < 0.35,
    `${(squallFraction * 100).toFixed(1)}% of samples at or above ${STORM_GUST_BLOWOUT_PULSE}`);

  // NO LATTICE. A hashed cell grid (the obvious implementation) snaps the wind
  // by tens of degrees the frame a hull crosses a border. Walk a hull 0.5 m at
  // a time across 2 km of sea and grade the largest single-step jump.
  let worstStep = 0, worstStepAt = 0;
  for (let i = 0; i < 4000; i++) {
    const x = -1000 + i * 0.5;
    const d = Math.abs(stormGustYaw(11.3, x, 217) - stormGustYaw(11.3, x + 0.5, 217));
    if (d > worstStep) { worstStep = d; worstStepAt = x; }
  }
  expect('the wind never snaps: a 0.5 m step moves the gust yaw by < 0.01 rad',
    worstStep < 0.01, `worst step ${worstStep.toFixed(5)} rad at x=${worstStepAt.toFixed(1)}`);
  let worstTimeStep = 0;
  for (let i = 0; i < 4000; i++) {
    const t = i * 0.02;
    const d = Math.abs(stormGustYaw(t, 40, -90) - stormGustYaw(t + 0.02, 40, -90));
    if (d > worstTimeStep) worstTimeStep = d;
  }
  // 0.52 rad/s is the field's analytic slew ceiling: a wander, not a snap.
  expect('and it never snaps in time either: one 20 ms tick moves it < 0.015 rad',
    worstTimeStep < 0.015, `worst tick step ${worstTimeStep.toFixed(5)} rad`);
}

console.log(failures === 0
  ? '\nAll shared storm-field checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
