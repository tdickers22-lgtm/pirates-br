import { personalityFor } from './bots/personalities.js';
import type { Player, Ship, Island, SeaRock, StormState } from '../../shared/types/index.js';
import { randAngle } from '../../shared/utils/index.js';
import type { WeaponSystem } from './WeaponSystem.js';
import { Blackboard, hullTotal, hostileHoleCount, BOT_RETALIATE_SECONDS, BOT_GUN_CREW_SECONDS } from './bots/Blackboard.js';
import type { BotFirearmShot, BotRole, BotState, CrewState, EventLure } from './bots/Blackboard.js';
import { BotCrew } from './bots/BotCrew.js';
import { BotPirate } from './bots/BotPirate.js';

// The predicates and tuning that used to live in this file are now the crew
// blackboard's; re-exported so every existing importer (Match, the bot suites)
// keeps the same entry point.
export {
  botMayFireCannons, isMooredAtBerth, hullTotal, hostileHoleCount,
  BOT_BERTH_TRUCE_SECONDS, BOT_BERTH_TRUCE_RADIUS, BOT_GUN_CREW_SECONDS,
} from './bots/Blackboard.js';
export type { BotRole, BotState, CrewState, EventLure } from './bots/Blackboard.js';

/** One live body of a crew this tick: the brain's state and the sim's Player. */
interface CrewHand { bot: BotState; player: Player }

/**
 * THE BOT BRAIN'S FRONT DOOR.
 *
 * Registry + tick order only. The thinking is split in two (BOTCREW-01):
 *   - `bots/BotCrew.ts`   — ONE decision per HULL (who we fight, where we sail);
 *   - `bots/BotPirate.ts` — one body at a time carrying it out (helm, gun, plank);
 *   - `bots/Blackboard.ts` — the shared, tick-scoped world both halves read.
 *
 * Before the split every field hung off this class and `behavior` lived on the
 * pirate, so a second pirate on the same hull was not expressible: two of them
 * would have steered the same rudder in opposite directions. A crew now decides
 * once and its hands execute in `memberIds` order, which is spawn order, so a
 * seeded match still replays bit-identically.
 */
export class BotSystem {
  private readonly bb: Blackboard;
  private readonly crewBrain: BotCrew;
  private readonly hands: BotPirate;

  constructor(rng: () => number = Math.random) {
    this.bb = new Blackboard(rng);
    this.crewBrain = new BotCrew(this.bb);
    this.hands = new BotPirate(this.bb, this.crewBrain);
  }

  /** Bot voice waiting to go out on the wire (BOTFUN-01). Match drains it each
   *  tick and broadcasts one `bot_intent` per line; the probe reads it directly. */
  drainIntents() {
    return this.bb.drainIntents();
  }

  /** Read-only view of the crews, for gates and for Match's pennant mirror. */
  get crewStates() {
    return this.bb.crews;
  }

  setEventLure(lure: EventLure | null) {
    this.bb.eventLure = lure;
  }

  /** Crews holding the prize off a world event (see BotCrew.decideBehavior). */
  setPrizeShips(shipIds: Iterable<string>) {
    this.bb.prizeShipIds = new Set(shipIds);
  }

  /** Match calls this each tick with the human's ship + player id when bot-peace is
   *  on (empty sets otherwise), so bots ignore that ship/player as a target. */
  setPeace(shipIds: Iterable<string>, playerIds: Iterable<string>) {
    this.bb.peaceShipIds = new Set(shipIds);
    this.bb.peacePlayerIds = new Set(playerIds);
  }

  /** Hulls carrying a gold bounty (Match sets this every tick). */
  setBountiedShips(shipIds: Iterable<string>) {
    this.bb.bountiedShipIds = new Set(shipIds);
  }

