#!/usr/bin/env node
// SoT naval damage loop, PURELY hole-based and now per-ENTITY: every breach is
// a point in the hull-local frame, it leaks only while that point sits under
// the live surface, ingress scales with how deep it sits, a plank shuts ONE of
// them, and water — never a hull-HP pool — is what sinks the ship.
import {
  PhysicsSystem,
  applyShipRudderSteering,
  evaluateHoleFlood,
  shipIngressRate,
  updateShipFlooding,
  floodListTargets,
  HULL_SATURATION,
} from '../src/server/systems/PhysicsSystem.ts';
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS, FLOODING, SHIP_UPGRADES, PLAYER } from '../src/shared/constants/index.ts';
import { countOpenHoles, getShipHoleTier } from '../src/shared/interactions.ts';
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

/** A breach entity at an exact hull-local point (+x starboard, +z bow, y = 0
 *  IS the design waterline). */
let holeSeq = 0;
function hole(x, y, z, patched = false) {
  return { id: ++holeSeq, x, y, z, patched };
}

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
    holes: [],
    nextHoleId: 1,
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

/** Two breaches on the waterline, one per rail — the canonical "shot at the
 *  waterline from both sides" state the ingress balance is tuned around. */
function waterlineHoles(type) {
  const stats = SHIP_STATS[type];
  return [hole(stats.width * 0.5, 0, 0), hole(-stats.width * 0.5, 0, 0)];
}

// ────────────────────────────────────────────────────────────────────────────
console.log('Ingress: two waterline breaches sink an untended ship');

/** Untended fill time (seconds) for a level ship with two lateral breaches. */
function untendedFillTime(type) {
  const ship = makeShip(type, { holes: waterlineHoles(type) });
  const flooding = evaluateHoleFlood(ship, 0).filter((h) => h.flooding);
  let t = 0;
  for (let i = 0; i < 200 * 60 && (ship.waterLevel ?? 0) < 1; i++) {
    updateShipFlooding(ship, 0, DT);
    t += DT;
  }
  return { t, flooding };
}

