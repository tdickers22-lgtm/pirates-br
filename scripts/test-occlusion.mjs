#!/usr/bin/env node
// Occlusion contract: hitscan + projectiles stop at island terrain, ship hulls
// and the real wave surface. Imports the REAL server/shared modules via tsx.
import { raymarchIslandSurface, intersectRayShipHull } from '../src/shared/raycast.ts';
import { gerstnerHeight, WAVE_PARAMS, getIslandSurfaceY, getIslandMaxRadius } from '../src/shared/utils/index.ts';
import { SHIP_STATS, PLAYER } from '../src/shared/constants/index.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { Match } from '../src/server/core/Match.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function makeIsland(position = { x: 0, y: 0, z: 0 }) {
  return {
    id: 'isle-test',
    name: 'Test Peak',
    position,
    radius: 80,
    profile: {
      islandHeading: 0,
      footprintX: 1.2,
      footprintZ: 1.2,
      heightProfile: 0.9,
      beachSpread: 1.15,
      ridgeAxis: 0,
      ridgeBias: 0,
      mesaBias: 0.3,
      primaryHillAngle: 0,
      secondaryHillAngle: Math.PI,
      tertiaryHillAngle: Math.PI / 2,
      primaryHillOffset: 0,
      secondaryHillOffset: 20,
      tertiaryHillOffset: 10,
      secondaryHillScale: 0.5,
      tertiaryHillScale: 0,
      peakBoost: 1.2,
      terrainStyle: 'mountain',
      inlets: [],
    },
    dock: null,
    tavern: null,
    caves: [],
    chests: [],
    barrels: [],
    upgradeStations: [],
    npcs: [],
  };
}

function makeShip(id, position, rotation = 0, type = 'sloop') {
  return { id, type, position, rotation, alive: true, sinking: false };
}

function makeProjectile(overrides = {}) {
  return {
    id: 'proj-test',
    type: 'cannonball',
    ownerId: 'shooter',
    ownerShipId: null,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    age: 0,
    maxAge: 8,
    damage: 120,
    knockback: 0,
    visualOnly: false,
    showImpact: true,
    ...overrides,
  };
}

function makePlayer(id, overrides = {}) {
  return {
    id,
    name: id,
    shipId: null,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH,
    state: 'alive',
    weapons: [],
    activeSlot: 0,
    knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false,
    kills: 0,
    gold: 0,
    swimTimer: 0,
    onShipId: null,
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
    lastDamagedById: null,
    lastDamageWasHeadshot: false,
    cannonBallistic: false,
    cannonFlightTimer: 0,
    ...overrides,
  };
}

// ── 1. Terrain raymarch ─────────────────────────────────────────────────────
console.log('Island terrain raymarch');
{
  const island = makeIsland();
  const peakY = getIslandSurfaceY(island, 0, 0);
  expect('Fixture island has a proper peak', peakY > 15, `peakY=${peakY.toFixed(2)}`);

  const through = raymarchIslandSurface({ x: -250, y: 8, z: 0 }, { x: 1, y: 0, z: 0 }, 500, [island]);
  expect('Low ray through the island hits terrain', through.hit, `distance=${through.distance}`);
  if (through.hit) {
    expect('Hit lands on the near half of the island', through.distance > 120 && through.distance < 260, `distance=${through.distance.toFixed(2)}`);
    const surfY = getIslandSurfaceY(island, through.point.x, through.point.z);
    expect('Hit point sits on the terrain surface', Math.abs(through.point.y - surfY) < 0.6, `pointY=${through.point.y.toFixed(2)} surfY=${surfY.toFixed(2)}`);
  }

  const above = raymarchIslandSurface({ x: -250, y: 150, z: 0 }, { x: 1, y: 0, z: 0 }, 500, [island]);
  expect('Ray well above the peak misses', !above.hit, `distance=${above.distance}`);

  const beside = raymarchIslandSurface({ x: -250, y: 8, z: 400 }, { x: 1, y: 0, z: 0 }, 500, [island]);
  expect('Ray far beside the island misses', !beside.hit);

  const upward = raymarchIslandSurface({ x: 0, y: peakY + 1.6, z: 0 }, { x: 0, y: 1, z: 0 }, 500, [island]);
  expect('Shooting straight up from the peak misses', !upward.hit);

  const down = raymarchIslandSurface({ x: 0, y: 200, z: 0 }, { x: 0, y: -1, z: 0 }, 400, [island]);
  expect('Falling ray hits the peak from above', down.hit && Math.abs((200 - down.distance) - peakY) < 0.6, `distance=${down.distance.toFixed(2)} peakY=${peakY.toFixed(2)}`);
}

