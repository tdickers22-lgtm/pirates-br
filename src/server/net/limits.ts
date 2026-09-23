/**
 * PUBLIC-INTERNET ABUSE LIMITS (online-06, vm:correctness:4).
 *
 * Every match on the host runs its 60 Hz tick on ONE event loop, and that same
 * loop parses every inbound frame and accepts every socket. Before this module
 * a single script could open tens of thousands of sockets from one address
 * (each a ClientSession + deflate context) or spam create_party hundreds of
 * times a second, and every live match paid for it. The 2026-09 IDENT-01 input
 * buckets never landed (grep: no rate limiting anywhere in src/server), so a
 * player_input flood cost every match CPU too.
 *
 * Two layers, both pure (clock passed in) so the suite can drive them:
 *
 *  1. ConnectionGate, BEFORE the upgrade: Origin allowlist, <= 8 live sockets
 *     per IP, <= 400 live sockets in total, <= 20 new sockets per minute per
 *     IP. A refusal is an HTTP status on the upgrade request (403 / 429 / 503),
 *     so a refused socket never allocates a session or a deflate window.
 *  2. SessionLimiter, per socket: token buckets per message class. A frame
 *     over budget is DROPPED and charged as debt (the bucket goes negative, to
 *     a floor), so a burst digs a hole that takes rate-seconds to climb out
 *     of. A socket that stays in debt for ABUSE_CLOSE_MS is closed with 1008.
 *
 * The numbers sit well above the real client: NetworkClient sends player_input
 * at most every 1/45 s (Game.ts CLIENT_INPUT_SEND_INTERVAL; ~30/s at 60 Hz,
 * ~36/s at 144 Hz) plus edge-triggered presses, and one ping every 3 s. The
 * input budget (120/s) is ~3x the fastest real cadence.
 *
 * Loopback addresses are exempt from the PER-IP connection caps by default:
 * without PIRATES_BR_TRUST_PROXY every player behind the Vite dev proxy is
 * 127.0.0.1, and the local suites open dozens of sockets from it. On Fly the
 * key is the x-forwarded-for client (TRUST_PROXY=1), never loopback.
 * PIRATES_BR_LIMIT_LOOPBACK=1 removes the exemption. The TOTAL cap and the
 * per-session buckets apply to everyone.
 */

export interface BucketSpec {
  /** Sustained messages per second. */
  rate: number;
  /** Messages admitted back to back from a full bucket. */
  burst: number;
}

/** A bucket in debt stops sinking after this many seconds of its own rate. */
const DEBT_FLOOR_SECONDS = 30;

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly spec: BucketSpec, now: number) {
    this.tokens = spec.burst;
    this.last = now;
  }

  private refill(now: number): void {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = Math.max(this.last, now);
    this.tokens = Math.min(this.spec.burst, this.tokens + dt * this.spec.rate);
  }

  /** Charge one message. True = admitted. A refused message is still charged
   *  (down to the debt floor), so flooding keeps the bucket underwater. */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.tokens = Math.max(this.tokens - 1, -this.spec.rate * DEBT_FLOOR_SECONDS);
    return false;
  }

  inDebt(now: number): boolean {
    this.refill(now);
    return this.tokens < 0;
  }

  /** Refilled to the brim: indistinguishable from a fresh bucket. */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.spec.burst;
  }
}

// ─── Per-session message buckets ───────────────────────────────

export type MsgClass = 'frame' | 'lobby' | 'input' | 'ping' | 'match';

/** Per-socket budgets. `frame` is charged for EVERY inbound frame before it
 *  is parsed (binary, oversized and garbage frames included). */
export const SESSION_LIMITS: Record<MsgClass, BucketSpec> = {
  frame: { rate: 200, burst: 400 },
  lobby: { rate: 10, burst: 20 },
  input: { rate: 120, burst: 240 },
  ping: { rate: 2, burst: 4 },
  match: { rate: 30, burst: 60 },
};

/** Continuously over budget this long -> close 1008 (policy violation). */
export const ABUSE_CLOSE_MS = 10_000;
export const ABUSE_CLOSE_CODE = 1008;

const MATCH_SCOPED = new Set(['shop_buy', 'trade_action', 'dev_bot_peace', 'dev_grant_gold']);

/** Which bucket a parsed frame's `type` is charged to. Unknown types are
 *  charged as lobby traffic (the strictest general bucket): the validator
 *  refuses them, but they were parsed, and parsing is the cost. */
export function classifyMsg(type: string): Exclude<MsgClass, 'frame'> {
  if (type === 'player_input') return 'input';
  if (type === 'ping') return 'ping';
  if (MATCH_SCOPED.has(type)) return 'match';
  return 'lobby';
}

export class SessionLimiter {
  private readonly buckets: Record<MsgClass, TokenBucket>;
  /** When the socket first went over budget without climbing back out. */
  private overSince: number | null = null;
  dropped = 0;

  constructor(now: number, limits: Record<MsgClass, BucketSpec> = SESSION_LIMITS) {
    this.buckets = {
      frame: new TokenBucket(limits.frame, now),
      lobby: new TokenBucket(limits.lobby, now),
      input: new TokenBucket(limits.input, now),
      ping: new TokenBucket(limits.ping, now),
      match: new TokenBucket(limits.match, now),
    };
  }

