import * as THREE from 'three';
import type { Projectile, ProjectileType, Vec3, WeaponId } from '../../shared/types/index.js';

// Fallback sea surface height; Game feeds the live Gerstner surface via
// setWaterSurfaceY each frame so splash-vs-hull classification tracks swells
// (fixed constants misread every waterline hit once storm waves reach ±3m).
const WATER_SURFACE_Y = 0.22;
const WATER_IMPACT_THRESHOLD_Y = 0.9;
let liveWaterSurfaceY = WATER_SURFACE_Y;
let liveWaterImpactThresholdY = WATER_IMPACT_THRESHOLD_Y;

// Shared scratch objects so emits never allocate.
const scratchColor = new THREE.Color();
const scratchVecA = new THREE.Vector3();
const scratchVecB = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchMatrix = new THREE.Matrix4();
const scratchSize = new THREE.Vector2();

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pick(a: number, b: number) {
  return Math.random() < 0.5 ? a : b;
}

function createCanvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) draw(context, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createSmokeTexture() {
  return createCanvasTexture(128, (ctx, size) => {
    const center = size / 2;
    let seed = 7;
    const prng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const base = ctx.createRadialGradient(center, center, 0, center, center, center * 0.92);
    base.addColorStop(0, 'rgba(255,255,255,0.5)');
    base.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (let index = 0; index < 18; index++) {
      const angle = prng() * Math.PI * 2;
      const radius = prng() * size * 0.26;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      const blobRadius = size * (0.09 + prng() * 0.15);
      const blob = ctx.createRadialGradient(x, y, 0, x, y, blobRadius);
      blob.addColorStop(0, 'rgba(255,255,255,0.30)');
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = blob;
      ctx.fillRect(0, 0, size, size);
    }
    // Feather the silhouette so puffs never show a square edge.
    ctx.globalCompositeOperation = 'destination-in';
    const mask = ctx.createRadialGradient(center, center, 0, center, center, center * 0.98);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(0.55, 'rgba(255,255,255,1)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, size, size);
  });
}

function createSparkTexture() {
  return createCanvasTexture(64, (ctx, size) => {
    const center = size / 2;
    const core = ctx.createRadialGradient(center, center, 0, center, center, center);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.22, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);
    for (let axis = 0; axis < 2; axis++) {
      const grad = axis === 0
        ? ctx.createLinearGradient(0, 0, size, 0)
        : ctx.createLinearGradient(0, 0, 0, size);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.65)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      if (axis === 0) ctx.fillRect(0, center - size * 0.035, size, size * 0.07);
      else ctx.fillRect(center - size * 0.035, 0, size * 0.07, size);
    }
    applyRadialEdgeMask(ctx, size);
  });
}

// Sprites are rotated in the shader; transparent edges avoid clamp smearing.
function applyRadialEdgeMask(ctx: CanvasRenderingContext2D, size: number) {
  const center = size / 2;
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(center, center, 0, center, center, center);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.72, 'rgba(255,255,255,1)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
}

