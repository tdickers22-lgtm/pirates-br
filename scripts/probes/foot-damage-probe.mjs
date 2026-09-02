#!/usr/bin/env node
// PROBE, not a gate: WHO IS EATING A WALKER'S HEALTH? The fresh-eyes audit read 100 → 58 while wandering the spawn island under a blue sky INSIDE the ring, with swimTim...
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// WHO IS EATING A WALKER'S HEALTH?
//
// The fresh-eyes audit read 100 → 58 while wandering the spawn island under a
// blue sky INSIDE the ring, with swimTimer 0 and the nearest shark 400 m off,
// then 58 → 8 walking to a chest, then dead — with nothing on screen naming any
// of it. Before routing damage to the HUD there has to be an answer to what the
// damage WAS, so this walks a pirate around a real island headlessly and prints
// every health loss with the physics state that produced it.
//
//   node --import tsx scripts/foot-damage-probe.mjs
import { Match } from '../../src/server/core/Match.ts';
import { PLAYER, SERVER_TICK_MS } from '../../src/shared/constants/index.ts';
import { getIslandSurfaceY } from '../../src/shared/utils/index.ts';

const DT = SERVER_TICK_MS / 1000;
const makeFakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });

const match = new Match({ matchId: 'foot-damage', botCount: 0 });
match.state.phase = 'playing';
const joined = match.addHumanClient(makeFakeWs(), 'Walker');
const player = match.state.players.find((p) => p.id === joined.playerId);
const ship = match.state.ships.find((s) => s.id === joined.shipId);

// Park him ashore on the island his crew was moored at, well inside the ring.
const island = match.state.islands.find((i) => i.dock)
  ?? match.state.islands[0];
const put = (x, z) => {
  player.onShipId = null;
  player.position.x = x;
  player.position.z = z;
  player.position.y = getIslandSurfaceY(island, x, z) + 0.3;
  player.velocity = { x: 0, y: 0, z: 0 };
};
ship.anchored = true;
console.log(`island ${island.name} at (${island.position.x.toFixed(0)}, ${island.position.z.toFixed(0)}) r=${island.radius?.toFixed(0) ?? '?'}`);
console.log(`ring: centre (${match.state.storm.centerX.toFixed(0)}, ${match.state.storm.centerZ.toFixed(0)}) safeRadius ${match.state.storm.safeRadius.toFixed(0)}`);

// applyInput reads client.lastInput, so the probe writes there rather than
// reaching for a private method. Every field the walk path touches must exist.
const client = [...match.clients.values()].find((c) => c.playerId === player.id);
const BLANK_INPUT = {
  crouch: false, seq: 0, ts: 0, forward: false, back: false, left: false, right: false,
  jump: false, jumpPressed: false, fire: false, useItem: false, aim: false,
  interact: false, interactHeld: false, anchor: false, sailRaise: false,
  sailLower: false, sailLeft: false, sailRight: false, trade: false, reload: false,
  placeKeg: false, dropChest: false, specialAttack: false, slot: null,
  cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null, selectMap: null,
};

const tally = new Map();
let worstDrop = 0;
let samples = 0;

// Twelve radial walks out from the island's high ground, each 40 s of held W at
// a fresh heading: beaches, flanks, terraces, the shoreline, the lot.
for (let leg = 0; leg < 12; leg++) {
  const angle = (leg / 12) * Math.PI * 2;
  put(island.position.x, island.position.z);
  player.health = PLAYER.MAX_HEALTH;
  player.respawnProtectionTimer = 0;
  player.state = 'alive';
  const yaw = angle;
  const legStart = player.health;
  for (let i = 0; i < Math.ceil(40 / DT); i++) {
    client.lastInput = {
      ...BLANK_INPUT, seq: i, ts: Date.now(), forward: true, yaw,
    };
    const before = player.health;
    const beforeY = player.position.y;
    const beforeVy = player.velocity.y;
    const beforeState = player.state;
    const beforeSwim = player.swimTimer;
    match.tick();
    samples += 1;
    const lost = before - player.health;
    if (lost > 1e-6) {
      const cause = match.lastDamageSourceById.get(player.id)?.source ?? 'unattributed';
      tally.set(cause, (tally.get(cause) ?? 0) + lost);
      if (lost > worstDrop) {
        worstDrop = lost;
        console.log(`  worst single tick so far: -${lost.toFixed(2)} as '${cause}'`
          + ` state ${beforeState}→${player.state} y ${beforeY.toFixed(2)}→${player.position.y.toFixed(2)}`
          + ` vy ${beforeVy.toFixed(2)} swim ${beforeSwim.toFixed(1)}→${player.swimTimer.toFixed(1)}`);
      }
    }
    if (player.health <= 0) break;
  }
  console.log(`leg ${leg} bearing ${(angle * 57.3).toFixed(0)}°: hp ${legStart.toFixed(0)} → ${player.health.toFixed(1)}`
    + ` state=${player.state} swimTimer=${player.swimTimer.toFixed(1)}`
    + ` pos=(${player.position.x.toFixed(0)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(0)})`);
}

console.log(`\n${samples} ticks walked. Health lost by source:`);
if (tally.size === 0) console.log('  (nothing — a walker never bled)');
for (const [cause, amount] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cause.padEnd(12)} ${amount.toFixed(1)}`);
}
