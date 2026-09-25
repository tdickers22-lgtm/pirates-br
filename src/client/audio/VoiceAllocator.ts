/**
 * VoiceAllocator: a hard cap on concurrently sounding sample voices, scaled by device tier
 * (b2.4b, audio-09, section 3.8: 64 / 40 / 24). When the pool is full a new voice may steal
 * the playing voice with the LOWEST priority x gain, and only if the newcomer scores higher:
 * a distant musket never cuts off your own cannon, and a 200-event broadside cannot build
 * 200 voices on a phone. Pure (no Web Audio): the engine passes a stop callback per voice.
 */

export type AudioTier = 'high' | 'balanced' | 'low';
export const VOICE_CAPS: Readonly<Record<AudioTier, number>> = { high: 64, balanced: 40, low: 24 };

export function isAudioTier(t: unknown): t is AudioTier {
  return t === 'high' || t === 'balanced' || t === 'low';
}

/** Coarse priority classes; callers may pass any finite number (higher = more important). */
export const VOICE_PRIORITY = { ambient: 1, foley: 2, world: 3, combat: 4, own: 5, ui: 6 } as const;

export interface VoiceRequest {
  priority: number;
  /** Linear gain the voice plays at (after distance): the "how audible is it" half of the score. */
  gain: number;
  /** Context time now, seconds. */
  now: number;
  /** Seconds until the voice ends on its own (Infinity for a loop). */
  duration: number;
  /** Called when the voice is stolen or the tier shrinks under it. */
  stop?: () => void;
}

interface Voice { id: number; score: number; endsAt: number; startedAt: number; stop?: () => void }

export class VoiceAllocator {
  private tier: AudioTier;
  private readonly voices = new Map<number, Voice>();
  private nextId = 1;
  /** Counters for tests and the audio census. */
  readonly stats = { admitted: 0, stolen: 0, rejected: 0, peak: 0 };

  constructor(tier: AudioTier = 'high') {
    this.tier = isAudioTier(tier) ? tier : 'high';
  }

  get cap(): number { return VOICE_CAPS[this.tier]; }
  get active(): number { return this.voices.size; }
  getTier(): AudioTier { return this.tier; }

  /** Change tier; if the pool is now over the cap, the lowest-scoring voices are stopped. */
  setTier(tier: AudioTier, now = 0): void {
    if (!isAudioTier(tier)) return;
    this.tier = tier;
    this.reap(now);
    while (this.voices.size > this.cap) {
      const victim = this.lowest();
      if (!victim) break;
      this.kill(victim);
    }
  }

  /** Drop voices whose natural end has passed. */
  reap(now: number): void {
    if (!Number.isFinite(now)) return;
    for (const v of this.voices.values()) if (v.endsAt <= now) this.voices.delete(v.id);
  }

  /** Admit a voice: returns its id, or null when the pool is full of voices that all outrank it. */
  acquire(req: VoiceRequest): number | null {
    const priority = Number.isFinite(req.priority) ? req.priority : 0;
    const gain = Number.isFinite(req.gain) ? Math.max(0, req.gain) : 0;
    const now = Number.isFinite(req.now) ? req.now : 0;
    const duration = Number.isNaN(req.duration) ? 0 : Math.max(0, req.duration);
    this.reap(now);
    const score = priority * gain;
    if (this.voices.size >= this.cap) {
      const victim = this.lowest();
      if (!victim || victim.score >= score) {
        this.stats.rejected += 1;
        return null;
      }
      this.kill(victim);
      this.stats.stolen += 1;
    }
    const id = this.nextId++;
    this.voices.set(id, { id, score, endsAt: now + duration, startedAt: now, stop: req.stop });
    this.stats.admitted += 1;
    if (this.voices.size > this.stats.peak) this.stats.peak = this.voices.size;
    return id;
  }

  /** The voice ended on its own (source 'ended'): free its slot without calling stop. */
  release(id: number): void {
    this.voices.delete(id);
  }

  /** Lowest priority x gain; ties go to the oldest voice. */
  lowestScore(): number | null {
    const v = this.lowest();
    return v ? v.score : null;
  }

  private lowest(): Voice | null {
    let best: Voice | null = null;
    for (const v of this.voices.values()) {
      if (!best || v.score < best.score || (v.score === best.score && v.startedAt < best.startedAt)) best = v;
    }
    return best;
  }

  private kill(v: Voice): void {
    this.voices.delete(v.id);
    try { v.stop?.(); } catch { /* a source that already ended may throw on stop(); the slot is free either way */ }
  }
}
