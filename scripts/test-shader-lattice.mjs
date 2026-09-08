#!/usr/bin/env node
// SHADER LATTICE GATE (GFXPOL-01 / graphics-18, graphics-19) — two hand-drawn
// grids the player reads at arm's length.
//
// WHAT THE DEFECTS WERE.
//   1. SEA-STACK MOTTLE. `fract(sin(dot(floor(vRockWorld.xz * 0.55), ...)))` —
//      ONE hash per 1.818 m cell and nothing in between, so every sea stack
//      wore 1.8 m squares of ±10% brightness with a hard edge at each cell
//      boundary. A stack is the one rock family a player swims past at 5-20 m.
//   2. TERRAIN CAUSTICS. `sin(x * 1.15 + t) * sin(z * 0.97 - t)` — a product of
//      two WORLD-AXIS sines is a 5.5 m x 6.5 m checker of light, and it was
//      switched on by `step(vTerrWorld.y, 0.6)`, i.e. the whole 16% modulation
//      appeared across ONE contour line, drawing a hard bright ring at exactly
//      0.6 m of altitude around every coast in the world.
//
// WHY THIS IS NOT A SCREENSHOT PROBE. Both are properties of a closed-form
// FIELD, not of a frame. Rendering them costs a stack, a browser, a stand with
// the right sun and a stochastic sample of a moving surface; evaluating them
// costs 30 ms and fails for exactly one reason. Following the precedent of
// `ocean-lattice-probe.mjs`.
//
// HOW IT CANNOT SILENTLY DRIFT. Nothing graded here is typed twice. The GLSL
// is IMPORTED (`SEA_ROCK_NOISE_GLSL`, `SEA_ROCK_MOTTLE_GLSL`,
// `TERRAIN_CAUSTIC_GLSL` are the very strings spliced into the compiled
// shaders), every constant that decides a verdict is PARSED out of it, and the
// one hand-ported function (the value noise) is pinned to its GLSL source line:
// if that body changes, the gate exits loudly instead of grading a mirror of a
// shader that no longer exists.
//
// GRADED
//   1. sea-stack mottle: max brightness step between adjacent samples 2 cm
//      apart <= 0.06 of the base colour. The cell hash steps ~0.20. RED on HEAD.
//   2. sea-stack mottle is not a cell hash: no `floor(` in the mottle field.
//   3. caustic altitude gate: max change in the modulation per 1 cm of height
//      <= 0.04. `step()` changes it by the full amplitude. RED on HEAD.
//   4. caustic bearings are off BOTH world axes and not parallel to each other.
//      RED on HEAD (the old field has no bearings at all: bare x and z sines).
//   5. each caustic sine's phase carries a noise term. This is what breaks the
//      product grid on the LOW tier, where `tP` is unwarped — a merely rotated
//      checker is still a checker. (Structural: it proves the modulation is
//      wired, not how strong it is.)
//
// Run: node --import tsx scripts/test-shader-lattice.mjs
import {
  SEA_ROCK_MOTTLE_GLSL, SEA_ROCK_MOTTLE_SWING, SEA_ROCK_NOISE_GLSL,
} from '../src/client/world/island/SeaRockBuilder.ts';
import { TERRAIN_CAUSTIC_GLSL } from '../src/client/world/island/TerrainMeshBuilder.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};
const die = (why) => { console.error(`  ✗ FAIL: ${why}`); process.exit(1); };

// ── 1-2. THE SEA-STACK MOTTLE ──────────────────────────────────────────────
// The mirror is pinned to the shipped noise body. Anything else and it is
// grading a shader that does not exist.
const NOISE_PINS = [
  'vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
  'return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
];
for (const pin of NOISE_PINS) {
  if (!SEA_ROCK_NOISE_GLSL.includes(pin)) {
    die(`SEA_ROCK_NOISE_GLSL no longer contains "${pin}" — the JS mirror of srNoise is stale, re-derive it before trusting this gate`);
  }
}
// The hash multiplier and the two dot weights come out of the GLSL, never out
// of this file: a re-tuned hash must not change the verdict silently.
const hashM = SEA_ROCK_NOISE_GLSL.match(/fract\(sin\(dot\(p, vec2\(([\d.]+), ([\d.]+)\)\)\) \* ([\d.]+)\)/);
if (!hashM) die('cannot parse srHash out of SEA_ROCK_NOISE_GLSL');
const [HX, HY, HK] = [Number(hashM[1]), Number(hashM[2]), Number(hashM[3])];

