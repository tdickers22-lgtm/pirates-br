#!/usr/bin/env node
// A BOT HELMSMAN IS A HELMSMAN (BOTCREW-01 / bots-v02, bots-06).
//
// Nobody was ever at the wheel of a bot hull. BotSystem steered by writing
// ship.rudderAngle and never set player.atHelm, so PhysicsSystem counted every
// bot ship as UN-HELMED and applied the un-helmed decay (RUDDER_DECAY 4.1)
// to her angular velocity every tick. With RUDDER_SLEW 3.25 that pins the
// steady-state at ~0.43x the commanded rate, and on top of it bots passed
// omegaCapScale 0.36 + 0.52*sail (<= 0.88) where a human at the wheel passes
// 0.5 + 0.5*sail (1.0 at full canvas): a bot at full sail answered her helm at
// about 0.38x a player on the same hull. That is why she needed a 90 m orbit,
// and why "seamanship tiers" could not be tuned honestly — the physics, not the
// decision, was the handicap.
//
// Two other cheats sat next to it: a bot left a berth with `anchored = false`
// in one tick (a human works the capstan for SHIP.ANCHOR_RAISE_TIME) and set
// sailHeight instantly (a human makes sail at 0.22/s).
//
// The measurement is the SAME HULL twice, at the same spot, on the same clock,
// with the rudder saturated hard over both times: once driven by the bot brain,
// once driven by the player helm block out of Match. Only the controller
// differs, so the ratio is the handicap and nothing else.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
import { Match } from '../src/server/core/Match.ts';
import { SERVER_TICK_MS, SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { applyShipRudderSteering } from '../src/server/systems/PhysicsSystem.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

/** Clearest patch of open water in the fixed world (same scan the other bot
 *  suites use), so no obstacle-avoidance term ever enters the steering. */
function openWaterSpot(islands, seaRocks) {
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
      const clear = clearanceAt(x, z);
      if (clear > bestClear) { bestClear = clear; best = { x, z }; }
    }
  }
  return best;
}

const TURN_SECONDS = 10;

/** Hard over for TURN_SECONDS on one hull; returns her best sustained rate. */
function hardOver(driver) {
  const match = new Match({ matchId: `seamanship-${driver}`, botCount: 1 });
  const state = match.state;
  state.phase = 'playing';
  const ship = state.ships[0];
  const pirate = state.players.find((p) => p.shipId === ship.id);
  const water = openWaterSpot(state.islands, state.seaRocks);
  // Ring centred on her and enormous: nothing in decideBehavior may promote
  // 'flee' or a fight, and no other hull exists to engage.
  state.storm.centerX = water.x; state.storm.centerZ = water.z;
  state.storm.safeRadius = 4000; state.storm.shrinking = false; state.storm.phase = 0;
  ship.position.x = water.x; ship.position.z = water.z; ship.position.y = 0;
  ship.rotation = 0;
  ship.anchored = false;
  ship.anchorRaiseProgress = 1;
  ship.sailHeight = 1;
  ship.rudderAngle = 0;
  ship.angularVelocity = 0;

  const crew = match.bots.getCrew(ship.id);
  if (driver === 'human') {
    // The reference: a player at the wheel, full rudder, Match's own cap.
    match.bots.removeBot(pirate.id);
    pirate.atHelm = true;
  }

  let peak = 0;
  const t0 = 400; // past the peace window; irrelevant with one hull, kept honest
  for (let i = 0; i < Math.ceil(TURN_SECONDS / dt); i += 1) {
    // Same water, same wind, same waves every tick for both drivers, and the
    // same WAY: rudder authority rises with speed through the blade, so both
    // hulls are held at the same knots or the comparison is about sailing, not
    // about steering.
    ship.position.x = water.x; ship.position.z = water.z;
    ship.sailHeight = 1;
    const way = SHIP_STATS[ship.type].maxSpeed * 0.6;
    ship.velocity.x = Math.sin(ship.rotation) * way;
    ship.velocity.z = Math.cos(ship.rotation) * way;
    if (driver === 'bot') {
      // Hard over: a bearing 180 deg off her head keeps the rudder saturated
      // whatever the no-go cone does to the desired course.
      crew.behavior = 'patrol';
      crew.targetShipId = null;
      crew.stateTimer = 999;
      crew.patrolAngle = ship.rotation + Math.PI;
      match.bots.update(dt, t0 + i * dt, state.players, state.ships, state.islands, state.storm, match.weapons, state.seaRocks);
    } else {
      pirate.atHelm = true;
      const omegaCapScale = 0.5 + ship.sailHeight * 0.5;
      applyShipRudderSteering(ship, dt, 1, omegaCapScale);
    }
    match.physics.updateShips(dt, t0 + i * dt, [ship], state.players, state.islands, state.seaRocks, state.storm);
    peak = Math.max(peak, Math.abs(ship.angularVelocity ?? 0));
  }
  return { peak, atHelm: pirate.atHelm === true, match };
}

