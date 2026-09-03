// SHIP HOLE VISUALS — pure three.js under node, no browser.
//
// WHY (ships-26). Hole decals are keyed by ShipHole.id and the sync loop only
// ever BUILT or DISPOSED them; it never re-read x/y/z. Two server paths move a
// live id under the client's feet:
//   * fire burn-down (PhysicsSystem): a firebomb char starts at
//     FIRE_HOLE_START_Y 1.05 and walks down to HOLE_BAND_Y.min at
//     FIRE_BURN_DOWN_RATE m/s under the SAME id, flooding once it arrives;
//   * placeHole at the MAX_HOLES_PER_SHIP cap: the nearest PATCHED slot is
//     recycled with new coords and patched=false, so the fresh breach can be on
//     the other side of the hull.
// Both left the drawn hole, the see-through discard disc, the gush anchor and
// the [X] repair halo at the ORIGINAL point while the server flooded from the
// new one: the player bails a bilge filling from a hole he cannot see and the
// repair prompt points at intact planking.
//
// WHY (ships-07). The see-through breach is a fragment discard on the hull
// shell material only. The proud strakes (sheer strake, main wale, boot-top)
// and the hull-reinforcement armour are separate meshes with their own
// materials, so a dark timber bar bridged every waterline hole.
//
// RED ON HEAD: vis.point.y stays at the spawn height while hole.y burns down;
// the recycled slot keeps the old point and its plank patch; the strake and
// armour materials carry no onBeforeCompile.
//
//   node --import tsx scripts/test-ship-hole-vis.mjs
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS, FLOODING } = await import('../src/shared/constants/index.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function fixtureShip(type, holes) {
  return {
    id: `holevis-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes, nextHoleId: holes.length + 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'high');
openFirstDrawBudgetForSettle();

const cam = new THREE.Vector3(10, 6, 10);
const type = 'brigantine';
const stats = SHIP_STATS[type];
const R = FLOODING.HOLE_VISUAL_RADIUS;

// ── 1. FIRE BURN-DOWN: same id, y walks to the waterline ────────────────────
{
  const hole = { id: 1, x: 0, y: 1.05, z: stats.length * 0.12, patched: false };
  const ship = fixtureShip(type, [hole]);
  sr.update([ship], [], 20, 1 / 60, 0, cam);
  const mesh = sr.shipMeshes.get(ship.id);
  const vis = mesh.holeVis.get(1);
  const spawnY = vis.point.y;
  const spawnGush = vis.gush.getWorldPosition(new THREE.Vector3()).clone();
  hole.y = 0.18; // ~15 s of burn-down at FIRE_BURN_DOWN_RATE
  sr.update([ship], [], 20.02, 1 / 60, 0, cam);
  const moved = spawnY - vis.point.y;
  const gushDrop = spawnGush.y - vis.gush.getWorldPosition(new THREE.Vector3()).y;
  const slot = mesh.hullHoleUniform.value[0];
  console.log(`  burn-down: hole.y 1.05 -> 0.18, vis.point.y ${spawnY.toFixed(2)} -> ${vis.point.y.toFixed(2)}, discard slot y ${slot.y.toFixed(2)}, gush dropped ${gushDrop.toFixed(2)} m`);
  expect('fire burn-down: the drawn breach follows the server hole down the hull',
    moved > 0.7, `vis.point.y moved ${moved.toFixed(3)} m for a 0.87 m burn-down`);
  expect('fire burn-down: the see-through discard slot is the drawn point',
    Math.abs(slot.y - vis.point.y) < 1e-6 && Math.abs(slot.x - vis.point.x) < 1e-6,
    `slot (${slot.x.toFixed(3)}, ${slot.y.toFixed(3)}) vs point (${vis.point.x.toFixed(3)}, ${vis.point.y.toFixed(3)})`);
  expect('fire burn-down: the outward gush anchor comes down with it',
    gushDrop > 0.7, `gush dropped ${gushDrop.toFixed(3)} m`);
}

// ── 2. SATURATED HULL: placeHole recycles a patched slot ────────────────────
{
  const hole = { id: 7, x: 0, y: 0.3, z: -stats.length * 0.2, patched: true };
  const ship = fixtureShip(type, [hole]);
  sr.update([ship], [], 21, 1 / 60, 0, cam);
  const mesh = sr.shipMeshes.get(ship.id);
  const vis = mesh.holeVis.get(7);
  expect('a patched breach wears its plank cross', vis.patch !== null);
  const oldPoint = vis.point.clone();
  // Same id, reopened on the opposite side and further forward.
  hole.z = stats.length * 0.3;
  hole.y = 0.4;
  hole.patched = false;
  sr.update([ship], [], 21.02, 1 / 60, 0, cam);
  const jump = oldPoint.distanceTo(vis.point);
  console.log(`  recycled slot: point (${oldPoint.x.toFixed(2)}, ${oldPoint.y.toFixed(2)}, ${oldPoint.z.toFixed(2)}) -> (${vis.point.x.toFixed(2)}, ${vis.point.y.toFixed(2)}, ${vis.point.z.toFixed(2)}), moved ${jump.toFixed(2)} m, patch ${vis.patch === null ? 'gone' : 'STILL ON'}`);
  expect('a recycled slot re-seats the breach at the new wound',
    jump > 2, `moved only ${jump.toFixed(2)} m`);
  expect('a recycled slot loses the plank patch nailed over the old wound',
    vis.patch === null);
  expect('the group, the marker and the discard slot all sit at the new point',
    vis.group.position.distanceTo(vis.point) < 1e-6
      && Math.abs(mesh.hullHoleUniform.value[0].z - vis.point.z) < 1e-6);
}

// ── 3. NOTHING MOVES WHEN NOTHING MOVED ─────────────────────────────────────
{
  const hole = { id: 3, x: 0, y: 0.3, z: 0, patched: false };
  const ship = fixtureShip(type, [hole]);
  sr.update([ship], [], 22, 1 / 60, 0, cam);
  const mesh = sr.shipMeshes.get(ship.id);
  const vis = mesh.holeVis.get(3);
  const before = vis.point.clone();
  const groupRef = vis.group;
  for (let i = 0; i < 5; i++) sr.update([ship], [], 22 + i * 0.02, 1 / 60, 0, cam);
  expect('a stationary breach is neither moved nor rebuilt',
    vis.point.equals(before) && mesh.holeVis.get(3).group === groupRef);
}

// ── 4. THE TIMBER BAR ACROSS THE HOLE (ships-07) ────────────────────────────
// Every surface that hugs the shell inside a breach radius must carry the same
// hull-local discard, or it bridges the opening.
{
  const hole = { id: 1, x: 0, y: 0.275, z: 0, patched: false };
  const ship = fixtureShip(type, [hole]);
  ship.upgrades = [{ type: 'hull_reinforcement', level: 1 }];
  sr.update([ship], [], 23, 1 / 60, 0, cam);
  const mesh = sr.shipMeshes.get(ship.id);
  const vis = mesh.holeVis.get(1);

  // A material carries the discard if patching a stub shader injects it.
  const STUB = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n',
    fragmentShader: '#include <common>\n#include <map_fragment>\n',
  };
  function discardSource(material) {
    if (typeof material.onBeforeCompile !== 'function') return null;
    const shader = { uniforms: {}, vertexShader: STUB.vertexShader, fragmentShader: STUB.fragmentShader };
    material.onBeforeCompile(shader, {});
    return shader.fragmentShader.includes('discard') && shader.vertexShader.includes('vHullPos')
      ? shader : null;
  }

  // DOES ANYTHING BRIDGE THE OPENING? Measure the true distance from the breach
  // point to every triangle of each merged surface. Vertex proximity is no good
  // (the loft and the strakes are metres apart at the stations, so a bar crosses
  // a 0.26 m disc without a single vertex in it) and a planar ray fan misses the
  // hull's curve below the waterline.
  const tri = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  function nearestTriangleDistance(obj) {
    const geo = obj.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return { d: Infinity, along: 0 };
    geo.computeBoundingBox();
    if (geo.boundingBox.distanceToPoint(vis.point) > R) return { d: Infinity, along: 0 };
    const bestPoint = new THREE.Vector3();
    const index = geo.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    let best = Infinity;
    for (let i = 0; i < triCount; i++) {
      const i0 = index ? index.getX(i * 3) : i * 3;
      const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      tri.set(a.fromBufferAttribute(pos, i0), b.fromBufferAttribute(pos, i1), c.fromBufferAttribute(pos, i2));
      tri.closestPointToPoint(vis.point, closest);
      const d = closest.distanceTo(vis.point);
      if (d < best) { best = d; bestPoint.copy(closest); }
      if (best === 0) break;
    }
    // Signed depth along the shell normal: a proud strake or armour belt sits at
    // or outside the planking (>= 0), the hold's inner wall is inboard and is
    // exactly what you are MEANT to see through the opening.
    return { d: best, along: best === Infinity ? 0 : bestPoint.clone().sub(vis.point).dot(vis.normal) };
  }

  const shellSurfaces = new Map();
  const inboardSurfaces = new Map();
  mesh.detailRoot.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh) return;
    if (obj === vis.marker || obj.parent === vis.decal) return;
    if (obj.userData.isPlankPatch || obj.parent?.userData?.isPlankPatch) return;
    if (obj.position.lengthSq() > 1e-8 || obj.quaternion.w < 0.999999) return; // not hull-local
    const { d, along } = nearestTriangleDistance(obj);
    if (d > R) return;
    const name = obj.material?.name || obj.name || 'unnamed';
    // Only surfaces that HUG THE SHELL bridge the opening. Anything more than
    // 3 cm inboard (the hold's inner wall, the bulkheads) is the far side of the
    // hole and must stay drawn.
    const bucket = along > -0.03 ? shellSurfaces : inboardSurfaces;
    if (!bucket.has(name) || bucket.get(name).d > d) bucket.set(name, { d, along, material: obj.material });
  });
  const names = [...shellSurfaces.keys()].sort();
  console.log(`  proud/flush surfaces in the ${R} m breach disc: ${names.map((n) => `${n} @ ${shellSurfaces.get(n).d.toFixed(3)} m`).join(', ') || '(none)'}`);
  console.log(`  inboard of the shell (seen THROUGH the hole, must stay drawn): ${[...inboardSurfaces.keys()].join(', ') || '(none)'}`);
  expect('the shell itself is one of them (else this gate is aimed at nothing)',
    shellSurfaces.has('ship-hull-shell'), `found ${JSON.stringify(names)}`);
  expect('the proud strakes really do cross the breach disc (ships-07: the bar in the hole)',
    shellSurfaces.has('ship-hull-strake'), `found ${JSON.stringify(names)}`);
  for (const [name, entry] of shellSurfaces) {
    expect(`${name} (nearest triangle ${entry.d.toFixed(3)} m from the breach) discards it`,
      discardSource(entry.material) !== null);
  }
  expect('no un-discarded timber is left in the disc',
    !shellSurfaces.has('ship-dark-timber'),
    'a strake fell back into the plain dark-timber merge bucket');

  // Armour + rivets: the belts sit in the band and the rivet instances carry
  // their offset in instanceMatrix, so the patch must read it.
  const armorGroup = mesh.root.getObjectByName('upgrade-hull-reinforcement');
  expect('the hull-reinforcement armour is built', !!armorGroup);
  const armorMats = new Map();
  let rivetMat = null;
  armorGroup?.traverse((obj) => {
    if (!obj.isMesh) return;
    armorMats.set(obj.material.name || obj.material.uuid, obj.material);
    if (obj.isInstancedMesh) rivetMat = obj.material;
  });
  expect(`every armour material carries the discard (${armorMats.size} materials)`,
    armorMats.size > 0 && [...armorMats.values()].every((m) => discardSource(m) !== null));
  expect('the rivet InstancedMesh material reads hull-local through instanceMatrix',
    !!rivetMat && discardSource(rivetMat)?.vertexShader.includes('instanceMatrix'));
  // Ribs and plates must be baked into hull-local space or the discard aims at
  // the wrong point for them.
  let offsetMeshes = 0;
  armorGroup?.traverse((obj) => {
    if (obj.isMesh && !obj.isInstancedMesh && obj.position.lengthSq() > 1e-8) offsetMeshes += 1;
  });
  expect('armour ribs and plates sit at identity (hull-local positions)', offsetMeshes === 0,
    `${offsetMeshes} armour meshes carry a transform the discard cannot see`);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
