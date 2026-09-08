#!/usr/bin/env node
// A shark swims in the sea the client DRAWS, and a hull is a wall to it
// (SHARK-01 / physics-29).
//   1. y follows gerstnerHeight - SURFACE_DEPTH every tick, in a storm-1 sea
//      (the old pinned y = 0.38 flies 4-5 m over a storm crest and buries
//      itself 5 m under the trough)
//   2. a shark driven at a parked galleon never enters her swim-hull footprint
//      (the old shark cruised straight through a hull a swimmer hid under)
import { Match } from '../src/server/core/Match.ts';
import { SHARK, SHIP_STATS } from '../src/shared/constants/index.ts';
import { WAVE_PARAMS, gerstnerHeight, getStormWaveIntensity, isInsideSwimHullFootprint } from '../src/shared/utils/index.ts';
import { toShipLocalPoint } from '../src/shared/interactions.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = 1 / 60;
const match = new Match({ matchId: 'shark-surface-test', botCount: 1 });
const state = match.state;
const swimmer = state.players[0];

/** Open water: clear of every island footprint, sea rock and hull by a wide
 *  margin, so only the term under test moves the shark. */
function findOpenSea(pad = 120) {
  for (let x = -800; x <= 800; x += 25) {
    for (let z = -800; z <= 800; z += 25) {
      let clear = true;
      for (const island of state.islands) {
        const spread = Math.max(island.profile?.footprintX ?? 1, island.profile?.footprintZ ?? 1);
        if (Math.hypot(x - island.position.x, z - island.position.z) < island.radius * spread + pad) { clear = false; break; }
      }
      if (!clear) continue;
      for (const rock of state.seaRocks) {
        if (Math.hypot(x - rock.position.x, z - rock.position.z) < (rock.colliderBoundsRadius ?? rock.radius) + pad) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  throw new Error('no open-sea point found for test setup');
}
const sea = findOpenSea();

function makeShark(x, z, targetId) {
  return {
    id: 'surface-shark',
    position: { x, y: 0.38, z },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    health: SHARK.HEALTH,
    biteCooldown: 1e9,   // never bite: this suite grades motion, not damage
    attackState: 'cruise',
    attackTimer: 0,
    lungeDirX: 0,
    lungeDirZ: 0,
    targetId,
    anchorX: x,
    anchorZ: z,
    idleTime: 0,
  };
}

function waveYAt(x, z) {
  return gerstnerHeight(x, z, match.t, WAVE_PARAMS, getStormWaveIntensity(state.storm, x, z));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('1. A shark rides the storm sea, not a flat plane at y = 0.38');
{
  // Full storm over the test water: safeRadius small and far away, phase 6, so
  // getStormWaveIntensity saturates and the storm swell is in the sample.
  state.storm.centerX = sea.x + 4000;
  state.storm.centerZ = sea.z;
  state.storm.safeRadius = 200;
  state.storm.phase = 6;
  const stormHere = getStormWaveIntensity(state.storm, sea.x, sea.z);
  expect('the test water really is a storm sea', stormHere > 0.9, `intensity=${stormHere.toFixed(3)}`);

  swimmer.state = 'swimming';
  swimmer.health = 100;
  swimmer.swimTimer = 0;
  swimmer.position = { x: sea.x, y: 0.1, z: sea.z };
  state.sharks.length = 0;
  const shark = makeShark(sea.x, sea.z - 12, swimmer.id);
  state.sharks.push(shark);

  let worst = 0;
  let swing = { min: Infinity, max: -Infinity };
  for (let i = 0; i < 600; i++) {
    match.t += DT;
    match.updateSharks(DT);
    if (!state.sharks.length) break;
    const w = waveYAt(shark.position.x, shark.position.z);
    worst = Math.max(worst, Math.abs(shark.position.y - w));
    swing.min = Math.min(swing.min, w);
    swing.max = Math.max(swing.max, w);
    // Keep the swimmer alive under the shark so the chase never leashes out.
    swimmer.position.x = shark.position.x;
    swimmer.position.z = shark.position.z + 6;
  }
  expect('the sea under the shark actually moved (control)', swing.max - swing.min > 1.2,
    `sea swing ${(swing.max - swing.min).toFixed(2)} m over 600 ticks`);
  expect('|shark.y - waveY| < 0.5 on every one of 600 ticks', worst < 0.5, `worst=${worst.toFixed(3)} m`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2. A shark driven at a parked galleon never enters her hull');
{
  const berth = findOpenSea(200);
  const ship = state.ships[0];
  ship.alive = true;
  ship.sinking = false;
  ship.type = 'galleon';
  ship.position = { x: berth.x, y: 0, z: berth.z };
  ship.rotation = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  const stats = SHIP_STATS[ship.type];
  for (const other of state.ships) {
    if (other === ship) continue;
    other.alive = false;
  }

  // Swimmer hugging the far side of the hull, shark released on the near side:
  // the straight line between them runs the length of the ship.
  swimmer.state = 'swimming';
  swimmer.health = 100;
  swimmer.onShipId = null;
  swimmer.position = { x: berth.x, y: 0.1, z: berth.z + stats.length * 0.52 + 3 };
  state.sharks.length = 0;
  const shark = makeShark(berth.x, berth.z - stats.length * 0.52 - 3, swimmer.id);
  shark.anchorX = shark.position.x;
  shark.anchorZ = shark.position.z;
  state.sharks.push(shark);

  let deepest = 0;
  let breaches = 0;
  for (let i = 0; i < 900; i++) {
    match.t += DT;
    match.updateSharks(DT);
    if (!state.sharks.length) break;
    const local = toShipLocalPoint(shark.position, ship);
    if (isInsideSwimHullFootprint(stats, local.x, local.z, 0, 0.5)) {
      breaches += 1;
      const half = stats.width * 0.5;
      deepest = Math.max(deepest, half - Math.abs(local.x));
    }
    // Re-anchor the leash each tick: this case grades the wall, not the leash.
    shark.anchorX = shark.position.x;
    shark.anchorZ = shark.position.z;
  }
  expect('shark never enters the parked galleon\'s swim footprint', breaches === 0,
    `${breaches} ticks inside, deepest ${deepest.toFixed(2)} m past the planking`);
  const local = toShipLocalPoint(shark.position, ship);
  expect('shark ended the run outside the hull', !isInsideSwimHullFootprint(stats, local.x, local.z, 0, 0.5),
    `local=(${local.x.toFixed(2)}, ${local.z.toFixed(2)})`);
}

if (failures > 0) {
  console.error(`\n${failures} shark-surface assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll shark surface/hull assertions passed.');
