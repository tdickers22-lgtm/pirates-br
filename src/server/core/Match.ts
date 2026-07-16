import { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type {
  GameState, InteractIntent, Island, IslandDock, IslandNpc, Player, Projectile, SeaRock, Ship, ShipKeg, ShipUpgrade, TreasureChest, Vec3, WeaponId, NetMsg, PlayerInput, TradeActionPayload, Shark, WildlifeAnimal, WildlifeType, EquippableTool,
} from '../../shared/types/index.js';
import { SERVER_TICK_MS, SNAPSHOT_RATE, FULL_SNAPSHOT_TICKS, DBNO, ECONOMY, PLAYER, POCKET, SHIP, SHARK, SHIP_STATS, WEAPONS, WORLD, WILDLIFE, FLOODING } from '../../shared/constants/index.js';
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
  getIslandSurfacePoint,
  getIslandSurfaceY,
  isPointInsideIslandFootprint,
  dockLocalToWorld,
  randRange,
  randAngle,
  dist2D,
  angleWrap,
  clamp,
  getMainMastLocalZ,
  getCrowNestStandingY,
  getShipCompanionwayConfig,
  getShipDeckRaiseAt,
  gerstnerHeight,
  WAVE_PARAMS,
  intersectRaySeaRock,
} from '../../shared/utils/index.js';
import { intersectRayShipHull, raymarchIslandSurface } from '../../shared/raycast.js';
import {
  findNearbyCannonIndex as findSharedNearbyCannonIndex,
  getCannonDeckLocalPosition as getSharedCannonDeckLocalPosition,
  getSailControlLocal as getSharedSailControlLocal,
  isNearAnchor as isSharedNearAnchor,
  isNearCrowNestLadder as isSharedNearCrowNestLadder,
  isNearHelm as isSharedNearHelm,
  isNearSailStation as isSharedNearSailStation,
  findBraceStationDir,
  toShipLocalPoint,
  toShipWorldPoint,
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
  | 'bail';

interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  name: string;
  lastInput: PlayerInput | null;
  lastPing: number;
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
  /** Latest full snapshot skipped while the socket was congested — flushed
   *  (newest only, older ones dropped) once the buffer drains. */
  pendingFullSnapshot: string | null;
  /** Latest hot snapshot skipped while congested (superseded by any newer send). */
  pendingHotSnapshot: string | null;
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
}

export interface MatchEndResult {
  matchId: string;
  winnerId: string | null;
  winnerName: string | null;
  reason: 'gold' | 'last_ship' | 'abandoned';
  humans: MatchHumanResult[];
}

export interface MatchOptions {
  matchId: string;
  botCount: number;
  /** Names of human players who will join — used so bots get distinct identities. */
  reservedHumanNames?: string[];
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
const CUTLASS_CHARGE_TIME = 0.72;
const CUTLASS_CHARGE_MIN_TAP = 0.02;
const CUTLASS_LUNGE_COOLDOWN = 1.05;
const CUTLASS_LUNGE_DAMAGE = 50;
const CUTLASS_LUNGE_IMPULSE = 32;
/** Kill credit for prior damage expires after this long (storm/drown deaths). */
const KILL_CREDIT_WINDOW_SECONDS = 90;
/** Catch-up steps per timer callback — bounds the death spiral after a stall. */
const MAX_CATCHUP_TICKS = 5;
/** Minimum sim-time interval between accepted one-shot actions (anti-spam). */
const ONE_SHOT_MIN_INTERVAL: Partial<Record<OneShotAction, number>> = {
  interact: 0.2,
  wheel: 0.15,
  trade: 0.3,
  barrelTakeAll: 0.3,
};
const VALID_INTERACT_INTENTS: ReadonlySet<InteractIntent> = new Set<InteractIntent>([
  'barrel', 'chest', 'board', 'dock', 'mermaid', 'keg_diffuse', 'upgrade',
  'gold_hoarder', 'stow_chest', 'helm', 'sails', 'brace',
  'crow', 'anchor', 'repair', 'bail', 'revive', 'cannon',
]);

export class Match {
  readonly id: string;
  private clients: Map<string, ConnectedClient> = new Map();
  private playersById = new Map<string, Player>();
  private shipsById = new Map<string, Ship>();
  private state!: GameState;
  private t = 0;
  private tickCount = 0;
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
  /** Order of elimination — earliest first. Used for placement on match end. */
  private eliminationOrder: string[] = [];

  /** Called once when the match definitively ends (winner found, last ship, or abandoned). */
  onMatchEnd: ((result: MatchEndResult) => void) | null = null;
  /** Called when an in-match client's WebSocket closes — lobby uses this to clean its session. */
  onClientDisconnect: ((playerId: string) => void) | null = null;

  // Systems
  private physics = new PhysicsSystem();
  private weapons = new WeaponSystem();
  private storm = new StormSystem();
  private islands = new IslandSystem();
  private trading = new TradingSystem();
  private bots = new BotSystem();
  /** Dev-only (solo): when true, bots ignore human players + their ships. */
  private botPeace = false;
  private mapGen = new MapGenerator();
  private skeletonHomes: Map<string, string> = new Map();
  private skeletonWaveTimers: Map<string, number> = new Map();
  private skeletonSpawnedAt: Map<string, number> = new Map();
  private skeletonDefeatedAt: Map<string, number> = new Map();
  private cutlassChargeByPlayer = new Map<string, number>();
  private cutlassFireHeldByPlayer = new Map<string, boolean>();
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

  constructor(opts: MatchOptions) {
    this.id = opts.matchId;
    this.configuredBotCount = opts.botCount;
    this.setupWorld(opts.botCount);
  }

  start(): void {
    if (this.tickInterval) return;
    this.state.phase = 'playing';
    this.lastTickWallMs = performance.now();
    this.tickBacklogSec = 0;
    this.tickInterval = setInterval(() => this.runTicks(), SERVER_TICK_MS);
    console.log(`[Match ${this.id}] started — bots: ${this.configuredBotCount}`);
  }

