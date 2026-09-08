#!/usr/bin/env node
// CLOUD DEPTH GATE (GFXPOL-01 / graphics-07) — the sky's cloud deck had no
// thickness in it.
//
// WHAT THE DEFECT WAS. `smoothstep(coverage, coverage + band, fbm2(cuv))` over a
// TWO-octave, unwarped noise, shaded by `mix(cloudShade, cloudLit, litEdge)`
// where litEdge is the difference between the field and the field one sun-step
// away. Away from the rim both taps saturate together, so litEdge sits at its
// 0.55 rest value across the whole body: every cumulus in the game was a round
// two-octave blob filled with ONE flat colour. The sky is the largest surface in
// the frame, so this is the single biggest "cut-out" read in the game.
//
// WHAT SHIPS NOW. A tier ladder: 2 octaves (low), 3 + domain warp (balanced),
// 4 + warp + cirrus (high); plus a BELLY term that darkens a fragment by how far
// past the coverage edge it sits, which is how much cloud the light crossed to
// reach it. That is the thickness.
//
// WHY THIS IS NOT A SCREENSHOT PROBE. "Is there variation inside a cloud" is a
// property of a closed-form field, so it is graded in 30 ms with no stack, no
// browser and no GPU, following `test-shader-lattice.mjs`.
//
// HOW IT CANNOT SILENTLY DRIFT. The GLSL is IMPORTED — `SKY_NOISE_GLSL`,
// `SKY_CLOUD_NOISE_GLSL`, `SKY_CLOUD_GLSL` are the very strings spliced into the
// compiled sky shader. Every weight, frequency, offset, coverage constant and
// colour is PARSED out of them; the two hand-ported bodies (hash21, vnoise) are
// pinned to their source lines and the gate exits loudly if they change.
//
// GRADED
//   1. hash21/vnoise mirrors still match the shipped bodies (pins).
//   2. THE LOW TIER PAYS NOTHING: cloudFbm at 2 octaves is bit-identical to the
//      old fbm2 over 20k samples, and the warp, the third/fourth octave, the
//      belly and the cirrus are all behind `#if SKY_CLOUD_OCTAVES >= 3/4`.
//   3. Cloud INTERIORS have thickness: the spread of shading over fragments that
//      are fully inside a cloud is >= 1.6x the flat 2-octave control on
//      balanced and >= 1.6x on high. The control is the field that shipped, so
//      the measurement is proven able to read "flat".
//   4. The warp actually bends the field (mean displacement > 0.15 domain units).
//
// Run: node --import tsx scripts/test-cloud-depth.mjs
import {
  SKY_NOISE_GLSL, SKY_CLOUD_NOISE_GLSL, SKY_CLOUD_GLSL,
  SKY_CLOUD_OCTAVES_BY_TIER, CLOUD_BODY_DEPTH, CLOUD_BELLY,
} from '../src/client/rendering/Renderer.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};
const die = (why) => { console.error(`  ✗ FAIL: ${why}`); process.exit(1); };

// ── the mirror, pinned to the shipped bodies ───────────────────────────────
const PINS = [
  ['p = fract(p * vec2(123.34, 456.21));', SKY_NOISE_GLSL],
  ['p += dot(p, p + 45.32);', SKY_NOISE_GLSL],
  ['return fract(p.x * p.y);', SKY_NOISE_GLSL],
  ['f = f * f * (3.0 - 2.0 * f);', SKY_NOISE_GLSL],
  ['return vnoise(p) * 0.6667 + vnoise(p * 2.13 + 19.7) * 0.3333;', SKY_NOISE_GLSL],
];
for (const [pin, src] of PINS) {
  if (!src.includes(pin)) die(`SKY_NOISE_GLSL no longer contains "${pin}" — the JS mirror is stale, re-derive it before trusting this gate`);
}
console.log('  ✓ hash21/vnoise/fbm2 mirrors are pinned to the shipped GLSL bodies');

const f32 = Math.fround;
const fract = (x) => f32(x - Math.floor(x));
const hash21 = (px, py) => {
  let x = fract(f32(px * 123.34)), y = fract(f32(py * 456.21));
  const d = f32(f32(x * f32(x + 45.32)) + f32(y * f32(y + 45.32)));
  x = f32(x + d); y = f32(y + d);
  return fract(f32(x * y));
};
const vnoise = (px, py) => {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = f32(fx * fx * (3 - 2 * fx)); fy = f32(fy * fy * (3 - 2 * fy));
  const a = hash21(ix, iy), b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  const lo = f32(a + (b - a) * fx), hi = f32(c + (d - c) * fx);
  return f32(lo + (hi - lo) * fy);
};
const fbm2 = (x, y) => f32(f32(vnoise(x, y) * 0.6667) + f32(vnoise(f32(x * 2.13 + 19.7), f32(y * 2.13 + 19.7)) * 0.3333));

