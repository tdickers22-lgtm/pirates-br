#!/usr/bin/env node
// SoT naval damage loop, PURELY hole-based and now per-ENTITY: every breach is
// a point in the hull-local frame, it leaks only while that point sits under
// the live surface, ingress scales with how deep it sits, a plank shuts ONE of
// them, and water — never a hull-HP pool — is what sinks the ship.
import { idealBrace } from '../src/shared/sailing.ts';
import {
  PhysicsSystem,
  applyShipRudderSteering,
  evaluateHoleFlood,
  shipIngressRate,
  updateShipFlooding,
  floodListTargets,
  stormSeaState,
  FOUNDER_WADE_DEPTH,
  HULL_SATURATION,
} from '../src/server/systems/PhysicsSystem.ts';
import { Match } from '../src/server/core/Match.ts';
import { TRUCE_SECONDS } from '../src/shared/truce.ts';
import { SHIP, SHIP_STATS, FLOODING, SHIP_UPGRADES, PLAYER } from '../src/shared/constants/index.ts';
import {
  countOpenHoles,
  getShipHoleTier,
  findRepairableHole,
  getBilgePumpLocal,
  getShipFloorYAt,
  isInsideShipHoldFootprint,
  isStandingInFloodedHold,
  isStandingInShipHold,
  toShipLocalPoint,
} from '../src/shared/interactions.ts';
import { angleWrap, sampleWind, gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';
import { floodSettle, holeIngress, holeRepairTime, holeSizeArea, holeVisualRadius, waterlineHoleIngress } from '../src/shared/flooding/floodModel.ts';

// THIS SUITE PINS THE WORLD. Every block below that builds a real `new Match()`
// (the founder scene, the pump, the sealed hold) inherits `this.rng` from
// makeMatchRng, and UNSEEDED that rng IS Math.random (RNG-01, by design) — so
// the hull's type and the dock she lies at were redrawn on every run. The
// founder assertions are read off the Gerstner surface AT HER OWN x/z, so a
// different berth meant a different swell under her breaches and under each
// hand's boots: measured 6 failures in 40 unseeded runs, all three list/trim
// assertions reporting pitch=0.000 on green code, plus a fwd/aft tie at the
// deck-awash tick. A gate that grades a different world each run is not a gate.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';

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
    // Riding the frozen surface at the origin (the design waterline), so a
    // breach placed with onCalmLine is on the water, not 0.18 m above it.
    position: { x: 0, y: gerstnerHeight(0, 0, 0, WAVE_PARAMS), z: 0 },
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
  return [hole(stats.width * 0.5, onCalmLine(stats.width * 0.5, 0), 0), hole(-stats.width * 0.5, onCalmLine(-stats.width * 0.5, 0), 0)];
}

/** Hull-local y that puts a breach at (x, z) exactly on the frozen t=0 surface
 *  when the hull rides at CALM_Y. The t=0 swell varies +-0.2 m across a beam;
 *  with the D15 wash margin (0.15 m) "on the waterline" has to mean the LOCAL
 *  waterline, or one rail's hole is dry and the other gushes 0.25 m under. */
const CALM_Y = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
function onCalmLine(x, z) {
  return gerstnerHeight(x, z, 0, WAVE_PARAMS) - CALM_Y;
}

// ────────────────────────────────────────────────────────────────────────────
console.log('Ingress: two waterline breaches sink an untended ship');

