/**
 * THE INTERPOLATION BUFFER — how a body that belongs to somebody else is placed.
 *
 * WHAT WAS THERE BEFORE. The client was a pure extrapolator. Every remote body
 * was drawn at
 *
 *     p_snapshot + v_snapshot × (now − whenThatPacketLANDED)
 *
 * and the clue is the last term: the age was measured from the moment the packet
 * ARRIVED, not from the moment the server took the sample. Those two differ by
 * however late the packet was, so the network's arrival jitter went straight into
 * the drawn position. A snapshot that came 60ms after its predecessor instead of
 * 32ms left the body extrapolated 28ms — 13cm at a walk, more at a sprint — past
 * where the next sample said it actually was, and the next sample yanked it back
 * inside one frame. Measured on the bot fleet with a 106Hz reconstruction of the
 * drawn path (scripts/test-remote-smoothness.mjs): a 0.345m step at p99 and a
 * 0.917m worst, which at the range that body was drawn is 164 PIXELS of sideways
 * jump. The older motion-continuity suite reads 1.00 carry through all of it,
 * because carry asks "does it move" and this defect is "it moves, then it is
 * corrected".
 *
 * WHAT REPLACES IT. Samples are stamped with the SERVER time they describe and
 * kept in a short per-entity ring. The renderer asks the buffer for a position at
 * a render time on that same server timeline, and gets it by interpolating the
 * two samples that bracket it. Nothing about the answer is a function of when a
 * packet landed, so arrival jitter cannot move a body at all — it only changes
 * how much history is available, and there is a delay held in hand for exactly
 * that.
 *
 * THREE PARTS.
 *
 *  1. {@link RemoteTimeline} — the clock. Estimating "what server time is it now"
 *     from arrivals is a jittery business, so the estimate is never used directly:
 *     a local clock is advanced by real elapsed time and SERVOED toward the
 *     estimate by dilating its rate within ±12%. That guarantees the render time
 *     is continuous and monotonic no matter what the packet stream does, which in
 *     turn guarantees no drawn position can ever step. Only a gap big enough to be
 *     a join, a tab restore or a genuine disconnect (HARD_SNAP_S) re-anchors it.
 *
 *  2. The delay. Rendering at (server now − delay) is what buys the bracketing
 *     sample. It starts at 1.5 snapshot intervals and adapts to the MEASURED
 *     arrival jitter between bounds, so a clean connection pays the minimum and a
 *     ragged one pays what it has to instead of starving.
 *
 *  3. {@link RemoteTrack} — one ring per entity. Interpolates between brackets,
 *     falls back to BOUNDED extrapolation from the newest pair only when the
 *     buffer starves, and refuses to interpolate across a frame change (a pirate
 *     who boards a ship changes what his coordinates MEAN, and lerping across
 *     that would drag him through the hull).
 *
 * WHAT IS DELIBERATELY NOT IN HERE. The local player. His motion, his aim and his
 * one-shot actions are predicted and must never be handed a delay — see
 * Game.getPlayerRenderPosition, which keeps its own dead-reckoning branch for him
 * and only routes OTHER people through this file.
 */

/** One hot-snapshot interval: SNAPSHOT_RATE(2) × SERVER_TICK_MS(16), in seconds. */
export const SNAPSHOT_INTERVAL_S = 0.032;

/**
 * How much history a track keeps. 24 samples is ~0.77s at 31Hz — comfortably more
 * than the largest delay the timeline will ever ask for, so the buffer can answer
 * from history even after a burst of late packets, and small enough that the whole
 * ring for a 60-body match is a few kilobytes of Float64.
 */
const TRACK_CAPACITY = 24;

/** Delay bounds, in snapshot intervals. */
const DELAY_MIN_S = SNAPSHOT_INTERVAL_S * 1.0;
const DELAY_MAX_S = SNAPSHOT_INTERVAL_S * 6.0;
const DELAY_BASE_S = SNAPSHOT_INTERVAL_S * 1.5;
/**
 * The delay must cover the jitter, not the average. 2.5 standard-ish deviations
 * of the measured arrival error is the usual engineering number and it is what
 * turns "the buffer starves on one snapshot in twenty" into "the buffer starves
 * when the connection genuinely breaks".
 */
