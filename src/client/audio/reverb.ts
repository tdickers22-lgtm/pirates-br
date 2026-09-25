/**
 * Listener spaces (b2.4g; audio-05, audio-12). Two pure pieces the engine and the gate share:
 *
 *   generateImpulse  a synthetic room impulse with what a real one has and white noise lacks:
 *                    a pre-delay, 6-10 early reflections, and a tail whose highs die 2-3x
 *                    faster than its lows (air + wood/stone absorb treble first). The old IR was
 *                    rand * (1-t)^k, flat across frequency, so every tail hissed.
 *   occlusionFor     what standing below deck does to the mix: the outside world (ambience beds and
 *                    distant one-shots) lowpassed to 900 Hz and 8 dB down over 250 ms, your own
 *                    hull's creak +6 dB and its flooding +4 dB. On the weather deck your own flooded
 *                    hold is heard through the planks: 1.2 kHz, -6 dB.
 *
 * Deterministic (seeded), no Web Audio types, so node gates grade the real law.
 */

export type ReverbSpaceName = 'outdoor' | 'cave' | 'hold';

export interface ImpulseSpec {
  /** Buffer length, s. */
  duration: number;
  /** Low-band decay time to -60 dB, s. */
  rt60: number;
  /** The band above the crossover decays this many times faster. */
  hfRatio: number;
  /** Early reflection taps. */
  earlyTaps: number;
  /** Last early tap, s. */
  earlyWindow: number;
  /** Direct-to-first-reflection gap, s. */
  predelay: number;
  /** Tail lowpass at t=0 and at the end (exponential glide between them). */
  brightHz: number;
  darkHz: number;
}

export const REVERB_SPACES: Readonly<Record<ReverbSpaceName, ImpulseSpec>> = {
  // Open air: sparse ground/hull reflections, a short diffuse tail.
  outdoor: { duration: 1.2, rt60: 0.9, hfRatio: 2.2, earlyTaps: 6, earlyWindow: 0.09, predelay: 0.012, brightHz: 7000, darkHz: 900 },
  // Rock chamber: dense early field, long dark tail.
  cave: { duration: 2.8, rt60: 2.5, hfRatio: 2.6, earlyTaps: 10, earlyWindow: 0.07, predelay: 0.008, brightHz: 6000, darkHz: 600 },
  // Ship's hold: a small wooden box, 0.5 s, boomy, treble soaked up by wet timber.
  hold: { duration: 0.5, rt60: 0.42, hfRatio: 2.5, earlyTaps: 8, earlyWindow: 0.024, predelay: 0.002, brightHz: 4500, darkHz: 700 },
};

/** mulberry32: small, fast, seeded. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LN1000 = Math.log(1000); // -60 dB
const CROSSOVER_HZ = 1500;

/** One-pole lowpass coefficient for a cutoff at this sample rate. */
const onePole = (hz: number, sr: number): number => 1 - Math.exp((-2 * Math.PI * Math.max(20, hz)) / sr);

/**
 * Stereo impulse for a space. Channels use different seeds (decorrelated tails, wide image) and
 * mirrored early taps. Peak-normalised to 1 (ConvolverNode.normalize rescales anyway).
 */
