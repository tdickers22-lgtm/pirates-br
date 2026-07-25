#!/usr/bin/env node
// Prop / structure collider contract — "if you can see it, you can't walk
// through it" (and where the art says you CAN walk in, you still can).
//
// Drives the REAL PhysicsSystem with body-walk probes (the way BotSystem moves)
// against a flat test island:
//   1. Every visible mass of a compound prop (standing-stone menhirs, fort
//      towers + curtain wall, rock-arch legs, gallows posts) blocks from every
//      azimuth — at prop yaw 0 AND rotated, so the local→world frame is right.
//   2. The designed openings stay open: the stone ring interior, the fort gate,
//      the arch walk-under, the tavern doorway.
//   3. The tavern is a building: all four walls block, the door does not.
//   4. The swim-hull vertical band matches the RENDERED draft constants.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { PLAYER, SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { PROP_COLLIDERS, getPropBoundsRadius } from '../src/shared/props.ts';
import {
  getIslandSurfaceY,
  getSwimHullHalfWidth,
  getSwimHullVerticalBand,
  getSwimHullVerticalT,
  getTavernWallBand,
  getTavernWallSegments,
  tavernLocalToWorld,
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

const DT = 1 / 60;
const PAD_Y = 9;

/** Flat plateau island: a wide stamp removes terrain relief so a walk probe
 *  measures the COLLIDER, never a slope block. */
function makeFlatIsland() {
  return {
    id: 'isle-collider',
    name: 'Collider Flats',
    position: { x: 0, y: 0, z: 0 },
    radius: 120,
    profile: {
      islandHeading: 0,
      footprintX: 1,
      footprintZ: 1,
      heightProfile: 0.4,
      beachSpread: 1.1,
      ridgeAxis: 0,
      ridgeBias: 0,
      mesaBias: 0.3,
      primaryHillAngle: 0,
      secondaryHillAngle: Math.PI,
      tertiaryHillAngle: Math.PI / 2,
      primaryHillOffset: 0,
      secondaryHillOffset: 40,
      tertiaryHillOffset: 20,
      secondaryHillScale: 0.2,
      tertiaryHillScale: 0,
      peakBoost: 0,
      terrainStyle: 'plateau',
      biome: 'lush',
      seed: 4242,
      coastBias: 0,
      inlets: [],
    },
    dock: null,
    tavern: null,
    caves: [],
    chests: [],
    barrels: [],
    upgradeStations: [],
    npcs: [],
    props: [],
    stamps: [{ x: 0, z: 0, radius: 70, targetY: PAD_Y, blend: 0.12 }],
  };
}

function makePlayer(position) {
  return {
    id: 'probe',
    name: 'Probe',
    shipId: null,
    position: { ...position },
    rotation: { x: 0, y: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    knockbackVelocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH,
    state: 'alive',
    weapons: [],
    activeSlot: 0,
    isBot: false,
    kills: 0,
    gold: 0,
    swimTimer: 0,
    onShipId: null,
    nearShipId: null,
    nearChestId: null,
    nearBarrelId: null,
    carryingChestId: null,
    atCannon: false,
    atHelm: false,
    atSails: false,
    atCrowNest: false,
    mastClimb: null,
    cannonBallistic: false,
    cannonFlightTimer: 0,
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
    lastDamagedById: null,
    lastDamagedAt: null,
    lastDamageWasHeadshot: false,
  };
}

/**
 * Body-walk a player from `startDist` metres away toward (tx, tz) along the
 * bearing `angle`, letting the real PhysicsSystem resolve every tick. Returns
 * the closest XZ approach to the target and the finishing position.
 */
function walkProbe(island, tx, tz, angle, startDist = 9, seconds = 4) {
  const dirX = -Math.cos(angle);
  const dirZ = -Math.sin(angle);
  const sx = tx + Math.cos(angle) * startDist;
  const sz = tz + Math.sin(angle) * startDist;
  const player = makePlayer({ x: sx, y: getIslandSurfaceY(island, sx, sz) + 0.05, z: sz });
  const physics = new PhysicsSystem();
  const speed = PLAYER.MOVE_SPEED;
  let closest = Infinity;
  const track = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    player.velocity.x = dirX * speed;
    player.velocity.z = dirZ * speed;
    player.position.x += dirX * speed * DT;
    player.position.z += dirZ * speed * DT;
    physics.update(DT, i * DT, [], [player], [], [island], [], null);
    closest = Math.min(closest, Math.hypot(player.position.x - tx, player.position.z - tz));
    track.push({ x: player.position.x, z: player.position.z });
  }
  return { closest, x: player.position.x, z: player.position.z, track };
}

/** World centre of a compound mass (world = prop + Ry(yaw)·offset). */
function subWorld(prop, sub) {
  const cos = Math.cos(prop.yaw);
  const sin = Math.sin(prop.yaw);
  return {
    x: prop.x + (sub.dx * cos + sub.dz * sin) * prop.scale,
    z: prop.z + (sub.dz * cos - sub.dx * sin) * prop.scale,
  };
}

/** Walk into every mass of a compound prop from 4 bearings each; the closest
 *  approach must never breach the mass's blocking radius. */
function assertMassesBlock(label, island, prop, masses) {
  let worstOverlap = 0;
  let worstDetail = '';
  for (const [mi, sub] of masses.entries()) {
    const c = subWorld(prop, sub);
    const block = sub.radius * prop.scale + PLAYER.RADIUS;
    for (let a = 0; a < 4; a++) {
      const angle = (a / 4) * Math.PI * 2 + 0.31;
      const res = walkProbe(island, c.x, c.z, angle, block + 6);
      const overlap = block - res.closest;
      if (overlap > worstOverlap) {
        worstOverlap = overlap;
        worstDetail = `mass ${mi} bearing ${a}: closest ${res.closest.toFixed(2)} < block ${block.toFixed(2)}`;
      }
    }
  }
  expect(label, worstOverlap <= 0.06, worstDetail);
}

console.log('Compound prop colliders (real PhysicsSystem walk probes)');

// ── 1. Standing stones: every menhir blocks, the ring interior stays open ──
for (const yaw of [0, 1.1]) {
  const island = makeFlatIsland();
  const prop = { id: 1, type: 'standing_stones', x: 0, z: 0, yaw, scale: 1 };
  island.props.push(prop);
  const masses = PROP_COLLIDERS.standing_stones.subColliders;
  assertMassesBlock(`standing_stones (yaw ${yaw}): every menhir blocks`, island, prop, masses);

  // Between two adjacent menhirs (30° off a stone) the ring is enterable.
  const gapAngle = yaw + Math.PI / 6;
  const gap = walkProbe(island, prop.x, prop.z, gapAngle, 9);
  expect(`standing_stones (yaw ${yaw}): ring interior reachable between stones`,
    gap.closest < 1.0, `closest to ring centre ${gap.closest.toFixed(2)}`);
}

// ── 2. Fort: towers + curtain wall block, the gate stays the only way in ──
for (const yaw of [0, -0.8]) {
  const island = makeFlatIsland();
  const prop = { id: 2, type: 'fort', x: 0, z: 0, yaw, scale: 1 };
  island.props.push(prop);
  const subs = PROP_COLLIDERS.fort.subColliders;
  const towers = subs.filter((s) => s.radius > 1);
  assertMassesBlock(`fort (yaw ${yaw}): corner towers block`, island, prop, towers);

  // Curtain wall: approach the courtyard from bearings away from the gate.
  // The gate faces prop-local +Z, i.e. world bearing yaw (from the centre).
  let wallOk = true;
  let wallDetail = '';
  for (const off of [Math.PI * 0.4, Math.PI * 0.75, Math.PI, -Math.PI * 0.75, -Math.PI * 0.4]) {
    const bearing = Math.atan2(Math.cos(yaw), Math.sin(yaw)) + off;
    const res = walkProbe(island, prop.x, prop.z, bearing, 16, 6);
    if (res.closest < 5.3) {
      wallOk = false;
      wallDetail = `bearing offset ${off.toFixed(2)} reached ${res.closest.toFixed(2)}m from the keep`;
    }
  }
  expect(`fort (yaw ${yaw}): curtain wall has no walk-through holes`, wallOk, wallDetail);

  const gateBearing = Math.atan2(Math.cos(yaw), Math.sin(yaw));
  const gate = walkProbe(island, prop.x, prop.z, gateBearing, 16, 6);
  const keepBlock = PROP_COLLIDERS.fort.radius + PLAYER.RADIUS;
  expect(`fort (yaw ${yaw}): gate is enterable`,
    gate.closest <= keepBlock + 0.3, `closest ${gate.closest.toFixed(2)} vs keep block ${keepBlock.toFixed(2)}`);
}

// ── 3. Rock arch: solid legs, open walk-under ──
{
  const yaw = 0.6;
  const island = makeFlatIsland();
  const prop = { id: 3, type: 'rock_arch', x: 0, z: 0, yaw, scale: 1 };
  island.props.push(prop);
  assertMassesBlock('rock_arch: both legs block', island, prop, PROP_COLLIDERS.rock_arch.subColliders);
  // Walking the span axis (prop-local +Z through the centre) stays open.
  const underBearing = Math.atan2(Math.cos(yaw), Math.sin(yaw));
  const under = walkProbe(island, prop.x, prop.z, underBearing, 9);
  expect('rock_arch: walk-under stays clear', under.closest < 0.5, `closest ${under.closest.toFixed(2)}`);
}

// ── 4. Gallows: posts and cart are solid, you can still stand under the beam ──
{
  const yaw = -1.4;
  const island = makeFlatIsland();
  const prop = { id: 4, type: 'gallows', x: 0, z: 0, yaw, scale: 1 };
  island.props.push(prop);
  assertMassesBlock('gallows: posts + cart block', island, prop, PROP_COLLIDERS.gallows.subColliders);
  const betweenBearing = Math.atan2(Math.cos(yaw), Math.sin(yaw));
  const between = walkProbe(island, prop.x, prop.z, betweenBearing, 9);
  expect('gallows: you can still walk between the posts', between.closest < 0.5,
    `closest ${between.closest.toFixed(2)}`);
}

// ── 5. Watchtower / boulder: single-primitive props still block at their size ──
{
  const island = makeFlatIsland();
  const tower = { id: 5, type: 'watchtower', x: 0, z: 0, yaw: 0.4, scale: 1 };
  const boulder = { id: 6, type: 'boulder_a', x: 30, z: 0, yaw: 0, scale: 1 };
  island.props.push(tower, boulder);
  const towerBlock = PROP_COLLIDERS.watchtower.radius + PLAYER.RADIUS;
  let towerOk = true;
  for (let a = 0; a < 6; a++) {
    const res = walkProbe(island, tower.x, tower.z, (a / 6) * Math.PI * 2, towerBlock + 6);
    if (res.closest < towerBlock - 0.06) towerOk = false;
  }
  expect('watchtower blocks at its full masonry radius (2.9)', towerOk);
  const boulderRes = walkProbe(island, boulder.x, boulder.z, 0.9, 8);
  const boulderBlock = PROP_COLLIDERS.boulder_a.radius + PLAYER.RADIUS;
  expect('boulder_a blocks at the trimmed 1.35m silhouette',
    Math.abs(boulderRes.closest - boulderBlock) < 0.12,
    `closest ${boulderRes.closest.toFixed(2)} vs ${boulderBlock.toFixed(2)}`);
}

// ── 6. Tavern: four solid walls, one open door ──
console.log('\nTavern shell');
for (const rotation of [0, 2.2]) {
  const island = makeFlatIsland();
  const y = getIslandSurfaceY(island, 0, 0);
  island.tavern = {
    position: { x: 0, y, z: 0 },
    rotation,
    width: 7.6,
    depth: 6.4,
    counterPosition: { x: 0, y: y + 0.18, z: 0 },
  };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const toWorld = (lx, lz) => ({ x: lx * cos + lz * sin, z: -lx * sin + lz * cos });
  const toLocal = (x, z) => ({ x: x * cos - z * sin, z: x * sin + z * cos });

  // Head-on into each wall panel (the front wall probed well clear of the door,
  // both sides). A short perpendicular run so a blocked walker can't slide
  // around to the doorway — the WALL itself must stop them.
  const insideRoom = (p) => {
    const l = toLocal(p.x, p.z);
    return Math.abs(l.x) < 3.8 - 0.2 && Math.abs(l.z) < 3.2 - 0.2;
  };
  const wallProbes = [
    { name: 'back wall', lx: 0, lz: -3.2, nx: 0, nz: -1 },
    { name: 'port wall', lx: -3.8, lz: 0, nx: -1, nz: 0 },
    { name: 'starboard wall', lx: 3.8, lz: 0, nx: 1, nz: 0 },
    { name: 'front wall port of the door', lx: -2.4, lz: 3.2, nx: 0, nz: 1 },
    { name: 'front wall starboard of the door', lx: 2.4, lz: 3.2, nx: 0, nz: 1 },
  ];
  let wallsOk = true;
  let wallDetail = '';
  for (const probe of wallProbes) {
    const face = toWorld(probe.lx, probe.lz);
    const outward = toWorld(probe.nx, probe.nz);
    const bearing = Math.atan2(outward.z, outward.x);
    const res = walkProbe(island, face.x, face.z, bearing, 3.5, 1.6);
    const breach = res.track.find(insideRoom);
    if (breach) {
      wallsOk = false;
      const l = toLocal(breach.x, breach.z);
      wallDetail = `${probe.name}: walked to local (${l.x.toFixed(2)}, ${l.z.toFixed(2)})`;
    }
  }
  expect(`tavern (rot ${rotation}): all four walls block`, wallsOk, wallDetail);

  const doorDir = toWorld(0, 1);
  const doorBearing = Math.atan2(doorDir.z, doorDir.x);
  const doorRes = walkProbe(island, 0, 0, doorBearing, 12, 5);
  const doorLocal = toLocal(doorRes.x, doorRes.z);
  expect(`tavern (rot ${rotation}): the doorway is genuinely open`,
    doorRes.track.some(insideRoom) && Math.abs(doorLocal.x) < 1.0,
    `ended at local (${doorLocal.x.toFixed(2)}, ${doorLocal.z.toFixed(2)})`);
}

// ── 6b. Real world: every tavern's walls sit inside the collision band ──
// The band is gated on feet height, so if the stamped pad let a wall foot drop
// away the shell would quietly stop blocking on that side.
{
  const islands = new MapGenerator(3).generateIslands();
  const taverns = islands.filter((i) => i.tavern);
  let bandOk = true;
  let bandDetail = '';
  let blockOk = true;
  let blockDetail = '';
  for (const island of taverns) {
    const t = island.tavern;
    const band = getTavernWallBand(t);
    for (const seg of getTavernWallSegments(t)) {
      for (const [lx, lz] of [[seg.minX, seg.minZ], [seg.maxX, seg.maxZ], [(seg.minX + seg.maxX) / 2, (seg.minZ + seg.maxZ) / 2]]) {
        const w = tavernLocalToWorld(t, lx, lz);
        const g = getIslandSurfaceY(island, w.x, w.z);
        if (g < band.minY || g > band.maxY - 1.5) {
          bandOk = false;
          bandDetail = `${island.id}: wall ground ${g.toFixed(2)} outside band [${band.minY.toFixed(2)}, ${band.maxY.toFixed(2)}]`;
        }
      }
    }
    // Walk in through the back wall on real terrain.
    const cos = Math.cos(t.rotation);
    const sin = Math.sin(t.rotation);
    const back = { x: t.position.x - t.depth * 0.5 * sin, z: t.position.z - t.depth * 0.5 * cos };
    const bearing = Math.atan2(back.z - t.position.z, back.x - t.position.x);
    const res = walkProbe(island, back.x, back.z, bearing, 3.5, 1.6);
    const local = { x: (res.x - t.position.x) * cos - (res.z - t.position.z) * sin, z: (res.x - t.position.x) * sin + (res.z - t.position.z) * cos };
    if (Math.abs(local.x) < t.width * 0.5 - 0.2 && Math.abs(local.z) < t.depth * 0.5 - 0.2) {
      blockOk = false;
      blockDetail = `${island.id}: walked inside to local (${local.x.toFixed(2)}, ${local.z.toFixed(2)})`;
    }
  }
  expect(`fixed world: all ${taverns.length} taverns keep their walls inside the collision band`, bandOk, bandDetail);
  expect('fixed world: tavern back wall blocks on real terrain', blockOk, blockDetail);
}

// ── 7. Swim hull band vs the rendered draft ──
console.log('\nSwim hull vs rendered draft');
{
  const expectedDraft = { sloop: 0.803, brigantine: 1.008, galleon: 1.225 };
  for (const [type, stats] of Object.entries(SHIP_STATS)) {
    const draft = stats.height * SHIP.HULL_DRAFT_F[type];
    expect(`${type}: shared draft matches the rendered hull (${expectedDraft[type]}m)`,
      Math.abs(draft - expectedDraft[type]) < 0.01, `draft=${draft.toFixed(3)}`);
    const band = getSwimHullVerticalBand(0, stats, type);
    expect(`${type}: swim keel sits just under the visible keel`,
      Math.abs(band.keelY + draft + 0.15) < 1e-9, `keelY=${band.keelY.toFixed(3)}`);
    // At depth the hull tucks in — the blocking half-width must fall below the
    // waterline beam, not stay a straight prism.
    const wide = getSwimHullHalfWidth(stats, 0, 0, 0);
    const deep = getSwimHullHalfWidth(stats, 0, 0, getSwimHullVerticalT(-draft * 0.9, 0, stats, type));
    expect(`${type}: swim hull tapers with depth`, deep < wide * 0.65,
      `waterline ${wide.toFixed(2)} vs deep ${deep.toFixed(2)}`);
  }
}

// ── 8. Bounds radii cover every compound structure (broad-phase safety) ──
{
  let boundsOk = true;
  let boundsDetail = '';
  for (const [type, col] of Object.entries(PROP_COLLIDERS)) {
    const bounds = getPropBoundsRadius(type, 1);
    for (const sub of col.subColliders ?? []) {
      if (Math.hypot(sub.dx, sub.dz) + sub.radius > bounds + 1e-9) {
        boundsOk = false;
        boundsDetail = `${type}: mass reaches past bounds ${bounds.toFixed(2)}`;
      }
    }
  }
  expect('broad-phase bounds cover every compound mass', boundsOk, boundsDetail);
}

console.log(failures === 0 ? '\nAll prop collider assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
