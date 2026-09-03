import { FLOODING, PLAYER, SHIP, SHIP_STATS } from './constants/index.js';
import type { Island, IslandDock, IslandNpc, Player, Ship, ShipHole, ShipHoleTier, ShipKeg, UpgradeStation, Vec3 } from './types/index.js';
import {
  angleWrap, clamp, dist2D, getSailRopeStationLocals, getBraceStationLocals, getCrowNestLadderInteractionBounds, getSailStationLocal, getShipCompanionwayConfig, getShipDeckRaiseAt, getShipDeckWalkHalfWidth, getShipDeckY, getShipHoldFloorY, isInsideSwimHullFootprint, getSwimHullVerticalT, toDockLocalPoint, dockLocalToWorld } from './utils/index.js';

type ShipStats = (typeof SHIP_STATS)[keyof typeof SHIP_STATS];
type ShipLocalPoint = { x: number; z: number };
type ShipLike = Pick<Ship, 'position' | 'rotation' | 'type' | 'id'>;
type PlayerLike = Pick<Player, 'position' | 'onShipId'>;

/** The gold hoarder's table is wide — reach him from anywhere around it. */
const GOLD_HOARDER_REACH_BONUS = 0.8;
/** Swim out at least this far before the mermaid will carry you home. */
const MERMAID_RETURN_MIN_DISTANCE = 45;

export function toShipLocalPoint(position: { x: number; z: number }, ship: Pick<Ship, 'position' | 'rotation'>): ShipLocalPoint {
  const dx = position.x - ship.position.x;
  const dz = position.z - ship.position.z;
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos,
  };
}

export function toShipWorldPoint(local: ShipLocalPoint, ship: Pick<Ship, 'position' | 'rotation'>): ShipLocalPoint {
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return {
    x: ship.position.x + local.x * cos + local.z * sin,
    z: ship.position.z + local.z * cos - local.x * sin,
  };
}

// ── Hull breaches ────────────────────────────────────────────────────────────
// Holes are POINT ENTITIES in the hull-local frame (see ShipHole). These two
// helpers are the SHARED truth for "how many leaks are open" and "which hole can
// this pirate plank" — the server validates the repair with findRepairableHole
// and the client prompt calls the exact same function, so the [X] prompt can
// never offer a patch the server then refuses.

export function countOpenHoles(ship: Pick<Ship, 'holes'>): number {
  let n = 0;
  for (const hole of ship.holes ?? []) if (!hole.patched) n += 1;
  return n;
}

/**
 * Height class of a breach at hull-local `localY`. SHARED so the server stamp
 * (placeHole) and any client read agree byte for byte: LOW breaches flood a
 * level hull, MID ones only once she has settled into her own bilge, HIGH ones
 * are topside and stay dry until she lists or the sea gets up.
 */
export function getShipHoleTier(localY: number, stats: Pick<ShipStats, 'height'>): ShipHoleTier {
  if (localY < FLOODING.HOLE_TIER_LOW_Y) return 0;
  if (localY < stats.height * FLOODING.HOLE_TIER_HIGH_F) return 1;
  return 2;
}

/**
 * The unpatched hole this pirate is standing at, or null. Planar hull-local
 * reach only (HOLE_REPAIR_REACH): a breach is worked from the rail/deck
 * directly above it, so height never gates the swing. Nearest hole wins.
 */
export function findRepairableHole(
  position: { x: number; z: number },
  ship: Pick<Ship, 'position' | 'rotation' | 'holes'>,
): ShipHole | null {
  const local = toShipLocalPoint(position, ship);
  const reachSq = FLOODING.HOLE_REPAIR_REACH * FLOODING.HOLE_REPAIR_REACH;
  let best: ShipHole | null = null;
  let bestSq = Infinity;
  for (const hole of ship.holes ?? []) {
    if (hole.patched) continue;
    const dx = hole.x - local.x;
    const dz = hole.z - local.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= reachSq && d2 < bestSq) {
      bestSq = d2;
      best = hole;
    }
  }
  return best;
}

export function getAnchorControlLocal(stats: Pick<ShipStats, 'length'>): ShipLocalPoint {
  return {
    x: 0,
    z: stats.length * 0.42,
  };
}

export function getHelmControlLocal(stats: Pick<ShipStats, 'length'>): ShipLocalPoint {
  return {
    x: 0,
    z: -stats.length * SHIP.HELM_LOCAL_Z_F,
  };
}

