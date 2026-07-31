#!/usr/bin/env node
/**
 * THE END-OF-MATCH BOARD, AND THE DEATHS COLUMN THAT WAS NEVER A COUNT.
 *
 * A solo queue is one human against nine bots. The end screen was fed the
 * server's `humans` list and nothing else, so its "results table" had exactly
 * ONE row in it — yours — sitting at placement 1 whether you took the seas or
 * drowned in the first minute. And the Deaths column read
 * `state === 'eliminated' ? 1 : 0`: a survival flag wearing a counter's name,
 * so a pirate cut down four times and respawned each time read 0.
 *
 * What is pinned here:
 *   1. `board` carries EVERY crew in the match, bots included, ranked once;
 *      `crewCount` agrees with its length.
 *   2. Skeleton-wave players are bots too — they must never reach the board.
 *   3. The ranking rule: winner first, then survivors richest-first, then the
 *      eliminated in reverse order of dying (outlasting IS the ranking).
 *   4. Deaths counts every death, respawns included — for bots as well.
 *   5. A human's persisted `placement` is her FLEET standing, not her rank
 *      among the humans (which in solo is always 1, forever).
 *   6. A human who disconnected after being eliminated keeps her row.
 */
import { Match } from '../src/server/core/Match.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function makeFakeWs(sink = null) {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send(data) { if (sink) sink.push(JSON.parse(data)); },
    close() {},
  };
}

/** Kill a player through the real death path so matchDeaths is earned, not set. */
function slay(match, player) {
  player.health = 0;
  match.handlePlayerDeath(player);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('1. The board is the whole fleet, not the humans');

const BOTS = 9;
const match = new Match({ matchId: `board-${Math.random().toString(36).slice(2, 8)}`, botCount: BOTS });
match.state.phase = 'playing';
const sink = [];
const joined = match.addHumanClient(makeFakeWs(sink), 'BoardHero');
const hero = match.state.players.find((p) => p.id === joined.playerId);
const bots = match.state.players.filter((p) => p.isBot && !match.isSkeletonPlayer(p));

expect(`fleet is ${BOTS} bots + 1 human`, bots.length === BOTS && !!hero,
  `bots=${bots.length} hero=${!!hero}`);

// Give the survivors distinct purses so the gold tiebreak is observable.
hero.gold = 400;
bots[0].gold = 900;
bots[1].gold = 120;

// ── Deaths that are really deaths ──────────────────────────────────────────
// The hero dies three times and respawns each time (her ship is alive), so the
// Deaths column has to read 3 and her state has to be nothing like eliminated.
for (let i = 0; i < 3; i += 1) {
  hero.state = 'alive';
  hero.health = 0;
  match.handlePlayerDeath(hero);
}
hero.state = 'alive';
hero.health = 100;

// ── A run of eliminations, in a known order ────────────────────────────────
// bots[8] dies first (worst), then 7, 6 … so the board must list them 6, 7, 8
// from the bottom up.
const eliminated = [];
for (let i = BOTS - 1; i >= 2; i -= 1) {
  const bot = bots[i];
  // No home ship ⇒ handlePlayerDeath eliminates instead of respawning.
  for (const ship of match.state.ships) {
    if (ship.id === bot.shipId) ship.alive = false;
  }
  slay(match, bot);
  eliminated.push(bot);
}
expect('the seven losers were eliminated, not respawned',
  eliminated.every((b) => b.state === 'eliminated'),
  eliminated.map((b) => `${b.name}:${b.state}`).join(' '));

// bots[0] takes it on gold.
match.state.winnerId = bots[0].id;
match.state.phase = 'ended';
match.endReason = 'gold';

let captured = null;
match.onMatchEnd = (r) => { captured = r; };
match.emitMatchEnd();

expect('a result was emitted', !!captured);
const board = captured.board;
expect('board exists and is an array', Array.isArray(board), typeof board);
expect(`board has all ${BOTS + 1} crews`, board.length === BOTS + 1,
  `length=${board.length}: ${board.map((r) => r.name).join(', ')}`);
expect('crewCount agrees with the board', captured.crewCount === board.length,
  `crewCount=${captured.crewCount} board=${board.length}`);
expect('board is more than the humans list', board.length > captured.humans.length,
  `board=${board.length} humans=${captured.humans.length}`);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. Skeletons are wildlife, not crews');

expect('no skeleton reached the board',
  board.every((r) => !match.isSkeletonPlayer({ id: r.playerId, isBot: true })),
  board.filter((r) => match.isSkeletonPlayer({ id: r.playerId, isBot: true })).map((r) => r.name).join(', '));
expect('every board row is a real player id',
  board.every((r) => match.playersById.has(r.playerId) || match.humanFinalStats.has(r.playerId)));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Placements are one contiguous 1..N ranking');

expect('placements run 1..N with no gaps and no ties',
  board.every((r, i) => r.placement === i + 1),
  board.map((r) => `${r.placement}:${r.name}`).join(' '));
expect('the winner is placement 1',
  board[0].playerId === bots[0].id && board[0].isWinner === true,
  `${board[0].name} placement=${board[0].placement} isWinner=${board[0].isWinner}`);
expect('exactly one winner flag on the board',
  board.filter((r) => r.isWinner).length === 1);

const survivors = board.filter((r) => r.alive);
const sunk = board.filter((r) => !r.alive);
expect('survivors all rank above the sunk',
  Math.max(...survivors.map((r) => r.placement)) < Math.min(...sunk.map((r) => r.placement)),
  `survivors ${survivors.map((r) => r.placement)} sunk ${sunk.map((r) => r.placement)}`);
expect('among survivors, richer places higher',
  board.find((r) => r.playerId === hero.id).placement
    < board.find((r) => r.playerId === bots[1].id).placement,
  `hero(${hero.gold}) vs bot1(${bots[1].gold})`);
// The last crew to die outranks the first.
const firstToDie = eliminated[0];
const lastToDie = eliminated[eliminated.length - 1];
expect('the last crew to sink outranks the first',
  board.find((r) => r.playerId === lastToDie.id).placement
    < board.find((r) => r.playerId === firstToDie.id).placement,
  `last=${board.find((r) => r.playerId === lastToDie.id).placement} first=${board.find((r) => r.playerId === firstToDie.id).placement}`);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. Deaths is a count, for everyone');

const heroRow = board.find((r) => r.playerId === hero.id);
expect('the hero died three times and the board says three', heroRow.deaths === 3,
  `deaths=${heroRow.deaths}`);
expect('the hero is marked afloat', heroRow.alive === true);
expect('every eliminated bot carries at least one death',
  eliminated.every((b) => board.find((r) => r.playerId === b.id).deaths >= 1),
  eliminated.map((b) => `${b.name}:${board.find((r) => r.playerId === b.id).deaths}`).join(' '));
expect('the untouched survivor carries zero deaths',
  board.find((r) => r.playerId === bots[1].id).deaths === 0,
  `${bots[1].name} deaths=${board.find((r) => r.playerId === bots[1].id).deaths}`);
expect('bot rows are flagged as bots and the human row is not',
  board.filter((r) => r.isBot).length === BOTS && heroRow.isBot === false,
  `bots flagged=${board.filter((r) => r.isBot).length} heroIsBot=${heroRow.isBot}`);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. A human\'s persisted placement is her FLEET standing');

