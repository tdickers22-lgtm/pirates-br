import type { Island, IslandBiome, IslandProp, IslandPropType, Vec3 } from './types/index.js';
import { getIslandSurfaceY } from './utils/index.js';

// ── Prop collider metadata ──────────────────────────────────────────────────
// One entry per GLB asset type (public/assets/models/README.md manifest).
// Capsules for palms/towers/posts, spheres for boulders. `radius` is the XZ
// blocking radius at scale 1; `height` is the full blocking height above the
// terrain sample at the prop's XZ. shape 'none' props have no central mass
// (dock modules use the dock's own walkway collision; campfires are low decor
// kept as a small sphere so players don't stand in the flames) — but they may
// still carry `subColliders`, which is how ring/courtyard/walk-under structures
// block their visible masses while keeping their interior open.

/** One blocking mass of a COMPOUND prop, in prop-local metres at scale 1.
 *  Offsets rotate with prop.yaw (world = prop + Ry(yaw)·offset — the same
 *  three.js convention the renderer uses) and scale with prop.scale. */
interface PropSubCollider {
  dx: number;
  dz: number;
  radius: number;
  height: number;
}

interface PropCollider {
  shape: 'capsule' | 'sphere' | 'none';
  radius: number;
  height: number;
  /** Structures whose SOLID MASSES are not one primitive (stone rings, fort
   *  walls + towers, arch legs, gallows posts) block per mass instead of via a
   *  fat central capsule. `shape: 'none'` + subColliders keeps the core walkable
   *  by design — the ring interior, the fort courtyard, the arch walk-under. */
  subColliders?: PropSubCollider[];
}

/** Six leaning menhirs on a ~3.0 m ring (scripts/blender/build_landmarks.py
 *  build_standing_stones). Centres/heights are the MEASURED upper-body
 *  centroids of standing_stones.glb, not the pre-jitter Blender layout; each
 *  radius averages that stone's wide/thin half-extents so you brush the narrow
 *  face and are genuinely walled by the broad one. Gaps between neighbours stay
 *  ≥1.0 m clear of a player's diameter — the RING INTERIOR is walkable, which
 *  is the whole point of the landmark. */
const STANDING_STONE_RING: PropSubCollider[] = [
  { dx: 3.02, dz: -0.04, radius: 0.44, height: 3.31 },
  { dx: 1.37, dz: -2.60, radius: 0.68, height: 2.26 },
  { dx: -1.48, dz: -2.65, radius: 0.40, height: 2.91 },
  { dx: -2.98, dz: 0.08, radius: 0.51, height: 2.57 },
  { dx: -1.43, dz: 2.70, radius: 0.42, height: 3.06 },
  { dx: 1.56, dz: 2.58, radius: 0.64, height: 2.03 },
];

/** Fort battlements + corner towers (scripts/blender/build_fort.py). The gate
 *  faces prop-local +Z (Blender front = −Y), so the wall chain skips the gate
 *  arc and the courtyard is enterable through the gate ONLY. Chain spacing is
 *  tighter than a player's blocking diameter, so the curtain wall has no holes. */
const FORT_STRUCTURE: PropSubCollider[] = (() => {
  const parts: PropSubCollider[] = [];
  // Corner towers: drum radius 1.5 at the measured GLB centres (the two by the
  // gate carry cone caps, all four crenellate out to ~5.2 m).
  for (const t of [
    { dx: -4.55, dz: 5.19 },
    { dx: 4.55, dz: 5.19 },
    { dx: 3.31, dz: -6.06 },
    { dx: -3.31, dz: -6.06 },
  ]) {
    parts.push({ dx: t.dx, dz: t.dz, radius: 1.5, height: 5.2 });
  }
  // Curtain wall: r_base 6.6 → r_top 6.3, 3.4 m tall, 0.7 m thick.
  const ringR = 6.45;
  const segments = 32;
  const gateHalfAngle = 0.30;
  for (let j = 0; j < segments; j++) {
    let phi = (j / segments) * Math.PI * 2;
    if (phi > Math.PI) phi -= Math.PI * 2;
    if (Math.abs(phi) < gateHalfAngle) continue;
    parts.push({
      dx: ringR * Math.sin(phi),
      dz: ringR * Math.cos(phi),
      radius: 0.55,
      height: 3.4,
    });
  }
  return parts;
})();

