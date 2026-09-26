// Camera-side motion with a sign that can be wrong (b3.3e, vm:animations:5).
//
// Pure functions, so test-anim-no-inversion can grade the SIGN of each one in
// node without booting Game: which way the deck rolls the view, which way a
// footfall and a hard landing move the eye, and whether the spyglass sway
// drifts off what it is pointed at.
import * as THREE from 'three';

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Roll (rad, for `camera.rotateZ`) that stands the camera's up on the deck
 * normal as seen through the lens. `camQuat` is the camera orientation after
 * `lookAt` and before any roll; `deckNormal` is the drawn hull's up vector in
 * world space.
 *
 * The view is standing on the deck, so its up follows the deck's up: heel to
 * starboard and the horizon tilts the other way. The HEAD formula was
 * `-hull.roll`, right only while you look at the bow: facing aft it rolled the
 * view AGAINST the heel, and looking over the rail the ship's pitch (which is
 * what actually tilts that horizon) never reached the camera.
 *
 * rotateZ(+a) turns the camera's up toward its -X (left), so
 * a = atan2(-n.right, n.up) aligns them.
 */
export function deckCameraRoll(camQuat: THREE.Quaternion, deckNormal: THREE.Vector3): number {
  _right.set(1, 0, 0).applyQuaternion(camQuat);
  _up.set(0, 1, 0).applyQuaternion(camQuat);
  const nr = deckNormal.dot(_right);
  const nu = deckNormal.dot(_up);
  if (nu <= 1e-4) return 0; // looking straight along the mast: no horizon to roll
  return Math.atan2(-nr, nu);
}

/** Head bob amplitude (m) at full run; first person, on foot. A few cm reads as
 *  footfall weight without the seasickness of a big bob. */
export const HEAD_BOB_M = 0.016;

/**
 * Vertical eye offset (m, <= 0) for the stride. `stride01` is the distance
 * walked since the last audible footstep over the footstep stride (0 = the
 * foot just landed). The head is LOWEST at heel strike (double support) and
 * back at the standing eye height mid-stance, so the dip lands on the sound.
 * Never above the standing eye: a bob that lifts reads as a hop.
 */
export function headBobOffset(stride01: number, speed: number, moveSpeed: number): number {
  const k = THREE.MathUtils.clamp(speed / Math.max(moveSpeed, 1e-3), 0, 1);
  if (k <= 0) return 0;
  const c = Math.cos(stride01 * Math.PI * 2);
  return -HEAD_BOB_M * k * (0.5 + 0.5 * c);
}

/** Landing dip (m) per m/s of fall past the 3 m/s thud threshold, capped. */
export const LANDING_DIP_PER_MS = 0.022;
export const LANDING_DIP_MAX_M = 0.14;
const DIP_ATTACK_S = 0.07;
const DIP_RECOVER_TAU_S = 0.11;

/**
 * Eye offset (m, <= 0) `age` seconds after touching down from a fall of
 * `fallSpeed` m/s: the knees take the landing, so the eye DROPS fast and
 * recovers, never pops up. Zero below the 3 m/s landing-thud threshold.
 */
export function landingDipOffset(age: number, fallSpeed: number): number {
  if (!(age >= 0) || fallSpeed <= 3) return 0;
  const amp = Math.min(LANDING_DIP_MAX_M, (fallSpeed - 3) * LANDING_DIP_PER_MS);
  const env = age < DIP_ATTACK_S
    ? age / DIP_ATTACK_S
    : Math.exp(-(age - DIP_ATTACK_S) / DIP_RECOVER_TAU_S);
  return -amp * env;
}

/** Spyglass handheld sway amplitude (rad). At the 6 deg scope FOV this is ~3%
 *  of the frame: alive, never enough to lose a sail on the horizon. */
export const SPYGLASS_SWAY_RAD = 0.0018;

/**
 * Handheld spyglass sway (rad, yaw and pitch offsets) at time `t` seconds.
 * Two incommensurate sines per axis so it never loops visibly, each a whole
 * number of cycles over the 2*PI*10 s window, so the sway is ZERO-MEAN: it
 * breathes around the target and never pulls the glass off it. Crouching
 * steadies the hand.
 */
export function spyglassSway(t: number, crouching: boolean, out = { yaw: 0, pitch: 0 }) {
  const a = SPYGLASS_SWAY_RAD * (crouching ? 0.45 : 1);
  // Each axis peaks at a / sqrt(2), so the combined offset never exceeds a.
  const k = a * Math.SQRT1_2;
  out.yaw = k * (0.7 * Math.sin(t * 0.7) + 0.3 * Math.sin(t * 1.9 + 1.3));
  out.pitch = k * (0.6 * Math.sin(t * 1.1 + 0.4) + 0.4 * Math.sin(t * 0.3 + 2.1));
  return out;
}
