import * as THREE from 'three';
import { WAVE_PARAMS, getOceanRoughness } from '../../shared/utils/index.js';
import type { RenderQuality } from './Renderer.js';

const MAX_ISLANDS = 16;

// GLSL is generated from the shared WAVE_PARAMS so the rendered surface is the
// same field gameplay samples via gerstnerHeight(): vertical-only displacement,
// amplitude × getOceanRoughness(t), phase k·(d·p − speed·t). The only rendering
// liberties are a per-wave distance fade (keeps far coarse cells above Nyquist,
// sub-10cm and >90m from camera) and slight shore damping near islands.
const fmt = (n: number) => n.toFixed(6);

const WAVE_FIELD_GLSL = `
  // Returns vec3(height, dHeight/dx, dHeight/dz) of the shared Gerstner field.
  vec3 waveField(vec2 p, float camDist) {
    float h = 0.0; float dhx = 0.0; float dhz = 0.0;
    float f; float a; float c;
${WAVE_PARAMS.map((w) => {
  const len = Math.hypot(w.direction.x, w.direction.y);
  const dx = w.direction.x / len;
  const dz = w.direction.y / len;
  const k = (2 * Math.PI) / w.wavelength;
  const fadeStart = w.wavelength * 9;
  const fadeEnd = w.wavelength * 20;
  return `    f = ${fmt(k)} * (dot(vec2(${fmt(dx)}, ${fmt(dz)}), p) - ${fmt(w.speed)} * u_time);
    a = ${fmt(w.amplitude)} * u_roughness * (1.0 - smoothstep(${fmt(fadeStart)}, ${fmt(fadeEnd)}, camDist));
    h += a * sin(f);
    c = a * ${fmt(k)} * cos(f);
    dhx += c * ${fmt(dx)};
    dhz += c * ${fmt(dz)};`;
}).join('\n')}
    return vec3(h, dhx, dhz);
  }
`;

const SHORE_GLSL = `
  // Signed distance (m) to the nearest island waterline; huge when no islands.
  float shoreDist(vec2 p) {
    float d = 100000.0;
    for (int i = 0; i < ${MAX_ISLANDS}; i++) {
      if (i >= u_islandCount) break;
      vec3 isl = u_islands[i];
      d = min(d, length(p - isl.xy) - isl.z);
    }
    return d;
  }
`;

