/**
 * First-person viewmodel: the held weapon, hands, pocket-item preview, muzzle
 * flash, capstan hands and the cutlass slash ribbons. Owns its own scene groups
 * (parented to the camera by Game) and reads the rest of the world through a
 * narrow `ViewmodelView`.
 */
import * as THREE from 'three';
import { WEAPONS } from '../../shared/constants/index.js';
import type { Player, Ship, TreasureChest, WeaponId, WeaponInstance } from '../../shared/types/index.js';
import type { ClientInteractKind } from '../core/Game.js';
import type { InputManager } from '../input/InputManager.js';
import type { MapRenderer } from '../ui/MapRenderer.js';
import { applyViewmodelMaterialSettings, makeHeldWeaponMesh, makePocketPreviewMesh, type PocketPreviewKind } from './factories/WeaponMeshFactory.js';
import { makeCarpentersHammerMesh, toolGlbReady, type ToolGlbName } from './factories/MiscMeshFactory.js';
import { makeViewHand, applyViewHandTeamColor } from './factories/PlayerMeshFactory.js';
import { registerBudgetLight } from './LightBudget.js';
import { CUTLASS_VIEW_CHARGE_TIME } from './PlayerAnimator.js';
import type { CombatFx } from './CombatFx.js';
import type { OceanRenderer } from './OceanRenderer.js';
import type { Renderer } from './Renderer.js';
import {
  CUTLASS_GUARD, SLASH_SWING_TIME, VIEW_DRAW_TIME, cutlassLungePose, cutlassRestPose, cutlassSlashPose,
  drawDelta, muzzleTipFor, toolPose, recoilEnvelope, recoilSpecFor, reloadChoreography, slashRibbonPose, weaponPose,
  type Pose6,
} from './viewmodel/poses.js';
import {
  REPAIR_BLOW_S, repairBlowsFor, repairBlowPhase, hammerSwingAngle, HAMMER_IMPACT_PHASE,
  REPAIR_HAMMER_PIVOT, bucketWaterShown, bucketThrowDroplet,
} from './viewmodel/poses.js';
import { repairBlowPosition } from './viewmodel/repairBlows.js';

/** A held mesh built from the primitive while its tool GLB was in flight. */
function toolGlbArrived(mesh: THREE.Object3D | null | undefined): boolean {
  const pending = mesh?.userData.toolGlbPending as ToolGlbName | undefined;
  return !!pending && toolGlbReady(pending);
}
const BUCKET_DROPLETS = 12;

// MIN_OFF_AXIS (the long-tool off-axis floor) now lives in viewmodel/poses.ts as TOOL_MIN_OFF_AXIS.

/** A first-person hand attachment in viewmodel-root space. */
type HandGrip = { pos: [number, number, number]; rot: [number, number, number]; scale?: number };

export type ViewmodelView = {
  readonly combatFx: CombatFx;
  readonly input: InputManager;
  readonly ocean: OceanRenderer;
  readonly renderer: Renderer;
  readonly map: MapRenderer;
  readonly shipsById: Map<string, Ship>;
  readonly cutlassSwingKind: Map<string, 'lunge' | 'swing'>;
  readonly frameDt: number;
  readonly lanternRaise01: number;
  readonly lastInteractKind: ClientInteractKind | null;
  readonly localPlayerId: string | null;
  readonly spyglassActive: boolean;
  readonly visibleInteractKind: ClientInteractKind | null;
  cameraShake: number;
  cutlassDashKick: number;
  pocketUsePreviewKind: PocketPreviewKind | null;
  pocketUsePreviewTimer: number;
  prevCutlassSwingProgress: number;
  findChestById(chestId: string): TreasureChest | null;
  getCutlassSwingProgress(player: Player): number;
  getLocalPlayer(): Player | null;
  getPocketWheelCount(player: Player, slot: number): number;
  getPocketWheelKind(player: Player | null, slot: number): PocketPreviewKind | null;
};

export class ViewmodelController {
  constructor(private readonly view: ViewmodelView) {}

