import type { BotIntent, CrewState } from './Blackboard.js';

/**
 * WHAT A BOT CREW SAYS OUT LOUD (BOTFUN-01 / bots-14).
 *
 * A bot that changes its mind silently is scenery. The behaviour tree already
 * names the branch that won (BotIntent); this turns that name into one short
 * line in the player's voice, so "the brig turned toward me" becomes "Rooker's
 * Hand: she's holed — finish her". One line per crew per INTENT_SPEAK_COOLDOWN,
 * broadcast as `bot_intent` and mirrored by the pennant on the hull.
 *
 * Phrases are picked with a stable per-crew hash, never rng: the seeded match
 * replays bit-identically, and a crew keeps the same mouth all match.
 */
const LINES: Record<BotIntent, readonly string[]> = {
  survive: ['she\'s going — get us out', 'strike the colours, we run', 'pumps and prayers, lads'],
  storm: ['the wall\'s on us — make for the ring', 'inside the ring or drown', 'run before it closes'],
  plunder: ['boats away, that box is ours', 'over the side, take the chest', 'lay her alongside the prize'],
  grudge: ['that hull holed us — bring her about', 'we answer that broadside', 'find the one that shot us'],
  hunt: ['sail on her, roll out the guns', 'she\'s holed — finish her', 'run her down'],
  raid: ['make for the wreck', 'there\'s gold in that water', 'hard over, follow the smoke'],
  loot: ['dig the beach, quick work', 'that island owes us a chest', 'ashore, find the X'],
  deliver: ['put the hold ashore before we lose it', 'make for the Tallyman', 'gold in the hold does us no good'],
  patrol: ['hold this heading', 'keep the ring off the bow', 'eyes to weather'],
};