export const PROP_COLLIDERS: Record<IslandPropType, PropCollider> = {
  palm_a: { shape: 'capsule', radius: 0.38, height: 8.5 },
  palm_b: { shape: 'capsule', radius: 0.4, height: 6.5 },
  palm_c: { shape: 'capsule', radius: 0.42, height: 5.0 },
  palm_tall: { shape: 'capsule', radius: 0.3, height: 13.5 },
  palm_ground: { shape: 'capsule', radius: 0.5, height: 2.0 },
  // GLB XZ half-extents are 1.29 × 1.21 on a rounded mesh — 1.6 ringed every
  // boulder with ~0.3 m of invisible blocking ground.
  boulder_a: { shape: 'sphere', radius: 1.35, height: 2.4 },
  boulder_b: { shape: 'sphere', radius: 2.6, height: 2.0 },
  boulder_c: { shape: 'sphere', radius: 1.1, height: 2.0 },
  barrel: { shape: 'capsule', radius: 0.42, height: 1.0 },
  crate: { shape: 'capsule', radius: 0.45, height: 0.72 },
  campfire: { shape: 'sphere', radius: 0.55, height: 0.5 },
  lantern_post: { shape: 'capsule', radius: 0.16, height: 2.6 },
  // Base drum is r≈2.0 with corner block courses reaching ~2.6 — 2.5 left the
  // protruding masonry torso-deep penetrable.
  watchtower: { shape: 'capsule', radius: 2.9, height: 9.0 },
  // Central keep (r 2.8, 8.4 m) is the primary mass; towers and the curtain wall
  // are compound so everything between them stops being walk-through masonry.
  fort: { shape: 'capsule', radius: 2.8, height: 8.4, subColliders: FORT_STRUCTURE },
  shipwreck: { shape: 'sphere', radius: 2.6, height: 3.2 },
  standing_stones: { shape: 'none', radius: 0, height: 3.35, subColliders: STANDING_STONE_RING },
  // Tent canvas cores. Each variant blocks only its own occupied mass — the
  // measured p70 XZ radius of the geometry above ankle height — while
  // SPACING_OVERRIDES reserves the full guy-rope/peg footprint so scatter
  // never grows through a tent's ropes.
  tent_a: { shape: 'sphere', radius: 1.3, height: 1.6 },
  // Lean-to: one canted slope, so the mass is shallower and lower than the
  // A-frame but the driftwood windbreak runs its whole 4.8 m length.
  tent_b: { shape: 'sphere', radius: 1.15, height: 1.5 },
  // Bell tent: round footprint round a centre pole — narrow but tall.
  tent_c: { shape: 'sphere', radius: 1.0, height: 2.3 },
  bedroll: { shape: 'none', radius: 0, height: 0.2 },
  // Exposed bedrock: three blade masses on one ridge line (MEASURED centres of
  // crag.glb, radius = mean of each blade's XZ half-extents above ground).
  // shape 'none' keeps the gaps between blades walkable — weaving through an
  // outcrop is the whole point of putting one on a flank — while every blade
  // is genuinely solid. Replaces the deleted client-only decoration, which
  // players walked straight through.
  crag: {
    shape: 'none',
    radius: 0,
    height: 3.4,
    subColliders: [
      { dx: -1.02, dz: 0.00, radius: 0.52, height: 2.27 },
      { dx: 0.04, dz: -0.31, radius: 0.70, height: 3.40 },
      { dx: 1.12, dz: -0.12, radius: 0.52, height: 3.36 },
    ],
  },
  // Two solid rock legs (measured GLB centres, ~1.0 m mean half-extent) block;
  // the span overhead stays a genuine walk-under (no centre collider).
  rock_arch: {
    shape: 'none',
    radius: 0,
    height: 4.6,
    subColliders: [
      { dx: -2.57, dz: 0.12, radius: 1.00, height: 4.0 },
      { dx: 2.58, dz: -0.13, radius: 1.00, height: 4.0 },
    ],
  },
  bush: { shape: 'none', radius: 0, height: 1.0 },
  bush_berry: { shape: 'none', radius: 0, height: 1.0 },
  flower_bush: { shape: 'none', radius: 0, height: 1.0 },
  fern_plant: { shape: 'none', radius: 0, height: 0.8 },
  flower_patch: { shape: 'none', radius: 0, height: 0.6 },
  wildflowers: { shape: 'none', radius: 0, height: 0.9 },
  dock_mid: { shape: 'none', radius: 0, height: 1.1 },
  dock_end: { shape: 'none', radius: 0, height: 1.1 },
  // Story scenes: the collider blocks only the core structure so players can
  // walk INTO the vignette; SPACING_OVERRIDES reserves the visual footprint.
  smuggler_cache: { shape: 'capsule', radius: 1.6, height: 2.2 },
  skull_totem: { shape: 'capsule', radius: 2.4, height: 4.5 },
  wrecker_tower: { shape: 'capsule', radius: 2.0, height: 7.3 },
  whale_skeleton: { shape: 'none', radius: 0, height: 3.0 },
  rum_still: { shape: 'capsule', radius: 1.1, height: 2.4 },
  crow_roost: { shape: 'capsule', radius: 2.0, height: 9.0 },
  mermaid_shrine: { shape: 'capsule', radius: 2.0, height: 2.8 },
  castaway_camp: { shape: 'capsule', radius: 0.5, height: 4.0 },
  kraken_wreck: { shape: 'capsule', radius: 4.0, height: 4.6 },
  dig_site: { shape: 'none', radius: 0, height: 1.0 },
  // Walk INTO the scene between the posts (cut ropes are the focal point), but
  // not THROUGH the two heavy uprights or the coffin cart.
  gallows: {
    shape: 'none',
    radius: 0,
    height: 4.4,
    subColliders: [
      { dx: -1.90, dz: 0, radius: 0.32, height: 4.2 },
      { dx: 1.90, dz: 0, radius: 0.32, height: 4.2 },
      { dx: 2.35, dz: -1.55, radius: 0.85, height: 1.4 },
    ],
  },
  parley_table: { shape: 'capsule', radius: 1.9, height: 1.0 },
  mine_head: { shape: 'capsule', radius: 3.2, height: 5.0 },
  widow_memorial: { shape: 'capsule', radius: 1.6, height: 3.4 },
  gibbet_cage: { shape: 'capsule', radius: 0.5, height: 3.4 },
  bone_pile: { shape: 'none', radius: 0, height: 0.6 },
  driftwood_log: { shape: 'sphere', radius: 1.1, height: 0.9 },
  grave_marker: { shape: 'capsule', radius: 0.3, height: 1.1 },
};