export function getSailControlLocal(stats: Pick<ShipStats, 'length' | 'mastCount' | 'width'>): ShipLocalPoint {
  return getSailStationLocal(stats);
}

/** Half-width of the walkable CARGO HOLD at a hull-local z (tapers at the ends). */
export function getShipHoldHalfWidth(stats: Pick<ShipStats, 'width' | 'length'>, localZ: number, margin = 0): number {
  const normalized = clamp(Math.abs(localZ) / Math.max(0.001, stats.length * 0.34), 0, 1);
  const endTaper = normalized > 0.58 ? (normalized - 0.58) / 0.42 : 0;
  return stats.width * (0.38 - endTaper * 0.11) + margin;
}

export function isInsideShipHoldFootprint(local: ShipLocalPoint, stats: Pick<ShipStats, 'width' | 'length'>, margin = 0): boolean {
  if (Math.abs(local.z) > stats.length * 0.34 + margin) return false;
  return Math.abs(local.x) <= getShipHoldHalfWidth(stats, local.z, margin);
}

/**
 * CANONICAL standing height aboard a hull: hold floor, companionway ramp,
 * weather deck, or the raised quarterdeck dais — whichever the point is over.
 * Physics resolves the walker against this and Match reads it for held-interact
 * context, so the two can never disagree about where the floor is.
 */
export function getShipFloorYAt(
  position: Vec3,
  ship: Pick<Ship, 'position' | 'rotation' | 'type'>,
  providedLocal?: ShipLocalPoint,
): number {
  const stats = SHIP_STATS[ship.type];
  const deckY = getShipDeckY(ship.position.y, stats);
  const holdFloor = getShipHoldFloorY(ship.position.y);
  const local = providedLocal ?? toShipLocalPoint(position, ship);
  const stair = getShipCompanionwayConfig(stats);
  if (
    Math.abs(local.x - stair.cx) <= stair.stairHalfWidth
    && local.z <= stair.stairFrontZ
    && local.z >= stair.stairBackZ
  ) {
    // The whole stairwell footprint is open air — the floor there is always the
    // stair ramp, never a deck-level lid. Walking onto the hole from ANY side
    // drops you onto the steps; the coaming colliders around the sides/back are
    // what stop accidental entry, not a phantom floor.
    const descent = clamp((stair.stairFrontZ - local.z) / Math.max(0.001, stair.stairFrontZ - stair.stairBackZ), 0, 1);
    return deckY + (holdFloor - deckY) * descent;
  }
  if (isInsideShipHoldFootprint(local, stats, 0.08) && position.y < deckY - 0.25) {
    return holdFloor;
  }
  // Stern quarterdeck dais — a genuinely raised helm platform (ramps up over its
  // front step). 0 everywhere off the dais, so the rest of the deck is unchanged.
  return deckY + getShipDeckRaiseAt(local, stats);
}

/** Which rail a gun sits on: +1 starboard (first half of the indices), −1 port. */
export function getCannonSide(stats: Pick<ShipStats, 'cannonCount'>, cannonIndex: number): 1 | -1 {
  return cannonIndex < Math.max(1, stats.cannonCount / 2) ? 1 : -1;
}

/** World yaw this cannon's broadside faces — bot gunnery and the aim clamp
 *  share it so "which rail can hit the target" is a single truth. */
export function getCannonBroadsideYaw(ship: Pick<Ship, 'rotation' | 'type'>, cannonIndex: number): number {
  return ship.rotation + getCannonSide(SHIP_STATS[ship.type], cannonIndex) * Math.PI * 0.5;
}

/**
 * CANONICAL cannon aim: a gun swings inside CANNON_YAW_ARC of its own broadside
 * and elevates between CANNON_PITCH_MIN/MAX. Server authority (Match, the firing
 * solution in WeaponSystem) and the client's viewmodel prediction all call this,
 * so the barrel a gunner sees is the barrel the shot leaves.
 */
export function getConstrainedCannonAim(
  ship: Pick<Ship, 'rotation' | 'type'>,
  cannonIndex: number,
  yaw: number,
  pitch: number,
): { yaw: number; pitch: number } {
  const broadsideYaw = getCannonBroadsideYaw(ship, cannonIndex);
  return {
    yaw: broadsideYaw + clamp(angleWrap(yaw - broadsideYaw), -SHIP.CANNON_YAW_ARC, SHIP.CANNON_YAW_ARC),
    pitch: clamp(pitch, SHIP.CANNON_PITCH_MIN, SHIP.CANNON_PITCH_MAX),
  };
}

