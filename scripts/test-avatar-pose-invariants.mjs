// THIRD-PERSON POSE INVARIANTS — pure node, no browser, no GPU.
//
// WHY. Every avatar defect in the 2026-09-01 audit (sunk boots avatar-01, head
// 24 cm above the server's headshot sphere avatar-02, corpse lift avatar-16,
// crouch float avatar-17, pose pops) is a pure function of (mesh factory,
// animator, replicated Player fields). Nothing checked that function: the only
// pose suite (test-viewmodel-poses) exits 0 on software GL, which is what this
// machine has, so the defects survived eight campaigns.
//
// WHAT. Build the real mesh with makePlayerMesh, drive it with the real
// PlayerAnimator through fourteen replicated states, update the world matrices
// and read the boxes back. Each invariant is a statement about where a body part
// sits relative to the group origin — which Game.ts puts at the server's
// player.position, i.e. the standing surface:
//   • boot soles on the ground: min boot y in [-0.02, +0.06] when standing;
//   • hands never below the shins (y > 0.1) in any upright pose;
//   • head centre within 5 cm of Match's headshot sphere, which is now
//     PLAYER.HEAD_Y (PLAYER.HEAD_Y − PLAYER.CROUCH_DROP crouched) for pirates
//     AND island skeletons — one height set, read by both sides;
//   • the camera eye, the drawn head and the collider are ONE figure: EYE_Y is
//     7 cm under HEAD_Y, the crown clears PLAYER.HEIGHT by ≤6 cm, and neither
//     Match.ts nor Game.ts carries a hand-typed height any more;
//   • the team bandana is OUTSIDE the hair, and a captain has one beard and
//     one moustache, not two of each;
//   • a settled corpse lies on the ground (bottom ≥ -0.1, top ≤ 0.8);
//   • no single frame turns a joint by more than 0.35 rad across a state edge;
//   • visible-mesh count per variant under a fixed budget.
//
// RED ON HEAD (2026-09-02, before AVATAR-01): 30 of 46 assertions — boots at
// -0.19 (verifier witness), head at 1.92 vs the server's 1.68, crouched head
// 1.60 vs 1.155, skeleton shins at -0.09, corpses propped 1.46 m tall, every
// state edge a one-frame snap. Do not widen a threshold here to pass: the
// numbers are the shared constants', not the animator's.
//
//   node --import tsx scripts/test-avatar-pose-invariants.mjs
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
import { makePlayerMesh } from '../src/client/rendering/factories/PlayerMeshFactory.ts';
import { PlayerAnimator } from '../src/client/rendering/PlayerAnimator.ts';
import { PLAYER } from '../src/shared/constants/index.ts';
import { AVATAR_RIG } from '../src/client/rendering/factories/PlayerMeshFactory.ts';
import { hudAnchorLocal, makeNameplateSprite, NAMEPLATE_SCREEN_H } from '../src/client/rendering/factories/MiscMeshFactory.ts';
import { applyViewHandTeamColor, makeViewHand } from '../src/client/rendering/factories/PlayerMeshFactory.ts';
import { playerMeshVisible } from '../src/client/core/corpseVisibility.ts';
import { getShipFloorYAt } from '../src/shared/interactions.ts';
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── fixture ────────────────────────────────────────────────────────────────
const BOOT_MIN = -0.02;   // sole may sink 2 cm (shadow acne guard), no more
const BOOT_MAX = 0.06;    // and may float 6 cm at most (walk lift)
const HAND_MIN_Y = 0.10;
const HEAD_TOL = 0.05;
const STAND_HEAD = PLAYER.HEAD_Y;
const CROUCH_HEAD = PLAYER.HEAD_Y - PLAYER.CROUCH_DROP;
const POP_MAX_RAD = 0.35;
/** ANIMPOL: how far a sole may be from the surface under it (PLAN §5, w9.3). */
const DECK_TOL = 0.03;
const MESH_BUDGET = { pirate: 26, skeleton: 26 };
const ALLOC_MAX_B = 350;   // bytes per avatar per frame; 783 before the scratch buffers

let clock = 0;
const view = {
  input: { isAiming: () => false },
  ocean: { getTime: () => clock },
  localPlayerId: 'local',
  tempSlashPos: new THREE.Vector3(),
  spawnRemoteSlashArc: () => {},
  getCutlassSwingProgress: () => scenarioSwing,
};
let scenarioSwing = 0;
const animator = new PlayerAnimator(view);

const cutlass = () => ({ weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 });
const pistol = () => ({ weaponId: 'pistol', ammo: 6, reserve: 12, reloading: false, reloadTimer: 0 });

