/**
 * b4.7d canopy placement (islands-09): a three-layer jungle on the static world.
 *   CANOPY (8-14 m crowns): tree_broadleaf_a/_b, tree_buttress (lush), plus dead snags on the harsh biomes;
 *   SHORE: tree_mangrove on the tide line of the green biomes;
 *   UNDERSTORY (1-3 m): banana_plant, fern_giant, ringed under the canopy;
 *   GROUND: tall_grass clumps in the open interior.
 * Trees join island.props (trunk capsules in PROP_COLLIDERS, crowns never block); understory and grass are
 * soft ('none' colliders).
 *
 * COVER is the contract (PLAN 3.14 "35-50% interior canopy cover" on lush, CANOPY_COVER_TABLE for the rest):
 * the fraction of the island's dry interior (2 m grid, distRatio <= INTERIOR_DIST, ground >= 1.4 m, outside
 * every stamp) that lies under a crown disc (canopy trees, snags, mangroves and the existing palms all count).
 * Placement grows trees into uncovered interior cells until the biome's target is reached, then stops; the
 * same `canopyCover` grades it in scripts/test-canopy-density.mjs.
 *
 * Determinism (PLAN rule 6): each island draws from its OWN stream, mulberry32(seed ^ CANOPY_STREAM), after
 * every island stream, the cliff kit and the POIs; no draw is added to any earlier stream. Runs from
 * MapGenerator.generateIslands after placePoisWorld and BEFORE placeClimbsWorld (the climb routes keep clear
 * of props, so they must see the trunks).
 */
import type { Island, IslandBiome, IslandProp, IslandPropType } from '../../../shared/types/index.js';
import { getIslandDistRatio, getIslandSurfaceY, mulberry32 } from '../../../shared/utils/index.js';
import { getPropSpacingRadius } from '../../../shared/props.js';
import { getIslandKitPieces, getKitColliders } from '../../../shared/hullCollide.js';
import { islandPois, poiStampRadius } from './pois.js';

export const CANOPY_STREAM = 0xca70b1e5;
export const INTERIOR_DIST = 0.72;
const GRID_M = 2;
const DRY_Y = 1.4;

export type CanopyType =
  | 'tree_broadleaf_a' | 'tree_broadleaf_b' | 'tree_buttress' | 'tree_mangrove'
  | 'tree_dead_a' | 'tree_dead_b' | 'banana_plant' | 'fern_giant' | 'tall_grass';
export type CanopyLayer = 'canopy' | 'shore' | 'snag' | 'understory' | 'ground';

export const CANOPY_LAYER: Record<CanopyType, CanopyLayer> = {
  tree_broadleaf_a: 'canopy', tree_broadleaf_b: 'canopy', tree_buttress: 'canopy', tree_mangrove: 'shore',
  tree_dead_a: 'snag', tree_dead_b: 'snag', banana_plant: 'understory', fern_giant: 'understory', tall_grass: 'ground',
};

/** Crown radius at scale 1 (m), from the built GLB XZ half-extents x0.85 (the leaf mass, not the stray
 *  twig). Palms are the shipped palm GLBs' frond spread. Anything not here casts no cover. */
export const CROWN_R: Partial<Record<IslandPropType | CanopyType, number>> = {
  tree_broadleaf_a: 5.2, tree_broadleaf_b: 4.4, tree_buttress: 6.2, tree_mangrove: 3.0,
  tree_dead_a: 2.2, tree_dead_b: 1.8,
  palm_a: 3.0, palm_b: 2.8, palm_c: 2.6, palm_tall: 3.2,
};

/** Interior canopy cover band per biome [lo, hi] (fraction). Lush = PLAN 3.14; the rest keep their identity:
 *  atolls stay palm-open, highland/volcanic/bone are sparse snag country. */
export const CANOPY_COVER_TABLE: Record<IslandBiome, [number, number]> = {
  lush: [0.35, 0.5],
  palm_atoll: [0.1, 0.28],
  highland: [0.06, 0.22],
  volcanic: [0.03, 0.15],
  bone: [0.03, 0.15],
};
const COVER_TARGET: Record<IslandBiome, number> = { lush: 0.42, palm_atoll: 0.17, highland: 0.12, volcanic: 0.07, bone: 0.07 };

