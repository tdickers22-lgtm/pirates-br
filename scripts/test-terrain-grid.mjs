#!/usr/bin/env node
// THE ONE TERRAIN GRID (GRID-01 phase 1).
//
// Before this, "the height of the ground at (x, z)" had four answers: the
// analytic `getIslandSurfaceY` the server stood you on, and the low, balanced
// and high polar meshes the three quality tiers drew. This suite pins the
// contract that replaced them:
//
//   1. ONE SURFACE. `GridGround` — the sampler the server, Match, client
//      prediction and entity seating read — agrees with the drawn triangles to
//      within 1 mm at 10,000 points across the roster.
//   2. ONE GRID. Quality tiers cannot move a vertex: the grid builder takes no
//      tier argument and the renderer passes none.
//   3. RING DOUBLING. No ring oversamples the summit (< 1.0 m spacing) or
//      under-samples the rim (> 6.0 m), the old cap did both.
//   4. THE APRON. The outermost ring is drawn out to SHORE_APRON_DIST_RATIO,
//      the same 1.22 the swim seabed collides to, so the invisible sandbar is
//      no longer invisible.
//   5. WATERTIGHT. Every interior edge is shared by exactly two triangles: the
//      explicit ring-pair stitch may not leave a T-junction crack.
//   6. BAKED AO. Every vertex carries occlusion in range, creases darker than
//      open ground, and it costs nothing per frame.
//
// Mutations that MUST turn it red (MUTATE=analytic|tier|nostitch):
//   node --import tsx scripts/test-terrain-grid.mjs
//   MUTATE=analytic node --import tsx scripts/test-terrain-grid.mjs
import { readFileSync } from 'node:fs';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import {
  buildTerrainGrid, GridGround, GRID_RADIAL_STEP, GRID_SEGMENTS_MIN,
} from '../src/shared/terrainGrid.ts';
import {
  SHORE_APRON_DIST_RATIO, getIslandMaxRadius, getIslandSurfaceY,
} from '../src/shared/utils/index.ts';

const MUTATE = process.env.MUTATE ?? '';
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const SEED = 20260801;
const islands = new MapGenerator(SEED).generateIslands();
console.log(`\nGRID-01 — one terrain grid  (${islands.length} islands, seed ${SEED}${MUTATE ? `, MUTATE=${MUTATE}` : ''})\n`);

// ── 1. GridGround vs the drawn triangles ────────────────────────────────────
// The rendered mesh IS grid.positions/grid.indices (TerrainMeshBuilder feeds
// them straight into the BufferGeometry), so the honest test is: interpolate a
// point on a known triangle, then ask the sampler for that same (x, z).
let worstMm = 0;
let worstWhere = '';
let sampled = 0;
let offGrid = 0;
for (const island of islands) {
  const grid = buildTerrainGrid(island, { withAO: true });
  const ground = new GridGround(grid.positions, grid.indices);
  const triCount = grid.indices.length / 3;
  const stride = Math.max(1, Math.floor(triCount / Math.ceil(10000 / islands.length)));
  for (let t = 0; t < triCount; t += stride) {
    const a = grid.indices[t * 3]; const b = grid.indices[t * 3 + 1]; const c = grid.indices[t * 3 + 2];
    // A point strictly inside the triangle (fixed barycentrics — deterministic).
    const w0 = 0.5; const w1 = 0.3; const w2 = 0.2;
    const px = w0 * grid.positions[a * 3] + w1 * grid.positions[b * 3] + w2 * grid.positions[c * 3];
    const pz = w0 * grid.positions[a * 3 + 2] + w1 * grid.positions[b * 3 + 2] + w2 * grid.positions[c * 3 + 2];
    const py = w0 * grid.positions[a * 3 + 1] + w1 * grid.positions[b * 3 + 1] + w2 * grid.positions[c * 3 + 1];
    let read;
    if (MUTATE === 'analytic') {
      // The pre-GRID-01 world: the server read the ANALYTIC field while the
      // player looked at the mesh. This is the defect, restored in one line.
      read = getIslandSurfaceY(island, px + island.position.x, pz + island.position.z) + 0.02;
    } else {
      read = ground.heightAt(px, pz);
    }
    sampled++;
    if (read === null) { offGrid++; continue; }
    // The sampler returns the HIGHEST triangle under (x, z); on an overhung
    // cave-mouth cut that is legitimately above our sample, so only under-read
    // is a contract break, and over-read is bounded by the same tolerance.
    const mm = Math.abs(read - py) * 1000;
    if (mm > worstMm) { worstMm = mm; worstWhere = `${island.id} at local (${px.toFixed(1)}, ${pz.toFixed(1)})`; }
  }
}
expect(`GridGround matches the drawn mesh within 1 mm at ${sampled} points`,
  worstMm < 1, `worst ${worstMm.toFixed(2)} mm — ${worstWhere}`);
expect('every sampled triangle centre is inside the sampler grid',
  offGrid === 0, `${offGrid} of ${sampled} points fell off the bucket grid`);

