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
  boulder_a: { shape: 'sphere', radius: 1.6, height: 2.4 },
  boulder_b: { shape: 'sphere', radius: 2.6, height: 2.0 },
  boulder_c: { shape: 'sphere', radius: 1.1, height: 2.0 },
  barrel: { shape: 'capsule', radius: 0.42, height: 1.0 },
  crate: { shape: 'capsule', radius: 0.5, height: 0.72 },
  campfire: { shape: 'sphere', radius: 0.55, height: 0.5 },
  lantern_post: { shape: 'capsule', radius: 0.16, height: 2.6 },
  watchtower: { shape: 'capsule', radius: 2.5, height: 9.0 },
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
};

/** Palette hints per biome (0xRRGGBB) — the client keys vertex colors off
 *  profile.palette which MapGenerator copies from this table. */
export const BIOME_PALETTES: Record<IslandBiome, { sand: number; grass: number; rock: number; foliage: number }> = {
  lush: { sand: 0xe8d5a3, grass: 0x5fa84c, rock: 0x8b8578, foliage: 0x3e7a34 },
  palm_atoll: { sand: 0xf2e3b6, grass: 0x7cbf5a, rock: 0x9c927f, foliage: 0x4c9c46 },
  volcanic: { sand: 0x6e6154, grass: 0x77863f, rock: 0x5a5148, foliage: 0x5c7440 },
  highland: { sand: 0xc9bb94, grass: 0x6e8f4e, rock: 0x7c7c74, foliage: 0x49663c },
  bone: { sand: 0xe6ddc4, grass: 0x9ba06a, rock: 0xb0a896, foliage: 0x7c8256 },
};

/** Some landmark GLBs are much wider than their walk-blocking collider (the
 *  standing-stone RING is r≈3.5 but players can walk inside it; the shipwreck
 *  hull skeleton is ~11×5). Scatter spacing uses the visual footprint. */
const SPACING_OVERRIDES: Partial<Record<IslandPropType, number>> = {
  standing_stones: 3.6,
  shipwreck: 5.2,
};

/** Spacing radius used when scattering props (slightly wider than the hard
 *  collider so trunks/rocks never visually interpenetrate). */
export function getPropSpacingRadius(type: IslandPropType, scale: number): number {
  const col = PROP_COLLIDERS[type];
  if (!col || col.shape === 'none') return 0;
  return (SPACING_OVERRIDES[type] ?? (col.radius + 0.12)) * scale;
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

/** Convenience for placement/tests: world-space Y a prop rests at. Sunk a
 *  few cm so bases bite into sloped terrain instead of hovering on the
 *  single-sample point (patrol-1: crates/chests/tents floating on hills). */
export function getPropGroundY(island: Island, prop: IslandProp): number {
  return getIslandSurfaceY(island, prop.x, prop.z) - 0.07;
}
