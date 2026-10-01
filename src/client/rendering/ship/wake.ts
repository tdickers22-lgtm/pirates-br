import * as THREE from 'three';
import { gerstnerHeight, WAVE_PARAMS } from '../../../shared/utils/index.js';
import type { HullProfile } from '../../../shared/hull.js';
import { makeWaterlineFoamGeometry } from './geometry.js';

/**
 * WAKE — SHIPVIS-01 phase B.
 *
 * WHAT WAS THERE. One tapered ribbon, nine rows by three columns, laid along
 * the ship's own track astern of the transom. That is the turbulent stern
 * wake and nothing else: a hull under sail drew a single straight smear of
 * foam behind her and no mark at all on the water either side of the bow. From
 * any camera above the deck the sea read as flat until the smear started, and
 * two hulls converging left two parallel stripes that never interacted with
 * the shape of the water at all.
 *
 * WHAT IT IS NOW. The same stern ribbon, vertex for vertex, plus the two
 * things a displacement hull actually leaves behind:
 *
 *   - the KELVIN ARMS. A hull moving through deep water throws a wedge of
 *     divergent waves whose half-angle is arcsin(1/3) = 19.47 degrees, and
 *     that angle is the same for every hull at every speed — it is set by the
 *     dispersion of deep-water gravity waves, not by the boat. So the arms are
 *     built at exactly that angle from the ship's track, springing from the bow
 *     shoulders and trailing aft, and they widen with speed only in LENGTH,
 *     never in angle. A sloop and a galleon leave the same wedge.
 *   - the BOW SHEETS. The short, bright sheet of water peeled off each bow
 *     shoulder, at a wider angle and a third of the length, brightest where it
 *     leaves the planking.
 *
 * WHAT IT COSTS ON THE LOW TIER. Nothing. The arms and the sheets are not
 * built at all when `quality === 'low'`: `buildWakeSurface` returns the same
 * 27 vertices and 96 indices it returned before this lane, and `hasArms` is
 * false. On balanced and high they add 40 vertices and 32 triangles per ship —
 * 384 triangles for a full twelve-hull Solo match — and, deliberately, ZERO
 * draw calls: the arms and sheets live in the SAME BufferGeometry and the same
 * index buffer as the stern ribbon, ordered after it, so the wake is one draw
 * exactly as it was before.
 *
 * HOW IT FADES WITHOUT POPPING. Two ramps multiply into one `armFactor`
 * (0..1), and that factor scales the arm and sheet HALF-WIDTHS. At factor 0
 * every arm quad is degenerate — zero area, therefore zero fill — so there is
 * no frame on which a wedge appears or vanishes as a visible edge. The caller
 * ramps it down with distance (reaching 0 before the hull's detail range ends)
 * and with speed (a hull barely making way leaves no wedge). Only once the
 * factor is at the floor does the caller call `setArmsVisible(surface, false)`,
 * which drops the index range back to the stern ribbon so the degenerate
 * triangles are not even submitted — and that switch is invisible precisely
 * because it happens when the arms are already zero-area.
 *
 * NO PER-FRAME ALLOCATION. `writeWakeSurface` writes through the position
 * attribute the surface was built with and allocates nothing; the static UV and
 * colour attributes are written once at build time and never touched again.
 */

/** Stern ribbon, unchanged from before this lane: 9 rows x 3 columns. */
export const WAKE_ROWS = 9;
export const WAKE_COLS = 3;

/**
 * arcsin(1/3) = 0.3398 rad = 19.47 degrees. The Kelvin wedge half-angle for
 * deep-water gravity waves. It is a constant of the water, not of the hull, so
 * nothing here is allowed to scale it with speed or with ship class.
 */
export const KELVIN_HALF_ANGLE = Math.asin(1 / 3);
/** The bow sheet peels off much wider than the wedge and dies much sooner. */
export const BOW_SHEET_ANGLE = 0.70;

const ARM_ROWS = 7;
const ARM_COLS = 2;
const SHEET_ROWS = 3;
const SHEET_COLS = 2;

