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
 * evaluated in metric STRAKE SPACE on the hull (v2, b4.2e) and hull-local
 * position on the deck, so details are the same physical size
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

/** Which surface: the lofted shell (strake space) or the deck (boards in X). */
export type PlankSurface = 'hull' | 'deck';

export interface PlankUniforms {
  /** Hull-local Y of the sea surface this frame. Below it the planking is wet. */
  uWetY: { value: number };
  /** How far above the wet line the splash/damp band fades out, in metres. */
  uWetBand: { value: number };
  /** 1 on the local crew's ship: a thin gilded edge along the boot-top (ships-04).
   *  It replaced the gold-tinted foam collar, which read as a sand tray. */
  uOwnEdge: { value: number };
  /** Bounce/env lift as a fraction of albedo. The ships have no env map, so the
   *  shaded side of a hull went near-black (ships-05: hull luma 32-36/255). */
  uEnvLift: { value: number };
}

export function makePlankUniforms(): PlankUniforms {
  return { uWetY: { value: 0 }, uWetBand: { value: 0.35 }, uOwnEdge: { value: 0 }, uEnvLift: { value: PLANK_ENV_LIFT } };
}

// ── PLANK SHADER v2 (b4.2e, ships-05) ─────────────────────────────────────────
// The hull planks no longer run in world-Y bands. Every shell vertex carries a
// STRAKE-SPACE coordinate (`strakeUv`, computeStrakeSpace below) built from the
// spline shell itself: x = arc length along the hull at that girth (metres),
// y = strake index = girth arc length from the sheer / girth at that column x
// strake count, z = that column's strake width (metres). So the strakes follow
// the sheer, taper into the stem rabbet with the SAME count as amidships (no
// band is lost or born at the bow), and every metric detail (caulking, butts,
// trenails) stays the same physical size wherever the strake narrows.

/** Target strake width amidships (m); the count per class is girth / this. */
export const STRAKE_TARGET_WIDTH = 0.26;
/** Plank (butt-to-butt) length, metres. Inside the 5-8 m spec on every class. */
export const PLANK_LENGTH: Record<PlankSurface, number> = { hull: 6.4, deck: 5.6 };
/** Butts shift by a third of a plank per strake: a 3-strake stagger. */
export const BUTT_STAGGER_STRAKES = 3;
/** Trenail pairs on every frame line, metres apart (hull-local Z). */
export const TRENAIL_PITCH = 0.6;
/** Caulked seam full width, metres (1.2 cm of oakum and pitch). */
export const CAULK_WIDTH = 0.012;
/** Grime gradient height above the live wet line, metres. */
export const GRIME_HEIGHT = 0.4;
/** Boot-top: a tarred band at the design waterline, hull-local y range (m). */
export const BOOT_TOP: [number, number] = [-0.08, 0.15];
/** Own-ship gilded edge: centre y (m, just above the boot-top) and half-height. */
export const OWN_EDGE_Y = 0.19;
export const OWN_EDGE_HALF = 0.022;
/** Default env lift (fraction of albedo added as bounce light). */
export const PLANK_ENV_LIFT = 0.36;

/**
 * The same env lift for outboard timber that is NOT on the plank shader (wales,
 * boot-top, the stern castle): radiance += albedo * lift, through the emissive
 * map so it rides three's own emissivemap chunk (no onBeforeCompile, so it
 * composes with the strakes' hull-hole discard). Without it the stern castle
 * read as a black slab at noon (gallery galleon stern hullLuma 37.2 < 45).
 * Hold timber stays unlifted: the hold is lit by its lanterns.
 */
export function applyTimberEnvLift(mat: THREE.MeshStandardMaterial, lift = PLANK_ENV_LIFT): void {
  mat.emissive.setRGB(1, 1, 1);
  mat.emissiveMap = mat.map;
  mat.emissiveIntensity = lift;
}
/** Deck boards are fixed-width, laid in X. */
const DECK_BOARD_WIDTH = 0.22;

/**
 * Strake-space coordinates for a spline shell from makeSplineHullGeometry
 * (userData {cols, rows, shellVerts}; col-major per side, row 0 = sheer, last =
 * keel). Returns (along m, strake index, strake width m) per vertex and the
 * strake count. Transom/stem cap vertices get horizontal planks: (x, -y/target,
 * target). Pure and deterministic: the gate reads the same numbers the GPU does.
 */
