import * as THREE from 'three';
import { WAVE_PARAMS, STORM_WAVE_PARAMS, getOceanRoughness } from '../../shared/utils/index.js';
import type { RenderQuality } from './Renderer.js';

const MAX_ISLANDS = 16;

// GLSL is generated from the shared WAVE_PARAMS / STORM_WAVE_PARAMS so the
// rendered surface is the same field gameplay samples via
// gerstnerHeight(x, z, t, WAVE_PARAMS, storm): vertical-only displacement,
// base amplitude × getOceanRoughness(t) × (1 + storm·0.85), plus the dedicated
// storm swell × storm, where storm is the shared getStormWaveIntensity()
// replicated exactly in stormWaveIntensity() below. The only rendering
// liberties are a per-wave distance fade (keeps far coarse cells above Nyquist,
// sub-10cm and >90m from camera) and slight shore damping near islands.
const fmt = (n: number) => n.toFixed(6);

const waveComponentGlsl = (
  w: { amplitude: number; wavelength: number; direction: { x: number; y: number }; speed: number },
  ampExpr: string,
  indent: string,
) => {
  const len = Math.hypot(w.direction.x, w.direction.y);
  const dx = w.direction.x / len;
  const dz = w.direction.y / len;
  const k = (2 * Math.PI) / w.wavelength;
  const fadeStart = w.wavelength * 9;
  const fadeEnd = w.wavelength * 20;
  return `${indent}f = ${fmt(k)} * (dot(vec2(${fmt(dx)}, ${fmt(dz)}), p) - ${fmt(w.speed)} * u_time);
${indent}a = ${fmt(w.amplitude)} * ${ampExpr} * (1.0 - smoothstep(${fmt(fadeStart)}, ${fmt(fadeEnd)}, camDist));
${indent}h += a * sin(f);
${indent}c = a * ${fmt(k)} * cos(f);
${indent}dhx += c * ${fmt(dx)};
${indent}dhz += c * ${fmt(dz)};`;
};

const WAVE_FIELD_GLSL = `
  // Local storm sea-state in 0..1 — EXACT GLSL replica of the shared
  // getStormWaveIntensity(): full swell inside the deadly ring, ramp across a
  // 180m band around its edge, late-phase ambient chop everywhere.
  // u_stormSafeRadius < 0 means "no storm" (matches storm == null on the CPU).
  float stormWaveIntensity(vec2 p) {
    if (u_stormSafeRadius < -0.5) return 0.0;
    float distOutside = length(p - u_stormCenter) - u_stormSafeRadius;
    float edge = smoothstep(-140.0, 40.0, distOutside);
    float ambient = u_stormPhase01 * 0.38;
    return clamp(max(edge * (0.55 + u_stormPhase01 * 0.45), ambient), 0.0, 1.0);
  }

  // Returns vec3(height, dHeight/dx, dHeight/dz) of the shared Gerstner field
  // gerstnerHeight(x, z, t, WAVE_PARAMS, storm). Identical GLSL runs in both
  // the vertex and fragment stages so analytic normals match displacement.
  vec3 waveField(vec2 p, float camDist) {
    float storm = stormWaveIntensity(p);
    float rough = u_roughness * (1.0 + storm * 0.85);
    float h = 0.0; float dhx = 0.0; float dhz = 0.0;
    float f; float a; float c;
${WAVE_PARAMS.map((w) => waveComponentGlsl(w, 'rough', '    ')).join('\n')}
    if (storm > 0.0) {
${STORM_WAVE_PARAMS.map((w) => waveComponentGlsl(w, 'storm', '      ')).join('\n')}
    }
    return vec3(h, dhx, dhz);
  }
`;

const SHORE_GLSL = `
  // Approx signed distance (m) to the nearest island waterline. Each island is
  // an elliptical footprint vec4(centerX, centerZ, rx, rz); the normalized
  // ellipse distance is rescaled to meters by the minor half-extent, which is
  // exact on the minor axis and slightly conservative on the major one.
  float shoreDist(vec2 p) {
    float d = 100000.0;
    for (int i = 0; i < ${MAX_ISLANDS}; i++) {
      if (i >= u_islandCount) break;
      vec4 isl = u_islands[i];
      vec2 q = (p - isl.xy) / isl.zw;
      d = min(d, (length(q) - 1.0) * min(isl.z, isl.w));
    }
    return d;
  }
`;

