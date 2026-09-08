import type { Player, Ship, Island, SeaRock, StormState, TreasureChest, Vec3, WeaponId } from '../../../shared/types/index.js';
import {
  SHIP_STATS, SHIP, PLAYER, WEAPONS, BOT_LOOKAHEAD_METERS, BOT_OBSTACLE_MARGIN, BOT_KEEL_CLEARANCE, BOT_CANNON_CADENCE_BY_PHASE, BOT_CANNON_ACCURACY_BY_PHASE, botPhaseScale, WRECK_EVENT,
} from '../../../shared/constants/index.js';
import { dist2D, angleWrap, sampleLocalWind, getIslandSurfaceY, getIslandMaxRadius, getShipDeckY, getShipDeckRaiseAt } from '../../../shared/utils/index.js';
import { raymarchIslandSurface, intersectRayShipHull } from '../../../shared/raycast.js';
import { getCannonBroadsideYaw, getHelmControlLocal } from '../../../shared/interactions.js';
import { applyShipRudderSteering } from '../PhysicsSystem.js';
import type { WeaponSystem } from '../WeaponSystem.js';
import type { Blackboard } from './Blackboard.js';
import type { BotState, CrewState } from './Blackboard.js';
import { BOT_TIERS, BOT_GUNNERY_HOLD } from './personalities.js';
import { hullTotal, BOT_ANCHOR_RAISE_FACTOR, BOT_SAIL_RAISE_RATE, BOT_SAIL_LOWER_RATE, CANNON_GRAVITY, CANNON_VY_BOOST, FIREARM_RANGE, FIREARM_AIM_HEIGHT, BOT_RETALIATE_SECONDS, BOT_FIREARM_TURN_RATE, BOT_FIREARM_AIM_TOLERANCE, BOT_AMMO_LULL_SECONDS, BOT_AMMO_TOPUP_SECONDS, botMayFireCannons, isMooredAtBerth } from './Blackboard.js';
import type { BotCrew } from './BotCrew.js';

/**
 * ONE PIRATE'S HANDS (BOTCREW-01 / bots-v02).
 *
 * The execution half of the bot brain: given the crew's decision, this moves a
 * BODY — the helm, a gun, a bucket, a plank, a shore party. Nothing here
 * decides anything; every branch reads `crew.behavior`.
 */
export class BotPirate {
  /** Navigation context for steerToward's obstacle lookahead (set per body each tick). */
  private navIslands: Island[] = [];
  private navSeaRocks: SeaRock[] = [];
  private navSkipIslandId: string | null = null;

  constructor(private readonly bb: Blackboard, private readonly crew: BotCrew) {}


  /**
   * WEIGH ANCHOR THROUGH THE CAPSTAN (bots-06). Eight sites in the old brain
   * set `ship.anchored = false` in the same tick they decided to leave, while a
   * human works the capstan for SHIP.ANCHOR_RAISE_TIME (x1.35 when he calls it
   * from the wheel). A bot leaving a berth the instant she changes her mind is
   * the most visible of the small cheats: you watch her anchor chain do nothing.
   */
  weighAnchor(ship: Ship, dt: number): boolean {
    if (!ship.anchored) { ship.anchorRaiseProgress = 1; return true; }
    ship.anchorRaiseProgress = Math.min(1, (ship.anchorRaiseProgress ?? 0)
      + dt / (SHIP.ANCHOR_RAISE_TIME * BOT_ANCHOR_RAISE_FACTOR));
    if (ship.anchorRaiseProgress < 1) return false;
    ship.anchored = false;
    return true;
  }

  /**
   * MAKE OR SHORTEN SAIL AT THE RATE HANDS CAN HAUL (bots-06). Same 0.22/0.28
   * per second the player helm uses, and the same clamp to `sailIntegrity` — a
   * chainshotted bot can no longer snap back to full canvas the tick after her
   * rig is cut.
   */
  setSail(ship: Ship, target: number, dt: number) {
    const want = Math.max(0, Math.min(target, ship.sailIntegrity ?? 1));
    if (ship.sailHeight < want) ship.sailHeight = Math.min(want, ship.sailHeight + BOT_SAIL_RAISE_RATE * dt);
    else if (ship.sailHeight > want) ship.sailHeight = Math.max(want, ship.sailHeight - BOT_SAIL_LOWER_RATE * dt);
  }

