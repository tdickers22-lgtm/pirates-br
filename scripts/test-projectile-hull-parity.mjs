#!/usr/bin/env node
// HULL-01 — cannonball-vs-hull PARITY: the server registers a ball exactly where
// the drawn planking is (the shared swim-hull skin), sweeps the tick segment so
// a 60 m/s ball cannot straddle the stem, and (slice b) tells a plunging deck
// hit from a hull breach. RED on the 6.6 m deck-walk slab this replaced:
// inboard points 0.45–1.58 m inside the wale missed, stem crossings passed clean.
import { PhysicsSystem, PROJECTILE_HULL_MARGIN, shipIngressRate } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP, SHIP_STATS, PLAYER, PHYSICS } from '../src/shared/constants/index.ts';
import { getSwimHullHalfWidth, getSwimHullVerticalT } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const DT = 1 / 60;

function makeShip(type, overrides = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: `ship-${type}`, type, ownerId: 'owner', crewIds: [],
    position: { x: 0, y: 0, z: 0 }, rotation: 0, velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0,
    sailHeight: 0, sailAngle: 0, anchored: true, anchorRaiseProgress: 0,
    holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0, fireDamageAccum: 0,
    sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0), chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [], repairCooldown: 0,
    autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], pitch: 0, roll: 0, heave: 0, waterLevel: 0,
    ...overrides,
  };
}
let seq = 0;
function makeBall(position, velocity, overrides = {}) {
  return {
    id: `ball-${++seq}`, type: 'cannonball', ownerId: 'gunner', ownerShipId: 'attacker',
    position: { ...position }, velocity: { ...velocity }, alive: true, age: 0, maxAge: 8,
    damage: SHIP.CANNON_DAMAGE_HULL, knockback: 0, visualOnly: false, showImpact: false, ...overrides,
  };
}
function makePlayer(id, position, overrides = {}) {
  return {
    id, name: id, shipId: null,
    position: { ...position }, rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 100, state: "alive", weapons: [null, null, null, null], activeSlot: 0,
    reloading: false, reloadTimer: 0, knockbackVelocity: { x: 0, y: 0, z: 0 }, isBot: false,
    kills: 0, playerKillStreak: 0, superCannonballs: 0, megaKegs: 0, tsunamiCharges: 0, gold: 0,
    carryingChestId: null, treasureMapIslandId: null, questMaps: [], swimTimer: 0,
    atCannon: false, atHelm: false, atCrowNest: false, blocking: false, bailing: false,
    cutlassCharge: 0, cannonIndex: 0, nearChestId: null, nearShipId: null, onShipId: null,
    respawnTimer: 0, respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0, lastDamagedById: null,
    lastDamagedAt: null, lastDamageWasHeadshot: false, selectedCannonAmmo: "ball", kegs: 0,
    kegCooldown: 0, cannonFlightTimer: 0, cannonBallistic: false, pocketBanana: 0, pocketWood: 0,
    pocketCoconut: 0, pocketMango: 0, pocketMeat: 0, pocketMeatByType: {}, pocketOre: 0,
    mastClimb: null, crouching: false, armor: 0, pocketUseCooldown: 0, hasShovel: false,
    hasSpyglass: false, equippedTool: null, bailScoopProgress: 0, hullRepairProgress: 0,
    bucketFilled: false, nearBarrelId: null, downedUntil: 0, reviveProgress: 0,
    ...overrides,
  };
}
/** Rotate a ship-local point into the world for a ship at `rotation`. */
function toWorld(ship, local) {
  const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
  return { x: ship.position.x + local.x * c + local.z * s, y: ship.position.y + local.y, z: ship.position.z + local.z * c - local.x * s };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('1. Hull skin parity: 200 wale points per class, 0.1 m outboard misses, 0.1 m inboard hits');
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const stats = SHIP_STATS[type];
  // A heading that is not a multiple of 90° so the local frame is exercised.
  const ship = makeShip(type, { rotation: 0.7, position: { x: 120, y: 0, z: -40 } });
  let inboardMiss = 0, outboardHit = 0, worst = 0;
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    // Even samples at the waterline band, odd ones half way down to the keel.
    const yLocal = i % 2 === 0 ? 0.25 : -stats.height * SHIP.HULL_DRAFT_F[type] * 0.5;
    const zf = -0.5 + (i / (N - 1)) * 1.0;            // stern → stem
    const side = i % 4 < 2 ? 1 : -1;
    const z = zf * stats.length;
    const verticalT = getSwimHullVerticalT(ship.position.y + yLocal, ship.position.y, stats, type);
    const half = getSwimHullHalfWidth(stats, z, PROJECTILE_HULL_MARGIN, verticalT);
    for (const [offset, kind] of [[0.1, 'outboard'], [-0.1, 'inboard']]) {
      const physics = new PhysicsSystem();
      const local = { x: side * (half + offset), y: yLocal, z };
      const ball = makeBall(toWorld(ship, local), { x: 0, y: 0, z: 0 });
      physics.update(DT, 1, [ship], [], [ball], [], [], null);
      // A breach entity is the witness: a ball dying in the WATER is not a hit.
      const hit = ship.holes.length > 0;
      if (kind === 'inboard' && !hit) { inboardMiss += 1; worst = Math.max(worst, half); }
      if (kind === 'outboard' && hit) outboardHit += 1;
      ship.holes = []; ship.repairCooldown = 0;
    }
  }
  expect(`${type}: every point 0.1 m INSIDE the wale registers (misses=${inboardMiss}/${N})`, inboardMiss === 0,
    `widest skin half-width that still missed: ${worst.toFixed(2)} m`);
  expect(`${type}: every point 0.1 m OUTSIDE the wale is clear water (false hits=${outboardHit}/${N})`, outboardHit === 0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. Swept stem: 100 tangential crossings at 60 m/s just inside the stem all register');
{
  const stats = SHIP_STATS.sloop;
  const ship = makeShip('sloop', { rotation: -1.1, position: { x: -30, y: 0, z: 55 } });
  let registered = 0;
  const N = 100;
  for (let i = 0; i < N; i += 1) {
    const physics = new PhysicsSystem();
    // Across the bow, 0.515 L forward of amidships (inside the 0.52 L stem
    // post, outside the old 0.48 L + 0.38 m deck limit), waterline height,
    // phase-shifted so the 1 m/tick samples land at every offset.
    const z = stats.length * 0.515;
    const startX = 4 + (i / N) * (SHIP.CANNON_SPEED * DT);
    const local = { x: startX, y: 0.3, z };
    const world = toWorld(ship, local);
    const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
    // Local −x direction rotated into the world.
    const vel = { x: -SHIP.CANNON_SPEED * c, y: 0, z: SHIP.CANNON_SPEED * s };
    const ball = makeBall(world, vel);
    for (let tick = 0; tick < 12 && ball.alive; tick += 1) {
      physics.update(DT, 1 + tick * DT, [ship], [], [ball], [], [], null);
      ball.velocity.y = 0; // hold the waterline line: this case is about the stem, not the arc
    }
    if (ship.holes.length > 0) registered += 1;
    ship.holes = []; ship.repairCooldown = 0;
  }
  expect(`all ${N} stem crossings register (got ${registered})`, registered === N);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Deck crossings meet the CREW, not invisible hull: a ball at deck+0.6 over midships hits the pirate standing there');
{
  const physics = new PhysicsSystem();
  const stats = SHIP_STATS.sloop;
  const ship = makeShip('sloop', { rotation: 0.4 });
  const deckY = ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET;
  const pirate = makePlayer('deckhand', toWorld(ship, { x: 0, y: stats.height + SHIP.DECK_STAND_OFFSET, z: 1 }), { shipId: ship.id, onShipId: ship.id });
  // Flat shot at chest height, crossing the deck from starboard to port.
  const c = Math.cos(ship.rotation), sn = Math.sin(ship.rotation);
  const ball = makeBall(toWorld(ship, { x: 2.0, y: stats.height + SHIP.DECK_STAND_OFFSET + 0.6, z: 1 }), { x: -40 * c, y: 0, z: 40 * sn });
  for (let tick = 0; tick < 8 && ball.alive; tick += 1) physics.update(DT, 1 + tick * DT, [ship], [pirate], [ball], [], [], null);
  expect('the ball is spent', ball.alive === false);
  expect('the deckhand took the ball', pirate.health < 100, `health=${pirate.health}`);
  expect('...and it opened NO hole (the deck is not planking)', ship.holes.length === 0, `holes=${ship.holes.length}`);
  expect('the deckhand is credited to the gunner', pirate.lastDamagedById === 'gunner');
  void deckY;
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. A plunging ball from 40 m lands on the DECK: no hole, impact=deck, crew within 1.5 m splintered, bilge stays dry');
{
  const physics = new PhysicsSystem();
  const stats = SHIP_STATS.sloop;
  const ship = makeShip('sloop', { position: { x: 0, y: 0, z: 0 } });
  // 1 m off the ball's line (outside the 0.8 m capsule, inside the 1.5 m splash).
  const near = makePlayer('near', { x: 0, y: stats.height + SHIP.DECK_STAND_OFFSET, z: 1.0 }, { shipId: ship.id, onShipId: ship.id });
  const far = makePlayer('far', { x: -1.2, y: stats.height + SHIP.DECK_STAND_OFFSET, z: -4.0 }, { shipId: ship.id, onShipId: ship.id });
  // Let the hull settle on the swell first so the aim solves against her real
  // freeboard, then lob from 40 m abeam so the ball drops steeply onto the
  // deck centre (a bot solves its arc to the target height the same way).
  for (let tick = 0; tick < 120; tick += 1) physics.update(DT, tick * DT, [ship], [near, far], [], [], [], null);
  const target = { x: 0, y: ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET + 0.15, z: 0 };
  const start = { x: 40, y: ship.position.y + 1.5, z: 0 };
  const g = PHYSICS.GRAVITY * SHIP.CANNON_GRAVITY_MULT;
  const flight = 40 / 22; // slow lob so it comes down steeply
  const vel = { x: -40 / flight, y: (target.y - start.y) / flight - 0.5 * g * flight, z: 0 };
  const ball = makeBall(start, vel);
  let events = [];
  for (let tick = 0; tick < 240 && ball.alive; tick += 1) {
    physics.update(DT, 2 + tick * DT, [ship], [near, far], [ball], [], [], null);
    events = events.concat(physics.flushCombatEvents());
  }
  const shipHit = events.find((e) => e.type === 'ship_hit');
  expect('the arc struck the ship', shipHit !== undefined && ball.alive === false, `events=${events.map((e) => e.type).join(',')}`);
  expect('classified as a DECK impact', shipHit?.impact === 'deck', `impact=${shipHit?.impact} y=${(ball.position.y - ship.position.y).toFixed(2)}`);
  expect('no hole entity opened (the old slab clamped this to a dry 1.32 m "leak")', ship.holes.length === 0,
    `holes=${ship.holes.map((h) => h.y.toFixed(2)).join(',')}`);
  expect('the crewman within 1.5 m took splinters', near.health < 100, `health=${near.health}`);
  expect('the crewman 4.5 m away did not', far.health === 100, `health=${far.health}`);
  for (let tick = 0; tick < 60 * 60; tick += 1) physics.update(DT, 5 + tick * DT, [ship], [], [], [], [], null);
  expect('waterLevel stays flat for 60 s', (ship.waterLevel ?? 0) === 0, `water=${ship.waterLevel}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Topside hits keep their real height; the drawn face follows the ball, not the sign of a centreline x');
{
  const physics = new PhysicsSystem();
  const stats = SHIP_STATS.brigantine;
  const ship = makeShip('brigantine', { rotation: 2.3, position: { x: 10, y: 0, z: 10 } });
  const c = Math.cos(ship.rotation), sn = Math.sin(ship.rotation);
  // Flat shot into the sheer strake at 0.85 H, from starboard.
  const ball = makeBall(toWorld(ship, { x: 6, y: stats.height * 0.85, z: -2 }), { x: -50 * c, y: 0, z: 50 * sn });
  for (let tick = 0; tick < 6 && ball.alive; tick += 1) physics.update(DT, 1 + tick * DT, [ship], [], [ball], [], [], null);
  const hole = ship.holes[0];
  expect('a sheer-strake hit opens a TOPSIDE hole at its real height (not clamped to 0.6 H)',
    hole !== undefined && hole.y > stats.height * 0.8 && hole.y <= stats.height * 0.95, `y=${hole?.y?.toFixed(2)} 0.6H=${(stats.height * 0.6).toFixed(2)}`);
  const ev = physics.flushCombatEvents().find((e) => e.type === 'ship_hit');
  expect('...and the event says so', ev?.impact === 'topside', `impact=${ev?.impact}`);
  expect('a topside hole is dry in calm water', shipIngressRate(ship, 1) === 0, `ingress=${shipIngressRate(ship, 1)}`);
  expect('...on the starboard face the ball came from', hole !== undefined && hole.x > 0, `x=${hole?.x?.toFixed(2)}`);

  // Raking shot down the centreline from dead ahead: the stem post is the
  // entry, x ≈ 0; the face sign must come from the heading, not from noise.
  const ship2 = makeShip('brigantine', { rotation: -0.9, position: { x: -5, y: 0, z: 20 } });
  const c2 = Math.cos(ship2.rotation), s2 = Math.sin(ship2.rotation);
  const rake = makeBall(toWorld(ship2, { x: 0.02, y: 0.3, z: 12 }), { x: -50 * s2, y: 0, z: -50 * c2 });
  for (let tick = 0; tick < 8 && rake.alive; tick += 1) physics.update(DT, 1 + tick * DT, [ship2], [], [rake], [], [], null);
  const stem = ship2.holes[0];
  expect('a bow rake registers on the stem (z ≥ 0.5 L)', stem !== undefined && stem.z >= stats.length * 0.5, `z=${stem?.z?.toFixed(2)} L/2=${stats.length / 2}`);
  expect('...as a flooding band breach', stem !== undefined && stem.y <= stats.height * 0.6 && stem.y >= 0.2, `y=${stem?.y?.toFixed(2)}`);
}

// ────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} projectile-hull parity assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll projectile-hull parity assertions passed.');