function makePlayer(over = {}) {
  return {
    id: 'p1', name: 'Fixture', shipId: null,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 100, state: 'walking', weapons: [cutlass(), pistol(), null, null], activeSlot: 1,
    reloading: false, reloadTimer: 0, knockbackVelocity: { x: 0, y: 0, z: 0 }, isBot: false,
    kills: 0, playerKillStreak: 0, superCannonballs: 0, megaKegs: 0, tsunamiCharges: 0, gold: 0,
    carryingChestId: null, treasureMapIslandId: null, questMaps: [], swimTimer: 0,
    atCannon: false, atHelm: false, atCrowNest: false, blocking: false, bailing: false,
    cutlassCharge: 0, cannonIndex: 0, nearChestId: null, nearShipId: null, onShipId: null,
    respawnTimer: 0, respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0, lastDamagedById: null,
    lastDamagedAt: null, lastDamageWasHeadshot: false, selectedCannonAmmo: 'ball', kegs: 0,
    kegCooldown: 0, cannonFlightTimer: 0, cannonBallistic: false, pocketBanana: 0, pocketWood: 0,
    pocketCoconut: 0, pocketMango: 0, pocketMeat: 0, pocketMeatByType: {}, pocketOre: 0,
    mastClimb: null, crouching: false, armor: 0, pocketUseCooldown: 0, hasShovel: false,
    hasSpyglass: false, equippedTool: null, bailScoopProgress: 0, hullRepairProgress: 0,
    bucketFilled: false, nearBarrelId: null, downedUntil: 0, reviveProgress: 0,
    ...over,
  };
}

/** Every scenario: the replicated fields that select the pose, how many frames
 *  to let blends settle (a branch change cross-fades over POSE_FADE_TIME, so a
 *  pose that must be graded SETTLED gets more than that many frames), and which invariants apply. `ground` = boots must be on
 *  the deck; `upright` = hands above the shins; `headY` = the server sphere. */
const SCENARIOS = [
  { name: 'idle', player: {}, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'walk 4 m/s', player: { velocity: { x: 4, y: 0, z: 0 } }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'helm', player: { atHelm: true }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'cannon', player: { atCannon: true }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'crow nest', player: { atCrowNest: true }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'climb 0.5', player: { mastClimb: 0.5 }, ground: false, upright: false, headY: STAND_HEAD },
  { name: 'swim', player: { state: 'swimming', velocity: { x: 2, y: 0, z: 0 } }, ground: false, upright: false, headY: null },
  { name: 'block', player: { activeSlot: 0, blocking: true }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'cutlass swing 0.4', player: { activeSlot: 0, weapons: [{ ...cutlass(), reloading: true, reloadTimer: 0.33 }, null, null, null] }, swing: 0.4, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'bail', player: { bailing: true, bailScoopProgress: 0.5, bucketFilled: true }, ground: true, upright: true, headY: STAND_HEAD },
  { name: 'crouch', player: { crouching: true }, frames: 24, ground: true, upright: true, headY: CROUCH_HEAD },
  { name: 'downed', player: { state: 'downed' }, frames: 40, ground: false, upright: false, headY: null },
  { name: 'airborne', player: { velocity: { x: 0, y: -5, z: 0 } }, frames: 20, ground: false, upright: true, headY: null },
];

const box = new THREE.Box3();
const worldBox = (obj) => {
  obj.geometry.computeBoundingBox();
  return box.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
};
function partBounds(group, pick) {
  let min = Infinity, max = -Infinity;
  group.traverse((o) => {
    if (!o.isMesh || !pick(o)) return;
    let vis = o.visible; for (let q = o.parent; q; q = q.parent) if (!q.visible) vis = false;
    if (!vis) return;
    const b = worldBox(o);
    min = Math.min(min, b.min.y); max = Math.max(max, b.max.y);
  });
  return { min, max };
}
const isBoot = (o) => o.name.endsWith('boot');
const isLeftBoot = (o) => isBoot(o) && /left/.test(o.name);
const isRightBoot = (o) => isBoot(o) && /right/.test(o.name);
const isLeg = (o) => o.name.endsWith('leg');
const isHand = (o) => o.name.endsWith('hand');
const isBody = (o) => !/health|bar/i.test(o.name) && !/health|bar/i.test(o.parent?.name ?? '');

const JOINTS = ['torso', 'pelvis', 'head', 'leftArmPivot', 'rightArmPivot', 'leftLegPivot', 'rightLegPivot'];
function snapshotJoints(parts) {
  const out = {};
  for (const j of JOINTS) { const r = parts[j].rotation; out[j] = [r.x, r.y, r.z]; }
  return out;
}
function maxJointDelta(a, b) {
  let worst = 0, at = '';
  for (const j of JOINTS) for (let i = 0; i < 3; i++) {
    const d = Math.abs(THREE.MathUtils.euclideanModulo(b[j][i] - a[j][i] + Math.PI, Math.PI * 2) - Math.PI);
    if (d > worst) { worst = d; at = `${j}.${'xyz'[i]}`; }
  }
  return { worst, at };
}

function run(mesh, player, ship, frames = 6, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) { clock += dt; animator.animatePlayerMesh(mesh, player, ship, dt); }
  mesh.updateMatrixWorld(true);
}

