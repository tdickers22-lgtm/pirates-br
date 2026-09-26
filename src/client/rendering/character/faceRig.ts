/**
 * FACE RIG (b3.2g, characters-04): eyes that look at something, lids that blink,
 * a jaw that works on a swing or a hit.
 *
 * Two halves:
 *  - PURE maths (no THREE): gaze target choice, clamped eye yaw/pitch with an
 *    80 ms lead over the head, the seeded blink scheduler and the jaw envelope.
 *    scripts/test-face-rig.mjs grades these directly.
 *  - A thin THREE applier: finds eye_l/eye_r, lid_upper_l/lid_upper_r and an
 *    optional jaw bone on a cloned skinned scene and writes them ABSOLUTELY from
 *    their bind pose every frame (the clips carry no channels for them, so there
 *    is no clip value to stash). A rig without eye or lid bones (the v1
 *    pirate_base.glb) gets `null` and the whole thing is a no-op.
 *
 * Conventions (model space of the pirate, the same the head look-at uses):
 * forward +Z, up +Y, yaw = atan2(x, z) (positive toward +X, like rotation.y),
 * pitch positive = UP. Lids close by rotating about their local +X by the
 * joint's extras.closeDeg (glTF userData.closeDeg; male 50.5, female 47.2,
 * stout 40.5 in pirate_base.report.json), positive = closed.
 */
import * as THREE from 'three';

export const FACE = {
  /** Eye yaw clamp (rad), either side of the head's facing. */
  EYE_YAW_MAX: 0.5,
  /** Eye pitch clamp (rad), up and down. */
  EYE_PITCH_MAX: 0.35,
  /** Eyes lead the head: they aim where the head's own turn will be in 80 ms. */
  EYE_LEAD_S: 0.08,
  /** Remote pirates look at the nearest other pirate inside this range. */
  LOOK_RANGE_M: 8,
  BLINK_MIN_S: 2,
  BLINK_MAX_S: 6,
  /** One blink, lid down and back up. */
  BLINK_DUR_S: 0.12,
  /** Share of blinks that come as a pair. */
  DOUBLE_P: 0.1,
  /** Start-to-start gap of the second blink in a double. */
  DOUBLE_GAP_S: 0.2,
  /** Fallback lid travel when a joint carries no closeDeg extra. */
  DEFAULT_CLOSE_DEG: 45,
  /** Jaw: open angle (rad) and envelope (attack, hold, release in s). */
  JAW_OPEN_RAD: 0.2,
  JAW_ATTACK_S: 0.06,
  JAW_HOLD_S: 0.1,
  JAW_RELEASE_S: 0.2,
  /** Faces are not readable past this; beyond it the lids are left open. */
  FACE_LOD_M: 15,
} as const;

export type Vec3 = { x: number; y: number; z: number };

// ── pure: gaze ─────────────────────────────────────────────────────────────

/** Direction (model space, from the eyes) → yaw/pitch, pitch + = up. */
export function dirToYawPitch(d: Vec3): { yaw: number; pitch: number } {
  const horiz = Math.hypot(d.x, d.z);
  return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, horiz) };
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Eye angles relative to the head.
 * @param want      gaze the pirate wants (model space yaw/pitch).
 * @param head      where the head currently points (model space yaw/pitch).
 * @param headRate  the head's angular velocity (rad/s), so the eyes get there
 *                  EYE_LEAD_S before the head does.
 */
export function eyeAngles(
  want: { yaw: number; pitch: number },
  head: { yaw: number; pitch: number },
  headRate: { yaw: number; pitch: number } = { yaw: 0, pitch: 0 },
): { yaw: number; pitch: number } {
  const yaw = wrap(want.yaw - head.yaw) + headRate.yaw * FACE.EYE_LEAD_S;
  const pitch = want.pitch - head.pitch + headRate.pitch * FACE.EYE_LEAD_S;
  return {
    yaw: clamp(yaw, -FACE.EYE_YAW_MAX, FACE.EYE_YAW_MAX),
    pitch: clamp(pitch, -FACE.EYE_PITCH_MAX, FACE.EYE_PITCH_MAX),
  };
}

