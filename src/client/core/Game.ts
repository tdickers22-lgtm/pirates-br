import * as THREE from 'three';
import { ECONOMY, HARVEST, PHYSICS, PLAYER, SHARK, SHIP, SHIP_STATS, SHIP_UPGRADES, STORM_PHASES, UPGRADE_COSTS, WEAPONS, WILDLIFE } from '../../shared/constants/index.js';
import type {
  GameState, HotSnapshotPayload, InteractIntent, Island, IslandNpc, IslandProp, IslandPropType, ItemStack, MatchStartPayload, Player, PlayerInput, Projectile, SharkAttackState, Ship, ShipKeg, ShipUpgradeType, TradeSession, TreasureChest, UpgradeStation, WeaponId, WeaponInstance, WildlifeAnimal,
} from '../../shared/types/index.js';
import { getBridgeDeckY, getSailRopeStationLocals, getBraceStationLocals, getIslandSurfaceY, getNearestShipBoardingLadder, getIslandDockSwimLadderPoint, isPointInsideIslandFootprint, sampleWind, angleWrap, getMainMastLocalZ, gerstnerHeight, WAVE_PARAMS, getStormWaveIntensity, getIslandMaxRadius, getCaveFloorY, getCaveCeilingY, isInsideSwimHullFootprint, pushOutOfSwimHullFootprint, getSwimHullVerticalBand, getShipQuarterdeckConfig } from '../../shared/utils/index.js';
import { getPropGroundY } from '../../shared/props.js';
import {
  findNearbyCannonIndex as findSharedNearbyCannonIndex,
  getAmmoCrateLocal,
  getAnchorControlLocal as getSharedAnchorControlLocal,
  getCannonDeckLocalPosition as getSharedCannonDeckLocalPosition,
  getSailControlLocal as getSharedSailControlLocal,
  isNearAmmoCrate,
  isNearAnchor as isSharedNearAnchor,
  isNearCrowNestLadder as isSharedNearCrowNestLadder,
  isNearHelm as isSharedNearHelm,
  isNearSailStation as isSharedNearSailStation,
  toShipLocalPoint,
} from '../../shared/interactions.js';
import { Renderer } from '../rendering/Renderer.js';
import { OceanRenderer } from '../rendering/OceanRenderer.js';
import { ShipRenderer } from '../rendering/ShipRenderer.js';
import { CombatFx } from '../rendering/CombatFx.js';
import { SoundEngine } from '../audio/SoundEngine.js';
import { NetworkClient } from '../network/NetworkClient.js';
import { MenuController } from '../menu/MenuController.js';
import { InputManager } from '../input/InputManager.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';
import { buildUiRefs, type UiRefs } from '../ui/UiRefs.js';
import { IslandBuilder } from '../world/IslandBuilder.js';
import type { ChestMeshRecord, NpcMeshRecord, UpgradeStationMeshRecord } from '../world/IslandBuilder.js';
import { HudController, type HudView } from '../ui/HudController.js';
import { MapRenderer, type MapView } from '../ui/MapRenderer.js';
import { CUTLASS_VIEW_CHARGE_TIME, PlayerAnimator, type PlayerAnimatorView } from '../rendering/PlayerAnimator.js';
import { applyPlayerTeamColor, makePlayerMesh } from '../rendering/factories/PlayerMeshFactory.js';
import { applyViewmodelMaterialSettings, makeHeldWeaponMesh, makePocketPreviewMesh } from '../rendering/factories/WeaponMeshFactory.js';
import { makeLanternFlameTexture, makeLanternGlowTexture, makeStormTexture, makeWindWispTexture } from '../rendering/factories/TextureFactory.js';
import { buildMermaidMesh, makeNameplateSprite, makeProjectileMesh } from '../rendering/factories/MiscMeshFactory.js';
import type { PocketPreviewKind } from '../rendering/factories/WeaponMeshFactory.js';

const CLIENT_INPUT_SEND_INTERVAL = 1 / 45;
const CLIENT_INPUT_HEARTBEAT_INTERVAL = 0.2;

function installGeometryNaNGuard() {
  const proto = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
    __piratesBrNaNGuard?: boolean;
  };
  if (proto.__piratesBrNaNGuard) return;
  proto.__piratesBrNaNGuard = true;

  const originalComputeBoundingSphere = proto.computeBoundingSphere;
  proto.computeBoundingSphere = function guardedComputeBoundingSphere(this: THREE.BufferGeometry) {
    const position = this.getAttribute('position') as THREE.BufferAttribute | undefined;
    const values = position?.array as ArrayLike<number> & { [index: number]: number } | undefined;
    if (values) {
      let changed = false;
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) {
          values[i] = 0;
          changed = true;
        }
      }
      if (changed && position) position.needsUpdate = true;
    }
    return originalComputeBoundingSphere.call(this);
  };
}

installGeometryNaNGuard();

type KegMeshRecord = {
  root: THREE.Group;
  fuse: THREE.PointLight;
};

type StoryCutsceneRefs = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  name: HTMLDivElement;
  line: HTMLDivElement;
  cue: HTMLDivElement;
};

type WindWispRecord = {
  mesh: THREE.Mesh;
  radius: number;
  height: number;
  phase: number;
  speed: number;
  sway: number;
  tilt: number;
};

export type FloatingDamageIndicator = {
  element: HTMLDivElement;
  worldPos: THREE.Vector3;
  life: number;
  duration: number;
  riseSpeed: number;
};

/**
 * A warm island light source (dock lantern, campfire, cave torch, tavern lantern).
 * The nearest few of each kind get a real PointLight at night; everything else
 * shows an additive glow sprite scaled by the night factor. `anchor` lives inside
 * its island group so it inherits the island transform and is disposed with it.
 */
type LanternEmitter = {
  anchor: THREE.Object3D;
  kind: 'lantern' | 'campfire';
  glow: THREE.Sprite;
  flame: THREE.Sprite | null;
  worldPos: THREE.Vector3;
  dist: number;
  phase: number;
};

/** Zero-scale matrix used to collapse a removed prop's InstancedMesh slot. */
const ZERO_SCALE_MAT4 = new THREE.Matrix4().makeScale(0, 0, 0);

/** Interaction kinds the HUD arbiter juggles: server intents plus CLIENT-ONLY
 *  kinds that never ride interactIntent — 'door' (tavern doors swing locally)
 *  and 'harvest' (the axe prompt; LMB does the work via useItem). */
export type ClientInteractKind = InteractIntent | 'door' | 'harvest';

export class Game {
  private readonly renderer = new Renderer();
  private readonly ocean = new OceanRenderer();
  /** EMA-smoothed offset mapping performance.now()/1000 onto server sim seconds. */
  private serverTimeOffset: number | null = null;
  /** Dev/tour hook: when non-null, forces the day/night clock to this many
   *  seconds (see setDayNightOverride), so a visual tour can capture noon,
   *  dusk and night deterministically. Inert during normal play. */
  private dayNightOverrideSec: number | null = null;
  private readonly shipRenderer = new ShipRenderer();
  private readonly combatFx = new CombatFx();
  private readonly audio = new SoundEngine();
  // Edge-detect state for sound triggers (chest carry, drowning, eating, sail/anchor changes).
  private prevCarryingChestId: string | null = null;
  private prevPlayerStateForAudio: string | null = null;
  private prevPocketUseCooldown = 0;
  private prevAnchored: boolean | null = null;
  private prevAnchorRaiseProgress: number | null = null;
  private prevSailHeightForAudio: number | null = null;
  private prevSailAngleForAudio: number | null = null;
  private lastSailTrimSoundAt = 0;
  private lastAnchorMoveSoundAt = 0;
  private lastHelmTurnSoundAt = 0;
  private lastHullSplashAt = 0;
  private lastSwimStrokeAt = 0;
  private readonly remoteSwimAudioState = new Map<string, string>();
  private prevStormPhase = -1;
  private digStrikePhase = 0;
  private prevAxeChopCycle = 1;
  private prevMeleeReloading = false;
  private prevCannonBallistic = false;
  private prevStormShrinking = false;
  // Bilge flooding audio loop + FX throttles (naval damage loop).
  private floodingLoopActive = false;
  private lastHullLeakAt = 0;
  private readonly lastChainshotWhirrAt = new Map<string, number>();
  // Camera feel — additive on top of updateCamera's base FOV/orientation.
  private cameraFovKick = 0;      // eased FOV bump in degrees
  private cameraShake = 0;        // trauma 0..1, decays each frame
  private cameraShakeCannon = 0;  // brief own-cannon FOV pop 0..1
  private cameraRoll = 0;         // smoothed deck-roll coupling (rad)
  private prevOwnHullTotal = 4;   // sum of local ship hull sections for hit detection
  private prevOwnShipId: string | null = null;
  private readonly tempShakeVec = new THREE.Vector3();
  // Island lantern / campfire warm-light budget.
  private readonly lanternRoot = new THREE.Group();
  private readonly lanternLightPool: THREE.PointLight[] = [];
  private readonly campfireLightPool: THREE.PointLight[] = [];
  private readonly lanternEmitters: LanternEmitter[] = [];
  private readonly assignedLanterns: LanternEmitter[] = [];
  private readonly assignedCampfires: LanternEmitter[] = [];
  private lanternGlowTexture: THREE.Texture | null = null;
  private lanternFlameTexture: THREE.Texture | null = null;
  /** Currently-browsed barrel — renders the side-by-side inventory comparison panel */
  private barrelBrowse: { barrelId: string; loot: ItemStack[]; lastEventAt: number } | null = null;
  private readonly network = new NetworkClient();
  private readonly input = new InputManager();
  private readonly menu = new MenuController({
    network: this.network,
    audio: this.audio,
    input: this.input,
    onMatchStart: (payload) => this.onMatchStartFromMenu(payload),
    onReturnToMenu: () => this.onReturnToMenuFromEnd(),
  });
  // Used by ambient render & end-of-round flow + gameplay-key gating.
  private inMatch = false;
  // @ts-expect-error reserved for showing the leaderboard until user dismisses it
  private endmatchPending = false;
  private readonly ui: UiRefs = buildUiRefs();

