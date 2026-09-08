/**
 * A GARRISON ON THE HORIZON IS HIDDEN, NOT DEMOLISHED (final-sweep P1).
 *
 * review-6's draw-range gate was right about the draws — an island skeleton is
 * the one body `makePlayerRig` refuses, so it stays the 22-26-draw procedural
 * build, and several armed garrisons across the map used to draw all of them.
 * The fix it shipped, though, removed the mesh from the scene and deleted the
 * map entry at a hard 150 m boundary. Both ends of that distance move (camera
 * AND skeleton), so a pirate walking a garrison island's shoreline re-crosses
 * it over and over, and every re-entry takes the `!mesh` branch: 98 `new
 * THREE.*` calls with no shared geometry or material, up to SKELETON_LIVE_CAP
 * of them on one frame. Nothing was disposed on the way out either, so the
 * rebuild leaked the old one.
 *
 * Two rules, both pinned by scripts/test-skeleton-crowd.mjs:
 *
 *  1. HYSTERESIS. Separate arm/disarm radii, the way
 *     `OceanRenderer.armHullMaskProgram` splits the hull-mask program swap.
 *     A body already drawn stays drawn out to 150 m; a body that is hidden
 *     must come back inside 135 m before it is drawn again. Nothing that
 *     oscillates inside that 15 m band can flip the state.
 *  2. HIDE, DO NOT DESTROY. The caller sets `visible = false` and keeps the
 *     mesh, so the transition costs one boolean instead of a rebuild. The
 *     mesh is only released (and disposed) when the player leaves the match.
 *
 * Pure and DOM-free so the suite can oscillate a camera across the boundary
 * under plain node and count the transitions.
 */

/** Drawn out to here; past it an already-drawn skeleton is hidden. */
export const SKELETON_DRAW_RANGE_M = 150;
/** A hidden skeleton is only drawn again once it is back inside here. */
export const SKELETON_DRAW_ARM_RANGE_M = 135;

export const SKELETON_DRAW_RANGE_SQ = SKELETON_DRAW_RANGE_M * SKELETON_DRAW_RANGE_M;
export const SKELETON_DRAW_ARM_RANGE_SQ = SKELETON_DRAW_ARM_RANGE_M * SKELETON_DRAW_ARM_RANGE_M;

/**
 * Should this skeleton's body be hidden this frame?
 *
 * @param distSq   squared camera→skeleton distance, metres².
 * @param wasCulled the state this skeleton was left in last frame (a body that
 *                  has never been built counts as culled, so a distant garrison
 *                  is never built in the first place).
 */
export function skeletonDrawCulled(distSq: number, wasCulled: boolean): boolean {
  return distSq > (wasCulled ? SKELETON_DRAW_ARM_RANGE_SQ : SKELETON_DRAW_RANGE_SQ);
}