/** Palette hints per biome (0xRRGGBB) — the client keys vertex colors off
 *  profile.palette which MapGenerator copies from this table. */
export const BIOME_PALETTES: Record<IslandBiome, { sand: number; grass: number; rock: number; foliage: number }> = {
  lush: { sand: 0xe8d5a3, grass: 0x5fa84c, rock: 0x8b8578, foliage: 0x3e7a34 },
  palm_atoll: { sand: 0xf2e3b6, grass: 0x7cbf5a, rock: 0x9c927f, foliage: 0x4c9c46 },
  volcanic: { sand: 0x7a695a, grass: 0x77863f, rock: 0x6b5f52, foliage: 0x5c7440 },
  highland: { sand: 0xc9bb94, grass: 0x6e8f4e, rock: 0x7c7c74, foliage: 0x49663c },
  bone: { sand: 0xe6ddc4, grass: 0x87914f, rock: 0xa89f8c, foliage: 0x6d7444 },
};

/** Some landmark GLBs are much wider than their walk-blocking collider (the
 *  standing-stone RING is r≈3.5 but players can walk inside it; the shipwreck
 *  hull skeleton is ~11×5). Scatter spacing uses the visual footprint. */
const SPACING_OVERRIDES: Partial<Record<IslandPropType, number>> = {
  standing_stones: 3.6,
  shipwreck: 5.2,
  fort: 8.5,
  // Tents: the canvas collider is the sleeping mass, but guy ropes and pegs
  // reach much further (MEASURED max XZ radius of each GLB). Without these the
  // scatter grew ferns through the ropes and parked the neighbouring camp
  // clutter half a metre off the canvas — the "copy-pasted kit" read.
  tent_a: 2.25,
  // The lean-to's 4.8 m windbreak is a LINE, not a disc — reserving its full
  // half-length as a circle would push the whole camp apart, so this covers
  // the canvas and the near guy ropes.
  tent_b: 2.15,
  tent_c: 1.75,
  // Blade cluster reaches 1.62 m from the origin; keep a little air round it so
  // flora never sprouts out of solid bedrock.
  crag: 2.0,
  // Story vignettes reserve their whole visual footprint (walk-in scenes have
  // small or no hard collider, but scatter must stay out of the tableau).
  smuggler_cache: 5.0,
  skull_totem: 5.0,
  wrecker_tower: 5.5,
  whale_skeleton: 10.0,
  rum_still: 5.5,
  crow_roost: 5.0,
  mermaid_shrine: 5.0,
  castaway_camp: 5.5,
  kraken_wreck: 9.0,
  dig_site: 6.5,
  gallows: 6.0,
  parley_table: 5.5,
  mine_head: 6.0,
  widow_memorial: 5.5,
  gibbet_cage: 1.4,
};