export function getCannonDeckLocalPosition(stats: Pick<ShipStats, 'cannonCount' | 'length' | 'width'>, cannonIndex: number): ShipLocalPoint {
  const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
  const side = cannonIndex < cannonsPerSide ? 0 : 1;
  const slotWithinSide = cannonIndex % cannonsPerSide;
  const cannonSpacing = cannonsPerSide <= 1
    ? 0
    : stats.length * 0.5 / (cannonsPerSide - 1);
  // Single gun per side sits AMIDSHIPS (clear of the mast band, the anchor bow
  // zone and the stairwell); rows on the bigger hulls keep the classic spread.
  const z = cannonsPerSide <= 1 ? 0 : stats.length * 0.2 - slotWithinSide * cannonSpacing;
  // x follows the bulwark TAPER at this z — the naive W/2−0.65 fell outside the
  // walkable deck near bow/stern on the brig and galleon, so mounting those guns
  // snapped the player off the deck ("using the cannon dropped me in the water").
  const x = (side === 0 ? 1 : -1)
    * Math.min(stats.width * 0.5 - 0.65, getShipDeckWalkHalfWidth(stats, z, -0.45));
  // Stand point = the visual gun position (ShipRenderer places carriages from
  // this same function) — keeping it clear of the companionway is the HATCH's
  // job (getShipCompanionwayConfig stays narrow and centred).
  return { x, z };
}

export function findNearbyCannonIndex(player: PlayerLike, ship: ShipLike): number | null {
  if (player.onShipId !== ship.id) return null;

  const stats = SHIP_STATS[ship.type];
  const local = toShipLocalPoint(player.position, ship);
  let best: { index: number; score: number } | null = null;
  // Tight prompt zones: wide ones (2.05 × L·0.09) tiled the whole rail on the
  // galleon and bled into the halyard/brace stations — the source of "I don't
  // know what I'm pressing X for". Capped below half the row spacing so
  // adjacent gun zones can never merge.
  const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
  const rowSpacing = cannonsPerSide <= 1 ? Infinity : stats.length * 0.5 / (cannonsPerSide - 1);
  const maxX = 1.35;
  const maxZ = Math.min(1.5, rowSpacing * 0.4);

  for (let index = 0; index < stats.cannonCount; index++) {
    const cannon = getCannonDeckLocalPosition(stats, index);
    const dx = Math.abs(local.x - cannon.x);
    const dz = Math.abs(local.z - cannon.z);
    if (dx > maxX || dz > maxZ) continue;
    if (Math.sign(local.x) !== Math.sign(cannon.x) && Math.abs(local.x) > 0.35) continue;
    const score = dx * dx + dz * dz * 0.82;
    if (!best || score < best.score) best = { index, score };
  }

  return best?.index ?? null;
}

export function isNearHelm(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const local = toShipLocalPoint(player.position, ship);
  const helm = getHelmControlLocal(SHIP_STATS[ship.type]);
  if (Math.abs(local.x - helm.x) < 1.2 && Math.abs(local.z - helm.z) < 1.45) return true;
  // THE PROMPT MUST NOT OUTRUN THE GRANT. The arbiter offers "[X] Take Helm"
  // anywhere inside the stand CONE — a radius — while the reach the server
  // grants off was this BOX, and a radius pokes out of a box. That left a
  // crescent of the dais on every hull (562 sampled points per hull) where the
  // card read Take Helm and the press came back out_of_reach: a dead key, which
  // is the precise failure the cone was added to end. Reach is the UNION of the
  // two, so nothing that was ever grantable stops being grantable.
  return isStandingAtHelm(player, ship);
}

/**
 * THE HELM CONE. Planar radius around the wheel inside which a pirate is
 * STANDING AT THE STATION, not merely near it.
 *
 * 1.6 m fits inside the quarterdeck dais on all three hulls and still clears
 * every other stand point by a margin — the closest neighbour anywhere in the
 * fleet is the brigantine's after gun at 2.53 m, then the brace rails at
 * 2.62 / 3.01 / 3.14 m and the ammo chest at 2.54 / 3.82 / 5.74 m. So the cone
 * can never swallow another verb's own station.
 */
export const HELM_STAND_CONE = 1.6;

