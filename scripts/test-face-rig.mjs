#!/usr/bin/env node
// test-face-rig (b3.2g, characters-04): the face rig in src/client/rendering/character/faceRig.ts.
//
//   node --import tsx scripts/test-face-rig.mjs
//
// Rows:
//  1. Clamps: eye yaw never past +-0.5, pitch never past +-0.35, whatever the want or the head rate.
//  2. Sign: a target ABOVE raises eye pitch, a target to +X turns eye yaw +, in the pure maths AND
//     on real bones (a head/eye chain with non-identity glTF-style rest frames, head yawed 0.4 rad:
//     the eye's gaze vector gains +Y for pitch up and stays relative to the head).
//  3. Lead: eyes aim where the head's own turn will be 80 ms later (head turning 2 rad/s -> +0.16).
//  4. Blink schedule over 50 seeded pirates x 10 min at 60 fps: single gaps 2.12-6.12 s start to
//     start, each blink shut for 120 ms (+-1 frame) with a fully shut frame, doubles 10 % +-3 % with a
//     0.2 s gap, never a triple; two pirates never share a schedule; dead = shut, every frame.
//  5. Lids on bones: closure 1 turns lid_upper_* about local +X by extras.closeDeg exactly, 0 = bind.
//  6. Jaw: 0 before an edge, 0.2 rad held, back to 0 by 0.36 s; the jaw bone follows.
//  7. Gaze target: nearest pirate inside 8 m, never self, nothing past 8 m.
//  8. Contract with the asset: pirate_base_<body>.glb (assets-src out) carries eye_l/eye_r and
//     lid_upper_l/lid_upper_r joints with a closeDeg extra, and attachFaceRig finds all four on a
//     skeleton with those names; a v1-style skeleton without them gets null (no-op).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {
  FACE, eyeAngles, dirToYawPitch, makeBlink, stepBlink, jawOpen, nearestWithin,
  attachFaceRig, applyFace, updateFaceRig, triggerJaw,
} from '../src/client/rendering/character/faceRig.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function expect(label, ok, detail = '') {
  if (ok) { passes += 1; console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`); }
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. clamps ──────────────────────────────────────────────────────────────
console.log('1. clamps');
{
  let maxYaw = 0, maxPitch = 0;
  for (let i = 0; i < 2000; i++) {
    const w = { yaw: (i % 97) / 97 * 6.2 - 3.1, pitch: (i % 53) / 53 * 3 - 1.5 };
    const h = { yaw: (i % 31) / 31 * 1.2 - 0.6, pitch: (i % 17) / 17 - 0.5 };
    const r = { yaw: (i % 13) * 3 - 18, pitch: (i % 7) * 3 - 9 };
    const e = eyeAngles(w, h, r);
    maxYaw = Math.max(maxYaw, Math.abs(e.yaw));
    maxPitch = Math.max(maxPitch, Math.abs(e.pitch));
  }
  expect('eye |yaw| <= 0.5 over 2,000 wants/heads/rates', maxYaw <= FACE.EYE_YAW_MAX + 1e-12 && near(maxYaw, 0.5), `max ${maxYaw.toFixed(4)}`);
  expect('eye |pitch| <= 0.35 over 2,000 wants/heads/rates', maxPitch <= FACE.EYE_PITCH_MAX + 1e-12 && near(maxPitch, 0.35), `max ${maxPitch.toFixed(4)}`);
  expect('spec constants: yaw 0.5, pitch 0.35, lead 80 ms, range 8 m', FACE.EYE_YAW_MAX === 0.5 && FACE.EYE_PITCH_MAX === 0.35 && FACE.EYE_LEAD_S === 0.08 && FACE.LOOK_RANGE_M === 8);
  const wrapE = eyeAngles({ yaw: 3.0, pitch: 0 }, { yaw: -3.0, pitch: 0 });
  expect('yaw difference wraps (3.0 vs -3.0 is 0.28 rad, not 6 rad clamped)', near(wrapE.yaw, 6 - 2 * Math.PI, 1e-9), `yaw ${wrapE.yaw.toFixed(4)}`);
}

// ── 2. sign ────────────────────────────────────────────────────────────────
console.log('2. sign');
{
  const up = dirToYawPitch({ x: 0, y: 0.8, z: 3 });
  const e = eyeAngles(up, { yaw: 0, pitch: 0 });
  expect('target above -> eye pitch > 0', e.pitch > 0.2, `pitch ${e.pitch.toFixed(3)}`);
  const down = eyeAngles(dirToYawPitch({ x: 0, y: -0.8, z: 3 }), { yaw: 0, pitch: 0 });
  expect('target below -> eye pitch < 0', down.pitch < -0.2, `pitch ${down.pitch.toFixed(3)}`);
  const side = eyeAngles(dirToYawPitch({ x: 1, y: 0, z: 3 }), { yaw: 0, pitch: 0 });
  expect('target to +X -> eye yaw > 0 (same sign as rotation.y / player yaw)', side.yaw > 0.2, `yaw ${side.yaw.toFixed(3)}`);
  const headUp = eyeAngles(up, { yaw: 0, pitch: up.pitch });
  expect('head already pitched onto the target -> eyes centred', near(headUp.pitch, 0, 1e-9));

  // Bones: root -> head (rest rotated like a glTF UE skeleton) -> eye_l (own rest roll).
  const root = new THREE.Group();
  const head = new THREE.Bone(); head.name = 'head';
  head.quaternion.setFromEuler(new THREE.Euler(-1.2, 0.3, 1.57, 'XYZ'));
  head.position.set(0, 1.5, 0);
  const eye = new THREE.Bone(); eye.name = 'eye_l';
  eye.quaternion.setFromEuler(new THREE.Euler(0.4, -0.7, 0.2, 'XYZ'));
  eye.position.set(0.03, 0.1, 0.08);
  root.add(head); head.add(eye);
  const face = attachFaceRig(root, 1);
  expect('attachFaceRig finds an eye on a bare head/eye chain', !!face && face.eyes.length === 1);
  root.updateMatrixWorld(true);
  const restWorld = eye.getWorldQuaternion(new THREE.Quaternion());
  // The eye-local vector that points model +Z (forward) at rest.
  const fwdLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(restWorld.clone().invert());
  const gaze = () => { root.updateMatrixWorld(true); return fwdLocal.clone().applyQuaternion(eye.getWorldQuaternion(new THREE.Quaternion())); };
  applyFace(face, 0, 0.3, 0, 0);
  const gUp = gaze();
  expect('bones: eye pitch +0.3 -> gaze gains +Y by sin 0.3', near(gUp.y, Math.sin(0.3), 1e-6) && gUp.z > 0.9, `gaze ${gUp.toArray().map((v) => v.toFixed(3))}`);
  applyFace(face, 0.4, 0, 0, 0);
  const gSide = gaze();
  expect('bones: eye yaw +0.4 -> gaze toward +X by sin 0.4', near(gSide.x, Math.sin(0.4), 1e-6) && near(gSide.y, 0, 1e-6), `gaze ${gSide.toArray().map((v) => v.toFixed(3))}`);
  applyFace(face, 0, 0, 0, 0);
  expect('bones: 0/0 restores the bind quaternion', face.eyes[0].bone.quaternion.angleTo(face.eyes[0].rest) < 1e-6);
  // Head-relative: yaw the head 0.4 rad about MODEL up, then eye pitch up: the gaze follows the head.
  const headRest = head.quaternion.clone();
  head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4));
  applyFace(face, 0, 0.3, 0, 0);
  const gRel = gaze();
  expect('bones: pitch stays up with the head yawed 0.4 (gaze x = sin0.4 cos0.3, y = sin0.3)',
    near(gRel.y, Math.sin(0.3), 1e-6) && near(gRel.x, Math.sin(0.4) * Math.cos(0.3), 1e-6), `gaze ${gRel.toArray().map((v) => v.toFixed(3))}`);
  head.quaternion.copy(headRest);
}

// ── 3. lead ────────────────────────────────────────────────────────────────
console.log('3. lead');
{
  const e = eyeAngles({ yaw: 0.2, pitch: 0 }, { yaw: 0.2, pitch: 0 }, { yaw: 2, pitch: -1 });
  expect('head turning +2 rad/s -> eyes lead +0.16 rad', near(e.yaw, 0.16, 1e-9), `yaw ${e.yaw}`);
  expect('head pitching -1 rad/s -> eyes lead -0.08 rad', near(e.pitch, -0.08, 1e-9), `pitch ${e.pitch}`);
  const still = eyeAngles({ yaw: 0.2, pitch: 0 }, { yaw: 0.2, pitch: 0 });
  expect('head still -> no lead', still.yaw === 0 && still.pitch === 0);
}

// ── 4. blink schedule ──────────────────────────────────────────────────────
console.log('4. blink schedule');
{
  const dt = 1 / 60;
  let singles = [], doubleGaps = [], shutDur = [], peaks = [], firstBlinks = 0, doubles = 0, triples = 0;
  const schedules = new Set();
  for (let seed = 1; seed <= 50; seed++) {
    const s = makeBlink(seed * 2654435761);
    const starts = [];
    let prev = 0, runStart = -1, runPeak = 0;
    for (let f = 0; f < 60 * 600; f++) {
      const c = stepBlink(s, dt);
      if (c > 0 && prev === 0) { starts.push(f * dt); runStart = f; runPeak = 0; }
      if (c > 0) runPeak = Math.max(runPeak, c);
      if (c === 0 && prev > 0) { shutDur.push((f - runStart) * dt); peaks.push(runPeak); }
      prev = c;
    }
    schedules.add(starts.slice(0, 5).map((t) => t.toFixed(3)).join(','));
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      if (gap < 0.5) {
        doubleGaps.push(gap);
        if (i >= 2 && starts[i - 1] - starts[i - 2] < 0.5) triples += 1;
      } else singles.push(gap);
    }
    // Count pairs: a blink starting < 0.5 s after the previous is the second of a double.
    for (let i = 0; i < starts.length; i++) {
      const isSecond = i > 0 && starts[i] - starts[i - 1] < 0.5;
      if (!isSecond) { firstBlinks += 1; if (i + 1 < starts.length && starts[i + 1] - starts[i] < 0.5) doubles += 1; }
    }
  }
  const minS = Math.min(...singles), maxS = Math.max(...singles);
  expect('single gaps start-to-start inside 2.0-6.2 s (2-6 s wait + 120 ms)', minS >= 2.0 && maxS <= 6.2, `${minS.toFixed(3)}-${maxS.toFixed(3)} s over ${singles.length}`);
  expect('gaps really spread over the band (min < 2.4, max > 5.8)', minS < 2.4 && maxS > 5.8);
  const dMin = Math.min(...shutDur), dMax = Math.max(...shutDur);
  expect('each blink shut 120 ms +-1 frame', dMin >= 0.12 - 1 / 60 - 1e-9 && dMax <= 0.12 + 1 / 60 + 1e-9, `${(dMin * 1000).toFixed(1)}-${(dMax * 1000).toFixed(1)} ms over ${shutDur.length}`);
  expect('every blink shows a fully shut frame at 60 fps (peak >= 0.999)', Math.min(...peaks) >= 0.999, `min peak ${Math.min(...peaks).toFixed(3)}`);
  const frac = doubles / firstBlinks;
  expect('10 % +-3 % of blinks come as a pair', frac >= 0.07 && frac <= 0.13, `${doubles}/${firstBlinks} = ${(frac * 100).toFixed(1)} %`);
  const gMin = Math.min(...doubleGaps), gMax = Math.max(...doubleGaps);
  expect('double gap 0.2 s +-1 frame', gMin >= 0.2 - 1 / 60 - 1e-9 && gMax <= 0.2 + 1 / 60 + 1e-9, `${gMin.toFixed(3)}-${gMax.toFixed(3)} s`);
  expect('never a triple', triples === 0, `${triples}`);
  expect('50 pirates, 50 different schedules', schedules.size === 50, `${schedules.size}`);
  const dead = makeBlink(7);
  let allShut = true;
  for (let f = 0; f < 600; f++) if (stepBlink(dead, dt, true) !== 1) allShut = false;
  expect('dead: lids shut on every frame', allShut);
}

// ── 5. lids on bones ───────────────────────────────────────────────────────
console.log('5. lids');
{
  const root = new THREE.Group();
  const head = new THREE.Bone(); head.name = 'head'; root.add(head);
  const lids = ['lid_upper_l', 'lid_upper_r'].map((n, i) => {
    const b = new THREE.Bone(); b.name = n;
    b.quaternion.setFromEuler(new THREE.Euler(0.3 * (i + 1), 0.5, -0.2));
    b.userData.closeDeg = 50.49;
    head.add(b); return b;
  });
  const face = attachFaceRig(root, 3);
  expect('attachFaceRig finds both lids and reads closeDeg', !!face && face.lids.length === 2 && near(face.lids[0].closeRad, THREE.MathUtils.degToRad(50.49), 1e-9));
  applyFace(face, 0, 0, 1, 0);
  const rest0 = face.lids[0].rest;
  const delta = rest0.clone().invert().multiply(lids[0].quaternion);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
  const axis = new THREE.Vector3(delta.x, delta.y, delta.z).normalize();
  expect('closure 1 turns the lid by closeDeg about local +X (positive = closes)', near(THREE.MathUtils.radToDeg(ang), 50.49, 1e-6) && axis.x > 0.999999 && delta.x > 0, `${THREE.MathUtils.radToDeg(ang).toFixed(3)} deg about ${axis.toArray().map((v) => v.toFixed(3))}`);
  applyFace(face, 0, 0, 0, 0);
  expect('closure 0 = bind pose', lids.every((b, i) => b.quaternion.angleTo(face.lids[i].rest) < 1e-6));
  const noExtra = new THREE.Group(); const hb = new THREE.Bone(); hb.name = 'lid_upper_l'; noExtra.add(hb);
  const f2 = attachFaceRig(noExtra, 1);
  expect('no closeDeg extra -> 45 deg fallback', near(f2.lids[0].closeRad, THREE.MathUtils.degToRad(45), 1e-9));
  // Dead through updateFaceRig: shut and eyes centred.
  updateFaceRig(face, 1 / 60, { yaw: 0.4, pitch: 0.3 }, { yaw: 0, pitch: 0 }, true);
  expect('updateFaceRig(dead) shuts the lids', face.last.closure === 1 && face.last.eyeYaw === 0);
}

// ── 6. jaw ─────────────────────────────────────────────────────────────────
console.log('6. jaw');
{
  expect('no edge -> jaw shut', jawOpen(-1) === 0);
  expect('jaw fully open 0.2 rad through the hold', near(jawOpen(0.06), 0.2) && near(jawOpen(0.12), 0.2));
  expect('jaw shut again by 0.36 s', jawOpen(0.3601) === 0 && jawOpen(0.25) > 0);
  const root = new THREE.Group();
  const jaw = new THREE.Bone(); jaw.name = 'jaw'; root.add(jaw);
  const eye = new THREE.Bone(); eye.name = 'eye_l'; root.add(eye);
  const face = attachFaceRig(root, 9);
  triggerJaw(face);
  let peak = 0;
  for (let f = 0; f < 30; f++) { updateFaceRig(face, 1 / 60, { yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }, false); peak = Math.max(peak, face.last.jaw); }
  expect('swing/hit edge opens the jaw bone and it closes again', near(peak, 0.2, 1e-9) && face.last.jaw === 0 && face.jawAge === -1 && jaw.quaternion.angleTo(face.jaw.rest) < 1e-6, `peak ${peak.toFixed(3)}`);
}

// ── 7. gaze target ─────────────────────────────────────────────────────────
console.log('7. gaze target');
{
  const self = { x: 0, y: 0, z: 0 };
  const others = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 3, y: 1, z: 1 }, { x: 8.5, y: 0, z: 0 }];
  const t = nearestWithin(self, others);
  expect('nearest pirate inside 8 m, never self', t === others[2]);
  expect('nobody inside 8 m -> null', nearestWithin(self, [{ x: 8.5, y: 0, z: 0 }, { x: 0, y: 0, z: -9 }]) === null);
}

// ── 8. asset contract ──────────────────────────────────────────────────────
console.log('8. asset contract');
{
  const readGlbJson = (file) => {
    const buf = readFileSync(file);
    const len = buf.readUInt32LE(12);
    return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  };
  for (const body of ['male', 'female', 'stout']) {
    const file = path.join(ROOT, `assets-src/quaternius/out/pirate_base_${body}.glb`);
    if (!existsSync(file)) { expect(`${body}: ${path.relative(ROOT, file)} exists`, false); continue; }
    const gltf = readGlbJson(file);
    const joints = new Set((gltf.skins ?? []).flatMap((s) => s.joints));
    const byName = new Map(gltf.nodes.map((n, i) => [n.name, { n, i }]));
    const face = ['eye_l', 'eye_r', 'lid_upper_l', 'lid_upper_r'].map((n) => byName.get(n));
    expect(`${body}: eye_l, eye_r, lid_upper_l, lid_upper_r are skin joints`, face.every((x) => x && joints.has(x.i)));
    const deg = face.slice(2).map((x) => Number(x?.n.extras?.closeDeg));
    expect(`${body}: both lids carry extras.closeDeg in 30-70 deg`, deg.every((d) => d >= 30 && d <= 70), deg.join(', '));
  }
  const v1 = new THREE.Group();
  for (const n of ['hips', 'spine1', 'head', 'foot_l']) { const b = new THREE.Bone(); b.name = n; v1.add(b); }
  expect('v1 skeleton (no eye/lid bones) -> attachFaceRig null, rig face is a no-op', attachFaceRig(v1, 1) === null);
}

console.log(`\ntest-face-rig: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
