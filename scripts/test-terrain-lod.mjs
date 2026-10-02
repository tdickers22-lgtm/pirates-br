#!/usr/bin/env node
// TERRAIN RENDER LOD (b4.4c, islands-06/07) — quick logic gate.
//
//   node --import tsx scripts/test-terrain-lod.mjs [--mutate=nofill|bandedges|lod-off]
//
// For every island of the fixed world (seed 20260801):
//  1. the fine lists are exactly the grid's own triangles (multiset), so a near
//     chunk draws the walkable truth (GRID-01) and nothing else;
//  2. WATERTIGHT in any mix: for all-fine, all-coarse, two random 50/50 mixes
//     and a checkerboard, no edge is used more than four times (two coarse neighbours
//     leave a zero-area fin pair on their shared side) and the edges used
//     once are exactly the full grid's own boundary edges (a T-junction crack
//     shows up as an extra single-use edge);
//  3. the coarse world is <= 25% of the fine world's triangles (4 m grid:
//     24.4%; the b4.4c 2 m grid: 117,312 of 818,688 = 14.3%, under what the
//     whole 4 m grid drew, 132,816);
//  4. the client switch: a camera on the island draws the near chunks fine and
//     the far ones coarse, a far camera draws everything coarse, the index is
//     rewritten only on a band crossing, and raycasts hit the FULL grid.
// Mutations that must FAIL: nofill (side fills dropped -> cracks), bandedges
// (band rings decimated -> T-junctions), lod-off (?terrainlod=off -> check 4).
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { buildTerrainGrid } from '../src/shared/terrainGrid.ts';
import { buildTerrainLodChunks, writeTerrainLodIndex, terrainLodCapacity } from '../src/shared/terrainLod.ts';

const mutate = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
if (mutate === 'lod-off') globalThis.location = { search: '?terrainlod=off' };
const THREE = await import('three');
const { TerrainLodSwitch } = await import('../src/client/world/island/TerrainLod.ts');

let fails = 0; let passes = 0;
const check = (cond, label) => {
  if (cond) { passes++; console.log(`  ✓ ${label}`); } else { fails++; console.log(`  ✗ ${label}`); }
};

const edgeCounts = (idx, n) => {
  const m = new Map();
  for (let t = 0; t < n; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e]; const b = idx[t + ((e + 1) % 3)];
      if (a === b) continue;
      const k = a < b ? a * 4194304 + b : b * 4194304 + a;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
};
const boundaryOf = (m) => { const s = new Set(); for (const [k, c] of m) if (c === 1) s.add(k); return s; };
const triKey = (a, b, c) => [a, b, c].sort((x, y) => x - y).join(',');

console.log(`\nb4.4c — terrain render LOD${mutate ? ` (MUTATE=${mutate})` : ''}\n`);
const opts = { noSideFill: mutate === 'nofill', decimateBandEdges: mutate === 'bandedges' };
const map = { islands: new MapGenerator(20260801).generateIslands() };
let rng = 0x9e3779b9;
const rand = () => { rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return rng / 4294967296; };
let worldFine = 0; let worldCoarse = 0;
let badSets = 0; let overUsed = 0; let cracked = 0; const crackIslands = [];
let fineExact = true;
const grids = [];
for (const island of map.islands) {
  const g = buildTerrainGrid(island, { withAO: false });
  const lod = buildTerrainLodChunks(g.positions, g.indices, g.ringStart, g.ringSegments, g.rings, opts);
  if (!lod) { badSets++; continue; }
  grids.push({ island, g, lod });
  worldFine += lod.fineTris; worldCoarse += lod.coarseTris;
  // 1. fine == the grid's triangles (multiset)
  const want = new Map();
  for (let t = 0; t < g.indices.length; t += 3) { const k = triKey(g.indices[t], g.indices[t + 1], g.indices[t + 2]); want.set(k, (want.get(k) ?? 0) + 1); }
  for (const c of lod.chunks) for (let t = 0; t < c.fine.length; t += 3) {
    const k = triKey(c.fine[t], c.fine[t + 1], c.fine[t + 2]);
    const n = want.get(k); if (!n) { fineExact = false; break; } want.set(k, n - 1);
  }
  for (const n of want.values()) if (n !== 0) fineExact = false;
  // 2. watertight in any mix
  const fullEdges = edgeCounts(g.indices, g.indices.length);
  const fullBoundary = boundaryOf(fullEdges);
  let fullOver = 0; for (const c of fullEdges.values()) if (c > 4) fullOver++;
  const out = new Uint32Array(terrainLodCapacity(lod.chunks));
  const mixes = [
    lod.chunks.map(() => 1), lod.chunks.map(() => 0),
    lod.chunks.map(() => (rand() < 0.5 ? 1 : 0)), lod.chunks.map(() => (rand() < 0.5 ? 1 : 0)),
    lod.chunks.map((_, i) => i % 2),
  ];
  let islandCrack = 0;
  for (const near of mixes) {
    const n = writeTerrainLodIndex(lod.chunks, near, out);
    const m = edgeCounts(out, n);
    let over = 0; for (const c of m.values()) if (c > 4) over++;
    overUsed += Math.max(0, over - fullOver);
    const b = boundaryOf(m);
    for (const k of b) if (!fullBoundary.has(k)) islandCrack++;
    for (const k of fullBoundary) if (!b.has(k)) islandCrack++;
  }
  if (islandCrack > 0) { cracked += islandCrack; crackIslands.push(`${island.id} ${islandCrack}`); }
}
check(badSets === 0, `every island grid is a 24 x 2^k ladder the LOD can chunk (${map.islands.length - badSets}/${map.islands.length})`);
check(fineExact, 'fine chunks are exactly the walkable grid\'s triangles (multiset)');
check(cracked === 0 && overUsed === 0, `any fine/coarse mix is watertight: single-use edges == the grid's own boundary (cracks ${cracked}${crackIslands.length ? `: ${crackIslands.slice(0, 4).join(', ')}` : ''}; edges used > 4 (fin pairs aside) beyond the grid's own: ${overUsed})`);
check(worldCoarse <= worldFine * 0.25, `coarse world ${worldCoarse} tris <= 25% of fine ${worldFine} (${(100 * worldCoarse / Math.max(1, worldFine)).toFixed(1)}%)`);

