import type { Player, Ship, Island, SeaRock, StormState, Vec3, WeaponId } from '../../shared/types/index.js';
import {
  SHIP_STATS, SHIP, PHYSICS, PLAYER,
  BOT_EARLY_PEACE_SECONDS, BOT_ENGAGE_RANGE_BY_PHASE, BOT_ENGAGE_SHRINK_MULT, BOT_DEFEND_RANGE,
  BOT_MAX_HUNTERS_BY_PHASE, BOT_LOOKAHEAD_METERS, BOT_OBSTACLE_MARGIN, BOT_KEEL_CLEARANCE,
} from '../../shared/constants/index.js';
import { dist2D, randAngle, angleWrap, sampleWind, getIslandSurfaceY, getIslandMaxRadius } from '../../shared/utils/index.js';
import { raymarchIslandSurface } from '../../shared/raycast.js';
import { applyShipRudderSteering } from './PhysicsSystem.js';
import type { WeaponSystem } from './WeaponSystem.js';

type BotBehavior = 'patrol' | 'chase' | 'engage' | 'flee' | 'loot' | 'return';

interface BotState {
  playerId: string;
  shipId: string;
  behavior: BotBehavior;
  targetShipId: string | null;
  targetIslandId: string | null;
  patrolAngle: number;
  aimYaw: number;
  aimPitch: number;
  fireTimer: number;
  difficulty: 'easy' | 'medium' | 'hard';
  stateTimer: number;
  /** Cooldown between personal-weapon shots at boarders. */
  firearmTimer: number;
  /** Remaining seconds for the current shore-party leg (walk to chest / back).
   *  Expiry falls back to the legacy warp so bots can never brick. */
  shoreTimer: number;
  /** Which shore-party leg the timer budgets. */
  shoreLeg: 'toChest' | 'toShip' | null;
  /** Seconds spent unintentionally off the ship (knocked overboard, stranded)
   *  outside the loot behavior — recalled aboard after a short grace. */
  overboardTimer: number;
  /** Hull total at the last check — a drop means somebody is shooting at us. */
  lastHullTotal: number;
  /** Sim time until which this bot counts as "under fire" and may fight back
   *  during the early-game peace window. */
  underFireUntil: number;
}

export interface BotFirearmShot {
  playerId: string;
  /** Direction used for the hitscan trace; world-aligned aim point. */
  aimPoint: Vec3;
  /** Yaw used for the shooter's facing — also constrains spread/melee arcs. */
  yaw: number;
  pitch: number;
}

const CANNON_GRAVITY = -PHYSICS.GRAVITY * SHIP.CANNON_GRAVITY_MULT; // positive magnitude
const CANNON_VY_BOOST = 5; // matches WeaponSystem.fireShipCannon
const FIREARM_RANGE = 24;
const FIREARM_AIM_HEIGHT = 1.4;
/** How long a bot stays willing to fight back after taking hull damage. */
const BOT_RETALIATE_SECONDS = 45;

function hullTotal(ship: Ship): number {
  return ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard;
}

export class BotSystem {
  private bots: Map<string, BotState> = new Map();
  private pendingFirearmFires: BotFirearmShot[] = [];
  /** Dev-only "leave me alone" (solo testing): ships/players bots must not target
   *  or shoot at. Bots still fight each other. Set by Match each tick. */
  private peaceShipIds: Set<string> = new Set();
  private peacePlayerIds: Set<string> = new Set();
  /** Navigation context for the current bot's steering (set per bot each tick). */
  private navIslands: Island[] = [];
  private navSeaRocks: SeaRock[] = [];
  private navSkipIslandId: string | null = null;

  /** Match calls this each tick with the human's ship + player id when bot-peace is
   *  on (empty sets otherwise), so bots ignore that ship/player as a target. */
  setPeace(shipIds: Iterable<string>, playerIds: Iterable<string>) {
    this.peaceShipIds = new Set(shipIds);
    this.peacePlayerIds = new Set(playerIds);
  }

  registerBot(player: Player, ship: Ship, difficulty: 'easy' | 'medium' | 'hard' = 'medium') {
    this.bots.set(player.id, {
      playerId: player.id,
      shipId: ship.id,
      behavior: 'patrol',
      targetShipId: null,
      targetIslandId: null,
      patrolAngle: randAngle(),
      aimYaw: 0,
      aimPitch: 0.1,
      fireTimer: 1.5 + Math.random() * 1.5,
      difficulty,
      stateTimer: 5 + Math.random() * 10,
      firearmTimer: 0.3 + Math.random() * 0.6,
      shoreTimer: 0,
      shoreLeg: null,
      overboardTimer: 0,
      lastHullTotal: hullTotal(ship),
      underFireUntil: 0,
    });
  }

