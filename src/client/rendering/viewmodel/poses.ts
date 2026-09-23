/**
 * First-person viewmodel POSES, as pure functions (b1.6b).
 *
 * Every pose the local viewmodel root takes lives here, not inline in the
 * 1,900-line ViewmodelController, so node can import it and grade it: the only
 * earlier pose suite (test-viewmodel-poses) declines to run on SwiftShader, and
 * that is how three inversions shipped green (animations-03/04/09/15):
 *
 *   * recoil pushed every gun FORWARD, DOWN and muzzle-DOWN, and holding the
 *     trigger parked it there (a 0.72 "hold plateau");
 *   * the slash ribbon was the vertical mirror of the blade and swept the
 *     opposite way on both diagonals;
 *   * a fresh weapon came up muzzle-HIGH (43 deg) and tipped down into aim.
 *
 * CONVENTIONS (the ones the gate checks). The camera looks down -Z; the weapon
 * root is a camera child; a Pose6 is [x, y, z, rx, ry, rz] of that root (Euler
 * XYZ). Guns are yawed 180 deg into the root, so the muzzle sits at root -Z and
 * a POSITIVE rx tips it UP. +Z is toward the eye. The cutlass is authored blade
 * UP along +Y, so its screen angle is 90 deg + roll.
 */
import * as THREE from 'three';
import type { WeaponId } from '../../../shared/types/index.js';

export type Pose6 = [number, number, number, number, number, number];

const smooth = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const DEG = Math.PI / 180;

/**
 * Barrel-tip offset per weapon, in viewmodel-ROOT space (mesh muzzle position
 * times the mesh scale, negated by the 180 deg yaw: the muzzle is at -Z). The
 * old positive offsets parked the flash behind the camera.
 */
export function muzzleTipFor(weaponId: WeaponId): [number, number, number] {
  switch (weaponId) {
    case 'eye_of_reach': return [0, 0.069, -1.24];
    case 'blunderbuss': return [0, 0.052, -0.94];
    case 'flintknock': return [0, 0.054, -0.53];
    default: return [0, 0.024, -0.79];
  }
}

// ── RECOIL ──────────────────────────────────────────────────────────────────

/**
 * Per-weapon recoil: an IMPULSE, not a pose. `climb` seconds to the peak
 * (60-90 ms), then an eased settle that is back at rest by `climb + settle`
 * (<= 260 ms). `pitch` is the muzzle climb at the peak (radians, positive =
 * muzzle up), `back` how far the gun comes toward the eye (m), `lift` how far it
 * rises (m), `roll` the small wrist roll. `adsBack` replaces `back` while
 * aiming: a shouldered blunderbuss sits 0.15 m from the eye, and its full 8 cm
 * shove would put the stock through the 0.1 near plane (the near-plane rule in
 * test-anim-no-inversion holds every vertex at z < -0.12); the climb carries it.
 */
export type RecoilSpec = { climb: number; settle: number; pitch: number; back: number; adsBack: number; lift: number; roll: number };

export const RECOIL: Record<'pistol' | 'blunderbuss' | 'eye_of_reach', RecoilSpec> = {
  pistol: { climb: 0.065, settle: 0.135, pitch: 5 * DEG, back: 0.05, adsBack: 0.05, lift: 0.012, roll: 0.03 },
  blunderbuss: { climb: 0.085, settle: 0.17, pitch: 9.5 * DEG, back: 0.08, adsBack: 0.025, lift: 0.02, roll: 0.05 },
  eye_of_reach: { climb: 0.075, settle: 0.165, pitch: 6 * DEG, back: 0.09, adsBack: 0.09, lift: 0.01, roll: 0.02 },
};

export function recoilSpecFor(weaponId: WeaponId): RecoilSpec {
  if (weaponId === 'blunderbuss') return RECOIL.blunderbuss;
  if (weaponId === 'eye_of_reach') return RECOIL.eye_of_reach;
  return RECOIL.pistol;
}

/**
 * Recoil envelope 0..1 at `age` seconds after the shot. `from` is the envelope
 * value when the shot landed (a fast follow-up starts from where the last kick
 * was instead of snapping down to zero). Monotone up for `climb`, then an
 * eased settle to exactly 0; there is no hold plateau, whatever the trigger does.
 */
