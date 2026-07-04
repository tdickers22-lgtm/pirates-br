import { v4 as uuid } from 'uuid';
import type {
  IslandBridge,
  Island, IslandBarrel, IslandBiome, IslandCave, IslandDock, IslandInlet, IslandNpc,
  IslandProfile, IslandProp, IslandPropType, IslandTavern, ItemType,
  TreasureChest, UpgradeStation, ShipUpgradeType, Vec3, Ship, WildlifeAnimal, WildlifeType, SeaRock,
} from '../../shared/types/index.js';
import { WORLD, SHIP_STATS, CHEST_LOOT_TABLE, BARREL_LOOT_TABLE, ECONOMY, WILDLIFE, SEA_ROCKS } from '../../shared/constants/index.js';
import {
  angleWrap,
  directionToYaw,
  buildSeaRockColliders,
  getIslandCoastWeights,
  getIslandMaxRadius,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  mulberry32,
} from '../../shared/utils/index.js';
import { BIOME_PALETTES, getPropSpacingRadius } from '../../shared/props.js';

const SHIP_TYPES = ['sloop', 'brigantine', 'galleon'] as const;

// ── Seeded helpers (never Math.random — the whole map must be reproducible) ──
type Rng = () => number;
const rr = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
const ri = (rng: Rng, lo: number, hi: number) => Math.floor(rr(rng, lo, hi + 1));
const ra = (rng: Rng) => rng() * Math.PI * 2;
function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}
function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// ── Curated island roster ────────────────────────────────────────────────────
// Every named island has a FIXED archetype, biome, size and seed so its
// silhouette, coast bands, caves, stamps and props are identical every match —
// only world placement and rotation vary. Players learn the islands.
type LandmarkType = 'watchtower' | 'shipwreck' | 'standing_stones';

interface RosterEntry {
  name: string;
  style: IslandProfile['terrainStyle'];
  biome: IslandBiome;
  seed: number;
  radius: number;
  /** -1 ⇒ nearly all beach … +1 ⇒ mostly cliff. */
  coastBias: number;
  landmarks: LandmarkType[];
  hasDock: boolean;
  hasTavern: boolean;
  /** Guaranteed inlet (cove/bay) — [widthLo, widthHi], [depthLo, depthHi]. */
  forcedInlet?: { width: [number, number]; depth: [number, number] };
}

const ISLAND_ROSTER: readonly RosterEntry[] = [
  { name: "Smuggler's Rest", style: 'tropical', biome: 'lush', seed: 0x5310a11, radius: 74, coastBias: -0.25, landmarks: ['standing_stones'], hasDock: true, hasTavern: true },
  { name: 'Skull Cove', style: 'rocky', biome: 'bone', seed: 0x2b0be5c, radius: 62, coastBias: 0.05, landmarks: ['shipwreck'], hasDock: true, hasTavern: false, forcedInlet: { width: [0.34, 0.46], depth: [0.3, 0.4] } },
  { name: 'The Crooked Atoll', style: 'archipelago', biome: 'palm_atoll', seed: 0x3c400a7, radius: 88, coastBias: -0.55, landmarks: ['shipwreck'], hasDock: true, hasTavern: false },
  { name: 'Dead Man Shoals', style: 'archipelago', biome: 'bone', seed: 0x4dead10, radius: 56, coastBias: -0.3, landmarks: ['shipwreck'], hasDock: false, hasTavern: false },
  { name: 'Rumrunner Key', style: 'tropical', biome: 'palm_atoll', seed: 0x5b0b0b0, radius: 44, coastBias: -0.6, landmarks: ['shipwreck'], hasDock: true, hasTavern: false },
  { name: "Crow's Perch", style: 'mountain', biome: 'highland', seed: 0x6c0ffee, radius: 96, coastBias: 0.45, landmarks: ['watchtower'], hasDock: true, hasTavern: false },
  { name: "Mermaid's Folly", style: 'plateau', biome: 'lush', seed: 0x7f01111, radius: 70, coastBias: -0.1, landmarks: ['standing_stones'], hasDock: true, hasTavern: false },
  { name: 'Castaway Reach', style: 'tropical', biome: 'lush', seed: 0x8beac42, radius: 102, coastBias: -0.35, landmarks: ['standing_stones', 'shipwreck'], hasDock: true, hasTavern: true },
  { name: 'Kraken Tooth', style: 'twin', biome: 'volcanic', seed: 0x9707071, radius: 78, coastBias: 0.55, landmarks: ['watchtower'], hasDock: false, hasTavern: false },
  { name: 'Booty Bay', style: 'plateau', biome: 'lush', seed: 0xab00713, radius: 108, coastBias: -0.2, landmarks: ['standing_stones'], hasDock: true, hasTavern: true, forcedInlet: { width: [0.75, 0.95], depth: [0.2, 0.28] } },
  { name: 'Gallows Sands', style: 'rocky', biome: 'bone', seed: 0xb6a1105, radius: 40, coastBias: -0.15, landmarks: ['shipwreck'], hasDock: false, hasTavern: false },
  { name: 'Parley Point', style: 'plateau', biome: 'highland', seed: 0xc9a41e4, radius: 66, coastBias: 0.2, landmarks: ['watchtower'], hasDock: true, hasTavern: true },
  { name: 'Old Maw Caldera', style: 'mountain', biome: 'volcanic', seed: 0xdca1de6, radius: 112, coastBias: 0.5, landmarks: ['watchtower'], hasDock: true, hasTavern: false },
  { name: "Widow's Watch", style: 'mountain', biome: 'highland', seed: 0xe51d0e7, radius: 84, coastBias: 0.35, landmarks: ['watchtower', 'standing_stones'], hasDock: false, hasTavern: false },
] as const;

// ── Biome prop scatter tables ───────────────────────────────────────────────
interface ScatterSpec {
  type: IslandPropType;
  weight: number;
  minY: number;
  maxSlope: number;
  dMin: number;
  dMax: number;
  sMin: number;
  sMax: number;
}

const PALM_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.9, maxSlope: 1.4, dMin: 0.25, dMax: 0.93, sMin: 0.85, sMax: 1.25 };
const BOULDER_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.5, maxSlope: 2.4, dMin: 0.08, dMax: 0.95, sMin: 0.75, sMax: 1.35 };
const CLUTTER_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 1.2, maxSlope: 0.42, dMin: 0.2, dMax: 0.8, sMin: 0.9, sMax: 1.1 };

