/**
 * Convex-hull colliders for the cliff kit (b4.6c, islands-02). ONE owner of kit collision: the
 * walker / swimmer pushout (via resolvePropCollision, so server physics and client prediction run
 * the same code), every ray (via raymarchIslandSurface and intersectRayIslandProps: hitscan,
 * cannonballs, bot sight lines, aim assist) and the ship hull stations (PhysicsSystem).
 *
 * Data: src/shared/generated/kitColliders.json, written by scripts/blender/export_colliders.py from
 * the LOD0 GLBs (<= 6 hulls per piece, <= 32 vertices per hull, every drawn vertex enclosed). A hull
 * is a plane set: a point p is inside when n.p <= d for every row [nx, ny, nz, d] (piece frame:
 * game space, +Y up, origin = GLB origin).
 *
 * Placement (b4.6d) puts instances on `island.kitPieces` in WORLD coordinates; yaw follows the
 * project convention (yaw r faces (sin r, cos r); a piece's local +Z maps to that heading).
 * Pure and allocation-light: no Math.random, no per-call arrays on the hot paths.
 */
import type { Island, Vec3 } from './types/index.js';
import kitData from './generated/kitColliders.json' with { type: 'json' };

export interface KitHull {
  /** Flat [nx, ny, nz, d] rows. */
  planes: Float64Array;
  verts: readonly (readonly number[])[];
  min: readonly number[];
  max: readonly number[];
}

export interface KitPieceColliders {
  key: string;
  hulls: KitHull[];
  min: readonly number[];
  max: readonly number[];
  radiusXZ: number;
  /** Bounding-sphere radius about the piece origin (unscaled). */
  radius: number;
}

export interface KitPieceInstance {
  key: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale?: number;
}

/** Structural extension of Island: b4.6d adds `kitPieces` to the served world. */
export interface KitPlacedIsland {
  kitPieces?: readonly KitPieceInstance[];
}

interface RawPiece { hulls: { verts: number[][]; planes: number[][]; min: number[]; max: number[] }[]; min: number[]; max: number[]; radiusXZ: number }

const PIECES = new Map<string, KitPieceColliders>();
for (const [key, raw] of Object.entries((kitData as { pieces: Record<string, RawPiece> }).pieces)) {
  const hulls = raw.hulls.map((h) => {
    const planes = new Float64Array(h.planes.length * 4);
    h.planes.forEach((row, i) => { for (let c = 0; c < 4; c++) planes[i * 4 + c] = row[c]; });
    return { planes, verts: h.verts, min: h.min, max: h.max };
  });
  const ext = Math.max(Math.abs(raw.min[1]), Math.abs(raw.max[1]));
  PIECES.set(key, { key, hulls, min: raw.min, max: raw.max, radiusXZ: raw.radiusXZ, radius: Math.hypot(raw.radiusXZ, ext) });
}

export function getKitColliders(key: string): KitPieceColliders | null {
  return PIECES.get(key) ?? null;
}

export function kitColliderKeys(): string[] {
  return [...PIECES.keys()];
}

export function getIslandKitPieces(island: Island): readonly KitPieceInstance[] {
  return (island as Island & KitPlacedIsland).kitPieces ?? EMPTY;
}
const EMPTY: readonly KitPieceInstance[] = [];

/** Max distance (XZ) from the island centre any kit collider reaches, cached per instance list. */
const reachCache = new WeakMap<readonly KitPieceInstance[], number>();
export function getIslandKitReach(island: Island): number {
  const list = getIslandKitPieces(island);
  if (list.length === 0) return 0;
  let r = reachCache.get(list);
  if (r === undefined) {
    r = 0;
    for (const inst of list) {
      const piece = PIECES.get(inst.key);
      if (!piece) continue;
      r = Math.max(r, Math.hypot(inst.x - island.position.x, inst.z - island.position.z) + piece.radiusXZ * (inst.scale ?? 1));
    }
    reachCache.set(list, r);
  }
  return r;
}

