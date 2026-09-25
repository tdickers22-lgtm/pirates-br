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

/**
 * WHICH D27 FAMILY A MODEL KEY'S BYTES AND TEXTURES ARE CHARGED TO (b3.1g, critique gap 4).
 *
 * The D27 ceilings (world set 6.0 / 4.5 MB, streamed 12.0 / 6.0 MB brotli; GPU textures
 * 256 / 128 / 96 / 64 MB) are split per family in scripts/lib/budgets.mjs, and each family is graded
 * on its OWN row: test-model-transport sums brotli bytes per family per set, test-memory-budget
 * sums resident texture MB per family per tier (AssetLibrary tags userData.assetFamily on every
 * mesh and texture it loads; untagged textures (terrain, ocean, sky, env map, UI) are `shared`).
 * A `<key>_far` sibling belongs to its base key's family. Every packed GLB must have a row here:
 * test-model-transport fails a key without one, so a new GLB cannot hide in `shared`.
 */
export const MODEL_FAMILIES = [
  'shared', 'characters', 'weapons-tools', 'ship-hardware-kit', 'rocks-cliffs',
  'flora-canopy', 'props-poi', 'buildings-story', 'creatures-kraken', 'instruments',
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

const FAMILY_MEMBERS: Record<Exclude<ModelFamily, 'shared' | 'instruments'>, readonly string[]> = {
  characters: ['pirate_base'],
  'weapons-tools': ['cutlass', 'flintlock', 'flintknock', 'eye_of_reach', 'blunderbuss', 'tool_bucket', 'tool_hammer', 'tool_planks'],
  'ship-hardware-kit': ['cannon', 'capstan', 'wheel', 'ship_lantern', 'rowboat'],
  'rocks-cliffs': [
    'boulder_a', 'boulder_b', 'boulder_c', 'searock_a', 'searock_b', 'searock_c', 'rock_arch', 'crag',
    'rock_arch_cave', 'stalactite_cluster_a', 'stalactite_cluster_b', 'stalagmite_cluster_a', 'stalagmite_cluster_b',
    'cave_ledge', 'crystal_vein_a', 'crystal_vein_b', 'cave_pool_rim',
  ],
  'flora-canopy': ['palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground', 'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers'],
  'props-poi': [
    'barrel', 'keg', 'chest_closed', 'chest_open', 'crate', 'campfire', 'bedroll', 'lantern_post', 'tent_a', 'tent_b', 'tent_c',
    'bone_pile', 'driftwood_log', 'grave_marker', 'signal_pyre', 'wall_torch', 'bone_pile_cave', 'skull_shrine',
    'cave_painting_panel', 'rope_bridge_short',
  ],
  'buildings-story': [
    'dock_mid', 'dock_end', 'watchtower', 'shipwreck', 'standing_stones', 'fort', 'tavern', 'stall',
    'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton', 'rum_still', 'crow_roost', 'mermaid_shrine',
    'castaway_camp', 'kraken_wreck', 'dig_site', 'gallows', 'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage',
  ],
  'creatures-kraken': ['shark', 'crab', 'chicken', 'pig', 'gull'],
};

/** Base key -> family, built once from FAMILY_MEMBERS (a key listed twice throws at import). */
export const MODEL_FAMILY_OF: Readonly<Record<string, ModelFamily>> = (() => {
  const out: Record<string, ModelFamily> = {};
  for (const [family, keys] of Object.entries(FAMILY_MEMBERS) as [ModelFamily, readonly string[]][]) {
    for (const k of keys) {
      if (out[k]) throw new Error(`modelManifest: ${k} is in both ${out[k]} and ${family}`);
      out[k] = family;
    }
  }
  return out;
})();

/** The family a model key (or its `_far` sibling) is charged to; null for an unlisted key. */
export function modelFamily(key: string): ModelFamily | null {
  return MODEL_FAMILY_OF[key.replace(/_far$/, '')] ?? null;
}
