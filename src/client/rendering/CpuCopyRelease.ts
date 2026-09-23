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

/** b1-ask-04: after a WebGL context loss a released attribute re-uploads
 *  empty, so this session stops releasing (islands built from now on keep
 *  their CPU copy and survive the next loss). Called by Renderer on
 *  webglcontextlost. Islands released BEFORE the loss still need a rebuild. */
export function disableCpuCopyReleaseAfterContextLoss(): void {
  enabled = false;
}

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

// ─── library templates (AssetLibrary.releaseCpuCopies) ──────────────────────────────────────────────
//
// The same drop, applied to the AssetLibrary's own template and merged geometry
// once a match's islands are built. A library geometry is shared by every clone,
// so it may be uploaded long before or long after the release; the tracker below
// records WHEN it was uploaded (armed at load, so the flag is honest), and the
// release then either drops at once (already on the GPU), arms the drop for the
// upload (not drawn yet but in the scene or clonable), or drops outright with no
// GPU copy (`dead`: nothing draws it and the library stops serving it).

const UPLOADED_KEY = '__gpuUploaded';
const DROP_ARMED_KEY = '__cpuDropArmed';
type Tracked = Releasable & { [UPLOADED_KEY]?: boolean; [DROP_ARMED_KEY]?: boolean };

function markUploaded(this: THREE.BufferAttribute): void {
  const attr = this as Tracked;
  attr[UPLOADED_KEY] = true;
  if (attr[DROP_ARMED_KEY]) dropAfterUpload.call(attr);
}

function geometryAttributes(g: THREE.BufferGeometry): (THREE.BufferAttribute | null)[] {
  return [g.index, ...(Object.values(g.attributes) as THREE.BufferAttribute[])];
}

/** Record every later upload of `g`'s attributes. Call once, at load/merge time. */
export function trackUpload(g: THREE.BufferGeometry): void {
  for (const a of geometryAttributes(g)) if (a && releasable(a)) a.onUpload(markUploaded);
}

/** True when every attribute of `g` has reached the GPU at least once. */
export function geometryUploaded(g: THREE.BufferGeometry): boolean {
  return geometryAttributes(g).every((a) => a === null || (a as Tracked)[UPLOADED_KEY] === true);
}

/**
 * Release `g`'s CPU copies. `dead` drops them now whatever the GPU state (the
 * caller guarantees nothing draws or reads it again); otherwise an uploaded
 * attribute drops now and a pending one drops inside its upload. Bounds are
 * computed first. Returns the CPU bytes released or armed; 0 when the geometry
 * is not eligible (interleaved, dynamic, morph targets).
 */
export function releaseGeometryCpu(g: THREE.BufferGeometry, dead: boolean): number {
  const attrs = geometryAttributes(g);
  if (Object.keys(g.morphAttributes).length > 0 || g.userData.keepCpu) return 0;
  if (!attrs.every((a) => a === null || releasable(a))) return 0;
  if (!g.boundingBox) g.computeBoundingBox();
  if (!g.boundingSphere) g.computeBoundingSphere();
  let bytes = 0;
  for (const a of attrs) {
    const attr = a as Tracked | null;
    if (!attr || attr[RELEASED_KEY] !== undefined) continue;
    bytes += attr.array.byteLength;
    if (dead && !attr[UPLOADED_KEY]) {
      const arr = attr.array as unknown as { constructor: new (n: number) => THREE.TypedArray };
      attr[RELEASED_KEY] = 0; // never on the GPU: nothing to count anywhere
      attr.array = new arr.constructor(0);
    } else if (attr[UPLOADED_KEY]) {
      dropAfterUpload.call(attr);
    } else {
      attr[DROP_ARMED_KEY] = true;
    }
  }
  armedBytes += bytes;
  return bytes;
}
