#!/usr/bin/env node
// test-anchor-turn (b2.1c, D22, mechanicshud-09 / physics-01).
// The anchor on the REAL PhysicsSystem at the 62.5 Hz server tick:
//   - the cable pays out for 2.0 s and the hull feels nothing (vs a twin with no anchor)
//   - the bite never decelerates harder than 0.6 g and stops her in 1.5-3.0 s from top speed
//   - sloop at 12 m/s with full rudder turns >= 90 deg within 6 s and ends < 0.5 m/s;
//     rudder centred she turns < 20 deg
//   - the anchor turn pivots about the BOW (the stern swings, the bow is held)
//   - a hull that spawns anchored is already held (no pay-out, no creep)
//   - no bow breach, whatever the bite speed
//   - pure state machine: stagger above 5 m/s, raise 3.2 s solo / 2.0 s with two
import {
  ANCHOR_MAX_DECEL, ANCHOR_PAYOUT_SECONDS, anchorBiteStaggers, anchorRaiseSeconds, stepAnchorPhase,
} from '../src/shared/anchor.ts';
import { CLASS_TOP_SPEED } from '../src/shared/sailing.ts';
import { PhysicsSystem, applyShipRudderSteering } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { readFileSync } from 'node:fs';

const DEG = Math.PI / 180;
const TICK = 0.016;
const G = 9.81;
let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
function makeShip(type, id = `ship-${type}`) {
  const stats = SHIP_STATS[type];
  return {
    id, type, ownerId: 'owner', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], rudderAngle: 0,
  };
}
const helmFor = (s) => ({ id: `helm-${s.id}`, atHelm: true, onShipId: s.id, state: 'eliminated', respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0 });
const speedOf = (s) => Math.hypot(s.velocity.x, s.velocity.z);
const bowOf = (s) => {
  const h = SHIP_STATS[s.type].length / 2;
  return { x: s.position.x + Math.sin(s.rotation) * h, z: s.position.z + Math.cos(s.rotation) * h };
};
const sternOf = (s) => {
  const h = SHIP_STATS[s.type].length / 2;
  return { x: s.position.x - Math.sin(s.rotation) * h, z: s.position.z - Math.cos(s.rotation) * h };
};

/**
 * Run one anchor drop. The hull starts at `v0` m/s, canvas struck (the drop
 * is the only thing that changes her way), helm `rudder` from `helmFrom` s.
 * `anchor=false` runs the no-anchor twin.
 */
function drop(type, v0, { rudder = 0, helmFrom = 0, anchor = true, seconds = 6, sail = 0 } = {}) {
  const physics = new PhysicsSystem();
  const ship = makeShip(type);
  ship.sailHeight = sail;
  // Seed the physics state with the anchor up (a hull that has been sailing).
  physics.update(TICK, TICK, [ship], [], [], [], []);
  ship.position.x = 0; ship.position.z = 0; ship.rotation = 0; ship.angularVelocity = 0;
  ship.velocity.x = 0; ship.velocity.z = v0;
  ship.anchored = anchor;
  const helm = helmFor(ship);
  const rows = [];
  let t = TICK;
  let prevSpeed = speedOf(ship);
  let pivotSum = 0; let pivotW = 0;
  let peakDecel = 0; let tStop = null; let bowAtBite = null; let sternAtBite = null; let headingAtBite = null;
  for (let i = 0; i < seconds / TICK; i++) {
    const el = (i + 1) * TICK;
    const steer = el > helmFrom ? rudder : 0;
    applyShipRudderSteering(ship, TICK, steer, 1);
    t += TICK;
    physics.update(TICK, t, [ship], [helm], [], [], []);
    const s = speedOf(ship);
    peakDecel = Math.max(peakDecel, (prevSpeed - s) / TICK);
    prevSpeed = s;
    if (bowAtBite === null && el >= ANCHOR_PAYOUT_SECONDS + TICK) {
      bowAtBite = bowOf(ship); sternAtBite = sternOf(ship); headingAtBite = ship.rotation;
    }
    if (tStop === null && s < 0.5) tStop = el;
    // Pivot point: where along the hull (m forward of the centre) the sideways
    // velocity is zero, weighted by the swing rate, from the bite on.
    if (el > ANCHOR_PAYOUT_SECONDS && Math.abs(ship.angularVelocity) > 0.02) {
      const lat = Math.cos(ship.rotation) * ship.velocity.x - Math.sin(ship.rotation) * ship.velocity.z;
      pivotSum += (-lat / ship.angularVelocity) * Math.abs(ship.angularVelocity); pivotW += Math.abs(ship.angularVelocity);
    }
    rows.push({ el, s, rot: ship.rotation });
  }
  const bowMove = bowAtBite ? Math.hypot(bowOf(ship).x - bowAtBite.x, bowOf(ship).z - bowAtBite.z) : NaN;
  const sternMove = sternAtBite ? Math.hypot(sternOf(ship).x - sternAtBite.x, sternOf(ship).z - sternAtBite.z) : NaN;
  return {
    ship, rows, peakDecel, tStop, bowMove, sternMove, pivot: pivotW > 0 ? pivotSum / pivotW : NaN,
    turn: Math.abs(ship.rotation) / DEG,
    turnSinceBite: headingAtBite === null ? 0 : Math.abs(ship.rotation - headingAtBite) / DEG,
    speedAt: (sec) => rows[Math.max(0, Math.round(sec / TICK) - 1)].s,
  };
}

