#!/usr/bin/env node
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  findNearbyCannonIndex,
  getAnchorControlLocal,
  getCannonDeckLocalPosition,
  getSailControlLocal,
  isNearAnchor,
  isNearCrowNestLadder,
  isNearHelm,
  isNearSailStation,
  toShipWorldPoint,
} from '../src/shared/interactions.ts';
import { getMainMastLocalZ } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const ship = {
  id: 'ship-test',
  type: 'galleon',
  position: { x: 120, y: 1.5, z: -80 },
  rotation: Math.PI * 0.18,
};
const stats = SHIP_STATS[ship.type];

function playerAt(local, extra = {}) {
  const world = toShipWorldPoint(local, ship);
  return {
    onShipId: ship.id,
    position: {
      x: world.x,
      y: ship.position.y + stats.height + 0.1,
      z: world.z,
    },
    ...extra,
  };
}

console.log('Shared ship interaction predicates');

expect('Helm prompt and server validation share one predicate', isNearHelm(playerAt({ x: 0, z: -stats.length * 0.37 }), ship));
expect('Sail ring predicate accepts the shared sail control point', isNearSailStation(playerAt(getSailControlLocal(stats)), ship));
expect('Anchor predicate accepts the shared capstan point', isNearAnchor(playerAt(getAnchorControlLocal(stats)), ship));
expect(
  'Crow ladder predicate accepts the main mast ladder band',
  isNearCrowNestLadder(playerAt({ x: 0.1, z: getMainMastLocalZ(stats) }), ship),
);

const cannonLocal = getCannonDeckLocalPosition(stats, 0);
expect('Cannon index resolves when standing at cannon deck point', findNearbyCannonIndex(playerAt(cannonLocal), ship) === 0);
expect('Wrong ship never validates helm', !isNearHelm({ ...playerAt({ x: 0, z: -stats.length * 0.37 }), onShipId: 'other' }, ship));
expect('Low/below-deck sail ring position is rejected', !isNearSailStation(playerAt(getSailControlLocal(stats), {
  position: {
    ...playerAt(getSailControlLocal(stats)).position,
    y: ship.position.y + stats.height - 0.5,
  },
}), ship));

if (failures > 0) {
  console.error(`\n${failures} ship-interaction assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll ship-interaction assertions passed.');
