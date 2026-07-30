/**
 * THE HOLE IN THE MOUNTAINSIDE.
 *
 * The island terrain is ONE polar heightfield: a single-valued function of xz.
 * That geometry can express a trench, a ledge, a cliff — but it can never
 * express "rock above, air below", which is exactly what a cave mouth is. So at
 * every mouth the heightfield ran straight across the opening: the shared carve
 * (`carveCaveMouthAt`) lowers the ground to the cave floor for the first ~1.4 m
 * and then ramps back to raw hillside by lz ≈ −2.6, and that ramp is a sheet of
 * terrain standing from floor to ceiling across the passage — tinted cave-rock
 * grey by the colour pass, so it read as a wall you could walk through. The user
 * reported it as "the entrance is still the mountain side visible but u can walk
 * through it".
 *
 * The fix is a per-fragment CUTOUT keyed on the SAME oriented boxes physics
 * walks (`getCaveInteriorAt` / `caveSegLocal`), so visual air and collision air
 * agree by construction instead of by tuning:
 *
 *     |lx| ≤ interiorRadius + pad,  −length ≤ lz ≤ 0,
 *     floorAt + CAVE_CUTOUT_LIFT ≤ y ≤ floorAt + height
 *
 * with `floorAt` ramping floorY → floorYEnd exactly as the shared frame does.
 *
 * The three bounds that are NOT the collision box are the load-bearing ones:
 *
 *  • `lz ≤ 0` — the mouth plane. The walkable union overhangs it by
 *    CAVE_NEAR_OVERHANG, but the drawn rock does not: the mouth tube's front rim
 *    is exactly lz = 0 (`frontOvershoot = 0`). Cutting past the plane would open
 *    a gap between the trench floor and the tube that nothing draws.
 *  • `y ≥ floorAt + CAVE_CUTOUT_LIFT` — the trench FLOOR is drawn terrain sitting
 *    at floorAt, and the terrain-mesh feather pass may lift a vertex by up to
 *    FEATHER_CAP (0.42 m). Never cut the ground the pirate stands on.
 *  • `|lx| ≤ cR + pad` — the void must be backed by rock from every angle. For
 *    the first `collarLen` metres the throat collar (radius 1.5·cR + 0.5) is
 *    behind it; deeper only the tube is, whose superellipse half-width is
 *    ≥ (cR + CAVE_SHELL_MARGIN)·CAVE_SHELL_K. Both bounds are asserted in
 *    scripts/test-cave-walk.mjs rather than trusted.
 *
 * The predicate exists twice — once as GLSL (`caveCutoutGlsl`, the thing that
 * actually opens the hole) and once as TypeScript (`caveCutoutHit`, used by the
 * cave shell's hillside tint and by the regression suite). They are written off
 * the same slot layout so a drift in one is a drift in both.
 */
import type { Island, IslandCave } from '../../../shared/types/index.js';

/** Metres above a segment's ramped floor before terrain may be cut away. Above
 *  the trench floor + the terrain feather pass's worst lift, below head height. */
export const CAVE_CUTOUT_LIFT = 0.55;
/** Lateral cut past the interior radius while the throat COLLAR is behind it. */
export const CAVE_CUTOUT_PAD_NEAR = 0.45;
/** …and once only the tube is behind it. Both must stay inside the drawn shell. */
export const CAVE_CUTOUT_PAD_DEEP = 0.18;
/** Uniform-array size cap. Islands generate a handful of mouths; the cap keeps
 *  the shader's slot count (and so its program cache key) small and stable. */
export const CAVE_CUTOUT_MAX_MOUTHS = 8;

/**
 * One island's mouth cutouts, packed for both the shader and the TS mirror.
 * Three flat vec4 blocks (three.js uploads a Float32Array straight through):
 *   a = (position.x, position.z, cos(rotation), sin(rotation))
 *   b = (interiorRadius, length, floorY, floorYEnd)      — world y
 *   c = (height, collarLen, 0, 0)
 */
export type CaveCutout = {
  readonly count: number;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly c: Float32Array;
};

/** How long the client's throat collar is for a segment — mirrors CaveBuilder's
 *  `collarLen` exactly, because the lateral pad depends on it. */
export function caveCollarLength(cave: IslandCave): number {
  return Math.min(7.0, (cave.length ?? 10) * 0.95);
}

