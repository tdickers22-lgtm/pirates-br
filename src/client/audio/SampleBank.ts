/**
 * SampleBank: loads the D31 sample set (public/assets/audio/manifest.json, written by
 * scripts/audio/build-audio.mjs) and hands decoded buffers to the engine (b2.4b, audio-01,
 * vm:performance:1).
 *
 * - fetch + decodeAudioData, in BOTH the promise and the callback form (older WebKit only
 *   calls back and returns undefined; some builds do both, so the first answer wins).
 * - At most 3 decodes in flight, taken from a priority queue: an event that just asked for a
 *   key jumps ahead of the tier preload; then boot, match, zones.
 * - Decoded PCM lives in an LRU capped at 64 MB on desktop / 40 MB on phones and tablets
 *   (length x channels x 4 bytes, what the browser holds as Float32). A buffer longer than its
 *   kind's duration cap (one-shot and ui 3 s, loop 12 s, + 50 ms) is refused rather than cached.
 * - `pick()` is synchronous and never throws: a key that is missing, failed, not decoded yet
 *   (late) or evicted returns null and the caller plays its procedural voice instead.
 */

export type SampleKind = 'oneshot' | 'bed' | 'ui';
export type SampleTier = 'boot' | 'match' | 'zones';

export interface SampleManifestFile {
  file: string;
  bytes: number;
  duration: number;
  channels: number;
  lufs?: number;
  peakDb?: number;
  loopStart?: number;
  loopEnd?: number;
}
export interface SampleManifestKey {
  tier: SampleTier;
  kind: SampleKind;
  loop?: boolean;
  frequent?: boolean;
  targetLufs?: number;
  files: SampleManifestFile[];
}
export interface SampleManifest { keys: Record<string, SampleManifestKey> }

/** What the bank needs from an AudioBuffer (a fake satisfies it in node). */
export interface DecodedLike { duration: number; length: number; numberOfChannels: number }

export interface SampleBankDeps<B extends DecodedLike> {
  fetchBytes(url: string): Promise<ArrayBuffer>;
  decode(bytes: ArrayBuffer): Promise<B>;
  /** ms clock for retry backoff (performance.now in the browser). */
  nowMs?(): number;
}

export const MB = 1024 * 1024;
export const DECODED_CAP_BYTES = { desktop: 64 * MB, phone: 40 * MB } as const;
export const DURATION_CAP_S: Readonly<Record<SampleKind, number>> = { oneshot: 3, ui: 3, bed: 12 };
const DURATION_SLACK_S = 0.05;
export const MAX_CONCURRENT_DECODES = 3;
const TIER_RANK: Record<SampleTier, number> = { boot: 1, match: 2, zones: 3 };
/** An event asked for this key right now: ahead of every preload. */
const URGENT_RANK = 0;
const RETRY_AFTER_MS = 30_000;

export function decodedBytes(b: DecodedLike): number {
  return Math.max(0, b.length) * Math.max(1, b.numberOfChannels) * 4;
}

/** decodeAudioData that works on both the promise and the legacy callback signature. */
export function decodeAudioDataCompat<B>(
  ctx: { decodeAudioData(data: ArrayBuffer, ok?: (b: B) => void, err?: (e: unknown) => void): Promise<B> | void },
  bytes: ArrayBuffer,
): Promise<B> {
  return new Promise<B>((resolve, reject) => {
    let settled = false;
    const ok = (b: B): void => { if (!settled) { settled = true; resolve(b); } };
    const fail = (e: unknown): void => { if (!settled) { settled = true; reject(e ?? new Error('decode failed')); } };
    try {
      const ret = ctx.decodeAudioData(bytes, ok, fail);
      if (ret && typeof (ret as Promise<B>).then === 'function') (ret as Promise<B>).then(ok, fail);
    } catch (e) {
      fail(e);
    }
  });
}

interface Job { key: string; index: number; rank: number; seq: number }
type FileState = 'queued' | 'loading' | 'ready' | 'failed';

export interface SamplePick<B> { buffer: B; file: SampleManifestFile; key: string; kind: SampleKind; loop: boolean }

export class SampleBank<B extends DecodedLike = AudioBuffer> {
  private manifest: SampleManifest | null = null;
  private readonly cache = new Map<string, B>(); // LRU: insertion order = recency
  private bytes = 0;
  private readonly state = new Map<string, FileState>();
  private readonly retryAt = new Map<string, number>();
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private seq = 0;
  private readonly lastPick = new Map<string, number>();
  readonly stats = { decoded: 0, failed: 0, evicted: 0, refusedDuration: 0, fallbacks: 0, peakInFlight: 0 };

  constructor(
    private readonly deps: SampleBankDeps<B>,
    private readonly opts: { capBytes: number; baseUrl?: string },
  ) {}

  get decodedBytes(): number { return this.bytes; }
  get capBytes(): number { return this.opts.capBytes; }
  get decodesInFlight(): number { return this.inFlight; }
  hasManifest(): boolean { return this.manifest !== null; }

  setManifest(m: SampleManifest | null | undefined): void {
    this.manifest = m && typeof m === 'object' && m.keys && typeof m.keys === 'object' ? m : null;
  }

