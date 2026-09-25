import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { auditAssetMaterial } from './materialAudit.js';
import { collapseChunks } from './AssetMaterialCollapse.js';
import { modelUrl, withMeshopt, modelFamily } from './modelManifest.js';
import { loadQualityPreference, parseRenderQuality } from '../rendering/QualityPreference.js';
import { trackUpload, geometryUploaded, releaseGeometryCpu, cpuCopyReleaseEnabled } from '../rendering/CpuCopyRelease.js';

/**
 * Preloaded GLB asset library. Assets are authored in Blender
 * (scripts/blender/*.py) and exported to public/assets/models/.
 * See public/assets/models/README.md for the manifest.
 *
 * Usage:
 *   await assets.preload(onProgress);
 *   const palm = assets.clone('palm_a');          // independent transform, shared geometry/materials
 *   const inst = assets.mergedGeometry('boulder_a'); // for InstancedMesh batching
 */

export const ASSET_NAMES = [
  'palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground',
  'boulder_a', 'boulder_b', 'boulder_c',
  'searock_a', 'searock_b', 'searock_c',
  'barrel', 'keg', 'chest_closed', 'chest_open', 'crate', 'campfire',
  'dock_mid', 'dock_end',
  'watchtower', 'shipwreck', 'standing_stones', 'lantern_post', 'fort', 'tavern', 'stall',
  'tent_a', 'tent_b', 'tent_c', 'bedroll', 'rock_arch', 'crag',
  'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers',
  // Story scenes + story scatter (docs/ISLAND_STORY_BIBLE.md)
  'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
  'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp',
  'kraken_wreck', 'dig_site', 'gallows', 'parley_table',
  'mine_head', 'widow_memorial', 'gibbet_cage',
  'bone_pile', 'driftwood_log', 'grave_marker',
  // Shipped since 2026-07-25 and loaded by nothing until now; they appear
  // embedded in mermaid_shrine and crow_roost, so the standalone GLBs are
  // the same builders (_story_props.py) and can never drift from the scenes.
  'rowboat', 'signal_pyre',
  // Creatures with named animatable pivot nodes (scripts/blender/build_animals.py)
  'shark', 'crab', 'chicken', 'pig', 'gull',
  // The player: one 23-bone skeleton, six heads, three hats, two coats and 33
  // clips (RIG-01, scripts/blender/pirate_rig.py). Boot asset — see below.
  'pirate_base',
  // Hero weapons: atlas-textured GLBs with named nodes (hammer/trigger/muzzle/
  // scope) that WeaponMeshFactory clones in place of its primitive union
  // (WEAPON-01, scripts/blender/build_weapons.py). World assets, not boot
  // assets — the primitive fallback covers the queue window.
  'cutlass', 'flintlock', 'flintknock', 'eye_of_reach', 'blunderbuss',
  // Cave interior kit (CAVE-01, scripts/blender/build_cave_kit.py). World tier,
  // not boot: nothing on the menu is underground, and CaveBuilder only instances
  // them on the 6 roster islands that HAVE caves, behind the 45 m visibility
  // gate. The two stalactite clusters hang from their origin (see PINNED_BASE in
  // scripts/test-asset-bounds.mjs); everything else stands on its base.
  'stalactite_cluster_a', 'stalactite_cluster_b',
  'stalagmite_cluster_a', 'stalagmite_cluster_b',
  'rock_arch_cave', 'cave_ledge', 'crystal_vein_a', 'crystal_vein_b',
  'cave_pool_rim', 'rope_bridge_short', 'wall_torch',
  'bone_pile_cave', 'skull_shrine', 'cave_painting_panel',
] as const;

export type AssetName = (typeof ASSET_NAMES)[number];

/**
 * THE ASSETS BOOT WAITS FOR. Everything else is island content.
 *
 * `Game.init` used to `await assets.preload()` over all 63 GLBs before the name
 * field worked — 26.3 MB (9.1 MB brotli, since BOOT-01's build step) parked
 * behind "Loading ship's stores... 12/64" with the menu inert (netcode-33).
 * Nothing on that screen draws a fern.
 *
 * What IS drawn before the island finishes is a hull, her mooring and what the
 * player carries: barrels, kegs, crates, chests, a bedroll, the dock decking,
 * a lantern post and the rowboat. Ten files. The other fifty-three are island
 * and story scatter, and the world build is the first thing that can ask for
 * one — so they load during the queue and the countdown instead
 * (`preloadWorld`), where the wait is free.
 *
 * THE SAFETY RULE, and it is the whole reason this is a named set rather than a
 * slice of the array: `preloadBoot` alone does NOT make the world drawable.
 * `clone()` returns null for anything not yet in, and callers fall back to
 * procedural geometry — a visibly wrong island, not a crash. So a caller that
 * builds a world MUST await `preloadWorld()` (or `preload()`, which is both in
 * order) first. `scripts/test-asset-merge.mjs` pins that: after `preloadBoot()`
 * the world set is deterministically ABSENT.
 */
export const BOOT_ASSET_NAMES = [
  'barrel', 'keg', 'crate', 'chest_closed', 'chest_open',
  'bedroll', 'dock_mid', 'dock_end', 'lantern_post', 'rowboat',
  // The skinned pirate boots with the hull, not with the island: a player mesh
  // is built the moment a player appears, and a pirate built before her rig
  // arrived stays a box pirate for the whole match (RIG-01, lane 7.1).
  'pirate_base',
] as const satisfies readonly AssetName[];

const BOOT_ASSET_SET: ReadonlySet<string> = new Set<string>(BOOT_ASSET_NAMES);

/** How many lazy GLBs may be in flight at once. Four keeps a phone's socket
 *  pool and its decoder busy without starving the ones the player can see. */
const LAZY_FETCH_DEPTH = 4;

