#!/usr/bin/env node
// THE STORM MUST NOT OUTRUN THE BOAT, AND THE FIRST SAIL MUST CATCH WIND.
//
// The death carousel, measured by a fresh-eyes audit: the ring displaces 300–500 m
// every two minutes, it crossed the learner's spawn dock, and it killed him three
// times in three minutes — died six seconds after the wall arrived, respawned
// inside it, caught again. Two readings behind that:
//
//   1. THE HULL HAD NO ANSWER. The prevailing breeze was the same everywhere, so a
//      crew already caught outside the wall had nothing but its own canvas to
//      argue with — and the audit measured 1.26 u/s of canvas. The wind outside
//      the ring is now a gale out of the tempest blowing toward shelter
//      (sampleLocalWind), so running for the eye is genuinely fast.
//   2. THE FIRST SAIL CAUGHT NOTHING. A fresh berth hands you a SQUARE yard, which
//      on any reach catches almost none of the wind: "hold W to get under way"
//      plateaued at 0.3 u/s and decayed while bots auto-trimmed from tick one.
//      FIRST_SAIL_ASSIST hands the crew a working trim on the first anchor-up.
//
// Plus the two rails that make a respawn survivable at all: the reprieve is real
// weather immunity, and it is NOT combat immunity (or it would be a boarding tool).
//
//   node --import tsx scripts/test-storm-outrun.mjs
import { Match } from '../src/server/core/Match.ts';
import {
  FIRST_SAIL_ASSIST,
  PLAYER,
  SERVER_TICK_MS,
  SHIP,
  STORM_PHASES,
  STORM_RESPAWN_GRACE_SECONDS,
  STORM_TAILWIND,
} from '../src/shared/constants/index.ts';
import { angleWrap, dist2D, sampleWind, sampleLocalWind } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
const makeFakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });
const BLANK_INPUT = {
  crouch: false, seq: 0, ts: 0, forward: false, back: false, left: false, right: false,
  jump: false, jumpPressed: false, fire: false, useItem: false, aim: false,
  interact: false, interactHeld: false, anchor: false, sailRaise: false,
  sailLower: false, sailLeft: false, sailRight: false, trade: false, reload: false,
  placeKeg: false, dropChest: false, specialAttack: false, slot: null,
  cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null, selectMap: null,
};

function liveMatch(id, botCount = 0) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  return match;
}
function join(match, name = 'Skipper') {
  const joined = match.addHumanClient(makeFakeWs(), name);
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);
  const client = [...match.clients.values()].find((c) => c.playerId === player.id);
  return { player, ship, client };
}
/** Hold a set of keys for `seconds` of real ticks. */
function hold(match, client, keys, seconds) {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i++) {
    client.lastInput = { ...BLANK_INPUT, ...keys, seq: i, ts: Date.now() };
    match.tick();
  }
}
/** Park a small static ring on the origin — the only way to put a hull OUTSIDE
 *  the wall inside a 1000 m world. */
function closeTheRing(match, radius) {
  const s = match.state.storm;
  s.phase = 2;
  s.centerX = 0; s.centerZ = 0;
  s.nextCenterX = 0; s.nextCenterZ = 0;
  s.shrinkStartCenterX = 0; s.shrinkStartCenterZ = 0;
  s.shrinkStartRadius = radius;
  s.safeRadius = radius;
  s.nextRadius = radius;
  s.shrinking = false;
  s.shrinkTimer = 900;
  return s;
}
/** How much of the wind the yard is actually holding, by PhysicsSystem's rule. */
function catchOf(ship, wind) {
  const signedRelative = angleWrap(wind.direction - ship.rotation);
  const desired = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
  return 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desired)) / SHIP.MAX_SAIL_ANGLE);
}

