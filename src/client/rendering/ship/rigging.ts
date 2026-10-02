import * as THREE from 'three';
import { acquireSharedGeometry } from './geometry.js';
import { hullSurfacePointAt, type HullProfile } from '../../../shared/hull.js';
import { finishCanvasTexture } from './textures.js';

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
 *
 * RIGGING V2 (b4.2h, ships-09). The rope PLAN is per class and per mast
 * (planRopes below): shrouds from the mast hounds down to deadeyes on the
 * channels, with a lanyard between each deadeye pair and ratlines between
 * adjacent shrouds; backstays aft of the shrouds on the same channel; a
 * mainstay and topmast stay from each mast forward to the next; lifts from
 * each yardarm up to a block on the mast; braces from each yardarm to a block
 * seized on the aft backstay and down to a pin rail; sheets from the course
 * yardarm to a pin rail forward; halyards from a block on the mast to the fife
 * rail at its foot. Slack lines (braces, sheets) hang a 2 % parabolic sag
 * (the catenary at this sag is the parabola to < 0.1 % of the chord) in six
 * segments and re-seat whole when the yard swings; taut lines stay straight.
 * The fittings (deadeyes, blocks, pins, channels, pin and fife rails) are
 * instances of the same unit cylinder in the rope draw, so the whole rig is
 * still three instanced draws: rope (fittings + standing + running, in that
 * order, so `count` drops the running lines), ratline, and one alpha-tested
 * card per mast. LOD families (applyRiggingLod): ratlines go past 60 m, the
 * running lines past 150 m, and past 250 m (ship LOD3) both rope draws give
 * way to the cards.
 */

export type RopeFamily = 'standing' | 'running' | 'ratline';
export type RigAnchorKind = 'spar' | 'deadeye' | 'block' | 'pin';

export interface RopeRun {
  /** Fixed end, in ship-group local space. */
  a: THREE.Vector3;
  /** Free end, in ship-group local space at rest. */
  b: THREE.Vector3;
  /** If set, `b` is carried by this yard pivot and `bLocal` is its seat. */
  pivot?: THREE.Group;
  /** Where on the pivot the rope is made fast, in PIVOT-local space. */
  bLocal?: THREE.Vector3;
  /** LOD family; default standing (running when made fast to a yard). */
  family?: RopeFamily;
  /** Slack: max offset from the chord as a fraction of its length (0 = taut). */
  sag?: number;
  /** What each end is made fast to (graded by test-ship-rigging). */
  aKind?: RigAnchorKind;
  bKind?: RigAnchorKind;
  label?: string;
}

/** A fitting drawn as a scaled instance of the unit rope cylinder. */
export interface RigFitting {
  kind: 'deadeye' | 'block' | 'pin' | 'channel' | 'rail' | 'stanchion';
  /** Centre, ship-group space. */
  at: THREE.Vector3;
  /** Unit cylinder axis (+Y) maps to this direction. */
  axis: THREE.Vector3;
  /** Radius across the axis (local x), length along it, second radius (local z). */
  rx: number;
  len: number;
  rz?: number;
}

/** One run's place in the instance buffer (read by the gate). */
export interface RopeRunMeta {
  first: number;
  segs: number;
  family: RopeFamily;
  sag: number;
  aKind?: RigAnchorKind;
  bKind?: RigAnchorKind;
  label: string;
}

interface DynamicRope {
  /** The LAST segment: its b end is the one on the yard. */
  index: number;
  first: number;
  segs: number;
  sag: number;
  pivot: THREE.Group;
  local: THREE.Vector3;
  anchor: THREE.Vector3;
}

export interface Rigging {
  mesh: THREE.InstancedMesh;
  dynamic: DynamicRope[];
  /** Last trim the dynamic instances were written for, per pivot. */
  lastYaw: number[];
  runs: RopeRunMeta[];
  hardware: RigFitting[];
  /** Instance count with the running family dropped (fittings + standing). */
  standingEnd: number;
}

/** The three rigging draws of one hull. */
export interface RiggingSet {
  rope: Rigging;
  ratline: Rigging;
  far: THREE.InstancedMesh;
}

/** LOD family edges (m), b4.2h. */
export const RIG_RATLINE_FAR = 60;
export const RIG_RUNNING_FAR = 150;

