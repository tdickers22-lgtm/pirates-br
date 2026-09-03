#!/usr/bin/env node
/**
 * WHO IS STILL IN THE RACE — AND WHEN IS THE RACE OVER?
 *
 * The win check counted HULLS and called them crews, and it counted island
 * SKELETONS among them. Five separate ways that ended a match wrong:
 *
 *  • A skeleton wave standing on a beach was an "active crew", so the last two
 *    living captains could sink each other and the match would still hold open
 *    for scenery that is not running the race — and `winnerId` could be crowned
 *    onto a skeleton, because `lastContender` never asked what it was.
 *  • A sunk bot floating in open water 800 m from land kept its crew alive for
 *    as long as it took the sea to drown it (60-80 s of a finished match).
 *  • `crew_eliminated` fired the instant a hull went under, while her crew was
 *    still swimming and fighting — the announce that the CREWS AFLOAT counter
 *    is named after, spent on a hull.
 *  • A two-human, zero-bot match could not end after one player left, because
 *    the guard read `ships.length > 1` on an array the leaver's hull had just
 *    been spliced out of.
 *  • A simultaneous wipe crowned nobody and still filed the match as
 *    'last_ship'. There was no draw.
 *
 * This suite drives a real Match on real ticks. WIN-01 (gameplay-34, 01, 28,
 * 04, 15, 12, netcode-34).
 */
import { Match } from '../src/server/core/Match.ts';
import { MATCH_END } from '../src/shared/constants/index.ts';

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

/** A live match already at sea: phase 'playing', crews registered, storm wide. */
function freshMatch(botCount = 3, id = 'win-condition-test') {
  const match = new Match({ matchId: id, botCount });
  const state = match.state;
  state.phase = 'playing';
  state.storm.centerX = 0;
  state.storm.centerZ = 0;
  state.storm.safeRadius = 900;
  state.storm.damagePerSec = 0;
  const msgs = [];
  match.broadcast = (msg) => { msgs.push(msg); };
  // One tick registers the crews that started the match (crewsAtStart).
  match.tick();
  msgs.length = 0;
  return { match, state, msgs };
}

/** Put a hull on the bottom for good, the way a founder ends. */
function sinkOutright(match, ship) {
  ship.sinking = true;
  ship.alive = false;
  ship.sinkProgress = 1;
}

// ── SKELETONS DO NOT RUN THE RACE ────────────────────────────────────────────
console.log('Skeleton waves:');
{
  const { match, state } = freshMatch(3, 'win-skeletons');
  const [winner, loserA, loserB] = state.players;
  // An island wave is up: a skeleton is a Player like any other, minus a hull.
  const skeleton = match.spawnTestSkeleton
    ? match.spawnTestSkeleton()
    : (() => {
        const bone = { ...loserA, id: 'skeleton-1', name: 'Skeleton', isBot: true, shipId: null, onShipId: null,
          state: 'alive', health: 60, position: { x: 120, y: 2, z: 120 }, velocity: { x: 0, y: 0, z: 0 } };
        state.players.push(bone);
        match.skeletonHomes.set(bone.id, state.islands[0]?.id ?? 'island-0');
        match.rebuildEntityIndexes();
        return bone;
      })();

  // Both rival captains go down with their hulls, well clear of land.
  for (const loser of [loserA, loserB]) {
    const hull = state.ships.find((s) => s.id === loser.shipId);
    sinkOutright(match, hull);
    loser.state = 'eliminated';
    loser.health = 0;
  }
  match.checkWinCondition();

  expect('the match ends on the first check once only one living crew is left',
    state.phase === 'ended', `phase=${state.phase}`);
  expect('...and the winner is a captain, never the skeleton wave',
    state.winnerId === winner.id,
    `winnerId=${state.winnerId} winner=${winner.id} skeleton=${skeleton.id}`);
}

