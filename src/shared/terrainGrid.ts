/**
 * THE ONE TERRAIN GRID (GRID-01 phase 1).
 *
 * Before this file there were THREE island meshes — the low, balanced and high
 * caps each sampled the shared heightfield on their own polar lattice (radial
 * 8/5.5/4 m, angular 11/7/5) — and a FOURTH surface, the analytic
 * `getIslandSurfaceY`, which is what the server stood the player on. Every pair
 * of those four disagreed by the chord error of the coarser one, so a chest sat
 * on the drawn triangles on one machine and hovered on another, feet sank into
 * terrace lips, and the feather pass (±0.42 m, client-only) moved the drawn
 * ground off the analytic field on purpose.
 *
 * So: ONE grid, at ONE fixed resolution, built here, THREE-free, from the
 * shared field. Quality tiers vary decoration and shading, never a vertex
 * position (`test-terrain-grid.mjs` asserts that). `GridGround` reads the same
 * triangles back, so "the height of the ground at (x, z)" has exactly one
 * answer for the renderer, the server, client prediction and entity placement.
 *
 * Three shape changes ride along, because they are properties of the grid:
 *
 *  - RING DOUBLING. The old cap held its angular count constant, so 48-176
 *    segments converged onto the summit (0.23 m apart on a 5 m circle) while
 *    the rim — where the cliffs and beaches are — got 4-8 m chords. Segment
 *    count now doubles with the circumference (ladder 24·2^k), the centre is a
 *    single apex vertex instead of a sliver fan, and the rings are stitched
 *    explicitly so no T-junction opens.
 *  - THE APRON. Rings run out to SHORE_APRON_DIST_RATIO, the same 1.22 the
 *    server's swim seabed collides to, so the invisible sandbar band is drawn.
 *  - VERTEX AO. A horizon estimate over the grid's own neighbourhood (no extra
 *    field evaluation, no per-frame cost) so creases, cave mouths and terrace
 *    undersides stop being lit like an open beach.
 *
 * There is no seam vertex: rings store exactly `segments` vertices and wrap
 * with a modulo, so the coast cannot split along a meridian and normals are
 * continuous across it.
 */
import type { Island } from './types/index.js';
import {
  SHORE_APRON_DIST_RATIO,
  getIslandMaxRadius,
  getIslandSurfacePoint,
} from './utils/index.js';

/** Radial spacing target, metres. The old high tier. */
export const GRID_RADIAL_STEP = 4;
/** Angular spacing target at the rim, metres of arc. */
export const GRID_RIM_ARC_STEP = 5;
/** Rings between the footprint edge (1.0) and the apron. */
export const GRID_SHORE_RINGS = 7;
/** Ring-doubling ladder: segments are always 24·2^k, so an outer ring's count
 *  is an exact integer multiple of its inner neighbour's and the stitch is
 *  T-junction free by construction. */
