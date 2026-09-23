/**
 * AUDIO RESILIENCE + PLATFORM LIFECYCLE (b1.1c).
 *
 * Two jobs, both about the Web Audio platform rather than about any one sound:
 *
 * 1. `safeSet` — the ONE door every AudioParam write in the engine goes
 *    through (liveplay-05). A real AudioParam throws a TypeError on a NaN or
 *    infinite value or time and a RangeError on an exponential ramp to 0; one
 *    such throw inside a network handler used to drop the rest of that server
 *    message. A non-finite value becomes 0 (silence-biased: a skipped envelope
 *    start would leave a gain at its default 1, which is a blast, not a
 *    whisper), a non-finite time becomes 0 (= "now" on the audio clock), an
 *    exponential target of 0 becomes 1e-4, and anything still refused by the
 *    platform is caught and counted. It returns the param so ramps can chain.
 *
 * 2. `AudioLifecycle` — when the context may exist and run (audio-08,
 *    crossdevice-12, D14):
 *    - the context is created ONLY inside a user gesture, and the gestures that
 *      count are the ones WebKit accepts as activation: pointerup, touchend,
 *      click, keydown (NOT pointerdown / touchstart). Listeners stay armed until
 *      the context reports 'running', then remove themselves;
 *    - inside the gesture a 1-sample silent buffer is played (the classic iOS
 *      unlock) and the context resumed;
 *    - `navigator.audioSession.type = 'playback'` when the API exists (Safari
 *      16.4+), so the ring/silent switch does not mute the game; the "Mix with
 *      other audio" setting (b2.4h) switches it to 'ambient';
 *    - page hidden -> suspend ONCE; visible again -> resume, and re-arm the
 *      gesture unlock in case the platform refused the resume;
 *    - context state 'interrupted' (iOS call / Siri / app switch) or a
 *      'suspended' we did not ask for -> re-arm the gesture unlock.
 *
 * Everything the lifecycle touches is injected, so the node suite
 * (scripts/test-audio-lifecycle.mjs) drives it with fakes.
 */

// ── 1. safeSet ──────────────────────────────────────────────────────────────

export type ParamOp = 'value' | 'set' | 'linear' | 'exp' | 'target' | 'cancel';

/** Writes that needed sanitising (a non-finite value/time, an exp ramp to 0). */
let paramRejects = 0;
/** Writes the platform still refused after sanitising (caught here). */
let paramFaults = 0;
let lastParamFault = '';

export function audioParamStats(): { rejects: number; faults: number; lastFault: string } {
  return { rejects: paramRejects, faults: paramFaults, lastFault: lastParamFault };
}

/**
 * The single AudioParam write. `op`: 'value' = `.value =`, 'set' =
 * setValueAtTime, 'linear' / 'exp' = the two ramps, 'target' = setTargetAtTime
 * (`extra` = time constant), 'cancel' = cancelScheduledValues(`at`).
 */
export function safeSet<P extends AudioParam | null | undefined>(
  param: P,
  op: ParamOp,
  value: number,
  at = 0,
  extra = 0,
): P {
  if (!param) return param;
  let v = value;
  let t = at;
  if (op !== 'cancel' && !Number.isFinite(v)) { v = 0; paramRejects += 1; }
  if (op !== 'value' && !Number.isFinite(t)) { t = 0; paramRejects += 1; }
  if (t < 0) t = 0;
  if (op === 'exp' && v === 0) { v = 1e-4; paramRejects += 1; }
  let tc = extra;
  if (op === 'target' && !(Number.isFinite(tc) && tc >= 0)) { tc = 0.01; paramRejects += 1; }
  try {
    switch (op) {
      case 'value': param.value = v; break;
      case 'set': param.setValueAtTime(v, t); break;
      case 'linear': param.linearRampToValueAtTime(v, t); break;
      case 'exp': param.exponentialRampToValueAtTime(v, t); break;
      case 'target': param.setTargetAtTime(v, t, tc); break;
      case 'cancel': param.cancelScheduledValues(t); break;
    }
  } catch (err) {
    paramFaults += 1;
    if (paramFaults <= 3) {
      lastParamFault = String((err as Error)?.message ?? err).slice(0, 200);
      console.warn(`[Audio] AudioParam ${op} refused (${paramFaults}):`, lastParamFault);
    }
  }
  return param;
}

/** A finite, non-negative distance. NaN = unknown -> a moderate far distance
 *  (never blasted at the ear); +Infinity -> very far (inaudible). */
export const UNKNOWN_DISTANCE_M = 60;
export function finiteDistance(d: number | null | undefined): number {
  if (d === Infinity) return 1e4;
  if (typeof d !== 'number' || !Number.isFinite(d)) return UNKNOWN_DISTANCE_M;
  return d < 0 ? 0 : d;
}

/** A position with all three components finite, else null (= unpanned). */
export function finitePos<T extends { x: number; y: number; z: number }>(p: T | null | undefined): T | null {
  if (!p || typeof p !== 'object') return null;
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
}

