import * as THREE from 'three';
import type { Vec3 } from '../../shared/types/index.js';

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

  playWoodPlank(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Heavy mallet-on-board: stiff transient, woody body resonance, low thud.
    this.playNoise(now, 0.05, 1800, 1.2, 0.25, 'bandpass');
    this.playTone(now, 240, 110, 0.16, 0.32, 'triangle', 0.005);
    this.playTone(now + 0.005, 165, 78, 0.22, 0.28, 'triangle');
    this.playTone(now + 0.04, 92, 60, 0.18, 0.18, 'sine');
    this.playNoise(now, 0.12, 360, 0.9, 0.16, 'lowpass');
    // Hammer ring
    this.playTone(now, 1320, 880, 0.06, 0.06, 'square');
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
  playCannonFire(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Muzzle crack, low pressure wave, carriage thump, and a short smoky tail.
    this.playNoise(now, 0.045, 5200, 0.8, 0.34, 'highpass');
    this.playTone(now, 104, 34, 0.48, 0.54, 'sawtooth', 0.003);
    this.playTone(now + 0.018, 58, 29, 0.68, 0.34, 'sine', 0.006);
    this.playNoise(now, 0.34, 180, 0.7, 0.54, 'lowpass');
    this.playNoise(now + 0.012, 0.3, 1450, 0.95, 0.3, 'bandpass');
    this.playNoise(now + 0.06, 0.18, 320, 1.1, 0.18, 'bandpass');
    this.playTone(now + 0.06, 82, 56, 0.22, 0.2, 'triangle', 0.01);
    this.playNoise(now + 0.18, 0.62, 420, 0.42, 0.2, 'lowpass');
  }

  // ── Water ────────────────────────────────────────────────────────
  playSplash(intensity: number): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(intensity, 0.1, 1.5);
    this.playNoise(now, 0.26, 4600, 0.45, 0.36 * volume, 'highpass');
    this.playNoise(now + 0.025, 0.42, 980, 0.75, 0.38 * volume, 'bandpass');
    this.playNoise(now + 0.08, 0.55, 260, 0.55, 0.22 * volume, 'lowpass');
    this.playTone(now + 0.018, 210, 72, 0.32, 0.15 * volume, 'triangle');
    this.playTone(now + 0.1, 92, 55, 0.44, 0.12 * volume, 'sine', 0.03);
    for (let i = 0; i < 5; i++) {
      const at = now + 0.18 + i * 0.055;
      this.playTone(at, 980 + i * 190, 1500 + i * 240, 0.05, 0.038 * volume, 'sine');
      this.playNoise(at, 0.04, 5200 + i * 260, 1.35, 0.045 * volume, 'highpass');
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

  playSwimSplash(amount = 1): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(amount, 0.2, 1.1);
    // Smaller hand/shoulder splash for swimming movement.
    this.playNoise(now, 0.16, 3600, 0.7, 0.09 * volume, 'highpass');
    this.playNoise(now + 0.02, 0.22, 720, 0.85, 0.11 * volume, 'bandpass');
    this.playNoise(now + 0.08, 0.24, 220, 0.45, 0.055 * volume, 'lowpass');
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
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
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
      gain.connect(master);
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
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
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
      gain.connect(master);
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
    const dry = this.busDry;
    const wet = this.busReverb;
    const noise = this.noise;
    if (!ctx || !dry || !wet || !noise) return;
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
      gain.connect(dry);
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
    gain.connect(dry);
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
    gain.connect(dry);
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