  /**
   * PUT THE HELMSMAN ON THE QUARTERDECK (bots-v02).
   *
   * Two things follow from `player.atHelm`, and the bot brain had neither:
   * PhysicsSystem counts the hull as HELMED (no un-helmed rudder decay, which
   * alone was 0.43x of a player's turn rate), and everyone who looks at her —
   * the client animator, a boarder at the top of the ladder, Match's station
   * arbiter — sees a pirate standing at the wheel instead of an empty
   * quarterdeck with broadsides coming out of it.
   */
  private standStation(bot: BotState, player: Player, ship: Ship) {
    const helm = bot.role === 'helm' && player.onShipId === ship.id && bot.shoreLeg === null;
    if (!helm) {
      if (player.atHelm) player.atHelm = false;
      return;
    }
    player.atHelm = true;
    const stats = SHIP_STATS[ship.type];
    const local = getHelmControlLocal(stats);
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    player.position.x = ship.position.x + local.x * cos + local.z * sin;
    player.position.z = ship.position.z + local.z * cos - local.x * sin;
    player.position.y = getShipDeckY(ship.position.y, stats) + getShipDeckRaiseAt(local, stats);
    player.rotation.x = ship.rotation;
    player.velocity.x = 0;
    player.velocity.z = 0;
  }