/**
 * THE FIFTEEN HERO SCENES NOBODY CAN SEE FROM THE QUEUE (LOD-01 / assets-08).
 *
 * Each story scene is a whole tableau in one GLB — the wrecker's tower, the
 * kraken wreck, the whale skeleton — 25-48k triangles and ~17 MB between them,
 * and every one of them was fetched and decoded before `preloadWorld()`
 * resolved, i.e. before the countdown could end. A match cannot start until the
 * last of them is in, yet at most three are ever within a kilometre of the
 * spawn and a roster island carries one or two.
 *
 * So they leave the world set and load through `ensure()` instead: the island
 * build asks for the ones its own scatter actually names, PropScatterer stands
 * a seated placeholder in the meantime (see buildLazyStoryProp), and
 * `updateInstanceLod` promotes an island's request to the head of the queue
 * once its edge is inside LAZY_PRIORITY_M. Nothing is ever MISSING from the
 * scene graph — the placeholder is a real, ground-seated, named node, so the
 * floating-prop census counts the same 3,298 pieces it always did — and
 * nothing waits on 17 MB it cannot see.
 */
export const LAZY_ASSET_NAMES = [
  'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
  'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp',
  'kraken_wreck', 'dig_site', 'gallows', 'parley_table',
  'mine_head', 'widow_memorial', 'gibbet_cage',
] as const satisfies readonly AssetName[];

const LAZY_ASSET_SET: ReadonlySet<string> = new Set<string>(LAZY_ASSET_NAMES);

/** True for a name that `preloadWorld()` deliberately does NOT fetch. */
export function isLazyAsset(name: string): boolean {
  return LAZY_ASSET_SET.has(name);
}

/** The story scenes whose 2-4k `<name>_far.glb` proxy has SHIPPED (passed
 *  build_far_lods.py's verify and test-far-lod-integrity). Only these are
 *  fetched with the world set; a name missing here keeps the seated box until
 *  its proxy lands. All fifteen (b1.1g): kraken_wreck (459 closed parts) and
 *  widow_memorial (356 twelve-triangle stones) were floor-bound above the 4k
 *  band until the build's compact path turned their small closed parts into
 *  4-triangle tetrahedra (2840 and 2270 tris). */
export const STORY_PROXY_NAMES: readonly AssetName[] = [
  'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton', 'rum_still',
  'crow_roost', 'mermaid_shrine', 'castaway_camp', 'kraken_wreck', 'dig_site', 'gallows',
  'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage',
];

/** Metres from the island's EDGE inside which a story scene's LOD0 is fetched
 *  and swapped in over its far proxy (b1.1g, performance-09). Outside it the
 *  2-4k `<name>_far.glb` proxy, which rides the world set, stands alone: lazy
 *  means "when near", not "after the countdown". Real metres, not apparent
 *  ones — a spyglass sweep must not fetch the map. */
export const LAZY_PRIORITY_M = 600;
/** The same line on a phone, where LOD0 is the biggest resident item. */
export const STORY_LOD0_PHONE_M = 400;
/** A phone disposes a story scene's LOD0 (its proxy stays) once the island
 *  edge is beyond this, and re-ensures it on the next approach. */
export const STORY_EVICT_PHONE_M = 1500;

let phoneProfile: boolean | null = null;
/** True on a phone/tablet (`?profile=mobile` forces it, `?profile=desktop`
 *  forbids it): the profile whose story LOD0 is fetched later and evicted. */
export function storyPhoneProfile(): boolean {
  if (phoneProfile !== null) return phoneProfile;
  let forced: string | null = null;
  try { forced = new URLSearchParams(globalThis.location?.search ?? '').get('profile'); } catch { forced = null; }
  if (forced === 'mobile') phoneProfile = true;
  else if (forced === 'desktop') phoneProfile = false;
  else {
    const nav = globalThis.navigator as Navigator | undefined;
    const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
    const touch = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
    phoneProfile = /android|iphone|ipad|ipod|\bmobile\b|silk|kindle/i.test(ua) || (touch > 1 && coarse);
  }
  return phoneProfile;
}

/** The 38 the world build needs, the menu does not, and that are not lazy. */
export const WORLD_ASSET_NAMES: readonly AssetName[] =
  ASSET_NAMES.filter((n) => !BOOT_ASSET_SET.has(n) && !LAZY_ASSET_SET.has(n));

/** Assets that must be faceted even though their GLB carries smooth normals.
 *  Empty by design: the right place to force facets is the Blender builder
 *  (`use_smooth=False`), which then ships split normals and needs no loader
 *  override. `scripts/test-asset-merge.mjs` fails on any material outside this
 *  set that comes back flat-shaded. */
export const FLAT_SHADED_ASSETS: ReadonlySet<string> = new Set<string>();

/** The assets the 2026-09-05 fidelity pass rebuilt at 1.2-4.8x their old
 *  triangle counts. Each ships a decimated `<name>_far.glb` sibling
 *  (scripts/blender/build_far_lods.py) that InstanceLod swaps in once the
 *  island is far enough that the detail is sub-pixel. A missing sibling is
 *  tolerated: the batch simply keeps its near geometry at every distance. */
export const FAR_ASSET_NAMES = [
  'palm_a', 'palm_b', 'palm_c',
  'boulder_a', 'boulder_b', 'boulder_c',
  'searock_a', 'searock_b', 'searock_c',
  'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers',
  // The shark's far sibling is a TIER swap, not only a distance one: it is the
  // 1,058-tri rigid puppet FaunaMeshFactory draws on `low`, where the 8.3k
  // skinned hero would cost SHARK.MAX_WORLD x ~7k extra triangles and a
  // skinning shader variant (FAUNAGLB-01).
  'shark',
] as const satisfies readonly AssetName[];
type FarKey = `${(typeof FAR_ASSET_NAMES)[number] | (typeof LAZY_ASSET_NAMES)[number]}_far`;
const STORY_PROXY_SET: ReadonlySet<string> = new Set<string>(STORY_PROXY_NAMES);
type AssetKey = AssetName | FarKey;

export interface MergedAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

/** World keys a runtime caller clones long after the islands are built (weapon
 *  pickups, fauna spawns). Their templates are never dropped outright by the
 *  CPU-copy release, only after upload, so `clone()` keeps serving them. */
const RUNTIME_CLONED: ReadonlySet<string> = new Set<string>([
  'cutlass', 'flintlock', 'flintknock', 'eye_of_reach', 'blunderbuss',
  'shark', 'crab', 'chicken', 'pig', 'gull',
  // Sea rocks drain on their own queue, which may trail the islands'.
  'searock_a', 'searock_b', 'searock_c',
]);
const STORY_PROXY_KEYS: ReadonlySet<string> = new Set<string>(STORY_PROXY_NAMES.map((n) => `${n}_far`));
/** A library key whose template/merged CPU copies the phone release may drop:
 *  world-set GLBs and their far siblings. Never boot assets (ships, kegs and
 *  chests are cloned all match long), never lazy story scenes (evict() owns
 *  them) or their proxies (the story slot re-merges them on eviction). */
