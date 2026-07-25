#!/usr/bin/env node
// Traversal integrity: (1) swimmers can never dive under the island shell —
// the underwater apron (distRatio ≤ ~1.16) has a real seabed and submerged
// rock faces act as walls; (2) rope bridges are REAL: server-generated
// endpoints sit flush on terrain, the shared deck is a standing surface, and
// walking under a bridge does not teleport you onto it.
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PLAYER } from '../src/shared/constants/index.ts';
import {
  getIslandSurfaceY,
  getIslandDistRatio,
  getBridgeDeckY,
  gerstnerHeight,
  WAVE_PARAMS,
} from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 62.5;
const T = 0;

function makePlayer(position, overrides = {}) {
  return {
    id: 'traversal-tester', name: 'Tester', shipId: null,
    position: { ...position }, rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH, state: 'alive', weapons: [], activeSlot: 0,
    reloading: false, reloadTimer: 0, knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false, kills: 0, playerKillStreak: 0, superCannonballs: 0, megaKegs: 0,
    tsunamiCharges: 0, gold: 0, carryingChestId: null, treasureMapIslandId: null,
    swimTimer: 0, atCannon: false, atHelm: false, sailControlMode: null,
    atCrowNest: false, blocking: false, cutlassCharge: 0, cannonIndex: 0,
    nearChestId: null, nearShipId: null, onShipId: null, respawnTimer: 0,
    respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0, lastDamagedById: null,
    lastDamagedAt: null, lastDamageWasHeadshot: false, selectedCannonAmmo: 'cannonball',
    kegs: 0, kegCooldown: 0, cannonFlightTimer: 0, cannonBallistic: false,
    pocketBanana: 0, pocketWood: 0, pocketCoconut: 0, pocketMango: 0, pocketMeat: 0,
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null,
    downedUntil: 0, reviveProgress: 0, hasSpyglass: false,
    ...overrides,
  };
}

function step(physics, player, islands, dir) {
  if (dir) {
    player.velocity.x = dir.x;
    player.velocity.z = dir.z;
    player.position.x += player.velocity.x * DT;
    player.position.z += player.velocity.z * DT;
  }
  physics.update(DT, T, [], [player], [], islands, []);
}

const POOL = [];
for (const seed of [101, 202, 303, 404, 505]) {
  POOL.push(...new MapGenerator(seed).generateIslands());
}

