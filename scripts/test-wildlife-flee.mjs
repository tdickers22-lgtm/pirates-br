#!/usr/bin/env node
/**
 * Wildlife awareness, gull flight and carcasses — REAL server code.
 *
 * WILD-01 (islandworld-07, 08, 09, 11, 32, 34, physics-31). Every assertion
 * here drives `Match.updateWildlife` (which delegates to FaunaSystem), so a
 * regression in the AI cannot hide behind a mirror of it.
 *
 *   1. a pirate who walks up to a grazing animal makes it BOLT
 *   2. a gunshot inside SHOT_ALERT_RADIUS spooks the birds
 *   3. gulls fly: over a minute a gull's altitude spans more than 5 m
 *   4. a dead animal is a carcass for CARCASS_SECONDS, not a puff of nothing
 *   5. the wander walker refuses water, cliffs, cave mouths and solid props
 *   6. a pirate cannot stand inside an animal
 */
import { Match } from '../src/server/core/Match.ts';
import { WILDLIFE } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY, dist2D } from '../src/shared/utils/index.ts';
import { nearCaveFootprint, resolveWalkerAgainstIsland, resolveWalkerAgainstWildlife } from '../src/shared/locomotion.ts';
import { resolvePropCollision } from '../src/shared/props.ts';
import { buildWireSnapshot } from '../src/server/core/snapshot.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 30;
const match = new Match({ matchId: 'wildlife-flee-test', botCount: 1 });
const state = match.state;
const islandById = new Map(state.islands.map((i) => [i.id, i]));

/** Park every player far out at sea so no test perturbs another's animal. */
function parkPlayers() {
  for (const p of state.players) {
    p.position = { x: 900, y: 0.2, z: 900 };
    p.state = 'alive';
    p.onShipId = null;
  }
}
parkPlayers();

function pick(type) {
  const animal = state.wildlife.find((a) => a.type === type && a.health > 0 && islandById.has(a.islandId));
  if (!animal) throw new Error(`no live ${type} in the generated world`);
  return animal;
}

/** Drive the fauna tick AND the match clock — alert windows, gull state timers
 *  and the carcass fade are all read off `match.t`, so a suite that froze the
 *  clock would grade a world where nothing ever expires. */
function step() {
  match.t += DT;
  match.updateWildlife(DT);
}
function tick(seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) step();
}

// ── 1. Flee from a pirate ───────────────────────────────────────────────────
console.log('1. A pirate walking up to an animal makes it bolt');
{
  const animal = pick('chicken');
  const start = { x: animal.position.x, z: animal.position.z };
  const stalker = state.players[0];
  // Three metres away, inside FLEE_RADIUS.chicken (6 m).
  stalker.position = { x: start.x + 3, y: animal.position.y, z: start.z };
  stalker.state = 'alive';
  tick(2);
  const moved = dist2D(animal.position.x, animal.position.z, start.x, start.z);
  const away = dist2D(animal.position.x, animal.position.z, stalker.position.x, stalker.position.z);
  expect('chicken is more than 5 m from the pirate after 2 s', away > 5, `away=${away.toFixed(2)} moved=${moved.toFixed(2)}`);
  expect('and it ran AWAY, not past him', away > 3, `away=${away.toFixed(2)}`);
  expect('the wire carries the spooked bit', animal.alert === true, `alert=${animal.alert}`);
  parkPlayers();
}

// ── 2. A gunshot spooks the birds ───────────────────────────────────────────
console.log('2. A gunshot inside the alert radius spooks a gull');
{
  const gull = pick('gull');
  const start = { x: gull.position.x, z: gull.position.z };
  // A shot 10 m away — well inside SHOT_ALERT_RADIUS (25 m).
  match.fauna.alertToShot(state, start.x + 10, start.z);
  tick(1);
  const away = dist2D(gull.position.x, gull.position.z, start.x, start.z);
  expect('gull is more than 4 m from where the shot found it, within 1 s', away > 4, `away=${away.toFixed(2)}`);
  const far = pick('pig');
  const farStart = { x: far.position.x, z: far.position.z };
  // Calm it first: the gull shot above may have carried to this one too, and
  // the assertion under test is about THIS shot, not the last one.
  far.alertUntil = undefined;
  far.alert = undefined;
  match.fauna.alertToShot(state, farStart.x + WILDLIFE.SHOT_ALERT_RADIUS + 40, farStart.z);
  expect('a shot beyond the alert radius does NOT spook',
    far.alertUntil === undefined, `alertUntil=${far.alertUntil}`);
}

