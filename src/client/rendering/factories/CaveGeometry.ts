/** Cave tunnel tube geometry: lofting, neighbour culling and vertex shading. */
import * as THREE from 'three';
import type { Island, IslandCave } from '../../../shared/types/index.js';
import { CAVE_CEIL_HEADROOM, CAVE_NEAR_OVERHANG, CAVE_WALK_EXTRA, getIslandSurfaceY } from '../../../shared/utils/index.js';

/** Metres of rock the drawn shell keeps OUTSIDE the walkable interior box. The
 *  shell used to be an ellipse whose radius WOBBLED between 0.67× and 1.45× the
 *  interior radius, while collision was a hard box at that radius: wherever the
 *  wobble pinched inward, an eye standing legally inside the cave sat OUTSIDE
 *  the drawn rock and saw the whole island exterior through the wall. The shell
 *  is now a rounded-rect loft that provably contains the box (+ this margin) at
 *  every ring, so the wall can never be behind the player. */
export const CAVE_SHELL_MARGIN = 0.25;
/** Superellipse exponent of the tunnel cross-section: 2 is an ellipse, ∞ a
 *  rectangle. 14 hugs the walkable box closely enough that the rock a player
 *  can SEE and the rock a player can REACH are within a body-width of each
 *  other; the arch still reads as an arch because the crown corners round off
 *  and the floor is flattened under it. */
const SHELL_P = 14;
/** Ring samples per tube cross-section (chords between them are what the
 *  containment solve has to clear, so it is a shell parameter, not a detail
 *  knob). */
export const CAVE_SHELL_SEGS = 16;
/** Per-vertex outward rock jitter. Was 0.30 — on a 6 m gallery that alone put
 *  1.8 m of drawn rock outside the wall a player could touch (physics-04's
 *  1.28-1.90 m invisible wall). The rock reads rocky from the triplanar detail
 *  and the AO, not from a silhouette that lies about where the wall is. */
const SHELL_JITTER = 0.02;

/**
 * Half-extents of the drawn shell around a segment, SOLVED rather than scaled.
 *
 * The shell used to be the interior box scaled by k = 2^(1/p): a multiplicative
 * fudge that puts the box's corners inside the superellipse but whose slack
 * grows with the cave — on the roster's 6.2 m gallery it stood the wall 1.9 m
 * outboard of the walkable limit, which is the invisible wall players walked
 * into (physics-04). Here the offset is ADDITIVE and minimal: bisect for the
 * smallest s ≥ CAVE_SHELL_MARGIN with (X/(X+s))^p + (Y/(Y+s))^p ≤ 1, so the
 * gap between drawn rock and reachable air is s at every cave size.
 *
 * X/Y are the box that must be contained: the WALK box (interior radius +
 * CAVE_WALK_EXTRA, ceiling + CAVE_CEIL_HEADROOM), inflated by the chord sag of
 * a `CAVE_SHELL_SEGS`-gon so the straight edges between ring samples clear it
 * too — the shell is a polygon, and a chord is the other way into the box.
 */
export function caveShellHalfExtents(walkR: number, walkHalfH: number): { bx: number; by: number } {
  const sag = 1 - Math.cos(Math.PI / CAVE_SHELL_SEGS);
  const X = walkR * (1 + sag) + 0.02;
  const Y = walkHalfH * (1 + sag) + 0.02;
  const covers = (s: number) => Math.pow(X / (X + s), SHELL_P) + Math.pow(Y / (Y + s), SHELL_P) <= 1;
  let lo = CAVE_SHELL_MARGIN;
  if (covers(lo)) return { bx: X + lo, by: Y + lo };
  let hi = CAVE_SHELL_MARGIN;
  for (let i = 0; i < 12 && !covers(hi); i++) { lo = hi; hi *= 1.6; }
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (covers(mid)) hi = mid; else lo = mid; }
  return { bx: X + hi, by: Y + hi };
}
/** Metres every segment's tube overshoots its far plane so its open rim buries
 *  inside the neighbour it joins (see the tubeLen comment in CaveBuilder). */
