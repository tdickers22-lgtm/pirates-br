#!/usr/bin/env node
// test-ship-collision-mass (b2.1g, physics-08, PLAN 3.7 collisions).
// Rams on the REAL PhysicsSystem at the 62.5 Hz server tick, canvas struck,
// after the truce (t > 150 s):
//   - a galleon ramming a stationary sloop at 8 m/s keeps >= 70% of her way
//     (vs a twin galleon that hit nothing); the sloop ramming a stationary
//     galleon keeps <= 30%
//   - damage follows mass: the same reduced-mass impact energy stoves the
//     lighter hull in harder (sloop:galleon damage ~ 3.6:1 = the mass ratio),
//     and the sloop loses more planks than the galleon
//   - each crew feels its OWN hull's delta-v (hullJolts), sloop:galleon ~ 3.6:1
//   - equal hulls (sloop vs sloop) share the blow evenly
//   - the outcome does not depend on the order of the ships array (bit-equal)
//   - a sea rock is infinite mass: a head-on strike rebounds at e = 0.2
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { HULL_PARAMS } from '../src/shared/sailing.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

const TICK = 0.016;
const T0 = 1000; // well after the 150 s truce
let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
function makeShip(type, id) {
  const stats = SHIP_STATS[type];
  return {
    id, type, ownerId: `owner-${id}`, crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], rudderAngle: 0,
  };
}

/**
 * `rammer` sails +z at `v0` straight at `target`, which lies stopped ahead of
 * her, bow to bow (both hulls on the centreline, so both stems meet and both
 * hulls take the same T-bone factor). Returns the rammer's way 0.4 s after
 * the first contact as a fraction of a twin that hit nothing, the ram damage
 * and holes per hull, the jolts, and the final state for the order check.
 */
function ram(rammerType, targetType, v0 = 8, { reverseOrder = false, seconds = 3 } = {}) {
  const physics = new PhysicsSystem();
  const twinPhysics = new PhysicsSystem();
  const a = makeShip(rammerType, 'rammer');
  const b = makeShip(targetType, 'target');
  const twin = makeShip(rammerType, 'twin');
  const gap = 3;
  const place = () => {
    for (const s of [a, b, twin]) { s.velocity.x = 0; s.velocity.z = 0; s.angularVelocity = 0; s.position.x = 0; s.position.y = 0; }
    a.position.z = 0; a.rotation = 0; a.velocity.z = v0;
    twin.position.z = 0; twin.rotation = 0; twin.velocity.z = v0;
    b.position.z = SHIP_STATS[rammerType].length / 2 + SHIP_STATS[targetType].length / 2 + gap;
    b.rotation = Math.PI;
  };
  const ships = reverseOrder ? [b, a] : [a, b];
  // Seed each hull's dynamics state, then place them.
  physics.update(TICK, T0, ships, [], [], [], []);
  twinPhysics.update(TICK, T0, [twin], [], [], [], []);
  physics.flushCombatEvents();
  place();
  let t = T0;
  let contactTick = null;
  let keptAt04 = null;
  const damage = { rammer: 0, target: 0 };
  const jolts = { rammer: 0, target: 0 };
  let impacts = 0;
  const n = Math.round(seconds / TICK);
  for (let i = 0; i < n; i++) {
    t += TICK;
    physics.update(TICK, t, ships, [], [], [], []);
    twinPhysics.update(TICK, t, [twin], [], [], [], []);
    for (const ev of physics.flushCombatEvents()) {
      if (ev.type === 'ship_ram') damage[ev.targetId] += ev.damage;
      if (ev.type === 'ship_impact' && ev.kind === 'ram') impacts += 1;
    }
    for (const j of physics.hullJolts ?? []) jolts[j.shipId] = Math.max(jolts[j.shipId], j.deltaV);
    if (contactTick === null && Math.abs(b.velocity.z) > 0.3) contactTick = i;
    if (contactTick !== null && keptAt04 === null && i === contactTick + 25) keptAt04 = a.velocity.z / twin.velocity.z;
  }
  const holes = { rammer: a.holes.filter((h) => !h.patched).length, target: b.holes.filter((h) => !h.patched).length };
  const state = [a, b].map((s) => [s.position.x, s.position.z, s.velocity.x, s.velocity.z, s.rotation, s.angularVelocity,
    s.holes.map((h) => `${h.x},${h.z},${h.y},${h.size ?? ''}`).join(';')]);
  return { contactTick, kept: keptAt04, damage, holes, jolts, impacts, state };
}

const MASS_RATIO = HULL_PARAMS.galleon.mass / HULL_PARAMS.sloop.mass;
console.log(`Ship collisions carry mass (galleon:sloop = ${MASS_RATIO.toFixed(2)})`);

const gs = ram('galleon', 'sloop');
expect('galleon ram: the hulls meet', gs.contactTick !== null, `contact tick ${gs.contactTick}`);
expect('galleon ramming a stationary sloop at 8 m/s keeps >= 70% of her way',
  gs.kept !== null && gs.kept >= 0.70, `kept ${(gs.kept * 100).toFixed(1)}% of the twin 0.4 s after contact`);
const sg = ram('sloop', 'galleon');
expect('sloop ramming a stationary galleon at 8 m/s keeps <= 30% of her way',
  sg.kept !== null && sg.kept <= 0.30, `kept ${(sg.kept * 100).toFixed(1)}%`);

