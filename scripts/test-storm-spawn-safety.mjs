#!/usr/bin/env node
// THE OPENING MUST NOT KILL YOU, AND THE END MUST NOT HANG.
//
// A fresh-eyes audit died four times in five matches without ever fighting a
// pirate. Two rails failed at once, and this suite is the pin for both plus the
// three economy/pacing calls that landed with them:
//
//   1. THE STORM SPAWN TRAP. Spawn docks reach 750 m from the origin while the
//      first ring used to settle at 680 — an edge-spawned solo was OUTSIDE the
//      circle at ~T+3:45, bleeding on his own pier, dead at ~T+5:00 with zero
//      kills. The first ring is now sized off REAL dock geometry and closes on
//      the world instead of drifting off it.
//   2. THE RESPAWN-HELD DEADLOCK. Solo crew, dead, hull anchored outside the
//      ring: "Respawn held — your ship is in the storm" forever on a near-black
//      screen until an empty hull foundered. With no living soul who can sail
//      her, the tide now brings the derelict in and a REAL countdown starts.
//   3. SKELETONS DO NOT GET PAID. A skeleton that cut a pirate down banked the
//      full 275 g kill bounty and rode it onto the gold leaderboard.
//   4. THE RACE NEEDS RIVALS. A bot crew that crosses the gold target takes the
//      match; it used to be barred from winning a race it was running.
//   5. THE GUNS LEARN THE WEATHER. Bot cannon cadence/accuracy scale with the
//      storm phase — gentle opening, converting endgame.
//
//   node --import tsx scripts/test-storm-spawn-safety.mjs
import { Match } from '../src/server/core/Match.ts';
import { buildWireSnapshot } from '../src/server/core/snapshot.ts';
import {
  BOT_CANNON_ACCURACY_BY_PHASE,
  BOT_CANNON_CADENCE_BY_PHASE,
  ECONOMY,
  PLAYER,
  RESPAWN_HOLD_GRACE_SECONDS,
  SERVER_TICK_MS,
  STORM_ARC_SECONDS,
  STORM_DOCK_COVER_MARGIN,
  STORM_PHASES,
  botPhaseScale,
} from '../src/shared/constants/index.ts';
import { dist2D } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
function makeFakeWs(sink = null) {
  return { readyState: 1, bufferedAmount: 0, send(d) { if (sink) sink.push(JSON.parse(d)); }, close() {} };
}
function liveMatch(id, botCount = 0) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  return match;
}
function run(match, seconds) {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i++) match.tick();
}
/** Wind the ring forward to a small, static circle on the origin — the only way
 *  to put a hull OUTSIDE the wall inside a 1000 m world. */
function closeTheRing(match, radius) {
  const storm = match.state.storm;
  storm.phase = 2;
  storm.centerX = 0;
  storm.centerZ = 0;
  storm.nextCenterX = 0;
  storm.nextCenterZ = 0;
  storm.shrinkStartCenterX = 0;
  storm.shrinkStartCenterZ = 0;
  storm.shrinkStartRadius = radius;
  storm.safeRadius = radius;
  storm.nextRadius = radius;
  storm.shrinking = false;
  storm.shrinkTimer = 600;
  return storm;
}

/** Every dock in the world, with its distance from the origin. */
function docksOf(match) {
  return match.state.islands
    .filter((island) => island.dock)
    .map((island) => ({
      island,
      dock: island.dock,
      radius: Math.max(
        Math.hypot(island.dock.berthPosition.x, island.dock.berthPosition.z),
        Math.hypot(island.dock.respawnPoint.x, island.dock.respawnPoint.z),
      ),
    }));
}

