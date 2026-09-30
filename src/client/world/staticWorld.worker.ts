/// <reference lib="webworker" />
// b4.1c (D30, performance-05): the client half of the seed join.
//
// The join names the world (seed, WORLD_VERSION, worldHash, deltas) instead of
// carrying ~300 KB of islands. Regenerating it is 100-230 ms of MapGenerator in
// Node on the Air and ~4x that on a throttled phone, which on the main thread
// is one long task landing in the countdown and stalling input and the first
// frames. Here it runs off the main thread: generate, hash the PRISTINE world
// (what the server advertised), then apply the deltas (destroyed/moved statics)
// and hand back only the wire the snapshot path already knows how to install.
//
// A throw (bad delta path, foreign version) comes back as ok:false; the caller
// reports a wrong hash so the server answers with a full world_sync.
import { generateStaticWorld, hashStaticWorld } from '../../shared/staticWorld.js';
import { applyStaticWorldDeltas, staticWorldWire } from '../../server/core/snapshot.js';
import type { Island, SeaRock, StaticWorldDelta } from '../../shared/types/index.js';

export interface StaticWorldJob {
  id: number;
  seed: number;
  version: number;
  deltas: StaticWorldDelta[];
}

export type StaticWorldResult =
  | { id: number; ok: true; worldHash: string; islands: Island[]; seaRocks: SeaRock[]; genMs: number; totalMs: number }
  | { id: number; ok: false; error: string; totalMs: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<StaticWorldJob>) => {
  const job = e.data;
  const t0 = performance.now();
  let result: StaticWorldResult;
  try {
    const world = generateStaticWorld(job.seed, job.version);
    const genMs = performance.now() - t0;
    const { worldHash } = hashStaticWorld(world);
    const wire = applyStaticWorldDeltas(staticWorldWire(world), job.deltas ?? []);
    result = { id: job.id, ok: true, worldHash, islands: wire.islands, seaRocks: wire.seaRocks, genMs, totalMs: performance.now() - t0 };
  } catch (err) {
    result = { id: job.id, ok: false, error: String((err as Error)?.message ?? err).slice(0, 200), totalMs: performance.now() - t0 };
  }
  scope.postMessage(result);
};
