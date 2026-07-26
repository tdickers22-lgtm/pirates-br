/** Cave tunnel tube geometry: lofting, neighbour culling and vertex shading. */
import * as THREE from 'three';
import type { Island, IslandCave } from '../../../shared/types/index.js';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';

/** Metres of rock the drawn shell keeps OUTSIDE the walkable interior box. The
 *  shell used to be an ellipse whose radius WOBBLED between 0.67× and 1.45× the
 *  interior radius, while collision was a hard box at that radius: wherever the
 *  wobble pinched inward, an eye standing legally inside the cave sat OUTSIDE
 *  the drawn rock and saw the whole island exterior through the wall. The shell
 *  is now a rounded-rect loft that provably contains the box (+ this margin) at
 *  every ring, so the wall can never be behind the player. */
export const CAVE_SHELL_MARGIN = 0.5;
/** Superellipse exponent of the tunnel cross-section: 2 is an ellipse, ∞ a
 *  rectangle. 5 reads as an arched passage with square-ish shoulders — and, at
 *  CAVE_SHELL_K, provably encloses the rectangular interior. */
const SHELL_P = 5;
/** Scale that makes a superellipse of exponent SHELL_P contain the rectangle it
 *  is built around: k ≥ 2^(1/p) puts the rectangle's CORNERS inside it. */
const CAVE_SHELL_K = Math.pow(2, 1 / SHELL_P) + 0.01;

/** One cave segment as a CONTINUOUS, enclosed, organically-displaced rock tube
 *  (walls + floor + arched ceiling as a single surface — no gaps, no flat
 *  slabs). Rings are lofted along the tunnel axis with per-ring wander and
 *  per-vertex rock jitter; the floor is flattened for walking. Both ends stay
 *  open so overlapping segments blend into a network; `capBack` seals dead-ends.
 *  `cR`/`ceilY - floorY` describe the WALKABLE interior — the shell itself is
 *  lofted outside them (CAVE_SHELL_MARGIN), never through them. */