  /**
   * Fixed-step sim driven by a wall-clock accumulator. setInterval fires late
   * under load, so we run enough fixed-dt steps per callback for sim time to
   * track wall time, capped at MAX_CATCHUP_TICKS to avoid a death spiral.
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
      this.tickBacklogSec = step * MAX_CATCHUP_TICKS;
    }
  }

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
    const seaRocks = this.mapGen.generateSeaRocks(islandList, spawns);

    const ships: Ship[] = [];
    const players: Player[] = [];

    // Create bot ships
    for (let i = 0; i < Math.min(botCount, spawns.length); i++) {
      const spawn = spawns[i];
      const botId = uuid();
      const shipId = uuid();
      const ship = this.mapGen.buildShip(shipId, botId, spawn, TEAM_COLORS[i % TEAM_COLORS.length]);
      ships.push(ship);

      const bot = this.createPlayer(botId, `Pirate_${i + 1}`, shipId, true);
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
      swimTimer: 0,
      atCannon: false,
      atHelm: false,
      atSails: false,
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
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null;
  }

  private getNextTeamColor() {
    const usedColors = new Set(this.state.ships.map((ship) => ship.teamColor));
    return TEAM_COLORS.find((color) => !usedColors.has(color))
      ?? TEAM_COLORS[this.state.ships.length % TEAM_COLORS.length];
  }

  /**
   * Add a human to this match. Lobby owns the WebSocket lifecycle (message routing,
   * close handler) — it MUST call removeClient(playerId) on disconnect or detach.
   */
  addHumanClient(ws: WebSocket, name: string): { playerId: string; shipId: string; snapshot: GameState } {
    const playerId = uuid();
    const displayName = (name || '').trim().slice(0, 24) || 'Pirate';

    const spawns = this.mapGen.generateShipSpawns(this.state.islands);
    const spawn = this.pickHumanSpawn(spawns) ?? {
      position: { x: randRange(-600, 600), y: 0, z: randRange(-600, 600) },
      rotation: randAngle(),
      type: 'sloop' as const,
    };

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

    const client: ConnectedClient = {
      ws,
      playerId,
      name: displayName,
      lastInput: null,
      lastPing: Date.now(),
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
      },
      lastOneShotAt: {},
      pendingFullSnapshot: null,
      pendingHotSnapshot: null,
    };
    this.clients.set(playerId, client);

    const snapshot = this.buildSnapshot(true);
    this.send(ws, {
      type: 'join',
      ts: Date.now(),
      payload: { playerId, shipId, snapshot, matchId: this.id },
    });

    console.log(`[Match ${this.id}] human joined: ${displayName} (${playerId.slice(0, 6)}); humans=${this.clients.size}`);
    return { playerId, shipId, snapshot };
  }

