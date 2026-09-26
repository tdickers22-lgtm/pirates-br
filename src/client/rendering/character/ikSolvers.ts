/**
 * STATION CONTACTS: two-bone IK post-solver (b3.3c, animations-02).
 *
 * A clip is authored against an imagined wheel. The live wheel is wherever the
 * ship put it, spinning, on a hull that heels, so a helmsman whose clip is even
 * a hand's width off grips air (and on the legacy rig the helm clip put both
 * hands 0.29 m BEHIND the hips). After the mixer step, the arms are solved onto
 * the live grip points the ShipRenderer tags on the station objects (wheel
 * pegs, capstan bar knobs, cannon breech handles, mast ladder rungs), and each
 * boot that the clip left inside the deck is lifted back onto it.
 *
 * Why analytic two-bone IK and not a pose tweak: it needs no knowledge of a
 * Blender rig's bone axes (the thing that inverted the arms in the first
 * place). It reads world positions, bends the elbow to the reach, points the
 * chain at the target with the elbow toward a pole (down, out and back, so an
 * elbow never folds forward through the chest), and writes local quaternions.
 *
 * The mixer only writes a track when its value CHANGES (three's PropertyMixer),
 * so an absolute write here would compound on a clip that holds still. The same
 * contract as the head look-at: the solver stashes the clip pose before it
 * writes, and `restoreContactClipPose` puts it back before the next mixer step.
 *
 * Grip sets live on the station object as `userData.ikGrips = { kind, points }`,
 * points in that object's LOCAL frame, so they follow the wheel's spin, the
 * cannon's yaw and pitch and the hull's heel for free.
 */
import * as THREE from 'three';

export type GripKind = 'helm' | 'capstan' | 'cannon' | 'ladder';
/** The palm sits this far past the wrist bone along the forearm: the grip
 *  point is what the PALM reaches, not the wrist joint. */
export const PALM = 0.07;
/** Most a pirate leans in from the waist to reach a grip the clip left short. */
export const LEAN_MAX = 0.5;
export type GripSet = { kind: GripKind; points: THREE.Vector3[] };
export const IK_GRIPS_KEY = 'ikGrips';

type Chain = { a: THREE.Bone; b: THREE.Bone; c: THREE.Bone; qa: THREE.Quaternion; qb: THREE.Quaternion };
type Side = 'l' | 'r';
type Chains = {
  arm: Record<Side, Chain | null>;
  leg: Record<Side, Chain | null>;
  /** The spine bone the reach lean bends (spine2 / spine_02), and its clip value. */
  lean: THREE.Bone | null;
  qLean: THREE.Quaternion;
  stashed: boolean;
  /** Contact blend weight, eased in and out so a pirate taking the wheel reaches for it. */
  w: number;
  kind: GripKind | null;
};

const CHAINS = new WeakMap<THREE.Object3D, Chains>();
const find = (root: THREE.Object3D, names: string[]): THREE.Bone | null => {
  for (const n of names) {
    const o = root.getObjectByName(n) as THREE.Bone | undefined;
    if (o?.isBone) return o;
  }
  return null;
};
const chain = (a: THREE.Bone | null, b: THREE.Bone | null, c: THREE.Bone | null): Chain | null =>
  a && b && c ? { a, b, c, qa: a.quaternion.clone(), qb: b.quaternion.clone() } : null;

/** The limb chains of a rig, by name: v2 (upperarm/lowerarm/hand,
 *  thigh/calf/foot) or the legacy rig (forearm, shin). Cached per rig root. */
export function contactChainsOf(root: THREE.Object3D): Chains {
  let c = CHAINS.get(root);
  if (c) return c;
  const arm = (s: Side) => chain(find(root, [`upperarm_${s}`]), find(root, [`lowerarm_${s}`, `forearm_${s}`]), find(root, [`hand_${s}`]));
  const leg = (s: Side) => chain(find(root, [`thigh_${s}`]), find(root, [`calf_${s}`, `shin_${s}`]), find(root, [`foot_${s}`]));
  const lean = find(root, ['spine_02', 'spine2', 'spine_01', 'spine1']);
  c = { arm: { l: arm('l'), r: arm('r') }, leg: { l: leg('l'), r: leg('r') }, lean, qLean: lean?.quaternion.clone() ?? new THREE.Quaternion(), stashed: false, w: 0, kind: null };
  CHAINS.set(root, c);
  return c;
}

