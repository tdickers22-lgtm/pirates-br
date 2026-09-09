/**
 * The island heightfield mesh: geometry, per-vertex colour/material class, the
 * volcanic magma + summit attributes, the fragment-scale detail shader, the
 * underwater plinth skirt, and the low-res proxy the distance LOD swaps in.
 *
 * Everything here is pure geometry/colour work off the shared heightfield —
 * `IslandBuilder` owns the call order and the shared per-island scratch.
 */
import * as THREE from 'three';
import { getIslandCoastWeights } from '../../../shared/utils/index.js';
import { buildTerrainGrid, coastWobble, setIslandGround } from '../../../shared/terrainGrid.js';
import type { Island } from '../../../shared/types/index.js';
import {
  buildCaveCutout, caveCutoutGlsl, caveCutoutUniforms, type CaveCutout,
} from './CaveMouthCutout.js';
import type { IslandBuildCtx, IslandBuilderCtx } from './context.js';

/** Terrain-derived values the rest of the island build reads back: the colour
 *  bands and height references the decor scatter and the proxy LOD key off. */
export type TerrainBuild = {
  readonly seaBase: number;
  readonly peakEst: number;
  readonly shoreRingSpan: number;
  readonly rockSlopeColor: THREE.Color;
  readonly wetSandColor: THREE.Color;
  readonly submergedColor: THREE.Color;
};

/**
 * FRAGMENT-SCALE ground detail for the island terrain material.
 *
 * The terrain mesh carries vertices 4-8m apart, so 100% of its read used to
 * come from per-vertex colour: at 2m every biome collapsed into one flat
 * airbrushed smear ("vinyl"), and the cliff plinths rendered as featureless
 * whale-backs. This injects a world-space procedural detail pass that runs
 * per PIXEL — a handful of ALU ops, no textures, no extra lights, no geometry
 * and no contact with `getIslandSurfaceY` (purely a colour/roughness edit):
 *
 *  • 3 octaves of value noise (~1.8m mottle, ~0.5m patches, ~0.09m grain)
 *    keyed per material class from `aMat` (sand / grass / rock / ash), so
 *    sand speckles + ripples, grass patches, rock grains and ash chars.
 *  • Slope-gated sedimentary STRATA on steep faces — the whale-back killer.
 *  • A wet-sand band that breathes with the swell, plus an underwater floor
 *    tint and caustic mottle so the walk-in slope reads through the water.
 *  • Volcanic: hairline magma cracks evaluated per-pixel (the per-vertex
 *    field smeared them into ~10m glow bars) with the glow confined to the
 *    crack core, and a molten caldera pool from `aSummit`.
 */

/** ── THE CAUSTICS ARE NOT A CHECKERBOARD, AND THE SHALLOWS HAVE NO RING ────
 *  Shipped as `sin(x * 1.15 + t) * sin(z * 0.97 - t)` gated by
 *  `step(vTerrWorld.y, 0.6)`. Two defects a player reads on every approach:
 *
 *  1. Two WORLD-AXIS sines multiplied together are a 5.5 m x 6.5 m CHECKER of
 *     light, laid over the strip of island every landing stares at. This file
 *     argues at length above that an axis-aligned field must be domain-warped;
 *     the caustics were the one field that never got the treatment. They now
 *     read the ALREADY WARPED point `tP` on two non-axis bearings and are
 *     phase-modulated by the two detail octaves already sitting in registers.
 *     Zero new texture fetches and zero new noise evaluations on every tier
 *     (`tP`, `nMid`, `nFine` all exist even at low, where `tP` is unwarped but
 *     the phase modulation still breaks the grid); net cost is 2 `dot` and 2
 *     multiply-adds against the 2 multiplies it replaces.
 *  2. `step()` switched the whole 16% modulation on across ONE contour, drawing
 *     a hard bright ring at exactly 0.6 m around every coast in the world. A
 *     `smoothstep(0.9, 0.2, y)` spreads that switch over ~0.7 m of ground: same
 *     look, no ring, and `step` and `smoothstep` are both one op here.
 *
 *  Exported so `scripts/test-shader-lattice.mjs` grades the string that is
 *  actually compiled rather than a mirror of it. */
export const TERRAIN_CAUSTIC_GLSL =
  'float cA = sin(dot(tP, vec2(1.15, 0.31)) + nMid * 3.0 + uTerrTime * 0.7);\n'
  + 'float cB = sin(dot(tP, vec2(-0.42, 0.97)) - nFine * 2.4 - uTerrTime * 0.55);\n'
  + 'float caustic = cA * cB;\n'
  + 'float causticBand = smoothstep(0.9, 0.2, vTerrWorld.y);\n'
  + 'diffuseColor.rgb *= 1.0 + caustic * 0.16 * (1.0 - subm) * causticBand + caustic * 0.10 * subm;\n';

