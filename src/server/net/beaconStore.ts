/**
 * BEACON + TELEMETRY TRIAGE STORE (b1.7c, D35, critique gaps 5a and 14).
 *
 * `/beacon` used to be a log line and nothing more; nobody reads `fly logs`
 * for a week to count how often Safari throws the same error. This store keeps
 * a capped ring (5 MB of JSON by default) on the Fly volume:
 *   - ERROR SIGNATURES: message + top stack frame, normalised so the same bug
 *     groups across builds (Vite content hashes and line:col are stripped);
 *     each group counts sessions per build and per device class. The client
 *     dedupes each distinct message once per page load, so a count is a
 *     session count.
 *   - SESSION SUMMARIES (kind `session`, from sessionTelemetry.ts): one per
 *     match nonce (a later summary with the same nonce replaces the earlier),
 *     oldest evicted first, plus the per-device fps histograms derived from them.
 *
 * Served only behind HEALTH_KEY at GET /health/beacons and /health/telemetry
 * (no key configured: loopback callers that did not come through the edge,
 * the same posture as the detailed /health). Nothing here ever holds an IP,
 * a name or a device id.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const STORE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_SIGNATURES = 2000;
/** fps histogram bin lower edges; the grading lines are 24 (phone) and 45 (desktop). */
export const FPS_BINS = [0, 10, 15, 20, 24, 30, 40, 45, 55, 60, 90] as const;
const DEVICES = new Set(['phone', 'tablet', 'desktop']);

export interface SessionRecord {
  t: number; nonce: string; buildId: string; device: string; browser: string; tier: string; dpr: number;
  frames: number; frameP50Ms: number; frameP95Ms: number; fpsP50: number; longTasks: number; longFrames: number;
  contextLosses: number; reloadWithoutCleanExit: boolean; matchCompleted: boolean; durationSec: number;
}

export interface SignatureGroup {
  sig: string; kind: string; message: string; topFrame: string; count: number;
  builds: Record<string, number>; devices: Record<string, number>;
  firstSeen: number; lastSeen: number; sampleStack: string;
}

/** Whitelist + clamp for a `session` body. Anything else is dropped. */
export function sanitizeSession(raw: unknown): Omit<SessionRecord, 't'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.kind !== 'session') return null;
  const str = (v: unknown, n: number, dflt = '') => (typeof v === 'string' ? v.slice(0, n) : dflt);
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
  const nonce = str(b.nonce, 24);
  if (!/^[a-z0-9]{4,24}$/.test(nonce)) return null;
  const device = str(b.device, 10);
  return {
    nonce,
    buildId: str(b.buildId, 40, 'unknown'),
    device: DEVICES.has(device) ? device : 'other',
    browser: str(b.browser, 12, 'other').replace(/[^a-z]/g, '') || 'other',
    tier: str(b.tier, 16, 'unknown'),
    dpr: num(b.dpr, 8),
    frames: Math.round(num(b.frames, 1e8)),
    frameP50Ms: num(b.frameP50Ms, 1000),
    frameP95Ms: num(b.frameP95Ms, 1000),
    fpsP50: num(b.fpsP50, 1000),
    longTasks: Math.round(num(b.longTasks, 1e6)),
    longFrames: Math.round(num(b.longFrames, 1e7)),
    contextLosses: Math.round(num(b.contextLosses, 1e4)),
    reloadWithoutCleanExit: b.reloadWithoutCleanExit === true,
    matchCompleted: b.matchCompleted === true,
    durationSec: Math.round(num(b.durationSec, 86400)),
  };
}

/** The first stack line that names a frame, with the Vite hash and line:col removed. */
export function topFrame(stack: string): string {
  for (const line of String(stack ?? '').split('\n')) {
    const l = line.trim();
    if (!/^at |@|\.js|\.ts/.test(l)) continue;
    return l
      .replace(/^at\s+/, '')
      .replace(/https?:\/\/[^/\s)]+/g, '')
      .replace(/-[A-Za-z0-9_-]{8}(\.(?:js|mjs))/g, '$1')
      .replace(/(:\d+)+(\)?)$/g, '$2')
      .slice(0, 160);
  }
  return '';
}

