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
import { readFileSync, existsSync } from 'node:fs';
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
import { PlayerAnimator } from '../src/client/rendering/PlayerAnimator.ts';
import {
  weaponPose, recoilEnvelope, recoilSpecFor, recoilDelta, drawDelta, muzzleTipFor, cutlassSlashPose, slashRibbonPose,
  CUTLASS_TIP, SLASH_RIBBON_HALF_SPAN, SLASH_SWING_TIME, VIEW_DRAW_TIME, toolPose, TOOL_MIN_OFF_AXIS,
} from '../src/client/rendering/viewmodel/poses.ts';
import { makeHeldWeaponMesh } from '../src/client/rendering/factories/WeaponMeshFactory.ts';
const DEG = Math.PI / 180;

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
  const ship = { type: 'sloop', rotation: 0, velocity: { x: 0, z: 8 }, rudderAngle: 0, angularVelocity: 0, waterLevel: 0 };
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

// ── 5b. THE NEW SKELETON (b3.3a, D25): named bones, three.js mixer, all three bodies ──
// The no-inversion family re-pointed at the 55-bone named set (thigh/calf/
// upperarm/lowerarm/head): pirate_clips.glb bound BY NAME to each of the three
// bodies through a real THREE.AnimationMixer, which is the path the runtime
// plays clips on. test-anim-rig-anatomy grades the clip file on its own node
// hierarchy with hand-rolled FK; this grades what three.js produces on the
// male, female AND stout bodies (a retarget by name that lands on the wrong
// bone, or a body whose rest roll differs, shows up here and not there).
// Knee: hinge fixed to the thigh from the rest pose (the calf folds behind).
// Elbow: the clinical shoulder-frame metric of test-anim-rig-anatomy (the UAL
// upper arm carries no humeral twist, so a bone-fixed hinge is wrong there).
// Head: the RUNTIME look formula (updatePlayerRig: head.rotation.x +=
// pitchUpToBoneX(pitch)) on the new `head` bone must raise the gaze.
console.log('New skeleton (55-bone named set): mixer on male, female, stout');
{
  const qm = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const qi = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qr = (q, v) => qm(qm(q, [...v, 0]), qi(q)).slice(0, 3);
  const sub = (a, b) => a.map((x, i) => x - b[i]); const dt3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const un = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
  const swingQ = (a, b) => { const c = cr(a, b); const d = dt3(a, b); if (d < -0.9999) return [1, 0, 0, 0]; return un([c[0], c[1], c[2], 1 + d]); };
  const ELBOW = { extMax: 145 * DEG, intMax: 90 * DEG, bendMax: 150 * DEG, bendMin: 0.2 };
  const MARGIN = 0.05;
  const loadGlb = async (p) => {
    const b = readFileSync(new URL(`../${p}`, import.meta.url));
    return new Promise((res, rej) => new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej));
  };
  const NAMED = ['thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r', 'head'];
  const LEGACY_NAMES = ['shin_l', 'shin_r', 'forearm_l', 'forearm_r', 'spine1', 'hips'];
  const tq = new THREE.Quaternion(); const tv = new THREE.Vector3();
  /** World rotation [x,y,z,w] and position of every named bone, right now. */
  const snap = (bones) => {
    const wr = {}; const wp = {};
    for (const [n, b] of Object.entries(bones)) { b.getWorldQuaternion(tq); b.getWorldPosition(tv); wr[n] = tq.toArray(); wp[n] = tv.toArray(); }
    return { wr, wp };
  };
  /** The graders for one body, set up from its rest pose. */
  function grader(bones, legNames = { calf: 'calf' }) {
    const R = snap(bones);
    const hinge = {};
    for (const s of ['l', 'r']) {
      const kd = un(sub(R.wp[`${legNames.calf}_${s}`], R.wp[`thigh_${s}`]));
      hinge[`knee_${s}`] = qr(qi(R.wr[`thigh_${s}`]), un(cr(kd, [0, 0, -1])));
      if (bones[`upperarm_${s}`] && bones[`lowerarm_${s}`]) {
        const ed = un(sub(R.wp[`lowerarm_${s}`], R.wp[`upperarm_${s}`]));
        hinge[`elbow_${s}`] = qr(qi(R.wr[`upperarm_${s}`]), un(cr(ed, [0, 0, 1])));
      }
    }
    const ARM = {};
    for (const s of bones.clavicle_l ? ['l', 'r'] : []) {
      const js = `clavicle_${s}`;
      const dRest = un(qr(qi(R.wr[js]), sub(R.wp[`lowerarm_${s}`], R.wp[`upperarm_${s}`])));
      const hRest = un(qr(qi(R.wr[js]), qr(R.wr[`upperarm_${s}`], hinge[`elbow_${s}`])));
      const down = un(qr(qi(R.wr[js]), [0, -1, 0]));
      ARM[s] = { js, dRest, hRest, down, hDown: un(qr(swingQ(dRest, down), hRest)), sg: s === 'l' ? 1 : -1 };
    }
    const knee = (P, s) => {
      const u = un(sub(P.wp[`${legNames.calf}_${s}`], P.wp[`thigh_${s}`])); const f = un(sub(P.wp[`foot_${s}`], P.wp[`${legNames.calf}_${s}`]));
      const h = un(qr(P.wr[`thigh_${s}`], hinge[`knee_${s}`]));
      return -Math.atan2(dt3(cr(u, f), h), dt3(u, f)); // margin: > 0 = bent backward
    };
    const elbow = (P, s) => {
      const A = ARM[s]; const toS = (v) => qr(qi(P.wr[A.js]), v);
      const u = un(toS(sub(P.wp[`lowerarm_${s}`], P.wp[`upperarm_${s}`]))); const f = un(toS(sub(P.wp[`hand_${s}`], P.wp[`lowerarm_${s}`])));
      const bend = Math.acos(Math.max(-1, Math.min(1, dt3(u, f))));
      if (bend < ELBOW.bendMin) return -1;
      const n = un(cr(u, f));
      const psiOf = (h) => A.sg * Math.atan2(dt3(cr(h, n), u), dt3(h, n));
      const p1 = psiOf(un(qr(swingQ(A.dRest, u), A.hRest))); const p2 = psiOf(un(qr(swingQ(A.down, u), A.hDown)));
      const psi = Math.abs(p1) < Math.abs(p2) ? p1 : p2;
      return Math.max(bend - ELBOW.bendMax, -psi - ELBOW.extMax, psi - ELBOW.intMax);
    };
    const headGaze = bones.head ? qr(qi(R.wr.head), [0, 0, 1]) : null; const headUp = bones.head ? qr(qi(R.wr.head), [0, 1, 0]) : null;
    return { R, hinge, knee, elbow, headGaze, headUp };
  }

  const clipsGltf = await loadGlb('public/assets/models/pirate_clips.glb');
  const clipList = clipsGltf.animations;
  expect(`pirate_clips.glb carries the clip library (${clipList.length} clips)`, clipList.length >= 80);
  let maleBones = null; let maleScene = null;
  for (const body of ['male', 'female', 'stout']) {
    const scene = (await loadGlb(`assets-src/quaternius/out/pirate_base_${body}.glb`)).scene;
    scene.updateMatrixWorld(true);
    const bones = Object.fromEntries(NAMED.map((n) => [n, scene.getObjectByName(n)]));
    const missing = NAMED.filter((n) => !bones[n]?.isBone);
    const legacy = LEGACY_NAMES.filter((n) => scene.getObjectByName(n));
    expect(`${body}: every graded bone is found BY NAME on the new skeleton, no legacy name left`, !missing.length && !legacy.length,
      `missing ${missing.join(', ')} legacy ${legacy.join(', ')}`);
    if (missing.length) continue;
    const G = grader(bones);
    // Handedness (section 3.10: facing +Z, the right hand is -X).
    expect(`${body}: the pirate faces +Z with hand_r on -X at rest`, G.R.wp.hand_r[0] < -0.2 && G.R.wp.hand_l[0] > 0.2,
      `hand_r x ${G.R.wp.hand_r[0].toFixed(2)} hand_l x ${G.R.wp.hand_l[0].toFixed(2)}`);
    if (body === 'male') { maleBones = bones; maleScene = scene; }
    const mixer = new THREE.AnimationMixer(scene);
    const worst = []; let bad = 0; let gazeBad = 0; let ctlCaught = 0; let graded = 0;
    for (const clip of clipList) {
      const action = mixer.clipAction(clip); action.play();
      let clipWorst = -Infinity; let where = '';
      for (let k = 0; k <= 20; k++) {
        mixer.setTime(clip.duration * k / 20); scene.updateMatrixWorld(true);
        const P = snap(bones);
        for (const s of ['l', 'r']) {
          const km = G.knee(P, s); if (km > clipWorst) { clipWorst = km; where = `knee_${s} ${k}/20`; }
          const em = G.elbow(P, s); if (em > clipWorst) { clipWorst = em; where = `elbow_${s} ${k}/20`; }
        }
        if (k === 10) {
          const head = bones.head; const keep = head.quaternion.clone();
          // Toward the head's OWN up before the look (a pirate lying on his back
          // already gazes at +Y world), as test-anim-rig-anatomy grades it.
          scene.updateMatrixWorld(true); head.getWorldQuaternion(tq); const up0 = qr(tq.toArray(), G.headUp);
          const gazeUp = () => { scene.updateMatrixWorld(true); head.getWorldQuaternion(tq); return dt3(qr(tq.toArray(), G.headGaze), up0); };
          const g0 = gazeUp();
          head.rotation.x += pitchUpToBoneX(0.4); const g1 = gazeUp();
          head.quaternion.copy(keep); head.rotation.x -= pitchUpToBoneX(0.4); const gInv = gazeUp(); // the inverted sign
          head.quaternion.copy(keep);
          graded++;
          if (!(g1 > g0 + 0.1)) gazeBad++;
          if (gInv < g0 - 0.1) ctlCaught++;
        }
      }
      action.stop(); mixer.uncacheAction(clip);
      if (clipWorst > MARGIN) { bad++; worst.push(`${clip.name}: ${clipWorst.toFixed(3)} rad (${where})`); }
    }
    expect(`${body}: every clip keeps knee and elbow flexion margins <= +${MARGIN} rad at 21 phases (${clipList.length - bad}/${clipList.length})`,
      bad === 0, worst.slice(0, 8).join('\n      '));
    expect(`${body}: runtime head look (rotation.x += pitchUpToBoneX(+0.4)) raises the gaze in every clip (${graded - gazeBad}/${graded})`, gazeBad === 0);
    expect(`${body}: negative control, the inverted look sign lowers the gaze in every clip`, ctlCaught === graded, `${ctlCaught}/${graded}`);
  }
  // Negative controls on the metric itself (male rest pose): a backward knee and
  // elbow fold must fail, a natural bend must pass.
  if (maleBones) {
    const G = grader(maleBones);
    const bendAt = (bone, hingeLocal, ang) => {
      const b = maleBones[bone]; const keep = b.quaternion.clone();
      // rotate about the parent limb's hinge, expressed in the bone's parent frame
      const parentBone = b.parent; parentBone.updateMatrixWorld(true);
      const limbQ = new THREE.Quaternion(); maleBones[bone === 'calf_l' || bone === 'calf_r' ? `thigh_${bone.slice(-1)}` : `upperarm_${bone.slice(-1)}`].getWorldQuaternion(limbQ);
      const parentQ = new THREE.Quaternion(); parentBone.getWorldQuaternion(parentQ);
      const axisW = new THREE.Vector3(...hingeLocal).applyQuaternion(limbQ);
      const axisP = axisW.applyQuaternion(parentQ.clone().invert()).normalize();
      b.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axisP, ang));
      maleScene.updateMatrixWorld(true); const P = snap(maleBones); b.quaternion.copy(keep); maleScene.updateMatrixWorld(true);
      return P;
    };
    const kBack = G.knee(bendAt('calf_l', G.hinge.knee_l, -0.5), 'l'); const kOk = G.knee(bendAt('calf_l', G.hinge.knee_l, 1.0), 'l');
    const eBack = G.elbow(bendAt('lowerarm_r', G.hinge.elbow_r, -0.5), 'r'); const eOver = G.elbow(bendAt('lowerarm_r', G.hinge.elbow_r, 2.8), 'r');
    const eOk = G.elbow(bendAt('lowerarm_r', G.hinge.elbow_r, 1.2), 'r');
    expect('negative controls: a 29 deg backward knee, a 29 deg backward elbow and a 160 deg elbow over-fold fail; natural bends pass',
      kBack > MARGIN && kOk <= MARGIN && eBack > MARGIN && eOver > MARGIN && eOk <= MARGIN,
      `knee back ${kBack.toFixed(3)} ok ${kOk.toFixed(3)} elbow back ${eBack.toFixed(3)} over ${eOver.toFixed(3)} ok ${eOk.toFixed(3)}`);
  }
  // A REAL negative control: the legacy rig animations-01 convicted (thigh/shin
  // names) still fails the same knee grader on its run clip.
  {
    const v1 = await loadGlb('public/assets/models/pirate_base.glb');
    const bones = Object.fromEntries(['thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'].map((n) => [n, v1.scene.getObjectByName(n)]));
    v1.scene.updateMatrixWorld(true);
    const G = grader(bones, { calf: 'shin' });
    const run = v1.animations.find((c) => c.name === 'run');
    const mixer = new THREE.AnimationMixer(v1.scene); mixer.clipAction(run).play();
    let w = -Infinity;
    for (let k = 0; k <= 20; k++) { mixer.setTime(run.duration * k / 20); v1.scene.updateMatrixWorld(true); const P = snap(bones); w = Math.max(w, G.knee(P, 'l'), G.knee(P, 'r')); }
    expect('negative control: the legacy pirate_base.glb run clip (reverse knees, animations-01) fails the knee grader', w > MARGIN, `margin ${w.toFixed(3)} rad`);
  }
}

