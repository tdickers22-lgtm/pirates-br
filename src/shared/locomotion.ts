import type { Island, ShipType, WildlifeAnimal } from './types/index.js';
import { getCrowNestStandingY, getIslandSurfaceY, isPointInsideIslandFootprint } from './utils/index.js';
import { getShipFloorYAt } from './interactions.js';
import { resolvePropCollision } from './props.js';
import { PLAYER, SHIP_STATS, WILDLIFE } from './constants/index.js';

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
  out: WalkerStep = { x: fromX, z: fromZ, groundY: fromGroundY, blocked: false, reason: 'none' },
): WalkerStep {
  const refuse = (reason: WalkerBlockReason): WalkerStep => {
    out.x = fromX;
    out.z = fromZ;
    out.groundY = fromGroundY;
    out.blocked = true;
    out.reason = reason;
    return out;
  };

  // Cheapest test first, and each one exits: the prop sweep (the only test that
  // walks a list) is reached only by a step that is otherwise legal.
  if (!isPointInsideIslandFootprint(island, toX, toZ, limits.footprintPad)) return refuse('footprint');

  const groundY = getIslandSurfaceY(island, toX, toZ);
  if (groundY < limits.minGroundY) return refuse('water');

  const run = Math.hypot(toX - fromX, toZ - fromZ);
  if (run > 1e-4 && Math.abs(groundY - fromGroundY) / run > limits.maxSlope) return refuse('slope');

  if (limits.cavePad > 0 && nearCaveFootprint(island, toX, toZ, limits.cavePad)) return refuse('cave');

  if (limits.radius > 0) {
    const pushed = resolvePropCollision(propProbe(toX, groundY, toZ), limits.radius, island);
    if (pushed.pushed) {
      // Take the PUSHED-OUT point rather than refusing outright: a walker that
      // starts inside a collider (a spawn the registry never checked) would
      // otherwise find every direction illegal and be trapped there forever.
      // Only if the shove lands somewhere legal, mind.
      const pushedGround = getIslandSurfaceY(island, pushed.x, pushed.z);
      // …and only if the shove actually got it CLEAR. A compound prop (a fort
      // wall, a crag's overlapping blades) can shove a walker out of one mass
      // and into its neighbour, and the relaxation inside resolvePropCollision
      // is capped; accepting that blind would seat the animal in the stone.
      const clear = !resolvePropCollision(propProbe(pushed.x, pushedGround, pushed.z), limits.radius, island).pushed;
      if (
        clear
        && pushedGround >= limits.minGroundY
        && isPointInsideIslandFootprint(island, pushed.x, pushed.z, limits.footprintPad)
      ) {
        out.x = pushed.x;
        out.z = pushed.z;
        out.groundY = pushedGround;
        out.blocked = true;
        out.reason = 'prop';
        return out;
      }
      return refuse('prop');
    }
  }

  out.x = toX;
  out.z = toZ;
  out.groundY = groundY;
  out.blocked = false;
  out.reason = 'none';
  return out;
}

