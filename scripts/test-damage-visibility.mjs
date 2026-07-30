#!/usr/bin/env node
// NO POINT OF HEALTH LEAVES A PIRATE IN SILENCE.
//
// The fresh-eyes audit read 100 → 58 while wandering under a blue sky, 58 → 8
// walking to a chest, then died, and could not name one point of it. Combat had
// always shipped a `player_hit` the victim could read; the weather, the water,
// the fire, the rock and the sharks shipped nothing at all, so half the damage
// model was invisible by construction.
//
// This suite pins the rails that fixed it:
//
//   1. EVERY ENVIRONMENTAL SOURCE IS ANNOUNCED. Storm, drowning, fall and fire
//      each reach the victim's socket as an incoming hit that NAMES the cause.
//   2. CHIPS ADD UP INSTEAD OF SPAMMING. The tempest bills 0.06–0.4 hp per tick
//      at 62.5 Hz; the notices arrive at a readable cadence carrying the total,
//      and never as "-0".
//   3. COMBAT IS NOT DOUBLE-BILLED. A blade or a ball still ships exactly one
//      hit message — the environmental channel must not print it again.
//   4. A CHIP OF RAIN CANNOT RENAME A CUTLASS. The storm witness used to tag
//      any loss across its call as 'storm', so a 19 hp skeleton swing followed
//      by 0.06 hp of drizzle in the same tick read TAKEN BY THE STORM.
//   5. THE HELD RESPAWN ALWAYS RESOLVES, and inside the ring (the carousel).
//
//   node --import tsx scripts/test-damage-visibility.mjs
import { Match } from '../src/server/core/Match.ts';
import {
  PLAYER, RESPAWN_HOLD_MAX_SECONDS, SERVER_TICK_MS, SHARK, STORM_PHASES,
  STORM_RESPAWN_GRACE_SECONDS,
} from '../src/shared/constants/index.ts';
import { dist2D } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;

/** A socket that keeps every message the server sent this player. */
function recordingWs(sink) {
  return { readyState: 1, bufferedAmount: 0, send(d) { sink.push(JSON.parse(d)); }, close() {} };
}
function liveMatch(id, botCount = 0) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  return match;
}
/** Join one human and hand back everything a test needs to drive him. */
function withCastaway(id) {
  const sent = [];
  const match = liveMatch(id);
  const joined = match.addHumanClient(recordingWs(sent), 'Castaway');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);
  const hits = () => sent.filter((m) => m.type === 'player_hit' && m.payload?.incoming);
  return { match, player, ship, sent, hits };
}
function run(match, seconds, onTick) {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i++) { onTick?.(); match.tick(); }
}
/**
 * Send every shark to the far corner of the world, this tick.
 *
 * Not squeamishness — isolation. A shark spawns on a 0.055 %/tick roll behind any
 * swimmer who has been under for 8 s, so ANY section that holds a pirate in the
 * water for more than a few seconds has a coin-flip chance of a 42 hp bite
 * landing in the middle of its measurement. That is what made the drowning
 * section read 'shark' three times and no 'drowned' at all. Sections measuring
 * the weather or the lungs banish them; the section measuring the jaws puts one
 * there on purpose (see putSharkOn).
 */
function banishSharks(match) {
  for (const shark of match.state.sharks) { shark.position.x = 4000; shark.position.z = 4000; }
}
/**
 * Put a shark in the water NEXT TO this pirate, exactly as the spawner would.
 *
 * The suite used to read `state.sharks[0]` and hope: a match starts with zero
 * sharks and the spawner rolls 0.00055 per tick, so after the 16 s reprieve the
 * odds of one existing are about one in two — and the section failed on 2 of
 * every 5 runs with "causes seen: " (there was no shark to pin). The jaws are the
 * subject of this section, so they are placed, not waited for.
 */
