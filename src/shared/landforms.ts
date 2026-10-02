// Authored landform layer (D29, islands-01, b4.4b).
//
// The island heightfield in utils/index.ts is a radial profile plus three
// Gaussian hills and low fbm: it can make domes, not scarps, gorges, mesas or
// basins. This module adds a small set of TYPED, AUTHORED records evaluated on
// top of the natural surface by getIslandSurfaceY, after the natural relief and
// the coast blend (so a shelf or a headland is not erased by the shore drop)
// and BEFORE the structure stamps (buildings still sit on level discs) and the
// cave-mouth carve. The hook scales every delta by caveReliefWeight, so the
// protected cave corridors and the `baseRelief` topography the cave generator
// reads never change: adding a landform cannot reroll a cave network.
//
// Rules:
//   - Data, not dice: records live in LANDFORM_ROSTER keyed by the stable
//     island id. ZERO rng draws (no Math.random, no seeded stream), so the
//     server, the client mesh and client prediction read the identical field.
//   - Coordinates are island-local metres (x - island.position.x,
//     z - island.position.z), unrotated.
//   - Each island's records are indexed in a 16 m bucket hash; a sample
//     evaluates at most LANDFORM_MAX_PER_SAMPLE (4) records, in authored order.
//     test-island-relief fails any roster island whose densest cell holds more.
//   - Authoring (the records themselves) lands in b4.4e-h; this file is the
//     evaluator, the index and the exports the water/stream/POI slices read.

export type LandformPoint = readonly [number, number];

export type LandformKind =
  | 'scarp' | 'valley' | 'gorge' | 'mesa' | 'basin' | 'dune_field'
  | 'rock_shelf' | 'terrace_run' | 'headland' | 'caldera' | 'meadow' | 'arch_site';

interface LandformBase {
  /** Stable label for gates and reports (e.g. 'castaway-plateau-scarp'). */
  readonly id: string;
}

/** A step along a polyline. The HIGH side is the side where
 *  cross(segmentDir, p - segmentStart) > 0 (left of the walking direction in
 *  x/z). `raise` lifts the high side, `cut` lowers the low side. The face is
 *  `face` metres wide (1.5-3 m reads as 60-75 deg for a 5+ m step); the moved
 *  ground eases back to the natural surface `reach` metres from the face. */
export interface ScarpLandform extends LandformBase {
  readonly kind: 'scarp';
  readonly path: readonly LandformPoint[];
  readonly height: number;
  readonly face?: number;
  readonly reach?: number;
  readonly mode?: 'raise' | 'cut';
  /** Metres over which the step fades in from each path end (default 8). */
  readonly taper?: number;
}

/** A cut whose floor is a MONOTONE stream bed: the path runs head (inland) ->
 *  mouth (sea); the bed falls linearly from bedHeadY to bedMouthY. The cut only
 *  ever lowers ground (min with the natural surface). valley = open U walls,
 *  gorge = near-vertical walls. */
export interface ValleyLandform extends LandformBase {
  readonly kind: 'valley' | 'gorge';
  readonly path: readonly LandformPoint[];
  readonly bedHeadY: number;
  readonly bedMouthY: number;
  /** Full width of the flat bed (m). */
  readonly floorWidth: number;
  /** Full width beyond which the cut fades out (m). */
  readonly topWidth: number;
  /** Wall rise per metre beyond the bed (default valley 0.55, gorge 2.6). */
  readonly wallSlope?: number;
}

export interface MesaRamp {
  /** Island-local heading of the ramp axis from the mesa centre (radians, atan2(z, x)). */
  readonly angle: number;
  readonly halfWidth: number;
  /** Horizontal run of the ramp from the rim down to the surrounding ground. */
  readonly run: number;
}