const JITTER_MARGIN = 2.5;
/** Delay moves at most this fast (seconds of delay per second of wall clock), so
 *  a jitter spike widens the window as a slow drift, never as a step. */
const DELAY_SLEW_PER_S = 0.15;

/**
 * THE AIM LEAD, AND THE ONE THING THIS CHANGE COSTS THE PLAYER.
 *
 * Rendering an opponent at (server now − delay) draws him where he WAS. There is
 * no lag compensation on the server — Match resolves a hitscan against the
 * positions it holds at the moment your fire message arrives — so every
 * millisecond of delay is a millisecond you must lead a moving target by.
 *
 * The path this replaced drew remotes at snapshot + age + 0.035s: it led the
 * target by 35ms on purpose, as a standing approximation of the trip your shot
 * has to make. That lead was tuned into the game and there is no reason to
 * throw it away in order to buy a bracket, so it is given back here — the delay
 * that gets rendered is the buffer's requirement MINUS the lead, floored at one
 * whole snapshot interval so a bracketing pair is still guaranteed.
 *
 * IT MAY ONLY EAT THE SURPLUS. The first reading of this with the lead taken
 * off the whole delay measured what that costs: the delay fell to 1.2 measured
 * intervals, the buffer starved on 3.8% of answers instead of 1.4%, and the
 * shark population went from p99 0.015m to 0.087m — the jitter it had been
 * covering came straight back as steps. So the lead is only allowed to spend
 * what is left ABOVE a guaranteed bracket, which is one whole MEASURED interval
 * plus the jitter margin. On a clean wire that is ~35ms and the lead is given
 * back almost in full; on a ragged one the bracket wins and the buffer is fed
 * first, which is the right priority — a target that snaps is harder to hit than
 * one that is honestly late.
 */
const AIM_LEAD_S = 0.035;

/**
 * BOUNDED EXTRAPOLATION. When the render time runs past the newest sample the
 * buffer has, the body is carried forward along the velocity of its newest PAIR.
 * Capped, because past this the guess is worth less than standing still and a
 * body that flies off on a stale velocity is worse than one that pauses.
 */
const MAX_EXTRAPOLATION_S = 0.20;

/**
 * A push this much newer than the newest sample held is a REAPPEARANCE, not the
 * next sample: a pirate who died and respawned across the map, or a body the
 * server stopped reporting for a while. The ring is emptied rather than
 * bracketed across it — half a second of history that ends where a man fell and
 * begins where he came back would be interpolated as a slow glide between the
 * two, which is the one thing worse than the cut it really is.
 */
const STALE_GAP_S = 0.5;

/** Rate dilation limit for the servo. ±12% of real time is imperceptible on a
 *  walking body (7mm/s at 5.5 m/s) and closes a 100ms error in under a second. */
const MAX_RATE_SKEW = 0.12;
/** A disagreement bigger than this is not drift, it is a new timeline. */
const HARD_SNAP_S = 0.75;

/** What {@link RemoteTrack.sample} did, for instrumentation and for the gate. */
export type SampleMode = 'interpolated' | 'extrapolated' | 'held' | 'empty';

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  mode: SampleMode;
  /**
   * WHICH COORDINATE SYSTEM THE ANSWER IS IN, which is not always the one the
   * newest sample is in. A pirate who boarded and stepped off again leaves a ring
   * of [world, world, ship, ship, world] — ask for a render time inside the ship
   * stretch and you get ship-LOCAL numbers back while the newest sample is a
   * world one. A caller that checked the track's newest frame would then treat a
   * 2-metre deck offset as a world position and draw him at the origin. Measured
   * as a 6.78m deck-slip outlier in a 60s run before this field existed.
   */
  frame: string | null;
}

const TAU = Math.PI * 2;

/** Shortest signed angular difference b−a, wrapped into (−π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * One entity's history: a ring of (serverTime, x, y, z, yaw, frame).
 *
 * `frame` is the coordinate system the sample is expressed in — for a pirate it
 * is the id of the ship he is standing on, or '' ashore. Two samples in different
 * frames are not comparable, so the track never interpolates across the boundary;
 * it snaps to the newest instead. That is the boarding case, and lerping through
 * it would walk a man through a hull over 48ms.
 */