/**
 * Boots on the helm station. This is the geometry the prompt arbiter needs that
 * `isNearHelm` could not give it: the wheel's grab point sits ~0.9 m BELOW eye
 * level, so a newcomer who walks onto the quarterdeck staring out over the bow
 * has a look-dot near zero on the very thing she is standing on. Distance from
 * the station — not gaze — is what says "your hands are on this".
 */
export function isStandingAtHelm(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const stats = SHIP_STATS[ship.type];
  const local = toShipLocalPoint(player.position, ship);
  const helm = getHelmControlLocal(stats);
  if (Math.hypot(local.x - helm.x, local.z - helm.z) > HELM_STAND_CONE) return false;
  // Deck level only — never claimed from the hold below or from the rigging above.
  const deckY = getShipDeckY(ship.position.y, stats);
  const y = (player.position as Vec3).y;
  return y >= deckY - 0.6 && y <= deckY + 2.4;
}

export function isNearSailStation(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const stats = SHIP_STATS[ship.type];
  if ((player.position as Vec3).y < ship.position.y + stats.height - 0.35) return false;
  const local = toShipLocalPoint(player.position, ship);
  // Both rail rope stations work the halyard (port and starboard bulwarks).
  return getSailRopeStationLocals(stats).some((station) =>
    Math.abs(local.x - station.x) < 1.15 && Math.abs(local.z - station.z) < 1.35);
}

/** Which brace station the player is working: -1 = port (yard to port),
 *  +1 = starboard, 0 = not at a brace rail. */
export function findBraceStationDir(player: PlayerLike, ship: ShipLike): -1 | 0 | 1 {
  if (player.onShipId !== ship.id) return 0;
  const stats = SHIP_STATS[ship.type];
  if ((player.position as Vec3).y < ship.position.y + stats.height - 0.35) return 0;
  const local = toShipLocalPoint(player.position, ship);
  for (const station of getBraceStationLocals(stats)) {
    if (Math.abs(local.x - station.x) < 1.15 && Math.abs(local.z - station.z) < 1.3) return station.dir;
  }
  return 0;
}

export function isNearAnchor(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const local = toShipLocalPoint(player.position, ship);
  const anchor = getAnchorControlLocal(SHIP_STATS[ship.type]);
  return Math.abs(local.x - anchor.x) < 1.25 && Math.abs(local.z - anchor.z) < 1.3;
}

/** Ammo chest (Sea-of-Thieves style): centreline just aft of the companionway —
 *  the only deck band clear of every station on all three hulls. [X] here
 *  instantly tops up every firearm. */
export function getAmmoCrateLocal(stats: Pick<ShipStats, 'width' | 'length'>): ShipLocalPoint {
  const hatch = getShipCompanionwayConfig(stats);
  return { x: 0, z: hatch.stairBackZ - 1.3 };
}

export function isNearAmmoCrate(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const local = toShipLocalPoint(player.position, ship);
  const crate = getAmmoCrateLocal(SHIP_STATS[ship.type]);
  return Math.abs(local.x - crate.x) < 1.0 && Math.abs(local.z - crate.z) < 1.0;
}

// ── Boarding gangway ─────────────────────────────────────────────────────────
// A berthed ship drops a boarding plank from its bulwark to the dock deck, so
// stepping aboard a galleon is a walk up a plank instead of a 2 m freeboard
// climb. One shared geometry source: ShipRenderer draws exactly this plank and
// PhysicsSystem makes exactly this plank walkable.

/** Longest gap the plank will span, rail to dock edge (metres). */
const GANGWAY_MAX_GAP = 3.0;
/** Half-width of the walkable/rendered plank. */
const GANGWAY_HALF_WIDTH = 0.55;
/** Walkable top of a dock deck above the dock's own origin (matches the
 *  server's dock floor: dock.position.y + 0.14). */
const DOCK_DECK_RISE = 0.14;
/** How far the plank's outboard end rests ON the dock, past the dock edge. */
const GANGWAY_DOCK_BITE = 0.6;

export interface GangwayPlan {
  /** Inboard end (ship rail), world XZ + walkable Y. */
  shipEnd: Vec3;
  /** Outboard end resting on the dock deck, world XZ + walkable Y. */
  dockEnd: Vec3;
  halfWidth: number;
  /** Which bulwark it hangs from: -1 = port, +1 = starboard. */
  side: -1 | 1;
  /** Ship-local XZ of the inboard end (for drawing in ship space). */
  shipLocal: ShipLocalPoint;
  /** Inboard-end height in SHIP-LOCAL Y (deck standing plane). */
  shipLocalY: number;
}

