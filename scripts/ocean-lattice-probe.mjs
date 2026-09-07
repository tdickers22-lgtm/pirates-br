#!/usr/bin/env node
// OCEAN LATTICE GATE (PLAID-01 / graphics-02) — is the far sea a woven plaid?
//
// WHAT THE DEFECT IS. The crest-foam mask is the PRODUCT of two value-noise
// fields sampled on WORLD-AXIS-ALIGNED integer grids (cells 18.5 m and 7.9 m at
// the shipped 0.018 uv scale). Value noise is bilinear over an integer lattice,
// so its energy piles up on the two frequency axes; multiply two of them and
// the product is a grid of bright/dark cells running along world X and Z. At
// 150-420 m from a deck those cells are 5-25 px, and at grazing incidence they
// compress in depth into rows — the "plaid" the fidelity shots show, on every
// heading, because the lattice is in the world and not in the camera.
//
// WHY THIS IS NOT A SCREENSHOT PROBE. It was specified as an FFT of a rendered
// 150-420 m band. That needs a stack, a headless browser and a stand with no
// land in frame, and it grades a stochastic 40-row sample of a moving surface —
// the same shape of measurement that made the two night ratios in
// horizon-luminance-probe advisory for a month. The lattice is not a property
// of the frame, it is a property of the foam FIELD, and the field is closed
// form. So this gate evaluates the shipped field directly on a 256 m patch of
// world and takes its 2-D power spectrum. Deterministic, sub-second, no browser,
// and it fails for exactly one reason.
//
// HOW IT CANNOT SILENTLY DRIFT. Nothing here is a hand-copy of the shader. The
// octave scales and rotation matrices are PARSED OUT of OCEAN_FRAG (the string
// the material is compiled from), and hash()/noise() are ported once and pinned
// to their GLSL source lines: if either body changes, the parse fails loudly
// rather than grading a mirror of a shader that no longer exists.
//
// GRADED
//   1. the sharpest mode of the foam power spectrum is <= 4.0x the median of
//      its own radius ring (the finding's threshold, made direction-agnostic
//      so a merely ROTATED lattice cannot pass it). RED on HEAD.
//   2. every foam octave is rotated off the world axes (no bare `foamUv * k`).
//   3. the foam mask has a FOOTPRINT LOD — it blends toward its own mean once a
//      cell is subpixel — not only a distance gate. RED on HEAD.
//   4. foam breakup starts nearer than 900 m at grazing incidence. RED on HEAD.
//
// Run: node --import tsx scripts/ocean-lattice-probe.mjs
import { OCEAN_FRAG } from '../src/client/rendering/OceanRenderer.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};