interface Pick { type: CanopyType; weight: number }
const TREE_MIX: Record<IslandBiome, Pick[]> = {
  lush: [{ type: 'tree_broadleaf_a', weight: 3 }, { type: 'tree_broadleaf_b', weight: 2.5 }, { type: 'tree_buttress', weight: 1 }],
  palm_atoll: [{ type: 'tree_broadleaf_b', weight: 2 }, { type: 'tree_broadleaf_a', weight: 1 }],
  highland: [{ type: 'tree_broadleaf_b', weight: 1.4 }, { type: 'tree_dead_a', weight: 1.2 }, { type: 'tree_dead_b', weight: 1 }],
  volcanic: [{ type: 'tree_dead_a', weight: 1 }, { type: 'tree_dead_b', weight: 1.4 }],
  bone: [{ type: 'tree_dead_a', weight: 1.2 }, { type: 'tree_dead_b', weight: 1 }],
};
const UNDER_MIX: Record<IslandBiome, Pick[]> = {
  lush: [{ type: 'banana_plant', weight: 1.4 }, { type: 'fern_giant', weight: 2 }],
  palm_atoll: [{ type: 'banana_plant', weight: 2 }, { type: 'fern_giant', weight: 0.8 }],
  highland: [{ type: 'fern_giant', weight: 1 }],
  volcanic: [{ type: 'fern_giant', weight: 1 }],
  bone: [],
};
/** Understory plants per canopy tree, mangroves per 10 m of radius, tall-grass clumps per 100 m^2 of interior. */
const UNDER_PER_TREE: Record<IslandBiome, number> = { lush: 1.6, palm_atoll: 1.2, highland: 0.6, volcanic: 0.4, bone: 0 };
const MANGROVE_PER_10M: Record<IslandBiome, number> = { lush: 0.8, palm_atoll: 1, highland: 0, volcanic: 0, bone: 0 };
const GRASS_PER_100M2: Record<IslandBiome, number> = { lush: 0.35, palm_atoll: 0.3, highland: 0.45, volcanic: 0.1, bone: 0.15 };

function pick(rng: () => number, mix: Pick[]): CanopyType {
  let total = 0;
  for (const m of mix) total += m.weight;
  let r = rng() * total;
  for (const m of mix) if ((r -= m.weight) <= 0) return m.type;
  return mix[mix.length - 1].type;
}