// float32 at every step, exactly as the GLSL evaluates it: the whole question
// is the size of a discontinuity, and a discontinuity is a property of the
// precision it is taken at.
const f32 = Math.fround;
const fract = (x) => f32(x - Math.floor(x));
const srHash = (x, y) => fract(f32(Math.sin(f32(f32(f32(x * HX) + f32(y * HY))))) * HK);
const srNoise = (x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = f32(fx * fx * (3 - 2 * fx)), uy = f32(fy * fy * (3 - 2 * fy));
  const a = srHash(ix, iy), b = srHash(ix + 1, iy);
  const c = srHash(ix, iy + 1), d = srHash(ix + 1, iy + 1);
  return f32(f32(a + (b - a) * ux) + (f32(c + (d - c) * ux) - f32(a + (b - a) * ux)) * uy);
};

// The OLD field, kept only as the control that proves the measurement can see a
// discontinuity at all. It is never what ships.
const cellHash = (x, y) => fract(f32(Math.sin(f32(f32(Math.floor(x) * 12.9898) + f32(Math.floor(y) * 78.233)))) * 43758.5453);

expect('sea-stack mottle is a continuous field, not a per-cell hash (no floor())',
  !SEA_ROCK_MOTTLE_GLSL.includes('floor('),
  SEA_ROCK_MOTTLE_GLSL.trim());

// The world scale AND the sampler both come out of the GLSL. A cell hash is
// recognised rather than rejected, so the numeric grade below actually runs on
// it and FAILS on its step instead of the gate exiting early: "can it fail"
// has to be answerable on the field that shipped, not only on a missing regex.
const smoothM = SEA_ROCK_MOTTLE_GLSL.match(/srNoise\(vRockWorld\.xz \* ([\d.]+)\)/);
const cellM = SEA_ROCK_MOTTLE_GLSL.match(/floor\(vRockWorld\.xz \* ([\d.]+)\)/);
if (!smoothM && !cellM) die('cannot parse the mottle world scale out of SEA_ROCK_MOTTLE_GLSL');
const MOTTLE_SCALE = Number((smoothM ?? cellM)[1]);
const mottleSampler = smoothM ? srNoise : cellHash;
if (!SEA_ROCK_MOTTLE_GLSL.includes(`(_m - 0.5) * ${SEA_ROCK_MOTTLE_SWING.toFixed(3)}`)) {
  die('SEA_ROCK_MOTTLE_GLSL no longer applies SEA_ROCK_MOTTLE_SWING as a centred swing — re-derive the amplitude before grading it');
}

// A player standing at a stack reads ~2 cm of rock per pixel. Step across 8 m
// (four and a half of the old 1.818 m cells) at that spacing on both axes.
const STEP_M = 0.02, SPAN_M = 8;
const N = Math.round(SPAN_M / STEP_M);
const MAX_MOTTLE_STEP = 0.06;
const brightness = (sample) => (x, z) => f32(1 + (sample(x * MOTTLE_SCALE, z * MOTTLE_SCALE) - 0.5) * SEA_ROCK_MOTTLE_SWING);
const worstAdjacentStep = (fn) => {
  let worst = 0;
  for (let i = 0; i <= N; i++) {
    const z = -SPAN_M / 2 + i * STEP_M;
    for (let j = 0; j < N; j++) {
      const x = -SPAN_M / 2 + j * STEP_M;
      worst = Math.max(worst, Math.abs(fn(x + STEP_M, z) - fn(x, z)), Math.abs(fn(x, z + STEP_M) - fn(x, z)));
    }
  }
  return worst;
};
const shipped = worstAdjacentStep(brightness(mottleSampler));
const control = worstAdjacentStep(brightness(cellHash));
expect(`sea-stack mottle: worst adjacent-sample step ${shipped.toFixed(4)} <= ${MAX_MOTTLE_STEP} (2 cm apart, 8 m patch)`,
  shipped <= MAX_MOTTLE_STEP,
  `the cell-hash control on the same measurement steps ${control.toFixed(4)}`);
