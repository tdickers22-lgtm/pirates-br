// b4.1c (D30, OD1 row B): island chart heights sampled OFF the main thread.
//
// The map's base bitmap for an island (MapRenderer.getIslandChartBitmap) is a
// grid of getIslandSurfaceY samples, each a full fbm terrain evaluation: up to
// 150x150 of them per island. On the throttled 4G phone profile the CPU
// profile of the 20 s after the horn put three of the five graded long tasks
// there (99-216 ms each, sampleChartRows under drawMaps/renderBattleMap). The
// heights are a pure function of the static world, so the static-world worker
// samples them right after it regenerates the world, the main thread receives
// the Float32Arrays (transferred, not copied), and MapRenderer only shades.
//
// The registry is keyed by island id and guarded by a fingerprint (extent and
// position), so an island that changed under a later world-carrying snapshot
// or a world_sync simply falls back to sampling on the main thread, as before.
import { getIslandMaxRadius, getIslandSurfaceY } from '../../shared/utils/index.js';
import type { Island } from '../../shared/types/index.js';

export interface ChartHeights {
  id: string;
  grid: number;
  extent: number;
  x: number;
  z: number;
  heights: Float32Array;
}

/** MapRenderer's base-bitmap grid for an island (same formula, same clamp). */
export function chartGridFor(island: Island): { grid: number; extent: number } {
  const extent = getIslandMaxRadius(island) * 1.04;
  const grid = Math.min(150, Math.max(48, Math.round(extent / 1.4)));
  return { grid, extent };
}

/** Sample one island's chart grid exactly like MapRenderer.sampleChartRows
 *  (cell centres, true surface height, no sea mask). */
export function sampleChartHeights(island: Island): ChartHeights {
  const { grid, extent } = chartGridFor(island);
  const heights = new Float32Array(grid * grid);
  for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      const lx = ((gx + 0.5) / grid * 2 - 1) * extent;
      const lz = ((gz + 0.5) / grid * 2 - 1) * extent;
      heights[gz * grid + gx] = getIslandSurfaceY(island, island.position.x + lx, island.position.z + lz);
    }
  }
  return { id: island.id, grid, extent, x: island.position.x, z: island.position.z, heights };
}

const presampled = new Map<string, ChartHeights>();

/** Install the worker's samples (a new world replaces the previous set). */
export function setPresampledCharts(charts: readonly ChartHeights[]): void {
  presampled.clear();
  for (const c of charts) presampled.set(c.id, c);
}

let hits = 0;
/** The worker's heights for this island if they still describe it, else null. */
export function presampledChartFor(island: Island): ChartHeights | null {
  const c = presampled.get(island.id);
  if (!c) return null;
  const { grid, extent } = chartGridFor(island);
  if (c.grid !== grid || c.extent !== extent || c.x !== island.position.x || c.z !== island.position.z) return null;
  hits += 1;
  return c;
}

/** Probe hook: how many presampled sets are installed and how many were used. */
export function presampledChartStats(): { installed: number; hits: number } {
  return { installed: presampled.size, hits };
}
