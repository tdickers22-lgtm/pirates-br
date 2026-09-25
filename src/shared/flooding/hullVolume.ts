// THE fill-to-height table (holes-11). One per hull class, integrated from the
// lofted hull (getHullProfile / hullSurfacePointAt) between the hold sole and
// the deck underside, so every consumer that asks "how high is the water in
// her?" gets the same number: the server settle and flood head
// (FloodSystem), the client hold-water plane, wading (holdMovement) and the
// founder. waterLevel stays a VOLUME fraction (0..1 of the hold); this module
// is the only place that turns it into a hull-local height.
//
// The loft is narrow near the bilge and widest at the wale, so equal volume
// rises fast at first and then slows: fill 0.5 sits BELOW the geometric middle
// of the hold (test-flood-model pins that, plus monotonicity and the ends).
import type { Ship, ShipType, Vec3 } from '../types/index.js';
import { PLAYER, SHIP, SHIP_STATS } from '../constants/index.js';
import { getHullProfile, hullSurfacePointAt } from '../hull.js';
import { getShipFloorYAt, isStandingInShipHold, toShipLocal3 } from '../interactions.js';

/** Height samples between the sole and the deck underside. */
const Y_SAMPLES = 64;
/** Length samples along the hold (the loft is linear between stations). */
const Z_SAMPLES = 48;
/** The hold runs this fraction of the hull length (the stem and stern knees
 *  are solid timber, not flood volume). */
const HOLD_LENGTH_F = 0.9;

export interface HullVolumeTable {
  type: ShipType;
  /** Hull-local y of the hold sole (fill 0). */
  soleY: number;
  /** Hull-local y of the deck underside (fill 1). */
  deckY: number;
  /** ys[i] ascending from soleY to deckY; fills[i] the volume fraction below ys[i]. */
  ys: Float64Array;
  fills: Float64Array;
  /** Hold volume in cubic metres (for mass and the slosh period). */
  volumeM3: number;
}

const TABLES = new Map<ShipType, HullVolumeTable>();

/** Planform area (m^2) of the hull's inside at hull-local height y. */
function sectionArea(type: ShipType, y: number): number {
  const profile = getHullProfile(type);
  const halfL = profile.L * 0.5 * HOLD_LENGTH_F;
  const dz = (2 * halfL) / Z_SAMPLES;
  let area = 0;
  for (let i = 0; i < Z_SAMPLES; i += 1) {
    const z = -halfL + (i + 0.5) * dz;
    area += 2 * Math.max(0, hullSurfacePointAt(profile, z, y).x) * dz;
  }
  return area;
}

export function getHullVolumeTable(type: ShipType): HullVolumeTable {
  const cached = TABLES.get(type);
  if (cached) return cached;
  const soleY = SHIP.HOLD_FLOOR_OFFSET;
  const deckY = SHIP_STATS[type].height;
  const ys = new Float64Array(Y_SAMPLES + 1);
  const fills = new Float64Array(Y_SAMPLES + 1);
  const dy = (deckY - soleY) / Y_SAMPLES;
  let prevArea = sectionArea(type, soleY);
  let vol = 0;
  ys[0] = soleY;
  for (let i = 1; i <= Y_SAMPLES; i += 1) {
    const y = soleY + i * dy;
    const a = sectionArea(type, y);
    vol += (prevArea + a) * 0.5 * dy; // trapezoid
    prevArea = a;
    ys[i] = y;
    fills[i] = vol;
  }
  for (let i = 0; i <= Y_SAMPLES; i += 1) fills[i] /= vol;
  fills[Y_SAMPLES] = 1;
  const table: HullVolumeTable = { type, soleY, deckY, ys, fills, volumeM3: vol };
  TABLES.set(type, table);
  return table;
}

/** Hull-local height of the hold-water free surface at a volume fill (level hull). */
export function fillToLocalY(type: ShipType, fill: number): number {
  const t = getHullVolumeTable(type);
  const f = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0));
  if (f <= 0) return t.soleY;
  if (f >= 1) return t.deckY;
  let lo = 0;
  let hi = t.fills.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.fills[mid] <= f) lo = mid; else hi = mid;
  }
  const span = t.fills[hi] - t.fills[lo] || 1;
  return t.ys[lo] + (t.ys[hi] - t.ys[lo]) * ((f - t.fills[lo]) / span);
}

/** Inverse of fillToLocalY: the volume fill whose free surface stands at y. */
export function localYToFill(type: ShipType, y: number): number {
  const t = getHullVolumeTable(type);
  if (!(y > t.soleY)) return 0;
  if (y >= t.deckY) return 1;
  const dy = (t.deckY - t.soleY) / (t.ys.length - 1);
  const i = Math.min(t.ys.length - 2, Math.floor((y - t.soleY) / dy));
  const u = (y - t.ys[i]) / dy;
  return t.fills[i] + (t.fills[i + 1] - t.fills[i]) * u;
}

