#!/usr/bin/env node
// Regression tests for the server-correctness stage-B fixes. Imports the REAL
// server modules via tsx (see package.json test:logic).
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { WeaponSystem } from '../src/server/systems/WeaponSystem.ts';
import { SHIP, WEAPONS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. Keg plant → defuse → tick 12 s → no explosion ─────────
console.log('Keg defuse contract');
const match = new Match({ matchId: 'server-fixes-test', botCount: 2 });
const state = match.state;
const dt = 0.016;

function makeKeg(id) {
  return {
    id,
    shipId: null,
    position: { x: 640, y: 0.45, z: 640 },
    localPosition: null,
    section: 'bow',
    plantedById: 'nobody',
    timer: SHIP.KEG_FUSE_TIME,
  };
}

let explosions = 0;
match.explodeKeg = (keg) => { explosions += 1; keg.timer = 0; };
// Mirrors the per-tick keg pass in Match.tick(): update, then cleanup filter.
function tickKegs(seconds) {
  for (let i = 0; i < Math.ceil(seconds / dt); i += 1) {
    match.updateKegs(dt);
    state.kegs = state.kegs.filter((keg) => keg.timer > 0 && !keg.defused);
  }
}

const defusedKeg = makeKeg('keg-defused');
state.kegs.push(defusedKeg);
match.diffuseKeg(defusedKeg);
tickKegs(12);
expect('defused keg never detonates over 12 s of ticks', explosions === 0, `explosions=${explosions}`);
expect('defuse sets the defused flag', defusedKeg.defused === true);
expect('defused keg is cleaned up', !state.kegs.includes(defusedKeg));

const liveKeg = makeKeg('keg-live');
state.kegs.push(liveKeg);
tickKegs(12);
expect('undefused keg still detonates exactly once (control)', explosions === 1, `explosions=${explosions}`);
delete match.explodeKeg;
state.kegs.length = 0;

// ── 2. Hull-section attribution at rotations 0/90/180/270 ────
console.log('\nHull-section attribution for rotated ships');
const SECTIONS = ['bow', 'stern', 'port', 'starboard'];

function makeShip(rotation) {
  return {
    id: 'ship-test',
    type: 'sloop',
    ownerId: 'owner',
    crewIds: [],
    position: { x: 0, y: 0, z: 0 },
    rotation,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    sailHeight: 0,
    sailAngle: 0,
    anchored: true,
    anchorRaiseProgress: 0,
    hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
    maxHull: 600,
    onFire: false,
    fireTimer: 0,
    fireDamageAccum: 0,
    sinkProgress: 0,
    sinking: false,
    cannonCooldowns: [0, 0],
    chainshottedUntil: 0,
    sailIntegrity: 1,
    sailRepairWoodTimer: 0,
    gold: 0,
    treasureChestIds: [],
    inventory: [],
    repairCooldown: 0,
    autoRepairProgress: 0,
    teamColor: 0,
    alive: true,
    upgrades: [],
  };
}

function primarySectionHit(rotation, worldX, worldZ) {
  const physics = new PhysicsSystem();
  const ship = makeShip(rotation);
  physics.onProjectileHitShip({
    id: 'proj-section',
    type: 'cannonball',
    ownerId: 'attacker',
    ownerShipId: 'other-ship',
    position: { x: worldX, y: 1, z: worldZ },
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    age: 0,
    maxAge: 8,
    damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0,
    visualOnly: false,
    showImpact: true,
  }, ship, 0);
  return SECTIONS.reduce((worst, s) => (ship.hull[s] < ship.hull[worst] ? s : worst), 'bow');
}

for (const rotation of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
  const deg = Math.round(rotation * 180 / Math.PI);
  const fx = Math.sin(rotation);
  const fz = Math.cos(rotation); // bow direction in world space
  const sx = Math.cos(rotation);
  const sz = -Math.sin(rotation); // starboard direction in world space
  expect(`bow hit attributed at ${deg}°`, primarySectionHit(rotation, fx * 5, fz * 5) === 'bow');
  expect(`stern hit attributed at ${deg}°`, primarySectionHit(rotation, -fx * 5, -fz * 5) === 'stern');
  expect(`starboard hit attributed at ${deg}°`, primarySectionHit(rotation, sx * 2, sz * 2) === 'starboard');
  expect(`port hit attributed at ${deg}°`, primarySectionHit(rotation, -sx * 2, -sz * 2) === 'port');
}

// ── 3. Cannonball vs player damage ───────────────────────────
console.log('\nCannonball damage against players');
const physics = new PhysicsSystem();
const victim = {
  id: 'victim',
  health: 100,
  state: 'alive',
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  knockbackVelocity: { x: 0, y: 0, z: 0 },
  respawnProtectionTimer: 0,
  lastDamagedById: null,
  lastDamagedAt: null,
  lastDamageWasHeadshot: false,
};
const upgradeMult = 1.3; // charged_cannons
physics.onProjectileHitPlayer({
  id: 'proj-player',
  type: 'cannonball',
  ownerId: 'attacker',
  ownerShipId: 'other-ship',
  position: { x: 0, y: 1, z: 0 },
  velocity: { x: 40, y: 0, z: 0 },
  alive: true,
  age: 0,
  maxAge: 8,
  damage: SHIP.CANNON_DAMAGE_HULL * upgradeMult,
  knockback: 0,
  visualOnly: false,
  showImpact: true,
}, victim, 5);
const expected = SHIP.CANNON_DAMAGE_PLAYER * upgradeMult;
expect(
  'cannonball deals CANNON_DAMAGE_PLAYER × upgrade mult',
  approx(100 - victim.health, expected),
  `dealt=${100 - victim.health} expected=${expected}`,
);
expect('cannonball no longer one-shots a full-health player', victim.health > 0, `health=${victim.health}`);
const hitEvent = physics.flushCombatEvents().find((e) => e.type === 'player_hit');
expect('combat event reports the scaled damage', !!hitEvent && approx(hitEvent.damage, expected));
expect('lastDamagedAt records sim time', victim.lastDamagedAt === 5);

// ── 4. Reload consumes reserve / blocks at zero ──────────────
console.log('\nReload reserve consumption');
const weapons = new WeaponSystem();
const gunner = {
  state: 'alive',
  activeSlot: 0,
  weapons: weapons.createDefaultWeapons(),
  velocity: { x: 0, y: 0, z: 0 },
};
const gun = gunner.weapons[0];
const gunDef = WEAPONS[gun.weaponId];
gun.ammo = 0;
weapons.startReload(gunner);
expect('reload starts while reserve remains', gun.reloading === true);
weapons.update(gunDef.reloadTime + 0.05, [gunner]);
expect('reload refills the magazine', gun.ammo === gunDef.ammoMax && gun.reloading === false, `ammo=${gun.ammo}`);
expect('reload decrements reserve', gun.reserve === 4, `reserve=${gun.reserve}`);
gun.ammo = 0;
gun.reserve = 0;
weapons.startReload(gunner);
expect('reload blocked at 0 reserve', gun.reloading === false);
weapons.update(gunDef.reloadTime + 0.05, [gunner]);
expect('empty weapon stays empty without reserve', gun.ammo === 0 && gun.reserve === 0);

// ── 5. Input sanitizer ───────────────────────────────────────
console.log('\nInput sanitizer');
const baseInput = {
  seq: 1, ts: 0,
  forward: true, back: false, left: false, right: false,
  jump: false, jumpPressed: false, fire: false, aim: false,
  interact: false, interactHeld: false, anchor: false,
  sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
  trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
  slot: null, cannonAmmo: null, yaw: 1.25, pitch: 0.2,
  wheelIndex: null, useWheelItem: false, barrelTakeAll: false, interactIntent: null,
};
expect('NaN yaw dropped', match.sanitizeInput({ ...baseInput, yaw: NaN }) === null);
expect('Infinite pitch dropped', match.sanitizeInput({ ...baseInput, pitch: Infinity }) === null);
expect('non-numeric seq dropped', match.sanitizeInput({ ...baseInput, seq: 'x' }) === null);
expect('non-object payload dropped', match.sanitizeInput('garbage') === null);
const cleaned = match.sanitizeInput({
  ...baseInput,
  pitch: 9,
  slot: 7,
  wheelIndex: 2.5,
  cannonAmmo: 'nuke',
  interactIntent: 'give_me_gold',
});
expect('otherwise-valid input passes', cleaned !== null);
expect('pitch clamped to +PI/2', !!cleaned && approx(cleaned.pitch, Math.PI / 2), `pitch=${cleaned?.pitch}`);
expect('out-of-range slot nulled', !!cleaned && cleaned.slot === null);
expect('fractional wheelIndex nulled', !!cleaned && cleaned.wheelIndex === null);
expect('unknown cannon ammo nulled', !!cleaned && cleaned.cannonAmmo === null);
expect('unknown interact intent nulled', !!cleaned && cleaned.interactIntent === null);
const wrapped = match.sanitizeInput({ ...baseInput, yaw: Math.PI * 7.5 });
expect('yaw wrapped into ±PI', !!wrapped && wrapped.yaw >= -Math.PI && wrapped.yaw <= Math.PI, `yaw=${wrapped?.yaw}`);

// ── 6. Snapshot serverTime contract ──────────────────────────
console.log('\nSnapshot serverTime');
const snapshot = match.buildSnapshot(true);
expect('snapshot carries a finite serverTime', Number.isFinite(snapshot.serverTime));

if (failures > 0) {
  console.error(`\n${failures} server-fix assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll server-fix assertions passed.');