/** The boarding plank for a ship berthed alongside a dock, or null when the
 *  ship is under way, too far off, or lying across the dock's end.
 *  Pure geometry — deterministic on client and server from replicated state. */
export function getShipGangwayPlan(
  ship: Pick<Ship, 'position' | 'rotation' | 'type'> & { anchored?: boolean; alive?: boolean; sinking?: boolean },
  dock: IslandDock,
): GangwayPlan | null {
  if (ship.alive === false || ship.sinking) return null;
  if (ship.anchored === false) return null;
  const stats = SHIP_STATS[ship.type];

  // Nearest point of the dock rectangle to the ship centre, in dock-local space.
  const shipInDock = toDockLocalPoint(dock, ship.position.x, ship.position.z);
  const halfX = dock.width * 0.5;
  const halfZ = dock.length * 0.5;
  // Only berth ALONGSIDE (a plank off the dock's short end would cross the
  // swim ladder and the shore ramp), so the attach point must be on a long edge.
  if (Math.abs(shipInDock.x) < halfX * 0.5) return null;
  const attachLocalX = Math.sign(shipInDock.x) * halfX;
  const attachLocalZ = Math.max(-halfZ + GANGWAY_DOCK_BITE, Math.min(halfZ - GANGWAY_DOCK_BITE, shipInDock.z));
  const dockEdge = dockLocalToWorld(dock, attachLocalX, DOCK_DECK_RISE, attachLocalZ);
  // Bite back onto the deck so the plank rests on planking, not on the edge.
  const dockRest = dockLocalToWorld(
    dock,
    attachLocalX - Math.sign(shipInDock.x) * GANGWAY_DOCK_BITE,
    DOCK_DECK_RISE,
    attachLocalZ,
  );

  // Where that lands on the ship: pick the rail on the dock-facing side.
  const local = toShipLocalPoint(dockEdge, ship);
  const side: -1 | 1 = local.x >= 0 ? 1 : -1;
  const railZ = Math.max(-stats.length * 0.34, Math.min(stats.length * 0.34, local.z));
  // The inboard end rests ON the cap rail (0.44 m above the standing deck) and
  // just outboard of the walk clamp, so the plank visibly crosses the bulwark
  // instead of vanishing into the planking; boarders step down onto the deck.
  const railX = side * (getShipDeckWalkHalfWidth(stats, railZ) + 0.42);
  const shipEndXZ = toShipWorldPoint({ x: railX, z: railZ }, ship);

  const gap = Math.hypot(dockRest.x - shipEndXZ.x, dockRest.z - shipEndXZ.z);
  if (gap > GANGWAY_MAX_GAP + GANGWAY_DOCK_BITE || gap < 0.35) return null;

  return {
    shipEnd: { x: shipEndXZ.x, y: ship.position.y + stats.height + 0.44, z: shipEndXZ.z },
    dockEnd: { x: dockRest.x, y: dock.position.y + DOCK_DECK_RISE, z: dockRest.z },
    halfWidth: GANGWAY_HALF_WIDTH,
    side,
    shipLocal: { x: railX, z: railZ },
    shipLocalY: stats.height + 0.44,
  };
}

/** Walkable plank height under (x, z), or null when the point is off the plank.
 *  Shared so the renderer's plank and the server's floor can never disagree. */
export function getGangwayFloorY(plan: GangwayPlan, x: number, z: number): number | null {
  const ax = plan.shipEnd.x, az = plan.shipEnd.z;
  const bx = plan.dockEnd.x, bz = plan.dockEnd.z;
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return null;
  const t = ((x - ax) * dx + (z - az) * dz) / lenSq;
  if (t < 0 || t > 1) return null;
  const px = ax + dx * t, pz = az + dz * t;
  if (Math.hypot(x - px, z - pz) > plan.halfWidth) return null;
  return plan.shipEnd.y + (plan.dockEnd.y - plan.shipEnd.y) * t;
}