  executeBehavior(
    crew: CrewState, bot: BotState, player: Player, ship: Ship,
    ships: Ship[], islands: Island[], storm: StormState,
    dt: number, t: number,
    weaponSystem: WeaponSystem,
    seaRocks: SeaRock[] = [],
  ) {
    // Navigation context for steerToward's obstacle lookahead. A looting bot is
    // deliberately closing on its target island, so that one is exempt.
    this.navIslands = islands;
    this.navSeaRocks = seaRocks;
    this.navSkipIslandId = crew.behavior === 'loot' ? crew.targetIslandId : null;
    this.standStation(bot, player, ship);
    // Shore parties belong to the 'loot' and 'plunder' behaviors only — any
    // other behavior with the body off the ship recalls it aboard after a short
    // grace so a knocked-overboard bot isn't an instant teleport, yet can never
    // strand.
    if (crew.behavior !== 'loot' && crew.behavior !== 'plunder'
      && !player.onShipId && player.state !== 'eliminated' && player.state !== 'respawning') {
      bot.overboardTimer += dt;
      if (bot.overboardTimer >= 6) {
        this.recallCrewToShip(player, ship);
        this.resetShoreLeg(bot);
        bot.overboardTimer = 0;
      }
    } else {
      bot.overboardTimer = 0;
    }

    switch (crew.behavior) {
      case 'patrol':
        this.steerToward(ship, crew.patrolAngle, dt, t);
        this.weighAnchor(ship, dt);
        this.setSail(ship, 0.35, dt);
        this.trimSails(ship, t, dt);
        break;

      case 'engage': {
        const target = ships.find(s => s.id === crew.targetShipId && s.alive);
        if (!target) { crew.behavior = 'patrol'; break; }

        const dx = target.position.x - ship.position.x;
        const dz = target.position.z - ship.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const angleToTarget = Math.atan2(dx, dz);

        // HOW THIS CAPTAIN CLOSES (BOTFUN-01). One flat 90 m circle for nine
        // crews is what made every bot fight look like the same fight.
        //  rake          — cross her stern: hold the broadside band, but bias
        //                  the turn toward the quarter she cannot answer from.
        //  weather_gauge — keep the wind, fight long, never let her close.
        //  ram           — a wounded hull is boarded, not shelled.
        const orbitRange = crew.personality.orbitRange;
        const manoeuvre = crew.personality.manoeuvre;
        const charging = manoeuvre === 'ram' && hullTotal(target) < 1.6;
        // A CREW ALREADY IN GUN RANGE FIGHTS WHERE SHE STANDS. The preferred
        // band is where a captain SAILS to, not a rule that turns her bow-on to
        // a hull she could already hit: a Corsair at 110 m used to break off the
        // broadside to close 36 m and stopped shooting while she did it
        // (test-bot-crew-roles: hull a fired nothing in thirty seconds).
        if (charging) {
          // Straight down her throat; the collision and the boarders do the rest.
          this.steerToward(ship, angleToTarget, dt, t);
          this.setSail(ship, 0.85, dt);
        } else if (d > orbitRange * 1.45 && d > BOT_GUNNERY_HOLD) {
          this.steerToward(ship, angleToTarget, dt, t);
          this.setSail(ship, 0.5, dt);
        } else if (d < orbitRange * 0.7) {
          this.steerToward(ship, angleToTarget + Math.PI, dt, t);
          this.setSail(ship, 0.22, dt);
        } else {
          // Broadside — turn perpendicular to target so cannons face them.
          // A raker leans the circle 25 degrees toward the target's stern; a
          // weather-gauge captain leans the other way, upwind, to hold the
          // advantage she picked the range for.
          const sternBias = manoeuvre === 'rake'
            ? Math.sign(angleWrap(target.rotation - angleToTarget)) * 0.44
            : manoeuvre === 'weather_gauge' ? -0.3 : 0;
          this.steerToward(ship, angleToTarget + Math.PI * 0.5 + sternBias, dt, t);
          this.setSail(ship, 0.16, dt);
        }
        this.weighAnchor(ship, dt);
        this.trimSails(ship, t, dt);

        // ── Aim with proper ballistic + lead prediction ───────────
        // Gun crews sharpen as the ring closes: same difficulty, later weather.
        const aim = computeCannonAim(this.bb.rng, ship, target, crew.difficulty,
          botPhaseScale(BOT_CANNON_ACCURACY_BY_PHASE, storm.phase));
        bot.aimYaw = aim.yaw;
        bot.aimPitch = aim.pitch;

        bot.fireTimer -= dt;
        // Fire whenever cooled down + in cannon range. Difficulty sets the base
        // cadence and accuracy; the STORM PHASE scales both, so the opening keeps
        // its gentle bots and the endgame actually converts (see
        // BOT_CANNON_CADENCE_BY_PHASE).
        const baseDelay = crew.difficulty === 'hard' ? 0.75
          : crew.difficulty === 'medium' ? 2.0
          : 3.5;
        const minDelay = baseDelay * BOT_TIERS[crew.difficulty].cadenceMult
          * botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, storm.phase);
        const inCannonRange = d < (crew.difficulty === 'hard' ? 270 : 245);
        // The peace covers the guns too — an unprovoked bot shadows its neighbour
        // with the ports shut. Timer is held just short of ready so the window
        // lifting doesn't fire nine simultaneous broadsides.
        if (!botMayFireCannons(t, crew.underFireUntil, target, islands, crew.retaliateShipId)) {
          bot.fireTimer = Math.max(bot.fireTimer, 0.35);
          // She went back to her berth and anchored: leave her be rather than
          // circling her with the ports shut (berth truce, liveplay-19).
          if (isMooredAtBerth(target, islands)) { crew.behavior = 'patrol'; crew.targetShipId = null; }
          break;
        }
        if (bot.fireTimer <= 0 && inCannonRange) {
          // Side-aware gunnery: only cannons whose broadside arc actually
          // contains the firing solution shoot — the other rail holds instead
          // of wasting a ball 180° off. Island occlusion also holds fire.
          let fired = false;
          if (this.hasCannonLineOfSight(ship, target, islands)) {
            for (let cidx = 0; cidx < ship.cannonCooldowns.length && !fired; cidx++) {
              if (ship.cannonCooldowns[cidx] > 0) continue;
              const broadsideYaw = getCannonBroadsideYaw(ship, cidx);
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
          if (fired) crew.lastFiredAt = t;
          bot.fireTimer = fired ? minDelay + this.bb.rng() * 0.6 : 0.35;
        }
        break;
      }

      case 'flee': {
        const angleToCenter = Math.atan2(storm.centerX - ship.position.x, storm.centerZ - ship.position.z);
        this.steerToward(ship, angleToCenter, dt, t);
        this.weighAnchor(ship, dt);
        this.setSail(ship, 1.0, dt);
        this.trimSails(ship, t, dt);
        const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
        if (distToCenter < storm.safeRadius * 0.48 && !storm.shrinking) {
          crew.behavior = 'patrol';
          crew.patrolAngle = this.bb.rng() * Math.PI * 2;
          crew.stateTimer = 5 + this.bb.rng() * 8;
        }
        break;
      }

      case 'loot': {
        const island = islands.find(i => i.id === crew.targetIslandId);
        if (!island || island.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating)) {
          if (!player.onShipId && !player.carryingChestId) {
            this.recallCrewToShip(player, ship);
            this.resetShoreLeg(bot);
          }
          crew.behavior = 'patrol';
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
          this.weighAnchor(ship, dt);
          this.setSail(ship, 0.32, dt);
          this.trimSails(ship, t, dt);
        } else {
          ship.anchored = true;
          ship.anchorRaiseProgress = 0;
          this.setSail(ship, 0, dt);
          ship.sailAngle *= Math.pow(0.9, dt / 0.016); // frame-rate-independent decay
          this.updateShoreParty(crew, bot, player, ship, island, dt);
        }
        break;
      }

      // BOARDING THE GILDED WRECK. Same shape as a shore party, over water: the
      // hull heaves to alongside, one pirate goes over the side, swims to a
      // chest and hauls it back. Match's processBotLooting resolves the pickup
      // and the stow through exactly the paths a human uses.
      case 'plunder': {
        const lure = this.bb.eventLure;
        if (!lure) {
          this.endPlunder(crew, bot, player, ship);
          break;
        }
        const chest = player.carryingChestId ? null : this.crew.freeEventChest(islands, crew);
        // Keep the claim current for the whole sail-in, not just the last 62 m:
        // if this crew had to re-pick (somebody stowed the mark it wanted) the
        // board has to show the NEW mark, or the chest it is now swimming for
        // reads as free to everyone else.
        if (chest) crew.plunderChestId = chest.id;
        if (!chest && !player.carryingChestId) {
          // Picked clean (or somebody beat us to the last of her): stand off and
          // keep the mark in sight — there is still a fight to be had over her.
          this.endPlunder(crew, bot, player, ship);
          crew.patrolAngle = this.crew.lureBearing(ship) ?? crew.patrolAngle;
          break;
        }
        const d = dist2D(ship.position.x, ship.position.z, lure.x, lure.z);
        if (d > WRECK_EVENT.PLUNDER_RANGE && player.onShipId) {
          this.steerToward(ship, Math.atan2(lure.x - ship.position.x, lure.z - ship.position.z), dt, t);
          this.weighAnchor(ship, dt);
          this.setSail(ship, 0.42, dt);
          this.trimSails(ship, t, dt);
          break;
        }
        // Hove to over her. Anchored, sails in, guns unmanned: this is the crew
        // every other crew at the wreck would rather be shooting at.
        ship.anchored = true;
        ship.anchorRaiseProgress = 0;
        this.setSail(ship, 0, dt);
        ship.sailAngle *= Math.pow(0.9, dt / 0.016);
        this.updateWreckParty(crew, bot, player, ship, chest, dt);
        break;
      }

      case 'return': {
        const island = islands.find(candidate => candidate.id === crew.targetIslandId);
        if (!island) {
          crew.behavior = 'patrol';
          break;
        }

        const awayAngle = Math.atan2(
          ship.position.x - island.position.x,
          ship.position.z - island.position.z,
        );
        const distance = dist2D(ship.position.x, ship.position.z, island.position.x, island.position.z);
        if (distance < island.radius + 115) {
          this.steerToward(ship, awayAngle, dt, t);
          this.weighAnchor(ship, dt);
          this.setSail(ship, 0.44, dt);
          this.trimSails(ship, t, dt);
        } else {
          crew.behavior = 'patrol';
          crew.targetIslandId = null;
          crew.patrolAngle = awayAngle + (this.bb.rng() - 0.5) * 0.8;
          crew.stateTimer = 7 + this.bb.rng() * 8;
        }
        break;
      }
    }
  }

