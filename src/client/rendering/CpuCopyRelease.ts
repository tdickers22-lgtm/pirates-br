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
  pending.clear();
}

// ─── eager upload (b1-ask-05, OD2) ─────────────────────────────────────────────
//
// A drop armed for "inside the upload" never happens for geometry nothing draws:
// the batches of an island the player never looks at, a story LOD0 behind the
// camera. The phone census found 20-55 MB of such armed-but-never-uploaded
// copies after a 60 s tour (more the less the tour saw), all of it counted as
// GPU-resident by the budget already. So armed geometry is queued here and
// uploaded ahead of its first draw, a byte budget per frame, which is what fires
// the drop. The upload goes through three's own path: a throwaway mesh with an
// INVISIBLE material in a private scene. WebGLRenderer.projectObject calls
// objects.update(object) (every non-index attribute -> gl.bufferData ->
// onUpload) BEFORE it checks material.visible. The index buffer only uploads
// inside renderBufferDirect (WebGLBindingStates.setup), and the phone census
// found story LOD0 and batch indices still held after the vertex arrays had
// gone (b1-ask-05). So the pass material is VISIBLE but writes nothing
// (colorWrite/depthWrite/depthTest off), and each geometry's drawRange count is
// 0 for the pass: renderBufferDirect returns only on drawCount < 0, so setup
// runs (index uploaded, its drop fires) and the draw rasterises 0 indices. One
// cheap MeshBasicMaterial program serves the whole pass; drawRange is restored.

const pending = new Set<THREE.BufferGeometry>();

function onPendingDispose(event: { target: THREE.BufferGeometry }): void {
  pending.delete(event.target);
  event.target.removeEventListener('dispose', onPendingDispose);
}

function queueUpload(g: THREE.BufferGeometry): void {
  if (pending.has(g)) return;
  pending.add(g);
  g.addEventListener('dispose', onPendingDispose);
}

function unreleasedAttributeBytes(g: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const a of [g.index, ...Object.values(g.attributes)]) {
    const attr = a as Releasable | null;
    if (!attr) continue;
    if (attr[RELEASED_KEY] === undefined && attr.array?.byteLength) bytes += attr.array.byteLength;
  }
  return bytes;
}

let upScene: THREE.Scene | null = null;
let upCamera: THREE.Camera | null = null;
let upMaterial: THREE.MeshBasicMaterial | null = null;

/** Armed geometries still waiting for their first upload. */
export function pendingUploadCount(): number {
  return pending.size;
}

/**
 * Upload up to `maxBytes` of queued armed geometry now (at least one geometry
 * when any is queued), so its CPU copy drops. Call once per frame OUTSIDE any
 * other render (before the frame's own render). Returns the bytes handed to GL.
 */
export function uploadPendingCpuCopies(renderer: THREE.WebGLRenderer, maxBytes: number): number {
  if (pending.size === 0) return 0;
  if (!upScene || !upCamera || !upMaterial) {
    upScene = new THREE.Scene();
    upScene.matrixWorldAutoUpdate = false;
    upCamera = new THREE.Camera();
    upMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, fog: false });
    upMaterial.name = 'cpu-copy-upload-pass';
  }
  const batch: THREE.Mesh[] = [];
  const ranges: [THREE.BufferGeometry, number, number][] = [];
  let bytes = 0;
  for (const g of pending) {
    if (bytes >= maxBytes) break;
    pending.delete(g);
    g.removeEventListener('dispose', onPendingDispose);
    const b = unreleasedAttributeBytes(g);
    if (b === 0) continue;
    ranges.push([g, g.drawRange.start, g.drawRange.count]);
    g.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(g, upMaterial);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    batch.push(mesh);
    upScene.add(mesh);
    bytes += b;
  }
  if (batch.length === 0) return 0;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    renderer.render(upScene, upCamera);
  } finally {
    renderer.autoClear = autoClear;
    for (const mesh of batch) upScene.remove(mesh);
    for (const [g, start, count] of ranges) g.setDrawRange(start, count);
  }
  return bytes;
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
    queueUpload(g);
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
      queueUpload(g);
    }
  }
  armedBytes += bytes;
  return bytes;
}
