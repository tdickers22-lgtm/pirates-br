import * as THREE from 'three';
import { storyPhoneProfile } from '../assets/AssetLibrary.js';

/**
 * CPU-COPY RELEASE for render-only geometry (b3.1b, moved forward into b1.7b).
 *
 * three.js keeps every BufferAttribute's typed array after it has been uploaded
 * to the GPU. On a phone that copy is pure cost: WebKit counts it against the
 * tab, and an iPhone kills a tab that holds too much and reloads it mid-match.
 * The memory census measured 53 MB of it in the island static batches alone
 * (test-memory-budget, phone profile, 2026-09-23).
 *
 * WHAT IS RELEASED. Only geometry that nothing reads after its first upload:
 *  - the static batches StaticBatcher builds at island build time (`*-batch`
 *    meshes): fresh merged clones, one mesh each, never animated, never re-merged
 *    (the batcher runs once per island, before the island is ever drawn);
 *  - never library-owned geometry (`isShared`): the AssetLibrary clones and
 *    merges its templates on demand, so their arrays must stay;
 *  - never Points/Lines/Sprites/skinned meshes, never morph targets, never an
 *    attribute whose usage is not StaticDraw (a writer would write into nothing).
 *
 * HOW. The array is dropped from inside the attribute's `onUpload` callback, so
 * it only ever happens AFTER three has copied it to the GPU; an attribute that
 * was already uploaded before arming simply keeps its copy (a missed saving, never
 * a broken mesh). Bounds are computed first so frustum culling never needs the
 * vertices again. The array is replaced by an empty one of the same type rather
 * than null: a context restore then re-uploads an empty buffer (the mesh vanishes
 * until reload) instead of throwing inside the render loop.
 *
 * WHERE. Phone/iPad profile only (storyPhoneProfile) — desktops have the memory,
 * and desktop audits read batch vertices. `?cpurelease=1` forces it on, `=0` off.
 */

const RELEASED_KEY = '__cpuReleasedBytes';
const BATCH_NAME = /-batch\d*$/;

type Releasable = THREE.BufferAttribute & { [RELEASED_KEY]?: number };

let enabled: boolean | null = null;
let armedBytes = 0;
let releasedBytes = 0;

export function cpuCopyReleaseEnabled(): boolean {
  if (enabled !== null) return enabled;
  let forced: string | null = null;
  try { forced = new URLSearchParams(globalThis.location?.search ?? '').get('cpurelease'); } catch { forced = null; }
  enabled = forced === '1' ? true : forced === '0' ? false : storyPhoneProfile();
  return enabled;
}

/** Bytes a released attribute still occupies on the GPU (the census counts them as GPU, not heap). */
export function releasedGpuBytes(a: unknown): number | undefined {
  return (a as Releasable | null)?.[RELEASED_KEY];
}

function dropAfterUpload(this: THREE.BufferAttribute): void {
  const attr = this as Releasable;
  const arr = attr.array as unknown as { byteLength: number; constructor: new (n: number) => THREE.TypedArray };
  if (!arr || attr[RELEASED_KEY] !== undefined) return;
  attr[RELEASED_KEY] = arr.byteLength;
  releasedBytes += arr.byteLength;
  attr.array = new arr.constructor(0);
}

function releasable(a: unknown): a is THREE.BufferAttribute {
  const attr = a as THREE.BufferAttribute & { isInterleavedBufferAttribute?: boolean };
  return !!attr && !attr.isInterleavedBufferAttribute && attr.usage === THREE.StaticDrawUsage && !!attr.array;
}

/**
 * Arm the release on every render-only static batch under `root`. Call it right
 * after the subtree is built and BEFORE its first draw. Returns the bytes armed.
 */
export function releaseRenderOnlyCpuCopies(root: THREE.Object3D, isShared: (o: object) => boolean): number {
  if (!cpuCopyReleaseEnabled()) return 0;
  let bytes = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh & { isSkinnedMesh?: boolean };
    if (!mesh.isMesh || mesh.isSkinnedMesh || !BATCH_NAME.test(mesh.name)) return;
    const g = mesh.geometry;
    if (!g || isShared(g) || g.userData.keepCpu || mesh.userData.keepCpu) return;
    if (Object.keys(g.morphAttributes).length > 0) return;
    const attrs = [g.index, ...Object.values(g.attributes)];
    if (!attrs.every((a) => a === null || releasable(a))) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingSphere) g.computeBoundingSphere();
    for (const a of attrs) {
      if (!a || (a as Releasable)[RELEASED_KEY] !== undefined) continue;
      a.onUpload(dropAfterUpload);
      bytes += a.array.byteLength;
    }
  });
  armedBytes += bytes;
  return bytes;
}

export function cpuCopyReleaseStats(): { enabled: boolean; armedBytes: number; releasedBytes: number } {
  return { enabled: cpuCopyReleaseEnabled(), armedBytes, releasedBytes };
}
