/** Canvas-generated textures (storm wall, wisps, lantern glow, foliage, signage). */
import * as THREE from 'three';

export function makeStormTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(18, 27, 45, 0)');
  gradient.addColorStop(0.16, 'rgba(39, 57, 90, 0.38)');
  gradient.addColorStop(0.5, 'rgba(47, 66, 104, 0.82)');
  gradient.addColorStop(0.84, 'rgba(32, 47, 75, 0.42)');
  gradient.addColorStop(1, 'rgba(18, 27, 45, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 60; index++) {
    const x = Math.random() * canvas.width;
    const width = 2 + Math.random() * 6;
    const alpha = 0.035 + Math.random() * 0.08;
    ctx.fillStyle = `rgba(120, 158, 196, ${alpha})`;
    ctx.fillRect(x, 0, width, canvas.height);
  }

  for (let index = 0; index < 36; index++) {
    const y = Math.random() * canvas.height;
    const height = 8 + Math.random() * 28;
    const alpha = 0.04 + Math.random() * 0.08;
    ctx.fillStyle = `rgba(16, 25, 48, ${alpha})`;
    ctx.fillRect(0, y, canvas.width, height);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(18, 1);
  return texture;
}

export function makeWindWispTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 24;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = ctx.createLinearGradient(0, canvas.height * 0.5, canvas.width, canvas.height * 0.5);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.18, 'rgba(215,240,255,0.12)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.82, 'rgba(215,240,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height * 0.5);
  ctx.quadraticCurveTo(canvas.width * 0.18, 0, canvas.width * 0.42, canvas.height * 0.34);
  ctx.quadraticCurveTo(canvas.width * 0.7, canvas.height * 0.8, canvas.width, canvas.height * 0.5);
  ctx.quadraticCurveTo(canvas.width * 0.7, canvas.height, canvas.width * 0.42, canvas.height * 0.66);
  ctx.quadraticCurveTo(canvas.width * 0.18, canvas.height * 0.08, 0, canvas.height * 0.5);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Soft warm radial halo for island lantern / campfire glow sprites. */
export function makeLanternGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,240,200,0.95)');
    grad.addColorStop(0.32, 'rgba(255,196,116,0.52)');
    grad.addColorStop(0.7, 'rgba(255,150,72,0.14)');
    grad.addColorStop(1, 'rgba(255,140,64,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Teardrop flame billboard for campfire flame sprites (bright base, wispy tip). */
export function makeLanternFlameTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 74, 2, 32, 62, 46);
    grad.addColorStop(0, 'rgba(255,248,214,0.98)');
    grad.addColorStop(0.35, 'rgba(255,190,96,0.85)');
    grad.addColorStop(0.7, 'rgba(255,120,44,0.34)');
    grad.addColorStop(1, 'rgba(200,64,20,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(32, 4);
    ctx.quadraticCurveTo(60, 52, 48, 82);
    ctx.quadraticCurveTo(32, 100, 16, 82);
    ctx.quadraticCurveTo(4, 52, 32, 4);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ── Foliage alpha textures (cached; white shapes so per-instance colors tint
// them). These turn the flat cross-quads from solid green rectangles into
// wispy grass blades / feathered fern fronds. ──
let _grassBladeTex: THREE.CanvasTexture | null = null;
let _fernFrondTex: THREE.CanvasTexture | null = null;

export function makeGrassBladeTexture(): THREE.CanvasTexture {
  if (_grassBladeTex) return _grassBladeTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  // A tuft of tapering blades fanning up from the bottom edge. White with a
  // slight top-fade so tips feel soft; alpha carries the blade shape.
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const baseX = size * (0.12 + (i / (blades - 1)) * 0.76);
    const lean = (i - (blades - 1) / 2) * 6 + (Math.sin(i * 2.3) * 5);
    const tipX = baseX + lean;
    const w = 6 + (i % 3) * 2;
    const tipY = size * (0.06 + (i % 4) * 0.05);
    const grad = ctx.createLinearGradient(0, size, 0, tipY);
    grad.addColorStop(0, 'rgba(230,255,220,0.95)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.98)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseX - w * 0.5, size);
    ctx.quadraticCurveTo((baseX + tipX) * 0.5 - w * 0.3, size * 0.5, tipX, tipY);
    ctx.quadraticCurveTo((baseX + tipX) * 0.5 + w * 0.3, size * 0.5, baseX + w * 0.5, size);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _grassBladeTex = tex;
  return tex;
}

export function makeFernFrondTexture(): THREE.CanvasTexture {
  if (_fernFrondTex) return _fernFrondTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  // A single arching frond: central rachis + paired pinnae (leaflets).
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  const baseX = size * 0.5;
  const tipX = size * 0.66;
  const rachis = (t: number) => ({
    x: baseX + (tipX - baseX) * t,
    y: size - (size * 0.92) * t,
  });
  // rachis
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(baseX, size);
  for (let t = 0; t <= 1; t += 0.1) { const p = rachis(t); ctx.lineTo(p.x, p.y); }
  ctx.stroke();
  // pinnae
  ctx.lineWidth = 3;
  for (let t = 0.08; t < 0.98; t += 0.075) {
    const p = rachis(t);
    const len = (1 - t) * size * 0.32 + 6;
    const droop = 0.5 + t * 0.5;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(p.x + side * len * 0.6, p.y + len * 0.15 * droop, p.x + side * len, p.y + len * 0.35 * droop);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _fernFrondTex = tex;
  return tex;
}

export function makeUpgradeSignTexture(title: string, effect: string, accentHex: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const accent = `#${accentHex.toString(16).padStart(6, '0')}`;
  // Weathered WOOD plank, not a near-black board — reads as a carved sign from
  // a distance against bright terrain instead of a black slab.
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(158, 118, 66, 0.99)');
  gradient.addColorStop(0.5, 'rgba(139, 101, 54, 0.99)');
  gradient.addColorStop(1, 'rgba(122, 87, 46, 0.99)');
  ctx.fillStyle = gradient;
  ctx.fillRect(12, 12, canvas.width - 24, canvas.height - 24);
  // Plank grain streaks
  ctx.strokeStyle = 'rgba(90, 62, 32, 0.35)';
  ctx.lineWidth = 2;
  for (let gy = 30; gy < canvas.height - 20; gy += 22) {
    ctx.beginPath();
    ctx.moveTo(16, gy + Math.sin(gy) * 3);
    ctx.lineTo(canvas.width - 16, gy + Math.cos(gy * 0.7) * 3);
    ctx.stroke();
  }
  ctx.lineWidth = 8;
  ctx.strokeStyle = accent;
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(58, 38, 18, 0.7)';
  ctx.strokeRect(34, 34, canvas.width - 68, canvas.height - 68);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Dark engraved lettering on the light plank
  ctx.fillStyle = '#2c1a0a';
  ctx.font = '700 46px Georgia, serif';
  ctx.fillText(title.toUpperCase(), canvas.width * 0.5, 72);
  ctx.fillStyle = accent;
  ctx.font = '700 28px system-ui, sans-serif';
  ctx.fillText(effect, canvas.width * 0.5, 122);
  ctx.fillStyle = 'rgba(52, 34, 16, 0.82)';
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillText('UPGRADE FORGE', canvas.width * 0.5, 157);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
