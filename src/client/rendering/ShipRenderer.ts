import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Player, Ship, ShipType, ShipUpgradeType, Vec2 } from '../../shared/types/index.js';
import { FLOODING, SHIP, SHIP_STATS } from '../../shared/constants/index.js';
import { sampleWind, angleWrap, getSailRopeStationLocals, getShipBoardingLadderLocals, getMainMastLocalZ, getCrowNestStandingY, getShipCompanionwayConfig, gerstnerHeight, getStormWaveIntensity, WAVE_PARAMS } from '../../shared/utils/index.js';
import type { RenderQuality } from './Renderer.js';

/** Storm sea-state source accepted by update(): either a precomputed 0..1
 *  intensity, or the replicated storm ring so the renderer can evaluate the
 *  shared getStormWaveIntensity() per ship position. */
export type ShipStormSource = number | { center: Vec2; safeRadius: number; phase: number } | null | undefined;

const UPGRADE_PENNANT_COLORS: Record<ShipUpgradeType, number> = {
  hull_reinforcement: 0x67b9ff,
  charged_cannons: 0xff8459,
  swift_sails: 0xf6d360,
};

const CYLINDER_UP = new THREE.Vector3(0, 1, 0);

/** Marks canvas art as sRGB (authored colors, not linear data) and enables
 *  anisotropic filtering so deck planks stay crisp at grazing angles. */
function finishCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

type WoodVariant = 'hull' | 'dark' | 'deck';

const WOOD_PALETTES: Record<WoodVariant, { bases: string[]; separator: string; grain: string; knot: string }> = {
  // Hull: rich dark planking. Deck: sun-bleached lighter boards. Dark: trim/beams.
  // Brightened after patrol-1: the old values read as featureless black at
  // noon under ACES (deck planks were fine; every vertical surface vanished).
  hull: { bases: ['#7B4A22', '#6E401C', '#8A5527', '#75441F'], separator: '#3A2210', grain: '#96602E', knot: '#54301A' },
  dark: { bases: ['#4A2C12', '#422810', '#523314'], separator: '#241204', grain: '#5E3A1E', knot: '#38200E' },
  deck: { bases: ['#93714A', '#8A6942', '#9C7A50', '#856340'], separator: '#57391D', grain: '#A8865C', knot: '#5E3F20' },
};

function woodCanvas(w: number, h: number, variant: WoodVariant = 'hull'): HTMLCanvasElement {
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

function woodTexture(w: number, h: number, variant: WoodVariant = 'hull'): THREE.CanvasTexture {
  return finishCanvasTexture(woodCanvas(w, h, variant));
}

function sailTexture(teamColor?: number): THREE.CanvasTexture {
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

/** Streaky foam for the wake ribbon — additive, so black regions vanish. */
function foamTexture(): THREE.CanvasTexture {
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
function sprayTexture(): THREE.CanvasTexture {
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

// ─────────────────────────────────────────────────────────────────────────────
// Lofted hull construction
//
// The hull is lofted from 9 cross-section stations, each with 7 vertical slots
// per side: sheer (deck edge) → tumblehome → wale (max beam) → topside →
// waterline → rounded bilge → keel. The SHEER half-widths are numerically
// identical to the walkable-deck station table in PhysicsSystem.getDeckHalfWidth
// (that is the gameplay contract: the visible deck edge IS the walkable edge).
// Everything below the sheer is free visual shape: gentle tumblehome above the
// wale, a flared V bow with a forward-raked stem, a mildly raked underwater
// stern, and real DRAFT — the keel sits ~0.8-1.2m below the waterline so hulls
// ride IN the water instead of on top of it.
// ─────────────────────────────────────────────────────────────────────────────

interface HullProfileStation {
  baseZ: number;
  sheerY: number;
  keelY: number;
  /** Starboard half-section, sheer(0) → keel(last). x >= 0. */
  slots: Array<{ x: number; y: number; z: number }>;
}

interface HullProfile {
  W: number;
  H: number;
  L: number;
  draft: number;
  stations: HullProfileStation[];
}

/** Per-class hull character: tumblehome bulge at the wale and draft fraction. */
const HULL_SHAPES: Record<ShipType, { bulge: number; draftF: number }> = {
  sloop: { bulge: 1.045, draftF: 0.365 },      // draft ≈ 0.80m
  brigantine: { bulge: 1.07, draftF: 0.36 },   // draft ≈ 1.01m
  galleon: { bulge: 1.10, draftF: 0.35 },      // draft ≈ 1.23m
};

/** Loft stations. `dh` (sheer half-width fraction of W) at the six knot rows
 *  MUST stay identical to PhysicsSystem.getDeckHalfWidth's table — intermediate
 *  rows are exact linear interpolations of that table, so the walkable footprint
 *  is preserved everywhere. ztF/zbF give the stem/stern rake (z at sheer vs keel). */
const LOFT_STATIONS = [
  { zf: -0.50, dh: 0.300, sheer: 0.95,  keel01: 0.32, wlF: 0.62, bilgeF: 0.34, mid: 0.15, ztF: -0.505, zbF: -0.415 },
  { zf: -0.36, dh: 0.500, sheer: 0.98,  keel01: 0.74, wlF: 0.76, bilgeF: 0.48, mid: 0.75, ztF: -0.360, zbF: -0.350 },
  { zf: -0.22, dh: 0.530, sheer: 0.99,  keel01: 0.90, wlF: 0.80, bilgeF: 0.52, mid: 0.95, ztF: -0.220, zbF: -0.220 },
  { zf: -0.08, dh: 0.560, sheer: 1.00,  keel01: 1.00, wlF: 0.82, bilgeF: 0.54, mid: 1.00, ztF: -0.080, zbF: -0.080 },
  { zf:  0.07, dh: 0.520, sheer: 0.995, keel01: 1.00, wlF: 0.80, bilgeF: 0.52, mid: 1.00, ztF:  0.070, zbF:  0.070 },
  { zf:  0.22, dh: 0.480, sheer: 0.99,  keel01: 0.92, wlF: 0.74, bilgeF: 0.46, mid: 0.90, ztF:  0.220, zbF:  0.220 },
  { zf:  0.32, dh: 0.370, sheer: 1.015, keel01: 0.78, wlF: 0.62, bilgeF: 0.36, mid: 0.60, ztF:  0.325, zbF:  0.310 },
  { zf:  0.42, dh: 0.260, sheer: 1.04,  keel01: 0.55, wlF: 0.46, bilgeF: 0.24, mid: 0.30, ztF:  0.445, zbF:  0.405 },
  { zf:  0.50, dh: 0.055, sheer: 1.08,  keel01: 0.18, wlF: 0.30, bilgeF: 0.14, mid: 0.00, ztF:  0.530, zbF:  0.415 },
];

const HULL_PROFILE_CACHE = new Map<ShipType, HullProfile>();

function getHullProfile(type: ShipType): HullProfile {
  let profile = HULL_PROFILE_CACHE.get(type);
  if (profile) return profile;
  const stats = SHIP_STATS[type];
  const { bulge, draftF } = HULL_SHAPES[type];
  const W = stats.width, H = stats.height, L = stats.length;
  const draft = H * draftF;
  const stations: HullProfileStation[] = LOFT_STATIONS.map((def) => {
    const sheerY = def.sheer * H;
    const keelY = -draft * def.keel01;
    const dh = def.dh * W;
    const wale = dh * (1 + (bulge - 1) * def.mid);
    const wl = dh * def.wlF;
    const bilge = dh * def.bilgeF;
    const waleY = sheerY * 0.60;
    const zt = def.ztF * L;
    const zb = def.zbF * L;
    const span = Math.max(0.001, sheerY - keelY);
    const zAt = (y: number) => {
      const vf = THREE.MathUtils.clamp((sheerY - y) / span, 0, 1);
      return zt + (zb - zt) * Math.pow(vf, 1.35); // stem/stern curve, not a straight rake
    };
    const slot = (x: number, y: number) => ({ x, y, z: zAt(y) });
    return {
      baseZ: def.zf * L,
      sheerY,
      keelY,
      slots: [
        slot(dh, sheerY),
        slot(dh + (wale - dh) * 0.72, sheerY - (sheerY - waleY) * 0.45),
        slot(wale, waleY),
        slot(wl + (wale - wl) * 0.62, waleY * 0.5),
        slot(wl, 0),
        slot(bilge, keelY * 0.52),
        slot(W * 0.015, keelY),
      ],
    };
  });
  profile = { W, H, L, draft, stations };
  HULL_PROFILE_CACHE.set(type, profile);
  return profile;
}

/** Hull texture V for a local height — the whole shell (keel → highest sheer)
 *  maps 0..1 so the painted waterline/wale bands land on the right planks. */
function hullUvV(profile: HullProfile, y: number): number {
  return THREE.MathUtils.clamp((y + profile.draft) / (profile.H * 1.08 + profile.draft), 0, 1);
}

/** Interpolates one station's side polyline at height y. Returns surface x, the
 *  outward 2D section normal (starboard sense) and the raked z at that height. */
function stationSurfaceAt(st: HullProfileStation, y: number): { x: number; z: number; nx: number; ny: number } {
  const slots = st.slots;
  let j = 0;
  const yc = THREE.MathUtils.clamp(y, slots[slots.length - 1].y, slots[0].y);
  while (j < slots.length - 2 && yc < slots[j + 1].y) j++;
  const a = slots[j], b = slots[j + 1];
  const t = THREE.MathUtils.clamp((a.y - yc) / Math.max(0.0001, a.y - b.y), 0, 1);
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  // Outward normal of segment a→b (downward), rotated +90°: (Δy, Δx_down)
  let nx = a.y - b.y;
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  return { x, z, nx, ny };
}

/** Surface point + outward section normal anywhere on the loft (starboard side;
 *  mirror x/nx for port). Used to anchor gunports, rivets and hole decals. */
function hullSurfacePointAt(profile: HullProfile, z: number, y: number): { x: number; nx: number; ny: number } {
  const sts = profile.stations;
  const zc = THREE.MathUtils.clamp(z, sts[0].baseZ, sts[sts.length - 1].baseZ);
  let i = 0;
  while (i < sts.length - 2 && zc > sts[i + 1].baseZ) i++;
  const a = sts[i], b = sts[i + 1];
  const t = THREE.MathUtils.clamp((zc - a.baseZ) / Math.max(0.0001, b.baseZ - a.baseZ), 0, 1);
  const sa = stationSurfaceAt(a, y);
  const sb = stationSurfaceAt(b, y);
  let nx = sa.nx + (sb.nx - sa.nx) * t;
  let ny = sa.ny + (sb.ny - sa.ny) * t;
  const len = Math.hypot(nx, ny) || 1;
  return { x: sa.x + (sb.x - sa.x) * t, nx: nx / len, ny: ny / len };
}

/** The lofted hull shell. Open at the top (deck slabs are separate so the
 *  companionway stays a real hole); capped at the transom and stem. */
function makeLoftedHullGeometry(profile: HullProfile, lowDetail = false): THREE.BufferGeometry {
  const stationIdx = lowDetail ? [0, 1, 3, 5, 7, 8] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const slotIdx = lowDetail ? [0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6];
  const S = stationIdx.length;
  const J = slotIdx.length;
  const L = profile.L;

  const verts: number[] = [];
  const uvs: number[] = [];
  for (const si of stationIdx) {
    const st = profile.stations[si];
    for (const side of [1, -1] as const) { // starboard block, then port block
      for (const ji of slotIdx) {
        const s = st.slots[ji];
        verts.push(side * s.x, s.y, s.z);
        uvs.push((s.z / L) + 0.5, hullUvV(profile, s.y));
      }
    }
  }

  const faces: number[] = [];
  const vi = (s: number, side: 0 | 1, j: number) => s * (2 * J) + side * J + j;
  for (let s = 0; s < S - 1; s++) {
    for (let j = 0; j < J - 1; j++) {
      // starboard (+x): outward winding
      let a = vi(s, 0, j), b = vi(s + 1, 0, j), c = vi(s, 0, j + 1), d = vi(s + 1, 0, j + 1);
      faces.push(a, b, c, b, d, c);
      // port (−x): mirrored → reversed winding
      a = vi(s, 1, j); b = vi(s + 1, 1, j); c = vi(s, 1, j + 1); d = vi(s + 1, 1, j + 1);
      faces.push(a, c, b, b, c, d);
    }
  }
  // Transom cap (−Z) and stem cap (+Z)
  for (let j = 0; j < J - 1; j++) {
    faces.push(vi(0, 0, j), vi(0, 0, j + 1), vi(0, 1, j));
    faces.push(vi(0, 0, j + 1), vi(0, 1, j + 1), vi(0, 1, j));
    const e = S - 1;
    faces.push(vi(e, 0, j), vi(e, 1, j), vi(e, 0, j + 1));
    faces.push(vi(e, 0, j + 1), vi(e, 1, j), vi(e, 1, j + 1));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo;
}

/** A strake (wale / rub rail / armor belt) that HUGS the loft: a thin proud
 *  ridge following the hull surface at a per-station height. Replaces the old
 *  straight BoxGeometry rails that floated off the tapered bow/stern. */
function makeHullStrakeGeometry(
  profile: HullProfile,
  side: 1 | -1,
  yAt: (st: HullProfileStation) => number,
  proud: number,
  th: number,
  i0 = 0,
  i1 = profile.stations.length - 1,
): THREE.BufferGeometry {
  const pts: Array<{ x: number; y: number; z: number; nx: number; ny: number }> = [];
  for (let i = i0; i <= i1; i++) {
    const st = profile.stations[i];
    const y = yAt(st);
    const s = stationSurfaceAt(st, y);
    pts.push({ x: s.x, y, z: s.z, nx: s.nx, ny: s.ny });
  }
  const S = pts.length;
  const verts: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < S; i++) {
    const p = pts[i];
    // Section-plane "up" (normal rotated +90°)
    const bx = -p.ny, by = p.nx;
    const rails = [
      { x: p.x + bx * th * 0.5, y: p.y + by * th * 0.5 },                                  // top edge on hull
      { x: p.x + p.nx * proud + bx * th * 0.32, y: p.y + p.ny * proud + by * th * 0.32 },  // top outer
      { x: p.x + p.nx * proud - bx * th * 0.32, y: p.y + p.ny * proud - by * th * 0.32 },  // bottom outer
      { x: p.x - bx * th * 0.5, y: p.y - by * th * 0.5 },                                  // bottom edge on hull
    ];
    for (let r = 0; r < 4; r++) {
      verts.push(side * rails[r].x, rails[r].y, p.z);
      uvs.push(i / Math.max(1, S - 1), r / 3);
    }
  }
  const faces: number[] = [];
  const vi = (s: number, r: number) => s * 4 + r;
  for (let s = 0; s < S - 1; s++) {
    for (let r = 0; r < 3; r++) {
      const a = vi(s, r), b = vi(s + 1, r), c = vi(s, r + 1), d = vi(s + 1, r + 1);
      if (side === 1) faces.push(a, b, c, b, d, c);
      else faces.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo;
}

function makeStairRampGeometry(
  width: number,
  topY: number,
  bottomY: number,
  frontZ: number,
  backZ: number,
  thickness: number,
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const verts = [
    -hw, topY, frontZ,
     hw, topY, frontZ,
    -hw, bottomY, backZ,
     hw, bottomY, backZ,
    -hw, topY - thickness, frontZ,
     hw, topY - thickness, frontZ,
    -hw, Math.max(0.12, bottomY - thickness), backZ,
     hw, Math.max(0.12, bottomY - thickness), backZ,
  ];
  const faces = [
    0, 1, 2, 1, 3, 2,
    4, 6, 5, 5, 6, 7,
    0, 4, 1, 1, 4, 5,
    2, 3, 6, 3, 7, 6,
    0, 2, 4, 2, 6, 4,
    1, 5, 3, 3, 5, 7,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo;
}

function makeBillowedSailGeometry(
  width: number,
  height: number,
  segmentsX = 8,
  segmentsY = 6,
  billowDepth = Math.min(width, height) * 0.14,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const halfW = width * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const nx = Math.abs(x) / Math.max(halfW, 0.001);
    const ny = THREE.MathUtils.clamp((y + height * 0.5) / Math.max(height, 0.001), 0, 1);
    const centerFill = Math.max(0, 1 - nx * nx);
    const verticalFill = Math.sin(ny * Math.PI);
    pos.setZ(i, centerFill * verticalFill * billowDepth);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function makeWindowFrame(
  width: number,
  height: number,
  depth: number,
  bar: number,
  material: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const addBar = (x: number, y: number, w: number, h: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), material);
    mesh.position.set(x, y, 0);
    mesh.castShadow = true;
    g.add(mesh);
  };
  addBar(0, height * 0.5, width + bar * 2, bar);
  addBar(0, -height * 0.5, width + bar * 2, bar);
  addBar(-width * 0.5, 0, bar, height + bar * 2);
  addBar(width * 0.5, 0, bar, height + bar * 2);
  addBar(0, 0, bar * 0.62, height * 0.82);
  addBar(0, 0, width * 0.82, bar * 0.58);
  return g;
}

function makeCylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.001), segments), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) {
    mesh.quaternion.setFromUnitVectors(CYLINDER_UP, dir.normalize());
  }
  mesh.castShadow = true;
  return mesh;
}

function makeBarrel(
  woodMat: THREE.Material,
  hoopMat: THREE.Material,
  lidMat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();

  // Barrel body — rounded cylinder approximated with tapered ends
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.72, 10),
    woodMat,
  );
  body.castShadow = true;
  g.add(body);

  // Bulge rings (hoops)
  for (const hy of [-0.22, 0, 0.22]) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.4, 0.045, 6, 14),
      hoopMat,
    );
    hoop.rotation.x = Math.PI * 0.5;
    hoop.position.y = hy;
    hoop.castShadow = true;
    g.add(hoop);
  }

  // Top lid with colour indicating contents
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 10),
    lidMat,
  );
  lid.position.y = 0.39;
  lid.castShadow = true;
  g.add(lid);

  // Bottom cap
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 10),
    woodMat,
  );
  cap.position.y = -0.39;
  g.add(cap);

  return g;
}

