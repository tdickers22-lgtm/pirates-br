/**
 * Cliff kit draw (b4.6d; islands-02, islands-08, islands-12, islands-14).
 *
 * The server places the Blender cliff kit (scripts/blender/build_cliff_kit.py) on the static world
 * as `island.kitPieces` in WORLD coordinates (src/server/world/placement/cliffKit.ts); the same
 * list drives the convex-hull colliders in src/shared/hullCollide.ts on the server and in client
 * prediction. This module is the matching draw: one InstancedMesh per kit key per island, LOD0
 * from `<key>.glb`, thinned by InstanceLod's prop ramp and swapped to the `<key>_far` node of
 * `<key>_lods.glb` past the tier's far distance.
 *
 * Drawn on EVERY quality tier: the colliders exist on every tier, and a hull without a draw is an
 * invisible wall. Piece frame = GLB origin; yaw r maps local +Z to world (sin r, cos r), which is
 * exactly three's rotation about +Y, so the instance matrix is T(x,y,z) * Ry(yaw) * S(scale).
 */
import * as THREE from 'three';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import { getIslandKitPieces, type KitPieceInstance } from '../../../shared/hullCollide.js';
import type { IslandBuildCtx } from './context.js';
import { attachInstanceFarLod, attachInstanceLod } from './InstanceLod.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Group an island's kit pieces by key, each list sorted biggest first (InstanceLod's invariant). */
export function groupKitPieces(pieces: readonly KitPieceInstance[]): Map<string, KitPieceInstance[]> {
  const byKey = new Map<string, KitPieceInstance[]>();
  for (const p of pieces) {
    const list = byKey.get(p.key) ?? [];
    list.push(p);
    byKey.set(p.key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => (b.scale ?? 1) - (a.scale ?? 1));
  return byKey;
}

/** Build the island's cliff kit batches into `ctx.group`. Returns the number of instances drawn. */
export function buildCliffKit(ctx: IslandBuildCtx): number {
  const pieces = getIslandKitPieces(ctx.island);
  if (pieces.length === 0) return 0;
  const { group, lowDetail } = ctx;
  // Pieces are in world space; the island group may carry its own transform.
  group.updateMatrix();
  const toLocal = group.matrix.clone().invert();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let drawn = 0;

  for (const [key, list] of groupKitPieces(pieces)) {
    const near = assets.mergedGeometry(key as AssetName);
    if (!near) {
      console.warn(`[cliff-kit] ${key}.glb not loaded: ${list.length} collider(s) on ${ctx.island.id} have no draw`);
      continue;
    }
    const inst = new THREE.InstancedMesh(near.geometry, near.material, list.length);
    list.forEach((p, i) => {
      const s = p.scale ?? 1;
      q.setFromAxisAngle(Y_AXIS, p.yaw);
      m.compose(pos.set(p.x, p.y, p.z), q, scl.set(s, s, s)).premultiply(toLocal);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.name = `cliffkit-${key}`;
    inst.castShadow = !lowDetail;
    inst.receiveShadow = true;
    if (!near.geometry.boundingBox) near.geometry.computeBoundingBox();
    const bb = near.geometry.boundingBox;
    attachInstanceLod(inst, list.map((p) => p.scale ?? 1), bb ? bb.max.y - bb.min.y : 0);
    const far = assets.mergedNodeGeometry(`${key}_lods` as AssetName, `${key}_far`);
    if (far) attachInstanceFarLod(inst, { geometry: near.geometry, material: near.material }, far);
    group.add(inst);
    drawn += list.length;
  }
  return drawn;
}