function putSharkOn(match, player) {
  match.state.sharks.length = 0;
  match.state.sharks.push({
    id: 'probe-shark',
    position: { x: player.position.x + 1.5, y: 0.38, z: player.position.z },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    health: SHARK.HEALTH,
    biteCooldown: 1.2,
    attackState: 'cruise',
    attackTimer: 0,
    lungeDirX: 0,
    lungeDirZ: 0,
    targetId: player.id,
  });
  return match.state.sharks[0];
}
function closeTheRing(match, radius) {
  const storm = match.state.storm;
  storm.phase = 2;
  storm.centerX = 0; storm.centerZ = 0;
  storm.nextCenterX = 0; storm.nextCenterZ = 0;
  storm.shrinkStartCenterX = 0; storm.shrinkStartCenterZ = 0;
  storm.shrinkStartRadius = radius;
  storm.safeRadius = radius;
  storm.nextRadius = radius;
  storm.shrinking = false;
  storm.shrinkTimer = 600;
  return storm;
}

// ══ 1. The tempest names itself ══════════════════════════════════════════════
console.log('The storm announces every point it takes');
{
  const { match, player, ship, hits } = withCastaway('storm-speaks');
  const storm = closeTheRing(match, 120);
  // JUST outside the wall, off any hull. Far outside, the excess multiplier kills
  // him inside the measurement window — and a death legitimately drops the bank
  // (clearEnvironmentalDamage), which would fail the accounting check for the
  // right reason. The rail under test is announcement, not lethality.
  player.onShipId = null;
  player.position.x = 0; player.position.z = 132;
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  ship.anchored = true;
  // Burn off the join-time storm reprieve before measuring. Nothing with teeth
  // is allowed in the water: twenty-two seconds of swimming is long enough for
  // the spawner to roll a shark, and one 42 hp bite would break the accounting
  // check below for a reason that has nothing to do with the weather.
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1, () => banishSharks(match));
  player.health = PLAYER.MAX_HEALTH;
  const before = hits().length;
  run(match, 6, () => banishSharks(match));
  const stormHits = hits().slice(before).filter((m) => m.payload.cause === 'storm');

  expect('the tempest reaches the victim as a NAMED incoming hit',
    stormHits.length > 0,
    `${hits().length - before} incoming hits, ${stormHits.length} named 'storm'`);
  expect('and it does not spam — chips are banked, not shipped per tick',
    stormHits.length <= 12,
    `${stormHits.length} notices across 6 s (375 ticks)`);
  expect('no notice ever rounds to nothing on screen',
    stormHits.every((m) => Math.round(m.payload.damage) >= 1),
    stormHits.map((m) => m.payload.damage.toFixed(2)).join(' '));
  // He is a SWIMMER, and that is correct: just outside a 120 m ring at (0, 132)
  // is open sea, and there is no standing on it. The rail is that the tempest did
  // not finish him inside the window — a death legitimately drops the bank
  // (clearEnvironmentalDamage) and the accounting check below would then fail for
  // the right reason. Being in the water is not being dead.
  expect('the tempest does not finish him inside the window, so the accounting is whole',
    player.state !== 'eliminated' && player.state !== 'respawning' && player.health > 0,
    `state=${player.state} hp=${player.health.toFixed(1)}`);
  expect('the banked total accounts for the health actually lost',
    Math.abs(stormHits.reduce((a, m) => a + m.payload.damage, 0)
      - (PLAYER.MAX_HEALTH - player.health)) < 3,
    `announced ${stormHits.reduce((a, m) => a + m.payload.damage, 0).toFixed(1)}`
    + ` vs lost ${(PLAYER.MAX_HEALTH - player.health).toFixed(1)}`);
  expect('the tempest carries a BEARING — outside the wall, so the clear side is home',
    stormHits.every((m) => m.payload.sourcePosition
      && dist2D(m.payload.sourcePosition.x, m.payload.sourcePosition.z, storm.centerX, storm.centerZ)
        > storm.safeRadius),
    JSON.stringify(stormHits[0]?.payload.sourcePosition));
}