export function computeStrakeSpace(geo: THREE.BufferGeometry): { data: Float32Array; strakes: number } {
  const { cols, rows, shellVerts } = geo.userData as { cols: number; rows: number; shellVerts: number };
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const data = new Float32Array(n * 3);
  const vi = (side: number, c: number, r: number) => side * cols * rows + c * rows + r;
  const dist = (a: number, b: number) => Math.hypot(pos.getX(a) - pos.getX(b), pos.getY(a) - pos.getY(b), pos.getZ(a) - pos.getZ(b));
  // Girth per column (both sides are mirror images; measure starboard).
  let maxGirth = 0;
  const girth: number[] = [];
  for (let c = 0; c < cols; c++) {
    let g = 0;
    for (let r = 1; r < rows; r++) g += dist(vi(0, c, r), vi(0, c, r - 1));
    girth.push(g);
    if (g > maxGirth) maxGirth = g;
  }
  const strakes = Math.max(4, Math.round(maxGirth / STRAKE_TARGET_WIDTH));
  for (let side = 0; side < 2; side++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let r = 0; r < rows; r++) {
        if (r > 0) s += dist(vi(side, c, r), vi(side, c, r - 1));
        const k = vi(side, c, r) * 3;
        const G = girth[c];
        data[k + 1] = G > 1e-6 ? (s / G) * strakes : (r / (rows - 1)) * strakes;
        data[k + 2] = Math.max(1e-3, G / strakes);
      }
    }
    // Along: arc length from the transom at constant girth row.
    for (let r = 0; r < rows; r++) {
      let a = 0;
      for (let c = 0; c < cols; c++) {
        if (c > 0) a += dist(vi(side, c, r), vi(side, c - 1, r));
        data[vi(side, c, r) * 3] = a;
      }
    }
  }
  for (let i = shellVerts; i < n; i++) {
    data[i * 3] = pos.getX(i);
    data[i * 3 + 1] = -pos.getY(i) / STRAKE_TARGET_WIDTH;
    data[i * 3 + 2] = STRAKE_TARGET_WIDTH;
  }
  return { data, strakes };
}

/** Attach `strakeUv` to a spline shell (idempotent). Returns the strake count. */
export function addStrakeSpace(geo: THREE.BufferGeometry): number {
  const { data, strakes } = computeStrakeSpace(geo);
  geo.setAttribute('strakeUv', new THREE.Float32BufferAttribute(data, 3));
  geo.userData.strakes = strakes;
  return strakes;
}

const HASH_GLSL = `
float shipPlankHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
`;

const f = (x: number) => x.toFixed(4);

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
  const hull = surface === 'hull';
  const plankLen = PLANK_LENGTH[surface];
  // Hull: strake space from the shell attribute. Deck: boards stack in X.
  const acrossAxis = hull ? 'vec3(0.0, 1.0, 0.0)' : 'vec3(1.0, 0.0, 0.0)';
  const coords = hull
    ? `float shipPlankAlongM = vStrake.x;
  float shipStrakeIdx = vStrake.y;
  float shipStrakeW = vStrake.z;`
    : `float shipPlankAlongM = vPlankPos.z;
  float shipStrakeIdx = vPlankPos.x / ${f(DECK_BOARD_WIDTH)};
  float shipStrakeW = ${f(DECK_BOARD_WIDTH)};`;

  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer) {
    prevCompile?.call(this, shader, renderer);
    shader.uniforms.uWetY = uniforms.uWetY;
    shader.uniforms.uWetBand = uniforms.uWetBand;
    shader.uniforms.uOwnEdge = uniforms.uOwnEdge;
    shader.uniforms.uEnvLift = uniforms.uEnvLift;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPlankPos;
varying vec3 vPlankAcross;${hull ? '\nattribute vec3 strakeUv;\nvarying vec3 vStrake;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vPlankPos = (instanceMatrix * vec4(position, 1.0)).xyz;
#else
  vPlankPos = position;
#endif${hull ? '\n  vStrake = strakeUv;' : ''}
  vPlankAcross = normalize(normalMatrix * ${acrossAxis});`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPlankPos;
varying vec3 vPlankAcross;${hull ? '\nvarying vec3 vStrake;' : ''}
uniform float uWetY;
uniform float uWetBand;
uniform float uOwnEdge;
uniform float uEnvLift;
${HASH_GLSL}`,
      )
      // The plank grid and its per-cell random are needed by BOTH the colour
      // block and the normal block. In three's standard/physical fragment
      // <map_fragment> runs BEFORE <normal_fragment_begin>, so the grid is
      // declared ahead of the colour block (liveplay-04: declared at the normal
      // block it never linked).
      .replace(
        '#include <map_fragment>',
        `${coords}
  float shipPlankRow = floor(shipStrakeIdx);
  // 3-strake butt stagger plus a small per-strake jitter, so butts never ladder.
  float shipPlankAlong = shipPlankAlongM / ${f(plankLen)}
    + mod(shipPlankRow, ${BUTT_STAGGER_STRAKES.toFixed(1)}) / ${BUTT_STAGGER_STRAKES.toFixed(1)}
    + 0.07 * shipPlankHash(vec2(shipPlankRow, 7.0));
  vec2 shipPlankCell = vec2(floor(shipPlankAlong), shipPlankRow);
  vec2 shipPlankF = vec2(fract(shipPlankAlong), fract(shipStrakeIdx));
  float shipPlankRnd = shipPlankHash(shipPlankCell);
  // Seams in METRES, so the caulking is 1.2 cm wide on a 26 cm strake amidships
  // and on a 9 cm strake at the stem alike.
  float shipButtM = min(shipPlankF.x, 1.0 - shipPlankF.x) * ${f(plankLen)};
  float shipSeamM = min(shipPlankF.y, 1.0 - shipPlankF.y) * shipStrakeW;
  float shipPlankSeamA = smoothstep(${f(CAULK_WIDTH * 0.25)}, ${f(CAULK_WIDTH * 0.5)}, shipButtM);
  float shipPlankSeamB = smoothstep(${f(CAULK_WIDTH * 0.25)}, ${f(CAULK_WIDTH * 0.5)}, shipSeamM);
  float shipPlankSeam = min(shipPlankSeamA, shipPlankSeamB);
  // Trenail pairs on every frame line (hull-local Z), at 30% / 70% of the strake.
  float shipFrameM = abs(fract(vPlankPos.z / ${f(TRENAIL_PITCH)} + 0.5) - 0.5) * ${f(TRENAIL_PITCH)};
  float shipNailM = min(abs(shipPlankF.y - 0.3), abs(shipPlankF.y - 0.7)) * shipStrakeW;
  float shipTrenail = 1.0 - smoothstep(0.009, 0.015, length(vec2(shipFrameM, shipNailM)));
  float shipPlankWet = 1.0 - smoothstep(0.0, uWetBand, vPlankPos.y - uWetY);
#include <map_fragment>`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
#ifdef SHIP_PLANK_HIGH
  // Bevel: each plank is chamfered at its edges, so the normal tilts ACROSS the
  // plank toward the seam (object axis in view space, a real perturbation).
  float shipPlankEdge = 1.0 - smoothstep(0.0, 0.16, min(shipPlankF.y, 1.0 - shipPlankF.y));
  float shipPlankBevel = sign(0.5 - shipPlankF.y) * shipPlankEdge * 0.42;
  // Fine grain running ALONG the plank: cheap 1D ripple, per-plank phase.
  float shipPlankGrain = sin((shipPlankAlongM * 26.0) + shipPlankRnd * 40.0) * 0.05
    + sin((shipStrakeIdx * shipStrakeW * 91.0) + shipPlankRnd * 17.0) * 0.03;
  normal = normalize(normal + vPlankAcross * (shipPlankBevel + shipPlankGrain));
#endif`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  // Caulking: oakum and pitch in the seams, near-black and never shiny.
  diffuseColor.rgb *= mix(0.34, 1.0, shipPlankSeam);
  // Trenails: end-grain oak pegs, darker than the plank face.
  diffuseColor.rgb *= mix(1.0, 0.58, shipTrenail);
  // Per-plank timber tone, lifted (ships-05: the old 0.86-1.14 swing on a dark
  // base put the shaded side near black), then a slight hue swing.
  diffuseColor.rgb *= 0.98 + 0.26 * shipPlankRnd;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 0.97, 0.86), shipPlankRnd * 0.6);