// ── 2. Ship hull line test ──────────────────────────────────────────────────
console.log('\nShip hull line test');
{
  const ship = makeShip('ship-hull', { x: 0, y: 0.5, z: 0 }, 0);
  const stats = SHIP_STATS.sloop;

  const beam = intersectRayShipHull({ x: -30, y: 1.2, z: 0 }, { x: 1, y: 0, z: 0 }, 200, ship);
  expect('Beam-on ray at deck-side height hits the hull', beam !== null && beam > 25 && beam < 28.5, `distance=${beam}`);

  const overRail = intersectRayShipHull(
    { x: -30, y: ship.position.y + stats.height + 1.1, z: 0 },
    { x: 1, y: 0, z: 0 }, 200, ship,
  );
  expect('Ray above the bulwark rail passes clean', overRail === null, `distance=${overRail}`);

  const pastBow = intersectRayShipHull({ x: -30, y: 1.2, z: stats.length * 0.52 + 1.2 }, { x: 1, y: 0, z: 0 }, 200, ship);
  expect('Ray past the bow misses', pastBow === null, `distance=${pastBow}`);
}

// ── 3. Cannonball dies against a hill ───────────────────────────────────────
console.log('\nCannonball vs island terrain');
{
  const island = makeIsland();
  const physics = new PhysicsSystem();
  const proj = makeProjectile({ position: { x: -160, y: 6, z: 0 }, velocity: { x: 60, y: 6, z: 0 } });
  const dt = 1 / 60;
  let t = 100; // arbitrary sim time
  for (let i = 0; i < 60 * 8 && proj.alive; i++) {
    physics.update(dt, t, [], [], [proj], [island], []);
    t += dt;
  }
  expect('Cannonball dies before crossing the island', !proj.alive && proj.position.x < 40, `alive=${proj.alive} x=${proj.position.x.toFixed(2)}`);
  expect('Cannonball died on terrain, not in the sea', proj.position.y > 3, `y=${proj.position.y.toFixed(2)}`);
  expect('Terrain impact keeps the client impact FX flag', proj.showImpact === true);
  expect('Impact point is inside the island footprint', Math.hypot(proj.position.x, proj.position.z) < getIslandMaxRadius(island), `r=${Math.hypot(proj.position.x, proj.position.z).toFixed(1)}`);
}

// ── 4. Projectile dies at the wave surface, not y=0 ─────────────────────────
console.log('\nProjectile vs wave surface');
{
  // Find sim times with a solid crest and a deep trough at a fixed spot.
  let crestT = null;
  let troughT = null;
  for (let t = 0; t < 900 && (crestT === null || troughT === null); t += 0.25) {
    const h = gerstnerHeight(50, 50, t, WAVE_PARAMS);
    if (crestT === null && h > 0.45) crestT = t;
    if (troughT === null && h < -0.5) troughT = t;
  }
  expect('Found a wave crest > 0.45m and a trough < -0.5m', crestT !== null && troughT !== null, `crestT=${crestT} troughT=${troughT}`);

  if (crestT !== null) {
    const physics = new PhysicsSystem();
    const dt = 1 / 60;
    const proj = makeProjectile({ position: { x: 50, y: 0.35, z: 50 }, velocity: { x: 0, y: -0.5, z: 0 } });
    physics.update(dt, crestT + dt, [], [], [proj], [], []);
    expect('Projectile below a crest dies while still above y=0', !proj.alive && proj.position.y > 0, `alive=${proj.alive} y=${proj.position.y.toFixed(3)}`);
  }
  if (troughT !== null) {
    const physics = new PhysicsSystem();
    const dt = 1 / 60;
    const proj = makeProjectile({ position: { x: 50, y: -0.15, z: 50 }, velocity: { x: 0, y: 0, z: 0 } });
    physics.update(dt, troughT + dt, [], [], [proj], [], []);
    expect('Projectile skimming a trough below y=0 survives', proj.alive, `alive=${proj.alive} y=${proj.position.y.toFixed(3)}`);
  }
}

