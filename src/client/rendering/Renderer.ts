import * as THREE from 'three';

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

  void main() {
    vec3 d = normalize(v_dir);

    // Vertical gradient: deep azure at zenith, warm light at horizon
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 zenith  = vec3(0.09, 0.26, 0.68);
    vec3 mid     = vec3(0.38, 0.62, 0.88);
    vec3 horizon = vec3(0.78, 0.88, 0.96);

    vec3 sky = mix(horizon, mid, smoothstep(0.0, 0.28, h));
    sky       = mix(sky, zenith, smoothstep(0.22, 0.72, h));

    // Storm layer: slate-gray overcast
    vec3 sZen = vec3(0.08, 0.09, 0.12);
    vec3 sMid = vec3(0.20, 0.22, 0.26);
    vec3 sHor = vec3(0.42, 0.44, 0.48);
    vec3 stormSky = mix(sHor, sMid, smoothstep(0.0, 0.32, h));
    stormSky = mix(stormSky, sZen, smoothstep(0.18, 0.78, h));
    sky = mix(sky, stormSky, u_stormIntensity);

    // Sun disk + glow corona (heavily muted in storm)
    float sunDot  = dot(d, u_sunDir);
    float sunDisk = smoothstep(0.9994, 0.9999, sunDot);
    float corona  = pow(max(0.0, sunDot), 14.0) * 0.35;
    float scatter = pow(max(0.0, sunDot), 5.0)  * 0.12;
    float sunVis = mix(1.0, 0.08, u_stormIntensity);
    sky += vec3(1.0, 0.95, 0.75) * (sunDisk + corona) * sunVis;
    sky += vec3(0.9, 0.60, 0.25) * scatter * (1.0 - h) * sunVis;

    // Horizon haze band
    float haze = pow(1.0 - abs(d.y), 7.0) * 0.38 * mix(1.0, 0.35, u_stormIntensity);
    sky = mix(sky, mix(vec3(0.86, 0.91, 0.97), vec3(0.55, 0.58, 0.62), u_stormIntensity), haze);

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
  private readonly sunDir = new THREE.Vector3(0.5, 0.72, 0.3).normalize();
  private readonly fogClearColor = new THREE.Color(0x9BBFD4);
  private readonly fogStormColor = new THREE.Color(0x5a6a78);

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(this.fogClearColor.getHex(), 0.0015);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.05, 3000,
    );
    this.camera.position.set(0, 12, -20);
    // Required so first-person viewmodels parented to the camera are included in scene traversal.
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const pixelRatioCap = window.innerWidth < 900 ? 0.85 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild);

    // ── Sky dome ────────────────────────────────────────────────
    const skyGeo = new THREE.SphereGeometry(2800, 20, 10);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        u_sunDir: { value: this.sunDir.clone() },
        u_stormIntensity: { value: 0 },
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
    this.sun = new THREE.DirectionalLight(0xFFF0D8, 2.2);
    this.sun.position.copy(sunWorldDir);
    this.sun.castShadow = true;
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
    this.ambientLight = new THREE.AmbientLight(0x7090B8, 0.65);
    this.scene.add(this.ambientLight);

    // Hemisphere: sky (blue) → ground (sandy) for natural look
    this.hemisphereLight = new THREE.HemisphereLight(0x88BBDD, 0xC4A86A, 0.55);
    this.scene.add(this.hemisphereLight);

    // Warm horizon fill on opposite side to sun
    this.horizonFill = new THREE.DirectionalLight(0xFFDDB0, 0.25);
    this.horizonFill.position.set(-300, 30, -450);
    this.scene.add(this.horizonFill);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** 0 = clear weather, 1 = full storm (gray sky, fog, dim lights). */
  updateStormWeather(intensity: number) {
    const t = clamp(intensity, 0, 1);
    this.skyMaterial.uniforms.u_stormIntensity.value = t;

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.fogClearColor).lerp(this.fogStormColor, t);
    fog.density = THREE.MathUtils.lerp(0.0015, 0.00255, t);

    this.sun.intensity = THREE.MathUtils.lerp(2.2, 0.42, t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(0.65, 0.32, t);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(0.55, 0.22, t);
    this.horizonFill.intensity = THREE.MathUtils.lerp(0.25, 0.06, t);

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.05, 0.72, t);
  }

  render() {
    // Sky dome follows camera so it always fills the background
    this.skyMesh.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