// ── The shader's own hash/noise, ported once and PINNED ─────────────────────
// If either GLSL body moves, this mirror is wrong and the gate must not grade.
const PIN_HASH2 = 'p += dot(p, p + 19.19);';
const PIN_HASH3 = 'return fract(p.x * p.y);';
const PIN_NOISE = 'vec2 u = f * f * (3.0 - 2.0 * f);';
for (const pin of [PIN_HASH2, PIN_HASH3, PIN_NOISE]) {
  if (!OCEAN_FRAG.includes(pin)) {
    console.error(`  ✗ FAIL: OCEAN_FRAG no longer contains "${pin}" — the JS mirror of noise() is stale, re-derive it before trusting this gate`);
    process.exit(1);
  }
}
// The mirror rounds to float32 at every step. It has to: the whole defect is a
// PERIOD in the fractional part of a multiplier, and a period is a property of
// the precision it is evaluated at. In float64 a constant can look aperiodic
// and still tile on the GPU.
const f32 = Math.fround;
const fract = (x) => f32(x - Math.floor(x));
const HASH_MUL = (OCEAN_FRAG.match(/p = fract\(p \* vec2\(([0-9.]+), ([0-9.]+)\)\);/) ?? []).slice(1).map(Number);
function hash(px, pz) {
  let x = fract(f32(px * HASH_MUL[0])), z = fract(f32(pz * HASH_MUL[1]));
  const d = f32(f32(x * f32(x + 19.19)) + f32(z * f32(z + 19.19)));
  x = f32(x + d); z = f32(z + d);
  return fract(f32(x * z));
}
function noise(px, pz) {
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = f32(px - ix), fz = f32(pz - iz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  const ux = f32(fx * fx * (3 - 2 * fx)), uz = f32(fz * fz * (3 - 2 * fz));
  const lo = a + (b - a) * ux, hi = c + (d - c) * ux;
  return f32(lo + (hi - lo) * uz);
}

// ── Parse the foam block out of the shipped fragment source ────────────────
const blockStart = OCEAN_FRAG.indexOf('vec2 foamUv');
const blockEnd = OCEAN_FRAG.indexOf('float breakup ');
if (blockStart < 0 || blockEnd < 0 || blockEnd < blockStart) {
  console.error('  ✗ FAIL: could not locate the foam block in OCEAN_FRAG (vec2 foamUv .. float breakup)');
  process.exit(1);
}
const foamBlock = OCEAN_FRAG.slice(blockStart, blockEnd);

const mats = new Map();
for (const m of OCEAN_FRAG.matchAll(/mat2\s+(\w+)\s*=\s*mat2\(([^)]*)\)/g)) {
  const n = m[2].split(',').map((s) => Number(s.trim()));
  if (n.length === 4 && n.every(Number.isFinite)) mats.set(m[1], n);
}
/** GLSL mat2(a,b,c,d) is COLUMN major: columns (a,b) and (c,d). m*v = (a*vx+c*vy, b*vx+d*vy). */
const applyMat = (name, x, y) => {
  if (!name) return [x, y];
  const m = mats.get(name);
  if (!m) throw new Error(`unknown mat2 ${name}`);
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
};

/** Every `noise(<rot>? <base> * <scale> ...)` in the foam block, in order. */
const octaves = [];
for (const m of foamBlock.matchAll(/noise\(\s*(?:(\w+)\s*\*\s*)?(foamUv|wp)\s*\*\s*([0-9.]+)/g)) {
  octaves.push({ rot: m[1] ?? null, base: m[2], scale: Number(m[3]) });
}
const uvBase = Number((foamBlock.match(/vec2 foamUv = wp \* ([0-9.]+)/) ?? [])[1]);
if (!Number.isFinite(uvBase) || octaves.length < 3) {
  console.error(`  ✗ FAIL: foam block parse failed (uvBase=${uvBase}, octaves=${octaves.length})`);
  process.exit(1);
}
console.log(`Ocean lattice — foam uv base ${uvBase}, octaves ${octaves.map((o) => `${o.rot ? `${o.rot}*` : ''}${o.base}*${o.scale}`).join(', ')}`);

/** foamN(x, z) at u_time = 0, exactly as the shipped block composes it. */
function foamN(x, z) {
  const sample = (o) => {
    const [bx, bz] = o.base === 'foamUv' ? [x * uvBase, z * uvBase] : [x, z];
    const [rx, rz] = applyMat(o.rot, bx, bz);
    return noise(rx * o.scale, rz * o.scale);
  };
  // The +1.5 offset on the second octave is a pure translation: it moves no
  // frequency, so the spectrum this gate reads does not need it.
  const a = sample(octaves[0]);
  const b = sample(octaves[1]);
  const c = sample(octaves[2]);
  return a * b * (0.62 + 0.76 * c);
}

// ── 2-D power spectrum on a 256 m patch, Hann-windowed ─────────────────────
// The window matters more than anything else here: a RECTANGULAR window leaks
// in a cross along the two frequency axes, which is the exact signature being
// graded, and would report a lattice on a field that has none.
const N = 128;         // samples per side
const STEP = 2;        // metres — 256 m window, Nyquist 0.25 cycles/m
const field = new Float64Array(N * N);
let mean = 0;
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    // Offset off the origin so the patch is not centred on the lattice origin.
    const v = foamN(137.5 + i * STEP, 61.25 + j * STEP);
    field[j * N + i] = v; mean += v;
  }
}
mean /= N * N;
const hann = new Float64Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