function cpuReleasableKey(key: string): boolean {
  if (STORY_PROXY_KEYS.has(key)) return false;
  const base = key.replace(/_far$/, '');
  return !BOOT_ASSET_SET.has(base) && !isLazyAsset(base);
}

/** Released GLBs refetched + re-parsed at once at the next match (b1-device-03). */
export const REHYDRATE_CONCURRENCY = 3;

// ── KTX2 TEXTURES (b3.1c; performance-02) ──────────────────────────────────
// scripts/pack-models.mjs ships every GLB texture as KHR_texture_basisu (ETC1S
// colour/ORM, UASTC+zstd normals, full mip chain in the file). ONE KTX2Loader
// serves every GLTFLoader (a second one would spin a second transcoder worker
// pool). Its transcoder (public/basis/, served with .br/.gz siblings) is only
// fetched by the first .load(), i.e. by the first GLB that carries a KTX2
// image; no boot-set GLB does (test-texture-budget), so the ~220 KB brotli
// transcoder is paid in the world stage, never before the menu (D27).

/** Top-mip ceilings on the capped tiers (low quality, phones, iPad): family
 *  maps upload at most 512 px, the hero first-person viewmodel at most 1024.
 *  test-texture-budget reads these two numbers out of this file. */
export const TEXTURE_TOP_MIP_CAP = { family: 512, heroViewmodel: 1024 } as const;
/** Assets drawn as the held first-person viewmodel (the 1024 cap applies). */
export const HERO_VIEWMODEL_TEXTURE_ASSETS: ReadonlySet<string> = new Set<string>(['cutlass', 'flintlock', 'blunderbuss', 'eye_of_reach', 'flintknock', 'tool_bucket', 'tool_hammer', 'tool_planks']);

/** The subset of WebGLRenderer KTX2Loader.detectSupport reads. */
export type TextureSupportSource = { extensions: { has(name: string): boolean }; capabilities: { isWebGL2: boolean } };

let ktx2Loader: KTX2Loader | null = null;
let ktx2Support: TextureSupportSource | null = null;

/** The game's renderer, when the caller has one: detectSupport reads its
 *  context instead of a throwaway probe context. Call before the world set. */
export function attachTextureRenderer(renderer: TextureSupportSource): void {
  ktx2Support = renderer;
  ktx2Loader?.detectSupport(renderer as unknown as THREE.WebGLRenderer);
}

/** Compressed-format support without the renderer: one probe context, read
 *  once and released (format support is a property of the device/browser). */
function probeTextureSupport(): TextureSupportSource {
  const exts = new Set<string>();
  let isWebGL2 = false;
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 ?? canvas.getContext('webgl');
    isWebGL2 = gl2 !== null;
    for (const e of gl?.getSupportedExtensions() ?? []) exts.add(e);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* no GL: KTX2Loader falls back to RGBA32, which every GL accepts */ }
  return { extensions: { has: (n: string) => exts.has(n) }, capabilities: { isWebGL2 } };
}

/** detectSupport runs at the first .load(), not at construction: the library
 *  singleton is built at import (menu time) and must not open a probe context
 *  or touch the transcoder before a KTX2 image actually arrives. */
class LazyKtx2Loader extends KTX2Loader {
  private detected = false;
  override load(...args: Parameters<KTX2Loader['load']>): ReturnType<KTX2Loader['load']> {
    if (!this.detected) {
      this.detected = true;
      ktx2Support ??= probeTextureSupport();
      this.detectSupport(ktx2Support as unknown as THREE.WebGLRenderer);
    }
    return super.load(...args);
  }
}

/** The shared KTX2Loader (created on first use, transcoder path /basis/). */
export function sharedKtx2Loader(): KTX2Loader {
  ktx2Loader ??= new LazyKtx2Loader().setTranscoderPath('/basis/');
  return ktx2Loader;
}

/** Wire the shared KTX2 decoder into a GLTFLoader (idempotent); returns it.
 *  Every loader that fetches a packed GLB needs this beside withMeshopt(). */
export function withKtx2<T extends GLTFLoader>(loader: T): T {
  loader.setKTX2Loader(sharedKtx2Loader());
  return loader;
}

let cappedTier: boolean | null = null;
/** Low quality, phone or iPad: textures upload without their top mip(s). */
export function textureTierCapped(): boolean {
  if (cappedTier !== null) return cappedTier;
  let urlQuality: string | null = null;
  try { urlQuality = new URLSearchParams(globalThis.location?.search ?? '').get('quality'); } catch { urlQuality = null; }
  const quality = parseRenderQuality(urlQuality) ?? loadQualityPreference();
  cappedTier = storyPhoneProfile() || quality === 'low';
  return cappedTier;
}

/** Drop top mips of a compressed (KTX2) texture until it fits `cap`. Returns
 *  the number of levels dropped. Must run before the first upload. */
export function dropTopMips(tex: THREE.Texture, cap: number): number {
  const c = tex as THREE.CompressedTexture;
  if (!c.isCompressedTexture || !Array.isArray(c.mipmaps)) return 0;
  const mips = c.mipmaps as { width: number; height: number }[];
  let dropped = 0;
  while (mips.length > 1 && Math.max(mips[0].width, mips[0].height) > cap) { mips.shift(); dropped += 1; }
  if (dropped) {
    const img = c.image as { width: number; height: number };
    img.width = mips[0].width; img.height = mips[0].height;
    c.needsUpdate = true;
  }
  return dropped;
}