/** Spacing radius used when scattering props (slightly wider than the hard
 *  collider so trunks/rocks never visually interpenetrate). Walk-through
 *  scenes (shape 'none') still reserve space via SPACING_OVERRIDES. */
export function getPropSpacingRadius(type: IslandPropType, scale: number): number {
  const col = PROP_COLLIDERS[type];
  if (!col) return 0;
  const override = SPACING_OVERRIDES[type];
  if (col.shape === 'none') return (override ?? 0) * scale;
  return (override ?? (col.radius + 0.12)) * scale;
}

/** Broad-phase radius covering every blocking mass of a prop type at scale 1. */
const PROP_BOUNDS_RADIUS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const [type, col] of Object.entries(PROP_COLLIDERS)) {
    let r = col.shape === 'none' ? 0 : col.radius;
    for (const sub of col.subColliders ?? []) {
      r = Math.max(r, Math.hypot(sub.dx, sub.dz) + sub.radius);
    }
    out[type] = r;
  }
  return out;
})();

/** Blocking radius of a prop's whole structure at its instance scale. */
export function getPropBoundsRadius(type: IslandPropType, scale: number): number {
  return (PROP_BOUNDS_RADIUS[type] ?? 0) * scale;
}

/**
 * Push a circle of `radius` at `pos` out of every blocking prop on `island`
 * (XZ resolution; vertical band gated by each mass's collider height above the
 * prop's terrain sample). Compound props resolve their DEEPEST overlapping mass
 * and then re-check, so stepping clear of one wall stone can't leave the walker
 * standing inside its neighbour. Pure — shared by server physics and client
 * prediction so the two can never disagree.
 */
