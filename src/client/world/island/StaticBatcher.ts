import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { assets } from '../../assets/AssetLibrary.js';
import { type CollapseChunk, collapseChunks, collapseFamilyKey } from '../../assets/AssetMaterialCollapse.js';

/**
 * ONE DRAW PER MATERIAL FAMILY, for scenery that never moves.
 *
 * IT WAS "ONE DRAW PER MATERIAL" UNTIL THE MATERIAL COUNT BECAME THE WALL. The
 * naming fix below took a pier from 38.2 draws to 16.0, and 16.0 is the number
 * of flat colours in `dock.glb` — the census's every remaining row was
 * SOLE-OF-MATERIAL, i.e. the batcher was exhausted with a sixteen-call pier
 * (cost model §12.3). Colour is not a reason two meshes cannot share a draw; it
 * is a thing a merge can CARRY. `AssetMaterialCollapse` bakes each part's
 * colour, roughness and metalness into vertex attributes, so meshes now bucket
 * by material FAMILY — the per-draw states an attribute cannot express — and a
 * pier is its family count, which is one.
 *
 * The budget census attributes a wide island vista to a handful of named
 * subsystems, and the ones it names are not the ones anyone would guess. A
 * single pier — `decor-dock` — is 49 to 67 draw calls: a plank at a time, a
 * bollard, a ladder rung at a time, a crab trap, drying nets. One rope bridge is
 * 150. A lookout is 24, a camp 19, a stone-idol cluster 18. Nothing in there is
 * animated and nothing in there is interactive; they are boxes and cylinders
 * bolted to an island that is itself frozen out of the per-frame matrix walk.
 * Five islands in view is a thousand draw calls of planking.
 *
 * The measured alternative to paying that was to stop DRAWING the far islands —
 * a distance gate, which buys the same number and takes the pier off the horizon
 * to do it. This buys it without taking anything off the screen: merge the
 * static sub-meshes of a piece by material, once, at build time. Same
 * silhouette, same colours, same shadows, at every distance including the one
 * the player is standing on. A pier that cost 49 calls costs four.
 *
 * WHAT IS NOT MERGED, and why the rule is conservative:
 *
 *   * anything with a NAME THIS CODEBASE WROTE. Every node it looks up later —
 *     the tavern's `door`, a `waterfall-site`, `dock-piling` for the floater
 *     audit, the FX nodes that push their own world matrix through
 *     refreshFrozenChild — is found by name. Merging one would leave the lookup
 *     holding a node that is no longer in the graph.
 *
 *     THE RULE USED TO BE "anything with a name", and it cost almost everything
 *     this pass was written to save: the census (scripts/perf-decor-census.mjs)
 *     puts a pier at 38.2 draws per copy of which **362 of 382 meshes are
 *     refused for being named**, and every one of those names — `dock_mid_deck`,
 *     `lantern_post_post_1`, `campfire_stone0_3`, `tent_c_pole_5` — is a
 *     Blender exporter's, written by glTF because glTF names every node, and
 *     read by nothing. `assets.isAssetNodeName` is what separates them: a name
 *     that arrived inside a GLB is anonymous unless this file says otherwise,
 *     and ADDRESSED_NAMES is the list of the ones it says otherwise about.
 *   * anything with CHILDREN. Merging a mesh means removing it, and a mesh with
 *     children is a joint as well as a surface.
 *   * anything with USERDATA — the marker this repo uses for "there is a system
 *     attached to this node".
 *   * instanced, skinned and morphed meshes, and multi-material meshes: an
 *     InstancedMesh is already one call, and the others carry per-mesh state a
 *     merge would flatten.
 *   * LIGHTS and every non-mesh node, which are left exactly where they are —
 *     the dock lanterns and the camp fire register themselves into these very
 *     groups.
 *
 * Geometry attribute sets have to match for a merge to be legal, so the bucket
 * key carries them; a group whose meshes disagree simply merges in subsets.
 * Shadow flags ride the key too, because they are per-mesh and a merge picks one.
 */

