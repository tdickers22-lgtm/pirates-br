#!/usr/bin/env node
/**
 * WHAT KILLED YOU, ANSWERED HONESTLY.
 *
 * The death screen used to read the world at the moment of death rather than
 * the blow that caused it: killer? no. outside the ring right now? no. in the
 * water right now? yes → "DROWNED — you went under in open water". So a shark
 * mauling you in the shallows, and a tempest that shredded you before you swam
 * back inside the ring, both got filed as drownings. Four observed eliminations,
 * four wrong titles.
 *
 * Match now TAGS the source as the damage lands (Match.ts: DamageSource, the
 * health witness around PhysicsSystem/StormSystem, and per-site tags for blade,
 * shot, keg and shark) and threads it out on BOTH exits — `game_over.cause` for
 * an elimination and `kill_event.cause` for a death you respawn from, which is
 * what lets the respawn blackout finally name what got you.
 *
 * Driven against a real Match on real ticks, like the other logic suites.
 */
import { Match } from '../src/server/core/Match.ts';
import { PLAYER, SHARK, SHIP } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY, isPointInsideIslandFootprint } from '../src/shared/utils/index.ts';

/** PhysicsSystem keeps its locomotion table module-private; this is the only
 *  number this suite needs from it (m/s of descent above which a landing on
 *  hard ground hurts — LOCO.FALL_SAFE_SPEED). */
const FALL_SAFE_SPEED = 15;

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
const match = new Match({ matchId: 'death-cause-test', botCount: 3 });
const state = match.state;

// Collect the kill feed instead of shouting it at absent sockets. `cause` rides
// this message for every death, respawnable or final.
const killEvents = [];
match.broadcast = (msg) => { if (msg?.type === 'kill_event') killEvents.push(msg.payload); };

// A big, centred ring so "inside the storm" is a stable, deliberate choice.
state.storm.centerX = 0;
state.storm.centerZ = 0;
state.storm.safeRadius = 900;
state.storm.damagePerSec = 6;

const [victim, other] = state.players;
const victimShip = state.ships.find((s) => s.id === victim.shipId);

/** Somewhere inside the ring with no island under it — real open water. */
function openWater() {
  for (let r = 0; r < 4000; r++) {
    const x = -700 + (r * 37) % 1400;
    const z = -700 + (r * 53) % 1400;
    if (Math.hypot(x, z) > 820) continue;
    if (state.islands.some((i) => isPointInsideIslandFootprint(i, x, z, 90))) continue;
    if (state.ships.some((s) => Math.hypot(s.position.x - x, s.position.z - z) < 90)) continue;
    return { x, z };
  }
  throw new Error('no open water found inside the ring');
}

/** Put the victim back on their feet, unhurt, un-tagged, inside the ring. */
function reset(position = { x: 0, y: 2, z: 0 }) {
  killEvents.length = 0;
  match.lastDamageSourceById.clear();
  victim.state = 'alive';
  victim.health = 100;
  victim.armor = 0;
  victim.position = { ...position };
  victim.velocity = { x: 0, y: 0, z: 0 };
  victim.swimTimer = 0;
  victim.onShipId = null;
  victim.respawnProtectionTimer = 0;
  victim.respawnTimer = 0;
  victim.lastDamagedById = null;
  victim.lastDamagedAt = null;
  victim.downedUntil = 0;
  state.sharks.length = 0;
  // Solo rules: nobody shares the victim's hull, so hp 0 is death, never DBNO.
  for (const p of state.players) if (p !== victim) p.shipId = p.shipId === victim.shipId ? p.id : p.shipId;
}

/** Kill them where they stand and read the cause off the wire. */
function causeOfDeathNow() {
  match.handlePlayerDeath(victim);
  return killEvents.at(-1)?.cause ?? null;
}