export function generateImpulse(sampleRate: number, spec: ImpulseSpec, seed = 1): [Float32Array, Float32Array] {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const n = Math.max(16, Math.floor(sr * Math.max(0.05, spec.duration)));
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const xo = onePole(CROSSOVER_HZ, sr);
  const kLo = LN1000 / Math.max(0.05, spec.rt60);
  const kHi = kLo * Math.max(1, spec.hfRatio);
  const pre = Math.floor(spec.predelay * sr);
  const glide = Math.log(spec.darkHz / spec.brightHz);
  for (let ch = 0; ch < 2; ch++) {
    const rand = rng(seed * 7919 + ch * 104729 + 17);
    const d = out[ch];
    // Early reflections: distinct taps, amplitude falling with arrival, alternating polarity.
    const er = rng(seed * 31 + 5);
    for (let i = 0; i < spec.earlyTaps; i++) {
      const frac = (i + 0.35 + er() * 0.5) / spec.earlyTaps;
      const at = pre + Math.floor(frac * spec.earlyWindow * sr) + (ch ? Math.floor(er() * 0.0015 * sr) : 0);
      // Each reflection is a short smeared burst (~1.5 ms, a surface is never a perfect mirror); first-order reflections sit well above the young tail.
      const amp = (i % 2 ? -1 : 1) * (1.9 - 1.1 * frac) * (0.8 + er() * 0.2);
      const len = Math.max(8, Math.floor(0.0015 * sr));
      for (let k = 0; k < len && at + k < n; k++) d[at + k] += amp * Math.exp((-4 * k) / len) * (k % 2 ? 0.6 : 1);
    }
    // Diffuse tail: noise split at the crossover; each band decays at its own rate.
    let lo = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const w = rand() * 2 - 1;
      lo += xo * (w - lo);
      const hi = w - lo;
      const onset = Math.min(1, t / Math.max(0.004, spec.earlyWindow)) ** 2; // tail builds under the taps
      d[i] += onset * 0.6 * (lo * 2.2 * Math.exp(-kLo * t) + hi * Math.exp(-kHi * t));
    }
    // Time-varying lowpass over the whole thing: bright at the start, dark at the end.
    let y = 0;
    for (let i = 0; i < n; i++) {
      const hz = spec.brightHz * Math.exp(glide * (i / n));
      y += onePole(hz, sr) * (d[i] - y);
      d[i] = y;
    }
    // 5% cosine fade so the truncation never clicks.
    const fade = Math.max(1, Math.floor(n * 0.05));
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
  }
  let peak = 0;
  for (const d of out) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (const d of out) for (let i = 0; i < d.length; i++) d[i] /= peak;
  return out;
}

export interface ListenerSpace {
  /** Standing in a ship's hold (shared isStandingInShipHold). */
  inHold?: boolean;
  /** Standing on a hull (deck or hold). */
  aboard?: boolean;
  /** 0..1 blend toward the cave space. */
  cave?: number;
}

export interface Occlusion {
  space: ReverbSpaceName;
  /** Lowpass on the outside world (ambience bed and distant one-shots). 20000 = open. */
  outsideCutoffHz: number;
  outsideGainDb: number;
  /** Glide time for the outside stage. */
  rampS: number;
  /** Your own hull's creak bed. */
  ownCreakDb: number;
  /** Your own hull's flooding loops, and the cap on their brightness. */
  ownFloodDb: number;
  ownFloodCutoffHz: number;
}

export const OPEN_CUTOFF_HZ = 20000;
export const HOLD_OUTSIDE_CUTOFF_HZ = 900;
export const HOLD_OUTSIDE_DB = -8;
export const HOLD_RAMP_S = 0.25;
export const HOLD_OWN_CREAK_DB = 6;
export const HOLD_OWN_FLOOD_DB = 4;
export const TOPSIDE_HOLD_CUTOFF_HZ = 1200;
export const TOPSIDE_HOLD_DB = -6;

export function occlusionFor(s: ListenerSpace | null | undefined): Occlusion {
  const inHold = !!s?.inHold;
  const aboard = inHold || !!s?.aboard;
  const cave = Number.isFinite(s?.cave) ? Math.min(1, Math.max(0, s?.cave as number)) : 0;
  if (inHold) {
    return {
      space: 'hold', outsideCutoffHz: HOLD_OUTSIDE_CUTOFF_HZ, outsideGainDb: HOLD_OUTSIDE_DB, rampS: HOLD_RAMP_S,
      ownCreakDb: HOLD_OWN_CREAK_DB, ownFloodDb: HOLD_OWN_FLOOD_DB, ownFloodCutoffHz: OPEN_CUTOFF_HZ,
    };
  }
  return {
    space: cave > 0.5 ? 'cave' : 'outdoor', outsideCutoffHz: OPEN_CUTOFF_HZ, outsideGainDb: 0, rampS: HOLD_RAMP_S,
    ownCreakDb: 0,
    // Topside, your own hold's water comes up through the deck planking.
    ownFloodDb: aboard ? TOPSIDE_HOLD_DB : 0,
    ownFloodCutoffHz: aboard ? TOPSIDE_HOLD_CUTOFF_HZ : OPEN_CUTOFF_HZ,
  };
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
