import type { Player, Ship, Island, SeaRock, StormState, TreasureChest, Vec3, WeaponId } from '../../shared/types/index.js';
import {
  SHIP_STATS, SHIP, PHYSICS, PLAYER, WEAPONS,
  BOT_EARLY_PEACE_SECONDS, BOT_ENGAGE_RANGE_BY_PHASE, BOT_ENGAGE_SHRINK_MULT, BOT_DEFEND_RANGE,
  BOT_MAX_HUNTERS_BY_PHASE, BOT_LOOKAHEAD_METERS, BOT_OBSTACLE_MARGIN, BOT_KEEL_CLEARANCE,
  BOT_CANNON_CADENCE_BY_PHASE, BOT_CANNON_ACCURACY_BY_PHASE, botPhaseScale,
  WRECK_EVENT,
} from '../../shared/constants/index.js';
import { dist2D, randAngle, angleWrap, sampleLocalWind, getIslandSurfaceY, getIslandMaxRadius } from '../../shared/utils/index.js';
import { raymarchIslandSurface, intersectRayShipHull } from '../../shared/raycast.js';
import { countOpenHoles, getCannonBroadsideYaw } from '../../shared/interactions.js';
import { applyShipRudderSteering } from './PhysicsSystem.js';
import type { WeaponSystem } from './WeaponSystem.js';

type BotBehavior = 'patrol' | 'chase' | 'engage' | 'flee' | 'loot' | 'plunder' | 'return';

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
  /** Chest this crew is currently boarding the Gilded Wreck for. */
  plunderChestId: string | null;
  /** This crew's fight was granted by a world event (contested water or the
   *  prize), not by the ordinary seek radius — so it does not spend a slot in
   *  BOT_MAX_HUNTERS_BY_PHASE. See countHunters. */
  uncappedHunt: boolean;
  /** Seconds spent unintentionally off the ship (knocked overboard, stranded)
   *  outside the loot behavior — recalled aboard after a short grace. */
  overboardTimer: number;
  /** Hull total at the last check — kept for behaviour tuning/telemetry. */
  lastHullTotal: number;
  /** Unpatched cannon/keg breaches at the last check. A RISE here (not any old
   *  hull loss) is what counts as being shot at. */
  lastHostileHoles: number;
  /** Sim time until which this bot counts as "under fire" and may fight back
   *  during the early-game peace window. */
  underFireUntil: number;
  /** Sim time this crew last actually put a ball through a port. A one-pirate
   *  crew that is firing is AT THE GUN — see BotSystem.isAtGuns. */
  lastFiredAt: number;
  /** Sim time a personal-weapon target was last in view. The ammo-crate
   *  top-up waits for a lull measured from here (see maybeTopUpAmmo). */
  lastFirearmThreatAt: number;
  /** Sim time of the last ammo-crate top-up (per-tier cooldown). */
  lastAmmoTopUpAt: number;
}

/** A live world event bots sail to, plus the loot they can carry off it. */
interface EventLure {
  x: number;
  z: number;
  radius: number;
  /** Island the event's chests are filed under (see Match's world-event note). */
  hostIslandId: string;
  /** Her chests, in the order she offers them — the prize first. */
  chestIds: string[];
}

