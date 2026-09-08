/**
 * THE SKINNED PIRATE (RIG-01 / avatar-14 phase B, avatar-13).
 *
 * `pirate_base.glb` is one 23-bone skeleton carrying a body, six heads, three
 * hats and two coats, plus the 33 clips of PLAN §2.5. This module turns that
 * file into a player:
 *
 *   BUILD   `makePlayerRig` clones the loaded scene with SkeletonUtils (three's
 *           Object3D.clone copies a SkinnedMesh's skeleton BY REFERENCE, so
 *           every pirate would pose off one set of bones that live in no scene
 *           and never update — twelve pirates frozen in one shared pose), drops
 *           the variants this pirate is not wearing, and tints the one
 *           `TeamTint` material the coat and bandana share.
 *
 *   DRIVE   `updatePlayerRig` is a two-layer state machine over an
 *           AnimationMixer. Clips are split ONCE, at load, into a LOWER mask
 *           (root/hips/legs) and an UPPER mask (spine/arms/head) by dropping
 *           tracks; the two layers therefore write disjoint bones and never
 *           fight over a weight. That is what lets a pirate aim a pistol while
 *           her legs keep walking — the thing avatar-15 says today's welded
 *           animator cannot do. Every transition is a 0.12 s cross-fade.
 *
 *   SOLVE   Two post-solvers survive the move to bones, because a clip cannot
 *           know about the world: the head look-at (yaw ±0.6, pitch ±0.5) and
 *           the sole solve that lifts the hips so the lower boot sits ON the
 *           deck rather than through it (AVATAR-01's invariant, now on bones).
 *
 * COST ON THE LOW TIER: NONE. `makePlayerRig` returns null unless the caller
 * passes a balanced/high tier, and null means Game keeps `makePlayerMesh` —
 * which is also what happens if the GLB has not loaded or ever ships without
 * clips. Above low the per-frame bill is one `mixer.update` per visible pirate,
 * and that is rate-limited by distance (see MIXER_LOD): full rate inside 25 m,
 * half beyond, quarter beyond 60 m, frozen past 120 m where a pirate is a few
 * pixels. A pirate is 2,780 tris in 7 draws against 22-26 draws today.
 */
import * as THREE from 'three';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER, WEAPONS } from '../../../shared/constants/index.js';
import type { Player } from '../../../shared/types/index.js';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import type { RenderQuality } from '../QualityPreference.js';
import { AVATAR_RIG } from './PlayerMeshFactory.js';

const RIG_ASSET = 'pirate_base' as string as AssetName;

/** Bones the LOWER layer owns. Everything else is the UPPER layer's. */
const LOWER_BONES = new Set([
  'root', 'hips',
  'thigh_l', 'shin_l', 'foot_l', 'toe_l',
  'thigh_r', 'shin_r', 'foot_r', 'toe_r',
]);

/** PLAN §2.5: cross-fade 0.12 s. One number, used by both layers. */
const CROSSFADE = 0.12;

/** Clips that are a whole-body statement — while one of these is the lower
 *  state the upper layer plays its own upper half and no weapon pose overrides
 *  it (a helmsman does not aim a pistol at the wheel). */
const FULL_BODY = new Set([
  'helm', 'cannon_aim', 'cannon_fire', 'capstan_push', 'bail', 'dig', 'hammer',
  'swim', 'tread', 'climb', 'downed', 'revive',
  'death_shot', 'death_fall', 'death_drown',
]);

const ONE_SHOT = new Set([
  'jump', 'land', 'cannon_fire', 'fire_pistol', 'reload',
  'cutlass_swing_a', 'cutlass_swing_b', 'hit_front', 'hit_back', 'revive',
  'death_shot', 'death_fall', 'death_drown',
]);

