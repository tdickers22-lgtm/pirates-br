#!/usr/bin/env node
/**
 * DYING IS NOT A REFIT, AND A DEAD CAPTAIN'S SHIP DOES NOT SAIL ON.
 *
 * Three readings the respawn path got wrong (TOW-01: gameplay-03, gameplay-24):
 *
 *  • THE FREE REFIT. A hull towed in from outside the ring — or parked at a
 *    dock for a respawn — went through parkShipAtDock, which zeroes `holes`,
 *    `waterLevel`, `onFire` and `sailIntegrity`. So the cheapest repair in the
 *    game was to die: sail out of the ring with four breaches and 70% flooding,
 *    get killed, and come back to a brand-new ship at a berth in the middle of
 *    the map. Bots got it too.
 *  • THE GHOST HELMSMAN. A solo captain killed at speed left his hull under
 *    full canvas with nobody aboard: she carried on for the whole respawn — 20 s
 *    at 10 m/s is 200 m, usually into the storm or a reef.
 *  • THE DISCARDED SPAWN. `pickHumanSpawn` carefully computes the berth
 *    farthest from every other hull, and `createHumanClient` then threw it away
 *    for a UNIFORMLY RANDOM in-ring dock, so two humans could join into the
 *    same bay.
 *
 * Driven against a real Match on real ticks.
 */
// Join-time coin flips (which free dock a newcomer moors at) are plain
// Math.random unless the map seed is pinned — so pin it, or this suite grades a
// different world every run. Same seed the test runner boots the stack on.
process.env.PIRATES_BR_MAP_SEED = process.env.PIRATES_BR_MAP_SEED || '20260801';

import { Match } from '../src/server/core/Match.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function livePlayingMatch(botCount, id) {
  const match = new Match({ matchId: id, botCount });
  match.state.phase = 'playing';
  match.state.storm.centerX = 0;
  match.state.storm.centerZ = 0;
  match.state.storm.safeRadius = 700;
  match.state.storm.damagePerSec = 0;
  match.broadcast = () => {};
  return match;
}

// ── A TOW IS A RESCUE, NOT A DRYDOCK ─────────────────────────────────────────
console.log('The tide brings her in as she is:');
{
  const match = livePlayingMatch(2, 'tow-refit');
  const state = match.state;
  const [captain] = state.players;
  const hull = state.ships.find((s) => s.id === captain.shipId);

  // She is 200 m outside the wall, holed four times and half full of water.
  hull.position = { x: state.storm.safeRadius + 200, y: 0.05, z: 0 };
  hull.anchored = false;
  hull.holes = [1, 2, 3, 4].map((id) => ({ id, x: 0, y: 0.2, z: id * 1.5 - 3, patched: false }));
  hull.nextHoleId = 5;
  hull.waterLevel = 0.7;
  hull.onFire = false;

  // Her captain is killed: nobody alive aboard, nobody who calls her home.
  captain.position = { ...hull.position };
  captain.health = 0;
  match.handlePlayerDeath(captain);
  expect('the captain is holding a respawn on his hull',
    captain.state === 'respawning', `state=${captain.state}`);

  const deadline = match.t + 35;
  while (match.t < deadline) match.tick();

  const inside = dist2(hull.position, { x: state.storm.centerX, z: state.storm.centerZ })
    <= state.storm.safeRadius;
  expect('the tide brought her inside the wall', inside,
    `d=${dist2(hull.position, { x: 0, z: 0 }).toFixed(1)} safeRadius=${state.storm.safeRadius}`);
  expect('...still holed — a tow is not a refit', hull.holes.length >= 4,
    `holes=${hull.holes.length}`);
  expect('...still wet, and only bailed to the survivable clamp',
    hull.waterLevel > 0 && hull.waterLevel <= 0.45, `waterLevel=${hull.waterLevel.toFixed(3)}`);
}

