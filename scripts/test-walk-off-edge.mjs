#!/usr/bin/env node
// THE EDGE OF THE ISLAND (GRID-01 slice c: physics-28, physics-21, physics-34).
//
// Three different numbers used to decide where an island stops, and none of
// them was where the island stops:
//
//   * the WALK FLOOR switched off at distRatio 1.0, while rocky coasts hold
//     terrain to ~1.14 and cliff plinths to ~1.05 — so a pirate walking to the
//     edge lost the ground with 2-20 m of drawn shore face still under her and
//     fell INSIDE it (60 of 305 dry-edge columns, probe 5);
//   * the SWIM SEABED collided out to 1.22 while the cap was only drawn to
//     1.155 — an invisible sandbar you were held on and could not dive off;
//   * the TERRAIN RAYCAST stopped at 1.03, so up to 3.4 m of drawn shore rock
//     was shoot-through in both directions.
//
// One apron now: SHORE_APRON_DIST_RATIO. This suite asserts each of the three
// against the shared field and the ray marcher.
//
//   node --import tsx scripts/test-walk-off-edge.mjs
//   MUTATE=footprint  (the old 1.0 walk floor)  → red
//   MUTATE=raylimit   (the old 1.03 ray limit)  → red
//   MUTATE=seabed     (the old analytic seabed cut at a fixed 1.22) → red
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import {
  SHORE_APRON_DIST_RATIO, WALK_FOOTPRINT_MARGIN,
  getIslandSurfaceY, getIslandSurfacePoint, isPointInsideIslandFootprint, getIslandDistRatio,
} from '../src/shared/utils/index.ts';
import { raymarchIslandSurface } from '../src/shared/raycast.ts';
import { buildTerrainGrid, GridGround, drawnIslandSurfaceY } from '../src/shared/terrainGrid.ts';

/** The server's swimSeabedY, as PhysicsSystem now computes it. */
function swimSeabedY(all, x, z) {
  let floor = -Infinity;
  for (const island of all) {
    const drawn = drawnIslandSurfaceY(island, x, z);
    if (drawn !== null && drawn > floor) floor = drawn;
  }
  return floor;
}

const MUTATE = process.env.MUTATE ?? '';
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const islands = new MapGenerator(20260801).generateIslands();
const HEADINGS = 180;
/** Terrain this far above the waterline is land you can stand on and see. */
const DRY = 0.3;
console.log(`\nGRID-01 slice c — the edge of the island  (${islands.length} islands x ${HEADINGS} headings${MUTATE ? `, MUTATE=${MUTATE}` : ''})\n`);

// ── 1. The walk floor never switches off over dry land ───────────────────────
// Where findPlayerIsland stops returning an island, the walker's floor becomes
// -Infinity and he falls. So at the LIMIT ring the shared field must already be
// under water on every column of every island.
{
  const margin = MUTATE === 'footprint' ? 0 : WALK_FOOTPRINT_MARGIN;
  let dryColumns = 0; let total = 0; let worst = -Infinity; let worstWhere = '';
  for (const island of islands) {
    for (let h = 0; h < HEADINGS; h++) {
      const angle = (h / HEADINGS) * Math.PI * 2;
      // Just OUTSIDE the limit: the first step with no floor under it.
      const p = getIslandSurfacePoint(island, 1 + margin + 0.004, angle);
      total++;
      const y = getIslandSurfaceY(island, p.x, p.z);
      // Sanity: the predicate and the ring must agree about being outside.
      const inside = isPointInsideIslandFootprint(island, p.x, p.z, margin * Math.max(island.radius, 1));
      if (inside) continue;
      if (y > DRY) {
        dryColumns++;
        if (y > worst) { worst = y; worstWhere = `${island.id} at ${(angle * 180 / Math.PI).toFixed(0)}°`; }
      }
    }
  }
  expect(`the walk floor never ends over dry land (${total} columns)`,
    dryColumns === 0,
    `${dryColumns} columns drop the walker with terrain up to ${worst.toFixed(1)} m above the sea — worst ${worstWhere}`);
}

