import type { Island } from '../../shared/types/index.js';
import { getIslandDistRatio, getIslandMaxRadius, getIslandSurfaceY } from '../../shared/utils/index.js';

/** Sea bed depth encoding shared by the sampler, the worker and the shader. */
export const BATHY_MIN_Y = -12;
export const BATHY_HEIGHT_RANGE = 20;

export type BathyBounds = { minX: number; minZ: number; spanX: number; spanZ: number };

/** The world rectangle the texture covers: every island plus its surf apron. */
export function bathymetryBounds(islands: readonly Island[]): BathyBounds {
  let minX = -1, minZ = -1, maxX = 1, maxZ = 1;
  for (const island of islands) {
    const reach = getIslandMaxRadius(island) + 48;
    minX = Math.min(minX, island.position.x - reach);
    maxX = Math.max(maxX, island.position.x + reach);
    minZ = Math.min(minZ, island.position.z - reach);
    maxZ = Math.max(maxZ, island.position.z + reach);
  }
  return { minX, minZ, spanX: maxX - minX, spanZ: maxZ - minZ };
}

/** The texel rectangle one island is responsible for. */
export function islandTexelRect(island: Island, bounds: BathyBounds, size: number) {
  const reach = getIslandMaxRadius(island) + 48;
  const px = (x: number) => Math.floor(((x - bounds.minX) / bounds.spanX) * size);
  const pz = (z: number) => Math.floor(((z - bounds.minZ) / bounds.spanZ) * size);
  return {
    minX: Math.max(0, px(island.position.x - reach)),
    maxX: Math.min(size - 1, px(island.position.x + reach)),
    row: Math.max(0, pz(island.position.z - reach)),
    lastRow: Math.min(size - 1, pz(island.position.z + reach)),
  };
}

function smoothstep(x: number, min: number, max: number): number {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
}

/**
 * One texel of the depth map, as the byte the shader reads.
 *
 * The physics sampler holds a -6.5m safety floor infinitely far from an island.
 * It is not an infinite shallow shelf: carrying that floor to the row-job bounds
 * drew rectangular turquoise patches at sea. Continue the underwater apron down
 * to open water before the edge.
 */
export function bathymetryTexel(island: Island, x: number, z: number): number {
  const rawHeight = getIslandSurfaceY(island, x, z);
  const offshore = (getIslandDistRatio(island, x, z).distRatio - 1.10)
    * island.radius * Math.min(island.profile.footprintX, island.profile.footprintZ);
  const deepBlend = smoothstep(offshore, 0, 24);
  const height = rawHeight + (BATHY_MIN_Y - rawHeight) * deepBlend;
  const t = Math.min(1, Math.max(0, (height - BATHY_MIN_Y) / BATHY_HEIGHT_RANGE));
  return Math.round(t * 255);
}

/** Bake every island into `data` (RGBA8, red = depth). Used by the worker and by
 *  the main-thread fallback's final rows; identical arithmetic either way. */
export function bakeBathymetry(islands: readonly Island[], bounds: BathyBounds, size: number, data: Uint8Array): void {
  for (const island of islands) {
    const rect = islandTexelRect(island, bounds, size);
    for (let row = rect.row; row <= rect.lastRow; row++) {
      const z = bounds.minZ + ((row + 0.5) / size) * bounds.spanZ;
      for (let col = rect.minX; col <= rect.maxX; col++) {
        const x = bounds.minX + ((col + 0.5) / size) * bounds.spanX;
        const encoded = bathymetryTexel(island, x, z);
        const offset = (row * size + col) * 4;
        if (encoded > data[offset]) data[offset] = encoded;
      }
    }
  }
}
