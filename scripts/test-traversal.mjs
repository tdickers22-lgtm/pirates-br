#!/usr/bin/env node
// Traversal integrity: (1) swimmers can never dive under the island shell —
// the underwater apron (distRatio ≤ ~1.16) has a real seabed and submerged
// rock faces act as walls; (2) rope bridges are REAL: server-generated
// endpoints sit flush on terrain, the shared deck is a standing surface, and
// walking under a bridge does not teleport you onto it.
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PLAYER } from '../src/shared/constants/index.ts';
import * as THREE from 'three';
import { buildBridges } from '../src/client/world/island/Landmarks.ts';
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

console.log('Peak routes and rendered plank parity:');
{
  const islands = new MapGenerator(20260801).generateIslands();
  const mountains = islands.filter((i) => i.profile.terrainStyle === 'mountain');
  expect('Every mountain in the fixed archipelago has a suspended peak route',
    mountains.length >= 3 && mountains.every((i) => i.bridges.length > 0));
  let rendered = 0, maxDeckError = 0, badWidth = false, blockedDeck = false;
  for (const island of islands.filter((i) => i.bridges?.length)) {
    const group = new THREE.Group();
    group.position.set(island.position.x, 0, island.position.z);
    buildBridges({ island, group, rng: () => 0.5,
      boulderGeo: new THREE.IcosahedronGeometry(1, 0), boulderMat: new THREE.MeshStandardMaterial() });
    group.updateMatrixWorld(true);
    for (let b = 0; b < island.bridges.length; b++) {
      const bridge = island.bridges[b];
      const node = group.children[b];
      for (const mesh of node.children) {
        if (!mesh.isMesh || mesh.geometry.parameters?.height !== 0.10) continue;
        const top = mesh.localToWorld(new THREE.Vector3(0, 0.05, 0));
        const deck = getBridgeDeckY(bridge, top.x, top.z);
        badWidth ||= Math.abs(mesh.geometry.parameters.width - bridge.width) > 1e-6;
        maxDeckError = Math.max(maxDeckError, deck === null ? 100 : Math.abs(top.y - deck));
        rendered++;
      }
      for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const x = bridge.ax + (bridge.bx - bridge.ax) * t;
        const z = bridge.az + (bridge.bz - bridge.az) * t;
        const y = getBridgeDeckY(bridge, x, z);
        const walker = makePlayer({ x, y: y + 0.03, z });
        const physics = new PhysicsSystem();
        for (let n = 0; n < 30; n++) step(physics, walker, [island], null);
        if (walker.state === 'swimming' || Math.abs(walker.position.y - y) > 0.3) blockedDeck = true;
      }
    }
    group.traverse((o) => { o.geometry?.dispose(); });
  }
  expect('Every rendered plank matches the standing surface and full collision width',
    rendered > 100 && maxDeckError < 1e-5 && !badWidth, `${rendered} planks, error ${maxDeckError}`);
  expect('Peak and channel crossings remain dry standing surfaces along their span', !blockedDeck);

  // Explicitly force a deep channel beneath a high bridge. This isolates the
  // water-entry bug from whichever land shape the seeded map happens to roll.
  const island = structuredClone(islands.find((i) => i.bridges.length > 0));
  island.props = []; island.caves = [];
  const bridge = island.bridges[0];
  const x = (bridge.ax + bridge.bx) * 0.5, z = (bridge.az + bridge.bz) * 0.5;
  island.stamps = [{ x, z, radius: 8, targetY: -5, blend: 0.35 }];
  expect('Channel fixture has a submerged seabed', getIslandSurfaceY(island, x, z) < -3);
  const deck = getBridgeDeckY(bridge, x, z);
  const walker = makePlayer({ x, y: deck + 0.03, z });
  const physics = new PhysicsSystem();
  for (let n = 0; n < 50; n++) step(physics, walker, [island], null);
  expect('A deep channel under a bridge cannot force its walker into swimming',
    walker.state !== 'swimming' && Math.abs(walker.position.y - deck) < 0.1);
}

// ── The pier's edge is the last plank (physics-11, PHYSREM-01) ───────────────
// The server's dock footing carried a 0.45 m pad, so a pirate whose feet were
// past the drawn planking still stood at deck height — she walked off the end
// of the pier and kept walking, on open water. The drawn deck is exactly
// width x length (the GLB modules are 3 m wide and getShipGangwayPlan attaches
// its plank at exactly width*0.5), so anything beyond that half-extent must be
// a fall, and everything inside it must still hold her up.
{
  const docked = new MapGenerator(20260801).generateIslands().filter((i) => i.dock);
  expect('The fixed archipelago has piers to walk off', docked.length >= 3,
    `docks=${docked.length}`);
  let heldOnAir = 0;
  let fellThroughPlanking = 0;
  let cases = 0;
  const worst = [];
  for (const island of docked) {
    const dock = island.dock;
    const cos = Math.cos(dock.rotation);
    const sin = Math.sin(dock.rotation);
    const toWorld = (lx, lz) => ({
      x: dock.position.x + lx * cos + lz * sin,
      z: dock.position.z - lx * sin + lz * cos,
    });
    const deckY = dock.position.y + 0.14;
    // Sample along the pier's long axis, on the seaward half only: the inboard
    // end runs onto the shore, where the island surface legitimately catches her.
    for (let f = -0.35; f <= 0.45; f += 0.1) {
      const lz = f * dock.length;
      // 0.30 m INSIDE the edge must hold; 0.30 m OUTSIDE it must not.
      for (const [lx, mustHold] of [
        [dock.width * 0.5 - 0.3, true],
        [-(dock.width * 0.5 - 0.3), true],
        [dock.width * 0.5 + 0.3, false],
        [-(dock.width * 0.5 + 0.3), false],
      ]) {
        const w = toWorld(lx, lz);
        // Only grade spots that are genuinely over WATER, so the island's own
        // surface under the inboard end never masks the result either way.
        if (getIslandSurfaceY(island, w.x, w.z) > deckY - 1.5) continue;
        cases += 1;
        const p = makePlayer({ x: w.x, y: deckY + 0.05, z: w.z });
        const physics = new PhysicsSystem();
        for (let n = 0; n < 30; n++) step(physics, p, [island], null);
        const held = Math.abs(p.position.y - deckY) < 0.35 && p.state !== 'swimming';
        if (mustHold && !held) {
          fellThroughPlanking += 1;
          if (worst.length < 3) worst.push(`${island.name ?? island.id} lx=${lx.toFixed(2)} fell to y=${p.position.y.toFixed(2)}`);
        }
        if (!mustHold && held) {
          heldOnAir += 1;
          if (worst.length < 3) worst.push(`${island.name ?? island.id} lx=${lx.toFixed(2)} stood on air at y=${p.position.y.toFixed(2)}`);
        }
      }
    }
  }
  expect('Graded a real population of pier-edge stands', cases >= 24, `cases=${cases}`);
  expect('Nobody stands on the water past the last plank', heldOnAir === 0,
    `stood on air in ${heldOnAir}/${cases} cases; ${worst.join('; ')}`);
  expect('The planking itself still holds a pirate up', fellThroughPlanking === 0,
    `fell through in ${fellThroughPlanking}/${cases} cases; ${worst.join('; ')}`);
}

if (failures > 0) {
  console.error(`\n${failures} traversal assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll traversal assertions passed.');