export function isNearCrowNestLadder(player: PlayerLike, ship: ShipLike): boolean {
  if (player.onShipId !== ship.id) return false;
  const stats = SHIP_STATS[ship.type];
  const local = toShipLocalPoint(player.position, ship);
  const { mastZ, maxAbsX, maxAbsZ } = getCrowNestLadderInteractionBounds(stats);
  const deckY = getShipDeckY(ship.position.y, stats);
  const y = (player.position as Vec3).y;
  return Math.abs(local.x) < maxAbsX
    && Math.abs(local.z - mastZ) < maxAbsZ
    && y >= deckY - 0.35
    && y < deckY + stats.height * 4.2;
}

// ── Boarding reach (CANONICAL) ───────────────────────────────────────────────
// One truth for "can this pirate climb aboard from here", used by the client
// prompt, the server's [X] grant and the server's queued-climb latch. A press
// that shows a prompt must always be honoured, so the prompt band and the grant
// band are the same numbers.

/** Ladder reach for an instantaneous [X] press (swimmer or islander). */
export const SHIP_BOARD_LADDER_REACH = 3.6;
/** Ladder reach while a queued climb is still live (see the board latch): a
 *  press is an INTENTION, so drifting a metre off the rungs mid-swell must not
 *  silently eat it. */
export const SHIP_BOARD_LATCH_REACH = 4.6;
/** How far out from her OWN hull a swimmer counts as "at the ship". The two
 *  side ladders stay the visual, but a pirate who has already reached her own
 *  hull must never have to circle it hunting for rungs — the old ladder-only
 *  attach left a dead zone along the bow, stern and the far rail. */
export const OWN_HULL_SWIM_BOARD_MARGIN = 1.9;

/** How close to her OWN hull a pirate ON FOOT (beach, sandbar, dock planking)
 *  counts as "pressed against the side". Tighter than the swimmer's margin: a
 *  walker can put her shoulder on the planking, so the offer means exactly
 *  that, and never "somewhere on the same stretch of sand". */
export const OWN_HULL_SHORE_BOARD_MARGIN = 0.9;
/** Vertical band a shore-side boarder must stand in — waterline to a step over
 *  the cap rail. Without it a pirate on a clifftop above the bay would be
 *  offered a climb she cannot possibly make. */
const SHORE_BOARD_MAX_RISE = 1.4;
const SHORE_BOARD_MAX_DROP = 2.5;

/** A swimmer hugging her own hull anywhere around it (bow, stern, either rail). */
export function isSwimBoardingOwnHull(
  player: Pick<Player, 'position' | 'state' | 'shipId'>,
  ship: ShipLike,
): boolean {
  if (player.state !== 'swimming') return false;
  if (player.shipId !== ship.id) return false;
  const stats = SHIP_STATS[ship.type];
  const local = toShipLocalPoint(player.position, ship);
  const verticalT = getSwimHullVerticalT(player.position.y, ship.position.y, stats, ship.type);
  return isInsideSwimHullFootprint(stats, local.x, local.z, OWN_HULL_SWIM_BOARD_MARGIN, verticalT);
}

/**
 * CANONICAL "I have a hand on my own ship". Swimming OR on foot.
 *
 * The swim-only predicate left a silent dead zone that read as a broken game:
 * a pirate standing on the sand with her shoulder against her own hull got NO
 * prompt in any direction — the side ladders hang over water, so the ladder
 * band never reached her, and the own-hull offer refused her for not being wet.
 * Client prompt and server grant both call this, so the offer and the grant are
 * still one number.
 */
export function isBoardingOwnHull(
  player: Pick<Player, 'position' | 'state' | 'shipId'>,
  ship: ShipLike,
): boolean {
  if (player.shipId !== ship.id) return false;
  if (player.state === 'swimming') return isSwimBoardingOwnHull(player, ship);
  if (player.state !== 'alive') return false;
  const stats = SHIP_STATS[ship.type];
  const deckY = getShipDeckY(ship.position.y, stats);
  const y = player.position.y;
  if (y > deckY + SHORE_BOARD_MAX_RISE || y < ship.position.y - SHORE_BOARD_MAX_DROP) return false;
  const local = toShipLocalPoint(player.position, ship);
  return isInsideSwimHullFootprint(stats, local.x, local.z, OWN_HULL_SHORE_BOARD_MARGIN, 0);
}

/**
 * True when the pirate's feet are resting on this hull's walkable deck (weather
 * deck, quarterdeck dais or the hold below) even though the server has not
 * logged her as aboard. Walking up the dock gangway does exactly that, and the
 * server uses this to auto-board her instead of leaving her standing on her own
 * ship with a "Climb Ladder" prompt.
 */