/** A flat cap at topY with a cliff ring `face` wide; ramps soften the ring. */
export interface MesaLandform extends LandformBase {
  readonly kind: 'mesa';
  readonly center: LandformPoint;
  readonly radius: number;
  readonly topY: number;
  readonly face?: number;
  readonly ramps?: readonly MesaRamp[];
  /** Ladder sites on the cliff ring (island-local headings, radians). Data
   *  only: the height field keeps the cliff; the climb/kit lanes mount a
   *  ladder at center + (radius + face / 2) * (cos, sin)(angle). */
  readonly ladders?: readonly number[];
}

/** A closed depression. The floor sits `depth` below spillY; a low berm keeps
 *  the rim at least 0.3 m above spillY so a pond plane at spillY never leaks. */
export interface BasinLandform extends LandformBase {
  readonly kind: 'basin';
  readonly center: LandformPoint;
  readonly radius: number;
  readonly spillY: number;
  readonly depth: number;
  /** Fraction of the radius that is flat floor (default 0.4). */
  readonly flat?: number;
}

/** Ridged sand on a beach band along a path; only ever raises ground. */
export interface DuneFieldLandform extends LandformBase {
  readonly kind: 'dune_field';
  readonly path: readonly LandformPoint[];
  readonly width: number;
  readonly amplitude?: number;
  readonly wavelength?: number;
}

/** A flat platform at y (0.3-0.8 m on rocky arcs: tide-pool shelves). */
export interface RockShelfLandform extends LandformBase {
  readonly kind: 'rock_shelf';
  readonly center: LandformPoint;
  readonly radius: number;
  readonly y: number;
  /** Width of the drop at the edge (default 1.2 m). */
  readonly edge?: number;
}

/** Sharp walkable steps inside a band along a path (the only place the
 *  terraced look is meant to appear once b4.4e removes the global terracing). */
export interface TerraceRunLandform extends LandformBase {
  readonly kind: 'terrace_run';
  readonly path: readonly LandformPoint[];
  readonly width: number;
  readonly stepHeight: number;
  /** Fraction of each step that is riser (default 0.25). */
  readonly riser?: number;
  readonly edge?: number;
}

/** A ridge pushed seaward: path base (on land) -> tip (past the rim); crest
 *  falls linearly from crestBaseY to crestTipY; steep flanks. Raises only. */
export interface HeadlandLandform extends LandformBase {
  readonly kind: 'headland';
  readonly path: readonly LandformPoint[];
  readonly crestBaseY: number;
  readonly crestTipY: number;
  readonly topHalfWidth: number;
  readonly sideSlope?: number;
}

export interface CalderaBreach {
  readonly angle: number;
  readonly halfWidth: number;
  readonly sillY: number;
}

/** A crater: flat floor at floorY inside the rim, rim crest at rimY on
 *  rimRadius, outer flank eases back to the natural surface over outerRun;
 *  an optional breach notch lowers the rim to sillY. */
export interface CalderaLandform extends LandformBase {
  readonly kind: 'caldera';
  readonly center: LandformPoint;
  readonly rimRadius: number;
  readonly rimY: number;
  readonly floorY: number;
  readonly rimWidth?: number;
  readonly outerRun?: number;
  readonly breach?: CalderaBreach;
}

/** Marker only: an authored flat meadow the relief gate's 60 x 60 m
 *  flat-window rule exempts. Changes no height, is never indexed. */
export interface MeadowLandform extends LandformBase {
  readonly kind: 'meadow';
  readonly center: LandformPoint;
  readonly radius: number;
}

/** Marker only: a sea-level arch site (b4.4e). Changes no height and is never
 *  indexed; the cliff/arch kit places the arch mesh here, spanning `radius`
 *  each side of center across `heading` (the seaward direction, radians). */
export interface ArchSiteLandform extends LandformBase {
  readonly kind: 'arch_site';
  readonly center: LandformPoint;
  readonly radius: number;
  readonly heading: number;
}

export type Landform =
  | ScarpLandform | ValleyLandform | MesaLandform | BasinLandform | DuneFieldLandform
  | RockShelfLandform | TerraceRunLandform | HeadlandLandform | CalderaLandform | MeadowLandform
  | ArchSiteLandform;

