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
  CAVE_WALL_PAD, getCaveInteriorAt, getIslandSurfaceY, getCaveCeilingY, getCaveFloorY, isInsideCaveInterior,
} from '../src/shared/utils/index.ts';
import { CAVE_SHELL_MARGIN, makeCaveTubeGeometry } from '../src/client/rendering/factories/CaveGeometry.ts';
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
const ESCAPE_PINS = [
  ['old-maw-caldera', 44.11, 32.90, 3.93], ['old-maw-caldera', 37.96, 46.75, 2.36],
  ['crow-s-perch', -304.10, 241.63, 3.14], ['crow-s-perch', -332.02, 268.96, 1.18],
  ['crow-s-perch', -298.49, 266.57, 1.96], ['crow-s-perch', -312.47, 265.68, 0.39],
  ['castaway-reach', 400.79, -392.59, 1.18], ['castaway-reach', 414.35, -373.34, 1.96],
  ['skull-cove', 709.41, -71.96, 5.89], ['skull-cove', 706.38, -60.74, 0.0],
  ['skull-cove', 690.97, -62.53, 0.0],
  ['gallows-sands', 640.38, -647.48, 5.50], ['gallows-sands', 653.95, -647.32, 2.36],
  ['widow-s-watch', -604.63, -561.53, 0.79], ['widow-s-watch', -603.12, -550.24, 3.53],
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
    const geo = makeCaveTubeGeometry(
      cR, cLen + 1.2, floorLocal, floorLocal + c.height,
      c.width * 7.3 + cLen * 2.1 + cR, c.hasBackWall ?? true,
      cLen > 0 ? floorEndLocal + (floorEndLocal - floorLocal) * (1.2 / cLen) : floorEndLocal,
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

console.log(failures === 0 ? '\nALL CAVE WALK TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
