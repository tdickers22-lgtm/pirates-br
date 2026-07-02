#!/usr/bin/env node
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { PLAYER, SHIP_STATS } from '../src/shared/constants/index.ts';
import { isInsideSwimHullFootprint, getSwimHullVerticalBand } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function toShipWorld(local, ship) {
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return {
    x: ship.position.x + local.x * cos + local.z * sin,
    y: ship.position.y + local.y,
    z: ship.position.z + local.z * cos - local.x * sin,
  };
}

function toShipLocal(position, ship) {
  const dx = position.x - ship.position.x;
  const dz = position.z - ship.position.z;
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos,
  };
}

function makeShip(type = 'sloop') {
  const stats = SHIP_STATS[type];
  return {
    id: 'ship-test',
    type,
    ownerId: 'player-test',
    crewIds: ['player-test'],
    position: { x: 30, y: 0, z: -18 },
    rotation: Math.PI * 0.21,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    sailHeight: 0,
    sailAngle: 0,
    anchored: true,
    anchorRaiseProgress: 0,
    hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
    maxHull: stats.maxHull,
    onFire: false,
    fireTimer: 0,
    fireDamageAccum: 0,
    sinkProgress: 0,
    sinking: false,
    cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0,
    sailIntegrity: 1,
    sailRepairWoodTimer: 0,
    gold: 0,
    treasureChestIds: [],
    inventory: [],
    repairCooldown: 0,
    autoRepairProgress: 0,
    teamColor: 0x3366cc,
    alive: true,
    upgrades: [],
  };
}

function makeSwimmingPlayer(position) {
  return {
    id: 'player-test',
    name: 'Tester',
    shipId: 'ship-test',
    position,
    rotation: { x: 0, y: 0 },
    velocity: { x: -2.5, y: 0.25, z: 0 },
    health: PLAYER.MAX_HEALTH,
    state: 'swimming',
    weapons: [],
    activeSlot: 0,
    reloading: false,
    reloadTimer: 0,
    knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false,
    kills: 0,
    playerKillStreak: 0,
    superCannonballs: 0,
    megaKegs: 0,
    tsunamiCharges: 0,
    gold: 0,
    carryingChestId: null,
    treasureMapIslandId: null,
    swimTimer: 3,
    atCannon: false,
    atHelm: false,
    atSails: false,
    sailControlMode: null,
    atCrowNest: false,
    blocking: false,
    cutlassCharge: 0,
    cannonIndex: 0,
    nearChestId: null,
    nearShipId: null,
    onShipId: null,
    respawnTimer: 0,
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
    lastDamagedById: null,
    lastDamageWasHeadshot: false,
    selectedCannonAmmo: 'cannonball',
    kegs: 0,
    kegCooldown: 0,
    cannonFlightTimer: 0,
    cannonBallistic: false,
    pocketBanana: 0,
    pocketWood: 0,
    pocketCoconut: 0,
    pocketMango: 0,
    pocketMeat: 0,
    pocketUseCooldown: 0,
    hasShovel: true,
    nearBarrelId: null,
  };
}

function runOneFrame(player, ship) {
  const physics = new PhysicsSystem();
  physics.update(1 / 30, 0.5, [ship], [player], [], [], []);
}

console.log('Swimmer ship-hull collision');

{
  const ship = makeShip('sloop');
  const stats = SHIP_STATS[ship.type];
  const player = makeSwimmingPlayer(toShipWorld({
    x: stats.width * 0.45,
    y: stats.height * 0.34,
    z: -stats.length * 0.18,
  }, ship));

  runOneFrame(player, ship);
  const localAfter = toShipLocal(player.position, ship);

  expect('Side/ladder underside keeps swimmer off the ship', player.onShipId === null && player.state === 'swimming', `state=${player.state} onShipId=${player.onShipId}`);
  expect('Side/ladder underside pushes outside the hull side', localAfter.x > stats.width * 0.56, `localX=${localAfter.x.toFixed(2)}`);
  expect('Boarding prompt remains available after collision push', player.nearShipId === ship.id, `nearShipId=${player.nearShipId}`);
}

{
  const ship = makeShip('sloop');
  const stats = SHIP_STATS[ship.type];
  const player = makeSwimmingPlayer(toShipWorld({
    x: 0,
    y: stats.height * 0.34,
    z: stats.length * 0.5,
  }, ship));

  runOneFrame(player, ship);
  const localAfter = toShipLocal(player.position, ship);

  expect('Bow underside keeps swimmer off the ship', player.onShipId === null && player.state === 'swimming', `state=${player.state} onShipId=${player.onShipId}`);
  expect('Bow underside pushes forward out of the hull', localAfter.z > stats.length * 0.52, `localZ=${localAfter.z.toFixed(2)}`);
}

{
  const ship = makeShip('sloop');
  const stats = SHIP_STATS[ship.type];
  const deepY = -stats.height * 0.95;
  const player = makeSwimmingPlayer(toShipWorld({
    x: 0,
    y: deepY,
    z: 0,
  }, ship));

  runOneFrame(player, ship);
  const localAfter = toShipLocal(player.position, ship);

  expect('Deep swimmer can still pass under the keel', Math.abs(localAfter.x) < 0.2 && Math.abs(localAfter.z) < 0.2, `local=(${localAfter.x.toFixed(2)}, ${localAfter.z.toFixed(2)})`);
}

// Bottom-approach: a swimmer just under the keel at dead center, swimming straight
// UP into the hull, must NOT end up inside the ship. Whatever the one-frame
// integration does, the invariant holds: after resolution the swimmer is never
// left inside the hull footprint within the vertical band, and is never boarded.
// (This is the "swim into the ship from the bottom of the hull" fix.)
{
  const ship = makeShip('sloop');
  const stats = SHIP_STATS[ship.type];
  const band = getSwimHullVerticalBand(ship.position.y, stats);
  const player = makeSwimmingPlayer(toShipWorld({
    x: 0,
    y: (band.keelY - ship.position.y) - 0.15, // local y so world y sits just below the keel
    z: 0,
  }, ship));
  player.velocity = { x: 0, y: 3.5, z: 0 }; // swimming straight up into the hull

  runOneFrame(player, ship);
  const localAfter = toShipLocal(player.position, ship);
  const inFootprint = isInsideSwimHullFootprint(stats, localAfter.x, localAfter.z, 0);
  const inBand = player.position.y > band.keelY && player.position.y < band.deckY;

  expect(
    'Bottom-approach swimmer never ends up inside the hull',
    !(inFootprint && inBand),
    `local=(${localAfter.x.toFixed(2)}, ${localAfter.z.toFixed(2)}) y=${player.position.y.toFixed(2)} band=[${band.keelY.toFixed(2)}, ${band.deckY.toFixed(2)}]`,
  );
  expect('Bottom-approach swimmer is not boarded', player.onShipId === null && player.state === 'swimming', `state=${player.state} onShipId=${player.onShipId}`);
}

if (failures > 0) {
  console.error(`\n${failures} swimmer ship-collision assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll swimmer ship-collision assertions passed.');
