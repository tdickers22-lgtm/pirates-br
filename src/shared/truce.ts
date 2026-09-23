// THE TRUCE (b1.6e, mechanicshud-01 + vm:mechanicshud:1).
//
// The onboarding card promises "No crew may fire for the first 2:30". Until
// this module the promise held for BOTS only (BotCrew/Blackboard read
// BOT_EARLY_PEACE_SECONDS); the server let a human shoot, cannon or keg anyone
// from the horn, and two bot sloops leaving neighbouring berths at ~4 m/s stove
// each other in with ram holes and both foundered before the truce was over,
// one crew banking a 400 g sink bounty nobody fought for.
//
// One predicate family, read by every path that can hurt another crew:
//   - WeaponSystem.tryFire: ship cannons refuse to fire (reason 'truce').
//   - Match.findClosestFirearmHit: small arms pass through another crew's
//     pirate (the shooter gets one 'truce' refusal); PvE targets still take hits.
//   - Match.explodeKeg: a blast opens no hole in another crew's hull and hurts
//     no pirate of another crew.
//   - PhysicsSystem.resolveShipShipCollision: contact under TRUCE_CONTACT_SPEED
//     opens no hole; no contact at any speed banks ram credit (no ram bounty).
//   - Match's sink credit: no SHIP_SINK_GOLD inside the truce.
// Server-only authority; the client reads TRUCE_SECONDS for the HUD chip.

import { BOT_EARLY_PEACE_SECONDS } from './constants/index.js';
import { isSameCrew, type CrewMember } from './crew.js';

/** Sim seconds from the horn during which no crew can harm another. Same clock
 *  and same env mutation knob as the bots' early peace, so the two never drift. */
export const TRUCE_SECONDS = BOT_EARLY_PEACE_SECONDS;

/** Closing speed (m/s) under which a ship-ship contact inside the truce is a
 *  bump: the hulls are pushed apart, no plank springs. Berth traffic measured
 *  3.8-4.5 m/s; a deliberate full-sail ram is 7+ m/s. */
export const TRUCE_CONTACT_SPEED = 6;

export function inTruce(t: number): boolean {
  return t < TRUCE_SECONDS;
}

/** Two DIFFERENT crews, by the same rule the win count and the crewmate
 *  small-arms pass-through use (crewId, else shared hull). A bot crew with no
 *  crewId is still its hull's crew. */
export function differentCrews(a: CrewMember, b: CrewMember): boolean {
  return a.id !== b.id && !isSameCrew(a, b);
}

/** Truce shields `target` from `attacker` (guns, cannons, kegs). */
export function truceShieldsPlayer(t: number, attacker: CrewMember | null | undefined, target: CrewMember): boolean {
  return inTruce(t) && !!attacker && differentCrews(attacker, target);
}

/** Truce shields a hull from a keg planted by `planter`: any hull that is not
 *  the planter's own. A crew can still blow up its own ship. */
export function truceShieldsHullFromKeg(t: number, planter: { shipId: string | null } | null | undefined, shipId: string): boolean {
  return inTruce(t) && (!planter || planter.shipId !== shipId);
}

/** Ship cannons stay cold for everyone during the truce. */
export function truceRefusesCannon(t: number): boolean {
  return inTruce(t);
}

/** A ship-ship contact inside the truce under TRUCE_CONTACT_SPEED opens no hole. */
export function truceSparesContact(t: number, closingSpeed: number): boolean {
  return inTruce(t) && closingSpeed < TRUCE_CONTACT_SPEED;
}

/** No ram bounty and no sink gold inside the truce. */
export function truceBlocksBounty(t: number): boolean {
  return inTruce(t);
}