const CENTRE_VERTS = WAKE_ROWS * WAKE_COLS;
const ARM_VERTS = ARM_ROWS * ARM_COLS;
const SHEET_VERTS = SHEET_ROWS * SHEET_COLS;
/** Vertex block offsets: [centre][arm -1][arm +1][sheet -1][sheet +1]. */
export const ARM_VERTEX_OFFSET = CENTRE_VERTS;
export const SHEET_VERTEX_OFFSET = CENTRE_VERTS + ARM_VERTS * 2;
export const WAKE_VERTS_WITH_ARMS = SHEET_VERTEX_OFFSET + SHEET_VERTS * 2;

/**
 * Below this the caller may drop the arms out of the draw range. It is set so
 * that AT the floor the ribbons are already a fifth of a millimetre wide — far
 * under a pixel at any range a ship is visible from — because the whole
 * no-pop argument rests on the arms being invisible before they stop being
 * submitted, not on the moment they stop being submitted.
 */
export const ARM_FACTOR_FLOOR = 1e-4;

export interface WakeSurface {
  geometry: THREE.BufferGeometry;
  positions: THREE.BufferAttribute;
  /** False on the low tier: the arms and sheets were never allocated. */
  hasArms: boolean;
  /** Index count of the stern ribbon alone — the low-tier / far-LOD draw range. */
  centreIndexCount: number;
  totalIndexCount: number;
}

/** Everything `writeWakeSurface` needs, as a caller-owned object it fills in
 *  place each frame. Primitives only, so driving the wake allocates nothing. */
export interface WakeFrame {
  sternX: number; sternZ: number;
  bowX: number; bowZ: number;
  fwdX: number; fwdZ: number;
  latX: number; latZ: number;
  width: number; length: number;
  speedFrac: number;
  waveT: number;
  storm: number;
  /** 0..1. Scales the arm and sheet half-widths; 0 collapses them. */
  armFactor: number;
}

export function makeWakeFrame(): WakeFrame {
  return {
    sternX: 0, sternZ: 0, bowX: 0, bowZ: 0, fwdX: 0, fwdZ: 1, latX: 1, latZ: 0,
    width: 1, length: 1, speedFrac: 0, waveT: 0, storm: 0, armFactor: 0,
  };
}

/**
 * Builds the wake's one geometry. The stern ribbon occupies vertices
 * [0, CENTRE_VERTS) and the FIRST `centreIndexCount` indices, so a draw range
 * clamped to that count draws exactly the pre-lane wake and touches no arm
 * vertex — which is what makes the far LOD and the low tier free.
 */