  update(
    dt: number,
    t: number,
    players: Player[],
    ships: Ship[],
    islands: Island[],
    storm: StormState,
    weaponSystem: WeaponSystem,
    seaRocks: SeaRock[] = [],
  ) {
    for (const [pid, bot] of this.bots) {
      const player = players.find(p => p.id === pid);
      const ship = ships.find(s => s.id === bot.shipId);
      // Downed bots stop steering/firing — Match's DBNO pass owns them until
      // a crewmate revives them or they bleed out.
      if (!player || !ship || player.state === 'eliminated' || player.state === 'downed' || !ship.alive) continue;

      bot.stateTimer -= dt;
      bot.firearmTimer -= dt;

      // Taking hull damage lifts the early-game peace for this bot — it may hunt
      // whoever is in range for a while (self-defence, not lobby-wide aggression).
      const hull = hullTotal(ship);
      if (hull < bot.lastHullTotal - 0.001) bot.underFireUntil = t + BOT_RETALIATE_SECONDS;
      bot.lastHullTotal = hull;

      this.decideBehavior(bot, ship, ships, islands, storm, players, t);
      this.executeBehavior(bot, player, ship, ships, islands, storm, dt, t, weaponSystem, seaRocks);
      this.maybeFireAtBoarder(bot, player, ship, players, weaponSystem);
    }
  }

  /** How many bot crews are currently hunting a ship (bounded by the lobby size,
   *  so a straight recount per decision is cheaper than keeping a live tally). */
  private countHunters(): number {
    let n = 0;
    for (const other of this.bots.values()) if (other.behavior === 'engage') n++;
    return n;
  }

  /** Drain any personal-weapon shots generated this tick. Match resolves their hits. */
  flushFirearmShots(): BotFirearmShot[] {
    return this.pendingFirearmFires.splice(0);
  }

  private decideBehavior(
    bot: BotState, ship: Ship,
    ships: Ship[], islands: Island[], storm: StormState,
    players: Player[], t: number,
  ) {
    const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
    const distRatio = distToCenter / Math.max(1, storm.safeRadius);
    const dangerThreshold = storm.shrinking ? 0.65 : 0.85;
    const inDanger = distRatio > dangerThreshold;

    if (inDanger) {
      bot.behavior = 'flee';
      bot.targetShipId = null;
      return;
    }

    const avgHull = (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4;
    if (avgHull < 0.2 && bot.behavior !== 'flee') {
      bot.behavior = 'flee';
      bot.stateTimer = 15;
      return;
    }

    // Mid-engagement re-target check: if the current target is dead/out of range, drop it.
    if (bot.behavior === 'engage' && bot.targetShipId) {
      const tgt = ships.find(s => s.id === bot.targetShipId);
      if (!tgt || !tgt.alive || tgt.sinking || this.peaceShipIds.has(bot.targetShipId)) {
        bot.targetShipId = null;
        bot.stateTimer = 0; // re-evaluate now
      }
    }

    if (bot.stateTimer <= 0) {
      bot.stateTimer = 6 + Math.random() * 8;

      // Find best target: prefer ships with humans aboard.
      const humanShipIds = new Set<string>();
      for (const p of players) {
        if (!p.isBot && p.shipId && p.state !== 'eliminated') humanShipIds.add(p.shipId);
      }

      let nearest: Ship | null = null;
      let nearestScore = Infinity;
      for (const other of ships) {
        if (other.id === ship.id || !other.alive || other.sinking) continue;
        if (this.peaceShipIds.has(other.id)) continue; // dev bot-peace: never engage this ship

        const d = dist2D(ship.position.x, ship.position.z, other.position.x, other.position.z);
        // Score: distance, but humans get only a modest discount so bots contest players
        // without feeling like they are hard-locked from across the map.
        const score = humanShipIds.has(other.id) ? d * 0.88 : d;
        if (score < nearestScore) { nearestScore = score; nearest = other; }
      }

      // Find island for looting
      let nearIsland: Island | null = null;
      let nearIslandDist = Infinity;
      for (const isl of islands) {
        if (isl.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating)) continue;
        const d = dist2D(ship.position.x, ship.position.z, isl.position.x, isl.position.z);
        if (d < nearIslandDist) { nearIslandDist = d; nearIsland = isl; }
      }

      const nearestActualDist = nearest
        ? dist2D(ship.position.x, ship.position.z, nearest.position.x, nearest.position.z)
        : Infinity;

      // Early-game pacing governor. For the first BOT_EARLY_PEACE_SECONDS bots do
      // not SEEK ship fights — they patrol and loot — unless something shot them
      // (underFireUntil). Half the lobby used to be gone before the first shrink,
      // which collapsed the whole 7-phase storm arc into the opening minutes.
      // After that window the seek radius is a local skirmish range instead of the
      // old map-wide 780/920 that had every bot converging on the player at once.
      const inEarlyWindow = t < BOT_EARLY_PEACE_SECONDS;
      const underFire = t < bot.underFireUntil;
      const phaseRange = BOT_ENGAGE_RANGE_BY_PHASE[
        Math.min(Math.max(0, storm.phase), BOT_ENGAGE_RANGE_BY_PHASE.length - 1)
      ];
      const engageRange = inEarlyWindow
        ? (underFire ? BOT_DEFEND_RANGE : 0)
        : phaseRange * (storm.shrinking ? BOT_ENGAGE_SHRINK_MULT : 1);
      // Concurrency cap on top of the range gate: when the peace window lifted,
      // every bot flipped to 'engage' in the same tick and six crews went down
      // inside 33 s. Only so many crews may be hunting at once (already-engaged
      // bots keep their fight; the cap only gates NEW ones), which spreads the
      // same number of fights across the ring arc.
      const hunterCap = BOT_MAX_HUNTERS_BY_PHASE[
        Math.min(Math.max(0, storm.phase), BOT_MAX_HUNTERS_BY_PHASE.length - 1)
      ];
      const alreadyHunting = bot.behavior === 'engage';
      if (nearestActualDist < engageRange && (alreadyHunting || this.countHunters() < hunterCap)) {
        bot.behavior = 'engage';
        bot.targetShipId = nearest?.id ?? null;
      } else if (nearIsland && nearIslandDist < 540 && Math.random() < 0.28) {
        bot.behavior = 'loot';
        bot.targetIslandId = nearIsland.id;
      } else {
        // No nearby target — pick patrol direction biased toward the storm center
        // so bots converge over time.
        bot.behavior = 'patrol';
        const towardCenter = Math.atan2(
          storm.centerX - ship.position.x,
          storm.centerZ - ship.position.z,
        );
        bot.patrolAngle = towardCenter + (Math.random() - 0.5) * 1.2;
      }
    }
  }