console.log('Swim-under-shell protection:');
{
  // Find a coast where the terrain just outside the footprint is underwater
  // (the apron) but rises above swim depth within the footprint.
  let site = null;
  outer: for (const island of POOL) {
    for (let a = 0; a < 64 && !site; a++) {
      const angle = (a / 64) * Math.PI * 2;
      // Point on the apron (distRatio ~1.1)
      for (let rr = 1.06; rr <= 1.14; rr += 0.04) {
        const gx = island.position.x + Math.cos(angle) * island.radius * rr * island.profile.footprintX;
        const gz = island.position.z + Math.sin(angle) * island.radius * rr * island.profile.footprintZ;
        const apronY = getIslandSurfaceY(island, gx, gz);
        const waveY = gerstnerHeight(gx, gz, T, WAVE_PARAMS);
        // inward point that is clearly above the swimmer's head at depth
        const ix = island.position.x + Math.cos(angle) * island.radius * 0.9 * island.profile.footprintX;
        const iz = island.position.z + Math.sin(angle) * island.radius * 0.9 * island.profile.footprintZ;
        const innerY = getIslandSurfaceY(island, ix, iz);
        if (apronY < waveY - 1.6 && innerY > apronY + 2.2) {
          site = { island, x: gx, z: gz, apronY, dirX: (ix - gx), dirZ: (iz - gz) };
          break outer;
        }
      }
    }
  }
  expect('Found an underwater apron outside the footprint with rising rock inside', site !== null);
  if (site) {
    const { island } = site;
    const physics = new PhysicsSystem();
    // 1. Seabed exists beyond the footprint: drop a swimmer below the apron sand.
    const player = makePlayer(
      { x: site.x, y: site.apronY - 2.0, z: site.z },
      { state: 'swimming' },
    );
    step(physics, player, [island], null);
    expect(
      'Apron seabed clamps a swimmer trying to sink under the shell',
      player.position.y >= site.apronY - 0.05,
      `y=${player.position.y.toFixed(2)} apron=${site.apronY.toFixed(2)}`,
    );
    const { distRatio } = getIslandDistRatio(island, player.position.x, player.position.z);
    expect('...and that clamp applied OUTSIDE the walk footprint', distRatio > 1.0, `distRatio=${distRatio.toFixed(3)}`);

    // 2. Rock wall: swim hard toward the island at depth — must never end up
    // inside terrain that rises above head height.
    const mag = Math.hypot(site.dirX, site.dirZ);
    const dir = { x: (site.dirX / mag) * PLAYER.SWIM_SPEED, z: (site.dirZ / mag) * PLAYER.SWIM_SPEED };
    let violated = false;
    for (let i = 0; i < 400; i++) {
      step(physics, player, [island], dir);
      const ground = getIslandSurfaceY(island, player.position.x, player.position.z);
      const waveY = gerstnerHeight(player.position.x, player.position.z, T, WAVE_PARAMS);
      // Surface-level contact with a near-vertical face is fine (the wall pins
      // you there); the failure mode is being DEEP while under the ground —
      // i.e., genuinely inside/under the island shell.
      if (player.position.y < waveY - 1.2 && ground > player.position.y + 0.75) { violated = true; break; }
    }
    expect('Swimming into the coast never phases deep inside submerged rock', !violated,
      `pos=(${player.position.x.toFixed(1)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(1)})`);
  }
}

console.log('Walkable rope bridges:');
{
  const bridged = POOL.filter((island) => (island.bridges?.length ?? 0) > 0);
  expect('Bridge registry generated for split-landmass islands', bridged.length >= 1, `found ${bridged.length}`);
  if (bridged.length > 0) {
    const island = bridged[0];
    const bridge = island.bridges[0];
    expect(
      'Endpoint A sits flush on the terrain',
      Math.abs(getIslandSurfaceY(island, bridge.ax, bridge.az) - bridge.ay) < 0.01,
    );
    expect(
      'Endpoint B sits flush on the terrain',
      Math.abs(getIslandSurfaceY(island, bridge.bx, bridge.bz) - bridge.by) < 0.01,
    );
    const midX = (bridge.ax + bridge.bx) * 0.5;
    const midZ = (bridge.az + bridge.bz) * 0.5;
    const deckY = getBridgeDeckY(bridge, midX, midZ);
    expect('Deck height defined at mid-span', deckY !== null);
    const saddleY = getIslandSurfaceY(island, midX, midZ);
    expect('Bridge actually spans a dip (deck clears the saddle)', deckY - saddleY > 1.2,
      `deck=${deckY?.toFixed(2)} saddle=${saddleY.toFixed(2)}`);

    // Stand on the deck: no input, must not fall through to the saddle.
    const physics = new PhysicsSystem();
    const walker = makePlayer({ x: midX, y: deckY + 0.03, z: midZ });
    for (let i = 0; i < 40; i++) step(physics, walker, [island], null);
    expect('A pirate stands ON the deck at mid-span', Math.abs(walker.position.y - deckY) < 0.5,
      `y=${walker.position.y.toFixed(2)} deck=${deckY.toFixed(2)}`);

    // Walk under it: someone crossing the saddle must NOT get teleported up.
    const under = makePlayer({ x: midX, y: saddleY + 0.03, z: midZ });
    for (let i = 0; i < 40; i++) step(physics, under, [island], null);
    expect('Crossing the saddle below does not snap you onto the bridge',
      under.position.y < deckY - 0.8,
      `y=${under.position.y.toFixed(2)} deck=${deckY.toFixed(2)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} traversal assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll traversal assertions passed.');