// ── 3. Gulls fly ────────────────────────────────────────────────────────────
console.log('3. A gull flies: its altitude spans more than 5 m over a minute');
{
  const gull = pick('gull');
  const island = islandById.get(gull.islandId);
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (let i = 0; i < Math.round(60 / DT); i++) {
    step();
    const ground = getIslandSurfaceY(island, gull.position.x, gull.position.z);
    const alt = gull.position.y - ground;
    minAlt = Math.min(minAlt, alt);
    maxAlt = Math.max(maxAlt, alt);
  }
  expect('altitude span > 5 m', maxAlt - minAlt > 5, `min=${minAlt.toFixed(2)} max=${maxAlt.toFixed(2)}`);
  expect('and it perches (comes within 0.6 m of the ground)', minAlt < 0.6, `min=${minAlt.toFixed(2)}`);
}

// ── 4. Carcasses ────────────────────────────────────────────────────────────
console.log('4. A dead animal stays as a carcass, it does not vanish');
{
  const pig = pick('pig');
  const id = pig.id;
  pig.health = 0;
  tick(10);
  const still = state.wildlife.find((a) => a.id === id);
  expect('id still in state.wildlife 10 s after death', !!still, `found=${!!still}`);
  expect('and it is flagged dead on the wire', still?.dead === true, `dead=${still?.dead}`);
  expect('a carcass does not walk', still ? Math.abs(still.velocity.x) + Math.abs(still.velocity.z) < 1e-6 : false);
  tick(WILDLIFE.CARCASS_SECONDS + 2);
  expect('and it is gone once the carcass window closes',
    !state.wildlife.some((a) => a.id === id));
}

// ── 5. The walker refuses water, cliffs, cave mouths and props ──────────────
console.log('5. 600 s of wandering never puts an animal in the sea, on a cliff, in a cave or inside a prop');
{
  parkPlayers();
  let minGround = Infinity;
  let caveEntries = 0;
  let propOverlaps = 0;
  let firstOverlap = -1;
  let lastOverlap = -1;
  let worstSlope = 0;
  const tracked = state.wildlife.filter((a) => a.health > 0 && a.type !== 'gull');
  // Per-TICK slope truth for a subset: sampling every half second and dividing
  // by the net displacement grades a turn-around as a cliff.
  const close = tracked.slice(0, 8);
  const prev = close.map((a) => ({ x: a.position.x, z: a.position.z, y: a.position.y - 0.06 }));
  for (let i = 0; i < Math.round(600 / DT); i++) {
    step();
    for (let k = 0; k < close.length; k++) {
      const a = close[k];
      if (a.health <= 0) continue;
      const ground = a.position.y - 0.06;
      const run = Math.hypot(a.position.x - prev[k].x, a.position.z - prev[k].z);
      if (run > 1e-4) worstSlope = Math.max(worstSlope, Math.abs(ground - prev[k].y) / run);
      prev[k].x = a.position.x; prev[k].z = a.position.z; prev[k].y = ground;
    }
    if (i % 15) continue;
    for (const a of tracked) {
      if (a.health <= 0) continue;
      const island = islandById.get(a.islandId);
      const ground = getIslandSurfaceY(island, a.position.x, a.position.z);
      minGround = Math.min(minGround, ground);
      if (nearCaveFootprint(island, a.position.x, a.position.z, WILDLIFE.CAVE_PAD)) caveEntries++;
      const res = resolvePropCollision({ x: a.position.x, y: ground, z: a.position.z }, WILDLIFE.HIT_RADIUS[a.type], island);
      if (res.pushed) { propOverlaps++; if (firstOverlap < 0) firstOverlap = i; lastOverlap = i; }
    }
  }
  expect('no animal ever stood on ground below 0.1 m', minGround > 0.1, `minGround=${minGround.toFixed(3)}`);
  expect('nothing walked into a cave mouth', caveEntries === 0, `entries=${caveEntries}`);
  expect('and nothing stood inside a palm, a boulder or a tent wall', propOverlaps === 0, `overlaps=${propOverlaps} firstTick=${firstOverlap} lastTick=${lastOverlap}`);
  expect('no single step climbed steeper than the walk limit',
    worstSlope <= WILDLIFE.MAX_STEP_SLOPE + 1e-6, `worst=${worstSlope.toFixed(3)}`);
}

