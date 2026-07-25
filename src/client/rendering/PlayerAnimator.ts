/**
 * Third-person avatar animation: gait, arms, tool/weapon poses, cutlass swing
 * timing and the skeleton death slump. Pure presentation — mesh creation and
 * removal stay in Game.
 */
import * as THREE from 'three';
import { PLAYER, WEAPONS } from '../../shared/constants/index.js';
import type { Player, Ship } from '../../shared/types/index.js';
import { angleWrap } from '../../shared/utils/index.js';
import type { InputManager } from '../input/InputManager.js';
import type { OceanRenderer } from './OceanRenderer.js';

/** First-person cutlass charge/lunge timings, shared with the viewmodel code. */
export const CUTLASS_VIEW_CHARGE_TIME = 0.72;
export const CUTLASS_VIEW_LUNGE_COOLDOWN = 1.05;

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

export class PlayerAnimator {
  constructor(private readonly view: PlayerAnimatorView) {}

  /** Per-player swing-type latch so the cutlass anim keeps ONE denominator per swing. */
  readonly cutlassSwingKind = new Map<string, 'lunge' | 'swing'>();

  getCutlassSwingProgress(player: Player) {
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
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
    const animation = mesh.userData.animation as {
      phase: number;
      parts?: Record<string, THREE.Object3D>;
    };
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

    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    const moveRatio = Math.min(
      1,
      player.state === 'swimming'
        ? Math.max(0.38, moveSpeed / PLAYER.SWIM_SPEED)
        : moveSpeed / PLAYER.MOVE_SPEED,
    );
    const swimRate = player.state === 'swimming' ? 3.4 + moveRatio * 9.2 : 2.2 + moveRatio * 7.4;
    animation.phase = (animation.phase + dt * swimRate) % (Math.PI * 2);
    const phase = animation.phase;
    const deckSway = Math.sin(this.view.ocean.getTime() * 1.5 + mesh.position.x * 0.03 + mesh.position.z * 0.04) * 0.025;
    const walkSwing = Math.sin(phase) * 0.8 * moveRatio;
    const walkLift = Math.cos(phase * 2) * 0.05 * moveRatio;
    const idleBob = deckSway + Math.sin(this.view.ocean.getTime() * 2.1 + phase) * 0.018;
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    const cutlassReady = activeWeapon?.weaponId === 'cutlass';
    const cutlassSwing = cutlassReady ? this.view.getCutlassSwingProgress(player) : 0;
    // Remote swing-start edge → pooled world-space slash arc at the sword hand.
    if (player.id !== this.view.localPlayerId) {
      const prevSwing = (mesh.userData.prevCutlassSwing as number | undefined) ?? 0;
      if (cutlassSwing > 0.001 && prevSwing <= 0.001) {
        const hand = mesh.getObjectByName('right-hand');
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

    torso.position.y = 1.28 + idleBob + walkLift * 0.35;
    shirt.position.y = 1.24 + idleBob + walkLift * 0.3;
    pelvis.position.y = 0.8 + idleBob * 0.35;
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

    if (player.atHelm) {
      const helmLean = ship ? THREE.MathUtils.clamp(ship.angularVelocity * 0.035, -0.18, 0.18) : 0;
      torso.rotation.x = 0.16;
      torso.rotation.z = helmLean;
      leftArmPivot.rotation.set(-1.15, 0, -0.48);
      rightArmPivot.rotation.set(-1.15, 0, 0.48);
      leftLegPivot.rotation.set(0.14, 0, 0.05);
      rightLegPivot.rotation.set(-0.08, 0, -0.05);
    } else if (player.atSails) {
      torso.rotation.x = 0.08;
      torso.rotation.z = -0.06;
      leftArmPivot.rotation.set(-0.74, 0.12, -0.34);
      rightArmPivot.rotation.set(-0.96, -0.06, 0.28);
      leftLegPivot.rotation.set(0.1, 0, 0.02);
      rightLegPivot.rotation.set(-0.06, 0, -0.02);
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
      torso.rotation.x = 0.12;
      leftArmPivot.rotation.set(-0.9, 0, -0.18);
      rightArmPivot.rotation.set(-1.05, 0, 0.18);
      leftLegPivot.rotation.set(0.2, 0, 0);
      rightLegPivot.rotation.set(-0.16, 0, 0);
    } else if (player.state === 'swimming') {
      const swimPitch = THREE.MathUtils.clamp(player.rotation.y, -0.65, 0.65);
      const strokePhase = phase * 2.1;
      const kick = Math.sin(strokePhase);
      if (firearmReady) {
        const armStroke = localSwimAim ? 0.12 : 0.32;
        torso.rotation.x = -0.48 + swimPitch * 0.38 - (localSwimAim ? 0.08 : 0);
        torso.rotation.z = Math.sin(strokePhase * 0.8) * (localSwimAim ? 0.02 : 0.04);
        head.rotation.x = -swimPitch * 0.1;
        if (pelvis) pelvis.rotation.x = -0.18 + swimPitch * 0.08;
        leftArmPivot.rotation.set(-1.12 + Math.sin(strokePhase + Math.PI * 0.35) * armStroke, 0.08, -0.26);
        rightArmPivot.rotation.set(-0.82 - swimPitch * 0.22 - (localSwimAim ? 0.32 : 0.12), -0.08, 0.3);
        leftLegPivot.rotation.set(-0.34 - kick * 0.34, 0, -0.1);
        rightLegPivot.rotation.set(-0.34 + kick * 0.34, 0, 0.1);
      } else {
        torso.rotation.x = -0.42 + swimPitch * 0.32;
        torso.rotation.z = Math.sin(strokePhase * 0.9) * 0.05;
        head.rotation.x = -swimPitch * 0.12;
        if (pelvis) pelvis.rotation.x = -0.18 + swimPitch * 0.08;
        leftArmPivot.rotation.set(-1.52 + Math.sin(strokePhase) * 1.02, Math.sin(strokePhase) * 0.22, -0.24);
        rightArmPivot.rotation.set(-1.52 - Math.sin(strokePhase) * 1.02, -Math.sin(strokePhase) * 0.22, 0.24);
        leftLegPivot.rotation.set(-0.34 + Math.sin(strokePhase + Math.PI) * 0.34, 0, -0.08);
        rightLegPivot.rotation.set(-0.34 + Math.sin(strokePhase) * 0.34, 0, 0.08);
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
      leftArmPivot.rotation.set(0.08 + walkSwing * 0.45 - cutlassCharge * 0.22, 0.08 + cutlassCharge * 0.22, 0.24);
      rightArmPivot.rotation.set(-0.42 - walkSwing * 0.18 - cutlassCharge * 0.82, -0.16 - cutlassCharge * 0.24, -0.38 - cutlassCharge * 0.35);
      leftLegPivot.rotation.set(-walkSwing * 1.05, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 1.05, 0, 0.04);
      torso.rotation.z = -walkSwing * 0.06 - cutlassCharge * 0.1;
    } else if (player.bailing) {
      // Bailing crew visibly SCOOP (bow low, arms down into the bilge) and
      // TOSS (straighten, both arms flinging out) so remote players read the
      // bucket work instead of a default idle-swing.
      const bailProg = 1 - THREE.MathUtils.clamp(player.bailScoopProgress ?? 0, 0, 1);
      const bailArc = Math.sin(Math.min(1, bailProg / 0.7) * Math.PI);
      if (player.bucketFilled) {
        torso.rotation.x = 0.16 + bailArc * 0.34;
        pelvis.rotation.x = 0.06 + bailArc * 0.12;
        leftArmPivot.rotation.set(0.55 + bailArc * 0.6, 0.1, -0.2);
        rightArmPivot.rotation.set(0.55 + bailArc * 0.6, -0.1, 0.2);
      } else {
        torso.rotation.x = 0.24 - bailArc * 0.42;
        pelvis.rotation.x = 0.08 - bailArc * 0.1;
        leftArmPivot.rotation.set(0.7 - bailArc * 1.9, 0.12, -0.16);
        rightArmPivot.rotation.set(0.7 - bailArc * 1.9, -0.12, 0.16);
      }
      leftLegPivot.rotation.set(-walkSwing * 0.4, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 0.4, 0, 0.04);
      torso.rotation.z = walkSwing * 0.04;
    } else {
      const armRest = 0.2;
      leftArmPivot.rotation.set(armRest + walkSwing, 0, -0.12);
      rightArmPivot.rotation.set(armRest - walkSwing, 0, 0.12);
      leftLegPivot.rotation.set(-walkSwing * 1.15, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 1.15, 0, 0);
      torso.rotation.z = walkSwing * 0.08;
    }

    if (player.crouching) {
      // Hold-C crouch: everything sinks, knees bend; walk swing stays subtle.
      const crouchDrop = 0.32;
      torso.position.y -= crouchDrop;
      shirt.position.y -= crouchDrop;
      pelvis.position.y -= crouchDrop * 0.8;
      head.position.y -= crouchDrop;
      torso.rotation.x += 0.14;
      leftLegPivot.rotation.x = -0.95 + walkSwing * 0.4;
      rightLegPivot.rotation.x = -0.75 - walkSwing * 0.4;
    }

    if (cutlassReady && !player.blocking && player.state !== 'swimming' && !player.atHelm && !player.atCannon && !player.atSails
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
    } else if (cutlassReady && !player.blocking && player.state !== 'swimming' && !player.atHelm && !player.atCannon && !player.atSails) {
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
  }

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

    torso.rotation.set(-0.72 * collapse, 0.18 * collapse, 0.14 * collapse);
    pelvis.rotation.set(0.42 * collapse, 0.12 * collapse, -0.08 * collapse);
    head.rotation.set(0.4 * collapse, -0.22 * collapse, 0.18 * collapse);
    leftArmPivot.rotation.set(-1.9 * collapse, -0.4 * collapse, -1.05 * collapse);
    rightArmPivot.rotation.set(-1.2 * collapse, 0.3 * collapse, 1.25 * collapse);
    leftLegPivot.rotation.set(0.92 * collapse, 0, -0.42 * collapse);
    rightLegPivot.rotation.set(-0.28 * collapse, 0, 0.76 * collapse);
    torso.position.y = 1.28 - 0.55 * collapse;
    pelvis.position.y = 0.8 - 0.32 * collapse;
    head.position.y = 1.92 - 0.26 * collapse;
  }
}
