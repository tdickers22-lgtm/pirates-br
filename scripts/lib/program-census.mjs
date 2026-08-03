// EVERY SHADER PROGRAM THIS CLIENT LINKS, WHEN, AND WHO ASKED FOR IT.
//
// The frame cost model's lever 1 says shader links are still being taken during
// play — 56 of 87 hitches and 77% of all hitched time at `high`. It could say
// that much from a CPU profile, because the stack is unmistakable
// (`getProgramParameter | getUniforms | replaceLightNums`). What a profile
// cannot say is WHICH programs, or what put them on the screen at that moment,
// and without those two facts a warm pass is guesswork.
//
// HOW IT CATCHES THE JOIN, EXACTLY.
//
// three r160 defers a program's first-use work — reflecting every active uniform
// and attribute location — to the first draw that uses it (WebGLProgram.js,
// `onFirstUse` behind `getUniforms`/`getAttributes`). `cachedUniforms` is a
// closure variable, so nothing outside can ask a program whether it has been
// used. But the first thing `new WebGLUniforms( gl, program )` does is
// `gl.getProgramParameter( program, ACTIVE_UNIFORMS )`, and that IS observable:
// patch it on the context prototypes at document start and every join announces
// itself, once, before any of this game's code has run.
//
//   ACTIVE_UNIFORMS  0x8B86   ← the join, one per program, ever
//   ACTIVE_ATTRIBUTES 0x8B89  ← fetchAttributeLocations, same join
//   LINK_STATUS      0x8B82   ← checkShaderErrors' own join, when enabled
//
// ATTRIBUTION comes from wrapping the renderer's own `renderBufferDirect`, which
// is where `setProgram` (and therefore the deferred join) is reached from. While
// that call is on the stack we know the material and the object being drawn, so
// a join recorded inside it is stamped with both — and a join recorded OUTSIDE
// it was paid deliberately by the warmer, which is the entire distinction this
// instrument exists to draw.
//
// The `cacheKey` is three's own program cache key, resolved lazily against
// `renderer.info.programs` (each `WebGLProgram` wrapper holds both the raw GL
// program and the key it was built from). Two materials that resolve to one key
// share a program; two keys are two links and two joins.
//
// FAIL OPEN AND STAY OUT OF THE WAY. Every patch is a thin pass-through in a
// try/catch. This runs in probe pages only — it is installed by scripts, never
// bundled into the client.