  admit(cls: MsgClass, now: number): boolean {
    const ok = this.buckets[cls].take(now);
    if (!ok) {
      this.dropped += 1;
      if (this.overSince === null) this.overSince = now;
    } else {
      this.settle(now);
    }
    return ok;
  }

  private settle(now: number): void {
    if (this.overSince === null) return;
    for (const b of Object.values(this.buckets)) if (b.inDebt(now)) return;
    this.overSince = null;
  }

  /** True once the socket has been over budget for ABUSE_CLOSE_MS straight.
   *  Called on every frame AND from the lobby's 1 s tick, so a flood that
   *  stops sending is still closed on time. */
  shouldClose(now: number): boolean {
    this.settle(now);
    return this.overSince !== null && now - this.overSince >= ABUSE_CLOSE_MS;
  }

  /** When the socket will have been over budget for ABUSE_CLOSE_MS if it
   *  never climbs out, or null while it is inside its budget. */
  closeDueAt(now: number): number | null {
    this.settle(now);
    return this.overSince === null ? null : this.overSince + ABUSE_CLOSE_MS;
  }
}

// ─── Connection gate (before the upgrade) ──────────────────────

export interface ConnectionLimits {
  perIp: number;
  total: number;
  /** New sockets per IP per minute (token bucket, burst = the same number). */
  newPerMinute: number;
  /** Exact origins allowed (scheme://host[:port]); empty = allow any. */
  allowedOrigins: string[];
  limitLoopback: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter((s) => s.length > 0);
}

export function connectionLimitsFromEnv(): ConnectionLimits {
  return {
    perIp: envInt('PIRATES_BR_MAX_SOCKETS_PER_IP', 8),
    total: envInt('PIRATES_BR_MAX_CLIENTS', 400),
    newPerMinute: envInt('PIRATES_BR_NEW_SOCKETS_PER_MIN', 20),
    allowedOrigins: parseAllowedOrigins(process.env.PIRATES_BR_ALLOWED_ORIGINS),
    limitLoopback: process.env.PIRATES_BR_LIMIT_LOOPBACK === '1',
  };
}

export function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
}

export type GateVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 429 | 503; reason: 'origin' | 'per_ip' | 'rate' | 'total' };

export class ConnectionGate {
  private readonly live = new Map<string, number>();
  private readonly newRate = new Map<string, TokenBucket>();
  private total = 0;
  refused = 0;

  constructor(public limits: ConnectionLimits = connectionLimitsFromEnv()) {}

  /** Origin rule: no allowlist = any; a missing Origin header is allowed (node
   *  clients, smoke tests and native apps send none, and a browser always
   *  sends one, so a hostile PAGE cannot hide it). */
  originAllowed(origin: string | undefined): boolean {
    if (this.limits.allowedOrigins.length === 0 || !origin) return true;
    return this.limits.allowedOrigins.includes(origin.trim().replace(/\/+$/, '').toLowerCase());
  }

  /** Decide an upgrade. Charges the new-socket bucket for every attempt that
   *  passes the Origin check (a hammering client pays for its refusals). Does
   *  NOT count the socket as live: call open() when it really connects. */
  check(ip: string, origin: string | undefined, now: number): GateVerdict {
    const verdict = this.decide(ip, origin, now);
    if (!verdict.ok) this.refused += 1;
    return verdict;
  }

  private decide(ip: string, origin: string | undefined, now: number): GateVerdict {
    if (!this.originAllowed(origin)) return { ok: false, status: 403, reason: 'origin' };
    if (this.total >= this.limits.total) return { ok: false, status: 503, reason: 'total' };
    if (!this.limits.limitLoopback && isLoopback(ip)) return { ok: true };
    let bucket = this.newRate.get(ip);
    if (!bucket) {
      bucket = new TokenBucket({ rate: this.limits.newPerMinute / 60, burst: this.limits.newPerMinute }, now);
      this.newRate.set(ip, bucket);
    }
    if ((this.live.get(ip) ?? 0) >= this.limits.perIp) return { ok: false, status: 429, reason: 'per_ip' };
    // A refused attempt is charged as debt too: a client that keeps hammering
    // after its 429 stays refused until it backs off.
    if (!bucket.take(now)) return { ok: false, status: 429, reason: 'rate' };
    return { ok: true };
  }

  open(ip: string): void {
    this.total += 1;
    this.live.set(ip, (this.live.get(ip) ?? 0) + 1);
  }

  close(ip: string): void {
    this.total = Math.max(0, this.total - 1);
    const n = (this.live.get(ip) ?? 0) - 1;
    if (n > 0) this.live.set(ip, n);
    else this.live.delete(ip);
  }

  liveCount(): number {
    return this.total;
  }

  /** Drop per-IP rate buckets that have refilled completely: the Map is keyed
   *  by attacker-chosen text and must not grow without bound. */
  prune(now: number): void {
    for (const [ip, bucket] of this.newRate) {
      if (!this.live.has(ip) && bucket.isFull(now)) this.newRate.delete(ip);
    }
  }

  trackedIps(): number {
    return this.newRate.size;
  }
}