// ── 5. Projectile torso capsule honours pose ────────────────────────────────
console.log('\nProjectile vs player pose');
{
  const dt = 1 / 60;
  {
    const physics = new PhysicsSystem();
    const target = makePlayer('standing', { position: { x: 200, y: 0, z: 200 }, state: 'alive' });
    // Ends the tick at chest height (~1.25m above feet) — the old feet-sphere whiffed here.
    const proj = makeProjectile({ position: { x: 199.5, y: 1.25, z: 200.2 }, velocity: { x: 30, y: 0, z: 0 } });
    physics.update(dt, 5, [], [target], [proj], [], []);
    expect('Chest-height cannonball hits a standing player', !proj.alive && target.health < PLAYER.MAX_HEALTH, `alive=${proj.alive} health=${target.health}`);
  }
  {
    const physics = new PhysicsSystem();
    const target = makePlayer('standing2', { position: { x: 200, y: 0, z: 200 }, state: 'alive' });
    const proj = makeProjectile({ position: { x: 199.5, y: 2.6, z: 200 }, velocity: { x: 30, y: 0, z: 0 } });
    physics.update(dt, 5, [], [target], [proj], [], []);
    expect('Ball well above the head still misses', proj.alive && target.health === PLAYER.MAX_HEALTH, `alive=${proj.alive} health=${target.health}`);
  }
  {
    const physics = new PhysicsSystem();
    // Swimming pose lies horizontal along yaw (+x here); head is ~0.6m ahead of feet.
    const target = makePlayer('swimmer', {
      position: { x: 300, y: 0, z: 300 },
      state: 'swimming',
      rotation: { x: Math.PI / 2, y: 0 },
    });
    const proj = makeProjectile({ position: { x: 300.42, y: 0.55, z: 299.7 }, velocity: { x: 0.5, y: 0, z: 30 } });
    physics.update(dt, 5, [], [target], [proj], [], []);
    expect('Ball at swim-body height hits the horizontal pose', !proj.alive && target.health < PLAYER.MAX_HEALTH, `alive=${proj.alive} health=${target.health}`);
  }
}

// ── 6. Match hitscan occlusion end-to-end ───────────────────────────────────
console.log('\nMatch hitscan occlusion');
{
  const match = new Match({ matchId: 'occlusion-test', botCount: 0 });
  const state = match.state;
  state.ships = [];
  state.seaRocks = [];
  state.sharks = [];
  state.wildlife = [];
  state.kegs = [];

  const shooter = makePlayer('shooter', { position: { x: -150, y: 8, z: 0 } });
  const target = makePlayer('target', { position: { x: 150, y: 8, z: 0 } });
  state.players = [shooter, target];
  match.playersById = new Map(state.players.map((p) => [p.id, p]));

  const makeTrace = (origin, direction, range = 5000) => {
    const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
    return {
      origin: { ...origin },
      direction: { x: direction.x / len, y: direction.y / len, z: direction.z / len },
      range,
      damage: 40,
      knockback: 0,
      weaponId: 'eye_of_reach',
    };
  };

  // Island between shooter and target blocks the shot.
  state.islands = [makeIsland()];
  match.resolveFirearmHits(shooter, [makeTrace({ x: -150, y: 9, z: 0 }, { x: 1, y: 0, z: 0 })]);
  expect('Island between shooter and target blocks hitscan', target.health === PLAYER.MAX_HEALTH, `health=${target.health}`);

  // Same shot with a clear path lands.
  state.islands = [];
  match.resolveFirearmHits(shooter, [makeTrace({ x: -150, y: 9, z: 0 }, { x: 1, y: 0, z: 0 })]);
  expect('Same shot with a clear path lands', target.health < PLAYER.MAX_HEALTH, `health=${target.health}`);

  // Ship hull between shooter and a swimmer behind it blocks the shot.
  const blocker = makeShip('ship-blocker', { x: 0, y: 0.5, z: 0 }, 0);
  state.ships = [blocker];
  const swimmer = makePlayer('swimmer-behind', {
    position: { x: 30, y: 0.5, z: 0 },
    state: 'swimming',
    rotation: { x: 0, y: 0 },
  });
  const seaShooter = makePlayer('sea-shooter', { position: { x: -30, y: 0.5, z: 0 }, state: 'swimming' });
  state.players = [seaShooter, swimmer];
  match.playersById = new Map(state.players.map((p) => [p.id, p]));
  match.resolveFirearmHits(seaShooter, [makeTrace({ x: -30, y: 1.2, z: 0 }, { x: 1, y: 0, z: 0 })]);
  expect('Hull blocks a shot at a swimmer behind the ship', swimmer.health === PLAYER.MAX_HEALTH, `health=${swimmer.health}`);

  state.ships = [];
  match.resolveFirearmHits(seaShooter, [makeTrace({ x: -30, y: 1.2, z: 0 }, { x: 1, y: 0, z: 0 })]);
  expect('Removing the ship lets the same shot land', swimmer.health < PLAYER.MAX_HEALTH, `health=${swimmer.health}`);

  // Shooter standing on their own ship shoots outward-down past their bulwark.
  state.ships = [blocker];
  const deckShooter = makePlayer('deck-shooter', {
    position: { x: 0, y: 2.8, z: 0 },
    onShipId: blocker.id,
  });
  const nearSwimmer = makePlayer('near-swimmer', {
    position: { x: 5.5, y: 0.3, z: 0 },
    state: 'swimming',
    rotation: { x: Math.PI / 2, y: 0 },
  });
  state.players = [deckShooter, nearSwimmer];
  match.playersById = new Map(state.players.map((p) => [p.id, p]));
  const muzzle = { x: 0, y: 4.14, z: 0 };
  const aim = { x: 5.62 - muzzle.x, y: 0.72 - muzzle.y, z: 0 - muzzle.z };
  match.resolveFirearmHits(deckShooter, [makeTrace(muzzle, aim, 100)]);
  expect('Own hull never blocks shooting outward from deck', nearSwimmer.health < PLAYER.MAX_HEALTH, `health=${nearSwimmer.health}`);
}

