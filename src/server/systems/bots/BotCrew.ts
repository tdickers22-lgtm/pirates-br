import type { Player, Ship, Island, StormState, TreasureChest } from '../../../shared/types/index.js';
import {
  BOT_EARLY_PEACE_SECONDS, BOT_ENGAGE_RANGE_BY_PHASE, BOT_ENGAGE_SHRINK_MULT, BOT_DEFEND_RANGE, BOT_MAX_HUNTERS_BY_PHASE, WRECK_EVENT,
} from '../../../shared/constants/index.js';
import { dist2D, angleWrap } from '../../../shared/utils/index.js';
import { countOpenHoles } from '../../../shared/interactions.js';
import type { Blackboard } from './Blackboard.js';
import type { BotState, CrewState, ProvokedShip, BotIntent } from './Blackboard.js';
import { intentLine, BOT_TIERS, botSightRange, BOT_LOUD_RANGE, BOT_CONTACT_MEMORY } from './personalities.js';
import { BOT_DAMAGE_CONTROL_WATER, FIREARM_RANGE, hullTotal, botMayFireCannons, BOT_LURE_BRAWL_RADIUS, BOT_LURE_STATION_RADIUS } from './Blackboard.js';

/**
 * THE CREW'S MIND (BOTCREW-01 / bots-16, bots-03).
 *
 * Everything a bot hull DECIDES — who it is fighting, where it is sailing, who
 * shot it, which chest it has claimed — lives here, once per hull. The bodies
 * that carry the decision out live in BotPirate. Split out of BotSystem so a
 * hull can carry more than one pirate without two of them arguing over the
 * wheel.
 */
export class BotCrew {
  constructor(private readonly bb: Blackboard) {}

  /**
   * Was this crew provoked THIS tick, and by which hull? Returns undefined
   * when nothing happened, null when something did but the provoker is
   * unknown, else the provoking ship's id. Sources, in order of certainty:
   *  - a rise in cannon/keg breaches — provoker is `ship.lastHostileShipId`
   *    (Match stamps it from the projectile owner; absent ⇒ unknown);
   *  - chainshot (chainshottedUntil advanced) — same stamp;
   *  - this pirate freshly hurt by a player of ANOTHER crew (skeletons and
   *    crewmates never count) — provoker is the attacker's ship;
   *  - an enemy pirate standing on OUR deck — provoker is his ship.
   */
  /**
   * WHO DOES WHAT, THIS TICK (BOTCREW-01 slice b/c).
   *
   * A pure function of the crew's decision, the hull's condition and the order
   * the hands were enlisted in — no rng, no memory — so a seeded match replays
   * bit-identically and a crew never dithers between two equal jobs.
   *
   * The order of need is the one a real crew works to:
   *   1. THE WHEEL, whenever she is under way. Somebody visibly has the helm,
   *      which is what physics counts as helmed (bots-v02) and what a boarder
   *      climbing the ladder finds at the top.
   *   2. DAMAGE CONTROL, up to two hands, the moment there is a breach open or
   *      water in the bilge. Match's updateBotFlooding caps bailers at two.
   *   3. THE GUNS for everyone left while the crew is fighting.
   *
   * THE ONE-PIRATE CREW IS THE INTERESTING CASE and it is why this cannot be a
   * fixed table: a lone hand at the wheel is a lone hand NOT at the bucket, and
   * Match refuses damage control to anyone at a station. So she leaves the
   * wheel to plank — exactly the trade a human sailing alone makes — and the
   * hull coasts while she does it. Handing her a permanent helm would have made
   * every one-pirate bot hull unsinkable-by-neglect and un-bailable at once.
   */
  assignRoles(crew: CrewState, ship: Ship, hands: { bot: BotState; player: Player }[], players: Player[], t: number) {
    const anchored = crew.behavior === 'loot' || crew.behavior === 'plunder';
    // ENEMIES ON OUR DECK OUTRANK THE WHEEL. A pirate at the helm has both
    // hands on it — Match refuses a human at a station his pistol, and the bot
    // brain's own aim turn is overwritten by the helm pose every tick. A lone
    // hand therefore lets go of the wheel and fights, exactly as a solo player
    // must; a crew with hands to spare keeps her helmsman and answers with the
    // rest (which is the whole point of having a crew).
    const boarded = players.some((other) => {
      if (other.shipId === ship.id) return false;
      if (other.state === 'eliminated' || other.state === 'respawning' || other.state === 'downed') return false;
      if (this.bb.peacePlayerIds.has(other.id)) return false;
      if (other.onShipId === ship.id) return true;
      // Not aboard yet, but inside pistol range of one of our people — in the
      // water alongside, on the dock, on his own rail. Same call.
      return hands.some((hand) => dist2D(hand.player.position.x, hand.player.position.z,
        other.position.x, other.position.z) <= FIREARM_RANGE);
    });
    const damage = countOpenHoles(ship) > 0 || (ship.waterLevel ?? 0) > BOT_DAMAGE_CONTROL_WATER;
    const fighting = crew.behavior === 'engage' || t - crew.lastFiredAt < 7;
    // Hands away over the side (a shore or wreck party) are nobody's station.
    const aboard = hands.filter((h) => h.bot.shoreLeg === null && h.player.onShipId === ship.id);
    for (const hand of hands) hand.bot.role = 'deckhand';
    if (aboard.length === 0) return;

    let next = 0;
    const wantHelm = !anchored && !((damage || boarded) && aboard.length === 1);
    if (wantHelm) aboard[next++].bot.role = 'helm';
    let repairers = damage ? Math.min(2, aboard.length - next) : 0;
    while (repairers-- > 0) aboard[next++].bot.role = 'deckhand';
    while (next < aboard.length) aboard[next++].bot.role = fighting ? 'gunner' : 'deckhand';
  }