export const GRID_SEGMENTS_MIN = 24;
export const GRID_SEGMENTS_MAX = 192;
/** How far a vertex may be pulled toward its radial neighbours' mean. */
export const GRID_FEATHER_CAP = 0.42;
/** Distance from the footprint edge to the apron, in distRatio. */
export const GRID_APRON_SPAN = SHORE_APRON_DIST_RATIO - 1;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(x: number, edge0: number, edge1: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * COAST WOBBLE — why every island sat in a mathematically perfect turquoise disc.
 *
 * The ring radius gains a low-order angular wobble and the vertex is then
 * resampled from the shared field at its new place, so every drawn vertex still
 * lies EXACTLY on `getIslandSurfaceY` and no shared math is touched. Amplitude
 * ramps in from the interior so nothing moves under the ground the player walks
 * on. Frequencies stop at 7 because the shore skirt (44 segments) and the LOD
 * proxy (30) must trace the SAME curve or daylight opens between them — which
 * is why this is one module function all of them call. It lives here rather
 * than in the renderer because the grid is now shared.
 */
export function coastWobble(
  island: { profile: { ridgeAxis: number; primaryHillAngle: number } },
  distRatio: number,
  angle: number,
): number {
  const ramp = smoothstep(distRatio, 0.42, 1.06);
  if (ramp <= 0) return distRatio;
  const s = (island.profile.ridgeAxis + island.profile.primaryHillAngle) * 3.1;
  const w = Math.sin(angle * 2 + s) * 0.078
    + Math.sin(angle * 3 - s * 1.7) * 0.052
    + Math.sin(angle * 5 + s * 0.6) * 0.032
    + Math.sin(angle * 7 - s * 2.3) * 0.020;
  // The rings must stay ORDERED — d(out)/d(in) > 0 — or a quad folds through
  // its neighbour. With |w| ≤ 0.182 and the ramp spread over 0.64 of distRatio
  // (max slope 2.34) the worst case is 1 − 0.182 − 1.06·0.182·2.34 ≈ 0.33.
  return distRatio * (1 + w * ramp);
}

/** Smallest ladder count that meets `target`, clamped to the grid's range. */
export function ringSegmentCount(target: number): number {
  if (target <= GRID_SEGMENTS_MIN) return GRID_SEGMENTS_MIN;
  let n = GRID_SEGMENTS_MIN;
  while (n < target && n < GRID_SEGMENTS_MAX) n *= 2;
  return Math.min(n, GRID_SEGMENTS_MAX);
}

export type TerrainGrid = {
  /** Island-LOCAL vertex positions (x, y, z), one entry per vertex. */
  readonly positions: Float32Array;
  /** Triangle indices into `positions`. */
  readonly indices: Uint32Array;
  /** Per-vertex ambient occlusion in [0, 1] (1 = open sky), or null. */
  readonly ao: Float32Array | null;
  /** Per-vertex mouth-carve depth, parallel to the vertex list. */
  readonly mouthCarveDepth: Float32Array;
  /** First vertex index of each ring; length = rings + 1 (last = vertex count). */
  readonly ringStart: Uint32Array;
  /** Segment count of each ring; ring 0 is the single apex vertex. */
  readonly ringSegments: Uint32Array;
  /** Un-wobbled distRatio of each ring. */
  readonly ringDist: Float32Array;
  readonly rings: number;
  /** The apron span this grid was built to (1.22 - 1). */
  readonly shoreRingSpan: number;
};

export type TerrainGridOptions = {
  /** Island-local surface point (defaults to the shared analytic field). */
  surfacePoint?: (distRatio: number, angle: number, extraY?: number) => { x: number; y: number; z: number };
  /** Cave-mouth trench carve, in WORLD xz. Defaults to no carve (the server's
   *  view: `getIslandSurfaceY` already owns the shared trench). */
  carveCaveMouth?: (worldX: number, worldZ: number, y: number) => { y: number; carved: number };
  /** Bake per-vertex AO (client only — the server never shades). */
  withAO?: boolean;
};

/**
 * Build one island's terrain grid. Pure and deterministic: the same island in
 * the same seed yields bit-identical positions on the server and in every
 * browser, at every quality tier.
 */
export function buildTerrainGrid(island: Island, opts: TerrainGridOptions = {}): TerrainGrid {
  const islandMaxR = getIslandMaxRadius(island);
  const surfacePoint = opts.surfacePoint ?? ((distRatio: number, angle: number, extraY = 0) => {
    const p = getIslandSurfacePoint(island, distRatio, angle, extraY);
    return { x: p.x - island.position.x, y: p.y, z: p.z - island.position.z };
  });
  const carve = opts.carveCaveMouth;

  const radialSegments = clamp(Math.round(islandMaxR / GRID_RADIAL_STEP), 16, 60);
  const rings = radialSegments + GRID_SHORE_RINGS;
  const ringDist = new Float32Array(rings + 1);
  const ringSegments = new Uint32Array(rings + 1);
  const ringStart = new Uint32Array(rings + 2);
  let vertexCount = 0;
  for (let ring = 0; ring <= rings; ring++) {
    const d = ring <= radialSegments
      ? (ring === 0 ? 0 : Math.pow(ring / radialSegments, 0.9))
      : 1 + ((ring - radialSegments) / GRID_SHORE_RINGS) * GRID_APRON_SPAN;
    ringDist[ring] = d;
    // Ring 0 is ONE vertex: the summit sliver fan (48-176 segments sharing a
    // 5 m circle) is where the shading pinwheel came from.
    const segs = ring === 0 ? 1 : ringSegmentCount((Math.PI * 2 * islandMaxR * d) / GRID_RIM_ARC_STEP);
    ringSegments[ring] = segs;
    ringStart[ring] = vertexCount;
    vertexCount += segs;
  }
  ringStart[rings + 1] = vertexCount;

  const positions = new Float32Array(vertexCount * 3);
  const mouthCarveDepth = new Float32Array(vertexCount);
  for (let ring = 0; ring <= rings; ring++) {
    const segs = ringSegments[ring];
    const base = ringStart[ring];
    const d = ringDist[ring];
    for (let s = 0; s < segs; s++) {
      const angle = (s / segs) * Math.PI * 2;
      const point = surfacePoint(coastWobble(island, d, angle), angle, 0.02);
      const i = base + s;
      let y = point.y;
      if (carve) {
        const c = carve(point.x + island.position.x, point.z + island.position.z, point.y);
        y = c.y;
        mouthCarveDepth[i] = c.carved;
      }
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = point.z;
    }
  }

  featherRisers(positions, ringStart, ringSegments, rings);
  const indices = stitchRings(ringStart, ringSegments, rings);
  const ao = opts.withAO ? bakeVertexAO(positions, ringStart, ringSegments, rings) : null;

  return {
    positions, indices, ao, mouthCarveDepth,
    ringStart, ringSegments, ringDist, rings,
    shoreRingSpan: GRID_APRON_SPAN,
  };
}

/** Vertex index on `ring` nearest the fractional segment position `u` in [0,1). */
function ringVertexAt(ringStart: Uint32Array, ringSegments: Uint32Array, ring: number, u: number): number {
  const segs = ringSegments[ring];
  let s = Math.round(u * segs) % segs;
  if (s < 0) s += segs;
  return ringStart[ring] + s;
}

/**
 * FEATHER THE TERRACE LIPS. A vertex far off the mean of its two RADIAL
 * neighbours is standing on the lip of a step, and a lip sampled once per ring
 * is a hard 90° corner running the length of the coast. Pull it a fraction
 * toward that mean — only on ground steeper than ~40° (where nothing stands and
 * nothing is seated) or underwater, and never by more than the cap.
 *
 * It runs HERE, in shared code, rather than in the renderer, because the server
 * stands the player on the result: before GRID-01 this was a client-only ±0.42 m
 * offset from the field the server collided with (physics-32).
 */
function featherRisers(
  positions: Float32Array,
  ringStart: Uint32Array,
  ringSegments: Uint32Array,
  rings: number,
): void {
  const smoothed = new Float32Array(positions.length / 3);
  for (let i = 0; i < smoothed.length; i++) smoothed[i] = positions[i * 3 + 1];
  for (let ring = 1; ring < rings; ring++) {
    const segs = ringSegments[ring];
    const base = ringStart[ring];
    for (let s = 0; s < segs; s++) {
      const i = base + s;
      const u = s / segs;
      const inI = ringVertexAt(ringStart, ringSegments, ring - 1, u);
      const outI = ringVertexAt(ringStart, ringSegments, ring + 1, u);
      const yc = positions[i * 3 + 1];
      const yIn = positions[inI * 3 + 1];
      const yOut = positions[outI * 3 + 1];
      const mean = (yIn + yOut) * 0.5;
      const dx = positions[outI * 3] - positions[inI * 3];
      const dz = positions[outI * 3 + 2] - positions[inI * 3 + 2];
      const run = Math.max(0.35, Math.hypot(dx, dz));
      const grade = Math.abs(yOut - yIn) / run;
      const gate = yc < 0.4 ? 1 : smoothstep(grade, 0.84, 1.5);
      if (gate <= 0) continue;
      smoothed[i] = yc + clamp((mean - yc) * 0.5 * gate, -GRID_FEATHER_CAP, GRID_FEATHER_CAP);
    }
  }
  for (let i = 0; i < smoothed.length; i++) positions[i * 3 + 1] = smoothed[i];
}

/**
 * Explicit ring-pair stitching. Counts are ladder values so `outer = inner · k`
 * exactly; each inner edge fans over its k outer edges and closes with one
 * triangle, which is watertight and T-junction free. Winding matches the old
 * uniform grid (a, c, b) / (b, c, d) so the cap still faces the sky.
 */
function stitchRings(ringStart: Uint32Array, ringSegments: Uint32Array, rings: number): Uint32Array {
  const tris: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    const ni = ringSegments[ring];
    const no = ringSegments[ring + 1];
    const bi = ringStart[ring];
    const bo = ringStart[ring + 1];
    const k = Math.max(1, Math.round(no / ni));
    for (let i = 0; i < ni; i++) {
      const inA = bi + i;
      const inB = bi + ((i + 1) % ni);
      if (ni > 1) tris.push(inA, bo + ((i * k) % no), inB);
      for (let j = 0; j < k; j++) {
        tris.push(inB, bo + ((i * k + j) % no), bo + ((i * k + j + 1) % no));
      }
    }
  }
  return Uint32Array.from(tris);
}

