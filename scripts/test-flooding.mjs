#!/usr/bin/env node
// SoT naval damage loop, PURELY hole-based: ingress from open holes below the
// waterline, weight of water (speed/rudder/freeboard), bailing vs holes, passive
// pump, sink-by-flood, fire dousing, and chainshot (rigging-only, no hull holes).
import {
  PhysicsSystem,
  applyShipRudderSteering,
  evaluateSectionFlood,
  shipIngressRate,
  updateShipFlooding,
} from '../src/server/systems/PhysicsSystem.ts';
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS, FLOODING, SHIP_UPGRADES, PLAYER } from '../src/shared/constants/index.ts';
import { angleWrap, sampleWind } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 60;

function makeShip(type = 'sloop', overrides = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: `ship-${Math.random().toString(36).slice(2, 8)}`,
    type,
    ownerId: 'owner',
    crewIds: [],
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    sailHeight: 0,
    sailAngle: 0,
    anchored: false,
    anchorRaiseProgress: 0,
    holes: { bow: 0, stern: 0, port: 0, starboard: 0 },
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
    pitch: 0,
    roll: 0,
    heave: 0,
    waterLevel: 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('Ingress: two open holes (port + starboard) sink an untended ship');

/** Untended fill time (seconds) for a level ship with two lateral holes. */
function untendedFillTime(type) {
  const ship = makeShip(type, {
    position: { x: 0, y: -0.2, z: 0 }, // sitting a touch low: lateral holes below the line
    holes: { bow: 0, stern: 0, port: 1, starboard: 1 },
  });
  const flooding = evaluateSectionFlood(ship, 0).filter((s) => s.flooding).map((s) => s.section);
  let t = 0;
  for (let i = 0; i < 200 * 60 && (ship.waterLevel ?? 0) < 1; i++) {
    updateShipFlooding(ship, 0, DT);
    t += DT;
  }
  return { t, floodingSections: flooding };
}

{
  const sloop = untendedFillTime('sloop');
  expect('exactly the two holed sections flood (bow/stern intact stay dry)',
    sloop.floodingSections.length === 2
    && sloop.floodingSections.includes('port')
    && sloop.floodingSections.includes('starboard'),
    `flooding=${JSON.stringify(sloop.floodingSections)}`);
  expect('sloop: two open holes founder it in ~55–80 s untended',
    sloop.t >= 55 && sloop.t <= 80, `t=${sloop.t.toFixed(1)}s`);

  const galleon = untendedFillTime('galleon');
  expect('galleon: two open holes founder it in ~82–115 s untended',
    galleon.t >= 82 && galleon.t <= 115, `t=${galleon.t.toFixed(1)}s`);
  expect('bigger hull floods slower (galleon > sloop)',
    galleon.t > sloop.t, `sloop=${sloop.t.toFixed(1)} galleon=${galleon.t.toFixed(1)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nMore holes flood faster; a reinforced hull seeps slower');

{
  const two = makeShip('sloop', { position: { x: 0, y: -0.3, z: 0 }, holes: { bow: 0, stern: 0, port: 1, starboard: 1 } });
  const three = makeShip('sloop', { position: { x: 0, y: -0.3, z: 0 }, holes: { bow: 1, stern: 0, port: 1, starboard: 1 } });
  expect('three open holes gush faster than two', shipIngressRate(three, 0) > shipIngressRate(two, 0),
    `two=${shipIngressRate(two, 0).toFixed(4)} three=${shipIngressRate(three, 0).toFixed(4)}`);
  const reinforced = makeShip('sloop', {
    position: { x: 0, y: -0.3, z: 0 },
    holes: { bow: 0, stern: 0, port: 1, starboard: 1 },
    upgrades: [{ type: 'hull_reinforcement' }],
  });
  expect('a reinforced hull floods slower than a standard one',
    shipIngressRate(reinforced, 0) < shipIngressRate(two, 0),
    `std=${shipIngressRate(two, 0).toFixed(4)} reinforced=${shipIngressRate(reinforced, 0).toFixed(4)}`);
  const expectedReinforced = FLOODING.INGRESS_PER_HOLE * 2 * FLOODING.INGRESS_CLASS_SCALE.sloop * SHIP_UPGRADES.HULL_INGRESS_MULT;
  expect('reinforced ingress = base × HULL_INGRESS_MULT',
    Math.abs(shipIngressRate(reinforced, 0) - expectedReinforced) < 1e-9,
    `rate=${shipIngressRate(reinforced, 0)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nHeeled ship: the raised windward hole does NOT flood');

{
  // Heel to starboard (positive roll lifts the +x rail). Both rails are holed.
  const ship = makeShip('sloop', {
    position: { x: 0, y: 0, z: 0 },
    roll: 0.35,
    holes: { bow: 0, stern: 0, port: 1, starboard: 1 },
  });
  const flooding = evaluateSectionFlood(ship, 0);
  const stbd = flooding.find((s) => s.section === 'starboard');
  const port = flooding.find((s) => s.section === 'port');
  expect('windward (raised starboard) hole stays above the waterline — no flood',
    stbd.holes > 0 && !stbd.submerged && !stbd.flooding);
  expect('leeward (dipped port) hole floods',
    port.holes > 0 && port.submerged && port.flooding);
  const expectedLowSideRate = FLOODING.INGRESS_PER_HOLE * port.holes * FLOODING.INGRESS_CLASS_SCALE.sloop;
  expect('heeled ship only takes water on the low side',
    Math.abs(shipIngressRate(ship, 0) - expectedLowSideRate) < 1e-9,
    `rate=${shipIngressRate(ship, 0)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nBailing vs holes');

/** Simulate N seconds: bail `bailers` players, then physics ingress each tick. */
function simulateBail({ holes, bailers, seconds, start = 0.5 }) {
  const holed = ['port', 'starboard', 'bow', 'stern'];
  const shipHoles = { bow: 0, stern: 0, port: 0, starboard: 0 };
  for (let i = 0; i < holes; i++) shipHoles[holed[i]] = 1;
  const ship = makeShip('sloop', { position: { x: 0, y: -0.3, z: 0 }, holes: shipHoles, waterLevel: start });
  for (let i = 0; i < seconds * 60; i++) {
    // Bailers act first (mirrors Match applying input before physics).
    ship.waterLevel = Math.max(0, ship.waterLevel - bailers * FLOODING.BAIL_RATE * DT);
    updateShipFlooding(ship, 0, DT);
  }
  return ship.waterLevel;
}

{
  expect('one bailer bails faster than one open hole floods',
    FLOODING.BAIL_RATE > FLOODING.INGRESS_PER_HOLE,
    `bail=${FLOODING.BAIL_RATE} perHole=${FLOODING.INGRESS_PER_HOLE}`);
  const oneVsOne = simulateBail({ holes: 1, bailers: 1, seconds: 20 });
  expect('one bailer net-drains against one hole', oneVsOne < 0.5, `water=${oneVsOne.toFixed(3)}`);

  const oneVsTwo = simulateBail({ holes: 2, bailers: 1, seconds: 20 });
  expect('one bailer cannot keep up with two holes (rising)', oneVsTwo > 0.5, `water=${oneVsTwo.toFixed(3)}`);

  const twoVsTwo = simulateBail({ holes: 2, bailers: 2, seconds: 20 });
  expect('two bailers beat two holes', twoVsTwo < 0.5, `water=${twoVsTwo.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nPatch every hole stops ingress; passive pump recovers a patched hull');

{
  const ship = makeShip('sloop', {
    position: { x: 0, y: -0.3, z: 0 },
    holes: { bow: 0, stern: 0, port: 1, starboard: 1 },
    waterLevel: 0.5,
  });
  expect('holed hull is taking on water', shipIngressRate(ship, 0) > 0);
  // Plank every hole.
  ship.holes.port = 0;
  ship.holes.starboard = 0;
  expect('patched hull has zero ingress', shipIngressRate(ship, 0) === 0);
  const before = ship.waterLevel;
  const expectedPump = FLOODING.BAIL_RATE * FLOODING.PASSIVE_PUMP_FACTOR;
  for (let i = 0; i < 5 * 60; i++) updateShipFlooding(ship, 0, DT);
  expect('passive bilge pump drains a patched hull', ship.waterLevel < before, `water=${ship.waterLevel.toFixed(3)}`);
  expect('pump trend is reported and negative',
    ship.floodingRate < 0 && Math.abs(ship.floodingRate + expectedPump) < 1e-9,
    `rate=${ship.floodingRate}`);
  const drained = before - ship.waterLevel;
  expect('pump drains at 0.25× bail rate',
    Math.abs(drained - expectedPump * 5) < 1e-6, `drained=${drained.toFixed(4)} over 5s`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nWeight of water: speed falls monotonically toward ~0.62× when swamped');

function steadySpeedAtWater(waterLevel) {
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sailHeight: 1 });
  const offWind = Math.PI / 2; // beam reach
  let t = 0;
  for (let i = 0; i < 30 * 60; i++) {
    t += DT;
    const wind = sampleWind(t);
    ship.rotation = angleWrap(wind.direction + Math.PI - offWind);
    ship.angularVelocity = 0;
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    ship.sailAngle = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
    ship.waterLevel = waterLevel; // hold the bilge fixed (intact hull would pump dry)
    physics.update(DT, t, [ship], [], [], [], []);
  }
  return Math.hypot(ship.velocity.x, ship.velocity.z);
}

{
  const dry = steadySpeedAtWater(0);
  const half = steadySpeedAtWater(0.5);
  const full = steadySpeedAtWater(1);
  expect('speed decreases monotonically with water', dry > half && half > full,
    `dry=${dry.toFixed(2)} half=${half.toFixed(2)} full=${full.toFixed(2)}`);
  const ratio = full / dry;
  expect('full bilge cuts top speed to ~0.62×', ratio > 0.58 && ratio < 0.66, `ratio=${ratio.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nWeight of water dulls the rudder ~40%');

function turnedWithWater(waterLevel) {
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sailHeight: 0, waterLevel });
  const helm = { id: 'helm', atHelm: true, onShipId: ship.id, state: 'eliminated', respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0 };
  const start = ship.rotation;
  for (let i = 0; i < 3 * 60; i++) {
    ship.velocity.x = Math.sin(ship.rotation) * 12;
    ship.velocity.z = Math.cos(ship.rotation) * 12;
    ship.waterLevel = waterLevel;
    applyShipRudderSteering(ship, DT, 1, 1);
    physics.update(DT, i * DT, [ship], [helm], [], [], []);
  }
  return Math.abs(angleWrap(ship.rotation - start));
}

{
  const dry = turnedWithWater(0);
  const swamped = turnedWithWater(1);
  const ratio = swamped / dry;
  expect('a swamped hull turns less', swamped < dry, `dry=${dry.toFixed(3)} swamped=${swamped.toFixed(3)}`);
  expect('rudder authority ~60% when full (40% cut)', ratio > 0.5 && ratio < 0.72, `ratio=${ratio.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nA submerged open hole douses a deck fire');

{
  const ship = makeShip('sloop', {
    position: { x: 0, y: -0.3, z: 0 },
    holes: { bow: 0, stern: 0, port: 1, starboard: 0 },
    onFire: true,
    fireTimer: SHIP.FIRE_DURATION,
    fireDamageAccum: 0.4,
  });
  expect('fire is taking on water (an open hole is under)', shipIngressRate(ship, 0) > 0);
  updateShipFlooding(ship, 0, DT);
  expect('submersion extinguishes the fire',
    ship.onFire === false && ship.fireTimer === 0 && ship.fireDamageAccum === 0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nSinking by flooding (waterLevel ≥ 1): crew SURVIVES the sink (swims out), sinker banks gold');

{
  const match = new Match({ matchId: 'flooding-test', botCount: 3 });
  match.state.phase = 'playing';
  const st = match.state;
  const victimShip = st.ships[0];
  const attacker = st.players.find((p) => p.shipId && p.shipId !== victimShip.id);
  const victimCrew = st.players.filter((p) => p.shipId === victimShip.id);
  expect('victim ship has crew aboard', victimCrew.length > 0);
  expect('a valid attacker on another ship exists', !!attacker && attacker.shipId !== victimShip.id);

  match.markShipDamagedByPlayer(victimShip.id, attacker.id);
  victimShip.waterLevel = 1;
  const chestsBefore = victimShip.treasureChestIds.length;
  const goldBefore = attacker.gold;
  match.evaluateShipSinking(victimShip);

  expect('a fully-flooded ship starts sinking', victimShip.sinking === true);
  // Losing the ship does NOT eliminate the crew — they splash out alive and
  // keep fighting; the sink only costs them their respawn anchor.
  expect('the flooded crew survives the sink (swimming, not eliminated)',
    victimCrew.every((p) => p.state === 'swimming' && p.health > 0),
    victimCrew.map((p) => p.state).join(','));
  expect('crew keeps NO respawn anchor (home ship sinking)',
    victimShip.sinking && victimCrew.every((p) => p.shipId === victimShip.id));
  expect('sinker banked the ship-sink bounty (gold, not kills)',
    attacker.gold - goldBefore === PLAYER.SHIP_SINK_GOLD && attacker.kills === 0,
    `goldΔ=${attacker.gold - goldBefore} kills=${attacker.kills}`);
  expect('sink flow still drops treasure', victimShip.treasureChestIds.length === 0, `chests=${chestsBefore}`);

  // Holes, not hp, decide: a fully-holed hull sitting dry does NOT insta-sink —
  // only the rising water sinks it, giving the crew a real bail/patch fight.
  const hpVictim = st.ships[1];
  hpVictim.position.y = -1.5; // sitting low: every hole is well below the waterline
  hpVictim.pitch = 0;
  hpVictim.roll = 0;
  hpVictim.holes = {
    bow: FLOODING.MAX_HOLES_PER_SECTION,
    stern: FLOODING.MAX_HOLES_PER_SECTION,
    port: FLOODING.MAX_HOLES_PER_SECTION,
    starboard: FLOODING.MAX_HOLES_PER_SECTION,
  };
  hpVictim.waterLevel = 0;
  match.evaluateShipSinking(hpVictim);
  expect('a fully-holed but dry hull does NOT insta-sink (water decides)', hpVictim.sinking !== true);
  const wreckedFlood = evaluateSectionFlood(hpVictim, 0);
  expect('every open, submerged hole is gushing',
    wreckedFlood.every((sec) => sec.flooding), JSON.stringify(wreckedFlood.map((s) => [s.section, s.holes, s.flooding])));
  let wreckT = 0;
  for (let i = 0; i < 90 * 60 && (hpVictim.waterLevel ?? 0) < 1; i++) {
    updateShipFlooding(hpVictim, 0, DT);
    wreckT += DT;
  }
  match.evaluateShipSinking(hpVictim);
  expect('a shot-to-pieces hull still founders — via the rising water (<45 s)',
    hpVictim.sinking === true && wreckT < 45, `filled in ${wreckT.toFixed(1)}s`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nChainshot is a rigging weapon: no hull holes, sets chainshottedUntil');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sailHeight: 1, sailIntegrity: 1 });
  physics.onProjectileHitShip({
    id: 'chain-1',
    type: 'chainshot',
    ownerId: 'attacker',
    ownerShipId: 'other',
    position: { x: 0, y: 1, z: 5 }, // over the bow
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    age: 0,
    maxAge: 8,
    damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0,
    visualOnly: false,
    showImpact: true,
  }, ship, 5);

  const noHoles = ship.holes.bow === 0 && ship.holes.stern === 0 && ship.holes.port === 0 && ship.holes.starboard === 0;
  expect('chainshot opens NO hull holes', noHoles, JSON.stringify(ship.holes));
  expect('chainshot sets chainshottedUntil = t + 30 (sim seconds)', ship.chainshottedUntil === 35,
    `chainshottedUntil=${ship.chainshottedUntil}`);
  expect('chainshot tears the rigging (sailIntegrity down)', ship.sailIntegrity < 1, `integrity=${ship.sailIntegrity}`);
  expect('chainshot collapses the canvas (sailHeight down)', ship.sailHeight < 1, `sailHeight=${ship.sailHeight}`);
  const chainEvent = physics.flushCombatEvents().find((e) => e.type === 'ship_hit');
  expect('chainshot ship_hit reports 0 hull damage', !!chainEvent && chainEvent.damage === 0,
    `damage=${chainEvent?.damage}`);

  // Control: a cannonball DOES open a hole (chainshot guard is type-specific).
  const ball = makeShip('sloop');
  physics.onProjectileHitShip({
    id: 'ball-1', type: 'cannonball', ownerId: 'attacker', ownerShipId: 'other',
    position: { x: 0, y: 1, z: 5 }, velocity: { x: 0, y: 0, z: 0 },
    alive: true, age: 0, maxAge: 8, damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0, visualOnly: false, showImpact: true,
  }, ball, 5);
  expect('cannonball punches exactly one hole (control)', ball.holes.bow === 1, `bow holes=${ball.holes.bow}`);
  expect('the punched hole lowers the derived integrity', ball.hull.bow < 1, `bow=${ball.hull.bow}`);
}

if (failures > 0) {
  console.error(`\n${failures} flooding assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll flooding assertions passed.');
