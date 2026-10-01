// SHIP LOD POLICY (b4.2d, D26; findings ships-01, ships-11, vm:ships:4).
//
// Four levels per hull, chosen by camera distance with 10% hysteresis:
//   0  LOD0  < 30 m      the detail hull (spline shell 72 x 40 per side)
//   1  LOD1  30-90 m     today still the detail hull; its merged per-material
//                         variant (<= 35% tris, <= 12 draws) needs the b4.3 kit
//                         trim atlas
//   2  LOD2  90-250 m    ship-lod2-root: spline shell 18 x 8, deck slab, castle,
//                         masts, one instanced sail draw (<= 4 draws)
//   3  far   > 250 m     ship-proxy: spline shell 9 x 5, everything in one
//                         vertex-coloured draw + the flag (<= 2 draws)
// Low tier and phones: every hull but the one you stand on starts at LOD2; the
// one you stand on is LOD0 (capped 60k tris on low, 45k on phones). Graded by
// scripts/test-ship-lod-budget.mjs.

export type ShipLodLevel = 0 | 1 | 2 | 3;

/** Outer edge (m) of LOD0, LOD1, LOD2; beyond the last is far. */
export const SHIP_LOD_BANDS: ReadonlyArray<number> = [30, 90, 250];
/** Coarsen once past band x (1 + h); refine only back inside band x (1 - h). */
export const SHIP_LOD_HYSTERESIS = 0.1;

/** Spline shell sampling per level: `cols` stations along the length (dense
 *  toward the stem, where uniform u turns ~20 deg per face), `rows` girth
 *  samples per side. LOD0 rows are 40, not the plan's 22: the b4.2b2 spec
 *  change (< 5 deg between adjacent girth faces needs >= 40). */
export const HULL_TIER_GRID: ReadonlyArray<{ cols: number; rows: number }> = [
  { cols: 72, rows: 40 },
  { cols: 36, rows: 12 },
  { cols: 18, rows: 8 },
  { cols: 9, rows: 5 },
];

export interface ShipLodOptions {
  quality: 'low' | 'balanced' | 'high';
  phone: boolean;
  /** The hull the local player is crewing / standing on. */
  ownHull: boolean;
}

/** Plain band for a distance, no hysteresis. */
function bandOf(distance: number): ShipLodLevel {
  if (distance < SHIP_LOD_BANDS[0]) return 0;
  if (distance < SHIP_LOD_BANDS[1]) return 1;
  if (distance < SHIP_LOD_BANDS[2]) return 2;
  return 3;
}

/** Next level for a hull at `distance` m that currently shows `current`. */
export function selectShipLod(current: ShipLodLevel, distance: number, opts: ShipLodOptions): ShipLodLevel {
  if (opts.ownHull) return 0;
  const floor: ShipLodLevel = opts.quality === 'low' || opts.phone ? 2 : 0;
  let level = current;
  // Coarsen: past the current band's outer edge by the hysteresis margin.
  while (level < 3 && distance > SHIP_LOD_BANDS[level] * (1 + SHIP_LOD_HYSTERESIS)) level = (level + 1) as ShipLodLevel;
  // Refine: inside the next finer band's outer edge by the margin.
  while (level > 0 && distance < SHIP_LOD_BANDS[level - 1] * (1 - SHIP_LOD_HYSTERESIS)) level = (level - 1) as ShipLodLevel;
  // A jump across several bands lands where the plain band says.
  const plain = bandOf(distance);
  if (Math.abs(plain - level) > 1) level = plain;
  return (level < floor ? floor : level) as ShipLodLevel;
}

/** Same-class hulls share their level geometry through mergeStaticMeshes'
 *  cache key; this is the key suffix per level. */
export function shipLodKey(type: string, level: ShipLodLevel): string {
  return `lod${level}-${type}`;
}
