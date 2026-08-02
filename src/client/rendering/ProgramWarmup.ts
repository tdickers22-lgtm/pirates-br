import * as THREE from 'three';

/**
 * THE SHADER BILL IS DEFERRED TO FIRST DRAW. This pays it on purpose instead.
 *
 * THE DEFECT, named precisely. A cold start froze the tab for seconds at a
 * time — menu hover acknowledged after 1.5s, single main-thread tasks of 2.4s,
 * twelve tasks over 150ms between navigation and first control. A sampling
 * profile across the whole load put 53% of ALL JS self time in one stack, and
 * 91-99% of every multi-second frame gap in the same one:
 *
 *   onFirstUse  <  WebGLProgram.getUniforms  <  setProgram  <  renderBufferDirect
 *               <  renderObject < renderObjects < renderScene < render
 *
 * `onFirstUse` (three/src/renderers/webgl/WebGLProgram.js) does two things the
 * GL driver cannot do lazily: it reflects every active uniform's location, and —
 * while `renderer.debug.checkShaderErrors` is on — it reads three info logs and
 * the LINK_STATUS. Every one of those calls JOINS the link. ANGLE compiles and
 * links on background threads; the join is where the main thread sits down and
 * waits for them.
 *
 * WHY THE EXISTING WARM PASS COULD NOT FIX IT. `IslandDetailWarmer` pre-compiles
 * island materials through `renderer.compileAsync`, and that was measured doing
 * its job — worst warm frame 8.4ms while whole frames blocked for 3.4s. It is
 * not the warmer's fault: in three r160 `compile()` reaches `getProgram()`,
 * which ends with `materialProperties.uniformsList = null` and returns.
 * `getUniforms()` is never called there. It is called from `setProgram()` at
 * render time (WebGLRenderer.js:1900) and from `getUniformList()` (:1708). So
 * `compile()` kicks the link off and NOTHING ELSE — the reflection and the join
 * are unconditionally deferred to the first real draw. Worse, `isReady()` lies
 * when KHR_parallel_shader_compile is absent (WebGLProgram.js:1039 flags the
 * program ready immediately), so `compileAsync`'s promise resolves with nothing
 * linked and the warmer's millisecond budget never trips, because the work it is
 * budgeting costs ~0.
 *
 * WHAT THIS DOES INSTEAD, and why it is the whole fix rather than a mitigation:
 *
 *   1. PAY THE JOIN HERE. After `compile()` has kicked off the link, reach the
 *      program through `renderer.properties.get(material).currentProgram` and
 *      call `getUniforms()` and `getAttributes()` ourselves. That is literally
 *      the blocking function from the profile, now called from inside a loop
 *      that holds a stopwatch and stops.
 *
 *   2. KICK FIRST, JOIN LATER. `compile()` is issued for a chunk of meshes on
 *      one frame and the joins are taken on following frames, so ANGLE's
 *      background compile threads have real wall-clock time to finish and each
 *      join is short instead of being a full software shader JIT taken inline.
 *
 *   3. GATE WHAT IS NOT PAID FOR. A budget that only warms is a best effort: the
 *      materials it did not reach still link at draw time, which is the stall.
 *      So while the load guard is up, any material still owing its first use is
 *      given `visible = false` for that frame and restored immediately after the
 *      render. `WebGLRenderer.projectObject` tests `material.visible` when it
 *      builds the render list, so an unpaid program simply is not reached — the
 *      frame renders without it and the next frame pays for it. This is what
 *      turns "we try to warm" into "the load path cannot block".
 *
 * FAIL OPEN, ALWAYS. Warming is an optimisation and must never be able to make
 * something permanently invisible. A material that throws on the way through is
 * marked done and left alone forever after; a material that has been held back
 * `MAX_HELD_FRAMES` times is let through regardless of whether it is paid. The
 * worst case this degrades to is exactly the behaviour that existed before.
 */

/** Materials compiled per frame — the KICK, which only issues `linkProgram`. */
const KICK_PER_FRAME = 6;
/** …and while a ceremony owns the screen and nobody is playing. */
const KICK_PER_FRAME_BOOST = 14;

/**
 * Milliseconds a frame may spend taking JOINS.
 *
 * There is no smaller unit available: one `getUniforms()` is one program's
 * reflection and cannot be subdivided by anyone. So the budget is checked
 * BEFORE each join rather than after — a slice that has already spent its
 * allowance must not drag one more indivisible join in behind it, which is
 * exactly how a 4ms budget elsewhere in this repo became a 7460ms frame.
 */