export function buildWakeSurface(quality: 'low' | 'balanced' | 'high'): WakeSurface {
  const withArms = quality !== 'low';
  const vertCount = withArms ? WAKE_VERTS_WITH_ARMS : CENTRE_VERTS;

  const positions = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 4);

  // ── Stern ribbon: byte-identical to the pre-lane build ──────────────
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
  const centreIndexCount = indices.length;

  if (withArms) {
    // ── Kelvin arms ──────────────────────────────────────────────────
    // Column 0 is the INBOARD edge and carries the crest; column 1 feathers
    // out so the wedge has no hard border against the sea.
    for (let s = 0; s < 2; s++) {
      const base = ARM_VERTEX_OFFSET + s * ARM_VERTS;
      for (let row = 0; row < ARM_ROWS; row++) {
        const t = row / (ARM_ROWS - 1);
        // Fade in over the first quarter so the arm does not begin with a cut
        // end at the bow, and out along its length.
        const along = Math.min(1, t * 4) * Math.pow(1 - t, 1.1);
        for (let col = 0; col < ARM_COLS; col++) {
          const i = base + row * ARM_COLS + col;
          uvs[i * 2] = col;
          uvs[i * 2 + 1] = t * 3;
          colors[i * 4] = 1; colors[i * 4 + 1] = 1; colors[i * 4 + 2] = 1;
          colors[i * 4 + 3] = along * (col === 0 ? 0.85 : 0.12);
        }
      }
      for (let row = 0; row < ARM_ROWS - 1; row++) {
        const a = base + row * ARM_COLS;
        indices.push(a, a + 1, a + ARM_COLS, a + 1, a + ARM_COLS + 1, a + ARM_COLS);
      }
    }
    // ── Bow sheets ───────────────────────────────────────────────────
    for (let s = 0; s < 2; s++) {
      const base = SHEET_VERTEX_OFFSET + s * SHEET_VERTS;
      for (let row = 0; row < SHEET_ROWS; row++) {
        const t = row / (SHEET_ROWS - 1);
        const along = Math.pow(1 - t, 0.9);
        for (let col = 0; col < SHEET_COLS; col++) {
          const i = base + row * SHEET_COLS + col;
          uvs[i * 2] = col;
          uvs[i * 2 + 1] = t;
          colors[i * 4] = 1; colors[i * 4 + 1] = 1; colors[i * 4 + 2] = 1;
          colors[i * 4 + 3] = along * (col === 0 ? 1 : 0.25);
        }
      }
      for (let row = 0; row < SHEET_ROWS - 1; row++) {
        const a = base + row * SHEET_COLS;
        indices.push(a, a + 1, a + SHEET_COLS, a + 1, a + SHEET_COLS + 1, a + SHEET_COLS);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', positions);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.setDrawRange(0, centreIndexCount);

  return { geometry, positions, hasArms: withArms, centreIndexCount, totalIndexCount: indices.length };
}

/** Drops the arm and sheet indices out of the draw (or puts them back). A no-op
 *  on the low tier, where they were never built. */
export function setArmsVisible(surface: WakeSurface, on: boolean): void {
  const want = on && surface.hasArms ? surface.totalIndexCount : surface.centreIndexCount;
  const range = surface.geometry.drawRange;
  if (range.count !== want) surface.geometry.setDrawRange(0, want);
}

/**
 * Rewrites every wake vertex in WORLD space for this frame. The stern ribbon's
 * maths is unchanged from before this lane; the arms and sheets are appended.
 */
export function writeWakeSurface(surface: WakeSurface, f: WakeFrame): void {
  const pos = surface.positions;
  const W = f.width, L = f.length;

  // ── Stern ribbon (unchanged) ────────────────────────────────────────
  const wakeLen = L * (1.1 + f.speedFrac * 1.5);
  for (let row = 0; row < WAKE_ROWS; row++) {
    const jt = row / (WAKE_ROWS - 1);
    const dist = Math.pow(jt, 1.25) * wakeLen;
    const sway = Math.sin(f.waveT * 0.9 + jt * 4.2) * W * 0.05 * jt;
    const cx = f.sternX - f.fwdX * dist + f.latX * sway;
    const cz = f.sternZ - f.fwdZ * dist + f.latZ * sway;
    const half = W * (0.14 + jt * (0.42 + 0.42 * f.speedFrac));
    for (let col = 0; col < WAKE_COLS; col++) {
      const u = col - 1; // -1, 0, 1
      const x = cx + f.latX * half * u;
      const z = cz + f.latZ * half * u;
      const y = gerstnerHeight(x, z, f.waveT, WAVE_PARAMS, f.storm) + 0.08 + (1 - jt) * 0.04;
      pos.setXYZ(row * WAKE_COLS + col, x, y, z);
    }
  }

  if (!surface.hasArms) { pos.needsUpdate = true; return; }

  // Nothing to write when the wedge is collapsed: the caller has already
  // dropped it out of the draw range, and the stale positions behind it are
  // therefore not submitted.
  if (f.armFactor <= ARM_FACTOR_FLOOR) { pos.needsUpdate = true; return; }

  writeFan(
    pos, ARM_VERTEX_OFFSET, ARM_VERTS, ARM_ROWS, f,
    KELVIN_HALF_ANGLE,
    L * (1.0 + f.speedFrac * 1.9), // the wedge lengthens with speed; it never widens
    W * 0.30, L * 0.06, 1.15, 0.09, 0.55, 0.9, 0.07,
  );
  writeFan(
    pos, SHEET_VERTEX_OFFSET, SHEET_VERTS, SHEET_ROWS, f,
    BOW_SHEET_ANGLE,
    L * 0.30 * (0.5 + f.speedFrac),
    W * 0.22, L * 0.04, 1.0, 0.11, 0.5, 0.7, 0.10,
  );
  pos.needsUpdate = true;
}

/**
 * Writes one mirrored pair of two-column ribbons springing from the bow at
 * `angle` off the ship's track. Shared by the Kelvin arms and the bow sheets
 * because they differ only in angle, length and width — the frame maths is the
 * same, and one copy of it is one place for a sign error to live.
 */
function writeFan(
  pos: THREE.BufferAttribute,
  offset: number, vertsPerSide: number, rows: number,
  f: WakeFrame,
  angle: number, len: number, rootOffset: number, rootAft: number,
  distExp: number, widthScale: number, widthBase: number, widthGain: number,
  lift: number,
): void {
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const base = offset + s * vertsPerSide;
    // Unit normal of the ribbon's own direction, in XZ. Perpendicular to
    // (-fwd*cosA + lat*side*sinA) and pointing outboard.
    const nx = f.fwdX * sinA + f.latX * side * cosA;
    const nz = f.fwdZ * sinA + f.latZ * side * cosA;
    for (let row = 0; row < rows; row++) {
      const t = row / (rows - 1);
      // `rootAft` springs the ribbon from the bow SHOULDER rather than the very
      // stem: physically where the water actually parts, and it also keeps the
      // ribbon's outboard edge from reaching ahead of water the ship has not
      // touched yet (the perpendicular has a forward component of sin(angle)).
      const d = Math.pow(t, distExp) * len;
      const ax = f.bowX - f.fwdX * (d * cosA + rootAft) + f.latX * side * (d * sinA + rootOffset);
      const az = f.bowZ - f.fwdZ * (d * cosA + rootAft) + f.latZ * side * (d * sinA + rootOffset);
      const halfW = f.width * widthScale * (widthBase + t * widthGain) * f.armFactor;
      for (let col = 0; col < 2; col++) {
        const off = col === 0 ? -halfW : halfW;
        const x = ax + nx * off;
        const z = az + nz * off;
        const y = gerstnerHeight(x, z, f.waveT, WAVE_PARAMS, f.storm) + lift + (1 - t) * 0.03;
        pos.setXYZ(base + row * 2 + col, x, y, z);
      }
    }
  }
}

// ── WATERLINE COLLAR v2 (b4.2e, ships-04) ────────────────────────────────────
// The old collar was a constant max(0.55, 0.16 W) = 0.8-1.6 m cream apron round
// a hull that was not moving, gilded on the own ship, and it read as a sand
// tray or a raft at a berth. Now its width is driven per ring vertex by speed
// and the local wave slope: a thin broken lapping line at rest (0.15-0.25 m),
// a bow wave that grows to a quarter of the beam on the bow sector at full
// speed (with the inner edge climbing the stem), and a stern wash aft. Own-ship
// identity moved to the plank shader's gold edge and the pennant.

/** Rest width of the collar on flat water and on the steepest slope, metres. */
export const COLLAR_REST_MIN = 0.15;
export const COLLAR_REST_MAX = 0.25;
/** Bow-sector width at full speed, as a fraction of the beam (spec >= 0.2 W). */
export const COLLAR_BOW_BEAM = 0.25;
/** Stern-wash width at full speed, as a fraction of the beam. */
export const COLLAR_STERN_BEAM = 0.16;
/** Side (amidships) growth at full speed, metres. */
export const COLLAR_SIDE_SPEED = 0.3;
/** How far the bow wave climbs the stem at full speed, metres. */
export const COLLAR_BOW_RISE = 0.14;

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Collar width (m) at a ring vertex. bow01/stern01: sector weights, speed01:
 *  speed / class top speed, slope: local |dh/dx| of the sea, beam: hull W. */
export function collarWidth(bow01: number, stern01: number, speed01: number, slope: number, beam: number): number {
  const s = Math.min(1, Math.max(0, speed01));
  const rest = COLLAR_REST_MIN + (COLLAR_REST_MAX - COLLAR_REST_MIN) * Math.min(1, Math.max(0, slope / 0.35));
  // Sector weights saturate at 0.6 so the whole bow sector (weight >= 0.5)
  // carries at least 0.83 of the full bow wave.
  const bow = Math.min(1, bow01 / 0.6), stern = Math.min(1, stern01 / 0.6);
  const run = Math.max(bow * COLLAR_BOW_BEAM * beam, stern * COLLAR_STERN_BEAM * beam, COLLAR_SIDE_SPEED);
  return rest + run * s * s * (3 - 2 * s) * (s > 0 ? 1 : 0);
}

interface CollarData {
  inner: Float32Array; // ring xz (hull-local)
  dir: Float32Array; // outward unit xz
  bow: Float32Array; // bow-sector weight
  stern: Float32Array; // stern-sector weight
  slope: Float32Array; // last frame's measured slope
  widths: Float32Array; // last written width per ring vertex
  beam: number;
}

/** Build the collar: the same ring as before (makeWaterlineFoamGeometry), but
 *  the outer edge is re-placed every frame at collarWidth along the outward dir. */
export function buildWaterlineCollar(profile: HullProfile, map: THREE.Texture | null): THREE.Mesh {
  const geo = makeWaterlineFoamGeometry(profile, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count / 2;
  const d: CollarData = {
    inner: new Float32Array(n * 2), dir: new Float32Array(n * 2), bow: new Float32Array(n),
    stern: new Float32Array(n), slope: new Float32Array(n), widths: new Float32Array(n), beam: profile.W,
  };
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) { const z = pos.getZ(2 * i); zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
  for (let i = 0; i < n; i++) {
    const ix = pos.getX(2 * i), iz = pos.getZ(2 * i);
    d.inner[2 * i] = ix; d.inner[2 * i + 1] = iz;
    d.dir[2 * i] = pos.getX(2 * i + 1) - ix; d.dir[2 * i + 1] = pos.getZ(2 * i + 1) - iz;
    const t = (iz - zMin) / Math.max(1e-6, zMax - zMin); // 0 transom -> 1 stem
    d.bow[i] = sstep(0.62, 0.9, t);
    d.stern[i] = 1 - sstep(0.06, 0.3, t);
    d.widths[i] = COLLAR_REST_MIN;
  }
  geo.userData.collar = d;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  mesh.name = 'waterline-foam';
  mesh.renderOrder = 2;
  return mesh;
}

/** Last-written collar widths (one per ring vertex) and the bow/stern weights. */
export function collarState(mesh: THREE.Mesh): { widths: Float32Array; bow: Float32Array; stern: Float32Array; beam: number } {
  const d = mesh.geometry.userData.collar as CollarData;
  return { widths: d.widths, bow: d.bow, stern: d.stern, beam: d.beam };
}

/**
 * Seat the collar for this frame: yaw-only frame (cancel pitch/roll, Euler
 * 'ZXY', ships-01; sign-agnostic, so the b2 heel sign cannot invert it), widths
 * from speed and the slope measured across the collar last frame, every vertex
 * lifted onto the LOCAL Gerstner surface, the inner edge raised on the bow at speed.
 */
export function seatWaterlineCollar(
  foam: THREE.Mesh, root: THREE.Object3D, waveT: number, storm01: number, speed01: number,
): void {
  foam.rotation.set(-root.rotation.x, 0, -root.rotation.z, 'ZXY');
  if (!foam.visible) return;
  const d = foam.geometry.userData.collar as CollarData | undefined;
  if (!d) return;
  const pos = foam.geometry.attributes.position as THREE.BufferAttribute;
  const cy = Math.cos(root.rotation.y), sy = Math.sin(root.rotation.y);
  const n = d.bow.length;
  const s = Math.min(1, Math.max(0, speed01));
  for (let i = 0; i < n; i++) {
    const w = collarWidth(d.bow[i], d.stern[i], s, d.slope[i], d.beam);
    d.widths[i] = w;
    const ix = d.inner[2 * i], iz = d.inner[2 * i + 1];
    const ox = ix + d.dir[2 * i] * w, oz = iz + d.dir[2 * i + 1] * w;
    const hIn = gerstnerHeight(root.position.x + ix * cy + iz * sy, root.position.z - ix * sy + iz * cy, waveT, WAVE_PARAMS, storm01);
    const hOut = gerstnerHeight(root.position.x + ox * cy + oz * sy, root.position.z - ox * sy + oz * cy, waveT, WAVE_PARAMS, storm01);
    d.slope[i] = Math.abs(hOut - hIn) / w;
    pos.setXYZ(2 * i, ix, hIn - root.position.y + 0.035 + COLLAR_BOW_RISE * d.bow[i] * s, iz);
    pos.setXYZ(2 * i + 1, ox, hOut - root.position.y + 0.005, oz);
  }
  pos.needsUpdate = true;
}