export function recoilEnvelope(spec: RecoilSpec, age: number, from = 0): number {
  if (!(age >= 0) || !Number.isFinite(age)) return 0;
  if (age < spec.climb) {
    const u = age / spec.climb;
    return from + (1 - from) * Math.sin(u * Math.PI * 0.5);
  }
  const s = (age - spec.climb) / spec.settle;
  if (s >= 1) return 0;
  return 0.5 * (1 + Math.cos(s * Math.PI));
}

/** The recoil delta to ADD to a weapon pose at envelope value `k` (aimBlend 0 hip .. 1 ADS). */
export function recoilDelta(spec: RecoilSpec, k: number, aimBlend = 0): Pose6 {
  const back = lerp(spec.back, spec.adsBack, clamp(aimBlend, 0, 1));
  return [0, spec.lift * k, back * k, spec.pitch * k, 0, -spec.roll * k];
}

// ── FIREARM POSE ────────────────────────────────────────────────────────────

export type WeaponPoseState = {
  aimBlend: number;
  bob: number;
  sway: number;
  strafeTilt: number;
  travelSwing: number;
  /** reloadChoreography(...).pose */
  reload: Pose6;
  /** recoilEnvelope(...) */
  recoil: number;
};

/** The firearm viewmodel root pose (eye_of_reach, blunderbuss, flintknock + fallback). */
export function weaponPose(weaponId: WeaponId, s: WeaponPoseState): Pose6 {
  const { aimBlend, bob, sway, strafeTilt, travelSwing } = s;
  const [rlX, rlY, rlZ, rlRX, rlRY, rlRZ] = s.reload;
  const [, kY, kZ, kRX, , kRZ] = recoilDelta(recoilSpecFor(weaponId), s.recoil, aimBlend);
  switch (weaponId) {
    case 'eye_of_reach':
      // 1.4 m of rifle: yawed POSITIVE so the barrel crosses toward screen
      // centre as a readable diagonal instead of a foreshortened stock corner.
      return [
        lerp(0.24, 0.025, aimBlend) + sway * 0.26 + travelSwing * 0.18 + rlX,
        lerp(-0.26, -0.15, aimBlend) + bob * 0.75 + kY + rlY,
        lerp(-0.96, -0.42, aimBlend) + kZ + rlZ,
        -0.16 + aimBlend * 0.16 + kRX + rlRX,
        lerp(0.3, 0.0, aimBlend) + rlRY,
        -0.06 - strafeTilt * 0.8 + kRZ + rlRZ,
      ];
    case 'blunderbuss':
      // Lower-right hip with presence; barrel angled toward the crosshair so
      // the flash lands in the visible lower third.
      return [
        lerp(0.32, 0.16, aimBlend) + sway * 0.36 + travelSwing * 0.28 + rlX,
        lerp(-0.28, -0.24, aimBlend) + bob + kY + rlY,
        lerp(-0.82, -0.7, aimBlend) + kZ + rlZ,
        -0.2 - aimBlend * 0.07 + kRX + rlRX,
        lerp(0.14, 0.06, aimBlend) + rlRY,
        -0.08 - strafeTilt + kRZ + rlRZ,
      ];
    default:
      // Flintknock + fallback: carried high enough that its own fist stays in
      // frame at rest and mid-reload.
      return [
        lerp(0.24, 0.085, aimBlend) + sway * 0.64 + travelSwing * 0.38 + rlX,
        lerp(-0.15, -0.12, aimBlend) + bob + kY + rlY,
        lerp(-0.62, -0.5, aimBlend) + kZ + rlZ,
        -0.16 - aimBlend * 0.07 + kRX + rlRX,
        lerp(0.16, 0.06, aimBlend) + rlRY,
        -0.1 - strafeTilt + kRZ + rlRZ,
      ];
  }
}

// ── DRAW ────────────────────────────────────────────────────────────────────

/** Seconds for a freshly drawn weapon/tool to rise into its rest pose (220-280 ms band). */
export const VIEW_DRAW_TIME = 0.26;

/**
 * Delta ADDED to the pose while a fresh weapon comes up, `t` = 0..1 of
 * VIEW_DRAW_TIME. It starts low, a touch nearer and MUZZLE-LOW (rx -0.55, so
 * the gun rotates UP into line the way a real draw does; it used to start
 * 43 deg muzzle-high and tip down), with a small roll-in, and lands with a
 * slight upward overshoot that never crosses more than 3 deg past the aim.
 */
export function drawDelta(t: number): Pose6 {
  const d = clamp(t, 0, 1);
  if (d >= 1) return [0, 0, 0, 0, 0, 0];
  const e = 1 - d;
  const overshoot = Math.sin(d * Math.PI) * d * 0.05;
  return [0, -0.34 * e * e, 0.1 * e * e, -0.55 * e * e + overshoot, 0, 0.14 * e * e];
}