export class RemoteTrack {
  private readonly t = new Float64Array(TRACK_CAPACITY);
  private readonly x = new Float64Array(TRACK_CAPACITY);
  private readonly y = new Float64Array(TRACK_CAPACITY);
  private readonly z = new Float64Array(TRACK_CAPACITY);
  private readonly yaw = new Float64Array(TRACK_CAPACITY);
  private readonly frame: (string | null)[] = new Array(TRACK_CAPACITY).fill(null);
  /** Index one past the newest sample, modulo capacity. */
  private head = 0;
  private count = 0;
  /** Wall-clock ms of the last push — used to retire tracks nobody is feeding. */
  touchedAt = 0;

  get length() { return this.count; }
  get newestTime() { return this.count === 0 ? Number.NEGATIVE_INFINITY : this.t[(this.head + TRACK_CAPACITY - 1) % TRACK_CAPACITY]; }
  get oldestTime() { return this.count === 0 ? Number.POSITIVE_INFINITY : this.t[(this.head + TRACK_CAPACITY - this.count) % TRACK_CAPACITY]; }

  clear() {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Record where this body was at server time `t`. Out-of-order and duplicate
   * samples are dropped rather than inserted: the wire is unordered enough that a
   * hot can overtake the full it was built from, and a ring that is not sorted by
   * time cannot be bracketed.
   */
  push(t: number, x: number, y: number, z: number, yaw: number, frame: string | null, nowMs: number) {
    this.touchedAt = nowMs;
    if (this.count > 0 && t <= this.newestTime) return;
    // A GAP THIS BIG IS NOT HISTORY, IT IS A REAPPEARANCE. A pirate who died and
    // respawned, or a body the server stopped sending for a while, comes back
    // with a sample seconds newer than anything held. Bracketing across that gap
    // would walk him from where he fell to where he respawned over the whole
    // span — a slow glide across the map instead of the cut it actually is.
    if (this.count > 0 && t - this.newestTime > STALE_GAP_S) this.clear();
    const i = this.head;
    this.t[i] = t;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.yaw[i] = yaw;
    this.frame[i] = frame;
    this.head = (i + 1) % TRACK_CAPACITY;
    if (this.count < TRACK_CAPACITY) this.count++;
  }

  private idx(n: number) { return (this.head + TRACK_CAPACITY - this.count + n) % TRACK_CAPACITY; }

  /**
   * Where this body is at server time `renderT`, written into `out`.
   *
   * Returns the mode so callers (and the gate) can tell an answer that came from
   * two real samples apart from one that is a guess.
   */
  sample(renderT: number, out: RemotePose): SampleMode {
    if (this.count === 0) {
      out.mode = 'empty';
      out.frame = null;
      return 'empty';
    }
    const newest = this.idx(this.count - 1);
    if (this.count === 1) {
      out.x = this.x[newest]; out.y = this.y[newest]; out.z = this.z[newest];
      out.yaw = this.yaw[newest];
      out.frame = this.frame[newest];
      out.mode = 'held';
      return 'held';
    }
    const oldest = this.idx(0);
    if (renderT <= this.t[oldest]) {
      // Behind everything we hold: the connection just came back, or the delay
      // widened faster than history accumulated. Hold the oldest rather than
      // extrapolate backwards into a past nobody measured.
      out.x = this.x[oldest]; out.y = this.y[oldest]; out.z = this.z[oldest];
      out.yaw = this.yaw[oldest];
      out.frame = this.frame[oldest];
      out.mode = 'held';
      return 'held';
    }
    if (renderT >= this.t[newest]) {
      const prev = this.idx(this.count - 2);
      const span = this.t[newest] - this.t[prev];
      const ahead = Math.min(MAX_EXTRAPOLATION_S, renderT - this.t[newest]);
      if (span <= 0 || this.frame[prev] !== this.frame[newest]) {
        out.x = this.x[newest]; out.y = this.y[newest]; out.z = this.z[newest];
        out.yaw = this.yaw[newest];
        out.frame = this.frame[newest];
        out.mode = 'held';
        return 'held';
      }
      const inv = 1 / span;
      out.x = this.x[newest] + (this.x[newest] - this.x[prev]) * inv * ahead;
      out.y = this.y[newest] + (this.y[newest] - this.y[prev]) * inv * ahead;
      out.z = this.z[newest] + (this.z[newest] - this.z[prev]) * inv * ahead;
      out.yaw = this.yaw[newest] + angleDelta(this.yaw[prev], this.yaw[newest]) * inv * ahead;
      out.frame = this.frame[newest];
      out.mode = 'extrapolated';
      return 'extrapolated';
    }
    // Walk back from the newest — the answer is almost always in the last pair,
    // and a linear scan over at most 24 entries beats keeping a sorted index.
    for (let n = this.count - 1; n > 0; n--) {
      const b = this.idx(n);
      if (this.t[b] < renderT) break;
      const a = this.idx(n - 1);
      if (this.t[a] > renderT) continue;
      const span = this.t[b] - this.t[a];
      if (this.frame[a] !== this.frame[b] || span <= 0) {
        out.x = this.x[b]; out.y = this.y[b]; out.z = this.z[b];
        out.yaw = this.yaw[b];
        out.frame = this.frame[b];
        out.mode = 'held';
        return 'held';
      }
      const u = (renderT - this.t[a]) / span;
      out.x = this.x[a] + (this.x[b] - this.x[a]) * u;
      out.y = this.y[a] + (this.y[b] - this.y[a]) * u;
      out.z = this.z[a] + (this.z[b] - this.z[a]) * u;
      out.yaw = this.yaw[a] + angleDelta(this.yaw[a], this.yaw[b]) * u;
      out.frame = this.frame[a];
      out.mode = 'interpolated';
      return 'interpolated';
    }
    out.x = this.x[newest]; out.y = this.y[newest]; out.z = this.z[newest];
    out.yaw = this.yaw[newest];
    out.frame = this.frame[newest];
    out.mode = 'held';
    return 'held';
  }

  /** The frame the newest sample is expressed in — callers compose against the
   *  matching hull, and a mismatch means the body just boarded or stepped off. */
  get newestFrame(): string | null {
    return this.count === 0 ? null : this.frame[this.idx(this.count - 1)];
  }
}

/**
 * The shared clock and the shared delay. One per match.
 *
 * `noteSnapshot` is fed every applied snapshot (hot and full alike). `advance` is
 * called once a frame. `renderTimeAt` may be called any number of times at any
 * instant between advances and is exact and monotonic in its argument — which is
 * what lets a 106Hz probe reconstruct the drawn path without drawing anything.
 */
export class RemoteTimeline {
  /** Server seconds at `anchorClientMs`. */
  private anchorServerT = 0;
  private anchorClientMs = 0;
  /** Current dilation of the local clock, 1 = real time. */
  private rate = 1;
  private started = false;

