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
 * than null, so a draw between a context restore and the rebuild below uploads
 * an empty buffer instead of throwing inside the render loop.
 *
 * CONTEXT LOSS (b1-ask-04). A lost context takes the GPU copy with it, and a
 * released attribute has no CPU copy left to re-upload, so every island batch
 * and every released library template would draw nothing for the rest of the
 * match. So the drop first parks the bytes in a Blob (off the JS heap: WebKit
 * keeps blob data in the network process, Chromium in the browser process, so
 * neither the tab's heap nor the jetsam footprint pays for it), and
 * `restoreReleasedCpuCopies()` (Renderer, on webglcontextrestored) reads every
 * backup back, gives the attributes their arrays, disposes the geometry's GL
 * buffers (the empty ones a draw made on the new context: three's buffer update
 * is a bufferSubData that cannot grow them) and re-queues the geometry for the
 * eager pass, which drops the arrays again after the fresh upload. Release stays
 * on after a loss; a second loss restores the same way.
 *
 * WHERE. Phone/iPad profile only (storyPhoneProfile) — desktops have the memory,
 * and desktop audits read batch vertices. `?cpurelease=1` forces it on, `=0` off.
 */

const RELEASED_KEY = '__cpuReleasedBytes';
const BATCH_NAME = /-batch\d*$/;

type Releasable = THREE.BufferAttribute & { [RELEASED_KEY]?: number; __cpuBackup?: Blob };

let enabled: boolean | null = null;
let armedBytes = 0;
let releasedBytes = 0;
/** Eager-pass bookkeeping for the census: frames it ran, bytes it handed to GL. */
let eagerPasses = 0;
let eagerBytes = 0;

const BACKUP_KEY = '__cpuBackup';

/** Geometries holding at least one released attribute with a backup (restore set). */
const releasedGeoms = new Set<THREE.BufferGeometry>();
/** Attribute -> geometry, recorded when the drop is armed (the upload callback only sees the attribute). */
const ownerOf = new WeakMap<THREE.BufferAttribute, THREE.BufferGeometry>();
/** True while the restore itself disposes GL buffers (not a real disposal). */
let resettingGpu = false;
let restoreJob: Promise<number> | null = null;
let restoresPending = 0;
let restoredGeoms = 0;
let restoredBytes = 0;

function onReleasedDispose(event: { target: THREE.BufferGeometry }): void {
  if (resettingGpu) return;
  const g = event.target;
  releasedGeoms.delete(g);
  g.removeEventListener('dispose', onReleasedDispose);
  for (const a of geometryAttributes(g)) if (a) delete (a as Releasable)[BACKUP_KEY];
}

function noteOwner(a: THREE.BufferAttribute | null, g: THREE.BufferGeometry): void {
  if (a) ownerOf.set(a, g);
}

/** Park the bytes off the JS heap before the drop; reuse the backup of a re-drop. */
function backUp(attr: Releasable): void {
  if (attr[BACKUP_KEY] || typeof Blob !== 'function') return;
  const g = ownerOf.get(attr);
  if (!g) return;
  attr[BACKUP_KEY] = new Blob([attr.array as unknown as BlobPart]);
  if (!releasedGeoms.has(g)) {
    releasedGeoms.add(g);
    g.addEventListener('dispose', onReleasedDispose);
  }
}

/** True while a context-restore rebuild is still reading backups (Renderer holds its pill). */
export function cpuCopyRestorePending(): boolean {
  return restoresPending > 0;
}

async function restoreAll(): Promise<number> {
  let bytes = 0;
  for (const g of [...releasedGeoms]) {
    if (!releasedGeoms.has(g)) continue; // disposed while an earlier geometry was reading
    const attrs = geometryAttributes(g).filter((a): a is THREE.BufferAttribute =>
      !!a && !!(a as Releasable)[RELEASED_KEY] && !!(a as Releasable)[BACKUP_KEY]);
    if (attrs.length === 0) continue;
    let bufs: ArrayBuffer[];
    try {
      bufs = await Promise.all(attrs.map((a) => ((a as Releasable)[BACKUP_KEY] as Blob).arrayBuffer()));
    } catch (err) {
      console.warn('[cpu-release] backup read failed; this mesh stays empty until the next match', err);
      continue;
    }
    if (!releasedGeoms.has(g)) continue;
    // Synchronous from here: every array of g is back before any draw can upload it.
    attrs.forEach((a, i) => {
      const attr = a as Tracked;
      const Ctor = (attr.array as unknown as { constructor: new (b: ArrayBuffer) => THREE.TypedArray }).constructor;
      attr.array = new Ctor(bufs[i]);
      releasedBytes -= attr[RELEASED_KEY] ?? 0;
      delete attr[RELEASED_KEY];
      // Drop again after the fresh upload (same backup, no second copy).
      attr[UPLOADED_KEY] = false;
      attr[DROP_ARMED_KEY] = true;
      attr.onUpload(markUploaded);
      bytes += attr.array.byteLength;
    });
    resettingGpu = true;
    try { g.dispose(); } finally { resettingGpu = false; }
    queueUpload(g);
    restoredGeoms += 1;
  }
  restoredBytes += bytes;
  return bytes;
}

/**
 * Give every released attribute its array back after a WebGL context restore
 * (see CONTEXT LOSS above). Runs are chained, so a loss during a restore just
 * queues another pass. Resolves with the CPU bytes restored by this pass.
 */
export function restoreReleasedCpuCopies(): Promise<number> {
  restoresPending += 1;
  const job = (restoreJob ?? Promise.resolve(0)).catch(() => 0).then(restoreAll);
  restoreJob = job;
  void job.finally(() => { restoresPending -= 1; if (restoreJob === job) restoreJob = null; }).catch(() => undefined);
  return job;
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
// onUpload) BEFORE it checks material.visible, so nothing is drawn, no program
// is linked, no draw call is counted. The index buffer only uploads inside a
// real draw (WebGLBindingStates), so it keeps its armed drop until then.

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
  for (const a of Object.values(g.attributes)) {
    const attr = a as Releasable;
    if (attr[RELEASED_KEY] === undefined && attr.array?.byteLength) bytes += attr.array.byteLength;
  }
  return bytes;
}

let upScene: THREE.Scene | null = null;
let upCamera: THREE.Camera | null = null;
let upMaterial: THREE.MeshBasicMaterial | null = null;

/** Eager-pass throughput: 1 MB per 60 Hz frame, i.e. a constant ~60 MB/s. */
const EAGER_BYTES_PER_MS = 1_000_000 / (1000 / 60);
const EAGER_MIN_BYTES = 1_000_000;
const EAGER_MAX_BYTES = 8_000_000;

/**
 * Bytes the eager pass may hand to GL this frame, from the rendered interval.
 * A per-FRAME budget left the queue full on a slow device (phone census run 5,
 * 2026-09-23: 44 of 94 MB armed never drained in a 60 s tour at a few fps, heap
 * 121 MB; the same tree drained it and read 108 MB when the frames came faster),
 * so the budget is per unit of TIME: a device at 20 fps uploads 3 MB a frame,
 * one at 60 fps 1 MB, capped at 8 MB so a hitch never becomes a stall.
 */
export function eagerUploadBudget(rawDtMs: number): number {
  const ms = Number.isFinite(rawDtMs) && rawDtMs > 0 ? rawDtMs : 1000 / 60;
  return Math.max(EAGER_MIN_BYTES, Math.min(EAGER_MAX_BYTES, Math.round(ms * EAGER_BYTES_PER_MS)));
}

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
    upMaterial = new THREE.MeshBasicMaterial();
    upMaterial.visible = false;
  }
  const batch: THREE.Mesh[] = [];
  let bytes = 0;
  for (const g of pending) {
    if (bytes >= maxBytes) break;
    pending.delete(g);
    g.removeEventListener('dispose', onPendingDispose);
    const b = unreleasedAttributeBytes(g);
    if (b === 0) continue;
    const mesh = new THREE.Mesh(g, upMaterial);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    batch.push(mesh);
    upScene.add(mesh);
    bytes += b;
  }
  if (batch.length === 0) return 0;
  eagerPasses += 1;
  eagerBytes += bytes;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    renderer.render(upScene, upCamera);
  } finally {
    renderer.autoClear = autoClear;
    for (const mesh of batch) upScene.remove(mesh);
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
  if (!arr || attr[RELEASED_KEY] !== undefined || arr.byteLength === 0) return;
  backUp(attr);
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
      noteOwner(a, g);
      bytes += a.array.byteLength;
    }
    queueUpload(g);
  });
  armedBytes += bytes;
  return bytes;
}

export interface CpuCopyReleaseStats {
  enabled: boolean; armedBytes: number; releasedBytes: number;
  /** Queued for the eager pass and not handed to GL yet (count, CPU bytes incl. index). */
  pendingCount: number; pendingBytes: number;
  eagerPasses: number; eagerBytes: number;
  /** Context-loss rebuild (b1-ask-04): geometries with a backup, geometries and bytes restored. */
  backedUpGeoms: number; restoredGeoms: number; restoredBytes: number; restorePending: boolean;
}

export function cpuCopyReleaseStats(): CpuCopyReleaseStats {
  let pendingBytes = 0;
  for (const g of pending) pendingBytes += unreleasedAttributeBytes(g) + (g.index?.array.byteLength ?? 0);
  return {
    enabled: cpuCopyReleaseEnabled(), armedBytes, releasedBytes, pendingCount: pending.size, pendingBytes, eagerPasses, eagerBytes,
    backedUpGeoms: releasedGeoms.size, restoredGeoms, restoredBytes, restorePending: restoresPending > 0,
  };
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
  for (const a of geometryAttributes(g)) if (a && releasable(a)) { a.onUpload(markUploaded); noteOwner(a, g); }
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
    noteOwner(attr, g);
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
