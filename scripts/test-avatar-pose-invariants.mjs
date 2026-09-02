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
//   • head centre within 5 cm of Match's headshot sphere
//     (PLAYER.HEIGHT*0.96 standing, *0.66 crouched, 1.92 island skeleton);
//   • a settled corpse lies on the ground (bottom ≥ -0.1, top ≤ 0.8);
//   • no single frame turns a joint by more than 0.35 rad across a state edge;
//   • visible-mesh count per variant under a fixed budget.
//
// RED ON HEAD (2026-09-02): boots at -0.19 (verifier witness), head at 1.92 vs
// 1.68, crouched head 1.60 vs 1.155, skeleton shins at -0.09. Green is the job
// of AVATAR-01 (wave 2). Do not widen a threshold here to pass: the numbers are
// the server's, not the animator's.
//
//   node --import tsx scripts/test-avatar-pose-invariants.mjs
import * as THREE from 'three';
import { makePlayerMesh } from '../src/client/rendering/factories/PlayerMeshFactory.ts';
import { PlayerAnimator } from '../src/client/rendering/PlayerAnimator.ts';
import { PLAYER } from '../src/shared/constants/index.ts';

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
const POP_MAX_RAD = 0.35;
const MESH_BUDGET = { pirate: 26, skeleton: 26 };

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
 *  to let blends settle, and which invariants apply. `ground` = boots must be on
 *  the deck; `upright` = hands above the shins; `headY` = the server sphere. */
const SCENARIOS = [
  { name: 'idle', player: {}, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'walk 4 m/s', player: { velocity: { x: 4, y: 0, z: 0 } }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'helm', player: { atHelm: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'cannon', player: { atCannon: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'crow nest', player: { atCrowNest: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'climb 0.5', player: { mastClimb: 0.5 }, ground: false, upright: false, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'swim', player: { state: 'swimming', velocity: { x: 2, y: 0, z: 0 } }, ground: false, upright: false, headY: null },
  { name: 'block', player: { activeSlot: 0, blocking: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'cutlass swing 0.4', player: { activeSlot: 0, weapons: [{ ...cutlass(), reloading: true, reloadTimer: 0.33 }, null, null, null] }, swing: 0.4, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'bail', player: { bailing: true, bailScoopProgress: 0.5, bucketFilled: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.96 },
  { name: 'crouch', player: { crouching: true }, ground: true, upright: true, headY: PLAYER.HEIGHT * 0.66 },
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

    const feet = variant === 'skeleton' ? partBounds(mesh, isLeg) : partBounds(mesh, isBoot);
    const footName = variant === 'skeleton' ? 'shin' : 'boot';
    const hands = partBounds(mesh, isHand);
    const headY = parts.head.getWorldPosition(new THREE.Vector3()).y;
    const serverHead = variant === 'skeleton' ? 1.92 : sc.headY;

    if (sc.ground) {
      expect(`${sc.name}: ${footName} sole on the deck (min y ${feet.min.toFixed(3)} in [${BOOT_MIN}, ${BOOT_MAX}])`,
        feet.min >= BOOT_MIN && feet.min <= BOOT_MAX,
        feet.min < BOOT_MIN ? `sunk ${(-feet.min).toFixed(2)} m below the standing surface` : `floating ${feet.min.toFixed(2)} m above it`);
    }
    if (sc.upright && variant === 'pirate') {
      expect(`${sc.name}: hands above the shins (min hand y ${hands.min.toFixed(3)} > ${HAND_MIN_Y})`, hands.min > HAND_MIN_Y);
    }
    if (serverHead !== null && serverHead !== undefined) {
      expect(`${sc.name}: head centre ${headY.toFixed(3)} within ${HEAD_TOL} of the server sphere at ${serverHead.toFixed(3)}`,
        Math.abs(headY - serverHead) <= HEAD_TOL,
        `Match.ts headY = PLAYER.HEIGHT*${player.crouching ? 0.66 : 0.96}; the drawn head is what players aim at`);
    }
  }
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

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