  /** Newest server time any snapshot has reported. */
  newestServerT = Number.NEGATIVE_INFINITY;
  /** Arrival-jitter EMA, seconds. */
  jitter = 0;
  /** Current delay, seconds. */
  delay = DELAY_BASE_S;
  /** Snapshot-interval EMA measured off server timestamps, seconds. */
  interval = SNAPSHOT_INTERVAL_S;

  /**
   * HARNESS ONLY, and it is not a hack — it is what makes CARRY measurable again.
   *
   * scripts/test-motion-continuity.mjs reads the transfer function of the
   * placement arithmetic by evaluating a body twice with the clock a snapshot
   * interval apart and dividing the distance by how far the body really travels
   * in one. For a dead-reckoned body the clock it has to move is `lastSnapshotAt`
   * — the packet's arrival — and that is what the suite pinned. For a buffered
   * body arrival time does not enter the answer AT ALL, which is the entire
   * point of this file, so pinning it moves nothing and carry reads 0.00 on a
   * path that is in fact perfectly continuous. The clock that has to move is this
   * one. Written only by the harness, in a single synchronous block, and put
   * back; the game never touches it.
   */
  debugSkewMs = 0;

  private lastArrivalMs = -1;
  private lastServerT = -1;
  private lastAdvanceMs = -1;
  /**
   * Counters the gate reads. The two are not the same event and must never be
   * added together.
   *
   * BACKWARD is always a defect: the clock was moved to an earlier server time,
   * so every remote body in the world is redrawn where it already was. Nothing
   * legitimate does that.
   *
   * FORWARD is a data gap that has been survived. This machine measures snapshot
   * arrivals up to 2.1 SECONDS apart — a frame spent building an island cannot
   * run the message callback — and after a gap that long the world genuinely has
   * moved on. Slewing at 12% would take fifteen seconds to catch up and draw
   * everyone a second and a half in the past the whole way; the snap is correct
   * and the honest thing is to count it, not to forbid it.
   */
  hardSnapsBack = 0;
  hardSnapsForward = 0;
  get hardSnaps() { return this.hardSnapsBack + this.hardSnapsForward; }

