#!/usr/bin/env node
// A BOT MAY ONLY HUNT WHAT SHE CAN FIND (BOTFUN-01 / bots-08).
//
// The old target scan read every hull in the match and handed a human's hull a
// flat 0.88 discount for being human. Two things followed and players felt both:
// running did not break contact (the late-phase seek radius is 900 m x 1.2), and
// weather did not either — a squall that hides a galleon from a PLAYER hid
// nothing from a bot.
//
// This grades the perception model directly, through BotCrew.decideBehavior:
//   1. Late arc, spray and dark, a hull at 700 m: not engaged.
//   2. The same hull at 150 m in the same weather: engaged (the gate can fail
//      the other way, so it is not a "bots never fight" tautology).
//   3. A contact lost in the murk stays hunted for BOT_CONTACT_MEMORY, then is
//      forgotten — bots do not blink out of a fight the moment sight breaks.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';

import { Match } from '../src/server/core/Match.ts';
import { BOT_TIERS, botSightRange, BOT_CONTACT_MEMORY } from '../src/server/systems/bots/personalities.ts';
import { BOT_EARLY_PEACE_SECONDS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const LATE_PHASE = 5;
const sight = botSightRange(BOT_TIERS.medium.perceptionRange, LATE_PHASE);
console.log(`A medium crew sees ${sight.toFixed(0)} m in phase-${LATE_PHASE} weather (clear-water ${BOT_TIERS.medium.perceptionRange} m)`);

/** Park hull B at `range` metres abeam of hull A and ask A's brain what it wants. */
function decideAt(range, { forget = 0 } = {}) {
  const match = new Match({ matchId: `perception-${range}-${forget}`, botCount: 2 });
  const state = match.state;
  state.phase = 'playing';
  const [a, b] = state.ships;
  const crew = match.bots.getCrew(a.id);
  const t = BOT_EARLY_PEACE_SECONDS + 120; // past the opening truce: free to hunt
  state.storm.phase = LATE_PHASE;
  state.storm.shrinking = false;
  // Both hulls sit on the ring centre line so the storm branch never fires.
  a.position.x = state.storm.centerX; a.position.z = state.storm.centerZ;
  b.position.x = state.storm.centerX + range; b.position.z = state.storm.centerZ;
  a.anchored = false; b.anchored = false;
  crew.stateTimer = 0;
  crew.behavior = 'patrol';
  crew.targetShipId = null;
  match.bots.crewBrain.decideBehavior(crew, a, state.ships, state.islands, state.storm, state.players, t);
  if (forget > 0) {
    // Same crew, later: she has had the contact and then lost it in the murk.
    b.position.x = state.storm.centerX + 4000;
    crew.stateTimer = 0;
    match.bots.crewBrain.decideBehavior(crew, a, state.ships, state.islands, state.storm, state.players, t + forget);
  }
  return { crew, hunted: crew.behavior === 'engage' && crew.targetShipId === b.id, t };
}

console.log('\nOut of sight in the spray');
const far = decideAt(700);
expect('a hull 700 m off in the late-arc murk is not hunted', !far.hunted,
  `behavior=${far.crew.behavior} target=${far.crew.targetShipId ? 'set' : 'null'} intent=${far.crew.intent}`);

console.log('\nUnder her guns');
const near = decideAt(150);
expect('the same hull at 150 m in the same weather IS hunted', near.hunted,
  `behavior=${near.crew.behavior} intent=${near.crew.intent}`);

console.log('\nMemory, not omniscience');
const lost = decideAt(150, { forget: BOT_CONTACT_MEMORY * 0.4 });
expect('a contact lost seconds ago is still worth chasing', lost.hunted,
  `behavior=${lost.crew.behavior}`);
const stale = decideAt(150, { forget: BOT_CONTACT_MEMORY * 2 });
expect('and is forgotten once she is stale', !stale.hunted,
  `behavior=${stale.crew.behavior} target=${stale.crew.targetShipId ? 'set' : 'null'}`);
expect('the forgotten contact is pruned, so the memory cannot grow',
  stale.crew.contacts.size === 0, `contacts=${stale.crew.contacts.size}`);

console.log(failures === 0 ? '\nAll bot-perception assertions passed.' : `\n${failures} bot-perception assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