console.log('Section 1: pay-out (no deceleration before the anchor bites)');
for (const type of ['sloop', 'galleon']) {
  const a = drop(type, 12, { rudder: 1 });
  const b = drop(type, 12, { rudder: 1, anchor: false });
  const at = ANCHOR_PAYOUT_SECONDS - 0.05;
  const diff = Math.abs(a.speedAt(at) - b.speedAt(at));
  expect(`${type}: at ${at.toFixed(2)} s the anchored hull still carries the way of a twin with no anchor`, diff < 0.02,
    `anchored ${a.speedAt(at).toFixed(3)} vs twin ${b.speedAt(at).toFixed(3)} m/s`);
}

console.log('\nSection 2: the bite (<= 0.6 g, stop in 1.5-3.0 s from top speed)');
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const v0 = CLASS_TOP_SPEED[type];
  // Canvas SET through the pay-out (dropped at full way, as a crew does): she
  // bites near her top speed and the rode must beat the canvas too.
  const r = drop(type, v0, { seconds: 8, sail: 1 });
  const stopAfterBite = r.tStop === null ? null : r.tStop - ANCHOR_PAYOUT_SECONDS;
  expect(`${type}: bites near full way (>= 80% of ${v0} m/s)`, r.speedAt(ANCHOR_PAYOUT_SECONDS) >= 0.8 * v0,
    `${r.speedAt(ANCHOR_PAYOUT_SECONDS).toFixed(2)} m/s at the bite`);
  expect(`${type}: peak deceleration <= 0.6 g`, r.peakDecel <= ANCHOR_MAX_DECEL + 1e-6,
    `peak ${r.peakDecel.toFixed(2)} m/s^2 = ${(r.peakDecel / G).toFixed(2)} g`);
  expect(`${type}: from ${v0} m/s the bite stops her (< 0.5 m/s) in 1.5-3.0 s`, stopAfterBite !== null && stopAfterBite >= 1.5 && stopAfterBite <= 3.0,
    `${stopAfterBite === null ? 'never' : stopAfterBite.toFixed(2)} s after the bite`);
  expect(`${type}: no bow breach from a ${v0} m/s bite`, r.ship.holes.length === 0, `${r.ship.holes.length} holes`);
}

console.log('\nSection 3: the anchor turn (sloop at 12 m/s)');
{
  const hard = drop('sloop', 12, { rudder: 1 });
  expect('full rudder turns >= 90 deg within 6 s', hard.turn >= 90, `${hard.turn.toFixed(1)} deg`);
  expect('full rudder ends < 0.5 m/s at 6 s', hard.speedAt(6) < 0.5, `${hard.speedAt(6).toFixed(2)} m/s`);
  expect('full rudder: peak deceleration <= 0.6 g', hard.peakDecel <= ANCHOR_MAX_DECEL + 1e-6, `${(hard.peakDecel / G).toFixed(2)} g`);
  const centred = drop('sloop', 12, { rudder: 0 });
  expect('rudder centred turns < 20 deg', centred.turn < 20, `${centred.turn.toFixed(1)} deg`);
  expect('rudder centred ends < 0.5 m/s at 6 s', centred.speedAt(6) < 0.5, `${centred.speedAt(6).toFixed(2)} m/s`);
  // The helm put over only as the anchor bites: the swing is the anchor's, not the rudder's.
  const late = drop('sloop', 12, { rudder: 1, helmFrom: ANCHOR_PAYOUT_SECONDS });
  const coast = drop('sloop', 12, { rudder: 1, helmFrom: ANCHOR_PAYOUT_SECONDS, anchor: false });
  expect('helm over at the bite: the anchor turn swings her 45-90 deg', late.turnSinceBite >= 45 && late.turnSinceBite <= 90,
    `${late.turnSinceBite.toFixed(1)} deg after the bite`);
  const half = SHIP_STATS.sloop.length / 2;
  expect('she pivots about the BOW: the swing-weighted pivot point lies in the forward 20% of the hull', late.pivot >= 0.6 * half,
    `pivot ${late.pivot.toFixed(2)} m forward of the centre (bow at ${half}); free-turn twin ${coast.pivot.toFixed(2)} m; stern travel ${late.sternMove.toFixed(1)} m vs bow ${late.bowMove.toFixed(1)} m`);
  expect('the anchor turn is tighter than the same helm with no anchor (bow travel)', late.bowMove < 0.5 * coast.bowMove,
    `anchored bow ${late.bowMove.toFixed(1)} m vs free bow ${coast.bowMove.toFixed(1)} m`);
  // PLAN 3.7: anchor turn 45-90 deg; the longest hull swings least.
  const swings = {};
  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const r = drop(type, 12, { rudder: 1, helmFrom: ANCHOR_PAYOUT_SECONDS });
    swings[type] = r.turnSinceBite;
    expect(`${type}: helm over at a 12 m/s bite swings her 45-90 deg`, r.turnSinceBite >= 45 && r.turnSinceBite <= 90, `${r.turnSinceBite.toFixed(1)} deg`);
    const mirror = drop(type, 12, { rudder: -1, helmFrom: ANCHOR_PAYOUT_SECONDS });
    expect(`${type}: the other helm swings her the other way by the same amount`, Math.abs(mirror.ship.rotation + r.ship.rotation) < 1e-6 && Math.sign(r.ship.rotation) === -1,
      `helm right ${(r.ship.rotation / DEG).toFixed(2)} deg, helm left ${(mirror.ship.rotation / DEG).toFixed(2)} deg`);
  }
  expect('the galleon swings least', swings.galleon <= swings.sloop && swings.galleon <= swings.brigantine,
    `sloop ${swings.sloop.toFixed(1)} / brig ${swings.brigantine.toFixed(1)} / galleon ${swings.galleon.toFixed(1)} deg`);
}