// ── 0. hot path: steady-state allocation ───────────────────────────────────
// A GC is a hitch the player feels, and this path runs once per visible avatar
// per frame. The pose cross-fade landed building a fresh 21-number array AND a
// template-literal branch key every frame: 783 B per avatar per frame, 9.4 KB a
// frame with twelve pirates on screen, all of it garbage. Read the heap either
// side of ONE frame at a time and take the median of the positive samples (the
// method test-frame-allocation had to learn: a collection inside a long window
// silently refunds what the window allocated).
console.log('\n[hot path: steady-state allocation]');
{
  scenarioSwing = 0;
  const N = 12;
  const crowd = [];
  const crowdPlayers = [];
  for (let i = 0; i < N; i++) {
    crowd.push(makePlayerMesh(0x3366cc, 'pirate', 'crew'));
    crowdPlayers.push(makePlayer({ id: `alloc${i}`, velocity: { x: 3.2, y: 0, z: 0 } }));
  }
  const frame = () => {
    clock += 1 / 60;
    for (let i = 0; i < N; i++) animator.animatePlayerMesh(crowd[i], crowdPlayers[i], null, 1 / 60);
  };
  for (let i = 0; i < 300; i++) frame();       // warm: let V8 settle and the hidden classes stabilise
  const samples = [];
  for (let i = 0; i < 600; i++) {
    const before = process.memoryUsage().heapUsed;
    frame();
    const d = process.memoryUsage().heapUsed - before;
    if (d > 0) samples.push(d);
  }
  samples.sort((a, b) => a - b);
  const perAvatar = samples.length ? samples[samples.length >> 1] / N : 0;
  expect(`animatePlayerMesh allocates ${perAvatar.toFixed(0)} B per avatar per frame ≤ ${ALLOC_MAX_B}`,
    samples.length >= 100 && perAvatar <= ALLOC_MAX_B,
    samples.length < 100
      ? `only ${samples.length}/600 positive samples: the measurement, not the build, is broken`
      : `${(perAvatar * N / 1024).toFixed(1)} KB of garbage a frame with ${N} pirates on screen`);
}

// ── 1. per-scenario placement ─────────────────────────────────────────────
console.log('Avatar pose invariants (node, makePlayerMesh + PlayerAnimator)');
for (const variant of ['pirate', 'skeleton']) {
  const role = variant === 'skeleton' ? 'raider' : 'crew';
  console.log(`\n[${variant}/${role}]`);
  const mesh = makePlayerMesh(0x3366cc, variant, role);
  const parts = mesh.userData.animation.parts;
  let visible = 0;
  mesh.updateMatrixWorld(true);
  mesh.traverse((o) => { if (o.isMesh && o.visible && o.parent?.visible !== false && isBody(o)) visible += 1; });
  expect(`${variant}: ${visible} visible body meshes ≤ ${MESH_BUDGET[variant]}`, visible <= MESH_BUDGET[variant]);

  for (const sc of SCENARIOS) {
    // Skeletons never man stations / swim / bail in the sim; grade their gait only.
    if (variant === 'skeleton' && !['idle', 'walk 4 m/s', 'crouch', 'airborne'].includes(sc.name)) continue;
    scenarioSwing = sc.swing ?? 0;
    animator.cutlassSwingKind.delete('p1');
    const player = makePlayer(sc.player);
    // Reset blends so each scenario is graded on its own, not on the previous pose.
    mesh.userData.animation.airBlend = 0; mesh.userData.animation.downedBlend = 0;
    mesh.userData.animation.landTimer = 0;
    run(mesh, player, null, sc.frames ?? 6);

    // Skeletons have feet now (avatar-26) and stand on the same rig, so the
    // same measurement applies to both variants.
    const feet = partBounds(mesh, isBoot);
    const footName = 'boot';
    const shins = partBounds(mesh, isLeg);
    const hands = partBounds(mesh, isHand);
    const headY = parts.head.getWorldPosition(new THREE.Vector3()).y;
    const serverHead = sc.headY;

    if (sc.ground) {
      expect(`${sc.name}: ${footName} sole on the deck (min y ${feet.min.toFixed(3)} in [${BOOT_MIN}, ${BOOT_MAX}])`,
        feet.min >= BOOT_MIN && feet.min <= BOOT_MAX,
        feet.min < BOOT_MIN ? `sunk ${(-feet.min).toFixed(2)} m below the standing surface` : `floating ${feet.min.toFixed(2)} m above it`);
      expect(`${sc.name}: shin bones stay out of the deck (min y ${shins.min.toFixed(3)} ≥ ${BOOT_MIN})`, shins.min >= BOOT_MIN);
    }
    if (sc.upright && variant === 'pirate') {
      expect(`${sc.name}: hands above the shins (min hand y ${hands.min.toFixed(3)} > ${HAND_MIN_Y})`, hands.min > HAND_MIN_Y);
    }
    if (serverHead !== null && serverHead !== undefined) {
      expect(`${sc.name}: head centre ${headY.toFixed(3)} within ${HEAD_TOL} of the server sphere at ${serverHead.toFixed(3)}`,
        Math.abs(headY - serverHead) <= HEAD_TOL,
        `Match.ts headY = PLAYER.HEAD_Y${player.crouching ? ' − PLAYER.CROUCH_DROP' : ''}; the drawn head is what players aim at`);
    }
  }
}

// Every crew has a captain, and a captain is the dressed-up variant (hat, coat,
// beard, moustache). One avatar = one draw per body mesh at the low tier, so the
// role that adds parts is the one the budget has to cover; only crew and raider
// were ever counted.
console.log('\n[pirate/captain]');
{
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'captain');
  mesh.updateMatrixWorld(true);
  let visible = 0;
  mesh.traverse((o) => { if (o.isMesh && o.visible && o.parent?.visible !== false && isBody(o)) visible += 1; });
  expect(`captain: ${visible} visible body meshes ≤ ${MESH_BUDGET.pirate}`, visible <= MESH_BUDGET.pirate,
    `a captain is drawn for every crew; ${visible} draws each is what the low tier pays`);
}

