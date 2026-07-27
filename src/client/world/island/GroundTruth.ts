/**
 * The DRAWN ground, as opposed to the analytic one.
 *
 * Every seat helper in this codebase used to sample `getIslandSurfaceY` — the
 * shared analytic heightfield. The island the player actually looks at is a
 * POLAR TRIANGLE MESH sampled from that field on a ~4 m grid, and a triangle is
 * a CHORD: wherever the field is convex (every stamp rim round a dock, tavern
 * or camp pad, every terrace lip, every ridge) the drawn surface runs BELOW the
 * function. Seat a boulder on the function next to a dock and it hangs in the
 * air over the mesh — the P1 floating boulder, and 1,193 smaller cousins the
 * analytic audit could never see, because analytically they are seated fine.
 *
 * So: after the terrain mesh exists, index its triangles and let props and
 * decor seat on THAT. The sampler also carries the two things only the mesh
 * knows — the triangle normal (real drawn slope) and the terrain vertex colour
 * under a point (what a grass tuft must match).
 *
 * The same index is published to `shared/props.ts` through
 * `setRenderedSurfaceSampler`, so `getPropGroundY` — the one seat helper the
 * client, the server registry and the harvest actors all share — silently
 * becomes mesh-true on the client while the server keeps its pure analytic
 * (and therefore deterministic) answer.
 */
import * as THREE from 'three';
import type { Island } from '../../../shared/types/index.js';
import { setRenderedSurfaceSampler } from '../../../shared/props.js';
import type { IslandBuildCtx } from './context.js';

/** One triangle hit under a query point, in island-local space. */
export type GroundHit = {
  /** Interpolated surface height. */
  y: number;
  /** Triangle normal (unit, +Y up). `ny` is the cosine of the slope. */
  nx: number;
  ny: number;
  nz: number;
  /** Barycentric weights + vertex offsets, for colour lookups. */
  w0: number; w1: number; w2: number;
  a: number; b: number; c: number;
};

/** Seat of a piece standing on the drawn ground. */
export type MeshSeat = {
  /** Lowest drawn ground under the footprint ring — where the base must reach. */
  lo: number;
  /** Highest drawn ground under the ring. */
  hi: number;
  /** Ground at the centre. */
  center: number;
  /** Cosine of the slope at the centre (1 = flat, 0 = vertical wall). */
  slopeCos: number;
  /** Terrain normal at the centre. */
  normal: THREE.Vector3;
};

const DIAG = Math.SQRT1_2;
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [DIAG, DIAG], [DIAG, -DIAG], [-DIAG, DIAG], [-DIAG, -DIAG],
];

/**
 * A uniform XZ bucket grid over one island's terrain triangles. Built once per
 * island mesh (~20k triangles, two counting passes into flat typed arrays, a
 * couple of milliseconds) and queried tens of thousands of times by the grass
 * scatter, so the lookup is the part that has to stay cheap: one cell index,
 * then a barycentric test per triangle in that cell.
 */
export class MeshGround {
  private readonly pos: Float32Array;
  private readonly col: Float32Array | null;
  private readonly tri: Uint32Array;
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  /** CSR: cellStart[i]..cellStart[i+1] index into cellTris. */
  private readonly cellStart: Uint32Array;
  private readonly cellTris: Uint32Array;