/**
 * PER-VERTEX AMBIENT OCCLUSION, baked at build time (graphics-06 phase 1).
 *
 * A horizon estimate over the grid's OWN neighbourhood: eight directions in
 * ring/segment index space, three strides each, so it costs 24 array reads per
 * vertex and not one extra evaluation of the heightfield, and nothing per
 * frame. Creases, cave-mouth trenches, terrace undersides and the inside of a
 * caldera come out darker than an open beach; ridges stay open.
 */
function bakeVertexAO(
  positions: Float32Array,
  ringStart: Uint32Array,
  ringSegments: Uint32Array,
  rings: number,
): Float32Array {
  const count = positions.length / 3;
  const ao = new Float32Array(count);
  const STRIDES = [1, 2, 5];
  for (let ring = 0; ring <= rings; ring++) {
    const segs = ringSegments[ring];
    const base = ringStart[ring];
    for (let s = 0; s < segs; s++) {
      const i = base + s;
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const u = s / segs;
      let occ = 0;
      let dirs = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let ds = -1; ds <= 1; ds++) {
          if (dr === 0 && ds === 0) continue;
          let horizon = 0;
          for (const step of STRIDES) {
            const nr = ring + dr * step;
            if (nr < 0 || nr > rings) continue;
            const nu = u + (ds * step) / Math.max(segs, 1);
            const n = ringVertexAt(ringStart, ringSegments, nr, nu - Math.floor(nu));
            const dxn = positions[n * 3] - x;
            const dyn = positions[n * 3 + 1] - y;
            const dzn = positions[n * 3 + 2] - z;
            const run = Math.hypot(dxn, dzn);
            if (run < 0.05) continue;
            const sinTheta = dyn / Math.hypot(run, dyn);
            if (sinTheta > horizon) horizon = sinTheta;
          }
          occ += horizon;
          dirs++;
        }
      }
      // 0.35 floor: a crease still reads as rock, never as a black hole.
      ao[i] = dirs > 0 ? clamp(1 - (occ / dirs) * 1.35, 0.35, 1) : 1;
    }
  }
  return ao;
}