/** A finite number, else `fallback`. */
export function finiteOr(n: number | null | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

// ── 2. Lifecycle ────────────────────────────────────────────────────────────

/** The gestures WebKit grants audio activation on. pointerdown does NOT count. */
export const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

export interface LifecycleContext {
  readonly state: string;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  addEventListener(type: 'statechange', fn: () => void): void;
  createBuffer(channels: number, length: number, rate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioNode;
  readonly sampleRate: number;
}

interface ListenerTarget {
  addEventListener(type: string, fn: (e?: unknown) => void, opts?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e?: unknown) => void, opts?: boolean | EventListenerOptions): void;
}

export interface LifecycleEnv {
  /** Where gestures are heard (window, capture phase: runs before any UI handler). */
  target: ListenerTarget;
  /** Page visibility source (document). */
  doc?: (ListenerTarget & { visibilityState?: string }) | null;
  /** navigator (for navigator.audioSession). */
  nav?: { audioSession?: { type: string } } | null;
}

export interface LifecycleHooks {
  /** Create the context if needed (called ONLY inside a gesture) and return it. */
  createInGesture(): LifecycleContext | null;
  /** The context if it exists; never creates one. */
  current(): LifecycleContext | null;
  /** Called after the context first reports 'running' following a gesture. */
  onRunning?(): void;
}

export class AudioLifecycle {
  /** Gesture listeners currently armed. */
  armed = false;
  /** Count of suspend() calls we issued (the gate reads it). */
  suspends = 0;
  /** Count of gesture unlock attempts. */
  gestures = 0;
  private suspendedByUs = false;
  private watchedCtx: LifecycleContext | null = null;
  private mixWithOthers = false;
  private installed = false;

  constructor(private readonly env: LifecycleEnv, private readonly hooks: LifecycleHooks) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.applySession();
    this.arm();
    this.env.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.env.doc?.addEventListener('pagehide', this.onHidden);
  }

  /** "Mix with other audio" (D14): 'ambient' respects the silent switch and mixes; default 'playback'. */
  setMixWithOthers(mix: boolean): void {
    this.mixWithOthers = mix;
    this.applySession();
  }

  sessionType(): string | null {
    return this.env.nav?.audioSession?.type ?? null;
  }

  private applySession(): void {
    const session = this.env.nav?.audioSession;
    if (!session) return;
    try { session.type = this.mixWithOthers ? 'ambient' : 'playback'; } catch { /* read-only on old WebKit */ }
  }

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    for (const type of UNLOCK_EVENTS) this.env.target.addEventListener(type, this.onGesture, true);
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    for (const type of UNLOCK_EVENTS) this.env.target.removeEventListener(type, this.onGesture, true);
  }

  private isHidden(): boolean {
    return this.env.doc?.visibilityState === 'hidden';
  }

  /** Inside a real gesture: create, prime with a silent sample, resume. */
  readonly onGesture = (): void => {
    this.gestures += 1;
    let ctx: LifecycleContext | null = null;
    try { ctx = this.hooks.createInGesture(); } catch (err) { console.warn('[Audio] unlock failed:', err); }
    if (!ctx) return;
    this.watch(ctx);
    this.primeSilent(ctx);
    if (ctx.state !== 'running' && !this.isHidden()) {
      this.suspendedByUs = false;
      ctx.resume().then(() => this.settle(ctx), () => { /* stay armed: the next gesture retries */ });
    }
    this.settle(ctx);
  };

  private settle(ctx: LifecycleContext): void {
    if (ctx.state === 'running') {
      this.disarm();
      this.hooks.onRunning?.();
    }
  }

  private primeSilent(ctx: LifecycleContext): void {
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* priming is best-effort */ }
  }

  private watch(ctx: LifecycleContext): void {
    if (this.watchedCtx === ctx) return;
    this.watchedCtx = ctx;
    ctx.addEventListener('statechange', () => {
      const s = ctx.state;
      if (s === 'running') { this.disarm(); return; }
      // iOS 'interrupted' (call, Siri, app switch) or a suspend we did not
      // issue: only a fresh gesture can bring it back there.
      if (s === 'interrupted' || (s === 'suspended' && !this.suspendedByUs)) this.arm();
    });
  }

  private readonly onHidden = (): void => {
    const ctx = this.hooks.current();
    if (!ctx || this.suspendedByUs || ctx.state === 'closed') return;
    this.suspendedByUs = true;
    this.suspends += 1;
    ctx.suspend().catch(() => { /* ignore */ });
  };

  private readonly onVisibility = (): void => {
    if (this.isHidden()) { this.onHidden(); return; }
    const ctx = this.hooks.current();
    if (!ctx) return;
    if (this.suspendedByUs) {
      this.suspendedByUs = false;
      ctx.resume().then(() => this.settle(ctx), () => { /* re-armed below */ });
    }
    // If the platform refuses a resume outside a gesture (iOS), the next tap does it.
    if (ctx.state !== 'running') this.arm();
  };
}
