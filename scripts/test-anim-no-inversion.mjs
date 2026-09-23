// NOTHING INVERTED — the no-inversion gate family, first cases (b1.6a).
//
// The owner's words: "all animations perfect, nothing inverted". Every case
// below was measured backwards at f5fee97e (evidence/animations/
// vm-ship-inversion.out.txt, rig-inversion.out.txt):
//
//   * helm wheel top peg moved screen-LEFT while the bow swung screen-RIGHT;
//   * the masthead flag and every pennant pointed exactly INTO the wind
//     (dot = -1.000 at every heading);
//   * palms leaned along a fixed world vector (dot with the wind -0.53..+0.12);
//   * a pirate looking UP nodded her head DOWN (rig and low tier), and the
//     low-tier aimed pistol dipped when she aimed up;
//   * a turning hull heeled INTO the turn like an aircraft.
//
// Each case is graded twice: the shipped function must pass, and the formula
// HEAD shipped (transcribed, a negative control) must FAIL the same predicate,
// so the gate proves on every run that it can go red. Then the consumers are
// grepped: a helper nobody calls fixes nothing.
//
//   node --import tsx scripts/test-anim-no-inversion.mjs
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  helmWheelRotZ, apparentWindLocal, flagPivotYaw, flagSlack, foliageWindInto,
  lowTierHeadPitchX, pitchUpToBoneX, WHEEL_TURNS_LOCK_TO_LOCK,
} from '../src/client/rendering/signConventions.ts';
import { applyShipRudderSteering, shipTurnHeel } from '../src/server/systems/PhysicsSystem.ts';
import { toShipWorld3 } from '../src/shared/interactions.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { assets } from '../src/client/assets/AssetLibrary.ts';
import { makePlayerRig, updatePlayerRig, playerRigOf } from '../src/client/rendering/factories/PlayerRigFactory.ts';
import { makePlayerMesh } from '../src/client/rendering/factories/PlayerMeshFactory.ts';

const t0 = performance.now();
let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── 1. HELM WHEEL: the top peg moves across the screen the way the bow does ──
console.log('Helm wheel vs the turn');
function steerRightOmega() {
  const ship = { type: 'sloop', velocity: { x: 0, z: 8 }, rudderAngle: 0, angularVelocity: 0, waterLevel: 0 };
  for (let i = 0; i < 40; i++) applyShipRudderSteering(ship, 1 / 30, +1);
  return ship;
}
const steered = steerRightOmega();
expect('steer +1 (D, right) gives +rudder and omega < 0 (the convention the wheel reads)',
  steered.rudderAngle > 0 && steered.angularVelocity < 0,
  `rudder ${steered.rudderAngle.toFixed(3)} omega ${steered.angularVelocity.toFixed(3)}`);
function wheelPegVsHeading(rotZOf, yaw) {
  const L = SHIP_STATS.sloop.length;
  const ship = new THREE.Object3D(); ship.rotation.y = yaw;
  const wheel = new THREE.Object3D(); wheel.position.set(0, 3, -0.315 * L); ship.add(wheel);
  const peg = new THREE.Object3D(); peg.position.set(0, 0.4, 0); wheel.add(peg);
  ship.updateMatrixWorld(true);
  const eye = V(0, 3.2, -0.37 * L).applyMatrix4(ship.matrixWorld);
  const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 100);
  cam.position.copy(eye); cam.lookAt(eye.clone().add(V(Math.sin(yaw), 0, Math.cos(yaw)))); cam.updateMatrixWorld(true);
  const pegX = () => { ship.updateMatrixWorld(true); return V(0, 0, 0).applyMatrix4(peg.matrixWorld).project(cam).x; };
  wheel.rotation.z = 0; const a = pegX();
  const rudder01 = steered.rudderAngle / SHIP.RUDDER_MAX_ANGLE;
  wheel.rotation.z = rotZOf(rudder01 * 0.2); const b = pegX();
  const yaw1 = yaw + steered.angularVelocity * 0.2; // omega sign from the real server function
  const f = (r) => eye.clone().add(V(Math.sin(r), 0, Math.cos(r)).multiplyScalar(50)).project(cam).x;
  return { peg: b - a, heading: f(yaw1) - f(yaw) };
}
const headWheel = (r01) => -r01 * WHEEL_TURNS_LOCK_TO_LOCK * Math.PI; // f5fee97e ShipRenderer.ts:3172
for (const yaw of [0, 0.7, -2.4]) {
  const s = wheelPegVsHeading(helmWheelRotZ, yaw);
  expect(`yaw ${yaw}: top peg screen dx has the heading's sign`, Math.sign(s.peg) === Math.sign(s.heading) && Math.abs(s.peg) > 1e-3,
    `peg ${s.peg.toFixed(3)} heading ${s.heading.toFixed(3)}`);
  const h = wheelPegVsHeading(headWheel, yaw);
  expect(`yaw ${yaw}: negative control (HEAD formula) is caught`, Math.sign(h.peg) !== Math.sign(h.heading));
}

