#!/usr/bin/env node
// test-anim-locomotion — lane b3.3b (animations-07, vm:liveplay:7).
//
// The locomotion blend space on the v2 skeleton (pirate_base_male.glb bound BY
// NAME to the shipped pirate_clips.glb library), driven exactly as the rig
// drives it: locomotionFacing picks the remote body's yaw, bodyLocal turns the
// world velocity into (fwd, side), stepLocomotion sets weights, the shared phase
// and every action's time, and a real THREE.AnimationMixer evaluates the pose.
//
// For 1..5 m/s in 8 world directions relative to the look (yaw 0):
//  - the STANCE foot (the lower boot, same boot on both ends of the step) is
//    planted: its world velocity averaged over 2 s is <= 12% of the body speed
//    (i.e. the stride-matched foot speed is within 12% of the body speed);
//  - the stance foot moves AGAINST the travel relative to the body;
//  - a backpedal (travel in the body's rear hemisphere) never carries weight on
//    a forward clip, and at 1-3 m/s straight back the body DOES backpedal
//    (keeps facing the look) instead of turning round;
//  - the timeScale stays in 0.6-1.6 and phase is shared (a walk->run cross-fade
//    keeps one phase).
//
//   node --import tsx scripts/test-anim-locomotion.mjs
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  buildLocoSet, registerLocoClips, locomotionFacing, bodyLocal, stepLocomotion, newLocoState, pickLocomotion,
  TS_MIN, TS_MAX,
} from '../src/client/rendering/character/locomotion.ts';

let failed = 0; let passed = 0;
function expect(label, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}
const loadGlb = async (p) => {
  const b = readFileSync(new URL(`../${p}`, import.meta.url));
  return new Promise((res, rej) => new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej));
};

const t0 = performance.now();
const clips = (await loadGlb('public/assets/models/pirate_clips.glb')).animations;
const scene = (await loadGlb('assets-src/quaternius/out/pirate_base_male.glb')).scene;
const set = buildLocoSet(scene, clips);
registerLocoClips(scene, clips, new Map());
const byName = Object.fromEntries(set.map((c) => [c.name, c]));
for (const n of ['walk', 'run', 'sprint', 'walk_back', 'run_back', 'strafe_l', 'strafe_r']) {
  expect(`blend space has a measured ${n} sample`, !!byName[n] && !byName[n].reverse && byName[n].speed > 0.3,
    byName[n] ? `dir ${(byName[n].dir * 180 / Math.PI).toFixed(0)} deg, ${byName[n].speed.toFixed(2)} m/s` : 'missing');
}
expect('forward clips walk the body forward, back clips backward, strafe_l to the left',
  Math.cos(byName.walk.dir) > 0.9 && Math.cos(byName.run_back.dir) < -0.9 && Math.sin(byName.strafe_l.dir) > 0.5 && Math.sin(byName.strafe_r.dir) < -0.5);

const fl = scene.getObjectByName('foot_l'); const fr = scene.getObjectByName('foot_r');
const clipByName = new Map(clips.map((c) => [c.name, c]));
const FORWARD = new Set(['walk', 'run', 'sprint']);

function runCase(speed, dirDeg) {
  const th = dirDeg * Math.PI / 180;
  const vx = Math.sin(th) * speed; const vz = Math.cos(th) * speed;
  const yaw = locomotionFacing(0, vx, vz, true);
  const mixer = new THREE.AnimationMixer(scene);
  const st = newLocoState();
  const actionOf = (src) => (clipByName.has(src) ? mixer.clipAction(clipByName.get(src)) : null);
  const dt = 1 / 60;
  const { fwd, side } = bodyLocal(vx, vz, yaw);
  scene.rotation.set(0, yaw, 0);
  let pick = null; let fwdWeightWhileBack = 0; let minTs = Infinity; let maxTs = -Infinity;
  const P = new THREE.Vector3(); const A = new THREE.Vector3(); const B = new THREE.Vector3();
  let prev = null; let sx = 0; let sz = 0; let n = 0; let relAlong = 0;
  const travel = new THREE.Vector3(vx, 0, vz).normalize();
  const back = Math.cos(Math.atan2(side, fwd)) < -0.2;
  for (let i = 0; i < 180; i++) {
    pick = stepLocomotion(st, set, fwd, side, dt, actionOf);
    minTs = Math.min(minTs, pick.ts); maxTs = Math.max(maxTs, pick.ts);
    if (back) for (const [c, w] of st.weights) if (FORWARD.has(c.name) && w > 1e-3 && i > 10) fwdWeightWhileBack = Math.max(fwdWeightWhileBack, w);
    mixer.update(dt);
    P.set(vx * i * dt, 0, vz * i * dt);
    scene.position.copy(P);
    scene.updateMatrixWorld(true);
    fl.getWorldPosition(A); fr.getWorldPosition(B);
    const cur = { L: A.clone(), R: B.clone(), P: P.clone() };
    if (i >= 60 && prev) {
      const k = cur.L.y <= cur.R.y ? 'L' : 'R';
      if ((prev.L.y <= prev.R.y ? 'L' : 'R') === k) {
        const wvx = (cur[k].x - prev[k].x) / dt; const wvz = (cur[k].z - prev[k].z) / dt;
        sx += wvx; sz += wvz; n++;
        relAlong += (wvx - vx) * travel.x + (wvz - vz) * travel.z;
      }
    }
    prev = cur;
  }
  mixer.stopAllAction(); mixer.uncacheRoot(scene);
  const slip = n ? Math.hypot(sx / n, sz / n) / speed : Infinity;
  return { yaw, slip, rel: n ? relAlong / n : 0, back, fwdWeightWhileBack, dom: st.dominant?.name, minTs, maxTs, pick };
}

