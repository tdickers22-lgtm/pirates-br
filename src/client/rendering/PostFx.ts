import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { RenderQuality } from './Renderer.js';

// ── THE GRADE IS NOT A PASS ──────────────────────────────────────────────────
// It used to be its own ShaderPass after OutputPass: one more full-screen quad,
// 518,400 fragments and a whole read+write of a 960x540 HalfFloat target every
// frame, to do four ALU operations on a colour OutputPass had just finished
// writing. The post chain measured 2,030,220 fragments — 3.92 whole screens,
// more than the entire main pass — and this was a quarter of the full-resolution
// part of it.
//
// So it is spliced INTO OutputPass instead (see `makeOutputPass`): same
// arithmetic, same place in the chain — after tone mapping and after the sRGB
// transfer, exactly where it was authored to run — for zero extra fragments.
const GRADE_UNIFORMS = /* glsl */`
  uniform float u_vignette;
  uniform float u_saturation;
  uniform float u_gamma;
  uniform vec3 u_lift;
`;

const GRADE_BODY = /* glsl */`
  {
    vec3 col = max(gl_FragColor.rgb, 0.0);
    // Gentle contrast shape + cool shadow lift.
    col = pow(col, vec3(u_gamma));
    col = col * (1.0 - u_lift) + u_lift;
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3(luma), col, u_saturation), 0.0, 1.0);
    // Vignette
    float edge = smoothstep(0.42, 1.12, length(vUv - 0.5) * 1.55);
    col *= 1.0 - u_vignette * edge;
    gl_FragColor.rgb = col;
  }
`;

/**
 * OutputPass with the grade folded in. `OutputShader` is a RawShaderMaterial —
 * no uniform is declared for you — so the four grade uniforms are declared and
 * registered by hand, and the body is appended after `SRGB_TRANSFER` so it still
 * operates on tone-mapped sRGB values, which is what it was tuned against.
 *
 * OutputPass rebuilds `material.defines` and sets `needsUpdate` whenever the
 * renderer's tone mapping or output colour space changes. That recompiles from
 * `material.fragmentShader`, which is the patched one, so the grade survives it.
 */
function makeOutputPass(graded: boolean): OutputPass {
  const pass = new OutputPass();
  if (!graded) return pass;
  const material = pass.material as THREE.RawShaderMaterial;
  // OutputPass writes tDiffuse/toneMappingExposure through `pass.uniforms`
  // every frame, and the material shares that object — so the grade uniforms go
  // into the same one rather than replacing it.
  Object.assign(material.uniforms, {
    u_vignette: { value: 0.25 },
    u_saturation: { value: 1.07 },
    u_gamma: { value: 0.985 },
    u_lift: { value: new THREE.Vector3(0.006, 0.008, 0.013) },
  });
  material.fragmentShader = material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', `uniform sampler2D tDiffuse;\n${GRADE_UNIFORMS}`)
    .replace(/\}\s*$/, `${GRADE_BODY}\n}`);
  return pass;
}

/**
 * Post-processing chain: RenderPass -> UnrealBloom -> OutputPass (ACES + sRGB,
 * plus the grade/vignette at `high`) -> FXAA (only when MSAA render targets are
 * unavailable). 'low' quality never constructs this class and keeps direct
 * rendering.
 *
 * Everything here is sized off the composer's pixel ratio, so the whole chain
 * follows the governor's resolution ladder down: `EffectComposer.setSize`
 * multiplies by `_pixelRatio` before it hands a size to any pass, and
 * `setPixelRatio` re-runs it. There is no full-screen target in the game that
 * renders at native resolution while the main pass does not.
 */
export class PostFx {
  private readonly composer: EffectComposer;
  private readonly fxaaPass: ShaderPass | null = null;
  private width: number;
  private height: number;
  private pixelRatio: number;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: RenderQuality) {
    const size = renderer.getSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    this.pixelRatio = renderer.getPixelRatio();

    // MSAA render targets need WebGL2; balanced always prefers cheaper FXAA.
    const useMsaa = quality === 'high' && renderer.capabilities.isWebGL2;
    const target = new THREE.WebGLRenderTarget(
      Math.round(this.width * this.pixelRatio),
      Math.round(this.height * this.pixelRatio),
      // 2x, NOT 4x. EffectComposer keeps TWO of these and ping-pongs between
      // them, so the sample count is paid twice in residency and once more, per
      // frame, in the resolve: at 4x that was 21.8 MB each resident (43.6 MB of
      // the tier's 160.5 MB of render targets) and ~16.6 MB read → 4.1 MB
      // written every frame just to collapse the samples. 2x halves all three.
      // What it costs to look at is one step of edge gradation on a chain that
      // is followed by a bloom and a grade; what 4x was buying on a 0.62-ratio
      // framebuffer was mostly being resolved away again.
      { type: THREE.HalfFloatType, samples: useMsaa ? 2 : 0 },
    );
    target.texture.name = 'PostFx.rt';

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.42, 0.55, 1.05));
    // The grade rides inside OutputPass rather than following it — see above.
    this.composer.addPass(makeOutputPass(quality === 'high'));
    if (!useMsaa) {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaaPass);
    }
    this.setPixelRatio(this.pixelRatio);
  }

  setSize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer.setSize(this.width, this.height);
    this.syncResolution();
  }

  setPixelRatio(ratio: number) {
    this.pixelRatio = Math.max(0.1, ratio);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    this.syncResolution();
  }

  render() {
    this.composer.render();
  }

  private syncResolution() {
    if (!this.fxaaPass) return;
    const resolution = this.fxaaPass.material.uniforms.resolution.value as THREE.Vector2;
    resolution.set(1 / (this.width * this.pixelRatio), 1 / (this.height * this.pixelRatio));
  }
}