// ══ 1. The first ring is sized off the docks, and it closes on the world ═════
console.log('The first ring contains every spawn dock');
{
  const match = liveMatch('ring-covers-docks');
  const docks = docksOf(match);
  const furthest = docks.reduce((a, b) => (b.radius > a.radius ? b : a));
  const storm = match.state.storm;

  expect('the world really does moor crews out past the old 680 m ring',
    furthest.radius > 680,
    `furthest dock: ${furthest.island.name} at ${furthest.radius.toFixed(0)} m`);
  expect('the first ring settles OUTSIDE the furthest berth, with margin',
    storm.nextRadius >= furthest.radius + STORM_DOCK_COVER_MARGIN,
    `firstRing=${storm.nextRadius} furthest=${furthest.radius.toFixed(0)} margin=${STORM_DOCK_COVER_MARGIN}`);
  expect('the opening circle closes ON the world, not off into a corner',
    storm.nextCenterX === 0 && storm.nextCenterZ === 0,
    `next centre=(${storm.nextCenterX}, ${storm.nextCenterZ})`);
  expect('EVERY dock — berth and pier alike — is inside that first ring',
    docks.every((d) => d.radius < storm.nextRadius),
    docks.map((d) => `${d.island.name}=${d.radius.toFixed(0)}`).join(' '));
  expect('the design constant agrees with the measured world (no silent widening)',
    STORM_PHASES[0].endRadius >= furthest.radius + STORM_DOCK_COVER_MARGIN,
    `table=${STORM_PHASES[0].endRadius} needed=${(furthest.radius + STORM_DOCK_COVER_MARGIN).toFixed(0)}`);
  expect('the first ring still SHRINKS (it is a storm, not a gift)',
    storm.nextRadius < storm.safeRadius,
    `${storm.safeRadius} → ${storm.nextRadius}`);

  // Drive the whole first phase and prove the settled circle really holds them.
  run(match, STORM_PHASES[0].waitSec + STORM_PHASES[0].shrinkSec + 2);
  expect('after the first shrink has run, every dock is still in shelter',
    docks.every((d) => dist2D(
      d.dock.respawnPoint.x, d.dock.respawnPoint.z,
      match.state.storm.centerX, match.state.storm.centerZ,
    ) < match.state.storm.safeRadius),
    `radius=${match.state.storm.safeRadius.toFixed(0)} centre=(${match.state.storm.centerX.toFixed(0)}, ${match.state.storm.centerZ.toFixed(0)})`);
}

// ══ 2. A pirate who never sails is not killed where the game put him ═════════
console.log('\nA never-sailed spawn survives past T+5:00 with nobody firing');
{
  const SURVIVE_TO = 300;
  let lastRing = null;
  for (let run3 = 0; run3 < 3; run3++) {
    const match = liveMatch(`never-sails-${run3}`);
    const joined = match.addHumanClient(makeFakeWs(), 'Greenhorn');
    const player = match.state.players.find((p) => p.id === joined.playerId);
    const ship = match.state.ships.find((s) => s.id === joined.shipId);
    // The WORST berth in the world, not whichever one the join roll handed out.
    const furthest = docksOf(match).reduce((a, b) => (b.radius > a.radius ? b : a));
    match.parkShipAtDock(ship, furthest.dock);
    player.position = {
      x: furthest.dock.respawnPoint.x,
      y: furthest.dock.respawnPoint.y + 0.2,
      z: furthest.dock.respawnPoint.z,
    };
    player.onShipId = null;

    let diedAt = null;
    const steps = Math.ceil(SURVIVE_TO / DT);
    for (let i = 0; i < steps; i++) {
      match.tick();
      // He does nothing at all: no input is ever sent, the anchor stays down.
      if (player.state !== 'alive' || player.health <= 0) { diedAt = match.t; break; }
    }
    expect(`run ${run3}: still standing at T+5:00 on a ${furthest.radius.toFixed(0)} m pier`,
      diedAt === null && player.health > 0,
      diedAt === null ? `hp=${player.health.toFixed(0)}` : `died at t=${diedAt.toFixed(0)}s state=${player.state}`);
    expect(`run ${run3}: and his moored hull is still afloat under him`,
      ship.alive && !ship.sinking,
      `alive=${ship.alive} sinking=${ship.sinking} holes=${ship.holes.length}`);
    lastRing = { radius: match.state.storm.safeRadius, pier: furthest.radius };
  }
  // He did NOT survive because the weather stood still. By T+5:00 the opening
  // circle has closed a long way from its 950 m start — the pier is inside it
  // because the ring was SIZED to contain it, which is the whole fix. Without
  // this the two asserts above would still pass on a storm that never shrank.
  expect('the storm still means something — the ring really has closed by T+5:00',
    lastRing !== null && lastRing.radius < STORM_PHASES[0].startRadius,
    `radius=${lastRing?.radius.toFixed(0)} start=${STORM_PHASES[0].startRadius}`);
  expect('and he is inside it because it was sized to hold his pier',
    lastRing !== null && lastRing.pier < lastRing.radius,
    `pier=${lastRing?.pier.toFixed(0)} radius=${lastRing?.radius.toFixed(0)}`);
}

