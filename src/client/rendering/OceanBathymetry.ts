import * as THREE from 'three';
import type { Island } from '../../shared/types/index.js';
import { bakeBathymetry, bathymetryBounds, bathymetryTexel, islandTexelRect,
  BATHY_HEIGHT_RANGE, BATHY_MIN_Y, type BathyBounds } from './bathymetryField.js';

/** Samples between deadline reads inside a row (main-thread fallback only). */
const DEADLINE_STRIDE = 16;
type RowJob = { island: Island; minX: number; maxX: number; row: number; lastRow: number; col: number };

/** A single filtered texture replaces the ellipse estimate for shoreline
 * shading. Height comes from the same field as terrain and physics, including
 * inlets, lagoon channels, cays and stamps. ~2m texels across this archipelago,
 * 8cm height precision; no additional render pass or scene depth capture.
 *
 * WHERE THE SAMPLING HAPPENS. On a WORKER — see bathymetry.worker.ts. The bake
 * is 0.59M evaluations of the full relief field, and doing it on the main
 * thread cost 2 ms of EVERY frame for ~750 frames after the join (25 s at 30
 * fps, a minute on an integrated-GPU laptop), during the exact seconds the
 * island build queue, the program warmer and the first-draw reveal are spending
 * their own allowances. The worker gets plain replicated `Island` data and a
 * pure sampler, so it needs nothing from the renderer.
 *
 * `step()` is the FALLBACK for anywhere a module worker cannot be constructed
 * (a locked-down CSP, a node harness): the same arithmetic, time-sliced a few
 * rows per frame, graded by scripts/test-bathymetry-budget.mjs. */
export class OceanBathymetry {
  readonly texture: THREE.DataTexture;
  /** World-space minimum X/Z and span X/Z, directly usable by the shader. */
  readonly bounds: THREE.Vector4;
  /** True when no main-thread sampling will happen at all. */
  readonly offThread: boolean;
  /** Every texel this bake will evaluate — a pure function of the roster and
   *  the resolution, so a gate can pin it without timing anything. */
  readonly plannedSamples: number;
  private readonly size: number;
  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly field: BathyBounds;
  private readonly jobs: RowJob[] = [];
  private worker: Worker | null = null;
  private next = 0;
  complete = false;

  constructor(islands: readonly Island[], size = 1024) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
    this.field = bathymetryBounds(islands);
    const { minX, minZ, spanX, spanZ } = this.field;
    this.bounds = new THREE.Vector4(minX, minZ, spanX, spanZ);
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
    this.texture = new THREE.DataTexture(this.data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.name = 'ocean-bathymetry';
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    let planned = 0;
    for (const island of islands) {
      const rect = islandTexelRect(island, this.field, size);
      planned += Math.max(0, rect.maxX - rect.minX + 1) * Math.max(0, rect.lastRow - rect.row + 1);
    }
    this.plannedSamples = planned;
    this.offThread = this.startWorker(islands);
    if (!this.offThread) {
      for (const island of islands) {
        const rect = islandTexelRect(island, this.field, size);
        this.jobs.push({ island, ...rect, col: -1 });
      }
    }
  }

  /** @returns true when the bake was handed to a worker. */
  private startWorker(islands: readonly Island[]): boolean {
    if (typeof Worker === 'undefined') return false;
    try {
      const worker = new Worker(new URL('./bathymetry.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        this.data.set(new Uint8Array(event.data));
        this.texture.needsUpdate = true;
        this.complete = true;
        worker.terminate();
        this.worker = null;
      };
      // A worker that dies (CSP, a bundler that did not emit it) must not leave
      // the sea on the ellipse fallback for the rest of the match: fall back to
      // the sliced main-thread bake, which is what `jobs` is for.
      worker.onerror = () => {
        worker.terminate();
        this.worker = null;
        if (this.jobs.length === 0 && !this.complete) {
          for (const island of islands) {
            const rect = islandTexelRect(island, this.field, this.size);
            this.jobs.push({ island, ...rect, col: -1 });
          }
        }
      };
      // Structured clone of plain replicated data. If anything on an island is
      // not cloneable this throws HERE, before any state has changed.
      worker.postMessage({ islands: islands as Island[], bounds: this.field, size: this.size });
      this.worker = worker;
      return true;
    } catch {
      this.worker = null;
      return false;
    }
  }

  /** Returns true once all islands have been sampled. Upload only the final
   * texture: partially baked coastlines must never appear in the ocean. */
  step(budgetMs = 2): boolean {
    if (this.complete) return true;
    if (this.worker) return false;          // the worker owns it; spend nothing here
    if (this.jobs.length === 0) return false;
    const deadline = performance.now() + budgetMs;
    do {
      const job = this.jobs[this.next];
      if (!job) {
        this.complete = true;
        this.texture.needsUpdate = true;
        return true;
      }
      const z = this.field.minZ + ((job.row + 0.5) / this.size) * this.field.spanZ;
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
        const x = this.field.minX + ((col + 0.5) / this.size) * this.field.spanX;
        const encoded = bathymetryTexel(job.island, x, z);
        const offset = (job.row * this.size + col) * 4;
        if (encoded > this.data[offset]) this.data[offset] = encoded;
      }
      job.col = -1;
      if (++job.row > job.lastRow) this.next++;
    } while (performance.now() < deadline);
    return false;
  }

  /** Bake everything now, on this thread. For harnesses that have no frames. */
  bakeNow(islands: readonly Island[]): void {
    bakeBathymetry(islands, this.field, this.size, this.data);
    this.texture.needsUpdate = true;
    this.complete = true;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.texture.dispose();
  }
}

export { BATHY_HEIGHT_RANGE, BATHY_MIN_Y };
