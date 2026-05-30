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
});

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
    return this.data.players[key] ?? null;
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
    return this.data.players[key];
  }

  applyMatchResult(input: {
    name: string;
    kills: number;
    deaths: number;
    gold: number;
    placement: number; // 1 = winner
    isWinner: boolean;
  }): PlayerStatsRecord {
    const rec = this.ensure(input.name);
    rec.kills += input.kills;
    rec.deaths += input.deaths;
    rec.totalGold += input.gold;
    rec.matchesPlayed += 1;
    if (input.isWinner) rec.wins += 1;
    if (input.placement > 0 && (rec.bestPlacement === 0 || input.placement < rec.bestPlacement)) {
      rec.bestPlacement = input.placement;
    }
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
