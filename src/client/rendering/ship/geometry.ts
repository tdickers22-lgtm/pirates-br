// SHIP GEOMETRY — everything lofted from the shared hull stations (shell,
// strakes, waterline collar, companionway ramp, sail cloth) plus the static
// merge helpers. Extracted verbatim from ShipRenderer (codehealth-03 phase 1,
// HULLGEO-01 slice a); scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullSurfacePointAt, hullUvV, sampleHullSurface, stationSurfaceAt } from '../../../shared/hull.js';
import { HULL_TIER_GRID } from './lod.js';
import type { HullProfile, HullProfileStation } from '../../../shared/hull.js';

/** Axis a CylinderGeometry is built along, for makeCylinderBetween. */
export const CYLINDER_UP = new THREE.Vector3(0, 1, 0);

/** Waterline contact collar: a flat ribbon hugging the hull's own waterline
 *  outline (the loft's y = 0 slot) and fanning outward `width` metres.
 *  Textured with a soft inner-bright / outer-transparent ramp, this is the
 *  wet-edge foam that tells the eye the hull is IN the water. Without it a
 *  correctly-drafted hull still reads as pasted on top of the surface: the
 *  ocean simply clips the shell with a hard silhouette and the hull's own
 *  shadow underneath sells "air gap" (the floating-props P1 read).
 *  UV: u runs bow→stern→bow (foam scroll), v = 0 at the hull, 1 at the fringe. */
export function makeWaterlineFoamGeometry(profile: HullProfile, width: number): THREE.BufferGeometry {
  const sts = profile.stations;
  const SEG = 12; // samples per station gap, per side
  const ring: Array<{ x: number; z: number }> = [];
  // Starboard bow→stern, then port stern→bow: one closed loop.
  for (let side = 0 as 0 | 1; side <= 1; side++) {
    const forward = side === 0;
    for (let i = 0; i < sts.length - 1; i++) {
      const a = forward ? sts[sts.length - 1 - i] : sts[i];
      const b = forward ? sts[sts.length - 2 - i] : sts[i + 1];
      const sa = stationSurfaceAt(a, 0);
      const sb = stationSurfaceAt(b, 0);
      for (let s = 0; s < SEG; s++) {
        const t = s / SEG;
        const sx = side === 0 ? 1 : -1;
        ring.push({
          x: sx * (sa.x + (sb.x - sa.x) * t),
          z: sa.z + (sb.z - sa.z) * t,
        });
      }
    }
  }
  const n = ring.length;
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // Outward normal of a counter-clockwise loop in XZ.
    let nx = tz, nz = -tx;
    if (nx * p.x + nz * p.z < 0) { nx = -nx; nz = -nz; }
    const u = (i / n) * 6;
    verts.push(p.x, 0.035, p.z);
    uvs.push(u, 0);
    verts.push(p.x + nx * width, 0.005, p.z + nz * width);
    uvs.push(u, 1);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1;
    const c = ((i + 1) % n) * 2, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Ship-local XZ per vertex + its rest height above the waterline plane: the
  // renderer re-lifts every vertex onto the LOCAL Gerstner surface each frame,
  // so the collar rides the same swell the ocean draws instead of being buried
  // by the first wave crest that rolls past the hull.
  const baseXZ = new Float32Array(verts.length / 3 * 2);
  const rest = new Float32Array(verts.length / 3);
  for (let i = 0; i < verts.length / 3; i++) {
    baseXZ[i * 2] = verts[i * 3];
    baseXZ[i * 2 + 1] = verts[i * 3 + 2];
    rest[i] = verts[i * 3 + 1];
  }
  geo.userData.baseXZ = baseXZ;
  geo.userData.rest = rest;
  return geo;
}

/** Soft foam ramp: bright wet edge against the planking, feathering out into
 *  clear water, with a little streaky noise so it is not a clean airbrush. */