  /**
   * Lobby calls this on WS close OR when the client returns to menu.
   * If closeWs=true the client's WS is also closed.
   */
  removeClient(playerId: string, closeWs: boolean = false): void {
    const client = this.clients.get(playerId);
    if (!client) return;
    this.clients.delete(playerId);

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
    const placements: MatchHumanResult[] = [];
    const seen = new Set<string>();

    const pushHuman = (playerId: string, isWinner: boolean) => {
      if (seen.has(playerId)) return;
      seen.add(playerId);
      const live = this.playersById.get(playerId);
      const final = this.humanFinalStats.get(playerId);
      const name = live?.name ?? final?.name ?? this.clients.get(playerId)?.name ?? 'Pirate';
      const kills = live?.kills ?? final?.kills ?? 0;
      const deaths = final?.deaths ?? (live?.state === 'eliminated' ? 1 : 0);
      const gold = live?.gold ?? final?.gold ?? 0;
      placements.push({
        playerId,
        name,
        kills,
        deaths,
        gold,
        placement: placements.length + 1,
        isWinner,
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
    };
    this.broadcast({ type: 'match_ended', ts: Date.now(), payload: result });
    this.onMatchEnd?.(result);
  }

  private handleMessage(client: ConnectedClient, msg: NetMsg) {
    switch (msg.type) {
      case 'player_input': {
        const input = this.sanitizeInput(msg.payload);
        if (input) client.lastInput = input;
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
      case 'ping':
        this.send(client.ws, { type: 'pong', ts: Date.now(), payload: msg.payload });
        break;
      case 'dev_bot_peace': {
        // Dev/testing convenience — only honoured when a single human is in the
        // match (solo), so it can't be abused to disable bot aggression in a real
        // multiplayer game.
        if (this.clients.size <= 1) {
          this.botPeace = !!(msg.payload as { enabled?: boolean } | null)?.enabled;
          console.log(`[Match ${this.id}] dev bot-peace ${this.botPeace ? 'ON' : 'OFF'}`);
        }
        break;
      }
    }
  }

  private clearStationFlags(player: Player) {
    player.atCannon = false;
    player.atHelm = false;
    player.atSails = false;
    player.atCrowNest = false;
    player.blocking = false;
    player.bailing = false;
    player.cutlassCharge = 0;
  }

  private isStationOccupied(
    ship: Ship,
    station: 'helm' | 'sails' | 'crow' | 'cannon',
    playerId: string,
    cannonIndex: number | null = null,
  ) {
    return this.state.players.some((other) => {
      if (other.id === playerId || other.onShipId !== ship.id) return false;
      if (other.state === 'eliminated' || other.state === 'respawning') return false;
      switch (station) {
        case 'helm':
          return other.atHelm;
        case 'sails':
          return other.atSails;
        case 'crow':
          return other.atCrowNest;
        case 'cannon':
          return other.atCannon && other.cannonIndex === cannonIndex;
      }
    });
  }

  private enterHelm(player: Player, ship: Ship): boolean {
    if (this.isStationOccupied(ship, 'helm', player.id)) return false;
    this.clearStationFlags(player);
    player.atHelm = true;
    this.snapPlayerToHelm(player, ship);
    return true;
  }

  private enterCrowNest(player: Player, ship: Ship): boolean {
    if (this.isStationOccupied(ship, 'crow', player.id)) return false;
    this.clearStationFlags(player);
    player.atCrowNest = true;
    this.snapPlayerToCrowNest(player, ship);
    return true;
  }

  private enterCannon(player: Player, ship: Ship, cannonIndex: number, yaw: number, pitch: number): boolean {
    if (this.isStationOccupied(ship, 'cannon', player.id, cannonIndex)) return false;
    this.clearStationFlags(player);
    player.atCannon = true;
    player.cannonIndex = cannonIndex;
    const aim = this.getCannonAim(ship, cannonIndex, yaw, pitch);
    player.rotation.x = aim.yaw;
    player.rotation.y = aim.pitch;
    this.snapPlayerToCannon(player, ship, cannonIndex);
    return true;
  }

  private tick() {
    const dt = SERVER_TICK_MS / 1000;
    this.t += dt;
    this.tickCount++;
    this.state.tick++;

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
    this.physics.update(
      dt, this.t,
      this.state.ships,
      this.state.players,
      this.state.projectiles,
      this.state.islands,
      this.state.seaRocks,
      this.state.storm,
    );
    this.relayPendingCombatEvents();
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

    // Storm — routes through openHole so the tempest punches real holes into
    // the seaward face (holes + flooding), the SoT damage loop.
    this.storm.update(dt, this.state.storm, this.state.ships, this.state.players, {
      openHole: (ship, section, count) => this.physics.openHole(ship, section, count),
    });
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
        const includeStaticWorld = this.tickCount % FULL_WORLD_SNAPSHOT_TICKS === 0;
        const snap = buildWireSnapshot(this.buildSnapshot(includeStaticWorld), includeStaticWorld);
        this.broadcastVolatile({ type: 'state_snapshot', ts: Date.now(), payload: snap }, 'full');
      } else {
        const hot = buildHotSnapshot(this.state, this.t);
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
      && input.wheelIndex <= 8
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
    };
  }

  private applyInput(client: ConnectedClient, input: PlayerInput, dt: number) {
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
      ? this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch)
      : null;

    const prevJumpHeld = this.lastJumpHeldByPlayer.get(client.playerId) ?? false;
    const jumpEdge = input.jumpPressed || (!!input.jump && !prevJumpHeld);
    this.lastJumpHeldByPlayer.set(client.playerId, !!input.jump);

    player.rotation.x = player.atHelm && ship ? ship.rotation : (cannonAim?.yaw ?? input.yaw);
    player.rotation.y = cannonAim?.pitch ?? input.pitch;

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

    this.updateBlockingState(player, input);

    // Revive a downed crewmate: hold interact (~4 s) next to the body with the
    // revive action selected. Contributions are resolved in updateDownedAndRevives.
    if (
      input.interactHeld
      && input.interactIntent === 'revive'
      && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest
    ) {
      const target = this.findReviveTarget(player);
      if (target) this.reviveActionsThisTick.set(target.id, player.id);
    }

    if (ship && player.atCannon && jumpEdge && this.consumeOneShot(client, 'jump', input.seq)) {
      this.launchPlayerFromCannon(player, ship, cannonAim ?? this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch));
      return;
    }

    if (
      input.specialAttack
      && player.tsunamiCharges > 0
      && !player.carryingChestId
      && !player.atCannon
      && !player.atHelm
      && !player.atSails
      && !player.atCrowNest
      && this.consumeOneShot(client, 'special', input.seq)
    ) {
      this.fireTsunamiSpecial(player, input.yaw);
      return;
    }

    const canPlaceNormalKeg = player.kegs > 0 && player.kegCooldown <= 0;
    const canPlaceMegaKeg = player.megaKegs > 0;
    if (input.placeKeg && (canPlaceMegaKeg || canPlaceNormalKeg) && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest && this.consumeOneShot(client, 'placeKeg', input.seq)) {
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

    // Interact (X key) — exit current station always wins
    if (input.interact && this.consumeOneShot(client, 'interact', input.seq)) {
      if (player.atCannon) { player.atCannon = false; return; }
      if (player.atHelm)   { player.atHelm   = false; return; }
      if (player.atSails)  { player.atSails = false; return; }
      if (player.atCrowNest) {
        player.atCrowNest = false;
        if (ship) this.snapPlayerToCrowNestLadderBase(player, ship);
        return;
      }

      // Modern clients send the HUD-selected action. If that validation misses, do nothing:
      // falling through to the legacy chain is what made one [X] press trigger a different station.
      if (input.interactIntent) {
        this.tryInteractIntent(player, input, ship ?? null);
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

      if (this.tryBoardFromLadder(player)) return;

      if (this.handleGoldHoarderInteraction(player)) return;

      const homeShip = this.getAliveShip(player.shipId);
      const upgradeStation = this.getNearbyUpgradeStation(player);
      if (
        upgradeStation
        && homeShip
        && upgradeStation.claimedByShipId !== homeShip.id
        && !homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)
      ) {
        upgradeStation.claimedByShipId = homeShip.id;
        this.applyShipUpgrade(homeShip, upgradeStation.type);
        this.broadcast({ type: 'ship_upgraded', ts: Date.now(), payload: { shipId: homeShip.id, type: upgradeStation.type } });
        return;
      }

      if (ship) {
        // Hull repair is now a HOLD (the hammer-swing block below patches one hole
        // per ~0.9s plank), so a bare press at a breach is consumed here rather than
        // falling through to another interaction.
        if (this.getRepairableHullSection(player, ship)) return;

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
          if (this.enterCrowNest(player, ship)) return;
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
        && !player.atSails
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
        && !player.atSails
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
        if (this.getRepairPlankCount(player, ship) > 0) {
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
        && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest;
      const hullRepairTarget = mendingHull ? this.getRepairableHullSection(player, ship) : null;
      if (hullRepairTarget && this.getRepairPlankCount(player, ship) > 0) {
        player.hullRepairProgress = Math.min(1, player.hullRepairProgress + dt / SHIP.HULL_REPAIR_SWING_TIME);
        if (player.hullRepairProgress >= 1) {
          player.hullRepairProgress = 0;
          if (this.consumeRepairPlank(player, ship)) {
            this.physics.repairHullSection(ship, hullRepairTarget);
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
    } else if (player.atSails && ship) {
      this.snapPlayerToSails(player, ship);
      player.velocity.x = 0;
      player.velocity.z = 0;
    } else if (player.atCrowNest && ship) {
      this.snapPlayerToCrowNest(player, ship);
      player.velocity.x = 0;
      player.velocity.z = 0;
    } else if (player.atCannon && ship) {
      const aim = this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch);
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
      const jumpBlocked = !!ship && (player.atHelm || player.atSails || player.atCrowNest);
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
        const speed = PLAYER.MOVE_SPEED;

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
        if (ship && player.onShipId === ship.id) {
          const floorY = this.getShipFloorY(player.position, ship);
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
    this.tryUsePocketWheel(client, player, ship ?? null, input);
  }

  private updateCutlassAttack(player: Player, input: PlayerInput, dt: number): boolean {
    const activeWeapon = player.weapons[player.activeSlot];
    const isCutlass = !!activeWeapon && activeWeapon.weaponId === 'cutlass';
    if (!isCutlass || player.carryingChestId || player.atCannon || player.atHelm || player.atSails || player.blocking) {
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
    },
  ) {
    const activeWeapon = player.weapons[player.activeSlot];
    if (!activeWeapon || !WEAPONS[activeWeapon.weaponId].melee) return;
    const hits = this.weapons.tryMeleeAttack(player, this.state.players, yaw, options);
    for (const hit of hits) {
      const target = this.getPlayer(hit.targetId);
      if (!target) continue;
      if (target.respawnProtectionTimer > 0 || target.state === 'respawning') continue;
      const blockScale = this.getCutlassBlockScale(target, player);
      const damage = hit.damage * blockScale;
      const knockback = hit.knockback * (blockScale < 1 ? 0.32 : 1);
      target.lastDamagedById = player.id;
      target.lastDamagedAt = this.t;
      target.lastDamageWasHeadshot = false;
      target.health -= this.absorbWithArmor(target, damage);
      this.awardPlayerHitGold(player.id, damage);
      this.notifyPlayerHit(player.id, {
        targetId: target.id,
        damage,
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

  private updateBlockingState(player: Player, input: PlayerInput) {
    const activeWeapon = player.weapons[player.activeSlot];
    player.blocking = !!activeWeapon
      && activeWeapon.weaponId === 'cutlass'
      && !activeWeapon.reloading
      && input.aim
      && !input.fire
      && !player.carryingChestId
      && !player.atCannon
      && !player.atHelm
      && !player.atSails
      && player.state !== 'swimming';
  }

  private getCutlassBlockScale(target: Player, attacker: Player): number {
    if (!target.blocking || target.state === 'swimming' || target.carryingChestId) return 1;
    const activeWeapon = target.weapons[target.activeSlot];
    if (!activeWeapon || activeWeapon.weaponId !== 'cutlass') return 1;
    const dx = attacker.position.x - target.position.x;
    const dz = attacker.position.z - target.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return 1;
    const angleToAttacker = Math.atan2(dx, dz);
    const facingDelta = Math.abs(angleWrap(angleToAttacker - target.rotation.x));
    return facingDelta <= Math.PI * 0.58 ? 0.16 : 1;
  }

  private applyCutlassLunge(player: Player, yaw: number) {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    player.knockbackVelocity.x += forwardX * CUTLASS_LUNGE_IMPULSE;
    player.knockbackVelocity.y += 1.4;
    player.knockbackVelocity.z += forwardZ * CUTLASS_LUNGE_IMPULSE;
    player.velocity.y = Math.max(player.velocity.y, 1.8);
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
        }
        return;
      }
    }
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
    // Unified supply wheel — slots 0-2,7,8 EQUIP a tool (instant toggle, no
    // cooldown); slot 3 transfers a plank to ship stores; slots 4-6 eat one
    // consumable. Layout mirrors the client SVG (9-slice wheel).
    const tool: EquippableTool | null =
      ix === 0 ? 'spyglass'
        : ix === 1 ? 'compass'
          : ix === 2 ? 'bucket'
            : ix === 7 ? 'shovel'
              : ix === 8 ? 'lantern'
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

  private getNearbyGoldHoarder(player: Player): { npc: IslandNpc; island: Island } | null {
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs ?? []) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = dist2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (distance < PLAYER.INTERACT_RANGE + 0.8 && (!closest || distance < closest.distance)) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest ? { npc: closest.npc, island: closest.island } : null;
  }

  private handleGoldHoarderInteraction(player: Player): boolean {
    const hoarder = this.getNearbyGoldHoarder(player);
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
    const target = current ?? targetPool
      .map((island) => ({
        island,
        distance: dist2D(player.position.x, player.position.z, island.position.x, island.position.z),
      }))
      .sort((a, b) => a.distance - b.distance)[0].island;
    player.treasureMapIslandId = target.id;
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
      // A keg blast caves the hull in: the detonation section is stove wide
      // open, the rest take a hole each. A MEGA keg riddles the whole hull.
      for (const section of this.getHullSections()) {
        const isPrimary = section === hit.section;
        const holes = keg.mega
          ? (isPrimary ? FLOODING.MAX_HOLES_PER_SECTION : 2)
          : (isPrimary ? 2 : 1);
        this.physics.openHole(hit.ship, section, holes);
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

  private getKegShipHits(keg: ShipKeg): Array<{ ship: Ship; section: keyof Ship['hull'] }> {
    if (keg.shipId) {
      const attachedShip = this.getAliveShip(keg.shipId);
      return attachedShip ? [{ ship: attachedShip, section: keg.section }] : [];
    }

    const hits: Array<{ ship: Ship; section: keyof Ship['hull'] }> = [];
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

  private getHullSectionFromLocal(local: { x: number; z: number }): keyof Ship['hull'] {
    return Math.abs(local.x) > Math.abs(local.z)
      ? (local.x >= 0 ? 'starboard' : 'port')
      : (local.z >= 0 ? 'bow' : 'stern');
  }

  private getHullSections(): Array<keyof Ship['hull']> {
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
      if (player.atCannon || player.atHelm || player.atSails || player.atCrowNest) {
        if (player.bailing) player.bailing = false;
        continue;
      }
      const water = ship.waterLevel ?? 0;
      const holedSection = this.getWeakestHoledSection(ship);

      // Priority 1: get to the holed section's rail and plug it (throttled,
      // consumes planks — same proximity rule getRepairableHullSection applies
      // to humans).
      if (holedSection && (this.botRepairCooldownAt.get(player.id) ?? 0) <= this.t && this.getRepairPlankCount(player, ship) > 0) {
        if (this.getRepairableHullSection(player, ship) === holedSection) {
          if (this.consumeRepairPlank(player, ship)) {
            this.physics.repairHullSection(ship, holedSection);
            this.botRepairCooldownAt.set(player.id, this.t + SHIP.FIELD_REPAIR_INTERVAL);
          }
        } else {
          const rail = this.getSectionRailLocal(ship, holedSection);
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

  /** Ship-local standing point at a hull section's repair rail. */
  private getSectionRailLocal(ship: Ship, section: keyof Ship['hull']): { x: number; z: number } {
    const stats = SHIP_STATS[ship.type];
    switch (section) {
      case 'bow': return { x: 0, z: stats.length * 0.38 };
      case 'stern': return { x: 0, z: -stats.length * 0.38 };
      case 'starboard': return { x: stats.width * 0.42, z: 0 };
      case 'port': return { x: -stats.width * 0.42, z: 0 };
    }
  }

  /** Most-holed section (the one to plank first), or null if the hull is whole. */
  private getWeakestHoledSection(ship: Ship): keyof Ship['hull'] | null {
    return this.getWeakestHullSection(ship);
  }

  private updateFieldRepairs(dt: number) {
    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;

      ship.repairCooldown = Math.max(0, ship.repairCooldown - dt);
      const weakestSection = this.getWeakestHullSection(ship);
      const plankStack = ship.inventory.find((entry) => entry.item === 'wood_plank' && entry.qty > 0);
      if (!ship.anchored || ship.onFire || ship.repairCooldown > 0 || !weakestSection || !plankStack) {
        ship.autoRepairProgress = 0;
        continue;
      }

      ship.autoRepairProgress += dt;
      if (ship.autoRepairProgress < SHIP.FIELD_REPAIR_INTERVAL) continue;
      ship.autoRepairProgress = 0;
      if (!this.consumeShipItem(ship, 'wood_plank', 1)) continue;
      this.physics.repairHullSection(ship, weakestSection);
    }
  }

  /** The section with the most open holes (repair/bail target), or null if the
   *  hull has no holes at all. */
  private getWeakestHullSection(ship: Ship): keyof Ship['hull'] | null {
    let worst: keyof Ship['hull'] | null = null;
    let worstHoles = 0;
    for (const section of ['bow', 'stern', 'port', 'starboard'] as Array<keyof Ship['hull']>) {
      if (ship.holes[section] > worstHoles) {
        worstHoles = ship.holes[section];
        worst = section;
      }
    }
    return worst;
  }

  private getNearbyKeg(player: Player, ship: Ship | null = null) {
    let closest: ShipKeg | null = null;
    let closestDistance: number = SHIP.KEG_DIFFUSE_RANGE;
    for (const keg of this.state.kegs) {
      if (ship && keg.shipId && keg.shipId !== ship.id) continue;
      if (keg.timer <= 0) continue;
      this.syncKegPosition(keg);
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

  private diffuseKeg(keg: ShipKeg) {
    // Flag first — a bare timer=0 would read as "fuse burnt down" and detonate
    // in the same tick's updateKegs pass.
    keg.defused = true;
    keg.timer = 0;
  }

  private getNearbyUpgradeStation(player: Player) {
    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const dx = player.position.x - station.position.x;
        const dz = player.position.z - station.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) return station;
      }
    }
    return null;
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
      section: 'bow' as keyof Ship['hull'],
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

  private getCannonAim(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    const stats = SHIP_STATS[ship.type];
    const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
    const broadsideYaw = ship.rotation + (cannonIndex < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
    return {
      yaw: broadsideYaw + Math.max(-SHIP.CANNON_YAW_ARC, Math.min(SHIP.CANNON_YAW_ARC, angleWrap(yaw - broadsideYaw))),
      pitch: Math.max(SHIP.CANNON_PITCH_MIN, Math.min(SHIP.CANNON_PITCH_MAX, pitch)),
    };
  }

  private getCannonMuzzlePosition(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    return this.weapons.getCannonMuzzlePosition(ship, cannonIndex, yaw, pitch);
  }

  private getShipFloorY(position: Vec3, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const deckY = ship.position.y + stats.height + 0.1;
    const holdFloor = ship.position.y + 0.35;
    const local = this.toShipLocal(position, ship);
    const stair = getShipCompanionwayConfig(stats);
    if (
      Math.abs(local.x - stair.cx) <= stair.stairHalfWidth
      && local.z <= stair.stairFrontZ
      && local.z >= stair.stairBackZ
    ) {
      const descent = Math.max(
        0,
        Math.min(1, (stair.stairFrontZ - local.z) / Math.max(0.001, stair.stairFrontZ - stair.stairBackZ)),
      );
      return deckY + (holdFloor - deckY) * descent;
    }
    return position.y < deckY - 0.25 ? holdFloor : deckY;
  }

  private getSailControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSharedSailControlLocal(stats);
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
    return occlusion;
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
      const headY = islandSkeleton ? 1.92 : PLAYER.HEIGHT * 0.96;
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
      y: player.position.y + (swimming ? PLAYER.HEIGHT * 0.56 : PLAYER.HEIGHT * 0.84),
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

  private tryClimbIslandDockFromWater(player: Player): boolean {
    if (player.state !== 'swimming') return false;
    for (const island of this.state.islands) {
      if (!island.dock) continue;
      const dock = island.dock;
      const dx = player.position.x - dock.position.x;
      const dz = player.position.z - dock.position.z;
      const cos = Math.cos(dock.rotation);
      const sin = Math.sin(dock.rotation);
      const localX = dx * cos + dz * sin;
      const localZ = -dx * sin + dz * cos;
      if (Math.abs(localX) > dock.width * 0.42) continue;
      if (localZ > -dock.length * 0.08 || localZ < -dock.length * 0.58) continue;
      const targetDist = Math.hypot(localX, localZ + dock.length * 0.34);
      if (targetDist > 4.2) continue;
      const top = dockLocalToWorld(dock, 0, 0.55, -dock.length * 0.12);
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

  private getMermaidReturnShip(player: Player): Ship | null {
    if (player.state !== 'swimming' || !player.shipId) return null;
    const homeShip = this.getAliveShip(player.shipId);
    if (!homeShip || homeShip.sinking) return null;
    const distance = dist2D(player.position.x, player.position.z, homeShip.position.x, homeShip.position.z);
    return distance >= 45 ? homeShip : null;
  }

  private returnPlayerByMermaid(player: Player): boolean {
    const homeShip = this.getMermaidReturnShip(player);
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

  private tryBoardFromLadder(player: Player): boolean {
    if (!player.nearShipId || (player.state !== 'swimming' && player.onShipId !== null)) return false;
    const targetShip = this.getAliveShip(player.nearShipId);
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
    return true;
  }

  /** Resolves [X] to the action the client HUD selected; each branch validates range / state. */
  private tryInteractIntent(player: Player, input: PlayerInput, ship: Ship | null): boolean {
    const intent = input.interactIntent;
    if (!intent) return false;

    switch (intent) {
      case 'barrel': {
        if (!player.nearBarrelId) return false;
        const barrelEvent = this.islands.tryOpenBarrel(player, this.state.islands, this.state.ships);
        if (barrelEvent) {
          this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
          return true;
        }
        return false;
      }
      case 'chest': {
        const event = this.tryTakeChest(player);
        if (event) {
          this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
          return true;
        }
        return false;
      }
      case 'stow_chest': {
        if (!ship || player.onShipId !== ship.id) return false;
        return this.tryStowCarriedChest(player, ship);
      }
      case 'gold_hoarder':
        return this.handleGoldHoarderInteraction(player);
      case 'board':
        return this.tryBoardFromLadder(player);
      case 'dock':
        return this.tryClimbIslandDockFromWater(player);
      case 'mermaid':
        return this.returnPlayerByMermaid(player);
      case 'keg_diffuse': {
        const keg = this.getNearbyKeg(player, ship ?? null);
        if (!keg) return false;
        this.diffuseKeg(keg);
        return true;
      }
      case 'upgrade': {
        const homeShip = this.getAliveShip(player.shipId);
        const upgradeStation = this.getNearbyUpgradeStation(player);
        if (
          !upgradeStation
          || !homeShip
          || upgradeStation.claimedByShipId === homeShip.id
          || homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)
        ) {
          return false;
        }
        upgradeStation.claimedByShipId = homeShip.id;
        this.applyShipUpgrade(homeShip, upgradeStation.type);
        this.broadcast({ type: 'ship_upgraded', ts: Date.now(), payload: { shipId: homeShip.id, type: upgradeStation.type } });
        return true;
      }
      case 'repair': {
        if (!ship || player.onShipId !== ship.id) return false;
        const repairSection = this.getRepairableHullSection(player, ship);
        if (!repairSection || !this.consumeRepairPlank(player, ship)) return false;
        this.physics.repairHullSection(ship, repairSection);
        if (ship.onFire) {
          ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
          if (ship.fireTimer <= 0) { ship.onFire = false; ship.fireTimer = 0; ship.fireDamageAccum = 0; }
        }
        return true;
      }
      case 'bail': {
        // The press just confirms intent; the continuous drain runs in the
        // held-interact block (applyInput). Consume it so [X] doesn't fall through.
        if (!ship || player.onShipId !== ship.id) return false;
        return (ship.waterLevel ?? 0) > 0;
      }
      case 'anchor': {
        if (!ship || player.onShipId !== ship.id) return false;
        if (!this.isNearAnchor(player, ship)) return false;
        if (!ship.anchored) {
          ship.anchored = true;
          ship.anchorRaiseProgress = 0;
        }
        this.clearStationFlags(player);
        return true;
      }
      case 'crow': {
        if (!ship || player.onShipId !== ship.id) return false;
        if (!this.isNearCrowNestLadder(player, ship)) return false;
        return this.enterCrowNest(player, ship);
      }
      case 'sails': {
        // No captive sail mode: the press confirms intent, the continuous
        // hold in applyInput hauls the halyard (Sea-of-Thieves style).
        if (!ship || player.onShipId !== ship.id) return false;
        return this.isNearSailStation(player, ship);
      }
      case 'brace': {
        // Same pattern as the halyard: press confirms, the hold in applyInput
        // sweeps the yard toward the station's side.
        if (!ship || player.onShipId !== ship.id) return false;
        return findBraceStationDir(player, ship) !== 0;
      }
      case 'revive': {
        // The press just confirms intent; the continuous revive runs off the
        // held-interact block in applyInput. Consume so [X] doesn't fall through.
        return this.findReviveTarget(player) !== null;
      }
      case 'helm': {
        if (!ship || player.onShipId !== ship.id) return false;
        if (!this.isNearHelm(player, ship)) return false;
        return this.enterHelm(player, ship);
      }
      case 'cannon': {
        if (!ship || player.onShipId !== ship.id) return false;
        const nearbyCannon = this.getNearbyCannonIndex(player, ship);
        if (nearbyCannon === null) return false;
        return this.enterCannon(player, ship, nearbyCannon, input.yaw, input.pitch);
      }
      default:
        return false;
    }
  }

  private updateSharks(dt: number) {
    const { sharks, players, islands } = this.state;
    this.sharkSpawnCooldown = Math.max(0, this.sharkSpawnCooldown - dt);

    if (sharks.length < SHARK.MAX_WORLD && this.sharkSpawnCooldown <= 0 && Math.random() < SHARK.SPAWN_CHANCE_PER_TICK) {
      const swimmers = players.filter(p => p.state === 'swimming' && p.swimTimer >= SHARK.SPAWN_SWIM_GRACE);
      if (swimmers.length) {
        const p = swimmers[Math.floor(Math.random() * swimmers.length)];
        const ang = Math.random() * Math.PI * 2;
        const dist = randRange(SHARK.SPAWN_MIN_DIST, SHARK.SPAWN_MAX_DIST);
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
              targetId: p.id,
            });
            this.sharkSpawnCooldown = randRange(SHARK.SPAWN_COOLDOWN_MIN, SHARK.SPAWN_COOLDOWN_MAX);
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

      if (!target) {
        // Frame-rate-independent decay preserving the previous per-16ms feel.
        const idleDamp = Math.pow(0.92, dt / 0.016);
        s.velocity.x *= idleDamp;
        s.velocity.z *= idleDamp;
        s.position.x += s.velocity.x * dt;
        s.position.z += s.velocity.z * dt;
        continue;
      }

      const dx = target.position.x - s.position.x;
      const dz = target.position.z - s.position.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      s.rotation = Math.atan2(dx, dz);
      const sp = SHARK.CHASE_SPEED;
      s.velocity.x = (dx / d) * sp;
      s.velocity.z = (dz / d) * sp;
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

      // Only bite from open water within range (not from inside the shore rock).
      if (!inLand && d < SHARK.BITE_RANGE && s.biteCooldown <= 0) {
        target.health -= this.absorbWithArmor(target, SHARK.BITE_DAMAGE);
        target.lastDamagedById = null;
        target.lastDamagedAt = null;
        target.lastDamageWasHeadshot = false;
        s.biteCooldown = SHARK.BITE_COOLDOWN;
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
          ? homeAngle + randRange(-0.55, 0.55)
          : animal.wanderAngle + randRange(-1.35, 1.35);
        animal.wanderTimer = randRange(0.7, animal.type === 'gull' ? 2.0 : 3.0);
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
        animal.wanderAngle += Math.PI + randRange(-0.45, 0.45);
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
    // A foundering ship is riddled — max out its holes so it renders wrecked.
    ship.holes.bow = FLOODING.MAX_HOLES_PER_SECTION;
    ship.holes.stern = FLOODING.MAX_HOLES_PER_SECTION;
    ship.holes.port = FLOODING.MAX_HOLES_PER_SECTION;
    ship.holes.starboard = FLOODING.MAX_HOLES_PER_SECTION;
    this.physics.syncHullFromHoles(ship);

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
        x: (Math.random() - 0.5) * (rapid ? 7 : 5),
        y: rapid ? 5.5 : 4.2,
        z: (Math.random() - 0.5) * (rapid ? 7 : 5),
      };
    }

    ship.crewIds = [];
    this.state.kegs = this.state.kegs.filter((keg) => keg.shipId !== ship.id);
    this.shipLastDamagedByPlayer.delete(ship.id);
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
    if (killer.playerKillStreak === 5) {
      killer.superCannonballs += 1;
      return { type: 'super_cannonball', label: 'Super cannonball ready' };
    }
    if (killer.playerKillStreak === 10) {
      killer.megaKegs += 1;
      return { type: 'mega_keg', label: 'Mega keg ready' };
    }
    if (killer.playerKillStreak === 20) {
      killer.tsunamiCharges += 1;
      return { type: 'tsunami', label: 'Tsunami ready' };
    }
    return null;
  }

  private creditPlayerKill(killer: Player, victim: Player): {
    streakReward: { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null;
    killGold: number;
  } {
    killer.kills += 1;
    let streakReward: { type: 'super_cannonball' | 'mega_keg' | 'tsunami'; label: string } | null = null;
    if (killer.shipId && victim.shipId && killer.shipId !== victim.shipId) {
      streakReward = this.awardPlayerKillStreak(killer);
    }
    const isSkeleton = victim.isBot && this.skeletonHomes.has(victim.id);
    const killGold = isSkeleton ? PLAYER.SKELETON_KILL_GOLD : PLAYER.KILL_GOLD_REWARD;
    killer.gold += killGold;
    this.checkWinCondition();
    return { streakReward, killGold };
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

  private recordElimination(p: Player) {
    if (this.eliminationOrder.includes(p.id)) return;
    this.eliminationOrder.push(p.id);
    if (!p.isBot && !this.humanFinalStats.has(p.id)) {
      this.humanFinalStats.set(p.id, {
        name: p.name,
        kills: p.kills,
        deaths: 1,
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

  /** Crewmates = players sharing the same home ship (player.shipId). Anyone
   *  not eliminated counts — a downed or respawning mate can still come back
   *  and revive you, so the squad isn't wiped yet. */
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
      if (bot.atCannon || bot.atHelm || bot.atSails || bot.atCrowNest) continue;

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
      if (headshot) killer.gold += PLAYER.HEADSHOT_GOLD_BONUS;
      if (boardingKill) {
        const previousHealth = killer.health;
        stolenGold = Math.min(player.gold, PLAYER.BOARDING_GOLD_STEAL_CAP);
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

    if (canRespawn) {
      player.state = 'respawning';
      player.health = 0;
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
          payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold },
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

  private checkWinCondition() {
    if (this.state.phase !== 'playing') return;

    const goldWinner = this.state.players.find((player) =>
      !player.isBot
      && player.state !== 'eliminated'
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

  private buildSnapshot(includeStaticWorld = true): GameState {
    return {
      ...this.state,
      serverTime: this.t,
      projectiles: this.state.projectiles.filter(p => p.alive),
      kegs: this.state.kegs.filter((keg) => keg.timer > 0 && !keg.defused),
      islands: includeStaticWorld ? this.state.islands : [],
    };
  }

  private relayPendingCombatEvents() {
    for (const event of this.physics.flushCombatEvents()) {
      if (event.type === 'player_hit') {
        this.awardPlayerHitGold(event.attackerId, event.damage);
        const attacker = this.getPlayer(event.attackerId);
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
        // ship_hit above stays the hit-confirm channel).
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
          },
        });
      }
    }
  }

  private awardPlayerHitGold(attackerId: string | null, damage: number) {
    if (!attackerId || damage <= 0) return;
    const attacker = this.getPlayer(attackerId);
    if (!attacker || attacker.state === 'eliminated') return;
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
    },
  ) {
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
      section: keyof Ship['hull'];
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
        if (kind === 'full') client.pendingFullSnapshot = data;
        else client.pendingHotSnapshot = data;
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
      client.pendingHotSnapshot = null;
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
        randRange(SKELETON_WAVE_INITIAL_DELAY_MIN, SKELETON_WAVE_INITIAL_DELAY_MAX),
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
        timer = randRange(SKELETON_WAVE_COOLDOWN_MIN, SKELETON_WAVE_COOLDOWN_MAX);
      }

      timer -= dt;
      if (timer <= 0) {
        this.spawnSkeletonWave(island, waveSize);
        timer = randRange(SKELETON_WAVE_COOLDOWN_MIN, SKELETON_WAVE_COOLDOWN_MAX);
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
    const baseAngle = randAngle();
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
      const offset = (i - (count - 1) * 0.5) * 0.42 + randRange(-0.18, 0.18);
      const angle = baseAngle + offset;
      const spawnPoint = getIslandSurfacePoint(island, randRange(0.2, 0.5), angle, 0.06);
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
          if (weapon && !weapon.reloading) {
            const hits = this.weapons.tryMeleeAttack(skeleton, [target], skeleton.rotation.x);
            for (const hit of hits) {
              target.lastDamagedById = skeleton.id;
              target.lastDamagedAt = this.t;
              target.lastDamageWasHeadshot = false;
              // 65% weapon damage — skeletons are a real threat now
              const damage = hit.damage * 0.65;
              target.health -= this.absorbWithArmor(target, damage);
              this.notifyIncomingPlayerHit(target.id, {
                attackerId: skeleton.id,
                attackerName: skeleton.name,
                damage,
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
              target.knockbackVelocity.x += (dx / len) * hit.knockback * 0.72;
              target.knockbackVelocity.y += hit.knockback * 0.18;
              target.knockbackVelocity.z += (dz / len) * hit.knockback * 0.72;
            }
            weapon.reloading = true;
            weapon.reloadTimer = WEAPONS.cutlass.reloadTime * 1.5;
          }
        }
      } else {
        const roamSeed = skeleton.id.charCodeAt(0) * 0.17 + skeleton.id.charCodeAt(skeleton.id.length - 1) * 0.11;
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
              payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold },
            });
          }
        }
        continue;
      }

      if (!this.isShipInStormSafeZone(homeShip)) {
        // Home ship is outside the ring: HOLD the respawn (timer pauses)
        // instead of the old instant crew-wide elimination + force-sink.
        // The storm's hull punctures sink the ship (handled above via the
        // homeShip-gone branch) or the crew sails it back to safety.
        continue;
      }

      player.respawnTimer -= dt;
      if (player.respawnTimer > 0) continue;

      const respawnPlan = this.getRespawnPlan(homeShip);
      player.state = 'alive';
      player.health = PLAYER.RESPAWN_HEALTH;
      player.onShipId = respawnPlan.onShipId;
      player.position = respawnPlan.position;
      player.velocity = { x: 0, y: 0, z: 0 };
      player.knockbackVelocity = { x: 0, y: 0, z: 0 };
      this.clearStationFlags(player);
      player.nearChestId = null;
      player.nearShipId = null;
      player.lastDamagedById = null;
      player.lastDamagedAt = null;
      player.lastDamageWasHeadshot = false;
      player.respawnTimer = 0;
      player.swimTimer = 0;
      player.cannonFlightTimer = 0;
      player.cannonBallistic = false;
      player.blocking = false;
      player.cutlassCharge = 0;
      player.respawnProtectionTimer = respawnPlan.protectionTime;
      player.shipBoundaryGraceTimer = 0;
      if (respawnPlan.dock) {
        this.parkShipAtDock(homeShip, respawnPlan.dock);
      }
      if (!homeShip.crewIds.includes(player.id)) {
        homeShip.crewIds.push(player.id);
      }
      this.broadcast({ type: 'player_spawned', ts: Date.now(), payload: { playerId: player.id, shipId: homeShip.id } });
    }
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
    const local = { x: 0, z: -stats.length * 0.37 };
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    player.position.x = ship.position.x + local.x * cos + local.z * sin;
    player.position.z = ship.position.z + local.z * cos - local.x * sin;
    // Stand ON the raised quarterdeck dais, not sunk into it.
    player.position.y = ship.position.y + stats.height + 0.1 + getShipDeckRaiseAt(local, stats);
  }

  private snapPlayerToSails(player: Player, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const local = this.getSailControlLocal(stats);
    const world = this.toShipWorld(local.x, local.z, ship);
    player.position.x = world.x;
    player.position.z = world.z;
    player.position.y = ship.position.y + stats.height + 0.1;
  }

  private isNearCrowNestLadder(player: Player, ship: Ship): boolean {
    return isSharedNearCrowNestLadder(player, ship);
  }

  private snapPlayerToCrowNest(player: Player, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const mastZ = getMainMastLocalZ(stats);
    const world = this.toShipWorld(0.42, mastZ - 0.12, ship);
    player.position.x = world.x;
    player.position.z = world.z;
    player.position.y = ship.position.y + getCrowNestStandingY(stats);
  }

  private snapPlayerToCrowNestLadderBase(player: Player, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const mastZ = getMainMastLocalZ(stats);
    const world = this.toShipWorld(0.42, mastZ - 0.42, ship);
    player.position.x = world.x;
    player.position.z = world.z;
    player.position.y = ship.position.y + stats.height + 0.1;
    player.velocity = { x: 0, y: 0, z: 0 };
    player.knockbackVelocity = { x: 0, y: 0, z: 0 };
  }

  private getRepairableHullSection(player: Player, ship: Ship): keyof Ship['hull'] | null {
    if (this.getRepairPlankCount(player, ship) <= 0) return null;

    const local = this.toShipLocal(player.position, ship);
    const candidate: keyof Ship['hull'] =
      Math.abs(local.x) > Math.abs(local.z)
        ? (local.x >= 0 ? 'starboard' : 'port')
        : (local.z >= 0 ? 'bow' : 'stern');

    const closeEnough =
      candidate === 'bow' || candidate === 'stern'
        ? Math.abs(local.z) > SHIP_STATS[ship.type].length * 0.34
        : Math.abs(local.x) > SHIP_STATS[ship.type].width * 0.38;

    if (!closeEnough) return null;
    return ship.holes[candidate] > 0 ? candidate : null;
  }

  private getRepairPlankCount(player: Player, ship: Ship) {
    const shipPlanks = ship.inventory.find(entry => entry.item === 'wood_plank')?.qty ?? 0;
    return player.pocketWood + shipPlanks;
  }

  private consumeRepairPlank(player: Player, ship: Ship): boolean {
    if (player.pocketWood > 0) {
      player.pocketWood -= 1;
      return true;
    }
    return this.consumeShipItem(ship, 'wood_plank', 1);
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
    player.position.y = ship.position.y + SHIP_STATS[ship.type].height + 0.1;
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

  private getRespawnPlan(homeShip: Ship) {
    return {
      position: this.getRespawnDeckPosition(homeShip),
      onShipId: homeShip.id,
      protectionTime: PLAYER.RESPAWN_PROTECTION_TIME + 1.5,
      dock: null,
    };
  }

  private parkShipAtDock(ship: Ship, dock: IslandDock) {
    // Normalized berth, computed for THIS ship: parallel to the dock, bow
    // seaward, a consistent ~1m gap between hull side and dock edge, midship
    // abreast the dock's outer half. The old pre-baked point was sized for a
    // galleon and slid up to 88m seaward on shallow shores — sloops floated
    // far off crooked-looking docks. Depth is verified per ship type; the
    // pre-baked galleon berth stays as the fallback.
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
    // A reset/respawned ship is seaworthy again — patch every hole (any open
    // hole would keep flooding it under the new model).
    ship.holes.bow = 0;
    ship.holes.stern = 0;
    ship.holes.port = 0;
    ship.holes.starboard = 0;
    ship.waterLevel = 0;
    this.physics.syncHullFromHoles(ship);
  }

  /** Depth-verified side-berth for THIS ship type: parallel to the dock, a
   *  fixed ~1m rail gap, midship starting abreast the dock's outer half and
   *  only sliding seaward as far as the draft demands. Tries the dock's
   *  preferred side first, then the other; null → caller falls back to the
   *  pre-baked galleon berth. */
  private computeShipBerth(ship: Ship, dock: IslandDock): { x: number; z: number } | null {
    const island = this.state.islands.find((isl) => isl.dock === dock);
    if (!island) return null;
    const stats = SHIP_STATS[ship.type];
    const fwd = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
    const right = { x: fwd.z, z: -fwd.x };
    const half = stats.length * 0.5;
    const lateral = dock.width * 0.5 + stats.width * 0.5 + 1.0;
    // The berth must clear the KEEL (draft = height × KEEL_DRAFT_RATIO) with
    // margin, per ship type — a too-shallow berth grounds the hull and the
    // buoyancy/grounding resolve visibly shoves it out of the water.
    const needDepth = -(stats.height * SHIP.KEEL_DRAFT_RATIO + 0.55);
    const alongStart = Math.max(dock.length * 0.55, dock.length - half);
    for (const side of [dock.moorSide, -dock.moorSide]) {
      for (let step = 0; step < 24; step++) {
        const along = alongStart + step * 1.5;
        const cx = dock.position.x + fwd.x * along + right.x * side * lateral;
        const cz = dock.position.z + fwd.z * along + right.z * side * lateral;
        const clear = [half + 1.5, 0, -(half + 1.5)].every((offset) =>
          getIslandSurfaceY(island, cx + fwd.x * offset, cz + fwd.z * offset) < needDepth,
        );
        if (clear) return { x: cx, z: cz };
      }
    }
    return null;
  }

  private armShipExitGrace(player: Player, ship: Ship, input: PlayerInput) {
    if (!input.jumpPressed || player.atHelm || player.atCannon || player.atSails || player.atCrowNest || player.onShipId !== ship.id) return;

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