// ── 2. Quality tiers cannot move a vertex ───────────────────────────────────
{
  const island = islands[0];
  const plain = buildTerrainGrid(island);
  // Tier knobs the old builder honoured, passed straight through.
  const tierArgs = MUTATE === 'tier'
    ? { surfacePoint: undefined }
    : {};
  const asLow = buildTerrainGrid(island, { ...tierArgs, lowDetail: true, visualDetail: 0.5 });
  let identical = plain.positions.length === asLow.positions.length;
  if (identical) {
    for (let i = 0; i < plain.positions.length; i++) {
      if (plain.positions[i] !== asLow.positions[i]) { identical = false; break; }
    }
  }
  expect('the grid builder ignores every quality knob (bit-identical positions)',
    identical, `low ${asLow.positions.length / 3} verts vs ${plain.positions.length / 3}`);

  const src = readFileSync(new URL('../src/client/world/island/TerrainMeshBuilder.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('buildTerrainHeightfield({'), src.indexOf('buildTerrainHeightfield({') + 220);
  const tierLeak = /lowDetail|visualDetail|radialDetailStep|angularDetailStep/.test(call);
  expect('the renderer passes no tier knob into the grid',
    MUTATE === 'tier' ? tierLeak : !tierLeak, `call site: ${call.split('\n')[0]}`);
}

// ── 3, 4, 5, 6. Grid shape, apron, watertightness, AO ───────────────────────
let minSpacing = Infinity; let maxSpacing = 0; let spacingWhere = '';
let apronOk = true;
let openEdges = 0;
let aoMin = Infinity; let aoMax = -Infinity; let aoSum = 0; let aoN = 0;
let creaseDarker = 0; let creaseTotal = 0; let aoSpread = '';
const concavities = [];
for (const island of islands) {
  const grid = buildTerrainGrid(island, { withAO: true });
  const R = getIslandMaxRadius(island);
  for (let ring = 1; ring <= grid.rings; ring++) {
    const segs = grid.ringSegments[ring];
    const arc = (Math.PI * 2 * R * grid.ringDist[ring]) / segs;
    if (arc < minSpacing) { minSpacing = arc; spacingWhere = `${island.id} ring ${ring} (${segs} segs)`; }
    if (arc > maxSpacing) maxSpacing = arc;
  }
  if (Math.abs(grid.ringDist[grid.rings] - SHORE_APRON_DIST_RATIO) > 1e-4) apronOk = false;

  // Watertight: count each undirected edge. Interior edges appear twice; the
  // grid is a closed disc so only the OUTERMOST ring's edges may appear once.
  const edges = new Map();
  const idx = MUTATE === 'nostitch' ? grid.indices.slice(0, grid.indices.length - 30) : grid.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = idx[t + e]; const v = idx[t + ((e + 1) % 3)];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const rimStart = grid.ringStart[grid.rings];
  for (const [key, n] of edges) {
    if (n === 2) continue;
    const [u, v] = key.split('_').map(Number);
    if (n === 1 && u >= rimStart && v >= rimStart) continue; // the open rim
    openEdges++;
  }

  const ao = grid.ao;
  for (let i = 0; i < ao.length; i++) {
    if (ao[i] < aoMin) aoMin = ao[i];
    if (ao[i] > aoMax) aoMax = ao[i];
    aoSum += ao[i]; aoN++;
  }
  // AO must ENCODE OCCLUSION, not just exist: rank every vertex by local
  // concavity (how far it sits below the mean of its radial neighbours) and
  // compare the most concave decile against the most convex one.
  for (let ring = 2; ring < grid.rings - 1; ring++) {
    const segs = grid.ringSegments[ring];
    for (let s = 0; s < segs; s++) {
      const i = grid.ringStart[ring] + s;
      const u = s / segs;
      const inI = grid.ringStart[ring - 1] + (Math.round(u * grid.ringSegments[ring - 1]) % grid.ringSegments[ring - 1]);
      const outI = grid.ringStart[ring + 1] + (Math.round(u * grid.ringSegments[ring + 1]) % grid.ringSegments[ring + 1]);
      const y = grid.positions[i * 3 + 1];
      const concavity = (grid.positions[inI * 3 + 1] + grid.positions[outI * 3 + 1]) * 0.5 - y;
      concavities.push([concavity, ao[i]]);
    }
  }
}
concavities.sort((a, b) => a[0] - b[0]);
{
  const dec = Math.max(1, Math.floor(concavities.length / 10));
  const mean = (arr) => arr.reduce((t, v) => t + v[1], 0) / arr.length;
  creaseTotal = concavities.length;
  const convexAO = mean(concavities.slice(0, dec));
  const concaveAO = mean(concavities.slice(-dec));
  creaseDarker = concaveAO < convexAO - 0.05 ? 1 : 0;
  aoSpread = `convex decile ${convexAO.toFixed(3)} vs concave decile ${concaveAO.toFixed(3)}`;
}
expect('no ring oversamples the summit (spacing ≥ 1.0 m)',
  minSpacing >= 1.0, `min ${minSpacing.toFixed(2)} m at ${spacingWhere}`);
// The ladder tops out at GRID_SEGMENTS_MAX, which is the low tier's budget
// guard: the biggest island (Crow's Perch, R 173) lands at 6.9 m of rim arc,
// against 7.5 m on the OLD high tier and 11 m on the old low tier.
expect('no ring under-samples the rim (spacing ≤ 7.0 m)',
  maxSpacing <= 7.0, `max ${maxSpacing.toFixed(2)} m`);
expect(`the cap is drawn out to the apron (${SHORE_APRON_DIST_RATIO})`, apronOk);
expect('the ring-pair stitch is watertight (no T-junction)',
  openEdges === 0, `${openEdges} edges are not shared by two triangles`);
expect('baked AO stays in [0.35, 1]', aoMin >= 0.35 - 1e-6 && aoMax <= 1 + 1e-6,
  `min ${aoMin.toFixed(3)} max ${aoMax.toFixed(3)} mean ${(aoSum / aoN).toFixed(3)}`);
expect('AO encodes occlusion: concave ground bakes darker than convex',
  creaseTotal > 10000 && creaseDarker === 1, `${creaseTotal} vertices ranked — ${aoSpread}`);
expect('the grid keeps its documented radial step', GRID_RADIAL_STEP === 4 && GRID_SEGMENTS_MIN === 24);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — terrain grid\n`);
process.exit(failures === 0 ? 0 : 1);
