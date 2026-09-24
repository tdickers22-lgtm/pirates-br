/**
 * memoryCensus() — what this tab is holding, in bytes (b1.7b, critique gap 9).
 *
 * WHY THIS EXISTS. An iPhone does not throttle a tab that holds too much: it
 * kills it, mid-match, and reloads the page. Nothing on SwiftShader or a Mac
 * ever shows that, so the phone and iPad rows of `scripts/test-memory-budget.mjs`
 * grade the one thing the harness CAN measure honestly: the bytes the scene,
 * the asset library and the render targets pin.
 *
 * WHAT IT COUNTS (every figure is an upper bound, never a flattering one):
 *  - geometry: every unique BufferAttribute (and index) reachable from the
 *    scene graph, visible or not. A hidden LOD level is still a GPU buffer
 *    once it has drawn, so it counts.
 *  - textures: every unique texture SOURCE reachable from scene materials
 *    (map slots and ShaderMaterial uniforms), scene.background/environment.
 *    Deduplicated by `texture.source` because three r160 uploads one GL
 *    texture per source: a `.clone()` shares it and must not count twice.
 *    Mip chains add 1/3; cube faces x6; compressed data is its real length.
 *  - render targets: every WebGLRenderTarget found by a bounded walk of the
 *    game object (post-fx, shadow maps, warm-up targets), colour x samples +
 *    depth, plus the default drawing buffer (x4 + resolve when antialiased).
 *  - library: CPU-side geometry the asset library retains outside the scene
 *    (template scenes and merged copies); reported, not counted as GPU.
 *  - heap: `performance.memory.usedJSHeapSize` where the browser exposes it
 *    (Chromium); elsewhere (Safari, Firefox) an ESTIMATE = CPU copies of every
 *    counted attribute + library geometry + DataTexture payloads + a fixed
 *    runtime floor, flagged `heapSource: 'estimate'`.
 *
 * Registered as `window.__piratesBR.memoryCensus()` (Game.ts, ?debug).
 * `forceStoryLod0(copies)` is the gate's MUTATION: every lazy story scene
 * resident at LOD0 `copies` extra times with fresh buffers and texture sources
 * (the shape of an eviction leak), which the phone rows must then FAIL.
 */
import * as THREE from 'three';
import { assets, LAZY_ASSET_NAMES } from '../assets/AssetLibrary.js';
import { releasedGpuBytes, cpuCopyReleaseStats, geometryUploaded, type CpuCopyReleaseStats } from '../rendering/CpuCopyRelease.js';

/** Bytes the current census walk found released from the CPU (reset per census). */
let cpuReleasedAcc = 0;

const MB = 1024 * 1024;
/** What a running three.js game holds before any content (module code, three,
 *  the net/state layer). Used only when the browser gives no heap reading. */
const RUNTIME_FLOOR_BYTES = 24 * MB;

export interface MemoryCensus {
  geometryBytes: number;
  textureBytes: number;
  renderTargetBytes: number;
  drawingBufferBytes: number;
  /** geometry + textures + render targets + drawing buffer. */
  gpuResidentBytes: number;
  libraryRetainedBytes: number;
  heapBytes: number;
  heapSource: 'performance.memory' | 'estimate';
  /** Of the heap: the CPU copies of counted geometry + library geometry + data-texture payloads.
   *  Chromium's usedJSHeapSize includes ArrayBuffer backing stores (measured: +100 MB typed
   *  array = +100 MB), so this is the share the b3.1b CPU-copy release can win back. */
  heapTypedArrayBytes: number;
  /** Of `geometryBytes`: GPU-only bytes whose CPU copy was released after upload (CpuCopyRelease). */
  cpuReleasedBytes: number;
  cpuRelease: CpuCopyReleaseStats;
  counts: {
    geometries: number; attributes: number; textures: number; renderTargets: number;
    infoGeometries: number; infoTextures: number; storyLod0Resident: number;
  };
  /** The same totals in MB (1 MB = 2^20 bytes), rounded to 0.1. */
  mb: { gpu: number; geometry: number; textures: number; renderTargets: number; heap: number; library: number; heapTypedArrays: number; cpuReleased: number };
  /** Top texture sources by bytes, for triage. */
  topTextures: { name: string; w: number; h: number; mb: number }[];
  objects: number;
  topRetained: { name: string; mb: number; n: number; uploaded: number; indexMb: number }[];
  /** Distinct scene materials (each compiled one carries its own uniform clone). */
  materials: number;
  /** Distinct materials by `<type>:<name>`, biggest families first (b1-ask-05). */
  topMaterials: { key: string; n: number }[];
}

