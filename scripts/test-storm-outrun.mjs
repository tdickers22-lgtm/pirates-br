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
import { StormSystem } from '../src/server/systems/StormSystem.ts';
import {
  FIRST_SAIL_ASSIST,
  PLAYER,
  SERVER_TICK_MS,
  SHIP,
  STORM_PHASES,
  STORM_RESPAWN_GRACE_SECONDS,
  STORM_TAILWIND,
} from '../src/shared/constants/index.ts';
import { STORM_GUST_BLOWOUT_SAIL_HEIGHT } from '../src/shared/utils/index.ts';
import {
  angleWrap,
  dist2D,
  finiteCircleBoundaryDistance,
  finiteClamp,
  sampleWind,
  sampleLocalWind,
} from '../src/shared/utils/index.ts';

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
/** The furthest-from-anything patch of sea in this map, and how clear it is.
 *
 *  Sailing claims have to be made somewhere no island can quietly answer them —
 *  AND INSIDE THE RING. The unbounded version of this picked the world corner at
 *  (−900, 900): 393 m of clear water, 1296 m from an eye with a 950 m safe radius,
 *  which is a hull in the tempest bleeding 9 hp and sailing the storm gale, not
 *  the prevailing breeze. `limit` keeps the search in shelter, where the ordinary
 *  sailing model is the thing under test. */