  readonly localViewWeaponRoot = new THREE.Group();
  /** First-person hands shown while cranking the capstan (anchor hold). */
  readonly localViewHandsRoot = new THREE.Group();
  private capstanHandsBuilt = false;
  readonly localViewPocketRoot = new THREE.Group();
  localViewPocketKind: PocketPreviewKind | null = null;
  localViewWeaponId: WeaponInstance['weaponId'] | null = null;
  /** Seconds since the last shot's recoil impulse (Infinity = settled). */
  private recoilAge = Infinity;
  /** Envelope value when the last shot landed (a follow-up climbs from there). */
  private recoilFrom = 0;
  /** Current recoil envelope 0..1 (poses.recoilEnvelope). Writing 0 settles it. */
  get localViewWeaponKick(): number {
    return recoilEnvelope(recoilSpecFor(this.localViewWeaponId ?? 'flintknock'), this.recoilAge, this.recoilFrom);
  }
  set localViewWeaponKick(v: number) {
    if (v <= 0) { this.recoilAge = Infinity; this.recoilFrom = 0; }
  }
  /** First-person muzzle flash + powder smoke on the local viewmodel barrel. */
  private muzzleFlash: THREE.Sprite | null = null;
  private muzzleGlow: THREE.PointLight | null = null;
  private muzzleSmoke: THREE.Sprite[] = [];
  private muzzleFlashTimer = 0;
  private prevLocalFiring = false;
  /** Last ramrod pulse index played, so each stroke nudges the camera once. */
  private prevReloadPulse = -1;
  localViewWeaponReloadPhase = 0;
  private localCutlassCharge = 0;
  localViewWeaponAmmoSignature = '';
  /** Alternating slash diagonal for the first-person cutlass (flips per swing). */
  cutlassSlashSide: 1 | -1 = 1;
  /** Camera-space crescent ribbons (2, alternating) for the first-person slash. */
  private slashRibbons: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; side: 1 | -1 }> = [];
  private slashRibbonCursor = 0;
  /** Straight forward streak for the cutlass dash-lunge. */
  private slashStreak: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number } | null = null;
  private slashTexture: THREE.CanvasTexture | null = null;
  /** World-space billboard arcs at REMOTE players' sword hands (pooled). */
  private remoteSlashArcs: Array<{ sprite: THREE.Sprite; age: number; life: number }> = [];
  private remoteSlashCursor = 0;

  /** Called once at boot; the rig rebuilds itself if a match reset clears the
   *  viewmodel root out from under it (which used to kill the flash forever). */
  /** Match teardown: drop the held meshes but KEEP the muzzle rig and hands,
   *  which are permanent children of the viewmodel roots. */
  resetForMatch() {
    this.localViewWeaponRoot.getObjectByName('local-view-weapon')?.removeFromParent();
    this.localViewPocketRoot.getObjectByName('local-pocket')?.removeFromParent();
    this.localViewWeaponRoot.visible = false;
    this.localViewPocketRoot.visible = false;
    this.localViewHandsRoot.visible = false;
    this.localViewWeaponId = null;
    this.localViewPocketKind = null;
    this.localViewWeaponKick = 0;
    this.localViewWeaponReloadPhase = 0;
    this.localViewDrawTimer = 1;
    this.localViewPocketDrawTimer = 1;
    this.localCutlassCharge = 0;
    this.prevReloadPulse = -1;
    if (this.weaponHands) {
      this.weaponHands.left.visible = false;
      this.weaponHands.right.visible = false;
    }
    if (this.pocketHands) {
      this.pocketHands.left.visible = false;
      this.pocketHands.right.visible = false;
    }
    this.hideSwimHands();
    this.setupMuzzleFlash();
  }

  setupMuzzleFlash() {
    if (this.muzzleFlash && this.muzzleFlash.parent) return;
    this.buildMuzzleFlash();
  }

  private buildMuzzleFlash() {
    this.muzzleSmoke.length = 0;
    // Radial flare texture for the flash + smoke, drawn once.
    const tex = (inner: string, outer: string) => {
      const size = 64;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, inner);
      g.addColorStop(0.5, outer);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(c);
    };
    const flashTex = tex('rgba(255,246,214,1)', 'rgba(255,168,52,0.7)');
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0, depthTest: false, depthWrite: false,
    }));
    this.muzzleFlash.renderOrder = 1000;
    this.muzzleFlash.visible = false;
    this.localViewWeaponRoot.add(this.muzzleFlash);
    this.muzzleGlow = new THREE.PointLight(0xffb347, 0, 6, 2);
    registerBudgetLight(this.muzzleGlow);
    this.localViewWeaponRoot.add(this.muzzleGlow);
    const smokeTex = tex('rgba(180,180,180,0.6)', 'rgba(120,120,120,0.25)');
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
      }));
      s.renderOrder = 999;
      s.visible = false;
      this.localViewWeaponRoot.add(s);
      this.muzzleSmoke.push(s);
    }
  }

  /**
   * Barrel-tip offset per weapon, in viewmodel-ROOT space.
   *
   * AXIS NOTE (this was the "handguns show no muzzle flash" bug): the camera
   * looks down −Z, and every gun mesh is authored +Z-forward then yawed 180°
   * into the root — so the muzzle sits at NEGATIVE z here. The old positive
   * offsets parked the flash, its light and all four smoke puffs *behind the
   * camera*, where nothing could ever see them. Values below are the mesh
   * muzzle position × the mesh scale applied in syncLocalViewWeapon, negated.
   */
  private muzzleTipFor(weaponId: WeaponId): [number, number, number] {
    return muzzleTipFor(weaponId);
  }

  triggerMuzzleFlash(weaponId: WeaponId) {
    this.setupMuzzleFlash();
    if (!this.muzzleFlash || !this.muzzleGlow) return;
    const [tx, ty, tz] = this.muzzleTipFor(weaponId);
    const scatter = weaponId === 'blunderbuss' ? 1.5 : 1;
    this.muzzleFlash.position.set(tx, ty, tz);
    const flashScale = (weaponId === 'blunderbuss' ? 0.55 : weaponId === 'eye_of_reach' ? 0.4 : 0.32) * scatter;
    this.muzzleFlash.scale.set(flashScale, flashScale, 1);
    this.muzzleFlash.material.rotation = Math.sin(this.view.ocean.getTime() * 91.7) * Math.PI;
    this.muzzleFlash.visible = true;
    this.muzzleFlash.material.opacity = 1;
    this.muzzleGlow.position.set(tx, ty, tz);
    this.muzzleGlow.intensity = 5 * scatter;
    // ≥90ms so the flash always survives at least 5 frames at 60fps — a
    // 2-frame flash reads as nothing at all.
    this.muzzleFlashTimer = 0.11;
    // Smoke puffs drift forward (−Z) out of the barrel and fade.
    for (let i = 0; i < this.muzzleSmoke.length; i++) {
      const s = this.muzzleSmoke[i];
      s.position.set(tx + (Math.sin(i * 2.1) * 0.05), ty + 0.02 + i * 0.015, tz - 0.05 - i * 0.04);
      s.scale.setScalar(0.14 + i * 0.05);
      s.material.opacity = 0.55 - i * 0.08;
      s.visible = true;
      s.userData.smokeLife = 0.55 + i * 0.14;
      s.userData.smokeAge = 0;
    }
  }

  updateMuzzleFlash(dt: number) {
    if (this.muzzleFlash && this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer -= dt;
      const k = Math.max(0, this.muzzleFlashTimer / 0.11);
      this.muzzleFlash.material.opacity = k;
      if (this.muzzleGlow) this.muzzleGlow.intensity = 5 * k;
      if (this.muzzleFlashTimer <= 0) {
        this.muzzleFlash.visible = false;
        if (this.muzzleGlow) this.muzzleGlow.intensity = 0;
      }
    }
    for (const s of this.muzzleSmoke) {
      if (!s.visible) continue;
      s.userData.smokeAge = (s.userData.smokeAge ?? 0) + dt;
      const life = s.userData.smokeLife ?? 0.5;
      const a = s.userData.smokeAge / life;
      if (a >= 1) { s.visible = false; continue; }
      s.position.z -= dt * 0.5;
      s.position.y += dt * 0.12;
      s.scale.setScalar(s.scale.x + dt * 0.35);
      s.material.opacity = (1 - a) * 0.4;
    }
  }

  // ── First-person hands ────────────────────────────────────────────────────
  // Every weapon and tool is gripped by a real forearm+fist parented INTO the
  // matching viewmodel root, so the hands inherit bob, sway, recoil, reload and
  // swing poses for free. Grips are authored in ROOT space: the item mesh is
  // built +Z-forward and yawed 180° into the root, so a grip at mesh (x,y,z)
  // with mesh scale s lands at (−x·s, y·s, −z·s) here.
  private weaponHands: { left: THREE.Group; right: THREE.Group } | null = null;
  private pocketHands: { left: THREE.Group; right: THREE.Group } | null = null;
  private swimHands: { left: THREE.Group; right: THREE.Group } | null = null;
  private capstanRig: THREE.Group | null = null;
  private swimRig: THREE.Group | null = null;
  /** 0→1 draw-in for a freshly equipped weapon/tool (kills the teleport swap). */
  private localViewDrawTimer = 1;
  private localViewPocketDrawTimer = 1;
  /** b2.3h repair: both fists follow the plank and the swinging hammer. */
  private repairHandGrips: { left: HandGrip | null; right: HandGrip | null } | null = null;
  /** Replication-rate estimate of the hole's repair time (s) -> blows 2/3/4. */
  private repairProgPrev = 0;
  private repairProgAt = 0;
  private repairTimeEst = 2.4;
  private repairBlowX = 0;
  private repairBlowXAt = -Infinity;
  /** The live blow position (0..blows, extrapolated like the swing) while the
   *  first-person hammer is up, else null. FloodAudio fires the mallet on its
   *  HAMMER_IMPACT_PHASE crossings so sound and swing line up. */
  getRepairBlowPosition(): number | null {
    return this.view.ocean.getTime() - this.repairBlowXAt <= 0.1 ? this.repairBlowX : null;
  }
  /** The repair time the swing is paced on (s), for the fallback blow clock. */
  getRepairTimeEstimate(): number {
    return this.repairTimeEst;
  }
  /** Water leaving the bucket on a throw: one instanced draw, hidden when idle. */
  private bucketSpray: THREE.InstancedMesh | null = null;
  /** Swim-stroke clock for the first-person crawl arms. */
  private swimStrokePhase = 0;

  /**
   * A gripping fist has to paint OVER the thing it is gripping. Everything in a
   * viewmodel runs depthTest off at renderOrder 999, so with equal orders the
   * draw sequence is arbitrary — and it lost: measured with NDC projection, the
   * axe, shovel and cutlass fists were visible, on-screen and completely buried
   * inside the haft/knuckle-bow they were holding. That is the whole "hand-less
   * floating prop" read. Hands draw last, always.
   */
  private static readonly HAND_RENDER_ORDER = 1004;

  /** The crew colour the world coat is wearing, once Game knows it (avatar-18). */
  private localCrewColor: number | null = null;

  /**
   * Tell the viewmodel which crew you are on. Called from syncPlayers with the
   * same number `applyPlayerTeamColor` gives the world mesh, so the sleeve you
   * see and the coat everyone else sees on you are one garment. Cheap: both
   * sides bail on an unchanged colour, so this is a no-op after the first frame.
   */
  setLocalCrewColor(color: number) {
    if (this.localCrewColor === color) return;
    this.localCrewColor = color;
    if (this.weaponHands) { applyViewHandTeamColor(this.weaponHands.left, color); applyViewHandTeamColor(this.weaponHands.right, color); }
    if (this.pocketHands) { applyViewHandTeamColor(this.pocketHands.left, color); applyViewHandTeamColor(this.pocketHands.right, color); }
  }

  private makeHand(side: 1 | -1, parent: THREE.Group): THREE.Group {
    const hand = makeViewHand(side);
    if (this.localCrewColor !== null) applyViewHandTeamColor(hand, this.localCrewColor);
    applyViewmodelMaterialSettings(hand);
    hand.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) object.renderOrder = ViewmodelController.HAND_RENDER_ORDER;
    });
    hand.visible = false;
    parent.add(hand);
    return hand;
  }

  private ensureWeaponHands() {
    if (this.weaponHands) return this.weaponHands;
    this.weaponHands = {
      left: this.makeHand(-1, this.localViewWeaponRoot),
      right: this.makeHand(1, this.localViewWeaponRoot),
    };
    return this.weaponHands;
  }

  private ensurePocketHands() {
    if (this.pocketHands) return this.pocketHands;
    this.pocketHands = {
      left: this.makeHand(-1, this.localViewPocketRoot),
      right: this.makeHand(1, this.localViewPocketRoot),
    };
    return this.pocketHands;
  }

  /** Position both hands on the item's grips; `left`/`right` null = hand hidden. */
  private placeHands(
    hands: { left: THREE.Group; right: THREE.Group },
    grips: { left: HandGrip | null; right: HandGrip | null },
  ) {
    for (const key of ['left', 'right'] as const) {
      const hand = hands[key];
      const grip = grips[key];
      if (!grip) {
        hand.visible = false;
        continue;
      }
      hand.visible = true;
      hand.position.set(grip.pos[0], grip.pos[1], grip.pos[2]);
      hand.rotation.set(grip.rot[0], grip.rot[1], grip.rot[2]);
      hand.scale.setScalar(grip.scale ?? 1);
    }
  }

  /** Grip transforms per weapon (root space — see the note above).
   *  SCREEN RULE: every grip below is verified by projecting the palm to NDC
   *  (scripts/viewmodel-hands-probe.mjs). A fist whose palm sits below
   *  ndc.y ≈ −0.9 is off the bottom of the frame and the weapon reads as a
   *  floating prop again, no matter that `visible` is true. */
  private weaponGrips(weaponId: WeaponId): { left: HandGrip | null; right: HandGrip | null } {
    switch (weaponId) {
      // Forearms are pitched steeply DOWN (rot.x ≈ 1) so they exit through the
      // bottom of the frame instead of running back at the lens, where they
      // read as giant logs across the lower third.
      case 'blunderbuss':
        return {
          // Trigger hand at the small of the stock, support hand under the fore-end.
          right: { pos: [0.015, -0.11, 0.035], rot: [1.0, 0.2, 0.12], scale: 1.12 },
          left: { pos: [-0.01, -0.07, -0.235], rot: [1.05, -0.36, -0.16], scale: 1.12 },
        };
      case 'eye_of_reach':
        return {
          right: { pos: [0.015, -0.1, 0.03], rot: [1.0, 0.2, 0.12], scale: 1.12 },
          left: { pos: [-0.01, -0.05, -0.3], rot: [1.05, -0.36, -0.16], scale: 1.12 },
        };
      case 'flintknock':
        return {
          right: { pos: [0.01, -0.1, 0.04], rot: [0.95, 0.18, 0.12], scale: 1.12 },
          left: null,
        };
      case 'cutlass':
        // Lifted off the pommel and onto the grip proper: at −0.13 the fist rode
        // the bottom edge (palm ndc.y ≈ −0.8 at rest, off-frame on the dash
        // windup) and the sword read as a blade with nothing behind it.
        return {
          right: { pos: [0.005, -0.05, 0.015], rot: [0.9, 0.14, 0.1], scale: 1.16 },
          left: null,
        };
      default:
        return {
          right: { pos: [0.01, -0.1, 0.03], rot: [0.95, 0.18, 0.12], scale: 1.12 },
          left: { pos: [-0.01, -0.05, -0.28], rot: [1.05, -0.36, -0.16], scale: 1.12 },
        };
    }
  }

  /** Grip transforms per pocket item (root space). Chest and keg meshes ship
   *  with their own modelled hands, so they opt out. */
  private pocketGrips(kind: PocketPreviewKind): { left: HandGrip | null; right: HandGrip | null } {
    switch (kind) {
      case 'chest':
      case 'powder_keg':
        return { left: null, right: null };
      case 'bucket':
        return { right: { pos: [0.0, 0.16, 0.0], rot: [0.5, 0.12, 0.1], scale: 1.25 }, left: null };
      case 'lantern':
        return { right: { pos: [0.0, 0.33, 0.0], rot: [0.45, 0.1, 0.08], scale: 1.25 }, left: null };
      case 'compass':
        return { right: { pos: [0.02, -0.07, 0.02], rot: [0.15, 0.1, 0.1], scale: 1.15 }, left: null };
      case 'spyglass':
        return { right: { pos: [0.0, -0.07, 0.03], rot: [0.42, 0.1, 0.1], scale: 1.15 }, left: null };
      // LONG TOOLS: the rear fist used to sit far down the haft toward the lens
      // (root z +0.30/+0.34), which threw the palm to ndc.y −1.5/−1.7 — clean
      // off the bottom of the frame. Both fists now ride the middle of the
      // shaft, a hand's width apart, and are sized up to match a 1.7–1.8×
      // tool (a default-scale fist vanishes inside a haft that thick).
      case 'shovel':
        return {
          right: { pos: [0.0, 0.0, 0.14], rot: [0.5, 0.16, 0.1], scale: 1.5 },
          left: { pos: [0.0, 0.0, -0.1], rot: [0.62, -0.36, -0.14], scale: 1.5 },
        };
      case 'axe':
        return {
          right: { pos: [0.0, 0.0, 0.13], rot: [0.5, 0.16, 0.1], scale: 1.5 },
          left: { pos: [0.0, 0.0, -0.05], rot: [0.6, -0.32, -0.12], scale: 1.5 },
        };
      case 'wood':
        return {
          right: { pos: [0.14, -0.05, 0.1], rot: [0.5, 0.2, 0.12], scale: 1.2 },
          left: { pos: [-0.14, -0.05, 0.1], rot: [0.5, -0.2, -0.12], scale: 1.2 },
        };
      default:
        // Food and everything else: one cupped hand under the item.
        return { right: { pos: [0.02, -0.08, 0.03], rot: [0.28, 0.12, 0.1], scale: 1.2 }, left: null };
    }
  }

  /**
   * First-person swim strokes: two crawl arms sweeping in from the screen
   * edges. Replaces the old nothing-at-all (the weapon is stowed while
   * swimming, and until now nothing took its place).
   */
  private updateSwimHands(moveAmount: number, dt: number) {
    if (!this.swimRig) {
      const rig = new THREE.Group();
      this.swimHands = { left: this.makeHand(-1, rig), right: this.makeHand(1, rig) };
      this.swimRig = rig;
      this.localViewHandsRoot.add(rig);
    }
    const hands = this.swimHands!;
    this.swimRig.visible = true;
    if (this.capstanRig) this.capstanRig.visible = false;
    this.localViewHandsRoot.visible = true;
    this.localViewHandsRoot.position.set(0, 0, 0);
    this.localViewHandsRoot.rotation.set(0, 0, 0);
    this.swimStrokePhase = (this.swimStrokePhase + dt * (0.75 + moveAmount * 0.85)) % 1;

    for (const key of ['left', 'right'] as const) {
      const side = key === 'left' ? -1 : 1;
      const hand = hands[key];
      const p = (this.swimStrokePhase + (key === 'left' ? 0.5 : 0)) % 1;
      // REACH (0–0.45): the arm drives forward past the head. PULL (0.45–1):
      // it sweeps down and back along the flank, out of frame.
      const reach = THREE.MathUtils.smoothstep(p, 0, 0.45);
      const pull = THREE.MathUtils.smoothstep(p, 0.45, 0.95);
      const ext = reach - pull;
      hand.visible = true;
      hand.scale.setScalar(0.95);
      // Kept a metre out in front: closer than that and a forearm fills a
      // quarter of the screen as an unreadable log (and below z ≈ −0.5 the
      // stroke sits under the bottom edge entirely).
      hand.position.set(
        side * (0.5 - ext * 0.3),
        -0.46 + ext * 0.4,
        -1.05 - ext * 0.42,
      );
      hand.rotation.set(
        0.95 - ext * 0.9,
        side * (0.46 - ext * 0.3),
        side * (0.34 - ext * 0.5),
      );
    }
  }

  private hideSwimHands() {
    if (this.swimRig) this.swimRig.visible = false;
  }

  private buildCapstanHands() {
    if (this.capstanHandsBuilt) return;
    this.capstanHandsBuilt = true;
    // Own subgroup so the capstan rig and the swim-stroke rig can share
    // localViewHandsRoot without fighting over its visibility.
    const rig = new THREE.Group();
    this.capstanRig = rig;
    this.localViewHandsRoot.add(rig);
    // These are FIRST-PERSON hands, and they are drawn straight into the world
    // scene on the camera. You crank a capstan standing on top of it, so the
    // drum sits centimetres from the eye — nearer than the bar, nearer than the
    // fists — and the depth test buried the whole rig inside it every single
    // time. (Measured: the gate fired, the rig was visible, the anchor was
    // rising, and the screen was pure capstan.) A viewmodel does not participate
    // in world depth: draw it last, over everything.
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x4a331e, roughness: 0.9, depthTest: false, depthWrite: false,
    });
    // THE SPOKE BAR: a proper capstan bar, thick enough to be gripped rather
    // than a wire, laid across the lower-middle frame.
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 10), barMat);
    bar.rotation.z = Math.PI * 0.5;
    bar.position.set(0, -0.255, -0.62);
    bar.renderOrder = 996;
    rig.add(bar);
    // THE HANDS. The old rig hand-built two flat skin-coloured boxes with three
    // stubby fingers, and against a capstan drum that fills the frame they read
    // as pale tiles lying on the deck — the "diagnosed, improved, unresolved"
    // symptom. These are the SAME forearm+fist+sleeve+curled-fingers rig every
    // other viewmodel uses (makeViewHand), scaled up 1.55 and set on the bar a
    // shoulder-width apart, so they land at ndc [±0.36, −0.51]: two chunky
    // gripping fists in the lower-middle frame, sleeves running back out of
    // shot past the lens. Consistency with the weapon hands is the point — the
    // player already knows what his own fists look like.
    const gripHands = { left: this.makeHand(-1, rig), right: this.makeHand(1, rig) };
    for (const key of ['left', 'right'] as const) {
      const side = key === 'left' ? -1 : 1;
      const hand = gripHands[key];
      hand.visible = true;
      hand.scale.setScalar(1.55);
      // Palm on top of the bar, knuckles forward, forearm angled down-back so it
      // exits through the bottom of the frame instead of running at the lens.
      hand.position.set(side * 0.3, -0.24, -0.62);
      hand.rotation.set(0.62, side * 0.22, side * 0.12);
      // makeHand already stamps HAND_RENDER_ORDER (1004) on every mesh, which is
      // above the bar's 996 — the fists paint over the thing they are holding.
    }
    this.capstanGripHands = gripHands;
  }

  /** Kept so the crank cycle can wring the fists on the bar per push. */
  private capstanGripHands: { left: THREE.Group; right: THREE.Group } | null = null;

  /** Show working hands on the capstan bar while the anchor hold runs. */
  updateCapstanHands() {
    const player = this.view.getLocalPlayer();
    const ship = player?.onShipId ? this.view.shipsById.get(player.onShipId) : null;
    // Show the crank hands the instant you grab the capstan (holding X with
    // the anchor interaction resolved), not only once the anchor is already
    // rising — the old progress>0.001 gate made them flicker/never show.
    const cranking = !!player && !!ship
      && ship.anchored
      && this.view.input.isInteractHeld()
      && (this.view.visibleInteractKind === 'anchor' || this.view.lastInteractKind === 'anchor');
    if (cranking) this.buildCapstanHands();
    if (this.capstanRig) this.capstanRig.visible = !!cranking;
    // This pass runs AFTER syncLocalViewWeapon in the frame, so it must not
    // clobber the swim-stroke rig's request to be visible (it did: the crawl
    // arms were built, posed and then hidden every single frame).
    this.localViewHandsRoot.visible = !!cranking || !!this.swimRig?.visible;
    if (cranking) {
      this.localViewWeaponRoot.visible = false;
      // Both hands are on the bar — you cannot also be holding a shovel. (The
      // pocket viewmodel used to stay up, so the audit shot of the crank showed
      // a tool floating over the drum next to the crank hands.)
      this.localViewPocketRoot.visible = false;
      const t = this.view.ocean.getTime();
      // PUSH-WALK cycle, not a floating bar: sweep the bar+hands ~70° LEFT
      // around a vertical axis ~0.8m ahead (walking a capstan spoke around),
      // then a quick 0.25s re-grip — hands dip, the bar snaps back right.
      const PUSH = 1.1;
      const REGRIP = 0.25;
      const cycle = t % (PUSH + REGRIP);
      const SWEEP = THREE.MathUtils.degToRad(70);
      let theta: number;
      let dip = 0;
      if (cycle < PUSH) {
        const p = cycle / PUSH;
        theta = SWEEP * (0.5 - p); // +35° → -35°, constant spoke speed
        dip = Math.abs(Math.sin(t * 6.2)) * -0.025; // shoulder heave per step
      } else {
        const u = (cycle - PUSH) / REGRIP;
        const e = u * u * (3 - 2 * u);
        theta = SWEEP * (e - 0.5); // snap back right for the next spoke
        dip = -0.09 * Math.sin(u * Math.PI); // hands drop off the bar and re-grip
      }
      // Rotate the whole hands rig about the pivot at (0, 0, -0.8): keep that
      // point fixed so the bar orbits it like a real spoke.
      const PIVOT_Z = -0.8;
      this.localViewHandsRoot.rotation.set(0, theta, Math.sin(t * 3.1) * 0.04);
      this.localViewHandsRoot.position.set(
        PIVOT_Z * -Math.sin(theta),
        dip,
        PIVOT_Z - PIVOT_Z * Math.cos(theta),
      );
      // Per-push WRING on the bar: the fists roll and squeeze forward as he
      // leans into the spoke, then open and re-set on the regrip. Without this
      // the pair is a static decal riding a rotating group, which is most of why
      // they never read as hands doing work.
      if (this.capstanGripHands) {
        const heave = cycle < PUSH ? Math.sin((cycle / PUSH) * Math.PI) : 0;
        const open = cycle < PUSH ? 0 : Math.sin(((cycle - PUSH) / REGRIP) * Math.PI);
        for (const key of ['left', 'right'] as const) {
          const side = key === 'left' ? -1 : 1;
          const hand = this.capstanGripHands[key];
          hand.position.set(
            side * (0.3 - heave * 0.015),
            -0.24 - open * 0.07,
            -0.62 - heave * 0.035,
          );
          hand.rotation.set(
            0.62 + heave * 0.16 - open * 0.3,
            side * (0.22 + heave * 0.06),
            side * (0.12 + heave * 0.1),
          );
        }
      }
    }
  }

  // ── Anime slash trails ──────────────────────────────────────────────────
  /** Additive white gradient strip: bright head fading down the tail. */
  private getSlashTexture(): THREE.CanvasTexture {
    if (this.slashTexture) return this.slashTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 32);
    // Soft vertical falloff so the band has no hard edges.
    const vGrad = ctx.createLinearGradient(0, 0, 0, 32);
    vGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vGrad.addColorStop(0.5, 'rgba(0,0,0,1)');
    vGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = vGrad;
    ctx.fillRect(0, 0, 128, 32);
    this.slashTexture = new THREE.CanvasTexture(canvas);
    this.slashTexture.minFilter = THREE.LinearFilter;
    return this.slashTexture;
  }

  /** Crescent band (~130°) tapering tail→head, in the camera XY plane. */
  private buildSlashArcGeometry(): THREE.BufferGeometry {
    const segs = 16;
    const span = Math.PI * 0.72;
    const rMid = 0.5;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -span / 2 + span * t;
      const halfW = 0.025 + 0.12 * t;
      for (const r of [rMid - halfW, rMid + halfW]) {
        positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      }
      uvs.push(t, 0, t, 1);
      if (i < segs) {
        const b = i * 2;
        indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  private ensureSlashRibbons() {
    if (this.slashRibbons.length > 0) return;
    const tex = this.getSlashTexture();
    const makeMat = () => new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const arcGeo = this.buildSlashArcGeometry();
    for (let i = 0; i < 2; i++) {
      const mat = makeMat();
      const mesh = new THREE.Mesh(arcGeo, mat);
      // Centred on the crosshair band the blade now crosses, not below it.
      mesh.position.set(0, -0.02, -0.86);
      mesh.renderOrder = 998;
      mesh.visible = false;
      this.view.renderer.camera.add(mesh);
      this.slashRibbons.push({ mesh, mat, age: 0, life: 0, side: 1 });
    }
    // Dash streak: a long thin gradient quad receding into the screen.
    const streakMat = makeMat();
    const streak = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 1.3), streakMat);
    streak.position.set(0.16, -0.14, -0.9);
    streak.rotation.set(-Math.PI * 0.46, 0, 0); // lay it along the thrust axis
    streak.renderOrder = 998;
    streak.visible = false;
    this.view.renderer.camera.add(streak);
    this.slashStreak = { mesh: streak, mat: streakMat, age: 0, life: 0 };
  }

  /** First-person slash flash along the current cutlass diagonal. */
  private spawnViewSlashArc(side: 1 | -1) {
    this.ensureSlashRibbons();
    const r = this.slashRibbons[this.slashRibbonCursor];
    this.slashRibbonCursor = (this.slashRibbonCursor + 1) % this.slashRibbons.length;
    r.age = 0;
    // The ribbon is spawned on the swing's rising edge but the blade does not
    // cross the screen until p≈0.2–0.56 of a 0.55s swing (110–310ms) — a 0.16s
    // trail was already gone before the cut, which is why the slash read as
    // untrailed. 0.34s brightest at 0.17s = the whip frame.
    r.life = 0.34;
    r.side = side;
    r.mesh.visible = true;
  }

  private spawnViewSlashStreak() {
    this.ensureSlashRibbons();
    const s = this.slashStreak;
    if (!s) return;
    s.age = 0;
    s.life = 0.2;
    s.mesh.visible = true;
  }

  /** Small world-space slash arc at a REMOTE player's sword hand. */
  spawnRemoteSlashArc(worldPos: THREE.Vector3) {
    if (this.remoteSlashArcs.length === 0) {
      const tex = this.getSlashTexture();
      for (let i = 0; i < 6; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex, color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        sprite.visible = false;
        sprite.renderOrder = 996;
        this.view.renderer.scene.add(sprite);
        this.remoteSlashArcs.push({ sprite, age: 0, life: 0 });
      }
    }
    const arc = this.remoteSlashArcs[this.remoteSlashCursor];
    this.remoteSlashCursor = (this.remoteSlashCursor + 1) % this.remoteSlashArcs.length;
    arc.sprite.position.copy(worldPos);
    arc.sprite.material.rotation = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.4);
    arc.age = 0;
    arc.life = 0.18;
    arc.sprite.visible = true;
  }

  updateSlashRibbons(dt: number) {
    for (const r of this.slashRibbons) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const p = r.age / r.life;
      if (p >= 1) {
        r.mesh.visible = false;
        r.mat.opacity = 0;
        continue;
      }
      // The ribbon RIDES THE BLADE (poses.slashRibbonPose): its head points
      // where the steel points on screen and sweeps the same way on both
      // diagonals. The old scale (a Y reflection) plus a DECREASING rotation
      // drew the upside-down mirror of the cut (animations-04).
      const rp = slashRibbonPose(r.side, r.age / SLASH_SWING_TIME);
      r.mesh.scale.set(rp.scaleX, rp.scaleY, 1);
      r.mesh.rotation.z = rp.rotZ;
      r.mat.opacity = rp.opacity;
    }
    const s = this.slashStreak;
    if (s && s.mesh.visible) {
      s.age += dt;
      const p = s.age / s.life;
      if (p >= 1) {
        s.mesh.visible = false;
        s.mat.opacity = 0;
      } else {
        s.mesh.scale.set(1 + p * 0.4, 1 + p * 0.7, 1);
        s.mat.opacity = 0.7 * (1 - p);
      }
    }
    for (const arc of this.remoteSlashArcs) {
      if (!arc.sprite.visible) continue;
      arc.age += dt;
      const p = arc.age / arc.life;
      if (p >= 1) {
        arc.sprite.visible = false;
        arc.sprite.material.opacity = 0;
        continue;
      }
      const sc = 1.0 + p * 0.5;
      arc.sprite.scale.set(sc, sc * 0.55, 1);
      arc.sprite.material.opacity = 0.7 * (1 - p);
    }
  }

  /** The bucketful in the air on a throw: one instanced draw in camera space. */
  private syncBucketSpray(scoop: number, filled: boolean) {
    const parent = this.localViewPocketRoot.parent;
    if (!parent) return;
    let spray = this.bucketSpray;
    let any = false;
    for (let i = 0; i < BUCKET_DROPLETS && !any; i++) any = !!bucketThrowDroplet(i, BUCKET_DROPLETS, scoop, filled);
    if (!any) { if (spray) spray.visible = false; return; }
    if (!spray) {
      spray = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.MeshStandardMaterial({ color: 0x3f8a9c, roughness: 0.1, metalness: 0.05, transparent: true, opacity: 0.78 }),
        BUCKET_DROPLETS,
      );
      spray.name = 'bucket-spray';
      spray.frustumCulled = false;
      applyViewmodelMaterialSettings(spray);
      this.bucketSpray = spray;
    }
    if (spray.parent !== parent) parent.add(spray);
    const m = new THREE.Matrix4();
    for (let i = 0; i < BUCKET_DROPLETS; i++) {
      const d = bucketThrowDroplet(i, BUCKET_DROPLETS, scoop, filled);
      if (d) m.makeScale(d[3], d[3] * 0.8, d[3] * 1.4).setPosition(d[0], d[1], d[2]);
      else m.makeScale(0, 0, 0);
      spray.setMatrixAt(i, m);
    }
    spray.instanceMatrix.needsUpdate = true;
    spray.visible = true;
  }

  /** Free a held item's geometries and materials — a repair that starts and
   *  stops every few seconds would otherwise leak one hammer per cycle. */
  private disposeHeldItem(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // Tool GLB clones share the library's geometry (b2.3h): materials only.
      if (!root.userData.sharedGeometry) m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) for (const x of mat) x.dispose();
      else mat?.dispose();
    });
  }

  /**
   * THE THING IN HIS HAND WHEN IT IS NOT A WEAPON (avatar-08).
   *
   * `equippedTool` and `hullRepairProgress` are both replicated and neither was
   * ever drawn on the world body: a crewmate patching a hole or scanning with a
   * spyglass held a cutlass and stood idle. Returns true when it took the hand,
   * so `syncHeldWeapon` knows to stow the steel.
   *
   * Cost: ONE extra Group of 2-6 meshes per pirate who is actually holding
   * something, built on the transition and disposed on the way out, so a low-tier
   * frame with nobody working pays nothing.
   */
  private syncHeldItem(
    mesh: THREE.Group,
    player: Player,
    rightHand: THREE.Object3D,
    useLocalSwimViewmodel: boolean,
  ): boolean {
    const ud = mesh.userData as { heldItemKind?: string | null };
    const existing = rightHand.getObjectByName('held-item') as THREE.Group | null;
    const dead = player.state === 'eliminated' || player.state === 'respawning';
    const repairing = (player.hullRepairProgress ?? 0) > 0;
    const kind: string | null = dead || useLocalSwimViewmodel || player.state === 'swimming'
      || player.atCannon || player.atHelm || player.atCrowNest || player.mastClimb !== null
      ? null
      : repairing ? 'hammer' : player.equippedTool ?? null;
    if (!kind) {
      if (existing) {
        this.disposeHeldItem(existing);
        existing.removeFromParent();
        ud.heldItemKind = null;
      }
      return false;
    }
    let item = existing;
    if (!item || ud.heldItemKind !== kind || toolGlbArrived(item)) {
      if (existing) { this.disposeHeldItem(existing); existing.removeFromParent(); }
      // Third person takes LOD1 of the tool GLBs (b2.3h).
      item = kind === 'hammer'
        ? makeCarpentersHammerMesh(1)
        : makePocketPreviewMesh(kind as PocketPreviewKind, 1);
      item.name = 'held-item';
      rightHand.add(item);
      ud.heldItemKind = kind;
    }
    // Sit it in the fist, pointing the way the tool is used.
    if (kind === 'hammer') {
      item.position.set(0.01, -0.02, 0.05);
      item.rotation.set(-1.32, 0, 0.1);
    } else if (kind === 'spyglass') {
      item.position.set(0.0, -0.02, 0.08);
      item.rotation.set(-1.5, 0, 0);
    } else if (kind === 'shovel') {
      item.position.set(0.01, -0.05, 0.06);
      item.rotation.set(-1.1, 0, 0.12);
    } else {
      item.position.set(0.0, -0.04, 0.06);
      item.rotation.set(-0.3, 0, 0);
    }
    return true;
  }

  /**
   * Is a first-person rig currently drawing hands? Game hides the WORLD body's
   * arms when it is (avatar-10) — the local body is drawn now, and two right
   * arms in the same eye is worse than none.
   */
  get armsInUse(): boolean {
    return this.localViewWeaponRoot.visible
      || this.localViewPocketRoot.visible
      || this.localViewHandsRoot.visible;
  }

  syncHeldWeapon(mesh: THREE.Group, player: Player) {
    const rightHand = (mesh.userData.animation?.parts as Record<string, THREE.Object3D | undefined> | undefined)?.rightHand;
    if (!rightHand) return;

    const activeWeapon = player.atCannon || player.atHelm ? null : player.weapons[player.activeSlot];
    const currentId = activeWeapon?.weaponId ?? null;
    const existing = rightHand.getObjectByName('held-weapon') as THREE.Group | null;
    const useLocalSwimViewmodel = player.id === this.view.localPlayerId;
    if (this.syncHeldItem(mesh, player, rightHand, useLocalSwimViewmodel)) {
      // Both hands are on a job (hammer, spyglass, shovel): the weapon is stowed.
      existing?.removeFromParent();
      mesh.userData.heldWeaponId = null;
      return;
    }
    // Swimmers STOW their steel — a pirate doing the crawl with a blunderbuss
    // held dry in one hand was the single clearest tell that the swim pose was
    // a static prop. (Aiming while treading water keeps it, below.)
    const swimStowed = player.state === 'swimming'
      && !(player.id === this.view.localPlayerId && this.view.input.isAiming());

    if (!currentId || currentId === 'ship_cannon' || useLocalSwimViewmodel || swimStowed
      || player.state === 'eliminated' || player.state === 'respawning') {
      existing?.removeFromParent();
      return;
    }

    let weaponMesh = existing;
    if (!weaponMesh || mesh.userData.heldWeaponId !== currentId) {
      existing?.removeFromParent();
      weaponMesh = makeHeldWeaponMesh(currentId);
      weaponMesh.name = 'held-weapon';
      rightHand.add(weaponMesh);
      mesh.userData.heldWeaponId = currentId;
    }

    switch (currentId) {
      case 'cutlass':
        {
          if (player.blocking) {
            weaponMesh.position.set(0.0, 0.1, 0.2);
            weaponMesh.rotation.set(-0.82, -0.08, -0.18);
            break;
          }
          const charge = THREE.MathUtils.clamp(player.cutlassCharge ?? 0, 0, 1);
          if (charge > 0.01) {
            weaponMesh.position.set(
              0.02 - charge * 0.08,
              0.04 + charge * 0.09,
              0.12 - charge * 0.08,
            );
            weaponMesh.rotation.set(
              -0.1 - charge * 0.72,
              0.1 - charge * 0.18,
              -0.68 - charge * 0.5,
            );
            break;
          }
          const swingProgress = this.view.getCutlassSwingProgress(player);
          if (this.view.cutlassSwingKind.get(player.id) === 'lunge' && swingProgress > 0) {
            // Dash stab: blade rams straight out with the extended arm.
            const ext = Math.sin(Math.min(1, swingProgress / 0.55) * Math.PI);
            weaponMesh.position.set(0.02, 0.04 + ext * 0.06, 0.1 + ext * 0.3);
            weaponMesh.rotation.set(-0.06 - ext * 1.35, 0.1, -0.62 + ext * 0.5);
            break;
          }
          // Same beat as the first-person arc (cut 0.20 → follow-through 0.56)
          // so a swing you watch someone else make and a swing you make yourself
          // are the same swing.
          const slashArc = Math.sin(THREE.MathUtils.clamp((swingProgress - 0.2) / 0.36, 0, 1) * Math.PI);
          const recover = THREE.MathUtils.smoothstep(swingProgress, 0.56, 1);
          weaponMesh.position.set(
            0.04 + slashArc * 0.12,
            0.02 + swingProgress * 0.05,
            0.12 + slashArc * 0.16,
          );
          weaponMesh.rotation.set(
            -0.06 - slashArc * 0.7 + recover * 0.14,
            0.12 + slashArc * 0.28,
            -0.62 + slashArc * 0.92 - recover * 0.16,
          );
        }
        break;
      case 'eye_of_reach':
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.06, -0.04, 0.38);
          weaponMesh.rotation.set(-Math.PI * 0.42, Math.PI * 0.08, -Math.PI * 0.12);
        } else {
          weaponMesh.position.set(0.03, 0.06, 0.14);
          weaponMesh.rotation.set(-Math.PI * 0.28, Math.PI * 0.06, -Math.PI * 0.08);
        }
        break;
      case 'blunderbuss':
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.08, -0.05, 0.3);
          weaponMesh.rotation.set(-Math.PI * 0.36, Math.PI * 0.12, -Math.PI * 0.1);
        } else {
          weaponMesh.position.set(0.02, 0.04, 0.1);
          weaponMesh.rotation.set(-Math.PI * 0.22, Math.PI * 0.08, -Math.PI * 0.06);
        }
        break;
      default:
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.09, -0.08, 0.24);
          weaponMesh.rotation.set(-Math.PI * 0.34, Math.PI * 0.16, -Math.PI * 0.2);
        } else {
          weaponMesh.position.set(0.04, 0.02, 0.04);
          weaponMesh.rotation.set(-Math.PI * 0.08, Math.PI * 0.1, -Math.PI * 0.12);
        }
        break;
    }
  }

  /**
   * First-person pocket/tool viewmodel: poses the item, then hangs real hands
   * on it and eases it into frame on a swap.
   */
  private syncLocalViewPocket(): boolean {
    const prevKind = this.localViewPocketKind;
    const shown = this.syncLocalViewPocketPose();
    if (!shown) {
      if (this.pocketHands) {
        this.pocketHands.left.visible = false;
        this.pocketHands.right.visible = false;
      }
      this.localViewPocketDrawTimer = 0;
      return false;
    }
    if (this.localViewPocketKind !== prevKind) this.localViewPocketDrawTimer = 0;
    this.localViewPocketDrawTimer = Math.min(1, this.localViewPocketDrawTimer + this.view.frameDt / VIEW_DRAW_TIME);
    if (this.localViewPocketDrawTimer < 1) {
      const e = 1 - this.localViewPocketDrawTimer;
      this.localViewPocketRoot.position.y -= 0.3 * e * e;
      this.localViewPocketRoot.rotation.x += 0.6 * e * e;
    }
    this.placeHands(
      this.ensurePocketHands(),
      this.repairHandGrips
        ?? (this.localViewPocketKind ? this.pocketGrips(this.localViewPocketKind) : { left: null, right: null }),
    );
    return true;
  }

  /** Preview of held supplies, tools and powder kegs before use. */
  private syncLocalViewPocketPose(): boolean {
    const player = this.view.getLocalPlayer();
    if (!player || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    this.repairHandGrips = null;
    if (this.bucketSpray) this.bucketSpray.visible = false;
    if (player.atCannon || player.atHelm) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    // Carrying a treasure chest takes over both hands — nothing else can be held.
    if (player.carryingChestId) {
      const kind: PocketPreviewKind = 'chest';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        mesh?.removeFromParent();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      const time = this.view.ocean.getTime();
      const moveAxes = this.view.input.getMoveAxes();
      const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
      const trudge = Math.sin(time * (3.6 + moveAmount * 1.8)) * (0.012 + moveAmount * 0.02);
      const sway = Math.sin(time * (1.9 + moveAmount * 0.9)) * (0.008 + moveAmount * 0.012);
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(0 + sway * 0.4, -0.34 + trudge, -0.55);
      this.localViewPocketRoot.rotation.set(-0.18 + trudge * 0.5, 0 + sway * 0.18, 0);
      return true;
    }
    // Hull repair (b2.3h, animations-13): TWO hands. The left presses a plank
    // from the bundle flat against the breach (it does not move), the right
    // swings the claw hammer from the wrist: raise, drive with the head
    // leading, rebound. The blows are the server's: HOLE_REPAIR_TIME is 2/3/4
    // blows of 0.8 s by hole size, the blow count comes from how fast the
    // replicated hullRepairProgress climbs, and the face meets the plank at
    // HAMMER_IMPACT_PHASE of every blow (test-anim-no-inversion hammer case).
    const repairProgress = player.hullRepairProgress ?? 0;
    if (repairProgress > 0.001) {
      const kind: PocketPreviewKind = 'wood';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind || !mesh.userData.repair
        || toolGlbArrived(mesh.getObjectByName('repair-plank')) || toolGlbArrived(mesh.getObjectByName('carpenters-hammer'))) {
        mesh?.removeFromParent();
        mesh = new THREE.Group();
        mesh.name = 'local-pocket';
        mesh.userData.repair = true;
        const plank = makePocketPreviewMesh('wood', 0);
        plank.name = 'repair-plank';
        // Bundle frame: width x, thickness y, length z. Stand it on the hull:
        // length runs across the screen (x), the broad face looks back at the
        // eye (+z), its top face at REPAIR_PLANK_FACE_Z.
        plank.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
        mesh.add(plank);
        const pivot = new THREE.Group();
        pivot.name = 'repair-hammer-pivot';
        pivot.position.set(REPAIR_HAMMER_PIVOT[0], REPAIR_HAMMER_PIVOT[1], REPAIR_HAMMER_PIVOT[2]);
        pivot.add(makeCarpentersHammerMesh(0));
        mesh.add(pivot);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
        this.repairProgPrev = repairProgress;
        this.repairProgAt = this.view.ocean.getTime();
      }
      const t = this.view.ocean.getTime();
      if (repairProgress > this.repairProgPrev + 1e-4) {
        const dt = t - this.repairProgAt;
        if (dt > 0.02 && dt < 0.5) {
          const est = dt / (repairProgress - this.repairProgPrev);
          if (Number.isFinite(est)) this.repairTimeEst += (THREE.MathUtils.clamp(est, 0.8, 4.8) - this.repairTimeEst) * 0.35;
        }
        this.repairProgPrev = repairProgress;
        this.repairProgAt = t;
      } else if (repairProgress < this.repairProgPrev - 1e-4) {
        this.repairProgPrev = repairProgress;
        this.repairProgAt = t;
      }
      // Snapshots arrive in steps; extrapolate up to one blow so the swing is smooth.
      const lead = Math.min(REPAIR_BLOW_S, t - this.repairProgAt) / this.repairTimeEst;
      const blows = repairBlowsFor(this.repairTimeEst);
      const phase = repairBlowPhase(Math.min(1, repairProgress + lead), blows);
      // FloodAudio plays the mallet on the impacts of THIS swing (b2-ask-03).
      this.repairBlowX = repairBlowPosition(Math.min(1, repairProgress + lead), blows);
      this.repairBlowXAt = t;
      const swing = hammerSwingAngle(phase);
      const pivot = mesh.getObjectByName('repair-hammer-pivot');
      if (pivot) pivot.rotation.set(swing, 0, 0);
      // The plank takes the blow: a 6 mm shove right after impact, nothing else moves.
      const jolt = phase > HAMMER_IMPACT_PHASE ? Math.exp(-(phase - HAMMER_IMPACT_PHASE) * 40) * 0.006 : 0;
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(0.04, -0.27, -0.56 - jolt);
      this.localViewPocketRoot.rotation.set(-0.06, 0.12, 0.02);
      const c = Math.cos(swing), sn = Math.sin(swing);
      const gy = -0.03; // fist 3 cm down the haft from the grip origin
      this.repairHandGrips = {
        left: { pos: [-0.1, -0.02, 0.05], rot: [0.5 - Math.PI / 2, -0.2, -0.12], scale: 1.15 },
        right: {
          pos: [REPAIR_HAMMER_PIVOT[0], REPAIR_HAMMER_PIVOT[1] + gy * c, REPAIR_HAMMER_PIVOT[2] + gy * sn],
          rot: [swing + 0.5 - Math.PI / 2, 0.16, 0.1],
          scale: 1.15,
        },
      };
      return true;
    }
    // Only show the in-hand keg + place animation when the server would ACTUALLY
    // spawn one: a mega keg, or a normal keg off cooldown. Otherwise the preview
    // "places" a keg client-side that never appears (60s replenish cooldown) — the
    // "kegs aren't being put down properly" feeling. getKegSummary shows the timer.
    const kegPlaceable = player.megaKegs > 0 || (player.kegs > 0 && (player.kegCooldown ?? 0) <= 0);
    if (this.view.input.isKegPreviewActive() && kegPlaceable) {
      const kind: PocketPreviewKind = 'powder_keg';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        mesh?.removeFromParent();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.55);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }

      const time = this.view.ocean.getTime();
      const moveAxes = this.view.input.getMoveAxes();
      const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
      const bob = Math.sin(time * (4.7 + moveAmount * 2.1)) * (0.005 + moveAmount * 0.013);
      const sway = Math.sin(time * (2.5 + moveAmount * 1.3)) * (0.006 + moveAmount * 0.012);

      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(-0.1 + sway * 0.38, -0.46 + bob, -0.84);
      this.localViewPocketRoot.rotation.set(-0.13 + bob * 0.9, 0.18 + sway * 0.35, 0.04);
      return true;
    }
    const digChest = player.nearChestId ? this.view.findChestById(player.nearChestId) : null;
    const chestDig =
      !!digChest
      && player.hasShovel
      && this.view.input.isInteractHeld()
      && !player.carryingChestId
      && digChest.buried
      && digChest.digProgress < 1;
    // The shovel also digs over EMPTY ground (SoT feel) — same swing animation,
    // it just never uncovers anything unless an X marks the spot.
    const freeDig = !chestDig
      && player.hasShovel
      && player.equippedTool === 'shovel'
      && this.view.input.isFiring()
      && player.state === 'alive'
      && !player.carryingChestId;
    const digging = chestDig || freeDig;
    if (digging) {
      const kind: PocketPreviewKind = 'shovel';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        mesh?.removeFromParent();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(2.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      // THREE sequential beats — the old cycle ran lift and strike at the same
      // time (the blade floated down instead of driving in) and ended before
      // any dirt left the hole: RAISE → DRIVE → LEVER + toss over the shoulder.
      const time = this.view.ocean.getTime();
      const cycle = (time * 1.9) % 1;
      const raise = THREE.MathUtils.smoothstep(cycle, 0, 0.35);
      const drive = THREE.MathUtils.clamp((cycle - 0.35) / 0.15, 0, 1) ** 2;
      const toss = THREE.MathUtils.smoothstep(cycle, 0.5, 0.85);
      // FRAMING: measured phase-by-phase (probe pinning the cycle), the dig kept
      // the OLD close-in anchor the rest pose was moved off of — z −0.55 puts the
      // rear fist ~0.4m from the eye, and the beats threw it clean off the bottom
      // of the frame twice per cycle: ndc.y −0.85 at the base of the RAISE and
      // −1.08 at the DRIVE peak (a whole frame-height under the HUD). Re-anchored
      // on the audited shovel rest anchor (out to z −0.76 and right of centre, the
      // same move that fixed rest) with the three beats and their relative
      // weights untouched, so RAISE → DRIVE → LEVER+toss still reads.
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(
        0.14 + toss * 0.16,
        -0.28 + raise * 0.2 - drive * 0.12 + toss * 0.14,
        -0.76 + raise * 0.05 - drive * 0.1 + toss * 0.08,
      );
      this.localViewPocketRoot.rotation.set(
        -0.5 - raise * 0.42 + drive * 1.25 - toss * 0.6,
        0.2 + raise * 0.18 - toss * 0.3,
        -0.06 + drive * 0.05 + toss * 0.6,
      );
      return true;
    }
    if (this.view.pocketUsePreviewTimer > 0) {
      this.view.pocketUsePreviewTimer = Math.max(0, this.view.pocketUsePreviewTimer - this.view.frameDt);
    } else {
      this.view.pocketUsePreviewKind = null;
    }

    const usingPreview = this.view.pocketUsePreviewKind !== null && this.view.pocketUsePreviewTimer > 0;
    if (!this.view.input.isSupplyWheelOpen() && !usingPreview) {
      // Persistently hold the equipped TOOL in first-person so you can SEE what's
      // in your hands. The spyglass is the exception — raised, the full-screen
      // scope overlay is the visual, so no barrel viewmodel is drawn.
      const tool = player.equippedTool;
      if (tool && !(tool === 'spyglass' && this.view.spyglassActive)) {
        const kind = tool as PocketPreviewKind;
        let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
        if (!mesh || this.localViewPocketKind !== kind || mesh.userData.repair || toolGlbArrived(mesh)) {
          mesh?.removeFromParent();
          mesh = makePocketPreviewMesh(kind);
          mesh.name = 'local-pocket';
          mesh.rotation.y = Math.PI;
          mesh.scale.setScalar(tool === 'compass' ? 1.7 : tool === 'bucket' ? 1.4 : tool === 'shovel' ? 1.7 : tool === 'lantern' ? 1.5 : tool === 'axe' ? 1.8 : 1.5);
          applyViewmodelMaterialSettings(mesh);
          this.localViewPocketRoot.add(mesh);
          this.localViewPocketKind = kind;
        }
        // The bucket shows water once it has gone under on the scoop, and the
        // water leaves it on the throw: the disc goes at the pour and the
        // bucketful flies out of the mouth in an arc (b2.3h).
        if (tool === 'bucket') {
          const scoop = player.bailScoopProgress ?? 0;
          const water = mesh.getObjectByName('bucket-water');
          if (water) water.visible = bucketWaterShown(scoop, !!player.bucketFilled);
          this.syncBucketSpray(scoop, !!player.bucketFilled);
        }
        const time = this.view.ocean.getTime();
        const moveAxes = this.view.input.getMoveAxes();
        const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
        const bob = Math.sin(time * (3.1 + moveAmount * 2.4)) * (0.006 + moveAmount * 0.02);
        const sway = Math.sin(time * (1.8 + moveAmount * 1.1)) * (0.006 + moveAmount * 0.014);
        const cfg = toolPose(tool, {
          bob, sway, time, firing: this.view.input.isFiring(),
          bailScoopProgress: player.bailScoopProgress ?? 0, bucketFilled: !!player.bucketFilled,
        });
        this.localViewPocketRoot.visible = true;
        this.localViewPocketRoot.position.set(cfg[0], cfg[1], cfg[2]);
        this.localViewPocketRoot.rotation.set(cfg[3], cfg[4], cfg[5]);
        return true;
      }
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const slot = this.view.input.getSupplyWheelHeldSlot();
    if (slot === null && !usingPreview) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const kind = usingPreview ? this.view.pocketUsePreviewKind! : this.view.getPocketWheelKind(player, slot!);
    if (!kind || (!usingPreview && this.view.getPocketWheelCount(player, slot!) <= 0)) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
    if (!mesh || this.localViewPocketKind !== kind) {
      mesh?.removeFromParent();
      mesh = makePocketPreviewMesh(kind);
      mesh.name = 'local-pocket';
      mesh.rotation.y = Math.PI;
      mesh.scale.setScalar(1.35);
      applyViewmodelMaterialSettings(mesh);
      this.localViewPocketRoot.add(mesh);
      this.localViewPocketKind = kind;
    }

    const time = this.view.ocean.getTime();
    const moveAxes = this.view.input.getMoveAxes();
    const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
    const bob = Math.sin(time * (5.2 + moveAmount * 2.2)) * (0.006 + moveAmount * 0.014);
    const sway = Math.sin(time * (2.8 + moveAmount * 1.4)) * (0.005 + moveAmount * 0.01);
    const previewDuration = kind === 'wood' ? 0.45 : 0.82;
    const eatProgress = usingPreview
      ? 1 - THREE.MathUtils.clamp(this.view.pocketUsePreviewTimer / previewDuration, 0, 1)
      : 0;
    const biteArc = Math.sin(eatProgress * Math.PI);
    const toMouth = kind === 'wood' ? 0 : THREE.MathUtils.smoothstep(eatProgress, 0.1, 0.72);

    // Lift the lantern up into view when raised (ATTACK held), matching the light flare.
    const lanternLift = kind === 'lantern' ? this.view.lanternRaise01 : 0;
    this.localViewPocketRoot.visible = true;
    this.localViewPocketRoot.position.set(
      -0.34 + sway * 0.5 + toMouth * 0.22 - lanternLift * 0.14,
      -0.38 + bob + toMouth * 0.3 + biteArc * 0.035 + lanternLift * 0.44,
      -0.52 + toMouth * 0.22 + lanternLift * 0.17,
    );
    this.localViewPocketRoot.rotation.set(
      -0.12 + bob * 1.2 - toMouth * 0.46 - lanternLift * 0.38,
      0.22 + sway * 0.4 + toMouth * 0.22,
      0.08 + biteArc * 0.12,
    );
    return true;
  }

  /**
   * Flintlock reload choreography: INSPECT (drop the muzzle, roll the lock
   * plate up to the eye) → RAM (hold, with discrete ramrod pulses down the
   * barrel) → RETURN (snap back with a little overshoot). Amplitudes are an
   * order of magnitude past the old `reloadArc` tilt, which was invisible.
   *
   * @param p 0→1 reload progress.
   * @returns additive root offset [x,y,z,rx,ry,rz] plus `ram`, the 0..1 ramrod
   *          plunge used to drive the support hand down the muzzle.
   */
  // ── Incoming damage watch ─────────────────────────────────────────────────
  /** Last seen local health/armour, for the "something just hit me" edge. */
  private prevWatchedHealth: number | null = null;
  private prevWatchedArmor = 0;

  /**
   * Fire the incoming-damage read on ANY loss of health or armour.
   *
   * CombatFx.flashIncomingDamage (directional edge vignette + hit cue) already
   * existed and was documented as being driven from here — but nothing in the
   * whole client ever called it, which is why the auditor lost 50 HP with no
   * cause, no direction and no vignette. Watching the local player every frame
   * (rather than hanging off the `hit` message) is deliberate: storm, drowning,
   * fall, fire, shark, keg, cannon and bullet all move these two numbers, and
   * only some of them ship a hit payload. Armour is included so a hit that
   * armour ate is still unmistakably a hit.
   */
  private watchIncomingDamage(player: Player | null) {
    if (!player || player.state === 'eliminated' || player.state === 'respawning') {
      // A respawn refills both bars; don't read that as a 100-point wound.
      this.prevWatchedHealth = null;
      return;
    }
    const health = player.health ?? 0;
    const armor = player.armor ?? 0;
    if (this.prevWatchedHealth === null) {
      this.prevWatchedHealth = health;
      this.prevWatchedArmor = armor;
      return;
    }
    const lost = Math.max(0, this.prevWatchedHealth - health) + Math.max(0, this.prevWatchedArmor - armor);
    this.prevWatchedHealth = health;
    this.prevWatchedArmor = armor;
    if (lost < 0.5) return;
    const camera = this.view.renderer.camera;
    // A chip of storm damage still registers; a blunderbuss to the chest fills
    // the frame. 45 is roughly "half your health in one bite".
    this.view.combatFx.flashIncomingDamage(
      THREE.MathUtils.clamp(lost / 45, 0.18, 1),
      camera.position,
      camera.quaternion,
    );
  }

  syncLocalViewWeapon() {
    const localPlayer = this.view.getLocalPlayer();
    // Runs before every early return below — being shot must register whether
    // you are swimming, at the helm, holding a chest or scoped in.
    this.watchIncomingDamage(localPlayer);
    const firearmSlot = localPlayer?.atCannon || localPlayer?.atHelm
      ? null
      : localPlayer?.weapons[localPlayer.activeSlot] ?? null;
    const swimAiming = !!firearmSlot && !WEAPONS[firearmSlot.weaponId].melee
      && (this.view.input.isAiming() || this.view.input.isFiring());
    // SWIMMING: both hands are in the water. Stow the weapon and tools and play
    // a real front-crawl stroke instead of showing nothing at all — unless the
    // pirate is actually aiming a firearm, which keeps the gun up.
    if (localPlayer?.state === 'swimming' && !swimAiming) {
      this.localViewWeaponRoot.visible = false;
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      this.localCutlassCharge = 0;
      this.localViewDrawTimer = 0;
      this.localViewPocketDrawTimer = 0;
      const axes = this.view.input.getMoveAxes();
      this.updateSwimHands(Math.min(1, Math.hypot(axes.x, axes.z)), this.view.frameDt);
      return;
    }
    this.hideSwimHands();

    if (this.syncLocalViewPocket()
      // Opening the supply wheel or the map holsters the gun — you're not aiming.
      || this.view.input.isSupplyWheelOpen()
      || this.view.map.mapOpen) {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      this.localCutlassCharge = 0;
      this.localViewDrawTimer = 0;
      return;
    }

    const player = this.view.getLocalPlayer();
    const activeWeapon = player?.atCannon || player?.atHelm ? null : player?.weapons[player.activeSlot] ?? null;
    if (!player || !activeWeapon || activeWeapon.weaponId === 'ship_cannon' || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      this.localCutlassCharge = 0;
      return;
    }
    const weaponId = activeWeapon.weaponId;

    let weaponMesh = this.localViewWeaponRoot.getObjectByName('local-view-weapon') as THREE.Group | null;
    if (!weaponMesh || this.localViewWeaponId !== weaponId) {
      // Swap the WEAPON only. The old `clear()` also tore out the muzzle flash
      // rig and the hands (both parented here), so after a single weapon switch
      // no gun ever flashed again for the rest of the match.
      weaponMesh?.removeFromParent();
      weaponMesh = makeHeldWeaponMesh(weaponId);
      weaponMesh.name = 'local-view-weapon';
      weaponMesh.rotation.y = Math.PI;
      weaponMesh.scale.setScalar(
        weaponId === 'eye_of_reach'
          ? 0.92
          : weaponId === 'blunderbuss'
            ? 0.95
            : weaponId === 'cutlass'
              ? 0.92
              : 1.2,
      );
      applyViewmodelMaterialSettings(weaponMesh);
      this.localViewWeaponRoot.add(weaponMesh);
      this.localViewWeaponId = weaponId;
      // Fresh steel comes UP into frame instead of teleporting into the pose.
      this.localViewDrawTimer = 0;
      this.setupMuzzleFlash();
    }
    this.localViewDrawTimer = Math.min(1, this.localViewDrawTimer + this.view.frameDt / VIEW_DRAW_TIME);

    const firearmEquipped = !WEAPONS[weaponId].melee;
    const cutlassEquipped = weaponId === 'cutlass';
    const cutlassBlocking = cutlassEquipped && this.view.input.isAiming() && !this.view.input.isFiring() && !activeWeapon.reloading;
    const cutlassCharging = cutlassEquipped && this.view.input.isFiring() && !cutlassBlocking && !activeWeapon.reloading;
    if (cutlassCharging) {
      this.localCutlassCharge = Math.min(1, this.localCutlassCharge + this.view.frameDt / CUTLASS_VIEW_CHARGE_TIME);
    } else {
      this.localCutlassCharge += (0 - this.localCutlassCharge) * Math.min(1, this.view.frameDt * (activeWeapon.reloading ? 14 : 8));
    }
    const aimBlend = firearmEquipped && this.view.input.isAiming() ? 1 : 0;
    const time = this.view.ocean.getTime();
    const moveAxes = this.view.input.getMoveAxes();
    const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
    const bob = Math.sin(time * (6.4 + moveAmount * 2.8)) * (0.004 + moveAmount * 0.012);
    const sway = Math.sin(time * (3.2 + moveAmount * 1.6)) * (0.004 + moveAmount * 0.01);
    const strafeTilt = moveAxes.x * (0.008 + moveAmount * 0.018);
    const travelSwing = Math.cos(time * (5.2 + moveAmount * 2.5)) * moveAmount * 0.016;
    const ammoSignature = `${weaponId}:${activeWeapon.ammo}:${activeWeapon.reloading ? 1 : 0}`;
    this.localViewWeaponAmmoSignature = ammoSignature;
    // Muzzle flash + smoke + recoil the instant you pull the trigger
    // (client-predicted press edge), so feedback is immediate rather than
    // waiting on the server ammo round-trip. Gated on a loaded, ready weapon.
    const firingNow = firearmEquipped && this.view.input.isFiring();
    const canFire = activeWeapon.ammo > 0 && !activeWeapon.reloading;
    if (firingNow && canFire && !this.prevLocalFiring) {
      this.triggerMuzzleFlash(weaponId);
      // Crack the shot locally the instant the trigger drops (sniper included),
      // instead of waiting for the server tracer to replicate ~1 RTT later.
      this.view.combatFx.playLocalShot(weaponId, this.view.renderer.camera.position);
      // Recoil is an IMPULSE (poses.recoilEnvelope): back toward the eye and
      // muzzle-UP, peak in 65-85 ms, settled by 200-255 ms. It used to push the
      // gun forward, down and muzzle-down, and holding the trigger parked it
      // there at 0.72 (animations-03).
      this.recoilFrom = this.localViewWeaponKick;
      this.recoilAge = 0;
    } else if (Number.isFinite(this.recoilAge)) {
      this.recoilAge += this.view.frameDt;
      if (this.recoilAge > 1) this.recoilAge = Infinity;
    }
    this.prevLocalFiring = firingNow;
    const recoil = firearmEquipped ? this.localViewWeaponKick : 0;
    const reloadBlend = activeWeapon.reloading && firearmEquipped
      ? 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / Math.max(0.001, WEAPONS[weaponId].reloadTime), 0, 1)
      : 0;
    if (activeWeapon.reloading && firearmEquipped) {
      this.localViewWeaponReloadPhase = reloadBlend;
    } else {
      this.localViewWeaponReloadPhase += (0 - this.localViewWeaponReloadPhase) * Math.min(1, this.view.frameDt * 10);
    }
    // Real reload choreography (INSPECT → RAM → RETURN) instead of the old
    // near-invisible sine tilt; `ram` also drives the support hand.
    const reload = reloadChoreography(weaponId, this.localViewWeaponReloadPhase);
    if (reload.pulseIndex >= 0 && reload.pulseIndex !== this.prevReloadPulse) {
      // A small camera nudge per ramrod stroke — the shove has weight.
      this.view.cameraShake = Math.min(1, this.view.cameraShake + 0.05);
    }
    this.prevReloadPulse = reload.pulseIndex;
    // A raised spyglass (hold P) occupies both hands — stow the weapon.
    this.localViewWeaponRoot.visible = !this.view.spyglassActive;

    const root = this.localViewWeaponRoot;
    const setPose = (p: Pose6) => {
      root.position.set(p[0], p[1], p[2]);
      root.rotation.set(p[3], p[4], p[5]);
    };
    if (weaponId === 'cutlass') {
      // Shared progress helper: denominator locked per swing (basic 0.55 s vs
      // lunge 1.05 s) so the animation always plays forward from windup. The
      // keys live in viewmodel/poses.ts (blade authored UP along +Y).
      const cooldownProgress = this.view.getCutlassSwingProgress(player);
      const swingKind = this.view.cutlassSwingKind.get(player.id) ?? 'swing';
      const charge = this.localCutlassCharge;
      const chargeReadyPulse = charge > 0.96 ? Math.sin(time * 22) * 0.018 : 0;
      if (cooldownProgress > 0.001 && this.view.prevCutlassSwingProgress <= 0.001) {
        if (swingKind === 'lunge') {
          this.view.cutlassDashKick = 1;
          this.view.cameraShake = Math.min(1, this.view.cameraShake + 0.2);
          this.spawnViewSlashStreak();
        } else {
          this.cutlassSlashSide = this.cutlassSlashSide === 1 ? -1 : 1;
          this.spawnViewSlashArc(this.cutlassSlashSide);
        }
      }
      this.view.prevCutlassSwingProgress = cooldownProgress;
      if (cutlassBlocking) {
        const g = CUTLASS_GUARD;
        setPose([g[0] + sway * 0.14, g[1] + bob * 0.45, g[2] + travelSwing * 0.08, g[3], g[4], g[5] - strafeTilt * 0.4]);
      } else if (cooldownProgress > 0.001 && swingKind === 'lunge') {
        const pose = cutlassLungePose(cooldownProgress);
        pose[1] += bob * 0.3;
        pose[5] -= strafeTilt * 0.6;
        setPose(pose);
      } else if (cooldownProgress > 0.001) {
        const pose = cutlassSlashPose(this.cutlassSlashSide, cooldownProgress);
        pose[1] += bob * 0.3;
        pose[5] -= strafeTilt * 0.8;
        setPose(pose);
      } else {
        const pose = cutlassRestPose(charge);
        pose[0] += sway * 0.24 + travelSwing * 0.42;
        pose[1] += chargeReadyPulse + bob * 0.75;
        pose[5] -= strafeTilt * 1.4;
        setPose(pose);
      }
    } else {
      setPose(weaponPose(weaponId, { aimBlend, bob, sway, strafeTilt, travelSwing, reload: reload.pose, recoil }));
    }

    // ── DRAW: the fresh weapon rises into the pose MUZZLE-LOW and rotates up
    // into line (poses.drawDelta); it used to start 43 deg muzzle-high.
    if (this.localViewDrawTimer < 1) {
      const d = drawDelta(this.localViewDrawTimer);
      root.position.x += d[0];
      root.position.y += d[1];
      root.position.z += d[2];
      root.rotation.x += d[3];
      root.rotation.y += d[4];
      root.rotation.z += d[5];
    }
    // ── HANDS: real forearms and fists on the grips. They ride inside the
    // weapon root, so every pose above (bob, recoil, reload, swing) carries
    // them for free — this is what kills the "floating prop" read.
    const hands = this.ensureWeaponHands();
    const scopedAway = weaponId === 'eye_of_reach' && this.view.input.isAiming() && !activeWeapon.reloading;
    if (this.view.spyglassActive || scopedAway) {
      hands.left.visible = false;
      hands.right.visible = false;
    } else {
      const grips = this.weaponGrips(weaponId);
      if (grips.left && reload.ram > 0.001) {
        // The support hand rams the charge home down the muzzle.
        grips.left = {
          pos: [grips.left.pos[0], grips.left.pos[1] + reload.ram * 0.06, grips.left.pos[2] - reload.ram * 0.22],
          rot: grips.left.rot,
        };
      }
      this.placeHands(hands, grips);
    }

    // Eye of Reach: keep the 3D scope tube (classic look). Hide stock/barrel/grip while ADS; counter-scale so narrow scope FOV does not balloon the viewmodel.
    if (weaponId === 'eye_of_reach' && weaponMesh) {
      const adsScope = this.view.input.isAiming() && !activeWeapon.reloading;
      const HIP_FOV = 74;
      const adsFov = WEAPONS.eye_of_reach.scopeFov ?? 14;
      let usedScopedFlags = false;
      weaponMesh.traverse((part) => {
        if (part.userData.eorHideInScope === true) {
          part.visible = !adsScope;
          usedScopedFlags = true;
        } else if (part.userData.eorKeepInScope === true) {
          part.visible = true;
          usedScopedFlags = true;
        }
      });
      if (!usedScopedFlags) {
        for (const partId of ['vm-eor-grip', 'vm-eor-stock', 'vm-eor-barrel', 'vm-eor-butt'] as const) {
          const part = weaponMesh.getObjectByName(partId);
          if (part) part.visible = !adsScope;
        }
        const scopePart = weaponMesh.getObjectByName('vm-eor-scope');
        if (scopePart) scopePart.visible = true;
      }
      if (adsScope) {
        // Counter-scale against the LIVE camera fov (not the target constant)
        // so the viewmodel keeps its apparent size through the zoom lerp and
        // under any non-74 base fov (swimming 78, aiming 64, settings).
        const hipHalf = THREE.MathUtils.degToRad(HIP_FOV * 0.5);
        const liveHalf = THREE.MathUtils.degToRad(Math.max(adsFov * 0.85, this.view.renderer.camera.fov) * 0.5);
        this.localViewWeaponRoot.scale.setScalar(Math.tan(liveHalf) / Math.tan(hipHalf));
      } else {
        // Hip viewmodels at 82%: guns should frame the fight, not block it.
        this.localViewWeaponRoot.scale.setScalar(0.82);
      }
    } else {
      this.localViewWeaponRoot.scale.setScalar(1);
    }
  }
}