{
  const sloop = untendedFillTime('sloop');
  expect('both waterline breaches take on water',
    sloop.flooding.length === 2, `flooding=${sloop.flooding.length}`);
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
  const two = makeShip('sloop', { holes: waterlineHoles('sloop') });
  const three = makeShip('sloop', { holes: [...waterlineHoles('sloop'), hole(0, 0, 4)] });
  expect('three open holes gush faster than two', shipIngressRate(three, 0) > shipIngressRate(two, 0),
    `two=${shipIngressRate(two, 0).toFixed(4)} three=${shipIngressRate(three, 0).toFixed(4)}`);
  const reinforced = makeShip('sloop', {
    holes: waterlineHoles('sloop'),
    upgrades: [{ type: 'hull_reinforcement' }],
  });
  expect('a reinforced hull floods slower than a standard one',
    shipIngressRate(reinforced, 0) < shipIngressRate(two, 0),
    `std=${shipIngressRate(two, 0).toFixed(4)} reinforced=${shipIngressRate(reinforced, 0).toFixed(4)}`);
  expect('hull_reinforcement stays exactly an ingress multiplier',
    Math.abs(shipIngressRate(reinforced, 0) - shipIngressRate(two, 0) * SHIP_UPGRADES.HULL_INGRESS_MULT) < 1e-12,
    `rate=${shipIngressRate(reinforced, 0)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nIngress scales with how DEEP a breach sits (the doom spiral)');

{
  const ship = makeShip('sloop', { holes: [hole(2.5, 0, 0)] });
  const atLine = shipIngressRate(ship, 0);
  const shallow = evaluateHoleFlood(ship, 0)[0];
  ship.position.y = -0.9; // the bilge has settled her: same breach, well under
  const deep = evaluateHoleFlood(ship, 0)[0];
  const submerged = shipIngressRate(ship, 0);
  expect('a breach ON the waterline leaks the reference rate',
    Math.abs(atLine - FLOODING.INGRESS_PER_HOLE * shallow.rateFactor * FLOODING.INGRESS_CLASS_SCALE.sloop) < 1e-12);
  expect('the SAME breach dragged under leaks strictly harder',
    submerged > atLine * 1.3, `line=${atLine.toFixed(5)} deep=${submerged.toFixed(5)}`);
  expect('the depth factor is capped so a swamped hull cannot gush infinitely',
    deep.rateFactor === FLOODING.HOLE_DEPTH_MAX_FACTOR, `factor=${deep.rateFactor}`);
  expect('depth reads as metres below the live surface',
    deep.depth > shallow.depth + 0.85, `shallow=${shallow.depth.toFixed(3)} deep=${deep.depth.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nHeeled ship: the raised windward breach does NOT flood');

{
  // Heel to starboard (positive roll lifts the +x rail). Both rails are holed.
  const ship = makeShip('sloop', { roll: 0.35, holes: waterlineHoles('sloop') });
  const flood = evaluateHoleFlood(ship, 0);
  const stbd = flood.find((h) => h.hole.x > 0);
  const port = flood.find((h) => h.hole.x < 0);
  expect('windward (raised starboard) breach stays above the waterline — no flood',
    !stbd.flooding && stbd.rateFactor === 0, `depth=${stbd.depth.toFixed(3)}`);
  expect('leeward (dipped port) breach floods', port.flooding && port.rateFactor > 0);
  const expectedLowSideRate = FLOODING.INGRESS_PER_HOLE * port.rateFactor * FLOODING.INGRESS_CLASS_SCALE.sloop;
  expect('a heeled ship only takes water on the low side',
    Math.abs(shipIngressRate(ship, 0) - expectedLowSideRate) < 1e-12,
    `rate=${shipIngressRate(ship, 0)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nA breach high on the topside is dry in calm water, wet in a storm');

{
  const ship = makeShip('sloop', { holes: [hole(2.5, 1.4, 0)] });
  expect('a breach 1.4 m up the topside does not leak in a calm sea',
    shipIngressRate(ship, 0) === 0, `rate=${shipIngressRate(ship, 0)}`);
  let stormRate = 0;
  // Storm seas break over her: somewhere in the wave cycle the breach goes under.
  for (let i = 0; i < 400; i++) stormRate = Math.max(stormRate, shipIngressRate(ship, i * 0.05, 1));
  expect('storm seas wash over it and it starts taking water', stormRate > 0,
    `bestStormRate=${stormRate}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nBailing vs holes');

/** Simulate N seconds: `bailers` players bail, then physics ingress each tick. */
function simulateBail({ holes, bailers, seconds, start = 0.5 }) {
  const spots = [[2.5, 0, 0], [-2.5, 0, 0], [0, 0, 4.8], [0, 0, -4.8]];
  const shipHoles = [];
  for (let i = 0; i < holes; i++) shipHoles.push(hole(...spots[i % spots.length]));
  const ship = makeShip('sloop', { holes: shipHoles, waterLevel: start });
  for (let i = 0; i < seconds * 60; i++) {
    // Bailers act first (mirrors Match applying input before physics).
    ship.waterLevel = Math.max(0, ship.waterLevel - bailers * FLOODING.BAIL_RATE * DT);
    updateShipFlooding(ship, 0, DT);
  }
  return ship.waterLevel;
}

{
  expect('one bailer bails faster than one waterline hole floods',
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
console.log('\nPatching ONE breach stops THAT breach; a whole hull pumps dry');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { holes: waterlineHoles('sloop'), waterLevel: 0.5 });
  const [stbd, port] = ship.holes;
  const both = shipIngressRate(ship, 0);
  const stbdShare = evaluateHoleFlood(ship, 0).find((h) => h.hole.id === stbd.id).rateFactor
    * FLOODING.INGRESS_PER_HOLE * FLOODING.INGRESS_CLASS_SCALE.sloop;
  expect('holed hull is taking on water', both > 0);

  expect('patching an id that is not open reports failure', physics.patchHole(ship, 99999) === false);
  expect('a plank shuts the breach you were standing at', physics.patchHole(ship, stbd.id) === true);
  expect('the patched entity SURVIVES (the crossed planks render at its point)',
    ship.holes.length === 2 && ship.holes.find((h) => h.id === stbd.id).patched === true);
  expect('a patched breach NEVER leaks again',
    evaluateHoleFlood(ship, 0).every((h) => h.hole.id !== stbd.id));
  expect('ingress drops by exactly that breach\'s share, not by half a section',
    Math.abs(shipIngressRate(ship, 0) - (both - stbdShare)) < 1e-12,
    `both=${both} after=${shipIngressRate(ship, 0)} share=${stbdShare}`);

  physics.patchHole(ship, port.id);
  expect('every breach patched -> zero ingress', shipIngressRate(ship, 0) === 0);
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
console.log('\nA torn hull also drags: open breaches cost speed on top of the water');

{
  const physics = new PhysicsSystem();
  const run = (holes) => {
    const ship = makeShip('sloop', { sailHeight: 1, holes });
    let t = 0;
    for (let i = 0; i < 20 * 60; i++) {
      t += DT;
      const wind = sampleWind(t);
      ship.rotation = angleWrap(wind.direction + Math.PI - Math.PI / 2);
      ship.angularVelocity = 0;
      ship.sailAngle = Math.sin(angleWrap(wind.direction - ship.rotation)) * SHIP.MAX_SAIL_ANGLE * 0.92;
      ship.waterLevel = 0;
      physics.update(DT, t, [ship], [], [], [], []);
    }
    return Math.hypot(ship.velocity.x, ship.velocity.z);
  };
  const whole = run([]);
  const torn = run(Array.from({ length: 6 }, (_, i) => hole(2.5, 0.2, i - 3)));
  expect('a riddled hull makes less way than a sound one', torn < whole,
    `whole=${whole.toFixed(2)} torn=${torn.toFixed(2)}`);
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
console.log('\nA submerged open breach douses a deck fire');

{
  const ship = makeShip('sloop', {
    position: { x: 0, y: -0.3, z: 0 },
    holes: [hole(-2.5, 0, 0)],
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
console.log('\nFire chars HIGH and burns DOWN — a firebomb is a real threat now');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { onFire: true, fireTimer: SHIP.FIRE_DURATION });
  // Six seconds in: the first char exists, high and DRY.
  for (let i = 0; i < Math.round(6.5 / DT); i++) physics.update(DT, i * DT, [ship], [], [], [], []);
  expect('the blaze chars its first breach within ~6 s', ship.holes.length >= 1, `holes=${ship.holes.length}`);
  expect('that char starts high on the topside, above the calm waterline',
    ship.holes[0].y > FLOODING.HOLE_BAND_Y.max, `y=${ship.holes[0].y.toFixed(2)}`);
  expect('a dry char does not flood, so it cannot self-douse the fire',
    ship.onFire === true && (ship.waterLevel ?? 0) === 0,
    `onFire=${ship.onFire} water=${ship.waterLevel}`);
  const firstY = ship.holes[0].y;
  for (let i = 0; i < Math.round(6 / DT); i++) physics.update(DT, (6.5 + i * DT), [ship], [], [], [], []);
  expect('the flames burn that char DOWNWARD toward the sea',
    ship.holes[0].y < firstY - 0.2, `${firstY.toFixed(2)} -> ${ship.holes[0].y.toFixed(2)}`);
  expect('an untended blaze stacks more than one breach (the old model stopped at 1)',
    ship.holes.length >= 2, `holes=${ship.holes.length}`);
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
  expect('a foundering hull is visibly riddled (breaches all round her)',
    countOpenHoles(victimShip) >= 8, `open=${countOpenHoles(victimShip)}`);

  // Holes, not hp, decide: a fully-holed hull sitting dry does NOT insta-sink —
  // only the rising water sinks it, giving the crew a real bail/patch fight.
  const hpVictim = st.ships[1];
  hpVictim.position.y = -1.5; // sitting low: every hole is well below the waterline
  hpVictim.pitch = 0;
  hpVictim.roll = 0;
  hpVictim.holes = [];
  hpVictim.nextHoleId = 1;
  match.physics.openHoleAt(hpVictim, { x: 2.4, y: 0.15, z: 0 }, FLOODING.MAX_HOLES_PER_SHIP, 'cannon');
  hpVictim.waterLevel = 0;
  match.evaluateShipSinking(hpVictim);
  expect('a fully-holed but dry hull does NOT insta-sink (water decides)', hpVictim.sinking !== true);
  const wreckedFlood = evaluateHoleFlood(hpVictim, 0);
  expect('every open, submerged breach is gushing',
    wreckedFlood.length === FLOODING.MAX_HOLES_PER_SHIP && wreckedFlood.every((h) => h.flooding),
    JSON.stringify(wreckedFlood.map((h) => [h.hole.id, +h.depth.toFixed(2), h.flooding])));
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
console.log('\nShot to pieces: a saturated hull is never immune (HULL-01 slice c)');

{
  // Eight OPEN dry holes at deck height (the liveplay run5 state), then a
  // waterline shot: the driest open breach must move down and start leaking.
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  for (let i = 0; i < FLOODING.MAX_HOLES_PER_SHIP; i += 1) {
    physics.openHoleAt(ship, { x: (i % 2 ? 1 : -1) * 2.0, y: 1.3, z: -3 + i * 0.8 }, 1, 'cannon');
  }
  expect('eight open holes at 1.3 m take no water', countOpenHoles(ship) === 8 && shipIngressRate(ship, 0) === 0,
    `open=${countOpenHoles(ship)} ingress=${shipIngressRate(ship, 0)}`);
  const before = ship.holes.map((h) => h.y);
  const [moved] = physics.openHoleAt(ship, { x: 2.4, y: 0.3, z: 0.5 }, 1, 'cannon');
  const lowered = ship.holes.filter((h, i) => h.y < before[i] - 0.5);
  expect('a waterline shot on the saturated hull moves exactly ONE hole down to 0.3 m',
    lowered.length === 1 && Math.abs(moved.y - 0.3) < 0.01 && ship.holes.length === 8,
    `moved=${lowered.length} y=${moved?.y} holes=${ship.holes.length}`);
  expect('...and the hull now takes water', shipIngressRate(ship, 0) > 0, `ingress=${shipIngressRate(ship, 0)}`);
  const again = physics.openHoleAt(ship, { x: -2.4, y: 1.25, z: 2 }, 1, 'cannon')[0];
  expect('a shot no lower than the driest open hole lands in an existing wound (no eviction)',
    ship.holes.filter((h) => h.y >= 1.29).length === 7 && again.y >= 1.29, `heights=${ship.holes.map((h) => h.y.toFixed(2)).join(',')}`);
}

{
  // Eight open DRY holes left alone: 20 s of grace, then the seams work open
  // at HULL_SATURATION.FORCED_INGRESS so the hull founders instead of sitting
  // at "8 LEAKS, 0 % bilge" for a hundred seconds.
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  for (let i = 0; i < FLOODING.MAX_HOLES_PER_SHIP; i += 1) {
    physics.openHoleAt(ship, { x: (i % 2 ? 1 : -1) * 2.0, y: 1.3, z: -3 + i * 0.8 }, 1, 'cannon');
  }
  let tick = 0;
  const run = (seconds) => { const n = Math.round(seconds / DT); for (let i = 0; i < n; i += 1, tick += 1) physics.update(DT, tick * DT, [ship], [], [], [], [], null); };
  run(19);
  expect('still dry inside the 20 s grace', (ship.waterLevel ?? 0) === 0, `water=${ship.waterLevel}`);
  run(11);
  const rate = (ship.waterLevel ?? 0) / 10;
  expect('after the grace the hull takes ~0.02/s of forced ingress',
    rate > HULL_SATURATION.FORCED_INGRESS * 0.8 && rate < HULL_SATURATION.FORCED_INGRESS * 1.25,
    `water=${(ship.waterLevel ?? 0).toFixed(3)} over 10 s (rate ${rate.toFixed(4)})`);
  physics.patchHole(ship, ship.holes[0].id);
  const w = ship.waterLevel;
  run(5);
  expect('planking ONE hole ends the forced ingress (and the pump starts gaining)', (ship.waterLevel ?? 0) < w, `${w.toFixed(3)} -> ${(ship.waterLevel ?? 0).toFixed(3)}`);
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

  expect('chainshot opens NO hull breaches', ship.holes.length === 0, JSON.stringify(ship.holes));
  expect('chainshot sets chainshottedUntil = t + 30 (sim seconds)', ship.chainshottedUntil === 35,
    `chainshottedUntil=${ship.chainshottedUntil}`);
  expect('chainshot tears the rigging (sailIntegrity down)', ship.sailIntegrity < 1, `integrity=${ship.sailIntegrity}`);
  expect('chainshot collapses the canvas (sailHeight down)', ship.sailHeight < 1, `sailHeight=${ship.sailHeight}`);
  const chainEvent = physics.flushCombatEvents().find((e) => e.type === 'ship_hit');
  expect('chainshot ship_hit reports 0 hull damage', !!chainEvent && chainEvent.damage === 0,
    `damage=${chainEvent?.damage}`);
  expect('chainshot ship_hit carries an empty breach list', chainEvent.holes.length === 0);

  // Control: a cannonball DOES open a breach, at the point it struck.
  const ball = makeShip('sloop');
  physics.onProjectileHitShip({
    id: 'ball-1', type: 'cannonball', ownerId: 'attacker', ownerShipId: 'other',
    position: { x: 0.4, y: 0.22, z: 5 }, velocity: { x: 0, y: 0, z: 0 },
    alive: true, age: 0, maxAge: 8, damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0, visualOnly: false, showImpact: true,
  }, ball, 5);
  expect('cannonball punches exactly one breach (control)', ball.holes.length === 1,
    JSON.stringify(ball.holes));
  const punched = ball.holes[0];
  expect('the breach sits at the exact hull-local impact point',
    Math.hypot(punched.x - 0.4, punched.y - 0.22, punched.z - 5) < 0.01,
    JSON.stringify(punched));
  expect('the breach is tagged with what made it', punched.source === 'cannon');
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nHole HEIGHT tiers: every breach carries its own tier byte (SINK-01 slice a)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  const stats = SHIP_STATS.sloop;
  const [low] = physics.openHoleAt(ship, { x: 2.4, y: 0.05, z: 0 }, 1, 'cannon');
  const [mid] = physics.openHoleAt(ship, { x: 2.4, y: 0.40, z: 1 }, 1, 'cannon');
  const [high] = physics.openHoleAt(ship, { x: 2.4, y: 1.45, z: -1 }, 1, 'cannon');
  expect('a breach at the wale is tier LOW (0)', low.tier === 0, `tier=${low.tier}`);
  expect('a breach in the band is tier MID (1)', mid.tier === 1, `tier=${mid.tier}`);
  expect('a breach on the topside is tier HIGH (2)', high.tier === 2, `tier=${high.tier}`);
  expect('the stored tier agrees with the shared classifier (client parity)',
    ship.holes.every((h) => h.tier === getShipHoleTier(h.y, stats)),
    ship.holes.map((h) => `${h.y.toFixed(2)}:${h.tier}`).join(','));

  // Eviction must re-tier the slot it recycles, or a moved breach lies about
  // its height for the rest of the match.
  const sat = makeShip('sloop');
  for (let i = 0; i < FLOODING.MAX_HOLES_PER_SHIP; i += 1) {
    physics.openHoleAt(sat, { x: (i % 2 ? 1 : -1) * 2.0, y: 1.3, z: -3 + i * 0.8 }, 1, 'cannon');
  }
  expect('eight breaches at 1.3 m are all tier MID (a sloop\'s topside starts at 0.6x2.2 m)',
    sat.holes.every((h) => h.tier === 1), sat.holes.map((h) => h.tier).join(','));
  const [moved] = physics.openHoleAt(sat, { x: 2.4, y: 0.1, z: 0.5 }, 1, 'cannon');
  expect('a waterline shot re-tiers the breach it dragged down to LOW', moved.tier === 0, `tier=${moved.tier}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nThe SERVER owns the list: she leans on her holed side and settles by her flooded end');

{
  // Pure targets first — no wave noise, so the SIGN is unambiguous.
  const stbd = makeShip('sloop', { holes: [hole(2.5, 0, 0), hole(2.5, 0, 2)] });
  const port = makeShip('sloop', { holes: [hole(-2.5, 0, 0), hole(-2.5, 0, 2)] });
  const bow = makeShip('sloop', { holes: [hole(0.5, 0, 5.5), hole(-0.5, 0, 5.5)] });
  const st = floodListTargets(stbd, 0);
  const pt = floodListTargets(port, 0);
  const bt = floodListTargets(bow, 0);
  expect('breaches to starboard roll the deck DOWN to starboard (negative roll)',
    st.roll < -0.05, `roll=${st.roll.toFixed(3)}`);
  expect('breaches to port heel her the other way, to the same order of lean',
    pt.roll > 0.05 && Math.abs(pt.roll + st.roll) < Math.abs(st.roll) * 0.3,
    `port=${pt.roll.toFixed(3)} stbd=${st.roll.toFixed(3)}`);
  expect('a bow full of water dips the bow (positive pitch)', bt.trim > 0.03, `trim=${bt.trim.toFixed(3)}`);
  expect('the list is bounded (±LIST_ROLL_MAX / ±LIST_TRIM_MAX)',
    Math.abs(st.roll) <= FLOODING.LIST_ROLL_MAX + 1e-9 && Math.abs(bt.trim) <= FLOODING.LIST_TRIM_MAX + 1e-9);
  expect('a patched hull sits level (no list without an open breach)',
    floodListTargets(makeShip('sloop', { holes: [hole(2.5, 0, 0, true)] })).roll === 0);

  // ...and the attitude spring actually carries it into ship.roll.
  const run = (ship) => {
    const physics = new PhysicsSystem();
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 8 * 60; i += 1) {
      physics.update(DT, i * DT, [ship], [], [], [], [], null);
      if (i > 4 * 60) { sum += ship.roll ?? 0; n += 1; }
    }
    return sum / n;
  };
  const rollStbd = run(makeShip('sloop', { holes: [hole(2.5, 0, 0), hole(2.5, 0, 2)] }));
  const rollPort = run(makeShip('sloop', { holes: [hole(-2.5, 0, 0), hole(-2.5, 0, 2)] }));
  expect('a starboard-holed hull heels to starboard for real (mean roll < -0.05)',
    rollStbd < -0.05, `meanRoll=${rollStbd.toFixed(3)}`);
  expect('and the port-holed hull heels the other way', rollPort > 0.05, `meanRoll=${rollPort.toFixed(3)}`);
}

if (failures > 0) {
  console.error(`\n${failures} flooding assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll flooding assertions passed.');