export function makeCaveTubeGeometry(cR: number, cLen: number, floorY: number, ceilY: number, seed: number, capBack: boolean, floorYEnd?: number): THREE.BufferGeometry {
  const segs = 16;
  const rings = Math.max(5, Math.round(cLen / 1.3));
  const hash = (n: number) => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
  const fEnd = floorYEnd ?? floorY;
  const height = ceilY - floorY;
  const positions: number[] = [];
  // 1 on walkable-floor vertices (ring angle sa < -0.28) — the junction
  // face-cull must never remove floor triangles, or players walk on void.
  const floorFlag: number[] = [];
  const ringIdx: number[][] = [];
  let vi = 0;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const z = -cLen * t;
    const floorJ = floorY + (fEnd - floorY) * t;          // ramp down into the mountain
    const vc = floorJ + height * 0.5;
    const cxWob = (hash(j * 3.7) - 0.5) * cR * 0.5;      // tunnel meanders
    // Wobble is OUTWARD-ONLY (≥1): a pinch below the interior radius is a hole
    // in the wall, not a pinch. The meander is added back into the half-width
    // so the shifted shell still clears the interior box on the near side.
    const rMul = 1 + hash(j * 6.3) * 0.3;                 // widenings
    const bx = (cR + CAVE_SHELL_MARGIN + Math.abs(cxWob)) * CAVE_SHELL_K * rMul;
    // Vertical half-extent takes NO wobble: the generator only guarantees ~1-2m
    // of rock over the ceiling (roofed()), so a tube that wobbles UP pokes out
    // of the hillside as a black slab — and light leaks in where it does.
    const by = (height * 0.5 + CAVE_SHELL_MARGIN) * CAVE_SHELL_K;
    const idxs: number[] = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;                 // 0=right, π/2=up, 3π/2=down
      const ca = Math.abs(Math.cos(a));
      const sa = Math.sin(a);
      // Rocky jitter, outward only, and faded out toward the crown for the same
      // roof-thickness reason.
      const n = 1 + hash(j * 131 + s * 7.7) * 0.3 * (1 - Math.max(0, sa));
      // Superellipse radius along this angle — the rounded rectangle around the
      // interior box (see CAVE_SHELL_K).
      const rA = 1 / Math.pow(Math.pow(ca / bx, SHELL_P) + Math.pow(Math.abs(sa) / by, SHELL_P), 1 / SHELL_P);
      let x = Math.cos(a) * rA * n + cxWob;
      let y = vc + sa * rA * n;
      if (sa < -0.28) { const k = (-sa - 0.28) / 0.72; y = y * (1 - k) + (floorJ + 0.05) * k; } // flat floor
      else if (sa < 0.45) {
        // Wall SKIRT: tuck the lower side walls ~1.9m below the floor plane so
        // no light leaks under the wall edge where the carved mouth trench sits
        // slightly lower/wider than the tube (white slivers at the wall base).
        const k = 1 - (sa + 0.28) / 0.73;
        y -= k * 1.9;
      }
      positions.push(x, sa < -0.28 ? Math.max(y, floorJ - 0.02) : y, z);
      floorFlag.push(sa < -0.28 ? 1 : 0);
      idxs.push(vi++);
    }
    ringIdx.push(idxs);
  }
  const indices: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      const a = ringIdx[j][s], b = ringIdx[j][s2], c = ringIdx[j + 1][s2], d = ringIdx[j + 1][s];
      indices.push(a, d, c, a, c, b); // inward-facing
    }
  }
  if (capBack) {
    const last = ringIdx[rings];
    let cx = 0, cy = 0;
    for (const idx of last) { cx += positions[idx * 3]; cy += positions[idx * 3 + 1]; }
    const cIdx = vi++;
    positions.push(cx / segs, cy / segs, -cLen);
    floorFlag.push(0);
    for (let s = 0; s < segs; s++) indices.push(last[s], cIdx, last[(s + 1) % segs]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aFloor', new THREE.Float32BufferAttribute(floorFlag, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Drop tube triangles whose (world-space) centroid lies inside a DIFFERENT
 *  cave segment's open interior. Every segment emits its full circumferential
 *  wall with no neighbour awareness while physics walks the UNION of interiors
 *  — so at junctions/forks a solid-looking wall stood exactly where you can
 *  walk. The interior test mirrors getCaveCeilingY's hard box (inverse yaw,
 *  |lx| within an inset radius, entrance overhang to -length, y between the
 *  ramped floor and ceiling). Floor triangles are never culled. */
export function cullCaveTubeAgainstNeighbors(geo: THREE.BufferGeometry, cave: IslandCave, island: Island) {
  const caves = island.caves;
  if (!caves || caves.length < 2) return;
  const index = geo.getIndex();
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const floorAttr = geo.getAttribute('aFloor') as THREE.BufferAttribute | undefined;
  if (!index || !posAttr) return;
  // Same local→world transform the cave/portal groups apply (yaw about Y,
  // then cave.position; the island group contributes island.position which
  // cave.position already includes in world space).
  const cosSelf = Math.cos(cave.rotation);
  const sinSelf = Math.sin(cave.rotation);
  const insideOther = (wx: number, wy: number, wz: number): boolean => {
    for (const other of caves) {
      if (other === cave) continue;
      const oLen = other.length ?? 10;
      const oRadius = (other.interiorRadius ?? 3.0) - 0.35; // inset keeps shared shells
      if (oRadius <= 0) continue;
      const dx = wx - other.position.x;
      const dz = wz - other.position.z;
      const cosR = Math.cos(other.rotation);
      const sinR = Math.sin(other.rotation);
      const lx = dx * cosR - dz * sinR;
      const lz = dx * sinR + dz * cosR;
      if (Math.abs(lx) > oRadius || lz > -0.4 || lz < -(oLen - 0.6)) continue;
      // Per-segment floor ramp — mirrors shared getCaveFloorY/getCaveCeilingY.
      const f0 = other.floorY ?? other.position.y - 0.4;
      const fEnd = other.floorYEnd ?? f0;
      const along = oLen > 0 ? THREE.MathUtils.clamp(-lz / oLen, 0, 1) : 0;
      const floorAt = f0 + (fEnd - f0) * along;
      if (wy > floorAt + 0.05 && wy < floorAt + other.height - 0.05) return true;
    }
    return false;
  };
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const ia = index.getX(t);
    const ib = index.getX(t + 1);
    const ic = index.getX(t + 2);
    const isFloorTri = !!floorAttr
      && floorAttr.getX(ia) > 0.5 && floorAttr.getX(ib) > 0.5 && floorAttr.getX(ic) > 0.5;
    if (isFloorTri) {
      kept.push(ia, ib, ic);
      continue;
    }
    const lx = (posAttr.getX(ia) + posAttr.getX(ib) + posAttr.getX(ic)) / 3;
    const ly = (posAttr.getY(ia) + posAttr.getY(ib) + posAttr.getY(ic)) / 3;
    const lz = (posAttr.getZ(ia) + posAttr.getZ(ib) + posAttr.getZ(ic)) / 3;
    const wx = cave.position.x + lx * cosSelf + lz * sinSelf;
    const wy = cave.position.y + ly;
    const wz = cave.position.z - lx * sinSelf + lz * cosSelf;
    // Exterior guard: only cull faces genuinely BURIED under the hillside —
    // culling walls at/above the natural surface opened literal windows from
    // inside the cave to open daylight (segment boxes overshoot the rock).
    if (insideOther(wx, wy, wz) && wy < getIslandSurfaceY(island, wx, wz) - 0.4) continue;
    kept.push(ia, ib, ic);
  }
  if (kept.length !== index.count) {
    geo.setIndex(kept);
    geo.computeVertexNormals();
  }
}

/** Per-vertex tint for a cave tube: mouths get their first ~3m of throat
 *  lifted toward paletteRock×0.62 so the opening reads OPEN from approach
 *  distance (the flat ×0.36 stone read as a boulder wedged in the mouth).
 *  Every tube gets the attribute — the cave rock material is shared and
 *  vertexColors=true samples black where the attribute is missing. */
export function applyCaveTubeColors(geo: THREE.BufferGeometry, mouthBoost: boolean) {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    const z = posAttr.getZ(i);
    const c = mouthBoost ? THREE.MathUtils.lerp(1.38, 1.0, THREE.MathUtils.clamp(-z / 3, 0, 1)) : 1.0;
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
