#!/usr/bin/env node
// OCEANTIER-01 (perf-06, graphics-12) — THE OCEAN GETS THREE PROGRAMS, NOT ONE.
//
// The sea covers 45-55% of every frame and its fragment shader is the heaviest
// in the game, and until now every quality tier compiled the IDENTICAL one: a
// machine that opened on 'low' solved the full Gerstner field, a sixteen-ellipse
// shore SDF, three ripple octaves and three foam octaves per pixel, exactly like
// a desktop on 'high'. The geometry had tiers (LOD_LEVELS); the fill did not.
//
// WHAT THIS GRADES, with no stack and no rasteriser (30 ms):
//   • OCEAN_TIER is a real compile-time define on BOTH ocean programs (the
//     maskless one and the HULL_MASK variant), and it is derived from the same
//     RenderQuality the rest of the renderer takes from ?quality;
//   • the fragment op count falls tier by tier, under a ceiling each — the
//     count comes from scripts/lib/glsl-ops.mjs, which expands user functions at
//     their call sites and unrolls constant loops, and counts a runtime `if` at
//     its worst case (on the ocean the near band IS the frame from a deck);
//   • the VERTEX stage is identical at every tier, and still solves the whole
//     wave field — this is the parity rule, not a preference. The drawn surface
//     is the one the physics samples (shared gerstnerHeight); a tier that
//     displaced its water differently would put a swimmer's head through the
//     sea on one machine and not on another. What tiers move is SHADING;
//   • the far-field escapes that must survive any later edit: the foam fbm is
//     skipped past 2,400 m at every tier, and the low tier reads its normal,
//     shore distance and sea state off varyings rather than re-deriving them;
//   • ProgramWarmup keys on receiveShadow, which is what makes the ocean's two
//     shadow variants two warmed programs instead of one warmed and one linked
//     at draw time on the surface that covers half the frame.
//
// Numbers, measured by the model here (they are ALU/fetch ops, not nanoseconds,
// and not comparable to the coarser ~470 quoted in the campaign plan — same
// ratios, different scale): high 1709, balanced 1369 (80%), low 897 (52%).
//
//   node --import tsx scripts/test-ocean-tier.mjs
//   node --import tsx scripts/test-ocean-tier.mjs --mutate   (must FAIL)
//
// --mutate grades the low tier through the tier-2 preprocessor, i.e. exactly
// what HEAD shipped before this lane: one program for everybody.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fragmentOps, preprocess } from './lib/glsl-ops.mjs';

const MUTATE = process.argv.includes('--mutate');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const Ocean = await import('../src/client/rendering/OceanRenderer.ts');
const src = read('src/client/rendering/OceanRenderer.ts');

console.log(`Ocean fill tiers (OCEANTIER-01)${MUTATE ? '  [MUTATED: low graded as tier 2]' : ''}`);

// ── the define exists, and it is the quality the renderer already has ────
expect('OCEAN_TIER maps the three qualities to 0/1/2',
  Ocean.OCEAN_TIER?.low === 0 && Ocean.OCEAN_TIER?.balanced === 1 && Ocean.OCEAN_TIER?.high === 2,
  JSON.stringify(Ocean.OCEAN_TIER));
expect('the maskless program carries the define',
  /defines:\s*\{\s*OCEAN_TIER:\s*OCEAN_TIER\[quality\]\s*\}/.test(src));
expect('the HULL_MASK program carries the SAME define',
  /defines:\s*\{\s*HULL_MASK:\s*'1',\s*OCEAN_TIER:\s*OCEAN_TIER\[quality\]\s*\}/.test(src));