  private state: GameState | null = null;
  private playersById = new Map<string, Player>();
  private shipsById = new Map<string, Ship>();
  private livePlayerIds = new Set<string>();
  private liveProjectileIds = new Set<string>();
  private liveKegIds = new Set<string>();
  private localPlayerId: string | null = null;
  private localShipId: string | null = null;
  /** Cleared when the server sends `join`; avoids an endless 68% bar if assignment stalls. */
  private joinAssignmentWatchdog: number | null = null;
  private lastFrameTime = performance.now();
  private frameDt = 1 / 60;
  /** Shared emissive-glow flicker for volcanic magma veins + caldera lava,
   *  driven per-frame in updateVolcanicFx and read by the terrain shader. */
  private readonly magmaPulseUniform = { value: 1 };
  /** Per-frame FX closures for volcanic islands (ash drift, embers, smoke,
   *  caldera lava, erupting geyser plumes). Cleared with the island meshes. */
  private volcanicFx: Array<(dt: number, worldTime: number, camera: THREE.Vector3) => void> = [];
  /** Cached soft radial particle sprite (ash/steam/ember points share it). */
  private softParticleTexture: THREE.Texture | null = null;
  /** Dev-only detached camera. Inert unless enableFreeCam() is called (e.g. from
   *  a visual-tour harness via window.__piratesBR); normal play never touches it. */
  private freeCam: { pos: THREE.Vector3; yaw: number; pitch: number } | null = null;
  private readonly debugPerfEnabled = (() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('debug') || params.has('perf');
  })();
  /** ?stormdemo — client-visual storm preview (raging seas, rain, tint) without
   *  waiting for real storm phases. Screenshot/dev aid; server sim unaffected. */
  private readonly debugStormDemo = new URLSearchParams(window.location.search).has('stormdemo');
  /** F8 = one-keypress bug report: next frame is captured (canvas + state)
   *  and POSTed to /bugsnap on the game server → data/bugsnaps/. */
  private bugSnapRequested = false;
  private bugSnapListenerBound = false;
  private readonly bugSnapListener = (event: KeyboardEvent) => {
    if (event.code === 'F8') {
      event.preventDefault();
      this.bugSnapRequested = true;
    }
  };
  private debugPerfPanel: HTMLDivElement | null = null;
  private debugFrameCounter = 0;
  private debugFrameAccum = 0;
  private debugFps = 0;
  private debugWorstFrameMs = 0;
  private debugRawFrameMs = 16.7;
  private debugUpdateTimer = 0;
  private hudTimer = 0;
  private minimapTimer = 0;
  private interactScanTimer = 0;
  private slowSceneTimer = 0;
  private inputSendTimer = 0;
  private inputHeartbeatTimer = 0;
  private windWispTimer = 0;
  private rainOverlayTimer = 0;
  private lastSentInputSignature = '';
  private previousHealth: number = PLAYER.MAX_HEALTH;
  private previousKnockback = 0;
  private activeTradeSessionId: string | null = null;
  private localTradeOffer: ItemStack[] = [];
  /** Supply-wheel slot the mouse is hovering while it's open (radial select). */
  private wheelHoverSlot: number | null = null;
  /** Whether the supply wheel was open last frame — to catch the release edge. */
  private wheelWasOpen = false;
  /** Aim button state last frame — so right-click can lower a raised spyglass. */
  private scopeAimWasDown = false;
  /** Wind vector + clock driving the palm/foliage sway shader (updated per frame). */
  private readonly foliageWind = { value: new THREE.Vector2(0.62, 0.42) };
  private readonly foliageTime = { value: 0 };
  /** Warm point light carried by the player while the LANTERN tool is equipped. */
  private readonly heldLampLight = new THREE.PointLight(0xffb262, 0, 26, 1.6);
  /** 0→1 eased "lantern raised" state (ATTACK/LMB while holding the lantern). */
  private lanternRaise01 = 0;
  private previousLocalState: Player['state'] | null = null;
  private prevIsInsideIsland: string | null = null;
  private islandBannerHideAt = 0;
  private islandArrivalAudioCtx: AudioContext | null = null;
  private lightningFlash: THREE.PointLight | null = null;
  private lightningTimer = 4 + Math.random() * 6;
  private stormWeatherIntensity = 0;
  private stormRainCanvas: HTMLCanvasElement | null = null;
  private stormRainCtx: CanvasRenderingContext2D | null = null;
  private stormLightningFlashEl: HTMLDivElement | null = null;
  private stormLightningFlashOpacity = 0;
  private storyCutscene: StoryCutsceneRefs | null = null;
  private storyCutsceneNpcId: string | null = null;
  private storyCutsceneHideAt = 0;
  /** Matches the HUD [X] prompt — server must perform this action only. */
  private lightningLightPool: THREE.PointLight | null = null;
  private lightningBolt: THREE.Line | null = null;
  private spyglassActive = false;
  // 'door' is a CLIENT-ONLY interaction kind (tavern doors are cosmetic and
  // collision-less) — it must never be sent as a server interactIntent.
  private lastInteractKind: ClientInteractKind | null = null;
  private visibleInteractKind: ClientInteractKind | null = null;
  private pendingInteractFromUi = false;
  private pendingLaunchFromUi = false;
  private readonly stormRingPositions = new Float32Array(96 * 3);
  private readonly stormWallColorClear = new THREE.Color(0x395270);
  private readonly stormWallColorStorm = new THREE.Color(0x202a3f);
  private readonly stormWallTexture = makeStormTexture();
  private readonly windWispTexture = makeWindWispTexture();
  private readonly tempProjectilePos = new THREE.Vector3();
  private readonly tempKegPos = new THREE.Vector3();
  private readonly tempSharkPos = new THREE.Vector3();
  private readonly tempWildlifePos = new THREE.Vector3();
  private readonly tempHudVector = new THREE.Vector3();
  private readonly tempRenderPos = new THREE.Vector3();
  private readonly tempBallisticPos = new THREE.Vector3();
  private readonly localViewWeaponRoot = new THREE.Group();
  /** First-person hands shown while cranking the capstan (anchor hold). */
  private readonly localViewHandsRoot = new THREE.Group();
  private capstanHandsBuilt = false;
  private readonly localViewPocketRoot = new THREE.Group();
  private localViewPocketKind: PocketPreviewKind | null = null;
  private pocketUsePreviewKind: PocketPreviewKind | null = null;
  private pocketUsePreviewTimer = 0;
  private localViewWeaponId: WeaponInstance['weaponId'] | null = null;
  private localViewWeaponKick = 0;
  /** First-person muzzle flash + powder smoke on the local viewmodel barrel. */
  private muzzleFlash: THREE.Sprite | null = null;
  private muzzleGlow: THREE.PointLight | null = null;
  private muzzleSmoke: THREE.Sprite[] = [];
  private muzzleFlashTimer = 0;
  private prevLocalFiring = false;
  private localViewWeaponReloadPhase = 0;
  private localCutlassCharge = 0;
  private localViewWeaponAmmoSignature = '';
  private lastSnapshotAt = performance.now();
  private hitMarkerTimer = 0;
  private hitMarkerHeadshot = false;
  private hitMarkerKill = false;
  private hitMarkerShip = false;
  private hitMarkerShark = false;
  private readonly floatingDamageIndicators: FloatingDamageIndicator[] = [];

  private readonly islandMeshes = new Map<string, THREE.Group>();
  /** propId → InstancedMesh slot per island, so prop_removed can collapse one
   *  felled palm / cracked boulder without rebuilding the whole batch. */
  private readonly islandPropInstances = new Map<string, Map<number, { inst: THREE.InstancedMesh; index: number }>>();
  /** Swingable tavern door leaves (GLB node 'door', origin on the hinge). */
  private tavernDoors: Array<{ islandId: string; node: THREE.Object3D; open: boolean }> = [];
  /** Locally-promoted harvest target: the instanced palm/boulder is swapped for a
   *  live clone while the axe works it, so strikes shake it and completion plays a
   *  real breakdown. One slot — the axe only ever works one prop at a time. */
  private harvestPromoted: {
    islandId: string;
    propId: number;
    type: IslandPropType;
    node: THREE.Object3D;
    /** Original instance matrix, restored on a clean demote (chop abandoned). */
    savedMatrix: THREE.Matrix4;
    basePos: THREE.Vector3;
    /** World-space height of the clone (crown offset for palm FX). */
    height: number;
    shakeTimer: number;
    shakeSeed: number;
  } | null = null;
  /** Felled palms mid-topple → bounce → sink-and-fade (promoted clones, or
   *  just-in-time clones when a REMOTE player felled the tree). */
  private readonly harvestFalls: Array<{
    node: THREE.Object3D;
    age: number;
    baseYaw: number;
    fallDirX: number;
    fallDirZ: number;
    trunkHeight: number;
    baseLocalY: number;
    baseWorld: THREE.Vector3;
    impactFired: boolean;
    fadeMats: THREE.Material[] | null;
  }> = [];
  /** Own copy of the 1.4Hz chop-beat edge detector (audioFrameTriggers keeps its own). */
  private prevHarvestChopCycle = 1;
  private readonly tempHarvestVec = new THREE.Vector3();
  private readonly tempHarvestQuatA = new THREE.Quaternion();
  private readonly tempHarvestQuatB = new THREE.Quaternion();
  /** bucketFilled edge-detector per player — bail FX fire on the transitions. */
  private readonly prevBucketFilled = new Map<string, boolean>();
  /** Alternating slash diagonal for the first-person cutlass (flips per swing). */
  private cutlassSlashSide: 1 | -1 = 1;
  private prevCutlassSwingProgress = 0;
  /** 0..1 FOV punch on the cutlass dash, decays fast (rush feel). */
  private cutlassDashKick = 0;
  /** True while the axe has a harvestable in range — gates the chop thunk. */
  private harvestTargetActive = false;
  // ── Anime slash trails: pooled, zero per-swing allocations ──
  /** Camera-space crescent ribbons (2, alternating) for the first-person slash. */
  private slashRibbons: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; side: 1 | -1 }> = [];
  private slashRibbonCursor = 0;
  /** Straight forward streak for the cutlass dash-lunge. */
  private slashStreak: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number } | null = null;
  private slashTexture: THREE.CanvasTexture | null = null;
  /** World-space billboard arcs at REMOTE players' sword hands (pooled). */
  private remoteSlashArcs: Array<{ sprite: THREE.Sprite; age: number; life: number }> = [];
  private remoteSlashCursor = 0;
  private readonly tempSlashPos = new THREE.Vector3();
  private readonly chestMeshes = new Map<string, ChestMeshRecord>();
  private readonly barrelMeshes = new Map<string, THREE.Group>();
  private readonly sharkMeshes = new Map<string, THREE.Group>();
  /** Last seen attackState per shark — edges fire the telegraph FX/sounds once. */
  private readonly sharkPrevAttackState = new Map<string, SharkAttackState>();
  private readonly wildlifeMeshes = new Map<string, THREE.Group>();
  private readonly seaRockMeshes = new Map<string, THREE.Group>();
  private readonly kegMeshes = new Map<string, KegMeshRecord>();
  private readonly upgradeStationMeshes = new Map<string, UpgradeStationMeshRecord>();
  private readonly npcMeshes = new Map<string, NpcMeshRecord>();
  private readonly playerMeshes = new Map<string, THREE.Group>();
  private readonly projectileMeshes = new Map<string, THREE.Mesh>();
  private readonly windWispMeshes: WindWispRecord[] = [];
  private readonly seenStoryNpcIds = new Set<string>();

  private readonly environment = new THREE.Group();
  /** Island terrain / prop / sea-rock mesh construction (see world/IslandBuilder.ts). */
  private readonly islands = new IslandBuilder({
    renderer: this.renderer,
    islandPropInstances: this.islandPropInstances,
    foliageWind: this.foliageWind,
    foliageTime: this.foliageTime,
    registerLanternEmitter: (container, x, y, z, kind) => this.registerLanternEmitter(container, x, y, z, kind),
    environment: this.environment,
    islandMeshes: this.islandMeshes,
    chestMeshes: this.chestMeshes,
    barrelMeshes: this.barrelMeshes,
    upgradeStationMeshes: this.upgradeStationMeshes,
    npcMeshes: this.npcMeshes,
    magmaPulseUniform: this.magmaPulseUniform,
    pushVolcanicFx: (fx) => { this.volcanicFx.push(fx); },
    setTavernDoor: (islandId, node) => {
      this.tavernDoors = this.tavernDoors.filter((entry) => entry.islandId !== islandId);
      this.tavernDoors.push({ islandId, node, open: false });
    },
    getSoftParticleTexture: () => this.getSoftParticleTexture(),
    getUpgradePresentation: (type) => this.getUpgradePresentation(type),
  });

  /** Third-person avatar animation (see rendering/PlayerAnimator.ts). */
  private readonly anim = new PlayerAnimator(this.createPlayerAnimatorView());

  private createPlayerAnimatorView(): PlayerAnimatorView {
    const self = this;
    return {
      input: this.input,
      ocean: this.ocean,
      get localPlayerId() { return self.localPlayerId; },
      tempSlashPos: this.tempSlashPos,
      spawnRemoteSlashArc: (worldPos) => this.spawnRemoteSlashArc(worldPos),
      getCutlassSwingProgress: (player) => this.getCutlassSwingProgress(player),
    };
  }

  /** Per-player swing-type latch; still reachable as `game.cutlassSwingKind`
   *  because scripts/pose-pin-probe.mjs drives it directly. */
  private get cutlassSwingKind() { return this.anim.cutlassSwingKind; }

  /** Delegate kept for the pose probe, which may override this on the instance. */
  private getCutlassSwingProgress(player: Player) {
    return this.anim.getCutlassSwingProgress(player);
  }

  /** Minimap / battle map / treasure chart drawing (see ui/MapRenderer.ts). */
  private readonly map = new MapRenderer(this.createMapView());

  private createMapView(): MapView {
    const self = this;
    return {
      ui: this.ui,
      input: this.input,
      renderer: this.renderer,
      get state() { return self.state; },
      formatStormTimer: (seconds) => this.formatStormTimer(seconds),
      getClosestGoldHoarder: (player) => this.getClosestGoldHoarder(player),
      getLocalPlayer: () => this.getLocalPlayer(),
      getNearestIsland: (px, pz) => this.getNearestIsland(px, pz),
      getStormTimerSeconds: () => this.getStormTimerSeconds(),
      getTrackedShip: () => this.getTrackedShip(),
    };
  }

  /** In-match HUD panels and feed (see ui/HudController.ts). */
  private readonly hud = new HudController(this.createHudView());

  private createHudView(): HudView {
    const self = this;
    return {
      ui: this.ui,
      input: this.input,
      renderer: this.renderer,
      ocean: this.ocean,
      shipsById: this.shipsById,
      floatingDamageIndicators: this.floatingDamageIndicators,
      tempHudVector: this.tempHudVector,
      get state() { return self.state; },
      get localPlayerId() { return self.localPlayerId; },
      get spyglassActive() { return self.spyglassActive; },
      get wheelHoverSlot() { return self.wheelHoverSlot; },
      get islandBannerHideAt() { return self.islandBannerHideAt; },
      get barrelBrowse() { return self.barrelBrowse; },
      set barrelBrowse(v) { self.barrelBrowse = v; },
      get hitMarkerTimer() { return self.hitMarkerTimer; },
      set hitMarkerTimer(v) { self.hitMarkerTimer = v; },
      get hitMarkerShip() { return self.hitMarkerShip; },
      set hitMarkerShip(v) { self.hitMarkerShip = v; },
      get hitMarkerShark() { return self.hitMarkerShark; },
      set hitMarkerShark(v) { self.hitMarkerShark = v; },
      get hitMarkerHeadshot() { return self.hitMarkerHeadshot; },
      set hitMarkerHeadshot(v) { self.hitMarkerHeadshot = v; },
      get hitMarkerKill() { return self.hitMarkerKill; },
      set hitMarkerKill(v) { self.hitMarkerKill = v; },
      get prevIsInsideIsland() { return self.prevIsInsideIsland; },
      set prevIsInsideIsland(v) { self.prevIsInsideIsland = v; },
      get visibleInteractKind() { return self.visibleInteractKind; },
      set visibleInteractKind(v) { self.visibleInteractKind = v; },
      distance2D: (ax, az, bx, bz) => this.distance2D(ax, az, bx, bz),
      findNearbyCannonIndex: (player, ship) => this.findNearbyCannonIndex(player, ship),
      findRepairableHullSection: (player, ship) => this.findRepairableHullSection(player, ship),
      flashIslandBanner: (name) => this.flashIslandBanner(name),
      formatCompassHeading: (angle) => this.formatCompassHeading(angle),
      formatStormTimer: (seconds) => this.formatStormTimer(seconds),
      getBlunderbussCrosshairSize: (player) => this.getBlunderbussCrosshairSize(player),
      getClosestGoldHoarder: (player) => this.getClosestGoldHoarder(player),
      getInventoryQty: (ship, item) => this.getInventoryQty(ship, item),
      getLocalPlayer: () => this.getLocalPlayer(),
      getLookInteraction: (player, ship, cannon, section) => this.getLookInteraction(player, ship, cannon, section),
      getPocketWheelCount: (player, slot) => this.getPocketWheelCount(player, slot),
      getStormTimerSeconds: () => this.getStormTimerSeconds(),
      getTrackedShip: () => this.getTrackedShip(),
      getUpgradePresentation: (type) => this.getUpgradePresentation(type),
      playIslandArrivalFanfare: () => this.playIslandArrivalFanfare(),
      renderMapWheel: (player) => this.map.renderMapWheel(player),
      renderTreasureInventoryChart: (player, mapped, hoarder) => this.map.renderTreasureInventoryChart(player, mapped, hoarder),
      returnToLobbyAfterLoss: (kills, gold, reason) => this.returnToLobbyAfterLoss(kills, gold, reason),
      toolWheelSlot: (tool) => this.toolWheelSlot(tool),
    };
  }

  /** Delegate kept so the ~30 existing pushFeed call sites read unchanged. */
  private pushFeed(message: string, color = '#e7e1d4') {
    this.hud.pushFeed(message, color);
  }

  /** Delegates so island/harvest code inside Game keeps its old call shape. */
  private buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale = 1): THREE.Group | null {
    return this.islands.buildPropInstance(type, position, yaw, scale);
  }

  private readonly windWisps = new THREE.Group();
  private readonly mermaidGroup = buildMermaidMesh();
  private mermaidAnchor: { x: number; z: number; shipId: string } | null = null;
  private readonly stormRing = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x587ca5, transparent: true, opacity: 0.58 }),
  );
  private readonly stormWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 120, 72, 1, true),
    new THREE.MeshBasicMaterial({
      map: this.stormWallTexture,
      color: 0x395270,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  private readonly stormHalo = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.05, 8, 64),
    new THREE.MeshBasicMaterial({
      color: 0x25344f,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );

  async init() {
    document.addEventListener('contextmenu', (event) => event.preventDefault());

    this.setLoading(4, 'Hoisting sails...');
    await this.yieldForLoadingPaint();

    this.renderer.init();
    this.setupDebugPerfPanel();
    this.setLoading(8, 'Charting the horizon...');
    await this.yieldForLoadingPaint();

    // Real progress: the GLB prop library is the bulk of boot time. Failures are
    // tolerated inside preload() — missing assets keep their procedural fallbacks.
    await assets.preload((done, total) => {
      this.setLoading(8 + (done / total) * 44, `Loading ship's stores... ${done}/${total}`);
    });
    await this.yieldForLoadingPaint();

    this.setupStormWeatherOverlay();
    this.setupStoryCutsceneOverlay();
    this.bindInteractPromptClick();
    this.localViewWeaponRoot.visible = false;
    this.localViewWeaponRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewWeaponRoot);
    this.setupMuzzleFlash();
    this.localViewHandsRoot.visible = false;
    this.renderer.camera.add(this.localViewHandsRoot);
    this.localViewPocketRoot.visible = false;
    this.localViewPocketRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewPocketRoot);
    // Held-lamp light rides with the view (off until the lantern is equipped),
    // offset to the held hand so it washes the world around the player.
    this.heldLampLight.position.set(0.35, -0.1, -0.5);
    this.renderer.camera.add(this.heldLampLight);
    this.ocean.init(this.renderer.scene, this.renderer.getQuality());
    this.setLoading(56, 'Stirring the deep...');
    await this.yieldForLoadingPaint();

    this.shipRenderer.init(this.renderer.scene, this.renderer.getQuality());
    this.setLoading(62, 'Rigging the brigantine...');
    await this.yieldForLoadingPaint();

    this.combatFx.init(this.renderer.scene);
    this.initLanternSystem();
    this.renderer.scene.add(this.environment);
    this.renderer.scene.add(this.windWisps);
    this.renderer.scene.add(this.mermaidGroup);
    this.mermaidGroup.visible = false;
    this.renderer.scene.add(this.stormRing);
    this.renderer.scene.add(this.stormWall);
    this.renderer.scene.add(this.stormHalo);
    this.initWindWisps();
    this.stormRing.geometry.setAttribute('position', new THREE.BufferAttribute(this.stormRingPositions, 3));
    this.stormRing.position.y = 0.55;
    this.stormRing.frustumCulled = false;
    this.stormWall.position.y = 44;
    this.stormWall.renderOrder = 1;
    this.stormWall.frustumCulled = false;
    this.stormHalo.rotation.x = Math.PI * 0.5;
    this.stormHalo.renderOrder = 2;
    this.stormHalo.frustumCulled = false;
    this.setLoading(68, 'Reading the weather glass...');
    await this.yieldForLoadingPaint();

    this.input.init(this.renderer.renderer.domElement);
    this.bindSupplyWheelActions();
    // Scroll to zoom the opened map (pans to keep the player centred). Bound on
    // window so it catches regardless of the overlay's pointer-events.
    window.addEventListener('wheel', (e) => {
      if (!this.map.mapOpen) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.map.mapZoom = Math.max(1, Math.min(7, this.map.mapZoom * factor));
    }, { passive: false });
    document.body.addEventListener('pointerdown', () => {
      this.combatFx.unlockAudio();
      this.audio.unlock();
    });
    document.body.addEventListener('keydown', () => {
      this.combatFx.unlockAudio();
      this.audio.unlock();
    });
    // Universal UI feedback — anything that's a <button> chirps on click.
    document.body.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, [data-ui-click]')) {
        this.audio.playUiClick();
      }
    }, true);
    this.bindMapUiActions();
    this.bindTradeUiActions();
    this.bindNetworkEvents();

    this.showLoadingScreen('Opening crew waters...', 74);
    await this.yieldForLoadingPaint();
    this.menu.init();
    const connected = await this.connectToServer();
    if (!connected) return;
    // Hide loading, show main menu — the game frame loop still runs for ambient render later.
    this.ui.loadingScreen.classList.add('hidden');
    this.ui.loadingScreen.style.display = 'none';
    this.menu.show();

    requestAnimationFrame((time) => this.frame(time));
  }

  private async connectToServer(): Promise<boolean> {
    const socketUrl = this.getSocketUrl();
    this.setLoading(80, `Connecting to ${socketUrl} ...`);
    await this.yieldForLoadingPaint();
    const connectTimeoutMs = 6_000;
    try {
      await Promise.race([
        this.network.connect(socketUrl),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('connect-timeout')), connectTimeoutMs);
        }),
      ]);
    } catch {
      this.network.disconnect();
      this.setLoading(
        0,
        `Cannot reach game server at ${socketUrl}. Make sure 'npm run dev' is running (server on :8080), then refresh.`,
      );
      return false;
    }
    return true;
  }

  private onMatchStartFromMenu(payload?: MatchStartPayload): void {
    this.resetLocalRoundState();
    this.inMatch = true;
    this.endmatchPending = false;
    this.menu.setLastMatchPartyCode(payload?.partyCode ?? null);
    this.scheduleJoinAssignmentWatchdog();
    this.bindReturnToMenuButtons();
    this.audio.unlock();
    this.audio.playMatchStart();
  }

  private returnToMenuButtonsBound = false;
  private pointerLockHintEl: HTMLElement | null = null;
  private bindReturnToMenuButtons(): void {
    if (this.returnToMenuButtonsBound) return;
    this.returnToMenuButtonsBound = true;
    const handler = () => this.goBackToMenuFromMatch();
    document.getElementById('death-return-btn')?.addEventListener('click', handler);
    document.getElementById('win-return-btn')?.addEventListener('click', handler);
  }

  private onReturnToMenuFromEnd(): void {
    this.inMatch = false;
    this.endmatchPending = false;
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.classList.remove('visible');
    this.ui.winScreen.style.display = 'none';
    document.getElementById('hud')?.classList.remove('visible');
    this.resetLocalRoundState();
  }

  private showLoadingScreen(message: string, percent: number) {
    this.ui.loadingScreen.style.display = 'flex';
    this.ui.loadingScreen.style.opacity = '1';
    this.ui.loadingScreen.style.pointerEvents = 'auto';
    this.setLoading(percent, message);
  }

  private scheduleJoinAssignmentWatchdog() {
    this.clearJoinAssignmentWatchdog();
    this.joinAssignmentWatchdog = window.setTimeout(() => {
      this.joinAssignmentWatchdog = null;
      if (this.localPlayerId != null) return;
      this.setLoading(
        0,
        'Connected but no ship assignment yet. Check the server log or refresh.',
      );
    }, 45_000);
  }

  private clearJoinAssignmentWatchdog() {
    if (this.joinAssignmentWatchdog != null) {
      window.clearTimeout(this.joinAssignmentWatchdog);
      this.joinAssignmentWatchdog = null;
    }
  }

  /** Lets the browser paint `setLoading` before the next long synchronous chunk (main-thread init was freezing the bar). */
  private yieldForLoadingPaint(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  private resetLocalRoundState() {
    this.clearJoinAssignmentWatchdog();
    this.state = null;
    this.localPlayerId = null;
    this.localShipId = null;
    this.playersById.clear();
    this.shipsById.clear();
    this.livePlayerIds.clear();
    this.liveProjectileIds.clear();
    this.liveKegIds.clear();
    this.previousHealth = PLAYER.MAX_HEALTH;
    this.previousKnockback = 0;
    this.previousLocalState = null;
    this.prevIsInsideIsland = null;
    this.activeTradeSessionId = null;
    this.localTradeOffer = [];
    this.map.mapOpen = false;
    this.hitMarkerTimer = 0;
    this.hitMarkerHeadshot = false;
    this.hitMarkerKill = false;
    this.hitMarkerShip = false;
    this.hitMarkerShark = false;
    this.localViewWeaponId = null;
    this.localViewWeaponAmmoSignature = '';
    this.localViewWeaponKick = 0;
    this.localViewWeaponReloadPhase = 0;
    this.localViewPocketKind = null;
    this.pocketUsePreviewKind = null;
    this.pocketUsePreviewTimer = 0;
    this.inputSendTimer = 0;
    this.inputHeartbeatTimer = 0;
    this.lastSentInputSignature = '';
    this.prevAnchored = null;
    this.prevAnchorRaiseProgress = null;
    this.prevSailHeightForAudio = null;
    this.prevSailAngleForAudio = null;
    this.lastSailTrimSoundAt = 0;
    this.lastAnchorMoveSoundAt = 0;
    this.lastHelmTurnSoundAt = 0;
    this.lastHullSplashAt = 0;
    this.lastSwimStrokeAt = 0;
    this.remoteSwimAudioState.clear();
    this.prevPlayerStateForAudio = null;
    this.prevCannonBallistic = false;
    this.prevStormShrinking = false;
    this.prevBucketFilled.clear();
    this.cutlassSwingKind.clear();
    this.prevCutlassSwingProgress = 0;
    this.cutlassDashKick = 0;
    this.lastHullLeakAt = 0;
    this.lastChainshotWhirrAt.clear();
    this.cameraFovKick = 0;
    this.cameraShake = 0;
    this.cameraShakeCannon = 0;
    this.cameraRoll = 0;
    this.prevOwnHullTotal = 4;
    this.prevOwnShipId = null;
    if (this.floodingLoopActive) {
      this.audio.stopFlooding();
      this.floodingLoopActive = false;
    }
    this.ui.waterGauge.classList.remove('visible', 'danger');

    document.getElementById('hud')?.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.style.display = 'none';
    this.ui.tradeUi.style.display = 'none';
    this.ui.mapOverlay.classList.remove('visible');
    this.ui.scopeOverlay.style.display = 'none';
    this.ui.hitMarker.className = '';
    this.ui.killFeed.innerHTML = '';
    this.ui.damageIndicatorLayer.innerHTML = '';
    this.ui.crosshair.className = '';
    this.ui.crosshair.style.removeProperty('--shotgun-spread');
    this.ui.islandBanner.classList.remove('visible');
    this.localViewWeaponRoot.visible = false;
    this.disposeSceneObject(this.localViewWeaponRoot);
    this.localViewWeaponRoot.clear();
    this.localViewPocketRoot.visible = false;
    this.disposeSceneObject(this.localViewPocketRoot);
    this.localViewPocketRoot.clear();

    for (const indicator of this.floatingDamageIndicators) {
      indicator.element.remove();
    }
    this.floatingDamageIndicators.length = 0;

    for (const mesh of this.playerMeshes.values()) {
      this.renderer.scene.remove(mesh);
      this.disposeSceneObject(mesh);
    }
    for (const mesh of this.projectileMeshes.values()) {
      this.renderer.scene.remove(mesh);
      this.disposeSceneObject(mesh);
    }
    for (const record of this.kegMeshes.values()) {
      this.renderer.scene.remove(record.root);
      this.disposeSceneObject(record.root);
    }

    // Free GPU resources from the previous match (geometries/materials/textures).
    // AssetLibrary-owned shared resources are skipped inside disposeSceneObject.
    for (const child of [...this.environment.children]) {
      this.disposeSceneObject(child);
    }
    this.environment.clear();
    this.clearLanternEmitters();
    this.shipRenderer.clear();
    this.islandMeshes.clear();
    this.islandPropInstances.clear();
    this.tavernDoors = [];
    // Promoted harvest clones / mid-fall palms lived inside island groups —
    // already disposed with the environment children above.
    this.harvestPromoted = null;
    this.harvestFalls.length = 0;
    this.prevHarvestChopCycle = 1;
    // Islands still queued from the previous match must not drain into the
    // next one as untracked ghost terrain.
    this.pendingIslandBuilds.length = 0;
    this.volcanicFx = [];
    // disposeSceneObject() disposes this shared particle texture along with the
    // volcanic point clouds (it isn't an AssetLibrary-owned resource), so drop
    // the cache — the next match rebuilds it instead of reusing a disposed one.
    this.softParticleTexture = null;
    this.chestMeshes.clear();
    this.barrelMeshes.clear();
    this.sharkMeshes.clear();
    this.wildlifeMeshes.clear();
    this.seaRockMeshes.clear();
    this.kegMeshes.clear();
    this.upgradeStationMeshes.clear();
    this.npcMeshes.clear();
    this.playerMeshes.clear();
    this.projectileMeshes.clear();
    this.seenStoryNpcIds.clear();
  }

  /**
   * Recursively dispose GPU resources (geometry, materials, textures) of a
   * per-match scene graph. Resources owned by the shared AssetLibrary cache
   * (GLB clones/instances) are skipped — they outlive matches by design.
   */
  private disposeSceneObject(root: THREE.Object3D) {
    root.traverse((obj) => {
      const light = obj as THREE.Light;
      if (light.isLight) {
        light.dispose();
        return;
      }
      const mesh = obj as THREE.Mesh;
      const drawable = mesh as unknown as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
      if (!drawable.isMesh && !drawable.isLine && !drawable.isPoints && !drawable.isSprite) return;
      const instanced = obj as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) instanced.dispose();
      if (mesh.geometry && !assets.isShared(mesh.geometry)) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if (assets.isShared(material)) continue;
        const record = material as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const value = record[key] as { isTexture?: boolean; dispose?: () => void } | null;
          if (value && value.isTexture && typeof value.dispose === 'function' && !assets.isShared(value)) {
            value.dispose();
          }
        }
        material.dispose();
      }
    });
  }

  // ── Harvest destruction: promote-on-chop + real breakdown ─────────────────
  // The instanced palm/boulder under the local axe is swapped for a live GLB
  // clone so each strike can shake it and completion can topple/burst it for
  // real instead of the prop silently zero-scaling away.

  /** Nearest choppable palm/boulder within axe range — the SAME nearest-prop
   *  logic the harvest prompt uses, shared so prompt and promotion agree. */
  private findHarvestTarget(player: Player): { prop: IslandProp; island: Island } | null {
    if (!this.state) return null;
    let bestProp: IslandProp | null = null;
    let bestIsland: Island | null = null;
    let bestD: number = HARVEST.RANGE;
    for (const isl of this.state.islands) {
      if (!isl.props?.length) continue;
      if (!isPointInsideIslandFootprint(isl, player.position.x, player.position.z, 8)) continue;
      for (const prop of isl.props) {
        if (!prop.type.startsWith('palm_') && !prop.type.startsWith('boulder_')) continue;
        const d = this.distance2D(player.position.x, player.position.z, prop.x, prop.z);
        if (d < bestD) {
          bestD = d;
          bestProp = prop;
          bestIsland = isl;
        }
      }
    }
    return bestProp && bestIsland ? { prop: bestProp, island: bestIsland } : null;
  }

  /** Live clone of an instanced prop at its exact registry transform, parented
   *  into the island group (same space the InstancedMesh slots live in). */
  private buildHarvestClone(island: Island, prop: IslandProp): THREE.Object3D | null {
    const slot = prop.id !== undefined ? this.islandPropInstances.get(island.id)?.get(prop.id) : undefined;
    const parent = slot?.inst.parent ?? this.islandMeshes.get(island.id);
    if (!parent) return null;
    const node = this.buildPropInstance(
      prop.type as AssetName,
      new THREE.Vector3(prop.x - island.position.x, getPropGroundY(island, prop), prop.z - island.position.z),
      prop.yaw,
      prop.scale,
    );
    if (!node) return null;
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    parent.add(node);
    return node;
  }

  /** Swap the instance for a live clone: zero the instance slot (keeping its
   *  matrix for a clean demote) and stand the clone at the same transform. */
  private promoteHarvestProp(island: Island, prop: IslandProp) {
    if (prop.id === undefined) return;
    const slot = this.islandPropInstances.get(island.id)?.get(prop.id);
    if (!slot) return;
    const node = this.buildHarvestClone(island, prop);
    if (!node) return;
    const savedMatrix = new THREE.Matrix4();
    slot.inst.getMatrixAt(slot.index, savedMatrix);
    slot.inst.setMatrixAt(slot.index, ZERO_SCALE_MAT4);
    slot.inst.instanceMatrix.needsUpdate = true;
    this.harvestPromoted = {
      islandId: island.id,
      propId: prop.id,
      type: prop.type,
      node,
      savedMatrix,
      basePos: node.position.clone(),
      height: new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y,
      shakeTimer: 0,
      shakeSeed: 0,
    };
  }

  /** Chop abandoned before completion: restore the instance matrix, drop the clone. */
  private demotePromotedHarvestProp() {
    const promoted = this.harvestPromoted;
    if (!promoted) return;
    this.harvestPromoted = null;
    const slot = this.islandPropInstances.get(promoted.islandId)?.get(promoted.propId);
    if (slot) {
      slot.inst.setMatrixAt(slot.index, promoted.savedMatrix);
      slot.inst.instanceMatrix.needsUpdate = true;
    }
    promoted.node.removeFromParent();
    this.disposeSceneObject(promoted.node);
  }

  /** Start a felled palm's topple: away from the harvester when known, else a
   *  random lean. The node animates in updateHarvestDestruction. */
  private beginPalmTopple(node: THREE.Object3D, byPlayerId: string | undefined) {
    node.getWorldPosition(this.tempHarvestVec);
    const baseWorld = this.tempHarvestVec.clone();
    const harvester = byPlayerId ? this.playersById.get(byPlayerId) : undefined;
    let dirX = harvester ? baseWorld.x - harvester.position.x : 0;
    let dirZ = harvester ? baseWorld.z - harvester.position.z : 0;
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.3) {
      const theta = Math.random() * Math.PI * 2;
      dirX = Math.cos(theta);
      dirZ = Math.sin(theta);
    } else {
      dirX /= len;
      dirZ /= len;
    }
    const height = new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y;
    this.harvestFalls.push({
      node,
      age: 0,
      baseYaw: node.rotation.y,
      fallDirX: dirX,
      fallDirZ: dirZ,
      trunkHeight: Math.max(1.5, height),
      baseLocalY: node.position.y,
      baseWorld,
      impactFired: false,
      fadeMats: null,
    });
  }

  /** Fade prep for the sink phase: clone every material (the GLB library ones
   *  are shared) so opacity can animate; clones are disposed with the node. */
  private makeHarvestNodeFadable(node: THREE.Object3D): THREE.Material[] {
    const mats: THREE.Material[] = [];
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;
      const swap = (material: THREE.Material) => {
        const clone = material.clone();
        clone.transparent = true;
        mats.push(clone);
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    return mats;
  }

  /** Per-frame driver: promote/demote the live chop target, pulse strike FX on
   *  the 1.4Hz swing beat, and play out palm topples. */
  private updateHarvestDestruction(dt: number) {
    const player = this.getLocalPlayer();
    const chopping = !!player
      && player.equippedTool === 'axe'
      && player.state === 'alive'
      && !player.carryingChestId
      && this.input.isFiring();
    const target = chopping && player ? this.findHarvestTarget(player) : null;
    this.harvestTargetActive = !!target;

    if (!target || target.prop.id === undefined) {
      this.demotePromotedHarvestProp();
    } else if (
      !this.harvestPromoted
      || this.harvestPromoted.islandId !== target.island.id
      || this.harvestPromoted.propId !== target.prop.id
    ) {
      this.demotePromotedHarvestProp();
      this.promoteHarvestProp(target.island, target.prop);
    }

    // Strike beat — same clock as the axe viewmodel + playAxeChop (beat at 0.75).
    const chopCycle = (this.ocean.getTime() * 1.4) % 1;
    const struck = chopping && chopCycle >= 0.75 && this.prevHarvestChopCycle < 0.75;
    this.prevHarvestChopCycle = chopping ? chopCycle : 1;

    const promoted = this.harvestPromoted;
    if (promoted && player) {
      const isPalm = promoted.type.startsWith('palm_');
      if (struck) {
        promoted.shakeTimer = 0.3;
        promoted.shakeSeed = Math.random() * Math.PI * 2;
        // Strike point: trunk/face height, nudged toward the axe wielder.
        promoted.node.getWorldPosition(this.tempHarvestVec);
        const toX = player.position.x - this.tempHarvestVec.x;
        const toZ = player.position.z - this.tempHarvestVec.z;
        const toLen = Math.hypot(toX, toZ) || 1;
        this.tempHarvestVec.x += (toX / toLen) * 0.4;
        this.tempHarvestVec.z += (toZ / toLen) * 0.4;
        if (isPalm) {
          this.tempHarvestVec.y += 1.1;
          this.combatFx.emitWoodChips(this.tempHarvestVec);
          // Frond shiver at the crown.
          this.tempHarvestVec.x -= (toX / toLen) * 0.4;
          this.tempHarvestVec.z -= (toZ / toLen) * 0.4;
          this.tempHarvestVec.y += promoted.height - 1.4;
          this.combatFx.emitLeafPuff(this.tempHarvestVec);
        } else {
          this.tempHarvestVec.y += Math.min(0.7, promoted.height * 0.5);
          this.combatFx.emitStoneChips(this.tempHarvestVec);
        }
      }
      // Strike impulse: palms whip at the trunk, boulders jitter in place.
      const node = promoted.node;
      if (promoted.shakeTimer > 0) {
        promoted.shakeTimer = Math.max(0, promoted.shakeTimer - dt);
        const k = promoted.shakeTimer / 0.3;
        const wobble = Math.sin((0.3 - promoted.shakeTimer) * 42 + promoted.shakeSeed) * 0.04 * k * k;
        if (isPalm) {
          node.rotation.x = wobble * Math.cos(promoted.shakeSeed);
          node.rotation.z = wobble * Math.sin(promoted.shakeSeed);
        } else {
          node.position.x = promoted.basePos.x + wobble * 0.55;
          node.position.z = promoted.basePos.z + wobble * 0.4;
        }
      } else {
        node.rotation.x = 0;
        node.rotation.z = 0;
        node.position.copy(promoted.basePos);
      }
    }

    // Palm topple playback: ease-in fall (gravity feel) → damped bounce at
    // ~85° → sink 1.5m + fade → gone.
    const TOPPLE = 1.1;
    const BOUNCE = 0.35;
    const SINK = 0.7;
    const FALL_ANGLE = 1.484; // ~85°
    for (let index = this.harvestFalls.length - 1; index >= 0; index--) {
      const fall = this.harvestFalls[index];
      fall.age += dt;
      const node = fall.node;
      let tilt: number;
      if (fall.age < TOPPLE) {
        const t = fall.age / TOPPLE;
        tilt = FALL_ANGLE * t * t * (0.4 + 0.6 * t); // accelerating lean
      } else {
        const s = fall.age - TOPPLE;
        tilt = FALL_ANGLE - Math.abs(Math.sin(s * 16)) * 0.06 * Math.exp(-s * 7);
        if (!fall.impactFired) {
          fall.impactFired = true;
          // Crown slams down trunkHeight out along the fall direction.
          this.tempHarvestVec.set(
            fall.baseWorld.x + fall.fallDirX * fall.trunkHeight * 0.9,
            fall.baseWorld.y + 0.3,
            fall.baseWorld.z + fall.fallDirZ * fall.trunkHeight * 0.9,
          );
          this.combatFx.emitLeafPuff(this.tempHarvestVec, 10);
          this.combatFx.emitTreeFallImpact(this.tempHarvestVec, fall.baseWorld.y);
          this.audio.playTreeFallThud(this.renderer.camera.position.distanceTo(this.tempHarvestVec));
        }
      }
      // Tip about the base: tilt axis ⊥ fall direction, composed over the yaw.
      this.tempHarvestVec.set(fall.fallDirZ, 0, -fall.fallDirX);
      this.tempHarvestQuatA.setFromAxisAngle(this.tempHarvestVec, tilt);
      this.tempHarvestVec.set(0, 1, 0);
      this.tempHarvestQuatB.setFromAxisAngle(this.tempHarvestVec, fall.baseYaw);
      node.quaternion.multiplyQuaternions(this.tempHarvestQuatA, this.tempHarvestQuatB);
      if (fall.age >= TOPPLE + BOUNCE) {
        const sinkT = Math.min(1, (fall.age - TOPPLE - BOUNCE) / SINK);
        if (!fall.fadeMats) fall.fadeMats = this.makeHarvestNodeFadable(node);
        node.position.y = fall.baseLocalY - 1.5 * sinkT;
        for (const material of fall.fadeMats) material.opacity = 1 - sinkT;
        if (sinkT >= 1) {
          node.removeFromParent();
          this.disposeSceneObject(node);
          this.harvestFalls.splice(index, 1);
        }
      }
    }
  }

  // ── Island lantern / campfire warm-light budget ──────────────────────────
  // Shared point-light pools (added once, reused across matches) plus per-emitter
  // additive glow / flame sprites. The nearest N of each kind are lit for real at
  // night; everything else is a cheap sprite. See updateLanterns().
  private initLanternSystem() {
    this.lanternGlowTexture = makeLanternGlowTexture();
    this.lanternFlameTexture = makeLanternFlameTexture();
    for (let i = 0; i < 6; i++) {
      const light = new THREE.PointLight(0xffb257, 0, 24, 1.6);
      light.visible = false;
      this.lanternRoot.add(light);
      this.lanternLightPool.push(light);
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xff7a30, 0, 21, 1.5);
      light.visible = false;
      this.lanternRoot.add(light);
      this.campfireLightPool.push(light);
    }
    this.renderer.scene.add(this.lanternRoot);
  }

  /** Register a warm island light. `container` is an island sub-group (dock/camp/
   *  tavern/cave); the anchor tracks its transform so world positions stay correct. */
  private registerLanternEmitter(
    container: THREE.Object3D,
    localX: number,
    localY: number,
    localZ: number,
    kind: 'lantern' | 'campfire',
  ) {
    if (!this.lanternGlowTexture) return;
    const anchor = new THREE.Object3D();
    anchor.position.set(localX, localY, localZ);
    container.add(anchor);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.lanternGlowTexture,
      color: kind === 'campfire' ? 0xff8a3c : 0xffbb66,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    }));
    glow.scale.setScalar(kind === 'campfire' ? 3.4 : 2.1);
    glow.visible = false;
    this.lanternRoot.add(glow);

    let flame: THREE.Sprite | null = null;
    if (kind === 'campfire' && this.lanternFlameTexture) {
      flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.lanternFlameTexture,
        color: 0xffb257,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }));
      flame.center.set(0.5, 0.08); // pivot near the base so it grows upward
      flame.scale.set(0.5, 0.9, 1);
      this.lanternRoot.add(flame);
    }

    this.lanternEmitters.push({
      anchor, kind, glow, flame,
      worldPos: new THREE.Vector3(),
      dist: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  private updateLanterns(nf: number, cameraPos: THREE.Vector3, t: number) {
    if (this.lanternEmitters.length === 0) return;
    const day = nf <= 0.02;

    for (const e of this.lanternEmitters) {
      e.anchor.getWorldPosition(e.worldPos);
      e.dist = e.worldPos.distanceTo(cameraPos);
    }

    const lanterns = this.lanternEmitters.filter((e) => e.kind === 'lantern');
    const campfires = this.lanternEmitters.filter((e) => e.kind === 'campfire');
    this.assignLanternBudget(lanterns, this.assignedLanterns, this.lanternLightPool.length);
    this.assignLanternBudget(campfires, this.assignedCampfires, this.campfireLightPool.length);

    for (let i = 0; i < this.lanternLightPool.length; i++) {
      const light = this.lanternLightPool[i];
      const e = this.assignedLanterns[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 7.3 + e.phase) * 0.05 + Math.sin(t * 13.7 + e.phase * 1.7) * 0.03;
        light.position.copy(e.worldPos);
        light.intensity = nf * 2.1 * flicker;
        light.visible = true;
      }
    }
    for (let i = 0; i < this.campfireLightPool.length; i++) {
      const light = this.campfireLightPool[i];
      const e = this.assignedCampfires[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 11 + e.phase) * 0.24 + Math.sin(t * 23 + e.phase * 2.1) * 0.14 + (Math.random() - 0.5) * 0.08;
        light.position.copy(e.worldPos);
        light.intensity = nf * 2.5 * Math.max(0.25, flicker);
        light.visible = true;
      }
    }

    for (const e of this.lanternEmitters) {
      const hasRealLight = e.kind === 'lantern'
        ? this.assignedLanterns.includes(e)
        : this.assignedCampfires.includes(e);
      const glowFlicker = e.kind === 'campfire'
        ? 1 + Math.sin(t * 12 + e.phase) * 0.18
        : 1 + Math.sin(t * 6 + e.phase) * 0.06;
      const glowBase = hasRealLight ? 0.3 : 0.85;
      const glowOpacity = day ? 0 : nf * glowBase * glowFlicker;
      e.glow.position.copy(e.worldPos);
      e.glow.material.opacity = glowOpacity;
      e.glow.visible = glowOpacity > 0.01;

      if (e.flame) {
        // A lit campfire always shows a small flame; it grows and brightens at night.
        const flick = 0.85 + Math.sin(t * 15 + e.phase) * 0.12 + Math.sin(t * 27 + e.phase * 1.9) * 0.07;
        e.flame.position.copy(e.worldPos);
        e.flame.scale.set(0.4 * (0.92 + (flick - 0.85) * 0.5), (0.5 + nf * 0.5) * flick, 1);
        e.flame.material.opacity = (0.5 + nf * 0.42) * flick;
        e.flame.visible = true;
      }
    }
  }

  /** Fill the light budget from the nearest emitters, with 15%-closer hysteresis so
   *  the active set doesn't pop as the camera drifts between equidistant sources. */
  private assignLanternBudget(emitters: LanternEmitter[], assigned: LanternEmitter[], budget: number) {
    for (let i = assigned.length - 1; i >= 0; i--) {
      if (!emitters.includes(assigned[i])) assigned.splice(i, 1);
    }
    while (assigned.length < budget) {
      let best: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!best || e.dist < best.dist) best = e;
      }
      if (!best) break;
      assigned.push(best);
    }
    for (let guard = 0; guard <= budget; guard++) {
      let furthest: LanternEmitter | null = null;
      for (const e of assigned) if (!furthest || e.dist > furthest.dist) furthest = e;
      let nearestOut: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!nearestOut || e.dist < nearestOut.dist) nearestOut = e;
      }
      if (furthest && nearestOut && nearestOut.dist < furthest.dist * 0.85) {
        assigned[assigned.indexOf(furthest)] = nearestOut;
      } else {
        break;
      }
    }
  }

  private clearLanternEmitters() {
    for (const e of this.lanternEmitters) {
      this.lanternRoot.remove(e.glow);
      e.glow.material.dispose();
      if (e.flame) {
        this.lanternRoot.remove(e.flame);
        e.flame.material.dispose();
      }
    }
    this.lanternEmitters.length = 0;
    this.assignedLanterns.length = 0;
    this.assignedCampfires.length = 0;
    for (const light of this.lanternLightPool) { light.visible = false; light.intensity = 0; }
    for (const light of this.campfireLightPool) { light.visible = false; light.intensity = 0; }
  }

  private returnToLobbyAfterLoss(kills: number, gold: number, reason = 'Defeated') {
    // In multiplayer mode: don't disconnect or auto-respawn. Show the death screen
    // with a "Return to Port" button. The server-side match_ended will deliver the
    // full leaderboard when (or if) the round actually ends.
    this.ui.deathStats.innerHTML = `<div>${reason}</div><div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.ui.deathScreen.classList.add('visible');
    this.ui.deathScreen.style.display = 'flex';
  }

  private goBackToMenuFromMatch(): void {
    this.network.returnToMenu();
    this.inMatch = false;
    this.endmatchPending = false;
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.classList.remove('visible');
    this.ui.winScreen.style.display = 'none';
    document.getElementById('hud')?.classList.remove('visible');
    this.menu.hideEndmatch();
    this.menu.show();
    this.resetLocalRoundState();
  }

  private bindMapUiActions() {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      // Don't toggle the map while typing (menu name field) or before a match.
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

      if (event.code === 'KeyM' && this.inMatch) {
        this.toggleMap();
      } else if (event.code === 'Escape' && this.map.mapOpen) {
        this.toggleMap(false);
      }
    });
  }

  private bindSupplyWheelActions() {
    for (const slice of this.ui.pocketWheel.querySelectorAll<SVGPathElement>('[data-wheel-slot]')) {
      slice.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.activateWheelSlot(Number(slice.dataset.wheelSlot));
      });
    }
    // Radial select: while the wheel is open, the mouse angle from the hub picks
    // a slot (highlighted); releasing [I] over it activates it — the SoT feel.
    const svgEl = this.ui.pocketWheel.querySelector<SVGSVGElement>('#pocket-wheel-svg');
    window.addEventListener('mousemove', (e) => {
      if (!this.input.isSupplyWheelOpen() || !svgEl) { this.wheelHoverSlot = null; return; }
      const rect = svgEl.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width * 0.5);
      const dy = e.clientY - (rect.top + rect.height * 0.5);
      // Inside the hub dead-zone (r≈26 of the 200-unit viewBox) selects nothing.
      if (Math.hypot(dx, dy) < rect.width * 0.13) { this.wheelHoverSlot = null; return; }
      let ang = Math.atan2(dx, -dy); // clockwise from the top (slot 0)
      if (ang < 0) ang += Math.PI * 2;
      this.wheelHoverSlot = Math.round(ang / (Math.PI * 2 / 10)) % 10; // 10-slice wheel
    });
  }

  /** Use/equip a supply-wheel slot (shared by click and hover-release). */
  private activateWheelSlot(slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return;
    const local = this.getLocalPlayer();
    if (local?.carryingChestId) return;
    if (this.pocketUsePreviewTimer > 0) return;
    this.input.queueWheelSlot(slot);
    this.startPocketUsePreview(slot);
  }

  /** On the frame the wheel closes, activate whatever slot was hovered. */
  private updateWheelRelease() {
    const open = this.input.isSupplyWheelOpen();
    if (this.wheelWasOpen && !open && this.wheelHoverSlot !== null) {
      this.activateWheelSlot(this.wheelHoverSlot);
    }
    if (!open) this.wheelHoverSlot = null;
    this.wheelWasOpen = open;
  }

  private bindNetworkEvents() {
    this.network.onJoin = (playerId, shipId, snapshot) => {
      this.clearJoinAssignmentWatchdog();
      this.localPlayerId = playerId;
      this.localShipId = shipId;
      this.previousHealth = PLAYER.MAX_HEALTH;
      this.applySnapshot(snapshot);
      // Dev: ?peace makes solo bots leave you (and your ship) alone from the start.
      if (new URLSearchParams(window.location.search).has('peace')) {
        this.network.sendDevBotPeace(true);
      }
      this.setLoading(100, 'Battle underway');
      window.setTimeout(() => {
        this.ui.loadingScreen.style.opacity = '0';
        this.ui.loadingScreen.style.pointerEvents = 'none';
      }, 200);
      window.setTimeout(() => {
        this.ui.loadingScreen.style.display = 'none';
        document.getElementById('hud')?.classList.add('visible');
      }, 650);
    };

    this.network.onPlayerDowned = (payload) => {
      const isMe = payload.playerId === this.localPlayerId;
      const byWho = payload.attackerName ? ` by ${payload.attackerName}` : '';
      this.pushFeed(
        isMe ? `You were downed${byWho} — a crewmate can revive you!` : `${payload.playerName} was downed${byWho}`,
        isMe ? '#ff8a7a' : '#e0b090',
      );
    };
    this.network.onReviveComplete = (payload) => {
      const isMe = payload.playerId === this.localPlayerId;
      const byWho = payload.reviverName ? ` by ${payload.reviverName}` : '';
      this.pushFeed(
        isMe ? `You were revived${byWho}!` : `${payload.playerName} was revived${byWho}`,
        '#7ce38b',
      );
    };
    this.network.onHotSnapshot = (hot) => {
      this.applyHotSnapshot(hot);
    };
    this.network.onSnapshot = (snapshot) => {
      this.applySnapshot(snapshot);
    };

    this.network.onPlayerHit = (payload) => {
      const hitPayload = payload as {
        damage?: number;
        position?: { x: number; y: number; z: number };
        sourcePosition?: { x: number; y: number; z: number };
        headshot?: boolean;
        kill?: boolean;
        weaponId?: WeaponId | string;
        targetType?: 'player' | 'shark' | 'wildlife';
        incoming?: boolean;
        attackerName?: string;
        blocked?: boolean;
        meat?: number;
      meatType?: string;
      };
      if (hitPayload.blocked) {
        // A parried swing — steel on steel, not a wound. The clang IS the
        // feedback that the guard worked (both for the blocker and attacker).
        this.audio.playSwordBlock();
        if (hitPayload.incoming) {
          this.pushFeed(`Blocked ${hitPayload.attackerName?.trim() || 'an enemy'}'s swing.`, '#9fc7e8');
        } else if (hitPayload.position) {
          this.spawnFloatingDamageIndicator('BLOCKED', hitPayload.position, { weaponLabel: 'parried' });
        }
        if ((hitPayload.damage ?? 0) <= 0) return;
      }
      if (hitPayload.incoming) {
        this.handleIncomingHit(hitPayload);
        this.audio.playPlayerHurt(hitPayload.damage ?? 10);
      } else {
        this.handleCombatHit(hitPayload);
        if (hitPayload.kill) {
          this.audio.playKill();
        } else {
          this.audio.playHitMarker(Boolean(hitPayload.headshot));
        }
      }
    };

    this.network.onShipHit = (payload) => {
      this.handleCombatHit(payload as {
        damage?: number;
        position?: { x: number; y: number; z: number };
        kill?: boolean;
        remainingHull?: number;
        shipHealthMilestone?: 'half' | 'critical' | null;
      }, true);
    };

    this.network.onShipDamage = (payload) => {
      // Broadcast to everyone in range: victims and bystanders see the hit
      // splinter where the ball actually struck ('ship_hit' stays the
      // attacker-only confirm with hitmarker + sound).
      const hit = payload as { attackerId?: string | null; position?: { x: number; y: number; z: number }; projectileType?: string };
      if (!hit.position || hit.attackerId === this.localPlayerId) return;
      this.combatFx.emitShipHitConfirm(hit.position, this.renderer.camera.position);
      // Physical wood-smash layer (the confirm chime alone reads as a UI blip).
      const cam = this.renderer.camera.position;
      const d = Math.hypot(hit.position.x - cam.x, hit.position.y - cam.y, hit.position.z - cam.z);
      if (d < 200) this.audio.playHullImpact(d);
    };

    this.network.onShipImpact = (payload) => {
      // A ship physically crashed (ram / aground / sea-rock) — play the spatial
      // hull-smash so a wreck actually sounds like one.
      const ev = payload as { kind?: 'ram' | 'ground' | 'rock'; position?: { x: number; y: number; z: number }; speed?: number };
      if (!ev.position || !ev.kind) return;
      const cam = this.renderer.camera.position;
      const d = Math.hypot(ev.position.x - cam.x, ev.position.y - cam.y, ev.position.z - cam.z);
      if (d > 240) return;
      this.audio.playShipImpact(ev.kind, ev.speed ?? 4, d);
    };

    this.network.onKillEvent = (payload) => {
      const event = payload as {
        killerId?: string | null;
        victimName?: string;
        killerName?: string | null;
        respawning?: boolean;
        headshot?: boolean;
        boardingKill?: boolean;
        shipSink?: boolean;
        stolenGold?: number;
        killGold?: number;
        headshotGold?: number;
        killerStreak?: number;
        streakReward?: { type?: string; label?: string } | null;
      };
      if (event.killerName && event.victimName) {
        const details = [
          event.headshot ? 'headshot' : '',
          event.boardingKill ? 'boarding raid' : '',
          event.shipSink ? 'ship sunk' : '',
          event.killerStreak && event.killerStreak > 1 ? `${event.killerStreak} streak` : '',
          event.killGold ? `+${event.killGold} kill gold` : '',
          event.headshotGold ? `+${event.headshotGold} headshot` : '',
          event.stolenGold ? `+${event.stolenGold} stolen` : '',
        ].filter(Boolean).join(' · ');
        this.pushFeed(
          `${event.killerName} ${event.shipSink ? 'sank' : 'dropped'} ${event.victimName}${details ? ` (${details})` : ''}${event.respawning ? ', but they will respawn.' : '.'}`,
        );
        if (event.killerId === this.localPlayerId && event.streakReward?.label) {
          this.pushFeed(`${event.streakReward.label}.`, '#7fe7ff');
        }
      } else {
        this.pushFeed(event.victimName ? `${event.victimName} went under.` : 'A pirate was eliminated.');
      }
    };

    this.network.onKegExploded = (payload) => {
      const event = payload as { position?: { x: number; y: number; z: number }; mega?: boolean };
      if (event.position) {
        this.combatFx.emitKegExplosion(event.position, this.renderer.camera.position);
        if (event.mega) {
          this.combatFx.emitKegExplosion(
            { x: event.position.x, y: event.position.y + 0.7, z: event.position.z },
            this.renderer.camera.position,
          );
          this.pushFeed('Mega keg detonated for 5x ship damage.', '#ff9d6f');
        }
      }
    };

    this.network.onChestOpened = (payload) => {
      const event = payload as { action?: string; value?: number; loot?: Array<{ item: string; qty: number }> };
      if (event.action === 'pickup') {
        this.pushFeed(`Chest taken: base ${event.value ?? 0} gold, Hoarders pay more.`, '#d9c17e');
        // The carryingChestId edge-detector also fires for the local player; this covers other crew.
        return;
      }
      if (event.action === 'stow') {
        this.pushFeed(`Chest stowed aboard: base ${event.value ?? 0} gold before Hoarder payout.`, '#d9c17e');
        return;
      }
      if (event.action === 'drop') {
        this.pushFeed(`Chest dropped: base ${event.value ?? 0} gold.`, '#d9c17e');
        return;
      }
      const loot = (event.loot ?? [])
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      this.pushFeed(loot ? `Treasure seized: ${loot}` : 'Treasure chest opened.', '#d9c17e');
      this.audio.playChestOpen();
    };

    this.network.onBarrelOpened = (payload) => {
      const event = payload as {
        playerId?: string;
        barrelId?: string;
        loot?: Array<{ item: string; qty: number }>;
        taken?: boolean;
      };
      const isLocal = event.playerId === this.localPlayerId;
      const loot = (event.loot ?? []).map((entry) => ({ item: entry.item as ItemStack['item'], qty: entry.qty }));
      if (isLocal) {
        if (event.taken) {
          // Player committed — close the panel
          this.barrelBrowse = null;
        } else if (event.barrelId) {
          // Browsing — show the side-by-side panel
          this.barrelBrowse = { barrelId: event.barrelId, loot, lastEventAt: performance.now() };
        }
      }
      const summary = loot
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      const verb = event.taken ? 'Took' : 'Inspecting';
      this.pushFeed(summary ? `${verb} barrel: ${summary}` : `${verb} barrel.`, '#9ec0e5');
    };

    this.network.onShipUpgraded = (payload) => {
      const event = payload as { shipId?: string; type?: ShipUpgradeType };
      if (!event.type) return;
      const meta = this.getUpgradePresentation(event.type);
      const isOwn = event.shipId === this.localShipId;
      const subject = isOwn ? 'Your ship claimed' : 'A crew claimed';
      this.pushFeed(`${subject} ${meta.name}.`, meta.color);
      if (isOwn) this.audio.playUpgradeBought();
    };

    this.network.onPropRemoved = (payload) => {
      const event = payload as {
        islandId?: string; propId?: number; propType?: string;
        byPlayerId?: string; byPlayerName?: string; wood?: number; ore?: number;
      };
      if (!event.islandId || event.propId === undefined) return;
      const island = this.state?.islands.find((i) => i.id === event.islandId);
      // Look the prop up BEFORE the splice below — the breakdown clone and the
      // pickup text both need its transform.
      const prop = island?.props?.find((p) => p.id === event.propId);
      const propType = event.propType ?? prop?.type;
      // Consume the promoted clone (if the LOCAL axe was working this prop) —
      // it becomes the breakdown actor; its saved matrix must never restore.
      let liveNode: THREE.Object3D | null = null;
      if (this.harvestPromoted
        && this.harvestPromoted.islandId === event.islandId
        && this.harvestPromoted.propId === event.propId) {
        liveNode = this.harvestPromoted.node;
        liveNode.rotation.x = 0;
        liveNode.rotation.z = 0;
        liveNode.position.copy(this.harvestPromoted.basePos);
        this.harvestPromoted = null;
      }
      const slot = this.islandPropInstances.get(event.islandId)?.get(event.propId);
      if (slot) {
        // Collapse the instance to zero scale — far cheaper than rebuilding
        // the whole island batch for one felled palm / cracked boulder.
        slot.inst.setMatrixAt(slot.index, ZERO_SCALE_MAT4);
        slot.inst.instanceMatrix.needsUpdate = true;
      }
      // Real breakdown — palms topple, boulders burst. Spawn the clone
      // just-in-time when another player harvested so EVERYONE sees it.
      if (island && propType?.startsWith('palm_')) {
        if (!liveNode && prop) liveNode = this.buildHarvestClone(island, prop);
        if (liveNode) this.beginPalmTopple(liveNode, event.byPlayerId);
      } else if (island && propType?.startsWith('boulder_')) {
        if (liveNode) {
          liveNode.getWorldPosition(this.tempHarvestVec);
          liveNode.removeFromParent();
          this.disposeSceneObject(liveNode);
          this.combatFx.emitRockShatter(this.tempHarvestVec, this.tempHarvestVec.y);
        } else if (prop) {
          const groundY = island.position.y + getPropGroundY(island, prop);
          this.tempHarvestVec.set(prop.x, groundY + 0.4 * prop.scale, prop.z);
          this.combatFx.emitRockShatter(this.tempHarvestVec, groundY);
        }
      }
      // Keep the client's static-world copy honest until the next rare
      // island resync (harvest prompts must not target a removed prop).
      if (island?.props) {
        const idx = island.props.findIndex((p) => p.id === event.propId);
        if (idx >= 0) island.props.splice(idx, 1);
      }
      // Local harvests get a floating pickup number at the stump; everyone
      // else keeps the feed line.
      const localHarvest = !!event.byPlayerId && event.byPlayerId === this.localPlayerId;
      const pickupPos = island && prop
        ? { x: prop.x, y: island.position.y + getPropGroundY(island, prop) + 1.5, z: prop.z }
        : null;
      if ((event.wood ?? 0) > 0) {
        if (localHarvest && pickupPos) this.spawnFloatingDamageIndicator(`+${event.wood} wood`, pickupPos, { pickup: true });
        else this.pushFeed(`+${event.wood} wood — palm felled`, '#d7b48a');
        // Trunk CRACK at the fell moment; the ground thud follows at topple impact.
        this.audio.playWoodPlank();
      }
      if ((event.ore ?? 0) > 0) {
        if (localHarvest && pickupPos) this.spawnFloatingDamageIndicator(`+${event.ore} ore`, pickupPos, { pickup: true });
        else this.pushFeed(`+${event.ore} ore — boulder cracked`, '#9ec0e5');
        this.audio.playDigStrike();
      }
    };

    this.network.onTreasureSold = (payload) => {
      const event = payload as {
        playerName?: string;
        playerId?: string;
        gold?: number;
        questBonus?: boolean;
        totalGold?: number;
        islandName?: string;
      };
      const seller = event.playerName ?? 'A pirate';
      const bonus = event.questBonus ? ' with map bonus' : '';
      this.pushFeed(
        `${seller} sold a chest${bonus} for ${event.gold ?? 0} gold (${event.totalGold ?? 0}/${ECONOMY.GOLD_WIN_TARGET}).`,
        '#f0c86a',
      );
      if (event.playerId === this.localPlayerId || (event.playerName && this.getLocalPlayer()?.name === event.playerName)) {
        this.audio.playGoldEarn();
      }
    };

    this.network.onArmorBought = (payload) => {
      const event = payload as { price?: number; armor?: number };
      this.pushFeed(`Iron Cuirass fitted — +${event.armor ?? PLAYER.MAX_ARMOR} armor (${event.price ?? ECONOMY.ARMOR_PRICE}g).`, '#67b9ff');
      this.audio.playUpgradeBought();
    };

    this.network.onTreasureMap = (payload) => {
      const event = payload as { islandName?: string; chestCount?: number };
      this.pushFeed(
        `Gold Hoarder chart: ${event.islandName ?? 'unknown island'} (${event.chestCount ?? 0} X marks).`,
        '#d9c17e',
      );
      if (this.map.mapOpen) this.map.drawMaps();
    };

    this.network.onAmmoRefilled = () => {
      this.pushFeed('Ammo chest — every firearm topped up.', '#9fd18a');
      this.audio.playRepairSequence();
    };

    this.network.onTradeRequest = () => {
      this.pushFeed('Parley signaled between nearby ships.', '#8bc2d7');
    };
    this.network.onTradeUpdate = () => {
      if (this.state) this.syncTradeUi(this.state);
    };
    this.network.onTradeResult = (payload) => {
      const result = payload as { type?: string };
      const label =
        result.type === 'trade_completed' ? 'Trade completed.' :
        result.type === 'trade_betrayed' ? 'Parley broken.' :
        result.type === 'trade_timeout' ? 'Trade offer timed out.' :
        'Trade cancelled.';
      this.pushFeed(label, '#8bc2d7');
      if (this.state) this.syncTradeUi(this.state);
    };

    this.network.onGameOver = (payload) => {
      const result = payload as { died?: boolean; winnerId?: string | null; kills?: number; gold?: number; reason?: string; targetGold?: number };
      const player = this.getLocalPlayer();
      if (result.died) {
        this.audio.playDefeat();
        this.returnToLobbyAfterLoss(result.kills ?? player?.kills ?? 0, result.gold ?? player?.gold ?? 0, 'Crew lost');
      } else if (result.winnerId && result.winnerId === this.localPlayerId) {
        this.audio.playVictory();
        this.hud.showVictory(player?.kills ?? 0, result.gold ?? player?.gold ?? 0);
      } else {
        this.audio.playDefeat();
        const reason = result.reason === 'gold'
          ? `Enemy reached ${result.targetGold ?? ECONOMY.GOLD_WIN_TARGET} gold`
          : 'Crew lost';
        this.returnToLobbyAfterLoss(player?.kills ?? 0, player?.gold ?? 0, reason);
      }
    };

    this.network.onPlayerSpawned = (payload) => {
      const event = payload as { playerId?: string; mermaid?: boolean };
      if (event.playerId === this.localPlayerId) {
        this.ui.deathScreen.style.display = 'none';
        if (event.mermaid) {
          this.mermaidAnchor = null;
          if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
          this.pushFeed('The mermaid returned you to your ship.', '#8bc2d7');
        }
      }
    };

    this.network.onMatchEnded = (payload) => {
      const result = payload as {
        winnerId: string | null;
        winnerName: string | null;
        reason: string;
        humans: Array<{ playerId: string; name: string; kills: number; deaths: number; gold: number; placement: number; isWinner: boolean }>;
      };
      this.endmatchPending = true;
      const youId = this.localPlayerId;
      const youRow = result.humans.find((r) => r.playerId === youId);
      const won = !!result.winnerId && result.winnerId === youId;
      const subtitle = result.reason === 'gold'
        ? `${result.winnerName ?? 'A pirate'} amassed enough gold`
        : result.reason === 'last_ship'
          ? 'Last crew afloat takes the seas'
          : 'The voyage ended';
      this.menu.showEndmatch({
        isWinner: won,
        title: won ? 'VICTORY' : (youRow?.deaths ? 'DEFEATED' : 'VOYAGE ENDED'),
        subtitle,
        rows: result.humans.map((r) => ({
          placement: r.placement,
          name: r.name,
          kills: r.kills,
          deaths: r.deaths,
          gold: r.gold,
          you: r.playerId === youId,
          winner: r.isWinner,
        })),
      });
    };
  }

  private bindTradeUiActions() {
    this.ui.tradeConfirm.addEventListener('click', () => {
      if (!this.activeTradeSessionId) return;
      this.network.sendTradeAction({
        action: 'offer',
        sessionId: this.activeTradeSessionId,
        offer: this.localTradeOffer,
      });
      this.network.sendTradeAction({
        action: 'confirm',
        sessionId: this.activeTradeSessionId,
      });
    });

    this.ui.tradeCancel.addEventListener('click', () => {
      if (!this.activeTradeSessionId) return;
      this.network.sendTradeAction({
        action: 'cancel',
        sessionId: this.activeTradeSessionId,
      });
    });
  }

  private handleCombatHit(
    payload: {
      damage?: number;
      position?: { x: number; y: number; z: number };
      headshot?: boolean;
      kill?: boolean;
      weaponId?: WeaponId | string;
      targetType?: 'player' | 'shark' | 'wildlife';
      remainingHull?: number;
      shipHealthMilestone?: 'half' | 'critical' | null;
      meat?: number;
      meatType?: string;
    },
    ship = false,
  ) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    const shark = payload.targetType === 'shark';
    const wildlife = payload.targetType === 'wildlife';
    this.hitMarkerTimer = Math.max(this.hitMarkerTimer, ship ? 0.22 : shark ? 0.16 : payload.headshot ? 0.18 : 0.14);
    this.hitMarkerHeadshot = this.hitMarkerHeadshot || !!payload.headshot;
    this.hitMarkerKill = this.hitMarkerKill || !!payload.kill;
    this.hitMarkerShip = this.hitMarkerShip || ship;
    this.hitMarkerShark = this.hitMarkerShark || shark;
    if (ship && payload.position) {
      this.combatFx.emitShipHitConfirm(payload.position, this.renderer.camera.position);
    }
    if (ship && payload.shipHealthMilestone) {
      const pct = Math.max(0, Math.round((payload.remainingHull ?? 0) * 100));
      this.pushFeed(
        payload.shipHealthMilestone === 'half'
          ? `Enemy ship at half health (${pct}%).`
          : `Enemy ship critical (${pct}%).`,
        payload.shipHealthMilestone === 'half' ? '#f0c86a' : '#ff9878',
      );
    }
    if (wildlife && payload.kill && (payload.meat ?? 0) > 0) {
      const cut = payload.meatType && payload.meatType in WILDLIFE.MEAT_NAME
        ? WILDLIFE.MEAT_NAME[payload.meatType as keyof typeof WILDLIFE.MEAT_NAME]
        : 'meat';
      this.pushFeed(`Harvested ${cut} ×${payload.meat}.`, '#d7b48a');
    }
    const wid = payload.weaponId;
    const weaponLabel = wid && wid in WEAPONS ? WEAPONS[wid as WeaponId].name : undefined;
    if (payload.position) {
      this.spawnFloatingDamageIndicator(String(damage), payload.position, {
        headshot: !!payload.headshot,
        kill: !!payload.kill,
        ship,
        weaponLabel,
      });
    }
  }

  private handleIncomingHit(payload: {
    damage?: number;
    sourcePosition?: { x: number; y: number; z: number };
    headshot?: boolean;
    kill?: boolean;
    weaponId?: WeaponId | string;
    attackerName?: string;
  }) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    const wid = payload.weaponId;
    const weaponLabel = wid && wid in WEAPONS
      ? WEAPONS[wid as WeaponId].name
      : wid === 'powder_keg'
        ? 'Powder Keg'
        : 'attack';
    const attacker = payload.attackerName?.trim() || 'Enemy';
    const critical = payload.headshot ? ' headshot' : '';
    this.pushFeed(`Hit by ${attacker}${critical} - ${damage} (${weaponLabel})`, payload.headshot ? '#ff8f6d' : '#ffb37a');
    if (payload.sourcePosition) this.spawnIncomingDamageDirection(payload.sourcePosition);
  }

  private spawnIncomingDamageDirection(sourcePosition: { x: number; y: number; z: number }) {
    this.tempHudVector.set(sourcePosition.x, sourcePosition.y, sourcePosition.z).project(this.renderer.camera);
    const angle = Math.atan2(this.tempHudVector.x, -this.tempHudVector.y);
    const element = document.createElement('div');
    element.className = 'incoming-damage-arrow';
    element.style.setProperty('--hit-angle', `${angle}rad`);
    this.ui.damageIndicatorLayer.appendChild(element);
    window.setTimeout(() => element.remove(), 760);
  }

  private spawnFloatingDamageIndicator(
    text: string,
    position: { x: number; y: number; z: number },
    options?: { headshot?: boolean; kill?: boolean; ship?: boolean; weaponLabel?: string; pickup?: boolean },
  ) {
    const element = document.createElement('div');
    element.className = 'damage-number';
    if (options?.headshot) element.classList.add('headshot');
    if (options?.kill) element.classList.add('kill');
    if (options?.ship) element.classList.add('ship');
    if (options?.pickup) {
      // Harvest pickup variant ('+3 wood') — gold/tan, styled inline so the
      // shared .damage-number CSS stays combat-only.
      element.style.color = '#eec981';
      element.style.textShadow = '0 1px 3px rgba(43,26,5,0.9), 0 0 10px rgba(240,200,106,0.35)';
    }
    if (options?.weaponLabel && !options.ship) {
      element.innerHTML = `<span class="damage-val">${text}</span><span class="damage-weapon">${options.weaponLabel}</span>`;
    } else {
      element.textContent = text;
    }
    this.ui.damageIndicatorLayer.appendChild(element);
    this.floatingDamageIndicators.push({
      element,
      worldPos: new THREE.Vector3(position.x, position.y + 0.2, position.z),
      life: 0,
      duration: options?.pickup ? 1.0 : options?.headshot ? 0.72 : 0.62,
      riseSpeed: options?.pickup ? 0.8 : options?.ship ? 0.7 : 0.95,
    });
  }

  private applySnapshot(snapshot: GameState) {
    const hasFreshIslandState = snapshot.islands.length > 0 || !this.state;
    // Static world (islands + seaRocks) rides only every 4th full snapshot on
    // the wire — preserve the previous copies on the ticks that omit them.
    const nextSnapshot = this.state && (snapshot.islands.length === 0 || (snapshot.seaRocks?.length ?? 0) === 0)
      ? {
        ...snapshot,
        islands: snapshot.islands.length === 0 ? this.state.islands : snapshot.islands,
        seaRocks: (snapshot.seaRocks?.length ?? 0) === 0 ? this.state.seaRocks : snapshot.seaRocks,
      }
      : snapshot;
    const previousLocalState = this.getLocalPlayer()?.state ?? this.previousLocalState;
    this.state = nextSnapshot;
    this.rebuildStateIndexes(nextSnapshot);
    this.lastSnapshotAt = performance.now();
    if (Number.isFinite(nextSnapshot.serverTime)) {
      const offset = nextSnapshot.serverTime - performance.now() / 1000;
      this.serverTimeOffset = this.serverTimeOffset === null
        ? offset
        : this.serverTimeOffset + (offset - this.serverTimeOffset) * 0.1;
    }
    // Fresh chest state rides EVERY full snapshot (chestSync) — merge it into
    // the (usually preserved) island copies so pickups/stows/drops/digs read
    // instantly instead of freezing until the ~19s static-world resync left
    // ghost chests at the original pickup spot.
    if (snapshot.chestSync && snapshot.chestSync.length > 0 && nextSnapshot.islands.length > 0) {
      const byId = new Map(snapshot.chestSync.map((chest) => [chest.id, chest]));
      for (const island of nextSnapshot.islands) {
        for (const chest of island.chests) {
          const fresh = byId.get(chest.id);
          // Partial merge — the wire only carries the dynamic fields.
          if (fresh) Object.assign(chest, fresh);
        }
      }
    }
    if (hasFreshIslandState) {
      this.ensureWorldMeshes(nextSnapshot);
      this.syncBarrels();
    }
    this.syncChests();
    this.updateStormRing();
    this.updateDamageFx();
    this.syncTradeUi(nextSnapshot);
    const localPlayer = this.getLocalPlayer();
    if (localPlayer && previousLocalState === 'respawning' && localPlayer.state === 'alive') {
      this.combatFx.emitRespawn(localPlayer.position, this.renderer.camera.position);
    }
    this.previousLocalState = localPlayer?.state ?? null;
  }

  /** Merge a 31Hz 'state_hot' transform update into the last full snapshot.
   *  Hot payloads carry only moving-entity transforms (plus storm), so ships,
   *  players and projectiles glide at full rate while the heavyweight world
   *  state arrives at ~10Hz — this is what fixed the ~1s snapshot starvation. */
  private applyHotSnapshot(hot: HotSnapshotPayload) {
    const state = this.state;
    if (!state) return; // need one full snapshot first
    if (hot.tick < state.tick) return; // stale hot arriving after a newer full
    state.tick = hot.tick;
    state.serverTime = hot.serverTime;
    state.shipsAlive = hot.shipsAlive;
    state.storm = hot.storm;
    for (const h of hot.ships) {
      const ship = this.shipsById.get(h.id);
      if (!ship) continue;
      ship.position = h.position;
      ship.rotation = h.rotation;
      ship.velocity = h.velocity;
      ship.angularVelocity = h.angularVelocity;
      ship.pitch = h.pitch;
      ship.roll = h.roll;
      ship.heave = h.heave;
      if (h.rudderAngle !== undefined) ship.rudderAngle = h.rudderAngle;
      ship.sailHeight = h.sailHeight;
      ship.sailAngle = h.sailAngle;
      ship.sinking = h.sinking;
      ship.sinkProgress = h.sinkProgress;
      if (h.waterLevel !== undefined) ship.waterLevel = h.waterLevel;
      if (h.floodingRate !== undefined) ship.floodingRate = h.floodingRate;
    }
    for (const h of hot.players) {
      const player = this.playersById.get(h.id);
      if (!player) continue;
      player.position = h.position;
      player.rotation = h.rotation;
      player.velocity = h.velocity;
      player.health = h.health;
      player.armor = h.armor ?? player.armor ?? 0;
      player.crouching = h.crouching ?? player.crouching ?? false;
      player.state = h.state;
      player.mastClimb = h.mastClimb;
      player.onShipId = h.onShipId;
      player.cutlassCharge = h.cutlassCharge;
      player.downedUntil = h.downedUntil;
      player.reviveProgress = h.reviveProgress;
    }
    for (const h of hot.projectiles) {
      for (const projectile of state.projectiles) {
        if (projectile.id === h.id) {
          projectile.position = h.position;
          projectile.velocity = h.velocity;
          break;
        }
      }
    }
    for (const h of hot.kegs) {
      let known = false;
      for (const keg of state.kegs) {
        if (keg.id === h.id) {
          keg.position = h.position;
          keg.timer = h.timer;
          known = true;
          break;
        }
      }
      if (!known) {
        // A keg placed between full snapshots must render NOW — spawn a
        // minimal record; the next full snapshot fills shipId/localPosition.
        state.kegs.push({
          id: h.id,
          shipId: null,
          position: h.position,
          localPosition: null,
          section: 'bow',
          plantedById: '',
          timer: h.timer,
        } as ShipKeg);
        this.liveKegIds.add(h.id);
      }
    }
    for (const h of hot.sharks) {
      for (const shark of state.sharks ?? []) {
        if (shark.id === h.id) {
          shark.position = h.position;
          shark.rotation = h.rotation;
          shark.health = h.health;
          shark.attackState = h.attackState;
          shark.attackTimer = h.attackTimer;
          break;
        }
      }
    }
    this.lastSnapshotAt = performance.now();
    if (Number.isFinite(hot.serverTime)) {
      const offset = hot.serverTime - performance.now() / 1000;
      this.serverTimeOffset = this.serverTimeOffset === null
        ? offset
        : this.serverTimeOffset + (offset - this.serverTimeOffset) * 0.1;
    }
  }

  private rebuildStateIndexes(state: GameState) {
    this.playersById.clear();
    for (const player of state.players) this.playersById.set(player.id, player);
    this.shipsById.clear();
    for (const ship of state.ships) this.shipsById.set(ship.id, ship);
    this.livePlayerIds.clear();
    for (const player of state.players) this.livePlayerIds.add(player.id);
    this.liveProjectileIds.clear();
    for (const projectile of state.projectiles) {
      if (projectile.alive) this.liveProjectileIds.add(projectile.id);
    }
    this.liveKegIds.clear();
    for (const keg of state.kegs) {
      if (keg.timer > 0) this.liveKegIds.add(keg.id);
    }
  }

  /** Islands still waiting to be built, drained a few per frame so joining a
   *  match never freezes the main thread for seconds (10 islands × a heavy
   *  buildIsland used to run synchronously inside the ws message handler). */
  private pendingIslandBuilds: Island[] = [];

  private ensureWorldMeshes(state: GameState) {
    let islandsQueued = false;
    for (const island of state.islands) {
      if (!this.islandMeshes.has(island.id)
        && !this.pendingIslandBuilds.some((queued) => queued.id === island.id)) {
        this.pendingIslandBuilds.push(island);
        islandsQueued = true;
      }
    }
    if (islandsQueued) {
      // Nearest islands first so the spawn area appears immediately.
      const cam = this.renderer.camera.position;
      this.pendingIslandBuilds.sort((a, b) =>
        this.distance2D(cam.x, cam.z, a.position.x, a.position.z)
        - this.distance2D(cam.x, cam.z, b.position.x, b.position.z));
      // Elliptical footprints: foam/shallows/damping land at the real
      // waterline (the old circle-of-roster-radius buried the foam band tens
      // of meters inside the beach).
      this.ocean.setIslands(state.islands.map((i) => ({
        x: i.position.x,
        z: i.position.z,
        rx: i.radius * i.profile.footprintX,
        rz: i.radius * i.profile.footprintZ,
      })));
      // Build the two closest synchronously so the player never sees a bare
      // horizon at spawn; the rest stream in over the next frames.
      this.drainIslandBuildQueue(2);
    }
    for (const rock of state.seaRocks ?? []) {
      if (!this.seaRockMeshes.has(rock.id)) {
        const mesh = this.islands.buildSeaRockMesh(rock);
        this.environment.add(mesh);
        this.seaRockMeshes.set(rock.id, mesh);
      }
    }
  }

  /** Build up to `count` queued islands (called once per frame from the main
   *  loop with count=1, and from ensureWorldMeshes for the spawn area). */
  drainIslandBuildQueue(count = 1) {
    for (let i = 0; i < count && this.pendingIslandBuilds.length > 0; i++) {
      const island = this.pendingIslandBuilds.shift()!;
      if (this.islandMeshes.has(island.id)) continue;
      // Contain per-island build throws: this drains inside frame() BEFORE the
      // next requestAnimationFrame is scheduled, so one bad island otherwise
      // kills the render loop outright (frozen canvas, no error surface).
      try {
        this.islands.buildIsland(island);
      } catch (err) {
        console.error(`[World] failed to build island ${island.id}:`, err);
      }
    }
  }

  /** Soft round particle sprite (radial alpha falloff), shared by ash / ember /
   *  steam / smoke point clouds so they render as puffs, not hard squares. */
  private getSoftParticleTexture(): THREE.Texture {
    if (this.softParticleTexture) return this.softParticleTexture;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    this.softParticleTexture = tex;
    return tex;
  }

  /** Per-frame driver for volcanic islands: flickers the shared magma pulse
   *  (terrain veins + caldera lava) and steps every registered FX closure
   *  (ashfall, embers, smoke, erupting geyser plumes). Each closure distance-
   *  culls itself against its own island, so idle isles cost almost nothing. */
  private updateVolcanicFx(dt: number, worldTime: number) {
    if (this.volcanicFx.length === 0) return;
    // Warm flicker in ~[0.55, 1.1]: a slow throb plus a faster shimmer.
    const throb = Math.sin(worldTime * 1.6) * 0.5 + 0.5;
    const shimmer = Math.sin(worldTime * 7.3 + 1.7) * 0.5 + 0.5;
    this.magmaPulseUniform.value = 0.62 + throb * 0.34 + shimmer * 0.08;
    const cam = this.renderer.camera.position;
    for (const fx of this.volcanicFx) fx(dt, worldTime, cam);
  }

  private frame(now: number) {
    const rawDtMs = now - this.lastFrameTime;
    const dt = Math.min(0.05, rawDtMs / 1000);
    this.lastFrameTime = now;
    this.frameDt = dt;
    // True frame time for the debug overlay (physics dt above is clamped to
    // 50ms for sim stability, which was pinning 'worst' at exactly 50.0).
    this.debugRawFrameMs = rawDtMs;
    this.minimapTimer -= dt;
    this.inputSendTimer -= dt;
    this.inputHeartbeatTimer -= dt;
    this.windWispTimer -= dt;
    this.rainOverlayTimer -= dt;

    if (this.serverTimeOffset !== null) {
      this.ocean.setWaveTime(performance.now() / 1000 + this.serverTimeOffset);
    }
    this.ocean.update(dt, this.renderer.camera.position);
    this.ocean.setAtmosphere(this.renderer.getAtmosphere());
    this.updateScene(dt);
    // Shared match clock (same value the server passes to the physics/geyser
    // timing) drives the volcanic magma flicker + geyser plumes in lockstep.
    const worldTime = this.serverTimeOffset !== null
      ? performance.now() / 1000 + this.serverTimeOffset
      : performance.now() / 1000;
    this.updateVolcanicFx(dt, worldTime);
    this.updateTavernDoors(dt);
    // Drive the palm/foliage sway: advance its clock and gust the wind strength.
    this.foliageTime.value = worldTime;
    const gust = 0.75 + 0.35 * Math.sin(worldTime * 0.27) + 0.15 * Math.sin(worldTime * 0.11);
    this.foliageWind.value.set(0.68 * gust, 0.46 * gust);
    // Held lantern: warm light follows the view while the lantern tool is up,
    // with a gentle candle flicker. Lets you see inside caves and at night.
    const lampOn = this.getLocalPlayer()?.equippedTool === 'lantern';
    // Hold ATTACK (LMB) to RAISE the lantern — it flares much brighter and throws
    // its light far ahead so you can flood a cave or the deck at night. Eased so
    // the flare ramps smoothly. (Dedicated light → no lantern-budget pressure.)
    const raiseTarget = lampOn && this.input.isFiring() ? 1 : 0;
    this.lanternRaise01 += (raiseTarget - this.lanternRaise01) * 0.16;
    const lr = this.lanternRaise01;
    const lampFlicker = 1 + 0.09 * Math.sin(worldTime * 8.3) + 0.05 * Math.sin(worldTime * 17.0);
    this.heldLampLight.intensity = lampOn ? THREE.MathUtils.lerp(2.6, 9.5, lr) * lampFlicker : 0;
    this.heldLampLight.distance = THREE.MathUtils.lerp(24, 54, lr);
    this.heldLampLight.position.set(0.35 - lr * 0.18, -0.1 + lr * 0.55, -0.5 - lr * 0.55);

    // Radial release: if the wheel just closed over a hovered slot, queue it now
    // (before hasPendingActions so the resulting input is force-sent this frame).
    this.updateWheelRelease();

    // Right-click PUTS AWAY a held tool (bucket/compass/shovel) — re-selecting
    // its wheel slot toggles it off. The SPYGLASS is excluded: for it, aim
    // (right-click) RAISES the scope to zoom, so it must not stow on right-click.
    const equippedTool = this.getLocalPlayer()?.equippedTool ?? null;
    const aimDown = this.input.isAiming();
    if (equippedTool && equippedTool !== 'spyglass' && aimDown && !this.scopeAimWasDown) {
      this.input.queueWheelSlot(this.toolWheelSlot(equippedTool));
    }
    // While the wheel is open the pointer is UNLOCKED, so isAiming() reads
    // false even with Shift physically held — on wheel close + relock that
    // used to register as a fresh aim edge and instantly stow the tool you
    // JUST equipped (compass bounced straight back to the gun).
    this.scopeAimWasDown = aimDown || this.input.isSupplyWheelOpen();

    const hasForcedInput = this.input.hasPendingActions() || this.pendingInteractFromUi || this.pendingLaunchFromUi;
    if (this.network.isConnected() && (this.inputSendTimer <= 0 || hasForcedInput)) {
      if (this.input.consumeLegendPressed()) {
        const legend = document.getElementById('controls-hint');
        if (legend) legend.style.display = legend.style.display === 'block' ? 'none' : 'block';
      }
      const input = this.input.buildInput();
      if (this.spyglassActive || equippedTool) {
        // A raised spyglass or a held tool occupies both hands — no weapon fire.
        // But the ATTACK button (LMB) now drives the held tool's own verb: bail
        // with the bucket, raise the lantern. Route it via useItem, keep fire off.
        input.useItem = !!equippedTool && !this.spyglassActive && this.input.isFiring();
        input.fire = false;
        input.aim = false;
      }
      if (input.useWheelItem && input.wheelIndex !== null) {
        this.startPocketUsePreview(input.wheelIndex);
      }
      // Quest-map equip (maps wheel page): digit index or clicked row → the
      // held chart's island id rides ONE input as a server one-shot.
      const selectMapIndex = this.input.consumeSelectMapIndex();
      const me = this.getLocalPlayer();
      const selectMapId = this.map.pendingSelectMapFromUi
        ?? (selectMapIndex !== null ? me?.questMaps?.[selectMapIndex] ?? null : null);
      this.map.pendingSelectMapFromUi = null;
      if (selectMapId) input.selectMap = selectMapId;
      const uiInteract = this.pendingInteractFromUi;
      if (this.pendingInteractFromUi) {
        input.interact = true;
        this.pendingInteractFromUi = false;
      }
      const currentInteractKind = this.resolveCurrentInteractKind();
      if (input.interact && currentInteractKind === 'door') {
        // Tavern doors are purely client-side — swing it here and swallow the
        // press so the server's legacy interact fallback can't grab something
        // else (a chest, a ladder) the player never aimed at.
        this.toggleNearestTavernDoor();
        input.interact = false;
      }
      // Harvest is LMB work (useItem), not an [X] intent — swallow the press
      // like the doors so the server's legacy fallback can't grab something else.
      if (input.interact && currentInteractKind === 'harvest') {
        input.interact = false;
      }
      const toServerIntent = (kind: ClientInteractKind | null): InteractIntent | null =>
        (kind === 'door' || kind === 'harvest' ? null : kind);
      input.interactIntent = input.interact
        ? (toServerIntent(currentInteractKind) ?? (uiInteract ? toServerIntent(this.lastInteractKind) : null))
        // Revive, the sail halyard, the yard braces and hull REPAIR are
        // continuous holds — their intent must ride every held frame for the
        // server-side work to run. (Bailing is a discrete press per
        // scoop/heave, so it only fires on the edge.)
        : (input.interactHeld
          && (currentInteractKind === 'revive' || currentInteractKind === 'sails'
            || currentInteractKind === 'brace' || currentInteractKind === 'repair')
          ? currentInteractKind
          : null);
      if (this.pendingLaunchFromUi) {
        input.jumpPressed = true;
        this.pendingLaunchFromUi = false;
      }
      const signature = this.getInputSignature(input);
      const changed = signature !== this.lastSentInputSignature;
      if (hasForcedInput || changed || this.inputHeartbeatTimer <= 0) {
        this.network.sendInput(input);
        this.lastSentInputSignature = signature;
        this.inputHeartbeatTimer = CLIENT_INPUT_HEARTBEAT_INTERVAL;
      }
      this.inputSendTimer = CLIENT_INPUT_SEND_INTERVAL;
    }

    this.updateStationMarkers();
    this.updateCapstanHands();
    this.updateSlashRibbons(dt);
    this.updateMuzzleFlash(dt);
    if (!this.bugSnapListenerBound) {
      this.bugSnapListenerBound = true;
      window.addEventListener('keydown', this.bugSnapListener);
    }
    this.updateMermaid(now);
    // Stream one queued island build per frame (join used to build all 10
    // synchronously and freeze the tab for seconds).
    this.drainIslandBuildQueue(1);
    this.renderer.updatePerformance(dt);
    this.renderer.render();
    if (this.bugSnapRequested) {
      this.bugSnapRequested = false;
      try {
        const image = this.renderer.renderer.domElement.toDataURL('image/png');
        const player = this.getLocalPlayer();
        const ship = player?.onShipId ? this.shipsById.get(player.onShipId) : null;
        const meta = {
          at: new Date().toISOString(),
          position: player?.position ?? null,
          state: player?.state ?? null,
          onShipId: player?.onShipId ?? null,
          shipType: ship?.type ?? null,
          nearestIsland: (() => {
            let best: { id: string; d: number } | null = null;
            for (const island of this.state?.islands ?? []) {
              const d = this.distance2D(player?.position.x ?? 0, player?.position.z ?? 0, island.position.x, island.position.z);
              if (!best || d < best.d) best = { id: island.id, d: Math.round(d) };
            }
            return best;
          })(),
          fps: Math.round(this.debugFps),
          note: 'F8 bug snap',
        };
        void fetch('/bugsnap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image, meta }),
        }).then(() => this.pushFeed('Bug snap saved — thanks, captain!', '#7ce38b'))
          .catch(() => this.pushFeed('Bug snap failed to save', '#ff8a7a'));
      } catch {
        this.pushFeed('Bug snap failed to capture', '#ff8a7a');
      }
    }
    this.updatePointerLockHint();
    this.updateDebugPerfPanel(dt);

    requestAnimationFrame((time) => this.frame(time));
  }

  private setupDebugPerfPanel() {
    if (!this.debugPerfEnabled || this.debugPerfPanel) return;

    const panel = document.createElement('div');
    panel.id = 'debug-perf-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:10px',
      'bottom:10px',
      'z-index:99999',
      'min-width:260px',
      'max-width:380px',
      'padding:9px 10px',
      'border:1px solid rgba(141,185,255,0.42)',
      'border-radius:6px',
      'background:rgba(4,11,23,0.78)',
      'box-shadow:0 8px 28px rgba(0,0,0,0.35)',
      'color:#d9e8ff',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre',
      'pointer-events:none',
      'text-shadow:0 1px 2px rgba(0,0,0,0.7)',
    ].join(';');
    panel.textContent = 'Pirates BR debug\nwaiting for first frame...';
    document.body.appendChild(panel);
    this.debugPerfPanel = panel;
  }

  private updateDebugPerfPanel(dt: number) {
    if (!this.debugPerfPanel) return;

    this.debugFrameCounter++;
    this.debugFrameAccum += dt;
    this.debugWorstFrameMs = Math.max(this.debugWorstFrameMs, this.debugRawFrameMs);
    this.debugUpdateTimer -= dt;
    if (this.debugUpdateTimer > 0) return;

    this.debugFps = this.debugFrameCounter / Math.max(0.001, this.debugFrameAccum);
    const worstFrame = this.debugWorstFrameMs;
    this.debugFrameCounter = 0;
    this.debugFrameAccum = 0;
    this.debugWorstFrameMs = 0;
    this.debugUpdateTimer = 0.5;

    const info = this.renderer.renderer.info;
    const player = this.getLocalPlayer();
    const ship = this.getTrackedShip();
    const activeWeapon = player?.weapons[player.activeSlot] ?? null;
    const averageHull = ship
      ? (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) * 25
      : null;
    const prompt = (this.ui.interactPrompt.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const snapshotAgeMs = performance.now() - this.lastSnapshotAt;

    const stateLine = this.state
      ? [
          `state ${this.state.phase}`,
          `ships ${this.state.shipsAlive}/${this.state.ships.length}`,
          `players ${this.state.players.length}`,
          `proj ${this.state.projectiles.length}`,
          `kegs ${this.state.kegs.length}`,
        ].join(' | ')
      : 'state menu/waiting';

    const playerLine = player
      ? [
          `player ${player.state}`,
          `hp ${Math.round(player.health)}`,
          `onShip ${player.onShipId ? 'yes' : 'no'}`,
          `helm ${player.atHelm ? 'Y' : 'n'}`,
          `cannon ${player.atCannon ? player.cannonIndex : 'n'}`,
          `sails ${player.atSails ? 'Y' : 'n'}`,
          `weapon ${activeWeapon?.weaponId ?? 'none'}`,
        ].join(' | ')
      : 'player none';

    const shipLine = ship
      ? [
          `ship ${ship.type}`,
          `hull ${Math.round(averageHull ?? 0)}%`,
          `sail ${Math.round(ship.sailHeight * 100)}%`,
          `anchor ${ship.anchored ? `down ${Math.round((ship.anchorRaiseProgress ?? 0) * 100)}%` : 'up'}`,
          `speed ${Math.hypot(ship.velocity.x, ship.velocity.z).toFixed(1)}`,
        ].join(' | ')
      : 'ship none';

    this.debugPerfPanel.textContent = [
      'Pirates BR debug',
      `fps ${this.debugFps.toFixed(0)} | worst ${worstFrame.toFixed(1)}ms | quality ${this.renderer.getQuality()} | dpr ${this.renderer.renderer.getPixelRatio().toFixed(2)}`,
      `draw ${info.render.calls} | tris ${info.render.triangles} | geom ${info.memory.geometries} | tex ${info.memory.textures}`,
      stateLine,
      playerLine,
      shipLine,
      `snapshot ${Math.round(snapshotAgeMs)}ms | interact ${this.visibleInteractKind ?? this.lastInteractKind ?? 'none'} | prompt ${prompt || 'none'}`,
    ].join('\n');
  }

  private updateEnvironmentLod() {
    if (!this.state) return;

    const quality = this.renderer.getQuality();
    const cam = this.renderer.camera.position;
    // Islands are THE landmark visuals: hold full detail out to AAA distances,
    // measured from the island EDGE (footprint radius), not its center — a
    // 200m-radius island's shoreline used to flip to proxy while you stood on it.
    const detailRadius = quality === 'low' ? 420 : quality === 'balanced' ? 700 : 950;
    const wildlifeRadius = quality === 'low' ? 220 : quality === 'balanced' ? 360 : 520;
    const lootRadius = quality === 'low' ? 340 : quality === 'balanced' ? 520 : 760;
    const seaRockRadius = quality === 'low' ? 650 : quality === 'balanced' ? 900 : 1200;
    const upgradeRadius = quality === 'low' ? 420 : quality === 'balanced' ? 620 : 820;
    const npcRadius = quality === 'low' ? 360 : quality === 'balanced' ? 560 : 760;

    for (const island of this.state.islands) {
      const group = this.islandMeshes.get(island.id);
      if (!group) continue;
      const dist = this.distance2D(cam.x, cam.z, island.position.x, island.position.z);
      const detailRoot = group.userData.detailRoot as THREE.Object3D | undefined;
      const proxyRoot = group.userData.proxyRoot as THREE.Object3D | undefined;
      if (detailRoot && proxyRoot) {
        const edgeDist = dist - getIslandMaxRadius(island);
        const showDetail = edgeDist < detailRadius;
        detailRoot.visible = showDetail;
        proxyRoot.visible = !showDetail;
        // Micro decor (shells, rubble, clutter) only reads up close — culling
        // it past ~260m cuts hundreds of draw calls per distant island.
        const microRoot = detailRoot.getObjectByName('island-micro-root');
        if (microRoot) microRoot.visible = showDetail && edgeDist < (quality === 'low' ? 180 : 260);
        for (const layerName of ['island-grass', 'island-ferns', 'island-shells'] as const) {
          const layer = detailRoot.getObjectByName(layerName);
          if (layer) layer.visible = showDetail && edgeDist < (layerName === 'island-shells' ? 200 : 300);
        }
        // Cave INTERIOR decor + lights (torch, crystals, stalactites, treasure)
        // reveal within ~45m so the warm glow greets you at the mouth and the
        // light budget isn't spent on unseen caverns across the map. The exterior
        // rock PORTAL + its mouth tube live in a separate group that stays visible
        // with the terrain, so the entrance always reads from across the island.
        const caveGroups = group.userData.caveGroups as THREE.Object3D[] | undefined;
        if (caveGroups) {
          for (const caveGroup of caveGroups) {
            const e = caveGroup.userData.caveEntranceWorld as { x: number; y: number; z: number };
            const cd = this.distance2D(cam.x, cam.z, e.x, e.z);
            caveGroup.visible = showDetail && cd < 45;
          }
        }
        // Mouth-glow lights ride the always-visible portal group, so gate the
        // LIGHTS by camera distance here (same 55m budget as chest/station glows).
        const mouthGlows = group.userData.caveMouthGlows as { light: THREE.PointLight; x: number; z: number }[] | undefined;
        if (mouthGlows) {
          for (const glow of mouthGlows) {
            // 90m: the beckoning mouth glow must read from the approach, not
            // pop in at the threshold like the 55m chest/station budget.
            glow.light.visible = showDetail && this.distance2D(cam.x, cam.z, glow.x, glow.z) < 90;
          }
        }
      }

      for (const chest of island.chests) {
        const record = this.chestMeshes.get(chest.id);
        if (!record) continue;
        const chestDist = this.distance2D(cam.x, cam.z, chest.position.x, chest.position.z);
        const carriedByLocal = chest.carriedByPlayerId === this.localPlayerId;
        record.root.visible = chestDist < lootRadius && !chest.opened && !carriedByLocal;
        const chestLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (chestLight) chestLight.visible = record.root.visible && chestDist < 55;
      }

      for (const barrel of island.barrels) {
        const root = this.barrelMeshes.get(barrel.id);
        if (!root) continue;
        const barrelDist = this.distance2D(cam.x, cam.z, barrel.position.x, barrel.position.z);
        root.visible = barrelDist < lootRadius && (!barrel.opened || barrel.loot.length > 0);
      }

      for (const station of island.upgradeStations) {
        const record = this.upgradeStationMeshes.get(station.id);
        if (!record) continue;
        const stationDist = this.distance2D(cam.x, cam.z, station.position.x, station.position.z);
        record.root.visible = stationDist < upgradeRadius;
        const stationLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (stationLight) stationLight.visible = record.root.visible && stationDist < 55;
      }

      for (const npc of island.npcs ?? []) {
        const record = this.npcMeshes.get(npc.id);
        if (!record) continue;
        const npcDist = this.distance2D(cam.x, cam.z, npc.position.x, npc.position.z);
        record.root.visible = npcDist < npcRadius;
        const npcLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (npcLight) npcLight.visible = record.root.visible && npcDist < 55;
      }
    }

    for (const animal of this.state.wildlife ?? []) {
      const mesh = this.wildlifeMeshes.get(animal.id);
      if (!mesh) continue;
      const dist = this.distance2D(cam.x, cam.z, animal.position.x, animal.position.z);
      mesh.visible = animal.health > 0 && dist < (animal.type === 'gull' ? wildlifeRadius * 1.35 : wildlifeRadius);
    }

    for (const rock of this.state.seaRocks ?? []) {
      const mesh = this.seaRockMeshes.get(rock.id);
      if (!mesh) continue;
      const dist = this.distance2D(cam.x, cam.z, rock.position.x, rock.position.z);
      mesh.visible = dist < seaRockRadius;
    }
  }

  private getInputSignature(input: PlayerInput): string {
    return [
      input.forward ? 1 : 0,
      input.back ? 1 : 0,
      input.left ? 1 : 0,
      input.right ? 1 : 0,
      input.jump ? 1 : 0,
      input.fire ? 1 : 0,
      input.aim ? 1 : 0,
      // Tool use (bucket scoop / lantern raise) rides useItem with fire forced
      // off — omitting it here meant an LMB edge with a tool equipped changed
      // no signature field, so the action only reached the server on the next
      // unrelated input change.
      input.useItem ? 1 : 0,
      input.interactHeld ? 1 : 0,
      input.sailRaise ? 1 : 0,
      input.sailLower ? 1 : 0,
      input.sailLeft ? 1 : 0,
      input.sailRight ? 1 : 0,
      input.dropChest ? 1 : 0,
      input.specialAttack ? 1 : 0,
      input.slot ?? '',
      input.cannonAmmo ?? '',
      input.interactIntent ?? '',
      Math.round(input.yaw * 1000),
      Math.round(input.pitch * 1000),
    ].join('|');
  }

  /** SoT-style station beacons: soft pulsing rings floating over the anchor
   *  capstan, the sail rigging, and the helm while you're aboard your ship —
   *  you can SEE where to go from across the deck. The anchor ring burns
   *  red while the anchor is down (the #1 'why is my ship not moving'). */
  private stationMarkers: { anchor: THREE.Sprite; sails: THREE.Sprite; helm: THREE.Sprite } | null = null;

  private setupMuzzleFlash() {
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

  /** Barrel-tip offset per weapon (local to the viewmodel root). */
  private muzzleTipFor(weaponId: WeaponId): [number, number, number] {
    switch (weaponId) {
      case 'eye_of_reach': return [0, 0.075, 1.5];
      case 'blunderbuss': return [0, 0.055, 1.0];
      case 'flintknock': return [0, 0.05, 0.62];
      default: return [0, 0.05, 0.7];
    }
  }

  private triggerMuzzleFlash(weaponId: WeaponId) {
    if (!this.muzzleFlash || !this.muzzleGlow) return;
    const [tx, ty, tz] = this.muzzleTipFor(weaponId);
    const scatter = weaponId === 'blunderbuss' ? 1.5 : 1;
    this.muzzleFlash.position.set(tx, ty, tz);
    const flashScale = (weaponId === 'blunderbuss' ? 0.55 : weaponId === 'eye_of_reach' ? 0.4 : 0.32) * scatter;
    this.muzzleFlash.scale.set(flashScale, flashScale, 1);
    this.muzzleFlash.material.rotation = Math.sin(this.ocean.getTime() * 91.7) * Math.PI;
    this.muzzleFlash.visible = true;
    this.muzzleFlash.material.opacity = 1;
    this.muzzleGlow.position.set(tx, ty, tz);
    this.muzzleGlow.intensity = 5 * scatter;
    this.muzzleFlashTimer = 0.09;
    // Smoke puffs drift forward from the barrel and fade.
    for (let i = 0; i < this.muzzleSmoke.length; i++) {
      const s = this.muzzleSmoke[i];
      s.position.set(tx + (Math.sin(i * 2.1) * 0.05), ty + 0.02 + i * 0.015, tz + 0.05 + i * 0.04);
      s.scale.setScalar(0.12 + i * 0.04);
      s.material.opacity = 0.5 - i * 0.08;
      s.visible = true;
      s.userData.smokeLife = 0.5 + i * 0.12;
      s.userData.smokeAge = 0;
    }
  }

  private updateMuzzleFlash(dt: number) {
    if (this.muzzleFlash && this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer -= dt;
      const k = Math.max(0, this.muzzleFlashTimer / 0.09);
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
      s.position.z += dt * 0.5;
      s.position.y += dt * 0.12;
      s.scale.setScalar(s.scale.x + dt * 0.35);
      s.material.opacity = (1 - a) * 0.4;
    }
  }

  private buildCapstanHands() {
    if (this.capstanHandsBuilt) return;
    this.capstanHandsBuilt = true;
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x7a3f2a, roughness: 0.92 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc98d5f, roughness: 0.85 });
    const barMat = new THREE.MeshStandardMaterial({ color: 0x4a331e, roughness: 0.9 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), barMat);
    bar.rotation.z = Math.PI * 0.5;
    bar.position.set(0, -0.32, -0.62);
    this.localViewHandsRoot.add(bar);
    for (const side of [-1, 1] as const) {
      const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.42, 8), sleeveMat);
      forearm.position.set(side * 0.24, -0.42, -0.44);
      forearm.rotation.x = -1.05;
      forearm.rotation.z = side * 0.18;
      this.localViewHandsRoot.add(forearm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.075, 0.13), skinMat);
      hand.position.set(side * 0.22, -0.325, -0.6);
      this.localViewHandsRoot.add(hand);
      for (let f = 0; f < 3; f++) {
        const finger = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.024), skinMat);
        finger.position.set(side * 0.22 - 0.026 + f * 0.026, -0.29, -0.655);
        finger.rotation.x = 0.7;
        this.localViewHandsRoot.add(finger);
      }
    }
  }

  /** Show working hands on the capstan bar while the anchor hold runs. */
  private updateCapstanHands() {
    const player = this.getLocalPlayer();
    const ship = player?.onShipId ? this.shipsById.get(player.onShipId) : null;
    // Show the crank hands the instant you grab the capstan (holding X with
    // the anchor interaction resolved), not only once the anchor is already
    // rising — the old progress>0.001 gate made them flicker/never show.
    const cranking = !!player && !!ship
      && ship.anchored
      && this.input.isInteractHeld()
      && (this.visibleInteractKind === 'anchor' || this.lastInteractKind === 'anchor');
    if (cranking) this.buildCapstanHands();
    this.localViewHandsRoot.visible = !!cranking;
    if (cranking) {
      this.localViewWeaponRoot.visible = false;
      const t = this.ocean.getTime();
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
      mesh.position.set(0, -0.04, -0.9);
      mesh.renderOrder = 998;
      mesh.visible = false;
      this.renderer.camera.add(mesh);
      this.slashRibbons.push({ mesh, mat, age: 0, life: 0, side: 1 });
    }
    // Dash streak: a long thin gradient quad receding into the screen.
    const streakMat = makeMat();
    const streak = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 1.3), streakMat);
    streak.position.set(0.16, -0.14, -0.9);
    streak.rotation.set(-Math.PI * 0.46, 0, 0); // lay it along the thrust axis
    streak.renderOrder = 998;
    streak.visible = false;
    this.renderer.camera.add(streak);
    this.slashStreak = { mesh: streak, mat: streakMat, age: 0, life: 0 };
  }

  /** First-person slash flash along the current cutlass diagonal. */
  private spawnViewSlashArc(side: 1 | -1) {
    this.ensureSlashRibbons();
    const r = this.slashRibbons[this.slashRibbonCursor];
    this.slashRibbonCursor = (this.slashRibbonCursor + 1) % this.slashRibbons.length;
    r.age = 0;
    r.life = 0.16;
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
  private spawnRemoteSlashArc(worldPos: THREE.Vector3) {
    if (this.remoteSlashArcs.length === 0) {
      const tex = this.getSlashTexture();
      for (let i = 0; i < 6; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex, color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        sprite.visible = false;
        sprite.renderOrder = 996;
        this.renderer.scene.add(sprite);
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

  private updateSlashRibbons(dt: number) {
    for (const r of this.slashRibbons) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const p = r.age / r.life;
      if (p >= 1) {
        r.mesh.visible = false;
        r.mat.opacity = 0;
        continue;
      }
      const grow = 1 + p * 0.18;
      // Mirror the CUT keyframes: head lands lower-opposite of the cock side.
      r.mesh.scale.set(r.side * grow, -grow, 1);
      r.mesh.rotation.z = THREE.MathUtils.degToRad(-20) * r.side;
      r.mat.opacity = 0.85 * (1 - p);
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

  private updateStationMarkers() {
    // Retired: the floating beacon orbs read as UI garbage in-world (they
    // glowed through sniper scopes at night). Stations are now marked by
    // PHYSICAL implements — rope coils on the rails, the capstan itself —
    // plus the [X] prompts. Keep sprites hidden if they were ever created.
    if (this.stationMarkers) {
      this.stationMarkers.anchor.visible = false;
      this.stationMarkers.sails.visible = false;
      this.stationMarkers.helm.visible = false;
    }
  }

  private updateMermaid(now: number): void {
    const player = this.getLocalPlayer();
    const ship = player ? this.getMermaidReturnShip(player) : null;
    if (!player || !ship) {
      this.mermaidAnchor = null;
      if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
      return;
    }
    if (
      !this.mermaidAnchor
      || this.mermaidAnchor.shipId !== ship.id
      || this.distance2D(player.position.x, player.position.z, this.mermaidAnchor.x, this.mermaidAnchor.z) > 62
    ) {
      this.mermaidAnchor = this.createMermaidAnchor(player, ship);
    }
    const phase = (this.mermaidGroup.userData.bobPhase as number) ?? 0;
    const bob = Math.sin(now * 0.0023 + phase) * 0.12;
    // Ride the real sea — a fixed 0.18 left her hovering over troughs and
    // submerged under storm crests.
    const mermaidWaveY = gerstnerHeight(
      this.mermaidAnchor.x, this.mermaidAnchor.z, this.ocean.getTime(), WAVE_PARAMS,
      getStormWaveIntensity(this.state?.storm, this.mermaidAnchor.x, this.mermaidAnchor.z),
    );
    this.mermaidGroup.position.set(this.mermaidAnchor.x, mermaidWaveY + 0.14 + bob, this.mermaidAnchor.z);
    this.mermaidGroup.rotation.y = Math.atan2(
      player.position.x - this.mermaidAnchor.x,
      player.position.z - this.mermaidAnchor.z,
    );
    this.mermaidGroup.visible = true;
  }

  private createMermaidAnchor(player: Player, ship: Ship) {
    const dx = ship.position.x - player.position.x;
    const dz = ship.position.z - player.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const offset = Math.min(8, Math.max(5, len * 0.12));
    return {
      x: player.position.x + (dx / len) * offset,
      z: player.position.z + (dz / len) * offset,
      shipId: ship.id,
    };
  }

  private updatePointerLockHint(): void {
    if (!this.pointerLockHintEl) {
      this.pointerLockHintEl = document.getElementById('pointer-lock-hint');
    }
    if (!this.pointerLockHintEl) return;
    const inMatch = !!this.localPlayerId;
    const menuVisible = this.menu.isVisible();
    const showHint = inMatch && !menuVisible && !this.input.isLocked();
    this.pointerLockHintEl.classList.toggle('visible', showHint);
  }

  private updateScene(dt: number) {
    if (!this.state) {
      return;
    }

    this.audioFrameTriggers(dt);
    // Single source of night-ness for every warm-light system this frame.
    const nightFactor = THREE.MathUtils.clamp(this.renderer.getAtmosphere().nightFactor, 0, 1);
    this.shipRenderer.setNightFactor(nightFactor);
    this.updateLanterns(nightFactor, this.renderer.camera.position, this.ocean.getTime());
    const snapshotAge = Math.min(0.22, (performance.now() - this.lastSnapshotAt) / 1000);
    this.shipRenderer.update(
      this.state.ships,
      this.state.players,
      this.ocean.getTime(),
      dt,
      snapshotAge,
      this.renderer.camera.position,
      this.localPlayerId ?? undefined,
      // Ring form: the renderer evaluates the shared storm sea-state per ship,
      // so hulls straddling the wall ride the same swell the ocean draws.
      this.state.storm
        ? { center: { x: this.state.storm.centerX, y: this.state.storm.centerZ }, safeRadius: this.state.storm.safeRadius, phase: this.state.storm.phase }
        : 0,
    );
    this.syncSharks(dt);
    this.syncWildlife(dt);
    this.updateEnvironmentLod();
    // Per-frame so the wall/ring track the shrink smoothly instead of stepping
    // only when snapshots arrive.
    this.updateStormRing();
    this.stormWall.rotation.y = this.ocean.getTime() * 0.035;
    this.stormWallTexture.offset.x = this.ocean.getTime() * 0.018;
    this.stormHalo.rotation.z = this.ocean.getTime() * 0.12;
    this.stormWeatherIntensity = this.computeStormWeatherIntensity();
    // (renderer storm weather is applied via updateWaterEnvironment below —
    // calling updateStormWeather here too did the same work twice per frame)
    this.ocean.setStormIntensity(this.stormWeatherIntensity);
    // Storm SEA GEOMETRY (separate from the color tint above): the shader
    // mirrors getStormWaveIntensity, so waves genuinely rage inside the ring.
    // phase01 must match the shared formula: clamp(phase / 6, 0, 1) — phase is
    // 0-indexed over the 7 STORM_PHASES.
    if (this.debugStormDemo) {
      // Park a tiny full-power ring at the camera: locally we are deep outside
      // it, so the shared sea-state formula returns ~1 right here.
      const cam = this.renderer.camera.position;
      this.stormWeatherIntensity = 0.7;
      this.ocean.setStormIntensity(0.7);
      // Positive radius, ring parked far away: we are ~780m outside it, so the
      // shared sea-state formula returns 1 here. (A negative radius hits the
      // shader's no-storm sentinel and silently disables the swell geometry.)
      this.ocean.setStormState(cam.x + 900, cam.z, 120, 1);
    } else if (this.state?.storm) {
      const storm = this.state.storm;
      this.ocean.setStormState(
        storm.centerX,
        storm.centerZ,
        storm.safeRadius,
        THREE.MathUtils.clamp(storm.phase / 6, 0, 1),
      );
    } else {
      this.ocean.clearStormState();
    }
    const effectScale = this.renderer.getEffectScale();
    // World-space rain runs every frame (cheap buffer update; the old canvas
    // overlay throttle is gone with the overlay).
    this.updateStormRain3D(dt, this.debugStormDemo ? 0.9 : this.computeStormRainIntensity());
    this.updateStormLightningFlash(dt);
    const stormW = this.stormWeatherIntensity;
    const wallMat = this.stormWall.material as THREE.MeshBasicMaterial;
    wallMat.opacity = 0.18 + stormW * 0.28;
    wallMat.color.copy(this.stormWallColorClear).lerp(this.stormWallColorStorm, stormW);
    const haloMat = this.stormHalo.material as THREE.MeshBasicMaterial;
    haloMat.opacity = 0.08 + stormW * 0.16;
    this.combatFx.update(dt);
    this.updateHarvestDestruction(dt);
    this.syncKegs(dt);
    this.slowSceneTimer -= dt;
    if (this.slowSceneTimer <= 0) {
      this.updateUpgradeStations(Math.max(dt, 0.1));
      this.updateStoryNpcs(Math.max(dt, 0.1));
      this.slowSceneTimer = 0.1;
    }
    this.syncPlayers(dt);
    this.syncProjectiles(dt);
    this.updateCamera();
    this.updateWaterEnvironment();
    this.hud.updateCombatHud(dt);
    this.syncLocalViewWeapon();
    if (this.freeCam) {
      // A detached tour/dev camera is not "the pirate's eyes" — hide the
      // first-person weapon/hands/pocket viewmodels so audit shots are clean.
      this.localViewWeaponRoot.visible = false;
      this.localViewHandsRoot.visible = false;
      this.localViewPocketRoot.visible = false;
    }
    if (this.windWispTimer <= 0) {
      this.updateWindWisps();
      this.windWispTimer = effectScale < 0.55 ? 1 / 20 : effectScale < 0.85 ? 1 / 30 : 0;
    }
    this.updateLightning(dt);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hud.updateHud();
      this.hudTimer = effectScale < 0.55 ? 0.09 : 0.06;
    }
    if (this.minimapTimer <= 0) {
      this.map.drawMaps();
      this.minimapTimer = effectScale < 0.55 ? 0.5 : effectScale < 0.85 ? 0.35 : 0.25;
    }
    // The opened map tracks live (arrow + ships) every frame; minimap throttled.
    if (this.map.mapOpen) this.map.drawFullMap();

    this.interactScanTimer -= dt;
    if (this.interactScanTimer <= 0) {
      this.refreshInteractIntentForNet();
      this.interactScanTimer = 1 / 30;
    }
  }

  /** Same look-based winner as the HUD; refreshed between input sends for prompt previews. */
  private refreshInteractIntentForNet() {
    this.lastInteractKind = this.resolveCurrentInteractKind();
  }

  private resolveCurrentInteractKind(): ClientInteractKind | null {
    if (!this.state) return null;
    const player = this.getLocalPlayer();
    if (!player) return null;
    const ship = this.getTrackedShip();
    const nearbyCannon = ship ? this.findNearbyCannonIndex(player, ship) : null;
    const repairSection = ship ? this.findRepairableHullSection(player, ship) : null;
    const lookInteraction = this.getLookInteraction(player, ship, nearbyCannon, repairSection);
    // Mid-mast-climb, X means "let go" (server-owned) — don't let a stray
    // chest/door candidate claim the press.
    const canPickInteractKind = !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest
      && player.mastClimb === null
      && player.state !== 'respawning' && player.state !== 'eliminated';
    return canPickInteractKind && lookInteraction ? lookInteraction.kind : null;
  }

  /** Match server PhysicsSystem cannon flight between snapshots so launches don't feel ~1–3 ticks behind. */
  private extrapolateCannonBallistic(player: Player, ageSeconds: number) {
    let vx = player.velocity.x;
    let vy = player.velocity.y;
    let vz = player.velocity.z;
    let px = player.position.x;
    let py = player.position.y;
    let pz = player.position.z;
    const total = Math.max(0, Math.min(0.22, ageSeconds));
    const steps = Math.max(4, Math.ceil(total / 0.022));
    const step = total / steps;
    for (let i = 0; i < steps; i++) {
      vy += PHYSICS.GRAVITY * step;
      px += vx * step;
      py += vy * step;
      pz += vz * step;
    }
    this.tempBallisticPos.set(px, py, pz);
    return this.tempBallisticPos;
  }

  private getPlayerRenderPosition(player: Player, leadSeconds: number) {
    const isLocal = player.id === this.localPlayerId;
    const rawAge = (performance.now() - this.lastSnapshotAt) / 1000;
    const snapshotAge = Math.min(isLocal ? 0.24 : 0.18, rawAge);

    if (player.cannonBallistic) {
      const age = Math.min(0.22, snapshotAge + (isLocal ? leadSeconds + 0.02 : leadSeconds * 0.5));
      return this.extrapolateCannonBallistic(player, age);
    }

    let predictedX = player.position.x + (player.velocity.x + player.knockbackVelocity.x * 0.32) * leadSeconds;
    let predictedZ = player.position.z + (player.velocity.z + player.knockbackVelocity.z * 0.32) * leadSeconds;
    let visualY = player.position.y + (player.velocity.y + player.knockbackVelocity.y * 0.18) * leadSeconds;
    if (player.onShipId && this.state) {
      const ship = this.shipsById.get(player.onShipId) ?? null;
      if (ship) {
        const dx = player.position.x - ship.position.x;
        const dz = player.position.z - ship.position.z;
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        const localX = dx * cos - dz * sin;
        const localZ = dx * sin + dz * cos;
        const shipLead = Math.min(0.16, leadSeconds + snapshotAge * (isLocal ? 1 : 0.6));
        const predictedShipX = ship.position.x + ship.velocity.x * shipLead;
        const predictedShipZ = ship.position.z + ship.velocity.z * shipLead;
        const predictedShipRotation = ship.rotation + ship.angularVelocity * shipLead;
        const predictedCos = Math.cos(predictedShipRotation);
        const predictedSin = Math.sin(predictedShipRotation);
        predictedX = predictedShipX + localX * predictedCos + localZ * predictedSin
          + (player.velocity.x + player.knockbackVelocity.x * 0.32) * leadSeconds;
        predictedZ = predictedShipZ + localZ * predictedCos - localX * predictedSin
          + (player.velocity.z + player.knockbackVelocity.z * 0.32) * leadSeconds;
      }
    }
    // Lag compensation: extrapolate from last snapshot velocity only.
    // Do NOT add a second "input × speed × window" step on land or on ships — server velocity already
    // matches movement input each tick; duplicating it here caused rubber-banding (shuffle back/forth).
    if (isLocal && !player.atHelm && !player.atCannon && !player.atSails) {
      // On deck the server already couples you to the ship; full velocity×age extrapolation reads as double-counted lag.
      const deckDamp = player.onShipId ? 0.48 : 1;
      predictedX += player.velocity.x * snapshotAge * deckDamp;
      predictedZ += player.velocity.z * snapshotAge * deckDamp;
      visualY += player.velocity.y * snapshotAge * 0.3;
      const moveAxes = this.input.getMoveAxes();
      if (player.state !== 'swimming') {
        const moving = moveAxes.x !== 0 || moveAxes.z !== 0;
        const inputLead = Math.min(player.onShipId ? 0.07 : 0.12, snapshotAge + leadSeconds + 0.018);
        if (moving) {
          const len = Math.hypot(moveAxes.x, moveAxes.z) || 1;
          const nx = moveAxes.x / len;
          const nz = moveAxes.z / len;
          const yaw = this.input.getYaw();
          const desiredVx = (Math.sin(yaw) * nz - Math.cos(yaw) * nx) * PLAYER.MOVE_SPEED;
          const desiredVz = (Math.cos(yaw) * nz + Math.sin(yaw) * nx) * PLAYER.MOVE_SPEED;
          const response = player.onShipId ? 0.42 : 0.62;
          predictedX += (desiredVx - player.velocity.x) * inputLead * response;
          predictedZ += (desiredVz - player.velocity.z) * inputLead * response;
        } else {
          const stopLead = Math.min(player.onShipId ? 0.04 : 0.07, snapshotAge + leadSeconds);
          predictedX -= player.velocity.x * stopLead * 0.45;
          predictedZ -= player.velocity.z * stopLead * 0.45;
        }
      }
      if (player.state === 'swimming') {
        const predictionWindow = Math.min(0.22, snapshotAge + leadSeconds + 0.04);
        const verticalIntent = this.input.getSwimVerticalIntent();
        if (moveAxes.x !== 0 || moveAxes.z !== 0) {
          const yaw = this.input.getYaw();
          const pitch = this.input.getPitch();
          const len = Math.hypot(moveAxes.x, moveAxes.z) || 1;
          const nx = moveAxes.x / len;
          const nz = moveAxes.z / len;
          predictedX += (Math.sin(yaw) * nz - Math.cos(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          predictedZ += (Math.cos(yaw) * nz + Math.sin(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          visualY += Math.sin(pitch) * nz * PLAYER.SWIM_SPEED * predictionWindow * 0.72;
        }
        if (verticalIntent !== 0) {
          visualY += verticalIntent * PLAYER.SWIM_SPEED * predictionWindow * 0.68;
        }
      }
    }
    if (player.state === 'swimming') {
      const t = this.ocean.getTime();
      const swimStorm = getStormWaveIntensity(this.state?.storm, predictedX, predictedZ);
      const waveY = gerstnerHeight(predictedX, predictedZ, t, WAVE_PARAMS, swimStorm);
      const waterSurface = waveY + 0.28;
      const targetFeetY = waterSurface - 0.18;
      // Only snap the visual to the surface when the SERVER position is also
      // near the surface and the player isn't actively plunging. Otherwise the
      // snap was pulling the visual up to the surface during a deep cannon dive,
      // making it look like the player splashed without ever going under.
      const serverDepth = waterSurface - player.position.y;
      const plunging = player.velocity.y < -1.2;
      const depthBelowSurface = waterSurface - visualY;
      if (!plunging && serverDepth < 0.6 && depthBelowSurface < 1.15) {
        const waveSnap = isLocal ? 0.7 : 0.6;
        visualY = THREE.MathUtils.lerp(visualY, targetFeetY, waveSnap);
      } else if (!plunging && serverDepth < 1.4 && depthBelowSurface < 2.0 && player.velocity.y > -0.35) {
        // Gentle pull as the player surfaces and starts to bob with the waves
        visualY = THREE.MathUtils.lerp(visualY, targetFeetY, 0.14);
      }

      // Hull collision parity: mirror the authoritative resolveSwimmerShipCollision
      // so a swimmer never *visually* clips into a ship hull (or rubber-bands out
      // when the server correction arrives). Uses the same shared footprint math.
      if (!player.onShipId && !player.cannonBallistic && this.state) {
        const hullMargin = PLAYER.RADIUS + 0.18;
        for (const ship of this.state.ships) {
          if (!ship.alive || ship.sinking) continue;
          const stats = SHIP_STATS[ship.type];
          const band = getSwimHullVerticalBand(ship.position.y, stats);
          const dx = predictedX - ship.position.x;
          const dz = predictedZ - ship.position.z;
          const cos = Math.cos(ship.rotation);
          const sin = Math.sin(ship.rotation);
          const localX = dx * cos - dz * sin;
          const localZ = dx * sin + dz * cos;
          if (!isInsideSwimHullFootprint(stats, localX, localZ, hullMargin)) continue;
          if (visualY < band.keelY) {
            if (visualY > band.keelY - (PLAYER.HEIGHT + 0.4)) visualY = Math.min(visualY, band.keelY - 0.02);
            continue;
          }
          if (visualY > band.deckY + 0.35) continue;
          const out = pushOutOfSwimHullFootprint(stats, localX, localZ, hullMargin);
          if (!out.pushed) continue;
          predictedX = ship.position.x + out.x * cos + out.z * sin;
          predictedZ = ship.position.z + out.z * cos - out.x * sin;
        }
      }
    }
    // Match server: only treat as walkable island ground when inside the real footprint (not a huge ocean margin).
    // A loose margin here snapped feet to island height over the water past cliffs ("buffering" in mid-air).
    if (isLocal && !player.onShipId && this.state && player.state !== 'swimming') {
      let resolvedSurfaceY = -Infinity;
      for (const island of this.state.islands) {
        const rdx = predictedX - island.position.x;
        const rdz = predictedZ - island.position.z;
        const r2 = rdx * rdx + rdz * rdz;
        const islandReach = island.radius * 1.75 + 48;
        if (r2 > islandReach * islandReach) continue;

        if (isPointInsideIslandFootprint(island, predictedX, predictedZ, 0)) {
          // Mirror the server's islandStandY: inside a cave tunnel the
          // authoritative floor is the carved cave floor, 2-6m below the
          // natural hillside — snapping to the hilltop made players pop out
          // of caves and jitter against server corrections.
          let standY = getIslandSurfaceY(island, predictedX, predictedZ);
          const caveCeil = getCaveCeilingY(island, predictedX, predictedZ);
          if (caveCeil !== null && player.position.y < caveCeil - 0.1) {
            const caveFloor = getCaveFloorY(island, predictedX, predictedZ);
            if (caveFloor !== null && caveFloor < standY) standY = caveFloor;
          }
          resolvedSurfaceY = Math.max(resolvedSurfaceY, standY + 0.03);
        }
        // Rope-bridge decks are real floors (mirror the server's step gate).
        for (const islandBridge of island.bridges ?? []) {
          const deckY = getBridgeDeckY(islandBridge, predictedX, predictedZ);
          if (deckY !== null && player.position.y > deckY - 1.2) {
            resolvedSurfaceY = Math.max(resolvedSurfaceY, deckY + 0.03);
          }
        }
        if (island.dock) {
          const dx = predictedX - island.dock.position.x;
          const dz = predictedZ - island.dock.position.z;
          const cos = Math.cos(island.dock.rotation);
          const sin = Math.sin(island.dock.rotation);
          const localX = dx * cos - dz * sin;
          const localZ = dx * sin + dz * cos;
          if (Math.abs(localX) <= island.dock.width * 0.5 + 0.45 && Math.abs(localZ) <= island.dock.length * 0.5 + 0.45) {
            resolvedSurfaceY = Math.max(resolvedSurfaceY, island.dock.position.y + 0.14);
          }
        }
      }
      if (resolvedSurfaceY > -Infinity) {
        const clippedUnderTerrain = player.position.y < resolvedSurfaceY - 0.75;
        const settlingOntoGround =
          player.velocity.y <= 0.12
          && player.position.y <= resolvedSurfaceY + 0.22
          && player.position.y >= resolvedSurfaceY - 0.55;
        if (clippedUnderTerrain || settlingOntoGround) {
          const snap = clippedUnderTerrain ? 1 : 0.58;
          visualY = THREE.MathUtils.lerp(visualY, resolvedSurfaceY, snap);
        }
      }
    }
    this.tempRenderPos.set(predictedX, visualY, predictedZ);
    return this.tempRenderPos;
  }

  private getPlayerTeamColor(player: Player): number {
    const homeShip = player.shipId ? this.shipsById.get(player.shipId) ?? null : null;
    const currentShip = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    return homeShip?.teamColor
      ?? currentShip?.teamColor
      ?? (player.id === this.localPlayerId ? 0x6f2d22 : player.isBot ? 0x9a3340 : 0x365879);
  }

  private getPlayerTeamRole(player: Player): 'captain' | 'crew' | 'raider' {
    const homeShip = player.shipId ? this.shipsById.get(player.shipId) ?? null : null;
    if (homeShip?.ownerId === player.id) return 'captain';
    return player.shipId ? 'crew' : 'raider';
  }

  private syncPlayers(dt: number) {
    if (!this.state) return;

    for (const [playerId, mesh] of this.playerMeshes) {
      if (!this.livePlayerIds.has(playerId)) {
        this.renderer.scene.remove(mesh);
        this.playerMeshes.delete(playerId);
      }
    }

    for (const player of this.state.players) {
      const playerIsSkeleton = player.isBot && player.shipId === null;
      const playerTeamColor = playerIsSkeleton ? 0xd7d1c4 : this.getPlayerTeamColor(player);
      let mesh = this.playerMeshes.get(player.id);
      if (!mesh) {
        mesh = makePlayerMesh(
          playerTeamColor,
          playerIsSkeleton ? 'skeleton' : 'pirate',
          playerIsSkeleton ? 'crew' : this.getPlayerTeamRole(player),
        );
        // Floating username over every OPPONENT's head (not yourself).
        if (player.id !== this.localPlayerId) {
          mesh.add(makeNameplateSprite(player.name));
        }
        this.playerMeshes.set(player.id, mesh);
        this.renderer.scene.add(mesh);
      } else if (!playerIsSkeleton) {
        applyPlayerTeamColor(mesh, playerTeamColor);
      }

      const isLocal = player.id === this.localPlayerId;
      // Nameplate: shown for living opponents within ~85m, hidden when downed/gone.
      const plate = mesh.getObjectByName('nameplate');
      if (plate) {
        const ndist = this.distance2D(this.renderer.camera.position.x, this.renderer.camera.position.z, player.position.x, player.position.z);
        plate.visible = !isLocal && player.state === 'alive' && ndist < 85;
      }
      const ship = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
      const hideForLocalAim = isLocal;
      const useLocalSwimViewmodel = false;

      const targetPos = this.getPlayerRenderPosition(player, isLocal ? (player.state === 'swimming' ? 0.05 : player.cannonBallistic ? 0.06 : 0.055) : player.cannonBallistic ? 0.05 : 0.035);
      const onIslandFoot = !player.onShipId && player.state === 'alive';
      const movementKey = `${player.state}|${player.onShipId ?? 'off'}|${onIslandFoot ? 'isle' : 'open'}|${player.cannonBallistic ? 'bal' : 'nb'}`;
      const ud = mesh.userData as { movementKey?: string; transitionBoost?: number };
      if (ud.movementKey !== movementKey) {
        ud.movementKey = movementKey;
        ud.transitionBoost = 0.38;
      }
      if (ud.transitionBoost && ud.transitionBoost > 0) {
        ud.transitionBoost = Math.max(0, ud.transitionBoost - dt * 2.8);
      }
      const boost = isLocal && (ud.transitionBoost ?? 0) > 0 ? (ud.transitionBoost ?? 0) * 88 : 0;
      const basePosRate = isLocal
        ? (player.cannonBallistic
          ? 165
          : onIslandFoot
            ? 82
            : player.onShipId && player.state === 'alive'
              ? 76
              : player.state === 'swimming'
                ? 128
                : 64)
        : (player.cannonBallistic ? 120 : onIslandFoot ? 38 : player.state === 'swimming' ? 72 : 32);
      const positionAlpha = 1 - Math.exp(-(basePosRate + boost) * dt);
      const rotationAlpha = 1 - Math.exp(-18 * dt);
      const targetYaw = player.atHelm && ship
        ? ship.rotation
        : isLocal
          ? this.input.getYaw()
          : player.rotation.x;
      const isSkeleton = mesh.userData.animation?.variant === 'skeleton';
      const lastState = mesh.userData.lastState as Player['state'] | undefined;
      if (isSkeleton && lastState !== 'eliminated' && player.state === 'eliminated') {
        mesh.userData.deathTimer = 0;
        mesh.userData.deathSpin = Math.random() > 0.5 ? 1 : -1;
      }
      mesh.userData.lastState = player.state;
      if (isSkeleton && player.state === 'eliminated') {
        mesh.userData.deathTimer = Math.min((mesh.userData.deathTimer ?? 0) + dt, 1.8);
      }

      const skeletonDeathVisible = isSkeleton && player.state === 'eliminated' && (mesh.userData.deathTimer ?? 0) < 1.55;
      mesh.visible = !isLocal && !useLocalSwimViewmodel && (skeletonDeathVisible || (player.state !== 'eliminated' && player.state !== 'respawning'));
      if (!mesh.userData.initialized) {
        mesh.position.copy(targetPos);
        mesh.rotation.y = targetYaw;
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
        mesh.userData.initialized = true;
      } else {
        if (mesh.position.distanceToSquared(targetPos) > (isLocal ? 20 * 20 : 34 * 34)) {
          mesh.position.copy(targetPos);
        } else {
          mesh.position.lerp(targetPos, positionAlpha);
        }
        mesh.rotation.y += angleWrap(targetYaw - mesh.rotation.y) * (isLocal ? 1 : rotationAlpha);
      }

      // Downed pirates read prone at a glance: tipped onto their side, sunk to
      // ground level, with a slow pained sway while they crawl/bleed out.
      const downedLean = mesh.userData.downedLean as number | undefined ?? 0;
      const downedTarget = player.state === 'downed' ? 1 : 0;
      const nextLean = downedLean + (downedTarget - downedLean) * Math.min(1, dt * 6);
      mesh.userData.downedLean = nextLean;
      if (nextLean > 0.002) {
        mesh.rotation.z = (Math.PI * 0.42 + Math.sin(this.ocean.getTime() * 1.7) * 0.05) * nextLean;
        mesh.position.y -= 0.55 * nextLean;
      } else if (mesh.rotation.z !== 0 && player.state !== 'eliminated') {
        mesh.rotation.z = 0;
      }

      const healthBar = mesh.userData.healthBar as {
        root: THREE.Group;
        fill: THREE.Mesh;
        fullWidth: number;
      } | undefined;
      if (healthBar) {
        const distanceToCamera = mesh.position.distanceTo(this.renderer.camera.position);
        const showHealthBar =
          !isLocal
          && mesh.visible
          && player.state !== 'eliminated'
          && player.state !== 'respawning'
          && distanceToCamera < 90;
        healthBar.root.visible = showHealthBar;
        if (showHealthBar) {
          const ratio = THREE.MathUtils.clamp(player.health / PLAYER.MAX_HEALTH, 0, 1);
          healthBar.root.position.y = player.state === 'swimming' ? 1.55 : 2.38;
          this.tempHudVector.copy(this.renderer.camera.position);
          mesh.worldToLocal(this.tempHudVector);
          healthBar.root.lookAt(this.tempHudVector);
          healthBar.fill.scale.x = Math.max(0.001, ratio);
          healthBar.fill.position.x = -(healthBar.fullWidth * 0.5) + (healthBar.fullWidth * ratio) * 0.5;
          const fillMat = healthBar.fill.material as THREE.MeshBasicMaterial;
          if (player.state === 'downed') {
            // Downed: show bleed-out red, or revive teal while a mate holds X.
            if ((player.reviveProgress ?? 0) > 0) {
              fillMat.color.setHSL(0.45, 0.75, 0.55);
              healthBar.fill.scale.x = Math.max(0.001, player.reviveProgress ?? 0);
            } else {
              fillMat.color.setHSL(0.995, 0.85, 0.5);
            }
            fillMat.opacity = 0.9;
          } else {
            fillMat.color.setHSL(0.02 + ratio * 0.31, 0.82, 0.56);
            fillMat.opacity = 0.68 + ratio * 0.28;
          }
        }
      }

      const head = mesh.getObjectByName('head');
      const hair = mesh.getObjectByName('hair');
      const bandana = mesh.getObjectByName('bandana');
      const animParts = (mesh.userData.animation?.parts ?? {}) as Record<string, THREE.Object3D | undefined>;
      const torso = animParts.torso;
      const shirt = animParts.shirt;
      const coatSkirt = animParts.coatSkirt ?? animParts['coat-skirt'];
      const leftArmPivot = animParts.leftArmPivot ?? animParts['left-arm-pivot'];
      const showHead = (!isLocal || !this.input.isAiming()) && !hideForLocalAim;
      if (head) head.visible = showHead;
      if (hair) hair.visible = showHead && !isSkeleton;
      if (bandana) bandana.visible = showHead && !isSkeleton;
      if (torso) torso.visible = !isSkeleton && !hideForLocalAim;
      if (shirt) shirt.visible = !isSkeleton && !hideForLocalAim;
      if (coatSkirt) coatSkirt.visible = !isSkeleton && !hideForLocalAim;
      if (leftArmPivot) leftArmPivot.visible = !hideForLocalAim;

      if (player.state === 'swimming') {
        const swimBodyPitch = THREE.MathUtils.clamp(-Math.PI * 0.56 + player.rotation.y * 0.7, -1.18, -0.18);
        mesh.rotation.x += (swimBodyPitch - mesh.rotation.x) * Math.min(1, dt * 14);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      } else if (skeletonDeathVisible) {
        const deathProgress = Math.min(1, (mesh.userData.deathTimer ?? 0) / 0.75);
        const deathSpin = mesh.userData.deathSpin ?? 1;
        mesh.rotation.x += (-0.95 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (deathSpin * 0.85 - mesh.rotation.z) * Math.min(1, dt * 10);
        mesh.position.y -= deathProgress * dt * 0.35;
      } else {
        mesh.rotation.x += (0 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      }

      if (skeletonDeathVisible) {
        this.anim.animateSkeletonDeath(mesh);
      } else {
        this.anim.animatePlayerMesh(mesh, player, ship, dt);
      }
      this.syncHeldWeapon(mesh, player);
    }
  }

  private syncProjectiles(dt: number) {
    if (!this.state) return;

    for (const [projectileId, mesh] of this.projectileMeshes) {
      if (!this.liveProjectileIds.has(projectileId)) {
        const projectileType = mesh.userData.projectileType as Projectile['type'] | undefined;
        const showImpact = mesh.userData.showImpact as boolean | undefined;
        if (projectileType && showImpact !== false) {
          this.combatFx.emitImpact(
            projectileType,
            { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
            this.renderer.camera.position,
          );
          // Chainshot that dies above the water almost certainly caught rigging —
          // tear canvas audibly (visual scraps come from emitImpact's chainshot case).
          if (projectileType === 'chainshot' && mesh.position.y > 0.9) {
            const d = this.distance2D(
              this.renderer.camera.position.x, this.renderer.camera.position.z,
              mesh.position.x, mesh.position.z,
            );
            this.audio.playSailRip(d);
          }
        }
        this.lastChainshotWhirrAt.delete(projectileId);
        this.renderer.scene.remove(mesh);
        this.disposeSceneObject(mesh);
        this.projectileMeshes.delete(projectileId);
      }
    }

    for (const projectile of this.state.projectiles) {
      if (!projectile.alive) continue;
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        mesh = makeProjectileMesh(projectile);
        this.projectileMeshes.set(projectile.id, mesh);
        this.renderer.scene.add(mesh);
        mesh.position.set(projectile.position.x, projectile.position.y, projectile.position.z);
        mesh.userData.projectileType = projectile.type;
        mesh.userData.showImpact = projectile.showImpact;
        this.combatFx.emitLaunch(projectile, this.renderer.camera.position, projectile.ownerId === this.localPlayerId);
        // Own-ship broadside just fired — brief FOV pop + a touch of shake.
        if (projectile.ownerShipId && projectile.ownerShipId === this.localShipId && projectile.type !== 'bullet') {
          this.cameraShakeCannon = 1;
          this.cameraShake = Math.min(1, this.cameraShake + 0.18);
        }
      }
      mesh.userData.projectileType = projectile.type;
      mesh.userData.showImpact = projectile.showImpact;
      mesh.position.lerp(
        this.tempProjectilePos.set(projectile.position.x, projectile.position.y, projectile.position.z),
        1 - Math.exp(-24 * dt),
      );
      if (projectile.type === 'tsunami') {
        mesh.rotation.y = Math.atan2(projectile.velocity.x, projectile.velocity.z);
        const life = 1 - Math.min(1, projectile.age / Math.max(0.001, projectile.maxAge));
        mesh.scale.set(1 + projectile.age * 0.18, 1 + (1 - life) * 0.35, 1 + projectile.age * 0.55);
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = Math.max(0, 0.42 * life);
      } else if (mesh.userData.chainshot) {
        // Whirl the ball-and-chain in flight; lay a pale trail; whistle by distance.
        mesh.rotation.y += dt * 15;
        mesh.rotation.x += dt * 5.5;
        this.combatFx.emitTrail(projectile.position, 0x9fd0ff);
        const nowT = this.ocean.getTime();
        const last = this.lastChainshotWhirrAt.get(projectile.id) ?? -1;
        if (nowT - last > 0.5) {
          const d = this.distance2D(
            this.renderer.camera.position.x, this.renderer.camera.position.z,
            projectile.position.x, projectile.position.z,
          );
          this.audio.playChainshotWhirr(d);
          this.lastChainshotWhirrAt.set(projectile.id, nowT);
        }
      }
    }
  }

  private syncKegs(dt: number) {
    if (!this.state) return;

    for (const [kegId, mesh] of this.kegMeshes) {
      if (!this.liveKegIds.has(kegId)) {
        this.renderer.scene.remove(mesh.root);
        this.disposeSceneObject(mesh.root);
        this.kegMeshes.delete(kegId);
      }
    }

    for (const keg of this.state.kegs) {
      if (keg.timer <= 0) continue;
      let mesh = this.kegMeshes.get(keg.id);
      let created = false;
      if (!mesh) {
        const root = new THREE.Group();
        const mega = !!keg.mega;
        const kegGlb = mega
          ? assets.cloneTinted('keg', 'Wood_Dark', 0x1d0e08)
          : assets.clone('keg');
        if (kegGlb) {
          kegGlb.scale.setScalar(0.62);
          kegGlb.position.y = -0.3;
          root.add(kegGlb);
        } else {
          const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.26, 0.58, 10),
            new THREE.MeshStandardMaterial({
              color: mega ? 0x2a1510 : 0x5a3418,
              emissive: mega ? 0x4a0f08 : 0x000000,
              emissiveIntensity: mega ? 0.26 : 0,
              roughness: 0.92,
            }),
          );
          barrel.castShadow = true;
          root.add(barrel);

          const bandMat = new THREE.MeshStandardMaterial({ color: mega ? 0xd89b3a : 0x2b2b2b, roughness: 0.45, metalness: 0.85 });
          for (const y of [-0.18, 0.18]) {
            const band = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 10), bandMat);
            band.rotation.x = Math.PI * 0.5;
            band.position.y = y;
            root.add(band);
          }

          const fuseStem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.018, 0.018, 0.22, 6),
            new THREE.MeshStandardMaterial({ color: 0x2b1f12, roughness: 1 }),
          );
          fuseStem.position.set(0.04, 0.36, 0);
          root.add(fuseStem);
        }

        const fuse = new THREE.PointLight(mega ? 0xff3226 : 0xff7a26, mega ? 2.2 : 1.2, mega ? 6.5 : 3.5);
        fuse.position.set(0.04, 0.48, 0);
        root.add(fuse);
        root.scale.setScalar(mega ? 1.55 : 1);

        this.renderer.scene.add(root);
        mesh = { root, fuse };
        this.kegMeshes.set(keg.id, mesh);
        created = true;
      }

      // Ship-mounted kegs re-base onto the CLIENT's ship transform from their
      // ship-local position (like players do) — raw server world coords lag
      // the rendered deck on a moving/turning ship and slid the keg around.
      const kegHostShip = keg.shipId ? this.shipsById.get(keg.shipId) ?? null : null;
      if (kegHostShip && keg.localPosition) {
        const cos = Math.cos(kegHostShip.rotation);
        const sin = Math.sin(kegHostShip.rotation);
        this.tempKegPos.set(
          kegHostShip.position.x + keg.localPosition.x * cos + keg.localPosition.z * sin,
          kegHostShip.position.y + keg.localPosition.y + 0.28,
          kegHostShip.position.z + keg.localPosition.z * cos - keg.localPosition.x * sin,
        );
      } else {
        this.tempKegPos.set(keg.position.x, keg.position.y + 0.28, keg.position.z);
      }
      const moveAlpha = 1 - Math.exp(-28 * dt);
      if (created || mesh.root.position.distanceToSquared(this.tempKegPos) > 16 * 16) {
        mesh.root.position.copy(this.tempKegPos);
      } else {
        mesh.root.position.lerp(this.tempKegPos, moveAlpha);
      }
      const hostShip = keg.shipId ? this.shipsById.get(keg.shipId) ?? null : null;
      const targetYaw = hostShip?.rotation ?? 0;
      mesh.root.rotation.y += angleWrap(targetYaw - mesh.root.rotation.y) * (1 - Math.exp(-24 * dt));
      const megaBoost = keg.mega ? 1.75 : 1;
      mesh.root.scale.setScalar(keg.mega ? 1.55 : 1);
      mesh.fuse.intensity = megaBoost * (0.6 + Math.max(0.2, Math.sin((SHIP.KEG_FUSE_TIME - keg.timer) * 12) * 0.35 + (1 - Math.min(1, keg.timer / SHIP.KEG_FUSE_TIME)) * 2.1));
    }
  }

  private syncChests() {
    if (!this.state) return;
    const showGlow = this.renderer.getQuality() !== 'low';

    for (const island of this.state.islands) {
      for (const chest of island.chests) {
        const chestMesh = this.chestMeshes.get(chest.id);
        if (!chestMesh) continue;
        chestMesh.root.position.set(chest.position.x, chest.position.y, chest.position.z);
        const carriedByLocal = chest.carriedByPlayerId === this.localPlayerId;
        chestMesh.root.visible = !chest.opened && !carriedByLocal;
        const portable = !!chest.carriedByPlayerId || !!chest.storedOnShipId || chest.floating;
        const dug = portable || chest.digProgress >= 1;
        if (chest.buried && chestMesh.mound) {
          chestMesh.mound.visible = !chest.opened && !portable && !dug;
          const s = Math.max(0.06, 1 - chest.digProgress * 0.95);
          chestMesh.mound.scale.setScalar(s);
        }
        chestMesh.chestMesh.visible = !chest.opened && (!chest.buried || dug);
        chestMesh.lid.visible = chestMesh.chestMesh.visible;
        chestMesh.glow.visible = showGlow && !chest.opened && (dug || !chest.buried) && !carriedByLocal;
        chestMesh.glow.intensity = chest.floating ? 1.45 : chest.carriedByPlayerId ? 1.15 : 0.9;
        if (chestMesh.chestMesh.visible) {
          chestMesh.glow.position.set(0, 1.2, 0);
        }
      }
    }
  }

  private syncBarrels() {
    if (!this.state) return;
    for (const island of this.state.islands) {
      for (const barrel of island.barrels) {
        const root = this.barrelMeshes.get(barrel.id);
        if (!root) continue;
        root.visible = !barrel.opened || barrel.loot.length > 0;
      }
    }
  }

  private syncSharks(dt: number) {
    if (!this.state) return;
    const sharks = this.state.sharks ?? [];
    const seen = new Set<string>();
    for (const shark of sharks) {
      if (shark.health <= 0) continue;
      seen.add(shark.id);
      let mesh = this.sharkMeshes.get(shark.id);
      let created = false;
      if (!mesh) {
        mesh = this.buildSharkMesh();
        this.environment.add(mesh);
        this.sharkMeshes.set(shark.id, mesh);
        created = true;
      }
      this.tempSharkPos.set(shark.position.x, shark.position.y + 0.15, shark.position.z);
      const moveAlpha = 1 - Math.exp(-18 * dt);
      if (created || mesh.position.distanceToSquared(this.tempSharkPos) > 55 * 55) {
        mesh.position.copy(this.tempSharkPos);
      } else {
        mesh.position.lerp(this.tempSharkPos, moveAlpha);
      }
      mesh.rotation.y += angleWrap(shark.rotation - mesh.rotation.y) * (1 - Math.exp(-16 * dt));

      // ── Telegraphed attack animation (attackState rides hot snapshots) ──
      const attackState: SharkAttackState = shark.attackState ?? 'cruise';
      const prevAttack = this.sharkPrevAttackState.get(shark.id);
      if (attackState !== prevAttack) {
        const camDist = this.renderer.camera.position.distanceTo(this.tempSharkPos);
        if (attackState === 'windup') {
          // The dodge window opens: warning ripple + low growl, once per windup.
          this.combatFx.emitSharkTelegraph(shark.position);
          this.audio.playSharkGrowl(camDist);
        } else if (attackState === 'lunge' && prevAttack === 'windup') {
          this.combatFx.emitSharkLungeSplash(shark.position, this.renderer.camera.position);
          this.audio.playSharkChomp(camDist);
        }
        this.sharkPrevAttackState.set(shark.id, attackState);
      }
      const t = this.ocean.getTime();
      const swimSpeed = Math.hypot(shark.velocity.x, shark.velocity.z);
      let tailAmp: number;
      let tailHz: number;
      let jawTarget: number;
      let pecTarget = 0;
      let pitchTarget = 0;
      let rollTarget = 0;
      switch (attackState) {
        case 'windup': {
          // Rear back, jaw gapes, pecs flare — the readable pre-lunge pose.
          const wind = THREE.MathUtils.clamp(1 - (shark.attackTimer ?? 0) / SHARK.WINDUP_TIME, 0, 1);
          tailAmp = 0.15;
          tailHz = 2.2;
          jawTarget = 0.55 * Math.max(0.4, wind);
          pecTarget = 0.5;
          pitchTarget = -0.12;
          break;
        }
        case 'lunge': // jaw snaps shut, tail thrashes hard
          tailAmp = 0.8;
          tailHz = 6.5;
          jawTarget = 0.06;
          break;
        case 'recover': // everything droops — the vulnerable beat
          tailAmp = 0.12;
          tailHz = 1.6;
          jawTarget = 0.1;
          rollTarget = 0.14;
          break;
        default: // cruise
          tailAmp = 0.35;
          tailHz = 2.2 * THREE.MathUtils.clamp(0.5 + swimSpeed / 6, 0.5, 1.6);
          jawTarget = 0.02;
          break;
      }
      const parts = mesh.userData.parts as Record<string, THREE.Object3D | undefined> | undefined;
      const ease = 1 - Math.exp(-10 * dt);
      if (parts?.shark_tail) parts.shark_tail.rotation.y = Math.sin(t * Math.PI * 2 * tailHz + mesh.position.x * 0.1) * tailAmp;
      if (parts?.shark_jaw) parts.shark_jaw.rotation.x += (jawTarget - parts.shark_jaw.rotation.x) * ease;
      if (parts?.shark_pec_l) parts.shark_pec_l.rotation.z += (pecTarget - parts.shark_pec_l.rotation.z) * ease;
      if (parts?.shark_pec_r) parts.shark_pec_r.rotation.z += (-pecTarget - parts.shark_pec_r.rotation.z) * ease;
      mesh.rotation.x += (pitchTarget - mesh.rotation.x) * ease;
      mesh.rotation.z += (rollTarget - mesh.rotation.z) * ease;
    }
    for (const [id, mesh] of this.sharkMeshes) {
      if (!seen.has(id)) {
        this.combatFx.emitSharkDeathBloom(
          { x: mesh.position.x, y: mesh.position.y - 0.12, z: mesh.position.z },
          this.renderer.camera.position,
        );
        this.environment.remove(mesh);
        this.sharkMeshes.delete(id);
        this.sharkPrevAttackState.delete(id);
      }
    }
  }

  private syncWildlife(dt: number) {
    if (!this.state) return;
    const seen = new Set<string>();
    const t = this.ocean.getTime();
    for (const animal of this.state.wildlife ?? []) {
      if (animal.health <= 0) continue;
      seen.add(animal.id);
      let mesh = this.wildlifeMeshes.get(animal.id);
      let created = false;
      if (!mesh) {
        mesh = this.buildWildlifeMesh(animal);
        this.environment.add(mesh);
        this.wildlifeMeshes.set(animal.id, mesh);
        created = true;
      }

      this.tempWildlifePos.set(animal.position.x, animal.position.y, animal.position.z);
      const alpha = 1 - Math.exp(-16 * dt);
      if (created || mesh.position.distanceToSquared(this.tempWildlifePos) > 18 * 18) {
        mesh.position.copy(this.tempWildlifePos);
      } else {
        mesh.position.lerp(this.tempWildlifePos, alpha);
      }
      mesh.rotation.y += angleWrap(animal.rotation - mesh.rotation.y) * (1 - Math.exp(-14 * dt));
      mesh.position.y += animal.type === 'gull'
        ? Math.sin(t * 8 + animal.position.x * 0.03) * 0.025
        : Math.sin(t * 10 + animal.position.x * 0.07) * 0.01;

      const parts = mesh.userData.parts as Record<string, THREE.Object3D | undefined> | undefined;
      const phase = t * (animal.type === 'gull' ? 9.5 : animal.type === 'chicken' ? 11 : animal.type === 'crab' ? 14 : 6.5)
        + animal.position.x * 0.04
        + animal.position.z * 0.03;
      if (parts?.leftWing) parts.leftWing.rotation.z = 0.35 + Math.sin(phase) * 0.55;
      if (parts?.rightWing) parts.rightWing.rotation.z = -0.35 - Math.sin(phase) * 0.55;
      if (parts?.head) parts.head.rotation.y = Math.sin(phase * 0.55) * 0.22;
      if (parts?.body) parts.body.rotation.z = Math.sin(phase) * (animal.type === 'crab' ? 0.035 : 0.02);
      for (let leg = 0; leg < 6; leg++) {
        const limb = parts?.[`leg${leg}`];
        if (limb) limb.rotation.z = (leg % 2 === 0 ? 1 : -1) * (0.18 + Math.sin(phase + leg) * 0.16);
      }
    }

    for (const [id, mesh] of this.wildlifeMeshes) {
      if (!seen.has(id)) {
        this.combatFx.emitSharkDeathBloom(
          { x: mesh.position.x, y: mesh.position.y + 0.12, z: mesh.position.z },
          this.renderer.camera.position,
        );
        this.environment.remove(mesh);
        this.wildlifeMeshes.delete(id);
      }
    }
  }

  private buildWildlifeMesh(animal: WildlifeAnimal): THREE.Group {
    // Blender GLB first (authored in parallel — standard part names drive the
    // same sync animation); missing asset keeps the procedural fallback.
    const glb = assets.clone(animal.type as string as AssetName);
    if (glb) {
      const glbGroup = new THREE.Group();
      glbGroup.name = `wildlife-${animal.id}`;
      glbGroup.add(glb);
      const glbParts: Record<string, THREE.Object3D> = {};
      for (const partName of ['body', 'head', 'leftWing', 'rightWing', 'leg0', 'leg1', 'leg2', 'leg3', 'leg4', 'leg5']) {
        const node = glb.getObjectByName(partName);
        if (node) glbParts[partName] = node;
      }
      glbGroup.userData.parts = glbParts;
      return glbGroup;
    }

    const group = new THREE.Group();
    group.name = `wildlife-${animal.id}`;
    const parts: Record<string, THREE.Object3D> = {};
    group.userData.parts = parts;

    const add = (name: string, mesh: THREE.Object3D) => {
      mesh.name = name;
      parts[name] = mesh;
      group.add(mesh);
      return mesh;
    };

    if (this.renderer.getQuality() === 'low') {
      const color =
        animal.type === 'crab' ? 0xb53a2b :
        animal.type === 'chicken' ? 0xe8dcc4 :
        animal.type === 'pig' ? 0xc58d7d :
        0xf2f0e8;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), mat));
      body.position.y = animal.type === 'gull' ? 0 : animal.type === 'crab' ? 0.08 : 0.28;
      body.scale.set(
        animal.type === 'pig' ? 2.0 : animal.type === 'crab' ? 1.45 : animal.type === 'gull' ? 1.45 : 1.05,
        animal.type === 'pig' ? 1.05 : animal.type === 'crab' ? 0.42 : animal.type === 'gull' ? 0.72 : 1.2,
        animal.type === 'pig' ? 1.0 : animal.type === 'crab' ? 0.9 : 0.85,
      );

      if (animal.type !== 'crab') {
        const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), mat));
        head.position.set(animal.type === 'pig' ? 0.42 : 0.18, body.position.y + 0.16, 0);
      }

      if (animal.type === 'gull') {
        const wingMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.82, side: THREE.DoubleSide });
        for (const side of [-1, 1]) {
          const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.16), wingMat));
          wing.position.set(0, 0.0, side * 0.16);
          wing.rotation.set(0.12, 0, side * 0.42);
        }
      }

      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = false;
          obj.receiveShadow = false;
        }
      });
      return group;
    }

    if (animal.type === 'crab') {
      const mat = new THREE.MeshStandardMaterial({ color: 0xb53a2b, roughness: 0.86 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 5), mat));
      body.scale.set(1.35, 0.48, 0.9);
      for (const side of [-1, 1]) {
        const claw = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), mat);
        claw.position.set(0.2, 0.02, side * 0.18);
        claw.scale.set(1.3, 0.7, 1);
        group.add(claw);
        for (let leg = 0; leg < 3; leg++) {
          const limb = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.018, 0.026), mat);
          limb.position.set(-0.05 - leg * 0.055, -0.03, side * (0.12 + leg * 0.055));
          limb.rotation.y = side * (0.55 + leg * 0.18);
          add(`leg${side > 0 ? leg : leg + 3}`, limb);
        }
      }
    } else if (animal.type === 'chicken') {
      const feather = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.92 });
      const red = new THREE.MeshStandardMaterial({ color: 0xb82e24, roughness: 0.8 });
      const beak = new THREE.MeshStandardMaterial({ color: 0xd9a33f, roughness: 0.75 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), feather));
      body.scale.set(1.0, 1.15, 0.82);
      body.position.y = 0.22;
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), feather));
      head.position.set(0.18, 0.43, 0);
      const crest = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), red);
      crest.position.set(0.18, 0.55, 0);
      group.add(crest);
      const bill = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 5), beak);
      bill.position.set(0.29, 0.43, 0);
      bill.rotation.z = -Math.PI * 0.5;
      group.add(bill);
      for (const side of [-1, 1]) {
        const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.14), feather));
        wing.position.set(0.02, 0.25, side * 0.16);
        wing.rotation.y = side * 0.65;
      }
    } else if (animal.type === 'pig') {
      const skin = new THREE.MeshStandardMaterial({ color: 0xc58d7d, roughness: 0.88 });
      const snoutMat = new THREE.MeshStandardMaterial({ color: 0xe2a69a, roughness: 0.86 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), skin));
      body.scale.set(1.45, 0.82, 0.86);
      body.position.y = 0.34;
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 7), skin));
      head.position.set(0.45, 0.43, 0);
      const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.1, 8), snoutMat);
      snout.rotation.z = Math.PI * 0.5;
      snout.position.set(0.62, 0.42, 0);
      group.add(snout);
      for (let i = 0; i < 4; i++) {
        const leg = add(`leg${i}`, new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.28, 6), skin));
        leg.position.set(i < 2 ? -0.22 : 0.24, 0.05, i % 2 === 0 ? -0.18 : 0.18);
      }
    } else {
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.78 });
      const wingMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.82, side: THREE.DoubleSide });
      const beakMat = new THREE.MeshStandardMaterial({ color: 0xd3a13b, roughness: 0.76 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.14, 9, 6), bodyMat));
      body.scale.set(1.35, 0.72, 0.85);
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 5), bodyMat));
      head.position.set(0.18, 0.08, 0);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 5), beakMat);
      beak.position.set(0.27, 0.08, 0);
      beak.rotation.z = -Math.PI * 0.5;
      group.add(beak);
      for (const side of [-1, 1]) {
        const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.16), wingMat));
        wing.position.set(0, 0.0, side * 0.14);
        wing.rotation.set(0.12, 0, side * 0.42);
      }
    }

    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return group;
  }

  private buildSharkMesh(): THREE.Group {
    // Blender GLB first (authored in parallel); the standard part names let
    // syncSharks drive GLB and procedural sharks with the same code.
    const glb = assets.clone('shark' as string as AssetName);
    if (glb) {
      const glbGroup = new THREE.Group();
      glbGroup.add(glb);
      const glbParts: Record<string, THREE.Object3D> = {};
      for (const partName of ['shark_tail', 'shark_jaw', 'shark_pec_l', 'shark_pec_r']) {
        const node = glb.getObjectByName(partName);
        if (node) glbParts[partName] = node;
      }
      glbGroup.userData.parts = glbParts;
      return glbGroup;
    }

    const g = new THREE.Group();
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2a4a5c, roughness: 0.82, metalness: 0.08 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0x8aa8b8, roughness: 0.75, metalness: 0.02 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x3a5c6e, roughness: 0.78, metalness: 0.05 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x071016, roughness: 0.9 });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xf4ead0, roughness: 0.62 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.48, 14, 12), topMat);
    body.scale.set(1.15, 0.72, 2.35);
    body.rotation.y = Math.PI * 0.5;
    body.position.y = 0.08;
    body.castShadow = true;
    g.add(body);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), bellyMat);
    belly.scale.set(0.95, 0.55, 2.0);
    belly.rotation.y = Math.PI * 0.5;
    belly.position.set(0, -0.12, 0);
    g.add(belly);

    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.95, 10), topMat);
    snout.rotation.z = -Math.PI * 0.5;
    snout.position.set(1.12, 0.02, 0);
    snout.castShadow = true;
    g.add(snout);

    // Tail pivot — syncSharks swings rotation.y for the swim/thrash cycle.
    const parts: Record<string, THREE.Object3D> = {};
    g.userData.parts = parts;
    const tailPivot = new THREE.Group();
    tailPivot.name = 'shark_tail';
    tailPivot.position.set(-0.9, 0.1, 0);
    g.add(tailPivot);
    parts.shark_tail = tailPivot;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.62, 8), finMat);
    tail.rotation.z = Math.PI * 0.5;
    tail.position.set(-0.15, 0.02, 0);
    tail.castShadow = true;
    tailPivot.add(tail);

    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.62, 6), finMat);
    dorsal.position.set(0.05, 0.52, 0);
    dorsal.rotation.z = Math.PI * 0.5;
    g.add(dorsal);

    // Pec pivots carry a zero neutral so syncSharks can flare rotation.z
    // directly; the base fin angle is baked into the mesh inside.
    for (const side of [1, -1] as const) {
      const pecPivot = new THREE.Group();
      pecPivot.name = side > 0 ? 'shark_pec_l' : 'shark_pec_r';
      pecPivot.position.set(0.35, -0.18, side * 0.42);
      const pec = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.38), finMat);
      pec.rotation.set(0.2, 0, side * 0.35);
      pecPivot.add(pec);
      g.add(pecPivot);
      parts[pecPivot.name] = pecPivot;
    }

    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.3 }));
    eyeL.position.set(0.82, 0.18, 0.16);
    g.add(eyeL);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.16;
    g.add(eyeR);

    // Jaw pivot: yawed π/2 so the child's local +Z runs down the snout —
    // syncSharks opens the bite with plain rotation.x, matching GLB jaws.
    const jawPivot = new THREE.Group();
    jawPivot.position.set(1.05, -0.08, 0);
    jawPivot.rotation.y = Math.PI * 0.5;
    g.add(jawPivot);
    const jaw = new THREE.Group();
    jaw.name = 'shark_jaw';
    jawPivot.add(jaw);
    parts.shark_jaw = jaw;
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.3), darkMat);
    mouth.position.set(0, -0.04, 0.21);
    mouth.rotation.x = 0.12;
    jaw.add(mouth);

    for (let i = 0; i < 7; i++) {
      const lx = -(-0.18 + i * 0.06);
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 4), toothMat);
      tooth.position.set(lx, -0.08, 0.23);
      tooth.rotation.x = Math.PI;
      tooth.rotation.z = i % 2 === 0 ? 0.12 : -0.12;
      jaw.add(tooth);
    }

    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const slit = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.012), darkMat);
        slit.position.set(0.55 - i * 0.07, 0.04, side * 0.36);
        slit.rotation.set(0.25, 0, side * 0.48);
        g.add(slit);
      }

      const flankStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.025, 0.018),
        new THREE.MeshStandardMaterial({ color: 0x1d3544, roughness: 0.9 }),
      );
      flankStripe.position.set(-0.12, 0.2, side * 0.44);
      flankStripe.rotation.set(0.12, 0, side * 0.2);
      g.add(flankStripe);
    }

    const tailTop = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, 0.08), finMat);
    tailTop.position.set(-0.55, 0.24, 0);
    tailTop.rotation.z = -0.42;
    tailPivot.add(tailTop);
    const tailBottom = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.08), finMat);
    tailBottom.position.set(-0.53, -0.28, 0);
    tailBottom.rotation.z = 0.52;
    tailPivot.add(tailBottom);

    const rearDorsal = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 5), finMat);
    rearDorsal.position.set(-0.62, 0.38, 0);
    rearDorsal.rotation.z = Math.PI * 0.5;
    g.add(rearDorsal);

    return g;
  }

  private updateUpgradeStations(dt: number) {
    if (!this.state) return;

    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const mesh = this.upgradeStationMeshes.get(station.id);
        if (!mesh) continue;

        const meta = this.getUpgradePresentation(mesh.type);
        const claimed = station.claimedByShipId !== null;
        const pulse = 0.75 + Math.sin(this.ocean.getTime() * 4 + mesh.root.position.x * 0.02) * 0.18;
        const glowOpacity = claimed ? 0.18 : 0.55 + Math.sin(this.ocean.getTime() * 3.2 + mesh.root.position.z * 0.03) * 0.12;
        mesh.halo.rotation.z += dt * (claimed ? 0.1 : 0.55);
        mesh.halo.position.y = 0.58 + (claimed ? 0 : Math.sin(this.ocean.getTime() * 2.8 + mesh.root.position.x * 0.01) * 0.05);
        mesh.light.intensity = claimed ? 0.18 : 2.1 * pulse;
        mesh.light.distance = claimed ? 10 : 16;

        const coreMaterial = mesh.core.material as THREE.MeshStandardMaterial;
        coreMaterial.color.setHex(claimed ? 0x8b8f97 : meta.hex);
        coreMaterial.emissive.setHex(claimed ? 0x31343a : meta.hex);
        coreMaterial.emissiveIntensity = claimed ? 0.14 : 0.78 * pulse;

        const haloMaterial = mesh.halo.material as THREE.MeshBasicMaterial;
        haloMaterial.color.setHex(claimed ? 0x8b8f97 : meta.hex);
        haloMaterial.opacity = glowOpacity;

        mesh.sign.lookAt(this.renderer.camera.position);
        const signMaterial = mesh.sign.material as THREE.MeshBasicMaterial;
        signMaterial.opacity = claimed ? 0.46 : 0.94;
      }
    }
  }

  private updateStoryNpcs(dt: number) {
    if (!this.state) return;

    const player = this.getLocalPlayer();
    const now = performance.now();
    if (this.storyCutscene && now > this.storyCutsceneHideAt) {
      this.storyCutscene.root.style.opacity = '0';
      this.storyCutscene.root.style.transform = 'translateY(14px)';
      this.storyCutsceneNpcId = null;
    }

    for (const island of this.state.islands) {
      for (const npc of island.npcs ?? []) {
        const mesh = this.npcMeshes.get(npc.id);
        if (!mesh) continue;

        const pulse = 0.82 + Math.sin(this.ocean.getTime() * 2.1 + mesh.root.position.x * 0.03) * 0.18;
        mesh.root.position.y = mesh.baseY + Math.sin(this.ocean.getTime() * 0.86 + mesh.root.position.z * 0.02) * 0.025;
        mesh.light.intensity = 1.0 + pulse * 0.65;

        if (!player || player.state === 'eliminated' || player.state === 'respawning') continue;

        const dx = player.position.x - mesh.root.position.x;
        const dz = player.position.z - mesh.root.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance < 11) {
          const desiredYaw = Math.atan2(dx, dz);
          mesh.body.rotation.y += angleWrap(desiredYaw - mesh.body.rotation.y) * Math.min(1, dt * 5.5);
        } else {
          mesh.body.rotation.y += angleWrap(npc.rotation - mesh.body.rotation.y) * Math.min(1, dt * 1.4);
        }

        if (
          distance < 7.2
          && !this.seenStoryNpcIds.has(npc.id)
          && this.storyCutsceneNpcId !== npc.id
        ) {
          this.triggerStoryCutscene(npc, island);
        }
      }
    }
  }

  private triggerStoryCutscene(npc: IslandNpc, island: Island) {
    if (!this.storyCutscene) return;
    this.seenStoryNpcIds.add(npc.id);
    this.storyCutsceneNpcId = npc.id;
    this.storyCutsceneHideAt = performance.now() + 6200;
    this.storyCutscene.title.textContent = npc.cutsceneTitle;
    this.storyCutscene.name.textContent = `${npc.name} - ${island.name}`;
    this.storyCutscene.line.textContent = npc.line;
    this.storyCutscene.cue.textContent = npc.cue;
    this.storyCutscene.root.style.opacity = '1';
    this.storyCutscene.root.style.transform = 'translateY(0)';
    // The cutscene overlay IS the delivery — echoing the same line into the
    // kill feed printed every NPC's words twice on screen at once.
  }

  private updateStormRing() {
    if (!this.state) return;

    const segments = this.stormRingPositions.length / 3;
    const safeRadius = Math.max(16, this.state.storm.safeRadius);
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const offset = index * 3;
      this.stormRingPositions[offset] = this.state.storm.centerX + Math.cos(angle) * safeRadius;
      this.stormRingPositions[offset + 1] = 0;
      this.stormRingPositions[offset + 2] = this.state.storm.centerZ + Math.sin(angle) * safeRadius;
    }
    const positionAttr = this.stormRing.geometry.getAttribute('position') as THREE.BufferAttribute;
    positionAttr.needsUpdate = true;
    this.stormRing.material.opacity = 0.42 + Math.sin(this.ocean.getTime() * 3.6) * 0.08;

    this.stormWall.position.set(this.state.storm.centerX, 44, this.state.storm.centerZ);
    this.stormWall.scale.set(safeRadius, 1, safeRadius);
    this.stormWall.visible = true;

    this.stormHalo.position.set(this.state.storm.centerX, 9, this.state.storm.centerZ);
    this.stormHalo.scale.set(safeRadius, safeRadius, 1);
    this.stormHalo.visible = true;
  }

  /** Dev/tour hook: detach the camera and place it in the world. Call
   *  disableFreeCam() to hand control back to the player follow. */
  enableFreeCam(x: number, y: number, z: number, yaw = 0, pitch = -0.12) {
    this.freeCam = { pos: new THREE.Vector3(x, y, z), yaw, pitch };
  }

  disableFreeCam() {
    this.freeCam = null;
  }

  /** Dev/tour hook: force the day/night clock. Pass seconds into the 960s cycle
   *  (0 ≈ the DAY_NIGHT_START_OFFSET phase; +240 ≈ dusk, +480 ≈ deep night) to
   *  audit lighting at a fixed time; pass null to resume the live match clock. */
  setDayNightOverride(seconds: number | null) {
    this.dayNightOverrideSec = seconds;
  }

  /** Dev hook (honoured solo): make bots ignore YOU and your ship (they keep
   *  fighting each other). Call window.__piratesBR.setBotPeace(true) to test in
   *  peace, false to restore aggression. Also auto-enabled by the ?peace URL param. */
  setBotPeace(enabled = true) {
    this.network.sendDevBotPeace(enabled);
  }

  /** Dev/tour helper: world ground height at (x, z) via the shared heightfield,
   *  or 0 over open sea. Lets a tour aim the free-cam at real terrain. */
  sampleGroundY(x: number, z: number): number {
    let best = 0;
    for (const island of this.state?.islands ?? []) {
      if (!isPointInsideIslandFootprint(island, x, z, 4)) continue;
      best = Math.max(best, getIslandSurfaceY(island, x, z));
    }
    return best;
  }

  private updateCamera() {
    if (this.freeCam) {
      const { pos, yaw, pitch } = this.freeCam;
      const forward = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).normalize();
      this.renderer.camera.position.copy(pos);
      this.renderer.camera.lookAt(pos.clone().add(forward));
      return;
    }
    const player = this.getLocalPlayer();
    if (!player) return;

    const trackedShip = player.onShipId ? this.getTrackedShip() : null;
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    const swimming = player.state === 'swimming';
    const firearmEquipped = !!activeWeapon && !WEAPONS[activeWeapon.weaponId].melee;
    const aiming = this.input.isAiming();
    const firing = this.input.isFiring();
    const aimingFirearm = firearmEquipped && (aiming || firing);
    const scopedFov = aiming && activeWeapon && WEAPONS[activeWeapon.weaponId].scopeFov
      ? WEAPONS[activeWeapon.weaponId].scopeFov
      : null;

    let desired: THREE.Vector3;
    let lookTarget: THREE.Vector3;
    // Spyglass: 6° (~12x) beats the sniper's 14° by design. With the SCOPE tool
    // equipped it sits in your hand; AIM (right-click) raises it to the eye and
    // zooms, release lowers it back to your hand — it stays equipped until you
    // draw a weapon or re-select it. Holding P is a momentary shortcut.
    const spyglassActive = (this.input.isSpyglassHeld() || (player.equippedTool === 'spyglass' && aiming))
      && !player.atCannon
      && player.state !== 'downed'
      && player.state !== 'respawning'
      && player.state !== 'eliminated';
    this.spyglassActive = spyglassActive;
    let targetFov = spyglassActive ? 6 : scopedFov ?? (aimingFirearm ? 64 : swimming ? 78 : 74);

    if (player.atCannon && trackedShip) {
      const aim = this.getCannonAim(trackedShip, player.cannonIndex, this.input.getYaw(), this.input.getPitch());
      const forward = new THREE.Vector3(
        Math.sin(aim.yaw) * Math.cos(aim.pitch),
        Math.sin(aim.pitch),
        Math.cos(aim.yaw) * Math.cos(aim.pitch),
      ).normalize();
      const cannonWorld = this.shipRenderer.getCannonWorldPos(trackedShip.id, player.cannonIndex)
        ?? this.getShipWorldPoint(
          trackedShip,
          this.getCannonSide(player.cannonIndex, trackedShip) * (SHIP_STATS[trackedShip.type].width * 0.52),
          0,
          SHIP_STATS[trackedShip.type].height + 0.18,
        );
      const inward = new THREE.Vector3(trackedShip.position.x, cannonWorld.y, trackedShip.position.z)
        .sub(cannonWorld)
        .normalize();
      desired = cannonWorld
        .clone()
        .addScaledVector(forward, -0.45)
        .addScaledVector(inward, 1.72)
        .add(new THREE.Vector3(0, 1.08, 0));
      lookTarget = cannonWorld.clone().addScaledVector(forward, 74).add(new THREE.Vector3(0, 0.44, 0));
      targetFov = 80;
    } else if (player.atHelm && trackedShip) {
      const stats = SHIP_STATS[trackedShip.type];
      const helmZ = -stats.length * 0.39;
      // The wheel mesh sits on the centerline (x=0); keep the eye nearly centered
      // (a slight starboard nudge for an over-the-shoulder feel) so the wheel is
      // framed dead-ahead instead of jammed into the lower-left corner.
      const starboardX = stats.width * 0.06;
      // Ride the raised quarterdeck dais the captain stands on, so the eye sits at
      // helmsman head height instead of sunk toward the main-deck plane.
      const qdRise = getShipQuarterdeckConfig(stats).rise;
      desired = this.getShipWorldPoint(
        trackedShip,
        starboardX,
        helmZ - stats.length * 0.02,
        stats.height + 1.70 + qdRise,
      );
      lookTarget = this.getShipWorldPoint(
        trackedShip,
        starboardX * 0.68,
        stats.length * 0.22,
        stats.height + 1.55,
      );
      targetFov = 78;
    } else if (player.atSails && trackedShip) {
      const stats = SHIP_STATS[trackedShip.type];
      const station = this.getSailControlLocal(stats);
      const stationWorld = this.getShipWorldPoint(trackedShip, station.x, station.z, stats.height + 0.82);
      const sailTarget = this.getShipWorldPoint(
        trackedShip,
        0,
        getMainMastLocalZ(stats),
        stats.height + stats.height * 1.95,
      );
      const aftBias = this.getShipWorldPoint(
        trackedShip,
        0,
        station.z - stats.length * 0.11,
        stats.height + 0.86,
      );
      desired = stationWorld.lerp(aftBias, 0.22);
      lookTarget = sailTarget;
      targetFov = 76;
    } else {
      const yaw = player.atHelm && trackedShip ? trackedShip.rotation : this.input.getYaw();
      const pitch = this.input.getPitch();
      const forward = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).normalize();
      const eyePos = this.getPlayerRenderPosition(player, 0.02).add(new THREE.Vector3(0, swimming ? PLAYER.HEIGHT * 0.56 : player.crouching ? PLAYER.HEIGHT * 0.55 : PLAYER.HEIGHT * 0.84, 0));
      desired = eyePos;
      lookTarget = eyePos
        .clone()
        .addScaledVector(forward, scopedFov ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14)
        .add(new THREE.Vector3(0, swimming ? -0.04 : scopedFov ? 0.05 : 0, 0));
    }

    const onIslandFoot = !player.onShipId && player.state === 'alive' && !swimming
      && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest;
    let followHz = 158;
    if (player.atCannon || player.atHelm || player.atSails) followHz = 70;
    else if (onIslandFoot) followHz = 178;
    else if (swimming) followHz = 162;
    else if (player.onShipId) followHz = 165;
    const cameraFollow = 1 - Math.exp(-followHz * this.frameDt);
    this.renderer.camera.position.lerp(desired, cameraFollow);
    this.renderer.camera.lookAt(lookTarget);

    const camera = this.renderer.camera;
    const onDeck = !!player.onShipId && !!trackedShip && !swimming;
    const shipSpeed01 = onDeck && trackedShip
      ? THREE.MathUtils.clamp(
          Math.hypot(trackedShip.velocity.x, trackedShip.velocity.z) / Math.max(SHIP_STATS[trackedShip.type].maxSpeed, 0.001),
          0, 1,
        )
      : 0;

    // ── FOV kick: +4° eased into full sail speed, +2° brief pop on own cannon
    // fire, +5° rush on the cutlass dash.
    const fovKickTarget = shipSpeed01 * 4 + this.cameraShakeCannon * 2 + this.cutlassDashKick * 3.5;
    this.cameraFovKick += (fovKickTarget - this.cameraFovKick) * Math.min(1, this.frameDt * 6);
    this.cameraShakeCannon = Math.max(0, this.cameraShakeCannon - this.frameDt * 3.2);
    this.cutlassDashKick = Math.max(0, this.cutlassDashKick - this.frameDt * 2.6);
    const finalFov = targetFov + this.cameraFovKick;
    if (Math.abs(camera.fov - finalFov) > 0.02) {
      camera.fov += (finalFov - camera.fov) * Math.min(1, this.frameDt * 10);
      this.input.setFovScale(camera.fov / 74);
      camera.updateProjectionMatrix();
    }

    // ── Deck roll coupling: lean the view with the hull heel, clamped to ±0.06 rad.
    let rollTarget = 0;
    if (onDeck && trackedShip) {
      rollTarget = THREE.MathUtils.clamp(-(trackedShip.roll ?? 0) * 0.5, -0.06, 0.06);
    }
    this.cameraRoll += (rollTarget - this.cameraRoll) * Math.min(1, this.frameDt * 4);
    this.cameraRoll = THREE.MathUtils.clamp(this.cameraRoll, -0.06, 0.06);
    if (Math.abs(this.cameraRoll) > 0.0002) camera.rotateZ(this.cameraRoll);

    // ── Impact shake (own-hull hits) + a sluggish wallow when heavily flooded.
    this.cameraShake = Math.max(0, this.cameraShake - this.frameDt * 2.4);
    let shake = this.cameraShake;
    const water = onDeck && trackedShip ? (trackedShip.waterLevel ?? 0) : 0;
    if (water > 0.5) shake += (water - 0.5) * 0.14;
    if (shake > 0.0005) {
      const amp = Math.min(0.9, shake) * 0.12;
      const st = this.ocean.getTime();
      camera.rotateX(Math.sin(st * 41.0) * amp * 0.5);
      camera.rotateY(Math.cos(st * 37.0) * amp * 0.5);
      this.tempShakeVec.set(Math.sin(st * 53.0) * amp, Math.cos(st * 59.0) * amp, 0)
        .applyQuaternion(camera.quaternion);
      camera.position.add(this.tempShakeVec);
    }
  }

  private updateWaterEnvironment() {
    const camera = this.renderer.camera.position;
    const camStorm = getStormWaveIntensity(this.state?.storm, camera.x, camera.z);
    const waveY = gerstnerHeight(camera.x, camera.z, this.ocean.getTime(), WAVE_PARAMS, camStorm);
    this.combatFx.setWaterSurfaceY(waveY);
    const depthBelowSurface = Math.max(0, waveY + 0.18 - camera.y);
    this.renderer.updateWaterEnvironment(
      depthBelowSurface,
      this.stormWeatherIntensity,
      this.dayNightOverrideSec ?? this.ocean.getTime(),
    );
    this.ocean.setSunDirection(this.renderer.getSunDirection());
    this.ocean.setUnderwaterDepth(depthBelowSurface);
  }

  private getBlunderbussCrosshairSize(player: Player) {
    const spreadMultiplier = this.getLocalSpreadMultiplier(player, 'blunderbuss', this.input.isAiming());
    const spreadRad = THREE.MathUtils.degToRad(WEAPONS.blunderbuss.spread * spreadMultiplier);
    const fovRad = THREE.MathUtils.degToRad(this.renderer.camera.fov * 0.5);
    const radiusPx = Math.tan(spreadRad) / Math.max(0.001, Math.tan(fovRad)) * window.innerHeight * 0.5;
    const maxSize = Math.min(window.innerWidth * 0.76, window.innerHeight * 0.74);
    return Math.round(THREE.MathUtils.clamp(radiusPx * 2, 58, maxSize));
  }

  private getLocalSpreadMultiplier(player: Player, weaponId: WeaponId, aiming: boolean) {
    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    let multiplier = 1;

    if (aiming) {
      multiplier *= weaponId === 'eye_of_reach' ? 0.12 : 0.55;
    } else if (weaponId === 'eye_of_reach') {
      multiplier *= 0.38;
    }

    if (player.state === 'swimming') {
      multiplier *= 1.7;
    } else if (moveSpeed > 0.1) {
      multiplier *= 1.35;
    } else {
      multiplier *= 0.92;
    }

    if (weaponId === 'blunderbuss') {
      multiplier *= aiming ? 0.82 : 1.08;
    }

    return multiplier;
  }

  private formatCompassHeading(angle: number): string {
    const headings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const degrees = ((THREE.MathUtils.radToDeg(angle) % 360) + 360) % 360;
    return headings[Math.round(degrees / 45) % headings.length];
  }

  private getStormTimerSeconds() {
    if (!this.state) return 0;
    return this.state.storm.shrinking
      ? Math.max(0, Math.ceil((1 - this.state.storm.shrinkProgress) * this.state.storm.shrinkDuration))
      : Math.max(0, Math.ceil(this.state.storm.shrinkTimer));
  }

  private formatStormTimer(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
  }

  private updateDamageFx() {
    if (!this.localPlayerId) return;

    const player = this.playersById.get(this.localPlayerId);
    if (!player) return;

    if (player.health < this.previousHealth) {
      this.ui.damageVignette.style.opacity = '1';
      window.setTimeout(() => {
        this.ui.damageVignette.style.opacity = '0';
      }, 160);
    }

    const knockbackMagnitude = Math.hypot(
      player.knockbackVelocity.x,
      player.knockbackVelocity.y,
      player.knockbackVelocity.z,
    );
    if (knockbackMagnitude > this.previousKnockback + 2) {
      this.ui.knockbackFlash.style.opacity = '0.8';
      window.setTimeout(() => {
        this.ui.knockbackFlash.style.opacity = '0';
      }, 90);
    }

    this.previousKnockback = knockbackMagnitude;
    this.previousHealth = player.health;

    // Own-ship hull damage: shake the camera (scaled by the hit). No direction
    // arrow for ship hits — the shake + hull HUD + hole markers carry it; the
    // red arc stays reserved for the player's own body being shot.
    const localShip = this.localShipId ? this.shipsById.get(this.localShipId) ?? null : null;
    if (localShip) {
      const total = localShip.hull.bow + localShip.hull.stern + localShip.hull.port + localShip.hull.starboard;
      if (localShip.id !== this.prevOwnShipId) {
        this.prevOwnShipId = localShip.id;
      } else {
        const drop = this.prevOwnHullTotal - total;
        if (drop > 0.01) {
          this.cameraShake = Math.min(1, this.cameraShake + THREE.MathUtils.clamp(drop * 1.6, 0.12, 0.8));
        }
      }
      this.prevOwnHullTotal = total;
    } else {
      this.prevOwnShipId = null;
      this.prevOwnHullTotal = 4;
    }
  }

  private syncTradeUi(snapshot: GameState) {
    const session = this.getActiveTradeSession(snapshot);
    const player = snapshot.players.find((candidate) => candidate.id === this.localPlayerId) ?? null;
    const ship = this.getTrackedShipFromState(snapshot);

    if (!session || !player || !ship) {
      this.activeTradeSessionId = null;
      this.localTradeOffer = [];
      this.ui.tradeUi.style.display = 'none';
      return;
    }

    const localIsInitiator = session.initiatorId === this.localPlayerId;
    const localOffer = localIsInitiator ? session.initiatorOffer : session.targetOffer;
    const remoteOffer = localIsInitiator ? session.targetOffer : session.initiatorOffer;
    const localConfirmed = localIsInitiator ? session.initiatorConfirmed : session.targetConfirmed;

    if (this.activeTradeSessionId !== session.id) {
      this.activeTradeSessionId = session.id;
      this.localTradeOffer = this.cloneOffer(localOffer);
    }
    if (JSON.stringify(this.localTradeOffer) !== JSON.stringify(localOffer)) {
      this.localTradeOffer = this.cloneOffer(localOffer);
    }

    this.ui.tradeUi.style.display = 'flex';
    this.ui.tradeTimer.textContent = session.betrayalWindow
      ? `Betrayal window: ${session.timer.toFixed(1)}s`
      : `Parley expires in ${Math.ceil(session.timer)}s`;

    this.renderTradeOfferButtons(player, ship, session.id, localConfirmed);
    this.renderTradeOfferSummary(this.ui.theirTradeItems, remoteOffer, 'No offer yet');
    this.ui.tradeConfirm.disabled = localConfirmed;
    this.ui.tradeConfirm.textContent = localConfirmed ? 'OFFER LOCKED' : 'CONFIRM TRADE';
  }

  private renderTradeOfferButtons(player: Player, ship: Ship, sessionId: string, disabled: boolean) {
    const options = [
      { item: 'gold', qty: Math.min(100, player.gold), label: '100 Gold' },
      { item: 'cannonball', qty: Math.min(5, this.getInventoryQty(ship, 'cannonball')), label: '5 Cannonballs' },
      { item: 'wood_plank', qty: Math.min(2, this.getInventoryQty(ship, 'wood_plank')), label: '2 Planks' },
      { item: 'firebomb_ball', qty: Math.min(1, this.getInventoryQty(ship, 'firebomb_ball')), label: '1 Firebomb' },
      { item: 'chainshot', qty: Math.min(1, this.getInventoryQty(ship, 'chainshot')), label: '1 Chainshot' },
      { item: 'banana', qty: Math.min(1, this.getInventoryQty(ship, 'banana')), label: '1 Banana' },
    ].filter((option) => option.qty > 0);

    this.ui.yourTradeItems.innerHTML = '';
    if (options.length === 0) {
      this.renderTradeOfferSummary(this.ui.yourTradeItems, this.localTradeOffer, 'Nothing to offer');
      return;
    }

    for (const option of options) {
      const button = document.createElement('button');
      button.className = 'trade-btn';
      button.textContent = this.localTradeOffer.some((entry) => entry.item === option.item) ? `Remove ${option.label}` : option.label;
      button.disabled = disabled;
      button.style.display = 'block';
      button.style.width = '100%';
      button.style.marginBottom = '8px';
      button.style.opacity = disabled ? '0.55' : '1';
      button.addEventListener('click', () => {
        const existing = this.localTradeOffer.find((entry) => entry.item === option.item);
        this.localTradeOffer = existing
          ? this.localTradeOffer.filter((entry) => entry.item !== option.item)
          : [...this.localTradeOffer, { item: option.item as ItemStack['item'], qty: option.qty }];
        this.network.sendTradeAction({
          action: 'offer',
          sessionId,
          offer: this.localTradeOffer,
        });
        if (this.state) this.syncTradeUi(this.state);
      });
      this.ui.yourTradeItems.appendChild(button);
    }

    const summary = document.createElement('div');
    summary.style.marginTop = '8px';
    summary.style.fontSize = '0.72rem';
    summary.style.color = '#d8d1c0';
    summary.textContent = this.localTradeOffer.length > 0
      ? `Selected: ${this.localTradeOffer.map((entry) => this.formatTradeItem(entry)).join(', ')}`
      : 'Selected: nothing yet';
    this.ui.yourTradeItems.appendChild(summary);
  }

  private renderTradeOfferSummary(container: HTMLDivElement, offer: ItemStack[], emptyLabel: string) {
    container.innerHTML = '';
    if (offer.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = emptyLabel;
      empty.style.color = '#9aa6af';
      empty.style.fontSize = '0.75rem';
      container.appendChild(empty);
      return;
    }

    for (const entry of offer) {
      const row = document.createElement('div');
      row.textContent = this.formatTradeItem(entry);
      row.style.marginBottom = '8px';
      row.style.fontSize = '0.78rem';
      row.style.color = '#f0e5c6';
      container.appendChild(row);
    }
  }

  /**
   * Per-frame edge-detection that fires sound effects driven by client state:
   * eating fruit, digging rhythm, chest pickup/stow, water entry, storm wind.
   */
  private audioFrameTriggers(dt: number) {
    if (!this.state) return;
    const player = this.getLocalPlayer();
    const localShip = this.localShipId ? this.state.ships.find((s) => s.id === this.localShipId) ?? null : null;
    const now = this.ocean.getTime();

    // Fruit/wood eat — fire on the rising edge of pocketUseCooldown.
    if (player) {
      const cooldown = player.pocketUseCooldown ?? 0;
      if (cooldown > this.prevPocketUseCooldown + 0.2) {
        const kind = this.pocketUsePreviewKind;
        if (kind === 'wood') {
          this.audio.playWoodPlank();
        } else if (kind === 'meat') {
          this.audio.playMeatEat();
        } else if (kind === 'banana' || kind === 'coconut' || kind === 'mango') {
          this.audio.playFruitEat(kind);
        } else {
          this.audio.playFruitEat('banana');
        }
      }
      this.prevPocketUseCooldown = cooldown;
    }

    // Carrying a chest — pickup vs stow vs drop.
    const carryingNow = player?.carryingChestId ?? null;
    if (carryingNow !== this.prevCarryingChestId) {
      if (carryingNow && !this.prevCarryingChestId) {
        this.audio.playChestPickup();
      } else if (!carryingNow && this.prevCarryingChestId) {
        const onShip = player?.onShipId && player.onShipId === this.localShipId;
        if (onShip) this.audio.playChestStow();
      }
      this.prevCarryingChestId = carryingNow;
    }

    // Water entry / exit — alive↔swimming transitions.
    if (player) {
      const stateNow = player.state;
      if (this.prevPlayerStateForAudio && this.prevPlayerStateForAudio !== 'swimming' && stateNow === 'swimming') {
        // Splashing IN — scaled by how fast you hit the water.
        const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
        this.audio.playSplash(THREE.MathUtils.clamp(speed / 12, 0.35, 1.4));
      } else if (this.prevPlayerStateForAudio === 'swimming' && (stateNow === 'alive' || stateNow === 'boarding')) {
        // Climbing OUT / hauling onto deck — a lighter surfacing splash + stroke.
        this.audio.playSplash(0.55);
        this.audio.playSwimSplash(1.1);
      }
      this.prevPlayerStateForAudio = stateNow;
    }

    // Digging strike rhythm — match the client-side animation cycle.
    const digChest = player?.nearChestId ? this.findChestById(player.nearChestId) : null;
    const chestDig =
      !!digChest
      && !!player?.hasShovel
      && (this.input.isInteractHeld() || (player?.equippedTool === 'shovel' && this.input.isFiring()))
      && !player?.carryingChestId
      && digChest.buried
      && digChest.digProgress < 1;
    // A shovel digs ANYWHERE (SoT): swinging it over empty ground still bites —
    // only a spot with treasure actually progresses a dig.
    const freeDig = !chestDig
      && !!player?.hasShovel
      && player?.equippedTool === 'shovel'
      && this.input.isFiring()
      && player?.state === 'alive'
      && !player?.carryingChestId;
    const digging = chestDig || freeDig;
    if (digging) {
      // Roughly two strikes per second — same rhythm the shovel viewmodel runs at.
      this.digStrikePhase += dt;
      if (this.digStrikePhase >= 0.55) {
        this.digStrikePhase = 0;
        this.audio.playDigStrike();
      }
    } else {
      this.digStrikePhase = 0;
    }

    // Axe chop thunk — keyed to the SAME clock as the viewmodel swing (strike
    // beat lands at cycle 0.75), so sound and blade connect together.
    const chopping = !!player
      && player.equippedTool === 'axe'
      && this.input.isFiring()
      && player.state === 'alive'
      && !player.carryingChestId;
    const chopCycle = (now * 1.4) % 1;
    // The thunk means CONTACT — air swings stay silent; harvestTargetActive
    // is maintained by updateHarvestDestruction from the live target scan.
    if (chopping && this.harvestTargetActive && chopCycle >= 0.75 && this.prevAxeChopCycle < 0.75) {
      this.audio.playAxeChop();
    }
    this.prevAxeChopCycle = chopping ? chopCycle : 1;

    // Storm wind ambient — louder as the safe zone shrinks past you.
    const stormPhase = this.state.storm?.phase ?? 0;
    if (stormPhase !== this.prevStormPhase) {
      this.prevStormPhase = stormPhase;
    }
    this.audio.setWindIntensity(THREE.MathUtils.clamp(this.stormWeatherIntensity, 0, 1));

    const localShipSpeed = localShip ? Math.hypot(localShip.velocity.x, localShip.velocity.z) : 0;
    const localShipStats = localShip ? SHIP_STATS[localShip.type] : null;
    const localShipMotion = localShipStats
      ? THREE.MathUtils.clamp(localShipSpeed / Math.max(localShipStats.maxSpeed, 0.001), 0, 1)
      : 0;
    const swimmingWaveBoost = player?.state === 'swimming' ? 0.26 : 0;
    this.audio.setWaveBed(THREE.MathUtils.clamp(0.36 + swimmingWaveBoost + localShipMotion * 0.32 + this.stormWeatherIntensity * 0.38, 0, 1));
    this.audio.setHullCreakIntensity(
      localShip ? THREE.MathUtils.clamp(0.18 + localShipMotion * 0.62 + this.stormWeatherIntensity * 0.28, 0, 1) : 0,
      localShipMotion,
    );

    if (localShip) {
      const hullSplashAmount = THREE.MathUtils.clamp(localShipMotion * 0.9 + this.stormWeatherIntensity * 0.38, 0, 1.25);
      const hullSplashInterval = THREE.MathUtils.clamp(1.15 - hullSplashAmount * 0.58 + Math.sin(now * 1.9) * 0.08, 0.38, 1.25);
      if (hullSplashAmount > 0.16 && now - this.lastHullSplashAt > hullSplashInterval) {
        this.audio.playHullSplash(hullSplashAmount);
        this.lastHullSplashAt = now;
      }
    }

    // Swim stroke SFX — a soft slosh on a movement-scaled cadence while the
    // local player is in the water, so swimming isn't eerily silent.
    if (player?.state === 'swimming') {
      const swimSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      const move01 = THREE.MathUtils.clamp(swimSpeed / 3.2, 0, 1);
      // ~0.85s idle tread down to ~0.42s at a hard stroke, with a little jitter.
      const strokeInterval = 0.85 - move01 * 0.43 + Math.sin(now * 2.3) * 0.05;
      if (now - this.lastSwimStrokeAt > strokeInterval) {
        this.audio.playSwimSplash(0.45 + move01 * 0.6);
        this.lastSwimStrokeAt = now;
      }
    }

    // Remote pirates hitting the water beside you get a spatial splash.
    if (this.state?.players) {
      const camPos = this.renderer.camera.position;
      for (const other of this.state.players) {
        if (other.id === this.localPlayerId) continue;
        const prev = this.remoteSwimAudioState.get(other.id);
        if (prev && prev !== 'swimming' && other.state === 'swimming') {
          const d = Math.hypot(other.position.x - camPos.x, other.position.y - camPos.y, other.position.z - camPos.z);
          if (d < 90) this.audio.playSplash(THREE.MathUtils.clamp(1.1 - d / 110, 0.3, 1.0), d);
        }
        this.remoteSwimAudioState.set(other.id, other.state);
      }
    }

    // Sail/anchor change cues for the local ship — physical deck feedback instead of UI clicks.
    if (localShip) {
      if (this.prevAnchored !== null && this.prevAnchored !== localShip.anchored) {
        this.audio.playAnchorChange(localShip.anchored);
      }
      this.prevAnchored = localShip.anchored;

      const anchorProgress = THREE.MathUtils.clamp(localShip.anchorRaiseProgress ?? 0, 0, 1);
      if (this.prevAnchorRaiseProgress !== null) {
        const anchorDelta = Math.abs(anchorProgress - this.prevAnchorRaiseProgress);
        const anchorMoving = localShip.anchored && anchorProgress > 0 && anchorProgress < 1 && anchorDelta > 0.0012;
        if (anchorMoving && now - this.lastAnchorMoveSoundAt > 0.16) {
          this.audio.playAnchorMovement(THREE.MathUtils.clamp(anchorDelta * 88 + 0.28, 0.32, 1.15));
          this.lastAnchorMoveSoundAt = now;
        }
      }
      this.prevAnchorRaiseProgress = anchorProgress;

      const helmAxes = this.input.getMoveAxes();
      const helmIntent = Math.abs(helmAxes.x);
      const helmMotion = Math.abs(localShip.angularVelocity);
      if (player?.atHelm && (helmIntent > 0 || helmMotion > 0.006)) {
        const helmAmount = THREE.MathUtils.clamp(helmIntent * 0.55 + helmMotion * 4.4 + localShipMotion * 0.18, 0.25, 1.15);
        const helmInterval = THREE.MathUtils.clamp(0.34 - helmAmount * 0.16, 0.14, 0.34);
        if (now - this.lastHelmTurnSoundAt > helmInterval) {
          this.audio.playHelmTurn(helmAmount);
          this.lastHelmTurnSoundAt = now;
        }
      }

      if (this.prevSailHeightForAudio !== null && this.prevSailAngleForAudio !== null) {
        const heightDelta = Math.abs(localShip.sailHeight - this.prevSailHeightForAudio);
        const angleDelta = Math.abs(angleWrap(localShip.sailAngle - this.prevSailAngleForAudio));
        if ((heightDelta > 0.055 || angleDelta > 0.18) && now - this.lastSailTrimSoundAt > 0.36) {
          this.audio.playSailTrim(THREE.MathUtils.clamp(heightDelta * 7 + angleDelta * 1.6, 0.35, 1.25));
          this.lastSailTrimSoundAt = now;
        }
      }
      this.prevSailHeightForAudio = localShip.sailHeight;
      this.prevSailAngleForAudio = localShip.sailAngle;
    } else {
      this.prevAnchored = null;
      this.prevAnchorRaiseProgress = null;
      this.prevSailHeightForAudio = null;
      this.prevSailAngleForAudio = null;
    }

    // Cannon launch — local player just got fired out of a ship cannon.
    if (player) {
      const ballisticNow = !!player.cannonBallistic;
      if (ballisticNow && !this.prevCannonBallistic) {
        this.audio.playCannonFire();
      }
      this.prevCannonBallistic = ballisticNow;
    }

    // Cutlass swing — when the active melee weapon enters its reload window we just swung.
    if (player && !player.atCannon && !player.atHelm && !player.atSails) {
      const active = player.weapons[player.activeSlot];
      const isMelee = active && WEAPONS[active.weaponId]?.melee;
      const reloading = !!(active && active.reloading);
      if (isMelee && reloading && !this.prevMeleeReloading) {
        this.audio.playCutlassSwing();
      }
      this.prevMeleeReloading = !!(isMelee && reloading);
    } else {
      this.prevMeleeReloading = false;
    }

    this.updateNavalAudioAndFx(dt, player, localShip);
  }

  /**
   * Round-3 naval audio + FX bed: world ambience (night/storm/shore), the sailing
   * bed for the ship you're aboard, the flooding loop for that ship (or the nearest
   * flooding hull within 20 m), bail scoop arcs, hull leaks, and the storm stinger.
   */
  private updateNavalAudioAndFx(_dt: number, player: Player | null, localShip: Ship | null) {
    if (!this.state) return;
    const t = this.ocean.getTime();
    const cam = this.renderer.camera.position;
    const atmo = this.renderer.getAtmosphere();
    const nightFactor = THREE.MathUtils.clamp(atmo.nightFactor, 0, 1);
    const storminess = THREE.MathUtils.clamp(this.stormWeatherIntensity, 0, 1);

    // Shore proximity — closest island edge to the listener drives breaker ambience.
    let nearestEdge = Infinity;
    for (const island of this.state.islands) {
      const edge = this.distance2D(cam.x, cam.z, island.position.x, island.position.z) - island.radius;
      if (edge < nearestEdge) nearestEdge = edge;
    }
    const nearShore01 = Number.isFinite(nearestEdge)
      ? THREE.MathUtils.clamp(1 - THREE.MathUtils.clamp(nearestEdge / 70, 0, 1), 0, 1)
      : 0;
    this.audio.setAmbience({ nightFactor, storminess, nearShore01 });

    // Sailing bed — reflects the ship the player is physically standing on.
    const aboardShip = player?.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    if (aboardShip) {
      const stats = SHIP_STATS[aboardShip.type];
      const speed = Math.hypot(aboardShip.velocity.x, aboardShip.velocity.z);
      const speed01 = THREE.MathUtils.clamp(speed / Math.max(stats.maxSpeed, 0.001), 0, 1);
      const heel01 = THREE.MathUtils.clamp(Math.abs(aboardShip.roll ?? 0) / 0.3, 0, 1);
      const roughness01 = THREE.MathUtils.clamp(storminess * 0.8 + heel01 * 0.4, 0, 1);
      this.audio.setSailingState({ speed01, roughness01, heel01, luffing: !!aboardShip.luffing });
    } else {
      this.audio.setSailingState({ speed01: 0, roughness01: 0, heel01: 0, luffing: false });
    }

    // Flooding loop — the ship you're on if it's taking water, else the nearest
    // flooding hull within earshot.
    const floodShip = aboardShip && (aboardShip.waterLevel ?? 0) > 0.02
      ? aboardShip
      : this.findNearestFloodingShip(cam, 20);
    if (floodShip && (floodShip.waterLevel ?? 0) > 0.02) {
      const level = THREE.MathUtils.clamp(floodShip.waterLevel ?? 0, 0, 1);
      if (!this.floodingLoopActive) {
        this.audio.startFlooding(level);
        this.floodingLoopActive = true;
      } else {
        this.audio.updateFlooding(level);
      }
      if (t - this.lastHullLeakAt > 0.4) {
        this.emitHullLeaks(floodShip);
        // Pressure jets from holes punched below the waterline: the anchors
        // ride the lofted hull (heave/pitch/roll/list), +Z = outward normal.
        if (!floodShip.sinking) {
          for (const hole of this.shipRenderer.getHoleAnchors(floodShip.id)) {
            if (!hole.active) continue;
            hole.anchor.getWorldPosition(this.tempRenderPos);
            // Submerged = the breach sits at/below the LIVE wave surface — computed
            // per-hole (not a hardcoded per-section flag) so a holed, submerged bow
            // or stern jets water just like the port/starboard breaches do.
            const waveY = gerstnerHeight(this.tempRenderPos.x, this.tempRenderPos.z, this.ocean.getTime(), WAVE_PARAMS, storminess);
            if (this.tempRenderPos.y > waveY + 0.2) continue;
            hole.anchor.getWorldDirection(this.tempHudVector);
            this.combatFx.emitHullLeak(
              { x: this.tempRenderPos.x, y: this.tempRenderPos.y, z: this.tempRenderPos.z },
              this.tempHudVector.x * (0.7 + (floodShip.waterLevel ?? 0) * 0.9),
              this.tempHudVector.z * (0.7 + (floodShip.waterLevel ?? 0) * 0.9),
            );
          }
        }
        this.lastHullLeakAt = t;
      }
    } else if (this.floodingLoopActive) {
      this.audio.stopFlooding();
      this.floodingLoopActive = false;
    }

    // Bail scoop arcs (+ the local scoop one-shot), beaten out for all bailers.
    // Bail FX ride the bucketFilled EDGES (10Hz snapshot resolution) so the
    // thrown-water arc lands ON the heave instead of drifting on a timer:
    // false→true = scoop (small dip splash), true→false = HEAVE (fling arc).
    for (const bailer of this.state.players) {
      const filled = !!bailer.bucketFilled;
      const prev = this.prevBucketFilled.get(bailer.id);
      this.prevBucketFilled.set(bailer.id, filled);
      if (prev === undefined || prev === filled) continue;
      const bShip = bailer.onShipId ? this.shipsById.get(bailer.onShipId) ?? null : null;
      let dx = 1;
      let dz = 0;
      if (bShip) {
        dx = bailer.position.x - bShip.position.x;
        dz = bailer.position.z - bShip.position.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
      }
      if (!filled) {
        // HEAVE — throw the arc outward from chest height, over the rail.
        this.combatFx.emitBailScoop(
          { x: bailer.position.x + dx * 0.55, y: bailer.position.y + PLAYER.HEIGHT * 0.62, z: bailer.position.z + dz * 0.55 },
          dx, dz,
        );
        if (bailer.id === this.localPlayerId) this.audio.playBail();
      } else if (bailer.id === this.localPlayerId) {
        // SCOOP — just the dip, no thrown water.
        this.audio.playSwimSplash(0.5);
      }
    }

    // Storm-shrink stinger on the rising edge.
    const shrinkingNow = !!this.state.storm.shrinking;
    if (shrinkingNow && !this.prevStormShrinking) this.audio.playStormShrink();
    this.prevStormShrinking = shrinkingNow;

    void localShip;
  }

  private findNearestFloodingShip(pos: THREE.Vector3, maxDist: number): Ship | null {
    if (!this.state) return null;
    let best: Ship | null = null;
    let bestDist = maxDist;
    for (const ship of this.state.ships) {
      if (!ship.alive || (ship.waterLevel ?? 0) <= 0.02) continue;
      const d = this.distance2D(pos.x, pos.z, ship.position.x, ship.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = ship;
      }
    }
    return best;
  }

  /** Streaming water at holed hull sections sitting near/below the waterline. */
  private emitHullLeaks(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const sections: Array<[keyof Ship['hull'], number, number]> = [
      ['bow', 0, stats.length * 0.42],
      ['stern', 0, -stats.length * 0.42],
      ['port', -stats.width * 0.5, 0],
      ['starboard', stats.width * 0.5, 0],
    ];
    for (const [section, lx, lz] of sections) {
      // Spray from ANY breached section (hull < 1 == at least one hole), matching
      // the server which floods on any submerged hole — not only once a section is
      // half-gone. So a single fresh hole visibly weeps where it was punched.
      if (ship.hull[section] > 0.995) continue;
      const point = this.getShipWorldPoint(ship, lx, lz, 0.16);
      this.combatFx.emitHullLeak(
        { x: point.x, y: point.y, z: point.z },
        point.x - ship.position.x,
        point.z - ship.position.z,
      );
    }
  }

  /** Supply-wheel slot layout: 0 scope · 1 compass · 2 bucket · 3 planks ·
   *  4 banana · 5 coconut · 6 meat/mango · 7 shovel · 8 lantern · 9 axe.
   *  Tools (0-2, 7-9) equip. */
  private getPocketWheelCount(player: Player, slot: number) {
    switch (slot) {
      case 3: return player.pocketWood;
      case 4: return player.pocketBanana;
      case 5: return player.pocketCoconut;
      case 6: return player.pocketMeat + player.pocketMango;
      default: return 0;
    }
  }

  private getPocketWheelKind(player: Player | null, slot: number): PocketPreviewKind | null {
    switch (slot) {
      case 3: return 'wood';
      case 4: return 'banana';
      case 5: return 'coconut';
      case 6: return (player?.pocketMeat ?? 0) > 0 ? 'meat' : 'mango';
      default: return null; // tool slots have no consumable preview
    }
  }

  /** Wheel slice index for an equipped tool (for the highlight), else -1. */
  private toolWheelSlot(tool: Player['equippedTool']): number {
    return tool === 'spyglass' ? 0 : tool === 'compass' ? 1 : tool === 'bucket' ? 2 : tool === 'shovel' ? 7 : tool === 'lantern' ? 8 : tool === 'axe' ? 9 : -1;
  }

  private startPocketUsePreview(slot: number) {
    const kind = this.getPocketWheelKind(this.getLocalPlayer(), slot);
    if (!kind) return;
    const player = this.getLocalPlayer();
    if (player?.carryingChestId) return;
    if (player && player.pocketUseCooldown > 0) return;
    if (this.pocketUsePreviewTimer > 0) return;
    if (!player || this.getPocketWheelCount(player, slot) <= 0) return;
    this.pocketUsePreviewKind = kind;
    this.pocketUsePreviewTimer = kind === 'wood' ? 0.45 : 0.82;
  }

  private getUpgradePresentation(type: ShipUpgradeType) {
    switch (type) {
      case 'hull_reinforcement':
        return {
          name: 'Reinforced Hull',
          short: 'Hull+',
          icon: '🛡',
          color: '#8fd0ff',
          hex: 0x67b9ff,
          effect: `−${Math.round((1 - SHIP_UPGRADES.HULL_INGRESS_MULT) * 100)}% flooding`,
        };
      case 'charged_cannons':
        return {
          name: 'Heavy Shot',
          short: 'Cannons+',
          icon: '✹',
          color: '#ffb08a',
          hex: 0xff8459,
          effect: `+${SHIP_UPGRADES.CHARGED_EXTRA_HOLES} hole per hit`,
        };
      case 'swift_sails':
      default:
        return {
          name: 'Swift Sails',
          short: 'Sails+',
          icon: '✦',
          color: '#f7de84',
          hex: 0xf6d360,
          effect: '+20% sail speed',
        };
    }
  }

  private toggleMap(force?: boolean) {
    const next = force ?? !this.map.mapOpen;
    this.map.mapOpen = next;
    this.ui.mapOverlay.classList.toggle('visible', next);
    // Hide the corner minimap while the fullscreen chart is open (it was drawing
    // a redundant second map over the top-right of the fullscreen view).
    const minimapShell = document.getElementById('minimap-shell');
    if (minimapShell) minimapShell.style.visibility = next ? 'hidden' : '';
    if (next) {
      this.map.mapZoom = 1; // always open at the whole-world view; scroll to zoom in
      this.ui.scopeOverlay.style.display = 'none';
      this.map.drawMaps();
    }
  }

  private setLoading(percent: number, text: string) {
    this.ui.loadingBar.style.width = `${percent}%`;
    this.ui.loadingText.textContent = text;
  }

  private getSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.hostname;
    const port = window.location.port;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    // Any localhost port other than the game server's own (8080) is a dev server (Vite, etc.).
    // Connect directly to 8080 instead of relying on a proxy — works for 3000/3003/5173/etc.
    if (isLocalhost && port && port !== '8080') {
      return `${protocol}://${host}:8080/ws`;
    }
    return `${protocol}://${window.location.host}/ws`;
  }

  private getLocalPlayer(): Player | null {
    if (!this.state || !this.localPlayerId) return null;
    return this.playersById.get(this.localPlayerId) ?? null;
  }

  private getTrackedShip(): Ship | null {
    if (!this.state) return null;

    const player = this.getLocalPlayer();
    if (player?.onShipId) {
      return this.shipsById.get(player.onShipId) ?? null;
    }
    if (this.localShipId) {
      return this.shipsById.get(this.localShipId) ?? null;
    }
    return null;
  }

  private getTrackedShipFromState(state: GameState): Ship | null {
    const player = this.localPlayerId
      ? state.players.find((candidate) => candidate.id === this.localPlayerId)
      : null;
    if (player?.onShipId) {
      return state.ships.find((ship) => ship.id === player.onShipId) ?? null;
    }
    if (this.localShipId) {
      return state.ships.find((ship) => ship.id === this.localShipId) ?? null;
    }
    return null;
  }

  private getActiveTradeSession(state: GameState): TradeSession | null {
    if (!this.localPlayerId) return null;
    return state.tradeSessions.find((session) =>
      session.initiatorId === this.localPlayerId ||
      session.targetPlayerId === this.localPlayerId ||
      session.initiatorShipId === this.localShipId ||
      session.targetShipId === this.localShipId
    ) ?? null;
  }

  private distance2D(ax: number, az: number, bx: number, bz: number) {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private getInventoryQty(ship: Ship | null, item: ItemStack['item']) {
    if (!ship) return 0;
    return ship.inventory.find((entry) => entry.item === item)?.qty ?? 0;
  }

  private getRepairPlankCount(player: Player, ship: Ship | null) {
    return player.pocketWood + this.getInventoryQty(ship, 'wood_plank');
  }

  private formatTradeItem(entry: ItemStack) {
    return `${entry.qty} ${entry.item.replace(/_/g, ' ')}`;
  }

  private cloneOffer(offer: ItemStack[]) {
    return offer.map((entry) => ({ ...entry }));
  }

  private syncHeldWeapon(mesh: THREE.Group, player: Player) {
    const rightHand = mesh.getObjectByName('right-hand');
    if (!rightHand) return;

    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    const currentId = activeWeapon?.weaponId ?? null;
    const existing = rightHand.getObjectByName('held-weapon') as THREE.Group | null;
    const useLocalSwimViewmodel = player.id === this.localPlayerId;

    if (!currentId || currentId === 'ship_cannon' || useLocalSwimViewmodel || player.state === 'eliminated' || player.state === 'respawning') {
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
          const swingProgress = this.getCutlassSwingProgress(player);
          if (this.cutlassSwingKind.get(player.id) === 'lunge' && swingProgress > 0) {
            // Dash stab: blade rams straight out with the extended arm.
            const ext = Math.sin(Math.min(1, swingProgress / 0.55) * Math.PI);
            weaponMesh.position.set(0.02, 0.04 + ext * 0.06, 0.1 + ext * 0.3);
            weaponMesh.rotation.set(-0.06 - ext * 1.35, 0.1, -0.62 + ext * 0.5);
            break;
          }
          const slashArc = Math.sin(THREE.MathUtils.clamp((swingProgress - 0.18) / 0.42, 0, 1) * Math.PI);
          const recover = THREE.MathUtils.smoothstep(swingProgress, 0.6, 1);
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

  /** First-person preview of held supplies and powder kegs before use. */
  private syncLocalViewPocket(): boolean {
    const player = this.getLocalPlayer();
    if (!player || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    if (player.atCannon || player.atHelm || player.atSails) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    // Carrying a treasure chest takes over both hands — nothing else can be held.
    if (player.carryingChestId) {
      const kind: PocketPreviewKind = 'chest';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      const time = this.ocean.getTime();
      const moveAxes = this.input.getMoveAxes();
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
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.3);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      const t = this.ocean.getTime();
      const swing = Math.sin((player.hullRepairProgress ?? 0) * Math.PI);   // eases in over the swing
      const tap = Math.max(0, Math.sin(t * 16));                            // rapid hammer taps
      const strike = tap * swing;
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(0.16, -0.34 - strike * 0.08, -0.5 + swing * 0.06);
      this.localViewPocketRoot.rotation.set(-0.5 - strike * 0.55, 0.28, 0.12);
      return true;
    }
    // Only show the in-hand keg + place animation when the server would ACTUALLY
    // spawn one: a mega keg, or a normal keg off cooldown. Otherwise the preview
    // "places" a keg client-side that never appears (60s replenish cooldown) — the
    // "kegs aren't being put down properly" feeling. getKegSummary shows the timer.
    const kegPlaceable = player.megaKegs > 0 || (player.kegs > 0 && (player.kegCooldown ?? 0) <= 0);
    if (this.input.isKegPreviewActive() && kegPlaceable) {
      const kind: PocketPreviewKind = 'powder_keg';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.55);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }

      const time = this.ocean.getTime();
      const moveAxes = this.input.getMoveAxes();
      const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
      const bob = Math.sin(time * (4.7 + moveAmount * 2.1)) * (0.005 + moveAmount * 0.013);
      const sway = Math.sin(time * (2.5 + moveAmount * 1.3)) * (0.006 + moveAmount * 0.012);

      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(-0.1 + sway * 0.38, -0.46 + bob, -0.84);
      this.localViewPocketRoot.rotation.set(-0.13 + bob * 0.9, 0.18 + sway * 0.35, 0.04);
      return true;
    }
    const digChest = player.nearChestId ? this.findChestById(player.nearChestId) : null;
    const chestDig =
      !!digChest
      && player.hasShovel
      && this.input.isInteractHeld()
      && !player.carryingChestId
      && digChest.buried
      && digChest.digProgress < 1;
    // The shovel also digs over EMPTY ground (SoT feel) — same swing animation,
    // it just never uncovers anything unless an X marks the spot.
    const freeDig = !chestDig
      && player.hasShovel
      && player.equippedTool === 'shovel'
      && this.input.isFiring()
      && player.state === 'alive'
      && !player.carryingChestId;
    const digging = chestDig || freeDig;
    if (digging) {
      const kind: PocketPreviewKind = 'shovel';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(2.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      // Two-beat dig cycle: lift the shovel, then drive it into the dirt.
      const time = this.ocean.getTime();
      const cycle = (time * 1.9) % 1;
      const lift = Math.sin(cycle * Math.PI) ** 2;            // 0 → 1 → 0 (raise)
      const strike = Math.max(0, Math.sin((cycle - 0.5) * Math.PI * 2)); // sharp drop
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(
        -0.05,
        -0.34 + lift * 0.22 - strike * 0.12,
        -0.55 + lift * 0.05 - strike * 0.08,
      );
      this.localViewPocketRoot.rotation.set(
        -0.55 - lift * 0.55 + strike * 0.85,
        0.12 + lift * 0.18,
        -0.08 + strike * 0.05,
      );
      return true;
    }
    if (this.pocketUsePreviewTimer > 0) {
      this.pocketUsePreviewTimer = Math.max(0, this.pocketUsePreviewTimer - this.frameDt);
    } else {
      this.pocketUsePreviewKind = null;
    }

    const usingPreview = this.pocketUsePreviewKind !== null && this.pocketUsePreviewTimer > 0;
    if (!this.input.isSupplyWheelOpen() && !usingPreview) {
      // Persistently hold the equipped TOOL in first-person so you can SEE what's
      // in your hands. The spyglass is the exception — raised, the full-screen
      // scope overlay is the visual, so no barrel viewmodel is drawn.
      const tool = player.equippedTool;
      if (tool && !(tool === 'spyglass' && this.spyglassActive)) {
        const kind = tool as PocketPreviewKind;
        let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
        if (!mesh || this.localViewPocketKind !== kind) {
          this.localViewPocketRoot.clear();
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
        const time = this.ocean.getTime();
        const moveAxes = this.input.getMoveAxes();
        const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
        const bob = Math.sin(time * (3.1 + moveAmount * 2.4)) * (0.006 + moveAmount * 0.02);
        const sway = Math.sin(time * (1.8 + moveAmount * 1.1)) * (0.006 + moveAmount * 0.014);
        const cfg = tool === 'compass'
          ? { p: [0.2 + sway * 0.5, -0.19 + bob, -0.38], r: [-0.88 + bob, 0.16 + sway * 0.3, 0.08] }
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
                  if (this.input.isFiring()) {
                    const cycle = (time * 1.4) % 1;
                    // Fortnite-style harvest swing: cock the head up-right,
                    // SWEEP it diagonally down-across to the left, recover.
                    const raise = THREE.MathUtils.smoothstep(cycle, 0, 0.55);
                    const strike = THREE.MathUtils.smoothstep(cycle, 0.55, 0.78);
                    const recover = THREE.MathUtils.smoothstep(cycle, 0.8, 1);
                    const arc = 1 - recover;
                    return {
                      p: [
                        0.3 + (raise * 0.1 - strike * 0.32) * arc,
                        -0.24 + (raise * 0.08 - strike * 0.2) * arc,
                        -0.7 - strike * 0.12 * arc,
                      ],
                      r: [
                        0.5 + (raise * 0.6 - strike * 1.5) * arc,
                        0.15 + (raise * 0.25 - strike * 0.6) * arc,
                        -0.15 + (-raise * 0.15 + strike * 0.45) * arc,
                      ],
                    };
                  }
                  // Rest: head UP at the far end, hand low on the haft.
                  return { p: [0.3 + sway * 0.4, -0.24 + bob, -0.7], r: [0.5 + bob, 0.15 + sway * 0.2, -0.15] };
                })()
              // Shovel is long — lay it DIAGONALLY across the lower-right (blade
              // low, handle up-left) via a roll about the view axis, so the whole
              // tool stays in the frame plane instead of receding down-forward.
              : { p: [0.22 + sway * 0.4, -0.34 + bob, -0.54], r: [-0.2 + bob, 0.3 + sway * 0.2, 0.8] }; // shovel
        this.localViewPocketRoot.visible = true;
        this.localViewPocketRoot.position.set(cfg.p[0], cfg.p[1], cfg.p[2]);
        this.localViewPocketRoot.rotation.set(cfg.r[0], cfg.r[1], cfg.r[2]);
        return true;
      }
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const slot = this.input.getSupplyWheelHeldSlot();
    if (slot === null && !usingPreview) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const kind = usingPreview ? this.pocketUsePreviewKind! : this.getPocketWheelKind(player, slot!);
    if (!kind || (!usingPreview && this.getPocketWheelCount(player, slot!) <= 0)) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
    if (!mesh || this.localViewPocketKind !== kind) {
      this.localViewPocketRoot.clear();
      mesh = makePocketPreviewMesh(kind);
      mesh.name = 'local-pocket';
      mesh.rotation.y = Math.PI;
      mesh.scale.setScalar(1.35);
      applyViewmodelMaterialSettings(mesh);
      this.localViewPocketRoot.add(mesh);
      this.localViewPocketKind = kind;
    }

    const time = this.ocean.getTime();
    const moveAxes = this.input.getMoveAxes();
    const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
    const bob = Math.sin(time * (5.2 + moveAmount * 2.2)) * (0.006 + moveAmount * 0.014);
    const sway = Math.sin(time * (2.8 + moveAmount * 1.4)) * (0.005 + moveAmount * 0.01);
    const previewDuration = kind === 'wood' ? 0.45 : 0.82;
    const eatProgress = usingPreview
      ? 1 - THREE.MathUtils.clamp(this.pocketUsePreviewTimer / previewDuration, 0, 1)
      : 0;
    const biteArc = Math.sin(eatProgress * Math.PI);
    const toMouth = kind === 'wood' ? 0 : THREE.MathUtils.smoothstep(eatProgress, 0.1, 0.72);

    // Lift the lantern up into view when raised (ATTACK held), matching the light flare.
    const lanternLift = kind === 'lantern' ? this.lanternRaise01 : 0;
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

  private syncLocalViewWeapon() {
    if (this.syncLocalViewPocket()
      // Opening the supply wheel or the map holsters the gun — you're not aiming.
      || this.input.isSupplyWheelOpen()
      || this.map.mapOpen) {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      this.localCutlassCharge = 0;
      return;
    }

    const player = this.getLocalPlayer();
    const activeWeapon = player?.atCannon || player?.atHelm || player?.atSails ? null : player?.weapons[player.activeSlot] ?? null;
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
      this.localViewWeaponRoot.clear();
      weaponMesh = makeHeldWeaponMesh(weaponId);
      weaponMesh.name = 'local-view-weapon';
      weaponMesh.rotation.y = Math.PI;
      weaponMesh.scale.setScalar(
        weaponId === 'eye_of_reach'
          ? 0.92
          : weaponId === 'blunderbuss'
            ? 0.95
            : 1.2,
      );
      applyViewmodelMaterialSettings(weaponMesh);
      this.localViewWeaponRoot.add(weaponMesh);
      this.localViewWeaponId = weaponId;
    }

    const firearmEquipped = !WEAPONS[weaponId].melee;
    const cutlassEquipped = weaponId === 'cutlass';
    const cutlassBlocking = cutlassEquipped && this.input.isAiming() && !this.input.isFiring() && !activeWeapon.reloading;
    const cutlassCharging = cutlassEquipped && this.input.isFiring() && !cutlassBlocking && !activeWeapon.reloading;
    if (cutlassCharging) {
      this.localCutlassCharge = Math.min(1, this.localCutlassCharge + this.frameDt / CUTLASS_VIEW_CHARGE_TIME);
    } else {
      this.localCutlassCharge += (0 - this.localCutlassCharge) * Math.min(1, this.frameDt * (activeWeapon.reloading ? 14 : 8));
    }
    const aimBlend = firearmEquipped && this.input.isAiming() ? 1 : 0;
    const time = this.ocean.getTime();
    const moveAxes = this.input.getMoveAxes();
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
    const firingNow = firearmEquipped && this.input.isFiring();
    const canFire = activeWeapon.ammo > 0 && !activeWeapon.reloading;
    if (firingNow && canFire && !this.prevLocalFiring) {
      this.triggerMuzzleFlash(weaponId);
      // Crack the shot locally the instant the trigger drops (sniper included),
      // instead of waiting for the server tracer to replicate ~1 RTT later.
      this.combatFx.playLocalShot(weaponId, this.renderer.camera.position);
      this.localViewWeaponKick = Math.min(1.35, this.localViewWeaponKick + 0.55);
    }
    this.prevLocalFiring = firingNow;
    const kickTarget = firearmEquipped && this.input.isFiring() && !activeWeapon.reloading ? 0.72 : 0;
    this.localViewWeaponKick += (kickTarget - this.localViewWeaponKick) * Math.min(1, this.frameDt * (kickTarget > this.localViewWeaponKick ? 18 : 13));
    const reloadBlend = activeWeapon.reloading && firearmEquipped
      ? 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / Math.max(0.001, WEAPONS[weaponId].reloadTime), 0, 1)
      : 0;
    if (activeWeapon.reloading && firearmEquipped) {
      this.localViewWeaponReloadPhase = reloadBlend;
    } else {
      this.localViewWeaponReloadPhase += (0 - this.localViewWeaponReloadPhase) * Math.min(1, this.frameDt * 10);
    }
    const reloadArc = Math.sin(this.localViewWeaponReloadPhase * Math.PI);
    const recoilBack = this.localViewWeaponKick * 0.12;
    const recoilLift = this.localViewWeaponKick * 0.045;
    const recoilRoll = this.localViewWeaponKick * 0.055;

    // A raised spyglass (hold P) occupies both hands — stow the weapon.
    this.localViewWeaponRoot.visible = !this.spyglassActive;

    switch (weaponId) {
      case 'eye_of_reach':
        // Brought up/in/closer for real screen presence (was a tiny stick in
        // the far corner); ADS still swings it to center-scope.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.32, 0.025, aimBlend) + sway * 0.26 + travelSwing * 0.18 + reloadArc * 0.06,
          THREE.MathUtils.lerp(-0.3, -0.15, aimBlend) + bob * 0.75 - recoilLift - reloadArc * 0.04,
          THREE.MathUtils.lerp(-0.8, -0.42, aimBlend) - recoilBack * 0.72 + reloadArc * 0.06,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.26 + aimBlend * 0.0 - recoilLift * 1.1 + reloadArc * 0.18,
          -0.24 + aimBlend * 0.19 - reloadArc * 0.22,
          -0.1 - strafeTilt * 0.8 - recoilRoll + reloadArc * 0.1,
        );
        break;
      case 'blunderbuss':
        // Lower-right hip with real screen PRESENCE (reads as a gun) without
        // parking the fat stock over center; barrel angled toward the
        // crosshair so the muzzle flash lands in the visible lower third.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.34, 0.16, aimBlend) + sway * 0.36 + travelSwing * 0.28 + reloadArc * 0.08,
          THREE.MathUtils.lerp(-0.28, -0.24, aimBlend) + bob - recoilLift * 0.8 - reloadArc * 0.06,
          THREE.MathUtils.lerp(-0.82, -0.7, aimBlend) - recoilBack * 0.72 + reloadArc * 0.1,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.24 - aimBlend * 0.07 - recoilLift + reloadArc * 0.28,
          -0.18 + aimBlend * 0.12 - reloadArc * 0.34,
          -0.08 - strafeTilt - recoilRoll * 0.8 + reloadArc * 0.14,
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
          const cooldownProgress = this.getCutlassSwingProgress(player);
          const swingKind = this.cutlassSwingKind.get(player.id) ?? 'swing';
          const charge = this.localCutlassCharge;
          const chargeReadyPulse = charge > 0.96 ? Math.sin(time * 22) * 0.018 : 0;
          if (cooldownProgress > 0.001 && this.prevCutlassSwingProgress <= 0.001) {
            if (swingKind === 'lunge') {
              this.cutlassDashKick = 1;
              this.cameraShake = Math.min(1, this.cameraShake + 0.2);
              this.spawnViewSlashStreak();
            } else {
              this.cutlassSlashSide = this.cutlassSlashSide === 1 ? -1 : 1;
              this.spawnViewSlashArc(this.cutlassSlashSide);
            }
          }
          this.prevCutlassSwingProgress = cooldownProgress;
          const mixPose = (a: number[], b: number[], t: number) => {
            for (let i = 0; i < 6; i++) a[i] += (b[i] - a[i]) * t;
            return a;
          };
          // Ready stance: hilt lower-right, blade rising across toward screen
          // center, tip angled forward — the sword is SEEN at rest.
          const REST = [0.34, -0.36, -0.6, -0.62, -0.1, 0.28];
          if (cutlassBlocking) {
            // Guard: blade held horizontally across the view.
            this.localViewWeaponRoot.position.set(
              0.2 + sway * 0.14,
              -0.2 + bob * 0.45,
              -0.5 + travelSwing * 0.08,
            );
            this.localViewWeaponRoot.rotation.set(-0.7, -0.1, -1.35 - strafeTilt * 0.4);
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
                  mixPose([...REST], [0.45, -0.35, -0.45, -0.55, -0.35, -0.55], windup),
                  [0.1, -0.22, -0.85, -1.62, 0, -0.08], stab,
                ),
                [0.13, -0.25, -0.78, -1.5, -0.04, -0.16], carry,
              ),
              REST, recover,
            );
            this.localViewWeaponRoot.position.set(pose[0], pose[1] + bob * 0.3, pose[2]);
            this.localViewWeaponRoot.rotation.set(pose[3], pose[4], pose[5] - strafeTilt * 0.6);
          } else if (cooldownProgress > 0.001) {
            // SLASH: cock high on one side, tip driven FORWARD through a
            // cross-screen arc (roll carries the sweep), follow through low
            // on the other side, ease home. Alternates diagonals.
            const sSide = this.cutlassSlashSide;
            const p = cooldownProgress;
            const cock = THREE.MathUtils.smoothstep(p, 0, 0.14);
            const cut = THREE.MathUtils.smoothstep(p, 0.14, 0.4);
            const through = THREE.MathUtils.smoothstep(p, 0.4, 0.58);
            const recover = THREE.MathUtils.smoothstep(p, 0.62, 1);
            // Roll-dominant arc: the blade lies BACK on the cock side, sweeps
            // visibly ACROSS the screen at the cut (tip strongly lateral, only
            // moderately forward), and finishes low on the far side. Pitch-
            // dominant keys foreshorten the blade into an unreadable smudge.
            const pose = mixPose(
              mixPose(
                mixPose(
                  mixPose([...REST], [0.28 + 0.24 * sSide, -0.05, -0.6, -0.75, -0.25 * sSide, -1.15 * sSide], cock),
                  [0.05 - 0.15 * sSide, -0.32, -0.6, -0.7, 0.15 * sSide, 1.1 * sSide], cut,
                ),
                [0.05 - 0.35 * sSide, -0.38, -0.55, -0.55, 0.25 * sSide, 1.75 * sSide], through,
              ),
              REST, recover,
            );
            this.localViewWeaponRoot.position.set(pose[0], pose[1] + bob * 0.3, pose[2]);
            this.localViewWeaponRoot.rotation.set(pose[3], pose[4], pose[5] - strafeTilt * 0.8);
          } else {
            // Rest / charge wind-up: cocks deeper low-right as the charge builds.
            this.localViewWeaponRoot.position.set(
              REST[0] + charge * 0.08 + sway * 0.24 + travelSwing * 0.42,
              REST[1] - charge * 0.06 + chargeReadyPulse + bob * 0.75,
              REST[2] + charge * 0.1,
            );
            this.localViewWeaponRoot.rotation.set(
              REST[3] + charge * 0.12,
              REST[4] - charge * 0.25,
              REST[5] - charge * 0.68 - strafeTilt * 1.4,
            );
          }
        }
        break;
      default:
        // Flintknock + fallback: readable lower-right presence, barrel angled
        // toward the crosshair so the muzzle flash lands on screen.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.26, 0.085, aimBlend) + sway * 0.64 + travelSwing * 0.38 + reloadArc * 0.07,
          THREE.MathUtils.lerp(-0.22, -0.17, aimBlend) + bob - recoilLift * 0.62 - reloadArc * 0.05,
          THREE.MathUtils.lerp(-0.52, -0.4, aimBlend) - recoilBack * 0.8 + reloadArc * 0.06,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.2 - aimBlend * 0.07 - recoilLift + reloadArc * 0.24,
          -0.18 + aimBlend * 0.14 - reloadArc * 0.22,
          -0.1 - strafeTilt - recoilRoll + reloadArc * 0.12,
        );
        break;
    }

    // Eye of Reach: keep the 3D scope tube (classic look). Hide stock/barrel/grip while ADS; counter-scale so narrow scope FOV does not balloon the viewmodel.
    if (weaponId === 'eye_of_reach' && weaponMesh) {
      const adsScope = this.input.isAiming() && !activeWeapon.reloading;
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
        const liveHalf = THREE.MathUtils.degToRad(Math.max(adsFov * 0.85, this.renderer.camera.fov) * 0.5);
        this.localViewWeaponRoot.scale.setScalar(Math.tan(liveHalf) / Math.tan(hipHalf));
      } else {
        // Hip viewmodels at 82%: guns should frame the fight, not block it.
        this.localViewWeaponRoot.scale.setScalar(0.82);
      }
    } else {
      this.localViewWeaponRoot.scale.setScalar(1);
    }
  }

  private getLookInteraction(
    player: Player,
    ship: Ship | null,
    nearbyCannon: number | null,
    repairSection: keyof Ship['hull'] | null,
  ): { prompt: string; label: string; kind: ClientInteractKind } | null {
    const candidates: Array<{ prompt: string; label: string; score: number; kind: ClientInteractKind }> = [];
    // A FOUNDERING ship offers no work: every station/repair/board prompt on
    // it is a lie (the server refuses, the crew has splashed out) — pressing
    // a stale "[X] Use Cannon" on a sinking deck read as "X threw me in the
    // water". Drop the ship from candidate generation entirely.
    if (ship?.sinking) {
      ship = null;
      nearbyCannon = null;
      repairSection = null;
    }

    // Downed crewmate nearby → hold to revive (server drains reviveProgress).
    if (this.state && player.state === 'alive' && player.shipId) {
      for (const other of this.state.players) {
        if (other.id === player.id || other.state !== 'downed') continue;
        if (other.shipId !== player.shipId) continue;
        const d2 = this.distance2D(player.position.x, player.position.z, other.position.x, other.position.z);
        if (d2 > 3.2 || Math.abs(other.position.y - player.position.y) > 2.2) continue;
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(other.position.x, other.position.y + 0.5, other.position.z),
          3.4,
          0.1,
          `[X] Revive ${other.name}`,
          'Hold to stabilize your crewmate',
          'revive',
        );
      }
    }

    const mermaidShip = this.getMermaidReturnShip(player);
    if (mermaidShip) {
      if (!this.mermaidAnchor || this.mermaidAnchor.shipId !== mermaidShip.id) {
        this.mermaidAnchor = this.createMermaidAnchor(player, mermaidShip);
      }
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(this.mermaidAnchor.x, player.position.y + 0.65, this.mermaidAnchor.z),
        6.4,
        0.12,
        '[X] Return To Ship',
        'Mermaid ferry waiting nearby',
        'mermaid',
      );
    }

    if (player.nearBarrelId) {
      const barrelPos = this.getBarrelWorldPoint(player.nearBarrelId);
      if (barrelPos) {
        const browsingThisBarrel = this.barrelBrowse?.barrelId === player.nearBarrelId;
        this.pushInteractionCandidate(
          candidates,
          player,
          barrelPos,
          5.5,
          0.72,
          browsingThisBarrel ? '[X] Take All' : '[X] Look Inside',
          browsingThisBarrel ? 'Transfer supplies' : 'Supply barrel · opening shows what’s inside',
          'barrel',
        );
      }
    }

    const nearbyGoldHoarder = this.getNearbyGoldHoarder(player);
    if (nearbyGoldHoarder) {
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(nearbyGoldHoarder.npc.position.x, nearbyGoldHoarder.npc.position.y + 1.05, nearbyGoldHoarder.npc.position.z),
        4.6,
        0.2,
        player.carryingChestId
          ? '[X] Sell Chest'
          : (player.treasureMapIslandId && player.gold >= ECONOMY.ARMOR_PRICE && (player.armor ?? 0) < PLAYER.MAX_ARMOR * 0.5)
            ? `[X] Buy Iron Cuirass (${ECONOMY.ARMOR_PRICE}g)`
            : '[X] Get Treasure Map',
        player.carryingChestId
          ? `Gold Hoarder pays toward ${ECONOMY.GOLD_WIN_TARGET}`
          : (player.treasureMapIslandId && player.gold >= ECONOMY.ARMOR_PRICE && (player.armor ?? 0) < PLAYER.MAX_ARMOR * 0.5)
            ? `Combat plate — absorbs ${PLAYER.MAX_ARMOR} damage, lost on death`
            : 'Gold Hoarder chart marks buried treasure',
        'gold_hoarder',
      );
    }

    if (player.nearChestId && !player.carryingChestId) {
      const chestPos = this.getChestWorldPoint(player.nearChestId);
      const chest = this.findChestById(player.nearChestId);
      if (chestPos && chest && chest.carriedByPlayerId !== player.id) {
        const digging = chest.buried && chest.digProgress < 1;
        const prompt = digging
          ? (player.hasShovel ? '[Hold X] Dig' : 'Find a shovel')
          : chest.carriedByPlayerId
            ? '[X] Steal Chest'
            : chest.storedOnShipId
              ? '[X] Take Chest'
              : chest.floating
                ? '[X] Grab Floating Chest'
                : '[X] Pick Up Chest';
        const label = digging
          ? `Buried treasure · ${Math.round(chest.digProgress * 100)}% dug`
          : `Base ${chest.value} gold · Gold Hoarder pays more`;
        this.pushInteractionCandidate(candidates, player, chestPos, 5.5, 0.72, prompt, label, 'chest');
      }
    }

    if (!player.onShipId && player.nearShipId && this.state) {
      const targetShip = this.state.ships.find((candidate) => candidate.id === player.nearShipId && candidate.alive);
      if (targetShip) {
        const ladder = getNearestShipBoardingLadder(targetShip, player.position);
        // Mirror the server's acceptance (PhysicsSystem nearShipId gate):
        // swimmers board within 3.5m of the LADDER point, islanders within
        // 3.0m. The old deck-height candidate showed [X] in spots where
        // tryBoardFromLadder refused — pressing did nothing.
        const maxLadderDist = player.state === 'swimming' ? 3.5 : 3.0;
        if (ladder && ladder.distance <= maxLadderDist) {
          const boardPoint = new THREE.Vector3(ladder.x, targetShip.position.y + SHIP_STATS[targetShip.type].height * 0.4, ladder.z);
          this.pushInteractionCandidate(candidates, player, boardPoint, 7.0, 0.35, '[X] Climb Ladder', 'Board from the side ladder', 'board');
        }
      }
    }

    // Axe harvest — CLIENT-ONLY prompt ('harvest' never rides interactIntent);
    // holding LMB swings the axe and the server does the felling via useItem.
    if (player.equippedTool === 'axe' && player.state === 'alive' && this.state) {
      const harvestTarget = this.findHarvestTarget(player);
      if (harvestTarget) {
        const { prop: bestProp, island: bestIsland } = harvestTarget;
        const isPalm = bestProp.type.startsWith('palm_');
        const propY = getIslandSurfaceY(bestIsland, bestProp.x, bestProp.z);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(bestProp.x, propY + (isPalm ? 1.6 : 0.7), bestProp.z),
          HARVEST.RANGE + 1.6,
          0.2,
          isPalm ? '[Hold LMB] Chop Palm — wood' : '[Hold LMB] Crack Boulder — ore',
          isPalm
            ? `Fells in ~${HARVEST.CHOP_TIME}s · ${HARVEST.WOOD_PER_TREE_MIN}–${HARVEST.WOOD_PER_TREE_MAX} wood`
            : `Cracks in ~${HARVEST.MINE_TIME}s · ${HARVEST.ORE_PER_BOULDER_MIN}–${HARVEST.ORE_PER_BOULDER_MAX} ore`,
          'harvest',
        );
      }
    }

    if (player.state === 'swimming' && this.state) {
      for (const isl of this.state.islands) {
        if (!isl.dock) continue;
        const dock = isl.dock;
        const dx = player.position.x - dock.position.x;
        const dz = player.position.z - dock.position.z;
        const cos = Math.cos(dock.rotation);
        const sin = Math.sin(dock.rotation);
        const localX = dx * cos + dz * sin;
        const localZ = -dx * sin + dz * cos;
        if (Math.abs(localX) > dock.width * 0.42) continue;
        if (localZ > -dock.length * 0.08 || localZ < -dock.length * 0.58) continue;
        const ladderPoint = getIslandDockSwimLadderPoint(dock);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(ladderPoint.x, ladderPoint.y, ladderPoint.z),
          4.2,
          0.45,
          '[X] Climb Dock Ladder',
          'Swim up to the wooden dock',
          'dock',
        );
      }
    }

    const nearbyKeg = this.findNearbyKeg(player, ship ?? null);
    if (nearbyKeg) {
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(nearbyKeg.position.x, nearbyKeg.position.y + 0.45, nearbyKeg.position.z),
        3,
        0.3,
        '[X] Defuse Powder Keg',
        `${Math.max(1, Math.ceil(nearbyKeg.timer))}s until detonation`,
        'keg_diffuse',
      );
    }

    if (ship) {
      // Bail the bilge — physical bucket work. Only offered with the BUCKET tool
      // equipped from the supply wheel; otherwise a hint nudges you to equip it.
      // Low priority so cannons/helm/repairs win when you're facing one.
      const flooded = (ship.waterLevel ?? 0) > 0.02;
      const hasBucket = player.equippedTool === 'bucket';
      if (player.onShipId === ship.id && (flooded || (hasBucket && player.bucketFilled))) {
        const pct = Math.round((ship.waterLevel ?? 0) * 100);
        let prompt: string;
        let label: string;
        if (!hasBucket) {
          prompt = 'Equip the Bucket [Hold I] to bail';
          label = `Bilge flooding ${pct}% · grab the bucket from the supply wheel`;
        } else if (player.bucketFilled) {
          prompt = '[X] Heave the water overboard';
          label = 'Bucket full — toss it over the side';
        } else {
          prompt = '[X] Fill the bucket from the bilge';
          label = `Bilge flooding ${pct}% · scoop a bucketful out`;
        }
        candidates.push({ prompt, label, score: -0.5, kind: 'bail' });
      }

      if (player.carryingChestId && player.onShipId === ship.id) {
        const stats = SHIP_STATS[ship.type];
        const stowPoint = this.getShipWorldPoint(ship, 0, -stats.length * 0.22, stats.height + 0.7);
        this.pushInteractionCandidate(
          candidates,
          player,
          stowPoint,
          4.8,
          0.16,
          '[X] Stow Chest',
          'Place chest on deck for the crew',
          'stow_chest',
        );
      }

      const nearbyStation = this.getNearbyUpgradeStation(player);
      if (
        nearbyStation
        && nearbyStation.claimedByShipId !== ship.id
        && !ship.upgrades.some((upgrade) => upgrade.type === nearbyStation.type)
      ) {
        const meta = this.getUpgradePresentation(nearbyStation.type);
        // Materials honesty: show the recipe and whether the crew can pay it
        // (pocket + ship hold combined — the server drains the same pool).
        const cost = UPGRADE_COSTS[nearbyStation.type];
        const woodHave = player.pocketWood + this.getInventoryQty(ship, 'wood_plank');
        const oreHave = (player.pocketOre ?? 0) + this.getInventoryQty(ship, 'ore');
        const needs: string[] = [];
        if (woodHave < cost.wood) needs.push(`Need ${cost.wood - woodHave} more wood`);
        if (oreHave < cost.ore) needs.push(`Need ${cost.ore - oreHave} more ore`);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(nearbyStation.position.x, nearbyStation.position.y + 0.9, nearbyStation.position.z),
          4.4,
          0.2,
          `[X] Claim ${meta.name} — ${cost.wood} wood · ${cost.ore} ore`,
          `${needs.length > 0 ? needs.join(' · ') : 'Materials ready'} · ${meta.effect}`,
          'upgrade',
        );
      }

      if (this.isNearHelm(player, ship)) {
        const helmPoint = this.getShipWorldPoint(ship, 0, -SHIP_STATS[ship.type].length * 0.37, SHIP_STATS[ship.type].height + 0.95);
        this.pushInteractionCandidate(candidates, player, helmPoint, 4.2, 0.2, '[X] Take Helm', 'A/D or arrows turn · W/S trims sails', 'helm');
      }

      if (this.isNearSailStation(player, ship)) {
        const ropeStations = getSailRopeStationLocals(SHIP_STATS[ship.type]);
        const localHere = this.toShipLocal(player, ship);
        const sailControl = ropeStations.reduce((best, st) =>
          Math.hypot(localHere.x - st.x, localHere.z - st.z) < Math.hypot(localHere.x - best.x, localHere.z - best.z) ? st : best);
        const sailPoint = this.getShipWorldPoint(ship, sailControl.x, sailControl.z, SHIP_STATS[ship.type].height + 0.85);
        const sailPct = Math.round(ship.sailHeight * 100);
        const canvasTorn = ship.sailIntegrity < 0.995;
        const sailPrompt = canvasTorn
          ? `[X] Hold — Mend the Rigging (${Math.round(ship.sailIntegrity * 100)}%)`
          : ship.sailHeight < 0.5
            ? `[X] Hold — Drop the Sails (${sailPct}%)`
            : `[X] Hold — Raise the Sails (${sailPct}%)`;
        this.pushInteractionCandidate(
          candidates,
          player,
          sailPoint,
          4.2,
          0.08,
          sailPrompt,
          canvasTorn ? 'Needs planks aboard · crewmates on the rope haul faster' : 'Crewmates on the rope haul faster',
          'sails',
        );
      }

      if (player.onShipId === ship.id && ship.sailIntegrity >= 0.995) {
        // Brace rails — the physical station that ANGLES the yard. One
        // candidate per side; the arbiter picks whichever you're looking at.
        const stats = SHIP_STATS[ship.type];
        const trimDeg = Math.round((ship.sailAngle * 180) / Math.PI);
        for (const brace of getBraceStationLocals(stats)) {
          const bracePoint = this.getShipWorldPoint(ship, brace.x, brace.z, stats.height + 0.7);
          this.pushInteractionCandidate(
            candidates,
            player,
            bracePoint,
            4.0,
            0.1,
            `[X] Hold — Brace the Yard to ${brace.dir > 0 ? 'Starboard' : 'Port'} (${trimDeg > 0 ? '+' : ''}${trimDeg}°)`,
            'Angle the sails to catch the wind',
            'brace',
          );
        }
      }

      if (this.isNearCrowNestLadder(player, ship)) {
        const stats = SHIP_STATS[ship.type];
        const mastZ = getMainMastLocalZ(stats);
        const ladderPoint = this.getShipWorldPoint(ship, 0, mastZ, stats.height + 1.15);
        this.pushInteractionCandidate(
          candidates,
          player,
          ladderPoint,
          3.2,
          0.24,
          '[X] Climb the Mast',
          'Main mast ladder · W/S climbs to the crow\'s nest',
          'crow',
        );
      }

      if (this.isNearAnchor(player, ship)) {
        const anchorLocal = this.getAnchorControlLocal(SHIP_STATS[ship.type]);
        const anchorPoint = this.getShipWorldPoint(ship, anchorLocal.x, anchorLocal.z, SHIP_STATS[ship.type].height + 0.45);
        const anchorProgress = Math.round((ship.anchorRaiseProgress ?? 0) * 100);
        this.pushInteractionCandidate(
          candidates,
          player,
          anchorPoint,
          4.4,
          0.18,
          ship.anchored ? `[X] Hold — Raise the Anchor (${anchorProgress}%)` : '[X] Drop the Anchor',
          ship.anchored ? 'Man the capstan · crewmates speed the turn' : 'Stops the ship fast — you will have to crank it back up',
          'anchor',
        );
      }

      if (repairSection) {
        const repairPoint = this.getRepairWorldPoint(ship, repairSection);
        const plankCount = this.getRepairPlankCount(player, ship);
        this.pushInteractionCandidate(
          candidates,
          player,
          repairPoint,
          4.5,
          0.52,
          plankCount > 0
            ? `[X] Repair ${repairSection[0].toUpperCase()}${repairSection.slice(1)}`
            : `⚠ Damaged ${repairSection[0].toUpperCase()}${repairSection.slice(1)}`,
          plankCount > 0
            ? `${plankCount} plank${plankCount === 1 ? '' : 's'} ready`
            : 'No planks ready',
          'repair',
        );
      }

      if (nearbyCannon !== null) {
        const cannonLocal = this.getCannonDeckLocalPosition(SHIP_STATS[ship.type], nearbyCannon);
        const cannonPoint = this.getShipWorldPoint(
          ship,
          cannonLocal.x,
          cannonLocal.z,
          SHIP_STATS[ship.type].height + 0.75,
        );
        this.pushInteractionCandidate(
          candidates,
          player,
          cannonPoint,
          4.8,
          0.16,
          '[X] Use Cannon',
          `Broadside cannon ${nearbyCannon + 1} · [5/6/7] ammo`,
          'cannon',
        );
      }

      // Ammo chest (SoT): aft of the companionway — instant firearm top-up.
      if (player.onShipId === ship.id && isNearAmmoCrate(player, ship)) {
        const crateLocal = getAmmoCrateLocal(SHIP_STATS[ship.type]);
        const cratePoint = this.getShipWorldPoint(ship, crateLocal.x, crateLocal.z, SHIP_STATS[ship.type].height + 0.5);
        this.pushInteractionCandidate(
          candidates,
          player,
          cratePoint,
          3.6,
          0.2,
          '[X] Ammo Chest — Refill Firearms',
          'Tops up every gun and clears reloads',
          'ammo',
        );
      }
    }

    // Tavern doors — a client-local toggle; the candidate rides the same
    // arbiter so its prompt can never stack with another [X] prompt.
    if (this.tavernDoors.length > 0) {
      const doorPoint = new THREE.Vector3();
      for (const door of this.tavernDoors) {
        if (!door.node.parent) continue;
        this.getTavernDoorWorldPoint(door, doorPoint);
        this.pushInteractionCandidate(
          candidates,
          player,
          doorPoint,
          3.4,
          0.2,
          `[X] ${door.open ? 'Close' : 'Open'} Door`,
          'Tavern',
          'door',
        );
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  private pushInteractionCandidate(
    candidates: Array<{ prompt: string; label: string; score: number; kind: ClientInteractKind }>,
    player: Player,
    point: THREE.Vector3,
    maxDistance: number,
    minDot: number,
    prompt: string,
    label: string,
    kind: ClientInteractKind,
  ) {
    const eyePos = new THREE.Vector3(player.position.x, player.position.y + PLAYER.HEIGHT * 0.72, player.position.z);
    const toPoint = point.clone().sub(eyePos);
    const distance = toPoint.length();
    if (distance > maxDistance) return;

    const lookDir = this.getLookDirection(player);
    const dot = toPoint.normalize().dot(lookDir);
    if (dot < minDot) return;

    candidates.push({ prompt, label, score: dot - distance * 0.035, kind });
  }

  private getLookDirection(player: Player) {
    return new THREE.Vector3(
      Math.sin(player.rotation.x) * Math.cos(player.rotation.y),
      Math.sin(player.rotation.y),
      Math.cos(player.rotation.x) * Math.cos(player.rotation.y),
    ).normalize();
  }

  /** Mid-leaf point of a tavern door (the node origin sits on the hinge). */
  private getTavernDoorWorldPoint(door: { node: THREE.Object3D }, out: THREE.Vector3) {
    return door.node.localToWorld(out.set(0.8, 1.2, 0));
  }

  private toggleNearestTavernDoor() {
    const player = this.getLocalPlayer();
    if (!player) return;
    const point = new THREE.Vector3();
    let best: { islandId: string; node: THREE.Object3D; open: boolean } | null = null;
    let bestDist = 3.8;
    for (const door of this.tavernDoors) {
      if (!door.node.parent) continue;
      this.getTavernDoorWorldPoint(door, point);
      const d = Math.hypot(point.x - player.position.x, point.z - player.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = door;
      }
    }
    if (!best) return;
    best.open = !best.open;
    this.audio.playDoorCreak(best.open);
  }

  /** Ease every registered tavern door toward its open/closed pose. The GLB
   *  front faces +Z, so negative yaw swings the leaf OUTWARD (clear of the
   *  interior furniture and the barrel clutter beside the jamb). */
  private updateTavernDoors(dt: number) {
    const ease = Math.min(1, dt * 5.5);
    for (const door of this.tavernDoors) {
      const target = door.open ? -1.83 : 0;
      const diff = target - door.node.rotation.y;
      if (Math.abs(diff) < 0.002) {
        door.node.rotation.y = target;
        continue;
      }
      door.node.rotation.y += diff * ease;
    }
  }

  private getShipWorldPoint(ship: Ship, localX: number, localZ: number, worldY: number) {
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return new THREE.Vector3(
      ship.position.x + localX * cos + localZ * sin,
      ship.position.y + worldY,
      ship.position.z + localZ * cos - localX * sin,
    );
  }

  private getRepairWorldPoint(ship: Ship, section: keyof Ship['hull']) {
    const stats = SHIP_STATS[ship.type];
    switch (section) {
      case 'bow':
        return this.getShipWorldPoint(ship, 0, stats.length * 0.44, stats.height + 0.4);
      case 'stern':
        return this.getShipWorldPoint(ship, 0, -stats.length * 0.42, stats.height + 0.4);
      case 'port':
        return this.getShipWorldPoint(ship, -stats.width * 0.54, 0, stats.height + 0.4);
      case 'starboard':
      default:
        return this.getShipWorldPoint(ship, stats.width * 0.54, 0, stats.height + 0.4);
    }
  }

  private getCannonSide(cannonIndex: number, ship: Ship) {
    return cannonIndex < Math.max(1, SHIP_STATS[ship.type].cannonCount / 2) ? 1 : -1;
  }

  private getCannonAim(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    const broadsideYaw = ship.rotation + (this.getCannonSide(cannonIndex, ship) > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
    return {
      yaw: broadsideYaw + THREE.MathUtils.clamp(angleWrap(yaw - broadsideYaw), -SHIP.CANNON_YAW_ARC, SHIP.CANNON_YAW_ARC),
      pitch: THREE.MathUtils.clamp(pitch, SHIP.CANNON_PITCH_MIN, SHIP.CANNON_PITCH_MAX),
    };
  }

  private findNearbyKeg(player: Player, ship: Ship | null = null): ShipKeg | null {
    if (!this.state) return null;
    let closest: ShipKeg | null = null;
    let closestDistance: number = SHIP.KEG_DIFFUSE_RANGE;
    for (const keg of this.state.kegs) {
      if (ship && keg.shipId && keg.shipId !== ship.id) continue;
      if (keg.timer <= 0) continue;
      const dx = player.position.x - keg.position.x;
      const dy = player.position.y - keg.position.y;
      const dz = player.position.z - keg.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = keg;
      }
    }
    return closest;
  }

  private getNearbyUpgradeStation(player: Player): UpgradeStation | null {
    if (!this.state) return null;
    let closest: UpgradeStation | null = null;
    let closestDistance: number = PLAYER.INTERACT_RANGE;
    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const dx = player.position.x - station.position.x;
        const dz = player.position.z - station.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = station;
        }
      }
    }
    return closest;
  }

  private getNearbyGoldHoarder(player: Player): { npc: IslandNpc; island: Island } | null {
    if (!this.state) return null;
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = this.distance2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (distance < PLAYER.INTERACT_RANGE + 0.85 && (!closest || distance < closest.distance)) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest ? { npc: closest.npc, island: closest.island } : null;
  }

  private getClosestGoldHoarder(player: Player): { npc: IslandNpc; island: Island; distance: number } | null {
    if (!this.state) return null;
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = this.distance2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (!closest || distance < closest.distance) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest;
  }

  private getMermaidReturnShip(player: Player): Ship | null {
    if (!this.state || player.state !== 'swimming' || !player.shipId) return null;
    const homeShip = this.state.ships.find((ship) => ship.id === player.shipId && ship.alive && !ship.sinking) ?? null;
    if (!homeShip) return null;
    return this.distance2D(player.position.x, player.position.z, homeShip.position.x, homeShip.position.z) >= 45
      ? homeShip
      : null;
  }

  private findChestById(chestId: string): TreasureChest | null {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (chest) return chest;
    }
    return null;
  }

  private getChestWorldPoint(chestId: string) {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (chest) {
        const y = chest.buried && chest.digProgress < 1
          ? getIslandSurfaceY(island, chest.position.x, chest.position.z) + 0.35
          : chest.position.y + 0.8;
        return new THREE.Vector3(chest.position.x, y, chest.position.z);
      }
    }
    return null;
  }

  private getBarrelWorldPoint(barrelId: string) {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const barrel = island.barrels.find((b) => b.id === barrelId);
      if (barrel) {
        return new THREE.Vector3(barrel.position.x, barrel.position.y + 0.55, barrel.position.z);
      }
    }
    return null;
  }

  private getNearestIsland(px: number, pz: number): Island | null {
    if (!this.state) return null;
    let best: Island | null = null;
    let bestD = Infinity;
    for (const island of this.state.islands) {
      const dx = px - island.position.x;
      const dz = pz - island.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD) {
        bestD = d;
        best = island;
      }
    }
    return best;
  }

  private flashIslandBanner(name: string) {
    // Don't slam a discovery banner over an open wheel/legend — the next
    // island (or re-entry) will announce itself when the center is clear.
    const legend = document.getElementById('controls-hint');
    if (this.input.isSupplyWheelOpen() || legend?.style.display === 'block') return;
    this.ui.islandBanner.innerHTML = `<div class="ib-title">${name}</div><div class="ib-sub">Land discovered</div>`;
    this.ui.islandBanner.classList.add('visible');
    this.islandBannerHideAt = performance.now() + 4500;
  }

  private playIslandArrivalFanfare() {
    try {
      const win = window as unknown as { webkitAudioContext?: typeof AudioContext };
      const Ctx = window.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      const ctx = this.islandArrivalAudioCtx ?? new Ctx();
      this.islandArrivalAudioCtx = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 987.77];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, now + i * 0.11);
        g.gain.linearRampToValueAtTime(0.065, now + i * 0.11 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.38);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + i * 0.11);
        o.stop(now + i * 0.11 + 0.42);
      });
    } catch {
      /* Web Audio optional */
    }
  }

  private initWindWisps() {
    if (this.windWispMeshes.length > 0) return;

    const geometry = new THREE.PlaneGeometry(3.1, 0.22);
    const count = this.renderer.getQuality() === 'low' ? 0 : this.renderer.getQuality() === 'balanced' ? 4 : 8;
    if (count === 0) {
      this.windWisps.visible = false;
      return;
    }
    for (let index = 0; index < count; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: this.windWispTexture,
        color: 0xe5f7ff,
        transparent: true,
        opacity: 0.032 + Math.random() * 0.025,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.windWisps.add(mesh);
      this.windWispMeshes.push({
        mesh,
        radius: 1.2 + Math.random() * 4.8,
        height: 0.18 + Math.random() * 1.7,
        phase: Math.random(),
        speed: 0.16 + Math.random() * 0.18,
        sway: (Math.random() - 0.5) * 1.8,
        tilt: (Math.random() - 0.5) * 0.08,
      });
    }
  }

  private updateWindWisps() {
    if (this.windWispMeshes.length === 0) {
      this.windWisps.visible = false;
      return;
    }
    const player = this.getLocalPlayer();
    if (!player) {
      this.windWisps.visible = false;
      return;
    }

    const trackedShip = this.getTrackedShip();
    const time = this.ocean.getTime();
    const wind = sampleWind(time);
    const dirX = Math.sin(wind.direction);
    const dirZ = Math.cos(wind.direction);
    const rightX = dirZ;
    const rightZ = -dirX;
    const shipDeckHeight = trackedShip ? SHIP_STATS[trackedShip.type].height : 0;
    const anchorX = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.x : player.position.x;
    const anchorY = trackedShip && player.onShipId === trackedShip.id
      ? trackedShip.position.y + shipDeckHeight + 1.1
      : player.position.y + PLAYER.HEIGHT * 0.6;
    const anchorZ = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.z : player.position.z;
    const laneLength = trackedShip ? SHIP_STATS[trackedShip.type].length * 0.95 : 10;
    this.windWisps.visible = true;

    for (const wisp of this.windWispMeshes) {
      const cycle = ((time * wisp.speed + wisp.phase) % 1 + 1) % 1;
      const along = (cycle - 0.5) * laneLength;
      const lateral = Math.sin(time * 0.85 + wisp.phase * Math.PI * 2) * wisp.radius + wisp.sway;
      const bob = Math.sin(time * 1.8 + wisp.phase * Math.PI * 4) * 0.2;
      wisp.mesh.position.set(
        anchorX + dirX * along + rightX * lateral,
        anchorY + wisp.height + bob,
        anchorZ + dirZ * along + rightZ * lateral,
      );
      wisp.mesh.rotation.set(wisp.tilt, wind.direction, 0);
      wisp.mesh.scale.set(0.86 + wind.strength * 0.78, 1 + wind.strength * 0.3, 1);
      const alpha = (0.028 + wind.strength * 0.052) * (1 - Math.abs(cycle - 0.5) * 1.05);
      (wisp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0.01, alpha);
    }
  }

  private toShipLocal(player: Player, ship: Ship) {
    return toShipLocalPoint(player.position, ship);
  }

  private isNearHelm(player: Player, ship: Ship) {
    return isSharedNearHelm(player, ship);
  }

  private isNearSailStation(player: Player, ship: Ship) {
    return isSharedNearSailStation(player, ship);
  }

  private isNearCrowNestLadder(player: Player, ship: Ship): boolean {
    return isSharedNearCrowNestLadder(player, ship);
  }

  private isNearAnchor(player: Player, ship: Ship) {
    return isSharedNearAnchor(player, ship);
  }

  private getAnchorControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSharedAnchorControlLocal(stats);
  }

  private getSailControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSharedSailControlLocal(stats);
  }

  private findRepairableHullSection(player: Player, ship: Ship): keyof Ship['hull'] | null {
    const local = this.toShipLocal(player, ship);
    const candidate: keyof Ship['hull'] =
      Math.abs(local.x) > Math.abs(local.z)
        ? (local.x >= 0 ? 'starboard' : 'port')
        : (local.z >= 0 ? 'bow' : 'stern');
    const closeEnough =
      candidate === 'bow' || candidate === 'stern'
        ? Math.abs(local.z) > SHIP_STATS[ship.type].length * 0.34
        : Math.abs(local.x) > SHIP_STATS[ship.type].width * 0.38;
    return closeEnough && ship.hull[candidate] < 0.98 ? candidate : null;
  }

  private findNearbyCannonIndex(player: Player, ship: Ship): number | null {
    return findSharedNearbyCannonIndex(player, ship);
  }

  private getCannonDeckLocalPosition(
    stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS],
    cannonIndex: number,
  ): { x: number; z: number } {
    return getSharedCannonDeckLocalPosition(stats, cannonIndex);
  }

  private bindInteractPromptClick() {
    const el = this.ui.interactPrompt;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.lastInteractKind = this.resolveCurrentInteractKind() ?? this.visibleInteractKind;
      this.pendingInteractFromUi = true;
      const t = el.textContent ?? '';
      if (t.includes('Launch')) {
        this.pendingLaunchFromUi = true;
      }
    });
  }

  private setupStormWeatherOverlay() {
    const wrap = document.createElement('div');
    wrap.id = 'storm-weather-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden;';
    const cvs = document.createElement('canvas');
    cvs.id = 'storm-rain-canvas';
    cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    const flash = document.createElement('div');
    flash.id = 'storm-lightning-flash';
    flash.style.cssText = 'position:absolute;inset:0;background:#9fc4e6;opacity:0;mix-blend-mode:soft-light;';
    wrap.appendChild(cvs);
    wrap.appendChild(flash);
    const hud = document.getElementById('hud');
    if (hud?.parentNode) {
      hud.parentNode.insertBefore(wrap, hud);
    } else {
      document.body.appendChild(wrap);
    }
    this.stormRainCanvas = cvs;
    this.stormRainCtx = cvs.getContext('2d');
    this.stormLightningFlashEl = flash;
  }

  private setupStoryCutsceneOverlay() {
    const root = document.createElement('div');
    root.id = 'story-cutscene-overlay';
    root.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      // Sit ABOVE the bottom HUD stack (pocket/stores bars) and on a higher
      // z-index so NPC dialogue is never rendered behind the panels.
      'bottom:20vh',
      'z-index:140',
      'pointer-events:none',
      'display:flex',
      'justify-content:center',
      'opacity:0',
      'transform:translateY(14px)',
      'transition:opacity 420ms ease,transform 420ms ease',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:min(760px,calc(100vw - 42px))',
      'border-top:1px solid rgba(226,197,122,.6)',
      'border-bottom:1px solid rgba(226,197,122,.42)',
      'background:linear-gradient(90deg,rgba(7,10,16,0),rgba(8,11,17,.88) 13%,rgba(8,11,17,.9) 87%,rgba(7,10,16,0))',
      'padding:18px 34px 20px',
      'box-sizing:border-box',
      'text-align:center',
      'color:#f3e4bc',
      'text-shadow:0 2px 8px rgba(0,0,0,.75)',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font:700 18px Georgia,serif;letter-spacing:.04em;text-transform:uppercase;color:#f4cf7a;';
    const name = document.createElement('div');
    name.style.cssText = 'font:600 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#aebdd3;margin-top:5px;';
    const line = document.createElement('div');
    line.style.cssText = 'font:500 20px/1.38 Georgia,serif;margin-top:12px;color:#fff5d8;';
    const cue = document.createElement('div');
    cue.style.cssText = 'font:600 12px/1.3 system-ui,sans-serif;margin-top:10px;color:#d5bb79;';

    panel.appendChild(title);
    panel.appendChild(name);
    panel.appendChild(line);
    panel.appendChild(cue);
    root.appendChild(panel);
    document.body.appendChild(root);
    this.storyCutscene = { root, title, name, line, cue };
  }

  private computeStormWeatherIntensity(): number {
    if (!this.state) return 0;
    const player = this.getLocalPlayer();
    if (!player) return 0;
    const dist = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ);

    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const phaseBoost = Math.min(1, phase / maxPhase) * 0.2;
    const shrinkBoost = this.state.storm.shrinking ? 0.08 + this.state.storm.shrinkProgress * 0.08 : 0;

    // Crossfade across a ±30m band at the wall — weather used to snap from
    // 0.24 to 0.52+ the frame you crossed the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -30, 30);
    const stormDepth = THREE.MathUtils.clamp(distOutside / 240, 0, 1);
    const edgeFade = THREE.MathUtils.clamp((dist / safeRadius - 0.84) / 0.16, 0, 1);
    const insideIntensity = Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
    const outsideIntensity = Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
    return THREE.MathUtils.lerp(insideIntensity, outsideIntensity, outsideBlend);
  }

  private computeStormRainIntensity(): number {
    if (!this.state) return 0;
    const player = this.getLocalPlayer();
    if (!player) return 0;

    const dist = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ);
    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);

    // Rain builds across the wall band instead of popping on at the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -25, 35);
    if (outsideBlend <= 0.001) return 0;
    const stormDepth = THREE.MathUtils.clamp(distOutside / 220, 0, 1);
    const shrinkBoost = this.state.storm.shrinking ? 0.08 : 0;
    return Math.min(1, 0.34 + stormDepth * 0.42 + (phase / maxPhase) * 0.2 + shrinkBoost) * outsideBlend;
  }

  /** World-space rain: wind-blown line-segment drops falling around the
   *  camera (replaces the old screen-space canvas overlay — rain now exists
   *  in the world, slants with the wind, and reads correctly in motion). */
  private rain3D: {
    lines: THREE.LineSegments;
    material: THREE.LineBasicMaterial;
    geo: THREE.BufferGeometry;
    pos: Float32Array;
    drops: number;
  } | null = null;

  private ensureRain3D() {
    if (this.rain3D) return this.rain3D;
    const drops = 1600;
    const pos = new Float32Array(drops * 2 * 3);
    // Seed deterministically around the origin; first update recenters on camera.
    for (let i = 0; i < drops; i++) {
      const o = i * 6;
      const a = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral: even disc coverage
      const rad = 30 * Math.sqrt(((i * 7919) % 1000) / 1000);
      pos[o] = Math.cos(a) * rad;
      pos[o + 1] = ((i * 37) % 240) / 10 - 4;
      pos[o + 2] = Math.sin(a) * rad;
      pos[o + 3] = pos[o];
      pos[o + 4] = pos[o + 1] - 0.5;
      pos[o + 5] = pos[o + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({
      color: 0xcfe0f4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, material);
    lines.frustumCulled = false;
    lines.renderOrder = 8;
    lines.visible = false;
    this.renderer.scene.add(lines);
    this.rain3D = { lines, material, geo, pos, drops };
    return this.rain3D;
  }

  private updateStormRain3D(dt: number, intensity: number) {
    // Clear the legacy canvas overlay once (kept in the DOM for compatibility).
    if (this.stormRainCanvas && this.stormRainCtx && this.stormRainCanvas.width > 0) {
      this.stormRainCtx.clearRect(0, 0, this.stormRainCanvas.width, this.stormRainCanvas.height);
      this.stormRainCanvas.width = 0;
    }
    if (intensity <= 0.001) {
      if (this.rain3D) this.rain3D.lines.visible = false;
      return;
    }
    const rain = this.ensureRain3D();
    rain.lines.visible = true;
    const cam = this.renderer.camera.position;
    const t = this.ocean.getTime();
    const wind = sampleWind(t);
    const gust = Math.sin(t * 2.7) * 0.5 + Math.sin(t * 6.3 + 1.4) * 0.3;
    const windSpeed = (6 + intensity * 12) * wind.strength + gust * intensity * 3;
    const windX = Math.sin(wind.direction) * windSpeed;
    const windZ = Math.cos(wind.direction) * windSpeed;
    const fallSpeed = 21 + intensity * 11;
    const active = Math.max(24, Math.floor(rain.drops * (0.22 + intensity * 0.78)));
    const streak = 0.55 + intensity * 0.8;
    // Normalized fall direction × streak length for the trailing vertex.
    const vLen = Math.hypot(windX, windZ, fallSpeed);
    const sx = (windX / vLen) * streak;
    const sy = (fallSpeed / vLen) * streak;
    const sz = (windZ / vLen) * streak;
    const pos = rain.pos;
    const spawnRadius = 32;
    for (let i = 0; i < active; i++) {
      const o = i * 6;
      let x = pos[o] + windX * dt * 0.85;
      let y = pos[o + 1] - fallSpeed * dt;
      let z = pos[o + 2] + windZ * dt * 0.85;
      // Recycle drops that fell below the camera or drifted out of the volume.
      const dx = x - cam.x;
      const dz = z - cam.z;
      if (y < cam.y - 8 || dx * dx + dz * dz > spawnRadius * spawnRadius * 1.9) {
        const a = Math.random() * Math.PI * 2;
        const rad = spawnRadius * Math.sqrt(Math.random());
        // Bias the spawn upwind so the slanted fall carries drops across the view.
        x = cam.x + Math.cos(a) * rad - (windX / Math.max(1, windSpeed)) * 8;
        z = cam.z + Math.sin(a) * rad - (windZ / Math.max(1, windSpeed)) * 8;
        y = cam.y + 12 + Math.random() * 14;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      pos[o + 3] = x - sx;
      pos[o + 4] = y + sy;
      pos[o + 5] = z - sz;
    }
    rain.geo.setDrawRange(0, active * 2);
    (rain.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    const nightFactor = this.renderer.getAtmosphere().nightFactor ?? 0;
    rain.material.opacity = (0.13 + intensity * 0.2) * (1 - nightFactor * 0.35);
  }

  private updateStormLightningFlash(dt: number) {
    if (!this.stormLightningFlashEl) return;
    this.stormLightningFlashOpacity = Math.max(0, this.stormLightningFlashOpacity - dt * 4.8);
    this.stormLightningFlashEl.style.opacity = String(this.stormLightningFlashOpacity);
  }

  private updateLightning(dt: number) {
    if (!this.state) return;

    // Fade out any active flash
    if (this.lightningFlash) {
      this.lightningFlash.intensity -= dt * (18 + this.state.storm.phase * 4);
      if (this.lightningFlash.intensity <= 0) {
        this.lightningFlash.intensity = 0; // pooled light stays in the scene
        this.lightningFlash = null;
      }
    }
    if (this.lightningBolt) {
      const boltMat = this.lightningBolt.material as THREE.LineBasicMaterial;
      if (boltMat.opacity > 0) boltMat.opacity = Math.max(0, boltMat.opacity - dt * 6);
    }

    const phase = this.state.storm.phase;
    const player = this.getLocalPlayer();
    const playerDist = player
      ? this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ)
      : 0;
    const outsideStorm = !!player
      && playerDist > this.state.storm.safeRadius;
    const nearStormWall = !!player && Math.abs(playerDist - this.state.storm.safeRadius) < 85;

    // Keep lightning tied to the storm front, not clear water well inside the safe zone.
    if (!outsideStorm && !(this.state.storm.shrinking && nearStormWall) && phase < 2) return;

    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      const stormR = this.state.storm.safeRadius;
      const angle = Math.random() * Math.PI * 2;
      // Strike near the storm wall boundary
      const dist = stormR * (0.88 + Math.random() * 0.38);
      const lx = this.state.storm.centerX + Math.cos(angle) * dist;
      const lz = this.state.storm.centerZ + Math.sin(angle) * dist;

      // Pooled flash light (allocating one per strike forced shader churn).
      if (!this.lightningLightPool) {
        this.lightningLightPool = new THREE.PointLight(0x9fc4e6, 0, 300);
        this.renderer.scene.add(this.lightningLightPool);
      }
      const flash = this.lightningLightPool;
      flash.intensity = 60 + phase * 10;
      flash.distance = Math.max(300, stormR * 0.9);
      flash.position.set(lx, 85 + Math.random() * 50, lz);
      this.lightningFlash = flash;

      // Jagged bolt: cloud base to the sea, brief life synced with the flash.
      if (!this.lightningBolt) {
        const boltGeo = new THREE.BufferGeometry();
        boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
        this.lightningBolt = new THREE.Line(
          boltGeo,
          new THREE.LineBasicMaterial({ color: 0xdceeff, transparent: true, opacity: 0, depthWrite: false }),
        );
        this.lightningBolt.frustumCulled = false;
        this.renderer.scene.add(this.lightningBolt);
      }
      {
        const positions = this.lightningBolt.geometry.getAttribute('position') as THREE.BufferAttribute;
        const topY = 150 + Math.random() * 40;
        let bx = lx;
        let bz = lz;
        for (let i = 0; i < 9; i++) {
          const f = i / 8;
          positions.setXYZ(i, bx, topY * (1 - f), bz);
          bx += (Math.random() - 0.5) * 14;
          bz += (Math.random() - 0.5) * 14;
        }
        positions.needsUpdate = true;
        (this.lightningBolt.material as THREE.LineBasicMaterial).opacity = 0.9;
      }

      // Thunder boom matched to the actual strike distance.
      const localPlayerForThunder = this.getLocalPlayer();
      if (localPlayerForThunder) {
        this.audio.playThunder(this.distance2D(localPlayerForThunder.position.x, localPlayerForThunder.position.z, lx, lz));
      }

      this.stormLightningFlashOpacity = Math.max(
        this.stormLightningFlashOpacity,
        0.18 + this.stormWeatherIntensity * 0.26 + phase * 0.015,
      );

      const baseCooldown = Math.max(
        0.75,
        10.5 - phase * 1.25 - (outsideStorm ? 3.2 : 0) - this.stormWeatherIntensity * 2.5,
      );
      this.lightningTimer = baseCooldown * (0.35 + Math.random() * 0.85);
    }
  }
}
