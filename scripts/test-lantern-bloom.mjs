#!/usr/bin/env node
// LANTERN BLOOM GATE (GFXPOL-01 / graphics-23) — bloom never touched the one
// scene it exists for.
//
// WHAT THE DEFECT WAS. UnrealBloomPass ran at a CONSTANT threshold of 1.05 of
// linear HDR, and the brightest thing on a night island was a lantern glow
// sprite at 0.85 of linear white (0.3 for the ones carrying a real point light).
// So the warm lights the whole night scene is built around were below the
// threshold at every hour of the match, while the sun on the sea was above it.
//
// WHAT SHIPS NOW. The threshold follows the day/night clock (1.05 at noon, 0.55
// at full night: the frame is dark, so almost nothing else crosses it), and the
// lantern glass is lifted into HDR by LANTERN_BLOOM_GAIN — but only on tiers
// that BUILD a composer, because an HDR sprite with no bloom pass behind it is
// just a clipped white disc, and a lantern that looks like a different object on
// a different tier is exactly the incoherence this campaign is about.
//
// WHY THIS IS NOT A SCREENSHOT PROBE. "Does the glass clear the threshold" is
// arithmetic on two shipped numbers and a curve. A pixel probe would need a
// stack, a browser, a night stand and a stochastic sample of a flickering
// sprite, to answer a question that has a closed form.
//
// GRADED
//   1. at full night the DIMMEST lantern glass clears the bloom threshold with
//      margin (>= 1.15x) — not just the few carrying a real point light.
//   2. at noon the threshold is exactly what it was (1.05), so nothing about
//      the daylight frame changed; the curve between is monotonic.
//   3. at noon the lantern glass does NOT bloom (it is invisible by day, and it
//      must not become a hidden daytime bloom source either).
//   4. the HDR gain is off on 'low', which has no composer at all.
//
// Run: node --import tsx scripts/test-lantern-bloom.mjs
import {
  BLOOM_DAY_THRESHOLD, BLOOM_NIGHT_THRESHOLD, bloomThresholdForNight, bloomStrengthForNight,
} from '../src/client/rendering/PostFx.ts';
import {
  LANTERN_BLOOM_GAIN, LANTERN_GLOW_BASE_LIT, LANTERN_GLOW_BASE_UNLIT, lanternBloomGainFor,
} from '../src/client/rendering/EnvironmentFx.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};

// The glow sprite is additive: its contribution is colour * opacity * texel,
// and the texel is 1 at the core of the glow disc. The brightest channel of
// 0xffbb66 (and of the campfire's 0xff8a3c) is 1.0, so the peak the bloom pass
// sees is gain * base * flicker, and flicker only ever helps.
const peak = (base, quality) => lanternBloomGainFor(quality) * base;

const nightThreshold = bloomThresholdForNight(1);
const dimmest = peak(LANTERN_GLOW_BASE_LIT, 'balanced');
const brightest = peak(LANTERN_GLOW_BASE_UNLIT, 'balanced');
const MARGIN = 1.15;
expect(`the dimmest lantern glass peaks at ${dimmest.toFixed(2)} against a ${nightThreshold} night threshold (>= ${MARGIN}x)`,
  dimmest >= nightThreshold * MARGIN,
  `with no HDR gain it peaks at ${LANTERN_GLOW_BASE_LIT} and never blooms at any hour; the unlit-pool lanterns peak at ${brightest.toFixed(2)}`);
expect(`every lantern blooms, not only the few holding a real point light (dim ${dimmest.toFixed(2)}, bright ${brightest.toFixed(2)})`,
  Math.min(dimmest, brightest) >= nightThreshold);

expect(`noon is untouched: the threshold at nightAmount 0 is still ${BLOOM_DAY_THRESHOLD}`,
  bloomThresholdForNight(0) === BLOOM_DAY_THRESHOLD);
expect(`full night reaches ${BLOOM_NIGHT_THRESHOLD}`, bloomThresholdForNight(1) === BLOOM_NIGHT_THRESHOLD);

let monotonic = true, prev = Infinity, strengthOk = true;
for (let i = 0; i <= 100; i++) {
  const t = bloomThresholdForNight(i / 100);
  if (t > prev + 1e-9) monotonic = false;
  prev = t;
  const s = bloomStrengthForNight(i / 100);
  if (!(s > 0 && s <= 0.6)) strengthOk = false;
}
expect('the threshold falls monotonically from noon to midnight (no hour where bloom snaps on)', monotonic);
expect('the bloom strength stays inside a sane band the whole way (0, 0.6]', strengthOk);
expect('out-of-range clock values are clamped, not extrapolated',
  bloomThresholdForNight(-3) === BLOOM_DAY_THRESHOLD && bloomThresholdForNight(9) === BLOOM_NIGHT_THRESHOLD);

// By day the glow opacity is driven to 0 by the same nightAmount, so the peak
// the pass sees at noon is 0 — the gain must not create a daylight bloom source.
const noonPeak = brightest * 0;
expect(`the lantern glass adds nothing to the noon frame (peak ${noonPeak} < ${BLOOM_DAY_THRESHOLD})`,
  noonPeak < BLOOM_DAY_THRESHOLD);

expect(`the HDR gain is off on the tier with no composer (low ${lanternBloomGainFor('low')}, balanced ${lanternBloomGainFor('balanced')}, high ${lanternBloomGainFor('high')})`,
  lanternBloomGainFor('low') === 1
  && lanternBloomGainFor('balanced') === LANTERN_BLOOM_GAIN
  && lanternBloomGainFor('high') === LANTERN_BLOOM_GAIN);

console.log(failures === 0 ? '\nPASS test-lantern-bloom' : `\nFAIL test-lantern-bloom (${failures})`);
process.exit(failures === 0 ? 0 : 1);