// 4. the client switch on the biggest island
const big = grids.reduce((a, b) => (b.lod.fineTris > a.lod.fineTris ? b : a));
const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(big.g.positions, 3));
geom.setIndex(new THREE.BufferAttribute(big.g.indices, 1));
const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
mesh.updateMatrixWorld(true);
const sw = new TerrainLodSwitch(mesh, big.lod, 60);
const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 5000);
const at = (x, y, z) => { cam.position.set(x, y, z); cam.updateMatrixWorld(true); sw.update(cam); };
const summit = (() => { let y = -Infinity; let i0 = 0; for (let i = 1; i < big.g.positions.length; i += 3) if (big.g.positions[i] > y) { y = big.g.positions[i]; i0 = i - 1; } return [big.g.positions[i0], y, big.g.positions[i0 + 2]]; })();
at(summit[0], summit[1] + 2, summit[2]);
const nearCount = sw.near.reduce((a, b) => a + b, 0);
const onTris = sw.drawnTris;
check(nearCount > 0 && nearCount < big.lod.chunks.length && onTris < big.lod.fineTris && onTris > big.lod.coarseTris,
  `on ${big.island.id}: ${nearCount}/${big.lod.chunks.length} chunks near, ${onTris} tris drawn (fine ${big.lod.fineTris}, coarse ${big.lod.coarseTris})`);
const r0 = sw.rewrites;
at(summit[0] + 0.3, summit[1] + 2, summit[2] + 0.3);
check(sw.rewrites === r0, 'a 0.4 m step inside the band rewrites nothing');
at(summit[0] + 2000, 50, summit[2]);
check(sw.drawnTris === big.lod.coarseTris, `a camera 2 km away draws the coarse list only (${sw.drawnTris})`);
const ray = new THREE.Raycaster(new THREE.Vector3(summit[0] + 0.7, summit[1] + 50, summit[2] + 0.4), new THREE.Vector3(0, -1, 0));
const hits = ray.intersectObject(mesh, false);
const truth = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', geom.getAttribute('position')).setIndex(new THREE.BufferAttribute(big.g.indices, 1)), mesh.material);
const truthHits = new THREE.Raycaster(ray.ray.origin.clone(), new THREE.Vector3(0, -1, 0)).intersectObject(truth, false);
check(hits.length > 0 && truthHits.length > 0 && Math.abs(hits[0].point.y - truthHits[0].point.y) < 1e-4,
  `raycast hits the full grid while the coarse list is drawn (${hits[0]?.point.y.toFixed(3)} vs ${truthHits[0]?.point.y.toFixed(3)})`);

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — terrain LOD (${passes} passed, ${fails} failed)`);
process.exit(fails === 0 ? 0 : 1);
