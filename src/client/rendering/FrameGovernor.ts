/**
 * THE ADAPTIVE FRAME GOVERNOR — measure the frame, then spend the budget the
 * machine actually has.
 *
 * WHAT WAS HERE BEFORE. A tier chosen once at startup from the GPU's name, a
 * resolution scaler chasing 47fps in 0.08 steps off a one-second average, and a
 * two-rung "distress ladder" that fired after 6.9 seconds under 28fps. Three
 * controllers, three different notions of "too slow", none of them looking at
 * the same number, and none of them able to say what it was currently running.
 * The tier is a guess about hardware; this is a measurement of the frame.
 *
 * WHY A MEDIAN AND A p95, NOT AN AVERAGE. An average frame time cannot tell a
 * machine that is uniformly 10% slow from one that is fine except for four
 * shader links a second, and those want opposite responses: the first wants
 * less work every frame, the second wants the link storm fixed and no quality
 * change at all. The median says what the steady frame costs. The p95 says
 * whether the steady frame is the whole story. Both are read against the same
 * budget, and the p95 gets a looser threshold (§ TUNING) because a frame that
 * is 45% over budget once in twenty is a hitch, and a hitch is what the player
 * feels — but it is not evidence that the resolution is wrong.
 *
 * ═══ WHY THE LEVER ORDER IS NOT "RESOLUTION FIRST" AT EVERY TIER ═══
 *
 * The obvious ladder is "turn the resolution down, it's a fill-rate-bound GPU".
 * The cost model (docs/FRAME_COST_MODEL.md §8.1, §9.2) measured that and it is
 * only true at `low`:
 *
 *   • Everything that is a fragment scales with ratio²; NOTHING else moves.
 *     Draws, triangles, and the shadow map are all invariant — 1503/1504/1505/
 *     1514 draws measured across a 0.75→1.5 sweep at dock-vista.
 *   • At `high` the shadow map is 4096², i.e. 16.78 M texels against a 0.52 M
 *     framebuffer — THIRTY-TWO screens. The resolution ladder cannot touch one
 *     texel of it. Ratio 1→0.75 at `high` reaches about **12%** of the frame's
 *     total fill+texel work.
 *   • And resolution is, by a distance, the most VISIBLE thing on the list.
 *
 * So the ladder is ordered by measured saving per unit of visible loss, which
 * puts the invisible knobs first and differs by tier:
 *
 *   `high` / `balanced`   shadow map size → far dressing (LOD radius, instance
 *                         density) → particles → shadow distance → RESOLUTION
 *   `low`                 RESOLUTION, from the first step — there is no shadow
 *                         map and no post chain at this tier, so ratio² is the
 *                         only fill knob there is, and it reaches all of it.
 *
 * TWO RUNGS THAT ARE DELIBERATELY ABSENT. Switching shadows off, and switching
 * the post chain off, both change every material's PROGRAM KEY — three would
 * re-link the whole scene at exactly the moment the machine has proven it has
 * nothing to spare, which is the single largest hitch class in the census (§7).
 * A smaller shadow map is a reallocation and links nothing; a smaller pixel
 * ratio resizes the post chain's targets and links nothing. Those are the two
 * this controller is allowed to pull. Anything that re-links belongs to the tier
 * decision, which happens between sessions.
 *
 * WHAT IT WILL NOT DO TO THE PICTURE (see `resolveLevers`): resolution has a
 * hard per-tier floor, the far-dressing scales bottom out well before anything
 * at eye level is reachable, and nothing here touches the HUD, nameplates,
 * prompts, or the visibility of anything the player can interact with — those
 * are not levers, and Game clamps the interaction radii separately.
 *
 * GL-FREE ON PURPOSE. No THREE, no DOM, no `performance` — every input arrives
 * as a number. That is what lets scripts/test-frame-governor.mjs drive step
 * response, oscillation, clamps, hysteresis and recovery deterministically on
 * a machine whose only GL backend draws one frame a second.
 */

import type { RenderQuality } from './QualityPreference.js';