${hull ? `  // Boot-top: tarred band at the design waterline.
  float shipBoot = 1.0 - smoothstep(0.0, 0.02, max(${f(BOOT_TOP[0])} - vPlankPos.y, vPlankPos.y - ${f(BOOT_TOP[1])}));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.38, 0.34), shipBoot);
` : ''}  // Grime: weed and slime over the ${GRIME_HEIGHT} m above the LIVE wet line.
  float shipPlankGrime = 1.0 - smoothstep(0.0, ${f(GRIME_HEIGHT)}, max(0.0, vPlankPos.y - uWetY));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.68, 0.54), 0.40 * shipPlankGrime);
  // Wet planking is darker and glossier than dry planking.
  diffuseColor.rgb *= mix(1.0, 0.6, shipPlankWet);
${hull ? `  // Own ship: a thin gilded edge just above the boot-top (ships-04 identity).
  float shipGold = uOwnEdge * (1.0 - smoothstep(0.0, 0.01, abs(vPlankPos.y - ${f(OWN_EDGE_Y)}) - ${f(OWN_EDGE_HALF)}));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.64, 0.22), shipGold);
` : '  float shipGold = 0.0;\n'}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor * (0.88 + 0.26 * shipPlankRnd) - 0.46 * shipPlankWet - 0.3 * shipGold, 0.05, 1.0);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  // Env lift: bounce light the scene has no env map for, so the shaded side of
  // a hull stays warm brown; the gold edge glints a little in shade too.
  totalEmissiveRadiance += diffuseColor.rgb * uEnvLift * (1.0 - 0.5 * shipPlankWet) + vec3(0.22, 0.15, 0.04) * shipGold;`,
      );
  };

  material.customProgramCacheKey = function () {
    const prev = prevKey ? prevKey.call(this) : '';
    return `${prev}|ship-plank2-${surface}-${highTier ? 'hi' : 'lo'}`;
  };
  if (highTier) material.defines = { ...(material.defines ?? {}), SHIP_PLANK_HIGH: '' };
  material.needsUpdate = true;
}
