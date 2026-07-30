// Walk-in / walk-out test for every cave system using the real PhysicsSystem:
// spawn outside the mouth, walk the mouth axis to the deep junction, then walk
// back out. Assert: never flips to swimming, never ejected to the natural
// surface, and actually exits past the lip.
//
// Plus the CAVES ARE SOLID suite (a human playtest reported "walk-through parts
// and see-through walls", and an automated hunt then found 13,000+ escapes):
//   • the hunter's own escape repros, pinned by coordinate + heading;
//   • a systematic outward sweep — every segment, every heading, walk AND jump;
//   • mouth lips — walking out at shallow angles must neither pop you onto the
//     gully rim nor brick against a trench wall that isn't drawn;
//   • floor continuity across segment seams, everywhere a body can stand;
//   • and the drawn rock shell provably enclosing the walkable interior, which
//     is what stops an eye near a wall from seeing the whole island through it.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import {
  CAVE_MOUTH_TRENCH_FADE, CAVE_MOUTH_TRENCH_K, CAVE_NEAR_OVERHANG, CAVE_WALL_PAD,
  getCaveInteriorAt, getIslandSurfaceY, getCaveCeilingY, getCaveFloorY, isInsideCaveInterior,
} from '../src/shared/utils/index.ts';
import {
  CAVE_SHELL_MARGIN, capCaveTubeRims, caveTubeParams, cullCaveTubeAgainstNeighbors,
  insideCaveShellVolume, makeCaveTubeGeometry,
} from '../src/client/rendering/factories/CaveGeometry.ts';
import * as THREE from 'three';
import { getCaveMouthCarve, isNearCaveMouthCut, getIslandMaxRadius, getIslandSurfacePoint } from '../src/shared/utils/index.ts';
import { buildTerrainHeightfield } from '../src/client/world/island/TerrainMeshBuilder.ts';
import { MeshGround } from '../src/client/world/island/GroundTruth.ts';
import {
  CAVE_CUTOUT_LIFT, CAVE_CUTOUT_PAD_DEEP, CAVE_CUTOUT_PAD_NEAR,
  buildCaveCutout, caveCollarLength, caveCutoutHit,
} from '../src/client/world/island/CaveMouthCutout.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

const islands = new MapGenerator(12345).generateIslands();
const DT = 0.016;

function makePlayer(position, overrides = {}) {
  return {
    id: 'audit', name: 'Audit', shipId: null, position: { ...position },
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
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null, ...overrides,
  };
}

let failures = 0;
const expect = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

for (const island of islands) {
  const mouth = (island.caves ?? []).find((c) => c.hasMouth);
  if (!mouth) continue;
  console.log(`\n── ${island.id} (${island.profile.terrainStyle}, ${island.caves.length} segs) ──`);
  const phys = new PhysicsSystem();
  const inX = -Math.sin(mouth.rotation), inZ = -Math.cos(mouth.rotation);
  const startX = mouth.position.x - inX * 3.0, startZ = mouth.position.z - inZ * 3.0;
  const startY = getIslandSurfaceY(island, startX, startZ);
  const p = makePlayer({ x: startX, y: startY, z: startZ });
  const SPEED = 3.4;
  let everSwim = false, maxEject = 0, minY = 1e9;
  const walk = (dirX, dirZ, ticks) => {
    for (let i = 0; i < ticks; i++) {
      p.velocity.x = dirX * SPEED; p.velocity.z = dirZ * SPEED;
      p.position.x += p.velocity.x * DT; p.position.z += p.velocity.z * DT;
      phys.update(DT, i * DT, [], [p], [], islands, []);
      if (p.state === 'swimming') everSwim = true;
      minY = Math.min(minY, p.position.y);
      const cf = getCaveFloorY(island, p.position.x, p.position.z);
      if (cf !== null) {
        const natural = getIslandSurfaceY(island, p.position.x, p.position.z);
        if (p.position.y > natural + 0.5) maxEject = Math.max(maxEject, p.position.y - natural);
      }
    }
  };
  // In: mouth (15m) + junction (~8m) + a bit = walk ~26m inward
  const inTicks = Math.round((mouth.length + 11) / (SPEED * DT));
  walk(inX, inZ, inTicks);
  const midX = p.position.x, midZ = p.position.z, midY = p.position.y;
  const midCave = getCaveFloorY(island, midX, midZ);
  expect('reached the deep interior on foot (in-cave, below grade)',
    midCave !== null && Math.abs(midY - midCave) < 1.2 && midY < getIslandSurfaceY(island, midX, midZ) - 2,
    `y=${midY.toFixed(2)} caveFloor=${midCave === null ? 'null' : midCave.toFixed(2)} natural=${getIslandSurfaceY(island, midX, midZ).toFixed(2)}`);
  expect('never flipped to swimming inside', !everSwim);
  // The client swaps the listener's reverb space to 'cave' and its footsteps to
  // stone off this exact predicate, so it must agree with where the physics
  // actually put the pirate: true down here, false on the hillside overhead.
  expect('audio cave test: TRUE at the deep interior',
    isInsideCaveInterior(island, midX, midY, midZ),
    `y=${midY.toFixed(2)} caveFloor=${midCave === null ? 'null' : midCave.toFixed(2)}`);
  expect('audio cave test: FALSE standing on the hillside above the tunnel',
    !isInsideCaveInterior(island, midX, getIslandSurfaceY(island, midX, midZ) + 0.03, midZ));
  expect('never ejected above the hillside', maxEject === 0, `eject=${maxEject.toFixed(2)}m`);
  // Out: walk back the same axis
  walk(-inX, -inZ, inTicks + Math.round(3 / (SPEED * DT)));
  const outDist = Math.hypot(p.position.x - mouth.position.x, p.position.z - mouth.position.z);
  const outNatural = getIslandSurfaceY(island, p.position.x, p.position.z);
  expect('walked back OUT past the mouth lip',
    outDist > 2.0 && Math.abs(p.position.y - outNatural) < 1.0 && getCaveFloorY(island, p.position.x, p.position.z) === null,
    `outDist=${outDist.toFixed(1)} y=${p.position.y.toFixed(2)} natural=${outNatural.toFixed(2)}`);
  expect('audio cave test: FALSE back outside the mouth (reverb returns to outdoor)',
    !isInsideCaveInterior(island, p.position.x, p.position.y, p.position.z));
  expect('still alive and unhurt', p.state === 'alive' && p.health > 95, `state=${p.state} hp=${p.health.toFixed(0)}`);
  console.log(`   deepest walk y=${minY.toFixed(2)}`);
}