export const CAVE_TUBE_BACK_OVERSHOOT = 1.2;

/** Every ARGUMENT makeCaveTubeGeometry needs for one cave segment, derived from
 *  the segment alone. The client builder and the geometry tests both go through
 *  this, so "what the player sees" and "what the suite proves" can't drift. */
export function caveTubeParams(cave: IslandCave) {
  const cLen = cave.length ?? 10;
  const cR = cave.interiorRadius ?? 3.0;
  const floorLocalY = cave.floorY - cave.position.y;
  const floorEndLocalY = (cave.floorYEnd ?? cave.floorY) - cave.position.y;
  return {
    cR,
    // Overshoot the tube past its nominal END so its open rim lands INSIDE the
    // connecting segment's walls (butt-joined rims left wedge gaps of sky).
    tubeLen: cLen + CAVE_TUBE_BACK_OVERSHOOT,
    floorLocalY,
    ceilingLocalY: floorLocalY + cave.height,
    seed: cave.width * 7.3 + cLen * 2.1 + cR,
    capBack: cave.hasBackWall ?? true,
    tubeFloorEnd: cLen > 0
      ? floorEndLocalY + (floorEndLocalY - floorLocalY) * (CAVE_TUBE_BACK_OVERSHOOT / cLen)
      : floorEndLocalY,
    // …and past its NEAR plane too, for every segment that joins one there. The
    // walkable box overhangs the near plane by CAVE_NEAR_OVERHANG so adjacent
    // segments share a real overlap band — a shell that stopped at the plane
    // left that band undrawn, and (worse) left the rim itself uncapped. Mouths
    // keep their near plane: theirs is the opening in the hillside.
    frontOvershoot: (cave.hasMouth ?? true) ? 0 : CAVE_NEAR_OVERHANG,
  };
}

/** One cave segment as a CONTINUOUS, enclosed, organically-displaced rock tube
 *  (walls + floor + arched ceiling as a single surface — no gaps, no flat
 *  slabs). Rings are lofted along the tunnel axis with per-ring wander and
 *  per-vertex rock jitter; the floor is flattened for walking. Both ends stay
 *  open so overlapping segments blend into a network; `capBack` seals dead-ends.
 *  `cR`/`ceilY - floorY` describe the WALKABLE interior — the shell itself is
 *  lofted outside them (CAVE_SHELL_MARGIN), never through them. */