function applyTerrainDetail(
  material: THREE.MeshStandardMaterial, volcanic: boolean, host: IslandBuilderCtx,
  cutout: CaveCutout | null,
) {
  const pulse = host.magmaPulseUniform;
  const time = host.foliageTime;
  // Octave ladder. Every octave is a fresh value-noise fetch — four hashes,
  // each a sin() — evaluated per pixel across every scrap of visible ground, so
  // this is the single biggest fragment cost the terrain has. A fanless laptop
  // gets ONE: the ~1.8m mottle, the octave that carries the biome read, with
  // the finer bands aliasing into it. The identity survives (ground is still
  // mottled, strata still band the cliffs) — it is just coarser.
  const octaves = host.renderer.getQuality() === 'low' ? 1
    : host.renderer.getQuality() === 'balanced' ? 2 : 3;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrTime = time;
    if (volcanic) shader.uniforms.uMagmaPulse = pulse;
    if (cutout) Object.assign(shader.uniforms, caveCutoutUniforms(cutout));
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'attribute float aMat;\n'
        + 'varying vec3 vTerrWorld;\n'
        + 'varying float vTerrMat;\n'
        + 'varying float vTerrSlope;\n'
        + (volcanic ? 'attribute float aMagma;\nattribute float aSummit;\nvarying float vMagmaGate;\nvarying float vSummit;\n' : ''),
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        + 'vTerrMat = aMat;\n'
        + 'vTerrSlope = clamp(1.0 - normalize(objectNormal).y, 0.0, 1.0);\n'
        + (volcanic ? 'vMagmaGate = aMagma;\nvSummit = aSummit;\n' : ''),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'uniform float uTerrTime;\n'
        + 'varying vec3 vTerrWorld;\n'
        + 'varying float vTerrMat;\n'
        + 'varying float vTerrSlope;\n'
        + (volcanic ? 'uniform float uMagmaPulse;\nvarying float vMagmaGate;\nvarying float vSummit;\n' : '')
        + (cutout ? caveCutoutGlsl(cutout.count) : '')
        + 'float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n'
        + 'float tNoise(vec2 p) {\n'
        + '  vec2 i = floor(p); vec2 f = fract(p);\n'
        + '  vec2 u = f * f * (3.0 - 2.0 * f);\n'
        + '  float a = tHash(i), b = tHash(i + vec2(1.0, 0.0));\n'
        + '  float c = tHash(i + vec2(0.0, 1.0)), d = tHash(i + vec2(1.0, 1.0));\n'
        + '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n'
        + '}\n'
        // ── WHY THE DETAIL OCTAVES ARE NOT VALUE NOISE ─────────────────────
        // tNoise is bilinear VALUE noise: one scalar per lattice corner,
        // smoothstepped between them. Every cell is therefore a little dome or
        // bowl with a flat-ish middle and its extremum ON the grid, and three
        // such octaves — even rotated, even domain-warped — put a repeating
        // 0.3-0.5m knit across a whole lawn. It is the hexagonal weave the
        // review photographed at eye level on Astra's own verification shot,
        // and it is worse on the LOW tier, which collapses the three octaves
        // onto one and builds no ground cover to hide it (graded: spectral peak
        // 30.0 on low, 20.0 on high, against 10.3 for a cliff face in the same
        // frame; ceiling now 15.0 in test-world-fidelity).
        //
        // GRADIENT noise fixes it at the source. Each corner carries a random
        // DIRECTION and contributes a linear ramp; the field is exactly zero at
        // every lattice point, so cells have no interior plateau and no
        // extremum to line up with their neighbours. The visible structure
        // becomes the gradients, which are isotropic, instead of the grid.
        // Quintic (not cubic) fade keeps the second derivative continuous, so
        // no cell EDGE reads either.
        //
        // Cost: two hashes per corner instead of one, on the three detail
        // octaves only — the 12-16m macro and warp octaves stay value noise
        // because at that scale there is no lattice to see and they are what
        // bends everything below them. On the low tier this is one extra hash
        // per fragment, because low collapses to a single octave.
        + 'vec2 tGradDir(vec2 i) {\n'
        + '  vec2 h = fract(sin(vec2(dot(i, vec2(127.1, 311.7)), dot(i, vec2(269.5, 183.3)))) * 43758.5453);\n'
        + '  return normalize(h * 2.0 - 1.0 + 1e-4);\n'
        + '}\n'
        + 'float tGrad(vec2 p) {\n'
        + '  vec2 i = floor(p); vec2 f = fract(p);\n'
        + '  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);\n'
        + '  float a = dot(tGradDir(i), f);\n'
        + '  float b = dot(tGradDir(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));\n'
        + '  float c = dot(tGradDir(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));\n'
        + '  float d = dot(tGradDir(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));\n'
        // Perlin 2D with unit gradients spans about +-0.707; map to 0..1 on the
        // same convention every consumer below already assumes.
        + '  return clamp(0.5 + 0.7071 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y), 0.0, 1.0);\n'
        + '}\n',
      )
      // ── THE CAVE MOUTHS ARE HOLES ─────────────────────────────────────────
      // Cut before anything else in main() runs: the heightfield cannot express
      // "rock above, air below", so the opening is opened per-fragment on the
      // same oriented boxes physics walks (see CaveMouthCutout).
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n'
        + (cutout ? 'if (caveCutout(vTerrWorld)) discard;\n' : ''),
      )
      // Detail runs AFTER the vertex colour is folded into diffuseColor.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + 'vec2 tP0 = vTerrWorld.xz;\n'
        // ── THE WEAVE ──────────────────────────────────────────────────────
        // A value-noise lattice is a grid, and a grid of smoothstepped cells at
        // 0.5m pitch photographs as knitting — a repeating checker at your feet
        // and across a whole cliff face. Rotating each octave (tR1/tR2 below)
        // stops the octaves stacking their cell edges on each other, but it does
        // not stop ONE octave's edges from reading. The cure for that is DOMAIN
        // WARP: displace the sample point by a low-frequency field before any
        // finer octave reads it, and every lattice edge downstream bends with the
        // warp, so no cell boundary stays straight and no cell stays square.
        //
        // WHAT MUST NOT BE DONE, AND WAS: rotate the sample point by a
        // spatially-varying angle. `tP = tRW * tP` turns tP about the WORLD
        // ORIGIN, so the distance the sample point travels per metre walked is
        // the angle gradient TIMES THE DISTANCE TO THAT ORIGIN. The angle field
        // here swung 2.4 rad over ~16m — about 0.3 rad/m — and the islands sit
        // 400m+ out, which is a ~120x anisotropic stretch of the whole detail
        // field, rising the further from the origin you sail. It did destroy the
        // knit. It replaced it with a comb: the ground and every cliff smeared
        // into long directional strands, like brushed fur, which is what the
        // verification shots of this pass photographed.
        //
        // So: warp at TWO scales instead — a ~12m octave and a ~3.4m one — which
        // bends the lattice at two frequencies with a strictly BOUNDED
        // displacement (nothing here moves a sample point more than ~1.8m, at any
        // distance from the origin). Costs one fetch, and gives back the two
        // trig calls and the matrix multiply the rotation was spending.
        //
        // The macro field then also does the job it is named for: a 5-20m tonal
        // and hue octave, so a cliff face is lit in broad patches rather than
        // being one flat value carrying a uniform texture.
        + (octaves >= 2
          ? 'float nMacro = tNoise(tP0 * 0.085);\n'              // ~12m
            + 'float nMacro2 = tNoise(tP0.yx * 0.062 + 19.3);\n'  // ~16m, other axis
            + 'vec2 tP = tP0 + (vec2(nMacro, nMacro2) - 0.5) * 2.6;\n'
            + 'float nWarp = tNoise(tP * 0.29 + 7.7);\n'          // ~3.4m
            + 'tP += (vec2(nWarp, nMacro2 * 0.6 + nWarp * 0.4) - 0.5) * 1.05;\n'
          : 'float nMacro = 0.5;\nfloat nMacro2 = 0.5;\nvec2 tP = tP0;\n')
        // Each octave samples a ROTATED lattice. A value-noise grid shares the
        // world axes, and three co-aligned octaves stack their cell edges into
        // a visible checkerboard on flat ground (caught in verification).
        // ── NO OCTAVE UNDER THE PIXEL ──────────────────────────────────────
        // Every octave below was evaluated at whatever frequency the screen
        // happened to give it, so on a hillside 20-100 m away the 0.42 m and
        // 0.11 m cells were one pixel or less and the surface was per-pixel
        // speckle — TV static, worst on the bald low-tier islands that have no
        // foliage over it (audit r1). fwidth(tP) is the lattice's world size
        // of one pixel; times an octave's frequency it is cells per pixel. An
        // octave is whole under ~0.15 cells/px (6.7 px per cell) and gone by
        // 0.45 (under 2.2 px per cell), replaced by its own mean so the material
        // weights below are untouched. Two derivative ops per fragment.
        + 'float tFw = max(fwidth(tP.x), fwidth(tP.y));\n'
        + 'mat2 tR0 = mat2(0.71, 0.70, -0.70, 0.71);\n'
        + 'mat2 tR1 = mat2(0.87, -0.50, 0.50, 0.87);\n'
        + 'mat2 tR2 = mat2(0.36, 0.93, -0.93, 0.36);\n'
        // Frequencies are deliberately NOT in small integer ratios (0.53 :
        // 2.37 : 9.13, not 0.55 : 2.1 : 8.5): octaves whose periods share a
        // common multiple beat, and a beat is a second, coarser lattice on top
        // of the first. Each also gets its own rotation and origin offset, so
        // no two share a cell edge anywhere in the world.
        + 'float nMid = tGrad(tR0 * tP * 0.53 + 3.1);\n'          // ~1.9m mottle
        // nFine is NOT tier-gated. ONE gradient octave is worse than one value
        // octave for the thing being graded: value noise's cells have flat
        // middles that mush together, gradient noise is exactly zero on its
        // lattice, so alone it draws that lattice (measured: low ground 12.6
        // with the old single value octave, 15.2 with a single gradient one).
        // Two decorrelated octaves cancel each other's zero sets and take it to
        // 11.7. That is one extra hash pair on the low tier and it is the only
        // ground detail a low-tier player gets — nothing else is drawn on it.
        + 'float nFine = 0.5;\n'
        + 'float fadeFine = 1.0 - smoothstep(0.15, 0.45, tFw * 2.37);\n'
        + 'if (fadeFine > 0.002) nFine = mix(0.5, tGrad(tR1 * tP * 2.37 + 13.7), fadeFine);\n'   // ~0.42m patches
        + (octaves >= 3
          ? 'float nGrain = 0.5;\n'
            + 'float fadeGrain = 1.0 - smoothstep(0.15, 0.45, tFw * 9.13);\n'
            + 'if (fadeGrain > 0.002) nGrain = mix(0.5, tGrad(tR2 * tP * 9.13 + 5.3), fadeGrain);\n'  // ~0.11m grain
          : 'float nGrain = nFine;\n')
        // ── NEAR-FIELD GRIT ────────────────────────────────────────────────
        // The ladder above bottoms out at ~0.12m, and 0.12m features are ~1/3
        // of a metre of screen at arm's length: stand still and the ground
        // under your boots is one airbrushed smear, which is what the audit
        // photographed. This adds the two octaves BELOW that — ~3.5cm sand
        // grain and ~1.2cm speckle — on a distance ramp, so they exist exactly
        // where the eye can resolve them and are gone (no shimmer, no cost that
        // matters) by the time a pixel covers more ground than a grain does.
        + `float near = ${octaves >= 2 ? '1.0 - smoothstep(1.6, 11.0, length(vViewPosition))' : '0.0'};\n`
        + 'float nGrit = 0.0;\n'
        + (octaves >= 2
          ? 'if (near > 0.004) {\n'
            // Grit is gradient noise too, and that was MEASURED, not assumed:
            // sending these two octaves back to tNoise to save two hashes in
            // the near field put the graded ground score back up from 12.2 to
            // 16.0. At 1m of eye height a 3.5cm cell is several pixels across,
            // so its lattice is exactly as visible as the 0.42m one.
            + '  nGrit = (tGrad(tR2 * tP * 31.7 + 21.9) - 0.5) * (1.0 - smoothstep(0.15, 0.45, tFw * 31.7));\n'
            + (octaves >= 3 ? '  nGrit += (tGrad(tR0 * tP * 87.3 + 41.1) - 0.5) * 0.55 * (1.0 - smoothstep(0.15, 0.45, tFw * 87.3));\n' : '')
            + '  nGrit *= near;\n'
            + '}\n'
          : '')
        // Tent weights over the 0..3 material axis: adjacent classes crossfade.
        + 'float mC = clamp(vTerrMat, 0.0, 3.0);\n'
        + 'float wSand = max(0.0, 1.0 - abs(mC - 0.0));\n'
        + 'float wGrass = max(0.0, 1.0 - abs(mC - 1.0));\n'
        + 'float wRock = max(0.0, 1.0 - abs(mC - 2.0));\n'
        + 'float wAsh = max(0.0, 1.0 - abs(mC - 3.0));\n'
        // Sand: fine grain speckle + shallow wind/tide ripple bands.
        + 'float ripple = sin(dot(tP, vec2(0.86, 0.51)) * 4.4 + nMid * 4.0);\n'
        + 'float dSand = (nGrain - 0.5) * 0.34 + (nFine - 0.5) * 0.12 + ripple * 0.06;\n'
        // Grass: broad patchiness (blade clumps), light grain.
        + 'float dGrass = (nMid - 0.5) * 0.34 + (nFine - 0.5) * 0.28 + (nGrain - 0.5) * 0.18;\n'
        // Rock: crystalline grain + a touch of mottle.
        + 'float dRock = (nFine - 0.5) * 0.34 + (nGrain - 0.5) * 0.28 + (nMid - 0.5) * 0.16;\n'
        // Ash: high-contrast char/clinker.
        + 'float dAsh = (nFine - 0.5) * 0.44 + (nGrain - 0.5) * 0.36;\n'
        + 'float detail = dSand * wSand + dGrass * wGrass + dRock * wRock + dAsh * wAsh;\n'
        // Grit rides on top, weighted per class: sand is nearly all grain at
        // this scale, rock is crystalline, turf is matted and takes the least.
        + 'detail += nGrit * (0.62 * wSand + 0.30 * wGrass + 0.54 * wRock + 0.58 * wAsh);\n'
        // …and the MACRO octave on top: broad 5-20m patches of light and dark.
        // Without it every square metre of a biome carries the same statistics,
        // and identical statistics over a 60m cliff is what makes a procedural
        // texture read as a tiled texture however good the fine detail is.
        + 'detail += (nMacro - 0.5) * 0.20 + (nMacro2 - 0.5) * 0.12;\n'
        // Sedimentary STRATA on steep faces — horizontal bands that follow the
        // rock face without moving a single vertex. The cliff/whale-back fix.
        // Heavily noise-warped and shallow: an un-warped low-frequency band
        // reads as zebra stripes painted across a big cone (seen in review).
        + 'float steep = smoothstep(0.34, 0.62, vTerrSlope);\n'
        // The warp on the bedding phase must stay UNDER one full band period.
        // It was nMid*6.5 + nFine*2.4 — up to 8.9 radians against a 2*PI band, so
        // the bands folded back through each other and a cone came out wearing
        // graphic zigzag chevrons rather than bedding. Held under ~0.6 of a period
        // the same fields make the layers undulate and disagree face-to-face,
        // which is what sedimentary rock actually does.
        + 'float strataW = sin(vTerrWorld.y * 2.5 + nMid * 2.6 + nFine * 1.1);\n'
        + 'float strata = smoothstep(-0.40, 0.35, strataW) - 0.5;\n'
        // ...and only on ROCK/ASH ground: contour bands running across a green
        // grass spire read as topographic lines, not sedimentary layers.
        + 'float strataMat = clamp(wRock + wAsh + wSand * 0.3, 0.0, 1.0);\n'
        + 'detail += strata * 0.17 * steep * strataMat;\n'
        + 'diffuseColor.rgb *= clamp(1.0 + detail, 0.35, 1.9);\n'
        // Hue character: sun-bleached sand warms, grass patches yellow off,
        // strata bands run ochre, ash cools toward blue-grey clinker.
        + 'diffuseColor.rgb += vec3(0.030, 0.018, -0.012) * (nGrain - 0.5) * wSand;\n'
        + 'diffuseColor.rgb += vec3(0.045, 0.038, -0.030) * (nMid - 0.5) * wGrass;\n'
        + 'diffuseColor.rgb += vec3(0.032, 0.019, 0.003) * strata * steep * strataMat;\n'
        + 'diffuseColor.rgb += vec3(-0.012, -0.006, 0.014) * (nFine - 0.5) * wAsh;\n'
        // Macro HUE drift too: patches of ground that differ in tone but not in
        // colour still read as one material with a filter over it.
        + 'diffuseColor.rgb += vec3(0.026, 0.038, -0.020) * (nMacro2 - 0.5);\n'
        // …and the near grain carries hue too: dark mineral flecks in the sand,
        // a shell-white glint here and there. Grain that only shifts VALUE reads
        // as film grain; grain that shifts hue reads as ground.
        + 'diffuseColor.rgb += vec3(0.055, 0.036, -0.020) * nGrit * (wSand + wAsh);\n'
        + 'diffuseColor.rgb += vec3(-0.020, 0.030, -0.024) * nGrit * wGrass;\n'
        // ── Shore: wet-sand band whose upper edge breathes with the swell ──
        + 'float wetLine = 1.05 + 0.30 * sin(uTerrTime * 0.55) + 0.12 * sin(uTerrTime * 0.23 + 1.7);\n'
        + 'float wet = smoothstep(wetLine + 0.45, wetLine - 0.65, vTerrWorld.y);\n'
        + 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.58, 0.63, 0.69), wet * 0.88);\n'
        // ── Submerged floor: keep the terrain read going under the water ──
        + 'float subm = smoothstep(-0.15, -2.6, vTerrWorld.y);\n'
        // The submerged tint is written BEFORE the caustics (it does not read
        // them) so the whole caustic field is one contiguous, exportable block.
        + 'diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(0.10, 0.30, 0.33), 0.55), subm);\n'
        + TERRAIN_CAUSTIC_GLSL
        + (volcanic
          ? // Hairline magma cracks, per pixel. Two crossed sine fields sharpened
            // HARD so only the crack CORE lights; the flanks stay charred basalt.
            'float vein = 0.0;\n'
            + 'if (vMagmaGate > 0.004) {\n'
            + '  float c1 = sin(vTerrWorld.x * 0.224 + sin(vTerrWorld.z * 0.112) * 2.2);\n'
            + '  float c2 = sin(vTerrWorld.z * 0.208 - sin(vTerrWorld.x * 0.098) * 2.0);\n'
            + '  float c3 = sin(vTerrWorld.x * 0.496 - sin(vTerrWorld.z * 0.432) * 1.6);\n'
            + '  float c4 = sin(vTerrWorld.z * 0.464 + sin(vTerrWorld.x * 0.528) * 1.5);\n'
            + '  float coarse = pow(max(0.0, 1.0 - min(abs(c1), abs(c2))), 46.0);\n'
            + '  float fine = pow(max(0.0, 1.0 - min(abs(c3), abs(c4))), 58.0) * 0.7;\n'
            // Cracks are INTERMITTENT: an unbroken glowing line running the
            // length of an island reads as a racing stripe, not fractured rock.
            + '  float breakUp = smoothstep(0.30, 0.72, nMid * 0.6 + nFine * 0.4);\n'
            // ...and only the genuinely elevated cone cracks open; the shore
            // flank stays cold basalt (which the ash tint already sells).
            + '  float lift = smoothstep(9.0, 22.0, vTerrWorld.y);\n'
            + '  vein = min(1.0, coarse + fine) * vMagmaGate * breakUp * lift;\n'
            + '  diffuseColor.rgb *= 1.0 - vein * 0.55;\n'   // hot rim: rock darkens at the crack
            + '}\n'
          : ''),
      )
      // Wet rock/sand gains a specular sheen (roughness drops); the same band
      // that darkens the albedo lifts the highlight, which is what actually
      // sells "the tide just went out" at eye level.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor = mix(roughnessFactor, 0.30, clamp(wet * 0.9 + subm * 0.7, 0.0, 1.0));\n',
      );
    if (volcanic) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + 'float veinCore = pow(vein, 2.4);\n'
        + 'if (veinCore > 0.002) {\n'
        + '  vec3 mc = mix(vec3(0.95, 0.16, 0.02), vec3(1.0, 0.72, 0.16), clamp(veinCore * 1.6, 0.0, 1.0));\n'
        + '  totalEmissiveRadiance += mc * veinCore * uMagmaPulse * 1.1;\n'
        + '}\n'
        + 'if (vSummit > 0.004) {\n'
        + '  float pool = vSummit * (0.75 + 0.25 * (nMid - 0.5) * 2.0);\n'
        + '  totalEmissiveRadiance += mix(vec3(0.95, 0.22, 0.03), vec3(1.0, 0.75, 0.20), clamp(pool * 1.6, 0.0, 1.0)) * pool * uMagmaPulse * 1.4;\n'
        + '}\n',
      );
    }
  };
  // One program per variant — not one per island — so shader compilation
  // doesn't churn across 14 island builds. The MOUTH-SLOT COUNT is part of the
  // key: the cutout's uniform arrays are sized by it, and three.js would
  // otherwise hand this material a program compiled for a different array size
  // (the hole then reads the wrong island's mouths, or none at all).
  const key = volcanic ? 'pirates-terrain-detail-volcanic' : 'pirates-terrain-detail';
  material.customProgramCacheKey = () => `${key}-m${cutout ? cutout.count : 0}`;
}

