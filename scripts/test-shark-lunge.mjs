#!/usr/bin/env node
// Telegraphed shark attack against the real Match tick loop (updateSharks):
//   1. a cruising shark closing on a swimmer enters WINDUP inside 1.9× bite
//      range with the lunge vector LOCKED to the target's position at that
//      instant (normalized, never re-aimed)
//   2. the windup brakes hard — the lunge is a dash from near-standstill
//   3. a stationary swimmer is caught by the lunge corridor: one bite of
//      BITE_DAMAGE, cooldown armed, shark drops into RECOVER
//   4. a swimmer who strafes 3m perpendicular during the 0.75s windup leaves
//      the locked corridor — no damage, the shark recovers and re-cruises
import { Match } from '../src/server/core/Match.ts';
import { SHARK } from '../src/shared/constants/index.ts';

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
const match = new Match({ matchId: 'shark-lunge-test', botCount: 1 });
const state = match.state;
const swimmer = state.players[0];

/** Open water: clear of every island footprint and sea rock by a wide margin
 *  so shore avoidance never perturbs the attack geometry under test. */
function findOpenSea() {
  for (let x = -850; x <= 850; x += 25) {
    for (let z = -850; z <= 850; z += 25) {
      let clear = true;
      for (const island of state.islands) {
        const spread = Math.max(island.profile?.footprintX ?? 1, island.profile?.footprintZ ?? 1);
        if (Math.hypot(x - island.position.x, z - island.position.z) < island.radius * spread + 90) { clear = false; break; }
      }
      if (!clear) continue;
      for (const rock of state.seaRocks) {
        if (Math.hypot(x - rock.position.x, z - rock.position.z) < (rock.colliderBoundsRadius ?? rock.radius) + 50) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  throw new Error('no open-sea point found for test setup');
}

const sea = findOpenSea();

function setupEncounter() {
  swimmer.state = 'swimming';
  swimmer.health = 100;
  swimmer.armor = 0;
  swimmer.swimTimer = 0;
  swimmer.position = { x: sea.x, y: 0.1, z: sea.z };
  const shark = {
    id: 'test-shark',
    position: { x: sea.x, y: 0.38, z: sea.z - 10 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    health: SHARK.HEALTH,
    biteCooldown: 0,
    attackState: 'cruise',
    attackTimer: 0,
    lungeDirX: 0,
    lungeDirZ: 0,
    targetId: swimmer.id,
  };
  state.sharks.length = 0;
  state.sharks.push(shark);
  match.sharkSpawnCooldown = 1e9; // no surprise extras mid-measurement
  return shark;
}

const sharkDist = (s) => Math.hypot(swimmer.position.x - s.position.x, swimmer.position.z - s.position.z);

/** Tick updateSharks until the shark reaches `stateName` (or ticks run out). */
function tickUntil(shark, stateName, maxTicks) {
  for (let i = 0; i < maxTicks; i++) {
    if (shark.attackState === stateName) return true;
    match.updateSharks(DT);
  }
  return shark.attackState === stateName;
}

// ────────────────────────────────────────────────────────────────────────────
console.log('1. Cruise → windup: in range, vector locked at windup start');

{
  const shark = setupEncounter();
  expect('shark reaches windup while chasing', tickUntil(shark, 'windup', 600), `state=${shark.attackState}`);
  const d = sharkDist(shark);
  expect('windup starts inside 1.9× bite range', d <= SHARK.BITE_RANGE * 1.9 + 0.2, `d=${d.toFixed(2)}`);
  const len = Math.hypot(shark.lungeDirX, shark.lungeDirZ);
  expect('locked lunge vector is normalized', Math.abs(len - 1) < 1e-6, `len=${len}`);
  const toTargetX = (swimmer.position.x - shark.position.x) / d;
  const toTargetZ = (swimmer.position.z - shark.position.z) / d;
  const dot = shark.lungeDirX * toTargetX + shark.lungeDirZ * toTargetZ;
  expect('locked vector points at the target', dot > 0.995, `dot=${dot.toFixed(4)}`);
  expect('windup timer armed', Math.abs(shark.attackTimer - SHARK.WINDUP_TIME) < DT, `timer=${shark.attackTimer}`);

  const lockedX = shark.lungeDirX;
  const lockedZ = shark.lungeDirZ;
  expect('windup → lunge on timer', tickUntil(shark, 'lunge', 120), `state=${shark.attackState}`);
  // At lunge entry the velocity is still the braked windup drift — the dash
  // speed is applied on the first lunge tick.
  const speedAfterBrake = Math.hypot(shark.velocity.x, shark.velocity.z);
  expect('windup braked the chase to a near-standstill', speedAfterBrake < 1.0,
    `speed=${speedAfterBrake.toFixed(3)}`);
  expect('lock never re-aimed during windup',
    shark.lungeDirX === lockedX && shark.lungeDirZ === lockedZ);
  match.updateSharks(DT);
  if (shark.attackState === 'lunge') {
    const dashSpeed = Math.hypot(shark.velocity.x, shark.velocity.z);
    expect('lunge dashes at LUNGE_SPEED down the locked vector',
      Math.abs(dashSpeed - SHARK.LUNGE_SPEED) < 1e-6, `speed=${dashSpeed.toFixed(2)}`);
  }

  // 2. Stationary swimmer: the dash connects.
  console.log('\n2. Stationary swimmer gets bitten by the lunge');
  let ticks = 0;
  while (shark.attackState === 'lunge' && ticks++ < 120) match.updateSharks(DT);
  expect('one bite of BITE_DAMAGE landed', swimmer.health === 100 - SHARK.BITE_DAMAGE, `health=${swimmer.health}`);
  expect('bite arms the cooldown', shark.biteCooldown > SHARK.BITE_COOLDOWN - 0.5, `cd=${shark.biteCooldown.toFixed(2)}`);
  expect('shark drops into recover after the hit', shark.attackState === 'recover', `state=${shark.attackState}`);
  expect('recover ends back in cruise', tickUntil(shark, 'cruise', Math.ceil((SHARK.RECOVER_TIME + 0.5) / DT)),
    `state=${shark.attackState}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Perpendicular strafe during the windup dodges the lunge');

{
  const shark = setupEncounter();
  expect('fresh shark reaches windup', tickUntil(shark, 'windup', 600), `state=${shark.attackState}`);
  // Step 3m perpendicular to the LOCKED vector — the classic dodge.
  swimmer.position.x += -shark.lungeDirZ * 3;
  swimmer.position.z += shark.lungeDirX * 3;

  // Judge exactly ONE attack cycle — after recovering, a fair shark is free
  // to wind up again at the swimmer's NEW position (and hit if they stand
  // still), so the no-damage claim only covers the dodged lunge itself.
  let sawLunge = false;
  const cycleTicks = Math.ceil((SHARK.WINDUP_TIME + SHARK.LUNGE_TIME + 0.5) / DT);
  for (let i = 0; i < cycleTicks && shark.attackState !== 'recover'; i++) {
    match.updateSharks(DT);
    if (shark.attackState === 'lunge') sawLunge = true;
  }
  expect('the lunge fired down the stale corridor', sawLunge);
  expect('displaced swimmer takes NO damage from the dodged lunge',
    swimmer.health === 100, `health=${swimmer.health}`);
  expect('missed lunge ends in recover', shark.attackState === 'recover', `state=${shark.attackState}`);
  expect('a miss leaves the bite off cooldown (only a HIT arms it)',
    shark.biteCooldown === 0, `cd=${shark.biteCooldown}`);
  // Recover runs its timer down and the shark resumes hunting (same-tick
  // re-windup is legal once back in range, so accept either).
  for (let i = 0; i < Math.ceil((SHARK.RECOVER_TIME + 0.2) / DT); i++) match.updateSharks(DT);
  expect('recover expires back into the hunt',
    shark.attackState === 'cruise' || shark.attackState === 'windup', `state=${shark.attackState}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. The swimmer boards: the shark loses interest and LEAVES');

{
  setupEncounter();
  // She is out of the water and on a deck. Nothing is left to hunt.
  swimmer.state = 'alive';
  swimmer.swimTimer = 0;
  let goneAt = null;
  for (let i = 0; i < Math.ceil(60 / DT); i++) {
    match.updateSharks(DT);
    if (state.sharks.length === 0) { goneAt = i * DT; break; }
  }
  expect('sharks.length === 0 within 60 s of the swimmer boarding',
    state.sharks.length === 0, `${state.sharks.length} shark(s) still parked after 60 s`);
  expect('and it took the idle clock to do it, not one tick',
    goneAt !== null && goneAt > 5, `gone at ${goneAt === null ? 'never' : goneAt.toFixed(1)} s`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Two sharks on one swimmer stay two sharks');

{
  setupEncounter();
  // Both released from almost the same point: the old chase drove them onto
  // identical coordinates (one fin, two bites on the same tick).
  const a = state.sharks[0];
  a.id = 'shark-a';
  const b = { ...a, id: 'shark-b', position: { x: a.position.x + 0.4, y: a.position.y, z: a.position.z + 0.2 }, velocity: { x: 0, y: 0, z: 0 } };
  state.sharks.push(b);
  let closest = Infinity;
  for (let i = 0; i < Math.ceil(5 / DT); i++) {
    match.updateSharks(DT);
    if (state.sharks.length < 2) break;
    closest = Math.min(closest, Math.hypot(
      state.sharks[0].position.x - state.sharks[1].position.x,
      state.sharks[0].position.z - state.sharks[1].position.z,
    ));
  }
  expect('both sharks are still in the water', state.sharks.length === 2, `${state.sharks.length}`);
  expect('min pairwise distance over 5 s > 2.5 m', closest > 2.5, `closest=${closest.toFixed(3)} m`);
}

if (failures > 0) {
  console.error(`\n${failures} shark-lunge assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll shark telegraphed-attack assertions passed.');
