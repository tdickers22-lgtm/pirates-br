/**
 * AudioCore: the bus graph every sound in the client lands on (b2.4b, audio-11, D31/section 3.8).
 *
 *   sfx voices ───→ sfx level ──────┐
 *   ambience beds → ambience level ─┼→ worldFilter (submerged / below-deck muffle) → master → glue → limiter → out
 *   music → duck ─→ music level ────┘
 *   ui chrome ────→ ui level ───────────────────────────────────────────────→ master
 *
 * The ui bus joins AFTER the world filter, so a menu click is never muffled underwater, never
 * occluded below deck and never ducked by a broadside (audio-11: it used to ride busDry ->
 * worldFilter). Each bus has its own level node for the Master/Music/Effects/Ambience/UI
 * sliders; the engine's duck automation lives on the bus INPUT nodes upstream, so a slider
 * write and a duck ramp never fight over one AudioParam.
 *
 * Pure of any engine state: it takes a context-shaped object, so test-audio-models builds it on
 * a fake context and walks the connections.
 */
import { safeSet } from './audioLifecycle.js';

export type AudioBusName = 'sfx' | 'ambience' | 'music' | 'ui';
export const AUDIO_BUSES: readonly AudioBusName[] = ['sfx', 'ambience', 'music', 'ui'];

/** The slice of BaseAudioContext the graph needs (a fake satisfies it in node). */
export interface AudioGraphContext {
  readonly destination: AudioNode;
  createGain(): GainNode;
  createBiquadFilter(): BiquadFilterNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
}

export interface AudioCoreNodes {
  /** Master volume + mute. */
  master: GainNode;
  /** Soft glue compressor (the pre-b2.4b "compressor"): evens a broadside out. */
  glue: DynamicsCompressorNode;
  /** Brick-wall-ish limiter, last node before the destination: nothing leaves above ~-1 dBFS. */
  limiter: DynamicsCompressorNode;
  /** Swept lowpass for submerged / below-deck. World buses only. */
  worldFilter: BiquadFilterNode;
  /** Per-bus level (slider) nodes. Feed a bus by connecting into its level node. */
  levels: Record<AudioBusName, GainNode>;
}

/** Sample-peak ceiling after the limiter (b2.4h). The DynamicsCompressor limiter overshoots on
 *  transients (audio-render-probe measured a broadside at +0.14 dBFS and splash.small at -0.5 through
 *  it), so a WaveShaper catches what it lets through: identity below CEILING_KNEE, a tanh shoulder
 *  above that can never reach CEILING_DB. The shaper sees the signal at half scale (inputs up to
 *  +6 dBFS land inside its [-1, 1] domain). It runs WITHOUT oversampling: the '2x' path's
 *  downsampling low-pass rings after a shaped transient and put splash.cannon out at -0.9 dBFS
 *  (b2 gate), so only the bare curve is a hard sample-peak bound. The shoulder engages only above
 *  -2.5 dBFS, after the limiter, so the aliasing it can add is a few samples per transient. */
export const CEILING_DB = -1.05;
export const CEILING_KNEE = 0.75;
export function ceilingCurve(n = 4096): Float32Array<ArrayBuffer> {
  const c = Math.pow(10, CEILING_DB / 20);
  const k = CEILING_KNEE;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = ((i / (n - 1)) * 2 - 1) * 2; // shaper input x in [-1, 1] carries y = 2x
    const a = Math.abs(y);
    const v = a <= k ? a : k + (c - k) * Math.tanh((a - k) / (c - k));
    out[i] = Math.sign(y) * v;
  }
  return out;
}

/** Limiter settings: threshold -1.5 dB, hard knee, 20:1, 2 ms attack. */
export const LIMITER = { threshold: -1.5, knee: 0, ratio: 20, attack: 0.002, release: 0.1 } as const;

export function buildAudioCore(ctx: AudioGraphContext, masterGain = 0.55): AudioCoreNodes {
  const limiter = ctx.createDynamicsCompressor();
  safeSet(limiter.threshold, 'value', LIMITER.threshold);
  safeSet(limiter.knee, 'value', LIMITER.knee);
  safeSet(limiter.ratio, 'value', LIMITER.ratio);
  safeSet(limiter.attack, 'value', LIMITER.attack);
  safeSet(limiter.release, 'value', LIMITER.release);
  const shaperCtor = (ctx as unknown as { createWaveShaper?: () => WaveShaperNode }).createWaveShaper;
  if (typeof shaperCtor === 'function') {
    const half = ctx.createGain();
    safeSet(half.gain, 'value', 0.5);
    const ceiling = shaperCtor.call(ctx);
    ceiling.curve = ceilingCurve();
    ceiling.oversample = 'none';
    limiter.connect(half);
    half.connect(ceiling);
    ceiling.connect(ctx.destination);
  } else {
    limiter.connect(ctx.destination);
  }

  const glue = ctx.createDynamicsCompressor();
  safeSet(glue.threshold, 'value', -14);
  safeSet(glue.knee, 'value', 16);
  safeSet(glue.ratio, 'value', 3.4);
  safeSet(glue.attack, 'value', 0.005);
  safeSet(glue.release, 'value', 0.18);
  glue.connect(limiter);

  const master = ctx.createGain();
  safeSet(master.gain, 'value', masterGain);
  master.connect(glue);

  const worldFilter = ctx.createBiquadFilter();
  worldFilter.type = 'lowpass';
  safeSet(worldFilter.frequency, 'value', 20000);
  safeSet(worldFilter.Q, 'value', 0.4);
  worldFilter.connect(master);

  const level = (to: AudioNode): GainNode => {
    const g = ctx.createGain();
    safeSet(g.gain, 'value', 1);
    g.connect(to);
    return g;
  };
  const levels: Record<AudioBusName, GainNode> = {
    sfx: level(worldFilter),
    ambience: level(worldFilter),
    music: level(worldFilter),
    // The ui bus skips the world: straight to master (still volume-controlled and limited).
    ui: level(master),
  };
  return { master, glue, limiter, worldFilter, levels };
}

/** Section 3.8 combat duck: within 40 m of a fight ambience drops 6 dB and music 12 dB; the ui bus
 *  is never ducked. Returns linear gains for the duck nodes. */
export const COMBAT_DUCK_RANGE_M = 40;
export function combatDuckGains(nearestCombatM: number): { ambience: number; music: number; ui: 1 } {
  const inRange = Number.isFinite(nearestCombatM) && nearestCombatM >= 0 && nearestCombatM <= COMBAT_DUCK_RANGE_M;
  return inRange
    ? { ambience: Math.pow(10, -6 / 20), music: Math.pow(10, -12 / 20), ui: 1 }
    : { ambience: 1, music: 1, ui: 1 };
}
