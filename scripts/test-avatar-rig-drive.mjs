// THE RIG, DRIVEN — node, no browser, no GPU, no network (RIG-01 slice b).
//
// test-avatar-rig grades the FILE. This suite grades the code that turns the
// file into a pirate: PlayerRigFactory's clone, dress, tint and two-layer state
// machine, on the real pirate_base.glb parsed straight off disk with
// GLTFLoader.parse (no fetch, no server).
//
// The four things that go silently wrong here, and are checked below:
//
//   * THE SHARED SKELETON. three's Object3D.clone copies a SkinnedMesh's
//     skeleton by REFERENCE. Twelve pirates cloned that way pose off one set of
//     bones that live in no scene and never update: they all freeze in one
//     pose, together, and it looks like a network bug. SkeletonUtils.clone is
//     the fix, and "these two pirates' head bones are different objects" is the
//     only assertion that can tell the two apart.
//   * THE TIER GATE. The low tier must keep makePlayerMesh — a skinning shader
//     variant plus one mixer per avatar is exactly what the weakest machine
//     cannot pay for. `makePlayerRig(..., 'low')` returning a rig is a P1
//     against the owner's north star, not a nicety.
//   * THE MASKS. Upper and lower layers must write DISJOINT bones, or the two
//     actions blend 50/50 and every pose is half of two clips. A leg track in
//     the upper clip is invisible in a screenshot and obvious here.
//   * THE SOLES. The clips are authored on flat ground and a cross-fade blends
//     two of them; the post-solver has to keep the lower boot on the surface.
//     This is AVATAR-01's invariant (boots were at −0.19), now on bones.
//
//   node --import tsx scripts/test-avatar-rig-drive.mjs
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assets } from '../src/client/assets/AssetLibrary.ts';
import { makePlayerRig, updatePlayerRig, playerRigOf, playRigDeath } from '../src/client/rendering/factories/PlayerRigFactory.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

console.log('Rigged pirate, driven (node, GLTFLoader.parse + PlayerRigFactory)');

// ── load the GLB off disk and hand it to the AssetLibrary ──────────────────
const glbPath = new URL('../public/assets/models/pirate_base.glb', import.meta.url).pathname;
const bytes = readFileSync(glbPath);
const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject);
});
// The library is the only door into the asset; stub the one method the factory
// uses rather than booting a loader against a dev server.
assets.source = (name) => (name === 'pirate_base' ? { scene: gltf.scene, animations: gltf.animations } : null);

expect('the parsed GLB carries clips', gltf.animations.length === 33, `${gltf.animations.length} clips`);

// ── build ──────────────────────────────────────────────────────────────────
const a = makePlayerRig(0x3366cc, 'pirate', 'crew', 'player-alpha', 'balanced');
const b = makePlayerRig(0xcc3333, 'pirate', 'captain', 'player-bravo', 'high');
expect('a balanced-tier pirate gets a rig', !!a);
expect('a high-tier pirate gets a rig', !!b);
expect('the LOW tier keeps makePlayerMesh (no skinning, no mixer)',
  makePlayerRig(0x3366cc, 'pirate', 'crew', 'player-alpha', 'low') === null);
expect('the island SKELETON variant keeps its procedural body',
  makePlayerRig(0x3366cc, 'skeleton', 'crew', 'bones-1', 'high') === null);

const rigA = playerRigOf(a);
const rigB = playerRigOf(b);
expect('each pirate has her OWN skeleton (SkeletonUtils, not Object3D.clone)',
  !!rigA?.bones.head && !!rigB?.bones.head && rigA.bones.head !== rigB.bones.head);