/**
 * How often the mixer is stepped, by distance to the camera. A pirate at 80 m
 * is ~30 px tall; stepping her skeleton 60 times a second buys nothing a player
 * can see and costs the same as the one in your face. dt is ACCUMULATED, never
 * dropped, so a pirate stepped at quarter rate still plays her clip at the
 * right speed — she just does it in bigger steps.
 */
const MIXER_LOD: readonly { d2: number; interval: number }[] = [
  { d2: 25 * 25, interval: 0 },
  { d2: 60 * 60, interval: 1 / 30 },
  { d2: 120 * 120, interval: 1 / 15 },
];
/** Past this the mixer stops entirely: the pose freezes where it was. */
const MIXER_FREEZE_D2 = 120 * 120;

/**
 * Past this range a pirate stops casting a shadow.
 *
 * avatar-13's second complaint after the draw count is that every one of the
 * old body's 22-26 meshes had castShadow=true, so a crowd cost its draws TWICE
 * on balanced and high. The rig is 7, but 7 is still 14 with the shadow pass,
 * and the shadow of a 1.75 m figure at 40 m falls inside a couple of shadow-map
 * texels — it is a smudge you cannot attribute to a person. Toggling
 * `castShadow` costs nothing (it is a render-list flag, not a material change,
 * so nothing re-links), and it is the cheapest halving of a crowd's cost there
 * is.
 */
const SHADOW_D2 = 40 * 40;

/** The span PlayerAnimator sampled the two surface heights over. It is the
 *  SAMPLE span, not the rig's own foot span (±0.112 m, pirate_rig.py HIP_X):
 *  dividing by it turns the two heights back into the surface's angle, and a
 *  pelvis rolled by that angle lifts a foot at ANY offset to its own height. */
const FOOT_SPAN_X = AVATAR_RIG.legPivotX * 2;
/** A pelvis braces up to ~17°; past that a sailor squats or grabs a shroud, and
 *  a body rolled further than this reads as a mannequin nailed to the deck. */
const PELVIS_ROLL_MAX = 0.3;

type ClipPair = { lower: THREE.AnimationClip; upper: THREE.AnimationClip };

/** Masked clips are immutable data and are shared by every pirate's mixer. */
let clipCache: Map<string, ClipPair> | null = null;
/** One tinted material per crew colour, shared by every pirate in that crew. */
const tintCache = new Map<number, THREE.MeshStandardMaterial>();

function splitClips(source: readonly THREE.AnimationClip[]): Map<string, ClipPair> {
  const out = new Map<string, ClipPair>();
  for (const clip of source) {
    const lower: THREE.KeyframeTrack[] = [];
    const upper: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      // track.name is "<boneName>.<property>"
      const bone = track.name.slice(0, track.name.indexOf('.'));
      (LOWER_BONES.has(bone) ? lower : upper).push(track);
    }
    out.set(clip.name, {
      lower: new THREE.AnimationClip(`${clip.name}#lo`, clip.duration, lower),
      upper: new THREE.AnimationClip(`${clip.name}#up`, clip.duration, upper),
    });
  }
  return out;
}

export type RigLayer = {
  action: THREE.AnimationAction | null;
  name: string;
};

