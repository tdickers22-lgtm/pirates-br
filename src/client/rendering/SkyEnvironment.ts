import * as THREE from 'three';
import type { GpuClass, RenderQuality } from './QualityPreference.js';

/**
 * ENVIRONMENT LIGHTING FROM THE LIVE SKY (b3.1d, assets-13).
 *
 * WHY. Until this module the game had no environment map at all (0 hits for
 * PMREMGenerator / scene.environment / .envMap in src/client), so a metal
 * surface had nothing to reflect: a PBR metal has no diffuse term, and the only
 * light it could show was the sun's one specular highlight. Every GLB builder
 * set metalness 0 on purpose because 1.0 rendered near black. The assets lanes
 * cannot ship real iron, brass and steel until this exists.
 *
 * WHAT. The sky dome's own ShaderMaterial is drawn into a small cube render
 * target (no tone mapping: three renders to a target linear), and that cube is
 * prefiltered into a PMREM (the cubeUV atlas MeshStandardMaterial samples by
 * roughness). The result is `scene.environment`, so every standard material,
 * including ones loaded later, sees the same sky.
 *
 * TWO PATHS, one mechanism.
 *   pmrem (high, balanced on a desktop GPU): 128 px cube faces.
 *   baked (low, and any phone/tablet GPU):    32 px cube faces, the "baked 32x32
 *     irradiance". Cheap to capture (6 x 32x32 sky fragments + a tiny blur), and
 *     the shader patch below restricts the lookup to METAL fragments, so a
 *     dielectric pixel on the low tier pays nothing it did not pay before.
 *
 * WHEN. Never per frame. The capture is keyed on a quantised day/twilight/night
 * phase plus the storm/overcast weight (envPhaseKey) and re-runs only when that
 * key changes, and no sooner than ENV_MIN_REFRESH_MS after the last capture (a
 * value sitting on a quantisation edge cannot thrash). The output render target
 * is reused, so the texture object never changes and no material re-links on a
 * refresh; every program that samples it was linked with the same cubeUV height.
 *
 * DIFFUSE STAYS WHERE IT WAS TUNED. The ambient + hemisphere + horizon fill rig
 * already is this game's sky irradiance and every look shot was graded against
 * it. Adding the env map's diffuse term on top would double-light the whole
 * world. patchEnvironmentChunk() therefore drops the IBL IRRADIANCE lookup
 * (one textureCubeUV per standard fragment saved) and keeps the IBL RADIANCE
 * (specular) term, which is what makes a metal read as metal and what gives a
 * dielectric its faint Fresnel sky sheen at grazing angles.
 */

export type EnvPath = 'pmrem' | 'baked';

export const ENV_CUBE_SIZE: Record<EnvPath, number> = { pmrem: 128, baked: 32 };

/** A dropped capture can never come back faster than this. */
export const ENV_MIN_REFRESH_MS = 1500;

/** Steps per unit for each weight in the phase key (4 = quarter steps). */
export const ENV_PHASE_STEPS = 4;

/** Metalness at or above which the low path still samples the env map. */
export const ENV_BAKED_METAL_THRESHOLD = 0.5;

export function envPathFor(quality: RenderQuality, fillClass: GpuClass): EnvPath {
  return quality === 'low' || fillClass === 'mobile-gpu' ? 'baked' : 'pmrem';
}

export interface EnvPhaseInputs {
  day: number;
  twilight: number;
  night: number;
  storm: number;
  overcast: number;
}

/** Quantised sky state. Equal keys = a capture would look the same. */
export function envPhaseKey(p: EnvPhaseInputs): string {
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * ENV_PHASE_STEPS);
  return `d${q(p.day)}t${q(p.twilight)}n${q(p.night)}s${q(Math.max(p.storm, p.overcast * 0.8))}`;
}

const IRRADIANCE_LINE = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const RADIANCE_LINE = 'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';

/**
 * Rewrites three's lights_fragment_maps chunk once per page load, BEFORE any
 * program compiles (the tier never changes inside a page load). Idempotent.
 * Returns false if three's chunk text no longer matches (an upgrade moved it):
 * the env map then still works, it just also lights diffuse.
 */
