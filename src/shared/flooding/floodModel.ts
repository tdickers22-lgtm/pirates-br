// THE ingress law (D15, holes-03). Pure and deterministic: the server's
// FloodSystem floods hulls with it, test-flood-model grades it, and the client
// (jets, gauge trend) may evaluate the same numbers without a wire field.
//
//   Q = K_class x A_size x sqrt(2 g h_eff)          (fill fraction per second)
//
// h_eff = (depth of the hole centre under the LIVE outside surface) minus
// (the inside head, once the hole is under the hold water). A hole within
// WASH_MARGIN above the surface still takes wash (slop against the planking a
// frozen Gerstner sample cannot see), fading linearly to 0 at the margin, so a
// breach 0.30 m above calm water on a level hull is DRY and floods only once a
// list, the settle or a wave puts it under. Depth is capped at MAX_HEAD.
import type { ShipType } from '../types/index.js';
import { FLOODING } from '../constants/index.js';
import { getHullVolumeTable, fillToLocalY } from './hullVolume.js';

export const GRAVITY = 9.81;

/** Area factor of a hole of size 1..3 (b2.2b adds ShipHole.size; absent = 1). */
export function holeSizeArea(size: number | undefined): number {
  const i = Math.min(3, Math.max(1, Math.round(size ?? 1))) - 1;
  return FLOODING.HOLE_SIZE_AREA[i];
}

/** K for a hull class (fill fraction per second per unit area per m/s). */
export function floodK(type: ShipType): number {
  return FLOODING.K_REF * (FLOODING.INGRESS_CLASS_SCALE[type] ?? 1);
}

/** Metres the hull settles at a full hold. b2.2c moves this to a per-class
 *  SETTLE table; until then every class reads FREEBOARD_DROP. */
export function floodSettleDepth(_type: ShipType): number {
  return FLOODING.FREEBOARD_DROP;
}

/** Hull-local sink (metres) at a fill: the displacement of the water aboard. */
export function floodSettle(type: ShipType, fill: number): number {
  return Math.min(1, Math.max(0, fill)) * floodSettleDepth(type);
}

/**
 * The inside head at a hole, in the hull's flood frame. The hold water pushes
 * back through a hole it covers. The game's hold floats above the design
 * waterline, so a literal world-frame comparison would stop every flood at the
 * first litre; instead the column of hold water standing over the hole (above
 * max(hole, sole)) is scaled into the displacement frame the settle lives in:
 * a full column over the hole pushes back exactly the full settle. For a hole
 * under the sole this makes inside rise and settle cancel (the box-with-a-hole
 * result: the net head stays near the start depth, a steady flood), and a hole
 * above the sole is not pushed back at all until the water reaches it.
 */
export function holeInsideHead(type: ShipType, fill: number, holeLocalY: number): number {
  if (!(fill > 0)) return 0;
  const t = getHullVolumeTable(type);
  const surfaceY = fillToLocalY(type, fill);
  const base = Math.max(holeLocalY, t.soleY);
  if (surfaceY <= base) return 0;
  const column = (surfaceY - base) / Math.max(1e-6, t.deckY - t.soleY);
  return Math.min(1, column) * floodSettleDepth(type);
}

/** Effective driving head (metres, may be negative = dry) at a hole. */
export function holeNetHead(outsideDepth: number, insideHead = 0): number {
  return outsideDepth - Math.max(0, insideHead);
}

/** Speed-of-efflux factor sqrt(2 g h_eff) for a net head (0 when dry). */
export function holeHeadFactor(netHead: number): number {
  const wash = FLOODING.WASH_MARGIN;
  const base = Math.sqrt(2 * GRAVITY * FLOODING.WASH_HEAD);
  if (!(netHead > -wash)) return 0;
  if (netHead < 0) return base * (1 + netHead / wash);
  const h = Math.min(FLOODING.MAX_HEAD, netHead) + FLOODING.WASH_HEAD;
  return Math.sqrt(2 * GRAVITY * h);
}

/** Q for one hole, fill fraction per second. */
export function holeIngress(type: ShipType, sizeArea: number, outsideDepth: number, insideHead = 0): number {
  return floodK(type) * sizeArea * holeHeadFactor(holeNetHead(outsideDepth, insideHead));
}

/** The reference rate: one size-1 hole exactly on the waterline, dry hold. */
export function waterlineHoleIngress(type: ShipType): number {
  return floodK(type) * holeHeadFactor(0);
}
