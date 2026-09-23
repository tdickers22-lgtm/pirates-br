import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlayerStatsRecord } from '../../shared/types/index.js';

/** What is kept per record on disk: the public record plus the LRU clock. */
type StoredRecord = PlayerStatsRecord & { lastPlayedAt?: number };

interface StatsFile {
  version: 1;
  players: Record<string, StoredRecord>;
}

/** b1.2f (online-07): at most this many lifetime records; the least recently
 *  PLAYED is evicted first. ~400 bytes each, so ~20 MB on disk at the cap. */
export const STATS_MAX_RECORDS = 50_000;
/** At most one file write per this many ms, however many matches end. */
export const STATS_FLUSH_INTERVAL_MS = 5_000;
/** Records serialised per chunk before yielding to the event loop. */
const FLUSH_CHUNK = 500;

/** The stats key of a device: 'd:' + sha256(deviceId). The raw id is never
 *  stored, so the file cannot be used to impersonate a device. Legacy keys
 *  (lowercased names, <= 24 chars) can never collide with the 66-char form. */
export function deviceStatsKey(deviceId: string): string {
  return 'd:' + createHash('sha256').update(deviceId).digest('hex');
}
const legacyKey = (name: string) => (name || '').trim().toLowerCase();

/** Who a result belongs to: the device when the client sent one (every
 *  current client), else the name (older clients and node smoke tests). */
export interface StatsIdentity {
  deviceId?: string | null;
  name: string;
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
  noContests: 0,
});

/** Per-match deltas rolled into the lifetime record at match end. */
interface MatchStatDeltas {
  name: string;
  /** b1.2f: the device the result belongs to; absent = keyed by name. */
  deviceId?: string | null;
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
  /** b1.2e (online-11): the match was cut short by a server restart. What the
   *  player earned is kept; the match counts as neither played nor lost. */
  noContest?: boolean;
}

/**
 * JSON-backed lifetime stats (b1.2f, online-07 / liveplay-14).
 *
 * IDENTITY IS THE DEVICE, NOT THE TYPED NAME. Stats were keyed by
 * name.toLowerCase(), so anyone who typed 'Tobias' was served and credited
 * Tobias's record, and every set_name created a record, so a loop of random
 * names grew the file without bound. Now:
 *   - a record is keyed by deviceStatsKey(deviceId) (a name-keyed record only
 *     for a client that sent no device id);
 *   - records are created ONLY at match end (applyMatchResult). The menu's
 *     read (lookup) never creates and never writes;
 *   - a legacy name-keyed record is claimed ONCE, by the first device that
 *     finishes a match under that name, and moves to the device key;
 *   - at most STATS_MAX_RECORDS records, least recently played evicted;
 *   - writes are async, compact, chunked (the event loop never serialises
 *     50k records in one go), atomic (.tmp + rename) and at most one per
 *     STATS_FLUSH_INTERVAL_MS. flushSync() is for the emergency/drain path.
 */
export class StatsStore {
  private path: string;
  /** Map order IS the LRU order: oldest-played first. */
  private players = new Map<string, StoredRecord>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private lastFlushAt = 0;
  /** Bumped by every write; an async write superseded by a sync one skips its rename. */
  private generation = 0;
  private readonly maxRecords: number;
  private readonly flushIntervalMs: number;
  /** Completed file writes (test and /health visibility). */
  writes = 0;

  constructor(path: string, opts: { maxRecords?: number; flushIntervalMs?: number } = {}) {
    this.path = path;
    this.maxRecords = opts.maxRecords ?? STATS_MAX_RECORDS;
    this.flushIntervalMs = opts.flushIntervalMs ?? STATS_FLUSH_INTERVAL_MS;
    this.load();
  }