/**
 * The coast wobble and the vertex grid itself moved to `src/shared/terrainGrid.ts`
 * under GRID-01: the server now stands the player on these exact triangles, so
 * the grid cannot live in the renderer any more. Re-exported here because the
 * skirt, the LOD proxy and `scripts/test-coast-wobble.mjs` call it by this name.
 */
export { coastWobble };

/** One island's terrain heightfield: the polar vertex grid, its triangle
 *  indices, the per-vertex mouth-carve depth and the baked vertex AO. Pure — no
 *  THREE.Mesh, no materials, no colours — and now built in SHARED code at ONE
 *  fixed resolution, so `buildTerrainMesh`, `scripts/test-cave-walk.mjs` and the
 *  server's GridGround all read the same surface at every quality tier. */
export type TerrainField = {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Parallel to positions/3: how deep the mouth carve cut that vertex. */
  readonly mouthCarveDepth: Float32Array;
  /** Parallel to positions/3: baked hemisphere AO, 1 = open sky. */
  readonly ao: Float32Array | null;
  /** First vertex of each ring (length rings + 2, last = vertex count). */
  readonly ringStart: Uint32Array;
  /** Segment count of each ring; ring 0 is the single apex vertex. */
  readonly ringSegments: Uint32Array;
  readonly totalRings: number;
  readonly shoreRingSpan: number;
  readonly ringDistRatio: (ring: number) => number;
};

