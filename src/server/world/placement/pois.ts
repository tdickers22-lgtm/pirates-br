/**
 * b4.7c POI placement (islands-04): ruins, outposts, camps, overlooks, lighthouses, shrines and grotto
 * landings on the static world, written to `island.pois` (WORLD coordinates) with
 *  - a terrain STAMP (flatten disc on island.stamps, read by getIslandSurfaceY on server and client),
 *  - a LOOT hook (a slot inside the footprint with a chest/barrel bias for the loot spawner),
 *  - a TRAIL link (the footprint entry facing the landing; Landmarks.buildTrails routes paths to it).
 *
 * Count per island by radius (PLAN 3.14): r < 50 -> 3, 50..75 -> 5, > 75 -> 7 (POI_TARGET). Every POI
 * stands in the dock's walk component (or the landing beach's when the island has no dock), so it is
 * reachable on foot from where a crew lands.
 *
 * Determinism (PLAN rule 6): each island draws from its OWN stream, mulberry32(profile.seed ^ POI_STREAM),
 * after every island stream; no draw is added to islandRng or to the kit/camp/story streams. Runs from
 * MapGenerator.generateIslands after the per-island content and the cliff kit (whose placement it never
 * moves: stamps keep clear of every kit piece) and BEFORE the climbs, which plan on the stamped ground. Flora/boulders inside a
 * stamp are cleared (their ground moves); any other prop near a site rejects it.
 */
import type { Island, IslandProp } from '../../../shared/types/index.js';
import { getIslandSurfaceY, mulberry32 } from '../../../shared/utils/index.js';
import { getLandformLadders } from '../../../shared/landforms.js';
import { WALK_SLOPE_MAX } from '../../../shared/interactions.js';
import { getIslandKitPieces, getKitColliders } from '../../../shared/hullCollide.js';
import { buildWalkGrid, gridCellAt, landingComponent, CLIMB_DRY_Y, type WalkGrid } from './climbs.js';

export const POI_STREAM = 0x9017a5e7;

export type PoiKind =
  | 'ruin_temple' | 'ruin_wall' | 'ruin_arch' | 'stilt_outpost' | 'skeleton_camp'
  | 'overlook_platform' | 'small_lighthouse' | 'jungle_shrine' | 'grotto_landing';

/** Footprint radius per kind (m): the drawn piece fits inside, the stamp's flat core is this wide. */
export const POI_FOOTPRINT_M: Record<PoiKind, number> = {
  ruin_temple: 10, ruin_wall: 4.5, ruin_arch: 4, stilt_outpost: 6.5, skeleton_camp: 6.5,
  overlook_platform: 4.5, small_lighthouse: 5, jungle_shrine: 4, grotto_landing: 5.5,
};

export interface IslandPoi {
  id: string;
  kind: PoiKind;
  /** Variant index (ruin_wall a/b/c = 0/1/2; 0 otherwise). */
  variant: number;
  x: number;
  y: number;
  z: number;
  /** Project yaw convention: local +Z faces (sin yaw, cos yaw) = toward the trail link. */
  yaw: number;
  /** Footprint radius (m); the stamp on island.stamps is r + rim. */
  r: number;
  loot: { x: number; z: number; bias: 'chest' | 'barrel' };
  link: { x: number; z: number };
}
export interface PoiPlacedIsland { pois?: IslandPoi[] }

export function islandPois(island: object): readonly IslandPoi[] {
  return (island as PoiPlacedIsland).pois ?? [];
}

/** PLAN 3.14 radius table. */
export function poiTarget(radius: number): number {
  return radius < 50 ? 3 : radius <= 75 ? 5 : 7;
}

export const poiStampRadius = (r: number): number => r + Math.max(4, r * 0.5);

const REMOVABLE = /^(palm_|boulder_|bush|flower_|fern_plant|wildflowers|crag|driftwood_log)/;
const CHEST_KINDS = new Set<PoiKind>(['ruin_temple', 'jungle_shrine', 'grotto_landing', 'skeleton_camp']);
const FILLERS: PoiKind[] = ['ruin_wall', 'ruin_arch', 'skeleton_camp', 'jungle_shrine', 'stilt_outpost', 'ruin_wall', 'ruin_arch', 'ruin_wall', 'ruin_arch', 'ruin_wall'];
const round = (v: number): number => Math.round(v * 1000) / 1000;