// ── 2. FLAG + PENNANTS fly downwind of the APPARENT wind ──────────────────────
console.log('Flag and pennants vs the apparent wind');
const flyDir = (pivotYawOf, shipRot, localYaw, droop = 0) => {
  const ship = new THREE.Object3D(); ship.rotation.y = shipRot;
  const piv = new THREE.Object3D(); piv.rotation.set(0, pivotYawOf(localYaw), -droop); ship.add(piv);
  ship.updateMatrixWorld(true);
  return V(1, 0, 0).transformDirection(piv.matrixWorld);
};
const headFlag = (lw) => Math.PI * 0.5 + lw; // f5fee97e ShipRenderer.ts:3299/3309/3319
let worst = 1; let headWorst = -1; let cases = 0;
for (let h = 0; h < 8; h++) {
  for (const [dir, str] of [[-0.26 * Math.PI, 0.9], [1.9, 0.8], [-2.8, 1.3]]) {
    const rot = -Math.PI + (h * Math.PI) / 4 + 0.1;
    const spd = 7;
    const vx = Math.sin(rot) * spd; const vz = Math.cos(rot) * spd;
    const aw = apparentWindLocal(dir, str, rot, vx, vz);
    const W = str * 17;
    const app = V(Math.sin(dir) * W - vx, 0, Math.cos(dir) * W - vz).normalize();
    const fly = flyDir(flagPivotYaw, rot, aw.localYaw);
    const flyH = V(fly.x, 0, fly.z).normalize();
    worst = Math.min(worst, flyH.dot(app));
    headWorst = Math.max(headWorst, flyDir(headFlag, rot, aw.localYaw).dot(app));
    cases += 1;
  }
}
expect(`fly . apparent wind > 0.9 at 8 headings x 3 winds (${cases} cases)`, worst > 0.9, `worst ${worst.toFixed(3)}`);
expect('negative control: the HEAD pivot yaw streams upwind', headWorst < 0, `best ${headWorst.toFixed(3)}`);
{
  // Dead run at the wind's own speed: the apparent wind dies and the flag hangs.
  const aw = apparentWindLocal(0.4, 0.9, 0.4, Math.sin(0.4) * 15.3, Math.cos(0.4) * 15.3);
  const beat = apparentWindLocal(0.4, 0.9, 0.4 + Math.PI, -Math.sin(0.4) * 6, -Math.cos(0.4) * 6);
  expect('a run at the wind speed leaves the flag slack (apparent < 1.5 m/s, slack > 0.8)',
    aw.speed < 1.5 && flagSlack(aw.speed) > 0.8, `apparent ${aw.speed.toFixed(2)} slack ${flagSlack(aw.speed).toFixed(2)}`);
  expect('head to wind the apparent wind is strongest and the flag streams (slack 0)',
    beat.speed > 15 && flagSlack(beat.speed) === 0, `apparent ${beat.speed.toFixed(2)}`);
  const hang = flyDir(flagPivotYaw, 0, 0, 1.2);
  expect('slack droop drops the fly end below the halyard', hang.y < -0.8, `fly y ${hang.y.toFixed(2)}`);
}

