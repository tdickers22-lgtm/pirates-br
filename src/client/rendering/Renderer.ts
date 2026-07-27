import * as THREE from 'three';
import { PostFx } from './PostFx.js';
import { initLightBudget, updateLightBudget } from './LightBudget.js';
import { freezeStaticParent } from './three-util.js';
import { clamp, smoothstep } from '../../shared/utils/index.js';

export type RenderQuality = 'low' | 'balanced' | 'high';

const DAY_NIGHT_CYCLE_SECONDS = 960; // slower cycle: dusk is a scene, not a flash
const DAY_NIGHT_START_OFFSET = 0.47;

/** Below this, with resolution already on the floor, the startup tier is simply
 *  wrong for this machine and the runtime ladder starts giving quality back.
 *  Set well under the 47fps the resolution scaler chases: this rung is for a
 *  machine that cannot cope at all, not one having a rough few seconds. */
const DISTRESS_FPS = 28;
/** Seconds under DISTRESS_FPS, at the floor, before a rung is spent. Long on
 *  purpose — the cost of escalating too eagerly is a visibly softer image. */
const DISTRESS_DWELL_SECONDS = 6.9;

const SKY_VERT = /* glsl */`
  varying vec3 v_dir;
  void main() {
    v_dir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Sky is authored in display-referred values, then shaped to linear at the end so the
// same shader looks identical through the post chain (OutputPass) and direct rendering
// (in-shader tonemapping/colorspace chunks) on 'low'.
const SKY_FRAG = /* glsl */`
  varying vec3 v_dir;
  uniform vec3 u_sunDir;
  uniform float u_stormIntensity;
  uniform float u_underwaterIntensity;
  // Lightning: 0..1 strike envelope + the world direction toward the bolt, so
  // the cloud deck lights from inside and the flash has an azimuth.
  uniform float u_lightningFlash;
  uniform vec3 u_lightningDir;
  uniform float u_dayAmount;
  uniform float u_twilightAmount;
  uniform float u_nightAmount;
  uniform float u_time;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.11369, 0.13787));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  float fbm2(vec2 p) {
    return vnoise(p) * 0.6667 + vnoise(p * 2.13 + 19.7) * 0.3333;
  }

  void main() {
    vec3 d = normalize(v_dir);

    // Day, dusk, and readable night gradients blended by the client time cycle.
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 dayZenith = vec3(0.09, 0.30, 0.72);
    vec3 dayMid = vec3(0.42, 0.66, 0.92);
    vec3 dayHorizon = vec3(0.78, 0.90, 0.98);
    vec3 twilightZenith = vec3(0.10, 0.12, 0.44);
    vec3 twilightMid = vec3(0.44, 0.36, 0.72);
    vec3 twilightHorizon = vec3(1.00, 0.54, 0.28);
    vec3 nightZenith = vec3(0.06, 0.11, 0.25);
    vec3 nightMid = vec3(0.11, 0.19, 0.33);
    vec3 nightHorizon = vec3(0.22, 0.32, 0.45);

    vec3 daySky = mix(dayHorizon, dayMid, smoothstep(0.0, 0.30, h));
    daySky = mix(daySky, dayZenith, smoothstep(0.24, 0.74, h));
    vec3 twilightSky = mix(twilightHorizon, twilightMid, smoothstep(0.0, 0.30, h));
    twilightSky = mix(twilightSky, twilightZenith, smoothstep(0.22, 0.72, h));
    vec3 nightSky = mix(nightHorizon, nightMid, smoothstep(0.0, 0.34, h));
    nightSky = mix(nightSky, nightZenith, smoothstep(0.20, 0.76, h));

    vec3 sky = daySky * u_dayAmount + twilightSky * u_twilightAmount + nightSky * u_nightAmount;
    float antiSun = pow(max(0.0, dot(d, normalize(vec3(-u_sunDir.x, 0.18, -u_sunDir.z)))), 2.2);
    sky = mix(sky, mix(vec3(0.28, 0.22, 0.62), vec3(0.08, 0.13, 0.24), u_nightAmount), antiSun * 0.18 * (1.0 - u_stormIntensity));

    // Storm layer: desaturate, then blend to a dark brooding overcast
    float grey = dot(sky, vec3(0.299, 0.587, 0.114));
    sky = mix(sky, vec3(grey), u_stormIntensity * 0.4);
    vec3 sZen = vec3(0.12, 0.13, 0.17);
    vec3 sMid = vec3(0.26, 0.28, 0.32);
    vec3 sHor = vec3(0.45, 0.46, 0.50);
    vec3 stormSky = mix(sHor, sMid, smoothstep(0.0, 0.32, h));
    stormSky = mix(stormSky, sZen, smoothstep(0.18, 0.78, h));
    sky = mix(sky, stormSky, u_stormIntensity);

    // Stylized drifting 2-octave fbm cloud layer
    float skyUp = smoothstep(0.015, 0.14, d.y);
    vec2 cuv = d.xz / (abs(d.y) * 0.85 + 0.22);
    vec2 drift = vec2(u_time * 0.010, u_time * 0.0042);
    float cf = fbm2(cuv * 1.15 + drift);
    float coverage = mix(0.42, 0.24, u_stormIntensity);
    float cloud = smoothstep(coverage, coverage + mix(0.28, 0.40, u_stormIntensity), cf) * skyUp;
    float cfLit = fbm2(cuv * 1.15 + drift + u_sunDir.xz * 0.16);
    float litEdge = clamp((cf - cfLit) * 2.6 + 0.55, 0.0, 1.0);
    vec3 cloudLit = vec3(1.00, 0.99, 0.96) * u_dayAmount + vec3(1.00, 0.62, 0.40) * u_twilightAmount + vec3(0.30, 0.35, 0.47) * u_nightAmount;
    vec3 cloudShade = vec3(0.62, 0.68, 0.78) * u_dayAmount + vec3(0.42, 0.33, 0.46) * u_twilightAmount + vec3(0.12, 0.15, 0.22) * u_nightAmount;
    cloudLit = mix(cloudLit, vec3(0.35, 0.37, 0.41), u_stormIntensity);
    cloudShade = mix(cloudShade, vec3(0.10, 0.11, 0.13), u_stormIntensity);
    float cloudAlpha = cloud * mix(0.85, 0.97, u_stormIntensity);
    sky = mix(sky, mix(cloudShade, cloudLit, litEdge), cloudAlpha);

    // ── Lightning illumination: the strike lights the CLOUD DECK from inside
    //    (bellies flare, clear sky only lifts) and is brightest toward the
    //    bolt's azimuth, so the flash has a direction you can read ──────────
    float boltLobe = 0.0;
    if (u_lightningFlash > 0.001) {
      float boltAz = dot(normalize(vec3(d.x, 0.0001, d.z)), u_lightningDir);
      boltLobe = (0.08 + 0.92 * pow(max(0.0, boltAz), 2.2))
               * (1.0 - smoothstep(0.05, 0.85, d.y) * 0.55);
      float boltGlow = u_lightningFlash * boltLobe;
      // Deliberately restrained: the CHANNEL has to stay the brightest thing on
      // screen, so the sky lifts and the cloud bellies flare, but nothing here
      // is allowed to blow the whole dome to flat white.
      sky += vec3(0.60, 0.70, 0.92) * boltGlow * (0.08 + cloudAlpha * 0.95);
      sky = mix(sky, vec3(0.74, 0.82, 0.99), boltGlow * cloudAlpha * 0.22);
    }

    // Storm scud: fast low dark wisps racing along the horizon band
    float scud = smoothstep(0.48, 0.92, fbm2(cuv * 2.4 + vec2(u_time * 0.055, u_time * 0.020) + 31.7));
    float scudBand = smoothstep(-0.02, 0.06, d.y) * (1.0 - smoothstep(0.16, 0.52, d.y));
    sky = mix(sky, vec3(0.055, 0.060, 0.075), scud * scudBand * u_stormIntensity * 0.85);

    // Sun disk + glow corona (heavily muted in storm)
    float sunDot  = dot(d, u_sunDir);
    float sunAbove = smoothstep(-0.04, 0.09, u_sunDir.y);
    float sunDisk = smoothstep(0.9994, 0.9999, sunDot);
    float corona  = pow(max(0.0, sunDot), 9.0);
    float scatter = pow(max(0.0, sunDot), 3.2);
    float sunVis = mix(1.0, 0.06, u_stormIntensity) * sunAbove;
    vec3 scatterTint = mix(vec3(1.0, 0.78, 0.35), vec3(1.0, 0.32, 0.22), u_twilightAmount);
    sky += scatterTint * scatter * 0.22 * (1.15 - h) * sunVis * (1.0 - cloudAlpha * 0.6);
    sky += vec3(0.62, 0.22, 0.72) * pow(max(0.0, sunDot), 1.8) * 0.08 * sunVis * u_twilightAmount;
    float moonDot = dot(d, -u_sunDir);
    float moonDisk = smoothstep(0.99972, 0.99994, moonDot) * u_nightAmount * (1.0 - u_stormIntensity * 0.7);

    // Hash-grid stars, fading in with night and hidden by clouds/storm
    float starField = 0.0;
    vec3 sp = d * 150.0;
    float sh = hash31(floor(sp));
    if (sh > 0.905) {
      vec3 jitter = fract(vec3(sh * 719.7, sh * 431.3, sh * 213.9)) - 0.5;
      float distToStar = length(fract(sp) - 0.5 - jitter * 0.55);
      float twinkle = 0.72 + 0.28 * sin(u_time * (1.2 + fract(sh * 57.0) * 2.4) + sh * 41.0);
      starField = smoothstep(0.30, 0.02, distToStar) * (0.3 + 0.7 * fract(sh * 97.0)) * twinkle;
    }
    float starVis = u_nightAmount * (1.0 - u_stormIntensity) * (1.0 - cloudAlpha) * smoothstep(0.02, 0.24, d.y);
    sky += vec3(0.62, 0.70, 0.86) * starField * starVis * 0.55;

    // Horizon haze band
    float haze = pow(1.0 - abs(d.y), 7.0) * 0.38 * mix(1.0, 0.35, u_stormIntensity);
    vec3 hazeColor = dayHorizon * u_dayAmount + twilightHorizon * u_twilightAmount + nightHorizon * u_nightAmount;
    sky = mix(sky, mix(hazeColor, vec3(0.50, 0.53, 0.57), u_stormIntensity), haze);

    vec3 waterBelow = mix(vec3(0.00, 0.04, 0.08), vec3(0.02, 0.18, 0.27), smoothstep(-0.7, 0.2, d.y));
    vec3 waterGlow = vec3(0.08, 0.42, 0.52) * pow(max(0.0, d.y), 2.0);
    sky = mix(sky, waterBelow + waterGlow, u_underwaterIntensity);

    // Display-authored -> linear, shaped so ACES + sRGB output lands near the authored values
    sky = max(sky, vec3(0.0));
    sky = sky * sky * sky * 0.55 + sky * 0.06;

    // Emissive terms added in linear so bloom picks them up
    float notUnder = 1.0 - u_underwaterIntensity;
    float cloudOcclusion = 1.0 - cloudAlpha * 0.85;
    sky += vec3(1.0, 0.86, 0.42) * (sunDisk * 3.2 + corona * 0.30) * sunVis * cloudOcclusion * notUnder;
    sky += vec3(0.55, 0.68, 1.00) * moonDisk * 1.5 * cloudOcclusion * notUnder;
    sky += vec3(0.80, 0.88, 1.10) * starField * starVis * 0.9 * notUnder;
    // Emissive in linear so bloom blooms off the lit cloud belly.
    sky += vec3(0.55, 0.66, 0.95) * u_lightningFlash * boltLobe * 0.3 * notUnder;

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface Atmosphere {
  sunDir: THREE.Vector3;
  fogColor: THREE.Color;
  horizonColor: THREE.Color;
  storminess: number;
  nightFactor: number;
  twilightFactor: number;
}

// Camera-following shadow frustum: an ortho box snapped to shadow texels. Sized
// to swallow a whole large island (radius up to ~96m) so its cast/self shadows
// never clip to a hard rectangular seam on the terrain you're standing near.
const SHADOW_HALF_EXTENT = 155;
const SHADOW_LIGHT_DISTANCE = 210;
const SHADOW_UP = new THREE.Vector3(0, 1, 0);
const SHADOW_ORIGIN = new THREE.Vector3(0, 0, 0);

export class Renderer {
  public renderer!: THREE.WebGLRenderer;
  public scene!: THREE.Scene;
  public camera!: THREE.PerspectiveCamera;

  private sun!: THREE.DirectionalLight;
  private ambientLight!: THREE.AmbientLight;
  private hemisphereLight!: THREE.HemisphereLight;
  private horizonFill!: THREE.DirectionalLight;
  private skyMesh!: THREE.Mesh;
  private skyMaterial!: THREE.ShaderMaterial;
  private sunDisc!: THREE.Mesh;
  private sunGlow!: THREE.Mesh;
  private readonly sunDir = new THREE.Vector3(0.2, 0.92, -0.34).normalize();
  private readonly activeLightDir = new THREE.Vector3();
  // Distance fog is deliberately DARKER than the sky it sits under. A fog tint
  // that matched the horizon washed every island to a white ghost by ~500m and
  // killed navigate-by-silhouette: only Old Maw (dark volcanic rock) survived.
  // Keeping the haze a few stops under the sky keeps mountain profiles readable
  // out to 800m while still reading as atmosphere.
  private readonly fogDayColor = new THREE.Color(0x7ba3bd);
  private readonly fogTwilightColor = new THREE.Color(0x94737a);
  private readonly fogNightColor = new THREE.Color(0x23374e);
  private readonly fogStormColor = new THREE.Color(0x4a5764);
  private readonly underwaterFillColor = new THREE.Color(0x63c6d6);
  private readonly underwaterFloorColor = new THREE.Color(0x2f7f8c);
  private readonly fogUnderwaterNearColor = new THREE.Color(0x1a6f86);
  private readonly fogUnderwaterDeepColor = new THREE.Color(0x0a3a4a); // murky teal, not a black void
  private readonly tempFogColor = new THREE.Color();
  private readonly tempUnderwaterFogColor = new THREE.Color();
  private readonly sunDayColor = new THREE.Color(0xfff0d8);
  private readonly sunTwilightColor = new THREE.Color(0xffbd6d);
  private readonly moonColor = new THREE.Color(0x8aa6ff);
  private readonly ambientDayColor = new THREE.Color(0x8a9aad);
  private readonly ambientTwilightColor = new THREE.Color(0x6270aa);
  private readonly ambientNightColor = new THREE.Color(0x526f95);
  private readonly hemiSkyDayColor = new THREE.Color(0x88bbdd);
  private readonly hemiSkyTwilightColor = new THREE.Color(0x8891df);
  private readonly hemiSkyNightColor = new THREE.Color(0x536fa8);
  private readonly hemiGroundDayColor = new THREE.Color(0xc4a86a);
  private readonly hemiGroundTwilightColor = new THREE.Color(0xd99a4d);
  private readonly hemiGroundNightColor = new THREE.Color(0x4e5a6c);
  private readonly horizonDayColor = new THREE.Color(0xffddb0);
  private readonly horizonTwilightColor = new THREE.Color(0xff7f8e);
  private readonly horizonNightColor = new THREE.Color(0x334c7a);
  private readonly skyHorizonDayColor = new THREE.Color(0xc7e6fa);
  private readonly skyHorizonTwilightColor = new THREE.Color(0xff8a47);
  private readonly skyHorizonNightColor = new THREE.Color(0x38516f);
  private readonly skyHorizonStormColor = new THREE.Color(0x73767f);
  private dayAmount = 1;
  private twilightAmount = 0;
  private nightAmount = 0;
  private stormLevel = 0;
  private readonly quality = detectRenderQuality();
  private readonly minPixelRatio = this.quality === 'low' ? 0.44 : this.quality === 'balanced' ? 0.58 : 0.8;
  private readonly maxPixelRatio = this.quality === 'low'
    ? 0.62
    : Math.min(window.devicePixelRatio || 1, this.quality === 'balanced' ? 1.5 : 1.75);
  private currentPixelRatio = 1;
  private readonly baseShadowMapSize = this.quality === 'high' ? 4096 : 2048;
  private postFx: PostFx | null = null;
  private readonly shadowFocus = new THREE.Vector3();
  private readonly shadowBasis = new THREE.Matrix4();
  private readonly shadowBasisInv = new THREE.Matrix4();
  private readonly cameraForward = new THREE.Vector3();
  private readonly atmosphere: Atmosphere = {
    sunDir: new THREE.Vector3(0.2, 0.92, -0.34).normalize(),
    fogColor: new THREE.Color(0x9bbfd4),
    horizonColor: new THREE.Color(0xc7e6fa),
    storminess: 0,
    nightFactor: 0,
    twilightFactor: 0,
  };
  /** 0..1 falling-rain density from EnvironmentFx. Rain is not just streaks: a
   *  downpour thickens the air, so it adds fog density and pulls the fog toward
   *  a wet slate grey on top of whatever the storm/day cycle already asked for. */
  private rainMist = 0;
  private readonly fogRainColor = new THREE.Color(0x54606b);
  private perfTimer = 0;
  private perfFrameCount = 0;
  private perfFrameTime = 0;
  private smoothFrameTime = 1 / 60;
  private recoverTimer = 0;
  /** Runtime quality ladder BELOW the startup tier: 0 = untouched, 2 = spent.
   *  The tier itself is a one-shot guess off core count, so this is the only
   *  thing standing between a bad guess (or a thermally throttled Mac) and a
   *  session pinned at 13fps. */
  private distressLevel = 0;
  private distressTimer = 0;
  private distressRecoverTimer = 0;
  private lastStormWeather = -1;

  init() {
    this.scene = new THREE.Scene();
    // The scene root never moves. That matters for more than tidiness: three
    // re-composes a node's local matrix every frame when matrixAutoUpdate is
    // on, and a re-composed matrix FORCES the world-matrix walk through every
    // descendant — which would defeat every freezeStaticSubtree() below it.
    freezeStaticParent(this.scene);
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(this.fogDayColor.getHex(), 0.0015);
    initLightBudget(this.scene, this.quality);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.05, 3000,
    );
    this.camera.position.set(0, 12, -20);
    // Required so first-person viewmodels parented to the camera are included in scene traversal.
    this.scene.add(this.camera);

    // AA comes from the post chain (MSAA target or FXAA); low renders direct without AA.
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    // Start BELOW the ceiling: on a dpr-2 Retina panel, opening at the max
    // means 4x the fragments of 1.0 before the machine has proven any
    // headroom — fanless Macs stuttered until the down-ratchet caught up.
    // The recovery loop climbs toward maxPixelRatio when frames stay fast.
    this.applyPixelRatio(Math.min(this.maxPixelRatio, 1.2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild);

    // ── Sky dome ────────────────────────────────────────────────
    const skyGeo = new THREE.SphereGeometry(2800, this.quality === 'low' ? 12 : 20, this.quality === 'low' ? 6 : 10);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        u_sunDir: { value: this.sunDir.clone() },
        u_stormIntensity: { value: 0 },
        u_underwaterIntensity: { value: 0 },
        u_lightningFlash: { value: 0 },
        u_lightningDir: { value: new THREE.Vector3(0, 0, 1) },
        u_dayAmount: { value: 1 },
        u_twilightAmount: { value: 0 },
        u_nightAmount: { value: 0 },
        u_time: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.skyMesh.renderOrder = -1;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    // ── Sun ─────────────────────────────────────────────────────
    const sunWorldDir = this.sunDir.clone().multiplyScalar(400);
    // depthTest STAYS ON for both. With it off, the twilight glow corona — a
    // 124m additive disc parked 2km out, tinted hot pink by the dusk horizon
    // colour — painted straight over whatever island stood between you and the
    // sunset: a huge translucent pink plate hovering over the dock island.
    // Depth-tested, the sun sets behind the land like it should.
    const sunDiscMat = new THREE.MeshBasicMaterial({
      color: 0xffd36a,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const sunGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff6f45,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.sunGlow = new THREE.Mesh(new THREE.CircleGeometry(96, 40), sunGlowMat);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(28, 40), sunDiscMat);
    this.sunGlow.renderOrder = -0.5;
    this.sunDisc.renderOrder = -0.45;
    this.sunGlow.frustumCulled = false;
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunGlow);
    this.scene.add(this.sunDisc);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.75);
    this.sun.position.copy(sunWorldDir);
    this.sun.castShadow = this.quality !== 'low';
    // Larger frustum (see SHADOW_HALF_EXTENT) needs more texels to stay crisp.
    const shadowMapSize = this.baseShadowMapSize;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.camera.near = 30;
    this.sun.shadow.camera.far = SHADOW_LIGHT_DISTANCE + 230;
    this.sun.shadow.camera.left   = -SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.right  =  SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.top    =  SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = this.quality === 'high' ? 1.0 : 1.8;
    this.scene.add(this.sun);
    // Target must be in the graph so the follow-camera shadow frustum updates.
    this.scene.add(this.sun.target);

    // Ambient sky light (blue-ish to simulate skylight scatter)
    this.ambientLight = new THREE.AmbientLight(0x7090b8, 0.68);
    this.scene.add(this.ambientLight);

    // Hemisphere: violet sky scatter → amber sand bounce.
    this.hemisphereLight = new THREE.HemisphereLight(0x88bbdd, 0xc4a86a, 0.78);
    this.scene.add(this.hemisphereLight);

    // Warm horizon fill on opposite side to sun
    this.horizonFill = new THREE.DirectionalLight(0xffddb0, 0.3);
    this.horizonFill.position.set(-300, 30, -450);
    this.scene.add(this.horizonFill);

    if (this.quality !== 'low') {
      try {
        this.postFx = new PostFx(this.renderer, this.scene, this.camera, this.quality);
        this.postFx.setSize(window.innerWidth, window.innerHeight);
        this.postFx.setPixelRatio(this.currentPixelRatio);
      } catch (error) {
        console.warn('PostFx unavailable, falling back to direct rendering', error);
        this.postFx = null;
      }
    }

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.applyPixelRatio(this.currentPixelRatio);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.postFx?.setSize(window.innerWidth, window.innerHeight);
    });
  }

  getQuality(): RenderQuality {
    return this.quality;
  }

  getEffectScale(): number {
    return this.quality === 'low' ? 0.48 : this.quality === 'balanced' ? 0.72 : 1;
  }

  areShadowsEnabled(): boolean {
    return this.renderer?.shadowMap.enabled ?? false;
  }

  updatePerformance(dt: number) {
    this.smoothFrameTime = THREE.MathUtils.lerp(this.smoothFrameTime, dt, 0.08);
    this.perfTimer += dt;
    this.perfFrameTime += dt;
    this.perfFrameCount++;
    if (this.perfTimer < 1.15) return;

    const avgFrameTime = this.perfFrameTime / Math.max(1, this.perfFrameCount);
    const avgFps = 1 / Math.max(0.001, avgFrameTime);
    this.perfTimer = 0;
    this.perfFrameTime = 0;
    this.perfFrameCount = 0;

    if (avgFps < 47 || this.smoothFrameTime > 1 / 42) {
      this.recoverTimer = 0;
      if (this.currentPixelRatio > this.pixelRatioFloor() + 0.01) {
        this.applyPixelRatio(Math.max(this.pixelRatioFloor(), this.currentPixelRatio - 0.08));
        this.distressTimer = 0;
        return;
      }
      // Already scraping the floor and STILL missing frames. The tier was a
      // one-shot guess off core count at startup, so a machine that guessed
      // wrong — or a fast one that has since thermally throttled — used to sit
      // at 13fps forever with nothing left to give. Escalate a step.
      if (avgFps < DISTRESS_FPS) {
        this.distressTimer += 1.15;
        if (this.distressTimer > DISTRESS_DWELL_SECONDS) {
          this.distressTimer = 0;
          this.escalateDistress();
        }
      } else {
        this.distressTimer = Math.max(0, this.distressTimer - 1.15);
      }
      return;
    }

    // Recovery must be reachable under 60Hz vsync (58fps+perfect frames never
    // happened, so quality only ratcheted down over a session).
    if (avgFps > 55.5 && this.smoothFrameTime < 1 / 50) {
      this.recoverTimer += 1.15;
      if (this.recoverTimer > 4) {
        if (this.currentPixelRatio < this.maxPixelRatio - 0.01) {
          this.applyPixelRatio(Math.min(this.maxPixelRatio, this.currentPixelRatio + 0.06));
          this.recoverTimer = 0;
        } else if (this.distressLevel > 0) {
          // Only hand quality back once resolution is already all the way up
          // AND has held there — the long dwell is what stops the ladder from
          // hunting between "shadows off" and "shadows on" every few seconds.
          this.distressRecoverTimer += 1.15;
          if (this.distressRecoverTimer > 12) {
            this.distressRecoverTimer = 0;
            this.relieveDistress();
          }
        }
      }
    } else {
      this.recoverTimer = Math.max(0, this.recoverTimer - 1.15);
      this.distressRecoverTimer = Math.max(0, this.distressRecoverTimer - 1.15);
    }
  }

  /** How far the resolution scaler may drop right now. Each distress step
   *  unlocks more headroom below the tier's nominal floor. */
  private pixelRatioFloor(): number {
    return this.minPixelRatio * (this.distressLevel >= 2 ? 0.75 : 1);
  }

  /**
   * One rung DOWN the runtime ladder. The rungs are deliberately things that do
   * NOT change any shader program key — a smaller shadow map is a reallocation,
   * whereas switching shadows off entirely re-links every material in the scene
   * and would cost a multi-second freeze at exactly the worst moment.
   */
  private escalateDistress() {
    if (this.distressLevel >= 2) return;
    this.distressLevel++;
    this.distressRecoverTimer = 0;
    if (this.distressLevel === 1) this.applyShadowMapSize(Math.max(1024, this.baseShadowMapSize / 2));
    if (this.distressLevel === 2) this.applyPixelRatio(this.pixelRatioFloor());
  }

  /** One rung back UP, in the reverse order it was given away. */
  private relieveDistress() {
    if (this.distressLevel <= 0) return;
    this.distressLevel--;
    // Re-clamp: the floor just rose under whatever ratio we were running at.
    this.applyPixelRatio(this.currentPixelRatio);
    if (this.distressLevel === 0) this.applyShadowMapSize(this.baseShadowMapSize);
  }

  private applyShadowMapSize(size: number) {
    if (!this.sun.castShadow || this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    // Force reallocation at the new size; the depth material is untouched, so
    // nothing recompiles.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
  }

  /** 0 = nothing given away, 2 = every runtime rung spent. Diagnostics/tests. */
  getDistressLevel(): number {
    return this.distressLevel;
  }

  /** 0 = dry, 1 = full downpour. Couples falling-rain density into the
   *  atmosphere so distance reads WET, not merely dark. */
  setRainMist(amount: number) {
    const next = clamp(amount, 0, 1);
    if (Math.abs(next - this.rainMist) < 0.004) return;
    this.rainMist = next;
    // Force updateStormWeather's early-out to re-derive the fog next call.
    this.lastStormWeather = -1;
  }

  /** Strike lighting for the sky dome / cloud deck. `strength` is the bolt's
   *  0..1 brightness envelope; `dirX/dirZ` point from the camera toward it. */
  setLightningFlash(strength: number, dirX: number, dirZ: number) {
    this.skyMaterial.uniforms.u_lightningFlash.value = clamp(strength, 0, 1);
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      (this.skyMaterial.uniforms.u_lightningDir.value as THREE.Vector3).set(dirX / len, 0, dirZ / len);
    }
  }

  /** 0 = clear weather, 1 = full storm (gray sky, fog, dim lights). */
  updateStormWeather(intensity: number) {
    const t = clamp(intensity, 0, 1);
    if (Math.abs(t - this.lastStormWeather) < 0.008) return;
    this.lastStormWeather = t;
    this.stormLevel = t;
    this.skyMaterial.uniforms.u_stormIntensity.value = t;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    fog.color.copy(this.tempFogColor).lerp(this.fogStormColor, t);
    fog.color.lerp(this.fogRainColor, this.rainMist * 0.4);
    fog.density = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, t) * (1 + this.rainMist * 0.62);

    this.sun.intensity = THREE.MathUtils.lerp(this.getCycleSunIntensity(), this.getStormSunIntensity(), t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), this.getStormAmbientIntensity(), t);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), this.getStormHemisphereIntensity(), t);
    this.horizonFill.intensity = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), this.getStormHorizonIntensity(), t);
    this.setSunDiscWeather(t, 0);

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(this.getCycleExposure(), this.getStormExposure(), t);
  }

  updateWaterEnvironment(depthBelowSurface: number, stormIntensity: number, elapsedSeconds = 0) {
    this.updateDayNight(elapsedSeconds);
    const storm = clamp(stormIntensity, 0, 1);
    this.stormLevel = storm;
    const depth = Math.max(0, depthBelowSurface);
    const underwater = clamp(depth / 1.45, 0, 1);
    const deep = clamp(depth / 28, 0, 1);

    this.skyMaterial.uniforms.u_stormIntensity.value = storm;
    this.skyMaterial.uniforms.u_underwaterIntensity.value = underwater;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    this.tempFogColor.lerp(this.fogStormColor, storm);
    this.tempFogColor.lerp(this.fogRainColor, this.rainMist * 0.4);
    this.tempUnderwaterFogColor.copy(this.fogUnderwaterNearColor).lerp(this.fogUnderwaterDeepColor, deep);
    fog.color.copy(this.tempFogColor).lerp(this.tempUnderwaterFogColor, underwater);
    const weatherFog = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, storm) * (1 + this.rainMist * 0.62);
    const waterFog = THREE.MathUtils.lerp(0.0058, 0.011, deep); // gentler falloff so silhouettes survive at depth
    fog.density = THREE.MathUtils.lerp(weatherFog, waterFog, underwater);

    this.getCycleColor(this.sun.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
    this.getCycleColor(this.ambientLight.color, this.ambientDayColor, this.ambientTwilightColor, this.ambientNightColor);
    this.getCycleColor(this.hemisphereLight.color, this.hemiSkyDayColor, this.hemiSkyTwilightColor, this.hemiSkyNightColor);
    this.getCycleColor(this.hemisphereLight.groundColor, this.hemiGroundDayColor, this.hemiGroundTwilightColor, this.hemiGroundNightColor);
    this.getCycleColor(this.horizonFill.color, this.horizonDayColor, this.horizonTwilightColor, this.horizonNightColor);
    // Submerged fill is TEAL, not grey: the fill light is standing in for light
    // that has already travelled through metres of water, so island slopes and
    // sea rocks below the waterline take a depth ramp instead of going to ink.
    if (underwater > 0.001) {
      this.ambientLight.color.lerp(this.underwaterFillColor, underwater * 0.8);
      this.hemisphereLight.color.lerp(this.underwaterFillColor, underwater * 0.8);
      this.hemisphereLight.groundColor.lerp(this.underwaterFloorColor, underwater * 0.85);
    }

    const sunBase = THREE.MathUtils.lerp(this.getCycleSunIntensity(), this.getStormSunIntensity(), storm);
    const ambientBase = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), this.getStormAmbientIntensity(), storm);
    const hemisphereBase = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), this.getStormHemisphereIntensity(), storm);
    const horizonBase = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), this.getStormHorizonIntensity(), storm);
    this.sun.intensity = THREE.MathUtils.lerp(sunBase, THREE.MathUtils.lerp(0.22, 0.08, deep), underwater);
    // Below the surface the only thing shaping the sea floor and the island
    // slopes is fill light — the sun is all but gone and no lantern reaches. The
    // floors here are what stop a submerged shelf resolving to a black hole in
    // the water; they are raised WITH the murky-teal fog, so depth still reads.
    this.ambientLight.intensity = THREE.MathUtils.lerp(ambientBase, THREE.MathUtils.lerp(1.05, 0.72, deep), underwater);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(hemisphereBase, THREE.MathUtils.lerp(0.92, 0.62, deep), underwater);
    this.horizonFill.intensity = THREE.MathUtils.lerp(horizonBase, THREE.MathUtils.lerp(0.04, 0.015, deep), underwater);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.getCycleExposure(), this.getStormExposure(), storm),
      THREE.MathUtils.lerp(0.98, 0.76, deep),
      underwater,
    );
    this.setSunDiscWeather(storm, underwater);
  }

  getSunDirection() {
    return this.sunDir;
  }

  render() {
    // Hand this frame's few brightest torches/lanterns to the fixed light pool
    // BEFORE anything is drawn (see LightBudget: the pool size never changes,
    // so no material ever re-links because a torch came into view).
    updateLightBudget(this.camera.position);
    // Sky dome follows camera so it always fills the background
    this.skyMesh.position.copy(this.camera.position);
    const sunPos = this.camera.position.clone().addScaledVector(this.sunDir, 2050);
    this.sunGlow.position.copy(sunPos);
    this.sunDisc.position.copy(sunPos);
    this.sunGlow.lookAt(this.camera.position);
    this.sunDisc.lookAt(this.camera.position);
    this.updateShadowFrustum();
    // Accumulate draw/tri counters across ALL passes for this frame — with
    // autoReset the post-fx composer wipes them per pass and the debug overlay
    // forever reads the final fullscreen quad ("draw 1 | tris 1").
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    if (this.postFx) {
      this.postFx.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Per-frame atmosphere snapshot for the ocean/other systems. Returned objects are reused. */
  getAtmosphere(): Atmosphere {
    const a = this.atmosphere;
    a.sunDir.copy(this.sunDir);
    const fog = this.scene?.fog as THREE.FogExp2 | null;
    if (fog) a.fogColor.copy(fog.color);
    this.getCycleColor(a.horizonColor, this.skyHorizonDayColor, this.skyHorizonTwilightColor, this.skyHorizonNightColor);
    a.horizonColor.lerp(this.skyHorizonStormColor, this.stormLevel);
    a.storminess = this.stormLevel;
    a.nightFactor = this.nightAmount;
    a.twilightFactor = this.twilightAmount;
    return a;
  }

  /** Keeps a tight shadow ortho box centered ahead of the camera, snapped to shadow texels. */
  private updateShadowFrustum() {
    if (!this.sun.castShadow) return;
    this.camera.getWorldDirection(this.cameraForward);
    this.cameraForward.y = 0;
    if (this.cameraForward.lengthSq() < 1e-4) this.cameraForward.set(0, 0, 1);
    else this.cameraForward.normalize();
    // Anchor at sea level so wave/camera bob doesn't shift the frustum vertically.
    this.shadowFocus.copy(this.camera.position).addScaledVector(this.cameraForward, SHADOW_HALF_EXTENT * 0.7);
    this.shadowFocus.y = 0;

    // Snap the focus to the shadow-texel grid in light space to stop edge crawling.
    const texel = (SHADOW_HALF_EXTENT * 2) / this.sun.shadow.mapSize.x;
    this.shadowBasis.lookAt(this.activeLightDir, SHADOW_ORIGIN, SHADOW_UP);
    this.shadowBasisInv.copy(this.shadowBasis).invert();
    this.shadowFocus.applyMatrix4(this.shadowBasisInv);
    this.shadowFocus.x = Math.round(this.shadowFocus.x / texel) * texel;
    this.shadowFocus.y = Math.round(this.shadowFocus.y / texel) * texel;
    this.shadowFocus.applyMatrix4(this.shadowBasis);

    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.activeLightDir, SHADOW_LIGHT_DISTANCE);
  }

  private setSunDiscWeather(storm: number, underwater: number) {
    const sunAbove = smoothstep(-0.04, 0.1, this.sunDir.y);
    const visibility = (1 - clamp(storm, 0, 1) * 0.86) * (1 - clamp(underwater, 0, 1)) * sunAbove;
    const discMat = this.sunDisc?.material as THREE.MeshBasicMaterial | undefined;
    const glowMat = this.sunGlow?.material as THREE.MeshBasicMaterial | undefined;
    if (discMat) {
      this.getCycleColor(discMat.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
      discMat.opacity = 0.84 * visibility * (0.85 + this.twilightAmount * 0.25);
    }
    if (glowMat) {
      this.getCycleColor(glowMat.color, this.horizonDayColor, this.horizonTwilightColor, this.moonColor);
      glowMat.opacity = (0.12 + this.twilightAmount * 0.22) * visibility;
    }
  }

  private updateDayNight(elapsedSeconds: number) {
    const cycle = positiveModulo(elapsedSeconds / DAY_NIGHT_CYCLE_SECONDS + DAY_NIGHT_START_OFFSET, 1);
    const daylightShare = 0.72;
    const sunArc = cycle < daylightShare
      ? (cycle / daylightShare) * Math.PI
      : Math.PI + ((cycle - daylightShare) / (1 - daylightShare)) * Math.PI;
    const rawY = Math.sin(sunArc);
    const horizontal = Math.sqrt(Math.max(0.001, 1 - rawY * rawY));
    const azimuth = cycle * Math.PI * 2 * 0.62 - 0.74;
    this.sunDir.set(Math.cos(azimuth) * horizontal, rawY, Math.sin(azimuth) * horizontal).normalize();

    const dayRaw = smoothstep(-0.03, 0.26, rawY);
    const nightRaw = 1 - smoothstep(-0.32, 0.05, rawY);
    const twilightRaw = clamp(1 - Math.abs(rawY) / 0.34, 0, 1) * (1 - nightRaw * 0.18);
    const total = Math.max(0.001, dayRaw + twilightRaw + nightRaw);
    this.dayAmount = dayRaw / total;
    this.twilightAmount = twilightRaw / total;
    this.nightAmount = nightRaw / total;

    this.skyMaterial.uniforms.u_sunDir.value.copy(this.sunDir);
    this.skyMaterial.uniforms.u_dayAmount.value = this.dayAmount;
    this.skyMaterial.uniforms.u_twilightAmount.value = this.twilightAmount;
    this.skyMaterial.uniforms.u_nightAmount.value = this.nightAmount;
    this.skyMaterial.uniforms.u_time.value = elapsedSeconds;

    const sunAbove = smoothstep(-0.06, 0.12, this.sunDir.y);
    this.activeLightDir.copy(this.sunDir);
    if (sunAbove <= 0.08) this.activeLightDir.multiplyScalar(-1);
    this.activeLightDir.y = Math.max(0.16, this.activeLightDir.y);
    this.activeLightDir.normalize();
    this.sun.position.copy(this.activeLightDir).multiplyScalar(400);
    this.horizonFill.position.copy(this.activeLightDir).multiplyScalar(-340);
    this.horizonFill.position.y = Math.max(28, this.horizonFill.position.y);
  }

  private getCycleColor(target: THREE.Color, day: THREE.Color, twilight: THREE.Color, night: THREE.Color) {
    target.setRGB(
      day.r * this.dayAmount + twilight.r * this.twilightAmount + night.r * this.nightAmount,
      day.g * this.dayAmount + twilight.g * this.twilightAmount + night.g * this.nightAmount,
      day.b * this.dayAmount + twilight.b * this.twilightAmount + night.b * this.nightAmount,
    );
    return target;
  }

  private getCycleSunIntensity() {
    // The night term is MOONLIGHT (activeLightDir flips to the anti-sun once the
    // sun is down). It is the only directional light after dark, so it has to be
    // strong enough to shape a hull/cliff into a silhouette — a Sea-of-Thieves
    // night is blue and legible, not an unlit black screen.
    return this.dayAmount * 2.65 + this.twilightAmount * 1.55 + this.nightAmount * 0.62;
  }

  private getCycleAmbientIntensity() {
    // Raised so slopes facing away from an overhead sun read as deep colour, not
    // black — the shaded side of an island should still show its biome tone.
    // Twilight fill is kept LOWER than day: the low dusk sun must still shape the
    // terrain (directional warm light + long shadows), so fill can't out-power it.
    return this.dayAmount * 0.9 + this.twilightAmount * 0.58 + this.nightAmount * 0.78;
  }

  private getCycleHemisphereIntensity() {
    // Sky/ground fill is the main lever that keeps steep terrain readable; it is
    // normal-oriented so it lifts shaded faces without flattening lit ones.
    return this.dayAmount * 1.34 + this.twilightAmount * 0.78 + this.nightAmount * 0.86;
  }

  private getCycleHorizonIntensity() {
    return this.dayAmount * 0.3 + this.twilightAmount * 0.42 + this.nightAmount * 0.16;
  }

  // ── Storm light targets ───────────────────────────────────────────────────
  // A storm dims the world toward these; they used to be flat constants, which
  // meant a storm AT NIGHT stacked its dimming on top of an already-dark cycle
  // and drove the whole frame to black (only the HUD survived). The floors now
  // rise with nightAmount, so a night storm is a dark BLUE squall you can still
  // read a deck and a coastline through.
  private getStormSunIntensity() { return 0.42 + this.nightAmount * 0.16; }
  private getStormAmbientIntensity() { return 0.36 + this.nightAmount * 0.40; }
  private getStormHemisphereIntensity() { return 0.28 + this.nightAmount * 0.50; }
  private getStormHorizonIntensity() { return 0.08 + this.nightAmount * 0.06; }
  private getStormExposure() { return 0.78 + this.nightAmount * 0.22; }

  private getCycleExposure() {
    return this.dayAmount * 1.06 + this.twilightAmount * 1.12 + this.nightAmount * 1.08;
  }

  private getCycleFogDensity() {
    // Thinned a notch across the cycle: combined with the darker fog tint above,
    // an 800m island still reads as a shape instead of dissolving into haze.
    return this.dayAmount * 0.00112 + this.twilightAmount * 0.00146 + this.nightAmount * 0.00158;
  }

  private applyPixelRatio(target: number) {
    const deviceRatio = window.devicePixelRatio || 1;
    const viewportCap = window.innerWidth < 900 ? Math.min(this.maxPixelRatio, 0.72) : this.maxPixelRatio;
    // The floor moves with the distress ladder, so a machine that cannot hold
    // frames at the tier's nominal minimum is allowed to go lower still.
    this.currentPixelRatio = clamp(Math.min(deviceRatio, target, viewportCap), this.pixelRatioFloor(), this.maxPixelRatio);
    this.renderer?.setPixelRatio(this.currentPixelRatio);
    this.postFx?.setPixelRatio(this.currentPixelRatio);
  }
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function detectRenderQuality(): RenderQuality {
  const param = new URLSearchParams(window.location.search).get('quality');
  if (param === 'low' || param === 'balanced' || param === 'high') return param;

  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory;
  const memoryLimited = typeof memory === 'number' && memory <= 4;
  const memoryStrong = typeof memory === 'number' ? memory >= 8 : true;
  // Judge on CSS pixels: the adaptive pixel-ratio scaler owns the actual
  // output resolution, so a HiDPI screen must not permanently veto 'high'
  // (every Retina Mac was stuck on 'balanced' forever).
  const cssPixels = window.innerWidth * window.innerHeight;

  if (cores <= 4 || memoryLimited || (cssPixels > 3_400_000 && cores <= 6)) return 'low';
  if (cores >= 8 && memoryStrong && cssPixels <= 2_600_000) return 'high';
  return 'balanced';
}
