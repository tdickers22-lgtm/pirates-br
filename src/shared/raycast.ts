import type { Island, Ship, Vec3 } from './types/index.js';
import { SHIP_STATS } from './constants/index.js';
import { getHullProfile } from './hull.js';
import {
  getCaveCeilingY,
  getCaveFloorY,
  getIslandDistRatio,
  getIslandMaxRadius,
  getIslandSurfaceY,
  isInsideSwimHullFootprint,
  SHORE_APRON_DIST_RATIO,
} from './utils/index.js';

interface SurfaceRaycastHit {
  hit: boolean;
  point: Vec3 | null;
  /** Distance to the hit, or `maxDist` when nothing was hit. */
  distance: number;
}

/** Coarse march step over island heightfields — refined by bisection on contact. */
const TERRAIN_STEP = 1.5;
/** Fine step for the shore band. The coarse 1.5 m step only bisects after a
 *  SIGN CHANGE, so a rock plinth or a ridge crest thinner than 1.5 m along the
 *  ray reads as air on both bracketing samples and the ball flies through it
 *  (physics-34). The apron is where those thin crests live. */
const TERRAIN_SHORE_STEP = 0.75;
/** Inside this distRatio the march uses the fine step. */
const TERRAIN_SHORE_BAND = 1.1;
/** The march stops caring about terrain past the apron — the SAME apron the
 *  swim seabed collides to and the terrain grid is now drawn out to. It used to
 *  stop at 1.03, copied from a ship-collision constant that no longer exists,
 *  so up to 3.4 m of drawn shore rock (585 of 10,080 probe columns) was
 *  shoot-through: a pirate on the apron was hittable from the sea and a
 *  cannonball fired at a cliff plinth buried itself in the island (physics-34).
 *  Past ~1.15 the shared field is below the waterline, so this costs nothing. */
const TERRAIN_FOOTPRINT_LIMIT = SHORE_APRON_DIST_RATIO;
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
  if (y > getIslandSurfaceY(island, x, z)) return false;
  // Cave-air exemption: a point inside a carved cave interior (between the
  // cave floor and ceiling) is shootable air, not rock — players in caves can
  // fire out of the mouth and be shot through it. Deterministic and shared by
  // client + server so hit registration stays in lockstep.
  const ceiling = getCaveCeilingY(island, x, z);
  if (ceiling !== null && y <= ceiling) {
    const floor = getCaveFloorY(island, x, z);
    if (floor !== null && y >= floor - 0.05) return false;
  }
  return true;
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

    // Step size follows the ray: fine across the shore band, coarse inland.
    let step = TERRAIN_STEP;
    for (let t = tEnter + step; ; t += step) {
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
      const { distRatio } = getIslandDistRatio(
        island,
        origin.x + direction.x * tSample,
        origin.z + direction.z * tSample,
      );
      step = distRatio <= TERRAIN_SHORE_BAND && distRatio >= 0.9 ? TERRAIN_SHORE_STEP : TERRAIN_STEP;
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
  // THE KEEL IS THE DRAWN KEEL (LOFT-01 / physics-12). This band used to reach
  // 0.72 H below the waterline while the loft the renderer draws bottoms out at
  // 0.35–0.365 H, so a full half-height of open water under a galleon
  // registered as solid hull: shots aimed UNDER a ship stopped dead in nothing,
  // and a swimmer beneath her keel was shielded by timber that was not there.
  // getHullProfile is the same loft the client builds the planking from.
  const minY = ship.position.y - getHullProfile(ship.type).draft - 0.15;
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