// dressed set
// A multi-material part arrives as a NODE named `body` / `head_b` holding
// meshes named after their Blender datablocks (`p_torso`, `head_b_skin`), so
// the dressed set is graded on the node names, not the mesh names.
const PART_RE = /^(body|head_[a-f]|hat_[a-z]+|coat_(long|short))$/;
const wornParts = [];
a.traverse((o) => { if (PART_RE.test(o.name)) wornParts.push(o.name); });
expect('exactly one body, one head, one hat and one coat are kept',
  wornParts.filter((n) => n === 'body').length === 1
  && wornParts.filter((n) => n.startsWith('head_')).length === 1
  && wornParts.filter((n) => n.startsWith('hat_')).length === 1
  && wornParts.filter((n) => n.startsWith('coat_')).length === 1,
  wornParts.join(', '));
expect('the twelve variants this pirate is not wearing are gone', wornParts.length === 4, wornParts.join(', '));

let drawsA = 0;
a.traverse((o) => { if (o.isSkinnedMesh) drawsA += Array.isArray(o.material) ? o.material.length : 1; });
expect('a dressed pirate is ≤ 7 skinned draws (22-26 for makePlayerMesh)', drawsA <= 7, `draws=${drawsA}`);

// team tint: one material per crew colour, shared across that crew's pirates
const c = makePlayerRig(0x3366cc, 'pirate', 'crew', 'player-charlie', 'balanced');
const tintOf = (g) => {
  let m = null;
  g.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) if (mat.name === 'TeamTint') m = mat;
  });
  return m;
};
expect('two pirates of the same crew share ONE tinted material', tintOf(a) === tintOf(c) && !!tintOf(a));
expect('two crews do not share a tint', tintOf(a) !== tintOf(b));
expect('the tint is the crew colour', tintOf(a)?.color.getHex() === 0x3366cc, `#${tintOf(a)?.color.getHexString()}`);

// ── masks are disjoint ─────────────────────────────────────────────────────
const LOWER = new Set(['root', 'hips', 'thigh_l', 'shin_l', 'foot_l', 'toe_l', 'thigh_r', 'shin_r', 'foot_r', 'toe_r']);
let lowerBad = 0;
let upperBad = 0;
let emptyMask = 0;
// The layers themselves are the observable: one frame is enough to bind them.
const player = (over = {}) => ({
  id: 'player-alpha', health: 100, state: 'alive', activeSlot: 0,
  weapons: [{ weaponId: 'pistol', reloading: false, reloadTimer: 0 }],
  velocity: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  atCannon: false, atHelm: false, atCrowNest: false, mastClimb: null,
  bailing: false, hullRepairProgress: 0, equippedTool: null, cutlassCharge: 0,
  ...over,
});

updatePlayerRig(a, player(), 1 / 60, 0, 0, 0);
for (const track of rigA.lower.action.getClip().tracks) {
  if (!LOWER.has(track.name.slice(0, track.name.indexOf('.')))) lowerBad += 1;
}
for (const track of rigA.upper.action.getClip().tracks) {
  if (LOWER.has(track.name.slice(0, track.name.indexOf('.')))) upperBad += 1;
}
if (rigA.lower.action.getClip().tracks.length === 0 || rigA.upper.action.getClip().tracks.length === 0) emptyMask += 1;
expect('the LOWER layer only writes root/hips/legs', lowerBad === 0, `${lowerBad} stray tracks`);
expect('the UPPER layer never writes a leg bone', upperBad === 0, `${upperBad} stray tracks`);
expect('neither mask came out empty', emptyMask === 0);

