#!/usr/bin/env node
// BALLISTIC BODIES vs THE TERRAIN (physics-33, physics-10, physics-15).
//
// A pirate fired out of her own cannon, or thrown by a geyser, is not a walker:
// she is in the `cannonBallistic` branch of PhysicsSystem, and that branch used
// to run ONE test against the NATURAL surface — `if (y <= getIslandSurfaceY(...))
// y = getIslandSurfaceY(...)`. Three consequences a player can see:
//
//  A1  A body flying INTO a cliff face is teleported to the cliff TOP in one
//      tick. The finder measured single-tick lifts >5 m on 111 of 178 headings,
//      max 17.75 m. On the wire that is a pop: the client predicts the arc, the
//      snapshot says "on the summit".
//  A2  A body inside a CAVE reads the mountain ABOVE the roof as its ground and
//      is teleported through the roof onto the hilltop. 98/98 cave placements.
//  A3  The tavern has no roof: a body drops through the slates onto the floor.
//
// This suite drives the real PhysicsSystem over the real fixed world. It grades
// the SINGLE-TICK VERTICAL LIFT, which is the shape of the defect — a landing is
// allowed to raise a body onto the ground under it, but never by a cliff height
// in one 16 ms tick.
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import {
  getCaveCeilingY,
  getCaveFloorY,
  getIslandSurfaceY,
  getTavernWallBand,
  toTavernLocal,
} from '../src/shared/utils/index.ts';
import { makeTestPlayer } from './lib/test-player.mjs';

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
/** A landing may lift a body onto the ground under it; a tick that raises it by
 *  more than this is a teleport, not a landing. A 25 m/s body covers 0.4 m of
 *  ground per tick, so even a 45° ramp only accounts for 0.4 m. */
const MAX_TICK_LIFT = 2.0;

const islands = new MapGenerator(20260801).generateIslands();

console.log('Ballistic bodies vs the terrain');

// ── A1. Flying into a cliff face ─────────────────────────────
// The defect needs a body meeting a FACE, not a body drifting onto a beach, so
// this does not guess an arc: on each heading it SCANS inward for the single
// steepest tick-step on that ray (the wobbled coastline reaches 7.1 m of rise
// per 0.64 m of run on Skull Cove — an 84° wall) and fires a body horizontally
// into it at cannon speed, half way up. That is a pirate who launched herself
// off a deck and arrived at a cliff, which is precisely the finder's case.
{
  const HEADINGS = 24;
  /** One tick of closing ground at the speed graded below. */
  const SPEED = 40;
  const PROBE_STEP = SPEED * DT;
  /** A step smaller than this is a ramp, not a face; skip the heading. */
  const MIN_FACE_RISE = 1.2;
  let arcs = 0;
  let lifted2 = 0;
  let lifted5 = 0;
  let worst = 0;
  let worstWhere = '';
  for (const island of islands) {
    for (let h = 0; h < HEADINGS; h++) {
      const ang = (h / HEADINGS) * Math.PI * 2;
      const cx = Math.cos(ang);
      const cz = Math.sin(ang);
      // Steepest step on this ray, walking from outside the footprint inward.
      let faceR = 0;
      let faceRise = 0;
      let faceBaseY = 0;
      for (let r = island.radius * 1.4; r > island.radius * 0.15; r -= PROBE_STEP) {
        const outY = getIslandSurfaceY(island, island.position.x + cx * r, island.position.z + cz * r);
        const inY = getIslandSurfaceY(
          island,
          island.position.x + cx * (r - PROBE_STEP),
          island.position.z + cz * (r - PROBE_STEP),
        );
        if (inY - outY > faceRise) { faceRise = inY - outY; faceR = r; faceBaseY = outY; }
      }
      if (faceRise < MIN_FACE_RISE) continue;
      arcs += 1;
      // Start 2 m out from the FOOT of the face (the ground there is faceBaseY),
      // flying level straight at it. At the foot the whole face is above the
      // body, so the broken point test reports the face TOP as her ground and
      // the lift it produces is the full cliff height — the shape of the defect.
      const startR = faceR + 2;
      const physics = new PhysicsSystem();
      const player = makeTestPlayer(
        {
          x: island.position.x + cx * startR,
          y: Math.max(faceBaseY, 0) + 0.6,
          z: island.position.z + cz * startR,
        },
        {
          velocity: { x: -cx * SPEED, y: 0, z: -cz * SPEED },
          cannonBallistic: true,
          cannonFlightTimer: 6,
        },
      );
      let t = 0;
      for (let i = 0; i < 250 && player.cannonBallistic; i++) {
        const before = player.position.y;
        physics.update(DT, t, [], [player], [], [island], []);
        t += DT;
        const lift = player.position.y - before;
        if (lift > worst) { worst = lift; worstWhere = `${island.name ?? island.id} heading ${h}`; }
        if (lift > MAX_TICK_LIFT) lifted2 += 1;
        if (lift > 5) lifted5 += 1;
      }
    }
  }
  expect(
    'A1 graded a real population of cliff-bound arcs',
    arcs >= 40,
    `arcs=${arcs}`,
  );
  expect(
    `A1 no ballistic body is lifted more than ${MAX_TICK_LIFT} m in one tick`,
    lifted2 === 0,
    `ticks over ${MAX_TICK_LIFT} m = ${lifted2} (over 5 m = ${lifted5}); worst=${worst.toFixed(2)} m at ${worstWhere}; arcs=${arcs}`,
  );
}