/** Fraction (0..1) of the hold HEIGHT the water stands at for a volume fill. */
export function fillToHeightFraction(type: ShipType, fill: number): number {
  const t = getHullVolumeTable(type);
  return (fillToLocalY(type, fill) - t.soleY) / Math.max(1e-6, t.deckY - t.soleY);
}

// ─────────────────────────────────────────────────────────────────────────────
// b2.2f (holes-07): the flooded hold is WATER for the player.
//
// The hold water is a free surface that stays level in the WORLD while the
// hull rolls and trims under it, so in the hull's own frame it tilts: deeper on
// the low rail, deeper at a dipped bow. Everything here reads only fields that
// are on the wire (type, waterLevel, pitch, roll, position, rotation), so the
// server's wading/swimming (src/server/systems/holdMovement.ts) and a client
// predictor that calls the same functions get bit-identical answers.
// ─────────────────────────────────────────────────────────────────────────────

/** Water depth over the floor, as a fraction of PLAYER.HEIGHT, where wading
 *  starts (knee deep) and where the pirate is off his feet and swims. */
export const HOLD_WADE_IMMERSION = 0.35;
export const HOLD_SWIM_IMMERSION = 0.75;
/** Horizontal speed caps as a fraction of the dry walk (PLAN 4 b2.2f). */
export const HOLD_WADE_SPEED_SCALE = 0.55;
export const HOLD_SWIM_SPEED_SCALE = 0.5;

export type HoldWaterMode = 'dry' | 'wade' | 'swim';

/**
 * Hull-local height of the hold-water surface at hull-local (x, z), or null
 * when she is dry. The fill table gives the level-hull height at the hold
 * centre; the live attitude tilts it (world-level water in a rolled hull):
 * world up of a local point is cp*sr*x + cp*cr*y - sp*z (shipLocalUpY), so a
 * level plane through the centre reads y0 - (cp*sr*x - sp*z) / (cp*cr).
 * Clamped to the sole and the deck underside.
 */
export function holdWaterSurfaceLocalY(
  type: ShipType,
  fill: number,
  localX: number,
  localZ: number,
  roll = 0,
  pitch = 0,
): number | null {
  if (!(fill > 0.001)) return null;
  const t = getHullVolumeTable(type);
  const y0 = fillToLocalY(type, fill);
  const r = Number.isFinite(roll) ? roll : 0;
  const p = Number.isFinite(pitch) ? pitch : 0;
  const cp = Math.cos(p);
  const k = cp * Math.cos(r);
  let y = y0;
  if (k > 0.2 && (r !== 0 || p !== 0)) y = y0 - (cp * Math.sin(r) * localX - Math.sin(p) * localZ) / k;
  return Math.min(t.deckY, Math.max(t.soleY, y));
}

/** Water depth over the floor under the pirate, in body heights (>= 0). */
export function holdImmersion(surfaceLocalY: number | null, floorLocalY: number): number {
  if (surfaceLocalY == null) return 0;
  return Math.max(0, (surfaceLocalY - floorLocalY) / PLAYER.HEIGHT);
}

export function holdWaterMode(immersion: number): HoldWaterMode {
  if (immersion > HOLD_SWIM_IMMERSION) return 'swim';
  if (immersion >= HOLD_WADE_IMMERSION) return 'wade';
  return 'dry';
}

/** Horizontal speed cap (m/s) in the hold water; Infinity when dry. */
export function holdSpeedCap(mode: HoldWaterMode, crouching = false): number {
  if (mode === 'wade') return HOLD_WADE_SPEED_SCALE * PLAYER.MOVE_SPEED * (crouching ? 0.55 : 1);
  if (mode === 'swim') return HOLD_SWIM_SPEED_SCALE * PLAYER.MOVE_SPEED;
  return Infinity;
}

export interface HoldWaterSample {
  mode: HoldWaterMode;
  immersion: number;
  /** Hull-local surface height at the pirate (null when dry or not below). */
  surfaceLocalY: number | null;
  /** Hull-local floor under him (the sole, or a companionway tread). */
  floorLocalY: number;
  /** His feet in the hull frame. */
  local: Vec3;
}

type HoldShip = Pick<Ship, 'position' | 'rotation' | 'type' | 'pitch' | 'roll' | 'waterLevel'>;

/** Where the hold water stands on a pirate at `position` aboard `ship`. */
export function sampleHoldWater(position: Vec3, ship: HoldShip): HoldWaterSample {
  const local = toShipLocal3(position, ship);
  const floorWorldY = getShipFloorYAt(position, ship);
  const floorLocalY = toShipLocal3({ x: position.x, y: floorWorldY, z: position.z }, ship).y;
  if (!isStandingInShipHold(position, ship, local)) {
    return { mode: 'dry', immersion: 0, surfaceLocalY: null, floorLocalY, local };
  }
  const surfaceLocalY = holdWaterSurfaceLocalY(ship.type, ship.waterLevel ?? 0, local.x, local.z, ship.roll ?? 0, ship.pitch ?? 0);
  const immersion = holdImmersion(surfaceLocalY, floorLocalY);
  return { mode: holdWaterMode(immersion), immersion, surfaceLocalY, floorLocalY, local };
}