// ── 1b. one figure: collider, camera and mesh read the same constants ──────
console.log('\n[one figure: shared heights]');
{
  expect(`eye ${PLAYER.EYE_Y} sits 7 cm under the head centre ${PLAYER.HEAD_Y}`,
    Math.abs(PLAYER.EYE_Y - (PLAYER.HEAD_Y - 0.07)) < HEAD_TOL,
    'the camera must be INSIDE the drawn head, not 45 cm under it');
  expect(`rig head ${AVATAR_RIG.headY} is PLAYER.HEAD_Y`, AVATAR_RIG.headY === PLAYER.HEAD_Y);
  for (const [variant, role] of [['pirate', 'crew'], ['skeleton', 'raider']]) {
    const mesh = makePlayerMesh(0x3366cc, variant, role);
    mesh.updateMatrixWorld(true);
    const body = partBounds(mesh, isBody);
    expect(`${variant}: crown ${body.max.toFixed(2)} m ≤ PLAYER.HEIGHT + 0.06`,
      body.max <= PLAYER.HEIGHT + 0.06,
      `a ${body.max.toFixed(2)} m avatar on a ${PLAYER.HEIGHT} m collider looms over the camera`);
  }
  // The two hand-typed copies of these numbers are what let the three heights
  // drift apart; a literal creeping back in is the regression to catch.
  const matchSrc = readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
  const gameSrc = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  expect('Match.ts derives the headshot sphere from PLAYER.HEAD_Y',
    /headY = PLAYER\.HEAD_Y/.test(matchSrc) && !/islandSkeleton \? 1\.92/.test(matchSrc));
  expect('Match.ts crouch uses PLAYER.CROUCH_DROP', /PLAYER\.CROUCH_DROP/.test(matchSrc));
  expect('Game.ts places the camera at PLAYER.EYE_Y',
    /PLAYER\.EYE_Y/.test(gameSrc) && !/PLAYER\.HEIGHT \* 0\.84/.test(gameSrc));
}

// ── 1c. head dressing: one bandana over the hair, one beard per captain ────
console.log('\n[head dressing]');
{
  const crew = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  crew.updateMatrixWorld(true);
  const parts = crew.userData.animation.parts;
  const hair = parts.hair;
  const bandana = parts.bandana;
  const hairCentre = hair.getWorldPosition(new THREE.Vector3());
  const hairR = hair.geometry.parameters.radius;
  const pos = bandana.geometry.attributes.position;
  let outside = 0;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(bandana.matrixWorld);
    if (v.distanceTo(hairCentre) > hairR + 0.001) outside += 1;
  }
  const frac = outside / pos.count;
  expect(`bandana is worn OVER the hair (${(frac * 100).toFixed(0)}% of its vertices outside the r=${hairR} hair shell > 50%)`,
    frac > 0.5, 'a torus buried in the skull is not a team marker');
  expect('crew wear the bandana', bandana.visible);

  const captain = makePlayerMesh(0x3366cc, 'pirate', 'captain');
  const face = { beard: 0, moustache: 0 };
  parts.head.parent.updateMatrixWorld(true);
  captain.userData.animation.parts.head.traverse((o) => {
    if (o.isMesh && face[o.name] !== undefined) face[o.name] += 1;
  });
  expect(`captain has exactly one beard (${face.beard}) and one moustache (${face.moustache})`,
    face.beard === 1 && face.moustache === 1,
    'the base face and the captain branch both added a set: two chins, z-fighting where they coincide');
  expect('captains wear the hat instead of the bandana', !captain.userData.animation.parts.bandana.visible);
}

// ── 2. pose pops across state edges (pirate) ───────────────────────────────
console.log('\n[state edges: one-frame joint deltas]');
{
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const parts = mesh.userData.animation.parts;
  const EDGES = [
    ['idle', {}, 'crouch', { crouching: true }],
    ['idle', {}, 'helm', { atHelm: true }],
    ['walk', { velocity: { x: 4, y: 0, z: 0 } }, 'idle', {}],
    ['idle', {}, 'cannon', { atCannon: true }],
    ['idle', {}, 'block', { activeSlot: 0, blocking: true }],
  ];
  for (const [fromName, from, toName, to] of EDGES) {
    scenarioSwing = 0;
    run(mesh, makePlayer(from), null, 30);
    const before = snapshotJoints(parts);
    run(mesh, makePlayer(to), null, 1);
    const { worst, at } = maxJointDelta(before, snapshotJoints(parts));
    expect(`${fromName} → ${toName}: largest one-frame joint turn ${worst.toFixed(2)} rad (${at}) < ${POP_MAX_RAD}`, worst < POP_MAX_RAD,
      'no cross-fade: the pose snaps in a single frame');
  }
}