export function makeWaterlineFoamTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 64);
  for (let y = 0; y < 64; y++) {
    const v = y / 63;
    // Bright band right at the hull, decaying to nothing at the fringe.
    const a = Math.pow(1 - v, 2.1) * 0.92;
    for (let x = 0; x < 128; x++) {
      const streak = 0.72 + 0.28 * Math.sin(x * 0.31 + y * 0.11) * Math.sin(x * 0.07 + 1.7);
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, a * streak).toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** u columns for a tier: denser toward the stem (uniform u turned ~20 deg per
 *  face just aft of the stem head; this reads 13-14 deg) and a little at the
 *  counter, by inverse CDF of a smooth density. Deterministic, both ends
 *  included. Stem weight 1.3 with 48 LOD0 rows keeps adjacent girth faces
 *  3.8/4.2/4.4 deg (weights 1.2-1.4 all < 4.5; 2.5 put columns on the sharp
 *  sections at u 0.98-0.99 and read 5.1-5.3 on 40 rows). */
function shellColumns(cols: number): number[] {
  const N = 2048;
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const cdf: number[] = [0];
  for (let i = 1; i <= N; i++) {
    const u = (i - 0.5) / N;
    const rho = 1 + 1.3 * smooth(0.78, 0.93, u) + 0.8 * (1 - smooth(0, 0.08, u));
    cdf.push(cdf[i - 1] + rho / N);
  }
  const total = cdf[N];
  const us: number[] = [];
  let k = 0;
  for (let c = 0; c < cols; c++) {
    const target = (c / (cols - 1)) * total;
    while (k < N && cdf[k + 1] < target) k++;
    const span = cdf[k + 1] - cdf[k];
    us.push(c === 0 ? 0 : c === cols - 1 ? 1 : (k + (span > 0 ? (target - cdf[k]) / span : 0)) / N);
  }
  return us;
}

/** Newell normal of a closed loop of flat-array vertices. */
function loopNormal(verts: number[], loop: number[]): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
    ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
    nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * THE HULL SHELL ON THE SPLINE (b4.2d, ships-01): sampleHullSurface at the
 * tier's grid (HULL_TIER_GRID: LOD0 72 x 40 per side ... far 9 x 5), analytic
 * normals, open at the top (the deck slab is separate so the companionway stays
 * a real hole), capped with flat transom and stem panels. Layout: starboard
 * block (col-major, `rows` per column), port block, then the two caps; the
 * shell vertices ARE spline points, so the renderer and the server agree to
 * float precision. uv as before: (z / L + 0.5, hullUvV(y)).
 */
export function makeSplineHullGeometry(profile: HullProfile, tier: number): THREE.BufferGeometry {
  const grid = HULL_TIER_GRID[Math.min(HULL_TIER_GRID.length - 1, Math.max(0, tier | 0))];
  const cols = grid.cols, rows = grid.rows;
  const us = shellColumns(cols);
  const L = profile.L;
  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const samples: Array<{ x: number; y: number; z: number; nx: number; ny: number; nz: number }> = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) samples.push(sampleHullSurface(profile, us[c], r / (rows - 1)));
  }
  for (const side of [1, -1] as const) { // starboard block, then port block
    for (const s of samples) {
      verts.push(side * s.x, s.y, s.z);
      norms.push(side * s.nx, s.ny, s.nz);
      uvs.push(s.z / L + 0.5, hullUvV(profile, s.y));
    }
  }
  const faces: number[] = [];
  const vi = (c: number, side: 0 | 1, r: number) => side * cols * rows + c * rows + r;
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows - 1; r++) {
      // starboard (+x): outward winding
      let a = vi(c, 0, r), b = vi(c + 1, 0, r), cc = vi(c, 0, r + 1), d = vi(c + 1, 0, r + 1);
      faces.push(a, b, cc, b, d, cc);
      // port (-x): mirrored, reversed winding
      a = vi(c, 1, r); b = vi(c + 1, 1, r); cc = vi(c, 1, r + 1); d = vi(c + 1, 1, r + 1);
      faces.push(a, cc, b, b, cc, d);
    }
  }
  // Transom (u = 0) and stem (u = 1) caps on their own vertices, flat-shaded.
  const shellCount = verts.length / 3;
  for (const end of [0, cols - 1]) {
    const base = verts.length / 3;
    for (const side of [0, 1] as const) {
      for (let r = 0; r < rows; r++) {
        const k = vi(end, side, r) * 3;
        verts.push(verts[k], verts[k + 1], verts[k + 2]);
        uvs.push(uvs[(k / 3) * 2], uvs[(k / 3) * 2 + 1]);
      }
    }
    const S = (r: number) => base + r, P = (r: number) => base + rows + r;
    const loop: number[] = [];
    for (let r = 0; r < rows; r++) loop.push(S(r));
    for (let r = rows - 1; r >= 0; r--) loop.push(P(r));
    let n = loopNormal(verts, loop);
    const aft = end === 0;
    if ((aft && n[2] > 0) || (!aft && n[2] < 0)) n = [-n[0], -n[1], -n[2]];
    for (let i = 0; i < 2 * rows; i++) norms.push(n[0], n[1], n[2]);
    for (let r = 0; r < rows - 1; r++) {
      if (aft) faces.push(S(r), S(r + 1), P(r), S(r + 1), P(r + 1), P(r));
      else faces.push(S(r), P(r), S(r + 1), S(r + 1), P(r), P(r + 1));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(faces);
  geo.userData = { cols, rows, shellVerts: shellCount, tier };
  return geo;
}

/** A strake (wale / rub rail / armor belt) that HUGS the loft: a thin proud
 *  ridge following the hull surface at a per-station height. Replaces the old
 *  straight BoxGeometry rails that floated off the tapered bow/stern. */
/** Spline points per station interval along a strake. */
const STRAKE_SUBDIV = 6;

export function makeHullStrakeGeometry(
  profile: HullProfile,
  side: 1 | -1,
  yAt: (st: HullProfileStation) => number,
  proud: number,
  th: number,
  i0 = 0,
  i1 = profile.stations.length - 1,
): THREE.BufferGeometry {
  // Station knots on their spline rows, then STRAKE_SUBDIV spline points
  // between each pair (b4.2d): the run follows the curved shell instead of
  // cutting chords across it between stations.
  const knots: Array<{ x: number; y: number; z: number; nx: number; ny: number }> = [];
  for (let i = i0; i <= i1; i++) {
    const st = profile.stations[i];
    const y = yAt(st);
    const s = stationSurfaceAt(st, y);
    knots.push({ x: s.x, y, z: s.z, nx: s.nx, ny: s.ny });
  }
  const pts: Array<{ x: number; y: number; z: number; nx: number; ny: number }> = [];
  for (let k = 0; k < knots.length; k++) {
    pts.push(knots[k]);
    if (k === knots.length - 1) break;
    const a = knots[k], b = knots[k + 1];
    for (let j = 1; j < STRAKE_SUBDIV; j++) {
      const t = j / STRAKE_SUBDIV;
      const z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      const s = hullSurfacePointAt(profile, z, y);
      pts.push({ x: s.x, y, z, nx: s.nx, ny: s.ny });
    }
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

export function makeStairRampGeometry(
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

export function makeBillowedSailGeometry(
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


export const NO_MERGE_EXCLUDE: ReadonlySet<THREE.Object3D> = new Set();

/** Rebuilds a geometry so it can be merged with siblings: non-indexed, only
 *  position/normal/uv attributes, with zero-filled uv when the source has none. */
export function normalizeForMerge(geo: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) {
    // strakeUv (plank shader v2, b4.2e) survives so the merged hull keeps its strake space.
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'strakeUv') g.deleteAttribute(name);
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

/**
 * THE SHARED HULL GEOMETRY CACHE (perf-15).
 *
 * Ten to twenty-four hulls of three classes were each merging and keeping a
 * private ~2.5 MB copy of planking, rails, masts and deck furniture: 25.7 MB,
 * more than a third of every geometry byte in the game and more than the five
 * largest islands put together (docs/FRAME_COST_MODEL.md section 5). The static
 * part of a hull is IDENTICAL across ships of a class — team colour is a
 * material, breaches are a shader uniform, sails/flags/upgrades/patches are all
 * in the merge exclusion set — so the merged BufferGeometry can be shared and
 * three shares the GPU buffer behind it.
 *
 * Refcounted, because ShipRenderer.clear() disposes every geometry it can reach
 * and one hull leaving a match must not take the other nine's planking with it.
 * The refcount lives on the entry; `geo.userData.shipSharedKey` is how a
 * disposer knows to release instead of dispose.
 */
type SharedMerge = { geo: THREE.BufferGeometry; refs: number; bytes: number };
const SHARED_MERGES = new Map<string, SharedMerge>();

function geometryBytes(geo: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name] as THREE.BufferAttribute;
    bytes += a.array.byteLength ?? 0;
  }
  if (geo.index) bytes += (geo.index.array as ArrayLike<number> & { byteLength?: number }).byteLength ?? 0;
  return bytes;
}

/** Resident bytes and refcounts of the shared hull geometry — the census
 *  scripts/perf-cost-model.mjs grades. */
export function sharedShipGeometryCensus(): { entries: number; bytes: number; byKey: Array<{ key: string; bytes: number; refs: number }> } {
  let bytes = 0;
  const byKey: Array<{ key: string; bytes: number; refs: number }> = [];
  for (const [key, e] of SHARED_MERGES) {
    bytes += e.bytes;
    byKey.push({ key, bytes: e.bytes, refs: e.refs });
  }
  byKey.sort((a, b) => b.bytes - a.bytes);
  return { entries: SHARED_MERGES.size, bytes, byKey };
}

/**
 * Dispose a geometry that came out of a ship build. Shared merges are released
 * (disposed only when the last hull using them is gone); anything else is
 * disposed outright. Every ship teardown path must go through this instead of
 * calling `geometry.dispose()`.
 */
export function releaseShipGeometry(geo: THREE.BufferGeometry | undefined): void {
  if (!geo) return;
  const key = (geo.userData as { shipSharedKey?: string }).shipSharedKey;
  if (!key) { geo.dispose?.(); return; }
  const entry = SHARED_MERGES.get(key);
  if (!entry || entry.geo !== geo) { geo.dispose?.(); return; }
  entry.refs -= 1;
  if (entry.refs <= 0) {
    SHARED_MERGES.delete(key);
    geo.dispose?.();
  }
}

/**
 * Share one BufferGeometry across every hull that asks for the same key
 * (perf-15), building it on the first ask. For geometry that is assembled
 * outside `mergeStaticMeshes` but is still identical per hull class — the hold's
 * cumulative cargo tiers, for instance. Released by `releaseShipGeometry`.
 */
export function acquireSharedGeometry(
  key: string,
  build: () => THREE.BufferGeometry | null,
): THREE.BufferGeometry | null {
  if ((globalThis as { __shipMergeNoCache?: boolean }).__shipMergeNoCache) return build();
  const hit = SHARED_MERGES.get(key);
  if (hit) { hit.refs += 1; return hit.geo; }
  const geo = build();
  if (!geo) return null;
  (geo.userData as { shipSharedKey?: string }).shipSharedKey = key;
  SHARED_MERGES.set(key, { geo, refs: 1, bytes: geometryBytes(geo) });
  return geo;
}

/** Test hook: drop the whole cache (a suite that builds fleet after fleet). */
export function resetSharedShipGeometry(): void {
  for (const e of SHARED_MERGES.values()) e.geo.dispose?.();
  SHARED_MERGES.clear();
}

/** Bakes every static leaf mesh under `root` into one mesh per material,
 *  skipping excluded subtrees (anything animated, tinted, or toggled at
 *  runtime). This is the main per-ship draw-call reduction.
 *
 *  `cacheKey` (the hull class) opts the result into the shared cache above: a
 *  second hull of the same class reuses the first hull's merged buffers instead
 *  of merging and keeping its own. Pass nothing for a one-off group. */
export function mergeStaticMeshes(root: THREE.Object3D, excluded: ReadonlySet<THREE.Object3D>, cacheKey?: string) {
  // Census escape hatch: merging batches by material and throws every mesh
  // NAME away, so a geometry gate can say "ship-dark-timber hangs 0.85 m aft"
  // and nothing can say WHICH timber. Node-side probes set this global to keep
  // the parts separate; nothing in the browser build ever sets it.
  if ((globalThis as { __shipNoMerge?: boolean }).__shipNoMerge) return;
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
  // b4.2e: a bucket whose shell carries strakeUv pads every other part on that
  // material with horizontal metric planks (along z, strake = -y / 0.26 m) so
  // the attribute sets match and nothing reads a zero-width strake.
  for (const bucket of buckets.values()) {
    if (!bucket.geos.some((geo) => geo.attributes.strakeUv)) continue;
    for (const geo of bucket.geos) {
      if (geo.attributes.strakeUv) continue;
      const p = geo.attributes.position as THREE.BufferAttribute;
      const su = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        su[i * 3] = p.getZ(i); su[i * 3 + 1] = -p.getY(i) / 0.26; su[i * 3 + 2] = 0.26;
      }
      geo.setAttribute('strakeUv', new THREE.BufferAttribute(su, 3));
    }
  }

  // Two materials in one build can carry the same NAME (a clone keeps it unless
  // it is renamed), so the cache key counts occurrences: `sloop|ship-rope#1`.
  const nameSeen = new Map<string, number>();
  const g = globalThis as { __shipMergeVerify?: boolean; __shipMergeNoCache?: boolean };
  const verify = Boolean(g.__shipMergeVerify);
  // The census gate's red proof: rebuild every hull the way HEAD did, with a
  // private merged copy each, and watch the resident bill go back over budget.
  if (g.__shipMergeNoCache) cacheKey = undefined;
  for (const [material, bucket] of buckets) {
    if (bucket.meshes.length < 2) {
      for (const geo of bucket.geos) geo.dispose();
      continue;
    }
    let merged: THREE.BufferGeometry | null = null;
    let sharedKey: string | undefined;
    if (cacheKey) {
      const n = (nameSeen.get(material.name) ?? 0) + 1;
      nameSeen.set(material.name, n);
      sharedKey = `${cacheKey}|${material.name}#${n}|${bucket.meshes.length}`;
      const hit = SHARED_MERGES.get(sharedKey);
      if (hit) {
        if (verify) {
          // "Can the cache be wrong?" mode: merge anyway and compare. A hull
          // class whose static geometry is NOT identical across ships (a random
          // seed, a per-ship dimension) shows up here instead of on screen.
          const fresh = mergeGeometries(bucket.geos, false);
          const a = hit.geo.attributes.position as THREE.BufferAttribute | undefined;
          const b = fresh?.attributes.position as THREE.BufferAttribute | undefined;
          let same = Boolean(a && b) && a!.count === b!.count;
          if (same) {
            for (let i = 0; i < a!.array.length; i++) {
              if (Math.abs((a!.array as ArrayLike<number>)[i] - (b!.array as ArrayLike<number>)[i]) > 1e-5) { same = false; break; }
            }
          }
          fresh?.dispose();
          if (!same) throw new Error(`shared hull geometry mismatch for ${sharedKey}: the cache would draw the wrong shape`);
        }
        for (const geo of bucket.geos) geo.dispose();
        hit.refs += 1;
        merged = hit.geo;
      }
    }
    if (!merged) {
      merged = mergeGeometries(bucket.geos, false);
      for (const geo of bucket.geos) geo.dispose();
      if (merged && sharedKey) {
        (merged.userData as { shipSharedKey?: string }).shipSharedKey = sharedKey;
        SHARED_MERGES.set(sharedKey, { geo: merged, refs: 1, bytes: geometryBytes(merged) });
      }
    }
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

/** Masthead flag: hoist→fly and head→foot, in metres (roughly a 2:1 ensign). */

// ─────────────────────────────────────────────────────────────────────────────
// THE SHEER LINE — everything that stands ON the hull instead of IN her.
//
// The deck, the bulwarks, the cap rail, the railings and the stern castle were
// all straight boxes sized off W and L: a W·0.95 deck slab, bulwarks at 0.44 W
// and a cap rail at 0.48 W, all carried the full length of the ship. The lofted
// hull is not a box — she is 0.30 W at the transom and 0.055 W at the stem — so
// every one of those parts hung over open water at the ends: 2.5 m of planking
// past the galleon's bow, a cap rail 1.5 m outboard of her own topside
// (ships-04/05/06). These helpers put each of them back on the sheer curve.
// ─────────────────────────────────────────────────────────────────────────────

/** Half-beam of the DECK EDGE at a hull-local z: the loft's top slot (sheer),
 *  interpolated on its raked z, so the run closes at the real stem and transom
 *  rather than at the station's base z. */
export function sheerHalfWidthAt(profile: HullProfile, z: number): number {
  const t = sheerTable(profile);
  const zs = t.z, xs = t.x;
  if (z <= zs[0]) return xs[0];
  if (z >= zs[zs.length - 1]) return xs[xs.length - 1];
  let lo = 0, hi = zs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (zs[m] <= z) lo = m; else hi = m; }
  const f = (z - zs[lo]) / Math.max(1e-6, zs[hi] - zs[lo]);
  return xs[lo] + (xs[hi] - xs[lo]) * f;
}

/** The sheer (v = 0 iso-line of the spline) sampled densely once per profile
 *  (b4.2d): deck slab, bulwarks, sheer runs and the castle follow the curved
 *  deck edge, not chords between the 9 loft stations. */
const SHEER_SAMPLES = 160;
const SHEER_TABLES = new WeakMap<HullProfile, { z: Float64Array; x: Float64Array }>();
function sheerTable(profile: HullProfile): { z: Float64Array; x: Float64Array } {
  let t = SHEER_TABLES.get(profile);
  if (t) return t;
  const z = new Float64Array(SHEER_SAMPLES + 1), x = new Float64Array(SHEER_SAMPLES + 1);
  for (let i = 0; i <= SHEER_SAMPLES; i++) {
    const s = sampleHullSurface(profile, i / SHEER_SAMPLES, 0);
    z[i] = s.z; x[i] = s.x;
  }
  for (let i = 1; i <= SHEER_SAMPLES; i++) if (z[i] < z[i - 1]) z[i] = z[i - 1];
  t = { z, x };
  SHEER_TABLES.set(profile, t);
  return t;
}

/** Fore-and-aft z of the sheer at the transom and at the stem. */
export function sheerZRange(profile: HullProfile): { aft: number; fore: number } {
  const t = sheerTable(profile);
  return { aft: t.z[0], fore: t.z[t.z.length - 1] };
}

function slabZSamples(zFrom: number, zTo: number, samples: number, extra: number[]): number[] {
  const zs: number[] = [];
  for (let i = 0; i <= samples; i++) zs.push(zFrom + (zTo - zFrom) * (i / samples));
  for (const e of extra) if (e > zFrom + 1e-4 && e < zTo - 1e-4) zs.push(e);
  zs.sort((a, b) => a - b);
  return zs.filter((z, i) => i === 0 || z - zs[i - 1] > 1e-4);
}

/**
 * A SLAB THAT FOLLOWS THE SHEER — the weather deck and the stern castle.
 *
 * Top face at `topY`, bottom at `topY - thickness`, half-beam at every z taken
 * from the loft (less `inset`). An optional rectangular `hole` (the
 * companionway) is cut by splitting the strip at the hole's own z values, so no
 * ShapeGeometry triangulation and no T-junctions. Roughly 24 z samples: about
 * 190 triangles for the deck against the 60 the five boxes cost, and it exists
 * only on the DETAIL hull (the far LOD proxy is untouched), so the low tier's
 * far-hull budget does not move.
 *
 * uv is world-metric — u = x·uvScaleX, v = z·uvScaleY — so plank spacing is a
 * length in metres and does not stretch with hull class (ships-19).
 */
export function makeLoftedSlabGeometry(
  profile: HullProfile,
  opts: {
    topY: number;
    thickness: number;
    zFrom: number;
    zTo: number;
    inset?: number;
    hole?: { cx: number; cz: number; halfX: number; halfZ: number } | null;
    samples?: number;
    uvScaleX?: number;
    uvScaleY?: number;
    /** Override the sheer as the outline — the hold uses its own footprint. */
    halfAt?: (z: number) => number;
  },
): THREE.BufferGeometry {
  const inset = opts.inset ?? 0;
  const hole = opts.hole ?? null;
  const uvx = opts.uvScaleX ?? 1;
  const uvy = opts.uvScaleY ?? 1;
  const botY = opts.topY - opts.thickness;
  const zs = slabZSamples(opts.zFrom, opts.zTo, opts.samples ?? 22,
    hole ? [hole.cz - hole.halfZ, hole.cz + hole.halfZ] : []);
  const outline = opts.halfAt ?? ((z: number) => sheerHalfWidthAt(profile, z));
  const half = zs.map((z) => Math.max(0.05, outline(z) - inset));

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number) => {
    const i = pos.length / 3;
    pos.push(x, y, z);
    uv.push(x * uvx, z * uvy);
    return i;
  };
  const quad = (a: number, b: number, c: number, d: number) => { idx.push(a, b, c, a, c, d); };
  /** One fore-and-aft strip between two z samples, from x0(z) to x1(z). */
  const strip = (i: number, x0a: number, x1a: number, x0b: number, x1b: number) => {
    const za = zs[i], zb = zs[i + 1];
    const tA = push(x0a, opts.topY, za), tB = push(x1a, opts.topY, za);
    const tC = push(x1b, opts.topY, zb), tD = push(x0b, opts.topY, zb);
    quad(tA, tB, tC, tD);
    const uA = push(x0a, botY, za), uB = push(x1a, botY, za);
    const uC = push(x1b, botY, zb), uD = push(x0b, botY, zb);
    quad(uA, uD, uC, uB);
  };
  for (let i = 0; i < zs.length - 1; i++) {
    const za = zs[i], zb = zs[i + 1];
    const ha = half[i], hb = half[i + 1];
    const inHole = hole
      && (za + zb) * 0.5 > hole.cz - hole.halfZ
      && (za + zb) * 0.5 < hole.cz + hole.halfZ;
    if (inHole && hole) {
      const xMin = hole.cx - hole.halfX, xMax = hole.cx + hole.halfX;
      strip(i, -ha, Math.max(-ha, Math.min(xMin, ha)), -hb, Math.max(-hb, Math.min(xMin, hb)));
      strip(i, Math.min(ha, Math.max(xMax, -ha)), ha, Math.min(hb, Math.max(xMax, -hb)), hb);
    } else {
      strip(i, -ha, ha, -hb, hb);
    }
    // Outboard skirt (both sides), so the deck edge has a visible thickness.
    for (const s of [-1, 1] as const) {
      const a = push(s * ha, opts.topY, za), b = push(s * hb, opts.topY, zb);
      const c = push(s * hb, botY, zb), d = push(s * ha, botY, za);
      if (s === 1) quad(a, b, c, d); else quad(a, d, c, b);
    }
  }
  // End caps.
  for (const [z, h, sign] of [[zs[0], half[0], -1], [zs[zs.length - 1], half[half.length - 1], 1]] as const) {
    const a = push(-h, opts.topY, z), b = push(h, opts.topY, z);
    const c = push(h, botY, z), d = push(-h, botY, z);
    if (sign === 1) quad(a, b, c, d); else quad(a, d, c, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A WALL THAT FOLLOWS THE SHEER — bulwark, cap rail, side railing.
 *
 * A closed box-section run whose OUTER face sits on the deck edge at every z.
 * `inset` pulls the outer face inboard (the cap rail sits proud of the bulwark,
 * the railing inboard of it). ~14 samples: 4 faces x 13 spans = 104 triangles
 * per side against the 12 of the old box, again detail-hull only.
 */
export function makeSheerRunGeometry(
  profile: HullProfile,
  side: 1 | -1,
  opts: { y0: number; y1: number; thickness: number; zFrom: number; zTo: number; inset?: number; samples?: number; halfAt?: (z: number) => number },
): THREE.BufferGeometry {
  const inset = opts.inset ?? 0;
  const outline = opts.halfAt ?? ((z: number) => sheerHalfWidthAt(profile, z));
  const zs = slabZSamples(opts.zFrom, opts.zTo, opts.samples ?? 14, []);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const run = Math.max(0.001, opts.zTo - opts.zFrom);
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i];
    const xOut = Math.max(0.05, outline(z) - inset);
    const xIn = Math.max(0.02, xOut - opts.thickness);
    const rails: Array<[number, number]> = [[xOut, opts.y1], [xOut, opts.y0], [xIn, opts.y0], [xIn, opts.y1]];
    for (let r = 0; r < 4; r++) {
      pos.push(side * rails[r][0], rails[r][1], z);
      uv.push((z - opts.zFrom) / run, r / 3);
    }
  }
  const vi = (s: number, r: number) => s * 4 + (r % 4);
  for (let s = 0; s < zs.length - 1; s++) {
    for (let r = 0; r < 4; r++) {
      const a = vi(s, r), b = vi(s + 1, r), c = vi(s, r + 1), d = vi(s + 1, r + 1);
      if (side === 1) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * b4.2d LOD1 (30-90 m, D26 <= 35% of LOD0 tris, <= 12 draws): every static
 * part `accept` names, baked at its pose under `root` into ONE geometry whose
 * vertex colour is its material's tone (position + normal + color, no uv).
 * Parts whose world-scaled bounding radius is under `minRadius` are dropped:
 * at 30 m a 10 cm cleat is under two pixels and only costs triangles. Shared
 * and refcounted through the same cache as mergeStaticMeshes, so hulls of a
 * class hold one copy (the key must carry everything the shape depends on).
 */
export function bakeVertexColorMerge(
  root: THREE.Object3D,
  accept: (mesh: THREE.Mesh) => THREE.Color | null,
  minRadius: number,
  cacheKey: string,
): THREE.BufferGeometry | null {
  const sharedKey = `${cacheKey}|vertex-colour`;
  const hit = SHARED_MERGES.get(sharedKey);
  if (hit) { hit.refs += 1; return hit.geo; }
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const geos: THREE.BufferGeometry[] = [];
  root.traverseVisible((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || Array.isArray(mesh.material)) return;
    if (!mesh.geometry.attributes.position) return;
    const tone = accept(mesh);
    if (!tone) return;
    relative.multiplyMatrices(rootInverse, mesh.matrixWorld);
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    scale.setFromMatrixScale(relative);
    const r = (mesh.geometry.boundingSphere?.radius ?? 0) * Math.max(scale.x, scale.y, scale.z);
    if (r < minRadius) return;
    const g = normalizeForMerge(mesh.geometry, relative);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = tone.r; col[i * 3 + 1] = tone.g; col[i * 3 + 2] = tone.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  });
  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  (merged.userData as { shipSharedKey?: string }).shipSharedKey = sharedKey;
  SHARED_MERGES.set(sharedKey, { geo: merged, refs: 1, bytes: geometryBytes(merged) });
  return merged;
}
