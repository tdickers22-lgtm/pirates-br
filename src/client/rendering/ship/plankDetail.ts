import * as THREE from 'three';

/**
 * PLANK DETAIL — SHIPVIS-01 phase A (ships-21).
 *
 * WHAT WAS THERE. `makeWoodTexture` paints seven flat plank rows onto a
 * 256x128 canvas and that canvas is stretched over the whole lofted shell and
 * the whole deck slab. At boarding range one drawn "plank" is two metres wide,
 * there is no caulking, no per-plank variation, no normal relief and no wet
 * edge: the hull reads as a brown decal, which is the single largest gap to the
 * reference look in the audit's own ranking (ships-21, gap 1 of 8).
 *
 * WHY A SHADER AND NOT A TEXTURE. A texture big enough to carry 35 cm planks
 * over a 22 m galleon at boarding range is 4k+, per hull class, and it would
 * still stretch across the loft's tapering girth. The plank grid here is
 * evaluated from HULL-LOCAL POSITION, so the cells are the same physical size
 * at the stem as amidships, they cost no memory and no fetch, and the wet line
 * can move with the sea because it is a uniform, not a baked band.
 *
 * WHAT IT COSTS. Zero draw calls, zero triangles, zero bytes resident. It is
 * fragment ALU on materials that already exist:
 *   low      ~18 ALU + 1 hash  (colour only: caulking, plank jitter, grime, wet)
 *   balanced/high  + ~14 ALU + 2 derivative-free hashes (bevel normal + grain)
 * The extra work is behind `SHIP_PLANK_HIGH`, so the low tier compiles a
 * genuinely shorter program rather than branching around it at runtime.
 *
 * COMPOSITION. `applyHullHoleDiscard` already owns `onBeforeCompile` on the
 * hull material. This patch CHAINS: it calls whatever was installed first and
 * then makes its own replacements, and it folds the previous
 * `customProgramCacheKey` into its own so the two patches never share a
 * program with an unpatched material.
 */

/** Which two hull-local axes the planks run along, and how big a plank is. */
export type PlankSurface = 'hull' | 'deck';

export interface PlankUniforms {
  /** Hull-local Y of the sea surface this frame. Below it the planking is wet. */
  uWetY: { value: number };
  /** How far above the wet line the splash/damp band fades out, in metres. */
  uWetBand: { value: number };
}

export function makePlankUniforms(): PlankUniforms {
  return { uWetY: { value: 0 }, uWetBand: { value: 0.35 } };
}

/** Plank cell size in metres: (along the plank, across the plank). */
const PLANK_SIZE: Record<PlankSurface, [number, number]> = {
  // Hull strakes: 2.4 m butts, 0.28 m strake height (matches the drawn wales).
  hull: [2.4, 0.28],
  // Deck planking: 2.2 m lengths, 0.22 m wide — a foot-and-a-half board.
  deck: [2.2, 0.22],
};

/** Half-width of the caulking seam in cell units (along, across). */
const SEAM: Record<PlankSurface, [number, number]> = {
  hull: [0.018, 0.055],
  deck: [0.02, 0.07],
};

const HASH_GLSL = `
float shipPlankHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
`;

/**
 * Patch a ship surface material with procedural planking.
 *
 * @param highTier false on the low quality tier: colour detail only.
 */
