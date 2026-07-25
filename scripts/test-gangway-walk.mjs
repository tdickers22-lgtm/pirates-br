#!/usr/bin/env node
// GANGWAY WALK CONTRACT — a berthed ship's boarding plank must be walkable.
//
// The plank is shared geometry (getShipGangwayPlan / getGangwayFloorY): the
// renderer draws it, PhysicsSystem stands players on it. But the swimmer/hull
// pushout also runs on 'alive' walkers below the deck rail (that's what stops
// walk-through-the-hull at a dock), and the plank's inboard end sits INSIDE the
// hull footprint by construction — it hangs off the cap rail. Without an
// exemption the pushout shoves anyone near the ship end of the plank sideways
// off it and into the sea.
//
// This walks a pirate from the dock deck up the plank, for all three hull
// classes, at every dock in the fixed world, through the REAL PhysicsSystem.
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { getShipGangwayPlan } from '../src/shared/interactions.js';
import { SHIP_STATS, PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const match = new Match({ matchId: 'gangway-walk', botCount: 0 });
const state = match['state'];
const mapGen = match['mapGen'];
const physics = new PhysicsSystem();
const dockIslands = state.islands.filter((island) => island.dock);

console.log(`Gangway walk (${dockIslands.length} docks × 3 hulls)`);

const results = [];
for (const type of ['sloop', 'brigantine', 'galleon']) {
  for (const island of dockIslands) {
    const dock = island.dock;
    const ship = mapGen.buildShip(`gw-${type}`, 'owner', { position: { x: 0, y: 0, z: 0 }, rotation: 0, type }, 0x3366cc);
    match['parkShipAtDock'](ship, dock);
    ship.anchored = true;
    const plan = getShipGangwayPlan(ship, dock);
    if (!plan) { results.push({ type, island: island.name, plan: false }); continue; }

    // Face the plank and walk it, dock end → ship end, at plain walk speed.
    const dirX = plan.shipEnd.x - plan.dockEnd.x;
    const dirZ = plan.shipEnd.z - plan.dockEnd.z;
    const span = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / span;
    const uz = dirZ / span;

    const player = match['createPlayer']('gw-walker', 'Walker', null, false);
    player.position = { x: plan.dockEnd.x - ux * 1.0, y: plan.dockEnd.y + 0.15, z: plan.dockEnd.z - uz * 1.0 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.state = 'alive';
    player.onShipId = null;

    const dt = 1 / 30;
    let t = 0;
    let swam = false;
    let worstOffAxis = 0;
    let boarded = false;
    const deckY = ship.position.y + SHIP_STATS[type].height;
    for (let step = 0; step < 240; step++) {
      // Match.applyInput's walk step, then the server physics resolve.
      player.velocity.x = ux * PLAYER.MOVE_SPEED;
      player.velocity.z = uz * PLAYER.MOVE_SPEED;
      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
      physics.update(dt, t, [ship], [player], [], state.islands, state.seaRocks ?? [], null);
      t += dt;
      if (player.state === 'swimming') swam = true;
      const rx = player.position.x - plan.dockEnd.x;
      const rz = player.position.z - plan.dockEnd.z;
      const along = rx * ux + rz * uz;
      if (along > -0.2 && along < span + 0.4) worstOffAxis = Math.max(worstOffAxis, Math.abs(rx * uz - rz * ux));
      if (player.onShipId === ship.id && player.position.y > deckY - 0.6) {
        boarded = true;
        break;
      }
    }
    results.push({ type, island: island.name, plan: true, boarded, swam, worstOffAxis, span });
  }
}

const planked = results.filter((r) => r.plan);
expect('every dock offers a boarding plank for every hull class', planked.length === results.length,
  results.filter((r) => !r.plan).map((r) => `${r.type} @ ${r.island}`).join(', '));

const dunked = planked.filter((r) => r.swam);
expect('walking the plank never dunks the pirate', dunked.length === 0,
  dunked.map((r) => `${r.type} @ ${r.island}`).join('\n     '));

const shoved = planked.filter((r) => r.worstOffAxis > 0.9);
expect('the hull pushout never shoves a plank walker sideways off it', shoved.length === 0,
  shoved.map((r) => `${r.type} @ ${r.island}: offAxis=${r.worstOffAxis.toFixed(2)}m`).join('\n     '));

const stranded = planked.filter((r) => !r.boarded);
expect('the walk reaches the deck on every plank', stranded.length === 0,
  stranded.map((r) => `${r.type} @ ${r.island}: offAxis=${r.worstOffAxis.toFixed(2)} span=${r.span.toFixed(2)}`).join('\n     '));

console.log(`     planks=${planked.length} worstOffAxis=${Math.max(...planked.map((r) => r.worstOffAxis)).toFixed(2)}m`);

if (failures > 0) {
  console.error(`\n${failures} gangway-walk assertion(s) failed.`);
  process.exit(1);
}
console.log('\nUp the plank and over the rail, on every hull.');
