#!/usr/bin/env node
/**
 * Kill-streak power regression.
 *
 * Mirrors the server threshold contract: player kills at 5/10/20 without dying
 * grant exactly one special each.
 */

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function awardPlayerKillStreak(killer) {
  killer.playerKillStreak += 1;
  if (killer.playerKillStreak === 5) {
    killer.superCannonballs += 1;
    return 'super_cannonball';
  }
  if (killer.playerKillStreak === 10) {
    killer.megaKegs += 1;
    return 'mega_keg';
  }
  if (killer.playerKillStreak === 20) {
    killer.tsunamiCharges += 1;
    return 'tsunami';
  }
  return null;
}

console.log('Kill-streak power thresholds');

const killer = {
  playerKillStreak: 0,
  superCannonballs: 0,
  megaKegs: 0,
  tsunamiCharges: 0,
};
const rewards = [];
for (let i = 0; i < 20; i++) {
  const reward = awardPlayerKillStreak(killer);
  if (reward) rewards.push({ kill: i + 1, reward });
}

expect('5 kills grants one super cannonball', killer.superCannonballs === 1);
expect('10 kills grants one mega keg', killer.megaKegs === 1);
expect('20 kills grants one tsunami', killer.tsunamiCharges === 1);
expect(
  'Rewards happen only at 5, 10, and 20',
  JSON.stringify(rewards) === JSON.stringify([
    { kill: 5, reward: 'super_cannonball' },
    { kill: 10, reward: 'mega_keg' },
    { kill: 20, reward: 'tsunami' },
  ]),
  JSON.stringify(rewards),
);

if (failures > 0) {
  console.error(`\n${failures} kill-streak assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll kill-streak assertions passed.');