  private executeBehavior(
    bot: BotState, player: Player, ship: Ship,
    ships: Ship[], islands: Island[], storm: StormState,
    dt: number, t: number,
    weaponSystem: WeaponSystem,
    seaRocks: SeaRock[] = [],
  ) {
    // Navigation context for steerToward's obstacle lookahead. A looting bot is
    // deliberately closing on its target island, so that one is exempt.
    this.navIslands = islands;
    this.navSeaRocks = seaRocks;
    this.navSkipIslandId = bot.behavior === 'loot' ? bot.targetIslandId : null;
    // Shore parties belong to the 'loot' behavior only — any other behavior
    // with the body off the ship recalls it aboard after a short grace so a
    // knocked-overboard bot isn't an instant teleport, yet can never strand.
    if (bot.behavior !== 'loot' && !player.onShipId && player.state !== 'eliminated' && player.state !== 'respawning') {
      bot.overboardTimer += dt;
      if (bot.overboardTimer >= 6) {
        this.recallCrewToShip(player, ship);
        this.resetShoreLeg(bot);
        bot.overboardTimer = 0;
      }
    } else {
      bot.overboardTimer = 0;
    }

    switch (bot.behavior) {
      case 'patrol':
        this.steerToward(ship, bot.patrolAngle, dt, t);
        ship.sailHeight = Math.min(ship.sailHeight + dt * 0.08, 0.35);
        ship.anchored = false;
        ship.anchorRaiseProgress = 0;
        this.trimSails(ship, t, dt);
        break;

      case 'engage': {
        const target = ships.find(s => s.id === bot.targetShipId && s.alive);
        if (!target) { bot.behavior = 'patrol'; break; }

        const dx = target.position.x - ship.position.x;
        const dz = target.position.z - ship.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const angleToTarget = Math.atan2(dx, dz);

        const orbitRange = 90;
        if (d > orbitRange * 1.6) {
          this.steerToward(ship, angleToTarget, dt, t);
          ship.sailHeight = Math.min(ship.sailHeight + dt * 0.14, 0.5);
        } else if (d < orbitRange * 0.6) {
          this.steerToward(ship, angleToTarget + Math.PI, dt, t);
          ship.sailHeight = 0.22;
        } else {
          // Broadside — turn perpendicular to target so cannons face them.
          this.steerToward(ship, angleToTarget + Math.PI * 0.5, dt, t);
          ship.sailHeight = 0.16;
        }
        ship.anchored = false;
        ship.anchorRaiseProgress = 0;
        this.trimSails(ship, t, dt);

        // ── Aim with proper ballistic + lead prediction ───────────
        const aim = computeCannonAim(ship, target, bot.difficulty);
        bot.aimYaw = aim.yaw;
        bot.aimPitch = aim.pitch;

        bot.fireTimer -= dt;
        // Fire whenever cooled down + in cannon range. Difficulty controls cadence and accuracy.
        const minDelay = bot.difficulty === 'hard' ? 0.75
          : bot.difficulty === 'medium' ? 2.0
          : 3.5;
        const inCannonRange = d < (bot.difficulty === 'hard' ? 270 : 245);
        if (bot.fireTimer <= 0 && inCannonRange) {
          // Side-aware gunnery: only cannons whose broadside arc actually
          // contains the firing solution shoot — the other rail holds instead
          // of wasting a ball 180° off. Island occlusion also holds fire.
          let fired = false;
          if (this.hasCannonLineOfSight(ship, target, islands)) {
            for (let cidx = 0; cidx < ship.cannonCooldowns.length && !fired; cidx++) {
              if (ship.cannonCooldowns[cidx] > 0) continue;
              const broadsideYaw = weaponSystem.getCannonBroadsideYaw(ship, cidx);
              if (Math.abs(angleWrap(bot.aimYaw - broadsideYaw)) > SHIP.CANNON_YAW_ARC) continue;
              player.atCannon = true;
              player.cannonIndex = cidx;
              const before = ship.cannonCooldowns[cidx];
              weaponSystem.tryFire(player, ship, bot.aimYaw, bot.aimPitch, cidx);
              player.atCannon = false;
              if (ship.cannonCooldowns[cidx] !== before) fired = true;
            }
          }
          // Full cadence after a shot; quick re-check while holding fire.
          bot.fireTimer = fired ? minDelay + Math.random() * 0.6 : 0.35;
        }
        break;
      }

      case 'flee': {
        const angleToCenter = Math.atan2(storm.centerX - ship.position.x, storm.centerZ - ship.position.z);
        this.steerToward(ship, angleToCenter, dt, t);
        ship.sailHeight = Math.min(ship.sailHeight + dt * 0.5, 1.0);
        ship.anchored = false;
        ship.anchorRaiseProgress = 0;
        this.trimSails(ship, t, dt);
        const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
        if (distToCenter < storm.safeRadius * 0.48 && !storm.shrinking) {
          bot.behavior = 'patrol';
          bot.patrolAngle = Math.random() * Math.PI * 2;
          bot.stateTimer = 5 + Math.random() * 8;
        }
        break;
      }

      case 'loot': {
        const island = islands.find(i => i.id === bot.targetIslandId);
        if (!island || island.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating)) {
          if (!player.onShipId && !player.carryingChestId) {
            this.recallCrewToShip(player, ship);
            this.resetShoreLeg(bot);
          }
          bot.behavior = 'patrol';
          break;
        }
        const angleToIsland = Math.atan2(
          island.position.x - ship.position.x,
          island.position.z - ship.position.z,
        );
        const d = dist2D(ship.position.x, ship.position.z, island.position.x, island.position.z);
        // Island footprints are lobed: `radius` is the nominal disc, but land
        // reaches out to getIslandMaxRadius (157m vs a nominal 96m on the
        // caldera). Closing to a fixed radius+40 parked bots several metres
        // INSIDE the hillside, which is where most bot beachings came from.
        // Keep closing only while there is still water under the keel ahead.
        if (d > island.radius + 40 && this.hasSeaRoomAhead(ship, angleToIsland, islands)) {
          this.steerToward(ship, angleToIsland, dt, t);
          ship.sailHeight = 0.32;
          ship.anchored = false;
          ship.anchorRaiseProgress = 0;
          this.trimSails(ship, t, dt);
        } else {
          ship.anchored = true;
          ship.anchorRaiseProgress = 0;
          ship.sailHeight = 0;
          ship.sailAngle *= Math.pow(0.9, dt / 0.016); // frame-rate-independent decay
          this.updateShoreParty(bot, player, ship, island, dt);
        }
        break;
      }

      case 'return': {
        const island = islands.find(candidate => candidate.id === bot.targetIslandId);
        if (!island) {
          bot.behavior = 'patrol';
          break;
        }

        const awayAngle = Math.atan2(
          ship.position.x - island.position.x,
          ship.position.z - island.position.z,
        );
        const distance = dist2D(ship.position.x, ship.position.z, island.position.x, island.position.z);
        if (distance < island.radius + 115) {
          this.steerToward(ship, awayAngle, dt, t);
          ship.sailHeight = Math.min(ship.sailHeight + dt * 0.14, 0.44);
          ship.anchored = false;
          ship.anchorRaiseProgress = 0;
          this.trimSails(ship, t, dt);
        } else {
          bot.behavior = 'patrol';
          bot.targetIslandId = null;
          bot.patrolAngle = awayAngle + (Math.random() - 0.5) * 0.8;
          bot.stateTimer = 7 + Math.random() * 8;
        }
        break;
      }
    }
  }

  /**
   * If an enemy player (human or other bot) is within firearm range and roughly on/near
   * this bot's ship, fire a personal weapon. Match.ts resolves the resulting hitscan trace.
   */
  private maybeFireAtBoarder(
    bot: BotState, player: Player, ship: Ship,
    players: Player[],
    _weaponSystem: WeaponSystem,
  ) {
    if (player.state !== 'alive' || player.atCannon || player.atHelm) return;
    if (bot.firearmTimer > 0) return;

    // Find the closest enemy who is either on the bot's ship or within firearm range.
    let bestTarget: Player | null = null;
    let bestDist = FIREARM_RANGE;
    for (const other of players) {
      if (other.id === player.id) continue;
      if (other.state === 'eliminated' || other.state === 'respawning') continue;
      if (this.peacePlayerIds.has(other.id)) continue; // dev bot-peace: never shoot this player
      // Don't shoot allies on the same ship.
      if (other.shipId === player.shipId && other.isBot) continue;
      const dx = other.position.x - player.position.x;
      const dy = other.position.y - player.position.y;
      const dz = other.position.z - player.position.z;
      const horizontal = Math.sqrt(dx * dx + dz * dz);
      if (horizontal > FIREARM_RANGE) continue;
      if (Math.abs(dy) > 5.8) continue; // ignore vertical extremes (swimmers far below)
      // Bias toward boarders (same ship).
      const score = other.onShipId === ship.id ? horizontal * 0.4 : horizontal;
      if (score < bestDist) { bestDist = score; bestTarget = other; }
    }
    if (!bestTarget) return;

    // Pick the most appropriate weapon by range.
    const desiredWeaponId = this.selectFirearm(bestDist, bot.difficulty);
    const slot = player.weapons.findIndex((w) => w?.weaponId === desiredWeaponId);
    if (slot < 0) return;
    const weapon = player.weapons[slot];
    if (!weapon) return;
    if (weapon.reloading || weapon.ammo <= 0) {
      // Don't waste a tick — bots trigger reload via WeaponSystem.tryFire below.
    }
    player.activeSlot = slot as 0 | 1 | 2 | 3;

    const aimPoint: Vec3 = {
      x: bestTarget.position.x,
      y: bestTarget.position.y + FIREARM_AIM_HEIGHT,
      z: bestTarget.position.z,
    };
    const dx = aimPoint.x - player.position.x;
    const dy = aimPoint.y - (player.position.y + FIREARM_AIM_HEIGHT);
    const dz = aimPoint.z - player.position.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, horizontal);

    // Apply difficulty-based aim noise — a few degrees of jitter.
    const noise = bot.difficulty === 'hard' ? 0.018 : bot.difficulty === 'medium' ? 0.06 : 0.11;
    const noisyAim: Vec3 = {
      x: aimPoint.x + (Math.random() - 0.5) * noise * bestDist,
      y: aimPoint.y + (Math.random() - 0.5) * noise * bestDist,
      z: aimPoint.z + (Math.random() - 0.5) * noise * bestDist,
    };

    player.rotation.x = yaw;
    player.rotation.y = pitch;

    this.pendingFirearmFires.push({
      playerId: player.id,
      aimPoint: noisyAim,
      yaw,
      pitch,
    });

    bot.firearmTimer = bot.difficulty === 'hard' ? 1.1
      : bot.difficulty === 'medium' ? 2.1
      : 3.1;
  }

  private selectFirearm(distance: number, _difficulty: 'easy' | 'medium' | 'hard'): WeaponId {
    if (distance > 18) return 'eye_of_reach';
    if (distance > 9) return 'flintknock';
    return 'blunderbuss';
  }

  private steerToward(ship: Ship, targetAngle: number, dt: number, t: number) {
    // Land/rock avoidance FIRST: bots used to sail dead straight at their target
    // and beach themselves on anything in between (zero avoidance terms existed).
    let desired = this.avoidObstacles(ship, targetAngle);
    // Upwind no-go awareness: a course inside the cone is unsailable — offset
    // to the nearer ~40°-off-the-wind tack instead of pinching straight in.
    const wind = sampleWind(t);
    const upwind = angleWrap(wind.direction + Math.PI);
    const offUpwind = angleWrap(desired - upwind);
    if (Math.abs(offUpwind) < SHIP.SAIL_NO_GO_ANGLE) {
      desired = upwind + (offUpwind >= 0 ? 1 : -1) * (SHIP.SAIL_NO_GO_ANGLE + 0.09);
    }
    // Same rudder physics as the player helm (negative steer turns toward a
    // positive heading error); turning still requires way on the ship.
    const diff = angleWrap(desired - ship.rotation);
    const steer = Math.max(-1, Math.min(1, -diff * 1.5));
    applyShipRudderSteering(ship, dt, steer, 0.36 + ship.sailHeight * 0.52);
    // Rotation is integrated once for all ships in PhysicsSystem.updateShips;
    // integrating here too would double the bot turn rate.
  }

  /**
   * Is there still water under the keel along `heading`? Samples the seabed a
   * hull-length-and-a-bit ahead against the SAME draft the grounding resolve
   * uses, so an approaching bot stops in floating water instead of at a nominal
   * radius that can sit well inside the shore.
   */
  private hasSeaRoomAhead(ship: Ship, heading: number, islands: Island[]): boolean {
    const stats = SHIP_STATS[ship.type];
    const need = -(stats.height * SHIP.HULL_DRAFT_F[ship.type] + BOT_KEEL_CLEARANCE);
    const dirX = Math.sin(heading);
    const dirZ = Math.cos(heading);
    const half = stats.length * 0.5;
    for (const ahead of [half + 4, half + 18, half + 32]) {
      const x = ship.position.x + dirX * ahead;
      const z = ship.position.z + dirZ * ahead;
      for (const island of islands) {
        const dx = x - island.position.x;
        const dz = z - island.position.z;
        const reach = getIslandMaxRadius(island) + 20;
        if (dx * dx + dz * dz > reach * reach) continue;
        if (getIslandSurfaceY(island, x, z) > need) return false;
      }
    }
    return true;
  }

  /**
   * Steer around land and sea rocks: probe BOT_LOOKAHEAD_METERS along the desired
   * heading and, if the swept path clips an obstacle's inflated circle, aim at the
   * nearer tangent instead. Only the closest blocker is resolved — the next tick
   * re-probes, which is enough to skirt an island smoothly and keeps the whole
   * thing deterministic (no randomness, no per-bot memory).
   */
  private avoidObstacles(ship: Ship, desired: number): number {
    const look = BOT_LOOKAHEAD_METERS + SHIP_STATS[ship.type].length;
    const dirX = Math.sin(desired);
    const dirZ = Math.cos(desired);
    let blocker: { angle: number; distance: number; clear: number; side: number } | null = null;

    const consider = (ox: number, oz: number, radius: number) => {
      const dx = ox - ship.position.x;
      const dz = oz - ship.position.z;
      const along = dx * dirX + dz * dirZ;
      if (along < -radius || along > look) return;
      const cross = dx * dirZ - dz * dirX; // signed lateral offset from the path
      if (Math.abs(cross) > radius) return;
      const distance = Math.hypot(dx, dz);
      if (blocker && distance >= blocker.distance) return;
      blocker = {
        angle: Math.atan2(dx, dz),
        distance,
        clear: radius,
        side: cross >= 0 ? -1 : 1,
      };
    };

    for (const island of this.navIslands) {
      if (island.id === this.navSkipIslandId) continue;
      consider(island.position.x, island.position.z, getIslandMaxRadius(island) + BOT_OBSTACLE_MARGIN);
    }
    for (const rock of this.navSeaRocks) {
      consider(rock.position.x, rock.position.z, (rock.colliderBoundsRadius || rock.radius) + BOT_OBSTACLE_MARGIN * 0.5);
    }
    if (!blocker) return desired;

    const hit = blocker as { angle: number; distance: number; clear: number; side: number };
    // Already inside the danger circle: turn straight out of it.
    if (hit.distance <= hit.clear) return angleWrap(hit.angle + Math.PI);
    const offset = Math.asin(Math.min(1, hit.clear / hit.distance)) + 0.08;
    return angleWrap(hit.angle + hit.side * offset);
  }

  /** Straight-line island occlusion check from this deck to the target's deck. */
  private hasCannonLineOfSight(ship: Ship, target: Ship, islands: Island[]): boolean {
    const origin = {
      x: ship.position.x,
      y: ship.position.y + SHIP_STATS[ship.type].height + 1.1,
      z: ship.position.z,
    };
    const dx = target.position.x - origin.x;
    const dy = target.position.y + SHIP_STATS[target.type].height + 0.6 - origin.y;
    const dz = target.position.z - origin.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1) return true;
    const hit = raymarchIslandSurface(
      origin,
      { x: dx / dist, y: dy / dist, z: dz / dist },
      Math.max(0, dist - SHIP_STATS[target.type].length * 0.4),
      islands,
    );
    return !hit.hit;
  }

  /**
   * Walk the bot's body across the island: ship → chest, then (carrying) back
   * to the hull, where Match.processBotLooting boards + stows. A generous
   * timeout per leg falls back to the legacy warp so bots can never brick.
   */
  private updateShoreParty(bot: BotState, player: Player, ship: Ship, island: Island, dt: number) {
    const stats = SHIP_STATS[ship.type];

    if (player.carryingChestId) {
      // Haul the chest home; Match boards + stows once we reach the hull.
      if (bot.shoreLeg !== 'toShip') {
        bot.shoreLeg = 'toShip';
        bot.shoreTimer = this.shoreLegBudget(
          dist2D(player.position.x, player.position.z, ship.position.x, ship.position.z),
        );
      }
      bot.shoreTimer -= dt;
      if (bot.shoreTimer <= 0) {
        player.position.x = ship.position.x;
        player.position.y = ship.position.y + 0.4;
        player.position.z = ship.position.z;
        return;
      }
      this.walkBotToward(player, ship.position.x, ship.position.z, dt);
      return;
    }

    const chest = island.chests.find(candidate => !candidate.opened && !candidate.carriedByPlayerId && !candidate.storedOnShipId && !candidate.floating);
    if (!chest) {
      if (!player.onShipId) {
        this.recallCrewToShip(player, ship);
        this.resetShoreLeg(bot);
      }
      bot.behavior = 'return';
      bot.stateTimer = 8 + Math.random() * 6;
      ship.anchored = false;
      ship.anchorRaiseProgress = 0;
      return;
    }

    if (player.onShipId) {
      // Step off the rail toward the chest and start the walk timer.
      const dx = chest.position.x - ship.position.x;
      const dz = chest.position.z - ship.position.z;
      const len = Math.hypot(dx, dz) || 1;
      player.onShipId = null;
      player.state = 'alive';
      player.atCannon = false;
      player.atHelm = false;
      player.atSails = false;
      player.atCrowNest = false;
      player.position.x = ship.position.x + (dx / len) * (stats.width * 0.5 + 1.6);
      player.position.z = ship.position.z + (dz / len) * (stats.width * 0.5 + 1.6);
      player.position.y = ship.position.y + 0.4;
      player.velocity = { x: 0, y: 0, z: 0 };
      bot.shoreLeg = 'toChest';
      bot.shoreTimer = this.shoreLegBudget(len);
      return;
    }

    const dChest = dist2D(player.position.x, player.position.z, chest.position.x, chest.position.z);
    if (dChest <= 1.2) {
      // Standing on the X — Match digs + picks up via the proximity flag; the
      // carrying branch above budgets the trip home next tick.
      player.nearChestId = chest.id;
      return;
    }
    bot.shoreTimer -= dt;
    if (bot.shoreTimer <= 0) {
      // Timeout fallback — the legacy teleport straight to the chest.
      const groundY = getIslandSurfaceY(island, chest.position.x, chest.position.z);
      player.position.x = chest.position.x;
      player.position.y = groundY + 0.18;
      player.position.z = chest.position.z;
      player.nearChestId = chest.id;
      bot.shoreTimer = 30;
      return;
    }
    this.walkBotToward(player, chest.position.x, chest.position.z, dt);
  }

  /** Generous walking-time budget for one shore-party leg before the legacy
   *  warp fallback rescues the bot (distance-scaled — far chests need longer). */
  private shoreLegBudget(distance: number): number {
    const walkSeconds = distance / (PLAYER.MOVE_SPEED * 0.92);
    return Math.min(75, Math.max(20, walkSeconds * 1.8));
  }

  /** Step the bot's body toward a point; PhysicsSystem owns ground snap /
   *  swimming transitions, so only the horizontal walk lives here. */
  private walkBotToward(player: Player, tx: number, tz: number, dt: number) {
    const dx = tx - player.position.x;
    const dz = tz - player.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) return;
    const speed = player.state === 'swimming' ? PLAYER.SWIM_SPEED * 0.85 : PLAYER.MOVE_SPEED * 0.92;
    const step = Math.min(d, speed * dt);
    player.position.x += (dx / d) * step;
    player.position.z += (dz / d) * step;
    player.rotation.x = Math.atan2(dx, dz);
  }

  /** Emergency recall: pop the crew back on deck (bots must never be stranded). */
  private recallCrewToShip(player: Player, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    player.onShipId = ship.id;
    player.state = 'alive';
    player.position = {
      x: ship.position.x,
      y: ship.position.y + stats.height + 0.3,
      z: ship.position.z,
    };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.swimTimer = 0;
    player.nearChestId = null;
  }

  private resetShoreLeg(bot: BotState) {
    bot.shoreLeg = null;
    bot.shoreTimer = 0;
  }

  private trimSails(ship: Ship, t: number, dt: number) {
    const wind = sampleWind(t);
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
    const delta = desiredTrim - ship.sailAngle;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), SHIP.SAIL_TRIM_RATE * 0.9 * dt);
    ship.sailAngle += step;
  }

  removeBot(playerId: string) {
    this.bots.delete(playerId);
  }

  getBotCount(): number {
    return this.bots.size;
  }
}

