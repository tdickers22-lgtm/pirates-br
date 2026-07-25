/**
 * Third-person avatar animation: gait, arms, tool/weapon poses, cutlass swing
 * timing, hit reactions, airborne/landing poses and the death crumple. Pure
 * presentation — mesh creation and removal stay in Game.
 */
import * as THREE from 'three';
import { PLAYER, WEAPONS } from '../../shared/constants/index.js';
import type { Player, Ship } from '../../shared/types/index.js';
import { angleWrap } from '../../shared/utils/index.js';
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
};

/** Directional flinch pushed in by Game on any health drop. */
type FlinchState = { t: number; mag: number; yaw: number };

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

  animatePlayerMesh(mesh: THREE.Group, player: Player, ship: Ship | null, dt: number) {
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

    const swimming = player.state === 'swimming';
    const downed = player.state === 'downed';
    const atStation = player.atCannon || player.atHelm || player.atCrowNest || player.mastClimb !== null;
    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
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

    torso.position.y = 1.28 + idleBob + walkLift * 0.35;
    shirt.position.y = 1.24 + idleBob + walkLift * 0.3;
    pelvis.position.y = 0.8 + idleBob * 0.35 + Math.sin(phase) * 0.05 * moveRatio;
    head.position.y = 1.92 + idleBob * 0.9;
    hair.position.y = 2.0 + idleBob * 0.9;
    bandana.position.y = 2.0 + idleBob * 0.9;
    if (coatSkirt) {
      coatSkirt.position.y = 0.66 + idleBob * 0.2;
      coatSkirt.rotation.set(0, Math.sin(phase) * 0.1 * moveRatio, 0);
    }

    torso.rotation.set(0.04, 0, 0);
    pelvis.rotation.set(0, 0, 0);
    head.rotation.set(0, angleWrap(player.rotation.x - mesh.rotation.y) * 0.28, 0);
    hair.rotation.set(0, head.rotation.y, 0);
    bandana.rotation.set(Math.PI * 0.5, head.rotation.y, 0);

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
      bandana.rotation.x = Math.PI * 0.5 + head.rotation.x;
      leftArmPivot.rotation.set(-2.4 * b + crawl * 0.6 * b, 0.1 * b, -0.25 * b);
      rightArmPivot.rotation.set(-2.4 * b - crawl * 0.6 * b, -0.1 * b, 0.25 * b);
      leftLegPivot.rotation.set(-0.28 * b + crawl * 0.28 * b, 0, -0.12 * b);
      rightLegPivot.rotation.set(-0.28 * b - crawl * 0.28 * b, 0, 0.12 * b);
      // Body flat on the deck: sink the torso stack toward ground level.
      torso.position.y -= 0.1 * b;
      head.position.y -= 0.06 * b;
      hair.position.y -= 0.06 * b;
      bandana.position.y -= 0.06 * b;
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
      const swimPitch = THREE.MathUtils.clamp(player.rotation.y, -0.65, 0.65);
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
        bandana.rotation.x = Math.PI * 0.5 + head.rotation.x;
        pelvis.rotation.x = -0.08;
        leftArmPivot.rotation.set(armFor(stroke), stroke * 0.2, -0.2 - stroke * 0.18);
        rightArmPivot.rotation.set(armFor(strokeOpp), strokeOpp * -0.2, 0.2 + strokeOpp * 0.18);
        leftLegPivot.rotation.set(-0.12 - kick * 0.4, 0, -0.06);
        rightLegPivot.rotation.set(-0.12 + kick * 0.4, 0, 0.06);
      }
    } else if (cutlassReady && player.blocking) {
      torso.rotation.x = 0.12;
      torso.rotation.y = -0.08;
      pelvis.rotation.y = 0.04;
      leftArmPivot.rotation.set(-0.42, 0.22, 0.34);
      rightArmPivot.rotation.set(-0.88, -0.1, -0.28);
      leftLegPivot.rotation.set(-walkSwing * 0.72, 0, -0.06);
      rightLegPivot.rotation.set(walkSwing * 0.72, 0, 0.06);
      torso.rotation.z = -walkSwing * 0.035;
    } else if (cutlassReady) {
      torso.rotation.x = 0.08;
      torso.rotation.y = -0.14 - cutlassCharge * 0.24;
      pelvis.rotation.y = 0.08 + cutlassCharge * 0.12;
      // The free arm swings a full stride; the sword arm keeps ~60% so the
      // blade stays presented. (At walking speed the old 0.45/0.18 factors
      // damped the swing to ±0.07rad — skeletons read as frozen-armed.)
      leftArmPivot.rotation.set(0.08 + armSwing * 1.0 - cutlassCharge * 0.22, 0.08 + cutlassCharge * 0.22, 0.24);
      rightArmPivot.rotation.set(-0.42 - armSwing * 0.58 - cutlassCharge * 0.82, -0.16 - cutlassCharge * 0.24, -0.38 - cutlassCharge * 0.35);
      leftLegPivot.rotation.set(-walkSwing * 1.05, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 1.05, 0, 0.04);
      torso.rotation.z = -walkSwing * 0.06 - cutlassCharge * 0.1;
    } else if (player.bailing) {
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
      leftLegPivot.rotation.set(-walkSwing * 0.4, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 0.4, 0, 0.04);
      torso.rotation.z = walkSwing * 0.04;
    } else {
      // Neutral gait: legs lead, arms trail, torso counter-rotates against the
      // pelvis and the head stabilises against the torso roll.
      const armRest = 0.2;
      leftArmPivot.rotation.set(armRest + armSwing, 0, -0.12 - Math.abs(armSwing) * 0.1);
      rightArmPivot.rotation.set(armRest - armSwing, 0, 0.12 + Math.abs(armSwing) * 0.1);
      leftLegPivot.rotation.set(-walkSwing * 1.15, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 1.15, 0, 0);
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
    }

    if (player.crouching) {
      // Hold-C crouch: everything sinks, knees bend; walk swing stays subtle.
      const crouchDrop = 0.32;
      torso.position.y -= crouchDrop;
      shirt.position.y -= crouchDrop;
      pelvis.position.y -= crouchDrop * 0.8;
      head.position.y -= crouchDrop;
      hair.position.y -= crouchDrop;
      bandana.position.y -= crouchDrop;
      torso.rotation.x += 0.14;
      leftLegPivot.rotation.x = -0.95 + walkSwing * 0.4;
      rightLegPivot.rotation.x = -0.75 - walkSwing * 0.4;
    }

    if (cutlassReady && !player.blocking && !swimming && !player.atHelm && !player.atCannon
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
    } else if (cutlassReady && !player.blocking && !swimming && !player.atHelm && !player.atCannon) {
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

    this.applyFlinch(mesh, parts, dt);
  }

  /**
   * Directional hit reaction — a brief additive jolt applied on top of whatever
   * pose the state branch produced. Game seeds `mesh.userData.flinch` on any
   * health drop; here it just decays.
   */
  private applyFlinch(mesh: THREE.Group, parts: Record<string, THREE.Object3D>, dt: number) {
    const flinch = mesh.userData.flinch as FlinchState | undefined;
    if (!flinch) return;
    flinch.t += dt;
    const FLINCH_TIME = 0.28;
    if (flinch.t >= FLINCH_TIME) {
      mesh.userData.flinch = undefined;
      return;
    }
    // Snap in over the first 25%, ease out across the rest.
    const p = flinch.t / FLINCH_TIME;
    const k = (p < 0.25 ? p / 0.25 : 1 - easeOutCubic((p - 0.25) / 0.75)) * flinch.mag;
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
      if (bandana) bandana.rotation.set(Math.PI * 0.5 + head.rotation.x, head.rotation.y, head.rotation.z);
      return;
    }

    // ── Whole-body topple. +rotation.x pitches the body face-DOWN, −x drops it
    // onto its back; rotation.z rolls it onto a flank.
    const fallPitch = pancake ? 1.32 : explosive ? -1.1 : limp ? -1.38 : -1.26;
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
    let dropY = -0.16 * knee * (1 - settleRaw) + 0.18 * settleRaw;
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

    torso.position.y = 1.28 - 0.34 * knee * (1 - sprawl) - 0.16 * sprawl;
    shirt.position.y = 1.24 - 0.32 * knee * (1 - sprawl) - 0.16 * sprawl;
    pelvis.position.y = 0.8 - 0.2 * knee * (1 - sprawl) - 0.06 * sprawl;
    head.position.y = 1.92 - 0.24 * knee * (1 - sprawl) - 0.18 * sprawl;
    if (hair) {
      hair.position.y = head.position.y + 0.08;
      hair.rotation.set(head.rotation.x, head.rotation.y, head.rotation.z);
    }
    if (bandana) {
      bandana.position.y = head.position.y + 0.08;
      bandana.rotation.set(Math.PI * 0.5 + head.rotation.x, head.rotation.y, head.rotation.z);
    }
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
    torso.position.y = 1.28 - 0.55 * collapse - sag;
    pelvis.position.y = 0.8 - 0.32 * collapse - sag * 0.6;
    head.position.y = 1.92 - 0.26 * collapse - sag;
  }
}