// ── 7. Solid structures stop bullets (tavern walls + big props) ─────────────
// Cover that reads as solid has to BE solid: snipers used to shoot clean through
// the tavern, boulders, towers and the fort.
console.log('\nHitscan vs island structures');
{
  const match = new Match({ matchId: 'structure-occlusion', botCount: 0 });
  const island = makeIsland();
  const groundY = getIslandSurfaceY(island, 0, 0);

  // Boulder_b (r=2.6, h=2.0) sitting on the island peak.
  island.props = [{ id: 1, type: 'boulder_b', x: 0, z: 0, yaw: 0, scale: 1 }];
  match.state.islands = [island];

  const trace = (origin, dir, maxDistance = 40) => {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return match.intersectRayIslandStructures(
      origin,
      { x: dir.x / len, y: dir.y / len, z: dir.z / len },
      maxDistance,
    );
  };

  const throughBoulder = trace({ x: -12, y: groundY + 1, z: 0 }, { x: 1, y: 0, z: 0 });
  expect('Shot through a boulder is blocked', throughBoulder !== null && Math.abs(throughBoulder - 9.66) < 0.6, `distance=${throughBoulder}`);
  const besideBoulder = trace({ x: -12, y: groundY + 1, z: 6 }, { x: 1, y: 0, z: 0 });
  expect('Shot beside the same boulder is clear', besideBoulder === null, `distance=${besideBoulder}`);
  const overBoulder = trace({ x: -12, y: groundY + 3.2, z: 0 }, { x: 1, y: 0, z: 0 });
  expect('Shot over the boulder is clear', overBoulder === null, `distance=${overBoulder}`);

  // Palms are deliberately shoot-through (thin capsules, arcade feel).
  island.props = [{ id: 2, type: 'palm_a', x: 0, z: 0, yaw: 0, scale: 1 }];
  expect('Palm trunks stay shoot-through', trace({ x: -12, y: groundY + 1, z: 0 }, { x: 1, y: 0, z: 0 }) === null);

  // Tavern shell: walls block, the doorway does not.
  island.props = [];
  island.tavern = {
    position: { x: 0, y: groundY, z: 0 },
    rotation: 0,
    width: 7.6,
    depth: 6.4,
    counterPosition: { x: 0, y: groundY + 0.18, z: -1.8 },
  };
  const throughWall = trace({ x: -12, y: groundY + 1, z: 0 }, { x: 1, y: 0, z: 0 });
  expect('Shot through the tavern side wall is blocked', throughWall !== null && Math.abs(throughWall - 8.02) < 0.4, `distance=${throughWall}`);
  const outTheDoor = trace({ x: 0, y: groundY + 1, z: 0 }, { x: 0, y: 0, z: 1 });
  expect('Shooting out through the doorway is clear', outTheDoor === null, `distance=${outTheDoor}`);
  const outTheBack = trace({ x: 0, y: groundY + 1, z: 0 }, { x: 0, y: 0, z: -1 });
  expect('Shooting into the back wall is blocked', outTheBack !== null && outTheBack < 3.6, `distance=${outTheBack}`);
  const overRoof = trace({ x: -12, y: groundY + 5, z: 0 }, { x: 1, y: 0, z: 0 });
  expect('Shot above the tavern roof line is clear', overRoof === null, `distance=${overRoof}`);
}

if (failures > 0) {
  console.error(`\n${failures} occlusion assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll occlusion assertions passed.');