function createFlashTexture() {
  return createCanvasTexture(128, (ctx, size) => {
    const center = size / 2;
    const glow = ctx.createRadialGradient(center, center, 0, center, center, center);
    glow.addColorStop(0, 'rgba(255,255,255,1)');
    glow.addColorStop(0.18, 'rgba(255,255,255,0.9)');
    glow.addColorStop(0.45, 'rgba(255,255,255,0.28)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(center, center);
    for (let spike = 0; spike < 4; spike++) {
      ctx.rotate(Math.PI / 4);
      const grad = ctx.createLinearGradient(-center, 0, center, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(-center, -size * 0.02, size, size * 0.04);
    }
    ctx.restore();
    applyRadialEdgeMask(ctx, size);
  });
}

function createDropletTexture() {
  return createCanvasTexture(32, (ctx, size) => {
    const center = size / 2;
    const grad = ctx.createRadialGradient(center, center, 0, center, center, center);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  });
}

function createRingTexture() {
  return createCanvasTexture(128, (ctx, size) => {
    const center = size / 2;
    const grad = ctx.createRadialGradient(center, center, 0, center, center, center);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0)');
    grad.addColorStop(0.72, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.82, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  });
}

function createSplashTexture() {
  return createCanvasTexture(128, (ctx, size) => {
    let seed = 31;
    const prng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let index = 0; index < 11; index++) {
      const width = size * (0.03 + prng() * 0.05);
      const x = size * (0.12 + prng() * 0.76) - width / 2;
      const height = size * (0.4 + prng() * 0.55);
      const grad = ctx.createLinearGradient(0, size, 0, size - height);
      grad.addColorStop(0, 'rgba(255,255,255,0.85)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, size - height, width, height);
    }
    const base = ctx.createRadialGradient(size / 2, size * 0.92, 0, size / 2, size * 0.92, size * 0.48);
    base.addColorStop(0, 'rgba(255,255,255,0.9)');
    base.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    // Fade toward the left/right edges so columns read as tapered spray.
    ctx.globalCompositeOperation = 'destination-in';
    const mask = ctx.createLinearGradient(0, 0, size, 0);
    mask.addColorStop(0, 'rgba(255,255,255,0)');
    mask.addColorStop(0.28, 'rgba(255,255,255,1)');
    mask.addColorStop(0.72, 'rgba(255,255,255,1)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, size, size);
  });
}

const SPRITE_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aRot;
attribute vec3 aColor;
uniform float uPixelScale;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vRot = aRot;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const SPRITE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot);
  float s = sin(vRot);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  vec4 tex = texture2D(uMap, uv);
  float alpha = tex.a * vAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor * tex.rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Ring-buffer pool of textured point sprites. All buffers are preallocated;
 * emitting recycles the oldest slot and writes scalars only.
 */
class SpritePool {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly rotations: Float32Array;
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly lives: Float32Array;
  private readonly sizeStarts: Float32Array;
  private readonly sizeEnds: Float32Array;
  private readonly alphaStarts: Float32Array;
  private readonly alphaEnds: Float32Array;
  private readonly gravities: Float32Array;
  private readonly drags: Float32Array;
  private readonly rotationSpeeds: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly rotationAttr: THREE.BufferAttribute;
  private cursor = 0;
  private activeCount = 0;

  constructor(capacity: number, texture: THREE.Texture, blending: THREE.Blending, renderOrder: number) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.rotations = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
    this.sizeStarts = new Float32Array(capacity);
    this.sizeEnds = new Float32Array(capacity);
    this.alphaStarts = new Float32Array(capacity);
    this.alphaEnds = new Float32Array(capacity);
    this.gravities = new Float32Array(capacity);
    this.drags = new Float32Array(capacity);
    this.rotationSpeeds = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    this.rotationAttr = new THREE.BufferAttribute(this.rotations, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('aColor', this.colorAttr);
    geometry.setAttribute('aSize', this.sizeAttr);
    geometry.setAttribute('aAlpha', this.alphaAttr);
    geometry.setAttribute('aRot', this.rotationAttr);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uPixelScale: { value: 540 },
      },
      vertexShader: SPRITE_VERTEX_SHADER,
      fragmentShader: SPRITE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(scratchSize);
      // Exact world-size point sprites: projectionMatrix[5] = 1 / tan(fov / 2).
      material.uniforms.uPixelScale.value = 0.5 * scratchSize.y * camera.projectionMatrix.elements[5];
    };
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    sizeStart: number,
    sizeEnd: number,
    alphaStart: number,
    alphaEnd: number,
    colorHex: number,
    gravity: number,
    drag: number,
    rotationSpeed: number,
  ) {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.lives[index] <= 0) this.activeCount++;

    const index3 = index * 3;
    this.positions[index3] = x;
    this.positions[index3 + 1] = y;
    this.positions[index3 + 2] = z;
    this.velocities[index3] = vx;
    this.velocities[index3 + 1] = vy;
    this.velocities[index3 + 2] = vz;
    scratchColor.setHex(colorHex);
    this.colors[index3] = scratchColor.r;
    this.colors[index3 + 1] = scratchColor.g;
    this.colors[index3 + 2] = scratchColor.b;
    this.ages[index] = 0;
    this.lives[index] = life;
    this.sizeStarts[index] = sizeStart;
    this.sizeEnds[index] = sizeEnd;
    this.alphaStarts[index] = alphaStart;
    this.alphaEnds[index] = alphaEnd;
    this.gravities[index] = gravity;
    this.drags[index] = drag;
    this.rotationSpeeds[index] = rotationSpeed;
    this.sizes[index] = sizeStart;
    this.alphas[index] = 0;
    this.rotations[index] = Math.random() * Math.PI * 2;

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.rotationAttr.needsUpdate = true;
  }

  update(dt: number) {
    if (this.activeCount === 0) return;
    for (let index = 0; index < this.capacity; index++) {
      const life = this.lives[index];
      if (life <= 0) continue;
      const age = this.ages[index] + dt;
      if (age >= life) {
        this.lives[index] = 0;
        this.alphas[index] = 0;
        this.sizes[index] = 0;
        this.activeCount--;
        continue;
      }
      this.ages[index] = age;
      const index3 = index * 3;
      const damping = Math.exp(-this.drags[index] * dt);
      this.velocities[index3] *= damping;
      this.velocities[index3 + 1] = this.velocities[index3 + 1] * damping + this.gravities[index] * dt;
      this.velocities[index3 + 2] *= damping;
      this.positions[index3] += this.velocities[index3] * dt;
      this.positions[index3 + 1] += this.velocities[index3 + 1] * dt;
      this.positions[index3 + 2] += this.velocities[index3 + 2] * dt;

      const progress = age / life;
      const eased = 1 - (1 - progress) * (1 - progress);
      this.sizes[index] = THREE.MathUtils.lerp(this.sizeStarts[index], this.sizeEnds[index], eased);
      const fadeIn = Math.min(1, progress * 9);
      this.alphas[index] = THREE.MathUtils.lerp(this.alphaStarts[index], this.alphaEnds[index], eased) * fadeIn;
      this.rotations[index] += this.rotationSpeeds[index] * dt;
    }
    this.positionAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.rotationAttr.needsUpdate = true;
  }
}

type RingSlot = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  scaleStart: number;
  scaleEnd: number;
  alphaStart: number;
  alphaEnd: number;
};

/** Flat expanding rings (foam, shockwaves) lying on the water/deck plane. */
class RingPool {
  private readonly slots: RingSlot[] = [];
  private cursor = 0;

  constructor(group: THREE.Group, capacity: number, texture: THREE.Texture) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (let index = 0; index < capacity; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 19;
      group.add(mesh);
      this.slots.push({ mesh, material, age: 0, life: 0, scaleStart: 0, scaleEnd: 0, alphaStart: 0, alphaEnd: 0 });
    }
  }

  emit(
    x: number,
    y: number,
    z: number,
    life: number,
    scaleStart: number,
    scaleEnd: number,
    alphaStart: number,
    alphaEnd: number,
    colorHex: number,
    additive: boolean,
  ) {
    const slot = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.setScalar(scaleStart);
    slot.mesh.visible = true;
    slot.material.color.setHex(colorHex);
    slot.material.opacity = alphaStart;
    slot.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    slot.age = 0;
    slot.life = life;
    slot.scaleStart = scaleStart;
    slot.scaleEnd = scaleEnd;
    slot.alphaStart = alphaStart;
    slot.alphaEnd = alphaEnd;
  }

  update(dt: number) {
    for (const slot of this.slots) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const progress = Math.min(1, slot.age / slot.life);
      if (progress >= 1) {
        slot.life = 0;
        slot.mesh.visible = false;
        continue;
      }
      const eased = 1 - Math.pow(1 - progress, 3);
      slot.mesh.scale.setScalar(THREE.MathUtils.lerp(slot.scaleStart, slot.scaleEnd, eased));
      slot.material.opacity = THREE.MathUtils.lerp(slot.alphaStart, slot.alphaEnd, eased);
    }
  }
}

type SplashSlot = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  height: number;
  alpha: number;
};

/** Vertical splash columns; Y-axis billboarded quads with the splash texture. */
class SplashPool {
  private readonly slots: SplashSlot[] = [];
  private cursor = 0;