export const PROGRAM_CENSUS_SOURCE = String.raw`
(() => {
  if (window.__programCensus) return;

  const ACTIVE_UNIFORMS = 0x8B86;
  const LINK_STATUS = 0x8B82;
  const census = {
    /** Set by the runner: 'boot' | 'load' | 'ceremony' | 'play'. */
    phase: 'boot',
    /** performance.now() at the moment the runner declared first control. */
    controlAt: null,
    /** One entry per program join (i.e. per program that has ever been used). */
    events: [],
    /** Raw counters, so a join that could not be attributed is still counted. */
    counters: { links: 0, joins: 0, joinsInDraw: 0, joinsOutsideDraw: 0 },
    installedDraw: false,
    _current: null,
    _pending: [],

    setPhase(phase) { this.phase = phase; return this.phase; },
    markControl() { this.controlAt = performance.now(); this.phase = 'play'; return this.controlAt; },

    /** Resolve raw GL programs to three's cache keys, as late as possible. */
    resolve() {
      const renderer = window.__piratesBR?.renderer?.renderer;
      const programs = renderer?.info?.programs ?? [];
      const byGl = new Map();
      for (const p of programs) { try { byGl.set(p.program, p); } catch {} }
      for (const e of this.events) {
        if (e.cacheKey) continue;
        const wrapper = byGl.get(e.glProgram);
        if (!wrapper) continue;
        e.cacheKey = String(wrapper.cacheKey ?? '');
        e.shaderName = wrapper.name ?? '';
        e.shaderType = wrapper.type ?? '';
        e.programId = wrapper.id ?? -1;
      }
      return this.events.length;
    },

    /** Everything that linked after first control, worst first. */
    duringPlay() {
      this.resolve();
      return this.events.filter((e) => e.phase === 'play')
        .sort((a, b) => (b.ms + b.preMs) - (a.ms + a.preMs));
    },

    summary() {
      this.resolve();
      const byPhase = {};
      const keys = new Set();
      for (const e of this.events) {
        const row = (byPhase[e.phase] ??= { joins: 0, ms: 0, worstMs: 0, keys: 0 });
        const total = e.ms + e.preMs;
        row.joins += 1; row.ms += total; row.worstMs = Math.max(row.worstMs, total);
        keys.add(e.cacheKey || ('gl#' + e.seq));
      }
      for (const phase of Object.keys(byPhase)) {
        const seen = new Set();
        for (const e of this.events) if (e.phase === phase) seen.add(e.cacheKey || ('gl#' + e.seq));
        byPhase[phase].keys = seen.size;
        byPhase[phase].ms = Math.round(byPhase[phase].ms);
        byPhase[phase].worstMs = Math.round(byPhase[phase].worstMs);
      }
      const renderer = window.__piratesBR?.renderer?.renderer;
      return {
        counters: { ...this.counters },
        totalKeys: keys.size,
        livePrograms: renderer?.info?.programs?.length ?? -1,
        byPhase,
        all: this.events.map((e) => ({
          phase: e.phase,
          ms: Math.round(e.ms * 10) / 10,
          preMs: Math.round(e.preMs * 10) / 10,
          cacheKey: e.cacheKey || '(unresolved)',
          material: e.material,
          materialName: e.materialName,
          object: e.object,
          why: e.why,
        })),
        play: this.duringPlay().map((e) => ({
          ms: Math.round((e.ms + e.preMs) * 10) / 10,
          reflectMs: Math.round(e.ms * 10) / 10,
          atMs: e.controlOffsetMs === null ? null : Math.round(e.controlOffsetMs),
          cacheKey: e.cacheKey || '(unresolved)',
          shaderName: e.shaderName,
          material: e.material,
          materialName: e.materialName,
          object: e.object,
          parents: e.parents,
          why: e.why,
        })),
      };
    },

    /** Time already spent joining this program before the reflection began.
     *  checkShaderErrors reads LINK_STATUS and the info logs FIRST, and on a
     *  driver without parallel compile that read is where the whole link is
     *  paid. The warmer turns that flag on for its own joins, so without this
     *  column every warmed join reads a dishonest 0 ms. */
    _preMs: new WeakMap(),
    _charge(glProgram, ms) {
      try { this._preMs.set(glProgram, (this._preMs.get(glProgram) ?? 0) + ms); } catch {}
    },

    _record(glProgram, ms) {
      const ctx = this._current;
      this.counters.joins += 1;
      if (ctx) this.counters.joinsInDraw += 1; else this.counters.joinsOutsideDraw += 1;
      this.events.push({
        seq: this.events.length,
        glProgram,
        at: performance.now(),
        controlOffsetMs: this.controlAt === null ? null : performance.now() - this.controlAt,
        phase: ctx ? this.phase : (this.phase === 'play' ? 'play-warm' : this.phase + '-warm'),
        ms,
        preMs: (() => { try { return this._preMs.get(glProgram) ?? 0; } catch { return 0; } })(),
        cacheKey: '',
        shaderName: '',
        shaderType: '',
        programId: -1,
        material: ctx?.material ?? '(warm)',
        materialName: ctx?.materialName ?? '',
        object: ctx?.object ?? '',
        parents: ctx?.parents ?? '',
        why: ctx ? ctx.why : 'warmer (deliberate, outside a draw)',
      });
    },
  };

  // ── the join detector ───────────────────────────────────────────────────
  // Installed on the prototypes at document start, so no program can be created
  // and used before the instrument exists.
  for (const Ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctor?.prototype) continue;
    const proto = Ctor.prototype;
    const getParam = proto.getProgramParameter;
    proto.getProgramParameter = function (program, pname) {
      if (pname !== ACTIVE_UNIFORMS && pname !== LINK_STATUS) return getParam.call(this, program, pname);
      const t0 = performance.now();
      const out = getParam.call(this, program, pname);
      const ms = performance.now() - t0;
      try {
        if (pname === LINK_STATUS) census._charge(program, ms);
        else census._record(program, ms);
      } catch {}
      return out;
    };
    const infoLog = proto.getProgramInfoLog;
    proto.getProgramInfoLog = function (program) {
      const t0 = performance.now();
      const out = infoLog.call(this, program);
      try { census._charge(program, performance.now() - t0); } catch {}
      return out;
    };
    const link = proto.linkProgram;
    proto.linkProgram = function (program) {
      census.counters.links += 1;
      return link.call(this, program);
    };
  }

  // ── the attribution wrapper ─────────────────────────────────────────────
  // renderBufferDirect is an own property of the renderer instance in r160, so
  // it is wrapped per renderer, once, as soon as the game has built one.
  const chain = (object) => {
    const names = [];
    let node = object?.parent;
    for (let i = 0; i < 3 && node; i++) { names.push(node.name || node.type); node = node.parent; }
    return names.join(' < ');
  };
  census.installDraw = function () {
    const renderer = window.__piratesBR?.renderer?.renderer;
    if (!renderer || this.installedDraw) return this.installedDraw;
    const original = renderer.renderBufferDirect;
    renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      census._current = {
        material: material?.type ?? '?',
        materialName: material?.name ?? '',
        object: (object?.name || object?.type || '?'),
        parents: chain(object),
        why: [
          object?.isInstancedMesh ? 'instanced' : '',
          object?.isSkinnedMesh ? 'skinned' : '',
          object?.isSprite ? 'sprite' : '',
          object?.isPoints ? 'points' : '',
          object?.isLine ? 'line' : '',
          material?.transparent ? 'transparent' : '',
          geometry?.attributes?.color ? 'vcolor' : '',
          geometry?.morphAttributes && Object.keys(geometry.morphAttributes).length ? 'morph' : '',
        ].filter(Boolean).join(',') || 'plain',
      };
      try {
        return original.call(this, camera, scene, geometry, material, object, group);
      } finally {
        census._current = null;
      }
    };
    this.installedDraw = true;
    return true;
  };

  window.__programCensus = census;
})();
`;
