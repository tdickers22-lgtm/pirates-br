#!/usr/bin/env node
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';

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
    hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
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

function runImpact({ label, section, rock, velocity }) {
  const physics = new PhysicsSystem();
  const ship = makeShip(velocity);
  physics.pushShipOutOfSeaRock(ship, rock);

  expect(`${label}: damages ${section}`, ship.hull[section] < 0.99, `${section}=${ship.hull[section]}`);
  for (const other of ['bow', 'stern', 'port', 'starboard']) {
    if (other === section) continue;
    expect(`${label}: leaves ${other} untouched`, ship.hull[other] === 1, `${other}=${ship.hull[other]}`);
  }
}

console.log('Sea rock ship hull-section damage');

runImpact({
  label: 'Bow impact',
  section: 'bow',
  rock: makeRock(0, 7.2),
  velocity: { x: 0, y: 0, z: 6 },
});

runImpact({
  label: 'Stern impact',
  section: 'stern',
  rock: makeRock(0, -6.35),
  velocity: { x: 0, y: 0, z: -6 },
});

runImpact({
  label: 'Starboard impact',
  section: 'starboard',
  rock: makeRock(3.15, 0),
  velocity: { x: 6, y: 0, z: 0 },
});

runImpact({
  label: 'Port impact',
  section: 'port',
  rock: makeRock(-3.15, 0),
  velocity: { x: -6, y: 0, z: 0 },
});

{
  const physics = new PhysicsSystem();
  const ship = makeShip({ x: 0, y: 0, z: 1.7 });
  physics.pushShipOutOfSeaRock(ship, makeRock(0, 7.2));
  expect('Soft rock bump below damage threshold does not hurt hull', ship.hull.bow === 1, `bow=${ship.hull.bow}`);
}

if (failures > 0) {
  console.error(`\n${failures} sea-rock ship-damage assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll sea-rock ship-damage assertions passed.');