// ── 2. The drawn cap reaches the apron the seabed collides to ───────────────
{
  let gaps = 0; let worst = 0; let worstWhere = '';
  for (const island of islands) {
    const grid = buildTerrainGrid(island);
    const ground = new GridGround(grid.positions, grid.indices);
    for (let h = 0; h < HEADINGS; h += 3) {
      const angle = (h / HEADINGS) * Math.PI * 2;
      // Inside the old invisible band (1.155 → 1.22): the seabed the swimmer is
      // clamped onto must now have drawn triangles over it.
      for (const d of [1.16, 1.19, SHORE_APRON_DIST_RATIO - 0.005]) {
        const p = getIslandSurfacePoint(island, d, angle);
        // The old cut: everything inside distRatio 1.22 got an analytic floor,
        // whether or not a triangle was drawn over it.
        const collided = MUTATE === 'seabed'
          ? getIslandSurfaceY(island, p.x, p.z)
          : swimSeabedY(islands, p.x, p.z);
        const drawn = ground.heightAt(p.x - island.position.x, p.z - island.position.z);
        // A floor with no triangle over it is the invisible sandbar.
        if (collided > -1e9 && drawn === null) {
          gaps++;
          if (d > worst) { worst = d; worstWhere = `${island.id} at ${(angle * 180 / Math.PI).toFixed(0)}° d=${d} floor ${collided.toFixed(2)} m`; }
        }
      }
    }
  }
  expect('the seabed a swimmer is clamped onto is drawn all the way to the apron',
    gaps === 0, `${gaps} sampled points have collision but no triangle — worst ${worstWhere}`);
}

// ── 3. Drawn shore rock is shootable ────────────────────────────────────────
// Probe B: every column just outside the old footprint that carries dry rock is
// fired at from 40 m seaward, level, at the height of a swimmer's head.
{
  // The old marcher declared every point past distRatio 1.03 to be air, so a
  // ray sailed through the apron rock. Model that by discarding any hit out
  // there, which is exactly what isInsideIslandTerrain used to do.
  const limit = MUTATE === 'raylimit' ? 1.03 : SHORE_APRON_DIST_RATIO;
  let rockColumns = 0; let missed = 0; let worstMiss = '';
  for (const island of islands) {
    for (let h = 0; h < HEADINGS; h++) {
      const angle = (h / HEADINGS) * Math.PI * 2;
      for (const d of [1.035, 1.05, 1.08, 1.11]) {
        const p = getIslandSurfacePoint(island, d, angle);
        const y = getIslandSurfaceY(island, p.x, p.z);
        if (y <= 0.8) continue;
        rockColumns++;
        const dirX = -Math.cos(angle); const dirZ = -Math.sin(angle);
        const origin = { x: p.x - dirX * 40, y: 0.6, z: p.z - dirZ * 40 };
        const hit = raymarchIslandSurface(origin, { x: dirX, y: 0, z: dirZ }, 60, islands);
        // The ray must stop in the rock, not sail through it: the hit has to
        // land at or before the column it was aimed at.
        const beyondOldLimit = hit.hit && hit.point
          ? getIslandDistRatio(island, hit.point.x, hit.point.z).distRatio > limit
          : false;
        if (!hit.hit || beyondOldLimit || hit.distance > 41.5) {
          missed++;
          if (!worstMiss) worstMiss = `${island.id} ${(angle * 180 / Math.PI).toFixed(0)}° d=${d} rock ${y.toFixed(2)} m`;
        }
      }
    }
  }
  expect(`drawn shore rock stops a level ray (${rockColumns} dry apron columns)`,
    rockColumns > 200 && missed === 0,
    `${missed} of ${rockColumns} columns are shoot-through — first ${worstMiss}`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — the edge of the island\n`);
process.exit(failures === 0 ? 0 : 1);