// ── Caves are SOLID ────────────────────────────────────────────────────────
// Shared driver: settle a body at a stance, then drive it for `secs` on a fixed
// heading (optionally jumping) through the real PhysicsSystem. Reports the worst
// "escape" — standing on the natural hillside above the cave roof — and how far
// the body actually travelled (a wall you can't see must not brick you either).
const DRIVE_SPEED = 4.2;
function drive(island, islands, sx, sz, sy, heading, { jump = false, secs = 1.2 } = {}) {
  const phys = new PhysicsSystem();
  const p = makePlayer({ x: sx, y: sy, z: sz });
  for (let i = 0; i < 6; i++) phys.update(DT, i * DT, [], [p], [], islands, []);
  const settledY = p.position.y;
  if (jump) p.velocity.y = 8;
  const dx = Math.sin(heading), dz = Math.cos(heading);
  let escape = 0, worstAt = null, maxTickRise = 0;
  const ticks = Math.round(secs / DT);
  let prevY = p.position.y;
  for (let i = 0; i < ticks; i++) {
    p.velocity.x = dx * DRIVE_SPEED; p.velocity.z = dz * DRIVE_SPEED;
    p.position.x += p.velocity.x * DT; p.position.z += p.velocity.z * DT;
    phys.update(DT, i * DT, [], [p], [], islands, []);
    if (!jump) maxTickRise = Math.max(maxTickRise, p.position.y - prevY);
    prevY = p.position.y;
    const ceil = getCaveCeilingY(island, p.position.x, p.position.z);
    const nat = getIslandSurfaceY(island, p.position.x, p.position.z);
    // Escaped: over a cave's footprint but standing on the hillside ABOVE its
    // roof — the landing snap fired the body out through solid rock.
    const above = ceil !== null
      ? p.position.y > ceil + 0.5 && p.position.y > nat - 0.8
      : getCaveFloorY(island, p.position.x, p.position.z) === null && p.position.y > nat - 0.8;
    if (above && p.position.y > settledY + 2.0 && escape < p.position.y - settledY) {
      escape = p.position.y - settledY;
      worstAt = { x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2) };
    }
  }
  return { escape, worstAt, maxTickRise, moved: Math.hypot(p.position.x - sx, p.position.z - sz), player: p };
}

// Every cave-local (lx, lz) → world helper the geometry uses.
const caveWorld = (c, lx, lz) => ({
  x: c.position.x + lx * Math.cos(c.rotation) + lz * Math.sin(c.rotation),
  z: c.position.z - lx * Math.sin(c.rotation) + lz * Math.cos(c.rotation),
});

