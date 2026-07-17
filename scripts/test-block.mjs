#!/usr/bin/env node
// Sword blocking, end-to-end against the real Match:
//   1. a guard FACING the swing turns an ordinary cutlass swipe completely
//   2. a turned back blocks nothing
//   3. the charged lunge is a guard-breaker (partial damage through a parry)
//   4. the same rules bind skeleton swings (they used to bypass the check)
//   5. a threatened skeleton raises its guard (blocking flag) and holds its swing
import { Match } from '../src/server/core/Match.ts';
import { WEAPONS, PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function makeDuel() {
  const match = new Match({ matchId: `block-${Math.random().toString(36).slice(2, 8)}`, botCount: 2 });
  match.state.phase = 'playing';
  const [attacker, target] = match.state.players;
  for (const p of [attacker, target]) {
    p.state = 'alive';
    p.health = 100;
    p.armor = 0;
    p.respawnProtectionTimer = 0;
    p.carryingChestId = null;
    p.onShipId = null;
    const slot = p.weapons.findIndex((w) => w && w.weaponId === 'cutlass');
    p.activeSlot = slot >= 0 ? slot : (p.weapons.push({ weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 }) - 1);
  }
  // Attacker south of target, swinging north (+z).
  attacker.position = { x: 0, y: 0, z: 0 };
  attacker.rotation.x = 0;
  target.position = { x: 0, y: 0, z: 1.6 };
  return { match, attacker, target };
}

// ── 1. Frontal block turns the swipe completely ──
{
  const { match, attacker, target } = makeDuel();
  target.blocking = true;
  target.rotation.x = Math.PI; // facing south, straight at the attacker
  match.performMeleeAttack(attacker, 0);
  expect('frontal block: zero damage through the guard', target.health === 100, `health=${target.health}`);
}

// ── 2. A turned back blocks nothing ──
{
  const { match, attacker, target } = makeDuel();
  target.blocking = true;
  target.rotation.x = 0; // facing away
  match.performMeleeAttack(attacker, 0);
  expect('back turned: full damage lands', target.health === 100 - WEAPONS.cutlass.damage,
    `health=${target.health}, expected ${100 - WEAPONS.cutlass.damage}`);
}

// ── 3. Not blocking at all: full damage ──
{
  const { match, attacker, target } = makeDuel();
  target.blocking = false;
  target.rotation.x = Math.PI;
  match.performMeleeAttack(attacker, 0);
  expect('no guard: full damage lands', target.health === 100 - WEAPONS.cutlass.damage, `health=${target.health}`);
}

// ── 4. Charged lunge breaks the guard partially ──
{
  const { match, attacker, target } = makeDuel();
  target.blocking = true;
  target.rotation.x = Math.PI;
  match.performMeleeAttack(attacker, 0, { damageMultiplier: 1, guardBreak: true });
  const dealt = 100 - target.health;
  expect('guard-break lunge: partial damage through the parry',
    dealt > 0 && dealt < WEAPONS.cutlass.damage,
    `dealt=${dealt} (raw swing=${WEAPONS.cutlass.damage})`);
}

// ── 5. Skeleton swings honor the guard + skeletons raise their own ──
{
  const { match, attacker, target } = makeDuel();
  // Recast the "attacker" bot as a skeleton via the same private maps the AI uses.
  const island = match.state.islands.find((i) => i.props?.length) ?? match.state.islands[0];
  match.skeletonHomes.set(attacker.id, island.id);
  attacker.isBot = true;
  attacker.shipId = null;
  attacker.position = { x: island.position.x, y: 3, z: island.position.z };
  target.isBot = false;
  target.state = 'alive';
  target.position = { x: island.position.x, y: 3, z: island.position.z + 1.5 };
  target.blocking = true;
  target.rotation.x = Math.PI; // facing the skeleton
  const before = target.health;
  match.updateIslandSkeletons(1 / 60);
  // Whatever the AI chose this tick (swing or guard), a blocked skeleton swing
  // must never land full damage.
  const dealt = before - target.health;
  expect('skeleton swing cannot land full damage through a facing guard',
    dealt === 0, `dealt=${dealt}`);

  // Skeleton guard reflex: threatened by a charging cutlass in range.
  target.cutlassCharge = 0.5;
  const reflex = ((attacker.id.charCodeAt(1) ?? 0) % 10) / 10;
  const weapon = attacker.weapons[attacker.activeSlot];
  weapon.reloading = false;
  match.updateIslandSkeletons(1 / 60);
  if (reflex < 0.7) {
    expect('threatened skeleton raises its guard', attacker.blocking === true, `blocking=${attacker.blocking} (reflex=${reflex})`);
  } else {
    expect('slow-reflex skeleton keeps swinging (by design)', attacker.blocking === false, `blocking=${attacker.blocking} (reflex=${reflex})`);
  }
}

console.log(failures === 0 ? '\nAll blocking assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