const JOIN_MS_PER_FRAME = 6;
const JOIN_MS_PER_FRAME_BOOST = 24;

/** Frames a single material may be held out of the render before it is let
 *  through unpaid. A visible stall beats a world that is missing forever. */
const MAX_HELD_FRAMES = 40;

/** Cost of the guard itself: the scene walk stops after this many meshes, and
 *  resumes where it left off next frame. A scene walk that is itself a long
 *  task would be a fine joke to write into the fix for long tasks. */
const WALK_BUDGET = 4000;

type ProgramLike = { getUniforms?: () => unknown; getAttributes?: () => unknown; isReady?: () => boolean };

/** What makes two meshes want DIFFERENT programs off the SAME material. three
 *  builds its cache key from the material plus a handful of object/geometry
 *  facts that switch shader defines on and off. Anything missed here is not a
 *  correctness bug — it links at draw time exactly as it did before. */
function programKey(mesh: THREE.Mesh, material: THREE.Material): string {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  const attributes = geometry?.attributes;
  const flags = [
    (mesh as unknown as THREE.InstancedMesh).isInstancedMesh ? 'I' : '',
    (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh ? 'S' : '',
    (mesh as unknown as THREE.Sprite).isSprite ? 'P' : '',
    (mesh as unknown as THREE.Points).isPoints ? 'O' : '',
    (mesh as unknown as THREE.Line).isLine ? 'L' : '',
    attributes?.color ? 'C' : '',
    attributes?.tangent ? 'T' : '',
    attributes?.uv1 ? 'U' : '',
    geometry?.morphAttributes && Object.keys(geometry.morphAttributes).length > 0 ? 'M' : '',
  ].join('');
  return `${flags}|${material.uuid}`;
}

/**
 * NOT JUST MESHES. `WebGLRenderer.projectObject` puts meshes, LINES, POINTS and
 * SPRITES on the render list, and each of those is a program of its own — a
 * sprite does not even share a shader family with a mesh. A first pass of this
 * warmer tested `isMesh` alone and left a hole exactly the size of the scene's
 * 1052 points and 96 lines, which promptly linked at draw time and produced a
 * 770ms task inside `setProgram` with the guard nominally up. Anything the
 * renderer will draw has to be something this walk can see.
 */
function drawable(node: THREE.Object3D): node is THREE.Mesh {
  const any = node as unknown as Record<string, boolean>;
  return !!(any.isMesh || any.isLine || any.isPoints || any.isSprite);
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return [];
  return Array.isArray(material) ? material.filter(Boolean) : [material];
}

/**
 * WAITING ONLY PAYS WHERE THE DRIVER IS ACTUALLY WORKING IN THE BACKGROUND.
 *
 * `linkProgram` returns immediately everywhere, but what that means depends
 * entirely on KHR_parallel_shader_compile. Where the extension is present the
 * driver really is linking on its own threads and `program.isReady()` reports
 * it honestly, so holding the join until it says yes makes the join nearly free.
 * Where it is absent, three flags the program ready the instant it is created
 * (WebGLProgram.js:1039) — `isReady()` is not merely unhelpful there, it is a
 * lie — and the whole link is done inside the first query no matter how long we
 * wait. Measured on this machine's SwiftShader, a blind 500ms delay before each
 * join changed the worst load task by nothing and cost the load its head start.
 *
 * So the wait is conditional on the extension, and the fuse below only exists
 * for a driver that says it will report and then does not.
 */
const MAX_LINK_WAIT_MS = 2_000;
/** …and it is abandoned entirely once the backlog is this deep, because waiting
 *  longer then only means the guard holds more of the world out of more frames. */
const PENDING_HIGH_WATER = 24;

type Kicked = { key: string; material: THREE.Material; at: number };

/**
 * Pre-pays three's deferred first-use work for every material the scene is
 * about to draw, and holds back anything it has not paid for yet.
 */
export class ProgramWarmer {
  /** Program keys whose first use has been paid — never charged again. */
  private readonly paid = new Set<string>();
  /** Kicked (`compile`d) and waiting for a join, oldest first. */
  private readonly pending: Kicked[] = [];
  private readonly pendingKeys = new Set<string>();
  /** How many frames each held-back material has been held. Weak: a disposed
   *  material must not be kept alive by the bookkeeping that hid it once. */
  private readonly heldFrames = new WeakMap<THREE.Material, number>();
  /** Materials hidden for the current frame, to be restored after the render. */
  private readonly held: THREE.Material[] = [];
  /** Where last frame's scene walk stopped, so a huge scene costs a bounded
   *  walk per frame instead of one long one. */
  private walkCursor = 0;

  private boosted = false;
  private guard = true;
  /** Scratch container handed to `compile` — children are ASSIGNED, never
   *  `add`ed, so meshes keep their real parents and their baked world matrices. */
  private readonly batch = (() => {
    const group = new THREE.Group();
    group.name = 'program-warm-batch';
    group.matrixAutoUpdate = false;
    group.matrixWorldAutoUpdate = false;
    return group;
  })();

  /** Diagnostics, and the gate's own evidence. `forced` is the one that matters:
   *  it counts materials let through UNPAID because they had been held too long,
   *  i.e. every time the mechanism failed open and a draw-time link was allowed.
   *  A suite that only reads the worst task cannot tell a load that warmed from a
   *  load that gave up quietly. */
  readonly stats = {
    paid: 0, kicked: 0, heldNow: 0, forced: 0, lastMs: 0, worstMs: 0, worstJoinMs: 0,
    guard: true, parallel: null as boolean | null,
  };

  /** Warm harder while a ceremony owns the screen — nobody is playing, and a
   *  frame spent linking there is a frame that is not spent linking later. */
  setBoosted(boosted: boolean): void {
    this.boosted = boosted;
  }

  /**
   * The gate is only up during the load. Once the world has arrived, holding a
   * material out of a frame would be a visible pop for no benefit — the LOD
   * warmers and the first-draw allowance own the steady state, and this class
   * costs nothing but a bounded walk while it is down.
   */
  setGuard(active: boolean): void {
    this.guard = active;
    this.stats.guard = active;
  }

  reset(): void {
    this.paid.clear();
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.held.length = 0;
    this.walkCursor = 0;
  }

  /**
   * Run one slice, immediately BEFORE `renderer.render()`.
   *
   * Returns with any material this frame cannot afford already hidden; the
   * caller MUST call `release()` after the render or those materials stay
   * hidden. Both calls live in `Renderer.render()` so they cannot drift apart.
   */
  prepare(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.guard && this.pending.length === 0) { this.stats.heldNow = 0; return; }
    const startedAt = performance.now();

    // ── 1. join what was kicked on earlier frames ────────────────────────
    // Oldest first: those have had the most wall-clock time on ANGLE's compile
    // threads, so their join is the shortest one available.
    const joinBudget = this.boosted ? JOIN_MS_PER_FRAME_BOOST : JOIN_MS_PER_FRAME;
    while (this.pending.length > 0) {
      const now = performance.now();
      // Checked BEFORE the join, never after: a join cannot be interrupted.
      if (now - startedAt >= joinBudget) break;
      // FIFO, so if the oldest is not linked yet neither is anything behind it —
      // leave them all to the driver for another frame.
      const head = this.pending[0];
      if (this.pending.length < PENDING_HIGH_WATER
        && now - head.at < MAX_LINK_WAIT_MS
        && this.parallelCompile(renderer)
        && !this.linked(renderer, head.material)) break;
      const next = this.pending.shift()!;
      this.pendingKeys.delete(next.key);
      const joinStart = performance.now();
      this.join(renderer, next.material);
      const joinMs = performance.now() - joinStart;
      if (joinMs > this.stats.worstJoinMs) this.stats.worstJoinMs = +joinMs.toFixed(1);
      this.paid.add(next.key);
      this.stats.paid += 1;
    }

    // ── 2. walk the scene for meshes that still owe ──────────────────────
    const owing: { mesh: THREE.Mesh; key: string; material: THREE.Material }[] = [];
    let visited = 0;
    let skipped = 0;
    const resume = this.walkCursor;
    let wrapped = false;
    const kickCap = this.boosted ? KICK_PER_FRAME_BOOST : KICK_PER_FRAME;
    scene.traverseVisible((node) => {
      if (!drawable(node)) return;
      const mesh = node;
      // Resume where the last walk stopped, so no part of a large scene is
      // starved by always being at the back of the queue.
      if (skipped < resume) { skipped += 1; return; }
      visited += 1;
      if (visited > WALK_BUDGET) { wrapped = true; return; }
      for (const material of materialsOf(mesh)) {
        const key = programKey(mesh, material);
        if (this.paid.has(key)) continue;
        owing.push({ mesh, key, material });
      }
    });
    this.walkCursor = wrapped ? resume + WALK_BUDGET : 0;

    // ── 3. kick the links for a few of them ──────────────────────────────
    // One `compile()` call for the whole chunk: it walks the real scene's lights
    // once, which is the expensive part of the call, and issues `linkProgram`
    // for each mesh. The joins are deliberately NOT taken here.
    if (owing.length > 0) {
      const chunk: THREE.Mesh[] = [];
      const kicked: Kicked[] = [];
      const seen = new Set<string>();
      for (const entry of owing) {
        if (kicked.length >= kickCap) break;
        if (this.pendingKeys.has(entry.key) || seen.has(entry.key)) continue;
        seen.add(entry.key);
        chunk.push(entry.mesh);
        kicked.push({ key: entry.key, material: entry.material, at: 0 });
      }
      if (chunk.length > 0) {
        this.kick(renderer, scene, camera, chunk);
        const kickedAt = performance.now();
        for (const entry of kicked) {
          if (this.pendingKeys.has(entry.key)) continue;
          this.pendingKeys.add(entry.key);
          entry.at = kickedAt;
          this.pending.push(entry);
        }
        this.stats.kicked += chunk.length;
      }
    }

    // ── 4. hold back everything still unpaid ─────────────────────────────
    if (this.guard) {
      for (const entry of owing) {
        if (this.paid.has(entry.key)) continue;
        const material = entry.material;
        if (!material.visible) continue;
        const held = (this.heldFrames.get(material) ?? 0) + 1;
        if (held > MAX_HELD_FRAMES) { this.stats.forced += 1; continue; } // fail open — a stall beats a hole
        this.heldFrames.set(material, held);
        material.visible = false;
        this.held.push(material);
      }
    }
    this.stats.heldNow = this.held.length;
    this.stats.lastMs = +(performance.now() - startedAt).toFixed(2);
    if (this.stats.lastMs > this.stats.worstMs) this.stats.worstMs = this.stats.lastMs;
  }

  /** Give every held-back material its flag back. Call after `render()`. */
  release(): void {
    for (const material of this.held) material.visible = true;
    this.held.length = 0;
  }

  /** Issue `linkProgram` for a chunk without joining it. */
  private kick(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    meshes: THREE.Mesh[],
  ): void {
    this.batch.children = meshes;
    try {
      renderer.compile(this.batch, camera, scene);
    } catch {
      // A material that cannot be compiled here compiles at draw time exactly as
      // it always did; warming is an optimisation, never a correctness step.
    } finally {
      this.batch.children = [];
    }
  }

  /**
   * Take the join: reflect the uniforms and attributes, which is the work three
   * defers to `setProgram` and the profile named as the freeze.
   *
   * `checkShaderErrors` is turned ON for exactly this call and off everywhere
   * else, which is not a trick — `onFirstUse` runs ONCE per program, so a
   * program warmed here is fully error-checked and a program that reaches draw
   * time unwarmed skips a check whose three info-log reads are themselves part
   * of the stall being removed. Errors keep being reported, at a moment where
   * the cost is inside a budget.
   */
  private programOf(renderer: THREE.WebGLRenderer, material: THREE.Material): ProgramLike | undefined {
    const properties = (renderer as unknown as {
      properties?: { get(o: object): { currentProgram?: ProgramLike } };
    }).properties;
    return properties?.get(material)?.currentProgram;
  }

  /** Does this driver report link completion without blocking? Asked once. */
  private parallelCompile(renderer: THREE.WebGLRenderer): boolean {
    if (this.stats.parallel === null) {
      let has = false;
      try {
        has = !!(renderer as unknown as { extensions?: { get(name: string): unknown } })
          .extensions?.get('KHR_parallel_shader_compile');
      } catch { has = false; }
      this.stats.parallel = has;
    }
    return this.stats.parallel;
  }

  /** Only meaningful where `parallelCompile` is true — see MAX_LINK_WAIT_MS. */
  private linked(renderer: THREE.WebGLRenderer, material: THREE.Material): boolean {
    try {
      return this.programOf(renderer, material)?.isReady?.() ?? true;
    } catch {
      return true;
    }
  }

  private join(renderer: THREE.WebGLRenderer, material: THREE.Material): void {
    const program = this.programOf(renderer, material);
    if (!program) return;
    const previous = renderer.debug.checkShaderErrors;
    renderer.debug.checkShaderErrors = true;
    try {
      program.getUniforms?.();
      program.getAttributes?.();
    } catch {
      /* a program that will not reflect is a program that will link at draw */
    } finally {
      renderer.debug.checkShaderErrors = previous;
    }
  }
}

/** `?shadererrors` keeps three's link diagnostics on for EVERY program, including
 *  the ones that reach draw time unwarmed. For shader work, not for play — it
 *  re-arms the synchronous info-log reads this fix exists to move. */
export function shaderErrorsForced(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('shadererrors');
  } catch {
    return false;
  }
}