export class AssetLibrary {
  private scenes = new Map<AssetKey, THREE.Group>();
  /** cloneTinted copies, one per (template material uuid, colour). */
  private tintedMaterials = new Map<string, THREE.MeshStandardMaterial>();
  private merged = new Map<AssetKey, MergedAsset>();
  /** Animation clips per asset — GLTFLoader hands them back beside the scene,
   *  not on it, so they would otherwise be dropped on the floor. */
  private clips = new Map<AssetKey, THREE.AnimationClip[]>();
  private boundsCache = new Map<AssetName, THREE.Box3>();
  /** Geometries/materials owned by the library (shared across clones) — must never be disposed by callers. */
  private sharedResources = new WeakSet<object>();
  /**
   * Every mesh NAME any loaded GLB carries — `lantern_post_post_1`,
   * `campfire_stone0_3`, `tent_c_pole_5`.
   *
   * These are the Blender exporter's node names, and nothing addresses them:
   * they exist because glTF names every node it writes. That mattered nowhere
   * until the static batcher, whose rule is "never merge a mesh with a NAME,
   * because a name is how this codebase finds a node again" — a rule the
   * exporter defeats wholesale. A pier is 38 draw calls of which 36 are refused
   * for carrying a name out of Blender that no line of this repo has ever read.
   *
   * Recording the set here is what lets the batcher tell an exporter's name from
   * one this game wrote, without guessing at the shape of the string. See
   * `island/StaticBatcher.ts`.
   */
  private assetNodeNames = new Set<string>();
  private loaded = false;

  private bootLoaded = false;
  /** In-flight (or settled) world load, so a second caller joins the first
   *  rather than fetching 53 GLBs again. */
  private worldLoad: Promise<void> | null = null;
  /** One promise per `ensure()`d name, so N callers share one fetch. */
  private readonly ensured = new Map<AssetName, Promise<void>>();
  private readonly lazyQueue: { name: AssetName; run: () => void }[] = [];
  private lazyActive = 0;
  private readonly loader = withKtx2(withMeshopt(new GLTFLoader()));
  private done = 0;

  /**
   * CPU-COPY RELEASE OF LIBRARY TEMPLATES (phone/iPad, b1.7b; see
   * rendering/CpuCopyRelease). `cpuReleased`: keys whose template (and merged)
   * arrays were released after the match's islands were built. `cloneDead`:
   * keys whose template was never drawn and was dropped outright, so `clone()`
   * answers null (the documented fallback). A released key is never MERGED
   * again (the cached merge is served; an uncached one answers null), because a
   * merge reads the template's vertices. The next match calls
   * `rehydrateReleased()`, which refetches exactly these GLBs (HTTP cache) and
   * holds island builds (`rehydrating`) until they are back.
   */
  private readonly cpuReleased = new Set<AssetKey>();
  private readonly cloneDead = new Set<AssetKey>();
  private cpuReleaseDone = false;
  /** Lazy story LOD0s whose CPU copies are armed to drop after upload (b1-ask-05). */
  private lazyCpuArmed = new Set<AssetKey>();
  private rehydrateJob: Promise<void> | null = null;
  rehydrating = false;