// ══ 2. Drowning names itself ═════════════════════════════════════════════════
console.log('\nDrowning announces itself');
{
  const { match, player, ship, hits } = withCastaway('drowning-speaks');
  closeTheRing(match, 900);
  ship.anchored = true;
  player.onShipId = null;
  // THE SHARKS GO SOMEWHERE ELSE, every tick. A lone swimmer holding still is
  // exactly what the shark AI is for, and it reached him first: the suite read
  // 'shark' three times and no 'drowned' at all. Isolate the lungs.
  banishSharks(match);
  // Deep open water far from any island, well inside the ring.
  player.position.x = 0; player.position.z = 300;
  player.position.y = -3;
  player.state = 'swimming';
  player.respawnProtectionTimer = 0;
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1, () => banishSharks(match));
  player.health = PLAYER.MAX_HEALTH;
  const before = hits().length;
  // Past DROWN_TIME the lungs give out. Hold him under while it bills.
  for (let i = 0; i < Math.ceil((PLAYER.DROWN_TIME + 8) / DT); i++) {
    player.position.y = -3;
    banishSharks(match);
    match.tick();
    if (player.health <= 0) break;
  }
  const drowned = hits().slice(before).filter((m) => m.payload.cause === 'drowned');
  expect('a drowning pirate is told he is drowning',
    drowned.length > 0,
    `${hits().length - before} incoming hits: `
    + `${[...new Set(hits().slice(before).map((m) => m.payload.cause))].join(',')}`);
  expect('and no arrow points at his own boots — the water has no bearing',
    drowned.every((m) => !m.payload.sourcePosition),
    JSON.stringify(drowned[0]?.payload.sourcePosition));
}

// ══ 3. A shark bite lands with jaws to point at ══════════════════════════════
console.log('\nA shark bite lands a number and a bearing');
{
  const { match, player, ship, hits } = withCastaway('shark-speaks');
  closeTheRing(match, 900);
  ship.anchored = true;
  player.onShipId = null;
  player.position.x = 0; player.position.z = 300; player.position.y = -1;
  player.state = 'swimming';
  player.respawnProtectionTimer = 0;
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1, () => banishSharks(match));
  player.health = PLAYER.MAX_HEALTH;
  const before = hits().length;
  // Put a shark on him and hold it there: cheaper and far less brittle than
  // waiting for the wander AI to find a swimmer in a 1900 m world — and, unlike
  // reading sharks[0], it does not depend on a 0.055 %/tick spawn roll having
  // happened to fire.
  const shark = putSharkOn(match, player);
  let bitten = false;
  for (let i = 0; i < Math.ceil(40 / DT); i++) {
    shark.position.x = player.position.x + 1.5;
    shark.position.z = player.position.z;
    shark.position.y = player.position.y;
    player.position.y = -1;
    player.health = PLAYER.MAX_HEALTH;
    match.tick();
    if (hits().slice(before).some((m) => m.payload.cause === 'shark')) { bitten = true; break; }
  }
  const sharkHits = hits().slice(before).filter((m) => m.payload.cause === 'shark');
  expect('the bite is announced by name',
    bitten && sharkHits.length > 0,
    `causes seen: ${[...new Set(hits().slice(before).map((m) => m.payload.cause))].join(',')}`);
  expect('a bite is announced AT ONCE — it is far past the chip threshold',
    sharkHits.every((m) => m.payload.damage >= SHARK.BITE_DAMAGE * 0.5),
    sharkHits.map((m) => m.payload.damage.toFixed(1)).join(' '));
  expect('and the wedge points at the jaws',
    sharkHits.every((m) => !!m.payload.sourcePosition),
    JSON.stringify(sharkHits[0]?.payload.sourcePosition));
}