export const LANDFORM_BUCKET_M = 16;
export const LANDFORM_MAX_PER_SAMPLE = 4;

/** The authored roster, keyed by island id. Each authoring slice (b4.4e-h)
 *  that adds records re-pins the fixed world once. Island-local metres. */
export const LANDFORM_ROSTER: Readonly<Record<string, readonly Landform[]>> = Object.freeze({
  // b4.4e: the archetypes deliver their names (islands-15).
  // Old Maw Caldera: the crater sits on the open south-west massif, clear of
  // the north-east cave network (no cave collar inside rim + flank). Rim at
  // 30 / (30 + 20) = 0.6 of the cone radius, floor 30 m below the crest, one
  // breach notch to the west-north-west (sill 3 m above the floor: the trail),
  // and a crater lake (basin; b4.7a draws the pond plane at spillY).
  'old-maw-caldera': [
    {
      id: 'old-maw-crater', kind: 'caldera', center: [-38, -18], rimRadius: 30, rimY: 62, floorY: 32,
      rimWidth: 10, outerRun: 20, breach: { angle: 2.76, halfWidth: 3.5, sillY: 35 },
    },
    { id: 'old-maw-crater-lake', kind: 'basin', center: [-38, -18], radius: 11, spillY: 32, depth: 3, flat: 0.45 },
  ],
  // Parley Point: a true mesa. Flat top at 26 m (radius 28 m, ~2,460 m2), a
  // 3 m cliff face over 10-17 m surrounding ground, two 46 m ramps (one toward
  // the dock, one north-east; both under 37 deg) and one ladder site on the west face.
  'parley-point': [
    {
      id: 'parley-mesa', kind: 'mesa', center: [5, 0], radius: 28, topY: 26, face: 3,
      ramps: [{ angle: -2.1, halfWidth: 3, run: 46 }, { angle: 0.7, halfWidth: 3, run: 46 }],
      ladders: [Math.PI],
    },
  ],
  // Kraken Tooth: two basalt fangs (steep headland spires raised on the two
  // natural summits at (-32, -32) and (30, 30)) over a low central saddle, and
  // a sea-level arch site on the north-west shore between them.
  'kraken-tooth': [
    { id: 'kraken-fang-west', kind: 'headland', path: [[-32, -32], [-36, -36]], crestBaseY: 52, crestTipY: 48, topHalfWidth: 1.5, sideSlope: 2.4 },
    { id: 'kraken-fang-east', kind: 'headland', path: [[30, 30], [34, 34]], crestBaseY: 49, crestTipY: 45, topHalfWidth: 1.5, sideSlope: 2.4 },
    { id: 'kraken-arch', kind: 'arch_site', center: [-67, 67], radius: 7, heading: 2.36 },
  ],

  // b4.4f: authored relief for four dome islands (islands-01, PLAN 3.14 table).
  // Smuggler's Rest: a limestone scarp splits the tavern beach (south, -z)
  // from the jungle interior (raised side +z; the path ends taper into the two
  // walk-up ramps, the cache pad at (4, -22) sits east of the face), a stream
  // valley from an interior spring out to the north-east grotto cove, and a
  // dune field on the white-sand west arc.
  'smuggler-s-rest': [
    { id: 'smuggler-scarp', kind: 'scarp', path: [[-50, -34], [-6, -32]], height: 10, face: 2, reach: 36, taper: 10 },
    {
      id: 'smuggler-spring-valley', kind: 'valley', path: [[-6, 22], [20, 34], [52, 52]],
      bedHeadY: 11, bedMouthY: -0.5, floorWidth: 3, topWidth: 16, wallSlope: 1.2,
    },
    { id: 'smuggler-dunes', kind: 'dune_field', path: [[-88, -18], [-88, 18]], width: 12, amplitude: 1.2, wavelength: 8 },
  ],
  // Rumrunner Key: a 7 m windward bluff on the east shore (inland side raised,
  // the face drops to the seaward bench), a freshwater pond behind the west
  // dunes, and the still-grove stream past the rum still pad (4, -21) to the
  // south shore. The lee mangrove fringe is flora (b4.6).
  'rumrunner-key': [
    { id: 'rumrunner-bluff', kind: 'scarp', path: [[37, -28], [37, 28]], height: 7, face: 2, reach: 30, taper: 8 },
    { id: 'rumrunner-pond', kind: 'basin', center: [-30, 0], radius: 7, spillY: 5, depth: 1.5, flat: 0.45 },
    { id: 'rumrunner-dunes', kind: 'dune_field', path: [[-44, -16], [-44, 16]], width: 8, amplitude: 1.0, wavelength: 7 },
    {
      id: 'rumrunner-still-stream', kind: 'valley', path: [[14, -12], [14, -30], [8, -58]],
      bedHeadY: 7.5, bedMouthY: -0.3, floorWidth: 2.5, topWidth: 12, wallSlope: 1.1,
    },
  ],
  // Mermaid's Folly: a 6 m scarp lifts the summit ridge over the dock slope,
  // a stream valley runs from the ridge into the lagoon, a tide-pool shelf sits
  // below the shrine (stamp at (-9, 58) stays authoritative), and the sea-arch
  // site spans the bay mouth (the arch mesh is the cliff kit's, b4.5).
  'mermaid-s-folly': [
    { id: 'mermaid-ridge-scarp', kind: 'scarp', path: [[-16, -36], [30, -36]], height: 6, face: 2, reach: 30, taper: 10 },
    {
      id: 'mermaid-lagoon-stream', kind: 'valley', path: [[30, -16], [12, 14], [2, 30]],
      bedHeadY: 9, bedMouthY: -0.4, floorWidth: 2.5, topWidth: 14, wallSlope: 1.1,
    },
    { id: 'mermaid-shrine-shelf', kind: 'rock_shelf', center: [-20, 66], radius: 6, y: 0.5 },
    { id: 'mermaid-bay-arch', kind: 'arch_site', center: [-6, 60], radius: 8, heading: 1.57 },
  ],
  // Castaway Reach: a central plateau east of the cave network (mesa top 26 m
  // over 11-13 m ground: a 14-15 m cliff; one ramp toward the dock, one ladder
  // site on the west face), the river off the plateau foot (the falls drop off
  // the cliff into its head) to the south-east shore, the fort headland (the
  // ground north of the fort pad is cut 7 m: the fort stands on a scarp), a
  // 6 m seaward bluff on the east shore, and a pond in the northern lowland.
  'castaway-reach': [
    {
      id: 'castaway-plateau', kind: 'mesa', center: [30, -8], radius: 18, topY: 26, face: 3,
      ramps: [{ angle: 0.83, halfWidth: 3, run: 44 }], ladders: [Math.PI],
    },
    {
      id: 'castaway-river', kind: 'gorge', path: [[46, -14], [70, -30], [96, -46]],
      bedHeadY: 7, bedMouthY: -0.4, floorWidth: 4, topWidth: 18, wallSlope: 2.4,
    },
    { id: 'castaway-fort-scarp', kind: 'scarp', path: [[50, 30], [2, 30]], height: 7, face: 2, reach: 16, taper: 8, mode: 'cut' },
    { id: 'castaway-east-bluff', kind: 'scarp', path: [[92, -26], [88, 16]], height: 6, face: 2, reach: 22, taper: 8 },
    { id: 'castaway-pond', kind: 'basin', center: [0, 64], radius: 8, spillY: 7, depth: 1.8, flat: 0.45 },
  ],
});