/**
 * EVERY NAME THIS REPO LOOKS A NODE UP BY — the one list that decides whether a
 * named mesh may be merged away.
 *
 * It is not a style guide and it is not aspirational: it is the set of string
 * literals that reach `getObjectByName` or an `o.name === '…'` test anywhere in
 * `src/` or `scripts/`, and `scripts/test-decor-batch.mjs` re-derives it from the
 * source on every run and FAILS when a literal appears that is not in here. That
 * is the whole safety argument. A name only has to be listed when a GLB also
 * carries it — an unnamed-in-GLB name can never be merged anyway — but listing
 * the lot costs nothing and means the gate does not need to know the difference.
 */
export const ADDRESSED_NAMES: ReadonlySet<string> = new Set([
  'bucket-water',
  'cave-portal-rock',
  'decor-camp',
  'door',
  'held-weapon',
  'hold-cargo',
  'island-grass',
  'island-terrain',
  'local-pocket',
  'local-view-weapon',
  'ocean-lod-grid',
  'own-pennant',
  'view-hand-right',
  'vm-eor-scope',
  'waterfall-site',
]);

/**
 * True when a mesh's name is one that has to survive the collapse.
 *
 * Unnamed → false, trivially. Named by a GLB and not addressed → false: the
 * exporter wrote it and nobody reads it. Named by anything else → true, because
 * a name this codebase wrote is, by its own convention, an address.
 */
export function isAddressedName(name: string): boolean {
  if (!name) return false;
  if (ADDRESSED_NAMES.has(name)) return true;
  return !assets.isAssetNodeName(name);
}

/**
 * Merge candidates are grouped by everything three needs to agree on.
 *
 * IT USED TO BE `material.uuid`, and that is what left the pass exhausted at
 * SOLE-OF-MATERIAL: after the naming fix every remaining decor draw was one
 * material's worth, and a pier still cost sixteen calls to say sixteen flat
 * colours (cost model §12.3). Colour is not something three needs two meshes to
 * agree on — it is something the merge can CARRY, in a vertex attribute, exactly
 * as `mergedGeometry` now carries it for the instanced props. So a collapsible
 * material contributes its FAMILY (side, flat shading, blending — the per-draw
 * states an attribute cannot express) instead of its identity, and sixteen
 * buckets become one. A material that must keep its identity — textured,
 * emissive, or carrying somebody's `onBeforeCompile` — returns no family key and
 * falls back to the uuid, which is the old behaviour exactly.
 */
function bucketKey(mesh: THREE.Mesh, material: THREE.Material): string {
  const attributes = Object.keys(mesh.geometry.attributes).sort().join(',');
  return `${collapseFamilyKey(material) ?? material.uuid}|${attributes}|${mesh.geometry.index ? 'i' : '-'}`
    + `|${mesh.castShadow ? 'C' : '-'}${mesh.receiveShadow ? 'R' : '-'}`;
}

function isMergeable(node: THREE.Object3D): node is THREE.Mesh {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh) return false;
  if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return false;
  if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return false;
  if (isAddressedName(mesh.name)) return false;
  if (mesh.children.length > 0) return false;
  if (!mesh.visible) return false;
  if (Array.isArray(mesh.material)) return false;
  if (!mesh.geometry || !mesh.geometry.attributes.position) return false;
  if (mesh.geometry.morphAttributes && Object.keys(mesh.geometry.morphAttributes).length > 0) return false;
  if (mesh.userData && Object.keys(mesh.userData).length > 0) return false;
  return true;
}

type Candidate = { mesh: THREE.Mesh; matrix: THREE.Matrix4 };

/**
 * Collapse the static, unnamed sub-meshes of `root` into one mesh per material.
 *
 * Safe to call on anything: a group with nothing to merge is left untouched.
 * Call it BEFORE the subtree is frozen or reparented — it reads local
 * transforms and composes them itself rather than trusting a world matrix that
 * may not have been walked yet.
 *
 * @returns how many draw calls the collapse removed (0 when nothing merged).
 */