function slopeAt(island: Island, x: number, z: number): number {
  const e = 1;
  const dx = getIslandSurfaceY(island, x + e, z) - getIslandSurfaceY(island, x - e, z);
  const dz = getIslandSurfaceY(island, x, z + e) - getIslandSurfaceY(island, x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

function inStamp(island: Island, x: number, z: number, pad: number): boolean {
  for (const s of island.stamps ?? []) if (Math.hypot(x - s.x, z - s.z) < s.radius + pad) return true;
  return false;
}

/** The dry interior sample cells cover is measured over (world XZ, 2 m grid). */
export function interiorCells(island: Island): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const R = island.radius * 1.4;
  const cx = island.position.x;
  const cz = island.position.z;
  for (let x = cx - R; x <= cx + R; x += GRID_M) {
    for (let z = cz - R; z <= cz + R; z += GRID_M) {
      if (getIslandDistRatio(island, x, z).distRatio > INTERIOR_DIST) continue;
      if (getIslandSurfaceY(island, x, z) < DRY_Y) continue;
      if (inStamp(island, x, z, 0)) continue;
      out.push({ x, z });
    }
  }
  return out;
}

export function crownRadius(p: IslandProp): number {
  return (CROWN_R[p.type as keyof typeof CROWN_R] ?? 0) * p.scale;
}

/** Fraction of the dry interior under a crown (0 when the island has no interior). */
export function canopyCover(island: Island, cells = interiorCells(island)): number {
  if (!cells.length) return 0;
  const crowns = (island.props ?? []).filter((p) => crownRadius(p) > 0);
  let covered = 0;
  for (const c of cells) if (crowns.some((p) => Math.hypot(c.x - p.x, c.z - p.z) < crownRadius(p))) covered++;
  return covered / cells.length;
}

class Placer {
  readonly blockers: Array<{ x: number; z: number; r: number }> = [];
  nextId: number;

  constructor(readonly isl: Island) {
    this.nextId = (isl.props ?? []).reduce((m, p) => Math.max(m, p.id ?? 0), 0) + 1;
    for (const p of isl.props ?? []) this.blockers.push({ x: p.x, z: p.z, r: getPropSpacingRadius(p.type, p.scale) });
    for (const poi of islandPois(isl)) this.blockers.push({ x: poi.x, z: poi.z, r: poiStampRadius(poi.r) + 0.5 });
    for (const k of getIslandKitPieces(isl)) this.blockers.push({ x: k.x, z: k.z, r: (getKitColliders(k.key)?.radiusXZ ?? 4) * (k.scale ?? 1) + 0.8 });
    for (const c of isl.caves) this.blockers.push({ x: c.position.x, z: c.position.z, r: 7 });
    for (const e of [...isl.chests, ...isl.barrels, ...isl.upgradeStations]) this.blockers.push({ x: e.position.x, z: e.position.z, r: 2 });
    for (const n of isl.npcs) this.blockers.push({ x: n.position.x, z: n.position.z, r: 3 });
    for (const g of isl.geysers ?? []) this.blockers.push({ x: g.x, z: g.z, r: g.radius + 3 });
    for (const b of isl.bridges ?? []) {
      this.blockers.push({ x: b.ax, z: b.az, r: 5 });
      this.blockers.push({ x: b.bx, z: b.bz, r: 5 });
    }
    const d = isl.dock;
    if (d) {
      this.blockers.push({ x: d.position.x, z: d.position.z, r: 16 });
      if (d.respawnPoint) this.blockers.push({ x: d.respawnPoint.x, z: d.respawnPoint.z, r: 8 });
      if (d.berthPosition) this.blockers.push({ x: d.berthPosition.x, z: d.berthPosition.z, r: 12 });
    }
    if (isl.tavern) this.blockers.push({ x: isl.tavern.position.x, z: isl.tavern.position.z, r: 16 });
  }

  clear(x: number, z: number, r: number): boolean {
    for (const b of this.blockers) if (Math.hypot(x - b.x, z - b.z) < b.r + r) return false;
    return true;
  }

  add(type: CanopyType, x: number, z: number, yaw: number, scale: number): IslandProp {
    const p: IslandProp = { id: this.nextId++, type: type as IslandPropType, x, z, yaw, scale };
    (this.isl.props ??= []).push(p);
    this.blockers.push({ x, z, r: getPropSpacingRadius(p.type, scale) });
    return p;
  }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const yawOf = (rng: () => number): number => r3(rng() * Math.PI * 2 - Math.PI);

export function placeIslandCanopy(island: Island): Record<CanopyType, number> {
  const counts = Object.fromEntries(Object.keys(CANOPY_LAYER).map((k) => [k, 0])) as Record<CanopyType, number>;
  const biome: IslandBiome = island.profile.biome ?? 'lush';
  const rng = mulberry32(((island.profile.seed ?? 0) ^ CANOPY_STREAM) >>> 0);
  const p = new Placer(island);
  const cells = interiorCells(island);
  if (!cells.length) return counts;
  const crowns = (island.props ?? []).filter((q) => crownRadius(q) > 0);
  const covered = new Uint8Array(cells.length);
  let nCovered = 0;
  const mark = (x: number, z: number, cr: number): void => {
    for (let i = 0; i < cells.length; i++) {
      if (!covered[i] && Math.hypot(cells[i].x - x, cells[i].z - z) < cr) {
        covered[i] = 1;
        nCovered++;
      }
    }
  };
  for (const q of crowns) mark(q.x, q.z, crownRadius(q));

  // 1. CANOPY / SNAGS: grow into uncovered interior until the biome target.
  const trees: IslandProp[] = [];
  const target = COVER_TARGET[biome];
  let tries = cells.length;
  while (nCovered / cells.length < target && tries-- > 0) {
    const open: number[] = [];
    for (let i = 0; i < cells.length; i++) if (!covered[i]) open.push(i);
    if (!open.length) break;
    const c = cells[open[Math.floor(rng() * open.length)]];
    const type = pick(rng, TREE_MIX[biome]);
    const scale = r3(0.85 + rng() * 0.3);
    const x = r3(c.x + (rng() - 0.5) * GRID_M);
    const z = r3(c.z + (rng() - 0.5) * GRID_M);
    if (getIslandSurfaceY(island, x, z) < DRY_Y + 0.2) continue;
    if (slopeAt(island, x, z) > (type === 'tree_buttress' ? 0.55 : 0.9)) continue;
    if (inStamp(island, x, z, 1.5)) continue;
    if (!p.clear(x, z, getPropSpacingRadius(type as IslandPropType, scale))) continue;
    const t = p.add(type, x, z, yawOf(rng), scale);
    trees.push(t);
    counts[type]++;
    mark(x, z, crownRadius(t));
  }

  // 2. SHORE: mangroves on the tide line (ground 0.25..1.1 m, gentle).
  const mangroves = Math.round((island.radius / 10) * MANGROVE_PER_10M[biome]);
  for (let n = 0, att = mangroves * 30; n < mangroves && att-- > 0;) {
    const a = rng() * Math.PI * 2;
    const dr = 0.8 + rng() * 0.25;
    const x = r3(island.position.x + Math.cos(a) * island.radius * dr * island.profile.footprintX);
    const z = r3(island.position.z + Math.sin(a) * island.radius * dr * island.profile.footprintZ);
    const y = getIslandSurfaceY(island, x, z);
    if (y < 0.25 || y > 1.1 || slopeAt(island, x, z) > 0.6 || inStamp(island, x, z, 2)) continue;
    const scale = r3(0.85 + rng() * 0.3);
    if (!p.clear(x, z, getPropSpacingRadius('tree_mangrove' as IslandPropType, scale) + 1)) continue;
    p.add('tree_mangrove', x, z, yawOf(rng), scale);
    counts.tree_mangrove++;
    n++;
  }

  // 3. UNDERSTORY: ringed 2.5-5 m around the canopy trees (shade plants), soft.
  const under = UNDER_MIX[biome];
  const anchors = trees.length ? trees : crowns;
  const nUnder = under.length && anchors.length ? Math.round(Math.max(trees.length, anchors.length * 0.3) * UNDER_PER_TREE[biome]) : 0;
  for (let n = 0, att = nUnder * 12; n < nUnder && att-- > 0;) {
    const t = anchors[Math.floor(rng() * anchors.length)];
    const a = rng() * Math.PI * 2;
    const d = 2.5 + rng() * 2.5;
    const x = r3(t.x + Math.cos(a) * d);
    const z = r3(t.z + Math.sin(a) * d);
    const type = pick(rng, under);
    const scale = r3(0.8 + rng() * 0.4);
    if (getIslandSurfaceY(island, x, z) < DRY_Y || slopeAt(island, x, z) > 1.0 || inStamp(island, x, z, 0.8)) continue;
    if (!p.clear(x, z, 0.6)) continue;
    p.add(type, x, z, yawOf(rng), scale);
    counts[type]++;
    n++;
  }

  // 4. GROUND: tall grass clumps in the open interior (never under a crown: grass wants light).
  const nGrass = Math.round((cells.length * GRID_M * GRID_M / 100) * GRASS_PER_100M2[biome]);
  for (let n = 0, att = nGrass * 8; n < nGrass && att-- > 0;) {
    const c = cells[Math.floor(rng() * cells.length)];
    const x = r3(c.x + (rng() - 0.5) * GRID_M);
    const z = r3(c.z + (rng() - 0.5) * GRID_M);
    const scale = r3(0.8 + rng() * 0.45);
    if (getIslandSurfaceY(island, x, z) < DRY_Y || slopeAt(island, x, z) > 0.9 || inStamp(island, x, z, 0.5)) continue;
    if (!p.clear(x, z, 0.35)) continue;
    p.add('tall_grass', x, z, yawOf(rng), scale);
    counts.tall_grass++;
    n++;
  }
  return counts;
}

export function placeCanopyWorld(islands: Island[]): Record<CanopyType, number> {
  const total = Object.fromEntries(Object.keys(CANOPY_LAYER).map((k) => [k, 0])) as Record<CanopyType, number>;
  for (const island of islands) {
    const c = placeIslandCanopy(island);
    for (const k of Object.keys(c) as CanopyType[]) total[k] += c[k];
  }
  return total;
}
