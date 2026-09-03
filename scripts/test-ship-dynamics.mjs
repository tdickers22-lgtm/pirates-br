#!/usr/bin/env node
// Ship dynamics: sail polar, rudder-needs-way, oriented ship-ship collision,
// keel-depth grounding, and server wave attitude (pitch/roll/heave).
import {
  PhysicsSystem,
  applyShipRudderSteering,
  computeSailPolar,
} from '../src/server/systems/PhysicsSystem.ts';
import { FLOODING, SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  angleWrap,
  gerstnerHeight,
  getIslandSurfaceY,
  sampleWind,
  WAVE_PARAMS,
} from '../src/shared/utils/index.ts';

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
    ...overrides,
  };
}

/** Minimal player whose atHelm flag marks the ship as helmed (skips the
 *  unhelmed angular decay); eliminated so updatePlayers ignores the body. */
function makeHelmMarker(shipId) {
  return {
    id: 'helm-marker',
    atHelm: true,
    onShipId: shipId,
    state: 'eliminated',
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('Sail polar (points of sail)');

{
  const irons = computeSailPolar(0.25);
  const ironsEdge = computeSailPolar(SHIP.SAIL_NO_GO_ANGLE - 0.01);
  const closeHauled = computeSailPolar(0.8);
  const reach = computeSailPolar(1.2);
  const beam = computeSailPolar(Math.PI / 2);
  const broad = computeSailPolar(1.92);
  const quarter = computeSailPolar(2.5);
  const run = computeSailPolar(Math.PI);

  expect('in-irons assist ≈ 0.10', Math.abs(irons - 0.10) < 1e-9, `irons=${irons}`);
  expect('whole no-go cone luffs equally', ironsEdge === irons);
  expect('in-irons < close-hauled', irons < closeHauled, `${irons} vs ${closeHauled}`);
  expect('close-hauled < beam', closeHauled < beam, `${closeHauled} vs ${beam}`);
  expect('polar rises monotonically to the broad-reach peak',
    irons < closeHauled && closeHauled < reach && reach < beam && beam < broad,
    `[${irons.toFixed(2)}, ${closeHauled.toFixed(2)}, ${reach.toFixed(2)}, ${beam.toFixed(2)}, ${broad.toFixed(2)}]`);
  expect('broad reach is the 1.0 peak', Math.abs(broad - 1) < 1e-9, `broad=${broad}`);
  expect('dead run eases to ~0.85 but stays fast',
    Math.abs(run - 0.85) < 1e-9 && run > quarter - 0.16 && run > closeHauled,
    `run=${run} quarter=${quarter}`);
  expect('dead run below the reach peak', run < broad);
}

// Integration: actual steady-state boat speed obeys the polar ordering, and
// the luffing flag reports in-irons canvas flutter.
function simulateSailing(offWind, seconds = 25) {
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sailHeight: 1 });
  let t = 0;
  for (let i = 0; i < seconds * 60; i++) {
    t += DT;
    const wind = sampleWind(t);
    ship.rotation = angleWrap(wind.direction + Math.PI - offWind);
    ship.angularVelocity = 0;
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    ship.sailAngle = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92; // perfect trim
    physics.update(DT, t, [ship], [], [], [], []);
  }
  return { speed: Math.hypot(ship.velocity.x, ship.velocity.z), ship };
}

{
  const irons = simulateSailing(0.3);
  const closeHauled = simulateSailing(0.85);
  const beam = simulateSailing(Math.PI / 2);
  expect('sim speeds: in-irons < close-hauled < beam',
    irons.speed < closeHauled.speed && closeHauled.speed < beam.speed,
    `${irons.speed.toFixed(2)} / ${closeHauled.speed.toFixed(2)} / ${beam.speed.toFixed(2)}`);
  expect('in-irons is a crawl (arcade-slow, not zero)',
    irons.speed < beam.speed * 0.25 && irons.speed > 0.2,
    `irons=${irons.speed.toFixed(2)} beam=${beam.speed.toFixed(2)}`);
  expect('in-irons sets ship.luffing for client sail flutter', irons.ship.luffing === true);
  expect('beam reach does not luff', beam.ship.luffing === false);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nRudder needs way on the ship');

function simulateHelm({ forcedSpeed }) {
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sailHeight: 0 });
  const helm = makeHelmMarker(ship.id);
  const startRotation = ship.rotation;
  for (let i = 0; i < 3 * 60; i++) {
    if (forcedSpeed > 0) {
      ship.velocity.x = Math.sin(ship.rotation) * forcedSpeed;
      ship.velocity.z = Math.cos(ship.rotation) * forcedSpeed;
    } else {
      ship.velocity.x = 0;
      ship.velocity.z = 0;
    }
    applyShipRudderSteering(ship, DT, 1, 1); // full helm-right
    physics.update(DT, i * DT, [ship], [helm], [], [], []);
  }
  return { turned: Math.abs(angleWrap(ship.rotation - startRotation)), ship };
}