// ── math (local: utils/index.ts imports this module) ─────────────────────────
const sstep = (e0: number, e1: number, x: number): number => {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const angDiff = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

interface Polyline {
  readonly xs: Float64Array; readonly zs: Float64Array;
  /** Cumulative arc length at each vertex. */
  readonly cum: Float64Array;
  readonly length: number;
}

function compilePolyline(path: readonly LandformPoint[]): Polyline {
  const n = path.length;
  const xs = new Float64Array(n), zs = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = path[i][0]; zs[i] = path[i][1];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { xs, zs, cum, length: cum[n - 1] || 0 };
}

interface PolyHit { dist: number; side: number; s: number }
const hit: PolyHit = { dist: 0, side: 0, s: 0 };

/** Nearest point on the polyline: unsigned distance, side sign (+1 = the side
 *  where cross(dir, p - a) > 0) and arc length s of the nearest point. Reuses
 *  one scratch object (hot path, single-threaded). */
function nearestOnPolyline(pl: Polyline, px: number, pz: number): PolyHit {
  let best = Infinity, bestSide = 0, bestS = 0;
  for (let i = 0; i < pl.xs.length - 1; i++) {
    const ax = pl.xs[i], az = pl.zs[i];
    const dx = pl.xs[i + 1] - ax, dz = pl.zs[i + 1] - az;
    const len2 = dx * dx + dz * dz;
    const ox = px - ax, oz = pz - az;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (ox * dx + oz * dz) / len2)) : 0;
    const qx = ox - dx * t, qz = oz - dz * t;
    const d = Math.hypot(qx, qz);
    if (d < best) {
      best = d;
      const cross = dx * oz - dz * ox;
      bestSide = cross > 0 ? 1 : cross < 0 ? -1 : 0;
      bestS = pl.cum[i] + Math.sqrt(len2) * t;
    }
  }
  hit.dist = best; hit.side = bestSide; hit.s = bestS;
  return hit;
}

