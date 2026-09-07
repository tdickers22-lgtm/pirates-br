// SHIP GEOMETRY — everything lofted from the shared hull stations (shell,
// strakes, waterline collar, companionway ramp, sail cloth) plus the static
// merge helpers. Extracted verbatim from ShipRenderer (codehealth-03 phase 1,
// HULLGEO-01 slice a); scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullUvV, stationSurfaceAt } from '../../../shared/hull.js';
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

/** The lofted hull shell. Open at the top (deck slabs are separate so the
 *  companionway stays a real hole); capped at the transom and stem. */
export function makeLoftedHullGeometry(profile: HullProfile, lowDetail = false): THREE.BufferGeometry {
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
export function makeHullStrakeGeometry(
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
export function mergeStaticMeshes(root: THREE.Object3D, excluded: ReadonlySet<THREE.Object3D>) {
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

/** Masthead flag: hoist→fly and head→foot, in metres (roughly a 2:1 ensign). */