/** One triangle hit under a query point, in island-local space. */
export type GridHit = {
  /** Interpolated drawn-surface height. */
  y: number;
  /** Unit triangle normal; `ny` is the cosine of the slope. */
  nx: number; ny: number; nz: number;
  /** Barycentric weights and the three vertex indices, for per-vertex lookups. */
  w0: number; w1: number; w2: number;
  a: number; b: number; c: number;
};

/**
 * THE DRAWN GROUND, read back.
 *
 * A uniform XZ bucket grid over one island's terrain triangles (counting sort
 * into flat typed arrays, no per-cell arrays, no garbage), so "what is the
 * height of the ground here" is one cell index plus a barycentric test per
 * triangle in that cell. This is the port of the client's MeshGround with THREE
 * taken out, so the SERVER can stand a player on the same triangles the player
 * is looking at instead of on the analytic field the mesh only approximates.
 *
 * Build cost is ~2 ms and ~180 KB per island; the server builds one per island
 * once, at map generation, never inside a tick.
 */
export class GridGround {
  private readonly pos: Float32Array;
  private readonly tri: Uint32Array;
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cellStart: Uint32Array;
  private readonly cellTris: Uint32Array;
  /** Highest and lowest drawn vertex, for cheap rejection. */
  readonly maxY: number;
  readonly minY: number;

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.pos = positions;
    this.tri = indices;
    const triCount = Math.floor(indices.length / 3);
    let lox = Infinity; let hix = -Infinity; let loz = Infinity; let hiz = -Infinity;
    let loy = Infinity; let hiy = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]; const y = positions[i + 1]; const z = positions[i + 2];
      if (x < lox) lox = x;
      if (x > hix) hix = x;
      if (z < loz) loz = z;
      if (z > hiz) hiz = z;
      if (y < loy) loy = y;
      if (y > hiy) hiy = y;
    }
    this.minY = loy;
    this.maxY = hiy;
    const span = Math.max(hix - lox, hiz - loz, 1);
    this.cellSize = Math.max(3, span / 64);
    this.minX = lox - this.cellSize;
    this.minZ = loz - this.cellSize;
    this.nx = Math.ceil((hix - this.minX) / this.cellSize) + 2;
    this.nz = Math.ceil((hiz - this.minZ) / this.cellSize) + 2;

    const cells = this.nx * this.nz;
    const counts = new Uint32Array(cells + 1);
    const bounds = new Int32Array(triCount * 4);
    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3] * 3;
      const i1 = indices[t * 3 + 1] * 3;
      const i2 = indices[t * 3 + 2] * 3;
      const x0 = Math.min(positions[i0], positions[i1], positions[i2]);
      const x1 = Math.max(positions[i0], positions[i1], positions[i2]);
      const z0 = Math.min(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]);
      const z1 = Math.max(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]);
      const cx0 = clamp(Math.floor((x0 - this.minX) / this.cellSize), 0, this.nx - 1);
      const cx1 = clamp(Math.floor((x1 - this.minX) / this.cellSize), 0, this.nx - 1);
      const cz0 = clamp(Math.floor((z0 - this.minZ) / this.cellSize), 0, this.nz - 1);
      const cz1 = clamp(Math.floor((z1 - this.minZ) / this.cellSize), 0, this.nz - 1);
      bounds[t * 4] = cx0; bounds[t * 4 + 1] = cx1; bounds[t * 4 + 2] = cz0; bounds[t * 4 + 3] = cz1;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) counts[cz * this.nx + cx + 1]++;
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellTris = new Uint32Array(counts[cells]);
    const cursor = Uint32Array.from(counts.subarray(0, cells));
    for (let t = 0; t < triCount; t++) {
      const cx0 = bounds[t * 4]; const cx1 = bounds[t * 4 + 1];
      const cz0 = bounds[t * 4 + 2]; const cz1 = bounds[t * 4 + 3];
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) this.cellTris[cursor[cz * this.nx + cx]++] = t;
      }
    }
  }

  /** Highest drawn triangle under (x, z) in ISLAND-LOCAL space, or null. */
  hit(x: number, z: number): GridHit | null {
    const cx = Math.floor((x - this.minX) / this.cellSize);
    const cz = Math.floor((z - this.minZ) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return null;
    const cell = cz * this.nx + cx;
    const end = this.cellStart[cell + 1];
    let best: GridHit | null = null;
    for (let k = this.cellStart[cell]; k < end; k++) {
      const t = this.cellTris[k];
      const a = this.tri[t * 3]; const b = this.tri[t * 3 + 1]; const c = this.tri[t * 3 + 2];
      const ax = this.pos[a * 3]; const az = this.pos[a * 3 + 2];
      const bx = this.pos[b * 3]; const bz = this.pos[b * 3 + 2];
      const cxv = this.pos[c * 3]; const czv = this.pos[c * 3 + 2];
      const v0x = bx - ax; const v0z = bz - az;
      const v1x = cxv - ax; const v1z = czv - az;
      const den = v0x * v1z - v1x * v0z;
      if (den === 0) continue;
      const px = x - ax; const pz = z - az;
      const w1 = (px * v1z - v1x * pz) / den;
      const w2 = (v0x * pz - px * v0z) / den;
      if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
      const w0 = 1 - w1 - w2;
      const ay = this.pos[a * 3 + 1]; const by = this.pos[b * 3 + 1]; const cy = this.pos[c * 3 + 1];
      const y = w0 * ay + w1 * by + w2 * cy;
      if (best && y <= best.y) continue;
      const e0x = bx - ax; const e0y = by - ay; const e0z = bz - az;
      const e1x = cxv - ax; const e1y = cy - ay; const e1z = czv - az;
      let nx = e0y * e1z - e0z * e1y;
      let ny = e0z * e1x - e0x * e1z;
      let nz = e0x * e1y - e0y * e1x;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      best = { y, nx, ny, nz, w0, w1, w2, a, b, c };
    }
    return best;
  }

  /** Drawn ground height under (x, z), island-local, or null off the grid. */
  heightAt(x: number, z: number): number | null {
    const h = this.hit(x, z);
    return h ? h.y : null;
  }
}

