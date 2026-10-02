/**
 * b4.7b climb placement: ladders, ropes and scramble corridors on the static
 * world, written to `island.climbs` (WORLD coordinates) after every island
 * stream and after the cliff kit. Pure geometry from the shared terrain truth
 * (getIslandSurfaceY): no rng draw, so no stream is consumed and the tick-order
 * baseline does not move. MapGenerator runs on the server and in the client's
 * static-world worker, so both sides hold the same routes.
 *
 * Three passes per island:
 *  1. authored mesa ladder sites (landforms.ts `ladders`);
 *  2. every authored scarp taller than CLIMB_SCARP_MIN_M that has walkable
 *     ground on both sides gets a route within CLIMB_SCARP_SPACING_M of every
 *     point of its path;
 *  3. reachability fill: walk graph on a coarse grid (slope <= WALK_SLOPE_MAX,
 *     dry), joined by bridges and by the sea (a swimmer lands on any beach),
 *     flooded from the landing beach (the largest shore-touching component); the largest unreached pockets get the
 *     shortest route from reached ground until >= REACH_TARGET of the walkable
 *     area is reached or no pocket is within LINK_MAX_M.
 */
import type { Island } from '../../../shared/types/index.js';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import { getIslandLandforms, getLandformLadders } from '../../../shared/landforms.js';
import {
  CLIMB_SCARP_MIN_M, CLIMB_SCARP_SPACING_M, SCRAMBLE_SLOPE_MAX, WALK_SLOPE_MAX,
  type ClimbKind, type ClimbPlacedIsland, type IslandClimb,
} from '../../../shared/interactions.js';

export const CLIMB_GRID_M = 3;
/** Dry land: the walk graph and every route end stand at least this far above the sea. */
export const CLIMB_DRY_Y = 0.3;
const REACH_TARGET = 0.975;
const LINK_MAX_M = 14;
const MAX_CLIMBS_PER_ISLAND = 18;
const MIN_POCKET_CELLS = 3;
const DRAPE_STEP_M = 0.5;

/** Coarse walk graph shared by placement and its gate. */
export interface WalkGrid {
  n: number; x0: number; z0: number; step: number;
  y: Float32Array;
  walk: Uint8Array;
  /** Component label per walkable cell (-1 otherwise), 4-connected walk edges. */
  comp: Int32Array;
  sizes: number[];
  /** Components with a walkable cell next to sea. */
  shore: Set<number>;
}

export function buildWalkGrid(island: Island, step = CLIMB_GRID_M): WalkGrid {
  const R = island.radius * 1.2 + 10;
  const n = Math.ceil((2 * R) / step) + 1;
  const x0 = island.position.x - R;
  const z0 = island.position.z - R;
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) y[j * n + i] = getIslandSurfaceY(island, x0 + i * step, z0 + j * step);
  const walk = new Uint8Array(n * n);
  const lim = WALK_SLOPE_MAX * step;
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      const h = y[k];
      if (h < CLIMB_DRY_Y) continue;
      const g = Math.max(Math.abs(y[k + 1] - y[k - 1]), Math.abs(y[k + n] - y[k - n])) / 2;
      if (g <= lim) walk[k] = 1;
    }
  }
  const edge = (a: number, b: number): boolean => walk[a] === 1 && walk[b] === 1 && Math.abs(y[a] - y[b]) <= lim;
  const comp = new Int32Array(n * n).fill(-1);
  const sizes: number[] = [];
  const shore = new Set<number>();
  const stack: number[] = [];
  for (let s = 0; s < n * n; s++) {
    if (!walk[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      for (const d of [1, -1, n, -n]) {
        const m = k + d;
        if (m < 0 || m >= n * n) continue;
        if (y[m] < 0) shore.add(id);
        if (comp[m] < 0 && edge(k, m)) { comp[m] = id; stack.push(m); }
      }
    }
    sizes.push(size);
  }
  return { n, x0, z0, step, y, walk, comp, sizes, shore };
}

export function gridCellAt(g: WalkGrid, x: number, z: number): number {
  const i = Math.round((x - g.x0) / g.step);
  const j = Math.round((z - g.z0) / g.step);
  if (i < 0 || j < 0 || i >= g.n || j >= g.n) return -1;
  return j * g.n + i;
}

/** The landing beach: the largest component that touches the sea. */
export function landingComponent(g: WalkGrid): number {
  let best = -1;
  for (const c of g.shore) if (best < 0 || g.sizes[c] > g.sizes[best]) best = c;
  return best;
}

/** Point slope probe (1 m central differences), the walker's own scale. */
function slopeAt(island: Island, x: number, z: number): number {
  return Math.max(
    Math.abs(getIslandSurfaceY(island, x + 1, z) - getIslandSurfaceY(island, x - 1, z)),
    Math.abs(getIslandSurfaceY(island, x, z + 1) - getIslandSurfaceY(island, x, z - 1)),
  ) / 2;
}