/** Untended fill time (seconds) for a level ship with two lateral breaches. */
function untendedFillTime(type) {
  const ship = makeShip(type, { holes: waterlineHoles(type) });
  // This fixture freezes time. Put the design waterline at the actual frozen
  // surface, not the mean sea-level datum, and close the loop with the
  // server's own settle (floodSettle, what PhysicsSystem's heave target reads):
  // the inside head (D15) pushes back as the hold fills, the settle drags the
  // holes down, and the pair is what founders her.
  const s0 = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  ship.position.y = s0;
  const flooding = evaluateHoleFlood(ship, 0).filter((h) => h.flooding);
  let t = 0;
  for (let i = 0; i < 200 * 60 && (ship.waterLevel ?? 0) < 1; i++) {
    ship.position.y = s0 - floodSettle(type, ship.waterLevel ?? 0);
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
console.log('\nIngress follows Torricelli: sqrt of how DEEP a breach sits (the doom spiral)');

{
  const ship = makeShip('sloop', { holes: [hole(2.5, 0, 0)] });
  const s0 = gerstnerHeight(2.5, 0, 0, WAVE_PARAMS);
  const at = (depth) => { ship.position.y = s0 - depth; return evaluateHoleFlood(ship, 0)[0]; };
  const q02 = at(0.2).ingress;
  const q1 = at(1.0).ingress;
  expect('Q(1 m) / Q(0.2 m) is the sqrt law (1.9-2.3), not the old linear 1.5x cap',
    q1 / q02 >= 1.9 && q1 / q02 <= 2.3, `ratio=${(q1 / q02).toFixed(3)}`);
  expect('the SAME breach dragged under leaks strictly harder', q1 > q02 * 1.3);
  expect('FloodSystem uses the shared law exactly',
    Math.abs(at(0.6).ingress - holeIngress('sloop', 1, at(0.6).depth, 0)) < 1e-12);
  expect('depth reads as metres below the live surface', Math.abs(at(0.6).depth - 0.6) < 1e-9, `depth=${at(0.6).depth}`);
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
  const expectedLowSideRate = port.ingress;
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
  const s0 = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  for (let i = 0; i < seconds * 60; i++) {
    ship.position.y = s0 - floodSettle('sloop', ship.waterLevel);
    // Bailers act first (mirrors Match applying input before physics).
    ship.waterLevel = Math.max(0, ship.waterLevel - bailers * FLOODING.BAIL_RATE * DT);
    updateShipFlooding(ship, 0, DT);
  }
  return ship.waterLevel;
}

{
  expect('one bailer bails faster than one waterline hole floods',
    FLOODING.BAIL_RATE > waterlineHoleIngress('sloop'),
    `bail=${FLOODING.BAIL_RATE} perHole=${waterlineHoleIngress('sloop')}`);
  const oneVsOne = simulateBail({ holes: 1, bailers: 1, seconds: 20 });
  expect('one bailer net-drains against one hole', oneVsOne < 0.5, `water=${oneVsOne.toFixed(3)}`);

  // PLAN 3.6 design race: one bailer beats one small hole, loses to three
  // small. (Two small holes on a settled sloop is now a near-hold for one
  // bailer, which is the point of BAIL_RATE beating a hole 0.2 m under.)
  const oneVsThree = simulateBail({ holes: 3, bailers: 1, seconds: 20 });
  expect('one bailer cannot keep up with three small holes (rising)', oneVsThree > 0.5, `water=${oneVsThree.toFixed(3)}`);

  const twoVsTwo = simulateBail({ holes: 2, bailers: 2, seconds: 20 });
  expect('two bailers beat two holes', twoVsTwo < 0.5, `water=${twoVsTwo.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nPatching ONE breach stops THAT breach; the water STAYS until bailed (D15)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { holes: waterlineHoles('sloop'), waterLevel: 0.5 });
  ship.position.y = CALM_Y - floodSettle('sloop', 0.5); // half full, she has settled
  const [stbd, port] = ship.holes;
  const both = shipIngressRate(ship, 0);
  const stbdShare = evaluateHoleFlood(ship, 0).find((h) => h.hole.id === stbd.id).ingress;
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
  // holes-10: a stock hull has NO passive pump. SoT water stays until bailed.
  for (let i = 0; i < 60 * 60; i++) updateShipFlooding(ship, 0, DT);
  expect('a stock patched hull at 0.5 is still >= 0.5 after 60 s', ship.waterLevel >= 0.5, `water=${ship.waterLevel.toFixed(3)}`);
  expect('no pump trend on a stock hull', ship.floodingRate === 0, `rate=${ship.floodingRate}`);
  const reinforced = makeShip('sloop', { holes: [], waterLevel: 0.5, upgrades: [{ type: 'hull_reinforcement' }] });
  const expectedPump = FLOODING.BAIL_RATE * SHIP_UPGRADES.REINFORCED_PUMP_FACTOR;
  for (let i = 0; i < 5 * 60; i++) updateShipFlooding(reinforced, 0, DT);
  expect('a reinforced hull drains (its slow passive pump)', reinforced.waterLevel < 0.5, `water=${reinforced.waterLevel.toFixed(3)}`);
  expect('reinforced pump trend is reported and negative',
    reinforced.floodingRate < 0 && Math.abs(reinforced.floodingRate + expectedPump) < 1e-9, `rate=${reinforced.floodingRate}`);
  expect('reinforced pump drains at 0.25x bail rate',
    Math.abs((0.5 - reinforced.waterLevel) - expectedPump * 5) < 1e-6, `drained=${(0.5 - reinforced.waterLevel).toFixed(4)} over 5s`);
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
    ship.sailAngle = idealBrace(signedRelative);
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
      ship.sailAngle = idealBrace(angleWrap(wind.direction - ship.rotation));
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
console.log('\nSinking by flooding (waterLevel ≥ 1): crew SURVIVES the sink (rides the deck down), sinker banks gold');

{
  const match = new Match({ matchId: 'flooding-test', botCount: 3 });
  match.state.phase = 'playing';
  // The sink lands after the match truce (b1.6e): inside it no crew banks
  // SHIP_SINK_GOLD, which is test-truce-integrity's row, not this one.
  match['t'] = TRUCE_SECONDS + 1;
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
  // Losing the ship does NOT eliminate the crew — they come out alive and keep
  // fighting; the sink only costs them their respawn anchor. SINK-01 re-pins
  // WHEN they leave: they are still aboard, alive, on the tick she founders and
  // walk off as the water reaches them (see the founder-scene block below).
  expect('the flooded crew survives the sink (alive, still on her deck)',
    victimCrew.every((p) => p.state !== 'eliminated' && p.health > 0 && p.onShipId === victimShip.id),
    victimCrew.map((p) => `${p.state}:${p.onShipId ? 'aboard' : 'off'}`).join(','));
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
  ship.position.y = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  for (let i = 0; i < FLOODING.MAX_HOLES_PER_SHIP; i += 1) {
    physics.openHoleAt(ship, { x: (i % 2 ? 1 : -1) * 2.0, y: 1.3, z: -3 + i * 0.8 }, 1, 'cannon');
  }
  expect('eight open holes at 1.3 m take no water', countOpenHoles(ship) === 8 && shipIngressRate(ship, 0) === 0,
    `open=${countOpenHoles(ship)} ingress=${shipIngressRate(ship, 0)}`);
  const before = ship.holes.map((h) => h.y);
  // D15: a hole 0.3 m above calm water is dry on a level hull, so the
  // waterline shot lands ON the local waterline (0.15 m wash margin).
  const lineY = onCalmLine(2.4, 0.5) + 0.05;
  const [moved] = physics.openHoleAt(ship, { x: 2.4, y: lineY, z: 0.5 }, 1, 'cannon');
  const lowered = ship.holes.filter((h, i) => h.y < before[i] - 0.5);
  expect('a waterline shot on the saturated hull moves exactly ONE hole down to the waterline',
    lowered.length === 1 && Math.abs(moved.y - lineY) < 0.01 && ship.holes.length === 8,
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
  // Stock hulls have no passive pump (D15, holes-10): the rise stops, the water stays until bailed.
  expect('planking ONE hole ends the forced ingress (the water stops rising, and stays)', Math.abs((ship.waterLevel ?? 0) - w) < 1e-9, `${w.toFixed(3)} -> ${(ship.waterLevel ?? 0).toFixed(3)}`);
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
  const ball = makeShip('sloop', { position: { x: 0, y: 0, z: 0 } });
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
  const on = (x, z) => hole(x, onCalmLine(x, z), z);
  const stbd = makeShip('sloop', { holes: [on(2.5, 0), on(2.5, 2)] });
  const port = makeShip('sloop', { holes: [on(-2.5, 0), on(-2.5, 2)] });
  const bow = makeShip('sloop', { holes: [on(0.5, 5.5), on(-0.5, 5.5)] });
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

// ────────────────────────────────────────────────────────────────────────────
console.log('\nThe founder is a SCENE: crew ride the deck down, no anchor, down by the flooded end (SINK-01 slice b)');

{
  const match = new Match({ matchId: 'founder-test', botCount: 3 });
  match.state.phase = 'playing';
  const st = match.state;
  const ship = st.ships[0];
  const stats = SHIP_STATS[ship.type];
  // HER OWN PATCH OF OPEN SEA, not whatever berth the fleet builder handed hull
  // zero. The founder is a scene AT SEA and it was being graded at a dock, so
  // the fixture inherited the berth — and when w3.6's outline grounding moved
  // that berth 2.24 m (z -155.56 -> -153.32) the swell phase under her bows
  // moved with it and the forward hand's boots went under at tick 287 of 1200
  // instead of 336: a do-not-regress suite turned red on a fixture accident,
  // not on a behaviour change. (Her sinking DEPTH is identical either way —
  // y = -1.129 at the quarter mark at the berth and here — so the bottom was
  // never what moved. It was the sea over it, which is why re-pinning to a
  // different berth would only buy the next terrain lane the same failure.)
  // Pinned to clear water instead, and the clearance is ASSERTED below so a
  // future map change cannot silently re-berth her.
  ship.position.x = -640;
  ship.position.z = -350;
  ship.position.y = 0;
  ship.rotation = 0;
  ship.pitch = 0;
  ship.roll = 0;
  ship.holes = [];
  ship.nextHoleId = 1;
  let clearWater = Infinity;
  for (const island of st.islands) {
    clearWater = Math.min(clearWater, Math.hypot(
      ship.position.x - island.position.x, ship.position.z - island.position.z) - island.radius);
  }
  for (const rock of st.seaRocks ?? []) {
    clearWater = Math.min(clearWater, Math.hypot(
      ship.position.x - rock.position.x, ship.position.z - rock.position.z) - rock.colliderBoundsRadius);
  }
  expect('the founder fixture lies in open water (no berth under her, no bottom to sit on)',
    clearWater > 100, `clearWater=${clearWater.toFixed(0)} m to the nearest island edge or sea rock`);
  // Breaches all FORWARD: she must go down by the head, and the pirate standing
  // in the bows must get his boots wet before the one aft on the quarterdeck.
  //
  // WELL under the waterline, not -0.1. An unseeded Match puts this hull at a
  // random dock, and beginFounder freezes the list from the breaches that are
  // FLOODING at that instant — which reads the Gerstner surface at the hull's
  // own x/z. At -0.1 the crest/trough draw left the breach dry about one run in
  // seven, floodListTargets returned {0,0}, and the three assertions below
  // (list kept, down by the head, forward hand swims first) failed with
  // pitch=0.000 on green code. 40 unseeded fixtures at -0.6: no dry draw.
  match.physics.openHoleAt(ship, { x: 1.5, y: -0.6, z: stats.length * 0.30 }, 3, 'cannon');
  // Solo bots crew one hull each — press-gang a second hand aboard so the
  // fixture has a pirate at each end of her.
  const pressed = st.players.find((p) => p.onShipId !== ship.id && p.state !== 'eliminated');
  if (pressed) {
    pressed.onShipId = ship.id;
    pressed.shipId = ship.id;
    if (!ship.crewIds.includes(pressed.id)) ship.crewIds.push(pressed.id);
  }
  const crew = st.players.filter((p) => p.onShipId === ship.id && p.state !== 'eliminated');
  expect('the founder fixture has crew aboard', crew.length >= 2, `crew=${crew.length}`);
  const deckY = ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET;
  const aft = crew[0];
  const fwd = crew[1];
  aft.position = { x: ship.position.x, y: deckY, z: ship.position.z - stats.length * 0.18 };
  fwd.position = { x: ship.position.x, y: deckY, z: ship.position.z + stats.length * 0.18 };

  ship.waterLevel = 1;
  // A full hold has settled her (the heave target reads floodSettle): the
  // fixture jumps the water, so it takes the settle too, or the D15 inside
  // head reads the breach as pushed back by a hold she has not sunk into.
  // The descent profile is still paced from the design datum (b2.2g re-paces
  // the founder from the settled hull), so the settle is lifted again once the
  // founder has captured her list.
  const settle = floodSettle(ship.type, 1);
  ship.position.y -= settle;
  match.evaluateShipSinking(ship);
  ship.position.y += settle;
  expect('she founders', ship.sinking === true);
  expect('a foundering hull does NOT let go her anchor', ship.anchored === false,
    `anchored=${ship.anchored}`);
  expect('the crew are still aboard the tick she founders',
    crew.every((p) => p.onShipId === ship.id), crew.map((p) => `${p.id}:${p.onShipId}`).join(','));

  const rollAtFounder = ship.roll ?? 0;
  const ticks = Math.round(SHIP.SINK_TIME * 60);
  const aboardAt = new Map(crew.map((p) => [p.id, ticks]));
  let deckAwashAt = ticks;
  for (let i = 0; i < ticks; i += 1) {
    match.physics.update(DT, i * DT, st.ships, st.players, [], [], [], null);
    match.updateFounderingCrew(DT);
    for (const p of crew) {
      if (p.onShipId !== ship.id && aboardAt.get(p.id) === ticks) aboardAt.set(p.id, i);
    }
    if (deckAwashAt === ticks
      && ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET <= 0) deckAwashAt = i;
    if (i === Math.round(ticks * 0.25)) {
      expect('EVERY hand is still aboard a quarter of the way through the founder',
        crew.every((p) => p.onShipId === ship.id),
        `progress=${ship.sinkProgress.toFixed(2)} aboard=${crew.filter((p) => p.onShipId === ship.id).length}/${crew.length}`);
    }
    if (i === Math.round(ticks * 0.4)) {
      expect('she still has a crew on her at 40% of SINK_TIME (only the flooded end is awash)',
        crew.some((p) => p.onShipId === ship.id),
        `progress=${ship.sinkProgress.toFixed(2)} aboard=${crew.filter((p) => p.onShipId === ship.id).length}/${crew.length}`);
      expect('...and she still carries the list her breaches gave her',
        Math.abs(ship.roll ?? 0) > 0.02 || Math.abs(ship.pitch ?? 0) > 0.02,
        `pitch=${(ship.pitch ?? 0).toFixed(3)} roll=${(ship.roll ?? 0).toFixed(3)} atFounder=${rollAtFounder.toFixed(3)}`);
      expect('she is down by the HEAD, the end her breaches are in', (ship.pitch ?? 0) > 0.02,
        `pitch=${(ship.pitch ?? 0).toFixed(3)}`);
    }
  }
  expect('her weather deck goes under around 60% of SINK_TIME, not on the first tick',
    deckAwashAt > ticks * 0.4 && deckAwashAt < ticks * 0.8,
    `awash at tick ${deckAwashAt}/${ticks} (${(deckAwashAt / ticks * 100).toFixed(0)}%)`);
  expect('the pirate at the flooded end swims first, the one at the high end stays dry longer',
    aboardAt.get(fwd.id) < aboardAt.get(aft.id),
    `fwd=${aboardAt.get(fwd.id)} aft=${aboardAt.get(aft.id)} of ${ticks}`);
  expect('everyone is off her by the time she is gone',
    crew.every((p) => p.onShipId === null && (p.state === 'swimming' || p.state === 'downed' || p.state === 'eliminated')),
    crew.map((p) => `${p.state}:${p.onShipId}`).join(','));
  expect('the swimmers came out ALIVE (nobody drowned in the hull)',
    crew.every((p) => p.health > 0 || p.state === 'downed'),
    crew.map((p) => p.health.toFixed(1)).join(','));
}

// ────────────────────────────────────────────────────────────────────────────
// A hull's list is already IN her floor. getShipFloorYAt runs every branch
// through tiltFloor -> shipLocalUpY, so the heel/trim contribution is baked in;
// updateFounderingCrew used to add `local.x*sin(roll) - local.z*sin(pitch)` on
// top of it and judged the hand at the flooded rail up to 1.7 m lower than he
// stands, throwing him over the side off a plank that was still dry.
console.log('\nThe founder reads a plank once, not twice: a listed hull does not throw a dry hand over the side');

{
  const match = new Match({ matchId: 'founder-list-double-count', botCount: 3 });
  match.state.phase = 'playing';
  const st = match.state;
  const ship = st.ships[0];
  const stats = SHIP_STATS[ship.type];
  ship.position.x = -640;
  ship.position.z = -350;
  ship.position.y = 0;
  ship.rotation = 0;
  ship.pitch = 0;
  ship.roll = 0;
  ship.holes = [];
  ship.nextHoleId = 1;
  // Two hands on the rails, one each side, same plank height in her own frame.
  const crew = st.players.filter((p) => p.onShipId === ship.id && p.state !== 'eliminated');
  const pressed = st.players.find((p) => p.onShipId !== ship.id && p.state !== 'eliminated');
  if (crew.length < 2 && pressed) {
    pressed.onShipId = ship.id;
    pressed.shipId = ship.id;
    if (!ship.crewIds.includes(pressed.id)) ship.crewIds.push(pressed.id);
    crew.push(pressed);
  }
  expect('the listed-hull fixture has a hand on each rail', crew.length >= 2, `crew=${crew.length}`);
  const low = crew[0];
  const high = crew[1];
  const halfBeam = stats.width * 0.42;

  ship.waterLevel = 1;
  match.evaluateShipSinking(ship);
  expect('the listed-hull fixture founders', ship.sinking === true);
  // She lists to PORT (-x) hard, but nowhere near awash: sinkProgress is still 0.
  ship.sinkProgress = 0;
  ship.pitch = 0;
  ship.roll = 0.3;
  ship.position.y = 0;

  const sea = stormSeaState(st.storm, ship.position.x, ship.position.z);
  const probeY = () => ship.position.y + stats.height + 6;
  const footingAt = (worldX, worldZ) => getShipFloorYAt(
    { x: worldX, y: probeY(), z: worldZ }, ship, { x: worldX - ship.position.x, z: worldZ - ship.position.z },
  );
  const lowX = ship.position.x - halfBeam;
  const highX = ship.position.x + halfBeam;
  const surfaceLow = gerstnerHeight(lowX, ship.position.z, match.t, WAVE_PARAMS, sea);
  // Sit her deep enough that the DOWNHILL rail is only 15 cm of dry plank above
  // the sea — dry, but with no room for a phantom second helping of her list.
  ship.position.y = surfaceLow + 0.15 - footingAt(lowX, ship.position.z);
  const lowFooting = footingAt(lowX, ship.position.z);
  const highFooting = footingAt(highX, ship.position.z);
  const surfaceHigh = gerstnerHeight(highX, ship.position.z, match.t, WAVE_PARAMS, sea);
  expect('the downhill rail is genuinely still dry (barely)',
    lowFooting > surfaceLow && lowFooting - surfaceLow < 0.4,
    `footing=${lowFooting.toFixed(3)} surface=${surfaceLow.toFixed(3)}`);
  expect('...and the weather rail is a whole beam of list higher',
    highFooting - lowFooting > halfBeam * Math.sin(0.3) * 1.5,
    `high=${highFooting.toFixed(3)} low=${lowFooting.toFixed(3)}`);
  low.position = { x: lowX, y: lowFooting, z: ship.position.z };
  high.position = { x: highX, y: highFooting, z: ship.position.z };
  expect('both hands stand clear of the water before the pass runs',
    lowFooting > surfaceLow - FOUNDER_WADE_DEPTH && highFooting > surfaceHigh - FOUNDER_WADE_DEPTH);

  match.updateFounderingCrew(DT);
  expect('the hand at the LOW rail keeps his footing (his plank is above the sea)',
    low.onShipId === ship.id,
    `footing=${lowFooting.toFixed(3)} surface=${surfaceLow.toFixed(3)} wade=${FOUNDER_WADE_DEPTH}`);
  expect('the hand at the WEATHER rail keeps his too',
    high.onShipId === ship.id,
    `footing=${highFooting.toFixed(3)} surface=${surfaceHigh.toFixed(3)}`);

  // Now put the downhill plank genuinely under: only that hand goes over.
  ship.position.y -= 0.7;
  low.position.y = footingAt(lowX, ship.position.z);
  high.position.y = footingAt(highX, ship.position.z);
  match.updateFounderingCrew(DT);
  expect('once the downhill plank IS under, that hand goes over the side',
    low.onShipId !== ship.id, `footing=${low.position.y.toFixed(3)}`);
  expect('...and the hand on the weather rail is still aboard',
    high.onShipId === ship.id, `footing=${high.position.y.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nRepair reach is 3D: you go BELOW to plank a breach under the waterline (SINK-01 slice c)');

{
  const physics = new PhysicsSystem();
  const stats = SHIP_STATS.galleon;
  const ship = makeShip('galleon');
  const deckY = ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET;
  const holdY = ship.position.y + SHIP.HOLD_FLOOR_OFFSET;
  const [breach] = physics.openHoleAt(ship, { x: stats.width * 0.45, y: 0.05, z: 0 }, 1, 'cannon');
  expect('the fixture breach is a LOW one', breach.tier === 0, `tier=${breach.tier} y=${breach.y}`);
  const onDeck = { x: breach.x, y: deckY, z: breach.z };
  const inHold = { x: breach.x * 0.4, y: holdY, z: breach.z };
  expect('a hand on the weather deck can NOT plank a breach below the waterline',
    findRepairableHole(onDeck, ship) === null,
    `got=${JSON.stringify(findRepairableHole(onDeck, ship))}`);
  expect('...but standing in the hold beside it, he can',
    findRepairableHole(inHold, ship)?.id === breach.id,
    `local=${JSON.stringify(toShipLocalPoint(inHold, ship))}`);
  expect('the hold stand point really IS below decks',
    isStandingInShipHold(inHold, ship) && !isStandingInShipHold(onDeck, ship));

  // A topside breach is the other way round: worked from the deck, out of reach
  // from down in the hold. Both rails of the same 1.6 m band.
  const top = makeShip('galleon');
  const [high] = physics.openHoleAt(top, { x: stats.width * 0.45, y: stats.height * 0.7, z: 2 }, 1, 'cannon');
  expect('a TOPSIDE breach is reachable from the deck above it',
    findRepairableHole({ x: high.x, y: deckY, z: high.z }, top)?.id === high.id,
    `hole y=${high.y.toFixed(2)} tier=${high.tier}`);
  expect('...and is NOT reachable from the hold sole under it',
    findRepairableHole({ x: high.x * 0.4, y: holdY, z: high.z }, top) === null);

  // THE ENDS STAY REACHABLE. A bow ram lands beyond the forward edge of the
  // walkable hold, so a naive "must be below decks" rule would have made every
  // ramming breach unpatchable for the rest of the match.
  const rammed = makeShip('galleon');
  physics.openHoleAt(rammed, { x: 1.0, y: 0.05, z: stats.length * 0.5 }, 1, 'ram');
  const bow = rammed.holes[0];
  const holdEdge = { x: 0, y: holdY, z: stats.length * 0.33 };
  expect('the forward end of the hold is inside the walkable hold',
    isInsideShipHoldFootprint(toShipLocalPoint(holdEdge, rammed), stats),
    JSON.stringify(toShipLocalPoint(holdEdge, rammed)));
  expect('a BOW breach is reachable from the forward end of the hold',
    findRepairableHole(holdEdge, rammed)?.id === bow.id,
    `hole z=${bow.z.toFixed(2)}, hold edge z=${(stats.length * 0.33).toFixed(2)}`);
  // Same for the stern, which no walkable frame reaches either.
  const pooped = makeShip('galleon');
  physics.openHoleAt(pooped, { x: -1.0, y: 0.05, z: -stats.length * 0.5 }, 1, 'ram');
  expect('a STERN breach is reachable from the after end of the hold',
    findRepairableHole({ x: 0, y: holdY, z: -stats.length * 0.33 }, pooped)?.id === pooped.holes[0].id);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nThe bilge pump is a station in the hold: it beats ONE open breach and loses to three');

{
  const match = new Match({ matchId: 'pump-test', botCount: 2 });
  const stats = SHIP_STATS.sloop;
  const pump = getBilgePumpLocal(stats);
  expect('the pump stands on the walkable hold sole',
    isInsideShipHoldFootprint(pump, stats), JSON.stringify(pump));

  const ship = makeShip('sloop');
  // Her own patch of open sea (same reason as the founder scene above: the
  // ingress depth term reads the live Gerstner surface at her x/z).
  ship.position = { x: -640, y: 0, z: -350 };
  const hand = {
    id: 'pumper', onShipId: ship.id, state: 'alive',
    atCannon: false, atHelm: false, atCrowNest: false,
    position: {
      x: ship.position.x + pump.x,
      y: ship.position.y + SHIP.HOLD_FLOOR_OFFSET,
      z: ship.position.z + pump.z,
    },
  };
  expect('a hand at the brake is AT the pump', match.isNearBilgePump(hand, ship));
  const onDeck = { ...hand, position: { ...hand.position, y: ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET } };
  expect('...and the man standing on the deck above him is NOT', !match.isNearBilgePump(onDeck, ship));
  const acrossHer = { ...hand, position: { ...hand.position, z: hand.position.z + 4.0 } };
  expect('...nor is a hand at the other end of the hold', !match.isNearBilgePump(acrossHer, ship));

  const drain = (holeCount) => {
    ship.holes = [];
    ship.nextHoleId = 1;
    ship.pitch = 0;
    ship.roll = 0;
    for (let i = 0; i < holeCount; i += 1) {
      match.physics.openHoleAt(ship, { x: (i % 2 ? 1 : -1) * stats.width * 0.45, y: -0.15, z: (i - 1) * 1.5 }, 1, 'cannon');
    }
    expect(`the ${holeCount}-breach fixture is actually flooding`, shipIngressRate(ship, 0, 0) > 0);
    ship.waterLevel = 0.5;
    const riding = ship.position.y;
    for (let i = 0; i < 20 * 60; i += 1) {
      ship.position.y = riding - floodSettle(ship.type, ship.waterLevel); // she settles as she fills
      match.applyBilgePump(hand, ship, DT);
      updateShipFlooding(ship, 0, DT);
    }
    return ship.waterLevel;
  };
  const one = drain(1);
  expect('a manned pump GAINS on a single open breach', one < 0.5, `water 0.500 -> ${one.toFixed(3)}`);
  const three = drain(3);
  expect('...and LOSES to three (the plank still has to go in)', three > 0.5, `water 0.500 -> ${three.toFixed(3)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nNobody drowns in a sealed hold: she fills, and the hand below comes out over her side (liveplay-11)');

{
  const match = new Match({ matchId: 'hold-test', botCount: 3 });
  match.state.phase = 'playing';
  const st = match.state;
  const ship = st.ships[0];
  const stats = SHIP_STATS[ship.type];
  ship.position = { x: -640, y: 0, z: -350 };
  ship.rotation = 0;
  ship.pitch = 0;
  ship.roll = 0;
  ship.holes = [];
  ship.nextHoleId = 1;
  const below = st.players.find((p) => p.onShipId === ship.id);
  expect('the sealed-hold fixture has a hand aboard', !!below);
  below.position = {
    x: ship.position.x,
    y: ship.position.y + SHIP.HOLD_FLOOR_OFFSET,
    z: ship.position.z,
  };
  expect('...and he is DOWN IN HER, not on the deck lid', isStandingInFloodedHold(below.position, ship));
  const hpBefore = below.health;
  ship.waterLevel = 1;
  match.evaluateShipSinking(ship);
  expect('she founders', ship.sinking === true);
  // ONE tick of the founder pass. A hand on deck rides her down for tens of
  // seconds; the hold is already full, so he comes out on the first tick.
  match.updateFounderingCrew(DT);
  expect('the hand in the flooded hold is put OUT of her at once, not left inside',
    below.onShipId === null, `onShipId=${below.onShipId}`);
  for (let i = 0; i < 3 * 60; i += 1) {
    match.physics.update(DT, i * DT, st.ships, st.players, [], [], [], null);
    match.updateFounderingCrew(DT);
  }
  expect('he is still in the match', below.state !== 'eliminated' && below.health > 0,
    `state=${below.state} hp=${below.health}`);
  expect('he comes up AT the surface, not under her keel', below.position.y > -0.5,
    `y=${below.position.y.toFixed(2)}`);
  expect('he did not drown climbing out (< 10 hp)', hpBefore - below.health < 10,
    `hp ${hpBefore} -> ${below.health}`);
  expect('he is clear of her beam, not inside her hull',
    Math.hypot(below.position.x - ship.position.x, below.position.z - ship.position.z) > stats.width * 0.5,
    `dist=${Math.hypot(below.position.x - ship.position.x, below.position.z - ship.position.z).toFixed(2)} beam=${stats.width}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nHole sizes 1-3: a hit near a wound widens it, a bigger breach takes longer to plank (b2.2b, holes-04)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  const x = SHIP_STATS.sloop.width * 0.45;
  const at = (dz) => ({ x, y: 0.2, z: dz });
  const [first] = physics.openHoleAt(ship, at(0), 1, 'cannon');
  physics.openHoleAt(ship, at(0.3), 1, 'cannon');
  expect('2 balls 0.3 m apart -> ONE hole of size 2', ship.holes.length === 1 && ship.holes[0].size === 2,
    `holes=${ship.holes.length} sizes=${ship.holes.map((h) => h.size ?? 1).join(',')}`);
  physics.openHoleAt(ship, at(-0.3), 1, 'cannon');
  expect('3 balls -> size 3', ship.holes.length === 1 && ship.holes[0].size === 3,
    `holes=${ship.holes.length} sizes=${ship.holes.map((h) => h.size ?? 1).join(',')}`);
  const nextIdBefore = ship.nextHoleId;
  const [fourth] = physics.openHoleAt(ship, at(0.15), 1, 'cannon');
  expect('a 4th ball -> still size 3 and no new entity',
    ship.holes.length === 1 && ship.holes[0].size === 3 && fourth.id === first.id && ship.nextHoleId === nextIdBefore,
    `holes=${ship.holes.length} size=${ship.holes[0].size} id ${first.id}/${fourth.id}`);
  const q1 = holeIngress('sloop', holeSizeArea(1), 0.3, 0);
  const q3 = holeIngress('sloop', holeSizeArea(3), 0.3, 0);
  expect('a size-3 hole takes 2.8x the water of a size-1 at the same head', Math.abs(q3 / q1 - 2.8) < 1e-6,
    `ratio=${(q3 / q1).toFixed(3)}`);
  expect('render radius / repair time follow the size (0.16/0.24/0.31 m, 1.6/2.4/3.2 s)',
    [1, 2, 3].map(holeVisualRadius).join() === '0.16,0.24,0.31' && [1, 2, 3].map(holeRepairTime).join() === '1.6,2.4,3.2');

  const spaced = makeShip('sloop');
  physics.openHoleAt(spaced, at(0), 1, 'cannon');
  physics.openHoleAt(spaced, at(1.0), 1, 'cannon');
  expect('1.0 m apart -> 2 holes of size 1', spaced.holes.length === 2 && spaced.holes.every((h) => (h.size ?? 1) === 1),
    `holes=${spaced.holes.length}`);

  const cluster = makeShip('sloop');
  physics.openHoleAt(cluster, at(0), 3, 'keg', 2);
  expect('siblings of ONE event stay a cluster (keg face: 3 entities, the torn size 2 each)',
    cluster.holes.length === 3 && cluster.holes.every((h) => h.size === 2),
    `holes=${cluster.holes.length} sizes=${cluster.holes.map((h) => h.size ?? 1).join(',')}`);

  const planked = makeShip('sloop');
  const [p2] = physics.openHoleAt(planked, at(0), 1, 'cannon');
  physics.openHoleAt(planked, at(0.2), 1, 'cannon');
  physics.patchHole(planked, p2.id);
  physics.openHoleAt(planked, at(0.25), 1, 'cannon');
  expect('a hit on a PATCHED hole knocks the plank off at its old size (no new entity)',
    planked.holes.length === 1 && !planked.holes[0].patched && planked.holes[0].size === 2,
    `holes=${planked.holes.length} patched=${planked.holes[0].patched} size=${planked.holes[0].size}`);
}

{
  // Held input on the REAL Match repair block: a size-3 breach needs >= 3.0 s.
  const heldToPlank = (size) => {
    const match = new Match({ matchId: `hole-size-${size}`, botCount: 1 });
    match.state.phase = 'playing';
    const ship = match.state.ships[0];
    const stats = SHIP_STATS[ship.type];
    ship.holes = [];
    ship.anchored = false;
    const [h] = match.physics.openHoleAt(ship, { x: stats.width * 0.45, y: 0.05, z: 0 }, 1, 'cannon', size);
    const player = match.state.players.find((p) => p.shipId === ship.id) ?? match.state.players[0];
    player.onShipId = ship.id;
    player.atCannon = false; player.atHelm = false; player.atCrowNest = false;
    player.pocketWood = 5;
    const lx = stats.width * 0.45;
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    // In the hold beside a LOW breach (the SINK-01 3D reach rule).
    player.position = {
      x: ship.position.x + lx * 0.4 * cos,
      y: ship.position.y + SHIP.HOLD_FLOOR_OFFSET,
      z: ship.position.z - lx * 0.4 * sin,
    };
    const reach = findRepairableHole(player.position, ship)?.id === h.id;
    const client = { playerId: player.id, appliedInputSeq: 0, consumedSeq: {}, lastOneShotAt: {} };
    const dt = 1 / 30;
    let held = 0;
    for (let seq = 1; seq < 400 && !h.patched; seq += 1) {
      match.applyInput(client, { seq, yaw: 0, pitch: 0, interactHeld: true, interactIntent: 'repair' }, dt);
      held += dt;
    }
    return { reach, held: h.patched ? held : Infinity };
  };
  const s1 = heldToPlank(1);
  const s3 = heldToPlank(3);
  expect('repair fixture: the pirate can reach the breach', s1.reach && s3.reach, `reach ${s1.reach}/${s3.reach}`);
  expect('a size-1 hole planks in ~1.6 s of held input', s1.held > 1.5 && s1.held < 1.8, `held=${s1.held.toFixed(2)} s`);
  expect('a size-3 repair needs >= 3.0 s of held input', s3.held >= 3.0 && s3.held < 3.5, `held=${s3.held.toFixed(2)} s`);
}

console.log('\nThe SoT bucket (b2.2d, holes-05): scoop in the hold water, throw over the rail, bots walk the cycle, no auto-carpenter:');
{
  const setup = (id) => {
    const match = new Match({ matchId: `bucket-${id}`, botCount: 1 });
    match.state.phase = 'playing';
    const ship = match.state.ships[0];
    ship.holes = []; ship.pitch = 0; ship.roll = 0; ship.heave = 0; ship.anchored = true;
    ship.waterLevel = 0.5;
    const stats = SHIP_STATS[ship.type];
    const player = match.state.players.find((p) => p.shipId === ship.id) ?? match.state.players[0];
    player.onShipId = ship.id; player.shipId = ship.id;
    player.atCannon = false; player.atHelm = false; player.atCrowNest = false;
    player.equippedTool = 'bucket'; player.bucketFilled = false; player.bailScoopProgress = 0;
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const place = (lx, ly, lz) => {
      player.position = { x: ship.position.x + lx * cos + lz * sin, y: ship.position.y + ly, z: ship.position.z + lz * cos - lx * sin };
    };
    const deckY = stats.height + SHIP.DECK_STAND_OFFSET;
    const holdY = SHIP.HOLD_FLOOR_OFFSET;
    const client = { playerId: player.id, appliedInputSeq: 0, consumedSeq: {}, lastOneShotAt: {} };
    let seq = 0;
    const press = (yawRel, pitch) => {
      match.t += 1; player.bailScoopProgress = 0; seq += 1;
      match.applyInput(client, { seq, yaw: ship.rotation + yawRel, pitch, useItem: true, slot: null }, 1 / 30);
      player.bailScoopProgress = 0;
    };
    const settle = (seconds) => { const end = match.t + seconds; while (match.t < end) { match.t += 1 / 30; match.processBailReturns?.(); } };
    return { match, ship, stats, player, place, deckY, holdY, press, settle };
  };

  { // 1. weather deck, looking ahead: refused
    const k = setup('deck');
    k.place(0.3, k.deckY, -k.stats.length * 0.3);
    k.press(0, -0.2);
    expect('a scoop from the weather deck is refused (water unchanged)', k.ship.waterLevel === 0.5 && !k.player.bucketFilled,
      `water ${k.ship.waterLevel} filled ${k.player.bucketFilled}`);
  }
  { // 2. in the hold: scoop works, a heave down there comes back within 1.5 s
    const k = setup('hold');
    k.place(k.stats.width * 0.2, k.holdY, -k.stats.length * 0.2);
    k.press(0, -0.6);
    const afterScoop = k.ship.waterLevel;
    expect('standing in hold water 0.5 the scoop takes a bucketful', k.player.bucketFilled && afterScoop < 0.5, `water ${afterScoop}`);
    k.press(0, 0);
    k.settle(1.5);
    expect('a heave inside the hold returns within 1.5 s (net 0)', Math.abs(k.ship.waterLevel - 0.5) < 1e-9 && !k.player.bucketFilled,
      `water ${k.ship.waterLevel}`);
    expect('the spilled bucket raises a splash event', (k.match.bailSpills ?? []).some((e) => e.landing === 'inHold'), JSON.stringify(k.match.bailSpills));
    // 3. at the starboard rail, aimed outboard: gone for good
    k.press(0, -0.6);
    const scooped = k.ship.waterLevel;
    k.place(k.stats.width * 0.40, k.deckY, 0);
    k.press(Math.PI / 2, 0);
    k.settle(2);
    expect('a heave at the rail aimed outboard removes it', Math.abs(k.ship.waterLevel - scooped) < 1e-9 && scooped < 0.5,
      `scooped ${scooped} now ${k.ship.waterLevel}`);
    // ... and the same heave aimed inboard lands on deck and runs back
    k.place(k.stats.width * 0.2, k.holdY, -k.stats.length * 0.2);
    k.press(0, -0.6);
    const s2 = k.ship.waterLevel;
    k.place(k.stats.width * 0.40, k.deckY, 0);
    k.press(-Math.PI / 2, 0);
    k.settle(1.5);
    expect('a heave at the rail aimed inboard lands on deck and returns', Math.abs(k.ship.waterLevel - (s2 + FLOODING.BAIL_SCOOP_VOLUME)) < 1e-9,
      `scooped ${s2} now ${k.ship.waterLevel}`);
  }
  { // 4. a bot on the weather deck does not drain remotely
    const k = setup('bot');
    k.player.isBot = true;
    k.place(0.4, k.deckY, -k.stats.length * 0.3);
    const start = { ...k.player.position };
    for (let i = 0; i < 30; i += 1) { k.match.t += 1 / 30; k.match.updateBotFlooding(1 / 30); }
    expect('a bot on the weather deck with water 0.5 lowers it by 0 in 1 s', k.ship.waterLevel === 0.5, `water ${k.ship.waterLevel}`);
    const moved = Math.hypot(k.player.position.x - start.x, k.player.position.z - start.z);
    expect('... and he is walking to the hold, not standing still', moved > 0.05 || (k.player.velocity && Math.hypot(k.player.velocity.x, k.player.velocity.z) > 0.1), `moved ${moved.toFixed(3)} m`);
    k.place(k.stats.width * 0.2, k.holdY, -k.stats.length * 0.2);
    for (let i = 0; i < 3; i += 1) { k.match.t += 1 / 30; k.match.updateBotFlooding(1 / 30); }
    expect('once in the hold water the bot scoops a bucketful', k.player.bucketFilled && k.ship.waterLevel < 0.5, `water ${k.ship.waterLevel}`);
  }
  { // 5. no auto-carpenter
    const k = setup('carpenter');
    k.ship.inventory = [{ item: 'wood_plank', qty: 20 }];
    k.ship.holes = [hole(k.stats.width * 0.45, 0.05, 0), hole(-k.stats.width * 0.45, 0.05, 1)];
    for (const p of k.match.state.players) { p.onShipId = null; p.position = { x: 9999, y: 0, z: 9999 }; }
    for (let i = 0; i < 60 * 30; i += 1) { k.match.t += 1 / 30; k.match.updateFieldRepairs(1 / 30); }
    expect('no hole closes without a pirate at it (60 s anchored, 20 planks aboard)', k.ship.holes.every((h) => !h.patched),
      `patched ${k.ship.holes.filter((h) => h.patched).length}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} flooding assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll flooding assertions passed.');