// ══ 3. The respawn hold converts when nobody is left to sail her ════════════
console.log('\nA marooned solo gets a countdown, not a black screen');
{
  const match = liveMatch('respawn-tow');
  const joined = match.addHumanClient(makeFakeWs(), 'Castaway');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);

  // Her crew is dead and she is adrift outside the wall. The ring is wound
  // forward by hand (the world is only 1000 m across, so "outside the OPENING
  // ring" is not a place a hull can physically be).
  const storm = closeTheRing(match, 300);
  ship.position.x = storm.centerX;
  ship.position.z = storm.centerZ + 600;
  ship.anchored = true;
  player.state = 'respawning';
  player.health = 0;
  player.respawnTimer = PLAYER.RESPAWN_TIME;
  player.onShipId = null;

  run(match, RESPAWN_HOLD_GRACE_SECONDS - 3);
  expect('inside the grace the hold still holds (a rescue may yet arrive)',
    player.state === 'respawning'
      && Math.abs(player.respawnTimer - PLAYER.RESPAWN_TIME) < 0.001
      && dist2D(ship.position.x, ship.position.z, match.state.storm.centerX, match.state.storm.centerZ) > match.state.storm.safeRadius,
    `timer=${player.respawnTimer.toFixed(2)}`);

  run(match, 5);
  const towedIn = dist2D(ship.position.x, ship.position.z, match.state.storm.centerX, match.state.storm.centerZ)
    <= match.state.storm.safeRadius - 5;
  expect('past the grace the tide brings the derelict inside the ring',
    towedIn && ship.alive && !ship.sinking,
    `d=${dist2D(ship.position.x, ship.position.z, match.state.storm.centerX, match.state.storm.centerZ).toFixed(0)} radius=${match.state.storm.safeRadius.toFixed(0)}`);
  expect('she comes in seaworthy and anchored, not adrift and holed',
    ship.anchored && ship.holes.length === 0 && (ship.waterLevel ?? 0) === 0,
    `anchored=${ship.anchored} holes=${ship.holes.length} water=${ship.waterLevel}`);
  expect('and the count is REAL — the timer is moving again',
    player.respawnTimer < PLAYER.RESPAWN_TIME && player.respawnTimer > 0,
    `timer=${player.respawnTimer.toFixed(2)}`);

  run(match, PLAYER.RESPAWN_TIME + 1);
  expect('he comes back aboard instead of dying of the wait',
    player.state === 'alive' && player.health > 0 && player.onShipId === ship.id,
    `state=${player.state} hp=${player.health}`);
}

// ── The hold is honest while a mate is still standing ──────────────────────
{
  const match = liveMatch('respawn-hold-kept');
  const a = match.addHumanClient(makeFakeWs(), 'Down');
  const b = match.addHumanClient(makeFakeWs(), 'Mate');
  const dead = match.state.players.find((p) => p.id === a.playerId);
  const mate = match.state.players.find((p) => p.id === b.playerId);
  const ship = match.state.ships.find((s) => s.id === a.shipId);
  // One crew, one hull: the mate is alive aboard her, outside the ring.
  mate.shipId = ship.id;
  mate.onShipId = ship.id;
  if (!ship.crewIds.includes(mate.id)) ship.crewIds.push(mate.id);
  const storm = closeTheRing(match, 300);
  ship.position.x = storm.centerX;
  ship.position.z = storm.centerZ + 600;
  mate.position = { x: ship.position.x, y: ship.position.y + 4, z: ship.position.z };
  dead.state = 'respawning';
  dead.health = 0;
  dead.respawnTimer = PLAYER.RESPAWN_TIME;

  const before = { x: ship.position.x, z: ship.position.z };
  run(match, RESPAWN_HOLD_GRACE_SECONDS + 6);
  expect('with a living mate aboard, the hold KEEPS holding (it is honest there)',
    dead.state === 'respawning' && Math.abs(dead.respawnTimer - PLAYER.RESPAWN_TIME) < 0.001,
    `state=${dead.state} timer=${dead.respawnTimer.toFixed(2)}`);
  expect('and nobody teleports a hull out from under a pirate who is standing on it',
    Math.abs(ship.position.x - before.x) < 60 && Math.abs(ship.position.z - before.z) < 60,
    `moved to (${ship.position.x.toFixed(0)}, ${ship.position.z.toFixed(0)})`);
}