  /**
   * Boot first, then the world — the old whole-library behaviour, unchanged for
   * any caller that just wants everything before it starts. A caller that can
   * put the island's 53 files behind a countdown calls `preloadBoot()` and then
   * `preloadWorld()`; see BOOT_ASSET_NAMES for why the second is not optional.
   */
  async preload(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.loaded) return;
    await this.preloadBoot(onProgress);
    await this.preloadWorld(onProgress);
  }

  /** The ten files a hull, her berth and the player's hands need. Resolves
   *  WITHOUT having started the world set: nothing races the assertion that the
   *  island content is still absent. */
  async preloadBoot(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.bootLoaded) return;
    await this.loadSet(BOOT_ASSET_NAMES, onProgress);
    this.bootLoaded = true;
  }

  /** The other 53, plus the far LODs. Idempotent and joinable: two callers
   *  during the countdown share one fetch. */
  preloadWorld(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.worldLoad) {
      this.worldLoad = (async () => {
        await this.loadSet(WORLD_ASSET_NAMES, onProgress, true);
        this.loaded = true;
      })();
    }
    return this.worldLoad;
  }

  /** True once every GLB the world set names is in. Lazy story scenes are NOT
   *  in it by design — `clone()` still returns null for one that has not been
   *  `ensure()`d yet, and the caller keeps its placeholder. */
  get isFullyLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Fetch ONE asset on demand, at most once, joinable by any number of callers.
   *
   * `priority` moves a pending request to the head of the queue instead of
   * starting a second fetch — the island 300 m off the bow gets its tableau
   * before the one on the far side of the map, and neither costs the countdown
   * anything. The queue is depth-limited so a fourteen-island roster cannot open
   * fifteen sockets at once on a phone.
   */
  ensure(name: AssetName, priority = false): Promise<void> {
    const existing = this.ensured.get(name);
    if (existing) {
      if (priority) this.promote(name);
      return existing;
    }
    if (this.scenes.has(name)) {
      const done = Promise.resolve();
      this.ensured.set(name, done);
      return done;
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const job = { name, run: release };
    if (priority) this.lazyQueue.unshift(job); else this.lazyQueue.push(job);
    const settled = gate
      .then(() => this.loadSet([name]))
      .then(() => { this.armLazyCpuRelease(name); })
      .finally(() => { this.lazyActive -= 1; this.pumpLazy(); });
    this.ensured.set(name, settled);
    this.pumpLazy();
    return settled;
  }

  /**
   * PHONE HEAP, STORY LOD0 (b1-ask-05, OD2). A lazy story scene lands through
   * ensure() at any time in the match — often after releaseCpuCopies() ran — and
   * cpuReleasableKey() rightly keeps it out of that sweep (evict() owns its
   * lifetime). But nothing reads its vertices once it is on the GPU: the story
   * slot clones it (clone() shares the geometry), blendStoryPad reads only the
   * bounding sphere, and nothing merges a LOD0. So on the release profile each
   * LOD0 geometry drops its CPU copy inside its own upload, bounds computed
   * first. evict() still disposes it and the next ensure() refetches a fresh,
   * full copy (re-armed here). Measured before: 12.5 MB of story LOD0 arrays
   * retained on the phone after the 60 s tour (58302dc1). Returns bytes armed.
   */
  private armLazyCpuRelease(name: AssetName): number {
    if (!cpuCopyReleaseEnabled() || this.lazyCpuArmed.has(name)) return 0;
    const src = this.scenes.get(name);
    if (!src) return 0;
    const geoms = new Set<THREE.BufferGeometry>();
    let skinned = false;
    src.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      else if (o instanceof THREE.Mesh) geoms.add(o.geometry);
    });
    if (skinned) return 0;
    this.bounds(name);
    let bytes = 0;
    for (const g of geoms) bytes += releaseGeometryCpu(g, false);
    this.lazyCpuArmed.add(name);
    return bytes;
  }

  /** A fresh, library-independent parse of one GLB (own buffers, own textures).
   *  For the memory census mutation only: it must not share anything the
   *  release above has emptied. */
  async loadDetached(name: AssetName): Promise<THREE.Group> {
    return (await this.loader.loadAsync(modelUrl(name))).scene;
  }

  /** Has this name been asked for through `ensure()` (settled or in flight)? */
  isEnsured(name: AssetName): boolean {
    return this.ensured.has(name);
  }

  private promote(name: AssetName): void {
    const i = this.lazyQueue.findIndex((j) => j.name === name);
    if (i > 0) this.lazyQueue.unshift(this.lazyQueue.splice(i, 1)[0]);
  }

  private pumpLazy(): void {
    while (this.lazyActive < LAZY_FETCH_DEPTH && this.lazyQueue.length > 0) {
      this.lazyActive += 1;
      this.lazyQueue.shift()!.run();
    }
  }

  /** Fetch + register one GLB under `key` (`name` is its base asset name). */
  private async loadOne(name: AssetName, key: AssetKey): Promise<void> {
    const gltf = await this.loader.loadAsync(modelUrl(key));
    const root = gltf.scene;
    const mipCap = textureTierCapped()
      ? (HERO_VIEWMODEL_TEXTURE_ASSETS.has(name) ? TEXTURE_TOP_MIP_CAP.heroViewmodel : TEXTURE_TOP_MIP_CAP.family)
      : Infinity;
    // b3.1g: every object and texture this GLB brings is charged to its D27 family
    // (test-memory-budget sums resident texture MB per family from these tags).
    const assetFamily = modelFamily(key) ?? 'shared';
    root.userData.assetFamily = assetFamily;
    root.traverse((o) => {
      o.userData.assetFamily = assetFamily;
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.name) this.assetNodeNames.add(o.name);
        this.sharedResources.add(o.geometry);
        trackUpload(o.geometry);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          this.sharedResources.add(m);
          // Register texture slots too — material clones (cloneTinted) share
          // texture references, so per-clone disposal must skip them.
          const record = m as unknown as Record<string, unknown>;
          for (const key of Object.keys(record)) {
            const value = record[key] as { isTexture?: boolean } | null;
            if (value && value.isTexture) {
              this.sharedResources.add(value);
              const tex = value as unknown as THREE.Texture;
              tex.userData.assetFamily ??= assetFamily;
              if (mipCap !== Infinity) dropTopMips(value as unknown as THREE.Texture, mipCap);
            }
          }
          if (m instanceof THREE.MeshStandardMaterial) {
            // The GLB's own normals decide (assets-06). The exporter
            // already writes SPLIT normals wherever the builder chose
            // flat — every rock ships 3 verts per triangle — and SHARED
            // normals wherever it chose smooth: ropes, kraken tentacles,
            // the mermaid idol, the shark's fusiform body, palm trunks.
            // Forcing flatShading here faceted all of them and capped the
            // payoff of every high-poly rebuild (a 10k-tri smooth boulder
            // still showed 10k facets). Collapse keys on flatShading
            // (AssetMaterialCollapse), so this must stay uniform per
            // asset — an empty allowlist keeps it uniform (all false) and
            // lets MORE pieces share a batch, not fewer.
            m.flatShading = FLAT_SHADED_ASSETS.has(name);
            // Lift near-black albedo off the AgX toe and cap metalness
            // while the scene ships without an envMap — see materialAudit.
            auditAssetMaterial(m);
            m.needsUpdate = true;
          }
        }
      }
    });
    this.scenes.set(key, root);
    if (gltf.animations.length) this.clips.set(key, gltf.animations);
  }

  /**
   * Release the CPU copies of every world template and merged geometry (phone/
   * iPad; the caller gates on cpuCopyReleaseEnabled). Call once the match's
   * islands and sea rocks are all built — the batcher and the merges have read
   * the vertices they will ever read. `scene` decides what is drawn: a template
   * nothing references and nothing has uploaded is dropped outright and stops
   * being served; everything else drops after its GPU upload. Idempotent until
   * the next `rehydrateReleased()`. Returns the CPU bytes released or armed.
   */
  releaseCpuCopies(scene: THREE.Object3D): number {
    if (this.cpuReleaseDone || this.rehydrating) return 0;
    this.cpuReleaseDone = true;
    const inScene = new Set<object>();
    scene.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) inScene.add(g); });
    let bytes = 0;
    for (const [key, root] of this.scenes) {
      if (this.cpuReleased.has(key) || !cpuReleasableKey(key)) continue;
      const geoms = new Set<THREE.BufferGeometry>();
      let skinned = false;
      root.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
        else if (o instanceof THREE.Mesh) geoms.add(o.geometry);
      });
      if (skinned || geoms.size === 0) continue;
      // Bounds from the vertices while they exist: callers fit clones with them.
      if (!key.endsWith('_far')) this.bounds(key as AssetName);
      const dead = !RUNTIME_CLONED.has(key.replace(/_far$/, ''))
        && [...geoms].every((g) => !inScene.has(g) && !geometryUploaded(g));
      for (const g of geoms) bytes += releaseGeometryCpu(g, dead);
      if (dead) this.cloneDead.add(key);
      const merged = this.merged.get(key);
      if (merged) {
        const mergedDead = !inScene.has(merged.geometry) && !geometryUploaded(merged.geometry);
        bytes += releaseGeometryCpu(merged.geometry, mergedDead);
        if (mergedDead) this.merged.delete(key);
      }
      this.cpuReleased.add(key);
    }
    return bytes;
  }

  /**
   * Next match: refetch every released GLB (the HTTP cache answers) so the
   * batcher and the merges have vertices again. Island builds wait on
   * `rehydrating`. Old GPU resources nothing in `scene` still uses are disposed.
   */
  rehydrateReleased(scene: THREE.Object3D): Promise<void> {
    this.cpuReleaseDone = false;
    if (this.rehydrateJob) return this.rehydrateJob;
    if (this.cpuReleased.size === 0) return Promise.resolve();
    const keys = [...this.cpuReleased];
    this.rehydrating = true;
    const keepGeo = new Set<object>();
    const keepMat = new Set<object>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) keepGeo.add(m.geometry);
      if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) keepMat.add(x);
    });
    this.rehydrateJob = (async () => {
      // Bounded (b1-device-03): each load refetches (a conditional GET) and
      // re-parses a GLB on the main thread; all ~50 at once on a phone was a
      // heap spike plus a 4G burst. REHYDRATE_CONCURRENCY workers drain the
      // list, yielding a task between parses so frames keep landing.
      let next = 0;
      const worker = async () => {
        while (next < keys.length) {
          const key = keys[next++];
          await rehydrateOne(key);
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      };
      const rehydrateOne = async (key: AssetKey) => {
        const old = this.scenes.get(key);
        const oldMerged = this.merged.get(key);
        try {
          await this.loadOne(key.replace(/_far$/, '') as AssetName, key);
        } catch (err) {
          console.warn(`[assets] rehydrate ${key} failed — it stays released (fallbacks draw)`, err);
          return;
        }
        this.cpuReleased.delete(key);
        this.cloneDead.delete(key);
        this.merged.delete(key);
        this.boundsCache.delete(key as AssetName);
        const seen = new Set<object>();
        const drop = (r: { dispose(): void } | null | undefined, keep: Set<object>) => {
          if (!r || seen.has(r) || keep.has(r)) return;
          seen.add(r);
          r.dispose();
        };
        old?.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          drop(o.geometry, keepGeo);
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (!m || keepMat.has(m)) continue;
            for (const v of Object.values(m as unknown as Record<string, unknown>)) {
              if (v && (v as { isTexture?: boolean }).isTexture) drop(v as THREE.Texture, keepMat);
            }
            drop(m, keepMat);
          }
        });
        if (oldMerged) drop(oldMerged.geometry, keepGeo);
      };
      await Promise.all(Array.from({ length: Math.min(REHYDRATE_CONCURRENCY, keys.length) }, worker));
    })().finally(() => { this.rehydrating = false; this.rehydrateJob = null; });
    return this.rehydrateJob;
  }

  /** Loads a set of GLBs in parallel. Failures are logged and tolerated:
   *  callers get `null` from clone() and should keep their procedural fallback.
   *  `done`/`total` stay a count over the WHOLE library across both calls, so a
   *  split boot still drives one honest progress bar. */
  private async loadSet(
    names: readonly AssetName[],
    onProgress?: (done: number, total: number) => void,
    withFarLods = false,
  ): Promise<void> {
    const loadOne = (name: AssetName, key: AssetKey) => this.loadOne(name, key);
    await Promise.all([
      ...names.map(async (name) => {
        try {
          await loadOne(name, name);
        } catch (err) {
          console.warn(`[assets] failed to load ${name}.glb — procedural fallback stays`, err);
        } finally {
          this.done += 1;
          onProgress?.(this.done, ASSET_NAMES.length);
        }
      }),
      // Far siblings ride the same parallel fetch but never the progress bar:
      // they are an optimisation, not content, and their absence costs only
      // triangles at distance. They are all island nature, so they ride the
      // WORLD set — a boot that fetched them would be paying for distant
      // triangles before the menu exists.
      ...(withFarLods ? FAR_ASSET_NAMES.map(async (name) => {
        try {
          await loadOne(name, `${name}_far`);
        } catch (err) {
          console.warn(`[assets] no far LOD for ${name} (${name}_far.glb) — near geometry at every distance`, err);
        }
      }) : []),
      // The story proxies (b1.1g) ride the world set for the opposite reason:
      // they ARE the content until the island is near, so their LOD0 can stay
      // out of memory. 15 x 2-4k triangles, a few hundred KB in all.
      ...(withFarLods ? STORY_PROXY_NAMES.map(async (name) => {
        try {
          await loadOne(name, `${name as (typeof LAZY_ASSET_NAMES)[number]}_far`);
        } catch (err) {
          console.warn(`[assets] no story proxy for ${name} (${name}_far.glb) — box stand-in until LOD0`, err);
        }
      }) : []),
    ]);
  }

  has(name: AssetName): boolean {
    return this.scenes.has(name);
  }

  /**
   * True when `name` is a node name that came out of a GLB rather than out of
   * this codebase.
   *
   * Only ever a licence to treat the node as anonymous — never a licence to
   * treat it as safe. A GLB is perfectly free to call a node `door`, and the
   * tavern's is exactly that; the caller still owes the addressed-name check.
   */
  isAssetNodeName(name: string): boolean {
    return this.assetNodeNames.has(name);
  }

  /**
   * True when the geometry/material is owned by the library cache (shared by
   * every clone/instance). Callers disposing per-match scene graphs must skip
   * these resources.
   */
  isShared(resource: object | null | undefined): boolean {
    return !!resource && this.sharedResources.has(resource);
  }

  /** Local-space AABB of the asset (cached). Useful for fitting clones to gameplay colliders. */
  bounds(name: AssetName): THREE.Box3 | null {
    const cached = this.boundsCache.get(name);
    if (cached) return cached;
    const src = this.scenes.get(name);
    if (!src) return null;
    src.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(src);
    this.boundsCache.set(name, box);
    return box;
  }

  /** Deep-clone the asset scene graph; geometry/materials stay shared. */
  clone(name: AssetName): THREE.Group | null {
    const src = this.scenes.get(name);
    if (!src || this.cloneDead.has(name)) return null;
    return src.clone(true);
  }

  /** The LOADED source scene (not a clone) and its clips. For skinned assets
   *  only: THREE.Object3D.clone() copies a SkinnedMesh's skeleton BY REFERENCE,
   *  so every clone would pose off the source's bones — which are not in any
   *  scene and never update — and all four sharks would share one pose. Such a
   *  caller clones with SkeletonUtils instead (FAUNAGLB-01). */
  source(name: AssetName): { scene: THREE.Group; animations: THREE.AnimationClip[] } | null {
    const scene = this.scenes.get(name);
    if (!scene) return null;
    return { scene, animations: this.clips.get(name) ?? [] };
  }

  /** A clone of the decimated far sibling (`<name>_far.glb`), or null when the
   *  asset has none — callers then simply keep the near clone at every distance. */
  cloneFar(name: AssetName): THREE.Group | null {
    if (!(FAR_ASSET_NAMES as readonly string[]).includes(name)) return null;
    const key = `${name as (typeof FAR_ASSET_NAMES)[number]}_far` as AssetKey;
    const src = this.scenes.get(key);
    if (!src || this.cloneDead.has(key)) return null;
    return src.clone(true);
  }

  /**
   * Clone with all materials duplicated, then tint materials whose name
   * matches `matchMat` (e.g. 'TeamTint') to the given color.
   */
  cloneTinted(name: AssetName, matchMat: string, color: THREE.ColorRepresentation): THREE.Group | null {
    const root = this.clone(name);
    if (!root) return null;
    const hex = new THREE.Color(color).getHexString();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = mats.map((m) => {
          if (m.name === matchMat && m instanceof THREE.MeshStandardMaterial) {
            // b1-ask-05: one tinted copy per (template material, colour), shared by
            // every clone; each copy costs the renderer its own uniforms clone.
            const key = `${m.uuid}|${hex}`;
            let c = this.tintedMaterials.get(key);
            if (!c) {
              c = m.clone();
              c.color.set(color);
              this.tintedMaterials.set(key, c);
              this.sharedResources.add(c); // per-object disposal must skip it now
            }
            return c;
          }
          return m;
        });
        o.material = Array.isArray(o.material) ? cloned : cloned[0];
      }
    });
    return root;
  }

  /**
   * Flatten the asset into a single geometry with material groups —
   * suitable for THREE.InstancedMesh (palms/rocks scattered across islands).
   * Cached per asset.
   */
  mergedGeometry(name: AssetName): MergedAsset | null {
    return this.mergeKey(name);
  }

  /** The 2-4k far proxy of a lazy story scene, merged like a batch so one
   *  InstancedMesh stands for it until LOD0 arrives. Null before the world set
   *  lands or when the proxy file is missing (the caller keeps a box). */
  mergedStoryProxy(name: AssetName): MergedAsset | null {
    if (!STORY_PROXY_SET.has(name)) return null;
    return this.mergeKey(`${name as (typeof LAZY_ASSET_NAMES)[number]}_far`);
  }

  /** How many story LOD0s have been disposed by `evict()` this session. */
  storyEvictions = 0;

  /**
   * Drop a lazy story scene's LOD0 from memory (phones, beyond
   * STORY_EVICT_PHONE_M): its source scene, merged copy, clips and bounds go,
   * geometry/material/texture GPU resources are disposed, and the next
   * `ensure()` fetches it again. Only lazy assets, only once loaded; the
   * caller (PropScatterer's story slot) guarantees no clone is still in the
   * scene graph. Returns true when something was released.
   */
  evict(name: AssetName): boolean {
    if (!isLazyAsset(name)) return false;
    const src = this.scenes.get(name);
    if (!src) return false;
    const merged = this.merged.get(name);
    this.scenes.delete(name);
    this.merged.delete(name);
    this.clips.delete(name);
    this.boundsCache.delete(name);
    this.ensured.delete(name);
    this.lazyCpuArmed.delete(name);
    const seen = new Set<object>();
    const drop = (r: { dispose(): void } | null | undefined) => {
      if (!r || seen.has(r)) return;
      seen.add(r);
      r.dispose();
    };
    src.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      drop(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        for (const v of Object.values(m as unknown as Record<string, unknown>)) {
          if (v && (v as { isTexture?: boolean }).isTexture) drop(v as THREE.Texture);
        }
        drop(m);
      }
    });
    // The merged copy's geometry is this asset's own; its materials may be
    // collapsed and shared with other assets, so they are left alone.
    if (merged) drop(merged.geometry);
    this.storyEvictions += 1;
    return true;
  }

  /** The decimated far variant of a rebuilt nature asset, merged and collapsed
   *  exactly like the near one so a batch can swap between the two by pointer.
   *  Null when the asset has no far sibling on disk. */
  mergedFarGeometry(name: AssetName): MergedAsset | null {
    if (!(FAR_ASSET_NAMES as readonly string[]).includes(name)) return null;
    return this.mergeKey(`${name as (typeof FAR_ASSET_NAMES)[number]}_far`);
  }

  private mergeKey(name: AssetKey): MergedAsset | null {
    const cached = this.merged.get(name);
    if (cached) return cached;
    const src = this.scenes.get(name);
    // A lazy LOD0 armed for release may already hold empty arrays: no merge.
    if (!src || this.cpuReleased.has(name) || this.lazyCpuArmed.has(name)) return null;

    const geoms: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const base = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const meshMats = Array.isArray(o.material) ? o.material : [o.material];
        if (base.groups.length > 1) {
          // split multi-material geometry into per-material chunks
          for (const g of base.groups) {
            const sub = subGeometry(base, g.start, g.count);
            geoms.push(sub);
            mats.push(meshMats[g.materialIndex ?? 0]);
          }
          base.dispose();
        } else {
          base.clearGroups();
          geoms.push(base);
          mats.push(meshMats[0]);
        }
      }
    });
    if (geoms.length === 0) return null;

    // group chunks by material so the final geometry has one group per material
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    geoms.forEach((g, i) => {
      const list = byMat.get(mats[i]) ?? [];
      list.push(g);
      byMat.set(mats[i], list);
    });

    const orderedMats: THREE.Material[] = [];
    const orderedGeoms: THREE.BufferGeometry[] = [];
    for (const [m, list] of byMat) {
      orderedMats.push(m);
      orderedGeoms.push(mergeGeoms(list));
    }
    const finalGeom = mergeGeoms(orderedGeoms, true);
    // ONE GROUP IS ONE DRAW CALL. three submits a mesh once per group whenever
    // the material is an ARRAY, so an asset with twelve flat colours was twelve
    // calls per InstancedMesh — `props-palm_a` was five on every island that has
    // palms. Bake the colour and the surface into vertex attributes and the
    // array becomes one material, which three submits once. Same pixels: see
    // `AssetMaterialCollapse.ts` for the term-for-term argument and for the four
    // traps this is written around. If the materials differ in anything an
    // attribute cannot carry — a texture, a transparency, a side — `collapse`
    // returns null and the array survives untouched.
    const chunks = finalGeom.groups.map((g) => ({
      start: g.start,
      count: g.count,
      material: orderedMats[g.materialIndex ?? 0],
    }));
    const collapsed = collapseChunks(finalGeom, chunks);
    const result: MergedAsset = collapsed
      ? { geometry: finalGeom, material: collapsed }
      : { geometry: finalGeom, material: orderedMats.length === 1 ? orderedMats[0] : orderedMats };
    this.sharedResources.add(finalGeom);
    trackUpload(finalGeom);
    for (const m of orderedMats) this.sharedResources.add(m);
    if (collapsed) this.sharedResources.add(collapsed);
    this.merged.set(name, result);
    return result;
  }
}

