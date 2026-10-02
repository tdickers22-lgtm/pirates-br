// TERRAIN RENDER LOD (b4.4c, islands-06/07): the drawn terrain is the walkable
// grid (GRID-01), so a 2 m grid is also a 2 m DRAW everywhere. This module cuts
// one island's grid into CHUNKS (24 angular sectors x bands of rings) and gives
// each chunk two index lists over the SAME vertices:
//
//  - fine:   the grid's own triangles, untouched (what GridGround stands on);
//  - coarse: every TERRAIN_LOD_RING_STEP-th ring and every TERRAIN_LOD_ARC_STEP-th
//            vertex on the band's interior rings, zipped by angle.
//
// Any mix of fine and coarse chunks is WATERTIGHT, which is the whole design:
//  - a band's first and last ring stay at full resolution in the coarse list,
//    so a ring shared by two bands has the same vertices on both sides;
//  - a sector boundary is a meridian through a vertex of EVERY ring (24 x 2^k
//    ladder), and the coarse list keeps that meridian's vertex on every ring it
//    skips through a side fill (inner, skipped, outer), so the radial edge a
//    fine neighbour draws is still matched edge for edge.
// Pure index work: no heightfield evaluation, no THREE. Collision never reads it.
export const TERRAIN_LOD_SECTORS = 24;
/** Rings per band. A band is the radial unit of the switch. */
export const TERRAIN_LOD_BAND_RINGS = 21;
/** Coarse keeps every Nth vertex on a band's interior rings (power of two). */
export const TERRAIN_LOD_ARC_STEP = 8;
/** Coarse keeps every Nth ring inside a band (3: two skipped rings per gap). */
export const TERRAIN_LOD_RING_STEP = 3;

export type TerrainLodChunk = {
  readonly fine: Uint32Array;
  readonly coarse: Uint32Array;
  /** Island-local bounding sphere of the chunk's fine triangles. */
  readonly cx: number; readonly cy: number; readonly cz: number; readonly radius: number;
};

export type TerrainLodChunks = {
  readonly chunks: TerrainLodChunk[];
  readonly fineTris: number;
  readonly coarseTris: number;
};

export type TerrainLodOptions = {
  /** Test mutation: drop the side fills (the coarse list then cracks). */
  noSideFill?: boolean;
  /** Test mutation: decimate the band's boundary rings too (T-junctions). */
  decimateBandEdges?: boolean;
};

