import type { Island, IslandBiome, IslandProp, IslandPropType, Vec3 } from './types/index.js';
import { getIslandSurfaceY } from './utils/index.js';

// ── Prop collider metadata ──────────────────────────────────────────────────
// One entry per GLB asset type (public/assets/models/README.md manifest).
// Capsules for palms/towers/posts, spheres for boulders. `radius` is the XZ
// blocking radius at scale 1; `height` is the full blocking height above the
// terrain sample at the prop's XZ. shape 'none' props never block (dock
// modules use the dock's own walkway collision; campfires are low decor kept
// as a small sphere so players don't stand in the flames).

export interface PropCollider {
  shape: 'capsule' | 'sphere' | 'none';
  radius: number;
  height: number;
}

export const PROP_COLLIDERS: Record<IslandPropType, PropCollider> = {
  palm_a: { shape: 'capsule', radius: 0.38, height: 8.5 },
  palm_b: { shape: 'capsule', radius: 0.4, height: 6.5 },
  palm_c: { shape: 'capsule', radius: 0.42, height: 5.0 },
  palm_tall: { shape: 'capsule', radius: 0.3, height: 13.5 },
  palm_ground: { shape: 'capsule', radius: 0.5, height: 2.0 },
  boulder_a: { shape: 'sphere', radius: 1.6, height: 2.4 },
  boulder_b: { shape: 'sphere', radius: 2.6, height: 2.0 },
  boulder_c: { shape: 'sphere', radius: 1.1, height: 2.0 },
  barrel: { shape: 'capsule', radius: 0.42, height: 1.0 },
  crate: { shape: 'capsule', radius: 0.5, height: 0.72 },
  campfire: { shape: 'sphere', radius: 0.55, height: 0.5 },
  lantern_post: { shape: 'capsule', radius: 0.16, height: 2.6 },
  watchtower: { shape: 'capsule', radius: 2.5, height: 9.0 },
  fort: { shape: 'capsule', radius: 5.2, height: 10.0 },
  shipwreck: { shape: 'sphere', radius: 2.6, height: 3.2 },
  standing_stones: { shape: 'sphere', radius: 1.2, height: 2.6 },
  tent_a: { shape: 'sphere', radius: 1.3, height: 1.6 },
  bedroll: { shape: 'none', radius: 0, height: 0.2 },
  rock_arch: { shape: 'none', radius: 0, height: 4.6 },
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
  gallows: { shape: 'capsule', radius: 0.4, height: 4.4 },
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

/**
 * Push a circle of `radius` at `pos` out of every blocking prop on `island`
 * (XZ resolution; vertical band gated by the prop's collider height above its
 * terrain sample). Pure — ready for the later physics/locomotion track.
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
    if (!col || col.shape === 'none') continue;
    const r = col.radius * prop.scale + radius;
    const dx = x - prop.x;
    const dz = z - prop.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    const baseY = getIslandSurfaceY(island, prop.x, prop.z);
    const top = baseY + col.height * prop.scale;
    // Above the prop top (jumping over a boulder) or far beneath it → no block.
    if (pos.y > top + 0.2 || pos.y < baseY - 2.5) continue;
    const d = Math.sqrt(d2) || 0.001;
    x = prop.x + (dx / d) * r;
    z = prop.z + (dz / d) * r;
    pushed = true;
  }
  return { x, z, pushed };
}

/** Convenience for placement/tests: world-space Y a prop rests at. The base
 *  seats on the LOWEST terrain sample under its footprint (center + 4 points
 *  at ~70% of the collider radius) minus a small bite — a center-only sample
 *  left rocks and story vignettes hovering wherever the relief-octave terrain
 *  fell away under one edge of the base. */
export function getPropGroundY(island: Island, prop: IslandProp): number {
  const col = PROP_COLLIDERS[prop.type];
  const footprint = col && col.shape !== 'none'
    ? col.radius * prop.scale * 0.7
    : (SPACING_OVERRIDES[prop.type] ?? 0) * prop.scale * 0.45;
  const center = getIslandSurfaceY(island, prop.x, prop.z);
  let ground = center;
  if (footprint > 0.2) {
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      ground = Math.min(ground, getIslandSurfaceY(island, prop.x + ox * footprint, prop.z + oz * footprint));
    }
    // Cap the extra sink so a wide vignette on one steep edge beds its low
    // side without drowning the whole scene.
    ground = Math.max(ground, center - 0.35);
  }
  return ground - 0.07;
}