/**
 * WHAT A MISSING ATTRIBUTE READS, per attribute name.
 *
 * The merge below is ALL-OR-IDENTITY: if ANY source mesh of an asset carries an
 * attribute, EVERY vertex of the merged buffer gets one, because a buffer with a
 * hole in it is not a buffer three can draw. The value used for the vertices
 * that never had one has to be the boring answer for that channel — the same
 * argument `AssetMaterialCollapse` trap 1 makes about `aSurface`/`aTintComp`,
 * generalised: a missing `color` is WHITE (no AO), a missing `normal` is up, a
 * missing `uv` is the atlas origin, a missing `tangent` is +X with a positive
 * handedness. Anything unknown gets zeros, which is what WebGL would have given
 * the shader anyway.
 */
const ATTRIBUTE_IDENTITY: Readonly<Record<string, readonly number[]>> = {
  normal: [0, 1, 0],
  color: [1, 1, 1],
  tangent: [1, 0, 0, 1],
  uv: [0, 0],
  uv1: [0, 0],
  uv2: [0, 0],
  uv3: [0, 0],
  skinWeight: [1, 0, 0, 0],
};

function identityFor(name: string, itemSize: number): readonly number[] {
  const known = ATTRIBUTE_IDENTITY[name];
  if (known && known.length === itemSize) return known;
  return new Array<number>(itemSize).fill(0);
}