  /** Fetch + parse the manifest. Never rejects: a missing manifest leaves every key on its fallback. */
  async loadManifest(url: string): Promise<boolean> {
    try {
      const buf = await this.deps.fetchBytes(url);
      this.setManifest(JSON.parse(new TextDecoder().decode(buf)) as SampleManifest);
    } catch {
      this.manifest = null;
    }
    return this.manifest !== null;
  }

  /** Queue every file of a tier at that tier's priority. */
  preloadTier(tier: SampleTier): void {
    const m = this.manifest;
    if (!m) return;
    for (const [key, entry] of Object.entries(m.keys)) if (entry.tier === tier) this.enqueue(key, TIER_RANK[tier] ?? 3);
  }

  /** Ask for a key now (urgent). Safe for unknown keys. */
  request(key: string): void {
    this.enqueue(key, URGENT_RANK);
  }

  /**
   * A decoded variant for `key`, or null (caller falls back to procedural). Avoids repeating the
   * previous variant when another one is ready. A miss kicks an urgent load, so the next call hits.
   */
  pick(key: string, rand: () => number = Math.random): SamplePick<B> | null {
    const entry = typeof key === 'string' ? this.manifest?.keys[key] : undefined;
    if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
      this.stats.fallbacks += 1;
      return null;
    }
    const ready: number[] = [];
    for (let i = 0; i < entry.files.length; i++) if (this.cache.has(this.fileId(key, i))) ready.push(i);
    if (ready.length === 0) {
      this.request(key);
      this.stats.fallbacks += 1;
      return null;
    }
    const last = this.lastPick.get(key);
    const pool = ready.length > 1 && last !== undefined ? ready.filter((i) => i !== last) : ready;
    const r = rand();
    const idx = pool[Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * pool.length)))];
    this.lastPick.set(key, idx);
    const id = this.fileId(key, idx);
    const buffer = this.cache.get(id) as B;
    this.cache.delete(id); // LRU touch
    this.cache.set(id, buffer);
    if (ready.length < entry.files.length) this.request(key); // variants evicted or never loaded
    return { buffer, file: entry.files[idx], key, kind: entry.kind, loop: entry.loop === true || entry.kind === 'bed' };
  }

  private fileId(key: string, index: number): string { return `${key}#${index}`; }

  private enqueue(key: string, rank: number): void {
    const entry = typeof key === 'string' ? this.manifest?.keys[key] : undefined;
    if (!entry || !Array.isArray(entry.files)) return;
    const now = this.deps.nowMs?.() ?? 0;
    for (let i = 0; i < entry.files.length; i++) {
      const id = this.fileId(key, i);
      if (this.cache.has(id)) continue;
      const st = this.state.get(id);
      if (st === 'loading') continue;
      if (st === 'failed' && now < (this.retryAt.get(id) ?? 0)) continue;
      if (st === 'queued') {
        const job = this.queue.find((j) => j.key === key && j.index === i);
        if (job && rank < job.rank) job.rank = rank;
        continue;
      }
      this.state.set(id, 'queued');
      this.queue.push({ key, index: i, rank, seq: this.seq++ });
    }
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < MAX_CONCURRENT_DECODES && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[best];
        if (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) best = i;
      }
      const job = this.queue.splice(best, 1)[0];
      this.inFlight += 1;
      if (this.inFlight > this.stats.peakInFlight) this.stats.peakInFlight = this.inFlight;
      void this.load(job).finally(() => {
        this.inFlight -= 1;
        this.pump();
      });
    }
  }

  private async load(job: Job): Promise<void> {
    const id = this.fileId(job.key, job.index);
    const entry = this.manifest?.keys[job.key];
    const file = entry?.files[job.index];
    if (!entry || !file) { this.state.delete(id); return; }
    this.state.set(id, 'loading');
    try {
      const bytes = await this.deps.fetchBytes(`${this.opts.baseUrl ?? '/assets/audio/'}${file.file}`);
      const buffer = await this.deps.decode(bytes);
      const cap = DURATION_CAP_S[entry.kind] ?? DURATION_CAP_S.oneshot;
      if (!(buffer.duration <= cap + DURATION_SLACK_S)) {
        this.stats.refusedDuration += 1;
        this.fail(id);
        return;
      }
      if (!this.insert(id, buffer)) { this.fail(id); return; }
      this.state.set(id, 'ready');
      this.stats.decoded += 1;
    } catch {
      this.fail(id);
    }
  }

  private fail(id: string): void {
    this.stats.failed += 1;
    this.state.set(id, 'failed');
    this.retryAt.set(id, (this.deps.nowMs?.() ?? 0) + RETRY_AFTER_MS);
  }

  private insert(id: string, buffer: B): boolean {
    const size = decodedBytes(buffer);
    if (size > this.opts.capBytes) return false;
    while (this.bytes + size > this.opts.capBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value as string;
      const old = this.cache.get(oldest) as B;
      this.cache.delete(oldest);
      this.state.delete(oldest);
      this.bytes -= decodedBytes(old);
      this.stats.evicted += 1;
    }
    this.cache.set(id, buffer);
    this.bytes += size;
    return true;
  }
}
