import * as THREE from 'three';
import { ECONOMY, PHYSICS, PLAYER, SHARK, SHIP, SHIP_STATS, SHIP_UPGRADES, WEAPONS, WILDLIFE } from '../../shared/constants/index.js';
import type {
  BountyRaisedPayload, CargoSpilledPayload, CrewEliminatedPayload, GameState, HotSnapshotPayload, SpoilClaimedPayload, InteractIntent, MatchCountdownPayload, MatchHornPayload, Island, IslandDock, IslandNpc, ItemStack, MatchStartPayload, Player, PlayerInput, Projectile, SeaRock, SharkAttackState, Ship, ShipHole, ShipUpgradeType, TradeSession, TreasureChest, WeaponId, WildlifeAnimal,
} from '../../shared/types/index.js';
import { dist2D, getBridgeDeckY, getIslandSurfaceY, isPointInsideIslandFootprint, angleWrap, gerstnerHeight, WAVE_PARAMS, getStormWaveIntensity, getIslandMaxRadius, getCaveFloorY, getCaveCeilingY, isInsideCaveInterior, getIslandCoastType, getIslandDistRatio, toDockLocalPoint, isInsideSwimHullFootprint, pushOutOfSwimHullFootprint, getSwimHullVerticalBand, getShipQuarterdeckConfig } from '../../shared/utils/index.js';
import { getPropGroundY } from '../../shared/props.js';
import {
  findNearbyCannonIndex,
  findMermaidReturnShip,
  findNearbyGoldHoarder,
  findNearbyKeg,
  findNearbyUpgradeStation,
  getCannonSide,
  getConstrainedCannonAim,
  getRepairPlankCount,
  toShipLocalPoint,
  countOpenHoles,
  findRepairableHole as sharedFindRepairableHole,
} from '../../shared/interactions.js';
import { Renderer, dayNightSecondsForMatchProgress } from '../rendering/Renderer.js';
import { OceanRenderer } from '../rendering/OceanRenderer.js';
import { ShipRenderer } from '../rendering/ShipRenderer.js';
import { SpoilsRenderer } from '../rendering/SpoilsRenderer.js';
import { SeaEventRenderer } from '../world/SeaEventRenderer.js';
import { CombatFx } from '../rendering/CombatFx.js';
import { SoundEngine, type FootstepSurface } from '../audio/SoundEngine.js';
import { NetworkClient } from '../network/NetworkClient.js';
import { MenuController } from '../menu/MenuController.js';
import { InputManager } from '../input/InputManager.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';
import { buildUiRefs, type UiRefs } from '../ui/UiRefs.js';
import { BROKER_NAME, FLEET_PENNANT, SHIP_CLASS_NAMES, WORLD_NAME, WORLD_NAME_MID, shipClassName, weaponDisplayName } from '../ui/DisplayNames.js';
import { IslandBuilder } from '../world/IslandBuilder.js';
import type { ChestMeshRecord, NpcMeshRecord, UpgradeStationMeshRecord } from '../world/IslandBuilder.js';
import { apparentDistanceScale, updateInstanceLod, type InstanceLodBatch } from '../world/island/InstanceLod.js';
import { HudController, type HudView } from '../ui/HudController.js';
import { MapRenderer, type MapView } from '../ui/MapRenderer.js';
import {
  CORPSE_FADE_START, CORPSE_LIFETIME, PlayerAnimator,
  type CorpseState, type DeathCause, type PlayerAnimatorView,
} from '../rendering/PlayerAnimator.js';
import { ViewmodelController, type ViewmodelView } from '../rendering/ViewmodelController.js';
import { InteractionPrompts, type InteractionView } from '../systems/InteractionPrompts.js';
import { EnvironmentFx, type EnvironmentFxView } from '../rendering/EnvironmentFx.js';
import { freezeStaticParent, freezeStaticSubtree, ZERO_SCALE_MAT4 } from '../rendering/three-util.js';
import { IslandDetailWarmer } from '../rendering/IslandDetailWarmup.js';
import { registerBudgetLight } from '../rendering/LightBudget.js';
import { beginFirstDrawFrame, clearFirstDrawBudget, openFirstDrawBudgetForSettle, showWhenAffordable } from '../rendering/FirstDrawBudget.js';
import { budgeted } from '../rendering/FrameBudget.js';
import { ClientState } from './ClientState.js';
import { applyPlayerTeamColor, makePlayerMesh } from '../rendering/factories/PlayerMeshFactory.js';
import { buildMermaidMesh, makeNameplateSprite, makeProjectileMesh } from '../rendering/factories/MiscMeshFactory.js';
import type { PocketPreviewKind } from '../rendering/factories/WeaponMeshFactory.js';

const CLIENT_INPUT_SEND_INTERVAL = 1 / 45;
const CLIENT_INPUT_HEARTBEAT_INTERVAL = 0.2;
/** Seconds of fuse hiss per burst; re-armed until the keg blows (SHIP.KEG_FUSE_TIME
 *  is 10s). Short bursts keep the sound tracking a keg that rides a turning deck,
 *  and stay inside SoundEngine.playKegFuse's per-call duration clamp. */
const KEG_FUSE_HISS_BURST = 2.5;
/** Port the game server listens on by default (src/server/index.ts DEFAULT_PORT).
 *  Kept off 8080: local content filters commonly intercept that port and corrupt
 *  the WebSocket handshake. Only used to hop off a dev server (Vite on :3000). */
const GAME_SERVER_PORT = '8090';
/** Skeleton remains linger (and sink/fade) instead of popping after 1.5s. */
const SKELETON_CORPSE_LIFETIME = 6.5;
/** A dropped weapon tumbles, lands and fades over this many seconds. */
const DROPPED_WEAPON_LIFETIME = 6;

/** What the [X] was reaching for, in the player's own words. */
const INTERACT_INTENT_NOUN: Record<string, string> = {
  barrel: 'that barrel', chest: 'that chest', board: 'the ladder', dock: 'the dock',
  mermaid: 'the mermaid', keg_diffuse: 'that keg', upgrade: 'the shipwright',
  gold_hoarder: `the ${BROKER_NAME}`, stow_chest: 'the hold', helm: 'the wheel',
  sails: 'the halyard', brace: 'the brace', crow: 'the mast ladder', anchor: 'the capstan',
  repair: 'that breach', bail: 'the bilge', revive: 'your crewmate', cannon: 'that cannon',
  ammo: 'the ammo chest',
};

/** 'the Black Fin' read attributively — "a Black Fin pennant". Derived, never
 *  spelled out, so the display layer stays the one place the crew is named. */
const FLEET_PENNANT_ADJ = FLEET_PENNANT.replace(/^the\s+/i, '');

/**
 * THE FIFTEEN SCENES — the authored story vignettes of the Reach.
 *
 * Every hero scene in docs/ISLAND_STORY_BIBLE.md is a mute prop until you walk
 * into it. Stepping inside a scene's footprint announces it ONCE per match on
 * the island banner: the scene's name, and the one line that says what happened
 * here. This is the whole story delivery — no reading required, just landfall.
 *
 * `radius` is how far out the scene "reads" as the thing you have walked into
 * (roughly its footprint plus an approach), in metres.
 */
const STORY_VIGNETTES: Partial<Record<string, { title: string; beat: string; radius: number }>> = {
  smuggler_cache: {
    title: "The Smuggler's Cache",
    beat: 'The tavern is the front. This is the business.',
    radius: 14,
  },
  skull_totem: {
    title: 'The Warning Stone',
    beat: 'They cut it facing the water, so you would read it before you landed.',
    radius: 15,
  },
  wrecker_tower: {
    title: "The Wrecker's Tower",
    beat: 'The light was never meant to save you.',
    radius: 16,
  },
  whale_skeleton: {
    title: "The Leviathan's Rest",
    beat: 'Even leviathans wash up here. You will not do better.',
    radius: 18,
  },
  gibbet_cage: {
    title: 'The Gibbet',
    beat: `${FLEET_PENNANT.charAt(0).toUpperCase()}${FLEET_PENNANT.slice(1)} leave their rag on the frame, so you know who to thank.`,
    radius: 12,
  },
  rum_still: {
    title: "The Runner's Still",
    beat: 'Business is booming. The quality is a rumour.',
    radius: 14,
  },
  crow_roost: {
    title: 'The Unlit Pyre',
    beat: 'The watch had one job. The crows had another.',
    radius: 16,
  },
  mermaid_shrine: {
    title: "The Siren's Toll",
    beat: 'The offerings are not thanks. She is owed.',
    radius: 15,
  },
  castaway_camp: {
    title: 'The Last Camp',
    beat: 'He counted every day. The raft is still three planks short.',
    radius: 16,
  },
  kraken_wreck: {
    title: 'What the Kraken Left',
    beat: 'It did not sink her. It held her until she stopped moving.',
    radius: 19,
  },
  dig_site: {
    title: 'The Empty Chest',
    beat: `A ${FLEET_PENNANT_ADJ} pennant marks the dig. The crew that opened it didn't all leave.`,
    radius: 17,
  },
  gallows: {
    title: 'The Gallows',
    beat: 'The tide brings everyone to justice eventually.',
    radius: 15,
  },
  parley_table: {
    title: 'The Parley Table',
    beat: 'Leave your steel at the barrel. Nobody has died here. Yet.',
    radius: 15,
  },
  mine_head: {
    title: 'The Obsidian Cut',
    beat: 'They dug black glass out of a living mountain. The mountain kept it.',
    radius: 16,
  },
  widow_memorial: {
    title: "The Widow's Lantern",
    beat: 'She lit it every night for a ship that never came. It still burns.',
    radius: 16,
  },
};

/**
 * The TEACHING half of an NPC.
 *
 * An island's speaker opens with that island's LORE (authored server-side, one
 * voice per island). The tutorial tips they used to recite instead now rotate
 * in on later visits, keyed by role — so the game still teaches storms, repair,
 * charts and trade without fourteen strangers reading the same three cards.
 */
const NPC_ROLE_TIPS: Record<IslandNpc['role'], readonly string[]> = {
  mysterious_stranger: [
    'The storm is closing on the Reach. Read the clouds, keep your bow inside the blue, and never trust a quiet horizon.',
    'When the ring tightens, sail early. Every pirate drowned by weather died arguing about the wind.',
  ],
  shipwright: [
    'A sound hull wins more fights than a loud cannon. Take planks from barrels, patch the low breaches first, then raise sail.',
    'Water finds the lowest hole. Bail while a mate patches, and never leave the helm to a rising bilge.',
  ],
  oracle: [
    'X marks are never alone. Docks, forges and camps leave scratches on every honest chart.',
    'Open the chart when land is near — the Reach draws its own detail as you close on it.',
  ],
  gold_hoarder: [
    'Sealed chests, carried in hand. I pay gold, and my charts point at the next mark.',
    "Gold buys upgrades at the island stations. Coin in a dead man's pocket buys nothing at all.",
  ],
  bartender: [
    'Rest here, restock here. Fruit heals, planks mend, and rumours come free with the second mug.',
    'Every tale told in this room started on another island. Go and collect one.',
  ],
};

/** One short amber line for a press the server heard and refused. */
function interactRefusalLine(intent?: string, reason?: string): string {
  const noun = INTERACT_INTENT_NOUN[intent ?? ''] ?? 'that';
  switch (reason) {
    case 'out_of_reach': return `Too far from ${noun}.`;
    case 'not_aboard': return `Get aboard first — ${noun} is out of reach.`;
    case 'occupied': return `A crewmate already has ${noun}.`;
    case 'materials': return 'Not enough wood and ore for that claim.';
    case 'no_plank': return 'No plank in hand — find wood to patch her.';
    case 'nothing_there': return `Nothing to do at ${noun}.`;
    case 'no_ladder': return 'No rungs in reach — swim closer to the hull.';
    case 'sinking': return "She's going down — that station is closed.";
    default: return `Can't do that with ${noun} right now.`;
  }
}

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
  /** performance.now() at which the fuse hiss needs re-arming (see syncKegs). */
  nextFuseHissAt: number;
};

export type StoryCutsceneRefs = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  name: HTMLDivElement;
  line: HTMLDivElement;
  cue: HTMLDivElement;
};