// Module-level scratch: the per-frame path must not allocate.
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _chord = new THREE.Vector3();
const _drop = new THREE.Vector3();

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
  // sides 1 = the phone ribbon: one 2-tri quad (x +-1, y +-0.5, the same
  // frame as the cylinder) drawn DoubleSide. A 2-sided cylinder is exactly
  // this quad twice, back to back, at 4 tris (b4.2h phone own-hull cap).
  if (sides <= 1) return acquireSharedGeometry('rope-ribbon', () => new THREE.PlaneGeometry(2, 1, 1, 1))!;
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

/** Point at t on a run hanging `sag` x chord below its chord (perpendicular to
 *  the chord in the plane of gravity; sideways for a near-vertical run). */
function chainPoint(a: THREE.Vector3, b: THREE.Vector3, sag: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  _chord.subVectors(b, a);
  const len = _chord.length();
  out.copy(a).addScaledVector(_chord, t);
  if (sag <= 0 || len < 1e-6) return out;
  const uy = _chord.y / len;
  // down - (down . u) u, with down = (0, -1, 0)
  _drop.set(_chord.x / len * uy, -1 + uy * uy, _chord.z / len * uy);
  if (_drop.lengthSq() < 0.0025) _drop.set(_chord.z, 0, -_chord.x);
  _drop.normalize();
  return out.addScaledVector(_drop, 4 * sag * len * t * (1 - t));
}

function writeChain(mesh: THREE.InstancedMesh, first: number, segs: number, a: THREE.Vector3, b: THREE.Vector3, sag: number, radius: number) {
  chainPoint(a, b, sag, 0, _p0);
  for (let i = 0; i < segs; i++) {
    chainPoint(a, b, sag, (i + 1) / segs, _p1);
    writeInstance(mesh, first + i, _p0, _p1, radius);
    _p0.copy(_p1);
  }
}

function writeFitting(mesh: THREE.InstancedMesh, index: number, f: RigFitting) {
  _quat.setFromUnitVectors(_up, f.axis);
  _scale.set(f.rx, f.len, f.rz ?? f.rx);
  _mat.compose(f.at, _quat, _scale);
  mesh.setMatrixAt(index, _mat);
}

/** Segments a slack run is drawn in (taut runs are one). */
export const SLACK_SEGMENTS = 6;
/** Phones draw slack runs in 3 segments (the own-hull tri cap, b4.2h). */
export const SLACK_SEGMENTS_PHONE = 3;

/**
 * Build one instanced rope family.
 *
 * @param sides radial segments — 3 on the low tier, 5 elsewhere, 1 = the
 *   phone ribbon (2 tris, needs a DoubleSide material).
 * @param slackSegments segments per slack run (6; 3 on phones).
 */
export function buildRigging(
  runs: RopeRun[],
  material: THREE.Material,
  radius: number,
  sides: number,
  hardware: RigFitting[] = [],
  slackSegments: number = SLACK_SEGMENTS,
): Rigging | null {
  if (runs.length === 0) return null;
  // Order: fittings, standing, running (count = standingEnd drops the running).
  const famOf = (r: RopeRun): RopeFamily => r.family ?? (r.pivot ? 'running' : 'standing');
  const ordered = [...runs.filter((r) => famOf(r) !== 'running'), ...runs.filter((r) => famOf(r) === 'running')];
  const segsOf = (r: RopeRun) => ((r.sag ?? 0) > 0 ? slackSegments : 1);
  const total = hardware.length + ordered.reduce((n, r) => n + segsOf(r), 0);
  const mesh = new THREE.InstancedMesh(ropeGeometry(sides), material, total);
  mesh.castShadow = true;
  mesh.name = 'ship-rigging';
  for (let i = 0; i < hardware.length; i++) writeFitting(mesh, i, hardware[i]);
  const dynamic: DynamicRope[] = [];
  const meta: RopeRunMeta[] = [];
  let at = hardware.length;
  let standingEnd = at;
  for (const run of ordered) {
    const segs = segsOf(run);
    const sag = segs > 1 ? run.sag! : 0;
    writeChain(mesh, at, segs, run.a, run.b, sag, radius);
    if (run.pivot && run.bLocal) {
      dynamic.push({ index: at + segs - 1, first: at, segs, sag, pivot: run.pivot, local: run.bLocal.clone(), anchor: run.a.clone() });
    }
    const family = famOf(run);
    meta.push({ first: at, segs, family, sag, aKind: run.aKind, bKind: run.bKind, label: run.label ?? family });
    at += segs;
    if (family !== 'running') standingEnd = at;
  }
  mesh.instanceMatrix.needsUpdate = true;
  const rig: Rigging = { mesh, dynamic, lastYaw: [], runs: meta, hardware, standingEnd };
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
    writeChain(rig.mesh, d.first, d.segs, d.anchor, _end, d.sag, radius);
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

// ─── RIGGING V2: the per-class rope plan (b4.2h, ships-09) ───────────────────

export interface RigPlanYard {
  pivot: THREE.Group;
  /** Yardarm seat, pivot-local x (the rope is made fast here). */
  halfSpan: number;
  headY: number;
  kind: 'course' | 'topsail';
}

export interface RigPlanMast {
  z: number;
  height: number;
  /** The mast cylinder is mastR*0.8 at the truck, mastR*1.4 at the deck. */
  mastR: number;
  /** Crow's nest floor (standing Y - 0.12) on this mast, or null. */
  nestY: number | null;
  yards: RigPlanYard[];
}

export interface RopePlanInput {
  profile: HullProfile;
  H: number;
  L: number;
  type: string;
  /** Ratline pitch (m): 0.38 (a real ratline is ~15 in), wider on the low tier. */
  ratlineStep: number;
  masts: RigPlanMast[];
  /** The yard the gameplay brace stations already brace (no second brace). */
  bracedPivot?: THREE.Group | null;
}

export interface RigFarCard { zMin: number; zMax: number; yMin: number; yMax: number }

export interface RopePlan {
  ropes: RopeRun[];
  ratlines: RopeRun[];
  hardware: RigFitting[];
  cards: RigFarCard[];
}

const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);

