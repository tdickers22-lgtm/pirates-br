#!/usr/bin/env node
// REPLICATED FURNITURE SITS ON THE GROUND YOU CAN SEE (ENTITYSEAT / physics-06).
//
// GroundTruth fixed props by seating them on the drawn triangles. Every
// REPLICATED entity — chests, barrels, upgrade stations — was still placed by
// the server on the analytic field and drawn at that Y, so wherever the mesh
// chord sags under a convex field (stamp rims, terrace lips, ridges) the box
// hovers. The live floater census never walked host.environment, so nothing
// measured it.
//
// This is the pure half of that measurement: register the shared terrain grid
// as the rendered sampler (it IS the drawn mesh since GRID-01) and compare the
// server's Y against the drawn ground under every chest and barrel on the
// roster, before and after the seat correction.
//
//   node --import tsx scripts/test-entity-seat.mjs
//   MUTATE=raw  (draw entities at the raw server Y, as before) → red
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { setRenderedSurfaceSampler, getSeatSurfaceY } from '../src/shared/props.ts';
import { drawnIslandSurfaceY } from '../src/shared/terrainGrid.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { seatedEntityY } from '../src/client/world/island/EntityMeshes.ts';

const MUTATE = process.env.MUTATE ?? '';
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const islands = new MapGenerator(20260801).generateIslands();
// The client publishes the drawn mesh through this hook; the shared grid IS
// that mesh, so a pure suite can stand in for the browser.
setRenderedSurfaceSampler((islandId, x, z) => {
  const island = islands.find((i) => i.id === islandId);
  return island ? drawnIslandSurfaceY(island, x, z) : null;
});

console.log(`\nENTITYSEAT — chests, barrels and stations on the drawn ground${MUTATE ? `  (MUTATE=${MUTATE})` : ''}\n`);

let entities = 0;
let worstBefore = 0; let worstAfter = 0; let worstWhere = '';
let over5cm = 0; let guarded = 0;
for (const island of islands) {
  const list = [
    ...island.chests.filter((c) => !c.carriedByPlayerId && !c.storedOnShipId && !c.floating)
      .map((c) => ({ kind: 'chest', x: c.position.x, y: c.position.y, z: c.position.z })),
    ...island.barrels.map((b) => ({ kind: 'barrel', x: b.position.x, y: b.position.y, z: b.position.z })),
  ];
  for (const e of list) {
    const drawn = getSeatSurfaceY(island, e.x, e.z);
    if (drawn === null || !Number.isFinite(drawn)) continue;
    const analytic = getIslandSurfaceY(island, e.x, e.z);
    // The offset the server MEANT the entity to carry above the ground.
    const intended = e.y - analytic;
    entities++;
    const shown = MUTATE === 'raw' ? e.y : seatedEntityY(island, e.x, e.z, e.y);
    const before = Math.abs((e.y - drawn) - intended);
    const after = Math.abs((shown - drawn) - intended);
    if (before > worstBefore) worstBefore = before;
    if (after > worstAfter) { worstAfter = after; worstWhere = `${island.id} ${e.kind} at (${e.x.toFixed(1)}, ${e.z.toFixed(1)})`; }
    // seatedEntityY deliberately refuses a disagreement over a metre: that is
    // not a chord gap, it is a different surface (a cave-mouth carve the server
    // never placed on). Those are counted apart and must stay rare.
    if (Math.abs(drawn - analytic) > 1) guarded++;
    else if (after > 0.05) over5cm++;
  }
}

expect(`the roster carries enough furniture to measure (${entities} chests + barrels)`, entities > 120);
expect('every settled entity keeps its intended offset above the DRAWN ground',
  over5cm === 0,
  `${over5cm} of ${entities} are more than 5 cm out — worst ${worstAfter.toFixed(3)} m at ${worstWhere}`);
expect('the over-a-metre guard catches only a handful (cave carves)',
  guarded <= 2, `${guarded} of ${entities} entities sit over a surface the mesh does not carry`);
console.log(`  · chord gap under this furniture before the seat: up to ${worstBefore.toFixed(3)} m`);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — entity seats\n`);
process.exit(failures === 0 ? 0 : 1);
