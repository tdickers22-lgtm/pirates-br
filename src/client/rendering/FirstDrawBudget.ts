import * as THREE from 'three';

/**
 * One frame, one allowance for showing things the GL driver has never drawn.
 *
 * Nothing reaches the driver until a mesh is actually drawn. So the frame on
 * which a group of objects first becomes visible is the frame that pays every
 * geometry upload and every shader link behind them, synchronously, on the main
 * thread — and LOD radii are exactly the machinery for making large groups of
 * objects become visible at the same instant.
 *
 * `IslandDetailWarmer` fixed that for an island's detail subtree. It was not the
 * only place it happens, and the others kept the freeze alive by themselves.
 * Measured on a first approach after the island fix had landed:
 *
 *   • forty-four chests crossed the loot radius together — 361 geometries on
 *     one frame;
 *   • two ships crossed their 285m detail radius together — 140 more.
 *
 * Each of those tiers is written in a different file and none of them knew
 * about the others, which is the point of putting the allowance HERE rather
 * than in any one of them: they cross their radii on the same frames, so a
 * budget held separately per tier is not a budget at all.
 *
 * The rule is deliberately narrow. Only the FIRST appearance of an object is
 * ever delayed, and only by frames — once the driver has drawn it, this is a
 * plain assignment forever after. No radius changes, nothing that has ever been
 * on screen can be held back, and an object that arrives late arrives within a
 * few frames of when it would have. What it buys is that the arrival is spread
 * over those frames instead of landing on one.
 */

/** MESHES whose first draw the whole client may pay for on a single frame.
 *
 *  Counted in meshes, not in objects, because the objects are nothing like each
 *  other: a sea rock is one mesh, a chest is eight, a hull's detail root is
 *  seventy-eight. An allowance of "six objects" let six of the heavy ones
 *  through together and put 204 geometries on a frame — a budget denominated in
 *  the wrong unit is a budget that does not bind.
 *
 *  Small on purpose. What this gates is objects arriving at the far edge of
 *  their LOD radius, where a few frames of delay cannot be seen and the frame
 *  that lands all of them at once very much can. */
const FIRST_DRAW_MESHES_PER_FRAME = 48;

let budget = 0;
let drawn = new WeakSet<THREE.Object3D>();
/** Mesh count per root, counted once — the roots this is asked about are static
 *  subtrees, and re-walking a hull every frame would cost more than it saves. */
let subtreeCost = new WeakMap<THREE.Object3D, number>();

/** Claim this frame's allowance. Call once per animation frame, from the game
 *  loop, before anything can ask to be shown. */
export function beginFirstDrawFrame(): void {
  budget = FIRST_DRAW_MESHES_PER_FRAME;
}

/** What is left of this frame's allowance. */
export function firstDrawRemaining(): number {
  return budget;
}

/** Charge the shared allowance directly. For amortizers that do their own
 *  chunking — the island detail reveal — and must not be able to spend a
 *  frame's whole upload budget in parallel with everyone else's. */
export function spendFirstDraw(meshes: number): void {
  budget -= meshes;
}

/** True while nothing has been charged to this frame yet. An object bigger than
 *  the entire allowance has to be let through on some frame or it would never
 *  be shown at all; this says when that is safe, namely when it lands alone. */
export function firstDrawFrameUntouched(): boolean {
  return budget >= FIRST_DRAW_MESHES_PER_FRAME;
}

function meshCost(root: THREE.Object3D): number {
  let cached = subtreeCost.get(root);
  if (cached === undefined) {
    cached = 0;
    root.traverse((node) => { if ((node as THREE.Mesh).isMesh) cached! += 1; });
    subtreeCost.set(root, cached);
  }
  return cached;
}

/**
 * MEASUREMENT ONLY — open the allowance wide for one settling pass.
 *
 * Every count a budget grades (draw calls, triangles, programs) is decided by
 * which objects are VISIBLE, and this allowance is the thing that decides that
 * over a run of frames rather than on one. On a GPU that is a handful of frames
 * and no probe ever noticed; on the software rasteriser this machine is limited
 * to, a frame takes two to seven SECONDS, so a rig that waits twelve seconds
 * after the join and then counts is counting a world that is still arriving.
 * That is exactly how a census read 687 draws at the dock vista where the July
 * pass measured 2206 — not a saving, an unfinished reveal.
 *
 * So the probe settles the world first. The pacing itself is a separate contract
 * with its own tests (test-first-draw-budget, test-island-reveal); this hook is
 * only ever reached through the debug object, never from the game loop.
 */
export function openFirstDrawBudgetForSettle(): void {
  budget = Number.POSITIVE_INFINITY;
}

/** Match teardown: the next match's objects are new, and must not inherit
 *  "already drawn" from a set still holding the last match's. */
export function clearFirstDrawBudget(): void {
  drawn = new WeakSet<THREE.Object3D>();
  subtreeCost = new WeakMap<THREE.Object3D, number>();
  budget = 0;
}

/** True once the driver has drawn this root — it owes nothing and is never
 *  gated again. Exposed for the probes, which need to tell a prop being held
 *  back from a prop that is simply out of range. */
export function hasBeenDrawn(root: THREE.Object3D): boolean {
  return drawn.has(root);
}

/**
 * Set an LOD-gated object's visibility, holding its FIRST appearance to this
 * frame's allowance.
 *
 * Hiding is always immediate — there is no cost to hiding, and deferring it
 * would be a real visual change.
 */
export function showWhenAffordable(root: THREE.Object3D, want: boolean): void {
  if (!want) { root.visible = false; return; }
  if (drawn.has(root)) { root.visible = true; return; }
  // An object under a group that is itself hidden cannot reach the driver this
  // frame, so it neither needs the allowance nor may claim to have spent it.
  // Without this an island group held back for a frame after its build would
  // burn the whole budget on props that were never going to be drawn.
  if (!ancestorsVisible(root)) { root.visible = true; return; }
  const price = meshCost(root);
  // A root heavier than the whole allowance must still get through eventually,
  // but only on a frame it has to itself.
  if (price > budget && !firstDrawFrameUntouched()) { root.visible = false; return; }
  budget -= price;
  drawn.add(root);
  root.visible = true;
}

function ancestorsVisible(node: THREE.Object3D): boolean {
  for (let cursor: THREE.Object3D | null = node.parent; cursor; cursor = cursor.parent) {
    if (!cursor.visible) return false;
  }
  return true;
}
