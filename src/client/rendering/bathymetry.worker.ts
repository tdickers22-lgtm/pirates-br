/// <reference lib="webworker" />
// THE SHORELINE DEPTH MAP IS BAKED OFF THE MAIN THREAD.
//
// It is 0.59M samples of the full relief field for this archipelago — ridges,
// cays, cave-relief blending — and on the main thread that was 2 ms of every
// frame for ~750 frames after the join (25 s at 30 fps, a minute on an
// integrated-GPU laptop), spent at exactly the moment the island build queue,
// the program warmer and the first-draw reveal are spending their own
// allowances. A budget that is paid every frame for a minute is not a budget.
//
// Everything it needs is pure: `Island` is plain replicated data and
// getIslandSurfaceY is a function of it, so the whole bake structured-clones
// across, runs at full speed on a worker thread, and comes back as one
// transferable buffer. The main thread's share is one postMessage and one
// texture upload.
import { bakeBathymetry, type BathyBounds } from './bathymetryField.js';
import type { Island } from '../../shared/types/index.js';

type BakeRequest = { islands: Island[]; bounds: BathyBounds; size: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<BakeRequest>) => {
  const { islands, bounds, size } = event.data;
  const data = new Uint8Array(size * size * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  bakeBathymetry(islands, bounds, size, data);
  const buffer = data.buffer as ArrayBuffer;
  ctx.postMessage(buffer, [buffer]);
};