// ── 2b. what the replicated fields must SHOW (POSE-01 / avatar-07, 08, 22) ──
// Every one of these is a field the server already sends and the animator used
// to ignore: look pitch, hullRepairProgress, equippedTool. A crewmate patching
// a hole looked like an idle pirate with a cutlass, and a man squinting up at
// the crow's nest looked straight ahead.
console.log('\n[replicated fields the pose must express]');
{
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const parts = mesh.userData.animation.parts;

  // avatar-07: look pitch reaches the head.
  scenarioSwing = 0;
  run(mesh, makePlayer({ rotation: { x: 0, y: -0.5 } }), null, 30);
  expect(`look up (pitch -0.5): head.x ${parts.head.rotation.x.toFixed(3)} < -0.2`,
    parts.head.rotation.x < -0.2, 'the head never showed pitch: everyone looked straight ahead');
  run(mesh, makePlayer({ rotation: { x: 0, y: 0.5 } }), null, 30);
  expect(`look down (pitch +0.5): head.x ${parts.head.rotation.x.toFixed(3)} > 0.2`,
    parts.head.rotation.x > 0.2);

  // avatar-08: the carpenter. Sampled across a whole hammer cycle, because the
  // beat is on the shared clock — one lucky frame must not carry the check.
  let armMin = Infinity, armMax = -Infinity, torsoMin = Infinity;
  const repairing = makePlayer({ hullRepairProgress: 0.5 });
  run(mesh, repairing, null, 30);
  for (let i = 0; i < 90; i++) {
    run(mesh, repairing, null, 1);
    armMin = Math.min(armMin, parts.rightArmPivot.rotation.x);
    armMax = Math.max(armMax, parts.rightArmPivot.rotation.x);
    torsoMin = Math.min(torsoMin, parts.torso.rotation.x);
  }
  expect(`hull repair: he stoops over the breach (torso.x ${torsoMin.toFixed(2)} > 0.3 all cycle)`, torsoMin > 0.3,
    'no repair pose at all: hullRepairProgress was never read');
  expect(`hull repair: the hammer arm reaches ${armMin.toFixed(2)} < -1.0`, armMin < -1.0);
  expect(`hull repair: the hammer SWINGS (arc ${(armMax - armMin).toFixed(2)} rad > 0.6)`, armMax - armMin > 0.6,
    'a frozen arm is a pose, not a repair');
  expect('hull repair: the hand hangs off a WRIST joint the tool can be aimed on',
    parts.rightHand.parent?.name === 'right-wrist',
    'the socket was the hand sphere bolted straight to the upper arm');

  // avatar-08: tools.
  run(mesh, makePlayer({ equippedTool: 'spyglass' }), null, 30);
  expect(`spyglass: the glass arm comes up to the eye (right arm x ${parts.rightArmPivot.rotation.x.toFixed(2)} < -1.2)`,
    parts.rightArmPivot.rotation.x < -1.2, 'equippedTool was never read by the animator');
  const shovelPlayer = makePlayer({ equippedTool: 'shovel' });
  run(mesh, shovelPlayer, null, 30);
  let digMin = Infinity, digMax = -Infinity;
  for (let i = 0; i < 90; i++) {
    run(mesh, shovelPlayer, null, 1);
    digMin = Math.min(digMin, parts.rightArmPivot.rotation.x);
    digMax = Math.max(digMax, parts.rightArmPivot.rotation.x);
  }
  expect(`shovel: a dig CYCLE, not a hold (arc ${(digMax - digMin).toFixed(2)} rad > 0.4)`, digMax - digMin > 0.4);

  // avatar-22: the wrist. The weapon socket must hold its aim through a stride.
  const walker = makePlayer({ velocity: { x: 4, y: 0, z: 0 } });
  run(mesh, walker, null, 40);
  let pitchMin = Infinity, pitchMax = -Infinity;
  const fwd = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const socket = parts.rightWrist ?? parts.rightHand;
  for (let i = 0; i < 120; i++) {
    run(mesh, walker, null, 1);
    socket.getWorldQuaternion(q);
    fwd.set(0, -1, 0).applyQuaternion(q);
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    pitchMin = Math.min(pitchMin, pitch);
    pitchMax = Math.max(pitchMax, pitch);
  }
  expect(`walk 4 m/s: the weapon socket holds its aim (pitch swing ${(pitchMax - pitchMin).toFixed(3)} rad < 0.15)`,
    pitchMax - pitchMin < 0.15,
    'no wrist: the blade/muzzle swings a full stride with the shoulder');
}

