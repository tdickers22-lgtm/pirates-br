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
  // b3.3b: the body faces +Z, so forward travel is +Z; 1 m/s is the walk
  // clip's stride-matched band, full speed the run's.
  [player({ velocity: { x: 0, y: 0, z: 1.0 } }), 'walk'],
  [player({ velocity: { x: 0, y: 0, z: PLAYER.MOVE_SPEED } }), 'run'],
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
const [lower, upper] = drive(player({ velocity: { x: 0, y: 0, z: 1.0 } }), 6);
expect('a walking pirate can aim: legs walk, arms aim', lower === 'walk' && upper === 'aim_pistol', `${lower}/${upper}`);

// a station pose owns the whole body — no pistol at the wheel
const [lowerHelm, upperHelm] = drive(player({ atHelm: true }), 6);
expect('a helmsman does not aim a pistol', lowerHelm === 'helm' && upperHelm === 'helm', `${lowerHelm}/${upperHelm}`);

// ── b3.3b: blend space on this asset + the clips that used to be dead data ──
// (animations-07/10). Each case settles first so no earlier one-shot owns a layer.
const settle = () => drive(player(), 40);
{
  settle();
  const [lo] = drive(player({ velocity: { x: 0, y: 0, z: -1.0 } }), 20);
  expect('b3.3b a 1 m/s backpedal plays a back clip, never walk', lo === 'walk_back', `got "${lo}"`);
  settle();
  const [ls] = drive(player({ velocity: { x: 0.9, y: 0, z: 0 } }), 20);
  expect('b3.3b a slow step to the left (+X on a +Z body) plays strafe_l', ls === 'strafe_l', `got "${ls}"`);
  settle();
  const [rs] = drive(player({ velocity: { x: -0.9, y: 0, z: 0 } }), 20);
  expect('b3.3b a slow step to the right plays strafe_r', rs === 'strafe_r', `got "${rs}"`);
}
{
  settle();
  drive(player({ velocity: { x: 0, y: -6, z: 0 } }), 6);
  const [lo] = drive(player(), 2);
  expect('b3.3b land: grounded after vy < -3 plays land', lo === 'land', `got "${lo}"`);
  settle();
  drive(player({ velocity: { x: 0, y: -2, z: 0 } }), 6);
  const [soft] = drive(player(), 2);
  expect('b3.3b a soft touchdown (vy > -3) does not', soft === 'idle', `got "${soft}"`);
}
{
  settle();
  drive(player({ atCannon: true }), 6);
  a.userData.cannonRecoil = 1;
  const [lo] = drive(player({ atCannon: true }), 2);
  expect('b3.3b cannon_fire: the gunner\'s cannonRecoil edge plays cannon_fire', lo === 'cannon_fire', `got "${lo}"`);
  a.userData.cannonRecoil = 0;
  const [back] = drive(player({ atCannon: true }), 90);
  expect('b3.3b ...and hands back to cannon_aim', back === 'cannon_aim', `got "${back}"`);
}
{
  settle();
  const [lo] = drive(player({ state: 'downed', reviveProgress: 0.5 }), 3);
  expect('b3.3b revive: a downed pirate being revived plays revive (scrubbed by progress)', lo === 'revive'
    && Math.abs(rigA.lower.action.time / rigA.lower.action.getClip().duration - 0.5) < 0.01, `got "${lo}"`);
  const [dn] = drive(player({ state: 'downed', reviveProgress: 0 }), 3);
  expect('b3.3b ...and downed again when nobody holds', dn === 'downed', `got "${dn}"`);
}
{
  settle();
  a.userData.flinch = { t: 0, mag: 0.5, yaw: 1.2, fromBehind: true };
  const [, up] = drive(player({ health: 80 }), 1);
  expect('b3.3b hit_back: a hit from behind (Game flinch.fromBehind) plays hit_back', up === 'hit_back', `got "${up}"`);
  a.userData.flinch = undefined;
  drive(player({ health: 80 }), 40);
  const [, upF] = drive(player({ health: 60 }), 1);
  expect('b3.3b ...and a hit from the front hit_front', upF === 'hit_front', `got "${upF}"`);
}
{
  settle();
  const gun = (ammo) => player({ weapons: [{ weaponId: 'pistol', ammo, reserve: 10, reloading: false, reloadTimer: 0 }] });
  drive(gun(5), 40);
  const [, up] = drive(gun(4), 1);
  expect('b3.3b fire_pistol: an ammo decrement plays fire_pistol on the upper layer', up === 'fire_pistol', `got "${up}"`);
  const [, after] = drive(gun(4), 60);
  expect('b3.3b ...then back to the aim', after === 'aim_pistol', `got "${after}"`);
}
{
  settle();
  const [, up] = drive(player({ equippedTool: 'spyglass' }), 6);
  expect('b3.3b spyglass: equippedTool spyglass plays spyglass on the upper layer', up === 'spyglass', `got "${up}"`);
}

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
// b3.2f mixer LOD (mixerIntervalFor): 5 Hz beyond 40 m and never frozen, so a far
// pirate walks in coarse steps instead of sliding across the deck in one pose.
expect('a pirate past 120 m is stepped at ~5 Hz, never frozen', far === 5, `${far} steps in 1 s`);

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