// ── 5c. LOW TIER, end to end (b3.3a, vm:animations:1, D25) ───────────────────
// The procedural body (makePlayerMesh + PlayerAnimator) is the load-failure
// fallback and the island skeleton; phones drew it for every pirate, so its
// signs are graded through animatePlayerMesh itself, not just the helpers.
// Pivot convention: a limb hangs along -Y, rotation.x < 0 swings it toward +Z
// (the way the body faces). Each case also grades the MIRRORED pose (pivot
// rotation.x negated, the animations-02 shape) and requires it to fail.
console.log('Low tier (procedural fallback), through animatePlayerMesh');
{
  let clock = 0;
  const view = {
    input: { isAiming: () => false }, ocean: { getTime: () => clock }, localPlayerId: 'local',
    tempSlashPos: new THREE.Vector3(), spawnRemoteSlashArc: () => {}, getCutlassSwingProgress: () => 0,
  };
  const animator = new PlayerAnimator(view);
  const cutlass = () => ({ weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 });
  const pistol = () => ({ weaponId: 'pistol', ammo: 6, reserve: 12, reloading: false, reloadTimer: 0 });
  const mk = (over = {}) => ({
    id: 'low', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100,
    state: 'walking', weapons: [cutlass(), pistol(), null, null], activeSlot: 0, knockbackVelocity: { x: 0, y: 0, z: 0 },
    atCannon: false, atHelm: false, atCrowNest: false, blocking: false, bailing: false, cutlassCharge: 0, mastClimb: null,
    crouching: false, equippedTool: null, hullRepairProgress: 0, downedUntil: 0, reviveProgress: 0, ...over,
  });
  const pose = (over, frames = 60) => {
    const mesh = makePlayerMesh(0x3366cc, 'pirate'); const player = mk(over);
    for (let i = 0; i < frames; i++) { clock += 1 / 60; animator.animatePlayerMesh(mesh, player, null, 1 / 60); }
    mesh.updateMatrixWorld(true);
    return mesh;
  };
  const parts = (m) => m.userData.animation.parts;
  const local = (m, o, p = V(0, 0, 0)) => m.worldToLocal(o.localToWorld(p.clone()));
  const ARM_TIP = V(0, -0.6, 0); // the left hand, in its pivot frame (the right has a named hand part)
  const hands = (m) => {
    const p = parts(m);
    return { r: local(m, p.rightHand), l: local(m, p.leftArmPivot, ARM_TIP), sh: local(m, p.rightArmPivot) };
  };
  const mirrored = (m) => {
    const p = parts(m); p.leftArmPivot.rotation.x *= -1; p.rightArmPivot.rotation.x *= -1; m.updateMatrixWorld(true);
    return hands(m);
  };
  const gazeY = (m) => V(0, 0, 1).transformDirection(parts(m).head.matrixWorld).y;

  const level = pose({}); const up = pose({ rotation: { x: 0, y: 0.4 } });
  expect('LOW e2e: look pitch +0.4 raises the head gaze', gazeY(up) > gazeY(level) + 0.2, `gaze y ${gazeY(level).toFixed(3)} -> ${gazeY(up).toFixed(3)}`);
  parts(up).head.rotation.x *= -1; up.updateMatrixWorld(true);
  expect('LOW e2e: negative control, the head pitch sign flipped is caught', !(gazeY(up) > gazeY(level) + 0.2));

  const stations = [
    ['helm', { atHelm: true }, (h) => h.r.z >= 0.35 && h.l.z >= 0.35 && h.r.y >= 1.0 && h.r.y <= 1.5 && h.l.y >= 1.0 && h.l.y <= 1.5],
    ['cannon', { atCannon: true }, (h) => h.r.z >= 0.3 && h.l.z >= 0.3],
    ['aimed pistol', { activeSlot: 1 }, (h) => h.r.z - h.sh.z >= 0.35],
  ];
  for (const [name, over, ok] of stations) {
    const m = pose(over); const h = hands(m);
    expect(`LOW e2e: ${name} hands reach FORWARD`, ok(h), `r ${h.r.toArray().map((v) => v.toFixed(2))} l ${h.l.toArray().map((v) => v.toFixed(2))}`);
    expect(`LOW e2e: ${name} negative control, mirrored arms (hands behind, animations-02) are caught`, !ok(mirrored(m)));
  }
  const lowAim = hands(pose({ activeSlot: 1 })).r.y; const highAim = hands(pose({ activeSlot: 1, rotation: { x: 0, y: 0.4 } })).r.y;
  expect('LOW e2e: aiming up lifts the pistol hand', highAim > lowAim + 0.05, `hand y ${lowAim.toFixed(3)} -> ${highAim.toFixed(3)}`);

  // Gait: the arm swings OPPOSITE to the leg on the same side (a same-side
  // swing is the pacing-camel read). Unarmed so the blade pose does not hold the arm.
  const walker = makePlayerMesh(0x3366cc, 'pirate'); const wp = mk({ weapons: [null, null, null, null], velocity: { x: 0, y: 0, z: 3.5 } });
  const arm = []; const leg = [];
  for (let i = 0; i < 150; i++) {
    clock += 1 / 60; animator.animatePlayerMesh(walker, wp, null, 1 / 60);
    if (i >= 30) { arm.push(parts(walker).leftArmPivot.rotation.x); leg.push(parts(walker).leftLegPivot.rotation.x); }
  }
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length; const mb = b.reduce((s, v) => s + v, 0) / b.length;
    const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
    return cov / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0) || 1);
  };
  const c = corr(arm, leg);
  expect('LOW e2e: walking, the left arm swings opposite to the left leg', c < -0.5, `corr ${c.toFixed(3)}`);
  expect('LOW e2e: negative control, a same-side swing is caught', !(corr(arm.map((x) => -x), leg) < -0.5));
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
  // D25 tripwire (b3.3a): the procedural body is the LOW tier only until the
  // v2 character (pirate_v2.glb + LOD1/LOD2, lane b3.2e/f2) ships. The day it
  // does, makePlayerRig must stop returning null on 'low' (skinned LOD1/LOD2,
  // one animation truth) and makePlayerMesh is the load-failure fallback only.
  const rigFactory = src('src/client/rendering/factories/PlayerRigFactory.ts');
  const lowStillBoxes = /quality === 'low'[^\n]*return null/.test(rigFactory);
  const v2Shipped = existsSync(new URL('../public/assets/models/pirate_v2.glb', import.meta.url));
  expect(`D25: once pirate_v2.glb ships the low tier draws the skinned rig, boxes only on load failure (v2 shipped: ${v2Shipped}, low tier still boxes: ${lowStillBoxes})`,
    !(v2Shipped && lowStillBoxes));
  expect('D25: PlayerAnimator keeps the procedural branch behind the rig branch (fallback still animates)',
    /if \(mesh\.userData\.rig\) \{[\s\S]{0,1600}?return;\s*\}\s*\n\s*const animation = mesh\.userData\.animation/.test(anim));
  const phys = src('src/server/systems/PhysicsSystem.ts');
  expect('PhysicsSystem attitude uses shipTurnHeel', /const turnHeel = shipTurnHeel\(/.test(phys));
}

