import type { Ship, Island, StormState, Vec3 } from '../../../shared/types/index.js';
import {
  SHIP, PHYSICS, BOT_EARLY_PEACE_SECONDS,
} from '../../../shared/constants/index.js';
import { dist2D } from '../../../shared/utils/index.js';
import { countOpenHoles } from '../../../shared/interactions.js';
import type { BotPersonality } from './personalities.js';

export type BotBehavior = 'patrol' | 'chase' | 'engage' | 'flee' | 'loot' | 'plunder' | 'return';

/** WHY A CREW IS DOING WHAT IT IS DOING — the leaf of the behaviour tree that
 *  won this decision (BOTFUN-01 / bots-15). `behavior` says what the hull does;
 *  the intent says which branch chose it, and it is the thing a player is
 *  allowed to READ: one feed line and one pennant per crew.
 *
 *  The tree is a strict priority ladder, checked top-down every decision:
 *    SURVIVE   — she is coming apart; nothing else matters.
 *    STORM     — the wall is closing on her; run for the ring.
 *    OPPORTUNITY — a chest with our name on it, a grudge, the prize, a brawl
 *                  the world started.
 *    OBJECTIVE — the ordinary business of the match: a hull in range, a lure to
 *                sail to, an island to dig, a hold to bank.
 *    IDLE      — nothing to answer; make for the centre.
 *  Before this, the same conditions were a flat if-else chain nobody could name
 *  and no gate could count: a crew "changed its mind" with no vocabulary for
 *  what it had changed it TO. */
export type BotIntent =
  | 'survive' | 'storm' | 'plunder' | 'grudge' | 'hunt' | 'raid' | 'loot' | 'deliver' | 'patrol';

/** Which rung of the ladder an intent sits on — the probe counts distinct
 *  BRANCHES, not distinct leaves, so "patrol then patrol again" is not variety. */
export const INTENT_BRANCH: Record<BotIntent, 'survive' | 'storm' | 'opportunity' | 'objective' | 'idle'> = {
  survive: 'survive',
  storm: 'storm',
  plunder: 'opportunity',
  grudge: 'opportunity',
  hunt: 'objective',
  raid: 'objective',
  loot: 'objective',
  deliver: 'objective',
  patrol: 'idle',
};

/** One line of bot voice, drained by Match each tick and broadcast as
 *  `bot_intent`. Bounded (INTENT_LOG_MAX) because a server that keeps every
 *  line a nine-crew lobby produces over thirteen minutes is a leak. */
export interface BotIntentLine {
  shipId: string;
  playerId: string;
  name: string;
  intent: BotIntent;
  /** What the crew says out loud. Personality-flavoured (BOT_PERSONALITIES). */
  text: string;
  t: number;
}
export const INTENT_LOG_MAX = 24;
/** A crew never cries out more often than this, however fast it changes its
 *  mind — the feed is three rows, not a log. */
export const INTENT_SPEAK_COOLDOWN = 18;

/** WHAT A PIRATE IS FOR THIS TICK.
 *  `helm` has the wheel (and is the one pirate the station arbiter and the
 *  physics see AS a helmsman); `gunner` works a rail; `deckhand` bails, planks
 *  and carries. Assigned by need every tick in BotCrew.assignRoles, in
 *  memberIds order, so a seeded match replays bit-identically. */
export type BotRole = 'helm' | 'gunner' | 'deckhand';

/** A bot crew weighs anchor through the capstan like anyone else. Match gives a
 *  captain who calls it from the WHEEL this same 1.35x penalty over manning the
 *  capstan himself (HELM_ANCHOR_RAISE_FACTOR): a bot helmsman is doing exactly
 *  that, so she pays the same 4.3 s. Before this, eight sites in the bot brain
 *  set `anchored = false` in one tick (bots-06). */
export const BOT_ANCHOR_RAISE_FACTOR = 1.35;
/** Rate a crew makes / shortens sail, copied from the player helm (Match's
 *  0.22 up, 0.28 down). Bots used to assign sailHeight outright. */
export const BOT_SAIL_RAISE_RATE = 0.22;
export const BOT_SAIL_LOWER_RATE = 0.28;
/** Water in the bilge, or any open breach, that pulls a hand off her station. */
export const BOT_DAMAGE_CONTROL_WATER = 0.15;

/** THE CREW'S DECISION. One per bot HULL, not per body: a crew has one mind
 *  about who it is fighting, where it is sailing and whether it has been shot
 *  at. Splitting this off BotState is what makes a two-pirate hull possible at
 *  all — before it, every pirate carried its own `behavior` and two of them on
 *  the same wheel fought each other for the rudder (bots-16 / bots-03). */