// ── the state machine reaches the clips the player state asks for ──────────
const drive = (p, frames = 30) => {
  for (let i = 0; i < frames; i++) updatePlayerRig(a, p, 1 / 60, 0, 0, 0);
  return [rigA.lower.name, rigA.upper.name];
};
const cases = [
  [player({ velocity: { x: 0, y: 0, z: 0 } }), 'idle'],
  [player({ velocity: { x: 2.0, y: 0, z: 0 } }), 'walk'],
  [player({ velocity: { x: PLAYER.MOVE_SPEED, y: 0, z: 0 } }), 'run'],
  [player({ state: 'swimming', velocity: { x: 2, y: 0, z: 0 } }), 'swim'],
  [player({ state: 'swimming', velocity: { x: 0, y: 0, z: 0 } }), 'tread'],
  [player({ atHelm: true }), 'helm'],
  [player({ atCannon: true }), 'cannon_aim'],
  [player({ bailing: true }), 'bail'],
  [player({ hullRepairProgress: 0.4 }), 'hammer'],
  [player({ mastClimb: 0.5 }), 'climb'],
  [player({ state: 'downed' }), 'downed'],
  [player({ velocity: { x: 0, y: 6, z: 0 } }), 'jump'],
  [player({ velocity: { x: 0, y: -6, z: 0 } }), 'fall'],
];
for (const [p, want] of cases) {
  const [lower] = drive(p, 6);
  expect(`state → clip: ${want}`, lower === want, `got "${lower}"`);
}

// aim while walking is the whole point of the split
const [lower, upper] = drive(player({ velocity: { x: 2.0, y: 0, z: 0 } }), 6);
expect('a walking pirate can aim: legs walk, arms aim', lower === 'walk' && upper === 'aim_pistol', `${lower}/${upper}`);

// a station pose owns the whole body — no pistol at the wheel
const [lowerHelm, upperHelm] = drive(player({ atHelm: true }), 6);
expect('a helmsman does not aim a pistol', lowerHelm === 'helm' && upperHelm === 'helm', `${lowerHelm}/${upperHelm}`);

// ── the soles stay on the ground through every state ───────────────────────
const boot = new THREE.Vector3();
function lowestSoleY(group) {
  const rig = playerRigOf(group);
  group.updateMatrixWorld(true);
  let low = Infinity;
  for (const f of [rig.bones.footL, rig.bones.footR]) {
    boot.setFromMatrixPosition(f.matrixWorld);
    group.worldToLocal(boot);
    low = Math.min(low, boot.y - 0.045);
  }
  return low;
}
let worstSole = Infinity;
let worstState = '';
for (const [p, want] of cases) {
  if (want === 'downed' || want === 'swim' || want === 'tread' || want === 'jump' || want === 'fall' || want === 'climb') continue;
  drive(p, 40);
  const y = lowestSoleY(a);
  if (y < worstSole) { worstSole = y; worstState = want; }
}
expect('no boot sinks through the deck in any grounded state (≥ −0.02)',
  worstSole >= -0.02, `worst ${worstSole.toFixed(3)} in "${worstState}"`);

// ── the head bone stays where the server's headshot sphere is ──────────────
drive(player(), 40);
a.updateMatrixWorld(true);
const headPos = new THREE.Vector3().setFromMatrixPosition(rigA.bones.head.matrixWorld);
a.worldToLocal(headPos);
expect(`the head bone stays within 8 cm of PLAYER.HEAD_Y (${PLAYER.HEAD_Y}) while idling`,
  Math.abs(headPos.y - PLAYER.HEAD_Y) <= 0.08, `head y=${headPos.y.toFixed(3)}`);

// ── the distance LOD actually skips work ───────────────────────────────────
let camDistSq = 0;
const stepped = () => {
  let n = 0;
  const real = rigA.mixer.update.bind(rigA.mixer);
  rigA.mixer.update = (dt) => { n += 1; return real(dt); };
  for (let i = 0; i < 60; i++) updatePlayerRig(a, player(), 1 / 60, camDistSq, 0, 0);
  rigA.mixer.update = real;
  return n;
};
const near = stepped();
camDistSq = 40 * 40;
const mid = stepped();
camDistSq = 200 * 200;
const far = stepped();
expect('a pirate in your face is stepped every frame', near === 60, `${near}/60`);
expect('a pirate at 40 m is stepped ~half as often', mid < near && mid > 0, `${mid}/60`);
expect('a pirate past 120 m is not stepped at all', far === 0, `${far}/60`);