  /**
   * Personal weapons. If an ENEMY THREAT is within firearm range and roughly at
   * deck height, turn to face him and fire; Match.ts resolves the hitscan.
   *
   * THE PEACE INCLUDES THE PISTOLS (BOT-01 / bots-01). The cannon path has
   * always run through botMayFireCannons; this one ran for every bot every tick
   * with no clock at all, so a human 20 m off a looting bot's rail at t=40 s
   * took a Wrecker's Glass round — the "executed at the central dock" report.
   * A pirate is a threat when (a) the guns are free anyway (peace lifted, or
   * this crew is under fire), OR (b) he is physically aboard OUR hull, OR
   * (c) he hurt this pirate recently (Match stamps lastDamagedById/At on every
   * firearm, blade and keg hit). Nothing else is shot at inside the window.
   */
  maybeFireAtBoarder(
    crew: CrewState, bot: BotState, player: Player, ship: Ship,
    players: Player[], ships: Ship[], islands: Island[],
    dt: number, t: number,
  ) {
    if (player.state !== 'alive' || player.atCannon || player.atHelm) return;

    const gunsFree = botMayFireCannons(t, crew.underFireUntil);
    // Find the closest enemy who is either on the bot's ship or within firearm range.
    let bestTarget: Player | null = null;
    let bestDist = FIREARM_RANGE;
    for (const other of players) {
      if (other.id === player.id) continue;
      if (other.state === 'eliminated' || other.state === 'respawning') continue;
      if (this.bb.peacePlayerIds.has(other.id)) continue; // dev bot-peace: never shoot this player
      // Don't shoot allies on the same ship.
      if (other.shipId === player.shipId && other.isBot) continue;
      const aboard = other.onShipId === ship.id;
      if (!gunsFree && !aboard && !this.hurtUsRecently(player, other, t)) continue;
      const dx = other.position.x - player.position.x;
      const dy = other.position.y - player.position.y;
      const dz = other.position.z - player.position.z;
      const horizontal = Math.sqrt(dx * dx + dz * dz);
      if (horizontal > FIREARM_RANGE) continue;
      if (Math.abs(dy) > 5.8) continue; // ignore vertical extremes (swimmers far below)
      // Bias toward boarders (same ship).
      const score = aboard ? horizontal * 0.4 : horizontal;
      if (score < bestDist) { bestDist = score; bestTarget = other; }
    }
    if (!bestTarget) return;
    bot.lastFirearmThreatAt = t;

    // Pick the most appropriate weapon by range — one that still has rounds.
    const slot = this.pickFirearmSlot(player, bestDist);
    if (slot < 0) return;
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

    // Turn the BODY at a finite rate; the shot waits for the facing.
    const rate = BOT_FIREARM_TURN_RATE[crew.difficulty];
    const off = angleWrap(yaw - player.rotation.x);
    const step = Math.max(-rate * dt, Math.min(rate * dt, off));
    player.rotation.x = angleWrap(player.rotation.x + step);
    player.rotation.y = pitch;

    if (bot.firearmTimer > 0) return;
    if (Math.abs(angleWrap(yaw - player.rotation.x)) > BOT_FIREARM_AIM_TOLERANCE) return;
    if (!this.hasFirearmLineOfSight(player, aimPoint, ships, islands)) return;

    // Apply difficulty-based aim noise — a few degrees of jitter.
    const noise = crew.difficulty === 'hard' ? 0.018 : crew.difficulty === 'medium' ? 0.06 : 0.11;
    const noisyAim: Vec3 = {
      x: aimPoint.x + (this.bb.rng() - 0.5) * noise * bestDist,
      y: aimPoint.y + (this.bb.rng() - 0.5) * noise * bestDist,
      z: aimPoint.z + (this.bb.rng() - 0.5) * noise * bestDist,
    };

    this.bb.pendingFirearmFires.push({
      playerId: player.id,
      aimPoint: noisyAim,
      yaw: player.rotation.x,
      pitch,
    });

    bot.firearmTimer = crew.difficulty === 'hard' ? 1.1
      : crew.difficulty === 'medium' ? 2.1
      : 3.1;
  }

