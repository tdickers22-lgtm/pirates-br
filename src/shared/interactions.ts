import { FLOODING, PLAYER, SHIP, SHIP_STATS } from './constants/index.js';
import type { Island, IslandDock, IslandNpc, Player, Ship, ShipHole, ShipKeg, UpgradeStation, Vec3 } from './types/index.js';
import {
  angleWrap, clamp, dist2D, getSailRopeStationLocals, getBraceStationLocals, getCrowNestLadderInteractionBounds, getSailStationLocal, getShipCompanionwayConfig, getShipDeckRaiseAt, getShipDeckWalkHalfWidth, getShipDeckY, getShipHoldFloorY, toDockLocalPoint, dockLocalToWorld } from './utils/index.js';

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
// Holes are POINT ENTITIES in the hull-local frame (see ShipHole). These three
// helpers are the SHARED truth for "how many leaks are open", "which hole can
// this pirate plank" and "where is that hole in the world" — the server
// validates the repair with findRepairableHole and the client prompt calls the
// exact same function, so the [X] prompt can never offer a patch the server
// then refuses.

/** Breaches still letting water in (patched entities stay in the list so the
 *  crossed-plank repair keeps rendering at the spot). */
export function openHoles(ship: Pick<Ship, 'holes'>): ShipHole[] {
  return (ship.holes ?? []).filter((hole) => !hole.patched);
}

export function countOpenHoles(ship: Pick<Ship, 'holes'>): number {
  let n = 0;
  for (const hole of ship.holes ?? []) if (!hole.patched) n += 1;
  return n;
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

/** World-space point of a hull-local breach (heel/pitch are the renderer's
 *  business — this is the flat-hull transform the server flood test uses). */
export function holeWorldPoint(
  ship: Pick<Ship, 'position' | 'rotation'>,
  hole: { x: number; y: number; z: number },
): Vec3 {
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return {
    x: ship.position.x + hole.x * cos + hole.z * sin,
    y: ship.position.y + hole.y,
    z: ship.position.z + hole.z * cos - hole.x * sin,
  };
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
  return Math.abs(local.x - helm.x) < 1.2 && Math.abs(local.z - helm.z) < 1.45;
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
export const GANGWAY_MAX_GAP = 3.0;
/** Half-width of the walkable/rendered plank. */
export const GANGWAY_HALF_WIDTH = 0.55;
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