interface BotFirearmShot {
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
/** Body turn rate for personal-weapon aiming (rad/s) by tier. A boarder who
 *  climbs the ladder BEHIND the pirate gets the half-second it takes him to
 *  turn round — the aim used to be a teleport (bots-v05). */
const BOT_FIREARM_TURN_RATE: Record<BotState['difficulty'], number> = { easy: 4, medium: 7, hard: 10 };
/** The shot is only queued once the body is within this of the firing line. */
const BOT_FIREARM_AIM_TOLERANCE = 0.12;
/** Seconds without a small-arms target before a bot walks to the ammo crate. */
const BOT_AMMO_LULL_SECONDS = 8;
/** Minimum seconds between crate visits, by tier: the deck lull a bot spends
 *  topping up, so late-match bots are not silent on deck (bots-v03) and the
 *  opening minutes are not a bottomless magazine either. */
const BOT_AMMO_TOPUP_SECONDS: Record<BotState['difficulty'], number> = { easy: 90, medium: 60, hard: 40 };

/** Rough "how sound is she" scalar (4 = whole, 0 = riddled) derived from open
 *  breaches — bots watch it drop to know they are being shot at. */
function hullTotal(ship: Ship): number {
  return Math.max(0, 4 - countOpenHoles(ship) * 0.5);
}

/** Breaches that mean SOMEBODY DID THIS TO US. A reef, a swell or a ram in the
 *  fog is the sea's fault; only powder is an act of war. Counting every hull
 *  loss as "under fire" is what let one grounded bot ignite the whole lobby
 *  inside the peace window. */
function hostileHoleCount(ship: Ship): number {
  if (!Array.isArray(ship.holes)) return 0;
  let n = 0;
  for (const hole of ship.holes) {
    if (hole.patched) continue;
    if (hole.source === 'cannon' || hole.source === 'keg') n += 1;
  }
  return n;
}

/**
 * THE PEACE HAS TO INCLUDE THE GUNS.
 *
 * The early-game governor gates who a bot SEEKS; this gates who it SHOOTS, off
 * the same clock. Inside BOT_EARLY_PEACE_SECONDS a bot only opens its ports if
 * somebody actually put powder through its planking (self-defence, not lobby-
 * wide aggression) — otherwise the opening minutes are sailing and looting, and
 * the storm arc still has crews left to squeeze.
 */
export function botMayFireCannons(
  t: number,
  underFireUntil: number,
  target?: Pick<Ship, 'id' | 'anchored' | 'position'> | null,
  islands?: Island[],
  retaliateShipId?: string | null,
): boolean {
  const underFire = t < underFireUntil;
  // THE BERTH TRUCE (liveplay-19). The clock alone is not the peace: a crew
  // still moored at its spawn berth at 2:30 is a learner who has not found the
  // helm yet, and the run-5 sloop that shelled one from 80 m the moment the
  // clock lifted holed her fifteen times before she ever sailed. A hull that
  // is ANCHORED within BOT_BERTH_TRUCE_RADIUS of a dock berth is off-limits
  // until BOT_BERTH_TRUCE_SECONDS — unless she is the one shooting at us.
  if (target && islands && t < BOT_BERTH_TRUCE_SECONDS && isMooredAtBerth(target, islands)) {
    const answering = underFire && (retaliateShipId == null || retaliateShipId === target.id);
    if (!answering) return false;
  }
  if (t >= BOT_EARLY_PEACE_SECONDS) return true;
  return underFire;
}

/** 270 s: how long a hull moored at a dock berth is spared by every bot.
 *  BOT_EARLY_PEACE_SECONDS (150) covers the whole lobby; this covers the one
 *  crew that is still tied up learning the ropes, and reaches to the second
 *  shrink so "get under way" is a real deadline, not a surprise. */
export const BOT_BERTH_TRUCE_SECONDS = 270;
/** A hull anchored within this of a dock berth counts as moored there. */
export const BOT_BERTH_TRUCE_RADIUS = 60;

/** Anchored within BOT_BERTH_TRUCE_RADIUS of any dock berth: still in harbour. */
export function isMooredAtBerth(target: Pick<Ship, 'anchored' | 'position'>, islands: Island[]): boolean {
  if (!target.anchored) return false;
  for (const island of islands) {
    const dock = island.dock;
    if (!dock) continue;
    if (dist2D(target.position.x, target.position.z, dock.berthPosition.x, dock.berthPosition.z) < BOT_BERTH_TRUCE_RADIUS) return true;
  }
  return false;
}

/** Inside this radius of a live world event, crews fight each other on sight —
 *  the hunter cap and the phase seek radius are both suspended (see the
 *  CONTESTED WATERS note in decideBehavior). Sized to "we can see each other
 *  across the wreck", not "we are on the same half of the map".
 *
 *  240 m was too tight to ever fire: instrumented over six matches, the fleet
 *  closed to a MEAN 390 m of the wreck and milled there, so on a typical tick
 *  one crew was inside the old radius and the rest were 300-400 m out — and
 *  "contested" needs BOTH hulls inside it. The water crews actually converge
 *  into is what the radius has to cover. Measured both ways at RUNS=3 x2:
 *  340 m landed 5.7/6.7 crews at 360 s, 380 m came back HIGHER (7.0/8.3) — past
 *  a point widening it stops making fights and starts making long stern chases
 *  nobody ever closes. Wide enough to cover her water, no wider. */
const BOT_LURE_BRAWL_RADIUS = 340;
/** How close a crew stands off the mark itself before it stops steering AT it
 *  and starts circling. Tied to the hull, not to the brawl radius — a crew that
 *  circles at 190 m never comes alongside, and a crew that never comes alongside
 *  never takes the prize. */
const BOT_LURE_STATION_RADIUS = 105;
/** How long after a broadside a one-pirate bot crew still counts as manning the
 *  gun rather than free to walk the deck with a plank (see isAtGuns). About one
 *  reload: long enough that a running fight keeps her off the rail, short enough
 *  that a lull hands her the repair back. */
const BOT_GUN_CREW_SECONDS = 7;

export class BotSystem {
  private bots: Map<string, BotState> = new Map();
  private pendingFirearmFires: BotFirearmShot[] = [];
  /** Dev-only "leave me alone" (solo testing): ships/players bots must not target
   *  or shoot at. Bots still fight each other. Set by Match each tick. */
  private peaceShipIds: Set<string> = new Set();
  private peacePlayerIds: Set<string> = new Set();
  /** Match-seeded stream (RNG-01): every bot coin-flip (timers, patrol
   *  bearings, aim noise) goes through it so a seeded match replays
   *  bit-identically. Unseeded it is Math.random (no behaviour change). */
  constructor(private readonly rng: () => number = Math.random) {}
  /** Crews past the gold-bounty line — bot hunters prefer them (see setBountiedShips). */
  private bountiedShipIds: Set<string> = new Set();
  /** Navigation context for the current bot's steering (set per bot each tick). */
  private navIslands: Island[] = [];
  private navSeaRocks: SeaRock[] = [];
  private navSkipIslandId: string | null = null;

