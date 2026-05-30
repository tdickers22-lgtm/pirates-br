import * as THREE from 'three';
import type { RenderQuality } from './Renderer.js';

const OCEAN_VERT = /* glsl */`
  uniform float u_time;

  varying vec2  v_uv;
  varying vec3  v_normal;
  varying vec3  v_worldPos;
  varying float v_height;

  #define PI 3.14159265

  // Gerstner wave: returns position offset
  vec3 gerstner(vec3 pos, float A, float L, vec2 dir, float speed) {
    float k = 2.0 * PI / L;
    float f = k * (dot(normalize(dir), pos.xz) - speed * u_time);
    float Q = 0.42;
    return vec3(
      Q * A * normalize(dir).x * cos(f),
      A * sin(f),
      Q * A * normalize(dir).y * cos(f)
    );
  }

  // Gerstner wave partial derivative for normal computation
  vec3 gerstnerDx(vec3 pos, float A, float L, vec2 dir, float speed) {
    vec2  d = normalize(dir);
    float k = 2.0 * PI / L;
    float f = k * (dot(d, pos.xz) - speed * u_time);
    float Q = 0.42;
    return vec3(
      -Q * A * k * d.x * d.x * sin(f),
       A * k * d.x * cos(f),
      -Q * A * k * d.x * d.y * sin(f)
    );
  }

  vec3 gerstnerDz(vec3 pos, float A, float L, vec2 dir, float speed) {
    vec2  d = normalize(dir);
    float k = 2.0 * PI / L;
    float f = k * (dot(d, pos.xz) - speed * u_time);
    float Q = 0.42;
    return vec3(
      -Q * A * k * d.y * d.x * sin(f),
       A * k * d.y * cos(f),
      -Q * A * k * d.y * d.y * sin(f)
    );
  }

  void main() {
    v_uv = uv;

    vec3 p = position;

    // Four layered Gerstner waves
    vec3 w1 = gerstner(p, 0.24, 86.0, vec2(1.0,  0.4), 5.6);
    vec3 w2 = gerstner(p, 0.14, 52.0, vec2(-0.5, 1.0), 4.6);
    vec3 w3 = gerstner(p, 0.08, 34.0, vec2( 0.8,-0.6), 6.5);
    vec3 w4 = gerstner(p, 0.04, 20.0, vec2(-0.3,-0.9), 7.4);

    p += w1 + w2 + w3 + w4;
    v_height   = p.y;
    v_worldPos = p;

    // Analytic normal from wave derivatives
    vec3 dx = vec3(1.0, 0.0, 0.0)
      + gerstnerDx(position, 0.24, 86.0, vec2(1.0,  0.4), 5.6)
      + gerstnerDx(position, 0.14, 52.0, vec2(-0.5, 1.0), 4.6)
      + gerstnerDx(position, 0.08, 34.0, vec2( 0.8,-0.6), 6.5)
      + gerstnerDx(position, 0.04, 20.0, vec2(-0.3,-0.9), 7.4);

    vec3 dz = vec3(0.0, 0.0, 1.0)
      + gerstnerDz(position, 0.24, 86.0, vec2(1.0,  0.4), 5.6)
      + gerstnerDz(position, 0.14, 52.0, vec2(-0.5, 1.0), 4.6)
      + gerstnerDz(position, 0.08, 34.0, vec2( 0.8,-0.6), 6.5)
      + gerstnerDz(position, 0.04, 20.0, vec2(-0.3,-0.9), 7.4);

    v_normal = normalize(cross(dz, dx));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const OCEAN_FRAG = /* glsl */`
  uniform float u_time;
  uniform vec3  u_sunDir;
  uniform vec3  u_cameraPos;
  uniform float u_stormIntensity;
  uniform float u_underwaterDepth;

  varying vec2  v_uv;
  varying vec3  v_normal;
  varying vec3  v_worldPos;
  varying float v_height;

  #define PI 3.14159265

  // Smooth pseudo-random for detail foam
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i),
          b = hash(i + vec2(1,0)),
          c = hash(i + vec2(0,1)),
          d = hash(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
  }

  void main() {
    vec3 N = normalize(v_normal);
    vec3 V = normalize(u_cameraPos - v_worldPos);
    vec3 L = normalize(u_sunDir);
    vec3 H = normalize(L + V);

    // ── Base water color (deep/shallow blend) ──────────────────
    float depth = clamp(v_height * 0.38 + 0.5, 0.0, 1.0);
    vec3 deep    = vec3(0.01, 0.07, 0.24);
    vec3 shallow = vec3(0.04, 0.24, 0.46);
    vec3 base    = mix(deep, shallow, depth);

    // ── Fresnel reflectance ────────────────────────────────────
    float NdotV  = max(0.0, dot(N, V));
    float fresnel = 0.032 + (1.0 - 0.032) * pow(1.0 - NdotV, 5.0);
    // sky reflection tint: blue base with warm sunset streaks near the sun path
    float sunPath = pow(max(0.0, dot(normalize(vec3(V.x, 0.12, V.z)), normalize(vec3(L.x, 0.12, L.z)))), 4.0);
    vec3 reflCol = mix(vec3(0.42, 0.56, 0.86), vec3(1.0, 0.58, 0.34), 0.32 + sunPath * 0.38);
    base = mix(base, reflCol, fresnel * 0.62);

    // ── Sun specular (sharp highlight) ────────────────────────
    float NdotH  = max(0.0, dot(N, H));
    float spec   = pow(NdotH, 260.0) * 3.8;
    float glare  = pow(NdotH, 28.0)  * 0.18;
    vec3 specCol = mix(vec3(1.0, 0.92, 0.74), vec3(1.0, 0.40, 0.22), sunPath) * (spec + glare);

    // ── Diffuse sun ───────────────────────────────────────────
    float diff = max(0.0, dot(N, L));
    base *= 0.45 + diff * 0.68;

    // ── Wave-crest foam ───────────────────────────────────────
    float crest = pow(clamp(v_height * 0.48, 0.0, 1.0), 3.2);

    // Animated detail foam using noise
    vec2 foamUv = v_worldPos.xz * 0.018 + u_time * vec2(0.012, 0.008);
    float foamN = noise(foamUv * 3.0) * noise(foamUv * 7.0 + 1.5);
    float foamDetail = smoothstep(0.35, 0.62, foamN);
    float foam = clamp(crest * 0.85 + foamDetail * crest * 0.55, 0.0, 1.0);

    // Foam color (slightly bluish-white to feel wet)
    vec3 foamCol = vec3(0.88, 0.93, 1.0);
    vec3 color = mix(base, foamCol, foam);

    // ── Sub-surface scatter tint (wave flanks) ────────────────
    float sss = pow(max(0.0, dot(L, -N)), 3.0) * 0.12;
    color += mix(vec3(0.06, 0.18, 0.28), vec3(0.22, 0.09, 0.24), sunPath * 0.65) * sss;
    color += vec3(0.95, 0.28, 0.18) * sunPath * fresnel * 0.18 * (1.0 - u_stormIntensity);

    color += specCol;

    // Storm: darker, desaturated water under gray skies
    vec3 stormTint = mix(vec3(1.0), vec3(0.42, 0.48, 0.55), u_stormIntensity);
    color *= stormTint;
    color = mix(color, color * vec3(0.72, 0.76, 0.82), u_stormIntensity * 0.55);

    // From below, the ocean surface should read as a bright wavering ceiling instead
    // of disappearing due to back-face culling or using the above-water shader.
    float underwater = smoothstep(0.08, 1.8, u_underwaterDepth);
    if (underwater > 0.0) {
      float underside = step(u_cameraPos.y, v_worldPos.y + 0.05);
      float caustic = noise(v_worldPos.xz * 0.055 + u_time * vec2(0.05, -0.035));
      vec3 undersideColor = mix(vec3(0.02, 0.20, 0.31), vec3(0.20, 0.74, 0.86), fresnel * 0.72 + caustic * 0.12);
      undersideColor += vec3(0.05, 0.18, 0.22) * pow(max(0.0, dot(N, L)), 2.0);
      color = mix(color, mix(color, undersideColor, underside), underwater);
      color *= mix(vec3(1.0), vec3(0.48, 0.78, 0.9), underwater * (1.0 - underside) * 0.55);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class OceanRenderer {
  private mesh!: THREE.Mesh;
  private material!: THREE.ShaderMaterial;
  private time = 0;

  private readonly sunDir = new THREE.Vector3(0.62, 0.24, -0.74).normalize();

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    const segments = quality === 'low' ? 48 : quality === 'balanced' ? 64 : 96;
    const geo = new THREE.PlaneGeometry(3200, 3200, segments, segments);
    geo.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      uniforms: {
        u_time:      { value: 0 },
        u_sunDir:    { value: this.sunDir.clone() },
        u_cameraPos: { value: new THREE.Vector3() },
        u_stormIntensity: { value: 0 },
        u_underwaterDepth: { value: 0 },
      },
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = false; // shadows on dynamic waves look odd
    scene.add(this.mesh);
  }

  update(dt: number, cameraPos?: THREE.Vector3) {
    this.time += dt;
    this.material.uniforms.u_time.value = this.time;
    if (cameraPos) {
      (this.material.uniforms.u_cameraPos.value as THREE.Vector3).copy(cameraPos);
    }
  }

  getTime() { return this.time; }

  setStormIntensity(intensity: number) {
    const t = Math.max(0, Math.min(1, intensity));
    this.material.uniforms.u_stormIntensity.value = t;
  }

  setSunDirection(direction: THREE.Vector3) {
    this.sunDir.copy(direction).normalize();
    (this.material.uniforms.u_sunDir.value as THREE.Vector3).copy(this.sunDir);
  }

  setUnderwaterDepth(depth: number) {
    this.material.uniforms.u_underwaterDepth.value = Math.max(0, depth);
  }
}
