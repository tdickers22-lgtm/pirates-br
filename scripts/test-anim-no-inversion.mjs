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

const ms = performance.now() - t0;
console.log(`\n${checks - failures}/${checks} checks, ${ms.toFixed(0)} ms`);
if (failures) { console.error(`FAIL: ${failures} inversion check(s)`); process.exit(1); }
console.log('PASS: nothing inverted (wheel, flag, foliage, heel, head pitch, viewmodel recoil/ribbon/draw)');