interface Compiled {
  readonly rec: Landform;
  readonly pl: Polyline | null;
  readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number;
}

function pathBounds(path: readonly LandformPoint[], pad: number): [number, number, number, number] {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of path) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return [minX - pad, maxX + pad, minZ - pad, maxZ + pad];
}

const scarpReach = (r: ScarpLandform): number => r.reach ?? Math.max(12, r.height * 3);
const headlandSlope = (r: HeadlandLandform): number => r.sideSlope ?? 2.2;

/** Conservative island-local AABB of everything a record can move. */
export function landformBounds(rec: Landform): [number, number, number, number] {
  switch (rec.kind) {
    case 'scarp': return pathBounds(rec.path, scarpReach(rec) + (rec.face ?? 2));
    case 'valley': case 'gorge': return pathBounds(rec.path, rec.topWidth / 2 + 4);
    case 'dune_field': return pathBounds(rec.path, rec.width / 2);
    case 'terrace_run': return pathBounds(rec.path, rec.width / 2);
    case 'headland': {
      const crest = Math.max(rec.crestBaseY, rec.crestTipY);
      return pathBounds(rec.path, rec.topHalfWidth + (crest + 12) / headlandSlope(rec));
    }
    case 'mesa': {
      const pad = rec.radius + Math.max(rec.face ?? 2.5, ...(rec.ramps ?? []).map((m) => m.run));
      return [rec.center[0] - pad, rec.center[0] + pad, rec.center[1] - pad, rec.center[1] + pad];
    }
    case 'basin': {
      const pad = rec.radius + 6;
      return [rec.center[0] - pad, rec.center[0] + pad, rec.center[1] - pad, rec.center[1] + pad];
    }
    case 'caldera': {
      const pad = rec.rimRadius + (rec.outerRun ?? 30);
      return [rec.center[0] - pad, rec.center[0] + pad, rec.center[1] - pad, rec.center[1] + pad];
    }
    case 'rock_shelf': case 'meadow': case 'arch_site': {
      const pad = rec.radius;
      return [rec.center[0] - pad, rec.center[0] + pad, rec.center[1] - pad, rec.center[1] + pad];
    }
  }
}

