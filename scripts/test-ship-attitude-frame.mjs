// SHIP ATTITUDE FRAME — pure three.js under node, no browser.
//
// WHY. ShipRenderer.update writes the server's body-axis pitch and roll into
// `root.rotation.x` / `root.rotation.z` on the ship's root Group, and the root
// was created with three's default Euler order, XYZ (R = Rx·Ry·Rz). That order
// applies the yaw BEFORE the pitch, so the pitch happens about WORLD X — the
// beam axis only when the ship heads north or south. Heading east or west the
// same "pitch" rolls the hull and the bow never dips (ships-01, P1). The server
// evaluates hole depth, flooding and the camera roll in body axes, so on three
// quarters of all headings the drawn hull and the simulated one disagree.
//
// WHAT. Build each hull with the real ShipRenderer.buildShip (canvas stubbed),
// then, for eight yaws, set a pure 0.2 rad pitch on the root exactly the way
// update() does and read the world position of the stem and the starboard rail.
// Body-axis pitch means: bow sinks by (L/2)·sin 0.2 at EVERY heading and the
// rail stays level. Then the same for a pure roll.
//
// RED ON HEAD: yaw 90° → bow y 0.00 (expected -1.19 on the sloop), rail +0.50.
// Green when SHIP-01 (lane 1.3) sets `group.rotation.order = 'YXZ'` on the root.
//
//   node --import tsx scripts/test-ship-attitude-frame.mjs
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { angleWrap } = await import('../src/shared/utils/index.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const PITCH = 0.2;
const ROLL = 0.15;
const TOL = 0.05;
const YAWS = [0, 45, 90, 135, 180, 225, 270, 315];

function fixtureShip(type) {
  return {
    id: `attitude-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'low');

const v = new THREE.Vector3();
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const { length: L, width: W } = SHIP_STATS[type];
  const root = sr.buildShip(fixtureShip(type));
  console.log(`\n[${type}] root Euler order '${root.rotation.order}'`);
  const expectedDip = -(L / 2) * Math.sin(PITCH);
  const expectedRailLift = (W / 2) * Math.sin(ROLL);
  let worstBow = 0, worstBowAt = 0, worstRail = 0, worstRailAt = 0;
  let worstRollRail = 0, worstRollRailAt = 0;
  for (const yawDeg of YAWS) {
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    // Pure pitch, exactly as ShipRenderer.update writes it (rotation.x = wavePitch, rotation.z = roll).
    root.rotation.set(PITCH, yaw, 0, root.rotation.order);
    root.updateMatrixWorld(true);
    const bowY = v.set(0, 0, L / 2).applyMatrix4(root.matrixWorld).y;
    const railY = v.set(W / 2, 0, 0).applyMatrix4(root.matrixWorld).y;
    const bowErr = Math.abs(bowY - expectedDip);
    const railErr = Math.abs(railY);
    if (bowErr > worstBow) { worstBow = bowErr; worstBowAt = yawDeg; }
    if (railErr > worstRail) { worstRail = railErr; worstRailAt = yawDeg; }
    // Pure roll: starboard rail lifts by the same amount at every heading.
    root.rotation.set(0, yaw, ROLL, root.rotation.order);
    root.updateMatrixWorld(true);
    const rollRailY = v.set(W / 2, 0, 0).applyMatrix4(root.matrixWorld).y;
    const rollErr = Math.abs(rollRailY - expectedRailLift);
    if (rollErr > worstRollRail) { worstRollRail = rollErr; worstRollRailAt = yawDeg; }
    console.log(`    yaw ${String(yawDeg).padStart(3)}°  pitch ${PITCH}: bow y ${bowY.toFixed(2).padStart(6)} (want ${expectedDip.toFixed(2)})  rail y ${railY.toFixed(2).padStart(5)} (want 0.00)   roll ${ROLL}: rail y ${rollRailY.toFixed(2)} (want ${expectedRailLift.toFixed(2)})`);
  }
  expect(`${type}: a 0.2 rad pitch dips the bow by ${(-expectedDip).toFixed(2)} m at every heading (worst error ${worstBow.toFixed(2)} at yaw ${worstBowAt}°)`,
    worstBow <= TOL, 'pitch is applied about WORLD X: on E/W headings the bow stays level');
  expect(`${type}: a pure pitch leaves the rails level (worst rail lift ${worstRail.toFixed(2)} at yaw ${worstRailAt}°)`,
    worstRail <= TOL, 'pitch leaks into roll on off-axis headings');
  expect(`${type}: a 0.15 rad roll lifts the starboard rail ${expectedRailLift.toFixed(2)} m at every heading (worst error ${worstRollRail.toFixed(2)} at yaw ${worstRollRailAt}°)`,
    worstRollRail <= TOL);
}

// ── THE WET EDGE AND THE COMPASS ───────────────────────────────────────────
// Two children of the root are meant to IGNORE the hull's attitude: the
// waterline foam collar (it belongs to the sea, not to the ship) and the
// compass needle (it points north whatever the deck does). Both cancel the
// root's rotation, and both were composed in the same wrong Euler order as the
// bug above, so both were only right on a north/south heading.
{
  const type = 'sloop';
  const stats = SHIP_STATS[type];
  const ship = fixtureShip(type);
  // Server-sent body-axis attitude: fixed, so the exponential lerps in update()
  // converge to a known number instead of to whatever the swell is doing.
  ship.pitch = 0.14;
  ship.roll = -0.11;
  sr.buildShip(ship);
  const mesh = sr.shipMeshes.get(ship.id);
  // The detail root (wheel, compass, anchor) is held behind the first-draw
  // allowance; open it the way the probes do or update() never reaches it.
  openFirstDrawBudgetForSettle();
  const cam = new THREE.Vector3();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s2 = new THREE.Vector3();
  let worstFoam = 0, worstFoamAt = 0, worstNeedle = 0, worstNeedleAt = 0;
  for (const yawDeg of YAWS) {
    ship.rotation = THREE.MathUtils.degToRad(yawDeg);
    ship.position.x = 40 * Math.cos(ship.rotation);
    ship.position.z = 40 * Math.sin(ship.rotation);
    cam.set(ship.position.x + 12, 6, ship.position.z + 12);
    // Settle: a fixed clock makes the wave attitude a constant, so the
    // exponential lerps converge and the collar's one-frame lag vanishes.
    for (let i = 0; i < 24; i++) sr.update([ship], [], 30, 2, 0, cam);
    mesh.root.updateMatrixWorld(true);
    const pitch = mesh.root.rotation.x, roll = mesh.root.rotation.z;
    mesh.waterlineFoam.matrixWorld.decompose(p, q, s2);
    e.setFromQuaternion(q, 'YXZ');
    const foamTilt = Math.max(Math.abs(e.x), Math.abs(e.z));
    if (foamTilt > worstFoam) { worstFoam = foamTilt; worstFoamAt = yawDeg; }
    mesh.compassNeedle.matrixWorld.decompose(p, q, s2);
    e.setFromQuaternion(q, 'YXZ');
    const needleYaw = Math.abs(angleWrap(e.y));
    if (needleYaw > worstNeedle) { worstNeedle = needleYaw; worstNeedleAt = yawDeg; }
    console.log(`    yaw ${String(yawDeg).padStart(3)}°  hull pitch ${pitch.toFixed(3)} roll ${roll.toFixed(3)}  ->  foam tilt ${foamTilt.toFixed(4)} rad, needle yaw ${needleYaw.toFixed(4)} rad`);
    // Guard against a vacuous pass: with no attitude to cancel both are trivial.
    expect(`sloop yaw ${yawDeg}°: the hull actually has an attitude to cancel, and the detail root is up`,
      Math.abs(pitch) > 0.05 && Math.abs(roll) > 0.05 && mesh.detailRoot.visible,
      `pitch ${pitch} roll ${roll} detailRoot.visible ${mesh.detailRoot.visible}`);
  }
  expect(`waterline collar stays flat on the sea at every heading (worst tilt ${worstFoam.toFixed(4)} rad at yaw ${worstFoamAt}°)`,
    worstFoam <= 0.002, 'the foam cancel is composed in the wrong Euler order');
  // The needle is rigid, not gimballed: cancelling only the yaw of Ry·Rx·Rz
  // leaves a second-order pitch·roll term (0.14 x 0.127 = 0.018 rad here), which
  // is the needle tilting with the deck. Anything larger is the composition bug
  // (drop the negation or the 'YXZ' order and this reads the hull's own yaw).
  expect(`compass needle still points north within 2° at every heading (worst yaw ${worstNeedle.toFixed(4)} rad at yaw ${worstNeedleAt}°)`,
    worstNeedle <= 0.035);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