// ── A2. Inside a cave, under the roof ────────────────────────────────────────
// Walk in from every cave mouth until the roof is overhead, place a body a metre
// off the floor with a little lift, and step once. It must stay under the roof.
{
  let stations = 0;
  let throughRoof = 0;
  let worst = 0;
  for (const island of islands) {
    for (const cave of island.caves ?? []) {
      const toCentreX = island.position.x - cave.position.x;
      const toCentreZ = island.position.z - cave.position.z;
      const len = Math.hypot(toCentreX, toCentreZ) || 1;
      const dx = toCentreX / len;
      const dz = toCentreZ / len;
      const found = [];
      for (let d = 1; d <= cave.length * 0.9 && found.length < 2; d += 0.5) {
        const x = cave.position.x + dx * d;
        const z = cave.position.z + dz * d;
        const ceil = getCaveCeilingY(island, x, z);
        const floor = getCaveFloorY(island, x, z);
        if (ceil === null || floor === null) continue;
        if (ceil - floor < 2.4) continue;
        if (found.length === 0 && d < cave.length * 0.2) continue;
        if (found.length === 1 && d < found[0].d + cave.length * 0.25) continue;
        found.push({ x, z, floor, ceil, d });
      }
      for (const st of found) {
        stations += 1;
        const physics = new PhysicsSystem();
        const player = makeTestPlayer(
          { x: st.x, y: st.floor + 1, z: st.z },
          { velocity: { x: 0, y: 0.5, z: 0 }, cannonBallistic: true, cannonFlightTimer: 6 },
        );
        physics.update(DT, 0, [], [player], [], [island], []);
        const rise = player.position.y - (st.floor + 1);
        if (rise > worst) worst = rise;
        if (player.position.y > st.ceil) throughRoof += 1;
      }
    }
  }
  expect('A2 graded a real population of cave stations', stations >= 20, `stations=${stations}`);
  expect(
    'A2 no ballistic body in a cave is pushed through the roof in one tick',
    throughRoof === 0,
    `through=${throughRoof}/${stations}; worst single-tick rise=${worst.toFixed(2)} m`,
  );
}

// ── A3. The tavern has a roof ────────────────────────────────────────────────
// A body dropped over the ridge line must stop ON the slates, not inside the bar.
{
  const taverns = islands.filter((i) => i.tavern);
  expect('The roster has a tavern to land on', taverns.length >= 1, `count=${taverns.length}`);
  let landedInside = 0;
  for (const island of taverns) {
    const tav = island.tavern;
    const band = getTavernWallBand(tav);
    const physics = new PhysicsSystem();
    const player = makeTestPlayer(
      { x: tav.position.x, y: band.maxY + 6, z: tav.position.z },
      { velocity: { x: 0, y: -2, z: 0 }, cannonBallistic: true, cannonFlightTimer: 6 },
    );
    let t = 0;
    for (let i = 0; i < 200 && player.cannonBallistic; i++) {
      physics.update(DT, t, [], [player], [], [island], []);
      t += DT;
    }
    const local = toTavernLocal(tav, player.position.x, player.position.z);
    const inside = Math.abs(local.x) < tav.width * 0.5 && Math.abs(local.z) < tav.depth * 0.5;
    if (inside && player.position.y < band.maxY - 0.5) landedInside += 1;
  }
  expect(
    'A3 a body dropped on the tavern stops on the roof, not in the bar',
    landedInside === 0,
    `fell through on ${landedInside}/${taverns.length} taverns`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} ballistic-terrain assertion(s) failed.`);
  process.exit(1);
}
console.log('All ballistic-terrain assertions passed.');