/**
 * Compute a yaw + pitch that lands a cannonball on `target` at its predicted position.
 * Accounts for cannon launch speed, gravity multiplier, and the +5 vy boost the cannon adds.
 * Difficulty mostly controls aim noise (lead is always applied — the original "no lead for
 * easy/medium" felt random and bad).
 */
function computeCannonAim(
  ship: Ship,
  target: Ship,
  difficulty: 'easy' | 'medium' | 'hard',
): { yaw: number; pitch: number } {
  const v = SHIP.CANNON_SPEED;
  const g = CANNON_GRAVITY;

  // ── 1. Predict target position by lead time ─────────────────
  // Use a 1-step iteration: estimate t with current distance, recompute predicted point.
  const dxNow = target.position.x - ship.position.x;
  const dzNow = target.position.z - ship.position.z;
  const distNow = Math.sqrt(dxNow * dxNow + dzNow * dzNow);
  const tFlight = distNow / v;
  const leadX = target.position.x + target.velocity.x * tFlight;
  const leadZ = target.position.z + target.velocity.z * tFlight;

  let yaw = Math.atan2(leadX - ship.position.x, leadZ - ship.position.z);

  // Refine once with the predicted distance (better lead at long range).
  const dxLead = leadX - ship.position.x;
  const dzLead = leadZ - ship.position.z;
  const dist = Math.sqrt(dxLead * dxLead + dzLead * dzLead);

  // ── 2. Solve ballistic pitch ────────────────────────────────
  // Same height assumption: target deck ≈ ship deck. Includes vy0 boost via iteration.
  const targetYDelta = (target.position.y - ship.position.y) || 0;
  let pitch = ballisticPitch(dist, v, g, CANNON_VY_BOOST, targetYDelta);

  // ── 3. Inject difficulty-tuned noise ────────────────────────
  const yawJitter = difficulty === 'hard' ? 0.005
    : difficulty === 'medium' ? 0.022
    : 0.05;
  const pitchJitter = difficulty === 'hard' ? 0.004
    : difficulty === 'medium' ? 0.018
    : 0.04;
  yaw += (Math.random() - 0.5) * yawJitter * 2;
  pitch += (Math.random() - 0.5) * pitchJitter * 2;

  return { yaw, pitch: Math.max(0.02, Math.min(0.6, pitch)) };
}