  /** Is any body of this crew currently away on a shore/wreck party? The
   *  commitment check in decideBehavior used to read the lone pirate's leg;
   *  with a crew it is "are any of my people in the water". */
  anyShoreLeg(crew: CrewState): boolean {
    for (const id of crew.memberIds) {
      const body = this.bb.bots.get(id);
      if (body && body.shoreLeg !== null) return true;
    }
    return false;
  }

  findProvocation(
    crew: CrewState, bot: BotState, player: Player, ship: Ship, players: Player[], hostileHoles: number,
  ): string | null | undefined {
    let provoker: string | null | undefined;
    const stamped = (ship as ProvokedShip).lastHostileShipId ?? null;
    if (hostileHoles > crew.lastHostileHoles) provoker = stamped;
    if ((ship.chainshottedUntil ?? 0) > crew.lastChainshottedUntil) provoker = provoker ?? stamped;
    if (player.lastDamagedAt !== null && player.lastDamagedAt !== bot.lastDamagedAtSeen && player.lastDamagedById) {
      const attacker = players.find((p) => p.id === player.lastDamagedById);
      if (attacker && attacker.shipId && attacker.shipId !== ship.id) provoker = attacker.shipId;
    }
    for (const other of players) {
      if (other.onShipId !== ship.id || other.shipId === ship.id) continue;
      if (other.state === 'eliminated' || other.state === 'respawning' || other.state === 'downed') continue;
      if (this.bb.peacePlayerIds.has(other.id)) continue;
      // A shipless boarder (swam over from a wreck) still provokes; he just
      // has no hull to answer.
      provoker = other.shipId ?? provoker ?? null;
      break;
    }
    return provoker;
  }

  /** Is this hull in the water the live world event has drawn everyone into? */
  nearLure(ship: Ship): boolean {
    const lure = this.bb.eventLure;
    if (!lure) return false;
    return dist2D(ship.position.x, ship.position.z, lure.x, lure.z) < BOT_LURE_BRAWL_RADIUS;
  }