  constructor(geometry: THREE.BufferGeometry) {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.pos = posAttr.array as Float32Array;
    const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    this.col = colAttr ? (colAttr.array as Float32Array) : null;
    const index = geometry.getIndex();
    if (index) {
      const src = index.array;
      this.tri = src instanceof Uint32Array ? src : Uint32Array.from(src);
    } else {
      const count = posAttr.count;
      this.tri = new Uint32Array(count);
      for (let i = 0; i < count; i++) this.tri[i] = i;
    }
    const triCount = Math.floor(this.tri.length / 3);

    let lox = Infinity; let hix = -Infinity; let loz = Infinity; let hiz = -Infinity;
    for (let i = 0; i < this.pos.length; i += 3) {
      const x = this.pos[i]; const z = this.pos[i + 2];
      if (x < lox) lox = x;
      if (x > hix) hix = x;
      if (z < loz) loz = z;
      if (z > hiz) hiz = z;
    }
    const span = Math.max(hix - lox, hiz - loz, 1);
    // ~64 cells across the island: cheap to build, ~4-8 triangles per cell on
    // the outer rings where every query lands.
    this.cellSize = Math.max(3, span / 64);
    this.minX = lox - this.cellSize;
    this.minZ = loz - this.cellSize;
    this.nx = Math.ceil((hix - this.minX) / this.cellSize) + 2;
    this.nz = Math.ceil((hiz - this.minZ) / this.cellSize) + 2;

    // Pass 1: count triangles per cell. Pass 2: fill. (Counting sort — no
    // per-cell arrays, no rehashing, no garbage.)
    const cells = this.nx * this.nz;
    const counts = new Uint32Array(cells + 1);
    const bounds = new Int32Array(triCount * 4);
    for (let t = 0; t < triCount; t++) {
      const a = this.tri[t * 3] * 3; const b = this.tri[t * 3 + 1] * 3; const c = this.tri[t * 3 + 2] * 3;
      const x0 = this.cellX(Math.min(this.pos[a], this.pos[b], this.pos[c]));
      const x1 = this.cellX(Math.max(this.pos[a], this.pos[b], this.pos[c]));
      const z0 = this.cellZ(Math.min(this.pos[a + 2], this.pos[b + 2], this.pos[c + 2]));
      const z1 = this.cellZ(Math.max(this.pos[a + 2], this.pos[b + 2], this.pos[c + 2]));
      bounds[t * 4] = x0; bounds[t * 4 + 1] = x1; bounds[t * 4 + 2] = z0; bounds[t * 4 + 3] = z1;
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) counts[ix * this.nz + iz + 1]++;
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellTris = new Uint32Array(counts[cells]);
    const cursor = new Uint32Array(cells);
    for (let t = 0; t < triCount; t++) {
      const x0 = bounds[t * 4]; const x1 = bounds[t * 4 + 1];
      const z0 = bounds[t * 4 + 2]; const z1 = bounds[t * 4 + 3];
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const cell = ix * this.nz + iz;
          this.cellTris[counts[cell] + cursor[cell]++] = t;
        }
      }
    }
  }

  private cellX(x: number): number {
    const i = Math.floor((x - this.minX) / this.cellSize);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }

  private cellZ(z: number): number {
    const i = Math.floor((z - this.minZ) / this.cellSize);
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i;
  }

  /** Highest triangle covering (x, z), island-local. Null off the mesh. */
  hit(x: number, z: number): GroundHit | null {
    const cell = this.cellX(x) * this.nz + this.cellZ(z);
    const from = this.cellStart[cell];
    const to = this.cellStart[cell + 1];
    const p = this.pos;
    let best: GroundHit | null = null;
    for (let i = from; i < to; i++) {
      const t = this.cellTris[i];
      const a = this.tri[t * 3] * 3; const b = this.tri[t * 3 + 1] * 3; const c = this.tri[t * 3 + 2] * 3;
      const x1 = p[a]; const z1 = p[a + 2];
      const x2 = p[b]; const z2 = p[b + 2];
      const x3 = p[c]; const z3 = p[c + 2];
      const det = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
      if (det > -1e-9 && det < 1e-9) continue;
      const w0 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / det;
      if (w0 < -1e-4) continue;
      const w1 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / det;
      if (w1 < -1e-4) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < -1e-4) continue;
      const y = w0 * p[a + 1] + w1 * p[b + 1] + w2 * p[c + 1];
      if (best !== null && y <= best.y) continue;
      // Face normal, oriented up (the heightfield is DoubleSide).
      let ex1 = x2 - x1; let ey1 = p[b + 1] - p[a + 1]; let ez1 = z2 - z1;
      let ex2 = x3 - x1; let ey2 = p[c + 1] - p[a + 1]; let ez2 = z3 - z1;
      let nx = ey1 * ez2 - ez1 * ey2;
      let ny = ez1 * ex2 - ex1 * ez2;
      let nz = ex1 * ey2 - ey1 * ex2;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      best = { y, nx, ny, nz, w0, w1, w2, a: a / 3, b: b / 3, c: c / 3 };
    }
    return best;
  }

  /** Drawn surface height at (x, z), island-local; null off the mesh. */
  heightAt(x: number, z: number): number | null {
    return this.hit(x, z)?.y ?? null;
  }

  /** Terrain vertex colour under (x, z). False when off the mesh or uncoloured. */
  colorAt(x: number, z: number, target: THREE.Color): boolean {
    const h = this.hit(x, z);
    if (!h || !this.col) return false;
    const c = this.col;
    target.setRGB(
      h.w0 * c[h.a * 3] + h.w1 * c[h.b * 3] + h.w2 * c[h.c * 3],
      h.w0 * c[h.a * 3 + 1] + h.w1 * c[h.b * 3 + 1] + h.w2 * c[h.c * 3 + 1],
      h.w0 * c[h.a * 3 + 2] + h.w1 * c[h.b * 3 + 2] + h.w2 * c[h.c * 3 + 2],
    );
    return true;
  }

  /** Seat a piece of `footR` radius: the drawn ground under its whole base. */
  seat(x: number, z: number, footR: number): MeshSeat | null {
    const c = this.hit(x, z);
    if (!c) return null;
    let lo = c.y;
    let hi = c.y;
    if (footR > 0.05) {
      for (const [ox, oz] of RING) {
        const y = this.heightAt(x + ox * footR, z + oz * footR);
        if (y === null) continue;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    return { lo, hi, center: c.y, slopeCos: c.ny, normal: new THREE.Vector3(c.nx, c.ny, c.nz) };
  }
}

type Registered = { ground: MeshGround; originX: number; originZ: number };

/** Live index per island id, and the geometry it was built from (a rebuilt
 *  island gets a fresh mesh object, so identity is the cache key). */
const registry = new Map<string, Registered>();
const built = new WeakMap<THREE.BufferGeometry, MeshGround>();
let samplerInstalled = false;

/**
 * Index this island's rendered terrain (idempotent). Call it before anything
 * seats onto the island; returns null on the low-detail proxy path or if the
 * terrain mesh is not in the group yet.
 */
export function ensureMeshGround(ctx: IslandBuildCtx): MeshGround | null {
  const { island, group } = ctx;
  const terrain = group.getObjectByName('island-terrain');
  if (!(terrain instanceof THREE.Mesh)) return null;
  const geometry = terrain.geometry as THREE.BufferGeometry;
  let ground = built.get(geometry);
  if (!ground) {
    ground = new MeshGround(geometry);
    built.set(geometry, ground);
  }
  registry.set(island.id, { ground, originX: island.position.x, originZ: island.position.z });
  if (!samplerInstalled) {
    samplerInstalled = true;
    // getPropGroundY (shared with the server) asks the client for the DRAWN
    // surface; the server never installs a sampler and keeps its analytic,
    // deterministic answer.
    setRenderedSurfaceSampler((islandId, worldX, worldZ) => {
      const entry = registry.get(islandId);
      if (!entry) return null;
      return entry.ground.heightAt(worldX - entry.originX, worldZ - entry.originZ);
    });
  }
  return ground;
}

/** The indexed ground for an already-built island, if any. */
export function getMeshGround(island: Island): MeshGround | null {
  return registry.get(island.id)?.ground ?? null;
}

/**
 * Move an analytic surface sample onto the DRAWN ground, keeping whatever lift
 * the caller asked `surfacePoint` for. This is the one line most client decor
 * needs: it was placed on the heightfield, and the heightfield is not what the
 * player is looking at.
 */
export function snapToDrawnGround(
  ground: MeshGround | null,
  point: THREE.Vector3,
  lift = 0,
): THREE.Vector3 {
  const y = ground?.heightAt(point.x, point.z);
  if (y !== null && y !== undefined) point.y = y + lift;
  return point;
}

/**
 * Seat a decor piece of `footR` footprint on the drawn ground: the base reaches
 * the LOWEST drawn ground under its footprint (so a slope leaves no daylight),
 * capped so one cliff-edge sample can't swallow the piece, then bitten in by
 * `bite` so the contact reads buried rather than balanced.
 */
export function seatOnDrawnGround(
  ctx: IslandBuildCtx,
  x: number,
  z: number,
  footR: number,
  opts: { capSink?: number; bite?: number } = {},
): { y: number; slopeCos: number; normal: THREE.Vector3 } {
  const capSink = opts.capSink ?? 0.4;
  const bite = opts.bite ?? 0.2;
  const seat = getMeshGround(ctx.island)?.seat(x, z, footR);
  if (seat) {
    return {
      y: Math.max(seat.lo, seat.center - capSink) - bite,
      slopeCos: seat.slopeCos,
      normal: seat.normal,
    };
  }
  const fallback = ctx.seatDecor(x, z, footR, capSink);
  return {
    y: fallback.groundY - fallback.drop - bite,
    slopeCos: fallback.normal.y,
    normal: fallback.normal,
  };
}