export function resolvePropCollision(
  pos: Vec3,
  radius: number,
  island: Island,
): { x: number; z: number; pushed: boolean } {
  let x = pos.x;
  let z = pos.z;
  let pushed = false;
  const props = island.props;
  if (!props || props.length === 0) return { x, z, pushed };
  for (const prop of props) {
    const col = PROP_COLLIDERS[prop.type];
    if (!col) continue;
    const subs = col.subColliders;
    if (col.shape === 'none' && (!subs || subs.length === 0)) continue;
    const bounds = getPropBoundsRadius(prop.type, prop.scale) + radius;
    const bdx = x - prop.x;
    const bdz = z - prop.z;
    if (bdx * bdx + bdz * bdz >= bounds * bounds) continue;
    const baseY = getIslandSurfaceY(island, prop.x, prop.z);
    // Far beneath the prop (in a cave under it) → no block.
    if (pos.y < baseY - 2.5) continue;

    if (col.shape !== 'none' && pos.y <= baseY + col.height * prop.scale + 0.2) {
      const r = col.radius * prop.scale + radius;
      const dx = x - prop.x;
      const dz = z - prop.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.001;
        x = prop.x + (dx / d) * r;
        z = prop.z + (dz / d) * r;
        pushed = true;
      }
    }

    if (!subs || subs.length === 0) continue;
    const cos = Math.cos(prop.yaw);
    const sin = Math.sin(prop.yaw);
    // Two passes clear a wall/ring where neighbouring masses barely touch. A
    // crag's three blades OVERLAP (it is one ridge of rock, not a fence), so a
    // walker shoved out of the middle blade can land inside BOTH neighbours
    // and two passes run out with him 0.35 m inside the stone. Bound the
    // relaxation by the number of masses instead (capped, and it exits early
    // the moment nothing overlaps).
    const passes = Math.min(4, Math.max(2, subs.length));
    for (let pass = 0; pass < passes; pass++) {
      let best: { cx: number; cz: number; r: number; d: number; pen: number } | null = null;
      for (const sub of subs) {
        if (pos.y > baseY + sub.height * prop.scale + 0.2) continue;
        const cx = prop.x + (sub.dx * cos + sub.dz * sin) * prop.scale;
        const cz = prop.z + (sub.dz * cos - sub.dx * sin) * prop.scale;
        const r = sub.radius * prop.scale + radius;
        const dx = x - cx;
        const dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        if (!best || r - d > best.pen) best = { cx, cz, r, d, pen: r - d };
      }
      if (!best) break;
      if (best.d > 1e-4) {
        x = best.cx + ((x - best.cx) / best.d) * best.r;
        z = best.cz + ((z - best.cz) / best.d) * best.r;
      } else {
        x = best.cx + best.r;
        z = best.cz;
      }
      pushed = true;
    }
  }
  return { x, z, pushed };
}

/** Prop types solid enough to stop a bullet or a cannonball. Slender timber and
 *  vegetation (palms, lantern posts, gallows frames, tents) stay shoot-through
 *  so cover reads exactly as the silhouette suggests without killing the arcade
 *  feel of firing through a palm grove. */
export const SHOT_BLOCKING_PROPS: ReadonlySet<IslandPropType> = new Set<IslandPropType>([
  'boulder_a', 'boulder_b', 'boulder_c', 'crag',
  'watchtower', 'fort', 'standing_stones', 'rock_arch',
  'shipwreck', 'wrecker_tower', 'crow_roost', 'mine_head',
  'skull_totem', 'kraken_wreck', 'widow_memorial',
]);

/**
 * Nearest hit distance along a UNIT `direction` against the solid props on an
 * island, or null. Each blocking mass is a vertical cylinder (centre, radius,
 * baseY .. baseY + height) — cheap enough for per-shot hitscan and per-tick
 * cannonball segments, and it makes "I was behind a boulder" finally true.
 */
