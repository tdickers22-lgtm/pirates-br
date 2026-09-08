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