// ── 7. FIRST-PERSON VIEWMODEL (b1.6b): recoil, slash ribbon, draw ────────────
// Poses come from src/client/rendering/viewmodel/poses.ts (pure), projected
// with a real PerspectiveCamera (fov 74, 16:9) exactly like the browser. At
// f5fee97e every gun kicked FORWARD, DOWN and muzzle-DOWN (dot +0.09, pitch
// -2.5 deg), the ribbon swept opposite to the blade, and a draw started 43 deg
// muzzle-HIGH (evidence/animations/vm-ship-inversion.out.txt).
console.log('First-person viewmodel');
{
  const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 100);
  cam.updateMatrixWorld(true);
  const Z6 = [0, 0, 0, 0, 0, 0];
  const still = (aimBlend, recoil) => ({ aimBlend, bob: 0, sway: 0, strafeTilt: 0, travelSwing: 0, reload: Z6, recoil });
  const HIP_HALF = THREE.MathUtils.degToRad(37);
  const rootScale = (id, aim) => id !== 'eye_of_reach' ? 1
    : aim ? Math.tan(THREE.MathUtils.degToRad(14 * 0.85 * 0.5)) / Math.tan(HIP_HALF) : 0.82;
  const meshScale = { eye_of_reach: 0.92, blunderbuss: 0.95, cutlass: 0.92 };
  const rootOf = (pose, scale) => {
    const g = new THREE.Group();
    g.position.set(pose[0], pose[1], pose[2]);
    g.rotation.set(pose[3], pose[4], pose[5]);
    g.scale.setScalar(scale);
    g.updateMatrixWorld(true);
    return g;
  };
  const muzzleOf = (id, pose, scale) => {
    const g = rootOf(pose, scale);
    return { tip: V(...muzzleTipFor(id)).applyMatrix4(g.matrixWorld), fwd: V(0, 0, -1).transformDirection(g.matrixWorld) };
  };
  const pitchDeg = (v) => Math.asin(v.y / v.length()) / DEG;
  const grade = (label, rest, peak) => {
    const d = peak.tip.clone().sub(rest.tip);
    return { along: d.dot(rest.fwd), climb: pitchDeg(peak.fwd) - pitchDeg(rest.fwd) };
  };
  // Recoil timing: peak <= 90 ms (>= 60), settled <= 260 ms (>= 180), no plateau.
  const BANDS = { flintknock: [4, 6], blunderbuss: [8, 11], eye_of_reach: [5, 7] };
  for (const id of ['flintknock', 'blunderbuss', 'eye_of_reach']) {
    const spec = recoilSpecFor(id);
    let tPeak = 0, kPeak = -1, tSettled = Infinity;
    for (let ms = 0; ms <= 600; ms += 1) {
      const k = recoilEnvelope(spec, ms / 1000);
      if (k > kPeak + 1e-9) { kPeak = k; tPeak = ms; }
    }
    for (let ms = tPeak; ms <= 600; ms += 1) if (recoilEnvelope(spec, ms / 1000) < 0.01) { tSettled = ms; break; }
    let later = 0;
    for (let ms = tSettled; ms <= 600; ms += 1) later = Math.max(later, recoilEnvelope(spec, ms / 1000));
    expect(`${id}: recoil peaks in 60-90 ms and settles by 180-260 ms, then stays settled (no hold plateau)`,
      tPeak >= 60 && tPeak <= 90 && tSettled >= 180 && tSettled <= 260 && later < 0.01,
      `peak ${tPeak} ms, settled ${tSettled} ms, max after settle ${later.toFixed(3)}`);
    for (const aim of [0, 1]) {
      const s = rootScale(id, aim);
      const rest = muzzleOf(id, weaponPose(id, still(aim, 0)), s);
      const peak = muzzleOf(id, weaponPose(id, still(aim, 1)), s);
      const g = grade(id, rest, peak);
      expect(`${id} ${aim ? 'ADS' : 'hip'}: the kick drives the muzzle BACK along the barrel (< -0.03 m) and UP (> +2 deg)`,
        g.along < -0.03 && g.climb > 2, `along ${g.along.toFixed(3)} m, climb ${g.climb.toFixed(2)} deg`);
      if (!aim) {
        const [lo, hi] = BANDS[id];
        expect(`${id}: muzzle climb in the ${lo}-${hi} deg band`, g.climb >= lo && g.climb <= hi, `${g.climb.toFixed(2)} deg`);
      }
      const ndc = peak.tip.clone().project(cam);
      if (!(id === 'eye_of_reach' && aim)) {
        expect(`${id} ${aim ? 'ADS' : 'hip'}: the muzzle flash is in frame at the kick peak`,
          Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && peak.tip.z < -0.1, `ndc ${ndc.x.toFixed(2)},${ndc.y.toFixed(2)}`);
      }
    }
    if (id === 'eye_of_reach') {
      const back = recoilDelta(spec, 1)[2];
      expect('eye_of_reach: the kick comes ~9 cm back toward the eye', back >= 0.085 && back <= 0.1, `${(back * 100).toFixed(1)} cm`);
    }
  }
  // Negative control: the f5fee97e flintknock kick (kick 1 = hold 0.72 plus a shot).
  {
    const k = 1, rest = weaponPose('flintknock', still(0, 0));
    const old = [...rest]; old[1] -= 0.045 * k * 0.62; old[2] -= 0.12 * k * 0.8; old[3] -= 0.045 * k; old[5] -= 0.055 * k;
    const g = grade('old', muzzleOf('flintknock', rest, 1), muzzleOf('flintknock', old, 1));
    expect('negative control: the HEAD recoil formula is caught', !(g.along < -0.03 && g.climb > 2), `along ${g.along.toFixed(3)} climb ${g.climb.toFixed(2)}`);
  }
  // Near plane: every weapon vertex stays at camera z < -0.12 at the kick peak (hip + ADS) and at draw start.
  for (const id of ['flintknock', 'blunderbuss', 'eye_of_reach']) {
    let nearest = -Infinity, where = '';
    for (const [tag, aim, drawT] of [['hip peak', 0, 1], ['ADS peak', 1, 1], ['draw start', 0, 0]]) {
      const pose = weaponPose(id, still(aim, drawT < 1 ? 0 : 1));
      const d = drawDelta(drawT);
      for (let i = 0; i < 6; i++) pose[i] += d[i];
      const root = rootOf(pose, rootScale(id, aim));
      const mesh = makeHeldWeaponMesh(id);
      mesh.rotation.y = Math.PI;
      mesh.scale.setScalar(meshScale[id] ?? 1.2);
      root.add(mesh);
      root.updateMatrixWorld(true);
      const v = V(0, 0, 0);
      mesh.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        if (id === 'eye_of_reach' && aim && (o.userData.eorHideInScope === true
          || /vm-eor-(grip|stock|barrel|butt)/.test(o.name) || /vm-eor-(grip|stock|barrel|butt)/.test(o.parent?.name ?? ''))) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.z > nearest) { nearest = v.z; where = tag; }
        }
      });
    }
    expect(`${id}: near-plane rule, every vertex z < -0.12 (kick peak hip/ADS, draw start)`, nearest < -0.12, `nearest z ${nearest.toFixed(3)} at ${where}`);
  }
  // Draw: starts MUZZLE-LOW and rotates up into line.
  for (const id of ['flintknock', 'blunderbuss', 'eye_of_reach']) {
    const aimPose = weaponPose(id, still(0, 0));
    const start = [...aimPose]; const d = drawDelta(0);
    for (let i = 0; i < 6; i++) start[i] += d[i];
    const s = rootScale(id, 0);
    const dp = pitchDeg(muzzleOf(id, start, s).fwd) - pitchDeg(muzzleOf(id, aimPose, s).fwd);
    expect(`${id}: draw starts muzzle BELOW the aim (pitch delta < -10 deg)`, dp < -10, `${dp.toFixed(1)} deg`);
    const old = [...aimPose]; old[1] -= 0.34; old[2] += 0.1; old[3] += 0.75;
    expect(`${id}: negative control (HEAD draw, +0.75 rad) is caught`,
      !(pitchDeg(muzzleOf(id, old, s).fwd) - pitchDeg(muzzleOf(id, aimPose, s).fwd) < -10));
  }
  expect('draw lands in the 220-280 ms band', VIEW_DRAW_TIME >= 0.22 && VIEW_DRAW_TIME <= 0.28, `${VIEW_DRAW_TIME} s`);
  // Slash ribbon rides the blade: same rotation sense on both diagonals, head within 35 deg of the tip at the whip.
  const screenAngle = (a, b) => {
    const pa = a.clone().project(cam), pb = b.clone().project(cam);
    return Math.atan2(pb.y - pa.y, (pb.x - pa.x) * cam.aspect);
  };
  const bladeAngle = (pose) => {
    const g = rootOf(pose, 1);
    return screenAngle(V(0, 0, 0).applyMatrix4(g.matrixWorld), V(...CUTLASS_TIP).applyMatrix4(g.matrixWorld));
  };
  const ribbonAngle = (rotZ, sx, sy) => {
    const g = new THREE.Group();
    g.position.set(0, -0.02, -0.86); g.rotation.z = rotZ; g.scale.set(sx, sy, 1); g.updateMatrixWorld(true);
    const head = V(Math.cos(SLASH_RIBBON_HALF_SPAN) * 0.62, Math.sin(SLASH_RIBBON_HALF_SPAN) * 0.62, 0).applyMatrix4(g.matrixWorld);
    return screenAngle(V(0, 0, 0).applyMatrix4(g.matrixWorld), head);
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const ribbonCase = (side, ribbonAt) => {
    let agree = 0, moved = 0, whipGap = 0, bladeSweep = 0, ribbonSweep = 0;
    let pb = null, pr = null;
    for (let p = 0.2; p <= 0.5601; p += 0.02) {
      const b = bladeAngle(cutlassSlashPose(side, p));
      const r = ribbonAt(side, p);
      if (pb !== null) {
        const db = wrap(b - pb), dr = wrap(r - pr);
        bladeSweep += db; ribbonSweep += dr;
        if (Math.abs(db) > 0.5 * DEG) { moved += 1; if (Math.sign(db) === Math.sign(dr)) agree += 1; }
      }
      if (p >= 0.26 && p <= 0.34) whipGap = Math.max(whipGap, Math.abs(wrap(r - b)) / DEG);
      pb = b; pr = r;
    }
    return { agree, moved, whipGap, bladeSweep: bladeSweep / DEG, ribbonSweep: ribbonSweep / DEG };
  };
  const shipped = (side, p) => { const rp = slashRibbonPose(side, p); return ribbonAngle(rp.rotZ, rp.scaleX, rp.scaleY); };
  const headRibbon = (side, p) => { // f5fee97e: scale(side*g, -g), rot (0.95 - 2.6q)*side, q = age/0.34
    const q = p * SLASH_SWING_TIME / 0.34; const g = 0.92 + q * 0.62;
    return ribbonAngle((0.95 - 2.6 * q) * side, side * g, -g);
  };
  for (const side of [1, -1]) {
    const r = ribbonCase(side, shipped);
    expect(`slash side ${side > 0 ? '+1' : '-1'}: ribbon sweeps the same way as the blade (every moving step, p 0.2-0.56)`,
      r.moved >= 8 && r.agree === r.moved && Math.sign(r.bladeSweep) === Math.sign(r.ribbonSweep),
      `${r.agree}/${r.moved} steps agree, blade ${r.bladeSweep.toFixed(0)} deg ribbon ${r.ribbonSweep.toFixed(0)} deg`);
    expect(`slash side ${side > 0 ? '+1' : '-1'}: ribbon head within 35 deg of the blade tip at the whip`, r.whipGap < 35, `${r.whipGap.toFixed(1)} deg`);
    const n = ribbonCase(side, headRibbon);
    expect(`slash side ${side > 0 ? '+1' : '-1'}: negative control (HEAD ribbon) is caught`,
      !(n.agree === n.moved && n.whipGap < 35), `${n.agree}/${n.moved} agree, whip gap ${n.whipGap.toFixed(0)} deg`);
  }
  // Held tools (toolPose): the axe head rides UP at rest, the chop brings it DOWN, and the haft never goes dead-on the view axis.
  {
    const T = { bob: 0, sway: 0, time: 0, firing: false, bailScoopProgress: 0, bucketFilled: false };
    const headY = (pose) => { const g = rootOf(pose, 1); return V(0, 0, -0.6).applyMatrix4(g.matrixWorld).y - V(0, 0, 0).applyMatrix4(g.matrixWorld).y; };
    const rest = toolPose('axe', T);
    expect('axe rest: the head (far -Z end) sits ABOVE the hand', headY(rest) > 0.1, `head dy ${headY(rest).toFixed(3)}`);
    const flipped = [...rest]; flipped[3] = -flipped[3];
    expect('axe: negative control (pitch sign flipped, the head-in-hand grip) is caught', !(headY(flipped) > 0.1));
    const at = (cycle) => toolPose('axe', { ...T, firing: true, time: cycle / 1.4 });
    const cocked = headY(at(0.4)), struck = headY(at(0.63));
    expect('axe chop: the strike drives the head DOWN from the cock', struck < cocked - 0.2, `cocked ${cocked.toFixed(3)} struck ${struck.toFixed(3)}`);
    let minOff = Infinity;
    for (let c = 0; c < 1; c += 0.005) {
      const g = rootOf(at(c), 1);
      const dir = V(0, 0, -1).transformDirection(g.matrixWorld);
      minOff = Math.min(minOff, Math.acos(Math.min(1, -dir.z)));
    }
    expect(`axe chop: the haft stays >= ${TOOL_MIN_OFF_AXIS} rad off the view axis all cycle`, minOff >= TOOL_MIN_OFF_AXIS - 0.01, `min ${minOff.toFixed(3)} rad`);
    for (const tool of ['compass', 'bucket', 'spyglass', 'lantern', 'axe', 'shovel']) {
      const p = toolPose(tool, T);
      expect(`${tool}: toolPose returns a finite pose in front of the eye`, p.every(Number.isFinite) && p[2] < -0.3, p.map((x) => x.toFixed(2)).join(','));
    }
  }
  const vm = src('src/client/rendering/ViewmodelController.ts');
  expect('ViewmodelController poses firearms through weaponPose, reload through reloadChoreography, draw through drawDelta',
    /weaponPose\(weaponId,/.test(vm) && /= reloadChoreography\(weaponId,/.test(vm) && /drawDelta\(this\.localViewDrawTimer\)/.test(vm)
    && !/private reloadChoreography/.test(vm) && !/0\.75 \* e \* e/.test(vm));
  expect('ViewmodelController: recoil is an impulse (no hold plateau, no inline recoilBack)',
    /recoilEnvelope\(/.test(vm) && !/kickTarget/.test(vm) && !/recoilBack/.test(vm));
  expect('ViewmodelController: slash ribbon driven by slashRibbonPose (no -grow mirror)',
    /slashRibbonPose\(r\.side/.test(vm) && !/-grow/.test(vm) && /cutlassSlashPose\(this\.cutlassSlashSide/.test(vm));
  expect('ViewmodelController: held tools posed through toolPose', /const cfg = toolPose\(tool, \{/.test(vm) && !/tool === 'compass'\n?\s*\/\//.test(vm));
}

// b2.3h (animations-13, vm:animations:3): the repair hammer and the bucket throw.
{
  const P = await import('../src/client/rendering/viewmodel/poses.ts');
  const mutate = process.env.PIRATES_BR_MUTATE_HAMMER === 'flip';
  const angle = (ph) => (mutate ? -1 : 1) * P.hammerSwingAngle(ph);
  const face = (ph) => P.hammerFacePoint(angle(ph));
  const hit = face(P.HAMMER_IMPACT_PHASE);
  const gap = hit[2] - P.REPAIR_PLANK_FACE_Z;
  expect('hammer: at impact the striking face is within 3 cm of the plank face (and not through it)', gap >= -0.002 && gap <= 0.03, `gap ${(gap * 100).toFixed(2)} cm`);
  const before = face(P.HAMMER_IMPACT_PHASE - 0.01);
  expect('hammer: the face is moving TOWARD the plank (-z) into impact, head leading', before[2] - hit[2] > 0.002, `dz over the last 1% of the blow ${((before[2] - hit[2]) * 100).toFixed(2)} cm`);
  const raised = face(0.5);
  expect('hammer: the raise cocks the head back toward the eye, well off the plank', raised[2] - P.REPAIR_PLANK_FACE_Z > 0.08, `raised gap ${(raised[2] - P.REPAIR_PLANK_FACE_Z).toFixed(3)} m`);
  let minGap = Infinity;
  for (let ph = 0; ph < 1; ph += 0.002) minGap = Math.min(minGap, face(ph)[2] - P.REPAIR_PLANK_FACE_Z);
  expect('hammer: the face never passes through the plank over a blow', minGap > -0.003, `min gap ${(minGap * 100).toFixed(2)} cm`);
  expect('hammer: blow count 2/3/4 for HOLE_REPAIR_TIME 1.6/2.4/3.2 s', [1.6, 2.4, 3.2].map(P.repairBlowsFor).join() === '2,3,4');
  let impacts = 0;
  for (let k = 0, prev = 0; k <= 400; k++) { const ph = P.repairBlowPhase(k / 400, 3); if (prev < P.HAMMER_IMPACT_PHASE && ph >= P.HAMMER_IMPACT_PHASE) impacts++; prev = ph; }
  expect('hammer: a size-2 hole gets exactly 3 impacts before progress reaches 1', impacts === 3, `${impacts} impacts`);
  const N = 12;
  expect('bucket: full and idle shows the water, empty idle does not', P.bucketWaterShown(0, true) && !P.bucketWaterShown(0, false));
  expect('bucket throw: the disc is gone once the pour starts', P.bucketWaterShown(0.95, false) && !P.bucketWaterShown(0.5, false));
  const d0 = P.bucketThrowDroplet(0, N, 1 - 0.3, false), d1 = P.bucketThrowDroplet(0, N, 1 - 0.95, false);
  expect('bucket throw: water leaves the bucket going AWAY from the eye (-z) and comes down', !!d0 && !!d1 && d1[2] < d0[2] - 0.5 && d1[1] < d0[1] + 0.2, d0 && d1 ? `z ${d0[2].toFixed(2)} -> ${d1[2].toFixed(2)}, y ${d0[1].toFixed(2)} -> ${d1[1].toFixed(2)}` : 'null droplet');
  expect('bucket throw: no water in the air on a scoop or at rest', !P.bucketThrowDroplet(0, N, 0.5, true) && !P.bucketThrowDroplet(0, N, 0, false));
  const vmSrc = readFileSync('src/client/rendering/ViewmodelController.ts', 'utf8');
  expect('ViewmodelController: repair swings the hammer pivot through hammerSwingAngle on the server blow phase',
    /hammerSwingAngle\(phase\)/.test(vmSrc) && /repairBlowPhase\(/.test(vmSrc) && /makeCarpentersHammerMesh\(0\)/.test(vmSrc));
}

// ── b3.3c STATION CONTACTS (animations-02): the two-bone IK post-solver puts
// both hands on the live grips (helm pegs, capstan knobs, cannon breech
// handles, mast rungs) on the legacy rig the balanced/high tiers draw today AND
// on the v2 male + pirate_clips.glb the cutover ships. Holders are built the way
// ShipRenderer tags them (userData.ikGrips, points in the holder's local frame).
{
  const IK = await import('../src/client/rendering/character/ikSolvers.ts');
  const expectFn = expect;
  const load = (p) => { const b = readFileSync(p); return new Promise((res, rej) => new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej)); };
  const holder = (kind, pos, rotY, points) => { const o = new THREE.Object3D(); o.position.copy(pos); o.rotation.y = rotY; o.userData[IK.IK_GRIPS_KEY] = { kind, points }; return o; };
  const ring = (n, r, y, z) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return V(Math.cos(a) * r, y + Math.sin(a) * r, z); });
  const knobs = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return V(Math.cos(a) * 0.72, 0, -Math.sin(a) * 0.72); });
  const rungs = []; for (let k = 0; k <= 8; k++) for (const x of [-0.18, 0.18]) rungs.push(V(x, 0.2 + k * 0.33, 0));
  const STATIONS = [
    // wheel: pegs on a 0.52 m ring in the holder's XY plane, 0.06 m toward the
    // helmsman; peg faces 0.56 m ahead of her (the live stand-off is the probe's job)
    ['helm', 'helm', () => holder('helm', V(0, 1.25, 0.62), Math.PI, ring(8, 0.52, 0, 0.06))],
    ['capstan', 'capstan_push', () => holder('capstan', V(0, 1.02, 1.05), 0, knobs)],
    // cannon: barrel along the pivot's +x, breech handles either side of the cascabel
    ['cannon', 'cannon_aim', () => holder('cannon', V(0, 0.9, 0.62), -Math.PI / 2, [V(-0.16, 0.1, 0.2), V(-0.16, 0.1, -0.2)])],
    ['ladder', 'climb', () => holder('ladder', V(0, 0, 0.3), 0, rungs)],
  ];
  const rigs = [
    ['legacy pirate_base', await load('public/assets/models/pirate_base.glb'), null],
    ['v2 male', await load('assets-src/quaternius/out/pirate_base_male.glb'), (await load('public/assets/models/pirate_clips.glb')).animations],
  ];
  // The legacy rig is what balanced/high draw TODAY: enforced. The v2 rows are
  // enforced the moment pirate_v2.glb ships (the D25 tripwire pattern); until
  // then they print their numbers as PENDING (v2 right arm still ~0.1 m short
  // of the side peg under its helm clip, aim_pistol palm 0.30 m: b3.2f2 handoff).
  const v2Live = existsSync('public/assets/models/pirate_v2.glb');
  const pending = (label, ok, detail = '') => console.log(`  ${ok ? '✓' : '… PENDING (v2 not shipped)'} ${label}  (${detail})`);
  for (const [rigName, gltf, clipsOverride] of rigs) {
    const expect = rigName.startsWith('v2') && !v2Live ? pending : expectFn;
    const clips = clipsOverride ?? gltf.animations;
    const body = new THREE.Group(); body.add(gltf.scene);
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const byName = (n) => gltf.scene.getObjectByName(n);
    const handBone = (s) => byName(`hand_${s}`);
    const elbowBone = (s) => byName(`lowerarm_${s}`) ?? byName(`forearm_${s}`);
    const shoulderBone = (s) => byName(`upperarm_${s}`);
    const wp = (o) => o.getWorldPosition(new THREE.Vector3());
    for (const [kind, clipName, mk] of STATIONS) {
      const clip = clips.find((c) => c.name === clipName);
      if (!clip) { expect(`${rigName} ${kind}: clip ${clipName} exists`, false); continue; }
      mixer.stopAllAction(); const act = mixer.clipAction(clip); act.reset().play();
      mixer.setTime(clip.duration * 0.5); body.updateMatrixWorld(true);
      const h = mk(); body.add(h); body.updateMatrixWorld(true);
      const clipHandR = wp(handBone('r'));
      const clipUpper = shoulderBone('r').quaternion.clone();
      // 20 frames of the real update order: restore -> mixer step -> post-solve
      let res = null;
      for (let f = 0; f < 20; f++) {
        IK.restoreContactClipPose(gltf.scene);
        mixer.update(0); body.updateMatrixWorld(true);
        res = IK.applyStationContacts(gltf.scene, body, h, 1 / 60);
      }
      const worst = Math.max(res.l, res.r);
      expect(`${rigName} ${kind}: both hands on the live grips (<= 0.08 m) after the IK post-solve`, Number.isFinite(worst) && worst <= 0.08,
        `residual l ${res.l.toFixed(3)} r ${res.r.toFixed(3)} (clip hand_r ${clipHandR.toArray().map((v) => v.toFixed(2)).join(',')})`);
      let elbowsOk = true; let det = '';
      for (const s of ['l', 'r']) {
        const sh = wp(shoulderBone(s)); const el = wp(elbowBone(s)); const ha = wp(handBone(s));
        const mid = sh.clone().add(ha).multiplyScalar(0.5);
        // down (station) or out to her own side (ladder, hands overhead); never forward/inward through the chest
        const out = (s === 'l' ? 1 : -1) * (el.x - mid.x);
        const ok = kind === 'ladder' ? out >= -0.02 : el.y <= mid.y + 0.02;
        if (!ok) elbowsOk = false;
        det += `${s}: elbow dy ${(el.y - mid.y).toFixed(3)} out ${out.toFixed(3)} hand f ${ha.z.toFixed(2)} y ${ha.y.toFixed(2)}; `;
      }
      expect(`${rigName} ${kind}: elbows bend down/out, never forward through the chest`, elbowsOk, det);
      if (kind === 'helm') {
        const ok = ['l', 'r'].every((s) => { const p = wp(handBone(s)); return p.z >= 0.45 && p.z <= 0.85 && p.y >= 1.0 && p.y <= 1.5; });
        expect(`${rigName} helm: both hands f 0.45-0.85 m, y 1.0-1.5 m`, ok, det);
      }
      IK.restoreContactClipPose(gltf.scene);
      expect(`${rigName} ${kind}: restore puts the clip pose back exactly (no compounding under a still mixer)`,
        shoulderBone('r').quaternion.angleTo(clipUpper) < 2e-3, `angle ${shoulderBone('r').quaternion.angleTo(clipUpper).toExponential(2)}`);
      body.remove(h);
    }
    // Leaving the station eases the contact out: the clip hand returns.
    const off = IK.applyStationContacts(gltf.scene, body, null, 1);
    expect(`${rigName}: no station = no hand solve`, Number.isNaN(off.l) && Number.isNaN(off.r));
    // Foot IK on the deck plane: a boot pushed 6 cm into the planking comes back onto it.
    mixer.stopAllAction(); const idle = clips.find((c) => c.name === 'idle'); mixer.clipAction(idle).reset().play(); mixer.setTime(0.1);
    IK.restoreContactClipPose(gltf.scene); body.updateMatrixWorld(true);
    // push the LOWER boot 6 cm into the planking (the deck is the body's y = 0)
    const sole0 = Math.min(...['l', 'r'].map((s) => wp(byName(`foot_${s}`)).y - 0.045));
    gltf.scene.position.y = -sole0 - 0.06; body.updateMatrixWorld(true);
    IK.applyStationContacts(gltf.scene, body, null, 1 / 60);
    const soles = ['l', 'r'].map((s) => wp(byName(`foot_${s}`)).y - 0.045);
    expect(`${rigName}: foot IK lifts both boots out of the deck (sole >= -0.01 m)`, Math.min(...soles) >= -0.01, `soles ${soles.map((v) => v.toFixed(3)).join(', ')}`);
    gltf.scene.position.y = 0; IK.restoreContactClipPose(gltf.scene);
  }
  // v2 aim_pistol, the clip itself (no station): the pistol hand is out in front on the eye line.
  for (const [rigName, g, clipsOverride] of rigs) {
    const expect = rigName.startsWith('v2') && !v2Live ? pending : expectFn;
    const clip = (clipsOverride ?? g.animations).find((c) => c.name === 'aim_pistol');
    const body = g.scene.parent;
    const m = new THREE.AnimationMixer(g.scene); m.clipAction(clip).reset().play(); m.setTime(clip.duration * 0.5); body.updateMatrixWorld(true);
    IK.applyStationContacts(g.scene, body, null, 1, 0); body.updateMatrixWorld(true);
    const hr = g.scene.getObjectByName('hand_r').getWorldPosition(new THREE.Vector3());
    const eye = g.scene.getObjectByName('head').getWorldPosition(new THREE.Vector3()).y + 0.08;
    expect(`${rigName} aim_pistol (post-solve): hand_r >= 0.35 m forward and within 0.12 m of the eye line`, hr.z >= 0.35 && Math.abs(hr.y - eye) <= 0.12,
      `hand_r f ${hr.z.toFixed(2)} y ${hr.y.toFixed(2)} eye ${eye.toFixed(2)}`);
  }
  // b3.3d (animations-08 remainder): a large look pitch splits 40/60 between the
  // chest and the head, so a pirate aiming at a crow's nest bends back from the
  // chest instead of snapping his neck, and the aimed pistol arm follows the look.
  // Real update order per pitch: restore -> mixer step -> factory head solve
  // (clipX + pitchUpToBoneX(clamp(p, +-0.5))) -> applyLookSplit -> contacts.
  const PITCHES = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];
  const fwdOf = (q) => V(0, 0, 1).applyQuaternion(q);
  const angUp = (v) => Math.atan2(v.y, v.z);
  for (const [rigName, g, clipsOverride] of rigs) {
    const expect = rigName.startsWith('v2') && !v2Live ? pending : expectFn;
    const has = typeof IK.applyLookSplit === 'function';
    if (!has) { expect(`${rigName} look split: ikSolvers exports applyLookSplit`, false, 'missing'); continue; }
    const body = g.scene.parent;
    const head = g.scene.getObjectByName('head');
    const chest = g.scene.getObjectByName('spine_02') ?? g.scene.getObjectByName('spine2');
    const m = new THREE.AnimationMixer(g.scene);
    const pose = (clipName, p, aim) => {
      const clip = (clipsOverride ?? g.animations).find((c) => c.name === clipName);
      m.stopAllAction(); m.clipAction(clip).reset().play(); m.setTime(clip.duration * 0.5);
      IK.restoreContactClipPose(g.scene); m.update(0); body.updateMatrixWorld(true);
      const hx = head.rotation.x;
      head.rotation.x = hx + pitchUpToBoneX(THREE.MathUtils.clamp(p, -0.5, 0.5));
      body.updateMatrixWorld(true);
      IK.applyLookSplit(g.scene, body, head, hx, p);
      if (aim) IK.applyStationContacts(g.scene, body, null, 1, p);
      body.updateMatrixWorld(true);
      const out = {
        hq: head.getWorldQuaternion(new THREE.Quaternion()), cq: chest.getWorldQuaternion(new THREE.Quaternion()),
        hand: g.scene.getObjectByName('hand_r').getWorldPosition(new THREE.Vector3()),
        eye: head.getWorldPosition(new THREE.Vector3()).add(V(0, 0.08, 0)),
      };
      head.rotation.x = hx; IK.restoreContactClipPose(g.scene);
      return out;
    };
    pose('idle', 0, false); // settle: the first restore drops whatever the station rows above left stashed
    const lvl = pose('idle', 0, false);
    const rows = PITCHES.map((p) => {
      const o = pose('idle', p, false);
      const gaze = angUp(fwdOf(o.hq.clone().multiply(lvl.hq.clone().invert())));
      const ch = angUp(fwdOf(o.cq.clone().multiply(lvl.cq.clone().invert())));
      return { p, gaze, ch };
    });
    const mono = rows.every((r, i) => i === 0 || r.gaze > rows[i - 1].gaze + 0.05);
    expect(`${rigName} look split: gaze rises monotonically for look pitch -0.9..+0.9 (idle)`, mono && rows[0].gaze < -0.6 && rows.at(-1).gaze > 0.6,
      rows.map((r) => `${r.p}:${r.gaze.toFixed(2)}`).join(' '));
    const big = rows.filter((r) => Math.abs(r.p) >= 0.3);
    const shareOk = big.every((r) => r.ch / r.p >= 0.35 && r.ch / r.p <= 0.45);
    expect(`${rigName} look split: the chest takes 0.35-0.45 of the pitch, same sign`, shareOk,
      big.map((r) => `${r.p}:${(r.ch / r.p).toFixed(2)}`).join(' '));
    const zero = rows.find((r) => r.p === 0);
    expect(`${rigName} look split: level look leaves the chest and head on the clip`, Math.abs(zero.ch) < 1e-3 && Math.abs(zero.gaze) < 1e-3,
      `chest ${zero.ch.toExponential(1)} gaze ${zero.gaze.toExponential(1)}`);
    // restore after the split puts the chest back exactly (the stash, no compounding)
    const c0 = chest.quaternion.clone();
    for (let f = 0; f < 5; f++) { IK.applyLookSplit(g.scene, body, head, head.rotation.x, 0.8); IK.restoreContactClipPose(g.scene); }
    expect(`${rigName} look split: restore returns the chest to the clip (no compounding over 5 frames)`, chest.quaternion.angleTo(c0) < 1e-4,
      `angle ${chest.quaternion.angleTo(c0).toExponential(2)}`);
    // The aimed pistol arm bends with the look: hand_r rises with pitch and stays on the eye line.
    const aims = [-0.6, 0, 0.6].map((p) => ({ p, ...pose('aim_pistol', p, true) }));
    const rise = aims[2].hand.y > aims[1].hand.y + 0.1 && aims[1].hand.y > aims[0].hand.y + 0.1;
    expect(`${rigName} aim_pistol: hand_r rises with the look pitch (-0.6 < 0 < +0.6)`, rise, aims.map((a) => `${a.p}:${a.hand.y.toFixed(2)}`).join(' '));
    const lineRes = (a) => { const d = V(0, Math.sin(a.p), Math.cos(a.p)); const r = a.hand.clone().sub(a.eye); r.x = 0; return r.sub(d.multiplyScalar(r.dot(d))).length(); };
    expect(`${rigName} aim_pistol: hand_r within 0.12 m of the eye line at every pitch`, aims.every((a) => lineRes(a) <= 0.12),
      aims.map((a) => `${a.p}:${lineRes(a).toFixed(3)}`).join(' '));
  }
}

// ── b3.3e CAMERA-SIDE AND INPUT (vm:animations:4/5/6): the view rolls with the
// deck it stands on, a footfall and a landing move the eye DOWN, the spyglass
// sways around its target, every look device agrees on "right" and "up", and
// the sail's belly is on the lee side of the apparent wind.
console.log('\nb3.3e camera side: deck roll, head bob, landing dip, spyglass sway');
{
  const CM = await import('../src/client/core/cameraMotion.ts');
  const gameSrc = src('src/client/core/Game.ts');
  // Deck roll: the lens up must stand on the drawn deck normal, at any look yaw.
  const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 100);
  const imageAngle = (camQ, n) => {
    const f = V(0, 0, -1).applyQuaternion(camQ);
    const up = V(0, 1, 0).applyQuaternion(camQ);
    const np = n.clone().sub(f.clone().multiplyScalar(n.dot(f))).normalize();
    return Math.atan2(up.clone().cross(np).dot(f), up.dot(np));
  };
  let worst = 0; let headAft = 0; let headFwd = 0; let cases = 0; let aftSign = 0;
  for (const shipYaw of [0.3, 1.9, -2.4]) {
    for (const [roll, pitch] of [[0.3, 0], [-0.3, 0], [0.2, 0.12], [-0.25, -0.1], [0, 0.15]]) {
      const pose = { position: { x: 0, y: 0, z: 0 }, rotation: shipYaw, pitch, roll };
      const o = toShipWorld3({ x: 0, y: 0, z: 0 }, pose); const u = toShipWorld3({ x: 0, y: 1, z: 0 }, pose);
      const n = V(u.x - o.x, u.y - o.y, u.z - o.z).normalize();
      for (let k = 0; k < 8; k++) {
        const rel = (k * Math.PI) / 4; const yaw = shipYaw + rel;
        for (const lp of [-0.4, 0, 0.4]) {
          cam.position.set(0, 0, 0); cam.quaternion.identity();
          cam.lookAt(Math.sin(yaw) * Math.cos(lp), Math.sin(lp), Math.cos(yaw) * Math.cos(lp));
          const q0 = cam.quaternion.clone();
          const a = CM.deckCameraRoll(q0, n);
          cam.rotateZ(a);
          const err = Math.abs(imageAngle(cam.quaternion, n));
          worst = Math.max(worst, err); cases += 1;
          const tilt = Math.abs(imageAngle(q0, n));
          const head = q0.clone(); cam.quaternion.copy(head); cam.rotateZ(-roll);
          const headErr = Math.abs(imageAngle(cam.quaternion, n));
          if (k === 4 && pitch === 0 && lp === 0) { headAft = Math.max(headAft, headErr - tilt); aftSign += Math.sign(a) === Math.sign(-roll) ? 0 : 1; }
          if (k === 0 && pitch === 0 && lp === 0) headFwd = Math.max(headFwd, headErr);
        }
      }
    }
  }
  expect(`deck roll: the lens up stands on the drawn deck normal at 8 look yaws x 3 pitches x 5 attitudes (${cases} cases, <= 0.01 rad)`,
    worst <= 0.01, `worst ${worst.toFixed(4)} rad`);
  expect('deck roll: looking aft the roll is the OPPOSITE sign of the bow-view roll (heel follows the view)', aftSign >= 6, `${aftSign}/6 aft cases flipped`);
  expect('negative control: HEAD -hull.roll matches at the bow but rolls AGAINST the heel facing aft',
    headFwd < 0.02 && headAft > 0.2, `bow err ${headFwd.toFixed(3)} aft extra err ${headAft.toFixed(3)}`);
  expect('Game rolls the view with deckCameraRoll (no bare -hull.roll)',
    /deckCameraRoll\(/.test(gameSrc) && !/clamp\(-hull\.roll/.test(gameSrc));

  // Head bob: lowest on the audible footfall, never above the standing eye.
  const bobs = []; for (let i = 0; i <= 40; i++) bobs.push(CM.headBobOffset(i / 40, 5, 5));
  const minAt = bobs.indexOf(Math.min(...bobs)) / 40;
  expect('head bob: never lifts the eye above standing (<= 0 over the stride)', bobs.every((b) => b <= 1e-9), `max ${Math.max(...bobs).toFixed(4)}`);
  expect('head bob: the eye is lowest ON the footfall (stride 0 or 1) and level mid-stride',
    (minAt === 0 || minAt === 1) && Math.abs(CM.headBobOffset(0.5, 5, 5)) < 1e-6 && CM.headBobOffset(0, 5, 5) < -0.01,
    `min at ${minAt} depth ${CM.headBobOffset(0, 5, 5).toFixed(3)} m`);
  expect('head bob: standing still does not bob; a crouch-walk bobs less than a run',
    CM.headBobOffset(0, 0, 5) === 0 && Math.abs(CM.headBobOffset(0, 2.75, 5)) < Math.abs(CM.headBobOffset(0, 5, 5)));
  expect('Game bobs the eye on the footstep stride clock', /headBobOffset\(/.test(gameSrc) && /FOOTSTEP_STRIDE_M/.test(gameSrc));

  // Landing dip: the knees take the fall, the eye drops then recovers.
  const dips = []; for (let i = 0; i <= 60; i++) dips.push(CM.landingDipOffset(i * 0.01, 9));
  const peakI = dips.indexOf(Math.min(...dips));
  expect('landing dip: the eye goes DOWN (<= 0 at every age) and the dip is real (>= 8 cm at 9 m/s)',
    dips.every((d) => d <= 1e-9) && Math.min(...dips) <= -0.08, `peak ${Math.min(...dips).toFixed(3)} m`);
  expect('landing dip: bottoms out within 0.12 s and is back within 5% by 0.6 s',
    peakI * 0.01 <= 0.12 && Math.abs(dips[60]) < 0.05 * Math.abs(dips[peakI]), `peak at ${(peakI * 0.01).toFixed(2)} s, 0.6 s ${dips[60].toFixed(4)}`);
  expect('landing dip: a harder fall dips deeper; a step off (<= 3 m/s) does not dip',
    CM.landingDipOffset(0.07, 12) < CM.landingDipOffset(0.07, 6) && CM.landingDipOffset(0.07, 3) === 0);
  expect('Game dips the eye on the local landing thud', /landingDipOffset\(/.test(gameSrc));

  // Spyglass sway: breathes AROUND the target, never drifts off it.
  let sy = 0; let sp = 0; let peak = 0; let n = 0; const s = { yaw: 0, pitch: 0 };
  const T = Math.PI * 2 * 10;
  for (let t = 0; t < T; t += 0.01) { CM.spyglassSway(t, false, s); sy += s.yaw; sp += s.pitch; peak = Math.max(peak, Math.hypot(s.yaw, s.pitch)); n += 1; }
  const bias = Math.hypot(sy / n, sp / n);
  expect('spyglass sway: zero-mean over its window (bias < 5% of the amplitude)', bias < 0.05 * CM.SPYGLASS_SWAY_RAD, `bias ${bias.toExponential(2)} rad`);
  expect('spyglass sway: alive but bounded (0.4-1.0 x SPYGLASS_SWAY_RAD)', peak >= 0.4 * CM.SPYGLASS_SWAY_RAD && peak <= CM.SPYGLASS_SWAY_RAD * 1.001,
    `peak ${peak.toExponential(2)} rad`);
  CM.spyglassSway(1.3, true, s); const crouchA = Math.hypot(s.yaw, s.pitch); CM.spyglassSway(1.3, false, s);
  expect('spyglass sway: crouching steadies the glass', crouchA < Math.hypot(s.yaw, s.pitch));
  expect('Game sways the scoped view with spyglassSway', /spyglassSway\(/.test(gameSrc));
}

console.log('\nb3.3e look devices: stick and touch look signs, per-scheme invert-Y');
{
  const listeners = new Map();
  const add = (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
  const body = { addEventListener: add, requestPointerLock: () => undefined };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { body, activeElement: null, pointerLockElement: null, visibilityState: 'visible', exitPointerLock: () => {}, addEventListener: add };
  globalThis.window = { addEventListener: add, location: { search: '' } };
  try {
    const { InputManager } = await import('../src/client/input/InputManager.ts');
    const { lookStep } = await import('../src/client/input/GamepadSource.ts');
    const input = new InputManager();
    input.init(body);
    input.setPlayContext('foot');
    const fwd = () => { const y = input.getYaw(); const p = input.getPitch(); return V(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)); };
    // Game's camera: lookAt(forward) with world up, so screen right = forward x up.
    const move = (fn) => { input.setLook(0.7, 0); const f0 = fwd(); const right = f0.clone().cross(V(0, 1, 0)).normalize(); fn(); const f1 = fwd(); return { right: f1.clone().sub(f0).dot(right), up: f1.y - f0.y }; };
    const pad = (x, y) => move(() => { const st = lookStep(x, y, 1 / 30); input.applyPadLook(st.dx, st.dy); });
    const touch = (dx, dy) => move(() => input.applyTouchLook(dx, dy));
    const mouse = (dx, dy) => move(() => input['applyLookDelta'](dx, dy));
    input.applyControlSettings({ invertY: { mouse: false, gamepad: false, touch: false } });
    const pr = pad(1, 0); const pu = pad(0, -1); const tr = touch(40, 0); const tu = touch(0, -40); const mr = mouse(40, 0); const mu = mouse(0, -40);
    expect('stick right turns the view right; stick up (axes[3] < 0) raises the gaze', pr.right > 0.01 && Math.abs(pr.up) < 1e-9 && pu.up > 0.01,
      `right ${pr.right.toFixed(3)} up ${pu.up.toFixed(3)}`);
    expect('touch drag right turns right; drag up raises the gaze (same as the mouse)', tr.right > 0.01 && tu.up > 0.01 && mr.right > 0.01 && mu.up > 0.01,
      `touch r ${tr.right.toFixed(3)} u ${tu.up.toFixed(3)} mouse r ${mr.right.toFixed(3)} u ${mu.up.toFixed(3)}`);
    input.applyControlSettings({ invertY: { mouse: false, gamepad: true, touch: false } });
    const ipu = pad(0, -1); const ipr = pad(1, 0); const tuPad = touch(0, -40); const muPad = mouse(0, -40);
    expect('invert-Y (gamepad): stick up LOWERS the gaze, yaw untouched, touch and mouse unaffected',
      ipu.up < -0.01 && ipr.right > 0.01 && tuPad.up > 0.01 && muPad.up > 0.01, `pad up ${ipu.up.toFixed(3)} touch up ${tuPad.up.toFixed(3)}`);
    input.applyControlSettings({ invertY: { mouse: false, gamepad: false, touch: true } });
    const itu = touch(0, -40); const itr = touch(40, 0); const puTouch = pad(0, -1);
    expect('invert-Y (touch): drag up LOWERS the gaze, yaw untouched, the stick unaffected',
      itu.up < -0.01 && itr.right > 0.01 && puTouch.up > 0.01, `touch up ${itu.up.toFixed(3)} pad up ${puTouch.up.toFixed(3)}`);
  } finally {
    globalThis.document = saved.document; globalThis.window = saved.window;
  }
}

console.log('\nb3.3e sail belly vs the apparent wind (the contract the b4 cloth inherits)');
{
  const { makeBillowedSailGeometry } = await import('../src/client/rendering/ship/geometry.ts');
  const { braceCatch } = await import('../src/shared/sailing.ts');
  const g = makeBillowedSailGeometry(6, 8, 10, 7);
  const zs = g.attributes.position.array.filter((_, i) => i % 3 === 2);
  const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  expect('square sail geometry bellies toward its local +Z (the face the trim pivot turns to the wind)', meanZ > 0.05, `mean z ${meanZ.toFixed(3)} m`);
  let worst = 1; let cases = 0;
  for (let h = 0; h < 8; h++) {
    const shipRot = -Math.PI + (h * Math.PI) / 4 + 0.2;
    for (const offWind of [0.9, 1.4, 2.0, 2.6, 3.0, -1.2, -1.9, -2.7]) {
      // offWind = where the wind blows FROM relative to the bow; direction is where it blows TO.
      const windDir = shipRot + offWind + Math.PI;
      const signedRelative = Math.atan2(Math.sin(windDir - shipRot), Math.cos(windDir - shipRot));
      let best = -1; let brace = 0;
      for (let a = -1.5; a <= 1.5; a += 0.01) { const c = braceCatch(a, signedRelative); if (c > best) { best = c; brace = a; } }
      if (best < 0.3) continue;
      const spd = 6; const aw = apparentWindLocal(windDir, 0.9, shipRot, Math.sin(shipRot) * spd, Math.cos(shipRot) * spd);
      const ship = new THREE.Object3D(); ship.rotation.y = shipRot;
      const pivot = new THREE.Object3D(); pivot.rotation.y = THREE.MathUtils.clamp(brace, -1.15, 1.15); ship.add(pivot);
      const sail = new THREE.Object3D(); sail.rotation.order = 'YXZ'; sail.rotation.x = 0.055; pivot.add(sail);
      ship.updateMatrixWorld(true);
      const belly = V(0, 0, 1).transformDirection(sail.matrixWorld);
      const app = V(Math.sin(shipRot + aw.localYaw), 0, Math.cos(shipRot + aw.localYaw));
      worst = Math.min(worst, belly.dot(app)); cases += 1;
    }
  }
  expect(`drawing sails belly to leeward of the apparent wind (belly . apparent > 0) at 8 headings (${cases} trimmed cases)`, cases >= 30 && worst > 0,
    `worst ${worst.toFixed(3)}`);
}

const ms = performance.now() - t0;
console.log(`\n${checks - failures}/${checks} checks, ${ms.toFixed(0)} ms`);
if (failures) { console.error(`FAIL: ${failures} inversion check(s)`); process.exit(1); }
console.log('PASS: nothing inverted (wheel, flag, foliage, heel, head pitch, new-skeleton knees/elbows/head on 3 bodies, low-tier e2e, viewmodel recoil/ribbon/draw, deck roll, head bob, landing dip, spyglass sway, stick/touch look + invert-Y, sail belly)');