const OCEAN_VERT = /* glsl */`
  uniform float u_time;
  uniform float u_roughness;
  uniform vec3  u_cameraPos;
  uniform vec3  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;

  varying vec3  v_worldPos;
  varying float v_height;
  varying float v_shoreDamp;

  ${WAVE_FIELD_GLSL}
  ${SHORE_GLSL}

  void main() {
    // Grid tiles are children of a translated group: modelMatrix is a pure
    // translation snapped to the coarsest cell, so world lattice never swims.
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    float camDist = distance(u_cameraPos.xz, wp.xz);

    // Slight rendering-only wave damping in island shallows.
    v_shoreDamp = mix(0.6, 1.0, smoothstep(-8.0, 34.0, shoreDist(wp.xz)));

    float h = waveField(wp.xz, camDist).x * v_shoreDamp;
    wp.y += h;

    v_worldPos = wp;
    v_height   = h;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const OCEAN_FRAG = /* glsl */`
  uniform float u_time;
  uniform vec3  u_sunDir;
  uniform vec3  u_cameraPos;
  uniform float u_stormIntensity;
  uniform float u_underwaterDepth;
  uniform float u_roughness;
  uniform float u_nightFactor;
  uniform vec3  u_fogColor;
  uniform vec3  u_horizonColor;
  uniform vec3  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;

  varying vec3  v_worldPos;
  varying float v_height;
  varying float v_shoreDamp;

  ${WAVE_FIELD_GLSL}
  ${SHORE_GLSL}

  // Smooth pseudo-random for detail foam / ripples
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

  // Multi-octave scrolling height field used to derive fine ripple normals.
  // Shading detail only — it never moves geometry, so the visual surface still
  // matches the shared gerstnerHeight() the gameplay code samples.
  float rippleField(vec2 p) {
    float n = 0.0;
    n += noise(p * 0.60 + u_time * vec2( 0.06,  0.04)) * 0.60;
    n += noise(p * 1.70 - u_time * vec2( 0.05,  0.09)) * 0.28;
    n += noise(p * 4.10 + u_time * vec2( 0.11, -0.07)) * 0.14;
    return n;
  }

  void main() {
    vec2  wp = v_worldPos.xz;
    float camDist = distance(u_cameraPos.xz, wp);

    // Analytic per-pixel normal: displacement is vertical-only, so xz is
    // undistorted and the derivative field matches the drawn surface exactly.
    vec3 wf = waveField(wp, camDist);
    vec3 N = normalize(vec3(-wf.y * v_shoreDamp, 1.0, -wf.z * v_shoreDamp));

    vec3 V = normalize(u_cameraPos - v_worldPos);
    vec3 L = normalize(u_sunDir);

    // ── Fine ripple detail normals: fade with distance (specular AA) and
    //    flatten on glassy-calm days ─────────────────────────────────────
    float calm = clamp((u_roughness - 0.25) / 1.3, 0.0, 1.0);
    float detailFade = 1.0 - smoothstep(40.0, 560.0, camDist);
    if (detailFade > 0.001) {
      float e  = 0.85;
      float h0 = rippleField(wp);
      float hx = rippleField(wp + vec2(e, 0.0));
      float hz = rippleField(wp + vec2(0.0, e));
      float rippleAmp = (0.9 + 1.5 * calm) * detailFade;
      N = normalize(N + vec3(-(hx - h0), 0.0, -(hz - h0)) * rippleAmp);
    }

    // ── Base water color: deep troughs to lifted flanks ────────────────
    float hn = clamp(v_height / max(0.22, u_roughness * 0.70), -1.0, 1.0);
    float flank = clamp(hn * 0.32 + 0.5, 0.0, 1.0);
    vec3 deep   = vec3(0.008, 0.09, 0.28);
    vec3 lifted = vec3(0.045, 0.30, 0.50);
    vec3 base   = mix(deep, lifted, flank);

    // ── Shore shallows: turquoise ramp toward the beach ─────────────────
    float sd = shoreDist(wp);
    float shallowMask = 1.0 - smoothstep(4.0, 52.0, sd);
    vec3 shallowCol = mix(vec3(0.06, 0.46, 0.50), vec3(0.30, 0.68, 0.62), 1.0 - smoothstep(0.0, 14.0, sd));
    base = mix(base, shallowCol, shallowMask * 0.8 * (1.0 - u_stormIntensity * 0.55));

    // ── Fresnel reflectance toward sky/horizon ──────────────────────────
    float NdotV   = max(0.0, dot(N, V));
    float fresnel = 0.028 + 0.972 * pow(1.0 - NdotV, 5.0);
    // Warm reflection streak only when the sun sits low (sunrise/sunset).
    float sunLow  = 1.0 - smoothstep(0.16, 0.48, L.y);
    float sunUp   = smoothstep(-0.06, 0.10, L.y);
    float sunPath = pow(max(0.0, dot(normalize(vec3(V.x, 0.14, V.z)), normalize(vec3(L.x, 0.14, L.z)))), 5.0);
    vec3 reflCol = mix(vec3(0.38, 0.54, 0.82), u_horizonColor, 0.42);
    reflCol = mix(reflCol, vec3(1.0, 0.55, 0.30), sunPath * sunLow * 0.6);
    base = mix(base, reflCol, fresnel * 0.58);

    // ── Diffuse sun ─────────────────────────────────────────────────────
    float diff = max(0.0, dot(N, L));
    base *= 0.48 + diff * 0.62;

    // ── Blinn specular: lobe widens with distance (specular AA), energy
    //    drops with it, and the HDR result is clamped — no firefly noise ─
    vec3  H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    float lobeWiden = max(smoothstep(90.0, 1400.0, camDist), u_stormIntensity * 0.5);
    float shininess = mix(310.0, 46.0, lobeWiden);
    float spec  = pow(NdotH, shininess) * mix(3.0, 0.55, lobeWiden);
    float glare = pow(NdotH, 24.0) * 0.15;
    vec3 specCol = mix(vec3(1.0, 0.94, 0.80), vec3(1.0, 0.50, 0.28), sunPath * sunLow) * (spec + glare) * sunUp;
    specCol = min(specCol, vec3(1.8));
    specCol = mix(specCol, specCol * vec3(0.62, 0.74, 1.05), u_nightFactor);

    // ── Foam: noise-broken crests + animated shore band ────────────────
    float crest = pow(clamp(hn * 1.15 - 0.10, 0.0, 1.0), 3.0) * (0.55 + 0.45 * calm + u_stormIntensity * 0.5);
    vec2 foamUv = wp * 0.018 + u_time * vec2(0.012, 0.008);
    float foamN = noise(foamUv * 3.0) * noise(foamUv * 7.0 + 1.5);
    float breakup = mix(0.55, smoothstep(0.28, 0.62, foamN), detailFade * 0.85 + 0.15);
    float foam = clamp(crest * breakup * 1.4, 0.0, 1.0);

    float shoreDetail = 1.0 - smoothstep(260.0, 900.0, camDist);
    float lap = sin(sd * 0.5 - u_time * 1.3) * 0.5 + 0.5;
    float lapNoise = noise(wp * 0.3 + u_time * vec2(0.05, -0.04));
    float shoreBand = (1.0 - smoothstep(2.0, 17.0, sd)) * smoothstep(0.42, 0.86, lap * (0.55 + 0.45 * lapNoise));
    float waterline = 1.0 - smoothstep(0.0, 3.5, sd);
    float shoreFoam = max(shoreBand * (0.35 + 0.65 * shoreDetail), waterline * 0.85);
    foam = clamp(foam + shoreFoam, 0.0, 1.0);

    vec3 foamCol = vec3(0.88, 0.93, 1.0) * mix(1.0, 0.45, u_nightFactor);
    vec3 color = mix(base, foamCol, foam);

    // ── Subtle sub-surface scatter on lit wave flanks ───────────────────
    float sss = pow(max(0.0, dot(L, -N)), 3.0) * 0.14 * clamp(hn + 0.6, 0.0, 1.0);
    color += mix(vec3(0.05, 0.20, 0.26), vec3(0.24, 0.10, 0.20), sunPath * sunLow) * sss;

    color += specCol;

    // Night: dim the water body (fog/horizon colors arrive pre-dimmed)
    color *= mix(1.0, 0.34, u_nightFactor * (1.0 - foam * 0.4));

    // Storm: darker, desaturated water under gray skies
    vec3 stormTint = mix(vec3(1.0), vec3(0.42, 0.48, 0.55), u_stormIntensity);
    color *= stormTint;
    color = mix(color, color * vec3(0.72, 0.76, 0.82), u_stormIntensity * 0.55);

    // ── Aerial perspective + horizon dissolve: far water sinks into the
    //    fog color, then fully into the sky's horizon tint ───────────────
    float underwater = smoothstep(0.08, 1.8, u_underwaterDepth);
    float fogAmt     = (1.0 - exp(-camDist * mix(0.00042, 0.0017, u_stormIntensity))) * (1.0 - underwater);
    float horizonAmt = smoothstep(1250.0, 3000.0, camDist) * (1.0 - underwater);
    vec3 fogCol     = mix(u_fogColor, vec3(0.46, 0.51, 0.56), u_stormIntensity * 0.8);
    vec3 horizonCol = mix(u_horizonColor, vec3(0.44, 0.47, 0.51), u_stormIntensity * 0.85);
    color = mix(color, fogCol, fogAmt * 0.78);
    color = mix(color, horizonCol, horizonAmt);

    // From below, the ocean surface should read as a bright wavering ceiling instead
    // of disappearing due to back-face culling or using the above-water shader.
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

// Camera-centered concentric LOD grid. Hole extents are exact multiples of
// every level's cell size, and the whole grid snaps to the coarsest cell, so
// each level's vertices stay pinned to a fixed world lattice (no swimming)
// and level boundaries share vertex positions.
interface LodLevel { halfExtent: number; cell: number; hole: number }

const LOD_LEVELS: Record<RenderQuality, LodLevel[]> = {
  low: [ // ~13k verts
    { halfExtent: 192, cell: 6, hole: 0 },
    { halfExtent: 768, cell: 24, hole: 192 },
    { halfExtent: 3264, cell: 96, hole: 768 },
  ],
  balanced: [ // ~29k verts
    { halfExtent: 192, cell: 4, hole: 0 },
    { halfExtent: 768, cell: 16, hole: 192 },
    { halfExtent: 3264, cell: 64, hole: 768 },
  ],
  high: [ // ~117k verts
    { halfExtent: 192, cell: 2, hole: 0 },
    { halfExtent: 768, cell: 8, hole: 192 },
    { halfExtent: 3264, cell: 32, hole: 768 },
  ],
};

function buildRingGeometry(level: LodLevel): THREE.BufferGeometry {
  const { halfExtent, cell, hole } = level;
  const n = Math.round((halfExtent * 2) / cell);
  const vertsPerRow = n + 1;
  const positions = new Float32Array(vertsPerRow * vertsPerRow * 3);
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const o = (iz * vertsPerRow + ix) * 3;
      positions[o] = -halfExtent + ix * cell;
      positions[o + 1] = 0;
      positions[o + 2] = -halfExtent + iz * cell;
    }
  }
  const indices: number[] = [];
  const holeLimit = hole - cell * 0.5 + 1e-6;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const cx = -halfExtent + (ix + 0.5) * cell;
      const cz = -halfExtent + (iz + 0.5) * cell;
      if (Math.abs(cx) < holeLimit && Math.abs(cz) < holeLimit) continue; // cell fully inside finer level
      const a = iz * vertsPerRow + ix;
      const b = a + 1;
      const c = a + vertsPerRow;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

