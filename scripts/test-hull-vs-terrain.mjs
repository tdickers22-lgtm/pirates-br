#!/usr/bin/env node
// THE HULL-VS-TERRAIN GATE (PHYS-02 / physics-02).
//
// The server grounded a ship by asking, at seven points ALONG HER KEEL, whether
// the seabed had risen above the keel. A keel line is one metre wide on a
// galleon whose beam is ten, so the question it answers is "is there a rock
// under my spine" — not "am I inside that cliff". A hull laid beam-on to a
// cliff coast therefore sailed her whole starboard side into the rock face and
// the server reported clear water: no bounce, no scrape, no AGROUND, the
// planking simply disappeared into the island while the camera watched.
//
// This gate stands hulls all round every island, at ratios that straddle the
// shoreline ring, and holds ONE rule:
//
//   if the physics says there is no contact, then the terrain under the drawn
//   WATERLINE OUTLINE of that hull must be below shipY + 0.5.
//
// The outline comes from the shared loft (src/shared/hull.ts) at y = 0, i.e.
// the line a player sees meet the water — never from the server's own tables,
// so the gate cannot be satisfied by editing the thing it is grading.
//
// Runs pure logic: no browser, no server, no stack.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getHullProfile, hullSurfacePointAt } from '../src/shared/hull.ts';
import { getIslandDistRatio, getIslandSurfaceY } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const TYPES = ['sloop', 'brigantine', 'galleon'];
const ANGLES = 72;
const RATIOS = [1.02, 1.05, 1.08, 1.11, 1.14];
const ISLAND_COUNT = 14;
/** Beam-on to the shore is the case a keel line cannot see; 45° is the case a
 *  captain actually sails past a headland. */
const YAW_OFFSETS = [0, Math.PI / 4];
/** How far above the hull's own waterline terrain may stand while the server
 *  still calls it clear water. Half a metre is already a visible ledge through
 *  the planking; anything more is the hull inside the island. */
const CLEARANCE = 0.5;

/** The drawn waterline silhouette: loft half-widths at y = 0, port + starboard,
 *  in hull-local (x abeam, z forward). */
function waterlineOutline(type) {
  const profile = getHullProfile(type);
  const points = [];
  for (let i = 0; i <= 20; i++) {
    const z = (-0.5 + i / 20) * profile.L;
    const half = hullSurfacePointAt(profile, z, 0).x;
    points.push({ x: half, z });
    if (half > 0.02) points.push({ x: -half, z });
  }
  return points;
}

/** World position at a given normalised distance ratio along a bearing.
 *  distRatio scales linearly along a ray, so one shape-terms lookup inverts it. */
function placeAtRatio(island, bearing, ratio) {
  const ux = Math.cos(bearing);
  const uz = Math.sin(bearing);
  const probe = island.radius;
  const at = getIslandDistRatio(island, island.position.x + ux * probe, island.position.z + uz * probe);
  const s = (ratio / Math.max(at.distRatio, 1e-6)) * probe;
  return { x: island.position.x + ux * s, z: island.position.z + uz * s };
}

const islands = new MapGenerator(3).generateIslands().slice(0, ISLAND_COUNT);
const physics = new PhysicsSystem();
const outlines = Object.fromEntries(TYPES.map((t) => [t, waterlineOutline(t)]));

console.log('— a hull the server calls clear of the island is clear of it on every plank —');

let configs = 0;
let missed = 0;
let worst = { over: 0, where: '' };
const missByType = { sloop: 0, brigantine: 0, galleon: 0 };

