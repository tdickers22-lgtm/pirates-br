import { SHIP_STATS } from './constants/index.js';
import type { Player, Ship, Vec3 } from './types/index.js';
import {
  getSailRopeStationLocals, getBraceStationLocals, getCrowNestLadderInteractionBounds, getSailStationLocal, getShipDeckWalkHalfWidth } from './utils/index.js';

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