/** Everything a rigged pirate carries, on `mesh.userData.rig`. */
export type PlayerRig = {
  mixer: THREE.AnimationMixer;
  root: THREE.Group;
  lower: RigLayer;
  upper: RigLayer;
  bones: {
    head: THREE.Bone | null;
    hips: THREE.Bone | null;
    /** First spine bone: takes the pelvis roll back out so the head stays plumb. */
    spine: THREE.Bone | null;
    footL: THREE.Bone | null;
    footR: THREE.Bone | null;
  };
  /** Bind-pose hip height, so the sole solve has something to return to. */
  hipsRestY: number;
  /** The head's CLIP-driven pitch, without the look-at solve on top of it.
   *  The solve has to write absolutely, and it cannot just read the bone after
   *  a mixer step to find the clip value: three's PropertyMixer only calls
   *  setValue when the accumulated value CHANGED, so a head track that holds
   *  still (every idle/walk/helm clip) leaves the bone exactly as the previous
   *  frame left it — including our own offset. So we stash the clip value,
   *  restore it before every mixer step, and write base+pitch after. */
  headClipX: number;
  /** …and the same for the yaw the look-at solve adds (ANIMPOL). */
  headClipY: number;
  /** The same stash for the two bones the foot plant writes absolutely. */
  hipsClipZ: number;
  spineClipZ: number;
  /** Damped surface roll the pelvis is currently carrying (ANIMPOL). */
  pelvisRoll: number;
  /** Accumulated, unspent dt for the distance-rate-limited mixer step. */
  pending: number;
  /** The one-shot the upper layer is committed to, and its remaining time. */
  oneShot: number;
  /** Latch so a swing/fire/hit edge fires its clip exactly once. */
  prevSwing: number;
  prevHealth: number;
  /** Alternating swing so two cuts in a row are not the same cut. */
  swingFlip: number;
  /** Whether this pirate is currently in the shadow-casting band. */
  casting: boolean;
  /** Her skinned parts, so the shadow toggle is a loop over 7 and not a
   *  traverse of the whole body every frame. */
  skins: THREE.Mesh[];
};

/** True when the GLB is loaded AND actually carries skin + clips. */
export function rigAssetReady(): boolean {
  const src = assets.source(RIG_ASSET);
  if (!src || src.animations.length === 0) return false;
  let skinned = false;
  src.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
  return skinned;
}

/** Deterministic per-player variant pick — the same pirate is the same pirate
 *  on every client, and across a reconnect. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

const HEADS = ['head_a', 'head_b', 'head_c', 'head_d', 'head_e', 'head_f'] as const;
const HATS = ['hat_tricorn', 'hat_bandana', 'hat_bare'] as const;
const COATS = ['coat_long', 'coat_short'] as const;
/** Every modular part in the file — the set the dresser removes from. */
const ALL_PARTS: ReadonlySet<string> = new Set<string>(['body', ...HEADS, ...HATS, ...COATS]);

function teamMaterial(color: number): THREE.MeshStandardMaterial {
  const hit = tintCache.get(color);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.78 });
  m.name = 'TeamTint';
  tintCache.set(color, m);
  return m;
}

/**
 * A dressed, skinned pirate — or null, which means "use makePlayerMesh".
 *
 * Null is returned on the low tier (a skinning shader variant and a mixer per
 * avatar is exactly the bill the weakest machine should not pay), for the
 * island SKELETON variant (a different body altogether — it keeps the
 * procedural bones), and whenever the asset is not there or not skinned.
 */