export interface LandformIndex {
  readonly compiled: readonly Compiled[];
  /** Bucket key -> indices into `compiled`, authored order. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
  /** Densest bucket (records whose AABB overlaps one 16 m cell). */
  readonly maxPerCell: number;
  /** Buckets holding more than LANDFORM_MAX_PER_SAMPLE records. */
  readonly overflowCells: number;
}

const cellKey = (cx: number, cz: number): number => (cx + 2048) * 4096 + (cz + 2048);

export function buildLandformIndex(records: readonly Landform[]): LandformIndex {
  const compiled: Compiled[] = [];
  const cells = new Map<number, number[]>();
  for (const rec of records) {
    if (rec.kind === 'meadow' || rec.kind === 'arch_site') continue;
    const [minX, maxX, minZ, maxZ] = landformBounds(rec);
    const pl = 'path' in rec ? compilePolyline(rec.path) : null;
    const idx = compiled.push({ rec, pl, minX, maxX, minZ, maxZ }) - 1;
    for (let cx = Math.floor(minX / LANDFORM_BUCKET_M); cx <= Math.floor(maxX / LANDFORM_BUCKET_M); cx++) {
      for (let cz = Math.floor(minZ / LANDFORM_BUCKET_M); cz <= Math.floor(maxZ / LANDFORM_BUCKET_M); cz++) {
        const k = cellKey(cx, cz);
        const list = cells.get(k);
        if (list) list.push(idx); else cells.set(k, [idx]);
      }
    }
  }
  let maxPerCell = 0, overflowCells = 0;
  for (const list of cells.values()) {
    maxPerCell = Math.max(maxPerCell, list.length);
    if (list.length > LANDFORM_MAX_PER_SAMPLE) overflowCells++;
  }
  return { compiled, cells, maxPerCell, overflowCells };
}

const EMPTY_INDEX: LandformIndex = buildLandformIndex([]);
const indexCache = new WeakMap<object, LandformIndex>();
const overrides = new WeakMap<object, readonly Landform[]>();

/** Authored records for an island (by stable id), or a test override. */
export function getIslandLandforms(island: { id: string }): readonly Landform[] {
  return overrides.get(island) ?? LANDFORM_ROSTER[island.id] ?? [];
}

/** Gates only: evaluate `records` on this island object instead of the roster. */
export function overrideIslandLandforms(island: { id: string }, records: readonly Landform[] | null): void {
  if (records) overrides.set(island, records); else overrides.delete(island);
  indexCache.delete(island);
}

export function getLandformIndex(island: { id: string }): LandformIndex {
  let idx = indexCache.get(island);
  if (!idx) {
    const recs = getIslandLandforms(island);
    idx = recs.length ? buildLandformIndex(recs) : EMPTY_INDEX;
    indexCache.set(island, idx);
  }
  return idx;
}

/** Monotone stream bed height at arc fraction u (0 = head, 1 = mouth). */
export function landformStreamBedY(rec: ValleyLandform, u: number): number {
  return mix(rec.bedHeadY, rec.bedMouthY, Math.max(0, Math.min(1, u)));
}

/** Water planes the authored layer promises: basin spill heights. */
export function getLandformPonds(island: { id: string }): Array<{ id: string; x: number; z: number; radius: number; y: number }> {
  return getIslandLandforms(island)
    .filter((r): r is BasinLandform => r.kind === 'basin')
    .map((r) => ({ id: r.id, x: r.center[0], z: r.center[1], radius: r.radius, y: r.spillY }));
}

/** Sea-level arch sites (markers) the cliff/arch kit mounts. */
export function getLandformArchSites(island: { id: string }): ArchSiteLandform[] {
  return getIslandLandforms(island).filter((r): r is ArchSiteLandform => r.kind === 'arch_site');
}

/** Ladder sites on mesa cliff rings: island-local foot position, heading and
 *  the height the ladder climbs to (the mesa top). */
