import type { Crew, GameState, Player, Ship } from './types/index.js';

/**
 * CREWS — read by the server sim (Match, PhysicsSystem, BotSystem, Trading) and
 * by the client (crew strip, nameplates, friendly-fire read), so the rule lives
 * here once instead of being re-derived on both sides of the wire.
 *
 * A crew is the unit the game is actually played in: a party of N shares ONE
 * hull, and win/board/elimination/credit/bounty all key on the crew, not on the
 * hull's ownerId. `crewId` outlives the hull deliberately — two crewmates
 * swimming from a sunk ship are still ONE crew, which is exactly the case the
 * old `p.shipId ?? p.id` accounting got wrong (netcode-12: the match could never
 * end because two survivors of one crew counted as two crews).
 */

/** Anyone the crew rules apply to: players, hulls, or a bare id pair. */
export interface CrewMember {
  id: string;
  crewId?: string | null;
  shipId?: string | null;
}

/**
 * Two bodies belong to the same crew. `crewId` is the truth; the shipId
 * fallback keeps every pre-crew caller (and any hand-built test fixture that
 * only shares a hull) reading the same answer it always did.
 */
export function isSameCrew(a: CrewMember | null | undefined, b: CrewMember | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.crewId && b.crewId) return a.crewId === b.crewId;
  return !!a.shipId && a.shipId === b.shipId;
}

/** The crew record for an id — a crewId, a playerId or a shipId. */
export function crewOf(state: Pick<GameState, 'crews'>, id: string | null | undefined): Crew | null {
  if (!id) return null;
  const crews = state.crews ?? [];
  return crews.find((crew) => (
    crew.id === id || crew.shipId === id || crew.memberIds.includes(id)
  )) ?? null;
}

/** Every player on a crew's books, alive or not (eliminated members included —
 *  the caller decides what counts). */
export function crewMembers(state: Pick<GameState, 'players' | 'crews'>, crewId: string | null | undefined): Player[] {
  if (!crewId) return [];
  return state.players.filter((player) => player.crewId === crewId);
}

/** The crew id of a hull, falling back to her own id so a crewless hull (a bot
 *  before BOTCREW-01, a derelict) still counts as exactly one crew. */
export function shipCrewId(ship: Pick<Ship, 'id' | 'crewId'>): string {
  return ship.crewId ?? ship.id;
}

/** The crew id a player counts under for win/elimination accounting. A pirate
 *  who lost his hull keeps his crew: he is still fighting for it in the water. */
export function playerCrewId(player: Pick<Player, 'id' | 'crewId' | 'shipId'>): string {
  return player.crewId ?? player.shipId ?? player.id;
}

/**
 * HOLD YOUR FIRE. Small arms and blades do nothing to a crewmate — a crew
 * fighting in the same 8 m of deck cannot be asked to check its lines of fire,
 * and creditPlayerKill used to pay gold for shooting one (netcode-12).
 *
 * The ship's own violence still hurts: cannon, kegs, fire, ramming and the sea
 * are hazards the whole crew shares, and blunting them would delete the tension
 * that makes a powder keg on your own deck frightening.
 */
export function smallArmsHitsCrewmate(
  attacker: CrewMember | null | undefined,
  target: CrewMember | null | undefined,
): boolean {
  if (!attacker || !target || attacker.id === target.id) return false;
  return isSameCrew(attacker, target);
}
