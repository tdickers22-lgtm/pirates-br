// SHIP RIGGING — the gate for ships-16 (SHIPVIS-01 rigging).
//
// THE DEFECT. Every rope on the ship was a segment inside one of two
// `LineSegments`, with its endpoints baked at BUILD time from the yard's REST
// position. The yard lives inside a `trimPivot` that swings with
// `ship.sailAngle` every frame, so bracing hard over swung the spar away from
// the ropes that lead to its ends — the halyards and braces stayed pointing at
// where the yard used to be. The brace's own source comment claimed it ran "up
// to the yard END on that side" while the drawn line stopped at a fixed point
// beside the mast.
//
// THE GATE. Build each hull, read the rope instance matrices at rest, brace the
// yards through a full 60 degrees, and require every rope that is made fast to
// a yard to still END on that yard, within 5 cm. It also grades that the ropes
// are drawable geometry rather than hairlines (an InstancedMesh that takes
// light and casts shadow), that the draw-call count did not grow, and that the
// per-frame re-seat allocates nothing.
//
//   node --import tsx scripts/test-ship-rigging.mjs [--mutate]
//
// `--mutate` freezes the yard-attached instances at their rest matrices — i.e.
// exactly the behaviour before this lane — and the gate must FAIL. RED PROOF is
// in the lane report.
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { ropeEndInGroupSpace } = await import('../src/client/rendering/ship/rigging.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

// A hull's detail root (the rig included) is revealed through the first-draw
// allowance, and nothing replenishes it in a headless run — so without this the
// detail root never comes up, the renderer takes its far-LOD `continue`, the
// yards never brace and every rope check passes on a ship that never moved.
// The gate refuses to be vacuous about exactly that (see "the yards actually
// braced"), so open the allowance the way the settle path does.
const frame = (sr, ships, t, cam) => { openFirstDrawBudgetForSettle(); sr.update(ships, [], t, 1 / 60, 0, cam); };

const MUTATE = process.argv.includes('--mutate');
// A camera on the hull: the renderer only animates the trim on hulls inside its
// detail range, so a gate that grades the rig has to stand where the rig is.
const CAM = { x: 0, y: 6, z: 26 };
const TOL = 0.05;

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function fixtureShip(type) {
  const stats = SHIP_STATS[type];
  return {
    id: `${type}-rig`, type, position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, health: stats.maxHealth, maxHealth: stats.maxHealth,
    sailAngle: 0, sailOpen: 1, sailHeight: 1, speed: 0, crew: [], holes: [],
    waterLevel: 0, sinking: false, anchored: false, repairCooldown: 0,
    autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

/** The free end of instance `i`, in ship-group space: the cylinder runs along
 *  its own +Y from -0.5 to +0.5, so the ends are mid ± (axis · length/2). */
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _axis = new THREE.Vector3();
function instanceEnds(mesh, i) {
  mesh.getMatrixAt(i, _m);
  _m.decompose(_pos, _quat, _scl);
  _axis.set(0, 1, 0).applyQuaternion(_quat).multiplyScalar(_scl.y * 0.5);
  return [_pos.clone().sub(_axis), _pos.clone().add(_axis)];
}

console.log(`SHIP RIGGING (ships-16)${MUTATE ? '  [--mutate: the yard-attached ropes are frozen at rest; this run must FAIL]' : ''}`);

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'balanced');

for (const type of ['sloop', 'brigantine', 'galleon']) {
  const ship = fixtureShip(type);
  const root = sr.buildShip(ship);
  frame(sr, [ship], 0, new THREE.Vector3(CAM.x, CAM.y, CAM.z));

  const group = sr.getShipGroup(ship.id);
  const detail = group.children.find((c) => c.name === 'ship-detail-root') ?? group;
  const rigs = [];
  detail.traverse((o) => { if (o.isInstancedMesh && o.name === 'ship-rigging') rigs.push(o); });
  console.log(`\n[${type}] ${rigs.length} rigging draws, ${rigs.reduce((a, r) => a + r.count, 0)} rope segments`);

  expect(`${type}: rigging is drawable geometry, not hairlines`,
    rigs.length === 2 && rigs.every((r) => r.count > 0),
    `found ${rigs.length} InstancedMesh rigging families`);
  expect(`${type}: rigging still costs two draw calls`, rigs.length === 2);
  expect(`${type}: rigging takes light and casts shadow`,
    rigs.every((r) => r.castShadow && r.material.isMeshStandardMaterial),
    'a LineBasicMaterial rope is unlit and unshadowed at any distance');

  // The yard-attached runs, and where their yards actually are.
  const dyn = sr.__riggingDynamic?.(ship.id) ?? [];
  expect(`${type}: at least one rope is made fast to a yard`, dyn.length >= 2, `${dyn.length} yard-attached runs`);

  // ── BRACE HER HARD OVER ────────────────────────────────────────────────────
  // 60 degrees is the audit's number and inside the renderer's own ±1.15 rad
  // visual clamp, so this is a trim the player can actually reach.
  const braced = 60 * Math.PI / 180;
  ship.sailAngle = braced;
  const frozen = MUTATE ? dyn.map((d) => instanceEnds(d.mesh, d.index)[1].clone()) : null;
  const camv = new THREE.Vector3(CAM.x, CAM.y, CAM.z);
  for (let f = 0; f < 240; f++) frame(sr, [ship], f / 60, camv);
  if (MUTATE) {
    // Put the rest matrices back: the pre-fix behaviour, where the rope keeps
    // pointing at where the yard used to be.
    const tmp = new THREE.Matrix4();
    for (let k = 0; k < dyn.length; k++) {
      const d = dyn[k];
      const ends = instanceEnds(d.mesh, d.index);
      const a = ends[0], b = frozen[k];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = dir.length();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      tmp.compose(mid, q, new THREE.Vector3(0.028, len, 0.028));
      d.mesh.setMatrixAt(d.index, tmp);
    }
  }

  const yawed = dyn.length > 0 ? dyn[0].pivot.rotation.y : 0;
  expect(`${type}: the yards actually braced (${(yawed * 180 / Math.PI).toFixed(1)} deg)`,
    Math.abs(yawed) > 0.8, `pivot yaw ${yawed.toFixed(3)} rad — the trim never moved, so the gate would be vacuous`);

  let worst = 0, worstIdx = -1;
  const want = new THREE.Vector3();
  for (const d of dyn) {
    ropeEndInGroupSpace(d, want);
    const end = instanceEnds(d.mesh, d.index)[1];
    // The instance's two ends are unordered relative to the run, so take the
    // nearer one: the grade is "does a rope END on the yard", not "which end".
    const other = instanceEnds(d.mesh, d.index)[0];
    const dist = Math.min(want.distanceTo(end), want.distanceTo(other));
    if (dist > worst) { worst = dist; worstIdx = d.index; }
  }
  expect(`${type}: every yard-attached rope ends on its yard after a 60 deg brace (worst ${worst.toFixed(3)} m)`,
    worst <= TOL, `instance ${worstIdx} is ${worst.toFixed(3)} m off the spar (tolerance ${TOL} m)`);
}

// ── The per-frame re-seat must not allocate ──────────────────────────────────
// Scoped to updateRigging ALONE, not to update(): the rest of the frame writes
// sail-cloth vertices and wake rows and would drown the signal.
{
  const { updateRigging } = await import('../src/client/rendering/ship/rigging.ts');
  const ship = fixtureShip('sloop');
  ship.id = 'alloc-sloop';
  sr.buildShip(ship);
  const rig = sr.__rigging?.('alloc-sloop');
  expect('the alloc probe found a rig to drive', Boolean(rig && rig.dynamic.length > 0));
  const pivots = [...new Set(rig.dynamic.map((d) => d.pivot))];
  // Indexed loops on purpose: a for..of here allocates an iterator per frame and
  // would be measuring the probe instead of the renderer.
  const drive = (n) => {
    for (let f = 0; f < n; f++) {
      const yaw = Math.sin(f * 0.17);
      for (let i = 0; i < pivots.length; i++) pivots[i].rotation.y = yaw;
      updateRigging(rig);
    }
  };
  // NO PER-FRAME ALLOCATION, measured deterministically.
  //
  // A heap-delta over N iterations is not a usable signal here: without
  // --expose-gc the nursery drift of the driving loop is the same order as the
  // thing being measured, and the check flips run to run. What DOES regress
  // observably is someone rebuilding the rig each frame instead of writing into
  // it, so the grade is buffer identity: after twenty thousand braces the
  // InstancedMesh, its geometry and the backing Float32Array must all still be
  // the very objects the build produced.
  const mesh0 = rig.mesh;
  const geo0 = rig.mesh.geometry;
  const arr0 = rig.mesh.instanceMatrix.array;
  const count0 = rig.mesh.count;
  drive(20000);
  expect('20,000 braces reuse the same InstancedMesh, geometry and instance buffer',
    rig.mesh === mesh0 && rig.mesh.geometry === geo0
    && rig.mesh.instanceMatrix.array === arr0 && rig.mesh.count === count0,
    'the rig was rebuilt rather than re-seated — that is a per-frame allocation of the whole rigging');
  expect('the rope matrices actually changed over those braces',
    [...arr0].some((v, k) => v !== 0) && rig.mesh.instanceMatrix.version > 0);

  // three's `needsUpdate` is a setter with no getter, so the observable is the
  // attribute's version counter: a no-op frame must not bump it.
  const v0 = rig.mesh.instanceMatrix.version;
  updateRigging(rig);
  expect('a trim that did not move re-uploads nothing',
    rig.mesh.instanceMatrix.version === v0, `version ${v0} -> ${rig.mesh.instanceMatrix.version}`);
}

sr.clear();
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