export function collapseStaticMeshes(root: THREE.Object3D): number {
  const buckets = new Map<string, { material: THREE.Material; parts: Candidate[] }>();

  // The batch is added to `root`, so every part's geometry has to be baked into
  // ROOT-LOCAL space — root's own transform must NOT be composed in, or the
  // batch is transformed by it twice. The walk therefore starts at root's
  // children with identity.
  const walk = (node: THREE.Object3D, parentMatrix: THREE.Matrix4) => {
    node.updateMatrix();
    const matrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, node.matrix);
    if (isMergeable(node)) {
      const material = node.material as THREE.Material;
      const key = bucketKey(node, material);
      const bucket = buckets.get(key) ?? { material, parts: [] };
      bucket.parts.push({ mesh: node, matrix });
      buckets.set(key, bucket);
      return; // a mergeable mesh has no children by definition
    }
    for (const child of [...node.children]) walk(child, matrix);
  };
  for (const child of [...root.children]) walk(child, new THREE.Matrix4());

  let saved = 0;
  let batch = 0;
  for (const bucket of buckets.values()) {
    // One mesh is already one call; merging it would only churn its buffers.
    if (bucket.parts.length < 2) continue;
    const geometries: THREE.BufferGeometry[] = [];
    // Where each part's vertices land in the merged buffer. mergeGeometries
    // concatenates in order and rewrites the indices, so a part's range is the
    // running sum of POSITION counts — true whether or not the parts are
    // indexed, which is what the bake below indexes by.
    const chunks: CollapseChunk[] = [];
    let vertexOffset = 0;
    for (const part of bucket.parts) {
      const geometry = part.mesh.geometry.clone();
      geometry.applyMatrix4(part.matrix);
      const count = geometry.getAttribute('position').count;
      chunks.push({ start: vertexOffset, count, material: part.mesh.material as THREE.Material });
      vertexOffset += count;
      geometries.push(geometry);
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    // mergeGeometries returns null when the set is not actually compatible —
    // leave those meshes exactly as they were rather than dropping them.
    if (!merged) continue;

    // ONE MATERIAL, OR THE ONE THEY ALREADY SHARED. A bucket keyed by family can
    // hold several materials, and then the colour and the surface have to move
    // into the vertex buffer before the merge is legal. A bucket whose parts all
    // point at the SAME material needs none of that — skip the bake rather than
    // pay 20 bytes a vertex to say the same number over and over.
    const distinct = new Set(bucket.parts.map((p) => p.mesh.material as THREE.Material));
    let material: THREE.Material | null = distinct.size === 1 ? bucket.material : null;
    if (!material) {
      material = collapseChunks(merged, chunks);
      // Refusing here means the family key promised something collapseChunks
      // will not honour. Drop the merge rather than draw the whole batch in the
      // first part's colour.
      if (!material) { merged.dispose(); continue; }
    }

    const sample = bucket.parts[0].mesh;
    const batched = new THREE.Mesh(merged, material);
    // Named after the piece it belongs to, never after a node anyone looks up.
    // The floater audit rolls a piece's whole subtree into one bounding box, so
    // a batch inside the piece reads to it exactly as the parts did.
    batched.name = `${root.name || 'static'}-batch${batch === 0 ? '' : batch}`;
    batch += 1;
    batched.castShadow = sample.castShadow;
    batched.receiveShadow = sample.receiveShadow;
    batched.renderOrder = sample.renderOrder;
    batched.frustumCulled = sample.frustumCulled;

    // Detach, but do NOT dispose: island builders share unit geometries across
    // pieces on purpose — one `boulderGeo` seats the cairn stones, the tidepool
    // rocks AND the interior-stone InstancedMesh, and one `bambooGeo` every
    // stalk. Disposing here frees the GL buffers of whichever meshes were still
    // using it, and the survivors then re-upload on their next draw — a hitch
    // manufactured by the very pass that exists to remove them. The merged copy
    // is a clone; the originals go out of scope with the pieces that held them.
    for (const part of bucket.parts) part.mesh.removeFromParent();
    root.add(batched);
    saved += bucket.parts.length - 1;
  }
  return saved;
}

/**
 * Collapse every static piece under an island group.
 *
 * Applied per PIECE rather than to the island as a whole, on purpose: a batch
 * spanning two pieces would span their bounding boxes too, and both the frustum
 * cull and the floater audit reason about a piece at a time. A dock merged into
 * a dock is four calls; a dock merged into a cairn on the far headland is one
 * call that is never off screen and one audit row nobody can read.
 *
 * @returns total draw calls removed, for the build-time log line.
 */
export function collapseIslandDecor(group: THREE.Object3D): number {
  let saved = 0;
  for (const child of [...group.children]) {
    // Meshes are already a single call, and the tiers (detail/micro/proxy) are
    // assembled after this runs, so every child here is one placed piece.
    if ((child as THREE.Mesh).isMesh) continue;
    saved += collapseStaticMeshes(child);
  }
  return saved;
}