console.log('Rudder authority: the bot brain against the player helm, same hull');
const human = hardOver('human');
const bot = hardOver('bot');
const ratio = bot.peak / Math.max(1e-6, human.peak);
console.log(`  · peak omega  human=${human.peak.toFixed(4)} rad/s  bot=${bot.peak.toFixed(4)} rad/s  ratio=${ratio.toFixed(3)}`);
expect('the reference helm actually turns her (the harness can steer)', human.peak > 0.05,
  `human peak=${human.peak.toFixed(4)}`);
expect('a bot answers her helm at >= 0.9x a player on the same hull', ratio >= 0.9,
  `ratio=${ratio.toFixed(3)}`);
expect('somebody is visibly at the wheel of a bot hull', bot.atHelm,
  `atHelm=${bot.atHelm}`);

// ── The capstan and the canvas ─────────────────────────────────────────────
console.log('\nThe capstan and the canvas are worked, not switched');
{
  const match = new Match({ matchId: 'seamanship-anchor', botCount: 1 });
  const state = match.state;
  state.phase = 'playing';
  const ship = state.ships[0];
  const water = openWaterSpot(state.islands, state.seaRocks);
  state.storm.centerX = water.x; state.storm.centerZ = water.z;
  state.storm.safeRadius = 4000; state.storm.shrinking = false; state.storm.phase = 0;
  ship.position.x = water.x; ship.position.z = water.z; ship.position.y = 0;
  ship.rotation = 0;
  ship.anchored = true;
  ship.anchorRaiseProgress = 0;
  ship.sailHeight = 0;
  const crew = match.bots.getCrew(ship.id);
  let weighedAt = null;
  let fullSailAt = null;
  for (let i = 0; i < Math.ceil(20 / dt); i += 1) {
    ship.position.x = water.x; ship.position.z = water.z;
    crew.behavior = 'patrol';
    crew.stateTimer = 999;
    crew.patrolAngle = ship.rotation;
    match.bots.update(dt, 400 + i * dt, state.players, state.ships, state.islands, state.storm, match.weapons, state.seaRocks);
    match.physics.updateShips(dt, 400 + i * dt, [ship], state.players, state.islands, state.seaRocks, state.storm);
    if (weighedAt === null && !ship.anchored) weighedAt = i * dt;
    if (fullSailAt === null && ship.sailHeight >= 0.34) fullSailAt = i * dt;
  }
  console.log(`  · anchor up at ${weighedAt === null ? 'never' : weighedAt.toFixed(2)} s, patrol canvas at ${fullSailAt === null ? 'never' : fullSailAt.toFixed(2)} s`);
  expect('she does weigh anchor eventually (the brain is not stuck)', weighedAt !== null,
    `weighedAt=${weighedAt}`);
  expect(`the capstan takes at least SHIP.ANCHOR_RAISE_TIME (${SHIP.ANCHOR_RAISE_TIME} s)`,
    weighedAt !== null && weighedAt >= SHIP.ANCHOR_RAISE_TIME, `weighedAt=${weighedAt}`);
  expect('and the canvas is made at the helm rate, not switched on', fullSailAt !== null && fullSailAt >= 1.5,
    `fullSailAt=${fullSailAt}`);
}

if (failures > 0) {
  console.error(`\n${failures} seamanship-parity assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll seamanship-parity assertions passed.');