// Damage follows mass. In both rams the sloop is the lighter hull.
const ratio1 = gs.damage.target / Math.max(1e-9, gs.damage.rammer);
const ratio2 = sg.damage.rammer / Math.max(1e-9, sg.damage.target);
expect('galleon rams sloop: sloop:galleon damage ~ the mass ratio (+-20%)',
  Math.abs(ratio1 / MASS_RATIO - 1) <= 0.2, `damage sloop ${gs.damage.target.toFixed(1)} galleon ${gs.damage.rammer.toFixed(1)} ratio ${ratio1.toFixed(2)}`);
expect('sloop rams galleon: sloop:galleon damage ~ the mass ratio (+-20%)',
  Math.abs(ratio2 / MASS_RATIO - 1) <= 0.2, `damage sloop ${sg.damage.rammer.toFixed(1)} galleon ${sg.damage.target.toFixed(1)} ratio ${ratio2.toFixed(2)}`);
expect('the sloop loses more planks than the galleon (both rams)',
  gs.holes.target > gs.holes.rammer && sg.holes.rammer > sg.holes.target,
  `galleon-rams: sloop ${gs.holes.target} / galleon ${gs.holes.rammer}; sloop-rams: sloop ${sg.holes.rammer} / galleon ${sg.holes.target}`);
expect('the sloop is holed in both rams (8 m/s is a real ram)', gs.holes.target >= 1 && sg.holes.rammer >= 1);
expect('one crash FX per contact', gs.impacts >= 1 && sg.impacts >= 1, `${gs.impacts} / ${sg.impacts}`);

// Crew stagger reads each hull's own delta-v.
const joltRatio = gs.jolts.target / Math.max(1e-9, gs.jolts.rammer);
expect('hullJolts: each crew feels its own hull delta-v, sloop:galleon ~ mass ratio (+-20%)',
  Math.abs(joltRatio / MASS_RATIO - 1) <= 0.2, `sloop ${gs.jolts.target.toFixed(2)} m/s, galleon ${gs.jolts.rammer.toFixed(2)} m/s`);
expect('hullJolts: the sloop is thrown by > 5 m/s, the galleon by < 2.5 m/s',
  gs.jolts.target > 5 && gs.jolts.rammer < 2.5, `sloop ${gs.jolts.target.toFixed(2)} galleon ${gs.jolts.rammer.toFixed(2)}`);

// Equal hulls share it.
const ss = ram('sloop', 'sloop');
const ssRatio = ss.damage.target / Math.max(1e-9, ss.damage.rammer);
expect('sloop vs sloop: damage shared evenly (ratio 0.8-1.25)', ssRatio >= 0.8 && ssRatio <= 1.25, `ratio ${ssRatio.toFixed(2)}`);
expect('sloop vs sloop: the rammer keeps 30-50% of her way (e 0.2 -> 40%)', ss.kept >= 0.30 && ss.kept <= 0.50, `kept ${(ss.kept * 100).toFixed(1)}%`);

// Array order does not change the outcome.
for (const [ra, ta] of [['galleon', 'sloop'], ['sloop', 'galleon'], ['brigantine', 'sloop']]) {
  const fwd = ram(ra, ta);
  const rev = ram(ra, ta, 8, { reverseOrder: true });
  const same = JSON.stringify(fwd.state) === JSON.stringify(rev.state)
    && JSON.stringify(fwd.damage) === JSON.stringify(rev.damage);
  expect(`${ra} rams ${ta}: bit-equal whichever hull comes first in the ships array`, same,
    same ? '' : `fwd ${JSON.stringify(fwd.state)}\n     rev ${JSON.stringify(rev.state)}\n     dmg ${JSON.stringify(fwd.damage)} vs ${JSON.stringify(rev.damage)}`);
}

// A sea rock is infinite mass: head-on at 5 m/s, she rebounds at e = 0.2.
{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', 'rocker');
  physics.update(TICK, T0, [ship], [], [], [], []);
  ship.position.x = 0; ship.position.z = 0; ship.rotation = 0; ship.velocity.x = 0; ship.velocity.z = 5; ship.angularVelocity = 0;
  const rock = {
    id: 'rock', position: { x: 0, y: 0, z: 12 }, radius: 3, height: 10, rotation: 0, variant: 0, colliderBoundsRadius: 3,
    colliders: [{ localX: 0, localZ: 0, radius: 1.35, minY: -3, maxY: 9 }],
  };
  let t = T0; let vIn = null; let vOut = null; let rockJolt = 0;
  for (let i = 0; i < 200 && vOut === null; i++) {
    const before = ship.velocity.z;
    t += TICK;
    physics.update(TICK, t, [ship], [], [], [], [rock]);
    for (const j of physics.hullJolts ?? []) rockJolt = Math.max(rockJolt, j.deltaV);
    if (vIn === null && ship.velocity.z < before - 0.5) { vIn = before; vOut = ship.velocity.z; }
  }
  physics.flushCombatEvents();
  expect('sea rock: the hull strikes it', vIn !== null, `in ${vIn?.toFixed(2)} m/s`);
  const e = vIn ? -vOut / vIn : NaN;
  expect('sea rock is infinite mass: head-on rebound at e = 0.2 (0.15-0.25)', e >= 0.15 && e <= 0.25, `e ${e.toFixed(3)}`);
  expect('sea rock: the crew feel the whole delta-v ((1+e) v)', vIn && Math.abs(rockJolt / (1.2 * vIn) - 1) < 0.1,
    `jolt ${rockJolt.toFixed(2)} m/s`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll ship collision mass checks passed.');