// ══ 1. The gale only exists outside the wall ══════════════════════════════════
console.log('The wind is a local fact: prevailing inside, a gale out of the storm outside');
{
  const storm = { centerX: 0, centerZ: 0, safeRadius: 400 };
  const t = 137.5;
  const base = sampleWind(t);

  // Inside, to the last decimal: nobody sailing in shelter may feel a shove.
  for (const d of [0, 50, 200, 399.5]) {
    const local = sampleLocalWind(t, 0, d, storm);
    expect(`at ${d} m from the eye the wind is EXACTLY the prevailing breeze`,
      local.direction === base.direction && local.strength === base.strength && local.tailwind === 0,
      `dir ${local.direction} vs ${base.direction}, str ${local.strength} vs ${base.strength}, ramp ${local.tailwind}`);
  }
  // And with no storm at all (lobby, pre-match) it degrades to the plain breeze.
  const noStorm = sampleLocalWind(t, 900, 900, null);
  expect('with no ring in the world it is still just the breeze',
    noStorm.direction === base.direction && noStorm.strength === base.strength && noStorm.tailwind === 0);

  // Outside, the ramp climbs and the gale freshens.
  const full = storm.safeRadius * STORM_TAILWIND.FULL_AT_RADIUS_FRACTION;
  let prevRamp = 0;
  for (const out of [1, 10, full * 0.5, full, full * 3]) {
    const local = sampleLocalWind(t, 0, storm.safeRadius + out, storm);
    expect(`${out.toFixed(0)} m outside: the ramp has climbed and the wind has freshened`,
      local.tailwind > prevRamp - 1e-9 && local.strength > base.strength,
      `ramp ${local.tailwind.toFixed(3)} (was ${prevRamp.toFixed(3)}) str ${local.strength.toFixed(3)} vs ${base.strength.toFixed(3)}`);
    prevRamp = local.tailwind;
  }
  const saturated = sampleLocalWind(t, 0, storm.safeRadius + full * 3, storm);
  expect('the ramp saturates at 1 — a gale, not an ever-growing hurricane',
    saturated.tailwind === 1
      && Math.abs(saturated.strength - base.strength * (1 + STORM_TAILWIND.STRENGTH_BOOST)) < 1e-9,
    `ramp ${saturated.tailwind} str ${saturated.strength.toFixed(3)}`);

  // …and it blows TOWARD the eye, from every side of the ring.
  for (const bearing of [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5, 2.4, -2.4]) {
    const x = Math.sin(bearing) * 900;
    const z = Math.cos(bearing) * 900;
    const local = sampleLocalWind(t, x, z, { centerX: 0, centerZ: 0, safeRadius: 300 });
    const toEye = Math.atan2(-x, -z);
    const offBase = Math.abs(angleWrap(toEye - base.direction));
    const offGale = Math.abs(angleWrap(toEye - local.direction));
    expect(`from bearing ${(bearing * 57.3).toFixed(0)}° the gale points nearer the eye than the breeze did`,
      offGale <= offBase + 1e-9 && offGale <= (1 - STORM_TAILWIND.DIRECTION_AUTHORITY) * offBase + 1e-6,
      `off-eye ${offGale.toFixed(3)} rad vs breeze ${offBase.toFixed(3)}`);
  }
}

// ══ 2. A hull caught outside the wall can get home ════════════════════════════
console.log('\nA crew caught outside the wall can outrun it home');
{
  const match = liveMatch('outrun');
  const { player, ship, client } = join(match);
  const storm = closeTheRing(match, 300);
  const startD = 420;
  ship.position.x = 0;
  ship.position.z = startD;
  ship.position.y = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.rotation = Math.PI;      // bow at the eye
  ship.anchored = false;
  ship.sailHeight = 1;
  ship.sailAngle = 0;           // square — the trim a panicking learner has
  player.onShipId = ship.id;
  player.position = { x: ship.position.x, y: ship.position.y + 4, z: ship.position.z };
  player.health = PLAYER.MAX_HEALTH;

  let insideAt = null;
  let peak = 0;
  const steps = Math.ceil(90 / DT);
  for (let i = 0; i < steps; i++) {
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now(), yaw: Math.PI };
    match.tick();
    peak = Math.max(peak, Math.hypot(ship.velocity.x, ship.velocity.z));
    const d = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
    if (insideAt === null && d <= storm.safeRadius) insideAt = match.t;
    if (player.state === 'eliminated') break;
  }
  // The ring's own worst closing rate is the bar: a hull that cannot match it is
  // a hull the weather outruns, which is the whole defect.
  const ringRate = STORM_PHASES.reduce(
    (worst, p) => Math.max(worst, (p.startRadius - p.endRadius) / p.shrinkSec), 0);
  expect('she reaches shelter instead of dying at the wall',
    insideAt !== null && player.state !== 'eliminated',
    `insideAt=${insideAt} state=${player.state} d=${dist2D(ship.position.x, ship.position.z, 0, 0).toFixed(0)}`);
  expect('and she does it fast enough to beat the ring closing on her',
    peak >= ringRate,
    `peak ${peak.toFixed(2)} u/s vs ring ${ringRate.toFixed(2)} m/s`);
  expect('the crossing costs blood, not the crew — the gale is a chance, not a taxi',
    player.health < PLAYER.MAX_HEALTH && player.health > 0,
    `hp=${player.health.toFixed(1)}`);
  match.stop?.();
}

