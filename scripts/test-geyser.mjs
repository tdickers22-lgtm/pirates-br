#!/usr/bin/env node
// Volcanic geysers — drives the REAL PhysicsSystem over the generated world so
// the shared eruption timing, terrain heightfield and launch impulse run exactly
// as the 62.5 Hz match server does.
//
// Coverage:
//  1. Every volcanic island gets geysers; non-volcanic isles get none; the vents
//     are bit-identical across match seeds (the world is fixed).
//  2. geyserEruptionLevel is a clean cyclic pulse in [0,1]: fully dormant part of
//     the cycle, reaches a full plume, and repeats every `period`.
//  3. A pirate standing on an erupting vent is launched skyward, goes well
//     airborne, and takes fall damage on landing (the launch feeds the fall
//     system — a geyser onto hard rock hurts).
//  4. A dormant vent never launches.
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PLAYER, GEYSER } from '../src/shared/constants/index.ts';
import { geyserEruptionLevel, getIslandSurfaceY } from '../src/shared/utils/index.ts';

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

function makePlayer(position, overrides = {}) {
  return {
    id: 'geyser-tester',
    name: 'Tester',
    shipId: null,
    position: { ...position },
    rotation: { x: 0, y: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH,
    state: 'alive',
    weapons: [],
    activeSlot: 0,
    reloading: false,
    reloadTimer: 0,
    knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false,
    kills: 0,
    playerKillStreak: 0,
    superCannonballs: 0,
    megaKegs: 0,
    tsunamiCharges: 0,
    gold: 0,
    carryingChestId: null,
    treasureMapIslandId: null,
    swimTimer: 0,
    atCannon: false,
    atHelm: false,
    sailControlMode: null,
    atCrowNest: false,
    blocking: false,
    cutlassCharge: 0,
    cannonIndex: 0,
    nearChestId: null,
    nearShipId: null,
    onShipId: null,
    respawnTimer: 0,
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
    lastDamagedById: null,
    lastDamagedAt: null,
    lastDamageWasHeadshot: false,
    selectedCannonAmmo: 'cannonball',
    kegs: 0,
    kegCooldown: 0,
    cannonFlightTimer: 0,
    cannonBallistic: false,
    pocketBanana: 0,
    pocketWood: 0,
    pocketCoconut: 0,
    pocketMango: 0,
    pocketMeat: 0,
    pocketUseCooldown: 0,
    hasShovel: false,
    nearBarrelId: null,
    ...overrides,
  };
}

/** One tick at shared match time `t` (fixed if held, advancing for a flight). */
function step(physics, player, islands, t, dir) {
  if (dir) {
    player.velocity.x = dir.x;
    player.velocity.z = dir.z;
    player.position.x += player.velocity.x * DT;
    player.position.z += player.velocity.z * DT;
  }
  physics.update(DT, t, [], [player], [], islands, []);
}

console.log('Volcanic geysers');

const islands = new MapGenerator(12345).generateIslands();
const volcanic = islands.filter((i) => i.profile.biome === 'volcanic');
const nonVolcanic = islands.filter((i) => i.profile.biome !== 'volcanic');

// ── 1. Presence + determinism ────────────────────────────────────────────────
expect('The fixed roster has volcanic islands', volcanic.length >= 1, `count=${volcanic.length}`);
expect(
  'Every volcanic island has geysers',
  volcanic.every((i) => (i.geysers?.length ?? 0) > 0),
  `counts=${volcanic.map((i) => i.geysers?.length).join(',')}`,
);
expect(
  'Non-volcanic islands have no geysers',
  nonVolcanic.every((i) => (i.geysers?.length ?? 0) === 0),
);

const islandsB = new MapGenerator(99999).generateIslands();
const serialize = (list) => JSON.stringify(list.map((i) => i.geysers ?? []));
expect(
  'Geysers are bit-identical across match seeds (fixed world)',
  serialize(islands) === serialize(islandsB),
);

// Vents sit above the wave/beach band on footable ground.
const allVents = volcanic.flatMap((i) => (i.geysers ?? []).map((g) => ({ i, g })));
expect(
  'Every vent clears the beach/wave band (y ≥ 4.5)',
  allVents.every(({ g }) => g.y >= 4.5),
  `min=${Math.min(...allVents.map(({ g }) => g.y)).toFixed(2)}`,
);

// ── 2. Eruption timing is a clean cyclic pulse ───────────────────────────────
{
  const g = volcanic[0].geysers[0];
  let sawZero = false;
  let sawPeak = false;
  let inRange = true;
  for (let t = 0; t < g.period * 3; t += 0.03) {
    const lvl = geyserEruptionLevel(g, t);
    if (lvl < 0 || lvl > 1.00001) inRange = false;
    if (lvl === 0) sawZero = true;
    if (lvl > 0.95) sawPeak = true;
  }
  expect('Eruption level stays within [0,1]', inRange);
  expect('The vent goes fully dormant part of the cycle', sawZero);
  expect('The vent reaches a full plume', sawPeak);
  expect(
    'Eruption is periodic in `period`',
    Math.abs(geyserEruptionLevel(g, 3.31) - geyserEruptionLevel(g, 3.31 + g.period)) < 1e-9,
  );
  // A negative time (client clock can drift slightly negative) is handled.
  expect('Handles negative time without NaN', Number.isFinite(geyserEruptionLevel(g, -2.4)));
}

// ── 3. An erupting vent launches a standing pirate, and landing hurts ─────────
{
  const island = volcanic.find((i) => (i.geysers?.length ?? 0) > 0);
  const g = island.geysers[0];
  const physics = new PhysicsSystem();
  const groundY = getIslandSurfaceY(island, g.x, g.z);
  // Dead-centre on the vent → the outward kick is ~0, so this is a clean vertical
  // launch that lands back on the vent (isolates the fall-damage path).
  const player = makePlayer({ x: g.x, y: groundY, z: g.z });
  step(physics, player, [island], 0, null); // prime footing
  const startHealth = player.health;
  let maxAbove = 0;
  let launched = false;
  let landedAfter = false;
  let t = 0;
  // Ride exactly ONE eruption: advance until launched, then until settled again.
  const ticks = Math.ceil((g.period + 8) / DT);
  for (let i = 0; i < ticks && !landedAfter; i++) {
    step(physics, player, [island], t, null);
    const above = player.position.y - groundY;
    maxAbove = Math.max(maxAbove, above);
    if (above > 8) launched = true;
    if (launched && above < 0.6 && Math.abs(player.velocity.y) < 1.5) landedAfter = true;
    t += DT;
  }
  expect('Standing on a geyser launches the pirate skyward', launched && maxAbove > 8, `maxAbove=${maxAbove.toFixed(1)}m`);
  expect('The launch deals fall damage on landing', player.health < startHealth, `health ${startHealth}→${player.health.toFixed(0)}`);
  expect('The launch is survivable (not instant death)', player.health > 0, `health=${player.health.toFixed(0)}`);
  const settledY = getIslandSurfaceY(island, player.position.x, player.position.z);
  expect(
    'The pirate settles back onto solid ground',
    Math.abs(player.position.y - settledY) < 1.5,
    `y=${player.position.y.toFixed(2)} ground=${settledY.toFixed(2)}`,
  );
}

// ── 4. A dormant vent never launches ─────────────────────────────────────────
{
  const island = volcanic.find((i) => (i.geysers?.length ?? 0) > 0);
  const g = island.geysers[0];
  // Find a dormant instant (level 0) and hold time there for the whole sim.
  let tDormant = null;
  for (let t = 0; t < g.period; t += 0.01) {
    if (geyserEruptionLevel(g, t) === 0) { tDormant = t; break; }
  }
  expect('Found a dormant instant', tDormant !== null);
  const physics = new PhysicsSystem();
  const groundY = getIslandSurfaceY(island, g.x, g.z);
  const player = makePlayer({ x: g.x, y: groundY, z: g.z });
  let maxAbove = 0;
  for (let i = 0; i < 240; i++) {
    step(physics, player, [island], tDormant, null);
    maxAbove = Math.max(maxAbove, player.position.y - groundY);
  }
  expect('A dormant vent does not launch (stays grounded)', maxAbove < 1.0, `maxAbove=${maxAbove.toFixed(2)}m`);
  expect('A dormant vent deals no fall damage', player.health === PLAYER.MAX_HEALTH, `health=${player.health}`);
}

// ── 5. An idle pirate is thrown CLEAR, not trampolined to death ───────────────
// Regression guard: a stationary/AFK pirate on a vent must be carried off it by
// the ballistic arc, so repeated eruptions can't stack fall damage to death.
{
  const island = volcanic.find((i) => (i.geysers?.length ?? 0) > 0);
  const g = island.geysers[0];
  const physics = new PhysicsSystem();
  const groundY = getIslandSurfaceY(island, g.x, g.z);
  // Dead-centre on the vent and NEVER provides input (dir stays null) — the AFK
  // case where the launch's horizontal escape has to do all the work.
  const player = makePlayer({ x: g.x, y: groundY, z: g.z });
  let t = 0;
  const ticks = Math.ceil((g.period * 3 + 8) / DT); // several full eruptions
  for (let i = 0; i < ticks; i++) {
    step(physics, player, [island], t, null);
    t += DT;
  }
  const distFromVent = Math.hypot(player.position.x - g.x, player.position.z - g.z);
  expect('The launch carries an idle pirate off the vent', distFromVent > g.radius, `dist=${distFromVent.toFixed(1)} radius=${g.radius.toFixed(1)}`);
  expect('An idle pirate survives repeated eruptions (no trampoline death)', player.health > 0, `health=${player.health.toFixed(0)}`);
}

if (failures > 0) {
  console.error(`\n${failures} geyser assertion(s) failed.`);
  process.exit(1);
}
console.log('All geyser assertions passed.');