export function makePlayerRig(
  color: number,
  variant: 'pirate' | 'skeleton',
  // The same union Game already passes makePlayerMesh: a raider dresses as crew.
  role: 'crew' | 'captain' | 'raider',
  playerId: string,
  quality: RenderQuality,
): THREE.Group | null {
  if (quality === 'low' || variant === 'skeleton') return null;
  const src = assets.source(RIG_ASSET);
  if (!src || !rigAssetReady()) return null;

  if (!clipCache) clipCache = splitClips(src.animations);

  const root = cloneSkinnedScene(src.scene) as THREE.Group;
  const h = hashId(playerId);
  const wornHead = HEADS[h % HEADS.length];
  // A captain always reads as a captain: tricorn, long coat.
  const wornHat = role === 'captain' ? 'hat_tricorn' : HATS[(h >>> 3) % HATS.length];
  const wornCoat = role === 'captain' ? 'coat_long' : COATS[(h >>> 6) % COATS.length];
  const keep = new Set<string>(['body', wornHead, wornHat, wornCoat]);

  // A part with more than one material comes out of GLTFLoader as a GROUP
  // named `body` holding `body_0`, `body_1`, ... — so the variant drop has to
  // walk NAMED PARTS, not meshes, or it deletes the body and the head (the two
  // multi-material parts) and dresses a pirate in a hat and a coat.
  const drop: THREE.Object3D[] = [];
  root.traverse((o) => { if (ALL_PARTS.has(o.name) && !keep.has(o.name)) drop.push(o); });
  // Geometry and the untinted materials belong to the AssetLibrary and are
  // shared with every other pirate: unhook the variants, never dispose them.
  for (const o of drop) o.removeFromParent();

  const tint = teamMaterial(color);
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh && !(o as THREE.Mesh).isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // a skinned pose can leave its bind bounds
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const swapped = mats.map((m) => (m.name === 'TeamTint' ? tint : m));
    mesh.material = Array.isArray(mesh.material) ? swapped : swapped[0];
  });

  const group = new THREE.Group();
  group.add(root);

  const mixer = new THREE.AnimationMixer(root);
  const bone = (name: string) => (root.getObjectByName(name) as THREE.Bone | undefined) ?? null;
  const hips = bone('hips');
  const rig: PlayerRig = {
    mixer,
    root,
    lower: { action: null, name: '' },
    upper: { action: null, name: '' },
    bones: { head: bone('head'), hips, spine: bone('spine1'), footL: bone('foot_l'), footR: bone('foot_r') },
    hipsRestY: hips?.position.y ?? 0,
    headClipX: bone('head')?.rotation.x ?? 0,
    headClipY: bone('head')?.rotation.y ?? 0,
    hipsClipZ: hips?.rotation.z ?? 0,
    spineClipZ: bone('spine1')?.rotation.z ?? 0,
    pelvisRoll: 0,
    pending: 0,
    oneShot: 0,
    prevSwing: 0,
    prevHealth: Number.POSITIVE_INFINITY,
    swingFlip: 0,
    casting: true,
    skins: [],
  };
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) rig.skins.push(o as THREE.Mesh); });
  group.userData.rig = rig;
  // Game and PlayerAnimator both branch on `animation.variant`; keeping the
  // same shape (with an EMPTY parts table) means the procedural animator bails
  // out on its first line instead of half-driving a rig.
  group.userData.animation = { phase: 0, variant, parts: undefined };
  group.userData.teamColor = color;
  // applyPlayerTeamColor writes coat → cloth → belt → bandana in that order and
  // the last write wins, so pointing all four at the one shared tint gives the
  // crew colour exactly.
  group.userData.teamMaterials = { coatMat: tint, clothMat: tint, beltMat: tint, bandanaMat: tint };

  const healthBarRoot = new THREE.Group();
  healthBarRoot.position.set(0, AVATAR_RIG.overheadY, 0);
  healthBarRoot.visible = false;
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.14),
    new THREE.MeshBasicMaterial({ color: 0x081015, transparent: true, opacity: 0.82, depthWrite: false }),
  );
  back.position.z = -0.003;
  back.renderOrder = 10;
  healthBarRoot.add(back);
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x69d57b, transparent: true, opacity: 0.96, depthWrite: false }),
  );
  fill.position.z = 0.003;
  fill.renderOrder = 11;
  healthBarRoot.add(fill);
  group.add(healthBarRoot);
  group.userData.healthBar = { root: healthBarRoot, fill, fullWidth: 0.7 };

  setLayer(rig, 'lower', 'idle');
  setLayer(rig, 'upper', 'idle');
  return group;
}

/** Is this mesh a rig? Cheap enough to ask every frame. */
export function playerRigOf(mesh: THREE.Object3D): PlayerRig | null {
  return (mesh.userData?.rig as PlayerRig | undefined) ?? null;
}