/** Sag of every slack line: 2 % of its chord (gate band 1-3 %). */
export const RIG_SLACK_SAG = 0.02;

export function planRopes(inp: RopePlanInput): RopePlan {
  const { profile, H, L, masts } = inp;
  const ropes: RopeRun[] = [];
  const ratlines: RopeRun[] = [];
  const hardware: RigFitting[] = [];
  const cards: RigFarCard[] = [];
  const big = inp.type === 'galleon' ? 1.2 : inp.type === 'brigantine' ? 1.1 : 1;
  const rD = 0.085 * big;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const fit = (kind: RigFitting['kind'], at: THREE.Vector3, axis: THREE.Vector3, rx: number, len: number, rz?: number) => {
    hardware.push({ kind, at, axis, rx, len, rz });
    return at;
  };
  const halfAt = (z: number) => Math.abs(hullSurfacePointAt(profile, z, H - 0.05).x);
  const zLimit = L * 0.42;

  for (let m = 0; m < masts.length; m++) {
    const M = masts[m];
    const truck = H + M.height;
    // Rope end on the mast: 90 % of its radius at that height (inside the spar).
    const rOn = (mast: RigPlanMast, y: number) => mast.mastR * (1.4 - 0.6 * THREE.MathUtils.clamp((y - H) / mast.height, 0, 1)) * 0.9;
    const yardYs = M.yards.map((y) => y.headY);
    const lowYard = yardYs.length ? Math.min(...yardYs) : H + M.height * 0.6;
    const hounds = lowYard - 0.3;
    const capY = Math.min(truck - 0.25, M.nestY !== null ? M.nestY - 0.3 : Infinity);
    const backTop = M.nestY !== null ? M.nestY - 0.45 : truck - 0.35;
    const nShroud = inp.type === 'galleon' ? (m === 2 ? 4 : 5) : inp.type === 'brigantine' ? 4 : 3;
    const nBack = 2;
    const dz = THREE.MathUtils.clamp(L * 0.025, 0.42, 0.8);
    const zFore = M.z + L * 0.02;
    const zs: number[] = [];
    for (let k = 0; k < nShroud + nBack; k++) zs.push(zFore - k * dz - (k >= nShroud ? dz * 0.5 : 0));
    const yc = H - 0.02;
    const yLow = yc + 0.1;
    const yUp = yLow + 0.38;
    let xc = 0;
    for (const z of zs) xc = Math.max(xc, halfAt(z));
    const zAft = zs[zs.length - 1];
    cards.push({ zMin: zAft - 0.2, zMax: M.z + 0.3, yMin: yUp, yMax: Math.max(backTop, hounds) });

    for (const sx of [-1, 1] as const) {
      // Channel: a plank standing out from the sheer, the deadeyes on its edge.
      fit('channel', v(sx * (xc + 0.12), yc, (zs[0] + zAft) * 0.5), AX_Z, 0.18, zs[0] - zAft + 0.5, 0.035);
      const dx = sx * (xc + 0.22);
      const shrouds: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
      for (let k = 0; k < zs.length; k++) {
        const z = zs[k];
        fit('deadeye', v(dx, yLow, z), AX_X, rD, 0.07);
        fit('deadeye', v(dx, yUp, z), AX_X, rD, 0.07);
        ropes.push({ a: v(dx, yLow + rD * 0.8, z), b: v(dx, yUp - rD * 0.8, z), family: 'standing', aKind: 'deadeye', bKind: 'deadeye', label: 'lanyard' });
        const back = k >= nShroud;
        const topY = back ? backTop : hounds;
        const run = { a: v(dx, yUp + rD * 0.8, z), b: v(sx * rOn(M, topY), topY, M.z) };
        ropes.push({ ...run, family: 'standing', aKind: 'deadeye', bKind: 'spar', label: back ? 'backstay' : 'shroud' });
        if (!back) shrouds.push(run);
      }
      // Ratlines between adjacent shrouds, from just above the deadeyes to a
      // man's reach under the hounds.
      for (let k = 0; k + 1 < shrouds.length; k++) {
        const s0 = shrouds[k], s1 = shrouds[k + 1];
        for (let y = yUp + 0.5; y <= hounds - 1.2; y += inp.ratlineStep) {
          const at = (s: { a: THREE.Vector3; b: THREE.Vector3 }) => s.a.clone().lerp(s.b, (y - s.a.y) / (s.b.y - s.a.y));
          ratlines.push({ a: at(s0), b: at(s1), family: 'ratline', label: 'ratline' });
        }
      }

      // Pin rails inboard of the bulwark: aft (braces) and forward (sheets).
      const backA = v(dx, yUp + rD * 0.8, zAft);
      const backB = v(sx * rOn(M, backTop), backTop, M.z);
      const zAftRail = Math.max(-zLimit, zAft - 0.6);
      const zForeRail = Math.min(zLimit, zFore + 0.7);
      const pinRail = (z: number, n: number) => {
        const x = sx * (halfAt(z) - 0.22);
        fit('rail', v(x, H + 0.72, z + 0.15 * (n - 1)), AX_Z, 0.07, 0.3 * n + 0.3, 0.03);
        const pins: THREE.Vector3[] = [];
        for (let j = 0; j < n; j++) {
          const pz = z + 0.3 * j;
          fit('pin', v(x, H + 0.75, pz), AX_Y, 0.022, 0.3);
          pins.push(v(x, H + 0.86, pz));
        }
        return pins;
      };
      const braced = M.yards.filter((y) => y.pivot !== inp.bracedPivot);
      const bracePins = braced.length ? pinRail(zAftRail, braced.length) : [];
      const courses = M.yards.filter((y) => y.kind === 'course');
      const sheetPins = courses.length ? pinRail(zForeRail, courses.length) : [];

      for (let j = 0; j < M.yards.length; j++) {
        const yd = M.yards[j];
        const arm = v(sx * yd.halfSpan, yd.headY, M.z);
        const seat = v(sx * yd.halfSpan, 0, 0);
        // Lift: yardarm up to a block on the mast (none where the top sits on it).
        const yl = Math.min(yd.headY + 0.9, capY);
        if (yl >= yd.headY + 0.25) {
          const blk = fit('block', v(sx * (rOn(M, yl) / 0.9 + 0.055), yl, M.z), AX_Z, 0.055, 0.11);
          ropes.push({ a: v(blk.x, yl - 0.05, M.z), b: arm, pivot: yd.pivot, bLocal: seat, family: 'running', aKind: 'block', bKind: 'spar', label: 'lift' });
        }
        // Brace: yardarm aft to a block seized on the aft backstay, then down
        // to its pin. Slack.
        const bi = braced.indexOf(yd);
        if (bi >= 0) {
          const q = fit('block', backA.clone().lerp(backB, 0.3 + 0.12 * bi), AX_Z, 0.06, 0.12);
          ropes.push({ a: q.clone(), b: arm, pivot: yd.pivot, bLocal: seat, family: 'running', sag: RIG_SLACK_SAG, aKind: 'block', bKind: 'spar', label: 'brace' });
          ropes.push({ a: bracePins[bi], b: q.clone(), family: 'running', aKind: 'pin', bKind: 'block', label: 'brace-fall' });
        }
        // Sheet: course yardarm down to the forward pin rail. Slack.
        const ci = courses.indexOf(yd);
        if (ci >= 0) {
          ropes.push({ a: sheetPins[ci], b: arm, pivot: yd.pivot, bLocal: seat.clone(), family: 'running', sag: RIG_SLACK_SAG, aKind: 'pin', bKind: 'spar', label: 'sheet' });
        }
      }
    }

    // Halyards: a block on the fore side of the mast above each yard, down to
    // the fife rail at the mast's foot.
    const fifeZ = M.z + 0.55;
    fit('rail', v(0, H + 0.72, fifeZ), AX_X, 0.06, 1.1, 0.03);
    for (const sx of [-1, 1]) fit('stanchion', v(sx * 0.5, H + 0.36, fifeZ), AX_Y, 0.035, 0.72);
    let hj = 0;
    for (const yd of M.yards) {
      const yh = Math.min(yd.headY + 0.55, capY);
      if (yh < yd.headY + 0.2) continue;
      const bz = M.z + rOn(M, yh) / 0.9 + 0.055;
      fit('block', v(0, yh, bz), AX_X, 0.055, 0.11);
      const px = -0.35 + 0.23 * hj++;
      fit('pin', v(px, H + 0.75, fifeZ), AX_Y, 0.022, 0.3);
      ropes.push({ a: v(px, H + 0.86, fifeZ), b: v(0, yh - 0.05, bz), family: 'running', aKind: 'pin', bKind: 'block', label: 'halyard' });
    }

    // Stays forward to the next mast: mainstay from the hounds to the deck
    // partners of the mast ahead, topmast stay from the truck to its top yard.
    if (m >= 1) {
      const P = masts[m - 1];
      const yA = hounds + 0.15;
      ropes.push({ a: v(0, yA, M.z + rOn(M, yA)), b: v(0, H + 1.6, P.z - rOn(P, H + 1.6)), family: 'standing', aKind: 'spar', bKind: 'spar', label: 'stay' });
      if (M.yards.length > 1) {
        const yT = truck - 0.45;
        const pLow = Math.min(...P.yards.map((y) => y.headY));
        ropes.push({ a: v(0, yT, M.z + rOn(M, yT)), b: v(0, pLow + 0.5, P.z - rOn(P, pLow + 0.5)), family: 'standing', aKind: 'spar', bKind: 'spar', label: 'topmast-stay' });
      }
    }
  }
  return { ropes, ratlines, hardware, cards };
}