/** Stable, allocation-free string hash — the crew's mouth, fixed for the match. */
function crewHash(shipId: string): number {
  let h = 2166136261;
  for (let i = 0; i < shipId.length; i++) {
    h ^= shipId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function intentLine(crew: CrewState, intent: BotIntent): string {
  const pool = LINES[intent];
  return pool[crewHash(crew.shipId + intent) % pool.length];
}

/**
 * TIER KNOBS (BOTFUN-01 / section 2.3). Every one of these changes an outcome:
 * how long a crew takes to notice, how often it re-decides, how far it can see,
 * how hard it shoots, how much it wants loot, and whether it will board.
 *
 * They live here rather than in shared/constants because the whole table is
 * server-only bot brain — the client never reads a tier — and shared/constants
 * has one owner this wave (lane 6.1). The three names the tiers are keyed by
 * are the ones already on CrewState.
 */
export interface BotTier {
  /** Seconds between a crew being ABLE to see something and acting on it. */
  reactionDelay: number;
  /** Seconds between target re-scans (the old flat 6-14 s coin flip). */
  rescanInterval: [number, number];
  /** Multiplier on the difficulty cannon jitter already in computeCannonAim. */
  aimJitter: number;
  /** Multiplier on the cannon reload cadence (>1 = slower). */
  cadenceMult: number;
  /** Open breaches this tier will absorb before it breaks off. */
  retreatHoles: number;
  /** Metres of clear-weather sight (multiplied by storm visibility, slice c). */
  perceptionRange: number;
  /** 0-1 pull toward chests over fights. */
  lootAppetite: number;
  /** May put hands on an enemy deck. */
  boardingAllowed: boolean;
}

export const BOT_TIERS: Record<'easy' | 'medium' | 'hard', BotTier> = {
  easy: {
    reactionDelay: 3.0, rescanInterval: [10, 14], aimJitter: 1.35, cadenceMult: 1.4,
    retreatHoles: 2, perceptionRange: 350, lootAppetite: 0.8, boardingAllowed: false,
  },
  medium: {
    reactionDelay: 1.6, rescanInterval: [7, 11], aimJitter: 1.0, cadenceMult: 1.0,
    retreatHoles: 3, perceptionRange: 450, lootAppetite: 0.5, boardingAllowed: true,
  },
  hard: {
    reactionDelay: 0.8, rescanInterval: [4, 7], aimJitter: 0.7, cadenceMult: 0.8,
    retreatHoles: 4, perceptionRange: 560, lootAppetite: 0.3, boardingAllowed: true,
  },
};

/**
 * FIVE CAPTAINS (section 2.3). A tier says how GOOD a crew is; a personality
 * says what it WANTS, and it is the half a player can read off the water: the
 * Coward breaks off at half planking, the Wrecker keeps coming at a fifth, the
 * Corsair rams, the Merchant would rather dig than fight.
 */
export type BotPersonalityName = 'merchant' | 'hunter' | 'corsair' | 'coward' | 'wrecker';
export type BotManoeuvre = 'rake' | 'weather_gauge' | 'ram';

export interface BotPersonality {
  name: BotPersonalityName;
  /** Metres she likes to fight at. The old brain used a flat 90 for everyone. */
  orbitRange: number;
  /** Average hull fraction at which she runs (the SURVIVE leaf). */
  retreatHull: number;
  /** Multiplier on the tier's loot appetite. */
  lootMult: number;
  /** How she closes: across the stern, from upwind, or straight into her. */
  manoeuvre: BotManoeuvre;
}

export const BOT_PERSONALITIES: readonly BotPersonality[] = [
  { name: 'merchant', orbitRange: 120, retreatHull: 0.34, lootMult: 1.6, manoeuvre: 'weather_gauge' },
  { name: 'hunter', orbitRange: 88, retreatHull: 0.20, lootMult: 0.8, manoeuvre: 'rake' },
  { name: 'corsair', orbitRange: 62, retreatHull: 0.16, lootMult: 0.9, manoeuvre: 'ram' },
  { name: 'coward', orbitRange: 140, retreatHull: 0.46, lootMult: 1.3, manoeuvre: 'weather_gauge' },
  { name: 'wrecker', orbitRange: 74, retreatHull: 0.11, lootMult: 0.6, manoeuvre: 'rake' },
];

/**
 * WHICH CAPTAIN THIS HULL GETS. Deterministic and free: hashed from the crew's
 * index and her SPAWN BERTH, which MapGenerator draws from the pinned map seed.
 *
 * Deliberately NOT a draw from the match rng stream: registerBot documents that
 * the draw order IS the replay, and adding a fifth draw per crew would move
 * every seeded pacing arc for no gameplay reason. Deliberately not the ship id
 * either — those are uuids and differ between two runs of the same seed.
 */
export function personalityFor(index: number, spawnX: number, spawnZ: number): BotPersonality {
  const key = `${index}:${Math.round(spawnX)}:${Math.round(spawnZ)}`;
  return BOT_PERSONALITIES[crewHash(key) % BOT_PERSONALITIES.length];
}

/** Metres inside which a crew fights where she stands instead of sailing to her
 *  captain's preferred band (see the engage case in BotPirate). Comfortably
 *  inside every tier's cannon reach (245-270 m) and outside every personality's
 *  back-off radius, so the band still shapes the fight it starts. */
export const BOT_GUNNERY_HOLD = 135;

/**
 * WHAT A CREW CAN ACTUALLY SEE (BOTFUN-01 / bots-08).
 *
 * Bots had perfect information: every hull on the chart was a candidate, and a
 * human's hull got a flat 0.88 discount for being human — a magnet no amount of
 * sea room or weather could break. A player who ran 700 m into a squall was
 * still being hunted, which is why bots felt like they were cheating.
 *
 * Sight is the tier's clear-weather range times the weather, and the weather is
 * the storm phase: an opening afternoon is clear, the late arc is spray, rain
 * and dark. Below that, two things still give a hull away — she is close enough
 * to HEAR (hull, canvas, gun crew), or she has a lit ship's lantern the ring
 * lights up. Everything else is memory: a contact stays hunted for
 * BOT_CONTACT_MEMORY seconds after she is lost, at her last known bearing.
 */
export const BOT_STORM_VISIBILITY = [1, 0.95, 0.86, 0.78, 0.7, 0.6, 0.52];
/** A hull inside this is heard whatever the weather. */
export const BOT_LOUD_RANGE = 200;
/** How long a lost contact stays worth chasing, at her last known position. */
export const BOT_CONTACT_MEMORY = 25;

export function botSightRange(perceptionRange: number, stormPhase: number): number {
  const i = Math.min(Math.max(0, stormPhase | 0), BOT_STORM_VISIBILITY.length - 1);
  return perceptionRange * BOT_STORM_VISIBILITY[i];
}
