#!/usr/bin/env node
// TAKING A SHIP, AND NOT FARMING A DECK (CAPTURE-01: gameplay-19, 29, 37).
//
// Three things a live match got wrong at once:
//   · a pirate whose hull went down could board an empty enemy brig, stand at
//     her wheel and sail her — and the match still called her shipless;
//   · boarding a bot deck and standing on the respawn point paid the full kill
//     bounty every twenty seconds, forever;
//   · the boarder who had just killed your whole crew counted as YOUR SAILOR,
//     so your hull was "still crewed" by the man who took her.
//
//   node --import tsx scripts/test-capture.mjs
import { Match } from '../src/server/core/Match.ts';
import { SERVER_TICK_MS, PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const DT = SERVER_TICK_MS / 1000;
function makeFakeWs() {
  return { readyState: 1, bufferedAmount: 0, send() {}, close() {}, on() {} };
}
function liveMatch(id, bots = 3) {
  const match = new Match({ matchId: id, botCount: bots });
  match.state.phase = 'playing';
  return match;
}

// ══ 1. A crewless hull changes hands at her own wheel ═══════════════════════
console.log('1. Capture — hold the helm of a crewless hull');
{
  const match = liveMatch('capture-helm', 3);
  const joined = match.addHumanClient(makeFakeWs(), 'Castaway');
  const human = match.state.players.find((p) => p.id === joined.playerId);
  const prize = match.state.ships.find((s) => s.id !== joined.shipId && s.alive);
  const skipper = match.state.players.find((p) => p.shipId === prize.id);

  // Her crew is dead and she is empty: the castaway swims aboard and takes the
  // wheel. (The station arbiter and locomotion are pinned by their own suites;
  // this drives the state the capture rule reads.)
  skipper.health = 0;
  skipper.state = 'eliminated';
  human.onShipId = prize.id;
  human.atHelm = true;
  human.position = { ...prize.position };

  const ownerBefore = prize.ownerId;
  for (let i = 0; i < Math.ceil(9 / DT); i++) {
    human.onShipId = prize.id;
    human.atHelm = true;
    match.tick();
  }
  expect('eight seconds at the wheel of a crewless hull makes her yours',
    prize.ownerId === human.id, `owner ${ownerBefore} → ${prize.ownerId}`);
  expect('and she is the hull the match now anchors him to',
    human.shipId === prize.id, `shipId=${human.shipId}`);
  expect('her old crew is on her crew list no longer',
    prize.crewIds.length === 1 && prize.crewIds[0] === human.id, prize.crewIds.join(','));
  expect('the crew that lost her is eliminated, not left counting down',
    skipper.state === 'eliminated', skipper.state);
  expect('and the bot skipper is unregistered from the fleet',
    !match.bots.bots.has(skipper.id), 'still steering');
  match.stop();
}

// ══ 2. A hull with living crew aboard is NOT takeable ══════════════════════
console.log('\n2. A crewed hull is not a prize');
{
  const match = liveMatch('capture-crewed', 3);
  const joined = match.addHumanClient(makeFakeWs(), 'Boarder');
  const human = match.state.players.find((p) => p.id === joined.playerId);
  const prize = match.state.ships.find((s) => s.id !== joined.shipId && s.alive);
  const skipper = match.state.players.find((p) => p.shipId === prize.id);
  skipper.health = 100;
  skipper.state = 'alive';
  const ownerBefore = prize.ownerId;
  for (let i = 0; i < Math.ceil(12 / DT); i++) {
    human.onShipId = prize.id;
    human.atHelm = true;
    match.tick();
  }
  expect('a hull with a living hand aboard never changes owner',
    prize.ownerId === ownerBefore, `${ownerBefore} → ${prize.ownerId}`);
  match.stop();
}

// ══ 3. An enemy on your deck is CONTESTED, not one of your sailors ═════════
console.log('\n3. The man who killed your crew is not your crew');
{
  const match = liveMatch('capture-contested', 3);
  const joined = match.addHumanClient(makeFakeWs(), 'Owner');
  const owner = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);
  const enemy = match.state.players.find((p) => p.isBot && p.shipId && p.shipId !== ship.id);
  enemy.onShipId = ship.id;
  enemy.health = 100;
  enemy.state = 'alive';
  expect('a boarder does not count as a sailor for the hull he is standing on',
    match.hasSailorForHull(ship, owner) === false, 'counted as crew');
  expect('but the hull reads as contested',
    match.isHullContested(ship, owner) === true, 'not contested');
  match.stop();
}

// ══ 4. Three kills of the same pirate in a minute pay under 2x ═════════════
console.log('\n4. No farming one deck');
{
  const match = liveMatch('capture-farm', 3);
  const a = match.addHumanClient(makeFakeWs(), 'Farmer');
  const killer = match.state.players.find((p) => p.id === a.playerId);
  const victim = match.state.players.find((p) => p.isBot && p.shipId && p.shipId !== a.shipId && !p.name.startsWith('Skeleton'));
  killer.gold = 0;
  let paid = 0;
  for (let round = 0; round < 3; round++) {
    paid += match.creditPlayerKill(killer, victim).killGold;
    for (let i = 0; i < Math.ceil(20 / DT); i++) match.tick();
  }
  expect('three kills of the SAME pirate inside a minute pay less than two bounties',
    paid < PLAYER.KILL_GOLD_REWARD * 2, `paid=${paid} vs ${PLAYER.KILL_GOLD_REWARD * 2}`);
  expect('the first one still pays in full', paid >= PLAYER.KILL_GOLD_REWARD, `paid=${paid}`);

  // A DIFFERENT pirate is a different fight and pays in full: this is anti-farm,
  // not anti-kill.
  const other = match.state.players.find((p) => p.isBot && p.id !== victim.id && p.shipId && p.shipId !== a.shipId && !p.name.startsWith('Skeleton'));
  const fresh = match.creditPlayerKill(killer, other).killGold;
  expect('killing someone else still pays the full bounty',
    fresh === PLAYER.KILL_GOLD_REWARD, `paid=${fresh}`);
  match.stop();
}

if (failures > 0) {
  console.error(`\n${failures} capture assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll capture assertions passed.');