console.log('\nSection 4: held, canvas, spawn');
{
  // Canvas set while anchored: the rode holds her.
  const sails = drop('sloop', 0, { sail: 1, seconds: 12 });
  const maxAfter = Math.max(...sails.rows.filter((r) => r.el > 5).map((r) => r.s));
  expect('canvas set on a held anchor: she stays < 0.5 m/s', maxAfter < 0.5, `max ${maxAfter.toFixed(2)} m/s after 5 s`);
  // A hull spawned anchored is held from the first tick (no 2 s drift out of her berth).
  const physics = new PhysicsSystem();
  const ship = makeShip('brigantine');
  ship.anchored = true; ship.velocity.z = 2;
  let t = 0; let first = null;
  for (let i = 0; i < 1 / TICK; i++) { t += TICK; physics.update(TICK, t, [ship], [], [], [], []); if (first === null) first = speedOf(ship); }
  expect('spawned anchored: held from the first tick (speed falls, no pay-out)', speedOf(ship) < 0.5 && first < 2,
    `after 1 s ${speedOf(ship).toFixed(2)} m/s`);
}

console.log('\nSection 5: the state machine');
{
  let s = stepAnchorPhase(undefined, false, 0, 0).state;
  expect('a fresh unanchored hull is raised', s.phase === 'raised');
  s = stepAnchorPhase(s, true, 1, 8).state;
  expect('drop -> dropping', s.phase === 'dropping');
  const early = stepAnchorPhase(s, true, 2.9, 8);
  expect('still dropping at 1.9 s', early.state.phase === 'dropping' && !early.bit);
  const bite = stepAnchorPhase(s, true, 3.0, 8);
  expect('bites at 2.0 s and reports the bite speed', bite.state.phase === 'biting' && bite.bit && bite.biteSpeed === 8);
  expect('held once the way is off', stepAnchorPhase(bite.state, true, 4, 0.1).state.phase === 'held');
  expect('raise -> raised', stepAnchorPhase(bite.state, false, 4, 3).state.phase === 'raised');
  expect('spawned anchored starts held', stepAnchorPhase(undefined, true, 0, 0).state.phase === 'held');
  expect('crew stagger above 5 m/s only', anchorBiteStaggers(5.5) && !anchorBiteStaggers(5) && !anchorBiteStaggers(2));
  expect('raise 3.2 s solo, 2.0 s with two (and not faster with three)', anchorRaiseSeconds(1) === 3.2 && anchorRaiseSeconds(2) === 2.0 && anchorRaiseSeconds(3) === 2.0);
}

console.log('\nSection 6: one source (server physics and the capstan read shared/anchor.ts)');
{
  const phys = readFileSync(new URL('../src/server/systems/PhysicsSystem.ts', import.meta.url), 'utf8');
  const match = readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
  expect('PhysicsSystem steps the shared state machine and the rode law', /stepAnchorPhase\(/.test(phys) && /rodeForwardStep\(/.test(phys) && /anchorTurnOmega\(/.test(phys));
  expect('PhysicsSystem keeps no hand-brake (no ANCHOR_BRAKE in the force path)', !/SHIP\.ANCHOR_BRAKE/.test(phys));
  expect('the capstan raise rate comes from anchorRaiseSeconds(hands), shared between the hands',
    /anchorRaiseSeconds\(hands\) \* hands/.test(match) && !/anchorRaiseProgress \+ dt \/ SHIP\.ANCHOR_RAISE_TIME\)/.test(match));
}

if (failures) { console.error(`\ntest-anchor-turn: ${failures} failure(s)`); process.exit(1); }
console.log('\ntest-anchor-turn: all checks passed');