  /** A world event worth sailing to (the Gilded Wreck). A crew inside `radius`
   *  that has nothing better to do points its bow at it instead of drifting
   *  vaguely toward the ring centre — which is the whole mechanism by which the
   *  event actually pulls the lobby together rather than just decorating it.
   *  `chestIds` are her loot: a bot alongside heaves to and sends a party over
   *  the side for them, so the prize actually changes hands.
   *  Null the rest of the match; engage and flee always outrank it. */
  private eventLure: EventLure | null = null;
  /** Hulls holding the Gilded Strongbox (see Match's cargo/bounty section). */
  private prizeShipIds: Set<string> = new Set();
  /** This tick's hulls, for arbitrating who is nearest a claimed chest. */
  private lureShips: Ship[] = [];
  /** This tick's ring — read only for the LOCAL wind a hull is actually sailing
   *  in (sampleLocalWind). Null before the first update. */
  private storm: StormState | null = null;

  setEventLure(lure: EventLure | null) {
    this.eventLure = lure;
  }

  /** Crews holding the prize off a world event. Unlike a gold bounty this lifts
   *  BOTH rails at once — the hunter cap and the phase seek radius — because an
   *  indivisible prize is the one thing in the match every crew wants at the
   *  same moment, and a cap that keeps six of nine crews watching is exactly
   *  what turned the wreck into a convergence with no conversion. */
  setPrizeShips(shipIds: Iterable<string>) {
    this.prizeShipIds = new Set(shipIds);
  }

  /** Match calls this each tick with the human's ship + player id when bot-peace is
   *  on (empty sets otherwise), so bots ignore that ship/player as a target. */
  setPeace(shipIds: Iterable<string>, playerIds: Iterable<string>) {
    this.peaceShipIds = new Set(shipIds);
    this.peacePlayerIds = new Set(playerIds);
  }

  /** Hulls carrying a gold bounty (Match sets this every tick). A bounty is a
   *  claim on the whole lobby's attention: it must move BOT crews too, or the
   *  "hunted treasure galleon" is theatre only the human ever answers. It does
   *  NOT widen the seek radius or lift the hunter cap — a bountied crew simply
   *  wins the target contest among ships already inside engage range. */
  setBountiedShips(shipIds: Iterable<string>) {
    this.bountiedShipIds = new Set(shipIds);
  }

