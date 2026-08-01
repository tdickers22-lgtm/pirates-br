import * as THREE from 'three';

/**
 * Island detail LOD: pay the reveal early, and in slices.
 *
 * `updateEnvironmentLod` used to flip an island's whole detail subtree from
 * invisible to visible on the ONE frame the camera crossed the detail radius.
 * Nothing is uploaded to the GL driver until a mesh is actually drawn, so that
 * single frame paid every geometry upload, every texture upload and every
 * shader program link for the entire island at once — synchronously, on the
 * main thread. Measured on identical three-pass free-cam sweeps: the first
 * approach to Smuggler's Rest stalled 7917ms where the third took 227ms
 * (34.9x), and a play-probe frame added 662 geometries and 5 program links
 * inside one 2654ms rAF gap. Programs and heap were flat — it was never a
 * leak, it was a burst.
 *
 * This is the same medicine `drainIslandBuildQueue` already applies to island
 * BUILDS (one per frame, drawn a frame after it is built), extended to the
 * reveal:
 *
 *   1. PRE-WARM. While an island is still outside its reveal radius (but
 *      inside a wider warm band) its materials are compiled a chunk at a time
 *      through `renderer.compileAsync(subtree, camera, scene)` — three links
 *      the programs against the REAL scene's lights and fog, so the programs
 *      warmed here are the very ones the reveal will want. Textures found on
 *      the way are pushed through `renderer.initTexture`. Both are bounded per
 *      frame, and the promise from one chunk gates the next, so the warm never
 *      becomes its own hitch.
 *
 *   2. CHUNKED REVEAL, the safety net for anything that arrives un-warmed (a
 *      fast approach, a teleport, the spawn island). The subtree goes visible
 *      immediately, but its meshes are held back and released over the next few
 *      frames against a byte budget, biggest structure first: terrain and shore
 *      skirt, then dressing, then the micro tier, then grass/ferns/shells. An
 *      island therefore fills in from its silhouette inward rather than
 *      appearing half-missing.
 *
 * Nothing here changes what is on screen once the reveal settles — same radii,
 * same content, same look. Geometry that has already been uploaded once costs
 * nothing against the budget, so a second approach to an island is instant,
 * which is exactly the pass-1/pass-3 asymmetry the evidence measured.
 *
 * Geometry buffers have no public "upload me now" hook in three (unlike
 * `initTexture` and `compileAsync`), which is why the geometry half of the bill
 * is amortised by the chunked reveal rather than pre-paid by the warm pass.
 */

/** Meshes whose materials are compiled per frame while warming one island. */
const WARM_MESHES_PER_CHUNK = 14;
/** …and while the start ceremony owns the screen, where a hitch costs nothing. */
const WARM_MESHES_PER_CHUNK_BOOST = 48;
/** Textures pushed to the GL driver per warm chunk. */
const WARM_TEXTURES_PER_CHUNK = 8;
/** Frames a warm chunk may wait on its compile promise before moving on. */
const WARM_CHUNK_TIMEOUT_FRAMES = 90;

/** Estimated NEW geometry bytes a single frame may hand to the driver. */
const REVEAL_BYTES_PER_FRAME = 2_000_000;
/** …and how many meshes carrying new geometry, whichever cap trips first. */
const REVEAL_MESHES_PER_FRAME = 48;
/** Tighter caps while the island being revealed has NOT been compiled yet — a
 *  teleport, or a hull that crossed the warm band faster than it could compile.
 *  Every mesh let out then links its programs at draw time, so the reveal is
 *  slowed to let the warm pass get in front of it. A few more frames of an
 *  island filling in beats one frame that stops the game. */
const REVEAL_BYTES_PER_FRAME_COLD = 600_000;
const REVEAL_MESHES_PER_FRAME_COLD = 12;
/** Already-uploaded meshes are free, but still capped so the walk stays cheap. */
const REVEAL_FREE_MESHES_PER_FRAME = 600;

/** Reveal order: silhouette first, ankle-height flecks last. */
function revealPriority(node: THREE.Object3D, inherited: number): number {
  switch (node.name) {
    case 'island-terrain':
    case 'island-shore-skirt':
    case 'island-contact-shadows':
      return 0;
    case 'island-micro-root':
    case 'island-pebbles':
      return 2;
    case 'island-grass':
    case 'island-ferns':
    case 'island-shells':
      return 3;
    default:
      return inherited;
  }
}