const eachChain = (c: Chains, fn: (ch: Chain) => void) => {
  for (const ch of [c.arm.l, c.arm.r, c.leg.l, c.leg.r]) if (ch) fn(ch);
};

/** Put the clip pose back under the solver's writes. Call BEFORE the mixer step. */
export function restoreContactClipPose(root: THREE.Object3D): void {
  const c = CHAINS.get(root);
  if (!c || !c.stashed) return;
  eachChain(c, (ch) => { ch.a.quaternion.copy(ch.qa); ch.b.quaternion.copy(ch.qb); });
  c.lean?.quaternion.copy(c.qLean);
  c.stashed = false;
}

function stash(c: Chains): void {
  if (c.stashed) return;
  eachChain(c, (ch) => { ch.qa.copy(ch.a.quaternion); ch.qb.copy(ch.b.quaternion); });
  if (c.lean) c.qLean.copy(c.lean.quaternion);
  c.stashed = true;
}

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const Bd = new THREE.Vector3();
const Cd = new THREE.Vector3();
const DIR = new THREE.Vector3();
const N = new THREE.Vector3();
const U = new THREE.Vector3();
const V = new THREE.Vector3();
const DQ = new THREE.Quaternion();
const WQ = new THREE.Quaternion();
const PQ = new THREE.Quaternion();

