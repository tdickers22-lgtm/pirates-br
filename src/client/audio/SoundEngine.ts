import * as THREE from 'three';
import type { Vec3 } from '../../shared/types/index.js';

/** A looped, filtered-noise voice with an optional tremolo/gust LFO on its gain. */
interface LoopVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  lfo?: OscillatorNode;
  lfoGain?: GainNode;
}

/** Options for the spatial one-shot dispatcher. */
export interface SpatialOpts {
  /** Extra intensity/size multiplier (splashes, explosions). Default 1. */
  intensity?: number;
}

/** Kinds routed through {@link SoundEngine.playAt}. */
export type SpatialKind =
  | 'cannonFire'
  | 'cannonballWhistle'
  | 'hullImpact'
  | 'splashSmall'
  | 'splashLarge'
  | 'chainshotWhirr'
  | 'sailRip'
  | 'kegFuse'
  | 'kegExplosion';

/**
 * Procedural sound engine — synthesizes every effect from oscillators + filtered
 * noise so the game ships with zero audio assets. CombatFx already does the same
 * for shots/impacts; this class covers everything else (chests, eating, digging,
 * UI, fanfares, splashes…).
 *
 * The signal graph is:
 *   per-voice → master gain → master compressor → destination
 * which lets all sounds glue together without any one transient swamping the mix.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private busDry: GainNode | null = null;
  private busReverb: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private convolver: ConvolverNode | null = null;
  private noise: AudioBuffer | null = null;
  private masterVolume = 0.55;
  private muted = false;
  private wind: { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode; lfo?: OscillatorNode; lfoGain?: GainNode } | null = null;
  private waveBed: { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private hullCreak: {
    source: AudioBufferSourceNode;
    gain: GainNode;
    filter: BiquadFilterNode;
    lfo: OscillatorNode;
    lfoGain: GainNode;
  } | null = null;
  // Ambient bed bus — every looped ambience routes here so big booms can duck it.
  private busBed: GainNode | null = null;
  // Sailing beds (driven by setSailingState)
  private sailingRush: LoopVoice | null = null;
  private canvasFlap: LoopVoice | null = null;
  // World ambience beds (driven by setAmbience; max 4 alive: wind, waveBed, crickets, breaker)
  private crickets: LoopVoice | null = null;
  private breaker: LoopVoice | null = null;
  private nextGullAt = 0;
  private nextThunderAt = 0;
  // Interior flooding slosh (single instance)
  private flooding: (LoopVoice & { lfo2?: OscillatorNode }) | null = null;
  // Per-burning-ship fire crackle loops (capped at 2 concurrent)
  private readonly fires = new Map<string, LoopVoice>();

  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const ctx = this.ctx;

      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 3.4;
      this.compressor.attack.value = 0.005;
      this.compressor.release.value = 0.18;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.masterVolume;
      this.master.connect(this.compressor);
      this.compressor.connect(ctx.destination);

      // Wet (reverb) bus
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this.createReverbImpulse(ctx, 1.6, 2.6);
      this.busReverb = ctx.createGain();
      this.busReverb.gain.value = 0.22;
      this.busReverb.connect(this.convolver);
      this.convolver.connect(this.master);

      this.busDry = ctx.createGain();
      this.busDry.gain.value = 1;
      this.busDry.connect(this.master);

      // Ambient bed bus — looped ambience routes through here so booms can duck it.
      this.busBed = ctx.createGain();
      this.busBed.gain.value = 1;
      this.busBed.connect(this.master);

      this.noise = this.createNoiseBuffer(ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(volume: number): void {
    this.masterVolume = THREE.MathUtils.clamp(volume, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.masterVolume;
  }

  // ── Pocket use (fruit / wood) ────────────────────────────────────
  playFruitEat(kind: 'banana' | 'coconut' | 'mango' = 'banana'): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const profile = {
      banana: { base: 1700, body: 280, wet: false, chomps: 3, soft: 0.6 },
      coconut: { base: 980, body: 160, wet: false, chomps: 4, soft: 0.2 }, // hard crunch
      mango: { base: 1450, body: 220, wet: true, chomps: 3, soft: 0.85 },
    }[kind];

    for (let i = 0; i < profile.chomps; i++) {
      const at = now + i * (0.08 + (i % 2) * 0.02);
      // Crunch transient
      this.playNoise(at, 0.07, profile.base + (i % 2) * 220, 1.6, 0.34, 'bandpass');
      this.playNoise(at, 0.04, 4200, 1.0, 0.18, 'highpass');
      // Body thump (jaw closing)
      this.playTone(at, profile.body - i * 18, profile.body * 0.55, 0.06, 0.22, 'triangle', 0.04);
      // Slight pitch detune to feel organic
      this.playTone(at + 0.005, profile.body * 1.5 + i * 18, profile.body * 0.9, 0.05, 0.1, 'sine', 0.03);
    }

    if (profile.wet) {
      // Juicy slosh tail
      this.playNoise(now + 0.18, 0.24, 480, 0.9, 0.22, 'lowpass');
      this.playTone(now + 0.22, 320, 180, 0.18, 0.1, 'sine');
    }
    // Swallow at end
    this.playTone(now + profile.chomps * 0.09 + 0.08, 220, 110, 0.18, 0.12 * profile.soft, 'sine', 0.06);
  }

  playMeatEat(): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    for (let i = 0; i < 4; i++) {
      const at = now + i * 0.085;
      this.playNoise(at, 0.075, 980 + i * 130, 1.1, 0.22, 'bandpass');
      this.playNoise(at + 0.012, 0.048, 2600, 0.8, 0.08, 'highpass');
      this.playTone(at, 180 - i * 8, 96, 0.07, 0.11, 'triangle', 0.01);
    }
    this.playNoise(now + 0.24, 0.26, 360, 0.72, 0.13, 'lowpass');
    this.playTone(now + 0.34, 150, 82, 0.2, 0.1, 'sine', 0.06);
  }

  /** One mallet strike. Factored out so the repair sequence can chain several. */
  private plankHit(when: number, vol = 1): void {
    // Heavy mallet-on-board: stiff transient, woody body resonance, low thud.
    this.playNoise(when, 0.05, 1800, 1.2, 0.25 * vol, 'bandpass');
    this.playTone(when, 240, 110, 0.16, 0.32 * vol, 'triangle', 0.005);
    this.playTone(when + 0.005, 165, 78, 0.22, 0.28 * vol, 'triangle');
    this.playTone(when + 0.04, 92, 60, 0.18, 0.18 * vol, 'sine');
    this.playNoise(when, 0.12, 360, 0.9, 0.16 * vol, 'lowpass');
    // Hammer ring
    this.playTone(when, 1320, 880, 0.06, 0.06 * vol, 'square');
  }

  playWoodPlank(): void {
    this.unlock();
    if (!this.ctx) return;
    this.plankHit(this.ctx.currentTime, 1);
  }

  /** Three-hit hammering burst for a full repair action. */
  playRepairSequence(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const offsets = [0, 0.24, 0.46];
    const vols = [0.95, 1, 0.85];
    for (let i = 0; i < 3; i++) this.plankHit(now + offsets[i], vols[i]);
  }

  // ── Digging ──────────────────────────────────────────────────────
  /** Each strike is a metallic ping into a soft dirt thud — fire on every animation strike. */
  playDigStrike(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Shovel scrape
    this.playNoise(now, 0.18, 1800, 0.6, 0.22, 'bandpass');
    // Dirt thud body
    this.playNoise(now, 0.22, 220, 0.9, 0.46, 'lowpass');
    this.playTone(now, 88, 54, 0.16, 0.28, 'triangle', 0.005);
    // Spade clang
    this.playTone(now + 0.005, 1850, 1450, 0.07, 0.1, 'square');
    this.playTone(now + 0.012, 2640, 1980, 0.06, 0.06, 'sine');
    // Falling dirt clods
    this.playNoise(now + 0.14, 0.18, 380, 0.4, 0.12, 'lowpass');
  }

  // ── Harvesting ───────────────────────────────────────────────────
  /** Axe biting into a palm trunk / boulder face — low knock + wood crack. */
  playAxeChop(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Low haft knock — the blow landing.
    this.playTone(now, 130, 62, 0.14, 0.34, 'triangle', 0.004);
    this.playNoise(now, 0.1, 320, 0.9, 0.3, 'lowpass');
    // Wood crack — bright splintering transient.
    this.playNoise(now + 0.008, 0.06, 2400, 1.3, 0.26, 'bandpass');
    this.playTone(now + 0.01, 1500, 620, 0.05, 0.1, 'square');
    // Fibres tearing as the edge pulls free.
    this.playNoise(now + 0.07, 0.12, 900, 0.7, 0.1, 'bandpass');
  }

  /** Felled palm hitting the ground — soft heavy earth thud + frond rustle.
   *  @param distance metres from the listener; rolls off like other spatials. */
  playTreeFallThud(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 110) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    // Deep soft ground impact.
    this.playTone(now, 72, 42, 0.3, 0.4 * g, 'sine', 0.01, dest);
    this.playNoise(now, 0.24, 200, 0.8, 0.42 * g, 'lowpass', dest);
    // Trunk knock.
    this.playTone(now + 0.01, 150, 84, 0.14, 0.2 * g, 'triangle', 0.004, dest);
    // Fronds settling.
    this.playNoise(now + 0.06, 0.32, 1500, 0.5, 0.12 * g, 'bandpass', dest);
  }

  // ── Shark telegraphs ─────────────────────────────────────────────
  /** Windup growl — low sawtooth slide under a noise rumble (the dodge cue).
   *  @param distance metres from the listener; rolls off like other spatials. */
  playSharkGrowl(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 90) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playTone(now, 70, 50, 0.5, 0.34 * g, 'sawtooth', 0.05, dest);
    this.playTone(now + 0.03, 46, 34, 0.46, 0.22 * g, 'triangle', 0.06, dest);
    this.playNoise(now, 0.5, 180, 0.8, 0.24 * g, 'lowpass', dest);
  }

  /** Lunge bite — sharp noise snap over two low body tones. */
  playSharkChomp(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 90) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playNoise(now, 0.05, 2600, 1.6, 0.3 * g, 'bandpass', dest);
    this.playNoise(now + 0.01, 0.09, 700, 1.0, 0.26 * g, 'lowpass', dest);
    this.playTone(now, 150, 70, 0.12, 0.3 * g, 'triangle', 0.002, dest);
    this.playTone(now + 0.05, 95, 48, 0.18, 0.24 * g, 'sine', 0.004, dest);
  }

  // ── Treasure chests ──────────────────────────────────────────────
  playChestPickup(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Heave-grunt bass + lock rattle + shimmer up
    this.playTone(now, 96, 72, 0.22, 0.32, 'sine', 0.01);
    this.playTone(now, 660, 660, 0.18, 0.18, 'sine');
    this.playTone(now + 0.04, 880, 880, 0.22, 0.16, 'sine');
    this.playTone(now + 0.09, 1320, 1320, 0.28, 0.12, 'triangle');
    // Wood creak underneath
    this.playNoise(now, 0.22, 420, 1.1, 0.1, 'bandpass');
    // Brass lock rattle
    this.playNoise(now + 0.02, 0.06, 4800, 1.4, 0.08, 'highpass');
    this.playNoise(now + 0.06, 0.05, 5600, 1.5, 0.06, 'highpass');
  }

  playChestStow(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Drop onto deck planks: heavy thud, plank rattle, settle creak
    this.playTone(now, 110, 60, 0.2, 0.34, 'triangle', 0.005);
    this.playNoise(now, 0.18, 220, 0.9, 0.32, 'lowpass');
    this.playTone(now + 0.04, 380, 240, 0.14, 0.12, 'sine');
    // Plank rattle
    this.playNoise(now + 0.04, 0.1, 1600, 1.0, 0.12, 'bandpass');
    // Settle
    this.playTone(now + 0.16, 90, 70, 0.2, 0.12, 'triangle');
  }

  playChestOpen(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Hinge creak — sustained mid-frequency rasp
    this.playNoise(now, 0.32, 1100, 1.4, 0.16, 'bandpass');
    this.playTone(now, 240, 480, 0.32, 0.1, 'sawtooth');
    // Latch click
    this.playNoise(now + 0.05, 0.04, 4800, 1.6, 0.14, 'highpass');
    // Reveal arpeggio (richer chord, with brightness)
    this.playTone(now + 0.18, 660, 990, 0.28, 0.18, 'triangle');
    this.playTone(now + 0.28, 990, 1320, 0.36, 0.16, 'sine');
    this.playTone(now + 0.4, 1320, 1760, 0.34, 0.14, 'sine');
    this.playTone(now + 0.4, 1760, 2640, 0.36, 0.1, 'sine');
    // Coin sparkle scatter
    for (let i = 0; i < 4; i++) {
      this.playNoise(now + 0.2 + i * 0.07, 0.04, 6500 + i * 400, 1.8, 0.08, 'highpass');
      this.playTone(now + 0.22 + i * 0.07, 1980 + i * 220, 1980 + i * 220, 0.06, 0.06, 'sine');
    }
  }

  playDoorCreak(opening: boolean): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Hinge creak — same rasp family as the chest lid, pitched by direction.
    this.playNoise(now, 0.3, opening ? 1050 : 850, 1.3, 0.14, 'bandpass');
    this.playTone(now, opening ? 220 : 300, opening ? 430 : 170, 0.3, 0.09, 'sawtooth');
    if (opening) {
      // Latch lifts first
      this.playNoise(now, 0.035, 4200, 1.6, 0.12, 'highpass');
    } else {
      // Frame thud + latch clack as it seats
      this.playTone(now + 0.24, 120, 80, 0.14, 0.2, 'triangle');
      this.playNoise(now + 0.26, 0.04, 3800, 1.5, 0.12, 'highpass');
    }
  }

  // ── Combat feedback ──────────────────────────────────────────────
  playPlayerHurt(damage: number): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const intensity = THREE.MathUtils.clamp(damage / 50, 0.2, 1);
    // Layered grunt + breath knock-out + soft sting
    this.playTone(now, 220 + intensity * 60, 110, 0.22, 0.22 * intensity, 'triangle', 0.005);
    this.playTone(now + 0.005, 180 + intensity * 40, 80, 0.28, 0.18 * intensity, 'sawtooth');
    this.playNoise(now, 0.16, 720, 1.1, 0.22 * intensity, 'bandpass');
    // Quick high sting for clarity
    this.playTone(now, 1320, 880, 0.08, 0.1 * intensity, 'square');
    // Heavier hit = chest-thump body
    if (intensity > 0.6) {
      this.playTone(now, 70, 40, 0.32, 0.28 * intensity, 'sine', 0.02);
    }
  }

  /** Confirmation chirp when YOU land a hit on someone. */
  playHitMarker(headshot: boolean): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (headshot) {
      // Sharp ping double-tap
      this.playTone(now, 1760, 2640, 0.1, 0.22, 'square');
      this.playTone(now + 0.04, 2640, 3300, 0.1, 0.16, 'sine');
      this.playNoise(now, 0.06, 5000, 1.6, 0.14, 'highpass');
    } else {
      this.playTone(now, 1100, 1480, 0.08, 0.18, 'triangle');
      this.playTone(now + 0.02, 1480, 1980, 0.06, 0.12, 'sine');
    }
  }

  /** Heavier stinger when you actually killed someone. */
  playKill(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Bell-toll body + descending growl + impact noise
    this.playTone(now, 110, 55, 0.42, 0.34, 'triangle', 0.005);
    this.playTone(now, 220, 110, 0.32, 0.22, 'sine');
    this.playTone(now + 0.05, 73, 55, 0.5, 0.2, 'sawtooth');
    this.playNoise(now, 0.18, 420, 1.1, 0.18, 'bandpass');
    this.playNoise(now + 0.04, 0.06, 5800, 1.5, 0.1, 'highpass');
    // Tonal "doom" tail
    this.playTone(now + 0.18, 165, 110, 0.55, 0.16, 'triangle');
  }

  /** Quick whoosh as a melee weapon arcs through the air. */
  playCutlassSwing(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Two-stage whoosh: low-pass body + high-pass leading edge
    this.playNoise(now, 0.24, 800, 1.0, 0.22, 'bandpass');
    this.playNoise(now + 0.02, 0.18, 3200, 0.7, 0.2, 'highpass');
    this.playTone(now, 540, 200, 0.2, 0.08, 'sawtooth');
    // Steel ring as the blade leaves the scabbard / edge cuts
    this.playTone(now, 1980, 1320, 0.08, 0.08, 'square');
  }

  // ── Cannon (fired from a ship cannon) — used for player-launch confirmation ──
  /**
   * @param distance metres from the listener. 0 = on top of you (unchanged local feel).
   *   Beyond 140m this becomes a soft, delayed distant thump instead of a sharp crack.
   */
  playCannonFire(distance = 0): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    const now = ctx.currentTime;
    if (distance > 140) {
      this.distantCannonThump(now, distance);
      return;
    }
    const { dest, gain: g } = this.makeSpatialDest(distance);
    // Muzzle crack, low pressure wave, carriage thump, and a short smoky tail.
    this.playNoise(now, 0.045, 5200, 0.8, 0.34 * g, 'highpass', dest);
    this.playTone(now, 104, 34, 0.48, 0.54 * g, 'sawtooth', 0.003, dest);
    this.playTone(now + 0.018, 58, 29, 0.68, 0.34 * g, 'sine', 0.006, dest);
    this.playNoise(now, 0.34, 180, 0.7, 0.54 * g, 'lowpass', dest);
    this.playNoise(now + 0.012, 0.3, 1450, 0.95, 0.3 * g, 'bandpass', dest);
    this.playNoise(now + 0.06, 0.18, 320, 1.1, 0.18 * g, 'bandpass', dest);
    this.playTone(now + 0.06, 82, 56, 0.22, 0.2 * g, 'triangle', 0.01, dest);
    this.playNoise(now + 0.18, 0.62, 420, 0.42, 0.2 * g, 'lowpass', dest);
    // Ship-shaking sub + bed duck at close range.
    if (distance < 28) {
      const shake = 1 - distance / 28;
      this.playTone(now, 44, 26, 0.7, 0.4 * shake, 'sine', 0.01, dest);
      this.duckBeds(0.5, 0.4, 0.4);
    }
  }

  /** Low, delayed rumble for a cannon fired far away — no sharp transient reaches you. */
  private distantCannonThump(now: number, distance: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    const delay = THREE.MathUtils.clamp(distance / 343, 0.2, 1.2); // ~sound-travel time
    const at = now + delay;
    const g = 1 / (1 + distance / 60); // gentler rolloff for the low thump
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.6;
    filter.connect(this.busDry);
    this.playTone(at, 70, 40, 0.6, 0.5 * g, 'sine', 0.02, filter);
    this.playTone(at + 0.02, 48, 30, 0.85, 0.4 * g, 'sine', 0.03, filter);
    this.playNoise(at, 0.5, 200, 0.5, 0.3 * g, 'lowpass', filter);
    this.playNoise(at + 0.12, 0.6, 140, 0.4, 0.18 * g, 'lowpass', filter);
  }

  // ── Water ────────────────────────────────────────────────────────
  /**
   * @param intensity ~0.35 = small plop, ~1.4 = large splash.
   * @param distance metres from the listener (0 = local).
   */
  playSplash(intensity: number, distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(intensity, 0.1, 1.5);
    const { dest, gain } = this.makeSpatialDest(distance);
    const v = volume * gain;
    this.playNoise(now, 0.26, 4600, 0.45, 0.36 * v, 'highpass', dest);
    this.playNoise(now + 0.025, 0.42, 980, 0.75, 0.38 * v, 'bandpass', dest);
    this.playNoise(now + 0.08, 0.55, 260, 0.55, 0.22 * v, 'lowpass', dest);
    this.playTone(now + 0.018, 210, 72, 0.32, 0.15 * v, 'triangle', 0, dest);
    this.playTone(now + 0.1, 92, 55, 0.44, 0.12 * v, 'sine', 0.03, dest);
    for (let i = 0; i < 5; i++) {
      const at = now + 0.18 + i * 0.055;
      this.playTone(at, 980 + i * 190, 1500 + i * 240, 0.05, 0.038 * v, 'sine', 0, dest);
      this.playNoise(at, 0.04, 5200 + i * 260, 1.35, 0.045 * v, 'highpass', dest);
    }
  }

  playAnchorChange(dropped: boolean): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const clankCount = dropped ? 5 : 3;
    this.playTone(now, dropped ? 92 : 128, dropped ? 48 : 86, dropped ? 0.42 : 0.28, 0.26, 'triangle', 0.006);
    this.playNoise(now, dropped ? 0.44 : 0.28, 260, 0.82, dropped ? 0.34 : 0.22, 'lowpass');
    for (let i = 0; i < clankCount; i++) {
      const at = now + i * (dropped ? 0.055 : 0.085);
      this.playNoise(at, 0.055, 2800 + i * 180, 1.6, dropped ? 0.14 : 0.1, 'bandpass');
      this.playTone(at + 0.006, 620 + i * 35, 430 + i * 22, 0.09, dropped ? 0.09 : 0.07, 'square');
    }
    this.playNoise(now + (dropped ? 0.22 : 0.18), 0.28, 720, 1.1, 0.12, 'bandpass');
  }

  playAnchorMovement(amount = 1): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(amount, 0.25, 1.25);
    // Capstan pawl, chain scrape, and a low wooden groan while the anchor is being raised.
    this.playTone(now, 160, 96, 0.12, 0.09 * volume, 'triangle', 0.004);
    this.playNoise(now, 0.16, 340, 1.2, 0.11 * volume, 'bandpass');
    this.playNoise(now + 0.012, 0.08, 1900, 1.55, 0.09 * volume, 'bandpass');
    this.playTone(now + 0.026, 620, 430, 0.075, 0.055 * volume, 'square');
  }

  playHelmTurn(amount = 1): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(amount, 0.25, 1.2);
    // Old wooden wheel: axle creak plus rope/rudder strain.
    this.playNoise(now, 0.16, 520, 1.05, 0.11 * volume, 'bandpass');
    this.playTone(now, 260, 170, 0.18, 0.075 * volume, 'sawtooth', 0.025);
    this.playTone(now + 0.035, 94, 72, 0.2, 0.045 * volume, 'triangle', 0.02);
    this.playNoise(now + 0.045, 0.11, 1650, 0.75, 0.055 * volume, 'bandpass');
  }

  playHullSplash(amount = 1): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(amount, 0.2, 1.3);
    // Bow wash against the hull: soft low slosh with bright spray flecks.
    this.playNoise(now, 0.42, 260, 0.45, 0.12 * volume, 'lowpass');
    this.playNoise(now + 0.02, 0.24, 1180, 0.7, 0.09 * volume, 'bandpass');
    this.playNoise(now + 0.06, 0.12, 4200, 1.2, 0.052 * volume, 'highpass');
    this.playTone(now + 0.03, 88, 58, 0.3, 0.055 * volume, 'sine', 0.03);
  }

  /**
   * One swim stroke — a soft low water slosh with a light spray fleck and a
   * gentle bubble tail. Called on a stroke cadence while swimming (and once,
   * louder, when you break the surface). Kept quiet so a long swim never nags.
   * @param amount 0.4 = idle tread, ~1.1 = a hard forward stroke / surfacing.
   */
  playSwimSplash(amount = 1): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const v = THREE.MathUtils.clamp(amount, 0.3, 1.25);
    // Body of the stroke: a short swept low slosh (arm/leg pushing water).
    this.playNoise(now, 0.2 + 0.1 * v, 300, 0.5, 0.09 * v, 'lowpass');
    this.playNoise(now + 0.015, 0.16, 780, 0.7, 0.06 * v, 'bandpass');
    // Bright spray flecks off the surface.
    this.playNoise(now + 0.02, 0.09, 3600, 1.1, 0.045 * v, 'highpass');
    // A couple of low glooping bubbles trailing the stroke.
    for (let i = 0; i < 2; i++) {
      const at = now + 0.12 + i * 0.07;
      this.playTone(at, 150 - i * 34, 90 + i * 40, 0.09, 0.03 * v, 'sine', 0.02);
    }
  }

  playSailTrim(amount = 1): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(amount, 0.35, 1.25);
    this.playNoise(now, 0.18, 760, 0.8, 0.16 * volume, 'bandpass');
    this.playNoise(now + 0.025, 0.12, 2100, 1.1, 0.13 * volume, 'bandpass');
    this.playTone(now + 0.015, 460, 320, 0.16, 0.08 * volume, 'sawtooth', 0.02);
    this.playTone(now + 0.1, 180, 130, 0.22, 0.06 * volume, 'triangle', 0.03);
  }

  // ── Match flow ───────────────────────────────────────────────────
  playMatchStart(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Heroic horn fanfare: G3 → D4 → G4 → B4 with brass-like sawtooth + triangle harmony,
    // plus a snare-style bandpass noise on the resolution.
    const blast = (when: number, freq: number, dur: number, vol: number) => {
      this.playTone(when, freq, freq, dur, vol * 0.6, 'sawtooth', 0.02);
      this.playTone(when, freq, freq, dur, vol, 'triangle', 0.02);
      this.playTone(when, freq * 2, freq * 2, dur, vol * 0.25, 'sine', 0.02);
    };
    blast(now,        196, 0.26, 0.28);
    blast(now + 0.18, 294, 0.26, 0.28);
    blast(now + 0.36, 392, 0.5, 0.32);
    blast(now + 0.36, 494, 0.5, 0.18); // major third on top
    this.playNoise(now + 0.36, 0.22, 1800, 0.9, 0.18, 'bandpass');
    // Low bass drop
    this.playTone(now + 0.36, 65, 49, 0.7, 0.22, 'sine', 0.02);
  }

  playVictory(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Major arpeggio C5 E5 G5 C6 with octave bass and a sustained pad.
    const note = (when: number, freq: number, dur: number, vol: number) => {
      this.playTone(when, freq, freq, dur, vol * 0.7, 'triangle', 0.02);
      this.playTone(when, freq * 2, freq * 2, dur, vol * 0.2, 'sine', 0.02);
    };
    note(now,        523, 0.36, 0.26);
    note(now + 0.16, 659, 0.36, 0.26);
    note(now + 0.32, 784, 0.36, 0.26);
    note(now + 0.48, 1046, 0.85, 0.32);
    // Bass octave under the resolution
    this.playTone(now + 0.48, 261, 261, 0.85, 0.22, 'sine', 0.04);
    // Bright bell on top
    this.playTone(now + 0.48, 1568, 1568, 0.7, 0.16, 'sine');
    this.playTone(now + 0.48, 2093, 2093, 0.55, 0.1, 'sine');
    // Sustained pad chord (C major)
    this.playTone(now + 0.5, 523, 523, 1.6, 0.08, 'triangle', 0.1);
    this.playTone(now + 0.5, 659, 659, 1.6, 0.08, 'triangle', 0.1);
    this.playTone(now + 0.5, 784, 784, 1.6, 0.08, 'triangle', 0.1);
  }

  playDefeat(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Long descending minor with low drone
    this.playTone(now,        392, 392, 0.5, 0.24, 'sawtooth', 0.04);
    this.playTone(now + 0.32, 311, 311, 0.62, 0.26, 'sawtooth', 0.04);
    this.playTone(now + 0.64, 261, 261, 0.78, 0.26, 'sawtooth', 0.04);
    // Drone tail
    this.playTone(now + 0.32, 130, 98, 1.3, 0.22, 'triangle', 0.06);
    this.playTone(now + 0.32, 65, 49, 1.4, 0.18, 'sine', 0.06);
    // Distant thunder
    this.playNoise(now + 0.4, 0.7, 220, 0.4, 0.18, 'lowpass');
  }

  // ── Economy / progression ────────────────────────────────────────
  playUpgradeBought(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Anvil clank → bright ascending chord
    this.playNoise(now, 0.06, 2800, 1.4, 0.22, 'bandpass');
    this.playTone(now, 880, 660, 0.06, 0.18, 'square');
    this.playTone(now + 0.005, 220, 110, 0.18, 0.22, 'triangle', 0.005);
    // Chord
    this.playTone(now + 0.1,  440,  660,  0.22, 0.22, 'triangle', 0.02);
    this.playTone(now + 0.22, 660,  990,  0.26, 0.22, 'triangle', 0.02);
    this.playTone(now + 0.36, 990,  1320, 0.4, 0.2, 'sine', 0.02);
    this.playTone(now + 0.36, 1320, 1760, 0.4, 0.16, 'sine', 0.02);
    // Sparkle tail
    for (let i = 0; i < 3; i++) {
      this.playTone(now + 0.5 + i * 0.06, 1980 + i * 220, 1980 + i * 220, 0.08, 0.07, 'sine');
    }
  }

  playGoldEarn(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Multiple coin clinks in quick succession + high sparkle
    for (let i = 0; i < 3; i++) {
      const at = now + i * 0.04;
      this.playTone(at, 1500 + i * 180, 1500 + i * 180, 0.04, 0.16, 'sine');
      this.playTone(at + 0.005, 2400 + i * 200, 2400 + i * 200, 0.05, 0.12, 'sine');
      this.playNoise(at, 0.04, 5400, 1.6, 0.07, 'highpass');
    }
    // Subtle weight thump
    this.playTone(now, 220, 110, 0.1, 0.06, 'triangle');
  }

  // ── UI / chrome ──────────────────────────────────────────────────
  playUiClick(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playTone(now, 1320, 880, 0.04, 0.16, 'square');
    this.playTone(now + 0.005, 660, 660, 0.05, 0.08, 'triangle');
    this.playNoise(now, 0.02, 6000, 1.4, 0.04, 'highpass');
  }

  playUiHover(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playTone(now, 1400, 1600, 0.04, 0.06, 'sine');
  }

  // ── Storm wind (ambient, looped) ─────────────────────────────────
  /** Set 0..1 for storm intensity. 0 silences the wind, 1 is full gale. */
  setWindIntensity(intensity: number): void {
    if (intensity <= 0.001) {
      this.stopWind();
      return;
    }
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    const noise = this.noise;
    if (!ctx || !bed || !noise) return;
    if (!this.wind) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      // Slow LFO modulation on filter cutoff for gust feel
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();
      source.connect(filter);
      filter.connect(gain);
      gain.connect(bed);
      source.start();
      this.wind = { source, gain, filter, lfo, lfoGain };
    }
    const target = THREE.MathUtils.clamp(intensity, 0, 1) * 0.22;
    this.wind.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.4);
    this.wind.filter.frequency.linearRampToValueAtTime(360 + intensity * 360, ctx.currentTime + 0.4);
    if (this.wind.lfoGain) this.wind.lfoGain.gain.linearRampToValueAtTime(60 + intensity * 220, ctx.currentTime + 0.4);
  }

  private stopWind(): void {
    const ctx = this.ctx;
    if (!this.wind || !ctx) return;
    this.wind.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    const fading = this.wind;
    this.wind = null;
    window.setTimeout(() => {
      try { fading.source.stop(); } catch { /* ignore */ }
      try { fading.lfo?.stop(); } catch { /* ignore */ }
    }, 800);
  }

  /** Always-on calm wave bed — set 0 to disable, 1 for full ambience. */
  setWaveBed(intensity: number): void {
    if (intensity <= 0.001) {
      if (this.waveBed && this.ctx) {
        this.waveBed.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
      }
      return;
    }
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    const noise = this.noise;
    if (!ctx || !bed || !noise) return;
    if (!this.waveBed) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 380;
      filter.Q.value = 0.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(bed);
      source.start();
      this.waveBed = { source, gain, filter };
    }
    const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
    const target = clamped * 0.085;
    this.waveBed.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.6);
    this.waveBed.filter.frequency.linearRampToValueAtTime(260 + clamped * 360, ctx.currentTime + 0.8);
    this.waveBed.filter.Q.linearRampToValueAtTime(0.32 + clamped * 0.34, ctx.currentTime + 0.8);
  }

  setHullCreakIntensity(intensity: number, motion = 0): void {
    if (intensity <= 0.001) {
      if (this.hullCreak && this.ctx) {
        this.hullCreak.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.7);
      }
      return;
    }
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    const wet = this.busReverb;
    const noise = this.noise;
    if (!ctx || !bed || !wet || !noise) return;
    if (!this.hullCreak) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 210;
      filter.Q.value = 4.8;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.13;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 80;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(bed);
      const wetGain = ctx.createGain();
      wetGain.gain.value = 0.18;
      gain.connect(wetGain);
      wetGain.connect(wet);
      source.start();
      lfo.start();
      this.hullCreak = { source, gain, filter, lfo, lfoGain };
    }
    const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
    const motionClamped = THREE.MathUtils.clamp(motion, 0, 1);
    this.hullCreak.gain.gain.linearRampToValueAtTime(0.012 + clamped * 0.055, ctx.currentTime + 0.55);
    this.hullCreak.filter.frequency.linearRampToValueAtTime(160 + motionClamped * 190, ctx.currentTime + 0.7);
    this.hullCreak.filter.Q.linearRampToValueAtTime(4.2 + clamped * 2.2, ctx.currentTime + 0.7);
    this.hullCreak.lfo.frequency.linearRampToValueAtTime(0.1 + motionClamped * 0.28, ctx.currentTime + 0.7);
    this.hullCreak.lfoGain.gain.linearRampToValueAtTime(55 + clamped * 115, ctx.currentTime + 0.7);
  }

  // ── Spatial helper ───────────────────────────────────────────────
  spatialVolume(position: Vec3, cameraPos: THREE.Vector3, maxDistance = 160, boost = 1): number {
    const dx = position.x - cameraPos.x;
    const dy = position.y - cameraPos.y;
    const dz = position.z - cameraPos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const n = 1 - THREE.MathUtils.clamp(d / maxDistance, 0, 1);
    return n * n * boost;
  }

  // ── Spatial one-shot dispatcher ──────────────────────────────────
  /**
   * Fire a positioned one-shot with distance-based gain rolloff (~1/(1+d/24)) and a
   * distance lowpass. Cannon/keg beyond 140m degrade into a soft, delayed distant thump.
   */
  playAt(kind: SpatialKind, worldDistance: number, opts: SpatialOpts = {}): void {
    const d = Math.max(0, worldDistance);
    const intensity = opts.intensity ?? 1;
    switch (kind) {
      case 'cannonFire': this.playCannonFire(d); break;
      case 'cannonballWhistle': this.playCannonballWhistle(d); break;
      case 'hullImpact': this.playHullImpact(d); break;
      case 'splashSmall': this.playSplash(0.4 * intensity, d); break;
      case 'splashLarge': this.playSplash(1.3 * intensity, d); break;
      case 'chainshotWhirr': this.playChainshotWhirr(d); break;
      case 'sailRip': this.playSailRip(d); break;
      case 'kegFuse': this.playKegFuse(1.6, d); break;
      case 'kegExplosion': this.playKegExplosion(d); break;
    }
  }

  /**
   * Build a per-shot lowpass→busDry group plus the distance gain multiplier.
   * Nearer = brighter + louder; distance colours the dry path, gain scales the whole voice.
   */
  private makeSpatialDest(distance: number): { dest: BiquadFilterNode; gain: number } {
    const ctx = this.ctx as AudioContext;
    const d = Math.max(0, distance);
    const gain = 1 / (1 + d / 24);
    const cutoff = THREE.MathUtils.clamp(19000 / (1 + d / 45), 380, 19000);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.5;
    filter.connect(this.busDry as GainNode);
    return { dest: filter, gain };
  }

  // ── Naval combat one-shots ───────────────────────────────────────
  /** Airy whistle that rises then falls to fake a cannonball passing by (no true doppler). */
  playCannonballWhistle(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playTone(now, 900, 1700, 0.16, 0.12 * g, 'sine', 0.02, dest);
    this.playTone(now + 0.16, 1700, 620, 0.26, 0.12 * g, 'sine', 0, dest);
    this.playNoise(now, 0.4, 2400, 3.2, 0.06 * g, 'bandpass', dest);
  }

  /** Cannonball smashing a hull — deep thud under a burst of wood splinters. */
  playHullImpact(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playTone(now, 120, 46, 0.22, 0.42 * g, 'triangle', 0.004, dest);
    this.playTone(now + 0.006, 76, 40, 0.3, 0.3 * g, 'sine', 0.008, dest);
    this.playNoise(now, 0.16, 300, 0.8, 0.4 * g, 'lowpass', dest);
    this.playNoise(now, 0.12, 1500, 1.1, 0.22 * g, 'bandpass', dest);
    for (let i = 0; i < 6; i++) {
      const at = now + 0.01 + Math.random() * 0.14;
      this.playNoise(at, 0.05, 2600 + Math.random() * 2600, 2.4, 0.1 * g, 'bandpass', dest);
    }
    if (distance < 24) this.duckBeds(0.6, 0.3, 0.25);
  }

  /**
   * A ship physically CRASHING — ramming another hull, running aground on a
   * beach/bar, or striking a sea rock. Builds a heavy timber smash (deep thud +
   * groaning strain + splinters) and layers a kind-specific tail:
   *   ram    → a second wooden boom as the two hulls slam and grind
   *   ground → a long gritty gravel/sand scrape as the keel drags
   *   rock   → a sharp high stone crack as rock tears into the planks
   * @param kind    what got hit
   * @param speed   impact speed (m/s); scales weight, brightness, and duck
   * @param distance metres from the listener (0 = your own ship)
   */
  playShipImpact(kind: 'ram' | 'ground' | 'rock', speed: number, distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    // 2..9 m/s maps to a 0.45..1.15 weight so a light nudge is a bump and a
    // full-speed slam is a house-shaking crash.
    const w = THREE.MathUtils.clamp(0.45 + (speed - 2) / 10, 0.45, 1.15);
    // Core timber smash: sub thud, a low wooden boom, a lowpassed body, and a
    // splinter burst — heavier and a touch lower than a cannonball hull hit.
    this.playTone(now, 96, 44, 0.3, 0.5 * w * g, 'triangle', 0.004, dest);
    this.playTone(now + 0.008, 60, 52, 0.42, 0.4 * w * g, 'sine', 0.01, dest);
    this.playNoise(now, 0.22, 260, 0.7, 0.46 * w * g, 'lowpass', dest);
    this.playNoise(now + 0.01, 0.18, 1200, 0.9, 0.2 * w * g, 'bandpass', dest);
    // Hull strain groan (planks flexing) — a detuned low saw that decays.
    this.playTone(now + 0.04, 138, 96, 0.5, 0.14 * w * g, 'sawtooth', 0.05, dest);
    for (let i = 0; i < 7; i++) {
      const at = now + 0.01 + Math.random() * 0.2;
      this.playNoise(at, 0.05, 2400 + Math.random() * 2800, 2.2, 0.09 * w * g, 'bandpass', dest);
    }
    if (kind === 'ram') {
      // Second boom + a grinding wood-on-wood scrape as the hulls rub apart.
      this.playTone(now + 0.09, 82, 60, 0.34, 0.3 * w * g, 'triangle', 0.02, dest);
      this.playNoise(now + 0.06, 0.5, 520, 0.6, 0.16 * w * g, 'bandpass', dest);
    } else if (kind === 'ground') {
      // Long gritty keel-drag: sustained gravel/sand hiss under a wood groan.
      this.playNoise(now + 0.02, 0.8 + 0.4 * w, 180, 0.4, 0.2 * w * g, 'lowpass', dest);
      this.playNoise(now + 0.05, 0.7, 900, 0.5, 0.11 * w * g, 'bandpass', dest);
      this.playTone(now + 0.06, 70, 130, 0.6, 0.1 * w * g, 'triangle', 0.06, dest);
    } else {
      // Rock strike: a bright high-Q stone crack cutting over the timber.
      this.playNoise(now, 0.09, 5200, 2.6, 0.22 * w * g, 'highpass', dest);
      this.playTone(now + 0.004, 640, 380, 0.1, 0.12 * w * g, 'square', 0, dest);
      this.playNoise(now + 0.05, 0.16, 2600, 1.4, 0.12 * w * g, 'bandpass', dest);
    }
    if (distance < 40) this.duckBeds(0.55 * w, 0.35, 0.3);
  }

  /**
   * Body hitting the ground hard after a fall/geyser launch — a dull thud plus
   * a short grunt-like low tone. Scales with impact so a survivable drop is a
   * soft "oof" and a near-lethal fall is a heavy slam.
   * @param intensity 0..1 (fall speed / lethal speed)
   * @param distance  metres from the listener
   */
  playBodyThud(intensity = 1, distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    const v = THREE.MathUtils.clamp(intensity, 0.3, 1);
    this.playTone(now, 78, 40, 0.18, 0.34 * v * g, 'sine', 0.006, dest);
    this.playNoise(now, 0.13, 240, 0.8, 0.3 * v * g, 'lowpass', dest);
    this.playNoise(now + 0.01, 0.09, 900, 1.0, 0.12 * v * g, 'bandpass', dest);
    // Short grunt (only on a real impact).
    if (v > 0.5) this.playTone(now + 0.02, 150, 120, 0.14, 0.08 * v * g, 'sawtooth', 0.04, dest);
  }

  /** Rotating whoosh of chainshot spinning on its chain — deliberate pitch wobble. */
  playChainshotWhirr(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playNoise(now, 0.55, 780, 1.6, 0.16 * g, 'bandpass', dest);
    this.playNoise(now + 0.05, 0.42, 2200, 0.9, 0.06 * g, 'highpass', dest);
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const at = now + i * 0.06;
      const hi = i % 2 === 0;
      this.playTone(at, hi ? 320 : 210, hi ? 210 : 320, 0.07, 0.09 * g, 'sawtooth', 0.008, dest);
    }
  }

  /** Canvas tearing when chainshot rips a sail. */
  playSailRip(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playNoise(now, 0.5, 3200, 1.2, 0.18 * g, 'bandpass', dest);
    this.playNoise(now + 0.04, 0.4, 1500, 1.4, 0.14 * g, 'bandpass', dest);
    for (let i = 0; i < 10; i++) {
      const at = now + i * 0.035;
      this.playNoise(at, 0.03, 4200 - i * 260, 3, 0.05 * g, 'bandpass', dest);
    }
    this.playNoise(now + 0.3, 0.24, 900, 0.8, 0.08 * g, 'bandpass', dest);
  }

  /** Powder-keg fuse hiss. Call once when the fuse lights, passing its burn time. */
  playKegFuse(duration = 1.6, distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    const dur = THREE.MathUtils.clamp(duration, 0.3, 4);
    this.playNoise(now, dur, 5200, 1.1, 0.09 * g, 'highpass', dest);
    this.playNoise(now, dur, 1800, 0.8, 0.05 * g, 'bandpass', dest);
    const sparks = Math.floor(dur / 0.12);
    for (let i = 0; i < sparks; i++) {
      const at = now + i * 0.12 + Math.random() * 0.05;
      this.playNoise(at, 0.03, 6000 + Math.random() * 2000, 2, 0.05 * g, 'highpass', dest);
    }
  }

  /** Powder-keg detonation — sub drop, blast body, debris patter, and a rolling tail. */
  playKegExplosion(distance = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const delay = distance > 140 ? THREE.MathUtils.clamp(distance / 343, 0.2, 1.2) : 0;
    const at = now + delay;
    const { dest, gain: g } = this.makeSpatialDest(distance);
    this.playNoise(at, 0.06, 6000, 0.7, 0.4 * g, 'highpass', dest);
    this.playTone(at, 120, 30, 0.9, 0.7 * g, 'sine', 0.005, dest);
    this.playTone(at + 0.02, 70, 24, 1.2, 0.55 * g, 'sine', 0.01, dest);
    this.playNoise(at, 0.5, 260, 0.6, 0.6 * g, 'lowpass', dest);
    this.playNoise(at + 0.02, 0.4, 1200, 0.9, 0.34 * g, 'bandpass', dest);
    for (let i = 0; i < 14; i++) {
      const t = at + 0.2 + Math.random() * 0.9;
      this.playNoise(t, 0.05, 900 + Math.random() * 3200, 2.2, 0.06 * g, 'bandpass', dest);
      if (i % 3 === 0) this.playTone(t, 180 + Math.random() * 220, 90, 0.06, 0.05 * g, 'triangle', 0, dest);
    }
    this.playNoise(at + 0.15, 1.0, 200, 0.4, 0.24 * g, 'lowpass', dest);
    this.duckBeds(0.5, 0.6, 0.4);
  }

  // ── Burning-ship fire crackle (looped, max 2 concurrent) ─────────
  /** Start a fire crackle loop keyed by ship id. Ignored if two fires already burn. */
  startFire(id: string, distance = 0): void {
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (this.fires.has(id)) { this.updateFire(id, distance); return; }
    if (this.fires.size >= 2) return; // cap concurrent burning ships
    const v = this.makeNoiseLoop('bandpass', 620, 1.1, bed);
    const trem = this.addGainTremolo(v.gain, 6.5, 0.045); // flicker
    this.fires.set(id, { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain });
    this.updateFire(id, distance);
  }

  /** Update a fire's distance-driven loudness/brightness each frame. */
  updateFire(id: string, distance = 0): void {
    const f = this.fires.get(id);
    if (!f || !this.ctx) return;
    const g = 1 / (1 + distance / 24);
    this.ramp(f.gain.gain, 0.12 * g, 0.4);
    this.ramp(f.filter.frequency, 480 + 260 * g, 0.4);
  }

  /** Fade out and dispose a fire loop. */
  stopFire(id: string): void {
    const f = this.fires.get(id);
    const ctx = this.ctx;
    this.fires.delete(id);
    if (!f || !ctx) return;
    f.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    window.setTimeout(() => {
      try { f.source.stop(); } catch { /* ignore */ }
      try { f.lfo?.stop(); } catch { /* ignore */ }
    }, 800);
  }

  // ── Interior flooding slosh (single instance) ────────────────────
  /** Begin the interior water-slosh loop. level is 0..1 waterline. */
  startFlooding(level = 0): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.busDry || !this.noise) return;
    if (!this.flooding) {
      // Route to dry (not the bed bus): flooding is critical feedback, not ambience to duck.
      const v = this.makeNoiseLoop('lowpass', 420, 0.7, this.busDry);
      const trem = this.addGainTremolo(v.gain, 0.5, 0.02); // slow swell
      // Slosh: a slow LFO wobbles the filter cutoff for a moving-water feel.
      const lfo2 = ctx.createOscillator();
      lfo2.type = 'sine';
      lfo2.frequency.value = 0.32;
      const lfo2Gain = ctx.createGain();
      lfo2Gain.gain.value = 120;
      lfo2.connect(lfo2Gain);
      lfo2Gain.connect(v.filter.frequency);
      lfo2.start();
      this.flooding = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain, lfo2 };
    }
    this.updateFlooding(level);
  }

  /** Follow the waterline: louder + brighter as the interior floods. */
  updateFlooding(level: number): void {
    if (!this.ctx) return;
    if (!this.flooding) { this.startFlooding(level); return; }
    const l = THREE.MathUtils.clamp(level, 0, 1);
    this.ramp(this.flooding.gain.gain, 0.03 + l * 0.16, 0.4);
    this.ramp(this.flooding.filter.frequency, 300 + l * 700, 0.5);
  }

  /** Fade out and dispose the flooding loop. */
  stopFlooding(): void {
    const ctx = this.ctx;
    const f = this.flooding;
    this.flooding = null;
    if (!ctx || !f) return;
    f.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.7);
    window.setTimeout(() => {
      try { f.source.stop(); } catch { /* ignore */ }
      try { f.lfo?.stop(); } catch { /* ignore */ }
      try { f.lfo2?.stop(); } catch { /* ignore */ }
    }, 900);
  }

  /** Scoop-and-toss bilge bail one-shot. */
  playBail(): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    // Scoop swish
    this.playNoise(now, 0.16, 700, 1.2, 0.12, 'bandpass');
    this.playNoise(now + 0.04, 0.14, 2200, 0.9, 0.08, 'highpass');
    // Toss-out splash
    this.playNoise(now + 0.18, 0.3, 3600, 0.5, 0.16, 'highpass');
    this.playNoise(now + 0.2, 0.34, 800, 0.7, 0.14, 'bandpass');
    this.playNoise(now + 0.26, 0.4, 240, 0.5, 0.1, 'lowpass');
    this.playTone(now + 0.2, 180, 90, 0.28, 0.06, 'sine', 0.02);
  }

  // ── Sailing feel (continuous) ────────────────────────────────────
  /**
   * Drive the sailing beds each frame. Owns hull creak (heel/roughness), the along-hull
   * water rush (speed), and canvas flap (luffing). Wind/waveBed remain owned by setAmbience.
   */
  setSailingState(state: { speed01: number; roughness01: number; heel01: number; luffing: boolean }): void {
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    const speed = THREE.MathUtils.clamp(state.speed01, 0, 1);
    const rough = THREE.MathUtils.clamp(state.roughness01, 0, 1);
    const heel = THREE.MathUtils.clamp(state.heel01, 0, 1);
    // Water rush along the hull scales with speed.
    if (!this.sailingRush) this.sailingRush = this.makeNoiseLoop('bandpass', 900, 0.7, bed);
    this.ramp(this.sailingRush.gain.gain, speed * speed * 0.13, 0.3);
    this.ramp(this.sailingRush.filter.frequency, 480 + speed * 1500 + rough * 380, 0.3);
    // Hull creak follows heel + roughness + speed.
    this.setHullCreakIntensity(
      THREE.MathUtils.clamp(0.14 + heel * 0.6 + rough * 0.34, 0, 1),
      THREE.MathUtils.clamp(heel * 0.6 + speed * 0.4 + rough * 0.5, 0, 1),
    );
    // Luffing adds irregular canvas flap.
    this.setCanvasFlap(state.luffing ? THREE.MathUtils.clamp(0.4 + speed * 0.5, 0, 1) : 0);
  }

  private setCanvasFlap(amount: number): void {
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (amount <= 0.001) {
      if (this.canvasFlap) this.canvasFlap.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
      return;
    }
    if (!this.canvasFlap) {
      const v = this.makeNoiseLoop('bandpass', 1100, 1.5, bed);
      const trem = this.addGainTremolo(v.gain, 4.5, 0.05); // flapping bursts
      this.canvasFlap = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain };
    }
    this.ramp(this.canvasFlap.gain.gain, THREE.MathUtils.clamp(amount, 0, 1) * 0.08, 0.25);
  }

  // ── World / night ambience ───────────────────────────────────────
  /**
   * Crossfade the world beds. Max 4 loops alive: storm wind, ocean wave bed,
   * night crickets, near-shore breaker. Gulls (day) and thunder (storm) are sparse one-shots.
   */
  setAmbience(a: { nightFactor: number; storminess: number; nearShore01: number }): void {
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    const night = THREE.MathUtils.clamp(a.nightFactor, 0, 1);
    const storm = THREE.MathUtils.clamp(a.storminess, 0, 1);
    const shore = THREE.MathUtils.clamp(a.nearShore01, 0, 1);
    // Bed 1: storm wind.
    this.setWindIntensity(storm);
    // Bed 2: ocean wave bed — gentler "lap" at night, swells in a storm.
    this.setWaveBed(THREE.MathUtils.clamp(THREE.MathUtils.lerp(0.6, 0.32, night) + storm * 0.4, 0, 1));
    // Bed 3: night crickets (hushed in a storm).
    this.setCrickets(night * (1 - storm * 0.7));
    // Bed 4: near-shore breaker wash.
    this.setBreaker(shore);
    // Sparse day gulls.
    const now = ctx.currentTime;
    if (night < 0.4 && storm < 0.5) {
      if (this.nextGullAt === 0) this.nextGullAt = now + 4 + Math.random() * 8;
      else if (now >= this.nextGullAt) {
        this.playGullCry();
        this.nextGullAt = now + 8 + Math.random() * 12;
      }
    } else {
      this.nextGullAt = 0;
    }
    // Sparse storm thunder, distance-varied.
    if (storm > 0.45) {
      if (this.nextThunderAt === 0) this.nextThunderAt = now + 3 + Math.random() * 6;
      else if (now >= this.nextThunderAt) {
        this.playThunder(80 + Math.random() * 620);
        this.nextThunderAt = now + 6 + Math.random() * 8;
      }
    } else {
      this.nextThunderAt = 0;
    }
  }

  private setCrickets(amount: number): void {
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (amount <= 0.001) {
      if (this.crickets) this.crickets.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      return;
    }
    if (!this.crickets) {
      const v = this.makeNoiseLoop('bandpass', 4600, 8, bed);
      const trem = this.addGainTremolo(v.gain, 16, 0.03); // chirp trill
      this.crickets = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain };
    }
    this.ramp(this.crickets.gain.gain, THREE.MathUtils.clamp(amount, 0, 1) * 0.04, 0.8);
  }

  private setBreaker(amount: number): void {
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (amount <= 0.001) {
      if (this.breaker) this.breaker.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.7);
      return;
    }
    if (!this.breaker) {
      const v = this.makeNoiseLoop('lowpass', 700, 0.6, bed);
      const trem = this.addGainTremolo(v.gain, 0.16, 0.04); // slow wash swell
      this.breaker = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain };
    }
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    this.ramp(this.breaker.gain.gain, a * 0.1, 0.9);
    this.ramp(this.breaker.filter.frequency, 500 + a * 500, 0.9);
  }

  private playGullCry(): void {
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const calls = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < calls; i++) {
      const at = now + i * (0.22 + Math.random() * 0.1);
      const base = 1200 + Math.random() * 500;
      // "kee-yah" up-then-down warble
      this.playTone(at, base, base * 1.5, 0.08, 0.05, 'sawtooth', 0.01);
      this.playTone(at + 0.08, base * 1.5, base * 0.8, 0.14, 0.05, 'sawtooth', 0);
      this.playTone(at, base * 2, base * 2.4, 0.1, 0.02, 'sine', 0.01);
    }
  }

  /** One thunder crack + rolling rumble. distance in metres varies delay, brightness, and length. */
  playThunder(distance = 300): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const d = THREE.MathUtils.clamp(distance, 20, 900);
    const g = 1 / (1 + d / 220);
    const near = d < 120;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = near ? 1600 : 400 + (1 - d / 900) * 600;
    filter.Q.value = 0.5;
    filter.connect(this.busDry);
    const at = now + THREE.MathUtils.clamp(d / 343, 0, 1.5);
    if (near) {
      this.playNoise(at, 0.08, 5000, 0.7, 0.34 * g, 'highpass', filter);
      this.playTone(at, 90, 40, 0.5, 0.4 * g, 'sine', 0.004, filter);
    }
    this.playNoise(at, 1.4 + (1 - g) * 1.2, 220, 0.4, 0.3 * g, 'lowpass', filter);
    this.playNoise(at + 0.3, 1.2, 140, 0.35, 0.2 * g, 'lowpass', filter);
    this.playTone(at + 0.1, 60, 34, 1.6, 0.22 * g, 'sine', 0.05, filter);
    if (near) this.duckBeds(0.55, 0.5, 0.5);
  }

  // ── Stingers ─────────────────────────────────────────────────────
  /** Ominous rising swell for a storm-zone shrink warning. < 2.5s. */
  playStormShrink(): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    this.playTone(now, 55, 110, 1.6, 0.3, 'sawtooth', 0.4);
    this.playTone(now, 82, 138, 1.6, 0.18, 'triangle', 0.4);
    this.playNoise(now, 1.6, 300, 0.6, 0.16, 'lowpass');
    this.playTone(now + 0.2, 220, 660, 1.2, 0.08, 'sawtooth', 0.3);
    // Tension hit at the crest
    this.playTone(now + 1.4, 70, 40, 0.6, 0.3, 'sine', 0.02);
    this.playNoise(now + 1.4, 0.4, 1800, 0.8, 0.12, 'bandpass');
    this.duckBeds(0.7, 0.4, 0.6);
  }

  /** Tiny coin tick for animating a gold counter. Pitch rises with index for a run-up feel. */
  playGoldCount(index = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const freq = 1500 + THREE.MathUtils.clamp(index, 0, 24) * 40;
    this.playTone(now, freq, freq, 0.03, 0.1, 'sine');
    this.playTone(now + 0.004, freq * 1.5, freq * 1.5, 0.04, 0.06, 'sine');
    this.playNoise(now, 0.02, 6000, 1.6, 0.04, 'highpass');
  }

  // ── Loop / mix helpers ───────────────────────────────────────────
  private makeNoiseLoop(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): LoopVoice {
    const ctx = this.ctx as AudioContext;
    const source = ctx.createBufferSource();
    source.buffer = this.noise as AudioBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    source.start();
    return { source, gain, filter };
  }

  private addGainTremolo(gain: GainNode, rate: number, depth: number): { lfo: OscillatorNode; lfoGain: GainNode } {
    const ctx = this.ctx as AudioContext;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = depth;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    lfo.start();
    return { lfo, lfoGain };
  }

  private ramp(param: AudioParam, value: number, time = 0.3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    param.linearRampToValueAtTime(value, ctx.currentTime + time);
  }

  /** Sidechain-ish duck of every ambient bed for a boom. depth ~0.5 ≈ -6dB. */
  private duckBeds(depth = 0.5, hold = 0.5, recover = 0.3): void {
    const ctx = this.ctx;
    const bus = this.busBed;
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    const g = bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(depth, now + 0.03);
    g.setValueAtTime(depth, now + hold);
    g.linearRampToValueAtTime(1, now + hold + recover);
  }

  // ── Primitives ───────────────────────────────────────────────────
  /**
   * @param attack optional attack time in seconds (default 0). Use a small attack to soften
   *   transients on tonal sounds so they don't click; leave at 0 for percussive ones.
   */
  private playTone(
    when: number,
    fromFreq: number,
    toFreq: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    attack = 0,
    dest?: AudioNode,
  ): void {
    const ctx = this.ctx;
    const dry = this.busDry;
    const wet = this.busReverb;
    if (!ctx || !dry || !wet) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromFreq, when);
    if (toFreq !== fromFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), when + duration);
    }
    if (attack > 0) {
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), when + Math.min(attack, duration * 0.5));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    } else {
      gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    }
    osc.connect(gain);
    gain.connect(dest ?? dry);
    // Send a small portion to reverb for spatial glue
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.35;
    gain.connect(wetGain);
    wetGain.connect(wet);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  private playNoise(
    when: number,
    duration: number,
    frequency: number,
    q: number,
    volume: number,
    filterType: BiquadFilterType,
    dest?: AudioNode,
  ): void {
    const ctx = this.ctx;
    const dry = this.busDry;
    const wet = this.busReverb;
    const noise = this.noise;
    if (!ctx || !dry || !wet || !noise) return;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, when);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest ?? dry);
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.25;
    gain.connect(wetGain);
    wetGain.connect(wet);
    source.start(when);
    source.stop(when + duration + 0.05);
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 1.6);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** Cheap procedural reverb — exponentially-decaying noise impulse. */
  private createReverbImpulse(ctx: AudioContext, durationSeconds: number, decay: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds));
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Random sign with exponential decay envelope
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buffer;
  }
}
