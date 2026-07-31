#!/usr/bin/env node
/**
 * THE STORES AT THE PIER HEAD.
 *
 * An audit walked eight legs off a spawn island and fired ZERO loot prompts.
 * The barrels existed — `generateBarrels` makes a fistful per island — but the
 * scatter loop deliberately pushes them inland and swings them a quarter-turn
 * AWAY from the dock, so the one stretch of sand every crew actually crosses on
 * their first hundred steps was the one stretch with nothing on it. Plunder
 * nobody walks past is not plunder, it is set dressing.
 *
 * `MapGenerator.generateBarrels` therefore appends three LANDING STORES per
 * dock, fanned across the dock's own shore ray. This pins that they are still
 * there, still on dry sand, and still where a pirate coming off the pier can
 * see them — because the failure this fixes is invisible in play: a beach with
 * no barrels looks exactly like a beach whose barrels are 90 m inland behind a
 * ridge, and neither one prompts.
 *
 *   node --import tsx scripts/test-landing-stores.mjs
 */
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

console.log('Landing stores — loot where a new crew actually walks');

const islands = new MapGenerator(7).generateIslands();
const docked = islands.filter((i) => i.dock);
expect('the Reach has docked islands to test', docked.length >= 4, `docked=${docked.length}`);

// ── 1. EVERY dock has stores in sight of it ────────────────────────────────
// 40 m is the honest "in sight" number for a beach: the dig-tell work uses 30 m
// as readable-at-a-glance, and a barrel is a bigger silhouette than a mound.
const SIGHT = 40;
let worstIsland = null;
let worstCount = Infinity;
for (const island of docked) {
  const near = island.barrels.filter((b) => dist2(b.position, island.dock.position) <= SIGHT);
  if (near.length < worstCount) { worstCount = near.length; worstIsland = island.name; }
}
expect(`every docked island lands at least 2 barrels within ${SIGHT} m of its pier`,
  worstCount >= 2, `worst: ${worstIsland} with ${worstCount}`);

// ── 2. …and they are on the SHORE ray, not merely close ────────────────────
// A barrel 38 m away round the headland satisfies a radius and still is not on
// the beach you walked onto. The stores are placed against `dock.shoreAngle`,
// so at least two per island must sit within a quarter-turn of it.
let worstFan = null;
let worstFanCount = Infinity;
for (const island of docked) {
  const onRay = island.barrels.filter((b) => {
    if (dist2(b.position, island.dock.position) > SIGHT) return false;
    const a = Math.atan2(b.position.z - island.position.z, b.position.x - island.position.x);
    let d = a - island.dock.shoreAngle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= Math.PI / 4;
  });
  if (onRay.length < worstFanCount) { worstFanCount = onRay.length; worstFan = island.name; }
}
expect('and at least 2 of them sit on the dock\'s own shore ray, not round the headland',
  worstFanCount >= 2, `worst: ${worstFan} with ${worstFanCount}`);

// ── 3. Dry sand, never in the water ────────────────────────────────────────
// A barrel bobbing at the waterline is a bug report, not a prompt. The bar is
// "clear of the water", not the generator's preferred 0.75 m: The Crooked Atoll
// is a ring whose beach stands a bare 0.4 m proud of the lagoon, and holding an
// atoll to a highland's freeboard is how it ended up with no stores at all.
let drowned = 0;
for (const island of docked) {
  for (const b of island.barrels) {
    if (dist2(b.position, island.dock.position) > SIGHT) continue;
    if (getIslandSurfaceY(island, b.position.x, b.position.z) < 0.28) drowned += 1;
  }
}
expect('no landing store is standing in the surf', drowned === 0, `below-waterline barrels: ${drowned}`);

// ── 4. Three stores, not three barrels in one place ────────────────────────
// The fan exists so they read as a small stack of stores; if they collapse onto
// one point the player sees one barrel and the other two are inside it.
let tooTight = 0;
for (const island of docked) {
  const near = island.barrels.filter((b) => dist2(b.position, island.dock.position) <= SIGHT);
  for (let i = 0; i < near.length; i += 1) {
    for (let j = i + 1; j < near.length; j += 1) {
      if (dist2(near[i].position, near[j].position) < 1.2) tooTight += 1;
    }
  }
}
expect('the stores are spread, not stacked inside each other', tooTight === 0, `pairs under 1.2 m: ${tooTight}`);

// ── 5. Determinism — the stores are part of the fixed world ────────────────
// The Reach is the same world every match; loot a player learns the position of
// must not move because the match seed changed.
const again = new MapGenerator(99).generateIslands();
const fingerprint = (list) => JSON.stringify(list.map((i) => i.barrels.map((b) => [
  Math.round(b.position.x * 1000), Math.round(b.position.y * 1000), Math.round(b.position.z * 1000),
])));
expect('barrel placement is identical across match seeds', fingerprint(islands) === fingerprint(again));

// ── 6. Every store is lootable ─────────────────────────────────────────────
// `rollBarrelLoot` runs off the island rng; an empty roll here would be a
// barrel that prompts and gives nothing, which is worse than no barrel.
let empties = 0;
for (const island of docked) {
  for (const b of island.barrels) {
    if (dist2(b.position, island.dock.position) > SIGHT) continue;
    if (b.opened) empties += 1;
    if (!b.loot || (Array.isArray(b.loot) && b.loot.length === 0)) empties += 1;
  }
}
expect('every landing store is unopened and carries loot', empties === 0, `empty/opened: ${empties}`);

console.log(failures === 0
  ? '\nAll landing-store checks passed'
  : `\n${failures} landing-store check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
