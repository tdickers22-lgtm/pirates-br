/**
 * THE LOCAL PLAYER'S PREDICTION CLOCK (b2.0d; critique gap 7).
 *
 * Reconciliation rewinds to the server's acked state at `ack.t` and replays the
 * inputs recorded since, up to `now`: the server time at which the input the
 * client is sending THIS frame will be applied. That instant is not the client's
 * wall clock and not `ack.t`; it is `ack.t + RTT` (the ack's trip down plus the
 * input's trip up), and it has to be re-derived from every ack. A clock seeded
 * once and then free-run by the frame step inherits whatever the server clock
 * did in between: b1.3e measured it 0.85 s ahead after the countdown (the sim
 * clock does not run through it), so every replay started inputs 0.67 s early
 * and the correction p99 read 3.8 m against a 0.3 m bar, worse than not
 * replaying at all (0.75 m).
 *
 * WHERE `now` COMES FROM. The ack says it outright: the first ack that
 * carries seq N is the server admitting it applied input N at some tick in
 * (previous ack's t, this ack's t]. Applied-at minus sent-at (client clock) is
 * O + up, the clock offset plus that input's upstream trip, measured on the one
 * quantity replay needs. Read `ack.t + RTT` off each ack instead and TCP ruins
 * it: an ack that sat behind a lost segment lands in a burst 100-190 ms late,
 * and every stale ack in the burst drags the clock back (measured: p99 1.04 m).
 * The estimate is a smoothed mean, not a floor, because the server applies
 * inputs at their MEAN delay, not their best; a single stalled sample is
 * clamped so one retransmit cannot yank every recorded timestamp.
 *
 * The clock slews toward `now + offset`, it does not jump; a clock more than
 * SNAP_S off (a countdown, a stall, a tab that slept) is re-seated at once.
 *
 * PURE: no Date, no performance.now, no allocation per call. The caller passes
 * its own clock; the WAN harness drives it on a virtual one.
 */
export class PredictionClock {
  /** Predicted server time at which the input going on the wire now is applied, seconds. NaN until anchored. */
  t = Number.NaN;
  /** Smoothed (server apply time - client send time), seconds. Null until the first applied input. */
  offsetS: number | null = null;
  /** Error beyond which the clock re-seats instead of slewing, seconds. */
  static readonly SNAP_S = 0.25;
  /** Fraction of the clock error taken out per anchor. */
  static readonly SLEW = 0.2;
  /** EWMA weight of one apply sample. */
  static readonly GAIN = 0.25;
  /** One sample may move the estimate by at most this, seconds (a stall is not a route change). */
  static readonly SAMPLE_CLAMP_S = 0.06;

  get ready(): boolean { return Number.isFinite(this.t) && this.offsetS !== null; }

  /**
   * Input sent at client time `sentS` was applied by the server at `appliedS`
   * (the first ack carrying its seq; pass the midpoint of that ack's t and the
   * previous ack's t when both are known).
   */
  noteApplied(sentS: number, appliedS: number): void {
    const sample = appliedS - sentS;
    if (!Number.isFinite(sample)) return;
    if (this.offsetS === null) { this.offsetS = sample; return; }
    // Off by more than SNAP_S is not jitter, it is a different clock (the first
    // sample was taken in the countdown, when the sim clock stands still): re-seat.
    if (Math.abs(sample - this.offsetS) > PredictionClock.SNAP_S) { this.offsetS = sample; return; }
    const c = PredictionClock.SAMPLE_CLAMP_S;
    const d = Math.max(-c, Math.min(c, sample - this.offsetS));
    this.offsetS += d * PredictionClock.GAIN;
  }

  /** Steer the clock toward `nowS + offset` (call on every ack). Returns the clock. */
  anchor(nowS: number): number {
    if (this.offsetS === null || !Number.isFinite(nowS)) return this.t;
    const err = this.t - (nowS + this.offsetS);
    if (!Number.isFinite(err) || Math.abs(err) > PredictionClock.SNAP_S) this.t = nowS + this.offsetS;
    else this.t -= err * PredictionClock.SLEW;
    return this.t;
  }

  /** One client prediction step. */
  advance(dt: number): void {
    if (Number.isFinite(this.t)) this.t += dt;
  }
}