// ── RELOAD ──────────────────────────────────────────────────────────────────

export type ReloadPose = { pose: Pose6; ram: number; pulseIndex: number };

/** Real reload choreography (INSPECT -> RAM -> RETURN); `ram` also drives the support hand. */
export function reloadChoreography(weaponId: WeaponId, p: number): ReloadPose {
  if (p <= 0.0001) return { pose: [0, 0, 0, 0, 0, 0], ram: 0, pulseIndex: -1 };
  const pulses = weaponId === 'blunderbuss' ? 2 : weaponId === 'eye_of_reach' ? 1 : 3;
  const inspect = smooth(p, 0, 0.3);
  const back = smooth(p, 0.72, 1);
  const hold = inspect * (1 - back);
  // Discrete plunges, timed so the last one lands right as RETURN starts.
  let ram = 0;
  let pulseIndex = -1;
  if (p > 0.3 && p < 0.74) {
    const u = (p - 0.3) / 0.44;
    pulseIndex = Math.floor(u * pulses);
    const frac = u * pulses - pulseIndex;
    ram = Math.sin(clamp(frac, 0, 1) * Math.PI) ** 1.6;
  }
  // Overshoot on the way home sells the snap-up.
  const overshoot = Math.sin(clamp((p - 0.72) / 0.28, 0, 1) * Math.PI) * 0.9;
  const bolt = weaponId === 'eye_of_reach' ? 1 : 0;
  if (weaponId === 'blunderbuss') {
    // BROADSIDE: yaw the whole gun ~75 deg and push it out so both ends sit at
    // a comparable depth; the old keys ran it straight down the view axis (a
    // diagonal stack of gold ellipses) and threw the trigger fist off-frame.
    return {
      pose: [
        hold * -0.22 + ram * 0.03,
        hold * -0.02 - ram * 0.03,
        hold * -0.18 - ram * 0.04,
        hold * 0.15 - ram * 0.1 - overshoot * 0.08,
        hold * 1.16 + ram * 0.06,
        hold * 0.18 + ram * 0.05 + overshoot * 0.1,
      ],
      ram,
      pulseIndex,
    };
  }
  if (weaponId === 'flintknock') {
    // A pistol is primed UP at eye level, not dropped to the hip.
    return {
      pose: [
        hold * -0.04 + ram * 0.02,
        hold * 0.06 - ram * 0.04,
        hold * 0.04 + ram * 0.04,
        hold * 0.3 - ram * 0.14,
        hold * -0.15,
        hold * 0.55 + ram * 0.06 + overshoot * 0.12,
      ],
      ram,
      pulseIndex,
    };
  }
  // Long arms (Eye of Reach + fallback): half the roll and a third of the drop
  // of the old keys keeps both fists at ndc.y ~ -0.5, clear of the slot HUD.
  return {
    pose: [
      hold * -0.06 + ram * 0.02,
      hold * -0.04 - ram * 0.04,
      hold * 0.06 + ram * 0.05,
      hold * (0.5 + bolt * 0.1) - ram * 0.12 - overshoot * 0.12,
      hold * -0.28 + bolt * hold * 0.2,
      hold * (0.5 + bolt * 0.35) + ram * 0.06 + overshoot * 0.1,
    ],
    ram,
    pulseIndex,
  };
}

// ── HELD TOOLS ──────────────────────────────────────────────────────────────

/**
 * Minimum angle (radians ~ 20.6 deg) a long tool's shaft may sit off the view
 * axis: dead-on, a 1 m haft projects to a few pixels behind the fists.
 */
export const TOOL_MIN_OFF_AXIS = 0.36;

export type ToolPoseState = { bob: number; sway: number; time: number; firing: boolean; bailScoopProgress: number; bucketFilled: boolean };

/**
 * The equipped-tool viewmodel root pose (compass, bucket, spyglass, lantern,
 * axe, shovel). Axe AXIS NOTE: the haft runs along Z with the head at the far
 * -Z end, so POSITIVE rx raises the HEAD.
 */