function kindPlan(island: Island): PoiKind[] {
  const n = poiTarget(island.radius);
  const biome = island.profile.biome;
  const lush = biome === 'lush' || biome === 'palm_atoll';
  const third: PoiKind = biome === 'bone' ? 'skeleton_camp' : lush ? 'jungle_shrine' : 'ruin_arch';
  if (n >= 7) return ['ruin_temple', 'overlook_platform', 'small_lighthouse', 'stilt_outpost', 'skeleton_camp', lush ? 'jungle_shrine' : 'ruin_arch', 'ruin_wall'];
  if (n >= 5) return ['ruin_temple', 'overlook_platform', 'small_lighthouse', third, 'stilt_outpost'];
  return ['overlook_platform', third, 'ruin_wall'];
}

/** Multi-source BFS: metres from each grid cell to the nearest sea cell (y < 0). */
function seaDistance(g: WalkGrid): Float32Array {
  const d = new Float32Array(g.n * g.n).fill(Infinity);
  const q: number[] = [];
  for (let k = 0; k < d.length; k++) if (g.y[k] < 0) { d[k] = 0; q.push(k); }
  for (let h = 0; h < q.length; h++) {
    const k = q[h];
    const i = k % g.n;
    for (const m of [i > 0 ? k - 1 : -1, i < g.n - 1 ? k + 1 : -1, k - g.n, k + g.n]) {
      if (m < 0 || m >= d.length || d[m] <= d[k] + g.step) continue;
      d[m] = d[k] + g.step;
      q.push(m);
    }
  }
  return d;
}

/** The dock's walk component (the landing beach's on dockless islands); archipelagos add every islet
 *  beach a swimmer lands on (the test-island-climb sea-join rule). */
export function homeComponents(island: Island, g: WalkGrid): Set<number> {
  let home = -1;
  const dock = island.dock?.respawnPoint;
  if (dock) {
    let best = Infinity;
    for (let k = 0; k < g.n * g.n; k++) {
      if (!g.walk[k]) continue;
      const dd = Math.hypot(g.x0 + (k % g.n) * g.step - dock.x, g.z0 + Math.floor(k / g.n) * g.step - dock.z);
      if (dd < best && dd < 18) { best = dd; home = g.comp[k]; }
    }
  }
  const homes = new Set<number>([home >= 0 ? home : landingComponent(g)]);
  if (island.profile.terrainStyle === 'archipelago') for (const c of g.shore) if (g.sizes[c] * g.step * g.step >= 54) homes.add(c);
  return homes;
}

class PoiPlacer {
  readonly pois: IslandPoi[] = [];
  private readonly g: WalkGrid;
  private readonly sea: Float32Array;
  /** Walk components a crew reaches from the landing (planning 3 m grid / the gate's 2 m grid). */
  private readonly homes: Set<number>;
  private readonly g2: WalkGrid;
  private readonly homes2: Set<number>;
  private readonly anchor: { x: number; z: number };
  private readonly mouths: Array<{ x: number; z: number }>;

  constructor(readonly island: Island, readonly rng: () => number) {
    this.g = buildWalkGrid(island);
    this.sea = seaDistance(this.g);
    this.mouths = island.caves.filter((c) => c.hasMouth !== false).map((c) => ({ x: c.position.x, z: c.position.z }));
    this.homes = homeComponents(island, this.g);
    this.g2 = buildWalkGrid(island, 2);
    this.homes2 = homeComponents(island, this.g2);
    const dock = island.dock?.respawnPoint;
    this.anchor = dock ? { x: dock.x, z: dock.z } : { x: island.position.x, z: island.position.z };
  }

  private spread(x: number, z: number): number {
    let s = Math.min(60, Math.hypot(x - this.anchor.x, z - this.anchor.z));
    for (const p of this.pois) s = Math.min(s, Math.hypot(x - p.x, z - p.z));
    return s;
  }

  private nearestMouth(x: number, z: number): number {
    let m = Infinity;
    for (const c of this.mouths) m = Math.min(m, Math.hypot(x - c.x, z - c.z));
    return m;
  }

