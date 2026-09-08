import * as THREE from 'three';
import { SHARK } from '../../shared/constants/index.js';
import type { SharkAttackState } from '../../shared/types/index.js';
import type { SharkAnimData } from './factories/FaunaMeshFactory.js';

/**
 * HOW A SHARK MOVES (FAUNAGLB-01, assets-12) — one file, two bodies.
 *
 * The pose *decisions* (how fast the tail beats, how far the jaw gapes, how far
 * the pectorals flare, how the body pitches and rolls) belong to the shark's
 * attack state and are the same whichever body is drawn. They used to live
 * inline in Game.syncSharks with the scene-graph bookkeeping wrapped around
 * them, which is why nothing could test them. They are pure functions here.
 *
 * Then one of two things applies them:
 *
 *   SKINNED (balanced/high): an AnimationMixer runs `swim` looping with its
 *     time scale on the beat rate, and `bite` fired once on the windup→lunge
 *     edge. The whole body bends, because the clip bends the whole spine.
 *
 *   PIVOT (low tier, or before the GLBs are in): the four named nodes are
 *     rotated exactly as they were before this lane. Unchanged on purpose —
 *     it is the fallback, and a fallback that drifts from the thing it stands
 *     in for is worse than no fallback.
 *
 * DISTANCE LOD. Stepping a mixer is skeleton work: every bone's matrix, every
 * frame, per shark. A shark 3.4 m long at 90 m is about 25 px tall and nobody
 * can see which frame of the swim it is on, so past MIXER_NEAR_M the mixer is
 * stepped at 15 Hz off an accumulator (motion continues, at a third of the
 * cost) and past MIXER_CULL_M not at all. No pop: the accumulator hands the
 * mixer the same total dt either way, so the clip is at the same phase when a
 * shark crosses back over the line.
 */

/** Inside this, the mixer steps every frame. */
export const MIXER_NEAR_M = 45;
/** Past this, the mixer does not step at all (the pose freezes; at 130 m a
 *  shark is a few pixels of fin and the swim cycle is not resolvable). */
export const MIXER_CULL_M = 130;
/** Between the two, the mixer steps at this rate off an accumulator. */
export const MIXER_FAR_HZ = 15;

/** What the shark's body is doing this frame. Pure: state in, numbers out. */
export interface SharkPose {
  /** Peak tail yaw, radians (pivot path). */
  tailAmp: number;
  /** Tail beats per second — also the skinned `swim` clip's time scale. */
  tailHz: number;
  /** Jaw opening, radians. */
  jawTarget: number;
  /** Pectoral flare, radians. */
  pecTarget: number;
  /** Nose-up/down of the whole body, radians. */
  pitchTarget: number;
  /** Bank of the whole body, radians. */
  rollTarget: number;
}

/**
 * The pose the attack state asks for. Verbatim the numbers Game.syncSharks
 * used, so nothing a player has seen changes: cruise beats with swim speed,
 * windup rears back and gapes and flares, lunge thrashes with the jaw shut,
 * recover droops and rolls (the vulnerable beat the dodge is scored against).
 */
export function sharkPose(
  attackState: SharkAttackState,
  attackTimer: number,
  swimSpeed: number,
): SharkPose {
  switch (attackState) {
    case 'windup': {
      const wind = THREE.MathUtils.clamp(1 - attackTimer / SHARK.WINDUP_TIME, 0, 1);
      return {
        tailAmp: 0.15, tailHz: 2.2, jawTarget: 0.55 * Math.max(0.4, wind),
        pecTarget: 0.5, pitchTarget: -0.12, rollTarget: 0,
      };
    }
    case 'lunge':
      return { tailAmp: 0.8, tailHz: 6.5, jawTarget: 0.06, pecTarget: 0, pitchTarget: 0, rollTarget: 0 };
    case 'recover':
      return { tailAmp: 0.12, tailHz: 1.6, jawTarget: 0.1, pecTarget: 0, pitchTarget: 0, rollTarget: 0.14 };
    default:
      return {
        tailAmp: 0.35,
        tailHz: 2.2 * THREE.MathUtils.clamp(0.5 + swimSpeed / 6, 0.5, 1.6),
        jawTarget: 0.02, pecTarget: 0, pitchTarget: 0, rollTarget: 0,
      };
  }
}