export interface OceanAtmosphere {
  fogColor?: THREE.Color;
  horizonColor?: THREE.Color;
  sunDir?: THREE.Vector3;
  storminess?: number;
  nightFactor?: number;
}

export class OceanRenderer {
  private group!: THREE.Group;
  private material!: THREE.ShaderMaterial;
  private time = 0;
  private snapSize = 64;
  private pendingIslands: Array<{ x: number; z: number; r: number }> | null = null;

  private readonly sunDir = new THREE.Vector3(0.62, 0.24, -0.74).normalize();

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    const levels = LOD_LEVELS[quality];
    this.snapSize = levels[levels.length - 1].cell;

    this.material = new THREE.ShaderMaterial({
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      uniforms: {
        u_time:      { value: 0 },
        u_roughness: { value: getOceanRoughness(0) },
        u_sunDir:    { value: this.sunDir.clone() },
        u_cameraPos: { value: new THREE.Vector3() },
        u_stormIntensity: { value: 0 },
        u_underwaterDepth: { value: 0 },
        u_nightFactor: { value: 0 },
        // Defaults match the sky shader's daytime horizon haze / scene fog so
        // the sea-sky junction is seamless before live values get wired in.
        u_fogColor:     { value: new THREE.Color(0x9bbfd4) },
        u_horizonColor: { value: new THREE.Color(0.78, 0.90, 0.98) },
        u_islands:     { value: Array.from({ length: MAX_ISLANDS }, () => new THREE.Vector3()) },
        u_islandCount: { value: 0 },
      },
      side: THREE.DoubleSide,
    });