/** What the controller is currently trying to hold. */
export type GovernorMode =
  /** Chasing `targetFps`. */
  | 'target'
  /** Bottomed out and still missing it: holding what it has at `floorFps`
   *  rather than degrading forever. */
  | 'floor'
  /** Disabled (a probe pinning a fixed quality, or an explicit opt-out). */
  | 'off';

export interface GovernorTuning {
  /** The frame rate the controller spends quality to reach. */
  targetFps: number;
  /** What it settles for once every lever is spent. A stable 30 is a better
   *  product than a picture that keeps getting worse and never arrives. */
  floorFps: number;
  /** Rolling window, in frames. */
  windowFrames: number;
  /** Frames discarded after a reset — a match start links programs, uploads
   *  geometry and reveals an island, and none of that is the steady frame. */
  warmupFrames: number;
  /** Samples needed before any step. */
  minSamples: number;
  /** …unless this long has passed with at least `slowSamples`. A machine at
   *  3fps needs help before it has produced twelve frames. */
  slowEvidenceMs: number;
  slowSamples: number;
  /** Minimum wall time between steps in each direction. Down is quick because
   *  the player is currently suffering; up is slow because being wrong upward
   *  costs another down step, and a pair of those is a visible pump. */
  minDownIntervalMs: number;
  minUpIntervalMs: number;
  /** After ANY step the window is cleared and no new step may be taken until
   *  this elapses — a frame rendered before a change is not evidence about
   *  the setting after it. */
  settleMs: number;
  /** After a DOWN step, no UP step for this long, whatever the frames say.
   *  This is the anti-pump rule: it makes a down→up→down cycle cost at least
   *  reboundLockoutMs + minDownIntervalMs, so it cannot be a visible flicker. */
  reboundLockoutMs: number;
  /** Headroom must persist this long before quality is handed back. */
  upDwellMs: number;
  /** Down when the median exceeds budget × this. */
  downMedianRatio: number;
  /** …or the p95 exceeds budget × this. Looser: an occasional long frame is a
   *  hitch to be fixed at the source, not evidence the resolution is wrong. */
  downP95Ratio: number;
  /** Up only when the median is under budget × this. The gap to
   *  `downMedianRatio` IS the dead band — nothing inside it moves anything. */
  upMedianRatio: number;
  /** …and the p95 is also comfortable. */
  upP95Ratio: number;
  /** Step size, as a fraction of the 0..1 scalar. */
  maxDownStep: number;
  minDownStep: number;
  maxUpStep: number;
  /** Down step = (overshoot ratio − 1) × this, clamped to the step bounds. */
  downGain: number;
  /** At scalar 0, still over budget, for this long → floor mode. */
  floorGiveUpMs: number;
  /** In floor mode, this much sustained headroom against the TARGET budget
   *  (not the floor budget) hands the machine back to target mode. */
  floorExitMedianRatio: number;
  floorExitDwellMs: number;
}

/**
 * The numbers, and why each one is where it is.
 *
 * The dead band is the load-bearing one. Down fires at median > 1.00 × budget,
 * up at median < 0.80 × budget: a machine sitting anywhere between 13.3 ms and
 * 16.7 ms changes nothing, forever. That is a 25% band in frame time, which is
 * wider than the frame-time change any single step of this ladder produces —
 * which is what makes a limit cycle impossible rather than merely unlikely.
 */
export const GOVERNOR_TUNING: GovernorTuning = {
  targetFps: 60,
  floorFps: 30,
  windowFrames: 45,
  warmupFrames: 30,
  minSamples: 12,
  slowEvidenceMs: 2000,
  slowSamples: 4,
  minDownIntervalMs: 250,
  minUpIntervalMs: 1000,
  settleMs: 450,
  reboundLockoutMs: 3500,
  upDwellMs: 1600,
  downMedianRatio: 1.0,
  downP95Ratio: 1.45,
  upMedianRatio: 0.8,
  upP95Ratio: 1.05,
  maxDownStep: 0.12,
  minDownStep: 0.02,
  maxUpStep: 0.035,
  downGain: 0.35,
  floorGiveUpMs: 9000,
  floorExitMedianRatio: 0.72,
  floorExitDwellMs: 6000,
};

export interface GovernorStats {
  samples: number;
  medianMs: number;
  p95Ms: number;
}