const SCATTER_MIX: Record<IslandBiome, ScatterSpec[]> = {
  lush: [
    { type: 'palm_a', weight: 3.0, ...PALM_SPECS },
    { type: 'palm_b', weight: 2.2, ...PALM_SPECS },
    { type: 'palm_c', weight: 2.0, ...PALM_SPECS },
    { type: 'boulder_a', weight: 0.8, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 0.8, ...BOULDER_SPECS },
    { type: 'crate', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'barrel', weight: 0.5, ...CLUTTER_SPECS },
  ],
  palm_atoll: [
    { type: 'palm_a', weight: 3.4, ...PALM_SPECS },
    { type: 'palm_b', weight: 2.6, ...PALM_SPECS },
    { type: 'palm_c', weight: 2.4, ...PALM_SPECS },
    { type: 'boulder_c', weight: 0.5, ...BOULDER_SPECS },
    { type: 'barrel', weight: 0.4, ...CLUTTER_SPECS },
    { type: 'crate', weight: 0.3, ...CLUTTER_SPECS },
  ],
  volcanic: [
    { type: 'boulder_a', weight: 2.6, ...BOULDER_SPECS },
    { type: 'boulder_b', weight: 1.4, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 2.2, ...BOULDER_SPECS },
    { type: 'palm_c', weight: 0.6, ...PALM_SPECS },
    { type: 'crate', weight: 0.4, ...CLUTTER_SPECS },
  ],
  highland: [
    { type: 'boulder_a', weight: 2.4, ...BOULDER_SPECS },
    { type: 'boulder_b', weight: 1.2, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 1.8, ...BOULDER_SPECS },
    { type: 'palm_b', weight: 0.6, ...PALM_SPECS },
    { type: 'palm_c', weight: 0.7, ...PALM_SPECS },
    { type: 'barrel', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'crate', weight: 0.5, ...CLUTTER_SPECS },
  ],
  bone: [
    { type: 'boulder_c', weight: 1.6, ...BOULDER_SPECS },
    { type: 'boulder_a', weight: 1.0, ...BOULDER_SPECS },
    { type: 'palm_c', weight: 0.8, ...PALM_SPECS },
    { type: 'palm_b', weight: 0.5, ...PALM_SPECS },
    { type: 'crate', weight: 0.9, ...CLUTTER_SPECS },
    { type: 'barrel', weight: 0.9, ...CLUTTER_SPECS },
  ],
};

const SCATTER_DENSITY: Record<IslandBiome, number> = {
  lush: 0.85,
  palm_atoll: 1.0,
  volcanic: 0.7,
  highland: 0.75,
  bone: 0.6,
};

interface CampSite { x: number; z: number; y: number }
interface LandmarkSite { type: LandmarkType; x: number; z: number; yaw: number }

export class MapGenerator {
  private readonly rng: Rng;

  /** Same seed ⇒ bit-identical islands/props/stamps (ids excepted). */
  constructor(seed?: number) {
    const s = seed ?? ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    this.rng = mulberry32(s >>> 0);
  }

  generateIslands(): Island[] {
    const rng = this.rng;
    const islands: Island[] = [];
    const minDist = 145;
    const attempts = 320;

    // Pick this match's subset of the roster; place the big islands first so
    // packing is reliable. Both steps are seeded ⇒ reproducible.
    const picked = shuffled(rng, ISLAND_ROSTER).slice(0, WORLD.ISLAND_COUNT);
    let variant = 0;
    while (picked.length < WORLD.ISLAND_COUNT) {
      const base = ISLAND_ROSTER[variant % ISLAND_ROSTER.length];
      picked.push({ ...base, name: `${base.name} II`, seed: (base.seed ^ (0x1000 + variant)) >>> 0 });
      variant++;
    }
    picked.sort((a, b) => b.radius - a.radius);

    for (const entry of picked) {
      const radius = entry.radius;
      let pos: Vec3 | null = null;
      for (let a = 0; a < attempts; a++) {
        const candidate: Vec3 = {
          x: rr(rng, -800, 800),
          y: 0,
          z: rr(rng, -800, 800),
        };
        let ok = true;
        for (const existing of islands) {
          const dx = candidate.x - existing.position.x;
          const dz = candidate.z - existing.position.z;
          const requiredGap = Math.max(minDist, radius + existing.radius + 46);
          if (Math.sqrt(dx * dx + dz * dz) < requiredGap) { ok = false; break; }
        }
        if (ok) { pos = candidate; break; }
      }
      if (!pos) continue;

      // Per-match variation is placement + rigid rotation ONLY — everything
      // else derives from the entry's fixed seed.
      const rotation = ra(rng);
      const island: Island = {
        id: uuid(),
        name: entry.name,
        position: pos,
        radius,
        profile: this.buildProfile(entry, rotation),
        dock: null,
        tavern: null,
        caves: [],
        chests: [],
        barrels: [],
        upgradeStations: [],
        npcs: [],
        props: [],
        stamps: [],
      };

      // Island-local deterministic stream: caves → structures/stamps → loot → props.
      const islandRng = mulberry32((entry.seed ^ 0x9e3779b9) >>> 0);
      island.caves = this.generateCaves(island, islandRng);
      island.dock = entry.hasDock ? this.generateDock(island, islandRng) : null;
      island.tavern = entry.hasTavern ? this.generateTavern(island, islandRng) : null;
      island.upgradeStations = this.generateUpgradeStations(island, islandRng);
      const camps = this.planCamps(island, islandRng);
      const landmarks = this.planLandmarks(island, entry, islandRng);
      island.chests = this.generateChests(island, islandRng);
      island.barrels = this.generateBarrels(island, islandRng);
      island.npcs = this.generateStoryNpcs(island, islands.length, islandRng);
      island.props = this.generateProps(island, entry, islandRng, camps, landmarks);
      island.bridges = this.generateBridges(island);
      islands.push(island);
    }

    return islands;
  }

