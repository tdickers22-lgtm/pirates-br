#!/usr/bin/env node
// HULL-01 — cannonball-vs-hull PARITY: the server registers a ball exactly where
// the drawn planking is (the shared swim-hull skin), sweeps the tick segment so
// a 60 m/s ball cannot straddle the stem, and (slice b) tells a plunging deck
// hit from a hull breach. RED on the 6.6 m deck-walk slab this replaced:
// inboard points 0.45–1.58 m inside the wale missed, stem crossings passed clean.
import { PhysicsSystem, PROJECTILE_HULL_MARGIN } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP, SHIP_STATS, PLAYER } from '../src/shared/constants/index.ts';
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
    id, name: id, position: { ...position }, rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH ?? 100, maxHealth: PLAYER.MAX_HEALTH ?? 100, armor: 0, state: 'alive',
    shipId: null, onShipId: null, respawnProtectionTimer: 0, swimTimer: 0, knockback: { x: 0, y: 0, z: 0 },
    lastDamagedById: null, lastDamagedAt: null, lastDamageWasHeadshot: false, ...overrides,
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
if (failures > 0) {
  console.error(`\n${failures} projectile-hull parity assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll projectile-hull parity assertions passed.');