export function applyPlankDetail(
  material: THREE.Material,
  surface: PlankSurface,
  uniforms: PlankUniforms,
  highTier: boolean,
): void {
  const [alongSize, acrossSize] = PLANK_SIZE[surface];
  const [seamAlong, seamAcross] = SEAM[surface];
  // Planks run fore-and-aft (hull-local Z) on both surfaces. They STACK in Y on
  // the shell (strakes) and in X on the deck (boards), so "across" is the axis
  // the caulking seams are perpendicular to — and the axis the bevel tilts the
  // normal along.
  const alongExpr = 'vPlankPos.z';
  const acrossExpr = surface === 'hull' ? 'vPlankPos.y' : 'vPlankPos.x';
  const acrossAxis = surface === 'hull' ? 'vec3(0.0, 1.0, 0.0)' : 'vec3(1.0, 0.0, 0.0)';

  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer) {
    prevCompile?.call(this, shader, renderer);
    shader.uniforms.uWetY = uniforms.uWetY;
    shader.uniforms.uWetBand = uniforms.uWetBand;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPlankPos;
varying vec3 vPlankAcross;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vPlankPos = (instanceMatrix * vec4(position, 1.0)).xyz;
#else
  vPlankPos = position;
#endif
  vPlankAcross = normalize(normalMatrix * ${acrossAxis});`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPlankPos;
varying vec3 vPlankAcross;
uniform float uWetY;
uniform float uWetBand;
${HASH_GLSL}`,
      )
      // The plank grid and its per-cell random are needed by BOTH the colour
      // block and the normal block, and <normal_fragment_begin> runs first, so
      // the grid is computed there and both blocks read the same cell.
      .replace(
        '#include <normal_fragment_begin>',
        `vec2 shipPlankQ = vec2(${alongExpr} / ${alongSize.toFixed(3)}, ${acrossExpr} / ${acrossSize.toFixed(3)});
  // Stagger every other strake so the butt joints do not line up into a ladder
  // (a straight column of butts is the classic "it is a texture" tell).
  float shipPlankRow = floor(shipPlankQ.y);
  shipPlankQ.x += 0.5 * mod(shipPlankRow, 2.0) + 0.31 * shipPlankHash(vec2(shipPlankRow, 7.0));
  vec2 shipPlankCell = floor(shipPlankQ);
  vec2 shipPlankF = fract(shipPlankQ);
  float shipPlankRnd = shipPlankHash(shipPlankCell);
  float shipPlankSeamA = smoothstep(0.0, ${seamAlong.toFixed(4)}, min(shipPlankF.x, 1.0 - shipPlankF.x));
  float shipPlankSeamB = smoothstep(0.0, ${seamAcross.toFixed(4)}, min(shipPlankF.y, 1.0 - shipPlankF.y));
  float shipPlankSeam = min(shipPlankSeamA, shipPlankSeamB);
  float shipPlankWet = 1.0 - smoothstep(0.0, uWetBand, vPlankPos.y - uWetY);
#include <normal_fragment_begin>
#ifdef SHIP_PLANK_HIGH
  // Bevel: each plank is chamfered at its edges, so the normal tilts ACROSS the
  // plank toward the seam. vPlankAcross is that object axis in view space, so
  // this is a real object-space perturbation, not a screen-space fake.
  float shipPlankEdge = 1.0 - smoothstep(0.0, 0.16, min(shipPlankF.y, 1.0 - shipPlankF.y));
  float shipPlankBevel = sign(0.5 - shipPlankF.y) * shipPlankEdge * 0.42;
  // Fine grain running ALONG the plank: cheap 1D ripple, per-plank phase.
  float shipPlankGrain = sin((${alongExpr} * 26.0) + shipPlankRnd * 40.0) * 0.05
    + sin((${acrossExpr} * 91.0) + shipPlankRnd * 17.0) * 0.03;
  normal = normalize(normal + vPlankAcross * (shipPlankBevel + shipPlankGrain));
#endif`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  // Caulking: oakum and pitch in the seams, near-black and never shiny.
  diffuseColor.rgb *= mix(0.34, 1.0, shipPlankSeam);
  // Per-plank timber variation — value first, then a slight hue swing so the
  // shell is not one flat brown at any distance.
  diffuseColor.rgb *= 0.86 + 0.28 * shipPlankRnd;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 0.97, 0.86), shipPlankRnd * 0.6);
  // Grime band: weed and slime collect just above the boot-top and fade out
  // over about half a metre. Anchored to the wet line so it rides the sea.
  float shipPlankGrime = exp(-max(0.0, vPlankPos.y - uWetY) * 2.4);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.60, 0.66, 0.52), 0.42 * shipPlankGrime);
  // Wet planking is darker and glossier than dry planking. This is what makes
  // the hull look like it is IN the water rather than sitting on a picture of it.
  diffuseColor.rgb *= mix(1.0, 0.52, shipPlankWet);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor * (0.88 + 0.26 * shipPlankRnd) - 0.46 * shipPlankWet, 0.05, 1.0);`,
      );
  };

  material.customProgramCacheKey = function () {
    const prev = prevKey ? prevKey.call(this) : '';
    return `${prev}|ship-plank-${surface}-${highTier ? 'hi' : 'lo'}`;
  };
  if (highTier) material.defines = { ...(material.defines ?? {}), SHIP_PLANK_HIGH: '' };
  material.needsUpdate = true;
}