/** Build the grid AND its sampler for one island (server path: no carve, no AO). */
export function buildIslandGridGround(island: Island): { grid: TerrainGrid; ground: GridGround } {
  const grid = buildTerrainGrid(island);
  return { grid, ground: new GridGround(grid.positions, grid.indices) };
}

/**
 * ONE GridGround per island, for the whole process.
 *
 * The world is FIXED (`test-world-fixed.mjs`: every match seed draws the same
 * Shattered Reach), so an island's grid is built at most once on the server and
 * once in the browser — ~15 ms and ~180 KB each, never inside a tick and never
 * per frame. The client REGISTERS the grid it already built for the mesh rather
 * than building a second one.
 */
const groundCache = new Map<string, GridGround>();

/** Publish the grid the renderer just drew, so nothing builds it twice. */
export function setIslandGround(islandId: string, positions: Float32Array, indices: Uint32Array): void {
  groundCache.set(islandId, new GridGround(positions, indices));
}

/**
 * WARM THE CACHE OFF-TICK (review-6 P2).
 *
 * The doc above says a grid is built "never inside a tick". On the server that
 * was not true: the only setIslandGround caller is the client's
 * TerrainMeshBuilder, so the server's first ask came from
 * PhysicsSystem.swimSeabedY -> drawnIslandSurfaceY -> getIslandGround, i.e. the
 * first time any swimmer entered an island's apron mid-match. Measured on the
 * owner's Air: 226 ms for all 14 islands, 29 ms worst (smuggler-s-rest) against
 * a 16 ms tick -- up to fourteen unpredictable two-tick overruns in the first
 * match of a process. Match.setupWorld calls this once, before the loop starts.
 *
 * Returns how many grounds it actually built (0 once the process is warm).
 */
export function warmIslandGrounds(islands: Island[]): number {
  let built = 0;
  for (const island of islands) {
    if (groundCache.has(island.id)) continue;
    getIslandGround(island);
    built += 1;
  }
  return built;
}

/** True when this island's drawn ground is already in the cache. */
export function hasIslandGround(islandId: string): boolean {
  return groundCache.has(islandId);
}

/** The drawn ground for one island, built on first ask and kept. */
export function getIslandGround(island: Island): GridGround {
  let g = groundCache.get(island.id);
  if (!g) {
    const grid = buildTerrainGrid(island);
    g = new GridGround(grid.positions, grid.indices);
    groundCache.set(island.id, g);
  }
  return g;
}

/** Drawn ground height at WORLD (x, z) for one island, or null off the cap. */
export function drawnIslandSurfaceY(island: Island, x: number, z: number): number | null {
  return getIslandGround(island).heightAt(x - island.position.x, z - island.position.z);
}
