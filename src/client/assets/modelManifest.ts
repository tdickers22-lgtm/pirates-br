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
 *
 * CONTENT-HASHED NAMES (b3.1b, performance-14): the packed file is
 * packed/<key>.<hash8>.glb and ./model-manifest.json (written by the pack
 * step, imported here so it rides inside a Vite-hashed chunk) maps each key to
 * it. LobbyServer serves those names `immutable` for a year: a repeat visit
 * revalidates 0 models and a re-export changes the URL. A key missing from the
 * manifest falls back to the unhashed name (404 -> the caller's procedural
 * fallback); test-static-serving fails any ASSET_NAMES key without a row.
 *
 * Every GLTFLoader that loads a packed file needs the meshopt decoder
 * (~20 KB WASM inside three's module, decodes > 1 GB/s): use withMeshopt().
 */
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import MODEL_MANIFEST from './model-manifest.json';

export const PACKED_MODEL_BASE = '/assets/models/packed/';

/** The URL the client fetches for one model key (e.g. `palm_a`, `palm_a_far`). */
export function modelUrl(key: string): string {
  const file = (MODEL_MANIFEST as Record<string, string>)[key];
  return `${PACKED_MODEL_BASE}${file ?? `${key}.glb`}`;
}

/** Wire the meshopt decoder into a loader (idempotent); returns the loader. */
export function withMeshopt<T extends GLTFLoader>(loader: T): T {
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
