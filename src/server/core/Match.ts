import { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type {
  GameState, HullSections, InteractIntent, InteractRefusalReason, InteractRefusedPayload, Island, IslandDock, IslandProp, Player, Projectile, SeaRock, Ship, ShipHole, ShipKeg, ShipUpgrade, TreasureChest, Vec3, WeaponId, NetMsg, PlayerInput, TradeActionPayload, Shark, WildlifeAnimal, WildlifeType, EquippableTool, WreckEvent,
} from '../../shared/types/index.js';
import { BERTH, CARGO, SERVER_TICK_MS, SNAPSHOT_RATE, FULL_SNAPSHOT_TICKS, FIRST_SAIL_ASSIST, MATCH_START_COUNTDOWN_SEC, DBNO, ECONOMY, HARVEST, KILL_STREAK_TIERS, PLAYER, POCKET, RESPAWN_HOLD_GRACE_SECONDS, RESPAWN_HOLD_MAX_SECONDS, SHIP, SHARK, SHIP_STATS, STORM_ARC_SECONDS, STORM_PHASES, STORM_RESPAWN_GRACE_SECONDS, UPGRADE_COSTS, WEAPONS, WORLD, WILDLIFE, FLOODING, WRECK_EVENT } from '../../shared/constants/index.js';
import {
  boardingStealCap,
  bountyClearGold,
  bountyThresholdGold,
  cargoGoldFromBanked,
  spillFromCargo,
  splitSpill,
} from '../../shared/cargo.js';
import { MapGenerator } from '../world/MapGenerator.js';
import { PhysicsSystem, applyShipRudderSteering, stormSeaState } from '../systems/PhysicsSystem.js';
import { buildHotSnapshot, buildWireSnapshot } from './snapshot.js';
import { WeaponSystem } from '../systems/WeaponSystem.js';
import type { HitscanTrace } from '../systems/WeaponSystem.js';
import { StormSystem } from '../systems/StormSystem.js';
import { IslandSystem } from '../systems/IslandSystem.js';
import { TradingSystem } from '../systems/TradingSystem.js';
import { BotSystem } from '../systems/BotSystem.js';
import {
  getNearestShipBoardingLadder,
  getIslandMaxRadius,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  isPointInsideIslandFootprint,
  dockLocalToWorld,
  randRange,
  randAngle,
  randInt,
  dist2D,
  angleWrap,
  clamp,
  sampleLocalWind,
  getShipDeckRaiseAt,
  getShipDeckY,
  getCrowNestStandingY,
  gerstnerHeight,
  WAVE_PARAMS,
  intersectRaySeaRock,
} from '../../shared/utils/index.js';
import { intersectRayShipHull, raymarchIslandSurface } from '../../shared/raycast.js';
import {
  findNearbyCannonIndex as findSharedNearbyCannonIndex,
  findMermaidReturnShip,
  findNearbyGoldHoarder,
  findNearbyKeg,
  findNearbyUpgradeStation,
  getConstrainedCannonAim,
  getHelmControlLocal,
  getRepairPlankCount,
  getShipFloorYAt,
  getCannonDeckLocalPosition as getSharedCannonDeckLocalPosition,
  isNearAmmoCrate as isSharedNearAmmoCrate,
  isNearAnchor as isSharedNearAnchor,
  isNearCrowNestLadder as isSharedNearCrowNestLadder,
  isNearHelm as isSharedNearHelm,
  isNearSailStation as isSharedNearSailStation,
  findBraceStationDir,
  isBoardingOwnHull,
  isStandingOnShipDeck,
  SHIP_BOARD_LADDER_REACH,
  SHIP_BOARD_LATCH_REACH,
  toShipLocalPoint,
  toShipWorldPoint,
  countOpenHoles,
  findRepairableHole,
} from '../../shared/interactions.js';

// Weathered banner dyes — team identity without the LED-strip look.
const TEAM_COLORS = [
  0xB33A3A, 0x3A6EA8, 0x3F8A5E, 0xC08A3E,
  0x8E4B8E, 0x3E8E8E, 0xB8A23E, 0xA85A32,
  0x6A4BA8, 0x5E8E3E, 0xA84B66, 0x7E8E3E,
  0x4B6AA8, 0xA87878, 0x6E9E9E, 0xB8B87E,
];

type ShipSpawn = ReturnType<MapGenerator['generateShipSpawns']>[number];

type OneShotAction =
  | 'interact'
  | 'trade'
  | 'wheel'
  | 'reload'
  | 'jump'
  | 'placeKeg'
  | 'dropChest'
  | 'special'
  | 'cannonAmmo'
  | 'slot'
  | 'barrelTakeAll'
  | 'bail'
  | 'selectMap';

interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  name: string;
  lastInput: PlayerInput | null;
  joinedAt: number;
  killsAtJoin: number;
  deathsAtJoin: number;
  /**
   * Tracks the last input.seq we have already "consumed" each one-shot action for.
   * Server applies client.lastInput every tick until a fresh one arrives, so press-style
   * flags (interact, trade, useWheelItem, cannonAmmo, slot) would otherwise re-fire 60×/sec.
   */
  consumedSeq: Record<OneShotAction, number>;
  /** Sim time each rate-limited one-shot was last accepted — seq dedupe alone is spoofable. */
  lastOneShotAt: Partial<Record<OneShotAction, number>>;
  /**
   * input.seq of the last packet a tick actually OFFERED to the sim. Inputs land
   * in a single `lastInput` slot at 45 Hz and are read once per tick, so a packet
   * whose seq never reached this was overwritten before anyone looked at it — its
   * one-shot presses may be carried onto its replacement (see carryUnreadOneShots).
   */
  appliedInputSeq: number | null;
  /** Wall clock (ms) of the OLDEST unread press still riding forward — bounds the
   *  carry so a frozen sim can't fire a stale press minutes later. */
  oneShotPendingSince: number | null;
  /** Sim time of the last interact_refused sent — one nudge per press storm. */
  lastRefusalAt: number;
  /** Latest full snapshot skipped while the socket was congested — flushed
   *  (newest only, older ones dropped) once the buffer drains. */
  pendingFullSnapshot: string | null;
}

export interface MatchHumanResult {
  playerId: string;
  name: string;
  kills: number;
  deaths: number;
  gold: number;
  /** 1 = winner, 2 = runner-up, etc. Higher is worse. */
  placement: number;
  isWinner: boolean;
  shipsSunk?: number;
  chestsSold?: number;
  chestsDug?: number;
  sharksKilled?: number;
  skeletonsKilled?: number;
  bestKillStreak?: number;
  woodChopped?: number;
  oreMined?: number;
  damageDealt?: number;
  headshots?: number;
  playSeconds?: number;
}

interface PlayerMatchDeltas {
  shipsSunk: number;
  chestsSold: number;
  chestsDug: number;
  sharksKilled: number;
  skeletonsKilled: number;
  bestKillStreak: number;
  woodChopped: number;
  oreMined: number;
  damageDealt: number;
  headshots: number;
  joinedAtSimTime: number;
  /** Frozen on removeClient so a leaver's playSeconds stops at departure. */
  leftAtSimTime: number | null;
}

/**
 * ONE ROW PER CREW IN THE MATCH — bots included.
 *
 * The end screen used to be handed `humans` and nothing else, so a solo queue
 * against nine bots produced a "results table" with exactly ONE row in it: your
 * own. A battle royale whose scoreboard cannot tell you who won, who you
 * outlasted, or where you placed out of ten is not a scoreboard.
 *
 * `board` is the whole fleet ranked once — winner first, then whoever was still
 * afloat by gold, then the eliminated in reverse order of dying. `humans` stays
 * exactly as it was because the lobby persists lifetime stats off it.
 */
export interface MatchBoardRow {
  playerId: string;
  name: string;
  kills: number;
  deaths: number;
  gold: number;
  placement: number;
  isWinner: boolean;
  isBot: boolean;
  /** False once the crew was eliminated — the board marks who was still afloat. */
  alive: boolean;
}

export interface MatchEndResult {
  matchId: string;
  winnerId: string | null;
  winnerName: string | null;
  reason: 'gold' | 'last_ship' | 'abandoned';
  humans: MatchHumanResult[];
  /** Every crew in the match, ranked. See MatchBoardRow. */
  board: MatchBoardRow[];
  /** How many crews the match was played with — the "of 10" in "Place: #6 of 10". */
  crewCount: number;
  /** True when a dev hook (dev_grant_gold / dev_bot_peace) was honoured —
   *  lifetime stats skip such matches (DEV-01). */
  devAssisted: boolean;
}

interface MatchOptions {
  matchId: string;
  botCount: number;
  /** Names of human players who will join — used so bots get distinct identities. */
  reservedHumanNames?: string[];
  /** Honour dev_grant_gold / dev_bot_peace (DEV-01). Defaults to
   *  PIRATES_BR_DEV_HOOKS=1: the test runner sets it, production never does. */
  devHooks?: boolean;
}

const SKELETON_WAVE_INITIAL_DELAY_MIN = 35;
const SKELETON_WAVE_INITIAL_DELAY_MAX = 70;
const SKELETON_WAVE_COOLDOWN_MIN = 120;
const SKELETON_WAVE_COOLDOWN_MAX = 190;
const SKELETON_WAVE_LINGER_SECONDS = 85;
const SKELETON_DEFEAT_DESPAWN_SECONDS = 2.25;
const SKELETON_ISLAND_ACTIVATION_MARGIN = 70;
const SKELETON_PLAYER_WAKE_RADIUS = 38;
/** Static world (islands + seaRocks) rides every 4th full snapshot (~2.6 Hz) —
 *  it is immutable apart from chest/barrel state, which also has explicit events. */
// Statics ride the 'join' message, and the websocket is TCP (no loss), so the
// periodic static-world re-send is belt-and-suspenders only — every ~20s keeps
// worst-case bandwidth negligible (~10KB/s) instead of ~470KB/s at every 4th full.
const FULL_WORLD_SNAPSHOT_TICKS = FULL_SNAPSHOT_TICKS * 200;
const MAX_VOLATILE_BUFFERED_BYTES = 512 * 1024;
/** End-screen clients keep receiving a slow full snapshot so spectate views stay live. */
const ENDED_SNAPSHOT_TICKS = SNAPSHOT_RATE * 15;

/** Optional fixed match seed (PIRATES_BR_MAP_SEED). Unset ⇒ a fresh random
 *  world roll per match, exactly as before. Set ⇒ ship spawns, sea rocks and
 *  loot rolls repeat, which is what makes a two-build perf A/B comparable. */
export function matchSeedFromEnv(): number | undefined {
  const raw = process.env.PIRATES_BR_MAP_SEED;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : undefined;
}

/** Coin-flips taken while players JOIN (which free dock a newcomer moors at).
 *  Unseeded this is plain Math.random. Under PIRATES_BR_MAP_SEED it becomes a
 *  private, stream-independent generator: the Nth join always lands on the same
 *  dock, no matter how many draws world generation happened to take. */
function makeJoinRng(): () => number {
  const seed = matchSeedFromEnv();
  if (seed === undefined) return Math.random;
  let s = (seed ^ 0x5f356495) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The match's gameplay RNG (RNG-01): storm centres, bot timers/aim noise,
 *  skeleton waves, sink knockback, shark spawns, harvest rolls, cannon spread
 *  and trade coin-flips all draw from it. Unseeded it IS Math.random (no
 *  behaviour change, no draw-order change). Under PIRATES_BR_MAP_SEED it is a
 *  private mulberry32 stream salted by matchId, so the same matchId replays
 *  bit-identically while two matches on one seeded server are not clones. It
 *  never feeds MapGenerator or the join stream, so island/berth determinism
 *  is exactly what it was. */
export function makeMatchRng(matchId: string): () => number {
  const seed = matchSeedFromEnv();
  if (seed === undefined) return Math.random;
  let salt = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) salt = Math.imul(salt ^ matchId.charCodeAt(i), 0x01000193);
  let s = (seed ^ salt ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-skeleton phase (guard reflex, roam offset) from its deterministic
 *  name (Skeleton_<n>), never its uuid: a seeded match must replay (RNG-01). */
function skeletonPhase(s: { name: string }): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.name.length; i++) h = Math.imul(h ^ s.name.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const CUTLASS_CHARGE_TIME = 0.72;
const CUTLASS_CHARGE_MIN_TAP = 0.02;
const CUTLASS_LUNGE_COOLDOWN = 1.05;
const CUTLASS_LUNGE_DAMAGE = 50;
// Dash impulse, calibrated by probe: 32 measured ~9.2m travel (incl. landing
// slide), 52 measured ~15m ("wayyyy too far"). 40 lands ~11.5-12m — a real
// gap-closer that stays chill.
const CUTLASS_LUNGE_IMPULSE = 40;
/** Kill credit for prior damage expires after this long (storm/drown deaths). */
const KILL_CREDIT_WINDOW_SECONDS = 90;
/**
 * What actually took the last of a pirate's health.
 *
 * Read off the world at the moment the damage lands, NOT off the pirate's
 * position at the moment they die: those are different questions and the
 * second one lies. A pirate mauled by a shark in the shallows, or shredded by
 * the tempest and then swimming back inside the ring to bleed out, is not a
 * drowning — but "where were you standing when you hit zero" calls both of them
 * one. The death screen is the one screen a losing player reads, so it gets the
 * real answer.
 */
type DamageSource =
  | 'storm' | 'shark' | 'drowned' | 'fall' | 'fire'
  | 'cannon' | 'gunshot' | 'blade' | 'explosion';
/** What finished a crew, threaded to the client on `game_over` (elimination)
 *  and on `kill_event` (a respawn still gets told what got it). */
type EliminationCause = DamageSource | 'ship_sunk' | 'killed';
/** A damage tag older than this is stale evidence — the world moved on, so the
 *  positional reading is the better answer. Deaths land within a tick or two of
 *  the blow that caused them; this is deliberately generous to bleed-out. */
const DAMAGE_SOURCE_WINDOW_SECONDS = 12;
/**
 * Which hull a crew of `size` is handed at the dock.
 *
 * SHIP_STATS is written for crews: a Cutter's two guns and 0.7 turn rate are one
 * pair of hands' worth of ship, a Man-o'-War's eight guns and 0.25 turn rate
 * assume four. The world still rolls all three classes for its bot crews and its
 * silhouettes — this decides only what a JOINING crew sails, and today every
 * human joins alone. When crews start sharing a hull, pass the real crew size.
 */
function hullForCrewSize(size: number): 'sloop' | 'brigantine' | 'galleon' {
  if (size <= 1) return 'sloop';
  if (size <= 3) return 'brigantine';
  return 'galleon';
}
/** Mast ladder climb rate — fraction of the full ladder per second (W up, S
 *  down). ~1.8s deck→nest on a sloop keeps the nest a commitment, not a snap. */
const MAST_CLIMB_RATE = 0.55;
/** Catch-up steps per timer callback — bounds the death spiral after a stall. */
const MAX_CATCHUP_TICKS = 5;
/** Minimum sim-time interval between accepted one-shot actions (anti-spam). */
const ONE_SHOT_MIN_INTERVAL: Partial<Record<OneShotAction, number>> = {
  interact: 0.2,
  wheel: 0.15,
  trade: 0.3,
  barrelTakeAll: 0.3,
};
/** Ceiling (wall ms) on how long an unread one-shot press may ride forward from
 *  packet to packet. Covers any plausible starvation gap — a stalled sim must
 *  never wake up and fire a press the player made a lifetime ago. */
const ONE_SHOT_CARRY_WINDOW_MS = 750;
/** Minimum sim seconds between two `interact_refused` nudges for one player —
 *  a mashed [X] is one dead thud, not a wall of amber. */
const INTERACT_REFUSAL_INTERVAL = 0.7;
/** How long a queued climb stays live after [X] at a ladder. A press is an
 *  INTENTION, not a single-frame assertion: nearShipId is recomputed every
 *  physics tick, so validating one instantaneous press ate 8 presses in a row
 *  ("14 seconds of dead X at a visible Climb Ladder prompt"). */
const BOARD_LATCH_TIME = 2.0;
/** Feet on your own deck for this long with the server still calling you
 *  un-boarded (walking up the dock gangway) → you are aboard. */
const DECK_AUTO_BOARD_TIME = 0.5;
/** Weighing anchor from the HELM (W at the wheel) takes this much longer than
 *  manning the bow capstan yourself — the capstan stays the proper way, the
 *  helm is the no-soft-lock way. */
const HELM_ANCHOR_RAISE_FACTOR = 1.35;
/** Dock-local z of the swim-up ladder as a fraction of dock length — the SEAWARD
 *  end. Must stay in step with getIslandDockSwimLadderPoint in shared/utils
 *  (the client prompt anchors on that point; this gate must accept where it is). */
const DOCK_LADDER_LOCAL_Z_FRAC = 0.44;
/** How close (metres, dock-local XZ) a swimmer must be to the ladder to climb. */
const DOCK_CLIMB_REACH = 4.2;
// Berthing geometry is SHARED with the map generator's mooring-lane dredge —
// the planner must look for water exactly where the generator dug it.
const BERTH_RAIL_GAP = BERTH.RAIL_GAP;
const BERTH_BOW_INSET = BERTH.BOW_INSET;
const BERTH_BOB_MARGIN = BERTH.BOB_MARGIN;
const BERTH_SEARCH_REACH = BERTH.SEARCH_REACH;
const BERTH_MIN_WATER = BERTH.MIN_WATER;

/** Candidate along-dock offsets from the canonical bow-at-the-tip anchor, nearest
 *  first: 0, +0.75, −0.75, +1.5, … Seaward wins ties. A dock whose seaward end
 *  runs onto a reef (the atoll) finds its water on the SHOREWARD side, which the
 *  old seaward-only slide could never do — it gave up and fell back to a berth
 *  tens of metres past the tip. */
function berthShiftLadder(dockLength: number): number[] {
  const reach = Math.min(BERTH_SEARCH_REACH, dockLength * 0.5 + 6);
  const shifts: number[] = [0];
  for (let d = 0.75; d <= reach; d += 0.75) shifts.push(d, -d);
  return shifts;
}
const VALID_INTERACT_INTENTS: ReadonlySet<InteractIntent> = new Set<InteractIntent>([
  'barrel', 'chest', 'board', 'dock', 'mermaid', 'keg_diffuse', 'upgrade',
  'gold_hoarder', 'stow_chest', 'helm', 'sails', 'brace',
  'crow', 'anchor', 'repair', 'bail', 'revive', 'cannon', 'ammo',
]);

export class Match {
  readonly id: string;
  private clients: Map<string, ConnectedClient> = new Map();
  private playersById = new Map<string, Player>();
  private shipsById = new Map<string, Ship>();
  private state!: GameState;
  private t = 0;
  private tickCount = 0;
  /** Monotonic snapshot counter shared by hot + full snapshots (wire field `seq`). */
  private snapshotSeq = 0;
  /** Seconds left on the staged start; 0 once the sim is live. */
  private countdownRemaining = 0;
  /** Last whole second broadcast as a 'match_countdown' tick. */
  private lastCountdownBroadcast = -1;
  /** Countdown-phase tick counter (state.tick stays frozen until the horn). */
  private countdownTick = 0;
  private lastTickWallMs = 0;
  private tickBacklogSec = 0;
  private sharkSpawnCooldown = 0;
  private configuredBotCount = 0;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private endedAt: number | null = null;
  private endReason: MatchEndResult['reason'] | null = null;
  private endResultEmitted = false;
  /** Tracks final stats at the moment of elimination so disconnect-after-elim still has stats. */
  private humanFinalStats: Map<string, { name: string; kills: number; deaths: number; gold: number }> = new Map();
  /** Per-player lifetime-stat deltas accumulated over the match (bots too — only humans persist). */
  private matchStatDeltas = new Map<string, PlayerMatchDeltas>();
  /**
   * TIMES DIED, COUNTED WHERE DYING HAPPENS.
   *
   * The end screen's Deaths column was `state === 'eliminated' ? 1 : 0` — a
   * survival flag wearing a counter's name. A pirate who was cut down four
   * times and respawned each time read 0, and the winner of a bloodbath read 0
   * beside a runner-up's 1. Every death passes through handlePlayerDeath, so
   * that is the one place the tally can be honest, respawns included.
   */
  private matchDeaths = new Map<string, number>();
  /** Order of elimination — earliest first. Used for placement on match end. */
  private eliminationOrder: string[] = [];
  /** Per-death record of a held respawn: when the hold began, and whether it has
   *  already been resolved (converted to a real countdown).
   *
   *  `resolved` is load-bearing. Clearing the record when the hold lifted let a
   *  fresh hold start on the very next tick — the count then advanced one tick
   *  per cap window and a "fixed" blackout still ran for minutes. One hold per
   *  death, one credit per hold; the record dies with the death. */
  private respawnHoldSince = new Map<string, { since: number; resolved: boolean }>();
  /** Sim time each pirate's post-respawn STORM reprieve expires. Not replicated:
   *  the client is told the length once on `player_spawned` and runs its own chip
   *  off a local clock, so the reprieve costs the snapshot nothing.
   *
   *  Weather only. Combat immunity stays respawnProtectionTimer — fifteen seconds
   *  of untouchable would be a boarding tool, not a mercy. */
  private stormGraceUntil = new Map<string, number>();
  /** Hulls whose crew has already been handed the first-sail trim (once per hull,
   *  see applyFirstSailAssist). */
  private firstSailAssisted = new Set<string>();

  // ── Hold cargo / bounty / sunken spoils (see shared/cargo.ts) ──────────
  /** Monotonic source for the short spoil ids that ride the wire ('sp7'). */
  private spoilSeq = 0;
  /** Ships currently carrying a map-wide bounty. Latched with hysteresis so a
   *  crew hovering at the 60% line does not strobe every battle map. */
  private bountiedShipIds = new Set<string>();
  /** Storm phase the standing bounties were last re-cried at. */
  private bountyCriedPhase = -1;
  /** Hull currently holding the Gilded Strongbox — tracked only so the cry goes
   *  up on the tick it changes hands, and not on every tick after. */
  private prizeShipId: string | null = null;

  /** Called once when the match definitively ends (winner found, last ship, or abandoned). */
  onMatchEnd: ((result: MatchEndResult) => void) | null = null;
  /** Called when an in-match client's WebSocket closes — lobby uses this to clean its session. */
  onClientDisconnect: ((playerId: string) => void) | null = null;

  // Systems
  private physics = new PhysicsSystem();
  /** RNG-01: the match's seeded gameplay stream (see makeMatchRng). */
  private readonly rng: () => number;
  private weapons: WeaponSystem;
  private storm: StormSystem;
  private islands = new IslandSystem();
  private trading: TradingSystem;
  private bots: BotSystem;
  /** Dev-only (solo): when true, bots ignore human players + their ships. */
  private botPeace = false;
  /** DEV-01: dev hooks are honoured only when opted in (env or MatchOptions). */
  private readonly devHooks: boolean;
  /** Set the first time a dev hook is honoured; rides MatchEndResult so stats skip the match. */
  private devAssisted = false;
  /** PIRATES_BR_MAP_SEED pins the match RNG (ship spawns, sea rocks, loot rolls).
   *  The islands themselves are already fixed per-entry seeds; this exists so a
   *  perf A/B can measure two builds against a bit-identical match. */
  private mapGen = new MapGenerator(matchSeedFromEnv());
  private readonly joinRng = makeJoinRng();
  private skeletonHomes: Map<string, string> = new Map();
  private skeletonWaveTimers: Map<string, number> = new Map();
  private skeletonSpawnedAt: Map<string, number> = new Map();
  private skeletonDefeatedAt: Map<string, number> = new Map();
  private cutlassChargeByPlayer = new Map<string, number>();
  private cutlassFireHeldByPlayer = new Map<string, boolean>();
  /** Sim time each pirate last had a genuine reason to hold their guard up. A
   *  raised sword rides out input jitter for PLAYER.GUARD_HOLD_GRACE off this
   *  (see updateBlockingState) instead of blinking off for a tick. */
  private guardHeldAt = new Map<string, number>();
  private skeletonNameIndex = 1;
  private shipLastDamagedByPlayer = new Map<string, { attackerId: string; at: number }>();
  /** Per-player: previous frame had jump key held — used for reliable cannon self-launch edge detection. */
  private lastJumpHeldByPlayer = new Map<string, boolean>();
  /** Per-bot cooldown (sim seconds) before the next plank-repair while flooding. */
  private botRepairCooldownAt = new Map<string, number>();
  /** Per-bot cooldown (sim seconds) between finisher swings on downed enemies. */
  private botFinishCooldownAt = new Map<string, number>();
  /** Who downed each DBNO player — bleed-out/finish credit survives env damage
   *  (drowning/fire) that clears lastDamagedById. */
  private downedByPlayer = new Map<string, { attackerId: string | null; at: number; headshot: boolean }>();
  /** playerId → what last took health off them, and when (sim seconds). This is
   *  the death screen's evidence: see DamageSource. */
  private lastDamageSourceById = new Map<string, { source: DamageSource; at: number; tick: number }>();
  /** Scratch: health per player at the start of a subsystem call, so a loss can
   *  be attributed to the system that caused it without every other system
   *  having to grow a reporting channel. */
  private readonly healthWitness = new Map<string, number>();
  /** downedPlayerId → reviverId contributions gathered this tick (humans via
   *  held interact intent, bots via updateBotDbno). */
  private reviveActionsThisTick = new Map<string, string>();
  /** Halyard hold direction per player (locked at hold start) + crew count per
   *  ship this tick (teamwork on the rope speeds the haul, capped 2×). */
  private sailHaulTargetByPlayer = new Map<string, number>();
  private sailHaulCrewThisTick = new Map<string, number>();
  /** Grace window per player so a tool equip can't be instantly undone by the
   *  wheel's double-fire or the shared wheel/weapon digit keys. */
  private readonly lastToolEquip = new Map<string, { tool: EquippableTool; at: number }>();
  /** Ship waterLevel at tick start — floodingRate is published NET of bailing. */
  private waterLevelAtTickStart = new Map<string, number>();
  /** Axe-swing accumulation per player — resets when the target prop changes
   *  or the swing stops (progress is per-prop, not a global charge). */
  private harvestProgressByPlayer = new Map<string, { islandId: string; propId: number; t: number }>();
  /** QUEUED CLIMB per player: sim time until which a [X] at a ladder keeps
   *  trying to put her aboard (see BOARD_LATCH_TIME). */
  private boardLatchUntil = new Map<string, number>();
  /** How long each player's feet have rested on her own deck while the server
   *  still had her un-boarded (gangway walk-on → auto-board). */
  private deckAutoBoardTimer = new Map<string, number>();

  constructor(opts: MatchOptions) {
    this.id = opts.matchId;
    this.configuredBotCount = opts.botCount;
    this.devHooks = opts.devHooks ?? process.env.PIRATES_BR_DEV_HOOKS === '1';
    this.rng = makeMatchRng(opts.matchId);
    this.weapons = new WeaponSystem(this.rng);
    this.storm = new StormSystem(this.rng);
    this.trading = new TradingSystem(this.rng);
    this.bots = new BotSystem(this.rng);
    this.setupWorld(opts.botCount);
  }

  /**
   * Begin the match. With MATCH_START_COUNTDOWN_SEC > 0 the match holds in phase
   * 'waiting' for that long — the sim is frozen and inputs are ignored (tick()
   * only runs the countdown branch) — broadcasting one 'match_countdown' per
   * whole second, then 'match_horn' the instant the sim goes live. At 0 this is
   * the legacy instant start, byte-for-byte.
   */
  start(): void {
    if (this.tickInterval) return;
    this.countdownRemaining = Math.max(0, MATCH_START_COUNTDOWN_SEC);
    if (this.countdownRemaining > 0) {
      this.state.phase = 'waiting';
      this.state.countdownRemaining = this.countdownRemaining;
      this.lastCountdownBroadcast = -1;
    } else {
      this.state.phase = 'playing';
      this.playingSinceWallMs = Date.now();
    }
    this.lastTickWallMs = performance.now();
    this.tickBacklogSec = 0;
    this.tickInterval = setInterval(() => this.runTicks(), SERVER_TICK_MS);
    console.log(`[Match ${this.id}] started — bots: ${this.configuredBotCount}${this.countdownRemaining > 0 ? `, countdown ${this.countdownRemaining}s` : ''}`);
  }

  /** Countdown phase step: broadcast whole-second ticks, then the horn. */
  private tickCountdown(dt: number): void {
    this.countdownRemaining = Math.max(0, this.countdownRemaining - dt);
    this.state.countdownRemaining = this.countdownRemaining;
    // Keep feeding hot snapshots (frozen world, countdownRemaining aboard) —
    // going silent for the whole countdown would read to the client exactly like
    // a dropped connection.
    this.countdownTick++;
    if (this.countdownTick % SNAPSHOT_RATE === 0) {
      const hot = buildHotSnapshot(this.state, this.t, ++this.snapshotSeq);
      this.broadcastVolatile({ type: 'state_hot', ts: Date.now(), payload: hot }, 'hot');
    }
    const whole = Math.ceil(this.countdownRemaining);
    if (whole !== this.lastCountdownBroadcast) {
      this.lastCountdownBroadcast = whole;
      this.broadcast({
        type: 'match_countdown',
        ts: Date.now(),
        payload: {
          secondsRemaining: whole,
          totalSeconds: MATCH_START_COUNTDOWN_SEC,
          crews: this.state.shipsAlive,
        },
      });
    }
    if (this.countdownRemaining > 0) return;
    this.state.phase = 'playing';
    this.playingSinceWallMs = Date.now();
    this.state.countdownRemaining = 0;
    this.preHoistSailsAtHorn();
    this.broadcast({
      type: 'match_horn',
      ts: Date.now(),
      payload: { crews: this.state.shipsAlive },
    });
  }

  /**
   * The horn drops canvas on every berthed hull — the ANCHOR STAYS DOWN.
   *
   * Cold start was: board, find the capstan, weigh anchor, then stand at the
   * halyard for another haul before the ship so much as drifts. Half of that is
   * pure setup nobody chose. Sails at half is the state a ship is left in at a
   * berth anyway; with the anchor down PhysicsSystem pins targetSpeed at 0, so
   * she does not move a metre until the captain says so.
   *
   * The anchor is deliberately NOT touched: `getShipGangwayPlan` returns null
   * for an unanchored ship, so raising it here would delete the dock gangway
   * out from under a player who is walking down it.
   */
  private preHoistSailsAtHorn(): void {
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      ship.sailHeight = Math.max(ship.sailHeight, Math.min(0.5, ship.sailIntegrity));
    }
  }

  /**
   * Fixed-step sim driven by a wall-clock accumulator. setInterval fires late
   * under load, so we run enough fixed-dt steps per callback for sim time to
   * track wall time, capped at MAX_CATCHUP_TICKS to avoid a death spiral.
   *
   * Dropping the surplus backlog is the right call — grinding it out is the death
   * spiral — but it is also the mechanism that turns CPU starvation into SILENT
   * slow motion. Every dropped tick is a second of match that will never be
   * simulated, and nothing used to say so: an observed match ran at ~7% real time
   * with a clean log. So count what we throw away and say it out loud.
   */
  private runTicks() {
    const now = performance.now();
    this.tickBacklogSec += (now - this.lastTickWallMs) / 1000;
    this.lastTickWallMs = now;
    const step = SERVER_TICK_MS / 1000;
    let steps = 0;
    while (this.tickBacklogSec >= step && steps < MAX_CATCHUP_TICKS) {
      this.tickBacklogSec -= step;
      this.tick();
      steps++;
    }
    // After an extreme stall, drop the surplus backlog instead of grinding through it.
    if (this.tickBacklogSec > step * MAX_CATCHUP_TICKS) {
      const dropped = Math.floor((this.tickBacklogSec - step * MAX_CATCHUP_TICKS) / step);
      this.tickBacklogSec = step * MAX_CATCHUP_TICKS;
      this.noteDroppedTicks(dropped);
    }
  }

  /** Ticks this match owed and will never run — the sim-dilation counter. */
  private droppedTicks = 0;
  /** Wall ms of the last dilation warning, so a starved host logs once a second
   *  instead of sixty times a second (which would itself cost sim time). */
  private lastDeficitWarnAt = 0;

  private noteDroppedTicks(dropped: number): void {
    if (dropped <= 0) return;
    this.droppedTicks += dropped;
    const now = Date.now();
    if (now - this.lastDeficitWarnAt < 1000) return;
    this.lastDeficitWarnAt = now;
    const behind = (this.droppedTicks * SERVER_TICK_MS) / 1000;
    console.warn(
      `[Match ${this.id.slice(0, 6)}] SIM DILATION — dropped ${dropped} tick(s) this callback,`
      + ` ${this.droppedTicks} total (${behind.toFixed(1)}s of match never simulated);`
      + ` sim clock ${this.simLagSeconds().toFixed(1)}s behind wall`,
    );
  }

  /**
   * How far the sim clock has fallen behind the wall clock since the horn.
   * Nonzero means players are living in slow motion — the single number that
   * makes an overloaded host visible from outside the process.
   */
  simLagSeconds(): number {
    if (this.playingSinceWallMs === null) return 0;
    const wallElapsed = (Date.now() - this.playingSinceWallMs) / 1000;
    return Math.max(0, wallElapsed - this.t);
  }

  /** Total ticks dropped by the catch-up cap over this match's life. */
  droppedTickCount(): number { return this.droppedTicks; }

  /** Wall ms at which the sim went live, or null while still counting down. */
  private playingSinceWallMs: number | null = null;

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    for (const client of this.clients.values()) {
      try {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.close(1000, 'match closed');
      } catch {}
    }
    this.clients.clear();
  }

  isPlaying(): boolean { return this.state?.phase === 'playing'; }
  isEnded(): boolean { return this.state?.phase === 'ended'; }
  endedAtMs(): number | null { return this.endedAt; }
  humanCount(): number { return this.clients.size; }

  /** Detach a client from the match (for return-to-menu) without destroying the match. */
  detachClient(playerId: string): void {
    this.removeClient(playerId, /*closeWs*/ false);
  }

  private setupWorld(botCount: number) {
    const islandList = this.mapGen.generateIslands();
    const spawns = this.mapGen.generateShipSpawns(islandList);
    const wildlife = this.mapGen.generateWildlife(islandList);
    // Uncharted sea micro-POIs: fixed sites in the biggest dead-water voids.
    // Their barrels are filed on the nearest island (so every loot path works
    // unchanged) and the lone mast's shoal is seeded into the rock field before
    // the drifting rocks are drawn, so nothing ever lands on top of it.
    const seaPois = this.mapGen.generateSeaPois(islandList);
    this.mapGen.attachSeaPoiLoot(seaPois, islandList);
    const seaRocks = this.mapGen.generateSeaRocks(islandList, spawns, seaPois);

    const ships: Ship[] = [];
    const players: Player[] = [];

    // Create bot ships. Their captains are named from the Reach's own roster
    // (MapGenerator.generateBotCrewNames) — the world has a barkeep, a
    // gravedigger and a Tallyman with full names on every isle, and the crews
    // you actually fight were Pirate_1 … Pirate_9.
    const crewNames = this.mapGen.generateBotCrewNames(Math.min(botCount, spawns.length));
    for (let i = 0; i < Math.min(botCount, spawns.length); i++) {
      const spawn = spawns[i];
      const botId = uuid();
      const shipId = uuid();
      const ship = this.mapGen.buildShip(shipId, botId, spawn, TEAM_COLORS[i % TEAM_COLORS.length]);
      ships.push(ship);

      const bot = this.createPlayer(botId, crewNames[i] ?? `Pirate_${i + 1}`, shipId, true);
      bot.position = this.getRespawnDeckPosition(ship);
      bot.rotation.x = ship.rotation;
      bot.rotation.y = 0;
      bot.onShipId = shipId;
      bot.state = 'alive';
      bot.velocity = { x: 0, y: 0, z: 0 };
      bot.knockbackVelocity = { x: 0, y: 0, z: 0 };
      players.push(bot);

      const diff = i < 5 ? 'easy' : i < 12 ? 'medium' : 'hard';
      this.bots.registerBot(bot, ship, diff);
    }

    this.setupSkeletonWaves(islandList);
    // The storm samples terrain when picking late ring centres (see
    // StormSystem.pickNextSafeCenter) — must be set before buildInitialState.
    this.storm.setIslands(islandList);

    this.state = {
      phase: 'waiting',
      tick: 0,
      serverTime: 0,
      shipsAlive: ships.length,
      storm: this.storm.buildInitialState(),
      ships,
      players,
      projectiles: [],
      kegs: [],
      wildlife,
      seaRocks,
      islands: islandList,
      tradeSessions: [],
      sharks: [],
      spoils: [],
      seaPois,
      wreck: null,
      winnerId: null,
    };
    this.rebuildEntityIndexes();
  }

  private createPlayer(id: string, name: string, shipId: string | null, isBot: boolean): Player {
    return {
      id,
      name,
      shipId,
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: PLAYER.MAX_HEALTH,
      state: 'alive',
      weapons: this.weapons.createDefaultWeapons(),
      activeSlot: 0,
      reloading: false,
      reloadTimer: 0,
      knockbackVelocity: { x: 0, y: 0, z: 0 },
      isBot,
      kills: 0,
      playerKillStreak: 0,
      superCannonballs: 0,
      megaKegs: 0,
      tsunamiCharges: 0,
      gold: 0,
      carryingChestId: null,
      treasureMapIslandId: null,
      questMaps: [],
      swimTimer: 0,
      atCannon: false,
      atHelm: false,
      atCrowNest: false,
      blocking: false,
      bailing: false,
      cutlassCharge: 0,
      cannonIndex: 0,
      nearChestId: null,
      nearShipId: null,
      onShipId: shipId,
      respawnTimer: 0,
      respawnProtectionTimer: 0,
      shipBoundaryGraceTimer: 0,
      lastDamagedById: null,
      lastDamagedAt: null,
      lastDamageWasHeadshot: false,
      selectedCannonAmmo: 'cannonball',
      kegs: PLAYER.STARTING_KEGS,
      kegCooldown: 0,
      cannonFlightTimer: 0,
      cannonBallistic: false,
      pocketBanana: 4,
      pocketWood: 0,
      pocketCoconut: 0,
      pocketMango: 0,
      pocketMeat: 0,
      pocketMeatByType: {},
      pocketOre: 0,
      mastClimb: null,
      crouching: false,
      armor: 0,
      pocketUseCooldown: 0,
      hasShovel: true,
      hasSpyglass: true,
      equippedTool: null,
      bailScoopProgress: 0,
      hullRepairProgress: 0,
      bucketFilled: false,
      nearBarrelId: null,
      downedUntil: 0,
      reviveProgress: 0,
    };
  }

  private rebuildEntityIndexes() {
    this.playersById = new Map(this.state.players.map((player) => [player.id, player]));
    this.shipsById = new Map(this.state.ships.map((ship) => [ship.id, ship]));
  }

  private getPlayer(playerId: string | null | undefined): Player | null {
    return playerId ? this.playersById.get(playerId) ?? null : null;
  }

  private getShip(shipId: string | null | undefined): Ship | null {
    return shipId ? this.shipsById.get(shipId) ?? null : null;
  }

  private getAliveShip(shipId: string | null | undefined): Ship | null {
    const ship = this.getShip(shipId);
    return ship && ship.alive && !ship.sinking ? ship : null;
  }

  private pickHumanSpawn(spawns: ShipSpawn[]): ShipSpawn | null {
    let bestSpawn: ShipSpawn | null = null;
    let bestDistance = -Infinity;

    for (const spawn of spawns) {
      let nearestShipDistance = Infinity;
      for (const ship of this.state.ships) {
        if (!ship.alive || ship.sinking) continue;
        nearestShipDistance = Math.min(
          nearestShipDistance,
          dist2D(spawn.position.x, spawn.position.z, ship.position.x, ship.position.z),
        );
      }
      if (nearestShipDistance > bestDistance) {
        bestDistance = nearestShipDistance;
        bestSpawn = spawn;
      }
    }

    return bestSpawn ?? spawns[0] ?? null;
  }

  private pickSafeSpawnDock(): IslandDock | null {
    const candidates: IslandDock[] = [];
    const { centerX, centerZ, safeRadius } = this.state.storm;

    for (const island of this.state.islands) {
      const dock = island.dock;
      if (!dock) continue;
      if (dist2D(dock.respawnPoint.x, dock.respawnPoint.z, centerX, centerZ) >= safeRadius - 50) continue;

      const occupied = this.state.ships.some((ship) => (
        ship.alive
        && !ship.sinking
        && dist2D(ship.position.x, ship.position.z, dock.berthPosition.x, dock.berthPosition.z) < 42
      ));
      if (!occupied) candidates.push(dock);
    }

    return candidates.length > 0
      ? candidates[Math.floor(this.joinRng() * candidates.length)]
      : null;
  }

  private getNextTeamColor() {
    const usedColors = new Set(this.state.ships.map((ship) => ship.teamColor));
    return TEAM_COLORS.find((color) => !usedColors.has(color))
      ?? TEAM_COLORS[this.state.ships.length % TEAM_COLORS.length];
  }

  private statsDelta(playerId: string): PlayerMatchDeltas {
    let delta = this.matchStatDeltas.get(playerId);
    if (!delta) {
      delta = {
        shipsSunk: 0,
        chestsSold: 0,
        chestsDug: 0,
        sharksKilled: 0,
        skeletonsKilled: 0,
        bestKillStreak: 0,
        woodChopped: 0,
        oreMined: 0,
        damageDealt: 0,
        headshots: 0,
        joinedAtSimTime: this.t,
        leftAtSimTime: null,
      };
      this.matchStatDeltas.set(playerId, delta);
    }
    return delta;
  }

  /**
   * Add a human to this match and send their join message immediately.
   * Lobby owns the WebSocket lifecycle (message routing, close handler) — it MUST
   * call removeClient(playerId) on disconnect or detach.
   */
  addHumanClient(ws: WebSocket, name: string): { playerId: string; shipId: string; snapshot: GameState } {
    return this.createHumanClient(ws, name).send();
  }

  /**
   * Spawn + register the human and BUILD their join message without sending it.
   * The lobby needs the two-step so it can emit 'match_start' (which tears down
   * the menu) only once the join payload definitely exists — and so
   * expectedHumans is the real count instead of humanCount()+1.
   */
  createHumanClient(ws: WebSocket, name: string): {
    playerId: string;
    shipId: string;
    send: () => { playerId: string; shipId: string; snapshot: GameState };
  } {
    const playerId = uuid();
    const displayName = (name || '').trim().slice(0, 24) || 'Pirate';

    const spawns = this.mapGen.generateShipSpawns(this.state.islands);
    const berth = this.pickHumanSpawn(spawns) ?? {
      position: { x: randRange(-600, 600, this.rng), y: 0, z: randRange(-600, 600, this.rng) },
      rotation: randAngle(this.rng),
      type: 'sloop' as const,
    };
    // HULLS ARE CREW-SCALED. The spawn table rolls sloop/brigantine/galleon for
    // the world's variety, and a lone player drawing a Man-o'-War inherits eight
    // guns nobody can man, three masts to haul alone and the worst turn rate in
    // the Reach — the ship is balanced around a crew that does not exist. One
    // pirate sails a Cutter; the ladder is here for the day crews share a hull.
    const spawn = { ...berth, type: hullForCrewSize(1) };

    const shipId = uuid();
    const ship = this.mapGen.buildShip(shipId, playerId, spawn, this.getNextTeamColor());
    ship.crewIds = [playerId];
    this.state.ships.push(ship);

    const player = this.createPlayer(playerId, displayName, shipId, false);
    const spawnDock = this.pickSafeSpawnDock();
    if (spawnDock) {
      this.parkShipAtDock(ship, spawnDock);
      player.position = {
        x: spawnDock.respawnPoint.x,
        y: spawnDock.respawnPoint.y + 0.2,
        z: spawnDock.respawnPoint.z,
      };
      player.onShipId = null;
    } else {
      player.position = {
        x: spawn.position.x,
        y: ship.position.y + SHIP_STATS[spawn.type].height + 0.5,
        z: spawn.position.z,
      };
      player.onShipId = shipId;
    }

    this.state.players.push(player);
    this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;
    this.rebuildEntityIndexes();
    this.statsDelta(playerId); // stamp join sim-time for playSeconds (match start = 0, late join > 0)

    const client: ConnectedClient = {
      ws,
      playerId,
      name: displayName,
      lastInput: null,
      joinedAt: Date.now(),
      killsAtJoin: 0,
      deathsAtJoin: 0,
      consumedSeq: {
        interact: -1,
        trade: -1,
        wheel: -1,
        reload: -1,
        jump: -1,
        placeKeg: -1,
        dropChest: -1,
        special: -1,
        cannonAmmo: -1,
        slot: -1,
        barrelTakeAll: -1,
        bail: -1,
        selectMap: -1,
      },
      lastOneShotAt: {},
      appliedInputSeq: null,
      oneShotPendingSince: null,
      lastRefusalAt: -Infinity,
      pendingFullSnapshot: null,
    };
    this.clients.set(playerId, client);

    // The join snapshot goes out through the SAME wire encoder as every later
    // full snapshot: raw buildSnapshot was ~310KB (vs ~214KB quantized) and its
    // unquantized floats disagreed with the quantized stream that followed.
    const snapshot = buildWireSnapshot(this.buildSnapshot(true), true);
    return {
      playerId,
      shipId,
      send: () => {
        this.send(ws, {
          type: 'join',
          ts: Date.now(),
          payload: { playerId, shipId, snapshot, matchId: this.id },
        });
        console.log(`[Match ${this.id}] human joined: ${displayName} (${playerId.slice(0, 6)}); humans=${this.clients.size}`);
        return { playerId, shipId, snapshot };
      },
    };
  }

  /**
   * Lobby calls this on WS close OR when the client returns to menu.
   * If closeWs=true the client's WS is also closed.
   */
  removeClient(playerId: string, closeWs: boolean = false): void {
    const client = this.clients.get(playerId);
    if (!client) return;
    this.clients.delete(playerId);

    const leaverDelta = this.matchStatDeltas.get(playerId);
    if (leaverDelta && leaverDelta.leftAtSimTime === null) leaverDelta.leftAtSimTime = this.t;

    const player = this.playersById.get(playerId);
    if (player && !this.humanFinalStats.has(playerId)) {
      this.humanFinalStats.set(playerId, {
        name: player.name,
        kills: player.kills,
        deaths: player.state === 'eliminated' ? 1 : 0,
        gold: player.gold,
      });
    } else if (!player && client.name && !this.humanFinalStats.has(playerId)) {
      this.humanFinalStats.set(playerId, {
        name: client.name,
        kills: 0,
        deaths: 0,
        gold: 0,
      });
    }

    const removedShipIds = new Set(
      this.state.ships
        .filter((ship) => ship.ownerId === playerId)
        .map((ship) => ship.id),
    );
    for (const other of this.state.players) {
      if (other.id === playerId || !other.onShipId || !removedShipIds.has(other.onShipId)) continue;
      other.onShipId = null;
      other.nearShipId = null;
      other.state = other.state === 'eliminated' || other.state === 'respawning' ? other.state : 'swimming';
      this.clearStationFlags(other);
    }
    this.state.ships = this.state.ships.filter(s => s.ownerId !== playerId);
    this.state.players = this.state.players.filter(p => p.id !== playerId);
    this.state.kegs = this.state.kegs.filter((keg) => !keg.shipId || !removedShipIds.has(keg.shipId));
    this.state.tradeSessions = this.state.tradeSessions.filter((session) => (
      session.initiatorId !== playerId
      && session.targetPlayerId !== playerId
      && !removedShipIds.has(session.initiatorShipId)
      && !removedShipIds.has(session.targetShipId)
    ));
    this.lastJumpHeldByPlayer.delete(playerId);
    this.boardLatchUntil.delete(playerId);
    this.deckAutoBoardTimer.delete(playerId);
    this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;
    this.rebuildEntityIndexes();

    if (closeWs) {
      try { client.ws.close(1000, 'removed from match'); } catch {}
    }

    console.log(`[Match ${this.id}] client removed: ${playerId.slice(0, 6)}; humans=${this.clients.size}`);

    // If everyone left and we never officially ended, abandon the match.
    if (this.clients.size === 0 && this.state.phase === 'playing') {
      this.endMatchAbandoned();
    }
  }

  /** Lobby forwards in-match game messages here. */
  handleClientMessage(playerId: string, msg: NetMsg): void {
    const client = this.clients.get(playerId);
    if (!client) return;
    this.handleMessage(client, msg);
  }

  private endMatchAbandoned(): void {
    if (this.endResultEmitted) return;
    this.state.phase = 'ended';
    this.endedAt = Date.now();
    this.endReason = 'abandoned';
    this.emitMatchEnd();
  }

  private emitMatchEnd(): void {
    if (this.endResultEmitted) return;
    this.endResultEmitted = true;

    const winnerPlayer = this.state.winnerId ? this.playersById.get(this.state.winnerId) ?? null : null;

    const allHumanIds = new Set<string>([
      ...Array.from(this.humanFinalStats.keys()),
      ...this.state.players.filter((p) => !p.isBot).map((p) => p.id),
    ]);
    // Rank the whole fleet FIRST, then read every human's placement out of it.
    // The old human-only counter handed the single human in a solo-vs-bots
    // match placement 1 whatever happened to her — so "best placement" was a
    // lifetime stat that could never be anything but 1st.
    const board = this.buildEndBoard(winnerPlayer);
    const boardPlacement = new Map(board.map((row) => [row.playerId, row.placement]));
    const placements: MatchHumanResult[] = [];
    const seen = new Set<string>();

    const pushHuman = (playerId: string, isWinner: boolean) => {
      if (seen.has(playerId)) return;
      seen.add(playerId);
      const live = this.playersById.get(playerId);
      const final = this.humanFinalStats.get(playerId);
      const name = live?.name ?? final?.name ?? this.clients.get(playerId)?.name ?? 'Pirate';
      const deaths = this.matchDeaths.get(playerId)
        ?? final?.deaths
        ?? (live?.state === 'eliminated' ? 1 : 0);
      const gold = live?.gold ?? final?.gold ?? 0;
      const delta = this.matchStatDeltas.get(playerId);
      // The LIFETIME kills stat is PvP only: the in-match scoreboard counts
      // skeletons too, but persisting that would let the front-page K/D be
      // farmed off endlessly-respawning island waves (skeletonsKilled is its
      // own panel stat).
      const scoreboardKills = live?.kills ?? final?.kills ?? 0;
      const kills = Math.max(0, scoreboardKills - (delta?.skeletonsKilled ?? 0));
      placements.push({
        playerId,
        name,
        kills,
        deaths,
        gold,
        placement: boardPlacement.get(playerId) ?? placements.length + 1,
        isWinner,
        ...(delta ? {
          shipsSunk: delta.shipsSunk,
          chestsSold: delta.chestsSold,
          chestsDug: delta.chestsDug,
          sharksKilled: delta.sharksKilled,
          skeletonsKilled: delta.skeletonsKilled,
          bestKillStreak: delta.bestKillStreak,
          woodChopped: delta.woodChopped,
          oreMined: delta.oreMined,
          damageDealt: delta.damageDealt,
          headshots: delta.headshots,
          playSeconds: Math.max(0, (delta.leftAtSimTime ?? this.t) - delta.joinedAtSimTime),
        } : {}),
      });
    };

    if (winnerPlayer && !winnerPlayer.isBot) pushHuman(winnerPlayer.id, true);

    const remainingLiving = this.state.players
      .filter((p) => !p.isBot && !seen.has(p.id) && p.state !== 'eliminated')
      .sort((a, b) => b.gold - a.gold);
    for (const p of remainingLiving) pushHuman(p.id, false);

    for (const elimId of [...this.eliminationOrder].reverse()) {
      if (allHumanIds.has(elimId)) pushHuman(elimId, false);
    }

    for (const id of allHumanIds) pushHuman(id, false);

    const result: MatchEndResult = {
      matchId: this.id,
      winnerId: this.state.winnerId,
      winnerName: winnerPlayer?.name ?? null,
      reason: this.endReason ?? 'last_ship',
      humans: placements,
      board,
      crewCount: board.length,
      devAssisted: this.devAssisted,
    };
    this.broadcast({ type: 'match_ended', ts: Date.now(), payload: result });
    this.onMatchEnd?.(result);
  }

  /**
   * THE WHOLE FLEET, RANKED ONCE.
   *
   * Same ordering rule the human placements use, applied to every crew in the
   * match so the number the end screen prints ("Place: #6 of 10") is a real
   * standing and not a count of the humans who happened to be logged in:
   *
   *   1. the winner, if there is one;
   *   2. everyone still afloat, richest first — surviving beats dying, and
   *      between survivors the gold race is the tiebreak the match was about;
   *   3. the eliminated, LAST death first — outlasting is the ranking.
   *
   * Skeletons are excluded. They are `isBot` Players like the crews are, but
   * they are island wildlife with a home cave, not a hull in the running; a
   * board with eleven rows of "Skeleton" in it is worse than no board.
   * Humans who disconnected mid-match keep their row from humanFinalStats —
   * quitting is not a way to vanish off the scoreboard.
   */
  private buildEndBoard(winnerPlayer: Player | null): MatchBoardRow[] {
    const crewIds: string[] = [];
    const pushId = (id: string) => { if (!crewIds.includes(id)) crewIds.push(id); };
    for (const p of this.state.players) {
      if (this.isSkeletonPlayer(p)) continue;
      pushId(p.id);
    }
    // A human who left after being eliminated is gone from state.players but
    // still finished ahead of whoever died before them.
    for (const id of this.humanFinalStats.keys()) pushId(id);

    const rowFor = (playerId: string): MatchBoardRow => {
      const live = this.playersById.get(playerId);
      const final = this.humanFinalStats.get(playerId);
      const delta = this.matchStatDeltas.get(playerId);
      const scoreboardKills = live?.kills ?? final?.kills ?? 0;
      return {
        playerId,
        name: live?.name ?? final?.name ?? this.clients.get(playerId)?.name ?? 'Pirate',
        // PvP only, exactly as the persisted human row reads it: skeleton waves
        // respawn forever and would otherwise decide the scoreboard.
        kills: Math.max(0, scoreboardKills - (delta?.skeletonsKilled ?? 0)),
        deaths: this.matchDeaths.get(playerId) ?? final?.deaths ?? 0,
        gold: live?.gold ?? final?.gold ?? 0,
        placement: 0,
        isWinner: !!winnerPlayer && winnerPlayer.id === playerId,
        isBot: live?.isBot ?? false,
        alive: !!live && live.state !== 'eliminated',
      };
    };

    const rows = crewIds.map(rowFor);
    const byId = new Map(rows.map((r) => [r.playerId, r]));
    const ordered: MatchBoardRow[] = [];
    const taken = new Set<string>();
    const take = (id: string) => {
      const row = byId.get(id);
      if (!row || taken.has(id)) return;
      taken.add(id);
      ordered.push(row);
    };

    if (winnerPlayer) take(winnerPlayer.id);
    for (const row of rows.filter((r) => r.alive && !taken.has(r.playerId)).sort((a, b) => b.gold - a.gold)) {
      take(row.playerId);
    }
    for (const id of [...this.eliminationOrder].reverse()) take(id);
    // Anything the two passes above missed (a crew that never entered the
    // elimination order and is not marked alive) still gets a row, by gold.
    for (const row of rows.filter((r) => !taken.has(r.playerId)).sort((a, b) => b.gold - a.gold)) {
      take(row.playerId);
    }

    ordered.forEach((row, i) => { row.placement = i + 1; });
    return ordered;
  }

  private handleMessage(client: ConnectedClient, msg: NetMsg) {
    switch (msg.type) {
      case 'player_input': {
        const input = this.sanitizeInput(msg.payload);
        if (input) client.lastInput = this.carryUnreadOneShots(client, input);
        break;
      }
      case 'trade_action': {
        // Shape-check like player_input's sanitizeInput: the unvalidated cast
        // crashed the process on hostile payloads (null action, non-array offer).
        const p = msg.payload as TradeActionPayload | null;
        if (!p || typeof p !== 'object' || typeof p.action !== 'string') break;
        if (p.offer !== undefined && !Array.isArray(p.offer)) break;
        this.handleTradeAction(client.playerId, p);
        break;
      }
      case 'dev_grant_gold': {
        // Dev/testing convenience with the SAME solo guard as dev bot-peace: a
        // match with more than one human never honours it, so it can't be used
        // to hand yourself the 9000g win in a real lobby. It exists because the
        // hold-cargo loop (ballast, bounty, spill) is otherwise only reachable
        // after an hour of chest runs, which no live probe can afford.
        if (!this.devHooks) { console.log(`[Match ${this.id}] ${msg.type} refused: PIRATES_BR_DEV_HOOKS unset`); break; }
        if (this.clients.size <= 1) {
          const requested = Number((msg.payload as { gold?: number } | null)?.gold);
          if (Number.isFinite(requested)) {
            const player = this.getPlayer(client.playerId);
            if (player) {
              player.gold = Math.max(0, Math.min(ECONOMY.GOLD_WIN_TARGET * 2, Math.floor(requested)));
              this.devAssisted = true;
              this.updateCargoAndBounty();
            }
          }
        }
        break;
      }
      case 'dev_bot_peace': {
        // Dev/testing convenience — only honoured when a single human is in the
        // match (solo), so it can't be abused to disable bot aggression in a real
        // multiplayer game.
        if (!this.devHooks) { console.log(`[Match ${this.id}] ${msg.type} refused: PIRATES_BR_DEV_HOOKS unset`); break; }
        if (this.clients.size <= 1) {
          this.botPeace = !!(msg.payload as { enabled?: boolean } | null)?.enabled;
          this.devAssisted = true;
          console.log(`[Match ${this.id}] dev bot-peace ${this.botPeace ? 'ON' : 'OFF'}`);
        }
        break;
      }
    }
  }

  private clearStationFlags(player: Player) {
    player.atCannon = false;
    player.atHelm = false;
    player.atCrowNest = false;
    player.mastClimb = null;
    player.blocking = false;
    player.bailing = false;
    player.cutlassCharge = 0;
  }

  private isStationOccupied(
    ship: Ship,
    station: 'helm' | 'crow' | 'cannon',
    playerId: string,
    cannonIndex: number | null = null,
  ) {
    return this.state.players.some((other) => {
      if (other.id === playerId || other.onShipId !== ship.id) return false;
      if (other.state === 'eliminated' || other.state === 'respawning') return false;
      switch (station) {
        case 'helm':
          return other.atHelm;
        case 'crow':
          // The ladder is single-file too — a climber en route reserves the nest.
          return other.atCrowNest || other.mastClimb !== null;
        case 'cannon':
          return other.atCannon && other.cannonIndex === cannonIndex;
      }
    });
  }

  private enterHelm(player: Player, ship: Ship): boolean {
    if (ship.sinking) return false;
    if (this.isStationOccupied(ship, 'helm', player.id)) return false;
    this.clearStationFlags(player);
    player.atHelm = true;
    this.snapPlayerToHelm(player, ship);
    return true;
  }

  /** Mount the mast ladder at its base — no teleport. The climb itself runs in
   *  applyInput (W/S drives mastClimb) with PhysicsSystem pinning the body to
   *  the ladder line; reaching the top hands off to the walkable nest. */
  private startMastClimb(player: Player, ship: Ship): boolean {
    if (ship.sinking) return false;
    if (player.isBot) return false; // bots have no ladder AI — keep them off it
    if (this.isStationOccupied(ship, 'crow', player.id)) return false;
    this.clearStationFlags(player);
    player.mastClimb = 0;
    return true;
  }

  private enterCannon(player: Player, ship: Ship, cannonIndex: number, yaw: number, pitch: number): boolean {
    if (ship.sinking) return false;
    if (this.isStationOccupied(ship, 'cannon', player.id, cannonIndex)) return false;
    this.clearStationFlags(player);
    player.atCannon = true;
    player.cannonIndex = cannonIndex;
    const aim = getConstrainedCannonAim(ship, cannonIndex, yaw, pitch);
    player.rotation.x = aim.yaw;
    player.rotation.y = aim.pitch;
    this.snapPlayerToCannon(player, ship, cannonIndex);
    return true;
  }

  private tick() {
    const dt = SERVER_TICK_MS / 1000;

    // Staged start: sim time itself is frozen so the storm clock, playSeconds and
    // the wave clock all begin at the horn, not at match creation. Only start()
    // arms the countdown, so with MATCH_START_COUNTDOWN_SEC = 0 this branch never
    // runs and tick() behaves exactly as it did before the staged start existed.
    if (this.state.phase === 'waiting' && this.countdownRemaining > 0) {
      this.tickCountdown(dt);
      return;
    }

    this.t += dt;
    this.tickCount++;
    this.state.tick++;
    // ONE SUNSET PER MATCH. The sky used to run a free 16-minute cycle off the
    // client's own render clock, so a match that opens at noon is in pitch dark
    // four minutes later — new players learned the stations in night rain while
    // the storm was still in its grace period. The server publishes how far
    // through the storm arc this match is (0 at the horn, 1 at the final ring)
    // and the renderer hangs the sun on THAT: mid-morning at the horn, dusk with
    // the late phases. Display only — nothing in the sim reads it.
    this.state.matchProgress = Math.round(
      Math.max(0, Math.min(1, this.t / STORM_ARC_SECONDS)) * 1e4,
    ) / 1e4;

    if (this.state.phase === 'ended') {
      // Keep end-screen clients live at a slow cadence so spectate/placement
      // views don't freeze at the last pre-end snapshot.
      if (this.tickCount % ENDED_SNAPSHOT_TICKS === 0) {
        const snap = buildWireSnapshot(this.buildSnapshot(false), false);
        this.broadcastVolatile({ type: 'state_snapshot', ts: Date.now(), payload: snap }, 'full');
      }
      return;
    }
    if (this.state.phase !== 'playing') return;
    this.state.serverTime = this.t;

    // Pre-tick water levels — floodingRate is published NET of bailing at the
    // end of the tick (bailers seeing a red "rising" arrow while winning was
    // inverted feedback).
    this.waterLevelAtTickStart.clear();
    for (const ship of this.state.ships) {
      if (ship.alive && !ship.sinking) this.waterLevelAtTickStart.set(ship.id, ship.waterLevel ?? 0);
    }

    this.updateRespawns(dt);

    for (const player of this.state.players) {
      if (player.kegCooldown > 0) player.kegCooldown = Math.max(0, player.kegCooldown - dt);
      if (player.pocketUseCooldown > 0) player.pocketUseCooldown = Math.max(0, player.pocketUseCooldown - dt);
    }

    // Apply player inputs
    for (const [, client] of this.clients) {
      if (client.lastInput) {
        this.applyInput(client, client.lastInput, dt);
      }
    }

    // Ship rotation integration + rudder decay for unhelmed ships lives in
    // PhysicsSystem.updateShips so external impulses turn every hull.

    // Weigh every hold and re-read the bounty board BEFORE bots choose targets
    // and before physics integrates — a laden hull must sail at laden speed on
    // the very tick her cargo changed.
    this.updateCargoAndBounty();

    // Dev-only bot-peace (solo testing): bots ignore the human + their ship as
    // targets while still fighting each other. Empty sets = normal aggression.
    if (this.botPeace) {
      const peaceShips = new Set<string>();
      const peacePlayers = new Set<string>();
      for (const p of this.state.players) {
        if (p.isBot) continue;
        peacePlayers.add(p.id);
        if (p.shipId) peaceShips.add(p.shipId);
        if (p.onShipId) peaceShips.add(p.onShipId);
      }
      this.bots.setPeace(peaceShips, peacePlayers);
    } else {
      this.bots.setPeace([], []);
    }

    // Update bots
    this.bots.update(
      dt, this.t,
      this.state.players,
      this.state.ships,
      this.state.islands,
      this.state.storm,
      this.weapons,
      this.state.seaRocks,
    );
    // Resolve any personal-weapon shots fired by bots this tick.
    for (const shot of this.bots.flushFirearmShots()) {
      const shooter = this.playersById.get(shot.playerId);
      if (!shooter || shooter.state === 'eliminated') continue;
      const ship = this.getAliveShip(shooter.shipId);
      const traces = this.weapons.tryFire(
        shooter, ship, shot.yaw, shot.pitch, 0,
        { aiming: false, aimPoint: shot.aimPoint },
      );
      if (traces.length > 0) this.resolveFirearmHits(shooter, traces);
    }
    this.updateSkeletonWaves(dt);
    this.updateIslandSkeletons(dt);
    this.processBotLooting();
    this.updateBotFlooding(dt);
    this.updateBotDbno(dt);
    this.updateDownedAndRevives(dt);

    // Update weapon reloads
    this.weapons.update(dt, this.state.players);
    this.weapons.tickCannons(dt, this.state.ships);

    // Flush new projectiles
    const newProjs = this.weapons.flushProjectiles();
    this.state.projectiles.push(...newProjs);

    // Physics — storm state rides along so every wave sample (buoyancy,
    // attitude, flooding waterlines, swimmers, projectiles) sees storm seas.
    this.syncTreasureChests();
    this.beginHealthWitness();
    this.physics.update(
      dt, this.t,
      this.state.ships,
      this.state.players,
      this.state.projectiles,
      this.state.islands,
      this.state.seaRocks,
      this.state.storm,
    );
    // The relay runs FIRST so bullets and cannonballs name themselves; whatever
    // health is still missing after it was drowning, fire or the ground.
    this.relayPendingCombatEvents();
    this.endHealthWitness((player) => this.resolvePhysicsDamageSource(player));
    this.syncTreasureChests();

    // Publish the net bilge trend (ingress − bailing) for the client gauge.
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      const before = this.waterLevelAtTickStart.get(ship.id);
      if (before === undefined) continue;
      const net = ((ship.waterLevel ?? 0) - before) / dt;
      ship.floodingRate = Math.abs(net) < 1e-6 ? 0 : net;
    }

    this.updateSharks(dt);
    this.updateWildlife(dt);
    // Sunken cargo: claimable by any swimmer, taken by the tide on a timer.
    this.updateSpoils();

    // Storm — routes through openHole so the tempest punches real holes into
    // the seaward face (holes + flooding), the SoT damage loop.
    this.beginHealthWitness();
    this.storm.update(dt, this.state.storm, this.state.ships, this.state.players, {
      openHoleAt: (ship, local, count) => { this.physics.openHoleAt(ship, local, count, 'storm'); },
      // Physics already worked out who is sheltered this tick (it runs first) —
      // one answer for seabed, reef and tempest alike.
      isSheltered: (shipId) => this.physics.isEnvironmentallySheltered(shipId),
      // The post-respawn reprieve: a pirate who just came back inside the wall
      // gets STORM_RESPAWN_GRACE_SECONDS to make sail instead of a second death.
      hasStormGrace: (playerId) => this.hasStormGrace(playerId),
    });
    // Nothing else in that call can take health off a pirate, so every loss
    // across it is the tempest — including the one that swims back inside the
    // ring afterwards and used to be filed as a drowning.
    //
    // EXCEPT A BLOW ALREADY NAMED THIS TICK. Skeleton waves resolve earlier in
    // the same tick and tag themselves 'blade'; an unguarded `() => 'storm'`
    // then relabelled a 19 hp cutlass as the weather because 0.06 hp of drizzle
    // landed after it, and the death screen read TAKEN BY THE STORM to a pirate
    // who was cut down. The latest blow names the death, but a rounding chip of
    // rain is not the latest blow.
    this.endHealthWitness((player) => (
      this.namedThisTickByOther(player.id, 'storm') ? null : 'storm'
    ));
    // Both witnesses have spoken: ship whatever they banked, so no loss of
    // health is ever silent (see noteEnvironmentalDamage).
    this.flushEnvironmentalDamage();
    // Runs immediately after the storm, because the whole event is keyed to the
    // ring: she rises at the announced next centre and the tempest takes her back.
    this.updateWreckEvent();
    this.syncTreasureChests();
    this.updateKegs(dt);
    this.updateFieldRepairs(dt);

    // Trading
    const tradeEvents = this.trading.update(dt, this.state.tradeSessions, this.state.ships, this.state.players);
    for (const event of tradeEvents) {
      if (event.type === 'trade_update' && event.session) {
        this.broadcast({ type: 'trade_update', ts: Date.now(), payload: event.session });
      } else {
        this.broadcast({ type: 'trade_result', ts: Date.now(), payload: event });
      }
    }

    // Check player deaths — hp 0 with a living crewmate downs the pirate
    // (down-but-not-out) instead of killing outright; damage against a downed
    // pirate finishes them.
    this.resolveHealthDeaths();

    // Check ship sunk
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      this.evaluateShipSinking(ship);
    }

    // Clean dead projectiles
    this.state.projectiles = this.state.projectiles.filter(p => p.alive && p.age < p.maxAge);
    this.state.kegs = this.state.kegs.filter((keg) => keg.timer > 0 && !keg.defused);

    // Count alive ships
    this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;

    // Check win condition
    this.checkWinCondition();

    // Send snapshots: quantized full state at ~10.4 Hz, light 'state_hot'
    // transform updates on the snapshot ticks in between (31.25 Hz total).
    if (this.tickCount % SNAPSHOT_RATE === 0) {
      if (this.tickCount % FULL_SNAPSHOT_TICKS === 0) {
        this.pruneQuestMaps();
        // The Gilded Wreck's chests and supply barrels are ORDINARY island
        // entities (that is what makes every loot path work unchanged) — and
        // island entities only ride the ~19 s static-world tick. A dynamic event
        // cannot wait 19 s to become lootable, so raising or claiming her arms
        // one extra world tick, on the very next full snapshot.
        const includeStaticWorld = this.tickCount % FULL_WORLD_SNAPSHOT_TICKS === 0
          || this.worldResyncPending;
        this.worldResyncPending = false;
        const snap = buildWireSnapshot(this.buildSnapshot(includeStaticWorld), includeStaticWorld);
        this.broadcastVolatile({ type: 'state_snapshot', ts: Date.now(), payload: snap }, 'full');
      } else {
        const hot = buildHotSnapshot(this.state, this.t, ++this.snapshotSeq);
        this.broadcastVolatile({ type: 'state_hot', ts: Date.now(), payload: hot }, 'hot');
      }
    }
  }

  /**
   * Edge-trigger gate for press-style inputs.
   * Returns true at most once per unique input.seq for the given action key.
   * Without this, server replays of `client.lastInput` every tick would re-fire
   * one-shots like interact/trade/wheel use 60× per second.
   * Rate-limited actions additionally enforce a minimum sim-time interval, since
   * a hostile client can bump seq every packet.
   */
  private consumeOneShot(client: ConnectedClient, action: OneShotAction, seq: number): boolean {
    if (client.consumedSeq[action] === seq) return false;
    client.consumedSeq[action] = seq;
    const minInterval = ONE_SHOT_MIN_INTERVAL[action];
    if (minInterval !== undefined) {
      const last = client.lastOneShotAt[action];
      if (last !== undefined && this.t - last < minInterval) return false;
      client.lastOneShotAt[action] = this.t;
    }
    return true;
  }

  /**
   * A PRESS IS A PROMISE, NOT A SAMPLE.
   *
   * Inputs stream in at 45 Hz and land in one `client.lastInput` slot that the
   * sim reads once per tick. When ticks run late (sim dilation, a dropped tick)
   * the packet carrying `interact: true` is overwritten by the newer packets
   * that arrive before anybody looks at it, and the press evaporates with the
   * right prompt still glowing on screen — three dead [X] at the wheel, the
   * fourth one works.
   *
   * So when the packet being REPLACED was never offered to a tick, its one-shot
   * flags ride forward onto its replacement. Two gates keep this from becoming a
   * press duplicator:
   *   • `appliedInputSeq` — a packet the sim already read had its presses
   *     offered (accepted, refused, or gated by a branch condition). Those are
   *     spent; only a NEVER-SEEN packet may donate.
   *   • `consumedSeq` — belt and braces against a donation whose action was
   *     already edge-consumed at that very seq.
   * A wall-clock ceiling bounds the carry so a stalled match can't fire a
   * minute-old press at the horn.
   */
  private carryUnreadOneShots(client: ConnectedClient, next: PlayerInput): PlayerInput {
    const prev = client.lastInput;
    const now = Date.now();
    if (!prev || client.appliedInputSeq === prev.seq) {
      client.oneShotPendingSince = null;
      return next;
    }
    const pendingSince = client.oneShotPendingSince ?? now;
    if (now - pendingSince > ONE_SHOT_CARRY_WINDOW_MS) {
      client.oneShotPendingSince = null;
      return next;
    }

    let carried = false;
    /** Donate a never-consumed press from the unread packet to its replacement. */
    const carryFlag = (key: 'jumpPressed' | 'trade' | 'reload' | 'placeKeg' | 'dropChest'
      | 'specialAttack' | 'barrelTakeAll', action: OneShotAction) => {
      if (!prev[key] || client.consumedSeq[action] === prev.seq) return;
      next[key] = true;
      carried = true;
    };

    // [X] carries the intent it was aimed with — the press and what it meant are
    // one thing; splitting them would resolve the press against a later frame's
    // highlight (the exact "one press triggered a different station" bug).
    if (prev.interact && client.consumedSeq.interact !== prev.seq && !next.interact) {
      next.interact = true;
      next.interactIntent = prev.interactIntent ?? next.interactIntent ?? null;
      carried = true;
    }
    carryFlag('jumpPressed', 'jump');
    carryFlag('trade', 'trade');
    carryFlag('reload', 'reload');
    carryFlag('placeKeg', 'placeKeg');
    carryFlag('dropChest', 'dropChest');
    carryFlag('specialAttack', 'special');
    carryFlag('barrelTakeAll', 'barrelTakeAll');

    if (prev.slot !== null && next.slot === null && client.consumedSeq.slot !== prev.seq) {
      next.slot = prev.slot;
      carried = true;
    }
    if (prev.cannonAmmo && !next.cannonAmmo && client.consumedSeq.cannonAmmo !== prev.seq) {
      next.cannonAmmo = prev.cannonAmmo;
      carried = true;
    }
    if (prev.selectMap && !next.selectMap && client.consumedSeq.selectMap !== prev.seq) {
      next.selectMap = prev.selectMap;
      carried = true;
    }
    // The wheel press is meaningless without the slice it pointed at.
    if (prev.useWheelItem && !next.useWheelItem && client.consumedSeq.wheel !== prev.seq) {
      next.useWheelItem = true;
      next.wheelIndex = prev.wheelIndex ?? next.wheelIndex;
      carried = true;
    }

    client.oneShotPendingSince = carried ? pendingSince : null;
    return next;
  }

  /**
   * Validate and normalize a raw player_input payload. Returns null (input is
   * dropped) when any required numeric is non-finite. Enum-ish fields fall back
   * to null rather than rejecting the whole packet.
   */
  private sanitizeInput(raw: unknown): PlayerInput | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const input = raw as Record<keyof PlayerInput, unknown>;
    const seq = input.seq;
    const yaw = input.yaw;
    const pitch = input.pitch;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return null;
    if (typeof pitch !== 'number' || !Number.isFinite(pitch)) return null;

    const slot = input.slot === 0 || input.slot === 1 || input.slot === 2 || input.slot === 3
      ? input.slot
      : null;
    const wheelIndex = typeof input.wheelIndex === 'number'
      && Number.isInteger(input.wheelIndex)
      && input.wheelIndex >= 0
      && input.wheelIndex <= 9
      ? input.wheelIndex
      : null;
    const cannonAmmo = input.cannonAmmo === 'cannonball' || input.cannonAmmo === 'firebomb' || input.cannonAmmo === 'chainshot'
      ? input.cannonAmmo
      : null;
    const interactIntent = typeof input.interactIntent === 'string'
      && VALID_INTERACT_INTENTS.has(input.interactIntent as InteractIntent)
      ? input.interactIntent as InteractIntent
      : null;

    return {
      seq,
      ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : 0,
      forward: !!input.forward,
      back: !!input.back,
      left: !!input.left,
      right: !!input.right,
      jump: !!input.jump,
      jumpPressed: !!input.jumpPressed,
      fire: !!input.fire,
      useItem: !!input.useItem,
      crouch: !!input.crouch,
      aim: !!input.aim,
      interact: !!input.interact,
      interactHeld: !!input.interactHeld,
      anchor: !!input.anchor,
      sailRaise: !!input.sailRaise,
      sailLower: !!input.sailLower,
      sailLeft: !!input.sailLeft,
      sailRight: !!input.sailRight,
      trade: !!input.trade,
      reload: !!input.reload,
      placeKeg: !!input.placeKeg,
      dropChest: !!input.dropChest,
      specialAttack: !!input.specialAttack,
      slot,
      cannonAmmo,
      yaw: angleWrap(yaw),
      pitch: clamp(pitch, -Math.PI / 2, Math.PI / 2),
      wheelIndex,
      useWheelItem: !!input.useWheelItem,
      barrelTakeAll: !!input.barrelTakeAll,
      interactIntent,
      // Quest-map equip rode in the payload but was dropped here, so the
      // selectMap one-shot on the other side could never fire.
      selectMap: typeof input.selectMap === 'string' && input.selectMap.length <= 64
        ? input.selectMap
        : null,
    };
  }

  private applyInput(client: ConnectedClient, input: PlayerInput, dt: number) {
    // Stamp BEFORE any early-out: the sim has now looked at this packet, so its
    // presses are spent and must not be donated to the next one.
    client.appliedInputSeq = input.seq;
    const player = this.getPlayer(client.playerId);
    if (!player || player.state === 'eliminated' || player.state === 'respawning') return;
    if (player.state === 'downed') {
      this.applyDownedInput(player, input, dt);
      return;
    }

    const ship = this.getAliveShip(player.onShipId);
    if (!ship) {
      this.clearStationFlags(player);
    }

    const cannonAim = ship && player.atCannon
      ? getConstrainedCannonAim(ship, player.cannonIndex, input.yaw, input.pitch)
      : null;

    const prevJumpHeld = this.lastJumpHeldByPlayer.get(client.playerId) ?? false;
    const jumpEdge = input.jumpPressed || (!!input.jump && !prevJumpHeld);
    this.lastJumpHeldByPlayer.set(client.playerId, !!input.jump);

    player.rotation.x = player.atHelm && ship ? ship.rotation : (cannonAim?.yaw ?? input.yaw);
    player.rotation.y = cannonAim?.pitch ?? input.pitch;

    // Crouch is a plain hold — meaningless in water, on ladders or at stations.
    player.crouching = !!input.crouch
      && player.state === 'alive'
      && !player.atCannon && !player.atHelm && !player.atCrowNest
      && player.mastClimb === null;

    // Weapon switch — edge-triggered so a held slot key doesn't keep "switching" each tick.
    if (input.slot !== null && (input.slot !== player.activeSlot || player.equippedTool !== null)
      && this.consumeOneShot(client, 'slot', input.seq)) {
      player.activeSlot = input.slot;
      // Drawing/selecting any weapon puts away a held tool (both hands back on
      // the gun) — the quick way to stow the scope/bucket without the wheel.
      // EXCEPT within a grace window of the equip: the wheel digits double as
      // weapon-slot keys (Digit2 = compass AND slot 1), so a stray slot edge
      // right after equipping used to stow the tool instantly.
      const equip = this.lastToolEquip.get(player.id);
      if (player.equippedTool !== null && !(equip && this.t - equip.at < 0.5)) {
        player.equippedTool = null;
      }
    }
    if (input.cannonAmmo && this.consumeOneShot(client, 'cannonAmmo', input.seq)) {
      player.selectedCannonAmmo = input.cannonAmmo;
    }

    if (input.dropChest && player.carryingChestId && this.consumeOneShot(client, 'dropChest', input.seq)) {
      this.dropCarriedChest(player, true);
      return;
    }

    // Reload (also blocked while a chest fills your hands)
    if (input.reload && !player.carryingChestId && this.consumeOneShot(client, 'reload', input.seq)) {
      const activeWeapon = player.weapons[player.activeSlot];
      if (!activeWeapon || !WEAPONS[activeWeapon.weaponId].melee) {
        this.weapons.startReload(player);
      }
    }

    // ── Mast ladder climb: captive mode. W/S slides mastClimb along the ladder
    // (PhysicsSystem pins the body each tick); [X] lets go mid-climb and drops
    // back to the deck. Nothing else — no weapons, no stations — while aloft.
    if (player.mastClimb !== null) {
      if (input.interact && this.consumeOneShot(client, 'interact', input.seq)) {
        player.mastClimb = null;
        return;
      }
      if (!ship || player.onShipId !== ship.id || ship.sinking) {
        player.mastClimb = null;
        return;
      }
      const climbDir = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
      player.mastClimb = clamp(player.mastClimb + climbDir * MAST_CLIMB_RATE * dt, 0, 1);
      if (player.mastClimb >= 1) {
        // Top of the ladder — step into the (walkable) basket.
        player.mastClimb = null;
        player.atCrowNest = true;
      } else if (player.mastClimb <= 0 && climbDir < 0) {
        // Back at the base — release standing on deck at the ladder foot.
        player.mastClimb = null;
      }
      return;
    }

    this.updateBlockingState(player, input);

    // Queued climb + gangway walk-on. Runs before the [X] dispatch so a latched
    // press can complete on the very tick the geometry allows it.
    this.updateBoardingLatch(player, dt);

    // Revive a downed crewmate: hold interact (~4 s) next to the body with the
    // revive action selected. Contributions are resolved in updateDownedAndRevives.
    if (
      input.interactHeld
      && input.interactIntent === 'revive'
      && !player.atCannon && !player.atHelm && !player.atCrowNest
    ) {
      const target = this.findReviveTarget(player);
      if (target) this.reviveActionsThisTick.set(target.id, player.id);
    }

    if (ship && player.atCannon && jumpEdge && this.consumeOneShot(client, 'jump', input.seq)) {
      this.launchPlayerFromCannon(player, ship, cannonAim ?? getConstrainedCannonAim(ship, player.cannonIndex, input.yaw, input.pitch));
      return;
    }

    if (
      input.specialAttack
      && player.tsunamiCharges > 0
      && !player.carryingChestId
      && !player.atCannon
      && !player.atHelm
      && !player.atCrowNest
      && this.consumeOneShot(client, 'special', input.seq)
    ) {
      this.fireTsunamiSpecial(player, input.yaw);
      return;
    }

    const canPlaceNormalKeg = player.kegs > 0 && player.kegCooldown <= 0;
    const canPlaceMegaKeg = player.megaKegs > 0;
    if (input.placeKeg && (canPlaceMegaKeg || canPlaceNormalKeg) && !player.atCannon && !player.atHelm && !player.atCrowNest && this.consumeOneShot(client, 'placeKeg', input.seq)) {
      const kegPlacement = this.getKegPlacement(player, ship ?? null);
      if (kegPlacement) {
        const useMegaKeg = player.megaKegs > 0;
        this.state.kegs.push({
          id: uuid(),
          shipId: kegPlacement.shipId,
          plantedById: player.id,
          section: kegPlacement.section,
          position: kegPlacement.position,
          localPosition: kegPlacement.localPosition,
          timer: SHIP.KEG_FUSE_TIME,
          mega: useMegaKeg,
        });
        if (useMegaKeg) {
          player.megaKegs = Math.max(0, player.megaKegs - 1);
          player.kegCooldown = Math.max(player.kegCooldown, 1.0);
        } else {
          player.kegs -= 1;
          player.kegCooldown = player.kegs > 0 ? PLAYER.KEG_REPLENISH_COOLDOWN : 0;
        }
      }
    }

    // Take-all from a nearby barrel (rising-edge). Independent of interact so the player
    // can browse first via interact and then commit with this shortcut, or commit directly.
    if (input.barrelTakeAll && this.consumeOneShot(client, 'barrelTakeAll', input.seq)) {
      const barrelEvent = this.islands.tryTakeAllFromNearbyBarrel(player, this.state.islands, this.state.ships);
      if (barrelEvent) {
        this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
      }
    }

    // Equip a held quest map from the wheel's map page (one-shot).
    if (input.selectMap && this.consumeOneShot(client, 'selectMap', input.seq)) {
      if (player.questMaps.includes(input.selectMap)) {
        player.treasureMapIslandId = input.selectMap;
        const island = this.state.islands.find((candidate) => candidate.id === input.selectMap);
        if (island) {
          this.send(client.ws, {
            type: 'treasure_map',
            ts: Date.now(),
            payload: {
              islandId: island.id,
              islandName: island.name,
              chestCount: island.chests.filter((chest) =>
                chest.buried && chest.digProgress < 1 && !chest.opened
                && !chest.carriedByPlayerId && !chest.storedOnShipId && !chest.floating).length,
            },
          });
        }
      }
    }

    // Interact (X key) — exit current station always wins
    if (input.interact && this.consumeOneShot(client, 'interact', input.seq)) {
      if (player.atCannon) { player.atCannon = false; return; }
      if (player.atHelm)   { player.atHelm   = false; return; }
      if (player.atCrowNest) {
        // [X] at the nest remounts the ladder — climbing down is manual now,
        // no instant deck teleport.
        player.atCrowNest = false;
        player.mastClimb = ship ? 1 : null;
        return;
      }

      // Modern clients send the HUD-selected action. If that validation misses, do nothing:
      // falling through to the legacy chain is what made one [X] press trigger a different station.
      if (input.interactIntent) {
        // A refusal is an ANSWER. Silence at a glowing prompt is what made the
        // player mash the key and then stop trusting it.
        if (!this.tryInteractIntent(player, input, ship ?? null)) {
          this.sendInteractRefused(client, input.interactIntent);
        }
        return;
      }

      if (this.tryClimbIslandDockFromWater(player)) return;
      if (this.returnPlayerByMermaid(player)) return;

      // Legacy (bots / old clients): fixed priority chain
      const keg = this.getNearbyKeg(player, ship ?? null);
      if (keg) { this.diffuseKeg(keg); return; }

      if (player.nearBarrelId) {
        const barrelEvent = this.islands.tryOpenBarrel(player, this.state.islands, this.state.ships);
        if (barrelEvent) {
          this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
        }
        return;
      }

      if (player.nearChestId) {
        const event = this.tryTakeChest(player);
        if (event) {
          this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
        }
        return;
      }

      if (this.requestBoard(player)) return;

      if (this.handleGoldHoarderInteraction(player)) return;

      const homeShip = this.getAliveShip(player.shipId);
      const upgradeStation = findNearbyUpgradeStation(this.state.islands, player);
      if (
        upgradeStation
        && homeShip
        && upgradeStation.claimedByShipId !== homeShip.id
        && !homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)
      ) {
        // Same material gate as the intent path — a short press consumes the
        // interact (station feedback) without claiming.
        const cost = UPGRADE_COSTS[upgradeStation.type];
        if (
          this.getMaterialCount(player, homeShip, 'wood') < cost.wood
          || this.getMaterialCount(player, homeShip, 'ore') < cost.ore
        ) {
          return;
        }
        this.consumeMaterial(player, homeShip, 'wood', cost.wood);
        this.consumeMaterial(player, homeShip, 'ore', cost.ore);
        upgradeStation.claimedByShipId = homeShip.id;
        this.applyShipUpgrade(homeShip, upgradeStation.type);
        this.broadcast({
          type: 'ship_upgraded',
          ts: Date.now(),
          payload: { shipId: homeShip.id, type: upgradeStation.type, costWood: cost.wood, costOre: cost.ore },
        });
        return;
      }

      if (ship) {
        // Hull repair is now a HOLD (the hammer-swing block below patches one hole
        // per ~0.9s plank), so a bare press at a breach is consumed here rather than
        // falling through to another interaction.
        if (this.getRepairableHole(player, ship)) return;

        if (player.carryingChestId && this.tryStowCarriedChest(player, ship)) return;

        if (this.isNearAnchor(player, ship)) {
          if (!ship.anchored) {
            ship.anchored = true;
            ship.anchorRaiseProgress = 0;
          }
          this.clearStationFlags(player);
          return;
        }

        if (this.isNearCrowNestLadder(player, ship)) {
          if (this.startMastClimb(player, ship)) return;
        }

        if (this.isNearHelm(player, ship)) {
          if (this.enterHelm(player, ship)) return;
        }

        const nearbyCannon = this.getNearbyCannonIndex(player, ship);
        if (nearbyCannon !== null) {
          this.enterCannon(player, ship, nearbyCannon, input.yaw, input.pitch);
        }
      }
    }

    // Trade request
    if (input.trade && ship && this.consumeOneShot(client, 'trade', input.seq)) {
      let nearest: Ship | null = null;
      let nearestDist = Infinity;
      for (const other of this.state.ships) {
        if (other.id === ship.id || !other.alive) continue;
        const dx = other.position.x - ship.position.x;
        const dz = other.position.z - ship.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 50 && d < nearestDist) { nearestDist = d; nearest = other; }
      }
      if (nearest) {
        const session = this.trading.requestTrade(player, nearest, this.state.tradeSessions);
        if (session) {
          this.broadcast({ type: 'trade_request', ts: Date.now(), payload: session });
        }
      }
    }

    // Ship controls
    if (ship && player.onShipId === ship.id) {
      // ── Halyard: HOLD [X] at the rigging — no captive mode, no key chords.
      // Direction locks when the hold starts (mostly-furled → drop to full
      // canvas, mostly-set → raise) so crossing the midpoint mid-haul never
      // reverses on you. Extra crewmates on the rope speed the haul (up to 2×).
      const haulingSails = input.interactIntent === 'sails'
        && input.interactHeld
        && !player.atCannon && !player.atHelm && !player.atCrowNest
        && player.state === 'alive'
        && this.isNearSailStation(player, ship);
      if (haulingSails && ship.sailIntegrity >= 0.995) {
        let target = this.sailHaulTargetByPlayer.get(player.id);
        if (target === undefined) {
          target = ship.sailHeight < 0.5 ? 1 : 0;
          this.sailHaulTargetByPlayer.set(player.id, target);
        }
        const crewOnRope = Math.min(2, 1 + (this.sailHaulCrewThisTick.get(ship.id) ?? 0));
        this.sailHaulCrewThisTick.set(ship.id, crewOnRope);
        const cap = ship.sailIntegrity;
        const rate = SHIP.SAIL_HOIST_RATE * (0.5 + crewOnRope * 0.5) * dt;
        ship.sailHeight = target > 0.5
          ? Math.min(cap, ship.sailHeight + rate)
          : Math.max(0, ship.sailHeight - rate);
      } else {
        this.sailHaulTargetByPlayer.delete(player.id);
      }

      // ── Braces: HOLD [X] at a quarterdeck brace rail — sweeps the yard
      // toward that side, the physical home for sail TRIM (helm Q/F remains
      // the convenience). Canvas must be sound, same as the halyard.
      if (
        input.interactIntent === 'brace'
        && input.interactHeld
        && !player.atCannon && !player.atHelm && !player.atCrowNest
        && player.state === 'alive'
        && ship.sailIntegrity >= 0.995
      ) {
        const braceDir = findBraceStationDir(player, ship);
        if (braceDir !== 0) {
          ship.sailAngle = Math.max(
            -SHIP.MAX_SAIL_ANGLE,
            Math.min(SHIP.MAX_SAIL_ANGLE, ship.sailAngle + braceDir * SHIP.SAIL_TRIM_RATE * 0.75 * dt),
          );
        }
      }

      if (
        ship.anchored
        && input.interactHeld
        && !player.atCannon
        && !player.atHelm
        && !player.atCrowNest
        && this.isNearAnchor(player, ship)
      ) {
        ship.anchorRaiseProgress = Math.min(1, ship.anchorRaiseProgress + dt / SHIP.ANCHOR_RAISE_TIME);
        if (ship.anchorRaiseProgress >= 1) {
          // Anchor is fully raised — release the brake but keep progress at 1 so the HUD reads
          // "100% — Anchor Raised" until the player drops the anchor again. The drop path resets
          // progress back to 0; we never reset mid-frame here, which used to cause the "100% → 0%"
          // flicker the moment the raise completed.
          ship.anchored = false;
          ship.anchorRaiseProgress = 1;
          this.applyFirstSailAssist(ship);
        }
      }

      // Physical bucket bailing as a SCOOP → CARRY → HEAVE cycle: with the BUCKET
      // equipped, press interact to fill the empty bucket from the bilge (ship
      // water drops one scoop), then press again to heave that bucketful over the
      // side (empties the bucket). Each action animates over BAIL_SCOOP_TIME so
      // you can't spam; the cycle alternates fill/heave.
      const bailPress =
        ((input.interact && input.interactIntent === 'bail') || input.useItem)
        && !player.atCannon
        && !player.atHelm
        && !player.atCrowNest
        && player.equippedTool === 'bucket'
        && player.bailScoopProgress <= 0.05
        && this.consumeOneShot(client, 'bail', input.seq);
      if (bailPress) {
        if (player.bucketFilled) {
          // Heave the carried bucketful overboard — empties it.
          player.bucketFilled = false;
          player.bailScoopProgress = 1;
        } else if ((ship.waterLevel ?? 0) > 0.001) {
          // Scoop a bucketful out of the bilge — fills the bucket, water drops.
          player.bucketFilled = true;
          ship.waterLevel = Math.max(0, (ship.waterLevel ?? 0) - FLOODING.BAIL_SCOOP_VOLUME);
          player.bailScoopProgress = 1;
        }
      }
      // Decay the scoop/heave animation; bailing flag rides it for client FX.
      if (player.bailScoopProgress > 0) {
        player.bailScoopProgress = Math.max(0, player.bailScoopProgress - dt / FLOODING.BAIL_SCOOP_TIME);
      }
      player.bailing = player.bailScoopProgress > 0;

      // Repair torn sails (hold [X] + wood at the rigging). Repairing both
      // restores rigging integrity and physically hoists the canvas back up.
      const mendingSails = input.interactIntent === 'sails'
        && input.interactHeld
        && !player.atCannon && !player.atHelm && !player.atCrowNest
        && this.isNearSailStation(player, ship);
      if (mendingSails && ship.sailIntegrity < 1) {
        // Sail repair draws planks from the SAME source hull repair does —
        // your pocket first, then ship stores (was ship-only, so you couldn't
        // mend canvas with planks in your pocket).
        if (getRepairPlankCount(player, ship) > 0) {
          ship.sailRepairWoodTimer += dt;
          while (ship.sailRepairWoodTimer >= SHIP.SAIL_REPAIR_WOOD_INTERVAL && ship.sailIntegrity < 1) {
            if (!this.consumeRepairPlank(player, ship)) break;
            ship.sailRepairWoodTimer -= SHIP.SAIL_REPAIR_WOOD_INTERVAL;
            ship.sailIntegrity = Math.min(1, ship.sailIntegrity + 0.28);
          }
        }
        // Continuous canvas hoist while at the sail station — independent of plank
        // consumption so even a single plank visibly raises the canvas back.
        ship.sailHeight = Math.min(ship.sailIntegrity, ship.sailHeight + SHIP.SAIL_HOIST_RATE * SHIP.SAIL_REPAIR_HOIST_FACTOR * dt);
      } else if (!mendingSails) {
        ship.sailRepairWoodTimer = 0;
      }

      // Repair breached HULL sections by HOLDING [X] at the damage with wood: each
      // ~0.9s hammer swing consumes one plank and patches one hole. The progress
      // drives the first-person plank+hammer animation (and rides the wire so
      // onlookers see the swing too). Replaces the old instant one-press patch.
      const mendingHull = input.interactHeld
        && input.interactIntent === 'repair'
        && !player.atCannon && !player.atHelm && !player.atCrowNest;
      const hullRepairTarget = mendingHull ? this.getRepairableHole(player, ship) : null;
      if (hullRepairTarget && getRepairPlankCount(player, ship) > 0) {
        player.hullRepairProgress = Math.min(1, player.hullRepairProgress + dt / SHIP.HULL_REPAIR_SWING_TIME);
        if (player.hullRepairProgress >= 1) {
          player.hullRepairProgress = 0;
          if (this.consumeRepairPlank(player, ship)) {
            this.physics.patchHole(ship, hullRepairTarget.id);
            if (ship.onFire) {
              ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
              if (ship.fireTimer <= 0) { ship.onFire = false; ship.fireTimer = 0; ship.fireDamageAccum = 0; }
            }
          }
        }
      } else if (player.hullRepairProgress > 0) {
        player.hullRepairProgress = Math.max(0, player.hullRepairProgress - dt / 0.3);
      }

      // Helm: A/D or arrow keys steer; W/S or arrow up/down trims sail while driving.
      if (player.atHelm) {
        let steerInput = 0;
        if (input.left) steerInput -= 1;
        if (input.right) steerInput += 1;
        // ── WEIGH ANCHOR FROM THE WHEEL ──────────────────────────────────────
        // A solo captain at the helm with the anchor down held W, watched the
        // canvas fall and the ship sit there, and had no way to learn why: the
        // capstan is at the BOW and [X] at the helm means "leave the helm".
        // So W at the wheel calls her crew to the capstan first — a shade slower
        // than manning it yourself, then the same W makes sail.
        if (ship.anchored && input.forward) {
          ship.anchorRaiseProgress = Math.min(1, ship.anchorRaiseProgress + dt / (SHIP.ANCHOR_RAISE_TIME * HELM_ANCHOR_RAISE_FACTOR));
          if (ship.anchorRaiseProgress >= 1) {
            ship.anchored = false;
            ship.anchorRaiseProgress = 1;
            this.applyFirstSailAssist(ship);
          }
        }
        // Slower than the rope stations — the helm trim is a convenience, the
        // rigging (with crew) is the fast way to make or shorten sail.
        if (input.forward) ship.sailHeight = Math.min(ship.sailIntegrity, ship.sailHeight + 0.22 * dt);
        if (input.back) ship.sailHeight = Math.max(0, ship.sailHeight - 0.28 * dt);
        // Q/F brace the yard: trim the sail ANGLE to port/starboard so the helmsman
        // can catch a crosswind on a reach (PhysicsSystem's trimEfficiency rewards
        // matching the wind-relative optimum). Without this the yard stayed centred
        // and a human was stuck at ~0.24× speed on every reach vs auto-trimming bots.
        if (input.sailLeft) ship.sailAngle = Math.max(-SHIP.MAX_SAIL_ANGLE, ship.sailAngle - SHIP.SAIL_TRIM_RATE * dt);
        if (input.sailRight) ship.sailAngle = Math.min(SHIP.MAX_SAIL_ANGLE, ship.sailAngle + SHIP.SAIL_TRIM_RATE * dt);
        const chainshotted = this.t < ship.chainshottedUntil;
        // Rudder + way: the helm slews ship.rudderAngle toward the input and the
        // blade only bites with water flowing past it — full-sail handling keeps
        // the classic turnRate cap, a stationary ship barely answers the helm.
        // Chainshot fouls the rigging AND the helm — ~25% rudder authority cut
        // while active (waterLevel dulls it further inside applyShipRudderSteering).
        const omegaCapScale = (0.5 + ship.sailHeight * 0.5)
          * (chainshotted ? 0.75 : 1)
          * (ship.sailIntegrity < 0.5 ? 0.9 : 1);
        applyShipRudderSteering(ship, dt, steerInput, omegaCapScale);
        // Rotation itself is integrated in PhysicsSystem.updateShips for all ships.
      }
    }

    if (player.atHelm && ship) {
      this.snapPlayerToHelm(player, ship);
      player.velocity.x = 0;
      player.velocity.z = 0;
    } else if (player.atCannon && ship) {
      const aim = getConstrainedCannonAim(ship, player.cannonIndex, input.yaw, input.pitch);
      player.rotation.x = aim.yaw;
      player.rotation.y = aim.pitch;
      this.snapPlayerToCannon(player, ship, player.cannonIndex);
      player.velocity.x = 0;
      player.velocity.z = 0;
    } else if (player.cannonBallistic) {
      // In free ballistic flight after being launched from a cannon — physics drives
      // motion. Don't run the on-foot/swim handlers (they would zero velocity.x/z
      // every tick when no WASD is pressed, which is why launches went straight up).
    } else {
      if (ship && player.onShipId === ship.id) {
        this.armShipExitGrace(player, ship, input);
      }

      // On-foot / swim movement
      const yaw = input.yaw;
      // The crow's nest is deliberately NOT in this list: PhysicsSystem treats the
      // basket as a walkable FLOOR (gravity + velocity.y run, the WASD clamp keeps
      // the lookout on the disc), so a lookout can hop like anywhere else. The helm
      // still blocks — it pins the body to a station.
      const jumpBlocked = !!ship && player.atHelm;
      const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
      if (player.state === 'swimming') {
        const pitch = input.pitch;
        const forwardScale = Math.cos(pitch);
        const forwardX = Math.sin(yaw) * forwardScale;
        const forwardY = Math.sin(pitch);
        const forwardZ = Math.cos(yaw) * forwardScale;
        const rightX = -Math.cos(yaw);
        const rightZ = Math.sin(yaw);
        const forwardIntent = (input.forward ? 1 : 0) - (input.back ? 0.58 : 0);
        const strafeIntent = (input.right ? 0.72 : 0) - (input.left ? 0.72 : 0);
        let wishX = 0;
        let wishY = 0;
        let wishZ = 0;
        if (forwardIntent !== 0) {
          const forwardScaleY = forwardIntent > 0 ? 1.18 : 0.6;
          wishX += forwardX * forwardIntent;
          wishY += forwardY * forwardScaleY * Math.abs(forwardIntent);
          wishZ += forwardZ * forwardIntent;
        }
        if (strafeIntent !== 0) {
          wishX += rightX * strafeIntent;
          wishZ += rightZ * strafeIntent;
        }
        if (input.jump) wishY += 0.95;
        if (input.sailLower) wishY -= 0.95;
        // While plunging from a fall/cannon launch, don't let upward swim input
        // steal the plunge momentum. The player can still dive deeper or steer
        // horizontally; once the plunge slows, jump becomes a swim-up again.
        const plunging = player.velocity.y < -1.5;
        if (plunging && wishY > 0) wishY = 0;

        const swimLen = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
        if (swimLen > 0.001) {
          const swimSpeed = PLAYER.SWIM_SPEED * (input.forward ? 1.06 : 1);
          const targetVx = (wishX / swimLen) * swimSpeed;
          const targetVz = (wishZ / swimLen) * swimSpeed;
          const targetVy = (wishY / swimLen) * PLAYER.SWIM_SPEED * 0.92;
          // Blend toward swim input rather than replacing velocity outright. This
          // preserves cannon-launch / cliff-jump plunge momentum even if the player
          // is holding space when they hit the water — they slow first, then rise.
          const horizBlend = 1 - Math.exp(-dt * 9);   // ~0.11 s response on X/Z
          const vertBlend  = 1 - Math.exp(-dt * 3.5); // ~0.29 s response on Y
          player.velocity.x += (targetVx - player.velocity.x) * horizBlend;
          player.velocity.z += (targetVz - player.velocity.z) * horizBlend;
          player.velocity.y += (targetVy - player.velocity.y) * vertBlend;
          player.position.x += player.velocity.x * dt;
          player.position.z += player.velocity.z * dt;
        }
        // No-input case is intentionally left to PhysicsSystem so cannon-launch and
        // cliff-jump plunges keep their downward momentum. Killing velocity here at
        // 0.82 per tick = 0.82^60/sec destroyed plunges in a single frame.
      } else {
        const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
        const nx = moveX / len, nz = moveZ / len;
        const speed = PLAYER.MOVE_SPEED * (player.crouching ? 0.55 : 1);

        if (moveX !== 0 || moveZ !== 0) {
          const cosY = Math.cos(yaw);
          const sinY = Math.sin(yaw);
          player.velocity.x = (sinY * nz - cosY * nx) * speed;
          player.velocity.z = (cosY * nz + sinY * nx) * speed;
          player.position.x += player.velocity.x * dt;
          player.position.z += player.velocity.z * dt;
        } else {
          player.velocity.x = 0;
          player.velocity.z = 0;
        }

        const verticalReady = player.velocity.y <= 0.2;
        let grounded = false;
        if (ship && player.onShipId === ship.id && player.atCrowNest) {
          // A lookout stands on the nest basket, not the deck — getShipFloorY would
          // report the deck ~15m below and read the lookout as airborne, so Space
          // did nothing up there. Ground against the basket floor instead.
          const nestFloorY = ship.position.y + getCrowNestStandingY(SHIP_STATS[ship.type]);
          grounded = verticalReady && Math.abs(player.position.y - nestFloorY) < 0.24;
        } else if (ship && player.onShipId === ship.id) {
          const floorY = getShipFloorYAt(player.position, ship);
          grounded = verticalReady && Math.abs(player.position.y - floorY) < 0.24;
        } else {
          for (const island of this.state.islands) {
            if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 0)) {
              grounded = verticalReady && Math.abs(player.position.y - getIslandSurfaceY(island, player.position.x, player.position.z)) < 0.24;
              if (grounded) break;
            }
            if (island.dock) {
              const dx = player.position.x - island.dock.position.x;
              const dz = player.position.z - island.dock.position.z;
              const cos = Math.cos(island.dock.rotation);
              const sin = Math.sin(island.dock.rotation);
              const localX = dx * cos - dz * sin;
              const localZ = dx * sin + dz * cos;
              if (Math.abs(localX) <= island.dock.width * 0.5 + 0.45 && Math.abs(localZ) <= island.dock.length * 0.5 + 0.45) {
                grounded = verticalReady && Math.abs(player.position.y - (island.dock.position.y + 0.14)) < 0.22;
                if (grounded) break;
              }
            }
          }
        }

        // Jump
        if (input.jumpPressed && !jumpBlocked && grounded) {
          player.velocity.y = PLAYER.JUMP_FORCE;
        }
      }
    }

    const cutlassHandled = this.updateCutlassAttack(player, input, dt);

    // Fire (suppressed entirely while a treasure chest is in your hands — Sea-of-Thieves style)
    if (!cutlassHandled && input.fire && !player.carryingChestId) {
      if (player.respawnProtectionTimer > 0) {
        player.respawnProtectionTimer = 0;
      }
      const activeWeapon = player.weapons[player.activeSlot];
      if (!activeWeapon || !WEAPONS[activeWeapon.weaponId].melee) {
        const activeWeapon = player.weapons[player.activeSlot];
        const aimRay = activeWeapon && !WEAPONS[activeWeapon.weaponId].melee
          ? this.getFirearmAimRay(player, ship ?? null, input, activeWeapon.weaponId)
          : null;
        const fireYaw = cannonAim?.yaw ?? input.yaw;
        const firePitch = cannonAim?.pitch ?? input.pitch;
        const traces = this.weapons.tryFire(
          player,
          ship ?? null,
          fireYaw,
          firePitch,
          player.cannonIndex,
          { aiming: input.aim, aimPoint: aimRay?.point ?? null, aimOrigin: aimRay?.eye ?? null },
        );
        if (traces.length > 0) {
          this.resolveFirearmHits(player, traces);
        }
      }
    }

    this.tryDigChest(player, input, dt);
    this.tryHarvestProp(player, input, dt);
    this.tryUsePocketWheel(client, player, ship ?? null, input);
  }

  private updateCutlassAttack(player: Player, input: PlayerInput, dt: number): boolean {
    const activeWeapon = player.weapons[player.activeSlot];
    const isCutlass = !!activeWeapon && activeWeapon.weaponId === 'cutlass';
    if (!isCutlass || player.carryingChestId || player.atCannon || player.atHelm || player.blocking) {
      this.cutlassChargeByPlayer.delete(player.id);
      this.cutlassFireHeldByPlayer.set(player.id, !!input.fire && isCutlass);
      player.cutlassCharge = 0;
      return false;
    }

    const wasHeld = this.cutlassFireHeldByPlayer.get(player.id) ?? false;
    const previousCharge = this.cutlassChargeByPlayer.get(player.id) ?? 0;
    this.cutlassFireHeldByPlayer.set(player.id, !!input.fire);

    if (activeWeapon.reloading) {
      if (!input.fire) this.cutlassChargeByPlayer.delete(player.id);
      player.cutlassCharge = 0;
      return input.fire || wasHeld;
    }

    if (input.fire) {
      if (player.respawnProtectionTimer > 0) {
        player.respawnProtectionTimer = 0;
      }
      const charge = Math.min(CUTLASS_CHARGE_TIME, previousCharge + dt);
      this.cutlassChargeByPlayer.set(player.id, charge);
      player.cutlassCharge = charge / CUTLASS_CHARGE_TIME;
      if (charge >= CUTLASS_CHARGE_TIME) {
        this.performMeleeAttack(player, input.yaw, {
          damageMultiplier: CUTLASS_LUNGE_DAMAGE / WEAPONS.cutlass.damage,
          rangeMultiplier: 2.15,
          knockbackMultiplier: 2.35,
          guardBreak: true,
        });
        this.applyCutlassLunge(player, input.yaw);
        activeWeapon.reloading = true;
        activeWeapon.reloadTimer = CUTLASS_LUNGE_COOLDOWN;
        this.cutlassChargeByPlayer.delete(player.id);
        this.cutlassFireHeldByPlayer.set(player.id, false);
        player.cutlassCharge = 0;
      }
      return true;
    }

    if (wasHeld && previousCharge >= CUTLASS_CHARGE_MIN_TAP) {
      this.performMeleeAttack(player, input.yaw);
      activeWeapon.reloading = true;
      activeWeapon.reloadTimer = WEAPONS.cutlass.reloadTime;
      this.cutlassChargeByPlayer.delete(player.id);
      player.cutlassCharge = 0;
      return true;
    }

    this.cutlassChargeByPlayer.delete(player.id);
    player.cutlassCharge = 0;
    return false;
  }

  private performMeleeAttack(
    player: Player,
    yaw: number,
    options?: {
      damageMultiplier?: number;
      rangeMultiplier?: number;
      knockbackMultiplier?: number;
      guardBreak?: boolean;
    },
  ) {
    const activeWeapon = player.weapons[player.activeSlot];
    if (!activeWeapon || !WEAPONS[activeWeapon.weaponId].melee) return;
    const hits = this.weapons.tryMeleeAttack(player, this.state.players, yaw, options);
    for (const hit of hits) {
      const target = this.getPlayer(hit.targetId);
      if (!target) continue;
      if (target.respawnProtectionTimer > 0 || target.state === 'respawning') continue;
      const blockScale = this.getCutlassBlockScale(target, player, options?.guardBreak);
      const blocked = blockScale < 1;
      const damage = hit.damage * blockScale;
      const knockback = hit.knockback * (blocked ? 0.32 : 1);
      target.lastDamagedById = player.id;
      target.lastDamagedAt = this.t;
      target.lastDamageWasHeadshot = false;
      this.noteDamageSource(target.id, 'blade');
      target.health -= this.absorbWithArmor(target, damage);
      this.awardPlayerHitGold(player.id, damage);
      this.notifyPlayerHit(player.id, {
        targetId: target.id,
        damage,
        blocked,
        position: {
          x: target.position.x,
          y: target.position.y + PLAYER.HEIGHT * 0.72,
          z: target.position.z,
        },
        kill: target.health <= 0,
        remainingHealth: Math.max(0, target.health),
        weaponId: activeWeapon.weaponId,
      });
      this.notifyIncomingPlayerHit(target.id, {
        attackerId: player.id,
        attackerName: player.name,
        damage,
        blocked,
        position: {
          x: target.position.x,
          y: target.position.y + PLAYER.HEIGHT * 0.72,
          z: target.position.z,
        },
        sourcePosition: {
          x: player.position.x,
          y: player.position.y + PLAYER.HEIGHT * 0.72,
          z: player.position.z,
        },
        kill: target.health <= 0,
        remainingHealth: Math.max(0, target.health),
        weaponId: activeWeapon.weaponId,
      });
      const dx = target.position.x - player.position.x;
      const dz = target.position.z - player.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      target.knockbackVelocity.x += (dx / len) * knockback;
      target.knockbackVelocity.y += knockback * 0.2;
      target.knockbackVelocity.z += (dz / len) * knockback;
    }
  }

  /**
   * A held guard STAYS held.
   *
   * This used to be one flat conjunction re-evaluated every tick, which made the
   * parry as fragile as the noisiest term in it. Measured against the real Match:
   * a single input packet arriving without the aim bit — one coalesced or dropped
   * frame under snapshot load, or a pointer-lock blip clearing the button set —
   * lowered the guard for a whole 62.5 Hz tick while RMB was never released, and
   * a wave flipping a shoreline walker to 'swimming' for one tick did the same
   * with no cause the player could possibly see. Either way a skeleton swing
   * landed in full through a raised sword.
   *
   * So the terms are split by intent. Deliberate ends to a guard — you swung
   * (fire, or the swing-recovery timer), you sheathed the cutlass, your hands
   * filled with a chest, you took a station — drop it the same tick they always
   * did. Transient ones only drop it once the stance has gone unfed for
   * PLAYER.GUARD_HOLD_GRACE, so input jitter can't open you up.
   */
  private updateBlockingState(player: Player, input: PlayerInput) {
    const activeWeapon = player.weapons[player.activeSlot];
    const guardDropped = !activeWeapon
      || activeWeapon.weaponId !== 'cutlass'
      || activeWeapon.reloading
      || !!input.fire
      || !!player.carryingChestId
      || player.atCannon
      || player.atHelm;
    if (guardDropped) {
      player.blocking = false;
      this.guardHeldAt.delete(player.id);
      return;
    }
    if (input.aim && player.state !== 'swimming') {
      this.guardHeldAt.set(player.id, this.t);
      player.blocking = true;
      return;
    }
    // Deliberately NOT gated on player.blocking: an on-foot pirate runs through
    // clearStationFlags (which zeroes the flag) every tick before this method is
    // reached, so the timestamp — set only while the stance was genuinely fed,
    // wiped by every deliberate drop above — is the only honest memory of it.
    const heldAt = this.guardHeldAt.get(player.id);
    if (heldAt !== undefined && this.t - heldAt <= PLAYER.GUARD_HOLD_GRACE) {
      player.blocking = true;
      return;
    }
    player.blocking = false;
    this.guardHeldAt.delete(player.id);
  }

  private getCutlassBlockScale(target: Player, attacker: Player, guardBreak = false): number {
    if (!target.blocking || target.state === 'swimming' || target.carryingChestId) return 1;
    const activeWeapon = target.weapons[target.activeSlot];
    if (!activeWeapon || activeWeapon.weaponId !== 'cutlass') return 1;
    const dx = attacker.position.x - target.position.x;
    const dz = attacker.position.z - target.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return 1;
    const angleToAttacker = Math.atan2(dx, dz);
    const facingDelta = Math.abs(angleWrap(angleToAttacker - target.rotation.x));
    if (facingDelta > Math.PI * 0.58) return 1;
    // A guard that faces the swing WORKS (Sea-of-Thieves rule): ordinary swipes
    // are fully turned; only the charged lunge is a guard-breaker that still
    // lands part of its weight through the parry.
    return guardBreak ? 0.45 : 0;
  }

  private applyCutlassLunge(player: Player, yaw: number) {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    player.knockbackVelocity.x += forwardX * CUTLASS_LUNGE_IMPULSE;
    player.knockbackVelocity.y += 1.2;
    player.knockbackVelocity.z += forwardZ * CUTLASS_LUNGE_IMPULSE;
    player.velocity.y = Math.max(player.velocity.y, 1.6);
    player.shipBoundaryGraceTimer = Math.max(player.shipBoundaryGraceTimer, PLAYER.SHIP_EXIT_GRACE_TIME + 0.35);
  }

  private tryDigChest(player: Player, input: PlayerInput, dt: number) {
    // HOLD [X] digs, and so does the trigger with the shovel actually in hand.
    const shovelSwing = !!input.useItem && player.equippedTool === 'shovel';
    if (!player.nearChestId || !(input.interactHeld || shovelSwing)) return;
    if (!player.hasShovel) return;
    for (const island of this.state.islands) {
      for (const chest of island.chests) {
        if (chest.id !== player.nearChestId || chest.opened) continue;
        if (!chest.buried || chest.digProgress >= 1) return;
        chest.digProgress = Math.min(1, chest.digProgress + POCKET.DIG_RATE * dt);
        if (chest.digProgress >= 1) {
          chest.position.y = getIslandSurfaceY(island, chest.position.x, chest.position.z) + 0.32;
          this.statsDelta(player.id).chestsDug += 1;
        }
        return;
      }
    }
  }

  /** Axe gathering: swing (useItem) at a palm → pocket wood, at a boulder →
   *  pocket ore. Progress accumulates per-prop over CHOP_TIME/MINE_TIME; the
   *  felled prop is spliced out of island.props server-side (that also kills
   *  its collider — resolvePropCollision iterates the live array) and clients
   *  learn about it via the prop_removed broadcast. */
  private tryHarvestProp(player: Player, input: PlayerInput, dt: number) {
    const swinging = !!input.useItem
      && player.equippedTool === 'axe'
      && player.state === 'alive'
      && player.onShipId === null
      && !player.carryingChestId;
    if (!swinging) {
      this.harvestProgressByPlayer.delete(player.id);
      return;
    }

    let best: { island: Island; prop: IslandProp; d: number } | null = null;
    for (const island of this.state.islands) {
      if (!island.props) continue;
      // Broad phase: every harvestable prop lives inside the footprint.
      if (!isPointInsideIslandFootprint(island, player.position.x, player.position.z, HARVEST.RANGE + 3)) continue;
      for (const prop of island.props) {
        if (prop.id === undefined) continue;
        const isPalm = prop.type.startsWith('palm_') && prop.type !== 'palm_ground';
        if (!isPalm && !prop.type.startsWith('boulder_')) continue;
        const d = dist2D(player.position.x, player.position.z, prop.x, prop.z);
        if (d < HARVEST.RANGE && (!best || d < best.d)) best = { island, prop, d };
      }
    }
    if (!best || best.prop.id === undefined) {
      this.harvestProgressByPlayer.delete(player.id);
      return;
    }

    const previous = this.harvestProgressByPlayer.get(player.id);
    const progress = previous && previous.islandId === best.island.id && previous.propId === best.prop.id
      ? previous
      : { islandId: best.island.id, propId: best.prop.id, t: 0 };
    progress.t += dt;
    this.harvestProgressByPlayer.set(player.id, progress);

    const isPalm = best.prop.type.startsWith('palm_');
    if (progress.t < (isPalm ? HARVEST.CHOP_TIME : HARVEST.MINE_TIME)) return;

    const index = best.island.props?.indexOf(best.prop) ?? -1;
    if (index >= 0) best.island.props?.splice(index, 1);
    this.harvestProgressByPlayer.delete(player.id);

    let wood: number | undefined;
    let ore: number | undefined;
    if (isPalm) {
      wood = randInt(HARVEST.WOOD_PER_TREE_MIN, HARVEST.WOOD_PER_TREE_MAX, this.rng);
      player.pocketWood += wood;
      this.statsDelta(player.id).woodChopped += wood;
    } else {
      ore = randInt(HARVEST.ORE_PER_BOULDER_MIN, HARVEST.ORE_PER_BOULDER_MAX, this.rng);
      player.pocketOre += ore;
      this.statsDelta(player.id).oreMined += ore;
    }
    this.broadcast({
      type: 'prop_removed',
      ts: Date.now(),
      payload: {
        islandId: best.island.id,
        propId: best.prop.id,
        propType: best.prop.type,
        byPlayerId: player.id,
        byPlayerName: player.name,
        ...(wood !== undefined ? { wood } : {}),
        ...(ore !== undefined ? { ore } : {}),
      },
    });
  }

  private tryUsePocketWheel(client: ConnectedClient, player: Player, ship: Ship | null, input: PlayerInput) {
    if (!input.useWheelItem || input.wheelIndex === null) return;
    if (player.state === 'eliminated' || player.state === 'respawning') return;
    if (player.carryingChestId) return;
    // Edge-trigger guard: same input replayed across ticks must not consume twice.
    if (!this.consumeOneShot(client, 'wheel', input.seq)) return;
    const crewShip =
      ship ??
      this.getAliveShip(player.shipId);
    const ix = input.wheelIndex;
    // Unified supply wheel — slots 0-2,7-9 EQUIP a tool (instant toggle, no
    // cooldown); slot 3 transfers a plank to ship stores; slots 4-6 eat one
    // consumable. Layout mirrors the client SVG (10-slice wheel).
    const tool: EquippableTool | null =
      ix === 0 ? 'spyglass'
        : ix === 1 ? 'compass'
          : ix === 2 ? 'bucket'
            : ix === 7 ? 'shovel'
              : ix === 8 ? 'lantern'
                : ix === 9 ? 'axe'
                  : null;
    if (tool) {
      // Equipping a tool is instant — bypasses the consumable use-cooldown.
      // The toggle-to-stow is guarded by a short grace window: the wheel UI
      // can emit the same slot twice for one gesture (slice click + hover
      // release), which used to equip-then-instantly-stow the tool.
      const equip = this.lastToolEquip.get(player.id);
      if (player.equippedTool === tool) {
        if (equip && equip.tool === tool && this.t - equip.at < 0.5) return;
        player.equippedTool = null;
      } else {
        player.equippedTool = tool;
        this.lastToolEquip.set(player.id, { tool, at: this.t });
      }
      return;
    }
    // Consumables/planks respect the use-cooldown (one fruit at a time).
    if (player.pocketUseCooldown > 0) return;
    let consumed = false;
    if (ix === 3) {
      if (player.pocketWood <= 0 || !crewShip) return;
      player.pocketWood -= 1;
      this.islands.addItemToShipInventory(crewShip, 'wood_plank', 1);
      consumed = true;
    } else if (ix === 4) {
      // Eat from your pocket first, then the ship's larder (shared crew food).
      if (player.pocketBanana > 0) player.pocketBanana -= 1;
      else if (!crewShip || !this.consumeShipItem(crewShip, 'banana', 1)) return;
      player.health = Math.min(PLAYER.MAX_HEALTH, player.health + PLAYER.BANANA_HEAL);
      consumed = true;
    } else if (ix === 5) {
      if (player.pocketCoconut > 0) player.pocketCoconut -= 1;
      else if (!crewShip || !this.consumeShipItem(crewShip, 'coconut', 1)) return;
      player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
      consumed = true;
    } else if (ix === 6) {
      if (player.pocketMeat > 0) {
        player.pocketMeat -= 1;
        // Eat the BEST typed cut first (pork before gull scraps); meat with
        // no known animal (barrels, larder pickups) heals the generic value.
        let heal: number = POCKET.MEAT_HEAL;
        let best: WildlifeType | null = null;
        for (const type of Object.keys(player.pocketMeatByType) as WildlifeType[]) {
          if ((player.pocketMeatByType[type] ?? 0) > 0 && (best === null || WILDLIFE.MEAT_HEAL[type] > WILDLIFE.MEAT_HEAL[best])) {
            best = type;
          }
        }
        if (best) {
          player.pocketMeatByType[best] = (player.pocketMeatByType[best] ?? 1) - 1;
          heal = WILDLIFE.MEAT_HEAL[best];
        }
        player.health = Math.min(PLAYER.MAX_HEALTH, player.health + heal);
      } else if (player.pocketMango > 0) {
        player.pocketMango -= 1;
        player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
      } else if (crewShip && this.consumeShipItem(crewShip, 'meat', 1)) {
        player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.MEAT_HEAL);
      } else if (crewShip && this.consumeShipItem(crewShip, 'mango', 1)) {
        player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
      } else {
        return;
      }
      consumed = true;
    }
    if (consumed) {
      player.pocketUseCooldown = POCKET.USE_COOLDOWN;
    }
  }

  private getChestById(chestId: string | null): { chest: TreasureChest; island: Island } | null {
    if (!chestId) return null;
    for (const island of this.state.islands) {
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (chest) return { chest, island };
    }
    return null;
  }

  private syncTreasureChests() {
    for (const island of this.state.islands) {
      for (const chest of island.chests) {
        if (chest.opened) continue;
        if (chest.carriedByPlayerId) {
          const carrier = this.getPlayer(chest.carriedByPlayerId);
          if (!carrier || carrier.state === 'eliminated' || carrier.state === 'respawning') {
            chest.carriedByPlayerId = null;
            chest.droppedOnShipId = null;
            chest.droppedLocalPosition = null;
            chest.floating = true;
            chest.position.y = 0.45;
            continue;
          }
          const yaw = carrier.rotation.x;
          chest.position.x = carrier.position.x - Math.sin(yaw) * 0.52 + Math.cos(yaw) * 0.36;
          chest.position.y = carrier.position.y + (carrier.state === 'swimming' ? 0.45 : 0.72);
          chest.position.z = carrier.position.z - Math.cos(yaw) * 0.52 - Math.sin(yaw) * 0.36;
          chest.storedOnShipId = null;
          chest.droppedOnShipId = null;
          chest.droppedLocalPosition = null;
          chest.floating = false;
          continue;
        }
        if (chest.storedOnShipId) {
          const ship = this.getShip(chest.storedOnShipId);
          if (!ship || !ship.alive || ship.sinking) {
            chest.storedOnShipId = null;
            chest.droppedOnShipId = null;
            chest.droppedLocalPosition = null;
            chest.floating = true;
            chest.position.y = 0.45;
            continue;
          }
          const index = Math.max(0, ship.treasureChestIds.indexOf(chest.id));
          const stats = SHIP_STATS[ship.type];
          const localX = (index % 3 - 1) * 0.62;
          const localZ = -stats.length * 0.24 - Math.floor(index / 3) * 0.58;
          const world = this.toShipWorld(localX, localZ, ship);
          chest.position.x = world.x;
          chest.position.y = ship.position.y + stats.height + 0.42;
          chest.position.z = world.z;
          chest.droppedOnShipId = null;
          chest.droppedLocalPosition = null;
          chest.floating = false;
          continue;
        }
        if (chest.droppedOnShipId && chest.droppedLocalPosition) {
          const ship = this.getShip(chest.droppedOnShipId);
          if (!ship || !ship.alive || ship.sinking) {
            chest.droppedOnShipId = null;
            chest.droppedLocalPosition = null;
            chest.floating = true;
            chest.position.y = 0.45;
            continue;
          }
          const world = this.toShipWorld(chest.droppedLocalPosition.x, chest.droppedLocalPosition.z, ship);
          chest.position.x = world.x;
          chest.position.y = ship.position.y + chest.droppedLocalPosition.y;
          chest.position.z = world.z;
          chest.floating = false;
          continue;
        }
        if (chest.floating) {
          // Ride the real sea (storm included) — a fixed 0.45 clipped under
          // every crest once base waves reached ±1m and storm swell ±3.5m.
          const chestSea = stormSeaState(this.state.storm, chest.position.x, chest.position.z);
          chest.position.y = gerstnerHeight(chest.position.x, chest.position.z, this.t, WAVE_PARAMS, chestSea)
            + 0.32 + Math.sin(this.t * 1.8 + chest.value * 0.01) * 0.05;
        }
      }
    }
  }

  private tryTakeChest(player: Player) {
    if (!player.nearChestId || player.carryingChestId) return null;
    const found = this.getChestById(player.nearChestId);
    if (!found) return null;
    const { chest, island } = found;
    if (chest.opened) return null;
    if (chest.buried && chest.digProgress < 1) return null;
    const dx = player.position.x - chest.position.x;
    const dy = player.position.y - chest.position.y;
    const dz = player.position.z - chest.position.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > PLAYER.INTERACT_RANGE + 0.7) return null;

    if (chest.carriedByPlayerId && chest.carriedByPlayerId !== player.id) {
      const previous = this.getPlayer(chest.carriedByPlayerId);
      if (previous && previous.carryingChestId === chest.id) previous.carryingChestId = null;
    }
    if (chest.storedOnShipId) {
      const storedShip = this.getShip(chest.storedOnShipId);
      if (storedShip) {
        storedShip.treasureChestIds = storedShip.treasureChestIds.filter((id) => id !== chest.id);
      }
    }

    chest.carriedByPlayerId = player.id;
    chest.storedOnShipId = null;
    chest.droppedOnShipId = null;
    chest.droppedLocalPosition = null;
    chest.floating = false;
    player.carryingChestId = chest.id;
    this.syncTreasureChests();
    return {
      playerId: player.id,
      chestId: chest.id,
      islandId: island.id,
      islandName: island.name,
      value: chest.value,
      action: 'pickup',
      loot: [],
    };
  }

  private tryStowCarriedChest(player: Player, ship: Ship): boolean {
    if (!player.carryingChestId || player.onShipId !== ship.id) return false;
    const found = this.getChestById(player.carryingChestId);
    if (!found || found.chest.opened) {
      player.carryingChestId = null;
      return false;
    }
    const chest = found.chest;
    chest.carriedByPlayerId = null;
    chest.storedOnShipId = ship.id;
    chest.droppedOnShipId = null;
    chest.droppedLocalPosition = null;
    chest.floating = false;
    player.carryingChestId = null;
    if (!ship.treasureChestIds.includes(chest.id)) ship.treasureChestIds.push(chest.id);
    this.syncTreasureChests();
    this.broadcast({
      type: 'chest_opened',
      ts: Date.now(),
      payload: { playerId: player.id, chestId: chest.id, value: chest.value, action: 'stow' },
    });
    return true;
  }

  private dropCarriedChest(player: Player, announce = false) {
    if (!player.carryingChestId) return;
    const found = this.getChestById(player.carryingChestId);
    if (!found) {
      player.carryingChestId = null;
      return;
    }
    const chest = found.chest;
    chest.carriedByPlayerId = null;
    chest.storedOnShipId = null;
    const dropWaveY = gerstnerHeight(player.position.x, player.position.z, this.t, WAVE_PARAMS,
      stormSeaState(this.state.storm, player.position.x, player.position.z));
    chest.floating = player.position.y < dropWaveY + 0.65 || player.state === 'swimming';
    chest.position = {
      x: player.position.x,
      y: chest.floating
        ? gerstnerHeight(player.position.x, player.position.z, this.t, WAVE_PARAMS,
          stormSeaState(this.state.storm, player.position.x, player.position.z)) + 0.32
        : player.position.y + 0.25,
      z: player.position.z,
    };
    const deckShip = !chest.floating && player.onShipId ? this.getAliveShip(player.onShipId) : null;
    if (deckShip) {
      const local = this.toShipLocal(chest.position, deckShip);
      chest.droppedOnShipId = deckShip.id;
      chest.droppedLocalPosition = {
        x: local.x,
        y: chest.position.y - deckShip.position.y,
        z: local.z,
      };
    } else {
      chest.droppedOnShipId = null;
      chest.droppedLocalPosition = null;
    }
    const chestId = chest.id;
    const value = chest.value;
    player.carryingChestId = null;
    this.syncTreasureChests();
    if (announce) {
      this.broadcast({
        type: 'chest_opened',
        ts: Date.now(),
        payload: { playerId: player.id, chestId, value, action: 'drop' },
      });
    }
  }

  private handleGoldHoarderInteraction(player: Player): boolean {
    const hoarder = findNearbyGoldHoarder(this.state.islands, player);
    if (!hoarder) return false;
    if (player.carryingChestId) {
      return this.sellCarriedChest(player, hoarder.island);
    }
    // Iron Cuirass — deliberately pricey combat plate, offered once you've
    // taken a map job and can pay. One plate at a time (no topping a full set).
    if (
      player.treasureMapIslandId
      && player.gold >= ECONOMY.ARMOR_PRICE
      && player.armor < PLAYER.MAX_ARMOR * 0.5
    ) {
      player.gold -= ECONOMY.ARMOR_PRICE;
      player.armor = PLAYER.MAX_ARMOR;
      const client = this.clients.get(player.id);
      if (client) {
        this.send(client.ws, {
          type: 'armor_bought',
          ts: Date.now(),
          payload: { price: ECONOMY.ARMOR_PRICE, armor: player.armor },
        });
      }
      return true;
    }
    return this.grantTreasureMap(player, hoarder.island.id);
  }

  private sellCarriedChest(player: Player, island: Island): boolean {
    const found = this.getChestById(player.carryingChestId);
    if (!found || found.chest.opened) {
      player.carryingChestId = null;
      return false;
    }
    const chest = found.chest;
    chest.opened = true;
    chest.carriedByPlayerId = null;
    chest.storedOnShipId = null;
    chest.droppedOnShipId = null;
    chest.droppedLocalPosition = null;
    chest.floating = false;
    player.carryingChestId = null;
    const fromActiveMap = player.treasureMapIslandId === found.island.id;
    const saleValue = Math.round(
      chest.value
      * ECONOMY.CHEST_SELL_MULTIPLIER
      * (fromActiveMap ? ECONOMY.HOARDER_QUEST_CHEST_BONUS : 1),
    );
    player.gold += saleValue;
    this.statsDelta(player.id).chestsSold += 1;
    this.broadcast({
      type: 'treasure_sold',
      ts: Date.now(),
      payload: {
        playerId: player.id,
        playerName: player.name,
        chestId: chest.id,
        islandName: island.name,
        gold: saleValue,
        baseGold: chest.value,
        questBonus: fromActiveMap,
        totalGold: player.gold,
      },
    });
    this.grantTreasureMap(player, island.id);
    this.checkWinCondition();
    return true;
  }

  private grantTreasureMap(player: Player, excludeIslandId: string | null = null): boolean {
    const isBuriedMapChest = (chest: TreasureChest) =>
      chest.buried
      && chest.digProgress < 1
      && !chest.opened
      && !chest.carriedByPlayerId
      && !chest.storedOnShipId
      && !chest.floating;
    const candidates = this.state.islands.filter((island) =>
      island.chests.some(isBuriedMapChest)
    );
    if (candidates.length === 0) {
      player.treasureMapIslandId = null;
      return false;
    }
    const eligible = candidates.filter((island) => island.id !== excludeIslandId);
    const targetPool = eligible.length > 0 ? eligible : candidates;
    const current = player.treasureMapIslandId
      ? targetPool.find((island) => island.id === player.treasureMapIslandId)
      : null;
    // Prefer a fresh island the player doesn't already hold a map for — the
    // hoarder hands out a POCKETFUL of maps (SoT quest radial), not one.
    const unheld = targetPool.filter((island) => !player.questMaps.includes(island.id));
    const drawPool = unheld.length > 0 ? unheld : targetPool;
    const target = (current && !player.questMaps.includes(current.id) ? current : null) ?? drawPool
      .map((island) => ({
        island,
        distance: dist2D(player.position.x, player.position.z, island.position.x, island.position.z),
      }))
      .sort((a, b) => a.distance - b.distance)[0].island;
    if (!player.questMaps.includes(target.id)) {
      player.questMaps.push(target.id);
      // Pocket holds three maps — oldest goes back to the hoarder.
      while (player.questMaps.length > 3) {
        const dropped = player.questMaps.shift();
        if (dropped === player.treasureMapIslandId) player.treasureMapIslandId = null;
      }
    }
    player.treasureMapIslandId = player.treasureMapIslandId ?? target.id;
    if (!player.questMaps.includes(player.treasureMapIslandId)) {
      player.treasureMapIslandId = target.id;
    }
    const client = this.clients.get(player.id);
    if (client) {
      this.send(client.ws, {
        type: 'treasure_map',
        ts: Date.now(),
        payload: {
          islandId: target.id,
          islandName: target.name,
          chestCount: target.chests.filter(isBuriedMapChest).length,
        },
      });
    }
    return true;
  }

  /** Drop quest maps whose island has no diggable chest left; keep the active
   *  map pointing at a REAL objective. Runs cheaply on the snapshot cadence. */
  private pruneQuestMaps() {
    const islandHasDig = (id: string) => {
      const island = this.state.islands.find((candidate) => candidate.id === id);
      return !!island && island.chests.some((chest) =>
        chest.buried && chest.digProgress < 1 && !chest.opened
        && !chest.carriedByPlayerId && !chest.storedOnShipId && !chest.floating);
    };
    for (const player of this.state.players) {
      if (player.isBot || player.questMaps.length === 0) continue;
      const kept = player.questMaps.filter(islandHasDig);
      if (kept.length !== player.questMaps.length) {
        player.questMaps = kept;
        if (player.treasureMapIslandId && !kept.includes(player.treasureMapIslandId)) {
          player.treasureMapIslandId = kept[0] ?? null;
        }
      }
    }
  }

  private updateKegs(dt: number) {
    for (const keg of this.state.kegs) {
      if (keg.defused) continue; // cut fuse — inert until cleanup removes it
      const ship = this.syncKegPosition(keg);
      if (keg.shipId && (!ship || !ship.alive || ship.sinking)) {
        keg.timer = 0;
        continue;
      }
      keg.timer -= dt;
      if (keg.timer <= 0) {
        this.explodeKeg(keg);
      }
    }
  }

  private explodeKeg(keg: ShipKeg) {
    if (keg.defused) return;
    this.syncKegPosition(keg);
    const attacker = this.getPlayer(keg.plantedById);
    const playerDamageMult = keg.mega ? 1.35 : 1;

    for (const hit of this.getKegShipHits(keg)) {
      this.markShipDamagedByPlayer(hit.ship.id, keg.plantedById);
      // A keg blast caves the hull in RADIALLY from where the barrel sat: the
      // face it was lashed to is stove wide open in a tight cluster, the other
      // three faces spring a plank each. A MEGA keg riddles the whole hull.
      const kegLocal = this.toShipLocal(keg.position, hit.ship);
      const bandY = (FLOODING.HOLE_BAND_Y.min + FLOODING.HOLE_BAND_Y.max) * 0.5;
      // The blast face is stove in first and the shock spends what is left on
      // the others — and the whole blast is capped, so one keg can never open
      // more breaches than a crew could conceivably plank (see
      // SHIP.KEG_MAX_HOLES_PER_BLAST).
      const sections = this.getHullSections()
        .slice()
        .sort((a, b) => Number(b === hit.section) - Number(a === hit.section));
      let budget = SHIP.KEG_MAX_HOLES_PER_BLAST;
      for (const section of sections) {
        if (budget <= 0) break;
        const isPrimary = section === hit.section;
        const holes = Math.min(budget, keg.mega ? (isPrimary ? 3 : 2) : (isPrimary ? 2 : 1));
        budget -= holes;
        // Primary face: cluster on the blast point itself. Other faces: the
        // shock finds their centre.
        const aim = isPrimary
          ? { x: kegLocal.x, z: kegLocal.z }
          : this.getSectionAimLocal(hit.ship, section);
        const point = this.physics.hullFacePoint(hit.ship, aim, bandY, isPrimary ? 0.8 : 2.2);
        this.physics.openHoleAt(hit.ship, point, holes, 'keg');
      }
      hit.ship.onFire = true;
      hit.ship.fireTimer = Math.max(hit.ship.fireTimer, SHIP.FIRE_DURATION);
    }

    for (const player of this.state.players) {
      if (player.state === 'eliminated' || player.state === 'respawning' || player.respawnProtectionTimer > 0) continue;
      const dx = player.position.x - keg.position.x;
      const dy = (player.position.y + PLAYER.HEIGHT * 0.4) - keg.position.y;
      const dz = player.position.z - keg.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > SHIP.KEG_PLAYER_RADIUS) continue;

      const damageScale = 1 - Math.min(1, distance / SHIP.KEG_PLAYER_RADIUS);
      const damage = (
        SHIP.KEG_PLAYER_MIN_DAMAGE
        + (SHIP.KEG_PLAYER_DAMAGE - SHIP.KEG_PLAYER_MIN_DAMAGE) * Math.pow(damageScale, 1.7)
      ) * playerDamageMult;
      player.lastDamagedById = attacker?.id ?? null;
      player.lastDamagedAt = attacker ? this.t : null;
      player.lastDamageWasHeadshot = false;
      this.noteDamageSource(player.id, 'explosion');
      player.health -= this.absorbWithArmor(player, damage);
      if (attacker) {
        this.notifyPlayerHit(attacker.id, {
          targetId: player.id,
          damage,
          position: {
            x: player.position.x,
            y: player.position.y + PLAYER.HEIGHT * 0.72,
            z: player.position.z,
          },
          kill: player.health <= 0,
          remainingHealth: Math.max(0, player.health),
          weaponId: 'powder_keg',
        });
      }
      this.notifyIncomingPlayerHit(player.id, {
        attackerId: attacker?.id,
        attackerName: attacker?.name ?? 'Powder Keg',
        damage,
        position: {
          x: player.position.x,
          y: player.position.y + PLAYER.HEIGHT * 0.72,
          z: player.position.z,
        },
        sourcePosition: { ...keg.position },
        kill: player.health <= 0,
        remainingHealth: Math.max(0, player.health),
        weaponId: 'powder_keg',
      });
      const force = Math.max(3.5, SHIP.KEG_BLAST_FORCE * Math.pow(damageScale, 1.2));
      const inv = distance > 0.001 ? 1 / distance : 0;
      player.knockbackVelocity.x += dx * inv * force;
      player.knockbackVelocity.y += Math.max(2.5, force * 0.55);
      player.knockbackVelocity.z += dz * inv * force;
    }

    this.broadcast({
      type: 'keg_exploded',
      ts: Date.now(),
      payload: {
        position: { ...keg.position },
        radius: SHIP.KEG_PLAYER_RADIUS,
        mega: !!keg.mega,
      },
    });
    keg.timer = 0;
  }

  private getKegShipHits(keg: ShipKeg): Array<{ ship: Ship; section: keyof HullSections }> {
    if (keg.shipId) {
      const attachedShip = this.getAliveShip(keg.shipId);
      return attachedShip ? [{ ship: attachedShip, section: keg.section }] : [];
    }

    const hits: Array<{ ship: Ship; section: keyof HullSections }> = [];
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      const stats = SHIP_STATS[ship.type];
      const local = this.toShipLocal(keg.position, ship);
      const blastPadding = SHIP.KEG_PLAYER_RADIUS * 0.85;
      if (Math.abs(local.x) > stats.width * 0.5 + blastPadding) continue;
      if (Math.abs(local.z) > stats.length * 0.5 + blastPadding) continue;
      hits.push({ ship, section: this.getHullSectionFromLocal(local) });
    }
    return hits;
  }

  private getHullSectionFromLocal(local: { x: number; z: number }): keyof HullSections {
    return Math.abs(local.x) > Math.abs(local.z)
      ? (local.x >= 0 ? 'starboard' : 'port')
      : (local.z >= 0 ? 'bow' : 'stern');
  }

  private getHullSections(): Array<keyof HullSections> {
    return ['bow', 'stern', 'port', 'starboard'];
  }

  private fireTsunamiSpecial(player: Player, yaw: number) {
    if (player.tsunamiCharges <= 0) return;
    player.tsunamiCharges = Math.max(0, player.tsunamiCharges - 1);

    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const origin = {
      x: player.position.x + dirX * 2.5,
      y: Math.max(0.55, player.position.y + 0.25),
      z: player.position.z + dirZ * 2.5,
    };
    const length = 520;
    const baseWidth = 44;

    this.weapons.queueProjectile({
      id: uuid(),
      type: 'tsunami',
      ownerId: player.id,
      ownerShipId: player.shipId,
      position: { ...origin },
      velocity: { x: dirX * 132, y: 0, z: dirZ * 132 },
      alive: true,
      age: 0,
      maxAge: 3.9,
      damage: 0,
      knockback: 0,
      visualOnly: true,
      showImpact: false,
      special: 'tsunami',
    });

    for (const target of this.state.players) {
      if (
        target.id === player.id
        || target.state === 'eliminated'
        || target.state === 'respawning'
        || target.respawnProtectionTimer > 0
      ) continue;

      const dx = target.position.x - origin.x;
      const dz = target.position.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < -5 || along > length) continue;
      const across = Math.abs(dx * rightX + dz * rightZ);
      const width = baseWidth * (1 - Math.min(0.42, along / length * 0.42));
      if (across > width) continue;

      const lateralFalloff = 1 - Math.min(1, across / Math.max(1, width));
      const forwardImpulse = 78 + lateralFalloff * 40;
      this.clearStationFlags(target);
      target.onShipId = null;
      target.shipBoundaryGraceTimer = Math.max(target.shipBoundaryGraceTimer, PLAYER.SHIP_EXIT_GRACE_TIME + 1.2);
      target.cannonBallistic = false;
      target.cannonFlightTimer = 0;
      target.knockbackVelocity.x += dirX * forwardImpulse;
      target.knockbackVelocity.y += 7.5 + lateralFalloff * 3.5;
      target.knockbackVelocity.z += dirZ * forwardImpulse;
      target.position.x += dirX * 0.85;
      target.position.z += dirZ * 0.85;
    }

    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking || ship.id === player.shipId) continue;
      const dx = ship.position.x - origin.x;
      const dz = ship.position.z - origin.z;
      const along = dx * dirX + dz * dirZ;
      if (along < -10 || along > length) continue;
      const across = Math.abs(dx * rightX + dz * rightZ);
      const width = baseWidth * 1.45;
      if (across > width) continue;
      const falloff = 1 - Math.min(1, across / width);
      ship.velocity.x += dirX * (18 + falloff * 14);
      ship.velocity.z += dirZ * (18 + falloff * 14);
      ship.angularVelocity += (across < 1 ? 0 : Math.sign(dx * rightX + dz * rightZ)) * 0.22 * falloff;
    }
  }

  /**
   * A ship sinks when a section is completely destroyed, its average hull is
   * fills (waterLevel ≥ 1) — the SoT path: holes flood the hull faster than
   * the crew can bail. Hull hp alone never sinks a ship; wrecked sections just
   * gush so hard the water wins unless they're planked.
   */
  private evaluateShipSinking(ship: Ship) {
    if (!ship.alive || ship.sinking) return;
    // Cannonballs make HOLES; only WATER sinks the ship. Wrecked sections
    // (hp 0) gush hard — evaluateSectionFlood treats them as breached even
    // above the waterline — so a shot-to-pieces hull still founders, but only
    // after the crew visibly loses the fight against the rising bilge.
    if ((ship.waterLevel ?? 0) >= 1) {
      this.startShipSinking(ship, false, this.getRecentShipSinkAttackerId(ship));
    }
  }

  /**
   * Bot damage-control (Match-side so BotSystem stays untouched), now under
   * the SAME constraints as players: no bailing/repairing while manning a
   * station, plank repairs only while standing at the holed section's rail
   * (bots walk there first), and at most two bailers per hull.
   */
  private updateBotFlooding(dt: number) {
    const bailersByShip = new Map<string, number>();
    for (const player of this.state.players) {
      if (!player.isBot || player.state === 'eliminated' || player.state === 'respawning' || player.state === 'downed') continue;
      const ship = this.getAliveShip(player.shipId);
      if (!ship || player.onShipId !== ship.id) {
        if (player.bailing) player.bailing = false;
        continue;
      }
      // Station crew keep fighting/steering — they can't bail or patch, same as humans.
      //
      // "At a station" has to include A CREW IN A GUNFIGHT. BotSystem raises
      // atCannon for the single tick it fires and drops it again, so a bot
      // trading broadsides read as an idle deckhand and worked the pumps and
      // the planks between every shot — while the human sailing alone has to
      // leave the gun to do either. Measured over the wreck at the old rule:
      // eight crews engaged, 25 open breaches on the water, three minutes, no
      // sinkings. One crew, one pair of hands, both sides.
      if (player.atCannon || player.atHelm || player.atCrowNest
        || this.bots.isAtGuns(player.id, this.t)) {
        if (player.bailing) player.bailing = false;
        continue;
      }
      const water = ship.waterLevel ?? 0;
      // Deepest breach first — the one actually letting water in hardest — with
      // hole id as the tie-break so a bot never dithers between two equals.
      const targetHole = this.getBotRepairTargetHole(ship);

      // Priority 1: walk to the rail directly above that breach and plank it
      // (throttled, consumes planks — the SAME findRepairableHole reach rule
      // humans get).
      if (targetHole && (this.botRepairCooldownAt.get(player.id) ?? 0) <= this.t && getRepairPlankCount(player, ship) > 0) {
        if (this.getRepairableHole(player, ship)?.id === targetHole.id) {
          if (this.consumeRepairPlank(player, ship)) {
            this.physics.patchHole(ship, targetHole.id);
            this.botRepairCooldownAt.set(player.id, this.t + SHIP.FIELD_REPAIR_INTERVAL);
          }
        } else {
          const rail = this.getHoleRailLocal(ship, targetHole);
          const world = this.toShipWorld(rail.x, rail.z, ship);
          this.stepBotToward(player, { x: world.x, y: player.position.y, z: world.z }, dt);
          if (player.bailing) player.bailing = false;
          continue;
        }
      }

      // Priority 2: bail down deep water (bucket line caps at two per hull).
      const activeBailers = bailersByShip.get(ship.id) ?? 0;
      if (water > FLOODING.BOT_BAIL_THRESHOLD && activeBailers < 2) {
        ship.waterLevel = Math.max(0, water - FLOODING.BAIL_RATE * dt);
        player.bailing = true;
        bailersByShip.set(ship.id, activeBailers + 1);
      } else if (player.bailing) {
        player.bailing = false;
      }
    }
  }

  /** Ship-local aim point at the centre of a hull section's face — the
   *  direction a keg blast or storm sea comes from when all we know is a
   *  section, not a surface point. */
  private getSectionAimLocal(ship: Ship, section: keyof HullSections): { x: number; z: number } {
    const stats = SHIP_STATS[ship.type];
    switch (section) {
      case 'bow': return { x: 0, z: stats.length };
      case 'stern': return { x: 0, z: -stats.length };
      case 'starboard': return { x: stats.width, z: 0 };
      case 'port': return { x: -stats.width, z: 0 };
    }
  }

  /** Ship-local standing point on the DECK directly above a breach — the spot
   *  a carpenter walks to before swinging. Clamped inside the walkable rail. */
  private getHoleRailLocal(ship: Ship, hole: ShipHole): { x: number; z: number } {
    const stats = SHIP_STATS[ship.type];
    return {
      x: clamp(hole.x, -stats.width * 0.42, stats.width * 0.42),
      z: clamp(hole.z, -stats.length * 0.38, stats.length * 0.38),
    };
  }

  /** The breach a damage-control bot (or the anchored auto-carpenter) plugs
   *  first: the deepest-sitting open hole, tie-broken by age. */
  private getBotRepairTargetHole(ship: Ship): ShipHole | null {
    let best: ShipHole | null = null;
    for (const hole of ship.holes ?? []) {
      if (hole.patched) continue;
      if (!best || hole.y < best.y - 1e-6 || (Math.abs(hole.y - best.y) <= 1e-6 && hole.id < best.id)) {
        best = hole;
      }
    }
    return best;
  }

  private updateFieldRepairs(dt: number) {
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;

      ship.repairCooldown = Math.max(0, ship.repairCooldown - dt);
      const target = this.getBotRepairTargetHole(ship);
      const plankStack = ship.inventory.find((entry) => entry.item === 'wood_plank' && entry.qty > 0);
      if (!ship.anchored || ship.onFire || ship.repairCooldown > 0 || !target || !plankStack) {
        ship.autoRepairProgress = 0;
        continue;
      }

      ship.autoRepairProgress += dt;
      if (ship.autoRepairProgress < SHIP.FIELD_REPAIR_INTERVAL) continue;
      ship.autoRepairProgress = 0;
      if (!this.consumeShipItem(ship, 'wood_plank', 1)) continue;
      this.physics.patchHole(ship, target.id);
    }
  }

  /** Kegs riding a hull only carry a hull-local position — freshen the world
   *  transforms of every candidate before the shared proximity scan reads them. */
  private getNearbyKeg(player: Player, ship: Ship | null = null) {
    for (const keg of this.state.kegs) {
      if (ship && keg.shipId && keg.shipId !== ship.id) continue;
      if (keg.timer <= 0) continue;
      this.syncKegPosition(keg);
    }
    return findNearbyKeg(this.state.kegs, player, ship);
  }

  private diffuseKeg(keg: ShipKeg) {
    // Flag first — a bare timer=0 would read as "fuse burnt down" and detonate
    // in the same tick's updateKegs pass.
    keg.defused = true;
    keg.timer = 0;
  }

  private applyShipUpgrade(ship: Ship, type: ShipUpgrade['type']) {
    // Every upgrade is now a stateless read of ship.upgrades at point-of-use
    // (hull_reinforcement → slower flooding + faster pump in the flood loop;
    // charged_cannons → extra holes + blast at fire/impact; swift_sails → speed),
    // so claiming one just records it — no stat mutation, no HP pool to inflate.
    ship.upgrades.push({ type });
  }

  private getKegPlacement(player: Player, ship: Ship | null) {
    if (ship && player.onShipId === ship.id) {
      const stats = SHIP_STATS[ship.type];
      const local = this.toShipLocal(player.position, ship);
      // Aboard your ship → ALWAYS attach the keg to the hull (the snap below clamps
      // it onto the deck). The old tight 0.42 box dropped a detached WORLD keg when
      // you stood near a rail/bow, and the moving ship immediately sailed away from
      // it — a keg that "wasn't put down properly".
      {
        const belowDeck = player.position.y < ship.position.y + stats.height - 0.25;
        const section = this.getHullSectionFromLocal(local);
        // Snap to gunwale / quarterdeck rail so kegs never sit on the open deck center (matches equipment staging).
        const railX = Math.sign(local.x || 1) * stats.width * 0.41;
        const railZ = Math.sign(local.z || 1) * stats.length * 0.18;
        const preferRailX = Math.abs(local.x) >= Math.abs(local.z) * 0.55;
        const snappedLocal = belowDeck
          ? {
              x: Math.max(-stats.width * 0.34, Math.min(stats.width * 0.34, local.x)),
              z: Math.max(-stats.length * 0.34, Math.min(stats.length * 0.34, local.z)),
            }
          : preferRailX
            ? { x: railX, z: Math.max(-stats.length * 0.36, Math.min(stats.length * 0.36, local.z)) }
            : { x: Math.max(-stats.width * 0.36, Math.min(stats.width * 0.36, local.x)), z: railZ };
        const world = this.toShipWorld(snappedLocal.x, snappedLocal.z, ship);
        return {
          shipId: ship.id,
          section,
          localPosition: {
            x: snappedLocal.x,
            y: belowDeck ? 0.55 : stats.height + 0.14,
            z: snappedLocal.z,
          },
          position: {
            x: world.x,
            y: ship.position.y + (belowDeck ? 0.55 : stats.height + 0.14),
            z: world.z,
          },
        };
      }
    }

    const forwardX = Math.sin(player.rotation.x);
    const forwardZ = Math.cos(player.rotation.x);
    const placeX = player.position.x + forwardX * 1.25;
    const placeZ = player.position.z + forwardZ * 1.25;
    let placeY = player.state === 'swimming' || player.position.y < 1.1
      ? 0.45
      : player.position.y + 0.08;

    for (const island of this.state.islands) {
      if (!isPointInsideIslandFootprint(island, placeX, placeZ, 1.5)) continue;
      placeY = getIslandSurfaceY(island, placeX, placeZ) + 0.22;
      break;
    }

    return {
      shipId: null,
      section: 'bow' as keyof HullSections,
      localPosition: null,
      position: {
        x: placeX,
        y: placeY,
        z: placeZ,
      },
    };
  }

  private launchPlayerFromCannon(player: Player, ship: Ship, aim: { yaw: number; pitch: number }) {
    const launchPitch = Math.max(
      SHIP.CANNON_PLAYER_LAUNCH_PITCH_MIN,
      Math.min(SHIP.CANNON_PLAYER_LAUNCH_PITCH_MAX, aim.pitch),
    );
    const muzzle = this.getCannonMuzzlePosition(ship, player.cannonIndex, aim.yaw, launchPitch);
    const dir = {
      x: Math.sin(aim.yaw) * Math.cos(launchPitch),
      y: Math.sin(launchPitch),
      z: Math.cos(aim.yaw) * Math.cos(launchPitch),
    };
    this.clearStationFlags(player);
    player.onShipId = null;
    player.cannonBallistic = true;
    player.cannonFlightTimer = SHIP.CANNON_PLAYER_FLIGHT_MAX;
    player.state = 'alive';
    player.position = { ...muzzle };
    player.velocity = {
      x: ship.velocity.x + dir.x * SHIP.CANNON_LAUNCH_SPEED,
      y: dir.y * SHIP.CANNON_LAUNCH_SPEED + SHIP.CANNON_LAUNCH_VERTICAL_BIAS,
      z: ship.velocity.z + dir.z * SHIP.CANNON_LAUNCH_SPEED,
    };
    player.knockbackVelocity = { x: 0, y: 0, z: 0 };
    player.shipBoundaryGraceTimer = PLAYER.SHIP_EXIT_GRACE_TIME + 0.8;
    player.nearShipId = null;
    player.nearChestId = null;
    ship.cannonCooldowns[player.cannonIndex] = Math.max(ship.cannonCooldowns[player.cannonIndex], SHIP.CANNON_RELOAD * 0.75);
  }

  private syncKegPosition(keg: ShipKeg) {
    if (!keg.shipId || !keg.localPosition) return null;
    const ship = this.getShip(keg.shipId);
    if (!ship) return null;
    const world = this.toShipWorld(keg.localPosition.x, keg.localPosition.z, ship);
    keg.position.x = world.x;
    keg.position.y = ship.position.y + keg.localPosition.y;
    keg.position.z = world.z;
    return ship;
  }

  private getCannonMuzzlePosition(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    return this.weapons.getCannonMuzzlePosition(ship, cannonIndex, yaw, pitch);
  }

  private resolveFirearmHits(shooter: Player, traces: HitscanTrace[]) {
    const hitFeedback = new Map<string, {
      targetId: string;
      damage: number;
      headshot: boolean;
      kill: boolean;
      remainingHealth: number;
      position: Vec3;
      weaponId: WeaponId;
    }>();
    const sharkHitFeedback = new Map<string, {
      targetId: string;
      damage: number;
      kill: boolean;
      remainingHealth: number;
      position: Vec3;
      weaponId: WeaponId;
      targetType: 'shark';
    }>();
    const wildlifeHitFeedback = new Map<string, {
      targetId: string;
      damage: number;
      kill: boolean;
      remainingHealth: number;
      position: Vec3;
      weaponId: WeaponId;
      targetType: 'wildlife';
      meat?: number;
      meatType?: WildlifeType;
    }>();

    for (const trace of traces) {
      // Terrain and ship hulls clamp the trace before any target test — a hit
      // beyond the first solid surface never lands.
      const occlusionDistance = this.getFirearmOcclusionDistance(shooter, trace);
      const occluded = occlusionDistance < trace.range;
      const effectiveTrace = occluded ? { ...trace, range: occlusionDistance } : trace;
      const playerHit = this.findClosestFirearmHit(shooter, effectiveTrace);
      const sharkHit = this.findClosestSharkHit(effectiveTrace);
      const wildlifeHit = this.findClosestWildlifeHit(effectiveTrace);
      const kegHit = this.findClosestKegHit(effectiveTrace);
      const seaRockHit = this.findClosestSeaRockHit(effectiveTrace);
      const closestDistance = Math.min(
        playerHit?.distance ?? Infinity,
        sharkHit?.distance ?? Infinity,
        wildlifeHit?.distance ?? Infinity,
        kegHit?.distance ?? Infinity,
        seaRockHit?.distance ?? Infinity,
      );
      const usePlayer = !!playerHit && playerHit.distance <= closestDistance;
      const useShark = !!sharkHit && sharkHit.distance < closestDistance + 0.0001 && !usePlayer;
      const useWildlife = !!wildlifeHit && wildlifeHit.distance < closestDistance + 0.0001 && !usePlayer && !useShark;
      const useKeg = !!kegHit && kegHit.distance < closestDistance + 0.0001 && !usePlayer && !useShark && !useWildlife;
      const useSeaRock = !!seaRockHit
        && seaRockHit.distance < closestDistance + 0.0001
        && !usePlayer
        && !useShark
        && !useWildlife
        && !useKeg;

      let tracerDistance = trace.range;
      let showImpact = false;

      if (useKeg && kegHit) {
        tracerDistance = kegHit.distance;
        showImpact = true;
        this.explodeKeg(kegHit.keg);
      } else if (useShark && sharkHit) {
        tracerDistance = sharkHit.distance;
        showImpact = true;
        const damage = trace.damage * SHARK.GUN_DAMAGE_MULT;
        sharkHit.shark.health -= damage;
        const existing = sharkHitFeedback.get(sharkHit.shark.id);
        const position = {
          x: sharkHit.shark.position.x,
          y: sharkHit.shark.position.y + 0.35,
          z: sharkHit.shark.position.z,
        };
        if (existing) {
          existing.damage += damage;
          existing.kill = sharkHit.shark.health <= 0;
          existing.remainingHealth = Math.max(0, sharkHit.shark.health);
          existing.position = position;
          existing.weaponId = trace.weaponId;
        } else {
          sharkHitFeedback.set(sharkHit.shark.id, {
            targetId: sharkHit.shark.id,
            damage,
            kill: sharkHit.shark.health <= 0,
            remainingHealth: Math.max(0, sharkHit.shark.health),
            position,
            weaponId: trace.weaponId,
            targetType: 'shark',
          });
        }
      } else if (useWildlife && wildlifeHit) {
        tracerDistance = wildlifeHit.distance;
        showImpact = true;
        const animal = wildlifeHit.animal;
        const damage = trace.damage * WILDLIFE.GUN_DAMAGE_MULT;
        const wasAlive = animal.health > 0;
        animal.health -= damage;
        const killed = wasAlive && animal.health <= 0;
        const meat = killed ? WILDLIFE.MEAT_DROP[animal.type] : 0;
        if (meat > 0) {
          shooter.pocketMeat += meat;
          // Typed cut — each animal's meat heals differently when eaten.
          shooter.pocketMeatByType[animal.type] = (shooter.pocketMeatByType[animal.type] ?? 0) + meat;
        }
        const position = {
          x: animal.position.x,
          y: animal.position.y + (animal.type === 'gull' ? 0.2 : 0.28),
          z: animal.position.z,
        };
        const existing = wildlifeHitFeedback.get(animal.id);
        if (existing) {
          existing.damage += damage;
          existing.kill = existing.kill || killed;
          existing.remainingHealth = Math.max(0, animal.health);
          existing.position = position;
          existing.weaponId = trace.weaponId;
          if (meat > 0) {
            existing.meat = (existing.meat ?? 0) + meat;
            existing.meatType = animal.type;
          }
        } else {
          wildlifeHitFeedback.set(animal.id, {
            targetId: animal.id,
            damage,
            kill: killed,
            remainingHealth: Math.max(0, animal.health),
            position,
            weaponId: trace.weaponId,
            targetType: 'wildlife',
            meat: meat || undefined,
            meatType: meat > 0 ? animal.type : undefined,
          });
        }
      } else if (usePlayer && playerHit) {
        const hit = playerHit;
        tracerDistance = hit.distance;
        showImpact = true;
        const damage = trace.damage * (hit.headshot ? this.getHeadshotMultiplier(trace.weaponId) : 1);
        const preserveCritical = hit.player.lastDamagedById === shooter.id && hit.player.lastDamageWasHeadshot;
        hit.player.lastDamagedById = shooter.id;
        hit.player.lastDamagedAt = this.t;
        hit.player.lastDamageWasHeadshot = hit.headshot || preserveCritical;
        this.noteDamageSource(hit.player.id, WEAPONS[trace.weaponId].melee ? 'blade' : 'gunshot');
        hit.player.health -= this.absorbWithArmor(hit.player, damage);
        const existing = hitFeedback.get(hit.player.id);
        if (existing) {
          existing.damage += damage;
          existing.headshot = existing.headshot || hit.headshot;
          existing.kill = hit.player.health <= 0;
          existing.remainingHealth = Math.max(0, hit.player.health);
          existing.weaponId = existing.weaponId ?? trace.weaponId;
          existing.position = {
            x: hit.player.position.x,
            y: hit.player.position.y + PLAYER.HEIGHT * 0.72,
            z: hit.player.position.z,
          };
        } else {
          hitFeedback.set(hit.player.id, {
            targetId: hit.player.id,
            damage,
            headshot: hit.headshot,
            kill: hit.player.health <= 0,
            remainingHealth: Math.max(0, hit.player.health),
            position: {
              x: hit.player.position.x,
              y: hit.player.position.y + PLAYER.HEIGHT * 0.72,
              z: hit.player.position.z,
            },
            weaponId: trace.weaponId,
          });
        }

        if (trace.knockback > 0) {
          const heavyKnockback = trace.knockback >= 20;
          const impulse = (heavyKnockback ? 1.18 : 1) * trace.knockback * (hit.headshot ? 1.08 : 1);
          hit.player.knockbackVelocity.x += trace.direction.x * impulse;
          hit.player.knockbackVelocity.y += impulse * (heavyKnockback ? 0.62 : 0.4);
          hit.player.knockbackVelocity.z += trace.direction.z * impulse;
        }
      } else if (useSeaRock && seaRockHit) {
        tracerDistance = seaRockHit.distance;
        showImpact = true;
      } else if (occluded) {
        tracerDistance = occlusionDistance;
        showImpact = true;
      } else {
        const waterImpactDistance = this.getWaterImpactDistance(trace.origin, trace.direction, trace.range);
        if (waterImpactDistance !== null) {
          tracerDistance = waterImpactDistance;
          showImpact = true;
        }
      }

      this.spawnHitscanTracer(shooter, trace, tracerDistance, showImpact);
    }

    for (const feedback of hitFeedback.values()) {
      this.awardPlayerHitGold(shooter.id, feedback.damage);
      this.notifyPlayerHit(shooter.id, feedback);
      this.notifyIncomingPlayerHit(feedback.targetId, {
        attackerId: shooter.id,
        attackerName: shooter.name,
        damage: feedback.damage,
        position: feedback.position,
        sourcePosition: {
          x: shooter.position.x,
          y: shooter.position.y + PLAYER.HEIGHT * 0.72,
          z: shooter.position.z,
        },
        headshot: feedback.headshot,
        kill: feedback.kill,
        remainingHealth: feedback.remainingHealth,
        weaponId: feedback.weaponId,
      });
    }
    for (const feedback of sharkHitFeedback.values()) {
      // One entry per shark per volley, and dead sharks can't be re-hit
      // (findClosestSharkHit skips health<=0) — so this counts each kill once.
      if (feedback.kill) this.statsDelta(shooter.id).sharksKilled += 1;
      this.notifyPlayerHit(shooter.id, feedback);
    }
    for (const feedback of wildlifeHitFeedback.values()) {
      this.notifyPlayerHit(shooter.id, feedback);
    }
  }

  /** Distance to the first solid occluder (island terrain or a ship hull) along
   *  a hitscan trace; returns trace.range when the path is clear. The shooter's
   *  own ship never occludes so deck shooters can always fire outward past
   *  their bulwark. */
  private getFirearmOcclusionDistance(shooter: Player, trace: HitscanTrace): number {
    let occlusion = trace.range;
    const terrainHit = raymarchIslandSurface(trace.origin, trace.direction, occlusion, this.state.islands);
    if (terrainHit.hit) occlusion = Math.min(occlusion, terrainHit.distance);
    for (const ship of this.state.ships) {
      if (!ship.alive) continue;
      if (ship.id === shooter.onShipId) continue;
      const hullDistance = intersectRayShipHull(trace.origin, trace.direction, occlusion, ship);
      if (hullDistance !== null) occlusion = Math.min(occlusion, hullDistance);
    }
    const structure = this.intersectRayIslandStructures(trace.origin, trace.direction, occlusion);
    if (structure !== null) occlusion = Math.min(occlusion, structure);
    return occlusion;
  }

  /** Distance to the first SOLID island structure (tavern walls, boulders, towers,
   *  the fort, story landmarks) along a ray, or null when the path is clear.
   *  Cover that reads as solid has to stop bullets — snipers used to shoot clean
   *  through a 2.6m boulder or a fort wall. Thin capsules (palms, posts, lanterns,
   *  crates) are deliberately NOT occluders: they are see-through-ish dressing and
   *  blocking on them would feel arbitrary.
   *
   *  ONE implementation, shared with the cannonball path and with the on-foot
   *  colliders (PhysicsSystem.firstStructureHit → intersectRayIslandProps over
   *  SHOT_BLOCKING_PROPS + the shared tavern shell). This used to be a private
   *  re-derivation with its own prop rule (any collider wider than a metre) and
   *  its own copy of the tavern ray test, so a cannonball and a musket ball
   *  disagreed about what counted as cover. */
  private intersectRayIslandStructures(origin: Vec3, direction: Vec3, maxDistance: number): number | null {
    return this.physics.firstStructureHit(origin, direction, maxDistance, this.state.islands);
  }

  private findClosestFirearmHit(
    shooter: Player,
    trace: HitscanTrace,
  ): { player: Player; distance: number; headshot: boolean } | null {
    let closest: { player: Player; distance: number; headshot: boolean } | null = null;

    for (const target of this.state.players) {
      if (
        target.id === shooter.id
        || target.state === 'eliminated'
        || target.state === 'respawning'
        || target.respawnProtectionTimer > 0
      ) {
        continue;
      }

      const hit = this.intersectPlayerHitboxes(trace.origin, trace.direction, trace.range, target);
      if (!hit) continue;
      if (!closest || hit.distance < closest.distance) {
        closest = { player: target, distance: hit.distance, headshot: hit.headshot };
      }
    }

    return closest;
  }

  private findClosestSharkHit(trace: HitscanTrace): { shark: Shark; distance: number } | null {
    let best: { shark: Shark; distance: number } | null = null;
    const r = SHARK.HIT_RADIUS;
    for (const shark of this.state.sharks) {
      if (shark.health <= 0) continue;
      const center = { x: shark.position.x, y: shark.position.y + 0.35, z: shark.position.z };
      const t = this.raySphereIntersection(trace.origin, trace.direction, center, r);
      if (t === null || t > trace.range) continue;
      if (!best || t < best.distance) best = { shark, distance: t };
    }
    return best;
  }

  private findClosestWildlifeHit(trace: HitscanTrace): { animal: WildlifeAnimal; distance: number } | null {
    let best: { animal: WildlifeAnimal; distance: number } | null = null;
    for (const animal of this.state.wildlife) {
      if (animal.health <= 0) continue;
      const radius = WILDLIFE.HIT_RADIUS[animal.type];
      const center = {
        x: animal.position.x,
        y: animal.position.y + (animal.type === 'gull' ? 0.1 : radius * 0.6),
        z: animal.position.z,
      };
      const t = this.raySphereIntersection(trace.origin, trace.direction, center, radius);
      if (t === null || t > trace.range) continue;
      if (!best || t < best.distance) best = { animal, distance: t };
    }
    return best;
  }

  private findClosestKegHit(trace: HitscanTrace): { keg: ShipKeg; distance: number } | null {
    let best: { keg: ShipKeg; distance: number } | null = null;
    for (const keg of this.state.kegs) {
      if (keg.timer <= 0) continue;
      this.syncKegPosition(keg);
      const center = { x: keg.position.x, y: keg.position.y + 0.35, z: keg.position.z };
      const distance = this.raySphereIntersection(trace.origin, trace.direction, center, 0.48);
      if (distance === null || distance > trace.range) continue;
      if (!best || distance < best.distance) best = { keg, distance };
    }
    return best;
  }

  private findClosestSeaRockHit(trace: HitscanTrace): { rock: SeaRock; distance: number } | null {
    let best: { rock: SeaRock; distance: number } | null = null;
    for (const rock of this.state.seaRocks) {
      const distance = intersectRaySeaRock(trace.origin, trace.direction, trace.range, rock, 0.035);
      if (distance === null) continue;
      if (!best || distance < best.distance) best = { rock, distance };
    }
    return best;
  }

  private intersectPlayerHitboxes(
    origin: Vec3,
    direction: Vec3,
    range: number,
    target: Player,
  ): { distance: number; headshot: boolean } | null {
    const swimming = target.state === 'swimming';
    const islandSkeleton = !!target.isBot && target.shipId === null;
    let headCenter: Vec3;
    let upperBodyCenter: Vec3;
    let lowerBodyCenter: Vec3;
    let headRadius: number;
    let upperRadius: number;
    let lowerRadius: number;

    if (swimming) {
      // The swim visual lays the body horizontal along the player's facing yaw,
      // not stacked vertically. Hitboxes must match that pose or shooters miss
      // anyone in the water entirely.
      const yaw = target.rotation.x;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const surfaceLift = 0.42; // body floats roughly half a metre above feet position
      headCenter = {
        x: target.position.x + fx * 0.62,
        y: target.position.y + surfaceLift + 0.18,
        z: target.position.z + fz * 0.62,
      };
      upperBodyCenter = {
        x: target.position.x + fx * 0.12,
        y: target.position.y + surfaceLift,
        z: target.position.z + fz * 0.12,
      };
      lowerBodyCenter = {
        x: target.position.x - fx * 0.45,
        y: target.position.y + surfaceLift - 0.08,
        z: target.position.z - fz * 0.45,
      };
      headRadius = 0.34;
      upperRadius = 0.6;
      lowerRadius = 0.5;
    } else {
      const headY = islandSkeleton ? 1.92 : target.crouching ? PLAYER.HEIGHT * 0.66 : PLAYER.HEIGHT * 0.96;
      const upperY = islandSkeleton ? 1.24 : PLAYER.HEIGHT * 0.58;
      const lowerY = islandSkeleton ? 0.62 : PLAYER.HEIGHT * 0.28;
      headCenter = { x: target.position.x, y: target.position.y + headY, z: target.position.z };
      upperBodyCenter = { x: target.position.x, y: target.position.y + upperY, z: target.position.z };
      lowerBodyCenter = { x: target.position.x, y: target.position.y + lowerY, z: target.position.z };
      headRadius = islandSkeleton ? 0.28 : 0.25;
      upperRadius = islandSkeleton ? 0.42 : 0.5;
      lowerRadius = islandSkeleton ? 0.34 : 0.38;
    }

    const hitboxes = [
      { center: headCenter, radius: headRadius, headshot: true },
      { center: upperBodyCenter, radius: upperRadius, headshot: false },
      { center: lowerBodyCenter, radius: lowerRadius, headshot: false },
    ];

    let closest: { distance: number; headshot: boolean } | null = null;
    for (const hitbox of hitboxes) {
      const distance = this.raySphereIntersection(origin, direction, hitbox.center, hitbox.radius);
      if (distance === null || distance > range) continue;
      if (!closest || distance < closest.distance || (Math.abs(distance - closest.distance) < 0.001 && hitbox.headshot)) {
        closest = { distance, headshot: hitbox.headshot };
      }
    }

    return closest;
  }

  private raySphereIntersection(origin: Vec3, direction: Vec3, center: Vec3, radius: number) {
    const ox = origin.x - center.x;
    const oy = origin.y - center.y;
    const oz = origin.z - center.z;
    const b = ox * direction.x + oy * direction.y + oz * direction.z;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const sqrtDisc = Math.sqrt(discriminant);
    const near = -b - sqrtDisc;
    const far = -b + sqrtDisc;
    if (near >= 0) return near;
    if (far >= 0) return far;
    return null;
  }

  private spawnHitscanTracer(shooter: Player, trace: HitscanTrace, distance: number, showImpact: boolean) {
    const clampedDistance = Math.max(0.45, Math.min(trace.range, distance));
    const maxAge = Math.max(0.08, Math.min(0.14, clampedDistance / 260));
    // The tracer starts at the MUZZLE but flies toward the true hit point on
    // the eye ray, so the visual agrees with where the shot actually landed.
    const start = trace.visualOrigin ?? trace.origin;
    const hitPoint = {
      x: trace.origin.x + trace.direction.x * clampedDistance,
      y: trace.origin.y + trace.direction.y * clampedDistance,
      z: trace.origin.z + trace.direction.z * clampedDistance,
    };
    const toHit = {
      x: hitPoint.x - start.x,
      y: hitPoint.y - start.y,
      z: hitPoint.z - start.z,
    };
    const visualDistance = Math.max(0.3, Math.hypot(toHit.x, toHit.y, toHit.z));
    const speed = visualDistance / maxAge;
    const projectile: Projectile = {
      id: uuid(),
      type: 'bullet',
      ownerId: shooter.id,
      ownerShipId: shooter.shipId,
      position: { ...start },
      velocity: {
        x: (toHit.x / visualDistance) * speed,
        y: (toHit.y / visualDistance) * speed,
        z: (toHit.z / visualDistance) * speed,
      },
      alive: true,
      age: 0,
      maxAge,
      damage: 0,
      knockback: 0,
      visualOnly: true,
      showImpact,
      weaponId: trace.weaponId,
    };
    this.weapons.queueProjectile(projectile);
  }

  /** March the hitscan ray against the real Gerstner surface (waves swing ±~1m)
   *  so splash effects land on the visible water, not the flat y=0 plane. */
  private getWaterImpactDistance(origin: Vec3, direction: Vec3, maxDistance: number) {
    // Above any possible crest a non-descending ray can never land.
    // (Bound covers full storm seas: base ±~2.6m + storm swell ±~2.6m.)
    const crestBound = 6.4;
    if (direction.y >= -0.0001 && origin.y > crestBound) return null;
    const originSea = stormSeaState(this.state.storm, origin.x, origin.z);
    if (origin.y <= gerstnerHeight(origin.x, origin.z, this.t, WAVE_PARAMS, originSea)) return null;

    const range = Math.min(maxDistance, 600); // splash is cosmetic — cap the march
    const step = 3;
    const waveYAt = (dist: number) => {
      const x = origin.x + direction.x * dist;
      const z = origin.z + direction.z * dist;
      return gerstnerHeight(x, z, this.t, WAVE_PARAMS, stormSeaState(this.state.storm, x, z));
    };
    let prev = 0;
    for (let d = step; ; d += step) {
      const dist = Math.min(d, range);
      if (origin.y + direction.y * dist <= waveYAt(dist)) {
        let lo = prev;
        let hi = dist;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) * 0.5;
          if (origin.y + direction.y * mid <= waveYAt(mid)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = dist;
      if (dist >= range) return null;
    }
  }

  private getFirearmAimRay(player: Player, ship: Ship | null, input: PlayerInput, weaponId: WeaponId): { eye: Vec3; point: Vec3 } {
    const swimming = player.state === 'swimming';
    const aimingFirearm = !WEAPONS[weaponId].melee && (input.aim || input.fire);
    const scoped = input.aim && !!WEAPONS[weaponId].scopeFov;
    const yaw = player.atHelm && ship ? ship.rotation : input.yaw;
    const pitch = input.pitch;
    const forward = this.normalizeVec3({
      x: Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch),
    });
    const cameraPos = {
      x: player.position.x,
      y: player.position.y + (swimming ? PLAYER.HEIGHT * 0.56 : player.crouching ? PLAYER.HEIGHT * 0.55 : PLAYER.HEIGHT * 0.84),
      z: player.position.z,
    };
    const lookTarget = {
      x: cameraPos.x + forward.x * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14),
      y: cameraPos.y + forward.y * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14) + (swimming ? -0.04 : scoped ? 0.05 : 0),
      z: cameraPos.z + forward.z * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14),
    };
    const rayDir = this.normalizeVec3({
      x: lookTarget.x - cameraPos.x,
      y: lookTarget.y - cameraPos.y,
      z: lookTarget.z - cameraPos.z,
    });

    return {
      eye: cameraPos,
      point: {
        x: cameraPos.x + rayDir.x * WEAPONS[weaponId].range,
        y: cameraPos.y + rayDir.y * WEAPONS[weaponId].range,
        z: cameraPos.z + rayDir.z * WEAPONS[weaponId].range,
      },
    };
  }

  private getHeadshotMultiplier(weaponId: WeaponId) {
    switch (weaponId) {
      case 'eye_of_reach':
        return 1.65;
      case 'flintlock':
        return 1.45;
      case 'flintknock':
      case 'pistol':
        return 1.35;
      case 'blunderbuss':
        return 1.18;
      default:
        return 1;
    }
  }

  private normalizeVec3(vector: Vec3) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
      x: vector.x / length,
      y: vector.y / length,
      z: vector.z / length,
    };
  }

  /** Swim-up ladder at the dock's SEAWARD end. Dock-local space is the canonical
   *  three.js frame (world = center + Ry(θ)·local, +local-z seaward) — the same
   *  frame as the client dock mesh, PhysicsSystem.toDockLocal and
   *  dockLocalToWorld. The old mirrored frame put the prompt (and the climb
   *  target) up to 37m off the dock, dumping climbers straight back into the sea. */
  private tryClimbIslandDockFromWater(player: Player): boolean {
    if (player.state !== 'swimming') return false;
    for (const island of this.state.islands) {
      if (!island.dock) continue;
      const dock = island.dock;
      const dx = player.position.x - dock.position.x;
      const dz = player.position.z - dock.position.z;
      const cos = Math.cos(dock.rotation);
      const sin = Math.sin(dock.rotation);
      const localX = dx * cos - dz * sin;
      const localZ = dx * sin + dz * cos;
      if (Math.abs(localX) > dock.width * 0.42 + PLAYER.RADIUS) continue;
      if (localZ < dock.length * 0.08 || localZ > dock.length * 0.58) continue;
      const ladderZ = dock.length * DOCK_LADDER_LOCAL_Z_FRAC;
      if (Math.hypot(localX, localZ - ladderZ) > DOCK_CLIMB_REACH) continue;
      // Land ON the walkable deck: the deck spans |localZ| ≤ length/2, so the
      // climb-out sits just inboard of the ladder, never past the seaward tip.
      const top = dockLocalToWorld(dock, 0, 0.52, Math.min(ladderZ, dock.length * 0.5 - 0.6));
      player.position.x = top.x;
      player.position.z = top.z;
      player.position.y = dock.position.y + 0.52;
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
      player.state = 'alive';
      return true;
    }
    return false;
  }

  private returnPlayerByMermaid(player: Player): boolean {
    const homeShip = findMermaidReturnShip(this.state.ships, player);
    if (!homeShip) return false;
    this.dropCarriedChest(player);
    const deckPosition = this.getRespawnDeckPosition(homeShip);
    player.position = deckPosition;
    player.velocity = { x: 0, y: 0, z: 0 };
    player.knockbackVelocity = { x: 0, y: 0, z: 0 };
    player.onShipId = homeShip.id;
    player.state = 'alive';
    player.swimTimer = 0;
    player.shipBoundaryGraceTimer = 0;
    player.cannonFlightTimer = 0;
    player.cannonBallistic = false;
    player.respawnProtectionTimer = Math.max(player.respawnProtectionTimer, 1.5);
    player.nearShipId = null;
    player.nearChestId = null;
    this.clearStationFlags(player);
    this.broadcast({ type: 'player_spawned', ts: Date.now(), payload: { playerId: player.id, shipId: homeShip.id, mermaid: true } });
    return true;
  }

  /**
   * The hull this pirate may climb right now, or null. `reach` is the ladder
   * band; her OWN hull also answers anywhere along it (bow, stern, far rail) so
   * a swimmer can't circle her ship forever hunting for rungs — and, ON FOOT,
   * so a pirate pressed against her own planking on the sand is granted the
   * climb the HUD offered her (isBoardingOwnHull is the shared predicate the
   * client prompt reads, so the offer and the grant stay one number).
   *
   * Deliberately NOT gated on player.nearShipId: that flag is recomputed every
   * physics tick, and a press landing on the wrong tick is what made boarding
   * feel broken. The geometry is re-checked here, which is the real authority.
   */
  private findBoardableShip(player: Player, reach: number): Ship | null {
    if (player.state !== 'swimming' && player.onShipId !== null) return null;
    if (player.state !== 'swimming' && player.state !== 'alive') return null;
    const ownShip = this.getAliveShip(player.shipId);
    if (ownShip && !ownShip.sinking && isBoardingOwnHull(player, ownShip)) return ownShip;
    let best: { ship: Ship; distance: number } | null = null;
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      if (ship.id === player.onShipId) continue;
      const ladder = getNearestShipBoardingLadder(ship, player.position);
      if (!ladder || ladder.distance > reach) continue;
      if (!best || ladder.distance < best.distance) best = { ship, distance: ladder.distance };
    }
    return best?.ship ?? null;
  }

  private tryBoardFromLadder(player: Player, reach: number = SHIP_BOARD_LADDER_REACH): boolean {
    const targetShip = this.findBoardableShip(player, reach);
    if (!targetShip) return false;
    const ladder = getNearestShipBoardingLadder(targetShip, player.position);
    if (!ladder) return false;
    const stats = SHIP_STATS[targetShip.type];
    player.onShipId = targetShip.id;
    const boardPoint = this.toShipWorld(
      Math.sign(ladder.localX) * stats.width * 0.34,
      ladder.localZ + 0.18,
      targetShip,
    );
    player.position.x = boardPoint.x;
    player.position.z = boardPoint.z;
    player.position.y = targetShip.position.y + stats.height + 0.45;
    player.velocity.y = 0;
    player.state = 'alive';
    this.clearStationFlags(player);
    player.shipBoundaryGraceTimer = 0;
    player.cannonFlightTimer = 0;
    player.cannonBallistic = false;
    if (!targetShip.crewIds.includes(player.id)) targetShip.crewIds.push(player.id);
    this.boardLatchUntil.delete(player.id);
    this.deckAutoBoardTimer.delete(player.id);
    return true;
  }

  /**
   * [X] at a ladder = "I am climbing". If the instant grant fails, QUEUE it:
   * for BOARD_LATCH_TIME the server keeps trying with a slightly wider ladder
   * reach, so a press that lands between two physics ticks (or half a metre off
   * the rungs on a swell) still puts her aboard instead of vanishing.
   * Returns true when the climb happened this very press.
   */
  private requestBoard(player: Player): boolean {
    if (this.tryBoardFromLadder(player)) return true;
    // Only queue it if a climb is plausible from here — otherwise the latch
    // would silently board her the moment she drifted past any hull.
    if (this.findBoardableShip(player, SHIP_BOARD_LATCH_REACH)) {
      this.boardLatchUntil.set(player.id, this.t + BOARD_LATCH_TIME);
    }
    return false;
  }

  /** Runs every tick per player: retries a queued climb, and auto-boards a
   *  pirate whose feet are already on her own deck (the dock gangway walk-on,
   *  which used to leave her logically ashore with a Climb Ladder prompt). */
  private updateBoardingLatch(player: Player, dt: number) {
    const latchUntil = this.boardLatchUntil.get(player.id);
    if (latchUntil !== undefined) {
      if (player.onShipId !== null && player.state !== 'swimming') {
        this.boardLatchUntil.delete(player.id);
      } else if (this.t > latchUntil) {
        // The queued climb ran out of rope. Say so — a latch that quietly expires
        // is exactly the silent [X] this whole path exists to kill.
        this.boardLatchUntil.delete(player.id);
        const latchClient = this.clients.get(player.id);
        if (latchClient) this.sendInteractRefused(latchClient, 'board', 'no_ladder');
      } else if (this.tryBoardFromLadder(player, SHIP_BOARD_LATCH_REACH)) {
        return;
      }
    }

    // ── Gangway walk-on: standing on your own planking IS being aboard ──
    if (player.onShipId !== null || player.state !== 'alive') {
      this.deckAutoBoardTimer.delete(player.id);
      return;
    }
    const ownShip = this.getAliveShip(player.shipId);
    if (!ownShip || ownShip.sinking || !isStandingOnShipDeck(player, ownShip)) {
      this.deckAutoBoardTimer.delete(player.id);
      return;
    }
    const held = (this.deckAutoBoardTimer.get(player.id) ?? 0) + dt;
    if (held < DECK_AUTO_BOARD_TIME) {
      this.deckAutoBoardTimer.set(player.id, held);
      return;
    }
    this.deckAutoBoardTimer.delete(player.id);
    this.boardLatchUntil.delete(player.id);
    player.onShipId = ownShip.id;
    player.state = 'alive';
    player.shipBoundaryGraceTimer = 0;
    if (!ownShip.crewIds.includes(player.id)) ownShip.crewIds.push(player.id);
  }

  /** Why the last refused [X] was refused — set by refuse(), read by the caller
   *  when it sends the nudge back. Single-threaded tick, single call site. */
  private lastRefusalReason: InteractRefusalReason = 'unavailable';

  /** Refuse an interaction WITH a reason. Always returns false, so it drops
   *  straight into the existing `return false` shape of every branch. */
  private refuse(reason: InteractRefusalReason): false {
    this.lastRefusalReason = reason;
    return false;
  }

  /** Answer a dead [X] — one short nudge per press storm, to the presser only. */
  private sendInteractRefused(
    client: ConnectedClient,
    intent: InteractIntent,
    reason: InteractRefusalReason = this.lastRefusalReason,
  ) {
    if (this.t - client.lastRefusalAt < INTERACT_REFUSAL_INTERVAL) return;
    client.lastRefusalAt = this.t;
    this.send(client.ws, {
      type: 'interact_refused',
      ts: Date.now(),
      payload: { intent, reason } satisfies InteractRefusedPayload,
    });
  }

  /** Resolves [X] to the action the client HUD selected; each branch validates range / state. */
  private tryInteractIntent(player: Player, input: PlayerInput, ship: Ship | null): boolean {
    const intent = input.interactIntent;
    if (!intent) return false;
    this.lastRefusalReason = 'unavailable';

    switch (intent) {
      case 'barrel': {
        if (!player.nearBarrelId) return this.refuse('nothing_there');
        const barrelEvent = this.islands.tryOpenBarrel(player, this.state.islands, this.state.ships);
        if (barrelEvent) {
          this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
          return true;
        }
        return this.refuse('out_of_reach');
      }
      case 'chest': {
        const event = this.tryTakeChest(player);
        if (event) {
          this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
          return true;
        }
        return this.refuse('nothing_there');
      }
      case 'stow_chest': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        return this.tryStowCarriedChest(player, ship) || this.refuse('out_of_reach');
      }
      case 'gold_hoarder':
        return this.handleGoldHoarderInteraction(player) || this.refuse('out_of_reach');
      case 'board': {
        // A failed board is not a refusal YET — requestBoard latches the press
        // and keeps trying; the nudge comes from the latch expiring unboarded.
        if (this.requestBoard(player)) return true;
        if (this.boardLatchUntil.has(player.id)) return true;
        return this.refuse('no_ladder');
      }
      case 'dock':
        return this.tryClimbIslandDockFromWater(player) || this.refuse('out_of_reach');
      case 'mermaid':
        return this.returnPlayerByMermaid(player) || this.refuse('unavailable');
      case 'keg_diffuse': {
        const keg = this.getNearbyKeg(player, ship ?? null);
        if (!keg) return this.refuse('nothing_there');
        this.diffuseKeg(keg);
        return true;
      }
      case 'upgrade': {
        const homeShip = this.getAliveShip(player.shipId);
        const upgradeStation = findNearbyUpgradeStation(this.state.islands, player);
        if (
          !upgradeStation
          || !homeShip
          || upgradeStation.claimedByShipId === homeShip.id
          || homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)
        ) {
          return this.refuse('out_of_reach');
        }
        // Claims cost materials (pocket + ship stores). A short press simply
        // fails — the client HUD already shows the recipe.
        const cost = UPGRADE_COSTS[upgradeStation.type];
        if (
          this.getMaterialCount(player, homeShip, 'wood') < cost.wood
          || this.getMaterialCount(player, homeShip, 'ore') < cost.ore
        ) {
          return this.refuse('materials');
        }
        this.consumeMaterial(player, homeShip, 'wood', cost.wood);
        this.consumeMaterial(player, homeShip, 'ore', cost.ore);
        upgradeStation.claimedByShipId = homeShip.id;
        this.applyShipUpgrade(homeShip, upgradeStation.type);
        this.broadcast({
          type: 'ship_upgraded',
          ts: Date.now(),
          payload: { shipId: homeShip.id, type: upgradeStation.type, costWood: cost.wood, costOre: cost.ore },
        });
        return true;
      }
      case 'repair': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        const repairHole = this.getRepairableHole(player, ship);
        if (!repairHole) return this.refuse('nothing_there');
        if (!this.consumeRepairPlank(player, ship)) return this.refuse('no_plank');
        this.physics.patchHole(ship, repairHole.id);
        if (ship.onFire) {
          ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
          if (ship.fireTimer <= 0) { ship.onFire = false; ship.fireTimer = 0; ship.fireDamageAccum = 0; }
        }
        return true;
      }
      case 'bail': {
        // The press just confirms intent; the continuous drain runs in the
        // held-interact block (applyInput). Consume it so [X] doesn't fall through.
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        return (ship.waterLevel ?? 0) > 0 || this.refuse('nothing_there');
      }
      case 'anchor': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        if (!this.isNearAnchor(player, ship)) return this.refuse('out_of_reach');
        if (!ship.anchored) {
          ship.anchored = true;
          ship.anchorRaiseProgress = 0;
        }
        this.clearStationFlags(player);
        return true;
      }
      case 'crow': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        if (!this.isNearCrowNestLadder(player, ship)) return this.refuse('out_of_reach');
        // Ladder is single-file and closed on a sinking hull.
        return this.startMastClimb(player, ship)
          || this.refuse(ship.sinking ? 'sinking' : 'occupied');
      }
      case 'sails': {
        // No captive sail mode: the press confirms intent, the continuous
        // hold in applyInput hauls the halyard (Sea-of-Thieves style).
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        return this.isNearSailStation(player, ship) || this.refuse('out_of_reach');
      }
      case 'brace': {
        // Same pattern as the halyard: press confirms, the hold in applyInput
        // sweeps the yard toward the station's side.
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        return findBraceStationDir(player, ship) !== 0 || this.refuse('out_of_reach');
      }
      case 'revive': {
        // The press just confirms intent; the continuous revive runs off the
        // held-interact block in applyInput. Consume so [X] doesn't fall through.
        return this.findReviveTarget(player) !== null || this.refuse('nothing_there');
      }
      case 'helm': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        if (!this.isNearHelm(player, ship)) return this.refuse('out_of_reach');
        return this.enterHelm(player, ship)
          || this.refuse(ship.sinking ? 'sinking' : 'occupied');
      }
      case 'cannon': {
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        const nearbyCannon = this.getNearbyCannonIndex(player, ship);
        if (nearbyCannon === null) return this.refuse('out_of_reach');
        return this.enterCannon(player, ship, nearbyCannon, input.yaw, input.pitch)
          || this.refuse(ship.sinking ? 'sinking' : 'occupied');
      }
      case 'ammo': {
        // Sea-of-Thieves ammo chest: [X] at the crate tops up every firearm.
        if (!ship || player.onShipId !== ship.id) return this.refuse('not_aboard');
        if (!isSharedNearAmmoCrate(player, ship)) return this.refuse('out_of_reach');
        let refilled = false;
        for (const weapon of player.weapons) {
          if (!weapon || WEAPONS[weapon.weaponId].melee) continue;
          const def = WEAPONS[weapon.weaponId];
          if (weapon.ammo < def.ammoMax || weapon.reserve < def.reserveMax || weapon.reloading) refilled = true;
          weapon.ammo = def.ammoMax;
          weapon.reserve = def.reserveMax;
          weapon.reloading = false;
          weapon.reloadTimer = 0;
        }
        if (refilled) {
          const client = this.clients.get(player.id);
          if (client) {
            this.send(client.ws, { type: 'ammo_refilled', ts: Date.now(), payload: {} });
          }
        }
        return refilled || this.refuse('nothing_there');
      }
      default:
        return this.refuse('unavailable');
    }
  }

  private updateSharks(dt: number) {
    const { sharks, players, islands } = this.state;
    this.sharkSpawnCooldown = Math.max(0, this.sharkSpawnCooldown - dt);

    if (sharks.length < SHARK.MAX_WORLD && this.sharkSpawnCooldown <= 0 && this.rng() < SHARK.SPAWN_CHANCE_PER_TICK) {
      const swimmers = players.filter(p => p.state === 'swimming' && p.swimTimer >= SHARK.SPAWN_SWIM_GRACE);
      if (swimmers.length) {
        const p = swimmers[Math.floor(this.rng() * swimmers.length)];
        const ang = this.rng() * Math.PI * 2;
        const dist = randRange(SHARK.SPAWN_MIN_DIST, SHARK.SPAWN_MAX_DIST, this.rng);
        const x = p.position.x + Math.sin(ang) * dist;
        const z = p.position.z + Math.cos(ang) * dist;
        if (Math.abs(x) < WORLD.HALF - 24 && Math.abs(z) < WORLD.HALF - 24) {
          let blocked = false;
          for (const island of islands) {
            if (isPointInsideIslandFootprint(island, x, z, 2.8)) {
              blocked = true;
              break;
            }
          }
          for (const shark of sharks) {
            if (dist2D(shark.position.x, shark.position.z, x, z) < SHARK.SPAWN_MIN_DIST) {
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            sharks.push({
              id: uuid(),
              position: { x, y: 0.38, z },
              rotation: 0,
              velocity: { x: 0, y: 0, z: 0 },
              health: SHARK.HEALTH,
              biteCooldown: 1.2,
              attackState: 'cruise',
              attackTimer: 0,
              lungeDirX: 0,
              lungeDirZ: 0,
              targetId: p.id,
            });
            this.sharkSpawnCooldown = randRange(SHARK.SPAWN_COOLDOWN_MIN, SHARK.SPAWN_COOLDOWN_MAX, this.rng);
          }
        }
      }
    }

    for (let i = sharks.length - 1; i >= 0; i--) {
      const s = sharks[i];
      if (s.health <= 0) {
        sharks.splice(i, 1);
        continue;
      }
      s.biteCooldown = Math.max(0, s.biteCooldown - dt);

      let target = this.getPlayer(s.targetId);
      if (target?.state !== 'swimming') target = null;
      if (!target) {
        const candidates = players.filter(pl => pl.state === 'swimming');
        target = candidates
          .map(pl => ({
            pl,
            d: dist2D(pl.position.x, pl.position.z, s.position.x, s.position.z),
          }))
          .sort((a, b) => a.d - b.d)[0]?.pl ?? null;
        s.targetId = target?.id ?? null;
      }

      if (!target && s.attackState === 'cruise') {
        // Frame-rate-independent decay preserving the previous per-16ms feel.
        const idleDamp = Math.pow(0.92, dt / 0.016);
        s.velocity.x *= idleDamp;
        s.velocity.z *= idleDamp;
        s.position.x += s.velocity.x * dt;
        s.position.z += s.velocity.z * dt;
        continue;
      }

      // ── Telegraphed attack state machine ──────────────────────────────────
      // cruise → (in range, off cooldown) windup: hard brake, aim LOCKED at the
      // target's position at windup start → lunge: dash along the locked vector,
      // biting anything (the target) inside LUNGE_HIT_RADIUS → recover: drift,
      // harmless. A swimmer strafing perpendicular during the windup leaves the
      // lunge corridor — the bite is dodgeable, unlike the old proximity check.
      // A target lost mid-attack (boarded, died) still plays the phase out.
      const dx = target ? target.position.x - s.position.x : 0;
      const dz = target ? target.position.z - s.position.z : 0;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      switch (s.attackState) {
        case 'cruise': {
          s.rotation = Math.atan2(dx, dz);
          s.velocity.x = (dx / d) * SHARK.CHASE_SPEED;
          s.velocity.z = (dz / d) * SHARK.CHASE_SPEED;
          break;
        }
        case 'windup': {
          const brake = Math.pow(0.85, dt / 0.016);
          s.velocity.x *= brake;
          s.velocity.z *= brake;
          s.attackTimer -= dt;
          if (s.attackTimer <= 0) {
            s.attackState = 'lunge';
            s.attackTimer = SHARK.LUNGE_TIME;
          }
          break;
        }
        case 'lunge': {
          s.velocity.x = s.lungeDirX * SHARK.LUNGE_SPEED;
          s.velocity.z = s.lungeDirZ * SHARK.LUNGE_SPEED;
          s.attackTimer -= dt;
          break;
        }
        case 'recover': {
          const drift = Math.pow(0.9, dt / 0.016);
          s.velocity.x *= drift;
          s.velocity.z *= drift;
          s.attackTimer -= dt;
          if (s.attackTimer <= 0) s.attackState = 'cruise';
          break;
        }
      }
      s.position.x += s.velocity.x * dt;
      s.position.z += s.velocity.z * dt;
      s.position.y = 0.38;

      // Sharks stay in OPEN WATER — shove them back out of any island footprint
      // so they never chase under the terrain (where they'd be invisible and bite
      // the swimmer from inside the rock = "random" damage).
      let inLand = false;
      for (const island of islands) {
        if (!isPointInsideIslandFootprint(island, s.position.x, s.position.z, 4)) continue;
        const ax = s.position.x - island.position.x;
        const az = s.position.z - island.position.z;
        const al = Math.hypot(ax, az) || 1;
        let px = s.position.x, pz = s.position.z;
        for (let step = 0; step < 40 && isPointInsideIslandFootprint(island, px, pz, 4); step++) {
          px += (ax / al) * 1.5; pz += (az / al) * 1.5;
        }
        s.position.x = px; s.position.z = pz;
        s.velocity.x *= 0.25; s.velocity.z *= 0.25;
        inLand = true;
      }

      // Only wind up from open water (not from inside the shore rock) — the
      // 1.9× bite range gives the windup brake room before the lunge fires.
      if (
        s.attackState === 'cruise'
        && target
        && !inLand
        && d < SHARK.BITE_RANGE * 1.9
        && s.biteCooldown <= 0
      ) {
        s.attackState = 'windup';
        s.attackTimer = SHARK.WINDUP_TIME;
        s.lungeDirX = dx / d;
        s.lungeDirZ = dz / d;
        s.rotation = Math.atan2(s.lungeDirX, s.lungeDirZ);
      }

      // The lunge only connects while dashing: CURRENT distance to the target,
      // one bite max, then straight into the vulnerable recover drift.
      if (s.attackState === 'lunge') {
        if (target && dist2D(target.position.x, target.position.z, s.position.x, s.position.z) < SHARK.LUNGE_HIT_RADIUS) {
          this.noteDamageSource(target.id, 'shark');
          const bite = this.absorbWithArmor(target, SHARK.BITE_DAMAGE);
          target.health -= bite;
          // A shark bite took a fifth of your health and put NOTHING on screen —
          // no number, no name, no bearing. It is the one environmental source
          // with real jaws, so the wedge points at them.
          this.noteEnvironmentalDamage(target, 'shark', bite, {
            x: s.position.x, y: s.position.y + 0.4, z: s.position.z,
          });
          target.lastDamagedById = null;
          target.lastDamagedAt = null;
          target.lastDamageWasHeadshot = false;
          s.biteCooldown = SHARK.BITE_COOLDOWN;
          s.attackState = 'recover';
          s.attackTimer = SHARK.RECOVER_TIME;
        } else if (s.attackTimer <= 0) {
          s.attackState = 'recover';
          s.attackTimer = SHARK.RECOVER_TIME;
        }
      }
    }
  }

  private updateWildlife(dt: number) {
    for (const animal of this.state.wildlife) {
      if (animal.health <= 0) continue;
      const island = this.state.islands.find((candidate) => candidate.id === animal.islandId);
      if (!island) {
        animal.health = 0;
        continue;
      }

      animal.wanderTimer -= dt;
      if (animal.wanderTimer <= 0) {
        const homeAngle = Math.atan2(animal.spawnPosition.z - animal.position.z, animal.spawnPosition.x - animal.position.x);
        const farFromHome = dist2D(animal.position.x, animal.position.z, animal.spawnPosition.x, animal.spawnPosition.z) > island.radius * 0.32;
        animal.wanderAngle = farFromHome
          ? homeAngle + randRange(-0.55, 0.55, this.rng)
          : animal.wanderAngle + randRange(-1.35, 1.35, this.rng);
        animal.wanderTimer = randRange(0.7, animal.type === 'gull' ? 2.0 : 3.0, this.rng);
      }

      const speed = WILDLIFE.SPEED[animal.type];
      const moveScale = animal.type === 'crab' ? (0.55 + Math.abs(Math.sin(this.t * 3.5 + animal.position.x)) * 0.55) : 1;
      const vx = Math.cos(animal.wanderAngle) * speed * moveScale;
      const vz = Math.sin(animal.wanderAngle) * speed * moveScale;
      const nextX = animal.position.x + vx * dt;
      const nextZ = animal.position.z + vz * dt;
      const allowed = isPointInsideIslandFootprint(island, nextX, nextZ, animal.type === 'gull' ? -4 : -2);

      if (allowed) {
        animal.position.x = nextX;
        animal.position.z = nextZ;
        animal.velocity.x = vx;
        animal.velocity.z = vz;
      } else {
        animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        animal.velocity.x = 0;
        animal.velocity.z = 0;
      }

      const groundY = getIslandSurfaceY(island, animal.position.x, animal.position.z);
      animal.position.y = animal.type === 'gull'
        ? groundY + 1.8 + Math.sin(this.t * 3.2 + animal.position.x * 0.04) * 0.35
        : groundY + 0.06;

      if (Math.abs(animal.velocity.x) + Math.abs(animal.velocity.z) > 0.01) {
        animal.rotation = Math.atan2(animal.velocity.x, animal.velocity.z);
      }
    }

    this.state.wildlife = this.state.wildlife.filter((animal) => animal.health > 0);
  }

  private startShipSinking(ship: Ship, rapid = false, sunkByPlayerId: string | null = null) {
    if (!ship.alive || ship.sinking) return;

    this.dropShipTreasure(ship);
    // Her winnings break out of the hold and go into the shallows before she
    // does — the wreck mark is a dive site, not just a hole in the sea.
    this.spillCargoOnFounder(ship);
    ship.sinking = true;
    ship.anchored = true;
    ship.anchorRaiseProgress = 0;
    ship.sailHeight = 0;
    ship.sailAngle = 0;
    ship.onFire = false;
    ship.fireTimer = 0;
    ship.fireDamageAccum = 0;
    ship.chainshottedUntil = 0;
    ship.sailIntegrity = Math.min(ship.sailIntegrity, 0.12);
    ship.velocity.x *= 0.3;
    ship.velocity.y = 0;
    ship.velocity.z *= 0.3;
    ship.angularVelocity *= 0.35;
    ship.sinkProgress = Math.max(ship.sinkProgress, rapid ? 0.22 : 0);
    // A foundering ship is riddled — spring waterline planks all round her
    // until at least eight breaches gape, so she visibly reads as a wreck.
    this.riddleWreck(ship);

    // Sinking a crew's ship does NOT eliminate them — they splash out and keep
    // fighting; they just have no home ship left to respawn on. The sinker
    // still earns credit for the play.
    const sinkKiller = sunkByPlayerId ? this.getPlayer(sunkByPlayerId) : null;
    if (sinkKiller && sinkKiller.state !== 'eliminated' && sinkKiller.shipId !== ship.id) {
      this.creditShipSink(ship, sinkKiller);
    }

    for (const player of this.state.players) {
      if (player.onShipId !== ship.id || player.state === 'eliminated' || player.state === 'respawning' || player.health <= 0) {
        continue;
      }
      player.onShipId = null;
      // Downed crew splash out with everyone else but STAY downed (bleeding
      // out in the water) — only Match's DBNO pass may change that state.
      if (player.state !== 'downed') player.state = 'swimming';
      this.dropCarriedChest(player);
      this.clearStationFlags(player);
      player.nearShipId = null;
      player.nearChestId = null;
      player.swimTimer = 0;
      player.shipBoundaryGraceTimer = 0;
      player.cannonFlightTimer = 0;
      player.cannonBallistic = false;
      player.velocity.y = Math.max(player.velocity.y, rapid ? 4 : 3);
      player.knockbackVelocity = {
        x: (this.rng() - 0.5) * (rapid ? 7 : 5),
        y: rapid ? 5.5 : 4.2,
        z: (this.rng() - 0.5) * (rapid ? 7 : 5),
      };
    }

    ship.crewIds = [];
    this.state.kegs = this.state.kegs.filter((keg) => keg.shipId !== ship.id);
    this.shipLastDamagedByPlayer.delete(ship.id);
    this.announceCrewEliminated(ship, sinkKiller);
  }

  /** A ship going under is what the CREWS AFLOAT counter tracks, and it used to
   *  drop silently (10 → 7 → 5 with no on-screen event). Announce it so the BR's
   *  tension meter is audible; the crew itself may still be swimming/fighting. */
  private announceCrewEliminated(ship: Ship, sunkBy: Player | null) {
    const owner = this.state.players.find((p) => p.id === ship.ownerId);
    const remaining = this.state.ships.filter((s) => s.alive && !s.sinking && s.id !== ship.id).length;
    this.broadcast({
      type: 'crew_eliminated',
      ts: Date.now(),
      payload: {
        crewId: ship.id,
        crewName: owner ? `${owner.name}'s crew` : 'A crew',
        remaining,
        byPlayerId: sunkBy?.id ?? null,
        byName: sunkBy?.name ?? null,
      },
    });
  }

  private dropShipTreasure(ship: Ship) {
    if (ship.treasureChestIds.length === 0) return;
    const chestIds = [...ship.treasureChestIds];
    const stats = SHIP_STATS[ship.type];
    chestIds.forEach((chestId, index) => {
      const found = this.getChestById(chestId);
      if (!found || found.chest.opened) return;
      const chest = found.chest;
      const angle = ship.rotation + (index / Math.max(1, chestIds.length)) * Math.PI * 2;
      const scatter = stats.width * 0.45 + 1.2 + (index % 3) * 0.8;
      chest.carriedByPlayerId = null;
      chest.storedOnShipId = null;
      chest.droppedOnShipId = null;
      chest.droppedLocalPosition = null;
      chest.floating = true;
      chest.position = {
        x: ship.position.x + Math.sin(angle) * scatter,
        y: 0.45,
        z: ship.position.z + Math.cos(angle) * scatter,
      };
    });
    ship.treasureChestIds = [];
  }

  private markShipDamagedByPlayer(shipId: string, attackerId: string | null) {
    if (!attackerId) return;
    const attacker = this.getPlayer(attackerId);
    if (!attacker || attacker.state === 'eliminated') return;
    this.shipLastDamagedByPlayer.set(shipId, { attackerId, at: this.t });
  }

  private getRecentShipSinkAttackerId(ship: Ship): string | null {
    const recent = this.shipLastDamagedByPlayer.get(ship.id);
    if (!recent || this.t - recent.at > 55) return null;
    const attacker = this.getPlayer(recent.attackerId);
    if (!attacker || attacker.state === 'eliminated' || attacker.shipId === ship.id) return null;
    return attacker.id;
  }

  private isBoardingKill(killer: Player, victim: Player) {
    return !!killer.shipId
      && !!victim.shipId
      && killer.shipId !== victim.shipId
      && killer.onShipId === victim.shipId;
  }

  private awardPlayerKillStreak(killer: Player): { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null {
    killer.playerKillStreak += 1;
    const delta = this.statsDelta(killer.id);
    if (killer.playerKillStreak > delta.bestKillStreak) delta.bestKillStreak = killer.playerKillStreak;
    // Thresholds live in KILL_STREAK_TIERS — the server, the badge, the feed and
    // the legend all read the same ladder (the old 5/10/20 was typed five times,
    // and its top rung was unreachable in a MATCH_TOTAL_SHIPS lobby).
    if (killer.playerKillStreak === KILL_STREAK_TIERS.super_cannonball) {
      killer.superCannonballs += 1;
      return { type: 'super_cannonball', label: 'Super cannonball ready' };
    }
    if (killer.playerKillStreak === KILL_STREAK_TIERS.mega_keg) {
      killer.megaKegs += 1;
      return { type: 'mega_keg', label: 'Mega keg ready' };
    }
    if (killer.playerKillStreak === KILL_STREAK_TIERS.tsunami) {
      killer.tsunamiCharges += 1;
      return { type: 'tsunami', label: 'Tsunami ready' };
    }
    return null;
  }

  private creditPlayerKill(killer: Player, victim: Player): {
    streakReward: { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null;
    killGold: number;
  } {
    // THE DEAD DO NOT GET PAID. Every gold path ran off "whoever last damaged
    // this pirate", and an island skeleton is a Player like any other — so a
    // skeleton that cut a pirate down banked the full 275 g kill bounty and rode
    // it onto the gold leaderboard, in a race it is not even running. A skeleton
    // is scenery with a cutlass: it kills, it is killed for gold, it earns none.
    if (this.isSkeletonPlayer(killer)) return { streakReward: null, killGold: 0 };
    killer.kills += 1;
    let streakReward: { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null = null;
    if (killer.shipId && victim.shipId && killer.shipId !== victim.shipId) {
      streakReward = this.awardPlayerKillStreak(killer);
    }
    const isSkeleton = this.isSkeletonPlayer(victim);
    if (isSkeleton) this.statsDelta(killer.id).skeletonsKilled += 1;
    const killGold = isSkeleton ? PLAYER.SKELETON_KILL_GOLD : PLAYER.KILL_GOLD_REWARD;
    killer.gold += killGold;
    this.checkWinCondition();
    return { streakReward, killGold };
  }

  /** An island skeleton: a bot with no ship, spawned by an island wave. The one
   *  authoritative test — `skeletonHomes` is what spawns and forgets them. */
  private isSkeletonPlayer(player: Player): boolean {
    return player.isBot && this.skeletonHomes.has(player.id);
  }

  /** Iron Cuirass: COMBAT damage (guns, blades, cannon, kegs, shark bites)
   *  chews through armor before flesh. Environmental attrition — storm,
   *  drowning, fire, falls — bypasses it: plate doesn't help you breathe.
   *  Returns the health damage left after absorption. */
  private absorbWithArmor(target: Player, amount: number): number {
    if (!target.armor || target.armor <= 0) return amount;
    const absorbed = Math.min(target.armor, amount);
    target.armor -= absorbed;
    return amount - absorbed;
  }

  /** Award the sinker gold + a feed line for the sink itself. The crew is NOT
   *  eliminated — they swim out (startShipSinking's splash loop) and stay in
   *  the fight; losing the ship only costs them their respawn anchor. */
  private creditShipSink(ship: Ship, killer: Player) {
    killer.gold += PLAYER.SHIP_SINK_GOLD;
    this.statsDelta(killer.id).shipsSunk += 1;
    const owner = this.state.players.find((p) => p.id === ship.ownerId);
    this.broadcast({
      type: 'kill_event',
      ts: Date.now(),
      payload: {
        victimId: ship.id,
        victimName: owner ? `${owner.name}'s ship` : 'a ship',
        killerId: killer.id,
        killerName: killer.name,
        respawning: false,
        headshot: false,
        boardingKill: false,
        shipSink: true,
        stolenGold: 0,
        healed: 0,
        killerStreak: killer.playerKillStreak,
        streakReward: 0,
        killGold: PLAYER.SHIP_SINK_GOLD,
        headshotGold: 0,
      },
    });
  }

  /** Home ship afloat and inside the VISIBLE storm ring (tiny 5m margin, not
   *  the old hidden 35m band) — respawn timers hold while this is false. */
  private isShipInStormSafeZone(ship: Ship): boolean {
    if (!ship.alive || ship.sinking) return false;
    const d = dist2D(ship.position.x, ship.position.z, this.state.storm.centerX, this.state.storm.centerZ);
    return d <= this.state.storm.safeRadius - 5;
  }

  private applyEliminatedPlayerFields(player: Player) {
    this.dropCarriedChest(player);
    player.health = 0;
    player.armor = 0;
    player.playerKillStreak = 0;
    player.respawnTimer = 0;
    player.respawnProtectionTimer = 0;
    player.shipBoundaryGraceTimer = 0;
    player.onShipId = null;
    this.clearStationFlags(player);
    player.nearShipId = null;
    player.nearChestId = null;
    player.velocity = { x: 0, y: 0, z: 0 };
    player.knockbackVelocity = { x: 0, y: 0, z: 0 };
    player.swimTimer = 0;
    player.cannonFlightTimer = 0;
    player.cannonBallistic = false;
    player.lastDamageWasHeadshot = false;
    player.blocking = false;
    player.cutlassCharge = 0;
    player.downedUntil = 0;
    player.reviveProgress = 0;
    this.downedByPlayer.delete(player.id);
  }

  // ── The damage witness ────────────────────────────────────────────────────
  // Tag WHO/WHAT is taking health off a pirate as it happens. Combat inside this
  // file tags itself directly; the two subsystems that own environmental
  // attrition (PhysicsSystem: drown/fire/fall/projectiles, StormSystem: the
  // tempest) are witnessed from out here by snapshotting health across their
  // update call, so neither of them has to grow a reporting channel.

  /** Remember what just bit this pirate. Latest wins — the LAST blow names the death. */
  private noteDamageSource(playerId: string, source: DamageSource): void {
    this.lastDamageSourceById.set(playerId, { source, at: this.t, tick: this.tickCount });
  }

  // ── The silent half of the damage model ───────────────────────────────────
  //
  // A fresh-eyes audit watched 100 → 58 while wandering, 58 → 8 walking to a
  // chest, then died, and could not name one point of it. The client's own
  // vitals watch (CombatFx.watchLocalVitals) does raise a red vignette on any
  // loss, so "something is hurting me" was on screen — but only combat ever
  // shipped a `player_hit`, so nothing ever said WHAT, and nothing put a number
  // in the frame. Weather, water, fire, rock and sharks were the whole silence.
  //
  // The witness above already knows the cause; it only ever threw the AMOUNT
  // away. So bank it and send the same incoming-hit message combat sends, with
  // the cause named. Two rules make it readable rather than a firehose:
  //
  //   * CHIPS ADD UP FIRST. The tempest bills 0.06–0.4 hp per tick at 62.5 Hz.
  //     One indicator per ENV_NOTICE_INTERVAL carrying the accumulated total
  //     reads as "-14 THE STORM" once a second, not as a wall of "-0".
  //   * A REAL BLOW JUMPS THE QUEUE. Past ENV_NOTICE_IMMEDIATE_HP (a shark's
  //     bite, a killing fall) the notice goes out on the tick it happened, so
  //     the number lands with the hit instead of a beat behind it.

  /** Banked environmental loss per pirate, awaiting its on-screen notice. */
  private envDamage = new Map<string, {
    amount: number; source: DamageSource; from: Vec3 | null; sentAt: number;
  }>();
  /** Cadence for accumulated chip damage. */
  private static readonly ENV_NOTICE_INTERVAL = 0.9;
  /** A blow this big is announced the tick it lands, whatever the cadence says. */
  private static readonly ENV_NOTICE_IMMEDIATE_HP = 10;

  /**
   * Bank a loss the player cannot otherwise account for.
   *
   * Combat sources are skipped: guns, blades, cannon and kegs already ship their
   * own `player_hit` with an attacker name, and doubling them would print every
   * musket ball twice.
   */
  private noteEnvironmentalDamage(
    player: Player,
    source: DamageSource,
    amount: number,
    origin?: Vec3,
  ): void {
    if (amount <= 1e-6) return;
    if (source === 'gunshot' || source === 'blade' || source === 'cannon' || source === 'explosion') return;
    const entry = this.envDamage.get(player.id);
    // WHERE IT CAME FROM, when that is a real direction. A shark carries its own
    // (the jaws are a place), and the tempest gets one built from the ring: the
    // hurt is outside the wall, so the wedge smears the seaward edge of the frame
    // and the clear side is the way home. Water, fire and the ground are under
    // you — a direction arrow for them would point at your own boots.
    const from = origin ?? (source === 'storm' ? this.stormwardPoint(player) : null);
    if (!entry) {
      this.envDamage.set(player.id, { amount, source, from, sentAt: this.t });
      return;
    }
    entry.amount += amount;
    // Latest cause wins, matching the witness: a swimmer the storm is billing
    // who then gets bitten reads as the shark, which is what just happened.
    entry.source = source;
    entry.from = from;
  }

  /** A point out past the storm wall on the player's own bearing from the eye. */
  private stormwardPoint(player: Player): Vec3 {
    const { centerX, centerZ, safeRadius } = this.state.storm;
    const dx = player.position.x - centerX;
    const dz = player.position.z - centerZ;
    const len = Math.hypot(dx, dz) || 1;
    const reach = safeRadius + 40;
    return {
      x: centerX + (dx / len) * reach,
      y: player.position.y + PLAYER.HEIGHT * 0.72,
      z: centerZ + (dz / len) * reach,
    };
  }

  /** Ship the banked notices whose turn has come. Once per tick, after both witnesses. */
  private flushEnvironmentalDamage(): void {
    for (const [playerId, entry] of this.envDamage) {
      const player = this.playersById.get(playerId);
      if (!player || player.state === 'eliminated') { this.envDamage.delete(playerId); continue; }
      const due = entry.amount >= Match.ENV_NOTICE_IMMEDIATE_HP
        || this.t - entry.sentAt >= Match.ENV_NOTICE_INTERVAL;
      if (!due) continue;
      // Rounded to a whole point, and never to zero: a notice that says "-0" is
      // worse than no notice at all, so sub-point trickles keep banking — and
      // they keep banking BY BEING LEFT ALONE.
      //
      // This used to delete the entry and set it straight back with a copy, which
      // WEDGED THE SERVER. Re-inserting a key into a Map that is being iterated
      // appends it after the cursor, so the loop reaches it again — and it is
      // still due, because the copy carries the same `sentAt` — so it is deleted
      // and re-appended again, forever. The tick never returned: 110 % CPU, a
      // dead /health endpoint, a silent log, and every later client stuck on the
      // loading screen because nothing could join. The `sample` was the whole
      // story — Runtime_MapShrink rehashing under MapPrototypeDelete next to
      // CloneObjectIC_Slow, which is exactly `delete` + `{ ...entry }` + `set`.
      //
      // Any storm chip under about half a point per second lands here, so this
      // was reachable from the edge of the ring in an ordinary match. A plain
      // `continue` banks it just as well: the entry keeps its old `sentAt`, so it
      // ships on the first tick it is worth a whole point. Deleting WITHOUT
      // re-inserting (below, and for the departed above) is safe.
      if (Math.round(entry.amount) < 1) continue;
      this.envDamage.delete(playerId);
      this.notifyIncomingPlayerHit(playerId, {
        attackerId: null,
        damage: entry.amount,
        position: {
          x: player.position.x,
          y: player.position.y + PLAYER.HEIGHT * 0.72,
          z: player.position.z,
        },
        sourcePosition: entry.from ?? undefined,
        // The client turns this into the floating label and the feed line — the
        // same nine words the death screen would have used, said while there is
        // still time to act on them.
        cause: entry.source,
        remainingHealth: Math.max(0, player.health),
        kill: player.health <= 0,
      });
    }
  }

  /** Drop a pirate's banked notice — a respawn refills the bar, it is not a wound. */
  private clearEnvironmentalDamage(playerId: string): void {
    this.envDamage.delete(playerId);
  }

  /**
   * Has something OTHER than `mine` already named this pirate's damage on the
   * tick now being resolved?
   *
   * The tick INDEX, not the clock. `tag.at === this.t` was only ever true for
   * tags written after `this.t` advanced inside the current tick, so a tag
   * written on the boundary read as a whole tick old and lost its name to
   * whichever witness closed last. A time WINDOW fixes that and breaks
   * something worse: the storm bills every tick, so a window wide enough to
   * cover one tick made the tempest's own previous tag suppress its next one and
   * half the storm damage stopped being announced at all. The tick counter is
   * the only reading that means exactly "this moment".
   *
   * `mine` is the source about to be claimed: a witness may always re-name its
   * own attrition, and may never overwrite somebody else's fresh blow.
   */
  private namedThisTickByOther(playerId: string, mine: DamageSource): boolean {
    const tag = this.lastDamageSourceById.get(playerId);
    if (!tag) return false;
    return tag.tick === this.tickCount && tag.source !== mine;
  }

  /** Freshest damage tag for this pirate, or null once the evidence goes stale. */
  private recentDamageSource(playerId: string): DamageSource | null {
    const tag = this.lastDamageSourceById.get(playerId);
    if (!tag) return null;
    if (this.t - tag.at > DAMAGE_SOURCE_WINDOW_SECONDS) return null;
    return tag.source;
  }

  /** Snapshot every living pirate's health into the witness scratch map. */
  private beginHealthWitness(): void {
    this.healthWitness.clear();
    for (const player of this.state.players) {
      if (player.state === 'eliminated') continue;
      this.healthWitness.set(player.id, player.health);
    }
  }

  /** Anyone who lost health since beginHealthWitness gets tagged by `resolve`,
   *  AND banked for a named on-screen notice (see noteEnvironmentalDamage). */
  private endHealthWitness(resolve: (player: Player) => DamageSource | null): void {
    for (const player of this.state.players) {
      const before = this.healthWitness.get(player.id);
      if (before === undefined || player.health >= before - 1e-6) continue;
      const source = resolve(player);
      if (source) {
        this.noteDamageSource(player.id, source);
        this.noteEnvironmentalDamage(player, source, before - player.health);
      }
    }
  }

  /**
   * Physics owns four unrelated ways to lose health in one call. Read the state
   * it left behind: a pirate under longer than DROWN_TIME is drowning, one
   * standing on a burning deck is burning, and anything else that hit them
   * inside a physics step was the ground coming up. Projectile hits are tagged
   * precisely (bullet vs cannon) in relayPendingCombatEvents, which runs first.
   */
  private resolvePhysicsDamageSource(player: Player): DamageSource | null {
    const mine: DamageSource = player.state === 'swimming' && (player.swimTimer ?? 0) > PLAYER.DROWN_TIME
      ? 'drowned'
      : (player.onShipId ? this.shipsById.get(player.onShipId) : null)?.onFire
        ? 'fire'
        : 'fall';
    // Already named this tick by the combat-event relay — don't overwrite a
    // cannonball with "fall" just because physics is what moved the number. The
    // reading has to be by tick INDEX: the old `at === this.t` equality silently
    // missed any tag written on the tick boundary (see namedThisTickByOther).
    if (this.namedThisTickByOther(player.id, mine)) return null;
    return mine;
  }

  /**
   * What actually finished this pirate, for the death screen's title.
   *
   * Called at the instant of elimination and never after: `applyEliminatedPlayerFields`
   * clears the state and position this reads from.
   *
   * The tagged source is the truth when it is fresh. Only when nothing tagged
   * them (a pirate who was already at zero when the match found them) does this
   * fall back to the old positional guess — which is the reading that told
   * storm and shark deaths alike they had DROWNED.
   */
  private eliminationCause(player: Player, killer: Player | null): EliminationCause {
    const source = this.recentDamageSource(player.id);
    if (killer) {
      // A credited killer still wins the ATTRIBUTION (it is a kill, not a
      // drowning) — but the weapon names itself when the last blow was theirs.
      return source === 'blade' || source === 'gunshot' || source === 'cannon' || source === 'explosion'
        ? source
        : 'killed';
    }
    if (source) return source;
    if (this.storm.isOutside(player.position.x, player.position.z, this.state.storm)) return 'storm';
    if (player.state === 'swimming') return 'drowned';
    return 'killed';
  }

  private recordElimination(p: Player) {
    if (this.eliminationOrder.includes(p.id)) return;
    this.eliminationOrder.push(p.id);
    if (!p.isBot && !this.humanFinalStats.has(p.id)) {
      this.humanFinalStats.set(p.id, {
        name: p.name,
        kills: p.kills,
        // Every death, not just the last one (see matchDeaths). An elimination
        // that somehow bypassed handlePlayerDeath still counts as the one.
        deaths: Math.max(1, this.matchDeaths.get(p.id) ?? 0),
        gold: p.gold,
      });
    }
  }

  // ── Down-but-not-out (DBNO) ─────────────────────────────────────────────

  /** The per-tick death gate: hp ≤ 0 downs the pirate when a living crewmate
   *  exists, finishes them if already downed, else it is a plain death. */
  private resolveHealthDeaths() {
    for (const player of this.state.players) {
      if (player.state === 'eliminated' || player.state === 'respawning') continue;
      if (player.health > 0) continue;
      if (player.state === 'downed') {
        this.finishDownedPlayer(player);
      } else if (this.hasLivingCrewmate(player)) {
        this.enterDowned(player);
      } else {
        this.handlePlayerDeath(player);
      }
    }
  }

  /**
   * Crewmates = players sharing the same home ship (player.shipId). Anyone not
   * eliminated counts — a downed or respawning mate can still come back and
   * revive you, so the squad isn't wiped yet.
   *
   * SOLO RETURNS FALSE BY DESIGN. Solo queue hands every human and every bot
   * their own hull, so no two players ever share a shipId and this is always
   * false: a solo pirate at 0 hp dies outright (the else-branch in
   * resolveHealthDeaths) and never enters DBNO. That is the intended solo
   * rule — there is nobody to crawl toward. The whole downed/revive/bleed-out
   * path below activates for DUOS and larger crews, where a shared shipId is
   * what makes a mate worth crawling to. Do not "fix" this by loosening the
   * crew test to proximity: it would let two strangers who happen to be near
   * each other keep one another alive.
   */
  private hasLivingCrewmate(player: Player): boolean {
    if (!player.shipId) return false;
    return this.state.players.some((mate) =>
      mate.id !== player.id
      && mate.shipId === player.shipId
      && mate.state !== 'eliminated',
    );
  }

  /** hp hit 0 with crewmates alive → crawl state instead of death. */
  private enterDowned(player: Player) {
    // Remember who put them down so bleed-out/finish still credits the
    // attacker even if environmental damage (drowning, fire) clears
    // lastDamagedById in the meantime.
    this.downedByPlayer.set(player.id, {
      attackerId: player.lastDamagedById !== player.id ? player.lastDamagedById : null,
      at: player.lastDamagedAt ?? this.t,
      headshot: player.lastDamageWasHeadshot,
    });
    const downerName = this.getPlayer(player.lastDamagedById)?.name ?? null;
    player.state = 'downed';
    player.health = DBNO.DOWNED_HEALTH;
    player.downedUntil = DBNO.BLEEDOUT_SECONDS;
    player.reviveProgress = 0;
    this.dropCarriedChest(player);
    this.clearStationFlags(player);
    player.reloading = false;
    player.reloadTimer = 0;
    player.cannonBallistic = false;
    player.cannonFlightTimer = 0;
    this.cutlassChargeByPlayer.delete(player.id);
    this.cutlassFireHeldByPlayer.delete(player.id);
    this.broadcast({
      type: 'player_downed',
      ts: Date.now(),
      payload: {
        playerId: player.id,
        playerName: player.name,
        attackerId: player.lastDamagedById,
        attackerName: downerName,
        bleedoutSeconds: DBNO.BLEEDOUT_SECONDS,
      },
    });
  }

  /** Bleed-out expired or a finisher drove downed vitality to 0 — real death. */
  private finishDownedPlayer(player: Player) {
    const downedBy = this.downedByPlayer.get(player.id);
    // Environmental damage clears lastDamagedById; fall back to whoever downed
    // them so bleed-out and finish always credit the killer.
    if (downedBy?.attackerId && !player.lastDamagedById) {
      player.lastDamagedById = downedBy.attackerId;
      player.lastDamagedAt = downedBy.at;
      player.lastDamageWasHeadshot = downedBy.headshot;
    }
    this.downedByPlayer.delete(player.id);
    player.downedUntil = 0;
    player.reviveProgress = 0;
    player.health = 0;
    this.handlePlayerDeath(player, /*wasDowned*/ true);
  }

  /** Nearest downed crewmate within revive range of the reviver, or null. */
  private findReviveTarget(reviver: Player): Player | null {
    if (!reviver.shipId || reviver.state === 'downed') return null;
    let best: Player | null = null;
    let bestDistance: number = DBNO.REVIVE_RANGE;
    for (const mate of this.state.players) {
      if (mate.id === reviver.id || mate.state !== 'downed') continue;
      if (mate.shipId !== reviver.shipId) continue;
      const dx = mate.position.x - reviver.position.x;
      const dy = mate.position.y - reviver.position.y;
      const dz = mate.position.z - reviver.position.z;
      const distance = Math.sqrt(dx * dx + Math.min(Math.abs(dy), 1.6) ** 2 + dz * dz);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = mate;
      }
    }
    return best;
  }

  /** Downed movement: crawl at 30% speed, look around, nothing else. */
  private applyDownedInput(player: Player, input: PlayerInput, dt: number) {
    player.rotation.x = input.yaw;
    player.rotation.y = input.pitch;
    const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    if (moveX !== 0 || moveZ !== 0) {
      const len = Math.hypot(moveX, moveZ) || 1;
      const speed = PLAYER.MOVE_SPEED * DBNO.CRAWL_SPEED_SCALE;
      const cosY = Math.cos(input.yaw);
      const sinY = Math.sin(input.yaw);
      player.velocity.x = (sinY * (moveZ / len) - cosY * (moveX / len)) * speed;
      player.velocity.z = (cosY * (moveZ / len) + sinY * (moveX / len)) * speed;
      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
    } else {
      player.velocity.x = 0;
      player.velocity.z = 0;
    }
  }

  /** Per-tick DBNO bookkeeping: revive progress (with decay) and bleed-out. */
  private updateDownedAndRevives(dt: number) {
    for (const player of this.state.players) {
      if (player.state !== 'downed') {
        if (player.reviveProgress !== 0) player.reviveProgress = 0;
        if (player.downedUntil !== 0) player.downedUntil = 0;
        continue;
      }

      const reviverId = this.reviveActionsThisTick.get(player.id) ?? null;
      if (reviverId) {
        const previous = player.reviveProgress;
        player.reviveProgress = Math.min(1, player.reviveProgress + dt / DBNO.REVIVE_SECONDS);
        if (previous <= 0 && player.reviveProgress > 0) {
          this.broadcast({
            type: 'revive_start',
            ts: Date.now(),
            payload: { playerId: player.id, reviverId },
          });
        }
        if (player.reviveProgress >= 1) {
          this.completeRevive(player, reviverId);
          continue;
        }
      } else if (player.reviveProgress > 0) {
        player.reviveProgress = Math.max(0, player.reviveProgress - DBNO.PROGRESS_DECAY_PER_SEC * dt);
      }

      // Bleed out — twice as fast outside the storm safe ring (the storm DoT
      // itself skips downed players so this is their only clock out there).
      const outsideStorm = this.storm.isOutside(player.position.x, player.position.z, this.state.storm);
      player.downedUntil -= dt * (outsideStorm ? DBNO.STORM_BLEEDOUT_MULT : 1);
      if (player.downedUntil <= 0) {
        this.finishDownedPlayer(player);
      }
    }
    this.reviveActionsThisTick.clear();
    this.sailHaulCrewThisTick.clear();
  }

  private completeRevive(player: Player, reviverId: string | null) {
    this.downedByPlayer.delete(player.id);
    player.state = 'alive'; // physics flips to swimming next tick if they're in water
    player.health = Math.round(PLAYER.MAX_HEALTH * DBNO.REVIVE_HEALTH_RATIO);
    player.downedUntil = 0;
    player.reviveProgress = 0;
    player.respawnProtectionTimer = Math.max(player.respawnProtectionTimer, 1.0);
    player.lastDamagedById = null;
    player.lastDamagedAt = null;
    player.lastDamageWasHeadshot = false;
    this.lastDamageSourceById.delete(player.id);
    this.broadcast({
      type: 'revive_complete',
      ts: Date.now(),
      payload: {
        playerId: player.id,
        playerName: player.name,
        reviverId,
        reviverName: this.getPlayer(reviverId)?.name ?? null,
      },
    });
  }

  /**
   * Bot DBNO behavior (Match-side, mirroring updateBotFlooding so BotSystem
   * stays lean): medics revive downed crewmates when no enemy is within
   * BOT_REVIVE_SAFE_RADIUS; otherwise bots walk over and finish downed
   * enemies inside BOT_FINISH_RADIUS with cutlass-cadence swings.
   */
  private updateBotDbno(dt: number) {
    for (const bot of this.state.players) {
      if (!bot.isBot || bot.health <= 0) continue;
      if (bot.state === 'eliminated' || bot.state === 'respawning' || bot.state === 'downed') continue;
      if (this.skeletonHomes.has(bot.id)) continue; // skeleton melee already mauls downed players
      if (bot.atCannon || bot.atHelm || bot.atCrowNest) continue;

      // 1. Medic: revive a downed crewmate when the coast is clear.
      const downedMate = this.state.players.find((mate) =>
        mate.id !== bot.id
        && mate.state === 'downed'
        && mate.shipId !== null
        && mate.shipId === bot.shipId
        && dist2D(mate.position.x, mate.position.z, bot.position.x, bot.position.z) <= DBNO.BOT_REVIVE_SAFE_RADIUS,
      );
      if (downedMate) {
        const enemyNear = this.state.players.some((enemy) =>
          enemy.shipId !== bot.shipId
          && enemy.state !== 'eliminated'
          && enemy.state !== 'respawning'
          && enemy.state !== 'downed'
          && dist2D(enemy.position.x, enemy.position.z, bot.position.x, bot.position.z) <= DBNO.BOT_REVIVE_SAFE_RADIUS,
        );
        if (!enemyNear) {
          const d = dist2D(downedMate.position.x, downedMate.position.z, bot.position.x, bot.position.z);
          if (d <= DBNO.REVIVE_RANGE) {
            this.reviveActionsThisTick.set(downedMate.id, bot.id);
          } else if (bot.onShipId === downedMate.onShipId) {
            this.stepBotToward(bot, downedMate.position, dt);
          }
          continue;
        }
      }

      // 2. Finisher: close on a downed enemy and end them.
      let downedEnemy: Player | null = null;
      let downedEnemyDistance: number = DBNO.BOT_FINISH_RADIUS;
      for (const enemy of this.state.players) {
        if (enemy.state !== 'downed' || enemy.shipId === bot.shipId) continue;
        const d = dist2D(enemy.position.x, enemy.position.z, bot.position.x, bot.position.z);
        if (d < downedEnemyDistance) {
          downedEnemyDistance = d;
          downedEnemy = enemy;
        }
      }
      if (downedEnemy) {
        if (downedEnemyDistance <= 2.3) {
          if ((this.botFinishCooldownAt.get(bot.id) ?? 0) <= this.t) {
            downedEnemy.lastDamagedById = bot.id;
            downedEnemy.lastDamagedAt = this.t;
            downedEnemy.lastDamageWasHeadshot = false;
            this.noteDamageSource(downedEnemy.id, 'blade');
            downedEnemy.health -= this.absorbWithArmor(downedEnemy, WEAPONS.cutlass.damage);
            this.botFinishCooldownAt.set(bot.id, this.t + WEAPONS.cutlass.reloadTime * 1.6);
          }
        } else if (bot.onShipId === downedEnemy.onShipId) {
          this.stepBotToward(bot, downedEnemy.position, dt);
        }
      }
    }
  }

  /** Step a bot's body toward a point at walking pace (deck clamps and slope
   *  blocking in PhysicsSystem keep the walk honest). */
  private stepBotToward(bot: Player, target: Vec3, dt: number) {
    const dx = target.x - bot.position.x;
    const dz = target.z - bot.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) return;
    const speed = PLAYER.MOVE_SPEED * 0.9;
    const step = Math.min(d, speed * dt);
    bot.position.x += (dx / d) * step;
    bot.position.z += (dz / d) * step;
    bot.rotation.x = Math.atan2(dx, dz);
  }

  private handlePlayerDeath(player: Player, wasDowned = false) {
    // Every death in the game funnels through here (bled out, finished, sunk,
    // drowned, stormed) — so this is where the end screen's Deaths column is
    // actually earned. Counted for bots too: the board ranks the whole fleet.
    this.matchDeaths.set(player.id, (this.matchDeaths.get(player.id) ?? 0) + 1);
    // The cuirass dies with you — armor never survives a respawn.
    player.armor = 0;
    let killer = player.lastDamagedById
      ? this.getPlayer(player.lastDamagedById)
      : null;
    if (killer?.id === player.id) killer = null;
    // Stale damage (e.g. shot minutes before drowning in the storm) pays nothing.
    if (killer && (player.lastDamagedAt === null || this.t - player.lastDamagedAt > KILL_CREDIT_WINDOW_SECONDS)) {
      killer = null;
    }
    const headshot = !!killer && player.lastDamageWasHeadshot;
    const boardingKill = !!killer && this.isBoardingKill(killer, player);
    let stolenGold = 0;
    let healed = 0;
    let killGold = 0;
    let streakReward: { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null = null;

    this.dropCarriedChest(player);
    player.playerKillStreak = 0;

    if (killer) {
      const credit = this.creditPlayerKill(killer, player);
      streakReward = credit.streakReward;
      killGold = credit.killGold;
      // A skeleton is still NAMED as the killer (the feed and the death card
      // owe you that) — it simply collects nothing for it: no bounty, no
      // headshot purse, no boarding plunder.
      const paidKiller = !this.isSkeletonPlayer(killer);
      if (headshot && paidKiller) killer.gold += PLAYER.HEADSHOT_GOLD_BONUS;
      if (boardingKill && paidKiller) {
        const previousHealth = killer.health;
        // Cutting down a pirate with a LADEN hold is worth what the hold is
        // worth: the cap scales from the old flat 180 up to STEAL_LADEN_MULT×
        // against a full purse (shared/cargo.ts). Boarding the leader is the
        // counterplay to the ballast that makes the leader catchable.
        stolenGold = Math.min(player.gold, boardingStealCap(player.gold));
        if (stolenGold > 0) {
          player.gold -= stolenGold;
          killer.gold += stolenGold;
        }
        killer.health = Math.min(PLAYER.MAX_HEALTH, killer.health + PLAYER.BOARDING_KILL_HEAL);
        healed = Math.max(0, killer.health - previousHealth);
      }
    }

    const occupiedShip = this.state.ships.find(s => s.crewIds.includes(player.id) && s.alive);
    if (occupiedShip) {
      occupiedShip.crewIds = occupiedShip.crewIds.filter(id => id !== player.id);
    }

    // A death only eliminates when the home ship is gone. The old rule also
    // required the ship to sit ≥35m INSIDE the storm ring — an invisible
    // margin that insta-eliminated players (and force-sank their whole crewed
    // ship) for boundary proximity. Now the respawn simply HOLDS while the
    // ship is outside the ring (see updateRespawns) and the storm's hull
    // punctures decide the ship's fate naturally.
    const homeShip = this.getAliveShip(player.shipId);
    const canRespawn = !!homeShip;
    // Read WHY here, ONCE, for both exits. A respawning pirate deserves the
    // same answer an eliminated one gets — "Respawning in 8" told you the wait
    // and never what put you in it — and the reading has to happen before the
    // state below clears the evidence it stands on.
    const eliminationCause: EliminationCause = this.eliminationCause(player, killer);

    if (canRespawn) {
      player.state = 'respawning';
      player.health = 0;
      // A fresh death gets a fresh hold: never inherit a spent one (which would
      // skip the mate's rescue window) nor a stale start time.
      this.respawnHoldSince.delete(player.id);
      // Whatever the weather still owed him died with him — a notice arriving on
      // the blackout would name a wound he is already past.
      this.clearEnvironmentalDamage(player.id);
      player.respawnTimer = PLAYER.RESPAWN_TIME;
      player.respawnProtectionTimer = 0;
      player.shipBoundaryGraceTimer = 0;
      player.onShipId = null;
      this.clearStationFlags(player);
      player.nearShipId = null;
      player.nearChestId = null;
      player.velocity = { x: 0, y: 0, z: 0 };
      player.knockbackVelocity = { x: 0, y: 0, z: 0 };
      player.swimTimer = 0;
      player.cannonFlightTimer = 0;
      player.cannonBallistic = false;
      player.lastDamageWasHeadshot = false;
      player.blocking = false;
      player.cutlassCharge = 0;
      player.downedUntil = 0;
      player.reviveProgress = 0;
      this.downedByPlayer.delete(player.id);
    } else {
      player.state = 'eliminated';
      this.recordElimination(player);
      this.applyEliminatedPlayerFields(player);
    }

    if (player.isBot && player.state === 'eliminated') {
      this.bots.removeBot(player.id);
    } else if (!player.isBot && player.state === 'eliminated') {
      const client = this.clients.get(player.id);
      if (client) {
        this.send(client.ws, {
          type: 'game_over',
          ts: Date.now(),
          payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold, cause: eliminationCause },
        });
      }
    }

    this.broadcast({
      type: 'kill_event',
      ts: Date.now(),
      payload: {
        victimId: player.id,
        victimName: player.name,
        killerId: killer?.id ?? null,
        killerName: killer?.name ?? null,
        respawning: player.state === 'respawning',
        /** What took the last of their health — the death screen's title, and
         *  the line the respawn blackout now names the wait WITH. */
        cause: eliminationCause,
        headshot,
        boardingKill,
        /** True when the victim bled out / was finished from the downed state. */
        downed: wasDowned,
        stolenGold,
        healed,
        killerStreak: killer?.playerKillStreak ?? 0,
        streakReward,
        killGold,
        headshotGold: killer && headshot ? PLAYER.HEADSHOT_GOLD_BONUS : 0,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // HOLD CARGO — the 9000-gold race, made physical
  // ══════════════════════════════════════════════════════════════════════
  // The signature mechanic of this BR used to play as a background scoreboard:
  // an invisible number climbing in the corner, with a 180g boarding steal as
  // its only counterplay against a 9000g target. Everything below turns that
  // number into matter in the world:
  //   · a crew's gold over CARGO.SAFE_GOLD becomes CARGO — crates you can walk
  //     down into the hold and look at, and BALLAST the hull carries as lost
  //     top speed, so the leader can be run down;
  //   · past CARGO.BOUNTY_RATIO of the target that crew is BOUNTIED: called out
  //     on every battle map and re-cried each storm phase — the hunted galleon;
  //   · when she FOUNDERS half that cargo SPILLS into the shallows over the
  //     wreck, divable by anyone (crucially including the crew that just swam
  //     out of her — sinking costs you the lead, it does not delete your match).
  // Safe pocket gold is never touched by any of it.

  /** A crew's banked gold: every non-eliminated pirate whose home is this hull. */
  private crewGold(ship: Ship): number {
    let total = 0;
    for (const player of this.state.players) {
      if (player.shipId !== ship.id) continue;
      if (player.state === 'eliminated') continue;
      total += Math.max(0, player.gold);
    }
    return total;
  }

  /**
   * Recompute every hull's cargo weight and the standing bounties. Runs before
   * bots pick targets and before physics integrates, so the ballast a laden
   * hull carries this tick is the ballast the sim actually sails with.
   */
  private updateCargoAndBounty() {
    const bountyAt = bountyThresholdGold();
    const clearAt = bountyClearGold();
    const raised: Ship[] = [];
    // THE STRONGBOX IS A BOUNTY YOU CAN CARRY. A gold bounty is earned slowly
    // and shows on the chart; the prize off the Gilded Wreck does the same job
    // the instant it comes over a rail, which is the whole point of putting one
    // indivisible thing aboard her. Kept apart from the gold set so it never
    // touches that set's hysteresis — it is a possession, not a threshold.
    const prizeShipId = this.strongboxHolderShipId();

    for (const ship of this.state.ships) {
      if (!ship.alive) {
        ship.cargoGold = 0;
        ship.bountied = undefined;
        this.bountiedShipIds.delete(ship.id);
        continue;
      }
      const gold = this.crewGold(ship);
      // THE PRIZE IS BALLAST. Two thousand six hundred in gold plate is not
      // pocket coin — it rides in the hold, it shows in the hold, and it costs
      // her the knots the ballast curve says it costs. That is the counterplay
      // that makes the prize hunt a CHASE somebody can win instead of a stern
      // parade: the crew that has it is the crew that can be run down.
      ship.cargoGold = cargoGoldFromBanked(gold)
        + (ship.id === prizeShipId ? WRECK_EVENT.STRONGBOX_VALUE : 0);

      const wasBountied = this.bountiedShipIds.has(ship.id);
      // Hysteresis: cross 60% to earn the bounty, fall under 55% to shake it.
      const bountied = ship.sinking ? false : wasBountied ? gold >= clearAt : gold >= bountyAt;
      if (bountied && !wasBountied) {
        this.bountiedShipIds.add(ship.id);
        raised.push(ship);
      } else if (!bountied && wasBountied) {
        this.bountiedShipIds.delete(ship.id);
      }
      // Only ever TRUE on the wire — an absent field reads as no bounty, which
      // keeps the flag free on the nine hulls that don't have one.
      const holdsPrize = ship.id === prizeShipId && !ship.sinking;
      ship.bountied = (bountied || holdsPrize) ? true : undefined;
    }

    // Bots hunt the money. The set is handed over every tick (like bot-peace)
    // so a bounty that lifts stops pulling hunters the same tick it clears.
    this.bots.setBountiedShips(this.bountiedShipIds);
    // The prize is handed over separately because it hunts HARDER than gold: a
    // strongbox holder is fair game to any crew inside PRIZE_HUNT_RANGE whether
    // or not the phase seek radius reaches her and whether or not the hunter cap
    // is full. Nothing else in the match lifts both rails at once.
    this.bots.setPrizeShips(prizeShipId ? [prizeShipId] : []);
    if (prizeShipId !== this.prizeShipId) {
      this.prizeShipId = prizeShipId;
      const prize = prizeShipId ? this.getShip(prizeShipId) : null;
      // Same cry as a gold bounty: one horn, one line, every chart. She is the
      // treasure now, and the whole lobby is told so. The strongbox rides the
      // cry as gold she is CARRYING — a crew with an empty purse and the prize
      // in her hold is not "banked 0g", she is worth STRONGBOX_VALUE to whoever
      // takes her, and that is the number the fleet needs to hear.
      if (prize && prize.alive) this.cryBounty(prize, false, WRECK_EVENT.STRONGBOX_VALUE);
    }

    for (const ship of raised) this.cryBounty(ship, false);

    // Re-cry the standing bounties on every storm phase: the ring tightening is
    // exactly when the fleet needs reminding who is carrying the match.
    if (this.state.storm.phase !== this.bountyCriedPhase) {
      this.bountyCriedPhase = this.state.storm.phase;
      for (const ship of this.state.ships) {
        if (!ship.alive || !this.bountiedShipIds.has(ship.id)) continue;
        if (raised.includes(ship)) continue;
        this.cryBounty(ship, true);
      }
    }
  }

  /** One horn-and-feed call across the whole map: THAT hull is the treasure. */
  private cryBounty(ship: Ship, renewed: boolean, carriedBonus = 0) {
    const owner = this.state.players.find((p) => p.id === ship.ownerId);
    this.broadcast({
      type: 'bounty_raised',
      ts: Date.now(),
      payload: {
        shipId: ship.id,
        crewName: owner ? `${owner.name}'s crew` : 'A crew',
        gold: this.crewGold(ship) + carriedBonus,
        targetGold: ECONOMY.GOLD_WIN_TARGET,
        renewed,
      },
    });
  }

  /**
   * She's going down with a full hold — half the crew's CARGO (capped, never
   * their safe pocket) breaks out of her and settles in the shallows over the
   * wreck as divable sunken cargo. Every crew member gives up a share
   * proportional to their own cargo, so nobody is ever pushed under SAFE_GOLD.
   */
  private spillCargoOnFounder(ship: Ship) {
    const crew = this.state.players.filter(
      (p) => p.shipId === ship.id && p.state !== 'eliminated' && cargoGoldFromBanked(p.gold) > 0,
    );
    const cargo = crew.reduce((sum, p) => sum + cargoGoldFromBanked(p.gold), 0);
    const spill = spillFromCargo(cargo);
    if (spill <= 0) return;

    let taken = 0;
    for (let i = 0; i < crew.length; i += 1) {
      const player = crew[i];
      const share = i === crew.length - 1
        ? spill - taken
        : Math.floor(spill * (cargoGoldFromBanked(player.gold) / cargo));
      const loss = Math.min(share, cargoGoldFromBanked(player.gold));
      player.gold -= loss;
      taken += loss;
    }
    if (taken <= 0) return;

    const pieces = splitSpill(taken);
    for (let i = 0; i < pieces.length; i += 1) {
      const angle = (i / pieces.length) * Math.PI * 2 + ship.rotation;
      const radius = CARGO.SPILL_SCATTER * (0.35 + (i % 3) * 0.28);
      this.state.spoils = this.state.spoils ?? [];
      this.state.spoils.push({
        id: `sp${++this.spoilSeq}`,
        position: {
          x: ship.position.x + Math.sin(angle) * radius,
          y: -CARGO.SPILL_DEPTH,
          z: ship.position.z + Math.cos(angle) * radius,
        },
        value: pieces[i],
        fromShipId: ship.id,
        expiresAt: this.t + CARGO.SPILL_LIFETIME,
      });
    }
    // Wire budget: a busy endgame can have several wrecks bleeding at once.
    const spoils = this.state.spoils ?? [];
    if (spoils.length > CARGO.SPILL_WORLD_MAX) {
      this.state.spoils = spoils.slice(spoils.length - CARGO.SPILL_WORLD_MAX);
    }

    const owner = this.state.players.find((p) => p.id === ship.ownerId);
    this.broadcast({
      type: 'cargo_spilled',
      ts: Date.now(),
      payload: {
        shipId: ship.id,
        crewName: owner ? `${owner.name}'s crew` : 'A crew',
        gold: taken,
        pieces: pieces.length,
        position: { x: ship.position.x, y: -CARGO.SPILL_DEPTH, z: ship.position.z },
      },
    });
  }

  /**
   * Sunken cargo: age it out, and hand it to any pirate who swims into it. No
   * [X] and no arbiter entry on purpose — swimming through a sunken chest and
   * feeling the coin go in is the whole verb, and diving already costs breath.
   */
  private updateSpoils() {
    const spoils = this.state.spoils;
    if (!spoils || spoils.length === 0) return;
    const rangeSq = CARGO.SPILL_PICKUP_RANGE * CARGO.SPILL_PICKUP_RANGE;

    for (let i = spoils.length - 1; i >= 0; i -= 1) {
      const spoil = spoils[i];
      if (spoil.expiresAt !== undefined && this.t >= spoil.expiresAt) {
        spoils.splice(i, 1);
        continue;
      }
      let claimant: Player | null = null;
      for (const player of this.state.players) {
        if (player.state === 'eliminated' || player.state === 'respawning' || player.state === 'downed') continue;
        if (player.health <= 0) continue;
        if (this.isSkeletonPlayer(player)) continue; // the dead do not go diving for coin

        const dx = player.position.x - spoil.position.x;
        const dy = player.position.y - spoil.position.y;
        const dz = player.position.z - spoil.position.z;
        if (dx * dx + dy * dy + dz * dz > rangeSq) continue;
        claimant = player;
        break;
      }
      if (!claimant) continue;

      claimant.gold += spoil.value;
      spoils.splice(i, 1);
      this.broadcast({
        type: 'spoil_claimed',
        ts: Date.now(),
        payload: {
          playerId: claimant.id,
          playerName: claimant.name,
          gold: spoil.value,
          position: { ...spoil.position },
        },
      });
      this.checkWinCondition();
    }
  }

  private checkWinCondition() {
    if (this.state.phase !== 'playing') return;

    // A RACE WITH ONE RUNNER IS NOT A RACE. Bot crews loot, bank, carry
    // bounties and get hunted for them — and then could not cross the finish
    // line, because the gold win only ever looked at humans. Any crew that
    // reaches the target takes the match, exactly as the bounty horn has been
    // promising the whole way in. Skeletons are the one exception: island
    // scenery does not run the race (and now earns nothing to run it with).
    const goldWinner = this.state.players.find((player) =>
      player.state !== 'eliminated'
      && !this.isSkeletonPlayer(player)
      && player.gold >= ECONOMY.GOLD_WIN_TARGET
    );
    if (goldWinner) {
      this.state.phase = 'ended';
      this.state.winnerId = goldWinner.id;
      this.endedAt = Date.now();
      this.endReason = 'gold';
      this.broadcast({
        type: 'game_over',
        ts: Date.now(),
        payload: {
          winnerId: this.state.winnerId,
          reason: 'gold',
          gold: goldWinner.gold,
          targetGold: ECONOMY.GOLD_WIN_TARGET,
        },
      });
      this.emitMatchEnd();
      return;
    }

    const aliveShips = this.state.ships.filter((ship) => ship.alive && !ship.sinking);
    this.state.shipsAlive = aliveShips.length;
    if (aliveShips.length <= 1 && this.state.ships.length > 1) {
      // A sunk crew is NOT out of the fight — shipless survivors (swimming,
      // boarding, marooned) keep the match alive until only one crew remains
      // standing. Ship count alone doesn't end it.
      const lastShip = aliveShips[0] ?? null;
      const activeCrews = new Set<string>();
      let lastContender: Player | null = null;
      for (const p of this.state.players) {
        if (p.state === 'eliminated') continue;
        const standing = p.health > 0;
        const canReturn = p.state === 'respawning' && aliveShips.some((s) => s.id === p.shipId);
        if (!standing && !canReturn) continue;
        activeCrews.add(p.shipId ?? p.id);
        lastContender = p;
      }
      if (activeCrews.size > 1) return;
      this.state.phase = 'ended';
      this.state.winnerId = lastShip?.ownerId ?? lastContender?.id ?? null;
      this.endedAt = Date.now();
      this.endReason = 'last_ship';
      this.broadcast({ type: 'game_over', ts: Date.now(), payload: { winnerId: this.state.winnerId } });
      this.emitMatchEnd();
    }
  }

  /** Every full snapshot (join included) stamps the next `seq`; hot snapshots draw
   *  from the same counter, so the client can order the two interleaved streams. */
  private buildSnapshot(includeStaticWorld = true): GameState {
    return {
      ...this.state,
      seq: ++this.snapshotSeq,
      serverTime: this.t,
      projectiles: this.state.projectiles.filter(p => p.alive),
      kegs: this.state.kegs.filter((keg) => keg.timer > 0 && !keg.defused),
      islands: includeStaticWorld ? this.state.islands : [],
      // Fixed for the life of the world, so they keep the statics' cadence and
      // cost the 10Hz full nothing. The live wreck rides EVERY full (see
      // GameState.wreck) because a beacon that lights 19s late is not a beacon.
      seaPois: includeStaticWorld ? this.state.seaPois : [],
      chestSync: this.state.islands.flatMap((island) => island.chests),
    };
  }

  private relayPendingCombatEvents() {
    for (const event of this.physics.flushCombatEvents()) {
      if (event.type === 'player_hit') {
        this.awardPlayerHitGold(event.attackerId, event.damage);
        const attacker = this.getPlayer(event.attackerId);
        // Name the round that landed BEFORE the physics witness closes, so a
        // cannonball through the chest is never filed as a fall.
        this.noteDamageSource(event.targetId, event.projectileType === 'bullet' ? 'gunshot' : 'cannon');
        this.notifyPlayerHit(event.attackerId, {
          targetId: event.targetId,
          damage: event.damage,
          position: event.position,
          kill: event.kill,
          remainingHealth: Math.max(0, this.getPlayer(event.targetId)?.health ?? 0),
          weaponId: event.projectileType,
        });
        this.notifyIncomingPlayerHit(event.targetId, {
          attackerId: event.attackerId,
          attackerName: attacker?.name,
          damage: event.damage,
          position: event.position,
          sourcePosition: attacker
            ? {
                x: attacker.position.x,
                y: attacker.position.y + PLAYER.HEIGHT * 0.72,
                z: attacker.position.z,
              }
            : undefined,
          kill: event.kill,
          remainingHealth: Math.max(0, this.getPlayer(event.targetId)?.health ?? 0),
          weaponId: event.projectileType,
        });
      } else if (event.type === 'ship_ram') {
        // Ram damage banks sink credit like any other ship damage; no
        // attacker-only toast (the collision itself is the feedback).
        this.markShipDamagedByPlayer(event.targetId, event.attackerId);
      } else if (event.type === 'ship_impact') {
        // A physical crash (ram / aground / sea-rock) — broadcast the contact
        // point so every nearby client plays the hull-smash SFX.
        this.broadcast({
          type: 'ship_impact',
          ts: Date.now(),
          payload: { kind: event.kind, position: event.position, speed: event.speed },
        });
      } else {
        this.markShipDamagedByPlayer(event.targetId, event.attackerId);
        this.notifyShipHit(event.attackerId, {
          targetId: event.targetId,
          damage: event.damage,
          position: event.position,
          section: event.section,
          remainingSection: event.remainingSection,
          remainingHull: event.remainingHull,
          shipHealthMilestone: event.milestone,
          weaponId: event.projectileType,
        });
        // Victims and bystanders get a slim broadcast so every client can
        // render impact FX / hole decals at the hit point (the attacker-only
        // ship_hit above stays the hit-confirm channel). `holes` carries the
        // hull-local breach points this ball just opened so the decal appears
        // the SAME frame as the splinters instead of waiting up to 100 ms for
        // the next full snapshot; the snapshot then reconciles by id.
        this.broadcast({
          type: 'ship_damage',
          ts: Date.now(),
          payload: {
            targetId: event.targetId,
            attackerId: event.attackerId,
            section: event.section,
            position: event.position,
            damage: event.damage,
            remainingSection: event.remainingSection,
            projectileType: event.projectileType,
            holes: event.holes,
          },
        });
      }
    }
  }

  private awardPlayerHitGold(attackerId: string | null, damage: number) {
    if (!attackerId || damage <= 0) return;
    const attacker = this.getPlayer(attackerId);
    if (!attacker || attacker.state === 'eliminated') return;
    // Skeletons draw no pay for landing a blow either (see creditPlayerKill).
    if (this.isSkeletonPlayer(attacker)) return;
    const raw = Math.round(damage * ECONOMY.PLAYER_HIT_GOLD_RATIO);
    const award = Math.max(
      ECONOMY.PLAYER_HIT_GOLD_MIN,
      Math.min(ECONOMY.PLAYER_HIT_GOLD_MAX, raw),
    );
    attacker.gold += award;
    this.checkWinCondition();
  }

  private notifyPlayerHit(
    attackerId: string,
    payload: {
      targetId: string;
      damage: number;
      position: Vec3;
      headshot?: boolean;
      kill?: boolean;
      remainingHealth?: number;
      weaponId?: string;
      targetType?: 'player' | 'shark' | 'wildlife';
      meat?: number;
      meatType?: WildlifeType;
      blocked?: boolean;
    },
  ) {
    // Single per-hit confirm channel — melee, hitscan (merged per volley), keg
    // and projectile paths each call this once per landed hit, so player-target
    // damage/headshot stats accumulate here without double counting.
    if ((payload.targetType ?? 'player') === 'player' && payload.targetId !== attackerId && payload.damage > 0) {
      const delta = this.statsDelta(attackerId);
      delta.damageDealt += payload.damage;
      if (payload.headshot) delta.headshots += 1;
    }
    const client = this.clients.get(attackerId);
    if (!client) return;
    this.send(client.ws, {
      type: 'player_hit',
      ts: Date.now(),
      payload,
    });
  }

  private notifyIncomingPlayerHit(
    victimId: string,
    payload: {
      attackerId?: string | null;
      attackerName?: string;
      damage: number;
      position?: Vec3;
      sourcePosition?: Vec3;
      headshot?: boolean;
      kill?: boolean;
      remainingHealth?: number;
      weaponId?: string;
      blocked?: boolean;
      /** Environmental blows have no attacker to name, so they name themselves. */
      cause?: DamageSource;
    },
  ) {
    const client = this.clients.get(victimId);
    if (!client) return;
    this.send(client.ws, {
      type: 'player_hit',
      ts: Date.now(),
      payload: {
        ...payload,
        incoming: true,
      },
    });
  }

  private notifyShipHit(
    attackerId: string,
    payload: {
      targetId: string;
      damage: number;
      position: Vec3;
      section: keyof HullSections;
      remainingSection: number;
      remainingHull?: number;
      shipHealthMilestone?: 'half' | 'critical' | null;
      weaponId?: string;
    },
  ) {
    const client = this.clients.get(attackerId);
    if (!client) return;
    this.send(client.ws, {
      type: 'ship_hit',
      ts: Date.now(),
      payload,
    });
  }

  private broadcast(msg: NetMsg) {
    const data = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try { client.ws.send(data); } catch {}
      }
    }
  }

  /**
   * Snapshot broadcast with drop-OLD backpressure: when a client's socket is
   * congested we hold the NEWEST update per kind (any older pending one is
   * simply replaced — dropped) and flush it as soon as the buffer drains,
   * instead of silently skipping new snapshots while stale bytes sit in
   * flight (the old behavior that ran clients ~1 s behind).
   */
  private broadcastVolatile(msg: NetMsg, kind: 'full' | 'hot') {
    const data = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.ws.bufferedAmount > MAX_VOLATILE_BUFFERED_BYTES) {
        // Hot updates are superseded ~31x/second, so a withheld one is simply
        // dropped; only the newest FULL base is worth holding for the flush.
        if (kind === 'full') client.pendingFullSnapshot = data;
        continue;
      }
      if (kind === 'full') {
        // A newer full snapshot supersedes any pending one outright.
        client.pendingFullSnapshot = null;
      } else if (client.pendingFullSnapshot) {
        // Hot updates patch onto the last full state — deliver the withheld
        // full base first so the client never applies patches to stale data.
        try { client.ws.send(client.pendingFullSnapshot); } catch {}
        client.pendingFullSnapshot = null;
      }
      try { client.ws.send(data); } catch {}
    }
  }

  private send(ws: WebSocket, msg: NetMsg) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }

  /**
   * Bot shore parties: BotSystem walks the bot's body to the chest and back
   * along the island surface. Here we resolve the world interactions — dig +
   * pick up when standing at the chest, then board + stow once the bot is back
   * at its own hull (the final hop aboard replaces climbing the ladder).
   */
  private processBotLooting() {
    for (const player of this.state.players) {
      if (!player.isBot || player.shipId === null || player.state === 'eliminated' || player.state === 'downed') continue;

      // A CREW DOES NOT KEEP HOISTING ITS OWN TREASURE BACK OUT OF THE HOLD.
      // Chest proximity (PhysicsSystem) does not know about stowage, so a bot
      // standing over its own hold saw the chest it had just stowed, took it,
      // stowed it again, and did that every tick — measured live on the wreck as
      // the same "Chest stowed aboard: base 2600 gold" feed line ×596. Harmless
      // to the sim, ruinous to the feed, and it pinned the crew to the spot.
      const ownStowed = player.nearChestId
        && this.getChestById(player.nearChestId)?.chest.storedOnShipId === player.shipId;
      if (ownStowed) player.nearChestId = null;

      if (player.nearChestId && !player.carryingChestId) {
        for (const island of this.state.islands) {
          const chest = island.chests.find((c) => c.id === player.nearChestId);
          if (chest && chest.buried && chest.digProgress < 1) {
            chest.digProgress = 1;
            chest.position.y = getIslandSurfaceY(island, chest.position.x, chest.position.z) + 0.32;
          }
        }
        const event = this.tryTakeChest(player);
        if (event) {
          this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
        }
      }

      if (player.carryingChestId) {
        const homeShip = this.getAliveShip(player.shipId);
        if (!homeShip) continue;
        if (player.onShipId === homeShip.id) {
          this.tryStowCarriedChest(player, homeShip);
          continue;
        }
        const stats = SHIP_STATS[homeShip.type];
        const hullDistance = dist2D(
          player.position.x, player.position.z,
          homeShip.position.x, homeShip.position.z,
        );
        if (hullDistance <= stats.length * 0.55 + 3.2 && !player.onShipId) {
          player.onShipId = homeShip.id;
          player.nearShipId = homeShip.id;
          player.state = 'alive';
          player.position = {
            x: homeShip.position.x,
            y: homeShip.position.y + stats.height + 0.35,
            z: homeShip.position.z,
          };
          player.velocity = { x: 0, y: 0, z: 0 };
          this.clearStationFlags(player);
          this.tryStowCarriedChest(player, homeShip);
        }
      }
    }
  }

  private setupSkeletonWaves(islands: GameState['islands']) {
    this.skeletonWaveTimers.clear();
    this.skeletonSpawnedAt.clear();
    this.skeletonDefeatedAt.clear();
    this.skeletonHomes.clear();
    this.skeletonNameIndex = 1;
    for (const island of islands) {
      if (this.getSkeletonWaveSize(island) <= 0) continue;
      this.skeletonWaveTimers.set(
        island.id,
        randRange(SKELETON_WAVE_INITIAL_DELAY_MIN, SKELETON_WAVE_INITIAL_DELAY_MAX, this.rng),
      );
    }
  }

  private updateSkeletonWaves(dt: number) {
    let playersChanged = false;
    const retainedPlayers: Player[] = [];

    for (const player of this.state.players) {
      const homeIslandId = this.skeletonHomes.get(player.id);
      if (!homeIslandId) {
        retainedPlayers.push(player);
        continue;
      }

      const eliminated = player.state === 'eliminated' || player.health <= 0;
      if (eliminated) {
        const defeatedAt = this.skeletonDefeatedAt.get(player.id) ?? this.t;
        this.skeletonDefeatedAt.set(player.id, defeatedAt);
        if (this.t - defeatedAt >= SKELETON_DEFEAT_DESPAWN_SECONDS) {
          this.forgetSkeleton(player.id);
          playersChanged = true;
          continue;
        }
      } else {
        this.skeletonDefeatedAt.delete(player.id);
        const spawnedAt = this.skeletonSpawnedAt.get(player.id) ?? this.t;
        if (
          this.t - spawnedAt >= SKELETON_WAVE_LINGER_SECONDS
          && !this.hasHumanNearPoint(player.position.x, player.position.z, SKELETON_PLAYER_WAKE_RADIUS)
        ) {
          this.forgetSkeleton(player.id);
          playersChanged = true;
          continue;
        }
      }

      retainedPlayers.push(player);
    }

    if (playersChanged) {
      this.state.players = retainedPlayers;
    }

    for (const island of this.state.islands) {
      const waveSize = this.getSkeletonWaveSize(island);
      if (waveSize <= 0) continue;

      if (this.countActiveSkeletonsOnIsland(island.id) > 0) continue;

      const activationRadius = island.radius + SKELETON_ISLAND_ACTIVATION_MARGIN;
      if (!this.hasHumanNearPoint(island.position.x, island.position.z, activationRadius)) {
        continue;
      }

      let timer = this.skeletonWaveTimers.get(island.id);
      if (timer == null) {
        timer = randRange(SKELETON_WAVE_COOLDOWN_MIN, SKELETON_WAVE_COOLDOWN_MAX, this.rng);
      }

      timer -= dt;
      if (timer <= 0) {
        this.spawnSkeletonWave(island, waveSize);
        timer = randRange(SKELETON_WAVE_COOLDOWN_MIN, SKELETON_WAVE_COOLDOWN_MAX, this.rng);
        playersChanged = true;
      }
      this.skeletonWaveTimers.set(island.id, timer);
    }

    if (playersChanged) {
      this.rebuildEntityIndexes();
    }
  }

  private getSkeletonWaveSize(island: Island) {
    if (island.radius > 84) return 4;
    if (island.radius > 68) return 3;
    if (island.radius > 52) return 2;
    if (island.radius > 42) return 1;
    return 0;
  }

  private countActiveSkeletonsOnIsland(islandId: string) {
    let count = 0;
    for (const player of this.state.players) {
      if (this.skeletonHomes.get(player.id) !== islandId) continue;
      if (player.state === 'eliminated' || player.state === 'respawning' || player.health <= 0) continue;
      count++;
    }
    return count;
  }

  private hasHumanNearPoint(x: number, z: number, radius: number) {
    return this.state.players.some((player) =>
      !player.isBot
      && player.state !== 'eliminated'
      && player.state !== 'respawning'
      && dist2D(player.position.x, player.position.z, x, z) <= radius,
    );
  }

  private spawnSkeletonWave(island: Island, count: number) {
    const baseAngle = randAngle(this.rng);
    for (let i = 0; i < count; i++) {
      const skeletonId = uuid();
      const skeleton = this.createPlayer(skeletonId, `Skeleton_${this.skeletonNameIndex++}`, null, true);
      skeleton.health = 70;
      skeleton.weapons = [
        { weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 },
        null,
        null,
        null,
      ];
      skeleton.activeSlot = 0;
      const offset = (i - (count - 1) * 0.5) * 0.42 + randRange(-0.18, 0.18, this.rng);
      const angle = baseAngle + offset;
      const spawnPoint = getIslandSurfacePoint(island, randRange(0.2, 0.5, this.rng), angle, 0.06);
      skeleton.position = spawnPoint;
      skeleton.rotation.x = angle + Math.PI;
      skeleton.rotation.y = 0;
      skeleton.velocity.x = 0;
      skeleton.velocity.y = 0;
      skeleton.velocity.z = 0;
      this.state.players.push(skeleton);
      this.skeletonHomes.set(skeletonId, island.id);
      this.skeletonSpawnedAt.set(skeletonId, this.t);
    }
  }

  private forgetSkeleton(skeletonId: string) {
    this.skeletonHomes.delete(skeletonId);
    this.skeletonSpawnedAt.delete(skeletonId);
    this.skeletonDefeatedAt.delete(skeletonId);
  }

  private updateIslandSkeletons(dt: number) {
    for (const skeleton of this.state.players) {
      if (!skeleton.isBot || skeleton.shipId !== null || skeleton.health <= 0 || skeleton.state === 'eliminated' || skeleton.state === 'respawning') {
        continue;
      }

      const homeIslandId = this.skeletonHomes.get(skeleton.id);
      const island = this.state.islands.find(candidate => candidate.id === homeIslandId);
      if (!island) continue;

      skeleton.onShipId = null;
      this.clearStationFlags(skeleton);
      skeleton.nearChestId = null;
      skeleton.nearShipId = null;
      skeleton.state = 'alive';

      const target = this.state.players
        .filter(candidate =>
          !candidate.isBot
          && candidate.state !== 'eliminated'
          && candidate.state !== 'respawning'
          && dist2D(candidate.position.x, candidate.position.z, skeleton.position.x, skeleton.position.z) < 22,
        )
        .sort((a, b) =>
          dist2D(a.position.x, a.position.z, skeleton.position.x, skeleton.position.z)
          - dist2D(b.position.x, b.position.z, skeleton.position.x, skeleton.position.z)
        )[0] ?? null;

      if (target) {
        const dx = target.position.x - skeleton.position.x;
        const dz = target.position.z - skeleton.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz) || 1;
        skeleton.rotation.x = Math.atan2(dx, dz);
        skeleton.rotation.y = 0;

        if (distance > 2.0) {
          skeleton.blocking = false;
          // Skeletons sprint at 38% player speed — fast enough to be threatening
          const moveSpeed = PLAYER.MOVE_SPEED * 0.38;
          const nextX = skeleton.position.x + (dx / distance) * moveSpeed * dt;
          const nextZ = skeleton.position.z + (dz / distance) * moveSpeed * dt;
          if (isPointInsideIslandFootprint(island, nextX, nextZ, 1.4)) {
            skeleton.position.x = nextX;
            skeleton.position.z = nextZ;
            skeleton.velocity.x = (dx / distance) * moveSpeed;
            skeleton.velocity.z = (dz / distance) * moveSpeed;
          } else {
            skeleton.velocity.x = 0;
            skeleton.velocity.z = 0;
          }
        } else {
          skeleton.velocity.x = 0;
          skeleton.velocity.z = 0;
          const weapon = skeleton.weapons[skeleton.activeSlot];
          // Swordplay: a skeleton facing a player who is winding up a cutlass
          // RAISES ITS GUARD instead of trading — the same block rules players
          // get (getCutlassBlockScale reads skeleton.blocking + facing). Reflexes
          // vary per skeleton so a crowd doesn't parry in lockstep.
          const targetWeapon = target.weapons[target.activeSlot];
          const targetThreatens = !!targetWeapon
            && targetWeapon.weaponId === 'cutlass'
            && (target.cutlassCharge > 0.12 || (this.cutlassFireHeldByPlayer.get(target.id) ?? false))
            && distance < 4.2;
          const guardReflex = (skeletonPhase(skeleton) % 10) / 10;
          skeleton.blocking = targetThreatens && guardReflex < 0.7
            && !!weapon && weapon.weaponId === 'cutlass' && !weapon.reloading;
          if (weapon && !weapon.reloading && !skeleton.blocking) {
            const hits = this.weapons.tryMeleeAttack(skeleton, [target], skeleton.rotation.x);
            for (const hit of hits) {
              // The same guard players rely on works against skeletons — their
              // swings used to bypass the block check entirely, which is why
              // "blocking doesn't work" was mostly true in practice.
              const blockScale = this.getCutlassBlockScale(target, skeleton);
              const blocked = blockScale < 1;
              target.lastDamagedById = skeleton.id;
              target.lastDamagedAt = this.t;
              target.lastDamageWasHeadshot = false;
              // 65% weapon damage — skeletons are a real threat now
              const damage = hit.damage * 0.65 * blockScale;
              this.noteDamageSource(target.id, 'blade');
              target.health -= this.absorbWithArmor(target, damage);
              this.notifyIncomingPlayerHit(target.id, {
                attackerId: skeleton.id,
                attackerName: skeleton.name,
                damage,
                blocked,
                position: {
                  x: target.position.x,
                  y: target.position.y + PLAYER.HEIGHT * 0.72,
                  z: target.position.z,
                },
                sourcePosition: {
                  x: skeleton.position.x,
                  y: skeleton.position.y + PLAYER.HEIGHT * 0.72,
                  z: skeleton.position.z,
                },
                kill: target.health <= 0,
                remainingHealth: Math.max(0, target.health),
                weaponId: weapon.weaponId,
              });
              const len = Math.sqrt(dx * dx + dz * dz) || 1;
              const kbScale = blocked ? 0.28 : 0.72;
              target.knockbackVelocity.x += (dx / len) * hit.knockback * kbScale;
              target.knockbackVelocity.y += hit.knockback * (blocked ? 0.06 : 0.18);
              target.knockbackVelocity.z += (dz / len) * hit.knockback * kbScale;
            }
            weapon.reloading = true;
            weapon.reloadTimer = WEAPONS.cutlass.reloadTime * 1.5;
          }
        }
      } else {
        skeleton.blocking = false;
        const roamSeed = (skeletonPhase(skeleton) % 1000) * 0.0173;
        const patrolAngle = (this.t * 0.22 + roamSeed) % (Math.PI * 2);
        const patrolRadius = 0.2 + ((Math.sin(this.t * 0.13 + roamSeed) + 1) * 0.5) * 0.24;
        const patrolPoint = getIslandSurfacePoint(island, patrolRadius, patrolAngle, 0.04);
        const dx = patrolPoint.x - skeleton.position.x;
        const dz = patrolPoint.z - skeleton.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz) || 1;
        if (distance > 0.35) {
          const moveSpeed = PLAYER.MOVE_SPEED * 0.18;
          skeleton.position.x += (dx / distance) * moveSpeed * dt;
          skeleton.position.z += (dz / distance) * moveSpeed * dt;
          skeleton.velocity.x = (dx / distance) * moveSpeed;
          skeleton.velocity.z = (dz / distance) * moveSpeed;
          skeleton.rotation.x = Math.atan2(dx, dz);
        } else {
          skeleton.velocity.x = 0;
          skeleton.velocity.z = 0;
        }
      }

      skeleton.position.y = getIslandSurfaceY(island, skeleton.position.x, skeleton.position.z);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── WORLD EVENTS: THE GILDED WRECK ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The pacing audit's P1: a mean 7.5 crews still afloat at 360 s, because
  // between ring shrinks there is nothing in the Reach worth sailing toward.
  // Crews sit on their loot island, the ring nudges them inward, nobody meets.
  //
  // So: once per match a half-sunk ghost galleon rises AT THE ANNOUNCED NEXT
  // RING CENTRE — the one spot the whole lobby has to sail to anyway — carrying
  // chests worth banking and a powder store worth killing for. She is on the
  // chart for everyone at once (gold beacon), she is loud (feed line + bell),
  // and she is on a clock: the storm takes her back at the end of the phase.
  // Everybody arrives inside the same two minutes, in the same square kilometre,
  // holding something the other crews want.
  //
  // IMPLEMENTATION NOTE — why her loot is filed on an island:
  //   her chests and barrels are ordinary TreasureChest / IslandBarrel entities
  //   pushed onto the NEAREST island's arrays. That is not a hack of
  //   convenience: it means chest proximity, [X] prompts, carry/stow/sell, the
  //   barrel take-all, the client meshes, the 10 Hz chestSync and the treasure
  //   HUD all work on her with ZERO new machinery and zero new wire format. The
  //   chests come out `floating`, which is a first-class state (a foundered
  //   crew's cargo already uses it), so you swim them home exactly as you would
  //   any chest that went into the water.

  /** True once she has risen this match — she is a once-per-match event. */
  private wreckHasRisen = false;
  /** Arms one extra static-world snapshot on the next full tick (see tick()). */
  private worldResyncPending = false;

  /** Sim-time drive for the whole event: rise on schedule, die on schedule. */
  private updateWreckEvent() {
    const wreck = this.state.wreck ?? null;
    if (!wreck) {
      if (this.wreckHasRisen) return;
      // Dev/live-verification hook: PIRATES_WRECK_SEC=20 raises her twenty
      // seconds after the horn so a probe does not have to sail for four
      // minutes to look at her. Unset in every real match.
      const forcedAt = Number(process.env.PIRATES_WRECK_SEC ?? NaN);
      if (Number.isFinite(forcedAt)) {
        if (this.t >= forcedAt) this.raiseGildedWreck();
        return;
      }
      // The ring starting to MOVE is the cue, not the clock: the announced next
      // centre is real from that instant, and it is the moment the whole lobby
      // is told to go somewhere.
      const storm = this.state.storm;
      if (storm.phase < WRECK_EVENT.SPAWN_PHASE) return;
      if (storm.phase === WRECK_EVENT.SPAWN_PHASE && !storm.shrinking) return;
      this.raiseGildedWreck();
      return;
    }
    if (this.t >= wreck.claimAt) this.claimGildedWreck(wreck);
  }

  /** Dev/test hook: raise her right now, wherever the ring is pointing.
   *  window.__piratesBR is a client; this is the server-side twin the wreck
   *  suite and the live probe drive. */
  forceRaiseGildedWreck(): WreckEvent | null {
    if (this.state.wreck) return this.state.wreck;
    this.wreckHasRisen = false;
    this.raiseGildedWreck();
    return this.state.wreck ?? null;
  }

  private raiseGildedWreck() {
    const storm = this.state.storm;
    // The ANNOUNCED next centre — the ring the HUD is already drawing dashed.
    const site = this.findWreckWater(storm.nextCenterX, storm.nextCenterZ);
    // Lies across the ring's radius so her broken length reads broadside from
    // whichever way you come in off the wall.
    const rotation = angleWrap(Math.atan2(site.x - storm.centerX, site.z - storm.centerZ) + Math.PI * 0.5);

    const host = this.nearestIsland(site.x, site.z);
    if (!host) return;

    const { chests, barrels } = this.mapGen.buildWreckLoot(
      (this.tickCount * 2654435761) >>> 0, { x: site.x, y: 0, z: site.z }, rotation,
    );
    // THE PRIZE. Her ordinary chests are a buffet; this is the thing only one
    // crew can walk away with, and it is what turns "we all arrived" into "we
    // fought". Amidships on her canted deck, where you have to come aboard for
    // it rather than swim past and scoop it off the scatter.
    chests.unshift(this.buildGildedStrongbox(site, rotation));
    for (const chest of chests) host.chests.push(chest);
    for (const barrel of barrels) host.barrels.push(barrel);

    const wreck: WreckEvent = {
      id: `gilded-wreck-${this.state.tick}`,
      position: { x: site.x, y: 0, z: site.z },
      rotation,
      spawnedAt: this.t,
      claimAt: this.t + WRECK_EVENT.LOOT_SECONDS,
      hostIslandId: host.id,
      chestIds: chests.map((c) => c.id),
      barrelIds: barrels.map((b) => b.id),
    };
    this.state.wreck = wreck;
    this.wreckHasRisen = true;
    this.worldResyncPending = true;
    this.syncTreasureChests();

    // Bots inside LURE_RADIUS break off patrol and converge on her — and, once
    // they are alongside, heave to and send a boarding party over the side for
    // her chests. A prize nobody can pick up is scenery: the plunder list is
    // what makes the strongbox actually MOVE, which is what makes it contested.
    this.bots.setEventLure({
      x: site.x, z: site.z,
      radius: WRECK_EVENT.LURE_RADIUS,
      hostIslandId: host.id,
      chestIds: [...wreck.chestIds],
    });

    this.broadcast({
      type: 'wreck_event',
      ts: Date.now(),
      payload: { phase: 'risen', position: { ...wreck.position }, duration: WRECK_EVENT.LOOT_SECONDS },
    });
  }

  /** The Gilded Strongbox: one chest, amidships, worth more than every other
   *  thing aboard her combined. Only one crew leaves with it. */
  private buildGildedStrongbox(site: { x: number; z: number }, rotation: number): TreasureChest {
    // Just abaft the mainmast on her canted deck — inside the hull outline, so
    // you come ABOARD for it rather than scooping it off the scatter in passing.
    const fwd = { x: Math.sin(rotation), z: Math.cos(rotation) };
    const right = { x: Math.cos(rotation), z: -Math.sin(rotation) };
    const along = -WRECK_EVENT.HULL_HALF_LENGTH * 0.16;
    const across = WRECK_EVENT.HULL_HALF_BEAM * 0.22;
    return {
      id: WRECK_EVENT.STRONGBOX_ID,
      position: {
        x: site.x + fwd.x * along + right.x * across,
        y: 0.32,
        z: site.z + fwd.z * along + right.z * across,
      },
      opened: false,
      value: WRECK_EVENT.STRONGBOX_VALUE,
      carriedByPlayerId: null,
      storedOnShipId: null,
      floating: true,
      buried: false,
      digProgress: 1,
      mapOffsetX: 0,
      mapOffsetZ: 0,
      // Her captain's own store: shot for the guns and powder for the kegs.
      loot: [
        { item: 'cannonball', qty: 8 },
        { item: 'firebomb_ball', qty: 3 },
        { item: 'gold', qty: 180 },
      ],
    };
  }

  /** Which hull is carrying the Gilded Strongbox right now — stowed in her hold
   *  or in a boarding party's arms on the way back to her. Null when it is still
   *  on the wreck, in the water, already sold, or gone with the storm. */
  private strongboxHolderShipId(): string | null {
    const found = this.getChestById(WRECK_EVENT.STRONGBOX_ID);
    if (!found || found.chest.opened) return null;
    const chest = found.chest;
    if (chest.storedOnShipId) return chest.storedOnShipId;
    if (chest.carriedByPlayerId) {
      const carrier = this.getPlayer(chest.carriedByPlayerId);
      if (carrier && carrier.state !== 'eliminated' && carrier.shipId) return carrier.shipId;
    }
    return null;
  }

  private claimGildedWreck(wreck: WreckEvent) {
    const host = this.state.islands.find((island) => island.id === wreck.hostIslandId);
    if (host) {
      const chestIds = new Set(wreck.chestIds);
      const barrelIds = new Set(wreck.barrelIds);
      // Anything a crew actually got off her is THEIRS — carried, stowed, sold,
      // or simply dragged clear of the wreck. The storm only takes back what is
      // still lying on her when the sea closes over.
      const stillAboard = (x: number, z: number) =>
        dist2D(x, z, wreck.position.x, wreck.position.z) < WRECK_EVENT.HULL_HALF_LENGTH * 3.5;
      host.chests = host.chests.filter((chest) => {
        if (!chestIds.has(chest.id)) return true;
        if (chest.carriedByPlayerId || chest.storedOnShipId || chest.opened) return true;
        return !stillAboard(chest.position.x, chest.position.z);
      });
      host.barrels = host.barrels.filter((barrel) =>
        !barrelIds.has(barrel.id) || !stillAboard(barrel.position.x, barrel.position.z));
    }
    // A pirate mid-swim holding one of her chests keeps it; nobody is left
    // pointing at an entity that no longer exists.
    for (const player of this.state.players) {
      if (player.nearChestId && wreck.chestIds.includes(player.nearChestId)
        && !this.getChestById(player.nearChestId)) player.nearChestId = null;
      if (player.nearBarrelId && wreck.barrelIds.includes(player.nearBarrelId)) player.nearBarrelId = null;
    }

    this.state.wreck = null;
    this.worldResyncPending = true;
    this.bots.setEventLure(null);
    this.broadcast({
      type: 'wreck_event',
      ts: Date.now(),
      payload: { phase: 'claimed', position: { ...wreck.position }, duration: 0 },
    });
  }

  /** Nudge a ring centre off dry land. The early rings are big enough that
   *  StormSystem does not land-check them at all, so the announced centre can
   *  sit squarely on Old Maw Caldera — and a galleon aground on a volcano is
   *  not the read. Deterministic outward spiral; the ring centre itself is
   *  untouched, only the wreck moves. */
  private findWreckWater(x: number, z: number): { x: number; z: number } {
    // Not merely "not aground": she needs SEA ROOM. A wreck tucked against a
    // headland is a wreck half the fleet arrives at with the island between them
    // and her, and a beacon that reads as a lighthouse. This is the same
    // clearance a ship needs to fight in.
    const clearance = (px: number, pz: number) => {
      let worst = Infinity;
      for (const island of this.state.islands) {
        const d = dist2D(px, pz, island.position.x, island.position.z) - getIslandMaxRadius(island);
        if (d < worst) worst = d;
      }
      return worst;
    };
    // Sea room from the islands is not the whole of it: she is a HULL, and a
    // shoal inside her length has her rise straight through the rock. Worse,
    // her chests then lie inside a collider — a boarding party swimming to
    // them is (correctly) shoved back out, so her loot is unreachable and the
    // whole event is a decoration. Measured on ~1.7% of raises before this.
    const foulsShoal = (px: number, pz: number) => this.state.seaRocks.some((rock) =>
      dist2D(px, pz, rock.position.x, rock.position.z)
        < rock.colliderBoundsRadius + WRECK_EVENT.HULL_HALF_LENGTH + 8);
    const NEED = 80;
    if (clearance(x, z) >= NEED && !foulsShoal(x, z)) return { x, z };
    // Deterministic outward spiral, keeping the BEST water found so far so a
    // crowded corner of the Reach still gets the deepest spot in reach. Clean
    // water is tracked separately from merely-open water so that a fouled
    // berth is only ever the last resort.
    let best: { x: number; z: number; clear: number } | null =
      foulsShoal(x, z) ? null : { x, z, clear: clearance(x, z) };
    let fallback = { x, z, clear: clearance(x, z) };
    for (let ring = 1; ring <= 12; ring++) {
      const reach = ring * 28;
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * Math.PI * 2 + ring * 0.37;
        const px = clamp(x + Math.cos(angle) * reach, -WORLD.HALF + 90, WORLD.HALF - 90);
        const pz = clamp(z + Math.sin(angle) * reach, -WORLD.HALF + 90, WORLD.HALF - 90);
        const clear = clearance(px, pz);
        const fouled = foulsShoal(px, pz);
        if (clear >= NEED && !fouled) return { x: px, z: pz };
        if (!fouled && (!best || clear > best.clear)) best = { x: px, z: pz, clear };
        if (clear > fallback.clear) fallback = { x: px, z: pz, clear };
      }
    }
    return best ? { x: best.x, z: best.z } : { x: fallback.x, z: fallback.z };
  }

  private nearestIsland(x: number, z: number): Island | null {
    let best: Island | null = null;
    let bestDist = Infinity;
    for (const island of this.state.islands) {
      const d = dist2D(x, z, island.position.x, island.position.z);
      if (d < bestDist) { bestDist = d; best = island; }
    }
    return best;
  }

  private handleTradeAction(playerId: string, payload: TradeActionPayload) {
    let session = null;

    switch (payload.action) {
      case 'offer':
        session = this.trading.setOffer(
          payload.sessionId,
          playerId,
          payload.offer ?? [],
          this.state.tradeSessions,
          this.state.ships,
          this.state.players,
        );
        if (session) {
          this.broadcast({ type: 'trade_update', ts: Date.now(), payload: session });
        }
        break;
      case 'confirm':
        session = this.trading.confirmTrade(payload.sessionId, playerId, this.state.tradeSessions);
        if (session) {
          this.broadcast({ type: 'trade_update', ts: Date.now(), payload: session });
        }
        break;
      case 'cancel': {
        const event = this.trading.cancelTrade(payload.sessionId, playerId, this.state.tradeSessions);
        if (event) {
          this.broadcast({ type: 'trade_result', ts: Date.now(), payload: event });
        }
        break;
      }
    }
  }

  private updateRespawns(dt: number) {
    for (const player of this.state.players) {
      if (player.state !== 'respawning') continue;

      const homeShip = this.getAliveShip(player.shipId);
      if (!homeShip) {
        player.state = 'eliminated';
        this.recordElimination(player);
        this.applyEliminatedPlayerFields(player);
        if (player.isBot) {
          this.bots.removeBot(player.id);
        } else {
          const client = this.clients.get(player.id);
          if (client) {
            this.send(client.ws, {
              type: 'game_over',
              ts: Date.now(),
              // Waiting to respawn when the hull went out from under you: the one
              // elimination that genuinely IS the ship going down.
              payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold, cause: 'ship_sunk' },
            });
          }
        }
        this.respawnHoldSince.delete(player.id);
        continue;
      }

      if (!this.isShipInStormSafeZone(homeShip)) {
        // Home ship is outside the ring: HOLD the respawn (timer pauses)
        // instead of the old instant crew-wide elimination + force-sink.
        // The storm's hull punctures sink the ship (handled above via the
        // homeShip-gone branch) or the crew sails it back to safety.
        //
        // THAT IS ONLY HONEST WHILE SOMEONE CAN STILL SAIL HER, AND ONLY FOR AS
        // LONG AS THE CAP ALLOWS. With no living crewmate the hold is a promise
        // nobody is coming to keep; in the final storm it is a promise the world
        // cannot keep at all (a 12 m ring has no berth and no clear water, so the
        // tide had nowhere to tow her and the hold ran for minutes on end). Both
        // readings are answered by the same rule: the hold may last no longer
        // than RESPAWN_HOLD_MAX_SECONDS, and when it lifts the count is REAL —
        // aboard her if the tide could bring her in, ashore inside the ring
        // without her if it could not.
        let hold = this.respawnHoldSince.get(player.id);
        if (!hold) {
          hold = { since: this.t, resolved: false };
          this.respawnHoldSince.set(player.id, hold);
        }
        const heldFor = this.t - hold.since;
        if (heldFor >= RESPAWN_HOLD_GRACE_SECONDS && !this.hasSailorForHull(homeShip, player)) {
          // The tide takes an abandoned hull in — when there is anywhere to take
          // her. This runs whether or not the respawn is still being held: a
          // derelict left outside the wall founders, and THAT eliminates her
          // whole crew. Failure is no longer terminal; the cap resolves anyway.
          this.towDerelictToSafety(homeShip);
        }
        if (!hold.resolved) {
          if (
            this.canHoldRespawnFor(homeShip)
            && heldFor < RESPAWN_HOLD_MAX_SECONDS
            && !this.isShipInStormSafeZone(homeShip)
          ) {
            continue;
          }
          // Past the cap, or never holdable at all (terminal storm, foundering
          // hull): the countdown becomes real. getRespawnPlan puts him somewhere
          // inside the CURRENT safe radius whatever became of his ship.
          //
          // THE WAIT ALREADY SERVED COUNTS — credited exactly once, on the tick
          // the hold lifts. Re-crediting every tick pinned the timer just above
          // its floor forever: a second, quieter version of the same hang.
          hold.resolved = true;
          player.respawnTimer = Math.max(
            1.5,
            Math.min(player.respawnTimer, PLAYER.RESPAWN_TIME - heldFor),
          );
        }
      }

      player.respawnTimer -= dt;
      if (player.respawnTimer > 0) continue;

      const respawnPlan = this.getRespawnPlan(homeShip, player);
      // The berth moves the whole hull, so her deck point can only be read AFTER
      // she is alongside — reading it first put a respawning pirate at the spot
      // the ship used to be lying.
      if (respawnPlan.dock) {
        this.parkShipAtDock(homeShip, respawnPlan.dock);
      }
      player.state = 'alive';
      player.health = PLAYER.RESPAWN_HEALTH;
      player.onShipId = respawnPlan.onShipId;
      player.position = respawnPlan.dock
        ? this.getRespawnDeckPosition(homeShip)
        : respawnPlan.position;
      player.velocity = { x: 0, y: 0, z: 0 };
      player.knockbackVelocity = { x: 0, y: 0, z: 0 };
      this.clearStationFlags(player);
      player.nearChestId = null;
      player.nearShipId = null;
      player.lastDamagedById = null;
      player.lastDamagedAt = null;
      player.lastDamageWasHeadshot = false;
      // A new life carries no wound: the last death's cause must not name the next one.
      this.lastDamageSourceById.delete(player.id);
      player.respawnTimer = 0;
      player.swimTimer = 0;
      player.cannonFlightTimer = 0;
      player.cannonBallistic = false;
      player.blocking = false;
      player.cutlassCharge = 0;
      player.respawnProtectionTimer = respawnPlan.protectionTime;
      player.shipBoundaryGraceTimer = 0;
      this.respawnHoldSince.delete(player.id);
      if (!homeShip.crewIds.includes(player.id)) {
        homeShip.crewIds.push(player.id);
      }
      this.grantStormRespawnGrace(player);
      this.broadcast({
        type: 'player_spawned',
        ts: Date.now(),
        payload: {
          playerId: player.id,
          shipId: homeShip.id,
          // The HUD runs the reprieve chip off this (a local clock, so it costs
          // the snapshot nothing) and names the beach when the hull was lost.
          stormGrace: STORM_RESPAWN_GRACE_SECONDS,
          ashore: respawnPlan.ashore,
        },
      });
    }
  }

  /**
   * THE FIRST TIME A CREW GETS UNDER WAY, THE YARD IS ALREADY TRIMMED.
   *
   * A fresh berth hands you a hull with the yard SQUARE, and square on any reach
   * catches almost none of the wind: PhysicsSystem's floor (0.16 of the polar) is
   * every drop of speed a new captain ever saw. The objective says "hold W to get
   * under way", so he holds W, the canvas comes down, the ship makes 0.3 u/s and
   * then decays — and the only thing on screen that could have told him why was a
   * trim clause in a side panel he had no reason to read. Bots have auto-trimmed
   * since the day they were written; the human was the only sailor in the world
   * expected to know about the brace keys before his first metre.
   *
   * So the anchor coming up hands the crew a working trim: FIRST_SAIL_ASSIST
   * .TRIM_FRACTION of the wind-optimal yard angle (≈93% catch, not 100% — there
   * is still a better trim to find) and enough canvas out to move. ONCE per hull:
   * after that the yard is the crew's business, and a captain who deliberately
   * squares up to slow down keeps what he set.
   *
   * It only ever ADDS canvas. Shortening sail is a real order — a hull creeping
   * into a berth under reefed sails must not be given full main by a helper.
   */
  private applyFirstSailAssist(ship: Ship): void {
    if (this.firstSailAssisted.has(ship.id)) return;
    this.firstSailAssisted.add(ship.id);
    const wind = sampleLocalWind(this.t, ship.position.x, ship.position.z, this.state.storm);
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    // 0.92 is PhysicsSystem's own desired-trim constant — the same optimum the
    // HUD's Catch% is measured against, so this reads as a high number there.
    const optimal = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
    ship.sailAngle = clamp(
      optimal * FIRST_SAIL_ASSIST.TRIM_FRACTION,
      -SHIP.MAX_SAIL_ANGLE,
      SHIP.MAX_SAIL_ANGLE,
    );
    ship.sailHeight = Math.max(
      ship.sailHeight,
      Math.min(clamp(ship.sailIntegrity, 0, 1), FIRST_SAIL_ASSIST.MIN_SAIL_HEIGHT),
    );
  }

  private getNearbyCannonIndex(player: Player, ship: Ship): number | null {
    return findSharedNearbyCannonIndex(player, ship);
  }

  private isNearHelm(player: Player, ship: Ship): boolean {
    return isSharedNearHelm(player, ship);
  }

  private isNearSailStation(player: Player, ship: Ship): boolean {
    return isSharedNearSailStation(player, ship);
  }

  private isNearAnchor(player: Player, ship: Ship): boolean {
    return isSharedNearAnchor(player, ship);
  }

  private snapPlayerToHelm(player: Player, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const local = getHelmControlLocal(stats);
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    player.position.x = ship.position.x + local.x * cos + local.z * sin;
    player.position.z = ship.position.z + local.z * cos - local.x * sin;
    // Stand ON the raised quarterdeck dais, not sunk into it.
    player.position.y = getShipDeckY(ship.position.y, stats) + getShipDeckRaiseAt(local, stats);
  }

  private isNearCrowNestLadder(player: Player, ship: Ship): boolean {
    return isSharedNearCrowNestLadder(player, ship);
  }

  /** The specific breach this pirate can plank right now — server truth. The
   *  client prompt calls the same shared findRepairableHole, so [X] can never
   *  offer a patch the server then refuses. Planks are NOT required to see the
   *  breach (the prompt reads "no planks ready"); the callers gate on stock. */
  private getRepairableHole(player: Player, ship: Ship): ShipHole | null {
    return findRepairableHole(player.position, ship);
  }

  /** Spring waterline planks all round a foundering hull until she reads as a
   *  wreck (at least 8 open breaches, spread across every face).
   *
   *  These are stamped with source 'scuttle', NOT 'cannon'. They are pure
   *  cosmetics on a hull that has ALREADY lost — tagging them as gunnery put
   *  eight phantom cannon breaches into every audit that reads hole sources
   *  (combat pacing, bot aggression, weapon tuning) for every ship that ever
   *  went down, including ones the storm or a reef killed. */
  private riddleWreck(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const faces: Array<{ x: number; z: number }> = [
      { x: stats.width, z: 0 }, { x: -stats.width, z: 0 },
      { x: 0, z: stats.length }, { x: 0, z: -stats.length },
    ];
    for (let i = 0; countOpenHoles(ship) < 8 && i < 16; i += 1) {
      const face = faces[i % faces.length];
      const point = this.physics.hullFacePoint(
        ship, face, FLOODING.HOLE_BAND_Y.min + (i % 3) * 0.12, stats.length * 0.6,
      );
      this.physics.openHoleAt(ship, point, 1, 'scuttle');
    }
  }

  private consumeRepairPlank(player: Player, ship: Ship): boolean {
    if (player.pocketWood > 0) {
      player.pocketWood -= 1;
      return true;
    }
    return this.consumeShipItem(ship, 'wood_plank', 1);
  }

  /** Upgrade-station materials pool: your pocket plus the ship's stores
   *  ('wood' rides the same wood_plank stack hull repair draws from). */
  private getMaterialCount(player: Player, ship: Ship, material: 'wood' | 'ore'): number {
    const item = material === 'wood' ? 'wood_plank' : 'ore';
    const shipStock = ship.inventory.find(entry => entry.item === item)?.qty ?? 0;
    return (material === 'wood' ? player.pocketWood : player.pocketOre) + shipStock;
  }

  /** Spend pocket first, then the ship stack — mirrors consumeRepairPlank.
   *  All-or-nothing: callers gate on getMaterialCount before consuming. */
  private consumeMaterial(player: Player, ship: Ship, material: 'wood' | 'ore', qty: number): boolean {
    if (this.getMaterialCount(player, ship, material) < qty) return false;
    const pocket = material === 'wood' ? player.pocketWood : player.pocketOre;
    const fromPocket = Math.min(pocket, qty);
    if (material === 'wood') player.pocketWood -= fromPocket;
    else player.pocketOre -= fromPocket;
    const fromShip = qty - fromPocket;
    return fromShip <= 0 || this.consumeShipItem(ship, material === 'wood' ? 'wood_plank' : 'ore', fromShip);
  }

  private consumeShipItem(ship: Ship, item: string, qty: number): boolean {
    const stack = ship.inventory.find(entry => entry.item === item && entry.qty >= qty);
    if (!stack) return false;
    stack.qty -= qty;
    if (stack.qty <= 0) {
      ship.inventory = ship.inventory.filter(entry => entry !== stack);
    }
    return true;
  }

  private snapPlayerToCannon(player: Player, ship: Ship, cannonIndex: number) {
    const local = this.getCannonDeckPosition(ship, cannonIndex);
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    player.position.x = ship.position.x + local.x * cos + local.z * sin;
    player.position.z = ship.position.z + local.z * cos - local.x * sin;
    player.position.y = getShipDeckY(ship.position.y, SHIP_STATS[ship.type]);
  }

  private getCannonDeckPosition(ship: Ship, cannonIndex: number): { x: number; z: number } {
    return getSharedCannonDeckLocalPosition(SHIP_STATS[ship.type], cannonIndex);
  }

  private getRespawnDeckPosition(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const local = {
      x: 0,
      z: -stats.length * 0.12,
    };
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return {
      x: ship.position.x + local.x * cos + local.z * sin,
      y: ship.position.y + stats.height + 0.18,
      z: ship.position.z + local.z * cos - local.x * sin,
    };
  }

  /**
   * WHERE A PIRATE COMES BACK — ALWAYS INSIDE THE CURRENT SAFE RADIUS.
   *
   * The deck of his own hull whenever she is in shelter, which is the ordinary
   * case and unchanged. When she is NOT — the hold has hit its cap and the tide
   * could not bring her in — respawning onto her would put him straight back in
   * the weather that just killed him, which is the death carousel the audit
   * measured: ring arrives, dies in six seconds, respawns inside it, dies again.
   * So the fallbacks walk inward: an unoccupied berth inside the ring (she comes
   * with him), then dry ground inside it, then the water at the storm's centre.
   * The last one always exists, so this can never fail to place him.
   */
  private getRespawnPlan(homeShip: Ship, player?: Player) {
    if (this.isShipInStormSafeZone(homeShip)) {
      return {
        position: this.getRespawnDeckPosition(homeShip),
        onShipId: homeShip.id as string | null,
        protectionTime: PLAYER.RESPAWN_PROTECTION_TIME + 1.5,
        dock: null as IslandDock | null,
        ashore: false,
      };
    }
    // Nobody alive aboard her: the berth takes the whole ship, so the crew keeps
    // its hull. (parkShipAtDock runs in the caller, as the dock path always has.)
    const dock = player && !this.hasSailorForHull(homeShip, player)
      ? this.pickSafeSpawnDock()
      : null;
    if (dock) {
      return {
        position: this.getRespawnDeckPosition(homeShip),
        onShipId: homeShip.id as string | null,
        protectionTime: PLAYER.RESPAWN_PROTECTION_TIME + 1.5,
        dock: dock as IslandDock | null,
        ashore: false,
      };
    }
    return {
      position: this.findSafeGroundInsideRing(),
      onShipId: null as string | null,
      // A pirate washed ashore without his ship has further to walk before he
      // can defend himself — the same protection the deck spawn gets, and the
      // storm grace on top of it (see grantStormRespawnGrace).
      protectionTime: PLAYER.RESPAWN_PROTECTION_TIME + 1.5,
      dock: null as IslandDock | null,
      ashore: true,
    };
  }

  /**
   * Dry ground — or failing that water — comfortably inside the storm wall.
   *
   * Hunted in the order a marooned pirate would want it: a pier he can walk off,
   * then a beach or low hillside, then the open water at the ring's centre. Never
   * a cliff face (the walk branch would slide him off) and never outside the
   * wall, so the answer is somewhere he can survive standing still.
   */
  private findSafeGroundInsideRing(): Vec3 {
    const { centerX, centerZ, safeRadius } = this.state.storm;
    const inner = Math.max(4, safeRadius - 8);

    let bestPier: { point: Vec3; d: number } | null = null;
    for (const island of this.state.islands) {
      const dock = island.dock;
      if (!dock) continue;
      const d = dist2D(dock.respawnPoint.x, dock.respawnPoint.z, centerX, centerZ);
      if (d > inner) continue;
      if (!bestPier || d < bestPier.d) {
        bestPier = { point: { x: dock.respawnPoint.x, y: dock.respawnPoint.y + 0.2, z: dock.respawnPoint.z }, d };
      }
    }
    if (bestPier) return bestPier.point;

    // Sampled on a polar grid inside the wall. A beach or low flank wins
    // outright; anything else above the waterline is kept as the runner-up, so a
    // ring that closed on a volcano still puts him on rock rather than in it.
    let highGround: Vec3 | null = null;
    for (const reach of [0.55, 0.8, 0.3, 0.95]) {
      for (let step = 0; step < 12; step++) {
        const angle = (step / 12) * Math.PI * 2 + reach;
        const x = centerX + Math.cos(angle) * inner * reach;
        const z = centerZ + Math.sin(angle) * inner * reach;
        for (const island of this.state.islands) {
          const y = getIslandSurfaceY(island, x, z);
          if (y > 0.6 && y < 9) return { x, y: y + 0.25, z };
          if (y > 0.6 && (!highGround || y < highGround.y)) highGround = { x, y: y + 0.25, z };
        }
      }
    }
    if (highGround) return highGround;
    // The water at the eye of the storm. Swimming is a survivable state and the
    // ring is centred on it, so this always exists — but the eye can itself be
    // dry (the late rings converge on Old Maw Caldera), and dropping a pirate at
    // wave height inside a caldera floor would spawn him embedded in rock.
    let eyeY = 0.4;
    for (const island of this.state.islands) {
      const y = getIslandSurfaceY(island, centerX, centerZ);
      if (y + 0.25 > eyeY) eyeY = y + 0.25;
    }
    return { x: centerX, y: eyeY, z: centerZ };
  }

  /**
   * MAY A RESPAWN BE HELD ON THIS HULL AT ALL?
   *
   * The hold says "the count resumes when your hull is back inside the ring". It
   * is only worth saying while that CAN happen — by crew (a living hand sails her
   * in) or by tide (towDerelictToSafety brings a derelict in after the grace).
   *
   * In the FINAL storm neither can: the last ring is 12 m across, so no berth
   * clears pickSafeSpawnDock's margin and no patch of water clears a hull's
   * length, and the endgame circle converges on Old Maw Caldera besides. The
   * sentence became a promise the world could not keep, and a fresh-eyes audit
   * read it on a grey screen for four minutes and then died of it. A hull already
   * going down cannot come back either.
   *
   * So in those states there is no hold: the ordinary countdown runs at once and
   * getRespawnPlan lands the pirate inside the ring without her.
   */
  private canHoldRespawnFor(ship: Ship): boolean {
    if (this.state.storm.phase >= STORM_PHASES.length) return false;
    return ship.alive && !ship.sinking;
  }

  /**
   * FIFTEEN SECONDS OF WEATHER, HANDED BACK.
   *
   * The carousel the audit rode: the ring crossed his spawn dock, billed him to
   * death six seconds after it arrived, put him back on the same deck inside the
   * same wall, and did it again — three deaths in three minutes, none of them
   * fightable. A fresh life inside the tempest needs long enough to weigh anchor
   * and bear away, so the storm stands down for exactly that long.
   */
  private grantStormRespawnGrace(player: Player): void {
    this.stormGraceUntil.set(player.id, this.t + STORM_RESPAWN_GRACE_SECONDS);
  }

  /** True while the tempest may not bill this pirate (post-respawn reprieve). */
  private hasStormGrace(playerId: string): boolean {
    const until = this.stormGraceUntil.get(playerId);
    if (until === undefined) return false;
    if (this.t >= until) {
      this.stormGraceUntil.delete(playerId);
      return false;
    }
    return true;
  }

  /** Is anyone still able to sail this hull back inside the ring? A mate who is
   *  merely DOWNED counts — he can be picked up. A mate who is himself waiting
   *  on the same held respawn does not: two dead men cannot rescue each other,
   *  which is exactly the deadlock this answers. Anyone standing on her deck
   *  counts too, even an enemy: a boarded hull is somebody's problem, and the
   *  tide does not move a ship out from under a living pirate. */
  private hasSailorForHull(ship: Ship, exclude: Player): boolean {
    for (const other of this.state.players) {
      if (other.id === exclude.id) continue;
      if (other.state === 'eliminated' || other.state === 'respawning') continue;
      if (other.health <= 0) continue;
      if (other.shipId === ship.id || other.onShipId === ship.id) return true;
    }
    return false;
  }

  /**
   * THE TIDE TAKES AN ABANDONED HULL IN.
   *
   * A derelict — nobody alive aboard, nobody alive who calls her home — lying
   * outside the ring is a two-to-three minute black screen for the pirate whose
   * respawn she holds, ending in an elimination he could not have prevented.
   * So she is warped to shelter: an unoccupied in-ring berth if there is one,
   * otherwise open water well inside the wall. She comes in seaworthy (the same
   * refit any dock respawn gets) and she comes in ANCHORED — the crew gets
   * their ship back where they can reach it, not a free escape from a fight.
   *
   * Returns false when there is nowhere safe to put her; the hold simply
   * continues and we try again next tick.
   */
  private towDerelictToSafety(ship: Ship): boolean {
    if (!ship.alive || ship.sinking) return false;
    const dock = this.pickSafeSpawnDock();
    if (dock) {
      this.parkShipAtDock(ship, dock);
      return true;
    }
    const berth = this.findOpenWaterInsideRing(ship);
    if (!berth) return false;
    ship.position.x = berth.x;
    ship.position.z = berth.z;
    ship.position.y = 0.05;
    ship.rotation = Math.atan2(
      this.state.storm.centerX - berth.x,
      this.state.storm.centerZ - berth.z,
    );
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.angularVelocity = 0;
    ship.anchored = true;
    ship.anchorRaiseProgress = 0;
    ship.sailHeight = 0;
    ship.sailAngle = 0;
    ship.onFire = false;
    ship.fireTimer = 0;
    ship.fireDamageAccum = 0;
    ship.sailIntegrity = 1;
    ship.holes = [];
    ship.nextHoleId = 1;
    ship.waterLevel = 0;
    return true;
  }

  /** A clear patch of water comfortably inside the ring, hunted along the line
   *  from the derelict toward the storm centre (she is towed IN, not teleported
   *  across the map) and then around it. Null when the ring is all land. */
  private findOpenWaterInsideRing(ship: Ship): { x: number; z: number } | null {
    const { centerX, centerZ, safeRadius } = this.state.storm;
    const dx = ship.position.x - centerX;
    const dz = ship.position.z - centerZ;
    const bearing = Math.atan2(dx, dz);
    const stats = SHIP_STATS[ship.type];
    const clearance = stats.length * 0.6 + 12;
    for (const reach of [0.62, 0.45, 0.28, 0.1]) {
      for (const sweep of [0, 0.5, -0.5, 1.1, -1.1, 2.0, -2.0, Math.PI]) {
        const angle = bearing + sweep;
        const x = centerX + Math.sin(angle) * safeRadius * reach;
        const z = centerZ + Math.cos(angle) * safeRadius * reach;
        let clear = true;
        for (const island of this.state.islands) {
          if (dist2D(x, z, island.position.x, island.position.z) < getIslandMaxRadius(island) + clearance) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        for (const rock of this.state.seaRocks) {
          if (dist2D(x, z, rock.position.x, rock.position.z) < (rock.radius ?? 8) + clearance) {
            clear = false;
            break;
          }
        }
        if (clear) return { x, z };
      }
    }
    return null;
  }

  private parkShipAtDock(ship: Ship, dock: IslandDock) {
    // Normalized berth, computed for THIS ship: parallel to the dock, bow
    // seaward, a consistent 1m gap between hull side and dock edge, and the hull
    // laid ALONGSIDE the dock's seaward run (stern always inside the dock span,
    // so the ship is boardable from the deck). Depth is verified per ship type;
    // the pre-baked galleon berth stays as the last-resort fallback.
    const berth = this.computeShipBerth(ship, dock) ?? dock.berthPosition;
    ship.position.x = berth.x;
    ship.position.z = berth.z;
    ship.position.y = 0.05;
    ship.rotation = dock.berthRotation;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.angularVelocity = 0;
    ship.anchored = true;
    ship.anchorRaiseProgress = 0;
    ship.sailHeight = 0;
    ship.sailAngle = 0;
    ship.onFire = false;
    ship.fireTimer = 0;
    ship.fireDamageAccum = 0;
    ship.chainshottedUntil = 0;
    ship.sailIntegrity = 1;
    ship.sailRepairWoodTimer = 0;
    ship.sinking = false;
    ship.sinkProgress = 0;
    ship.repairCooldown = 0;
    ship.autoRepairProgress = 0;
    // A reset/respawned ship is seaworthy again — fresh planking, no breaches
    // at all (any open hole would keep flooding her under the hole model).
    ship.holes = [];
    ship.nextHoleId = 1;
    ship.waterLevel = 0;
  }

  /** Depth-verified side-berth for THIS ship type, in the canonical dock frame
   *  (world = dock.position + Ry(θ)·local, +local-z SEAWARD, dock.position is the
   *  MIDDLE of a deck that spans ±length/2).
   *
   *  Along-dock anchor: the hull is centred on the dock's SEAWARD HALF with its
   *  bow tucked one hull-margin inside the tip, so every ship type — sloop, brig,
   *  galleon — lies fully ALONGSIDE the dock run at the same relative spot
   *  instead of drifting off the end. (The old formula measured a shore-frame
   *  offset from the dock CENTRE: 80% of sloop berths had zero hull-alongside
   *  overlap and some sat 24-38m past the tip.)
   *
   *  Lateral: hull side to dock edge is a fixed BERTH_RAIL_GAP.
   *  Depth: the keel must clear the seabed at the same three centreline stations
   *  grounding uses (±0.44·length, mid). If the canonical anchor is too shallow
   *  the berth shifts along the dock by the SMALLEST amount that floats — never
   *  more than BERTH_SEARCH_REACH, so a ship can never end up parked in open
   *  water tens of metres off the pier. Returns null only when even the deepest
   *  spot in reach would leave the hull sitting on dry ground. */
  private computeShipBerth(ship: Ship, dock: IslandDock): { x: number; z: number } | null {
    const island = this.state.islands.find((isl) => isl.dock === dock);
    if (!island) return null;
    const stats = SHIP_STATS[ship.type];
    const fwd = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
    const right = { x: Math.cos(dock.rotation), z: -Math.sin(dock.rotation) };
    const half = stats.length * 0.5;
    const lateral = dock.width * 0.5 + stats.width * 0.5 + BERTH_RAIL_GAP;
    // Depth requirement measured off the RENDERED keel (SHIP.HULL_DRAFT_F — the
    // draft grounding and swim-hull collision use) plus the grounding safety bite
    // and a wave-bob margin. The old conservative KEEL_DRAFT_RATIO figure demanded
    // ~0.7m more water than the hull actually needs, which is a big part of why
    // berths slid off the end of shallow-shelf docks.
    const draft = stats.height * SHIP.HULL_DRAFT_F[ship.type];
    const needDepth = -(draft + SHIP.GROUND_KEEL_SAFETY + BERTH_BOB_MARGIN);
    // Sample where PhysicsSystem's HULL_CONTACT_STATIONS do, so "floats here"
    // means exactly the same thing to the berth planner and to grounding.
    const stations = [stats.length * 0.44, 0, -stats.length * 0.44];
    // Bow tucked just inside the seaward tip; clamped to 0 (hull centred on the
    // dock) when the hull is longer than the dock's seaward half.
    const tip = dock.length * 0.5;
    const alongStart = Math.max(0, tip - half - BERTH_BOW_INSET);

    let fallback: { x: number; z: number; shallowest: number } | null = null;
    // Search outward from that anchor for the SMALLEST displacement that floats,
    // seaward first. Shoreward candidates matter: a couple of docks (the atoll)
    // run out onto a reef, so their deep water is on the INSIDE — the old
    // seaward-only slide gave up there and fell back to a berth ~40m off the tip.
    for (const shift of berthShiftLadder(dock.length)) {
      for (const side of [dock.moorSide, -dock.moorSide]) {
        const along = alongStart + shift;
        const cx = dock.position.x + fwd.x * along + right.x * side * lateral;
        const cz = dock.position.z + fwd.z * along + right.z * side * lateral;
        let shallowest = -Infinity;
        for (const offset of stations) {
          const y = getIslandSurfaceY(island, cx + fwd.x * offset, cz + fwd.z * offset);
          if (y > shallowest) shallowest = y;
        }
        if (shallowest < needDepth) return { x: cx, z: cz };
        // Best effort for docks with no floating berth in reach (reef mouths):
        // the wettest spot alongside beats a "perfect" one out at sea.
        if (!fallback || shallowest < fallback.shallowest) {
          fallback = { x: cx, z: cz, shallowest };
        }
      }
    }
    if (fallback && fallback.shallowest < -BERTH_MIN_WATER) {
      return { x: fallback.x, z: fallback.z };
    }
    return null;
  }

  private armShipExitGrace(player: Player, ship: Ship, input: PlayerInput) {
    if (!input.jumpPressed || player.atHelm || player.atCannon || player.atCrowNest || player.onShipId !== ship.id) return;

    const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    if (moveX === 0 && moveZ === 0) return;

    const local = this.toShipLocal(player.position, ship);
    const stats = SHIP_STATS[ship.type];
    const nearSideRail = Math.abs(local.x) > stats.width * 0.35;
    const nearEndRail = Math.abs(local.z) > stats.length * 0.36;
    if (!nearSideRail && !nearEndRail) return;

    const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
    const nx = moveX / len;
    const nz = moveZ / len;
    const cosY = Math.cos(input.yaw);
    const sinY = Math.sin(input.yaw);
    // Must match the on-foot movement basis in applyInput exactly, or strafing
    // toward a rail reads as strafing away and the exit grace never arms.
    const worldMoveX = (sinY * nz - cosY * nx);
    const worldMoveZ = (cosY * nz + sinY * nx);

    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    const localMoveX = worldMoveX * cos - worldMoveZ * sin;
    const localMoveZ = worldMoveX * sin + worldMoveZ * cos;
    const movingOutPortStarboard = nearSideRail
      && Math.sign(localMoveX) === Math.sign(local.x)
      && Math.abs(localMoveX) > 0.25;
    const movingOutBowStern = nearEndRail
      && Math.sign(localMoveZ) === Math.sign(local.z)
      && Math.abs(localMoveZ) > 0.25;

    if (movingOutPortStarboard || movingOutBowStern) {
      player.shipBoundaryGraceTimer = PLAYER.SHIP_EXIT_GRACE_TIME;
    }
  }

  private toShipLocal(position: { x: number; z: number }, ship: Ship): { x: number; z: number } {
    return toShipLocalPoint(position, ship);
  }

  private toShipWorld(x: number, z: number, ship: Ship): { x: number; z: number } {
    return toShipWorldPoint({ x, z }, ship);
  }

}