/** A dry walkable footing at or within 2 m of (x,z) (the coarse grid can call a
 *  cell walkable whose centre sits on a short steep bank), or null. */
function footing(island: Island, x: number, z: number): [number, number] | null {
  for (const r of [0, 1, 2]) {
    for (let a = 0; a < (r === 0 ? 1 : 8); a++) {
      const px = x + Math.cos((a * Math.PI) / 4) * r; const pz = z + Math.sin((a * Math.PI) / 4) * r;
      if (getIslandSurfaceY(island, px, pz) >= CLIMB_DRY_Y && slopeAt(island, px, pz) <= WALK_SLOPE_MAX * 0.95) return [px, pz];
    }
  }
  return null;
}

/** Route from low ground (lx,lz) to high ground (hx,hz), draped on the terrain. */
export function makeClimb(island: Island, id: string, lx0: number, lz0: number, hx0: number, hz0: number): IslandClimb | null {
  const lo = footing(island, lx0, lz0);
  const hi = footing(island, hx0, hz0);
  if (!lo || !hi) return null;
  const [lx, lz] = lo; const [hx, hz] = hi;
  const dx = hx - lx;
  const dz = hz - lz;
  const horiz = Math.hypot(dx, dz);
  const steps = Math.max(2, Math.ceil(horiz / DRAPE_STEP_M));
  const pts: number[] = [];
  let maxSlope = 0;
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const x = lx + dx * f;
    const z = lz + dz * f;
    const yy = getIslandSurfaceY(island, x, z);
    if (s > 0) maxSlope = Math.max(maxSlope, Math.abs(yy - pts[pts.length - 2]) / (horiz / steps));
    pts.push(x, yy, z);
  }
  const ay = pts[1];
  const by = pts[pts.length - 2];
  if (by - ay < 0.5 || ay < CLIMB_DRY_Y) return null;
  let nx: number; let nz: number;
  if (horiz > 0.3) { nx = -dx / horiz; nz = -dz / horiz; } else {
    const ox = lx - island.position.x; const oz = lz - island.position.z; const o = Math.hypot(ox, oz) || 1;
    nx = ox / o; nz = oz / o;
  }
  const kind: ClimbKind = maxSlope <= SCRAMBLE_SLOPE_MAX ? 'scramble' : by - ay > 9 ? 'rope' : 'ladder';
  return { id, kind, ax: pts[0], ay, az: pts[2], bx: pts[pts.length - 3], by, bz: pts[pts.length - 1], nx, nz, pts };
}

/** Nearest walkable cell centre from (x,z) stepping along (ux,uz), or null. */
function walkAlong(g: WalkGrid, x: number, z: number, ux: number, uz: number, maxM: number): { x: number; z: number; k: number } | null {
  for (let d = 0; d <= maxM; d += 1) {
    const k = gridCellAt(g, x + ux * d, z + uz * d);
    if (k >= 0 && g.walk[k]) return { x: g.x0 + (k % g.n) * g.step, z: g.z0 + Math.floor(k / g.n) * g.step, k };
  }
  return null;
}

