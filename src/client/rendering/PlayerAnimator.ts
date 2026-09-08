/**
 * Third-person avatar animation: gait, arms, tool/weapon poses, cutlass swing
 * timing, hit reactions, airborne/landing poses and the death crumple. Pure
 * presentation — mesh creation and removal stay in Game.
 */
import * as THREE from 'three';
import { PLAYER, WEAPONS } from '../../shared/constants/index.js';
import type { Player, Ship } from '../../shared/types/index.js';
import { angleWrap } from '../../shared/utils/index.js';
import { getShipFloorYAt, toShipLocalPointInto } from '../../shared/interactions.js';
import { AVATAR_RIG } from './factories/PlayerMeshFactory.js';
import { applyRigFlinch, playRigDeath, updatePlayerRig } from './factories/PlayerRigFactory.js';
import type { InputManager } from '../input/InputManager.js';
import type { OceanRenderer } from './OceanRenderer.js';

/** First-person cutlass charge/lunge timings, shared with the viewmodel code. */
export const CUTLASS_VIEW_CHARGE_TIME = 0.72;
const CUTLASS_VIEW_LUNGE_COOLDOWN = 1.05;

/** How a pirate died — drives which crumple the corpse plays. */
export type DeathCause = 'shot' | 'headshot' | 'cutlass' | 'explosion' | 'drown' | 'fall' | 'generic';

/** Per-corpse procedural death state, owned by Game and ticked by the animator. */
export type CorpseState = {
  /** Seconds since the death edge. */
  t: number;
  cause: DeathCause;
  /** −1 / +1: which way the body tips. */
  side: number;
  /** Extra yaw the body carries as it falls (cutlass kills spin). */
  spin: number;
  /** World position of the feet at the moment of death (corpses do not slide). */
  basePos: THREE.Vector3;
  baseYaw: number;
  weaponDropped: boolean;
  /** Set when the pirate died aboard a ship: Game re-derives `basePos`/`baseYaw`
   *  from the hull each frame so the body rides the deck instead of being left
   *  hanging in the air as the ship sails on. */
  shipId?: string;
  shipLocalX?: number;
  shipLocalZ?: number;
  shipLocalY?: number;
  shipYaw?: number;
};

/** Corpses hold their pose, then sink+fade out of the world. */
export const CORPSE_FADE_START = 6.4;
export const CORPSE_LIFETIME = 8;

/** Metres covered by one full (two-step) gait cycle at a walk — stride lock. */
const GAIT_CYCLE_M = 2.8;

/** The eight corners of a boot, in leg-pivot space (the wider pirate boot, so
 *  the skeleton's foot is covered too). */
const BOOT_CORNERS: THREE.Vector3[] = [];
for (const sx of [-0.0675, 0.0675]) {
  for (const sy of [AVATAR_RIG.bootY - AVATAR_RIG.bootH * 0.5, AVATAR_RIG.bootY + AVATAR_RIG.bootH * 0.5]) {
    for (const sz of [AVATAR_RIG.bootZ - 0.14, AVATAR_RIG.bootZ + 0.14]) {
      BOOT_CORNERS.push(new THREE.Vector3(sx, sy, sz));
    }
  }
}
const SOLE_SCRATCH = new THREE.Vector3();
const CORPSE_BOX = new THREE.Box3();
const SOLE_MATRIX = new THREE.Matrix4();

// ── FOOT PLANT (ANIMPOL / avatar-15) ────────────────────────────────────────
/**
 * How high the surface is under the LEFT and RIGHT boot, relative to the height
 * midway between them. Centred on purpose: the group origin is where the server
 * says the pirate stands, so a centred solve never moves the body off the seat
 * Match and PhysicsSystem agree on — it only straddles the slope. On flat
 * ground both numbers are 0 and every pose below is bit-identical to before.
 */
const FOOT_PLANT = { left: 0, right: 0, slope: 0 };
/** Scratch for the ground query: this runs once per visible pirate per frame
 *  and the allocation row of test-avatar-pose-invariants grades it at 350 B. */
const FOOT_LOCAL: { x: number; z: number } = { x: 0, z: 0 };
const FOOT_QUERY = { x: 0, y: 0, z: 0 };
/**
 * Beyond 30 m the boots are a couple of pixels and the two ground samples buy
 * nothing a player can see, so the solve (and its cost) switches off entirely
 * and the stance falls back to the flat-ground one. This is the LOD: inside
 * 30 m a pirate costs two extra `getShipFloorYAt` (or two GridGround cell
 * lookups) and one `acos` per frame, with no allocation; outside it, nothing.
 */
const FOOT_PLANT_D2 = 30 * 30;
/** A boot may straddle at most this much of slope; past it the body would have
 *  to squat, and a squatting sentry on a 30° hillside reads worse than a boot
 *  0.05 m into the sand. */
const FOOT_PLANT_MAX = 0.09;
/** Hip → sole, straight-legged: rotating a leg pivot by `a` lifts its own boot
 *  by LEG_LEN·(1−cos a), which is how the higher foot shortens its leg. */
const LEG_LEN = AVATAR_RIG.legPivotY;
/** A rigged pirate's legs are bones, not pivots; the foot query still wants a
 *  fore/aft offset, and a shared zero (feet abreast) is the honest one. */
const RIG_LEG_REST = new THREE.Euler(0, 0, 0);

/**
 * How far the hips must drop (≤0) for the LOWER boot to sit exactly on the
 * ground once both legs have been rotated. The other foot lifts, which is what
 * a stride looks like; before AVATAR-01 nothing solved this and the boots
 * simply floated or sank.
 */
function lowestSole(rot: THREE.Euler) {
  SOLE_MATRIX.makeRotationFromEuler(rot);
  let lowest = Infinity;
  for (let i = 0; i < BOOT_CORNERS.length; i++) {
    const y = SOLE_SCRATCH.copy(BOOT_CORNERS[i]).applyMatrix4(SOLE_MATRIX).y;
    if (y < lowest) lowest = y;
  }
  return lowest;
}

function solveHipLift(left: THREE.Euler, right: THREE.Euler) {
  // Unrolled on purpose: this runs once per avatar per frame and a `[left,
  // right]` literal here is a per-frame allocation in the hot path.
  const need = Math.max(-lowestSole(left), -lowestSole(right));
  // Positive is allowed but tiny: a boot tilted at the helm reaches ~2 cm past
  // the straight-leg length, and that 2 cm is the difference between standing
  // on the planking and standing in it.
  return THREE.MathUtils.clamp(need - AVATAR_RIG.legPivotY, -0.6, 0.05);
}

function easeOutCubic(x: number) {
  const k = 1 - x;
  return 1 - k * k * k;
}

function easeInQuad(x: number) {
  return x * x;
}

export type PlayerAnimatorView = {
  readonly input: InputManager;
  readonly ocean: OceanRenderer;
  readonly localPlayerId: string | null;
  readonly tempSlashPos: THREE.Vector3;
  spawnRemoteSlashArc(worldPos: THREE.Vector3): void;
  /**
   * Routed back through Game on purpose: scripts/pose-pin-probe.mjs pins a stub
   * onto the live Game instance, and that override must win here too.
   */
  getCutlassSwingProgress(player: Player): number;
  /** For the skinned rig's distance LOD only (RIG-01): how often a pirate's
   *  AnimationMixer is stepped falls off with range. Optional so a probe can
   *  build a view without a camera; missing means "step every pirate fully". */
  readonly camera?: THREE.Camera;
  /**
   * Drawn ground height at a world (x, z), or null off every island — the same
   * answer the terrain the player can SEE gives (GridGround, TERRAIN-01), not
   * the analytic heightfield. ANIMPOL's foot plant asks it twice per visible
   * pirate ashore. Optional so a probe can build a view without a world.
   */
  groundYAt?(x: number, z: number): number | null;
};

/** Mutable per-mesh animation scratch stored on `mesh.userData.animation`. */
type AnimScratch = {
  phase: number;
  variant?: 'pirate' | 'skeleton';
  parts?: Record<string, THREE.Object3D>;
  /** 0..1 airborne blend (jump / fall / geyser / cannon flight). */
  airBlend?: number;
  /** Fastest downward speed seen during the current airborne stint. */
  airFallPeak?: number;
  /** Countdown of the landing-crouch recovery. */
  landTimer?: number;
  /** 0..1 strength of the current landing crouch. */
  landPower?: number;
  /** Prone-crawl phase while downed — advances with movement only. */
  crawlPhase?: number;
  /** 0..1 eased blend into the downed prone pose. */
  downedBlend?: number;
  /** Which pose branch was showing last frame (see crossFade). */
  poseKey?: number;
  /** Seconds left of the cross-fade out of the previous branch's pose. */
  poseFade?: number;
  /** The pose actually SHOWN last frame, and the one being faded out of. */
  poseLast?: number[];
  poseFrom?: number[];
  /** The two boot meshes, looked up once. They hang off the leg pivots and are
   *  not in the factory's parts table, and the foot plant has to roll the ankle
   *  so the SOLE lies flat on the surface rather than on one edge. */
  bootL?: THREE.Object3D | null;
  bootR?: THREE.Object3D | null;
};