// ── 2c. what you see of yourself, and what you can read on everyone else ────
// avatar-10 (own body never drawn), avatar-21 (floating UI rides the pitched
// group), avatar-19 (3.4 m world-sized nameplates).
console.log('\n[own body, floating UI, nameplates]');
{
  const base = { isDead: false, skeletonDeathVisible: false, pirateCorpseVisible: false, tooSmallToDraw: false, useLocalSwimViewmodel: false };
  expect('alive local pirate with the body enabled is DRAWN',
    playerMeshVisible({ ...base, isLocal: true, localBodyDrawn: true }) === true,
    'looking down showed nothing and the deck never had your shadow');
  expect("the 'low' tier keeps the old behaviour (no local body)",
    playerMeshVisible({ ...base, isLocal: true, localBodyDrawn: false }) === false);
  expect('your corpse is still drawn for the death camera',
    playerMeshVisible({ ...base, isLocal: true, isDead: true, pirateCorpseVisible: true, localBodyDrawn: false }) === true);
  expect('too small to draw still wins over everything',
    playerMeshVisible({ ...base, isLocal: true, localBodyDrawn: true, tooSmallToDraw: true }) === false);
  expect('remotes are unaffected',
    playerMeshVisible({ ...base, isLocal: false }) === true
    && playerMeshVisible({ ...base, isLocal: false, isDead: true }) === false);
  const gameSrc2 = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  expect('Game.ts no longer short-circuits the per-part visibility for the local body',
    !/const hideForLocalAim = isLocal;/.test(gameSrc2) && /localBodyDrawn/.test(gameSrc2));

  // avatar-21: the bar over a PITCHED body.
  const swimmer = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const parts = swimmer.userData.animation.parts;
  const bar = swimmer.userData.healthBar.root;
  scenarioSwing = 0;
  run(swimmer, makePlayer({ state: 'swimming', velocity: { x: 2, y: 0, z: 0 } }), null, 30);
  swimmer.rotation.x = 1.26;              // the swim pitch Game applies about the soles
  swimmer.updateMatrixWorld(true);
  bar.position.copy(hudAnchorLocal(swimmer, parts.head, 0.42, new THREE.Vector3()));
  swimmer.updateMatrixWorld(true);
  const headW = parts.head.getWorldPosition(new THREE.Vector3());
  const barW = bar.getWorldPosition(new THREE.Vector3());
  const horiz = Math.hypot(barW.x - headW.x, barW.z - headW.z);
  expect(`swimmer: the health bar sits over his head, not ahead of him (${horiz.toFixed(2)} m horizontally < 0.15)`,
    horiz < 0.15, 'the bar is a child of the group Game pitches by 1.26 rad about the feet');
  expect(`swimmer: the bar is 0.42 m above the head (${(barW.y - headW.y).toFixed(2)})`,
    Math.abs((barW.y - headW.y) - 0.42) < 0.05);

  // avatar-19: a nameplate the same readable size at 5 m and at 50 m.
  const plate = makeNameplateSprite('Blackbeard');
  const FOV = 70;
  const focal = 1 / Math.tan((FOV * Math.PI) / 360);
  // three's sprite shader: with sizeAttenuation OFF the scale is multiplied by
  // the view depth, which cancels the perspective divide exactly.
  const screenFrac = (d) => (plate.material.sizeAttenuation === false
    ? plate.scale.y * focal / 2
    : (plate.scale.y / d) * focal / 2);
  const near = screenFrac(5);
  const far = screenFrac(50);
  const TARGET = NAMEPLATE_SCREEN_H * focal / 2;
  expect(`nameplate at 5 m covers ${(near * 100).toFixed(1)}% of the screen height, within 20% of ${(TARGET * 100).toFixed(1)}%`,
    Math.abs(near - TARGET) <= TARGET * 0.2,
    'a 2.8 m world billboard is wider than the pirate is tall up close');
  expect(`nameplate at 50 m covers ${(far * 100).toFixed(1)}% of the screen height, within 20% of ${(TARGET * 100).toFixed(1)}%`,
    Math.abs(far - TARGET) <= TARGET * 0.2,
    'a world-sized plate at 50 m is a three-pixel smear');
  expect('nameplates keep their occlusion (depthTest ON: names must not read through rock)',
    plate.material.depthTest === true);
}

// ── 2d. the buffered remote, the truthful flinch, the tinted sleeve ─────────
// avatar-25/12 (body yaw and gait off the newest raw snapshot while the body is
// drawn 1-2 snapshots behind), avatar-09 (a "directional" hit reaction with a
// random direction), avatar-18 (first-person sleeves stuck brown).
console.log('\n[remote timeline, flinch direction, sleeve tint]');
{
  const gameSrc3 = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  expect('remote body yaw comes from the interpolated pose, not the newest raw snapshot',
    /remotePose\?\.yaw \?\? player\.rotation\.x/.test(gameSrc3)
    && !/: isLocal\n\s*\? this\.input\.getYaw\(\)\n\s*: player\.rotation\.x;/.test(gameSrc3),
    'the ring already held the interpolated yaw and Game threw it away');
  expect('the body HOLDS while the head turns, and swings only when it must',
    /bodyYawHeld/.test(gameSrc3) && /Math\.abs\(off\) > 0\.6/.test(gameSrc3));
  expect('the flinch direction is derived from lastDamagedById',
    /lastDamagedById \? this\.playerMeshes\.get/.test(gameSrc3)
    && !/yaw: \(Math\.random\(\) - 0\.5\) \* 0\.8,/.test(gameSrc3),
    'a pirate shot from the left could twist right');
  expect('the animator is handed the buffered pitch/velocity for remotes',
    /animatePlayerMesh\(mesh, player, ship, dt, remoteAnim\)/.test(gameSrc3));

  // The consumer: the additive reaction must actually USE that yaw, and in the
  // right direction, or deriving it truthfully buys nothing.
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const parts = mesh.userData.animation.parts;
  scenarioSwing = 0;
  const still = makePlayer();
  run(mesh, still, null, 20);
  mesh.userData.flinch = { t: 0, mag: 1, yaw: 1.0 };
  run(mesh, still, null, 1);
  const twistRight = parts.torso.rotation.y;
  run(mesh, still, null, 20);
  mesh.userData.flinch = { t: 0, mag: 1, yaw: -1.0 };
  run(mesh, still, null, 1);
  const twistLeft = parts.torso.rotation.y;
  expect(`the torso twists TOWARD the hit (+yaw ${twistRight.toFixed(3)} > 0 > ${twistLeft.toFixed(3)} -yaw)`,
    twistRight > 0.01 && twistLeft < -0.01);

  // avatar-12: the animator reads the buffered pitch, not the raw one.
  run(mesh, makePlayer({ rotation: { x: 0, y: 0 } }), null, 30);
  for (let i = 0; i < 30; i++) { clock += 1 / 60; animator.animatePlayerMesh(mesh, makePlayer({ rotation: { x: 0, y: 0 } }), null, 1 / 60, { pitch: -0.5, vx: 0, vz: 0 }); }
  expect(`a remote's head follows the BUFFERED pitch (head.x ${parts.head.rotation.x.toFixed(3)} < -0.2)`,
    parts.head.rotation.x < -0.2,
    'the raw snapshot pitch would step the head at the 31 Hz snapshot rate');

  // avatar-18: the sleeve.
  const hand = makeViewHand(1);
  const before = hand.userData.viewCoatMat.color.getHex();
  applyViewHandTeamColor(hand, 0xff0000);
  const after = hand.userData.viewCoatMat.color;
  const want = new THREE.Color(0xff0000).lerp(new THREE.Color(0x2a1d14), 0.34);
  expect(`the first-person forearm wears the crew tint (#${after.getHexString()} == #${want.getHexString()})`,
    Math.abs(after.r - want.r) < 1e-6 && Math.abs(after.g - want.g) < 1e-6 && Math.abs(after.b - want.b) < 1e-6,
    `it was a hard-coded #${before.toString(16)} while the world coat was team-tinted`);
  expect('a second call with the same colour is a no-op (no per-frame material write)',
    (() => { const h = hand.userData.viewTeamColor; applyViewHandTeamColor(hand, 0xff0000); return hand.userData.viewTeamColor === h; })());
}