{
  const atRest = simulateHelm({ forcedSpeed: 0 });
  const atSpeed = simulateHelm({ forcedSpeed: 12 });
  expect('stationary ship barely turns (3s of full rudder)', atRest.turned < 0.16, `turned=${atRest.turned.toFixed(3)} rad`);
  expect('ship with way on turns hard', atSpeed.turned > 1.0, `turned=${atSpeed.turned.toFixed(3)} rad`);
  expect('way multiplies turn authority ≥ 8×', atSpeed.turned > atRest.turned * 8,
    `rest=${atRest.turned.toFixed(3)} speed=${atSpeed.turned.toFixed(3)}`);
  expect('rudderAngle state is slewed and bounded',
    typeof atSpeed.ship.rudderAngle === 'number'
    && Math.abs(atSpeed.ship.rudderAngle) <= SHIP.RUDDER_MAX_ANGLE + 1e-9
    && Math.abs(atSpeed.ship.rudderAngle) > SHIP.RUDDER_MAX_ANGLE * 0.8,
    `rudderAngle=${atSpeed.ship.rudderAngle}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nShip-ship collision (oriented hulls)');

{
  // Parallel galleons rail-to-rail at 11m centers: boarding range, no phantom hit.
  const physics = new PhysicsSystem();
  const a = makeShip('galleon', { anchored: true });
  const b = makeShip('galleon', { anchored: true });
  b.position.x = 11;
  for (let i = 0; i < 60; i++) physics.update(DT, i * DT, [a, b], [], [], [], []);
  const gap = Math.abs(b.position.x - a.position.x);
  expect('parallel galleons at 11m centers do not collide', Math.abs(gap - 11) < 0.25, `gap=${gap.toFixed(2)}`);
  expect('rail-to-rail hulls stay undamaged', a.holes.length === 0 && b.holes.length === 0);
}

function runConvergence(setup) {
  const physics = new PhysicsSystem();
  const { a, b, driveA, driveB } = setup;
  let contact = null;
  for (let i = 0; i < 600 && !contact; i++) {
    driveA(a);
    driveB(b);
    physics.update(DT, i * DT, [a, b], [], [], [], []);
    const damaged = a.holes.length > 0 || b.holes.length > 0;
    if (damaged) {
      contact = {
        omegaA: a.angularVelocity,
        omegaB: b.angularVelocity,
        dist: Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z),
      };
    }
  }
  return contact;
}

{
  // Converging bows (slight lateral offset so the ram is off-center).
  const a = makeShip('sloop');
  a.position.z = -8;
  const b = makeShip('sloop', { rotation: Math.PI });
  b.position.x = 0.9;
  b.position.z = 8;
  const contact = runConvergence({
    a, b,
    driveA: (s) => { s.rotation = 0; s.velocity = { x: 0, y: s.velocity.y, z: 5.5 }; },
    driveB: (s) => { s.rotation = Math.PI; s.velocity = { x: 0, y: s.velocity.y, z: -5.5 }; },
  });
  expect('converging bows actually collide', contact !== null);
  if (contact) {
    // Ram breaches land at the CONTACT POINT resolved into each hull's own
    // frame — so a bow-to-bow ram must stove in timber forward on both, not
    // merely decrement a section counter named 'bow'.
    expect('both ships are stove in', a.holes.length > 0 && b.holes.length > 0,
      `a=${a.holes.length} b=${b.holes.length}`);
    const fwd = (ship) => ship.holes.every((h) => h.z > SHIP_STATS.sloop.length * 0.25);
    expect('every breach is forward on both hulls (the bows met, not the sides)',
      fwd(a) && fwd(b),
      `a=${JSON.stringify(a.holes.map(h => +h.z.toFixed(2)))} b=${JSON.stringify(b.holes.map(h => +h.z.toFixed(2)))}`);
    expect('ram breaches ride the waterline band',
      [...a.holes, ...b.holes].every((h) => h.y >= FLOODING.HOLE_BAND_Y.min && h.y <= FLOODING.HOLE_BAND_Y.max));
    expect('off-center ram torques both hulls',
      Math.abs(contact.omegaA) > 0.002 && Math.abs(contact.omegaB) > 0.002,
      `ωA=${contact.omegaA.toFixed(4)} ωB=${contact.omegaB.toFixed(4)}`);
    expect('hulls separated instead of interpenetrating', contact.dist > 8,
      `dist=${contact.dist.toFixed(2)}`);
  }
}

{
  // 90° T-bone: rammer bow into the victim's starboard side.
  const a = makeShip('sloop');
  a.position.z = -9;
  const b = makeShip('sloop', { rotation: Math.PI / 2, anchored: true });
  b.position.z = 4;
  const contact = runConvergence({
    a, b,
    driveA: (s) => { s.rotation = 0; s.velocity = { x: 0, y: s.velocity.y, z: 6 }; },
    driveB: () => {},
  });
  expect('T-bone collision resolves', contact !== null);
  if (contact) {
    expect('rammer is stove in forward',
      a.holes.length > 0 && a.holes.every((h) => h.z > SHIP_STATS.sloop.length * 0.25),
      JSON.stringify(a.holes.map(h => [+h.x.toFixed(2), +h.z.toFixed(2)])));
    expect('victim is stove in on the struck BEAM, far rail spared',
      b.holes.length > 0 && b.holes.every((h) => h.x > SHIP_STATS.sloop.width * 0.25),
      JSON.stringify(b.holes.map(h => [+h.x.toFixed(2), +h.z.toFixed(2)])));
    expect('T-boned victim loses more planking than the rammer',
      b.holes.length > a.holes.length, `victim=${b.holes.length} rammer=${a.holes.length}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nIsland grounding by keel depth');

function makeIsland(profileOverrides = {}) {
  return {
    id: 'island-test',
    name: 'Test Isle',
    position: { x: 0, y: 0, z: 0 },
    radius: 60,
    profile: {
      islandHeading: 0.4,
      footprintX: 1,
      footprintZ: 1,
      heightProfile: 0.4,
      beachSpread: 0.5,
      ridgeAxis: 0.8,
      ridgeBias: 0.12,
      mesaBias: 0.2,
      primaryHillAngle: 0.5,
      secondaryHillAngle: 2.4,
      tertiaryHillAngle: 4.2,
      primaryHillOffset: 0.3,
      secondaryHillOffset: 0.45,
      tertiaryHillOffset: 0.5,
      secondaryHillScale: 0.5,
      tertiaryHillScale: 0,
      peakBoost: 0,
      terrainStyle: 'tropical',
      seed: 1234,
      coastBias: -1, // all-beach shoreline: gentle underwater shelf
      inlets: [],
      ...profileOverrides,
    },
    dock: null,
    tavern: null,
    caves: [],
    chests: [],
    barrels: [],
    upgradeStations: [],
    npcs: [],
  };
}

{
  // Shallow beach approach: find a genuinely shallow spot on the +x beach.
  const island = makeIsland();
  const stats = SHIP_STATS.sloop;
  const keelY = -stats.height * SHIP.KEEL_DRAFT_RATIO;
  let shallowX = null;
  for (let x = 95; x >= 40; x -= 0.5) {
    if (getIslandSurfaceY(island, x, 0) > keelY + 0.2) { shallowX = x; break; }
  }
  expect('beach shelf rises above keel depth somewhere off the sand', shallowX !== null, `keelY=${keelY.toFixed(2)}`);
  if (shallowX !== null) {
    const physics = new PhysicsSystem();
    const ship = makeShip('sloop', { rotation: Math.atan2(-1, 0) }); // bow toward the island
    ship.position = { x: shallowX, y: 0, z: 0 };
    ship.velocity = { x: -6, y: 0, z: 0 };
    physics.pushShipOutOfIsland(ship, island);
    expect('grounding at speed scrapes the hull', ship.holes.length > 0,
      JSON.stringify(ship.holes));
    expect('the bow takes the beaching scrape, at the sample that touched bottom',
      ship.holes.every((h) => h.z > SHIP_STATS.sloop.length * 0.2),
      JSON.stringify(ship.holes.map(h => +h.z.toFixed(2))));
    expect('a grounding breach is near the KEEL, so it is always underwater',
      ship.holes.every((h) => h.y <= 0.13),
      JSON.stringify(ship.holes.map(h => +h.y.toFixed(3))));
    expect('ship is pushed back toward deep water', ship.position.x > shallowX && ship.velocity.x > 0,
      `x=${ship.position.x.toFixed(2)} (from ${shallowX}) vx=${ship.velocity.x.toFixed(2)}`);
  }
}

{
  // Deep inlet: the same hull sails straight in where the heightfield stays deep.
  const island = makeIsland({
    inlets: [{ angle: 0, width: 0.55, depth: 0.5 }],
  });
  const stats = SHIP_STATS.sloop;
  const keelY = -stats.height * SHIP.KEEL_DRAFT_RATIO;
  const hullSpan = stats.length * 0.5 + 0.8;
  let deepX = null;
  for (let x = 34; x <= 54; x += 0.5) {
    // Deep enough for the keel plus wave margin across the WHOLE hull span
    // (bow to stern), and well inside the island outline.
    let allDeep = true;
    for (let off = -hullSpan; off <= hullSpan; off += 1) {
      if (getIslandSurfaceY(island, x + off, 0) >= keelY - 0.6) { allDeep = false; break; }
    }
    if (allDeep) { deepX = x; break; }
  }
  expect('inlet carves keel-deep water inside the island outline', deepX !== null, `keelY=${keelY.toFixed(2)}`);
  if (deepX !== null) {
    const physics = new PhysicsSystem();
    const ship = makeShip('sloop', { rotation: Math.atan2(-1, 0) });
    ship.position = { x: deepX, y: 0, z: 0 };
    ship.velocity = { x: -6, y: 0, z: 0 };
    const beforeX = ship.position.x;
    physics.pushShipOutOfIsland(ship, island);
    expect('deep inlet approach passes without grounding',
      ship.holes.length === 0 && ship.position.x === beforeX && ship.velocity.x === -6,
      `x=${ship.position.x} vx=${ship.velocity.x} holes=${JSON.stringify(ship.holes)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\nServer wave attitude (pitch/roll/heave)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('brigantine', { sailHeight: 1 });
  ship.position = { x: -220, y: 0, z: 140 };
  applyShipRudderSteering(ship, DT, 0, 1); // touch the rudder so the field serializes
  let t = 0;
  let maxPitch = 0;
  let maxRoll = 0;
  let maxHeave = 0;
  let minPitch = Infinity;
  let maxPitchSeen = -Infinity;
  for (let i = 0; i < 20 * 60; i++) {
    t += DT;
    const wind = sampleWind(t);
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    ship.sailAngle = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
    physics.update(DT, t, [ship], [], [], [], []);
    maxPitch = Math.max(maxPitch, Math.abs(ship.pitch ?? 0));
    maxRoll = Math.max(maxRoll, Math.abs(ship.roll ?? 0));
    maxHeave = Math.max(maxHeave, Math.abs(ship.heave ?? 0));
    minPitch = Math.min(minPitch, ship.pitch ?? 0);
    maxPitchSeen = Math.max(maxPitchSeen, ship.pitch ?? 0);
  }
  expect('pitch stays inside the client clamp (±0.5)', maxPitch > 0 && maxPitch <= 0.5, `max|pitch|=${maxPitch.toFixed(3)}`);
  expect('roll stays inside the client clamp (±0.6)', maxRoll <= 0.6, `max|roll|=${maxRoll.toFixed(3)}`);
  expect('heave residual stays inside ±2m', maxHeave <= 2, `max|heave|=${maxHeave.toFixed(3)}`);
  expect('pitch responds to the wave field (not frozen)', maxPitchSeen - minPitch > 0.004,
    `range=${(maxPitchSeen - minPitch).toFixed(4)}`);
  const waveY = gerstnerHeight(ship.position.x, ship.position.z, t, WAVE_PARAMS);
  expect('hull vertical position tracks the Gerstner surface', Math.abs(ship.position.y - waveY) < 1.0,
    `y=${ship.position.y.toFixed(2)} wave=${waveY.toFixed(2)}`);

  const serialized = JSON.parse(JSON.stringify(ship));
  expect('pitch/roll/heave/rudderAngle/luffing serialize into snapshots',
    typeof serialized.pitch === 'number'
    && typeof serialized.roll === 'number'
    && typeof serialized.heave === 'number'
    && typeof serialized.rudderAngle === 'number'
    && typeof serialized.luffing === 'boolean');
}

{
  // A founder holds the attitude her water gave her (SINK-01 slice b re-pins
  // this: the server no longer eases pitch/roll out for the client sink tilt).
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { sinking: true, sinkProgress: 0.2 });
  // Below the design waterline, so she is genuinely making water whatever
  // the wave phase at t=0 happens to be.
  ship.holes = [{ id: 1, x: 2.4, y: -0.2, z: -3, patched: false, tier: 0 }];
  ship.nextHoleId = 2;
  ship.pitch = 0.3;
  ship.roll = -0.2;
  ship.heave = 1.2;
  // Match calls this the instant she founders, before the wreck is riddled.
  physics.beginFounder(ship, 0);
  for (let i = 0; i < 120; i++) physics.update(DT, i * DT, [ship], [], [], [], []);
  expect('a founder zeroes heave but keeps leaning on her holed rail',
    ship.roll < -0.02 && ship.heave === 0,
    `pitch=${ship.pitch.toFixed(3)} roll=${ship.roll.toFixed(3)} heave=${ship.heave}`);
  expect('and she is settling by the end she is holed in', ship.pitch < -0.01,
    `pitch=${ship.pitch.toFixed(3)}`);
}

{
  // physics-23: a sinking hull is NOT a collider, and it must not matter which
  // side of the array she sits on. On HEAD the wreck is skipped before its own
  // pass but is still a valid `other` for a live hull earlier in the array, so
  // the two orders diverge.
  const runPair = (mode) => {
    const physics = new PhysicsSystem();
    const live = makeShip('sloop', { sailHeight: 1 });
    live.position = { x: 0, y: 0, z: 0 };
    const wreck = makeShip('sloop', { sinking: true, sinkProgress: 0.1 });
    wreck.position = { x: 3.2, y: 0, z: 0 };
    const ships = mode === 'alone' ? [live] : (mode === 'wreckFirst' ? [wreck, live] : [live, wreck]);
    for (let i = 0; i < 90; i++) physics.update(DT, i * DT, ships, [], [], [], []);
    return { x: live.position.x, z: live.position.z, vx: live.velocity.x, vz: live.velocity.z };
  };
  const a = runPair('liveFirst');
  const b = runPair('wreckFirst');
  const alone = runPair('alone');
  expect('a live hull beside a wreck behaves IDENTICALLY in both array orders',
    Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9
      && Math.abs(a.vx - b.vx) < 1e-9 && Math.abs(a.vz - b.vz) < 1e-9,
    `liveFirst=${JSON.stringify(a)} wreckFirst=${JSON.stringify(b)}`);
  expect('...and she sails exactly as she would with the wreck not there at all',
    Math.abs(a.x - alone.x) < 1e-9 && Math.abs(b.x - alone.x) < 1e-9,
    `liveFirst=${a.x.toFixed(4)} wreckFirst=${b.x.toFixed(4)} alone=${alone.x.toFixed(4)}`);
}

{
  // A ball fired at a founder passes through her: a wreck stops absorbing shot.
  const physics = new PhysicsSystem();
  const wreck = makeShip('sloop', { sinking: true, sinkProgress: 0.1 });
  const proj = {
    id: 'ball-wreck', type: 'cannonball', ownerId: 'gunner', ownerShipId: 'other',
    position: { x: -4, y: 1.5, z: 0 }, velocity: { x: 400, y: 0, z: 0 },
    alive: true, age: 0, maxAge: 8, damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0, visualOnly: false, showImpact: false,
  };
  physics.update(DT, 0, [wreck], [], [proj], [], []);
  expect('a cannonball flies THROUGH a wreck instead of being eaten by her',
    proj.alive === true && proj.position.x > 2, `alive=${proj.alive} x=${proj.position.x.toFixed(2)}`);
  expect('and the wreck takes no fresh breaches from it', (wreck.holes ?? []).length === 0,
    JSON.stringify(wreck.holes));
}

if (failures > 0) {
  console.error(`\n${failures} ship-dynamics assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll ship-dynamics assertions passed.');
