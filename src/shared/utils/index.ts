import type { Island, IslandDock, SeaRock, SeaRockCollider, Ship, ShipType, Vec3, Vec2 } from '../types/index.js';
import { SHIP_STATS } from '../constants/index.js';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist3D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function buildSeaRockColliders(radius: number, height: number, rotation: number, variant: SeaRock['variant']): {
  boundsRadius: number;
  colliders: SeaRockCollider[];
} {
  const colliders: SeaRockCollider[] = [];
  const mainRadius = variant === 1 ? radius * 0.72 : radius * (0.62 + variant * 0.035);
  colliders.push({
    localX: 0,
    localZ: 0,
    radius: mainRadius,
    minY: -height * (variant === 1 ? 0.16 : 0.28) - 1.9,
    maxY: height * (variant === 1 ? 0.84 : 0.94) - 1.3,
  });

  const shardCount = 4 + variant;
  for (let i = 0; i < shardCount; i++) {
    const angle = (i / shardCount) * Math.PI * 2 + rotation * 0.17;
    const localRadius = radius * (0.28 + (i % 2) * 0.16);
    const shardHeight = height * (0.34 + (i % 3) * 0.08);
    const shardVisualRadius = radius * (0.16 + (i % 2) * 0.04);
    colliders.push({
      localX: Math.cos(angle) * localRadius,
      localZ: Math.sin(angle) * localRadius,
      radius: shardVisualRadius * 0.95,
      minY: shardHeight * 0.28 - 1.2 - shardHeight * 0.52,
      maxY: shardHeight * 0.28 - 1.2 + shardHeight * 0.52,
    });
  }

  const boundsRadius = colliders.reduce((max, collider) => (
    Math.max(max, Math.hypot(collider.localX, collider.localZ) + collider.radius)
  ), radius);

  return { boundsRadius, colliders };
}

export function getSeaRockColliders(rock: SeaRock): SeaRockCollider[] {
  if (rock.colliders?.length) return rock.colliders;
  return buildSeaRockColliders(rock.radius, rock.height, rock.rotation, rock.variant).colliders;
}

export function getSeaRockBoundsRadius(rock: SeaRock): number {
  return rock.colliderBoundsRadius || buildSeaRockColliders(rock.radius, rock.height, rock.rotation, rock.variant).boundsRadius;
}

export function seaRockColliderWorldCenter(rock: SeaRock, collider: SeaRockCollider): { x: number; z: number } {
  const cos = Math.cos(rock.rotation);
  const sin = Math.sin(rock.rotation);
  return {
    x: rock.position.x + collider.localX * cos + collider.localZ * sin,
    z: rock.position.z + collider.localZ * cos - collider.localX * sin,
  };
}

export function intersectRaySeaRock(origin: Vec3, direction: Vec3, range: number, rock: SeaRock, padding = 0): number | null {
  const broadDx = origin.x - rock.position.x;
  const broadDz = origin.z - rock.position.z;
  const broadRadius = getSeaRockBoundsRadius(rock) + padding;
  const broadA = direction.x * direction.x + direction.z * direction.z;
  if (broadA > 0.000001) {
    const broadB = 2 * (broadDx * direction.x + broadDz * direction.z);
    const broadC = broadDx * broadDx + broadDz * broadDz - broadRadius * broadRadius;
    const broadDisc = broadB * broadB - 4 * broadA * broadC;
    if (broadDisc < 0 && broadC > 0) return null;
  }

  let best: number | null = null;
  const testT = (t: number, cx: number, cz: number, radius: number, minY: number, maxY: number) => {
    if (t < 0 || t > range || (best !== null && t >= best)) return;
    const y = origin.y + direction.y * t;
    if (y < minY || y > maxY) return;
    const x = origin.x + direction.x * t;
    const z = origin.z + direction.z * t;
    if (Math.hypot(x - cx, z - cz) <= radius + 0.0001) best = t;
  };

  for (const collider of getSeaRockColliders(rock)) {
    const center = seaRockColliderWorldCenter(rock, collider);
    const radius = collider.radius + padding;
    const minY = rock.position.y + collider.minY;
    const maxY = rock.position.y + collider.maxY;
    const ox = origin.x - center.x;
    const oz = origin.z - center.z;
    const a = direction.x * direction.x + direction.z * direction.z;
    if (a > 0.000001) {
      const b = 2 * (ox * direction.x + oz * direction.z);
      const c = ox * ox + oz * oz - radius * radius;
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        testT((-b - root) / (2 * a), center.x, center.z, radius, minY, maxY);
        testT((-b + root) / (2 * a), center.x, center.z, radius, minY, maxY);
      }
    } else if (Math.hypot(ox, oz) <= radius) {
      if (Math.abs(direction.y) > 0.000001) {
        testT((minY - origin.y) / direction.y, center.x, center.z, radius, minY, maxY);
        testT((maxY - origin.y) / direction.y, center.x, center.z, radius, minY, maxY);
      }
    }

    if (Math.abs(direction.y) > 0.000001) {
      testT((minY - origin.y) / direction.y, center.x, center.z, radius, minY, maxY);
      testT((maxY - origin.y) / direction.y, center.x, center.z, radius, minY, maxY);
    }
  }

  return best;
}

