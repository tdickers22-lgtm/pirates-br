#!/usr/bin/env node
/**
 * WEIGHING ANCHOR IS NOT CASTING OFF.
 *
 * OPEN-01 (liveplay-01, liveplay-08). The opening minute of a solo match:
 *
 *  • Every hull is PRE-HOISTED to half canvas at the horn (so a cold start is
 *    not board-capstan-halyard-helm), and the onboarding card says "weigh anchor
 *    at the capstan". The capstan is at the BOW. So the one thing the game tells
 *    a new pirate to do releases the brake on a ship already carrying half sail,
 *    with nobody at the wheel — she makes 11.8 kn straight out of the bay and
 *    into the storm while he is still walking aft. The solo match ends there.
 *  • The auto-carpenter patched a leak every FIELD_REPAIR_INTERVAL on any
 *    ANCHORED hull with planks aboard, silently, with the crew standing next to
 *    the hole. Sixteen planks became one and nothing on screen said why.
 *
 * The fix is not to take the pre-hoist away (a berth is where a ship sits with
 * her canvas at half) but to make the capstan honest: a HUMAN raising the anchor
 * with nobody at the helm furls her first. And the carpenter announces every
 * plank he spends and stands aside for a crewmate who is right there.
 */
// Join-time coin flips (which free dock a newcomer moors at) are plain
// Math.random unless the map seed is pinned — so pin it, or this suite grades a
// different world every run. Same seed the test runner boots the stack on.
process.env.PIRATES_BR_MAP_SEED = process.env.PIRATES_BR_MAP_SEED || '20260801';

import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { getAnchorControlLocal, toShipWorldPoint } from '../src/shared/interactions.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const fakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });
const speedOf = (ship) => Math.hypot(ship.velocity.x, ship.velocity.z);

function soloMatch(id) {
  const match = new Match({ matchId: id, botCount: 1 });
  match.state.phase = 'playing';
  match.state.storm.centerX = 0;
  match.state.storm.centerZ = 0;
  match.state.storm.safeRadius = 900;
  match.state.storm.damagePerSec = 0;
  match.broadcast = () => {};
  return match;
}

/** Stand the pirate at the capstan and hold [X], the way the card tells him to. */
function standAtCapstan(match, player, ship) {
  const stats = SHIP_STATS[ship.type];
  const anchor = getAnchorControlLocal(stats);
  const world = toShipWorldPoint(anchor, ship);
  player.onShipId = ship.id;
  player.position = { x: world.x, y: ship.position.y + stats.height + 0.1, z: world.z };
  player.atHelm = false;
  player.atCannon = false;
  player.atCrowNest = false;
}

// ── THE CAPSTAN DOES NOT CAST HER OFF ────────────────────────────────────────
console.log('Capstan first, helm empty:');
{
  const match = soloMatch('capstan-first');
  const state = match.state;
  const joined = match.addHumanClient(fakeWs(), 'Newcomer');
  const player = state.players.find((p) => p.id === joined.playerId);
  const ship = state.ships.find((s) => s.id === joined.shipId);

  // The horn's pre-hoist: half canvas at the berth, anchor down.
  match.preHoistSailsAtHorn();
  expect('she starts the match at half canvas, moored', ship.sailHeight > 0.4 && ship.anchored,
    `sail=${ship.sailHeight} anchored=${ship.anchored}`);
  const berth = { x: ship.position.x, z: ship.position.z };

  const hold = () => match.handleClientMessage(joined.playerId, {
    type: 'player_input',
    ts: 0,
    payload: { seq: match.tickCount + 1, yaw: 0, pitch: 0, interact: true, interactHeld: true, interactIntent: 'anchor' },
  });

  // Hold [X] at the capstan until the anchor is up, then let go and wait.
  let raised = false;
  for (let i = 0; i < 60 * (SHIP.ANCHOR_RAISE_TIME + 2); i++) {
    standAtCapstan(match, player, ship);
    hold();
    match.tick();
    if (!ship.anchored) { raised = true; break; }
  }
  expect('the capstan still weighs the anchor', raised && !ship.anchored,
    `anchored=${ship.anchored} progress=${ship.anchorRaiseProgress}`);

  const deadline = match.t + 20;
  while (match.t < deadline) {
    standAtCapstan(match, player, ship);
    match.handleClientMessage(joined.playerId, { type: 'player_input', ts: 0, payload: { seq: match.tickCount + 1, yaw: 0, pitch: 0 } });
    match.tick();
  }

  const drift = Math.hypot(ship.position.x - berth.x, ship.position.z - berth.z);
  expect('20 s later she is still in the bay (< 10 m of drift)', drift < 10,
    `drift=${drift.toFixed(1)}m sail=${ship.sailHeight.toFixed(2)}`);
  expect('...and dead in the water (< 0.5 m/s)', speedOf(ship) < 0.5,
    `speed=${speedOf(ship).toFixed(2)}m/s`);
}

