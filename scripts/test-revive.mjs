#!/usr/bin/env node
// Down-but-not-out (DBNO) + revive: hp<=0 with a living crewmate downs instead
// of kills; teammates hold-revive within range; progress decays when released;
// bleed-out (storm-accelerated) credits the original downer; solo players die
// outright. Drives the real Match via tsx like the other logic suites.
import { Match } from '../src/server/core/Match.ts';
import { DBNO } from '../src/shared/constants/index.ts';

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
const match = new Match({ matchId: 'revive-test', botCount: 4 });
const state = match.state;

// Keep the storm ring huge and centered so "inside the safe zone" is stable.
state.storm.centerX = 0;
state.storm.centerZ = 0;
state.storm.safeRadius = 900;

const [victim, mate, enemy, loner] = state.players;
// victim + mate share a crew (same home ship); enemy and loner are outsiders.
mate.shipId = victim.shipId;
for (const p of [victim, mate, enemy, loner]) {
  p.state = 'alive';
  p.health = 100;
  p.position = { x: 10, y: 1, z: 10 };
}
mate.position = { x: 11, y: 1, z: 10 }; // within REVIVE_RANGE of the victim

console.log('DBNO enter:');
victim.health = 0;
victim.lastDamagedById = enemy.id;
victim.lastDamagedAt = match.t;
match.resolveHealthDeaths();
expect('lethal hit with a living crewmate downs instead of killing', victim.state === 'downed');
expect('downed vitality pool set', victim.health === DBNO.DOWNED_HEALTH, `health=${victim.health}`);
expect('bleed-out clock starts full', Math.abs(victim.downedUntil - DBNO.BLEEDOUT_SECONDS) < 1e-9);

console.log('Revive hold:');
const ticksToRevive = Math.ceil((DBNO.REVIVE_SECONDS + 0.2) / DT);
for (let i = 0; i < ticksToRevive && victim.state === 'downed'; i++) {
  match.reviveActionsThisTick.set(victim.id, mate.id);
  match.updateDownedAndRevives(DT);
}
expect('held revive brings the crewmate back', victim.state === 'alive');
expect('revived at the DBNO revive-ratio health', victim.health === Math.round(100 * DBNO.REVIVE_HEALTH_RATIO), `health=${victim.health}`);
expect('revive progress cleared', victim.reviveProgress === 0);

console.log('Progress decay:');
victim.health = 0;
victim.lastDamagedById = enemy.id;
victim.lastDamagedAt = match.t; // real damage always stamps the credit window
match.resolveHealthDeaths();
for (let i = 0; i < Math.ceil(1 / DT); i++) {
  match.reviveActionsThisTick.set(victim.id, mate.id);
  match.updateDownedAndRevives(DT);
}
const partial = victim.reviveProgress;
expect('partial hold builds progress', partial > 0.15 && partial < 0.5, `progress=${partial.toFixed(3)}`);
for (let i = 0; i < Math.ceil(2 / DT); i++) {
  match.updateDownedAndRevives(DT); // nobody holding
}
expect('released hold decays progress', victim.reviveProgress < partial, `progress=${victim.reviveProgress.toFixed(3)}`);

console.log('Bleed-out + credit:');
const enemyKillsBefore = enemy.kills ?? 0;
const clockInside = victim.downedUntil;
for (let i = 0; i < Math.ceil(1 / DT); i++) match.updateDownedAndRevives(DT);
const insideDrain = clockInside - victim.downedUntil;
victim.position = { x: state.storm.centerX + state.storm.safeRadius + 250, y: 1, z: 0 };
const clockOutside = victim.downedUntil;
for (let i = 0; i < Math.ceil(1 / DT); i++) match.updateDownedAndRevives(DT);
const outsideDrain = clockOutside - victim.downedUntil;
expect(
  'bleed-out drains faster outside the storm ring',
  outsideDrain > insideDrain * (DBNO.STORM_BLEEDOUT_MULT - 0.25),
  `inside=${insideDrain.toFixed(3)}s/s outside=${outsideDrain.toFixed(3)}s/s`,
);
// Run the clock out entirely.
for (let i = 0; i < Math.ceil(90 / DT) && victim.state === 'downed'; i++) {
  match.updateDownedAndRevives(DT);
}
expect('bleed-out ends in a real death', victim.state !== 'downed' && victim.state !== 'alive', `state=${victim.state}`);
expect('the original downer gets the kill credit', (enemy.kills ?? 0) === enemyKillsBefore + 1, `kills=${enemy.kills}`);

console.log('Solo death:');
loner.health = 0;
loner.lastDamagedById = enemy.id;
match.resolveHealthDeaths();
expect('no crewmate → lethal hit kills outright', loner.state !== 'downed' && loner.state !== 'alive', `state=${loner.state}`);

if (failures > 0) {
  console.error(`\n${failures} revive assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll DBNO/revive assertions passed.');
