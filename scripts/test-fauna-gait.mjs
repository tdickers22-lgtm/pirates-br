// SHARK GAIT — the pose maths and the mixer's distance LOD (FAUNAGLB-01).
//
// WHY. The shark's animation used to be forty lines inline in Game.syncSharks,
// tangled with scene-graph bookkeeping, so nothing graded it: the jaw could
// gape on a lunge, the recover beat could stop banking, the swim could stop
// tracking speed, and the only way to find out was to swim next to one.
// SharkRenderer makes the decisions pure, and this is what watches them.
//
// It also watches the thing the north star cares about. Stepping an
// AnimationMixer is skeleton work per shark per frame, and SHARK.MAX_WORLD is
// 4. A shark 3.4 m long at 90 m is ~25 px tall and nobody can see which frame
// of the swim it is on, so past MIXER_NEAR_M the mixer runs at 15 Hz off an
// accumulator and past MIXER_CULL_M not at all. THE ACCUMULATOR MUST NOT LOSE
// TIME: if it did, a shark that swam out past 45 m and back would come back at
// a different phase — a visible pop on the exact creature a player is watching.
//
//   node --import tsx scripts/test-fauna-gait.mjs
import * as THREE from 'three';
import {
  MIXER_CULL_M, MIXER_FAR_HZ, MIXER_NEAR_M, mixerStep, sharkPose, updateSharkPose,
} from '../src/client/rendering/SharkRenderer.ts';
import { buildSharkMesh } from '../src/client/rendering/factories/FaunaMeshFactory.ts';

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('SHARK GAIT');
console.log('── pose per attack state ──────────────────────────────────────');
const cruiseSlow = sharkPose('cruise', 0, 0);
const cruiseFast = sharkPose('cruise', 0, 6);
expect('cruise tail beat rises with swim speed', cruiseFast.tailHz > cruiseSlow.tailHz * 1.5,
  `${cruiseSlow.tailHz.toFixed(2)} Hz at rest vs ${cruiseFast.tailHz.toFixed(2)} Hz at 6 m/s`);
expect('cruise beat is capped (a shark is not a hummingbird)',
  sharkPose('cruise', 0, 40).tailHz <= 2.2 * 1.6 + 1e-9,
  `${sharkPose('cruise', 0, 40).tailHz.toFixed(2)} Hz at 40 m/s`);
const windupEarly = sharkPose('windup', 0.9, 2);
const windupLate = sharkPose('windup', 0.0, 2);
expect('windup gapes wider the closer the lunge is', windupLate.jawTarget > windupEarly.jawTarget,
  `${windupEarly.jawTarget.toFixed(3)} early vs ${windupLate.jawTarget.toFixed(3)} late`);
expect('windup flares the pectorals and rears the nose',
  windupLate.pecTarget > 0.3 && windupLate.pitchTarget < 0,
  `pec ${windupLate.pecTarget}, pitch ${windupLate.pitchTarget}`);
const lunge = sharkPose('lunge', 0, 2);
expect('the jaw is SHUT on the lunge (the bite has landed)', lunge.jawTarget < 0.1,
  `jaw ${lunge.jawTarget}`);
expect('the lunge thrashes hardest', lunge.tailAmp > windupLate.tailAmp * 3 && lunge.tailHz > 5,
  `amp ${lunge.tailAmp}, ${lunge.tailHz} Hz`);
const recover = sharkPose('recover', 0, 2);
expect('recover banks the body — the readable vulnerable beat', recover.rollTarget > 0.1,
  `roll ${recover.rollTarget}`);
expect('recover droops: slower and shallower than a cruising shark',
  recover.tailHz < cruiseFast.tailHz && recover.tailAmp < cruiseSlow.tailAmp,
  `${recover.tailHz} Hz / amp ${recover.tailAmp} vs cruise ${cruiseFast.tailHz.toFixed(2)} Hz / amp ${cruiseSlow.tailAmp}`);

console.log('── mixer distance LOD ─────────────────────────────────────────');
const DT = 1 / 60;
function run(distance, seconds) {
  let carry = 0, total = 0, steps = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const r = mixerStep(DT, carry, distance);
    carry = r.carry;
    if (r.step > 0) { total += r.step; steps += 1; }
  }
  return { total, steps, carry };
}
const nearRun = run(MIXER_NEAR_M - 1, 1);
expect('inside MIXER_NEAR_M the mixer steps every frame', nearRun.steps === 60,
  `${nearRun.steps} steps in 60 frames`);
