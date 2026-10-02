#!/usr/bin/env node
// b4.7c gate (islands-04): points of interest on the static world (seed 20260801).
//   - POI count per island >= the PLAN 3.14 table (r < 50: 3, 50..75: 5, > 75: 7);
//   - footprints clear of each other, of cave mouths, of the dock, of props and of cliff-kit hulls;
//   - every POI stands in the dock's walk component (the landing beach's on dockless islands) on a
//     2 m walk flood fill, i.e. reachable on foot from where a crew lands (archipelagos: any islet
//     beach, the sea-join rule of test-island-climb: a swimmer lands on any beach);
//   - every POI has its stamp (flat core: relief <= 0.35 m over the footprint), a loot hook inside
//     the footprint and a trail link on its edge;
//   - same seed -> identical POIs.
// Usage: node --import tsx scripts/test-island-props-poi.mjs [--mutate=no-pois|no-stamp]
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { resolvePropCollision } from '../src/shared/props.ts';
import { buildWalkGrid, gridCellAt, landingComponent } from '../src/server/world/placement/climbs.ts';
import { islandPois, poiTarget, POI_FOOTPRINT_M } from '../src/server/world/placement/pois.ts';

const mutate = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
let passed = 0;
let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passed++; else { failed++; console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`); }
};
const t0 = Date.now();
const islands = new MapGenerator(20260801).generateIslands();
const genMs = Date.now() - t0;
if (mutate === 'no-pois') for (const i of islands) i.pois = [];
if (mutate === 'no-stamp') for (const i of islands) {
  const ps = islandPois(i);
  i.stamps = (i.stamps ?? []).filter((s) => !ps.some((p) => Math.hypot(s.x - p.x, s.z - p.z) < 0.01));
}

const kinds = {};
let total = 0;
for (const isl of islands) {
  const pois = islandPois(isl);
  total += pois.length;
  const need = poiTarget(isl.radius);
  ok(pois.length >= need, `[count] ${isl.id} r ${isl.radius} has >= ${need} POIs`, `${pois.length}`);
  const g = buildWalkGrid(isl, 2);
  let home = -1;
  const dock = isl.dock?.respawnPoint;
  if (dock) {
    let best = Infinity;
    for (let k = 0; k < g.n * g.n; k++) {
      if (!g.walk[k]) continue;
      const d = Math.hypot(g.x0 + (k % g.n) * g.step - dock.x, g.z0 + Math.floor(k / g.n) * g.step - dock.z);
      if (d < best && d < 18) { best = d; home = g.comp[k]; }
    }
  }
  if (home < 0) home = landingComponent(g);
  const mouths = isl.caves.filter((c) => c.hasMouth !== false).map((c) => c.position);
  for (const [i, p] of pois.entries()) {
    kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const tag = `${p.id} ${p.kind}`;
    ok(POI_FOOTPRINT_M[p.kind] === p.r, `[kind] ${tag} footprint from the kind table`);
    for (const q of pois.slice(i + 1)) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      ok(d >= p.r + q.r, `[overlap] ${tag} clear of ${q.id}`, `${d.toFixed(1)} < ${p.r + q.r}`);
    }
    for (const m of mouths) {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      const min = p.r + (p.kind === 'grotto_landing' ? 3 : 6);
      ok(d >= min, `[cave] ${tag} clear of a cave mouth`, `${d.toFixed(1)} < ${min}`);
    }
    if (isl.dock) {
      const d = Math.min(Math.hypot(p.x - isl.dock.position.x, p.z - isl.dock.position.z), Math.hypot(p.x - isl.dock.respawnPoint.x, p.z - isl.dock.respawnPoint.z));
      ok(d >= p.r + 6, `[dock] ${tag} clear of the dock`, `${d.toFixed(1)}`);
    }
    // Flat stamped core.
    const ys = [];
    for (const f of [0, 0.5, 0.9]) for (let a = 0; a < 12; a++) {
      const t = (a / 12) * Math.PI * 2;
      ys.push(getIslandSurfaceY(isl, p.x + Math.sin(t) * p.r * f, p.z + Math.cos(t) * p.r * f));
    }
    const relief = Math.max(...ys) - Math.min(...ys);
    ok(relief <= 0.35, `[stamp] ${tag} footprint flat (stamped)`, `relief ${relief.toFixed(2)} m`);
    ok(Math.abs(getIslandSurfaceY(isl, p.x, p.z) - p.y) <= 0.05, `[stamp] ${tag} y on the ground`, `${p.y} vs ${getIslandSurfaceY(isl, p.x, p.z).toFixed(2)}`);
    // Reachable on foot from the landing.
    const c = gridCellAt(g, p.x, p.z);
    const islet = isl.profile.terrainStyle === 'archipelago' && c >= 0 && g.shore.has(g.comp[c]) && g.sizes[g.comp[c]] * 4 >= 54;
    ok(c >= 0 && home >= 0 && (g.comp[c] === home || islet), `[reach] ${tag} in the landing walk component${islet ? ' (archipelago islet beach)' : ''}`, `comp ${c >= 0 ? g.comp[c] : 'off-grid'} home ${home}`);
    // Clear of props and cliff-kit hulls (core of the footprint).
    const push = resolvePropCollision({ x: p.x, y: p.y + 0.9, z: p.z }, p.r * 0.6, isl);
    ok(!push.pushed, `[solid] ${tag} core clear of props and kit hulls`);
    const prop = (isl.props ?? []).find((q) => Math.hypot(q.x - p.x, q.z - p.z) < p.r);
    ok(!prop, `[props] ${tag} no prop inside the footprint`, prop ? prop.type : '');
    // Hooks.
    const ld = Math.hypot(p.loot.x - p.x, p.loot.z - p.z);
    ok(ld <= p.r && (p.loot.bias === 'chest' || p.loot.bias === 'barrel'), `[loot] ${tag} loot hook inside the footprint`, `${ld.toFixed(1)} ${p.loot.bias}`);
    const kd = Math.hypot(p.link.x - p.x, p.link.z - p.z);
    ok(kd >= p.r && kd <= p.r + 1.5, `[trail] ${tag} trail link on the footprint edge`, `${kd.toFixed(1)}`);
  }
}
ok(total >= 60, 'world POI total', `${total}`);
ok(Object.keys(kinds).length >= 8, 'world uses >= 8 POI kinds', JSON.stringify(kinds));
const again = new MapGenerator(20260801).generateIslands();
ok(mutate !== '' || JSON.stringify(again.map(islandPois)) === JSON.stringify(islands.map(islandPois)), '[determinism] same seed, same POIs');

console.log(`POIs ${total} ${JSON.stringify(kinds)}; world gen ${genMs} ms`);
console.log(`test-island-props-poi: ${passed} passed, ${failed} failed`);
console.log(failed === 0 && passed > 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 && passed > 0 ? 0 : 1);
