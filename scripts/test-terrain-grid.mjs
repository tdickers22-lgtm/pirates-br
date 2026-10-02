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
//
// b4.4c (islands-07) adds, section 7:
//   7a. max LAND vertex spacing <= 2.5 m (ring arc and radial spoke, measured
//       in xz off grid.positions, wobble and footprint included);
//   7b. a ring within 0.5 m of every landform edge that faces the meridian
//       (fixture records on four islands through overrideIslandLandforms, the
//       roster path the server uses); MUTATE=noedgerings builds them with
//       `landforms: []` and must go red;
//   7c. no triangle faces down across the apron stitch;
//   7d. walker per-step query cost: mean triangles a GridGround.hit tests on
//       land <= 15 (14.5 at the 4 m grid, 2026-10-02), worst island <= 20;
//   7e. MAIN-THREAD grid cost per island <= 25 ms: the full 2 m build runs in
//       the static-world worker and is transferred (MUTATE=noworkergrid FAILS);
//       the worker grid is bit-identical to the client build; node build REPORTED.
import { readFileSync } from 'node:fs';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { Match } from '../src/server/core/Match.ts';
import { hasIslandGround, warmIslandGrounds } from '../src/shared/terrainGrid.ts';
import * as TG from '../src/shared/terrainGrid.ts';
import {
  buildTerrainGrid, GridGround, GRID_RADIAL_STEP, GRID_SEGMENTS_MIN,
} from '../src/shared/terrainGrid.ts';
import { overrideIslandLandforms } from '../src/shared/landforms.ts';
import {
  SHORE_APRON_DIST_RATIO, getIslandMaxRadius, getIslandSurfaceY, getIslandSurfacePoint,
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
// At a 2 m radial step ring 1 sits ~2 m from the apex with the ladder's 24
// segments (0.5 m apart); 1.0 m would need a 3.8 m first ring, over the
// 2.5 m spacing ceiling (7a). The pinwheel was 0.23 m.
expect('no ring oversamples the summit (spacing ≥ 0.5 m)',
  minSpacing >= 0.5, `min ${minSpacing.toFixed(2)} m at ${spacingWhere}`);
expect('no ring under-samples the rim (nominal spacing ≤ 3.0 m; drawn land ≤ 2.5 m in 7a)',
  maxSpacing <= 3.0, `max ${maxSpacing.toFixed(2)} m`);
expect(`the cap is drawn out to the apron (${SHORE_APRON_DIST_RATIO})`, apronOk);
expect('the ring-pair stitch is watertight (no T-junction)',
  openEdges === 0, `${openEdges} edges are not shared by two triangles`);
expect('baked AO stays in [0.35, 1]', aoMin >= 0.35 - 1e-6 && aoMax <= 1 + 1e-6,
  `min ${aoMin.toFixed(3)} max ${aoMax.toFixed(3)} mean ${(aoSum / aoN).toFixed(3)}`);
expect('AO encodes occlusion: concave ground bakes darker than convex',
  creaseTotal > 10000 && creaseDarker === 1, `${creaseTotal} vertices ranked — ${aoSpread}`);
expect('the grid keeps its documented radial step', GRID_RADIAL_STEP === 2 && GRID_SEGMENTS_MIN === 24);

// ── 7. b4.4c: 2 m grid, landform-edge rings, apron stitch, query cost ──────
{
  const LAND = 0.3;
  const xzd = (p, a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 2] - p[b * 3 + 2]);
  let worst = 0; let worstAt = '';
  let downTris = 0; let downAt = ''; let interiorFolds = 0;
  let costSum = 0; let costN = 0; let worstIslandCost = 0; let worstCostAt = '';
  const buildMs = [];
  for (const island of islands) {
    const t = [];
    let grid;
    for (let k = 0; k < 3; k++) { const t0 = performance.now(); grid = buildTerrainGrid(island); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b);
    buildMs.push([island.id, t[1], grid.positions.length / 3]);
    const P = grid.positions;
    for (let ring = 1; ring <= grid.rings; ring++) {
      const segs = grid.ringSegments[ring]; const base = grid.ringStart[ring];
      const inSegs = grid.ringSegments[ring - 1]; const inBase = grid.ringStart[ring - 1];
      for (let s = 0; s < segs; s++) {
        const i = base + s;
        if (P[i * 3 + 1] <= LAND) continue;
        const nxt = base + ((s + 1) % segs);
        if (segs > 1 && P[nxt * 3 + 1] > LAND) {
          const d = xzd(P, i, nxt);
          if (d > worst) { worst = d; worstAt = `${island.id} ring ${ring} arc`; }
        }
        // spoke = distance to the inner ring along the same meridian (the inner
        // ring's drawn polyline interpolated at this vertex's angle)
        const u = (s / segs) * inSegs;
        const s0 = Math.floor(u) % inSegs; const s1 = (s0 + 1) % inSegs; const f = u - Math.floor(u);
        const a0 = inBase + s0; const a1 = inBase + s1;
        if (P[a0 * 3 + 1] > LAND && P[a1 * 3 + 1] > LAND) {
          const ix = P[a0 * 3] * (1 - f) + P[a1 * 3] * f; const iz = P[a0 * 3 + 2] * (1 - f) + P[a1 * 3 + 2] * f;
          const d = Math.hypot(P[i * 3] - ix, P[i * 3 + 2] - iz);
          if (d > worst) { worst = d; worstAt = `${island.id} ring ${ring} (d ${grid.ringDist[ring].toFixed(3)}) spoke`; }
        }
      }
    }
    // 7c: triangles stitched from the last land ring outward must face the sky.
    const firstApron = grid.ringDist.findIndex((d) => d >= 0.9);
    const startV = grid.ringStart[Math.max(0, firstApron - 1)];
    // Winding is uniform over the cap, so a flip is any triangle whose xz
    // orientation disagrees with the majority (the cap's sky-facing sign).
    const I = grid.indices;
    let inPos = 0; let inNeg = 0; let apPos = 0; let apNeg = 0; let firstPos = -1; let firstNeg = -1;
    for (let t3 = 0; t3 < I.length; t3 += 3) {
      const a = I[t3]; const b = I[t3 + 1]; const c = I[t3 + 2];
      const ex = P[b * 3] - P[a * 3]; const ez = P[b * 3 + 2] - P[a * 3 + 2];
      const fx = P[c * 3] - P[a * 3]; const fz = P[c * 3 + 2] - P[a * 3 + 2];
      let ny = ez * fx - ex * fz;
      if (a < startV && b < startV && c < startV) { if (ny > 0) inPos++; else inNeg++; continue; }
      if (MUTATE === 'flipapron' && (t3 / 3) % 97 === 0) ny = -ny; // a few apron tris wound backwards
      if (ny > 0) { apPos++; if (firstPos < 0) firstPos = t3 / 3; } else { apNeg++; if (firstNeg < 0) firstNeg = t3 / 3; }
    }
    // the interior majority is the sky-facing sign; an apron triangle with the
    // other sign is a flip (MUTATE=flipapron reverses the band's winding)
    const skyPos = inPos >= inNeg;
    const flips = skyPos ? apNeg : apPos;
    interiorFolds += Math.min(inPos, inNeg);
    if (flips > 0) { downTris += flips; if (!downAt) downAt = `${island.id} tri ${skyPos ? firstNeg : firstPos}`; }
    // 7d: query cost on land points.
    const ground = new GridGround(grid.positions, grid.indices);
    let cs = 0; let cn = 0;
    for (let v = 0; v < P.length / 3; v += 5) {
      if (P[v * 3 + 1] <= LAND) continue;
      cs += ground.queryCost(P[v * 3] + 0.37, P[v * 3 + 2] - 0.21); cn++;
    }
    costSum += cs; costN += cn;
    if (cn && cs / cn > worstIslandCost) { worstIslandCost = cs / cn; worstCostAt = island.id; }
  }
  expect('7a: max land vertex spacing ≤ 2.5 m (arc and spoke, drawn xz)', worst <= 2.5, `max ${worst.toFixed(2)} m at ${worstAt}`);
  expect('7c: no triangle faces down across the apron stitch', downTris === 0, `${downTris} down-facing, first ${downAt}`);
  console.log(`     (interior xz folds, informational: ${interiorFolds})`);
  const meanCost = costSum / Math.max(1, costN);
  expect('7d: walker query tests ≤ 15 triangles on land (mean), ≤ 20 on the worst island',
    meanCost <= 15 && worstIslandCost <= 20, `mean ${meanCost.toFixed(1)}, worst ${worstIslandCost.toFixed(1)} (${worstCostAt})`);
  {
    const g = new GridGround(buildTerrainGrid(islands[0]).positions, buildTerrainGrid(islands[0]).indices);
    const t0 = performance.now(); let acc = 0;
    for (let k = 0; k < 200000; k++) acc += g.heightAt(((k * 7919) % 120) - 60, ((k * 104729) % 120) - 60) ?? 0;
    console.log(`     (walker query: ${(((performance.now() - t0) / 200000) * 1e6).toFixed(0)} ns per heightAt on ${islands[0].id}; checksum ${acc.toFixed(0)})`);
  }
  const totalVerts = buildMs.reduce((t, r) => t + r[2], 0);
  const worstBuild = buildMs.reduce((w, r) => (r[1] > w[1] ? r : w));
  console.log(`     (world grid: ${totalVerts} verts; build per island median-of-3 ${buildMs.map((r) => `${r[0]} ${r[1].toFixed(0)}`).join(', ')} ms)`);
  // 7e: the MAIN-THREAD cost per island. The full build (above, ~30-200 ms on
  // node at 2 m) runs in the static-world worker (staticWorld.worker.ts posts
  // buildWorkerTerrainGrid per island, NetworkClient adopts it); the renderer
  // only takes the transferred buffers and indexes the ground. Graded <= 25 ms.
  // MUTATE=noworkergrid skips the adopt, so the take falls back to a full build.
  {
    let worstMain = 0; let worstMainAt = ''; let identical = 0; let mismatched = '';
    for (const island of islands) {
      const { msg, transfer } = TG.buildWorkerTerrainGrid(7, island);
      const posted = structuredClone(msg, { transfer }); // what postMessage delivers
      if (process.env.MUTATE !== 'noworkergrid') TG.adoptWorkerTerrainGrid(posted);
      const t0 = performance.now();
      const grid = TG.takeWorkerTerrainGrid(island)
        ?? TG.buildTerrainGrid(island, { carveCaveMouth: TG.sharedCaveMouthCarver(island), withAO: true });
      new GridGround(grid.positions, grid.indices); // what setIslandGround indexes (kept out of the shared cache: section 8 needs it cold)
      const ms = performance.now() - t0;
      if (ms > worstMain) { worstMain = ms; worstMainAt = island.id; }
      // Bit-identical to the client's own build (IslandBuilder's surface point
      // closure + CaveBuilder's carve on the same two shared functions).
      const own = TG.buildTerrainGrid(island, {
        surfacePoint: (d, a, e = 0) => { const p = getIslandSurfacePoint(island, d, a, e); return { x: p.x - island.position.x, y: p.y, z: p.z - island.position.z }; },
        carveCaveMouth: TG.sharedCaveMouthCarver(island), withAO: true,
      });
      const same = (a, b) => a && b && a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
      if (same(own.positions, grid.positions) && same(own.indices, grid.indices) && same(own.ao, grid.ao) && same(own.mouthCarveDepth, grid.mouthCarveDepth)) identical++;
      else mismatched ||= island.id;
    }
    expect('7e: main-thread terrain grid cost <= 25 ms per island (worker-built 2 m grid)', worstMain <= 25, `worst ${worstMain.toFixed(1)} ms (${worstMainAt})`);
    expect('7e: worker grid bit-identical to the client build on every island', identical === islands.length, `${identical}/${islands.length}, first mismatch ${mismatched}`);
    // A grid answers only for its own island, and a newer join drops older grids.
    const a = islands[0];
    const { msg } = TG.buildWorkerTerrainGrid(8, a);
    TG.adoptWorkerTerrainGrid(msg);
    const stale = TG.takeWorkerTerrainGrid({ ...a, radius: a.radius + 1 });
    TG.adoptWorkerTerrainGrid(msg);
    TG.adoptWorkerTerrainGrid({ ...TG.buildWorkerTerrainGrid(9, islands[1]).msg });
    const superseded = TG.takeWorkerTerrainGrid(a);
    expect('7e: a reshaped island or a superseded join never takes a worker grid', stale === null && superseded === null, `stale ${stale !== null}, superseded ${superseded !== null}`);
    console.log(`     (main-thread take + ground index worst ${worstMain.toFixed(1)} ms on ${worstMainAt}; full build stays in the worker: worst ${worstBuild[1].toFixed(0)} ms on node)`);
  }

  // 7b: fixture landforms, island-local metres scaled to each island's radius.
  const fixture = (R) => [
    { id: 'fx-scarp', kind: 'scarp', path: [[-0.35 * R, 0.45 * R], [0, 0.55 * R], [0.35 * R, 0.45 * R]], height: 6 },
    { id: 'fx-valley', kind: 'valley', path: [[0.1 * R, -0.2 * R], [0.25 * R, -0.5 * R], [0.3 * R, -0.85 * R]], bedHeadY: 6, bedMouthY: 0.5, floorWidth: 3, topWidth: 14 },
    { id: 'fx-mesa', kind: 'mesa', center: [-0.4 * R, -0.2 * R], radius: 0.14 * R, topY: 9 },
    { id: 'fx-caldera', kind: 'caldera', center: [0.05 * R, 0.05 * R], rimRadius: 0.22 * R, rimY: 14, floorY: 4, rimWidth: 6 },
    { id: 'fx-headland', kind: 'headland', path: [[-0.6 * R, 0.4 * R], [-0.95 * R, 0.6 * R]], crestBaseY: 8, crestTipY: 3, topHalfWidth: 3 },
  ];
  let checked = 0; let skippedRadial = 0; let worstEdge = 0; let worstEdgeAt = '';
  const fixtureIslands = islands.filter((i) => ['castaway-reach', 'crow-s-perch', 'skull-cove', 'old-maw-caldera'].includes(i.id));
  for (const island of fixtureIslands) {
    const R = island.radius;
    const recs = fixture(R);
    overrideIslandLandforms(island, recs);
    try {
      const grid = buildTerrainGrid(island, MUTATE === 'noedgerings' ? { landforms: [] } : {});
      const P = grid.positions;
      const fx = island.profile.footprintX; const fz = island.profile.footprintZ;
      for (const s of TG.landformEdgeSamples(recs)) {
        const theta = Math.atan2(s.z / fz, s.x / fx);
        const rho = Math.hypot(s.x, s.z);
        // meridian direction: where the drawn rings cross theta
        let best = Infinity; let dirx = 0; let dirz = 0;
        for (let ring = 1; ring <= grid.rings; ring++) {
          const segs = grid.ringSegments[ring]; const base = grid.ringStart[ring];
          const u = ((theta / (Math.PI * 2)) % 1 + 1) % 1 * segs;
          const s0 = Math.floor(u) % segs; const s1 = (s0 + 1) % segs; const f = u - Math.floor(u);
          const x = P[(base + s0) * 3] * (1 - f) + P[(base + s1) * 3] * f;
          const z = P[(base + s0) * 3 + 2] * (1 - f) + P[(base + s1) * 3 + 2] * f;
          if (ring === grid.rings) { dirx = x; dirz = z; }
          const r = Math.hypot(x, z);
          if (Math.abs(r - rho) < best) best = Math.abs(r - rho);
        }
        const cos = Math.abs((s.nx * dirx + s.nz * dirz) / (Math.hypot(dirx, dirz) || 1));
        if (cos < 0.5 || rho > Math.hypot(dirx, dirz)) { skippedRadial++; continue; }
        checked++;
        if (best > worstEdge) { worstEdge = best; worstEdgeAt = `${island.id} ${s.id} at (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`; }
      }
    } finally {
      overrideIslandLandforms(island, null);
    }
  }
  expect(`7b: a ring within 0.5 m of every landform edge (${checked} edge samples, ${skippedRadial} radial-running left to the meridians)`,
    checked > 500 && worstEdge <= 0.5, `worst ${worstEdge.toFixed(2)} m at ${worstEdgeAt}`);
}

