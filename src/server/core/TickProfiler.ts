// performance-13 / vm:physics:5: what one server tick costs, by phase.
//
// Sim-lag honesty was already gated (perf-server-load), but the COST that
// causes the lag was not: a feature could double ms/tick and pass every gate
// until matches stacked up on the VM. ms/tick is the capacity number
// (62.5 Hz x 2.0 ms = 12.5% of a core, the whole shared-cpu quota), so every
// playing tick is timed here, lap by lap, into a fixed ring buffer.
//
// Lap style: begin() at the top of the playing tick, lap(phase) after each
// block charges the time since the previous mark to that phase, end() charges
// the tail to 'snapshot' and records the total. No allocation per tick.

export const TICK_PHASES = [
  'inputs', 'bots', 'combat', 'physics', 'wildlife', 'storm', 'rest', 'snapshot',
] as const;
export type TickPhase = typeof TICK_PHASES[number];

export interface TickCost {
  /** Playing ticks in the window (<= capacity). */
  n: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Mean ms per tick charged to each phase over the window. */
  phasesMs: Record<TickPhase, number>;
}

const PHASE_INDEX: Record<TickPhase, number> = Object.fromEntries(
  TICK_PHASES.map((p, i) => [p, i]),
) as Record<TickPhase, number>;

/** Recompute the percentiles at most this often (ticks). The worker mirror
 *  reads stats() every tick; a 2k-element sort per tick would be its own cost. */
const STATS_REFRESH_TICKS = 64;

const now = (): number => performance.now();

export class TickProfiler {
  readonly capacity: number;
  private totals: Float64Array;
  private phases: Float64Array;
  private head = 0;
  private count = 0;
  private open = false;
  private t0 = 0;
  private mark = 0;
  private cur: Float64Array;
  private cached: TickCost | null = null;
  private sinceStats = 0;

  /** 2048 ticks = 33 s at 62.5 Hz. */
  constructor(capacity = 2048) {
    this.capacity = capacity;
    this.totals = new Float64Array(capacity);
    this.phases = new Float64Array(capacity * TICK_PHASES.length);
    this.cur = new Float64Array(TICK_PHASES.length);
  }

  begin(): void {
    this.t0 = now();
    this.mark = this.t0;
    this.cur.fill(0);
    this.open = true;
  }

  lap(phase: TickPhase): void {
    if (!this.open) return;
    const t = now();
    this.cur[PHASE_INDEX[phase]] += t - this.mark;
    this.mark = t;
  }

  end(): void {
    if (!this.open) return;
    this.lap('snapshot');
    this.open = false;
    const slot = this.head;
    this.totals[slot] = this.mark - this.t0;
    this.phases.set(this.cur, slot * TICK_PHASES.length);
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.sinceStats++;
  }

  /** Drop everything recorded so far (a harness excludes its warm-up). */
  reset(): void {
    this.head = 0;
    this.count = 0;
    this.open = false;
    this.cached = null;
    this.sinceStats = 0;
  }

  stats(): TickCost {
    if (this.cached && this.sinceStats < STATS_REFRESH_TICKS) return this.cached;
    this.sinceStats = 0;
    const n = this.count;
    const phasesMs = Object.fromEntries(TICK_PHASES.map((p) => [p, 0])) as Record<TickPhase, number>;
    if (n === 0) {
      this.cached = { n: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, phasesMs };
      return this.cached;
    }
    const xs = Array.from(this.totals.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number) => xs[Math.min(n - 1, Math.floor(p * n))];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < TICK_PHASES.length; k++) {
        phasesMs[TICK_PHASES[k]] += this.phases[i * TICK_PHASES.length + k] / n;
      }
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    for (const p of TICK_PHASES) phasesMs[p] = r3(phasesMs[p]);
    this.cached = { n, p50Ms: r3(q(0.5)), p99Ms: r3(q(0.99)), maxMs: r3(xs[n - 1]), phasesMs };
    return this.cached;
  }
}
