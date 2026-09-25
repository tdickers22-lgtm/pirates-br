/**
 * THE ANCHOR (D22, mechanicshud-09 / physics-01, lane b2.1c).
 *
 * The old anchor was a hand-brake: `anchored = true` stopped a galleon from
 * 11 m/s in 0.9 m (about 3 g), with no rope, no bite and no swing. This module
 * is the ONE state machine and force law the server physics reads:
 *
 *   raised --(drop)--> dropping --(2.0 s pay-out)--> biting --(|v| < 0.3)--> held
 *      ^                                                                      |
 *      +------------------------ capstan raise (3.2 s / 2.0 s) --------------+
 *
 *  - dropping: the cable runs out for ANCHOR_PAYOUT_SECONDS and the hull does
 *    exactly what she would with no anchor at all (no deceleration).
 *  - biting: the rode takes up. Its force ramps in over ANCHOR_BITE_RAMP and
 *    never decelerates the hull harder than ANCHOR_MAX_DECEL (0.6 g), so a
 *    sloop from 12 m/s stops in ~2.3 s and a galleon from 13 m/s in ~2.5 s.
 *    With the helm over, the bow is held and the stern swings: she pivots
 *    about her bow (the anchor turn), yaw rate ~ gain x way / half-length.
 *  - held: the hull lies to her anchor; residual way dies quickly, no canvas
 *    drives her.
 *
 * Crew on deck stagger for ANCHOR_STAGGER_SECONDS when the bite comes above
 * ANCHOR_STAGGER_SPEED. There is NO bow breach (D22: it punishes new players
 * and is not in the reference game).
 *
 * Pure and deterministic (no randomness, no clocks): the server steps it in
 * PhysicsSystem.updateShips; the phase is server-side state keyed by ship.
 */
import type { ShipType } from './types/index.js';

export type AnchorPhase = 'raised' | 'dropping' | 'biting' | 'held';

export const G = 9.81;
/** Cable pay-out before the anchor bites, s. */
export const ANCHOR_PAYOUT_SECONDS = 2.0;
/** Ceiling on the rode's deceleration of the hull (D22: <= 0.6 g). */
export const ANCHOR_MAX_DECEL = 0.6 * G;
/** Seconds for the rode tension to build from slack to full. */
export const ANCHOR_BITE_RAMP = 0.5;
/** Below this speed (m/s) a biting anchor is holding. */
export const ANCHOR_HELD_SPEED = 0.3;
/** Residual-way decay once held, 1/s. */
export const ANCHOR_HELD_DAMP = 2.5;
/** Bite speed above which the crew on deck stagger, m/s, and for how long. */
export const ANCHOR_STAGGER_SPEED = 5;
export const ANCHOR_STAGGER_SECONDS = 0.4;
/** Capstan: one hand heaves the anchor up in 3.2 s, two (or more) in 2.0 s. */
export const ANCHOR_RAISE_SOLO_SECONDS = 3.2;
export const ANCHOR_RAISE_PAIR_SECONDS = 2.0;
/**
 * The anchor turn: yaw rate at full helm = ANCHOR_TURN_GAIN x forward way /
 * (half the hull length). Per unit of way the longer hull swings less (the
 * half-length divides), so the galleon's anchor turn is the shallowest; every
 * class lands in the 45-90 deg band of PLAN 3.7 when the helm goes over at the bite.
 * Sloop 1.7 since the rudder became a force (b2.1d): the helm now sheds way
 * in the 2 s pay-out, and the gate still wants >= 90 deg in 6 s from the drop.
 */
export const ANCHOR_TURN_GAIN: Readonly<Record<ShipType, number>> = {
  sloop: 1.7,
  brigantine: 1.4,
  galleon: 1.55,
};
/** Rate (1/s) at which the hull's yaw answers the anchor-turn target. */
export const ANCHOR_TURN_SLEW = 5;
/** Share of the ideal bow-pivot sideways swing the centre of mass carries. */
export const ANCHOR_PIVOT_SHARE = 0.8;

export interface AnchorState {
  phase: AnchorPhase;
  /** Match time the current phase began, s. */
  since: number;
}

export interface AnchorStep {
  state: AnchorState;
  /** True on the one tick the rode takes up (dropping -> biting). */
  bit: boolean;
  /** Hull speed at that bite, m/s (0 when bit is false). */
  biteSpeed: number;
}

