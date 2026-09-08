import type { Island, WildlifeAnimal } from './types/index.js';
import { getIslandSurfaceY, isPointInsideIslandFootprint } from './utils/index.js';
import { resolvePropCollision } from './props.js';
import { WILDLIFE } from './constants/index.js';

/**
 * How a thing that WALKS is allowed to move over an island.
 *
 * Extracted for WILD-01 (slice c) and extended by PRED-01 later: the rule that
 * "you may not walk into the sea, up a cliff, through a boulder or into a cave
 * mouth" was written three times in the codebase — once for the player (in
 * PhysicsSystem), once for spawn placement (MapGenerator), and NOT AT ALL for
 * wildlife, which is why pigs swam through archipelago saddles and chickens
 * stood on cave floors.
 *
 * Everything here is PURE (no Math.random, no Date, no clock): server and
 * client prediction must be able to call it and agree (PLAN section 5,
 * determinism note on this lane).
 */

export type WalkerBlockReason = 'none' | 'footprint' | 'water' | 'slope' | 'cave' | 'prop';

export interface WalkerLimits {
  /** Body radius used against prop colliders, metres. */
  radius: number;
  /** Inset handed to isPointInsideIslandFootprint (negative = allowed outside). */
  footprintPad: number;
  /** Ground below this height is the sea, a beach apron or an archipelago
   *  saddle: a land walker refuses it. */
  minGroundY: number;
  /** Refuse a step whose |rise| / |run| exceeds this (0.7 ≈ 35°). */
  maxSlope: number;
  /** Refuse a step within this distance of a cave mouth footprint. */
  cavePad: number;
}

export interface WalkerStep {
  x: number;
  z: number;
  /** Ground height at the RESULT (from, if the step was refused). */
  groundY: number;
  blocked: boolean;
  reason: WalkerBlockReason;
}

/**
 * Is (x,z) inside a cave mouth's carved footprint (+pad)?
 *
 * Mirrors MapGenerator's private `nearCave`, which spawn placement has always
 * used; the walker needs the same answer, and a shared copy is the only way the
 * two can never drift.
 */
export function nearCaveFootprint(island: Island, x: number, z: number, pad: number): boolean {
  const caves = island.caves;
  if (!caves || caves.length === 0) return false;
  for (const cave of caves) {
    const dx = x - cave.position.x;
    const dz = z - cave.position.z;
    const cosR = Math.cos(cave.rotation);
    const sinR = Math.sin(cave.rotation);
    const lx = dx * cosR - dz * sinR;
    const lz = dx * sinR + dz * cosR;
    if (Math.abs(lx) < cave.interiorRadius + pad && lz < 1.0 + pad && lz > -cave.length - pad) return true;
  }
  return false;
}

/**
 * Accept or refuse one walking step. On refusal the walker stays where it was
 * (the caller turns it around); on acceptance the result carries the ground
 * height it should be seated on, so the caller does not sample the field twice.
 */
export function resolveWalkerAgainstIsland(
  island: Island,
  fromX: number,
  fromZ: number,
  fromGroundY: number,
  toX: number,
  toZ: number,
  limits: WalkerLimits,
): WalkerStep {
  const refuse = (reason: WalkerBlockReason): WalkerStep =>
    ({ x: fromX, z: fromZ, groundY: fromGroundY, blocked: true, reason });

  if (!isPointInsideIslandFootprint(island, toX, toZ, limits.footprintPad)) return refuse('footprint');

  const groundY = getIslandSurfaceY(island, toX, toZ);
  if (groundY < limits.minGroundY) return refuse('water');

  const run = Math.hypot(toX - fromX, toZ - fromZ);
  if (run > 1e-4 && Math.abs(groundY - fromGroundY) / run > limits.maxSlope) return refuse('slope');

  if (limits.cavePad > 0 && nearCaveFootprint(island, toX, toZ, limits.cavePad)) return refuse('cave');

  if (limits.radius > 0) {
    const pushed = resolvePropCollision({ x: toX, y: groundY, z: toZ }, limits.radius, island);
    if (pushed.pushed) return refuse('prop');
  }

  return { x: toX, z: toZ, groundY, blocked: false, reason: 'none' };
}

/**
 * Push a walker (a pirate) out of any animal it is standing inside.
 *
 * A pig is a 0.62 m barrel of muscle; walking THROUGH it is the second reason
 * (after nothing fleeing) animals read as decals sliding over the ground
 * (islandworld-32). Pure and allocation-light: one object out, nothing per
 * animal, and a squared-distance broad phase so a pirate nowhere near the herd
 * pays four multiplies per animal.
 */
export function resolveWalkerAgainstWildlife(
  x: number,
  z: number,
  radius: number,
  wildlife: readonly WildlifeAnimal[] | undefined,
  out: { x: number; z: number; pushed: boolean } = { x, z, pushed: false },
): { x: number; z: number; pushed: boolean } {
  out.x = x;
  out.z = z;
  out.pushed = false;
  if (!wildlife || wildlife.length === 0) return out;
  for (const animal of wildlife) {
    // Gulls are in the air and carcasses are on the ground: neither blocks.
    if (animal.type === 'gull' || animal.dead) continue;
    const r = WILDLIFE.HIT_RADIUS[animal.type] + radius;
    const dx = out.x - animal.position.x;
    const dz = out.z - animal.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    const d = Math.sqrt(d2);
    // Dead centre: shove along +x rather than dividing by zero.
    const ux = d > 1e-4 ? dx / d : 1;
    const uz = d > 1e-4 ? dz / d : 0;
    out.x = animal.position.x + ux * r;
    out.z = animal.position.z + uz * r;
    out.pushed = true;
  }
  return out;
}