export interface CrewState {
  shipId: string;
  /** Player ids aboard, in spawn order. Role assignment is a pure function of
   *  this order, so a seeded match replays bit-identically. */
  memberIds: string[];
  /** The hull's owner: the pirate who takes the wheel while he is on his feet. */
  captainId: string;
  /** Crew skill tier (BOT_TIERS). One tier per crew, not per body. */
  difficulty: 'easy' | 'medium' | 'hard';
  /** WHAT THIS CAPTAIN WANTS (BOT_PERSONALITIES) — fight range, the hull
   *  fraction she runs at, her appetite for loot, and how she closes. */
  personality: BotPersonality;
  behavior: BotBehavior;
  targetShipId: string | null;
  targetIslandId: string | null;
  patrolAngle: number;
  stateTimer: number;
  /** Chest this crew is currently boarding the Gilded Wreck for. */
  plunderChestId: string | null;
  /** This crew's fight was granted by a world event (contested water or the
   *  prize), not by the ordinary seek radius — so it does not spend a slot in
   *  BOT_MAX_HUNTERS_BY_PHASE. See countHunters. */
  uncappedHunt: boolean;
  /** Hull total at the last check — kept for behaviour tuning/telemetry. */
  lastHullTotal: number;
  /** Unpatched cannon/keg breaches at the last check. A RISE here (not any old
   *  hull loss) is what counts as being shot at. */
  lastHostileHoles: number;
  /** Sim time until which this crew counts as "under fire" and may fight back
   *  during the early-game peace window. */
  underFireUntil: number;
  /** WHO did it: the hull that provoked us, while underFireUntil runs. */
  retaliateShipId: string | null;
  /** ship.chainshottedUntil at the last check — a rise is torn canvas. */
  lastChainshottedUntil: number;
  /** Sim time this crew last actually put a ball through a port. */
  lastFiredAt: number;
  /** LAST KNOWN BEARINGS. shipId -> where she was and when we last had her.
   *  Bounded by the hull count (<= 12); pruned when a contact goes stale. */
  contacts: Map<string, { x: number; z: number; t: number }>;
  /** The behaviour-tree leaf that won the last decision (BOTFUN-01). */
  intent: BotIntent;
  /** Sim time the intent last CHANGED (not the last time it was re-chosen). */
  intentAt: number;
  /** Sim time this crew last said something out loud. */
  spokeAt: number;
}

/** ONE PIRATE'S BODY. Everything here is about the man, not the crew: where he
 *  is aiming, what he is carrying, which leg of a shore party he is walking. */
export interface BotState {
  playerId: string;
  /** The crew he belongs to — his hull's one mind. */
  crew: CrewState;
  /** What this body is doing for the crew this tick. */
  role: BotRole;
  /** The name on her nameplate — carried here so the intent line the feed
   *  prints does not need a players[] scan on a hot path. */
  displayName: string;
  aimYaw: number;
  aimPitch: number;
  fireTimer: number;
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
  /** player.lastDamagedAt at the last check — a change is a fresh wound. */
  lastDamagedAtSeen: number | null;
  /** Sim time a personal-weapon target was last in view. */
  lastFirearmThreatAt: number;
  /** Sim time of the last ammo-crate top-up (per-tier cooldown). */
  lastAmmoTopUpAt: number;
}

/** A live world event bots sail to, plus the loot they can carry off it. */
export interface EventLure {
  x: number;
  z: number;
  radius: number;
  /** Island the event's chests are filed under (see Match's world-event note). */
  hostIslandId: string;
  /** Her chests, in the order she offers them — the prize first. */
  chestIds: string[];
}

/** Match stamps the last hull that put powder into this one (see
 *  Match.markShipDamagedByPlayer); server-internal, optional until it lands. */
export type ProvokedShip = Ship & { lastHostileShipId?: string | null };

export interface BotFirearmShot {
  playerId: string;
  /** Direction used for the hitscan trace; world-aligned aim point. */
  aimPoint: Vec3;
  /** Yaw used for the shooter's facing — also constrains spread/melee arcs. */
  yaw: number;
  pitch: number;
}

export const CANNON_GRAVITY = -PHYSICS.GRAVITY * SHIP.CANNON_GRAVITY_MULT; // positive magnitude
export const CANNON_VY_BOOST = 5; // matches WeaponSystem.fireShipCannon
export const FIREARM_RANGE = 24;
export const FIREARM_AIM_HEIGHT = 1.4;
/** How long a bot stays willing to fight back after taking hull damage. */
export const BOT_RETALIATE_SECONDS = 45;
/** Body turn rate for personal-weapon aiming (rad/s) by tier. A boarder who
 *  climbs the ladder BEHIND the pirate gets the half-second it takes him to
 *  turn round — the aim used to be a teleport (bots-v05). */