function clearWater(match, limit = 600) {
  const { centerX, centerZ } = match.state.storm;
  let best = { x: centerX, z: centerZ, clearance: -Infinity };
  for (let x = -900; x <= 900; x += 60) {
    for (let z = -900; z <= 900; z += 60) {
      if (dist2D(x, z, centerX, centerZ) > limit) continue;
      let clearance = Infinity;
      for (const i of match.state.islands) {
        clearance = Math.min(clearance, dist2D(i.position.x, i.position.z, x, z) - (i.radius ?? 0));
      }
      for (const r of match.state.seaRocks ?? []) {
        clearance = Math.min(clearance, dist2D(r.position.x, r.position.z, x, z) - (r.radius ?? 8));
      }
      if (clearance > best.clearance) best = { x, z, clearance };
    }
  }
  return best;
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

// ══ 0. A half-initialised camera cannot poison weather or Web Audio ══════════
console.log('Transient render poses stay finite at the weather/audio boundary');
expect('NaN weather falls back to calm instead of surviving an ordinary clamp',
  finiteClamp(Number.NaN, 0, 1, 0) === 0);
expect('infinite weather also falls back to calm',
  finiteClamp(Number.POSITIVE_INFINITY, 0, 1, 0) === 0);
expect('ordinary weather still clamps normally',
  finiteClamp(1.4, 0, 1, 0) === 1 && finiteClamp(0.42, 0, 1, 0) === 0.42);
expect('a non-finite camera pose reports no storm wall instead of NaN',
  finiteCircleBoundaryDistance(Number.NaN, 0, 0, 0, 950) === -1);
expect('a settled camera keeps the exact geometric wall distance',
  finiteCircleBoundaryDistance(0, 800, 0, 0, 950) === 150);

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
    noStorm.direction === base.direction && noStorm.strength === base.strength && noStorm.tailwind === 0
    && noStorm.gustPulse === 1);

  // Outside, the ramp climbs and the gale freshens.
  const full = storm.safeRadius * STORM_TAILWIND.FULL_AT_RADIUS_FRACTION;
  let prevRamp = 0;
  for (const out of [1, 10, full * 0.5, full, full * 3]) {
    const local = sampleLocalWind(t, 0, storm.safeRadius + out, storm);
    expect(`${out.toFixed(0)} m outside: the ramp has climbed and the wind has freshened`,
      local.tailwind > prevRamp - 1e-9 && local.meanStrength > base.strength,
      `ramp ${local.tailwind.toFixed(3)} (was ${prevRamp.toFixed(3)}) mean str ${local.meanStrength.toFixed(3)} vs ${base.strength.toFixed(3)}`);
    prevRamp = local.tailwind;
  }
  const saturated = sampleLocalWind(t, 0, storm.safeRadius + full * 3, storm);
  // Graded on the MEAN, not the instant: since storm-07 the sampled strength
  // carries the gust pulse (0.70..1.40) on top of the gale, and the gale is the
  // thing this contract is about.
  expect('the ramp saturates at 1 — a gale, not an ever-growing hurricane',
    saturated.tailwind === 1
      && Math.abs(saturated.meanStrength - base.strength * (1 + STORM_TAILWIND.STRENGTH_BOOST)) < 1e-9,
    `ramp ${saturated.tailwind} mean str ${saturated.meanStrength.toFixed(3)}`);

  // …and it blows TOWARD the eye, from every side of the ring.
  for (const bearing of [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5, 2.4, -2.4]) {
    const x = Math.sin(bearing) * 900;
    const z = Math.cos(bearing) * 900;
    const local = sampleLocalWind(t, x, z, { centerX: 0, centerZ: 0, safeRadius: 300 });
    const toEye = Math.atan2(-x, -z);
    const offBase = Math.abs(angleWrap(toEye - base.direction));
    const offGale = Math.abs(angleWrap(toEye - local.meanDirection));
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
  // The parked ring says phase 2, so it bills at phase 2 — closeTheRing only
  // moves the circle, and the opening 0.6 hp/s could not stove a plank in the
  // time this crossing takes, which is what the hull half of it grades.
  storm.damagePerSec = STORM_PHASES[1].dmgPerSec;
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
  let stormWork = 0;
  const steps = Math.ceil(90 / DT);
  for (let i = 0; i < steps; i++) {
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now(), yaw: Math.PI };
    match.tick();
    peak = Math.max(peak, Math.hypot(ship.velocity.x, ship.velocity.z));
    const d = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
    if (insideAt === null && d <= storm.safeRadius) insideAt = match.t;
    stormWork = Math.max(stormWork, ship.holes.length);
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
  // RE-PINNED BY STORM-01. This used to read "the crossing costs blood": the
  // weather billed the pirate on deck directly, which is the whole defect —
  // the crew died long before the hull did and the bail/repair fight never
  // happened. The crossing still costs, but it costs PLANKING: her crew comes
  // home whole and her hull comes home leaking. (Mutation proof: delete the
  // `this.hullsInTheWeather.add(ship.id)` line in StormSystem and this goes
  // red — nothing bills the hull either.)
  // RE-PINNED AGAIN BY STORMUP-01 (storm-04). The tempest can now light her
  // mainmast: a bolt down the conductor stoves a hole at the step AND sets the
  // mast alight, and a crew standing in that fire burns (cause 'fire', the same
  // as a firebomb, and now dousable by the rain). So the pin is no longer
  // "untouched health" — it is the thing STORM-01 actually established: the
  // GALE never bills the crew's health bar. A hull that comes home leaking and
  // scorched is the storm working; a pirate bled by cause 'storm' on a floating
  // deck is the defect. (Mutation proof: delete `this.hullsInTheWeather.add
  // (ship.id)` in StormSystem and stormWork goes to 0.)
  expect('the crossing costs planking, not blood — the gale is a chance, not a taxi',
    (player.lastEnvDamage?.cause ?? null) !== 'storm' && stormWork > 0,
    `hp=${player.health.toFixed(1)} cause=${player.lastEnvDamage?.cause ?? 'none'} holes=${ship.holes.length}`);
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
  match.stop?.();
}