type AnyTex = THREE.Texture & { isCompressedTexture?: boolean; isCubeTexture?: boolean; isDataTexture?: boolean;
  isData3DTexture?: boolean; isDataArrayTexture?: boolean; mipmaps?: { data?: ArrayBufferView }[] };

function channels(format: number): number {
  switch (format) {
    case THREE.RedFormat: case THREE.RedIntegerFormat: case THREE.AlphaFormat:
    case THREE.LuminanceFormat: case THREE.DepthFormat: return 1;
    case THREE.RGFormat: case THREE.RGIntegerFormat: case THREE.LuminanceAlphaFormat: case THREE.DepthStencilFormat: return 2;
    default: return 4; // RGBA; WebGL2 has no packed RGB upload in r160
  }
}

function bytesPerChannel(type: number): number {
  switch (type) {
    case THREE.FloatType: case THREE.IntType: case THREE.UnsignedIntType: case THREE.UnsignedInt248Type: return 4;
    case THREE.HalfFloatType: case THREE.ShortType: case THREE.UnsignedShortType: return 2;
    default: return 1;
  }
}

const MIP_FILTERS = new Set<number>([
  THREE.NearestMipmapNearestFilter, THREE.NearestMipmapLinearFilter,
  THREE.LinearMipmapNearestFilter, THREE.LinearMipmapLinearFilter,
]);

function imageDims(img: unknown): { w: number; h: number; d: number } {
  const i = img as { width?: number; height?: number; depth?: number; videoWidth?: number; videoHeight?: number } | null;
  if (!i) return { w: 0, h: 0, d: 1 };
  return { w: i.videoWidth ?? i.width ?? 0, h: i.videoHeight ?? i.height ?? 0, d: i.depth ?? 1 };
}

/** GPU bytes of one texture's upload. */
export function textureBytes(tex: THREE.Texture): { bytes: number; w: number; h: number } {
  const t = tex as AnyTex;
  if (t.isCompressedTexture && t.mipmaps?.length) {
    let bytes = 0;
    for (const m of t.mipmaps) bytes += m?.data?.byteLength ?? 0;
    const { w, h } = imageDims(t.image);
    return { bytes: bytes * (t.isCubeTexture ? 6 : 1), w, h };
  }
  const faces = t.isCubeTexture && Array.isArray(t.image) ? t.image.length : 1;
  const { w, h, d } = imageDims(Array.isArray(t.image) ? t.image[0] : t.image);
  const bpp = channels(t.format) * bytesPerChannel(t.type);
  const mip = t.generateMipmaps && MIP_FILTERS.has(t.minFilter) ? 4 / 3 : 1;
  return { bytes: Math.round(w * h * d * bpp * faces * mip), w, h };
}

/** GPU bytes of one render target (colour attachments x samples + depth). */
export function renderTargetBytes(rt: THREE.WebGLRenderTarget): number {
  const samples = Math.max(1, rt.samples ?? 0);
  const px = rt.width * rt.height * Math.max(1, (rt as unknown as { depth?: number }).depth ?? 1);
  const textures = (rt as unknown as { textures?: THREE.Texture[] }).textures ?? [rt.texture];
  let bytes = 0;
  for (const t of textures) {
    const bpp = channels(t.format) * bytesPerChannel(t.type);
    const mip = t.generateMipmaps && MIP_FILTERS.has(t.minFilter) ? 4 / 3 : 1;
    // A multisampled target keeps the MSAA renderbuffer AND the resolve texture.
    bytes += px * bpp * (samples > 1 ? samples + 1 : 1) * mip;
  }
  if (rt.depthBuffer) bytes += px * 4 * samples;
  return Math.round(bytes);
}

function attributeBytes(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
  seen: Set<unknown>): number {
  if (!a) return 0;
  const arr = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (a as THREE.InterleavedBufferAttribute).data.array
    : (a as THREE.BufferAttribute).array;
  if (!arr || seen.has(arr)) return 0;
  seen.add(arr);
  // A released attribute (rendering/CpuCopyRelease) still holds its bytes on the
  // GPU; only the CPU copy is gone. Count the GPU side, note the CPU saving.
  const released = releasedGpuBytes(a);
  if (released !== undefined) { cpuReleasedAcc += released; return released; }
  return (arr as ArrayBufferView).byteLength ?? 0;
}