// ── 5b. The walker itself, as a unit ────────────────────────────────────────
console.log('5b. resolveWalkerAgainstIsland refuses a cliff and refuses the sea');
{
  const island = state.islands.find((i) => i.caves && i.caves.length > 0) ?? state.islands[0];
  const limits = {
    radius: 0, footprintPad: -2,
    minGroundY: WILDLIFE.MIN_GROUND_Y.pig,
    maxSlope: WILDLIFE.MAX_STEP_SLOPE,
    cavePad: WILDLIFE.CAVE_PAD,
  };
  const centre = { x: island.position.x, z: island.position.z };
  const groundAt = (x, z) => getIslandSurfaceY(island, x, z);
  // A 0.1 m step that would rise 5 m is a cliff by any reading.
  const from = { x: centre.x, z: centre.z };
  const fake = groundAt(from.x, from.z) - 5;
  const cliff = resolveWalkerAgainstIsland(island, from.x, from.z, fake, from.x + 0.1, from.z, limits);
  expect('a step that rises 5 m in 10 cm is refused as a slope',
    cliff.blocked && cliff.reason === 'slope', `reason=${cliff.reason}`);
  // Far outside the island is open sea.
  const sea = resolveWalkerAgainstIsland(island, from.x, from.z, groundAt(from.x, from.z),
    from.x + island.radius * 4, from.z, limits);
  expect('a step out to sea is refused', sea.blocked, `reason=${sea.reason}`);
  expect('and a refused step leaves the walker exactly where it was',
    sea.x === from.x && sea.z === from.z);
}

// ── 6. A pirate cannot stand inside an animal ───────────────────────────────
console.log('6. A pirate cannot stand inside an animal');
{
  const pig = state.wildlife.find((a) => a.type === 'pig' && a.health > 0);
  const before = { x: pig.position.x, z: pig.position.z };
  const shove = resolveWalkerAgainstWildlife(before.x + 0.05, before.z, 0.35, state.wildlife);
  const d = Math.hypot(shove.x - before.x, shove.z - before.z);
  expect('a pirate standing in a pig is pushed clear of its hit radius',
    d >= WILDLIFE.HIT_RADIUS.pig + 0.35 - 0.02, `d=${d.toFixed(3)}`);
  const clear = resolveWalkerAgainstWildlife(before.x + 40, before.z, 0.35, state.wildlife);
  expect('and a pirate 40 m away is not moved at all',
    Math.abs(clear.x - (before.x + 40)) < 1e-9 && Math.abs(clear.z - before.z) < 1e-9);
}

// ── 7. The wire ─────────────────────────────────────────────────────────────
console.log('7. The wildlife wire record carries velocity and the two flags, and nothing else');
{
  parkPlayers();
  const walker = state.wildlife.find((a) => a.health > 0 && a.type !== 'gull' && !a.dead);
  walker.velocity.x = 1.2345;
  walker.velocity.z = -0.5;
  walker.alert = true;
  const wire = buildWireSnapshot(match.buildSnapshot(), false);
  const rec = wire.wildlife.find((a) => a.id === walker.id);
  expect('the record exists', !!rec);
  expect('it carries vx/vz for dead reckoning',
    typeof rec.vx === 'number' && typeof rec.vz === 'number', `vx=${rec.vx} vz=${rec.vz}`);
  expect('quantized to 0.1 m/s, not raw floats', rec.vx === 1.2 && rec.vz === -0.5, `vx=${rec.vx} vz=${rec.vz}`);
  expect('the spooked bit reaches the client', rec.alert === true, `alert=${rec.alert}`);
  expect('server AI internals never do',
    rec.spawnPosition === undefined && rec.islandId === undefined
    && rec.wanderAngle === undefined && rec.alertUntil === undefined
    && rec.gullState === undefined && rec.deadAt === undefined && rec.health === undefined);
  const calm = state.wildlife.find((a) => a.health > 0 && !a.alert && !a.dead);
  if (calm) {
    calm.velocity.x = 0;
    calm.velocity.z = 0;
    const calmRec = buildWireSnapshot(match.buildSnapshot(), false).wildlife.find((a) => a.id === calm.id);
    expect('and a calm, still animal spends no bytes on the flags or on zero velocity',
      calmRec && !('alert' in calmRec) && !('dead' in calmRec) && !('vx' in calmRec) && !('vz' in calmRec));
  }
  walker.alert = undefined;
}

console.log(failures === 0 ? '\nAll wildlife awareness assertions passed.' : `\n${failures} wildlife assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