const OCEAN_VERT = /* glsl */`
  uniform float u_time;
  uniform float u_roughness;
  uniform vec3  u_cameraPos;
  uniform vec4  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;
  uniform vec2  u_stormCenter;
  uniform float u_stormSafeRadius;
  uniform float u_stormPhase01;

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

    // Slight rendering-only wave damping in island shallows. Floor kept at
    // 0.85 so the drawn surface stays within ~15% of the shared physics field
    // (which applies no shore damping yet — see INTEGRATION_NOTES).
    v_shoreDamp = mix(0.85, 1.0, smoothstep(-8.0, 34.0, shoreDist(wp.xz)));

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
  uniform vec4  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;
  uniform vec2  u_stormCenter;
  uniform float u_stormSafeRadius;
  uniform float u_stormPhase01;

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

    // Local storm sea-state (same value waveField used for displacement).
    float stormSea = stormWaveIntensity(wp);

    vec3 V = normalize(u_cameraPos - v_worldPos);
    vec3 L = normalize(u_sunDir);

    // ── Fine ripple detail normals: fade with distance (specular AA),
    //    flatten on gentle days, churn harder inside the storm ──────────
    float calm = clamp((u_roughness - 0.55) / 1.05, 0.0, 1.0);
    float detailFade = 1.0 - smoothstep(40.0, 560.0, camDist);
    if (detailFade > 0.001) {
      float e  = 0.85;
      float h0 = rippleField(wp);
      float hx = rippleField(wp + vec2(e, 0.0));
      float hz = rippleField(wp + vec2(0.0, e));
      float rippleAmp = (0.9 + 1.5 * calm + 1.1 * stormSea) * detailFade;
      N = normalize(N + vec3(-(hx - h0), 0.0, -(hz - h0)) * rippleAmp);
    }

    // ── Base water color: deep troughs to lifted flanks. Height is
    //    normalized against the storm-boosted expected swell so hn keeps
    //    tracking crest/trough across sea states; storm steepens the
    //    trough/crest contrast and pulls the palette slate-dark ──────────
    float ampNorm = u_roughness * 0.70 * (1.0 + stormSea * 0.85) + stormSea * 1.85;
    float hn = clamp(v_height / max(0.22, ampNorm), -1.0, 1.0);
    float flank = clamp(hn * (0.32 + 0.18 * stormSea) + 0.5, 0.0, 1.0);
    vec3 deep   = mix(vec3(0.008, 0.09, 0.28), vec3(0.004, 0.045, 0.15), stormSea);
    vec3 lifted = mix(vec3(0.045, 0.30, 0.50), vec3(0.11, 0.33, 0.44), stormSea);
    vec3 base   = mix(deep, lifted, flank);

    // ── Shore shallows: turquoise ramp toward the beach ─────────────────
    float sd = shoreDist(wp);
    float shallowMask = 1.0 - smoothstep(4.0, 52.0, sd);
    // Richer, slightly deeper turquoise so shallows read as tropical water, not a
    // pale wash that the specular then blows to white.
    vec3 shallowCol = mix(vec3(0.04, 0.40, 0.50), vec3(0.10, 0.62, 0.62), 1.0 - smoothstep(0.0, 14.0, sd));
    base = mix(base, shallowCol, shallowMask * 0.9 * (1.0 - u_stormIntensity * 0.55));

    // ── Fresnel reflectance toward sky/horizon ──────────────────────────
    float NdotV   = max(0.0, dot(N, V));
    float fresnel = 0.028 + 0.972 * pow(1.0 - NdotV, 5.0);
    // Warm reflection streak only when the sun sits low (sunrise/sunset).
    float sunLow  = 1.0 - smoothstep(0.16, 0.48, L.y);
    float sunUp   = smoothstep(-0.06, 0.10, L.y);
    float sunPath = pow(max(0.0, dot(normalize(vec3(V.x, 0.14, V.z)), normalize(vec3(L.x, 0.14, L.z)))), 5.0);
    vec3 reflCol = mix(vec3(0.38, 0.54, 0.82), u_horizonColor, 0.42);
    reflCol = mix(reflCol, vec3(1.0, 0.55, 0.30), sunPath * sunLow * 0.6);
    base = mix(base, reflCol, fresnel * 0.42);

    // ── Diffuse sun ─────────────────────────────────────────────────────
    float diff = max(0.0, dot(N, L));
    base *= 0.48 + diff * 0.62;

    // ── Blinn specular: lobe widens with distance (specular AA), energy
    //    drops with it, and the HDR result is clamped — no firefly noise ─
    vec3  H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    float lobeWiden = max(smoothstep(90.0, 1400.0, camDist), u_stormIntensity * 0.5);
    float shininess = mix(310.0, 46.0, lobeWiden);
    float spec  = pow(NdotH, shininess) * mix(1.9, 0.5, lobeWiden);
    float glare = pow(NdotH, 24.0) * 0.1;
    vec3 specCol = mix(vec3(1.0, 0.94, 0.80), vec3(1.0, 0.50, 0.28), sunPath * sunLow) * (spec + glare) * sunUp;
    specCol = min(specCol, vec3(1.15));
    specCol = mix(specCol, specCol * vec3(0.62, 0.74, 1.05), u_nightFactor);

    // ── Foam: noise-broken crests + animated shore band. Storm lowers the
    //    breaking threshold and softens the exponent so whitecap coverage
    //    grows dramatically as the sea state rises ─────────────────────────
    // Whitecap coverage thins with distance in a storm — full-strength crest
    // foam at every range merged into a horizon-wide ice sheet (patrol-1).
    float stormFoamFade = 1.0 - smoothstep(220.0, 1400.0, camDist) * max(u_stormIntensity, stormSea) * 0.8;
    // Only the STEEPEST crests break into whitecaps on a calm/moderate sea, so
    // open water reads as clear blue with sparse foam — not a dense grid of
    // whitecaps on every wave. Storms still lower the threshold for full coverage.
    float crest = pow(clamp(hn * (1.15 + 0.35 * stormSea) - (0.30 - 0.24 * stormSea), 0.0, 1.0), 3.4 - 1.6 * stormSea)
                * (0.5 + 0.5 * calm + u_stormIntensity * 0.4 + stormSea * 0.5) * stormFoamFade;
    vec2 foamUv = wp * 0.018 + u_time * vec2(0.012, 0.008);
    float foamN = noise(foamUv * 3.0) * noise(foamUv * 7.0 + 1.5);
    // Break foam up harder (lower floor) so whitecaps are irregular, not a lattice.
    float breakup = mix(0.32, smoothstep(0.30 - 0.14 * stormSea, 0.66, foamN), detailFade * 0.9 + 0.1);
    float foam = clamp(crest * breakup * 1.15, 0.0, 1.0);

    float shoreDetail = 1.0 - smoothstep(260.0, 900.0, camDist);
    float lap = sin(sd * 0.5 - u_time * 1.3) * 0.5 + 0.5;
    float lapNoise = noise(wp * 0.3 + u_time * vec2(0.05, -0.04));
    float shoreBand = (1.0 - smoothstep(2.0, 11.0, sd)) * smoothstep(0.5, 0.9, lap * (0.55 + 0.45 * lapNoise));
    float waterline = 1.0 - smoothstep(0.0, 2.2, sd);
    float shoreFoam = max(shoreBand * (0.3 + 0.6 * shoreDetail), waterline * 0.55);
    foam = clamp(foam + shoreFoam, 0.0, 1.0);

    vec3 foamCol = vec3(0.88, 0.93, 1.0) * mix(1.0, 0.45, u_nightFactor);
    vec3 color = mix(base, foamCol, foam);

    // ── Storm spray: wind-torn white haze over the wave tops, present even
    //    where the crest-foam noise breaks up ─────────────────────────────
    float spray = stormSea * smoothstep(0.20, 0.80, hn) * (0.40 + 0.60 * smoothstep(0.15, 0.50, foamN));
    color = mix(color, foamCol * 0.92, clamp(spray, 0.0, 1.0) * 0.55);

    // ── Subtle sub-surface scatter on lit wave flanks ───────────────────
    float sss = pow(max(0.0, dot(L, -N)), 3.0) * 0.14 * clamp(hn + 0.6, 0.0, 1.0);
    color += mix(vec3(0.05, 0.20, 0.26), vec3(0.24, 0.10, 0.20), sunPath * sunLow) * sss;

    // Calm, flat shallow water near shore was reflecting the overhead sun as a
    // broad white sheen — a blinding halo/lagoon plate. Damp the specular in the
    // shallows so tropical water keeps its turquoise instead of blowing out.
    color += specCol * (1.0 - shallowMask * 0.62);

    // Night: dim the water body (fog/horizon colors arrive pre-dimmed)
    color *= mix(1.0, 0.42, u_nightFactor * (1.0 - foam * 0.4) * (1.0 - shallowMask * 0.4));

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

/** Island footprint for the shoreline SDF. Preferred: elliptical half-extents
 *  rx/rz in meters (radius × profile.footprintX/Z). Legacy circular `r` is
 *  still accepted and treated as rx = rz = r. */
export interface OceanIslandFootprint {
  x: number;
  z: number;
  r?: number;
  rx?: number;
  rz?: number;
}

interface StormSeaState { centerX: number; centerZ: number; safeRadius: number; phase01: number }

export class OceanRenderer {
  private group!: THREE.Group;
  private material!: THREE.ShaderMaterial;
  private time = 0;
  private snapSize = 64;
  private pendingIslands: OceanIslandFootprint[] | null = null;
  private pendingStorm: StormSeaState | null = null;

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
        u_islands:     { value: Array.from({ length: MAX_ISLANDS }, () => new THREE.Vector4(0, 0, 1, 1)) },
        u_islandCount: { value: 0 },
        // Storm sea-state (shared getStormWaveIntensity inputs). Negative
        // safe radius = no storm, matching storm == null on the CPU side.
        u_stormCenter:     { value: new THREE.Vector2() },
        u_stormSafeRadius: { value: -1 },
        u_stormPhase01:    { value: 0 },
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
    // the surface when the camera is underwater looking up. Sits below the
    // deepest storm trough (~-5.6m at storm=1) so it never pokes through.
    const underGeo = new THREE.PlaneGeometry(2400, 2400, 1, 1);
    underGeo.rotateX(-Math.PI / 2);
    const underlayer = new THREE.Mesh(
      underGeo,
      new THREE.MeshBasicMaterial({ color: 0x04182b }),
    );
    underlayer.position.y = -6.5;
    this.group.add(underlayer);

    scene.add(this.group);

    if (this.pendingIslands) {
      this.setIslands(this.pendingIslands);
      this.pendingIslands = null;
    }
    if (this.pendingStorm) {
      const s = this.pendingStorm;
      this.pendingStorm = null;
      this.setStormState(s.centerX, s.centerZ, s.safeRadius, s.phase01);
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

  /** Feed island footprints for the shoreline SDF (foam band, shallows ramp,
   *  shore damping). Accepts elliptical {x, z, rx, rz} entries; legacy
   *  {x, z, r} circles still work (rx = rz = r). */
  setIslands(islands: OceanIslandFootprint[]) {
    if (!this.material) {
      this.pendingIslands = islands;
      return;
    }
    const arr = this.material.uniforms.u_islands.value as THREE.Vector4[];
    const count = Math.min(islands.length, MAX_ISLANDS);
    for (let i = 0; i < count; i++) {
      const isl = islands[i];
      const rx = Math.max(1, isl.rx ?? isl.r ?? 1);
      const rz = Math.max(1, isl.rz ?? isl.r ?? 1);
      arr[i].set(isl.x, isl.z, rx, rz);
    }
    this.material.uniforms.u_islandCount.value = count;
  }

  /** Drive the storm SEA STATE (wave geometry) from replicated storm data —
   *  mirrors shared getStormWaveIntensity(), so pass the same inputs gameplay
   *  physics uses: storm center, current safeRadius, and
   *  phase01 = clamp((storm.phase - 1) / 6, 0, 1). Pass a negative safeRadius
   *  (or call clearStormState) when there is no storm. This is separate from
   *  setStormIntensity, which only tints the water for local weather. */
  setStormState(centerX: number, centerZ: number, safeRadius: number, phase01: number) {
    if (!this.material) {
      this.pendingStorm = { centerX, centerZ, safeRadius, phase01 };
      return;
    }
    const u = this.material.uniforms;
    (u.u_stormCenter.value as THREE.Vector2).set(centerX, centerZ);
    u.u_stormSafeRadius.value = safeRadius;
    u.u_stormPhase01.value = Math.max(0, Math.min(1, phase01));
  }

  /** Return the sea to its calm (no-storm) state. */
  clearStormState() {
    this.setStormState(0, 0, -1, 0);
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

  /** Local-weather storm COLOR intensity (darken/desaturate tint, wider spec
   *  lobe, denser fog). Wave GEOMETRY is driven by setStormState instead. */
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
