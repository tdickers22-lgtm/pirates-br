/**
 * HOLD CARGO — the gold race, made physical.
 *
 * The signature win condition of this battle royale is a 9000-gold race, and
 * for most of its life that race was an invisible number in the corner of the
 * HUD: no silhouette, no weight, no counterplay, no wreck to loot. This module
 * is the single shared truth that turns banked gold into a THING in the world,
 * so the server sim, the server physics, the hull renderer and the HUD can
 * never disagree about how heavy a crew is or what tier their hold reads at.
 *
 * The rules, in one place:
 *   · Gold at or below CARGO.SAFE_GOLD is pocket coin — weightless, unstealable
 *     by the world, never spilled. A losing night never zeroes a pirate.
 *   · Everything above it is CARGO: crates in the hold you can walk down and
 *     look at, ballast the hull carries as lost top speed, a fatter purse for a
 *     boarder's cutlass, and treasure that spills into the shallows when she
 *     founders.
 *
 * Every function here is pure and shared — no imports beyond constants.
 */
import { CARGO, ECONOMY, PLAYER } from './constants/index.js';

/** Hold tiers, tier 0 (trim) through tier 4 (wallowing). */
export const CARGO_TIER_LABELS = [
  'trim',
  'stowed',
  'laden',
  'deep-laden',
  'wallowing',
] as const;

export type CargoTier = 0 | 1 | 2 | 3 | 4;

/** The part of a purse that is CARGO — everything over the safe pocket. */
export function cargoGoldFromBanked(gold: number): number {
  return Math.max(0, Math.floor(gold) - CARGO.SAFE_GOLD);
}

/** 0..1 how full the hold reads against a full load. */
export function cargoLoadFraction(cargoGold: number): number {
  if (!(cargoGold > 0)) return 0;
  return Math.min(1, cargoGold / CARGO.FULL_LOAD);
}

/** Hold tier for a cargo-gold amount: 0 trim … 4 wallowing. */
export function cargoTier(cargoGold: number): CargoTier {
  let tier = 0;
  for (let i = 0; i < CARGO.TIER_THRESHOLDS.length; i += 1) {
    if (cargoGold >= CARGO.TIER_THRESHOLDS[i]) tier = i + 1;
  }
  return tier as CargoTier;
}

/** 'trim' | 'stowed' | 'laden' | 'deep-laden' | 'wallowing'. */
export function cargoTierLabel(cargoGold: number): string {
  return CARGO_TIER_LABELS[cargoTier(cargoGold)];
}

/**
 * Multiplier on a hull's top speed for the weight in her hold. 1 = flying
 * light; 1 - CARGO.MAX_BALLAST_PENALTY at a completely full hold. Applied by
 * PhysicsSystem to BOTH the sail target speed and the hard speed clamp, so a
 * treasure galleon is genuinely run-downable — the whole point of making the
 * leader visible is that the fleet can catch her.
 */
export function cargoBallastFactor(cargoGold: number): number {
  return 1 - cargoLoadFraction(cargoGold) * CARGO.MAX_BALLAST_PENALTY;
}

/** Ballast penalty as a 0..1 fraction of top speed (HUD/test convenience). */
export function cargoBallastPenalty(cargoGold: number): number {
  return 1 - cargoBallastFactor(cargoGold);
}

/**
 * How much gold one boarding kill may cut out of a purse. The floor is the
 * long-standing PLAYER.BOARDING_GOLD_STEAL_CAP — a rounding error against a
 * 9000 target — and it scales up to STEAL_LADEN_MULT× against a fully laden
 * victim. Boarding the leader is the answer to the leader.
 */
export function boardingStealCap(victimGold: number): number {
  const load = cargoLoadFraction(cargoGoldFromBanked(victimGold));
  return Math.round(
    PLAYER.BOARDING_GOLD_STEAL_CAP * (1 + (CARGO.STEAL_LADEN_MULT - 1) * load),
  );
}

/** True when a crew's banked gold is big enough to hang a bounty on them. */
export function bountyThresholdGold(): number {
  return Math.ceil(ECONOMY.GOLD_WIN_TARGET * CARGO.BOUNTY_RATIO);
}

/** Gold a bountied crew must fall back under before the bounty lifts. */
export function bountyClearGold(): number {
  return Math.ceil(ECONOMY.GOLD_WIN_TARGET * CARGO.BOUNTY_CLEAR_RATIO);
}

/**
 * Split a spill into divable pieces. Returns the value of each piece; the sum
 * is exactly `total`. Small spills stay one fat piece rather than a dusting of
 * worthless glints — a wreck should be worth swimming for.
 */
export function splitSpill(total: number): number[] {
  const amount = Math.floor(total);
  if (amount <= 0) return [];
  const pieces = Math.max(
    1,
    Math.min(CARGO.SPILL_PIECES_MAX, Math.floor(amount / CARGO.SPILL_PIECE_MIN)),
  );
  const base = Math.floor(amount / pieces);
  const out: number[] = [];
  let remaining = amount;
  for (let i = 0; i < pieces; i += 1) {
    const value = i === pieces - 1 ? remaining : base;
    out.push(value);
    remaining -= value;
  }
  return out;
}

/**
 * What a foundering crew loses to the sea. Half the CARGO (never the safe
 * pocket), capped — so sinking the leader is a real payday for the crew that
 * did it without being a one-shot deletion of somebody's whole match.
 */
export function spillFromCargo(cargoGold: number): number {
  if (!(cargoGold > 0)) return 0;
  return Math.min(CARGO.SPILL_MAX, Math.floor(cargoGold * CARGO.SPILL_FRACTION));
}