  /** Did `other` hurt this pirate inside the retaliation window? Match stamps
   *  lastDamagedById/lastDamagedAt on every firearm, blade and keg hit. */
  hurtUsRecently(player: Player, other: Player, t: number): boolean {
    if (player.lastDamagedById !== other.id || player.lastDamagedAt === null) return false;
    return t - player.lastDamagedAt < BOT_RETALIATE_SECONDS;
  }

  /** Weapon slot for this range that still has a round to fire or load, or -1
   *  when the pirate is dry. Range order: long → Glass, mid → flintknock,
   *  close → blunderbuss, then the next-best piece that has powder. */
  pickFirearmSlot(player: Player, distance: number): number {
    const order: WeaponId[] = distance > 18
      ? ['eye_of_reach', 'flintknock', 'blunderbuss']
      : distance > 9
        ? ['flintknock', 'eye_of_reach', 'blunderbuss']
        : ['blunderbuss', 'flintknock', 'eye_of_reach'];
    for (const id of order) {
      const slot = player.weapons.findIndex((w) => w?.weaponId === id);
      if (slot < 0) continue;
      const weapon = player.weapons[slot];
      if (!weapon) continue;
      if (weapon.ammo > 0 || weapon.reserve > 0) return slot;
    }
    return -1;
  }