export function normalize2D(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function normalize3D(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function dot3D(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3D(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function add3D(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale3D(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function len3D(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function randRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export function randInt(lo: number, hi: number): number {
  return Math.floor(randRange(lo, hi + 1));
}

export function randAngle(): number {
  return Math.random() * Math.PI * 2;
}

export function angleWrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function degreesToRad(d: number): number {
  return d * Math.PI / 180;
}

export function weightedRandom<T>(items: Array<{ weight: number } & T>): T {
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * totalWeight;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Roughness scalar in [0.25, 1.55] — slow drift between glassy calm and proper chop.
 * Two superimposed sines guarantee an irregular pattern: every match feels different
 * and the sea visibly transitions between flat days and rolling swells.
 *
 * The function is deterministic in `t` so client and server agree on the same wave
 * height at every shared timestamp — physics stays consistent with rendering.
 */
export function getOceanRoughness(t: number): number {
  const slow = Math.sin(t * 0.013) * 0.55;
  const slower = Math.sin(t * 0.0042 + 1.7) * 0.35;
  return clamp(0.85 + slow + slower, 0.25, 1.55);
}

/** Simple Gerstner wave height at world position. Amplitude is modulated by the
 *  global ocean roughness so the same call site produces the same wave height
 *  on client and server at any given time. */
export function gerstnerHeight(
  x: number, z: number, t: number,
  waves: Array<{ amplitude: number; wavelength: number; direction: Vec2; speed: number }>
): number {
  const roughness = getOceanRoughness(t);
  let height = 0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const c = w.speed;
    const d = normalize2D(w.direction);
    const f = k * (d.x * x + d.y * z - c * t);
    height += w.amplitude * roughness * Math.sin(f);
  }
  return height;
}

export const WAVE_PARAMS = [
  { amplitude: 0.32, wavelength: 86, direction: { x: 1, y: 0.4 }, speed: 5.6 },
  { amplitude: 0.20, wavelength: 52, direction: { x: -0.5, y: 1 }, speed: 4.6 },
  { amplitude: 0.12, wavelength: 34, direction: { x: 0.8, y: -0.6 }, speed: 6.5 },
  { amplitude: 0.06, wavelength: 20, direction: { x: -0.3, y: -0.9 }, speed: 7.4 },
];

export function sampleWind(t: number): { direction: number; strength: number } {
  const direction = angleWrap(
    -Math.PI * 0.26 +
    Math.sin(t * 0.013) * 0.22 +
    Math.sin(t * 0.005 + 1.2) * 0.12,
  );
  const strength = clamp(0.9 + Math.sin(t * 0.008 - 0.35) * 0.08, 0.78, 0.98);
  return { direction, strength };
}

export function directionToYaw(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

function islandAngleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function islandAngleMask(angle: number, center: number, width: number): number {
  return Math.exp(-Math.pow(islandAngleDelta(angle, center) / width, 2));
}

function getIslandShapeTerms(island: Island, angle: number) {
  const profile = island.profile;
  const primaryMask = islandAngleMask(angle, profile.primaryHillAngle, 0.8);
  const secondaryMask = islandAngleMask(angle, profile.secondaryHillAngle, 0.68) * profile.secondaryHillScale;
  const tertiaryMask = profile.tertiaryHillScale > 0
    ? islandAngleMask(angle, profile.tertiaryHillAngle, 0.62) * profile.tertiaryHillScale
    : 0;
  const bulge = 1
    + Math.cos(angle - profile.ridgeAxis) * profile.ridgeBias * 0.4
    + primaryMask * 0.1
    + secondaryMask * 0.08
    + tertiaryMask * 0.06;
  return { primaryMask, secondaryMask, tertiaryMask, bulge };
}

export function getIslandDistRatio(island: Island, x: number, z: number) {
  const dx = x - island.position.x;
  const dz = z - island.position.z;
  const angle = Math.atan2(dz, dx);
  const { bulge } = getIslandShapeTerms(island, angle);
  const scaleX = island.radius * island.profile.footprintX * bulge;
  const scaleZ = island.radius * island.profile.footprintZ * bulge;
  const distRatio = Math.sqrt((dx / Math.max(scaleX, 0.001)) ** 2 + (dz / Math.max(scaleZ, 0.001)) ** 2);
  return { angle, distRatio, bulge };
}

export function getIslandSurfaceY(island: Island, x: number, z: number): number {
  const { angle, distRatio } = getIslandDistRatio(island, x, z);
  const { primaryMask, secondaryMask, tertiaryMask } = getIslandShapeTerms(island, angle);
  const profile = island.profile;
  const localX = x - island.position.x;
  const localZ = z - island.position.z;
  const shoreline = Math.max(0, 1 - distRatio / 1.04);
  const innerShelf = Math.max(0, 1 - distRatio / (0.62 + profile.mesaBias * 0.12));
  const crownShelf = Math.max(0, 1 - distRatio / (0.34 + profile.mesaBias * 0.08));
  const ridgeWave = 1
    + Math.cos(angle - profile.ridgeAxis) * profile.ridgeBias
    + Math.sin(angle * 2.6 + profile.ridgeAxis) * 0.04;
  const hillContribution = (
    hillAngle: number,
    hillOffset: number,
    radiusScale: number,
    heightScale: number,
  ) => {
    const centerX = Math.cos(hillAngle) * hillOffset * profile.footprintX;
    const centerZ = Math.sin(hillAngle) * hillOffset * profile.footprintZ;
    const dx = localX - centerX;
    const dz = localZ - centerZ;
    const radius = Math.max(4, island.radius * radiusScale);
    return Math.exp(-(dx * dx + dz * dz) / (radius * radius)) * island.radius * heightScale;
  };
  const beachRise = Math.pow(shoreline, 1.12) * island.radius * 0.032;
  const cliffRise = Math.pow(Math.max(0, 1 - distRatio / 0.9), 1.35)
    * island.radius
    * 0.048
    * (0.86 + profile.heightProfile * 0.32)
    * ridgeWave;
  const plateauRise = Math.pow(innerShelf, 1.42)
    * island.radius
    * 0.042
    * (0.92 + profile.mesaBias * 0.22 + primaryMask * 0.1 + secondaryMask * 0.08 + tertiaryMask * 0.06);
  const crownRise = Math.pow(crownShelf, 2.05)
    * island.radius
    * 0.008
    * (0.28 + primaryMask * 0.16 + secondaryMask * 0.1 + tertiaryMask * 0.08);
  const peakBoost = profile.peakBoost ?? 0;
  const isTwin = profile.terrainStyle === 'twin';
  const isArchipelago = profile.terrainStyle === 'archipelago';
  const isMountain = profile.terrainStyle === 'mountain';
  // Twin/archipelago push secondary peak amplitude up so the second hill is a true peak
  const secondaryAmp = isTwin ? 2.2 : isArchipelago ? 1.8 : isMountain ? 1.35 : 1.0;
  const tertiaryAmp = isArchipelago ? 1.6 : 1.0;
  // Mountain islands now build dramatically taller peaks — peakBoost can hit 1.6 and
  // the multiplier is steeper, so a tall mountain genuinely dominates the skyline.
  const mountainBoostFactor = isMountain ? 3.2 : 1.6;
  const primaryHill = hillContribution(
    profile.primaryHillAngle,
    profile.primaryHillOffset,
    0.34 + profile.mesaBias * 0.08 + peakBoost * 0.04,
    (0.018 + profile.heightProfile * 0.022) * (1 + peakBoost * mountainBoostFactor) * (isTwin || isArchipelago ? 1.4 : isMountain ? 1.6 : 1),
  );
  const secondaryHill = hillContribution(
    profile.secondaryHillAngle,
    profile.secondaryHillOffset,
    0.3 + profile.secondaryHillScale * 0.1,
    (0.01 + profile.secondaryHillScale * 0.018) * secondaryAmp,
  );
  const tertiaryHill = profile.tertiaryHillScale > 0
    ? hillContribution(
      profile.tertiaryHillAngle,
      profile.tertiaryHillOffset,
      0.26 + profile.tertiaryHillScale * 0.1,
      (0.006 + profile.tertiaryHillScale * 0.014) * tertiaryAmp,
    )
    : 0;
  const angleNoise = (
    Math.sin(angle * 2 + profile.islandHeading) * 0.009 +
    Math.cos(angle * 4 - profile.islandHeading * 1.6) * 0.006
  ) * island.radius;
  let seaLift = 5.15 + island.radius * 0.0085;
  let floor = 0.08;
  // Combined hill mask drives the "land vs water" effect for archipelago islands
  if (isArchipelago) {
    const totalHillMask = primaryMask
      + secondaryMask * Math.max(0.4, profile.secondaryHillScale)
      + tertiaryMask * Math.max(0.2, profile.tertiaryHillScale);
    // Hills present → full sea lift, hills absent → seaLift drops below water surface
    // so the "saddle" between sub-peaks becomes actual ocean.
    const landFactor = Math.min(1.0, totalHillMask * 1.5);
    seaLift = -2.4 + (seaLift + 2.4) * landFactor;
    floor = -3.5;
  } else if (isTwin) {
    // Twin peaks: saddle drops noticeably (still above water) between the two hills
    const totalHillMask = primaryMask + secondaryMask * profile.secondaryHillScale;
    const landFactor = Math.min(1.0, totalHillMask * 1.2 + 0.35);
    seaLift = 1.0 + (seaLift - 1.0) * landFactor;
  }

  const naturalY = seaLift + beachRise + cliffRise + plateauRise + crownRise + primaryHill + secondaryHill + tertiaryHill + angleNoise;

  // Caves hollow out the heightmap inside their tunnel footprint — the natural
  // surface sweeps down to the cave floor with a smooth lateral/longitudinal falloff
  // so the walls of the slot ARE the natural terrain. The client adds a ceiling
  // mesh on top to seal the cavern.
  let bestMask = 0;
  let bestFloorY = naturalY;
  if (island.caves && island.caves.length > 0) {
    for (const cave of island.caves) {
      const cLen = (cave as { length?: number }).length ?? 10;
      const cRadius = (cave as { interiorRadius?: number }).interiorRadius ?? 3.0;
      const cFloorY = (cave as { floorY?: number }).floorY ?? cave.position.y - 0.4;
      const dx = x - cave.position.x;
      const dz = z - cave.position.z;
      const cosR = Math.cos(cave.rotation);
      const sinR = Math.sin(cave.rotation);
      // Cave-local: +z points OUTWARD from the island (entrance side); tunnel goes to -z
      const lx = dx * cosR - dz * sinR;
      const lz = dx * sinR + dz * cosR;
      const lateralPad = 0.7;
      const longPad = 1.0;
      const latFalloff = Math.abs(lx) <= cRadius
        ? 1
        : Math.abs(lx) <= cRadius + lateralPad
          ? 1 - (Math.abs(lx) - cRadius) / lateralPad
          : 0;
      const longFalloff = lz <= 0 && lz >= -cLen
        ? 1
        : lz > 0 && lz <= longPad
          ? 1 - lz / longPad
          : lz < -cLen && lz >= -(cLen + longPad)
            ? 1 - (-cLen - lz) / longPad
            : 0;
      const mask = latFalloff * longFalloff;
      if (mask > bestMask) {
        bestMask = mask;
        bestFloorY = cFloorY;
      }
    }
  }
  const blendedY = bestMask > 0
    ? naturalY * (1 - bestMask) + bestFloorY * bestMask
    : naturalY;
  return Math.max(floor, blendedY);
}

export function getIslandSurfacePoint(island: Island, distRatio: number, angle: number, extraY = 0): Vec3 {
  const { bulge } = getIslandShapeTerms(island, angle);
  return {
    x: island.position.x + Math.cos(angle) * island.radius * distRatio * island.profile.footprintX * bulge,
    y: getIslandSurfaceY(
      island,
      island.position.x + Math.cos(angle) * island.radius * distRatio * island.profile.footprintX * bulge,
      island.position.z + Math.sin(angle) * island.radius * distRatio * island.profile.footprintZ * bulge,
    ) + extraY,
    z: island.position.z + Math.sin(angle) * island.radius * distRatio * island.profile.footprintZ * bulge,
  };
}

export function isPointInsideIslandFootprint(island: Island, x: number, z: number, margin = 0): boolean {
  const { distRatio } = getIslandDistRatio(island, x, z);
  return distRatio <= 1 + margin / Math.max(island.radius, 1);
}

export function getIslandMaxRadius(island: Island): number {
  const profile = island.profile;
  return island.radius
    * Math.max(profile.footprintX, profile.footprintZ)
    * (1.08 + Math.abs(profile.ridgeBias) * 0.18 + profile.secondaryHillScale * 0.08 + profile.tertiaryHillScale * 0.05 + (profile.peakBoost ?? 0) * 0.05);
}

/** Main mast base Z (matches client ShipRenderer mast layout). */
export function getMainMastLocalZ(stats: { length: number }): number {
  return stats.length * 0.22;
}

/** Standing height in crow's nest (ship-local Y above waterline). */
export function getCrowNestStandingY(stats: { height: number; mastCount: number }): number {
  const H = stats.height;
  const mastH = H * (stats.mastCount === 1 ? 3.6 : 3.1);
  return H + mastH * 0.72 + 0.12;
}

/** Climb prompt zone for the crow's-nest ladder (main mast is at x=0 in ship-local space). */
export function getCrowNestLadderInteractionBounds(stats: { length: number }) {
  return {
    mastZ: getMainMastLocalZ(stats),
    maxAbsX: 0.88,
    maxAbsZ: 1.38,
  };
}

/** Shared sail ring for raising / reefing and angling canvas, kept clear of ladders, anchor, helm, and cannon rails. */
export function getSailStationLocal(stats: { length: number; mastCount: number; width?: number }): { x: number; z: number } {
  return {
    x: 0,
    z: -stats.length * 0.24,
  };
}

/** Back-compat: old hoist callers now resolve to the shared sail ring. */
export function getSailHoistStationLocal(stats: { length: number; mastCount: number; width?: number }): { x: number; z: number } {
  return getSailStationLocal(stats);
}

/** Back-compat: old angle callers now resolve to the shared sail ring. */
export function getSailAngleStationLocal(stats: { length: number; mastCount: number; width?: number }): { x: number; z: number } {
  return getSailStationLocal(stats);
}

export interface ShipCompanionwayConfig {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  stairHalfWidth: number;
  stairFrontZ: number;
  stairBackZ: number;
}

export function getShipCompanionwayConfig(stats: { width: number; length: number }): ShipCompanionwayConfig {
  const halfX = Math.max(1.35, stats.width * 0.2);
  const halfZ = Math.max(1.4, stats.length * 0.13);
  const cx = stats.width * 0.12;
  const cz = stats.length * 0.08;

  return {
    cx,
    cz,
    halfX,
    halfZ,
    stairHalfWidth: halfX * 0.92,
    stairFrontZ: cz + halfZ,
    stairBackZ: cz - halfZ,
  };
}

export function getShipBoardingLadderLocals(type: ShipType): Array<{ x: number; z: number }> {
  const stats = SHIP_STATS[type];
  const ladderX = stats.width * 0.56;
  const ladderZ = -stats.length * 0.18;
  return [
    { x: -ladderX, z: ladderZ },
    { x: ladderX, z: ladderZ },
  ];
}

export function getShipBoardingLadderWorldPoints(ship: Pick<Ship, 'type' | 'position' | 'rotation'>): Array<{ x: number; y: number; z: number; localX: number; localZ: number }> {
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return getShipBoardingLadderLocals(ship.type).map((ladder) => ({
    x: ship.position.x + ladder.x * cos + ladder.z * sin,
    y: ship.position.y,
    z: ship.position.z + ladder.z * cos - ladder.x * sin,
    localX: ladder.x,
    localZ: ladder.z,
  }));
}

export function getNearestShipBoardingLadder(ship: Pick<Ship, 'type' | 'position' | 'rotation'>, point: Pick<Vec3, 'x' | 'z'>) {
  let nearest: { x: number; y: number; z: number; localX: number; localZ: number; distance: number } | null = null;
  for (const ladder of getShipBoardingLadderWorldPoints(ship)) {
    const distance = dist2D(point.x, point.z, ladder.x, ladder.z);
    if (!nearest || distance < nearest.distance) {
      nearest = { ...ladder, distance };
    }
  }
  return nearest;
}

/** Dock-local space: +Z is inland, seaward ladder is at negative Z. */
export function dockLocalToWorld(dock: IslandDock, lx: number, ly: number, lz: number): Vec3 {
  const cos = Math.cos(dock.rotation);
  const sin = Math.sin(dock.rotation);
  return {
    x: dock.position.x + lx * cos - lz * sin,
    y: dock.position.y + ly,
    z: dock.position.z + lx * sin + lz * cos,
  };
}

/** World point at the seaward swim-up ladder (for prompts / climb checks). */
export function getIslandDockSwimLadderPoint(dock: IslandDock): Vec3 {
  return dockLocalToWorld(dock, 0, 0.38, -dock.length * 0.44);
}