// ── and a corpse does not keep her last glance (final-sweep P2) ────────────
// PlayerAnimator.animateCorpse returns straight after playRigDeath for a rigged
// body, so updatePlayerRig never runs again on her. If playRigDeath restores
// only the PITCH, the YAW the look-at solver wrote on her last living frame is
// baked into the neck for the whole corpse lifetime: three's PropertyMixer only
// writes a track whose accumulated value CHANGED, and a head track that holds
// still never changes. Drive her yaw hard, kill her, and the head must come
// back to whatever the death clip itself says.
camDistSq = 0;
const YAW = 0.5;
/** Live for 30 frames at `lookYaw`, then lie dead for 120, and report the head
 *  yaw of the corpse. The CONTROL is the same pirate who died looking straight
 *  ahead: whatever the death clip itself puts in the neck is in both numbers,
 *  so only the baked glance can separate them. */
const corpseHeadAfterLook = (pitch, yaw, tag) => {
  const body = makePlayerRig(0x3366cc, 'pirate', 'crew', `player-corpse-${tag}`, 'balanced');
  const rig = playerRigOf(body);
  for (let i = 0; i < 30; i++) updatePlayerRig(body, player(), 1 / 60, 0, pitch, yaw);
  const live = { x: rig.bones.head.rotation.x, y: rig.bones.head.rotation.y };
  for (let i = 0; i < 120; i++) playRigDeath(body, 'shot', 1 / 60);
  return { live, dead: { x: rig.bones.head.rotation.x, y: rig.bones.head.rotation.y } };
};
const straight = corpseHeadAfterLook(0, 0, 'straight');
const glanced = corpseHeadAfterLook(0, YAW, 'glancing');
const craned = corpseHeadAfterLook(PITCH, 0, 'craning');
expect('the look-at yaw reaches the head bone at all', Math.abs(glanced.live.y - straight.live.y) > 0.4,
  `${(glanced.live.y - straight.live.y).toFixed(3)} rad of glance`);
expect('a corpse\'s head comes off the look-at YAW',
  Math.abs(glanced.dead.y - straight.dead.y) <= 0.05,
  `she died glancing and her head stayed ${(glanced.dead.y - straight.dead.y).toFixed(3)} rad off the pirate who died looking straight ahead`);
expect('and off the look-at PITCH (the axis [fixup6] fixed — pinned so it stays fixed)',
  Math.abs(craned.dead.x - straight.dead.x) <= 0.05,
  `she died looking up and her head stayed ${(craned.dead.x - straight.dead.x).toFixed(3)} rad off`);