// ══ 4. Skeletons earn nothing and never rank ════════════════════════════════
console.log('\nThe dead do not get paid');
{
  const match = liveMatch('skeleton-purse');
  const joined = match.addHumanClient(makeFakeWs(), 'Victim');
  const victim = match.state.players.find((p) => p.id === joined.playerId);
  const island = match.state.islands.find((i) => i.dock) ?? match.state.islands[0];
  match.spawnSkeletonWave(island, 1);
  const skeleton = match.state.players.find((p) => p.isBot && p.shipId === null);
  expect('a skeleton is on the board to be measured', !!skeleton);

  const goldBefore = skeleton.gold;
  victim.lastDamagedById = skeleton.id;
  victim.lastDamagedAt = match.t;
  victim.lastDamageWasHeadshot = true;
  match.handlePlayerDeath(victim);
  expect('a skeleton that cuts a pirate down banks NOTHING',
    skeleton.gold === goldBefore, `gold=${skeleton.gold}`);
  expect('nor does it collect the headshot purse',
    skeleton.gold === 0, `gold=${skeleton.gold}`);
  expect('and it does not score the kill either',
    skeleton.kills === 0, `kills=${skeleton.kills}`);

  // Hit gold rides the same rail.
  match.awardPlayerHitGold(skeleton.id, 40);
  expect('landing a blow pays a skeleton nothing', skeleton.gold === 0, `gold=${skeleton.gold}`);

  // The pirate's side of the ledger is untouched: skeletons are still worth gold.
  const hunter = match.state.players.find((p) => p.id === joined.playerId);
  hunter.state = 'alive';
  hunter.health = PLAYER.MAX_HEALTH;
  const hunterGold = hunter.gold;
  skeleton.lastDamagedById = hunter.id;
  skeleton.lastDamagedAt = match.t;
  match.handlePlayerDeath(skeleton);
  expect('killing a skeleton still pays the skeleton bounty (unchanged)',
    hunter.gold === hunterGold + PLAYER.SKELETON_KILL_GOLD,
    `${hunterGold} → ${hunter.gold} (+${PLAYER.SKELETON_KILL_GOLD} expected)`);

  // A skeleton could never take the match even if it somehow held a fortune.
  const rich = liveMatch('skeleton-cannot-win');
  const richIsland = rich.state.islands.find((i) => i.dock) ?? rich.state.islands[0];
  rich.spawnSkeletonWave(richIsland, 1);
  const richBones = rich.state.players.find((p) => p.isBot && p.shipId === null);
  richBones.gold = ECONOMY.GOLD_WIN_TARGET * 2;
  rich.checkWinCondition();
  expect('island scenery never wins the gold race',
    rich.state.phase === 'playing' && rich.state.winnerId === null,
    `phase=${rich.state.phase} winner=${rich.state.winnerId}`);
}