function ringOf(ringStart: Uint32Array, rings: number, v: number): number {
  let lo = 0; let hi = rings;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ringStart[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Build the chunk lists for one grid. Returns null if the grid is not a
 * 24 x 2^k ladder (then the caller draws the plain index and nothing else).
 */
export function buildTerrainLodChunks(
  positions: Float32Array,
  indices: Uint32Array,
  ringStart: Uint32Array,
  ringSegments: Uint32Array,
  rings: number,
  opts: TerrainLodOptions = {},
): TerrainLodChunks | null {
  const S = TERRAIN_LOD_SECTORS;
  const B = TERRAIN_LOD_BAND_RINGS;
  for (let r = 1; r <= rings; r++) if (ringSegments[r] % S !== 0) return null;
  if (ringSegments[0] !== 1) return null;
  const bands = Math.max(1, Math.ceil(rings / B));
  const nChunks = bands * S;
  const fineLists: number[][] = Array.from({ length: nChunks }, () => []);

  // ── fine: the grid's own triangles, sorted into chunks by centroid angle ──
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    let rMin = Infinity;
    let u0 = NaN; let uSum = 0; let uN = 0;
    for (let c = 0; c < 3; c++) {
      const v = indices[t * 3 + c];
      const r = ringOf(ringStart, rings, v);
      if (r < rMin) rMin = r;
      if (r === 0) continue;
      let u = (v - ringStart[r]) / ringSegments[r];
      if (Number.isNaN(u0)) u0 = u;
      else if (u - u0 > 0.5) u -= 1;
      else if (u0 - u > 0.5) u += 1;
      uSum += u; uN++;
    }
    let u = uN > 0 ? uSum / uN : 0;
    u -= Math.floor(u);
    const sector = Math.min(S - 1, Math.floor(u * S));
    const band = Math.min(bands - 1, Math.floor(rMin / B));
    const list = fineLists[band * S + sector];
    list.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
  }

  // ── coarse: zip kept rings by angle, fill the skipped rings at the sides ──
  const coarseLists: number[][] = Array.from({ length: nChunks }, () => []);
  const polyline = (r: number, m: number, step: number): number[] => {
    const segs = ringSegments[r];
    if (segs === 1) return [ringStart[r]];
    const a = (segs * m) / S; const b = (segs * (m + 1)) / S;
    const out: number[] = [];
    for (let s = a; s <= b; s += step) out.push(ringStart[r] + (s % segs));
    return out;
  };
  const sideVertex = (r: number, m: number, right: boolean): number => {
    const segs = ringSegments[r];
    if (segs === 1) return ringStart[r];
    return ringStart[r] + (((segs * (right ? m + 1 : m)) / S) % segs);
  };
  for (let band = 0; band < bands; band++) {
    const r0 = band * B; const r1 = Math.min(rings, r0 + B);
    const kept: number[] = [r0];
    // The apex ring is one vertex shared by all 24 sectors: a side fill there
    // would be drawn twice (once per neighbour), so ring 1 is never skipped.
    let first = r0 + TERRAIN_LOD_RING_STEP;
    if (ringSegments[r0] === 1 && r0 + 1 < r1) { kept.push(r0 + 1); first = r0 + 1 + TERRAIN_LOD_RING_STEP; }
    for (let r = first; r < r1; r += TERRAIN_LOD_RING_STEP) kept.push(r);
    kept.push(r1);
    const stepOf = (r: number): number => {
      if ((r === r0 || r === r1) && !opts.decimateBandEdges) return 1;
      const per = ringSegments[r] / S;
      return per >= 1 ? Math.max(1, Math.min(TERRAIN_LOD_ARC_STEP, per)) : 1;
    };
    for (let m = 0; m < S; m++) {
      const out = coarseLists[band * S + m];
      for (let k = 0; k + 1 < kept.length; k++) {
        const ri = kept[k]; const ro = kept[k + 1];
        const P = polyline(ri, m, stepOf(ri));
        const Q = polyline(ro, m, stepOf(ro));
        const n = P.length - 1; const q = Q.length - 1;
        let i = 0; let j = 0;
        while (i < n || j < q) {
          const advanceInner = i < n && (j >= q || (i + 1) / n <= (j + 1) / q);
          if (advanceInner) { out.push(P[i], Q[j], P[i + 1]); i++; } else { out.push(P[i], Q[j], Q[j + 1]); j++; }
        }
        if (opts.noSideFill) continue;
        // The skipped rings' vertices on both side meridians, fanned from the
        // outer corner: the side edge is then inner -> skipped... -> outer, the
        // same edges a fine neighbour draws. Two coarse neighbours both fill
        // their shared side, which leaves a zero-area fin pair, never a crack.
        let left = P[0]; let right = P[n];
        for (let rs = ri + 1; rs < ro; rs++) {
          const l = sideVertex(rs, m, false); const rr = sideVertex(rs, m, true);
          out.push(left, l, Q[0]);
          out.push(right, Q[q], rr);
          left = l; right = rr;
        }
      }
    }
  }

  const chunks: TerrainLodChunk[] = [];
  let fineTris = 0; let coarseTris = 0;
  for (let c = 0; c < nChunks; c++) {
    const fine = Uint32Array.from(fineLists[c]);
    const coarse = Uint32Array.from(coarseLists[c]);
    if (fine.length === 0 && coarse.length === 0) continue;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const v of fine.length > 0 ? fine : coarse) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    chunks.push({
      fine, coarse,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
      radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
    });
    fineTris += fine.length / 3;
    coarseTris += coarse.length / 3;
  }
  return { chunks, fineTris, coarseTris };
}

/** Concatenate the chosen list of every chunk into `out`; returns the count. */
export function writeTerrainLodIndex(chunks: readonly TerrainLodChunk[], near: ArrayLike<boolean | number>, out: Uint32Array): number {
  let n = 0;
  for (let c = 0; c < chunks.length; c++) {
    const src = near[c] ? chunks[c].fine : chunks[c].coarse;
    out.set(src, n);
    n += src.length;
  }
  return n;
}

/** Index capacity that holds any mix of fine and coarse chunks. */
export function terrainLodCapacity(chunks: readonly TerrainLodChunk[]): number {
  let n = 0;
  for (const c of chunks) n += Math.max(c.fine.length, c.coarse.length);
  return n;
}