    this.group = new THREE.Group();
    this.group.name = 'ocean-lod-grid';
    for (const level of levels) {
      const mesh = new THREE.Mesh(buildRingGeometry(level), this.material);
      mesh.frustumCulled = false; // always on screen; skips bad flat-geometry bounds vs displaced verts
      mesh.receiveShadow = false; // shadows on dynamic waves look odd
      this.group.add(mesh);
    }

    // Opaque deep-water sheet just under the surface: hides any sub-pixel
    // T-junction cracks at LOD seams. Front side only so it never occludes
    // the surface when the camera is underwater looking up.
    const underGeo = new THREE.PlaneGeometry(2400, 2400, 1, 1);
    underGeo.rotateX(-Math.PI / 2);
    const underlayer = new THREE.Mesh(
      underGeo,
      new THREE.MeshBasicMaterial({ color: 0x04182b }),
    );
    underlayer.position.y = -1.6;
    this.group.add(underlayer);

    scene.add(this.group);

    if (this.pendingIslands) {
      this.setIslands(this.pendingIslands);
      this.pendingIslands = null;
    }
  }

  update(dt: number, cameraPos?: THREE.Vector3) {
    this.time += dt;
    this.material.uniforms.u_time.value = this.time;
    this.material.uniforms.u_roughness.value = getOceanRoughness(this.time);
    if (cameraPos) {
      (this.material.uniforms.u_cameraPos.value as THREE.Vector3).copy(cameraPos);
      const s = this.snapSize;
      this.group.position.set(Math.round(cameraPos.x / s) * s, 0, Math.round(cameraPos.z / s) * s);
    }
  }

  getTime() { return this.time; }

  /** Snap the wave clock to server time; update(dt) keeps extrapolating between syncs. */
  setWaveTime(tSeconds: number) {
    this.time = tSeconds;
    if (this.material) {
      this.material.uniforms.u_time.value = this.time;
      this.material.uniforms.u_roughness.value = getOceanRoughness(this.time);
    }
  }

  setIslands(islands: Array<{ x: number; z: number; r: number }>) {
    if (!this.material) {
      this.pendingIslands = islands;
      return;
    }
    const arr = this.material.uniforms.u_islands.value as THREE.Vector3[];
    const count = Math.min(islands.length, MAX_ISLANDS);
    for (let i = 0; i < count; i++) {
      arr[i].set(islands[i].x, islands[i].z, islands[i].r);
    }
    this.material.uniforms.u_islandCount.value = count;
  }

  setAtmosphere(atmo: OceanAtmosphere) {
    if (!this.material) return;
    const u = this.material.uniforms;
    if (atmo.fogColor) (u.u_fogColor.value as THREE.Color).copy(atmo.fogColor);
    if (atmo.horizonColor) (u.u_horizonColor.value as THREE.Color).copy(atmo.horizonColor);
    if (atmo.sunDir) this.setSunDirection(atmo.sunDir);
    if (atmo.storminess !== undefined) this.setStormIntensity(atmo.storminess);
    if (atmo.nightFactor !== undefined) {
      u.u_nightFactor.value = Math.max(0, Math.min(1, atmo.nightFactor));
    }
  }

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
