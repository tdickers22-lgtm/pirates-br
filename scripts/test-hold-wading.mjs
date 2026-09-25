#!/usr/bin/env node
// b2.2f (holes-07): the flooded hold is WATER for the player.
//
// The REAL Match (applyInput -> stepPirate) and the REAL PhysicsSystem at the
// server tick, a pirate down in his own hold walking away from the
// companionway. Graded on his measured deck-relative speed, his state, his
// breath (swimTimer) and his health, plus the shared surface/sampler that a
// client predictor calls:
//   - water 0.2: unaffected (same speed as dry, swimTimer stays 0)
//   - water 0.5: hold speed <= 0.6x dry
//   - water 0.95: off his feet (swimming), still aboard and 'alive', losing
//     breath on the drowning clock, and drowning past PLAYER.DROWN_TIME
//   - the hold surface tilts with the hull (world-level water: deeper at the
//     low rail and at a dipped bow), clamped to sole and deck
//   - client prediction bit-equal: the shared sampler fed a JSON copy of the
//     wire fields returns the identical mode/immersion/surface/cap
//   - he can still scoop with the water over his head (bail.ts canScoop)
// Logic tier, no stack, no browser.
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS, PLAYER } from '../src/shared/constants/index.ts';
import { toShipLocal3 } from '../src/shared/interactions.ts';
import { getShipCompanionwayConfig } from '../src/shared/utils/index.ts';
import { canScoop, bailPoseOf } from '../src/shared/flooding/bail.ts';
import {
  fillToLocalY,
  holdWaterSurfaceLocalY,
  holdSpeedCap,
  sampleHoldWater,
  HOLD_SWIM_IMMERSION,
  HOLD_WADE_IMMERSION,
} from '../src/shared/flooding/hullVolume.ts';
import { applyHoldWater } from '../src/server/systems/holdMovement.ts';

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = 1 / 62.5;

/** A pirate in the hold of match ship 0, walking for `seconds` at `water`. */
function walkInHold(type, water, seconds = 0.5, { forward = true } = {}) {
  const match = new Match({ matchId: `hold-wade-${type}-${water}`, botCount: 1 });
  match.state.phase = 'playing';
  const st = match.state;
  const ship = st.ships[0];
  ship.type = type;
  const stats = SHIP_STATS[type];
  ship.position = { x: -640, y: 0, z: -350 };
  ship.rotation = 0; ship.pitch = 0; ship.roll = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.angularVelocity = 0;
  ship.anchored = true;
  ship.holes = [];
  ship.waterLevel = water;
  const player = st.players.find((p) => p.shipId === ship.id) ?? st.players[0];
  for (const p of st.players) if (p !== player && p.onShipId === ship.id) { p.onShipId = null; p.position = { x: 5000, y: 0, z: 5000 }; }
  player.onShipId = ship.id;
  player.state = 'alive';
  player.atCannon = false; player.atHelm = false; player.atCrowNest = false; player.cannonIndex = null;
  player.respawnProtectionTimer = 0;
  player.swimTimer = 0;
  // Start just aft of the companionway mouth and walk AFT, away from it, so
  // the treads never lift him out of the water and the deck lid is overhead.
  const stair = getShipCompanionwayConfig(stats);
  const dir = -1;
  const startZ = Math.min(stair.stairBackZ, stair.stairFrontZ) - 0.2;
  player.position = { x: ship.position.x, y: ship.position.y + SHIP.HOLD_FLOOR_OFFSET, z: ship.position.z + startZ };
  player.velocity = { x: 0, y: 0, z: 0 };
  const yaw = dir > 0 ? 0 : Math.PI;
  const client = { playerId: player.id, appliedInputSeq: 0, consumedSeq: {}, lastOneShotAt: {} };
  const n = Math.round(seconds / DT);
  const from = Math.round(0.15 / DT);
  let z0 = 0; let z1 = 0;
  let minY = Infinity; let maxY = -Infinity;
  let wasSwim = false;
  const hp0 = player.health;
  for (let i = 0; i < n; i += 1) {
    match.applyInput(client, { seq: i + 1, yaw, pitch: 0, forward, slot: null }, DT);
    ship.waterLevel = water; // hold the fill fixed (no holes, no pump)
    match.physics.update(DT, i * DT, st.ships, st.players, [], [], [], null);
    const l = toShipLocal3(player.position, ship);
    if (i === from) z0 = l.z;
    if (i >= from) { minY = Math.min(minY, l.y); maxY = Math.max(maxY, l.y); }
    z1 = l.z;
    if (sampleHoldWater(player.position, ship).mode === 'swim') wasSwim = true;
  }
  const speed = Math.abs(z1 - z0) / ((n - 1 - from) * DT);
  return { match, ship, player, speed, minY, maxY, wasSwim, hp0 };
}

console.log('\nThe hold surface: fill table + world-level tilt');
{
  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const y0 = fillToLocalY(type, 0.5);
    const lvl = holdWaterSurfaceLocalY(type, 0.5, 1, 0, 0, 0);
    const rolled = (x) => holdWaterSurfaceLocalY(type, 0.5, x, 0, 0.1, 0);
    const trimmed = (z) => holdWaterSurfaceLocalY(type, 0.5, 0, z, 0, 0.05);
    expect(`${type}: level hull reads the fill table`, lvl === y0, `${lvl?.toFixed(3)} vs ${y0.toFixed(3)}`);
    expect(`${type}: +roll lifts +x, so the water is SHALLOWER at +x and deeper at -x`, rolled(1) < y0 && rolled(-1) > y0,
      `+x ${rolled(1).toFixed(3)} / -x ${rolled(-1).toFixed(3)} / centre ${y0.toFixed(3)}`);
    expect(`${type}: +pitch dips the bow, so the water is deeper forward`, trimmed(2) > y0 && trimmed(-2) < y0);
    expect(`${type}: dry hold has no surface`, holdWaterSurfaceLocalY(type, 0, 0, 0) === null);
    const deck = SHIP_STATS[type].height;
    expect(`${type}: clamped under the deck`, holdWaterSurfaceLocalY(type, 0.99, -4, 0, 0.3, 0) <= deck);
  }
}