/** One alpha-tested card per mast (> 250 m): the shroud fan and backstays as
 *  a cut-out, no blending (no sort, no blended fill layer). */
export function buildRigFarCards(cards: RigFarCard[], color: number): THREE.InstancedMesh {
  const geo = acquireSharedGeometry('rig-far-card', () => new THREE.PlaneGeometry(1, 1))!;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    g.clearRect(0, 0, 64, 128);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    // u = 0 is the fore edge (local -x maps to +z after the quarter turn);
    // the mast stands near it, the fan spreads aft to the channel.
    for (let k = 0; k < 7; k++) {
      g.beginPath();
      g.moveTo(12, 3);
      g.lineTo(6 + k * 9.5, 125);
      g.stroke();
    }
  }
  const tex = finishCanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshStandardMaterial({ color, map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
  mat.name = 'ship-rigging-far-card';
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cards.length));
  mesh.name = 'ship-rigging-far';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  _quat.setFromAxisAngle(_up, Math.PI * 0.5);
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    _mid.set(0, (c.yMin + c.yMax) * 0.5, (c.zMin + c.zMax) * 0.5);
    _scale.set(c.zMax - c.zMin, c.yMax - c.yMin, 1);
    _mat.compose(_mid, _quat, _scale);
    mesh.setMatrixAt(i, _mat);
  }
  mesh.count = cards.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.visible = false;
  return mesh;
}

/** LOD families: ratlines < 60 m, running rigging < 150 m, the cards at ship
 *  LOD3 (> 250 m). `distance` is 0 for the local crew's own hull. */
export function applyRiggingLod(set: RiggingSet | null, distance: number, farLevel: boolean): void {
  if (!set) return;
  set.far.visible = farLevel;
  set.rope.mesh.visible = !farLevel;
  set.ratline.mesh.visible = !farLevel && distance < RIG_RATLINE_FAR;
  set.rope.mesh.count = distance < RIG_RUNNING_FAR ? set.rope.mesh.instanceMatrix.count : set.rope.standingEnd;
}