/**
 * Numerically solve for launch pitch given:
 *   v       — initial speed
 *   g       — gravity magnitude (positive)
 *   d       — horizontal distance to target
 *   vyBoost — extra vy applied at muzzle (cannon adds +5)
 *   yDelta  — target_y - launcher_y (≈ 0 for ship-to-ship)
 *
 * Iterates a few Newton-style refinements; converges within 3 iterations
 * for ranges ≤ 280m and physically valid pitches.
 */
function ballisticPitch(
  d: number,
  v: number,
  g: number,
  vyBoost: number,
  yDelta: number,
): number {
  if (d < 1) return 0.05;
  // Initial guess from no-vy0-boost closed form.
  const ratio = Math.min(0.95, (g * d) / (v * v));
  let theta = 0.5 * Math.asin(ratio);

  for (let i = 0; i < 4; i++) {
    const vh = v * Math.cos(theta);
    if (vh < 0.1) break;
    const vy0 = v * Math.sin(theta) + vyBoost;
    const t = d / vh;
    const yLanding = vy0 * t - 0.5 * g * t * t;
    const error = yLanding - yDelta;
    // Adjust: if landing too high, reduce theta; too low, raise it.
    // Sensitivity ≈ d (rough).
    const adjust = -error / Math.max(20, d);
    theta += Math.max(-0.06, Math.min(0.06, adjust));
    theta = Math.max(0.01, Math.min(0.7, theta));
  }
  return theta;
}