console.log('\nDry, wading, swimming in the hold (real Match + PhysicsSystem)');
const dry = walkInHold('sloop', 0);
console.log(`  dry sloop hold speed ${dry.speed.toFixed(2)} m/s`);
expect('fixture: the dry walk is a real walk (> 4 m/s)', dry.speed > 4, `${dry.speed.toFixed(2)}`);
{
  const low = walkInHold('sloop', 0.2);
  expect('water 0.2: unaffected (speed within 2% of dry)', Math.abs(low.speed / dry.speed - 1) < 0.02,
    `${low.speed.toFixed(2)} vs ${dry.speed.toFixed(2)}`);
  expect('water 0.2: no breath lost', low.player.swimTimer === 0, `swimTimer ${low.player.swimTimer}`);

  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const d = type === 'sloop' ? dry : walkInHold(type, 0);
    const half = walkInHold(type, 0.5);
    const imm = sampleHoldWater(half.player.position, half.ship).immersion;
    expect(`${type} water 0.5: hold speed <= 0.6x dry`, half.speed <= 0.6 * d.speed,
      `${half.speed.toFixed(2)} vs dry ${d.speed.toFixed(2)} = ${(half.speed / d.speed).toFixed(2)}x, immersion ${imm.toFixed(2)}`);
    const deep = walkInHold(type, 0.95, 3);
    const p = deep.player;
    // Afloat: buoyed off the sole up to the float line (a sloop's hold is
    // barely taller than he is, so there he rises only to the deck beams).
    expect(`${type} water 0.95: swimming (buoyed off the sole)`, deep.wasSwim && deep.maxY > SHIP.HOLD_FLOOR_OFFSET + 0.03,
      `swim=${deep.wasSwim} feet ${deep.minY.toFixed(2)}..${deep.maxY.toFixed(2)} (sole ${SHIP.HOLD_FLOOR_OFFSET}, deck ${SHIP_STATS[type].height})`);
    expect(`${type} water 0.95: still aboard and alive (repair/bucket keep working)`, p.onShipId === deep.ship.id && p.state === 'alive',
      `onShipId=${p.onShipId} state=${p.state}`);
    expect(`${type} water 0.95: losing breath on the drowning clock`, p.swimTimer >= 3 - 1e-6, `swimTimer ${p.swimTimer.toFixed(2)} after 3 s`);
    const stroke = walkInHold(type, 0.95);
    expect(`${type} water 0.95: swims slower than he walks (<= 0.6x dry)`, stroke.speed <= 0.6 * d.speed, `${stroke.speed.toFixed(2)} m/s`);
    const bail = bailPoseOf(p.position, 0, -0.3, deep.ship);
    expect(`${type} water 0.95: he can still scoop`, canScoop(type, 0.95, bail));
  }
}

console.log('\nThe breath runs out: a full sloop hold drowns him past DROWN_TIME');
{
  const r = walkInHold('sloop', 0.98, 0.5, { forward: false });
  const p = r.player;
  const hp = p.health;
  const n = Math.round((PLAYER.DROWN_TIME / 4 + 3) / DT);
  for (let i = 0; i < n; i += 1) applyHoldWater(p, r.ship, DT, i * DT);
  expect('head under the deck lid: the clock runs >= 4x', p.swimTimer > PLAYER.DROWN_TIME,
    `swimTimer ${p.swimTimer.toFixed(1)} after ${(n * DT).toFixed(1)} s`);
  expect('...and he takes drowning damage', p.health < hp && p.lastEnvDamage?.cause === 'drowned', `hp ${hp} -> ${p.health.toFixed(1)}`);
}

console.log('\nClient prediction bit-equal: the shared sampler on the wire fields');
{
  const r = walkInHold('brigantine', 0.62);
  r.ship.roll = 0.07; r.ship.pitch = -0.03;
  const server = sampleHoldWater(r.player.position, r.ship);
  const wire = JSON.parse(JSON.stringify({
    ship: { position: r.ship.position, rotation: r.ship.rotation, type: r.ship.type, pitch: r.ship.pitch, roll: r.ship.roll, waterLevel: r.ship.waterLevel },
    pos: r.player.position,
  }));
  const client = sampleHoldWater(wire.pos, wire.ship);
  expect('same mode, immersion, surface and floor bit for bit',
    client.mode === server.mode && Object.is(client.immersion, server.immersion)
      && Object.is(client.surfaceLocalY, server.surfaceLocalY) && Object.is(client.floorLocalY, server.floorLocalY),
    `server ${server.mode} ${server.immersion} / client ${client.mode} ${client.immersion}`);
  expect('same speed cap', Object.is(holdSpeedCap(client.mode), holdSpeedCap(server.mode)), `${holdSpeedCap(server.mode)}`);
  expect('thresholds are the spec (0.35 wade, 0.75 swim)', HOLD_WADE_IMMERSION === 0.35 && HOLD_SWIM_IMMERSION === 0.75);
}

if (failures > 0) {
  console.error(`\n${failures} hold-wading assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll hold-wading assertions passed');