console.log('\n── caves are solid: the hunter\'s escape repros ──');
// Coordinates + headings a defect hunt recorded as WALKING (or jumping) through
// an interior wall onto the mountainside above, worst case +49m. Each one is a
// real stance in a real gallery on seed 12345; if generation ever moves a
// gallery out from under one, the membership assert below fails loudly rather
// than the pin silently passing on open hillside.
//
// REPINNED (terrain-form wave): mountain summits became two-scale (wide massif
// shoulder + narrow crest), which moved Widow's Watch's whole network and one
// of Crow's Perch's side veins. The three pins below marked ✎ are the same KIND
// of stance — a body a body-width off a gallery's lateral wall, deep in the
// tunnel, facing that wall — re-sited in the reshaped galleries. Every other
// pin is the hunter's original coordinate and still lands underground.
const ESCAPE_PINS = [
  ['old-maw-caldera', 44.11, 32.90, 3.93], ['old-maw-caldera', 37.96, 46.75, 2.36],
  ['crow-s-perch', -304.10, 241.63, 3.14], ['crow-s-perch', -333.87, 261.14, 4.24], // ✎
  ['crow-s-perch', -298.49, 266.57, 1.96], ['crow-s-perch', -312.47, 265.68, 0.39],
  ['castaway-reach', 400.79, -392.59, 1.18], ['castaway-reach', 414.35, -373.34, 1.96],
  ['skull-cove', 709.41, -71.96, 5.89], ['skull-cove', 706.38, -60.74, 0.0],
  ['skull-cove', 690.97, -62.53, 0.0],
  ['gallows-sands', 640.38, -647.48, 5.50], ['gallows-sands', 653.95, -647.32, 2.36],
  ['widow-s-watch', -617.86, -561.71, 2.13], ['widow-s-watch', -611.70, -555.15, 1.02], // ✎
];
let pinEscapes = 0, pinWorst = 0, pinWorstAt = '';
for (const [id, x, z, heading] of ESCAPE_PINS) {
  const island = islands.find((i) => i.id === id);
  const interior = island ? getCaveInteriorAt(island, x, z) : null;
  if (!interior) {
    console.error(`  ✗ FAIL: pin (${x}, ${z}) on ${id} is no longer inside a cave — repin it`);
    failures++;
    continue;
  }
  for (const jump of [false, true]) {
    const res = drive(island, islands, x, z, interior.floorY, heading, { jump });
    if (res.escape > 0) {
      pinEscapes++;
      if (res.escape > pinWorst) { pinWorst = res.escape; pinWorstAt = `${id} (${x}, ${z}) h=${heading} jump=${jump} → +${res.escape.toFixed(1)}m`; }
    }
  }
}
expect(`${ESCAPE_PINS.length} recorded escape repros stay underground (walking and jumping)`,
  pinEscapes === 0, `${pinEscapes} escaped, worst ${pinWorst.toFixed(1)}m: ${pinWorstAt}`);

console.log('\n── caves are solid: outward sweep of every segment ──');
let sweepRuns = 0, sweepEscapes = 0, sweepWorst = 0, sweepWorstAt = '';
for (const island of islands) {
  const caves = island.caves ?? [];
  if (caves.length === 0) continue;
  for (const [si, c] of caves.entries()) {
    const cR = c.interiorRadius ?? 3, cLen = c.length ?? 10;
    for (const tf of [0.3, 0.62, 0.9]) {
      for (const lxf of [-0.8, 0, 0.8]) {
        const { x, z } = caveWorld(c, cR * lxf, -cLen * tf);
        const interior = getCaveInteriorAt(island, x, z);
        if (!interior) continue;
        // Only stances genuinely UNDER the mountain can escape upward at all.
        if (getIslandSurfaceY(island, x, z) < interior.floorY + 2) continue;
        for (let h = 0; h < 8; h++) {
          for (const jump of [false, true]) {
            sweepRuns++;
            const res = drive(island, islands, x, z, interior.floorY, (h / 8) * Math.PI * 2, { jump, secs: 0.9 });
            if (res.escape > 0) {
              sweepEscapes++;
              if (res.escape > sweepWorst) {
                sweepWorst = res.escape;
                sweepWorstAt = `${island.id} seg${si} (${x.toFixed(2)}, ${z.toFixed(2)}) h=${h} jump=${jump}`;
              }
            }
          }
        }
      }
    }
  }
}
expect(`no wall in any segment can be walked or jumped through (${sweepRuns} drives)`,
  sweepEscapes === 0, `${sweepEscapes} escapes, worst +${sweepWorst.toFixed(1)}m at ${sweepWorstAt}`);

console.log('\n── caves are solid: mouth lips ──');
// The mouth trench is carved by the SHARED heightfield, so the gully you see is
// the gully you walk. Before that the client cut the trench and the server stood
// you on the uncut hillside: stepping off the mouth floor popped you +2-4m onto
// an invisible rim, and shallow-angle exits bricked on invisible trench walls.
let lipPops = 0, lipStuck = 0, lipWorst = 0, lipDetail = '';
for (const island of islands) {
  for (const m of (island.caves ?? []).filter((c) => c.hasMouth)) {
    const cR = m.interiorRadius ?? 3;
    const outward = Math.atan2(Math.sin(m.rotation), Math.cos(m.rotation));
    for (const lat of [-0.55, 0, 0.55]) {
      const { x, z } = caveWorld(m, cR * lat, -2.0);
      const floorY = getCaveFloorY(island, x, z);
      if (floorY === null) continue;
      for (const off of [-1.1, -0.55, 0, 0.55, 1.1]) {
        const res = drive(island, islands, x, z, floorY, outward + off, { secs: 1.6 });
        // A pop is a TELEPORT: a stride is 6.7cm, so any single tick that lifts
        // the pirate a metre is the invisible rim, not a slope they walked up.
        if (res.maxTickRise > 1.0) {
          lipPops++;
          if (res.maxTickRise > lipWorst) { lipWorst = res.maxTickRise; lipDetail = `${island.id} (${x.toFixed(2)}, ${z.toFixed(2)}) off=${off} → +${res.maxTickRise.toFixed(1)}m in one tick`; }
        }
        if (res.moved < 1.0) { lipStuck++; lipDetail ||= `${island.id} (${x.toFixed(2)}, ${z.toFixed(2)}) off=${off} moved ${res.moved.toFixed(2)}m`; }
      }
    }
  }
}
expect('walking out of a mouth never pops the pirate onto the gully rim', lipPops === 0, `${lipPops} pops, worst ${lipDetail}`);
expect('and never bricks against an invisible trench wall', lipStuck === 0, `${lipStuck} stuck: ${lipDetail}`);