export function buildTerrainHeightfield(args: {
  island: Island;
  surfacePoint: (distRatio: number, angle: number, extraY?: number) => { x: number; y: number; z: number };
  carveCaveMouth: (worldX: number, worldZ: number, y: number) => { y: number; carved: number };
  /** Bake vertex AO (the mesh path); the pure suites can skip it. */
  withAO?: boolean;
}): TerrainField {
  const grid = buildTerrainGrid(args.island, {
    surfacePoint: args.surfacePoint,
    carveCaveMouth: args.carveCaveMouth,
    withAO: args.withAO !== false,
  });
  return {
    positions: grid.positions,
    indices: grid.indices,
    mouthCarveDepth: grid.mouthCarveDepth,
    ao: grid.ao,
    ringStart: grid.ringStart,
    ringSegments: grid.ringSegments,
    totalRings: grid.rings,
    shoreRingSpan: grid.shoreRingSpan,
    ringDistRatio: (ring: number) => grid.ringDist[Math.max(0, Math.min(grid.rings, ring))],
  };
}


export function buildTerrainMesh(ctx: IslandBuildCtx): TerrainBuild {
  const {
    host, island, group, r, rng, lowDetail, visualDetail, surfacePoint, carveCaveMouth,
    isVolcanic, whiteSand,
    sandColor, beachColor, cliffColor, grassColor, jungleColor, peakColor, mudColor, paletteRock,
  } = ctx;
  // The vertex grid + its carve depths (pure; shared with the regression suite).
  // The vertex grid is SHARED and quality-independent (GRID-01): low, balanced
  // and high get identical positions, and the tiers differ only in decoration
  // and shading below. `lowDetail`/`visualDetail` no longer touch geometry.
  const field = buildTerrainHeightfield({ island, surfacePoint, carveCaveMouth });
  const terrainPositions = field.positions;
  const terrainIndices = field.indices;
  /** Per-vertex carve depth (parallel to terrainPositions) — drives the cut
   *  faces' ROCK recolor in the color pass below (they'd read as floating
   *  grass-green slabs otherwise) and lets decor placement skip the trench. */
  const mouthCarveDepth = field.mouthCarveDepth;
  // Publish the grid the player is looking at, so the shared sampler the client
  // prediction and the entity seats read is THIS mesh and nothing rebuilds it.
  setIslandGround(island.id, field.positions, field.indices);
  const fieldAO = field.ao;
  const ringStart = field.ringStart;
  const ringSegments = field.ringSegments;
  const totalRings = field.totalRings;
  const shoreRingSpan = field.shoreRingSpan;
  const ringDistRatio = field.ringDistRatio;

  const terrainColor = new THREE.Color();
  const scratchColor = new THREE.Color();
  const rockSlopeColor = paletteRock.clone().multiplyScalar(0.8);
  const ashCharcoal = new THREE.Color(0x2b2621);
  /** Vein GATE (smooth, interpolates cleanly) — the crack field itself is
   *  evaluated per-PIXEL in the fragment shader, so veins read as hairline
   *  cracks instead of the 10m airbrushed smears per-vertex storage produced. */
  const terrainMagma: number[] = [];
  /** Caldera core glow (the molten tip), kept separate from the vein gate so
   *  the summit stays a solid pool rather than a cracked field. */
  const terrainSummit: number[] = [];
  /** Fragment-detail material class per vertex: 0=sand, 1=grass, 2=rock, 3=ash.
   *  Interpolates between neighbours, and the shader blends the two adjacent
   *  grain characters, so transitions stay smooth. */
  const terrainMatClass: number[] = [];
  // Snow on tall NON-volcanic mountains: whiten the summit above the snow line
  // as part of the terrain itself (no floating cone). Volcanoes stay bare rock.
  // A tall mountain reads as craggy grey STONE with grass lower down — snow is
  // only ever a thin dusting on the very tip of a genuinely towering peak (the
  // old low, greedy band whitewashed the whole summit into a smooth blob).
  const isMountainColor = island.profile.terrainStyle === 'mountain';
  const isSnowy = isMountainColor
    && !isVolcanic
    && (island.profile.peakBoost ?? 0) > 0.95;
  const snowColor = new THREE.Color(0xeef3fb);

  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute('position', new THREE.Float32BufferAttribute(terrainPositions, 3));
  terrainGeometry.setIndex(new THREE.BufferAttribute(terrainIndices, 1));
  terrainGeometry.computeVertexNormals();

  // Colors are computed after normals: slope (1 - normal.y) drives exposed
  // rock on steep faces while flat ground keeps sand/grass/jungle.
  const terrainNormals = terrainGeometry.getAttribute('normal') as THREE.BufferAttribute;
  const terrainColors: number[] = [];
  // Normalize height by the island's EXPECTED relief (sea plinth → estimated
  // peak) instead of a fixed r*0.18 — the old mask saturated to rock-gray on
  // any mid-tall island, washing every biome to the same monochrome dome.
  const profileForColor = island.profile;
  const seaBase = 5.15 + r * 0.0085;
  const peakEst = Math.max(
    4,
    r * (0.10 + profileForColor.heightProfile * 0.25 + (profileForColor.peakBoost ?? 0) * 0.15),
  );
  // peakEst OVER-estimates relief on twin/secondary-hill styles, so the
  // volcanic scorch + vein gates (which key on the top half of the cone) never
  // fired on low volcanic isles — island 8 rendered as a generic lush dome
  // despite its smoke column. Measure the REAL relief from the vertices we
  // just generated and gate the volcanic identity on that. Deliberately kept
  // separate from `peakEst`: the grass/rock/peak masks are tuned against the
  // estimate and swapping them wholesale re-greys every lush island.
  let realPeakY = -Infinity;
  for (let i = 1; i < terrainPositions.length; i += 3) {
    if (terrainPositions[i] > realPeakY) realPeakY = terrainPositions[i];
  }
  const realRelief = Math.max(4, realPeakY - (5.15 + r * 0.0085));
  // Bright white-sand shelves (atoll/crescent lagoons) sit at ~sea level, so
  // pull their wet/submerged tints hard toward lagoon turquoise — otherwise the
  // barely-emergent floor stays a blinding white plate from above (audit P1).
  const wetSandColor = sandColor.clone().multiplyScalar(0.6).lerp(new THREE.Color(0x2f7d84), whiteSand ? 0.45 : 0.24);
  const submergedColor = new THREE.Color(whiteSand ? 0x2a8a90 : 0x1d4a52);
  // Smooth WORLD-SPACE value noise for organic ground mottling. Keying colour
  // on world XZ (not the ring/segment indices) kills the radial "pinwheel"
  // smear that streaked from every island centre, and gives the flat
  // vertex-colour terrain large- and small-scale variation at eye level.
  const vHash = (ix: number, iz: number): number => {
    const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vNoise = (x: number, z: number): number => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = vHash(ix, iz), b = vHash(ix + 1, iz), c = vHash(ix, iz + 1), d = vHash(ix + 1, iz + 1);
    return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
  };
  const groundFbm = (x: number, z: number): number =>
    vNoise(x * 0.045, z * 0.045) * 0.55 + vNoise(x * 0.14, z * 0.14) * 0.3 + vNoise(x * 0.46, z * 0.46) * 0.15;
  // Geyser mouths scorch the ground around them (works on ANY biome — a vent
  // on a grass island still burns a char ring), so the vent geometry sits in
  // ash instead of on untouched turf.
  const ventScorch = (island.geysers ?? []).map((g) => ({
    x: g.x - island.position.x,
    z: g.z - island.position.z,
    r: Math.max(1.5, g.radius) * 3.2,
  }));
  for (let ring = 0; ring <= totalRings; ring++) {
    const distRatio = ringDistRatio(ring);
    const ringSegs = ringSegments[ring];
    const ringBase = ringStart[ring];
    for (let segment = 0; segment < ringSegs; segment++) {
      const index = ringBase + segment;
      const angle = (segment / ringSegs) * Math.PI * 2;
      const coast = getIslandCoastWeights(island, angle);
      const rockyCoast = coast.rocky + coast.cliff;
      const pointY = terrainPositions[index * 3 + 1];
      const slope = THREE.MathUtils.clamp(1 - terrainNormals.getY(index), 0, 1);

      const heightNorm = THREE.MathUtils.clamp((pointY - seaBase) / peakEst, 0, 1);
      /** Same band, measured against the island's ACTUAL relief — used only by
       *  the volcanic ash/vein gates (see realRelief). */
      const reliefNorm = THREE.MathUtils.clamp((pointY - seaBase) / realRelief, 0, 1);
      const shoreMask = THREE.MathUtils.smoothstep(distRatio, 0.72, 0.99);
      // Grass is the DEFAULT interior ground: any land above the waterline is
      // green (the distRatio gate alone keeps a sand berm at the shore), so
      // even low, wide aprons on big islands read lush — not as tan dunes.
      const grassMask = THREE.MathUtils.smoothstep(heightNorm, -0.08, 0.05)
        * (1 - THREE.MathUtils.smoothstep(distRatio, 0.84, 0.99));
      const jungleMask = THREE.MathUtils.smoothstep(heightNorm, 0.08, 0.4)
        * (1 - THREE.MathUtils.smoothstep(distRatio, 0.55, 0.82)) * 0.58;
      // Rock is earned by SLOPE first; only genuinely high ground rock-caps.
      const rockMask = THREE.MathUtils.smoothstep(heightNorm, 0.72, 0.97) * (1 - shoreMask * 0.6) * 0.55;
      const peakMask = THREE.MathUtils.smoothstep(heightNorm, 0.88, 1) * 0.4;
      const mudMask = THREE.MathUtils.smoothstep(distRatio, 0.62, 0.78) * (1 - shoreMask) * 0.14;
      // Rock is earned on genuinely STEEP faces (~50°+). The old 0.26 start
      // painted grey rock over every gently-sloped dome flank, washing lush
      // islands to a muddy monochrome; grass now holds the walkable slopes.
      const slopeRockMask = THREE.MathUtils.smoothstep(slope, 0.42, 0.74) * (1 - shoreMask);

      terrainColor.copy(sandColor);
      terrainColor.lerp(beachColor, shoreMask * coast.beach * 0.95);
      terrainColor.lerp(cliffColor, shoreMask * rockyCoast * 0.75);
      terrainColor.lerp(mudColor, mudMask);
      terrainColor.lerp(grassColor, grassMask);
      terrainColor.lerp(jungleColor, jungleMask);
      terrainColor.lerp(cliffColor, rockMask);
      terrainColor.lerp(rockSlopeColor, slopeRockMask * 0.72);
      // Mountains bare craggy grey stone across their upper flanks (not just the
      // steepest faces) so the peak reads as rock — the same stone the cave mouth
      // is carved from — instead of a smooth green dome.
      if (isMountainColor) {
        const craggy = THREE.MathUtils.smoothstep(heightNorm, 0.4, 0.8) * (1 - shoreMask);
        terrainColor.lerp(rockSlopeColor, craggy * 0.55 * (1 - grassMask * 0.4));
        // Mottle the exposed rock (darken crevices, lift facets) on world-space
        // noise so the massif reads as fractured stone, not flat monochrome.
        const mwx = terrainPositions[index * 3 + 0] + island.position.x;
        const mwz = terrainPositions[index * 3 + 2] + island.position.z;
        terrainColor.multiplyScalar(1 + craggy * (groundFbm(mwx, mwz) - 0.5) * 0.55);
      }
      terrainColor.lerp(peakColor, peakMask * (1 - slopeRockMask));
      // Cave-mouth cut faces (and passage-skimming shelves, sentinel 0.35)
      // are freshly exposed ROCK, not turf: without this the trench and the
      // shelves crossing the arch keep their grass/sand height-band colors
      // and the opening reads as green slabs floating in the hillside.
      const cutDepth = mouthCarveDepth[index] ?? 0;
      if (cutDepth > 0.3) {
        terrainColor.lerp(rockSlopeColor, Math.max(0.78, Math.min(1, cutDepth / 1.6)) * 0.9);
      }
      scratchColor.copy(beachColor).multiplyScalar(THREE.MathUtils.smoothstep(distRatio, 0.9, 1) * 0.14);
      terrainColor.add(scratchColor);

      // Waterline gradient on the new shore rings: dry sand → darker wet
      // sand at the lapping band → blue-green submerged slope, so the
      // beach visually walks into the sea.
      // Waves lap above mean sea level, so start wetting/submerging sand a bit
      // ABOVE y=0: a barely-submerged shelf (e.g. the atoll lagoon floor) then
      // reads as turquoise shallow water, not a blinding white sand plate.
      const wetMask = THREE.MathUtils.smoothstep(-pointY, -1.1, 0.35);
      const depthMask = THREE.MathUtils.smoothstep(-pointY, -0.5, 1.8);
      if (wetMask > 0) {
        terrainColor.lerp(wetSandColor, wetMask * (0.6 + coast.beach * 0.3));
        terrainColor.lerp(submergedColor, depthMask * 0.9);
      }
      // whiteSand archipelago/crescent lagoons sit as emergent bright-sand
      // flats AT sea level (above water, so the depth tint never engages) that
      // read as a blinding white plate from above. Tint the low, non-berm
      // interior toward lagoon aqua so it reads as the shallow water it should.
      if (whiteSand) {
        const lagoon = (1 - THREE.MathUtils.smoothstep(heightNorm, 0.0, 0.13)) * (1 - shoreMask * 0.55);
        terrainColor.lerp(new THREE.Color(0x54b8bd), lagoon * 0.55);
      }

      // ── Volcanic: char the cone to ash; the magma CRACK FIELD itself is
      // evaluated per-pixel in the fragment shader (a per-vertex field on
      // 4-8m vertices smeared every hairline vein into a ~10m glow bar).
      // Here we only store the smooth GATE that says "how molten is this
      // region", which interpolates cleanly.
      let magmaGate = 0;
      let summitGlow = 0;
      let ashAmount = 0;
      if (isVolcanic) {
        // Veins run across the whole upper cone — a volcano's flanks are ALL
        // slope, so don't suppress by steepness; just keep them off the beach.
        magmaGate = THREE.MathUtils.smoothstep(reliefNorm, 0.14, 0.66) * (1 - shoreMask);
        // Just the very tip glows molten (the caldera itself), painted into the
        // terrain so the crater reads as part of the peak — not a floating disc.
        summitGlow = THREE.MathUtils.smoothstep(reliefNorm, 0.9, 0.995) * 0.55 * (1 - shoreMask);
        // Scorch the high ground to ashen charcoal so the thin veins glow against
        // dark rock. Every volcanic island now earns a basalt/ash floor down to
        // the shore band, not just the one tall cone.
        const scorch = THREE.MathUtils.smoothstep(reliefNorm, 0.05, 0.45) * (1 - shoreMask);
        const basalt = (1 - shoreMask) * 0.32;              // dark volcanic soil everywhere inland
        // Capped below 1: at a full lerp the ground goes flat near-black and
        // the whole biome palette (and the ash grain) disappears.
        ashAmount = Math.min(0.86, scorch * 0.95 + basalt);
        terrainColor.lerp(ashCharcoal, ashAmount);
      }
      // Vent char ring (any biome): ash halo so the geyser rim reads as burnt.
      if (ventScorch.length) {
        const lx = terrainPositions[index * 3 + 0];
        const lz = terrainPositions[index * 3 + 2];
        let burn = 0;
        for (const v of ventScorch) {
          const d = Math.hypot(lx - v.x, lz - v.z);
          burn = Math.max(burn, 1 - THREE.MathUtils.smoothstep(d, v.r * 0.35, v.r));
        }
        if (burn > 0.01) {
          terrainColor.lerp(ashCharcoal, burn * 0.85);
          ashAmount = Math.max(ashAmount, burn);
        }
      }
      terrainMagma.push(magmaGate);
      terrainSummit.push(summitGlow);

      // ── Snow line: the summit of a tall mountain whitens (terrain-hugging,
      // heavier on flatter shelves where snow settles, thinner on sheer faces). ──
      if (isSnowy) {
        // Snow keyed on ABSOLUTE height above the sea (not heightNorm, whose
        // peakEst over-estimated relief so the band never triggered) — the top
        // third of a real spire whitens, heavier on flatter shelves.
        const snow = THREE.MathUtils.smoothstep(pointY, seaBase + 34, seaBase + 50)
          * (1 - shoreMask)
          * (1 - slopeRockMask * 0.65);
        if (snow > 0) terrainColor.lerp(snowColor, Math.min(1, snow * 0.85));
      }

      // Per-vertex noise + a low-frequency hue drift so large faces never
      // read as one flat paint bucket (survives ACES tonemapping). Sand
      // (near shore) gets extra tonal variation so beaches don't clip to a
      // uniform bright halo.
      const sandiness = shoreMask * coast.beach;
      const worldX = terrainPositions[index * 3 + 0] + island.position.x;
      const worldZ = terrainPositions[index * 3 + 2] + island.position.z;
      // World-space fbm: broad tonal drift + finer mottle, plus a hint of
      // per-vertex grain. Warm the brighter patches, cool the darker ones.
      const fbm = groundFbm(worldX, worldZ) - 0.5;                       // -0.5..0.5
      const grain = (rng(ring * 113 + segment * 17) - 0.5) * (0.05 + sandiness * 0.05);
      // ── AMBIENT OCCLUSION (graphics-06 phase 1). An unoccluded ambient term
      // lit the inside of a cave-mouth trench and the crease between two crags
      // exactly as brightly as an open beach — the "cardboard" read. The grid
      // bakes a horizon estimate per vertex at build time, so this costs
      // nothing per frame and no material or batching path changes: it is a
      // multiply into the vertex colour the terrain already carries.
      // mix(1, ao, 0.7) so full occlusion darkens to ~0.55x, never to black.
      const occ = fieldAO ? 1 - (1 - fieldAO[index]) * 0.7 : 1;
      const bright = (1 + fbm * 0.26 + grain) * occ;
      const warm = fbm * 0.05 * occ;
      terrainColors.push(
        THREE.MathUtils.clamp(terrainColor.r * bright + warm, 0, 1),
        THREE.MathUtils.clamp(terrainColor.g * bright, 0, 1),
        THREE.MathUtils.clamp(terrainColor.b * bright - warm * 0.6, 0, 1),
      );

      // ── Fragment-detail material class (0 sand / 1 grass / 2 rock / 3 ash).
      // Weighted average rather than an argmax so a beach→grass boundary
      // crossfades its GRAIN too, not just its colour.
      const wSand = 0.35 + sandiness * 1.6 + shoreMask * 0.5;
      const wGrass = grassMask * 2.2 + jungleMask * 1.2;
      const wRock = slopeRockMask * 2.4 + rockMask * 1.6 + shoreMask * rockyCoast * 1.4
        + (cutDepth > 0.3 ? 2.5 : 0)
        + (isMountainColor ? THREE.MathUtils.smoothstep(heightNorm, 0.4, 0.8) * 1.6 : 0);
      const wAsh = ashAmount * 3.2;
      const wSum = wSand + wGrass + wRock + wAsh;
      terrainMatClass.push(wSum > 0.0001 ? (wGrass + wRock * 2 + wAsh * 3) / wSum : 1);
    }
  }
  terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));

  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, side: THREE.DoubleSide });
  terrainGeometry.setAttribute('aMat', new THREE.Float32BufferAttribute(terrainMatClass, 1));
  if (isVolcanic) {
    terrainGeometry.setAttribute('aMagma', new THREE.Float32BufferAttribute(terrainMagma, 1));
    terrainGeometry.setAttribute('aSummit', new THREE.Float32BufferAttribute(terrainSummit, 1));
  }
  applyTerrainDetail(terrainMat, isVolcanic, host, buildCaveCutout(island));
  const terrain = new THREE.Mesh(terrainGeometry, terrainMat);
  terrain.name = 'island-terrain';
  // THE ISLAND CASTS (SHADOW-01 / graphics-13).
  //
  // Casting was switched off because the DoubleSide heightfield shadowing
  // ITSELF produced an acne wash that crushed every island to murky olive —
  // and the diagnosis was right about the symptom and wrong about the cause.
  // three renders the shadow pass with `material.shadowSide`, which defaults to
  // "the opposite of side" for a FrontSide material and to DoubleSide for a
  // DoubleSide one. So this material was writing its OWN front faces into the
  // depth map and then sampling them from a hair in front: that is the acne,
  // and no bias short of a metre hides it.
  //
  // Pinning shadowSide to BackSide writes the FAR side of the cap+skirt volume
  // instead. A receiver point can never be in front of the far side of the
  // solid it sits on, so self-acne is gone at the source rather than bought off
  // with the metre of normalBias that detached every other shadow in the world
  // (slice a). What comes back is the thing a low sun is FOR: a cliff's shadow
  // across its own beach, a peak's across its bay, terraces and cave mouths
  // that finally read as relief instead of paint.
  //
  // COST, low tier: zero — shadowMap.enabled is false on low, so a castShadow
  // flag is never read. On balanced/high it is +1 draw and the cap's 9-30k
  // triangles per island in the depth pass, and ONLY for islands already inside
  // the 310 m ortho box (three culls the shadow pass against it, and the box is
  // sized to hold one island). The distance LOD's proxy stays non-casting below.
  terrain.castShadow = true;
  terrainMat.shadowSide = THREE.BackSide;
  terrain.receiveShadow = true;
  group.add(terrain);

  // Underwater plinth: the terrain cap itself now follows the heightfield
  // below the waterline (shore rings above), so this skirt is fully
  // submerged — it just closes the volume from the mesh's underwater edge
  // down to the reef base so islands never read as floating shells.
  const skirtPositions: number[] = [];
  const skirtColors: number[] = [];
  const skirtIndices: number[] = [];
  const skirtSegments = lowDetail ? 26 : visualDetail < 0.85 ? 34 : 44;
  const skirtBottomColor = new THREE.Color(0x28414b);
  const skirtTopColor = new THREE.Color(0x2c545c);
  for (let segment = 0; segment <= skirtSegments; segment++) {
    const angle = (segment / skirtSegments) * Math.PI * 2;
    // Same wobble as the cap's outer ring, or the skirt hangs off a circle the
    // terrain no longer ends on and the seam between them opens.
    const top = surfacePoint(coastWobble(island, 1 + shoreRingSpan - 0.005, angle), angle, -0.04);
    const expand = 1.018 + (rng(segment * 313 + 11) - 0.5) * 0.02;
    const bottomY = -Math.max(4.5, r * 0.16) - rng(segment * 317 + 17) * Math.max(0.5, r * 0.022);
    skirtPositions.push(top.x, top.y, top.z);
    skirtPositions.push(top.x * expand, bottomY, top.z * expand);

    skirtColors.push(skirtTopColor.r, skirtTopColor.g, skirtTopColor.b);
    skirtColors.push(skirtBottomColor.r, skirtBottomColor.g, skirtBottomColor.b);
  }
  for (let segment = 0; segment < skirtSegments; segment++) {
    const a = segment * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    skirtIndices.push(a, b, c);
    skirtIndices.push(c, b, d);
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
  skirtGeometry.setAttribute('color', new THREE.Float32BufferAttribute(skirtColors, 3));
  skirtGeometry.setIndex(skirtIndices);
  skirtGeometry.computeVertexNormals();
  const shoreSkirt = new THREE.Mesh(
    skirtGeometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
  );
  shoreSkirt.name = 'island-shore-skirt';
  shoreSkirt.castShadow = true;
  shoreSkirt.receiveShadow = true;
  group.add(shoreSkirt);

  return { seaBase, peakEst, shoreRingSpan, rockSlopeColor, wetSandColor, submergedColor };
}

