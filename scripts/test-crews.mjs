#!/usr/bin/env node
// CREW-01 (netcode-21, gameplay-18, netcode-12, netcode-02, gameplay-13):
// a party of N shares ONE hull, and everything above the physics knows it.
//
// Before this, every hull in the world held exactly one pirate — a party of
// four sailed out as four ENEMY sloops, hasLivingCrewmate was false for
// everyone (so DBNO/revive were dead code in production), crewmates could farm
// kill gold off each other, and two survivors of one sunk crew counted as TWO
// crews so the match could never end.
//
// LOGIC suite: drives the real Match, no stack, no browser.
import { Match } from '../src/server/core/Match.ts';
import { ECONOMY, SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const fakeWs = () => ({ readyState: 1, send() {} });

// ---------------------------------------------------------------- friendly fire
// Graded through the REAL hitscan resolution (findClosestFirearmHit), on a pair
// that shares a hull — the shape a crew has had since long before crew records.
console.log('Small arms pass through a crewmate:');
const ffMatch = new Match({ matchId: 'crews-ff', botCount: 3 });
const [shooter, mate, enemy] = ffMatch.state.players;
mate.shipId = shooter.shipId;
mate.crewId = shooter.crewId ?? shooter.shipId;
shooter.crewId = mate.crewId;
enemy.crewId = enemy.shipId;
for (const p of [shooter, mate, enemy]) {
  p.state = 'alive';
  p.health = 100;
  p.respawnProtectionTimer = 0;
  p.onShipId = null;
  p.crouching = false;
}
shooter.position = { x: 0, y: 1, z: 0 };
mate.position = { x: 4, y: 1, z: 0 };
enemy.position = { x: 9, y: 1, z: 0 };
const trace = { origin: { x: 0, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 }, range: 60 };
const hit = ffMatch.findClosestFirearmHit(shooter, trace);
expect('the round finds a body at all (the trace is real)', hit !== null,
  'nothing hit — the fixture, not the rule, is wrong');
expect('a crewmate in the line of fire is not the one it hits',
  hit === null || hit.player.id !== mate.id,
  `hit ${hit?.player.id === mate.id ? 'the crewmate' : hit?.player.id}`);
expect('the enemy behind him still takes it', hit !== null && hit.player.id === enemy.id,
  `hit=${hit ? hit.player.name : 'nobody'}`);
ffMatch.stop();

// ------------------------------------------------------------------ crew record
console.log('A party of N sails ONE hull:');
const match = new Match({ matchId: 'crews', botCount: 0 });
try {
  const crewA = match.createCrew([{ ws: fakeWs(), name: 'Ann' }, { ws: fakeWs(), name: 'Bo' }]);
  const crewB = match.createCrew([{ ws: fakeWs(), name: 'Cid' }, { ws: fakeWs(), name: 'Dee' }]);
  for (const join of [...crewA.joins, ...crewB.joins]) join.send();

  expect('two crews of two put TWO hulls in the water, not four',
    match.state.ships.filter((s) => s.alive && !s.sinking).length === 2,
    `hulls=${match.state.ships.length}`);
  expect('every member is aboard the same hull',
    crewA.joins.every((j) => j.shipId === crewA.shipId),
    JSON.stringify(crewA.joins.map((j) => j.shipId)));

  const shipA = match.state.ships.find((s) => s.id === crewA.shipId);
  expect('a crew of two draws the two-hand hull (brigantine)', shipA.type === 'brigantine',
    `type=${shipA.type} (${SHIP_STATS[shipA.type].cannonCount ?? '?'} guns)`);
  expect('her crew list is the whole crew, not just her owner', shipA.crewIds.length === 2,
    JSON.stringify(shipA.crewIds));
  expect('the hull carries the crew id', shipA.crewId === crewA.crewId, `crewId=${shipA.crewId}`);

  const record = (match.state.crews ?? []).find((c) => c.id === crewA.crewId);
  expect('the crew record is in the state the client is sent', !!record,
    `crews=${(match.state.crews ?? []).length}`);
  expect('with both members and a leader', record
    && record.memberIds.length === 2 && record.leaderId === record.memberIds[0],
    JSON.stringify(record));

  const members = match.state.players.filter((p) => p.crewId === crewA.crewId);
  expect('both pirates carry the crew id', members.length === 2, `members=${members.length}`);
  const spread = Math.hypot(
    members[0].position.x - members[1].position.x,
    members[0].position.z - members[1].position.z,
  );
  expect('crewmates are set down a stride apart, not in one pile', spread > 0.5 && spread < 6,
    `spread=${spread.toFixed(2)} m`);
  const nearHull = members.every((m) => Math.hypot(
    m.position.x - shipA.position.x, m.position.z - shipA.position.z,
  ) < 60);
  expect('and alongside their own hull', nearHull);

  expect('the two crews got two different hulls', crewA.shipId !== crewB.shipId);
  const shipB = match.state.ships.find((s) => s.id === crewB.shipId);
  const hullGap = Math.hypot(shipA.position.x - shipB.position.x, shipA.position.z - shipB.position.z);
  expect('moored clear of each other', hullGap > (SHIP_STATS[shipA.type].width + SHIP_STATS[shipB.type].width) * 0.5 + 1,
    `gap=${hullGap.toFixed(1)} m`);
} catch (err) {
  console.error(`  ✗ FAIL: Match.createCrew is unusable — ${err.message}`);
  failures += 1;
}
match.stop();

// -------------------------------------------------- a crew is one crew, sunk or not
console.log('A crew that lost her hull is still ONE crew:');
const endMatch = new Match({ matchId: 'crews-end', botCount: 0 });
endMatch.state.storm.centerX = 0;
endMatch.state.storm.centerZ = 0;
endMatch.state.storm.safeRadius = 1200;
const crew1 = endMatch.createCrew([{ ws: fakeWs(), name: 'Ann' }, { ws: fakeWs(), name: 'Bo' }]);
const crew2 = endMatch.createCrew([{ ws: fakeWs(), name: 'Cid' }, { ws: fakeWs(), name: 'Dee' }]);
for (const join of [...crew1.joins, ...crew2.joins]) join.send();
endMatch.state.phase = 'playing';
endMatch.crewsAtStart = 2;

// Crew 1 is sunk: her hull is gone and both survivors are ashore inside the ring.
const sunk = endMatch.state.ships.find((s) => s.id === crew1.shipId);
sunk.alive = false;
const survivors = endMatch.state.players.filter((p) => p.crewId === crew1.crewId);
for (const p of survivors) {
  p.shipId = null;
  p.onShipId = null;
  p.state = 'alive';
  p.health = 80;
  p.position = { x: 5, y: 2, z: 5 };
}
const counted = endMatch.countActiveCrews();
expect('two shipless survivors of one crew count as ONE crew', counted.crews.size === 2,
  `activeCrews=${counted.crews.size} (2 crews are in this match)`);
endMatch.checkWinCondition();
expect('and the match does NOT end while they are still in it', endMatch.state.phase === 'playing',
  `phase=${endMatch.state.phase}`);

// Now the sea takes them: the last crew standing wins, all hands.
for (const p of survivors) p.state = 'eliminated';
endMatch.checkWinCondition();
expect('the last crew afloat ends the match', endMatch.state.phase === 'ended',
  `phase=${endMatch.state.phase}`);
const winner = endMatch.state.players.find((p) => p.id === endMatch.state.winnerId);
expect('and the winner is one of hers', !!winner && winner.crewId === crew2.crewId,
  `winnerId=${endMatch.state.winnerId}`);
const board = endMatch.buildEndBoard(winner ?? null);
const winRows = board.filter((r) => r.isWinner);
expect('ALL HANDS win, not just the name on the hull', winRows.length === 2,
  `isWinner rows=${winRows.length}: ${board.map((r) => `${r.name}:${r.isWinner}`).join(' ')}`);
endMatch.stop();

// ------------------------------------------------------------- the crew's hold wins
console.log("The crew's hold crosses the line, not one purse:");
const goldMatch = new Match({ matchId: 'crews-gold', botCount: 0 });
goldMatch.state.storm.safeRadius = 1200;
const rich = goldMatch.createCrew([
  { ws: fakeWs(), name: 'Ann' }, { ws: fakeWs(), name: 'Bo' }, { ws: fakeWs(), name: 'Cid' },
]);
for (const join of rich.joins) join.send();
goldMatch.createCrew([{ ws: fakeWs(), name: 'Dee' }]).joins[0].send();
goldMatch.state.phase = 'playing';
goldMatch.crewsAtStart = 2;
const richCrew = goldMatch.state.players.filter((p) => p.crewId === rich.crewId);
const share = Math.ceil((ECONOMY.GOLD_WIN_TARGET / richCrew.length) + 1);
for (const p of richCrew) p.gold = share;
expect('no crewmate is at the target alone', richCrew.every((p) => p.gold < ECONOMY.GOLD_WIN_TARGET),
  `each=${share} target=${ECONOMY.GOLD_WIN_TARGET}`);
goldMatch.checkWinCondition();
expect('but the crew banks together and takes the match', goldMatch.state.phase === 'ended',
  `phase=${goldMatch.state.phase}, crewGold=${share * richCrew.length}`);
expect('the win is filed as gold', goldMatch.endReason === 'gold', `reason=${goldMatch.endReason}`);
const goldWinner = goldMatch.state.players.find((p) => p.id === goldMatch.state.winnerId);
expect('and it is the rich crew that won it', !!goldWinner && goldWinner.crewId === rich.crewId,
  `winnerId=${goldMatch.state.winnerId}`);
goldMatch.stop();

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