export class FrameGovernor {
  private readonly tuning: GovernorTuning;
  private readonly ring: Float64Array;
  private readonly scratch: Float64Array;
  private count = 0;
  private cursor = 0;
  private warmupLeft: number;
  private windowOpenedAt = 0;

  private scalar = 1;
  private mode: GovernorMode = 'target';
  private enabled = true;
  private suspended = false;
  private dropNext = false;

  private lastDownAt = -1e9;
  private lastUpAt = -1e9;
  private holdUntil = 0;
  private headroomSince = -1;
  private starvedSince = -1;
  private floorHeadroomSince = -1;
  /** The scalar floor mode froze at. In floor mode the ladder must HOLD, not
   *  ratchet quality back up against the easier 30fps budget and start
   *  stuttering again — that pump is the exact failure this mode exists to
   *  end. */
  private floorCeiling = 1;
  private now = 0;

  /**
   * `startScalar` is where the session OPENS, and it is deliberately not 1.
   *
   * Opening at the ceiling means asking an unknown machine for everything the
   * tier allows and then walking it back down while it stutters — which is what
   * the old scaler did, and it is the wrong way round: the cost of opening one
   * rung low is a picture that gets better after four seconds, and the cost of
   * opening at the ceiling is a first impression of a game that hitches. The
   * levers this spends are the invisible ones by construction (see
   * `resolveLevers`); nothing below 0.8 of the ladder is touched.
   */
  constructor(tuning: Partial<GovernorTuning> = {}, startScalar = 1) {
    this.tuning = { ...GOVERNOR_TUNING, ...tuning };
    this.ring = new Float64Array(this.tuning.windowFrames);
    this.scratch = new Float64Array(this.tuning.windowFrames);
    this.warmupLeft = this.tuning.warmupFrames;
    this.startScalar = clamp(startScalar, 0, 1);
    this.scalar = this.startScalar;
  }

  private readonly startScalar: number;

  /** The 0..1 quality scalar. 1 = everything the tier allows, 0 = every runtime
   *  lever spent. Never leaves [0,1]. */
  getScalar(): number {
    return this.scalar;
  }

  getMode(): GovernorMode {
    return this.enabled ? this.mode : 'off';
  }

  /** The frame rate currently being chased — 60, or 30 once it has given up on
   *  60. Surfaced so the settings panel can say so out loud. */
  getTargetFps(): number {
    return this.mode === 'floor' ? this.tuning.floorFps : this.tuning.targetFps;
  }

  getStats(): GovernorStats {
    if (this.count === 0) return { samples: 0, medianMs: 0, p95Ms: 0 };
    return { samples: this.count, medianMs: this.percentile(0.5), p95Ms: this.percentile(0.95) };
  }

  /** Probes and measurement rigs pin quality on purpose; a controller that
   *  moved the resolution under a census would make every count it took a
   *  reading of a different frame. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.scalar = this.startScalar;
      this.mode = 'target';
    }
    this.clearWindow();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Stop sampling entirely — the load, the start ceremony, a paused tab.
   *
   * Distinct from `setEnabled(false)`: the controller keeps whatever it had
   * decided, it simply refuses to learn from frames that are not play. Frames
   * during a world build are a measurement of the build, and a governor that
   * reacted to them would spend its whole ladder before the horn.
   */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return;
    this.suspended = suspended;
    if (!suspended) {
      // Coming back from a suspension is a fresh start, warmup and all: the
      // first frames after a load guard drops are still paying for it.
      this.clearWindow();
      this.warmupLeft = this.tuning.warmupFrames;
    }
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /** Discard the NEXT frame — a known one-off the caller can name (a match
   *  start, a respawn, a chart opening). Cheaper and more honest than trying to
   *  guess which long frames were "real". */
  markOneOff(): void {
    this.dropNext = true;
  }