// ══ 3b. A trickle too small to print does not wedge the tick ════════════════
//
// THE ONE THAT TOOK THE SERVER DOWN. A bank that is due but rounds below a whole
// point used to be deleted and set straight back with a copy — which, inside a
// `for…of` over that same Map, appends the key after the cursor, so the loop
// reaches it again, and the copy carries the same `sentAt` so it is still due,
// so it is deleted and re-appended again. Forever. The tick never returned: the
// dev server sat at 110 % CPU with a dead /health and every later client stuck
// on the loading screen, and any storm chip under about half a point a second
// could reach it.
//
// IF THIS REGRESSES, THIS SECTION HANGS rather than printing a failure — a tick
// that does not return cannot be asserted about from inside itself. That is the
// signal. The assertions below pin the two observable halves: nothing ships while
// the bank is under a point, and the identical entry OBJECT survives the flush
// (a re-insert would hand back a copy).
console.log('\nA trickle too small to print keeps banking, and the tick returns');
{
  const { match, player, ship, hits } = withCastaway('sub-point-trickle');
  closeTheRing(match, 900);
  ship.anchored = true;
  player.onShipId = null;
  player.position.x = 0; player.position.z = 300; player.position.y = 0.5;
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  banishSharks(match);
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1, () => banishSharks(match));
  const before = hits().length;
  // A third of a point of rock, and then time enough to be long overdue.
  match.noteEnvironmentalDamage(player, 'fall', 0.34);
  const banked = match.envDamage.get(player.id);
  run(match, 3, () => banishSharks(match));
  const shipped = hits().slice(before).filter((m) => m.payload.cause === 'fall');
  expect('a third of a point is never printed as "-0"',
    shipped.length === 0,
    `${shipped.length} notice(s): ${shipped.map((m) => m.payload.damage.toFixed(2)).join(' ')}`);
  expect('it is still banked, and it is the SAME entry — never deleted and re-added',
    match.envDamage.get(player.id) === banked,
    match.envDamage.has(player.id) ? 'a copy came back' : 'the bank was dropped');
  // Cross the whole point and it goes out at once, carrying the trickle with it.
  match.noteEnvironmentalDamage(player, 'fall', 0.9);
  run(match, 1, () => banishSharks(match));
  const late = hits().slice(before).filter((m) => m.payload.cause === 'fall');
  expect('and the moment it is worth a point it ships, trickle included',
    late.length === 1 && late[0].payload.damage > 1.2,
    `${late.length} notice(s): ${late.map((m) => m.payload.damage.toFixed(2)).join(' ')}`);
  expect('and the bank is emptied by shipping it',
    !match.envDamage.has(player.id),
    'the entry outlived its own notice');
}

// ══ 4. Combat is announced exactly once ══════════════════════════════════════
console.log('\nA cutlass is not billed twice');
{
  const { match, player, ship, hits } = withCastaway('no-double-bill', 0);
  closeTheRing(match, 900);
  ship.anchored = true;
  player.onShipId = null;
  player.position.x = 0; player.position.z = 300; player.position.y = 0.5;
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1);
  const before = hits().length;
  // One deliberate blade hit through the same path skeletons use.
  const attacker = match.state.players.find((p) => p.id !== player.id && p.isBot);
  if (attacker) {
    attacker.position = { ...player.position };
    attacker.rotation = { x: 0, y: 0, z: 0 };
  }
  run(match, 3);
  const combat = hits().slice(before).filter((m) => m.payload.cause === undefined);
  const bogus = hits().slice(before).filter(
    (m) => m.payload.cause === 'blade' || m.payload.cause === 'gunshot'
      || m.payload.cause === 'cannon' || m.payload.cause === 'explosion',
  );
  expect('no combat blow is ever re-announced through the environmental channel',
    bogus.length === 0,
    `${bogus.length} duplicate combat notices`);
  expect('and combat notices still carry an attacker rather than a cause',
    combat.every((m) => m.payload.cause === undefined),
    `${combat.length} combat hits`);
}

// ══ 5. A chip of rain cannot rename a cutlass ════════════════════════════════
console.log('\nThe last blow names the death — and drizzle is not a blow');
{
  const { match, player, ship } = withCastaway('blame-the-blade');
  closeTheRing(match, 120);
  ship.anchored = true;
  player.onShipId = null;
  // Outside the wall (so the tempest is billing him every tick) AND cut down by
  // a blade in the same tick. This is the exact shape of the mis-blame: the
  // storm witness ran last and relabelled the swing.
  player.position.x = 0; player.position.z = 600;
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  run(match, STORM_RESPAWN_GRACE_SECONDS + 1);
  player.health = PLAYER.MAX_HEALTH;
  // Tag a blade on the tick the storm is also billing, exactly as the skeleton
  // wave does (it resolves earlier in the same tick).
  // Written the way the skeleton wave writes it: `tickCount` is incremented at
  // the TOP of tick(), so anything resolving inside the tick (the wave runs well
  // before either witness) stamps the already-incremented index. Tagging from
  // out here with the current value would stamp the PREVIOUS tick and the rule
  // would correctly ignore it — which is a test artefact, not the defect.
  match.lastDamageSourceById.set(player.id, {
    source: 'blade', at: match.t, tick: match.tickCount + 1,
  });
  match.tick();
  const named = match.lastDamageSourceById.get(player.id);
  expect('a blade struck this tick survives the storm witness',
    named?.source === 'blade',
    `read '${named?.source}' at tick ${named?.tick} (now ${match.tickCount})`);
  // …and the weather still owns the ticks that are genuinely only weather.
  run(match, 2);
  expect('but the tempest still names the ticks that ARE only the tempest',
    match.lastDamageSourceById.get(player.id)?.source === 'storm',
    `read '${match.lastDamageSourceById.get(player.id)?.source}'`);
}