  get size(): number {
    return this.players.size;
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as StatsFile;
      if (parsed && parsed.players) {
        const entries = Object.entries(parsed.players).filter(([, r]) => r && typeof r === 'object');
        entries.sort((a, b) => (a[1].lastPlayedAt ?? 0) - (b[1].lastPlayedAt ?? 0));
        for (const [k, r] of entries) this.players.set(k, r);
        this.evict();
        console.log(`[Stats] loaded ${this.players.size} players from ${this.path}`);
      }
    } catch (e) {
      console.warn(`[Stats] failed to load ${this.path}:`, (e as Error).message);
    }
  }

  /** A name-keyed record (older clients, tests). Never creates. */
  get(name: string): PlayerStatsRecord | null {
    const rec = this.players.get(legacyKey(name));
    return rec ? this.normalize(rec) : null;
  }

  /** A device's record. Never creates. */
  getByDevice(deviceId: string): PlayerStatsRecord | null {
    const rec = this.players.get(deviceStatsKey(deviceId));
    return rec ? this.normalize(rec) : null;
  }

  /**
   * What the menu shows: the identity's record, or (for a device with no
   * record yet) the legacy record of that name it would claim at its first
   * match end, or an all-zero default. NEVER creates a record, never writes:
   * 10k set_name frames cost 0 records and 0 writes.
   */
  lookup(id: StatsIdentity): PlayerStatsRecord {
    const own = this.players.get(this.keyOf(id));
    const rec = own ?? (id.deviceId ? this.players.get(legacyKey(id.name)) : undefined);
    const view = rec ? { ...this.normalize(rec) } : EMPTY_STATS(id.name);
    delete (view as StoredRecord).lastPlayedAt;
    view.name = id.name;
    return view;
  }

  /** @deprecated b1.2f: set_name no longer creates records. Kept as a read. */
  ensure(name: string): PlayerStatsRecord {
    return this.lookup({ name });
  }

  private keyOf(id: StatsIdentity): string {
    return id.deviceId ? deviceStatsKey(id.deviceId) : legacyKey(id.name);
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
    const key = this.keyOf(input);
    // A dev-assisted match (DEV-01) never reaches the lifetime record: not the
    // gold it handed out, not the win, not even matchesPlayed, and it neither
    // creates a record nor claims a legacy one.
    if (input.devAssisted) return this.lookup(input);
    let rec = this.players.get(key);
    if (!rec && input.deviceId) {
      const legacy = this.players.get(legacyKey(input.name));
      if (legacy) {
        // Claimed once: the name-keyed record moves to this device.
        this.players.delete(legacyKey(input.name));
        rec = legacy;
      }
    }
    rec = rec ? (this.normalize(rec) as StoredRecord) : EMPTY_STATS(input.name);
    rec.name = input.name;
    rec.kills += input.kills;
    rec.deaths += input.deaths;
    rec.totalGold += input.gold;
    // A NO CONTEST (b1.2e, online-11): a deploy ended the match, not the sea.
    // "Your stats are saved" means the gold, kills and counters below; it does
    // not mean a played match with a placement, and above all not a loss
    // (losses are matchesPlayed - wins, so bumping matchesPlayed would be one).
    if (input.noContest) {
      rec.noContests += 1;
    } else {
      rec.matchesPlayed += 1;
      if (input.isWinner) rec.wins += 1;
      if (input.placement > 0 && (rec.bestPlacement === 0 || input.placement < rec.bestPlacement)) {
        rec.bestPlacement = input.placement;
      }
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
    rec.lastPlayedAt = Date.now();
    // Most recently played moves to the back of the LRU order.
    this.players.delete(key);
    this.players.set(key, rec);
    this.evict();
    this.markDirty();
    const view = { ...rec };
    delete (view as StoredRecord).lastPlayedAt;
    return view;
  }

  private evict(): void {
    while (this.players.size > this.maxRecords) {
      const oldest = this.players.keys().next().value as string;
      this.players.delete(oldest);
    }
  }

  private markDirty() {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.writeTimer || this.inFlight) return;
    const wait = Math.max(50, this.lastFlushAt + this.flushIntervalMs - Date.now());
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, wait);
    this.writeTimer.unref?.();
  }

  /** Write now if dirty (async, chunked). Resolves when the file is on disk. */
  async flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (this.inFlight) await this.inFlight;
    if (!this.dirty) return;
    this.dirty = false;
    const gen = ++this.generation;
    this.inFlight = this.writeChunked(gen)
      .catch((e) => {
        this.dirty = true;
        console.warn(`[Stats] failed to write ${this.path}:`, (e as Error).message);
      })
      .finally(() => {
        this.inFlight = null;
        this.lastFlushAt = Date.now();
        if (this.dirty) this.schedule();
      });
    await this.inFlight;
  }

  private async writeChunked(gen: number): Promise<void> {
    await fsp.mkdir(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try {
      const keys = Array.from(this.players.keys());
      await fh.write('{"version":1,"players":{');
      let first = true;
      for (let i = 0; i < keys.length; i += FLUSH_CHUNK) {
        let chunk = '';
        for (let j = i; j < Math.min(keys.length, i + FLUSH_CHUNK); j++) {
          const rec = this.players.get(keys[j]);
          if (!rec) continue; // evicted mid-flush
          chunk += (first ? '' : ',') + JSON.stringify(keys[j]) + ':' + JSON.stringify(rec);
          first = false;
        }
        if (chunk) await fh.write(chunk); // the await is the yield
      }
      await fh.write('}}');
    } finally {
      await fh.close();
    }
    if (gen !== this.generation) return; // a sync write landed after us: it is newer
    await fsp.rename(tmp, this.path);
    this.writes += 1;
  }

  /** The drain / emergency path: one synchronous compact write, now. */
  flushSync(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (!this.dirty && !this.inFlight) return;
    this.generation += 1;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + '.sync.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 1, players: Object.fromEntries(this.players) }), 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
      this.writes += 1;
      this.lastFlushAt = Date.now();
    } catch (e) {
      console.warn(`[Stats] failed to write ${this.path}:`, (e as Error).message);
    }
  }
}

/** PIRATES_BR_STATS_PATH wins (liveplay-14: the test runner and probes point
 *  it at a tmp file so test matches never land in the real stats). */
export function defaultStatsPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PIRATES_BR_STATS_PATH?.trim();
  return fromEnv ? fromEnv : join(projectRoot, 'data', 'stats.json');
}