// THE ASSIST HANDS YOU A YARD, NOT A HEADING — SO THE SPEED CLAIM CONTROLS BOTH.
//
// This check used to read the hull's speed straight off whichever berth the map
// RNG handed it, and failed 2 runs in 5. Two different reasons, both real and
// neither a threshold problem:
//
//   - ~40% of berths point the bow inside the 35° no-go cone, where a PERFECTLY
//     trimmed yard still only draws the 0.10 polar floor (1.3 u/s). That is the
//     designed shape of the sail model and the sail coach's in-irons line is the
//     answer to it, not a faster boat.
//   - Some berths sail her straight onto the beach she is moored at, where the
//     hull pins at 0.57 u/s (see the aground block below).
//
// The assist's promise is TRIM. So the trim is what the random berth tests, and
// the speed is tested where the claim is actually meaningful: open water, on a
// reach, with the heading set deliberately rather than drawn from a hat.
{
  const match = liveMatch('first-sail-reach');
  const { player, ship, client } = join(match, 'Reacher');
  // Open water, FOUND rather than guessed. The first draft of this put her on the
  // origin, which the fixed map sits an island squarely on top of — the clearance
  // check below caught it reading −96 m, and without that check the "she sails on
  // a reach" claim would have been a grounding wearing a pass.
  const berth = clearWater(match);
  ship.position.x = berth.x;
  ship.position.z = berth.z;
  expect('the reach test really is being sailed in open water',
    berth.clearance > 60, `nearest island edge ${berth.clearance.toFixed(0)} m`);
  // Beam-to-broad reach off the wind actually blowing, so the polar is not the
  // thing under test.
  const w0 = sampleLocalWind(match.t, berth.x, berth.z, match.state.storm);
  ship.rotation = angleWrap(w0.direction - Math.PI * 0.55);
  player.onShipId = ship.id;
  player.atHelm = true;
  hold(match, client, { forward: true, yaw: ship.rotation }, 12);
  const v = Math.hypot(ship.velocity.x, ship.velocity.z);
  expect('and on a reach, holding [W] and nothing else genuinely gets her going',
    v > 4, `v=${v.toFixed(2)} u/s (assist trim, no bracing keys touched)`);
  expect('with the yard the assist set, not one the captain had to find',
    catchOf(ship, sampleLocalWind(match.t, ship.position.x, ship.position.z, match.state.storm)) >= 0.5,
    `catch=${(catchOf(ship, w0) * 100).toFixed(0)}%`);
  expect('and she is sailing, not scraping — nothing on the wire says aground',
    !ship.aground, `aground=${ship.aground}`);
  match.stop?.();
}
{
  const match = liveMatch('first-sail');
  const { player, ship, client } = join(match, 'Learner');
  player.onShipId = ship.id;
  player.atHelm = true;
  hold(match, client, { forward: true, yaw: ship.rotation }, 12);

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

// ══ 4b. Aground: the third way to make no way, and the only silent one ════════
//
// THE NUMBER THE AUDIT MEASURED WAS A GROUNDING, NOT A BOAT SPEED. "1.26 u/s at
// best trim" is what a hull reads when her keel is on a shoal: PhysicsSystem
// skips the shove that frees her below 0.6 u/s (a moored hull must not jitter on
// her bedding), so a captain holding [W] into a beach settles into a stable limit
// cycle right on that threshold — sails drawing, trim 91%, not luffing, going
// nowhere. Neither existing coach line fits: bracing does nothing and there is no
// wind to steer off. So the wire carries `ship.aground`, and these are the three
// things that flag has to be true about, in order:
//
//   it is not on when she is merely moored, it IS on when she is held,
//   and the way out that the coach names actually works.
console.log('\nA hull held on the ground says so, and can still get off it');
// NAMED SHOALS, NOT "THE NEAREST ISLAND". The island set is fixed (test-world-fixed
// pins it); what was random was the BERTH this hull spawned at, and picking the
// island nearest to it meant every run beached her somewhere else — a steep rock
// one time, a gentle sandbar the next. That is a scenario that changes under the
// assertions, not a threshold that is too tight, and widening the numbers to cover
// both would have measured nothing. Three named shoals of different sizes instead,
// each in its own match so the wind is a function of the clock and nothing else.
for (const isleName of ['Gallows Sands', 'Mermaid\'s Folly', 'Crow\'s Perch']) {
  const match = liveMatch('aground');
  const { player, ship, client } = join(match, 'Grounder');
  const say = (label) => `${isleName}: ${label}`;

  // (i) A fresh berth is MOORED, not stuck. If this ever flipped, every player in
  // the game would be told they were aground on the tick they spawned.
  hold(match, client, {}, 2);
  expect(say('a hull lying at her own berth is moored, not aground'),
    !ship.aground, `aground=${ship.aground} anchored=${ship.anchored}`);

  // (ii) Put her keel on this shoal, beam-on to the wind, and hold [W]. `forward`
  // is the only key pressed — exactly what the objective tells a new captain to do.
  //
  // THE HEADING IS A BEAM REACH, ON PURPOSE, AND THE CONTACT IS SEARCHED FOR.
  // Approaching on whatever bearing the geometry gave meant roughly half the time
  // she arrived LUFFING — a fault the game already names, and not the silent pin
  // this block exists to catch. So the side is chosen off the wind, and the shoal
  // is found by walking in from clear water until the keel actually fouls.
  const isle = match.state.islands.find((i) => i.name === isleName);
  expect(say('the shoal is on the chart at all'), !!isle, `no island named ${isleName}`);
  if (!isle) { match.stop?.(); continue; }
  const wIsle = sampleLocalWind(match.t, isle.position.x, isle.position.z, match.state.storm);
  const approach = angleWrap(wIsle.direction + Math.PI * 0.5);
  player.onShipId = ship.id;
  player.atHelm = true;
  ship.anchored = false;
  ship.sailHeight = 1;
  // Trimmed the way the first-sail assist would have trimmed her. The assist fires
  // on anchor-up and this hull is being placed rather than sailed in, so without
  // this the yard stays SQUARE and the pin reads as a 9% catch — which is the
  // slack-yard fault the coach already names, not the silent one.
  const trimmed = Math.sin(angleWrap(wIsle.direction - approach))
    * SHIP.MAX_SAIL_ANGLE * FIRST_SAIL_ASSIST.TRIM_FRACTION;
  let beached = false;
  for (let r = (isle.radius ?? 60) + 30; r > 4 && !beached; r -= 3) {
    ship.position.x = isle.position.x - Math.sin(approach) * r;
    ship.position.z = isle.position.z - Math.cos(approach) * r;
    ship.position.y = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.rotation = approach;
    ship.sailAngle = trimmed;
    hold(match, client, { forward: true, yaw: approach }, 1);
    beached = !!ship.aground;
  }
  expect(say('a hull can be laid on this shoal at all (real keel contact, searched for)'),
    beached, `no contact found walking in to r=4`);
  // THE SEARCH IS SETUP, AND SETUP MAY NOT COST HER PLANKING. Walking in three
  // metres at a time grounds her at every step that touches, so by the time the
  // scenario proper began she was already carrying four breaches and 0.39 of
  // bilge — and on Mermaid's Folly she duly swamped forty seconds later while the
  // probe reported it as a failure to escape a shoal she had in fact escaped.
  // Hand the scenario a sound hull; the grounding it is about starts now.
  ship.holes = [];
  ship.waterLevel = 0;
  ship.floodingRate = 0;

  // The mistake itself: six seconds of holding [W] into it — long enough for the
  // coach pill to appear (FIRST_SAIL_ASSIST.COACH_AFTER_SECONDS is four) and be
  // acted on, which is the situation this whole block is about. Earlier drafts
  // held it for ten and then thirty and asked whether she was still afloat; she
  // was not, and she should not have been. Grounding is the harshest damage in
  // the game by design (four breaches on a steep shoal, ~0.04 of bilge a second),
  // so a captain who keeps the helm down for half a minute has decided to sink
  // the ship, and the flooding loop is entitled to oblige him.
  const grindFrom = { x: ship.position.x, z: ship.position.z };
  hold(match, client, { forward: true, yaw: approach }, 6);
  const grindRun = dist2D(ship.position.x, ship.position.z, grindFrom.x, grindFrom.z);
  const wind = sampleLocalWind(match.t, ship.position.x, ship.position.z, match.state.storm);

  // She is CHECKED, not welded. Before AGROUND_HELM_AUTHORITY and the resting
  // guard she sat here at 0.00–0.57 u/s permanently; now the sea keeps working her
  // off the bar while she is under canvas, so what the beach costs is most of her
  // way plus stove planking — a bad afternoon, not a soft lock.
  //
  // GROUND MADE GOOD, NOT INSTANTANEOUS SPEED: the velocity on any one tick swings
  // between 0.4 and 10 u/s while a hull is being worked off a bar. A beam reach in
  // open water covers ~60 m in these six seconds.
  expect(say('holding [W] into it takes most of the way off her'),
    grindRun < 27, `made ${grindRun.toFixed(0)} m in 6 s, against ~60 m free`);
  expect(say('and the pin is NOT luffing or a slack yard — the sails are drawing'),
    !ship.luffing && catchOf(ship, wind) >= 0.5,
    `luffing=${ship.luffing} catch=${(catchOf(ship, wind) * 100).toFixed(0)}%`);
  expect(say('so the wire says aground — the only thing left that can explain it'),
    ship.aground === true, `aground=${ship.aground} after ${grindRun.toFixed(0)} m in 6 s`);

  // (iii) THE COACH MAY NOT PROMISE AN ESCAPE THAT DOES NOT EXIST. The pill says
  // "hard over on [A] or [D] to swing her off the shoal", so hard over and then
  // steadying up has to work, using only the keys it names.
  //
  // It did not, before SHIP.AGROUND_HELM_AUTHORITY. A hull run onto a beach sits
  // at 0.00 u/s, the rudder only bites with way on, and 25 s of hard-over helm
  // bought 43° of swing while grounding breaches took her bilge from 0.31 to 0.84.
  // She drowned standing up, with no input that changed anything.
  //
  // "SWING HER OFF" MEANS UNTIL HER HEAD IS POINTING OUT, not until the flag
  // blinks. Stopping the helm on the first tick she floats leaves her aimed at
  // whatever she was aimed at, which on a small shoal is straight back onto it —
  // Gallows Sands re-grounded within the following twenty seconds when this loop
  // stopped early, and Crow's Perch came off pointing into the wind and made 3 m.
  const outward = () => Math.atan2(ship.position.x - isle.position.x, ship.position.z - isle.position.z);
  const headingOut = () => Math.abs(angleWrap(ship.rotation - outward())) < Math.PI / 3;
  let freedAfter = null;
  for (let sec = 1; sec <= 25; sec++) {
    hold(match, client, { forward: true, right: true, yaw: ship.rotation }, 1);
    if (freedAfter === null && !ship.aground) freedAfter = sec;
    if (freedAfter !== null && headingOut()) break;
  }
  expect(say('and hard over swings her off, exactly as the coach pill says'),
    freedAfter !== null && freedAfter <= 15,
    `still aground after 25 s of helm (bilge ${(ship.waterLevel ?? 0).toFixed(2)})`);
  expect(say('and the helm brings her head round to point at open water'),
    headingOut(),
    `heading ${(ship.rotation * 57.3).toFixed(0)}° vs outward ${(outward() * 57.3).toFixed(0)}°`);
  expect(say('and she is still afloat at the moment she comes off'),
    ship.alive && !ship.sinking,
    `alive=${ship.alive} sinking=${ship.sinking} bilge=${(ship.waterLevel ?? 0).toFixed(2)}`);

  // Then steady up and sail. Holding the helm over forever is not what the pill
  // says and it walks her straight round into irons — an earlier draft did exactly
  // that and read the resulting 0.7 u/s as a failure to escape.
  const offAt = dist2D(ship.position.x, ship.position.z, isle.position.x, isle.position.z);
  hold(match, client, { forward: true, yaw: ship.rotation }, 20);
  const clearAt = dist2D(ship.position.x, ship.position.z, isle.position.x, isle.position.z);
  // WHAT HAPPENS AFTER SHE IS OFF IS THE FLOODING LOOP, NOT THE GROUNDING. She
  // leaves with stove planking, and if nobody patches or bails she goes down some
  // thirty seconds later — that is the game working, and an earlier draft of this
  // check was effectively asserting that it should not. The claim here is only
  // that she is LEAVING: clearance grows and she does not settle back on the bar.
  expect(say('and steadying up genuinely takes her off the shoal, not along it'),
    clearAt - offAt > 10 && !ship.aground,
    `island clearance ${offAt.toFixed(1)} → ${clearAt.toFixed(1)} m in 20 s`
    + ` (free after ${freedAfter ?? '>20'} s), still aground=${ship.aground}`);
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


// ══ 6. THE STORM SINKS THE SHIP, IT DOES NOT ERASE THE CREW (STORM-01) ════════
//
// Measured on HEAD: a pirate standing on his own deck 60 m outside the phase-2
// wall died at 77 s while the hull he was standing on had taken FOUR holes and
// would have needed eight to founder. So the bail/repair fight the storm-hole
// model exists for never happened — the crew was dead first, every time, and
// the only counterplay the weather offered was a health bar. The tempest now
// bills the HULL: pirates aboard a floating hull take the hull's verdict, the
// water is where the storm kills people (x2), and exposure only bites a crew
// already at the end of her rope.
/** The fastest the wall may ever close on the hull it is chasing (gameplay-08).
 *  Half sail plus the storm gale makes 10.5 m/s; the ring must stay under it. */
const STORM_MAX_EDGE_SPEED = 8;
console.log('\nThe tempest bills the hull, not the crew standing on her');
{
  const match = liveMatch('storm-bills-the-hull');
  const { player, ship } = join(match, 'Bosun');
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = STORM_PHASES[1].dmgPerSec;
  ship.position.x = 0; ship.position.z = 360; ship.position.y = 0;
  ship.anchored = true;
  player.onShipId = ship.id;
  player.position = { x: ship.position.x, y: 2, z: ship.position.z };
  player.health = PLAYER.MAX_HEALTH;
  let wentDownAt = null;
  let hullLostAt = null;
  let holesPeak = 0;
  for (let i = 0; i < Math.ceil(90 / DT); i++) {
    match.tick();
    storm.damagePerSec = STORM_PHASES[1].dmgPerSec;
    holesPeak = Math.max(holesPeak, ship.holes.length);
    if (hullLostAt === null && (!ship.alive || ship.sinking)) hullLostAt = match.t;
    if (wentDownAt === null && (player.health <= 0 || player.state === 'downed'
      || player.state === 'eliminated' || player.state === 'respawning')) wentDownAt = match.t;
  }
  // THE CREW OUTLIVES THE HULL. On HEAD the pirate was dead at 67 s with his
  // ship afloat under him and four of the eight holes she needed to founder —
  // so plank patches, the bilge and hole-facing were all beside the point. Now
  // the only way the weather gets him is by taking his ship out from under him
  // first, which is a 70 s bail/repair fight he can actually win.
  expect('90 s at 60 m outside the phase-2 wall: the crew never goes down before the hull does',
    wentDownAt === null || (hullLostAt !== null && hullLostAt <= wentDownAt),
    `crew down at ${wentDownAt === null ? 'never' : wentDownAt.toFixed(0) + 's'}, `
    + `hull lost at ${hullLostAt === null ? 'never' : hullLostAt.toFixed(0) + 's'}`);
  expect('…and the hull has been stove in at least three times (the bail fight is real)',
    holesPeak >= 3,
    `peak holes ${holesPeak} alive=${ship.alive} sinking=${ship.sinking}`);
  match.stop?.();
}
{
  // The water is still lethal — that is where the storm kills people.
  const match = liveMatch('storm-kills-the-swimmer');
  const { player, ship } = join(match, 'Castaway');
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = STORM_PHASES[1].dmgPerSec;
  ship.position.x = 0; ship.position.z = 360; ship.anchored = true;
  player.onShipId = null;
  player.state = 'swimming';
  player.health = PLAYER.MAX_HEALTH;
  player.position = { x: 0, y: 0.4, z: 360 };
  let downAt = null;
  for (let i = 0; i < Math.ceil(90 / DT); i++) {
    match.tick();
    storm.damagePerSec = STORM_PHASES[1].dmgPerSec;
    if (downAt === null && (player.health <= 0 || player.state === 'eliminated'
      || player.state === 'downed' || player.state === 'respawning')) downAt = match.t;
  }
  expect('a swimmer in the same water is dead inside 90 s',
    downAt !== null && downAt <= 90,
    `downAt ${downAt === null ? 'never' : downAt.toFixed(0) + 's'} hp ${player.health.toFixed(1)}`);
  match.stop?.();
}

// The three rails below are graded on StormSystem itself: shelter and the
// hull-vs-pirate verdict are its contract, and a whole Match cannot state them
// without dragging PhysicsSystem's shelter bookkeeping in with it.
const stormAt = (radius, phase, dmgPerSec) => ({
  phase, centerX: 0, centerZ: 0, nextCenterX: 0, nextCenterZ: 0,
  shrinkStartCenterX: 0, shrinkStartCenterZ: 0, shrinkStartRadius: radius,
  safeRadius: radius, nextRadius: radius, shrinking: false, shrinkTimer: 900,
  shrinkDuration: 1, shrinkProgress: 0, damagePerSec: dmgPerSec,
});
const runStorm = (seconds, storm, ships, players, hooks) => {
  const system = new StormSystem();
  let holes = 0;
  const wrapped = { openHoleAt: (_s, _l, c) => { holes += c; }, ...hooks };
  const outer = { ...wrapped, openHoleAt: (s, l, c) => { holes += c; wrapped.openHoleAt?.(s, l, c); } };
  for (let i = 0; i < Math.ceil(seconds / DT); i++) system.update(DT, storm, ships, players, outer, i * DT);
  return holes;
};
const deckPlayer = (id, shipId, x, z, health = PLAYER.MAX_HEALTH) => ({
  id, state: 'alive', health, respawnProtectionTimer: 0, onShipId: shipId,
  position: { x, y: 2, z }, lastEnvDamage: null,
});
const hull = (id, type, x, z) => ({
  id, type, alive: true, sinking: false, rotation: 0, position: { x, y: 0, z },
});

console.log('\nShelter and the wall are read the same way for the hull and for her crew');
{
  // storm-20 / liveplay-v03: a moored hull under berth shelter took no damage
  // while the pirate standing on her lost half his health to the same weather.
  const storm = stormAt(300, 1, STORM_PHASES[1].dmgPerSec);
  const ship = hull('berthed', 'sloop', 0, 360);
  const player = deckPlayer('moored', 'berthed', 0, 360);
  const holes = runStorm(60, storm, [ship], [player], { isSheltered: () => true });
  expect('60 s in a sheltered berth: no holes AND no blood',
    holes === 0 && player.health === PLAYER.MAX_HEALTH,
    `holes ${holes} hp ${player.health.toFixed(1)}`);
}
{
  // storm-23: the ring is smaller than every hull in the endgame, so the crew
  // straddles the wall. Hull and crew must return the SAME verdict.
  const storm = stormAt(12, 6, STORM_PHASES[6].dmgPerSec);
  const ship = hull('straddler', 'galleon', 0, 9);
  const player = deckPlayer('sternwatch', 'straddler', 0, 20);
  const holes = runStorm(20, storm, [ship], [player], {});
  const bled = player.health < PLAYER.MAX_HEALTH - 1e-6;
  expect('a galleon straddling the final wall: either both take it or neither does',
    (holes > 0) === bled,
    `holes ${holes} hp ${player.health.toFixed(1)}`);
}
{
  // gameplay-08: the phase-2 wall closed on a half-sail sloop at up to 11.8 m/s
  // — faster than the storm gale could push her. Cap the drift so the worst
  // case the ring can ever produce stays inside what canvas can answer.
  const maxRng = new StormSystem(() => 1);
  let worst = { phase: 0, speed: 0 };
  for (let i = 1; i < STORM_PHASES.length; i++) {
    const current = STORM_PHASES[i - 1].endRadius;
    const next = STORM_PHASES[i];
    const centre = maxRng['pickNextSafeCenter'](0, 0, current, next.endRadius, next.shrinkSec);
    const drift = Math.hypot(centre.x, centre.z);
    const speed = (current - next.endRadius + drift) / next.shrinkSec;
    if (speed > worst.speed) worst = { phase: i + 1, speed };
  }
  expect('no phase can close its wall faster than 8 m/s on the hull it is chasing',
    worst.speed <= STORM_MAX_EDGE_SPEED + 1e-6,
    `worst phase ${worst.phase} at ${worst.speed.toFixed(2)} m/s (cap ${STORM_MAX_EDGE_SPEED})`);
}

// ══ 6. The gale is weather, not a conveyor belt (storm-07) ══════════════════
console.log('\nCanvas has to be watched: the gust blows a full press of sail out');
{
  // A hull hove to well outside the wall with everything set. The gust pulse
  // (0.70..1.40, 6-10 s beat, shared field) must eventually tear it out.
  const match = liveMatch('blowout');
  const { player, ship, client } = join(match);
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = 0;                 // grade the canvas, not the planking
  ship.position.x = 0; ship.position.z = 700; ship.position.y = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.rotation = Math.PI;
  ship.anchored = false;
  ship.sailHeight = 1;
  player.onShipId = ship.id;
  player.position = { x: 0, y: 4, z: 700 };
  let blowOuts = 0;
  let wasBlown = false;
  let minHeight = 1;
  for (let i = 0; i < Math.ceil(180 / DT); i++) {
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now(), yaw: Math.PI, sailRaise: true };
    match.tick();
    // Hold her outside: this case is about the canvas, not the passage.
    ship.position.z = 700;
    const blown = (ship.sailBlownOutUntil ?? 0) > match.t;
    if (blown && !wasBlown) blowOuts += 1;
    if (blown) minHeight = Math.min(minHeight, ship.sailHeight);
    wasBlown = blown;
  }
  expect('a crew that never reefs loses her canvas in the weather',
    blowOuts >= 1, `${blowOuts} blow-outs in 180 s`);
  expect('and while it is blown out the yard is held at a storm rag',
    blowOuts === 0 || minHeight <= STORM_GUST_BLOWOUT_SAIL_HEIGHT + 1e-6,
    `lowest deployment while blown ${minHeight.toFixed(2)} (cap ${STORM_GUST_BLOWOUT_SAIL_HEIGHT})`);
}
{
  // The same 180 s, the same weather, reefed. Reefing is the counterplay, so a
  // crew that shortens sail must NEVER blow one out.
  const match = liveMatch('blowout');
  const { player, ship, client } = join(match);
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = 0;
  ship.position.x = 0; ship.position.z = 700; ship.position.y = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.rotation = Math.PI;
  ship.anchored = false;
  player.onShipId = ship.id;
  player.position = { x: 0, y: 4, z: 700 };
  let blowOuts = 0;
  for (let i = 0; i < Math.ceil(180 / DT); i++) {
    ship.sailHeight = Math.min(ship.sailHeight, 0.5);   // reefed, every tick
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now(), yaw: Math.PI };
    match.tick();
    ship.position.z = 700;
    if ((ship.sailBlownOutUntil ?? 0) > match.t) blowOuts += 1;
  }
  expect('a reefing crew never blows one out — reefing IS the counterplay',
    blowOuts === 0, `${blowOuts} ticks blown out while reefed at 0.5`);
}
{
  // Inside the ring nothing changed: the gust ramps in with the tailwind, so
  // sheltered water is the old prevailing breeze to the last decimal.
  const inside = sampleLocalWind(123.4, 0, 100, { centerX: 0, centerZ: 0, safeRadius: 300 });
  const breeze = sampleWind(123.4);
  expect('inside the wall there is no gust at all',
    inside.direction === breeze.direction && inside.strength === breeze.strength
    && inside.gustPulse === 1);
}