export function placeIslandClimbs(island: Island): IslandClimb[] {
  const g = buildWalkGrid(island);
  const out: IslandClimb[] = [];
  const push = (c: IslandClimb | null): boolean => { if (c && out.length < MAX_CLIMBS_PER_ISLAND) { out.push(c); return true; } return false; };
  const cx = island.position.x;
  const cz = island.position.z;

  // 1. authored mesa ladder sites.
  for (const site of getLandformLadders(island)) {
    const ux = Math.cos(site.angle); const uz = Math.sin(site.angle);
    const fx = cx + site.x; const fz = cz + site.z;
    const low = walkAlong(g, fx, fz, ux, uz, 12);
    const high = walkAlong(g, fx, fz, -ux, -uz, 12);
    if (low && high && g.comp[low.k] !== g.comp[high.k]) push(makeClimb(island, site.id, low.x, low.z, high.x, high.z));
  }

  // 2. tall authored scarps: a route within CLIMB_SCARP_SPACING_M of every point.
  const near = (x: number, z: number): boolean => out.some((c) => Math.min(Math.hypot(c.ax - x, c.az - z), Math.hypot(c.bx - x, c.bz - z)) <= CLIMB_SCARP_SPACING_M);
  for (const rec of getIslandLandforms(island)) {
    if (rec.kind !== 'scarp' || rec.height <= CLIMB_SCARP_MIN_M) continue;
    let si = 0;
    for (let p = 1; p < rec.path.length; p++) {
      const [x0, z0] = rec.path[p - 1]; const [x1, z1] = rec.path[p];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 1e-3) continue;
      const tx = (x1 - x0) / L; const tz = (z1 - z0) / L;
      for (let s = 0; s <= L; s += 10) {
        const wx = cx + x0 + tx * s; const wz = cz + z0 + tz * s;
        if (near(wx, wz)) continue;
        // The face is where the cross-section drops fastest (raise-mode scarps
        // sit up to `reach` off their path), not on the path line itself.
        const px = -tz; const pz = tx;
        let faceD = 0; let drop = 0;
        let prev = getIslandSurfaceY(island, wx - px * 20, wz - pz * 20);
        for (let d = -19; d <= 20; d++) {
          const yy = getIslandSurfaceY(island, wx + px * d, wz + pz * d);
          if (Math.abs(yy - prev) > Math.abs(drop)) { drop = yy - prev; faceD = d - 0.5; }
          prev = yy;
        }
        const fx = wx + px * faceD; const fz = wz + pz * faceD;
        const up = drop > 0 ? 1 : -1; // +1: ground rises along +p
        const low = walkAlong(g, fx - px * up * 1.5, fz - pz * up * 1.5, -px * up, -pz * up, 16);
        const high = walkAlong(g, fx + px * up * 1.5, fz + pz * up * 1.5, px * up, pz * up, 16);
        if (!low || !high || g.y[high.k] - g.y[low.k] < CLIMB_SCARP_MIN_M * 0.6) continue;
        push(makeClimb(island, `${rec.id}-climb-${si++}`, low.x, low.z, high.x, high.z));
      }
    }
  }

  // 3. reachability fill from the landing beach.
  const start = landingComponent(g);
  if (start < 0) return out;
  const parent = g.sizes.map((_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const join = (a: number, b: number): void => { if (a >= 0 && b >= 0) parent[find(a)] = find(b); };
  const link = (x0: number, z0: number, x1: number, z1: number): void => {
    const ka = gridCellAt(g, x0, z0); const kb = gridCellAt(g, x1, z1);
    if (ka >= 0 && kb >= 0) join(g.comp[ka], g.comp[kb]);
  };
  // A swimmer lands on any beach: every shore-touching pocket is reached by sea.
  for (const c of g.shore) join(c, start);
  for (const b of island.bridges ?? []) link(b.ax, b.az, b.bx, b.bz);
  for (const c of out) link(c.ax, c.az, c.bx, c.bz);
  const total = g.sizes.reduce((a, b) => a + b, 0);
  const reachedArea = (): number => g.sizes.reduce((a, s, i) => a + (find(i) === find(start) ? s : 0), 0);
  const R = Math.ceil(LINK_MAX_M / g.step);
  const cellsOf: number[][] = g.sizes.map(() => []);
  for (let k = 0; k < g.n * g.n; k++) if (g.comp[k] >= 0) cellsOf[g.comp[k]].push(k);
  let fill = 0;
  for (let guard = 0; guard < 64 && out.length < MAX_CLIMBS_PER_ISLAND && reachedArea() < REACH_TARGET * total; guard++) {
    // Largest unreached pocket that has reached ground within LINK_MAX_M.
    const pockets = g.sizes.map((_, i) => i).filter((i) => find(i) !== find(start) && g.sizes[i] >= MIN_POCKET_CELLS)
      .sort((p, q) => g.sizes[q] - g.sizes[p] || p - q);
    let placed = false;
    for (const pocket of pockets) {
      let best: { a: number; b: number; d: number } | null = null;
      for (const k of cellsOf[pocket]) {
        const i = k % g.n; const j = Math.floor(k / g.n);
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            const ii = i + di; const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= g.n || jj >= g.n) continue;
            const m = jj * g.n + ii;
            if (g.comp[m] < 0 || find(g.comp[m]) !== find(start)) continue;
            const d = Math.hypot(di, dj) * g.step + Math.abs(g.y[m] - g.y[k]) * 0.05;
            if (d <= LINK_MAX_M && (!best || d < best.d)) best = { a: m, b: k, d };
          }
        }
      }
      if (!best) continue;
      const [lo, hi] = g.y[best.a] <= g.y[best.b] ? [best.a, best.b] : [best.b, best.a];
      const c = makeClimb(island, `${island.id}-climb-fill-${fill++}`,
        g.x0 + (lo % g.n) * g.step, g.z0 + Math.floor(lo / g.n) * g.step,
        g.x0 + (hi % g.n) * g.step, g.z0 + Math.floor(hi / g.n) * g.step);
      if (c && push(c)) { join(g.comp[lo], g.comp[hi]); placed = true; break; }
    }
    if (!placed) break;
  }
  return out;
}

/** Place every island's routes; returns the count per kind. */
export function placeClimbsWorld(islands: Island[]): Record<ClimbKind, number> {
  const counts: Record<ClimbKind, number> = { ladder: 0, rope: 0, scramble: 0 };
  for (const island of islands) {
    const climbs = placeIslandClimbs(island);
    (island as Island & ClimbPlacedIsland).climbs = climbs;
    for (const c of climbs) counts[c.kind]++;
  }
  return counts;
}