function setLayer(rig: PlayerRig, which: 'lower' | 'upper', clipName: string) {
  const layer = rig[which];
  if (layer.name === clipName) return;
  const pair = clipCache?.get(clipName);
  if (!pair) return;
  const clip = which === 'lower' ? pair.lower : pair.upper;
  if (clip.tracks.length === 0) return;
  const next = rig.mixer.clipAction(clip);
  const once = ONE_SHOT.has(clipName);
  next.reset();
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.play();
  if (layer.action && layer.action !== next) layer.action.crossFadeTo(next, CROSSFADE, false);
  layer.action = next;
  layer.name = clipName;
}

/** Which whole-body clip a player's replicated state asks for. */
function lowerStateFor(player: Player, moveSpeed: number): string {
  if (player.state === 'downed') return 'downed';
  if (player.state === 'swimming') return moveSpeed > 0.6 ? 'swim' : 'tread';
  if (player.mastClimb !== null) return 'climb';
  if (player.atHelm) return 'helm';
  if (player.atCannon) return 'cannon_aim';
  // `atCapstan` is POSE-01's wire bit and lands with lane 7.5; read it
  // defensively so the clip is wired the day the bit exists and this file does
  // not have to be touched again.
  if ((player as { atCapstan?: boolean }).atCapstan) return 'capstan_push';
  if (player.bailing) return 'bail';
  if ((player.hullRepairProgress ?? 0) > 0) return 'hammer';
  if (player.equippedTool === 'shovel') return 'dig';
  const vy = player.velocity.y ?? 0;
  if (Math.abs(vy) > 1.6) return vy > 0 ? 'jump' : 'fall';
  if (moveSpeed > PLAYER.MOVE_SPEED * 0.72) return 'run';
  if (moveSpeed > 0.4) return 'walk';
  return 'idle';
}

/** What the arms are doing, when the legs are free to do something else. */
function upperStateFor(player: Player, lower: string, rig: PlayerRig, swing: number): string | null {
  if (FULL_BODY.has(lower)) return null;
  const weapon = player.weapons[player.activeSlot];
  if (!weapon) return null;
  if (weapon.weaponId === 'cutlass') {
    if (swing > 0.001) return rig.swingFlip === 0 ? 'cutlass_swing_a' : 'cutlass_swing_b';
    return 'cutlass_idle';
  }
  if (WEAPONS[weapon.weaponId]?.melee) return 'block';
  if (weapon.reloading) return 'reload';
  return 'aim_pistol';
}

/**
 * One rigged pirate, one frame. Returns false when `mesh` is not a rig, so the
 * caller can fall through to the procedural animator.
 *
 * `cameraDistSq` drives MIXER_LOD; pass 0 for the local player.
 */