// ══ 7. The storm is somewhere you would CHOOSE to go (storm-08) ═════════════
console.log('\nA burning crew has a reason to run INTO the weather');
{
  const match = liveMatch('douse');
  const { player, ship, client } = join(match);
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = 0;
  ship.position.x = 0; ship.position.z = 620; ship.position.y = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.anchored = true;
  ship.onFire = true;
  ship.fireTimer = SHIP.FIRE_DURATION;
  player.onShipId = ship.id;
  player.position = { x: 0, y: 4, z: 620 };
  let outAt = null;
  for (let i = 0; i < Math.ceil(30 / DT); i++) {
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now() };
    match.tick();
    ship.position.z = 620;
    if (outAt === null && !ship.onFire) outAt = match.t;
  }
  expect('a burning hull out in the rain is extinguished within 10 s',
    outAt !== null && outAt <= 10,
    `out at ${outAt === null ? 'never' : outAt.toFixed(1)} s (dry burn is ${SHIP.FIRE_DURATION} s)`);
}
{
  // The control: the same fire, in shelter. Rain is the mechanism, not time.
  const match = liveMatch('douse');
  const { player, ship, client } = join(match);
  const storm = closeTheRing(match, 300);
  storm.damagePerSec = 0;
  ship.position.x = 0; ship.position.z = 40; ship.position.y = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.anchored = true;
  ship.onFire = true;
  ship.fireTimer = SHIP.FIRE_DURATION;
  player.onShipId = ship.id;
  player.position = { x: 0, y: 4, z: 40 };
  let outAt = null;
  for (let i = 0; i < Math.ceil(12 / DT); i++) {
    client.lastInput = { ...BLANK_INPUT, seq: i, ts: Date.now() };
    match.tick();
    ship.position.z = 40;
    if (outAt === null && !ship.onFire) outAt = match.t;
  }
  expect('the same fire inside the ring is still burning at 12 s — it is the RAIN',
    outAt === null, `out at ${outAt === null ? 'never' : outAt.toFixed(1)} s`);
}

console.log(failures === 0
  ? '\nAll storm-outrun / first-sail checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