  /** Bearing from this hull to the live world event, or null when there is no
   *  event, the crew is already on top of it, or it is simply too far to care. */
  lureBearing(ship: Ship): number | null {
    const lure = this.bb.eventLure;
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
  freeEventChest(islands: Island[], self?: CrewState): TreasureChest | null {
    const lure = this.bb.eventLure;
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
  lureDistOf(shipId: string | null): number {
    const lure = this.bb.eventLure;
    if (!lure || !shipId) return Infinity;
    const ship = this.bb.lureShips.find((candidate) => candidate.id === shipId);
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
  chestClaimedByAnother(chestId: string, self: CrewState): boolean {
    const selfDist = this.lureDistOf(self.shipId);
    for (const other of this.bb.crews.values()) {
      if (other.shipId === self.shipId) continue;
      if (other.behavior !== 'plunder' || other.plunderChestId !== chestId) continue;
      if (this.lureDistOf(other.shipId) <= selfDist) return true;
    }
    return false;
  }

  /** Is this hull hove to over a world event with a boarding party away? */
  shipIsPlundering(shipId: string): boolean {
    const crew = this.bb.crews.get(shipId);
    return !!crew && crew.behavior === 'plunder' && this.anyShoreLeg(crew);
  }

  /** How many bot crews have this hull as their target right now (excluding the
   *  crew asking). Cheap: the lobby is nine hulls. */
  huntersOn(shipId: string, exceptShipId: string): number {
    let n = 0;
    for (const other of this.bb.crews.values()) {
      if (other.shipId === exceptShipId) continue;
      if (other.behavior === 'engage' && other.targetShipId === shipId) n++;
    }
    return n;
  }

  /** How many bot crews are currently hunting a ship (bounded by the lobby size,
   *  so a straight recount per decision is cheaper than keeping a live tally). */
  countHunters(): number {
    let n = 0;
    // Fights the WORLD started do not spend the lobby's hunting budget. The cap
    // exists so the map does not ignite all at once when the peace lifts; a
    // brawl over the Gilded Wreck is the event doing its job. Counting those
    // brawlers against it had the wreck STARVE the rest of the chart — the
    // crews exempt from the cap at the mark filled every slot, and each crew
    // elsewhere was refused a fight the phase radius had already granted it.
    for (const other of this.bb.crews.values()) {
      if (other.behavior === 'engage' && !other.uncappedHunt) n++;
    }
    return n;
  }

  decideBehavior(
    crew: CrewState, ship: Ship,
    ships: Ship[], islands: Island[], storm: StormState,
    _players: Player[], t: number,
  ) {
    const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
    const distRatio = distToCenter / Math.max(1, storm.safeRadius);
    const dangerThreshold = storm.shrinking ? 0.65 : 0.85;
    const inDanger = distRatio > dangerThreshold;

    // ── 1. SURVIVE ─────────────────────────────────────────────────────────
    // She is coming apart. Checked ABOVE the ring on purpose: a hull at a fifth
    // of her planking does not care which side of the wall she drowns on, and
    // the ring branch used to win this tie and send her back into a fight with
    // her target still set.
    // HOW MUCH SHE WILL TAKE is the captain's, not a constant: the Coward
    // breaks off at half planking and the Wrecker keeps coming at a ninth. A
    // flat 0.2 for nine crews is why every bot fight ended the same way — and
    // why a whole peaceful crew could sail an arc without ever changing rung.
    const avgHull = hullTotal(ship) / 4;
    const retreatHull = crew.personality.retreatHull;
    const tier = BOT_TIERS[crew.difficulty];
    // Breaches alone are not a reason to run — a sound hull with three holes in
    // her is a hull with a carpenter on her, and a crew that broke off for that
    // stopped fighting the moment the first ball landed (test-bot-crew-roles
    // caught exactly that: hull a never fired a shot). She runs when the water
    // is winning: past her captain's threshold, or holed past her tier's
    // patience AND already down to sixty percent.
    const holed = countOpenHoles(ship) > tier.retreatHoles && avgHull < 0.6;
    if ((avgHull < retreatHull || holed) && crew.behavior !== 'flee') {
      crew.behavior = 'flee';
      crew.targetShipId = null;
      crew.stateTimer = 15;
      this.leaf(crew, 'survive', t);
      return;
    }

    // ── 2. STORM ───────────────────────────────────────────────────────────
    if (inDanger) {
      crew.behavior = 'flee';
      crew.targetShipId = null;
      this.leaf(crew, 'storm', t);
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
    if (crew.behavior === 'plunder' && this.bb.eventLure
      && (this.anyShoreLeg(crew) || this.freeEventChest(islands, crew))) {
      crew.stateTimer = Math.max(crew.stateTimer, 2);
      this.leaf(crew, 'plunder', t);
      return;
    }

    // Mid-engagement re-target check: if the current target is dead/out of range, drop it.
    if (crew.behavior === 'engage' && crew.targetShipId) {
      const tgt = ships.find(s => s.id === crew.targetShipId);
      if (!tgt || !tgt.alive || tgt.sinking || this.bb.peaceShipIds.has(crew.targetShipId)) {
        crew.targetShipId = null;
        crew.stateTimer = 0; // re-evaluate now
      }
    }

    if (crew.stateTimer <= 0) {
      // A hard crew re-reads the water every 4-7 s; an easy one every 10-14.
      // One rng draw either way, so the seeded stream keeps its shape.
      const [rescanMin, rescanMax] = tier.rescanInterval;
      crew.stateTimer = rescanMin + this.bb.rng() * (rescanMax - rescanMin);

      // WHAT THIS CREW CAN SEE FROM HER OWN DECK (bots-08). There is no
      // roster of humans here any more: the old scan read every hull on the
      // chart and gave a human's a flat 0.88 discount, so a player could not
      // break contact by running or by weather. Now a hull is a candidate only
      // if she is inside the tier's sight (scaled by the storm's weather), or
      // close enough to HEAR, or still in memory from when she was last seen.
      const sight = botSightRange(tier.perceptionRange, storm.phase);

      let nearest: Ship | null = null;
      let nearestScore = Infinity;
      /** How far away the crew BELIEVES her best candidate is — her last known
       *  bearing when the hull is out of sight. The range gate below has to ask
       *  the same question the scan asked, or a remembered contact is dropped
       *  the instant she is lost: the crew "chases" a memory and is then told
       *  the true position is 4 km away. */
      let nearestPerceived = Infinity;
      for (const other of ships) {
        if (other.id === ship.id || !other.alive || other.sinking) continue;
        if (this.bb.peaceShipIds.has(other.id)) continue; // dev bot-peace: never engage this ship
        // A hull we may not SHOOT is not a hull we SEEK — otherwise the crew
        // shadows a moored learner with the ports shut until the truce lifts.
        if (!botMayFireCannons(t, crew.underFireUntil, other, islands, crew.retaliateShipId)) continue;

        const trueD = dist2D(ship.position.x, ship.position.z, other.position.x, other.position.z);
        // SEEN, HEARD, OR REMEMBERED — in that order.
        const heard = trueD <= BOT_LOUD_RANGE;
        const seen = heard || trueD <= sight;
        if (seen) crew.contacts.set(other.id, { x: other.position.x, z: other.position.z, t });
        const memory = crew.contacts.get(other.id);
        if (!seen) {
          if (!memory || t - memory.t > BOT_CONTACT_MEMORY) {
            if (memory) crew.contacts.delete(other.id);
            continue;
          }
        }
        // A crew chases the bearing she last HAD, not the one the server knows.
        const d = seen ? trueD
          : dist2D(ship.position.x, ship.position.z, memory!.x, memory!.z);
        // Score: distance, but humans get only a modest discount so bots contest players
        // without feeling like they are hard-locked from across the map.
        // A BOUNTIED hull (a crew hauling most of a win in her hold) gets a
        // heavier discount still: everything nearby would rather have the gold.
        // And the crew holding the PRIZE outranks both: there is exactly one
        // strongbox in the match, and whoever has it is the answer to "who do
        // we shoot" for every crew that can still see her.
        const bountyDiscount = this.bb.prizeShipIds.has(other.id) ? 0.3
          : this.bb.bountiedShipIds.has(other.id) ? 0.6 : 1;
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
        const onHer = this.huntersOn(other.id, crew.shipId);
        const pileOn = onHer >= 2 ? 0.42 : onHer === 1 ? 0.55 : 1;
        // HOVE TO WITH HER BOATS AWAY. A crew anchored over the wreck with its
        // party in the water is the softest thing on the sea — no way on, no
        // helm, no gun crew — and the moment worth attacking is exactly the
        // moment somebody is lifting the prize off her deck. This is what makes
        // her DECK the contested ground rather than the water around it.
        const heaveTo = this.shipIsPlundering(other.id) ? 0.5 : 1;
        // A stale contact scores worse the older it is: a hull last seen twenty
        // seconds ago in the murk is a worse bet than one under the guns now.
        const staleness = seen ? 1 : 1 + (t - memory!.t) / BOT_CONTACT_MEMORY;
        const score = d * staleness * bountyDiscount * wounded * pileOn * heaveTo;
        if (score < nearestScore) { nearestScore = score; nearest = other; nearestPerceived = d; }
      }

      // Find island for looting
      let nearIsland: Island | null = null;
      let nearIslandDist = Infinity;
      for (const isl of islands) {
        if (isl.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating)) continue;
        const d = dist2D(ship.position.x, ship.position.z, isl.position.x, isl.position.z);
        if (d < nearIslandDist) { nearIslandDist = d; nearIsland = isl; }
      }

      // THE GRUDGE. A crew that knows who shot it answers THAT hull — no range
      // gate, no hunter cap, no "nearest scores better" — and never picks a
      // bystander from the peace branch (bots-v01).
      const grudge = t < crew.underFireUntil && crew.retaliateShipId
        ? ships.find((s) => s.id === crew.retaliateShipId && s.id !== ship.id && s.alive && !s.sinking
          && !this.bb.peaceShipIds.has(s.id)) ?? null
        : null;
      if (grudge) nearest = grudge;
      if (grudge && grudge !== null) {
        // The grudge is not a sighting: she knows who shot her. Take her last
        // known bearing if there is one, else the true one.
        const known = crew.contacts.get(grudge.id);
        nearestPerceived = known
          ? dist2D(ship.position.x, ship.position.z, known.x, known.z)
          : dist2D(ship.position.x, ship.position.z, grudge.position.x, grudge.position.z);
      }
      const nearestActualDist = nearest ? nearestPerceived : Infinity;

      // Early-game pacing governor. For the first BOT_EARLY_PEACE_SECONDS bots do
      // not SEEK ship fights — they patrol and loot — unless something shot them
      // (underFireUntil). Half the lobby used to be gone before the first shrink,
      // which collapsed the whole 7-phase storm arc into the opening minutes.
      // After that window the seek radius is a local skirmish range instead of the
      // old map-wide 780/920 that had every bot converging on the player at once.
      const inEarlyWindow = t < BOT_EARLY_PEACE_SECONDS;
      const underFire = t < crew.underFireUntil;
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
      const alreadyHunting = crew.behavior === 'engage';
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
      const prizeHunt = !inEarlyWindow && !!nearest && this.bb.prizeShipIds.has(nearest.id)
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
      const claimable = this.lureBearing(ship) !== null ? this.freeEventChest(islands, crew) : null;
      if (claimable) {
        crew.behavior = 'plunder';
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
        crew.plunderChestId = claimable.id;
        crew.targetShipId = null;
        this.leaf(crew, 'plunder', t);
      } else if ((grudge || contested || prizeHunt || nearestActualDist < engageRange)
        && (grudge || alreadyHunting || contested || prizeHunt || this.countHunters() < hunterCap)) {
        crew.behavior = 'engage';
        crew.targetShipId = nearest?.id ?? null;
        crew.uncappedHunt = !!grudge || contested || prizeHunt;
        // A GRUDGE IS NOT A HUNT. Answering the hull that holed you is the
        // OPPORTUNITY rung; picking the softest thing in the seek radius is
        // ordinary business. A player reads the difference off the pennant.
        this.leaf(crew, grudge ? 'grudge' : 'hunt', t);
      } else if (this.lureBearing(ship) !== null) {
        // A world event is up and this crew is in range: sail AT it. Ranked
        // above island looting on purpose — the wreck's whole job is to stop
        // crews sitting on separate islands through the mid-game drought — but
        // still below engage and flee, so it never overrides a live fight.
        crew.behavior = 'patrol';
        crew.targetShipId = null;
        crew.patrolAngle = this.lureBearing(ship)! + (this.bb.rng() - 0.5) * 0.3;
        this.leaf(crew, 'raid', t);
      } else if (nearIsland && nearIslandDist < 540
        && this.bb.rng() < Math.min(0.9, tier.lootAppetite * crew.personality.lootMult * 0.55)) {
        crew.behavior = 'loot';
        crew.targetIslandId = nearIsland.id;
        this.leaf(crew, 'loot', t);
      } else {
        // No nearby target — pick patrol direction biased toward the storm center
        // so bots converge over time.
        crew.behavior = 'patrol';
        const towardCenter = Math.atan2(
          storm.centerX - ship.position.x,
          storm.centerZ - ship.position.z,
        );
        crew.patrolAngle = towardCenter + (this.bb.rng() - 0.5) * 1.2;
        this.leaf(crew, 'patrol', t);
      }
    }
  }

  /** Stamp the leaf that won this decision and give the crew its voice. The
   *  phrase is the crew's, not the leaf's — a Coward and a Wrecker running for
   *  the same ring do not say the same thing (BOT_PERSONALITIES). */
  private leaf(crew: CrewState, intent: BotIntent, t: number) {
    this.bb.noteIntent(crew, intent, t, intentLine(crew, intent));
  }
}
