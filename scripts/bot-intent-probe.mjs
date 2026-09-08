#!/usr/bin/env node
// BOTS ARE A PACING DEVICE, AND A SILENT ONE IS SCENERY (BOTFUN-01 / bots-15, bots-14).
//
// Two things this grades, both of which a player feels directly:
//
//  1. VARIETY. A crew that spends a whole match on one rung of the behaviour
//     tree is a coin-flip switch with extra steps. Over a full arc every crew
//     must show at least three DISTINCT branches (survive / storm / opportunity
//     / objective / idle) — not three leaves, three branches, so "patrol then
//     patrol somewhere else" does not count as having a mind.
//  2. VOICE. Every crew that lives two minutes must say at least one thing out
//     loud. Before BOTFUN-01 there was no intent stream at all: bots changed
//     their minds nine times a match and the player was told nothing, which is
//     why a bot turning toward you read as random.
//
// Logic-tier: no stack, no browser. The map seed is pinned exactly as
// test-wreck-event/test-wreck-site do — the storm's ring centres draw from
// makeMatchRng, which is Math.random unless PIRATES_BR_MAP_SEED is set.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
const previousSeed = process.env.PIRATES_BR_MAP_SEED;

import { Match } from '../src/server/core/Match.ts';
import { INTENT_BRANCH, INTENT_LOG_MAX } from '../src/server/systems/bots/Blackboard.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const ARC_SECONDS = 420;
const match = new Match({ matchId: 'bot-intent-probe', botCount: 9 });
match.state.phase = 'playing';

/** shipId -> { branches:Set, lines:number, bornAt, lastSeen } */
const crews = new Map();
let undrainedMax = 0;

while (match.t < ARC_SECONDS && match.state.phase === 'playing') {
  match.tick();
  const bots = match.bots;
  const states = bots.crewStates ?? new Map();
  for (const crew of states.values()) {
    let row = crews.get(crew.shipId);
    if (!row) { row = { branches: new Set(), lines: 0, bornAt: match.t, lastSeen: match.t }; crews.set(crew.shipId, row); }
    row.lastSeen = match.t;
    const branch = INTENT_BRANCH?.[crew.intent];
    if (branch) row.branches.add(branch);
  }
  undrainedMax = Math.max(undrainedMax, bots.bb?.intentLog?.length ?? 0);
  const spoken = typeof bots.drainIntents === 'function' ? bots.drainIntents() : [];
  for (const line of spoken) {
    const row = crews.get(line.shipId);
    if (row) row.lines += 1;
    if (row && row.lines === 1) console.log(`     first voice ${line.shipId}: "${line.name}: ${line.text}" (${line.intent}) t=${line.t.toFixed(0)}s`);
  }
}

console.log(`\nArc ${match.t.toFixed(0)} s, ${crews.size} bot crews`);
expect('the probe actually watched a lobby', crews.size >= 6, `crews=${crews.size}`);

let thinnest = Infinity; let thinnestId = '';
let mute = [];
for (const [shipId, row] of crews) {
  const life = row.lastSeen - row.bornAt;
  if (row.branches.size < thinnest) { thinnest = row.branches.size; thinnestId = shipId; }
  const owed = Math.floor(life / 120);
  if (row.lines < Math.max(1, owed)) mute.push(`${shipId} life=${life.toFixed(0)}s lines=${row.lines} owed=${Math.max(1, owed)}`);
  console.log(`  ${shipId}: branches=[${[...row.branches].join(', ')}] lines=${row.lines} life=${life.toFixed(0)}s`);
}

expect('every crew shows at least three distinct branches of the tree',
  thinnest >= 3, `thinnest crew ${thinnestId} showed ${thinnest === Infinity ? 0 : thinnest}`);
expect('every crew that lives two minutes says something out loud',
  mute.length === 0, mute.slice(0, 4).join('\n     '));
expect('the intent log is bounded, drained or not',
  undrainedMax <= INTENT_LOG_MAX, `max undrained ${undrainedMax} > ${INTENT_LOG_MAX}`);

process.env.PIRATES_BR_MAP_SEED = previousSeed;
console.log(failures === 0 ? '\nPASS bot-intent-probe' : `\nFAIL bot-intent-probe (${failures})`);
process.exit(failures === 0 ? 0 : 1);