/** Rough driver cost of a geometry: what actually gets copied into GL buffers. */
function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    const array = attribute.array as ArrayLike<number> & { byteLength?: number };
    bytes += array.byteLength ?? attribute.count * attribute.itemSize * 4;
  }
  if (geometry.index) bytes += (geometry.index.array as Uint32Array).byteLength;
  return bytes;
}

type RevealUnit = {
  /** Top-most mesh of a drawable unit — holding it holds everything under it. */
  mesh: THREE.Mesh;
  /** The `visible` flag the LOD had set on it when the reveal began. */
  wasVisible: boolean;
  priority: number;
  /** Estimated bytes still owed to the driver (0 once already uploaded). */
  bytes: number;
  /** Every geometry under this unit, banked when the unit is finally drawn. */
  geometries: THREE.BufferGeometry[];
};

type RevealJob = {
  root: THREE.Object3D;
  units: RevealUnit[];
  cursor: number;
};

type WarmJob = {
  id: string;
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  cursor: number;
  /** Set while a compileAsync chunk is still linking. */
  waiting: boolean;
  waitedFrames: number;
};

/** The three bits of renderer state the warmer needs, read lazily. */
export type WarmupTarget = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
};

export class IslandDetailWarmer {
  constructor(private readonly target: () => WarmupTarget) {}

  /** Islands whose materials have been through a full compile pass. */
  private readonly warmed = new Set<string>();
  /** Islands queued for warming, nearest first (the caller decides the order). */
  private readonly warmQueue: { id: string; root: THREE.Object3D }[] = [];
  private warmJob: WarmJob | null = null;
  private reveals = new Map<string, RevealJob>();
  /** Geometries the driver has certainly seen — a second reveal owes nothing. */
  private readonly uploaded = new WeakSet<THREE.BufferGeometry>();
  /** True while the start ceremony holds the screen: warm harder, nobody is playing. */
  private boosted = false;

  /** Scratch container handed to `compile` — children are ASSIGNED, never
   *  `add`ed, so the meshes keep their real parents and their baked world
   *  matrices. `matrixWorldAutoUpdate` is off for the same reason: a matrix
   *  walk from this group would rewrite every child's world transform. */
  private readonly warmGroup = (() => {
    const group = new THREE.Group();
    group.name = 'island-warm-batch';
    group.matrixAutoUpdate = false;
    group.matrixWorldAutoUpdate = false;
    return group;
  })();

  setBoosted(boosted: boolean): void {
    this.boosted = boosted;
  }

  isWarm(id: string): boolean {
    return this.warmed.has(id);
  }

  /** True while an island is still filling in — used by tests/probes. */
  isRevealing(id: string): boolean {
    return this.reveals.has(id);
  }

  debugState() {
    return {
      warmed: [...this.warmed],
      warming: this.warmJob ? { id: this.warmJob.id, done: this.warmJob.cursor, total: this.warmJob.meshes.length } : null,
      queued: this.warmQueue.map((entry) => entry.id),
      revealing: [...this.reveals].map(([id, job]) => ({ id, done: job.cursor, total: job.units.length })),
    };
  }

  /** Ask for an island's detail subtree to be compiled before it is revealed.
   *  Cheap and idempotent — call it every frame for every island in the band. */
  requestWarm(id: string, root: THREE.Object3D): void {
    if (this.warmed.has(id)) return;
    if (this.warmJob?.id === id) return;
    if (this.warmQueue.some((entry) => entry.id === id)) return;
    this.warmQueue.push({ id, root });
  }

  /** Move an island to the head of the warm queue (its reveal is imminent). */
  private prioritiseWarm(id: string): void {
    const index = this.warmQueue.findIndex((entry) => entry.id === id);
    if (index > 0) this.warmQueue.unshift(...this.warmQueue.splice(index, 1));
  }

