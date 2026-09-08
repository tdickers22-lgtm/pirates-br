import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { auditAssetMaterial } from './materialAudit.js';
import { collapseChunks } from './AssetMaterialCollapse.js';

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
] as const satisfies readonly AssetName[];

const BOOT_ASSET_SET: ReadonlySet<string> = new Set<string>(BOOT_ASSET_NAMES);

/** The 53 the world build needs and the menu does not. */
export const WORLD_ASSET_NAMES: readonly AssetName[] =
  ASSET_NAMES.filter((n) => !BOOT_ASSET_SET.has(n));

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
] as const satisfies readonly AssetName[];
type FarKey = `${(typeof FAR_ASSET_NAMES)[number]}_far`;
type AssetKey = AssetName | FarKey;

export interface MergedAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

export class AssetLibrary {
  private scenes = new Map<AssetKey, THREE.Group>();
  private merged = new Map<AssetKey, MergedAsset>();
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
  private readonly loader = new GLTFLoader();
  private done = 0;

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

  /** True once every GLB is in and `clone()` can be trusted for any name. */
  get isFullyLoaded(): boolean {
    return this.loaded;
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
    const loader = this.loader;
    const loadOne = async (name: AssetName, key: AssetKey) => {
        const gltf = await loader.loadAsync(`/assets/models/${key}.glb`);
        const root = gltf.scene;
        root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            if (o.name) this.assetNodeNames.add(o.name);
            this.sharedResources.add(o.geometry);
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              this.sharedResources.add(m);
              // Register texture slots too — material clones (cloneTinted) share
              // texture references, so per-clone disposal must skip them.
              const record = m as unknown as Record<string, unknown>;
              for (const key of Object.keys(record)) {
                const value = record[key] as { isTexture?: boolean } | null;
                if (value && value.isTexture) this.sharedResources.add(value);
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
    };
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
    if (!src) return null;
    return src.clone(true);
  }

  /** A clone of the decimated far sibling (`<name>_far.glb`), or null when the
   *  asset has none — callers then simply keep the near clone at every distance. */
  cloneFar(name: AssetName): THREE.Group | null {
    if (!(FAR_ASSET_NAMES as readonly string[]).includes(name)) return null;
    const src = this.scenes.get(`${name as (typeof FAR_ASSET_NAMES)[number]}_far`);
    if (!src) return null;
    return src.clone(true);
  }

  /**
   * Clone with all materials duplicated, then tint materials whose name
   * matches `matchMat` (e.g. 'TeamTint') to the given color.
   */
  cloneTinted(name: AssetName, matchMat: string, color: THREE.ColorRepresentation): THREE.Group | null {
    const root = this.clone(name);
    if (!root) return null;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = mats.map((m) => {
          if (m.name === matchMat && m instanceof THREE.MeshStandardMaterial) {
            const c = m.clone();
            c.color.set(color);
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
    if (!src) return null;

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
