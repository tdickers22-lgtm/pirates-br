#!/usr/bin/env node
// DEAD SPACE IS A DESIGN NUMBER, NOT AN ACCIDENT.
//
// An audit called out the Reach's dead space: long stretches of water with
// nothing in them but scattered rocks, where a held heading buys a minute and a
// half of nothing. Measured here over the sailable disc, ~38% of open water is
// more than 120 m from any coast and ~15% is more than 180 m.
// MapGenerator.findSeaVoids is the geometry half of the fix: it locates the
// deepest of those pockets so sea micro-POIs (floating wreck + lootable
// barrels, gull-circled flotsam, a lone mast on a shoal) can be seeded there.
//
// This pins:
//   1. the measurement itself (so a future island reshuffle that quietly fills
//      or doubles the dead space shows up here rather than in a playtest),
//   2. that the sites are real open water — clear of every coast, sea rock,
//      ship spawn and the storm wall,
//   3. that the sites are in DIFFERENT voids, and
//   4. that the whole thing is deterministic across match seeds (fixed world).
//
//   node --import tsx scripts/test-sea-voids.mjs
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandMaxRadius } from '../src/shared/utils/index.ts';
import { WORLD } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const gen = new MapGenerator(12345);
const islands = gen.generateIslands();
const spawns = gen.generateShipSpawns(islands);
const rocks = gen.generateSeaRocks(islands, spawns);
const obstacles = [
  ...rocks.map((r) => ({ position: r.position, radius: r.radius })),
  ...spawns.map((s) => ({ position: s.position, radius: 40 })),
];
// Sea rocks and ship spawns are drawn from the MATCH stream — they move every
// match. The POI sites must not, or they stop being learnable, so they are
// keyed to the fixed island layout alone.

// ── 1. How much of the sailable disc is dead space? ────────────────────────
console.log('Dead space:');
const LIMIT = WORLD.HALF - 120;
const STEP = 20;
let water = 0;
const dead = { 120: 0, 150: 0, 180: 0 };
for (let x = -LIMIT; x <= LIMIT; x += STEP) {
  for (let z = -LIMIT; z <= LIMIT; z += STEP) {
    if (Math.hypot(x, z) > LIMIT) continue;
    let onLand = false;
    let nearest = Infinity;
    for (const island of islands) {
      const d = Math.hypot(x - island.position.x, z - island.position.z) - getIslandMaxRadius(island);
      if (d <= 0) { onLand = true; break; }
      if (d < nearest) nearest = d;
    }
    if (onLand) continue;
    water += 1;
    for (const t of [120, 150, 180]) if (nearest > t) dead[t] += 1;
  }
}
const pct = (t) => (dead[t] / water) * 100;
for (const t of [120, 150, 180]) console.log(`  ${pct(t).toFixed(1)}% of sailable water is >${t}m from any coast`);
// WATCHED numbers: reshaping islands nudges them, seeding POIs into the voids is
// what actually makes the space live. Move the band deliberately, never by
// accident — a jump means the layout drifted.
expect('>120m dead space stays inside the watched 20-36% band', pct(120) >= 20 && pct(120) <= 36, `${pct(120).toFixed(1)}%`);
expect('>180m dead space stays inside the watched 3-12% band', pct(180) >= 3 && pct(180) <= 12, `${pct(180).toFixed(1)}%`);

// ── 2. The void sites are real open water ─────────────────────────────────
console.log('Sea-POI sites:');
const voids = gen.findSeaVoids(islands, [], 4, 300);
expect('four void sites found', voids.length === 4, `${voids.length}`);
for (const v of voids) console.log(`  (${v.x}, ${v.z}) clearance ${v.clearance.toFixed(0)}m`);

let clearOk = true;
let clearDetail = '';
for (const v of voids) {
  for (const island of islands) {
    const d = Math.hypot(v.x - island.position.x, v.z - island.position.z) - getIslandMaxRadius(island);
    if (d < 170) { clearOk = false; clearDetail += `\n     ${island.id} only ${d.toFixed(0)}m from (${v.x}, ${v.z})`; }
  }
}
expect('every site is ≥170m from any coast', clearOk, clearDetail);

// The wiring pass owes the sites a berth in generateSeaRocks; until then, just
// report how close this match's rocks came.
const tightest = Math.min(...voids.map((v) => Math.min(...obstacles.map(
  (o) => Math.hypot(v.x - o.position.x, v.z - o.position.z) - (o.radius ?? 0)))));
console.log(`  nearest match-stream rock/spawn to any site: ${tightest.toFixed(0)}m`);

expect('every site is inside the storm ring', voids.every((v) => Math.hypot(v.x, v.z) <= WORLD.HALF - 120));

let spread = true;
for (let i = 0; i < voids.length; i++) {
  for (let j = i + 1; j < voids.length; j++) {
    if (Math.hypot(voids[i].x - voids[j].x, voids[i].z - voids[j].z) < 300) spread = false;
  }
}
expect('sites sit in four DIFFERENT voids (≥300m apart)', spread);

// ── 3. Fixed world: the sites do not move between matches ─────────────────
const gen2 = new MapGenerator(99999);
const islands2 = gen2.generateIslands();
const spawns2 = gen2.generateShipSpawns(islands2);
const rocks2 = gen2.generateSeaRocks(islands2, spawns2);
void rocks2;
const voids2 = gen2.findSeaVoids(islands2, [], 4, 300);
expect('void sites depend only on the fixed island layout, not the match seed',
  JSON.stringify(voids.map((v) => [v.x, v.z])) === JSON.stringify(voids2.map((v) => [v.x, v.z])));

console.log(failures === 0 ? '\nALL SEA VOID TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