export function getLandformLadders(island: { id: string }): Array<{ id: string; x: number; z: number; angle: number; topY: number }> {
  const out: Array<{ id: string; x: number; z: number; angle: number; topY: number }> = [];
  for (const r of getIslandLandforms(island)) {
    if (r.kind !== 'mesa' || !r.ladders) continue;
    const reach = r.radius + (r.face ?? 2.5) / 2;
    r.ladders.forEach((a, i) => out.push({
      id: `${r.id}-ladder-${i}`, x: r.center[0] + Math.cos(a) * reach, z: r.center[1] + Math.sin(a) * reach, angle: a, topY: r.topY,
    }));
  }
  return out;
}

function evalOne(c: Compiled, lx: number, lz: number, y: number): number {
  const rec = c.rec;
  switch (rec.kind) {
    case 'scarp': {
      const h = nearestOnPolyline(c.pl!, lx, lz);
      const face = rec.face ?? 2;
      const reach = scarpReach(rec);
      const back = Math.max(8, reach * 0.5);
      const taper = rec.taper ?? 8;
      const endW = c.pl!.length > 0 ? sstep(0, taper, Math.min(h.s, c.pl!.length - h.s)) : 0;
      if (endW <= 0) return y;
      const s = h.dist * (h.side >= 0 ? 1 : -1);
      const step = sstep(-face / 2, face / 2, s);
      if ((rec.mode ?? 'raise') === 'raise') {
        return y + rec.height * step * (1 - sstep(reach - back, reach, s)) * endW;
      }
      return y - rec.height * (1 - step) * (1 - sstep(reach - back, reach, -s)) * endW;
    }
    case 'valley': case 'gorge': {
      const h = nearestOnPolyline(c.pl!, lx, lz);
      const fh = rec.floorWidth / 2, th = rec.topWidth / 2;
      if (h.dist >= th + 4) return y;
      const slope = rec.wallSlope ?? (rec.kind === 'gorge' ? 2.6 : 0.55);
      const u = c.pl!.length > 0 ? h.s / c.pl!.length : 0;
      const target = landformStreamBedY(rec, u) + slope * Math.max(0, h.dist - fh);
      return mix(y, Math.min(y, target), 1 - sstep(th, th + 4, h.dist));
    }
    case 'mesa': {
      const dx = lx - rec.center[0], dz = lz - rec.center[1];
      const d = Math.hypot(dx, dz);
      const face = rec.face ?? 2.5;
      let m = 1 - sstep(rec.radius - face / 2, rec.radius + face / 2, d);
      if (rec.ramps && d > rec.radius - face) {
        const a = Math.atan2(dz, dx);
        for (const ramp of rec.ramps) {
          const da = angDiff(a, ramp.angle);
          if (Math.abs(da) > Math.PI / 2) continue;
          const lateral = Math.abs(Math.sin(da)) * d;
          const inCorridor = 1 - sstep(ramp.halfWidth, ramp.halfWidth + 1.5, lateral);
          if (inCorridor <= 0) continue;
          const rampM = 1 - sstep(rec.radius - 1, rec.radius + ramp.run, d);
          m = Math.max(m, rampM * inCorridor);
        }
      }
      return m > 0 ? mix(y, rec.topY, m) : y;
    }
    case 'basin': {
      const d = Math.hypot(lx - rec.center[0], lz - rec.center[1]);
      const floorY = rec.spillY - rec.depth;
      let out = y;
      if (d < rec.radius) {
        const bowl = mix(floorY, rec.spillY + 0.3, sstep(rec.radius * (rec.flat ?? 0.4), rec.radius, d));
        out = Math.min(out, bowl);
      }
      if (d >= rec.radius - 0.5) {
        const berm = rec.spillY + 0.3 - 0.35 * Math.max(0, Math.abs(d - (rec.radius + 1.5)) - 1);
        out = Math.max(out, berm);
      }
      return out;
    }
    case 'dune_field': {
      const h = nearestOnPolyline(c.pl!, lx, lz);
      const half = rec.width / 2;
      if (h.dist >= half) return y;
      const L = c.pl!.length;
      const mask = (1 - sstep(half * 0.55, half, h.dist)) * sstep(0, 6, Math.min(h.s, L - h.s));
      const wl = rec.wavelength ?? 9;
      const across = h.dist * (h.side >= 0 ? 1 : -1);
      const phase = (h.s / wl) * Math.PI + 0.8 * Math.sin(across / (wl * 1.7) + h.s / (wl * 3.1));
      const ridge = Math.pow(1 - Math.abs(Math.sin(phase)), 1.6);
      return y + (rec.amplitude ?? 1.2) * ridge * mask;
    }
    case 'rock_shelf': {
      const d = Math.hypot(lx - rec.center[0], lz - rec.center[1]);
      const m = 1 - sstep(rec.radius - (rec.edge ?? 1.2), rec.radius, d);
      return m > 0 ? mix(y, rec.y, m) : y;
    }
    case 'terrace_run': {
      const h = nearestOnPolyline(c.pl!, lx, lz);
      const half = rec.width / 2;
      if (h.dist >= half) return y;
      const edge = Math.min(rec.edge ?? 4, half);
      const mask = (1 - sstep(half - edge, half, h.dist)) * sstep(0, edge, Math.min(h.s, c.pl!.length - h.s));
      const sh = rec.stepHeight;
      const k = Math.floor(y / sh);
      const frac = y / sh - k;
      const riser = rec.riser ?? 0.25;
      const stepped = (k + sstep(1 - riser, 1, frac)) * sh;
      return mix(y, stepped, mask);
    }
    case 'headland': {
      const h = nearestOnPolyline(c.pl!, lx, lz);
      const u = c.pl!.length > 0 ? h.s / c.pl!.length : 0;
      const crest = mix(rec.crestBaseY, rec.crestTipY, u);
      const target = crest - Math.max(0, h.dist - rec.topHalfWidth) * headlandSlope(rec);
      return Math.max(y, target);
    }
    case 'caldera': {
      const dx = lx - rec.center[0], dz = lz - rec.center[1];
      const d = Math.hypot(dx, dz);
      const rimW = rec.rimWidth ?? 10;
      const outer = rec.outerRun ?? 30;
      const inner = rec.rimRadius - rimW;
      let out: number;
      if (d <= rec.rimRadius) out = mix(rec.floorY, rec.rimY, sstep(inner, rec.rimRadius, d));
      else out = mix(rec.rimY, y, sstep(rec.rimRadius, rec.rimRadius + outer, d));
      if (rec.breach && d > inner * 0.7) {
        const a = Math.atan2(dz, dx);
        const da = angDiff(a, rec.breach.angle);
        if (Math.abs(da) < Math.PI / 2) {
          const lateral = Math.abs(Math.sin(da)) * d;
          const notch = 1 - sstep(rec.breach.halfWidth, rec.breach.halfWidth + 3, lateral);
          if (notch > 0) out = mix(out, Math.min(out, rec.breach.sillY), notch);
        }
      }
      return out;
    }
    case 'meadow': case 'arch_site':
      return y;
  }
}

/** The hook getIslandSurfaceY calls with the natural, coast-blended surface at
 *  island-local (lx, lz). Returns the authored surface (unchanged when the
 *  island has no records or none covers this bucket). Pure, zero rng. */
export function applyLandforms(island: { id: string }, lx: number, lz: number, y: number): number {
  const idx = getLandformIndex(island);
  if (idx.compiled.length === 0) return y;
  const list = idx.cells.get(cellKey(Math.floor(lx / LANDFORM_BUCKET_M), Math.floor(lz / LANDFORM_BUCKET_M)));
  if (!list) return y;
  const n = Math.min(list.length, LANDFORM_MAX_PER_SAMPLE);
  let out = y;
  for (let i = 0; i < n; i++) {
    const c = idx.compiled[list[i]];
    if (lx < c.minX || lx > c.maxX || lz < c.minZ || lz > c.maxZ) continue;
    out = evalOne(c, lx, lz, out);
  }
  return out;
}