const heroHuman = captured.humans.find((h) => h.playerId === hero.id);
expect('the human result exists', !!heroHuman);
expect('her persisted placement matches her board placement',
  heroHuman.placement === heroRow.placement,
  `human=${heroHuman.placement} board=${heroRow.placement}`);
expect('she did not silently place 1st for being the only human',
  heroHuman.placement > 1, `placement=${heroHuman.placement}`);
expect('her persisted deaths match the counted deaths',
  heroHuman.deaths === 3, `deaths=${heroHuman.deaths}`);

// ────────────────────────────────────────────────────────────────────────────
console.log('\n6. A human who quit after dying keeps her row');

{
  const m2 = new Match({ matchId: `quit-${Math.random().toString(36).slice(2, 8)}`, botCount: 3 });
  m2.state.phase = 'playing';
  const j = m2.addHumanClient(makeFakeWs(), 'Deserter');
  const quitter = m2.state.players.find((p) => p.id === j.playerId);
  for (const ship of m2.state.ships) if (ship.id === quitter.shipId) ship.alive = false;
  slay(m2, quitter);
  expect('the quitter was eliminated', quitter.state === 'eliminated', quitter.state);

  // Arm the capture BEFORE the disconnect: losing the last human is itself an
  // end condition (endMatchAbandoned), and the result is emitted exactly once.
  let r2 = null;
  m2.onMatchEnd = (r) => { r2 = r; };
  const bots2 = m2.state.players.filter((p) => p.isBot && !m2.isSkeletonPlayer(p));
  m2.state.winnerId = bots2[0].id;
  m2.removeClient(j.playerId);
  m2.state.phase = 'ended';
  m2.endReason = m2.endReason ?? 'last_ship';
  m2.emitMatchEnd();

  expect('the abandoned match still emitted a result', !!r2);

  const row = r2.board.find((r) => r.name === 'Deserter');
  expect('the departed human still has a board row', !!row,
    r2.board.map((r) => r.name).join(', '));
  expect('her row still carries her death', !!row && row.deaths >= 1, `deaths=${row?.deaths}`);
  expect('placements are still contiguous with her in them',
    r2.board.every((r, i) => r.placement === i + 1),
    r2.board.map((r) => `${r.placement}:${r.name}`).join(' '));
}

console.log(failures === 0 ? '\nAll end-match board assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