export type WindWispRecord = {
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
export type LanternEmitter = {
  anchor: THREE.Object3D;
  kind: 'lantern' | 'campfire';
  glow: THREE.Sprite;
  flame: THREE.Sprite | null;
  worldPos: THREE.Vector3;
  dist: number;
  phase: number;
};

/** Interaction kinds the HUD arbiter juggles: server intents plus CLIENT-ONLY
 *  kinds that never ride interactIntent — 'door' (tavern doors swing locally)
 *  and 'harvest' (the axe prompt; LMB does the work via useItem). */
export type ClientInteractKind = InteractIntent | 'door' | 'harvest';

/** A story light that has to carry across open water (the widow's lantern).
 *  Core = the flame itself, halo = the bloom a lamp throws into night air. */
type StoryBeacon = {
  core: THREE.Sprite;
  halo: THREE.Sprite;
  worldPos: THREE.Vector3;
};

export class Game {
  /** Server world snapshot + id indexes (see core/ClientState.ts). Declared
   *  first so every accessor below can delegate to it. */
  private readonly clientState = new ClientState();

  private get state() { return this.clientState.state; }
  private set state(v: GameState | null) { this.clientState.state = v; }
  private get playersById() { return this.clientState.playersById; }
  private get shipsById() { return this.clientState.shipsById; }
  private get livePlayerIds() { return this.clientState.livePlayerIds; }
  private get liveProjectileIds() { return this.clientState.liveProjectileIds; }
  private get liveKegIds() { return this.clientState.liveKegIds; }
  private get serverTimeOffset() { return this.clientState.serverTimeOffset; }
  private set serverTimeOffset(v: number | null) { this.clientState.serverTimeOffset = v; }
  private get lastSnapshotAt() { return this.clientState.lastSnapshotAt; }
  private set lastSnapshotAt(v: number) { this.clientState.lastSnapshotAt = v; }

  private applyHotSnapshot(hot: HotSnapshotPayload) { this.clientState.applyHotSnapshot(hot); }

  private rebuildStateIndexes(state: GameState) { this.clientState.rebuildStateIndexes(state); }

  private readonly renderer = new Renderer();
  /** Pays an island's detail-LOD reveal early and in slices — see the module
   *  header for the burst it exists to flatten. Exposed on the debug handle so
   *  the perf probes can assert on warm/reveal state. */
  readonly lodWarmer = new IslandDetailWarmer(() => ({
    renderer: this.renderer.renderer,
    scene: this.renderer.scene,
    camera: this.renderer.camera,
  }));
  private readonly ocean = new OceanRenderer();
  /** Dev/tour hook: when non-null, forces the day/night clock to this many
   *  seconds (see setDayNightOverride), so a visual tour can capture noon,
   *  dusk and night deterministically. Inert during normal play. */
  private dayNightOverrideSec: number | null = null;
  private readonly shipRenderer = new ShipRenderer();
  /** Sunken cargo spilled by foundered crews — the dive-site half of the
   *  gold race (see shared/cargo.ts, Match.spillCargoOnFounder). */
  private readonly spoilsRenderer = new SpoilsRenderer();
  /** The Gilded Wreck (mid-match convergence event) and the four uncharted sea
   *  micro-POIs — see world/SeaEventRenderer.ts. */
  private readonly seaEvents = new SeaEventRenderer();
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
  /** Scratch for the group-level island cull — allocated once, never in a frame. */
  private readonly cullFrustum = new THREE.Frustum();
  private readonly shadowCullFrustum = new THREE.Frustum();
  private readonly cullMatrix = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();
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
    onCrewFound: () => this.beginCrewFoundBeat(),
    // Read through a thunk, not passed by value: the panel's graphics line is
    // live, and the governor moves while it is open.
    getGovernorStatus: () => (this.renderer ? this.renderer.getGovernorStatus() : null),
  });
  // Used by ambient render & end-of-round flow + gameplay-key gating.
  private inMatch = false;
  private readonly ui: UiRefs = buildUiRefs();

  private localPlayerId: string | null = null;
  private localShipId: string | null = null;
  /** Cleared when the server sends `join`; avoids an endless 68% bar if assignment stalls. */
  private joinAssignmentWatchdog: number | null = null;
  private lastFrameTime = performance.now();
  private frameDt = 1 / 60;
  /** Shared emissive-glow flicker for volcanic magma veins + caldera lava,
   *  driven per-frame in updateVolcanicFx and read by the terrain shader. */
  private readonly magmaPulseUniform = { value: 1 };
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
  private stormWeatherIntensity = 0;
  /** What the WEATHER LOOKS LIKE, as opposed to how hard it is blowing.
   *  stormWeatherIntensity stays the storm's own level and keeps driving wind,
   *  wave bed and hull spray; this is the number the sea colour, the fog, the
   *  scene lights and the sky all read, and it also answers to rain the client
   *  is drawing. See where it is derived, over the setOvercast call. */
  private stormVisualIntensity = 0;
  private storyCutscene: StoryCutsceneRefs | null = null;
  private storyCutsceneNpcId: string | null = null;
  private storyCutsceneHideAt = 0;
  private spyglassActive = false;
  // 'door' is a CLIENT-ONLY interaction kind (tavern doors are cosmetic and
  // collision-less) — it must never be sent as a server interactIntent.
  private lastInteractKind: ClientInteractKind | null = null;
  private visibleInteractKind: ClientInteractKind | null = null;
  private pendingInteractFromUi = false;
  private pendingLaunchFromUi = false;
  private readonly stormRingPositions = new Float32Array(96 * 3);
  private readonly tempProjectilePos = new THREE.Vector3();
  private readonly tempKegPos = new THREE.Vector3();
  private readonly tempSharkPos = new THREE.Vector3();
  private readonly tempWildlifePos = new THREE.Vector3();
  private readonly tempHudVector = new THREE.Vector3();
  private readonly tempRenderPos = new THREE.Vector3();
  private readonly tempBallisticPos = new THREE.Vector3();
  private pocketUsePreviewKind: PocketPreviewKind | null = null;
  private pocketUsePreviewTimer = 0;
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
  /** bucketFilled edge-detector per player — bail FX fire on the transitions. */
  private readonly prevBucketFilled = new Map<string, boolean>();
  // ── Death presentation ────────────────────────────────────────────────────
  /** Per-player health/state/fall history driving flinches and death causes. */
  private readonly prevPlayerHealth = new Map<string, number>();
  private readonly prevPlayerStateById = new Map<string, Player['state']>();
  private readonly prevPlayerFallSpeed = new Map<string, number>();
  /** kill_event details, consumed by the next death edge for that victim. */
  private readonly deathCauseHints = new Map<string, { killerId: string | null; headshot: boolean }>();
  /** performance.now() of the last feed line for each environmental cause. */
  private readonly envFeedAt = new Map<string, number>();
  /** Weapons flung out of dead hands, tumbling until they fade. */
  private readonly droppedWeapons: Array<{
    mesh: THREE.Group;
    velocity: THREE.Vector3;
    spin: THREE.Vector3;
    age: number;
    restY: number;
  }> = [];
  /** Where the local pirate died — the death camera stays there, not with the
   *  respawn-teleported server position. */
  private localDeathAnchor: { pos: THREE.Vector3; cause: DeathCause; tilt: number } | null = null;
  /** 0→1 ease into the death camera (drop to the ground + roll + desaturate). */
  private localDeathBlend = 0;
  /** Greyed-out vignette overlay owned by the death camera (built lazily). */
  private deathOverlay: HTMLDivElement | null = null;
  // ── Spectate rig: where the camera goes once you are OUT of the match ──────
  // The death camera parks the eye 34cm above the spot you fell. On a deck that
  // is a corpse's-eye view; in the water it is underneath the swell, which is
  // why every observed elimination was a black screen. These lift it clear.
  /** 0→1 blend from the corpse's eye into the raised spectate framing. */
  private spectateLift = 0;
  /** Slow drift added to the spectate yaw so the held frame is not dead still. */
  private spectateOrbit = 0;
  /** Fill light that only exists while spectating — a night elimination is
   *  otherwise unlit and unreadable however high the camera climbs. */
  private spectateLight: THREE.HemisphereLight | null = null;
  private static readonly SPECTATE_RISE_SECONDS = 2.4;
  /** Metres back from the body, up from it, and above whatever is underneath. */
  private static readonly SPECTATE_RADIUS = 9.5;
  private static readonly SPECTATE_HEIGHT = 7.2;
  private static readonly SPECTATE_CLEARANCE = 4.2;
  // ── After the lift: SOMETHING TO WATCH ─────────────────────────────────────
  // Climbing out of the water fixed the black screen, but what it revealed was
  // usually open sea — you died where nothing is, so the raised frame held a
  // corpse and a horizon for the rest of the round. Once the lift is done the
  // rig hands off to a LIVING crew: it flies to whoever is still fighting
  // nearest to you and orbits them, and the HUD says whose deck you are over
  // and where you finished. If the fleet is somehow empty it falls back to the
  // storm ring, which is the other thing still moving.
  /** 0→1 blend from orbiting your own body to orbiting the watched crew. */
  private spectateHandoff = 0;
  private static readonly SPECTATE_HANDOFF_SECONDS = 2.8;
  /** Orbit framing once handed off — a hull needs more room than a corpse. */
  private static readonly SPECTATE_SUBJECT_RADIUS = 31;
  private static readonly SPECTATE_SUBJECT_HEIGHT = 17;
  /** Who the spectate camera is watching, re-picked only when it has to be. */
  private spectateSubjectId: string | null = null;
  private spectateSubjectLabel = '';
  private readonly spectateSubjectPos = new THREE.Vector3();
  private spectateRepickAt = 0;
  /** Frozen the instant you are eliminated: crews still afloat + 1 is your place. */
  private spectatePlacement: { place: number; of: number } | null = null;
  private prevCutlassSwingProgress = 0;
  /** 0..1 FOV punch on the cutlass dash, decays fast (rush feel). */
  private cutlassDashKick = 0;
  // ── Anime slash trails: pooled, zero per-swing allocations ──
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
  private readonly seenStoryNpcIds = new Set<string>();
  /** Story scenes already announced this match, keyed `islandId:propType`. */
  private readonly seenVignettes = new Set<string>();
  /** How many times each NPC has spoken: 0 ⇒ lore, then the role's tips. */
  private readonly npcTalkCount = new Map<string, number>();
  /** NPCs the pirate is currently standing with — leaving re-arms their next line. */
  private readonly npcInRange = new Set<string>();
  /** Long-range beacons for story lights that must READ from open water. */
  private readonly storyBeacons: StoryBeacon[] = [];
  private storyBeaconsBuiltFor = '';

  private readonly environment = new THREE.Group();
  /** Island terrain / prop / sea-rock mesh construction (see world/IslandBuilder.ts). */
  private readonly islands = new IslandBuilder({
    renderer: this.renderer,
    islandPropInstances: this.islandPropInstances,
    foliageWind: this.foliageWind,
    foliageTime: this.foliageTime,
    registerLanternEmitter: (container, x, y, z, kind) => this.envFx.registerLanternEmitter(container, x, y, z, kind),
    environment: this.environment,
    islandMeshes: this.islandMeshes,
    chestMeshes: this.chestMeshes,
    barrelMeshes: this.barrelMeshes,
    upgradeStationMeshes: this.upgradeStationMeshes,
    npcMeshes: this.npcMeshes,
    magmaPulseUniform: this.magmaPulseUniform,
    pushVolcanicFx: (fx) => { this.envFx.volcanicFx.push(fx); },
    registerWaterfalls: (islandId, sites) => { this.envFx.registerWaterfalls(islandId, sites); },
    setTavernDoor: (islandId, node) => {
      this.tavernDoors = this.tavernDoors.filter((entry) => entry.islandId !== islandId);
      this.tavernDoors.push({ islandId, node, open: false });
    },
    getSoftParticleTexture: () => this.getSoftParticleTexture(),
    getUpgradePresentation: (type) => this.getUpgradePresentation(type),
  });

  /** Lanterns, volcanic FX, wind wisps, storm rain/lightning, harvest breakdown
   *  (see rendering/EnvironmentFx.ts). */
  private readonly envFx = new EnvironmentFx(this.createEnvironmentFxView());

  private createEnvironmentFxView(): EnvironmentFxView {
    const self = this;
    return {
      audio: this.audio,
      combatFx: this.combatFx,
      input: this.input,
      ocean: this.ocean,
      renderer: this.renderer,
      islandMeshes: this.islandMeshes,
      islandPropInstances: this.islandPropInstances,
      magmaPulseUniform: this.magmaPulseUniform,
      playersById: this.playersById,
      get state() { return self.state; },
      get stormWeatherIntensity() { return self.stormWeatherIntensity; },
      get stormVisualIntensity() { return self.stormVisualIntensity; },
      get storyCutscene() { return self.storyCutscene; },
      set storyCutscene(v) { self.storyCutscene = v; },
      buildPropInstance: (type, position, yaw, scale) => this.buildPropInstance(type, position, yaw, scale),
      disposeSceneObject: (root) => this.disposeSceneObject(root),
      getLocalPlayer: () => this.getLocalPlayer(),
      getTrackedShip: () => this.getTrackedShip(),
    };
  }

  /** Look-at prompt arbiter (see systems/InteractionPrompts.ts). */
  private readonly interactions = new InteractionPrompts(this.createInteractionView());

  private createInteractionView(): InteractionView {
    const self = this;
    return {
      ui: this.ui,
      get state() { return self.state; },
      get barrelBrowse() { return self.barrelBrowse; },
      get tavernDoors() { return self.tavernDoors; },
      get visibleInteractKind() { return self.visibleInteractKind; },
      get lastInteractKind() { return self.lastInteractKind; },
      set lastInteractKind(v) { self.lastInteractKind = v; },
      get mermaidAnchor() { return self.mermaidAnchor; },
      set mermaidAnchor(v) { self.mermaidAnchor = v; },
      get pendingInteractFromUi() { return self.pendingInteractFromUi; },
      set pendingInteractFromUi(v) { self.pendingInteractFromUi = v; },
      get pendingLaunchFromUi() { return self.pendingLaunchFromUi; },
      set pendingLaunchFromUi(v) { self.pendingLaunchFromUi = v; },
      createMermaidAnchor: (player, ship) => this.createMermaidAnchor(player, ship),
      findChestById: (chestId) => this.findChestById(chestId),
      findHarvestTarget: (player) => this.envFx.findHarvestTarget(player),
      findNearbyKeg: (player, ship) => (this.state ? findNearbyKeg(this.state.kegs, player, ship ?? null) : null),
      findRepairableHole: (player, ship) => this.findRepairableHole(player, ship),
      getBarrelWorldPoint: (barrelId) => this.getBarrelWorldPoint(barrelId),
      getChestWorldPoint: (chestId) => this.getChestWorldPoint(chestId),
      getInventoryQty: (ship, item) => this.getInventoryQty(ship, item),
      getLocalPlayer: () => this.getLocalPlayer(),
      getLookDirection: (player) => this.getLookDirection(player),
      getMermaidReturnShip: (player) => (this.state ? findMermaidReturnShip(this.state.ships, player) : null),
      getNearbyGoldHoarder: (player) => (this.state ? findNearbyGoldHoarder(this.state.islands, player) : null),
      getNearbyUpgradeStation: (player) => (this.state ? findNearbyUpgradeStation(this.state.islands, player) : null),
      getRepairPlankCount: (player, ship) => getRepairPlankCount(player, ship),
      getHoleRepairWorldPoint: (ship, hole) => this.getHoleRepairWorldPoint(ship, hole),
      getShipWorldPoint: (ship, localX, localZ, worldY) => this.getShipWorldPoint(ship, localX, localZ, worldY),
      getTavernDoorWorldPoint: (door, out) => this.getTavernDoorWorldPoint(door, out),
      getTrackedShip: () => this.getTrackedShip(),
      getUpgradePresentation: (type) => this.getUpgradePresentation(type),
    };
  }

  /** First-person viewmodel (see rendering/ViewmodelController.ts). */
  private readonly viewmodel = new ViewmodelController(this.createViewmodelView());

  private createViewmodelView(): ViewmodelView {
    const self = this;
    return {
      combatFx: this.combatFx,
      input: this.input,
      ocean: this.ocean,
      renderer: this.renderer,
      get map() { return self.map; },
      shipsById: this.shipsById,
      get cutlassSwingKind() { return self.cutlassSwingKind; },
      get frameDt() { return self.frameDt; },
      get lanternRaise01() { return self.lanternRaise01; },
      get lastInteractKind() { return self.lastInteractKind; },
      get localPlayerId() { return self.localPlayerId; },
      get spyglassActive() { return self.spyglassActive; },
      get visibleInteractKind() { return self.visibleInteractKind; },
      get cameraShake() { return self.cameraShake; },
      set cameraShake(v) { self.cameraShake = v; },
      get cutlassDashKick() { return self.cutlassDashKick; },
      set cutlassDashKick(v) { self.cutlassDashKick = v; },
      get pocketUsePreviewKind() { return self.pocketUsePreviewKind; },
      set pocketUsePreviewKind(v) { self.pocketUsePreviewKind = v; },
      get pocketUsePreviewTimer() { return self.pocketUsePreviewTimer; },
      set pocketUsePreviewTimer(v) { self.pocketUsePreviewTimer = v; },
      get prevCutlassSwingProgress() { return self.prevCutlassSwingProgress; },
      set prevCutlassSwingProgress(v) { self.prevCutlassSwingProgress = v; },
      findChestById: (chestId) => this.findChestById(chestId),
      getCutlassSwingProgress: (player) => this.getCutlassSwingProgress(player),
      getLocalPlayer: () => this.getLocalPlayer(),
      getPocketWheelCount: (player, slot) => this.getPocketWheelCount(player, slot),
      getPocketWheelKind: (player, slot) => this.getPocketWheelKind(player, slot),
    };
  }

  /** Exposed for scripts/pose-pin-probe.mjs, which flips the slash diagonal. */
  get cutlassSlashSide() { return this.viewmodel.cutlassSlashSide; }
  set cutlassSlashSide(v: 1 | -1) { this.viewmodel.cutlassSlashSide = v; }

  /** Third-person avatar animation (see rendering/PlayerAnimator.ts). */
  private readonly anim = new PlayerAnimator(this.createPlayerAnimatorView());

  private createPlayerAnimatorView(): PlayerAnimatorView {
    const self = this;
    return {
      input: this.input,
      ocean: this.ocean,
      get localPlayerId() { return self.localPlayerId; },
      tempSlashPos: this.tempSlashPos,
      spawnRemoteSlashArc: (worldPos) => this.viewmodel.spawnRemoteSlashArc(worldPos),
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

  /** Minimap / fullscreen chart / treasure chart drawing (see ui/MapRenderer.ts). */
  private readonly map = new MapRenderer(this.createMapView());

  private createMapView(): MapView {
    const self = this;
    return {
      ui: this.ui,
      input: this.input,
      renderer: this.renderer,
      get state() { return self.state; },
      get ownShipBeaconActive() { return self.ownShipObjectiveActive; },
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
      get startCeremonyActive() { return self.isStartCeremonyActive(); },
      get ownShipObjectiveActive() { return self.ownShipObjectiveActive; },
      get visibleInteractKind() { return self.visibleInteractKind; },
      set visibleInteractKind(v) { self.visibleInteractKind = v; },
      findNearbyCannonIndex: (player, ship) => findNearbyCannonIndex(player, ship),
      findRepairableHole: (player, ship) => this.findRepairableHole(player, ship),
      flashIslandBanner: (name) => this.flashIslandBanner(name),
      formatCompassHeading: (angle) => this.formatCompassHeading(angle),
      formatStormTimer: (seconds) => this.formatStormTimer(seconds),
      getBlunderbussCrosshairSize: (player) => this.getBlunderbussCrosshairSize(player),
      getClosestGoldHoarder: (player) => this.getClosestGoldHoarder(player),
      getInventoryQty: (ship, item) => this.getInventoryQty(ship, item),
      getLocalPlayer: () => this.getLocalPlayer(),
      getLookInteraction: (player, ship, cannon, hole) => this.interactions.getLookInteraction(player, ship, cannon, hole),
      getPocketWheelCount: (player, slot) => this.getPocketWheelCount(player, slot),
      getStormTimerSeconds: () => this.getStormTimerSeconds(),
      getTrackedShip: () => this.getTrackedShip(),
      getSpectateSummary: () => this.getSpectateSummary(),
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

  private readonly mermaidGroup = buildMermaidMesh();
  private mermaidAnchor: { x: number; z: number; shipId: string } | null = null;
  private readonly stormRing = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x587ca5, transparent: true, opacity: 0.58 }),
  );
  // (The old fogged MeshBasicMaterial storm-wall cylinder lived here. EnvironmentFx
  // owns the weather at the ring now, and the legacy wall was laying a faint pale
  // veil across everything at range from under it.)
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

    this.envFx.setupStormWeatherOverlay();
    this.setupStoryCutsceneOverlay();
    this.interactions.bindInteractPromptClick();
    this.viewmodel.localViewWeaponRoot.visible = false;
    this.viewmodel.localViewWeaponRoot.renderOrder = 999;
    this.renderer.camera.add(this.viewmodel.localViewWeaponRoot);
    this.viewmodel.setupMuzzleFlash();
    this.viewmodel.localViewHandsRoot.visible = false;
    this.renderer.camera.add(this.viewmodel.localViewHandsRoot);
    this.viewmodel.localViewPocketRoot.visible = false;
    this.viewmodel.localViewPocketRoot.renderOrder = 999;
    this.renderer.camera.add(this.viewmodel.localViewPocketRoot);
    // Held-lamp light rides with the view (off until the lantern is equipped),
    // offset to the held hand so it washes the world around the player.
    this.heldLampLight.position.set(0.35, -0.1, -0.5);
    registerBudgetLight(this.heldLampLight);
    this.renderer.camera.add(this.heldLampLight);
    this.ocean.init(this.renderer.scene, this.renderer.getQuality());
    this.setLoading(56, 'Stirring the deep...');
    await this.yieldForLoadingPaint();

    this.shipRenderer.init(this.renderer.scene, this.renderer.getQuality());
    this.spoilsRenderer.init(this.renderer.scene);
    this.seaEvents.init(this.renderer.scene, {
      ensureLootMeshes: (islandId, chestIds, barrelIds) =>
        this.buildLateLootMeshes(islandId, chestIds, barrelIds),
    });
    this.setLoading(62, `Rigging the ${SHIP_CLASS_NAMES.brigantine}...`);
    await this.yieldForLoadingPaint();

    this.combatFx.init(this.renderer.scene);
    this.envFx.initLanternSystem();
    this.renderer.scene.add(this.environment);
    // Static container: islands, sea rocks, chests and wildlife all live under
    // it and it never moves itself. Holding still here is what lets the frozen
    // island subtrees actually be skipped (a dirty ancestor forces the walk).
    freezeStaticParent(this.environment);
    this.renderer.scene.add(this.envFx.windWisps);
    this.renderer.scene.add(this.mermaidGroup);
    this.mermaidGroup.visible = false;
    this.renderer.scene.add(this.stormRing);
    this.renderer.scene.add(this.stormHalo);
    this.envFx.initWindWisps();
    this.stormRing.geometry.setAttribute('position', new THREE.BufferAttribute(this.stormRingPositions, 3));
    this.stormRing.position.y = 0.55;
    this.stormRing.frustumCulled = false;
    this.stormHalo.rotation.x = Math.PI * 0.5;
    this.stormHalo.renderOrder = 2;
    this.stormHalo.frustumCulled = false;
    this.setLoading(68, 'Reading the weather glass...');
    await this.yieldForLoadingPaint();

    this.input.init(this.renderer.renderer.domElement);
    this.bindSupplyWheelActions();
    // Scroll to zoom the opened map, anchored on the cursor — point at a distant
    // island and scroll and it comes to you. Bound on window so it catches
    // regardless of the overlay's pointer-events.
    window.addEventListener('wheel', (e) => {
      if (!this.map.mapOpen) return;
      e.preventDefault();
      this.map.zoomAtClient(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
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
        `Cannot reach game server at ${socketUrl}. Make sure 'npm run dev' is running (server on :${GAME_SERVER_PORT}), then refresh.`,
      );
      return false;
    }
    return true;
  }

  private onMatchStartFromMenu(payload?: MatchStartPayload): void {
    // The CREW FOUND beat fires from the QUEUE, before this teardown runs — so
    // carry it across resetLocalRoundState and repaint the card, or the found
    // hold would blink out the instant the menu came down.
    const crewFound = this.startSeqPhase === 'found';
    const foundAt = this.crewFoundAtMs;
    this.resetLocalRoundState();
    if (crewFound) {
      this.crewFoundAtMs = foundAt;
      this.renderCrewFoundCard();
    }
    this.inMatch = true;
    this.menu.setLastMatchPartyCode(payload?.partyCode ?? null);
    this.scheduleJoinAssignmentWatchdog();
    this.bindReturnToMenuButtons();
    // No fanfare here: the horn now blows at the horn (match_horn), not during
    // the sub-second load where nobody was there to hear it.
    this.audio.unlock();
    // Menu air off, world score on: at sea nothing plays continuously — only
    // the tavern jig and the odd whistled phrase surface.
    this.audio.setMusicContext('world');
  }

  // ── Staged match start ────────────────────────────────────────────────
  /** 'idle' before/after the ceremony; the rest track the found→count→horn arc. */
  private startSeqPhase: 'idle' | 'found' | 'countdown' | 'horn' = 'idle';
  private startSeqHideTimer: number | null = null;
  private startSeqLastCount = -1;
  /** performance.now() of the CREW FOUND beat, 0 when the arc began at a countdown. */
  private crewFoundAtMs = 0;
  /** How long CREW FOUND holds the screen before the count takes over. */
  private static readonly CREW_FOUND_HOLD_MS = 1500;
  /** performance.now() the horn is due, per the last server tick. 0 = not armed. */
  private startSeqDeadlineMs = 0;
  private startSeqCrews = 0;

  /** True while the start ceremony owns the screen centre — the island
   *  discovery banner and its fanfare stand down until it clears. */
  private isStartCeremonyActive(): boolean {
    return this.startSeqPhase !== 'idle';
  }

  private showStartSequence(): void {
    if (this.startSeqHideTimer !== null) {
      window.clearTimeout(this.startSeqHideTimer);
      this.startSeqHideTimer = null;
    }
    this.ui.matchStartSeq.classList.add('visible');
    // Dims the live HUD and pulls the crosshair / pointer-lock hint off the
    // screen centre, which is exactly where the count is drawn.
    document.body.classList.add('match-ceremony');
  }

  private hideStartSequence(): void {
    this.ui.matchStartSeq.classList.remove('visible');
    document.body.classList.remove('match-ceremony');
  }

  /** Paint (or repaint) the CREW FOUND card — no state change, no sound. */
  private renderCrewFoundCard(): void {
    this.startSeqPhase = 'found';
    this.startSeqLastCount = -1;
    this.ui.matchStartSeq.classList.remove('horn');
    this.ui.matchStartCrews.textContent = '—';
    this.ui.matchStartIsland.textContent = 'Crew Found';
    this.ui.matchStartCount.textContent = '';
    this.ui.matchStartCount.classList.remove('tick');
    this.ui.matchStartHint.textContent = `Boarding your ship — ${FLEET_PENNANT} at the masthead`;
    this.showStartSequence();
  }

  /** Queue popped: 'CREW FOUND' hold + sting, so joining reads found → countdown → horn. */
  private beginCrewFoundBeat(): void {
    this.audio.unlock();
    this.crewFoundAtMs = performance.now();
    this.renderCrewFoundCard();
    // Weighing anchor: iron running in through the hawse. The big fanfare is
    // saved for the horn — spending it here would make the horn the anticlimax.
    this.audio.playAnchorChange(false);
  }

  /**
   * One whole second of the server's staged start. This only ARMS/resyncs the
   * local deadline — the digits themselves are painted per frame by
   * {@link updateStartSequenceFrame}. The client is still streaming the world in
   * during these 8 seconds, so the ticks land in bursts (measured: 8, then a
   * 3.3 s gap, then three inside 700 ms) and painting straight off the message
   * made the count visibly skip 7 and 5.
   */
  private onMatchCountdownTick(payload: MatchCountdownPayload): void {
    const seconds = Math.max(0, Math.round(payload.secondsRemaining));
    if (seconds <= 0) return;
    this.startSeqCrews = payload.crews;
    const deadline = performance.now() + seconds * 1000;
    // Arm from the first tick, then only ever pull the deadline EARLIER. Island
    // streaming blocks the main thread for whole seconds during these 8, so
    // ticks are processed in late bursts: a two-way resync walked the count
    // backwards (measured: "1" then "2"), and a per-message rearm collapsed the
    // whole count into a blur. Monotonic + the authoritative horn message ending
    // it means the digits only ever fall.
    this.startSeqDeadlineMs = this.startSeqDeadlineMs === 0
      ? deadline
      : Math.min(this.startSeqDeadlineMs, deadline);
    this.showStartSequence();
  }

  /**
   * Per-frame face of the staged start: holds the CREW FOUND card for its beat,
   * then counts down off the local deadline — one number per real second, in
   * order, whatever the network and the world build are doing.
   */
  /** Last world-build backlog painted onto the countdown hint (-1 = unpainted). */
  private startSeqLastBacklog = -1;

  private updateStartSequenceFrame(): void {
    if (this.startSeqDeadlineMs === 0 || this.startSeqPhase === 'horn') return;
    const now = performance.now();
    if (this.startSeqPhase === 'found' && now - this.crewFoundAtMs < Game.CREW_FOUND_HOLD_MS) return;
    if (this.startSeqPhase !== 'countdown') {
      this.startSeqPhase = 'countdown';
      this.startSeqLastCount = -1;
      this.ui.matchStartSeq.classList.remove('horn');
      this.ui.matchStartIsland.textContent = '';
      this.startSeqLastBacklog = -1;
      this.showStartSequence();
    }
    this.ui.matchStartCrews.textContent = String(this.startSeqCrews);
    // Say what the wait is FOR while the world streams in. The islands build
    // one per frame and each one holds until its shaders link, so on a slow
    // machine this line is the difference between "loading" and "frozen".
    const backlog = this.getWorldBuildBacklog();
    if (backlog !== this.startSeqLastBacklog) {
      this.startSeqLastBacklog = backlog;
      this.ui.matchStartHint.textContent = backlog > 0
        ? `Charting the isles… ${backlog} to go`
        : `Helm locked — the horn looses you on ${WORLD_NAME_MID}`;
    }
    const player = this.getLocalPlayer();
    const island = player ? this.getNearestIsland(player.position.x, player.position.z) : null;
    // Only overwrite once the spawn island is known — a blank card beats a
    // flickering one while the join snapshot is still in flight.
    if (island) this.ui.matchStartIsland.textContent = island.name;
    // Never below 1: if the horn is a beat late, the count holds at 1 rather
    // than flashing a 0 nobody counts to.
    const seconds = Math.max(1, Math.ceil((this.startSeqDeadlineMs - now) / 1000));
    if (seconds !== this.startSeqLastCount) {
      this.startSeqLastCount = seconds;
      this.ui.matchStartCount.textContent = String(seconds);
      // Restart the pop animation on every tick (reflow forces a replay).
      this.ui.matchStartCount.classList.remove('tick');
      void this.ui.matchStartCount.offsetWidth;
      this.ui.matchStartCount.classList.add('tick');
      // Dry chrome tick for the long count; the last three escalate to the
      // rising beacon pip so the final seconds feel like the last seconds.
      if (seconds <= 3) this.audio.playCountdownPip();
      else this.audio.playUiClick();
    }
  }

  /** The sim just went live. */
  private onMatchHornBlown(payload: MatchHornPayload): void {
    this.startSeqPhase = 'horn';
    this.startSeqLastCount = -1;
    this.crewFoundAtMs = 0;
    this.startSeqDeadlineMs = 0;
    this.ui.matchStartCrews.textContent = String(payload.crews);
    this.ui.matchStartHint.textContent = '';
    this.ui.matchStartSeq.classList.add('horn');
    this.showStartSequence();
    // Release: the HUD comes back UP with the horn, not two seconds after it —
    // the banner rides over a live HUD, which is what "you are loose" looks like.
    document.body.classList.remove('match-ceremony');
    this.audio.unlock();
    // Deep ship's horn UNDER the heroic fanfare — the pairing the engine's own
    // doc calls for ("under/before the fanfare").
    this.audio.playMatchStartHorn();
    this.audio.playMatchStart();
    this.pushFeed(`The horn sounds — ${payload.crews} crews are loose on these waters.`, '#f0dda6');
    this.startSeqHideTimer = window.setTimeout(() => {
      this.startSeqHideTimer = null;
      this.startSeqPhase = 'idle';
      this.hideStartSequence();
      // Keep the horn class until the fade finishes or the banner snaps back.
      window.setTimeout(() => this.ui.matchStartSeq.classList.remove('horn'), 400);
    }, 2200);
  }

  // ── The gold race, made physical ──────────────────────────────────────
  /**
   * A crew is past 60% of the gold target. Until this existed, the leader of
   * the match's signature race was an invisible number: nobody could point at
   * them, sail at them, or feel the fleet turn. Now the whole sea is told, with
   * the same deep horn that opened the match, and their hull wears a hunter's
   * ring on every chart (MapRenderer). The cry repeats each storm phase.
   */
  private announceBounty(payload: BountyRaisedPayload): void {
    const own = payload.shipId === this.localShipId;
    const pct = Math.round((payload.gold / Math.max(1, payload.targetGold)) * 100);
    // The match-start horn was a stand-in: it says "begin", not "there is a
    // price on that hull". The score has a figure written for this — falling,
    // unresolved, blood money.
    this.audio.playEventSting('bounty');
    if (own) {
      this.pushFeed(
        payload.renewed
          ? `THE BOUNTY STANDS — ${pct}% of the run banked, and every hull knows it`
          : `BOUNTY ON YOUR CREW — ${pct}% of the run is in your hold. Run, or fight.`,
        '#ff8a6a',
      );
      return;
    }
    this.pushFeed(
      payload.renewed
        ? `BOUNTY STANDS — ${payload.crewName} still hauls ${payload.gold}g. Hunt them.`
        : `BOUNTY RAISED — ${payload.crewName} has banked ${payload.gold}g (${pct}%). Hunt them.`,
      '#ffb347',
    );
  }

  /** A hold burst open as she went down: there is treasure in the water. */
  private announceCargoSpill(payload: CargoSpilledPayload): void {
    const own = payload.shipId === this.localShipId;
    this.pushFeed(
      own
        ? `YOUR HOLD BURST — ${payload.gold}g went into the water. Dive for it.`
        : `${payload.crewName}'s hold burst — ${payload.gold}g of cargo is in the water.`,
      '#ffd278',
    );
    this.audio.playKill();
  }

  /** Coin banked off the seabed — the loudest possible confirmation of a dive. */
  private announceSpoilClaimed(payload: SpoilClaimedPayload): void {
    if (payload.playerId === this.localPlayerId) {
      this.pushFeed(`Sunken cargo recovered — +${payload.gold}g`, '#ffd278');
      this.audio.playGoldEarn();
      return;
    }
    this.pushFeed(`${payload.playerName} recovered ${payload.gold}g of sunken cargo.`, '#d9c17e');
  }

  // ── Crew eliminations ─────────────────────────────────────────────────
  /**
   * A crew's ship went under. CREWS AFLOAT used to fall 10 → 7 → 5 with no
   * on-screen event at all, so the BR's tension meter decayed invisibly: a gold
   * feed line, a counter pulse and a sting now mark every one.
   *
   * The line says SHIP SUNK, not "crew eliminated": this fires the moment the
   * hull starts going down, and under the sink-survival rule that crew is still
   * in the match — swimming, boarding someone else's deck, marooned on a key.
   * Calling them eliminated while they are shooting at you is a lie the counter
   * itself never told (it counts hulls AFLOAT); real eliminations have their own
   * kill-feed lines.
   */
  private announceCrewEliminated(payload: CrewEliminatedPayload): void {
    const remaining = Math.max(0, payload.remaining);
    const credit = payload.byName ? ` · sunk by ${payload.byName}` : '';
    this.pushFeed(
      `SHIP SUNK — ${remaining} crew${remaining === 1 ? '' : 's'} afloat · ${payload.crewName}${credit}`,
      '#f0c46a',
    );
    this.hud.pulseCrewsAfloat();
    // The killer already got playKill + playKillConfirm off their own hit —
    // a second toll on top of those is mud, not drama.
    if (payload.byPlayerId !== this.localPlayerId) this.audio.playKill();
    if (remaining === 3) this.pushFeed('THREE CREWS REMAIN — ENDGAME', '#ff9d5c');
    else if (remaining === 2) this.pushFeed('FINAL DUEL — TWO CREWS LEFT', '#ff8a6a');
  }

  // ── First objective: your own hull ────────────────────────────────────
  /** Marker + objective run until the pirate first boards, then never again. */
  private ownShipObjectiveActive = false;
  private ownShipObjectiveDone = false;
  private ownShipObjectiveDeadline = 0;
  /** Guards the "aboard" feed line — a pirate who SPAWNED aboard was never nudged. */
  private ownShipMarkerWasShown = false;

  private clearOwnShipObjective(): void {
    this.ownShipObjectiveActive = false;
    this.ownShipObjectiveDone = false;
    this.ownShipObjectiveDeadline = 0;
    this.ownShipMarkerWasShown = false;
    this.ui.ownShipMarker.classList.remove('visible');
  }

  /**
   * Projects a gold sail glyph over the player's own ship until they board it.
   * At spawn the hull is parked at the berth ~40 m away carrying no marker at
   * all — findable, but nothing said it was yours or that boarding was step one.
   */
  private updateOwnShipObjective(): void {
    const marker = this.ui.ownShipMarker;
    const player = this.getLocalPlayer();
    const ship = this.localShipId ? this.shipsById.get(this.localShipId) ?? null : null;
    // The start ceremony owns the screen until the horn — and its 120 s window
    // must not burn down while the helm is still locked.
    if (this.ownShipObjectiveDone || !player || !ship || !ship.alive || this.isStartCeremonyActive()) {
      this.ownShipObjectiveActive = false;
      if (marker.classList.contains('visible')) marker.classList.remove('visible');
      return;
    }
    if (this.ownShipObjectiveDeadline === 0) {
      // Long enough to walk the dock even after a scenic detour; the nudge is
      // guidance for the opening, not a permanent HUD fixture.
      this.ownShipObjectiveDeadline = performance.now() + 120_000;
    }
    this.ownShipObjectiveActive = true;
    const aboard = player.onShipId === ship.id;
    if (aboard || performance.now() > this.ownShipObjectiveDeadline) {
      this.ownShipObjectiveDone = true;
      this.ownShipObjectiveActive = false;
      marker.classList.remove('visible');
      if (aboard && this.ownShipMarkerWasShown) {
        this.pushFeed('Aboard — take the helm and make for open water.', '#9ec0e5');
      }
      return;
    }

    const camera = this.renderer.camera;
    camera.updateMatrixWorld();
    // Above the masthead so the glyph clears the hull from any angle.
    this.tempHudVector.set(ship.position.x, ship.position.y + 12, ship.position.z);
    const distance = this.tempHudVector.distanceTo(camera.position);
    this.tempHudVector.project(camera);
    const behind = this.tempHudVector.z > 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    let x = (this.tempHudVector.x * 0.5 + 0.5) * width;
    let y = (-this.tempHudVector.y * 0.5 + 0.5) * height;
    if (behind) {
      // Behind the camera the projection mirrors — flip it and pin to the edge
      // so the marker still points the right way round.
      x = width - x;
      y = height * 0.72;
    }
    // Clamp inside the PLAY AREA, not the viewport: pinned to a screen corner
    // the marker landed on top of the gold/kills panel ("YOUR SHIP 14m" printed
    // through the HUD chrome).
    x = THREE.MathUtils.clamp(x, width * 0.16, width * 0.84);
    y = THREE.MathUtils.clamp(y, height * 0.22, height * 0.74);
    marker.style.left = `${Math.round(x)}px`;
    marker.style.top = `${Math.round(y)}px`;
    this.ui.ownShipMarkerDistance.textContent = `${Math.round(distance)}m`;
    marker.classList.add('visible');
    this.ownShipMarkerWasShown = true;
  }

  /** Tear the ceremony down instantly (match teardown / return to menu). */
  private clearStartSequence(): void {
    if (this.startSeqHideTimer !== null) {
      window.clearTimeout(this.startSeqHideTimer);
      this.startSeqHideTimer = null;
    }
    this.startSeqPhase = 'idle';
    this.startSeqLastCount = -1;
    this.crewFoundAtMs = 0;
    this.startSeqDeadlineMs = 0;
    this.startSeqCrews = 0;
    this.hideStartSequence();
    this.ui.matchStartSeq.classList.remove('horn');
    this.ui.matchStartCount.classList.remove('tick');
    this.ui.matchStartCount.textContent = '';
    this.ui.matchStartIsland.textContent = '';
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
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    document.body.classList.remove('showing-death-screen');
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
    // A new round may raise the elimination card again.
    this.matchResultsShown = false;
    this.spectatePlacement = null;
    this.spectateSubjectId = null;
    this.spectateSubjectLabel = '';
    this.spectateHandoff = 0;
    // The server's snapshot counter restarts per match — so must ours.
    this.clientState.lastAppliedSeq = -1;
    this.clearStartSequence();
    this.hud.resetForMatch();
    this.clearOwnShipObjective();
    this.footstepDistance.clear();
    this.prevInCaveForAudio = null;
    this.prevSubmergeDepthForAudio = -1;
    this.clearJoinAssignmentWatchdog();
    this.state = null;
    this.localPlayerId = null;
    this.localShipId = null;
    this.playersById.clear();
    this.shipsById.clear();
    this.livePlayerIds.clear();
    this.liveProjectileIds.clear();
    this.liveKegIds.clear();
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
    this.viewmodel.localViewWeaponId = null;
    this.viewmodel.localViewWeaponAmmoSignature = '';
    this.viewmodel.localViewWeaponKick = 0;
    this.viewmodel.localViewWeaponReloadPhase = 0;
    this.viewmodel.localViewPocketKind = null;
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
    document.body.classList.remove('showing-death-screen');
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
    // Drops the held meshes but keeps the muzzle-flash rig and the first-person
    // hands, which are permanent children of the viewmodel roots (disposing the
    // whole root used to kill every muzzle flash for the rest of the session).
    this.viewmodel.resetForMatch();
    this.spoilsRenderer.reset();
    this.seaEvents.reset();
    for (const drop of this.droppedWeapons) {
      this.renderer.scene.remove(drop.mesh);
      this.disposeSceneObject(drop.mesh);
    }
    this.droppedWeapons.length = 0;
    this.prevPlayerHealth.clear();
    this.prevPlayerStateById.clear();
    this.prevPlayerFallSpeed.clear();
    this.deathCauseHints.clear();
    this.localDeathAnchor = null;
    this.localDeathBlend = 0;
    this.updateDeathOverlay(0);

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
    this.envFx.clearLanternEmitters();
    this.shipRenderer.clear();
    this.islandMeshes.clear();
    this.islandPropInstances.clear();
    // Last match's islands are disposed above; their warm/reveal bookkeeping
    // must go with them or the next match's islands inherit "already warm".
    this.lodWarmer.reset();
    clearFirstDrawBudget();
    this.islandDetailShown.clear();
    this.tavernDoors = [];
    // Promoted harvest clones / mid-fall palms lived inside island groups —
    // already disposed with the environment children above.
    this.envFx.harvestPromoted = null;
    this.envFx.harvestFalls.length = 0;
    this.envFx.prevHarvestChopCycle = 1;
    // Islands still queued from the previous match must not drain into the
    // next one as untracked ghost terrain. The same goes for sea rocks: their
    // mesh map is cleared just below, so a leftover rock would sail straight
    // past the already-built check and put last match's reef in this one's sea.
    this.pendingIslandBuilds.length = 0;
    this.pendingSeaRockBuilds.length = 0;
    this.envFx.volcanicFx = [];
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
    // A new voyage rediscovers the Reach: scenes speak again, speakers open
    // with their lore again, and the beacons rebuild from the fresh world.
    this.seenVignettes.clear();
    this.npcTalkCount.clear();
    this.npcInRange.clear();
    for (const beacon of this.storyBeacons) {
      this.renderer.scene.remove(beacon.core, beacon.halo);
      beacon.core.material.dispose();
      beacon.halo.material.dispose();
    }
    this.storyBeacons.length = 0;
    this.storyBeaconsBuiltFor = '';
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

  /**
   * ONE END SCREEN AT A TIME.
   *
   * The elimination card (SHIP SUNK, "waiting for the voyage to end…") and the
   * match-results card (DEFEATED, with the fleet board) are two different
   * moments, and they were both allowed on screen at once: the results card
   * drew over a still-visible elimination card, each carrying its own RETURN TO
   * PORT button with one of them unreachable behind the other. Once the results
   * are up the round is genuinely over, so nothing may re-raise the wait card —
   * not a late `game_over`, not a victory sting arriving after the board.
   */
  private matchResultsShown = false;

  private returnToLobbyAfterLoss(kills: number, gold: number, reason = 'Defeated') {
    if (this.matchResultsShown) return;
    // In multiplayer mode: don't disconnect or auto-respawn. Show the death screen
    // with a "Return to Port" button. The server-side match_ended will deliver the
    // full leaderboard when (or if) the round actually ends.
    this.ui.deathStats.innerHTML = `<div>${reason}</div><div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.ui.deathScreen.classList.add('visible');
    this.ui.deathScreen.style.display = 'flex';
    // Drops the live HUD (legend card, minimap, feed, prompts) behind the
    // screen — it was printing straight through the copy in every audit shot.
    document.body.classList.add('showing-death-screen');
  }

  private goBackToMenuFromMatch(): void {
    this.network.returnToMenu();
    this.inMatch = false;
    this.matchResultsShown = false;
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    document.body.classList.remove('showing-death-screen');
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

    // Drag to pan the opened chart; a click that didn't drag centres whatever
    // island (or island label) it landed on. Without this the chart was welded
    // to the player and half the Reach could never be looked at.
    const canvas = this.ui.mapCanvas;
    let dragPointer: number | null = null;
    let dragX = 0;
    let dragY = 0;
    let dragTravel = 0;
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.map.mapOpen || event.button !== 0) return;
      event.preventDefault();
      dragPointer = event.pointerId;
      dragX = event.clientX;
      dragY = event.clientY;
      dragTravel = 0;
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (event) => {
      if (dragPointer !== event.pointerId || !this.map.mapOpen) return;
      const dx = event.clientX - dragX;
      const dy = event.clientY - dragY;
      dragX = event.clientX;
      dragY = event.clientY;
      dragTravel += Math.hypot(dx, dy);
      this.map.panByClient(dx, dy);
      this.map.drawFullMap();
    });
    const endMapDrag = (event: PointerEvent) => {
      if (dragPointer !== event.pointerId) return;
      dragPointer = null;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.style.cursor = 'grab';
      // Under ~5px of travel is a click, not a drag.
      if (dragTravel < 5 && this.map.mapOpen) {
        if (this.map.focusIslandAtClient(event.clientX, event.clientY)) {
          this.audio.playUiClick();
          this.map.drawFullMap();
        }
      }
    };
    canvas.addEventListener('pointerup', endMapDrag);
    canvas.addEventListener('pointercancel', endMapDrag);
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

  /** Wires every server message. Split by topic so each registrar stays
   *  readable; the handler bodies themselves are unchanged. */
  private bindNetworkEvents() {
    this.bindSessionNetworkEvents();
    this.bindCombatNetworkEvents();
    this.bindLootNetworkEvents();
    this.bindTradeNetworkEvents();
  }

  /** Join / snapshot flow and match lifecycle. */
  private bindSessionNetworkEvents() {
    this.network.onJoin = (playerId, shipId, snapshot) => {
      this.clearJoinAssignmentWatchdog();
      this.localPlayerId = playerId;
      this.localShipId = shipId;
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

    this.network.onHotSnapshot = (hot) => {
      this.applyHotSnapshot(hot);
    };

    this.network.onMatchCountdown = (payload) => this.onMatchCountdownTick(payload);
    this.network.onMatchHorn = (payload) => this.onMatchHornBlown(payload);
    this.network.onCrewEliminated = (payload) => this.announceCrewEliminated(payload);
    this.network.onBountyRaised = (payload) => this.announceBounty(payload);
    this.network.onCargoSpilled = (payload) => this.announceCargoSpill(payload);
    this.network.onSpoilClaimed = (payload) => this.announceSpoilClaimed(payload);
    this.network.onWreckEvent = (payload) => this.announceWreckEvent(payload);

    this.network.onSnapshot = (snapshot) => {
      this.applySnapshot(snapshot);
    };

    this.network.onPlayerSpawned = (payload) => {
      const event = payload as {
        playerId?: string; mermaid?: boolean; stormGrace?: number; ashore?: boolean;
      };
      if (event.playerId === this.localPlayerId) {
        this.ui.deathScreen.style.display = 'none';
        // The HUD comes back with the pirate (see body.showing-death-screen).
        document.body.classList.remove('showing-death-screen');
        // The weather stands down for a few seconds after every respawn (Match
        // .grantStormRespawnGrace). Hand the length to the HUD so the chip can
        // count it out — a reprieve nobody can see is indistinguishable from luck,
        // and this one is the whole answer to being respawned inside the ring.
        this.hud.noteStormReprieve(event.stormGrace ?? 0, event.ashore === true);
        if (event.ashore) {
          this.pushFeed('The tide put you ashore inside the ring — your ship is elsewhere.', '#a9d4ff');
        }
        if (event.mermaid) {
          this.mermaidAnchor = null;
          if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
          this.pushFeed('The mermaid returned you to your ship.', '#8bc2d7');
        }
      }
    };

    this.network.onGameOver = (payload) => {
      const result = payload as { died?: boolean; winnerId?: string | null; kills?: number; gold?: number; reason?: string; targetGold?: number; cause?: string };
      const player = this.getLocalPlayer();
      // Match.ts already knows what took the last of your health (storm, shark,
      // drowning, fall, fire, cannon, shot, blade, keg…); hand it over so the
      // death screen names the real cause instead of falling back to the
      // client's read of the frame before the flip.
      //
      // ONLY when there is one to hand over. `game_over` also fires when some
      // OTHER crew wins, carrying no cause — and clearing on that message threw
      // away the cause a `kill_event` had already established for a pirate who
      // was eliminated minutes earlier. A new life is where the tag is dropped
      // (see the respawn edge in syncPlayers).
      if (result.cause) this.hud.noteEliminationCause(result.cause);
      if (result.died) {
        this.audio.playDefeat();
        this.returnToLobbyAfterLoss(result.kills ?? player?.kills ?? 0, result.gold ?? player?.gold ?? 0, 'Crew lost');
      } else if (result.winnerId && result.winnerId === this.localPlayerId) {
        this.audio.playVictory();
        if (!this.matchResultsShown) this.hud.showVictory(player?.kills ?? 0, result.gold ?? player?.gold ?? 0);
      } else {
        this.audio.playDefeat();
        const reason = result.reason === 'gold'
          ? `Enemy reached ${result.targetGold ?? ECONOMY.GOLD_WIN_TARGET} gold`
          : 'Crew lost';
        this.returnToLobbyAfterLoss(player?.kills ?? 0, player?.gold ?? 0, reason);
      }
    };

    this.network.onMatchEnded = (payload) => {
      type EndRow = {
        playerId: string; name: string; kills: number; deaths: number;
        gold: number; placement: number; isWinner: boolean; isBot?: boolean; alive?: boolean;
      };
      const result = payload as {
        winnerId: string | null;
        winnerName: string | null;
        reason: string;
        humans: EndRow[];
        /** Every crew in the match, bots included, ranked once (Match.buildEndBoard). */
        board?: EndRow[];
        crewCount?: number;
      };
      const youId = this.localPlayerId;
      // The board is the whole fleet; `humans` is the persistence list and is
      // only the fallback for a server that predates it.
      const rows = result.board?.length ? result.board : result.humans;
      const youRow = rows.find((r) => r.playerId === youId);
      const won = !!result.winnerId && result.winnerId === youId;
      const subtitle = result.reason === 'gold'
        ? `${result.winnerName ?? 'A pirate'} amassed enough gold`
        : result.reason === 'last_ship'
          ? 'Last crew afloat takes the seas'
          : 'The voyage ended';
      this.matchResultsShown = true;
      const fleet = result.crewCount ?? rows.length;
      const standing = youRow
        ? (won ? `Place: #1 of ${fleet} — the seas are yours` : `Place: #${youRow.placement} of ${fleet}`)
        : '';
      this.menu.showEndmatch({
        isWinner: won,
        title: won ? 'VICTORY' : (youRow?.deaths ? 'DEFEATED' : 'VOYAGE ENDED'),
        subtitle,
        standing,
        rows: rows.map((r) => ({
          placement: r.placement,
          name: r.name,
          kills: r.kills,
          deaths: r.deaths,
          gold: r.gold,
          you: r.playerId === youId,
          winner: r.isWinner,
          bot: r.isBot,
          alive: r.alive,
        })),
      });
    };
  }

  /** Damage, downs, kills and explosions. */
  private bindCombatNetworkEvents() {
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
        /** Set on environmental blows (storm/drown/fall/fire/shark) — no attacker. */
        cause?: string;
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
        // The grunt is CombatFx's (it hears storm/drown/fall/fire too) — playing
        // it here as well doubled it up on every bullet.
        this.handleIncomingHit(hitPayload);
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
      const hit = payload as {
        targetId?: string;
        attackerId?: string | null;
        position?: { x: number; y: number; z: number };
        projectileType?: string;
        holes?: Array<{ id: number; x: number; y: number; z: number }>;
      };
      // Instant breach: upsert the hull-local points the server just punched
      // into our own copy of the ship so ShipRenderer's id-diff spawns the
      // decal on THIS frame instead of up to 100ms later on the next full
      // snapshot. The snapshot then reconciles — the upsert is id-keyed and
      // idempotent, so a double-apply is a no-op. Runs for the attacker too
      // (they get the earliest possible decal on the hull they just holed).
      const target = hit.targetId ? this.shipsById.get(hit.targetId) : null;
      if (target && hit.holes?.length) {
        if (!Array.isArray(target.holes)) target.holes = [];
        for (const fresh of hit.holes) {
          const existing = target.holes.find((h) => h.id === fresh.id);
          if (existing) {
            existing.x = fresh.x; existing.y = fresh.y; existing.z = fresh.z;
            existing.patched = false;
          } else {
            target.holes.push({ ...fresh, patched: false });
          }
        }
      }
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
        victimId?: string;
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
        cause?: string;
      };
      // WHAT KILLED YOU, on every death and not just the last one. game_over
      // only fires on elimination, so a respawning pirate's blackout had no
      // cause to name; the kill event carries the server's reading for both.
      if (event.victimId && event.victimId === this.localPlayerId && !event.shipSink) {
        this.hud.noteEliminationCause(event.cause ?? null);
      }
      // Stash the kill details for the death-animation edge in syncPlayers —
      // it picks the crumple (headshot goes limp, a blade kill spins) from here.
      if (event.victimId && !event.shipSink) {
        this.deathCauseHints.set(event.victimId, {
          killerId: event.killerId ?? null,
          headshot: !!event.headshot,
        });
      }
      // YOU dropped someone: the dry confirm stab on top of the kill feed.
      if (event.killerId && event.killerId === this.localPlayerId && !event.shipSink) {
        this.audio.playKillConfirm();
      }
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
  }

  /** Chests, barrels, harvest, upgrades and shop flow. */
  private bindLootNetworkEvents() {
    this.network.onChestOpened = (payload) => {
      const event = payload as { action?: string; value?: number; loot?: Array<{ item: string; qty: number }> };
      if (event.action === 'pickup') {
        this.pushFeed(`Chest taken: base ${event.value ?? 0} gold, Tallymen pay more.`, '#d9c17e');
        // The carryingChestId edge-detector also fires for the local player; this covers other crew.
        return;
      }
      if (event.action === 'stow') {
        this.pushFeed(`Chest stowed aboard: base ${event.value ?? 0} gold before Tallyman payout.`, '#d9c17e');
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
      if (this.envFx.harvestPromoted
        && this.envFx.harvestPromoted.islandId === event.islandId
        && this.envFx.harvestPromoted.propId === event.propId) {
        liveNode = this.envFx.harvestPromoted.node;
        liveNode.rotation.x = 0;
        liveNode.rotation.z = 0;
        liveNode.position.copy(this.envFx.harvestPromoted.basePos);
        this.envFx.harvestPromoted = null;
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
        if (!liveNode && prop) liveNode = this.envFx.buildHarvestClone(island, prop);
        if (liveNode) this.envFx.beginPalmTopple(liveNode, event.byPlayerId);
      } else if (island && propType?.startsWith('boulder_')) {
        if (liveNode) {
          liveNode.getWorldPosition(this.envFx.tempHarvestVec);
          liveNode.removeFromParent();
          this.disposeSceneObject(liveNode);
          this.combatFx.emitRockShatter(this.envFx.tempHarvestVec, this.envFx.tempHarvestVec.y);
        } else if (prop) {
          const groundY = island.position.y + getPropGroundY(island, prop);
          this.envFx.tempHarvestVec.set(prop.x, groundY + 0.4 * prop.scale, prop.z);
          this.combatFx.emitRockShatter(this.envFx.tempHarvestVec, groundY);
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
        `Tallyman's chart: ${event.islandName ?? 'unknown island'} (${event.chestCount ?? 0} X marks).`,
        '#d9c17e',
      );
      if (this.map.mapOpen) this.map.drawMaps();
    };

    this.network.onAmmoRefilled = () => {
      this.pushFeed('Ammo chest — every firearm topped up.', '#9fd18a');
      this.audio.playRepairSequence();
    };

    // A dead [X] used to be pure silence: right prompt, nothing happens, and the
    // player mashes the key. The server now answers a refused press — one amber
    // line and a dull thud, so the failure is at least legible.
    this.network.onInteractRefused = (payload) => {
      const refusal = payload as { intent?: string; reason?: string };
      this.pushFeed(interactRefusalLine(refusal.intent, refusal.reason), '#e0a33c');
      this.audio.playBodyThud(0.35);
    };
  }

  /** Ship-to-ship parley/trade session. */
  private bindTradeNetworkEvents() {
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
    const weaponLabel = wid && wid in WEAPONS ? weaponDisplayName(wid) : undefined;
    if (payload.position) {
      this.spawnFloatingDamageIndicator(String(damage), payload.position, {
        headshot: !!payload.headshot,
        kill: !!payload.kill,
        ship,
        weaponLabel,
      });
    }
  }

  /**
   * WHAT IS TAKING MY HEALTH? — the environmental half of the answer.
   *
   * An audit watched 100 → 58 wandering and 58 → 8 walking to a chest and could
   * not name a point of it. The red vignette was there (CombatFx watches the
   * vitals directly), so "something is hurting me" was on screen; nothing ever
   * said WHAT, because only combat shipped a hit message. The server now names
   * every environmental blow it bills — these are the words for them, in the
   * present tense, because they are read while there is still time to act.
   */
  private static readonly ENV_DAMAGE_COPY: Record<string, { label: string; feed: string }> = {
    storm: { label: 'THE STORM', feed: 'The storm is tearing at you — get inside the ring [M]' },
    drowned: { label: 'DROWNING', feed: 'You are drowning — [SPACE] swims up' },
    fall: { label: 'THE FALL', feed: 'The landing hurt — deep water breaks a fall, rock does not' },
    fire: { label: 'FIRE', feed: 'You are burning — get off the fire, or douse it with a bucket' },
    shark: { label: 'SHARK', feed: 'A shark has you — get out of the water' },
  };

  private handleIncomingHit(payload: {
    damage?: number;
    sourcePosition?: { x: number; y: number; z: number };
    position?: { x: number; y: number; z: number };
    headshot?: boolean;
    kill?: boolean;
    weaponId?: WeaponId | string;
    attackerName?: string;
    cause?: string;
  }) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    // Environmental: no attacker to blame, so the cause carries the frame. A
    // floating number at your own chest (the same indicator a cutlass draws) and
    // one feed line naming it and what to do about it.
    const env = payload.cause ? Game.ENV_DAMAGE_COPY[payload.cause] : undefined;
    if (env) {
      if (payload.position) {
        this.spawnFloatingDamageIndicator(`-${damage}`, payload.position, { weaponLabel: env.label });
      }
      // Throttled to one line per cause per stretch of damage, so a storm that
      // bills for ninety seconds does not become ninety identical feed lines.
      const lastAt = this.envFeedAt.get(payload.cause!) ?? -Infinity;
      if (performance.now() - lastAt > 6000) {
        this.envFeedAt.set(payload.cause!, performance.now());
        this.pushFeed(env.feed, '#ff9d6f');
      }
      return;
    }
    const wid = payload.weaponId;
    const weaponLabel = wid && wid in WEAPONS
      ? weaponDisplayName(wid)
      : wid === 'powder_keg'
        ? 'Powder Keg'
        : 'attack';
    const attacker = payload.attackerName?.trim() || 'Enemy';
    const critical = payload.headshot ? ' headshot' : '';
    this.pushFeed(`Hit by ${attacker}${critical} - ${damage} (${weaponLabel})`, payload.headshot ? '#ff8f6d' : '#ffb37a');
    // No direction arrow here: CombatFx's hurt wedge already smears the edge of
    // the frame the shot came from, and it fires on EVERY loss of health rather
    // than only on the hits that happen to carry a sourcePosition.
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
    // Dropped when a newer hot/full snapshot already landed — applying the
    // overtaken one would rewind every transform for a frame.
    if (!this.clientState.acceptSeq(snapshot.seq)) return;
    const hasFreshIslandState = snapshot.islands.length > 0 || !this.state;
    // Static world (islands + seaRocks) rides only every 4th full snapshot on
    // the wire — preserve the previous copies on the ticks that omit them.
    const nextSnapshot = this.state && (snapshot.islands.length === 0 || (snapshot.seaRocks?.length ?? 0) === 0)
      ? {
        ...snapshot,
        islands: snapshot.islands.length === 0 ? this.state.islands : snapshot.islands,
        seaRocks: (snapshot.seaRocks?.length ?? 0) === 0 ? this.state.seaRocks : snapshot.seaRocks,
        seaPois: (snapshot.seaPois?.length ?? 0) === 0 ? this.state.seaPois : snapshot.seaPois,
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
    // The uncharted sea (fixed micro-POIs) and the Gilded Wreck. syncWreck also
    // notices when her chests/barrels have landed in the island copy and asks
    // for their meshes — they arrive mid-match, long after their island built.
    this.seaEvents.syncPois(nextSnapshot.seaPois);
    this.seaEvents.syncWreck(nextSnapshot.wreck ?? null, nextSnapshot.islands);
    this.syncChests();
    this.updateStormRing();
    this.updateDamageFx();
    this.syncTradeUi(nextSnapshot);
    const localPlayer = this.getLocalPlayer();
    if (localPlayer && previousLocalState === 'respawning' && localPlayer.state === 'alive') {
      this.combatFx.emitRespawn(localPlayer.position, this.renderer.camera.position);
      // A new life owes nothing to the last one: drop the death cause so the
      // NEXT blackout can't be labelled with the last blow.
      this.hud.noteEliminationCause(null);
    }
    this.previousLocalState = localPlayer?.state ?? null;
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
        dist2D(cam.x, cam.z, a.position.x, a.position.z)
        - dist2D(cam.x, cam.z, b.position.x, b.position.z));
      // Elliptical footprints: foam/shallows/damping land at the real
      // waterline (the old circle-of-roster-radius buried the foam band tens
      // of meters inside the beach).
      this.ocean.setIslands(state.islands.map((i) => ({
        x: i.position.x,
        z: i.position.z,
        rx: i.radius * i.profile.footprintX,
        rz: i.radius * i.profile.footprintZ,
      })));
      // Build the closest one now so the spawn area is there; the rest stream
      // in over the next frames, one per frame, each drawn a frame after it is
      // built (see drainIslandBuildQueue).
      this.drainIslandBuildQueue(1);
    }
    for (const rock of state.seaRocks ?? []) {
      if (!this.seaRockMeshes.has(rock.id)
        && !this.pendingSeaRockBuilds.some((queued) => queued.id === rock.id)) {
        this.pendingSeaRockBuilds.push(rock);
      }
    }
  }

  /** Build up to `count` queued islands (called once per frame from the main
   *  loop with count=1, and from ensureWorldMeshes for the spawn area).
   *
   *  A newly built island is held HIDDEN for one frame and revealed by the NEXT
   *  drain. Geometry cost and first-draw cost are different bills: three links
   *  a material the first time it is actually drawn, so two islands appearing
   *  together put both their program sets into a single draw call. Splitting
   *  build-frame from reveal-frame means at most one island's worth of shaders
   *  ever compiles per frame. */
  drainIslandBuildQueue(count = 1) {
    if (this.islandAwaitingReveal) {
      this.islandAwaitingReveal.visible = true;
      this.islandAwaitingReveal = null;
    }
    for (let i = 0; i < count && this.pendingIslandBuilds.length > 0; i++) {
      const island = this.pendingIslandBuilds.shift()!;
      if (this.islandMeshes.has(island.id)) continue;
      // Contain per-island build throws: this drains inside frame() BEFORE the
      // next requestAnimationFrame is scheduled, so one bad island otherwise
      // kills the render loop outright (frozen canvas, no error surface).
      try {
        this.islands.buildIsland(island);
        const group = this.islandMeshes.get(island.id);
        // Arm the chunked reveal HERE, not at the LOD radius crossing. The
        // group is held hidden for one frame and then made visible by the next
        // drain — which runs AFTER updateEnvironmentLod — so an island built
        // inside the detail radius (every spawn island) would otherwise draw
        // its whole subtree on that one frame before the LOD pass ever saw it.
        const builtDetailRoot = group?.userData.detailRoot as THREE.Object3D | undefined;
        if (builtDetailRoot) {
          this.lodWarmer.requestWarm(island.id, builtDetailRoot);
          this.lodWarmer.beginReveal(island.id, builtDetailRoot);
          // Matches detailRoot's own default; a distant island's first LOD pass
          // reads this as "shown", flips it off and cancels the reveal.
          this.islandDetailShown.set(island.id, true);
        }
        if (group && !this.islandAwaitingReveal) {
          group.visible = false;
          this.islandAwaitingReveal = group;
        }
      } catch (err) {
        console.error(`[World] failed to build island ${island.id}:`, err);
      }
    }
  }

  /** Island built this frame, drawn for the first time on the next one. */
  private islandAwaitingReveal: THREE.Object3D | null = null;
  /** Sea rocks still to be built, spread out for the same reason as islands. */
  private pendingSeaRockBuilds: SeaRock[] = [];

  /**
   * THE LOAD MUST YIELD, and this is the switch that says when "the load" is.
   *
   * The freeze the player reported lives entirely between opening the page and
   * getting first control: the menu's own hover took 1.5s to be acknowledged,
   * single main-thread tasks ran 2.4s, and the whole of it was three linking
   * shader programs inside the frame that first drew them (see ProgramWarmup).
   * While this is up, the renderer refuses to draw a material whose program it
   * has not already paid for — the frame renders without it and the next frame
   * pays. That is the difference between a load that tries to warm and a load
   * that cannot block.
   *
   * It comes back DOWN once the world has arrived, because holding a material
   * out of a frame during play would be a visible pop for no benefit, and the
   * walk that finds them is not free. Steady state has its own machinery: the
   * per-frame first-draw allowance and the island LOD warmer.
   */
  private updateLoadGuard(now: number): void {
    const loading = !this.inMatch
      || this.isStartCeremonyActive()
      || this.getWorldBuildBacklog() > 0;
    // A tail, because the last island's build frame is not the last frame that
    // draws something for the first time — its reveal is paced out behind it.
    if (loading) this.loadGuardUntil = now + Game.LOAD_GUARD_TAIL_MS;
    this.renderer.setLoadGuard(now < this.loadGuardUntil);
    // …and the governor samples nothing through it. A frame spent building an
    // island, linking its programs and revealing its subtree is a measurement of
    // the load, not of the machine, and a controller that believed it would
    // spend its whole ladder before the horn.
    this.renderer.setGovernorSuspended(now < this.loadGuardUntil);
    // Nobody is playing during the menu or the ceremony, so warm harder there:
    // every program paid before the horn is one that cannot stall after it.
    this.renderer.setWarmBoost(!this.inMatch || this.isStartCeremonyActive());
  }

  private loadGuardUntil = 0;
  /** How long the guard outlives the last thing that was still arriving. */
  private static readonly LOAD_GUARD_TAIL_MS = 5_000;

  /** How much of the world is still arriving: 0 = nothing left to stream. */
  getWorldBuildBacklog(): number {
    return this.pendingIslandBuilds.length
      + (this.islandAwaitingReveal ? 1 : 0)
      + (this.pendingSeaRockBuilds.length > 0 ? 1 : 0);
  }

  /** Build a few queued sea rocks. Thirty-six of them landing on the same frame
   *  as the spawn island stacked their first draws onto that one freeze. */
  private drainSeaRockBuildQueue(count = 6) {
    for (let i = 0; i < count && this.pendingSeaRockBuilds.length > 0; i++) {
      const rock = this.pendingSeaRockBuilds.shift()!;
      if (this.seaRockMeshes.has(rock.id)) continue;
      try {
        const mesh = this.islands.buildSeaRockMesh(rock);
        this.environment.add(mesh);
        // Scenery, bolted to the seabed: off the per-frame world-matrix walk.
        freezeStaticSubtree(mesh);
        this.seaRockMeshes.set(rock.id, mesh);
      } catch (err) {
        console.error(`[World] failed to build sea rock ${rock.id}:`, err);
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

  private frame(now: number) {
    const rawDtMs = now - this.lastFrameTime;
    const dt = Math.min(0.05, rawDtMs / 1000);
    this.lastFrameTime = now;
    this.frameDt = dt;
    // True frame time for the debug overlay (physics dt above is clamped to
    // 50ms for sim stability, which was pinning 'worst' at exactly 50.0).
    this.debugRawFrameMs = rawDtMs;
    this.stepFrameCpu(now, dt);
    this.renderer.render();
    if (this.bugSnapRequested) {
      this.bugSnapRequested = false;
      // A full-canvas toDataURL is a synchronous readback and a PNG encode, and
      // it lands in the NEXT frame's dt. It is a one-off the caller can name, so
      // name it: pressing F8 must not cost the player their resolution.
      this.renderer.markFrameOneOff();
      this.captureBugSnap();
    }
    this.stepFramePost();
    this.updateDebugPerfPanel(dt);

    requestAnimationFrame((time) => this.frame(time));
  }

  /**
   * EVERY BIT OF PER-FRAME CPU WORK THAT IS NOT THE DRAW ITSELF.
   *
   * Split out of `frame()` so a measurement rig can run it — and only it — a
   * pinned number of times with a pinned dt (see `benchFrameCpu`). Per-frame
   * ALLOCATION cannot be read off a rAF window on the software rasteriser: a
   * frame there is 0.15-1.2s long, so the 10Hz snapshot stream and every timed
   * subsystem land inside a fraction of the frames and get charged to them. Two
   * captures of the same build disagreed 5x per frame that way (docs
   * FRAME_COST_MODEL §6.3). Driving this N times with dt = 1/60 charges every
   * amortised subsystem exactly the share of a 60fps frame it really costs, and
   * the answer is the same on Metal and on SwiftShader because no GL is in it.
   *
   * Nothing may be added to `frame()` between here and `render()` without going
   * in this method, or the allocation gate stops covering it.
   */
  private stepFrameCpu(now: number, dt: number) {
    this.minimapTimer -= dt;
    this.inputSendTimer -= dt;
    this.inputHeartbeatTimer -= dt;
    this.windWispTimer -= dt;
    this.rainOverlayTimer -= dt;

    if (this.serverTimeOffset !== null) {
      this.ocean.setWaveTime(performance.now() / 1000 + this.serverTimeOffset);
    }
    // One animation frame, one island-chart rasterization budget — claimed here
    // so every chart drawn this frame (throttled minimap, live fullscreen map,
    // the inventory chart, a network event that repaints mid-frame) draws from
    // the same allowance instead of each helping itself to a fresh one.
    this.map.beginFrame();
    // …and one first-draw allowance, claimed in the same place and for the same
    // reason. The island LOD pass and the ship renderer both spend it, so it
    // cannot be reset by either of them.
    beginFirstDrawFrame();
    this.ocean.update(dt, this.renderer.camera.position);
    this.ocean.setAtmosphere(this.renderer.getAtmosphere());
    this.updateOceanCaveSuppression();
    this.updateScene(dt);
    // Shared match clock (same value the server passes to the physics/geyser
    // timing) drives the volcanic magma flicker + geyser plumes in lockstep.
    const worldTime = this.serverTimeOffset !== null
      ? performance.now() / 1000 + this.serverTimeOffset
      : performance.now() / 1000;
    this.envFx.updateVolcanicFx(dt, worldTime);
    this.updateTavernDoors(dt);
    this.envFx.updateWaterfallBed(this.renderer.camera.position);
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
      const currentInteractKind = this.interactions.resolveCurrentInteractKind();
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
    this.viewmodel.updateCapstanHands();
    this.viewmodel.updateSlashRibbons(dt);
    this.viewmodel.updateMuzzleFlash(dt);
    if (!this.bugSnapListenerBound) {
      this.bugSnapListenerBound = true;
      window.addEventListener('keydown', this.bugSnapListener);
    }
    this.updateMermaid(now);
    // Stream one queued island build per frame (join used to build all 10
    // synchronously and freeze the tab for seconds).
    // Both queues are amortizers, and both now read the one shared signal
    // instead of a constant each (see FrameBudget): a machine holding 60 gets
    // the world faster, a machine at 8fps stops being handed the same quota as
    // one that is fine. Floored at one island / one rock so the world always
    // finishes arriving.
    this.drainIslandBuildQueue(budgeted(1, 1));
    this.drainSeaRockBuildQueue(budgeted(6, 1));
    this.updateLoadGuard(now);
    this.renderer.updatePerformance(dt);
  }

  /** The DOM-only tail of a frame, after the draw. Part of the CPU frame, so the
   *  allocation bench runs it too. */
  private stepFramePost() {
    this.updatePointerLockHint();
    // Outside every `if (!this.state)` guard: the ceremony must keep counting
    // while the join snapshot and the island builds are still landing.
    this.updateStartSequenceFrame();
  }

  /** F8, lifted out of `frame()` so the hot path is not carrying a page of
   *  once-a-session code that a reader has to skip past to find the render. */
  private captureBugSnap() {
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
            const d = dist2D(player?.position.x ?? 0, player?.position.z ?? 0, island.position.x, island.position.z);
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

  /**
   * MEASUREMENT HOOK — run the per-frame CPU work `count` times at a pinned dt,
   * with no draw and no rAF, so a heap sample either side is per-frame
   * allocation and nothing else. Returns the wall time it took (ADVISORY).
   *
   * Reachable only through `window.__piratesBR`; the game loop never calls it.
   * See `stepFrameCpu` for why a rAF window cannot answer this question here.
   */
  benchFrameCpu(count = 240, dt = 1 / 60): number {
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      // A synthetic clock, advanced by the same dt the step is charged, so every
      // `performance.now()`-gated subsystem inside sees a coherent 60fps frame
      // even though the loop runs far faster than real time.
      this.benchClockMs += dt * 1000;
      this.stepFrameCpu(this.benchClockMs, dt);
      this.stepFramePost();
    }
    return performance.now() - t0;
  }

  private benchClockMs = performance.now();

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
    const openLeaks = ship ? countOpenHoles(ship) : null;
    const prompt = (this.ui.interactPrompt.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const snapshotAgeMs = performance.now() - this.lastSnapshotAt;
    // Heartbeat round trip: a rising rtt (or '--') is the first sign the socket
    // is in trouble, well before the server's liveness sweep gives up on us.
    const rtt = this.network.getLatencyMs();

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
          `weapon ${activeWeapon?.weaponId ?? 'none'}`,
        ].join(' | ')
      : 'player none';

    const shipLine = ship
      ? [
          `ship ${ship.type}`,
          `leaks ${openLeaks ?? 0}`,
          `sail ${Math.round(ship.sailHeight * 100)}%`,
          `anchor ${ship.anchored ? `down ${Math.round((ship.anchorRaiseProgress ?? 0) * 100)}%` : 'up'}`,
          `speed ${Math.hypot(ship.velocity.x, ship.velocity.z).toFixed(1)}`,
        ].join(' | ')
      : 'ship none';

    // The governor's own line. The panel above it prints the tier and the dpr,
    // which between them cannot say WHY either of them is what it is — the
    // scalar, the mode and the median it is being judged against can.
    const gov = this.renderer.getGovernorStatus();
    // The shadow pass is skipped whenever it last drew nothing, and a draw-call
    // total cannot show that: an empty pass costs a full-map CLEAR and zero
    // draws, so the saving is invisible in every counter this panel already
    // prints. run/skip is the only place it shows.
    const sh = this.renderer.getShadowPassStats();
    const shadowLine = sh.mapSize
      ? `shadow ${sh.mapSize} ${sh.lastCasterDraws}casters ${sh.run}run/${sh.skipped}skip`
      : 'shadow off';
    const governorLine = gov.enabled
      ? `governor ${gov.mode} @${gov.targetFps}fps | q ${gov.scalar.toFixed(2)} `
        + `| med ${gov.medianMs.toFixed(1)}ms p95 ${gov.p95Ms.toFixed(1)}ms `
        + `| ${shadowLine} | stream ${this.renderer.getFrameBudgetScale().toFixed(2)}x`
      : `governor off (quality pinned) | ${shadowLine}`;

    this.debugPerfPanel.textContent = [
      'Pirates BR debug',
      `fps ${this.debugFps.toFixed(0)} | worst ${worstFrame.toFixed(1)}ms | quality ${this.renderer.getQuality()} | dpr ${this.renderer.renderer.getPixelRatio().toFixed(2)}`,
      governorLine,
      `draw ${info.render.calls} | tris ${info.render.triangles} | geom ${info.memory.geometries} | tex ${info.memory.textures}`,
      stateLine,
      playerLine,
      shipLine,
      `snapshot ${Math.round(snapshotAgeMs)}ms | rtt ${rtt === null ? '--' : `${rtt}ms`} | interact ${this.visibleInteractKind ?? this.lastInteractKind ?? 'none'} | prompt ${prompt || 'none'}`,
    ].join('\n');
  }

  /** Detail-LOD state per island: whether the subtree is currently shown (for
   *  hysteresis) — the reveal itself is owned by {@link lodWarmer}. */
  private readonly islandDetailShown = new Map<string, boolean>();
  /** Band outside the reveal radius where an island's shaders are pre-compiled.
   *  Wide enough that a ship at full sail crosses it in seconds, not frames. */
  private static readonly DETAIL_WARM_SCALE = 1.6;
  /** Once shown, an island holds its detail a few percent further out. Sitting
   *  exactly on the radius used to flip the subtree every other frame. */
  private static readonly DETAIL_HYSTERESIS = 1.06;


  /**
   * A HUMAN FIGURE IS FORTY DRAW CALLS, and nothing was ever deciding when to
   * stop paying them.
   *
   * `makePlayerMesh` builds a pirate out of about forty boxes and cylinders —
   * torso, shirt, coat skirt, two arm pivots, two leg pivots, a skull's worth of
   * face under a hat — and the same factory builds the story NPCs. The budget
   * census found nine of them at forty-two calls apiece drawn at the scene root
   * from INSIDE A CAVE, plus seven more NPCs in the environment group: some
   * seven hundred draw calls, in every single view, for people the view could
   * not resolve.
   *
   * The honest question is not "how far away is he" but "how big is he on the
   * screen", and those differ by the one thing a metre radius cannot see: the
   * SPYGLASS. Raising the scope narrows the camera's field of view, and a
   * distance cut-off would blank the very figure the player raised it to find.
   * So the test is the projected height of a 1.9 m figure, in pixels, and the
   * scope earns its range back automatically. MEASURED against the fields this
   * game actually uses, not the 60° a first draft of this note assumed: a pirate
   * falls under the floor at ~545 m on foot (74°), ~657 m down a firearm's sights
   * (64°), ~507 m while swimming (78°) — and at ~7.8 km through the spyglass
   * (6°), which is several times the width of the map.
   *
   * Measured against a FIXED reference height rather than the live viewport, so
   * that the same figure is drawn at the same distances in a small window as in
   * a large one — and so the budget census, which runs at 540p, is measuring the
   * distances a player actually gets rather than a stricter set of its own.
   */
  private static readonly CHARACTER_REFERENCE_HEIGHT_PX = 1080;
  /** Under this many pixels tall, a pirate is noise on the horizon. */
  private static readonly CHARACTER_MIN_PIXELS = 2.5;
  private static readonly CHARACTER_HEIGHT_M = 1.9;

  /** Projected height in reference pixels of a person `dist` metres away. */
  private characterPixels(dist: number): number {
    const camera = this.renderer.camera;
    const halfFov = Math.tan(((camera.fov ?? 60) * Math.PI) / 360);
    const worldPerPixel = (2 * halfFov * Math.max(1, dist)) / Game.CHARACTER_REFERENCE_HEIGHT_PX;
    return Game.CHARACTER_HEIGHT_M / Math.max(1e-4, worldPerPixel);
  }

  /** True when a figure at this distance is too small on screen to be worth its
   *  forty draw calls. */
  private characterTooSmallToDraw(dist: number): boolean {
    return this.characterPixels(dist) < Game.CHARACTER_MIN_PIXELS;
  }

  /**
   * ONE SPHERE TEST INSTEAD OF SIX HUNDRED — the group-level island cull.
   *
   * three's `projectObject` returns at the first `visible === false` and
   * otherwise walks every node under it, frustum-testing each drawable's own
   * bounding sphere. An island group holds 300-650 of them. Turning the GROUP
   * off when the island cannot be in frame replaces all of that with one test.
   *
   * WHAT IT IS ACTUALLY WORTH, measured rather than assumed. The cost model
   * sized this lever off "the scene graph holds 9,201-9,388 drawables and
   * projectObject walks all of them", which is a `scene.traverse()` — a count
   * that includes every node under a hidden detail root, proxy root and micro
   * tier, none of which three ever visits. The walk three really performs, on
   * the pinned map at high: 4,526 nodes at the dock vista, 4,079 in the cave,
   * 1,562 at sea. Of those, the islands WHOLLY outside the frustum account for
   * 1,095 (24%), 150 (3.7%) and 0. So this is a quarter of the traversal in a
   * wide vista and nothing at all at sea, not the 70-80% the model projected.
   * It is kept because twelve sphere tests a frame cannot cost that much.
   *
   * TWELVE TESTS, NOT A TREE. The lever was written up as "a spatial structure
   * so the common case is a handful of tests". There are ten to twelve islands.
   * A BVH over twelve boxes is the handful of tests, plus a tree to maintain.
   *
   * WHY THE CAMERA HAS TO BE THIS FRAME'S. Every other gate in the LOD pass is a
   * DISTANCE, and a distance is one frame stale by a metre or two. A frustum is
   * stale by however far the mouse moved, and on a machine at eight frames a
   * second that is most of a field of view — an island culled against last
   * frame's forward vector is a hole in this frame's picture. So this runs from
   * updateScene straight after updateCamera, never from updateEnvironmentLod.
   *
   * WHY IT CANNOT DROP A SHADOW. `visible === false` takes a subtree out of the
   * shadow walk exactly as it takes it out of the colour walk, so an island that
   * is off screen but casting INTO the screen would lose its shadow. The only
   * honest guard is the question the shadow pass itself asks: three culls
   * casters against the shadow camera, so an island outside THAT frustum is
   * already casting nothing and turning it off changes no pixel. So the test is
   * two frustums, not one, and the second one is the renderer's own — not a
   * round number standing in for it. A first cut used "never cull inside 500 m"
   * and it was both too weak (it kept a 217 m island that is 46 m behind the
   * shadow box's rear face) and unprovable. At 'low' there is no shadow pass at
   * all and the second test is skipped.
   *
   * The shadow camera's matrices are written during render(), so they are one
   * frame old here; the island sphere is padded by SHADOW_CULL_PAD to cover the
   * frame of camera motion between the two, which is metres.
   */
  private static readonly SHADOW_CULL_PAD = 40;

  private cullIslandGroups() {
    if (!this.state) return;
    const camera = this.renderer.camera;
    camera.updateMatrixWorld();
    this.cullMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.cullFrustum.setFromProjectionMatrix(this.cullMatrix);
    const shadowCamera = this.renderer.getShadowCullCamera();
    if (shadowCamera) {
      this.cullMatrix.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
      this.shadowCullFrustum.setFromProjectionMatrix(this.cullMatrix);
    }
    for (const island of this.state.islands) {
      const group = this.islandMeshes.get(island.id);
      if (!group) continue;
      const sphere = group.userData.cullSphere as { x: number; y: number; z: number; r: number } | undefined;
      if (!sphere) continue;
      this.cullSphere.center.set(sphere.x, sphere.y, sphere.z);
      this.cullSphere.radius = sphere.r;
      let keep = this.cullFrustum.intersectsSphere(this.cullSphere);
      if (!keep && shadowCamera) {
        this.cullSphere.radius = sphere.r + Game.SHADOW_CULL_PAD;
        keep = this.shadowCullFrustum.intersectsSphere(this.cullSphere);
      }
      group.visible = keep;
    }
  }

  private updateEnvironmentLod() {
    if (!this.state) return;

    // Release a slice of any reveal in flight and advance one warm chunk BEFORE
    // the LOD decisions below, so a mesh let out this frame is drawn against
    // this frame's tier visibility rather than last frame's.
    this.lodWarmer.setBoosted(this.isStartCeremonyActive() || this.getWorldBuildBacklog() > 0);
    this.lodWarmer.update();

    const quality = this.renderer.getQuality();
    const cam = this.renderer.camera.position;
    // Apparent distance, once for the whole pass: every instance-count rule
    // measures how big a thing LOOKS, and raising the spyglass is a player
    // asking for detail at range. See island/InstanceLod.
    const lodDistanceScale = apparentDistanceScale(this.renderer.camera.fov ?? 74);
    // Islands are THE landmark visuals: hold full detail out to AAA distances,
    // measured from the island EDGE (footprint radius), not its center — a
    // 200m-radius island's shoreline used to flip to proxy while you stood on it.
    // ── THE GOVERNOR'S DRESSING BIAS ────────────────────────────────────────
    // One multiplier, floored at 0.70 by the governor itself, on every radius
    // that decides how far away scenery keeps its detail. It is the cheapest
    // visual loss on the ladder because everything it touches lives at mid and
    // far distance by construction — and it is the reason there is an explicit
    // floor under the three radii below rather than a bare multiply.
    const levers = this.renderer.getFrameLevers();
    const dressing = levers.lodRadiusScale;
    const detailRadius = (quality === 'low' ? 420 : quality === 'balanced' ? 700 : 950) * dressing;
    const wildlifeRadius = (quality === 'low' ? 220 : quality === 'balanced' ? 360 : 520) * dressing;
    const seaRockRadius = (quality === 'low' ? 650 : quality === 'balanced' ? 900 : 1200) * dressing;
    // THE INTERACTION FLOOR. A chest, an upgrade station and an NPC are things
    // the player walks up to and uses, and a governor that culls one of them
    // because the machine is warm has not degraded the picture, it has broken
    // the game. 180 m is far outside any interaction range in this client and
    // outside the distance at which either reads as more than a silhouette, so
    // the clamp costs nothing and the failure it forbids is unrecoverable.
    const INTERACTABLE_FLOOR = 180;
    const lootRadius = Math.max(INTERACTABLE_FLOOR, (quality === 'low' ? 340 : quality === 'balanced' ? 520 : 760) * dressing);
    const upgradeRadius = Math.max(INTERACTABLE_FLOOR, (quality === 'low' ? 420 : quality === 'balanced' ? 620 : 820) * dressing);
    const npcRadius = Math.max(INTERACTABLE_FLOOR, (quality === 'low' ? 360 : quality === 'balanced' ? 560 : 760) * dressing);

    for (const island of this.state.islands) {
      const group = this.islandMeshes.get(island.id);
      if (!group) continue;
      const dist = dist2D(cam.x, cam.z, island.position.x, island.position.z);
      const detailRoot = group.userData.detailRoot as THREE.Object3D | undefined;
      const proxyRoot = group.userData.proxyRoot as THREE.Object3D | undefined;
      if (detailRoot && proxyRoot) {
        const edgeDist = dist - getIslandMaxRadius(island);
        const wasShown = this.islandDetailShown.get(island.id) ?? false;
        // Hysteresis: the band you must LEAVE is wider than the one you enter,
        // so hovering on the edge cannot flip the whole subtree back and forth.
        const showDetail = edgeDist < detailRadius * (wasShown ? Game.DETAIL_HYSTERESIS : 1);
        if (showDetail !== wasShown) {
          this.islandDetailShown.set(island.id, showDetail);
          if (showDetail) this.lodWarmer.beginReveal(island.id, detailRoot);
          else this.lodWarmer.cancelReveal(island.id);
        }
        // Approaching, still on the proxy: compile this island's materials now,
        // a chunk a frame, so the reveal has nothing left to link.
        if (!showDetail && edgeDist < detailRadius * Game.DETAIL_WARM_SCALE) {
          this.lodWarmer.requestWarm(island.id, detailRoot);
        }
        detailRoot.visible = showDetail;
        // The proxy comes down only once the detail tier actually has the
        // island's shape on screen. `beginReveal` hides the whole subtree and
        // the release pass does not run until the top of the next frame, so
        // dropping the proxy the instant `showDetail` turns true takes the
        // island OUT OF THE WORLD until the reveal reaches it — measured at
        // twenty seconds on a cold approach with three islands crossing
        // together, two of them showing nothing at all the whole time. Same
        // rule the hulls already follow: swap to detail only when detail is up.
        proxyRoot.visible = !showDetail || this.lodWarmer.revealSilhouettePending(island.id);
        // Micro decor (shells, rubble, clutter) only reads up close — culling
        // it past ~260m cuts hundreds of draw calls per distant island.
        const microRoot = group.userData.microRoot as THREE.Object3D | undefined;
        if (microRoot) microRoot.visible = showDetail && edgeDist < (quality === 'low' ? 180 : 260);
        const lodLayers = group.userData.lodLayers as { node: THREE.Object3D; radius: number }[] | undefined;
        if (lodLayers) {
          for (const layer of lodLayers) layer.node.visible = showDetail && edgeDist < layer.radius;
        }
        // THE TRIANGLE DIET. Everything above decides what is DRAWN; this
        // decides how much of it. An island held at full detail out to a
        // kilometre pays for every half-metre flower patch on it at full
        // geometry — 53% of the island triangles in a settled cave frame are
        // these batches — and the only lever the old gate had was to hide the
        // whole batch. Lowering the instance count instead keeps the hero palms
        // and drops the scrub, one integer per batch per frame, no re-upload.
        const instanceBatches = group.userData.instanceLodBatches as InstanceLodBatch[] | undefined;
        if (instanceBatches && showDetail) {
          // The density bias rides the APPARENT-DISTANCE scale rather than a new
          // parameter: InstanceLod already measures everything against it, and
          // shrinking it makes a far batch behave as if it were further away —
          // which drops the smallest instances first, in the order the batch was
          // sorted at build time. Below 1 it thins; it can never thin the island
          // you are standing on, whose edge distance is negative.
          updateInstanceLod(instanceBatches, edgeDist, quality, lodDistanceScale * levers.instanceDensityScale);
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
            const cd = dist2D(cam.x, cam.z, e.x, e.z);
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
            glow.light.visible = showDetail && dist2D(cam.x, cam.z, glow.x, glow.z) < 90;
          }
        }
      }

      for (const chest of island.chests) {
        const record = this.chestMeshes.get(chest.id);
        if (!record) continue;
        const chestDist = dist2D(cam.x, cam.z, chest.position.x, chest.position.z);
        const carriedByLocal = chest.carriedByPlayerId === this.localPlayerId;
        showWhenAffordable(record.root, chestDist < lootRadius && !chest.opened && !carriedByLocal);
        record.root.matrixWorldAutoUpdate = record.root.visible;
        const chestLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (chestLight) chestLight.visible = record.root.visible && chestDist < 55;
      }

      for (const barrel of island.barrels) {
        const root = this.barrelMeshes.get(barrel.id);
        if (!root) continue;
        const barrelDist = dist2D(cam.x, cam.z, barrel.position.x, barrel.position.z);
        showWhenAffordable(root, barrelDist < lootRadius && (!barrel.opened || barrel.loot.length > 0));
        root.matrixWorldAutoUpdate = root.visible;
      }

      for (const station of island.upgradeStations) {
        const record = this.upgradeStationMeshes.get(station.id);
        if (!record) continue;
        const stationDist = dist2D(cam.x, cam.z, station.position.x, station.position.z);
        showWhenAffordable(record.root, stationDist < upgradeRadius);
        record.root.matrixWorldAutoUpdate = record.root.visible;
        const stationLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (stationLight) stationLight.visible = record.root.visible && stationDist < 55;
      }

      for (const npc of island.npcs ?? []) {
        const record = this.npcMeshes.get(npc.id);
        if (!record) continue;
        const npcDist = dist2D(cam.x, cam.z, npc.position.x, npc.position.z);
        // Same forty-call figure as a player, and the same screen-size test —
        // the metre radius stays as the outer bound it always was.
        showWhenAffordable(record.root, npcDist < npcRadius && !this.characterTooSmallToDraw(npcDist));
        record.root.matrixWorldAutoUpdate = record.root.visible;
        const npcLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (npcLight) npcLight.visible = record.root.visible && npcDist < 55;
      }
    }

    for (const animal of this.state.wildlife ?? []) {
      const mesh = this.wildlifeMeshes.get(animal.id);
      if (!mesh) continue;
      const dist = dist2D(cam.x, cam.z, animal.position.x, animal.position.z);
      // health is server-only (dead animals never reach the wire) — default alive.
      showWhenAffordable(mesh, (animal.health ?? 1) > 0 && dist < (animal.type === 'gull' ? wildlifeRadius * 1.35 : wildlifeRadius));
      // A crab out of sight still has ~40 rigged nodes, and three refreshes the
      // world matrix of every one of them whether or not it is drawn. Culled
      // animals leave the walk; they rejoin it the frame they come back, before
      // the render that needs them.
      mesh.matrixWorldAutoUpdate = mesh.visible;
    }

    for (const rock of this.state.seaRocks ?? []) {
      const mesh = this.seaRockMeshes.get(rock.id);
      if (!mesh) continue;
      const dist = dist2D(cam.x, cam.z, rock.position.x, rock.position.z);
      showWhenAffordable(mesh, dist < seaRockRadius);
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
    const ship = player && this.state ? findMermaidReturnShip(this.state.ships, player) : null;
    if (!player || !ship) {
      this.mermaidAnchor = null;
      if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
      return;
    }
    if (
      !this.mermaidAnchor
      || this.mermaidAnchor.shipId !== ship.id
      || dist2D(player.position.x, player.position.z, this.mermaidAnchor.x, this.mermaidAnchor.z) > 62
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
    this.envFx.updateLanterns(nightFactor, this.renderer.camera.position, this.ocean.getTime());
    const snapshotAge = Math.min(0.22, (performance.now() - this.lastSnapshotAt) / 1000);
    // Berths the renderer may drop a boarding plank to. The gangway PHYSICS is
    // already server-side (getShipGangwayPlan / getGangwayFloorY); without this
    // the plank you walk on is invisible.
    this.shipRenderer.setDocks(this.state.islands.map((i) => i.dock).filter(Boolean) as IslandDock[]);
    this.spoilsRenderer.update(this.state.spoils, this.ocean.getTime());
    this.seaEvents.update(this.ocean.getTime(), this.renderer.camera.position, nightFactor);
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
    // Per-frame so the ring/halo track the shrink smoothly instead of stepping
    // only when snapshots arrive.
    this.updateStormRing();
    this.stormHalo.rotation.z = this.ocean.getTime() * 0.12;
    this.stormWeatherIntensity = this.envFx.computeStormWeatherIntensity();
    // (renderer storm weather is applied via updateWaterEnvironment below —
    // calling updateStormWeather here too did the same work twice per frame.
    // The sea's own tint is set once the rain level is known, further down.)
    // Storm SEA GEOMETRY (separate from the color tint above): the shader
    // mirrors getStormWaveIntensity, so waves genuinely rage inside the ring.
    // phase01 must match the shared formula: clamp(phase / 6, 0, 1) — phase is
    // 0-indexed over the 7 STORM_PHASES.
    if (this.debugStormDemo) {
      // Park a tiny full-power ring at the camera: locally we are deep outside
      // it, so the shared sea-state formula returns ~1 right here.
      const cam = this.renderer.camera.position;
      this.stormWeatherIntensity = 0.7;
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
    const effectScale = this.renderer.getRuntimeEffectScale();
    // …and the same lever, as an edge length, to the one system whose particle
    // cost is fill rather than count. It was reading nothing at all before this:
    // the governor owned a `particleScale` that the largest particle system in
    // the game never asked for.
    this.combatFx.setParticleFillScale(this.renderer.getParticleFillScale());
    // World-space rain runs every frame (cheap buffer update; the old canvas
    // overlay throttle is gone with the overlay).
    this.stormRainIntensity = this.debugStormDemo ? 0.9 : this.envFx.computeStormRainIntensity();
    // The sky over the rain is driven by the rain itself, not only by the storm's
    // weather level: a replicated squall reaching inboard of the ring runs the
    // weather number near 0.35, and 0.35 of the sky's storm response is still
    // open blue with white cumulus in it. ?stormdemo was the only path that ever
    // closed the cloud deck. Now every drop the client draws carries its sky.
    this.renderer.setOvercast(this.stormRainIntensity);
    // ONE WEATHER, NOT TWO. u_overcast closes the cloud deck off the rain the
    // client is drawing, but the sea, the fog and the scene lights were still
    // reading the storm's own weather level — ~0.35 where the squall reaches
    // inboard of the ring — so a black overcast sky with rain falling out of it
    // stood over a bright tropical noon sea, lit as if the cloud were not there.
    // The visual level is the greater of the two, and the rain's contribution
    // uses the same response the sky's own shader applies to u_overcast, so
    // whatever closes the deck takes the water and the light with it.
    this.stormVisualIntensity = Math.max(
      this.stormWeatherIntensity,
      THREE.MathUtils.smoothstep(this.stormRainIntensity, 0.03, 0.30) * 0.8,
    );
    this.ocean.setStormIntensity(this.stormVisualIntensity);
    this.envFx.updateStormRain3D(dt, this.stormRainIntensity);
    this.envFx.updateStormLightningFlash(dt);
    const stormW = this.stormWeatherIntensity;
    const haloMat = this.stormHalo.material as THREE.MeshBasicMaterial;
    haloMat.opacity = 0.08 + stormW * 0.16;
    // Feed the local vitals watch BEFORE the fx update consumes them: storm,
    // fire and drowning bill in fractions of a point per snapshot, and nothing
    // in the client was announcing that kind of damage at all.
    this.combatFx.watchLocalVitals(
      this.getLocalPlayer(),
      dt,
      this.renderer.camera.position,
      this.renderer.camera.quaternion,
    );
    this.combatFx.update(dt);
    this.envFx.updateHarvestDestruction(dt);
    this.syncKegs(dt);
    this.slowSceneTimer -= dt;
    if (this.slowSceneTimer <= 0) {
      this.updateUpgradeStations(Math.max(dt, 0.1));
      this.updateStoryNpcs(Math.max(dt, 0.1));
      // Story delivery rides the slow tick: a scene you walk into announces
      // itself within 100 ms, which is instant to a pirate and free to a GPU.
      this.buildStoryBeacons();
      this.updateVignetteDiscovery();
      this.slowSceneTimer = 0.1;
    }
    this.updateStoryBeacons(nightFactor);
    this.syncPlayers(dt);
    this.updateDroppedWeapons(dt);
    this.syncProjectiles(dt);
    this.updateCamera();
    // The camera is final for this frame; the group-level island cull is the one
    // gate that cannot read a stale one. See cullIslandGroups.
    this.cullIslandGroups();
    this.updateWaterEnvironment();
    this.updateOwnShipObjective();
    this.hud.updateCombatHud(dt);
    this.viewmodel.syncLocalViewWeapon();
    if (this.freeCam) {
      // A detached tour/dev camera is not "the pirate's eyes" — hide the
      // first-person weapon/hands/pocket viewmodels so audit shots are clean.
      this.viewmodel.localViewWeaponRoot.visible = false;
      this.viewmodel.localViewHandsRoot.visible = false;
      this.viewmodel.localViewPocketRoot.visible = false;
    }
    if (this.windWispTimer <= 0) {
      this.envFx.updateWindWisps();
      this.windWispTimer = effectScale < 0.55 ? 1 / 20 : effectScale < 0.85 ? 1 / 30 : 0;
    }
    this.envFx.updateLightning(dt);
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
    // Whatever of this frame's chart budget the drawing above left unspent goes
    // to the isles not yet rasterized — but only once the world has finished
    // streaming, so the chart never competes with the island builds for the
    // join frames. Two a frame either way; nothing here can burst.
    if (this.getWorldBuildBacklog() === 0) this.map.advanceChartBacklog();

    this.interactScanTimer -= dt;
    if (this.interactScanTimer <= 0) {
      this.refreshInteractIntentForNet();
      this.interactScanTimer = 1 / 30;
    }
  }

  /** Same look-based winner as the HUD; refreshed between input sends for prompt previews. */
  private refreshInteractIntentForNet() {
    this.lastInteractKind = this.interactions.resolveCurrentInteractKind();
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
    if (isLocal && !player.atHelm && !player.atCannon) {
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
          const nameplate = makeNameplateSprite(player.name);
          mesh.userData.nameplate = nameplate;
          mesh.add(nameplate);
        }
        this.playerMeshes.set(player.id, mesh);
        this.renderer.scene.add(mesh);
      } else if (!playerIsSkeleton) {
        applyPlayerTeamColor(mesh, playerTeamColor);
      }

      const isLocal = player.id === this.localPlayerId;
      // Nameplate: shown for living opponents within ~85m, hidden when downed/gone.
      const plate = mesh.userData.nameplate as THREE.Sprite | undefined;
      if (plate) {
        const ndist = dist2D(this.renderer.camera.position.x, this.renderer.camera.position.z, player.position.x, player.position.z);
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
      const isDead = player.state === 'eliminated' || player.state === 'respawning';
      const wasDead = lastState === 'eliminated' || lastState === 'respawning';
      if (isSkeleton && !wasDead && isDead) {
        mesh.userData.deathTimer = 0;
        mesh.userData.deathSpin = Math.random() > 0.5 ? 1 : -1;
      }
      // ── Pirate death: keep the body in the world and CRUMPLE it. The mesh
      // used to vanish the same frame the server flipped the state; now a
      // corpse record pins it where it fell, plays a staged collapse and fades
      // out ~8s later (see PlayerAnimator.animateCorpse).
      if (!isSkeleton) {
        const corpse = mesh.userData.corpse as CorpseState | undefined;
        if (isDead && !corpse) {
          this.beginPirateDeath(mesh, player, isLocal);
        } else if (!isDead && corpse) {
          this.clearPirateDeath(mesh);
        }
      }
      mesh.userData.lastState = player.state;
      if (isSkeleton && isDead) {
        mesh.userData.deathTimer = Math.min((mesh.userData.deathTimer ?? 0) + dt, SKELETON_CORPSE_LIFETIME);
      }
      this.updatePlayerFlinch(mesh, player, isLocal);
      // Station work signal the animator reads: a decaying cannon-recoil kick.
      mesh.userData.cannonRecoil = Math.max(0, (mesh.userData.cannonRecoil ?? 0) - dt * 3.4);

      // Skeleton remains linger and sink/fade instead of popping out of
      // existence 1.5s after the (good) bone-scatter kill.
      const skeletonDeathTime = (mesh.userData.deathTimer ?? 0) as number;
      const skeletonDeathVisible = isSkeleton && isDead && skeletonDeathTime < SKELETON_CORPSE_LIFETIME;
      const corpseState = mesh.userData.corpse as CorpseState | undefined;
      const pirateCorpseVisible = !!corpseState && corpseState.t < CORPSE_LIFETIME;
      mesh.visible = !isLocal && !useLocalSwimViewmodel
        && (skeletonDeathVisible || pirateCorpseVisible || !isDead)
        // …and not when he is under two and a half pixels tall — ~545 m at the
        // walking field of view. See characterTooSmallToDraw: forty draw calls
        // for a figure the view cannot resolve, and the spyglass gets every one
        // of them back by narrowing the field.
        && !this.characterTooSmallToDraw(dist2D(
          this.renderer.camera.position.x, this.renderer.camera.position.z,
          targetPos.x, targetPos.z,
        ));
      if (skeletonDeathVisible) {
        this.applyCorpseFade(mesh, skeletonDeathTime, SKELETON_CORPSE_LIFETIME - 1.6, SKELETON_CORPSE_LIFETIME);
      } else if (pirateCorpseVisible) {
        this.applyCorpseFade(mesh, corpseState!.t, CORPSE_FADE_START, CORPSE_LIFETIME);
      }
      if (!mesh.userData.initialized) {
        mesh.position.copy(targetPos);
        mesh.rotation.y = targetYaw;
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
        mesh.userData.initialized = true;
      } else if (corpseState) {
        // A corpse never slides toward the server's respawn position — the
        // animator owns its transform from the frame it dropped. Bodies that
        // fell on a deck ride the hull.
        if (corpseState.shipId) {
          const corpseShip = this.shipsById.get(corpseState.shipId);
          if (corpseShip) {
            corpseState.basePos.copy(this.getShipWorldPoint(
              corpseShip,
              corpseState.shipLocalX ?? 0,
              corpseState.shipLocalZ ?? 0,
              corpseState.shipLocalY ?? 0,
            ));
            corpseState.baseYaw = (corpseState.shipYaw ?? 0) + corpseShip.rotation;
          }
        }
        this.anim.animateCorpse(mesh, corpseState, dt);
        this.viewmodel.syncHeldWeapon(mesh, player);
        continue;
      } else {
        if (player.state === 'swimming') {
          // The prone swim pose extends the body FORWARD of its foot pivot —
          // pull the pivot back along the facing so the torso still sits over
          // the tracked position instead of a body-length ahead of it.
          targetPos.x -= Math.sin(targetYaw) * 0.62;
          targetPos.z -= Math.cos(targetYaw) * 0.62;
        }
        if (mesh.position.distanceToSquared(targetPos) > (isLocal ? 20 * 20 : 34 * 34)) {
          mesh.position.copy(targetPos);
        } else {
          mesh.position.lerp(targetPos, positionAlpha);
        }
        mesh.rotation.y += angleWrap(targetYaw - mesh.rotation.y) * (isLocal ? 1 : rotationAlpha);
      }

      // Downed pirates read prone at a glance: face-DOWN on the deck (not
      // tipped on their side playing the standing walk cycle) and sunk to
      // ground level, with the crawl handled by animatePlayerMesh.
      const downedLean = mesh.userData.downedLean as number | undefined ?? 0;
      const downedTarget = player.state === 'downed' ? 1 : 0;
      const nextLean = downedLean + (downedTarget - downedLean) * Math.min(1, dt * 4);
      mesh.userData.downedLean = nextLean;
      if (nextLean > 0.002) mesh.position.y -= 0.14 * nextLean;

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

      const animParts = (mesh.userData.animation?.parts ?? {}) as Record<string, THREE.Object3D | undefined>;
      const head = animParts.head;
      const hair = animParts.hair;
      const bandana = animParts.bandana;
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
        // PRONE swimmer: +rotation.x pitches the body face-DOWN with the head
        // leading, which is what a front crawl looks like. The old negative
        // pitch laid the pirate on his back, floating feet-first like a corpse.
        const swimBodyPitch = THREE.MathUtils.clamp(Math.PI * 0.4 - player.rotation.y * 0.45, 0.75, 1.5);
        mesh.rotation.x += (swimBodyPitch - mesh.rotation.x) * Math.min(1, dt * 10);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      } else if (skeletonDeathVisible) {
        const deathSpin = mesh.userData.deathSpin ?? 1;
        mesh.rotation.x += (-0.95 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (deathSpin * 0.85 - mesh.rotation.z) * Math.min(1, dt * 10);
        // Sink for the first second and a half only, then the pile rests.
        if (skeletonDeathTime < 1.5) mesh.position.y -= dt * 0.3;
      } else if (nextLean > 0.002) {
        // Downed: rolled face-down, with a faint pained sway.
        const proneTarget = Math.PI * 0.46 * nextLean;
        mesh.rotation.x += (proneTarget - mesh.rotation.x) * Math.min(1, dt * 8);
        mesh.rotation.z = Math.sin(this.ocean.getTime() * 1.7) * 0.06 * nextLean;
      } else {
        mesh.rotation.x += (0 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      }

      if (skeletonDeathVisible) {
        this.anim.animateSkeletonDeath(mesh);
      } else {
        this.anim.animatePlayerMesh(mesh, player, ship, dt);
      }
      this.viewmodel.syncHeldWeapon(mesh, player);
    }
  }

  /**
   * Death edge for a (non-skeleton) pirate: pin the body where it fell, pick a
   * crumple flavour from what we know about the kill, fling the held weapon out
   * of the dead hand, and — if this was YOU — start the death camera.
   */
  private beginPirateDeath(mesh: THREE.Group, player: Player, isLocal: boolean) {
    const cause = this.resolveDeathCause(player);
    const side = Math.random() > 0.5 ? 1 : -1;
    const corpse: CorpseState = {
      t: 0,
      cause,
      side,
      spin: cause === 'cutlass' ? side * (1.1 + Math.random() * 0.6) : (Math.random() - 0.5) * 0.4,
      basePos: mesh.position.clone(),
      baseYaw: mesh.rotation.y,
      weaponDropped: false,
    };
    // Dying aboard a ship anchors the corpse to the HULL, not to a world point:
    // an 8s corpse on a sailing deck would otherwise be left behind in mid-air.
    const deathShip = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    if (deathShip) {
      const local = toShipLocalPoint(mesh.position, deathShip);
      corpse.shipId = deathShip.id;
      corpse.shipLocalX = local.x;
      corpse.shipLocalZ = local.z;
      corpse.shipLocalY = mesh.position.y - deathShip.position.y;
      corpse.shipYaw = mesh.rotation.y - deathShip.rotation;
    }
    mesh.userData.corpse = corpse;
    mesh.userData.flinch = undefined;
    // A corpse carries no floating UI.
    const healthBar = mesh.userData.healthBar as { root: THREE.Group } | undefined;
    if (healthBar) healthBar.root.visible = false;
    const plate = mesh.userData.nameplate as THREE.Sprite | undefined;
    if (plate) plate.visible = false;
    this.dropHeldWeapon(mesh, corpse);
    if (isLocal) {
      this.localDeathAnchor = {
        pos: mesh.position.clone(),
        cause,
        tilt: side * (0.42 + Math.random() * 0.2),
      };
      this.localDeathBlend = 0;
      this.audio.playDeathSting();
    }
  }

  /** Respawn / revive: wipe the corpse record and restore the body's materials. */
  private clearPirateDeath(mesh: THREE.Group) {
    mesh.userData.corpse = undefined;
    mesh.userData.initialized = false;
    mesh.rotation.set(0, mesh.rotation.y, 0);
    this.setMeshOpacity(mesh, 1);
  }

  /**
   * Infer what killed a pirate from the last snapshot we have of them plus the
   * kill_event that just landed. No new protocol: headshots come from the
   * event, blades from the killer's active weapon, blasts from the knockback
   * they are carrying, drowning/falls from their own motion.
   */
  private resolveDeathCause(player: Player): DeathCause {
    const hint = this.deathCauseHints.get(player.id);
    this.deathCauseHints.delete(player.id);
    if (hint?.headshot) return 'headshot';
    if (player.state === 'swimming' || this.prevPlayerStateById.get(player.id) === 'swimming') return 'drown';
    const knockback = Math.hypot(
      player.knockbackVelocity?.x ?? 0,
      player.knockbackVelocity?.y ?? 0,
      player.knockbackVelocity?.z ?? 0,
    );
    if (knockback > 5.5) return 'explosion';
    if (hint?.killerId) {
      const killer = this.playersById.get(hint.killerId);
      const killerWeapon = killer?.weapons[killer.activeSlot]?.weaponId;
      if (killerWeapon === 'cutlass') return 'cutlass';
      if (killerWeapon) return 'shot';
    }
    if ((this.prevPlayerFallSpeed.get(player.id) ?? 0) > 11) return 'fall';
    return hint ? 'shot' : 'generic';
  }

  /** Fling the dead pirate's weapon out of their hand and let it tumble away. */
  private dropHeldWeapon(mesh: THREE.Group, corpse: CorpseState) {
    if (corpse.weaponDropped) return;
    corpse.weaponDropped = true;
    const hand = (mesh.userData.animation?.parts as Record<string, THREE.Object3D | undefined> | undefined)?.rightHand;
    const weapon = hand?.getObjectByName('held-weapon') as THREE.Group | null;
    if (!weapon) return;
    weapon.getWorldPosition(this.tempRenderPos);
    const worldQuat = new THREE.Quaternion();
    weapon.getWorldQuaternion(worldQuat);
    weapon.removeFromParent();
    weapon.position.copy(this.tempRenderPos);
    weapon.quaternion.copy(worldQuat);
    weapon.scale.setScalar(1);
    this.renderer.scene.add(weapon);
    const angle = Math.random() * Math.PI * 2;
    this.droppedWeapons.push({
      mesh: weapon,
      velocity: new THREE.Vector3(Math.cos(angle) * 1.6, 1.4, Math.sin(angle) * 1.6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
      age: 0,
      restY: this.tempRenderPos.y - 1.0,
    });
  }

  /** Ballistic tumble → rest → fade for weapons knocked out of dead hands. */
  private updateDroppedWeapons(dt: number) {
    for (let index = this.droppedWeapons.length - 1; index >= 0; index--) {
      const drop = this.droppedWeapons[index];
      drop.age += dt;
      if (drop.age >= DROPPED_WEAPON_LIFETIME) {
        this.renderer.scene.remove(drop.mesh);
        this.disposeSceneObject(drop.mesh);
        this.droppedWeapons.splice(index, 1);
        continue;
      }
      if (drop.mesh.position.y > drop.restY) {
        drop.velocity.y -= 16 * dt;
        drop.mesh.position.addScaledVector(drop.velocity, dt);
        drop.mesh.rotation.x += drop.spin.x * dt;
        drop.mesh.rotation.y += drop.spin.y * dt;
        drop.mesh.rotation.z += drop.spin.z * dt;
        if (drop.mesh.position.y <= drop.restY) {
          // Landed: flop flat and stop.
          drop.mesh.position.y = drop.restY;
          drop.mesh.rotation.set(Math.PI * 0.5, drop.mesh.rotation.y, 0);
          drop.spin.set(0, 0, 0);
          drop.velocity.set(0, 0, 0);
        }
      }
      const fadeStart = DROPPED_WEAPON_LIFETIME - 1.4;
      if (drop.age > fadeStart) {
        this.setMeshOpacity(drop.mesh, 1 - (drop.age - fadeStart) / 1.4);
      }
    }
  }

  /** Corpse dissolve: sink a touch, then fade the whole body out. */
  private applyCorpseFade(mesh: THREE.Group, age: number, fadeStart: number, lifetime: number) {
    if (age <= fadeStart) {
      if (mesh.userData.corpseFaded) {
        this.setMeshOpacity(mesh, 1);
        mesh.userData.corpseFaded = false;
      }
      return;
    }
    const k = THREE.MathUtils.clamp((age - fadeStart) / Math.max(0.001, lifetime - fadeStart), 0, 1);
    mesh.userData.corpseFaded = true;
    mesh.position.y -= k * k * 0.004;
    this.setMeshOpacity(mesh, 1 - k);
  }

  /** Player meshes own their materials (makePlayerMesh builds a fresh set per
   *  avatar), so fading one body never touches another's. */
  private setMeshOpacity(root: THREE.Object3D, opacity: number) {
    const clamped = THREE.MathUtils.clamp(opacity, 0, 1);
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (clamped >= 1 && !material.transparent) continue;
        material.transparent = clamped < 1;
        material.opacity = clamped;
        material.depthWrite = clamped > 0.85;
      }
    });
  }

  /**
   * Seed a directional flinch whenever a pirate loses health, so bodies react
   * to being shot instead of only their health bar moving. Also tracks the
   * per-player fall speed used to classify fall deaths.
   */
  private updatePlayerFlinch(mesh: THREE.Group, player: Player, isLocal: boolean) {
    const prevHealth = this.prevPlayerHealth.get(player.id);
    this.prevPlayerHealth.set(player.id, player.health);
    this.prevPlayerStateById.set(player.id, player.state);
    const fall = Math.max(0, -(player.velocity.y ?? 0));
    this.prevPlayerFallSpeed.set(
      player.id,
      fall > 1 ? fall : (this.prevPlayerFallSpeed.get(player.id) ?? 0) * 0.9,
    );
    if (prevHealth === undefined) return;
    const drop = prevHealth - player.health;
    if (drop < 5 || player.state === 'eliminated' || player.state === 'respawning') return;
    mesh.userData.flinch = {
      t: 0,
      mag: THREE.MathUtils.clamp(drop / 40, 0.3, 1),
      yaw: (Math.random() - 0.5) * 0.8,
    };
    if (isLocal) {
      this.cameraShake = Math.min(1, this.cameraShake + THREE.MathUtils.clamp(drop / 90, 0.05, 0.3));
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
            const d = dist2D(
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
        // The gunner who pulled the lanyard flinches with the piece.
        if (projectile.ownerId && projectile.type !== 'bullet') {
          const gunnerMesh = this.playerMeshes.get(projectile.ownerId);
          if (gunnerMesh) gunnerMesh.userData.cannonRecoil = 1;
        }
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
          const d = dist2D(
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
        registerBudgetLight(fuse);
        root.add(fuse);
        root.scale.setScalar(mega ? 1.55 : 1);

        this.renderer.scene.add(root);
        mesh = { root, fuse, nextFuseHissAt: 0 };
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

      // A lit fuse is a ten-second warning, and it was SILENT: the only tell was
      // a point light you had to be looking at. Re-arm the hiss in short bursts
      // from the keg's CURRENT position rather than firing one long sample at
      // the spot it was planted — a keg rides a turning deck, and the panic is
      // in knowing which way to run.
      const nowMs = performance.now();
      if (nowMs >= mesh.nextFuseHissAt) {
        const cam = this.renderer.camera.position;
        const pos = mesh.root.position;
        const d = Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
        const burst = Math.min(KEG_FUSE_HISS_BURST, keg.timer);
        if (burst > 0.2) this.audio.playKegFuse(burst, d, { x: pos.x, y: pos.y, z: pos.z });
        mesh.nextFuseHissAt = nowMs + burst * 1000;
      }
    }
  }

  /** Give meshes to chests/barrels that joined an island AFTER it was built.
   *
   *  Every other loot entity in the world is born with its island, so the island
   *  builder is the only thing that ever makes a chest mesh. The Gilded Wreck's
   *  cargo is filed on an island mid-match (which is exactly what buys it every
   *  existing loot path for free), so this is the one place that has to catch
   *  up. Idempotent: anything already drawn is skipped. */
  /** The Gilded Wreck rose, or the storm took her back. One feed line, one bell
   *  toll — a bell because it has to carry over weather and gunfire and mean
   *  "look at the chart" without a word of UI — and, under it, the score's own
   *  two-bar figure for a grave with gold in it. */
  private announceWreckEvent(payload: { phase: 'risen' | 'claimed'; position: { x: number; y: number; z: number }; duration: number }) {
    if (payload.phase === 'claimed') {
      this.pushFeed('The sea closes over the Gilded Wreck.', '#9aa7b8');
      return;
    }
    const minutes = Math.max(1, Math.round(payload.duration / 60));
    this.pushFeed(
      `THE GILDED WRECK rises at the next ring — gold aboard, ${minutes > 1 ? `${minutes} minutes` : 'one phase'} before the storm claims her.`,
      '#f0c257',
    );
    const camera = this.renderer.camera.position;
    const distance = Math.hypot(camera.x - payload.position.x, camera.z - payload.position.z);
    this.audio.playWreckBell(distance);
    // The bell says WHERE; the sting says WHAT. It was written for exactly this
    // moment and then never fired, so the bounty cry was the only event in the
    // match the score ever answered.
    this.audio.playEventSting('wreck');
  }

  private buildLateLootMeshes(islandId: string, chestIds: string[], barrelIds: string[]) {
    const island = this.state?.islands.find((candidate) => candidate.id === islandId);
    if (!island) return;

    for (const chestId of chestIds) {
      if (this.chestMeshes.has(chestId)) continue;
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (!chest) continue;
      const root = new THREE.Group();
      root.position.set(chest.position.x, chest.position.y, chest.position.z);
      const yaw = (chest.position.x * 7.13 + chest.position.z * 3.71) % (Math.PI * 2);
      const glb = assets.clone('chest_closed');
      let body: THREE.Object3D;
      if (glb) {
        glb.position.set(0, -0.42, 0);
        glb.rotation.y = yaw;
        glb.scale.setScalar(1.15);
        root.add(glb);
        body = glb;
      } else {
        body = new THREE.Mesh(
          new THREE.BoxGeometry(1.1, 0.7, 0.75),
          new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 }),
        );
        root.add(body);
      }
      const glow = new THREE.PointLight(0xffc75a, 1.2, 12);
      glow.position.set(0, 1.2, 0);
      glow.visible = false;
      root.userData.decorLight = glow;
      registerBudgetLight(glow);
      root.add(glow);
      this.environment.add(root);
      this.chestMeshes.set(chest.id, { root, glow, chestMesh: body, lid: new THREE.Group(), mound: null });
    }

    for (const barrelId of barrelIds) {
      if (this.barrelMeshes.has(barrelId)) continue;
      const barrel = island.barrels.find((candidate) => candidate.id === barrelId);
      if (!barrel) continue;
      const root = new THREE.Group();
      root.position.set(barrel.position.x, barrel.position.y, barrel.position.z);
      const glb = assets.clone('barrel');
      if (glb) {
        glb.rotation.y = (barrel.position.x * 5.31 + barrel.position.z * 2.17) % (Math.PI * 2);
        glb.scale.setScalar(0.88);
        root.add(glb);
      } else {
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(0.4, 0.4, 0.72, 10),
          new THREE.MeshStandardMaterial({ color: 0x4a3010, roughness: 0.95 }),
        );
        body.position.y = 0.36;
        root.add(body);
      }
      this.environment.add(root);
      this.barrelMeshes.set(barrel.id, root);
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
          // The dig tell turns and twinkles — a still gold speck on sand reads
          // as a prop, a moving one reads as an invitation. Skipped entirely
          // once the mound is gone, so a dug site advertises nothing.
          const sparkle = chestMesh.mound.userData.digSparkle as THREE.Points | undefined;
          if (sparkle && chestMesh.mound.visible) {
            const phase = this.ocean.getTime() * 0.9 + chest.position.x * 0.13;
            sparkle.rotation.y = phase * 0.5;
            const mat = sparkle.material as THREE.PointsMaterial;
            mat.opacity = 0.62 + 0.34 * (0.5 + 0.5 * Math.sin(phase * 2.3));
          }
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
      if ((animal.health ?? 1) <= 0) continue;
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
      // Gate the gait on ACTUAL movement. Riding the global clock made standing
      // chickens flap at 11Hz and idle pigs march on the spot; a grounded gull
      // is not a hovering one. Derived from the position delta because the
      // wildlife snapshot carries no velocity.
      const prevPos = mesh.userData.prevPos as { x: number; z: number } | undefined;
      const stepped = prevPos
        ? Math.hypot(animal.position.x - prevPos.x, animal.position.z - prevPos.z) / Math.max(dt, 0.001)
        : 0;
      mesh.userData.prevPos = { x: animal.position.x, z: animal.position.z };
      const speedEma = ((mesh.userData.speedEma as number | undefined) ?? 0) * 0.82 + stepped * 0.18;
      mesh.userData.speedEma = speedEma;
      // A gull on the wing keeps full wingbeat; a grounded one tucks and pecks.
      const flying = animal.type === 'gull' && speedEma > 0.35;
      const move01 = flying ? 1 : THREE.MathUtils.clamp(speedEma / 1.2, 0, 1);
      const phase = t * (animal.type === 'gull' ? 9.5 : animal.type === 'chicken' ? 11 : animal.type === 'crab' ? 14 : 6.5)
        + animal.position.x * 0.04
        + animal.position.z * 0.03;
      // Idle animals get characterful ticks instead: a peck / snout-root / claw
      // raise on a per-animal random timer, so standing still still reads alive.
      const idleSeed = (mesh.userData.idleSeed as number | undefined)
        ?? (mesh.userData.idleSeed = 2 + Math.random() * 3);
      const idleCycle = (t + idleSeed * 7) % (2.6 + idleSeed);
      const tick = idleCycle < 0.42 ? Math.sin((idleCycle / 0.42) * Math.PI) * (1 - move01) : 0;
      if (parts?.leftWing) parts.leftWing.rotation.z = 0.35 + Math.sin(phase) * 0.55 * move01 - tick * 0.3;
      if (parts?.rightWing) parts.rightWing.rotation.z = -0.35 - Math.sin(phase) * 0.55 * move01 + tick * 0.3;
      if (parts?.head) {
        parts.head.rotation.y = Math.sin(phase * 0.55) * 0.22 * move01;
        // Peck / root at the ground while idle.
        parts.head.rotation.x = tick * (animal.type === 'chicken' ? 0.7 : 0.4);
      }
      if (parts?.body) parts.body.rotation.z = Math.sin(phase) * (animal.type === 'crab' ? 0.035 : 0.02) * move01;
      for (let leg = 0; leg < 6; leg++) {
        const limb = parts?.[`leg${leg}`];
        if (limb) limb.rotation.z = (leg % 2 === 0 ? 1 : -1) * (0.18 + Math.sin(phase + leg) * 0.16 * move01);
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

        // Walking away and coming back re-arms the speaker: the FIRST meeting
        // is this island's lore, later ones rotate the role's teaching lines.
        if (distance > 14 && this.npcInRange.has(npc.id)) this.npcInRange.delete(npc.id);
        if (
          distance < 7.2
          && !this.npcInRange.has(npc.id)
          && this.storyCutsceneNpcId !== npc.id
        ) {
          this.npcInRange.add(npc.id);
          this.triggerStoryCutscene(npc, island);
        }
      }
    }
  }

  private triggerStoryCutscene(npc: IslandNpc, island: Island) {
    if (!this.storyCutscene) return;
    this.seenStoryNpcIds.add(npc.id);
    // Rotation 0 is the island's own story (authored per island, server-side);
    // after that the speaker falls back to the tips their role is here to
    // teach, so the tutorial survives without every isle reciting it first.
    const talks = this.npcTalkCount.get(npc.id) ?? 0;
    const tips = NPC_ROLE_TIPS[npc.role] ?? [];
    const spoken = talks === 0 || tips.length === 0
      ? npc.line
      : tips[Math.min(talks, tips.length) - 1];
    this.npcTalkCount.set(npc.id, talks + 1);
    this.storyCutsceneNpcId = npc.id;
    this.storyCutsceneHideAt = performance.now() + 6200;
    this.storyCutscene.title.textContent = npc.cutsceneTitle;
    this.storyCutscene.name.textContent = `${npc.name} - ${island.name}`;
    this.storyCutscene.line.textContent = spoken;
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

  /**
   * MEASUREMENT HOOK — bring the world's LOD to the state it would REACH, now.
   *
   * Two mechanisms decide what is visible over a run of frames rather than on
   * one: the shared first-draw allowance and the island detail reveal. Both are
   * paced per FRAME, which means "how much of the world is up" after any fixed
   * wall-clock wait is a fact about the machine's frame rate. On the software
   * rasteriser this repo is limited to, one frame is two to seven seconds, so a
   * probe that waits and then counts is grading an unfinished arrival: measured,
   * the dock vista read 687 draws against the 2206 the same view costs settled.
   *
   * A budget must grade the view, not the arrival. So a probe calls this after
   * placing its camera: run the LOD pass with the allowance open and the reveal
   * flushed, twice, so an island revealed by the first pass has its micro tier
   * and foliage layers graded by the second. Nothing here changes a radius or a
   * visibility RULE — it only stops the pacing from standing in for one.
   *
   * The pacing itself is still under test where it belongs (the first-draw
   * allowance in test-first-draw-budget, the reveal in test-island-reveal); this
   * is reachable only through the debug object and is never called by the loop.
   */
  settleLod(passes = 2) {
    // The LOD gates read the CAMERA, and a free-cam placement does not reach the
    // camera until the next frame's updateCamera — so settling straight after
    // enableFreeCam would settle the view the probe just left.
    this.updateCamera();
    this.cullIslandGroups();
    for (let i = 0; i < passes; i++) {
      openFirstDrawBudgetForSettle();
      this.updateEnvironmentLod();
      this.lodWarmer.flushReveals();
    }
    // Leave the allowance the way the game loop expects to find it.
    beginFirstDrawFrame();
    // AND DROP THE LOAD GUARD. "Settled" means the load is over — that is the
    // whole claim this hook makes — and while the guard is up ProgramWarmer
    // holds every material it has not paid for OUT of the frame. Measured right
    // after a settle on the software rasteriser: three consecutive frames at 70
    // draws / 221k triangles with 1,311 materials held, then 2,332 draws the
    // instant it dropped. A rig that settles the world and then counts a guarded
    // frame is counting the guard.
    this.loadGuardUntil = 0;
    this.renderer.setLoadGuard(false);
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

  /** Dev hook (honoured solo): set your banked gold, so the hold-cargo loop can
   *  be flown live — the crate stack below decks, the ballast in the knots, the
   *  bounty on the chart, the spill when she founders. */
  grantGold(gold: number) {
    this.network.sendDevGrantGold(gold);
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
    const activeWeapon = player.atCannon || player.atHelm ? null : player.weapons[player.activeSlot];
    const swimming = player.state === 'swimming';
    // Spectating (eliminated, not respawning): drive the lift blend + its slow
    // orbit here, before the framing below reads them.
    // A RESPAWN HOLD IS A WAIT, NOT A BLINDFOLD.
    // The lift used to fire only on elimination, so a held respawn kept the
    // 34 cm corpse eye — which underwater is the grey noise-void the audit
    // photographed while it read "Respawn held". The hold is short and honest
    // now; it should also be watchable, so it gets the same climb.
    const spectating = player.state === 'eliminated' || player.state === 'respawning';
    // Your standing is the number of crews that outlasted you, plus you. Read it
    // ONCE, at the instant of elimination: a second later the fleet has thinned
    // and "Place: #6 of 10" would keep quietly improving while you watched.
    if (player.state === 'eliminated' && !this.spectatePlacement && this.state) {
      // Count CREWS, not hulls. The first cut of this read `state.shipsAlive`,
      // which counts SHIPS — with every hull still afloat in a ten-crew match
      // it printed "Place: #10 of 11", a standing out of a fleet that does not
      // exist. Both numbers come off the same list now, so `of` is the fleet
      // and `place` can never leave it.
      const fleet = this.state.players.filter((p) => !this.isSkeletonName(p));
      const of = Math.max(1, fleet.length);
      const outlasted = fleet.filter((p) => p.id !== player.id && p.state !== 'eliminated').length;
      this.spectatePlacement = { place: THREE.MathUtils.clamp(outlasted + 1, 1, of), of };
    }
    this.spectateLift = THREE.MathUtils.clamp(
      this.spectateLift
        + this.frameDt * (spectating ? 1 / Game.SPECTATE_RISE_SECONDS : -1 / 0.4),
      0, 1,
    );
    this.spectateOrbit = this.spectateLift > 0.001 ? this.spectateOrbit + this.frameDt * 0.05 : 0;
    this.updateSpectateLight();
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
      const aim = getConstrainedCannonAim(trackedShip, player.cannonIndex, this.input.getYaw(), this.input.getPitch());
      const forward = new THREE.Vector3(
        Math.sin(aim.yaw) * Math.cos(aim.pitch),
        Math.sin(aim.pitch),
        Math.cos(aim.yaw) * Math.cos(aim.pitch),
      ).normalize();
      const cannonWorld = this.shipRenderer.getCannonWorldPos(trackedShip.id, player.cannonIndex)
        ?? this.getShipWorldPoint(
          trackedShip,
          getCannonSide(SHIP_STATS[trackedShip.type], player.cannonIndex) * (SHIP_STATS[trackedShip.type].width * 0.52),
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
    } else {
      const yaw = player.atHelm && trackedShip ? trackedShip.rotation : this.input.getYaw();
      const pitch = this.input.getPitch();
      const forward = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).normalize();
      // ── Eye height. A downed pirate's eyes are 30cm off the deck, and a dead
      // one's stay at the spot they fell instead of standing bolt upright while
      // a respawn chip counts down.
      const dead = player.state === 'respawning' || player.state === 'eliminated';
      const downed = player.state === 'downed';
      let eyeHeight = swimming
        ? PLAYER.HEIGHT * 0.56
        : player.crouching ? PLAYER.HEIGHT * 0.55 : PLAYER.HEIGHT * 0.84;
      if (downed) {
        eyeHeight = THREE.MathUtils.lerp(eyeHeight, 0.3, this.localDeathBlend)
          + Math.sin(this.ocean.getTime() * 0.9) * 0.02 * this.localDeathBlend;
      } else if (dead) {
        eyeHeight = THREE.MathUtils.lerp(PLAYER.HEIGHT * 0.84, 0.34, this.localDeathBlend);
      }
      const basePos = dead && this.localDeathAnchor
        ? this.localDeathAnchor.pos.clone()
        : this.getPlayerRenderPosition(player, 0.02);
      const eyePos = basePos.add(new THREE.Vector3(0, eyeHeight, 0));
      desired = eyePos;
      lookTarget = eyePos
        .clone()
        .addScaledVector(forward, scopedFov ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14)
        .add(new THREE.Vector3(0, swimming ? -0.04 : scopedFov ? 0.05 : 0, 0));
      // ── SPECTATE LIFT ──────────────────────────────────────────────────────
      // Eliminated, the eye stayed 34 cm above the spot you fell — which for
      // three deaths out of four is UNDER the swell, and the death screen was a
      // near-black void: no wreck, no storm, no island, nothing to read. Once
      // you are out of the match the camera climbs out of the water and swings
      // back off your body, so the last thing you see is the scene that got you.
      if (this.spectateLift > 0.001) {
        const body = this.localDeathAnchor?.pos ?? this.getPlayerRenderPosition(player, 0.02);
        // ── HANDOFF ─────────────────────────────────────────────────────────
        // Only for the ELIMINATED: a respawning pirate is coming back to this
        // spot and wants to see it, not somebody else's broadside.
        const subject = player.state === 'eliminated' ? this.updateSpectateSubject() : null;
        this.spectateHandoff = THREE.MathUtils.clamp(
          this.spectateHandoff
            + this.frameDt * (subject ? 1 / Game.SPECTATE_HANDOFF_SECONDS : -1 / 0.8),
          0, 1,
        );
        // Ease in AFTER the body lift has finished, so the two moves read as one
        // continuous flight: out of the water, then away across it.
        const hRaw = this.spectateHandoff * Math.min(1, this.spectateLift * 1.15);
        const h = hRaw * hRaw * (3 - 2 * hRaw);
        const anchor = subject ? body.clone().lerp(subject, h) : body;
        const seaY = gerstnerHeight(
          anchor.x, anchor.z, this.ocean.getTime(), WAVE_PARAMS,
          getStormWaveIntensity(this.state?.storm, anchor.x, anchor.z),
        );
        // Drift the view slowly around the body so the frame is alive; the
        // mouse still steers it (getYaw) for anyone who wants to look.
        const orbitYaw = this.input.getYaw() + this.spectateOrbit;
        const back = new THREE.Vector3(-Math.sin(orbitYaw), 0, -Math.cos(orbitYaw));
        const radius = THREE.MathUtils.lerp(Game.SPECTATE_RADIUS, Game.SPECTATE_SUBJECT_RADIUS, h);
        const height = THREE.MathUtils.lerp(Game.SPECTATE_HEIGHT, Game.SPECTATE_SUBJECT_HEIGHT, h);
        const lifted = anchor.clone()
          .addScaledVector(back, radius)
          .add(new THREE.Vector3(0, height, 0));
        // Never below the swell (or the ground it is standing on) — clearing the
        // waterline is the whole point.
        const floor = Math.max(seaY, this.sampleGroundY(lifted.x, lifted.z)) + Game.SPECTATE_CLEARANCE;
        lifted.y = Math.max(lifted.y, floor);
        // Ease so the lift reads as the soul leaving, not a teleport.
        const k = this.spectateLift * this.spectateLift * (3 - 2 * this.spectateLift);
        desired = eyePos.clone().lerp(lifted, k);
        lookTarget = lookTarget.lerp(
          anchor.clone().add(new THREE.Vector3(0, THREE.MathUtils.lerp(0.7, 3.2, h), 0)),
          k,
        );
      }
    }

    const onIslandFoot = !player.onShipId && player.state === 'alive' && !swimming
      && !player.atCannon && !player.atHelm && !player.atCrowNest;
    let followHz = 158;
    if (player.atCannon || player.atHelm) followHz = 70;
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

    // ── Death / downed camera: the view drops toward the ground, rolls onto
    // its side and the world desaturates behind a vignette. Pairs with the
    // corpse crumple so dying reads as an event, not a HUD chip.
    const dying = player.state === 'respawning' || player.state === 'eliminated';
    const downedNow = player.state === 'downed';
    const deathBlendTarget = dying ? 1 : downedNow ? 1 : 0;
    const deathBlendRate = dying ? 1 / 0.55 : downedNow ? 1 / 0.4 : -1 / 0.35;
    this.localDeathBlend = THREE.MathUtils.clamp(
      deathBlendTarget > 0
        ? this.localDeathBlend + this.frameDt * Math.abs(deathBlendRate)
        : this.localDeathBlend + this.frameDt * deathBlendRate,
      0, 1,
    );
    if (!dying && this.localDeathAnchor && this.localDeathBlend <= 0.001) this.localDeathAnchor = null;
    if (this.localDeathBlend > 0.001) {
      // The corpse-roll tilt belongs to the body. Once the spectate camera has
      // climbed off it, level out — a horizon on its side reads as a bug.
      const tilt = (this.localDeathAnchor?.tilt ?? 0.45) * (1 - this.spectateLift);
      camera.rotateZ((dying ? tilt : tilt * 0.9) * this.localDeathBlend);
    }
    // The vignette that sells the moment of dying is what BLINDS the spectator
    // ten seconds later: at full strength it is a 94%-black ellipse with a
    // grayscale filter behind it. Ease it back as the spectate camera rises.
    this.updateDeathOverlay(
      dying ? this.localDeathBlend * (1 - 0.72 * this.spectateLift)
        : downedNow ? this.localDeathBlend * 0.45
        : 0,
    );

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

  /**
   * A soft hemisphere fill that exists only while you are spectating your own
   * death. Raising the camera fixes a view of nothing at noon; at dusk or in
   * the storm's shadow the scene is genuinely unlit and the wreck still reads
   * as black-on-black. Built lazily (a player who never dies never pays), and
   * it is a HEMISPHERE light, so the point-light budget is untouched.
   */
  /**
   * WHO THE DEAD WATCH.
   *
   * Pick a crew that is still in the fight and hold onto them: the nearest
   * living pirate to where you fell, preferring somebody actually aboard a hull
   * (a fight is worth watching, a swimmer is not). The choice is sticky — it is
   * only re-made when the subject dies, leaves, or a second has gone by with
   * nobody chosen — because a camera that re-targets every frame is nausea.
   *
   * With nobody left alive at all it falls back to the storm ring's centre,
   * which is the last thing in the Reach that is still moving.
   *
   * Returns the world point to orbit, or null if there is nothing at all (no
   * state yet), in which case the caller keeps orbiting the body.
   */
  private updateSpectateSubject(): THREE.Vector3 | null {
    const state = this.state;
    if (!state) return null;
    const now = this.ocean.getTime();

    const living = (id: string | null) => {
      if (!id) return null;
      const p = state.players.find((c) => c.id === id);
      return p && p.state !== 'eliminated' && p.id !== this.localPlayerId ? p : null;
    };

    let subject = living(this.spectateSubjectId);
    if (!subject || now >= this.spectateRepickAt) {
      const from = this.localDeathAnchor?.pos ?? this.renderer.camera.position;
      let best: { p: typeof state.players[number]; score: number } | null = null;
      for (const candidate of state.players) {
        if (candidate.id === this.localPlayerId) continue;
        if (candidate.state === 'eliminated' || candidate.state === 'respawning') continue;
        if (this.isSkeletonName(candidate)) continue;
        const d = Math.hypot(candidate.position.x - from.x, candidate.position.z - from.z);
        // Aboard a hull beats swimming: that is where the match is happening.
        const score = d * (candidate.onShipId ? 0.55 : 1);
        if (!best || score < best.score) best = { p: candidate, score };
      }
      if (best) {
        subject = best.p;
        this.spectateSubjectId = best.p.id;
        this.spectateRepickAt = now + 6;
      } else {
        subject = null;
        this.spectateSubjectId = null;
        this.spectateRepickAt = now + 1;
      }
    }

    if (subject) {
      const ship = subject.onShipId ? this.shipsById.get(subject.onShipId) : null;
      // Frame the HULL when they are on one — a 30 m orbit around a person
      // standing on a galleon points at a plank.
      const target = ship ? ship.position : subject.position;
      this.spectateSubjectPos.set(target.x, Math.max(target.y, 0) + 1.2, target.z);
      this.spectateSubjectLabel = ship
        ? `${subject.name}'s ${shipClassName(ship.type).toLowerCase()}`
        : subject.name;
      return this.spectateSubjectPos;
    }

    const storm = state.storm;
    if (storm) {
      this.spectateSubjectPos.set(storm.centerX, 3, storm.centerZ);
      this.spectateSubjectLabel = 'the storm ring';
      return this.spectateSubjectPos;
    }
    this.spectateSubjectLabel = '';
    return null;
  }

  /** Island skeleton waves ride the player list; they are not a crew to watch. */
  private isSkeletonName(p: { name?: string; isBot?: boolean }): boolean {
    return !!p.isBot && /skeleton/i.test(p.name ?? '');
  }

  /** What the HUD prints while you are out: whose deck, and where you finished. */
  getSpectateSummary(): { subject: string; place: number; of: number } | null {
    if (!this.spectatePlacement) return null;
    return {
      subject: this.spectateHandoff > 0.35 ? this.spectateSubjectLabel : '',
      place: this.spectatePlacement.place,
      of: this.spectatePlacement.of,
    };
  }

  private updateSpectateLight() {
    if (this.spectateLift <= 0.001) {
      if (this.spectateLight) this.spectateLight.visible = false;
      return;
    }
    if (!this.spectateLight) {
      this.spectateLight = new THREE.HemisphereLight(0xbcd2ee, 0x243040, 0);
      this.renderer.scene.add(this.spectateLight);
    }
    this.spectateLight.visible = true;
    this.spectateLight.intensity = 0.85 * this.spectateLift;
  }

  /**
   * Desaturating death vignette. Built on demand so nothing changes for a
   * player who never dies, and kept below the death/win screens (z 500).
   */
  private updateDeathOverlay(strength: number) {
    if (!this.deathOverlay) {
      if (strength <= 0.001) return;
      const overlay = document.createElement('div');
      overlay.id = 'death-vignette';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:92',
        'opacity:0', 'transition:opacity 0.12s linear',
        'background:radial-gradient(ellipse at center, rgba(20,6,6,0.25) 25%, rgba(6,3,4,0.94) 100%)',
      ].join(';');
      document.body.appendChild(overlay);
      this.deathOverlay = overlay;
    }
    const overlay = this.deathOverlay;
    const k = THREE.MathUtils.clamp(strength, 0, 1);
    overlay.style.opacity = k.toFixed(3);
    overlay.style.backdropFilter = k > 0.01 ? `grayscale(${(k * 0.85).toFixed(2)}) contrast(${(1 + k * 0.15).toFixed(2)})` : 'none';
  }

  private updateWaterEnvironment() {
    const camera = this.renderer.camera.position;
    const camStorm = getStormWaveIntensity(this.state?.storm, camera.x, camera.z);
    const waveY = gerstnerHeight(camera.x, camera.z, this.ocean.getTime(), WAVE_PARAMS, camStorm);
    this.combatFx.setWaterSurfaceY(waveY);
    const depthBelowSurface = Math.max(0, waveY + 0.18 - camera.y);
    // The audio engine's submerge muffle rides the same depth the water shader
    // uses, so the muffle lands exactly on the visual dunk.
    this.cameraSubmergeDepth = depthBelowSurface;
    this.renderer.updateWaterEnvironment(
      depthBelowSurface,
      // The LOOK of the weather, not its force: see stormVisualIntensity.
      this.stormVisualIntensity,
      // The sky rides MATCH PROGRESS (one sunset, arriving with the late storm
      // phases) whenever the server is publishing it; the free-running ocean
      // clock is the fallback for the menu/loading world, and the debug
      // override still wins over both. See Renderer's MATCH_DAY_CYCLE_*.
      this.dayNightOverrideSec
        ?? (this.state?.matchProgress !== undefined
          ? dayNightSecondsForMatchProgress(this.state.matchProgress)
          : this.ocean.getTime()),
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

    // (The 160ms full-screen vignette blip that lived here is gone: CombatFx's
    // directional hurt overlay is the same cue, but it decays over ~0.9s and
    // tells you WHERE it came from.)
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

    // Own-ship hull damage: shake the camera once per FRESH breach. No
    // direction arrow for ship hits — the shake + leak readout + hole markers
    // carry it; the red arc stays reserved for the player's own body.
    const localShip = this.localShipId ? this.shipsById.get(this.localShipId) ?? null : null;
    if (localShip) {
      const total = countOpenHoles(localShip);
      if (localShip.id !== this.prevOwnShipId) {
        this.prevOwnShipId = localShip.id;
      } else {
        const fresh = total - this.prevOwnHullTotal;
        if (fresh > 0) {
          this.cameraShake = Math.min(1, this.cameraShake + THREE.MathUtils.clamp(fresh * 0.22, 0.12, 0.8));
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
      { item: 'banana', qty: Math.min(1, this.getInventoryQty(ship, 'banana')), label: '1 Plantain' },
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
    if (chopping && this.envFx.harvestTargetActive && chopCycle >= 0.75 && this.prevAxeChopCycle < 0.75) {
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
    if (player && !player.atCannon && !player.atHelm) {
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

    // Spatial audio needs to know where the ears are before anything positional
    // plays this frame (footsteps, splashes, gunfire all pan off this pose).
    this.audio.setListenerFromCamera(this.renderer.camera);
    this.updateFootstepAudio(dt);
    this.updateListenerSpaceAudio(player);

    this.updateNavalAudioAndFx(dt, player, localShip);
  }

  // ── Footsteps ─────────────────────────────────────────────────────────
  /** Metres of ground covered per footfall — half of PlayerAnimator's 2.8 m
   *  two-step gait cycle, so a step sounds on every planted foot. */
  private static readonly FOOTSTEP_STRIDE_M = 1.4;
  private readonly footstepDistance = new Map<string, number>();

  /**
   * Stride-locked footfalls for the local pirate (dry, first-person) and for
   * anyone walking nearby (spatial). The stride is spent by integrating the
   * player's own velocity — exactly what PlayerAnimator's gait lock integrates,
   * so a step sounds when a foot is planted. (World position deltas would count
   * a moving ship's travel as walking: a pirate strolling a galleon's deck at
   * 15 kn would get triple cadence, and a teleport would fire a burst.)
   */
  private updateFootstepAudio(dt: number): void {
    if (!this.state) return;
    const camera = this.renderer.camera.position;
    const seen = new Set<string>();
    for (const player of this.state.players) {
      const isLocal = player.id === this.localPlayerId;
      const distance = isLocal
        ? 0
        : Math.hypot(player.position.x - camera.x, player.position.y - camera.y, player.position.z - camera.z);
      if (!isLocal && distance > 46) continue;
      seen.add(player.id);
      const grounded = player.state === 'alive'
        && !player.atCannon && !player.atHelm && !player.atCrowNest
        && player.mastClimb === null
        && !player.cannonBallistic
        && Math.abs(player.velocity.y ?? 0) < 2.2;
      // Aboard a ship the server keeps velocity deck-relative (the hull's carry
      // is applied to position), so this is the pirate's own walking speed.
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      if (!grounded || speed < 0.55) {
        this.footstepDistance.set(player.id, 0);
        continue;
      }
      const walked = (this.footstepDistance.get(player.id) ?? 0) + speed * dt;
      if (walked < Game.FOOTSTEP_STRIDE_M) {
        this.footstepDistance.set(player.id, walked);
        continue;
      }
      this.footstepDistance.set(player.id, walked - Game.FOOTSTEP_STRIDE_M);
      // There is no sprint key in this game (PLAYER.SPRINT_MULT is unused): full
      // MOVE_SPEED *is* the run, and the soft step belongs to the crouch-walk
      // (0.55 ×) and to anything the terrain is slowing down.
      const running = speed > PLAYER.MOVE_SPEED * 0.8 && !player.crouching;
      this.audio.playFootstep(
        this.getFootstepSurface(player),
        running,
        distance,
        isLocal ? undefined : player.position,
      );
    }
    for (const id of [...this.footstepDistance.keys()]) {
      if (!seen.has(id)) this.footstepDistance.delete(id);
    }
  }

  /** What the boot lands on: ship/dock planking, beach sand, bare rock, or turf. */
  private getFootstepSurface(player: Player): FootstepSurface {
    if (player.onShipId) return 'deck';
    const island = this.getNearestIsland(player.position.x, player.position.z);
    if (!island) return 'deck';
    const x = player.position.x;
    const z = player.position.z;
    // Dock planking reads as a deck, not as the beach it is moored off.
    const dock = island.dock;
    if (dock) {
      const local = toDockLocalPoint(dock, x, z);
      if (Math.abs(local.x) <= dock.width * 0.5 + 0.6 && Math.abs(local.z) <= dock.length * 0.5 + 0.6) {
        return 'deck';
      }
    }
    // Inside a cave the floor is cut stone.
    if (isInsideCaveInterior(island, x, player.position.y, z)) return 'stone';
    const { angle, distRatio } = getIslandDistRatio(island, x, z);
    if (distRatio > 0.84) {
      // Shore band: the coast type decides between sand and rock, the same way
      // IslandBuilder paints it.
      return getIslandCoastType(island, angle) === 'beach' ? 'sand' : 'stone';
    }
    // Interior: grass everywhere the terrain shader keeps green, bare stone on
    // the high crags (matching the rock cap at ~0.72 of the island's relief).
    const ground = getIslandSurfaceY(island, x, z);
    const relief = Math.max(6, island.radius * 0.42 * (0.6 + island.profile.heightProfile));
    return ground > relief * 0.72 ? 'stone' : 'grass';
  }

  /** Highest y a wave crest can reach, plus a margin: 1.01m of summed calm
   *  amplitude × the 1.6 roughness peak = 1.62m (storms heave higher still).
   *  Cave floor below this ⇒ the sea would render through it. */
  private static readonly CAVE_SEA_REACH_Y = 2.6;

  // ── Listener space: underwater muffle + cave reverb ───────────────────
  private cameraSubmergeDepth = 0;
  private stormRainIntensity = 0;
  private prevInCaveForAudio: boolean | null = null;
  private prevSubmergeDepthForAudio = -1;

  /** Head under the swell ⇒ muffle; standing under a cave roof ⇒ cave verb. */
  private updateListenerSpaceAudio(player: Player | null): void {
    const depth = this.cameraSubmergeDepth;
    if (Math.abs(depth - this.prevSubmergeDepthForAudio) > 0.02) {
      this.prevSubmergeDepthForAudio = depth;
      this.audio.setSubmerged(depth);
    }
    let inCave = false;
    if (player && this.state) {
      const island = this.getNearestIsland(player.position.x, player.position.z);
      if (island) {
        inCave = isInsideCaveInterior(island, player.position.x, player.position.y, player.position.z);
      }
    }
    if (inCave !== this.prevInCaveForAudio) {
      this.prevInCaveForAudio = inCave;
      this.audio.setReverbSpace(inCave ? 'cave' : 'outdoor');
    }
  }

  /** The sea is one sheet with no holes cut for land, and the deepest cave
   *  floors bottom out at y=1 — under the +1.62m crest a calm swell reaches. So
   *  in a deep gallery the ocean renders straight through the stone floor and
   *  you stand in a lantern-lit cavern with surf around your ankles.
   *
   *  The sheet stands down exactly where that can happen: camera under a cave
   *  roof AND on floor the sea could reach. Higher up the entrance ramp (where
   *  a pirate CAN still see daylight and open water out of the mouth) the floor
   *  is metres above any crest, so the sea keeps drawing and nothing pops. */
  private updateOceanCaveSuppression(): void {
    const cam = this.renderer.camera.position;
    const island = this.state ? this.getNearestIsland(cam.x, cam.z) : null;
    let suppress = false;
    if (island && isInsideCaveInterior(island, cam.x, cam.y, cam.z)) {
      const floorY = getCaveFloorY(island, cam.x, cam.z);
      suppress = floorY !== null && floorY < Game.CAVE_SEA_REACH_Y;
    }
    this.ocean.setSuppressed(suppress);
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

    // Shore proximity — closest island edge to the listener drives breaker
    // ambience. The same sweep finds the nearest tavern, which is where the jig
    // is playing from (SoundEngine does the falloff, panning and wall muffle).
    let nearestEdge = Infinity;
    let tavernDist = Infinity;
    let tavernPos: { x: number; y: number; z: number } | null = null;
    for (const island of this.state.islands) {
      const edge = dist2D(cam.x, cam.z, island.position.x, island.position.z) - island.radius;
      if (edge < nearestEdge) nearestEdge = edge;
      if (island.tavern) {
        const d = dist2D(cam.x, cam.z, island.tavern.position.x, island.tavern.position.z);
        if (d < tavernDist) { tavernDist = d; tavernPos = island.tavern.position; }
      }
    }
    this.audio.setTavernSource(tavernPos ? tavernDist : null, tavernPos);
    // The Gilded Wreck is the only mark in the open sea with a voice: bell,
    // hull groan and rigging creak, out to WRECK_AMBIENCE_RANGE. She had none
    // between the three tolls that announced her and the storm taking her back,
    // which meant the convergence event was silent for the whole fight over it.
    const wreck = this.state.wreck ?? null;
    this.audio.setWreckSource(
      wreck ? dist2D(cam.x, cam.z, wreck.position.x, wreck.position.z) : null,
      wreck ? wreck.position : null,
    );
    const nearShore01 = Number.isFinite(nearestEdge)
      ? THREE.MathUtils.clamp(1 - THREE.MathUtils.clamp(nearestEdge / 70, 0, 1), 0, 1)
      : 0;
    // rain01 is the SAME field the world-space rain draws from, so the downpour
    // you hear starts and stops with the drops you see (the engine's default
    // guess — storminess × 0.85 — had it raining audibly in clear weather deep
    // inside the safe zone).
    this.audio.setAmbience({
      nightFactor,
      storminess,
      nearShore01,
      rain01: THREE.MathUtils.clamp(this.stormRainIntensity, 0, 1),
    });

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
        // Pressure jets, one per OPEN breach: the anchors ride the lofted hull
        // (heave/pitch/roll/list) at the exact point the shot landed, +Z =
        // outward normal. This is the only hull-leak FX path — the old fixed
        // per-section spray points are gone with the section model.
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
      const d = dist2D(pos.x, pos.z, ship.position.x, ship.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = ship;
      }
    }
    return best;
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
    // The chart takes the mouse while it's up: the overlay is pointer-transparent
    // by default so the HUD stays clickable, and the pointer has to leave lock
    // or there is no cursor to drag a chart with (same deal as the supply wheel).
    this.ui.mapOverlay.style.pointerEvents = next ? 'auto' : '';
    this.ui.mapCanvas.style.cursor = next ? 'grab' : '';
    if (next) {
      this.map.resetChartView(); // always open at the whole-world view, centred on you
      this.ui.scopeOverlay.style.display = 'none';
      if (this.input.isLocked()) document.exitPointerLock?.();
      this.map.drawMaps();
    } else if (this.inMatch && !this.input.isLocked()) {
      // Give the helm back its mouse the moment the chart is folded away.
      this.renderer.renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
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
    // ?server=8091 — dev-only: point this tab at a SECOND game server. Verifying
    // a timed world event means running a server with the event forced early,
    // and that must not mean evicting everyone off the shared one. Localhost only.
    const override = new URLSearchParams(window.location.search).get('server');
    if (isLocalhost && override && /^\d{2,5}$/.test(override)) {
      return `${protocol}://${host}:${override}/ws`;
    }
    // Any localhost port other than the game server's own is a dev server (Vite, etc.).
    // Connect directly to the game port instead of relying on a proxy — works for
    // 3000/3003/5173/etc.
    if (isLocalhost && port && port !== GAME_SERVER_PORT) {
      return `${protocol}://${host}:${GAME_SERVER_PORT}/ws`;
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

  private getInventoryQty(ship: Ship | null, item: ItemStack['item']) {
    if (!ship) return 0;
    return ship.inventory.find((entry) => entry.item === item)?.qty ?? 0;
  }

  private formatTradeItem(entry: ItemStack) {
    return `${entry.qty} ${entry.item.replace(/_/g, ' ')}`;
  }

  private cloneOffer(offer: ItemStack[]) {
    return offer.map((entry) => ({ ...entry }));
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

  /** Prompt anchor for planking a breach: the spot on whichever floor the
   *  pirate is standing on, directly above/beside the hole. Same (x, z) as the
   *  hole — the prompt points at the right piece of planking, and the server's
   *  reach test is planar anyway.
   *
   *  From the weather deck that means the rail: the hole sits at the waterline,
   *  metres below and behind the planking, so anchoring it there would ask a
   *  pirate to look through his own feet. But a breach BELOW DECKS is planked
   *  from inside the hold, which the server has always allowed (the reach test
   *  never looked at Y) — the prompt just anchored on the deck OVERHEAD, so a
   *  pirate standing in the bilge staring straight at the gushing plank got no
   *  prompt at all. Down there, anchor at chest height in the hold. */
  private getHoleRepairWorldPoint(ship: Ship, hole: ShipHole) {
    const stats = SHIP_STATS[ship.type];
    const localX = THREE.MathUtils.clamp(hole.x * 1.08, -stats.width * 0.54, stats.width * 0.54);
    const localZ = THREE.MathUtils.clamp(hole.z * 1.04, -stats.length * 0.46, stats.length * 0.46);
    const player = this.getLocalPlayer();
    const deckLineY = ship.position.y + stats.height - 0.5;
    const inHold = !!player && player.onShipId === ship.id && player.position.y < deckLineY;
    return this.getShipWorldPoint(
      ship,
      localX,
      localZ,
      inHold ? SHIP.HOLD_FLOOR_OFFSET + 1.0 : stats.height + 0.4,
    );
  }

  private getClosestGoldHoarder(player: Player): { npc: IslandNpc; island: Island; distance: number } | null {
    if (!this.state) return null;
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = dist2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (!closest || distance < closest.distance) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest;
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
    // Land-ho names the ISLE and the world it belongs to: a pirate should learn
    // he is sailing the Shattered Reach from the game, not from a design doc.
    this.showBanner(name, `Land discovered · ${WORLD_NAME}`, 4500);
  }

  /** Shared banner paint. `sub` is the small line under the title. Returns
   *  false when the screen centre was busy and nothing was shown. */
  private showBanner(title: string, sub: string, holdMs: number, subStyle = ''): boolean {
    // Don't slam a discovery banner over an open wheel/legend — the next
    // island (or re-entry) will announce itself when the center is clear.
    const legend = document.getElementById('controls-hint');
    if (this.input.isSupplyWheelOpen() || legend?.style.display === 'block') return false;
    this.ui.islandBanner.innerHTML = `<div class="ib-title">${title}</div><div class="ib-sub"${subStyle ? ` style="${subStyle}"` : ''}>${sub}</div>`;
    this.ui.islandBanner.classList.add('visible');
    this.islandBannerHideAt = performance.now() + holdMs;
    return true;
  }

  /**
   * VIGNETTE DISCOVERY — the fifteen authored scenes speak when you reach them.
   *
   * The gallows, the kraken's kill, the widow's cairn: each was a beautifully
   * built mute prop. Walking inside a scene's footprint now fires the same
   * discovery banner + sting that landfall does, with the scene's NAME and the
   * one line that says what happened here — once per scene, per match.
   *
   * Cheap by construction: only islands the pirate is actually standing on are
   * scanned, and a scene drops out of the scan the moment it has spoken.
   */
  private updateVignetteDiscovery() {
    if (!this.state || this.isStartCeremonyActive()) return;
    const player = this.getLocalPlayer();
    // On foot only — a scene should be walked into, not sailed past.
    if (!player || player.onShipId || player.state === 'eliminated' || player.state === 'respawning') return;

    for (const island of this.state.islands) {
      if (!island.props?.length) continue;
      const reach = getIslandMaxRadius(island) + 30;
      if (dist2D(player.position.x, player.position.z, island.position.x, island.position.z) > reach) continue;
      for (const prop of island.props) {
        const vignette = STORY_VIGNETTES[prop.type];
        if (!vignette) continue;
        const key = `${island.id}:${prop.type}`;
        if (this.seenVignettes.has(key)) continue;
        const dx = player.position.x - prop.x;
        const dz = player.position.z - prop.z;
        if (dx * dx + dz * dz > vignette.radius * vignette.radius) continue;
        // A scene only counts as DISCOVERED once its beat has actually been on
        // screen. If the centre is busy (legend, supply wheel) the moment we
        // walk in, the revelation waits rather than being silently spent.
        const shown = this.showBanner(
          vignette.title,
          vignette.beat,
          5200,
          // The beat is a SENTENCE, not a label: drop the wide tracking the
          // 'Land discovered' stamp uses so it reads as the world talking.
          'letter-spacing:0.05em;font-size:0.98rem;color:#f0dfae;max-width:44ch;margin:12px auto 0;line-height:1.5;text-transform:none;font-style:italic;text-shadow:0 2px 14px rgba(0,0,0,0.85)',
        );
        if (!shown) return;
        this.seenVignettes.add(key);
        this.playIslandArrivalFanfare();
        // The feed keeps the find after the banner fades — a discovery log.
        this.pushFeed(`Discovered: ${vignette.title} — ${island.name}`, '#e8c98a');
        return; // one revelation at a time
      }
    }
  }

  /**
   * WIDOW'S LANTERN — the one light in the Reach that is a landmark.
   *
   * The bible promises her lamp is visible from the sea at night; the island's
   * own lantern glow is a 2 m sprite that dissolves into a smudge past ~60 m.
   * This is the stern-lantern treatment applied to a story prop: an amber core
   * plus a soft halo whose screen size is held up as distance grows, so from
   * 300 m of black water she reads as a BEACON — and a warm amber one, so she
   * is never confused with the cold white of a watchtower.
   *
   * Built once per match from the island data (not the island mesh), so the
   * light survives whatever LOD does to the terrain that far out.
   */
  private buildStoryBeacons() {
    if (!this.state) return;
    const signature = this.state.islands.map((i) => i.id).join('|');
    if (this.storyBeaconsBuiltFor === signature) return;
    this.storyBeaconsBuiltFor = signature;
    for (const beacon of this.storyBeacons) {
      this.renderer.scene.remove(beacon.core, beacon.halo);
      beacon.core.material.dispose();
      beacon.halo.material.dispose();
    }
    this.storyBeacons.length = 0;

    const texture = this.envFx.lanternGlowTexture;
    if (!texture) return;
    for (const island of this.state.islands) {
      for (const prop of island.props ?? []) {
        if (prop.type !== 'widow_memorial') continue;
        // Her raised lantern: the memorial's arm height above the cairn.
        const y = getIslandSurfaceY(island, prop.x, prop.z) + 3.15 * prop.scale;
        const make = (color: number, opacity: number) => {
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texture,
            color,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity,
          }));
          sprite.position.set(prop.x, y, prop.z);
          sprite.renderOrder = 3;
          sprite.visible = false;
          this.renderer.scene.add(sprite);
          return sprite;
        };
        this.storyBeacons.push({
          halo: make(0xff9c3a, 0),
          core: make(0xffd79a, 0),
          worldPos: new THREE.Vector3(prop.x, y, prop.z),
        });
      }
    }
  }

  /** Grow the beacon with distance so it holds a constant, unmistakable size
   *  on screen — a flame you can steer by rather than a fading dot. */
  private updateStoryBeacons(nightFactor: number) {
    if (this.storyBeacons.length === 0) return;
    const camera = this.renderer.camera.position;
    const flicker = 0.9 + Math.sin(this.ocean.getTime() * 3.1) * 0.06 + Math.sin(this.ocean.getTime() * 7.7) * 0.04;
    for (const beacon of this.storyBeacons) {
      const lit = nightFactor > 0.06;
      beacon.core.visible = lit;
      beacon.halo.visible = lit;
      if (!lit) continue;
      const dist = beacon.worldPos.distanceTo(camera);
      // Near: a lamp on a cairn. Far: a fixed mark on the horizon.
      const coreSize = THREE.MathUtils.clamp(dist * 0.034, 1.2, 11);
      const haloSize = coreSize * 3.4;
      beacon.core.scale.setScalar(coreSize);
      beacon.halo.scale.setScalar(haloSize);
      // Brighten as she gets far away — atmosphere eats the rest.
      const reach = THREE.MathUtils.clamp((dist - 40) / 220, 0, 1);
      beacon.core.material.opacity = nightFactor * (0.7 + reach * 0.3) * flicker;
      beacon.halo.material.opacity = nightFactor * (0.2 + reach * 0.34) * flicker;
    }
  }

  /** Land-ho fanfare. Routed through SoundEngine so it rides the master bus
   *  (volume slider, mute, compressor, ducking) instead of a private
   *  AudioContext bolted straight onto ctx.destination. */
  private playIslandArrivalFanfare() {
    this.audio.playIslandDiscovery();
  }

  /** The breach under this pirate's boots, via the SHARED reach rule the server
   *  validates with — so the [X] prompt can never offer a patch Match refuses. */
  private findRepairableHole(player: Player, ship: Ship): ShipHole | null {
    return sharedFindRepairableHole(player.position, ship);
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

}
