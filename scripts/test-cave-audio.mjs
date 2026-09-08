// CAVE AMBIENCE — the drip bed, graded on a fake clock (islandworld-05).
//
// WHY. Entering a cave changed the reverb TAIL and nothing else: no drips, no
// water, no moan. A silent room with a two-second echo reads as a bug. The
// scheduler is a pure function of a clock so this suite needs no AudioContext.
//
// CAN IT FAIL? `PIRATES_BR_MUTATE_DRIP=grid` replaces the jittered interval
// with a fixed one — the metronome a synthesised cave gives itself away with —
// and the spacing assertion must go red.
//
//   node --import tsx scripts/test-cave-audio.mjs
import { scheduleCaveDrips, CAVE_DRIP_MIN_AMOUNT } from '../src/client/audio/SoundEngine.ts';

let failures = 0, checks = 0;
const expect = (label, ok, detail = '') => {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};

const GRID = process.env.PIRATES_BR_MUTATE_DRIP === 'grid';
if (GRID) console.log('  ! mutation: PIRATES_BR_MUTATE_DRIP=grid (fixed intervals, no jitter)');
// Deterministic "random": mulberry32, or a constant under the mutation.
let seed = 0x9e3779b9;
const rand = () => {
  if (GRID) return 0.5;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function run(amount, secs) {
  const voices = [{ nextAt: 0, pan: -0.55, base: 1900 }, { nextAt: 0, pan: 0.6, base: 2450 }];
  const drips = [];
  for (let t = 0; t < secs; t += 0.05) {
    scheduleCaveDrips(voices, t, amount, (at, base, pan, level) => drips.push({ at, base, pan, level }), rand);
  }
  return drips.sort((a, b) => a.at - b.at);
}

console.log('cave ambience — the drip bed');
const outdoor = run(0, 5);
expect('outdoors the cave bed is silent', outdoor.length === 0, `${outdoor.length} drips scheduled outside a cave`);
expect(`…and a half-blended doorway is too (amount ≤ ${CAVE_DRIP_MIN_AMOUNT})`, run(CAVE_DRIP_MIN_AMOUNT, 5).length === 0);

const drips = run(1, 5);
expect(`a cave drips within five seconds (${drips.length} voices)`, drips.length > 0, 'setReverbSpace(cave,1) scheduled nothing');
expect('…but does not rattle (a drip bed is sparse, not a shaker)', drips.length <= 24, `${drips.length} drips in 5 s`);
expect('both ears get drips', new Set(drips.map((d) => Math.sign(d.pan))).size === 2,
  `pans ${[...new Set(drips.map((d) => d.pan))].join(', ')}`);
expect('every drip is scheduled in the FUTURE (lookahead, never behind the clock)',
  drips.every((d) => d.at >= 0), 'a drip was scheduled in the past');
expect('the plink pitch varies drip to drip', new Set(drips.map((d) => Math.round(d.base))).size > 2,
  'every drip is the same note');

// The metronome test: consecutive intervals on ONE voice must not all be equal.
const left = drips.filter((d) => d.pan < 0).map((d) => d.at);
const gaps = left.slice(1).map((t, i) => +(t - left[i]).toFixed(3));
const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
expect(`one voice's drips are jittered, not on a grid (spread ${spread.toFixed(2)} s over ${gaps.length} gaps)`,
  spread > 0.3, `gaps ${gaps.join(', ')}`);
expect('…and land in the 0.8-4.0 s band the bed is written for',
  gaps.every((g) => g >= 0.79 && g <= 4.01), `gaps ${gaps.join(', ')}`);

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log('\nALL CAVE AUDIO TESTS PASSED');