/**
 * How much simulated time to hand the mixer this frame, and what is left over.
 * Returns 0 to skip the step entirely (the caller then does no skeleton work).
 * The carry is never dropped, which is what makes crossing MIXER_NEAR_M
 * invisible: the clip is at the same phase either side of the line.
 */
export function mixerStep(dt: number, carry: number, cameraDistance: number): { step: number; carry: number } {
  if (cameraDistance > MIXER_CULL_M) return { step: 0, carry: 0 };
  if (cameraDistance <= MIXER_NEAR_M) return { step: dt + carry, carry: 0 };
  const acc = carry + dt;
  const interval = 1 / MIXER_FAR_HZ;
  if (acc < interval) return { step: 0, carry: acc };
  return { step: acc, carry: 0 };
}

/**
 * Drive one shark mesh for one frame. `mesh` is whatever
 * FaunaMeshFactory.buildSharkMesh returned; which path runs is decided by the
 * `userData.fauna` it was built with, never by a re-inspection of the scene
 * graph (that would be a traverse per shark per frame).
 *
 * Allocation-free: the only object made is the one `sharkPose` returns, and
 * that is a shape V8 keeps in a young generation for the frame. No closures,
 * no vectors, no arrays.
 */
export function updateSharkPose(
  mesh: THREE.Group,
  dt: number,
  attackState: SharkAttackState,
  attackTimer: number,
  swimSpeed: number,
  oceanTime: number,
  cameraDistance: number,
): void {
  const pose = sharkPose(attackState, attackTimer, swimSpeed);
  const ease = 1 - Math.exp(-10 * dt);
  const anim = mesh.userData.fauna as SharkAnimData | undefined;

  if (anim?.mixer && anim.skinned) {
    // The swim clip IS the tail beat: one cycle of the authored clip is one
    // beat, so the time scale is the beat rate over the authored 1 Hz.
    if (anim.swim) anim.swim.setEffectiveTimeScale(pose.tailHz / 2.2);
    const ud = mesh.userData as { mixerCarry?: number };
    const { step, carry } = mixerStep(dt, ud.mixerCarry ?? 0, cameraDistance);
    ud.mixerCarry = carry;
    if (step > 0) anim.mixer.update(step);
  } else {
    const parts = mesh.userData.parts as Record<string, THREE.Object3D | undefined> | undefined;
    if (parts?.shark_tail) {
      parts.shark_tail.rotation.y =
        Math.sin(oceanTime * Math.PI * 2 * pose.tailHz + mesh.position.x * 0.1) * pose.tailAmp;
    }
    if (parts?.shark_jaw) parts.shark_jaw.rotation.x += (pose.jawTarget - parts.shark_jaw.rotation.x) * ease;
    if (parts?.shark_pec_l) parts.shark_pec_l.rotation.z += (pose.pecTarget - parts.shark_pec_l.rotation.z) * ease;
    if (parts?.shark_pec_r) parts.shark_pec_r.rotation.z += (-pose.pecTarget - parts.shark_pec_r.rotation.z) * ease;
  }

  // Pitch and roll are the WHOLE body on both paths: the clips bend the spine,
  // they do not bank the shark, and banking is what sells the recover beat.
  mesh.rotation.x += (pose.pitchTarget - mesh.rotation.x) * ease;
  mesh.rotation.z += (pose.rollTarget - mesh.rotation.z) * ease;
}

/** The lunge, on the windup→lunge edge. No-op on the pivot path (its jaw is
 *  already driven by `jawTarget`), so the caller does not have to branch. */
export function playSharkBite(mesh: THREE.Group): void {
  const anim = mesh.userData.fauna as SharkAnimData | undefined;
  if (!anim?.mixer || !anim.bite) return;
  anim.bite.reset();
  anim.bite.setEffectiveWeight(1);
  anim.bite.play();
}

/** Release a shark's mixer when its mesh leaves the scene: an AnimationMixer
 *  holds its root and every action, and four a match over a long session is a
 *  leak nobody would ever see in a profile as anything but "three". */
export function disposeSharkAnim(mesh: THREE.Group): void {
  const anim = mesh.userData.fauna as SharkAnimData | undefined;
  if (!anim?.mixer) return;
  anim.mixer.stopAllAction();
  anim.mixer.uncacheRoot(anim.mixer.getRoot() as THREE.Object3D);
  anim.mixer = null;
  anim.swim = null;
  anim.bite = null;
}