console.log('\n── caves are solid: floor continuity across segment seams ──');
// The walkable union is many overlapping boxes; where two galleries at different
// depths merely GRAZE each other the blended floor steps by the difference in one
// cell — the hole players fall through. Generation keeps grazing galleries within
// half a metre of each other (overlapClash sweeps the whole footprint), so every
// step a body can actually reach stays a stride, not a storey.
const SEAM_LIMIT = 0.9;
let worstSeam = 0, worstSeamAt = '';
for (const island of islands) {
  const caves = island.caves ?? [];
  if (caves.length === 0) continue;
  // Reachable footing: inside the union, clear of the wall pushout, with real
  // headroom (a body cannot stand in a 0.4m-tall sliver of overlap).
  const footing = (x, z) => {
    const it = getCaveInteriorAt(island, x, z);
    if (!it || it.wallDist < CAVE_WALL_PAD) return null;
    if (it.ceilingY - it.floorY < 1.6) return null;
    if (getIslandSurfaceY(island, x, z) < it.floorY + 0.5) return null;
    return it.floorY;
  };
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const c of caves) {
    for (const [lx, lz] of [[-9, 3], [9, 3], [-9, -(c.length ?? 10) - 3], [9, -(c.length ?? 10) - 3]]) {
      const w = caveWorld(c, lx, lz);
      minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
      minZ = Math.min(minZ, w.z); maxZ = Math.max(maxZ, w.z);
    }
  }
  const step = 0.25;
  for (let x = minX; x <= maxX; x += step) {
    for (let z = minZ; z <= maxZ; z += step) {
      const f0 = footing(x, z);
      if (f0 === null) continue;
      for (const [dx, dz] of [[step, 0], [0, step]]) {
        const f1 = footing(x + dx, z + dz);
        if (f1 === null) continue;
        const d = Math.abs(f1 - f0);
        if (d > worstSeam) { worstSeam = d; worstSeamAt = `${island.id} (${x.toFixed(2)}, ${z.toFixed(2)}) ${f0.toFixed(2)}→${f1.toFixed(2)}`; }
      }
    }
  }
}
expect(`no floor seam over ${SEAM_LIMIT}m anywhere a pirate can stand`,
  worstSeam <= SEAM_LIMIT, `worst ${worstSeam.toFixed(2)}m at ${worstSeamAt}`);

console.log('\n── caves are solid: the drawn shell encloses the walkable interior ──');
// See-through walls were not holes in the mesh — they were the mesh being in the
// WRONG PLACE. The tube's radius wobbled between 0.67× and 1.45× the interior
// radius while collision was a hard box at 1.0×, so wherever it pinched inward an
// eye standing legally inside the cave sat outside the rock and saw the island
// exterior through the wall. Every ring must now clear the interior box.
let shellIntrusions = 0, shellWorst = 0, shellWorstAt = '';
for (const island of islands) {
  for (const [si, c] of (island.caves ?? []).entries()) {
    const cR = c.interiorRadius ?? 3;
    const cLen = c.length ?? 10;
    const floorLocal = c.floorY - c.position.y;
    const floorEndLocal = (c.floorYEnd ?? c.floorY) - c.position.y;
    const tp = caveTubeParams(c);
    const geo = makeCaveTubeGeometry(
      tp.cR, tp.tubeLen, tp.floorLocalY, tp.ceilingLocalY, tp.seed, tp.capBack, tp.tubeFloorEnd, tp.frontOvershoot,
    );
    const pos = geo.getAttribute('position');
    const floorAttr = geo.getAttribute('aFloor');
    const px = (i) => pos.getX(i), py = (i) => pos.getY(i), pz = (i) => pos.getZ(i);
    // How far INTO the interior box a point sits (0 = outside, > 0 = intruding).
    const intrusion = (x, y, z) => {
      const t = cLen > 0 ? Math.min(1, Math.max(0, -z / cLen)) : 0;
      const fl = floorLocal + (floorEndLocal - floorLocal) * t;
      // The interior box: |lx| ≤ cR, floor..ceiling, and -length ≤ lz ≤ the near
      // overhang. The tube deliberately overshoots the far plane (its open rim
      // buries inside the neighbour) and a dead-end's back cap seals it there —
      // both sit BEYOND the box in z, which is not an intrusion.
      return Math.min(cR - Math.abs(x), y - fl, fl + c.height - y, z + cLen, 1.2 - z);
    };
    // Vertices AND the midpoint of every ring edge: the shell is a closed loft,
    // so a chord between two clearing vertices is the only other way in.
    const segsPerRing = 16;
    for (let i = 0; i + segsPerRing <= pos.count; i += segsPerRing) {
      for (let s = 0; s < segsPerRing; s++) {
        const a = i + s, b = i + ((s + 1) % segsPerRing);
        if (b >= pos.count) break;
        if (floorAttr && floorAttr.getX(a) > 0.5 && floorAttr.getX(b) > 0.5) continue; // the floor IS the interior's floor
        const cand = [[px(a), py(a), pz(a)], [(px(a) + px(b)) / 2, (py(a) + py(b)) / 2, (pz(a) + pz(b)) / 2]];
        for (const [x, y, z] of cand) {
          const d = intrusion(x, y, z);
          if (d > 0.001) {
            shellIntrusions++;
            if (d > shellWorst) { shellWorst = d; shellWorstAt = `${island.id} seg${si} at local (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`; }
          }
        }
      }
    }
  }
}
expect('no tube wall/ceiling vertex or edge cuts into the walkable box',
  shellIntrusions === 0, `${shellIntrusions} intrusions, worst ${shellWorst.toFixed(2)}m at ${shellWorstAt}`);