// ── the count falls, tier by tier, under a ceiling each ──────────────────
const CEIL = { low: 950, balanced: 1400, high: 1750 };
const ops = {
  low: fragmentOps(Ocean.OCEAN_FRAG, { OCEAN_TIER: MUTATE ? 2 : 0, SHADOW: false }),
  balanced: fragmentOps(Ocean.OCEAN_FRAG, { OCEAN_TIER: 1, SHADOW: false }),
  high: fragmentOps(Ocean.OCEAN_FRAG, { OCEAN_TIER: 2, SHADOW: true }),
};
console.log(`  fragment ops — low ${ops.low}, balanced ${ops.balanced}, high ${ops.high}`);
for (const tier of ['low', 'balanced', 'high']) {
  expect(`${tier} fragment ops ≤ ${CEIL[tier]}`, ops[tier] <= CEIL[tier], `measured ${ops[tier]}`);
}
const plain = fragmentOps(Ocean.OCEAN_FRAG, { OCEAN_TIER: 2, SHADOW: false });
expect('low is at most 60% of high', ops.low <= plain * 0.60, `${ops.low} vs ${plain}`);
expect('balanced is at most 85% of high', ops.balanced <= plain * 0.85, `${ops.balanced} vs ${plain}`);
expect('the tiers are strictly ordered', ops.low < ops.balanced && ops.balanced < plain,
  `${ops.low} / ${ops.balanced} / ${plain}`);

// ── PARITY: the vertex stage does not have tiers ─────────────────────────
const vert = [0, 1, 2].map((t) => preprocess(Ocean.OCEAN_VERT.replace(/\/\/[^\n]*/g, ''), { OCEAN_TIER: t, SHADOW: false }));
expect('the vertex stage is identical at every tier (one displaced surface)',
  vert[0] === vert[1] && vert[1] === vert[2]);
expect('the vertex stage still solves the whole wave field',
  /waveField\(wp\.xz, camDist\)/.test(vert[0]) && /wp\.y \+= h/.test(vert[0]));
const vertOps = fragmentOps(Ocean.OCEAN_VERT, { OCEAN_TIER: 0, SHADOW: false });
expect('the vertex stage stays under 600 ops (work moved there is per-vertex, not free)',
  vertOps <= 600, `measured ${vertOps}`);

// ── what the cheap tiers actually do instead ─────────────────────────────
const low = preprocess(Ocean.OCEAN_FRAG.replace(/\/\/[^\n]*/g, ''), { OCEAN_TIER: MUTATE ? 2 : 0, SHADOW: false });
const bal = preprocess(Ocean.OCEAN_FRAG.replace(/\/\/[^\n]*/g, ''), { OCEAN_TIER: 1, SHADOW: false });
const high = preprocess(Ocean.OCEAN_FRAG.replace(/\/\/[^\n]*/g, ''), { OCEAN_TIER: 2, SHADOW: false });
const mainOf = (t) => t.split('void main()')[1] ?? '';
expect('low takes its normal off the vertex slope, not from a per-pixel wave field',
  /v_slope/.test(low) && !/waveField\(/.test(mainOf(low)));
expect('balanced keeps a per-pixel normal in the near band',
  /waveField\(/.test(bal) && /smoothstep\(160\.0, 192\.0, camDist\)/.test(bal));
expect('high keeps the per-pixel wave field everywhere', /waveField\(wp, camDist\)/.test(high));
expect('low and balanced skip the sixteen-ellipse SDF per pixel',
  /shoreDistLod\(/.test(low) && /shoreDistLod\(/.test(bal) && /shoreDist\(wp, v_height\)/.test(high));
expect('low reads the storm sea state off a varying', /float stormSea = v_stormSea/.test(low));
// minus one for the definition itself.
const octaves = (t) => ((t.match(/noiseSlope\(/g) ?? []).length - 1);
expect('ripple octaves are a tier: 1 / 2 / 3',
  octaves(low) === (MUTATE ? 1 : 1) && octaves(bal) === 2 && octaves(high) === 3,
  `${octaves(low)}/${octaves(bal)}/${octaves(high)}`);
expect('the foam fbm is skipped past 2,400 m at EVERY tier',
  [low, bal, high].every((s) => /step\(2400\.0, viewDist\)/.test(s)));
expect('the anti-lattice mottle survives on every tier (coherence beats fill)',
  [low, bal, high].every((s) => /flankFlat/.test(s) && /noise\(wp \* 0\.021/.test(s)));

// ── the third ocean program gets warmed like the other two ───────────────
const warm = read('src/client/rendering/ProgramWarmup.ts');
expect('ProgramWarmup keys on receiveShadow (two ocean shadow variants, two warms)',
  /mesh\.receiveShadow \? 'R' : ''/.test(warm));

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