// ── 3. FOLIAGE leans with the wind ───────────────────────────────────────────
console.log('Foliage vs the wind');
{
  let fWorst = 1; let hBest = 1;
  const v = new THREE.Vector2();
  for (const d of [-0.26 * Math.PI, 0.5, 2.2, -1.6, 3.0]) {
    foliageWindInto(v, d, 0.9, 1);
    const wind = new THREE.Vector2(Math.sin(d), Math.cos(d));
    fWorst = Math.min(fWorst, v.clone().normalize().dot(wind));
    hBest = Math.min(hBest, new THREE.Vector2(0.68, 0.46).normalize().dot(wind)); // f5fee97e Game.ts:3355
  }
  expect('foliage lean . wind > 0.95 at 5 directions', fWorst > 0.95, `worst ${fWorst.toFixed(3)}`);
  expect('negative control: the fixed HEAD vector is caught', hBest < 0.95, `worst ${hBest.toFixed(3)}`);
  foliageWindInto(v, 0, 1.4, 1); const storm = v.length(); foliageWindInto(v, 0, 0.9, 1);
  expect('a storm gale bends the palms harder than the calm breeze', storm > v.length() * 1.3, `${storm.toFixed(2)} vs ${v.length().toFixed(2)}`);
}

// ── 4. TURN HEEL: a displacement hull heels OUTWARD ─────────────────────────
console.log('Turn heel');
{
  const omega = steered.angularVelocity; // turning right
  const roll = shipTurnHeel(omega, 0.8);
  // Outer side of a right turn: the bow swings toward local -X, so the centre
  // of the turn is on -X and the outer rail is +X. Measure with the shared
  // ship transform the server and the client both use.
  const pose = { position: { x: 0, y: 0, z: 0 }, rotation: 0, pitch: 0, roll };
  const outer = toShipWorld3({ x: 2, y: 0, z: 0 }, pose).y;
  const inner = toShipWorld3({ x: -2, y: 0, z: 0 }, pose).y;
  const r0 = 0.3; const r1 = r0 + omega * 0.1;
  const bowStepX = Math.sin(r1) - Math.sin(r0); const bowStepZ = Math.cos(r1) - Math.cos(r0);
  const localSide = bowStepX * Math.cos(r0) - bowStepZ * Math.sin(r0); // bow step on the ship's local X
  expect('steer right swings the bow toward local -X (so +X is the outer rail)', localSide < 0, `local dx ${localSide.toFixed(4)}`);
  expect('turn heel lowers the OUTER rail', outer < inner, `outer y ${outer.toFixed(3)} inner y ${inner.toFixed(3)}`);
  expect('turn heel stays <= 3 deg', Math.abs(shipTurnHeel(omega * 10, 1.15)) <= (3 * Math.PI) / 180 + 1e-9,
    `${((Math.abs(shipTurnHeel(omega * 10, 1.15)) * 180) / Math.PI).toFixed(2)} deg`);
  const headRoll = Math.max(-0.06, Math.min(0.06, -omega * 0.8 * 0.5)); // f5fee97e PhysicsSystem.ts:2954
  const hp = { ...pose, roll: headRoll };
  expect('negative control: HEAD heeled into the turn', toShipWorld3({ x: 2, y: 0, z: 0 }, hp).y > toShipWorld3({ x: -2, y: 0, z: 0 }, hp).y);
}