/** Stable signature text: message with numbers/ids flattened + top frame. */
export function signatureOf(kind: string, message: string, stack: string): { sig: string; top: string } {
  const msg = String(message ?? '').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/0x[0-9a-f]+/gi, 'N').slice(0, 200);
  const top = topFrame(stack);
  return { sig: `${kind}|${msg}|${top}`, top };
}

/** Device class of an errorBeacon `ua` (browser/os/device). */
function deviceOfUa(ua: string | undefined): string {
  const d = String(ua ?? '').split('/')[2] ?? '';
  return DEVICES.has(d) ? d : 'other';
}

const approxBytes = (v: unknown) => JSON.stringify(v).length + 1;

export class BeaconStore {
  private signatures = new Map<string, SignatureGroup>();
  /** Bytes each group was last accounted at (groups grow as builds/devices add up). */
  private sigBytes = new Map<string, number>();
  private sessions: SessionRecord[] = [];
  private byNonce = new Map<string, SessionRecord>();
  private bytes = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: { path?: string | null; maxBytes?: number; now?: () => number; flushMs?: number } = {},
  ) {
    if (opts.path) this.load(opts.path);
    if (opts.path && (opts.flushMs ?? 30_000) > 0) {
      this.flushTimer = setInterval(() => this.flush(), opts.flushMs ?? 30_000);
      this.flushTimer.unref?.();
    }
  }

  private get max(): number { return this.opts.maxBytes ?? STORE_MAX_BYTES; }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  /** An error beacon (already sanitised by LobbyServer.sanitizeBeacon). */
  recordError(b: Record<string, string>): SignatureGroup {
    const { sig, top } = signatureOf(b.kind, b.message, b.stack ?? '');
    const t = this.now();
    let g = this.signatures.get(sig);
    if (!g) {
      g = { sig, kind: b.kind, message: String(b.message ?? '').slice(0, 300), topFrame: top, count: 0,
        builds: {}, devices: {}, firstSeen: t, lastSeen: t, sampleStack: String(b.stack ?? '').slice(0, 600) };
      this.signatures.set(sig, g);
    } else {
      // Map order = recency: move to the back so eviction drops the stalest group.
      this.signatures.delete(sig);
      this.signatures.set(sig, g);
    }
    g.count += 1;
    g.lastSeen = t;
    const build = String(b.buildId ?? 'unknown').slice(0, 40);
    g.builds[build] = (g.builds[build] ?? 0) + 1;
    const dev = deviceOfUa(b.ua);
    g.devices[dev] = (g.devices[dev] ?? 0) + 1;
    this.account(g);
    this.dirty = true;
    this.evict();
    return g;
  }

  /** A session summary (already sanitised). Same nonce replaces. */
  recordSession(s: Omit<SessionRecord, 't'>): void {
    const rec: SessionRecord = { t: this.now(), ...s };
    const prev = this.byNonce.get(rec.nonce);
    if (prev) {
      // Keep the killed-marker verdict of an earlier report; take the fuller numbers.
      rec.reloadWithoutCleanExit = rec.reloadWithoutCleanExit || prev.reloadWithoutCleanExit;
      const i = this.sessions.indexOf(prev);
      if (i >= 0) this.sessions.splice(i, 1);
      this.bytes -= approxBytes(prev);
    }
    this.sessions.push(rec);
    this.byNonce.set(rec.nonce, rec);
    this.bytes += approxBytes(rec);
    this.dirty = true;
    this.evict();
  }

  private evict(): void {
    let drop = 0;
    while (this.bytes > this.max && drop < this.sessions.length) {
      const s = this.sessions[drop++];
      this.byNonce.delete(s.nonce);
      this.bytes -= approxBytes(s);
    }
    if (drop > 0) this.sessions.splice(0, drop);
    while ((this.bytes > this.max || this.signatures.size > MAX_SIGNATURES) && this.signatures.size > 0) {
      const [sig, g] = this.signatures.entries().next().value as [string, SignatureGroup];
      this.signatures.delete(sig);
      this.bytes -= this.sigBytes.get(sig) ?? approxBytes(g);
      this.sigBytes.delete(sig);
    }
  }

  private account(g: SignatureGroup): void {
    const b = approxBytes(g);
    this.bytes += b - (this.sigBytes.get(g.sig) ?? 0);
    this.sigBytes.set(g.sig, b);
  }

  /** Serialized size (what the ring is capped on). */
  sizeBytes(): number { return JSON.stringify(this.snapshot()).length; }
  approxSize(): number { return this.bytes; }

  beaconsReport(sinceMs = 0): { total: number; signatures: SignatureGroup[] } {
    const sigs = [...this.signatures.values()].filter((g) => g.lastSeen >= sinceMs).sort((a, b) => b.count - a.count);
    return { total: sigs.reduce((n, g) => n + g.count, 0), signatures: sigs };
  }

  telemetryReport(sinceMs = 0): {
    sessions: number; fpsBins: readonly number[];
    byDevice: Record<string, { n: number; completed: number; killed: number; contextLosses: number; fpsHist: number[] }>;
    recent: SessionRecord[];
  } {
    const recent = this.sessions.filter((s) => s.t >= sinceMs);
    const byDevice: Record<string, { n: number; completed: number; killed: number; contextLosses: number; fpsHist: number[] }> = {};
    for (const s of recent) {
      const d = (byDevice[s.device] ??= { n: 0, completed: 0, killed: 0, contextLosses: 0, fpsHist: FPS_BINS.map(() => 0) });
      d.n += 1;
      if (s.matchCompleted) d.completed += 1;
      if (s.reloadWithoutCleanExit) d.killed += 1;
      d.contextLosses += s.contextLosses;
      if (s.frames > 0) {
        let bin = 0;
        for (let i = 0; i < FPS_BINS.length; i++) if (s.fpsP50 >= FPS_BINS[i]) bin = i;
        d.fpsHist[bin] += 1;
      }
    }
    return { sessions: recent.length, fpsBins: FPS_BINS, byDevice, recent };
  }

  snapshot(): { v: 1; signatures: SignatureGroup[]; sessions: SessionRecord[] } {
    return { v: 1, signatures: [...this.signatures.values()], sessions: this.sessions };
  }

  flush(): void {
    const path = this.opts.path;
    if (!path || !this.dirty) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(this.snapshot()));
      renameSync(`${path}.tmp`, path);
      this.dirty = false;
    } catch (err) {
      console.warn('[beaconStore] flush failed:', (err as Error).message);
    }
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }

  private load(path: string): void {
    try {
      if (!existsSync(path)) return;
      const snap = JSON.parse(readFileSync(path, 'utf8')) as { signatures?: SignatureGroup[]; sessions?: SessionRecord[] };
      for (const g of snap.signatures ?? []) { this.signatures.set(g.sig, g); this.account(g); }
      for (const s of snap.sessions ?? []) { this.sessions.push(s); this.byNonce.set(s.nonce, s); this.bytes += approxBytes(s); }
      this.evict();
    } catch (err) {
      console.warn('[beaconStore] load failed, starting empty:', (err as Error).message);
    }
  }
}