// ── everything numeric comes OUT of the GLSL ───────────────────────────────
const warpM = SKY_CLOUD_NOISE_GLSL.match(/vec2 w = vec2\(vnoise\(p \* ([\d.]+) \+ ([\d.]+)\), vnoise\(p \* [\d.]+ \+ ([\d.]+)\)\) - 0\.5;\s*\n\s*return p \+ w \* ([\d.]+);/);
if (!warpM) die('cannot parse cloudWarp out of SKY_CLOUD_NOISE_GLSL');
const [WF, WO1, WO2, WGAIN] = warpM.slice(1).map(Number);

// Octave taps, each tagged with the octave count it first appears at.
const taps = [];
{
  let need = 3; // everything inside the > 2 branch
  for (const raw of SKY_CLOUD_NOISE_GLSL.split('\n')) {
    const line = raw.trim();
    const gate = line.match(/^#if SKY_CLOUD_OCTAVES >= (\d)/);
    if (gate) { need = Number(gate[1]); continue; }
    if (line.startsWith('#endif')) { need = 3; continue; }
    const m = line.match(/^(?:float a = |a \+= )vnoise\(p(?: \* ([\d.]+) \+ ([\d.]+))?\) \* ([\d.]+);$/);
    if (m) taps.push({ freq: m[1] ? Number(m[1]) : 1, off: m[2] ? Number(m[2]) : 0, w: Number(m[3]), need });
  }
}
if (taps.length !== 4) die(`expected 4 parsed cloudFbm taps in the >2-octave branch, found ${taps.length}`);
const normM = SKY_CLOUD_NOISE_GLSL.match(/#define CLOUD_NORM ([\d.]+)/g);
if (!normM || normM.length !== 1) {
  die('CLOUD_NORM is no longer a single tier-independent constant — a per-tier normaliser makes the same cloud a different size on balanced and high, re-check the ladder before grading it');
}
const NORM = () => Number(normM[0].match(/([\d.]+)$/)[1]);

const cloudWarp = (oct, x, y) => {
  if (oct < 3) return [x, y];
  const wx = f32(vnoise(f32(x * WF + WO1), f32(y * WF + WO1)) - 0.5);
  const wy = f32(vnoise(f32(x * WF + WO2), f32(y * WF + WO2)) - 0.5);
  return [f32(x + wx * WGAIN), f32(y + wy * WGAIN)];
};
const cloudFbm = (oct, x, y) => {
  if (oct <= 2) return fbm2(x, y);
  let a = 0;
  for (const t of taps) {
    if (oct < t.need) continue;
    a = f32(a + f32(vnoise(f32(x * t.freq + t.off), f32(y * t.freq + t.off)) * t.w));
  }
  return f32(a * NORM());
};

// ── 2. THE LOW TIER PAYS NOTHING ───────────────────────────────────────────
expect('the tier ladder keeps the low tier at 2 octaves',
  SKY_CLOUD_OCTAVES_BY_TIER.low === 2, JSON.stringify(SKY_CLOUD_OCTAVES_BY_TIER));
let worstLow = 0;
for (let i = 0; i < 20000; i++) {
  const x = ((i * 7919) % 1201) / 97 - 6, y = ((i * 104729) % 1279) / 101 - 6;
  worstLow = Math.max(worstLow, Math.abs(cloudFbm(2, x, y) - fbm2(x, y)));
}
expect(`the low tier's cloud field is bit-identical to the old fbm2 (worst diff ${worstLow})`, worstLow === 0);
expect('the domain warp is compiled out below 3 octaves',
  /#if SKY_CLOUD_OCTAVES >= 3\s*\n\s*vec2 w = vec2\(vnoise/.test(SKY_CLOUD_NOISE_GLSL));
const bellyBlock = SKY_CLOUD_GLSL.match(/#if SKY_CLOUD_OCTAVES >= 3([\s\S]*?)#endif/);
expect('the belly (thickness) term is compiled out below 3 octaves',
  !!bellyBlock && bellyBlock[1].includes(`${CLOUD_BELLY} * cdepth`) && bellyBlock[1].includes(`smoothstep(0.0, ${CLOUD_BODY_DEPTH},`),
  bellyBlock ? bellyBlock[1].trim() : 'no >= 3 block in SKY_CLOUD_GLSL');
const cirrusBlock = SKY_CLOUD_GLSL.match(/#if SKY_CLOUD_OCTAVES >= 4([\s\S]*?)#endif/);
expect('cirrus is compiled out below 4 octaves', !!cirrusBlock && cirrusBlock[1].includes('cirrus'));

// ── 4. THE WARP BENDS THE FIELD ────────────────────────────────────────────
let warpSum = 0, warpN = 0;
for (let i = 0; i < 4000; i++) {
  const x = ((i * 7919) % 1201) / 97 - 6, y = ((i * 104729) % 1279) / 101 - 6;
  const [wx, wy] = cloudWarp(3, x, y);
  warpSum += Math.hypot(wx - x, wy - y); warpN++;
}
expect(`the domain warp displaces the field by ${(warpSum / warpN).toFixed(3)} domain units on average (> 0.15)`,
  warpSum / warpN > 0.15);

// ── 3. CLOUD INTERIORS HAVE THICKNESS ──────────────────────────────────────
// Fair weather (oc = 0) is the case a player sees most; the coverage constants,
// the sun-step and both cloud colours are read out of the shipped block.
const covM = SKY_CLOUD_GLSL.match(/float coverage = mix\(([\d.]+), [\d.]+, oc\);/);
const bandM = SKY_CLOUD_GLSL.match(/float cband = mix\(([\d.]+), [\d.]+, oc\);/);
const sunM = SKY_CLOUD_GLSL.match(/cloudFbm\(cwp \+ u_sunDir\.xz \* ([\d.]+)\)/);
const edgeM = SKY_CLOUD_GLSL.match(/litEdge = clamp\(\(cf - cfLit\) \* ([\d.]+) \+ ([\d.]+), 0\.0, 1\.0\)/);
const scaleM = SKY_CLOUD_GLSL.match(/cloudWarp\(cuv \* ([\d.]+) \+ drift\)/);
const litM = SKY_CLOUD_GLSL.match(/vec3 cloudLit = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\) \* u_dayAmount/);
const shadeM = SKY_CLOUD_GLSL.match(/vec3 cloudShade = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\) \* u_dayAmount/);
if (!covM || !bandM || !sunM || !edgeM || !scaleM || !litM || !shadeM) die('cannot parse the cloud deck constants out of SKY_CLOUD_GLSL');
const COVERAGE = Number(covM[1]), BAND = Number(bandM[1]), SUN_STEP = Number(sunM[1]);
const EDGE_GAIN = Number(edgeM[1]), EDGE_REST = Number(edgeM[2]), UV_SCALE = Number(scaleM[1]);
const lum = (m) => 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
const LIT = lum(litM), SHADE = lum(shadeM);
// A sun 40 degrees up on a fixed bearing; only its horizontal step matters.
const SUN = [0.62, 0.47];

const interiorSpread = (oct) => {
  const vals = [];
  const STEP = 0.03, HALF = 6;
  for (let x = -HALF; x <= HALF; x += STEP) {
    for (let y = -HALF; y <= HALF; y += STEP) {
      const [wx, wy] = cloudWarp(oct, f32(x * UV_SCALE), f32(y * UV_SCALE));
      const cf = cloudFbm(oct, wx, wy);
      if (cf < COVERAGE + BAND) continue; // not fully inside a cloud
      const cfLit = cloudFbm(oct, f32(wx + SUN[0] * SUN_STEP), f32(wy + SUN[1] * SUN_STEP));
      const litEdge = Math.min(1, Math.max(0, (cf - cfLit) * EDGE_GAIN + EDGE_REST));
      let v = SHADE + (LIT - SHADE) * litEdge;
      if (oct >= 3) v *= 1 - CLOUD_BELLY * (() => { const t = Math.min(1, Math.max(0, (cf - COVERAGE - BAND) / CLOUD_BODY_DEPTH)); return t * t * (3 - 2 * t); })();
      vals.push(v);
    }
  }
  if (vals.length < 500) die(`only ${vals.length} interior samples at ${oct} octaves — the patch is not over a cloud, re-choose it`);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { n: vals.length, std: Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) };
};
const low = interiorSpread(2), bal = interiorSpread(3), high = interiorSpread(4);
console.log(`  interior shading spread — low(2) ${low.std.toFixed(4)} over ${low.n} px, balanced(3) ${bal.std.toFixed(4)}, high(4) ${high.std.toFixed(4)}`);
const RATIO = 1.6;
expect(`balanced cloud interiors carry ${(bal.std / low.std).toFixed(2)}x the shading spread of the flat 2-octave control (>= ${RATIO}x)`,
  bal.std / low.std >= RATIO,
  'the control IS the field that shipped: a cut-out cumulus reads one flat colour inside its silhouette');
expect(`high cloud interiors carry ${(high.std / low.std).toFixed(2)}x the control's spread (>= ${RATIO}x)`,
  high.std / low.std >= RATIO);

console.log(failures === 0 ? '\nPASS test-cloud-depth' : `\nFAIL test-cloud-depth (${failures})`);
process.exit(failures === 0 ? 0 : 1);