function geometryBytes(g: THREE.BufferGeometry, seen: Set<unknown>): number {
  let bytes = attributeBytes(g.index, seen);
  for (const a of Object.values(g.attributes)) bytes += attributeBytes(a, seen);
  for (const list of Object.values(g.morphAttributes)) for (const a of list) bytes += attributeBytes(a, seen);
  return bytes;
}

function materialTextures(m: THREE.Material, out: (t: THREE.Texture) => void): void {
  for (const v of Object.values(m as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) out(v as THREE.Texture);
  const uniforms = (m as THREE.ShaderMaterial).uniforms;
  if (uniforms) {
    for (const u of Object.values(uniforms)) {
      const v = u?.value;
      if (v && (v as THREE.Texture).isTexture) out(v as THREE.Texture);
      else if (Array.isArray(v)) for (const x of v) if (x && (x as THREE.Texture).isTexture) out(x as THREE.Texture);
    }
  }
}

/** Bounded breadth-first walk of an object graph for render targets. Skips
 *  typed arrays, DOM nodes and the scene graph's children (walked apart). */
function findRenderTargets(roots: unknown[], limit = 60_000): THREE.WebGLRenderTarget[] {
  const found = new Set<THREE.WebGLRenderTarget>();
  const seen = new WeakSet<object>();
  let queue: unknown[] = roots;
  let visited = 0;
  for (let depth = 0; depth < 7 && queue.length && visited < limit; depth++) {
    const next: unknown[] = [];
    for (const v of queue) {
      if (!v || typeof v !== 'object' || seen.has(v as object)) continue;
      seen.add(v as object);
      if (++visited > limit) break;
      if ((v as THREE.WebGLRenderTarget).isWebGLRenderTarget) { found.add(v as THREE.WebGLRenderTarget); continue; }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
      if (typeof Node !== 'undefined' && v instanceof Node) continue;
      if ((v as THREE.BufferGeometry).isBufferGeometry || (v as THREE.Texture).isTexture) continue;
      if (v instanceof Map) { for (const x of v.values()) next.push(x); continue; }
      if (v instanceof Set) { for (const x of v) next.push(x); continue; }
      if (Array.isArray(v)) { if (v.length < 4096) for (const x of v) next.push(x); continue; }
      for (const k of Object.keys(v as object)) {
        if (k === 'parent' || k === 'children') continue;
        let x: unknown;
        try { x = (v as Record<string, unknown>)[k]; } catch { continue; }
        if (x && typeof x === 'object') next.push(x);
      }
    }
    queue = next;
  }
  return [...found];
}

/** What the census reads: the WebGL renderer, the scene, and the object whose
 *  graph is walked for render targets (the Game instance). */
export interface CensusHost {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  root: object;
}

export function memoryCensus(game: CensusHost): MemoryCensus {
  const { gl, scene } = game;
  const seenArrays = new Set<unknown>();
  const seenGeoms = new Set<THREE.BufferGeometry>();
  const sources = new Map<unknown, { bytes: number; name: string; w: number; h: number; tex: THREE.Texture }>();
  const rts = findRenderTargets([game.root, gl]);
  const rtTextures = new Set<THREE.Texture>();
  for (const rt of rts) for (const t of ((rt as unknown as { textures?: THREE.Texture[] }).textures ?? [rt.texture])) rtTextures.add(t);
  // Shadow maps are render targets hung on lights, which the game walk skips.
  scene.traverse((o) => {
    const map = (o as THREE.DirectionalLight).shadow?.map;
    if (map && !rts.includes(map)) { rts.push(map); rtTextures.add(map.texture); }
  });

  const addTexture = (t: THREE.Texture) => {
    if (rtTextures.has(t)) return;
    const key = (t as unknown as { source?: unknown }).source ?? t;
    if (sources.has(key)) return;
    const { bytes, w, h } = textureBytes(t);
    sources.set(key, { bytes, name: t.name || (t.image as { src?: string } | null)?.src?.split('/').pop() || t.uuid.slice(0, 8), w, h, tex: t });
  };

  let geometry = 0;
  cpuReleasedAcc = 0;
  let storyLod0Resident = 0;
  let objects = 0;
  // b1-ask-05: which meshes still hold CPU typed arrays after the tour, by
  // name family (digits stripped), so the heap cut targets real bytes.
  const retained = new Map<string, { bytes: number; n: number; uploaded: number; index: number }>();
  const retainedSeen = new Set<unknown>();
  const lazy = new Set<string>(LAZY_ASSET_NAMES);
  const matSeen = new Set<THREE.Material>();
  const matFamilies = new Map<string, number>();
  scene.traverse((o) => {
    objects += 1;
    // The proxy carries the same `prop-<type>` name until LOD0 lands; LOD0 is the non-mesh root.
    if (lazy.has(o.name.replace(/^prop-/, '')) && !(o as THREE.Mesh).isMesh) storyLod0Resident += 1;
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !seenGeoms.has(mesh.geometry)) {
      seenGeoms.add(mesh.geometry);
      geometry += geometryBytes(mesh.geometry, seenArrays);
      let cpu = 0;
      let idx = 0;
      const g = mesh.geometry;
      for (const a of [...Object.values(g.attributes), g.index]) {
        const arr = (a as THREE.BufferAttribute | null)?.array as ArrayBufferView | undefined;
        if (arr?.byteLength && !retainedSeen.has(arr)) {
          retainedSeen.add(arr); cpu += arr.byteLength;
          if (a === g.index) idx += arr.byteLength;
        }
      }
      if (cpu > 0) {
        let n = o as THREE.Object3D | null;
        while (n && !n.name) n = n.parent;
        const key = (n?.name || o.type).replace(/[\d_.-]+$/g, '').slice(0, 40) + ((mesh as THREE.SkinnedMesh).isSkinnedMesh ? ' (skinned)' : '');
        const e = retained.get(key) ?? { bytes: 0, n: 0, uploaded: 0, index: 0 };
        e.bytes += cpu; e.index += idx; e.n += 1; if (geometryUploaded(g)) e.uploaded += 1;
        retained.set(key, e);
      }
    }
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      geometry += attributeBytes(inst.instanceMatrix, seenArrays);
      geometry += attributeBytes(inst.instanceColor, seenArrays);
    }
    const mat = mesh.material;
    if (mat) for (const m of Array.isArray(mat) ? mat : [mat]) {
      materialTextures(m, addTexture);
      if (m && !matSeen.has(m)) {
        matSeen.add(m);
        // Unnamed material on an unnamed mesh: attribute it to the nearest
        // named ancestor (`~<ancestor>`) so the creation site is findable.
        let label = m.name || o.name;
        if (!label) {
          let n = o.parent;
          while (n && !n.name) n = n.parent;
          label = n?.name ? `~${n.name}` : o.type;
        }
        const key = `${m.type}:${label.replace(/[\d_.-]+$/g, '').slice(0, 32)}`;
        matFamilies.set(key, (matFamilies.get(key) ?? 0) + 1);
      }
    }
  });
  if ((scene.background as THREE.Texture | null)?.isTexture) addTexture(scene.background as THREE.Texture);
  if (scene.environment) addTexture(scene.environment);

  let textures = 0;
  let dataPayload = 0;
  for (const s of sources.values()) {
    textures += s.bytes;
    const img = s.tex.image as { data?: ArrayBufferView } | null;
    if (img?.data?.byteLength) dataPayload += img.data.byteLength;
  }
  let renderTargets = 0;
  for (const rt of rts) renderTargets += renderTargetBytes(rt);

  const ctx = gl.getContext();
  const attrs = ctx.getContextAttributes();
  const bufPx = ctx.drawingBufferWidth * ctx.drawingBufferHeight;
  const drawingBuffer = Math.round(bufPx * (4 + (attrs?.depth ? 4 : 0)) * (attrs?.antialias ? 4 : 1)
    + (attrs?.antialias ? bufPx * 4 : 0) + bufPx * 4 /* the front (displayed) buffer */);

  // Library-held CPU geometry outside the scene graph (templates, merged copies).
  let library = 0;
  const lib = assets as unknown as { scenes?: Map<string, THREE.Object3D>; merged?: Map<string, { geometry: THREE.BufferGeometry }> };
  const libSeen = new Set<unknown>(seenArrays);
  lib.scenes?.forEach((root) => root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) library += geometryBytes(g, libSeen);
  }));
  lib.merged?.forEach((m) => { if (m?.geometry) library += geometryBytes(m.geometry, libSeen); });

  const perf = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const measuredHeap = perf?.usedJSHeapSize;
  const heapSource = typeof measuredHeap === 'number' && measuredHeap > 0 ? 'performance.memory' : 'estimate';
  // Three keeps each attribute's typed array after upload (no onUploadCallback
  // release yet, b3.1b), so the CPU copy of counted geometry IS heap.
  const heap = heapSource === 'performance.memory' ? measuredHeap! : RUNTIME_FLOOR_BYTES + geometry - cpuReleasedAcc + library + dataPayload;

  const gpu = geometry + textures + renderTargets + drawingBuffer;
  const r = (b: number) => Math.round((b / MB) * 10) / 10;
  const top = [...sources.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)
    .map((s) => ({ name: s.name, w: s.w, h: s.h, mb: r(s.bytes) }));
  return {
    geometryBytes: geometry,
    textureBytes: textures,
    renderTargetBytes: renderTargets,
    drawingBufferBytes: drawingBuffer,
    gpuResidentBytes: gpu,
    libraryRetainedBytes: library,
    heapBytes: heap,
    heapSource,
    heapTypedArrayBytes: geometry - cpuReleasedAcc + library + dataPayload,
    cpuReleasedBytes: cpuReleasedAcc,
    cpuRelease: cpuCopyReleaseStats(),
    counts: {
      geometries: seenGeoms.size, attributes: seenArrays.size, textures: sources.size, renderTargets: rts.length,
      infoGeometries: gl.info.memory.geometries, infoTextures: gl.info.memory.textures, storyLod0Resident,
    },
    mb: { gpu: r(gpu), geometry: r(geometry), textures: r(textures), renderTargets: r(renderTargets + drawingBuffer), heap: r(heap), library: r(library), heapTypedArrays: r(geometry - cpuReleasedAcc + library + dataPayload), cpuReleased: r(cpuReleasedAcc) },
    topTextures: top,
    objects,
    topRetained: [...retained.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 14)
      .map(([name, e]) => ({ name, mb: r(e.bytes), n: e.n, uploaded: e.uploaded, indexMb: r(e.index) })),
    materials: matSeen.size,
    topMaterials: [...matFamilies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, n]) => ({ key, n })),
  };
}