export function toolPose(tool: string, s: ToolPoseState): Pose6 {
  const { bob, sway, time } = s;
  const MIN_OFF_AXIS = TOOL_MIN_OFF_AXIS;
  const cfg: { p: number[]; r: number[] } = tool === 'compass'
          // At z −0.38 the compass face was 38cm from the eye: it swallowed the
          // lower-right quarter of the frame and threw its own holding fist to
          // ndc [0.50, −0.70], in the corner behind the HUD tiles. Held at arm's
          // length instead the fist reads at [0.28, −0.43] and the card is still
          // easily large enough to take a bearing off.
          ? { p: [0.16 + sway * 0.5, -0.13 + bob, -0.56], r: [-0.88 + bob, 0.16 + sway * 0.3, 0.08] }
          : tool === 'bucket'
            ? (() => {
              // The SCOOP→HEAVE cycle must READ: bailScoopProgress runs 1→0
              // over 0.6s after each press. Just-scooped (filled) dips the
              // bucket low then lifts the load; just-heaved (emptied) hoists
              // and FLINGS it forward — the eject the cycle was missing.
              const prog = THREE.MathUtils.clamp(s.bailScoopProgress ?? 0, 0, 1);
              const anim = 1 - prog; // 0 → 1 across the action
              if (prog > 0.01 && s.bucketFilled) {
                const dip = Math.sin(Math.min(1, anim / 0.7) * Math.PI);
                return {
                  p: [0.24 + sway * 0.3, -0.35 - dip * 0.24 + bob, -0.56 - dip * 0.14],
                  r: [-0.12 - dip * 0.55 + bob, 0.2, -0.1 + dip * 0.08],
                };
              }
              if (prog > 0.01 && !s.bucketFilled) {
                const fling = Math.sin(Math.min(1, anim / 0.5) * Math.PI);
                return {
                  p: [0.24, -0.35 + fling * 0.3 + bob, -0.56 - fling * 0.36],
                  r: [-0.12 - fling * 1.25 + bob, 0.2, -0.1 + fling * 0.16],
                };
              }
              return { p: [0.24 + sway * 0.5, -0.35 + bob, -0.56], r: [-0.12 + bob, 0.2 + sway * 0.3, -0.1] };
            })()
            : tool === 'spyglass'
              ? { p: [0.2 + sway * 0.4, -0.2 + bob, -0.46], r: [0.05, -0.5 + sway * 0.2, 0.12] }
              : tool === 'lantern'
                ? { p: [0.26 + sway * 0.5, -0.16 + bob, -0.5], r: [0.02 + bob, 0.2, -0.05] } // held up like a lamp
              : tool === 'axe'
                ? (() => {
                  // AXIS NOTE (corrected from a user screenshot of the flipped
                  // grip): with the haft along Z, POSITIVE rot.x raises the
                  // HEAD (the far −Z end) — negative pitch lifted the BUTT and
                  // read as holding the axe by its head, handle in the sky.
                  if (s.firing) {
                    const cycle = (time * 1.4) % 1;
                    // Re-timed so the cycle isn't 70% static hold with the head
                    // buried in the trunk: COCK high 0–0.3, brief HOLD to 0.5,
                    // fast STRIKE 0.5–0.62, then recover.
                    const raise = THREE.MathUtils.smoothstep(cycle, 0, 0.3);
                    const strike = THREE.MathUtils.clamp((cycle - 0.5) / 0.12, 0, 1) ** 1.6;
                    const recover = THREE.MathUtils.smoothstep(cycle, 0.66, 1);
                    const arc = 1 - recover;
                    const pitch = 0.5 + (raise * 0.9 - strike * 2.4) * arc;
                    // THE SLIVER (the cutlass-thrust lesson, again). With the
                    // haft along Z the blade points along −Z, so its angle off
                    // the view axis is acos(cos(yaw)·cos(pitch)) — it foreshortens
                    // to NOTHING whenever pitch and yaw are BOTH near zero. The
                    // old keys swept yaw from +0.45 through −0.30, so it sat at
                    // ~0 at exactly the two moments pitch crossed the eyeline
                    // (mid-strike, and again for ~80 ms of the slow recovery,
                    // which is the frame the eye actually samples). Measured
                    // there: 0.9° off axis — a sliver of steel hiding behind the
                    // fists.
                    //
                    // Two changes, both needed. FIRST the yaw now OPENS with the
                    // chop instead of crossing over, so the swing travels
                    // diagonally across frame and the yaw never changes sign
                    // (a sign flip under the floor below would snap).
                    const yawKey = 0.15 + (raise * 0.3 + strike * 0.28) * arc;
                    // SECOND, a floor that makes the guarantee unconditional:
                    // whatever the keys ask for, hold ≥ MIN_OFF_AXIS of blade off
                    // the eyeline. The floor is 0 at the edge of the band and
                    // grows smoothly to its maximum at pitch = 0, so it eases in
                    // rather than snapping — and it is inert everywhere else,
                    // including at rest.
                    const cosPitch = Math.abs(Math.cos(pitch));
                    const yawFloor = cosPitch > Math.cos(MIN_OFF_AXIS)
                      ? Math.acos(THREE.MathUtils.clamp(Math.cos(MIN_OFF_AXIS) / cosPitch, -1, 1))
                      : 0;
                    return {
                      // Same rest anchor as below (0.26 / −0.20 / −0.80) so the
                      // chop swings away from a pose whose fists are in frame.
                      p: [
                        0.26 + (raise * 0.14 - strike * 0.4) * arc,
                        -0.2 + (raise * 0.16 - strike * 0.26) * arc,
                        -0.8 - strike * 0.14 * arc,
                      ],
                      r: [
                        pitch,
                        Math.max(yawKey, yawFloor),
                        // Roll is a spin about the haft — it never moves the head,
                        // so it is free to sell the bite of the blade.
                        -0.15 + (-raise * 0.2 + strike * 0.6) * arc,
                      ],
                    };
                  }
                  // Rest: head UP at the far end, hand low on the haft, pulled
                  // back so the blade clears the trunk you're stood against.
                  // FRAMING (this is the audited "axe floats with zero hands"):
                  // at z −0.62 the rear fist projected to ndc [0.47, −0.79] —
                  // the extreme bottom-right corner, behind the ship-hull and
                  // weapon-slot HUD tiles — while the head swept across mid
                  // screen, so the axe read as a prop with nothing holding it.
                  // Pushed 0.18 further out and lifted 0.04: fists now land at
                  // [0.30, −0.51] and [0.22, −0.28], on clear frame.
                  return { p: [0.26 + sway * 0.4, -0.2 + bob, -0.8], r: [0.5 + bob, 0.15 + sway * 0.2, -0.15] };
                })()
              // Shovel is long — lay it DIAGONALLY across the lower-right (blade
              // low, handle up-left) via a roll about the view axis, so the whole
              // tool stays in the frame plane instead of receding down-forward.
              // At z −0.54 the rear fist was only 0.41m from the eye, which threw
              // its palm to ndc.y −1.02 — literally off the bottom of the frame,
              // measured. 0.24 further out and 0.06 up puts both fists on the
              // haft in shot ([0.28, −0.52] and [0.15, −0.40]).
              : { p: [0.2 + sway * 0.4, -0.28 + bob, -0.78], r: [-0.2 + bob, 0.3 + sway * 0.2, 0.8] };
  return [cfg.p[0], cfg.p[1], cfg.p[2], cfg.r[0], cfg.r[1], cfg.r[2]];
}