// ── A DEAD CAPTAIN'S SHIP ROUNDS UP AND ANCHORS ──────────────────────────────
console.log('\nThe ghost helmsman:');
{
  const match = livePlayingMatch(1, 'tow-ghost-helm');
  const state = match.state;
  // A HUMAN captain, so no bot brain weighs the anchor again on respawn: the
  // question here is only what the hull does with nobody alive aboard her.
  const joined = match.addHumanClient(
    { readyState: 1, bufferedAmount: 0, send() {}, close() {} }, 'Ghost');
  const captain = state.players.find((p) => p.id === joined.playerId);
  const hull = state.ships.find((s) => s.id === captain.shipId);

  // Well inside the ring (no tow), making way under full canvas.
  hull.position = { x: 0, y: 0.05, z: 0 };
  hull.rotation = 0;
  hull.anchored = false;
  hull.anchorRaiseProgress = 1;
  hull.sailHeight = 1;
  hull.sailIntegrity = 1;
  hull.velocity = { x: 0, y: 0, z: 10 };
  const start = { x: hull.position.x, z: hull.position.z };

  captain.position = { x: 0, y: 3, z: 0 };
  captain.health = 0;
  match.handlePlayerDeath(captain);

  const deadline = match.t + 20;
  while (match.t < deadline) match.tick();

  const ran = dist2(hull.position, start);
  expect('a hull with nobody alive aboard rounds up within 20 s (< 60 m of way)',
    ran < 60, `ran=${ran.toFixed(1)}m sail=${hull.sailHeight.toFixed(2)} anchored=${hull.anchored}`);
  expect('...with her canvas furled and her anchor down',
    hull.sailHeight <= 0.01 && hull.anchored,
    `sail=${hull.sailHeight.toFixed(2)} anchored=${hull.anchored}`);
}

// ── TWO HUMANS DO NOT JOIN INTO THE SAME BAY ─────────────────────────────────
console.log('\nThe spawn that was computed and thrown away:');
{
  const match = livePlayingMatch(0, 'tow-spawn-spread');
  const fakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });
  const joined = ['First', 'Second', 'Third'].map((n) => match.addHumanClient(fakeWs(), n));
  const hulls = joined.map((j) => match.state.ships.find((s) => s.id === j.shipId));
  let closest = Infinity;
  for (let i = 0; i < hulls.length; i++) {
    for (let k = i + 1; k < hulls.length; k++) {
      closest = Math.min(closest, dist2(hulls[i].position, hulls[k].position));
    }
  }
  expect('every pair of joins lands at least 400 m apart', closest >= 400,
    `closest=${closest.toFixed(1)}m berths=${hulls.map((h) => `${h.position.x.toFixed(0)},${h.position.z.toFixed(0)}`).join(' | ')}`);
}

// ── A RESPAWN AT A BERTH IS NOT A DRYDOCK EITHER ─────────────────────────────
console.log('\nA berth respawn:');
{
  const match = livePlayingMatch(2, 'tow-berth-respawn');
  const state = match.state;
  const [captain] = state.players;
  const hull = state.ships.find((s) => s.id === captain.shipId);
  const dock = state.islands.find((i) => i.dock)?.dock;
  hull.holes = [1, 2].map((id) => ({ id, x: 0, y: 0.2, z: id, patched: false }));
  hull.nextHoleId = 3;
  hull.waterLevel = 0.3;
  match.parkShipAtDock(hull, dock, /*refit*/ false);
  expect('parking her without a refit keeps her breaches', hull.holes.length === 2,
    `holes=${hull.holes.length}`);
  expect('...and her water', Math.abs(hull.waterLevel - 0.3) < 1e-6,
    `waterLevel=${hull.waterLevel}`);
  expect('...but still moors her, furled and anchored',
    hull.anchored && hull.sailHeight === 0, `anchored=${hull.anchored} sail=${hull.sailHeight}`);

  match.parkShipAtDock(hull, dock);
  expect('a full refit (match start / reset) still hands back a sound ship',
    hull.holes.length === 0 && hull.waterLevel === 0,
    `holes=${hull.holes.length} water=${hull.waterLevel}`);
}

if (failures > 0) {
  console.error(`\n${failures} respawn/tow assertion(s) failed.`);
  process.exit(1);
}
console.log(`\nAll respawn/tow assertions passed (respawn time ${PLAYER.RESPAWN_TIME}s).`);