// ── 3. corpse ──────────────────────────────────────────────────────────────
console.log('\n[corpse t=3 s]');
for (const cause of ['shot', 'cutlass', 'fall']) {
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const corpse = { t: 0, cause, side: 1, baseYaw: 0.3, spin: 0.2, basePos: { x: 0, y: 0, z: 0 } };
  for (let i = 0; i < 180; i++) animator.animateCorpse(mesh, corpse, 1 / 60);
  mesh.updateMatrixWorld(true);
  const body = partBounds(mesh, isBody);
  expect(`corpse (${cause}): lies on the ground — bottom ${body.min.toFixed(2)} ≥ -0.10, top ${body.max.toFixed(2)} ≤ 0.80`,
    body.min >= -0.10 && body.max <= 0.80,
    body.max > 0.8 ? 'propped: the body is still standing up off the deck' : 'sunk below the deck');
}

// ── 4. FOOT PLANT ON A REAL SURFACE (ANIMPOL / avatar-15) ──────────────────
// avatar-15's witness: "legs swing about the hip with no ground contact solve;
// on a rolling deck the downhill foot floats and the uphill foot sinks". The
// animator stood every pirate on a flat plane through the group origin, so on a
// hull heeled 0.2 rad the two boots were at the SAME height while the planking
// under them was 5.5 cm apart.
//
// The plane is not this suite's opinion: it is `getShipFloorYAt`, the shared
// function the server collides the walker against, sampled under each boot.
console.log('\n[4. foot plant]');
{
  const heeled = (roll, pitch) => ({
    id: 'deck', type: 'sloop', position: { x: 0, y: 0, z: 0 }, rotation: 0,
    pitch, roll, angularVelocity: 0,
  });
  // Where a boot centre sits in the hull frame when the body faces +z at origin.
  const planeAt = (ship, lx, lz, originY) => getShipFloorYAt(
    { x: lx, y: originY + 0.02, z: lz }, ship,
  ) - originY;

  for (const [label, roll, pitch] of [['heeled 0.20 rad', 0.2, 0], ['storm heel 0.35 rad', 0.35, 0.06]]) {
    const ship = heeled(roll, pitch);
    const originY = getShipFloorYAt({ x: 0, y: 4, z: 0 }, ship);
    const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
    mesh.position.set(0, originY, 0);
    const player = makePlayer({ onShipId: 'deck' });
    run(mesh, player, ship, 40);
    mesh.updateMatrixWorld(true);
    const soleL = partBounds(mesh, isLeftBoot).min - originY;
    const soleR = partBounds(mesh, isRightBoot).min - originY;
    // The plane is read RELATIVE TO ITSELF between the boots. The solve is
    // centred on purpose: the group origin is the seat Match and PhysicsSystem
    // agree on, and a solve that moved the body off it to chase a ramp under
    // one toe would put a pirate somewhere the server does not have her. What
    // it owes is the STRADDLE — that the two soles sit on the surface's slope.
    const rawL = planeAt(ship, -AVATAR_RIG.legPivotX, AVATAR_RIG.bootZ, originY);
    const rawR = planeAt(ship, AVATAR_RIG.legPivotX, AVATAR_RIG.bootZ, originY);
    const planeMid = (rawL + rawR) * 0.5;
    const planeL = rawL - planeMid;
    const planeR = rawR - planeMid;
    expect(`${label}: LEFT sole on the deck plane (${soleL.toFixed(3)} vs ${planeL.toFixed(3)}, |Δ| ≤ ${DECK_TOL})`,
      Math.abs(soleL - planeL) <= DECK_TOL,
      'the boot stands on a flat plane through the origin, not on the planking');
    expect(`${label}: RIGHT sole on the deck plane (${soleR.toFixed(3)} vs ${planeR.toFixed(3)}, |Δ| ≤ ${DECK_TOL})`,
      Math.abs(soleR - planeR) <= DECK_TOL,
      'the boot stands on a flat plane through the origin, not on the planking');
    // The pair must actually STRADDLE the slope. Two boots that are both 2.7 cm
    // wrong in opposite directions can each squeak under a tolerance; a stance
    // that never opens at all cannot.
    const spread = Math.abs(soleR - soleL);
    const want = Math.abs(planeR - planeL) * 0.8;
    expect(`${label}: the stance straddles the slope (boot spread ${spread.toFixed(3)} ≥ ${want.toFixed(3)})`,
      spread >= want, 'both boots sat at the same height on a tilted deck');
  }

  // Ashore: the same solve off the drawn ground sampler, on a 1-in-4 slope.
  {
    const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
    mesh.position.set(0, 0, 0);
    const slope = 0.25;
    const hillView = { ...view, groundYAt: (x) => x * slope };
    const hillAnimator = new PlayerAnimator(hillView);
    const player = makePlayer({});
    for (let i = 0; i < 40; i++) { clock += 1 / 60; hillAnimator.animatePlayerMesh(mesh, player, null, 1 / 60); }
    mesh.updateMatrixWorld(true);
    const soleL = partBounds(mesh, isLeftBoot).min;
    const soleR = partBounds(mesh, isRightBoot).min;
    const mid = 0;
    expect(`hillside 1-in-4: LEFT sole on the hill (${soleL.toFixed(3)} vs ${(-AVATAR_RIG.legPivotX * slope - mid).toFixed(3)})`,
      Math.abs(soleL - (-AVATAR_RIG.legPivotX * slope)) <= DECK_TOL,
      'the animator never asked the terrain how high it was under the boot');
    expect(`hillside 1-in-4: RIGHT sole on the hill (${soleR.toFixed(3)} vs ${(AVATAR_RIG.legPivotX * slope).toFixed(3)})`,
      Math.abs(soleR - AVATAR_RIG.legPivotX * slope) <= DECK_TOL,
      'the animator never asked the terrain how high it was under the boot');
  }

  // Flat ground must be bit-identical to before the solve: an avatar on a deck
  // with no attitude, and one with no ground sampler at all, may not move.
  {
    const flatShip = { id: 'deck', type: 'sloop', position: { x: 0, y: 0, z: 0 }, rotation: 0, pitch: 0, roll: 0, angularVelocity: 0 };
    const originY = getShipFloorYAt({ x: 0, y: 4, z: 0 }, flatShip);
    const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
    mesh.position.set(0, originY, 0);
    run(mesh, makePlayer({ onShipId: 'deck' }), flatShip, 20);
    mesh.updateMatrixWorld(true);
    const soleL = partBounds(mesh, isLeftBoot).min - originY;
    const soleR = partBounds(mesh, isRightBoot).min - originY;
    expect(`flat deck: the solve is a no-op (soles ${soleL.toFixed(4)} / ${soleR.toFixed(4)} in [${BOOT_MIN}, ${BOOT_MAX}])`,
      soleL >= BOOT_MIN && soleL <= BOOT_MAX && soleR >= BOOT_MIN && soleR <= BOOT_MAX
        && Math.abs(soleL - soleR) < 1e-9);
  }
}

