#!/usr/bin/env node
// THE CORPSE DOES NOT KEEP THE HELM (BOT-02 / bots-02).
//
// Every bot hull has exactly one pirate. Killing him — sniped off his deck,
// cut down by a boarder — is the most skilful counter to a one-pirate crew,
// and on HEAD it bought nothing: the dead pirate sat in state 'respawning' for
// PLAYER.RESPAWN_TIME and kept steering, trimming and firing broadsides the
// whole time, because BotSystem.update only skipped 'eliminated'/'downed' and
// WeaponSystem.tryFire only refused the same two states.
//
// Contract: a bot hull whose pirate is dead is UNMANNED. The bot brain skips
// him, the un-helmed rudder decay in PhysicsSystem centres the wheel, and not
// one cannon speaks — while the live crew alongside keeps fighting, so the
// harness itself is proven able to fire.
//
// Deterministic: seeded match, two bot hulls pinned 80 m abeam on open water,
// sim clock past the peace window so nothing but the pirate's pulse gates the
// guns.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
import { Match } from '../src/server/core/Match.ts';
import { BOT_EARLY_PEACE_SECONDS, SERVER_TICK_MS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

/** Clearest patch of open water in the fixed world for a 80 m pair (same scan
 *  as test-bot-peace-window: both hulls and the water between must be clear). */
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

const SPAN = 80;
const match = new Match({ matchId: 'bot-ghost-helm', botCount: 2 });
const state = match.state;
state.phase = 'playing';
const [a, b] = state.ships;
const pirateA = state.players.find((p) => p.shipId === a.id);
const pirateB = state.players.find((p) => p.shipId === b.id);
const weapons = match.weapons;
const water = openWaterSpot(state.islands, state.seaRocks, SPAN);

const pinPair = (all) => {
  a.position.x = water.x; a.position.z = water.z;
  b.position.x = water.x + SPAN; b.position.z = water.z;
  if (!all) return;
  for (const ship of [a, b]) {
    ship.position.y = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.anchored = false;
    ship.sailHeight = 0;
    ship.rotation = 0;
  }
};
pinPair(true);
state.storm.centerX = water.x + SPAN / 2; state.storm.centerZ = water.z;
state.storm.safeRadius = 2000; state.storm.shrinking = false; state.storm.phase = 0;

// Count real cannon shots per pirate (a cooldown that moved = a ball left the port).
const shots = new Map();
const realTryFire = weapons.tryFire.bind(weapons);
weapons.tryFire = (player, ship, yaw, pitch, cannonIndex, options) => {
  const before = ship?.cannonCooldowns?.[cannonIndex] ?? 0;
  const trace = realTryFire(player, ship, yaw, pitch, cannonIndex, options);
  if (ship && ship.cannonCooldowns[cannonIndex] !== before) shots.set(player.id, (shots.get(player.id) ?? 0) + 1);
  return trace;
};
const shotsOf = (p) => shots.get(p.id) ?? 0;

// ── Phase 1: both pirates alive, past the peace, the pair fights ───────────
console.log('Two live crews abeam (harness sanity)');
const T0 = BOT_EARLY_PEACE_SECONDS + 50;
const WARM_SECONDS = 25;
for (let i = 0; i < Math.ceil(WARM_SECONDS / dt); i += 1) {
  pinPair(true);
  match.bots.update(dt, T0 + i * dt, state.players, state.ships, state.islands, state.storm, weapons, state.seaRocks);
  for (const ship of [a, b]) {
    for (let c = 0; c < ship.cannonCooldowns.length; c += 1) ship.cannonCooldowns[c] = Math.max(0, ship.cannonCooldowns[c] - dt);
  }
}
const aliveShotsA = shotsOf(pirateA);
const aliveShotsB = shotsOf(pirateB);
expect('a live bot crew fires on its neighbour 80 m abeam', aliveShotsA > 0, `shotsA=${aliveShotsA}`);
expect('so does the other crew', aliveShotsB > 0, `shotsB=${aliveShotsB}`);
expect('the live helmsman is working the wheel', Math.abs(a.rudderAngle ?? 0) > 0.02, `rudder=${(a.rudderAngle ?? 0).toFixed(3)}`);

// ── Phase 2: pirate A is dead (on the respawn clock); the hull must go quiet ─
console.log('\nPirate A shot off his deck (state respawning)');
pirateA.state = 'respawning';
pirateA.respawnTimer = 999;
pirateA.atCannon = false;
pirateA.atHelm = false;
a.rudderAngle = 0.5;
weapons.flushProjectiles();
state.projectiles.length = 0;
shots.clear();
match.t = T0 + WARM_SECONDS;

const GHOST_SECONDS = 8;
for (let i = 0; i < Math.ceil(GHOST_SECONDS / dt); i += 1) {
  pinPair(false);
  match.tick();
}
const ghostShotsA = shotsOf(pirateA);
const rudderA = Math.abs(a.rudderAngle ?? 0);
console.log(`  · ${GHOST_SECONDS}s dead: shotsA=${ghostShotsA} rudderA=${rudderA.toFixed(4)} shotsB=${shotsOf(pirateB)} stateA=${pirateA.state}`);
expect('the corpse fires no cannon', ghostShotsA === 0, `shotsA=${ghostShotsA}`);
expect('the wheel centres itself (rudder decays to 0)', rudderA < 0.02, `rudder=${rudderA.toFixed(4)}`);
expect('the pirate stayed dead for the whole window', pirateA.state === 'respawning', `state=${pirateA.state}`);
expect('the live crew alongside still fights (the harness can fire)', shotsOf(pirateB) > 0, `shotsB=${shotsOf(pirateB)}`);

if (failures > 0) {
  console.error(`\n${failures} ghost-helm assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll ghost-helm assertions passed.');