  /** Feed one rendered frame. `ms`, not seconds — the game loop's dt is in
   *  seconds and the conversion is the caller's, so a unit slip is one place. */
  pushFrame(ms: number, oneOff = false): void {
    const drop = this.dropNext;
    this.dropNext = false;
    if (!this.enabled || this.suspended) return;
    if (oneOff || drop) return;
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (this.warmupLeft > 0) { this.warmupLeft -= 1; return; }
    this.ring[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.ring.length;
    if (this.count < this.ring.length) this.count += 1;
  }

  /**
   * Decide. Call once per frame AFTER pushing that frame; returns the scalar,
   * which is unchanged on the overwhelming majority of calls.
   */
  update(nowMs: number): number {
    this.now = nowMs;
    if (!this.enabled || this.suspended) return this.scalar;
    if (this.windowOpenedAt === 0) this.windowOpenedAt = nowMs;
    if (nowMs < this.holdUntil) return this.scalar;
    if (!this.hasEvidence(nowMs)) return this.scalar;

    const targetBudget = 1000 / this.tuning.targetFps;
    const budget = 1000 / this.getTargetFps();
    const median = this.percentile(0.5);
    const p95 = this.percentile(0.95);
    const t = this.tuning;

    const over = median > budget * t.downMedianRatio || p95 > budget * t.downP95Ratio;
    const under = this.count >= t.minSamples
      && median < budget * t.upMedianRatio
      && p95 < budget * t.upP95Ratio;

    if (over) {
      this.headroomSince = -1;
      this.floorHeadroomSince = -1;
      if (this.scalar <= 0) {
        // Nothing left to give. Count how long that has been true; past
        // floorGiveUpMs the honest thing is to stop chasing 60 and hold.
        if (this.starvedSince < 0) this.starvedSince = nowMs;
        else if (this.mode === 'target' && nowMs - this.starvedSince >= t.floorGiveUpMs) {
          this.mode = 'floor';
          this.floorCeiling = this.scalar;
          this.clearWindow();
        }
        return this.scalar;
      }
      this.starvedSince = -1;
      if (nowMs - this.lastDownAt < t.minDownIntervalMs) return this.scalar;
      const overshoot = Math.max(median / budget, p95 / (budget * t.downP95Ratio));
      const step = clamp((overshoot - 1) * t.downGain, t.minDownStep, t.maxDownStep);
      this.applyStep(-step, nowMs);
      this.lastDownAt = nowMs;
      return this.scalar;
    }

    this.starvedSince = -1;

    if (this.mode === 'floor') {
      // Back to chasing 60 only if the machine is genuinely holding the TARGET
      // budget at the frozen ceiling — a slower phone-thermal recovery, a
      // window that got smaller, a scene that emptied out.
      if (median < targetBudget * t.floorExitMedianRatio && p95 < targetBudget) {
        if (this.floorHeadroomSince < 0) this.floorHeadroomSince = nowMs;
        else if (nowMs - this.floorHeadroomSince >= t.floorExitDwellMs) {
          this.mode = 'target';
          this.floorHeadroomSince = -1;
          this.clearWindow();
        }
      } else {
        this.floorHeadroomSince = -1;
      }
    }

    if (!under) { this.headroomSince = -1; return this.scalar; }

    const ceiling = this.mode === 'floor' ? this.floorCeiling : 1;
    if (this.scalar >= ceiling - 1e-6) { this.headroomSince = nowMs; return this.scalar; }
    if (nowMs - this.lastDownAt < t.reboundLockoutMs) { this.headroomSince = -1; return this.scalar; }
    if (this.headroomSince < 0) { this.headroomSince = nowMs; return this.scalar; }
    if (nowMs - this.headroomSince < t.upDwellMs) return this.scalar;
    if (nowMs - this.lastUpAt < t.minUpIntervalMs) return this.scalar;

    this.applyStep(Math.min(t.maxUpStep, ceiling - this.scalar), nowMs);
    this.lastUpAt = nowMs;
    return this.scalar;
  }

  /**
   * How much amortized streaming work this frame can afford, 0.25 … 1.4.
   *
   * The one shared signal (see FrameBudget.ts) that the first-draw allowance,
   * the island build queue, the detail warmer and the program warmer all read,
   * instead of each guessing. It is deliberately NOT the quality scalar: those
   * systems are spending main-thread milliseconds that the frame either has or
   * does not have RIGHT NOW, which is a different question from how much
   * picture the machine can sustain.
   */
  getStreamingScale(): number {
    if (!this.enabled || this.suspended || this.count < this.tuning.slowSamples) return 1;
    const budget = 1000 / this.getTargetFps();
    const ratio = this.percentile(0.5) / budget;
    if (ratio <= 0.6) return 1.4;
    if (ratio <= 0.85) return 1 + (0.85 - ratio) * (0.4 / 0.25);
    if (ratio >= 1.6) return 0.25;
    return 1 - (ratio - 0.85) * (0.75 / 0.75);
  }

  /** Match teardown / tier change. Keeps nothing. */
  reset(): void {
    this.scalar = this.startScalar;
    this.mode = 'target';
    this.floorCeiling = 1;
    this.lastDownAt = -1e9;
    this.lastUpAt = -1e9;
    this.starvedSince = -1;
    this.headroomSince = -1;
    this.floorHeadroomSince = -1;
    this.warmupLeft = this.tuning.warmupFrames;
    this.clearWindow();
  }

  private applyStep(delta: number, nowMs: number): void {
    const next = clamp(this.scalar + delta, 0, 1);
    if (next === this.scalar) return;
    this.scalar = next;
    this.holdUntil = nowMs + this.tuning.settleMs;
    this.headroomSince = -1;
    this.clearWindow();
  }

  private clearWindow(): void {
    this.count = 0;
    this.cursor = 0;
    this.windowOpenedAt = this.now;
  }

  private hasEvidence(nowMs: number): boolean {
    if (this.count >= this.tuning.minSamples) return true;
    return this.count >= this.tuning.slowSamples
      && nowMs - this.windowOpenedAt >= this.tuning.slowEvidenceMs;
  }

  /** Nearest-rank percentile over the live window. Insertion sort into a
   *  preallocated scratch: the window is 45 long and this runs once a frame, so
   *  the alternative (slice + sort) would be 45 numbers of garbage per frame
   *  for nothing (§6.3 — allocation is a measured cost here). */
  private percentile(p: number): number {
    const n = this.count;
    if (n === 0) return 0;
    const s = this.scratch;
    for (let i = 0; i < n; i++) {
      const v = this.ring[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j -= 1; }
      s[j + 1] = v;
    }
    const rank = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return s[rank];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LEVERS
// ─────────────────────────────────────────────────────────────────────────────

export interface LeverCaps {
  tier: RenderQuality;
  /** The tier's pixel-ratio ceiling, already clamped to devicePixelRatio. */
  maxPixelRatio: number;
  /** …and its floor. Below this the image stops being the game. */
  minPixelRatio: number;
  /** The shadow map this tier was built with, or 0 where there are no shadows. */
  baseShadowMapSize: number;
}

export interface GovernorLevers {
  /** renderer.setPixelRatio. Continuous — see `resolveLevers` on why. */
  pixelRatio: number;
  /** Square shadow map edge, 0 when the tier has no shadows. Never 0 because
   *  of the governor: switching shadows off re-links every material. */
  shadowMapSize: number;
  /** Multiplier on SHADOW_HALF_EXTENT. Shrinking the ortho box drops distant
   *  casters out of the depth pass; it changes no program. */
  shadowExtentScale: number;
  /** Multiplier on every island/prop LOD radius. Floored well above anything
   *  at eye level, and Game floors the interaction radii again on top. */
  lodRadiusScale: number;
  /** Multiplier on the apparent-distance scale InstanceLod measures against.
   *  Below 1 it makes far batches behave as if further away, thinning the
   *  smallest instances first — which is the only per-frame lever that removes
   *  triangles without removing an object. */
  instanceDensityScale: number;
  /** Multiplier on the per-frame particle/spray spawn budget. */
  particleScale: number;
}

/** 1 at `hi` and above, 0 at `lo` and below, linear between. `hi > lo`. */
function ramp(q: number, hi: number, lo: number): number {
  if (q >= hi) return 1;
  if (q <= lo) return 0;
  return (q - lo) / (hi - lo);
}

function mix(full: number, spent: number, keep: number): number {
  return spent + (full - spent) * keep;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The scalar → what the renderer actually does, in the order argued at the top
 * of this file.
 *
 * RESOLUTION IS CONTINUOUS AND EVERYTHING ELSE IS NOT. A pixel ratio can move
 * in 1% steps and cost one target reallocation; an LOD radius moving in 1%
 * steps would re-decide visibility for objects sitting on the boundary every
 * frame. So resolution carries the fine adjustment and the discrete levers are
 * given wide, non-overlapping-enough windows that each one crosses at most a
 * couple of times over the whole ladder.
 *
 * The windows differ by tier because the levers do: `low` has no shadow map and
 * no post chain, so its ladder is resolution plus dressing from the first step,
 * while `high` spends 22% of its ladder on a shadow map nobody can see the size
 * of before it touches a pixel.
 */
export function resolveLevers(scalar: number, caps: LeverCaps): GovernorLevers {
  const q = clamp(scalar, 0, 1);
  const hasShadows = caps.baseShadowMapSize > 0;

  // ── Resolution ───────────────────────────────────────────────────────────
  // At `low` it is the only fill knob in the game and it reaches all of the
  // fill, so it ramps across the whole ladder. At the tiers that own a shadow
  // map it reaches ~12% of the frame's fill+texel work (§8.1) and is the most
  // visible loss available, so it waits until the free knobs are spent.
  const resolutionKeep = hasShadows ? ramp(q, 0.78, 0) : ramp(q, 1, 0);
  const pixelRatio = mix(caps.maxPixelRatio, caps.minPixelRatio, resolutionKeep);

  // ── Shadow map ───────────────────────────────────────────────────────────
  // Discrete, because a shadow map is an allocation. 16.78 M texels → 4.19 M →
  // 2.36 M → 1.05 M. The last of those is 1024² over a 310 m box: 30 cm per
  // texel under PCF-soft, which is soft, not broken.
  let shadowMapSize = caps.baseShadowMapSize;
  if (hasShadows) {
    const stepped = q >= 0.8 ? caps.baseShadowMapSize
      : q >= 0.58 ? 2048
        : q >= 0.36 ? 1536
          : 1024;
    shadowMapSize = Math.min(caps.baseShadowMapSize, stepped);
  }

  // ── Far dressing ─────────────────────────────────────────────────────────
  // Both of these live at mid and far distance by construction: the radii they
  // scale are 340–1200 m, and InstanceLod's thinning removes the SMALLEST
  // instances first (sorted by scale at build time), so what leaves is scrub at
  // a kilometre, never the hero palm in front of you.
  const lodRadiusScale = mix(1, 0.7, ramp(q, 0.88, 0.3));
  const instanceDensityScale = mix(1, 0.6, ramp(q, 0.82, 0.25));

  // ── Particles ────────────────────────────────────────────────────────────
  // Halved at the bottom, never off: rain you cannot see falling is a weather
  // bug, not a saving. Cost here is FILL, and getEffectScale already carries a
  // per-tier factor that this multiplies (§9, lever 10).
  const particleScale = mix(1, 0.5, ramp(q, 0.62, 0.12));

  // ── Shadow distance ──────────────────────────────────────────────────────
  // Last of the free-ish levers and deliberately late: it is the one whose loss
  // is legible (shadows stop at a nearer ring), and at 0.6 the box is still
  // 186 m across, which swallows any island you are standing on.
  const shadowExtentScale = hasShadows ? mix(1, 0.6, ramp(q, 0.5, 0.08)) : 1;

  return {
    pixelRatio,
    shadowMapSize,
    shadowExtentScale,
    lodRadiusScale,
    instanceDensityScale,
    particleScale,
  };
}

/** What the settings panel says out loud. */
export function describeGovernor(
  tier: RenderQuality,
  pinned: boolean,
  mode: GovernorMode,
  levers: GovernorLevers,
): string {
  const ratio = `${levers.pixelRatio.toFixed(2)}× resolution`;
  const head = pinned ? `${tier} (pinned)` : `Auto — ${tier}`;
  if (mode === 'off') return `${head}, ${ratio}`;
  if (mode === 'floor') return `${head}, ${ratio} — holding 30fps`;
  return `${head}, ${ratio}`;
}