// ── 5. WALK AND AIM AT ONCE (avatar-15: upper and lower body are welded) ────
// "a walking gunner cannot aim". The gunner is only honest if BOTH halves move:
// the legs must still cycle through a stride while the weapon arm is up.
console.log('\n[5. walk + aim]');
{
  const mesh = makePlayerMesh(0x3366cc, 'pirate', 'crew');
  const player = makePlayer({ velocity: { x: 4, y: 0, z: 0 }, weapons: [pistol(), null, null, null], activeSlot: 0 });
  const parts = mesh.userData.animation.parts;
  let legMin = Infinity; let legMax = -Infinity; let armMin = Infinity;
  for (let i = 0; i < 60; i++) {
    clock += 1 / 60;
    animator.animatePlayerMesh(mesh, player, null, 1 / 60);
    legMin = Math.min(legMin, parts.rightLegPivot.rotation.x);
    legMax = Math.max(legMax, parts.rightLegPivot.rotation.x);
    armMin = Math.min(armMin, parts.rightArmPivot.rotation.x);
  }
  expect(`walking + aiming: the legs still cycle (right thigh swept ${(legMax - legMin).toFixed(2)} rad > 0.3)`,
    legMax - legMin > 0.3, 'the weapon pose froze the legs — upper and lower body are welded');
  expect(`walking + aiming: the weapon arm is raised (right shoulder ${armMin.toFixed(2)} ≤ -0.7)`,
    armMin <= -0.7, 'the arm hung at the side while walking');
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
