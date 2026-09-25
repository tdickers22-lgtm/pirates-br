/**
 * THE SoT BUCKET RULES (b2.2d, holes-05, D15), shared by the server bail block
 * (Match.ts), the bots' bail cycle (Match.updateBotFlooding) and the client
 * prompt (InteractionPrompts), so all three mean the same thing by "you can
 * scoop here" and "that throw cleared the rail".
 *
 * - Scoop: only standing IN the hold water (free surface >= 0.10 m over the
 *   feet) or looking at it within 2.2 m. From the weather deck the ray has to
 *   pass down through the companionway mouth; the deck planks block it.
 * - Heave: the bucket lands 1.5 m out along the look direction. Past the rail
 *   it is gone; inside the hull outline (on deck, or anywhere from the hold)
 *   it runs back down to the bilge after 1.2 s with a splash.
 *
 * Pure and deterministic: no rng, no wall clock.
 */
import type { Ship, ShipType, Vec3 } from '../types/index.js';
import { PLAYER, SHIP, SHIP_STATS } from '../constants/index.js';
import { getShipCompanionwayConfig, getShipDeckWalkHalfWidth } from '../utils/index.js';
import { isInsideShipHoldFootprint, isStandingInShipHold, toShipLocal3 } from '../interactions.js';
import { fillToLocalY } from './hullVolume.js';

/** Hold water that counts as "standing in it": this much over the feet. */
export const BAIL_WADE_DEPTH = 0.10;
/** Looking at the hold water: eye-to-surface ray length. */
export const BAIL_LOOK_REACH = 2.2;
/** A bucket thrown inside the hull outline runs back into the bilge after this. */
export const BAIL_RETURN_DELAY = 1.2;
/** Horizontal carry of a heave from the feet, along the look direction. */
export const BAIL_THROW_REACH = 1.5;
/** The landing point must clear the walkable deck edge by this (the bulwark). */
export const BAIL_RAIL_CLEAR = 0.35;

export type BailLanding = 'overboard' | 'onDeck' | 'inHold';

/** A pirate's bail pose in HULL-LOCAL terms. yawRel = look yaw minus ship yaw. */
export interface BailPose {
  feet: Vec3;
  inHold: boolean;
  yawRel: number;
  pitch: number;
}

type ShipPose = Pick<Ship, 'position' | 'rotation' | 'type' | 'pitch' | 'roll'>;

export function bailPoseOf(position: Vec3, yaw: number, pitch: number, ship: ShipPose): BailPose {
  const feet = toShipLocal3(position, ship);
  return { feet, inHold: isStandingInShipHold(position, ship, feet), yawRel: yaw - ship.rotation, pitch };
}

/** Hull-local height of the hold-water free surface (level hull), or null if dry. */
export function holdWaterSurfaceY(type: ShipType, fill: number): number | null {
  if (!(fill > 0.001)) return null;
  return fillToLocalY(type, fill);
}

export function canScoop(type: ShipType, fill: number, pose: BailPose): boolean {
  const surfY = holdWaterSurfaceY(type, fill);
  if (surfY == null) return false;
  const stats = SHIP_STATS[type];
  if (pose.inHold && surfY - pose.feet.y >= BAIL_WADE_DEPTH) return true;
  // Looking at it: eye ray against the water plane.
  const eyeY = pose.feet.y + PLAYER.EYE_Y;
  const dirY = Math.sin(pose.pitch);
  if (dirY >= -1e-3 || eyeY <= surfY) return false;
  const cp = Math.cos(pose.pitch);
  const dx = Math.sin(pose.yawRel) * cp;
  const dz = Math.cos(pose.yawRel) * cp;
  const t = (eyeY - surfY) / -dirY;
  if (t > BAIL_LOOK_REACH) return false;
  const hit = { x: pose.feet.x + dx * t, y: surfY, z: pose.feet.z + dz * t };
  if (!isInsideShipHoldFootprint(hit, stats)) return false;
  // From above the weather deck the ray must drop through the hatch mouth.
  const deckY = stats.height;
  if (eyeY > deckY) {
    const td = (eyeY - deckY) / -dirY;
    const px = pose.feet.x + dx * td;
    const pz = pose.feet.z + dz * td;
    const stair = getShipCompanionwayConfig(stats);
    const inMouth = Math.abs(px - stair.cx) <= stair.stairHalfWidth
      && pz >= Math.min(stair.stairBackZ, stair.stairFrontZ)
      && pz <= Math.max(stair.stairBackZ, stair.stairFrontZ);
    if (!inMouth) return false;
  }
  return true;
}

/** Where a heave lands, hull-local, and whether it cleared the rail. */
export function throwLanding(type: ShipType, pose: BailPose): { landing: BailLanding; x: number; z: number } {
  const stats = SHIP_STATS[type];
  const x = pose.feet.x + Math.sin(pose.yawRel) * BAIL_THROW_REACH;
  const z = pose.feet.z + Math.cos(pose.yawRel) * BAIL_THROW_REACH;
  // The hold is walled by the hull: nothing thrown down there leaves her.
  if (pose.inHold) return { landing: 'inHold', x, z };
  const outside = Math.abs(z) > stats.length * 0.5 + BAIL_RAIL_CLEAR
    || Math.abs(x) > getShipDeckWalkHalfWidth(stats, z, BAIL_RAIL_CLEAR);
  return { landing: outside ? 'overboard' : 'onDeck', x, z };
}

/** Deck-local y of the weather deck walking surface (for splash placement). */
export function bailDeckLocalY(type: ShipType): number {
  return SHIP_STATS[type].height + SHIP.DECK_STAND_OFFSET;
}
