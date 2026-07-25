#!/usr/bin/env node
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
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

console.log('Powder keg placement contract');

const match = new Match({ matchId: 'keg-test', botCount: 1 });
const state = match.state;
const ship = state.ships[0];
const stats = SHIP_STATS[ship.type];

function testPlayer(position, onShipId = null) {
  return {
    id: 'player-test',
    onShipId,
    position,
    rotation: { x: 0, y: 0 },
    state: 'alive',
  };
}

const deck = match.toShipWorld(0.2, 0, ship);
const shipPlacement = match.getKegPlacement(testPlayer({
  x: deck.x,
  y: ship.position.y + stats.height + 0.1,
  z: deck.z,
}, ship.id), ship);

expect('On-ship keg placement attaches to the ship', shipPlacement?.shipId === ship.id, JSON.stringify(shipPlacement));
expect('On-ship keg placement stores local coordinates', !!shipPlacement?.localPosition, JSON.stringify(shipPlacement));
expect('On-ship keg placement uses normal fuse time when spawned', SHIP.KEG_FUSE_TIME > 0);

const island = state.islands[0];
const groundY = getIslandSurfaceY(island, island.position.x, island.position.z) + 1;
const groundPlacement = match.getKegPlacement(testPlayer({
  x: island.position.x,
  y: groundY,
  z: island.position.z,
}), null);

expect('Off-ship keg placement becomes a world keg', groundPlacement?.shipId === null, JSON.stringify(groundPlacement));
expect('Off-ship keg placement has no local ship coordinates', groundPlacement?.localPosition === null, JSON.stringify(groundPlacement));
expect('Off-ship keg placement remains above ground or water', !!groundPlacement && groundPlacement.position.y >= 0.45, JSON.stringify(groundPlacement));

const bow = match.toShipWorld(0, stats.length * 0.48, ship);
const worldKeg = {
  id: 'ground-keg-test',
  shipId: null,
  plantedById: 'player-test',
  section: 'bow',
  position: { x: bow.x, y: ship.position.y + stats.height * 0.35, z: bow.z },
  localPosition: null,
  timer: SHIP.KEG_FUSE_TIME,
};
const hits = match.getKegShipHits(worldKeg);
expect('World keg blast can damage nearby ships', hits.some((hit) => hit.ship.id === ship.id), JSON.stringify(hits));
expect('World keg blast resolves impact section logically', hits.find((hit) => hit.ship.id === ship.id)?.section === 'bow', JSON.stringify(hits));

// ── Blast damage ceiling ────────────────────────────────────────────────────
// A keg lit on your own deck used to stove in a plank on every face at once —
// eight fresh breaches, which is past the point where planking or bailing can
// keep up. That is not damage, it is a scuttling, and it made your own keg the
// single most dangerous thing aboard. One blast is capped now.
for (const mega of [false, true]) {
  const blastMatch = new Match({ matchId: `keg-blast-${mega}`, botCount: 1 });
  const target = blastMatch.state.ships[0];
  target.holes = [];
  target.nextHoleId = 1;
  const deckPoint = blastMatch.toShipWorld(0, 0, target);
  blastMatch.explodeKeg({
    id: `blast-${mega}`,
    shipId: target.id,
    plantedById: 'player-test',
    section: 'port',
    position: { x: deckPoint.x, y: target.position.y + SHIP_STATS[target.type].height * 0.4, z: deckPoint.z },
    localPosition: { x: 0, y: 0, z: 0 },
    timer: 0,
    mega,
  });
  const opened = target.holes.filter((hole) => !hole.patched).length;
  expect(
    `${mega ? 'Mega keg' : 'Keg'} opens at most ${SHIP.KEG_MAX_HOLES_PER_BLAST} breaches in one blast`,
    opened <= SHIP.KEG_MAX_HOLES_PER_BLAST,
    `opened=${opened}`,
  );
  expect(`${mega ? 'Mega keg' : 'Keg'} still stoves the hull in`, opened >= 3, `opened=${opened}`);
}

if (failures > 0) {
  console.error(`\n${failures} keg-placement assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll keg-placement assertions passed.');