expect('and the shell keeps a real slab of rock outside it', CAVE_SHELL_MARGIN >= 0.35,
  `CAVE_SHELL_MARGIN=${CAVE_SHELL_MARGIN}`);

console.log('\n── caves are solid: no eye underground sees daylight through the rock ──');
// The shell being in the right PLACE is not the same as the shell being CLOSED.
// Every segment draws walls but no end faces, which is fine while the segment it
// joins is at least as big — the open rim buries inside its neighbour. Where the
// bore steps DOWN across a joint (skull-cove's 5.7m-radius, 5m-tall junction
// chamber meeting the 3.3m-radius, 2.8m-tall tunnel that feeds it) the annulus
// between the two rims was drawn by nobody, and from anywhere in the big room an
// eye looking at the joint saw the island exterior through 5-10m of "rock".
// So: rebuild the real drawn shell (loft → neighbour cull → rim caps) and shoot
// rays out of every walkable eye position that has a real mountain overhead. A
// ray that reaches open air without crossing rock is a window.
const rayTri = (o, d, t) => {
  const e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
  const e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  const s = [o[0] - t[0][0], o[1] - t[0][1], o[2] - t[0][2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
  const hit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return hit > 0.02 ? hit : -1;
};
const RAY_DIRS = [];
for (let yi = 0; yi < 36; yi++) {
  const yaw = (yi / 36) * Math.PI * 2;
  // Upward only: a ray angled DOWN can never reach the sky from under a hill.
  for (const pitch of [0, 0.2, 0.4, 0.58]) {
    RAY_DIRS.push([Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)]);
  }
}
let windows = 0, windowAt = '';
for (const island of islands) {
  const caves = island.caves ?? [];
  if (caves.length === 0) continue;
  // The DRAWN shell, in world space: exactly the pipeline CaveBuilder runs.
  const CELL = 4;
  const grid = new Map();
  for (const [si, c] of caves.entries()) {
    const tp = caveTubeParams(c);
    const geo = makeCaveTubeGeometry(tp.cR, tp.tubeLen, tp.floorLocalY, tp.ceilingLocalY, tp.seed, tp.capBack, tp.tubeFloorEnd, tp.frontOvershoot);
    cullCaveTubeAgainstNeighbors(geo, c, island);
    capCaveTubeRims(geo, c, island);
    const cs = Math.cos(c.rotation), sn = Math.sin(c.rotation);
    const idx = geo.getIndex(), pos = geo.getAttribute('position');
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const i = idx.getX(t + k);
        const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
        tri.push([c.position.x + lx * cs + lz * sn, c.position.y + ly, c.position.z - lx * sn + lz * cs]);
      }
      tri.seg = si;
      const i0 = Math.floor(Math.min(tri[0][0], tri[1][0], tri[2][0]) / CELL);
      const i1 = Math.floor(Math.max(tri[0][0], tri[1][0], tri[2][0]) / CELL);
      const j0 = Math.floor(Math.min(tri[0][2], tri[1][2], tri[2][2]) / CELL);
      const j1 = Math.floor(Math.max(tri[0][2], tri[1][2], tri[2][2]) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        const arr = grid.get(key);
        if (arr) arr.push(tri); else grid.set(key, [tri]);
      }
    }
  }
  // Conservative heightfield: each cell reports the HIGHEST natural ground of
  // its corners, so "the ray broke into open air" is never claimed early.
  const HS = 1.5, HR = island.radius + 40, HN = Math.ceil((2 * HR) / HS) + 1;
  const hf = new Float32Array(HN * HN);
  for (let i = 0; i < HN; i++) for (let j = 0; j < HN; j++) {
    hf[i * HN + j] = getIslandSurfaceY(island, island.position.x - HR + i * HS, island.position.z - HR + j * HS);
  }
  const surfaceMax = (x, z) => {
    const i = Math.floor((x - (island.position.x - HR)) / HS), j = Math.floor((z - (island.position.z - HR)) / HS);
    if (i < 0 || j < 0 || i + 1 >= HN || j + 1 >= HN) return -50;
    return Math.max(hf[i * HN + j], hf[(i + 1) * HN + j], hf[i * HN + j + 1], hf[(i + 1) * HN + j + 1]);
  };
  const mouths = caves.filter((c) => c.hasMouth);
  // A sightline that leaves through a MOUTH is the cave working: the trench is
  // carved open sky by design, out to CAVE_MOUTH_TRENCH_K·radius of gully.
  const throughAMouth = (px, py, pz) => mouths.some((m) => {
    const cs = Math.cos(m.rotation), sn = Math.sin(m.rotation);
    const lx = (px - m.position.x) * cs - (pz - m.position.z) * sn;
    const lz = (px - m.position.x) * sn + (pz - m.position.z) * cs;
    return Math.abs(lx) < (m.interiorRadius ?? 3) * CAVE_MOUTH_TRENCH_K * CAVE_MOUTH_TRENCH_FADE
      && lz < CAVE_NEAR_OVERHANG + 1.2 && lz > -(m.length ?? 10)
      && py > m.floorY - 1 && py < m.floorY + m.height + 1.5;
  });
  for (const [si, c] of caves.entries()) {
    if (c.hasMouth) continue;                       // mouths are open by design
    const inX = -Math.sin(c.rotation), inZ = -Math.cos(c.rotation);
    const nX = -inZ, nZ = inX;
    const R = (c.interiorRadius ?? 3) - CAVE_WALL_PAD;
    for (const along of [0.12, 0.37, 0.62, 0.87]) {
      for (const lat of [-1, -0.5, 0, 0.5, 1]) {
        const x = c.position.x + inX * c.length * along + nX * R * lat;
        const z = c.position.z + inZ * c.length * along + nZ * R * lat;
        const it = getCaveInteriorAt(island, x, z);
        if (!it || it.wallDist < CAVE_WALL_PAD || it.ceilingY - it.floorY < 2) continue;
        const eye = Math.min(it.floorY + 1.6, it.ceilingY - 0.3);
        // Only stations with a real mountain overhead — near a mouth the sky is
        // supposed to be there.
        if (getIslandSurfaceY(island, x, z) < eye + 3) continue;
        for (const d of RAY_DIRS) {
          // How far until the ray breaks into open air.
          let air = Infinity;
          for (let t = 0.5; t <= 120; t += 0.5) {
            if (eye + d[1] * t > surfaceMax(x + d[0] * t, z + d[2] * t) + 0.05) { air = t; break; }
          }
          if (!Number.isFinite(air)) continue;
          if (throughAMouth(x + d[0] * air, eye + d[1] * air, z + d[2] * air)) continue;
          // …otherwise the rock must stop it first.
          let best = Infinity;
          const seen = new Set();
          for (let t = 0; t <= air && t <= best; t += CELL * 0.4) {
            const gi = Math.floor((x + d[0] * t) / CELL), gj = Math.floor((z + d[2] * t) / CELL);
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
              const key = `${gi + di},${gj + dj}`;
              if (seen.has(key)) continue;
              seen.add(key);
              for (const tri of grid.get(key) ?? []) {
                const h = rayTri([x, eye, z], d, tri);
                if (h > 0 && h < best) best = h;
              }
            }
          }
          if (best >= air) {
            windows++;
            if (!windowAt) windowAt = `${island.id} seg${si} eye (${x.toFixed(2)}, ${eye.toFixed(2)}, ${z.toFixed(2)}) heading (${d.map((v) => v.toFixed(2)).join(', ')})`;
          }
        }
      }
    }
  }
}
expect('no walkable eye under the mountain can see the sky through a cave wall',
  windows <= 0, `${windows} sightlines, first at ${windowAt}`);


