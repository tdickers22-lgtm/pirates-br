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
import { SHIP_STATS } from '../src/shared/constants/index.ts';

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

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