  /** Walkable rope bridge between the two main peaks on split-landmass styles.
   *  Endpoints are the actual LOCAL MAXIMA of the final heightfield (grid
   *  search around each gaussian hill center — detail noise shifts the true
   *  summit off-center), so both ends sit flush on the terrain. Deterministic:
   *  pure function of the island, no rng. Deck math is shared
   *  (getBridgeDeckY), so the deck the client draws is the deck physics walks. */
  private generateBridges(island: Island): IslandBridge[] {
    const profile = island.profile;
    const eligible = profile.terrainStyle === 'twin'
      || profile.terrainStyle === 'archipelago'
      || ((profile.terrainStyle === 'mountain' || profile.terrainStyle === 'rocky') && profile.secondaryHillScale > 0.45);
    if (!eligible) return [];
    const localPeak = (hillAngle: number, hillOffset: number) => {
      const cx = island.position.x + Math.cos(hillAngle) * hillOffset * profile.footprintX;
      const cz = island.position.z + Math.sin(hillAngle) * hillOffset * profile.footprintZ;
      let best = { x: cx, z: cz, y: getIslandSurfaceY(island, cx, cz) };
      for (let gx = -3; gx <= 3; gx++) {
        for (let gz = -3; gz <= 3; gz++) {
          const x = cx + gx * 2.4;
          const z = cz + gz * 2.4;
          const y = getIslandSurfaceY(island, x, z);
          if (y > best.y) best = { x, z, y };
        }
      }
      return best;
    };
    const a = localPeak(profile.primaryHillAngle, profile.primaryHillOffset);
    const b = localPeak(profile.secondaryHillAngle, profile.secondaryHillOffset);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const seaBase = 5.15 + island.radius * 0.0085;
    if (span < 7 || span > island.radius * 1.15) return [];
    if (a.y - seaBase < 3 || b.y - seaBase < 3) return [];
    // The bridge must clear the saddle between the peaks — if the terrain
    // midway rises to (or above) the straight deck line, a bridge is silly.
    const midY = (a.y + b.y) * 0.5;
    const saddleY = getIslandSurfaceY(island, (a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
    if (saddleY > midY - 1.6) return [];
    return [{ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, width: 1.9 }];
  }

  private buildProfile(entry: RosterEntry, rotation: number): IslandProfile {
    const rng = mulberry32(entry.seed >>> 0);
    const radius = entry.radius;
    const terrainStyle = entry.style;
    const islandHeading = angleWrap(ra(rng) + rotation);
    const ridgeAxis = angleWrap(islandHeading + rr(rng, -0.48, 0.48));

    let heightProfile = rr(rng, 0.2, 0.48);
    let mesaBias = rr(rng, 0.15, 1);
    let secondaryHillScale = rr(rng, 0.28, 0.72);
    let tertiaryHillScale = rng() > 0.5 ? rr(rng, 0.14, 0.46) : 0;
    let peakBoost = 0;
    let footprintX = rr(rng, 1.08, 1.72);
    let footprintZ = rr(rng, 1.08, 1.72);
    let ridgeBias = rr(rng, -0.24, 0.24);
    let primaryHillOffset = radius * rr(rng, 0.18, 0.34);
    let secondaryHillOffset = radius * rr(rng, 0.16, 0.36);
    let tertiaryHillOffset = radius * rr(rng, 0.12, 0.28);
    let secondaryAngleSpread = Math.PI * rr(rng, 0.72, 1.06);

    if (terrainStyle === 'mountain') {
      heightProfile = rr(rng, 0.68, 1.22);
      peakBoost = rr(rng, 1.05, 2.05);
      mesaBias = rr(rng, 0.05, 0.35);
      secondaryHillScale = rr(rng, 0.4, 0.8);
    } else if (terrainStyle === 'plateau') {
      heightProfile = rr(rng, 0.42, 0.74);
      mesaBias = rr(rng, 0.7, 1.0);
      peakBoost = 0;
      ridgeBias = rr(rng, -0.12, 0.12);
    } else if (terrainStyle === 'rocky') {
      heightProfile = rr(rng, 0.28, 0.58);
      tertiaryHillScale = rr(rng, 0.32, 0.64);
      secondaryHillScale = rr(rng, 0.42, 0.78);
      footprintX = rr(rng, 1.0, 1.5);
      footprintZ = rr(rng, 1.0, 1.5);
    } else if (terrainStyle === 'twin') {
      // Two distinct peaks of comparable height — ridge running between them
      heightProfile = rr(rng, 0.48, 0.86);
      peakBoost = rr(rng, 0.5, 1.05);
      mesaBias = rr(rng, 0.05, 0.3);
      secondaryHillScale = rr(rng, 0.78, 1.05);
      tertiaryHillScale = 0;
      primaryHillOffset = radius * rr(rng, 0.36, 0.5);
      secondaryHillOffset = radius * rr(rng, 0.36, 0.5);
      secondaryAngleSpread = Math.PI * rr(rng, 0.92, 1.08);
      footprintX = rr(rng, 1.4, 1.85);
      footprintZ = rr(rng, 1.05, 1.4);
    } else if (terrainStyle === 'archipelago') {
      // Three smaller peaks each forming their own islet, water flows between
      heightProfile = rr(rng, 0.34, 0.56);
      peakBoost = rr(rng, 0.2, 0.55);
      mesaBias = rr(rng, 0.05, 0.25);
      secondaryHillScale = rr(rng, 0.7, 0.95);
      tertiaryHillScale = rr(rng, 0.55, 0.85);
      primaryHillOffset = radius * rr(rng, 0.32, 0.46);
      secondaryHillOffset = radius * rr(rng, 0.34, 0.5);
      tertiaryHillOffset = radius * rr(rng, 0.32, 0.48);
      secondaryAngleSpread = Math.PI * rr(rng, 0.7, 0.95);
      footprintX = rr(rng, 1.5, 2.0);
      footprintZ = rr(rng, 1.5, 2.0);
    }

    const primaryHillAngle = ridgeAxis + rr(rng, -0.42, 0.42);
    const secondaryHillAngle = primaryHillAngle + secondaryAngleSpread;
    const tertiaryHillAngle = terrainStyle === 'archipelago'
      ? primaryHillAngle + Math.PI * 0.5 + rr(rng, -0.18, 0.18)
      : ridgeAxis + Math.PI * 0.5 + rr(rng, -0.42, 0.42);

    // Coves & bays — the entry's rng makes each named island's inlet layout a
    // fixed part of its identity (rotated rigidly with the island).
    const inlets: IslandInlet[] = [];
    const hillAngles = [primaryHillAngle, secondaryHillAngle, tertiaryHillAngle];
    const farFromHills = (a: number) =>
      hillAngles.every((h) => Math.abs(angleDelta(a, h)) > 0.7);
    const pushInlet = (width: number, depth: number) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const a = angleWrap(ra(rng) + rotation);
        if (!farFromHills(a)) continue;
        if (inlets.some((inl) => Math.abs(angleDelta(a, inl.angle)) < 1.1)) continue;
        inlets.push({ angle: a, width, depth });
        return;
      }
    };
    if (entry.forcedInlet) {
      pushInlet(rr(rng, entry.forcedInlet.width[0], entry.forcedInlet.width[1]), rr(rng, entry.forcedInlet.depth[0], entry.forcedInlet.depth[1]));
    }
    const inletTarget = radius > 78 ? (rng() < 0.7 ? 2 : 1)
      : radius > 50 ? (rng() < 0.6 ? 1 : 0)
        : (rng() < 0.3 ? 1 : 0);
    while (inlets.length < inletTarget) {
      const isBay = rng() < 0.5;
      const before = inlets.length;
      pushInlet(
        isBay ? rr(rng, 0.7, 1.0) : rr(rng, 0.32, 0.5),
        isBay ? rr(rng, 0.16, 0.26) : rr(rng, 0.28, 0.42),
      );
      if (inlets.length === before) break; // no valid slot left
    }

    return {
      islandHeading,
      footprintX,
      footprintZ,
      heightProfile,
      beachSpread: rr(rng, 1.08, 1.26),
      ridgeAxis,
      ridgeBias,
      mesaBias,
      primaryHillAngle,
      secondaryHillAngle,
      tertiaryHillAngle,
      primaryHillOffset,
      secondaryHillOffset,
      tertiaryHillOffset,
      secondaryHillScale,
      tertiaryHillScale,
      peakBoost,
      terrainStyle,
      inlets,
      seed: entry.seed,
      biome: entry.biome,
      palette: BIOME_PALETTES[entry.biome],
      coastBias: entry.coastBias,
    };
  }