// ══ 5. The gold race has rivals ═════════════════════════════════════════════
console.log('\nThe 9000g race has an opposing racer');
{
  const match = liveMatch('bot-gold-win', 3);
  const sink = [];
  const human = match.addHumanClient(makeFakeWs(sink), 'Runner');
  const bot = match.state.players.find((p) => p.isBot && p.shipId !== null);
  expect('a bot crew is in the race', !!bot);

  bot.gold = ECONOMY.GOLD_WIN_TARGET - 1;
  match.checkWinCondition();
  expect('one coin short is not a win',
    match.state.phase === 'playing', `phase=${match.state.phase}`);

  bot.gold = ECONOMY.GOLD_WIN_TARGET;
  match.checkWinCondition();
  expect('a bot crew crossing the target TAKES the match',
    match.state.phase === 'ended' && match.state.winnerId === bot.id,
    `phase=${match.state.phase} winner=${match.state.winnerId} bot=${bot.id}`);
  expect('and the humans are told, by name, that the race was lost',
    sink.some((m) => m.type === 'game_over' && m.payload?.reason === 'gold' && m.payload?.winnerId === bot.id),
    sink.map((m) => m.type).join(','));
  expect('the human who did not win is not credited with the win',
    match.state.winnerId !== human.playerId);

  // The human path is untouched.
  const solo = liveMatch('human-gold-win', 1);
  const soloJoin = solo.addHumanClient(makeFakeWs(), 'Winner');
  const winner = solo.state.players.find((p) => p.id === soloJoin.playerId);
  winner.gold = ECONOMY.GOLD_WIN_TARGET;
  solo.checkWinCondition();
  expect('a human crossing the target still wins exactly as before',
    solo.state.phase === 'ended' && solo.state.winnerId === winner.id,
    `phase=${solo.state.phase} winner=${solo.state.winnerId}`);
}

// ══ 6. The guns learn the weather ═══════════════════════════════════════════
console.log('\nBot gunnery scales with the storm, not the clock');
{
  expect('the opening keeps its gentle bots (phase 0 is untouched)',
    botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, 0) === 1
      && botPhaseScale(BOT_CANNON_ACCURACY_BY_PHASE, 0) === 1);
  expect('the endgame fires about 40% faster than the opening',
    botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, STORM_PHASES.length - 1) <= 0.62,
    `late=${botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, STORM_PHASES.length - 1)}`);
  expect('cadence never gets slower as the ring closes',
    BOT_CANNON_CADENCE_BY_PHASE.every((v, i, a) => i === 0 || v <= a[i - 1]),
    BOT_CANNON_CADENCE_BY_PHASE.join(','));
  expect('accuracy tightens on the same schedule, and never to a sniper',
    BOT_CANNON_ACCURACY_BY_PHASE.every((v, i, a) => (i === 0 || v <= a[i - 1]) && v >= 0.6),
    BOT_CANNON_ACCURACY_BY_PHASE.join(','));
  expect('reading past the last phase clamps instead of falling off the table',
    botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, 99) === BOT_CANNON_CADENCE_BY_PHASE.at(-1)
      && botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, -3) === BOT_CANNON_CADENCE_BY_PHASE[0]);
}

// ══ 7. One sunset per match ═════════════════════════════════════════════════
console.log('\nThe sky is hung on the match, not on a free-running clock');
{
  const match = liveMatch('day-progress');
  expect('the arc is the real storm length', STORM_ARC_SECONDS > 600 && STORM_ARC_SECONDS < 900,
    `arc=${STORM_ARC_SECONDS}s`);
  run(match, 2);
  const early = match.state.matchProgress;
  expect('the match opens at the very start of the day',
    early !== undefined && early > 0 && early < 0.02, `progress=${early}`);
  run(match, 120);
  expect('progress advances with the storm clock',
    match.state.matchProgress > early
      && Math.abs(match.state.matchProgress - match.t / STORM_ARC_SECONDS) < 0.001,
    `progress=${match.state.matchProgress} t=${match.t.toFixed(0)}`);

  const wire = buildWireSnapshot(match.buildSnapshot(false), false);
  expect('and it rides the wire so the client can hang the sun on it',
    typeof wire.matchProgress === 'number' && wire.matchProgress === match.state.matchProgress,
    `wire=${wire.matchProgress}`);
  expect('it is a tiny field, not a float dump',
    JSON.stringify(wire.matchProgress).length <= 8, JSON.stringify(wire.matchProgress));

  // Overtime (a match that runs past the final ring) must not roll the sun back
  // up: the value clamps, so the sky can never wrap into a second dawn.
  match.t = STORM_ARC_SECONDS * 2;
  match.tick();
  expect('a match that outlives the arc stays at nightfall (no second dawn)',
    match.state.matchProgress === 1, `progress=${match.state.matchProgress}`);
}

if (failures > 0) {
  console.error(`\n${failures} storm-spawn-safety assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll storm-spawn-safety assertions passed.');