// ── the mouth is a HOLE: collision air must be VISUAL air ───────────────────
// The bug no test could see. The island terrain is one polar heightfield — a
// single-valued function of xz — so it can carve a trench but can never express
// "rock above, air below". At every mouth the shared carve ramps the ground back
// to raw hillside by lz ≈ −2.6, and that ramp is a sheet of terrain standing
// floor-to-ceiling across the passage: the player walked through visible rock,
// and the sweep above passed because it samples the ANALYTIC field, which knows
// nothing about the drawn mesh. The mouth is now a per-fragment cutout in the
// terrain material (CaveMouthCutout), so this rebuilds the DRAWN terrain mesh —
// the same pure heightfield builder the client renders — indexes it with the
// same MeshGround the props seat on, and asserts, for every mouth:
//   · no un-cut drawn triangle stands in the doorway between the floor and the
//     ceiling (that IS the "you walk through the mountainside" defect);
//   · the cutout genuinely fires — a mouth where nothing is discarded means the
//     hole is being drawn by luck, and the next heightfield change closes it;
//   · the floor the pirate walks on is never cut, and nothing is cut outside the
//     mouth plane (lz ≥ 0), where no rock shell backs the void;
//   · the cut stays inside what the collar and the tube DRAW, so the hole is
//     always backed by rock rather than by the island's far hillside.
console.log('\n── the mouth is a hole: drawn-mesh air matches collision air ──');
{
  let doorwayBlocked = 0, blockedAt = '', cutFired = 0, mouthsChecked = 0;
  let floorCut = 0, outsideCut = 0, coverFail = 0, coverDetail = '';
  let unbackedCut = 0;
  let worstLip = 0, worstLipAt = '';
  for (const island of islands) {
    const mouths = (island.caves ?? []).filter((c) => c.hasMouth);
    if (mouths.length === 0) continue;
    const cutout = buildCaveCutout(island);
    expect(`${island.id}: the terrain material gets a cutout slot per mouth`,
      cutout !== null && cutout.count === Math.min(8, mouths.length),
      `count=${cutout?.count ?? 'null'} mouths=${mouths.length}`);
    // The DRAWN terrain, exactly as the client builds it at full quality.
    const field = buildTerrainHeightfield({
      island,
      islandMaxR: getIslandMaxRadius(island),
      lowDetail: false,
      visualDetail: 1,
      surfacePoint: (d, angle, extraY = 0) => {
        const p = getIslandSurfacePoint(island, d, angle, extraY);
        return { x: p.x - island.position.x, y: p.y, z: p.z - island.position.z };
      },
      // Same composition makeCaveMouthCarver builds on the client: the trig-only
      // reject, then the shared carve, kept idempotent with `min`.
      carveCaveMouth: (wx, wz, y) => {
        if (!isNearCaveMouthCut(island, wx, wz)) return { y, carved: 0 };
        const carve = getCaveMouthCarve(island, wx, wz);
        return { y: Math.min(y, carve.y), carved: carve.carved };
      },
      islandX: island.position.x,
      islandZ: island.position.z,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(field.positions, 3));
    geo.setIndex(field.indices);
    const ground = new MeshGround(geo);

    for (const m of mouths) {
      mouthsChecked++;
      const cR = m.interiorRadius ?? 3;
      const cLen = m.length ?? 10;
      const fY = m.floorY;
      const fEnd = m.floorYEnd ?? fY;
      const collarLen = caveCollarLength(m);
      const cs = Math.cos(m.rotation), sn = Math.sin(m.rotation);
      const world = (lx, lz) => ({
        x: m.position.x + lx * cs + lz * sn,
        z: m.position.z - lx * sn + lz * cs,
      });
      // COVERAGE, analytically: the lateral cut must stay inside the drawn shell.
      // Collar: radius cR·CAVE_MOUTH_TRENCH_K + 0.5, so 0.3m of margin.
      const collarR = cR * CAVE_MOUTH_TRENCH_K + 0.5;
      if (cR + CAVE_CUTOUT_PAD_NEAR > collarR - 0.3) {
        coverFail++;
        coverDetail ||= `${island.id}: near cut ${(cR + CAVE_CUTOUT_PAD_NEAR).toFixed(2)} vs collar ${collarR.toFixed(2)}`;
      }
      // Tube: the loft's conservative superellipse half-width (no meander, no
      // jitter, no widening — all three are outward-only).
      const tubeHalf = (cR + CAVE_SHELL_MARGIN) * (Math.pow(2, 1 / 5) + 0.01) * 0.95;
      if (cR + CAVE_CUTOUT_PAD_DEEP > tubeHalf - 0.1) {
        coverFail++;
        coverDetail ||= `${island.id}: deep cut ${(cR + CAVE_CUTOUT_PAD_DEEP).toFixed(2)} vs tube ${tubeHalf.toFixed(2)}`;
      }
      // …and every point the cutout removes must lie inside SOME cave shell the
      // client draws, or the hole is a window onto the island's far hillside.
      for (let lz = -0.25; lz >= -cLen; lz -= 0.5) {
        const along = Math.min(1, Math.max(0, -lz / cLen));
        const floorAt = fY + (fEnd - fY) * along;
        const pad = -lz <= collarLen ? CAVE_CUTOUT_PAD_NEAR : CAVE_CUTOUT_PAD_DEEP;
        for (const lx of [-(cR + pad), 0, cR + pad]) {
          for (const fy of [CAVE_CUTOUT_LIFT + 0.01, m.height * 0.5, m.height - 0.01]) {
            const w = world(lx * 0.999, lz);
            const wy = floorAt + fy;
            if (!caveCutoutHit(cutout, w.x, wy, w.z)) continue;
            const inCollar = -lz <= collarLen && Math.abs(lx) <= collarR - 0.25
              && wy <= floorAt + m.height * 1.02;
            const inTube = (island.caves ?? []).some((other) => insideCaveShellVolume(other, w.x, wy, w.z));
            if (!inCollar && !inTube) {
              unbackedCut++;
              coverDetail ||= `${island.id}: cut at local (${lx.toFixed(2)}, ${fy.toFixed(2)}, ${lz.toFixed(2)}) is backed by nothing`;
            }
          }
        }
      }
      // THE DOORWAY. Sample the drawn mesh across the passage over the stretch
      // the carve's ramp lives in, plus the whole tunnel for good measure.
      //
      // The doorway is partitioned by ONE number, CAVE_CUTOUT_LIFT: at or above
      // it the terrain material discards, below it the mesh is the trench floor
      // the pirate stands on. Sampling with a second, hand-written bound (an
      // earlier 0.5 against a lift of 0.55) invented a 5cm band that belonged to
      // neither side and reported 18 phantom blockers, so the bound is READ from
      // the shader's own constant and there is no third case by construction.
      //
      // What that leaves needing a real assertion is the LIP: the drawn floor is
      // a 4-8m chord grid trying to resolve a 7m trench, so near the mouth it
      // bleeds upward off the uncarved vertices beside the cut and stands some
      // way above the analytic floor. That residual is tracked below and has to
      // stay inside the locomotion step, or the visible fix hands the player an
      // invisible kerb to brick against.
      for (let lz = -0.2; lz >= -Math.min(cLen, 12); lz -= 0.2) {
        const along = Math.min(1, Math.max(0, -lz / cLen));
        const floorAt = fY + (fEnd - fY) * along;
        const ceilAt = floorAt + m.height;
        for (let lat = -0.9; lat <= 0.9001; lat += 0.15) {
          const w = world(cR * lat, lz);
          const drawn = ground.heightAt(w.x - island.position.x, w.z - island.position.z);
          if (drawn === null) continue;
          if (drawn >= ceilAt) continue; // the lintel — rock overhead, as drawn
          if (drawn >= floorAt + CAVE_CUTOUT_LIFT) {
            // Above the partition: the material MUST be discarding here, or the
            // hillside sheet the audit photographed is still standing.
            if (caveCutoutHit(cutout, w.x, drawn, w.z)) { cutFired++; continue; }
            doorwayBlocked++;
            blockedAt ||= `${island.id} local (${(cR * lat).toFixed(2)}, ${lz.toFixed(2)}): drawn ${drawn.toFixed(2)} between floor ${floorAt.toFixed(2)} and ceiling ${ceilAt.toFixed(2)}`;
            continue;
          }
          // Below it: this is the drawn trench floor. How high does it ride?
          if (drawn - floorAt > worstLip) {
            worstLip = drawn - floorAt;
            worstLipAt = `${island.id} local (${(cR * lat).toFixed(2)}, ${lz.toFixed(2)})`;
          }
        }
      }
      // THE FLOOR IS NEVER CUT — and the ground under the doorway is drawn.
      for (let lz = 1.0; lz >= -Math.min(cLen, 12); lz -= 0.25) {
        const along = Math.min(1, Math.max(0, -lz / cLen));
        const floorAt = fY + (fEnd - fY) * along;
        for (const lat of [-0.7, 0, 0.7]) {
          const w = world(cR * lat, lz);
          for (const dy of [0.0, 0.2, 0.42]) {
            if (caveCutoutHit(cutout, w.x, floorAt + dy, w.z)) floorCut++;
          }
        }
      }
      // NOTHING IS CUT OUTSIDE THE MOUTH PLANE: past lz = 0 the tube's front rim
      // has ended and no shell backs a hole (frontOvershoot = 0 for a mouth).
      for (let lz = 0.02; lz <= CAVE_NEAR_OVERHANG + 2; lz += 0.1) {
        const along = 0;
        const floorAt = fY + (fEnd - fY) * along;
        for (const lat of [-0.9, -0.3, 0.3, 0.9]) {
          const w = world(cR * lat, lz);
          for (let dy = 0.1; dy <= m.height + 1.5; dy += 0.35) {
            if (caveCutoutHit(cutout, w.x, floorAt + dy, w.z)) outsideCut++;
          }
        }
      }
    }
  }
  expect(`no drawn terrain triangle stands in any mouth's doorway (${mouthsChecked} mouths)`,
    doorwayBlocked === 0, `${doorwayBlocked} blocking samples, first ${blockedAt}`);
  // The lip the mesh's own coarseness leaves at the threshold. SLOPE_MAX_STEP is
  // 1.0m in PhysicsSystem's LOCO table; a doorway sill the player cannot step
  // over is a walk-through-rock fix that trades one wall for another.
  expect('the drawn trench floor never leaves a sill the pirate cannot step over',
    worstLip <= 1.0 - 0.15,
    `worst sill ${worstLip.toFixed(3)}m above the collision floor at ${worstLipAt}`);
  expect('the cutout really is what opens them (the heightfield still runs across every mouth)',
    cutFired > 0, `cutout discarded ${cutFired} blocking samples`);
  expect('the trench floor a pirate walks on is never cut away', floorCut === 0, `${floorCut} floor samples cut`);
  expect('nothing is cut outside the mouth plane, where no shell backs the void',
    outsideCut === 0, `${outsideCut} samples cut at lz > 0`);
  expect('the cut stays inside the rock the collar and the tube draw',
    coverFail === 0 && unbackedCut === 0, `${coverFail} bound failures, ${unbackedCut} unbacked samples: ${coverDetail}`);

  // THE PROXY LOD DOES NOT NEED THE CUTOUT, and this is why rather than a hope.
  // buildProxyTerrainMesh samples the shared heightfield WITHOUT carveCaveMouth,
  // so the proxy has no trench and no floor-to-ceiling sheet across a doorway —
  // it is unbroken hillside, which is the correct silhouette for an island seen
  // from far enough away that the swap has happened. Cutting a hole in it would
  // be strictly worse: the collar and tube live under detailRoot and are hidden
  // alongside it, so a discarded proxy fragment would be backed by nothing and
  // the mouth would read as a window through the island.
  // The swap is gated on edgeDist = dist - getIslandMaxRadius(island) exceeding
  // detailRadius, whose smallest value is 420m at quality 'low' (Game.ts). An eye
  // at a mouth is inside the island's own footprint, so its edgeDist is at most
  // zero — the mesh a player can see a mouth in is ALWAYS the cut one.
  const PROXY_SWAP_MIN = 420;
  let mouthOutsideFootprint = 0, footprintDetail = '';
  for (const island of islands) {
    const maxR = getIslandMaxRadius(island);
    for (const m of (island.caves ?? []).filter((c) => c.hasMouth)) {
      const fromCenter = Math.hypot(m.position.x - island.position.x, m.position.z - island.position.z);
      // Stand back the length of the tunnel plus a body: still nowhere near 420m.
      if (fromCenter + (m.length ?? 10) + 2 >= maxR + PROXY_SWAP_MIN) {
        mouthOutsideFootprint++;
        footprintDetail ||= `${island.id}: mouth ${fromCenter.toFixed(1)}m out of a ${maxR.toFixed(1)}m island`;
      }
    }
  }
  expect('no mouth is ever seen through the uncut proxy: every one sits deep inside the detail radius',
    mouthOutsideFootprint === 0, footprintDetail);
}

console.log(failures === 0 ? '\nALL CAVE WALK TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