  /** Nothing solid between the muzzle and the target's chest: islands and any
   *  hull that is not the shooter's own (Match clamps the trace on exactly the
   *  same occluders, so a shot held here is a shot that would have hit planking). */
  hasFirearmLineOfSight(player: Player, aimPoint: Vec3, ships: Ship[], islands: Island[]): boolean {
    const origin = { x: player.position.x, y: player.position.y + FIREARM_AIM_HEIGHT, z: player.position.z };
    const dx = aimPoint.x - origin.x;
    const dy = aimPoint.y - origin.y;
    const dz = aimPoint.z - origin.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.5) return true;
    const direction = { x: dx / dist, y: dy / dist, z: dz / dist };
    if (raymarchIslandSurface(origin, direction, dist, islands).hit) return false;
    for (const other of ships) {
      if (!other.alive || other.id === player.onShipId) continue;
      if (intersectRayShipHull(origin, direction, Math.max(0, dist - 0.8), other) !== null) return false;
    }
    return true;
  }

  /** The ammo crate. Bots never walked to it, so after 6 rounds per firearm a
   *  bot was silent on deck for the rest of the match (bots-v03). During a lull
   *  on its own deck a bot tops up exactly as the [X] crate interaction does,
   *  at most once per tier cooldown. */
  maybeTopUpAmmo(crew: CrewState, bot: BotState, player: Player, ship: Ship, t: number, weaponSystem: WeaponSystem) {
    if (player.state !== 'alive' || player.onShipId !== ship.id) return;
    if (t - bot.lastFirearmThreatAt < BOT_AMMO_LULL_SECONDS) return;
    if (t - bot.lastAmmoTopUpAt < BOT_AMMO_TOPUP_SECONDS[crew.difficulty]) return;
    let short = false;
    for (const weapon of player.weapons) {
      if (!weapon || WEAPONS[weapon.weaponId].melee) continue;
      const def = WEAPONS[weapon.weaponId];
      if (weapon.ammo < def.ammoMax || weapon.reserve < def.reserveMax) { short = true; break; }
    }
    if (!short) return;
    weaponSystem.refillFirearms(player);
    bot.lastAmmoTopUpAt = t;
  }

  steerToward(ship: Ship, targetAngle: number, dt: number, t: number) {
    // Land/rock avoidance FIRST: bots used to sail dead straight at their target
    // and beach themselves on anything in between (zero avoidance terms existed).
    let desired = this.avoidObstacles(ship, targetAngle);
    // Upwind no-go awareness: a course inside the cone is unsailable — offset
    // to the nearer ~40°-off-the-wind tack instead of pinching straight in.
    // Read where the HULL is: outside the ring the wind is the storm's gale.
    const wind = sampleLocalWind(t, ship.position.x, ship.position.z, this.bb.storm);
    const upwind = angleWrap(wind.direction + Math.PI);
    const offUpwind = angleWrap(desired - upwind);
    if (Math.abs(offUpwind) < SHIP.SAIL_NO_GO_ANGLE) {
      desired = upwind + (offUpwind >= 0 ? 1 : -1) * (SHIP.SAIL_NO_GO_ANGLE + 0.09);
    }
    // Same rudder physics as the player helm (negative steer turns toward a
    // positive heading error); turning still requires way on the ship.
    const diff = angleWrap(desired - ship.rotation);
    // Proportional on the heading error, DAMPED on the rate she is already
    // swinging at. Without the damping term a crew that now has a player's full
    // rudder authority (below) slams the wheel hard over, sails through the
    // course she wanted and slams it back: the 90 m broadside circle became a
    // zig-zag. The damping is what makes the retuned orbit band hold.
    const steer = Math.max(-1, Math.min(1, -diff * 1.5 + (ship.angularVelocity ?? 0) * 0.45));
    // THE SAME CAP A PLAYER GETS (bots-06 / bots-v02). Bots passed
    // 0.36 + 0.52*sail (<= 0.88) where Match's helm passes 0.5 + 0.5*sail, and
    // on top of that nobody was at the wheel so the un-helmed decay took the
    // rest — a bot answered her helm at 0.38x a player on the same hull.
    // Difficulty tiers are decisions now, not a physics handicap.
    const chainshotted = t < (ship.chainshottedUntil ?? 0);
    const omegaCapScale = (0.5 + ship.sailHeight * 0.5)
      * (chainshotted ? 0.75 : 1)
      * ((ship.sailIntegrity ?? 1) < 0.5 ? 0.9 : 1);
    applyShipRudderSteering(ship, dt, steer, omegaCapScale);
    // Rotation is integrated once for all ships in PhysicsSystem.updateShips;
    // integrating here too would double the bot turn rate.
  }

  /**
   * Is there still water under the keel along `heading`? Samples the seabed a
   * hull-length-and-a-bit ahead against the SAME draft the grounding resolve
   * uses, so an approaching bot stops in floating water instead of at a nominal
   * radius that can sit well inside the shore.
   */
  hasSeaRoomAhead(ship: Ship, heading: number, islands: Island[]): boolean {
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
  avoidObstacles(ship: Ship, desired: number): number {
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
  hasCannonLineOfSight(ship: Ship, target: Ship, islands: Island[]): boolean {
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
  updateShoreParty(crew: CrewState, bot: BotState, player: Player, ship: Ship, island: Island, dt: number) {
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
      crew.behavior = 'return';
      crew.stateTimer = 8 + this.bb.rng() * 6;
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

  /**
   * A boarding party on the Gilded Wreck. The shore-party shape, over open
   * water: over the side, swim to the chest, haul it back to the rail. Match
   * resolves the pickup (player.nearChestId) and the stow (carryingChestId at
   * the hull) through the same code a human's hands go through, so the prize
   * that ends up in a bot's hold is the same entity a player would have taken.
   */
  updateWreckParty(
    crew: CrewState, bot: BotState, player: Player, ship: Ship,
    chest: TreasureChest | null, dt: number,
  ) {
    const stats = SHIP_STATS[ship.type];

    if (player.carryingChestId) {
      // Got her. Swim it home; Match boards + stows at the hull.
      if (bot.shoreLeg !== 'toShip') {
        bot.shoreLeg = 'toShip';
        bot.shoreTimer = this.shoreLegBudget(
          dist2D(player.position.x, player.position.z, ship.position.x, ship.position.z),
        );
      }
      bot.shoreTimer -= dt;
      if (bot.shoreTimer <= 0) {
        player.position.x = ship.position.x;
        player.position.y = ship.position.y + stats.height + 0.35;
        player.position.z = ship.position.z;
        return;
      }
      this.walkBotToward(player, ship.position.x, ship.position.z, dt);
      return;
    }

    if (!chest) {
      this.endPlunder(crew, bot, player, ship);
      return;
    }
    crew.plunderChestId = chest.id;

    if (player.onShipId) {
      const dx = chest.position.x - ship.position.x;
      const dz = chest.position.z - ship.position.z;
      const len = Math.hypot(dx, dz) || 1;
      player.onShipId = null;
      player.state = 'alive';
      player.atCannon = false;
      player.atHelm = false;
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
      player.nearChestId = chest.id;
      return;
    }
    bot.shoreTimer -= dt;
    if (bot.shoreTimer <= 0) {
      // Timeout fallback — the same legacy hop the island parties get. Her
      // chests float, so the mark is at the surface, not on a hillside.
      player.position.x = chest.position.x;
      player.position.y = chest.position.y + 0.1;
      player.position.z = chest.position.z;
      player.nearChestId = chest.id;
      bot.shoreTimer = 30;
      return;
    }
    this.walkBotToward(player, chest.position.x, chest.position.z, dt);
  }

  /** Break off the boarding: get the body back aboard and hand the helm back to
   *  the patrol/engage logic. Never leaves a bot swimming over a dead event. */
  endPlunder(crew: CrewState, bot: BotState, player: Player, ship: Ship) {
    if (!player.onShipId && !player.carryingChestId) this.recallCrewToShip(player, ship);
    this.resetShoreLeg(bot);
    crew.plunderChestId = null;
    crew.behavior = 'patrol';
    crew.stateTimer = Math.min(crew.stateTimer, 2);
    ship.anchored = false;
    ship.anchorRaiseProgress = 0;
  }

  /** Generous walking-time budget for one shore-party leg before the legacy
   *  warp fallback rescues the bot (distance-scaled — far chests need longer). */
  shoreLegBudget(distance: number): number {
    const walkSeconds = distance / (PLAYER.MOVE_SPEED * 0.92);
    return Math.min(75, Math.max(20, walkSeconds * 1.8));
  }

  /** Step the bot's body toward a point; PhysicsSystem owns ground snap /
   *  swimming transitions, so only the horizontal walk lives here. */
  walkBotToward(player: Player, tx: number, tz: number, dt: number) {
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
  recallCrewToShip(player: Player, ship: Ship) {
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

  resetShoreLeg(bot: BotState) {
    bot.shoreLeg = null;
    bot.shoreTimer = 0;
  }

  trimSails(ship: Ship, t: number, dt: number) {
    const wind = sampleLocalWind(t, ship.position.x, ship.position.z, this.bb.storm);
    const signedRelative = angleWrap(wind.direction - ship.rotation);
    const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
    const delta = desiredTrim - ship.sailAngle;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), SHIP.SAIL_TRIM_RATE * 0.9 * dt);
    ship.sailAngle += step;
  }
}

/**
 * Compute a yaw + pitch that lands a cannonball on `target` at its predicted position.
 * Accounts for cannon launch speed, gravity multiplier, and the +5 vy boost the cannon adds.
 * Difficulty mostly controls aim noise (lead is always applied — the original "no lead for
 * easy/medium" felt random and bad).
 */
function computeCannonAim(
  rng: () => number,
  ship: Ship,
  target: Ship,
  difficulty: 'easy' | 'medium' | 'hard',
  jitterScale = 1,
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
  const scale = Math.max(0.1, jitterScale);
  const yawJitter = (difficulty === 'hard' ? 0.005
    : difficulty === 'medium' ? 0.022
    : 0.05) * scale;
  const pitchJitter = (difficulty === 'hard' ? 0.004
    : difficulty === 'medium' ? 0.018
    : 0.04) * scale;
  yaw += (rng() - 0.5) * yawJitter * 2;
  pitch += (rng() - 0.5) * pitchJitter * 2;

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

