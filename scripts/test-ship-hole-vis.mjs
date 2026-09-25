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

// ── 5. THE BREACH SEEN FROM INSIDE (holes-06) ───────────────────────────────
// The hull shader cut the outer skin, but the hold lining 0.14 m inboard and the
// sole covered it: from the hold a waterline breach showed no opening, no water
// and no patch. Most holes (HOLE_BAND_Y 0.10..0.45) are BELOW the sole top
// (HOLD_FLOOR_OFFSET 0.35), so the lining alone is not enough: the sole and the
// bilge boards carry the same cut. The cut is a CAPSULE from the shell point to
// an inboard seat (a tube through both skins), graded here from the live
// uniforms against the real merged lining and sole triangles.
{
  const Lh = stats.length;
  const above = { id: 1, x: 1, y: 0.44, z: 0, patched: false };
  const below = { id: 2, x: -1, y: 0.14, z: Lh * 0.1, patched: false };
  const ship = fixtureShip(type, [above, below]);
  ship.id = 'holevis-inside';
  sr.update([ship], [], 24, 1 / 60, 0, cam);
  const mesh = sr.shipMeshes.get(ship.id);
  const vA = mesh.holeVis.get(1), vB = mesh.holeVis.get(2);

  const mats = new Map();
  const meshesByMat = new Map();
  mesh.detailRoot.traverse((o) => {
    if (!o.isMesh || !o.material?.name) return;
    mats.set(o.material.name, o.material);
    if (!meshesByMat.has(o.material.name)) meshesByMat.set(o.material.name, []);
    meshesByMat.get(o.material.name).push(o);
  });
  for (const name of ['hold-inner-wall', 'hold-floor', 'hold-bilge-board']) {
    const m = mats.get(name);
    const key = m?.customProgramCacheKey?.() ?? '';
    let src = '';
    if (typeof m?.onBeforeCompile === 'function') {
      const sh = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n' };
      m.onBeforeCompile(sh, {});
      src = sh.fragmentShader;
    }
    expect(`${name}: the hold ${name === 'hold-floor' ? 'sole' : name === 'hold-bilge-board' ? 'bilge boards' : 'lining'} program carries hull-hole-discard-8 (key '${key}')`,
      key.includes(`hull-hole-discard-${FLOODING.MAX_HOLES_PER_SHIP}`) && src.includes('discard') && src.includes('uHoleEnds'));
  }

  const uH = mesh.hullHoleUniform?.value ?? [];
  const uE = mesh.hullHoleEnds?.value ?? [];
  const cut = (p) => uH.some((c, i) => {
    if (!(c.w > 0) || !uE[i]) return false;
    const ab = new THREE.Vector3(uE[i].x - c.x, uE[i].y - c.y, uE[i].z - c.z);
    const ap = new THREE.Vector3(p.x - c.x, p.y - c.y, p.z - c.z);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(ab.lengthSq(), 1e-6)));
    return ap.distanceTo(ab.multiplyScalar(t)) < c.w;
  });
  const tri2 = new THREE.Triangle();
  const q = new THREE.Vector3(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  function nearestOn(name, target) {
    let best = Infinity; const out = new THREE.Vector3();
    for (const o of meshesByMat.get(name) ?? []) {
      const pos = o.geometry.attributes.position; const idx = o.geometry.index;
      const n = idx ? idx.count / 3 : pos.count / 3;
      for (let i = 0; i < n; i++) {
        tri2.set(p0.fromBufferAttribute(pos, idx ? idx.getX(i * 3) : i * 3), p1.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 1) : i * 3 + 1), p2.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + 2) : i * 3 + 2));
        tri2.closestPointToPoint(target, q);
        const d = q.distanceTo(target);
        if (d < best) { best = d; out.copy(q); }
      }
    }
    return { d: best, p: out };
  }
  expect('above-sole breach: the inboard seat is inboard of the shell by >= 0.1 m',
    !!vA?.inner && Math.abs(vA.inner.x) < Math.abs(vA.point.x) - 0.1,
    vA?.inner ? `seat x ${vA.inner.x.toFixed(2)} vs shell x ${vA.point.x.toFixed(2)}` : 'no vis.inner');
  // The lining where the tube crosses it: nearest lining to the tube's midpoint
  // (the seat itself sits on the bilge board, 0.24 m inboard of the lining).
  const midA = vA?.inner ? vA.inner.clone().lerp(vA.point, 0.5) : null;
  const liningA = midA ? nearestOn('hold-inner-wall', midA) : { d: Infinity, p: new THREE.Vector3() };
  const liningFar = midA ? nearestOn('hold-inner-wall', midA.clone().add(new THREE.Vector3(0, 0, 1.4))) : liningA;
  console.log(`  inside: shell (${vA?.point.x.toFixed(2)}, ${vA?.point.y.toFixed(2)}) seat ${vA?.inner ? `(${vA.inner.x.toFixed(2)}, ${vA.inner.y.toFixed(2)})` : '-'}; lining ${liningA.d.toFixed(3)} m from the tube midpoint`);
  expect('above-sole breach: the lining at the seat is cut (tube through both skins)',
    liningA.d < 0.2 && cut(liningA.p), `nearest lining ${liningA.d.toFixed(3)} m, cut ${cut(liningA.p)}`);
  expect('control: the lining 1.4 m along the hull is NOT cut', liningFar.d < 0.3 && !cut(liningFar.p));
  // b2.3c probe finding: seated on the lining, the angled bilge board 0.24 m
  // inboard still covered the opening from every hold pose. Whatever stands
  // on the VIEWER's side must be cut: the board face nearest a point 0.3 m
  // further inboard of the seat.
  const viewA = vA?.inner ? vA.inner.clone().add(new THREE.Vector3(-Math.sign(vA.point.x) * 0.3, 0, 0)) : null;
  const boardA = viewA ? nearestOn('hold-bilge-board', viewA) : { d: Infinity, p: new THREE.Vector3() };
  expect('above-sole breach: the bilge board in front of the lining is cut on the hold side',
    boardA.d < 0.45 && cut(boardA.p), `board face ${boardA.d.toFixed(3)} m from the viewer point, cut ${cut(boardA.p)}`);
  const boardFar = viewA ? nearestOn('hold-bilge-board', viewA.clone().add(new THREE.Vector3(0, 0, 1.4))) : boardA;
  expect('control: the bilge board 1.4 m along is NOT cut', boardFar.d < 0.45 && !cut(boardFar.p));
  const soleB = vB?.inner ? nearestOn('hold-floor', vB.inner) : { d: Infinity, p: new THREE.Vector3() };
  expect('below-sole breach: the sole above it is cut open (you see into the bilge)',
    !!vB?.inner && vB.inner.y > 0.3 && soleB.d < 0.1 && cut(soleB.p),
    vB?.inner ? `seat y ${vB.inner.y.toFixed(2)}, sole ${soleB.d.toFixed(3)} m, cut ${cut(soleB.p)}` : 'no vis.inner');
  const named = (root, n) => { let f = null; root?.traverse((o) => { if (!f && o.name === n) f = o; }); return f; };
  expect('an open breach wears a torn inboard edge ring at its seat',
    !!vA?.inboard?.visible && !!named(vA.inboard, 'hole-rim-inboard'));
  const back = named(vA?.group, 'hole-backdrop');
  const backN = back ? new THREE.Vector3(0, 0, 1).applyQuaternion(back.quaternion) : null;
  expect('a dark-water/daylight backdrop faces INBOARD behind the opening (culled from outside)',
    !!back && backN.dot(vA.normal) < -0.9 && back.material.side === THREE.FrontSide);
  expect('below-sole breach: water wells up through the sole',
    !!vB?.inboard?.visible && !!named(vB.inboard, 'hole-welling')?.visible);
  expect('above-sole breach: no welling on the lining', !named(vA?.inboard, 'hole-welling')?.visible);

  above.patched = true;
  sr.update([ship], [], 24.02, 1 / 60, 0, cam);
  const inPatch = named(vA?.patch, 'hole-patch-inboard');
  const planks = named(inPatch, 'hole-patch-inboard-planks');
  const nails = named(inPatch, 'hole-patch-inboard-nails');
  const at = inPatch ? inPatch.position : null;
  expect('a patched hole produces an inboard patch mesh (planks + nail heads)',
    !!planks && !!nails && (planks.geometry.index?.count ?? 0) / 3 >= 24 && nails.geometry.attributes.position.count > 0);
  expect('the inboard patch sits on the seat, inboard of the shell',
    !!at && at.distanceTo(vA.inner) < 0.12 && Math.abs(at.x) < Math.abs(vA.point.x) - 0.1);
  expect('a patched hole no longer cuts the lining', !cut(liningA.p));
  expect('the inboard ring goes when the hole is patched', !vA?.inboard?.visible);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
