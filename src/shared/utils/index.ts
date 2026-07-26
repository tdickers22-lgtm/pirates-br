import { createNoise2D } from 'simplex-noise';
import type { Island, IslandCave, IslandDock, IslandGeyser, IslandTavern, SeaRock, SeaRockCollider, Ship, ShipType, Vec3, Vec2 } from '../types/index.js';
import { SHIP, SHIP_STATS, PLAYER } from '../constants/index.js';

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

function normalize2D(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
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
function getIslandCoastField(island: Island, angle: number): number {
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

interface IslandSurfaceOptions {
  /** Skip the cave-MOUTH trench cut (see carveCaveMouthAt). Internal: only the
   *  carve itself, which needs the uncut hillside to cut FROM, passes this.
   *  Everything else — physics footing, the terrain mesh, prop seating — must
   *  see the same carved ground, or the mouth grows an invisible step. */
  skipMouthCarve?: boolean;
}

// ── Cave interior: ONE canonical hollow volume ──────────────────────────────
// A cave system is the UNION of oriented segment boxes. Everything that has to
// agree about where the rock is — the standing floor, the ceiling, the wall
// pushout, the client's tube meshes — derives from the SAME hard region:
//
//     |lx| <= interiorRadius,  -length <= lz <= CAVE_NEAR_OVERHANG
//
// The half-open near overhang is what makes the union CONTIGUOUS: a child
// segment starts exactly at its parent's far wall, so without an overlap band
// the two boxes would meet on a plane and a body-radius pad on each side would
// wall the passage shut. 1.2 m of overlap leaves room for both pads.
//
// Historical bug this replaces: the standing floor used to be a FEATHERED blend
// `natural*(1-mask) + floorY*mask` whose mask fell off across a 1 m long pad and
// a 0.7 m lateral pad — pads that sit INSIDE the ceiling box. Walking through a
// junction therefore mixed 20-40 m of mountainside into the cave floor and
// stepped the footing by up to 14 m between two 25 cm-apart samples. Inside the
// hard region the floor is now the cave floor, full stop. The only place rock
// and hillside still blend is the MOUTH trench below, which is a cut in the
// terrain rather than a hollow inside it.

/** Interior extends this far PAST a segment's near plane so adjacent segments
 *  share a real overlap band rather than meeting on a plane. */
export const CAVE_NEAR_OVERHANG = 1.2;
/** Body clearance kept between a walker's centre and a cave's rock wall. */
export const CAVE_WALL_PAD = 0.35;

/** Cave-local frame of a segment: +z points OUTWARD (entrance side), the tunnel
 *  runs to -z. `depth` is the distance to the nearest wall of this segment's
 *  hard box — positive inside, negative outside. Mouth segments have no near
 *  wall (you can walk straight out), so their near plane never bounds `depth`. */
function caveSegLocal(cave: IslandCave, x: number, z: number) {
  const cLen = cave.length ?? 10;
  const cRadius = cave.interiorRadius ?? 3.0;
  const cFloorY = cave.floorY ?? cave.position.y - 0.4;
  const cFloorEnd = cave.floorYEnd ?? cFloorY;
  const dx = x - cave.position.x;
  const dz = z - cave.position.z;
  const cosR = Math.cos(cave.rotation);
  const sinR = Math.sin(cave.rotation);
  const lx = dx * cosR - dz * sinR;
  const lz = dx * sinR + dz * cosR;
  // Floor ramps from cFloorY (near end) to cFloorEnd (far end) so the cave can
  // DESCEND deep into the mountain rather than sit under a thin roof.
  const along = cLen > 0 ? clamp(-lz / cLen, 0, 1) : 0;
  const floorAt = cFloorY + (cFloorEnd - cFloorY) * along;
  const openNear = cave.hasMouth === true;
  const sideDepth = Math.min(cRadius - Math.abs(lx), lz + cLen);
  // Membership always stops at the near plane (otherwise a mouth's "interior"
  // would stretch out over the whole beach in front of it); the wall pushout
  // ignores it for mouths so walking out of a cave is never blocked.
  const depth = Math.min(sideDepth, CAVE_NEAR_OVERHANG - lz);
  const wallDepth = openNear ? sideDepth : depth;
  return { lx, lz, cLen, cRadius, floorAt, ceilAt: floorAt + cave.height, depth, wallDepth, openNear, cosR, sinR };
}

export interface CaveInterior {
  /** Walkable cave floor — the pure carved floor, never mixed with hillside. */
  floorY: number;
  /** Highest covering segment's ceiling (the union's headroom). */
  ceilingY: number;
  /** Distance to the nearest rock wall (metres, > 0 inside). */
  wallDist: number;
}

/** The cave hollow at (x, z), or null outside every segment's hard box.
 *  Where segments overlap the floor is blended by squared wall-distance, so a
 *  junction reads as one smoothly-graded room instead of stepping between the
 *  two segment floors at whichever boundary happened to win an argmax. */
export function getCaveInteriorAt(island: Island, x: number, z: number): CaveInterior | null {
  const caves = island.caves;
  if (!caves || caves.length === 0) return null;
  let wSum = 0;
  let fSum = 0;
  let best = -Infinity;
  let bestFloor = 0;
  let ceiling = -Infinity;
  for (const cave of caves) {
    const s = caveSegLocal(cave, x, z);
    if (s.depth <= 0) continue;
    // Mouth segments are unbounded outward; cap their weight so the open air in
    // front of a mouth can't out-vote the tunnel it belongs to.
    const d = Math.min(s.depth, s.cRadius);
    const w = d * d;
    wSum += w;
    fSum += w * s.floorAt;
    if (s.depth > best) { best = s.depth; bestFloor = s.floorAt; }
    if (s.ceilAt > ceiling) ceiling = s.ceilAt;
  }
  if (best === -Infinity) return null;
  return {
    floorY: wSum > 1e-9 ? fSum / wSum : bestFloor,
    ceilingY: ceiling,
    wallDist: best,
  };
}

// ── The cave MOUTH trench: ONE carve, shared by the mesh and the ground ─────
// A mouth is a real gash in the hillside: the terrain drops to the cave floor
// through the doorway and up the two gully walls flanking it. This carve used
// to live only in the CLIENT (island/CaveBuilder's makeCaveMouthCarver) while
// the server stood players on the UNcarved hillside, so every mouth had a
// 2-4 m invisible step: walking out of a cave popped you up onto a rim that
// isn't drawn, and shallow-angle exits bricked against a gully wall that isn't
// there either. It is shared, and unconditional, so the drawn ground and the
// walked ground are the same surface.

/** Lateral reach of the gully cut, as a multiple of the tunnel radius. The
 *  client's throat collar is sized off this so the collar always wraps PAST
 *  the cut edge — the sliver between them was a sky hole. */
export const CAVE_MOUTH_TRENCH_K = 1.5;
/** Outward fade of the gully walls beyond CAVE_MOUTH_TRENCH_K·radius. */
export const CAVE_MOUTH_TRENCH_FADE = 1.9;

/** Trench-carved ground at (x, z) given the natural surface `y` there, plus how
 *  deep the cut is (drives the client's rock recolor and decor rejection).
 *
 *  The cut MUST stay a smooth function of (lz, lx) only: an earlier per-vertex
 *  "already roofed → skip" gate made neighbouring terrain vertices diverge by
 *  metres and sliced diagonal faces across the passage. */
function carveCaveMouthAt(island: Island, x: number, z: number, y: number): { y: number; carved: number } {
  const caves = island.caves;
  if (!caves || caves.length === 0) return { y, carved: 0 };
  let out = y;
  let carved = 0;
  for (const cave of caves) {
    if (!cave.hasMouth) continue; // only real surface mouths open the hillside
    if (out <= cave.floorY) continue;
    const s = caveSegLocal(cave, x, z);
    const ax = Math.abs(s.lx);
    // Cheap bbox reject — most of an island is nowhere near a mouth.
    if (ax > s.cRadius * CAVE_MOUTH_TRENCH_K + CAVE_MOUTH_TRENCH_FADE) continue;
    if (s.lz > CAVE_MOUTH_TRENCH_FADE + 2.5 || s.lz < -s.cLen - 1) continue;
    const ceilAt = s.ceilAt;
    // Any terrain skimming the passage volume gets flagged so the color pass
    // paints it CAVE ROCK and decor skips it — near the mouth the hillside
    // legitimately crosses the arch's upper region, and those shelves must not
    // read as floating grass.
    const inStrip = ax < s.cRadius * 1.6 && s.lz < 1.2;
    if (inStrip && out < ceilAt + 1.2) carved = Math.max(carved, 0.35);
    // Gully walls fade OUTSIDE the tube's widest wall radius so partially-cut
    // vertices land on the open-air trench sides, never inside the rock shell.
    const latK = smoothstep(s.cRadius * CAVE_MOUTH_TRENCH_K, s.cRadius * CAVE_MOUTH_TRENCH_K + CAVE_MOUTH_TRENCH_FADE, ax);
    // Approach gully outward of the mouth plane (fades by lz ≈ 4.4).
    const outerK = smoothstep(1.6, 4.4, s.lz);
    // DOORWAY-ONLY cut: open the sky above just the first ~2.6 m. The
    // carved→natural transition wall this creates is short, lands above head
    // height, and is wrapped by the rock collar — it reads as the doorway's
    // inner lintel.
    const depthCapK = smoothstep(1.4, 2.6, -s.lz);
    const keep = Math.max(latK, outerK, depthCapK);
    const target = s.floorAt + (out - s.floorAt) * keep;
    if (target < out) {
      carved = Math.max(carved, out - target);
      out = target;
    }
  }
  return { y: out, carved };
}

/** Is (x, z) anywhere near a mouth's cut at all? Pure trig, no heightfield —
 *  callers that already hold a surface height use it to skip the (comparatively
 *  expensive) re-sample below for the ~99% of an island that no mouth touches. */
export function isNearCaveMouthCut(island: Island, x: number, z: number): boolean {
  const caves = island.caves;
  if (!caves || caves.length === 0) return false;
  for (const cave of caves) {
    if (!cave.hasMouth) continue;
    const s = caveSegLocal(cave, x, z);
    if (Math.abs(s.lx) > s.cRadius * CAVE_MOUTH_TRENCH_K + CAVE_MOUTH_TRENCH_FADE) continue;
    if (s.lz > CAVE_MOUTH_TRENCH_FADE + 2.5 || s.lz < -s.cLen - 1) continue;
    return true;
  }
  return false;
}

/** The mouth trench at (x, z): the carved ground and the cut depth. Same
 *  surface `getIslandSurfaceY` returns — this form just also reports the depth,
 *  for the terrain color pass and decor rejection. */
export function getCaveMouthCarve(island: Island, x: number, z: number): { y: number; carved: number } {
  if (!island.caves || island.caves.length === 0) return { y: getIslandSurfaceY(island, x, z), carved: 0 };
  return carveCaveMouthAt(island, x, z, getIslandSurfaceY(island, x, z, { skipMouthCarve: true }));
}

/**
 * Push (x, z) back inside the cave union, keeping `pad` metres of body
 * clearance from the rock. Cave walls used to be PURELY IMPLICIT — step out of
 * the ceiling box and the standing floor silently became the natural hillside
 * 10-50 m overhead, so every interior wall in the game was a teleporter. This
 * is the wall.
 *
 * Only meaningful for a body already inside the union (callers gate on that):
 * it projects onto the deepest-covering segment's box, which is the nearest
 * interior point for any sane single-tick step. A mouth segment's near plane is
 * open, so walking out of a cave is never blocked.
 */
export function resolveCaveWallCollision(
  island: Island,
  x: number,
  z: number,
  pad: number = CAVE_WALL_PAD,
): { x: number; z: number; pushed: boolean } {
  const caves = island.caves;
  if (!caves || caves.length === 0) return { x, z, pushed: false };
  let best: ReturnType<typeof caveSegLocal> | null = null;
  let bestCave: IslandCave | null = null;
  for (const cave of caves) {
    const s = caveSegLocal(cave, x, z);
    // A segment narrower than the body can't hold it — never project into one.
    if (s.cRadius <= pad) continue;
    if (!best || s.wallDepth > best.wallDepth) { best = s; bestCave = cave; }
  }
  if (!best || !bestCave || best.wallDepth >= pad) return { x, z, pushed: false };
  const limit = best.cRadius - pad;
  const lx = clamp(best.lx, -limit, limit);
  let lz = Math.max(best.lz, -best.cLen + pad);
  if (!best.openNear) lz = Math.min(lz, CAVE_NEAR_OVERHANG - pad);
  if (lx === best.lx && lz === best.lz) return { x, z, pushed: false };
  // local → world (inverse of the yaw in caveSegLocal)
  return {
    x: bestCave.position.x + lx * best.cosR + lz * best.sinR,
    z: bestCave.position.z - lx * best.sinR + lz * best.cosR,
    pushed: true,
  };
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

  // The floor relaxes toward the rim so beach/cliff shores may dip below the
  // waterline; interior floors (incl. archipelago saddles) are unchanged.
  const effFloor = lerp(floor, -6.5, smoothstep(0.9, 1.02, distRatio));
  const groundY = Math.max(effFloor, surfaceY);
  // ── The cave-mouth trench is part of the GROUND, not a client decoration ──
  if (opts?.skipMouthCarve || !island.caves || island.caves.length === 0) return groundY;
  return carveCaveMouthAt(island, x, z, groundY).y;
}

/** Carved cave-tunnel floor height at (x, z), or null outside the cave union.
 *  In-cave locomotion walks on this while getIslandSurfaceY keeps returning the
 *  natural hillside above the tunnel. Inside the union this is the PURE cave
 *  floor: no hillside is ever mixed in (see getCaveInteriorAt). */
export function getCaveFloorY(island: Island, x: number, z: number): number | null {
  return getCaveInteriorAt(island, x, z)?.floorY ?? null;
}

/** Interior ceiling height above (x, z), or null outside the cave union. The
 *  physics track clamps in-cave player Y below this. Open space is the UNION of
 *  segment boxes, so the ceiling is the HIGHEST covering segment: keeping the
 *  lowest meant a side-vein overlapping a tall chamber slammed an invisible 2 m
 *  lid onto the open room and jumping in caves bonked on nothing. */
export function getCaveCeilingY(island: Island, x: number, z: number): number | null {
  return getCaveInteriorAt(island, x, z)?.ceilingY ?? null;
}

/**
 * True when a point is INSIDE a cave tunnel rather than on the hillside above
 * it: under the tunnel's ceiling, with a carved floor below the natural grade.
 * This is the same test PhysicsSystem.islandStandY uses to swap the standing
 * floor for the cave floor, so callers that need "is this pirate in a cave"
 * (cave reverb, stone footsteps) agree with the ground they're standing on.
 */
export function isInsideCaveInterior(island: Island, x: number, y: number, z: number): boolean {
  const ceiling = getCaveCeilingY(island, x, z);
  // 0.1m of head clearance — LOCO.CAVE_HEAD_CLEARANCE, mirrored here so the
  // shared test matches the server's floor swap exactly.
  if (ceiling === null || y >= ceiling - 0.1) return false;
  const caveFloor = getCaveFloorY(island, x, z);
  return caveFloor !== null && caveFloor < getIslandSurfaceY(island, x, z);
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

/** Walkable deck half-width at a ship-local z — the BULWARK INNER FACE taper
 *  (single source of truth; PhysicsSystem's clamp and every station placement
 *  read this). Stations placed with the naive W/2−margin fell OFF this taper
 *  near bow/stern on the wider hulls, which is how "use cannon" could snap a
 *  player outside the walkable deck and into the sea. */
export function getShipDeckWalkHalfWidth(stats: { width: number; length: number }, localZ: number, margin = 0): number {
  const z = Math.max(-0.5, Math.min(0.5, localZ / Math.max(0.001, stats.length)));
  // The forward-quarter stations follow the RENDERED bulwark: the side bulwark is
  // a straight run at 0.44·W out to z = 0.39·L and the bow breastwork spans
  // 0.72·W at 0.36·L, so the old 0.37/0.20 taper walled pirates off up to 1.8 m
  // of visible bow deck. 0.40/0.30 keeps the clamp just inboard of both.
  const stations = [
    { z: -0.5, half: 0.23 },
    { z: -0.36, half: 0.38 },
    { z: -0.08, half: 0.42 },
    { z: 0.22, half: 0.40 },
    { z: 0.42, half: 0.30 },
    { z: 0.5, half: 0.05 },
  ];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / Math.max(0.001, b.z - a.z);
      return stats.width * (a.half + (b.half - a.half) * t) + margin;
    }
  }
  return stats.width * stations[stations.length - 1].half + margin;
}

/** Climb prompt zone for the crow's-nest ladder (main mast is at x=0 in ship-local space). */
export function getCrowNestLadderInteractionBounds(stats: { length: number }) {
  return {
    mastZ: getMainMastLocalZ(stats),
    maxAbsX: 0.88,
    maxAbsZ: 1.38,
  };
}

/** Rail rope stations (halyards), worked from the pin rails at the bulwark.
 *  Single-master: abeam the mainmast (classic). Multi-master: in the CLEAR
 *  BAND midway between the first two cannon rows — abeam-the-mast placement
 *  stacked the halyard cleat directly on the forward gun ("the ships are too
 *  cramped, I don't know what I'm pressing X for"). x hugs the bulwark taper
 *  so the rack never floats off the deck edge. */
export function getSailRopeStationLocals(stats: { length: number; mastCount: number; width: number }): Array<{ x: number; z: number }> {
  const halfW = stats.width * 0.5;
  let z = getMainMastLocalZ(stats);
  if (stats.mastCount > 1) {
    // Midway between the first two broadside rows (rows sit at L*0.2 − slot ·
    // L*0.5/(perSide−1); brig carries 2 guns a side, galleon 4).
    const cannonsPerSide = stats.mastCount === 2 ? 2 : 4;
    const rowSpacing = stats.length * 0.5 / (cannonsPerSide - 1);
    z = stats.length * 0.2 - rowSpacing * 0.5;
  }
  const x = Math.min(halfW * 0.9 - 0.6, getShipDeckWalkHalfWidth(stats, z, -0.2));
  return [
    { x, z },
    { x: -x, z },
  ];
}

/** Brace stations: the ropes that ANGLE the yard. Single-master: at the rails
 *  forward of the quarterdeck. Multi-masters keep them INBOARD amidships-aft —
 *  their rails are wall-to-wall gun stations, so rail braces sat on top of the
 *  aft cannons. */
export function getBraceStationLocals(stats: { length: number; width: number; mastCount?: number }): Array<{ x: number; z: number; dir: -1 | 1 }> {
  const halfW = stats.width * 0.5;
  const mastCount = stats.mastCount ?? 1;
  const multi = mastCount > 1;
  // Multi-masters: inboard columns x-clear of the centreline ammo chest, z
  // threaded between the aft gun rows, the helm furniture and the binnacle.
  const z = mastCount === 3 ? -stats.length * 0.24 : multi ? -stats.length * 0.2 : -stats.length * 0.22;
  const x = multi ? 1.3 : halfW - 0.6;
  return [
    { x, z, dir: 1 },
    { x: -x, z, dir: -1 },
  ];
}

/** Legacy single-point accessor — resolves to the starboard rope station. */
export function getSailStationLocal(stats: { length: number; mastCount: number; width: number }): { x: number; z: number } {
  return getSailRopeStationLocals(stats)[0];
}

interface ShipCompanionwayConfig {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  stairHalfWidth: number;
  stairFrontZ: number;
  stairBackZ: number;
}

export function getShipCompanionwayConfig(stats: { width: number; length: number }): ShipCompanionwayConfig {
  // Deliberately NARROW and near the centreline: the stairwell footprint (and its
  // coaming colliders, inflated by player radius) must stay clear of the rail
  // columns where the cannon stands, sail-rope stations and gangways live. The
  // old W*0.2 halfX reached x≈1.95 on the sloop — the starboard coaming AABB then
  // CONTAINED the cannon stand point (x=1.85), so mounting a cannon snapped you
  // inside the wall collider and its ejection shoved you overboard.
  const halfX = Math.min(1.1, Math.max(0.85, stats.width * 0.16));
  const halfZ = Math.max(1.4, stats.length * 0.13);
  const cx = stats.width * 0.05;
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

interface ShipQuarterdeckConfig {
  /** Dais footprint (ship-local). */
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  /** How far the dais top sits above the flat weather deck (metres). */
  rise: number;
  /** Depth of the front step run that ramps up onto the dais. */
  stepDepth: number;
  /** Convenience: forward (bow-side) and aft edges of the dais footprint. */
  frontZ: number;
  backZ: number;
}

/** The stern helm dais (quarterdeck): a genuinely raised captain's platform the
 *  wheel sits on. Single source of truth shared by the renderer (geometry), the
 *  server (raised foot height at the stern) and the helm camera, so the visible
 *  platform and the surface you stand on can never drift apart. */
export function getShipQuarterdeckConfig(stats: { width: number; length: number }): ShipQuarterdeckConfig {
  const cx = 0;
  const cz = -stats.length * 0.33;
  const halfX = stats.width * 0.36;
  const halfZ = stats.length * 0.095;
  return {
    cx,
    cz,
    halfX,
    halfZ,
    rise: 0.45,
    stepDepth: 0.6,
    frontZ: cz + halfZ,
    backZ: cz - halfZ,
  };
}

/** Standing surface of the FLAT weather deck. Every "how high is the deck here"
 *  question starts here and adds getShipDeckRaiseAt for the quarterdeck dais. */
export function getShipDeckY(shipY: number, stats: { height: number }): number {
  return shipY + stats.height + SHIP.DECK_STAND_OFFSET;
}

/** Standing surface of the cargo hold, below the companionway. */
export function getShipHoldFloorY(shipY: number): number {
  return shipY + SHIP.HOLD_FLOOR_OFFSET;
}

/** Raised standing height at a ship-local point relative to the flat deck: the
 *  quarterdeck dais lifts the stern, ramping up over its front step so a walker
 *  steps up smoothly. Returns 0 anywhere off the dais. */
export function getShipDeckRaiseAt(local: { x: number; z: number }, stats: { width: number; length: number }): number {
  const qd = getShipQuarterdeckConfig(stats);
  if (Math.abs(local.x - qd.cx) > qd.halfX || local.z > qd.frontZ || local.z < qd.backZ) return 0;
  // Ramp from 0 at the front lip up to full rise over stepDepth, flat thereafter.
  const up = clamp((qd.frontZ - local.z) / Math.max(0.001, qd.stepDepth), 0, 1);
  return qd.rise * up;
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

function getShipBoardingLadderWorldPoints(ship: Pick<Ship, 'type' | 'position' | 'rotation'>): Array<{ x: number; y: number; z: number; localX: number; localZ: number }> {
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

// Plan-view stations mirror the RENDERED wale beam (ShipRenderer LOFT_STATIONS:
// dh × the tumblehome bulge at `mid`), so the widest blocking line is the widest
// visible line and nothing invisible sticks out abeam.
const SWIM_HULL_STATIONS: ReadonlyArray<{ z: number; half: number }> = [
  { z: -0.52, half: 0.20 },
  { z: -0.36, half: 0.526 },
  { z: -0.22, half: 0.565 },
  { z: -0.08, half: 0.599 },
  { z: 0.07, half: 0.556 },
  { z: 0.22, half: 0.510 },
  { z: 0.32, half: 0.386 },
  { z: 0.42, half: 0.266 },
  { z: 0.52, half: 0.055 },
];

/** Section taper factor on the plan-view half-width at a depth fraction below
 *  the waterline (0 = at/above the waterline, 1 = keel depth). Mirrors the
 *  rendered section (wale → waterline wlF → bilgeF → keel): under the waterline
 *  the hull tucks in hard, so a swimmer can hug the visible bilge curve instead
 *  of being walled out 1–2 m clear of it. */
function swimHullSectionFactor(verticalT: number): number {
  const t = clamp(verticalT, 0, 1);
  if (t <= 0) return 1;
  // 1.0 at the waterline → 0.79 just under → 0.5 at the keel (ShipRenderer's
  // wlF/bilgeF ratios against the wale beam).
  return t < 0.5
    ? 1 - 0.42 * (t / 0.5)
    : 0.58 - 0.08 * ((t - 0.5) / 0.5);
}

/** Where a swimmer's feet sit in the hull section, 0 = at/above the waterline,
 *  1 = at (or below) the rendered keel. Shared so client prediction and the
 *  authoritative resolver taper identically. */
export function getSwimHullVerticalT(
  y: number,
  shipY: number,
  stats: { height: number },
  type?: ShipType,
): number {
  const draft = stats.height * (type ? SHIP.HULL_DRAFT_F[type] : SHIP.HULL_DRAFT_F_FALLBACK);
  return clamp((shipY - y) / Math.max(0.001, draft), 0, 1);
}

/** Half-width of the swim hull at a given ship-local Z (bow +Z), plus margin.
 *  `verticalT` (see getSwimHullVerticalT) tapers the section with depth. */
export function getSwimHullHalfWidth(stats: HullFootprintStats, localZ: number, margin = 0, verticalT = 0): number {
  const z = clamp(localZ / Math.max(0.001, stats.length), -0.52, 0.52);
  const section = swimHullSectionFactor(verticalT);
  for (let i = 0; i < SWIM_HULL_STATIONS.length - 1; i++) {
    const a = SWIM_HULL_STATIONS[i];
    const b = SWIM_HULL_STATIONS[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / Math.max(0.001, b.z - a.z);
      return Math.max(PLAYER.RADIUS + 0.1, stats.width * (a.half + (b.half - a.half) * t) * section + margin);
    }
  }
  return Math.max(PLAYER.RADIUS + 0.1, stats.width * SWIM_HULL_STATIONS[SWIM_HULL_STATIONS.length - 1].half * section + margin);
}

/** True when a ship-local point lies inside the swim-hull footprint. */
export function isInsideSwimHullFootprint(stats: HullFootprintStats, localX: number, localZ: number, margin = 0, verticalT = 0): boolean {
  if (Math.abs(localZ) > stats.length * 0.52 + margin) return false;
  return Math.abs(localX) <= getSwimHullHalfWidth(stats, localZ, margin, verticalT);
}

/** Push a ship-local point out of the swim-hull footprint along the axis of
 *  least penetration (matches the server resolver exactly). */
export function pushOutOfSwimHullFootprint(
  stats: HullFootprintStats,
  localX: number,
  localZ: number,
  margin: number,
  verticalT = 0,
): { x: number; z: number; pushed: boolean } {
  if (!isInsideSwimHullFootprint(stats, localX, localZ, margin, verticalT)) {
    return { x: localX, z: localZ, pushed: false };
  }
  const halfLength = stats.length * 0.52 + margin;
  const halfWidthHere = getSwimHullHalfWidth(stats, localZ, margin, verticalT);
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
    if (!isInsideSwimHullFootprint(stats, x, z, margin * 0.55, verticalT)) {
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
 *  the deck (boarding is handled separately via the ladder prompt).
 *  keelY tracks the RENDERED draft (SHIP.HULL_DRAFT_F ⇔ ShipRenderer
 *  HULL_SHAPES.draftF) — the old 0.72·H keel walled swimmers out of ~1.6 m of
 *  visually open water under every hull. */
export function getSwimHullVerticalBand(
  shipY: number,
  stats: { height: number },
  type?: ShipType,
): { keelY: number; deckY: number } {
  const draftF = type ? SHIP.HULL_DRAFT_F[type] : SHIP.HULL_DRAFT_F_FALLBACK;
  return {
    keelY: shipY - stats.height * draftF - 0.15,
    deckY: getShipDeckY(shipY, stats),
  };
}

// ── Dock frame (CANONICAL) ──────────────────────────────────────────────────
// world = dockCenter + Ry(rotation) · local — the same three.js convention the
// client dock group (group.rotation.y = dock.rotation) and the server's
// toDockLocal already use. +local-z points SEAWARD: MapGenerator centers the
// dock at shore + 0.42·L·forward with forward = (sin θ, cos θ), so the shore
// end is −0.42·L and the swim-up ladder belongs at the +Z tip.
export function dockLocalToWorld(dock: IslandDock, lx: number, ly: number, lz: number): Vec3 {
  const cos = Math.cos(dock.rotation);
  const sin = Math.sin(dock.rotation);
  return {
    x: dock.position.x + lx * cos + lz * sin,
    y: dock.position.y + ly,
    z: dock.position.z - lx * sin + lz * cos,
  };
}

/** Dock-local XZ of a world point — exact inverse of dockLocalToWorld. */
export function toDockLocalPoint(dock: IslandDock, x: number, z: number): { x: number; z: number } {
  const dx = x - dock.position.x;
  const dz = z - dock.position.z;
  const cos = Math.cos(dock.rotation);
  const sin = Math.sin(dock.rotation);
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

/** World point at the SEAWARD swim-up ladder (for prompts / climb checks). */
export function getIslandDockSwimLadderPoint(dock: IslandDock): Vec3 {
  return dockLocalToWorld(dock, 0, 0.38, dock.length * 0.44);
}

// ── Tavern shell ────────────────────────────────────────────────────────────
// The tavern GLB is an EXACT 7.6 × 6.4 footprint (scripts/blender/
// build_buildings.py: `W, D = 7.6, 6.4  # footprint contract — EXACT`) with
// plaster walls 3.0 m tall on a 0.18 m plank floor and a 1.7 m door in the
// front (dock-facing) wall. Tavern-local space is the same three.js convention
// as docks/ships: world = position + Ry(rotation) · local, and MapGenerator
// aims rotation at the dock, so +local-z is the door/dock-facing side.
const TAVERN_WALL_HALF_T = 0.18;
const TAVERN_DOOR_HALF = 0.85;
const TAVERN_WALL_HEIGHT = 3.18;

interface TavernWallSegment {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function tavernLocalToWorld(tavern: IslandTavern, lx: number, lz: number): { x: number; z: number } {
  const cos = Math.cos(tavern.rotation);
  const sin = Math.sin(tavern.rotation);
  return {
    x: tavern.position.x + lx * cos + lz * sin,
    z: tavern.position.z - lx * sin + lz * cos,
  };
}

export function toTavernLocal(tavern: IslandTavern, x: number, z: number): { x: number; z: number } {
  const dx = x - tavern.position.x;
  const dz = z - tavern.position.z;
  const cos = Math.cos(tavern.rotation);
  const sin = Math.sin(tavern.rotation);
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

/** The four tavern walls as tavern-local AABBs, the front (+Z) wall split
 *  around the doorway. SINGLE TRUTH for on-foot collision (PhysicsSystem) and
 *  shot occlusion (Match hitscan / cannonballs) so the building is as solid to
 *  a musket ball as it is to a boot. */
export function getTavernWallSegments(tavern: IslandTavern): TavernWallSegment[] {
  const hx = tavern.width * 0.5;
  const hz = tavern.depth * 0.5;
  const t = TAVERN_WALL_HALF_T;
  const d = TAVERN_DOOR_HALF;
  return [
    // back wall (away from the dock)
    { minX: -hx - t, maxX: hx + t, minZ: -hz - t, maxZ: -hz + t },
    // side walls (full depth, so the corners are closed)
    { minX: -hx - t, maxX: -hx + t, minZ: -hz - t, maxZ: hz + t },
    { minX: hx - t, maxX: hx + t, minZ: -hz - t, maxZ: hz + t },
    // front wall, split around the door
    { minX: -hx - t, maxX: -d, minZ: hz - t, maxZ: hz + t },
    { minX: d, maxX: hx + t, minZ: hz - t, maxZ: hz + t },
  ];
}

/** World Y band the tavern walls block within (feet height). */
export function getTavernWallBand(tavern: IslandTavern): { minY: number; maxY: number } {
  return { minY: tavern.position.y - 1.2, maxY: tavern.position.y + TAVERN_WALL_HEIGHT };
}

/** Broad-phase radius covering the whole tavern shell (plus wall thickness). */
export function getTavernBoundsRadius(tavern: IslandTavern): number {
  return Math.hypot(tavern.width * 0.5, tavern.depth * 0.5) + TAVERN_WALL_HALF_T;
}

/** Push a circle of `radius` at a tavern-local XZ out of the wall AABBs along
 *  the axis of least penetration (same pattern as the ship-deck coamings). */
export function pushOutOfTavernWalls(
  tavern: IslandTavern,
  localX: number,
  localZ: number,
  radius: number,
): { x: number; z: number; pushed: boolean } {
  let x = localX;
  let z = localZ;
  let pushed = false;
  for (const seg of getTavernWallSegments(tavern)) {
    const ex0 = seg.minX - radius;
    const ex1 = seg.maxX + radius;
    const ez0 = seg.minZ - radius;
    const ez1 = seg.maxZ + radius;
    if (x <= ex0 || x >= ex1 || z <= ez0 || z >= ez1) continue;
    const dl = x - ex0;
    const dr = ex1 - x;
    const db = z - ez0;
    const dt = ez1 - z;
    const m = Math.min(dl, dr, db, dt);
    if (m === dl) x = ex0;
    else if (m === dr) x = ex1;
    else if (m === db) z = ez0;
    else z = ez1;
    pushed = true;
  }
  return { x, z, pushed };
}

/** Nearest hit distance along a unit `direction` against the tavern shell, or
 *  null. Walls are treated as solid boxes; the doorway gap is genuinely open. */
export function intersectRayTavern(
  origin: Vec3,
  direction: Vec3,
  range: number,
  tavern: IslandTavern,
): number | null {
  const band = getTavernWallBand(tavern);
  // Vertical slab first — a shot passing well over the roof never touches walls.
  let tEnter = 0;
  let tExit = range;
  if (Math.abs(direction.y) > 1e-6) {
    const tA = (band.minY - origin.y) / direction.y;
    const tB = (band.maxY - origin.y) / direction.y;
    tEnter = Math.max(tEnter, Math.min(tA, tB));
    tExit = Math.min(tExit, Math.max(tA, tB));
  } else if (origin.y < band.minY || origin.y > band.maxY) {
    return null;
  }
  if (tExit < tEnter) return null;

  const cos = Math.cos(tavern.rotation);
  const sin = Math.sin(tavern.rotation);
  const ox = origin.x - tavern.position.x;
  const oz = origin.z - tavern.position.z;
  const lox = ox * cos - oz * sin;
  const loz = ox * sin + oz * cos;
  const ldx = direction.x * cos - direction.z * sin;
  const ldz = direction.x * sin + direction.z * cos;

  let best: number | null = null;
  for (const seg of getTavernWallSegments(tavern)) {
    let t0 = tEnter;
    let t1 = tExit;
    let miss = false;
    for (const axis of [0, 1] as const) {
      const o = axis === 0 ? lox : loz;
      const d = axis === 0 ? ldx : ldz;
      const lo = axis === 0 ? seg.minX : seg.minZ;
      const hi = axis === 0 ? seg.maxX : seg.maxZ;
      if (Math.abs(d) < 1e-6) {
        if (o < lo || o > hi) { miss = true; break; }
        continue;
      }
      const ta = (lo - o) / d;
      const tb = (hi - o) / d;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
      if (t1 < t0) { miss = true; break; }
    }
    if (miss) continue;
    if (best === null || t0 < best) best = t0;
  }
  return best;
}