// ── CUTLASS ─────────────────────────────────────────────────────────────────

/** Ready stance: hilt lower-right, blade rising across toward screen centre. */
export const CUTLASS_REST: Pose6 = [0.33, -0.26, -0.66, -0.62, -0.1, 0.28];
/** Guard: the full blade crosses horizontally under the crosshair. */
export const CUTLASS_GUARD: Pose6 = [0.06, -0.16, -0.44, -0.35, 0.15, -1.5];
/** Blade tip in viewmodel-root space (mesh tip y ~ 1 times the 0.92 mesh scale). */
export const CUTLASS_TIP: [number, number, number] = [0, 0.92, 0];

function mix(a: Pose6, b: readonly number[], t: number): Pose6 {
  for (let i = 0; i < 6; i++) a[i] += (b[i] - a[i]) * t;
  return a;
}

/** Rest / charge wind-up (charge 0..1): the whole weapon and its fist stay in frame. */
export function cutlassRestPose(charge: number): Pose6 {
  return [
    CUTLASS_REST[0] + charge * 0.06,
    CUTLASS_REST[1] + charge * 0.05,
    CUTLASS_REST[2] + charge * 0.02,
    CUTLASS_REST[3] + charge * 0.02,
    CUTLASS_REST[4] - charge * 0.3,
    CUTLASS_REST[5] - charge * 0.55,
  ];
}

/**
 * SLASH at swing progress p (0..1 of the 0.55 s swing), diagonal `side`:
 * ANTICIPATION -> WHIP -> FOLLOW-THROUGH -> RECOVERY. The blade lies flat
 * across the screen at the cut (roll 1.45) and rolls PAST horizontal; the
 * keys are mirrored about the view axis per diagonal.
 */