for (const island of islands) {
  for (const type of TYPES) {
    const stats = SHIP_STATS[type];
    const outline = outlines[type];
    for (let a = 0; a < ANGLES; a++) {
      const bearing = (a / ANGLES) * Math.PI * 2;
      // Forward axis is (sin ψ, cos ψ); this ψ lays the full broadside against
      // the coast, and YAW_OFFSETS swings her off it.
      const beamOn = Math.atan2(Math.cos(bearing), -Math.sin(bearing));
      for (const yaw of YAW_OFFSETS) {
      const rotation = beamOn + yaw;
      const sin = Math.sin(rotation);
      const cos = Math.cos(rotation);
      for (const ratio of RATIOS) {
        const at = placeAtRatio(island, bearing, ratio);
        const ship = {
          id: `probe-${type}`,
          type,
          position: { x: at.x, y: 0, z: at.z },
          rotation,
          velocity: { x: 0, y: 0, z: 0 },
          angularVelocity: 0,
          sailHeight: 1,
          anchored: false,
          alive: true,
          sinking: false,
          holes: [],
          bilge: 0,
        };
        // Highest terrain anywhere under the drawn waterline outline.
        let over = -Infinity;
        for (const p of outline) {
          const wx = at.x + p.x * cos + p.z * sin;
          const wz = at.z + p.z * cos - p.x * sin;
          const y = getIslandSurfaceY(island, wx, wz);
          if (y > over) over = y;
        }
        configs += 1;
        const res = physics.pushShipOutOfIsland(ship, island, 0);
        if (res.contact) continue;
        if (over >= ship.position.y + CLEARANCE) {
          missed += 1;
          missByType[type] += 1;
          if (over > worst.over) {
            worst = { over, where: `${type} island@${island.position.x.toFixed(0)},${island.position.z.toFixed(0)} bearing ${(bearing * 180 / Math.PI).toFixed(0)}° ratio ${ratio}` };
          }
        }
      }
      }
    }
  }
}

expect(
  `${configs} hull placements: 0 pass through terrain unseen`,
  missed === 0,
  missed === 0 ? '' : `${missed} placements report NO contact while land stands up to ${worst.over.toFixed(2)} m over the waterline outline`
    + `\n     by class: sloop ${missByType.sloop}, brigantine ${missByType.brigantine}, galleon ${missByType.galleon}`
    + `\n     worst: ${worst.where}`,
);

// TWO CONTROLS, one against each way of cheating this gate.
//
// (1) A hull standing on real high ground must report contact — otherwise the
//     rule above is satisfiable by never detecting anything at all. Only the
//     inland placements whose outline really is over land are graded: an island
//     with a crescent bay or a flooded crater has genuine water at ratio 0.25.
// (2) A hull in open water must NOT report contact — otherwise the rule above
//     is satisfiable by declaring contact everywhere, which would weld every
//     ship in the map to the nearest island.
console.log('— control: a hull over high ground is contact, a hull offshore is not —');
let onLandCases = 0;
let onLandContacts = 0;
let offshoreCases = 0;
let offshoreContacts = 0;
for (const island of islands) {
  for (const type of TYPES) {
    const outline = outlines[type];
    for (let a = 0; a < 8; a++) {
      const bearing = (a / 8) * Math.PI * 2;
      for (const ratio of [0.25, 0.55, 1.35, 1.6]) {
        const at = placeAtRatio(island, bearing, ratio);
        const rotation = bearing;
        const sin = Math.sin(rotation);
        const cos = Math.cos(rotation);
        let over = -Infinity;
        for (const p of outline) {
          const y = getIslandSurfaceY(island, at.x + p.x * cos + p.z * sin, at.z + p.z * cos - p.x * sin);
          if (y > over) over = y;
        }
        const ship = {
          id: 'control', type, position: { x: at.x, y: 0, z: at.z }, rotation,
          velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1,
          anchored: false, alive: true, sinking: false, holes: [], bilge: 0,
        };
        const contact = physics.pushShipOutOfIsland(ship, island, 0).contact;
        if (ratio < 1 && over > 1.0) { onLandCases += 1; if (contact) onLandContacts += 1; }
        if (ratio > 1.3 && over < -1.2) { offshoreCases += 1; if (contact) offshoreContacts += 1; }
      }
    }
  }
}
expect(`${onLandCases} hulls over land: all report contact`, onLandCases > 100 && onLandContacts === onLandCases,
  `only ${onLandContacts}/${onLandCases} reported contact`);
expect(`${offshoreCases} hulls in deep water: none report contact`, offshoreCases > 100 && offshoreContacts === 0,
  `${offshoreContacts}/${offshoreCases} reported a phantom contact`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS: hull-vs-terrain');