export function intersectRayIslandProps(
  origin: Vec3,
  direction: Vec3,
  range: number,
  island: Island,
): number | null {
  const props = island.props;
  if (!props || props.length === 0) return null;
  let best: number | null = null;
  for (const prop of props) {
    if (!SHOT_BLOCKING_PROPS.has(prop.type)) continue;
    const col = PROP_COLLIDERS[prop.type];
    if (!col) continue;
    const bounds = getPropBoundsRadius(prop.type, prop.scale);
    if (bounds <= 0) continue;
    // Broad phase: perpendicular distance from the prop centre to the segment.
    const rx = prop.x - origin.x;
    const rz = prop.z - origin.z;
    const along = clampRange(rx * direction.x + rz * direction.z, 0, range);
    const px = rx - direction.x * along;
    const pz = rz - direction.z * along;
    if (px * px + pz * pz > (bounds + 0.5) * (bounds + 0.5)) continue;

    const baseY = getIslandSurfaceY(island, prop.x, prop.z);
    const cos = Math.cos(prop.yaw);
    const sin = Math.sin(prop.yaw);
    const testCylinder = (cx: number, cz: number, radius: number, top: number) => {
      const ox = origin.x - cx;
      const oz = origin.z - cz;
      const a = direction.x * direction.x + direction.z * direction.z;
      if (a < 1e-9) return;
      const b = 2 * (ox * direction.x + oz * direction.z);
      const c = ox * ox + oz * oz - radius * radius;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return;
      const root = Math.sqrt(disc);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t < 0 || t > range || (best !== null && t >= best)) continue;
        const y = origin.y + direction.y * t;
        if (y < baseY - 0.6 || y > top) continue;
        best = t;
        return;
      }
    };
    if (col.shape !== 'none') {
      testCylinder(prop.x, prop.z, col.radius * prop.scale, baseY + col.height * prop.scale);
    }
    for (const sub of col.subColliders ?? []) {
      testCylinder(
        prop.x + (sub.dx * cos + sub.dz * sin) * prop.scale,
        prop.z + (sub.dz * cos - sub.dx * sin) * prop.scale,
        sub.radius * prop.scale,
        baseY + sub.height * prop.scale,
      );
    }
  }
  return best;
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 8-point sampling ring at unit radius (compass + diagonals). */
const FOOTPRINT_RING: ReadonlyArray<readonly [number, number]> = (() => {
  const d = Math.SQRT1_2;
  return [[1, 0], [-1, 0], [0, 1], [0, -1], [d, d], [d, -d], [-d, d], [-d, -d]];
})();

/** Convenience for placement/tests: world-space Y a prop rests at. The base
 *  seats on the LOWEST terrain sample under its FULL footprint (center + 8
 *  ring points at the collider radius) minus a small bite — narrower/sparser
 *  sampling left rocks hovering wherever the terrain fell away under one edge
 *  of the base (shore drops, relief octaves). Loose boulders sink UNCAPPED:
 *  a half-buried rock on a slope reads natural, a hovering one never does.
 *  Built scenes keep the sink cap so one steep edge can't drown the whole
 *  vignette (their placement stamps a flat pad instead). */
export function getPropGroundY(island: Island, prop: IslandProp): number {
  const col = PROP_COLLIDERS[prop.type];
  const footprint = col && col.shape !== 'none'
    ? col.radius * prop.scale
    // A crag's outer blades stand at its FULL bounds radius, so the
    // spacing-derived 0.45 sample ring (0.9 m) missed the ground the downhill
    // blade actually lands on and left it hanging over the flank.
    : prop.type === 'crag'
      ? getPropBoundsRadius(prop.type, prop.scale)
      : (SPACING_OVERRIDES[prop.type] ?? 0) * prop.scale * 0.45;
  const center = getIslandSurfaceY(island, prop.x, prop.z);
  let ground = center;
  if (footprint > 0.2) {
    for (const [ox, oz] of FOOTPRINT_RING) {
      ground = Math.min(ground, getIslandSurfaceY(island, prop.x + ox * footprint, prop.z + oz * footprint));
    }
    // Tents may bed deeper into a hillside (canvas skirts hide it); other
    // built props keep the tight cap so a steep edge can't drown a vignette.
    const sinkCap = prop.type.startsWith('tent_') ? 0.65 : 0.35;
    // Loose rock sinks UNCAPPED: boulders half-bury, and a crag is bedrock
    // pushing OUT of the flank — its authored skirt+root run 1.55 m below the
    // origin precisely so it can bite into a steep slope with no daylight
    // under the downhill blade.
    if (!prop.type.startsWith('boulder_') && prop.type !== 'crag') {
      ground = Math.max(ground, center - sinkCap);
    }
  }
  // Crags take a deeper bite than the 7 cm everything else gets: the rendered
  // terrain mesh interpolates BELOW the analytic surface across a convex
  // ridge, which is exactly where crags are placed, so a flush seat still
  // reads as a hovering rock.
  return ground - (prop.type === 'crag' ? 0.45 : 0.07);
}