export const BOT_FIREARM_TURN_RATE: Record<CrewState['difficulty'], number> = { easy: 4, medium: 7, hard: 10 };
/** The shot is only queued once the body is within this of the firing line. */
export const BOT_FIREARM_AIM_TOLERANCE = 0.12;
/** Seconds without a small-arms target before a bot walks to the ammo crate. */
export const BOT_AMMO_LULL_SECONDS = 8;
/** Minimum seconds between crate visits, by tier: the deck lull a bot spends
 *  topping up, so late-match bots are not silent on deck (bots-v03) and the
 *  opening minutes are not a bottomless magazine either. */
export const BOT_AMMO_TOPUP_SECONDS: Record<CrewState['difficulty'], number> = { easy: 90, medium: 60, hard: 40 };

/** Rough "how sound is she" scalar (4 = whole, 0 = riddled) derived from open
 *  breaches — bots watch it drop to know they are being shot at. */
export function hullTotal(ship: Ship): number {
  return Math.max(0, 4 - countOpenHoles(ship) * 0.5);
}

/** Breaches that mean SOMEBODY DID THIS TO US. A reef, a swell or a ram in the
 *  fog is the sea's fault; only powder is an act of war. Counting every hull
 *  loss as "under fire" is what let one grounded bot ignite the whole lobby
 *  inside the peace window. */
export function hostileHoleCount(ship: Ship): number {
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
export const BOT_LURE_BRAWL_RADIUS = 340;
/** How close a crew stands off the mark itself before it stops steering AT it
 *  and starts circling. Tied to the hull, not to the brawl radius — a crew that
 *  circles at 190 m never comes alongside, and a crew that never comes alongside
 *  never takes the prize. */
export const BOT_LURE_STATION_RADIUS = 105;
/** How long after a broadside a one-pirate bot crew still counts as manning the
 *  gun rather than free to walk the deck with a plank (see isAtGuns). About one
 *  reload: long enough that a running fight keeps her off the rail, short enough
 *  that a lull hands her the repair back. */
export const BOT_GUN_CREW_SECONDS = 7;

/**
 * THE CREW BLACKBOARD.
 *
 * One shared, tick-scoped view of the world that both halves of the bot brain
 * read: the decision layer (BotCrew) writes what a crew has decided, the
 * execution layer (BotPirate) reads it and moves bodies. Before the split these
 * were fields on BotSystem itself and every helper reached through `this`,
 * which is why a second pirate on the same hull was not expressible.
 *
 * Everything here is server-only and deterministic: `rng` is the match stream
 * (RNG-01) and every map is iterated in insertion order.
 */
export class Blackboard {
  /** Bodies, by player id. */
  readonly bots: Map<string, BotState> = new Map();
  /** Crews, by ship id. One decision per hull. */
  readonly crews: Map<string, CrewState> = new Map();
  pendingFirearmFires: BotFirearmShot[] = [];
  /** Dev-only "leave me alone" (solo testing): ships/players bots must not target
   *  or shoot at. Bots still fight each other. Set by Match each tick. */
  peaceShipIds: Set<string> = new Set();
  peacePlayerIds: Set<string> = new Set();
  /** Crews past the gold-bounty line — bot hunters prefer them. */
  bountiedShipIds: Set<string> = new Set();
  /** A world event worth sailing to (the Gilded Wreck). Null the rest of the match. */
  eventLure: EventLure | null = null;
  /** Hulls holding the Gilded Strongbox. */
  prizeShipIds: Set<string> = new Set();
  /** This tick's hulls, for arbitrating who is nearest a claimed chest. */
  lureShips: Ship[] = [];
  /** This tick's ring — read only for the LOCAL wind a hull is sailing in. */
  storm: StormState | null = null;
  /** Voice waiting to go out on the wire. Match drains it every tick; capped at
   *  INTENT_LOG_MAX so an undrained blackboard (a headless probe) cannot grow. */
  intentLog: BotIntentLine[] = [];

  constructor(readonly rng: () => number = Math.random) {}

  /**
   * STAMP A DECISION. Called by every leaf of the tree, once per decision.
   * A CHANGE of intent is what a player is told about — the same intent chosen
   * again is the crew carrying on, which is not news — and even a change is
   * silent inside INTENT_SPEAK_COOLDOWN of the last cry.
   */
  noteIntent(crew: CrewState, intent: BotIntent, t: number, text: string) {
    if (crew.intent === intent) return;
    crew.intent = intent;
    crew.intentAt = t;
    if (t - crew.spokeAt < INTENT_SPEAK_COOLDOWN) return;
    crew.spokeAt = t;
    const speaker = this.bots.get(crew.captainId);
    this.intentLog.push({
      shipId: crew.shipId,
      playerId: crew.captainId,
      name: speaker?.displayName ?? 'Crew',
      intent,
      text,
      t,
    });
    while (this.intentLog.length > INTENT_LOG_MAX) this.intentLog.shift();
  }

  /** Match takes the pending lines and leaves the log empty. */
  drainIntents(): BotIntentLine[] {
    if (this.intentLog.length === 0) return [];
    const out = this.intentLog;
    this.intentLog = [];
    return out;
  }
}