/** Joints that cross-fade between pose branches, in a fixed order. */
const FADE_JOINTS = ['torso', 'pelvis', 'head', 'leftArmPivot', 'rightArmPivot', 'leftLegPivot', 'rightLegPivot'] as const;
/** One reusable read-back buffer for the fade. crossFade runs once per avatar
 *  per frame and never keeps `target` past the call, so a module-level scratch
 *  replaces the 21-element array it used to build every frame. */
const POSE_SCRATCH: number[] = new Array(FADE_JOINTS.length * 3).fill(0);
/** Pose-branch bits. A NUMBER, not a string: the key is rebuilt every frame for
 *  every avatar, and the template literal it used to be allocated ~0.6 KB of
 *  cons-strings per avatar per frame (12 avatars = 9.4 KB/frame of garbage,
 *  measured by the allocation row in test-avatar-pose-invariants). */
const POSE_HELM = 1, POSE_GUN = 2, POSE_NEST = 4, POSE_CLIMB = 8, POSE_SWIM = 16;
const POSE_BAIL = 32, POSE_BLADE = 64, POSE_GUARD = 128, POSE_CROUCH = 256;
const POSE_AIR = 512, POSE_MOVE = 1024, POSE_DOWNED = 2048;
const POSE_REPAIR = 4096, POSE_TOOL = 8192;
/** A station pose is a whole-body change; longer than this and it reads as slow
 *  motion, shorter and the arms still teleport. Linear on purpose: an eased
 *  fade is steeper than 1/N in the middle, and the widest edge (idle -> helm,
 *  1.35 rad of shoulder) has to stay under the gate's 0.35 rad/frame. */
const POSE_FADE_TIME = 0.16;
/** Hip drop the crouch leg fold produces once it is fully faded in. */
const CROUCH_HIP_DROP = 0.37;

/**
 * The buffered timeline's answer for a REMOTE body (avatar-12). Game hands this
 * in for anyone but the local player, so the gait phase and the head angle are
 * on the same clock as the position instead of on the newest raw snapshot.
 */
export type RemoteAnimPose = { pitch: number; vx: number; vz: number };

/** How long a hit reaction lasts. Shared by the boxy body and the rig. */
const FLINCH_TIME = 0.28;

/** Directional flinch pushed in by Game on any health drop. */
type FlinchState = { t: number; mag: number; yaw: number };

/** ONE decay envelope for the hit reaction, so the boxy body and the rigged one
 *  jolt on the same clock: a 25% snap in, then an eased recovery. Advances the
 *  timer and clears the state when it runs out; returns 0 when nothing is on. */
function flinchEnvelope(mesh: THREE.Group, dt: number): number {
  const flinch = mesh.userData.flinch as FlinchState | undefined;
  if (!flinch) return 0;
  flinch.t += dt;
  if (flinch.t >= FLINCH_TIME) {
    mesh.userData.flinch = undefined;
    return 0;
  }
  const p = flinch.t / FLINCH_TIME;
  return (p < 0.25 ? p / 0.25 : 1 - easeOutCubic((p - 0.25) / 0.75)) * flinch.mag;
}

function flinchYaw(mesh: THREE.Group): number {
  return (mesh.userData.flinch as FlinchState | undefined)?.yaw ?? 0;
}

export class PlayerAnimator {
  constructor(private readonly view: PlayerAnimatorView) {}

  /** Per-player swing-type latch so the cutlass anim keeps ONE denominator per swing. */
  readonly cutlassSwingKind = new Map<string, 'lunge' | 'swing'>();