/** Pack this island's surface mouths into cutout slots, or null when it has none. */
export function buildCaveCutout(island: Island): CaveCutout | null {
  const mouths = (island.caves ?? []).filter((c) => c.hasMouth === true).slice(0, CAVE_CUTOUT_MAX_MOUTHS);
  if (mouths.length === 0) return null;
  const a = new Float32Array(mouths.length * 4);
  const b = new Float32Array(mouths.length * 4);
  const c = new Float32Array(mouths.length * 4);
  mouths.forEach((cave, i) => {
    const cLen = cave.length ?? 10;
    const cR = cave.interiorRadius ?? 3.0;
    const floorY = cave.floorY ?? cave.position.y - 0.4;
    a[i * 4] = cave.position.x;
    a[i * 4 + 1] = cave.position.z;
    a[i * 4 + 2] = Math.cos(cave.rotation);
    a[i * 4 + 3] = Math.sin(cave.rotation);
    b[i * 4] = cR;
    b[i * 4 + 1] = cLen;
    b[i * 4 + 2] = floorY;
    b[i * 4 + 3] = cave.floorYEnd ?? floorY;
    c[i * 4] = cave.height;
    c[i * 4 + 1] = caveCollarLength(cave);
  });
  return { count: mouths.length, a, b, c };
}

/** Is this world point inside the cutout — i.e. does the terrain material
 *  DISCARD there? The TS mirror of the GLSL below. */
export function caveCutoutHit(cut: CaveCutout | null, wx: number, wy: number, wz: number): boolean {
  if (!cut) return false;
  for (let i = 0; i < cut.count; i++) {
    const cosR = cut.a[i * 4 + 2];
    const sinR = cut.a[i * 4 + 3];
    const dx = wx - cut.a[i * 4];
    const dz = wz - cut.a[i * 4 + 1];
    const lx = dx * cosR - dz * sinR;
    const lz = dx * sinR + dz * cosR;
    const cR = cut.b[i * 4];
    const cLen = cut.b[i * 4 + 1];
    if (lz > 0 || lz < -cLen) continue;
    const pad = -lz <= cut.c[i * 4 + 1] ? CAVE_CUTOUT_PAD_NEAR : CAVE_CUTOUT_PAD_DEEP;
    if (Math.abs(lx) > cR + pad) continue;
    const floorY = cut.b[i * 4 + 2];
    const along = cLen > 0 ? Math.min(1, Math.max(0, -lz / cLen)) : 0;
    const floorAt = floorY + (cut.b[i * 4 + 3] - floorY) * along;
    if (wy < floorAt + CAVE_CUTOUT_LIFT || wy > floorAt + cut.c[i * 4]) continue;
    return true;
  }
  return false;
}

/** GLSL for the cutout: uniform declarations + a `caveCutout(vec3)` function.
 *  `count` MUST be folded into the material's customProgramCacheKey — three.js
 *  otherwise hands back a cached program compiled for a different array size. */
export function caveCutoutGlsl(count: number): string {
  return `uniform vec4 uCaveMouthA[${count}];
uniform vec4 uCaveMouthB[${count}];
uniform vec4 uCaveMouthC[${count}];
bool caveCutout(vec3 wp) {
  for (int i = 0; i < ${count}; i++) {
    vec4 ma = uCaveMouthA[i];
    vec4 mb = uCaveMouthB[i];
    vec4 mc = uCaveMouthC[i];
    float dx = wp.x - ma.x;
    float dz = wp.z - ma.y;
    float lx = dx * ma.z - dz * ma.w;
    float lz = dx * ma.w + dz * ma.z;
    if (lz > 0.0 || lz < -mb.y) continue;
    float pad = (-lz <= mc.y) ? ${CAVE_CUTOUT_PAD_NEAR.toFixed(3)} : ${CAVE_CUTOUT_PAD_DEEP.toFixed(3)};
    if (abs(lx) > mb.x + pad) continue;
    float along = mb.y > 0.0 ? clamp(-lz / mb.y, 0.0, 1.0) : 0.0;
    float floorAt = mb.z + (mb.w - mb.z) * along;
    if (wp.y < floorAt + ${CAVE_CUTOUT_LIFT.toFixed(3)} || wp.y > floorAt + mc.x) continue;
    return true;
  }
  return false;
}
`;
}

/** The three uniform values a cutout feeds a material, as three.js wants them
 *  (flat Float32Array blocks — `flatten` passes those straight to uniform4fv). */
export function caveCutoutUniforms(cut: CaveCutout): Record<string, { value: Float32Array }> {
  return {
    uCaveMouthA: { value: cut.a },
    uCaveMouthB: { value: cut.b },
    uCaveMouthC: { value: cut.c },
  };
}