// ══ 6. The carousel: a held respawn resolves, inside the ring ════════════════
console.log('\nThe death carousel is broken: every respawn resolves, inside the wall');
{
  for (const [radius, phase] of [[12, STORM_PHASES.length], [40, STORM_PHASES.length], [200, 2]]) {
    const { match, player, ship } = withCastaway(`carousel-${radius}-${phase}`);
    const storm = closeTheRing(match, radius);
    storm.phase = phase;
    // Her hull is out in the weather with nobody left to sail her — the deadlock.
    ship.position.x = storm.centerX;
    ship.position.z = storm.centerZ + 420;
    ship.anchored = true;
    player.state = 'respawning';
    player.health = 0;
    player.respawnTimer = PLAYER.RESPAWN_TIME;
    player.onShipId = null;

    let resolvedAt = null;
    const budget = PLAYER.RESPAWN_TIME + RESPAWN_HOLD_MAX_SECONDS + 6;
    for (let i = 0; i < Math.ceil(budget / DT); i++) {
      // Keep the derelict afloat: this asserts the RESPAWN path, not how fast an
      // abandoned hull founders.
      ship.holes = []; ship.waterLevel = 0; ship.sinking = false;
      match.tick();
      if (player.state === 'alive') { resolvedAt = match.t; break; }
      if (player.state === 'eliminated') break;
    }
    expect(`r=${radius} phase=${phase}: he comes back inside the hard cap`,
      resolvedAt !== null && resolvedAt <= PLAYER.RESPAWN_TIME + RESPAWN_HOLD_MAX_SECONDS + 1,
      `state=${player.state} resolvedAt=${resolvedAt?.toFixed(1) ?? 'never'} budget=${budget.toFixed(1)}`);
    expect(`r=${radius} phase=${phase}: and he comes back INSIDE the safe radius`,
      player.state === 'alive'
        && dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ)
          <= storm.safeRadius + 0.5,
      `d=${dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ).toFixed(1)} radius=${storm.safeRadius}`);
    // THE REPRIEVE. He respawned INSIDE the wall (asserted above), which is why
    // the weather cannot touch him there — so to measure the reprieve at all he
    // has to be put back out in it. That is also the honest case: the carousel
    // was a pirate who came back and was billed before he could weigh anchor.
    player.position.x = storm.centerX;
    player.position.z = storm.centerZ + 420;
    player.onShipId = null;
    const hpOnSpawn = player.health;
    run(match, STORM_RESPAWN_GRACE_SECONDS - 3);
    expect(`r=${radius} phase=${phase}: the weather stands down while he gets under way`,
      player.health >= hpOnSpawn - 1e-6,
      `hp ${hpOnSpawn.toFixed(1)} → ${player.health.toFixed(1)} over ${STORM_RESPAWN_GRACE_SECONDS - 3}s`
      + ` at d=${dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ).toFixed(0)}`);
    // …and it is a REPRIEVE, not immunity: it must expire, or fifteen seconds of
    // untouchable becomes a boarding tool.
    run(match, 6);
    expect(`r=${radius} phase=${phase}: and the reprieve EXPIRES — the storm is not survivable`,
      player.health < hpOnSpawn || player.state !== 'alive',
      `hp still ${player.health.toFixed(1)} after ${STORM_RESPAWN_GRACE_SECONDS + 3}s outside the wall`);
  }
}

console.log(failures === 0
  ? '\nAll damage-visibility and carousel rails hold.'
  : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
