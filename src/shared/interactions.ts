import { SHIP_STATS } from './constants/index.js';
import type { IslandDock, Player, Ship, Vec3 } from './types/index.js';
import {
  getSailRopeStationLocals, getBraceStationLocals, getCrowNestLadderInteractionBounds, getSailStationLocal, getShipCompanionwayConfig, getShipDeckWalkHalfWidth, toDockLocalPoint, dockLocalToWorld } from './utils/index.js';

type ShipStats = (typeof SHIP_STATS)[keyof typeof SHIP_STATS];
type ShipLocalPoint = { x: number; z: number };
type ShipLike = Pick<Ship, 'position' | 'rotation' | 'type' | 'id'>;
type PlayerLike = Pick<Player, 'position' | 'onShipId'>;

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

export function getAnchorControlLocal(stats: Pick<ShipStats, 'length'>): ShipLocalPoint {
  return {
    x: 0,
    z: stats.length * 0.42,
  };
}

export function getSailControlLocal(stats: Pick<ShipStats, 'length' | 'mastCount' | 'width'>): ShipLocalPoint {
  return getSailStationLocal(stats);
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
  return Math.abs(local.x) < 1.2 && Math.abs(local.z + SHIP_STATS[ship.type].length * 0.37) < 1.45;
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
  const deckY = ship.position.y + stats.height + 0.1;
  const y = (player.position as Vec3).y;
  return Math.abs(local.x) < maxAbsX
    && Math.abs(local.z - mastZ) < maxAbsZ
    && y >= deckY - 0.35
    && y < deckY + stats.height * 4.2;
}
