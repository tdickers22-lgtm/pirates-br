import * as THREE from 'three';
import { acquireSharedGeometry } from './geometry.js';

/**
 * RIGGING — SHIPVIS-01 phase C / ships-16.
 *
 * WHAT WAS THERE. Every rope, shroud, ratline, halyard and brace on the ship
 * was a segment in one of two `LineSegments` with a `LineBasicMaterial`:
 * one-pixel hairlines that take no light, cast no shadow, alias at any distance
 * and thin out to nothing under MSAA. Worse, the endpoints were baked at BUILD
 * time from the yard's REST position, while the yard itself lives inside a
 * `trimPivot` that swings with `ship.sailAngle` every frame — so bracing the
 * yard 60 degrees swung the spar clean away from the ropes that were supposed
 * to lead to its ends, and the brace whose own comment says it "runs up to the
 * yard END on that side" ran up to a fixed point beside the mast instead.
 *
 * WHAT IT IS NOW. One `InstancedMesh` of unit cylinders per rope family (rope,
 * ratline): one draw call each, exactly as before, but lit, shadowed and thick
 * enough to survive a resolve. Instances whose upper end is ON the yard carry
 * the attachment point in PIVOT-LOCAL space and have their matrix rewritten
 * from the pivot whenever the trim moves, so the rope is attached to the spar
 * rather than to a memory of where the spar used to be.
 *
 * WHAT IT COSTS ON THE LOW TIER. Draw calls: unchanged — two instanced draws
 * replace the two line draws. Triangles (measured by the gate): a sloop carries
 * 23 segments, a brigantine 39, a galleon 55. At three radial sides on the low
 * tier a cylinder is 6 triangles, so a sloop's whole rig is 138 triangles and a
 * full twelve-hull Solo match is 1,656 — under a tenth of a percent of the
 * wide-shot budget. Balanced and high use five sides: 230 per sloop, 550 per
 * galleon. Resident bytes are one unit cylinder per tier for the whole game.
 * Per-frame work is O(runs attached to a yard) — four on a sloop — and only on
 * frames where the trim actually moved; the matrices are written into the
 * existing instance buffer through module-level temporaries, so there are no
 * allocations in the hot path.
 */

export interface RopeRun {
  /** Fixed end, in ship-group local space. */
  a: THREE.Vector3;
  /** Free end, in ship-group local space at rest. */
  b: THREE.Vector3;
  /** If set, `b` is carried by this yard pivot and `bLocal` is its seat. */
  pivot?: THREE.Group;
  /** Where on the pivot the rope is made fast, in PIVOT-local space. */
  bLocal?: THREE.Vector3;
}

interface DynamicRope {
  index: number;
  pivot: THREE.Group;
  local: THREE.Vector3;
  anchor: THREE.Vector3;
}

export interface Rigging {
  mesh: THREE.InstancedMesh;
  dynamic: DynamicRope[];
  /** Last trim the dynamic instances were written for, per pivot. */
  lastYaw: number[];
}

// Module-level scratch: the per-frame path must not allocate.
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Unit cylinder along +Y, height 1, radius 1, open-ended (a rope has no caps
 * worth drawing). One per tier for the whole game — the instance matrix does
 * the rest.
 *
 * It goes through the refcounted shared-geometry cache rather than a private
 * Map on purpose: ShipRenderer.clear() releases every geometry it can reach, so
 * a private cache would have its buffer disposed by the first match teardown
 * and the next match's rigging would draw from a dead buffer.
 */
function ropeGeometry(sides: number): THREE.BufferGeometry {
  return acquireSharedGeometry(
    `rope-cylinder-${sides}`,
    () => new THREE.CylinderGeometry(1, 1, 1, sides, 1, true),
  )!;
}

function writeInstance(mesh: THREE.InstancedMesh, index: number, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-6) {
    // Degenerate run: park it at zero scale rather than emitting a NaN matrix
    // (an InstancedMesh with one NaN matrix drops the WHOLE draw).
    _mat.makeScale(0, 0, 0);
    mesh.setMatrixAt(index, _mat);
    return;
  }
  _dir.multiplyScalar(1 / len);
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _quat.setFromUnitVectors(_up, _dir);
  _scale.set(radius, len, radius);
  _mat.compose(_mid, _quat, _scale);
  mesh.setMatrixAt(index, _mat);
}

/**
 * Build one instanced rope family.
 *
 * @param sides radial segments — 3 on the low tier, 5 elsewhere.
 */
export function buildRigging(
  runs: RopeRun[],
  material: THREE.Material,
  radius: number,
  sides: number,
): Rigging | null {
  if (runs.length === 0) return null;
  const mesh = new THREE.InstancedMesh(ropeGeometry(sides), material, runs.length);
  mesh.castShadow = true;
  mesh.name = 'ship-rigging';
  const dynamic: DynamicRope[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    writeInstance(mesh, i, run.a, run.b, radius);
    if (run.pivot && run.bLocal) {
      dynamic.push({ index: i, pivot: run.pivot, local: run.bLocal.clone(), anchor: run.a.clone() });
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  const rig: Rigging = { mesh, dynamic, lastYaw: [] };
  mesh.userData.riggingRadius = radius;
  return rig;
}

/**
 * Re-seat every yard-attached rope from its pivot's CURRENT trim. Called after
 * the trim pivots have been rotated for the frame. A no-op when nothing moved.
 */
export function updateRigging(rig: Rigging | null): void {
  if (!rig || rig.dynamic.length === 0) return;
  const radius = rig.mesh.userData.riggingRadius as number;
  let moved = false;
  for (let k = 0; k < rig.dynamic.length; k++) {
    const d = rig.dynamic[k];
    const yaw = d.pivot.rotation.y;
    if (rig.lastYaw[k] === yaw) continue;
    rig.lastYaw[k] = yaw;
    moved = true;
    // The pivot is a direct child of the ship group carrying a yaw-only trim,
    // so its local point maps into group space by hand — cheaper and
    // allocation-free next to updateMatrixWorld + a matrix multiply, and it
    // does not depend on when three last refreshed the world matrices.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    _end.set(
      d.pivot.position.x + d.local.x * c + d.local.z * s,
      d.pivot.position.y + d.local.y,
      d.pivot.position.z - d.local.x * s + d.local.z * c,
    );
    writeInstance(rig.mesh, d.index, d.anchor, _end, radius);
  }
  if (moved) rig.mesh.instanceMatrix.needsUpdate = true;
}

/** Where a yard-attached rope's free end IS this frame, in ship-group space.
 *  Used by scripts/test-ship-rigging.mjs to grade the 60-degree brace. */
export function ropeEndInGroupSpace(d: { pivot: THREE.Group; local: THREE.Vector3 }, out: THREE.Vector3): THREE.Vector3 {
  const yaw = d.pivot.rotation.y;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(
    d.pivot.position.x + d.local.x * c + d.local.z * s,
    d.pivot.position.y + d.local.y,
    d.pivot.position.z - d.local.x * s + d.local.z * c,
  );
}