/** Per-type carved figurehead at the stem (bow = +Z). Body is gilded carved wood
 *  (goldMat), with the team accent on fins / tail / eyes so the ship reads at a
 *  glance. Deliberately low-poly — it merges into two static meshes per ship. */
function makeFigurehead(
  type: ShipType,
  goldMat: THREE.Material,
  accentMat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
    sx = 1, sy = 1, sz = 1,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  if (type === 'sloop') {
    // Leaping fish arcing up and forward off the stem.
    add(new THREE.SphereGeometry(0.16, 10, 8), goldMat, 0, 0.02, 0.12, -0.55, 0, 0, 0.72, 0.95, 1.9);
    // Tail fluke (accent), swept down-aft
    add(new THREE.ConeGeometry(0.19, 0.36, 4), accentMat, 0, -0.16, -0.16, 2.5, Math.PI * 0.25, 0, 1, 1, 0.22);
    // Dorsal fin (accent)
    add(new THREE.ConeGeometry(0.1, 0.22, 3), accentMat, 0, 0.2, 0.02, -0.3, 0, 0, 1, 1, 0.2);
    // Eye
    add(new THREE.SphereGeometry(0.035, 6, 5), accentMat, 0.09, 0.11, 0.28);
    add(new THREE.SphereGeometry(0.035, 6, 5), accentMat, -0.09, 0.11, 0.28);
  } else if (type === 'brigantine') {
    // Mermaid silhouette: torso rising, head, and a curled tail below.
    add(new THREE.ConeGeometry(0.12, 0.42, 8), goldMat, 0, 0.2, 0.08, -0.2, 0, 0, 1, 1, 0.7);
    add(new THREE.SphereGeometry(0.1, 10, 8), goldMat, 0, 0.44, 0.12);
    // Hair (accent)
    add(new THREE.SphereGeometry(0.11, 8, 6), accentMat, 0, 0.5, 0.06, 0, 0, 0, 1, 0.7, 0.9);
    // Curled fish tail (accent)
    add(new THREE.ConeGeometry(0.14, 0.5, 6), accentMat, 0, -0.14, -0.02, 0.5, 0, 0, 0.5, 1, 1);
    add(new THREE.ConeGeometry(0.2, 0.24, 4), accentMat, 0, -0.36, -0.16, 1.9, Math.PI * 0.25, 0, 1, 1, 0.22);
  } else {
    // Galleon: fierce sea-dragon head thrusting forward off the beakhead.
    add(new THREE.CylinderGeometry(0.11, 0.15, 0.44, 8), goldMat, 0, 0.05, -0.04, Math.PI * 0.5 - 0.5, 0, 0); // neck
    add(new THREE.BoxGeometry(0.2, 0.2, 0.42), goldMat, 0, 0.22, 0.2, -0.35, 0, 0); // skull
    add(new THREE.ConeGeometry(0.11, 0.34, 5), goldMat, 0, 0.16, 0.42, Math.PI * 0.5 - 0.2, 0, 0); // snout
    add(new THREE.BoxGeometry(0.18, 0.06, 0.24), accentMat, 0, 0.09, 0.42, -0.2, 0, 0); // lower jaw (accent)
    // Horns (accent)
    for (const s of [-1, 1]) add(new THREE.ConeGeometry(0.04, 0.24, 4), accentMat, s * 0.08, 0.36, 0.06, -0.9, 0, s * 0.3);
    // Mane frills along the neck (accent)
    for (let i = 0; i < 3; i++) add(new THREE.ConeGeometry(0.06, 0.18, 3), accentMat, 0, 0.02 - i * 0.06, -0.14 - i * 0.06, -0.3, 0, 0, 1, 1, 0.3);
    // Eyes (accent)
    for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.035, 6, 5), accentMat, s * 0.09, 0.26, 0.34);
  }
  return g;
}

/** Cargo-hatch grating: a framed grid of slats. Cheap deck furniture; light shows
 *  through the gaps so the hold (and rising water) reads from above. */
function makeHatchGrating(
  w: number,
  l: number,
  frameMat: THREE.Material,
  slatMat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const fh = 0.12;
  const hw = w * 0.5, hl = l * 0.5;
  for (const [x, z, bw, bl] of [
    [0, hl, w + 0.08, 0.08],
    [0, -hl, w + 0.08, 0.08],
    [hw, 0, 0.08, l],
    [-hw, 0, 0.08, l],
  ] as const) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(bw, fh, bl), frameMat);
    frame.position.set(x, 0, z);
    frame.castShadow = true;
    g.add(frame);
  }
  const barsX = Math.max(3, Math.round(w / 0.28));
  const barsZ = Math.max(3, Math.round(l / 0.28));
  for (let i = 1; i < barsX; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, fh * 0.7, l), slatMat);
    bar.position.set(-hw + (i / barsX) * w, -0.01, 0);
    g.add(bar);
  }
  for (let i = 1; i < barsZ; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, fh * 0.55, 0.04), slatMat);
    bar.position.set(0, -0.02, -hl + (i / barsZ) * l);
    g.add(bar);
  }
  return g;
}

/** Warm ship lantern fixture: an emissive amber glass core in a dark metal cage
 *  with a hanging hook. The glass uses the SHARED glassMat so it merges into one
 *  controllable mesh whose emissive ramps with night. */
function makeLanternFixture(glassMat: THREE.Material, metalMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.2), glassMat);
  glass.position.y = 0;
  g.add(glass);
  // Cage: top + bottom caps and four corner posts
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 0.1, 6), metalMat);
  cap.position.y = 0.2;
  cap.castShadow = true;
  g.add(cap);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.08, 6), metalMat);
  base.position.y = -0.18;
  g.add(base);
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.02), metalMat);
      post.position.set(sx * 0.1, 0, sz * 0.1);
      g.add(post);
    }
  }
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 5, 8), metalMat);
  hook.position.y = 0.3;
  hook.rotation.x = Math.PI * 0.5;
  g.add(hook);
  return g;
}

const NO_MERGE_EXCLUDE: ReadonlySet<THREE.Object3D> = new Set();

/** Rebuilds a geometry so it can be merged with siblings: non-indexed, only
 *  position/normal/uv attributes, with zero-filled uv when the source has none. */
function normalizeForMerge(geo: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  g.morphAttributes = {};
  return g;
}

/** Bakes every static leaf mesh under `root` into one mesh per material,
 *  skipping excluded subtrees (anything animated, tinted, or toggled at
 *  runtime). This is the main per-ship draw-call reduction. */
function mergeStaticMeshes(root: THREE.Object3D, excluded: ReadonlySet<THREE.Object3D>) {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const buckets = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; castShadow: boolean; receiveShadow: boolean }>();

  const visit = (obj: THREE.Object3D) => {
    if (excluded.has(obj)) return;
    for (const child of obj.children) visit(child);
    if (obj === root || !(obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) return;
    const mesh = obj as THREE.Mesh;
    if (mesh.children.length > 0 || Array.isArray(mesh.material)) return;
    if (!mesh.geometry.attributes.position) return;
    let bucket = buckets.get(mesh.material);
    if (!bucket) {
      bucket = { geos: [], meshes: [], castShadow: false, receiveShadow: false };
      buckets.set(mesh.material, bucket);
    }
    relative.multiplyMatrices(rootInverse, mesh.matrixWorld);
    bucket.geos.push(normalizeForMerge(mesh.geometry, relative));
    bucket.meshes.push(mesh);
    bucket.castShadow ||= mesh.castShadow;
    bucket.receiveShadow ||= mesh.receiveShadow;
  };
  visit(root);

  for (const [material, bucket] of buckets) {
    if (bucket.meshes.length < 2) {
      for (const geo of bucket.geos) geo.dispose();
      continue;
    }
    const merged = mergeGeometries(bucket.geos, false);
    for (const geo of bucket.geos) geo.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    root.add(mesh);
    for (const original of bucket.meshes) {
      original.parent?.remove(original);
      original.geometry.dispose();
    }
  }
}

interface StairwellHole {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

function makeShipInterior(
  stats: { width: number; length: number; height: number },
  woodMat: THREE.Material,
  darkMat: THREE.Material,
  hole: StairwellHole,
): THREE.Group {
  const g = new THREE.Group();
  const W = stats.width, L = stats.length, H = stats.height;

  // Hold floor — warmer brown with a touch of wood grain so it reads as an actual
  // floor (not a flat dark tarp) when the player peers down through the stairwell.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a2e15, roughness: 0.85 });
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.88, 0.12, L * 0.88),
    floorMat,
  );
  floor.position.y = 0.35;
  floor.receiveShadow = true;
  g.add(floor);

  // Inner walls (port/starboard)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 1 });
  const wallH = H * 0.75;
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, wallH, L * 0.82),
      wallMat,
    );
    wall.position.set(sx * W * 0.42, wallH * 0.5 + 0.35, 0);
    g.add(wall);
  }

  // Bow/stern bulkheads so the hold reads as an enclosed room instead of an open box.
  const bulkheadW = W * 0.84;
  const bulkheadD = 0.14;
  const bowBulkhead = new THREE.Mesh(
    new THREE.BoxGeometry(bulkheadW, wallH, bulkheadD),
    wallMat,
  );
  bowBulkhead.position.set(0, wallH * 0.5 + 0.35, L * 0.39);
  g.add(bowBulkhead);

  const sternBulkhead = new THREE.Mesh(
    new THREE.BoxGeometry(bulkheadW, wallH, bulkheadD),
    wallMat,
  );
  sternBulkhead.position.set(0, wallH * 0.5 + 0.35, -L * 0.39);
  g.add(sternBulkhead);

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cornerPost = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, wallH, 0.16),
        darkMat,
      );
      cornerPost.position.set(sx * W * 0.38, wallH * 0.5 + 0.35, sz * L * 0.39);
      cornerPost.castShadow = true;
      g.add(cornerPost);
    }
  }

  // Low angled bilge planks close the bottom corners that were visible from the hold.
  for (const sx of [-1, 1] as const) {
    const bilge = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, H * 0.34, L * 0.72),
      darkMat,
    );
    bilge.position.set(sx * W * 0.34, 0.52, 0);
    bilge.rotation.z = -sx * Math.PI * 0.12;
    g.add(bilge);
  }

  // Deck underside — 4 box slabs surrounding the stairwell so the hole is real
  // geometry (no fragile ShapeGeometry hole-punching). Looking up from the hold
  // through the stairwell now reveals the open sky / weather deck above.
  const ceilingY = H - 0.12;
  const cw = W * 0.44;
  const cln = L * 0.46;
  const cThickness = 0.08;
  const addCeilingSlab = (cx: number, cz: number, bw: number, bd: number) => {
    if (bw <= 0.05 || bd <= 0.05) return;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(bw, cThickness, bd),
      darkMat,
    );
    slab.position.set(cx, ceilingY, cz);
    slab.receiveShadow = true;
    g.add(slab);
  };
  const cHoleZMin = hole.cz - hole.halfZ;
  const cHoleZMax = hole.cz + hole.halfZ;
  const cHoleXMin = hole.cx - hole.halfX;
  const cHoleXMax = hole.cx + hole.halfX;
  // Stern slab (south of hole, full width)
  const cSternDepth = Math.max(0, cHoleZMin - (-cln));
  if (cSternDepth > 0) addCeilingSlab(0, -cln + cSternDepth * 0.5, cw * 2, cSternDepth);
  // Bow slab (north of hole, full width)
  const cBowDepth = Math.max(0, cln - cHoleZMax);
  if (cBowDepth > 0) addCeilingSlab(0, cHoleZMax + cBowDepth * 0.5, cw * 2, cBowDepth);
  // Port mid slab (west of hole, between hole's z bounds)
  const cMidDepth = Math.max(0, cHoleZMax - cHoleZMin);
  const cPortWidth = Math.max(0, cHoleXMin - (-cw));
  if (cPortWidth > 0 && cMidDepth > 0) addCeilingSlab(-cw + cPortWidth * 0.5, hole.cz, cPortWidth, cMidDepth);
  const cStarWidth = Math.max(0, cw - cHoleXMax);
  if (cStarWidth > 0 && cMidDepth > 0) addCeilingSlab(cHoleXMax + cStarWidth * 0.5, hole.cz, cStarWidth, cMidDepth);

  // Ribs break up the box silhouette and make the hull interior feel more ship-shaped.
  const ribCount = Math.max(4, Math.round(L / 5));
  for (let r = 0; r < ribCount; r++) {
    const rz = -L * 0.26 + r * (L * 0.52 / Math.max(ribCount - 1, 1));
    for (const sx of [-1, 1]) {
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, wallH * 0.92, 0.12),
        darkMat,
      );
      rib.position.set(sx * W * 0.31, wallH * 0.5 + 0.38, rz);
      rib.rotation.z = sx * Math.PI * 0.1;
      g.add(rib);
    }
  }

  // Deck beams (visible from below) — skip the stairwell band so the companionway stays open above.
  const beamMat = darkMat;
  const beamCount = Math.max(2, Math.round(L * 0.1));
  for (let b = 0; b < beamCount; b++) {
    const bz = -L * 0.38 + b * (L * 0.76 / Math.max(beamCount - 1, 1));
    if (bz > hole.cz - hole.halfZ - 0.18 && bz < hole.cz + hole.halfZ + 0.18) continue;
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.86, 0.12, 0.18),
      beamMat,
    );
    beam.position.set(0, H - 0.25, bz);
    g.add(beam);
  }

  // Hammocks
  const hammockMat = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.9, side: THREE.DoubleSide });
  const hammockCount = Math.max(2, Math.round(L / 8));
  for (let h = 0; h < hammockCount; h++) {
    const hz = L * 0.3 - h * (L * 0.6 / Math.max(hammockCount - 1, 1));
    const sx = h % 2 === 0 ? 1 : -1;
    const hammock = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1.4),
      hammockMat,
    );
    hammock.position.set(sx * W * 0.28, H * 0.42, hz);
    hammock.rotation.set(Math.PI * 0.08, 0, Math.PI * 0.5);
    g.add(hammock);
  }

  // Crates along port/starboard bilge — keep the stairwell / centerline clear so nothing blocks the view down.
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3818, roughness: 1, map: woodMat instanceof THREE.MeshStandardMaterial ? woodMat.map : null });
  const crateCount = Math.max(2, Math.round(L / 12));
  for (let c = 0; c < crateCount; c++) {
    const cz = -L * 0.2 - c * (L * 0.1);
    for (const sx of [-1, 1] as const) {
      const cGrp = new THREE.Group();
      cGrp.position.set(sx * W * 0.28, 0.35, cz);

      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.72), crateMat);
      crate.position.y = 0.31;
      crate.castShadow = true;
      cGrp.add(crate);

      const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, roughness: 0.6 });
      for (const sy of [0.12, 0.48]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.045, 0.055), strapMat);
        strap.position.set(0, sy, 0.37);
        cGrp.add(strap);
      }

      g.add(cGrp);
    }
  }

  // Lantern + actual point light so the hold is visibly illuminated when peering
  // through the stairwell. Without a real light, the dark brown floor reads as a
  // featureless "tarp".
  const holdLantern = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.28, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xFFD66A, emissive: 0xFF8800, emissiveIntensity: 2.0 }),
  );
  holdLantern.position.set(0, H * 0.55, 0);
  g.add(holdLantern);

  const holdLight = new THREE.PointLight(0xFFB060, 1.4, Math.max(W, L) * 1.6, 1.4);
  holdLight.position.set(0, H * 0.55, 0);
  holdLight.visible = false;
  g.add(holdLight);

  // Brighten the hold floor so it doesn't look like a flat brown tarp from above.
  // Replace the original drab floorMat by tweaking the existing floor mesh's material.
  // (Done by creating a new lighter material; original mesh kept in scope above.)

  return g;
}

interface CannonMeshGroup {
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
}

interface WakeSpray {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

/** Scene-level animated wake: the ribbon lives in WORLD space (never parented
 *  to the ship) so hull pitch/roll/sinking can't tilt it out of the water. */
interface ShipWake {
  group: THREE.Group;
  ribbon: THREE.Mesh;
  positions: THREE.BufferAttribute;
  material: THREE.MeshBasicMaterial;
  spray: WakeSpray[];
  sprayCursor: number;
  sprayTimer: number;
  scroll: number;
}

const WAKE_ROWS = 9;
const WAKE_COLS = 3;

interface ShipMeshGroup {
  root: THREE.Group;
  detailRoot: THREE.Group;
  proxyRoot: THREE.Group;
  proxySails: THREE.Mesh[];
  sails: THREE.Mesh[];
  furledSails: THREE.Mesh[];
  pennants: THREE.Mesh[];
  upgradePennants: Record<ShipUpgradeType, THREE.Mesh>;
  upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]>;
  fireParticles: THREE.Points | null;
  hullHoles: Record<'bow' | 'stern' | 'port' | 'starboard', THREE.Group>;
  /** Yard+sail+furled-roll pivots, one per square-rigged mast (rotated to trim). */
  trimPivots: THREE.Group[];
  cannonMeshes: CannonMeshGroup[];
  lanterns: THREE.PointLight[];
  wheel: THREE.Object3D;
  compassNeedle: THREE.Object3D;
  anchor: THREE.Group;
  anchorChain: THREE.Mesh;
  anchorCapstan: THREE.Group;
  /** Shared warm-amber glass materials whose emissiveIntensity ramps with night. */
  lanternGlassMats: THREE.MeshStandardMaterial[];
  /** One warm PointLight per ship (budgeted: only the nearest few get lit at night). */
  nightLight: THREE.PointLight | null;
  /** Dark water plane inside the hold, raised by (ship as any).waterLevel. */
  holdWater: THREE.Mesh | null;
  holdWaterBase: Float32Array | null;
  wake: ShipWake;
}