// ── b3.3d flood-crew and impact motion ─────────────────────────────────────
// Each layer must APPEAR on its edge: the wade gait in knee-deep hold water,
// the stagger on a breach hit / anchor bite, and the bucket and hammer clips
// scrubbed by the SERVER's bailScoopProgress / hullRepairProgress clocks.
{
  const { queueStagger, setHoldImmersion, rigLocoState, WADE_CADENCE } = await import('../src/client/rendering/character/locomotion.ts');
  const fresh = (tag) => { const m = makePlayerRig(0x3366cc, 'pirate', 'crew', `player-b33d-${tag}`, 'balanced'); return { m, r: playerRigOf(m) }; };
  const run = (m, p, n) => { for (let i = 0; i < n; i++) updatePlayerRig(m, p, 1 / 60, 0, 0, 0); };
  // wade
  const wet = fresh('wet'); const dry = fresh('dry');
  setHoldImmersion(wet.m, 0.5); setHoldImmersion(dry.m, 0);
  const walkP = player({ velocity: { x: 0, y: 0, z: 1.5 } });
  run(wet.m, walkP, 20); run(dry.m, walkP, 20);
  const ph0w = rigLocoState(wet.r).phase; const ph0d = rigLocoState(dry.r).phase;
  run(wet.m, walkP, 12); run(dry.m, walkP, 12);
  const adv = (a0, a1) => ((a1 - a0) % 1 + 1) % 1;
  const ratio = adv(ph0w, rigLocoState(wet.r).phase) / Math.max(1e-6, adv(ph0d, rigLocoState(dry.r).phase));
  expect('knee-deep hold water: the lower layer is the wade gait', wet.r.lower.name === 'wade', wet.r.lower.name);
  expect('dry control at the same speed is not wading', dry.r.lower.name !== 'wade', dry.r.lower.name);
  expect('wading cadence is the WADE_CADENCE share of the dry stride', Math.abs(ratio - WADE_CADENCE) < 0.05, `ratio ${ratio.toFixed(3)}`);
  const fastWet = fresh('fastwet'); setHoldImmersion(fastWet.m, 0.5);
  run(fastWet.m, player({ velocity: { x: 0, y: 0, z: PLAYER.MOVE_SPEED } }), 30);
  const domW = rigLocoState(fastWet.r).dominant;
  expect('wading never plays a run sample', domW && domW.source === 'walk', domW?.name);
  // stagger
  const st = fresh('stagger'); run(st.m, player(), 20);
  queueStagger(st.m, true); run(st.m, player(), 1);
  expect('stagger from behind: hit_back on the legs', st.r.lower.name === 'hit_back', st.r.lower.name);
  expect('and on the arms', st.r.upper.name === 'hit_back', st.r.upper.name);
  run(st.m, player(), 60);
  expect('the stagger ends back in idle', st.r.lower.name === 'idle', st.r.lower.name);
  const sf = fresh('staggerfront'); run(sf.m, player(), 20); queueStagger(sf.m, false); run(sf.m, player(), 1);
  expect('stagger from the front: hit_front', sf.r.lower.name === 'hit_front', sf.r.lower.name);
  const helm = fresh('staggerhelm'); run(helm.m, player({ atHelm: true }), 20); queueStagger(helm.m, true); run(helm.m, player({ atHelm: true }), 1);
  expect('control: a helmsman holds the wheel through a lurch', helm.r.lower.name === 'helm', helm.r.lower.name);
  // bucket on the server clock
  const bk = fresh('bail');
  const frac = (act) => act.time / act.getClip().duration;
  run(bk.m, player({ bailing: true, equippedTool: 'bucket', bailScoopProgress: 0.75 }), 10);
  const b1 = { name: bk.r.lower.name, f: frac(bk.r.lower.action), u: frac(bk.r.upper.action) };
  run(bk.m, player({ bailing: true, equippedTool: 'bucket', bailScoopProgress: 0.25 }), 10);
  const b2 = { f: frac(bk.r.lower.action), u: frac(bk.r.upper.action) };
  expect('bail clip scrubbed by bailScoopProgress (0.75 -> 25% through)', b1.name === 'bail' && Math.abs(b1.f - 0.25) < 0.02 && Math.abs(b1.u - 0.25) < 0.02, JSON.stringify(b1));
  expect('and 0.25 -> 75% through, both layers', Math.abs(b2.f - 0.75) < 0.02 && Math.abs(b2.u - 0.75) < 0.02, JSON.stringify(b2));
  // hammer on the shared blow clock (default 2.4 s repair = 3 blows)
  const hm = fresh('hammer');
  run(hm.m, player({ hullRepairProgress: 0.1 }), 1);
  const h1 = { name: hm.r.lower.name, f: frac(hm.r.lower.action) };
  expect('hammer clip on the blow clock (progress 0.1 of 3 blows -> phase 0.3)', h1.name === 'hammer' && Math.abs(h1.f - 0.3) < 0.02, JSON.stringify(h1));
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
