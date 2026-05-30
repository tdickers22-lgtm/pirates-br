import * as THREE from 'three';

export type RenderQuality = 'low' | 'balanced' | 'high';

const DAY_NIGHT_CYCLE_SECONDS = 540;
const DAY_NIGHT_START_OFFSET = 0.47;

const SKY_VERT = /* glsl */`
  varying vec3 v_dir;
  void main() {
    v_dir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  varying vec3 v_dir;
  uniform vec3 u_sunDir;
  uniform float u_stormIntensity;
  uniform float u_underwaterIntensity;
  uniform float u_dayAmount;
  uniform float u_twilightAmount;
  uniform float u_nightAmount;

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
    vec3 nightZenith = vec3(0.035, 0.075, 0.19);
    vec3 nightMid = vec3(0.08, 0.15, 0.27);
    vec3 nightHorizon = vec3(0.18, 0.27, 0.39);

    vec3 daySky = mix(dayHorizon, dayMid, smoothstep(0.0, 0.30, h));
    daySky = mix(daySky, dayZenith, smoothstep(0.24, 0.74, h));
    vec3 twilightSky = mix(twilightHorizon, twilightMid, smoothstep(0.0, 0.30, h));
    twilightSky = mix(twilightSky, twilightZenith, smoothstep(0.22, 0.72, h));
    vec3 nightSky = mix(nightHorizon, nightMid, smoothstep(0.0, 0.34, h));
    nightSky = mix(nightSky, nightZenith, smoothstep(0.20, 0.76, h));

    vec3 sky = daySky * u_dayAmount + twilightSky * u_twilightAmount + nightSky * u_nightAmount;
    float antiSun = pow(max(0.0, dot(d, normalize(vec3(-u_sunDir.x, 0.18, -u_sunDir.z)))), 2.2);
    sky = mix(sky, mix(vec3(0.28, 0.22, 0.62), vec3(0.08, 0.13, 0.24), u_nightAmount), antiSun * 0.18 * (1.0 - u_stormIntensity));

    // Storm layer: slate-gray overcast
    vec3 sZen = vec3(0.08, 0.09, 0.12);
    vec3 sMid = vec3(0.20, 0.22, 0.26);
    vec3 sHor = vec3(0.42, 0.44, 0.48);
    vec3 stormSky = mix(sHor, sMid, smoothstep(0.0, 0.32, h));
    stormSky = mix(stormSky, sZen, smoothstep(0.18, 0.78, h));
    sky = mix(sky, stormSky, u_stormIntensity);

    // Sun disk + glow corona (heavily muted in storm)
    float sunDot  = dot(d, u_sunDir);
    float sunAbove = smoothstep(-0.04, 0.09, u_sunDir.y);
    float sunDisk = smoothstep(0.9994, 0.9999, sunDot);
    float corona  = pow(max(0.0, sunDot), 9.0) * 0.48;
    float scatter = pow(max(0.0, sunDot), 3.2) * 0.24;
    float sunVis = mix(1.0, 0.08, u_stormIntensity) * sunAbove;
    sky += vec3(1.0, 0.86, 0.42) * (sunDisk + corona) * sunVis;
    sky += mix(vec3(1.0, 0.78, 0.35), vec3(1.0, 0.32, 0.22), u_twilightAmount) * scatter * (1.15 - h) * sunVis;
    sky += vec3(0.62, 0.22, 0.72) * pow(max(0.0, sunDot), 1.8) * 0.08 * sunVis * u_twilightAmount;
    float moonDot = dot(d, -u_sunDir);
    float moonDisk = smoothstep(0.99972, 0.99994, moonDot) * u_nightAmount * (1.0 - u_stormIntensity * 0.7);
    sky += vec3(0.56, 0.68, 0.95) * moonDisk;

    // Horizon haze band
    float haze = pow(1.0 - abs(d.y), 7.0) * 0.38 * mix(1.0, 0.35, u_stormIntensity);
    vec3 hazeColor = dayHorizon * u_dayAmount + twilightHorizon * u_twilightAmount + nightHorizon * u_nightAmount;
    sky = mix(sky, mix(hazeColor, vec3(0.55, 0.58, 0.62), u_stormIntensity), haze);

    vec3 waterBelow = mix(vec3(0.00, 0.04, 0.08), vec3(0.02, 0.18, 0.27), smoothstep(-0.7, 0.2, d.y));
    vec3 waterGlow = vec3(0.08, 0.42, 0.52) * pow(max(0.0, d.y), 2.0);
    sky = mix(sky, waterBelow + waterGlow, u_underwaterIntensity);

    gl_FragColor = vec4(sky, 1.0);
  }
`;

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
  private readonly fogDayColor = new THREE.Color(0x9bbfd4);
  private readonly fogTwilightColor = new THREE.Color(0xdca48c);
  private readonly fogNightColor = new THREE.Color(0x35506d);
  private readonly fogStormColor = new THREE.Color(0x5a6a78);
  private readonly fogUnderwaterNearColor = new THREE.Color(0x0d5f78);
  private readonly fogUnderwaterDeepColor = new THREE.Color(0x031f35);
  private readonly tempFogColor = new THREE.Color();
  private readonly tempUnderwaterFogColor = new THREE.Color();
  private readonly sunDayColor = new THREE.Color(0xfff0d8);
  private readonly sunTwilightColor = new THREE.Color(0xffbd6d);
  private readonly moonColor = new THREE.Color(0x8aa6ff);
  private readonly ambientDayColor = new THREE.Color(0x7090b8);
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
  private dayAmount = 1;
  private twilightAmount = 0;
  private nightAmount = 0;
  private readonly quality = detectRenderQuality();
  private readonly minPixelRatio = this.quality === 'low' ? 0.5 : this.quality === 'balanced' ? 0.58 : 0.72;
  private readonly maxPixelRatio = this.quality === 'low' ? 0.72 : this.quality === 'balanced' ? 0.86 : 1;
  private currentPixelRatio = 1;
  private perfTimer = 0;
  private perfFrameCount = 0;
  private perfFrameTime = 0;
  private smoothFrameTime = 1 / 60;
  private recoverTimer = 0;
  private lastStormWeather = -1;

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(this.fogDayColor.getHex(), 0.0015);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.05, 3000,
    );
    this.camera.position.set(0, 12, -20);
    // Required so first-person viewmodels parented to the camera are included in scene traversal.
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality === 'high',
      powerPreference: 'high-performance',
    });
    this.applyPixelRatio(this.maxPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
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
        u_dayAmount: { value: 1 },
        u_twilightAmount: { value: 0 },
        u_nightAmount: { value: 0 },
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
    const sunDiscMat = new THREE.MeshBasicMaterial({
      color: 0xffd36a,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const sunGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff6f45,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      depthTest: false,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.sunGlow = new THREE.Mesh(new THREE.CircleGeometry(124, 40), sunGlowMat);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(28, 40), sunDiscMat);
    this.sunGlow.renderOrder = -0.5;
    this.sunDisc.renderOrder = -0.45;
    this.sunGlow.frustumCulled = false;
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunGlow);
    this.scene.add(this.sunDisc);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.75);
    this.sun.position.copy(sunWorldDir);
    this.sun.castShadow = this.quality === 'high';
    this.sun.shadow.mapSize.set(512, 512);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 1600;
    this.sun.shadow.camera.left   = -550;
    this.sun.shadow.camera.right  =  550;
    this.sun.shadow.camera.top    =  550;
    this.sun.shadow.camera.bottom = -550;
    this.sun.shadow.bias = -0.0002;
    this.scene.add(this.sun);

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

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.applyPixelRatio(this.currentPixelRatio);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
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
      if (this.currentPixelRatio > this.minPixelRatio + 0.01) {
        this.applyPixelRatio(Math.max(this.minPixelRatio, this.currentPixelRatio - 0.08));
      }
      return;
    }

    if (avgFps > 58 && this.smoothFrameTime < 1 / 55) {
      this.recoverTimer += 1.15;
      if (this.recoverTimer > 8 && this.currentPixelRatio < this.maxPixelRatio - 0.01) {
        this.applyPixelRatio(Math.min(this.maxPixelRatio, this.currentPixelRatio + 0.04));
        this.recoverTimer = 0;
      }
    } else {
      this.recoverTimer = Math.max(0, this.recoverTimer - 1.15);
    }
  }

  /** 0 = clear weather, 1 = full storm (gray sky, fog, dim lights). */
  updateStormWeather(intensity: number) {
    const t = clamp(intensity, 0, 1);
    if (Math.abs(t - this.lastStormWeather) < 0.008) return;
    this.lastStormWeather = t;
    this.skyMaterial.uniforms.u_stormIntensity.value = t;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    fog.color.copy(this.tempFogColor).lerp(this.fogStormColor, t);
    fog.density = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, t);

    this.sun.intensity = THREE.MathUtils.lerp(this.getCycleSunIntensity(), 0.42, t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), 0.36, t);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), 0.28, t);
    this.horizonFill.intensity = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), 0.08, t);
    this.setSunDiscWeather(t, 0);

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(this.getCycleExposure(), 0.78, t);
  }

  updateWaterEnvironment(depthBelowSurface: number, stormIntensity: number, elapsedSeconds = 0) {
    this.updateDayNight(elapsedSeconds);
    const storm = clamp(stormIntensity, 0, 1);
    const depth = Math.max(0, depthBelowSurface);
    const underwater = clamp(depth / 1.45, 0, 1);
    const deep = clamp(depth / 28, 0, 1);

    this.skyMaterial.uniforms.u_stormIntensity.value = storm;
    this.skyMaterial.uniforms.u_underwaterIntensity.value = underwater;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    this.tempFogColor.lerp(this.fogStormColor, storm);
    this.tempUnderwaterFogColor.copy(this.fogUnderwaterNearColor).lerp(this.fogUnderwaterDeepColor, deep);
    fog.color.copy(this.tempFogColor).lerp(this.tempUnderwaterFogColor, underwater);
    const weatherFog = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, storm);
    const waterFog = THREE.MathUtils.lerp(0.0065, 0.018, deep);
    fog.density = THREE.MathUtils.lerp(weatherFog, waterFog, underwater);

    this.getCycleColor(this.sun.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
    this.getCycleColor(this.ambientLight.color, this.ambientDayColor, this.ambientTwilightColor, this.ambientNightColor);
    this.getCycleColor(this.hemisphereLight.color, this.hemiSkyDayColor, this.hemiSkyTwilightColor, this.hemiSkyNightColor);
    this.getCycleColor(this.hemisphereLight.groundColor, this.hemiGroundDayColor, this.hemiGroundTwilightColor, this.hemiGroundNightColor);
    this.getCycleColor(this.horizonFill.color, this.horizonDayColor, this.horizonTwilightColor, this.horizonNightColor);

    const sunBase = THREE.MathUtils.lerp(this.getCycleSunIntensity(), 0.42, storm);
    const ambientBase = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), 0.36, storm);
    const hemisphereBase = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), 0.28, storm);
    const horizonBase = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), 0.08, storm);
    this.sun.intensity = THREE.MathUtils.lerp(sunBase, THREE.MathUtils.lerp(0.22, 0.08, deep), underwater);
    this.ambientLight.intensity = THREE.MathUtils.lerp(ambientBase, THREE.MathUtils.lerp(0.82, 0.45, deep), underwater);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(hemisphereBase, THREE.MathUtils.lerp(0.64, 0.36, deep), underwater);
    this.horizonFill.intensity = THREE.MathUtils.lerp(horizonBase, THREE.MathUtils.lerp(0.04, 0.015, deep), underwater);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.getCycleExposure(), 0.78, storm),
      THREE.MathUtils.lerp(0.94, 0.68, deep),
      underwater,
    );
    this.setSunDiscWeather(storm, underwater);
  }

  getSunDirection() {
    return this.sunDir;
  }

  render() {
    // Sky dome follows camera so it always fills the background
    this.skyMesh.position.copy(this.camera.position);
    const sunPos = this.camera.position.clone().addScaledVector(this.sunDir, 2050);
    this.sunGlow.position.copy(sunPos);
    this.sunDisc.position.copy(sunPos);
    this.sunGlow.lookAt(this.camera.position);
    this.sunDisc.lookAt(this.camera.position);
    this.renderer.render(this.scene, this.camera);
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
    return this.dayAmount * 2.65 + this.twilightAmount * 1.55 + this.nightAmount * 0.34;
  }

  private getCycleAmbientIntensity() {
    return this.dayAmount * 0.7 + this.twilightAmount * 0.66 + this.nightAmount * 0.54;
  }

  private getCycleHemisphereIntensity() {
    return this.dayAmount * 0.8 + this.twilightAmount * 0.72 + this.nightAmount * 0.52;
  }

  private getCycleHorizonIntensity() {
    return this.dayAmount * 0.3 + this.twilightAmount * 0.42 + this.nightAmount * 0.16;
  }

  private getCycleExposure() {
    return this.dayAmount * 1.06 + this.twilightAmount * 1.12 + this.nightAmount * 1.08;
  }

  private getCycleFogDensity() {
    return this.dayAmount * 0.00135 + this.twilightAmount * 0.0015 + this.nightAmount * 0.0019;
  }

  private applyPixelRatio(target: number) {
    const deviceRatio = window.devicePixelRatio || 1;
    const viewportCap = window.innerWidth < 900 ? Math.min(this.maxPixelRatio, 0.72) : this.maxPixelRatio;
    this.currentPixelRatio = clamp(Math.min(deviceRatio, target, viewportCap), this.minPixelRatio, this.maxPixelRatio);
    this.renderer?.setPixelRatio(this.currentPixelRatio);
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(0.00001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
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
  const dpr = window.devicePixelRatio || 1;
  const pixels = window.innerWidth * window.innerHeight * dpr * dpr;

  if (cores <= 4 || memoryLimited || (pixels > 3_400_000 && cores <= 6)) return 'low';
  if (cores >= 8 && memoryStrong && pixels <= 2_800_000 && dpr <= 1.5) return 'high';
  return 'balanced';
}