/** max_i (n_i . p - d_i): < 0 inside, > 0 outside (a lower bound on the true distance outside). */
export function hullSignedDistance(hull: KitHull, x: number, y: number, z: number): number {
  const P = hull.planes;
  let s = -Infinity;
  for (let i = 0; i < P.length; i += 4) {
    const v = P[i] * x + P[i + 1] * y + P[i + 2] * z - P[i + 3];
    if (v > s) s = v;
  }
  return s;
}

export function pointInHull(hull: KitHull, x: number, y: number, z: number, margin = 0): boolean {
  return hullSignedDistance(hull, x, y, z) <= margin;
}

/** Entry distance of a ray (unit dir) into a hull within [0, tMax], 0 if it starts inside, else null. */
export function rayHull(hull: KitHull, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): number | null {
  const P = hull.planes;
  let t0 = 0;
  let t1 = tMax;
  for (let i = 0; i < P.length; i += 4) {
    const nx = P[i], ny = P[i + 1], nz = P[i + 2];
    const dist = nx * ox + ny * oy + nz * oz - P[i + 3];
    const denom = nx * dx + ny * dy + nz * dz;
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return null;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return null;
  }
  return t0;
}

/** Scratch for the world -> piece transform (hot paths reuse it). */
const L = { x: 0, y: 0, z: 0 };
function toLocal(inst: KitPieceInstance, x: number, y: number, z: number): typeof L {
  const s = inst.scale ?? 1;
  const c = Math.cos(inst.yaw);
  const sn = Math.sin(inst.yaw);
  const wx = x - inst.x;
  const wz = z - inst.z;
  L.x = (wx * c - wz * sn) / s;
  L.y = (y - inst.y) / s;
  L.z = (wx * sn + wz * c) / s;
  return L;
}

/** Nearest ray entry (unit direction, world space) into any kit piece on the island, or null. */
export function intersectRayKit(origin: Vec3, direction: Vec3, range: number, island: Island): number | null {
  const list = getIslandKitPieces(island);
  let best: number | null = null;
  for (const inst of list) {
    const piece = PIECES.get(inst.key);
    if (!piece) continue;
    const s = inst.scale ?? 1;
    // Broad phase: ray vs the bounding sphere.
    const rx = inst.x - origin.x, ry = inst.y - origin.y, rz = inst.z - origin.z;
    const along = rx * direction.x + ry * direction.y + rz * direction.z;
    const R = piece.radius * s;
    const perp2 = rx * rx + ry * ry + rz * rz - along * along;
    if (perp2 > R * R || along < -R || along - R > (best ?? range)) continue;
    const lo = toLocal(inst, origin.x, origin.y, origin.z);
    const ox = lo.x, oy = lo.y, oz = lo.z;
    const c = Math.cos(inst.yaw), sn = Math.sin(inst.yaw);
    const dx = direction.x * c - direction.z * sn;
    const dz = direction.x * sn + direction.z * c;
    const limit = (best ?? range) / s;
    for (const hull of piece.hulls) {
      const t = rayHull(hull, ox, oy, oz, dx, direction.y, dz, limit);
      if (t !== null && (best === null || t * s < best)) best = t * s;
    }
  }
  return best;
}

/** Deepest horizontal penetration of a vertical segment [y0, y1] of radius r into the kit:
 *  { nx, nz } is the unit XZ direction out of the hull, pen the XZ distance to clear it. */
export interface KitPenetration { nx: number; nz: number; pen: number }
const STEEP = 0.7; // |ny| below this = a wall plane (push sideways); above = a floor/roof