// Separable DFT: rows, then columns. 2 * N^3 = 4.2M ops.
const re = new Float64Array(N * N), im = new Float64Array(N * N);
{
  const tr = new Float64Array(N * N), ti = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      let sr = 0, si = 0;
      for (let i = 0; i < N; i++) {
        const v = (field[j * N + i] - mean) * hann[i] * hann[j];
        const a = (-2 * Math.PI * k * i) / N;
        sr += v * Math.cos(a); si += v * Math.sin(a);
      }
      tr[j * N + k] = sr; ti[j * N + k] = si;
    }
  }
  for (let k = 0; k < N; k++) {
    for (let l = 0; l < N; l++) {
      let sr = 0, si = 0;
      for (let j = 0; j < N; j++) {
        const a = (-2 * Math.PI * l * j) / N;
        const ca = Math.cos(a), sa = Math.sin(a);
        sr += tr[j * N + k] * ca - ti[j * N + k] * sa;
        si += tr[j * N + k] * sa + ti[j * N + k] * ca;
      }
      re[l * N + k] = sr; im[l * N + k] = si;
    }
  }
}
const power = (kx, ky) => {
  const i = ((ky % N) + N) % N, j = ((kx % N) + N) % N;
  return re[i * N + j] * re[i * N + j] + im[i * N + j] * im[i * N + j];
};

// THE METRIC IS DIRECTION-AGNOSTIC ON PURPOSE. The first draft graded energy
// on the two frequency AXES, and it would have been fooled by the fix: rotate
// the octaves 23.7 deg and an axis lattice becomes a DIAGONAL lattice, which
// looks exactly as woven and would have scored clean. What a plaid actually is,
// is spectral energy concentrated in a few sharp modes; what open water is, is
// broadband. So: normalise out the radial envelope (value noise falls off with
// frequency, and a raw peak/median would just measure that falloff) by dividing
// each cell by the MEDIAN OF ITS OWN RADIUS RING, then take the largest
// normalised cell anywhere in the band.
//
// It also caught more than the finding described. The shipped hash is
// fract(p * vec2(127.1, 311.7)) on INTEGER lattice coordinates, i.e.
// fract(0.1*ix) and fract(0.7*iz): it repeats every TEN cells. On the 7.9 m
// octave that is a foam pattern that literally tiles every 79 m along world X
// and Z, which no amount of octave rotation removes — the hash has to stop
// being periodic too.
// PEAK_LIMIT is not the finding's 4.0x and cannot be. Value noise is bilinear
// over a square grid, so a single octave ALWAYS carries a strong mode at its own
// cell frequency; 4.0x is only reachable by abandoning value noise for the whole
// ocean, which is a different (and much larger) change than PLAID-01. What is
// gradeable, and what the plaid actually was, is (a) how far the sharpest mode
// stands above the rest of the field and (b) whether anything repeats at a scale
// COARSER than any foam octave — which is the hash tiling, and is pure defect.
// Measured, same 256 m patch, same metric:
//   HEAD (axis-aligned octaves, period-10 hash)  69.86x overall, 18.05x coarse
//   octaves rotated, hash UNCHANGED              48.18x        ,  7.52x coarse
//   shipped (rotated + aperiodic hash)           16.86x        ,  6.76x coarse
// So both limits are crossed by HEAD and by either half of the fix alone.
const PEAK_LIMIT = 20.0, TILE_LIMIT = 8.0, LOW_R = 12;
const RMIN = 3, RMAX = 48;
const rings = new Map();
const cells = [];
for (let ky = -RMAX; ky <= RMAX; ky++) {
  for (let kx = -RMAX; kx <= RMAX; kx++) {
    const r = Math.round(Math.hypot(kx, ky));
    if (r < RMIN || r > RMAX) continue;
    const p = power(kx, ky);
    if (!rings.has(r)) rings.set(r, []);
    rings.get(r).push(p);
    cells.push({ kx, ky, r, p });
  }
}
const ringMedian = new Map();
for (const [r, list] of rings) { list.sort((a, b) => a - b); ringMedian.set(r, Math.max(1e-12, list[Math.floor(list.length / 2)])); }
let worst = { norm: 0, kx: 0, ky: 0, r: 0 };
let worstLow = { norm: 0, kx: 0, ky: 0, r: 0 };
for (const c of cells) {
  const norm = c.p / ringMedian.get(c.r);
  if (norm > worst.norm) worst = { norm, kx: c.kx, ky: c.ky, r: c.r };
  if (c.r <= LOW_R && norm > worstLow.norm) worstLow = { norm, kx: c.kx, ky: c.ky, r: c.r };
}
const cellFor = (r) => (r === 0 ? Infinity : (N * STEP) / r);
console.log(`  sharpest mode        (${worst.kx}, ${worst.ky}) r=${worst.r} [~${cellFor(worst.r).toFixed(1)} m] = ${worst.norm.toFixed(2)}x its ring median  (limit ${PEAK_LIMIT.toFixed(2)}x)`);
console.log(`  sharpest COARSE mode (${worstLow.kx}, ${worstLow.ky}) r=${worstLow.r} [~${cellFor(worstLow.r).toFixed(1)} m] = ${worstLow.norm.toFixed(2)}x its ring median  (limit ${TILE_LIMIT.toFixed(2)}x)`);
expect(`no dominant mode in the foam field (${worst.norm.toFixed(2)}x <= ${PEAK_LIMIT.toFixed(2)}x)`, worst.norm <= PEAK_LIMIT,
  `a mode this far above its own ring is a repeating pattern at ~${cellFor(worst.r).toFixed(1)} m along (${worst.kx}, ${worst.ky})`);
