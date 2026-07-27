#!/usr/bin/env node
// GROUNDING IS DAMAGE, NOT A SCUTTLING.
//
// Grounding is re-resolved every physics tick while a keel sits on a bar, so
// without an event ledger one beaching opened a fresh breach 60 times a second
// and saturated FLOODING.MAX_HOLES_PER_SHIP in a single tick — a solo sloop
// foundered in ~25 s with no counterplay. Kegs were capped at
// KEG_MAX_HOLES_PER_BLAST for exactly this reason; this pins the same rail for
// running aground, plus the two shelters that stop the lobby emptying itself
// offscreen (berthed hulls in the opening storm phases, bot crews in the
// early-peace window).
//
//   node --import tsx scripts/test-grounding-cap.mjs
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP, SHIP_STATS, SERVER_TICK_MS, BOT_EARLY_PEACE_SECONDS, FLOODING } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { countOpenHoles } from '../src/shared/interactions.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = SERVER_TICK_MS / 1000;

/** A real generated world — grounding needs an honest heightfield, not a cone. */
const world = new Match({ matchId: 'grounding-cap-world', botCount: 1 });
const island = world.state.islands.find((i) => i.radius > 60) ?? world.state.islands[0];

/** March out from the island centre along `angle` and return the first point
 *  where the seabed has dropped a clear metre below a sloop's keel. */
function findDeepWaterBearing(angle) {
  const stats = SHIP_STATS.sloop;
  const keelDraft = stats.height * SHIP.HULL_DRAFT_F.sloop + SHIP.GROUND_KEEL_SAFETY;
  for (let r = island.radius * 0.4; r < island.radius * 4; r += 2) {
    const x = island.position.x + Math.cos(angle) * r;
    const z = island.position.z + Math.sin(angle) * r;
    if (getIslandSurfaceY(island, x, z) < -(keelDraft + 1.2)) return { x, z, r };
  }
  return null;
}

/** A bare sloop hull, positioned `standoff` metres seaward of the shelf on the
 *  given bearing and driving straight at the beach at `speed`. */
function makeCharge(angle, speed, standoff = 26) {
  const deep = findDeepWaterBearing(angle);
  if (!deep) throw new Error('no deep water on this bearing');
  const x = island.position.x + Math.cos(angle) * (deep.r + standoff);
  const z = island.position.z + Math.sin(angle) * (deep.r + standoff);
  // Heading points at the island centre (rotation 0 = +z forward).
  const inX = -Math.cos(angle);
  const inZ = -Math.sin(angle);
  return {
    ship: {
      id: 'aground', type: 'sloop', ownerId: 'skipper',
      position: { x, y: 0, z },
      rotation: Math.atan2(inX, inZ),
      velocity: { x: inX * speed, y: 0, z: inZ * speed },
      angularVelocity: 0,
      anchored: false,
      holes: [], nextHoleId: 1,
      maxHull: 600, repairCooldown: 0, autoRepairProgress: 0,
    },
    drive: { x: inX * speed, y: 0, z: inZ * speed },
  };
}

/** Drive the hull onto the shelf for `seconds`, re-applying the sail thrust each
 *  tick (the sail model would otherwise be doing that inside updateShips). */
function grind(physics, ship, drive, seconds, t0 = 0) {
  let t = t0;
  for (let i = 0; i < Math.ceil(seconds / DT); i += 1) {
    ship.position.x += ship.velocity.x * DT;
    ship.position.z += ship.velocity.z * DT;
    physics.pushShipOutOfIsland(ship, island, t);
    ship.velocity.x = drive.x;
    ship.velocity.z = drive.z;
    t += DT;
  }
  return t;
}

console.log('Grounding breach cap');

// ── 1. Full-sail beaching: hard, but survivable and capped ──
{
  const physics = new PhysicsSystem();
  const { ship, drive } = makeCharge(0.7, 7.5);
  grind(physics, ship, drive, 12);
  const open = countOpenHoles(ship);
  expect('a full-sail beaching does open the hull', open >= 1, `open=${open}`);
  expect('twelve seconds hard aground stays inside the per-event cap',
    open <= SHIP.GROUND_MAX_HOLES_PER_EVENT_MAX,
    `open=${open}, cap=${SHIP.GROUND_MAX_HOLES_PER_EVENT_MAX}`);
  expect('a beaching never saturates the hull hole cap',
    open < FLOODING.MAX_HOLES_PER_SHIP,
    `open=${open}, ship cap=${FLOODING.MAX_HOLES_PER_SHIP}`);
  expect('every grounding breach sits at the keel, under water',
    ship.holes.every((h) => h.y < FLOODING.HOLE_BAND_Y.max + 0.2),
    JSON.stringify(ship.holes.map((h) => +h.y.toFixed(2))));
}