// ══ 3. Inside the ring nothing changed ════════════════════════════════════════
console.log('\nInside the ring the sailing model is untouched');
{
  const match = liveMatch('inside-control');
  const { player, ship, client } = join(match);
  closeTheRing(match, 900);
  ship.position.x = 0;
  ship.position.z = 300;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.rotation = Math.PI;
  ship.anchored = false;
  ship.sailHeight = 1;
  ship.sailAngle = 0;
  player.onShipId = ship.id;
  player.health = PLAYER.MAX_HEALTH;
  const before = { x: ship.position.x, z: ship.position.z };
  hold(match, client, { yaw: Math.PI }, 20);
  const local = sampleLocalWind(match.t, ship.position.x, ship.position.z, match.state.storm);
  expect('a hull in shelter feels no gale at all',
    local.tailwind === 0 && local.strength === sampleWind(match.t).strength,
    `ramp ${local.tailwind} str ${local.strength.toFixed(3)}`);
  expect('she is untouched by the weather in there',
    player.health === PLAYER.MAX_HEALTH, `hp=${player.health}`);
  expect('and she still sails (this is a control, not a becalming)',
    dist2D(ship.position.x, ship.position.z, before.x, before.z) > 1,
    `moved ${dist2D(ship.position.x, ship.position.z, before.x, before.z).toFixed(1)} m`);
  match.stop?.();
}

// ══ 4. The first sail catches wind ════════════════════════════════════════════
console.log('\nThe first sail catches wind without a lesson in bracing');
{
  const match = liveMatch('first-sail');
  const { player, ship, client } = join(match, 'Learner');
  expect('a fresh berth really does hand her a SQUARE yard (the trap is real)',
    Math.abs(ship.sailAngle) < 1e-6 && ship.anchored,
    `yard=${ship.sailAngle.toFixed(3)} anchored=${ship.anchored}`);

  player.onShipId = ship.id;
  player.atHelm = true;
  // Exactly what the objective tells a new captain to do, and nothing else.
  hold(match, client, { forward: true, yaw: ship.rotation }, 12);

  const wind = sampleLocalWind(match.t, ship.position.x, ship.position.z, match.state.storm);
  const trimCatch = catchOf(ship, wind);
  expect('holding [W] gets the anchor up', !ship.anchored, `anchored=${ship.anchored}`);
  expect('and the yard comes round with it — at least half the wind is held',
    trimCatch >= 0.5, `catch=${(trimCatch * 100).toFixed(0)}%`);
  expect('with canvas actually out',
    ship.sailHeight >= FIRST_SAIL_ASSIST.MIN_SAIL_HEIGHT - 1e-6,
    `sailHeight=${ship.sailHeight.toFixed(2)}`);
  expect('so she is genuinely under way, not creeping at the speed floor',
    Math.hypot(ship.velocity.x, ship.velocity.z) > 1,
    `v=${Math.hypot(ship.velocity.x, ship.velocity.z).toFixed(2)} u/s`);

  // ONCE per hull. A captain who squares the yard on purpose keeps what he set:
  // the assist is a first lesson, not a rudder that fights him all match.
  ship.sailAngle = 0;
  ship.anchored = true;
  ship.anchorRaiseProgress = 0;
  hold(match, client, { forward: true, yaw: ship.rotation }, 12);
  expect('the second anchor-up leaves the trim exactly where the captain put it',
    Math.abs(ship.sailAngle) < 1e-6, `yard=${ship.sailAngle.toFixed(3)}`);
  match.stop?.();
}
{
  // It only ever ADDS canvas — reefing is a real order, not a mistake to correct.
  const match = liveMatch('first-sail-reefed');
  const { player, ship, client } = join(match, 'Bosun');
  player.onShipId = ship.id;
  player.atHelm = true;
  ship.sailHeight = 0.95;
  hold(match, client, { forward: true, yaw: ship.rotation }, 6);
  expect('a hull already under full main is not reefed by the assist',
    ship.sailHeight >= 0.95, `sailHeight=${ship.sailHeight.toFixed(2)}`);
  match.stop?.();
}

