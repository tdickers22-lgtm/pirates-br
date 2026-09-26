import { ECONOMY } from '../../shared/constants/index.js';

/**
 * THE GOLD RACE IS A SECOND WIN, NOT THE HEADLINE (D18, mechanicshud-12).
 *
 * The chip used to read "0/8000" from the first second, the most prominent
 * top-left number for a win condition that no bot fleet ever got a fifth of
 * the way to (seeded runs topped out at 1,434). Last ship afloat is the win
 * nearly every match ends on, so the chip is plain gold, and the race only
 * gets a line once a crew is past half the target: "Gold race: Mara 4,100 /
 * 8,000". A crew is what the server's win check sums (every non-eliminated
 * pirate aboard one hull, or a shipless pirate on their own), so the number
 * printed here is the number that ends the match.
 */
export interface GoldRacePirate {
  id: string;
  name: string;
  gold: number;
  shipId?: string | null;
  state?: string;
}

export interface GoldRaceView {
  /** The chip text: your own gold, no target. */
  chip: string;
  /** "Gold race: <leader> 4,100 / 8,000" once a crew passes half the target, else null. */
  line: string | null;
  leaderGold: number;
  leaderIsYou: boolean;
}

const fmt = (n: number) => Math.max(0, Math.floor(n)).toLocaleString('en-US');

export function goldRacePlan(
  players: readonly GoldRacePirate[],
  selfId: string | null,
  target: number = ECONOMY.GOLD_WIN_TARGET,
): GoldRaceView {
  const self = selfId ? players.find((p) => p.id === selfId) : undefined;
  const crews = new Map<string, { gold: number; top: GoldRacePirate; hasSelf: boolean }>();
  for (const p of players) {
    if (p.state === 'eliminated') continue;
    const key = p.shipId || p.id;
    const g = Math.max(0, p.gold || 0);
    const crew = crews.get(key);
    if (!crew) {
      crews.set(key, { gold: g, top: p, hasSelf: p.id === selfId });
    } else {
      crew.gold += g;
      if (g > Math.max(0, crew.top.gold || 0)) crew.top = p;
      if (p.id === selfId) crew.hasSelf = true;
    }
  }
  let leader: { gold: number; top: GoldRacePirate; hasSelf: boolean } | null = null;
  for (const crew of crews.values()) {
    // Ties go to your own crew: you are told you lead rather than trail a tie.
    if (!leader || crew.gold > leader.gold || (crew.gold === leader.gold && crew.hasSelf)) leader = crew;
  }
  const chip = fmt(self?.gold ?? 0);
  if (!leader || leader.gold <= target * 0.5) {
    return { chip, line: null, leaderGold: leader?.gold ?? 0, leaderIsYou: !!leader?.hasSelf };
  }
  const who = leader.hasSelf ? 'You' : leader.top.name || 'A crew';
  return {
    chip,
    line: `Gold race: ${who} ${fmt(leader.gold)} / ${fmt(target)}`,
    leaderGold: leader.gold,
    leaderIsYou: leader.hasSelf,
  };
}