type ReadableAttribute = {
  readonly itemSize: number;
  readonly count: number;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
  getW(i: number): number;
};

/** Component read that works for a plain BufferAttribute AND for the
 *  InterleavedBufferAttribute a glTF with interleaved accessors hands back, and
 *  that denormalises u8/u16 storage on the way out (three r152+). */
function readComponent(attr: ReadableAttribute, i: number, c: number): number {
  switch (c) {
    case 0: return attr.getX(i);
    case 1: return attr.getY(i);
    case 2: return attr.getZ(i);
    case 3: return attr.getW(i);
    default: return 0;
  }
}

/**
 * Extract an index-range slice of a geometry as a standalone geometry.
 *
 * EVERY attribute travels, not a hand-listed three. The list used to be
 * position/normal/color, which is why `crow_roost` — the one GLB the Blender
 * pipeline exports with `TEXCOORD_0` — arrived in the instanced buffer with no
 * UVs and no warning (assets-05). Any texture pass is dead on arrival while a
 * channel can vanish here, so the rule is now structural: read what the source
 * has, whatever it is called.
 */
function subGeometry(geom: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const index = geom.getIndex();
  const names = Object.keys(geom.attributes);
  const sources = names.map((n) => geom.getAttribute(n) as unknown as ReadableAttribute);
  const buffers = sources.map((a) => new Float32Array(count * a.itemSize));
  for (let w = 0; w < count; w++) {
    const vi = index ? index.getX(start + w) : start + w;
    for (let a = 0; a < sources.length; a++) {
      const attr = sources[a];
      const buf = buffers[a];
      const k = attr.itemSize;
      for (let c = 0; c < k; c++) buf[w * k + c] = readComponent(attr, vi, c);
    }
  }
  for (let a = 0; a < names.length; a++) {
    out.setAttribute(names[a], new THREE.Float32BufferAttribute(buffers[a], sources[a].itemSize));
  }
  return out;
}

