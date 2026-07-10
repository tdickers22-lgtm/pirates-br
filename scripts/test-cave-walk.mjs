// Walk-in / walk-out test for every cave system using the real PhysicsSystem:
// spawn outside the mouth, walk the mouth axis to the deep junction, then walk
// back out. Assert: never flips to swimming, never ejected to the natural
// surface, and actually exits past the lip.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { getIslandSurfaceY, getCaveFloorY } from '../src/shared/utils/index.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

const islands = new MapGenerator(12345).generateIslands();
const DT = 0.016;

function makePlayer(position, overrides = {}) {
  return {
    id: 'audit', name: 'Audit', shipId: null, position: { ...position },
    rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH, state: 'alive', weapons: [], activeSlot: 0,
    reloading: false, reloadTimer: 0, knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false, kills: 0, playerKillStreak: 0, superCannonballs: 0, megaKegs: 0,
    tsunamiCharges: 0, gold: 0, carryingChestId: null, treasureMapIslandId: null,
    swimTimer: 0, atCannon: false, atHelm: false, atSails: false, sailControlMode: null,
    atCrowNest: false, blocking: false, cutlassCharge: 0, cannonIndex: 0,
    nearChestId: null, nearShipId: null, onShipId: null, respawnTimer: 0,
    respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0, lastDamagedById: null,
    lastDamagedAt: null, lastDamageWasHeadshot: false, selectedCannonAmmo: 'cannonball',
    kegs: 0, kegCooldown: 0, cannonFlightTimer: 0, cannonBallistic: false,
    pocketBanana: 0, pocketWood: 0, pocketCoconut: 0, pocketMango: 0, pocketMeat: 0,
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null, ...overrides,
  };
}

let failures = 0;
const expect = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

for (const island of islands) {
  const mouth = (island.caves ?? []).find((c) => c.hasMouth);
  if (!mouth) continue;
  console.log(`\n── ${island.id} (${island.profile.terrainStyle}, ${island.caves.length} segs) ──`);
  const phys = new PhysicsSystem();
  const inX = -Math.sin(mouth.rotation), inZ = -Math.cos(mouth.rotation);
  const startX = mouth.position.x - inX * 3.0, startZ = mouth.position.z - inZ * 3.0;
  const startY = getIslandSurfaceY(island, startX, startZ);
  const p = makePlayer({ x: startX, y: startY, z: startZ });
  const SPEED = 3.4;
  let everSwim = false, maxEject = 0, minY = 1e9;
  const walk = (dirX, dirZ, ticks) => {
    for (let i = 0; i < ticks; i++) {
      p.velocity.x = dirX * SPEED; p.velocity.z = dirZ * SPEED;
      p.position.x += p.velocity.x * DT; p.position.z += p.velocity.z * DT;
      phys.update(DT, i * DT, [], [p], [], islands, []);
      if (p.state === 'swimming') everSwim = true;
      minY = Math.min(minY, p.position.y);
      const cf = getCaveFloorY(island, p.position.x, p.position.z);
      if (cf !== null) {
        const natural = getIslandSurfaceY(island, p.position.x, p.position.z);
        if (p.position.y > natural + 0.5) maxEject = Math.max(maxEject, p.position.y - natural);
      }
    }
  };
  // In: mouth (15m) + junction (~8m) + a bit = walk ~26m inward
  const inTicks = Math.round((mouth.length + 11) / (SPEED * DT));
  walk(inX, inZ, inTicks);
  const midX = p.position.x, midZ = p.position.z, midY = p.position.y;
  const midCave = getCaveFloorY(island, midX, midZ);
  expect('reached the deep interior on foot (in-cave, below grade)',
    midCave !== null && Math.abs(midY - midCave) < 1.2 && midY < getIslandSurfaceY(island, midX, midZ) - 2,
    `y=${midY.toFixed(2)} caveFloor=${midCave === null ? 'null' : midCave.toFixed(2)} natural=${getIslandSurfaceY(island, midX, midZ).toFixed(2)}`);
  expect('never flipped to swimming inside', !everSwim);
  expect('never ejected above the hillside', maxEject === 0, `eject=${maxEject.toFixed(2)}m`);
  // Out: walk back the same axis
  walk(-inX, -inZ, inTicks + Math.round(3 / (SPEED * DT)));
  const outDist = Math.hypot(p.position.x - mouth.position.x, p.position.z - mouth.position.z);
  const outNatural = getIslandSurfaceY(island, p.position.x, p.position.z);
  expect('walked back OUT past the mouth lip',
    outDist > 2.0 && Math.abs(p.position.y - outNatural) < 1.0 && getCaveFloorY(island, p.position.x, p.position.z) === null,
    `outDist=${outDist.toFixed(1)} y=${p.position.y.toFixed(2)} natural=${outNatural.toFixed(2)}`);
  expect('still alive and unhurt', p.state === 'alive' && p.health > 95, `state=${p.state} hp=${p.health.toFixed(0)}`);
  console.log(`   deepest walk y=${minY.toFixed(2)}`);
}

console.log(failures === 0 ? '\nALL CAVE WALK TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