/** Rotate `bone` by the WORLD-space delta `q`, then refresh it and its children. */
function rotateWorld(bone: THREE.Bone, q: THREE.Quaternion): void {
  bone.getWorldQuaternion(WQ);
  WQ.premultiply(q);
  if (bone.parent) { bone.parent.getWorldQuaternion(PQ); WQ.premultiply(PQ.invert()); }
  bone.quaternion.copy(WQ).normalize();
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK in world space. Bends `b` so the chain spans the reach
 * to `target`, keeps the bend in the plane toward `pole`, and blends the result
 * with the incoming pose by `weight`. Returns the end bone's distance to target.
 */
export function solveTwoBone(ch: Chain, target: THREE.Vector3, pole: THREE.Vector3, weight = 1, ext = 0): number {
  const { a, b } = ch;
  a.getWorldPosition(A); b.getWorldPosition(B); endPoint(ch, ext, C);
  const lenA = A.distanceTo(B); const lenB = B.distanceTo(C);
  DIR.subVectors(target, A);
  const dRaw = DIR.length();
  if (lenA < 1e-4 || lenB < 1e-4 || dRaw < 1e-4) return C.distanceTo(target);
  const d = THREE.MathUtils.clamp(dRaw, Math.abs(lenA - lenB) + 1e-3, lenA + lenB - 1e-3);
  DIR.divideScalar(dRaw);
  N.subVectors(pole, A); N.addScaledVector(DIR, -N.dot(DIR));
  if (N.lengthSq() < 1e-8) { N.subVectors(B, A); N.addScaledVector(DIR, -N.dot(DIR)); }
  if (N.lengthSq() < 1e-8) N.set(0, -1, 0);
  N.normalize();
  const cosA = THREE.MathUtils.clamp((lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  Bd.copy(A).addScaledVector(DIR, lenA * cosA).addScaledVector(N, lenA * sinA);
  Cd.copy(A).addScaledVector(DIR, d);
  const qa0 = weight < 1 ? a.quaternion.clone() : null;
  const qb0 = weight < 1 ? b.quaternion.clone() : null;
  U.subVectors(B, A).normalize(); V.subVectors(Bd, A).normalize();
  rotateWorld(a, DQ.setFromUnitVectors(U, V));
  b.getWorldPosition(B); endPoint(ch, ext, C);
  U.subVectors(C, B).normalize(); V.subVectors(Cd, B).normalize();
  rotateWorld(b, DQ.setFromUnitVectors(U, V));
  if (qa0 && qb0) {
    a.quaternion.slerpQuaternions(qa0, a.quaternion, weight);
    b.quaternion.slerpQuaternions(qb0, b.quaternion, weight);
    a.updateMatrixWorld(true);
  }
  endPoint(ch, ext, C);
  return C.distanceTo(target);
}

const EX = new THREE.Vector3();
/** The end bone's head, pushed `ext` further along the forearm (the palm). */
function endPoint(ch: Chain, ext: number, out: THREE.Vector3): THREE.Vector3 {
  ch.c.getWorldPosition(out);
  if (ext > 0) { ch.b.getWorldPosition(EX); EX.subVectors(out, EX).normalize(); out.addScaledVector(EX, ext); }
  return out;
}

/** Where each hand WANTS to be at a station, in the pirate's own frame
 *  (faces +Z, her left hand on +X): the nearest live grip to it is the one she takes. */
const IDEAL: Record<GripKind, { x: number; y: number; z: number }> = {
  helm: { x: 0.34, y: 1.3, z: 0.55 },
  capstan: { x: 0.22, y: 1.05, z: 0.5 },
  cannon: { x: 0.2, y: 0.95, z: 0.45 },
  ladder: { x: 0.2, y: 1.75, z: 0.25 },
};

/** The holder of the given kind nearest `near`, among the station objects the
 *  ShipRenderer tagged under `shipRoot`. The tag list is cached per ship. */
const HOLDERS = new WeakMap<THREE.Object3D, THREE.Object3D[]>();
export function nearestGripHolder(shipRoot: THREE.Object3D, kind: GripKind, near: THREE.Vector3): THREE.Object3D | null {
  let list = HOLDERS.get(shipRoot);
  if (!list) {
    list = [];
    shipRoot.traverse((o) => { if (o.userData?.[IK_GRIPS_KEY]) list!.push(o); });
    HOLDERS.set(shipRoot, list);
  }
  let best: THREE.Object3D | null = null; let bestD = Infinity;
  for (const o of list) {
    if ((o.userData[IK_GRIPS_KEY] as GripSet).kind !== kind) continue;
    o.getWorldPosition(A);
    const dd = A.distanceToSquared(near);
    if (dd < bestD) { bestD = dd; best = o; }
  }
  return best;
}

export type ContactResult = { l: number; r: number; targetL: THREE.Vector3 | null; targetR: THREE.Vector3 | null };
const TL = new THREE.Vector3();
const TR = new THREE.Vector3();
const IDEAL_W = new THREE.Vector3();
const G = new THREE.Vector3();
const POLE = new THREE.Vector3();

/** The two grip points (world) the hands take on `holder`, or null for a hand
 *  whose nearest grip is out of the arm's reach (the clip then keeps that hand). */
export function pickGrips(holder: THREE.Object3D, body: THREE.Object3D, arms: Record<Side, Chain | null>): { l: THREE.Vector3 | null; r: THREE.Vector3 | null } {
  const set = holder.userData[IK_GRIPS_KEY] as GripSet;
  const ideal = IDEAL[set.kind];
  holder.updateWorldMatrix(true, false);
  body.updateWorldMatrix(true, false);
  let taken = -1;
  const out: { l: THREE.Vector3 | null; r: THREE.Vector3 | null } = { l: null, r: null };
  for (const s of ['r', 'l'] as const) {
    const arm = arms[s];
    if (!arm) continue;
    IDEAL_W.set(s === 'l' ? ideal.x : -ideal.x, ideal.y, ideal.z);
    body.localToWorld(IDEAL_W);
    let bi = -1; let bd = Infinity;
    set.points.forEach((p, i) => {
      if (i === taken) return;
      G.copy(p).applyMatrix4(holder.matrixWorld);
      const dd = G.distanceToSquared(IDEAL_W);
      if (dd < bd) { bd = dd; bi = i; }
    });
    if (bi < 0) continue;
    const t = s === 'l' ? TL : TR;
    t.copy(set.points[bi]).applyMatrix4(holder.matrixWorld);
    arm.a.getWorldPosition(A); arm.b.getWorldPosition(B); arm.c.getWorldPosition(C);
    const reach = A.distanceTo(B) + B.distanceTo(C) + PALM;
    // the waist lean buys ~0.45 m x LEAN_MAX of extra reach
    if (A.distanceTo(t) > reach + 0.06 + 0.45 * LEAN_MAX) continue;
    taken = bi;
    out[s] = t;
  }
  return out;
}

/**
 * Hands onto the station's live grips (eased in over ~0.15 s), then boots out
 * of the deck. `holder` null = not at a station: the contact weight eases out
 * and only the foot guard runs. Returns the hand-to-grip residuals (m).
 */
export function applyStationContacts(
  rigRoot: THREE.Object3D,
  body: THREE.Object3D,
  holder: THREE.Object3D | null,
  dt: number,
  /** Aimed pistol: the right palm goes out on the eye line along this look pitch (rad, + up). */
  aimPitch: number | null = null,
): ContactResult {
  const c = contactChainsOf(rigRoot);
  const kind = holder ? (holder.userData[IK_GRIPS_KEY] as GripSet).kind : null;
  if (kind) c.kind = kind;
  c.w = THREE.MathUtils.clamp(c.w + (holder || aimPitch !== null ? 1 : -1) * dt * 7, 0, 1);
  stash(c);
  body.updateWorldMatrix(true, true);
  const res: ContactResult = { l: NaN, r: NaN, targetL: null, targetR: null };
  if (c.w > 0 && holder) {
    const grips = pickGrips(holder, body, c.arm);
    leanToReach(c, body, grips);
    for (const s of ['l', 'r'] as const) {
      const arm = c.arm[s]; const t = grips[s];
      if (!arm || !t) continue;
      // Elbow pole: down, out to her own side and a little back.
      arm.a.getWorldPosition(A);
      POLE.set(s === 'l' ? 0.5 : -0.5, -1, -0.35);
      body.localToWorld(POLE.add(body.worldToLocal(A.clone())));
      res[s] = solveTwoBone(arm, t, POLE, c.w, PALM);
      if (s === 'l') res.targetL = t.clone(); else res.targetR = t.clone();
    }
  } else if (c.w > 0 && aimPitch !== null && c.arm.r) {
    // Pistol out on the eye line: 0.42 m from the eye along the look, a hand's
    // width right of centre (her right is -X), elbow down and out.
    const head = rigRoot.getObjectByName('head');
    if (head) {
      head.getWorldPosition(A);
      const eye = body.worldToLocal(A.clone()); eye.y += 0.08;
      const t = new THREE.Vector3(-0.1, eye.y + Math.sin(aimPitch) * 0.42, eye.z + Math.cos(aimPitch) * 0.42);
      body.localToWorld(t);
      c.arm.r.a.getWorldPosition(A);
      POLE.copy(body.worldToLocal(A.clone())).add(new THREE.Vector3(-0.5, -1, -0.2));
      body.localToWorld(POLE);
      res.r = solveTwoBone(c.arm.r, t, POLE, c.w, PALM);
      res.targetR = t;
    }
  }
  plantFeetOnDeck(c, body);
  return res;
}

/** Bend forward from the waist just enough that the farther grip comes into
 *  the arm's reach (a helmsman leans into a wheel a step away). */
function leanToReach(c: Chains, body: THREE.Object3D, grips: { l: THREE.Vector3 | null; r: THREE.Vector3 | null }): void {
  if (!c.lean) return;
  let short = 0;
  for (const s of ['l', 'r'] as const) {
    const arm = c.arm[s]; const t = grips[s];
    if (!arm || !t) continue;
    arm.a.getWorldPosition(A); arm.b.getWorldPosition(B); arm.c.getWorldPosition(C);
    short = Math.max(short, A.distanceTo(t) - (A.distanceTo(B) + B.distanceTo(C) + PALM - 0.02));
  }
  if (short <= 0) return;
  c.lean.getWorldPosition(B);
  c.arm.r?.a.getWorldPosition(A) ?? c.arm.l?.a.getWorldPosition(A);
  const lever = Math.max(0.25, A.distanceTo(B));
  const angle = Math.min(LEAN_MAX, (short / lever) * c.w);
  // + about her own left (+X) tips her up-axis toward +Z: forward
  U.set(1, 0, 0).transformDirection(body.matrixWorld);
  rotateWorld(c.lean, DQ.setFromAxisAngle(U, angle));
}

/** FOOT IK ON THE DECK PLANE: a boot the clip (or the pelvis roll) pushed into
 *  the planking is lifted back onto it by bending that knee, knee forward. The
 *  plane is the body's own y = 0 (the sole solve already put the lower boot there). */
function plantFeetOnDeck(c: Chains, body: THREE.Object3D): void {
  for (const s of ['l', 'r'] as const) {
    const leg = c.leg[s];
    if (!leg) continue;
    leg.c.getWorldPosition(C);
    const local = body.worldToLocal(C.clone());
    const sole = local.y - 0.045;
    if (sole > -0.005 || sole < -0.25) continue;
    local.y -= sole;
    body.localToWorld(local);
    leg.a.getWorldPosition(A);
    const pole = body.worldToLocal(A.clone()).add(new THREE.Vector3(0, 0, 1));
    body.localToWorld(pole);
    solveTwoBone(leg, local, pole, 1);
  }
}