  reset() {
    this.started = false;
    this.newestServerT = Number.NEGATIVE_INFINITY;
    this.jitter = 0;
    this.delay = DELAY_BASE_S;
    this.interval = SNAPSHOT_INTERVAL_S;
    this.lastArrivalMs = -1;
    this.lastServerT = -1;
    this.lastAdvanceMs = -1;
    this.rate = 1;
    this.hardSnapsBack = 0;
    this.hardSnapsForward = 0;
  }

  get ready() { return this.started; }

  /** Feed one applied snapshot: its server time, and the client clock it landed on. */
  noteSnapshot(serverT: number, nowMs: number) {
    if (!Number.isFinite(serverT)) return;
    if (serverT > this.newestServerT) this.newestServerT = serverT;
    if (!this.started) {
      this.started = true;
      this.anchorServerT = serverT - this.delay;
      this.anchorClientMs = nowMs;
      this.rate = 1;
      this.lastArrivalMs = nowMs;
      this.lastServerT = serverT;
      return;
    }
    if (this.lastArrivalMs >= 0 && serverT > this.lastServerT) {
      const serverGap = serverT - this.lastServerT;
      const arrivalGap = (nowMs - this.lastArrivalMs) / 1000;
      // The interval is a property of the SERVER's cadence, so it is measured off
      // server timestamps and is immune to how late anything was.
      this.interval += (Math.min(0.5, serverGap) - this.interval) * 0.05;
      // …and the jitter is precisely the disagreement between the two, which is
      // the quantity the delay has to cover.
      const err = Math.abs(arrivalGap - serverGap);
      this.jitter += (Math.min(0.5, err) - this.jitter) * 0.08;
    }
    if (serverT > this.lastServerT) {
      this.lastArrivalMs = nowMs;
      this.lastServerT = serverT;
    }
  }

  /**
   * Server time being rendered at client clock `nowMs`. Continuous and
   * non-decreasing in `nowMs`, which is the property every drawn position
   * inherits.
   *
   * THE CLAMP IS NOT AN OPTIMISATION. A frame on the target machine can run for a
   * second, and during that second no snapshot is applied — the message callback
   * cannot run inside a synchronous frame. The free-running clock therefore
   * outruns the newest sample by the whole length of the stall, and the next
   * `advance` saw an error past HARD_SNAP_S and re-anchored the clock BACKWARDS:
   * measured 15 times in a 60s window on SwiftShader, and every one of those is
   * every remote body in the world teleporting at once. Parking the clock a
   * bounded distance past the newest sample instead costs nothing (nothing is
   * being drawn during the stall) and it keeps the error inside the servo's
   * range, so the hard snap is left to do the only job it should ever have: a
   * join, or a stream that stopped and came back.
   *
   * `Math.min` of two non-decreasing functions is non-decreasing, and both of
   * these are, so the clamp cannot make a body step backwards.
   */
  renderTimeAt(nowMs: number): number {
    if (!this.started) return Number.NEGATIVE_INFINITY;
    const free = this.anchorServerT + ((nowMs + this.debugSkewMs - this.anchorClientMs) / 1000) * this.rate;
    return Math.min(free, this.newestServerT + MAX_EXTRAPOLATION_S);
  }