let worst = 0; let worstCase = '';
for (const speed of [1, 2, 3, 4, 5]) {
  for (let k = 0; k < 8; k++) {
    const dir = k * 45;
    const r = runCase(speed, dir);
    if (r.slip > worst) { worst = r.slip; worstCase = `${speed} m/s @ ${dir} deg`; }
    const tag = `${speed} m/s @ ${String(dir).padStart(3)} deg (body yaw ${(r.yaw * 180 / Math.PI).toFixed(0)}, ${r.dom}, ts ${r.pick.ts.toFixed(2)})`;
    expect(`${tag}: stance foot slip <= 12% of body speed`, r.slip <= 0.12, `${(r.slip * 100).toFixed(1)}%`);
    expect(`${tag}: stance foot moves against the travel`, r.rel < 0, `rel ${r.rel.toFixed(2)} m/s`);
    expect(`${tag}: timeScale inside ${TS_MIN}-${TS_MAX}`, r.minTs >= TS_MIN - 1e-9 && r.maxTs <= TS_MAX + 1e-9);
    if (r.back) expect(`${tag}: backpedal never selects a forward clip`, r.fwdWeightWhileBack === 0 && !FORWARD.has(r.dom), `fwd weight ${r.fwdWeightWhileBack.toFixed(2)}`);
    if (dir === 180 && speed <= 3) expect(`${tag}: a ${speed} m/s retreat backpedals (keeps facing the look)`, Math.abs(r.yaw) < 1e-6 && r.back);
    if (dir === 0) expect(`${tag}: forward travel faces the look`, Math.abs(r.yaw) < 1e-6);
  }
}
console.log(`worst slip ${(worst * 100).toFixed(1)}% at ${worstCase}`);

// Phase sync: a walk->run change keeps ONE phase (no restart, no jump).
{
  const mixer = new THREE.AnimationMixer(scene);
  const st = newLocoState();
  const actionOf = (src) => (clipByName.has(src) ? mixer.clipAction(clipByName.get(src)) : null);
  const pa = pickLocomotion(set, 1, 0); const pb = pickLocomotion(set, 2.4, 0);
  for (let i = 0; i < 40; i++) stepLocomotion(st, set, 1, 0, 1 / 60, actionOf);
  const before = st.phase;
  const p = stepLocomotion(st, set, 2.4, 0, 1 / 60, actionOf);
  const ta = mixer.clipAction(clipByName.get(pa.a.source)).time / clipByName.get(pa.a.source).duration;
  const tb = mixer.clipAction(clipByName.get(pb.a.source)).time / clipByName.get(pb.a.source).duration;
  expect(`${pa.a.name}->${pb.a.name} cross-fade: one shared phase, both actions pinned to it`,
    pa.a.source !== pb.a.source && Math.abs(ta - tb) < 1e-6 && Math.abs(st.phase - before - p.phaseRate / 60) < 1e-9,
    `${pa.a.name} ${ta.toFixed(3)} ${pb.a.name} ${tb.toFixed(3)}`);
  mixer.stopAllAction(); mixer.uncacheRoot(scene);
}
// Backpedal picks a back clip even with no weight history.
{
  const p = pickLocomotion(set, -1, 0);
  expect('pickLocomotion(-1 m/s fwd) is a back clip', !!p && /_back$/.test(p.a.name) && !p.b, p ? p.a.name : 'null');
}
const ms = performance.now() - t0;
console.log(`\n${passed} passed, ${failed} failed (${ms.toFixed(0)} ms)`);
process.exit(failed ? 1 : 0);