// ── THE WITNESS IS ACTUALLY WIRED INTO THE TICK ──────────────────────────────
// Everything above drives the subsystems the way tick() drives them. This drives
// tick() itself, so the begin/end pair really does bracket the storm call in the
// shipping loop and not just in this file.
console.log('Wired into the real tick:');
{
  reset({ x: 0, y: 2, z: 0 });
  // start() would arm a real setInterval; the suite drives the loop by hand, so
  // just put the match in the phase tick() actually runs in.
  state.phase = 'playing';
  victim.position = { x: state.storm.safeRadius + 200, y: 1.2, z: 0 };
  const before = victim.health;
  for (let i = 0; i < 240; i++) {
    victim.position.x = state.storm.centerX + state.storm.safeRadius + 200;
    victim.position.z = state.storm.centerZ;
    match.tick();
  }
  expect('a real tick outside the ring bills health', victim.health < before, `health=${victim.health}`);
  expect('…and the tick tags it as the storm', match.recentDamageSource(victim.id) === 'storm',
    `tag=${JSON.stringify(match.lastDamageSourceById.get(victim.id))}`);
}

// ── STORM ────────────────────────────────────────────────────────────────────
// The headline defect: shredded by the tempest, then killed while standing on
// dry land INSIDE the ring. Position says "not in the storm"; the damage log
// says the storm is the only thing that has touched you.
console.log('Storm:');
{
  reset({ x: 0, y: 2, z: 0 });
  // Outside the ring, taking real tempest damage on real ticks.
  victim.position = { x: state.storm.safeRadius + 120, y: 1.2, z: 0 };
  let stormTicks = 0;
  const startHealth = victim.health;
  while (victim.health > 40 && stormTicks < 60 * 60) {
    match.beginHealthWitness();
    match.storm.update(DT, state.storm, state.ships, state.players, {
      openHoleAt: () => {},
      isSheltered: () => false,
    });
    match.endHealthWitness(() => 'storm');
    stormTicks += 1;
  }
  expect('the tempest actually bills health outside the ring',
    victim.health < startHealth, `health=${victim.health}`);
  // Now walk back inside the ring and die there. The OLD reading calls this a
  // drowning or a plain elimination; the tag remembers the storm.
  victim.position = { x: 0, y: 1.2, z: 0 };
  victim.state = 'swimming';
  expect('a storm-mauled pirate who dies inside the ring is still a storm death',
    causeOfDeathNow() === 'storm', `cause=${killEvents.at(-1)?.cause}`);
}

// ── DROWNED ──────────────────────────────────────────────────────────────────
console.log('Drowning:');
{
  const spot = openWater();
  reset({ x: spot.x, y: 0.2, z: spot.z });
  victim.state = 'swimming';
  victim.swimTimer = PLAYER.DROWN_TIME + 1;
  const before = victim.health;
  for (let i = 0; i < 90; i++) {
    match.beginHealthWitness();
    match.physics.update(DT, match.t, state.ships, state.players, state.projectiles, state.islands, state.seaRocks, state.storm);
    match.endHealthWitness((p) => match.resolvePhysicsDamageSource(p));
  }
  expect('a pirate held under actually loses health', victim.health < before,
    `health=${victim.health} state=${victim.state} swimTimer=${victim.swimTimer}`);
  expect('drowning is named drowning', causeOfDeathNow() === 'drowned',
    `cause=${killEvents.at(-1)?.cause}`);
}

// ── FIRE ─────────────────────────────────────────────────────────────────────
console.log('Burning deck:');
{
  reset({ ...victimShip.position, y: victimShip.position.y + 3 });
  victimShip.onFire = true;
  victimShip.fireTimer = SHIP.FIRE_DURATION;
  const before = victim.health;
  for (let i = 0; i < 180; i++) {
    match.beginHealthWitness();
    match.physics.update(DT, match.t, state.ships, state.players, state.projectiles, state.islands, state.seaRocks, state.storm);
    match.endHealthWitness((p) => match.resolvePhysicsDamageSource(p));
  }
  expect('a burning deck burns the crew', victim.health < before,
    `health=${victim.health} onShip=${victim.onShipId}`);
  expect('burning is named burning', causeOfDeathNow() === 'fire', `cause=${killEvents.at(-1)?.cause}`);
  victimShip.onFire = false;
  victimShip.fireTimer = 0;
}

