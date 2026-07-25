#!/usr/bin/env node
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { FLOODING, SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function makeShip(velocity) {
  return {
    id: 'ship-test',
    type: 'sloop',
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { ...velocity },
    angularVelocity: 0,
    holes: [],
    nextHoleId: 1,
    maxHull: 600,
    repairCooldown: 0,
    autoRepairProgress: 0,
  };
}

function makeRock(x, z) {
  return {
    id: 'rock-test',
    position: { x, y: 0, z },
    radius: 3,
    height: 10,
    rotation: 0,
    variant: 0,
    colliderBoundsRadius: 3,
    colliders: [{
      localX: 0,
      localZ: 0,
      radius: 1.35,
      minY: -3,
      maxY: 9,
    }],
  };
}

/** Which hull face a hull-local breach point lies on. Beam-normalised: a hull
 *  is far longer than it is wide, so a point at the half-beam 3.6 m aft is on
 *  the STARBOARD side, not the stern. */
function holeFace(hole, stats) {
  const bx = Math.abs(hole.x) / (stats.width * 0.5);
  const bz = Math.abs(hole.z) / (stats.length * 0.5);
  return bz >= bx
    ? (hole.z >= 0 ? 'bow' : 'stern')
    : (hole.x >= 0 ? 'starboard' : 'port');
}

function runImpact({ label, section, rock, velocity, expectPoint }) {
  const physics = new PhysicsSystem();
  const ship = makeShip(velocity);
  const stats = SHIP_STATS.sloop;
  physics.pushShipOutOfSeaRock(ship, rock);

  const open = ship.holes.filter((h) => !h.patched);
  expect(`${label}: tears the planking open`, open.length >= 1, `holes=${JSON.stringify(ship.holes)}`);
  // The rock bites at the hull SAMPLE that struck it — the breach point itself
  // must land on the struck face, not merely be tagged with a section name.
  expect(`${label}: every breach lands on the ${section} face`,
    open.length > 0 && open.every((h) => holeFace(h, stats) === section),
    JSON.stringify(open.map((h) => [holeFace(h, stats), +h.x.toFixed(2), +h.z.toFixed(2)])));
  expect(`${label}: breach sits within a metre of the contact point`,
    open.every((h) => Math.hypot(h.x - expectPoint.x, h.z - expectPoint.z) < 1.0),
    `expected ~${JSON.stringify(expectPoint)} got ${JSON.stringify(open.map((h) => [+h.x.toFixed(2), +h.z.toFixed(2)]))}`);
  expect(`${label}: breach rides the waterline band`,
    open.every((h) => h.y >= FLOODING.HOLE_BAND_Y.min - 1e-9 && h.y <= FLOODING.HOLE_BAND_Y.max + 1e-9),
    JSON.stringify(open.map((h) => +h.y.toFixed(3))));
  expect(`${label}: a fresh hit re-arms the field-repair cooldown`,
    ship.repairCooldown > 0, `cooldown=${ship.repairCooldown}`);
}

console.log('Sea rock ship hull-section damage');

runImpact({
  label: 'Bow impact',
  section: 'bow',
  rock: makeRock(0, 7.2),
  velocity: { x: 0, y: 0, z: 6 },
  expectPoint: { x: 0, z: 5.6 },
});

runImpact({
  label: 'Stern impact',
  section: 'stern',
  rock: makeRock(0, -6.35),
  velocity: { x: 0, y: 0, z: -6 },
  expectPoint: { x: 0, z: -5.6 },
});

runImpact({
  label: 'Starboard impact',
  section: 'starboard',
  rock: makeRock(3.15, 0),
  velocity: { x: 6, y: 0, z: 0 },
  expectPoint: { x: 2.6, z: 0 },
});

runImpact({
  label: 'Port impact',
  section: 'port',
  rock: makeRock(-3.15, 0),
  velocity: { x: -6, y: 0, z: 0 },
  expectPoint: { x: -2.6, z: 0 },
});

{
  const physics = new PhysicsSystem();
  const ship = makeShip({ x: 0, y: 0, z: 1.7 });
  physics.pushShipOutOfSeaRock(ship, makeRock(0, 7.2));
  expect('Soft rock bump below damage threshold opens no breach', ship.holes.length === 0,
    JSON.stringify(ship.holes));
}

if (failures > 0) {
  console.error(`\n${failures} sea-rock ship-damage assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll sea-rock ship-damage assertions passed.');