  constructor(group: THREE.Group, capacity: number, texture: THREE.Texture) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0, 0.5, 0);
    for (let index = 0; index < capacity; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 20;
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        mesh.rotation.y = Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z);
      };
      group.add(mesh);
      this.slots.push({ mesh, material, age: 0, life: 0, height: 1, alpha: 1 });
    }
  }

  emit(x: number, y: number, z: number, life: number, height: number, alpha: number, colorHex: number) {
    const slot = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.set(height * 0.42, height * 0.1, 1);
    slot.mesh.visible = true;
    slot.material.color.setHex(colorHex);
    slot.material.opacity = 0;
    slot.age = 0;
    slot.life = life;
    slot.height = height;
    slot.alpha = alpha;
  }

  update(dt: number) {
    for (const slot of this.slots) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const progress = Math.min(1, slot.age / slot.life);
      if (progress >= 1) {
        slot.life = 0;
        slot.mesh.visible = false;
        continue;
      }
      // Fast rise, then the column hangs and dissolves.
      const rise = Math.min(1, progress / 0.4);
      const easedRise = 1 - Math.pow(1 - rise, 3);
      const heightNow = slot.height * (0.25 + 0.75 * easedRise);
      slot.mesh.scale.set(slot.height * (0.34 + 0.2 * easedRise), heightNow, 1);
      slot.material.opacity = slot.alpha * Math.pow(1 - progress, 1.2) * Math.min(1, progress * 10);
    }
  }
}