  // ── Caves (before any structure so placement can avoid them) ──────────────
  private generateCaves(island: Island, rng: Rng): IslandCave[] {
    const style = island.profile.terrainStyle;
    let count = 0;
    if (style === 'rocky') count = 1 + (rng() < 0.6 ? 1 : 0);
    else if (style === 'mountain') count = rng() < 0.75 ? 1 : 0;
    else if (style === 'plateau') count = rng() < 0.45 ? 1 : 0;
    else count = rng() < 0.25 ? 1 : 0;
    if (count === 0) return [];

    const caves: IslandCave[] = [];
    const profile = island.profile;
    // Only the steep flanks of the island's hills rise fast enough to roof a
    // tunnel — bias the entrance hunt there, then fall back to a golden-angle
    // sweep of the whole interior.
    const hillAngles = [profile.primaryHillAngle, profile.secondaryHillAngle];
    if (profile.tertiaryHillScale > 0) hillAngles.push(profile.tertiaryHillAngle);
    const GOLDEN = 2.399963229728653;
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 72; attempt++) {
        const angle = attempt < 36
          ? hillAngles[attempt % hillAngles.length] + rr(rng, -0.9, 0.9)
          : ra(rng) + attempt * GOLDEN;
        const distRatio = rr(rng, 0.34, 0.68);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
        if (pos.y < 3.2) continue; // entrance must clear waves + beach band
        const rotation = directionToYaw(Math.cos(angle), Math.sin(angle));
        const interiorRadius = rr(rng, 2.6, 3.6);
        const height = rr(rng, 3.4, 4.6);
        // Mouth ramps ~1m down into the hillside for headroom under the roof.
        const floorY = pos.y - 1.0;
        const ceilingY = floorY + height;
        // Only hillsides thick enough to roof the tunnel qualify: the natural
        // surface must clear the ceiling by ≥2m along the tunnel. Try the
        // longest tunnel that stays roofed.
        let length = 0;
        for (const tryLen of [14, 11.5, 9, 7]) {
          let roofed = true;
          for (const f of [0.5, 0.8, 1.0]) {
            const sx = pos.x - Math.sin(rotation) * tryLen * f;
            const sz = pos.z - Math.cos(rotation) * tryLen * f;
            if (getIslandSurfaceY(island, sx, sz) < ceilingY + 2) { roofed = false; break; }
          }
          if (roofed) { length = tryLen; break; }
        }
        if (length === 0) continue;
        // Keep caves apart from each other.
        if (caves.some((c) => Math.hypot(c.position.x - pos.x, c.position.z - pos.z) < c.length + length)) continue;
        caves.push({
          position: pos,
          rotation,
          width: interiorRadius * 2,
          height,
          length,
          interiorRadius,
          floorY,
          ceilingY,
        });
        break;
      }
    }
    return caves;
  }

  // ── Docks: always land on a beach coast, shore end stamped flat ───────────
  private generateDock(island: Island, rng: Rng): IslandDock | null {
    let best: { angle: number; score: number } | null = null;
    for (let i = 0; i < 20; i++) {
      const a = ra(rng);
      const w = getIslandCoastWeights(island, a);
      let score = w.beach * 2 - w.cliff;
      // Shore anchor must be dry land — archipelago channels and deep beach
      // aprons drown the walkway (and its lantern posts) otherwise.
      if (getIslandSurfacePoint(island, 0.93, a, 0).y < 0.6) score -= 2.5;
      for (const cave of island.caves) {
        const caveAngle = Math.atan2(cave.position.z - island.position.z, cave.position.x - island.position.x);
        if (Math.abs(angleDelta(a, caveAngle)) < 0.7) score -= 3;
      }
      if (!best || score > best.score) best = { angle: a, score };
    }
    if (!best) return null;

    const shoreAngle = best.angle;
    const rotation = directionToYaw(Math.cos(shoreAngle), Math.sin(shoreAngle));
    const length = rr(rng, Math.max(14, island.radius * 0.3), Math.max(20, island.radius * 0.52));
    const width = rr(rng, 3.6, 5.6);
    const moorSide = (rng() < 0.5 ? -1 : 1) as -1 | 1;
    // Anchor at the outermost dry point along the shore ray (the waterline
    // crossing) — never in a flooded saddle.
    let shore = getIslandSurfacePoint(island, 0.93, shoreAngle, 0);
    if (shore.y < 0.6) {
      for (let d = 0.9; d >= 0.5; d -= 0.02) {
        const p = getIslandSurfacePoint(island, d, shoreAngle, 0);
        if (p.y >= 0.6) { shore = p; break; }
      }
    }
    // Flatten the shore end so the walkway meets level sand.
    island.stamps!.push({ x: shore.x, z: shore.z, radius: 4.6, targetY: shore.y, blend: 0.5 });
    const deckY = Math.max(shore.y + 0.15, 1.5);
    const forward = { x: Math.sin(rotation), z: Math.cos(rotation) };
    const right = { x: Math.cos(rotation), z: -Math.sin(rotation) };
    const center = {
      x: shore.x + forward.x * length * 0.42,
      y: deckY,
      z: shore.z + forward.z * length * 0.42,
    };
    return {
      position: center,
      rotation,
      shoreAngle,
      length,
      width,
      moorSide,
      respawnPoint: {
        x: shore.x + forward.x * Math.min(length * 0.22, 5.5),
        y: deckY + 0.26,
        z: shore.z + forward.z * Math.min(length * 0.22, 5.5),
      },
      // Berth: beside the dock, pushed seaward until BOTH hull ends of the
      // biggest ship class float clear of the beach (281/286 berths used to
      // bury a hull end in the sand — parked ships looked welded to the island).
      berthPosition: (() => {
        const galleonHalf = SHIP_STATS.galleon.length * 0.5 + 5;
        let along = length * 0.42;
        for (let tries = 0; tries < 40; tries++) {
          const cx = shore.x + forward.x * along + right.x * moorSide * (width * 0.65 + 4.6);
          const cz = shore.z + forward.z * along + right.z * moorSide * (width * 0.65 + 4.6);
          const bowGround = getIslandSurfaceY(island, cx + forward.x * galleonHalf, cz + forward.z * galleonHalf);
          const sternGround = getIslandSurfaceY(island, cx - forward.x * galleonHalf, cz - forward.z * galleonHalf);
          const midGround = getIslandSurfaceY(island, cx, cz);
          if (bowGround < -1.2 && sternGround < -1.2 && midGround < -1.2) {
            return { x: cx, y: 0.12, z: cz };
          }
          along += 2.2;
        }
        const cx = shore.x + forward.x * (along + galleonHalf) + right.x * moorSide * (width * 0.65 + 4.6);
        const cz = shore.z + forward.z * (along + galleonHalf) + right.z * moorSide * (width * 0.65 + 4.6);
        return { x: cx, y: 0.12, z: cz };
      })(),
      berthRotation: rotation,
    };
  }

  private generateTavern(island: Island, rng: Rng): IslandTavern | null {
    if (!island.dock) return null;

    const dock = island.dock;
    // Place the tavern off the side of the dock, set back inland, on a stamp.
    const sideAngle = dock.shoreAngle + dock.moorSide * 0.55;
    const distRatio = 0.6 + rr(rng, -0.02, 0.04);
    const pos = getIslandSurfacePoint(island, distRatio, sideAngle, 0);
    const rotation = directionToYaw(dock.position.x - pos.x, dock.position.z - pos.z);
    const width = 7.6;
    const depth = 6.4;
    island.stamps!.push({ x: pos.x, z: pos.z, radius: 6.2, targetY: pos.y, blend: 0.42 });

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    // Tavern floor sits 0.18m above the surface — counter Y must match so the
    // bartender stands on planks, not under them.
    const counterPosition: Vec3 = {
      x: pos.x + sinR * (-depth * 0.28),
      y: pos.y + 0.18,
      z: pos.z + cosR * (-depth * 0.28),
    };
    return { position: pos, rotation, width, depth, counterPosition };
  }

  private generateUpgradeStations(island: Island, rng: Rng): UpgradeStation[] {
    const count = island.radius > 70 ? 2 : island.radius > 50 ? 1 : (rng() < 0.55 ? 1 : 0);
    if (count === 0) return [];

    const allTypes: ShipUpgradeType[] = ['hull_reinforcement', 'charged_cannons', 'swift_sails'];
    const types = shuffled(rng, allTypes).slice(0, count);

    return types.map((type, i) => {
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 12 && !pos; attempt++) {
        const angle = island.dock
          ? island.dock.shoreAngle + Math.PI * (0.6 + i * 0.5) + rr(rng, -0.2, 0.2)
          : ra(rng);
        const distRatio = rr(rng, 0.14, 0.4);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0);
        if (candidate.y < 1.2) continue;
        if (this.nearCave(island, candidate.x, candidate.z, 2.5)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 2.4)) continue;
        pos = candidate;
      }
      if (!pos) pos = getIslandSurfacePoint(island, 0.3, ra(rng), 0);
      island.stamps!.push({ x: pos.x, z: pos.z, radius: 2.8, targetY: pos.y, blend: 0.5 });
      return {
        id: uuid(),
        type,
        position: { x: pos.x, y: pos.y + 0.08, z: pos.z },
        claimedByShipId: null,
      };
    });
  }

  // ── Camps: flattened sites that receive campfire/lantern/crate props ──────
  private planCamps(island: Island, rng: Rng): CampSite[] {
    const target = island.radius > 90 ? 2 : 1;
    const camps: CampSite[] = [];
    // Two passes: strict, then relaxed height/slope so even steep islands get
    // a campsite (spacing pads stay fixed).
    for (const relax of [1, 2]) {
      const minY = relax === 1 ? 1.6 : 1.0;
      const maxSlope = relax === 1 ? 0.5 : 0.85;
      for (let attempt = 0; attempt < 26 && camps.length < target; attempt++) {
        const angle = ra(rng);
        const distRatio = rr(rng, 0.28, 0.6);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
        if (pos.y < minY) continue;
        if (this.slopeAt(island, pos.x, pos.z) > maxSlope) continue;
        if (this.nearCave(island, pos.x, pos.z, 3)) continue;
        if (this.nearStamp(island, pos.x, pos.z, 4)) continue;
        if (camps.some((c) => Math.hypot(c.x - pos.x, c.z - pos.z) < 18)) continue;
        island.stamps!.push({ x: pos.x, z: pos.z, radius: 3.8, targetY: pos.y, blend: 0.45 });
        camps.push({ x: pos.x, z: pos.z, y: pos.y });
      }
      if (camps.length >= target) break;
    }
    return camps;
  }

  // ── Landmark POIs (fixed per roster entry) ─────────────────────────────────
  // Placement NEVER silently fails: seeded random attempts run first, then a
  // deterministic golden-angle sweep with progressively relaxed height/slope
  // limits (spacing pads stay fixed so props never interpenetrate), then an
  // absolute fallback on the primary-hill flank — every island keeps its
  // authored landmarks.
  private findLandmarkSite(
    island: Island,
    rng: Rng,
    siteIndex: number,
    limits: { minY: number; maxSlope: number; dLo: number; dHi: number; stampRadius: number; blend: number; pad: number },
  ): { x: number; z: number } {
    const GOLDEN = 2.399963229728653;
    const candidates: Array<{ angle: number; distRatio: number }> = [];
    for (let a = 0; a < 26; a++) candidates.push({ angle: ra(rng), distRatio: rr(rng, limits.dLo, limits.dHi) });
    for (let k = 0; k < 40; k++) {
      candidates.push({
        angle: island.profile.primaryHillAngle + (k + 1) * GOLDEN,
        distRatio: limits.dLo + ((k % 5) / 4) * (limits.dHi - limits.dLo),
      });
    }
    for (const relax of [1, 1.6, 2.6]) {
      for (const c of candidates) {
        const pos = getIslandSurfacePoint(island, c.distRatio, c.angle, 0);
        if (pos.y < limits.minY / relax) continue;
        if (this.slopeAt(island, pos.x, pos.z) > limits.maxSlope * relax) continue;
        if (this.nearCave(island, pos.x, pos.z, 3.5)) continue;
        if (this.nearStamp(island, pos.x, pos.z, limits.pad)) continue;
        island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
        return { x: pos.x, z: pos.z };
      }
    }
    // Absolute fallback: mid-slope near the primary hill, offset per site so
    // two fallbacks on one island can never coincide.
    for (let k = 0; k < 16; k++) {
      const angle = island.profile.primaryHillAngle + Math.PI + siteIndex * 2.1 + k * GOLDEN;
      const pos = getIslandSurfacePoint(island, (limits.dLo + limits.dHi) / 2, angle, 0);
      if (k < 15 && this.nearStamp(island, pos.x, pos.z, limits.pad)) continue;
      island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
      return { x: pos.x, z: pos.z };
    }
    const pos = getIslandSurfacePoint(island, (limits.dLo + limits.dHi) / 2, island.profile.primaryHillAngle + Math.PI, 0);
    island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
    return { x: pos.x, z: pos.z };
  }

  private planLandmarks(island: Island, entry: RosterEntry, rng: Rng): LandmarkSite[] {
    const sites: LandmarkSite[] = [];
    for (const type of entry.landmarks) {
      if (type === 'watchtower') {
        const s = this.findLandmarkSite(island, rng, sites.length, {
          minY: 4, maxSlope: 0.7, dLo: 0.2, dHi: 0.48, stampRadius: 3.6, blend: 0.5, pad: 4,
        });
        sites.push({ type, x: s.x, z: s.z, yaw: ra(rng) });
      } else if (type === 'standing_stones') {
        const s = this.findLandmarkSite(island, rng, sites.length, {
          minY: 2.5, maxSlope: 0.5, dLo: 0.18, dHi: 0.42, stampRadius: 4.4, blend: 0.4, pad: 4.5,
        });
        sites.push({ type, x: s.x, z: s.z, yaw: ra(rng) });
      } else if (type === 'shipwreck') {
        // Wrecks wash up half-beached at the waterline on beach coasts, away
        // from the dock. Seeded attempts first, then a deterministic sweep
        // scored by beachiness + closeness to the waterline.
        let best: { x: number; z: number; angle: number; score: number } | null = null;
        const consider = (angle: number, strict: boolean) => {
          if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.7) return;
          const w = getIslandCoastWeights(island, angle);
          if (strict && w.beach < 0.55) return;
          const pos = getIslandSurfacePoint(island, 1.02, angle, 0);
          if (strict && (pos.y < -1.3 || pos.y > 1.3)) return;
          if (this.nearStamp(island, pos.x, pos.z, 3)) return;
          const score = w.beach * 2 - Math.abs(pos.y + 0.25);
          if (!best || score > best.score) best = { x: pos.x, z: pos.z, angle, score };
        };
        for (let attempt = 0; attempt < 30 && !best; attempt++) consider(ra(rng), true);
        if (!best) for (let k = 0; k < 64; k++) consider((k / 64) * Math.PI * 2, true);
        if (!best) for (let k = 0; k < 64; k++) consider((k / 64) * Math.PI * 2 + 0.049, false);
        const site = best as { x: number; z: number; angle: number; score: number } | null;
        if (site) {
          sites.push({ type, x: site.x, z: site.z, yaw: angleWrap(site.angle + Math.PI * 0.5 + rr(rng, -0.3, 0.3)) });
        }
      }
    }
    return sites;
  }

  private generateChests(island: Island, rng: Rng): TreasureChest[] {
    const count = ri(rng, 2, 4);
    const chests: TreasureChest[] = [];
    for (let i = 0; i < count; i++) {
      let angle = 0;
      let distRatio = 0.3;
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 14; attempt++) {
        angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.55) {
          angle += Math.PI * 0.75;
        }
        distRatio = rr(rng, 0.16, 0.56);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0.35);
        if (candidate.y - 0.35 < 1.0) continue; // keep loot on dry land
        if (this.nearCave(island, candidate.x, candidate.z, 1.4)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 1.0)) continue;
        pos = candidate;
        break;
      }
      if (!pos) pos = getIslandSurfacePoint(island, distRatio, angle, 0.35);
      const surfaceY = pos.y;
      const buried = rng() < 0.78;
      if (buried) {
        pos.y = surfaceY - rr(rng, 0.7, 1.35);
      }
      // Chart-exact normalized offsets from the ACTUAL surface point (footprint
      // anisotropy and shoreline bulge included) — the X mark lands on the real
      // world direction and distance, normalized to roughly [-1, 1].
      const maxR = getIslandMaxRadius(island);
      const mapOffsetX = (pos.x - island.position.x) / maxR;
      const mapOffsetZ = (pos.z - island.position.z) / maxR;
      chests.push({
        id: uuid(),
        position: pos,
        opened: false,
        value: ri(rng, ECONOMY.CHEST_VALUE_MIN, ECONOMY.CHEST_VALUE_MAX),
        carriedByPlayerId: null,
        storedOnShipId: null,
        floating: false,
        buried,
        digProgress: buried ? 0 : 1,
        mapOffsetX,
        mapOffsetZ,
        loot: this.rollLoot(rng),
      });
    }
    return chests;
  }

  private generateBarrels(island: Island, rng: Rng): IslandBarrel[] {
    const count = ri(rng, 2, 5);
    const barrels: IslandBarrel[] = [];
    for (let i = 0; i < count; i++) {
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        let angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.4) {
          angle += Math.PI * 0.5;
        }
        const distRatio = rr(rng, 0.1, 0.68);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0.08);
        if (candidate.y - 0.08 < 1.0) continue;
        if (this.nearCave(island, candidate.x, candidate.z, 1.2)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 0.8)) continue;
        pos = candidate;
        break;
      }
      if (!pos) pos = getIslandSurfacePoint(island, 0.4, ra(rng), 0.08);
      barrels.push({
        id: uuid(),
        position: pos,
        opened: false,
        loot: this.rollBarrelLoot(rng),
      });
    }
    return barrels;
  }

  private rollBarrelLoot(rng: Rng) {
    const rolls = ri(rng, 2, 4);
    const loot = new Map<ItemType, number>();
    for (let i = 0; i < rolls; i++) {
      const entry = pickWeighted(rng, [...BARREL_LOOT_TABLE]);
      const qty = ri(rng, entry.minQty, entry.maxQty);
      loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
    }
    return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
  }

  private generateStoryNpcs(island: Island, islandIndex: number, rng: Rng): IslandNpc[] {
    const shouldSpawn = islandIndex < 3 || (island.radius > 62 && islandIndex % 4 === 0);
    const npcs: IslandNpc[] = [];

    // Gold hoarders only on a subset of islands — every other dock-hosting island,
    // plus a guaranteed couple early so first-game discovery is fast.
    const hoarderEligible = !!island.dock && island.radius > 50;
    const hoarderHere = hoarderEligible && (islandIndex < 2 || islandIndex % 2 === 0);
    if (hoarderHere) {
      const hoarderAngle = island.dock
        ? island.dock.shoreAngle + island.dock.moorSide * 0.42
        : island.profile.primaryHillAngle - 0.62;
      const hoarderDistRatio = island.dock ? 0.74 : 0.38;
      const hoarderPos = getIslandSurfacePoint(island, hoarderDistRatio, hoarderAngle, 0.08);
      npcs.push({
        id: uuid(),
        role: 'gold_hoarder',
        name: 'Gold Hoarder Darius',
        cutsceneTitle: 'The Hoarder at the Shore',
        line: 'Bring me sealed chests, not loose excuses. I pay gold, and my charts point to the next mark.',
        cue: 'Sell carried chests here or take a treasure map.',
        position: hoarderPos,
        rotation: directionToYaw(island.position.x - hoarderPos.x, island.position.z - hoarderPos.z),
      });
    }

    if (island.tavern) {
      const t = island.tavern;
      const cosR = Math.cos(t.rotation);
      const sinR = Math.sin(t.rotation);
      // Stand the bartender just behind the bar counter, facing the door.
      const barPos: Vec3 = {
        x: t.counterPosition.x + sinR * 0.55,
        y: t.counterPosition.y,
        z: t.counterPosition.z + cosR * 0.55,
      };
      npcs.push({
        id: uuid(),
        role: 'bartender',
        name: 'Tavernkeeper Bess',
        cutsceneTitle: 'A Mug at the Counter',
        line: 'Sit, sailor. Trade rumors keep the rum warm — drink up and the next horizon will feel a touch closer.',
        cue: 'Tavern: rest, restock, and listen for tales.',
        position: barPos,
        rotation: t.rotation + Math.PI,
      });
    }

    if (!shouldSpawn) return npcs;

    const cast: Array<Pick<IslandNpc, 'role' | 'name' | 'cutsceneTitle' | 'line' | 'cue'>> = [
      {
        role: 'mysterious_stranger',
        name: 'The Stranger',
        cutsceneTitle: 'A Figure at the Shore',
        line: 'The sea is closing in. Read the clouds, keep your bow inside the blue, and do not trust a quiet horizon.',
        cue: 'Storm warnings now point to the nearest safe water.',
      },
      {
        role: 'shipwright',
        name: 'Maeve the Shipwright',
        cutsceneTitle: 'Tools on the Tide',
        line: 'A sound hull wins more fights than a loud cannon. Take planks from barrels, patch low sections, then raise sail.',
        cue: 'Island barrels are the fastest way to restock repairs.',
      },
      {
        role: 'oracle',
        name: 'Old Salt Iona',
        cutsceneTitle: 'The Map Knows',
        line: 'X marks are never alone. Docks, forges, and camps leave scratches on every honest chart.',
        cue: 'Open the map near islands to inspect local details.',
      },
    ];

    const template = cast[islandIndex % cast.length];
    const angle = island.dock
      ? island.dock.shoreAngle + rr(rng, -0.34, 0.34)
      : island.profile.primaryHillAngle + rr(rng, -0.42, 0.42);
    const distRatio = island.dock ? rr(rng, 0.66, 0.78) : rr(rng, 0.22, 0.42);
    const pos = getIslandSurfacePoint(island, distRatio, angle, 0.06);
    const rotation = directionToYaw(island.position.x - pos.x, island.position.z - pos.z);

    npcs.push({
      id: uuid(),
      ...template,
      position: pos,
      rotation,
    });

    return npcs;
  }

  private rollLoot(rng: Rng) {
    const rolls = ri(rng, 3, 6);
    const loot = new Map<ItemType, number>();
    for (let i = 0; i < rolls; i++) {
      const entry = pickWeighted(rng, [...CHEST_LOOT_TABLE]);
      const qty = ri(rng, entry.minQty, entry.maxQty);
      loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
    }
    return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
  }

  // ── Deterministic prop registry ────────────────────────────────────────────
  private generateProps(
    island: Island,
    entry: RosterEntry,
    rng: Rng,
    camps: CampSite[],
    landmarks: LandmarkSite[],
  ): IslandProp[] {
    const props: IslandProp[] = [];
    const blockers: Array<{ x: number; z: number; r: number }> = [];
    const addProp = (type: IslandPropType, x: number, z: number, yaw: number, scale: number) => {
      props.push({ type, x, z, yaw: angleWrap(yaw), scale });
      const r = getPropSpacingRadius(type, scale);
      if (r > 0) blockers.push({ x, z, r });
    };
    const clearOf = (x: number, z: number, r: number) =>
      blockers.every((b) => Math.hypot(x - b.x, z - b.z) >= b.r + r + 0.35);

    // Keep scatter away from interactables.
    for (const st of island.upgradeStations) blockers.push({ x: st.position.x, z: st.position.z, r: 1.6 });
    for (const npc of island.npcs) blockers.push({ x: npc.position.x, z: npc.position.z, r: 1.2 });
    for (const chest of island.chests) blockers.push({ x: chest.position.x, z: chest.position.z, r: 1.0 });
    for (const barrel of island.barrels) blockers.push({ x: barrel.position.x, z: barrel.position.z, r: 0.8 });
    if (island.tavern) blockers.push({ x: island.tavern.position.x, z: island.tavern.position.z, r: 5.6 });

    // 1. Dock walkway modules + lantern pair (y = dock deck height client-side).
    if (island.dock) {
      const dock = island.dock;
      const forward = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
      const right = { x: Math.cos(dock.rotation), z: -Math.sin(dock.rotation) };
      const shoreX = dock.position.x - forward.x * dock.length * 0.42;
      const shoreZ = dock.position.z - forward.z * dock.length * 0.42;
      const midCount = Math.max(1, Math.round((dock.length - 4) / 6));
      for (let i = 0; i < midCount; i++) {
        const d = 3 + i * 6;
        addProp('dock_mid', shoreX + forward.x * d, shoreZ + forward.z * d, dock.rotation, 1);
      }
      const endD = 3 + midCount * 6 - 1;
      addProp('dock_end', shoreX + forward.x * endD, shoreZ + forward.z * endD, dock.rotation, 1);
      for (const side of [-1, 1]) {
        addProp(
          'lantern_post',
          shoreX + forward.x * 1.0 + right.x * side * (dock.width * 0.5 + 0.5),
          shoreZ + forward.z * 1.0 + right.z * side * (dock.width * 0.5 + 0.5),
          dock.rotation,
          1,
        );
      }
    }

    // 2. Camp props on their stamped flats (campfire + lantern + crates).
    for (const camp of camps) {
      const theta = ra(rng);
      addProp('campfire', camp.x, camp.z, ra(rng), 1);
      addProp('lantern_post', camp.x + Math.cos(theta) * 1.7, camp.z + Math.sin(theta) * 1.7, ra(rng), 1);
      const clutter = ri(rng, 1, 3);
      for (let i = 0; i < clutter; i++) {
        const a = theta + (i + 1) * 1.9;
        const d = rr(rng, 1.8, 2.3);
        addProp(rng() < 0.5 ? 'crate' : 'barrel', camp.x + Math.cos(a) * d, camp.z + Math.sin(a) * d, ra(rng), rr(rng, 0.9, 1.1));
      }
    }

    // 3. Landmark POIs.
    for (const site of landmarks) {
      addProp(site.type, site.x, site.z, site.yaw, 1);
    }

    // 4. Biome scatter — density scales with radius (big islands 40–120 props).
    const mix = SCATTER_MIX[entry.biome];
    const target = Math.min(120, Math.max(14, Math.round(island.radius * SCATTER_DENSITY[entry.biome])));
    let placed = 0;
    let attempts = target * 10;
    while (placed < target && attempts-- > 0) {
      const spec = pickWeighted(rng, mix);
      const angle = ra(rng);
      const distRatio = rr(rng, spec.dMin, spec.dMax);
      const scale = rr(rng, spec.sMin, spec.sMax);
      const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
      const spacing = getPropSpacingRadius(spec.type, scale);
      if (pos.y < spec.minY) continue; // above wet sand / never underwater
      if (this.slopeAt(island, pos.x, pos.z) > spec.maxSlope) continue;
      if (this.nearCave(island, pos.x, pos.z, 1.8 + spacing)) continue;
      if (this.nearStamp(island, pos.x, pos.z, spacing + 0.4)) continue;
      if (island.dock && this.nearDockLine(island.dock, pos.x, pos.z, spacing + 1.6)) continue;
      if (!clearOf(pos.x, pos.z, spacing)) continue;
      addProp(spec.type, pos.x, pos.z, ra(rng), scale);
      placed++;
    }

    return props;
  }

  // ── Placement helpers ──────────────────────────────────────────────────────
  private slopeAt(island: Island, x: number, z: number): number {
    const e = 1.1;
    const yE = getIslandSurfaceY(island, x + e, z);
    const yW = getIslandSurfaceY(island, x - e, z);
    const yN = getIslandSurfaceY(island, x, z + e);
    const yS = getIslandSurfaceY(island, x, z - e);
    return Math.max(Math.abs(yE - yW), Math.abs(yN - yS)) / (2 * e);
  }

  private nearCave(island: Island, x: number, z: number, pad: number): boolean {
    for (const cave of island.caves) {
      const dx = x - cave.position.x;
      const dz = z - cave.position.z;
      const cosR = Math.cos(cave.rotation);
      const sinR = Math.sin(cave.rotation);
      const lx = dx * cosR - dz * sinR;
      const lz = dx * sinR + dz * cosR;
      if (Math.abs(lx) < cave.interiorRadius + pad && lz < 1.0 + pad && lz > -cave.length - pad) return true;
    }
    return false;
  }

  private nearStamp(island: Island, x: number, z: number, pad: number): boolean {
    return (island.stamps ?? []).some((s) => Math.hypot(x - s.x, z - s.z) < s.radius + pad);
  }

  private nearDockLine(dock: IslandDock, x: number, z: number, pad: number): boolean {
    const forward = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
    const ax = dock.position.x - forward.x * dock.length * 0.42;
    const az = dock.position.z - forward.z * dock.length * 0.42;
    const bx = ax + forward.x * dock.length;
    const bz = az + forward.z * dock.length;
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
    const px = ax + abx * t;
    const pz = az + abz * t;
    return Math.hypot(x - px, z - pz) < dock.width * 0.5 + pad;
  }

  generateWildlife(islands: Island[]): WildlifeAnimal[] {
    const rng = this.rng;
    const animals: WildlifeAnimal[] = [];
    for (const island of islands) {
      const baseCount = island.radius > 96 ? 8 : island.radius > 70 ? 6 : island.radius > 54 ? 5 : 4;
      let placed = 0;
      let attempts = 0;
      while (placed < baseCount && attempts < baseCount * 6) {
        attempts++;
        const roll = rng();
        const type: WildlifeType = roll < 0.34
          ? 'crab'
          : roll < 0.62
            ? 'chicken'
            : roll < 0.82
              ? 'pig'
              : 'gull';
        let angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.32) {
          angle += Math.PI * 0.55;
        }
        const shoreBias = type === 'crab' ? rr(rng, 0.72, 0.9) : type === 'gull' ? rr(rng, 0.42, 0.76) : rr(rng, 0.22, 0.68);
        const pos = getIslandSurfacePoint(island, shoreBias, angle, type === 'gull' ? 2.2 : 0.08);
        // Skip underwater spawns (beach aprons, archipelago saddles) and cave footprints.
        const groundOnly = pos.y - (type === 'gull' ? 2.2 : 0.08);
        if (groundOnly < (type === 'crab' ? 0.45 : 0.9)) continue;
        if (this.nearCave(island, pos.x, pos.z, 0.5)) continue;
        animals.push({
          id: uuid(),
          islandId: island.id,
          type,
          position: { ...pos },
          spawnPosition: { ...pos },
          rotation: ra(rng),
          velocity: { x: 0, y: 0, z: 0 },
          health: WILDLIFE.HEALTH[type],
          wanderAngle: ra(rng),
          wanderTimer: rr(rng, 0.4, 2.4),
        });
        placed++;
      }
    }
    return animals;
  }

  generateSeaRocks(
    islands: Island[],
    spawns: Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }>,
  ): SeaRock[] {
    const rng = this.rng;
    const rocks: SeaRock[] = [];
    const attempts = SEA_ROCKS.COUNT * 36;

    for (let attempt = 0; attempt < attempts && rocks.length < SEA_ROCKS.COUNT; attempt++) {
      const angle = ra(rng);
      const dist = rr(rng, 170, WORLD.HALF - 95);
      const radius = rr(rng, SEA_ROCKS.MIN_RADIUS, SEA_ROCKS.MAX_RADIUS);
      const height = rr(rng, SEA_ROCKS.MIN_HEIGHT, SEA_ROCKS.MAX_HEIGHT);
      const rotation = ra(rng);
      const variant = ri(rng, 0, 2) as 0 | 1 | 2;
      const colliderSet = buildSeaRockColliders(radius, height, rotation, variant);
      const candidate: SeaRock = {
        id: uuid(),
        position: {
          x: Math.cos(angle) * dist,
          y: 0,
          z: Math.sin(angle) * dist,
        },
        radius,
        height,
        rotation,
        variant,
        colliderBoundsRadius: colliderSet.boundsRadius,
        colliders: colliderSet.colliders,
      };

      let blocked = false;
      for (const island of islands) {
        const d = Math.hypot(candidate.position.x - island.position.x, candidate.position.z - island.position.z);
        if (d < getIslandMaxRadius(island) + radius + 38) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      for (const spawn of spawns) {
        const d = Math.hypot(candidate.position.x - spawn.position.x, candidate.position.z - spawn.position.z);
        if (d < radius + 80) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      for (const rock of rocks) {
        const d = Math.hypot(candidate.position.x - rock.position.x, candidate.position.z - rock.position.z);
        if (d < candidate.radius + rock.radius + 45) {
          blocked = true;
          break;
        }
      }
      if (!blocked) rocks.push(candidate);
    }

    return rocks;
  }

  generateShipSpawns(islands: Island[]): Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }> {
    const rng = this.rng;
    const spawns: Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }> = [];
    const minDist = 120;
    const attempts = 300;

    for (let i = 0; i < WORLD.SHIP_COUNT; i++) {
      let pos: Vec3 | null = null;
      for (let a = 0; a < attempts; a++) {
        const angle = ra(rng);
        const dist = rr(rng, 200, 900);
        const candidate: Vec3 = {
          x: Math.cos(angle) * dist,
          y: 0,
          z: Math.sin(angle) * dist,
        };
        // Not on an island
        let onIsland = false;
        for (const isl of islands) {
          const dx = candidate.x - isl.position.x;
          const dz = candidate.z - isl.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < getIslandMaxRadius(isl) + 30) { onIsland = true; break; }
        }
        // Not too close to another spawn
        let tooClose = false;
        for (const sp of spawns) {
          const dx = candidate.x - sp.position.x;
          const dz = candidate.z - sp.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < minDist) { tooClose = true; break; }
        }
        if (!onIsland && !tooClose) { pos = candidate; break; }
      }
      if (!pos) pos = { x: rr(rng, -700, 700), y: 0, z: rr(rng, -700, 700) };

      // Distribute ship types: mostly sloops, some brigantines, few galleons
      const typeRoll = rng();
      const type = typeRoll < 0.5 ? 'sloop' : typeRoll < 0.8 ? 'brigantine' : 'galleon';
      spawns.push({ position: pos, rotation: ra(rng), type });
    }

    return spawns;
  }

  buildShip(id: string, ownerId: string, spawn: { position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }, teamColor: number): Ship {
    const stats = SHIP_STATS[spawn.type];
    return {
      id,
      type: spawn.type,
      ownerId,
      crewIds: [ownerId],
      position: { ...spawn.position, y: 0 },
      rotation: spawn.rotation,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: 0,
      sailHeight: 0.5,
      sailAngle: 0,
      anchored: false,
      anchorRaiseProgress: 0,
      hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
      maxHull: stats.maxHull,
      onFire: false,
      fireTimer: 0,
      fireDamageAccum: 0,
      sinkProgress: 0,
      sinking: false,
      cannonCooldowns: Array(stats.cannonCount).fill(0),
      chainshottedUntil: 0,
      sailIntegrity: 1,
      sailRepairWoodTimer: 0,
      gold: 0,
      treasureChestIds: [],
      // SoT-style: most cannon ordnance lives in deck barrels (represented as ship stacks)
      inventory: [
        { item: 'cannonball', qty: 48 },
        { item: 'wood_plank', qty: 16 },
        { item: 'banana', qty: 5 },
        { item: 'firebomb_ball', qty: 4 },
        { item: 'chainshot', qty: 14 },
      ],
      repairCooldown: 0,
      autoRepairProgress: 0,
      teamColor,
      alive: true,
      upgrades: [],
    };
  }
}