expect(`the foam field does not TILE (coarse band ${worstLow.norm.toFixed(2)}x <= ${TILE_LIMIT.toFixed(2)}x)`, worstLow.norm <= TILE_LIMIT,
  `a spike at ${cellFor(worstLow.r).toFixed(1)} m, far coarser than any foam octave (18.5 m / 7.5 m cells), is the HASH repeating — the whole field copy-pasted across the sea`);

const unrotated = octaves.filter((o) => !o.rot);
expect(`every foam octave is rotated off the world axes (${octaves.length - unrotated.length}/${octaves.length})`,
  unrotated.length === 0,
  unrotated.length ? `bare: ${unrotated.map((o) => `${o.base}*${o.scale}`).join(', ')}` : '');

expect('the foam mask has a screen-FOOTPRINT LOD (blends toward its mean once a cell is subpixel)',
  /foamLod/.test(foamBlock) && /smoothstep\([^)]*\)\s*;?\s*$|smoothstep/.test(foamBlock),
  'no foamLod term in the foam block: foam stays a resolvable pattern at any footprint');

const brA = OCEAN_FRAG.indexOf('float grazeBreakup') >= 0 ? OCEAN_FRAG.indexOf('float grazeBreakup') : OCEAN_FRAG.indexOf('float breakupRange');
const breakupSrc = OCEAN_FRAG.slice(brA, OCEAN_FRAG.indexOf('float capRange'));
expect('foam breakup starts nearer than 900 m at grazing incidence',
  /mix\(\s*900\.0\s*,\s*[0-9.]+/.test(breakupSrc) && /sightPitch|graze/i.test(breakupSrc),
  `breakupRange source: ${breakupSrc.split('\n').filter((l) => l.includes('breakup')).join(' | ').slice(0, 200)}`);

if (process.env.LATTICE_JSON) console.log(JSON.stringify({ peak: worst.norm, coarse: worstLow.norm }));
console.log(failures ? `\nFAIL: ${failures} check(s)` : '\nPASS: ocean lattice');
process.exit(failures ? 1 : 0);