/** HEALTH_KEY posture: key configured -> X-Health-Key must match; none -> non-proxied loopback only. */
export function beaconAccessAllowed(req: Pick<IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string } }, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env.HEALTH_KEY;
  if (key) {
    const given = req.headers['x-health-key'];
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  if (req.headers['fly-client-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined) return false;
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export const BEACON_ROUTES: ReadonlySet<string> = new Set(['/health/beacons', '/health/telemetry']);

/** GET /health/beacons | /health/telemetry (?sinceHours=N). 403 without the key. */
export function serveBeaconRoute(store: BeaconStore, req: IncomingMessage, res: ServerResponse, path: string): void {
  if (req.method !== 'GET') {
    req.resume?.();
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
    res.end('Method Not Allowed');
    return;
  }
  if (!beaconAccessAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Forbidden');
    return;
  }
  const hours = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('sinceHours'));
  const since = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600_000 : 0;
  const body = path === '/health/beacons' ? store.beaconsReport(since) : store.telemetryReport(since);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The process's store: on the Fly volume (/app/data) when it exists, else memory only. */
function defaultPath(): string | null {
  if (process.env.BEACON_STORE_PATH !== undefined) return process.env.BEACON_STORE_PATH || null;
  return existsSync('/app/data') ? '/app/data/beacons.json' : null;
}

let shared: BeaconStore | null = null;
export function getBeaconStore(): BeaconStore {
  shared ??= new BeaconStore({ path: defaultPath() });
  return shared;
}
