#!/usr/bin/env node
// A CREW IS WORTH MORE THAN A PIRATE (BOTCREW-01 / bots-16, bots-03, gameplay-02A).
//
// Every bot hull carried exactly ONE pirate, so she had to choose between the
// gun, the plank and the bucket every tick — which is why nine crews could
// trade fire over the wreck for three minutes with 25 open breaches on the
// water and nobody going down. The crew model exists to make that choice a
// CREW's choice: the captain holds the wheel, a hand goes to the breach, and
// the guns keep speaking while he works.
//
// Contract, graded here:
//   1. two hands on one hull do NOT share a station (never two helmsmen);
//   2. while a two-hand crew is firing, the hand on damage control is FREE to
//      work — Match refuses the bucket and the plank to anyone the bot brain
//      reports as being at the guns, and that question is per BODY now;
//   3. one hand on the same hull, same breach, same enemy, is NOT free — she
//      still has to choose, which is the control that proves the result above
//      is the crew and not the clock.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
import { Match } from '../src/server/core/Match.ts';
import { BOT_EARLY_PEACE_SECONDS, SERVER_TICK_MS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

function openWaterSpot(islands, seaRocks, span) {
  const clearanceAt = (x, z) => {
    let clear = Infinity;
    for (const isl of islands) clear = Math.min(clear, Math.hypot(isl.position.x - x, isl.position.z - z) - (isl.radius ?? 0));
    for (const rock of seaRocks ?? []) clear = Math.min(clear, Math.hypot(rock.position.x - x, rock.position.z - z) - (rock.radius ?? 0));
    return clear;
  };
  let best = { x: 0, z: 0 };
  let bestClear = -Infinity;
  for (let x = -700; x <= 700; x += 50) {
    for (let z = -700; z <= 700; z += 50) {
      const clear = Math.min(clearanceAt(x, z), clearanceAt(x + span / 2, z), clearanceAt(x + span, z));
      if (clear > bestClear) { bestClear = clear; best = { x, z }; }
    }
  }
  return best;
}

const SPAN = 110;
const SECONDS = 30;

/** One hull with `hands` pirates, a breach in her side and an enemy abeam. */
function run(hands) {
  const match = new Match({ matchId: `crew-roles-${hands}`, botCount: 2 });
  const state = match.state;
  state.phase = 'playing';
  const [a, b] = state.ships;
  const captain = state.players.find((p) => p.shipId === a.id);
  const water = openWaterSpot(state.islands, state.seaRocks, SPAN);

  const crew = [captain];
  for (let n = 1; n < hands; n += 1) {
    const mate = match.createPlayer(`crew-mate-${n}`, `Mate_${n}`, a.id, true);
    mate.position = { ...captain.position };
    mate.position.x += 1.5;
    mate.onShipId = a.id;
    mate.state = 'alive';
    state.players.push(mate);
    if (Array.isArray(a.crewIds) && !a.crewIds.includes(mate.id)) a.crewIds.push(mate.id);
    match.bots.registerBot(mate, a, 'medium', 'deckhand');
    crew.push(mate);
  }

  // Powder through her planking, and a working party's worth of planks aboard.
  match.physics.openHoleAt(a, a.position.x + 2, a.position.y, a.position.z, 'cannon');
  a.waterLevel = Math.max(a.waterLevel ?? 0, 0.35);
  for (const hand of crew) hand.planks = 6;
  a.repairPlanks = Math.max(a.repairPlanks ?? 0, 8);

  const shots = new Map();
  const realTryFire = match.weapons.tryFire.bind(match.weapons);
  match.weapons.tryFire = (player, ship, yaw, pitch, cannonIndex, options) => {
    const before = ship?.cannonCooldowns?.[cannonIndex] ?? 0;
    const trace = realTryFire(player, ship, yaw, pitch, cannonIndex, options);
    if (ship && ship.cannonCooldowns[cannonIndex] !== before) shots.set(player.id, (shots.get(player.id) ?? 0) + 1);
    return trace;
  };

  const T0 = BOT_EARLY_PEACE_SECONDS + 60;
  let twoHelmsmen = 0;
  let sharedGun = 0;
  let freeWhileFiring = 0;
  let blockedWhileFiring = 0;
  for (let i = 0; i < Math.ceil(SECONDS / dt); i += 1) {
    a.position.x = water.x; a.position.z = water.z;
    b.position.x = water.x + SPAN; b.position.z = water.z;
    state.storm.centerX = water.x + SPAN / 2; state.storm.centerZ = water.z;
    state.storm.safeRadius = 4000; state.storm.shrinking = false; state.storm.phase = 3;
    // Driven by hand rather than through Match.tick(): the sim clock has to sit
    // past BOT_EARLY_PEACE_SECONDS for the guns to be free, and tick() owns its
    // own clock. Same three passes tick() runs, in the same order.
    const t = T0 + i * dt;
    match.t = t;
    match.bots.update(dt, t, state.players, state.ships, state.islands, state.storm, match.weapons, state.seaRocks);
    match.updateBotFlooding(dt);
    match.physics.updateShips(dt, t, state.ships, state.players, state.islands, state.seaRocks, state.storm);
    for (const ship of [a, b]) {
      for (let c = 0; c < ship.cannonCooldowns.length; c += 1) ship.cannonCooldowns[c] = Math.max(0, ship.cannonCooldowns[c] - dt);
    }
    const atHelm = crew.filter((p) => p.atHelm).length;
    if (atHelm > 1) twoHelmsmen += 1;
    const gunners = crew.filter((p) => p.atCannon).map((p) => p.cannonIndex);
    if (gunners.length > 1 && new Set(gunners).size < gunners.length) sharedGun += 1;
    // Is anybody free to work the breach while the guns are speaking?
    const firing = t - (match.bots.getCrew(a.id)?.lastFiredAt ?? -999) < 7;
    if (firing) {
      const workers = crew.filter((p) => !p.atHelm && !p.atCannon && !match.bots.isAtGuns(p.id, t));
      if (workers.length > 0) freeWhileFiring += 1; else blockedWhileFiring += 1;
    }
  }
  const fired = [...shots.values()].reduce((n, v) => n + v, 0);
  return { fired, freeWhileFiring, blockedWhileFiring, twoHelmsmen, sharedGun, water };
}

console.log(`A two-hand crew: one at the wheel, one at the breach, guns speaking (${SECONDS}s)`);
const pair = run(2);
console.log(`  · shots=${pair.fired} freeWhileFiring=${pair.freeWhileFiring} blocked=${pair.blockedWhileFiring}`
  + ` twoHelmsmenTicks=${pair.twoHelmsmen} sharedGunTicks=${pair.sharedGun}`);
expect('two bots never share a station (never two helmsmen on one wheel)', pair.twoHelmsmen === 0,
  `ticks with 2 helmsmen = ${pair.twoHelmsmen}`);
expect('two bots never work the same gun in one tick', pair.sharedGun === 0,
  `ticks sharing a cannon = ${pair.sharedGun}`);
expect('the crew keeps firing', pair.fired > 0, `shots=${pair.fired}`);
expect('and a hand is free for the breach on every tick the guns speak',
  pair.freeWhileFiring > 0 && pair.blockedWhileFiring === 0,
  `free=${pair.freeWhileFiring} blocked=${pair.blockedWhileFiring}`);

console.log('\nThe control: ONE hand on the same hull cannot do both');
const solo = run(1);
console.log(`  · shots=${solo.fired} freeWhileFiring=${solo.freeWhileFiring} blocked=${solo.blockedWhileFiring}`);
expect('a lone pirate is never free for the breach while her gun is speaking',
  solo.fired > 0 && solo.freeWhileFiring === 0 && solo.blockedWhileFiring > 0,
  `shots=${solo.fired} free=${solo.freeWhileFiring} blocked=${solo.blockedWhileFiring}`);

if (failures > 0) {
  console.error(`\n${failures} crew-role assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll crew-role assertions passed.');
