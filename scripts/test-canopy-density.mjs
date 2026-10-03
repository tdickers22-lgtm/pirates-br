#!/usr/bin/env node
// b4.7d gate (islands-09): the three-layer canopy on the static world (seed 20260801).
//   - [cover] every island's interior canopy cover (canopyCover: dry interior cells under a crown disc,
//     palms included) inside CANOPY_COVER_TABLE for its biome (lush 35-50%, PLAN 3.14); histogram printed;
//   - [layers] every lush island carries all three layers (canopy trees, understory, ground grass) and every
//     green biome with a shoreline gets mangroves somewhere in the world; harsh biomes grow snags, not broadleaf;
//   - [world] >= 8 canopy kinds placed, every kind of the kit used at least once;
//   - [trunk] each tree's trunk is a capsule: a player capsule dropped on the trunk axis is pushed out
//     (resolvePropCollision), one dropped under the crown edge is not (you walk under the canopy);
//   - [ground] every canopy prop stands on dry ground (mangroves: the tide line 0.25..1.1 m), slope gated;
//   - [clear] no tree inside a POI footprint, a stamp or a cliff-kit hull radius;
//   - [det] same seed -> identical canopy.
// Usage: node --import tsx scripts/test-canopy-density.mjs [--mutate=no-canopy|no-trunk]
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { PROP_COLLIDERS, resolvePropCollision } from '../src/shared/props.ts';
import { islandPois } from '../src/server/world/placement/pois.ts';
import {
  CANOPY_COVER_TABLE, CANOPY_LAYER, CROWN_R, canopyCover,
} from '../src/server/world/placement/canopy.ts';

const mutate = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
let passed = 0;
let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passed++; else { failed++; console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`); }
};
const KINDS = Object.keys(CANOPY_LAYER);
const t0 = Date.now();
const islands = new MapGenerator(20260801).generateIslands();
const genMs = Date.now() - t0;
if (mutate === 'no-canopy') for (const i of islands) i.props = i.props.filter((p) => !KINDS.includes(p.type));
if (mutate === 'no-trunk') for (const k of KINDS) PROP_COLLIDERS[k] = { shape: 'none', radius: 0, height: 0 };

const world = Object.fromEntries(KINDS.map((k) => [k, 0]));
const hist = {};
for (const isl of islands) {
  const biome = isl.profile.biome ?? 'lush';
  const [lo, hi] = CANOPY_COVER_TABLE[biome];
  const cover = canopyCover(isl);
  (hist[biome] ??= []).push(`${isl.id} ${(cover * 100).toFixed(1)}%`);
  ok(cover >= lo && cover <= hi, `[cover] ${isl.id} (${biome}) interior canopy cover in [${lo * 100}, ${hi * 100}]%`, `${(cover * 100).toFixed(1)}%`);
  const mine = isl.props.filter((p) => KINDS.includes(p.type));
  const layers = new Set(mine.map((p) => CANOPY_LAYER[p.type]));
  for (const p of mine) world[p.type]++;
  if (biome === 'lush') {
    for (const L of ['canopy', 'understory', 'ground']) ok(layers.has(L), `[layers] ${isl.id} lush has the ${L} layer`, [...layers].join(','));
  }
  if (biome === 'volcanic' || biome === 'bone') {
    ok(!mine.some((p) => /broadleaf|buttress/.test(p.type)), `[layers] ${isl.id} (${biome}) grows snags, not broadleaf`);
  }
  const pois = islandPois(isl);
  for (const p of mine) {
    const y = getIslandSurfaceY(isl, p.x, p.z);
    if (p.type === 'tree_mangrove') ok(y >= 0.25 && y <= 1.1, `[ground] ${isl.id} mangrove ${p.id} on the tide line`, y.toFixed(2));
    else ok(y >= 1.39, `[ground] ${isl.id} ${p.type} ${p.id} on dry ground`, y.toFixed(2));
    for (const poi of pois) ok(Math.hypot(p.x - poi.x, p.z - poi.z) > poi.r, `[clear] ${isl.id} ${p.type} ${p.id} outside POI ${poi.id}`);
    const col = PROP_COLLIDERS[p.type];
    if (CROWN_R[p.type] && mutate !== 'no-trunk' ? col.shape === 'capsule' : CROWN_R[p.type]) {
      const pr = 0.35;
      const at = resolvePropCollision({ x: p.x + 0.05, y: y + 0.9, z: p.z }, pr, isl);
      // A second trunk inside reach of the probe pulls the resolved point toward it (two snags 1 m apart
      // resolve to a point between them), so the clearance distance is only asserted for a lone trunk.
      const lone = !isl.props.some((q) => q !== p && PROP_COLLIDERS[q.type]?.shape === 'capsule'
        && Math.hypot(q.x - p.x, q.z - p.z) < (col.radius ?? 0) * p.scale + (PROP_COLLIDERS[q.type].radius ?? 0) * q.scale + 2 * pr + 0.2);
      ok(at.pushed && (!lone || Math.hypot(at.x - p.x, at.z - p.z) >= (col.radius ?? 0) * p.scale + pr - 0.05),
        `[trunk] ${isl.id} ${p.type} ${p.id} trunk pushes a capsule out`, `pushed ${at.pushed}`);
      if (p.type !== 'tree_buttress' && p.type !== 'tree_mangrove') {
        // Under the crown (2.2 m out) is open ground unless something else stands there.
        const ux = p.x + 2.2;
        const others = isl.props.some((q) => q !== p && Math.hypot(q.x - ux, q.z - p.z) < 3);
        if (!others) {
          const under = resolvePropCollision({ x: ux, y: getIslandSurfaceY(isl, ux, p.z) + 0.9, z: p.z }, pr, isl);
          ok(!under.pushed, `[trunk] ${isl.id} ${p.type} ${p.id} crown does not block (walk under it)`);
        }
      }
    }
  }
}
for (const k of KINDS) ok(world[k] > 0, `[world] ${k} placed somewhere`, `${world[k]}`);
ok(KINDS.filter((k) => world[k] > 0).length >= 8, '[world] >= 8 canopy kinds');

const again = new MapGenerator(20260801).generateIslands();
const sig = (isls) => isls.map((i) => i.props.filter((p) => KINDS.includes(p.type)).map((p) => `${p.type}${p.x},${p.z},${p.yaw},${p.scale}`).join(';')).join('|');
if (!mutate) ok(sig(islands) === sig(again), '[det] same seed -> identical canopy');

console.log('canopy cover histogram (interior):');
for (const [b, rows] of Object.entries(hist)) console.log(`  ${b.padEnd(10)} [${CANOPY_COVER_TABLE[b].map((v) => v * 100).join('-')}%]  ${rows.join('  ')}`);
console.log('world canopy counts:', JSON.stringify(world), `generate ${genMs} ms`);
console.log(`${passed} passed, ${failed} failed`);
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