/**
 * MUTATION for test-memory-budget: make every lazy story scene resident at
 * LOD0 `copies` extra times, each with its own buffers and texture sources
 * (what an evict/re-ensure leak looks like), parked at the camera so every
 * copy uploads. Returns how many scenes were forced.
 */
export async function forceStoryLod0(game: CensusHost, copies = 2): Promise<number> {
  const { scene } = game;
  const lib = assets as unknown as { scenes?: Map<string, THREE.Object3D> };
  let forced = 0;
  const holder = new THREE.Group();
  holder.name = 'memory-mutation-story-lod0';
  scene.add(holder);
  for (const name of LAZY_ASSET_NAMES) {
    await assets.ensure(name, true).catch(() => undefined);
    if (!lib.scenes?.get(name)) continue;
    for (let i = 0; i < copies; i++) {
      // A fresh parse per copy: the library's own LOD0 may already have
      // dropped its CPU arrays on the release profile (b1-ask-05), and a clone
      // of an emptied geometry would make this mutation vacuous.
      const copy = await assets.loadDetached(name).catch(() => null);
      if (!copy) continue;
      copy.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry = mesh.geometry.clone();
        const fresh = (m: THREE.Material) => {
          const c = m.clone();
          for (const [k, v] of Object.entries(c as unknown as Record<string, unknown>)) {
            if (v && (v as THREE.Texture).isTexture) {
              const t = (v as THREE.Texture).clone();
              t.source = new THREE.Source((v as THREE.Texture).image);
              t.needsUpdate = true;
              (c as unknown as Record<string, unknown>)[k] = t;
            }
          }
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fresh) : fresh(mesh.material);
        mesh.frustumCulled = false;
      });
      copy.name = `mutation-${name}-${i}`;
      holder.add(copy);
    }
    forced += 1;
  }
  return forced;
}