expect(`the measurement can see a lattice at all (cell-hash control steps ${control.toFixed(4)} > ${MAX_MOTTLE_STEP})`,
  control > MAX_MOTTLE_STEP);

// ── 3. THE CAUSTIC ALTITUDE GATE ───────────────────────────────────────────
// Only the y-dependence is graded, so nothing about the terrain's own noise
// fields has to be mirrored. Worst case is |caustic| = 1: that is the pixel the
// contour ring was drawn on.
const ampM = TERRAIN_CAUSTIC_GLSL.match(/caustic \* ([\d.]+) \* \(1\.0 - subm\) \* causticBand/);
if (!ampM) die('cannot parse the shallow caustic amplitude out of TERRAIN_CAUSTIC_GLSL');
const CAUSTIC_AMP = Number(ampM[1]);

// Two accepted forms for the gate, and nothing else: an unknown third form must
// stop the gate rather than be graded as if it were smooth.
const bandLine = TERRAIN_CAUSTIC_GLSL.split('\n').find((l) => l.includes('causticBand ='));
if (!bandLine) die('TERRAIN_CAUSTIC_GLSL declares no causticBand');
let band;
const ss = bandLine.match(/smoothstep\(([-\d.]+), ([-\d.]+), vTerrWorld\.y\)/);
const st = bandLine.match(/step\(vTerrWorld\.y, ([-\d.]+)\)/);
if (ss) {
  const [e0, e1] = [Number(ss[1]), Number(ss[2])];
  band = (y) => { const t = Math.min(1, Math.max(0, (y - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
} else if (st) {
  const edge = Number(st[1]);
  band = (y) => (y <= edge ? 1 : 0);
} else {
  die(`causticBand is neither a step() nor a smoothstep() of vTerrWorld.y — this gate cannot grade "${bandLine.trim()}"`);
}

const DY = 0.01, MAX_BAND_STEP = 0.04;
let worstBand = 0, worstY = 0;
for (let y = -0.5; y <= 3; y += DY) {
  const d = Math.abs(band(y + DY) - band(y)) * CAUSTIC_AMP;
  if (d > worstBand) { worstBand = d; worstY = y; }
}
expect(`caustic altitude gate: worst modulation change per 1 cm of height ${worstBand.toFixed(4)} <= ${MAX_BAND_STEP} (worst at y=${worstY.toFixed(2)} m)`,
  worstBand <= MAX_BAND_STEP,
  `a step() gate changes it by the full ${CAUSTIC_AMP} amplitude across one contour — a hard ring around every coast`);

// ── 4-5. THE CAUSTIC BEARINGS ──────────────────────────────────────────────
const bearings = [...TERRAIN_CAUSTIC_GLSL.matchAll(/dot\(tP, vec2\(([-\d.]+), ([-\d.]+)\)\)/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
expect('caustics read the domain-warped point tP on two bearings (not bare world x and z)',
  bearings.length === 2 && !/sin\(vTerrWorld\.[xz] \*/.test(TERRAIN_CAUSTIC_GLSL),
  `found ${bearings.length} dot(tP, ...) bearings in:\n     ${TERRAIN_CAUSTIC_GLSL.trim().replace(/\n/g, '\n     ')}`);
if (bearings.length === 2) {
  const offAxis = bearings.every(([a, b]) => Math.abs(a) > 0.1 && Math.abs(b) > 0.1);
  const [[ax, ay], [bx, by]] = bearings;
  const cross = Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
  expect('both caustic bearings are off the world axes and not parallel to each other',
    offAxis && cross > 0.2,
    `bearings ${JSON.stringify(bearings)}, |sin(angle between)| = ${cross.toFixed(3)}`);
}
// On the low tier tP is unwarped, so the phase noise is the ONLY thing standing
// between this field and a rotated checker.
const phases = TERRAIN_CAUSTIC_GLSL.split('\n').filter((l) => /^float c[AB] = sin\(/.test(l.trim()));
expect('every caustic sine is phase-modulated by a terrain noise octave (the low-tier grid breaker)',
  phases.length === 2 && phases.every((l) => /\bn(Mid|Fine|Macro|Grain|Grit)\b/.test(l)),
  phases.join('\n     '));

console.log(failures === 0 ? '\nPASS test-shader-lattice' : `\nFAIL test-shader-lattice (${failures})`);
process.exit(failures === 0 ? 0 : 1);
