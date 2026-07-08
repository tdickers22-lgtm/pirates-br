import { createNoise2D } from 'simplex-noise';
import type { Island, IslandDock, IslandGeyser, SeaRock, SeaRockCollider, Ship, ShipType, Vec3, Vec2 } from '../types/index.js';
import { SHIP_STATS, PLAYER } from '../constants/index.js';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic PRNG (mulberry32) so the terrain noise permutation table is
 *  identical on server and client — never seed terrain noise from Math.random.
 *  Also used by MapGenerator for per-island prop/stamp determinism. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TERRAIN_NOISE_SEED = 0x51a7e11;
const terrainNoise2D = createNoise2D(mulberry32(TERRAIN_NOISE_SEED));

/** Deterministic fractal terrain noise in roughly [-1, 1]. Shared by server
 *  physics and client island meshes so both always agree on surface height. */
export function terrainFbm(x: number, z: number, octaves = 3): number {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += terrainNoise2D(x * frequency, z * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged terrain noise in [0, 1] — sharp crests used for exposed cliff bands. */
export function terrainRidge(x: number, z: number): number {
  const n = 1 - Math.abs(terrainNoise2D(x, z));
  return n * n;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Hermite smoothstep — 0 below e0, 1 above e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
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
 * Roughness scalar in [0.55, 1.6] — slow drift between gentle seas and proper chop
 * (never glassy: the ocean should always visibly breathe). Two superimposed sines
 * guarantee an irregular pattern so every match feels different.
 *
 * The function is deterministic in `t` so client and server agree on the same wave
 * height at every shared timestamp — physics stays consistent with rendering.
 */
export function getOceanRoughness(t: number): number {
  const slow = Math.sin(t * 0.013) * 0.45;
  const slower = Math.sin(t * 0.0042 + 1.7) * 0.3;
  return clamp(1.0 + slow + slower, 0.55, 1.6);
}

/** Storm sea-state at a world position: 0 = calm seas, 1 = full raging swell.
 *  Deterministic from replicated storm state (center/safeRadius/phase), so the
 *  client shader, client gameplay and server physics all agree. Seas heave
 *  hardest INSIDE the deadly ring, ramp up across a band around its edge, and
 *  get globally rougher in late phases even in the safe zone.
 *  Accepts the replicated StormState shape (centerX/centerZ, 0-indexed phase
 *  over the 7 STORM_PHASES) or a {center: Vec2} equivalent. */
export function getStormWaveIntensity(
  storm: {
    safeRadius: number;
    phase: number;
    center?: Vec2;
    centerX?: number;
    centerZ?: number;
  } | null | undefined,
  x: number,
  z: number,
): number {
  if (!storm) return 0;
  const cx = storm.center?.x ?? storm.centerX ?? 0;
  const cz = storm.center?.y ?? storm.centerZ ?? 0;
  const phase01 = clamp(storm.phase / 6, 0, 1);
  const distOutside = Math.hypot(x - cx, z - cz) - storm.safeRadius;
  // Inside the ring: full storm. Approaching the edge (within 140m): ramp up.
  const edge = smoothstep(-140, 40, distOutside);
  // Ambient late-game chop everywhere, so the endgame ocean feels hostile.
  const ambient = phase01 * 0.38;
  return clamp(Math.max(edge * (0.55 + phase01 * 0.45), ambient), 0, 1);
}

/** Simple Gerstner wave height at world position. Amplitude is modulated by the
 *  global ocean roughness — and by the local storm sea-state, which both scales
 *  the base waves and blends in the dedicated STORM_WAVE_PARAMS swell — so the
 *  same call site produces the same wave height on client and server at any
 *  given time. `storm` is getStormWaveIntensity() at (x, z); omit for calm. */
export function gerstnerHeight(
  x: number, z: number, t: number,
  waves: Array<{ amplitude: number; wavelength: number; direction: Vec2; speed: number }>,
  storm = 0,
): number {
  const roughness = getOceanRoughness(t) * (1 + storm * 0.85);
  let height = 0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const c = w.speed;
    const d = normalize2D(w.direction);
    const f = k * (d.x * x + d.y * z - c * t);
    height += w.amplitude * roughness * Math.sin(f);
  }
  if (storm > 0) {
    for (const w of STORM_WAVE_PARAMS) {
      const k = (2 * Math.PI) / w.wavelength;
      const d = normalize2D(w.direction);
      const f = k * (d.x * x + d.y * z - w.speed * t);
      height += w.amplitude * storm * Math.sin(f);
    }
  }
  return height;
}

/** Base sea. Amplitudes chosen so calm water visibly breathes (~±1m combined
 *  at roughness 1) without making decks nauseating. */
export const WAVE_PARAMS = [
  { amplitude: 0.46, wavelength: 96, direction: { x: 1, y: 0.4 }, speed: 6.4 },
  { amplitude: 0.30, wavelength: 58, direction: { x: -0.5, y: 1 }, speed: 5.2 },
  { amplitude: 0.17, wavelength: 34, direction: { x: 0.8, y: -0.6 }, speed: 6.5 },
  { amplitude: 0.08, wavelength: 20, direction: { x: -0.3, y: -0.9 }, speed: 7.4 },
];

/** Dedicated storm swell, blended in by the local storm sea-state: two long
 *  aligned rollers plus a short chaotic chop. At storm=1 this adds ~±2.6m on
 *  top of the boosted base sea — decks pitch hard, small boats struggle. */
export const STORM_WAVE_PARAMS = [
  { amplitude: 1.55, wavelength: 150, direction: { x: 0.92, y: 0.39 }, speed: 11.5 },
  { amplitude: 0.75, wavelength: 74, direction: { x: 0.72, y: 0.7 }, speed: 8.6 },
  { amplitude: 0.35, wavelength: 30, direction: { x: -0.2, y: -0.98 }, speed: 9.8 },
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

/** Total inward bite (0..~0.6 of radius) from all inlets at a given angle. */
export function getIslandInletCut(island: Island, angle: number): number {
  const inlets = island.profile.inlets;
  if (!inlets || inlets.length === 0) return 0;
  let cut = 0;
  for (const inlet of inlets) {
    const d = islandAngleDelta(angle, inlet.angle);
    // Smooth cosine lobe across the mouth; zero outside [-width, width].
    const t = Math.abs(d) / Math.max(inlet.width, 0.001);
    if (t >= 1) continue;
    const falloff = 0.5 + 0.5 * Math.cos(t * Math.PI);
    cut += inlet.depth * falloff;
  }
  return Math.min(cut, 0.6); // never bite past the island core
}

function getIslandShapeTerms(island: Island, angle: number) {
  const profile = island.profile;
  const primaryMask = islandAngleMask(angle, profile.primaryHillAngle, 0.8);
  const secondaryMask = islandAngleMask(angle, profile.secondaryHillAngle, 0.68) * profile.secondaryHillScale;
  const tertiaryMask = profile.tertiaryHillScale > 0
    ? islandAngleMask(angle, profile.tertiaryHillAngle, 0.62) * profile.tertiaryHillScale
    : 0;
  const bulge = (1
    + Math.cos(angle - profile.ridgeAxis) * profile.ridgeBias * 0.4
    + primaryMask * 0.1
    + secondaryMask * 0.08
    + tertiaryMask * 0.06)
    * (1 - getIslandInletCut(island, angle)); // coves/bays pull the shore inward
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

// ── Coast profile ───────────────────────────────────────────────────────────
// Every island shoreline is split into deterministic per-angle bands of three
// coast types. Beach coasts ease from the interior through a wet-sand strip
// (~+0.4m) and continue UNDERWATER past the footprint edge so a swimmer can
// walk straight up onto land. Cliff coasts keep a tall dramatic plinth
// (7–10m). Rocky coasts sit in between. Inlet mouths are always beach.

function coastPhase(seed: number, k: number): number {
  let h = (seed + Math.imul(k, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967296) * Math.PI * 2;
}

/** Smooth per-angle coast field in [-1, 1]: negative ⇒ beach, positive ⇒ cliff. */
export function getIslandCoastField(island: Island, angle: number): number {
  const seed = (island.profile.seed ?? 0x5eed) >>> 0;
  const f = Math.sin(angle + coastPhase(seed, 1)) * 0.55
    + Math.sin(angle * 2 + coastPhase(seed, 2)) * 0.34
    + Math.sin(angle * 3 + coastPhase(seed, 3)) * 0.22;
  return clamp(f * 0.95 + (island.profile.coastBias ?? 0), -1, 1);
}

/** Normalized blend weights of the three coast types at a shoreline angle.
 *  Weights vary smoothly with angle so the heightfield never steps. */
export function getIslandCoastWeights(island: Island, angle: number): { beach: number; rocky: number; cliff: number } {
  const f = getIslandCoastField(island, angle);
  let cliff = smoothstep(0.14, 0.52, f);
  let beach = smoothstep(0.14, 0.52, -f);
  // Inlet mouths (coves/bays) always land on beach so they read as harbors.
  const inletCut = getIslandInletCut(island, angle);
  if (inletCut > 0) {
    const force = clamp(inletCut * 6, 0, 1);
    beach = Math.max(beach, force);
    cliff *= 1 - force;
  }
  const sum = beach + cliff;
  if (sum > 1) {
    beach /= sum;
    cliff /= sum;
  }
  return { beach, cliff, rocky: Math.max(0, 1 - beach - cliff) };
}

/** Dominant coast type at a shoreline angle (beach | rocky | cliff). */
export function getIslandCoastType(island: Island, angle: number): 'beach' | 'rocky' | 'cliff' {
  const w = getIslandCoastWeights(island, angle);
  if (w.beach >= w.cliff && w.beach >= w.rocky) return 'beach';
  return w.cliff >= w.rocky ? 'cliff' : 'rocky';
}

export interface IslandSurfaceOptions {
  /** Opt in to carving cave tunnel trenches into the returned height (used for
   *  cave-interior mesh building / in-cave locomotion). Default OFF: walking
   *  ABOVE a cave stands on the natural hillside, not in the trench. */
  carveCaves?: boolean;
}

/** Carve mask/floor of the deepest-overlapping cave at (x, z), or null. */
function getCaveCarve(island: Island, x: number, z: number): { mask: number; floorY: number } | null {
  if (!island.caves || island.caves.length === 0) return null;
  let bestMask = 0;
  let bestFloorY = 0;
  for (const cave of island.caves) {
    const cLen = (cave as { length?: number }).length ?? 10;
    const cRadius = (cave as { interiorRadius?: number }).interiorRadius ?? 3.0;
    const cFloorY = (cave as { floorY?: number }).floorY ?? cave.position.y - 0.4;
    const cFloorEnd = (cave as { floorYEnd?: number }).floorYEnd ?? cFloorY;
    const dx = x - cave.position.x;
    const dz = z - cave.position.z;
    const cosR = Math.cos(cave.rotation);
    const sinR = Math.sin(cave.rotation);
    // Cave-local: +z points OUTWARD from the island (entrance side); tunnel goes to -z
    const lx = dx * cosR - dz * sinR;
    const lz = dx * sinR + dz * cosR;
    // Floor ramps from cFloorY (mouth) to cFloorEnd (far end) so the cave can
    // DESCEND deep into the mountain rather than sit under a thin roof.
    const along = cLen > 0 ? clamp(-lz / cLen, 0, 1) : 0;
    const floorAt = cFloorY + (cFloorEnd - cFloorY) * along;
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
      bestFloorY = floorAt;
    }
  }
  return bestMask > 0 ? { mask: bestMask, floorY: bestFloorY } : null;
}

export function getIslandSurfaceY(island: Island, x: number, z: number, opts?: IslandSurfaceOptions): number {
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
  const isCrescent = profile.terrainStyle === 'crescent';
  // Twin/archipelago push secondary peak amplitude up so the second hill is a true peak
  const secondaryAmp = isTwin ? 2.2 : isArchipelago ? 1.8 : isMountain ? 1.35 : 1.55;
  const tertiaryAmp = isArchipelago ? 1.6 : 1.0;
  // Mountain islands now build dramatically taller peaks — peakBoost can hit 1.6 and
  // the multiplier is steeper, so a tall mountain genuinely dominates the skyline.
  const mountainBoostFactor = isMountain ? 3.2 : 1.6;
  const primaryHill = hillContribution(
    profile.primaryHillAngle,
    profile.primaryHillOffset,
    // Mountains: the gaussian NARROWS as the peak grows — a sheer spire that
    // dominates the skyline (reference: SoT), not a wider rounded knoll.
    isMountain
      ? Math.max(0.16, 0.3 - peakBoost * 0.045) + profile.mesaBias * 0.05
      : 0.34 + profile.mesaBias * 0.08 + peakBoost * 0.04,
    (0.018 + profile.heightProfile * 0.022) * (1 + peakBoost * mountainBoostFactor) * (isTwin || isArchipelago ? 1.4 : isMountain ? 1.6 : 1.32),
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
  // ── Signed coast profile: rim height depends on the per-angle coast type ──
  const coast = getIslandCoastWeights(island, angle);
  const seaLiftBase = 5.15 + island.radius * 0.0085;
  const cliffLift = clamp(7.4 + island.radius * 0.03 * (0.7 + profile.heightProfile * 0.45), 7, 10);
  const rockyLift = 3.3 + island.radius * 0.005;
  // Beaches hug the sea: low enough that swell laps visibly up the sand, high
  // enough that storm waves (~+2.5m peaks near the rim's wet-sand band) don't
  // flood the dry berm where camps/chests sit.
  const beachLift = 1.45 + island.radius * 0.003;
  const coastLift = coast.beach * beachLift + coast.rocky * rockyLift + coast.cliff * cliffLift;
  // Interior keeps the classic plinth; the rim morphs toward the coast profile.
  const shoreMix = smoothstep(0.55, 0.92, distRatio);
  let seaLift = lerp(seaLiftBase, coastLift, shoreMix);
  let floor = 0.08;
  // 2D islet discs: a true gaussian around each sub-peak CENTER (not the angular
  // mask), so an archipelago reads as separate islets with open water between —
  // rather than one blob with pie-slice notches.
  const isletDisc = (hillAngle: number, hillOffset: number, discR: number) => {
    const cx = Math.cos(hillAngle) * hillOffset * profile.footprintX;
    const cz = Math.sin(hillAngle) * hillOffset * profile.footprintZ;
    const ddx = localX - cx;
    const ddz = localZ - cz;
    const r = Math.max(6, island.radius * discR);
    return Math.exp(-(ddx * ddx + ddz * ddz) / (r * r));
  };
  let archLandFactor = 1;
  let crescentBay = 0;
  if (isArchipelago) {
    const d1 = isletDisc(profile.primaryHillAngle, profile.primaryHillOffset, 0.46);
    const d2 = profile.secondaryHillScale > 0.05
      ? isletDisc(profile.secondaryHillAngle, profile.secondaryHillOffset, 0.42) : 0;
    const d3 = profile.tertiaryHillScale > 0
      ? isletDisc(profile.tertiaryHillAngle, profile.tertiaryHillOffset, 0.38) : 0;
    archLandFactor = smoothstep(0.1, 0.42, Math.max(d1, d2, d3));
    floor = -3.6;
  } else if (isCrescent) {
    // Horseshoe: carve an open-water bay out of one side (opposite the main
    // ridge) so the land wraps as a C around a lagoon. The two arms stay land.
    const bayAngle = profile.primaryHillAngle + Math.PI;
    const angFromBay = Math.abs(islandAngleDelta(angle, bayAngle));
    const wedge = smoothstep(1.15, 0.35, angFromBay);          // 1 straight into the mouth
    const bayRadial = smoothstep(0.16, 0.5, distRatio);        // keep a back land-bridge
    crescentBay = wedge * bayRadial;
    floor = -3.6;
  } else if (isTwin) {
    // Twin peaks: saddle drops noticeably (still above water) between the two hills
    const totalHillMask = primaryMask + secondaryMask * profile.secondaryHillScale;
    const landFactor = Math.min(1.0, totalHillMask * 1.2 + 0.35);
    seaLift = 1.0 + (seaLift - 1.0) * landFactor;
  }

  let baseY = seaLift + beachRise + cliffRise + plateauRise + crownRise + primaryHill + secondaryHill + tertiaryHill + angleNoise;
  if (isArchipelago) {
    // Sink everything between islets to open ocean; the islet cores keep height.
    baseY = -3.2 + (baseY + 3.2) * archLandFactor;
  } else if (isCrescent && crescentBay > 0) {
    // Drop the bay wedge to open water, leaving the wrapping arms as land.
    baseY = lerp(baseY, -3.0, crescentBay * 0.95);
  }

  // ── Deterministic noise detail (shared by server physics & client meshes) ──
  // Interior mask fades every detail term to zero approaching the shoreline so
  // beaches stay smooth and dock/berth/NPC placement is unaffected.
  const interiorMask = clamp(1 - distRatio / 0.97, 0, 1);
  const detailMask = Math.min(1, interiorMask * 1.6);
  // Rolling hill detail — a LARGE-scale octave carves headlands/knolls/valleys
  // that give the aerial silhouette real relief (flat styles read as domes, not
  // discs), plus a medium octave for surface undulation. Interior-only
  // (detailMask fades it to the shore, so the beach walk-in stays gentle) and
  // fully deterministic (world-space), so collision/props stay in sync.
  const bigHill = terrainFbm(x * 0.0065, z * 0.0065, 2)
    * island.radius * 0.062
    * (0.5 + profile.heightProfile * 0.7)
    * detailMask;
  const hillDetail = bigHill + terrainFbm(x * 0.016, z * 0.016, 3)
    * island.radius * 0.055
    * (0.45 + profile.heightProfile * 0.85)
    * detailMask;
  // Cliff bands — ridged noise pushes sharp exposed-rock crests on taller styles
  // (heavier on mountains, whose bare upper massif should read as fractured rock).
  const isMountainStyle = profile.terrainStyle === 'mountain';
  const cliffBands = terrainRidge(x * 0.021, z * 0.021)
    * island.radius * (isMountainStyle ? 0.05 : 0.034)
    * clamp((profile.heightProfile - 0.24) * 1.4, 0, 1)
    * detailMask;
  // Mountains fracture their upper slopes with an extra high-frequency crag octave
  // (ridged crests + a signed fbm for spurs AND crevices), so the peak reads as
  // craggy rock rather than a smooth cone. World-space deterministic (server↔client
  // parity) and rides detailMask so it fades out before the shore.
  const mtnCrag = isMountainStyle
    ? (terrainRidge(x * 0.032 + 11.3, z * 0.032 - 7.1) * 0.6
        + terrainFbm(x * 0.06, z * 0.06, 3) * 0.5)
      * island.radius * 0.045
      * clamp((profile.heightProfile - 0.18) * 1.4, 0, 1)
      // Only fracture the inner/upper massif — fully faded by distRatio 0.6 so the
      // gentle beach walk-in (≈0.8–1.0) keeps its sub-0.45m/step continuity.
      * clamp(1 - distRatio / 0.6, 0, 1)
      * detailMask
    : 0;
  // Noise must never carve interior land below the wave-safe shelf — but keep
  // intentional underwater saddles (twin/archipelago) untouched.
  const lowestAllowed = Math.min(baseY, 5.4);
  let detailedY = Math.max(baseY + hillDetail + cliffBands + mtnCrag, lowestAllowed);

  // Terraced "levels": soft-quantize relief above the sea shelf so hillsides
  // read as walkable tiers. Strong on plateau/rocky islands, subtle on tropical.
  const terraceStrength = profile.terrainStyle === 'plateau' ? 0.6
    : profile.terrainStyle === 'rocky' ? 0.42
      : profile.terrainStyle === 'mountain' ? 0.32
        : 0.16;
  const relief = detailedY - seaLift;
  if (relief > 0.5) {
    const stepHeight = Math.max(2.4, island.radius * 0.055);
    const stepIndex = Math.floor(relief / stepHeight);
    const stepFrac = relief / stepHeight - stepIndex;
    const eased = stepFrac * stepFrac * (3 - 2 * stepFrac);
    const steppedRelief = (stepIndex + eased) * stepHeight;
    detailedY = seaLift + lerp(relief, steppedRelief, terraceStrength * detailMask);
  }

  const naturalY = detailedY;

  // ── Signed shore drop past the rim (heightfield continues UNDERWATER) ──
  // Beach: ease interior → wet sand (~+0.42m) by distRatio ~0.97, then slide
  // under the waterline to ~−2.6m by ~1.15 so a swimmer walks straight in.
  const beachEase = smoothstep(0.8, 0.96, distRatio);
  const beachUnder = smoothstep(0.975, 1.15, distRatio);
  const beachY = lerp(naturalY, lerp(0.38, -3.0, beachUnder), beachEase);
  // Rocky: mid shelf holds a little longer, then steps down.
  const rockyY = lerp(naturalY, -3.4, smoothstep(0.96, 1.14, distRatio));
  // Cliff: tall plinth holds to the footprint edge, then plunges as a SHEER wall
  // right at the rim (drop bottoms out by ~1.05 instead of a wide 1.12 ramp), so
  // stepping or jumping off the edge drops you cleanly into the sea rather than
  // landing back on a sloped shelf.
  const cliffY = lerp(naturalY, -5.5, smoothstep(1.0, 1.05, distRatio));
  let surfaceY = coast.beach * beachY + coast.rocky * rockyY + coast.cliff * cliffY;

  // ── Structure stamps: flatten discs so buildings sit on level ground ──
  if (island.stamps && island.stamps.length > 0) {
    for (const stamp of island.stamps) {
      const sd = Math.hypot(x - stamp.x, z - stamp.z);
      if (sd >= stamp.radius) continue;
      const inner = stamp.radius * (1 - clamp(stamp.blend, 0.05, 0.95));
      const m = sd <= inner ? 1 : 1 - smoothstep(inner, stamp.radius, sd);
      surfaceY = lerp(surfaceY, stamp.targetY, m);
    }
  }

  // ── Cave trench carve is OPT-IN (see IslandSurfaceOptions) ──
  if (opts?.carveCaves) {
    const carve = getCaveCarve(island, x, z);
    if (carve) surfaceY = surfaceY * (1 - carve.mask) + carve.floorY * carve.mask;
  }

  // The floor relaxes toward the rim so beach/cliff shores may dip below the
  // waterline; interior floors (incl. archipelago saddles) are unchanged.
  const effFloor = lerp(floor, -6.5, smoothstep(0.9, 1.02, distRatio));
  return Math.max(effFloor, surfaceY);
}

/** Carved cave-tunnel floor height at (x, z), or null outside every cave
 *  footprint. In-cave locomotion (later physics track) walks on this while
 *  getIslandSurfaceY keeps returning the natural hillside above the tunnel. */
export function getCaveFloorY(island: Island, x: number, z: number): number | null {
  const carve = getCaveCarve(island, x, z);
  if (!carve) return null;
  const natural = getIslandSurfaceY(island, x, z);
  return natural * (1 - carve.mask) + carve.floorY * carve.mask;
}

/** Interior ceiling height above (x, z), or null outside every cave's interior
 *  box. The physics track clamps in-cave player Y below this. */
export function getCaveCeilingY(island: Island, x: number, z: number): number | null {
  if (!island.caves || island.caves.length === 0) return null;
  let best: number | null = null;
  for (const cave of island.caves) {
    const cLen = cave.length ?? 10;
    const cRadius = cave.interiorRadius ?? 3.0;
    const dx = x - cave.position.x;
    const dz = z - cave.position.z;
    const cosR = Math.cos(cave.rotation);
    const sinR = Math.sin(cave.rotation);
    const lx = dx * cosR - dz * sinR;
    const lz = dx * sinR + dz * cosR;
    if (Math.abs(lx) <= cRadius && lz <= 0.6 && lz >= -cLen) {
      // Ceiling ramps down with the descending floor (keeps constant headroom).
      const f0 = cave.floorY ?? cave.position.y - 0.4;
      const fEnd = (cave as { floorYEnd?: number }).floorYEnd ?? f0;
      const along = cLen > 0 ? clamp(-lz / cLen, 0, 1) : 0;
      const floorAt = f0 + (fEnd - f0) * along;
      const ceil = floorAt + cave.height;
      if (best === null || ceil < best) best = ceil;
    }
  }
  return best;
}

/** True when the standing ground at (x, z) sits deep enough under the local
 *  wave surface that a walker should be swimming (beach walk-ins, archipelago
 *  channels). The locomotion track flips player state off this. */
export function isSubmergedAt(
  island: Island,
  x: number,
  z: number,
  t: number,
  depth = 1.05,
  storm = 0,
): boolean {
  const ground = getIslandSurfaceY(island, x, z);
  return ground < gerstnerHeight(x, z, t, WAVE_PARAMS, storm) - depth;
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

/** Deck height of a rope bridge at (x, z), or null when off the deck strip.
 *  Linear span between the two anchored endpoints; the walkable strip extends
 *  width/2 to each side. Shared by server locomotion, client prediction and
 *  the renderer so bridges are genuinely solid. */
export function getBridgeDeckY(
  bridge: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; width: number },
  x: number,
  z: number,
): number | null {
  const dx = bridge.bx - bridge.ax;
  const dz = bridge.bz - bridge.az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return null;
  const t = ((x - bridge.ax) * dx + (z - bridge.az) * dz) / len2;
  if (t < 0 || t > 1) return null;
  const px = bridge.ax + dx * t;
  const pz = bridge.az + dz * t;
  if (Math.hypot(x - px, z - pz) > bridge.width * 0.5) return null;
  // Same catenary sag the client planks draw — feet stand ON the boards.
  const span = Math.sqrt(len2);
  const sag = -Math.sin(t * Math.PI) * Math.min(0.9, span * 0.04);
  return lerp(bridge.ay, bridge.by, t) + sag + 0.16; // plank-top standing surface
}

/**
 * Eruption level of a geyser at shared match time `t`, in [0, 1]: 0 = dormant,
 * 1 = full plume. The cycle rises fast, holds, then eases out over the active
 * window. Deterministic in `t` so the client plume and the server launch
 * impulse agree frame-for-frame (server passes its match clock; the client
 * passes performance.now()/1000 + serverTimeOffset, which tracks the same clock).
 */
export function geyserEruptionLevel(geyser: IslandGeyser, t: number): number {
  const period = Math.max(0.1, geyser.period);
  let phase = (t + geyser.phaseOffset) % period;
  if (phase < 0) phase += period;
  const active = Math.min(geyser.activeDuration, period);
  if (phase >= active) return 0;
  const u = phase / active; // 0..1 across the eruption window
  const rise = smoothstep(0, 0.12, u);
  const fall = 1 - smoothstep(0.72, 1, u);
  return clamp(rise * fall, 0, 1);
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
  // Nest rides just ABOVE the main sail's yard (sail top settles at ~0.82·mastH),
  // so the canvas hangs below it instead of clipping through the basket.
  return H + mastH * 0.86 + 0.12;
}

/** Climb prompt zone for the crow's-nest ladder (main mast is at x=0 in ship-local space). */
export function getCrowNestLadderInteractionBounds(stats: { length: number }) {
  return {
    mastZ: getMainMastLocalZ(stats),
    maxAbsX: 0.88,
    maxAbsZ: 1.38,
  };
}

/** Rail rope stations (SoT braces): the halyard is worked from the bulwarks
 *  on EITHER side of the ship, where the rigging ropes come down — not from a
 *  floating ring amidships. */
export function getSailRopeStationLocals(stats: { length: number; mastCount: number; width?: number }): Array<{ x: number; z: number }> {
  const halfW = (stats.width ?? 5) * 0.5;
  const z = -stats.length * 0.24;
  return [
    { x: halfW - 0.55, z },
    { x: -(halfW - 0.55), z },
  ];
}

/** Legacy single-point accessor — resolves to the starboard rope station. */
export function getSailStationLocal(stats: { length: number; mastCount: number; width?: number }): { x: number; z: number } {
  return getSailRopeStationLocals(stats)[0];
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

// ── Swim-hull footprint ───────────────────────────────────────────────────
// A ship's underwater hull as a tapered XZ prism. Shared verbatim by the
// authoritative server collision (PhysicsSystem.resolveSwimmerShipCollision)
// AND the client swimmer prediction (Game.ts) so the two never drift and a
// swimmer can never visually clip into / rubber-band through the hull.
// `stats` is structural ({ width, length }) so callers can pass SHIP_STATS[type]
// or a ship's stats without a type round-trip.
type HullFootprintStats = { width: number; length: number };

const SWIM_HULL_STATIONS: ReadonlyArray<{ z: number; half: number }> = [
  { z: -0.52, half: 0.18 },
  { z: -0.40, half: 0.45 },
  { z: -0.18, half: 0.57 },
  { z: 0.10, half: 0.60 },
  { z: 0.30, half: 0.46 },
  { z: 0.46, half: 0.22 },
  { z: 0.52, half: 0.07 },
];

/** Half-width of the swim hull at a given ship-local Z (bow +Z), plus margin. */
export function getSwimHullHalfWidth(stats: HullFootprintStats, localZ: number, margin = 0): number {
  const z = clamp(localZ / Math.max(0.001, stats.length), -0.52, 0.52);
  for (let i = 0; i < SWIM_HULL_STATIONS.length - 1; i++) {
    const a = SWIM_HULL_STATIONS[i];
    const b = SWIM_HULL_STATIONS[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / Math.max(0.001, b.z - a.z);
      return Math.max(PLAYER.RADIUS + 0.1, stats.width * (a.half + (b.half - a.half) * t) + margin);
    }
  }
  return Math.max(PLAYER.RADIUS + 0.1, stats.width * SWIM_HULL_STATIONS[SWIM_HULL_STATIONS.length - 1].half + margin);
}

/** True when a ship-local point lies inside the swim-hull footprint. */
export function isInsideSwimHullFootprint(stats: HullFootprintStats, localX: number, localZ: number, margin = 0): boolean {
  if (Math.abs(localZ) > stats.length * 0.52 + margin) return false;
  return Math.abs(localX) <= getSwimHullHalfWidth(stats, localZ, margin);
}

/** Push a ship-local point out of the swim-hull footprint along the axis of
 *  least penetration (matches the server resolver exactly). */
export function pushOutOfSwimHullFootprint(
  stats: HullFootprintStats,
  localX: number,
  localZ: number,
  margin: number,
): { x: number; z: number; pushed: boolean } {
  if (!isInsideSwimHullFootprint(stats, localX, localZ, margin)) {
    return { x: localX, z: localZ, pushed: false };
  }
  const halfLength = stats.length * 0.52 + margin;
  const halfWidthHere = getSwimHullHalfWidth(stats, localZ, margin);
  const sidePen = halfWidthHere - Math.abs(localX);
  const endPen = halfLength - Math.abs(localZ);
  let ux = 0;
  let uz = 0;
  if (sidePen <= endPen) {
    ux = localX >= 0 ? 1 : -1;
  } else {
    uz = localZ >= 0 ? 1 : -1;
  }
  let x = localX;
  let z = localZ;
  const step = 0.16;
  for (let i = 0; i < 56; i++) {
    if (!isInsideSwimHullFootprint(stats, x, z, margin * 0.55)) {
      return { x, z, pushed: true };
    }
    x += ux * step;
    z += uz * step;
  }
  return {
    x: localX + ux * (PLAYER.RADIUS + 0.45),
    z: localZ + uz * (PLAYER.RADIUS + 0.45),
    pushed: true,
  };
}

/** Vertical band [keelY, deckY] within which the swim hull blocks a swimmer.
 *  Below keelY a swimmer transits under the keel; above deckY they are on/above
 *  the deck (boarding is handled separately via the ladder prompt). */
export function getSwimHullVerticalBand(shipY: number, stats: { height: number }): { keelY: number; deckY: number } {
  return {
    keelY: shipY - stats.height * 0.72 - PLAYER.RADIUS,
    deckY: shipY + stats.height + 0.1,
  };
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