/** Tumbling wood-chip debris via a single InstancedMesh. */
class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly state: Float32Array; // x y z vx vy vz rx ry rz avx avy avz age life size
  private static readonly STRIDE = 15;
  private cursor = 0;
  private activeCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.state = new Float32Array(capacity * DebrisPool.STRIDE);
    const geometry = new THREE.PlaneGeometry(1, 0.45);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scratchMatrix.makeScale(0, 0, 0);
    scratchColor.setHex(0x4a3524);
    for (let index = 0; index < capacity; index++) {
      this.mesh.setMatrixAt(index, scratchMatrix);
      this.mesh.setColorAt(index, scratchColor);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    colorHex: number,
  ) {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const base = index * DebrisPool.STRIDE;
    if (this.state[base + 13] <= 0) this.activeCount++;
    this.state[base] = x;
    this.state[base + 1] = y;
    this.state[base + 2] = z;
    this.state[base + 3] = vx;
    this.state[base + 4] = vy;
    this.state[base + 5] = vz;
    this.state[base + 6] = Math.random() * Math.PI * 2;
    this.state[base + 7] = Math.random() * Math.PI * 2;
    this.state[base + 8] = Math.random() * Math.PI * 2;
    this.state[base + 9] = rand(-9, 9);
    this.state[base + 10] = rand(-9, 9);
    this.state[base + 11] = rand(-9, 9);
    this.state[base + 12] = 0;
    this.state[base + 13] = life;
    this.state[base + 14] = size;
    scratchColor.setHex(colorHex);
    this.mesh.setColorAt(index, scratchColor);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    if (this.activeCount === 0) return;
    for (let index = 0; index < this.capacity; index++) {
      const base = index * DebrisPool.STRIDE;
      const life = this.state[base + 13];
      if (life <= 0) continue;
      const age = this.state[base + 12] + dt;
      if (age >= life || this.state[base + 1] < liveWaterSurfaceY - 0.15) {
        this.state[base + 13] = 0;
        this.activeCount--;
        scratchMatrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(index, scratchMatrix);
        continue;
      }
      this.state[base + 12] = age;
      this.state[base + 4] -= 22 * dt;
      this.state[base] += this.state[base + 3] * dt;
      this.state[base + 1] += this.state[base + 4] * dt;
      this.state[base + 2] += this.state[base + 5] * dt;
      this.state[base + 6] += this.state[base + 9] * dt;
      this.state[base + 7] += this.state[base + 10] * dt;
      this.state[base + 8] += this.state[base + 11] * dt;
      const progress = age / life;
      const shrink = progress > 0.75 ? (1 - progress) / 0.25 : 1;
      scratchEuler.set(this.state[base + 6], this.state[base + 7], this.state[base + 8]);
      scratchQuat.setFromEuler(scratchEuler);
      scratchVecA.set(this.state[base], this.state[base + 1], this.state[base + 2]);
      scratchVecB.setScalar(this.state[base + 14] * shrink);
      scratchMatrix.compose(scratchVecA, scratchQuat, scratchVecB);
      this.mesh.setMatrixAt(index, scratchMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

type LightSlot = {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
};

/** Fixed pool of point lights so bursts never allocate GPU light state. */
class LightPool {
  private readonly slots: LightSlot[] = [];

  constructor(group: THREE.Group, capacity: number) {
    for (let index = 0; index < capacity; index++) {
      const light = new THREE.PointLight(0xffffff, 0, 10);
      group.add(light);
      this.slots.push({ light, age: 0, life: 0, peak: 0 });
    }
  }

  request(x: number, y: number, z: number, colorHex: number, intensity: number, life: number, distance: number) {
    let slot: LightSlot | null = null;
    let oldestProgress = -1;
    for (const candidate of this.slots) {
      if (candidate.life <= 0) {
        slot = candidate;
        break;
      }
      const progress = candidate.age / candidate.life;
      if (progress > oldestProgress) {
        oldestProgress = progress;
        slot = candidate;
      }
    }
    if (!slot) return;
    slot.light.position.set(x, y, z);
    slot.light.color.setHex(colorHex);
    slot.light.intensity = intensity;
    slot.light.distance = distance;
    slot.age = 0;
    slot.life = life;
    slot.peak = intensity;
  }

  update(dt: number) {
    for (const slot of this.slots) {
      if (slot.life <= 0) continue;
      slot.age += dt;
      const progress = Math.min(1, slot.age / slot.life);
      if (progress >= 1) {
        slot.life = 0;
        slot.light.intensity = 0;
        continue;
      }
      slot.light.intensity = slot.peak * (1 - progress) * (1 - progress);
    }
  }
}

export class CombatFx {
  /** Live wave surface near the action (Game feeds gerstnerHeight each frame)
   *  so splash-vs-hull classification and splash rings ride the swell. */
  setWaterSurfaceY(y: number) {
    if (!Number.isFinite(y)) return;
    liveWaterSurfaceY = y + 0.22;
    liveWaterImpactThresholdY = y + 0.9;
  }

  private readonly root = new THREE.Group();
  private smoke: SpritePool | null = null;
  private flame: SpritePool | null = null;
  private sparks: SpritePool | null = null;
  private droplets: SpritePool | null = null;
  private rings: RingPool | null = null;
  private splashes: SplashPool | null = null;
  private debris: DebrisPool | null = null;
  private lights: LightPool | null = null;
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  init(scene: THREE.Scene) {
    if (!this.smoke) {
      this.smoke = new SpritePool(192, createSmokeTexture(), THREE.NormalBlending, 21);
      this.flame = new SpritePool(96, createFlashTexture(), THREE.AdditiveBlending, 23);
      this.sparks = new SpritePool(256, createSparkTexture(), THREE.AdditiveBlending, 24);
      this.droplets = new SpritePool(256, createDropletTexture(), THREE.NormalBlending, 22);
      this.rings = new RingPool(this.root, 12, createRingTexture());
      this.splashes = new SplashPool(this.root, 10, createSplashTexture());
      this.debris = new DebrisPool(64);
      this.lights = new LightPool(this.root, 4);
      this.root.add(this.smoke.points, this.flame.points, this.sparks.points, this.droplets.points, this.debris.mesh);
    }
    scene.add(this.root);
  }

  unlockAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioContext = new AudioCtx();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.22;
      this.masterGain.connect(this.audioContext.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.audioContext);
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  update(dt: number) {
    this.smoke?.update(dt);
    this.flame?.update(dt);
    this.sparks?.update(dt);
    this.droplets?.update(dt);
    this.rings?.update(dt);
    this.splashes?.update(dt);
    this.debris?.update(dt);
    this.lights?.update(dt);
  }

  emitLaunch(projectile: Projectile, cameraPos: THREE.Vector3, isLocalSource: boolean) {
    this.playShotSound(projectile.type, projectile.position, cameraPos, isLocalSource, projectile.weaponId);
    if (!this.flame || !this.smoke || !this.sparks || !this.droplets || !this.lights) return;

    const position = projectile.position;
    const velocity = projectile.velocity;
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z) || 1;
    const dirX = velocity.x / speed;
    const dirY = velocity.y / speed;
    const dirZ = velocity.z / speed;
    const palette = this.getPalette(projectile.type);
    const type = projectile.type;

    if (type === 'bullet') {
      this.flame.emit(
        position.x + dirX * 0.3, position.y + dirY * 0.3, position.z + dirZ * 0.3,
        0, 0, 0, 0.08, 0.5, 1, 0.9, 0, palette.flash, 0, 0, 0,
      );
      for (let index = 0; index < 2; index++) {
        this.sparks.emit(
          position.x, position.y, position.z,
          dirX * rand(6, 11) + rand(-1.6, 1.6), dirY * rand(6, 11) + rand(-1, 1.6), dirZ * rand(6, 11) + rand(-1.6, 1.6),
          rand(0.14, 0.24), rand(0.08, 0.14), 0.03, 1, 0, 0xffe9b8, -10, 1.5, 0,
        );
      }
      this.smoke.emit(
        position.x, position.y, position.z,
        dirX * 1.4, dirY * 1.4 + 0.5, dirZ * 1.4,
        rand(0.45, 0.7), 0.22, 0.85, 0.32, 0, pick(0xb9bec6, 0x9aa0a8), 0.4, 2.4, rand(-1.5, 1.5),
      );
    } else if (type === 'tsunami') {
      this.flame.emit(position.x, position.y, position.z, 0, 0, 0, 0.16, 2.2, 5.2, 0.85, 0, palette.flash, 0, 0, 0);
      for (let index = 0; index < 10; index++) {
        this.droplets.emit(
          position.x, position.y, position.z,
          dirX * rand(3, 7) + rand(-2.5, 2.5), rand(1.5, 4.5), dirZ * rand(3, 7) + rand(-2.5, 2.5),
          rand(0.4, 0.8), rand(0.14, 0.3), rand(0.06, 0.12), 0.9, 0, 0xcfe8f4, -14, 0.6, 0,
        );
      }
      this.smoke.emit(
        position.x, position.y + 0.3, position.z,
        dirX * 2, 1, dirZ * 2,
        rand(0.8, 1.2), 1.2, 3.6, 0.4, 0, 0xbfe9f2, 0.5, 1.8, rand(-1, 1),
      );
      this.lights.request(position.x, position.y + 0.5, position.z, 0x8fefff, 3, 0.2, 40);
    } else {
      // cannonball / firebomb / chainshot: muzzle flash + powder smoke + sparks
      const big = type === 'cannonball';
      this.flame.emit(
        position.x + dirX * 0.5, position.y + dirY * 0.5, position.z + dirZ * 0.5,
        0, 0, 0, 0.1, big ? 1.2 : 0.9, big ? 2.6 : 2, 0.95, 0, palette.flash, 0, 0, 0,
      );
      this.flame.emit(
        position.x + dirX * 0.3, position.y + dirY * 0.3, position.z + dirZ * 0.3,
        0, 0, 0, 0.07, big ? 0.7 : 0.5, big ? 1.4 : 1, 1, 0, 0xfff6e0, 0, 0, 0,
      );
      const sparkCount = big ? 6 : 4;
      for (let index = 0; index < sparkCount; index++) {
        this.sparks.emit(
          position.x, position.y, position.z,
          dirX * rand(8, 15) + rand(-2.4, 2.4), dirY * rand(8, 15) + rand(-1.5, 2.4), dirZ * rand(8, 15) + rand(-2.4, 2.4),
          rand(0.2, 0.4), rand(0.1, 0.2), 0.04, 1, 0, type === 'firebomb' ? 0xffb066 : 0xffe0a2, -11, 1.8, 0,
        );
      }
      const smokeCount = big ? 4 : 3;
      const smokeTint = type === 'firebomb' ? pick(0x6f6258, 0x554c44) : pick(0x9aa0a8, 0x6f747c);
      for (let index = 0; index < smokeCount; index++) {
        this.smoke.emit(
          position.x + rand(-0.2, 0.2), position.y + rand(-0.1, 0.2), position.z + rand(-0.2, 0.2),
          dirX * rand(2.6, 4.6) + rand(-0.7, 0.7), dirY * rand(2.6, 4.6) + rand(0.4, 1), dirZ * rand(2.6, 4.6) + rand(-0.7, 0.7),
          rand(0.8, 1.4), rand(0.45, 0.65), rand(1.7, 2.4), 0.5, 0, smokeTint, 0.5, 2.4, rand(-1.8, 1.8),
        );
      }
      this.lights.request(position.x + dirX, position.y + dirY, position.z + dirZ, palette.flash, big ? 2.6 : 1.9, 0.13, 26);
    }
  }

  emitImpact(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3) {
    const onWater = position.y < liveWaterImpactThresholdY;
    if (onWater) {
      const magnitude = type === 'bullet' ? 0.5 : type === 'cannonball' ? 1.15 : type === 'tsunami' ? 1.5 : 0.9;
      this.spawnWaterSplash(position.x, position.z, magnitude);
      this.playSplashSound(type, position, cameraPos);
      return;
    }

    this.playImpactSound(type, position, cameraPos);
    if (!this.flame || !this.smoke || !this.sparks || !this.debris || !this.lights) return;

    const palette = this.getPalette(type);
    const big = type !== 'bullet';
    this.flame.emit(
      position.x, position.y, position.z,
      0, 0, 0, big ? 0.12 : 0.08, big ? 0.7 : 0.4, big ? 1.8 : 0.9, 0.85, 0, palette.impact, 0, 0, 0,
    );
    const sparkCount = big ? 9 : 5;
    for (let index = 0; index < sparkCount; index++) {
      const theta = Math.random() * Math.PI * 2;
      const up = rand(0.25, 1);
      const lateral = Math.sqrt(Math.max(0, 1 - up * up));
      const spd = rand(4, big ? 10 : 7);
      this.sparks.emit(
        position.x, position.y, position.z,
        Math.cos(theta) * lateral * spd, up * spd, Math.sin(theta) * lateral * spd,
        rand(0.25, 0.5), rand(0.08, 0.18), 0.03, 1, 0, palette.impact, -13, 1.2, 0,
      );
    }
    // wood-chip debris
    const chipCount = big ? 6 : 3;
    for (let index = 0; index < chipCount; index++) {
      const theta = Math.random() * Math.PI * 2;
      const spd = rand(2.5, big ? 7 : 4.5);
      this.debris.emit(
        position.x, position.y, position.z,
        Math.cos(theta) * spd, rand(2, big ? 6.5 : 4.5), Math.sin(theta) * spd,
        rand(0.7, 1.3), rand(0.1, big ? 0.28 : 0.18), pick(0x4a3524, pick(0x5d4630, 0x362617)),
      );
    }
    const smokeCount = big ? 3 : 1;
    for (let index = 0; index < smokeCount; index++) {
      this.smoke.emit(
        position.x + rand(-0.2, 0.2), position.y + rand(0, 0.3), position.z + rand(-0.2, 0.2),
        rand(-0.6, 0.6), rand(0.7, 1.6), rand(-0.6, 0.6),
        rand(0.6, 1.1), rand(0.3, 0.5), rand(1.1, big ? 2 : 1.4), 0.45, 0, pick(0x7a7169, 0x565049), 0.5, 2, rand(-2, 2),
      );
    }
    if (type === 'firebomb') {
      for (let index = 0; index < 3; index++) {
        this.flame.emit(
          position.x + rand(-0.3, 0.3), position.y + rand(0, 0.4), position.z + rand(-0.3, 0.3),
          rand(-0.6, 0.6), rand(1, 2.4), rand(-0.6, 0.6),
          rand(0.25, 0.4), rand(0.4, 0.7), rand(0.9, 1.4), 0.8, 0, pick(0xff8642, 0xffb066), 1.5, 1.5, 0,
        );
      }
    }
    if (type === 'chainshot') {
      // Canvas-scrap burst — pale, fluttery sailcloth torn free by the ball-and-chain,
      // plus a low dusty puff. Reads distinctly from a wooden splinter hit.
      for (let index = 0; index < 6; index++) {
        const theta = Math.random() * Math.PI * 2;
        const spd = rand(2, 5.5);
        this.debris.emit(
          position.x, position.y, position.z,
          Math.cos(theta) * spd, rand(1.4, 4.2), Math.sin(theta) * spd,
          rand(0.6, 1.15), rand(0.13, 0.26), pick(0xe8e2d2, pick(0xd7cfba, 0xcabf9f)),
        );
      }
      this.smoke.emit(
        position.x, position.y + 0.15, position.z,
        rand(-0.4, 0.4), rand(0.6, 1.3), rand(-0.4, 0.4),
        rand(0.5, 0.85), 0.3, 1.1, 0.32, 0, 0xd9d2c2, 0.35, 2, rand(-2, 2),
      );
    }
    if (big) {
      this.lights.request(position.x, position.y + 0.3, position.z, palette.impact, 2, 0.16, 20);
    }
  }

  /**
   * Bilge bail — a scooped arc of water flung overboard. Pooled droplets follow a
   * ballistic arc in the toss direction, capped with a light spray puff.
   */
  emitBailScoop(position: Vec3, dirX: number, dirZ: number) {
    if (!this.droplets || !this.smoke) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = dirX / len;
    const nz = dirZ / len;
    for (let index = 0; index < 9; index++) {
      const spread = rand(-0.55, 0.55);
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const outSpeed = rand(2.2, 4.6);
      const vx = (nx * cos - nz * sin) * outSpeed;
      const vz = (nz * cos + nx * sin) * outSpeed;
      this.droplets.emit(
        position.x, position.y + 0.1, position.z,
        vx, rand(2.6, 4.8), vz,
        rand(0.42, 0.72), rand(0.06, 0.12), rand(0.03, 0.06), 0.9, 0, pick(0xd8ecf6, 0xbfe0ee), -16, 0.42, 0,
      );
    }
    this.smoke.emit(
      position.x + nx * 0.3, position.y + 0.22, position.z + nz * 0.3,
      nx * 0.7, 0.5, nz * 0.7,
      rand(0.4, 0.62), 0.2, 0.55, 0.26, 0, 0xdfeef2, 0.2, 1.8, rand(-1, 1),
    );
  }

  /** A faint travelling trail marker — pale-blue for chainshot to read distinctly
   *  from a round shot's dark iron ball. Call once per frame while in flight. */
  emitTrail(position: Vec3, colorHex: number) {
    if (!this.sparks) return;
    this.sparks.emit(
      position.x, position.y, position.z,
      0, 0, 0,
      0.32, 0.11, 0.02, 0.55, 0, colorHex, 0, 0.6, 0,
    );
  }

  /**
   * Water streaming out of a holed hull section below the waterline. Deliberately
   * light (a few droplets + none of the heavy pools) — call it throttled per hole.
   */
  emitHullLeak(position: Vec3, outX: number, outZ: number) {
    if (!this.droplets) return;
    const len = Math.hypot(outX, outZ) || 1;
    const nx = outX / len;
    const nz = outZ / len;
    for (let index = 0; index < 3; index++) {
      this.droplets.emit(
        position.x, position.y, position.z,
        nx * rand(1.1, 2.6) + rand(-0.4, 0.4), rand(-0.6, 0.2), nz * rand(1.1, 2.6) + rand(-0.4, 0.4),
        rand(0.4, 0.75), rand(0.05, 0.09), 0.03, 0.85, 0, pick(0xbfe0ee, 0xa9d2e6), -12, 0.55, 0,
      );
    }
  }

  emitShipHitConfirm(position: Vec3, cameraPos: THREE.Vector3) {
    this.playShipHitConfirmSound(position, cameraPos);
    if (!this.flame || !this.sparks) return;
    this.flame.emit(position.x, position.y, position.z, 0, 0, 0, 0.14, 0.45, 1.05, 0.75, 0, 0xffe9b0, 0, 0, 0);
    for (let index = 0; index < 3; index++) {
      const theta = Math.random() * Math.PI * 2;
      this.sparks.emit(
        position.x, position.y, position.z,
        Math.cos(theta) * rand(2, 4), rand(1.5, 3.5), Math.sin(theta) * rand(2, 4),
        rand(0.2, 0.35), rand(0.07, 0.12), 0.02, 1, 0, 0xffd98a, -9, 1, 0,
      );
    }
  }

  emitRespawn(position: Vec3, cameraPos: THREE.Vector3) {
    this.playRespawnSound(position, cameraPos);
    if (!this.flame || !this.sparks || !this.lights) return;
    this.flame.emit(position.x, position.y + 0.6, position.z, 0, 0.6, 0, 0.35, 0.8, 2.8, 0.7, 0, 0x9bddff, 0, 0, 0);
    for (let index = 0; index < 12; index++) {
      const theta = Math.random() * Math.PI * 2;
      const radius = rand(0.2, 0.9);
      this.sparks.emit(
        position.x + Math.cos(theta) * radius, position.y + rand(0, 0.5), position.z + Math.sin(theta) * radius,
        Math.cos(theta) * rand(0.2, 0.7), rand(1.2, 3.2), Math.sin(theta) * rand(0.2, 0.7),
        rand(0.55, 1), rand(0.08, 0.16), 0.03, 0.9, 0, pick(0xbfe6ff, 0xe8f7ff), -1.2, 0.6, 0,
      );
    }
    this.lights.request(position.x, position.y + 1, position.z, 0x9bddff, 1.6, 0.4, 24);
  }

  /** Shark killed — blood bloom on the water surface */
  emitSharkDeathBloom(position: Vec3, cameraPos: THREE.Vector3) {
    const surfaceY = Math.max(liveWaterSurfaceY, position.y - 0.05);
    this.playSharkDeathSound({ x: position.x, y: surfaceY, z: position.z }, cameraPos);
    if (!this.smoke || !this.droplets || !this.rings) return;

    this.rings.emit(position.x, surfaceY + 0.03, position.z, 1.05, 0.5, 5, 0.8, 0, 0x8a1a24, false);
    this.rings.emit(position.x, surfaceY + 0.05, position.z, 0.8, 0.3, 3.2, 0.7, 0, 0x4a060c, false);
    for (let index = 0; index < 5; index++) {
      const theta = Math.random() * Math.PI * 2;
      const radius = rand(0.1, 0.7);
      this.smoke.emit(
        position.x + Math.cos(theta) * radius, surfaceY + rand(0.05, 0.25), position.z + Math.sin(theta) * radius,
        Math.cos(theta) * rand(0.3, 0.9), rand(0.1, 0.4), Math.sin(theta) * rand(0.3, 0.9),
        rand(1.1, 1.8), rand(0.4, 0.7), rand(1.8, 2.8), 0.55, 0, pick(0x7c1220, 0x4a060c), 0.1, 1.4, rand(-1, 1),
      );
    }
    for (let index = 0; index < 8; index++) {
      const theta = Math.random() * Math.PI * 2;
      this.droplets.emit(
        position.x, surfaceY + 0.1, position.z,
        Math.cos(theta) * rand(1, 3), rand(2, 4.5), Math.sin(theta) * rand(1, 3),
        rand(0.4, 0.7), rand(0.1, 0.2), 0.05, 0.9, 0, pick(0xa11622, 0xc42832), -13, 0.5, 0,
      );
    }
  }

  private playSharkDeathSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1, 200);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playNoise(now, 0.35, 420, 0.55, volume * 0.55, 'lowpass');
    this.playTone(now + 0.02, 95, 220, 0.4, volume * 0.35, 'sawtooth');
  }

  emitKegExplosion(position: Vec3, cameraPos: THREE.Vector3) {
    this.playKegExplosionSound(position, cameraPos);
    if (!this.flame || !this.smoke || !this.sparks || !this.debris || !this.rings || !this.lights) return;

    // fireball core + tongues
    this.flame.emit(position.x, position.y + 0.2, position.z, 0, 0.5, 0, 0.18, 1.6, 5.4, 1, 0, 0xffefbd, 0, 0, 0);
    for (let index = 0; index < 5; index++) {
      const theta = Math.random() * Math.PI * 2;
      const radius = rand(0.2, 0.8);
      this.flame.emit(
        position.x + Math.cos(theta) * radius, position.y + rand(0.1, 0.7), position.z + Math.sin(theta) * radius,
        Math.cos(theta) * rand(1.5, 4), rand(1.5, 4), Math.sin(theta) * rand(1.5, 4),
        rand(0.25, 0.42), rand(0.9, 1.5), rand(2.4, 3.6), 0.85, 0, pick(0xffc86a, pick(0xff8c3a, 0xff5b2d)), 1, 1.6, rand(-2, 2),
      );
    }
    // shockwave ring
    this.rings.emit(position.x, position.y + 0.25, position.z, 0.45, 0.6, 9, 0.6, 0, 0xffd9a0, true);
    // sparks
    for (let index = 0; index < 16; index++) {
      const theta = Math.random() * Math.PI * 2;
      const up = rand(-0.1, 1);
      const lateral = Math.sqrt(Math.max(0, 1 - up * up));
      const spd = rand(7, 17);
      this.sparks.emit(
        position.x, position.y + 0.3, position.z,
        Math.cos(theta) * lateral * spd, up * spd, Math.sin(theta) * lateral * spd,
        rand(0.35, 0.75), rand(0.1, 0.22), 0.04, 1, 0, pick(0xffe0a2, 0xffb066), -15, 0.9, 0,
      );
    }
    // rolling smoke
    for (let index = 0; index < 7; index++) {
      const theta = Math.random() * Math.PI * 2;
      const radius = rand(0.1, 1);
      this.smoke.emit(
        position.x + Math.cos(theta) * radius, position.y + rand(0.3, 1.1), position.z + Math.sin(theta) * radius,
        Math.cos(theta) * rand(0.6, 1.6), rand(1.4, 3), Math.sin(theta) * rand(0.6, 1.6),
        rand(1.4, 2.4), rand(1, 1.5), rand(3.4, 4.9), 0.6, 0, pick(0x4a453f, 0x35322e), 0.35, 1.5, rand(-1.4, 1.4),
      );
    }
    // debris
    for (let index = 0; index < 9; index++) {
      const theta = Math.random() * Math.PI * 2;
      const spd = rand(5, 12);
      this.debris.emit(
        position.x, position.y + 0.3, position.z,
        Math.cos(theta) * spd, rand(4, 10), Math.sin(theta) * spd,
        rand(0.9, 1.6), rand(0.14, 0.34), pick(0x4a3524, pick(0x5d4630, 0x2c2015)),
      );
    }
    this.lights.request(position.x, position.y + 0.8, position.z, 0xffa64d, 5, 0.32, 60);

    if (position.y < liveWaterImpactThresholdY + 0.3) {
      this.spawnWaterSplash(position.x, position.z, 1.6);
      this.playSplashSound('cannonball', position, cameraPos);
    }
  }

  /** Splash column + expanding foam ring + ballistic droplets at the sea surface. */
  private spawnWaterSplash(x: number, z: number, magnitude: number) {
    if (!this.splashes || !this.rings || !this.droplets || !this.smoke) return;
    const y = liveWaterSurfaceY;
    this.splashes.emit(x, y, z, rand(0.65, 0.85) * Math.max(0.7, Math.sqrt(magnitude)), rand(2.4, 3.2) * magnitude, 0.92, 0xdfeef6);
    this.rings.emit(x, y + 0.02, z, rand(0.8, 1.1), 0.4, rand(2.6, 3.4) * magnitude, 0.75, 0, 0xeaf6fa, false);
    const dropletCount = Math.round(8 + magnitude * 5);
    for (let index = 0; index < dropletCount; index++) {
      const theta = Math.random() * Math.PI * 2;
      const lateral = rand(0.6, 2.4) * magnitude;
      this.droplets.emit(
        x, y + 0.15, z,
        Math.cos(theta) * lateral, rand(3, 6.5) * magnitude, Math.sin(theta) * lateral,
        rand(0.5, 0.9), rand(0.1, 0.26) * magnitude, rand(0.04, 0.08), 0.95, 0, pick(0xd8ecf6, 0xbfe0ee), -16, 0.5, 0,
      );
    }
    // fine mist hanging over the splash
    this.smoke.emit(
      x, y + 0.6 * magnitude, z,
      rand(-0.3, 0.3), rand(0.5, 1), rand(-0.3, 0.3),
      rand(0.7, 1.1), 0.6 * magnitude, 1.8 * magnitude, 0.3, 0, 0xdfeef2, 0.3, 1.6, rand(-1, 1),
    );
  }

  private getPalette(type: ProjectileType) {
    switch (type) {
      case 'cannonball':
        return { flash: 0xffd8a0, impact: 0xffbb73 };
      case 'firebomb':
        return { flash: 0xff8642, impact: 0xff5b2d };
      case 'chainshot':
        return { flash: 0xb8d9ff, impact: 0x7fb4ee };
      case 'tsunami':
        return { flash: 0x8fefff, impact: 0x60cfff };
      case 'bullet':
      default:
        return { flash: 0xfff2c2, impact: 0xece8ff };
    }
  }

  private playShotSound(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3, isLocalSource: boolean, weaponId?: WeaponId) {
    const bulletRange = weaponId === 'eye_of_reach' ? 320 : weaponId === 'blunderbuss' ? 150 : 130;
    const volume = this.getSpatialVolume(position, cameraPos, isLocalSource ? 1.4 : 1, type === 'tsunami' ? 420 : type === 'cannonball' ? 240 : bulletRange);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    if (type === 'cannonball') {
      this.playNoise(now, 0.38, 180, 0.7, volume * 1.15, 'lowpass');
      this.playTone(now, 82, 38, 0.34, volume * 0.9, 'triangle');
      this.playTone(now + 0.02, 180, 110, 0.12, volume * 0.25, 'square');
    } else if (type === 'firebomb') {
      this.playNoise(now, 0.2, 1200, 1.2, volume * 0.8, 'bandpass');
      this.playTone(now, 180, 90, 0.18, volume * 0.45, 'sawtooth');
    } else if (type === 'chainshot') {
      this.playNoise(now, 0.16, 900, 0.9, volume * 0.6, 'bandpass');
      this.playTone(now, 210, 120, 0.16, volume * 0.38, 'square');
    } else if (type === 'tsunami') {
      this.playNoise(now, 0.55, 240, 0.95, volume * 0.9, 'lowpass');
      this.playTone(now, 70, 46, 0.46, volume * 0.58, 'sawtooth');
    } else if (weaponId === 'eye_of_reach') {
      // Long rifle crack: bright muzzle snap, wood/steel body, and a low echo tail.
      this.playNoise(now, 0.06, 5200, 1.4, volume * 0.95, 'highpass');
      this.playTone(now, 1160, 620, 0.09, volume * 0.34, 'square');
      this.playTone(now + 0.012, 92, 56, 0.34, volume * 0.42, 'triangle');
      this.playNoise(now + 0.08, 0.42, 310, 0.72, volume * 0.34, 'lowpass');
      this.playTone(now + 0.16, 260, 150, 0.22, volume * 0.12, 'sine');
    } else if (weaponId === 'blunderbuss') {
      this.playNoise(now, 0.11, 2800, 1.1, volume * 0.72, 'bandpass');
      this.playNoise(now + 0.025, 0.22, 430, 0.7, volume * 0.55, 'lowpass');
      this.playTone(now, 180, 88, 0.18, volume * 0.34, 'triangle');
    } else if (weaponId === 'flintknock') {
      this.playNoise(now, 0.08, 3600, 1.1, volume * 0.68, 'bandpass');
      this.playTone(now, 340, 120, 0.13, volume * 0.3, 'square');
      this.playNoise(now + 0.06, 0.18, 260, 0.75, volume * 0.28, 'lowpass');
    } else {
      this.playNoise(now, 0.12, 1500, 0.8, volume * 0.55, 'bandpass');
      this.playTone(now, 280, 120, 0.1, volume * 0.25, 'triangle');
    }
  }

  private playImpactSound(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1, type === 'cannonball' ? 220 : 120);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    if (type === 'cannonball') {
      this.playNoise(now, 0.22, 240, 1.1, volume * 0.72, 'lowpass');
      this.playTone(now, 70, 42, 0.22, volume * 0.42, 'triangle');
    } else if (type === 'firebomb') {
      this.playNoise(now, 0.2, 950, 1.2, volume * 0.6, 'bandpass');
      this.playTone(now, 150, 70, 0.18, volume * 0.28, 'sawtooth');
    } else {
      this.playNoise(now, 0.1, 850, 0.85, volume * 0.28, 'bandpass');
    }
  }

  /** Water-miss splash: bright slap, low whoomp, and a short foam hiss. */
  private playSplashSound(type: ProjectileType, position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1, type === 'cannonball' || type === 'tsunami' ? 200 : 110);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    const scale = type === 'bullet' ? 0.55 : 1;
    this.playNoise(now, 0.14, 1700, 0.9, volume * 0.5 * scale, 'bandpass');
    this.playNoise(now + 0.04, 0.38, 520, 0.6, volume * 0.55 * scale, 'lowpass');
    this.playTone(now + 0.01, 130, 58, 0.2, volume * 0.22 * scale, 'sine');
    this.playNoise(now + 0.16, 0.28, 2600, 0.7, volume * 0.16 * scale, 'highpass');
  }

  private playRespawnSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1.2, 220);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playTone(now, 240, 360, 0.18, volume * 0.22, 'sine');
    this.playTone(now + 0.06, 360, 520, 0.24, volume * 0.18, 'sine');
    this.playNoise(now, 0.16, 1400, 1.1, volume * 0.12, 'bandpass');
  }

  private playKegExplosionSound(position: Vec3, cameraPos: THREE.Vector3) {
    const volume = this.getSpatialVolume(position, cameraPos, 1.4, 260);
    if (volume <= 0.01) return;
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playNoise(now, 0.36, 180, 0.68, volume * 1.25, 'lowpass');
    this.playNoise(now + 0.03, 0.22, 980, 1.15, volume * 0.5, 'bandpass');
    this.playTone(now, 62, 34, 0.28, volume * 0.52, 'triangle');
    this.playTone(now + 0.02, 180, 92, 0.18, volume * 0.18, 'sawtooth');
  }

  private playShipHitConfirmSound(position: Vec3, cameraPos: THREE.Vector3) {
    const spatial = this.getSpatialVolume(position, cameraPos, 1.1, 260);
    const volume = Math.max(0.18, spatial * 0.95);
    this.unlockAudio();
    const ctx = this.audioContext;
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playNoise(now, 0.09, 720, 1.1, volume * 0.12, 'bandpass');
    this.playTone(now, 246, 294, 0.11, volume * 0.16, 'sine');
    this.playTone(now + 0.035, 369, 440, 0.16, volume * 0.2, 'triangle');
    this.playTone(now + 0.075, 440, 392, 0.12, volume * 0.12, 'triangle');
  }

  private playTone(
    when: number,
    fromFreq: number,
    toFreq: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromFreq, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), when + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + duration);
  }

  private playNoise(
    when: number,
    duration: number,
    frequency: number,
    q: number,
    volume: number,
    filterType: BiquadFilterType,
  ) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    const noiseBuffer = this.noiseBuffer;
    if (!ctx || !master || !noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, when);
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(when);
    source.stop(when + duration);
  }

  private getSpatialVolume(position: Vec3, cameraPos: THREE.Vector3, boost: number, maxDistance: number) {
    const dx = position.x - cameraPos.x;
    const dy = position.y - cameraPos.y;
    const dz = position.z - cameraPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const normalized = 1 - THREE.MathUtils.clamp(distance / maxDistance, 0, 1);
    return normalized * normalized * boost;
  }

  private createNoiseBuffer(ctx: AudioContext) {
    const length = Math.floor(ctx.sampleRate * 0.8);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length * 0.1);
    }
    return buffer;
  }
}
