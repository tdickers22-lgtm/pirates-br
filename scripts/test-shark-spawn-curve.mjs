#!/usr/bin/env node
// Shark spawns are a swim-time BUDGET, not a coin flip (SHARK-01 / bots-11).
// The old rule was a flat 3.4 %/s after an 8 s grace: mean first shark ~37 s
// into a swim, so a 10 s dash to the beach almost never met one and a bot wreck
// party 75 s in the water was the only population the feature ever hit — the
// threat read as random damage rather than a reason to get out of the water.
//
//   200 x 25 s open-water swims must produce a shark in >= 60 %
//   200 x 10 s swims must produce one in <= 5 %
// and blood in the water must call one immediately, budget or no budget.
import { Match } from '../src/server/core/Match.ts';
import { SHARK } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = 1 / 60;
const match = new Match({ matchId: 'shark-spawn-curve-test', botCount: 1 });
const state = match.state;
const swimmer = state.players[0];
for (const p of state.players) if (p !== swimmer) p.state = 'alive';

/** Open water, clear of every footprint by far more than OPEN_WATER_DIST. */
function findOpenSea() {
  for (let x = -800; x <= 800; x += 25) {
    for (let z = -800; z <= 800; z += 25) {
      let clear = true;
      for (const island of state.islands) {
        const spread = Math.max(island.profile?.footprintX ?? 1, island.profile?.footprintZ ?? 1);
        if (Math.hypot(x - island.position.x, z - island.position.z) < island.radius * spread + 120) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  throw new Error('no open-sea point found for test setup');
}
const sea = findOpenSea();

/** One swim of `seconds` in open water. Returns true if a shark showed up. */
function swim(seconds) {
  state.sharks.length = 0;
  match.fauna.sharkSpawnCooldown = 0;
  match.fauna.bloodCooldown = 0;
  match.fauna.lastSwimHealth?.clear();
  swimmer.state = 'swimming';
  swimmer.health = 100;
  swimmer.armor = 0;
  swimmer.onShipId = null;
  swimmer.swimTimer = 0;
  swimmer.position = { x: sea.x, y: 0.1, z: sea.z };
  for (let i = 0; i < Math.ceil(seconds / DT); i++) {
    swimmer.swimTimer += DT;
    swimmer.health = 100;   // the swim is graded, not the bite
    match.t += DT;
    match.updateSharks(DT);
    if (state.sharks.length > 0) return true;
  }
  return false;
}

const TRIALS = 200;
console.log(`1. ${TRIALS} x 25 s open-water swims`);
let long25 = 0;
for (let i = 0; i < TRIALS; i++) if (swim(25)) long25 += 1;
const rate25 = long25 / TRIALS;
console.log(`   ${long25}/${TRIALS} = ${(rate25 * 100).toFixed(1)} %`);
expect('a 25 s open-water swim meets a shark at least 60 % of the time',
  rate25 >= 0.6, `${(rate25 * 100).toFixed(1)} %`);

console.log(`\n2. ${TRIALS} x 10 s swims (a dash for the beach)`);
let short10 = 0;
for (let i = 0; i < TRIALS; i++) if (swim(10)) short10 += 1;
const rate10 = short10 / TRIALS;
console.log(`   ${short10}/${TRIALS} = ${(rate10 * 100).toFixed(1)} %`);
expect('a 10 s swim is safe at least 95 % of the time', rate10 <= 0.05, `${(rate10 * 100).toFixed(1)} %`);
expect('the two cases really are different (control)', rate25 - rate10 > 0.5,
  `25 s ${(rate25 * 100).toFixed(1)} % vs 10 s ${(rate10 * 100).toFixed(1)} %`);

console.log('\n3. Blood in the water calls one, budget or no budget');
{
  state.sharks.length = 0;
  match.fauna.sharkSpawnCooldown = 1e9;   // the budget is shut off entirely
  match.fauna.bloodCooldown = 0;
  match.fauna.lastSwimHealth?.clear();
  swimmer.state = 'swimming';
  swimmer.health = 100;
  swimmer.swimTimer = 0;                  // inside the grace: no budget shark
  swimmer.position = { x: sea.x, y: 0.1, z: sea.z };
  match.updateSharks(DT);
  expect('no shark from the budget with the cooldown held down', state.sharks.length === 0,
    `${state.sharks.length}`);
  swimmer.health = 62;                    // a broadside catches her in the water
  match.updateSharks(DT);
  expect('blood spawns a shark on the very next tick', state.sharks.length === 1,
    `${state.sharks.length}`);
  if (state.sharks.length) {
    const d = Math.hypot(state.sharks[0].position.x - sea.x, state.sharks[0].position.z - sea.z);
    expect('and it arrives inside BLOOD_SPAWN_DIST', d <= SHARK.BLOOD_SPAWN_DIST + 0.001, `d=${d.toFixed(1)} m`);
  }
  swimmer.health = 40;
  const before = state.sharks.length;
  match.updateSharks(DT);
  expect('a second wound inside the blood cooldown does NOT stack another',
    state.sharks.length === before, `${state.sharks.length}`);
}

if (failures > 0) {
  console.error(`\n${failures} shark spawn-curve assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll shark spawn-curve assertions passed.');
