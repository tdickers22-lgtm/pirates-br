import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { RenderQuality } from './Renderer.js';

// Final grade runs after OutputPass, so it operates on tone-mapped sRGB values.
const GRADE_SHADER = {
  name: 'PirateGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    u_vignette: { value: 0.25 },
    u_saturation: { value: 1.07 },
    u_gamma: { value: 0.985 },
    u_lift: { value: new THREE.Vector3(0.006, 0.008, 0.013) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float u_vignette;
    uniform float u_saturation;
    uniform float u_gamma;
    uniform vec3 u_lift;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 col = max(texel.rgb, 0.0);
      // Gentle contrast shape + cool shadow lift.
      col = pow(col, vec3(u_gamma));
      col = col * (1.0 - u_lift) + u_lift;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = clamp(mix(vec3(luma), col, u_saturation), 0.0, 1.0);
      // Vignette
      float edge = smoothstep(0.42, 1.12, length(vUv - 0.5) * 1.55);
      col *= 1.0 - u_vignette * edge;
      gl_FragColor = vec4(col, texel.a);
    }
  `,
};

/**
 * Post-processing chain: RenderPass -> UnrealBloom -> OutputPass (ACES + sRGB)
 * -> FXAA (only when MSAA render targets are unavailable) -> grade/vignette (high only).
 * 'low' quality never constructs this class and keeps direct rendering.
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
      { type: THREE.HalfFloatType, samples: useMsaa ? 4 : 0 },
    );
    target.texture.name = 'PostFx.rt';

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.42, 0.55, 1.05));
    this.composer.addPass(new OutputPass());
    if (!useMsaa) {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaaPass);
    }
    if (quality === 'high') {
      this.composer.addPass(new ShaderPass(GRADE_SHADER));
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