// ── 5. HEAD PITCH: looking up raises the gaze (rig AND low tier) ─────────────
console.log('Head pitch, rigged and low tier');
{
  const bytes = readFileSync(new URL('../public/assets/models/pirate_base.glb', import.meta.url));
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject);
  });
  assets.source = (name) => (name === 'pirate_base' ? { scene: gltf.scene, animations: gltf.animations } : null);
  const mesh = makePlayerRig(0x3366cc, 'pirate', 'crew', 'no-inversion', 'balanced');
  const rig = playerRigOf(mesh);
  const player = {
    id: 'no-inversion', state: 'alive', health: 100, velocity: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 }, weapons: [], activeSlot: 0, atCannon: null, atHelm: null, atCrowNest: false, mastClimb: null,
  };
  const gazeY = (pitch) => {
    updatePlayerRig(mesh, player, 1 / 60, 0, pitch, 0, 0, 0, 0);
    mesh.updateMatrixWorld(true);
    const q = new THREE.Quaternion(); rig.bones.head.getWorldQuaternion(q);
    return q;
  };
  const q0 = gazeY(0); const q1 = gazeY(0.4);
  const fwd = V(0, 0, 1).applyQuaternion(q1.clone().multiply(q0.clone().invert()));
  expect('RIG: lookPitch +0.4 turns the head gaze UP (forward y > 0.25)', fwd.y > 0.25, `gaze y ${fwd.y.toFixed(3)}`);

  const low = makePlayerMesh(0x3366cc, 'pirate');
  const head = low.userData.animation?.parts?.head;
  expect('LOW: makePlayerMesh exposes parts.head', !!head);
  if (head) {
    head.rotation.set(lowTierHeadPitchX(0.4), 0, 0);
    low.updateMatrixWorld(true);
    const lowFwd = V(0, 0, 1).transformDirection(head.matrixWorld);
    expect('LOW: lookPitch +0.4 turns the head gaze UP (forward y > 0.25)', lowFwd.y > 0.25, `gaze y ${lowFwd.y.toFixed(3)}`);
    head.rotation.set(Math.max(-0.6, Math.min(0.5, 0.4 * 0.55)), 0, 0); low.updateMatrixWorld(true); // f5fee97e PlayerAnimator.ts:500
    expect('LOW: negative control (HEAD formula) is caught', V(0, 0, 1).transformDirection(head.matrixWorld).y < 0.25);
  }
  // Raised aim arm (low tier): the hand hangs along -Y from the shoulder pivot;
  // aiming UP must lift it, and the wrist must lift the muzzle (+Z) too.
  const armDir = (x) => V(0, -1, 0).applyEuler(new THREE.Euler(x, 0, 0));
  const upArm = armDir(-0.94 + pitchUpToBoneX(0.5) * 0.52).y - armDir(-0.94).y;
  expect('LOW: aim arm rises when aiming up', upArm > 0.1, `hand dy ${upArm.toFixed(3)}`);
  const muzzle = V(0, 0, 1).applyEuler(new THREE.Euler(pitchUpToBoneX(0.5), 0, 0));
  expect('LOW: wrist lifts the muzzle when aiming up', muzzle.y > 0.4, `muzzle y ${muzzle.y.toFixed(3)}`);
}

// ── 6. THE CONSUMERS: a helper nobody calls fixes nothing ───────────────────
console.log('Wiring');
{
  const ship = src('src/client/rendering/ShipRenderer.ts');
  expect('ShipRenderer drives the wheel through helmWheelRotZ', /helmWheelRotZ\(rudder01\)/.test(ship) && !/-rudder01 \* WHEEL_TURNS/.test(ship));
  expect('ShipRenderer yaws the flag and both pennant loops with flagPivotYaw (no PI/2 + localWind left)',
    /const flagYaw = flagPivotYaw\(apparent\.localYaw\)/.test(ship)
    && (ship.match(/rotation\.y = flagYaw;/g) ?? []).length >= 3 && !/Math\.PI \* 0\.5 \+ localWind/.test(ship));
  expect('ShipRenderer feeds the flag the APPARENT wind', /apparentWindLocal\(/.test(ship));
  const game = src('src/client/core/Game.ts');
  expect('Game drives foliageWind from sampleLocalWind via foliageWindInto',
    /foliageWindInto\(\s*this\.foliageWind\.value/.test(game) && /sampleLocalWind\(/.test(game) && !/foliageWind\.value\.set\(0\.68/.test(game));
  const anim = src('src/client/rendering/PlayerAnimator.ts');
  expect('PlayerAnimator low-tier head uses lowTierHeadPitchX', /lowTierHeadPitchX\(lookPitchRaw\)/.test(anim) && !/lookPitchRaw \* 0\.55/.test(anim));
  expect('PlayerAnimator aim arm and wrist use pitchUpToBoneX', (anim.match(/pitchUpToBoneX\(/g) ?? []).length >= 2
    && !/\+ aimPitch \* 0\.52/.test(anim) && !/wristX \+= THREE\.MathUtils\.clamp\(lookPitchRaw/.test(anim));
  const phys = src('src/server/systems/PhysicsSystem.ts');
  expect('PhysicsSystem attitude uses shipTurnHeel', /const turnHeel = shipTurnHeel\(/.test(phys));
}

const ms = performance.now() - t0;
console.log(`\n${checks - failures}/${checks} checks, ${ms.toFixed(0)} ms`);
if (failures) { console.error(`FAIL: ${failures} inversion check(s)`); process.exit(1); }
console.log('PASS: nothing inverted (wheel, flag, foliage, heel, head pitch)');