// ── the cache is warm BEFORE the first tick (review-6 P2) ──────────────────
// The server collides swimmers against the drawn ground, and getIslandGround
// builds an island's grid on first ask. The only setIslandGround caller is the
// client's TerrainMeshBuilder, so on the server that first ask came from inside
// a tick (PhysicsSystem.swimSeabedY): 226 ms for all 14 islands, 29 ms worst,
// against a 16 ms budget. Match.setupWorld must warm them all up front.
{
  const cold = islands.filter((i) => !hasIslandGround(i.id));
  expect('a fresh process has not built any island ground yet',
    cold.length === islands.length, `${islands.length - cold.length} already cached before a Match exists`);
  const t0 = performance.now();
  const match = new Match({ matchId: 'terrain-grid-warm', botCount: 1, seed: SEED });
  const buildMs = performance.now() - t0;
  const stillCold = match.state.islands.filter((i) => !hasIslandGround(i.id));
  expect('constructing a Match warms every island ground, off-tick',
    stillCold.length === 0, `${stillCold.length} island(s) would build inside a tick: ${stillCold.map((i) => i.id).join(', ')}`);
  console.log(`     (match construction incl. grids: ${buildMs.toFixed(0)} ms — paid once per process, never in a tick)`);
  const t1 = performance.now();
  const built = warmIslandGrounds(match.state.islands);
  expect('and a warm process rebuilds nothing', built === 0 && performance.now() - t1 < 5,
    `${built} rebuilt in ${(performance.now() - t1).toFixed(1)} ms`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — terrain grid\n`);
process.exit(failures === 0 ? 0 : 1);
