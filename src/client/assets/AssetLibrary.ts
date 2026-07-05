import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
  'palm_a', 'palm_b', 'palm_c',
  'boulder_a', 'boulder_b', 'boulder_c',
  'searock_a', 'searock_b', 'searock_c',
  'barrel', 'keg', 'chest_closed', 'chest_open', 'crate', 'campfire',
  'dock_mid', 'dock_end',
  'watchtower', 'shipwreck', 'standing_stones', 'lantern_post',
  'tent_a', 'bedroll', 'rock_arch',
  'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers',
] as const;

export type AssetName = (typeof ASSET_NAMES)[number];

export interface MergedAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

export class AssetLibrary {
  private scenes = new Map<AssetName, THREE.Group>();
  private merged = new Map<AssetName, MergedAsset>();
  private boundsCache = new Map<AssetName, THREE.Box3>();
  /** Geometries/materials owned by the library (shared across clones) — must never be disposed by callers. */
  private sharedResources = new WeakSet<object>();
  private loaded = false;

  /** Loads every GLB in parallel. Failures are logged and tolerated:
   *  callers get `null` from clone() and should keep their procedural fallback. */
  async preload(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.loaded) return;
    const loader = new GLTFLoader();
    let done = 0;
    await Promise.all(ASSET_NAMES.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(`/assets/models/${name}.glb`);
        const root = gltf.scene;
        root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
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
                // authored for lit scenes; keep flat-shaded stylized look
                m.flatShading = true;
                m.needsUpdate = true;
              }
            }
          }
        });
        this.scenes.set(name, root);
      } catch (err) {
        console.warn(`[assets] failed to load ${name}.glb — procedural fallback stays`, err);
      } finally {
        done += 1;
        onProgress?.(done, ASSET_NAMES.length);
      }
    }));
    this.loaded = true;
  }

  has(name: AssetName): boolean {
    return this.scenes.has(name);
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
    const result: MergedAsset = {
      geometry: finalGeom,
      material: orderedMats.length === 1 ? orderedMats[0] : orderedMats,
    };
    this.sharedResources.add(finalGeom);
    for (const m of orderedMats) this.sharedResources.add(m);
    this.merged.set(name, result);
    return result;
  }
}

/** Extract an index-range slice of a geometry as a standalone geometry. */
function subGeometry(geom: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const index = geom.getIndex();
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const normal = geom.getAttribute('normal') as THREE.BufferAttribute | null;

  const positions: number[] = [];
  const normals: number[] = [];
  const readVertex = (vi: number) => {
    positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
    if (normal) normals.push(normal.getX(vi), normal.getY(vi), normal.getZ(vi));
  };
  if (index) {
    for (let i = start; i < start + count; i++) readVertex(index.getX(i));
  } else {
    for (let i = start; i < start + count; i++) readVertex(i);
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normal) out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

/** Minimal non-indexed geometry merge (positions + normals), optionally keeping groups. */
function mergeGeoms(geoms: THREE.BufferGeometry[], withGroups = false): THREE.BufferGeometry {
  if (geoms.length === 1 && !withGroups) return geoms[0];
  const out = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  let offset = 0;
  geoms.forEach((g, gi) => {
    const src = g.getIndex() ? g.toNonIndexed() : g;
    const pos = src.getAttribute('position') as THREE.BufferAttribute;
    const nor = src.getAttribute('normal') as THREE.BufferAttribute | null;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      else normals.push(0, 1, 0);
    }
    if (withGroups) {
      out.addGroup(offset, pos.count, gi);
      offset += pos.count;
    }
    if (src !== g) src.dispose();
  });
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

/** Singleton — preloaded during the boot/loading screen. */
export const assets = new AssetLibrary();
