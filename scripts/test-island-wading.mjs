#!/usr/bin/env node
// b2-ask-01: wading in island shallows is a SPEED CAP (0.55x walk), not a
// per-tick velocity multiply. With b2.1h's ground acceleration the multiply
// compounded to a steady ~0.78 m/s (0.16x walk). The REAL stepPirate (what
// Match.applyInput runs) followed by the REAL PhysicsSystem at the server
// tick, a pirate walking along the shoreline in 0.3..0.6 m of water.
// Logic tier, no stack, no browser.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { stepPirate } from '../src/shared/locomotion.ts';
import { getIslandSurfaceY, getIslandMaxRadius, gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

const islands = new MapGenerator(12345).generateIslands();
const DT = 1 / 62.5;
const WADE = 0.55;

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

function makePlayer(position, crouching = false) {
  return {
    id: 'wade', name: 'Wade', shipId: null, position: { ...position },
    rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
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
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null, crouching,
  };
}

/** Walk inward from open sea on `angle` until the water over the ground is `want` m. */
function findDepth(island, angle, want) {
  const r = getIslandMaxRadius(island);
  for (let d = r * 1.2; d > 0; d -= 0.25) {
    const x = island.position.x + Math.cos(angle) * d;
    const z = island.position.z + Math.sin(angle) * d;
    const g = getIslandSurfaceY(island, x, z);
    if (!Number.isFinite(g)) continue;
    const depth = gerstnerHeight(x, z, 0, WAVE_PARAMS) - g;
    if (depth <= want) return { x, z, g, depth };
  }
  return null;
}

/** Walk along the shore tangent for 0.8 s; median horizontal speed over the
 *  ticks after the first 0.25 s where he is still on his feet in the band. */
function walk(island, angle, want, crouching = false) {
  const at = findDepth(island, angle, want);
  if (!at) return null;
  const p = makePlayer({ x: at.x, y: at.g, z: at.z }, crouching);
  const phys = new PhysicsSystem();
  const tx = -Math.sin(angle), tz = Math.cos(angle);
  const yaw = Math.atan2(tx, tz);
  const input = { forward: true, back: false, left: false, right: false, jump: false, crouch: crouching, yaw, pitch: 0 };
  const speeds = [];
  for (let i = 0; i < 50; i++) {
    const t = i * DT;
    stepPirate(p, input, DT, { ship: null, islands, jumpBlocked: false });
    phys.update(DT, t, [], [p], [], islands, []);
    if (p.state !== 'alive') return null;
    const g = getIslandSurfaceY(islands.find((il) => il.id === island.id) ?? island, p.position.x, p.position.z);
    const depth = gerstnerHeight(p.position.x, p.position.z, t, WAVE_PARAMS) - g;
    if (i * DT >= 0.25 && depth > 0.25 && depth < 0.7) speeds.push(Math.hypot(p.velocity.x, p.velocity.z));
  }
  if (speeds.length < 10) return null;
  speeds.sort((a, b) => a - b);
  return speeds[speeds.length >> 1];
}

console.log('Island wading: 0.55x walk speed cap');
const wadeTarget = PLAYER.MOVE_SPEED * WADE;
const samples = [];
const crouchSamples = [];
for (const island of islands) {
  for (let k = 0; k < 8 && samples.length < 12; k++) {
    const angle = (k / 8) * Math.PI * 2;
    const v = walk(island, angle, 0.45);
    if (v != null) samples.push(v);
    if (crouchSamples.length < 4) {
      const c = walk(island, angle, 0.45, true);
      if (c != null) crouchSamples.push(c);
    }
  }
}
expect('found shallow-water walks on the map', samples.length >= 6, `${samples.length} walks`);
const med = samples.slice().sort((a, b) => a - b)[samples.length >> 1] ?? 0;
expect(
  `steady wading speed ~${wadeTarget.toFixed(2)} m/s (0.55x walk, +-10%)`,
  Math.abs(med - wadeTarget) <= wadeTarget * 0.1,
  `median ${med.toFixed(2)} m/s over ${samples.length} walks = ${(med / PLAYER.MOVE_SPEED).toFixed(2)}x walk`,
);
expect('no wading walk exceeds the cap', samples.every((v) => v <= wadeTarget * 1.02), samples.map((v) => v.toFixed(2)).join(' '));
if (crouchSamples.length) {
  const cm = crouchSamples.slice().sort((a, b) => a - b)[crouchSamples.length >> 1];
  const want = PLAYER.MOVE_SPEED * 0.55 * WADE;
  expect(`crouch-wading ~${want.toFixed(2)} m/s (crouch x wade, +-15%)`, Math.abs(cm - want) <= want * 0.15, `median ${cm.toFixed(2)}`);
}

if (failures) { console.error(`\n${failures} island-wading check(s) FAILED`); process.exit(1); }
console.log('\nisland wading: all checks passed');