  /**
   * Once per frame: re-anchor at the current render time, re-derive the delay
   * from the measured jitter, and choose the rate that walks the clock toward
   * (newest − delay) without ever stepping it.
   */
  advance(nowMs: number) {
    if (!this.started) return;
    const t = this.renderTimeAt(nowMs);
    const dt = this.lastAdvanceMs < 0 ? 0 : Math.max(0, (nowMs - this.lastAdvanceMs) / 1000);
    this.lastAdvanceMs = nowMs;
    this.anchorServerT = t;
    this.anchorClientMs = nowMs;

    // What starvation actually requires: one whole interval of history plus the
    // margin the measured jitter demands. Note this is the MEASURED interval, not
    // the nominal 32ms — a client whose snapshots arrive every 45ms needs 45ms of
    // bracket, and a floor written in nominal intervals silently under-buys it.
    const bracket = this.interval + this.jitter * JITTER_MARGIN;
    const want = this.interval * 1.5 + this.jitter * JITTER_MARGIN;
    const wantDelay = Math.min(
      DELAY_MAX_S,
      Math.max(DELAY_MIN_S, bracket, want - AIM_LEAD_S),
    );
    const slew = DELAY_SLEW_PER_S * Math.min(0.25, dt || SNAPSHOT_INTERVAL_S);
    this.delay += Math.max(-slew, Math.min(slew, wantDelay - this.delay));

    const target = this.newestServerT - this.delay;
    const err = target - t;
    if (Math.abs(err) > HARD_SNAP_S) {
      // A join, a tab that was backgrounded, or a stream that stopped and
      // restarted. Nothing continuous can be made of that, so say so and re-anchor.
      this.anchorServerT = target;
      this.rate = 1;
      if (err < 0) this.hardSnapsBack++; else this.hardSnapsForward++;
      return;
    }
    // Close the error over ~0.4s, bounded. Dead zone so a settled clock does not
    // hunt around its target at snapshot granularity.
    this.rate = Math.abs(err) < 0.002 ? 1 : 1 + Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, err * 2.5));
  }
}

/**
 * Every remote body's history, indexed by a namespaced id, plus the shared clock.
 *
 * Namespacing matters: a ship and a pirate can share neither an id space nor a
 * frame, and mixing them in one map is how a hull ends up interpolated toward a
 * man's shoulder.
 */
export class RemoteInterpolator {
  readonly timeline = new RemoteTimeline();
  private readonly tracks = new Map<string, RemoteTrack>();
  private readonly scratch: RemotePose = { x: 0, y: 0, z: 0, yaw: 0, mode: 'empty', frame: null };
  /** Mode census for the smoothness gate: how the last frame's answers were made. */
  readonly modeCounts: Record<SampleMode, number> = { interpolated: 0, extrapolated: 0, held: 0, empty: 0 };
  /**
   * THE MUTATION LEVER. Off, every caller falls back to the dead reckoning it
   * used before this file existed — same match, same wire, same walker. That is
   * what lets scripts/test-remote-smoothness.mjs measure both arms inside ONE
   * run and assert that its bar is a bar the old arithmetic cannot clear, rather
   * than comparing two runs of two builds and hoping the network was the same.
   * Reachable only through `window.__piratesBR.setRemoteInterpolation`.
   */
  enabled = true;

  reset() {
    this.timeline.reset();
    this.tracks.clear();
    for (const k of Object.keys(this.modeCounts) as SampleMode[]) this.modeCounts[k] = 0;
  }

  track(key: string): RemoteTrack {
    let t = this.tracks.get(key);
    if (!t) {
      t = new RemoteTrack();
      this.tracks.set(key, t);
    }
    return t;
  }

  peek(key: string): RemoteTrack | undefined { return this.tracks.get(key); }

  /**
   * Sample a body at the current render time. Returns null when nothing has ever
   * been recorded for it (first frame after it appeared) — callers fall back to
   * the raw snapshot, which is the right answer for exactly one frame.
   */
  poseAt(key: string, nowMs: number): RemotePose | null {
    if (!this.enabled) return null;
    const track = this.tracks.get(key);
    if (!track || track.length === 0) return null;
    const renderT = this.timeline.renderTimeAt(nowMs);
    if (!Number.isFinite(renderT)) return null;
    const mode = track.sample(renderT, this.scratch);
    this.modeCounts[mode]++;
    return this.scratch;
  }

  /** Drop tracks nobody has fed for `maxAgeMs` — deaths, despawns, culled bodies. */
  retire(nowMs: number, maxAgeMs = 5000) {
    for (const [key, track] of this.tracks) {
      if (nowMs - track.touchedAt > maxAgeMs) this.tracks.delete(key);
    }
  }
}