export function updatePlayerRig(
  mesh: THREE.Group,
  player: Player,
  dt: number,
  cameraDistSq: number,
  lookPitch: number,
  /** Look yaw RELATIVE to the body's facing, so the head turns the way the
   *  player is actually looking instead of staring through her own shoulder. */
  lookYaw: number,
  cutlassSwing: number,
  /** Surface height under the left/right boot relative to the height between
   *  them, from PlayerAnimator's shared-function samples (ANIMPOL, avatar-15).
   *  0/0 = flat, and flat is exactly what RIG-01 shipped. */
  plantL = 0,
  plantR = 0,
): boolean {
  const rig = playerRigOf(mesh);
  if (!rig) return false;

  const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
  const lower = lowerStateFor(player, moveSpeed);
  setLayer(rig, 'lower', lower);

  // One-shots first: a swing edge or a health drop OWNS the arms for its
  // duration, and only then does the steady-state pose come back.
  if (cutlassSwing > 0.001 && rig.prevSwing <= 0.001) {
    rig.swingFlip ^= 1;
    rig.oneShot = 0.62;
  }
  rig.prevSwing = cutlassSwing;
  if (player.health < rig.prevHealth - 0.5 && player.state !== 'downed' && rig.oneShot <= 0) {
    setLayer(rig, 'upper', 'hit_front');
    rig.oneShot = 0.34;
  }
  rig.prevHealth = player.health;
  rig.oneShot = Math.max(0, rig.oneShot - dt);

  if (rig.oneShot <= 0 || FULL_BODY.has(lower)) {
    const upper = upperStateFor(player, lower, rig, cutlassSwing);
    setLayer(rig, 'upper', upper ?? lower);
  }

  // ── mixer, rate-limited by distance ──────────────────────────────────────
  // Undo the head look-at BEFORE the step, so the bone the mixer sees (and the
  // bone it leaves behind when it decides nothing changed) is the clip pose and
  // nothing else. Without this the solve compounds on itself every frame.
  const headBone = rig.bones.head;
  if (headBone) { headBone.rotation.x = rig.headClipX; headBone.rotation.y = rig.headClipY; }
  if (rig.bones.hips) rig.bones.hips.rotation.z = rig.hipsClipZ;
  if (rig.bones.spine) rig.bones.spine.rotation.z = rig.spineClipZ;
  rig.pending += dt;
  let interval = Number.POSITIVE_INFINITY;
  if (cameraDistSq < MIXER_FREEZE_D2) {
    interval = 0;
    for (const step of MIXER_LOD) {
      if (cameraDistSq <= step.d2) { interval = step.interval; break; }
    }
  }
  if (rig.pending >= interval) {
    rig.mixer.update(rig.pending);
    rig.pending = 0;
  } else if (interval === Number.POSITIVE_INFINITY) {
    rig.pending = 0; // frozen: do not bank an hour of dt for the walk back
  }

  // ── shadow LOD ───────────────────────────────────────────────────────────
  const wantCasting = cameraDistSq <= SHADOW_D2;
  if (wantCasting !== rig.casting) {
    rig.casting = wantCasting;
    for (const skin of rig.skins) skin.castShadow = wantCasting;
  }

  // ── post-solvers ─────────────────────────────────────────────────────────
  // Head look-at. A clip cannot know where the player is looking, and a pirate
  // whose skull ignores 90° of aim is the single most obvious tell that she is
  // a puppet. Limits are PLAN §2.5's.
  if (headBone) {
    rig.headClipX = headBone.rotation.x; // whatever the clip left, solve-free
    rig.headClipY = headBone.rotation.y;
    headBone.rotation.x = rig.headClipX + THREE.MathUtils.clamp(lookPitch, -0.5, 0.5);
    // PLAN 2.5's limits. Past 0.6 rad a neck would break, and the shoulders are
    // what should have turned — the body yaw is already tracking, so clamping
    // here reads as a glance rather than as an owl.
    headBone.rotation.y = rig.headClipY + THREE.MathUtils.clamp(lookYaw, -0.6, 0.6);
  }
  if (rig.bones.hips) rig.hipsClipZ = rig.bones.hips.rotation.z;
  if (rig.bones.spine) rig.spineClipZ = rig.bones.spine.rotation.z;

  // FOOT PLANT ON A HEELING DECK (ANIMPOL / avatar-15).
  //
  // A clip is authored on flat ground, so on a hull heeled 0.2 rad the downhill
  // boot floats and the uphill one is inside the planking. A two-bone IK chain
  // would fix that by bending one knee; rolling the PELVIS onto the surface
  // fixes both boots at once, in one write, with no knowledge of a Blender
  // rig's bone axes. Rolling the pelvis by the surface angle moves the boots
  // apart in y by exactly stance-width x angle, which is the height the two
  // samples asked for, and spine1 takes the whole roll straight back out again
  // so the chest, the neck, the head and therefore the server's headshot sphere
  // stay plumb over the seat (avatar-02 — the head may not wander off it).
  const slope = THREE.MathUtils.clamp(
    Math.atan2(plantR - plantL, FOOT_SPAN_X), -PELVIS_ROLL_MAX, PELVIS_ROLL_MAX,
  );
  rig.pelvisRoll += (slope - rig.pelvisRoll) * Math.min(1, dt * 12);
  const { hips: hipsBone, spine } = rig.bones;
  if (hipsBone) hipsBone.rotation.z = rig.hipsClipZ + rig.pelvisRoll;
  if (spine) spine.rotation.z = rig.spineClipZ - rig.pelvisRoll;

  // Sole solve. Even square to the surface, a pose that lifts both feet (or a
  // blend between two clips mid-crossfade) can leave the lower boot hanging or
  // buried. Drop/lift the HIPS so the lower foot is on the surface — two bone
  // reads and one write, no IK chain.
  const { hips, footL, footR } = rig.bones;
  if (hips && footL && footR) {
    rig.root.updateMatrixWorld(true);
    const lowest = Math.min(footYInRoot(rig.root, footL), footYInRoot(rig.root, footR));
    if (Number.isFinite(lowest)) {
      const want = rig.hipsRestY - THREE.MathUtils.clamp(lowest, -0.12, 0.12);
      hips.position.y += (want - hips.position.y) * Math.min(1, dt * 18);
    }
  }
  return true;
}