// ── A SUNK CREW ADRIFT IN OPEN WATER IS NOT A CONTENDER FOREVER ──────────────
console.log('\nLost at sea:');
{
  const { match, state, msgs } = freshMatch(3, 'win-adrift');
  const [survivor, adrift, third] = state.players;
  for (const gone of [third]) {
    sinkOutright(match, state.ships.find((s) => s.id === gone.shipId));
    gone.state = 'eliminated';
    gone.health = 0;
  }
  // The bot's hull founders and he swims out — far from any island, inside the
  // ring, treading water with nothing to sail and nowhere to stand.
  const hull = state.ships.find((s) => s.id === adrift.shipId);
  match.startShipSinking(hull, false, null);
  adrift.onShipId = null;
  adrift.state = 'swimming';
  adrift.health = 100;
  adrift.position = { x: 640, y: 0, z: -410 };

  match.checkWinCondition();
  expect('a crew that just lost its hull still contends (the grace)',
    state.phase === 'playing', `phase=${state.phase}`);

  const sunkMsgs = msgs.filter((m) => m.type === 'ship_sunk');
  const crewMsgs = msgs.filter((m) => m.type === 'crew_eliminated');
  expect('the founder announces ship_sunk', sunkMsgs.length === 1,
    `ship_sunk=${sunkMsgs.length} crew_eliminated=${crewMsgs.length}`);
  expect('...and does NOT announce crew_eliminated while her crew still swims',
    crewMsgs.length === 0, `crew_eliminated=${JSON.stringify(crewMsgs.map((m) => m.payload))}`);

  // Run past the grace: the sea takes him and the match closes.
  const deadline = match.t + MATCH_END.LOST_AT_SEA_GRACE_SECONDS + 10;
  while (match.t < deadline && state.phase === 'playing') {
    adrift.position = { x: 640, y: 0, z: -410 };
    adrift.state = 'swimming';
    adrift.health = 100;
    match.tick();
  }
  expect(`the adrift crew is eliminated within ${MATCH_END.LOST_AT_SEA_GRACE_SECONDS + 10}s and the match ends`,
    state.phase === 'ended', `phase=${state.phase} t=${match.t.toFixed(1)}`);
  expect('...credited to the survivor',
    state.winnerId === survivor.id, `winnerId=${state.winnerId} survivor=${survivor.id}`);
  expect('...filed as lost at sea, not as a drowning nobody watched',
    adrift.state === 'eliminated' && msgs.some((m) => m.type === 'crew_eliminated'),
    `adrift=${adrift.state} crew_eliminated=${msgs.filter((m) => m.type === 'crew_eliminated').length}`);
}

// ── A SIMULTANEOUS WIPE IS A DRAW ────────────────────────────────────────────
console.log('\nDraw:');
{
  const { match, state } = freshMatch(2, 'win-draw');
  for (const p of state.players) {
    sinkOutright(match, state.ships.find((s) => s.id === p.shipId));
    p.state = 'eliminated';
    p.health = 0;
  }
  match.checkWinCondition();
  expect('the match ends with nobody afloat', state.phase === 'ended', `phase=${state.phase}`);
  expect('...crowning nobody', state.winnerId === null, `winnerId=${state.winnerId}`);
  expect("...and filed as a 'draw', not as a last_ship win with no ship",
    match.endReason === 'draw', `endReason=${match.endReason}`);
}

// ── ONE CREW IS NOT A RACE: A SOLO MATCH DOES NOT END ITSELF ─────────────────
console.log('\nCrews at start:');
{
  const { match, state } = freshMatch(1, 'win-solo');
  expect('a one-crew match records one crew at start', match.crewsAtStart === 1,
    `crewsAtStart=${match.crewsAtStart}`);
  match.checkWinCondition();
  expect('...and never ends itself for want of a rival',
    state.phase === 'playing', `phase=${state.phase}`);
}

if (failures > 0) {
  console.error(`\n${failures} win-condition assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll win-condition assertions passed.');