// ══ 5. The reprieve you come back with ════════════════════════════════════════
console.log('\nA respawn inside the tempest gets seconds to make sail, and no more');
{
  const match = liveMatch('reprieve');
  const { player, ship } = join(match, 'Castaway');
  const storm = closeTheRing(match, 120);
  // Put the whole crew outside the wall: the respawn plan will land her in the
  // weather whatever it does, which is exactly the carousel's geometry.
  ship.position.x = 0;
  ship.position.z = 300;
  ship.anchored = true;
  player.onShipId = null;
  player.state = 'respawning';
  player.health = 0;
  player.respawnTimer = 1.5;

  const steps = Math.ceil((PLAYER.RESPAWN_TIME + 4) / DT);
  let spawnedAt = null;
  for (let i = 0; i < steps; i++) {
    match.tick();
    if (player.state === 'alive') { spawnedAt = match.t; break; }
  }
  expect('he comes back at all', spawnedAt !== null, `state=${player.state}`);
  const startHp = player.health;
  // Two thirds into the reprieve: the tempest has not touched him.
  const runFor = (seconds) => { for (let i = 0; i < Math.ceil(seconds / DT); i++) match.tick(); };
  runFor(STORM_RESPAWN_GRACE_SECONDS * 0.6);
  const outside = dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ) > storm.safeRadius;
  expect('inside the reprieve the storm bills him nothing',
    player.health >= startHp - 1e-6,
    `hp ${startHp.toFixed(1)} → ${player.health.toFixed(1)} (outside=${outside})`);
  expect('and he was NOT dropped outside the wall in the first place',
    !outside,
    `d=${dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ).toFixed(0)} radius=${storm.safeRadius}`);
  match.stop?.();
}
{
  // …AND NO MORE. The reprieve is a chance to make sail, not shelter: when it
  // lapses the tempest picks the bill straight back up.
  const match = liveMatch('reprieve-lapses');
  const { player, ship } = join(match, 'Castaway');
  const storm = closeTheRing(match, 120);
  ship.position.x = 0;
  ship.position.z = 300;
  ship.anchored = true;
  player.onShipId = null;
  player.state = 'alive';
  player.health = PLAYER.MAX_HEALTH;
  player.respawnProtectionTimer = 0;
  // Stand him in the weather with a fresh reprieve, exactly as a respawn does.
  player.position = { x: 0, y: 0.4, z: storm.safeRadius + 260 };
  match['grantStormRespawnGrace'](player);
  const runFor = (seconds) => { for (let i = 0; i < Math.ceil(seconds / DT); i++) match.tick(); };
  runFor(STORM_RESPAWN_GRACE_SECONDS * 0.6);
  const duringGrace = player.health;
  runFor(STORM_RESPAWN_GRACE_SECONDS * 0.6 + 4);
  expect('the reprieve really did hold the weather off while it lasted',
    duringGrace >= PLAYER.MAX_HEALTH - 1e-6, `hp=${duringGrace.toFixed(1)}`);
  expect('and once it lapses the storm bills him again',
    player.health < duringGrace - 0.5,
    `hp ${duringGrace.toFixed(1)} → ${player.health.toFixed(1)}`);
  // The reprieve OUTLIVES combat protection by design, which is precisely why it
  // may never BE combat protection: 15 s of "cannot be shot" every death is a
  // free boarding window for anyone willing to die for it. The two clocks are
  // separate — PLAYER.RESPAWN_PROTECTION_TIME is the one guns look at.
  expect('the weather reprieve is a different, longer clock than combat protection',
    STORM_RESPAWN_GRACE_SECONDS > PLAYER.RESPAWN_PROTECTION_TIME,
    `storm ${STORM_RESPAWN_GRACE_SECONDS}s vs combat ${PLAYER.RESPAWN_PROTECTION_TIME}s`);
  match.stop?.();
}

console.log(failures === 0
  ? '\nAll storm-outrun / first-sail checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