const FOOT_SCRATCH = new THREE.Vector3();
function footYInRoot(root: THREE.Object3D, foot: THREE.Bone): number {
  FOOT_SCRATCH.setFromMatrixPosition(foot.matrixWorld);
  root.worldToLocal(FOOT_SCRATCH);
  // the sole is ~4.5 cm under the ankle bone (pirate_rig.py foot tail)
  return FOOT_SCRATCH.y - 0.045;
}

/**
 * ADDITIVE HIT FLINCH, ON THE RIG (avatar-15: "flinch is the only additive
 * layer" — and the rigged pirate had lost even that, because the rig branch
 * returns before the procedural animator's applyFlinch).
 *
 * It is written on the clone's ROOT, not on a bone: the mixer never touches the
 * root, so there is no clip value to stash and restore, and a jolt of the whole
 * body toward the shot is what a hit reads as at any range. `k` is the animator's
 * own decay envelope, so the rigged and the boxy body flinch on one clock.
 */
export function applyRigFlinch(mesh: THREE.Group, yaw: number, k: number): void {
  const rig = playerRigOf(mesh);
  if (!rig) return;
  rig.root.rotation.y = rig.pelvisRoll * 0 + yaw * 0.3 * k;
  rig.root.rotation.x = 0.16 * k;
}

/** A rigged corpse: play the death clip for the cause and let it clamp. */
export function playRigDeath(mesh: THREE.Group, cause: string, dt: number): boolean {
  const rig = playerRigOf(mesh);
  if (!rig) return false;
  const clip = cause === 'drown' ? 'death_drown' : cause === 'fall' ? 'death_fall' : 'death_shot';
  setLayer(rig, 'lower', clip);
  setLayer(rig, 'upper', clip);
  // BOTH AXES, or the corpse keeps her last glance (final-sweep P2). three's
  // PropertyMixer only calls setValue when the accumulated value CHANGED, so a
  // head track that holds still leaves the bone exactly as the previous frame
  // left it. [fixup6] established restore-step-reread for the look-at PITCH;
  // [w9.3] b added look-at YAW to updatePlayerRig and did not extend this
  // function, and PlayerAnimator.animateCorpse returns straight after this call
  // for a rigged body, so updatePlayerRig never runs again to undo it. A pirate
  // shot while glancing sideways lay dead with up to 0.6 rad (34 degrees) of
  // baked yaw in her neck for the whole corpse lifetime.
  if (rig.bones.head) {
    rig.bones.head.rotation.x = rig.headClipX;
    rig.bones.head.rotation.y = rig.headClipY;
  }
  rig.mixer.update(dt);
  if (rig.bones.head) {
    rig.headClipX = rig.bones.head.rotation.x;
    rig.headClipY = rig.bones.head.rotation.y;
  }
  return true;
}
