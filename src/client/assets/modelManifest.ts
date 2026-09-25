/**
 * WHERE A MODEL KEY IS FETCHED FROM, AND HOW IT DECODES (b3.1a).
 *
 * public/assets/models/<key>.glb is the Blender export (the source every
 * node-side gate reads); public/assets/models/packed/<key>.glb is what ships:
 * EXT_meshopt_compression + KHR_mesh_quantization (int8 normals, uint8
 * colours, uint16 UVs; POSITION stays float32 so StaticBatcher's
 * applyMatrix4 + mergeGeometries, AssetMaterialCollapse and the collider /
 * bounds paths keep reading world-unit floats). scripts/pack-models.mjs writes
 * it; scripts/test-model-transport.mjs fails a raw, stale or reshaped one.
 * b3.1b swaps modelUrl() for content-hashed names.
 *
 * Every GLTFLoader that loads a packed file needs the meshopt decoder
 * (~20 KB WASM inside three's module, decodes > 1 GB/s): use withMeshopt().
 */
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const PACKED_MODEL_BASE = '/assets/models/packed/';

/** The URL the client fetches for one model key (e.g. `palm_a`, `palm_a_far`). */
export function modelUrl(key: string): string {
  return `${PACKED_MODEL_BASE}${key}.glb`;
}

/** Wire the meshopt decoder into a loader (idempotent); returns the loader. */
export function withMeshopt<T extends GLTFLoader>(loader: T): T {
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