export function isStandingOnShipDeck(
  player: Pick<Player, 'position'>,
  ship: Pick<Ship, 'position' | 'rotation' | 'type'>,
  tolerance = 0.6,
): boolean {
  const stats = SHIP_STATS[ship.type];
  const local = toShipLocalPoint(player.position, ship);
  if (Math.abs(local.z) > stats.length * 0.34 + 0.1) return false;
  if (Math.abs(local.x) > getShipDeckWalkHalfWidth(stats, local.z, 0.1)) return false;
  const floorY = getShipFloorYAt(player.position as Vec3, ship, local);
  return player.position.y >= floorY - tolerance && player.position.y <= floorY + tolerance + 0.9;
}

// ── World proximity (CANONICAL) ──────────────────────────────────────────────
// The server decides whether an interaction happens; the client only decides
// whether to OFFER it. Both questions are the same geometry, so they live here:
// a prompt can never appear for something the server would refuse, and never be
// missing for something it would accept.

/** Nearest upgrade station within arm's reach, or null. */
export function findNearbyUpgradeStation(
  islands: ReadonlyArray<Pick<Island, 'upgradeStations'>>,
  player: Pick<Player, 'position'>,
): UpgradeStation | null {
  let closest: UpgradeStation | null = null;
  let closestDistance: number = PLAYER.INTERACT_RANGE;
  for (const island of islands) {
    for (const station of island.upgradeStations ?? []) {
      const distance = dist2D(player.position.x, player.position.z, station.position.x, station.position.z);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = station;
      }
    }
  }
  return closest;
}

/** The gold hoarder you can sell to right now. The band is a shade wider than a
 *  plain interact so the trader is reachable from around his table. */
export function findNearbyGoldHoarder<I extends Pick<Island, 'npcs'>>(
  islands: ReadonlyArray<I>,
  player: Pick<Player, 'position'>,
): { npc: IslandNpc; island: I } | null {
  let closest: { npc: IslandNpc; island: I; distance: number } | null = null;
  for (const island of islands) {
    for (const npc of island.npcs ?? []) {
      if (npc.role !== 'gold_hoarder') continue;
      const distance = dist2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
      if (distance < PLAYER.INTERACT_RANGE + GOLD_HOARDER_REACH_BONUS && (!closest || distance < closest.distance)) {
        closest = { npc, island, distance };
      }
    }
  }
  return closest ? { npc: closest.npc, island: closest.island } : null;
}

/** A stranded swimmer's own ship, once she is far enough out for the mermaid to
 *  be the only way home. */
export function findMermaidReturnShip<S extends Pick<Ship, 'id' | 'alive' | 'sinking' | 'position'>>(
  ships: ReadonlyArray<S>,
  player: Pick<Player, 'state' | 'shipId' | 'position'>,
): S | null {
  if (player.state !== 'swimming' || !player.shipId) return null;
  const homeShip = ships.find((ship) => ship.id === player.shipId && ship.alive && !ship.sinking) ?? null;
  if (!homeShip) return null;
  const distance = dist2D(player.position.x, player.position.z, homeShip.position.x, homeShip.position.z);
  return distance >= MERMAID_RETURN_MIN_DISTANCE ? homeShip : null;
}

/** Planks available for a hull patch: pocket first, then the ship's stores. */
export function getRepairPlankCount(
  player: Pick<Player, 'pocketWood'>,
  ship: Pick<Ship, 'inventory'> | null,
): number {
  const shipPlanks = ship?.inventory.find((entry) => entry.item === 'wood_plank')?.qty ?? 0;
  return player.pocketWood + shipPlanks;
}

/** Nearest live keg whose fuse you could cut. Kegs riding a hull must already
 *  have their world position synced by the caller. */
export function findNearbyKeg(
  kegs: ReadonlyArray<ShipKeg>,
  player: Pick<Player, 'position'>,
  ship: Pick<Ship, 'id'> | null = null,
): ShipKeg | null {
  let closest: ShipKeg | null = null;
  let closestDistance: number = SHIP.KEG_DIFFUSE_RANGE;
  for (const keg of kegs) {
    if (ship && keg.shipId && keg.shipId !== ship.id) continue;
    if (keg.timer <= 0) continue;
    const dx = player.position.x - keg.position.x;
    const dy = player.position.y - keg.position.y;
    const dz = player.position.z - keg.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = keg;
    }
  }
  return closest;
}
