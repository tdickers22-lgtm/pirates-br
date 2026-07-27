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
import { makeViewHand } from './factories/PlayerMeshFactory.js';
import { registerBudgetLight } from './LightBudget.js';
import { CUTLASS_VIEW_CHARGE_TIME } from './PlayerAnimator.js';
import type { CombatFx } from './CombatFx.js';
import type { OceanRenderer } from './OceanRenderer.js';
import type { Renderer } from './Renderer.js';

/** Seconds for a freshly drawn weapon/tool to rise into its rest pose. */
const VIEW_DRAW_TIME = 0.3;

/**
 * Minimum angle (radians ≈ 20.6°) a long tool's shaft is allowed to sit off the
 * view axis. Dead-on, a 1 m haft projects to a few pixels behind the fists and
 * the tool disappears out of its own animation — the lesson the cutlass thrust
 * and the rifle ADS both had to learn the expensive way.
 */
const MIN_OFF_AXIS = 0.36;

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
  localViewWeaponKick = 0;
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
    switch (weaponId) {
      case 'eye_of_reach': return [0, 0.069, -1.24];
      case 'blunderbuss': return [0, 0.052, -0.94];
      case 'flintknock': return [0, 0.054, -0.53];
      default: return [0, 0.024, -0.79];
    }
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

  private makeHand(side: 1 | -1, parent: THREE.Group): THREE.Group {
    const hand = makeViewHand(side);
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
      const grow = 0.92 + p * 0.62;
      // The ribbon SWEEPS with the blade instead of flashing in place: it rides
      // the same anticipation→follow-through rotation, so the eye is given the
      // arc the sword took even on a frame where the blade itself is a thin
      // edge-on line. The sweep is 2.6rad to match the blade's new 2.7rad roll
      // (cock −0.85 → follow-through +1.85); the old 1.75 under-swept it and the
      // ribbon and the steel visibly disagreed about where the cut went.
      r.mesh.scale.set(r.side * grow, -grow, 1);
      r.mesh.rotation.z = (0.95 - 2.6 * p) * r.side;
      // Peak mid-swing rather than at the wind-up (a linear fade from full made
      // the brightest frame the one where nothing had moved yet).
      r.mat.opacity = 0.98 * Math.sin(Math.min(1, p) * Math.PI) ** 0.6;
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

  syncHeldWeapon(mesh: THREE.Group, player: Player) {
    const rightHand = (mesh.userData.animation?.parts as Record<string, THREE.Object3D | undefined> | undefined)?.rightHand;
    if (!rightHand) return;

    const activeWeapon = player.atCannon || player.atHelm ? null : player.weapons[player.activeSlot];
    const currentId = activeWeapon?.weaponId ?? null;
    const existing = rightHand.getObjectByName('held-weapon') as THREE.Group | null;
    const useLocalSwimViewmodel = player.id === this.view.localPlayerId;
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
      this.localViewPocketKind ? this.pocketGrips(this.localViewPocketKind) : { left: null, right: null },
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
    // Hull repair: hammer a fresh PLANK over the breach while holding [X]. The
    // down-strikes are driven by the server's hullRepairProgress (one plank/swing),
    // so the wood-and-hammer motion the user asked for reads in first person.
    if ((player.hullRepairProgress ?? 0) > 0.001) {
      const kind: PocketPreviewKind = 'wood';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        mesh?.removeFromParent();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.3);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      // DISCRETE BLOWS, not a 16Hz buzz: a 0.45s raise → strike → bounce cycle
      // so the plank is hammered on rather than vibrated against the hull.
      const t = this.view.ocean.getTime();
      const cycle = (t / 0.45) % 1;
      const raise = THREE.MathUtils.smoothstep(cycle, 0, 0.62) ** 0.6;   // easeOut lift
      const strike = THREE.MathUtils.clamp((cycle - 0.62) / 0.18, 0, 1) ** 2; // easeIn drive
      const bounce = Math.sin(THREE.MathUtils.clamp((cycle - 0.8) / 0.2, 0, 1) * Math.PI) * 0.25;
      const blow = strike - bounce;
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(
        0.16,
        -0.34 + raise * 0.12 - blow * 0.16,
        -0.5 + raise * 0.02 - blow * 0.08,
      );
      this.localViewPocketRoot.rotation.set(-0.5 - raise * 0.9 + blow * 1.35, 0.28, 0.12);
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
        if (!mesh || this.localViewPocketKind !== kind) {
          mesh?.removeFromParent();
          mesh = makePocketPreviewMesh(kind);
          mesh.name = 'local-pocket';
          mesh.rotation.y = Math.PI;
          mesh.scale.setScalar(tool === 'compass' ? 1.7 : tool === 'bucket' ? 1.4 : tool === 'shovel' ? 1.7 : tool === 'lantern' ? 1.5 : tool === 'axe' ? 1.8 : 1.5);
          applyViewmodelMaterialSettings(mesh);
          this.localViewPocketRoot.add(mesh);
          this.localViewPocketKind = kind;
        }
        // The bucket only shows water once you've scooped a bucketful.
        if (tool === 'bucket') {
          const water = mesh.getObjectByName('bucket-water');
          if (water) water.visible = !!player.bucketFilled;
        }
        const time = this.view.ocean.getTime();
        const moveAxes = this.view.input.getMoveAxes();
        const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
        const bob = Math.sin(time * (3.1 + moveAmount * 2.4)) * (0.006 + moveAmount * 0.02);
        const sway = Math.sin(time * (1.8 + moveAmount * 1.1)) * (0.006 + moveAmount * 0.014);
        const cfg = tool === 'compass'
          // At z −0.38 the compass face was 38cm from the eye: it swallowed the
          // lower-right quarter of the frame and threw its own holding fist to
          // ndc [0.50, −0.70], in the corner behind the HUD tiles. Held at arm's
          // length instead the fist reads at [0.28, −0.43] and the card is still
          // easily large enough to take a bearing off.
          ? { p: [0.16 + sway * 0.5, -0.13 + bob, -0.56], r: [-0.88 + bob, 0.16 + sway * 0.3, 0.08] }
          : tool === 'bucket'
            ? (() => {
              // The SCOOP→HEAVE cycle must READ: bailScoopProgress runs 1→0
              // over 0.6s after each press. Just-scooped (filled) dips the
              // bucket low then lifts the load; just-heaved (emptied) hoists
              // and FLINGS it forward — the eject the cycle was missing.
              const prog = THREE.MathUtils.clamp(player.bailScoopProgress ?? 0, 0, 1);
              const anim = 1 - prog; // 0 → 1 across the action
              if (prog > 0.01 && player.bucketFilled) {
                const dip = Math.sin(Math.min(1, anim / 0.7) * Math.PI);
                return {
                  p: [0.24 + sway * 0.3, -0.35 - dip * 0.24 + bob, -0.56 - dip * 0.14],
                  r: [-0.12 - dip * 0.55 + bob, 0.2, -0.1 + dip * 0.08],
                };
              }
              if (prog > 0.01 && !player.bucketFilled) {
                const fling = Math.sin(Math.min(1, anim / 0.5) * Math.PI);
                return {
                  p: [0.24, -0.35 + fling * 0.3 + bob, -0.56 - fling * 0.36],
                  r: [-0.12 - fling * 1.25 + bob, 0.2, -0.1 + fling * 0.16],
                };
              }
              return { p: [0.24 + sway * 0.5, -0.35 + bob, -0.56], r: [-0.12 + bob, 0.2 + sway * 0.3, -0.1] };
            })()
            : tool === 'spyglass'
              ? { p: [0.2 + sway * 0.4, -0.2 + bob, -0.46], r: [0.05, -0.5 + sway * 0.2, 0.12] }
              : tool === 'lantern'
                ? { p: [0.26 + sway * 0.5, -0.16 + bob, -0.5], r: [0.02 + bob, 0.2, -0.05] } // held up like a lamp
              : tool === 'axe'
                ? (() => {
                  // AXIS NOTE (corrected from a user screenshot of the flipped
                  // grip): with the haft along Z, POSITIVE rot.x raises the
                  // HEAD (the far −Z end) — negative pitch lifted the BUTT and
                  // read as holding the axe by its head, handle in the sky.
                  if (this.view.input.isFiring()) {
                    const cycle = (time * 1.4) % 1;
                    // Re-timed so the cycle isn't 70% static hold with the head
                    // buried in the trunk: COCK high 0–0.3, brief HOLD to 0.5,
                    // fast STRIKE 0.5–0.62, then recover.
                    const raise = THREE.MathUtils.smoothstep(cycle, 0, 0.3);
                    const strike = THREE.MathUtils.clamp((cycle - 0.5) / 0.12, 0, 1) ** 1.6;
                    const recover = THREE.MathUtils.smoothstep(cycle, 0.66, 1);
                    const arc = 1 - recover;
                    const pitch = 0.5 + (raise * 0.9 - strike * 2.4) * arc;
                    // THE SLIVER (the cutlass-thrust lesson, again). With the
                    // haft along Z the blade points along −Z, so its angle off
                    // the view axis is acos(cos(yaw)·cos(pitch)) — it foreshortens
                    // to NOTHING whenever pitch and yaw are BOTH near zero. The
                    // old keys swept yaw from +0.45 through −0.30, so it sat at
                    // ~0 at exactly the two moments pitch crossed the eyeline
                    // (mid-strike, and again for ~80 ms of the slow recovery,
                    // which is the frame the eye actually samples). Measured
                    // there: 0.9° off axis — a sliver of steel hiding behind the
                    // fists.
                    //
                    // Two changes, both needed. FIRST the yaw now OPENS with the
                    // chop instead of crossing over, so the swing travels
                    // diagonally across frame and the yaw never changes sign
                    // (a sign flip under the floor below would snap).
                    const yawKey = 0.15 + (raise * 0.3 + strike * 0.28) * arc;
                    // SECOND, a floor that makes the guarantee unconditional:
                    // whatever the keys ask for, hold ≥ MIN_OFF_AXIS of blade off
                    // the eyeline. The floor is 0 at the edge of the band and
                    // grows smoothly to its maximum at pitch = 0, so it eases in
                    // rather than snapping — and it is inert everywhere else,
                    // including at rest.
                    const cosPitch = Math.abs(Math.cos(pitch));
                    const yawFloor = cosPitch > Math.cos(MIN_OFF_AXIS)
                      ? Math.acos(THREE.MathUtils.clamp(Math.cos(MIN_OFF_AXIS) / cosPitch, -1, 1))
                      : 0;
                    return {
                      // Same rest anchor as below (0.26 / −0.20 / −0.80) so the
                      // chop swings away from a pose whose fists are in frame.
                      p: [
                        0.26 + (raise * 0.14 - strike * 0.4) * arc,
                        -0.2 + (raise * 0.16 - strike * 0.26) * arc,
                        -0.8 - strike * 0.14 * arc,
                      ],
                      r: [
                        pitch,
                        Math.max(yawKey, yawFloor),
                        // Roll is a spin about the haft — it never moves the head,
                        // so it is free to sell the bite of the blade.
                        -0.15 + (-raise * 0.2 + strike * 0.6) * arc,
                      ],
                    };
                  }
                  // Rest: head UP at the far end, hand low on the haft, pulled
                  // back so the blade clears the trunk you're stood against.
                  // FRAMING (this is the audited "axe floats with zero hands"):
                  // at z −0.62 the rear fist projected to ndc [0.47, −0.79] —
                  // the extreme bottom-right corner, behind the ship-hull and
                  // weapon-slot HUD tiles — while the head swept across mid
                  // screen, so the axe read as a prop with nothing holding it.
                  // Pushed 0.18 further out and lifted 0.04: fists now land at
                  // [0.30, −0.51] and [0.22, −0.28], on clear frame.
                  return { p: [0.26 + sway * 0.4, -0.2 + bob, -0.8], r: [0.5 + bob, 0.15 + sway * 0.2, -0.15] };
                })()
              // Shovel is long — lay it DIAGONALLY across the lower-right (blade
              // low, handle up-left) via a roll about the view axis, so the whole
              // tool stays in the frame plane instead of receding down-forward.
              // At z −0.54 the rear fist was only 0.41m from the eye, which threw
              // its palm to ndc.y −1.02 — literally off the bottom of the frame,
              // measured. 0.24 further out and 0.06 up puts both fists on the
              // haft in shot ([0.28, −0.52] and [0.15, −0.40]).
              : { p: [0.2 + sway * 0.4, -0.28 + bob, -0.78], r: [-0.2 + bob, 0.3 + sway * 0.2, 0.8] }; // shovel
        this.localViewPocketRoot.visible = true;
        this.localViewPocketRoot.position.set(cfg.p[0], cfg.p[1], cfg.p[2]);
        this.localViewPocketRoot.rotation.set(cfg.r[0], cfg.r[1], cfg.r[2]);
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
  private reloadChoreography(weaponId: WeaponId, p: number) {
    if (p <= 0.0001) return { pose: [0, 0, 0, 0, 0, 0], ram: 0, pulseIndex: -1 };
    const pulses = weaponId === 'blunderbuss' ? 2 : weaponId === 'eye_of_reach' ? 1 : 3;
    const inspect = THREE.MathUtils.smoothstep(p, 0, 0.3);
    const back = THREE.MathUtils.smoothstep(p, 0.72, 1);
    const hold = inspect * (1 - back);
    // Discrete plunges, timed so the last one lands right as RETURN starts.
    let ram = 0;
    let pulseIndex = -1;
    if (p > 0.3 && p < 0.74) {
      const u = (p - 0.3) / 0.44;
      pulseIndex = Math.floor(u * pulses);
      const frac = u * pulses - pulseIndex;
      ram = Math.sin(THREE.MathUtils.clamp(frac, 0, 1) * Math.PI) ** 1.6;
    }
    // Overshoot on the way home sells the snap-up.
    const overshoot = Math.sin(THREE.MathUtils.clamp((p - 0.72) / 0.28, 0, 1) * Math.PI) * 0.9;
    const bolt = weaponId === 'eye_of_reach' ? 1 : 0;
    if (weaponId === 'blunderbuss') {
      // SILHOUETTE RULE (this IS the audited "diagonal stack of gold spheres"
      // frame, and the previous attempt did not fix it — measured, the old keys
      // put the breech at camera z −0.55 and the muzzle at −1.56, so the gun
      // ran almost straight down the view axis: 1m of foreshortened barrel with
      // its bands turning into a diagonal row of gold ellipses, and the trigger
      // fist thrown to ndc.y −1.02, clean off the bottom of the frame.
      //
      // BROADSIDE means BROADSIDE: yaw the whole gun ~75° (total ry ≈ 1.30) and
      // push it 0.18 further out, so both ends sit at a comparable depth
      // (muzzle z −1.25, breech −0.93) and the reload silhouette is a gun lying
      // across the lower-middle frame — muzzle screen-left at ndc [−0.48,−0.28],
      // breech screen-right at [0.27,−0.42], support fist on the fore-end at
      // [−0.09,−0.47] and trigger fist at [0.10,−0.54].
      return {
        pose: [
          hold * -0.22 + ram * 0.03,
          hold * -0.02 - ram * 0.03,
          hold * -0.18 - ram * 0.04,
          hold * 0.15 - ram * 0.1 - overshoot * 0.08,
          hold * 1.16 + ram * 0.06,
          hold * 0.18 + ram * 0.05 + overshoot * 0.1,
        ],
        ram,
        pulseIndex,
      };
    }
    if (weaponId === 'flintknock') {
      // A pistol is primed UP at eye level, not dropped to the hip: the shared
      // keys shoved it 0.18 nearer the lens and 0.13 down, which put the whole
      // gun (and its fist) below the frame at ndc.y −1.8.
      return {
        pose: [
          hold * -0.04 + ram * 0.02,
          hold * 0.06 - ram * 0.04,
          hold * 0.04 + ram * 0.04,
          hold * 0.3 - ram * 0.14,
          hold * -0.15,
          hold * 0.55 + ram * 0.06 + overshoot * 0.12,
        ],
        ram,
        pulseIndex,
      };
    }
    // Long arms (Eye of Reach + fallback): the old keys dropped the gun 0.13 and
    // rolled it 1.1rad, which swung the trigger fist down to ndc.y −0.89 —
    // riding the bottom edge, and under the weapon-slot HUD tiles that live at
    // ndc.y −0.82…−0.97. Half the roll, a third of the drop, and a small push
    // AWAY from the lens keeps both fists at ndc.y ≈ −0.5 through the whole
    // choreography while the lock plate still comes up to the eye.
    return {
      pose: [
        hold * -0.06 + ram * 0.02,
        hold * -0.04 - ram * 0.04,
        hold * 0.06 + ram * 0.05,
        hold * (0.5 + bolt * 0.1) - ram * 0.12 - overshoot * 0.12,
        hold * -0.28 + bolt * hold * 0.2,
        hold * (0.5 + bolt * 0.35) + ram * 0.06 + overshoot * 0.1,
      ],
      ram,
      pulseIndex,
    };
  }

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
    if (this.localViewWeaponAmmoSignature && ammoSignature !== this.localViewWeaponAmmoSignature && activeWeapon.reloading) {
      this.localViewWeaponKick = Math.min(1.25, this.localViewWeaponKick + 0.24);
    }
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
      this.localViewWeaponKick = Math.min(1.35, this.localViewWeaponKick + 0.55);
    }
    this.prevLocalFiring = firingNow;
    const kickTarget = firearmEquipped && this.view.input.isFiring() && !activeWeapon.reloading ? 0.72 : 0;
    this.localViewWeaponKick += (kickTarget - this.localViewWeaponKick) * Math.min(1, this.view.frameDt * (kickTarget > this.localViewWeaponKick ? 18 : 13));
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
    const reload = this.reloadChoreography(weaponId, this.localViewWeaponReloadPhase);
    const [rlX, rlY, rlZ, rlRX, rlRY, rlRZ] = reload.pose;
    if (reload.pulseIndex >= 0 && reload.pulseIndex !== this.prevReloadPulse) {
      // A small camera nudge per ramrod stroke — the shove has weight.
      this.view.cameraShake = Math.min(1, this.view.cameraShake + 0.05);
    }
    this.prevReloadPulse = reload.pulseIndex;
    const recoilBack = this.localViewWeaponKick * 0.12;
    const recoilLift = this.localViewWeaponKick * 0.045;
    const recoilRoll = this.localViewWeaponKick * 0.055;

    // A raised spyglass (hold P) occupies both hands — stow the weapon.
    this.localViewWeaponRoot.visible = !this.view.spyglassActive;

    switch (weaponId) {
      case 'eye_of_reach':
        // The rifle is 1.4m of viewmodel: pointed straight down the view axis
        // it foreshortened into a stock corner at the right edge (and recoil
        // pushed even that off-screen). Yaw it POSITIVE so the barrel crosses
        // toward screen centre and sits as a readable diagonal.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.24, 0.025, aimBlend) + sway * 0.26 + travelSwing * 0.18 + rlX,
          THREE.MathUtils.lerp(-0.26, -0.15, aimBlend) + bob * 0.75 - recoilLift + rlY,
          THREE.MathUtils.lerp(-0.96, -0.42, aimBlend) - recoilBack * 0.72 + rlZ,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.16 + aimBlend * 0.16 - recoilLift * 1.1 + rlRX,
          THREE.MathUtils.lerp(0.3, 0.0, aimBlend) + rlRY,
          -0.06 - strafeTilt * 0.8 - recoilRoll + rlRZ,
        );
        break;
      case 'blunderbuss':
        // Lower-right hip with real screen PRESENCE (reads as a gun) without
        // parking the fat stock over center; barrel angled toward the
        // crosshair so the muzzle flash lands in the visible lower third.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.32, 0.16, aimBlend) + sway * 0.36 + travelSwing * 0.28 + rlX,
          THREE.MathUtils.lerp(-0.28, -0.24, aimBlend) + bob - recoilLift * 0.8 + rlY,
          THREE.MathUtils.lerp(-0.82, -0.7, aimBlend) - recoilBack * 0.72 + rlZ,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.2 - aimBlend * 0.07 - recoilLift + rlRX,
          THREE.MathUtils.lerp(0.14, 0.06, aimBlend) + rlRY,
          -0.08 - strafeTilt - recoilRoll * 0.8 + rlRZ,
        );
        break;
      case 'cutlass':
        {
          // Shared progress helper — denominator locked per swing (basic 0.55s
          // vs lunge 1.05s) so the animation always plays forward from windup.
          // POSE MATH NOTE: the cutlass mesh is authored blade-UP along +Y
          // (grip at the origin, tip at y≈1). Every key below was derived from
          // that axis and verified frame-by-frame — small positive X pitches
          // point the tip INTO the camera (the old "upside down" read).
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
          const mixPose = (a: number[], b: number[], t: number) => {
            for (let i = 0; i < 6; i++) a[i] += (b[i] - a[i]) * t;
            return a;
          };
          // Ready stance: hilt lower-right, blade rising across toward screen
          // center, tip angled forward — the sword is SEEN at rest.
          // Lifted from y −0.36 so the hilt, knuckle bow and gripping hand all
          // stay in frame (they used to sit below the bottom edge).
          const REST = [0.33, -0.26, -0.66, -0.62, -0.1, 0.28];
          if (cutlassBlocking) {
            // Guard: the full blade crosses horizontally UNDER the crosshair
            // (it used to sit as a gold arc in the bottom-right corner with the
            // blade angled out of frame).
            this.localViewWeaponRoot.position.set(
              0.06 + sway * 0.14,
              -0.16 + bob * 0.45,
              -0.44 + travelSwing * 0.08,
            );
            this.localViewWeaponRoot.rotation.set(-0.35, 0.15, -1.5 - strafeTilt * 0.4);
          } else if (cooldownProgress > 0.001 && swingKind === 'lunge') {
            // DASH THRUST: pull back, then the blade rams dead-forward
            // (rot.x −1.62 maps the +Y blade onto the view axis) and holds
            // extended through the dash before sweeping home.
            const p = cooldownProgress;
            const windup = THREE.MathUtils.smoothstep(p, 0, 0.09);
            const stab = THREE.MathUtils.smoothstep(p, 0.09, 0.24);
            const carry = THREE.MathUtils.smoothstep(p, 0.24, 0.6);
            const recover = THREE.MathUtils.smoothstep(p, 0.6, 1);
            const pose = mixPose(
              mixPose(
                mixPose(
                  // Windup was pulled UP and forward: at y −0.35 / z −0.45 the
                  // hilt projected to ndc.y −1.09 — the fist and guard were
                  // under the frame and the blade looked detached, floating in
                  // mid-screen, which is exactly how the charge-dash read.
                  mixPose([...REST], [0.42, -0.2, -0.62, -0.55, -0.35, -0.55], windup),
                  // Thrust keys are kept ~0.35rad OFF the view axis: dead-on
                  // (rot.x −1.62) foreshortened the blade into a nub inside a
                  // giant gold guard — the "holding a donut" frame.
                  [0.2, -0.16, -0.88, -1.24, 0.3, -0.08], stab,
                ),
                [0.22, -0.18, -0.82, -1.18, 0.32, -0.16], carry,
              ),
              REST, recover,
            );
            this.localViewWeaponRoot.position.set(pose[0], pose[1] + bob * 0.3, pose[2]);
            this.localViewWeaponRoot.rotation.set(pose[3], pose[4], pose[5] - strafeTilt * 0.6);
          } else if (cooldownProgress > 0.001) {
            // SLASH — ANTICIPATION → WHIP → FOLLOW-THROUGH → RECOVERY.
            //
            // THE BUG THESE KEYS FIX (measured, not guessed): the old arc only
            // ever rolled the blade from −0.85 to +1.24 rad, so it passed
            // through VERTICAL — i.e. through the rest pose — at exactly the
            // middle of the swing. Projected: at p = 0.32 the tip sat at ndc
            // [0.05, 0.51] and at rest it sits at [0.05, 0.50]. The one frame
            // the eye actually samples was pixel-identical to "idle". That is
            // the whole "rest and mid-slash look the same" report.
            //
            // Now the blade LIES FLAT ACROSS THE SCREEN at the cut (roll 1.45,
            // tip ndc ≈ [−0.83, 0.16] with the hilt still at [0.30, −0.20] —
            // a horizontal blade through the crosshair, nothing like rest) and
            // the whip window is 77ms wide, so barely one frame is spent
            // anywhere near vertical. Every key is projected offline: hilt /
            // guard / mid-blade / tip all stay inside the frame for the whole
            // 0.55s on BOTH diagonals, and the follow-through still holds the
            // blade in shot at p = 0.55 (tip [−0.73, −0.59], hilt [0.18,
            // −0.08]) — the open item from 6586c3b, now frame-verified.
            const sSide = this.cutlassSlashSide;
            const p = cooldownProgress;
            const cock = THREE.MathUtils.smoothstep(p, 0, 0.2);
            const cut = THREE.MathUtils.smoothstep(p, 0.2, 0.34);
            const through = THREE.MathUtils.smoothstep(p, 0.34, 0.56);
            const recover = THREE.MathUtils.smoothstep(p, 0.62, 1);
            // Roll-dominant, and MIRRORED about the view axis per diagonal —
            // a partial mirror (the old `0.24 + 0.1·side`) left the off-side
            // swing's tip at ndc.x +1.22, off the right-hand edge.
            const pose = mixPose(
              mixPose(
                mixPose(
                  // ANTICIPATION: hilt lifts to ndc [0.34, −0.30] and the blade
                  // lays right back over the shoulder (tip [0.77, 0.60]) — a
                  // wind-up you can read in a single frame.
                  mixPose([...REST], [0.31 * sSide, -0.15, -0.68, -0.75, -0.3 * sSide, -0.85 * sSide], cock),
                  // WHIP: blade horizontal across the crosshair.
                  [0.29 * sSide, -0.11, -0.72, -0.3, 0.25 * sSide, 1.45 * sSide], cut,
                ),
                // FOLLOW-THROUGH: rolled past horizontal and pushed forward to
                // z −0.92, finishing down-across the far side of the frame.
                [0.22 * sSide, -0.06, -0.92, -0.1, 0.3 * sSide, 1.85 * sSide], through,
              ),
              REST, recover,
            );
            this.localViewWeaponRoot.position.set(pose[0], pose[1] + bob * 0.3, pose[2]);
            this.localViewWeaponRoot.rotation.set(pose[3], pose[4], pose[5] - strafeTilt * 0.8);
          } else {
            // Rest / charge wind-up. The old charge keys cocked the sword DOWN
            // and 0.10 nearer the lens, which walked the gripping fist to ndc
            // [0.56, −0.82] — off the bottom AND directly behind the weapon-slot
            // HUD tiles (ndc.y −0.82…−0.97). With no fist in shot the blade read
            // as a gold shape detached in mid-screen, which is exactly the
            // "cutlass detaches during the charge dash" report. A real windup
            // lifts the sword anyway: hilt now settles at ndc [0.46, −0.44] with
            // the tip at [0.43, 0.72] — the whole weapon and its fist in frame.
            this.localViewWeaponRoot.position.set(
              REST[0] + charge * 0.06 + sway * 0.24 + travelSwing * 0.42,
              REST[1] + charge * 0.05 + chargeReadyPulse + bob * 0.75,
              REST[2] + charge * 0.02,
            );
            this.localViewWeaponRoot.rotation.set(
              REST[3] + charge * 0.02,
              REST[4] - charge * 0.3,
              REST[5] - charge * 0.55 - strafeTilt * 1.4,
            );
          }
        }
        break;
      default:
        // Flintknock + fallback: readable lower-right presence, barrel angled
        // toward the crosshair so the muzzle flash lands on screen. Carried a
        // touch higher and further out than before — the pistol was posed so
        // low and so near the lens that its own gripping fist projected to
        // ndc.y −0.89 at rest and −1.83 mid-reload (clean off the bottom).
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.24, 0.085, aimBlend) + sway * 0.64 + travelSwing * 0.38 + rlX,
          THREE.MathUtils.lerp(-0.15, -0.12, aimBlend) + bob - recoilLift * 0.62 + rlY,
          THREE.MathUtils.lerp(-0.62, -0.5, aimBlend) - recoilBack * 0.8 + rlZ,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.16 - aimBlend * 0.07 - recoilLift + rlRX,
          THREE.MathUtils.lerp(0.16, 0.06, aimBlend) + rlRY,
          -0.1 - strafeTilt - recoilRoll + rlRZ,
        );
        break;
    }

    // ── DRAW: the fresh weapon rises into the pose with a slight overshoot
    // instead of appearing mid-frame already at rest.
    if (this.localViewDrawTimer < 1) {
      const e = 1 - this.localViewDrawTimer;
      const overshoot = Math.sin(this.localViewDrawTimer * Math.PI) * 0.1;
      this.localViewWeaponRoot.position.y -= 0.34 * e * e;
      this.localViewWeaponRoot.position.z += 0.1 * e * e;
      this.localViewWeaponRoot.rotation.x += 0.75 * e * e - overshoot;
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
