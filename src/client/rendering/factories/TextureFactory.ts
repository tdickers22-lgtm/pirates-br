/** Canvas-generated textures (wisps, lantern glow, foliage, signage). */
import * as THREE from 'three';

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