  /** The detail subtree just went visible: hold its meshes and let them out
   *  over the next frames. Safe to call when the island is already warm — the
   *  geometry bill is separate from the shader bill, and only the meshes with
   *  geometry the driver has never seen cost anything. */
  beginReveal(id: string, root: THREE.Object3D): void {
    if (this.reveals.has(id)) return;
    const units: RevealUnit[] = [];
    const walk = (node: THREE.Object3D, inherited: number) => {
      const priority = revealPriority(node, inherited);
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        const geometries: THREE.BufferGeometry[] = [];
        let bytes = 0;
        node.traverse((child) => {
          const inner = child as THREE.Mesh;
          if (!inner.isMesh || !inner.geometry) return;
          geometries.push(inner.geometry);
          if (!this.uploaded.has(inner.geometry)) bytes += geometryBytes(inner.geometry);
        });
        units.push({ mesh, wasVisible: mesh.visible, priority, bytes, geometries });
        return; // a mesh is one drawable unit — never reveal half of one
      }
      for (const child of node.children) walk(child, priority);
    };
    walk(root, 1);
    if (units.length === 0) return;
    // Silhouette first, and within a tier the heavy structure before the trim.
    units.sort((a, b) => a.priority - b.priority || b.bytes - a.bytes);
    for (const unit of units) unit.mesh.visible = false;
    this.reveals.set(id, { root, units, cursor: 0 });
    if (!this.warmed.has(id)) this.prioritiseWarm(id);
  }

  /** The island dropped back out of detail range mid-reveal (or was disposed):
   *  give every held mesh its flag back so nothing is left invisible forever. */
  cancelReveal(id: string): void {
    const job = this.reveals.get(id);
    if (!job) return;
    for (let i = job.cursor; i < job.units.length; i++) {
      job.units[i].mesh.visible = job.units[i].wasVisible;
    }
    this.reveals.delete(id);
  }

  /** Drop all bookkeeping for an island (match teardown). */
  forget(id: string): void {
    this.cancelReveal(id);
    this.warmed.delete(id);
    if (this.warmJob?.id === id) this.warmJob = null;
    const index = this.warmQueue.findIndex((entry) => entry.id === id);
    if (index >= 0) this.warmQueue.splice(index, 1);
  }

  reset(): void {
    for (const id of [...this.reveals.keys()]) this.cancelReveal(id);
    this.warmed.clear();
    this.warmQueue.length = 0;
    this.warmJob = null;
  }

  /** Per-frame pump. Call BEFORE the LOD pass so a mesh released this frame is
   *  drawn with this frame's LOD decision, not last frame's. */
  update(): void {
    this.pumpReveals();
    this.pumpWarm();
  }

  // ── reveal ────────────────────────────────────────────────────────────

  private pumpReveals(): void {
    if (this.reveals.size === 0) return;
    let bytes = 0;
    let costly = 0;
    let free = 0;
    for (const [id, job] of this.reveals) {
      const warm = this.warmed.has(id);
      const byteCap = warm ? REVEAL_BYTES_PER_FRAME : REVEAL_BYTES_PER_FRAME_COLD;
      const meshCap = warm ? REVEAL_MESHES_PER_FRAME : REVEAL_MESHES_PER_FRAME_COLD;
      while (job.cursor < job.units.length) {
        const unit = job.units[job.cursor];
        if (unit.bytes > 0) {
          // Always let at least one costly unit through, or a single mesh
          // heavier than the whole budget would wedge the reveal forever.
          if (costly > 0 && (bytes >= byteCap || costly >= meshCap)) return;
          bytes += unit.bytes;
          costly += 1;
        } else if (++free > REVEAL_FREE_MESHES_PER_FRAME) {
          return;
        }
        unit.mesh.visible = unit.wasVisible;
        job.cursor += 1;
        // Bank the geometry only if this unit is genuinely about to be drawn:
        // a mesh released under a still-hidden tier group has not been uploaded
        // and must not be counted as free next time round.
        if (unit.wasVisible && this.ancestorsVisible(unit.mesh)) {
          for (const geometry of unit.geometries) this.uploaded.add(geometry);
        }
      }
      this.reveals.delete(id);
    }
  }

  /** Walks the whole chain to the scene root, not just to the detail root: an
   *  island group is held hidden for a frame after it is built, and a mesh
   *  released under it has NOT reached the driver yet. */
  private ancestorsVisible(node: THREE.Object3D): boolean {
    for (let cursor: THREE.Object3D | null = node.parent; cursor; cursor = cursor.parent) {
      if (!cursor.visible) return false;
    }
    return true;
  }

  // ── warm ──────────────────────────────────────────────────────────────

  private pumpWarm(): void {
    if (!this.warmJob) {
      const next = this.warmQueue.shift();
      if (!next) return;
      if (this.warmed.has(next.id)) return;
      const meshes: THREE.Mesh[] = [];
      // A light inside a warm batch would be pushed onto the light list that
      // three builds the program key from, producing a program the real scene
      // never uses. Skip any mesh with a light under it — the real scene's
      // lights come through `targetScene` and are already accounted for.
      const lightAncestors = new Set<THREE.Object3D>();
      next.root.traverse((node) => {
        if (!(node as THREE.Light).isLight) return;
        for (let cursor: THREE.Object3D | null = node; cursor; cursor = cursor.parent) {
          lightAncestors.add(cursor);
          if (cursor === next.root) break;
        }
      });
      next.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.material && !lightAncestors.has(mesh)) meshes.push(mesh);
      });
      if (meshes.length === 0) {
        this.warmed.add(next.id);
        return;
      }
      this.warmJob = { id: next.id, root: next.root, meshes, cursor: 0, waiting: false, waitedFrames: 0 };
    }

    const job = this.warmJob;
    if (job.waiting) {
      // The link is the GL driver's business now; don't stack a second chunk on
      // top of it. The frame cap is a fuse for a driver that never reports back.
      if (++job.waitedFrames < WARM_CHUNK_TIMEOUT_FRAMES) return;
      job.waiting = false;
    }
    job.waitedFrames = 0;

    const { renderer, scene, camera } = this.target();
    // An island already filling in un-warmed is a race the compile has to win:
    // every mesh the reveal lets out ahead of it links its programs at draw
    // time instead. Compile in the bigger chunks until it is in front.
    const urgent = this.reveals.has(job.id);
    const size = this.boosted || urgent ? WARM_MESHES_PER_CHUNK_BOOST : WARM_MESHES_PER_CHUNK;
    const chunk = job.meshes.slice(job.cursor, job.cursor + size);
    job.cursor += chunk.length;
    if (chunk.length === 0) {
      this.warmed.add(job.id);
      this.warmJob = null;
      return;
    }

    this.warmTextures(renderer, chunk);

    this.warmGroup.children = chunk;
    try {
      const compileAsync = (renderer as THREE.WebGLRenderer & {
        compileAsync?: (scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene) => Promise<unknown>;
      }).compileAsync;
      if (typeof compileAsync === 'function') {
        job.waiting = true;
        const compiling = job;
        compileAsync.call(renderer, this.warmGroup, camera, scene)
          .then(() => { if (this.warmJob === compiling) compiling.waiting = false; })
          .catch(() => { if (this.warmJob === compiling) compiling.waiting = false; });
      } else {
        // Older three: the same work, just without the readiness handshake.
        renderer.compile(this.warmGroup, camera, scene);
      }
    } catch {
      // A material that cannot be compiled here will compile at draw time as it
      // always did; warming is an optimisation, never a correctness step.
      job.waiting = false;
    } finally {
      this.warmGroup.children = [];
    }

    if (job.cursor >= job.meshes.length && !job.waiting) {
      this.warmed.add(job.id);
      this.warmJob = null;
    }
  }

  private warmTextures(renderer: THREE.WebGLRenderer, chunk: THREE.Mesh[]): void {
    let budget = WARM_TEXTURES_PER_CHUNK;
    for (const mesh of chunk) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of Object.keys(material)) {
          if (budget <= 0) return;
          const value = (material as unknown as Record<string, unknown>)[key];
          const texture = value as THREE.Texture | null;
          if (!texture || !(texture as THREE.Texture).isTexture) continue;
          if (this.initedTextures.has(texture)) continue;
          this.initedTextures.add(texture);
          budget -= 1;
          try {
            renderer.initTexture(texture);
          } catch {
            /* a render-target texture has no CPU image to upload; harmless */
          }
        }
      }
    }
  }

  private readonly initedTextures = new WeakSet<THREE.Texture>();
}