/** Proxy LOD = a genuine low-res sample of the same shared heightfield with the
 *  same biome coloring, so distant islands keep their true silhouette, coast
 *  shape, and palette — no pop, no monochrome domes.
 *
 *  IT DELIBERATELY CARRIES NO CAVE-MOUTH CUTOUT. It also carries no mouth carve,
 *  which is the reason: with no trench there is no floor-to-ceiling sheet across
 *  a doorway to cut away, only unbroken hillside — the right silhouette for an
 *  island seen from past the swap. Discarding here would be strictly worse, since
 *  the collar and tube that back the hole live under detailRoot and are hidden in
 *  the same breath as this mesh is shown, so the hole would be backed by nothing
 *  and read as a window straight through the island. The swap needs the camera
 *  420m clear of the island's own edge at worst (Game.ts detailRadius), and every
 *  mouth sits inside the footprint — asserted in scripts/test-cave-walk.mjs so
 *  the argument fails loudly if a generator ever puts a mouth out to sea. */
export function buildProxyTerrainMesh(ctx: IslandBuildCtx, terrain: TerrainBuild): THREE.Mesh {
  const { island, surfacePoint, sandColor, beachColor, cliffColor, grassColor, peakColor } = ctx;
  const { shoreRingSpan, seaBase, peakEst, rockSlopeColor, wetSandColor, submergedColor } = terrain;
  const pRad = 10;
  const pAng = 30;
  const pShore = 2;
  const pTotal = pRad + pShore;
  const pRingDist = (ring: number): number => ring <= pRad
    ? (ring === 0 ? 0 : Math.pow(ring / pRad, 0.9))
    : 1 + ((ring - pRad) / pShore) * shoreRingSpan;
  const pPos: number[] = [];
  const pIdx: number[] = [];
  const pCol: number[] = [];
  for (let ring = 0; ring <= pTotal; ring++) {
    const dRatio = pRingDist(ring);
    for (let seg = 0; seg <= pAng; seg++) {
      const angle = (seg / pAng) * Math.PI * 2;
      // The proxy traces the SAME wobbled coast the full mesh does, or the LOD
      // swap pops the island's whole outline in and out.
      const point = surfacePoint(coastWobble(island, dRatio, angle), angle, 0.02);
      pPos.push(point.x, point.y, point.z);
    }
  }
  for (let ring = 0; ring < pTotal; ring++) {
    for (let seg = 0; seg < pAng; seg++) {
      const a = ring * (pAng + 1) + seg;
      const b = a + 1;
      const c = a + pAng + 1;
      const d = c + 1;
      pIdx.push(a, c, b, b, c, d);
    }
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
  pGeo.setIndex(pIdx);
  pGeo.computeVertexNormals();
  const pNorm = pGeo.getAttribute('normal') as THREE.BufferAttribute;
  const pColor = new THREE.Color();
  for (let ring = 0; ring <= pTotal; ring++) {
    const dRatio = pRingDist(ring);
    for (let seg = 0; seg <= pAng; seg++) {
      const index = ring * (pAng + 1) + seg;
      const angle = (seg / pAng) * Math.PI * 2;
      const coast = getIslandCoastWeights(island, angle);
      const pointY = pPos[index * 3 + 1];
      const slope = THREE.MathUtils.clamp(1 - pNorm.getY(index), 0, 1);
      const heightNorm = THREE.MathUtils.clamp((pointY - seaBase) / peakEst, 0, 1);
      const shoreMask = THREE.MathUtils.smoothstep(dRatio, 0.72, 0.99);
      pColor.copy(sandColor);
      pColor.lerp(beachColor, shoreMask * coast.beach * 0.95);
      pColor.lerp(cliffColor, shoreMask * (coast.rocky + coast.cliff) * 0.75);
      pColor.lerp(grassColor, THREE.MathUtils.smoothstep(heightNorm, 0.02, 0.42) * (1 - shoreMask));
      pColor.lerp(rockSlopeColor, THREE.MathUtils.smoothstep(slope, 0.26, 0.6) * (1 - shoreMask) * 0.85);
      pColor.lerp(peakColor, THREE.MathUtils.smoothstep(heightNorm, 0.88, 1) * 0.4);
      const wet = THREE.MathUtils.smoothstep(-pointY, -0.55, 0.25);
      if (wet > 0) {
        pColor.lerp(wetSandColor, wet * 0.6);
        pColor.lerp(submergedColor, THREE.MathUtils.smoothstep(-pointY, 0.2, 2.6) * 0.8);
      }
      pCol.push(pColor.r, pColor.g, pColor.b);
    }
  }
  pGeo.setAttribute('color', new THREE.Float32BufferAttribute(pCol, 3));
  const proxyMesh = new THREE.Mesh(
    pGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 }),
  );
  // The far LOD is a 30-segment silhouette of the same heightfield. It must NOT
  // cast: at the crossover distance both meshes exist, and two shadows of one
  // island half a metre apart is a doubled, crawling edge across the water.
  proxyMesh.castShadow = false;

  return proxyMesh;
}