function hullHorizontalPen(hull: KitHull, x: number, y: number, z: number, r: number, out: KitPenetration): boolean {
  const P = hull.planes;
  let any = false;
  let bestDelta = Infinity;
  let bx = 0, bz = 0;
  for (let i = 0; i < P.length; i += 4) {
    const s = P[i] * x + P[i + 1] * y + P[i + 2] * z - P[i + 3];
    if (s >= r) return false; // separated by this plane
    const ny = P[i + 1];
    if (Math.abs(ny) >= STEEP) continue;
    const hn = Math.hypot(P[i], P[i + 2]);
    const delta = (r - s) / hn;
    if (delta < bestDelta) { bestDelta = delta; bx = P[i] / hn; bz = P[i + 2] / hn; any = true; }
  }
  if (!any) return false;
  out.nx = bx; out.nz = bz; out.pen = bestDelta;
  return true;
}

const tmpPen: KitPenetration = { nx: 0, nz: 0, pen: 0 };

/** Deepest penetration of the segment (x, y0..y1, z, radius r) into any kit hull on the island,
 *  sampled at the segment ends and middle; world-space normal. Returns null when clear. */
export function kitPenetration(island: Island, x: number, y0: number, y1: number, z: number, r: number, out: KitPenetration): KitPenetration | null {
  const list = getIslandKitPieces(island);
  let found = false;
  out.pen = 0;
  for (const inst of list) {
    const piece = PIECES.get(inst.key);
    if (!piece) continue;
    const s = inst.scale ?? 1;
    const reach = piece.radiusXZ * s + r;
    const ddx = x - inst.x, ddz = z - inst.z;
    if (ddx * ddx + ddz * ddz > reach * reach) continue;
    if (y1 < inst.y + piece.min[1] * s - r || y0 > inst.y + piece.max[1] * s + r) continue;
    const c = Math.cos(inst.yaw), sn = Math.sin(inst.yaw);
    for (let k = 0; k < 3; k++) {
      const y = k === 0 ? y0 : k === 1 ? (y0 + y1) * 0.5 : y1;
      const lo = toLocal(inst, x, y, z);
      for (const hull of piece.hulls) {
        if (!hullHorizontalPen(hull, lo.x, lo.y, lo.z, r / s, tmpPen)) continue;
        if (tmpPen.pen * s > out.pen) {
          // piece -> world: x = lx cos + lz sin, z = lz cos - lx sin
          out.nx = tmpPen.nx * c + tmpPen.nz * sn;
          out.nz = tmpPen.nz * c - tmpPen.nx * sn;
          out.pen = tmpPen.pen * s;
          found = true;
        }
      }
    }
  }
  return found ? out : null;
}

/** Band of a walker/swimmer capsule tested against kit walls: above the step-up band, below the head. */
export const KIT_STEP_BAND = 0.45;

const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const capPen: KitPenetration = { nx: 0, nz: 0, pen: 0 };
/**
 * Push a standing capsule (feet at pos.y, height h, radius r) out of every kit wall on the island,
 * XZ only (relaxed up to 4 passes so a corner between two hulls clears). Shared by the server walker
 * and swimmer and by client prediction through resolvePropCollision.
 */
export function resolveKitCollision(pos: Vec3, r: number, h: number, island: Island): { x: number; z: number; pushed: boolean } {
  let x = pos.x;
  let z = pos.z;
  let pushed = false;
  if (getIslandKitPieces(island).length === 0) return { x, z, pushed };
  const y0 = pos.y + Math.max(KIT_STEP_BAND, r);
  const y1 = Math.max(y0, pos.y + h - r);
  for (let pass = 0; pass < 4; pass++) {
    const p = kitPenetration(island, x, y0, y1, z, r, capPen);
    if (!p) break;
    x += p.nx * (p.pen + 1e-4);
    z += p.nz * (p.pen + 1e-4);
    pushed = true;
  }
  return { x, z, pushed };
}

/** Highest kit hull top under (x, z) at or below yRef (a walk surface: arch_b deck, shelves), or null. */
export function kitSupportY(island: Island, x: number, z: number, yRef: number): number | null {
  const t = intersectRayKit({ x, y: yRef, z }, DOWN, 200, island);
  return t !== null && t > 0 ? yRef - t : null;
}