// ── A HELMSMAN KEEPS HER CANVAS ──────────────────────────────────────────────
console.log('\nCapstan with a hand at the wheel:');
{
  const match = soloMatch('capstan-with-helm');
  const state = match.state;
  const a = match.addHumanClient(fakeWs(), 'Bosun');
  const b = match.addHumanClient(fakeWs(), 'Helmsman');
  const bosun = state.players.find((p) => p.id === a.playerId);
  const helmsman = state.players.find((p) => p.id === b.playerId);
  const ship = state.ships.find((s) => s.id === a.shipId);
  match.preHoistSailsAtHorn();

  // The mate is at the wheel of the SAME hull: this crew meant to get under way.
  helmsman.onShipId = ship.id;
  helmsman.atHelm = true;

  let raised = false;
  for (let i = 0; i < 60 * (SHIP.ANCHOR_RAISE_TIME + 2); i++) {
    standAtCapstan(match, bosun, ship);
    helmsman.onShipId = ship.id;
    helmsman.atHelm = true;
    match.handleClientMessage(a.playerId, {
      type: 'player_input',
      ts: 0,
      payload: { seq: match.tickCount + 1, yaw: 0, pitch: 0, interact: true, interactHeld: true, interactIntent: 'anchor' },
    });
    match.tick();
    if (!ship.anchored) { raised = true; break; }
  }
  expect('the anchor comes up', raised, `anchored=${ship.anchored}`);
  expect('...and her canvas is left standing for the helmsman', ship.sailHeight > 0.2,
    `sail=${ship.sailHeight.toFixed(2)}`);
}

// ── THE CARPENTER SAYS WHAT HE SPENDS, AND STANDS ASIDE ──────────────────────
console.log('\nThe auto-carpenter:');
{
  const match = soloMatch('carpenter-feed');
  const state = match.state;
  const joined = match.addHumanClient(fakeWs(), 'Chips');
  const player = state.players.find((p) => p.id === joined.playerId);
  const ship = state.ships.find((s) => s.id === joined.shipId);
  const feed = [];
  match.broadcast = (msg) => { if (msg?.type === 'carpenter_patch') feed.push(msg.payload); };

  const armHole = () => {
    ship.holes = [{ id: 1, x: 0, y: 0.2, z: 1.0, patched: false }];
    ship.nextHoleId = 2;
    ship.waterLevel = 0.2;
    ship.anchored = true;
    ship.onFire = false;
    ship.repairCooldown = 0;
    ship.autoRepairProgress = 0;
    ship.inventory = [{ item: 'wood_plank', qty: 16 }];
  };

  // A crewmate is standing right beside the breach: it is his to plank.
  armHole();
  const holeWorld = toShipWorldPoint({ x: 0, z: 1.0 }, ship);
  player.onShipId = ship.id;
  player.position = { x: holeWorld.x, y: ship.position.y + 0.6, z: holeWorld.z };
  player.health = 100;
  for (let i = 0; i < Math.ceil(60 * (SHIP.FIELD_REPAIR_INTERVAL + 1)); i++) {
    match.updateFieldRepairs(1 / 60);
  }
  expect('the carpenter stands aside for a crewmate at the hole',
    ship.holes.some((h) => !h.patched) && ship.inventory[0].qty === 16,
    `patched=${ship.holes.map((h) => h.patched).join(',')} planks=${ship.inventory[0].qty}`);

  // Nobody aboard: the carpenter works, and says so.
  armHole();
  player.onShipId = null;
  player.position = { x: ship.position.x + 400, y: 2, z: ship.position.z + 400 };
  for (let i = 0; i < Math.ceil(60 * (SHIP.FIELD_REPAIR_INTERVAL + 1)); i++) {
    match.updateFieldRepairs(1 / 60);
  }
  expect('with the deck empty he planks the leak',
    ship.holes.every((h) => h.patched), `holes=${JSON.stringify(ship.holes)}`);
  expect('...spending exactly one plank', ship.inventory[0].qty === 15,
    `planks=${ship.inventory[0].qty}`);
  expect('...and announcing it with the planks he has left',
    feed.length === 1 && feed[0].shipId === ship.id && feed[0].planksLeft === 15,
    `feed=${JSON.stringify(feed)}`);
}

if (failures > 0) {
  console.error(`\n${failures} capstan/carpenter assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll capstan/carpenter assertions passed.');
