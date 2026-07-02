import type { Island, Ship, Vec3 } from './types/index.js';
import { SHIP_STATS } from './constants/index.js';
import {
  getIslandDistRatio,
  getIslandMaxRadius,
  getIslandSurfaceY,
  isInsideSwimHullFootprint,
} from './utils/index.js';

export interface SurfaceRaycastHit {
  hit: boolean;
  point: Vec3 | null;
  /** Distance to the hit, or `maxDist` when nothing was hit. */
  distance: number;
}

/** Coarse march step over island heightfields — refined by bisection on contact. */
const TERRAIN_STEP = 1.5;
/** Matches the shoreline ring PhysicsSystem collides ships against (distRatio 1.02). */
const TERRAIN_FOOTPRINT_LIMIT = 1.03;
const BISECT_ITERATIONS = 14;
const HULL_STEP = 0.5;

/**
 * [tEnter, tExit] of the ray's XZ track through a circle, clamped to [0, maxDist],
 * or null when the track misses entirely. Near-vertical rays inside the circle
 * yield the full [0, maxDist] interval.
 */
function rayCircleIntervalXZ(
  origin: Vec3,
  direction: Vec3,
  cx: number,
  cz: number,
  radius: number,
  maxDist: number,
): [number, number] | null {
  const ox = origin.x - cx;
  const oz = origin.z - cz;
  const a = direction.x * direction.x + direction.z * direction.z;
  if (a < 1e-8) {
    return ox * ox + oz * oz <= radius * radius ? [0, maxDist] : null;
  }
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const tNear = (-b - root) / (2 * a);
  const tFar = (-b + root) / (2 * a);
  if (tFar < 0 || tNear > maxDist) return null;
  return [Math.max(0, tNear), Math.min(maxDist, tFar)];
}

/** Generous upper bound on any island's peak (tallest mountains reach ~0.85r). */
function getIslandPeakBound(island: Island): number {
  return island.radius * 1.2 + 16;
}

function isInsideIslandTerrain(island: Island, x: number, y: number, z: number): boolean {
  const { distRatio } = getIslandDistRatio(island, x, z);
  if (distRatio > TERRAIN_FOOTPRINT_LIMIT) return false;
  return y <= getIslandSurfaceY(island, x, z);
}

/**
 * March a ray (normalized `direction`) against island terrain heightfields.
 * Broad-phase per island via its footprint radius, ~1.5m steps inside the
 * footprint, bisection refinement on the first inside/outside sign change.
 * Cove/archipelago water stays shootable because the heightfield itself dips
 * below the waterline there.
 */
export function raymarchIslandSurface(
  origin: Vec3,
  direction: Vec3,
  maxDist: number,
  islands: Island[],
): SurfaceRaycastHit {
  let bestDistance = Infinity;

  for (const island of islands) {
    const searchLimit = Math.min(maxDist, bestDistance);
    const interval = rayCircleIntervalXZ(
      origin,
      direction,
      island.position.x,
      island.position.z,
      getIslandMaxRadius(island) + TERRAIN_STEP,
      searchLimit,
    );
    if (!interval) continue;
    let [tEnter, tExit] = interval;

    // Vertical broad-phase: clamp the march to where the ray is below the peak bound.
    const peakBound = getIslandPeakBound(island);
    if (Math.abs(direction.y) > 1e-6) {
      const tAtBound = (peakBound - origin.y) / direction.y;
      if (direction.y > 0) tExit = Math.min(tExit, tAtBound);
      else tEnter = Math.max(tEnter, tAtBound);
    } else if (origin.y > peakBound) {
      continue;
    }
    if (tExit < tEnter) continue;

    let tPrev = tEnter;
    let prevInside = isInsideIslandTerrain(
      island,
      origin.x + direction.x * tEnter,
      origin.y + direction.y * tEnter,
      origin.z + direction.z * tEnter,
    );
    if (prevInside) {
      // Ray starts buried (e.g. muzzle pushed into a steep slope) — immediate hit.
      bestDistance = Math.min(bestDistance, tEnter);
      continue;
    }

    for (let t = tEnter + TERRAIN_STEP; ; t += TERRAIN_STEP) {
      const tSample = Math.min(t, tExit);
      const inside = isInsideIslandTerrain(
        island,
        origin.x + direction.x * tSample,
        origin.y + direction.y * tSample,
        origin.z + direction.z * tSample,
      );
      if (inside) {
        let lo = tPrev;
        let hi = tSample;
        for (let i = 0; i < BISECT_ITERATIONS; i++) {
          const mid = (lo + hi) * 0.5;
          if (isInsideIslandTerrain(
            island,
            origin.x + direction.x * mid,
            origin.y + direction.y * mid,
            origin.z + direction.z * mid,
          )) hi = mid;
          else lo = mid;
        }
        bestDistance = Math.min(bestDistance, hi);
        break;
      }
      tPrev = tSample;
      if (tSample >= tExit) break;
    }
  }

  if (bestDistance > maxDist) {
    return { hit: false, point: null, distance: maxDist };
  }
  return {
    hit: true,
    point: {
      x: origin.x + direction.x * bestDistance,
      y: origin.y + direction.y * bestDistance,
      z: origin.z + direction.z * bestDistance,
    },
    distance: bestDistance,
  };
}

/**
 * Distance at which a ray (normalized `direction`) enters a ship's hull, or null.
 * The hull is approximated as the oriented swim-hull footprint prism extruded
 * from the keel up to bulwark height — heads and chests above the deck rail
 * stay hittable, legs behind the bulwark and swimmers behind the hull do not.
 */
export function intersectRayShipHull(
  origin: Vec3,
  direction: Vec3,
  maxDist: number,
  ship: Pick<Ship, 'type' | 'position' | 'rotation'>,
): number | null {
  const stats = SHIP_STATS[ship.type];
  const minY = ship.position.y - stats.height * 0.72; // keel (matches swim-hull band)
  const maxY = ship.position.y + stats.height + 0.85; // deck + bulwark rail

  const interval = rayCircleIntervalXZ(
    origin,
    direction,
    ship.position.x,
    ship.position.z,
    stats.length * 0.55 + 0.6,
    maxDist,
  );
  if (!interval) return null;
  let [tEnter, tExit] = interval;

  // Clamp to the vertical band so above-rail / under-keel rays exit early.
  if (Math.abs(direction.y) > 1e-6) {
    const tA = (minY - origin.y) / direction.y;
    const tB = (maxY - origin.y) / direction.y;
    tEnter = Math.max(tEnter, Math.min(tA, tB));
    tExit = Math.min(tExit, Math.max(tA, tB));
  } else if (origin.y < minY || origin.y > maxY) {
    return null;
  }
  if (tExit < tEnter) return null;

  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  const inside = (t: number): boolean => {
    const y = origin.y + direction.y * t;
    if (y < minY || y > maxY) return false;
    const dx = origin.x + direction.x * t - ship.position.x;
    const dz = origin.z + direction.z * t - ship.position.z;
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    return isInsideSwimHullFootprint(stats, localX, localZ, 0.05);
  };

  let tPrev = tEnter;
  if (inside(tEnter)) return tEnter;
  for (let t = tEnter + HULL_STEP; ; t += HULL_STEP) {
    const tSample = Math.min(t, tExit);
    if (inside(tSample)) {
      let lo = tPrev;
      let hi = tSample;
      for (let i = 0; i < BISECT_ITERATIONS; i++) {
        const mid = (lo + hi) * 0.5;
        if (inside(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    tPrev = tSample;
    if (tSample >= tExit) break;
  }
  return null;
}
