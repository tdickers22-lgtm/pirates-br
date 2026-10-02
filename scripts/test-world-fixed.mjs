#!/usr/bin/env node
// The Shattered Reach is a DESIGNED world: identical every match, all 14
// roster islands present at their authored spots, with real sailing lanes
// between them and everything inside the storm's opening ring.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandMaxRadius, getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { WORLD } from '../src/shared/constants/index.ts';
import { WORLD_VERSION, hashString } from '../src/shared/staticWorld.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const worldSignature = (islands) => `v${WORLD_VERSION}|` + JSON.stringify(islands.map((island) => ({
  id: island.id,
  name: island.name,
  position: island.position,
  rotation: island.profile.islandHeading,
  caves: island.caves.length,
  bridges: island.bridges?.length ?? 0,
  props: island.props?.length ?? 0,
  dock: island.dock ? [island.dock.position.x, island.dock.position.z] : null,
  // b4.4f: the pin covers the served GROUND and every prop spot, not just the
  // counts. Before this a landform slice (b4.4f moved four islands by up to
  // 15 m) passed the v3 pin unchanged: the gate could not see terrain.
  terrain: terrainFingerprint(island),
  propSpots: hashString((island.props ?? []).map((p) => `${p.type}:${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(';')),
})));
// getIslandSurfaceY on an 8 m grid over the island's max radius + 10%, to 1 cm.
function terrainFingerprint(island) {
  const ext = getIslandMaxRadius(island) * 1.1, out = [];
  for (let x = -ext; x <= ext; x += 8) for (let z = -ext; z <= ext; z += 8) {
    out.push(getIslandSurfaceY(island, island.position.x + x, island.position.z + z).toFixed(2));
  }
  return hashString(out.join(','));
}

const a = new MapGenerator(12345).generateIslands();
const b = new MapGenerator(99999).generateIslands();

console.log('Fixed world:');
expect('all 14 roster islands present', a.length === 14 && new Set(a.map(i => i.name)).size === 14, `${a.length}`);
expect('two different match seeds produce the IDENTICAL world', worldSignature(a) === worldSignature(b));
expect('island ids are stable slugs (learnable, not per-match uuids)',
  a.every(i => /^[a-z0-9-]+$/.test(i.id)), a.map(i => i.id).join(','));
expect('Old Maw Caldera anchors the center', (() => {
  const maw = a.find(i => i.id === 'old-maw-caldera');
  return !!maw && Math.hypot(maw.position.x, maw.position.z) < 1;
})());

// b4.1b (D30, islands-12): the seed join tells clients WORLD_VERSION and they
// regenerate the world, so a world change that keeps the version would give a
// stale client a different world under the same name. One pin per version: a
// world slice bumps WORLD_VERSION (src/shared/staticWorld.ts) and adds its row
// in a re-pin commit that states the signature diff.
// v1-v3 pin the counts-only signature (historical); from v4 the signature
// also hashes the ground (terrainFingerprint) and every prop spot.
const SIGNATURE_PINS = { 1: '83f3f8241a029ccb', 2: '4455b027bde69f13', 3: '5d5eee4df1675b8f', 4: '2dc05c3b8a07a858', 5: '8ce82d7797a0a5dd', 6: 'ce0ce9eab4e39511' }; // v2: b4.4d islet beach rings + cays; v3: b4.4e archetype landforms + no global terracing; v4: b4.4f Smuggler's Rest, Rumrunner Key, Mermaid's Folly, Castaway Reach landforms + ground in the signature; v5: b4.4g Booty Bay, Skull Cove, The Crooked Atoll, Dead Man Shoals, Crow's Perch landforms; v6: b4.4h Kraken Tooth, Gallows Sands, Widow's Watch, Parley Point, Old Maw landforms
const signatureHash = hashString(worldSignature(a));
expect(`the fixed-world signature is pinned for WORLD_VERSION ${WORLD_VERSION}`,
  SIGNATURE_PINS[WORLD_VERSION] === signatureHash,
  `signature hash ${signatureHash} vs pin ${SIGNATURE_PINS[WORLD_VERSION]}: a world change must bump WORLD_VERSION and add a pin row`);

console.log('Layout invariants:');
const MIN_LANE = 70; // meters of open water between any two island footprints
let laneOk = true;
let laneDetail = '';
for (let i = 0; i < a.length; i++) {
  for (let j = i + 1; j < a.length; j++) {
    const d = Math.hypot(a[i].position.x - a[j].position.x, a[i].position.z - a[j].position.z);
    const need = getIslandMaxRadius(a[i]) + getIslandMaxRadius(a[j]) + MIN_LANE;
    if (d < need) {
      laneOk = false;
      laneDetail += `\n     ${a[i].id} <-> ${a[j].id}: ${d.toFixed(0)}m < ${need.toFixed(0)}m`;
    }
  }
}
expect(`every island pair keeps a ≥${MIN_LANE}m sailing lane`, laneOk, laneDetail);

let boundsOk = true;
let boundsDetail = '';
for (const island of a) {
  const reach = Math.hypot(island.position.x, island.position.z) + getIslandMaxRadius(island);
  if (reach > WORLD.HALF - 15) { boundsOk = false; boundsDetail += `\n     ${island.id}: reach ${reach.toFixed(0)}`; }
}
expect('every island fits inside the opening storm ring', boundsOk, boundsDetail);

expect('at least one bridge island made it in', a.some(i => (i.bridges?.length ?? 0) > 0));
expect('taverns mark the lanes (≥3 tavern islands)', a.filter(i => i.tavern !== null).length >= 3);

// ── Side streams never move the world ──────────────────────────────────────
// Naming the bot crews draws random numbers. If those draws came off the world
// generator's own stream, adding a tenth crew would shift every island, cave
// and prop in the designed archipelago — so crew naming runs on a private
// generator derived from the seed, and this proves it stays private.
console.log('Naming streams:');
const namedFirst = new MapGenerator(12345);
namedFirst.generateBotCrewNames(9);
expect('naming the crews first leaves the world bit-identical',
  worldSignature(namedFirst.generateIslands()) === worldSignature(a));
const namedBetween = new MapGenerator(12345);
namedBetween.generateBotCrewNames(3);
namedBetween.generateBotCrewNames(40);
expect('any number of naming draws leaves the world bit-identical',
  worldSignature(namedBetween.generateIslands()) === worldSignature(a));
const gen = new MapGenerator(777);
const before = gen.generateIslands();
expect('and generating the world does not move the crew list either',
  JSON.stringify(gen.generateBotCrewNames(9))
  === JSON.stringify(new MapGenerator(777).generateBotCrewNames(9)),
  `${before.length} islands drawn between`);

if (failures > 0) { console.error(`\n${failures} world assertion(s) failed.`); process.exit(1); }
console.log('\nThe Shattered Reach is fixed, spaced, and in bounds.');