  registerBot(player: Player, ship: Ship, difficulty: 'easy' | 'medium' | 'hard' = 'medium') {
    this.bots.set(player.id, {
      playerId: player.id,
      shipId: ship.id,
      behavior: 'patrol',
      targetShipId: null,
      targetIslandId: null,
      patrolAngle: randAngle(this.rng),
      aimYaw: 0,
      aimPitch: 0.1,
      fireTimer: 1.5 + this.rng() * 1.5,
      difficulty,
      stateTimer: 5 + this.rng() * 10,
      firearmTimer: 0.3 + this.rng() * 0.6,
      shoreTimer: 0,
      shoreLeg: null,
      plunderChestId: null,
      uncappedHunt: false,
      overboardTimer: 0,
      lastHullTotal: hullTotal(ship),
      lastHostileHoles: hostileHoleCount(ship),
      underFireUntil: 0,
      lastFiredAt: -999,
      lastFirearmThreatAt: -999,
      lastAmmoTopUpAt: 0,
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
    // Hull positions for the event-claim arbitration below (see freeEventChest).
    this.lureShips = ships;
    // The ring, for the WIND. PhysicsSystem sails every hull on sampleLocalWind
    // now (a gale out of the tempest outside the wall), so a bot trimming and
    // tacking against the prevailing breeze would be trimming for a wind it is
    // not in — square-rigged and crawling in exactly the weather it is trying
    // to escape. Held on the instance because every steering call site is deep
    // inside executeBehavior and already tick-scoped.
    this.storm = storm;
    for (const [pid, bot] of this.bots) {
      const player = players.find(p => p.id === pid);
      const ship = ships.find(s => s.id === bot.shipId);
      // Downed bots stop steering/firing — Match's DBNO pass owns them until
      // a crewmate revives them or they bleed out. A DEAD pirate (state
      // 'respawning', PLAYER.RESPAWN_TIME on the clock) is an unmanned hull:
      // no helm, no trim, no broadside — the wheel centres itself through the
      // un-helmed rudder decay in PhysicsSystem and she coasts. Sniping the
      // lone pirate off a bot's deck has to buy the same drift a human crew
      // gets when its helmsman dies (BOT-02 / bots-02).
      if (!player || !ship || !ship.alive) continue;
      if (player.state === 'eliminated' || player.state === 'downed' || player.state === 'respawning') continue;

      bot.stateTimer -= dt;
      bot.firearmTimer -= dt;

      // Taking POWDER lifts the early-game peace for this bot — it may hunt
      // whoever is in range for a while (self-defence, not lobby-wide aggression).
      // Counting every hull loss here is what set the lobby alight: one crew
      // scraped a reef, "retaliated" at a bystander, and that broadside made the
      // bystander "under fire" too, three cascades deep before the first shrink.
      const hostileHoles = hostileHoleCount(ship);
      if (hostileHoles > bot.lastHostileHoles) bot.underFireUntil = t + BOT_RETALIATE_SECONDS;
      bot.lastHostileHoles = hostileHoles;
      bot.lastHullTotal = hullTotal(ship);

      this.decideBehavior(bot, ship, ships, islands, storm, players, t);
      this.executeBehavior(bot, player, ship, ships, islands, storm, dt, t, weaponSystem, seaRocks);
      this.maybeFireAtBoarder(bot, player, ship, players, ships, islands, dt, t);
      this.maybeTopUpAmmo(bot, player, ship, t, weaponSystem);
    }
  }

  /** Is this hull in the water the live world event has drawn everyone into? */
  private nearLure(ship: Ship): boolean {
    const lure = this.eventLure;
    if (!lure) return false;
    return dist2D(ship.position.x, ship.position.z, lure.x, lure.z) < BOT_LURE_BRAWL_RADIUS;
  }

  /** Bearing from this hull to the live world event, or null when there is no
   *  event, the crew is already on top of it, or it is simply too far to care. */
  private lureBearing(ship: Ship): number | null {
    const lure = this.eventLure;
    if (!lure) return null;
    const d = dist2D(ship.position.x, ship.position.z, lure.x, lure.z);
    if (d > lure.radius) return null;
    const toward = Math.atan2(lure.x - ship.position.x, lure.z - ship.position.z);
    // ON STATION. Steering straight at a mark you are already on top of sails
    // you past it and out the other side, and the first build did exactly that:
    // crews arrived, lost the bearing, and took the next patrol heading back
    // toward the ring centre — the fight never got a chance to start. Inside the
    // brawl radius they STAND OFF AND CIRCLE instead, which keeps hulls in
    // gun range of each other for as long as the wreck is up.
    if (d < BOT_LURE_STATION_RADIUS) return angleWrap(toward + Math.PI * 0.5);
    return toward;
  }

  /** The next thing off the wreck worth boarding for: her prize first, then
   *  whatever is still lying on her deck. Null when there is no live event,
   *  nothing left free, or her host island has already given her up. */
  private freeEventChest(islands: Island[], self?: BotState): TreasureChest | null {
    const lure = this.eventLure;
    if (!lure || lure.chestIds.length === 0) return null;
    const host = islands.find((island) => island.id === lure.hostIslandId);
    if (!host) return null;
    // A CLAIM IS A CLAIM UNTIL IT IS SPENT. Her prize is first in `chestIds`, so
    // a fresh scan every tick has every crew re-answering "the strongbox" and
    // swapping marks mid-swim the moment somebody else stows something — and a
    // swapped mark silently releases the claim the rest of the lobby is reading.
    // A crew that has committed to a chest keeps it until it is taken.
    if (self?.plunderChestId) {
      const held = host.chests.find((candidate) => candidate.id === self.plunderChestId);
      if (held && !held.opened && !held.carriedByPlayerId && !held.storedOnShipId
        && !this.chestClaimedByAnother(held.id, self)) return held;
    }
    for (const id of lure.chestIds) {
      const chest = host.chests.find((candidate) => candidate.id === id);
      if (!chest || chest.opened) continue;
      if (chest.carriedByPlayerId || chest.storedOnShipId) continue;
      // One crew per chest. Nine hulls all swimming at the same strongbox is a
      // queue, not a contest — and it leaves the rest of her deck untouched.
      // Crews with nothing left to claim go back to their guns, which is where
      // the fight over what HAS been claimed comes from.
      if (self && this.chestClaimedByAnother(id, self)) continue;
      return chest;
    }
    return null;
  }

  /** How far this hull still has to sail to reach the event. Infinity when there
   *  is no event or the hull is not on this tick's roster. */
  private lureDistOf(shipId: string | null): number {
    const lure = this.eventLure;
    if (!lure || !shipId) return Infinity;
    const ship = this.lureShips.find((candidate) => candidate.id === shipId);
    if (!ship) return Infinity;
    return dist2D(ship.position.x, ship.position.z, lure.x, lure.z);
  }

  /**
   * Is somebody with a better claim than this crew already going for that chest?
   *
   * NEAREST HULL WINS, and that qualifier is the whole of it. A flat first-come
   * claim let whichever crew happened to run its decision first take her prize
   * from four hundred metres out and hold it against the whole lobby: measured
   * over her life the strongbox was claimed at t+0 s from 470-590 m away, and
   * crews sitting on top of her could not touch it, so five seeds in ten she
   * was never stripped at all. A claim you are not closing on is not a claim.
   * Ties go to the incumbent, which is all the stability it needs: a hull that
   * has actually closed on her outranks one that has not, and two crews running
   * abreast do not swap marks because neither is ever the nearer. A hysteresis
   * margin on top of this was measured over forty seeded matches and was strictly
   * worse (17/20 stripped at 150 m of slack against 20/20 with none) — it just
   * re-creates the original lockout at a shorter range.
   */
  private chestClaimedByAnother(chestId: string, self: BotState): boolean {
    const selfDist = this.lureDistOf(self.shipId);
    for (const other of this.bots.values()) {
      if (other.playerId === self.playerId) continue;
      if (other.behavior !== 'plunder' || other.plunderChestId !== chestId) continue;
      if (this.lureDistOf(other.shipId) <= selfDist) return true;
    }
    return false;
  }

  /** Is this hull hove to over a world event with a boarding party away? */
  private shipIsPlundering(shipId: string): boolean {
    for (const other of this.bots.values()) {
      if (other.shipId === shipId) return other.behavior === 'plunder' && other.shoreLeg !== null;
    }
    return false;
  }

  /** How many bot crews have this hull as their target right now (excluding the
   *  crew asking). Cheap: the lobby is nine hulls. */
  private huntersOn(shipId: string, exceptPlayerId: string): number {
    let n = 0;
    for (const other of this.bots.values()) {
      if (other.playerId === exceptPlayerId) continue;
      if (other.behavior === 'engage' && other.targetShipId === shipId) n++;
    }
    return n;
  }

  /** How many bot crews are currently hunting a ship (bounded by the lobby size,
   *  so a straight recount per decision is cheaper than keeping a live tally). */
  private countHunters(): number {
    let n = 0;
    // Fights the WORLD started do not spend the lobby's hunting budget. The cap
    // exists so the map does not ignite all at once when the peace lifts; a
    // brawl over the Gilded Wreck is the event doing its job. Counting those
    // brawlers against it had the wreck STARVE the rest of the chart — the
    // crews exempt from the cap at the mark filled every slot, and each crew
    // elsewhere was refused a fight the phase radius had already granted it.
    for (const other of this.bots.values()) {
      if (other.behavior === 'engage' && !other.uncappedHunt) n++;
    }
    return n;
  }

  /**
   * IS THIS CREW AT THE GUNS RIGHT NOW?
   *
   * A bot ship carries ONE pirate, and a human sailing alone has to choose:
   * you are at the cannon, or you are at the rail with a plank, never both in
   * the same breath. Bots were quietly doing both — BotSystem sets atCannon for
   * the single tick it fires and clears it again, so Match's damage-control saw
   * an idle deckhand and planked every breach between broadsides. That is why
   * nine crews could trade fire over the wreck for three minutes with 25 open
   * breaches on the water and nobody going down.
   *
   * A crew that has fired inside this window is holding the gun. She may still
   * work the bilge (a bucket is one hand and a few steps), but the plank has to
   * wait for a lull — which is what makes a gunfight end in a sinking.
   */
  isAtGuns(playerId: string, t: number): boolean {
    const bot = this.bots.get(playerId);
    if (!bot) return false;
    return t - bot.lastFiredAt < BOT_GUN_CREW_SECONDS;
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

    const avgHull = hullTotal(ship) / 4;
    if (avgHull < 0.2 && bot.behavior !== 'flee') {
      bot.behavior = 'flee';
      bot.stateTimer = 15;
      return;
    }

    // A CREW THAT HAS DECIDED TO BOARD HER, BOARDS HER. The target scan runs
    // every six to fourteen seconds and the wreck sits in water where somebody
    // is always in range, so re-deciding mid-approach meant every crew turned
    // back to its guns forty metres short and her deck was still fully laden
    // when the storm took her back — four chests untouched in every instrumented
    // run. The commitment is what makes the loot move.
    //
    // A crew hove to with its hands full is also the most contested thing on the
    // water: anchored, guns unmanned, prize walking. Fleeing still outranks this
    // (checked above) — a sinking crew drops the box like anyone would.
    if (bot.behavior === 'plunder' && this.eventLure
      && (bot.shoreLeg !== null || this.freeEventChest(islands, bot))) {
      bot.stateTimer = Math.max(bot.stateTimer, 2);
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
      bot.stateTimer = 6 + this.rng() * 8;

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
        // A hull we may not SHOOT is not a hull we SEEK — otherwise the crew
        // shadows a moored learner with the ports shut until the truce lifts.
        if (!botMayFireCannons(t, bot.underFireUntil, other, islands)) continue;

        const d = dist2D(ship.position.x, ship.position.z, other.position.x, other.position.z);
        // Score: distance, but humans get only a modest discount so bots contest players
        // without feeling like they are hard-locked from across the map.
        // A BOUNTIED hull (a crew hauling most of a win in her hold) gets a
        // heavier discount still: everything nearby would rather have the gold.
        // And the crew holding the PRIZE outranks both: there is exactly one
        // strongbox in the match, and whoever has it is the answer to "who do
        // we shoot" for every crew that can still see her.
        const bountyDiscount = this.prizeShipIds.has(other.id) ? 0.3
          : this.bountiedShipIds.has(other.id) ? 0.6 : 1;
        // BLOOD IN THE WATER. A hull already holed, or already somebody else's
        // target, is the one a pirate finishes. Without this every crew picked
        // its own private duel and the lobby stalemated: one pirate per hull has
        // to choose between the gun, the plank and the bucket, so an even fight
        // is two crews bailing at each other. Measured over the wreck — eight
        // crews engaged, 25 open breaches on the water, three minutes, no
        // sinkings. Focus is the whole difference between a fight and a sinking.
        const wounded = hullTotal(other) < 3 ? 0.5 : 1;
        // Scaled, not a flag: the second crew onto a hull is what turns a duel
        // into a sinking, and the third is what makes it quick. One pirate per
        // hull has to choose between the gun, the plank and the bucket, so an
        // even fight is two crews bailing at each other — measured at 25 open
        // breaches on the water over three minutes with nobody going down.
        const onHer = this.huntersOn(other.id, bot.playerId);
        const pileOn = onHer >= 2 ? 0.42 : onHer === 1 ? 0.55 : 1;
        // HOVE TO WITH HER BOATS AWAY. A crew anchored over the wreck with its
        // party in the water is the softest thing on the sea — no way on, no
        // helm, no gun crew — and the moment worth attacking is exactly the
        // moment somebody is lifting the prize off her deck. This is what makes
        // her DECK the contested ground rather than the water around it.
        const heaveTo = this.shipIsPlundering(other.id) ? 0.5 : 1;
        const score = (humanShipIds.has(other.id) ? d * 0.88 : d)
          * bountyDiscount * wounded * pileOn * heaveTo;
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
      // CONTESTED WATERS. Two crews within sight of the same world event are
      // not "patrolling near each other" — they are both there for the loot,
      // and the whole reason the event exists is to make that meeting HAPPEN.
      // So over the wreck the concurrency cap (which exists to stop the lobby
      // igniting all at once across the map) does not apply, and neither does
      // the phase seek radius. Everywhere else on the chart it still does.
      const contested = !inEarlyWindow && !!nearest && this.nearLure(ship) && this.nearLure(nearest);
      // THE PRIZE OUTRANKS THE RAILS. One crew is carrying the Gilded Strongbox
      // and every other crew that can still see her wants it: that is a chase,
      // not a skirmish, so neither the phase seek radius nor the hunter cap gets
      // to say no. This is the link that converts the convergence — the event
      // puts an indivisible thing in one hold and the whole lobby answers it.
      const prizeHunt = !inEarlyWindow && !!nearest && this.prizeShipIds.has(nearest.id)
        && nearestActualDist < WRECK_EVENT.PRIZE_HUNT_RANGE;
      // GO AND TAKE IT. There is a chest on her deck with THIS crew's name on
      // it (one claimant per chest), and hauling it aboard outranks picking a
      // gunfight — the only branch in the match that outranks engaging, and it
      // is self-limiting: her four chests can only ever draw four crews, and
      // the other five are left free to hunt.
      //
      // Ranked below engage it never fired ONCE across six instrumented
      // matches. She lies in water somebody is always in range of, so every
      // approaching crew turned back to its guns before it got alongside and
      // her deck was still fully laden when the storm took her back. Nothing
      // moved, so nothing was contested, so the fleet converged and left.
      const claimable = this.lureBearing(ship) !== null ? this.freeEventChest(islands, bot) : null;
      if (claimable) {
        bot.behavior = 'plunder';
        // STAMP THE CLAIM AT THE MOMENT OF COMMITMENT, not on arrival.
        // `plunderChestId` used to be written only inside updateWreckParty —
        // unreachable until the hull is already hove to inside PLUNDER_RANGE,
        // a minute of sailing AFTER this decision. So chestClaimedByAnother
        // read an empty board and every crew in the lobby claimed the same
        // chest: "her chests draw at most four crews and the rest are left to
        // fight" never once happened. Measured over her whole life, eight of
        // nine crews sat in `plunder`, nobody engaged, and the crew that lifted
        // the strongbox sailed away unhunted. The claim has to be taken when
        // the crew decides.
        bot.plunderChestId = claimable.id;
        bot.targetShipId = null;
      } else if ((contested || prizeHunt || nearestActualDist < engageRange)
        && (alreadyHunting || contested || prizeHunt || this.countHunters() < hunterCap)) {
        bot.behavior = 'engage';
        bot.targetShipId = nearest?.id ?? null;
        bot.uncappedHunt = contested || prizeHunt;
      } else if (this.lureBearing(ship) !== null) {
        // A world event is up and this crew is in range: sail AT it. Ranked
        // above island looting on purpose — the wreck's whole job is to stop
        // crews sitting on separate islands through the mid-game drought — but
        // still below engage and flee, so it never overrides a live fight.
        bot.behavior = 'patrol';
        bot.targetShipId = null;
        bot.patrolAngle = this.lureBearing(ship)! + (this.rng() - 0.5) * 0.3;
      } else if (nearIsland && nearIslandDist < 540 && this.rng() < 0.28) {
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
        bot.patrolAngle = towardCenter + (this.rng() - 0.5) * 1.2;
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
    // Shore parties belong to the 'loot' and 'plunder' behaviors only — any
    // other behavior with the body off the ship recalls it aboard after a short
    // grace so a knocked-overboard bot isn't an instant teleport, yet can never
    // strand.
    if (bot.behavior !== 'loot' && bot.behavior !== 'plunder'
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
        // Gun crews sharpen as the ring closes: same difficulty, later weather.
        const aim = computeCannonAim(this.rng, ship, target, bot.difficulty,
          botPhaseScale(BOT_CANNON_ACCURACY_BY_PHASE, storm.phase));
        bot.aimYaw = aim.yaw;
        bot.aimPitch = aim.pitch;

        bot.fireTimer -= dt;
        // Fire whenever cooled down + in cannon range. Difficulty sets the base
        // cadence and accuracy; the STORM PHASE scales both, so the opening keeps
        // its gentle bots and the endgame actually converts (see
        // BOT_CANNON_CADENCE_BY_PHASE).
        const baseDelay = bot.difficulty === 'hard' ? 0.75
          : bot.difficulty === 'medium' ? 2.0
          : 3.5;
        const minDelay = baseDelay * botPhaseScale(BOT_CANNON_CADENCE_BY_PHASE, storm.phase);
        const inCannonRange = d < (bot.difficulty === 'hard' ? 270 : 245);
        // The peace covers the guns too — an unprovoked bot shadows its neighbour
        // with the ports shut. Timer is held just short of ready so the window
        // lifting doesn't fire nine simultaneous broadsides.
        if (!botMayFireCannons(t, bot.underFireUntil, target, islands)) {
          bot.fireTimer = Math.max(bot.fireTimer, 0.35);
          // She went back to her berth and anchored: leave her be rather than
          // circling her with the ports shut (berth truce, liveplay-19).
          if (isMooredAtBerth(target, islands)) { bot.behavior = 'patrol'; bot.targetShipId = null; }
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
          if (fired) bot.lastFiredAt = t;
          bot.fireTimer = fired ? minDelay + this.rng() * 0.6 : 0.35;
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
          bot.patrolAngle = this.rng() * Math.PI * 2;
          bot.stateTimer = 5 + this.rng() * 8;
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

      // BOARDING THE GILDED WRECK. Same shape as a shore party, over water: the
      // hull heaves to alongside, one pirate goes over the side, swims to a
      // chest and hauls it back. Match's processBotLooting resolves the pickup
      // and the stow through exactly the paths a human uses.
      case 'plunder': {
        const lure = this.eventLure;
        if (!lure) {
          this.endPlunder(bot, player, ship);
          break;
        }
        const chest = player.carryingChestId ? null : this.freeEventChest(islands, bot);
        // Keep the claim current for the whole sail-in, not just the last 62 m:
        // if this crew had to re-pick (somebody stowed the mark it wanted) the
        // board has to show the NEW mark, or the chest it is now swimming for
        // reads as free to everyone else.
        if (chest) bot.plunderChestId = chest.id;
        if (!chest && !player.carryingChestId) {
          // Picked clean (or somebody beat us to the last of her): stand off and
          // keep the mark in sight — there is still a fight to be had over her.
          this.endPlunder(bot, player, ship);
          bot.patrolAngle = this.lureBearing(ship) ?? bot.patrolAngle;
          break;
        }
        const d = dist2D(ship.position.x, ship.position.z, lure.x, lure.z);
        if (d > WRECK_EVENT.PLUNDER_RANGE && player.onShipId) {
          this.steerToward(ship, Math.atan2(lure.x - ship.position.x, lure.z - ship.position.z), dt, t);
          ship.sailHeight = Math.min(ship.sailHeight + dt * 0.14, 0.42);
          ship.anchored = false;
          ship.anchorRaiseProgress = 0;
          this.trimSails(ship, t, dt);
          break;
        }
        // Hove to over her. Anchored, sails in, guns unmanned: this is the crew
        // every other crew at the wreck would rather be shooting at.
        ship.anchored = true;
        ship.anchorRaiseProgress = 0;
        ship.sailHeight = 0;
        ship.sailAngle *= Math.pow(0.9, dt / 0.016);
        this.updateWreckParty(bot, player, ship, chest, dt);
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
          bot.patrolAngle = awayAngle + (this.rng() - 0.5) * 0.8;
          bot.stateTimer = 7 + this.rng() * 8;
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
  private maybeFireAtBoarder(
    bot: BotState, player: Player, ship: Ship,
    players: Player[], ships: Ship[], islands: Island[],
    dt: number, t: number,
  ) {
    if (player.state !== 'alive' || player.atCannon || player.atHelm) return;

    const gunsFree = botMayFireCannons(t, bot.underFireUntil);
    // Find the closest enemy who is either on the bot's ship or within firearm range.
    let bestTarget: Player | null = null;
    let bestDist = FIREARM_RANGE;
    for (const other of players) {
      if (other.id === player.id) continue;
      if (other.state === 'eliminated' || other.state === 'respawning') continue;
      if (this.peacePlayerIds.has(other.id)) continue; // dev bot-peace: never shoot this player
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
    const rate = BOT_FIREARM_TURN_RATE[bot.difficulty];
    const off = angleWrap(yaw - player.rotation.x);
    const step = Math.max(-rate * dt, Math.min(rate * dt, off));
    player.rotation.x = angleWrap(player.rotation.x + step);
    player.rotation.y = pitch;

    if (bot.firearmTimer > 0) return;
    if (Math.abs(angleWrap(yaw - player.rotation.x)) > BOT_FIREARM_AIM_TOLERANCE) return;
    if (!this.hasFirearmLineOfSight(player, aimPoint, ships, islands)) return;

    // Apply difficulty-based aim noise — a few degrees of jitter.
    const noise = bot.difficulty === 'hard' ? 0.018 : bot.difficulty === 'medium' ? 0.06 : 0.11;
    const noisyAim: Vec3 = {
      x: aimPoint.x + (this.rng() - 0.5) * noise * bestDist,
      y: aimPoint.y + (this.rng() - 0.5) * noise * bestDist,
      z: aimPoint.z + (this.rng() - 0.5) * noise * bestDist,
    };

    this.pendingFirearmFires.push({
      playerId: player.id,
      aimPoint: noisyAim,
      yaw: player.rotation.x,
      pitch,
    });

    bot.firearmTimer = bot.difficulty === 'hard' ? 1.1
      : bot.difficulty === 'medium' ? 2.1
      : 3.1;
  }

  /** Did `other` hurt this pirate inside the retaliation window? Match stamps
   *  lastDamagedById/lastDamagedAt on every firearm, blade and keg hit. */
  private hurtUsRecently(player: Player, other: Player, t: number): boolean {
    if (player.lastDamagedById !== other.id || player.lastDamagedAt === null) return false;
    return t - player.lastDamagedAt < BOT_RETALIATE_SECONDS;
  }

  /** Weapon slot for this range that still has a round to fire or load, or -1
   *  when the pirate is dry. Range order: long → Glass, mid → flintknock,
   *  close → blunderbuss, then the next-best piece that has powder. */
  private pickFirearmSlot(player: Player, distance: number): number {
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
  private hasFirearmLineOfSight(player: Player, aimPoint: Vec3, ships: Ship[], islands: Island[]): boolean {
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
  private maybeTopUpAmmo(bot: BotState, player: Player, ship: Ship, t: number, weaponSystem: WeaponSystem) {
    if (player.state !== 'alive' || player.onShipId !== ship.id) return;
    if (t - bot.lastFirearmThreatAt < BOT_AMMO_LULL_SECONDS) return;
    if (t - bot.lastAmmoTopUpAt < BOT_AMMO_TOPUP_SECONDS[bot.difficulty]) return;
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

  private steerToward(ship: Ship, targetAngle: number, dt: number, t: number) {
    // Land/rock avoidance FIRST: bots used to sail dead straight at their target
    // and beach themselves on anything in between (zero avoidance terms existed).
    let desired = this.avoidObstacles(ship, targetAngle);
    // Upwind no-go awareness: a course inside the cone is unsailable — offset
    // to the nearer ~40°-off-the-wind tack instead of pinching straight in.
    // Read where the HULL is: outside the ring the wind is the storm's gale.
    const wind = sampleLocalWind(t, ship.position.x, ship.position.z, this.storm);
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
      bot.stateTimer = 8 + this.rng() * 6;
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
  private updateWreckParty(
    bot: BotState, player: Player, ship: Ship,
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
      this.endPlunder(bot, player, ship);
      return;
    }
    bot.plunderChestId = chest.id;

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
  private endPlunder(bot: BotState, player: Player, ship: Ship) {
    if (!player.onShipId && !player.carryingChestId) this.recallCrewToShip(player, ship);
    this.resetShoreLeg(bot);
    bot.plunderChestId = null;
    bot.behavior = 'patrol';
    bot.stateTimer = Math.min(bot.stateTimer, 2);
    ship.anchored = false;
    ship.anchorRaiseProgress = 0;
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
    const wind = sampleLocalWind(t, ship.position.x, ship.position.z, this.storm);
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
