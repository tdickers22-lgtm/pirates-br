#!/usr/bin/env node
// A BOT'S POWDER HORN IS NOT BOTTOMLESS, AND IT IS NOT A ONE-OFF EITHER (bots-v03).
//
// Bot firearms ship with ammo 1 + reserve 5 apiece (18 rounds over three
// pieces) and the only refill in the game was the [X] ammo-crate interaction,
// which bots never used. So a bot was lethal on deck for the first 18 shots
// and silent for the rest of the match — the difficulty curve ran backwards.
// Worse, selectFirearm picked by range only: a dry blunderbuss was "fired"
// every 3 s forever while two loaded pieces hung on the belt.
//
// Contract:
//   • a bot never queues a shot for a weapon with ammo 0 AND reserve 0 — it
//     picks the next piece that has powder, so all 18 rounds go downrange;
//   • during a lull on its own deck it tops up at the crate (per-tier
//     cooldown), so its reserve is back above zero inside two minutes.
// Deterministic: one bot hull hove to on open water, one boarder on deck,
// only the bot brain + WeaponSystem running (Match's drain loop reproduced).
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
import { Match } from '../src/server/core/Match.ts';
import { BOT_EARLY_PEACE_SECONDS, SERVER_TICK_MS, WEAPONS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

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

const match = new Match({ matchId: 'bot-ammo', botCount: 1 });
const state = match.state;
state.phase = 'playing';
const ship = state.ships[0];
const pirate = state.players.find((p) => p.shipId === ship.id);
const weapons = match.weapons;
const water = openWaterSpot(state.islands, state.seaRocks);
ship.position.x = water.x; ship.position.z = water.z; ship.position.y = 0;
ship.rotation = 0; ship.velocity = { x: 0, y: 0, z: 0 }; ship.sailHeight = 0; ship.anchored = true;
pirate.position = match.getRespawnDeckPosition(ship);
pirate.onShipId = ship.id;
pirate.state = 'alive';
pirate.rotation.x = Math.PI / 2; // already facing the boarder (+x)
const brain = match.bots.bots.get(pirate.id);
brain.difficulty = 'easy';
brain.firearmTimer = 0;
state.storm.centerX = ship.position.x; state.storm.centerZ = ship.position.z;
state.storm.safeRadius = 2000; state.storm.shrinking = false; state.storm.phase = 0;

// A boarder 5 m off on deck — blunderbuss range, so the first piece runs dry fast.
const boarder = match.createPlayer('boarder-1', 'Boarder', null, false);
boarder.state = 'alive';
boarder.position = { x: pirate.position.x + 5, y: pirate.position.y, z: pirate.position.z };
boarder.onShipId = ship.id;
boarder.health = 1e9; // a target that never dies
state.players.push(boarder);

const firearms = () => pirate.weapons.filter((w) => w && !WEAPONS[w.weaponId].melee);
const roundsLeft = () => firearms().reduce((n, w) => n + w.ammo + w.reserve, 0);
const loadout = roundsLeft();

/** Match's bot-firearm drain, reproduced: queue → tryFire → reload ticks. */
let t = BOT_EARLY_PEACE_SECONDS + 5;
let realShots = 0;
let dryQueued = 0;
function tick() {
  match.bots.update(dt, t, state.players, state.ships, state.islands, state.storm, weapons, state.seaRocks);
  for (const shot of match.bots.flushFirearmShots()) {
    const weapon = pirate.weapons[pirate.activeSlot];
    if (weapon && weapon.ammo <= 0 && weapon.reserve <= 0) dryQueued += 1;
    const traces = weapons.tryFire(pirate, ship, shot.yaw, shot.pitch, 0, { aiming: false, aimPoint: shot.aimPoint });
    if (traces.length > 0) realShots += 1;
  }
  weapons.update(dt, state.players);
  boarder.health = 1e9;
  t += dt;
}

console.log(`A boarder on deck, ${loadout} rounds on the belt`);
const FIGHT_CAP = 240;
const fightStart = t;
while (roundsLeft() > 0 && t - fightStart < FIGHT_CAP) tick();
const fightSeconds = t - fightStart;
console.log(`  · ${realShots} rounds fired in ${fightSeconds.toFixed(1)} s, ${dryQueued} shots queued on a dry piece, ${roundsLeft()} left`);
expect(`every round on the belt goes downrange (${loadout})`, realShots === loadout, `realShots=${realShots}`);
expect('no shot is ever queued for a weapon with ammo 0 and reserve 0', dryQueued === 0, `dryQueued=${dryQueued}`);
expect('the belt is empty afterwards (the harness really drained it)', roundsLeft() === 0, `left=${roundsLeft()}`);

// Now the boarder is gone. A lull on his own deck: the pirate walks to the crate.
console.log('\nThe boarder is gone; two minutes of quiet deck');
state.players.splice(state.players.indexOf(boarder), 1);
const PARK_SECONDS = 120;
const parkStart = t;
let firstTopUpAt = null;
while (t - parkStart < PARK_SECONDS) {
  tick();
  if (firstTopUpAt === null && roundsLeft() > 0) firstTopUpAt = t - parkStart;
}
console.log(`  · after ${PARK_SECONDS} s: ${roundsLeft()} rounds, first top-up at ${firstTopUpAt === null ? 'never' : firstTopUpAt.toFixed(1) + ' s'}`);
expect('the reserve is back above zero', firearms().every((w) => w.reserve > 0),
  firearms().map((w) => `${w.weaponId}:${w.ammo}+${w.reserve}`).join(' '));
expect('the top-up is a deck lull, not instant (>= 8 s after the last threat)',
  firstTopUpAt !== null && firstTopUpAt >= 8, `firstTopUpAt=${firstTopUpAt}`);

if (failures > 0) {
  console.error(`\n${failures} bot-ammo assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll bot-ammo assertions passed.');
