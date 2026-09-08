#!/usr/bin/env node
// GRADE GATE (GFXPOL-01 / graphics-11) — the colour grade existed on ONE tier
// and was four scalars.
//
// WHAT THE DEFECT WAS. `makeOutputPass(quality === 'high')`: a player on
// balanced got raw tone-mapped output — no vignette, no lift, no saturation —
// while a player on high got the graded image, so the game had two different
// looks depending on a settings menu. And the grade itself was gamma, lift,
// saturation and vignette: four scalars, none of which changes HUE with
// exposure, which is the one thing every graded frame does.
//
// WHAT SHIPS NOW. The grade runs on every tier that has a composer (low never
// builds one), and it carries a SPLIT TONE: sea slate into the shadows, lantern
// brass into the highlights, both centred on a pivot so mid grey does not move.
// That is the LUT, evaluated analytically — no 3D texture, no extra fetch, no
// extra pass; the whole thing is still spliced into OutputPass.
//
// HOW IT CANNOT SILENTLY DRIFT. `GRADE_BODY` and `GRADE_SETTINGS` are IMPORTED —
// the string is the one spliced into the OutputPass fragment shader and the
// numbers are the ones written into its uniforms. The JS mirror is pinned line
// by line to that string; if the shader changes the gate exits loudly instead of
// grading a fiction.
//
// GRADED
//   1. the mirror still matches the shipped body (pins).
//   2. the grade is on for balanced AND high, off only where there is no
//      composer at all.
//   3. it is still not a pass: no texture fetch and no loop in the body.
//   4. mid grey stays neutral (chroma <= 0.02) — a grade that tints the whole
//      image is a broken white balance, not a look.
//   5. the split tone actually splits: shadows read cooler than highlights by
//      >= 0.02 in blue-minus-red. RED under a zero-tint mutation.
//   6. the neutral ramp stays monotonic and inside [0,1]: no crushed band, no
//      inverted step, nothing a player would read as banding.
//
// Run: node --import tsx scripts/test-grade.mjs
import { GRADE_BODY, GRADE_SETTINGS, gradeEnabledFor } from '../src/client/rendering/PostFx.ts';

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
};
const die = (why) => { console.error(`  ✗ FAIL: ${why}`); process.exit(1); };

const PINS = [
  'col = pow(col, vec3(u_gamma));',
  'col = col * (1.0 - u_lift) + u_lift;',
  'float shadowW = 1.0 - smoothstep(0.0, u_splitPivot, luma);',
  'float highW = smoothstep(u_splitPivot, 1.0, luma);',
  'col += u_shadowTint * shadowW + u_highlightTint * highW;',
  'col = clamp(mix(vec3(luma), col, u_saturation), 0.0, 1.0);',
  'float edge = smoothstep(0.42, 1.12, length(vUv - 0.5) * 1.55);',
  'col *= 1.0 - u_vignette * edge;',
];
for (const pin of PINS) {
  if (!GRADE_BODY.includes(pin)) die(`GRADE_BODY no longer contains "${pin}" — the JS mirror is stale, re-derive it before trusting this gate`);
}
console.log('  ✓ the JS mirror is pinned to the shipped GRADE_BODY');

const S = GRADE_SETTINGS;
const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const LUMA = [0.2126, 0.7152, 0.0722];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The mirror. uv is the fragment's vUv; pass [0.5, 0.5] for the frame centre. */
const grade = (rgb, uv = [0.5, 0.5]) => {
  let col = rgb.map((c) => Math.max(c, 0));
  col = col.map((c) => c ** S.gamma);
  col = col.map((c, i) => c * (1 - S.lift[i]) + S.lift[i]);
  let luma = dot3(col, LUMA);
  const shadowW = 1 - sstep(0, S.splitPivot, luma);
  const highW = sstep(S.splitPivot, 1, luma);
  col = col.map((c, i) => c + S.shadowTint[i] * shadowW + S.highlightTint[i] * highW);
  luma = dot3(col.map((c) => Math.max(c, 0)), LUMA);
  col = col.map((c) => Math.min(1, Math.max(0, luma + (c - luma) * S.saturation)));
  const edge = sstep(0.42, 1.12, Math.hypot(uv[0] - 0.5, uv[1] - 0.5) * 1.55);
  return col.map((c) => c * (1 - S.vignette * edge));
};

// ── 2. every tier that has a composer is graded ────────────────────────────
expect('the grade is on for balanced and high, and only "low" (which builds no composer) is ungraded',
  gradeEnabledFor('balanced') && gradeEnabledFor('high') && !gradeEnabledFor('low'),
  `balanced=${gradeEnabledFor('balanced')} high=${gradeEnabledFor('high')} low=${gradeEnabledFor('low')}`);

// ── 3. still not a pass ────────────────────────────────────────────────────
expect('the grade takes no texture fetch and no loop (a 3D LUT would be a fetch on every output fragment)',
  !/texture2D\(|texture\(|textureLod\(|for\s*\(/.test(GRADE_BODY), GRADE_BODY);

// ── 4. mid grey stays neutral ──────────────────────────────────────────────
const chroma = (c) => Math.max(...c) - Math.min(...c);
const mid = grade([0.5, 0.5, 0.5]);
expect(`mid grey stays neutral (chroma ${chroma(mid).toFixed(4)} <= 0.02)`, chroma(mid) <= 0.02,
  `graded mid grey = [${mid.map((c) => c.toFixed(4)).join(', ')}]`);

// ── 5. the split tone splits ───────────────────────────────────────────────
const shadow = grade([0.12, 0.12, 0.12]), high = grade([0.88, 0.88, 0.88]);
const coolness = (c) => c[2] - c[0];
const split = coolness(shadow) - coolness(high);
expect(`the split tone splits: shadows read ${split.toFixed(4)} cooler than highlights in blue-minus-red (>= 0.02)`,
  split >= 0.02,
  `shadow [${shadow.map((c) => c.toFixed(3)).join(', ')}] highlight [${high.map((c) => c.toFixed(3)).join(', ')}] — with zero tints this is 0.0000 and the grade is still just four scalars`);

// ── 6. the neutral ramp is monotonic and bounded ───────────────────────────
let worstBack = 0, outOfRange = 0, worstStep = 0, prev = -1;
for (let i = 0; i <= 1000; i++) {
  const v = i / 1000;
  const g = grade([v, v, v]);
  const l = dot3(g, LUMA);
  if (g.some((c) => !(c >= 0 && c <= 1))) outOfRange++;
  if (prev >= 0) { worstBack = Math.min(worstBack, l - prev); worstStep = Math.max(worstStep, l - prev); }
  prev = l;
}
expect(`the neutral ramp never goes backwards (worst step ${worstBack.toFixed(6)} >= 0)`, worstBack >= 0);
expect(`the neutral ramp has no jump a player would read as a band (worst rise ${worstStep.toFixed(4)} <= 0.01 per 0.1% of input)`, worstStep <= 0.01);
expect(`every graded value stays inside [0,1] (${outOfRange} out of range)`, outOfRange === 0);

// The vignette still only darkens, and only off-centre.
const corner = grade([0.6, 0.6, 0.6], [0, 0]), centre = grade([0.6, 0.6, 0.6]);
expect(`the vignette darkens the corner (${dot3(corner, LUMA).toFixed(3)}) below the centre (${dot3(centre, LUMA).toFixed(3)})`,
  dot3(corner, LUMA) < dot3(centre, LUMA) * 0.95);

console.log(failures === 0 ? '\nPASS test-grade' : `\nFAIL test-grade (${failures})`);
process.exit(failures === 0 ? 0 : 1);