const farRun = run((MIXER_NEAR_M + MIXER_CULL_M) / 2, 1);
expect(`past MIXER_NEAR_M the mixer steps ~${MIXER_FAR_HZ} Hz, not 60`,
  farRun.steps <= MIXER_FAR_HZ + 1 && farRun.steps >= MIXER_FAR_HZ - 1,
  `${farRun.steps} steps in 60 frames`);
expect('the far accumulator loses no time (no phase pop crossing the line)',
  near(farRun.total + farRun.carry, 1, 1e-9),
  `handed the mixer ${farRun.total.toFixed(6)} s + ${farRun.carry.toFixed(6)} s carried, of 1 s`);
const cullRun = run(MIXER_CULL_M + 1, 1);
expect('past MIXER_CULL_M the mixer does no work at all', cullRun.steps === 0,
  `${cullRun.steps} steps`);

console.log('── a real AnimationMixer, driven through updateSharkPose ───────');
// A minimal skinned stand-in: a bone, a one-second clip on it, a mixer.
const bone = new THREE.Bone();
bone.name = 'spine1';
const root = new THREE.Group();
root.add(bone);
const clip = new THREE.AnimationClip('swim', 1, [
  new THREE.QuaternionKeyframeTrack('spine1.quaternion', [0, 0.5, 1],
    [0, 0, 0, 1, 0, 0.2, 0, 0.98, 0, 0, 0, 1]),
]);
const mixer = new THREE.AnimationMixer(root);
const swim = mixer.clipAction(clip);
swim.setLoop(THREE.LoopRepeat, Infinity);
swim.play();
const mesh = new THREE.Group();
mesh.add(root);
mesh.userData.parts = {};
mesh.userData.fauna = { mixer, swim, bite: null, skinned: true };

for (let i = 0; i < 30; i++) updateSharkPose(mesh, DT, 'cruise', 0, 3, i * DT, 10);
const nearTime = mixer.time;
expect('a near shark\'s clip advances', nearTime > 0.4, `mixer.time ${nearTime.toFixed(4)}`);
for (let i = 0; i < 30; i++) updateSharkPose(mesh, DT, 'cruise', 0, 3, i * DT, MIXER_CULL_M + 5);
expect('a culled shark\'s clip does NOT advance', near(mixer.time, nearTime, 1e-9),
  `mixer.time ${mixer.time.toFixed(4)} vs ${nearTime.toFixed(4)}`);
const beforeFar = mixer.time;
for (let i = 0; i < 60; i++) updateSharkPose(mesh, DT, 'cruise', 0, 3, i * DT, 90);
expect('a far shark still swims (LOD is a step rate, not a freeze)',
  mixer.time - beforeFar > 0.8, `advanced ${(mixer.time - beforeFar).toFixed(4)} s in 1 s`);
expect('the swim clip tracks speed through the mixer time scale',
  (() => {
    updateSharkPose(mesh, DT, 'cruise', 0, 0, 0, 10);
    const slow = swim.getEffectiveTimeScale();
    updateSharkPose(mesh, DT, 'lunge', 0, 8, 0, 10);
    return swim.getEffectiveTimeScale() > slow * 2;
  })(), 'lunge time scale is not faster than a resting cruise');
expect('the skinned path leaves the body pitch/roll to the caller (bank on recover)',
  (() => {
    mesh.rotation.z = 0;
    for (let i = 0; i < 60; i++) updateSharkPose(mesh, DT, 'recover', 0, 1, i * DT, 10);
    return mesh.rotation.z > 0.1;
  })(), `rotation.z ${mesh.rotation.z.toFixed(3)}`);

console.log('── the fallback contract (no GLBs loaded: procedural puppet) ───');
for (const quality of ['low', 'balanced', 'high']) {
  const g = buildSharkMesh(quality);
  const fauna = g.userData.fauna;
  const parts = g.userData.parts ?? {};
  expect(`buildSharkMesh('${quality}') with no assets falls back unskinned`,
    fauna && fauna.skinned === false && fauna.mixer === null,
    `fauna=${JSON.stringify(fauna && { skinned: fauna.skinned, mixer: !!fauna.mixer })}`);
  for (const node of ['shark_tail', 'shark_jaw', 'shark_pec_l', 'shark_pec_r']) {
    expect(`  …carrying the '${node}' pivot the fallback animator drives`, !!parts[node]);
  }
}

console.log(`\ntest-fauna-gait: ${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`FAIL (${failures})`); process.exit(1); }
console.log('PASS');