export function patchEnvironmentChunk(path: EnvPath): boolean {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.lights_fragment_maps;
  if (src.includes('PBR_ENV_PATCHED')) return true;
  if (!src.includes(IRRADIANCE_LINE) || !src.includes(RADIANCE_LINE)) return false;
  const radiance = path === 'baked'
    // Dynamic branch on the fragment's own metalness: SwiftShader and phone
    // GPUs skip the two cubeUV taps for every quad with no metal in it.
    ? `#ifdef STANDARD
		if ( metalnessFactor >= ${ENV_BAKED_METAL_THRESHOLD.toFixed(2)} ) ${RADIANCE_LINE}
	#else
		${RADIANCE_LINE}
	#endif`
    : RADIANCE_LINE;
  chunks.lights_fragment_maps = `// PBR_ENV_PATCHED (${path})\n` + src
    .replace(IRRADIANCE_LINE, '// IBL irradiance intentionally off: the ambient/hemisphere rig is the sky diffuse (SkyEnvironment.ts)')
    .replace(RADIANCE_LINE, radiance);
  return true;
}

export interface EnvironmentStats {
  path: EnvPath;
  cubeSize: number;
  refreshes: number;
  key: string;
  lastRefreshMs: number;
  lastCaptureCostMs: number;
  chunkPatched: boolean;
}

export class SkyEnvironment {
  readonly path: EnvPath;
  readonly cubeSize: number;
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly captureScene = new THREE.Scene();
  private readonly captureMesh: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  private output: THREE.WebGLRenderTarget | null = null;
  private key = '';
  private refreshes = 0;
  private lastRefreshMs = -Infinity;
  private lastCaptureCostMs = 0;
  private readonly chunkPatched: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    skyMaterial: THREE.ShaderMaterial,
    quality: RenderQuality,
    fillClass: GpuClass,
  ) {
    this.path = envPathFor(quality, fillClass);
    this.cubeSize = ENV_CUBE_SIZE[this.path];
    this.chunkPatched = patchEnvironmentChunk(this.path);
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(this.cubeSize, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
    });
    this.cubeCamera = new THREE.CubeCamera(0.5, 50, this.cubeTarget);
    // The dome's own material: the vertex shader takes the direction from the
    // local position and pins depth to the far plane, so a 10 m sphere around
    // the cube camera draws exactly the sky the player sees.
    this.captureMesh = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial);
    this.captureMesh.frustumCulled = false;
    this.captureScene.add(this.captureMesh);
    this.captureScene.add(this.cubeCamera);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /** The PMREM texture (stable object across refreshes). */
  get texture(): THREE.Texture | null {
    return this.output?.texture ?? null;
  }

  /**
   * Capture now if the phase key moved (or on the first call). Returns true
   * when a capture ran. `uniforms` is the live sky material's uniforms; the
   * transient terms (lightning flash, underwater tint) are zeroed for the
   * capture and restored, so a bolt never gets baked into the metal.
   */
  update(key: string, uniforms: Record<string, THREE.IUniform>, nowMs: number, force = false): boolean {
    if (!force && this.output && key === this.key) return false;
    if (!force && this.output && nowMs - this.lastRefreshMs < ENV_MIN_REFRESH_MS) return false;
    const t0 = performance.now();
    const flash = uniforms.u_lightningFlash?.value as number | undefined;
    const under = uniforms.u_underwaterIntensity?.value as number | undefined;
    if (uniforms.u_lightningFlash) uniforms.u_lightningFlash.value = 0;
    if (uniforms.u_underwaterIntensity) uniforms.u_underwaterIntensity.value = 0;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = true;
      this.cubeCamera.update(this.renderer, this.captureScene);
      this.output = this.pmrem.fromCubemap(this.cubeTarget.texture, this.output);
    } finally {
      this.renderer.autoClear = prevAutoClear;
      this.renderer.setRenderTarget(prevTarget);
      if (uniforms.u_lightningFlash && flash !== undefined) uniforms.u_lightningFlash.value = flash;
      if (uniforms.u_underwaterIntensity && under !== undefined) uniforms.u_underwaterIntensity.value = under;
    }
    this.key = key;
    this.refreshes += 1;
    this.lastRefreshMs = nowMs;
    this.lastCaptureCostMs = performance.now() - t0;
    return true;
  }

  stats(): EnvironmentStats {
    return {
      path: this.path,
      cubeSize: this.cubeSize,
      refreshes: this.refreshes,
      key: this.key,
      lastRefreshMs: this.lastRefreshMs,
      lastCaptureCostMs: this.lastCaptureCostMs,
      chunkPatched: this.chunkPatched,
    };
  }

  dispose() {
    this.cubeTarget.dispose();
    this.output?.dispose();
    this.output = null;
    this.pmrem.dispose();
    this.captureMesh.geometry.dispose();
  }
}