// ── the head look-at is ABSOLUTE, not accumulated (review-6 P1) ────────────
// The mixer is rate-limited by distance, but the head post-solver runs EVERY
// frame. If it writes `head.rotation.x += pitch` then on any frame the mixer
// skipped, nothing has rewritten the bone from the clip and the pitch is
// applied on top of itself: a 30 Hz nod in the 25-60 m band, and past the
// freeze range (nothing ever resets the bone) a head that spins without bound.
// So: pose the head at a fixed pitch for 120 frames at each LOD band and
// require the bone to stay inside the clip's own range plus one pitch limit.
camDistSq = 0;
let baseMin = Infinity;
let baseMax = -Infinity;
for (let i = 0; i < 120; i++) {
  updatePlayerRig(a, player(), 1 / 60, 0, 0, 0);
  baseMin = Math.min(baseMin, rigA.bones.head.rotation.x);
  baseMax = Math.max(baseMax, rigA.bones.head.rotation.x);
}
const PITCH = 0.5;
for (const [label, d2] of [['in your face', 0], ['in the 30 Hz band (45 m)', 45 * 45],
  ['in the 15 Hz band (90 m)', 90 * 90], ['past the freeze range (200 m)', 200 * 200]]) {
  let worst = 0;
  let worstX = 0;
  for (let i = 0; i < 120; i++) {
    updatePlayerRig(a, player(), 1 / 60, d2, PITCH, 0);
    const x = rigA.bones.head.rotation.x;
    const over = Math.max(x - (baseMax + PITCH), baseMin - PITCH - x);
    if (over > worst) { worst = over; worstX = x; }
  }
  expect(`the head look-at does not accumulate ${label}`, worst <= 1e-3,
    `head.rotation.x ran to ${worstX.toFixed(3)} rad, ${worst.toFixed(3)} outside [${(baseMin - PITCH).toFixed(3)}, ${(baseMax + PITCH).toFixed(3)}]`);
}
// and it still actually LOOKS: the pitch must reach the bone.
updatePlayerRig(a, player(), 1 / 60, 0, 0, 0);
const flat = rigA.bones.head.rotation.x;
updatePlayerRig(a, player(), 1 / 60, 0, PITCH, 0);
expect('the pitch still reaches the head bone', Math.abs(rigA.bones.head.rotation.x - flat) > 0.4,
  `${(rigA.bones.head.rotation.x - flat).toFixed(3)} rad of look`);
camDistSq = 0;

// ── the shadow LOD ─────────────────────────────────────────────────────────
// 7 draws become 14 with the shadow pass, and a 1.75 m figure at 40 m casts a
// shadow a couple of texels wide. The old body had castShadow on all 22-26
// meshes (avatar-13).
const casting = () => rigA.skins.filter((m) => m.castShadow).length;
updatePlayerRig(a, player(), 1 / 60, 5 * 5, 0, 0);
const nearShadows = casting();
updatePlayerRig(a, player(), 1 / 60, 80 * 80, 0, 0);
const farShadows = casting();
updatePlayerRig(a, player(), 1 / 60, 3 * 3, 0, 0);
const backShadows = casting();
expect('a pirate in front of you casts a shadow', nearShadows === rigA.skins.length, `${nearShadows}/${rigA.skins.length}`);
expect('a pirate at 80 m casts nothing', farShadows === 0, `${farShadows} still casting`);
expect('and she casts again when you walk back to her', backShadows === rigA.skins.length, `${backShadows}`);

// ── deaths reach a death clip ──────────────────────────────────────────────
expect('a drowned corpse plays death_drown', playRigDeath(a, 'drown', 1 / 60) && rigA.lower.name === 'death_drown', rigA.lower.name);
expect('a shot corpse plays death_shot', playRigDeath(a, 'shot', 1 / 60) && rigA.lower.name === 'death_shot', rigA.lower.name);

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
