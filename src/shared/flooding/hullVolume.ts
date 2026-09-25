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
import type { ShipType } from '../types/index.js';
import { SHIP, SHIP_STATS } from '../constants/index.js';
import { getHullProfile, hullSurfacePointAt } from '../hull.js';

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