  getCutlassSwingProgress(player: Player) {
    const activeWeapon = player.atCannon || player.atHelm ? null : player.weapons[player.activeSlot];
    if (!activeWeapon || activeWeapon.weaponId !== 'cutlass' || !activeWeapon.reloading) {
      this.cutlassSwingKind.delete(player.id);
      return 0;
    }
    // Lock the denominator for the WHOLE swing. The old per-frame pick flipped
    // from the 1.05s lunge cooldown to the 0.55s basic one the instant the
    // timer decayed past reloadTime — the animation snapped backwards and
    // replayed mid-swing (and the first-person path always divided by the
    // lunge cooldown, so a basic slash STARTED near its arc peak and swept
    // back to idle: the swing literally played in reverse).
    if (activeWeapon.reloadTimer > WEAPONS.cutlass.reloadTime + 0.001) {
      this.cutlassSwingKind.set(player.id, 'lunge');
    } else if (!this.cutlassSwingKind.has(player.id)) {
      this.cutlassSwingKind.set(player.id, 'swing');
    }
    const cooldown = this.cutlassSwingKind.get(player.id) === 'lunge'
      ? CUTLASS_VIEW_LUNGE_COOLDOWN
      : WEAPONS.cutlass.reloadTime;
    return 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / cooldown, 0, 1);
  }

  /**
   * FOOT PLANT (avatar-15). Where the surface is under each boot, relative to
   * the height between them, in the mesh's own frame.
   *
   * A pirate on a hull that is heeled 0.2 rad has 5.4 cm of deck between her
   * boots; before this she stood on a flat plane through the origin, so the
   * downhill boot floated 2.7 cm and the uphill one was 2.7 cm inside the
   * planking. The two samples come from the SHARED functions the server
   * collides against (`getShipFloorYAt` aboard, the drawn GridGround ashore),
   * so the plane she stands on is the one the server put her on.
   *
   * Writes FOOT_PLANT and returns it; never allocates.
   */
  private solveFootPlant(mesh: THREE.Group, ship: Ship | null, legRotL: THREE.Euler, legRotR: THREE.Euler) {
    FOOT_PLANT.left = 0;
    FOOT_PLANT.right = 0;
    FOOT_PLANT.slope = 0;
    const ground = this.view.groundYAt;
    if (!ship && !ground) return FOOT_PLANT;
    const cam = this.view.camera;
    if (cam && cam.position.distanceToSquared(mesh.position) > FOOT_PLANT_D2) return FOOT_PLANT;

    const yaw = mesh.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const originY = mesh.position.y;
    let gl = 0;
    let gr = 0;
    for (let i = 0; i < 2; i++) {
      const lx = i === 0 ? -AVATAR_RIG.legPivotX : AVATAR_RIG.legPivotX;
      // Where the boot actually IS this frame: the pivot swings it fore/aft with
      // the stride, which is what makes a PITCHED deck (and a hill walked up)
      // reach the solve at all — two feet abreast only ever see roll.
      const lz = AVATAR_RIG.bootZ - LEG_LEN * Math.sin((i === 0 ? legRotL : legRotR).x);
      FOOT_QUERY.x = mesh.position.x + lx * cos + lz * sin;
      FOOT_QUERY.z = mesh.position.z - lx * sin + lz * cos;
      FOOT_QUERY.y = originY + 0.02;
      let g: number | null = null;
      if (ship) {
        g = getShipFloorYAt(FOOT_QUERY, ship, toShipLocalPointInto(FOOT_LOCAL, FOOT_QUERY, ship));
      } else if (ground) {
        g = ground(FOOT_QUERY.x, FOOT_QUERY.z);
      }
      const dy = g === null || !Number.isFinite(g) ? originY : g;
      if (i === 0) gl = dy; else gr = dy;
    }
    const mid = (gl + gr) * 0.5;
    FOOT_PLANT.left = THREE.MathUtils.clamp(gl - mid, -FOOT_PLANT_MAX, FOOT_PLANT_MAX);
    FOOT_PLANT.right = THREE.MathUtils.clamp(gr - mid, -FOOT_PLANT_MAX, FOOT_PLANT_MAX);
    // The surface roll in the pirate's OWN frame, straight off the two samples —
    // no second copy of the hull attitude maths, and it works on a hillside too.
    FOOT_PLANT.slope = Math.atan2(FOOT_PLANT.right - FOOT_PLANT.left, AVATAR_RIG.legPivotX * 2);
    return FOOT_PLANT;
  }

  animatePlayerMesh(mesh: THREE.Group, player: Player, ship: Ship | null, dt: number, remote?: RemoteAnimPose | null) {
    // A SKINNED pirate plays her own clips (RIG-01). This branch must come
    // BEFORE the `parts` read, because a rig deliberately carries no parts
    // table: everything below is the procedural box body, which survives as the
    // LOW-tier and load-failure fallback and as the island skeleton.
    if (mesh.userData.rig) {
      const cam = this.view.camera;
      const distSq = cam ? cam.position.distanceToSquared(mesh.position) : 0;
      // The rig's legs are bones, but "where is the surface under each boot" is
      // the same world question with the same shared answer, so the solve lives
      // here (which has the ship and the ground sampler) and the rig is handed
      // the two numbers. RIG_LEG_REST keeps the query honest without reading
      // bones back: a clip's stride is what the fore/aft offset is for.
      const plant = this.solveFootPlant(mesh, ship, RIG_LEG_REST, RIG_LEG_REST);
      updatePlayerRig(
        mesh, player, dt, distSq,
        remote ? remote.pitch : player.rotation.y,
        angleWrap(player.rotation.x - mesh.rotation.y),
        this.view.getCutlassSwingProgress(player),
        plant.left, plant.right,
      );
      applyRigFlinch(mesh, flinchYaw(mesh), flinchEnvelope(mesh, dt));
      return;
    }

    const animation = mesh.userData.animation as AnimScratch;
    const parts = animation?.parts;
    if (!parts) return;

    const torso = parts.torso;
    const shirt = parts.shirt;
    const pelvis = parts.pelvis;
    const coatSkirt = parts['coatSkirt'] ?? parts['coat-skirt'];
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    const leftLegPivot = parts['leftLegPivot'] ?? parts['left-leg-pivot'];
    const rightLegPivot = parts['rightLegPivot'] ?? parts['right-leg-pivot'];
    const head = parts.head;
    const hair = parts.hair;
    const bandana = parts.bandana;
    if (!torso || !shirt || !pelvis || !leftArmPivot || !rightArmPivot || !leftLegPivot || !rightLegPivot || !head || !hair || !bandana) {
      return;
    }

    // A pooled mesh may have been a corpse a moment ago (animateCorpse switches
    // it to YXZ to topple in the body frame).
    if (mesh.rotation.order !== 'XYZ') mesh.rotation.order = 'XYZ';

    const swimming = player.state === 'swimming';
    const downed = player.state === 'downed';
    const atStation = player.atCannon || player.atHelm || player.atCrowNest || player.mastClimb !== null;
    // Buffered for remotes, raw (predicted) for the local player, who owns his
    // own input and must not be lagged by his own interpolation buffer.
    const moveSpeed = remote
      ? Math.hypot(remote.vx, remote.vz)
      : Math.hypot(player.velocity.x, player.velocity.z);
    const lookPitchRaw = remote ? remote.pitch : player.rotation.y;
    const moveRatio = Math.min(
      1,
      swimming
        ? Math.max(0.38, moveSpeed / PLAYER.SWIM_SPEED)
        : moveSpeed / PLAYER.MOVE_SPEED,
    );
    // STRIDE LOCK: the gait phase advances with distance travelled, not with a
    // speed-blended constant, so feet stop skating at intermediate speeds. Idle
    // keeps a slow breathing tick so a standing pirate is never a frozen prop.
    if (swimming) {
      animation.phase = (animation.phase + dt * (3.4 + moveRatio * 9.2)) % (Math.PI * 2);
    } else if (moveSpeed > 0.15) {
      const cycleRate = (moveSpeed * Math.PI * 2) / GAIT_CYCLE_M;
      animation.phase = (animation.phase + dt * Math.min(cycleRate, 22)) % (Math.PI * 2);
    } else {
      animation.phase = (animation.phase + dt * 1.6) % (Math.PI * 2);
    }
    const phase = animation.phase;
    const deckSway = Math.sin(this.view.ocean.getTime() * 1.5 + mesh.position.x * 0.03 + mesh.position.z * 0.04) * 0.025;
    // Legs lead, arms trail by ~0.35rad — the offset is what reads as "alive".
    const walkSwing = Math.sin(phase) * 0.8 * moveRatio;
    const armSwing = Math.sin(phase + 0.35) * 0.86 * moveRatio;
    const walkLift = Math.cos(phase * 2) * 0.05 * moveRatio;
    const idleBreath = Math.sin(this.view.ocean.getTime() * 1.35) * 0.012 * (1 - moveRatio);
    const idleBob = deckSway + Math.sin(this.view.ocean.getTime() * 2.1 + phase) * 0.018 + idleBreath;
    const activeWeapon = player.atCannon || player.atHelm ? null : player.weapons[player.activeSlot];
    const cutlassReady = activeWeapon?.weaponId === 'cutlass';
    const cutlassSwing = cutlassReady ? this.view.getCutlassSwingProgress(player) : 0;
    // Remote swing-start edge → pooled world-space slash arc at the sword hand.
    if (player.id !== this.view.localPlayerId) {
      const prevSwing = (mesh.userData.prevCutlassSwing as number | undefined) ?? 0;
      if (cutlassSwing > 0.001 && prevSwing <= 0.001) {
        const hand = parts.rightHand;
        if (hand) {
          hand.getWorldPosition(this.view.tempSlashPos);
          this.view.spawnRemoteSlashArc(this.view.tempSlashPos);
        }
      }
      mesh.userData.prevCutlassSwing = cutlassSwing;
    }
    const cutlassCharge = cutlassReady ? THREE.MathUtils.clamp(player.cutlassCharge ?? 0, 0, 1) : 0;
    const firearmReady = !!activeWeapon && !WEAPONS[activeWeapon.weaponId].melee;
    // Work states, in priority order: patching a hull beats carrying a tool.
    const hullRepair = atStation || swimming || downed ? 0 : THREE.MathUtils.clamp(player.hullRepairProgress ?? 0, 0, 1);
    const toolKind = atStation || swimming || downed || hullRepair > 0 || player.bailing
      ? null
      : player.equippedTool ?? null;
    /** Both hands are on a job: the blade poses and the strike additive stand down. */
    const poseBusy = hullRepair > 0 || !!toolKind;
    const localSwimAim = player.id === this.view.localPlayerId && firearmReady && this.view.input.isAiming();

    // ── Airborne / landing bookkeeping ────────────────────────────────────
    // No grounded flag rides the wire, so |velocity.y| is the tell. Stations,
    // swimming and the downed state all suppress it (a helmsman on a pitching
    // deck must not read as skydiving).
    const verticalSpeed = player.velocity.y ?? 0;
    const canBeAirborne = !swimming && !downed && !atStation && player.state !== 'boarding';
    const airborneNow = canBeAirborne && Math.abs(verticalSpeed) > 1.6;
    const prevAir = animation.airBlend ?? 0;
    const airBlend = THREE.MathUtils.clamp(
      prevAir + (airborneNow ? dt / 0.12 : -dt / 0.16),
      0, 1,
    );
    animation.airBlend = airBlend;
    if (airborneNow) {
      animation.airFallPeak = Math.max(animation.airFallPeak ?? 0, -verticalSpeed);
    } else if (prevAir > 0.45 && airBlend < prevAir) {
      // Falling → grounded edge: crouch-absorb, scaled by the impact speed.
      const impact = animation.airFallPeak ?? 0;
      if (impact > 3.4 && (animation.landTimer ?? 0) <= 0) {
        animation.landTimer = 0.3;
        animation.landPower = THREE.MathUtils.clamp((impact - 3) / 12, 0.25, 1);
      }
      animation.airFallPeak = 0;
    }
    if ((animation.landTimer ?? 0) > 0) animation.landTimer = Math.max(0, (animation.landTimer ?? 0) - dt);
    const landPhase = (animation.landTimer ?? 0) > 0
      ? (animation.landTimer ?? 0) / 0.3
      : 0;
    // Sharp compression on contact, eased recovery back to stance.
    const landCrouch = landPhase > 0
      ? Math.sin(landPhase * Math.PI) * (animation.landPower ?? 0.5)
      : 0;

    const downedBlend = THREE.MathUtils.clamp(
      (animation.downedBlend ?? 0) + (downed ? dt / 0.25 : -dt / 0.3),
      0, 1,
    );
    animation.downedBlend = downedBlend;

    // Base pose, straight off the shared rig: every Y here is a metre above the
    // SOLES, and the stance solve at the end of the frame is what keeps them so.
    torso.position.y = AVATAR_RIG.torsoY + idleBob + walkLift * 0.35;
    shirt.position.y = AVATAR_RIG.shirtY + idleBob + walkLift * 0.3;
    pelvis.position.y = AVATAR_RIG.pelvisY + idleBob * 0.35 + Math.sin(phase) * 0.05 * moveRatio;
    // The head carries a damped share of the bob: it is the server's headshot
    // sphere as well as a body part, and the gate holds it to 5 cm of HEAD_Y.
    head.position.y = AVATAR_RIG.headY + idleBob * 0.55;
    hair.position.y = AVATAR_RIG.hairY + idleBob * 0.55;
    bandana.position.y = AVATAR_RIG.hairY + idleBob * 0.55;
    leftArmPivot.position.y = AVATAR_RIG.armPivotY;
    rightArmPivot.position.y = AVATAR_RIG.armPivotY;
    if (coatSkirt) {
      coatSkirt.position.y = AVATAR_RIG.coatSkirtY + idleBob * 0.2;
      coatSkirt.rotation.set(0, Math.sin(phase) * 0.1 * moveRatio, 0);
    }

    torso.rotation.set(0.04, 0, 0);
    pelvis.rotation.set(0, 0, 0);
    // WHERE HE IS LOOKING, not just how far his body lags (avatar-07). The head
    // carries the replicated look PITCH — a crewmate squinting up at the crow's
    // nest or down at a hole now reads as doing it — and, since the body no
    // longer snaps to the look yaw (Game hands remotes a lagged body yaw), the
    // residual yaw here is a real head turn of up to ±0.6 rad rather than the
    // easing error it used to be. Clamped asymmetrically: a neck looks further
    // up than down.
    const lookPitch = THREE.MathUtils.clamp(lookPitchRaw * 0.55, -0.6, 0.5);
    const headYaw = THREE.MathUtils.clamp(angleWrap(player.rotation.x - mesh.rotation.y), -0.85, 0.85);
    head.rotation.set(lookPitch, headYaw, 0);
    hair.rotation.set(lookPitch, head.rotation.y, 0);
    bandana.rotation.set(lookPitch, head.rotation.y, 0);

    if (downedBlend > 0.002 && !swimming) {
      // ── DOWNED: a real prone crawl. The body lies FACE-DOWN (Game stops
      // tipping it sideways) and the arms reach hand-over-hand only while the
      // pirate is actually crawling, so a still casualty stays still.
      const crawlSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      animation.crawlPhase = ((animation.crawlPhase ?? 0) + dt * crawlSpeed * 3.4) % (Math.PI * 2);
      const crawl = Math.sin(animation.crawlPhase ?? 0);
      const b = downedBlend;
      const pain = Math.sin(this.view.ocean.getTime() * 1.7) * 0.06;
      torso.rotation.x = 0.16 * b;
      torso.rotation.z = pain * b;
      pelvis.rotation.x = -0.1 * b;
      head.rotation.x = 0.85 * b;
      head.rotation.y *= 1 - b * 0.5;
      hair.rotation.x = head.rotation.x;
      bandana.rotation.x = head.rotation.x;
      leftArmPivot.rotation.set(-2.4 * b + crawl * 0.6 * b, 0.1 * b, -0.25 * b);
      rightArmPivot.rotation.set(-2.4 * b - crawl * 0.6 * b, -0.1 * b, 0.25 * b);
      leftLegPivot.rotation.set(-0.28 * b + crawl * 0.28 * b, 0, -0.12 * b);
      rightLegPivot.rotation.set(-0.28 * b - crawl * 0.28 * b, 0, 0.12 * b);
      // Body flat on the deck: sink the torso stack toward ground level.
      torso.position.y -= 0.1 * b;
      head.position.y -= 0.06 * b;
      hair.position.y -= 0.06 * b;
      bandana.position.y -= 0.06 * b;
      this.crossFade(animation, parts, POSE_DOWNED, dt);
      this.applyFlinch(mesh, parts, dt);
      return;
    }

    if (player.atHelm) {
      // Hand-over-hand at the wheel: the harder the rudder is over, the more
      // the helmsman heaves at the spokes instead of posing beside them.
      const angVel = ship?.angularVelocity ?? 0;
      const helmLean = THREE.MathUtils.clamp(angVel * 0.035, -0.18, 0.18);
      const haul = THREE.MathUtils.clamp(Math.abs(angVel) / 0.35, 0, 1);
      const haulPhase = Math.sin(this.view.ocean.getTime() * 6.2);
      const spin = Math.sign(angVel) || 1;
      torso.rotation.x = 0.16;
      torso.rotation.z = helmLean;
      leftArmPivot.rotation.set(-1.15 + haulPhase * 0.26 * haul, 0, -0.48 + spin * 0.22 * haul);
      rightArmPivot.rotation.set(-1.15 - haulPhase * 0.26 * haul, 0, 0.48 + spin * 0.22 * haul);
      leftLegPivot.rotation.set(0.14, 0, 0.05);
      rightLegPivot.rotation.set(-0.08, 0, -0.05);
    } else if (player.atCrowNest) {
      torso.rotation.x = 0.02;
      torso.rotation.z = 0.04;
      leftArmPivot.rotation.set(-0.38, 0.06, -0.28);
      rightArmPivot.rotation.set(-0.42, -0.04, 0.26);
      leftLegPivot.rotation.set(0.14, 0, 0.06);
      rightLegPivot.rotation.set(-0.1, 0, -0.06);
    } else if (player.mastClimb !== null) {
      // Mast-ladder climb: body vertical against the mast, arms overhead
      // alternating hand-over-hand. Phase rides climb PROGRESS (not time) so
      // the limbs track W/S input and freeze when the climber pauses.
      const rung = Math.sin(player.mastClimb * 8 * Math.PI);
      torso.rotation.x = -0.05;
      pelvis.rotation.x = -0.04;
      leftArmPivot.rotation.set(-2.3 + rung * 0.5, 0.12, -0.14);
      rightArmPivot.rotation.set(-2.3 - rung * 0.5, -0.12, 0.14);
      leftLegPivot.rotation.set(-0.45 - rung * 0.4, 0, -0.05);
      rightLegPivot.rotation.set(-0.45 + rung * 0.4, 0, 0.05);
    } else if (player.atCannon) {
      // Recoil flinch when this crew's cannon fires (Game sets cannonRecoil).
      const recoil = mesh.userData.cannonRecoil as number | undefined ?? 0;
      torso.rotation.x = 0.12 + recoil * 0.22;
      torso.rotation.y = -recoil * 0.2;
      head.rotation.y += recoil * 0.45;
      hair.rotation.y = head.rotation.y;
      bandana.rotation.y = head.rotation.y;
      leftArmPivot.rotation.set(-0.9 + recoil * 0.34, 0, -0.18);
      rightArmPivot.rotation.set(-1.05 + recoil * 0.34, 0, 0.18);
      leftLegPivot.rotation.set(0.2, 0, 0);
      rightLegPivot.rotation.set(-0.16, 0, 0);
    } else if (swimming) {
      // PRONE FRONT CRAWL: the body lies face-down (Game pitches the mesh
      // forward now, not onto its back), arms windmill overarm and the legs
      // flutter-kick in antiphase.
      const swimPitch = THREE.MathUtils.clamp(lookPitchRaw, -0.65, 0.65);
      const strokePhase = phase * 2.1;
      const kick = Math.sin(strokePhase * 1.6);
      const roll = Math.sin(strokePhase) * 0.14;
      if (firearmReady && localSwimAim) {
        // Treading water to aim: upright-ish, weapon arm out of the water.
        torso.rotation.x = -0.34;
        torso.rotation.z = roll * 0.3;
        head.rotation.x = -0.25 - swimPitch * 0.1;
        pelvis.rotation.x = -0.18;
        leftArmPivot.rotation.set(-1.02 + Math.sin(strokePhase) * 0.2, 0.08, -0.3);
        rightArmPivot.rotation.set(-1.24, -0.08, 0.3);
        leftLegPivot.rotation.set(-0.34 - kick * 0.3, 0, -0.1);
        rightLegPivot.rotation.set(-0.34 + kick * 0.3, 0, 0.1);
      } else {
        const stroke = Math.sin(strokePhase);
        const strokeOpp = Math.sin(strokePhase + Math.PI);
        // Overarm recovery: the arm sweeps up past the head (−2.6) and pulls
        // back down along the flank (−0.2) once per stroke.
        const armFor = (s: number) => -1.4 - s * 1.25;
        torso.rotation.x = -0.2 - swimPitch * 0.22;
        torso.rotation.z = roll;
        head.rotation.x = -0.55 - swimPitch * 0.25;
        hair.rotation.x = head.rotation.x;
        bandana.rotation.x = head.rotation.x;
        pelvis.rotation.x = -0.08;
        leftArmPivot.rotation.set(armFor(stroke), stroke * 0.2, -0.2 - stroke * 0.18);
        rightArmPivot.rotation.set(armFor(strokeOpp), strokeOpp * -0.2, 0.2 + strokeOpp * 0.18);
        leftLegPivot.rotation.set(-0.12 - kick * 0.4, 0, -0.06);
        rightLegPivot.rotation.set(-0.12 + kick * 0.4, 0, 0.06);
      }
    } else if (cutlassReady && player.blocking && !poseBusy) {
      torso.rotation.x = 0.12;
      torso.rotation.y = -0.08;
      pelvis.rotation.y = 0.04;
      leftArmPivot.rotation.set(-0.42, 0.22, 0.34);
      rightArmPivot.rotation.set(-0.88, -0.1, -0.28);
      leftLegPivot.rotation.set(-walkSwing * 0.3, 0, -0.06);
      rightLegPivot.rotation.set(walkSwing * 0.3, 0, 0.06);
      torso.rotation.z = -walkSwing * 0.035;
    } else if (cutlassReady && !poseBusy) {
      torso.rotation.x = 0.08;
      torso.rotation.y = -0.14 - cutlassCharge * 0.24;
      pelvis.rotation.y = 0.08 + cutlassCharge * 0.12;
      // The free arm swings a full stride; the sword arm keeps ~60% so the
      // blade stays presented. (At walking speed the old 0.45/0.18 factors
      // damped the swing to ±0.07rad — skeletons read as frozen-armed.)
      leftArmPivot.rotation.set(0.08 + armSwing * 1.0 - cutlassCharge * 0.22, 0.08 + cutlassCharge * 0.22, 0.24);
      rightArmPivot.rotation.set(-0.42 - armSwing * 0.58 - cutlassCharge * 0.82, -0.16 - cutlassCharge * 0.24, -0.38 - cutlassCharge * 0.35);
      leftLegPivot.rotation.set(-walkSwing * 0.38, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 0.38, 0, 0.04);
      torso.rotation.z = -walkSwing * 0.06 - cutlassCharge * 0.1;
    } else if (player.bailing && hullRepair <= 0) {
      // Bailing crew visibly SCOOP (bow low, arms down into the bilge) and
      // TOSS (straighten, both arms flinging out). The two arms are offset —
      // a lead arm deeper, the trail arm lagging — plus a torso twist toward
      // the bilge on the scoop and away on the throw, so it reads as work
      // rather than a symmetric mechanical vibration.
      const bailProg = 1 - THREE.MathUtils.clamp(player.bailScoopProgress ?? 0, 0, 1);
      const bailArc = Math.sin(Math.min(1, bailProg / 0.7) * Math.PI);
      const lagArc = Math.sin(Math.min(1, Math.max(0, bailProg - 0.08) / 0.7) * Math.PI);
      if (player.bucketFilled) {
        // Loaded: heave up and fling out over the rail, overshooting slightly.
        const fling = Math.sin(Math.min(1, bailProg / 0.55) * Math.PI);
        torso.rotation.x = 0.16 + bailArc * 0.3;
        torso.rotation.y = 0.34 * fling;
        pelvis.rotation.x = 0.06 + bailArc * 0.12;
        pelvis.rotation.y = 0.14 * fling;
        leftArmPivot.rotation.set(0.55 + bailArc * 0.72, 0.1 + fling * 0.2, -0.2 - fling * 0.16);
        rightArmPivot.rotation.set(0.62 + lagArc * 0.5, -0.1 + fling * 0.14, 0.2 + fling * 0.1);
      } else {
        // Empty: bow down and scoop, twisting into the bilge.
        torso.rotation.x = 0.24 - bailArc * 0.42;
        torso.rotation.y = -0.25 * bailArc;
        pelvis.rotation.x = 0.08 - bailArc * 0.1;
        pelvis.rotation.y = -0.1 * bailArc;
        leftArmPivot.rotation.set(0.7 - bailArc * 2.05, 0.12, -0.16);
        rightArmPivot.rotation.set(0.7 - lagArc * 1.72, -0.12, 0.16);
      }
      leftLegPivot.rotation.set(-walkSwing * 0.24, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 0.24, 0, 0.04);
      torso.rotation.z = walkSwing * 0.04;
    } else if (hullRepair > 0) {
      // ── CARPENTER (avatar-08). Holes are the headline feature and until now
      // the man patching one looked like an idle pirate: hullRepairProgress is
      // replicated and nothing read it. He stoops over the breach and swings a
      // hammer; the beat is on the shared ocean clock, not on progress, so the
      // blows keep their rhythm however long the plank takes.
      const strike = (Math.sin(this.view.ocean.getTime() * 7.4) + 1) * 0.5;
      torso.rotation.x = 0.52 + strike * 0.1;
      torso.rotation.y = -0.16;
      pelvis.rotation.x = 0.14;
      // Raise, then drive down onto the plank. Both ends stay well forward of
      // the rest pose so the arm never passes through the stooped torso.
      rightArmPivot.rotation.set(-1.5 + strike * 1.28, -0.12, 0.2);
      leftArmPivot.rotation.set(-0.92, 0.3, -0.34);
      leftLegPivot.rotation.set(-0.34, 0, -0.16);
      rightLegPivot.rotation.set(0.22, 0, 0.16);
      head.rotation.x = Math.max(head.rotation.x, 0.42);
      hair.rotation.x = head.rotation.x;
      bandana.rotation.x = head.rotation.x;
    } else if (toolKind) {
      // ── A TOOL IN HAND (avatar-08). equippedTool is replicated and was never
      // drawn or posed: a spyglass goes to the eye, a shovel gets a two-hand dig
      // cycle, everything else is carried across the chest.
      const work = Math.sin(this.view.ocean.getTime() * 3.6);
      if (toolKind === 'spyglass') {
        torso.rotation.x = 0.02;
        rightArmPivot.rotation.set(-1.52, -0.34, 0.14);
        leftArmPivot.rotation.set(-0.62, 0.16, -0.2);
      } else if (toolKind === 'shovel') {
        const dig = (work + 1) * 0.5;
        torso.rotation.x = 0.3 + dig * 0.26;
        torso.rotation.y = -0.2;
        rightArmPivot.rotation.set(-0.34 - dig * 0.72, -0.18, 0.24);
        leftArmPivot.rotation.set(-0.86 - dig * 0.52, 0.26, -0.3);
      } else {
        torso.rotation.x = 0.1;
        rightArmPivot.rotation.set(-0.94 + work * 0.05, -0.42, 0.3);
        leftArmPivot.rotation.set(0.16 + armSwing * 0.4, 0, -0.14);
      }
      leftLegPivot.rotation.set(-walkSwing * 0.4, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 0.4, 0, 0);
      torso.rotation.z = walkSwing * 0.06;
    } else {
      // Neutral gait: legs lead, arms trail, torso counter-rotates against the
      // pelvis and the head stabilises against the torso roll.
      const armRest = 0.2;
      leftArmPivot.rotation.set(armRest + armSwing, 0, -0.12 - Math.abs(armSwing) * 0.1);
      rightArmPivot.rotation.set(armRest - armSwing, 0, 0.12 + Math.abs(armSwing) * 0.1);
      leftLegPivot.rotation.set(-walkSwing * 0.42, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 0.42, 0, 0);
      torso.rotation.z = walkSwing * 0.08;
      torso.rotation.y = -Math.sin(phase) * 0.12 * moveRatio;
      pelvis.rotation.y = Math.sin(phase) * 0.1 * moveRatio;
      // Sprinting leans in; a walk stays upright. moveRatio maps 0..1 across
      // crouch-walk → walk → full run, so the lean differentiates the speeds.
      torso.rotation.x += moveRatio * moveRatio * 0.16;
      head.rotation.z = -torso.rotation.z * 0.7;
      head.rotation.y -= torso.rotation.y * 0.6;
      hair.rotation.y = head.rotation.y;
      bandana.rotation.y = head.rotation.y;
      // UPPER-BODY OVERRIDE (avatar-15: "a walking gunner cannot aim"). The
      // legs above keep their whole stride; only the arms are rewritten, which
      // is the split the finding says the welded animator does not have. Before
      // this a pirate holding a pistol swung it at her hip like a handbag while
      // her first-person muzzle — and the server's shot — pointed downrange.
      if (firearmReady && !player.blocking) {
        const aimPitch = THREE.MathUtils.clamp(lookPitchRaw, -0.7, 0.7);
        // SIGHTED, OR JUST CARRYING (POSE-01 `aiming`, w7.5). Holding a firearm
        // and pointing one at somebody used to draw the same: the shoulder never
        // came up and the stride shook the barrel either way, so a player could
        // not read intent off a remote at all. The bit now crosses the wire, so
        // the sighted stance is a real one — shoulder up past -1.2 rad, both
        // hands on the grip whatever her feet are doing, and the stride shake
        // suppressed because a pirate taking aim plants the weapon.
        const sighted = !!player.aiming;
        rightArmPivot.rotation.set(
          (sighted ? -1.34 : -0.94) + aimPitch * 0.52 - armSwing * (sighted ? 0.03 : 0.12),
          sighted ? -0.06 : -0.14,
          sighted ? 0.08 : 0.16,
        );
        // The support hand comes across to the grip at a walk, and falls away
        // into a counter-swing at a run (nobody two-hands a pistol sprinting) —
        // unless she is sighted, and then it stays on the grip.
        const support = sighted ? 1 : 1 - moveRatio * moveRatio;
        leftArmPivot.rotation.set(
          (-0.72 + aimPitch * 0.4) * support + (0.2 + armSwing) * (1 - support),
          0.3 * support,
          -0.34 * support - 0.12 * (1 - support),
        );
      }
    }

    if (player.crouching) {
      // Hold-C crouch. Knee-less legs can only fold by rotating about the hip,
      // so the crouch is a wide plie: thighs splayed and pitched, and the
      // stance solve below drops the hips onto them. The old version rotated
      // the legs -0.95 rad about a pivot that never moved, which kicked them
      // 0.7 m forward and parked the boots 26 cm in the air.
      torso.rotation.x += 0.34;
      leftLegPivot.rotation.set(-0.36 + walkSwing * 0.12, 0, -1.06);
      rightLegPivot.rotation.set(-0.36 - walkSwing * 0.12, 0, 1.06);
    }

    if (cutlassReady && !poseBusy && !player.blocking && !swimming && !player.atHelm && !player.atCannon
      && this.cutlassSwingKind.get(player.id) === 'lunge' && cutlassSwing > 0) {
      // DASH STAB: full-extension fencer's thrust — body lunges forward, sword
      // arm rams horizontal, trailing arm flung back, legs in a deep stride.
      const ext = Math.sin(Math.min(1, cutlassSwing / 0.55) * Math.PI);
      torso.rotation.x += ext * 0.44;
      torso.rotation.y += -0.34 * ext;
      pelvis.rotation.x += ext * 0.14;
      head.rotation.y += 0.18 * ext;
      hair.rotation.y = head.rotation.y;
      bandana.rotation.y = head.rotation.y;
      rightArmPivot.rotation.x = -0.62 - ext * 0.98;
      rightArmPivot.rotation.y = -0.16 + ext * 0.1;
      rightArmPivot.rotation.z = -0.42 + ext * 0.3;
      leftArmPivot.rotation.x = -0.18 + ext * 0.72;
      leftArmPivot.rotation.z = 0.32 + ext * 0.35;
      leftLegPivot.rotation.x -= ext * 0.55;
      rightLegPivot.rotation.x += ext * 0.68;
    } else if (cutlassReady && !poseBusy && !player.blocking && !swimming && !player.atHelm && !player.atCannon) {
      const windup = THREE.MathUtils.smoothstep(cutlassSwing, 0.02, 0.26);
      const strike = THREE.MathUtils.smoothstep(cutlassSwing, 0.18, 0.58);
      const recover = THREE.MathUtils.smoothstep(cutlassSwing, 0.62, 1);
      const slashArc = Math.sin(THREE.MathUtils.clamp((cutlassSwing - 0.18) / 0.4, 0, 1) * Math.PI);

      torso.rotation.x += windup * 0.08 - strike * 0.12 + recover * 0.03;
      torso.rotation.y += -windup * 0.58 + strike * 1.08 - recover * 0.28;
      torso.rotation.z += -windup * 0.18 + strike * 0.34 - recover * 0.08;
      pelvis.rotation.y += windup * 0.24 - strike * 0.2;
      head.rotation.y += -windup * 0.05 + strike * 0.14;
      hair.rotation.y = head.rotation.y;
      bandana.rotation.y = head.rotation.y;

      leftArmPivot.rotation.x = -0.18 + windup * 0.08 + strike * 0.42 - recover * 0.14;
      leftArmPivot.rotation.y = 0.1 - windup * 0.3 + strike * 0.58 - recover * 0.16;
      leftArmPivot.rotation.z = 0.32 - windup * 0.08 + strike * 0.18 - recover * 0.06;

      rightArmPivot.rotation.x = -0.62 - windup * 1.18 + strike * 1.72 + recover * 0.28;
      rightArmPivot.rotation.y = -0.16 - windup * 0.46 + strike * 1.16 - recover * 0.32;
      rightArmPivot.rotation.z = -0.42 - windup * 0.78 + strike * 1.95 - recover * 0.48;

      leftLegPivot.rotation.x -= slashArc * 0.08;
      rightLegPivot.rotation.x += slashArc * 0.12;
      leftLegPivot.rotation.z -= slashArc * 0.05;
      rightLegPivot.rotation.z += slashArc * 0.08;
    }

    // ── Airborne pose: legs split, arms out, torso pitched with the fall.
    // Blended additively OVER the gait so the walk cycle stops mid-air.
    if (airBlend > 0.002) {
      const a = airBlend;
      const pitch = THREE.MathUtils.clamp(-verticalSpeed * 0.04, -0.25, 0.32);
      leftLegPivot.rotation.x = THREE.MathUtils.lerp(leftLegPivot.rotation.x, -0.62, a);
      rightLegPivot.rotation.x = THREE.MathUtils.lerp(rightLegPivot.rotation.x, 0.34, a);
      leftLegPivot.rotation.z = THREE.MathUtils.lerp(leftLegPivot.rotation.z, -0.14, a);
      rightLegPivot.rotation.z = THREE.MathUtils.lerp(rightLegPivot.rotation.z, 0.14, a);
      if (!cutlassReady) {
        leftArmPivot.rotation.x = THREE.MathUtils.lerp(leftArmPivot.rotation.x, -0.52, a);
        rightArmPivot.rotation.x = THREE.MathUtils.lerp(rightArmPivot.rotation.x, -0.52, a);
        leftArmPivot.rotation.z = THREE.MathUtils.lerp(leftArmPivot.rotation.z, -0.62, a);
        rightArmPivot.rotation.z = THREE.MathUtils.lerp(rightArmPivot.rotation.z, 0.62, a);
      }
      torso.rotation.x = THREE.MathUtils.lerp(torso.rotation.x, pitch, a);
      torso.rotation.z *= 1 - a;
    }

    // ── Landing crouch: knees absorb, torso folds, whole stack dips.
    if (landCrouch > 0.001) {
      const c = landCrouch;
      leftLegPivot.rotation.x -= 0.75 * c;
      rightLegPivot.rotation.x -= 0.6 * c;
      torso.rotation.x += 0.3 * c;
      leftArmPivot.rotation.x -= 0.4 * c;
      rightArmPivot.rotation.x -= 0.4 * c;
      const dip = 0.3 * c;
      torso.position.y -= dip;
      shirt.position.y -= dip;
      pelvis.position.y -= dip * 0.7;
      head.position.y -= dip;
      hair.position.y -= dip;
      bandana.position.y -= dip;
    }

    // ── WRIST (avatar-22). The socket used to hang rigidly off the shoulder, so
    // the blade swept ±0.5 rad with the stride and a pistol pointed at the deck.
    // The wrist counter-rotates against the shoulder (0.94, not 1: a fully
    // cancelled arm reads as a mannequin carrying a prop) and, with a firearm
    // up, adds the look pitch so the muzzle points where he is aiming. During a
    // strike, a block, a station or a work pose it stays neutral — the whole
    // point of a swing is that the wrist goes WITH the arm.
    const rightWrist = parts.rightWrist;
    if (rightWrist) {
      const wristFree = !swimming && downedBlend <= 0.002 && !atStation && !poseBusy
        && !player.blocking && !player.bailing && cutlassSwing <= 0.001 && airBlend < 0.5;
      let wristX = 0;
      if (wristFree) {
        wristX = -rightArmPivot.rotation.x * 0.94;
        if (firearmReady) wristX += THREE.MathUtils.clamp(lookPitchRaw, -0.7, 0.7);
      }
      rightWrist.rotation.x = wristX;
    }

    // Which BRANCH produced this pose. Continuous values (gait phase, charge,
    // recoil) are deliberately absent: they must not restart a fade.
    const poseKey = (player.atHelm ? POSE_HELM : 0) | (player.atCannon ? POSE_GUN : 0)
      | (player.atCrowNest ? POSE_NEST : 0) | (player.mastClimb !== null ? POSE_CLIMB : 0)
      | (swimming ? POSE_SWIM : 0) | (player.bailing ? POSE_BAIL : 0)
      | (cutlassReady ? (player.blocking ? POSE_GUARD : POSE_BLADE) : 0)
      | (player.crouching ? POSE_CROUCH : 0) | (airBlend > 0.5 ? POSE_AIR : 0)
      | (moveSpeed > 0.15 ? POSE_MOVE : 0)
      | (hullRepair > 0 ? POSE_REPAIR : 0) | (toolKind ? POSE_TOOL : 0);
    this.crossFade(animation, parts, poseKey, dt);

    // ── STANCE SOLVE. The group origin is the SOLES (Game parks it on the
    // server's player.position, which is the ground/deck contact), so whatever
    // the legs are doing the hips must ride at the height that puts the lower
    // boot ON the deck: rotating a straight leg raises its own foot. This is
    // what turns the leg rotations above into a gait with a real hip bob, keeps
    // the station poses out of the planking, and gives the crouch its drop.
    const grounded = !swimming && player.mastClimb === null;
    // FOOT PLANT (avatar-15). Straddle the real surface first: the higher boot
    // shortens its leg by splaying the pivot inward (a straight leg cannot
    // stretch, so the LOWER boot is the one the hip drop is solved against, and
    // it is the one that ends up exactly on the plane). Airborne and at a mast
    // there is no surface to stand on, so the splay fades out with the gait.
    let planted = 0;
    let splayL = 0;
    let splayR = 0;
    if (grounded && airBlend < 0.999) {
      const plant = this.solveFootPlant(mesh, ship, leftLegPivot.rotation, rightLegPivot.rotation);
      const base = Math.min(plant.left, plant.right);
      const weight = 1 - airBlend;
      for (let i = 0; i < 2; i++) {
        const pivot = i === 0 ? leftLegPivot : rightLegPivot;
        const lift = ((i === 0 ? plant.left : plant.right) - base) * weight;
        if (lift <= 1e-5) continue;
        // Rotating the pivot toward the body's centre-line by `a` raises its own
        // boot by LEG_LEN·(1−cos a): +z for the left leg, −z for the right.
        const a = Math.acos(THREE.MathUtils.clamp(1 - lift / LEG_LEN, -1, 1));
        pivot.rotation.z += i === 0 ? a : -a;
        if (i === 0) splayL = a; else splayR = -a;
      }
      // ANKLE ROLL. A splayed leg carries its boot with it, so the sole would
      // stand on one edge and the toe corner would still be in the planking.
      // Rolling the boot back by the leg's splay and on by the surface's own
      // angle lands the whole sole flat on the surface — which is the thing a
      // gate measuring the boot's lowest corner is actually asking for.
      if (animation.bootL === undefined) {
        animation.bootL = leftLegPivot.getObjectByName('left-boot') ?? null;
        animation.bootR = rightLegPivot.getObjectByName('right-boot') ?? null;
      }
      // Only MY splay is undone, never the factory's authored stance: on flat
      // ground both terms are 0 and the boots are exactly where they were.
      const surface = plant.slope * weight;
      if (animation.bootL) animation.bootL.rotation.z = surface - splayL;
      if (animation.bootR) animation.bootR.rotation.z = surface - splayR;
      planted = base * weight;
      // …and the body leans WITH the deck instead of standing plumb on a hull
      // that is heeled over (the old `deckSway` was a sine on ocean time and
      // knew nothing about the ship's attitude).
      const lean = THREE.MathUtils.clamp(plant.slope, -0.5, 0.5) * 0.34 * weight;
      torso.rotation.z += lean;
      pelvis.rotation.z += lean * 0.5;
    } else if (animation.bootL) {
      // Off the ground (swimming, up a mast, in the air) there is no surface to
      // lie flat on, and a boot left rolled from the last stride would twist.
      animation.bootL.rotation.z = 0;
      if (animation.bootR) animation.bootR.rotation.z = 0;
    }
    // The fold the LEGS produce, without the surface offset: the crouch drop is
    // owed to the camera and the server whatever the ground is doing, so it is
    // read off the leg solve alone.
    const hipFold = grounded
      ? solveHipLift(leftLegPivot.rotation, rightLegPivot.rotation) * (1 - airBlend)
      : 0;
    const hipLift = hipFold + planted;
    // A crouch owes the camera and the server a fixed drop (PLAYER.CROUCH_DROP,
    // the same number Match.ts lowers the headshot sphere by), so the torso
    // folds the rest of the way into the hips — in step with them, so the
    // pelvis never detaches from the legs while the fold fades in.
    const crouchProgress = player.crouching && grounded
      ? THREE.MathUtils.clamp(hipFold / -CROUCH_HIP_DROP, 0, 1)
      : 0;
    const bodyOffset = hipLift - (PLAYER.CROUCH_DROP - CROUCH_HIP_DROP) * crouchProgress;
    leftLegPivot.position.y = AVATAR_RIG.legPivotY + hipLift;
    rightLegPivot.position.y = AVATAR_RIG.legPivotY + hipLift;
    pelvis.position.y += hipLift;
    if (coatSkirt) coatSkirt.position.y += hipLift;
    torso.position.y += bodyOffset;
    shirt.position.y += bodyOffset;
    head.position.y += bodyOffset;
    hair.position.y += bodyOffset;
    bandana.position.y += bodyOffset;
    leftArmPivot.position.y += bodyOffset;
    rightArmPivot.position.y += bodyOffset;

    this.applyFlinch(mesh, parts, dt);
  }

  /**
   * Cross-fade between pose BRANCHES. Every branch above writes absolute joint
   * rotations, so taking the helm or dropping into a crouch used to rewrite the
   * whole upper body in a single frame — measured at 1.35 rad of shoulder in
   * one 16 ms step. Within a branch nothing is damped (the gait keeps its full
   * amplitude); only the frame the branch CHANGES starts a fade, from the pose
   * that was actually on screen.
   */
  private crossFade(animation: AnimScratch, parts: Record<string, THREE.Object3D>, key: number, dt: number) {
    const target = POSE_SCRATCH;
    for (let i = 0; i < FADE_JOINTS.length; i++) {
      const joint = parts[FADE_JOINTS[i]];
      if (!joint) return;
      target[i * 3] = joint.rotation.x;
      target[i * 3 + 1] = joint.rotation.y;
      target[i * 3 + 2] = joint.rotation.z;
    }
    const last = animation.poseLast;
    if (!last || last.length !== target.length) {
      animation.poseLast = target.slice();
      animation.poseKey = key;
      animation.poseFade = 0;
      return;
    }
    if (key !== animation.poseKey) {
      animation.poseKey = key;
      // Reused, not re-sliced: a player hovering on the 0.15 m/s move threshold
      // flips branch every frame, and a fresh array per flip is exactly the
      // garbage this path must not make.
      let from = animation.poseFrom;
      if (!from || from.length !== last.length) { from = new Array(last.length); animation.poseFrom = from; }
      for (let i = 0; i < last.length; i++) from[i] = last[i];
      animation.poseFade = POSE_FADE_TIME;
    }
    const fade = animation.poseFade ?? 0;
    if (fade > 0 && animation.poseFrom) {
      const remaining = Math.max(0, fade - dt);
      animation.poseFade = remaining;
      const alpha = 1 - remaining / POSE_FADE_TIME;
      const from = animation.poseFrom;
      for (let i = 0; i < FADE_JOINTS.length; i++) {
        const joint = parts[FADE_JOINTS[i]];
        joint.rotation.set(
          THREE.MathUtils.lerp(from[i * 3], target[i * 3], alpha),
          THREE.MathUtils.lerp(from[i * 3 + 1], target[i * 3 + 1], alpha),
          THREE.MathUtils.lerp(from[i * 3 + 2], target[i * 3 + 2], alpha),
        );
        last[i * 3] = joint.rotation.x;
        last[i * 3 + 1] = joint.rotation.y;
        last[i * 3 + 2] = joint.rotation.z;
      }
      // The hair and the bandana ride the head, so they follow the faded value.
      const head = parts.head;
      const hair = parts.hair;
      const bandana = parts.bandana;
      if (hair) { hair.rotation.x = head.rotation.x; hair.rotation.y = head.rotation.y; }
      if (bandana) { bandana.rotation.x = head.rotation.x; bandana.rotation.y = head.rotation.y; }
      return;
    }
    for (let i = 0; i < target.length; i++) last[i] = target[i];
  }

  /**
   * Directional hit reaction — a brief additive jolt applied on top of whatever
   * pose the state branch produced. Game seeds `mesh.userData.flinch` on any
   * health drop; here it just decays.
   */
  private applyFlinch(mesh: THREE.Group, parts: Record<string, THREE.Object3D>, dt: number) {
    // Snap in over the first 25%, ease out across the rest — the ONE envelope
    // the rigged pirate flinches on too (flinchEnvelope), so a hit reads the
    // same whichever body the tier gave this player.
    const yaw = flinchYaw(mesh);
    const k = flinchEnvelope(mesh, dt);
    if (k === 0) return;
    const flinch = { yaw };
    const torso = parts.torso;
    const head = parts.head;
    const hair = parts.hair;
    const bandana = parts.bandana;
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    if (torso) {
      torso.rotation.x += 0.34 * k;
      torso.rotation.y += flinch.yaw * 0.34 * k;
      torso.position.y -= 0.035 * k;
    }
    if (head) {
      head.rotation.x -= 0.28 * k;
      head.rotation.y += flinch.yaw * 0.2 * k;
      if (hair) hair.rotation.y = head.rotation.y;
      if (bandana) bandana.rotation.y = head.rotation.y;
    }
    if (leftArmPivot) leftArmPivot.rotation.x -= 0.42 * k;
    if (rightArmPivot) rightArmPivot.rotation.x -= 0.42 * k;
  }

  /**
   * Staged procedural death crumple for pirates: HIT recoil → knees buckle →
   * body topples and settles with one damped bounce → the corpse lies still
   * until Game fades it out. Returns the world-space Y offset already written
   * into `mesh.position`, so Game only owns the fade.
   *
   * Cause changes the read: a headshot goes limp instantly, a cutlass kill
   * spins as it falls, an explosion launches and tumbles, a drowning pirate
   * rolls face-down and sinks, and a fall pancakes.
   */
  animateCorpse(mesh: THREE.Group, corpse: CorpseState, dt: number) {
    // A rigged corpse falls with an authored death clip that clamps on its last
    // frame; the scripted crumple below is the procedural body's.
    if (mesh.userData.rig) {
      corpse.t += dt;
      playRigDeath(mesh, corpse.cause === 'headshot' ? 'shot' : corpse.cause, dt);
      return;
    }
    const animation = mesh.userData.animation as AnimScratch;
    const parts = animation?.parts;
    if (!parts) return;
    corpse.t += dt;
    const torso = parts.torso;
    const shirt = parts.shirt;
    const pelvis = parts.pelvis;
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    const leftLegPivot = parts['leftLegPivot'] ?? parts['left-leg-pivot'];
    const rightLegPivot = parts['rightLegPivot'] ?? parts['right-leg-pivot'];
    const head = parts.head;
    const hair = parts.hair;
    const bandana = parts.bandana;
    if (!torso || !shirt || !pelvis || !leftArmPivot || !rightArmPivot || !leftLegPivot || !rightLegPivot || !head) return;

    // Yaw FIRST: in the default XYZ order the body's yaw feeds back into the
    // topple, so a corpse that died facing 0.3 rad came to rest standing half
    // up on its shoulder. YXZ = turn on the spot, then fall in the body frame.
    mesh.rotation.order = 'YXZ';

    const { t, cause, side } = corpse;
    const limp = cause === 'headshot';
    const explosive = cause === 'explosion';
    const drowned = cause === 'drown';
    const pancake = cause === 'fall';

    // Stage timing. A headshot skips the recoil entirely (instantly limp), a
    // fall compresses the whole collapse, an explosion stretches it out.
    const hitEnd = limp ? 0 : 0.12;
    const kneeEnd = pancake ? 0.3 : explosive ? 0.5 : 0.45;
    const settleEnd = pancake ? 0.55 : explosive ? 0.95 : 0.85;

    const hit = hitEnd > 0 ? easeOutCubic(THREE.MathUtils.clamp(t / hitEnd, 0, 1)) : 0;
    const knee = easeInQuad(THREE.MathUtils.clamp((t - hitEnd) / Math.max(0.001, kneeEnd - hitEnd), 0, 1));
    const settleRaw = THREE.MathUtils.clamp((t - kneeEnd) / Math.max(0.001, settleEnd - kneeEnd), 0, 1);
    const settle = easeInQuad(settleRaw);
    // One damped bounce as the body hits the deck.
    const after = Math.max(0, t - settleEnd);
    const bounce = after < 0.55 ? Math.sin(after * 18) * 0.055 * Math.exp(-after * 8) : 0;

    if (drowned) {
      // No crumple in the water: roll face-down, arms trail, slow sink.
      const roll = THREE.MathUtils.clamp(t / 1.2, 0, 1);
      mesh.rotation.x = corpse.baseYaw * 0 + 1.45 * roll;
      mesh.rotation.z = side * 0.18 * roll;
      mesh.rotation.y = corpse.baseYaw;
      mesh.position.set(
        corpse.basePos.x,
        corpse.basePos.y - Math.min(1.4, t * 0.32),
        corpse.basePos.z,
      );
      const drift = Math.sin(t * 1.1) * 0.12;
      torso.rotation.set(0.1, 0, drift * 0.4);
      pelvis.rotation.set(-0.06, 0, 0);
      head.rotation.set(0.35, 0, drift * 0.3);
      leftArmPivot.rotation.set(-1.5 + drift, -0.3, -0.9);
      rightArmPivot.rotation.set(-1.4 - drift, 0.3, 0.95);
      leftLegPivot.rotation.set(0.2 + drift * 0.4, 0, -0.18);
      rightLegPivot.rotation.set(0.12 - drift * 0.4, 0, 0.22);
      if (hair) hair.rotation.set(head.rotation.x, head.rotation.y, head.rotation.z);
      if (bandana) bandana.rotation.set(head.rotation.x, head.rotation.y, head.rotation.z);
      return;
    }

    // ── Whole-body topple. +rotation.x pitches the body face-DOWN, −x drops it
    // onto its back; rotation.z rolls it onto a flank.
    // Near-flat on purpose: at the old 72 deg the body came to rest as a 2 m
    // ramp with its head 0.8 m up and its boots in the air.
    const fallPitch = pancake ? 1.5 : explosive ? -1.44 : limp ? -1.54 : -1.5;
    const fallRoll = pancake ? side * 0.18 : explosive ? side * 0.95 : cause === 'cutlass' ? side * 1.02 : side * 0.55;
    const topple = settle + bounce;
    mesh.rotation.x = fallPitch * topple + (explosive ? Math.sin(t * 5.4) * 0.16 * settleRaw : 0);
    mesh.rotation.z = fallRoll * topple;
    // Cutlass kills spin as they drop; explosions tumble on two axes.
    mesh.rotation.y = corpse.baseYaw + corpse.spin * settleRaw + (explosive ? side * 0.9 * settleRaw : 0);

    // Knees give first (the body sinks a little), then the topple lays it out
    // on the ground plane as the mesh rotates about its FOOT pivot. The sink
    // stays shallow on purpose: the group origin is at the soles, so a deep
    // drop pushes the whole body through the deck it is dying on.
    // Knees give first — a shallow sink, no more. The lift that lays the body
    // on the deck is SOLVED below from the posed bounds; the old constant 0.18
    // was tuned to cancel the 19 cm the boots used to be sunk by.
    let dropY = -0.06 * knee * (1 - settleRaw);
    if (explosive) {
      // Blast lift: up-and-over before it lands.
      dropY += Math.max(0, Math.sin(THREE.MathUtils.clamp(t / 0.65, 0, 1) * Math.PI)) * 0.85;
    }
    mesh.position.set(corpse.basePos.x, corpse.basePos.y + dropY, corpse.basePos.z);

    // ── Limbs: recoil → buckle → sprawl. NOTE the limb keys are relative to a
    // body that has already toppled ~75° at full settle, so the resting pose is
    // close to neutral with a loose splay — big limb rotations here read as
    // legs kicking at the sky rather than a corpse.
    const sprawl = THREE.MathUtils.clamp(settleRaw * 1.15, 0, 1);
    torso.rotation.set(
      -0.28 * hit * (1 - knee) + 0.85 * knee * (1 - sprawl) - 0.3 * sprawl,
      0.14 * sprawl,
      0.12 * sprawl,
    );
    pelvis.rotation.set(0.3 * knee - 0.08 * sprawl, 0.08 * sprawl, -0.06 * sprawl);
    head.rotation.set(
      -0.4 * hit * (1 - knee) + 0.34 * sprawl,
      -0.24 * sprawl,
      0.36 * sprawl,
    );
    // Arms flung out to the sides, palms up — dead weight, not a shrug.
    leftArmPivot.rotation.set(
      -1.25 * hit * (1 - knee) - 0.35 * knee - 0.35 * sprawl,
      -0.3 * sprawl,
      -0.2 - 0.78 * sprawl,
    );
    rightArmPivot.rotation.set(
      -1.25 * hit * (1 - knee) - 0.2 * knee - 0.15 * sprawl,
      0.26 * sprawl,
      0.22 + 0.92 * sprawl,
    );
    // Legs end nearly straight with one knee flopped outward.
    leftLegPivot.rotation.set(-0.85 * knee + 0.9 * knee * sprawl + 0.22 * sprawl, 0, -0.1 - 0.3 * sprawl);
    rightLegPivot.rotation.set(-0.45 * knee + 0.5 * knee * sprawl - 0.12 * sprawl, 0, 0.1 + 0.48 * sprawl);

    torso.position.y = AVATAR_RIG.torsoY - 0.24 * knee * (1 - sprawl) - 0.12 * sprawl;
    shirt.position.y = AVATAR_RIG.shirtY - 0.22 * knee * (1 - sprawl) - 0.12 * sprawl;
    pelvis.position.y = AVATAR_RIG.pelvisY - 0.14 * knee * (1 - sprawl) - 0.04 * sprawl;
    head.position.y = AVATAR_RIG.headY - 0.17 * knee * (1 - sprawl) - 0.13 * sprawl;
    if (hair) {
      hair.position.y = head.position.y + (AVATAR_RIG.hairY - AVATAR_RIG.headY);
      hair.rotation.set(head.rotation.x, head.rotation.y, head.rotation.z);
    }
    if (bandana) {
      bandana.position.y = head.position.y + (AVATAR_RIG.hairY - AVATAR_RIG.headY);
      bandana.rotation.set(head.rotation.x, head.rotation.y, head.rotation.z);
    }

    // Lay it ON the deck. The body rotates about its SOLES, so a toppled corpse
    // hangs below the origin by however much of it is now on the far side of
    // the pivot; measure the posed bounds and lift by exactly that.
    this.liftOntoGround(mesh, corpse.basePos.y);
  }

  /** Raise (never lower) a posed mesh until its lowest point rests on `groundY`. */
  private liftOntoGround(mesh: THREE.Group, groundY: number) {
    mesh.updateMatrixWorld(true);
    CORPSE_BOX.setFromObject(mesh);
    const sink = CORPSE_BOX.min.y - groundY;
    if (sink < 0 && Number.isFinite(sink)) mesh.position.y -= sink;
  }

  /**
   * Skeleton collapse: the bones fold over ~0.8s, then the remains SETTLE —
   * a couple of damped ticks and a slow sag — so the pile still reads as a
   * corpse for the several seconds Game keeps it around instead of popping.
   */
  animateSkeletonDeath(mesh: THREE.Group) {
    const animation = mesh.userData.animation as {
      phase: number;
      parts?: Record<string, THREE.Object3D>;
    };
    const parts = animation?.parts;
    if (!parts) return;

    const torso = parts.torso;
    const pelvis = parts.pelvis;
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    const leftLegPivot = parts['leftLegPivot'] ?? parts['left-leg-pivot'];
    const rightLegPivot = parts['rightLegPivot'] ?? parts['right-leg-pivot'];
    const head = parts.head;
    if (!torso || !pelvis || !leftArmPivot || !rightArmPivot || !leftLegPivot || !rightLegPivot || !head) {
      return;
    }

    const deathTime = mesh.userData.deathTimer ?? 0;
    const settle = THREE.MathUtils.clamp(deathTime / 0.75, 0, 1);
    const collapse = THREE.MathUtils.smoothstep(settle, 0, 1);
    // Post-collapse settle: two damped shudders as the bones come to rest,
    // then a long slow sag so the pile keeps sinking imperceptibly.
    const after = Math.max(0, deathTime - 0.75);
    const shudder = Math.sin(after * 16) * 0.06 * Math.exp(-after * 5);
    const sag = Math.min(0.12, after * 0.02);

    torso.rotation.set(-0.72 * collapse + shudder, 0.18 * collapse, 0.14 * collapse + shudder * 0.5);
    pelvis.rotation.set(0.42 * collapse, 0.12 * collapse, -0.08 * collapse);
    head.rotation.set(0.4 * collapse + shudder * 0.8, -0.22 * collapse, 0.18 * collapse);
    leftArmPivot.rotation.set(-1.9 * collapse - shudder, -0.4 * collapse, -1.05 * collapse);
    rightArmPivot.rotation.set(-1.2 * collapse + shudder, 0.3 * collapse, 1.25 * collapse);
    leftLegPivot.rotation.set(0.92 * collapse, 0, -0.42 * collapse);
    rightLegPivot.rotation.set(-0.28 * collapse, 0, 0.76 * collapse);
    torso.position.y = AVATAR_RIG.torsoY - 0.42 * collapse - sag;
    pelvis.position.y = AVATAR_RIG.pelvisY - 0.24 * collapse - sag * 0.6;
    head.position.y = AVATAR_RIG.headY - 0.2 * collapse - sag;
  }
}
