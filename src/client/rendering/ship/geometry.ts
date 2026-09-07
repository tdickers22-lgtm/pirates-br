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
  const sts = profile.stations;
  const zs = sts.map((st) => st.slots[0].z);
  if (z <= zs[0]) return sts[0].slots[0].x;
  if (z >= zs[zs.length - 1]) return sts[sts.length - 1].slots[0].x;
  let i = 0;
  while (i < zs.length - 2 && z > zs[i + 1]) i++;
  const t = (z - zs[i]) / Math.max(0.0001, zs[i + 1] - zs[i]);
  return sts[i].slots[0].x + (sts[i + 1].slots[0].x - sts[i].slots[0].x) * t;
}

/** Fore-and-aft z of the sheer at the transom and at the stem. */
export function sheerZRange(profile: HullProfile): { aft: number; fore: number } {
  const sts = profile.stations;
  return { aft: sts[0].slots[0].z, fore: sts[sts.length - 1].slots[0].z };
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