// ── 2. Breaches are spaced, not machine-gunned ──
{
  const physics = new PhysicsSystem();
  const { ship, drive } = makeCharge(2.1, 7.5);
  grind(physics, ship, drive, SHIP.GROUND_HOLE_INTERVAL * 0.8);
  expect('a single tick of contact cannot open more than one hit\'s worth',
    countOpenHoles(ship) <= 2, `open=${countOpenHoles(ship)}`);
}

// ── 3. Ghosting in gently costs less than charging ──
{
  const soft = new PhysicsSystem();
  const a = makeCharge(3.4, 2.6);
  grind(soft, a.ship, a.drive, 12);
  const hard = new PhysicsSystem();
  const b = makeCharge(3.4, 8.5);
  grind(hard, b.ship, b.drive, 12);
  expect('a gentle grounding is capped below a full-sail one',
    countOpenHoles(a.ship) <= SHIP.GROUND_MAX_HOLES_PER_EVENT_MIN
    && countOpenHoles(a.ship) <= countOpenHoles(b.ship),
    `gentle=${countOpenHoles(a.ship)} hard=${countOpenHoles(b.ship)}`);
}

// ── 4. The cap is per EVENT — a second beaching costs again ──
{
  const physics = new PhysicsSystem();
  const { ship, drive } = makeCharge(4.9, 7.5);
  let t = grind(physics, ship, drive, 12);
  const first = countOpenHoles(ship);
  // Haul off into deep water and let the event go cold.
  const off = makeCharge(4.9, 7.5);
  ship.position = { ...off.ship.position };
  ship.velocity = { x: 0, y: 0, z: 0 };
  t = grind(physics, ship, { x: 0, y: 0, z: 0 }, SHIP.GROUND_EVENT_RESET_SEC + 2, t);
  // ...then run her aground again.
  grind(physics, ship, drive, 12, t);
  expect('a second, separate grounding opens the hull again',
    countOpenHoles(ship) > first, `first=${first} after second=${countOpenHoles(ship)}`);
}

// ── 5. Nobody founders offscreen: berths shelter, bot crews are forgiven ──
//
// WHAT THE SHELTERS ACTUALLY PROMISE. Berth shelter and bot-grounding
// forgiveness are rails against the WORLD — seabed, reef and tempest. They are
// deliberately NOT a peace treaty between hulls: a bot helm that puts her bow
// through another bot's quarter has hit a SHIP, and `rebuildEnvSafeShips` has
// nothing to say about it.
//
// This assertion used to count every open hole regardless of cause, so a
// bot-on-bot collision at ~t=36s ('ram', 3 breaches, one tick, nobody sank)
// failed the suite roughly one run in fourteen. The engine was right and the
// question was wrong. Now the environmental sources are held to zero — which is
// the actual contract, and a strictly sharper reading of it, since a single
// 'ground' breach can no longer hide behind "well, something rammed" — and
// hull-on-hull contact is reported instead of asserted away.
const WORLD_SOURCES = new Set(['ground', 'rock', 'storm']);
{
  const match = new Match({ matchId: 'grounding-cap-pacing', botCount: 9 });
  match.state.phase = 'playing';
  const startAfloat = match.state.shipsAlive;
  const berthed = new Set(match.state.ships.map((s) => s.id));
  let worstWorldHoles = 0;
  const worldWitness = [];
  let hullContactHoles = 0;
  const steps = Math.ceil(120 / DT);
  for (let i = 0; i < steps; i += 1) {
    match.tick();
    for (const ship of match.state.ships) {
      if (!berthed.has(ship.id)) continue;
      let world = 0;
      for (const hole of ship.holes) {
        if (hole.patched) continue;
        if (WORLD_SOURCES.has(hole.source ?? 'ground')) {
          world += 1;
          if (!hole.__witnessed) {
            hole.__witnessed = true;
            worldWitness.push(`${hole.source ?? 'unsourced'} on ${ship.id.slice(0, 8)} at t=${match.t.toFixed(1)}s`);
          }
        } else if (!hole.__witnessed) {
          hole.__witnessed = true;
          hullContactHoles += 1;
        }
      }
      worstWorldHoles = Math.max(worstWorldHoles, world);
    }
  }
  expect('no crew is eliminated by the world in the first two minutes',
    match.state.shipsAlive === startAfloat,
    `afloat ${match.state.shipsAlive} / ${startAfloat} at t=${match.t.toFixed(0)}s`);
  expect('the world opens no breach at all through the peace window',
    worstWorldHoles === 0,
    `worst open world-sourced holes = ${worstWorldHoles}${worldWitness.length ? `\n     ${worldWitness.join('\n     ')}` : ''}`);
  if (hullContactHoles > 0) {
    console.log(`    (${hullContactHoles} hull-on-hull breach(es) — not a world source, not sheltered by design)`);
  }
  expect('the peace window is the one being measured',
    match.t <= BOT_EARLY_PEACE_SECONDS, `t=${match.t.toFixed(0)}s`);
  match.stop?.();
}

if (failures > 0) {
  console.error(`\n${failures} grounding-cap assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll grounding-cap assertions passed.');