/**
 * Advance the phase for one tick. `anchored` is the replicated intent flag
 * (Match sets it on the drop press, the capstan clears it); `speed` is the
 * hull's speed over ground. A state never seen before starts `held` when the
 * ship is already anchored (spawned in her berth), otherwise `raised`.
 */
export function stepAnchorPhase(
  prev: AnchorState | undefined,
  anchored: boolean,
  t: number,
  speed: number,
): AnchorStep {
  if (!prev) {
    return { state: { phase: anchored ? 'held' : 'raised', since: t }, bit: false, biteSpeed: 0 };
  }
  if (!anchored) {
    return prev.phase === 'raised'
      ? { state: prev, bit: false, biteSpeed: 0 }
      : { state: { phase: 'raised', since: t }, bit: false, biteSpeed: 0 };
  }
  switch (prev.phase) {
    case 'raised':
      return { state: { phase: 'dropping', since: t }, bit: false, biteSpeed: 0 };
    case 'dropping':
      if (t - prev.since >= ANCHOR_PAYOUT_SECONDS - 1e-9) {
        return { state: { phase: 'biting', since: t }, bit: true, biteSpeed: speed };
      }
      return { state: prev, bit: false, biteSpeed: 0 };
    case 'biting':
      if (speed < ANCHOR_HELD_SPEED) return { state: { phase: 'held', since: t }, bit: false, biteSpeed: 0 };
      return { state: prev, bit: false, biteSpeed: 0 };
    default:
      return { state: prev, bit: false, biteSpeed: 0 };
  }
}

/** True while the rode acts on the hull (biting or held). */
export function anchorHolds(phase: AnchorPhase | undefined): boolean {
  return phase === 'biting' || phase === 'held';
}

/** Rode deceleration ceiling (m/s^2) `sinceBite` seconds after the bite. */
export function rodeDecel(sinceBite: number): number {
  return ANCHOR_MAX_DECEL * Math.min(1, Math.max(0, sinceBite) / ANCHOR_BITE_RAMP);
}

/**
 * One tick of the rode on the forward speed. `free` is what the hull would
 * make this tick with no anchor (canvas, drag); the rode never lets her keep
 * more way than `current` minus its deceleration, never reverses her, and a
 * canvas still set cannot drive her past it.
 */
export function rodeForwardStep(current: number, free: number, sinceBite: number, dt: number): number {
  const brake = rodeDecel(sinceBite) * dt;
  if (current >= 0) return Math.max(0, Math.min(free, current - brake));
  return Math.min(0, Math.max(free, current + brake));
}

/**
 * The anchor turn: the target yaw rate (rad/s, the ship's angularVelocity sign
 * convention: positive rudder = helm right = omega < 0) for a hull biting on
 * her anchor. Zero with the helm amidships, zero with no way on.
 */
export function anchorTurnOmega(type: ShipType, rudderFrac: number, forwardSpeed: number, length: number): number {
  const half = Math.max(1, length / 2);
  return -Math.max(-1, Math.min(1, rudderFrac)) * ANCHOR_TURN_GAIN[type] * Math.max(0, forwardSpeed) / half;
}

/** Sideways speed of the centre of mass while the bow is held and she yaws at `omega`. */
export function anchorPivotLateral(omega: number, length: number): number {
  return -omega * (length / 2) * ANCHOR_PIVOT_SHARE;
}

/**
 * The rode is the only thing that may brake a biting hull harder than her own
 * drag, and it is capped at 0.6 g on the SPEED (what the crew feel): the keel
 * scrubbing way off in the swing counts against the same ceiling. Returns the
 * factor to scale the new velocity by (>= 1) so |v| never drops faster.
 */
export function rodeSpeedFloorScale(oldSpeed: number, newSpeed: number, dt: number): number {
  const floor = Math.max(0, oldSpeed - ANCHOR_MAX_DECEL * dt);
  return newSpeed > 1e-9 && newSpeed < floor ? floor / newSpeed : 1;
}

/** Whether a bite at `biteSpeed` staggers the crew on deck. */
export function anchorBiteStaggers(biteSpeed: number): boolean {
  return biteSpeed > ANCHOR_STAGGER_SPEED;
}

/** Seconds to heave the anchor up with `hands` pirates on the capstan (>= 1). */
export function anchorRaiseSeconds(hands: number): number {
  return hands >= 2 ? ANCHOR_RAISE_PAIR_SECONDS : ANCHOR_RAISE_SOLO_SECONDS;
}