  /**
   * Enlist one pirate. The FIRST pirate registered on a hull is her captain and
   * creates the crew record; every later one joins it, so a hull can carry the
   * crew its mode calls for (1 / 2 / 3-4) without a second brain appearing on
   * the same wheel. `difficulty` is the crew's tier and is read from the first
   * registration; deckhands inherit it.
   */
  registerBot(
    player: Player, ship: Ship,
    difficulty: 'easy' | 'medium' | 'hard' = 'medium',
    role: BotRole = 'deckhand',
  ) {
    // DRAW ORDER IS THE REPLAY. The seeded stream (RNG-01) must be consumed in
    // exactly the order the one-pirate registry used — patrol bearing, fire
    // timer, state timer, firearm timer — or every seeded match diverges from
    // its pinned pacing arc for no gameplay reason. A crew's bearing and state
    // timer are drawn once, by her captain; each extra hand draws only her own
    // two gun timers, after them.
    let crew = this.bb.crews.get(ship.id);
    const founding = !crew;
    const patrolAngle = founding ? randAngle(this.bb.rng) : 0;
    const fireTimer = 1.5 + this.bb.rng() * 1.5;
    const stateTimer = founding ? 5 + this.bb.rng() * 10 : 0;
    const firearmTimer = 0.3 + this.bb.rng() * 0.6;
    if (!crew) {
      crew = {
        shipId: ship.id,
        memberIds: [],
        captainId: player.id,
        difficulty,
        // The captain's temperament, hashed off her spawn berth and the order
        // she was enlisted in — deterministic, and never a draw from the match
        // rng stream (that order is the replay; see the comment above).
        personality: personalityFor(this.bb.crews.size, ship.position.x, ship.position.z),
        behavior: 'patrol',
        targetShipId: null,
        targetIslandId: null,
        patrolAngle,
        stateTimer,
        plunderChestId: null,
        uncappedHunt: false,
        lastHullTotal: hullTotal(ship),
        lastHostileHoles: hostileHoleCount(ship),
        underFireUntil: 0,
        retaliateShipId: null,
        lastChainshottedUntil: ship.chainshottedUntil ?? 0,
        lastFiredAt: -999,
        intent: 'patrol',
        intentAt: 0,
        spokeAt: -999,
      };
      this.bb.crews.set(ship.id, crew);
    }
    if (!crew.memberIds.includes(player.id)) crew.memberIds.push(player.id);
    this.bb.bots.set(player.id, {
      playerId: player.id,
      crew,
      displayName: player.name,
      role: player.id === crew.captainId ? 'helm' : role,
      aimYaw: 0,
      aimPitch: 0.1,
      fireTimer,
      firearmTimer,
      shoreTimer: 0,
      shoreLeg: null,
      overboardTimer: 0,
      lastDamagedAtSeen: player.lastDamagedAt,
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
    // Hull positions for the event-claim arbitration (see freeEventChest).
    this.bb.lureShips = ships;
    // The ring, for the WIND. PhysicsSystem sails every hull on sampleLocalWind
    // now (a gale out of the tempest outside the wall), so a bot trimming and
    // tacking against the prevailing breeze would be trimming for a wind it is
    // not in.
    this.bb.storm = storm;

    for (const crew of this.bb.crews.values()) {
      const ship = ships.find(s => s.id === crew.shipId);
      if (!ship || !ship.alive) continue;

      // Who is actually on their feet this tick. A DOWNED pirate is Match's
      // (his crewmates may still revive him); a DEAD one ('respawning',
      // PLAYER.RESPAWN_TIME on the clock) is simply not a pair of hands. A hull
      // whose whole crew is down or dead is UNMANNED — no helm, no trim, no
      // broadside — and the wheel centres itself through the un-helmed rudder
      // decay in PhysicsSystem (BOT-02 / bots-02).
      const crewOnDeck: CrewHand[] = [];
      for (const id of crew.memberIds) {
        const bot = this.bb.bots.get(id);
        const player = players.find(p => p.id === id);
        if (!bot || !player) continue;
        if (player.state === 'eliminated' || player.state === 'downed' || player.state === 'respawning') continue;
        crewOnDeck.push({ bot, player });
      }
      if (crewOnDeck.length === 0) continue;

      crew.stateTimer -= dt;
      for (const hand of crewOnDeck) hand.bot.firearmTimer -= dt;

      // Taking POWDER lifts the early-game peace for this CREW — she may hunt
      // whoever is in range for a while (self-defence, not lobby-wide
      // aggression). Counting every hull loss here is what set the lobby
      // alight: one crew scraped a reef, "retaliated" at a bystander, and that
      // broadside made the bystander "under fire" too.
      const hostileHoles = hostileHoleCount(ship);
      // THE PROVOCATION SET (bots-12), asked once per HAND: powder through the
      // planking, chainshot through the canvas, a wound on ANY of this crew
      // from an enemy, or an enemy standing on our deck. The hull-level
      // watermarks are read before any of them and written after all of them,
      // so a two-pirate crew answers one provocation, not two.
      let provoker: string | null | undefined;
      for (const hand of crewOnDeck) {
        const found = this.crewBrain.findProvocation(crew, hand.bot, hand.player, ship, players, hostileHoles);
        if (found === undefined) continue;
        if (provoker === undefined || (provoker === null && found !== null)) provoker = found;
      }
      crew.lastHostileHoles = hostileHoles;
      crew.lastChainshottedUntil = ship.chainshottedUntil ?? 0;
      for (const hand of crewOnDeck) hand.bot.lastDamagedAtSeen = hand.player.lastDamagedAt;
      if (provoker !== undefined) {
        crew.underFireUntil = t + BOT_RETALIATE_SECONDS;
        if (provoker) crew.retaliateShipId = provoker;
        // A crew that has just been shot decides NOW, not at the next 6-14 s
        // patrol tick — that lag is half the window it is allowed to answer in.
        if (provoker && provoker !== crew.targetShipId) crew.stateTimer = Math.min(crew.stateTimer, 0);
      }
      if (t >= crew.underFireUntil) crew.retaliateShipId = null;
      crew.lastHullTotal = hullTotal(ship);

      this.crewBrain.decideBehavior(crew, ship, ships, islands, storm, players, t);
      this.crewBrain.assignRoles(crew, ship, crewOnDeck, players, t);
      for (const hand of crewOnDeck) {
        this.hands.executeBehavior(crew, hand.bot, hand.player, ship, ships, islands, storm, dt, t, weaponSystem, seaRocks);
        this.hands.maybeFireAtBoarder(crew, hand.bot, hand.player, ship, players, ships, islands, dt, t);
        this.hands.maybeTopUpAmmo(crew, hand.bot, hand.player, ship, t, weaponSystem);
      }
    }
  }

  /**
   * IS THIS CREW AT THE GUNS RIGHT NOW?
   *
   * A pirate is at the cannon or at the rail with a plank, never both in the
   * same breath. Bots were quietly doing both — the brain sets atCannon for the
   * single tick it fires and clears it again, so Match's damage-control saw an
   * idle deckhand and planked every breach between broadsides. That is why nine
   * crews could trade fire over the wreck for three minutes with 25 open
   * breaches on the water and nobody going down.
   *
   * A crew that has fired inside this window is holding the gun. She may still
   * work the bilge (a bucket is one hand and a few steps), but the plank has to
   * wait for a lull — which is what makes a gunfight end in a sinking.
   */
  isAtGuns(playerId: string, t: number): boolean {
    const bot = this.bb.bots.get(playerId);
    if (!bot) return false;
    if (t - bot.crew.lastFiredAt >= BOT_GUN_CREW_SECONDS) return false;
    // WHICH HANDS ARE ON THE GUN. With a crew this is a per-BODY question: her
    // gunners are holding the rail, her deckhand is holding a plank, and the
    // whole point of a crew is that those happen at once. Asking it per CREW
    // (which is all that was possible with one pirate per hull) meant a
    // two-hand crew that fired froze her own working party.
    if (bot.role === 'gunner') return true;
    // A hand her crew SPARED for the work is not on the gun — that is the whole
    // difference a crew makes. A one-pirate hull has nobody to spare, so she is
    // still on the gun she just fired and still has to choose (which is what
    // makes a gunfight between two lone pirates end in a sinking).
    if (bot.role === 'deckhand' && bot.crew.memberIds.length > 1) return false;
    return true;
  }

  /** Drain any personal-weapon shots generated this tick. Match resolves their hits. */
  flushFirearmShots(): BotFirearmShot[] {
    return this.bb.pendingFirearmFires.splice(0);
  }

  removeBot(playerId: string) {
    const bot = this.bb.bots.get(playerId);
    this.bb.bots.delete(playerId);
    if (!bot) return;
    const crew = bot.crew;
    const at = crew.memberIds.indexOf(playerId);
    if (at >= 0) crew.memberIds.splice(at, 1);
    if (crew.memberIds.length === 0) this.bb.crews.delete(crew.shipId);
    // The wheel passes to whoever is left, in spawn order — a crew never loses
    // its captain and keeps sailing helmless.
    else if (crew.captainId === playerId) crew.captainId = crew.memberIds[0];
  }

  getBotCount(): number {
    return this.bb.bots.size;
  }

  /** How many bot HULLS are still crewed (one decision each). */
  getCrewCount(): number {
    return this.bb.crews.size;
  }

  /** The crew record for a hull — read by the bot suites and by Match's
   *  damage-control when it needs to know what a hull has decided. */
  getCrew(shipId: string): CrewState | undefined {
    return this.bb.crews.get(shipId);
  }

  /** The bodies, by player id. Kept as a named accessor because the bot suites
   *  reach in to pin one pirate's timers (test-bot-ammo, test-bot-peace-window)
   *  and to unman a hull by deleting its brain (test-bot-berth-truce). */
  get bots(): Map<string, BotState> {
    return this.bb.bots;
  }

  /** This pirate's job this tick (BOTCREW-01 slice c). */
  getRole(playerId: string): BotRole | null {
    return this.bb.bots.get(playerId)?.role ?? null;
  }
}