  /** Cheap pre-score from the grid; -Infinity = this kind cannot stand here. */
  private score(kind: PoiKind, k: number, x: number, z: number): number {
    const h = this.g.y[k];
    const d = this.sea[k];
    const s = this.spread(x, z);
    const j = this.rng();
    switch (kind) {
      case 'ruin_temple': return d < 16 ? -Infinity : s * 0.6 + Math.min(d, 40) * 0.5 + j * 6;
      case 'overlook_platform': return d < 6 ? -Infinity : h * 2 + s * 0.3 + j * 3;
      case 'small_lighthouse': return d < 4 || d > 24 ? -Infinity : h * 1.5 + s * 0.4 + j * 3;
      case 'stilt_outpost': return d < 3 || d > 12 || h < 0.6 || h > 4 ? -Infinity : s * 0.6 + j * 5;
      case 'grotto_landing': {
        const m = this.nearestMouth(x, z);
        return m < 9 || m > 26 || h > 5 ? -Infinity : -m + j * 3;
      }
      // Islets are narrow: the small pieces may stand nearer the water there.
      default: return d < (this.island.profile.terrainStyle === 'archipelago' ? 3 : 8) ? -Infinity : s * 0.7 + j * 8;
    }
  }

  /** Full site check on the live (already stamped) ground. Returns the stamp target height or null. */
  private fits(kind: PoiKind, x: number, z: number, r: number): number | null {
    const isl = this.island;
    const R = poiStampRadius(r);
    const ys: number[] = [getIslandSurfaceY(isl, x, z)];
    for (const f of [0.55, 1]) for (let a = 0; a < 8; a++) {
      const t = (a / 8) * Math.PI * 2 + f;
      ys.push(getIslandSurfaceY(isl, x + Math.sin(t) * r * f, z + Math.cos(t) * r * f));
    }
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const wet = kind === 'stilt_outpost' || kind === 'grotto_landing';
    // The stamp lifts the core to the mean: the low edge may dip toward the beach, never into the sea.
    if (lo < 0.1 || ys.reduce((a, b) => a + b, 0) / ys.length < (wet ? 0.5 : CLIMB_DRY_Y + 0.3)) return null;
    if (hi - lo > Math.min(3, WALK_SLOPE_MAX * (R - r) * 0.7)) return null;
    const near = (p: { x: number; z: number } | null | undefined, rr: number): boolean => !!p && Math.hypot(x - p.x, z - p.z) < rr;
    const dock = isl.dock;
    if (dock && (near(dock.position, R + 16) || near(dock.respawnPoint, R + 8) || near(dock.berthPosition, R + 12))) return null;
    if (near(isl.tavern?.position, R + 18)) return null;
    for (const c of this.mouths) if (near(c, kind === 'grotto_landing' ? r + 3 : R + 8)) return null;
    for (const s of isl.stamps ?? []) if (near(s, s.radius + R + 1)) return null;
    for (const e of [...isl.chests, ...isl.barrels, ...isl.upgradeStations]) if (near(e.position, R + 1.5)) return null;
    for (const npc of isl.npcs) if (near(npc.position, R + 3)) return null;
    for (const gy of isl.geysers ?? []) if (near(gy, gy.radius + R + 4)) return null;
    for (const b of isl.bridges ?? []) if (near({ x: b.ax, z: b.az }, R + 6) || near({ x: b.bx, z: b.bz }, R + 6)) return null;
    for (const l of getLandformLadders(isl)) if (near({ x: l.x + isl.position.x, z: l.z + isl.position.z }, R + 6)) return null;
    for (const p of isl.props ?? []) if (!REMOVABLE.test(p.type) && near(p, R + 4)) return null;
    // Cliff-kit pieces stand on the unstamped ground: the stamp never reaches under one.
    for (const k of getIslandKitPieces(isl)) if (near(k, (getKitColliders(k.key)?.radiusXZ ?? 4) * (k.scale ?? 1) + R + 1)) return null;
    let sum = 0;
    for (const y of ys) sum += y;
    return sum / ys.length;
  }

  place(kind: PoiKind): boolean {
    const g = this.g;
    const r = POI_FOOTPRINT_M[kind];
    const cands: Array<{ k: number; x: number; z: number; s: number }> = [];
    for (let k = 0; k < g.n * g.n; k++) {
      if (!g.walk[k] || !this.homes.has(g.comp[k])) continue;
      const i = k % g.n;
      const j = Math.floor(k / g.n);
      if (i < 3 || j < 3 || i > g.n - 4 || j > g.n - 4) continue;
      const x = g.x0 + i * g.step;
      const z = g.z0 + j * g.step;
      const s = this.score(kind, k, x, z);
      if (s > -Infinity) cands.push({ k, x, z, s });
    }
    cands.sort((a, b) => b.s - a.s);
    for (const c of cands.slice(0, 400)) {
      const ty = this.fits(kind, c.x, c.z, r);
      if (ty === null) continue;
      const k2 = gridCellAt(this.g2, c.x, c.z);
      if (k2 < 0 || !this.homes2.has(this.g2.comp[k2])) continue;
      const stamps = this.island.stamps!;
      const R = poiStampRadius(r);
      stamps.push({ x: round(c.x), z: round(c.z), radius: round(R), targetY: round(ty), blend: round((R - r) / R) });
      const holds = this.holds(c.x, c.z, r, ty);
      stamps.pop();
      if (!holds) continue;
      this.commit(kind, c.x, c.z, r, ty);
      return true;
    }
    return false;
  }

