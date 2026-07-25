// Swim-perimeter embedding probe with the real PhysicsSystem: for every
// island, swim straight at the shore from open water on many headings (plus a
// knockback-impulse variant) and assert the swimmer is NEVER left embedded in
// above-water terrain — i.e. terrain at the swimmer's own column pokes above
// the waves while the swimmer sits below it. This is the rocky/cliff-apron
// bug (distRatio ~1.0–1.05): the old resolve capped swimmers at the water
// surface INSIDE the shore face, outside the walk footprint, so neither the
// walk handoff nor the anti-embed net ever rescued them.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { getIslandSurfaceY, getIslandMaxRadius, gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

const islands = new MapGenerator(12345).generateIslands();
const DT = 0.016;

function makePlayer(position, overrides = {}) {
  return {
    id: 'audit', name: 'Audit', shipId: null, position: { ...position },
    rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH, state: 'swimming', weapons: [], activeSlot: 0,
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
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null, ...overrides,
  };
}

let failures = 0;
let checks = 0;

/** Embedded = terrain at the player's column stands above the waves while the
 *  player is well below that terrain (visually inside the shore face). */
function embedded(island, p, t) {
  const s = getIslandSurfaceY(island, p.position.x, p.position.z);
  const w = gerstnerHeight(p.position.x, p.position.z, t, WAVE_PARAMS);
  return s > w + 0.3 && p.position.y < s - 0.5;
}

function runApproach(island, angle, kick) {
  const r = getIslandMaxRadius(island);
  const dirX = -Math.cos(angle);
  const dirZ = -Math.sin(angle);
  const startX = island.position.x + Math.cos(angle) * r * 1.1;
  const startZ = island.position.z + Math.sin(angle) * r * 1.1;
  const phys = new PhysicsSystem();
  const p = makePlayer({ x: startX, y: -0.2, z: startZ });
  let embedTicks = 0;
  let worst = null;
  for (let i = 0; i < 340; i++) {
    const t = i * DT;
    if (p.state === 'swimming') {
      p.velocity.x = dirX * PLAYER.SWIM_SPEED;
      p.velocity.z = dirZ * PLAYER.SWIM_SPEED;
    }
    if (kick && i >= 60 && i < 66) {
      // Impulse entry (flintknock/geyser/wave surge class): shove shoreward.
      p.knockbackVelocity.x = dirX * 12;
      p.knockbackVelocity.z = dirZ * 12;
    }
    p.position.x += p.velocity.x * DT;
    p.position.z += p.velocity.z * DT;
    phys.update(DT, t, [], [p], [], islands, []);
    if (p.health <= 0) break;
    // Walking ashore is a legitimate outcome (beach walk-ins) — only judge
    // while the physics still treats them as a swimmer.
    if (p.state === 'swimming' && embedded(island, p, t)) {
      embedTicks++;
      const s = getIslandSurfaceY(island, p.position.x, p.position.z);
      if (!worst || s - p.position.y > worst.depth) {
        worst = { depth: s - p.position.y, x: p.position.x, z: p.position.z, tick: i };
      }
    } else {
      embedTicks = 0;
    }
    // Transient one-tick contact with a wall face is fine; STAYING inside
    // the shore for ~0.5s is the embedding bug.
    if (embedTicks > 30) break;
  }
  checks++;
  if (embedTicks > 30) {
    failures++;
    console.error(`  ✗ FAIL: ${island.id} θ=${(angle * 180 / Math.PI).toFixed(0)}°${kick ? ' (knockback)' : ''} — embedded ${embedTicks} ticks, ${worst.depth.toFixed(2)}m below terrain at (${worst.x.toFixed(1)}, ${worst.z.toFixed(1)})`);
  }
}

for (const island of islands) {
  const headings = 16;
  for (let a = 0; a < headings; a++) {
    runApproach(island, (a / headings) * Math.PI * 2, false);
  }
  // Knockback variant on 4 spread headings.
  for (let a = 0; a < 4; a++) {
    runApproach(island, (a / 4) * Math.PI * 2 + 0.4, true);
  }
  console.log(`── ${island.id} (${island.profile.terrainStyle}): ${headings + 4} approaches ${failures === 0 ? 'clean' : 'checked'}`);
}

console.log(`\nswim-shore probe: ${checks} approaches, ${failures} embedding failure(s)`);
if (failures > 0) process.exit(1);
console.log('OK: no swimmer left embedded in above-water shore terrain');
