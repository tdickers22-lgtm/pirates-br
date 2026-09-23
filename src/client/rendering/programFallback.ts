import * as THREE from 'three';
import { reportBeacon } from '../network/errorBeacon';

/**
 * A SHADER PROGRAM THAT DID NOT LINK MUST NOT DRAW NOTHING, SILENTLY.
 *
 * liveplay-04: the ship hull and deck planking programs failed to compile
 * ('shipPlankSeam: undeclared identifier') on every GPU, and nobody knew,
 * because Renderer keeps `checkShaderErrors` off (the four info-log reads are a
 * link join that cost seconds on a cold start). three kept the broken program,
 * bound it every frame ("useProgram: program not valid" x254 until Chrome's
 * cap) and the material drew nothing.
 *
 * This watches for that without paying the join:
 *  - three's own `debug.onShaderError` fires for every program the
 *    ProgramWarmer joins (it turns the check on for its budgeted first use);
 *  - every CHECK_EVERY frames it asks LINK_STATUS of programs it has not seen,
 *    but only once a program is AGE_FRAMES old (by then a draw or the warmer
 *    has joined it, so the query does not block) and, with
 *    KHR_parallel_shader_compile, only once COMPLETION_STATUS says it is done.
 * A failed program is logged ONCE with its program and shader info logs (and a
 * beacon), and every material in the scene bound to it is downgraded: a built-in
 * material drops its onBeforeCompile patches (it becomes the stock three
 * shader, which links everywhere); a ShaderMaterial gets a flat minimal pair.
 * `material.userData.programFallback = true` marks it for probes.
 */
const LINK_STATUS = 0x8b82;
const COMPLETION_STATUS_KHR = 0x91b1;
const CHECK_EVERY = 30;
const AGE_FRAMES = 60;

const FALLBACK_VS = `void main() {
  vec3 p = position;
#ifdef USE_INSTANCING
  p = (instanceMatrix * vec4(p, 1.0)).xyz;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FALLBACK_FS = 'void main() { gl_FragColor = vec4(0.42, 0.40, 0.38, 1.0); }';

interface ProgramWrapper { program: WebGLProgram; name?: string; cacheKey?: string }
export interface ProgramFailure { name: string; cacheKey: string; log: string; materials: number }

export class ProgramFallback {
  readonly failures: ProgramFailure[] = [];
  private readonly firstSeen = new WeakMap<object, number>();
  private readonly verdict = new WeakSet<object>();
  private frame = 0;

  install(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.fail(renderer, scene, gl, program, vs, fs);
    };
  }

  /** After each rendered frame. Cheap: one array walk every CHECK_EVERY frames. */
  tick(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    this.frame += 1;
    if (this.frame % CHECK_EVERY !== 0) return;
    const gl = renderer.getContext();
    if (gl.isContextLost()) return;
    const parallel = !!renderer.extensions.get('KHR_parallel_shader_compile');
    const programs = (renderer.info as unknown as { programs?: ProgramWrapper[] }).programs ?? [];
    for (const p of programs) {
      if (this.verdict.has(p)) continue;
      const seen = this.firstSeen.get(p);
      if (seen === undefined) { this.firstSeen.set(p, this.frame); continue; }
      if (this.frame - seen < AGE_FRAMES) continue;
      try {
        if (parallel && gl.getProgramParameter(p.program, COMPLETION_STATUS_KHR) !== true) continue;
        this.verdict.add(p);
        if (gl.getProgramParameter(p.program, LINK_STATUS) === true) continue;
        const shaders = gl.getAttachedShaders(p.program) ?? [];
        const vs = shaders.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER);
        const fs = shaders.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER);
        this.fail(renderer, scene, gl, p.program, vs ?? null, fs ?? null);
      } catch { /* a lost context mid-walk: the restore path relinks everything */ }
    }
  }

  private fail(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, gl: WebGLRenderingContext,
    program: WebGLProgram, vs: WebGLShader | null, fs: WebGLShader | null,
  ): void {
    const programs = (renderer.info as unknown as { programs?: ProgramWrapper[] }).programs ?? [];
    const wrapper = programs.find((p) => p.program === program);
    if (wrapper) this.verdict.add(wrapper);
    const logs = [
      gl.getProgramInfoLog(program) ?? '',
      vs ? gl.getShaderInfoLog(vs) ?? '' : '',
      fs ? gl.getShaderInfoLog(fs) ?? '' : '',
    ].map((s) => s.trim()).filter(Boolean).join(' | ');
    const materials = this.downgrade(renderer, scene, program);
    const failure: ProgramFailure = {
      name: String(wrapper?.name ?? ''), cacheKey: String(wrapper?.cacheKey ?? '').slice(0, 160),
      log: logs.slice(0, 1200), materials,
    };
    this.failures.push(failure);
    console.error(`[program-fallback] '${failure.name}' did not link; ${materials} material(s) now draw the fallback. ${failure.log}`);
    reportBeacon('error', new Error(`program-link-failed ${failure.name}: ${failure.log.slice(0, 200)}`));
  }

  private downgrade(renderer: THREE.WebGLRenderer, scene: THREE.Scene, program: WebGLProgram): number {
    const properties = (renderer as unknown as {
      properties: { get(o: object): { currentProgram?: ProgramWrapper } };
    }).properties;
    const done = new Set<THREE.Material>();
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        if (done.has(mat) || properties.get(mat)?.currentProgram?.program !== program) continue;
        done.add(mat);
        ProgramFallback.flatten(mat);
      }
    });
    return done.size;
  }

  /** Rebuild `mat` as a program that links everywhere. Exported for the unit test. */
  static flatten(mat: THREE.Material): void {
    mat.userData.programFallback = true;
    if ((mat as THREE.ShaderMaterial).isShaderMaterial) {
      const sm = mat as THREE.ShaderMaterial;
      sm.vertexShader = FALLBACK_VS;
      sm.fragmentShader = FALLBACK_FS;
      if ((sm as THREE.RawShaderMaterial).isRawShaderMaterial) {
        sm.vertexShader = `precision highp float;\nuniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\nattribute vec3 position;\n${FALLBACK_VS.replace(/#ifdef USE_INSTANCING[\s\S]*?#endif\n/, '')}`;
        sm.fragmentShader = `precision highp float;\n${FALLBACK_FS}`;
      }
    } else {
      mat.onBeforeCompile = () => {};
    }
    mat.customProgramCacheKey = () => 'program-fallback';
    mat.needsUpdate = true;
  }
}