/** Nearest other pirate inside LOOK_RANGE_M (world positions), or null. */
export function nearestWithin(self: Vec3, others: readonly Vec3[], range: number = FACE.LOOK_RANGE_M): Vec3 | null {
  let best: Vec3 | null = null;
  let bestD2 = range * range;
  for (const o of others) {
    const dx = o.x - self.x, dy = o.y - self.y, dz = o.z - self.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 1e-6 && d2 <= bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}

// ── pure: blink ────────────────────────────────────────────────────────────

/** mulberry32: a per-pirate stream so two pirates never blink in lockstep. */
export function faceRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BlinkState = {
  rng: () => number;
  /** Seconds until the next blink starts. */
  wait: number;
  /** Time into the running blink, or -1 when none runs. */
  t: number;
  /** A second blink is owed after this one. */
  doubleOwed: boolean;
  /** The running/next blink is the second of a pair. */
  second: boolean;
};

export function makeBlink(seed: number): BlinkState {
  const rng = faceRng(seed);
  return { rng, wait: FACE.BLINK_MIN_S + rng() * (FACE.BLINK_MAX_S - FACE.BLINK_MIN_S), t: -1, doubleOwed: false, second: false };
}

/** Lid closure over one blink: down in 40 ms, SHUT for 30 ms, up in 50 ms.
 *  The plateau is longer than a 60 fps frame, so every blink shows at least
 *  one fully shut frame (a pure triangle peaked between samples at 0.86). */
export function blinkShape(t: number): number {
  if (t < 0 || t >= FACE.BLINK_DUR_S) return 0;
  const down = FACE.BLINK_DUR_S * (1 / 3), shut = FACE.BLINK_DUR_S * 0.25;
  if (t < down) return t / down;
  if (t < down + shut) return 1;
  return 1 - (t - down - shut) / (FACE.BLINK_DUR_S - down - shut);
}

/** Advance the scheduler; returns lid closure 0..1. Dead eyes are shut. */
export function stepBlink(s: BlinkState, dt: number, dead = false): number {
  if (dead) return 1;
  if (s.t < 0) {
    s.wait -= dt;
    if (s.wait > 0) return 0;
    // Carry the overshoot in, so a long frame lands mid-blink instead of late.
    s.t = Math.min(-s.wait, FACE.BLINK_DUR_S * 0.99);
    // A double is decided once, at the FIRST blink of a pair (never a triple).
    if (!s.second) s.doubleOwed = s.rng() < FACE.DOUBLE_P;
    return blinkShape(s.t);
  }
  s.t += dt;
  if (s.t < FACE.BLINK_DUR_S) return blinkShape(s.t);
  s.t = -1;
  if (s.doubleOwed) {
    s.doubleOwed = false;
    s.second = true;
    s.wait = FACE.DOUBLE_GAP_S - FACE.BLINK_DUR_S;
  } else {
    s.second = false;
    s.wait = FACE.BLINK_MIN_S + s.rng() * (FACE.BLINK_MAX_S - FACE.BLINK_MIN_S);
  }
  return 0;
}

// ── pure: jaw ──────────────────────────────────────────────────────────────

/** Jaw opening (rad) `age` seconds after a swing/hit edge (age < 0 = none). */
export function jawOpen(age: number): number {
  if (age < 0) return 0;
  const { JAW_OPEN_RAD: o, JAW_ATTACK_S: a, JAW_HOLD_S: h, JAW_RELEASE_S: r } = FACE;
  if (age < a) return o * (age / a);
  if (age < a + h) return o;
  if (age < a + h + r) return o * (1 - (age - a - h) / r);
  return 0;
}

// ── THREE applier ──────────────────────────────────────────────────────────

type EyeJoint = { bone: THREE.Bone; rest: THREE.Quaternion; parentRest: THREE.Quaternion; parentRestInv: THREE.Quaternion };
type LidJoint = { bone: THREE.Bone; rest: THREE.Quaternion; closeRad: number };

export type FaceRig = {
  eyes: EyeJoint[];
  lids: LidJoint[];
  jaw: { bone: THREE.Bone; rest: THREE.Quaternion } | null;
  blink: BlinkState;
  /** Seconds since the last swing/hit edge, -1 = none. */
  jawAge: number;
  /** Previous head yaw/pitch (model space) for the lead term. */
  prevHead: { yaw: number; pitch: number } | null;
  /** Last written values, for probes and tests. */
  last: { eyeYaw: number; eyePitch: number; closure: number; jaw: number };
};

const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const E = new THREE.Euler(0, 0, 0, 'YXZ');
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Model-space (root-relative) orientation of a bone in the current pose. */
function rootSpaceQuat(root: THREE.Object3D, bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  out.identity();
  const chain: THREE.Object3D[] = [];
  for (let o: THREE.Object3D | null = bone; o && o !== root; o = o.parent) chain.push(o);
  for (let i = chain.length - 1; i >= 0; i--) out.multiply(chain[i].quaternion);
  return out;
}

/**
 * Find the face joints on a freshly cloned (bind pose) scene. Returns null when
 * the rig has no eye AND no lid bones, so the v1 rig costs nothing.
 */
export function attachFaceRig(root: THREE.Object3D, seed: number): FaceRig | null {
  const find = (n: string) => (root.getObjectByName(n) as THREE.Bone | undefined) ?? null;
  const eyes: EyeJoint[] = [];
  for (const n of ['eye_l', 'eye_r']) {
    const bone = find(n);
    if (!bone || !bone.parent) continue;
    const parentRest = rootSpaceQuat(root, bone.parent, new THREE.Quaternion());
    eyes.push({ bone, rest: bone.quaternion.clone(), parentRest, parentRestInv: parentRest.clone().invert() });
  }
  const lids: LidJoint[] = [];
  for (const n of ['lid_upper_l', 'lid_upper_r']) {
    const bone = find(n);
    if (!bone) continue;
    const deg = Number((bone.userData as { closeDeg?: unknown }).closeDeg);
    lids.push({ bone, rest: bone.quaternion.clone(), closeRad: THREE.MathUtils.degToRad(Number.isFinite(deg) && deg > 0 ? deg : FACE.DEFAULT_CLOSE_DEG) });
  }
  if (!eyes.length && !lids.length) return null;
  const jawBone = find('jaw') ?? find('jaw_01');
  return {
    eyes, lids,
    jaw: jawBone ? { bone: jawBone, rest: jawBone.quaternion.clone() } : null,
    blink: makeBlink(seed),
    jawAge: -1,
    prevHead: null,
    last: { eyeYaw: 0, eyePitch: 0, closure: 0, jaw: 0 },
  };
}

/** A swing or a hit: the jaw works. */
export function triggerJaw(face: FaceRig): void {
  face.jawAge = 0;
}

/**
 * One frame of the face.
 * @param want  gaze direction wanted (model space yaw/pitch), from the aim or a target.
 * @param head  where the head points after its own look-at (model space).
 */
export function updateFaceRig(
  face: FaceRig,
  dt: number,
  want: { yaw: number; pitch: number },
  head: { yaw: number; pitch: number },
  dead: boolean,
  near = true,
): void {
  const rate = face.prevHead && dt > 1e-4
    ? { yaw: wrap(head.yaw - face.prevHead.yaw) / dt, pitch: (head.pitch - face.prevHead.pitch) / dt }
    : { yaw: 0, pitch: 0 };
  face.prevHead = { yaw: head.yaw, pitch: head.pitch };
  const eye = dead ? { yaw: 0, pitch: 0 } : eyeAngles(want, head, rate);
  const closure = near || dead ? stepBlink(face.blink, dt, dead) : 0;
  if (face.jawAge >= 0) {
    face.jawAge += dt;
    if (face.jawAge > FACE.JAW_ATTACK_S + FACE.JAW_HOLD_S + FACE.JAW_RELEASE_S) face.jawAge = -1;
  }
  const jaw = dead ? 0 : jawOpen(face.jawAge);
  applyFace(face, eye.yaw, eye.pitch, closure, jaw);
}

/** Write the joints absolutely from their bind pose. */
export function applyFace(face: FaceRig, eyeYaw: number, eyePitch: number, closure: number, jaw: number): void {
  // R in head-aligned model axes: yaw about +Y, then pitch (+ = up = -X).
  E.set(-eyePitch, eyeYaw, 0, 'YXZ');
  Q.setFromEuler(E);
  for (const j of face.eyes) {
    // local' = P^-1 * R * P * rest: the rotation happens about axes that move with the head.
    Q2.copy(j.parentRestInv).multiply(Q).multiply(j.parentRest).multiply(j.rest);
    j.bone.quaternion.copy(Q2);
  }
  for (const l of face.lids) {
    Q2.setFromAxisAngle(X_AXIS, l.closeRad * clamp(closure, 0, 1));
    l.bone.quaternion.copy(l.rest).multiply(Q2);
  }
  if (face.jaw) {
    Q2.setFromAxisAngle(X_AXIS, jaw);
    face.jaw.bone.quaternion.copy(face.jaw.rest).multiply(Q2);
  }
  face.last.eyeYaw = eyeYaw;
  face.last.eyePitch = eyePitch;
  face.last.closure = closure;
  face.last.jaw = jaw;
}