export function makeCaveTubeGeometry(cR: number, cLen: number, floorY: number, ceilY: number, seed: number, capBack: boolean, floorYEnd?: number, frontOvershoot = 0): THREE.BufferGeometry {
  const segs = CAVE_SHELL_SEGS;
  const total = cLen + frontOvershoot;
  const rings = Math.max(5, Math.round(total / 1.3));
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
    const z = frontOvershoot - total * (j / rings);
    // Ramp parameter measured from the segment's NEAR PLANE (z = 0), so the
    // front overshoot doesn't shift the floor: it stays flat out there, exactly
    // like the walkable floor, which clamps its ramp at the same plane.
    const t = cLen > 0 ? Math.max(0, -z / cLen) : 0;
    const floorJ = floorY + (fEnd - floorY) * t;          // ramp down into the mountain
    const vc = floorJ + height * 0.5;
    // The meander (cxWob) and the per-ring widening (rMul) are GONE. They were
    // outward-only by construction — a shifted or widened ring had to add its
    // own shift back into the half-width or it pinched a hole in the wall — so
    // together they stood up to 1.9 m of drawn rock outboard of the walkable
    // limit and the player bonked into air (physics-04). The tunnel gets its
    // life from the floor ramp, the neighbour joins and the rock shading now.
    const { bx, by } = caveShellHalfExtents(
      cR + CAVE_WALK_EXTRA, height * 0.5 + CAVE_CEIL_HEADROOM,
    );
    const cxWob = 0;
    const idxs: number[] = [];
    for (let s = 0; s < segs; s++) {
      // Ring samples are NOT uniform in polar angle. A superellipse this square
      // is almost all flat wall and flat roof with four tight CORNERS, and a
      // chord across a corner is the only remaining way into the walkable box
      // (it cut 0.15 m under the collision ceiling at 32 uniform samples). The
      // superellipse's own PARAMETRIC form concentrates its parameter exactly
      // there, so reading the polar angle off it packs samples where the curve
      // turns and spends none on the flats, where a chord IS the surface.
      // Same vertex count, same shape, same axis points.
      const th = (s / segs) * Math.PI * 2;                // 0=right, π/2=up, 3π/2=down
      const a = Math.atan2(
        by * Math.sign(Math.sin(th)) * Math.pow(Math.abs(Math.sin(th)), 2 / SHELL_P),
        bx * Math.sign(Math.cos(th)) * Math.pow(Math.abs(Math.cos(th)), 2 / SHELL_P),
      );
      const ca = Math.abs(Math.cos(a));
      const sa = Math.sin(a);
      // Rocky jitter, outward only, and faded out toward the crown for the same
      // roof-thickness reason.
      const n = 1 + hash(j * 131 + s * 7.7) * SHELL_JITTER * (1 - Math.max(0, sa));
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
  // The rim-cap pass needs to find the two END RINGS again; the loft's layout
  // (ring-major, `segs` verts per ring) is the only thing that locates them.
  geo.userData.caveLoft = { segs, rings };
  return geo;
}

/** Is (wx, wy, wz) inside the ROCK SHELL VOLUME a segment's tube draws —
 *  i.e. would a sightline through this point have to pass through that tube's
 *  surface to escape? Deliberately CONSERVATIVE: the nominal superellipse (no
 *  meander, no rock jitter, no widening) is a strict subset of every ring the
 *  loft actually emits, because all three of those displacements are
 *  outward-only. So "true" always means genuinely covered. */
export function insideCaveShellVolume(other: IslandCave, wx: number, wy: number, wz: number): boolean {
  const oLen = other.length ?? 10;
  const oR = other.interiorRadius ?? 3.0;
  const oH = other.height;
  const cosR = Math.cos(other.rotation);
  const sinR = Math.sin(other.rotation);
  const dx = wx - other.position.x;
  const dz = wz - other.position.z;
  const lx = dx * cosR - dz * sinR;
  const lz = dx * sinR + dz * cosR;
  // Axial span of the drawn loft, pulled in 0.15m at both rims so a point that
  // only just grazes the end ring is never counted as covered.
  const front = (other.hasMouth ?? true) ? 0 : CAVE_NEAR_OVERHANG;
  if (lz > front - 0.15 || lz < -(oLen + CAVE_TUBE_BACK_OVERSHOOT) + 0.15) return false;
  const f0 = other.floorY;
  const fEnd = other.floorYEnd ?? f0;
  const floorAt = f0 + (fEnd - f0) * (oLen > 0 ? Math.max(0, -lz / oLen) : 0);
  // Same solve the loft runs, pulled in 5% so "inside the shell volume" never
  // claims a point the drawn surface only grazes.
  const ext = caveShellHalfExtents(oR + CAVE_WALK_EXTRA, oH * 0.5 + CAVE_CEIL_HEADROOM);
  const bx = ext.bx * 0.95;
  const by = ext.by * 0.95;
  // Below the floor plane the loft is not a superellipse — it is the flat
  // walkable floor with the wall skirt tucked under it, so the covered volume
  // there is the full-width slab between the skirt's feet.
  if (wy < floorAt) return wy > floorAt - 1.5 && Math.abs(lx) <= bx;
  const dy = wy - (floorAt + oH * 0.5);
  return Math.pow(Math.abs(lx) / bx, SHELL_P) + Math.pow(Math.abs(dy) / by, SHELL_P) <= 1;
}

/** Seal a tube's OPEN RIMS with an annular cap wherever the neighbour they join
 *  is too small to cover them.
 *
 *  A segment's rim is an open ring: the loft draws walls, never an end face. At
 *  a joint that is fine ONLY while the neighbour's shell is at least as big —
 *  the rim buries inside it. Where the radius (or the ceiling height) steps
 *  DOWN across the joint, e.g. a 5.7m-radius, 5m-tall junction chamber meeting
 *  the 3.3m-radius, 2.8m-tall tunnel that feeds it, the annulus between the two
 *  rims is drawn by nobody: from anywhere in the big room an eye looking at the
 *  joint sees straight through 5-10m of supposed rock to the island exterior.
 *
 *  So: at each open rim, march inward along all 16 spokes, find the radius at
 *  which a neighbour's shell starts covering, and fill the ring OUTSIDE it. A
 *  spoke whose rim vertex is already covered contributes nothing, which is why
 *  a well-matched joint (and every rim that buries in a bigger neighbour) still
 *  costs zero triangles. The hole this leaves is the neighbour's own shell
 *  outline, comfortably wider than the walkable box it wraps, so the cap can
 *  never stand in a doorway a pirate walks through. */
export function capCaveTubeRims(geo: THREE.BufferGeometry, cave: IslandCave, island: Island) {
  const loft = geo.userData.caveLoft as { segs: number; rings: number } | undefined;
  const caves = island.caves;
  if (!loft || !caves || caves.length < 2) return;
  const index = geo.getIndex();
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const floorAttr = geo.getAttribute('aFloor') as THREE.BufferAttribute | undefined;
  if (!index || !posAttr || !floorAttr) return;
  const { segs, rings } = loft;
  const cosSelf = Math.cos(cave.rotation);
  const sinSelf = Math.sin(cave.rotation);
  const coveredAt = (x: number, y: number, z: number): boolean => {
    const wx = cave.position.x + x * cosSelf + z * sinSelf;
    const wy = cave.position.y + y;
    const wz = cave.position.z - x * sinSelf + z * cosSelf;
    for (const other of caves) {
      if (other !== cave && insideCaveShellVolume(other, wx, wy, wz)) return true;
    }
    return false;
  };

  const positions = Array.from(posAttr.array as ArrayLike<number>);
  const floorFlag = Array.from(floorAttr.array as ArrayLike<number>);
  const indices: number[] = [];
  for (let i = 0; i < index.count; i++) indices.push(index.getX(i));
  let vi = posAttr.count;

  // Rims worth capping: the NEAR plane of every segment that isn't a mouth (a
  // mouth's near ring IS the opening), and the far rim of every segment that
  // isn't already sealed by the back cap.
  const rims: { base: number; outward: 1 | -1 }[] = [];
  if (!(cave.hasMouth ?? true)) rims.push({ base: 0, outward: 1 });
  if (!(cave.hasBackWall ?? true)) rims.push({ base: rings * segs, outward: -1 });

  for (const rim of rims) {
    const z = positions[rim.base * 3 + 2];
    let cx = 0, cy = 0;
    for (let s = 0; s < segs; s++) { cx += positions[(rim.base + s) * 3]; cy += positions[(rim.base + s) * 3 + 1]; }
    cx /= segs; cy /= segs;
    const outerR: number[] = [];
    const innerR: number[] = [];
    const dirs: [number, number][] = [];
    for (let s = 0; s < segs; s++) {
      const vx = positions[(rim.base + s) * 3] - cx;
      const vy = positions[(rim.base + s) * 3 + 1] - cy;
      const r = Math.hypot(vx, vy);
      dirs.push(r > 1e-4 ? [vx / r, vy / r] : [1, 0]);
      outerR.push(r);
      const [dx, dy] = dirs[s];
      let inner = 0;
      for (let q = r; q >= 0; q -= 0.12) {
        if (coveredAt(cx + dx * q, cy + dy * q, z)) { inner = q; break; }
      }
      // Overlap 0.25m INTO the covering shell so the polygonal inner edge can't
      // leave a hairline sliver between itself and the curved neighbour. The
      // neighbour's shell clears its own walkable box by ≥0.8m everywhere, so
      // the overlap still lands in rock, never in a doorway.
      innerR.push(inner >= r - 1e-3 ? r : Math.max(0, inner - 0.25));
    }
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      if (innerR[s] >= outerR[s] - 1e-3 && innerR[s2] >= outerR[s2] - 1e-3) continue;
      const quad = [
        [cx + dirs[s][0] * innerR[s], cy + dirs[s][1] * innerR[s]],
        [cx + dirs[s2][0] * innerR[s2], cy + dirs[s2][1] * innerR[s2]],
        [cx + dirs[s2][0] * outerR[s2], cy + dirs[s2][1] * outerR[s2]],
        [cx + dirs[s][0] * outerR[s], cy + dirs[s][1] * outerR[s]],
      ];
      const base = vi;
      for (const [qx, qy] of quad) { positions.push(qx, qy, z); floorFlag.push(0); vi++; }
      // Wound to face back down the tunnel (the only side an eye ever sees it
      // from): the near rim looks toward -z, the far rim toward +z.
      if (rim.outward === 1) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  if (vi === posAttr.count) return;
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aFloor', new THREE.Float32BufferAttribute(floorFlag, 1));
  geo.setIndex(indices);
  // computeVertexNormals REUSES an existing normal attribute rather than
  // resizing it, so the loft's old (shorter) normals would stay behind and the
  // draw call would run off the end of the buffer — GL_INVALID_OPERATION, and
  // the whole tube silently stops rendering. Drop it and let three rebuild.
  geo.deleteAttribute('normal');
  geo.computeVertexNormals();
}

/** Drop tube triangles whose (world-space) centroid lies inside a DIFFERENT
 *  cave segment's open interior. Every segment emits its full circumferential
 *  wall with no neighbour awareness while physics walks the UNION of interiors
 *  — so at junctions/forks a solid-looking wall stood exactly where you can
 *  walk. The interior test mirrors getCaveCeilingY's hard box (inverse yaw,
 *  |lx| within an inset radius, entrance overhang to -length, y between the
 *  ramped floor and ceiling). Floor triangles are never culled.
 *
 *  A triangle is only a fake wall where the neighbour REACHES. Deciding by
 *  centroid alone dropped whole quads that merely dipped into a smaller
 *  neighbour: a 7m-tall junction chamber lost the side wall standing over a
 *  4.1m-tall vein's opening, because the quad's midpoint fell inside the vein
 *  while its top sat 2m of solid rock above that vein's ceiling — and daylight
 *  came through the strip nobody drew. So a triangle also has to fit inside
 *  what its neighbours DRAW: every vertex must lie in some neighbour's shell
 *  volume, or the triangle stays and reads as the lintel over the opening. */
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
  // Per-vertex, memoised: does SOMETHING else still draw rock here? Only then
  // may this vertex's triangle be dropped.
  const shellCover = new Map<number, boolean>();
  const coveredByNeighbourShell = (i: number): boolean => {
    let hit = shellCover.get(i);
    if (hit === undefined) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      const wx = cave.position.x + x * cosSelf + z * sinSelf;
      const wy = cave.position.y + y;
      const wz = cave.position.z - x * sinSelf + z * cosSelf;
      hit = caves.some((other) => other !== cave && insideCaveShellVolume(other, wx, wy, wz));
      shellCover.set(i, hit);
    }
    return hit;
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
    if (insideOther(wx, wy, wz) && wy < getIslandSurfaceY(island, wx, wz) - 0.4
      && coveredByNeighbourShell(ia) && coveredByNeighbourShell(ib) && coveredByNeighbourShell(ic)) continue;
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
