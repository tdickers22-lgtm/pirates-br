import * as THREE from 'three';
import type { Island } from '../../shared/types/index.js';
import { getIslandDistRatio, getIslandMaxRadius, getIslandSurfaceY } from '../../shared/utils/index.js';

const SIZE = 1024;
const MIN_Y = -12;
const HEIGHT_RANGE = 20;
/** Samples between deadline reads inside a row. */
const DEADLINE_STRIDE = 16;
/** `col` is where the current row was left when the frame's budget ran out:
 * a row is up to ~300 samples of the full relief field (~1.5 ms), so a deadline
 * checked only between rows overshot a 2 ms budget by 1-4 ms most frames. */
type RowJob = { island: Island; minX: number; maxX: number; row: number; lastRow: number; col: number };

/** A single filtered texture replaces the ellipse estimate for shoreline
 * shading. Height comes from the same field as terrain and physics, including
 * inlets, lagoon channels, cays and stamps. ~2m texels across this archipelago,
 * 8cm height precision, 4MB; no additional render pass or scene depth capture.
 * Built a few rows at a time so joining does not acquire a new long task. */
export class OceanBathymetry {
  readonly texture: THREE.DataTexture;
  /** World-space minimum X/Z and span X/Z, directly usable by the shader. */
  readonly bounds: THREE.Vector4;
  private readonly data = new Uint8Array(SIZE * SIZE * 4);
  private readonly jobs: RowJob[] = [];
  private next = 0;
  complete = false;

  constructor(islands: readonly Island[]) {
    let minX = -1, minZ = -1, maxX = 1, maxZ = 1;
    for (const island of islands) {
      const reach = getIslandMaxRadius(island) + 48;
      minX = Math.min(minX, island.position.x - reach);
      maxX = Math.max(maxX, island.position.x + reach);
      minZ = Math.min(minZ, island.position.z - reach);
      maxZ = Math.max(maxZ, island.position.z + reach);
    }
    this.bounds = new THREE.Vector4(minX, minZ, maxX - minX, maxZ - minZ);
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
    this.texture = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.name = 'ocean-bathymetry';
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    const pixelX = (x: number) => Math.floor((x - minX) / this.bounds.z * SIZE);
    const pixelZ = (z: number) => Math.floor((z - minZ) / this.bounds.w * SIZE);
    for (const island of islands) {
      const reach = getIslandMaxRadius(island) + 48;
      this.jobs.push({ island,
        minX: Math.max(0, pixelX(island.position.x - reach)),
        maxX: Math.min(SIZE - 1, pixelX(island.position.x + reach)),
        row: Math.max(0, pixelZ(island.position.z - reach)),
        lastRow: Math.min(SIZE - 1, pixelZ(island.position.z + reach)),
        col: -1,
      });
    }
  }

  /** Returns true once all islands have been sampled. Upload only the final
   * texture: partially baked coastlines must never appear in the ocean. */
  step(budgetMs = 2): boolean {
    if (this.complete) return true;
    const deadline = performance.now() + budgetMs;
    do {
      const job = this.jobs[this.next];
      if (!job) {
        this.complete = true;
        this.texture.needsUpdate = true;
        return true;
      }
      const z = this.bounds.y + (job.row + 0.5) / SIZE * this.bounds.w;
      if (job.col < job.minX) job.col = job.minX;
      let col = job.col;
      for (; col <= job.maxX; col++) {
        // The deadline is read every DEADLINE_STRIDE samples (a few tens of
        // microseconds of work), not once per row, so the frame never pays
        // more than that past `budgetMs`. scripts/test-bathymetry-budget.mjs
        // holds the overshoot to a fraction of a millisecond.
        if ((col - job.minX) % DEADLINE_STRIDE === 0 && col !== job.col && performance.now() >= deadline) {
          job.col = col;
          return false;
        }
        const x = this.bounds.x + (col + 0.5) / SIZE * this.bounds.z;
        const rawHeight = getIslandSurfaceY(job.island, x, z);
        // The physics sampler holds a -6.5m safety floor infinitely far from
        // an island. It is not an infinite shallow shelf: carrying that floor
        // to the row-job bounds drew rectangular turquoise patches at sea.
        // Continue the underwater apron down to open water before the edge.
        const offshore = (getIslandDistRatio(job.island, x, z).distRatio - 1.10)
          * job.island.radius * Math.min(job.island.profile.footprintX, job.island.profile.footprintZ);
        const deepBlend = THREE.MathUtils.smoothstep(offshore, 0, 24);
        const height = THREE.MathUtils.lerp(rawHeight, MIN_Y, deepBlend);
        const encoded = Math.round(THREE.MathUtils.clamp((height - MIN_Y) / HEIGHT_RANGE, 0, 1) * 255);
        const offset = (job.row * SIZE + col) * 4;
        if (encoded > this.data[offset]) this.data[offset] = encoded;
      }
      job.col = -1;
      if (++job.row > job.lastRow) this.next++;
    } while (performance.now() < deadline);
    return false;
  }

  dispose(): void { this.texture.dispose(); }
}