export class ShipRenderer {
  private shipMeshes: Map<string, ShipMeshGroup> = new Map();
  private scene!: THREE.Scene;
  private quality: RenderQuality = 'balanced';
  private darkWoodTex!: THREE.CanvasTexture;
  private deckTex!: THREE.CanvasTexture;
  private sailTex!: THREE.CanvasTexture;
  private foamTex!: THREE.CanvasTexture;
  private sprayTex!: THREE.CanvasTexture;
  private readonly teamSailTex = new Map<number, THREE.CanvasTexture>();
  private readonly teamHullTex = new Map<number, THREE.CanvasTexture>();
  private readonly tempShipPos = new THREE.Vector3();
  private readonly tempCannonPos = new THREE.Vector3();
  private readonly cannonOperators = new Map<string, Player>();
  private windOverride: { direction: number; strength: number } | null = null;
  private readonly waveMotion = { pitch: 0, roll: 0, surfaceY: 0 };
  /** 0 = day, 1 = night. Drives lantern glass emissive + per-ship PointLights. */
  private nightFactor = 0;
  /** Frame counter for throttling per-vertex work (sail-cloth normals). */
  private frameIndex = 0;

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    this.scene = scene;
    this.quality = quality;
    this.darkWoodTex = woodTexture(256, 128, 'dark');
    this.deckTex     = woodTexture(256, 256, 'deck');
    this.sailTex     = sailTexture();
    this.foamTex     = foamTexture();
    this.sprayTex    = sprayTexture();
  }

  /** Optional wind override for sail cloth + pennants. Defaults to sampleWind(t). */
  setWind(dirRad: number, strength: number) {
    this.windOverride = { direction: dirRad, strength: THREE.MathUtils.clamp(strength, 0, 1.5) };
  }

  /** Day↔night lantern control. 0 = day (glass barely emissive, ship lights off),
   *  1 = night (warm glass glow + one warm PointLight on the nearest few ships).
   *  Game.ts should call this every frame with the sky's night factor (0–1). */
  setNightFactor(nf: number) {
    this.nightFactor = THREE.MathUtils.clamp(nf, 0, 1);
  }

  clear() {
    for (const mesh of this.shipMeshes.values()) {
      this.scene.remove(mesh.root);
      this.scene.remove(mesh.wake.group);
    }
    this.shipMeshes.clear();
  }

  private getTeamSailTexture(teamColor: number): THREE.CanvasTexture {
    let tex = this.teamSailTex.get(teamColor);
    if (!tex) {
      tex = sailTexture(teamColor);
      this.teamSailTex.set(teamColor, tex);
    }
    return tex;
  }

  /** Natural wood hull with a MUTED painted wale stripe in the team hue plus a
   *  weathered boot-top and dark antifouling below the waterline. The loft UV
   *  maps the whole shell (keel→sheer) to v 0..1 with the waterline at v≈0.25,
   *  so the painted bands hug the sheer/waterline curves with no extra meshes
   *  and zero emissive — team identity at distance comes from flag + sail band. */
  private getTeamHullTexture(teamColor: number): THREE.CanvasTexture {
    let tex = this.teamHullTex.get(teamColor);
    if (!tex) {
      const canvas = woodCanvas(256, 128, 'hull');
      const ctx = canvas.getContext('2d')!;
      // Desaturate the (often neon) team palette toward painted wood: worn
      // ship paint, not plastic. ~55% team hue, 45% dark oiled timber.
      const tr = (teamColor >> 16) & 0xff, tg = (teamColor >> 8) & 0xff, tb = teamColor & 0xff;
      const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
      const pr = mix(tr, 0x3a, 0.62), pg = mix(tg, 0x2a, 0.62), pb = mix(tb, 0x18, 0.62);
      // CanvasTexture flips Y: high v (sheer) lives near the TOP of the canvas.
      // Painted wale band (v≈0.81-0.89 → canvas y 14-25), matte and worn.
      ctx.globalAlpha = 0.68;
      ctx.fillStyle = `rgb(${pr}, ${pg}, ${pb})`;
      ctx.fillRect(0, 14, 256, 11);
      // Wear: streaks of the wood ghosting through the paint
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#3a2a18';
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * 256;
        ctx.fillRect(x, 14 + Math.random() * 8, 1.5 + Math.random() * 6, 2 + Math.random() * 4);
      }
      // Dark caulked edging above/below the painted band
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#1c1008';
      ctx.fillRect(0, 13, 256, 2);
      ctx.fillRect(0, 25, 256, 2);
      // Below the waterline (v<~0.24 → canvas y>98): dark weathered antifouling pitch
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#221a12';
      ctx.fillRect(0, 98, 256, 30);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#141009';
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * 256;
        ctx.fillRect(x, 98 + Math.random() * 26, 2 + Math.random() * 9, 1.5 + Math.random() * 3);
      }
      // Pale boot-top stripe straddling the waterline (v≈0.235-0.272 → y 93-98)
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = '#b9ab89';
      ctx.fillRect(0, 93, 256, 5);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#6d6350';
      for (let i = 0; i < 18; i++) {
        ctx.fillRect(Math.random() * 256, 93 + Math.random() * 4, 3 + Math.random() * 8, 1.2);
      }
      ctx.globalAlpha = 1;
      tex = finishCanvasTexture(canvas);
      this.teamHullTex.set(teamColor, tex);
    }
    return tex;
  }

  private buildShipProxy(
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    proxySails: THREE.Mesh[],
  ) {
    const W = stats.width;
    const L = stats.length;
    const H = stats.height;
    const group = new THREE.Group();
    group.name = 'ship-proxy';

    // Low-poly LOFT of the exact same silhouette as the detail hull (same
    // profile, fewer stations/slots) with the same painted-wale team texture —
    // crossing the detail distance no longer pops shape, draft or stripe.
    const profile = getHullProfile(ship.type);
    const hullMat = new THREE.MeshStandardMaterial({
      map: this.getTeamHullTexture(ship.teamColor),
      roughness: 0.85,
      metalness: 0.02,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.95 });
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xeadfbf, roughness: 0.8, side: THREE.DoubleSide });

    const hull = new THREE.Mesh(makeLoftedHullGeometry(profile, true), hullMat);
    group.add(hull);

    // Deck slab top face matches the walkable plane (H + 0.1)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.12, L * 0.72), darkMat);
    deck.position.y = H + 0.04;
    group.add(deck);

    // Stern castle + bowsprit so the far silhouette matches the detail model
    const castle = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, H * 0.28, L * 0.22), darkMat);
    castle.position.set(0, H + H * 0.14, -L * 0.37);
    group.add(castle);
    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 5), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    group.add(bowsprit);

    const mastCount = stats.mastCount;
    const mastSpacing = L * 0.55 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.22;
    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      // Same mast height law as the detail model — no rig-height pop at the LOD line
      const mastH = H * (mastCount === 1 ? 3.6 : 3.1);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, mastH, 5), darkMat);
      mast.position.set(0, H + mastH * 0.5, mastZ);
      group.add(mast);

      const proxySailMat = m === 0 ? sailMat.clone() : sailMat;
      if (m === 0) proxySailMat.map = this.getTeamSailTexture(ship.teamColor);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.05, H * 1.02), proxySailMat);
      sail.position.set(0, H + mastH * 0.58, mastZ);
      sail.rotation.order = 'YXZ';
      sail.rotation.x = 0.055; // slight billow tilt so the plane doesn't read flat
      group.add(sail);
      proxySails.push(sail);
    }

    // Flag keeps the saturated team color — it IS the team identity at range
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.62),
      new THREE.MeshStandardMaterial({
        color: ship.teamColor,
        emissive: ship.teamColor,
        emissiveIntensity: 0.25,
        side: THREE.DoubleSide,
        roughness: 0.85,
      }),
    );
    flag.position.set(0.38, H * 3.9, mastStartZ);
    group.add(flag);

    mergeStaticMeshes(group, new Set<THREE.Object3D>([...proxySails, flag]));

    return group;
  }

  buildShip(ship: Ship): THREE.Group {
    const stats = SHIP_STATS[ship.type];
    const group = new THREE.Group();
    group.name = `ship_${ship.id}`;
    const proxySails: THREE.Mesh[] = [];

    // Natural dark wood hull — NO team tint on the whole hull. Team color goes on
    // the painted sheer stripe (in the texture), flag cloth and main-sail band only.
    const hullMat = new THREE.MeshStandardMaterial({
      map: this.getTeamHullTexture(ship.teamColor),
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      map: this.darkWoodTex,
      roughness: 0.92,
      metalness: 0.0,
    });
    const deckMat = new THREE.MeshStandardMaterial({
      map: this.deckTex,
      roughness: 0.78,
      metalness: 0.0,
    });
    const sailMat = new THREE.MeshStandardMaterial({
      map: this.sailTex,
      color: 0xf5edd2,
      roughness: 0.68,
      emissive: 0x221a08,
      emissiveIntensity: 0.04,
      side: THREE.DoubleSide,
    });
    // Muted painted team accent — desaturated toward timber, NO emissive.
    // Saturated team color lives only on flag / pennant / sail band.
    const accent = new THREE.Color(ship.teamColor).lerp(new THREE.Color(0x3a2a18), 0.4);
    const teamAccentMat = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.72,
      metalness: 0.04,
    });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x484848, roughness: 0.4, metalness: 0.88 });
    const brassHardwareMat = new THREE.MeshStandardMaterial({ color: 0x9A6E28, roughness: 0.42, metalness: 0.82 });
    const ropeCoilMat = new THREE.MeshStandardMaterial({ color: 0x9a8050, roughness: 1 });
    const barrelWoodMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.92 });

    const W = stats.width, L = stats.length, H = stats.height;
    const upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]> = {
      hull_reinforcement: [],
      charged_cannons: [],
      swift_sails: [],
    };

    // ── Hull ─────────────────────────────────────────────────
    // Lofted shell: rounded bilge, tumblehome, flared raked bow, real draft.
    // Only the SHELL changed — deck plane, rails, cannon/mast positions and the
    // walkable footprint (sheer half-widths) are identical to the server tables.
    const profile = getHullProfile(ship.type);
    const hullGeo = makeLoftedHullGeometry(profile);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x07080a,
      roughness: 1,
      metalness: 0,
      emissive: 0x06243a,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const holeRimMat = new THREE.MeshStandardMaterial({
      color: 0x20120a,
      roughness: 0.95,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const splinterMat = new THREE.MeshStandardMaterial({ color: 0x140b05, roughness: 1, side: THREE.DoubleSide });
    // One punched-splinter decal facing local +Z (oriented via quaternion below).
    const makeHoleDecal = (radius: number) => {
      const decal = new THREE.Group();
      const opening = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), holeMat);
      decal.add(opening);
      const rim = new THREE.Mesh(new THREE.RingGeometry(radius * 1.05, radius * 1.3, 16), holeRimMat);
      decal.add(rim);
      // Splintered plank shards jutting from the rim — merged into one mesh so a
      // blown-through hole reads as jagged torn timber, not a clean drilled circle.
      const shardGeos: THREE.BufferGeometry[] = [];
      const shardCount = 7;
      for (let k = 0; k < shardCount; k++) {
        const a = (k / shardCount) * Math.PI * 2 + 0.3;
        const len = (0.14 + (k % 3) * 0.06) * (radius / 0.4);
        const cone = new THREE.ConeGeometry(0.05 * (radius / 0.4), len, 4);
        const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a - Math.PI * 0.5));
        const pos = new THREE.Vector3(
          Math.cos(a) * (radius * 1.1 + len * 0.5),
          Math.sin(a) * (radius * 1.1 + len * 0.5),
          (k % 2 ? 0.03 : -0.02),
        );
        cone.applyMatrix4(new THREE.Matrix4().compose(pos, rq, new THREE.Vector3(1, 1, 0.5)));
        shardGeos.push(cone);
      }
      const shardsMerged = mergeGeometries(shardGeos, false);
      for (const sg of shardGeos) sg.dispose();
      if (shardsMerged) decal.add(new THREE.Mesh(shardsMerged, splinterMat));
      return decal;
    };
    const Z_AXIS = new THREE.Vector3(0, 0, 1);
    // Hole group projected onto the REAL loft surface: position + outward normal
    // come from the profile query, so decals hug the planking instead of floating
    // beside a box approximation. Each carries an empty gush-anchor Object3D that
    // Game.ts can hang water-jet FX on (see getHoleAnchors()).
    const addHole = (
      position: THREE.Vector3,
      normal: THREE.Vector3,
      radius: number,
      belowWaterline: boolean,
      extraDecal?: { offset: THREE.Vector3; normal: THREE.Vector3 },
    ) => {
      const hm = new THREE.Group();
      hm.position.copy(position);
      hm.visible = false;
      const n = normal.clone().normalize();
      const decal = makeHoleDecal(radius);
      decal.quaternion.setFromUnitVectors(Z_AXIS, n);
      hm.add(decal);
      if (extraDecal) {
        const second = makeHoleDecal(radius);
        second.position.copy(extraDecal.offset);
        second.quaternion.setFromUnitVectors(Z_AXIS, extraDecal.normal.clone().normalize());
        hm.add(second);
      }
      const gush = new THREE.Object3D();
      gush.name = 'hole-gush-anchor';
      gush.position.copy(n).multiplyScalar(0.12);
      gush.quaternion.setFromUnitVectors(Z_AXIS, n);
      hm.add(gush);
      hm.userData.gushAnchor = gush;
      hm.userData.belowWaterline = belowWaterline;
      hm.userData.floodActive = false;
      group.add(hm);
      return hm;
    };
    // Side holes ride the waterline band (matches server flood tests + leak FX
    // at local y≈0.16); bow holes sit on the flared cheeks; stern on the transom.
    // Side holes straddle the waterline band (server flood tests pass there and
    // hull-leak FX stream nearby); bow holes sit on the flared cheeks; the stern
    // hole rides the raked transom cap of the loft itself.
    const holeY = 0.28;
    const sideSurf = hullSurfacePointAt(profile, -L * 0.04, holeY);
    const bowSurf = hullSurfacePointAt(profile, L * 0.40, H * 0.30);
    const bowN = new THREE.Vector3(bowSurf.nx * 0.8, bowSurf.ny * 0.25, 0.62).normalize();
    const bowCheekX = bowSurf.x + bowSurf.nx * 0.03;
    const sternStation = profile.stations[0];
    const sternSurf = stationSurfaceAt(sternStation, H * 0.24);
    const sternN = new THREE.Vector3(
      0,
      sternStation.slots[0].z - sternStation.slots[sternStation.slots.length - 1].z,
      -(sternStation.sheerY - sternStation.keelY),
    ).normalize();
    const hullHoles = {
      // Bow breach: mirrored decals on both flared cheeks (the stem itself is
      // too narrow to carry a readable hole), anchored on the starboard cheek.
      bow: addHole(
        new THREE.Vector3(bowCheekX, H * 0.30, L * 0.40),
        new THREE.Vector3(bowN.x, bowN.y, bowN.z),
        0.3,
        false,
        { offset: new THREE.Vector3(-2 * bowCheekX, 0, 0), normal: new THREE.Vector3(-bowN.x, bowN.y, bowN.z) },
      ),
      stern: addHole(
        new THREE.Vector3(0, H * 0.24, sternSurf.z).addScaledVector(sternN, 0.05),
        sternN.clone(),
        0.38,
        false,
      ),
      port: addHole(
        new THREE.Vector3(-sideSurf.x - sideSurf.nx * 0.03, holeY, -L * 0.04),
        new THREE.Vector3(-sideSurf.nx, sideSurf.ny, 0),
        0.4,
        true,
      ),
      starboard: addHole(
        new THREE.Vector3(sideSurf.x + sideSurf.nx * 0.03, holeY, -L * 0.04),
        new THREE.Vector3(sideSurf.nx, sideSurf.ny, 0),
        0.4,
        true,
      ),
    };

    // Wales + boot-top: proud strakes that FOLLOW the loft (no more straight
    // boxes floating off the tapered bow/stern). Sheer strake under the cap
    // rail, main wale at the turn of the topside, boot-top at the waterline.
    for (const side of [1, -1] as const) {
      const sheerStrake = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, (st) => st.sheerY - H * 0.14, 0.055, H * 0.055),
        darkMat,
      );
      sheerStrake.castShadow = true;
      group.add(sheerStrake);
      const mainWale = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.60, 0.07, H * 0.05),
        darkMat,
      );
      mainWale.castShadow = true;
      group.add(mainWale);
      const bootTop = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, () => 0.08, 0.03, H * 0.045, 1, 7),
        darkMat,
      );
      group.add(bootTop);
    }

    // Painted team band across the transom (side stripe lives in the hull
    // texture, so it follows the sheer curve exactly).
    const transomBand = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.6, H * 0.09, 0.07),
      teamAccentMat,
    );
    transomBand.position.set(0, H * 0.82, -L * 0.505 - 0.1);
    group.add(transomBand);

    // Hull-reinforcement upgrade: actual bolted armor belts, ribs, and bow/stern plates.
    {
      const armor = new THREE.Group();
      armor.name = 'upgrade-hull-reinforcement';
      armor.visible = false;
      const armorMat = new THREE.MeshStandardMaterial({
        color: 0x6f7e86,
        roughness: 0.34,
        metalness: 0.78,
        emissive: 0x0b1f2e,
        emissiveIntensity: 0.08,
      });
      const darkArmorMat = new THREE.MeshStandardMaterial({
        color: 0x2d3940,
        roughness: 0.5,
        metalness: 0.85,
      });
      // Armor belts follow the loft like the wales, so they hug the planking
      for (const side of [1, -1] as const) {
        const mainBelt = new THREE.Mesh(
          makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.43, 0.1, H * 0.17, 1, 7),
          armorMat,
        );
        mainBelt.castShadow = true;
        armor.add(mainBelt);
        const upperBelt = new THREE.Mesh(
          makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.70, 0.08, H * 0.1, 1, 7),
          darkArmorMat,
        );
        upperBelt.castShadow = true;
        armor.add(upperBelt);
      }
      for (const z of [-L * 0.34, -L * 0.08, L * 0.2, L * 0.39]) {
        const ribHalf = hullSurfacePointAt(profile, z, H * 0.52).x + 0.055;
        const rib = new THREE.Mesh(new THREE.BoxGeometry(ribHalf * 2, H * 0.13, 0.07), darkArmorMat);
        rib.position.set(0, H * 0.52, z);
        rib.castShadow = true;
        armor.add(rib);
      }
      const bowPlate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.48, H * 0.34, 0.08), armorMat);
      bowPlate.position.set(0, H * 0.52, L * 0.535);
      bowPlate.castShadow = true;
      armor.add(bowPlate);
      const sternPlate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, H * 0.28, 0.08), armorMat);
      sternPlate.position.set(0, H * 0.52, -L * 0.565);
      sternPlate.castShadow = true;
      armor.add(sternPlate);

      const rivetGeo = new THREE.SphereGeometry(0.045, 6, 4);
      const rivets = new THREE.InstancedMesh(rivetGeo, darkArmorMat, 36);
      const matrix = new THREE.Matrix4();
      let index = 0;
      for (const sx of [-1, 1] as const) {
        for (let i = 0; i < 9; i++) {
          const z = -L * 0.36 + (i / 8) * L * 0.72;
          for (const y of [H * 0.36, H * 0.52]) {
            const surf = hullSurfacePointAt(profile, z, y);
            matrix.makeTranslation(sx * (surf.x + surf.nx * 0.1), y + surf.ny * 0.1, z);
            rivets.setMatrixAt(index++, matrix);
          }
        }
      }
      rivets.count = index;
      rivets.instanceMatrix.needsUpdate = true;
      rivets.castShadow = true;
      armor.add(rivets);
      group.add(armor);
      upgradeVisuals.hull_reinforcement.push(armor);
    }

    // Bow stem post follows the forward-raked stem curve of the loft, from the
    // waterline entry up past the sheer where the figurehead mounts.
    const bowStem = makeCylinderBetween(
      new THREE.Vector3(0, -profile.draft * 0.25, L * 0.425),
      new THREE.Vector3(0, H * 1.14, L * 0.538),
      0.105,
      darkMat,
      8,
    );
    group.add(bowStem);

    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 8), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    bowsprit.castShadow = true;
    group.add(bowsprit);

    const figureheadMat = new THREE.MeshStandardMaterial({
      color: 0xc49235,
      roughness: 0.54,
      metalness: 0.45,
      emissive: 0x2a1500,
      emissiveIntensity: 0.08,
    });
    // Per-type carved figurehead at the stem, team accent on the fins/tail/eyes.
    const figurehead = makeFigurehead(ship.type, figureheadMat, teamAccentMat);
    figurehead.position.set(0, H * 0.72, L * 0.55);
    figurehead.rotation.x = -0.12;
    group.add(figurehead);

    // Transom panel nests within the lofted stern (the loft's own raked cap
    // carries the shape below) instead of the old full-beam slab.
    const sternTransom = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.64, H * 0.52, 0.14),
      darkMat,
    );
    sternTransom.position.set(0, H * 0.66, -L * 0.505);
    sternTransom.castShadow = true;
    sternTransom.receiveShadow = true;
    group.add(sternTransom);

    const bowCap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.34, H * 0.18, 0.12),
      hullMat,
    );
    bowCap.position.set(0, H * 0.78, L * 0.49);
    bowCap.castShadow = true;
    group.add(bowCap);

    // External keel plank running under the new draft, plus a rudder blade
    // hung off the raked sternpost — the underwater body reads as a real hull.
    const keel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, L * 0.68), darkMat);
    keel.position.set(0, -profile.draft + 0.05, -L * 0.02);
    group.add(keel);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.09, profile.draft * 0.85 + H * 0.2, L * 0.045), darkMat);
    rudder.position.set(0, -profile.draft * 0.42 + H * 0.06, -L * 0.455);
    rudder.rotation.x = 0.1;
    group.add(rudder);

    // ── Stairwell hole (shared by the weather deck above and the interior ceiling below) ────────
    const halfDeckZ = L * 0.45;
    const companionway = getShipCompanionwayConfig(stats);
    const stairCenterX = companionway.cx;
    const voidHalfX = companionway.halfX;
    const voidHalfZ = companionway.halfZ;
    const holeCx = companionway.cx;
    const holeCz = companionway.cz;

    // ── Ship Interior (below deck) ────────────────────────────
    const interior = makeShipInterior(stats, deckMat, darkMat, {
      cx: holeCx,
      cz: holeCz,
      halfX: voidHalfX,
      halfZ: voidHalfZ,
    });
    group.add(interior);

    // ── Water-in-hull plane ──────────────────────────────────
    // Dark flooding water inside the hold, visible from above through the open
    // companionway / hatch grating. Hidden until ship.waterLevel > 0.02;
    // its Y rises with the flood level and a few verts ripple in update().
    // The plane is FITTED to the interior footprint: each z-row is scaled to
    // the loft's waterline half-width at that station, so the rising sheet
    // stays inside the hull silhouette instead of poking through the tapered
    // bow/stern planking. (Above local y=0 the hull only gets wider toward the
    // wale, so the waterline half-width is a safe inner bound at every fill.)
    const holdWaterGeo = new THREE.PlaneGeometry(1, 1, 6, 8);
    holdWaterGeo.rotateX(-Math.PI * 0.5);
    {
      const pos = holdWaterGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const zLocal = pos.getZ(i) * L * 0.9; // rows span ±0.45 L
        const half = Math.max(0.16, hullSurfacePointAt(profile, zLocal, 0).x * 0.92);
        pos.setX(i, pos.getX(i) * 2 * half); // ±0.5 → ±half at this station
        pos.setZ(i, zLocal);
      }
      pos.needsUpdate = true;
      holdWaterGeo.computeVertexNormals();
    }
    const holdWater = new THREE.Mesh(
      holdWaterGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0a2028,
        roughness: 0.18,
        metalness: 0.35,
        emissive: 0x03141c,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    holdWater.position.set(0, 0.42, 0);
    holdWater.visible = false;
    holdWater.renderOrder = 1;
    const holdWaterBase = Float32Array.from(
      (holdWaterGeo.attributes.position as THREE.BufferAttribute).array as Float32Array,
    );
    group.add(holdWater);

    // ── Weather deck (split around stairwell — no hatch lids; open companionway like Sea of Thieves)

    // Weather deck: 4 box slabs around the stairwell so the hole is *real* geometry
    // (no fragile ShapeGeometry hole-punching). The bulwarks/rails added later hide
    // the rectangular outer edge.
    // Slab center such that the TOP face lands exactly on the server's standing
    // plane (ship.y + H + 0.1) — pirates stand ON the planks, not ankle-deep.
    const deckTopY = H + 0.025;
    const addDeckSlab = (cx: number, cz: number, bw: number, bd: number) => {
      if (bw <= 0.05 || bd <= 0.05) return;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.25, bw), 0.15, Math.max(0.25, bd)),
        deckMat,
      );
      slab.position.set(cx, deckTopY, cz);
      slab.receiveShadow = true;
      slab.castShadow = true;
      group.add(slab);
    };

    const zSternEdge = -halfDeckZ;
    const zBowEdge = halfDeckZ;
    const zHoleMin = holeCz - voidHalfZ;
    const zHoleMax = holeCz + voidHalfZ;
    const sternDepth = Math.max(0, zHoleMin - zSternEdge);
    if (sternDepth > 0) addDeckSlab(0, zSternEdge + sternDepth * 0.5, W * 0.95, sternDepth);
    const bowDepth = Math.max(0, zBowEdge - zHoleMax);
    if (bowDepth > 0) addDeckSlab(0, zHoleMax + bowDepth * 0.5, W * 0.95, bowDepth);

    const midDepth = Math.max(0, zHoleMax - zHoleMin);
    const xPortOuter = -W * 0.475;
    const xStarOuter = W * 0.475;
    const xHoleMin = holeCx - voidHalfX;
    const xHoleMax = holeCx + voidHalfX;
    const portMidW = Math.max(0, xHoleMin - xPortOuter);
    if (portMidW > 0 && midDepth > 0) addDeckSlab(xPortOuter + portMidW * 0.5, holeCz, portMidW, midDepth);
    const starMidW = Math.max(0, xStarOuter - xHoleMax);
    if (starMidW > 0 && midDepth > 0) addDeckSlab(xHoleMax + starMidW * 0.5, holeCz, starMidW, midDepth);

    // Trim coamings around the companionway (no hatch — just raised lip)
    const coamingMat = darkMat;
    for (const sx of [-1, 1] as const) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, midDepth + 0.08), coamingMat);
      lip.position.set(holeCx + sx * (voidHalfX + 0.05), H + 0.08, holeCz);
      lip.castShadow = true;
      group.add(lip);
    }
    for (const sz of [-1, 1] as const) {
      const endLip = new THREE.Mesh(new THREE.BoxGeometry(voidHalfX * 2 + 0.24, 0.1, 0.12), coamingMat);
      endLip.position.set(holeCx, H + 0.07, holeCz + sz * (voidHalfZ + 0.05));
      endLip.castShadow = true;
      group.add(endLip);
    }

    // Cargo-hold hatch grating amidships (forward of the companionway) — light and
    // rising floodwater read through its slats from above.
    {
      const grateW = Math.min(W * 0.34, 1.4);
      const grateL = Math.min(L * 0.16, 1.5);
      const grating = makeHatchGrating(grateW, grateL, darkMat, coamingMat);
      grating.position.set(W * 0.2, H + 0.13, holeCz + voidHalfZ + grateL * 0.65 + 0.22);
      group.add(grating);
    }

    // Stairwell down to the hold: a single solid run with broad treads, so there
    // is no floating plank gap or invisible divider between decks.
    const stairTopY = H + 0.03;
    const stairBottomY = 0.43;
    const stairFrontZ = companionway.stairFrontZ - Math.max(0.16, L * 0.012);
    const stairBackZ = companionway.stairBackZ;
    const stairWidth = companionway.stairHalfWidth * 2 - 0.18;
    const stairRun = Math.max(0.5, stairFrontZ - stairBackZ);
    const stairBody = new THREE.Mesh(
      makeStairRampGeometry(stairWidth, stairTopY, stairBottomY, stairFrontZ, stairBackZ, 0.22),
      deckMat,
    );
    stairBody.position.x = stairCenterX;
    stairBody.castShadow = true;
    stairBody.receiveShadow = true;
    group.add(stairBody);

    const stairStepCount = ship.type === 'sloop' ? 6 : ship.type === 'brigantine' ? 7 : 8;
    const treadDepth = Math.min(0.72, stairRun / stairStepCount * 0.82);
    for (let step = 0; step < stairStepCount; step++) {
      const stepMesh = new THREE.Mesh(
        new THREE.BoxGeometry(stairWidth, 0.09, treadDepth),
        deckMat,
      );
      const progress = step / Math.max(1, stairStepCount - 1);
      const y = stairTopY + (stairBottomY - stairTopY) * progress;
      const z = stairFrontZ + (stairBackZ - stairFrontZ) * progress;
      stepMesh.position.set(
        stairCenterX,
        y + 0.035,
        z,
      );
      stepMesh.castShadow = true;
      stepMesh.receiveShadow = true;
      group.add(stepMesh);
    }

    for (const sx of [-1, 1] as const) {
      const railX = stairCenterX + sx * (stairWidth * 0.5 + 0.13);
      const railStart = new THREE.Vector3(railX, stairTopY + 0.42, stairFrontZ - 0.06);
      const railEnd = new THREE.Vector3(railX, stairBottomY + 0.5, stairBackZ + 0.08);
      const handrail = makeCylinderBetween(railStart, railEnd, 0.036, darkMat, 8);
      group.add(handrail);
      for (let p = 0; p < 4; p++) {
        const progress = p / 3;
        const z = THREE.MathUtils.lerp(stairFrontZ - 0.08, stairBackZ + 0.08, progress);
        const baseY = THREE.MathUtils.lerp(stairTopY - 0.01, stairBottomY + 0.03, progress);
        const topY = THREE.MathUtils.lerp(railStart.y, railEnd.y, progress);
        const post = makeCylinderBetween(
          new THREE.Vector3(railX, baseY, z),
          new THREE.Vector3(railX, topY, z),
          0.027,
          darkMat,
          7,
        );
        group.add(post);
      }
    }

    // ── Railings ─────────────────────────────────────────────
    const railH = 0.58, railThick = 0.07;
    const addRail = (x: number, z: number, rw: number, rl: number) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(rw, railH, rl), darkMat);
      r.position.set(x, H + railH * 0.5, z);
      group.add(r);
    };
    addRail( W * 0.5 - railThick, 0, railThick * 2, L * 0.82);
    addRail(-W * 0.5 + railThick, 0, railThick * 2, L * 0.82);
    addRail(0, -L * 0.41, W * 0.95, railThick * 2);

    // Bulwarks keep the upper deck feeling like a proper enclosed ship instead of an open raft.
    const bulwarkH = 0.34;
    for (const sx of [-1, 1]) {
      const bulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.78),
        deckMat,
      );
      bulwark.position.set(sx * (W * 0.44), H + bulwarkH * 0.5, 0);
      bulwark.castShadow = true;
      bulwark.receiveShadow = true;
      group.add(bulwark);
    }
    const bowBreastwork = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.72, bulwarkH, 0.16),
      deckMat,
    );
    bowBreastwork.position.set(0, H + bulwarkH * 0.5, L * 0.36);
    group.add(bowBreastwork);
    for (const sx of [-1, 1]) {
      const quarterBulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.18),
        deckMat,
      );
      quarterBulwark.position.set(sx * (W * 0.33), H + bulwarkH * 0.5, -L * 0.31);
      group.add(quarterBulwark);
    }

    for (const sx of [-1, 1] as const) {
      const capRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.1, L * 0.86),
        darkMat,
      );
      capRail.position.set(sx * W * 0.48, H + bulwarkH + 0.05, 0);
      capRail.castShadow = true;
      group.add(capRail);
    }
    const sternCapRail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.1, 0.22), darkMat);
    sternCapRail.position.set(0, H + bulwarkH + 0.05, -L * 0.42);
    sternCapRail.castShadow = true;
    group.add(sternCapRail);

    // Railing stanchions
    const stanchionCount = Math.max(4, Math.round(L / 3));
    for (let s = 0; s < stanchionCount; s++) {
      const sz = L * 0.41 - s * (L * 0.82 / stanchionCount);
      for (const sx of [-1, 1]) {
        const stanchion = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, railH, 6),
          darkMat,
        );
        stanchion.position.set(sx * (W * 0.5 - railThick), H + railH * 0.5, sz);
        group.add(stanchion);
      }
    }

    // Boarding ladders on both sides
    const ladderTop = H + 0.42;
    const ladderBottom = 0.35;
    const ladderHeight = ladderTop - ladderBottom;
    const ladderRopeMat = ropeCoilMat;
    const ladderRungMat = darkMat;
    for (const ladder of getShipBoardingLadderLocals(ship.type)) {
      for (const ropeOffset of [-0.14, 0.14]) {
        const rope = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, ladderHeight, 6),
          ladderRopeMat,
        );
        rope.position.set(ladder.x, ladderBottom + ladderHeight * 0.5, ladder.z + ropeOffset);
        group.add(rope);
      }
      for (let rung = 0; rung < 6; rung++) {
        const rungY = ladderBottom + 0.2 + rung * (ladderHeight - 0.4) / 5;
        const rungMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6),
          ladderRungMat,
        );
        rungMesh.rotation.x = Math.PI * 0.5;
        rungMesh.position.set(ladder.x, rungY, ladder.z);
        group.add(rungMesh);
      }
    }

    // ── Stern castle ─────────────────────────────────────────
    const sternW = W * 0.88, sternH = H * 0.28, sternL = L * 0.22;
    const stern = new THREE.Mesh(new THREE.BoxGeometry(sternW, sternH, sternL), darkMat);
    stern.position.set(0, H + sternH * 0.5, -L * 0.37);
    stern.castShadow = true;
    group.add(stern);

    // Stern windows. Keep the glass on the aft face, with separate bars instead of
    // one solid brass rectangle covering the pane.
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x8fc7d8,
      roughness: 0.08,
      metalness: 0.15,
      emissive: 0x24465a,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.78,
    });
    const windowCount = Math.max(2, Math.round(W / 2.5));
    const sternFaceZ = -L * 0.51 - 0.085;
    for (let w = 0; w < windowCount; w++) {
      const wx = -sternW * 0.35 + w * (sternW * 0.7 / Math.max(windowCount - 1, 1));
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.05), windowMat);
      win.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.012);
      group.add(win);
      const winFrame = makeWindowFrame(0.5, 0.35, 0.055, 0.045, brassHardwareMat);
      winFrame.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.04);
      group.add(winFrame);
    }

    const galleryRailY = H + sternH * 0.24;
    const galleryRail = new THREE.Group();
    galleryRail.position.set(0, galleryRailY, sternFaceZ - 0.16);
    const galleryTop = new THREE.Mesh(new THREE.BoxGeometry(sternW * 0.72, 0.06, 0.07), brassHardwareMat);
    galleryTop.position.y = 0.28;
    galleryRail.add(galleryTop);
    for (let p = 0; p < windowCount + 1; p++) {
      const px = -sternW * 0.36 + p * (sternW * 0.72 / windowCount);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.36, 6), brassHardwareMat);
      post.position.set(px, 0.1, 0);
      post.castShadow = true;
      galleryRail.add(post);
    }
    group.add(galleryRail);

    // Helm wheel
    const wheelPost = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 1.06, 8), darkMat);
    wheelPost.position.set(0, H + 0.56, -L * 0.315);
    wheelPost.castShadow = true;
    group.add(wheelPost);

    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(0, H + 1.16, -L * 0.315);
    group.add(wheelGroup);

    const wheelBase = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.13, 8), metalMat);
    wheelBase.rotation.x = Math.PI * 0.5;
    wheelBase.castShadow = true;
    wheelGroup.add(wheelBase);

    const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.055, 8, 18), metalMat);
    wheelRim.castShadow = true;
    wheelGroup.add(wheelRim);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.2, 8), metalMat);
    hub.rotation.x = Math.PI * 0.5;
    hub.castShadow = true;
    wheelGroup.add(hub);

    for (let spoke = 0; spoke < 8; spoke++) {
      const spokeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.58, 0.042), darkMat);
      spokeMesh.rotation.z = (spoke / 8) * Math.PI * 2;
      wheelGroup.add(spokeMesh);

      // Handle pegs on alternating spokes
      if (spoke % 2 === 0) {
        const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6), darkMat);
        peg.rotation.x = Math.PI * 0.5;
        peg.position.set(Math.cos((spoke / 8) * Math.PI * 2) * 0.36, Math.sin((spoke / 8) * Math.PI * 2) * 0.36, 0.06);
        wheelGroup.add(peg);
      }
    }

    // Compass binnacle next to helm, close enough to read while steering.
    const compassX = W * 0.19;
    const compassZ = -L * 0.318;
    const binnacle = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.72, 10), darkMat);
    binnacle.position.set(compassX, H + 0.48, compassZ);
    binnacle.castShadow = true;
    group.add(binnacle);
    const compassTop = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.08, 18), brassHardwareMat);
    compassTop.position.set(compassX, H + 0.87, compassZ);
    group.add(compassTop);
    const compassFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.225, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4e0ad, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide }),
    );
    compassFace.rotation.x = -Math.PI * 0.5;
    compassFace.position.set(compassX, H + 0.916, compassZ);
    group.add(compassFace);
    const compassNeedle = new THREE.Group();
    compassNeedle.position.set(compassX, H + 0.928, compassZ);
    const northNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.018, 0.29), new THREE.MeshStandardMaterial({ color: 0xc52f24, roughness: 0.5 }));
    northNeedle.position.z = 0.072;
    const southNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.22), new THREE.MeshStandardMaterial({ color: 0x253044, roughness: 0.5 }));
    southNeedle.position.z = -0.055;
    compassNeedle.add(northNeedle, southNeedle);
    group.add(compassNeedle);
    for (let tick = 0; tick < 8; tick++) {
      const mark = new THREE.Mesh(
        new THREE.BoxGeometry(tick % 2 === 0 ? 0.018 : 0.012, 0.012, tick % 2 === 0 ? 0.07 : 0.045),
        new THREE.MeshStandardMaterial({ color: tick === 0 ? 0xb7241f : 0x263147, roughness: 0.6 }),
      );
      const angle = (tick / 8) * Math.PI * 2;
      mark.position.set(compassX + Math.sin(angle) * 0.16, H + 0.932, compassZ + Math.cos(angle) * 0.16);
      mark.rotation.y = angle;
      group.add(mark);
    }

    // Bow anchor capstan: a clear manual wheel station for dropping / raising anchor.
    const anchorCapstan = new THREE.Group();
    anchorCapstan.position.set(0, H + 0.1, L * 0.42);
    const capstanPost = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 0.78, 12), darkMat);
    capstanPost.position.y = 0.39;
    capstanPost.castShadow = true;
    anchorCapstan.add(capstanPost);
    const capstanBand = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 12), brassHardwareMat);
    capstanBand.position.y = 0.66;
    capstanBand.castShadow = true;
    anchorCapstan.add(capstanBand);
    const capstanWheel = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.055, 8, 30), brassHardwareMat);
    capstanWheel.rotation.x = Math.PI * 0.5;
    capstanWheel.position.y = 0.88;
    capstanWheel.castShadow = true;
    anchorCapstan.add(capstanWheel);
    for (let spoke = 0; spoke < 8; spoke++) {
      const angle = (spoke / 8) * Math.PI * 2;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.075, 0.095), darkMat);
      handle.position.y = 0.88;
      handle.rotation.y = angle;
      handle.castShadow = true;
      anchorCapstan.add(handle);
      for (const sign of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 8), brassHardwareMat);
        knob.position.set(Math.cos(angle) * sign * 0.72, 0.88, -Math.sin(angle) * sign * 0.72);
        knob.rotation.z = Math.PI * 0.5;
        knob.castShadow = true;
        anchorCapstan.add(knob);
      }
    }

    const anchorChain = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 2.15, 6),
      metalMat,
    );
    anchorChain.position.set(0, -0.78, 0.36);
    anchorChain.castShadow = true;
    anchorCapstan.add(anchorChain);

    group.add(anchorCapstan);

    const anchor = new THREE.Group();
    const buildAnchor = (side: -1 | 1) => {
      const g = new THREE.Group();
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.65, 6), metalMat);
      shank.castShadow = true;
      g.add(shank);

      const stock = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), metalMat);
      stock.rotation.z = Math.PI * 0.5;
      stock.position.y = 0.58;
      g.add(stock);

      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 12), metalMat);
      ring.position.y = 0.88;
      ring.rotation.x = Math.PI * 0.5;
      g.add(ring);

      for (const armSide of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.84, 6), metalMat);
        arm.position.set(armSide * 0.18, -0.32, 0);
        arm.rotation.z = armSide * Math.PI * 0.36;
        g.add(arm);

        const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), metalMat);
        fluke.position.set(armSide * 0.34, -0.73, 0);
        fluke.rotation.z = armSide * Math.PI * 0.14 - Math.PI * 0.18;
        g.add(fluke);
      }

      g.position.set(side * (W * 0.46), 0, L * 0.44);
      g.rotation.z = side * Math.PI * 0.33;
      g.rotation.y = side * Math.PI * 0.06;
      return g;
    };
    anchor.add(buildAnchor(-1));
    anchor.add(buildAnchor(1));
    anchor.position.y = H + 0.34;
    group.add(anchor);

    // Rope coil near anchor
    const ropeCoil = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.065, 6, 12), ropeCoilMat);
    ropeCoil.rotation.x = Math.PI * 0.5;
    ropeCoil.position.set(-0.24, H + 0.16, L * 0.38);
    group.add(ropeCoil);

    // ── Masts ────────────────────────────────────────────────
    const sails: THREE.Mesh[] = [];
    const furledSails: THREE.Mesh[] = [];
    const pennants: THREE.Mesh[] = [];
    const trimPivots: THREE.Group[] = [];
    const mastCount = stats.mastCount;
    const mastSpacing = L * 0.55 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.22;

    // All rigging collapses into two LineSegments draw calls (rope + ratline)
    // instead of ~50 individual Line objects per ship.
    const ropeSegmentPts: THREE.Vector3[] = [];
    const ratlineSegmentPts: THREE.Vector3[] = [];

    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      const mastH = H * (mastCount === 1 ? 3.6 : 3.1);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);

      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(mastR * 0.8, mastR * 1.4, mastH, 8),
        darkMat,
      );
      mast.position.set(0, H + mastH * 0.5, mastZ);
      mast.castShadow = true;
      group.add(mast);

      // Mast top cap
      const mastCap = new THREE.Mesh(new THREE.CylinderGeometry(mastR * 1.5, mastR * 1.2, 0.2, 8), darkMat);
      mastCap.position.set(0, H + mastH, mastZ);
      group.add(mastCap);

      const pennant = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15 - m * 0.12, 0.26),
        new THREE.MeshStandardMaterial({
          color: m === 0 ? ship.teamColor : 0xe8d8aa,
          emissive: m === 0 ? ship.teamColor : 0x000000,
          emissiveIntensity: m === 0 ? 0.18 : 0,
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        }),
      );
      pennant.position.set(0, H + mastH - 0.35, mastZ);
      group.add(pennant);
      pennants.push(pennant);

      // Crow's nest on main/top mast
      if (m === 0 && mastH > 6) {
        const nestY = H + mastH * 0.72;
        const nestFloor = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 0.14, 8), darkMat);
        nestFloor.position.set(0, nestY, mastZ);
        group.add(nestFloor);
        const nestRail = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.05, 6, 12), darkMat);
        nestRail.rotation.x = Math.PI * 0.5;
        nestRail.position.set(0, nestY + 0.45, mastZ);
        group.add(nestRail);
      }

      // Boom / yardarm — lives inside a trim pivot together with its sail and
      // furled roll, so bracing the sails visibly swings the SPAR too instead
      // of the canvas rotating away from a frozen yard.
      const yardW = W * (1.2 - m * 0.1);
      const trimPivot = new THREE.Group();
      trimPivot.name = 'yard-trim-pivot';
      trimPivot.position.set(0, H + mastH * 0.82, mastZ);
      group.add(trimPivot);
      trimPivots.push(trimPivot);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.042, yardW, 6),
        darkMat,
      );
      yard.rotation.z = Math.PI * 0.5;
      yard.castShadow = true;
      trimPivot.add(yard);

      // Rigging lines from yardarm to deck
      for (const sx of [-1, 1]) {
        ropeSegmentPts.push(
          new THREE.Vector3(sx * yardW * 0.48, H + mastH * 0.82, mastZ),
          new THREE.Vector3(sx * W * 0.44, H + 0.15, mastZ - L * 0.04),
        );
      }

      const addRigLine = (a: THREE.Vector3, b: THREE.Vector3) => {
        ratlineSegmentPts.push(a, b);
      };
      for (const sx of [-1, 1] as const) {
        const topA = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.78, mastZ - L * 0.025);
        const topB = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.72, mastZ + L * 0.025);
        const baseA = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ - L * 0.09);
        const baseB = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ + L * 0.08);
        addRigLine(topA, baseA);
        addRigLine(topB, baseB);
        const rungCount = 6;
        for (let rung = 1; rung < rungCount; rung++) {
          const tRung = rung / rungCount;
          addRigLine(
            new THREE.Vector3().lerpVectors(topA, baseA, tRung),
            new THREE.Vector3().lerpVectors(topB, baseB, tRung),
          );
        }
      }

      // Square-rigged sail — hangs from the yardarm. PlaneGeometry's default frame is
      // exactly what we want: width along X (matches yardarm direction), height along Y
      // (drops toward deck), normal along +Z (faces forward when "square" to wind).
      // The sail trim animation rotates around Y by `ship.sailAngle`.
      const sailGeo = makeBillowedSailGeometry(yardW * 0.92, mastH * 0.72, 10, 7);
      const mastSailMat = sailMat.clone();
      // Main sail carries the painted team band (team read at distance)
      if (m === 0) mastSailMat.map = this.getTeamSailTexture(ship.teamColor);
      const sail = new THREE.Mesh(sailGeo, mastSailMat);
      sail.rotation.order = 'YXZ';
      sail.rotation.y = 0;
      // Pivot-local frame: the pivot sits AT the yard, so hoist metadata is
      // relative to it (hoistTopY = 0 = the yard height).
      sail.position.set(0, -mastH * 0.27, 0);
      sail.userData.hoistTopY = 0;
      sail.userData.hoistHeight = mastH * 0.72;
      sail.userData.hoistCentered = true;
      sail.userData.sailKind = 'square';
      sail.userData.trimPivot = trimPivot;
      sail.userData.phaseSeed = mastZ;
      // Cloth flutter: keep the rest-pose so per-frame displacement is additive
      sail.userData.clothBase = Float32Array.from(
        (sailGeo.attributes.position as THREE.BufferAttribute).array as Float32Array,
      );
      sail.userData.clothW = yardW * 0.92;
      sail.userData.clothH = mastH * 0.72;
      sail.castShadow = false;
      sail.receiveShadow = false;
      this.addSwiftSailTrim(sail, yardW * 0.92, mastH * 0.72, upgradeVisuals.swift_sails);
      trimPivot.add(sail);
      sails.push(sail);

      // Furled canvas: a fat lashed BUNDLE gathered against the yard, not a
      // thin rod — an anchored ship must read as "sails stowed", not
      // dismasted. Slight vertical sag + gasket lashings sell the bundle.
      const furledGroup = new THREE.Group();
      const furled = new THREE.Mesh(
        new THREE.CylinderGeometry(0.26, 0.3, yardW * 0.86, 10),
        sailMat.clone(),
      );
      furled.rotation.z = Math.PI * 0.5;
      furled.castShadow = true;
      furledGroup.add(furled);
      // Rope gaskets lashing the bundle to the yard at intervals
      const gasketMat = new THREE.MeshStandardMaterial({ color: 0x6b5836, roughness: 1 });
      for (let g = -2; g <= 2; g++) {
        const gasket = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.028, 5, 10), gasketMat);
        gasket.rotation.y = Math.PI * 0.5;
        gasket.position.x = g * yardW * 0.17;
        furledGroup.add(gasket);
      }
      furledGroup.position.set(0, -mastH * 0.045, -0.04);
      furledGroup.userData.phaseSeed = mastZ;
      furledGroup.scale.y = 1;
      trimPivot.add(furledGroup);
      furledSails.push(furledGroup as unknown as THREE.Mesh);
    }

    // Crow's nest ladder — vertical rails hug the main mast pole (x=0), not offset toward the rail edge
    {
      const mainMastZ = getMainMastLocalZ(stats);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
      const nestY = getCrowNestStandingY(stats);
      const ladderBottom = H + 0.2;
      const ladderTop = nestY + 0.02;
      const ladderH = Math.max(0.4, ladderTop - ladderBottom);
      const railMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.95 });
      const railW = 0.07;
      const mastOuter = mastR * 1.35 + 0.012;
      const railCenterX = mastOuter + railW * 0.5 + 0.018;
      for (const side of [-1, 1] as const) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(railW, ladderH + 0.12, 0.075),
          railMat,
        );
        rail.position.set(side * railCenterX, ladderBottom + ladderH * 0.5, mainMastZ + side * 0.015);
        rail.rotation.y = side * 0.06;
        rail.castShadow = true;
        group.add(rail);
      }
      const rungCount = 8;
      const rungSpan = railCenterX * 2 + railW * 0.45;
      for (let r = 0; r <= rungCount; r++) {
        const ry = ladderBottom + (r / rungCount) * ladderH;
        const rung = new THREE.Mesh(
          new THREE.BoxGeometry(rungSpan, 0.05, 0.088),
          deckMat,
        );
        rung.position.set(0, ry, mainMastZ);
        rung.castShadow = true;
        group.add(rung);
      }
    }

    // Shared centerline sail ring, separated from side cannon click zones and anchor capstan.
    {
      const markerMat = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1, side: THREE.DoubleSide });
      const brassMat = new THREE.MeshStandardMaterial({ color: 0xa8792a, roughness: 0.55, metalness: 0.55 });
      // Rail rope stations (SoT braces): worked from the bulwarks on BOTH
      // sides — coiled halyard rope on a belaying rack, tail dropping from
      // the rigging above. The floating deck-ring station is gone.
      const ropeStationMat = new THREE.MeshStandardMaterial({ color: 0xb99e6a, roughness: 0.95 });
      for (const ropeStation of getSailRopeStationLocals(stats)) {
        const rack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.16), markerMat);
        rack.position.set(ropeStation.x, H + 0.78, ropeStation.z);
        rack.castShadow = true;
        group.add(rack);
        for (const pinOff of [-0.3, 0, 0.3]) {
          const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.035, 0.34, 6), brassMat);
          pin.position.set(ropeStation.x + pinOff, H + 0.68, ropeStation.z);
          group.add(pin);
        }
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.075, 8, 16), ropeStationMat);
        coil.rotation.y = Math.PI * 0.5;
        coil.position.set(ropeStation.x, H + 0.5, ropeStation.z + 0.02);
        group.add(coil);
        const coil2 = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.06, 8, 14), ropeStationMat);
        coil2.rotation.y = Math.PI * 0.5;
        coil2.position.set(ropeStation.x + 0.02, H + 0.46, ropeStation.z - 0.12);
        group.add(coil2);
        // rope tail dropping from the rig toward the rack
        const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, H * 1.3, 5), ropeStationMat);
        tail.position.set(ropeStation.x * 0.92, H + H * 0.9, ropeStation.z);
        tail.rotation.z = ropeStation.x > 0 ? 0.14 : -0.14;
        group.add(tail);
      }
    }

    // Forward jib tied to the bowsprit; this gives the bow a proper pirate-ship profile from side view.
    const jibShape = new THREE.Shape();
    jibShape.moveTo(0, 0);
    jibShape.lineTo(L * 0.24, H * 0.34);
    jibShape.lineTo(0.02, H * 1.18);
    jibShape.lineTo(0, 0);
    const jib = new THREE.Mesh(new THREE.ShapeGeometry(jibShape), sailMat.clone());
    jib.rotation.order = 'YXZ';
    // Jib is a stay-sail running on the centerline (YZ plane), so its plane normal
    // points sideways. It does NOT trim with the yardarm sails — fixed yaw.
    jib.rotation.y = Math.PI * 0.5;
    jib.position.set(0, H + 0.68, L * 0.56);
    jib.userData.hoistTopY = H + 0.68 + H * 1.18;
    jib.userData.hoistHeight = H * 1.18;
    jib.userData.hoistCentered = false;
    jib.userData.sailKind = 'stay';
    jib.userData.fixedYaw = Math.PI * 0.5;
    jib.userData.phaseSeed = L * 0.56;
    jib.castShadow = false;
    jib.receiveShadow = false;
    this.addSwiftSailTrim(jib, L * 0.24, H * 1.18, upgradeVisuals.swift_sails, true);
    group.add(jib);
    sails.push(jib);
    const furledJib = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, L * 0.22, 8), sailMat.clone());
    furledJib.rotation.x = Math.PI * 0.5;
    furledJib.rotation.z = -0.18;
    furledJib.position.set(0, H + 1.02, L * 0.66);
    furledJib.userData.phaseSeed = L * 0.66;
    furledJib.castShadow = true;
    group.add(furledJib);
    furledSails.push(furledJib);

    // Fore-stay rigging (bowsprit to foremast)
    const foreMastZ = mastStartZ;
    ropeSegmentPts.push(
      new THREE.Vector3(0, H + H * 2.15, foreMastZ),
      new THREE.Vector3(0, H + 0.55, L * 0.76),
    );
    for (const sx of [-1, 1] as const) {
      ropeSegmentPts.push(
        new THREE.Vector3(sx * W * 0.18, H + 0.52, L * 0.74),
        new THREE.Vector3(0, H + H * 1.95, foreMastZ),
      );
    }

    // Flush all collected rigging into two draw calls
    if (ropeSegmentPts.length > 0) {
      group.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(ropeSegmentPts),
        new THREE.LineBasicMaterial({ color: 0x6a5030 }),
      ));
    }
    if (ratlineSegmentPts.length > 0) {
      group.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(ratlineSegmentPts),
        new THREE.LineBasicMaterial({ color: 0x4b3520 }),
      ));
    }

    // ── Cannons ──────────────────────────────────────────────
    const cannonGroups: CannonMeshGroup[] = [];
    const cannonCount = stats.cannonCount;
    const cannonsPerSide = cannonCount / 2;
    const cannonSpacing = L * 0.5 / Math.max(cannonsPerSide - 1, 1);

    // Bigger, more visibly detailed cannons. Material highlights:
    // - Dark iron barrel with three brass reinforcing bands
    // - Brass muzzle bell at the front so the gun reads clearly even from far
    // - Beefier oak carriage with iron-banded wheels and trunnion caps
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb48335, roughness: 0.45, metalness: 0.7 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.55, metalness: 0.55 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x4f3520, roughness: 0.95 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x261810, roughness: 0.95 });
    const ironBandMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.7 });
    const boreMat = new THREE.MeshBasicMaterial({ color: 0x040404 });
    const lashingMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
    const chargedMetalMat = new THREE.MeshStandardMaterial({
      color: UPGRADE_PENNANT_COLORS.charged_cannons,
      emissive: 0xff3200,
      emissiveIntensity: 1.15,
      roughness: 0.3,
      metalness: 0.62,
    });
    const chargedGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff6c22,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const barrelLen = 1.5;
    const barrelR = 0.18;
    for (let side = 0; side < 2; side++) {
      const sideX = (side === 0 ? 1 : -1) * (W * 0.5 + 0.06);
      for (let c = 0; c < cannonsPerSide; c++) {
        const cz = L * 0.2 - c * cannonSpacing;
        const cg = new THREE.Group();
        const yawPivot = new THREE.Group();
        const pitchPivot = new THREE.Group();
        cg.add(yawPivot);
        yawPivot.add(pitchPivot);
        pitchPivot.position.set(0, 0.18, 0);

        // Main barrel — taper from breech (back) to muzzle (front)
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.95, barrelR * 1.2, barrelLen, 14),
          ironMat,
        );
        barrel.rotation.z = Math.PI * 0.5;
        barrel.position.x = barrelLen * 0.5 - 0.1;
        barrel.castShadow = true;
        pitchPivot.add(barrel);

        // Brass reinforcing bands at three positions along the barrel
        for (const offset of [0.05, 0.55, 0.95] as const) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.2, barrelR * 1.25, 0.08, 14),
            brassMat,
          );
          band.rotation.z = Math.PI * 0.5;
          band.position.x = -0.1 + offset * barrelLen;
          pitchPivot.add(band);
        }

        // Brass muzzle bell — flared at the front so the gun reads clearly
        const muzzle = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 1.45, barrelR * 1.0, 0.18, 14),
          brassMat,
        );
        muzzle.rotation.z = Math.PI * 0.5;
        muzzle.position.x = barrelLen - 0.1 + 0.06;
        muzzle.castShadow = true;
        pitchPivot.add(muzzle);

        // Dark muzzle bore (interior)
        const bore = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.65, barrelR * 0.65, 0.06, 12),
          boreMat,
        );
        bore.rotation.z = Math.PI * 0.5;
        bore.position.x = barrelLen - 0.1 + 0.13;
        pitchPivot.add(bore);

        const chargeGroup = new THREE.Group();
        chargeGroup.name = 'upgrade-charged-cannon';
        chargeGroup.visible = false;
        for (const offset of [0.26, 0.7, 1.05] as const) {
          const chargeBand = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.34, barrelR * 1.38, 0.035, 14),
            chargedMetalMat,
          );
          chargeBand.rotation.z = Math.PI * 0.5;
          chargeBand.position.x = -0.1 + offset * barrelLen;
          chargeGroup.add(chargeBand);
        }
        const muzzleGlow = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.72, 10, 8),
          chargedGlowMat,
        );
        muzzleGlow.position.x = barrelLen - 0.1 + 0.2;
        muzzleGlow.scale.set(1.35, 0.72, 0.72);
        chargeGroup.add(muzzleGlow);
        pitchPivot.add(chargeGroup);
        upgradeVisuals.charged_cannons.push(chargeGroup);

        // Cascabel (round knob at the back of the breech)
        const cascabel = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.6, 10, 8),
          ironMat,
        );
        cascabel.position.x = -0.18;
        pitchPivot.add(cascabel);

        // Touch hole on top of the breech
        const touchHole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8),
          ironMat,
        );
        touchHole.position.set(0.06, barrelR * 1.0, 0);
        pitchPivot.add(touchHole);

        // Trunnion caps (the bumps that let the barrel pivot)
        for (const sz of [-1, 1] as const) {
          const trunnion = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 0.45, barrelR * 0.45, 0.16, 10),
            ironMat,
          );
          trunnion.rotation.x = Math.PI * 0.5;
          trunnion.position.set(0.42, 0, sz * (barrelR * 1.25));
          pitchPivot.add(trunnion);
        }

        // Cannon mount (wheeled oak carriage)
        const mount = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.32, 0.55),
          oakMat,
        );
        mount.position.set(0.18, 0.0, 0);
        mount.castShadow = true;
        cg.add(mount);

        // Diagonal step planks on the carriage cheeks
        for (const sz of [-1, 1] as const) {
          const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), oakMat);
          cheek.position.set(0.18, 0.05, sz * 0.305);
          cheek.castShadow = true;
          cg.add(cheek);
        }

        // Carriage wheels — slightly larger
        for (const wz of [-0.27, 0.27] as const) {
          for (const wx of [-0.18, 0.42] as const) {
            const wheel = new THREE.Mesh(
              new THREE.CylinderGeometry(0.18, 0.18, 0.08, 12),
              wheelMat,
            );
            wheel.rotation.x = Math.PI * 0.5;
            wheel.position.set(wx, -0.18, wz);
            wheel.castShadow = true;
            cg.add(wheel);
            // Iron rim
            const rim = new THREE.Mesh(
              new THREE.TorusGeometry(0.18, 0.022, 6, 16),
              ironBandMat,
            );
            rim.rotation.x = Math.PI * 0.5;
            rim.position.set(wx, -0.18, wz);
            cg.add(rim);
          }
        }

        // Lashing rope on the back of the carriage (visual flair)
        const lashing = new THREE.Mesh(
          new THREE.TorusGeometry(0.1, 0.025, 6, 12),
          lashingMat,
        );
        lashing.rotation.y = Math.PI * 0.5;
        lashing.position.set(-0.16, 0.05, 0);
        cg.add(lashing);

        const sideSign = side === 0 ? 1 : -1;
        // Gunports anchored to the REAL loft surface so they neither bury into
        // the tumblehome nor float off the bow taper.
        const portSurf = hullSurfacePointAt(profile, cz, H * 0.58);
        const gunportFrame = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, 0.7, 0.85),
          oakMat,
        );
        gunportFrame.position.set(sideSign * (portSurf.x + 0.045), H * 0.58, cz);
        gunportFrame.rotation.z = sideSign * Math.atan2(portSurf.ny, portSurf.nx) * 0.6;
        gunportFrame.castShadow = true;
        group.add(gunportFrame);
        const gunportOpening = new THREE.Mesh(
          new THREE.BoxGeometry(0.095, 0.46, 0.62),
          holeMat,
        );
        gunportOpening.position.set(sideSign * (portSurf.x + 0.058), H * 0.59, cz);
        gunportOpening.rotation.z = gunportFrame.rotation.z;
        gunportOpening.castShadow = false;
        group.add(gunportOpening);
        // Hinged gunport door, flapped open
        const doorSurf = hullSurfacePointAt(profile, cz, H * 0.86);
        const gunportDoor = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.62), oakMat);
        gunportDoor.position.set(sideSign * (doorSurf.x + 0.06), H * 0.86, cz);
        gunportDoor.rotation.z = sideSign * 0.5;
        gunportDoor.castShadow = true;
        group.add(gunportDoor);

        // Merge rigid geometry per pivot: barrel hardware bakes into ~2 meshes
        // that still swing with the pitch pivot, carriage into a few under root.
        mergeStaticMeshes(chargeGroup, NO_MERGE_EXCLUDE);
        mergeStaticMeshes(pitchPivot, new Set<THREE.Object3D>([chargeGroup]));
        mergeStaticMeshes(cg, new Set<THREE.Object3D>([yawPivot]));

        cg.position.set(sideX, H + 0.18, cz);
        cg.rotation.y = side === 0 ? 0 : Math.PI;
        group.add(cg);
        cannonGroups.push({ root: cg, yawPivot, pitchPivot });
      }
    }

    // ── Barrels on Deck ──────────────────────────────────────
    const barrelConfigs: Array<{ x: number; z: number; color: number; label: string }> = [];

    // Barrel cluster near stern (water/supplies)
    barrelConfigs.push({ x: -W * 0.28, z: -L * 0.28, color: 0x3a6ab0, label: 'water' });
    barrelConfigs.push({ x: -W * 0.28, z: -L * 0.38, color: 0x3a6ab0, label: 'water' });

    // Cannon ordnance — port quarter, away from mast / rigging ring
    barrelConfigs.push({ x: -W * 0.38, z: -L * 0.26, color: 0x282828, label: 'powder' });
    if (cannonCount >= 4) {
      barrelConfigs.push({ x: -W * 0.38, z: -L * 0.36, color: 0x282828, label: 'powder' });
    }
    barrelConfigs.push({ x: -W * 0.3, z: -L * 0.2, color: 0x3a3530, label: 'chain' });

    // Food/banana barrel (gold lid) — forward port, clear of mast
    barrelConfigs.push({ x: -W * 0.32, z: L * 0.18, color: 0xc8a030, label: 'food' });

    // Rum barrel (dark brown lid)
    if (ship.type !== 'sloop') {
      barrelConfigs.push({ x: -W * 0.34, z: -L * 0.32, color: 0x6a2808, label: 'rum' });
    }

    const barrelHoopMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });
    const barrelLidMats = new Map<number, THREE.MeshStandardMaterial>();
    for (const bc of barrelConfigs) {
      let lidMat = barrelLidMats.get(bc.color);
      if (!lidMat) {
        lidMat = new THREE.MeshStandardMaterial({ color: bc.color, roughness: 0.8 });
        barrelLidMats.set(bc.color, lidMat);
      }
      const barrel = makeBarrel(barrelWoodMat, barrelHoopMat, lidMat);
      barrel.position.set(bc.x, H + 0.5, bc.z);
      barrel.rotation.y = Math.random() * Math.PI * 2;
      group.add(barrel);
    }

    // Stacked shot (port quarter with ordnance — not over the main deck / companionway)
    const ballMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.9 });
    const ballPositions = [
      [0, 0], [0.28, 0], [-0.28, 0], [0.14, 0.24], [-0.14, 0.24],
    ];
    const shotRackX = -W * 0.42;
    const shotRackZ = -L * 0.34;
    for (const [bx, by] of ballPositions) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), ballMat);
      ball.position.set(shotRackX + bx * 0.06, H + 0.22 + by, shotRackZ);
      ball.castShadow = true;
      group.add(ball);
    }

    // Rope coil near stern
    const sternRope = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 6, 10), ropeCoilMat);
    sternRope.rotation.x = Math.PI * 0.5;
    sternRope.position.set(W * 0.3, H + 0.155, -L * 0.26);
    group.add(sternRope);

    // ── Lanterns ─────────────────────────────────────────────
    // Warm amber glass (matches the GLB Lantern_Glass palette). ONE shared glass
    // material per ship so every fixture merges into a single controllable mesh
    // whose emissive ramps day→night via setNightFactor().
    const lanternGlassMat = new THREE.MeshStandardMaterial({
      color: 0xffcf87,
      emissive: 0xff9a34,
      emissiveIntensity: 0.15,
      roughness: 0.32,
      metalness: 0.1,
    });
    const lanternGlassMats = [lanternGlassMat];

    const sternLanternPos = new THREE.Vector3(0, H + 0.9, -L * 0.46);
    const lanternMounts: THREE.Vector3[] = [sternLanternPos.clone()];
    if (ship.type === 'sloop') {
      // Mast lantern lashed to the single mast
      lanternMounts.push(new THREE.Vector3(0.16, H + 2.15, mastStartZ + 0.12));
    } else if (ship.type === 'galleon') {
      // Extra lantern by the helm
      lanternMounts.push(new THREE.Vector3(W * 0.22, H + 1.5, -L * 0.3));
    }
    for (const mount of lanternMounts) {
      const fixture = makeLanternFixture(lanternGlassMat, metalMat);
      fixture.position.copy(mount);
      group.add(fixture);
    }

    // ONE warm PointLight per ship, ~9 m reach. Off by day; at night only the
    // nearest handful of ships light it (see update()).
    const nightLight = new THREE.PointLight(0xffb060, 0, 9, 1.6);
    nightLight.position.copy(sternLanternPos);
    nightLight.visible = false;
    group.add(nightLight);
    const lanterns: THREE.PointLight[] = [nightLight];

    // ── Flag ─────────────────────────────────────────────────
    const flagGeo = new THREE.PlaneGeometry(0.85, 0.52);
    const flagMat = new THREE.MeshStandardMaterial({
      color: ship.teamColor,
      emissive: ship.teamColor,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    const topMast = H + SHIP_STATS[ship.type].height * 3;
    flag.position.set(0.42, topMast, mastStartZ);
    group.add(flag);

    // Skull and crossbones on flag (very small detail meshes)
    const skullMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, side: THREE.DoubleSide });
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), skullMat);
    skull.position.set(0.44, topMast + 0.04, mastStartZ);
    group.add(skull);
    for (const boneAngle of [-0.62, 0.62]) {
      const bone = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.035), skullMat);
      bone.position.set(0.44, topMast - 0.07, mastStartZ + 0.002);
      bone.rotation.z = boneAngle;
      group.add(bone);
      for (const end of [-1, 1] as const) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), skullMat);
        knob.position.set(
          0.44 + Math.cos(boneAngle) * end * 0.17,
          topMast - 0.07 + Math.sin(boneAngle) * end * 0.17,
          mastStartZ + 0.004,
        );
        group.add(knob);
      }
    }

    const upgradePennants = {
      hull_reinforcement: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissive: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      charged_cannons: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissive: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      swift_sails: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.swift_sails,
          emissive: UPGRADE_PENNANT_COLORS.swift_sails,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
    } satisfies Record<ShipUpgradeType, THREE.Mesh>;
    const upgradePennantEntries = [
      { type: 'hull_reinforcement' as const, x: 0.34, y: topMast - 0.72, z: mastStartZ + 0.12 },
      { type: 'charged_cannons' as const, x: 0.34, y: topMast - 0.98, z: mastStartZ + 0.02 },
      { type: 'swift_sails' as const, x: 0.34, y: topMast - 1.24, z: mastStartZ - 0.08 },
    ];
    for (const { type, x, y, z } of upgradePennantEntries) {
      const pennant = upgradePennants[type];
      pennant.position.set(x, y, z);
      pennant.visible = false;
      group.add(pennant);
    }

    // Bake all static dressing into one mesh per material — this is where the
    // per-ship draw-call count collapses. Everything animated, tinted or
    // visibility-toggled at runtime is excluded and keeps its own object.
    mergeStaticMeshes(wheelGroup, NO_MERGE_EXCLUDE);
    mergeStaticMeshes(anchor, NO_MERGE_EXCLUDE);
    mergeStaticMeshes(anchorCapstan, new Set<THREE.Object3D>([anchorChain]));
    const mergeExclude = new Set<THREE.Object3D>([
      ...sails,
      ...furledSails,
      ...pennants,
      ...trimPivots,
      ...Object.values(upgradePennants),
      ...Object.values(upgradeVisuals).flat(),
      ...Object.values(hullHoles),
      ...cannonGroups.map((cannon) => cannon.root),
      wheelGroup,
      compassNeedle,
      anchor,
      anchorCapstan,
      holdWater,
    ]);
    mergeStaticMeshes(group, mergeExclude);

    // ── Wake foam ─────────────────────────────────────────────
    // Scene-level (NOT parented to the ship): the old wake quad inherited hull
    // pitch/roll/sinking rotation and reared out of the water as a giant tilted
    // white rectangle. This one follows the Gerstner surface in world space.
    const wake = this.createShipWake();
    this.scene.add(wake.group);

    const detailRoot = new THREE.Group();
    detailRoot.name = 'ship-detail-root';
    while (group.children.length > 0) {
      detailRoot.add(group.children[0]);
    }
    group.add(detailRoot);

    const proxyRoot = this.buildShipProxy(ship, stats, proxySails);
    proxyRoot.visible = false;
    group.add(proxyRoot);

    group.position.set(ship.position.x, ship.position.y, ship.position.z);
    group.rotation.y = ship.rotation;
    this.scene.add(group);

    this.shipMeshes.set(ship.id, {
      root: group,
      detailRoot,
      proxyRoot,
      proxySails,
      sails,
      furledSails,
      pennants,
      upgradePennants,
      upgradeVisuals,
      fireParticles: null,
      hullHoles,
      trimPivots,
      cannonMeshes: cannonGroups,
      lanterns,
      wheel: wheelGroup,
      compassNeedle,
      anchor,
      anchorChain,
      anchorCapstan,
      lanternGlassMats,
      nightLight,
      holdWater,
      holdWaterBase,
      wake,
    });

    return group;
  }

  private addSwiftSailTrim(
    sail: THREE.Mesh,
    width: number,
    height: number,
    targets: THREE.Object3D[],
    staySail = false,
  ) {
    const trimGroup = new THREE.Group();
    trimGroup.name = 'upgrade-swift-sail-trim';
    trimGroup.visible = false;
    const trimMat = new THREE.MeshBasicMaterial({
      color: 0xf9d85b,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x56b7ff,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const addStripe = (
      w: number,
      h: number,
      x: number,
      y: number,
      rotZ = 0,
      material: THREE.Material = trimMat,
    ) => {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
      stripe.position.set(x, y, 0.035);
      stripe.rotation.z = rotZ;
      stripe.renderOrder = 4;
      trimGroup.add(stripe);
    };

    if (staySail) {
      addStripe(width * 0.11, height * 0.78, width * 0.44, height * 0.48, -0.42);
      addStripe(width * 0.08, height * 0.62, width * 0.7, height * 0.42, -0.42, edgeMat);
    } else {
      addStripe(width * 0.055, height * 0.96, -width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.055, height * 0.96, width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.78, height * 0.06, 0, height * 0.43);
      addStripe(width * 0.065, height * 0.92, -width * 0.08, 0, 0.42);
      addStripe(width * 0.065, height * 0.92, width * 0.08, 0, -0.42);
    }

    sail.add(trimGroup);
    targets.push(trimGroup);
  }

  private updateUpgradeVisuals(mesh: ShipMeshGroup, activeUpgrades: Set<ShipUpgradeType>) {
    for (const [type, visuals] of Object.entries(mesh.upgradeVisuals) as Array<[ShipUpgradeType, THREE.Object3D[]]>) {
      const active = activeUpgrades.has(type);
      for (const visual of visuals) visual.visible = active;
    }

    const swift = activeUpgrades.has('swift_sails');
    for (const sail of mesh.sails) this.setSailUpgradeMaterial(sail, swift, false);
    for (const sail of mesh.furledSails) this.setSailUpgradeMaterial(sail, swift, true);
    for (const sail of mesh.proxySails) this.setSailUpgradeMaterial(sail, swift, false);
  }

  private setSailUpgradeMaterial(sail: THREE.Mesh, swift: boolean, furled: boolean) {
    const material = sail.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    material.color.set(swift ? (furled ? 0xd8b954 : 0xffefb2) : 0xf5edd2);
    material.emissive.set(swift ? 0x4c3300 : 0x221a08);
    material.emissiveIntensity = swift ? (furled ? 0.14 : 0.1) : 0.04;
    material.roughness = swift ? 0.48 : 0.62;
  }

  update(
    ships: Ship[],
    players: Player[],
    t: number,
    dt = 1 / 60,
    snapshotAge = 0,
    cameraPosition?: THREE.Vector3,
    localPlayerId?: string,
    storm: ShipStormSource = 0,
  ) {
    this.frameIndex++;
    const wind = this.windOverride ?? sampleWind(t);
    // `t` is already the server-synced ocean clock in Game.ts.
    const waveT = t;
    const positionAlpha = 1 - Math.exp(-18 * dt);
    const rotationAlpha = 1 - Math.exp(-20 * dt);
    const cannonOperators = this.cannonOperators;
    cannonOperators.clear();
    for (const player of players) {
      if (!player.atCannon || !player.onShipId) continue;
      const key = `${player.onShipId}:${player.cannonIndex}`;
      cannonOperators.set(key, player);
    }

    // Night lantern budget: only the nearest few ships get a real PointLight.
    const nightLightIds = this.pickNightLightShips(ships, cameraPosition);
    const lanternEmissive = THREE.MathUtils.lerp(0.15, 2.2, this.nightFactor);

    for (const ship of ships) {
      let mesh = this.shipMeshes.get(ship.id);
      if (!mesh) {
        this.buildShip(ship);
        mesh = this.shipMeshes.get(ship.id)!;
      }

      if (!ship.alive) {
        mesh.root.visible = false;
        mesh.detailRoot.visible = false;
        mesh.proxyRoot.visible = false;
        mesh.wake.group.visible = false;
        continue;
      }

      mesh.root.visible = true;
      const stats = SHIP_STATS[ship.type];
      const activeUpgrades = new Set(ship.upgrades.map(upgrade => upgrade.type));
      this.updateUpgradeVisuals(mesh, activeUpgrades);
      const detailDistance = this.quality === 'low' ? 170 : this.quality === 'balanced' ? 285 : 380;
      const distSq = cameraPosition
        ? (ship.position.x - cameraPosition.x) ** 2 + (ship.position.z - cameraPosition.z) ** 2
        : 0;
      const localCrewShip = !!localPlayerId && ship.crewIds.includes(localPlayerId);
      const detailNear = !cameraPosition || localCrewShip || distSq < detailDistance * detailDistance;
      mesh.detailRoot.visible = detailNear;
      mesh.proxyRoot.visible = !detailNear;
      const extrapolation = Math.min(0.14, snapshotAge + dt * 0.5);
      // Local storm sea-state feeds the SAME boosted Gerstner field the ocean
      // surface uses, so hulls keep riding the visible water inside a storm.
      const storm01 = typeof storm === 'number'
        ? THREE.MathUtils.clamp(storm, 0, 1)
        : getStormWaveIntensity(storm, ship.position.x, ship.position.z);
      // Wave attitude: prefer server-sent pitch/roll/heave while the snapshot is
      // FRESH (they carry non-deterministic wind/turn heel + flood listing), but
      // blend toward the deterministic client Gerstner attitude as it goes stale
      // (>180ms) so rocking never freezes between late snapshots.
      const dyn = ship as Ship & { pitch?: number; roll?: number; heave?: number; waterLevel?: number };
      const serverPitch = typeof dyn.pitch === 'number' && Number.isFinite(dyn.pitch)
        ? THREE.MathUtils.clamp(dyn.pitch, -0.5, 0.5) : null;
      const serverRoll = typeof dyn.roll === 'number' && Number.isFinite(dyn.roll)
        ? THREE.MathUtils.clamp(dyn.roll, -0.6, 0.6) : null;
      const serverHeave = typeof dyn.heave === 'number' && Number.isFinite(dyn.heave)
        ? THREE.MathUtils.clamp(dyn.heave, -2, 2) : null;
      const motion = this.computeWaveMotion(
        ship.position.x, ship.position.z, mesh.root.rotation.y,
        stats.length * 0.5, stats.width * 0.5, waveT, storm01,
      );
      const waterLevel = THREE.MathUtils.clamp(
        typeof dyn.waterLevel === 'number' && Number.isFinite(dyn.waterLevel) ? dyn.waterLevel : 0, 0, 1,
      );
      const staleBlend = THREE.MathUtils.clamp((snapshotAge - 0.18) / 0.04, 0, 1);
      // Client heave pins the hull to the shared wave surface (minus flood
      // freeboard drop) — used when the server residual is missing or stale.
      const clientHeave = THREE.MathUtils.clamp(
        motion.surfaceY - waterLevel * 0.8 - ship.position.y, -2.5, 2.5,
      );
      const basePitch = serverPitch === null ? motion.pitch : THREE.MathUtils.lerp(serverPitch, motion.pitch, staleBlend);
      const baseRoll = serverRoll === null ? motion.roll : THREE.MathUtils.lerp(serverRoll, motion.roll, staleBlend);
      // Flood attitude: settle deeper as the bilge fills and list toward the
      // most-damaged side (up to ~7°) so a breached flank reads at a glance.
      const floodGate = ship.sinking ? 0 : Math.min(1, waterLevel * 2.2);
      const dmg = ship.hull;
      const floodRoll = ((1 - THREE.MathUtils.clamp(dmg.port, 0, 1)) - (1 - THREE.MathUtils.clamp(dmg.starboard, 0, 1))) * 0.122 * floodGate;
      const floodPitch = ((1 - THREE.MathUtils.clamp(dmg.bow, 0, 1)) - (1 - THREE.MathUtils.clamp(dmg.stern, 0, 1))) * 0.06 * floodGate;
      // Visual extra on top of the server's FREEBOARD_DROP (0.8·wl, already in
      // heave): total settle tops out at ~45% of freeboard at full flood.
      const floodSettle = ship.sinking ? 0 : waterLevel * waterLevel * Math.max(0, stats.height * 0.45 - 0.8);
      const heave = ship.sinking
        ? 0
        : (serverHeave === null ? clientHeave : THREE.MathUtils.lerp(serverHeave, clientHeave, staleBlend)) - floodSettle;
      this.tempShipPos.set(
        ship.position.x + ship.velocity.x * extrapolation,
        ship.position.y + heave,
        ship.position.z + ship.velocity.z * extrapolation,
      );
      if (mesh.root.position.distanceToSquared(this.tempShipPos) > 75 * 75) {
        mesh.root.position.copy(this.tempShipPos);
      } else {
        mesh.root.position.lerp(this.tempShipPos, positionAlpha);
      }
      const targetRotation = ship.rotation + ship.angularVelocity * extrapolation;
      mesh.root.rotation.y += angleWrap(targetRotation - mesh.root.rotation.y) * rotationAlpha;
      for (const sail of mesh.proxySails) {
        sail.visible = !detailNear && ship.sailHeight > 0.06;
        sail.rotation.y = THREE.MathUtils.lerp(sail.rotation.y, ship.sailAngle * 0.6, 1 - Math.exp(-8 * dt));
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, Math.max(0.18, ship.sailHeight), 1 - Math.exp(-8 * dt));
      }
      if (!detailNear) {
        const visualSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
        const motionPhase = t * 0.9 + ship.id.charCodeAt(0) * 0.37;
        const steerRoll = THREE.MathUtils.clamp(-ship.angularVelocity * 0.09, -0.05, 0.05);
        const sailLean = THREE.MathUtils.clamp(ship.sailHeight * 0.014 + visualSpeed * 0.0015, 0, 0.035);
        const wavePitch = basePitch + floodPitch + Math.sin(motionPhase) * 0.004;
        const rollTarget = baseRoll + floodRoll + Math.sin(motionPhase * 1.18) * sailLean + steerRoll;
        if (ship.sinking) {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.5, 1 - Math.exp(-4 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.36, 1 - Math.exp(-6 * dt));
          mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 4.5, 1 - Math.exp(-9 * dt));
        } else {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3 * dt));
        }
        this.updateWake(mesh, ship, stats, waveT, dt, false, storm01);
        continue;
      }
      mesh.wheel.rotation.z -= ship.angularVelocity * 0.22;
      mesh.compassNeedle.rotation.y = -mesh.root.rotation.y;

      const anchorRaiseProgress = THREE.MathUtils.clamp(ship.anchorRaiseProgress ?? 0, 0, 1);
      const anchorDrop = ship.anchored ? 1 - anchorRaiseProgress : 0;
      if (ship.anchored && anchorRaiseProgress > 0) {
        mesh.anchorCapstan.rotation.y += dt * (3.6 + anchorRaiseProgress * 4.8);
      } else {
        mesh.anchorCapstan.rotation.y += dt * 0.08;
      }
      const anchorAlpha = 1 - Math.exp(-10 * dt);
      mesh.anchor.position.y = THREE.MathUtils.lerp(
        mesh.anchor.position.y,
        SHIP_STATS[ship.type].height + 0.34 - anchorDrop * 2.75,
        anchorAlpha,
      );
      mesh.anchor.rotation.z = THREE.MathUtils.lerp(mesh.anchor.rotation.z, ship.anchored ? 0.1 * anchorDrop : 0, anchorAlpha);
      // Chain hangs from windlass drum (child of windlass); only length changes
      mesh.anchorChain.scale.y = THREE.MathUtils.lerp(mesh.anchorChain.scale.y, ship.anchored ? 0.52 + anchorDrop * 0.76 : 0.52, anchorAlpha);

      const visualSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
      const motionPhase = t * 0.9 + ship.id.charCodeAt(0) * 0.37;
      const steerRoll = THREE.MathUtils.clamp(-ship.angularVelocity * 0.12, -0.07, 0.07);
      const sailLean = THREE.MathUtils.clamp(ship.sailHeight * 0.018 + visualSpeed * 0.002, 0, 0.045);
      const wavePitch = basePitch + floodPitch + Math.sin(motionPhase) * 0.005;
      const rollTarget = baseRoll + floodRoll + Math.sin(motionPhase * 1.18) * sailLean + steerRoll;

      // Sinking tilt
      if (ship.sinking) {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.6, 1 - Math.exp(-5 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.42, 1 - Math.exp(-8 * dt));
        mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 5, 1 - Math.exp(-11 * dt));
      } else {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3.8 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3.4 * dt));
      }

      // Sail state — keep canvas mostly vertical so it stays visible; tear is subtle
      const rawInt = ship.sailIntegrity ?? 1;
      const sailIntegrity = Number.isFinite(rawInt) ? Math.max(0, Math.min(1, rawInt)) : 1;
      // chainshottedUntil is in server sim seconds; `t` is the server-synced wave clock
      const chainshotted = t < ship.chainshottedUntil;
      const tornPitch = (1 - sailIntegrity) * 0.52 + (chainshotted ? 0.12 : 0);
      const sailAlpha = 1 - Math.exp(-11 * dt);
      // Round-2 field, read defensively: sails luff (flap, depowered) when pointed
      // into the no-go cone. Force the canvas slack so the cloth flutter goes hard.
      const luffing = !!(ship as Ship & { luffing?: boolean }).luffing;
      for (const sail of mesh.sails) {
        sail.visible = ship.sailHeight > 0.05;
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        // 0.92 matches the server's desired-trim constant (PhysicsSystem) so the
        // luff/billow visuals agree with the authoritative sail power.
        const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
        const rawTrimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
        const trimCatch = luffing ? Math.min(rawTrimCatch, 0.08) : rawTrimCatch;
        const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
        // Jibs and other stay-sails have a fixed yaw (centerline of the ship).
        // Square sails brace their whole trim pivot (yard + canvas + furled roll).
        const fixedYaw = sail.userData.fixedYaw;
        const trimPivot = sail.userData.trimPivot as THREE.Group | undefined;
        const targetSailYaw = typeof fixedYaw === 'number' ? fixedYaw : ship.sailAngle;
        const targetSailPitch = tornPitch * (0.55 + 0.15 * Math.sin(t * 0.9 + phaseSeed * 0.2));
        const deployedHeight = Math.max(0.06, ship.sailHeight * Math.max(0.22, sailIntegrity));
        const hoistTopY = typeof sail.userData.hoistTopY === 'number' ? sail.userData.hoistTopY : sail.position.y;
        const hoistHeight = typeof sail.userData.hoistHeight === 'number' ? sail.userData.hoistHeight : 1;
        const hoistCentered = sail.userData.hoistCentered !== false;
        const targetSailY = hoistTopY - hoistHeight * deployedHeight * (hoistCentered ? 0.5 : 1);
        if (trimPivot) {
          // Clamp the visible brace angle — gameplay trim can reach ±86° but a
          // yard braced past ~50° reads broken. The full value still drives physics.
          const visualTrim = THREE.MathUtils.clamp(targetSailYaw, -0.9, 0.9);
          trimPivot.rotation.y += angleWrap(visualTrim - trimPivot.rotation.y) * sailAlpha;
        } else {
          sail.rotation.y += angleWrap(targetSailYaw - sail.rotation.y) * sailAlpha;
        }
        sail.rotation.x = THREE.MathUtils.lerp(sail.rotation.x, targetSailPitch, sailAlpha);
        sail.position.y = THREE.MathUtils.lerp(sail.position.y, targetSailY, sailAlpha);
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, deployedHeight, sailAlpha);
        // Billow puffs the sail outward along its normal — that's the +Z axis in its
        // own local frame (set up at construction). scale.z grows the billow depth.
        const billow = Math.sin(t * 1.2 + phaseSeed * 0.3) * (0.12 + trimCatch * 0.2) * ship.sailHeight * sailIntegrity;
        sail.scale.z = THREE.MathUtils.lerp(sail.scale.z, 1 + billow, sailAlpha);
        if (sail.visible) {
          if (sail.userData.sailKind === 'stay') {
            // Jib has no cloth grid — a leech shiver keeps it alive, stronger when
            // depowered and hardest when luffing.
            const shiver = luffing ? 0.055 : 0.012 + (1 - trimCatch) * 0.028;
            const freq = luffing ? 13.5 : 7.4;
            sail.rotation.z = Math.sin(t * freq + phaseSeed * 0.5) * shiver * ship.sailHeight;
          } else {
            this.updateSailCloth(sail, t, wind.strength, trimCatch, ship.sailHeight, sailIntegrity, luffing);
          }
        }
      }
      for (const furled of mesh.furledSails) {
        furled.visible = ship.sailHeight <= 0.12;
        const furledSeed = typeof furled.userData.phaseSeed === 'number' ? furled.userData.phaseSeed : furled.position.z;
        furled.scale.setScalar(0.88 + Math.sin(t * 0.9 + furledSeed) * 0.015);
      }

      const localWind = angleWrap(wind.direction - ship.rotation);
      for (const pennant of mesh.pennants) {
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 8 + pennant.position.z * 0.14) * 0.12;
        pennant.scale.x = 1.05 + wind.strength * 0.65 + Math.min(0.4, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.03);
      }
      for (const [type, pennant] of Object.entries(mesh.upgradePennants) as Array<[ShipUpgradeType, THREE.Mesh]>) {
        pennant.visible = activeUpgrades.has(type);
        if (!pennant.visible) continue;
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 9.5 + pennant.position.y * 0.3) * 0.18;
        pennant.scale.x = 1.1 + wind.strength * 0.55 + Math.min(0.35, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.025);
      }

      const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
      for (const [index, cannon] of mesh.cannonMeshes.entries()) {
        const operator = cannonOperators.get(`${ship.id}:${index}`);
        if (!detailNear) {
          cannon.root.visible = true;
          continue;
        }
        const localOperatorUsingThisCannon = !!operator && operator.id === localPlayerId;
        const tooCloseToCamera = localOperatorUsingThisCannon
          && !!cameraPosition
          && cannon.root.getWorldPosition(this.tempCannonPos).distanceToSquared(cameraPosition) < 1.35 * 1.35;
        cannon.root.visible = !tooCloseToCamera;
        const broadsideYaw = ship.rotation + (index < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
        const desiredYaw = operator ? angleWrap(operator.rotation.x - broadsideYaw) : 0;
        const desiredPitch = operator ? operator.rotation.y : 0;
        const cannonAlpha = 1 - Math.exp(-18 * dt);
        cannon.yawPivot.rotation.y += angleWrap(desiredYaw - cannon.yawPivot.rotation.y) * cannonAlpha;
        cannon.pitchPivot.rotation.z = THREE.MathUtils.lerp(cannon.pitchPivot.rotation.z, desiredPitch, cannonAlpha);
      }

      // Ship lanterns: warm glass emissive ramps day→night (setNightFactor). At
      // night the nearest few ships also get one real PointLight with fast noise
      // flicker (deliberately NOT a smooth sine — reads like a real flame).
      for (const glassMat of mesh.lanternGlassMats) glassMat.emissiveIntensity = lanternEmissive;
      if (mesh.nightLight) {
        const wantLight = this.nightFactor > 0.02 && nightLightIds.has(ship.id);
        mesh.nightLight.visible = wantLight;
        if (wantLight) {
          const seed = ship.id.charCodeAt(0) * 1.37 + ship.id.charCodeAt(ship.id.length - 1) * 0.53;
          const flicker = 0.8 + 0.2 * this.flickerNoise(t * 9 + seed);
          mesh.nightLight.intensity = this.nightFactor * 1.8 * flicker;
        } else {
          mesh.nightLight.intensity = 0;
        }
      }

      // Animated foam wake ribbon + bow spray, tracking the Gerstner surface
      this.updateWake(mesh, ship, stats, waveT, dt, true, storm01);

      const hullSections = ['bow', 'stern', 'port', 'starboard'] as const;
      for (const s of hullSections) {
        const hp = ship.hull[s];
        const hole = mesh.hullHoles[s];
        hole.visible = hp < 0.92;
        // A section actually floods below the hole threshold — that's when the
        // gush anchor (see getHoleAnchors) should carry water-jet FX.
        hole.userData.floodActive = hp <= FLOODING.HOLE_THRESHOLD;
        // Damage must READ: a fresh hit shows a clear crack, a holed section
        // (hp ≤ 0.5, actively flooding) is a gaping breach.
        const sc = THREE.MathUtils.clamp((1 - hp) * 3.2, 0.4, 2.1);
        hole.scale.setScalar(sc);
      }

      // Water-in-hull: a dark plane rises with the flood level, visible from above
      // through the open companionway / hatch grating. `waterLevel` is a naval-track
      // field (read defensively). Past 0.55 the surface sloshes harder as a spill
      // hint; streaming-water particle FX at the holes is left for the CombatFx pass.
      if (mesh.holdWater && mesh.holdWaterBase) {
        const waterLevel = THREE.MathUtils.clamp(
          (ship as unknown as { waterLevel?: number }).waterLevel ?? 0, 0, 1,
        );
        // The rising water IS the drama: keep it visible through the founder
        // (it used to vanish the instant sinking started), let it climb past
        // the hold and wash OVER the deck planks in the final stage, and
        // slosh harder the fuller the hull gets.
        const sinkLevel = ship.sinking ? 1 : waterLevel;
        const show = sinkLevel > 0.02;
        mesh.holdWater.visible = show;
        if (show) {
          const floorY = 0.5;
          const holdTopY = stats.height - 0.12;
          // 0 → 0.8: fill the hold. 0.8 → 1: break over the deck (deck slab
          // top sits at H + 0.025; +0.09 reads as a sheet of water on deck).
          const awash = THREE.MathUtils.clamp((sinkLevel - 0.8) / 0.2, 0, 1);
          const topY = awash > 0
            ? holdTopY + (stats.height + 0.09 - holdTopY) * awash
            : holdTopY;
          const fillT = Math.min(1, sinkLevel / 0.8);
          mesh.holdWater.position.y = awash > 0 ? topY : floorY + (holdTopY - floorY) * fillT;
          const agitation = 1 + sinkLevel * 1.6 + (ship.sinking ? 0.8 : 0);
          const base = mesh.holdWaterBase;
          const posAttr = mesh.holdWater.geometry.attributes.position as THREE.BufferAttribute;
          const arr = posAttr.array as Float32Array;
          const amp = 0.03 * agitation;
          for (let i = 0; i < posAttr.count; i++) {
            const i3 = i * 3;
            arr[i3 + 1] = base[i3 + 1] + Math.sin(t * (1.8 + agitation) + base[i3] * 1.3 + base[i3 + 2] * 0.9) * amp;
          }
          posAttr.needsUpdate = true;
          const mat = mesh.holdWater.material as THREE.MeshStandardMaterial;
          mat.opacity = 0.82 + 0.12 * Math.min(1, sinkLevel * 1.4);
          // Awash water flashes brighter foam-green so the overwhelm reads at a glance.
          mat.emissiveIntensity = 0.4 + awash * 0.5;
        }
      }

      // Fire visual
      if (ship.onFire && !mesh.fireParticles) {
        mesh.fireParticles = this.createFireParticles();
        mesh.root.add(mesh.fireParticles);
      }
      if (!ship.onFire && mesh.fireParticles) {
        mesh.root.remove(mesh.fireParticles);
        mesh.fireParticles = null;
      }
      if (mesh.fireParticles && detailNear) {
        (mesh.fireParticles.material as THREE.PointsMaterial).size = 0.32 + Math.sin(t * 5) * 0.1;
        const positions = (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 1; i < positions.length; i += 3) {
          positions[i] += 0.05;
          if (positions[i] > 6) positions[i] = 1;
        }
        (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  }

  private createShipWake(): ShipWake {
    const group = new THREE.Group();
    group.name = 'ship-wake';

    // Tapered foam ribbon: WAKE_ROWS rows x 3 columns, positions rewritten
    // every frame in world space along the ship's track.
    const vertCount = WAKE_ROWS * WAKE_COLS;
    const positions = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const uvs = new Float32Array(vertCount * 2);
    const colors = new Float32Array(vertCount * 4);
    for (let row = 0; row < WAKE_ROWS; row++) {
      const jt = row / (WAKE_ROWS - 1);
      const rowAlpha = Math.pow(1 - jt, 1.35);
      for (let col = 0; col < WAKE_COLS; col++) {
        const i = row * WAKE_COLS + col;
        uvs[i * 2] = col / (WAKE_COLS - 1);
        uvs[i * 2 + 1] = jt * 2; // texture tiles twice along the ribbon
        const edge = col === 1 ? 1 : 0.32;
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = rowAlpha * edge;
      }
    }
    const indices: number[] = [];
    for (let row = 0; row < WAKE_ROWS - 1; row++) {
      for (let col = 0; col < WAKE_COLS - 1; col++) {
        const a = row * WAKE_COLS + col;
        const b = a + 1;
        const c = a + WAKE_COLS;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', positions);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geo.setIndex(indices);

    const material = new THREE.MeshBasicMaterial({
      map: this.foamTex.clone(), // per-ship clone so scroll offsets don't fight
      color: 0xcfe9f5,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    material.map!.needsUpdate = true;

    const ribbon = new THREE.Mesh(geo, material);
    ribbon.renderOrder = 2;
    ribbon.frustumCulled = false;
    group.add(ribbon);

    // Bow-spray sprite pool
    const spray: WakeSpray[] = [];
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.sprayTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.visible = false;
      group.add(sprite);
      spray.push({ sprite, velocity: new THREE.Vector3(), life: 0, maxLife: 0.7 });
    }

    group.visible = false;
    return { group, ribbon, positions, material, spray, sprayCursor: 0, sprayTimer: 0, scroll: 0 };
  }

  private updateWake(
    mesh: ShipMeshGroup,
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    waveT: number,
    dt: number,
    detailNear: boolean,
    storm = 0,
  ) {
    const wake = mesh.wake;
    const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
    const speedFrac = THREE.MathUtils.clamp(speed / Math.max(stats.maxSpeed, 0.001), 0, 1);
    const foaming = ship.alive && !ship.sinking && speed > 0.4;
    const targetAlpha = foaming
      ? Math.min(0.85, Math.pow(Math.min(speed / (stats.maxSpeed * 0.2), 1), 0.6) * (0.35 + speedFrac * 0.5))
      : 0;
    wake.material.opacity = THREE.MathUtils.lerp(wake.material.opacity, targetAlpha, 1 - Math.exp(-3.5 * dt));

    let sprayAlive = false;
    for (const p of wake.spray) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      sprayAlive = true;
      p.velocity.y -= 7.5 * dt;
      p.sprite.position.addScaledVector(p.velocity, dt);
      const age = 1 - p.life / p.maxLife;
      const scale = 0.45 + age * 1.6;
      p.sprite.scale.set(scale, scale * 0.8, 1);
      p.sprite.material.opacity = (p.life / p.maxLife) * 0.55;
    }

    wake.group.visible = wake.material.opacity > 0.02 || sprayAlive;
    if (!wake.group.visible) return;

    const W = stats.width;
    const L = stats.length;
    const yaw = mesh.root.rotation.y;
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const latX = Math.cos(yaw), latZ = -Math.sin(yaw);
    const sternX = mesh.root.position.x - fwdX * L * 0.46;
    const sternZ = mesh.root.position.z - fwdZ * L * 0.46;
    const wakeLen = L * (1.1 + speedFrac * 1.5);

    const pos = wake.positions;
    for (let row = 0; row < WAKE_ROWS; row++) {
      const jt = row / (WAKE_ROWS - 1);
      const dist = Math.pow(jt, 1.25) * wakeLen;
      const sway = Math.sin(waveT * 0.9 + jt * 4.2) * W * 0.05 * jt;
      const cx = sternX - fwdX * dist + latX * sway;
      const cz = sternZ - fwdZ * dist + latZ * sway;
      const half = W * (0.14 + jt * (0.42 + 0.42 * speedFrac));
      for (let col = 0; col < WAKE_COLS; col++) {
        const u = col - 1; // -1, 0, 1
        const x = cx + latX * half * u;
        const z = cz + latZ * half * u;
        const y = gerstnerHeight(x, z, waveT, WAVE_PARAMS, storm) + 0.08 + (1 - jt) * 0.04;
        pos.setXYZ(row * WAKE_COLS + col, x, y, z);
      }
    }
    pos.needsUpdate = true;

    // Scroll foam toward the tail so blobs read as staying put in the water
    wake.scroll = (wake.scroll - (speed * dt) / Math.max(wakeLen, 1)) % 1;
    wake.material.map!.offset.y = wake.scroll;

    // Bow spray bursts once the ship is really driving
    if (detailNear && foaming && speedFrac > 0.4) {
      wake.sprayTimer -= dt;
      if (wake.sprayTimer <= 0) {
        wake.sprayTimer = 0.12 / (0.4 + speedFrac);
        const bowX = mesh.root.position.x + fwdX * L * 0.5;
        const bowZ = mesh.root.position.z + fwdZ * L * 0.5;
        const bowY = gerstnerHeight(bowX, bowZ, waveT, WAVE_PARAMS, storm) + 0.25;
        for (const side of [-1, 1] as const) {
          const p = wake.spray[wake.sprayCursor];
          wake.sprayCursor = (wake.sprayCursor + 1) % wake.spray.length;
          p.maxLife = 0.5 + Math.random() * 0.35;
          p.life = p.maxLife;
          p.sprite.visible = true;
          p.sprite.position.set(
            bowX + latX * side * W * 0.32,
            bowY,
            bowZ + latZ * side * W * 0.32,
          );
          p.velocity.set(
            latX * side * (1.1 + Math.random() * 1.2) + fwdX * speed * 0.35,
            1.7 + Math.random() * 1.3 + speedFrac,
            latZ * side * (1.1 + Math.random() * 1.2) + fwdZ * speed * 0.35,
          );
          p.sprite.scale.set(0.45, 0.36, 1);
          p.sprite.material.opacity = 0.55;
        }
      }
    }
  }

  /** Samples the shared (storm-aware) Gerstner field at bow/stern/port/starboard
   *  plus center to derive hull attitude coherent with the visible ocean. Clamps
   *  match the server's spring-damped attitude (±0.45 / ±0.55) so blending from
   *  stale server values into this fallback is seamless. */
  private computeWaveMotion(x: number, z: number, yaw: number, halfL: number, halfW: number, waveT: number, storm = 0) {
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const latX = Math.cos(yaw), latZ = -Math.sin(yaw);
    const hBow = gerstnerHeight(x + fwdX * halfL, z + fwdZ * halfL, waveT, WAVE_PARAMS, storm);
    const hStern = gerstnerHeight(x - fwdX * halfL, z - fwdZ * halfL, waveT, WAVE_PARAMS, storm);
    const hRight = gerstnerHeight(x + latX * halfW, z + latZ * halfW, waveT, WAVE_PARAMS, storm);
    const hLeft = gerstnerHeight(x - latX * halfW, z - latZ * halfW, waveT, WAVE_PARAMS, storm);
    const out = this.waveMotion;
    // rotation.x > 0 dips the bow (local +z), so pitch follows stern-minus-bow
    out.pitch = THREE.MathUtils.clamp(Math.atan2(hStern - hBow, 2 * halfL) * 0.85, -0.45, 0.45);
    out.roll = THREE.MathUtils.clamp(Math.atan2(hRight - hLeft, 2 * halfW) * 0.7, -0.55, 0.55);
    // Wave surface height at the hull center — the heave target the mesh should
    // ride when the server residual is stale or missing.
    out.surfaceY = gerstnerHeight(x, z, waveT, WAVE_PARAMS, storm);
    return out;
  }

  /** Cheap 1-D value noise in [0,1): smoothstep-interpolated hashes of the integer
   *  lattice. Used for lantern flame flicker — chaotic, not a periodic sine. */
  private flickerNoise(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const hash = (n: number) => {
      const s = Math.sin(n * 127.1) * 43758.5453;
      return s - Math.floor(s);
    };
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }

  /** Light budget: returns the ids of the nearest (up to 6) alive ships to the
   *  camera that should receive a real PointLight at night. Empty by day. */
  private pickNightLightShips(ships: Ship[], cam?: THREE.Vector3): Set<string> {
    const set = new Set<string>();
    if (this.nightFactor <= 0.02) return set;
    const alive = ships.filter((s) => s.alive);
    if (cam) {
      alive.sort((a, b) =>
        ((a.position.x - cam.x) ** 2 + (a.position.z - cam.z) ** 2) -
        ((b.position.x - cam.x) ** 2 + (b.position.z - cam.z) ** 2));
    }
    for (let i = 0; i < Math.min(6, alive.length); i++) set.add(alive[i].id);
    return set;
  }

  /** CPU cloth: traveling wind ripple plus hard luff flutter when the sail is
   *  depowered (trim far from the wind). Displaces the low-vert sail plane
   *  along its billow normal; the yard-attached top edge stays pinned. */
  private updateSailCloth(
    sail: THREE.Mesh,
    t: number,
    windStrength: number,
    trimCatch: number,
    sailHeight: number,
    sailIntegrity: number,
    luffing = false,
  ) {
    const base = sail.userData.clothBase as Float32Array | undefined;
    if (!base) return;
    const w = sail.userData.clothW as number;
    const h = sail.userData.clothH as number;
    const minDim = Math.min(w, h);
    const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
    const phase = phaseSeed * 0.7 + sail.position.y * 0.31;
    const rippleAmp = (0.012 + 0.02 * windStrength) * minDim * sailHeight;
    const depower = 1 - trimCatch;
    // Luffing hits the whole sail (not just the leech) with a fast, deep flap.
    const luffGain = luffing ? 0.14 : 0.055;
    const luffFreq = luffing ? 16.5 : 11.5;
    const luffAmp = Math.min(0.55, depower * depower * luffGain * minDim) * sailHeight * (0.4 + 0.6 * sailIntegrity);
    if (rippleAmp < 0.001 && luffAmp < 0.001) return;

    const posAttr = sail.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const invH = 1 / Math.max(h, 0.001);
    for (let i = 0; i < posAttr.count; i++) {
      const i3 = i * 3;
      const x = base[i3];
      const y = base[i3 + 1];
      const nyTop = (y + h * 0.5) * invH; // 1 at the yard, 0 at the foot
      const pin = 1 - nyTop * nyTop;
      const ripple = Math.sin(t * 2.7 + x * 0.85 + y * 0.55 + phase) * rippleAmp;
      const luff = Math.sin(t * luffFreq + x * 2.7 + phase * 1.7) * luffAmp;
      arr[i3 + 2] = base[i3 + 2] + (ripple + luff) * pin;
    }
    posAttr.needsUpdate = true;
    // Normal recompute is the expensive half of the cloth sim and the low-amp
    // ripple barely moves them — refresh every 3rd frame, staggered per sail.
    if ((this.frameIndex + sail.id) % 3 === 0) {
      sail.geometry.computeVertexNormals();
    }
  }

  private createFireParticles(): THREE.Points {
    const count = 50;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 3.2;
      pos[i * 3 + 1] = Math.random() * 3.5 + 1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xFF6600, size: 0.32, sizeAttenuation: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    return new THREE.Points(geo, mat);
  }

  getShipGroup(shipId: string): THREE.Group | null {
    return this.shipMeshes.get(shipId)?.root ?? null;
  }

  /** Hole-decal FX attach points on the REAL hull surface. Each hull section
   *  exposes an empty Object3D (child of the rendered ship, so world transform
   *  follows heave/pitch/roll) oriented outward along the surface normal.
   *  `belowWaterline` marks holes on the waterline band (water-gush candidates);
   *  `active` is true while the section is holed below the flood threshold.
   *  Game.ts can hang gush/leak particle FX on these via getWorldPosition(). */
  getHoleAnchors(shipId: string): Array<{
    section: 'bow' | 'stern' | 'port' | 'starboard';
    anchor: THREE.Object3D;
    belowWaterline: boolean;
    active: boolean;
  }> {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh) return [];
    const out: Array<{
      section: 'bow' | 'stern' | 'port' | 'starboard';
      anchor: THREE.Object3D;
      belowWaterline: boolean;
      active: boolean;
    }> = [];
    for (const section of ['bow', 'stern', 'port', 'starboard'] as const) {
      const hole = mesh.hullHoles[section];
      const anchor = hole.userData.gushAnchor as THREE.Object3D | undefined;
      if (!anchor) continue;
      out.push({
        section,
        anchor,
        belowWaterline: !!hole.userData.belowWaterline,
        active: !!hole.userData.floodActive && hole.visible,
      });
    }
    return out;
  }

  getCannonWorldPos(shipId: string, cannonIndex: number): THREE.Vector3 | null {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh || cannonIndex >= mesh.cannonMeshes.length) return null;
    const pos = new THREE.Vector3();
    mesh.cannonMeshes[cannonIndex].root.getWorldPosition(pos);
    return pos;
  }
}