  /** Dense check on the trial-stamped ground: landforms applied after the stamps (scarps, basalt teeth)
   *  must not cut the core, and the 2 m neighbourhood of the centre stays walkable. */
  private holds(x: number, z: number, r: number, ty: number): boolean {
    for (let dz = -r; dz <= r; dz += 1.25) for (let dx = -r; dx <= r; dx += 1.25) {
      if (dx * dx + dz * dz > r * r) continue;
      if (Math.abs(getIslandSurfaceY(this.island, x + dx, z + dz) - ty) > 0.15) return false;
    }
    return true;
  }

  private commit(kind: PoiKind, x: number, z: number, r: number, targetY: number): void {
    const isl = this.island;
    const R = poiStampRadius(r);
    isl.stamps!.push({ x: round(x), z: round(z), radius: round(R), targetY: round(targetY), blend: round((R - r) / R) });
    isl.props = (isl.props ?? []).filter((p: IslandProp) => !(REMOVABLE.test(p.type) && Math.hypot(p.x - x, p.z - z) < R + 1));
    // Coastal pieces face the sea; everything else faces the trail from the landing.
    const seaward = kind === 'small_lighthouse' || kind === 'stilt_outpost' || kind === 'grotto_landing';
    const tx = seaward ? x - isl.position.x : this.anchor.x - x;
    const tz = seaward ? z - isl.position.z : this.anchor.z - z;
    const yaw = Math.atan2(tx, tz);
    const toAx = this.anchor.x - x;
    const toAz = this.anchor.z - z;
    const la = Math.hypot(toAx, toAz) || 1;
    const lootYaw = yaw + Math.PI; // behind the piece's front
    this.pois.push({
      id: `${isl.id}-poi-${this.pois.length}`,
      kind,
      variant: kind === 'ruin_wall' ? Math.floor(this.rng() * 3) : 0,
      x: round(x), y: round(targetY), z: round(z), yaw: round(yaw), r,
      loot: { x: round(x + Math.sin(lootYaw) * r * 0.4), z: round(z + Math.cos(lootYaw) * r * 0.4), bias: CHEST_KINDS.has(kind) ? 'chest' : 'barrel' },
      link: { x: round(x + (toAx / la) * (r + 0.5)), z: round(z + (toAz / la) * (r + 0.5)) },
    });
  }
}

export function placeIslandPois(island: Island): IslandPoi[] {
  island.stamps ??= [];
  const p = new PoiPlacer(island, mulberry32((((island.profile.seed ?? 0x5eed) >>> 0) ^ POI_STREAM) >>> 0));
  const target = poiTarget(island.radius);
  // A kind with no site falls back to the smaller pieces until the table count is met; a kind that
  // found no site never retries (the island only gets more crowded).
  const dead = new Set<PoiKind>();
  const tryKind = (kind: PoiKind): boolean => {
    if (dead.has(kind)) return false;
    if (p.place(kind)) return true;
    dead.add(kind);
    return false;
  };
  for (const kind of kindPlan(island)) tryKind(kind);
  for (let f = 0; p.pois.length < target && f < FILLERS.length; f++) tryKind(FILLERS[f]);
  // Grotto landing: a bonus on islands with a sea-cave mouth (Smuggler's Rest intent), never counted against the table.
  if (island.caves.some((c) => c.hasMouth !== false)) p.place('grotto_landing');
  (island as Island & PoiPlacedIsland).pois = p.pois;
  return p.pois;
}

export function placePoisWorld(islands: Island[]): Record<PoiKind, number> {
  const counts = Object.fromEntries(Object.keys(POI_FOOTPRINT_M).map((k) => [k, 0])) as Record<PoiKind, number>;
  for (const island of islands) for (const poi of placeIslandPois(island)) counts[poi.kind]++;
  return counts;
}