// ── FALL ─────────────────────────────────────────────────────────────────────
console.log('Falling:');
{
  const island = state.islands[0];
  const x = island.position.x;
  const z = island.position.z;
  const groundY = getIslandSurfaceY(island, x, z);
  reset({ x, y: groundY + 30, z });
  victim.velocity = { x: 0, y: -FALL_SAFE_SPEED * 2.5, z: 0 };
  const before = victim.health;
  for (let i = 0; i < 120; i++) {
    match.beginHealthWitness();
    match.physics.update(DT, match.t, state.ships, state.players, state.projectiles, state.islands, state.seaRocks, state.storm);
    match.endHealthWitness((p) => match.resolvePhysicsDamageSource(p));
  }
  expect('a long drop onto rock hurts', victim.health < before, `health=${victim.health}`);
  expect('a fall is named a fall', causeOfDeathNow() === 'fall', `cause=${killEvents.at(-1)?.cause}`);
}

// ── SHARK ────────────────────────────────────────────────────────────────────
console.log('Shark:');
{
  const spot = openWater();
  reset({ x: spot.x, y: 0.2, z: spot.z });
  victim.state = 'swimming';
  state.sharks.push({
    id: 'test-shark',
    position: { x: spot.x + SHARK.BITE_RANGE, y: 0.38, z: spot.z },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    health: SHARK.HEALTH,
    biteCooldown: 0,
    attackState: 'cruise',
    attackTimer: 0,
    lungeDirX: 0,
    lungeDirZ: 0,
    targetId: victim.id,
  });
  const before = victim.health;
  for (let i = 0; i < 60 * 8 && victim.health >= before; i++) {
    victim.state = 'swimming';
    victim.swimTimer = 0;
    match.updateSharks(DT);
  }
  expect('the shark actually bites', victim.health < before, `health=${victim.health}`);
  // A bite in the shallows used to die as "DROWNED" — swimming is the state,
  // but the shark is the cause.
  expect('a shark bite is named a shark', causeOfDeathNow() === 'shark',
    `cause=${killEvents.at(-1)?.cause}`);
}

// ── BLADE ────────────────────────────────────────────────────────────────────
console.log('Blade:');
{
  reset({ x: 0, y: 2, z: 0 });
  other.state = 'alive';
  other.health = 100;
  other.position = { x: 1.0, y: 2, z: 0 };
  other.activeSlot = other.weapons.findIndex((w) => w?.weaponId === 'cutlass');
  const before = victim.health;
  match.performMeleeAttack(other, Math.atan2(victim.position.x - other.position.x, victim.position.z - other.position.z));
  expect('the cutlass connects', victim.health < before, `health=${victim.health}`);
  const cause = causeOfDeathNow();
  expect('a cutlass kill names the blade', cause === 'blade', `cause=${cause}`);
  expect('the killer is still credited', killEvents.at(-1)?.killerId === other.id);
}

// ── EVERY CAUSE IS ONE THE CLIENT CAN PAINT ──────────────────────────────────
// HudController.DEATH_COPY is a Record over exactly this set; a cause the client
// has no copy for paints `undefined` into the title of the one screen a losing
// player reads.
console.log('Vocabulary:');
{
  const clientKnows = new Set([
    'ship_sunk', 'storm', 'drowned', 'shark', 'fall', 'fire',
    'cannon', 'gunshot', 'blade', 'explosion', 'killed', 'outlasted',
  ]);
  const seen = killEvents.length ? killEvents.map((e) => e.cause) : [];
  expect('every cause emitted in this run is one the death screen can paint',
    seen.every((c) => clientKnows.has(c)), `seen=${JSON.stringify(seen)}`);
}

// ── A NEW LIFE OWES NOTHING TO THE OLD ONE ───────────────────────────────────
console.log('Tag hygiene:');
{
  reset({ x: 0, y: 2, z: 0 });
  match.noteDamageSource(victim.id, 'shark');
  victim.state = 'respawning';
  victim.respawnTimer = 0;
  const home = state.ships.find((s) => s.id === victim.shipId);
  home.alive = true;
  home.sinking = false;
  home.position = { x: 0, y: 0, z: 0 };
  match.updateRespawns(DT);
  expect('respawning clears the last life\'s damage tag',
    match.recentDamageSource(victim.id) === null,
    `tag=${JSON.stringify(match.lastDamageSourceById.get(victim.id))}`);
}

if (failures > 0) {
  console.error(`\n${failures} death-cause assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll death-cause assertions passed.');
