import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlayerStatsRecord } from '../../shared/types/index.js';

interface StatsFile {
  version: 1;
  players: Record<string, PlayerStatsRecord>;
}

const EMPTY_STATS = (name: string): PlayerStatsRecord => ({
  name,
  kills: 0,
  deaths: 0,
  wins: 0,
  matchesPlayed: 0,
  totalGold: 0,
  bestPlacement: 0,
  shipsSunk: 0,
  chestsSold: 0,
  chestsDug: 0,
  sharksKilled: 0,
  skeletonsKilled: 0,
  bestKillStreak: 0,
  bestMatchGold: 0,
  woodChopped: 0,
  oreMined: 0,
  damageDealt: 0,
  headshots: 0,
  playSeconds: 0,
});

/** Per-match deltas rolled into the lifetime record at match end. */
interface MatchStatDeltas {
  name: string;
  kills: number;
  deaths: number;
  gold: number;
  placement: number; // 1 = winner
  isWinner: boolean;
  shipsSunk?: number;
  chestsSold?: number;
  chestsDug?: number;
  sharksKilled?: number;
  skeletonsKilled?: number;
  bestKillStreak?: number;
  woodChopped?: number;
  oreMined?: number;
  damageDealt?: number;
  headshots?: number;
  playSeconds?: number;
  /** DEV-01: a match in which dev_grant_gold / dev_bot_peace was honoured. Skipped entirely. */
  devAssisted?: boolean;
}

/**
 * Tiny JSON-backed key/value store keyed by lowercased player name.
 * Writes are debounced (400ms) and atomic (write to .tmp, rename).
 */
export class StatsStore {
  private path: string;
  private data: StatsFile = { version: 1, players: {} };
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as StatsFile;
      if (parsed && parsed.players) {
        this.data = { version: 1, players: parsed.players };
        console.log(`[Stats] loaded ${Object.keys(parsed.players).length} players from ${this.path}`);
      }
    } catch (e) {
      console.warn(`[Stats] failed to load ${this.path}:`, (e as Error).message);
    }
  }

  get(name: string): PlayerStatsRecord | null {
    const key = this.keyFor(name);
    const rec = this.data.players[key];
    return rec ? this.normalize(rec) : null;
  }

  /** Get-or-create. Used so a freshly-named player gets a baseline record. */
  ensure(name: string): PlayerStatsRecord {
    const key = this.keyFor(name);
    if (!this.data.players[key]) {
      this.data.players[key] = EMPTY_STATS(name);
      this.markDirty();
    } else if (this.data.players[key].name !== name) {
      // Update display casing without changing the key.
      this.data.players[key].name = name;
      this.markDirty();
    }
    return this.normalize(this.data.players[key]);
  }

  /** Records written before the stats-panel fields existed load without them —
   *  fill zeros IN PLACE so accumulation `+=` never touches undefined. */
  private normalize(rec: PlayerStatsRecord): PlayerStatsRecord {
    const defaults = EMPTY_STATS(rec.name);
    for (const [field, zero] of Object.entries(defaults)) {
      if (typeof zero === 'number' && typeof (rec as unknown as Record<string, unknown>)[field] !== 'number') {
        (rec as unknown as Record<string, number>)[field] = zero;
      }
    }
    return rec;
  }

  applyMatchResult(input: MatchStatDeltas): PlayerStatsRecord {
    const rec = this.ensure(input.name);
    // A dev-assisted match (DEV-01) never reaches the lifetime record: not the
    // gold it handed out, not the win, not even matchesPlayed.
    if (input.devAssisted) return rec;
    rec.kills += input.kills;
    rec.deaths += input.deaths;
    rec.totalGold += input.gold;
    rec.matchesPlayed += 1;
    if (input.isWinner) rec.wins += 1;
    if (input.placement > 0 && (rec.bestPlacement === 0 || input.placement < rec.bestPlacement)) {
      rec.bestPlacement = input.placement;
    }
    rec.shipsSunk += input.shipsSunk ?? 0;
    rec.chestsSold += input.chestsSold ?? 0;
    rec.chestsDug += input.chestsDug ?? 0;
    rec.sharksKilled += input.sharksKilled ?? 0;
    rec.skeletonsKilled += input.skeletonsKilled ?? 0;
    rec.woodChopped += input.woodChopped ?? 0;
    rec.oreMined += input.oreMined ?? 0;
    rec.damageDealt += Math.round(input.damageDealt ?? 0);
    rec.headshots += input.headshots ?? 0;
    rec.playSeconds += Math.max(0, Math.round(input.playSeconds ?? 0));
    if ((input.bestKillStreak ?? 0) > rec.bestKillStreak) rec.bestKillStreak = input.bestKillStreak ?? 0;
    if (input.gold > rec.bestMatchGold) rec.bestMatchGold = input.gold;
    this.markDirty();
    return rec;
  }

  private keyFor(name: string): string {
    return (name || '').trim().toLowerCase();
  }

  private markDirty() {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (e) {
      console.warn(`[Stats] failed to write ${this.path}:`, (e as Error).message);
    }
  }
}

export function defaultStatsPath(projectRoot: string): string {
  return join(projectRoot, 'data', 'stats.json');
}
