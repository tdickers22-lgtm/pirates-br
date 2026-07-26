import * as THREE from 'three';

/**
 * Zero-scale matrix used to collapse an InstancedMesh slot whose prop is gone.
 * InstancedMesh has no "hide instance N" — writing a degenerate transform is the
 * standard way, and sharing ONE frozen matrix keeps every caller collapsing a
 * slot the same way with no per-removal allocation.
 */
export const ZERO_SCALE_MAT4 = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Stop three from re-deriving a static subtree's world matrices every frame.
 *
 * WebGLRenderer.render() walks the WHOLE scene graph and recomputes
 * `matrixWorld = parent.matrixWorld * matrix` for every node, whether or not it
 * moved and whether or not it is visible. An island carries 300–650 meshes;
 * twelve of them put ~6,800 nodes on that walk, and profiling the open-sea view
 * put `updateMatrixWorld` + `multiplyMatrices` at 31% of frame CPU — all of it
 * spent re-deriving the same matrices for rocks that will never move again.
 *
 * Clearing `matrixWorldAutoUpdate` on a subtree ROOT makes three skip the whole
 * branch (see Object3D.updateMatrixWorld: it only recurses into a child when
 * `child.matrixWorldAutoUpdate === true` OR the walk is forced). The one-off
 * `updateMatrixWorld(true)` here leaves every world matrix inside correct and
 * final, and clearing `matrixAutoUpdate` stops the root re-composing a local
 * matrix that will never change again.
 *
 * IMPORTANT — the skip only happens if the walk is not FORCED, and it is forced
 * the moment any ancestor re-composes its own matrix (`updateMatrix()` sets
 * `matrixWorldNeedsUpdate` unconditionally). Every ancestor up to the scene must
 * therefore be static too: see `freezeStaticParent`.
 *
 * The root's own transform is baked at this moment, so only call it once the
 * subtree is parented and placed — and never on anything whose ANCESTOR moves.
 */
export function freezeStaticSubtree(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.matrixAutoUpdate = false;
  root.matrixWorldAutoUpdate = false;
}

/**
 * Mark a container that never moves but whose children still animate (the
 * scene, the environment root). It keeps being walked — but it stops dirtying
 * itself every frame, which is what lets a frozen child below it be skipped.
 */
export function freezeStaticParent(node: THREE.Object3D): void {
  node.updateMatrix();
  node.matrixAutoUpdate = false;
  node.matrixWorldNeedsUpdate = true; // one last refresh, then it holds still
}

/**
 * Refresh one node inside a frozen subtree after its transform was animated.
 *
 * Live FX nodes (an erupting geyser's splash collar, a felled palm mid-topple)
 * can still sit inside a frozen island: the freeze is a flag on the BOUNDARY
 * node, so a descendant that keeps `matrixWorldAutoUpdate` can recompute itself
 * against its parent's (correct, frozen) world matrix on demand. Call this
 * right after writing position/rotation/scale on such a node.
 */
export function refreshFrozenChild(node: THREE.Object3D): void {
  node.updateMatrixWorld(true);
}