/** One scratch Vec3 for the prop sweep — resolvePropCollision only reads it. */
const PROP_PROBE = { x: 0, y: 0, z: 0 };
function propProbe(x: number, y: number, z: number) {
  PROP_PROBE.x = x;
  PROP_PROBE.y = y;
  PROP_PROBE.z = z;
  return PROP_PROBE;
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

// ─────────────────────────────────────────────────────────────────────────────
// PRED-01 (netcode-35): ONE pirate step, run by the server AND by the client's
// prediction.
//
// Until this existed the pirate's per-tick movement integration lived inside
// `Match.applyInput` and nowhere else, so the client could not simulate its own
// body even in principle: W, A, S, D and SPACE all carried the full round trip
// and the drawn body was a server position plus a hand-tuned ≤0.41 m "input
// lead" nudge that oscillated whenever a snapshot landed late.
//
// The rule for this block is transcription, not improvement: it reproduces the
// server's movement arithmetic operation-for-operation so `stepPirate` and the
// old inline code are bit-identical (scripts/test-prediction.mjs holds a copy of
// the pre-extraction block and compares a 600-tick tape term by term). Anything
// that reads or writes match state — one-shots, stations, weapons, sails —
// stayed in Match; only the integration moved.
//
// PURE: no Math.random, no Date, no clock, no allocation per call.
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a Player this step reads and writes. `Player` satisfies it. */
export interface PirateMotionState {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  crouching: boolean;
  state: string;
  atCrowNest: boolean;
  onShipId: string | null;
}

/** The part of PlayerInput this step reads. `PlayerInput` satisfies it. */
export interface PirateMoveInput {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  jumpPressed?: boolean;
  sailLower?: boolean;
  yaw: number;
  pitch: number;
}

export interface PirateStepEnv {
  /** The hull the pirate is standing on, already validated (alive, onShipId
   *  matches). Null ashore, in the water or in free flight. */
  ship: PirateStepShip | null;
  /** Islands to test footing against when ashore. */
  islands: readonly Island[];
  /** True at a station that pins the body (the helm): SPACE does nothing. */
  jumpBlocked: boolean;
}

/** The hull fields the footing test needs — `Ship` satisfies it. */
export type PirateStepShip = Parameters<typeof getShipFloorYAt>[1] & {
  id: string;
  type: ShipType;
  position: { x: number; y: number; z: number };
};

/**
 * Is the body standing on something it can push off?
 *
 * Shared because the jump is the one movement one-shot the client must predict:
 * a jump onto a gangway or a boarding ladder that only starts when the server's
 * snapshot says so is a guess, and it is the input players notice first.
 */
export function isPirateGrounded(k: PirateMotionState, env: PirateStepEnv): boolean {
  const verticalReady = k.velocity.y <= 0.2;
  if (!verticalReady) return false;
  const ship = env.ship;
  if (ship && k.onShipId === ship.id && k.atCrowNest) {
    // A lookout stands on the nest basket, not the deck — getShipFloorYAt would
    // report the deck ~15 m below and read the lookout as airborne, so Space
    // did nothing up there. Ground against the basket floor instead.
    const nestFloorY = ship.position.y + getCrowNestStandingY(SHIP_STATS[ship.type]);
    return Math.abs(k.position.y - nestFloorY) < 0.24;
  }
  if (ship && k.onShipId === ship.id) {
    const floorY = getShipFloorYAt(k.position, ship);
    return Math.abs(k.position.y - floorY) < 0.24;
  }
  for (const island of env.islands) {
    if (isPointInsideIslandFootprint(island, k.position.x, k.position.z, 0)) {
      if (Math.abs(k.position.y - getIslandSurfaceY(island, k.position.x, k.position.z)) < 0.24) return true;
    }
    if (island.dock) {
      const dx = k.position.x - island.dock.position.x;
      const dz = k.position.z - island.dock.position.z;
      const cos = Math.cos(island.dock.rotation);
      const sin = Math.sin(island.dock.rotation);
      const localX = dx * cos - dz * sin;
      const localZ = dx * sin + dz * cos;
      if (Math.abs(localX) <= island.dock.width * 0.5 + 0.45 && Math.abs(localZ) <= island.dock.length * 0.5 + 0.45) {
        if (Math.abs(k.position.y - (island.dock.position.y + 0.14)) < 0.22) return true;
      }
    }
  }
  return false;
}

/**
 * Integrate ONE tick of on-foot / swimming movement.
 *
 * Vertical motion ashore (gravity, the ground snap, the pushouts) belongs to
 * PhysicsSystem and is NOT here: this is exactly the block Match.applyInput used
 * to run inline, so a client that calls it gets the same answer the server will
 * send back one round trip later.
 */
export function stepPirate(
  k: PirateMotionState,
  input: PirateMoveInput,
  dt: number,
  env: PirateStepEnv,
): void {
  const yaw = input.yaw;
  const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  if (k.state === 'swimming') {
    const pitch = input.pitch;
    const forwardScale = Math.cos(pitch);
    const forwardX = Math.sin(yaw) * forwardScale;
    const forwardY = Math.sin(pitch);
    const forwardZ = Math.cos(yaw) * forwardScale;
    const rightX = -Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    const forwardIntent = (input.forward ? 1 : 0) - (input.back ? 0.58 : 0);
    const strafeIntent = (input.right ? 0.72 : 0) - (input.left ? 0.72 : 0);
    let wishX = 0;
    let wishY = 0;
    let wishZ = 0;
    if (forwardIntent !== 0) {
      const forwardScaleY = forwardIntent > 0 ? 1.18 : 0.6;
      wishX += forwardX * forwardIntent;
      wishY += forwardY * forwardScaleY * Math.abs(forwardIntent);
      wishZ += forwardZ * forwardIntent;
    }
    if (strafeIntent !== 0) {
      wishX += rightX * strafeIntent;
      wishZ += rightZ * strafeIntent;
    }
    if (input.jump) wishY += 0.95;
    if (input.sailLower) wishY -= 0.95;
    // While plunging from a fall/cannon launch, don't let upward swim input
    // steal the plunge momentum. The player can still dive deeper or steer
    // horizontally; once the plunge slows, jump becomes a swim-up again.
    const plunging = k.velocity.y < -1.5;
    if (plunging && wishY > 0) wishY = 0;

    const swimLen = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
    if (swimLen > 0.001) {
      const swimSpeed = PLAYER.SWIM_SPEED * (input.forward ? 1.06 : 1);
      const targetVx = (wishX / swimLen) * swimSpeed;
      const targetVz = (wishZ / swimLen) * swimSpeed;
      const targetVy = (wishY / swimLen) * PLAYER.SWIM_SPEED * 0.92;
      // Blend toward swim input rather than replacing velocity outright. This
      // preserves cannon-launch / cliff-jump plunge momentum even if the player
      // is holding space when they hit the water — they slow first, then rise.
      const horizBlend = 1 - Math.exp(-dt * 9);   // ~0.11 s response on X/Z
      const vertBlend  = 1 - Math.exp(-dt * 3.5); // ~0.29 s response on Y
      k.velocity.x += (targetVx - k.velocity.x) * horizBlend;
      k.velocity.z += (targetVz - k.velocity.z) * horizBlend;
      k.velocity.y += (targetVy - k.velocity.y) * vertBlend;
      k.position.x += k.velocity.x * dt;
      k.position.z += k.velocity.z * dt;
    }
    // No-input case is intentionally left to PhysicsSystem so cannon-launch and
    // cliff-jump plunges keep their downward momentum. Killing velocity here at
    // 0.82 per tick = 0.82^60/sec destroyed plunges in a single frame.
    return;
  }

  const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
  const nx = moveX / len, nz = moveZ / len;
  const speed = PLAYER.MOVE_SPEED * (k.crouching ? 0.55 : 1);

  if (moveX !== 0 || moveZ !== 0) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    k.velocity.x = (sinY * nz - cosY * nx) * speed;
    k.velocity.z = (cosY * nz + sinY * nx) * speed;
    k.position.x += k.velocity.x * dt;
    k.position.z += k.velocity.z * dt;
  } else {
    k.velocity.x = 0;
    k.velocity.z = 0;
  }

  // Jump
  if (input.jumpPressed && !env.jumpBlocked && isPirateGrounded(k, env)) {
    k.velocity.y = PLAYER.JUMP_FORCE;
  }
}