export function cutlassSlashPose(side: 1 | -1, p: number): Pose6 {
  const cock = smooth(p, 0, 0.2);
  const cut = smooth(p, 0.2, 0.34);
  const through = smooth(p, 0.34, 0.56);
  const recover = smooth(p, 0.62, 1);
  return mix(
    mix(
      mix(
        mix([...CUTLASS_REST], [0.31 * side, -0.15, -0.68, -0.75, -0.3 * side, -0.85 * side], cock),
        [0.29 * side, -0.11, -0.72, -0.3, 0.25 * side, 1.45 * side], cut,
      ),
      [0.22 * side, -0.06, -0.92, -0.1, 0.3 * side, 1.85 * side], through,
    ),
    CUTLASS_REST, recover,
  );
}

/** DASH THRUST at lunge progress p: pull back, ram forward ~0.35 rad off the view axis, carry, recover. */
export function cutlassLungePose(p: number): Pose6 {
  const windup = smooth(p, 0, 0.09);
  const stab = smooth(p, 0.09, 0.24);
  const carry = smooth(p, 0.24, 0.6);
  const recover = smooth(p, 0.6, 1);
  return mix(
    mix(
      mix(
        mix([...CUTLASS_REST], [0.42, -0.2, -0.62, -0.55, -0.35, -0.55], windup),
        [0.2, -0.16, -0.88, -1.24, 0.3, -0.08], stab,
      ),
      [0.22, -0.18, -0.82, -1.18, 0.32, -0.16], carry,
    ),
    CUTLASS_REST, recover,
  );
}

const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Camera-space point of a root-space point under a Pose6 (no scale). */
export function poseApply(pose: Pose6, p: readonly [number, number, number], out = new THREE.Vector3()): THREE.Vector3 {
  _e.set(pose[3], pose[4], pose[5], 'XYZ');
  _m.makeRotationFromEuler(_e).setPosition(pose[0], pose[1], pose[2]);
  return out.set(p[0], p[1], p[2]).applyMatrix4(_m);
}

/**
 * Screen angle (radians, CCW from screen-right) of the blade, hilt -> tip, as
 * the eye sees it: perspective divide only, so it holds for any fov/aspect
 * rendered with square pixels.
 */
export function bladeScreenAngle(pose: Pose6): number {
  const h = poseApply(pose, [0, 0, 0], _a);
  const t = poseApply(pose, CUTLASS_TIP, _b);
  return Math.atan2(t.y / -t.z - h.y / -h.z, t.x / -t.z - h.x / -h.z);
}

/** Ribbon arc geometry: half-span of the crescent (the head sits at +half-span in ribbon-local XY). */
export const SLASH_RIBBON_HALF_SPAN = Math.PI * 0.36;
/** Seconds of the basic swing the ribbon rides (swing progress = age / this). */
export const SLASH_SWING_TIME = 0.55;
/** Swing progress where the ribbon stops holding the cocked angle and sweeps with the blade. */
const RIBBON_SWEEP_FROM = 0.2;

export type RibbonPose = { rotZ: number; scaleX: number; scaleY: number; opacity: number };

/**
 * The first-person slash ribbon at swing progress p, riding the BLADE: its head
 * points where the blade points on screen, and it sweeps the same way on both
 * diagonals. The geometry is only ever mirrored in X (per diagonal, which also
 * flips the tail to trail behind the head); the old extra -Y mirror and the
 * decreasing rotation made it the upside-down image of the cut. During the
 * wind-up it holds the cocked angle (the blade rolls backward there) and it is
 * brightest just after the whip.
 */
export function slashRibbonPose(side: 1 | -1, p: number): RibbonPose {
  const grow = 0.92 + clamp(p / 0.62, 0, 1) * 0.62;
  const blade = bladeScreenAngle(cutlassSlashPose(side, Math.max(p, RIBBON_SWEEP_FROM)));
  // Head angle in ribbon-local space after the X mirror.
  const headLocal = side === 1 ? SLASH_RIBBON_HALF_SPAN : Math.PI - SLASH_RIBBON_HALF_SPAN;
  const u = clamp((p - 0.16) / 0.46, 0, 1);
  return {
    rotZ: blade - headLocal,
    scaleX: side * grow,
    scaleY: grow,
    opacity: 0.98 * Math.sin(u ** 0.6 * Math.PI) ** 0.6,
  };
}
