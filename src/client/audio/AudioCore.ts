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

/** Limiter settings: threshold -1.5 dB, hard knee, 20:1, 2 ms attack. */
export const LIMITER = { threshold: -1.5, knee: 0, ratio: 20, attack: 0.002, release: 0.1 } as const;

export function buildAudioCore(ctx: AudioGraphContext, masterGain = 0.55): AudioCoreNodes {
  const limiter = ctx.createDynamicsCompressor();
  safeSet(limiter.threshold, 'value', LIMITER.threshold);
  safeSet(limiter.knee, 'value', LIMITER.knee);
  safeSet(limiter.ratio, 'value', LIMITER.ratio);
  safeSet(limiter.attack, 'value', LIMITER.attack);
  safeSet(limiter.release, 'value', LIMITER.release);
  limiter.connect(ctx.destination);

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
