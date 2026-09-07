// SHIP TEXTURES — the procedural canvases every hull, sail and barrel is
// painted with. Extracted verbatim from ShipRenderer (codehealth-03 phase 1,
// HULLGEO-01 slice a); scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';

/** Marks canvas art as sRGB (authored colors, not linear data) and enables
 *  anisotropic filtering so deck planks stay crisp at grazing angles. */
export function finishCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export type WoodVariant = 'hull' | 'dark' | 'deck';

export const WOOD_PALETTES: Record<WoodVariant, { bases: string[]; separator: string; grain: string; knot: string }> = {
  // Hull: rich dark planking. Deck: sun-bleached lighter boards. Dark: trim/beams.
  // Brightened after patrol-1: the old values read as featureless black at
  // noon under ACES (deck planks were fine; every vertical surface vanished).
  hull: { bases: ['#7B4A22', '#6E401C', '#8A5527', '#75441F'], separator: '#3A2210', grain: '#96602E', knot: '#54301A' },
  dark: { bases: ['#4A2C12', '#422810', '#523314'], separator: '#241204', grain: '#5E3A1E', knot: '#38200E' },
  deck: { bases: ['#93714A', '#8A6942', '#9C7A50', '#856340'], separator: '#57391D', grain: '#A8865C', knot: '#5E3F20' },
};

export function woodCanvas(w: number, h: number, variant: WoodVariant = 'hull'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const palette = WOOD_PALETTES[variant];
  ctx.fillStyle = palette.bases[0];
  ctx.fillRect(0, 0, w, h);

  const plankH = Math.floor(h / 7);
  for (let row = 0; row < 7; row++) {
    // Per-plank hue variation so large surfaces don't read as a flat wash
    ctx.fillStyle = palette.bases[(row * 3 + 1) % palette.bases.length];
    ctx.fillRect(0, row * plankH + 2, w, plankH - 2);
    // Plank separator
    ctx.fillStyle = palette.separator;
    ctx.fillRect(0, row * plankH, w, 2);
    // Grain lines within plank
    ctx.strokeStyle = palette.grain;
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const x = Math.random() * w;
      ctx.globalAlpha = 0.35 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.moveTo(x, row * plankH + 3);
      ctx.lineTo(x + (Math.random() - 0.5) * 30, (row + 1) * plankH - 1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Butt joints between plank sections
    ctx.fillStyle = palette.separator;
    for (let seam = 0; seam < 2; seam++) {
      const sx = Math.random() * w;
      ctx.fillRect(sx, row * plankH + 2, 1.5, plankH - 2);
    }
    // Knots
    if (Math.random() < 0.3) {
      const kx = Math.random() * w, ky = row * plankH + plankH * 0.5;
      ctx.fillStyle = palette.knot;
      ctx.beginPath();
      ctx.ellipse(kx, ky, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}

export function woodTexture(w: number, h: number, variant: WoodVariant = 'hull'): THREE.CanvasTexture {
  return finishCanvasTexture(woodCanvas(w, h, variant));
}

export function sailTexture(teamColor?: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#EEE0B8';
  ctx.fillRect(0, 0, 256, 256);
  // Worn patches
  ctx.fillStyle = '#D8C890';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, 15 + Math.random() * 28, 0, Math.PI * 2);
    ctx.fill();
  }
  // Horizontal stitch lines
  ctx.strokeStyle = '#B8A050';
  ctx.lineWidth = 1.5;
  for (let y = 28; y < 256; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y + (Math.random() - 0.5) * 4);
    ctx.lineTo(256, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  // Team emblem: painted band across the lower third — team readability without
  // tinting the whole canvas.
  if (teamColor !== undefined) {
    const hex = `#${teamColor.toString(16).padStart(6, '0')}`;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = hex;
    ctx.fillRect(0, 168, 256, 36);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 210, 256, 7);
    ctx.globalAlpha = 1;
  }
  return finishCanvasTexture(canvas);
}

export type SupplyKind = 'food' | 'plank' | 'shot';

export const SUPPLY_LID_TEX_CACHE = new Map<SupplyKind, THREE.CanvasTexture>();

/** Painted barrel-lid label for the three FUNCTIONAL supply barrels. The glyph
 *  sits centered so the cylinder cap's radial UVs show it upright from above
 *  regardless of the barrel's deck rotation. */
export function supplyLidTexture(kind: SupplyKind): THREE.CanvasTexture {
  let tex = SUPPLY_LID_TEX_CACHE.get(kind);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const base = kind === 'food' ? '#C8A030' : kind === 'plank' ? '#C9AE7E' : '#17171A';
  const rim = kind === 'shot' ? '#3A3A40' : '#5A3D1C';
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  if (kind === 'food') {
    // Banana: yellow crescent (disc minus offset disc) + brown tips
    ctx.fillStyle = '#F2D53C';
    ctx.beginPath();
    ctx.arc(64, 58, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(64, 34, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // destination-out also cut the base/ring under the crescent — repaint base there
    ctx.fillStyle = base;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillRect(0, 0, 128, 128);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#5E4014';
    ctx.fillRect(30, 62, 8, 9);
    ctx.fillRect(90, 62, 8, 9);
  } else if (kind === 'plank') {
    // Single repair plank, tilted, with grain + nail heads
    ctx.save();
    ctx.translate(64, 64);
    ctx.rotate(-0.5);
    ctx.fillStyle = '#8A5A2E';
    ctx.fillRect(-42, -13, 84, 26);
    ctx.strokeStyle = '#6B4220';
    ctx.lineWidth = 2;
    for (const gy of [-5, 3]) {
      ctx.beginPath();
      ctx.moveTo(-38, gy);
      ctx.lineTo(38, gy + 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#2E2E32';
    for (const nx of [-32, 32]) {
      ctx.beginPath();
      ctx.arc(nx, 0, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else {
    // Cannonball: iron sphere with a specular bite
    ctx.fillStyle = '#3A3A42';
    ctx.beginPath();
    ctx.arc(64, 64, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(230, 230, 240, 0.55)';
    ctx.beginPath();
    ctx.arc(55, 55, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  // Rim ring last — the banana's destination-out cut must not bite it
  ctx.strokeStyle = rim;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.stroke();
  tex = finishCanvasTexture(canvas);
  SUPPLY_LID_TEX_CACHE.set(kind, tex);
  return tex;
}

/** Streaky foam for the wake ribbon — additive, so black regions vanish. */
export function foamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 128;
    const y = Math.random() * 128;
    const r = 2 + Math.random() * 9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.25 + Math.random() * 0.55;
    g.addColorStop(0, `rgba(235, 248, 255, ${a})`);
    g.addColorStop(1, 'rgba(235, 248, 255, 0)');
    ctx.fillStyle = g;
    // Stretch blobs along V (wake travel direction) for streaky foam
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(0.6, 1.6);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const tex = finishCanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Soft radial puff used by bow-spray sprites. */
export function sprayTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(240, 250, 255, 0.9)');
  g.addColorStop(0.4, 'rgba(220, 240, 252, 0.4)');
  g.addColorStop(1, 'rgba(210, 235, 250, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finishCanvasTexture(canvas);
}