/**
 * Non-indexed geometry merge over the UNION of the sources' attributes,
 * optionally keeping groups.
 *
 * ALL-OR-IDENTITY (see `ATTRIBUTE_IDENTITY`): the union decides the merged
 * buffer's channels, and a source that lacks one of them contributes that
 * channel's identity rather than dropping it for everyone. `normal` is forced
 * into the union whether or not anything authored one, because every material
 * this library produces is lit.
 */
function mergeGeoms(geoms: THREE.BufferGeometry[], withGroups = false): THREE.BufferGeometry {
  if (geoms.length === 1 && !withGroups) return geoms[0];
  const out = new THREE.BufferGeometry();
  const sources = geoms.map((g) => (g.getIndex() ? g.toNonIndexed() : g));

  const order: string[] = ['position', 'normal'];
  const sizes = new Map<string, number>([['position', 3], ['normal', 3]]);
  for (const src of sources) {
    for (const name of Object.keys(src.attributes)) {
      if (sizes.has(name)) continue;
      sizes.set(name, (src.getAttribute(name) as THREE.BufferAttribute).itemSize);
      order.push(name);
    }
  }

  let total = 0;
  for (const src of sources) total += (src.getAttribute('position') as THREE.BufferAttribute).count;
  const buffers = new Map<string, Float32Array>();
  for (const name of order) buffers.set(name, new Float32Array(total * sizes.get(name)!));

  let offset = 0;
  sources.forEach((src, gi) => {
    const n = (src.getAttribute('position') as THREE.BufferAttribute).count;
    for (const name of order) {
      const k = sizes.get(name)!;
      const buf = buffers.get(name)!;
      const attr = src.getAttribute(name) as unknown as ReadableAttribute | undefined;
      const ident = identityFor(name, k);
      for (let i = 0; i < n; i++) {
        const base = (offset + i) * k;
        for (let c = 0; c < k; c++) {
          buf[base + c] = attr && c < attr.itemSize ? readComponent(attr, i, c) : ident[c];
        }
      }
    }
    if (withGroups) out.addGroup(offset, n, gi);
    offset += n;
  });

  for (const name of order) {
    out.setAttribute(name, new THREE.Float32BufferAttribute(buffers.get(name)!, sizes.get(name)!));
  }
  for (let i = 0; i < sources.length; i++) {
    if (sources[i] !== geoms[i]) sources[i].dispose();
  }
  return out;
}

/** Singleton — preloaded during the boot/loading screen. */
export const assets = new AssetLibrary();
