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

/** Extra LFOs/filters some beds carry (wave swell, flooding slosh). */
interface RichLoopVoice extends LoopVoice {
  filter2?: BiquadFilterNode;
  lfo2?: OscillatorNode;
  lfoGain2?: GainNode;
  lfo3?: OscillatorNode;
  lfoGain3?: GainNode;
}

/** Anything with x/y/z — accepts a THREE.Vector3 or a wire {@link Vec3}. */
type SoundPos = Vec3 | THREE.Vector3;

/** Options for the spatial one-shot dispatcher. */
interface SpatialOpts {
  /** Extra intensity/size multiplier (splashes, explosions). Default 1. */
  intensity?: number;
  /** World position of the source — enables stereo panning when the listener pose is known. */
  pos?: SoundPos;
}

/** Kinds routed through {@link SoundEngine.playAt}. */
type SpatialKind =
  | 'cannonFire'
  | 'cannonballWhistle'
  | 'hullImpact'
  | 'splashSmall'
  | 'splashLarge'
  | 'chainshotWhirr'
  | 'sailRip'
  | 'kegFuse'
  | 'kegExplosion'
  | 'bodyThud';

/** Ground material under a footstep. */
export type FootstepSurface = 'deck' | 'sand' | 'stone' | 'grass';

/** Black-powder firearm families (each gets its own crack/body/tail balance). */
export type GunshotKind = 'flintlock' | 'blunderbuss' | 'flintknock' | 'longRifle';

/** Non-cannon projectile launches (cannonballs go through {@link SoundEngine.playCannonFire}). */
type LaunchKind = 'firebomb' | 'chainshot' | 'tsunami';

/** Projectile terminal impacts on a solid. */
type ImpactKind = 'cannonball' | 'firebomb' | 'bullet';

/** Reverb character. `cave` is the long, dark interior tail. */
type ReverbSpace = 'outdoor' | 'cave';

/** Per-kind one-shot rate limits: [max starts, window ms]. Bursts past this are dropped. */
const KIND_LIMITS: Record<string, [number, number]> = {
  cannonFire: [3, 80],
  gunshot: [5, 90],
  launch: [4, 120],
  splash: [4, 150],
  hullImpact: [3, 100],
  impact: [5, 120],
  footstep: [6, 200],
  creak: [2, 500],
  whistle: [3, 250],
  clang: [4, 120],
  chirp: [12, 500],
};

/** Hard ceiling on primitive voices started inside one 120 ms window. */
const VOICE_BUDGET = 320;
const VOICE_WINDOW_MS = 120;

/** Seconds the music scheduler batches ahead of the clock. */
const MUSIC_LOOKAHEAD = 1.2;
/**
 * Music bus level per context. The menu is the loudest the score ever gets and
 * even that lands around −20 dBFS — roughly a UI click, an order of magnitude
 * under a broadside. At sea it's quieter still, because out there the music is
 * competing with a world that has something to say.
 */
const MUSIC_MENU_LEVEL = 0.52;
const MUSIC_WORLD_LEVEL = 0.34;
/** Metres at which the tavern jig fades to nothing. */
const TAVERN_MUSIC_RANGE = 26;
/**
 * Metres at which the Gilded Wreck stops being audible.
 *
 * She is the mid-match convergence mark and she had exactly ONE sound in her
 * life: three tolls at the instant she rose, and then silence for the whole
 * fight over her. 120 m is deliberately further than any prop bed in the game
 * (the tavern carries 26) because she is a SEA mark — at 120 m a sloop under
 * sail is still fifteen seconds out, which is long enough for "I can hear her"
 * to become "I am steering at her" without the chart.
 */
const WRECK_AMBIENCE_RANGE = 120;
/** Seconds between her bell's slow tolls once you are inside that range. */
const WRECK_TOLL_PERIOD = 11;

// ══ Procedural shanty grammar ══════════════════════════════════════
// Everything below the divider is PURE — no AudioContext, no engine state — so
// the tune generator can be exercised by a logic suite without a browser.

/**
 * Which musical world the mix is in.
 * - `menu`  — the wistful concertina air, looping with a freshly-generated melody.
 * - `world` — nothing plays continuously. Only the tavern jig (spatialized from
 *   the building) and the rare sailing whistle surface, and both duck away.
 * - `none`  — every melodic voice fades out.
 */
export type MusicContext = 'none' | 'menu' | 'world';

/**
 * The three modes a sea tune actually lives in, as semitones from the tonic.
 * Dorian is the wistful one (minor with a RAISED sixth — "Drunken Sailor",
 * "Scarborough Fair"), mixolydian the cheerful one (major with a FLAT seventh)
 * that jigs are built out of, aeolian the plain minor a sting falls back to.
 * None of them has a leading tone, which is precisely why they sound old
 * instead of classical: there is no half-step shove into the tonic.
 */
export const SHANTY_MODES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
} as const;

export type ShantyMode = keyof typeof SHANTY_MODES;

/** One melodic event, measured in BEATS (an eighth note in 6/8) from bar 1. */
export interface ShantyNote {
  /** Onset in beats. Negative for the pickup notes that lean into bar 1. */
  beat: number;
  /** Length in beats. */
  beats: number;
  /** Scale-step index from the tonic; 7 is the octave, -1 the subtonic below. */
  degree: number;
  /** 0..1 metric weight — downbeats push, off-beats and pickups lean back. */
  accent: number;
}

/** A generated tune: melody, the chord floor under it, and how to read both. */
export interface ShantyPhrase {
  /** Sorted by onset. Pickup notes (beat < 0) come first. */
  notes: ShantyNote[];
  bars: number;
  beatsPerBar: number;
  mode: ShantyMode;
  /** MIDI note the degrees are measured from. */
  rootMidi: number;
  /** Scale-step index of the chord root under each bar. */
  chords: number[];
  /** Beats of anacrusis before bar 1 (the pickup notes' span). */
  pickupBeats: number;
}

export interface ShantyOptions {
  mode?: ShantyMode;
  bars?: number;
  beatsPerBar?: number;
  rootMidi?: number;
  /** `air` favours long values and a slow arc; `jig` favours running eighths. */
  style?: 'air' | 'jig';
  pickup?: number;
}

/**
 * Bar-length rhythm vocabularies, in eighth-note beats summing to 6 (i.e. 6/8).
 * A jig is mostly running eighths broken by a dotted quarter; an air breathes in
 * halves and dotted quarters. Drawing whole BARS (rather than note-by-note) is
 * what keeps generated tunes metric instead of arrhythmic mush.
 */
const JIG_BARS: ReadonlyArray<readonly number[]> = [
  [1, 1, 1, 1, 1, 1], [1, 1, 1, 3], [3, 1, 1, 1], [2, 1, 3], [3, 3],
  [1, 1, 1, 1, 2], [2, 2, 2], [1, 2, 3], [2, 1, 1, 1, 1], [1, 1, 1, 2, 1],
];
const AIR_BARS: ReadonlyArray<readonly number[]> = [
  [3, 3], [6], [4, 2], [2, 4], [2, 2, 2], [3, 2, 1], [1, 2, 3], [2, 1, 3],
  [4, 1, 1], [3, 1, 2],
];

/**
 * Melodic step weights. Folk melody is overwhelmingly stepwise; the ±3/±4 leaps
 * are seasoning, and the single 0 lets a note repeat (which is what makes a
 * phrase feel sung rather than scale-run).
 */
const MELODY_STEPS = [-3, -2, -1, -1, -1, 0, 1, 1, 1, 2, 3, 4];

/** i – VII – IV – i: the entire harmonic language of modal folk, as scale steps. */
const CHORD_CYCLE = [0, 0, 6, 6, 3, 3, 4, 0];

/** Deterministic 32-bit PRNG — same seed, same tune, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MIDI note number → Hz. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Scale-step index → MIDI, wrapping octaves correctly for negative degrees.
 * Degree 7 is the octave above the tonic, -1 the subtonic below it.
 */
export function degreeToMidi(rootMidi: number, degree: number, mode: ShantyMode): number {
  const scale = SHANTY_MODES[mode];
  const octave = Math.floor(degree / scale.length);
  const step = degree - octave * scale.length;
  return rootMidi + octave * 12 + scale[step];
}

/**
 * Generate one tune from a seed.
 *
 * The grammar works on BAR PAIRS in the oldest shape there is — A A′ B A″ —
 * because that (not note-level Markov noise) is what makes a melody sound
 * remembered. A is invented; A′ re-uses A's rhythm with a re-walked contour; B
 * is a fresh contrasting pair pitched higher; A″ returns to A and is rewritten
 * into a cadence that lands on the tonic on a long note. Pickup notes lean into
 * bar 1 from below, and every bar's first note is pulled onto a tone of that
 * bar's chord so the melody and the drone agree.
 */
export function generateShantyPhrase(seed: number, opts: ShantyOptions = {}): ShantyPhrase {
  const rng = mulberry32(seed >>> 0);
  const style = opts.style ?? 'air';
  const bars = Math.max(2, Math.round(opts.bars ?? 8));
  const beatsPerBar = Math.max(2, Math.round(opts.beatsPerBar ?? 6));
  const mode = opts.mode ?? (style === 'jig' ? 'mixolydian' : 'dorian');
  const rootMidi = opts.rootMidi ?? 62;
  const vocab = style === 'jig' ? JIG_BARS : AIR_BARS;
  const pickupBeats = Math.max(0, Math.round(opts.pickup ?? (style === 'air' ? 2 : 1)));

  const chords: number[] = [];
  for (let b = 0; b < bars; b++) chords.push(CHORD_CYCLE[b % CHORD_CYCLE.length]);

  const pick = <T,>(list: ReadonlyArray<T>): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

  /** Fit a bar-vocabulary entry to this bar length (scale/trim/pad the last value). */
  const fitRhythm = (source: readonly number[]): number[] => {
    const out = source.slice();
    let total = out.reduce((s, v) => s + v, 0);
    while (total > beatsPerBar && out.length > 1) { total -= out.pop() as number; }
    if (total < beatsPerBar) out[out.length - 1] += beatsPerBar - total;
    return out;
  };

  const pairCount = Math.ceil(bars / 2);
  /** Rhythm for every bar, laid out pair by pair (A A′ B A″ re-uses rhythms). */
  const rhythms: number[][] = [];
  for (let p = 0; p < pairCount; p++) {
    const isReturn = p > 0 && p % 2 === 1;             // A′ / A″ re-use A's feet
    for (let i = 0; i < 2; i++) {
      const bar = p * 2 + i;
      if (bar >= bars) break;
      if (isReturn && rhythms[i]) rhythms.push(rhythms[i].slice());
      else rhythms.push(fitRhythm(pick(vocab)));
    }
  }

  // Contrasting middle pair sits a third higher — the "B" lift.
  const lift = (bar: number): number => (pairCount > 2 && Math.floor(bar / 2) === pairCount - 2 ? 2 : 0);

  const notes: ShantyNote[] = [];
  let cursor = 0;
  let firstDegree = 0;
  for (let bar = 0; bar < bars; bar++) {
    const rhythm = rhythms[bar] ?? fitRhythm(pick(vocab));
    const chord = chords[bar];
    const isLastBar = bar === bars - 1;
    let beatInBar = 0;
    for (let i = 0; i < rhythm.length; i++) {
      const beats = rhythm[i];
      if (i === 0) {
        // Land the downbeat on a tone of this bar's chord (root or its third).
        const target = chord + (rng() < 0.35 ? 2 : 0) + lift(bar);
        // Move to the nearest octave-equivalent of the target so the line
        // doesn't jump an octave every bar.
        let candidate = target;
        while (candidate - cursor > 3.5) candidate -= 7;
        while (cursor - candidate > 3.5) candidate += 7;
        cursor = rng() < 0.75 ? candidate : cursor + pick(MELODY_STEPS);
      } else {
        cursor += pick(MELODY_STEPS);
      }
      cursor = Math.max(-3, Math.min(10, cursor));
      if (isLastBar && i === rhythm.length - 1) cursor = 0;                 // cadence: home
      else if (isLastBar && i === rhythm.length - 2) cursor = rng() < 0.5 ? 1 : -1; // approach it
      const beat = bar * beatsPerBar + beatInBar;
      const accent = beatInBar === 0 ? 1 : (beatInBar * 2 === beatsPerBar ? 0.75 : 0.5);
      notes.push({ beat, beats, degree: cursor, accent });
      if (bar === 0 && i === 0) firstDegree = cursor;
      beatInBar += beats;
    }
  }

  // Anacrusis: one or two rising notes stolen from the bar before, aimed at the
  // first melody note from underneath. A tune that starts flat on the downbeat
  // sounds typed; a pickup sounds breathed in.
  const pickupNotes: ShantyNote[] = [];
  for (let i = 0; i < pickupBeats; i++) {
    const away = pickupBeats - i;   // beats before the downbeat
    pickupNotes.push({
      beat: -away,
      beats: 1,
      degree: Math.max(-3, firstDegree - away * 2),
      accent: 0.4,
    });
  }
  notes.unshift(...pickupNotes);

  return { notes, bars, beatsPerBar, mode, rootMidi, chords, pickupBeats };
}

/** Shared engine instance — see {@link getSharedSoundEngine}. */
let sharedEngine: SoundEngine | null = null;

/**
 * The SoundEngine the game is driving (the most recently constructed one).
 * CombatFx routes its combat audio through this so there is exactly ONE
 * AudioContext, and the volume slider / mute toggle / master compressor apply
 * to gunshots and explosions too. Returns null before Game constructs one.
 */
export function getSharedSoundEngine(): SoundEngine | null {
  return sharedEngine;
}

/**
 * Procedural sound engine — synthesizes every effect from oscillators + filtered
 * noise so the game ships with zero audio assets. It owns the ONLY AudioContext
 * in the client; CombatFx delegates its combat sounds here.
 *
 * The signal graph is:
 *   voice → [spatial lowpass → stereo pan] → busDry ┐
 *   ambience loops ──────────────────────→ busBed  ├→ worldFilter → master → compressor → destination
 *   post-distance sends → busReverb → convolver(outdoor|cave) ┘
 *
 * `worldFilter` is the submerged muffle; `busBed` lets booms duck the ambience.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private busDry: GainNode | null = null;
  private busReverb: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  /** Master tone shaping for the whole world — swept down when the listener submerges. */
  private worldFilter: BiquadFilterNode | null = null;
  private convolver: ConvolverNode | null = null;
  private convolverCave: ConvolverNode | null = null;
  private wetOutdoor: GainNode | null = null;
  private wetCave: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private masterVolume = 0.55;
  private muted = false;
  private wind: LoopVoice | null = null;
  private waveBed: RichLoopVoice | null = null;
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
  // World ambience beds (driven by setAmbience)
  private breaker: LoopVoice | null = null;
  private rainPatter: LoopVoice | null = null;
  private rainBody: LoopVoice | null = null;
  private submergedBed: LoopVoice | null = null;
  private nextGullAt = 0;
  private nextThunderAt = 0;
  // Interior flooding slosh (single instance)
  private flooding: RichLoopVoice | null = null;
  // Per-burning-ship fire crackle loops (capped at 2; oldest is stolen)
  private readonly fires = new Map<string, LoopVoice>();
  // Nearest-waterfall bed (single voice; the environment picks the fall)
  private waterfallBed: RichLoopVoice | null = null;

  // ── Music (see the "Procedural shanty" section) ────────────────────
  /** Music sums here BEFORE the duck, so one gain sets the whole score's level. */
  private busMusic: GainNode | null = null;
  /** Sidechain node — combat and weather push the music down through this. */
  private musicDuck: GainNode | null = null;
  private musicSend: GainNode | null = null;
  /** Spatial chain for the tavern jig: distance lowpass → pan → level → busMusic. */
  private tavernChain: { input: BiquadFilterNode; panner: StereoPannerNode; gain: GainNode } | null = null;
  /** Fireplace bed inside the tavern (ambience, not music — it rides busBed). */
  private tavernHearth: LoopVoice | null = null;
  private musicContext: MusicContext = 'none';
  private musicTimer: number | null = null;
  /** Per-session tune seed — two sessions never hear the identical melody. */
  private musicSeed = (Math.random() * 0x7fffffff) | 0;
  private menuLoopIndex = 0;
  private menuNextLoopAt = 0;
  private tavernLoopIndex = 0;
  private tavernNextLoopAt = 0;
  private sailLoopIndex = 0;
  private sailNextAt = 0;
  private nextHearthPopAt = 0;
  /** ctx.currentTime past which combat still counts as hot (motif stays away). */
  private combatHeatUntil = 0;
  private tavernDistance: number | null = null;
  private tavernPos: SoundPos | null = null;

  // ── The Gilded Wreck's own voice ───────────────────────────────────
  /** Spatial chain for her bed: creak/groan → distance lowpass → pan → level. */
  private wreckChain: { input: BiquadFilterNode; panner: StereoPannerNode; gain: GainNode } | null = null;
  /** Hull groan: the slow, low working of a hulk awash. */
  private wreckGroan: LoopVoice | null = null;
  /** Rigging creak: the dry, higher rope-and-timber layer over the groan. */
  private wreckCreak: LoopVoice | null = null;
  private wreckDistance: number | null = null;
  private wreckPos: SoundPos | null = null;
  /** ctx.currentTime of her next slow toll (0 = ring the moment she is heard). */
  private nextWreckTollAt = 0;
  private stormLevel = 0;
  private nearShore01 = 0;
  private underway01 = 0;

  // ── Listener pose (drives stereo panning) ──────────────────────────
  private readonly listenerPos = new THREE.Vector3();
  /** Unit forward in XZ. Panning stays centred until a pose is supplied. */
  private readonly listenerFwd = new THREE.Vector3(0, 0, -1);
  private listenerKnown = false;

  // ── World state ────────────────────────────────────────────────────
  private submerged01 = 0;
  private caveAmount = 0;
  private rainLevel = 0;
  private aboardShip = false;
  private lastAmbienceTick = 0;

  // ── Schedulers (lookahead batches, driven per frame by setAmbience) ─
  private cricketLevel = 0;
  private readonly cricketVoices = [
    { nextAt: 0, pan: -0.45, base: 4200 },
    { nextAt: 0, pan: 0.5, base: 4550 },
  ];
  private nextRainDropAt = 0;
  private nextBubbleAt = 0;
  private nextCreakAt = 0;
  private lastHeel = 0;
  private lastHeelAt = 0;

  // ── Voice management ───────────────────────────────────────────────
  private readonly kindLog = new Map<string, number[]>();
  private readonly voiceStamps: number[] = [];
  /** Nodes that already carry their own reverb send — nested voices must not add one. */
  private readonly ownSendNodes = new WeakSet<AudioNode>();

  constructor() {
    // CombatFx (and anything else outside Game's reach) resolves the engine here.
    sharedEngine = this;
  }

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

      // World filter — wide open above water, swept down to a muffle when submerged.
      this.worldFilter = ctx.createBiquadFilter();
      this.worldFilter.type = 'lowpass';
      this.worldFilter.frequency.value = 20000;
      this.worldFilter.Q.value = 0.4;
      this.worldFilter.connect(this.master);

      // Wet (reverb) bus — two parallel convolvers so the space can crossfade
      // between open air and cave without swapping a live buffer (which clicks).
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this.createReverbImpulse(ctx, 1.6, 2.6);
      this.convolverCave = ctx.createConvolver();
      this.convolverCave.buffer = this.createReverbImpulse(ctx, 2.8, 3.5);
      this.wetOutdoor = ctx.createGain();
      this.wetOutdoor.gain.value = 1;
      this.wetCave = ctx.createGain();
      this.wetCave.gain.value = 0;
      this.busReverb = ctx.createGain();
      this.busReverb.gain.value = 0.22;
      this.busReverb.connect(this.wetOutdoor);
      this.busReverb.connect(this.wetCave);
      this.wetOutdoor.connect(this.convolver);
      this.wetCave.connect(this.convolverCave);
      this.convolver.connect(this.worldFilter);
      this.convolverCave.connect(this.worldFilter);

      this.busDry = ctx.createGain();
      this.busDry.gain.value = 1;
      this.busDry.connect(this.worldFilter);

      // Ambient bed bus — looped ambience routes through here so booms can duck it.
      this.busBed = ctx.createGain();
      this.busBed.gain.value = 1;
      this.busBed.connect(this.worldFilter);

      // Music bus. It sits BEHIND the world (post-worldFilter, so it muffles
      // when you go under) and behind its own duck node, which combat and
      // weather pull down. Music is flavour: it never fights the mix.
      this.busMusic = ctx.createGain();
      this.busMusic.gain.value = 0;
      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = 1;
      this.busMusic.connect(this.musicDuck);
      this.musicDuck.connect(this.worldFilter);
      // One generous send for the whole score — a concertina in a taproom, not
      // in a laboratory. Tapped post-duck so a ducked tune loses its tail too.
      this.musicSend = ctx.createGain();
      this.musicSend.gain.value = 0.34;
      this.musicDuck.connect(this.musicSend);
      this.musicSend.connect(this.busReverb);
      // Notes routed straight at the music bus must not add a second send.
      this.ownSendNodes.add(this.busMusic);

      this.noise = this.createNoiseBuffer(ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    // First gesture just landed (or the context was already live) — arm the
    // score. Nothing is SCHEDULED until the context actually reports 'running',
    // so a suspended context can never bank up a batch that dumps at once.
    if (this.musicContext !== 'none') this.startMusicTimer();
  }

  setVolume(volume: number): void {
    this.masterVolume = THREE.MathUtils.clamp(volume, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.masterVolume;
  }

  // ── Listener pose / world acoustics ──────────────────────────────
  /**
   * Tell the engine where the ears are. Until this is called every 3D one-shot
   * stays centred (distance still applies).
   * @param position listener world position (camera).
   * @param forward  look direction (any length) OR a yaw in radians where 0 = -Z.
   */
  setListenerPose(position: SoundPos, forward: SoundPos | number): void {
    this.listenerPos.set(position.x, position.y, position.z);
    if (typeof forward === 'number') {
      this.listenerFwd.set(-Math.sin(forward), 0, -Math.cos(forward));
    } else {
      this.listenerFwd.set(forward.x, 0, forward.z);
      if (this.listenerFwd.lengthSq() < 1e-6) this.listenerFwd.set(0, 0, -1);
      this.listenerFwd.normalize();
    }
    this.listenerKnown = true;
  }

  /** Convenience wrapper for a THREE camera. */
  setListenerFromCamera(camera: THREE.Camera): void {
    const fwd = camera.getWorldDirection(SoundEngine.tmpFwd);
    this.setListenerPose(camera.position, fwd);
  }

  private static readonly tmpFwd = new THREE.Vector3();

  /**
   * Submerge the whole mix: sweeps the master lowpass down, drops the reverb, and
   * fades in a bubbling underwater bed. Call per frame with the head-below-surface
   * depth (metres or 0..1) — or just true/false.
   */
  setSubmerged(submerged: boolean | number): void {
    const target = typeof submerged === 'number'
      ? THREE.MathUtils.clamp(submerged / 1.6, 0, 1)
      : (submerged ? 1 : 0);
    // Called per frame — only re-automate when the depth actually moved.
    if (Math.abs(target - this.submerged01) < 0.02) return;
    this.submerged01 = target;
    const ctx = this.ctx;
    if (!ctx || !this.worldFilter || !this.busReverb) return;
    const under = target > 0.05;
    const cutoff = under ? THREE.MathUtils.lerp(620, 300, target) : 20000;
    this.ramp(this.worldFilter.frequency, cutoff, 0.12);
    this.ramp(this.busReverb.gain, under ? 0.04 : 0.22 + this.caveAmount * 0.23, 0.14);
    this.setSubmergedBed(under ? THREE.MathUtils.clamp(0.4 + target * 0.6, 0, 1) : 0);
    // The surfacing splash belongs to the swim code that owns the stroke cadence —
    // firing one here too would double it.
  }

  /**
   * Blend the reverb between open air and a cave/interior tail.
   * @param space  'cave' or 'outdoor'
   * @param amount 0..1 blend toward that space (default 1).
   */
  setReverbSpace(space: ReverbSpace, amount = 1): void {
    const cave = THREE.MathUtils.clamp(space === 'cave' ? amount : 1 - amount, 0, 1);
    this.caveAmount = cave;
    if (!this.ctx || !this.wetCave || !this.wetOutdoor || !this.busReverb) return;
    this.ramp(this.wetCave.gain, cave, 0.5);
    this.ramp(this.wetOutdoor.gain, 1 - cave, 0.5);
    if (this.submerged01 <= 0.05) this.ramp(this.busReverb.gain, 0.22 + cave * 0.23, 0.5);
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
    // Spade clang — inharmonic so the blade rings like steel, not a synth blip.
    this.metalClang(now + 0.004, 1850, 0.5, undefined, 0.5);
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
  playTreeFallThud(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 110) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.26);
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
  playSharkGrowl(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 90) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.2);
    this.playTone(now, 70, 50, 0.5, 0.34 * g, 'sawtooth', 0.05, dest);
    this.playTone(now + 0.03, 46, 34, 0.46, 0.22 * g, 'triangle', 0.06, dest);
    this.playNoise(now, 0.5, 180, 0.8, 0.24 * g, 'lowpass', dest);
  }

  /** Lunge bite — sharp noise snap over two low body tones. */
  playSharkChomp(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 90) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.2);
    this.playNoise(now, 0.05, 2600, 1.6, 0.3 * g, 'bandpass', dest);
    this.playNoise(now + 0.01, 0.09, 700, 1.0, 0.26 * g, 'lowpass', dest);
    this.playTone(now, 150, 70, 0.12, 0.3 * g, 'triangle', 0.002, dest);
    this.playTone(now + 0.05, 95, 48, 0.18, 0.24 * g, 'sine', 0.004, dest);
  }

  /** Shark killed — wet gurgling thrash that sinks away. */
  playSharkDeath(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 160) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.24);
    // Thrashing water.
    this.playNoiseCurve(now, 0.42, [[0, 520], [0.42, 260]], 0.55, 0.5 * g, 'lowpass', 0.01, dest);
    this.playNoise(now + 0.02, 0.3, 1900, 0.8, 0.16 * g, 'bandpass', dest);
    // Dying growl — falling, not rising.
    this.playTone(now + 0.02, 190, 74, 0.44, 0.26 * g, 'sawtooth', 0.02, dest);
    this.playTone(now + 0.04, 88, 46, 0.5, 0.18 * g, 'triangle', 0.04, dest);
    // Bubbles as it rolls under.
    for (let i = 0; i < 4; i++) {
      const at = now + 0.22 + i * 0.09 + Math.random() * 0.05;
      this.playTone(at, 180 + Math.random() * 240, 700, 0.06, 0.03 * g, 'sine', 0.006, dest);
    }
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
    // Hinge squeak train (stick-slip friction), then the latch and the reveal.
    this.squeakTrain(now, 0.4, 900, 1500, 0.075, 5);
    this.playNoise(now, 0.35, 320, 0.7, 0.07, 'lowpass');
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

  /**
   * Dry hinge on an old cabin door. The friction reads through the GAPS between
   * squeaks — a continuous slide sounds like a synth portamento, not a hinge.
   */
  playDoorCreak(opening: boolean): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Squeak train: rising as it swings open, falling as it's pulled shut.
    if (opening) {
      this.playNoise(now, 0.035, 4200, 1.6, 0.12, 'highpass'); // latch lifts first
      this.squeakTrain(now + 0.02, 0.42, 850, 1500, 0.085, 6);
    } else {
      this.squeakTrain(now, 0.34, 1400, 780, 0.08, 5);
      // Frame thud + latch clack as it seats
      this.playTone(now + 0.34, 120, 80, 0.14, 0.2, 'triangle');
      this.playNoise(now + 0.36, 0.04, 3800, 1.5, 0.12, 'highpass');
    }
    // Wood-body groan under the squeaks.
    this.playNoise(now, 0.35, 320, 0.8, 0.07, 'lowpass');
  }

  /**
   * A run of short high-Q noise squeaks with random gaps — the generic
   * stick-slip friction texture (hinges, chest lids, rope through a block).
   */
  private squeakTrain(
    when: number,
    span: number,
    fromFreq: number,
    toFreq: number,
    volume: number,
    count: number,
    dest?: AudioNode,
  ): void {
    let at = when;
    const end = when + span;
    for (let i = 0; i < count && at < end; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      const centre = THREE.MathUtils.lerp(fromFreq, toFreq, t) * (0.92 + Math.random() * 0.16);
      const dur = 0.04 + Math.random() * 0.03;
      this.playNoise(at, dur, centre, 10, volume * (0.7 + Math.random() * 0.5), 'bandpass', dest);
      at += dur + 0.02 + Math.random() * 0.04;
    }
  }

  // ── Combat feedback ──────────────────────────────────────────────
  /**
   * Body hit on YOU. A grunt is a voice: a low sawtooth pushed through two
   * formant bandpasses reads as a throat, where a bare tone reads as a UI beep.
   */
  playPlayerHurt(damage: number): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    this.markCombat();
    const now = this.ctx.currentTime;
    const intensity = THREE.MathUtils.clamp(damage / 50, 0.2, 1);
    const voice = this.makeFormantDest(480, 5, 1150, 6, 0.45, 0.18);
    const base = 135 * (0.9 + Math.random() * 0.2);
    this.playTone(now, base, 88, 0.22, 0.5 * intensity, 'sawtooth', 0.008, voice, 0);
    this.playTone(now + 0.01, base * 1.5, 130, 0.16, 0.22 * intensity, 'triangle', 0.006, voice, 0);
    // Breath forced out.
    this.playNoise(now + 0.05, 0.12, 1200, 0.7, 0.08 * intensity, 'highpass');
    // Impact on the body, not the throat.
    this.playNoise(now, 0.1, 520, 1.0, 0.2 * intensity, 'bandpass');
    // Clarity ping (sine, not square — no damage beep).
    this.playTone(now, 990, 760, 0.07, 0.05 * intensity, 'sine', 0, undefined, 0);
    // Heavier hit = chest-thump body
    if (intensity > 0.6) {
      this.playTone(now, 70, 40, 0.32, 0.28 * intensity, 'sine', 0.02);
    }
  }

  /** Confirmation chirp when YOU land a hit on someone. Dry — no outdoor reverb on chrome. */
  playHitMarker(headshot: boolean): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (headshot) {
      // Sharp ping double-tap
      this.playTone(now, 1760, 2640, 0.1, 0.22, 'square', 0, undefined, 0);
      this.playTone(now + 0.04, 2640, 3300, 0.1, 0.16, 'sine', 0, undefined, 0);
      this.playNoise(now, 0.06, 5000, 1.6, 0.14, 'highpass', undefined, 0);
    } else {
      this.playTone(now, 1100, 1480, 0.08, 0.18, 'triangle', 0, undefined, 0);
      this.playTone(now + 0.02, 1480, 1980, 0.06, 0.12, 'sine', 0, undefined, 0);
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
    this.playNoise(now + 0.04, 0.06, 5800, 1.5, 0.1, 'highpass', undefined, 0);
    // Tonal "doom" tail
    this.playTone(now + 0.18, 165, 110, 0.55, 0.16, 'triangle');
  }

  /**
   * Crisp "that one's down" confirm — sits on top of {@link playKill} for the
   * killfeed moment: a tight double tick and a short brass stab, fully dry so it
   * never smears into the world reverb.
   */
  playKillConfirm(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playNoise(now, 0.03, 6200, 1.4, 0.1, 'highpass', undefined, 0);
    this.playTone(now, 1568, 1568, 0.05, 0.14, 'square', 0, undefined, 0);
    this.playTone(now + 0.05, 2093, 2093, 0.09, 0.12, 'triangle', 0, undefined, 0);
    this.brassNote(now + 0.05, 784, 0.16, 0.16, 0.05);
  }

  /**
   * YOU died — a hard, hollow sting: sub drop, reversed-feeling swell, and a
   * dark bell toll. Deliberately longer and lower than any hit feedback.
   */
  playDeathSting(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Impact + sub drop.
    this.playNoise(now, 0.18, 300, 0.7, 0.4, 'lowpass');
    this.playTone(now, 88, 32, 0.9, 0.42, 'sine', 0.004);
    this.playTone(now + 0.02, 55, 26, 1.3, 0.3, 'sine', 0.02);
    // Dark inharmonic toll.
    this.metalClang(now + 0.06, 294, 0.5, undefined, 2.6);
    // Air leaving the scene.
    this.playNoiseCurve(now + 0.1, 1.2, [[0, 1400], [1.2, 220]], 0.5, 0.16, 'lowpass', 0.08);
    // Last breath.
    const voice = this.makeFormantDest(430, 5, 980, 6, 0.4, 0.3);
    this.playTone(now + 0.08, 120, 62, 0.5, 0.3, 'sawtooth', 0.03, voice, 0);
    this.duckBeds(0.4, 0.7, 0.6);
  }

  /**
   * Quick whoosh as a melee weapon arcs through the air. The bandpass centre
   * sweeps across the arc so the swing has motion instead of a static hiss.
   * @param draw first swing after a weapon switch — adds a faint edge ring.
   */
  playCutlassSwing(draw = false): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Two-stage whoosh: swept body + high-pass leading edge.
    this.playNoiseCurve(now, 0.22, [[0, 600], [0.1, 1400], [0.22, 900]], 1.1, 0.24, 'bandpass', 0.02);
    this.playNoise(now + 0.02, 0.18, 3200, 0.7, 0.18, 'highpass');
    this.playTone(now, 540, 200, 0.2, 0.07, 'sawtooth', 0.02);
    // Only the draw rings — an air swing has no steel-on-steel.
    if (draw) this.playTone(now, 2100, 2040, 0.1, 0.04, 'sine', 0.004);
  }

  /**
   * Parried swing — steel-on-steel CLANG. Metal modes are non-integer, so the
   * ring is an inharmonic partial stack with staggered decays; a harmonic stack
   * would read as a struck tuning fork.
   */
  playSwordBlock(): void {
    this.unlock();
    if (!this.ctx) return;
    if (!this.throttle('clang')) return;
    const now = this.ctx.currentTime;
    const f0 = 1900 + Math.random() * 500;
    this.playNoise(now, 0.008, 5000, 0.8, 0.3, 'highpass');   // impact snap
    this.metalClang(now, f0, 1);                              // ringing steel
    this.playTone(now, 150, 90, 0.08, 0.15, 'triangle', 0.002); // hilt thud
  }

  // ── Firearms ─────────────────────────────────────────────────────
  /**
   * Black-powder firearm report. The loudest layer is a sub-30 ms high-passed
   * CRACK — without that transient any gunshot reads as a damp pop. Under it sit
   * a body thump, a mid snap, and a powder tail whose filter falls away.
   * @param distance metres from the listener (0 = your own weapon).
   */
  playGunshot(kind: GunshotKind = 'flintlock', distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('gunshot')) return;
    this.markCombat();
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.2);
    const v = g;
    // Flash in the pan — the flint striking, just before ignition.
    this.playNoise(now, 0.02, 5000, 1.2, 0.07 * v, 'highpass', dest);
    const at = now + 0.045;
    switch (kind) {
      case 'longRifle': {
        // Long barrel: hardest, brightest crack and a rolling echo tail.
        this.playNoise(at, 0.035, 3000, 0.7, 0.95 * v, 'highpass', dest);
        this.playTone(at, 210, 66, 0.16, 0.5 * v, 'triangle', 0, dest);
        this.playTone(at + 0.006, 84, 46, 0.4, 0.42 * v, 'triangle', 0.004, dest);
        this.playNoise(at + 0.004, 0.07, 1500, 1.2, 0.4 * v, 'bandpass', dest);
        this.playNoiseCurve(at + 0.03, 0.6, [[0, 1600], [0.6, 240]], 0.55, 0.34 * v, 'lowpass', 0, dest);
        this.playTone(at + 0.16, 240, 130, 0.26, 0.1 * v, 'sine', 0.02, dest);
        break;
      }
      case 'blunderbuss': {
        // Shotgun roar: wider mid snap and a second, lower body.
        this.playNoise(at, 0.05, 2000, 0.7, 0.85 * v, 'highpass', dest);
        this.playTone(at, 230, 72, 0.14, 0.5 * v, 'triangle', 0, dest);
        this.playTone(at + 0.004, 150, 55, 0.2, 0.5 * v, 'triangle', 0.003, dest);
        this.playNoise(at + 0.004, 0.12, 900, 0.8, 0.42 * v, 'bandpass', dest);
        this.playNoiseCurve(at + 0.03, 0.5, [[0, 1400], [0.5, 240]], 0.5, 0.34 * v, 'lowpass', 0, dest);
        break;
      }
      case 'flintknock': {
        // Short pistol: tighter, higher crack, small body, quick tail.
        this.playNoise(at, 0.02, 3200, 0.8, 0.7 * v, 'highpass', dest);
        this.playTone(at, 260, 90, 0.1, 0.35 * v, 'triangle', 0, dest);
        this.playNoise(at + 0.004, 0.05, 1500, 1.2, 0.32 * v, 'bandpass', dest);
        this.playNoiseCurve(at + 0.025, 0.25, [[0, 1300], [0.25, 280]], 0.5, 0.26 * v, 'lowpass', 0, dest);
        break;
      }
      default: {
        this.playNoise(at, 0.03, 2600, 0.7, 0.85 * v, 'highpass', dest);
        this.playTone(at, 230, 72, 0.13, 0.5 * v, 'triangle', 0, dest);
        this.playNoise(at + 0.004, 0.06, 1350, 1.2, 0.4 * v, 'bandpass', dest);
        this.playNoiseCurve(at + 0.03, 0.47, [[0, 1400], [0.47, 260]], 0.5, 0.32 * v, 'lowpass', 0, dest);
        break;
      }
    }
    // Soft slapback off nearby geometry — only when you're close enough to hear it.
    if (distance < 30) this.playNoise(at + 0.14, 0.25, 380, 0.6, 0.1 * v, 'lowpass', dest);
  }

  // ── Cannon (ship broadsides and human cannon launches) ───────────
  /**
   * @param distance metres from the listener. 0 = on top of you (unchanged local feel).
   *   Beyond 140m this becomes a soft, delayed distant thump instead of a sharp crack.
   */
  playCannonFire(distance = 0, pos?: SoundPos): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    if (!this.throttle('cannonFire')) return;
    const now = ctx.currentTime;
    if (distance > 140) {
      this.distantCannonThump(now, distance, pos);
      return;
    }
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.3);
    // Muzzle crack, low pressure wave, carriage thump, and a rolling smoky tail.
    this.playNoise(now, 0.03, 4200, 0.7, 0.5 * g, 'highpass', dest);
    this.playNoise(now, 0.045, 5200, 0.8, 0.34 * g, 'highpass', dest);
    this.playTone(now, 104, 34, 0.48, 0.54 * g, 'sawtooth', 0.003, dest);
    this.playTone(now + 0.018, 58, 29, 0.68, 0.34 * g, 'sine', 0.006, dest);
    this.playNoise(now, 0.34, 180, 0.7, 0.54 * g, 'lowpass', dest);
    this.playNoise(now + 0.012, 0.3, 1450, 0.95, 0.3 * g, 'bandpass', dest);
    this.playNoise(now + 0.06, 0.18, 320, 1.1, 0.18 * g, 'bandpass', dest);
    this.playTone(now + 0.06, 82, 56, 0.22, 0.2 * g, 'triangle', 0.01, dest);
    // Powder tail whose brightness falls away — the smoke rolling off the muzzle.
    this.playNoiseCurve(now + 0.08, 0.7, [[0, 1500], [0.7, 200]], 0.45, 0.26 * g, 'lowpass', 0, dest);
    this.playNoise(now + 0.18, 0.62, 420, 0.42, 0.18 * g, 'lowpass', dest);
    // Ship-shaking sub + bed duck at close range.
    if (distance < 28) {
      const shake = 1 - distance / 28;
      this.playTone(now, 44, 26, 0.7, 0.4 * shake, 'sine', 0.01, dest);
      this.duckBeds(0.5, 0.4, 0.4);
    }
  }

  /** Low, delayed rumble for a cannon fired far away — no sharp transient reaches you. */
  private distantCannonThump(now: number, distance: number, pos?: SoundPos): void {
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    const delay = THREE.MathUtils.clamp(distance / 343, 0.2, 1.2); // ~sound-travel time
    const at = now + delay;
    const g = 1 / (1 + distance / 60); // gentler rolloff for the low thump
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.6;
    this.connectGroup(filter, pos, 0.24);
    this.playTone(at, 70, 40, 0.6, 0.5 * g, 'sine', 0.02, filter);
    this.playTone(at + 0.02, 48, 30, 0.85, 0.4 * g, 'sine', 0.03, filter);
    this.playNoise(at, 0.5, 200, 0.5, 0.3 * g, 'lowpass', filter);
    this.playNoise(at + 0.12, 0.6, 140, 0.4, 0.18 * g, 'lowpass', filter);
  }

  /** Non-cannon projectile launches (firebomb lob, chainshot spin-up, tsunami surge). */
  playProjectileLaunch(kind: LaunchKind, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('launch')) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.26);
    if (kind === 'firebomb') {
      // Pitch-soaked rag catching, then the lob.
      this.playNoise(now, 0.03, 3400, 0.8, 0.4 * g, 'highpass', dest);
      this.playNoiseCurve(now, 0.28, [[0, 1400], [0.28, 500]], 1.0, 0.5 * g, 'bandpass', 0.005, dest);
      this.playTone(now, 180, 88, 0.2, 0.34 * g, 'sawtooth', 0.004, dest);
      this.playNoise(now + 0.05, 0.3, 900, 0.6, 0.16 * g, 'bandpass', dest);
    } else if (kind === 'chainshot') {
      // Two shot halves parting with a chain snap between them.
      this.playNoise(now, 0.025, 3800, 0.9, 0.42 * g, 'highpass', dest);
      this.playTone(now, 210, 96, 0.16, 0.34 * g, 'triangle', 0, dest);
      this.metalClang(now + 0.01, 2600, 0.5 * g, dest, 0.5);
      this.playNoiseCurve(now + 0.02, 0.34, [[0, 1200], [0.34, 620]], 0.9, 0.26 * g, 'bandpass', 0.01, dest);
    } else {
      // Tsunami: a rising wall of water, not a bang.
      this.playNoiseCurve(now, 0.6, [[0, 420], [0.6, 180]], 0.9, 0.8 * g, 'lowpass', 0.06, dest);
      this.playTone(now, 70, 40, 0.55, 0.5 * g, 'sawtooth', 0.08, dest);
      this.playNoise(now + 0.08, 0.5, 2600, 0.6, 0.16 * g, 'highpass', dest);
    }
  }

  /** Projectile terminal impact on a solid (hull hits use {@link playHullImpact}). */
  playProjectileImpact(kind: ImpactKind, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('impact')) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.24);
    if (kind === 'cannonball') {
      // Iron burying itself in earth/timber: crack, thud, and debris rain.
      this.playNoise(now, 0.02, 3600, 1.0, 0.3 * g, 'highpass', dest);
      this.playNoise(now, 0.22, 240, 1.1, 0.72 * g, 'lowpass', dest);
      this.playTone(now, 78, 40, 0.24, 0.44 * g, 'triangle', 0.003, dest);
      for (let i = 0; i < 4; i++) {
        this.playNoise(now + 0.05 + Math.random() * 0.16, 0.04, 1800 + Math.random() * 2200, 2.2, 0.07 * g, 'bandpass', dest);
      }
    } else if (kind === 'firebomb') {
      // Clay shattering into a whoosh of flame.
      this.playNoise(now, 0.03, 4600, 1.4, 0.26 * g, 'highpass', dest);
      this.playNoiseCurve(now, 0.34, [[0, 1300], [0.34, 420]], 1.0, 0.5 * g, 'bandpass', 0.004, dest);
      this.playTone(now, 150, 62, 0.2, 0.28 * g, 'sawtooth', 0.004, dest);
      this.playNoise(now + 0.06, 0.5, 700, 0.5, 0.14 * g, 'lowpass', dest);
    } else {
      // Bullet slap into wood/stone: tick, thud, tiny ricochet.
      this.playNoise(now, 0.012, 5200, 1.2, 0.2 * g, 'highpass', dest);
      this.playNoise(now, 0.08, 850, 0.85, 0.26 * g, 'bandpass', dest);
      this.playTone(now, 190, 90, 0.06, 0.12 * g, 'triangle', 0, dest);
    }
  }

  /** Respawn / revive beacon shimmer at a world position. */
  playRespawnBeacon(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 220) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.4);
    this.playNoiseCurve(now, 0.3, [[0, 900], [0.3, 4200]], 1.1, 0.14 * g, 'bandpass', 0.04, dest);
    this.playTone(now, 240, 360, 0.2, 0.22 * g, 'sine', 0.02, dest);
    this.playTone(now + 0.06, 360, 540, 0.26, 0.18 * g, 'sine', 0.02, dest);
    this.playTone(now + 0.12, 540, 720, 0.3, 0.12 * g, 'triangle', 0.03, dest);
  }

  /** Final-seconds pip of the match countdown: a hard dry tick with a rising
   *  two-note tail, so the last three numbers read as the last three numbers.
   *  Deliberately NOT the respawn beacon — this is UI chrome, not a world event,
   *  so it never spatialises and never fades with distance. */
  playCountdownPip(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playNoise(now, 0.035, 3200, 1.4, 0.09, 'highpass', undefined, 0);
    this.playTone(now, 520, 620, 0.09, 0.16, 'triangle', 0, undefined, 0);
    this.playTone(now + 0.05, 780, 900, 0.13, 0.12, 'sine', 0.01, undefined, 0);
  }

  /** Two-note confirm that YOUR shot landed on an enemy hull. Mostly dry chrome. */
  playShipHitConfirm(distance = 0): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Always audible — this is feedback, not world audio — but distance still colours it.
    const v = Math.max(0.35, 1 / (1 + distance / 90));
    this.playNoise(now, 0.09, 720, 1.1, 0.12 * v, 'bandpass', undefined, 0);
    this.playTone(now, 246, 294, 0.11, 0.16 * v, 'sine', 0, undefined, 0);
    this.playTone(now + 0.035, 369, 440, 0.16, 0.2 * v, 'triangle', 0, undefined, 0);
    this.playTone(now + 0.075, 440, 392, 0.12, 0.12 * v, 'triangle', 0, undefined, 0);
  }

  // ── Water ────────────────────────────────────────────────────────
  /**
   * @param intensity ~0.35 = small plop, ~1.4 = large splash.
   * @param distance metres from the listener (0 = local).
   */
  playSplash(intensity: number, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('splash')) return;
    const now = this.ctx.currentTime;
    const volume = THREE.MathUtils.clamp(intensity, 0.1, 1.5);
    const { dest, gain } = this.makeSpatialDest(distance, pos, 0.22);
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
    // Irregular clank spacing — a metronomic chain reads as a machine, not iron links.
    let at = now;
    for (let i = 0; i < clankCount; i++) {
      this.playNoise(at, 0.055, 2800 + i * 180, 1.6, dropped ? 0.14 : 0.1, 'bandpass');
      this.metalClang(at + 0.004, 2400 + Math.random() * 1000, dropped ? 0.34 : 0.26, undefined, 0.22);
      at += (dropped ? 0.04 : 0.06) + Math.random() * 0.05;
    }
    // Rope running out through the hawse, then the anchor takes the water.
    this.playNoiseCurve(now + 0.1, 0.5, [[0, 1100], [0.5, 520]], 0.6, 0.1, 'bandpass', 0.02);
    if (dropped) this.playSplash(0.9, 6);
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
    this.metalClang(now + 0.026, 2200, 0.4 * volume, undefined, 0.2);
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
    // Spoke ticks — more of them the harder you spin the wheel.
    const ticks = 2 + Math.round(volume * 3);
    for (let i = 0; i < ticks; i++) {
      this.playNoise(now + 0.02 + i * (0.045 + Math.random() * 0.02), 0.015, 2200, 3, 0.04 * volume, 'bandpass');
    }
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
    // Rope squealing through the block.
    this.playNoiseCurve(now + 0.015, 0.09, [[0, 700], [0.09, 900]], 9, 0.05 * volume, 'bandpass', 0.005);
    // Canvas taking the wind.
    this.playNoise(now + 0.06, 0.12, 500, 0.6, 0.1 * volume, 'lowpass');
    this.playTone(now + 0.1, 180, 130, 0.22, 0.06 * volume, 'triangle', 0.03);
  }

  // ── Footsteps ────────────────────────────────────────────────────
  /**
   * One footfall. Surfaces differ mostly in where the friction energy sits:
   * sand is pure broadband friction with no tonal layer, stone is a bright tick,
   * deck adds a tuned plank body, grass is two soft overlapping swishes.
   * @param running  louder + harder heel strike
   * @param distance metres from the listener (0 = your own feet)
   */
  playFootstep(surface: FootstepSurface, running = false, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 30) return;
    if (!this.throttle('footstep')) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.14);
    const v = (running ? 1 : 0.72) * g;
    const j = (): number => 0.88 + Math.random() * 0.24; // ±12% per step
    switch (surface) {
      case 'deck':
        this.playTone(now, 100 * j(), 62, 0.06, 0.14 * v, 'triangle', 0.002, dest);
        this.playNoise(now, 0.07, 320 * j(), 0.8, 0.12 * v, 'lowpass', dest);
        // Every few steps a plank answers back.
        if (Math.random() < 0.25) this.playNoise(now + 0.008, 0.05, 720 * j(), 7, 0.03 * v, 'bandpass', dest);
        break;
      case 'sand':
        this.playNoise(now, 0.09, 950 * j(), 0.8, 0.1 * v, 'bandpass', dest);
        this.playNoise(now + 0.005, 0.08, 260 * j(), 0.7, 0.08 * v, 'lowpass', dest);
        break;
      case 'stone':
        this.playNoise(now, 0.04, 1700 * j(), 1.2, 0.09 * v, 'bandpass', dest);
        this.playNoise(now, 0.012, 4000, 1.0, 0.04 * v, 'highpass', dest);
        this.playTone(now, 140 * j(), 100, 0.04, 0.05 * v, 'triangle', 0.002, dest);
        break;
      default:
        this.playNoise(now, 0.06, 1200 * j(), 0.7, 0.06 * v, 'bandpass', dest);
        this.playNoise(now + 0.025, 0.06, 1200 * j(), 0.7, 0.05 * v, 'bandpass', dest);
        break;
    }
  }

  // ── Match flow ───────────────────────────────────────────────────
  playMatchStart(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Snare roll accelerating into the resolution.
    let at = now;
    let gap = 0.035;
    for (let i = 0; i < 14; i++) {
      this.playNoise(at, 0.05, 1800, 1.0, 0.05 + (i / 13) * 0.09, 'bandpass');
      at += gap;
      gap = Math.max(0.025, gap - 0.0008);
    }
    // Heroic horn fanfare: G3 → D4 → G4 (+ B4 third), brass-ified with detuned saws.
    const roll = at - now;
    this.brassNote(now + roll, 196, 0.26, 0.3);
    this.brassNote(now + roll + 0.18, 294, 0.26, 0.3);
    this.brassNote(now + roll + 0.36, 392, 0.55, 0.34);
    this.brassNote(now + roll + 0.36, 494, 0.55, 0.19);
    this.playNoise(now + roll + 0.36, 0.22, 1800, 0.9, 0.18, 'bandpass');
    // Low bass drop
    this.playTone(now + roll + 0.36, 65, 49, 0.7, 0.22, 'sine', 0.02);
  }

  /** Deep ship's horn — the "match is live" call, under/before the fanfare. */
  playMatchStartHorn(): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, now);
    lp.frequency.linearRampToValueAtTime(1100, now + 0.5);
    lp.Q.value = 0.6;
    this.connectGroup(lp, undefined, 0.4);
    // Two barely-detuned reeds beating against each other = a real horn's growl.
    this.playTone(now, 110, 110, 1.7, 0.3, 'sawtooth', 0.22, lp);
    this.playTone(now, 111.4, 111.4, 1.7, 0.26, 'sawtooth', 0.24, lp);
    this.playTone(now, 55, 55, 1.8, 0.24, 'sine', 0.28, lp);
    this.playTone(now + 0.05, 220, 220, 1.5, 0.08, 'triangle', 0.3, lp);
    // Air moving through the pipe.
    this.playNoise(now, 1.6, 400, 0.5, 0.05, 'lowpass', lp);
  }

  playVictory(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Major arpeggio C5 E5 G5 C6, brass-ified, with octave bass and a pad.
    this.brassNote(now, 523, 0.36, 0.24);
    this.brassNote(now + 0.16, 659, 0.36, 0.24);
    this.brassNote(now + 0.32, 784, 0.36, 0.24);
    this.brassNote(now + 0.48, 1046, 0.85, 0.3);
    // Bass octave under the resolution
    this.playTone(now + 0.48, 261, 261, 0.85, 0.22, 'sine', 0.04);
    // Bright bell on top
    this.playTone(now + 0.48, 1568, 1568, 0.7, 0.14, 'sine');
    this.playTone(now + 0.48, 2093, 2093, 0.55, 0.09, 'sine');
    // Tambourine on the beats.
    for (let i = 0; i < 4; i++) {
      this.playNoise(now + 0.16 * i, 0.02, 6000, 1.2, 0.05, 'highpass');
    }
    // Sustained pad chord (C major)
    this.playTone(now + 0.5, 523, 523, 1.6, 0.08, 'triangle', 0.1);
    this.playTone(now + 0.5, 659, 659, 1.6, 0.08, 'triangle', 0.1);
    this.playTone(now + 0.5, 784, 784, 1.6, 0.08, 'triangle', 0.1);
  }

  playDefeat(): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const ctx = this.ctx;
    // Long descending minor — saws kept dark so it mourns instead of buzzing.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    lp.Q.value = 0.7;
    this.connectGroup(lp, undefined, 0.4);
    this.playTone(now, 392, 392, 0.5, 0.24, 'sawtooth', 0.04, lp);
    this.playTone(now + 0.32, 311, 311, 0.62, 0.26, 'sawtooth', 0.04, lp);
    this.playTone(now + 0.64, 261, 261, 0.78, 0.26, 'sawtooth', 0.04, lp);
    // Drone tail
    this.playTone(now + 0.32, 130, 98, 1.3, 0.22, 'triangle', 0.06);
    this.playTone(now + 0.32, 65, 49, 1.4, 0.18, 'sine', 0.06);
    // Slow bell toll (inharmonic, long decays).
    this.metalClang(now + 0.1, 392, 0.6, undefined, 2.8);
    this.metalClang(now + 1.1, 392, 0.4, undefined, 2.8);
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
    this.metalClang(now, 1760, 0.55, undefined, 0.8);
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
    // Multiple coin clinks in quick succession + high sparkle (dry — it's chrome).
    for (let i = 0; i < 3; i++) {
      const at = now + i * 0.04;
      this.playTone(at, 1500 + i * 180, 1500 + i * 180, 0.04, 0.16, 'sine', 0, undefined, 0);
      this.playTone(at + 0.005, 2400 + i * 200, 2400 + i * 200, 0.05, 0.12, 'sine', 0, undefined, 0);
      this.playNoise(at, 0.04, 5400, 1.6, 0.07, 'highpass', undefined, 0);
    }
    // Subtle weight thump
    this.playTone(now, 220, 110, 0.1, 0.06, 'triangle', 0, undefined, 0);
  }

  // ── UI / chrome (fully dry: reverb on a click muddies the whole UI) ──
  playUiClick(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playTone(now, 1320, 880, 0.04, 0.16, 'square', 0, undefined, 0);
    this.playTone(now + 0.005, 660, 660, 0.05, 0.08, 'triangle', 0, undefined, 0);
    this.playNoise(now, 0.02, 6000, 1.4, 0.04, 'highpass', undefined, 0);
  }

  playUiHover(): void {
    this.unlock();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.playTone(now, 1400, 1600, 0.04, 0.06, 'sine', 0, undefined, 0);
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
      const v = this.makeNoiseLoop('bandpass', 420, 0.8, bed);
      // Slow LFO modulation on filter cutoff for gust feel
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      lfo.connect(lfoGain);
      lfoGain.connect(v.filter.frequency);
      lfo.start();
      this.wind = { ...v, lfo, lfoGain };
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

  /**
   * Always-on calm wave bed — set 0 to disable, 1 for full ambience.
   * Two incommensurate amplitude LFOs plus a slow cutoff LFO give the sea
   * audible swell; a single static filtered-noise loop just hisses.
   */
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
      // Second pole kills the white-noise sizzle (closer to pink).
      const filter2 = ctx.createBiquadFilter();
      filter2.type = 'lowpass';
      filter2.frequency.value = 1200;
      filter2.Q.value = 0.3;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(filter2);
      filter2.connect(gain);
      gain.connect(bed);
      source.start(0, Math.random() * Math.max(0.1, noise.duration - 0.2));
      // Swell: two slow, non-harmonically-related depths so it never loops audibly.
      const swellA = this.addGainTremolo(gain, 0.07, 0.03);
      const swellB = this.addGainTremolo(gain, 0.11, 0.019);
      // Cutoff drift — the sea "breathing" through the mix.
      const fLfo = ctx.createOscillator();
      fLfo.type = 'sine';
      fLfo.frequency.value = 0.05;
      const fLfoGain = ctx.createGain();
      fLfoGain.gain.value = 110;
      fLfo.connect(fLfoGain);
      fLfoGain.connect(filter.frequency);
      fLfo.start();
      this.waveBed = {
        source, gain, filter, filter2,
        lfo: swellA.lfo, lfoGain: swellA.lfoGain,
        lfo2: swellB.lfo, lfoGain2: swellB.lfoGain,
        lfo3: fLfo, lfoGain3: fLfoGain,
      };
    }
    const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
    const target = clamped * 0.085;
    this.waveBed.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.6);
    this.waveBed.filter.frequency.linearRampToValueAtTime(260 + clamped * 360, ctx.currentTime + 0.8);
    this.waveBed.filter.Q.linearRampToValueAtTime(0.32 + clamped * 0.34, ctx.currentTime + 0.8);
    // Bigger seas swell harder.
    if (this.waveBed.lfoGain) this.ramp(this.waveBed.lfoGain.gain, target * 0.35, 0.8);
    if (this.waveBed.lfoGain2) this.ramp(this.waveBed.lfoGain2.gain, target * 0.22, 0.8);
  }

  /**
   * Timber bed under the sailing mix. Deliberately quiet — the articulated
   * creaks are discrete events scheduled from {@link setSailingState}; this only
   * glues them to the hull.
   */
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
      source.start(0, Math.random() * Math.max(0.1, noise.duration - 0.2));
      lfo.start();
      this.hullCreak = { source, gain, filter, lfo, lfoGain };
    }
    const clamped = THREE.MathUtils.clamp(intensity, 0, 1);
    const motionClamped = THREE.MathUtils.clamp(motion, 0, 1);
    this.hullCreak.gain.gain.linearRampToValueAtTime(0.006 + clamped * 0.027, ctx.currentTime + 0.55);
    this.hullCreak.filter.frequency.linearRampToValueAtTime(160 + motionClamped * 190, ctx.currentTime + 0.7);
    this.hullCreak.filter.Q.linearRampToValueAtTime(4.2 + clamped * 2.2, ctx.currentTime + 0.7);
    this.hullCreak.lfo.frequency.linearRampToValueAtTime(0.1 + motionClamped * 0.28, ctx.currentTime + 0.7);
    this.hullCreak.lfoGain.gain.linearRampToValueAtTime(55 + clamped * 115, ctx.currentTime + 0.7);
  }

  /**
   * One articulated timber creak — stick-slip in a swept high-Q band, plus a
   * sub thump where the frame takes the load.
   */
  private playHullCreakEvent(strain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    if (!this.throttle('creak')) return;
    const now = ctx.currentTime;
    const rising = Math.random() < 0.65;
    const dur = 0.5 + Math.random() * 0.4;
    const centre = 170 + Math.random() * 40;
    const dest = this.makePanGroup((Math.random() * 2 - 1) * 0.35, 0.3);
    const vol = 0.05 + strain * 0.04;
    this.playNoiseCurve(
      now, dur,
      rising ? [[0, centre], [dur, centre * 1.4]] : [[0, centre * 1.5], [dur, centre * 1.1]],
      9 + Math.random() * 3, vol, 'bandpass', 0.05, dest,
    );
    this.playTone(now, 62, 56, 0.25, 0.03 + strain * 0.02, 'sine', 0.02, dest);
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
   * Fire a positioned one-shot with distance-based gain rolloff (~1/(1+d/24)), a
   * distance lowpass, and stereo pan when the listener pose is known.
   * Cannon/keg beyond 140m degrade into a soft, delayed distant thump.
   */
  playAt(kind: SpatialKind, worldDistance: number, opts: SpatialOpts = {}): void {
    const d = Math.max(0, worldDistance);
    const intensity = opts.intensity ?? 1;
    const pos = opts.pos;
    switch (kind) {
      case 'cannonFire': this.playCannonFire(d, pos); break;
      case 'cannonballWhistle': this.playCannonballWhistle(d, pos); break;
      case 'hullImpact': this.playHullImpact(d, pos); break;
      case 'splashSmall': this.playSplash(0.4 * intensity, d, pos); break;
      case 'splashLarge': this.playSplash(1.3 * intensity, d, pos); break;
      case 'chainshotWhirr': this.playChainshotWhirr(d, pos); break;
      case 'sailRip': this.playSailRip(d, pos); break;
      case 'kegFuse': this.playKegFuse(1.6, d, pos); break;
      case 'kegExplosion': this.playKegExplosion(d, pos); break;
      case 'bodyThud': this.playBodyThud(intensity, d, pos); break;
    }
  }

  /** Stereo pan for a world position, or 0 when the listener pose is unknown. */
  private panFor(pos?: SoundPos | null): number {
    if (!pos || !this.listenerKnown) return 0;
    const dx = pos.x - this.listenerPos.x;
    const dz = pos.z - this.listenerPos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return 0;
    // right = forward × up  (three.js: forward (0,0,-1) → right (1,0,0))
    const rx = -this.listenerFwd.z;
    const rz = this.listenerFwd.x;
    const pan = (dx * rx + dz * rz) / len;
    return THREE.MathUtils.clamp(pan, -0.85, 0.85);
  }

  /**
   * Wire a per-sound group node into the dry bus (through a panner when the
   * source position is known) and give it ONE reverb send. The send is tapped
   * here — after the distance lowpass — so a far, dulled sound also sends a
   * dull signal to the reverb instead of contradicting its own distance cue.
   */
  private connectGroup(node: AudioNode, pos: SoundPos | null | undefined, send: number): void {
    const ctx = this.ctx as AudioContext;
    const pan = this.panFor(pos);
    let tail: AudioNode = node;
    if (pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner);
      tail = panner;
    }
    tail.connect(this.busDry as GainNode);
    if (send > 0 && this.busReverb) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = send;
      tail.connect(sendGain);
      sendGain.connect(this.busReverb);
    }
    // Voices routed into this group must not add their own send on top.
    this.ownSendNodes.add(node);
  }

  /**
   * Build a per-sound distance lowpass → pan → busDry group plus the distance
   * gain multiplier. Nearer = brighter + louder.
   * @param send per-kind reverb send level, tapped post-distance.
   */
  private makeSpatialDest(
    distance: number,
    pos?: SoundPos | null,
    send = 0.22,
  ): { dest: BiquadFilterNode; gain: number } {
    const ctx = this.ctx as AudioContext;
    const d = Math.max(0, distance);
    const gain = 1 / (1 + d / 24);
    const cutoff = THREE.MathUtils.clamp(19000 / (1 + d / 45), 380, 19000);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.5;
    this.connectGroup(filter, pos, send);
    return { dest: filter, gain };
  }

  /** A bare panned group (no distance filter) — for beds/ambience one-shots. */
  private makePanGroup(pan: number, send: number, bus?: AudioNode): AudioNode {
    const ctx = this.ctx as AudioContext;
    const panner = ctx.createStereoPanner();
    panner.pan.value = THREE.MathUtils.clamp(pan, -1, 1);
    panner.connect(bus ?? (this.busDry as GainNode));
    if (send > 0 && this.busReverb) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = send;
      panner.connect(sendGain);
      sendGain.connect(this.busReverb);
    }
    this.ownSendNodes.add(panner);
    return panner;
  }

  /**
   * Two parallel bandpass formants summed into one output — the difference
   * between a tone and a voice.
   */
  private makeFormantDest(f1: number, q1: number, f2: number, q2: number, mix2: number, send: number): AudioNode {
    const ctx = this.ctx as AudioContext;
    const input = ctx.createGain();
    input.gain.value = 1;
    const out = ctx.createGain();
    out.gain.value = 1;
    this.connectGroup(out, null, send);
    for (const [freq, q, level] of [[f1, q1, 1], [f2, q2, mix2]] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      input.connect(bp);
      bp.connect(g);
      g.connect(out);
    }
    this.ownSendNodes.add(input);
    return input;
  }

  // ── Naval combat one-shots ───────────────────────────────────────
  /**
   * Airy whistle that rises then falls to fake a cannonball passing by (no true doppler).
   * @param delaySeconds schedule the pass ahead of time (time-of-flight to closest approach).
   */
  playCannonballWhistle(distance = 0, pos?: SoundPos, delaySeconds = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('whistle')) return;
    const now = this.ctx.currentTime + Math.max(0, delaySeconds);
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.2);
    this.playTone(now, 900, 1700, 0.16, 0.12 * g, 'sine', 0.02, dest);
    this.playTone(now + 0.16, 1700, 620, 0.26, 0.12 * g, 'sine', 0, dest);
    this.playNoise(now, 0.4, 2400, 3.2, 0.06 * g, 'bandpass', dest);
  }

  /** Cannonball smashing a hull — deep thud under a burst of wood splinters. */
  playHullImpact(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (!this.throttle('hullImpact')) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.26);
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
  playShipImpact(kind: 'ram' | 'ground' | 'rock', speed: number, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.28);
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
   * a short grunt. Scales with impact so a survivable drop is a soft "oof" and a
   * near-lethal fall is a heavy slam.
   * @param intensity 0..1 (fall speed / lethal speed)
   * @param distance  metres from the listener
   */
  playBodyThud(intensity = 1, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 60) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.22);
    const v = THREE.MathUtils.clamp(intensity, 0.3, 1);
    this.playTone(now, 78, 40, 0.18, 0.34 * v * g, 'sine', 0.006, dest);
    this.playNoise(now, 0.13, 240, 0.8, 0.3 * v * g, 'lowpass', dest);
    this.playNoise(now + 0.01, 0.09, 900, 1.0, 0.12 * v * g, 'bandpass', dest);
    // Air knocked out of the body (only on a real impact).
    if (v > 0.5) {
      const voice = this.makeFormantDest(460, 5, 1100, 6, 0.4, 0.18);
      this.playTone(now + 0.02, 150, 96, 0.16, 0.26 * v * g, 'sawtooth', 0.01, voice, 0);
      this.playNoise(now + 0.04, 0.1, 1400, 0.7, 0.06 * v * g, 'highpass', dest);
    }
  }

  /** Rotating whoosh of chainshot spinning on its chain — deliberate pitch wobble. */
  playChainshotWhirr(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.22);
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
  playSailRip(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.24);
    this.playNoise(now, 0.5, 3200, 1.2, 0.18 * g, 'bandpass', dest);
    this.playNoise(now + 0.04, 0.4, 1500, 1.4, 0.14 * g, 'bandpass', dest);
    for (let i = 0; i < 10; i++) {
      const at = now + i * 0.035;
      this.playNoise(at, 0.03, 4200 - i * 260, 3, 0.05 * g, 'bandpass', dest);
    }
    this.playNoise(now + 0.3, 0.24, 900, 0.8, 0.08 * g, 'bandpass', dest);
  }

  /** Powder-keg fuse hiss. Call once when the fuse lights, passing its burn time. */
  playKegFuse(duration = 1.6, distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    if (distance > 40) return;
    const now = this.ctx.currentTime;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.18);
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
  playKegExplosion(distance = 0, pos?: SoundPos): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const delay = distance > 140 ? THREE.MathUtils.clamp(distance / 343, 0.2, 1.2) : 0;
    const at = now + delay;
    const { dest, gain: g } = this.makeSpatialDest(distance, pos, 0.32);
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
    // Blast rolling away across the water.
    this.playNoiseCurve(at + 0.15, 1.2, [[0, 900], [1.2, 160]], 0.4, 0.24 * g, 'lowpass', 0.02, dest);
    this.duckBeds(0.5, 0.6, 0.4);
  }

  // ── Burning-ship fire crackle (looped, max 2 concurrent) ─────────
  /** Start a fire crackle loop keyed by ship id. Past two fires the oldest is stolen. */
  startFire(id: string, distance = 0): void {
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (this.fires.has(id)) { this.updateFire(id, distance); return; }
    if (this.fires.size >= 2) {
      // Oldest-steal: the newest fire is the one the player just saw catch.
      const oldest = this.fires.keys().next().value;
      if (oldest !== undefined) this.stopFire(oldest);
    }
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

  // ── Waterfall bed (single voice, follows the NEAREST fall) ───────
  /**
   * Distance-gated white water. One voice for the whole world: the environment
   * pass picks the closest fall each frame and hands its distance here, which
   * is all a broadband hiss needs — a per-fall voice would spend eight
   * oscillators on a sound you can only hear one of at a time.
   *
   * @param distance metres to the nearest fall, or null when none is in range.
   * @param scale 0..1 for how big that fall is (drives cutoff + level).
   */
  setWaterfallBed(distance: number | null, scale = 1): void {
    const ctx = this.ctx;
    if (distance === null || distance > 130) {
      if (this.waterfallBed && ctx) this.ramp(this.waterfallBed.gain.gain, 0, 0.7);
      return;
    }
    this.unlock();
    const bed = this.busBed;
    if (!this.ctx || !bed || !this.noise) return;
    if (!this.waterfallBed) {
      const v = this.makeNoiseLoop('lowpass', 1500, 0.5, bed);
      // Slow surge, so the hiss breathes instead of sitting flat under the mix.
      const surge = this.addGainTremolo(v.gain, 0.13, 0.02);
      this.waterfallBed = { ...v, lfo: surge.lfo, lfoGain: surge.lfoGain };
    }
    const g = 1 / (1 + distance / 26);
    const size = THREE.MathUtils.clamp(scale, 0.3, 1.6);
    this.ramp(this.waterfallBed.gain.gain, 0.115 * g * size, 0.5);
    this.ramp(this.waterfallBed.filter.frequency, 700 + 1500 * g, 0.5);
    if (this.waterfallBed.lfoGain) this.ramp(this.waterfallBed.lfoGain.gain, 0.03 * g, 0.5);
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
      this.flooding = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain, lfo2, lfoGain2: lfo2Gain };
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
   * @param state.aboard set true while the listener is standing on the ship (drives
   *   rain-on-deck droplets); optional so existing callers keep working.
   */
  setSailingState(state: { speed01: number; roughness01: number; heel01: number; luffing: boolean; aboard?: boolean }): void {
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
    // Hull creak bed follows heel + roughness + speed…
    const strain = THREE.MathUtils.clamp(0.14 + heel * 0.6 + rough * 0.34, 0, 1);
    this.setHullCreakIntensity(
      strain,
      THREE.MathUtils.clamp(heel * 0.6 + speed * 0.4 + rough * 0.5, 0, 1),
    );
    // …and discrete creak events articulate it. Sparser in calm water.
    const now = ctx.currentTime;
    if (strain > 0.16) {
      if (this.nextCreakAt === 0) this.nextCreakAt = now + 1 + Math.random() * 4;
      else if (now >= this.nextCreakAt) {
        this.playHullCreakEvent(strain);
        const base = THREE.MathUtils.lerp(9, 3, strain);
        this.nextCreakAt = now + base * (0.6 + Math.random() * 0.8);
      }
      // A tack/gybe loads the frame — creak immediately.
      if (Math.abs(heel - this.lastHeel) > 0.15 && now - this.lastHeelAt > 1) {
        this.playHullCreakEvent(Math.min(1, strain + 0.3));
        this.lastHeelAt = now;
        this.lastHeel = heel;
      } else if (now - this.lastHeelAt > 1) {
        this.lastHeel = heel;
        this.lastHeelAt = now;
      }
    } else {
      this.nextCreakAt = 0;
    }
    // Luffing adds irregular canvas flap.
    this.setCanvasFlap(state.luffing ? THREE.MathUtils.clamp(0.4 + speed * 0.5, 0, 1) : 0);
    this.aboardShip = state.aboard ?? (speed > 0.02 || heel > 0.02);
    // "Under way" for the idle whistle: aboard AND actually making way.
    this.underway01 = this.aboardShip ? speed : 0;
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
   * Crossfade the world beds and run every lookahead scheduler (crickets, rain
   * droplets, bubbles). Call once per frame.
   * @param a.rain01 rain intensity; defaults to a storminess proxy so rain is
   *   audible even before the call site forwards the real value.
   */
  setAmbience(a: { nightFactor: number; storminess: number; nearShore01: number; rain01?: number }): void {
    this.unlock();
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    const night = THREE.MathUtils.clamp(a.nightFactor, 0, 1);
    const storm = THREE.MathUtils.clamp(a.storminess, 0, 1);
    const shore = THREE.MathUtils.clamp(a.nearShore01, 0, 1);
    const rain = THREE.MathUtils.clamp(a.rain01 ?? storm * 0.85, 0, 1);
    // The score reads the weather from here: a gale swallows the music, and a
    // whistle only surfaces out in open water, not in the surf line.
    this.stormLevel = storm;
    this.nearShore01 = shore;
    // Bed 1: storm wind.
    this.setWindIntensity(storm);
    // Bed 2: ocean wave bed — gentler "lap" at night, swells in a storm.
    this.setWaveBed(THREE.MathUtils.clamp(THREE.MathUtils.lerp(0.6, 0.32, night) + storm * 0.4, 0, 1));
    // Bed 3: night crickets (hushed in a storm) — scheduled chirps, not a hiss loop.
    this.setCrickets(night * (1 - storm * 0.7));
    // Bed 4: near-shore breaker wash.
    this.setBreaker(shore);
    // Bed 5: rain.
    this.setRain(rain);
    const now = ctx.currentTime;
    // Sparse day gulls.
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
    this.tickSchedulers(now);
  }

  /**
   * Lookahead scheduling for everything made of discrete events. Batches ~1s
   * ahead so nothing depends on frame timing.
   */
  private tickSchedulers(now: number): void {
    if (now - this.lastAmbienceTick < 0.05) return;
    this.lastAmbienceTick = now;
    // Crickets: two individuals, each trilling on its own clock and pan.
    if (this.cricketLevel > 0.05) {
      for (const voice of this.cricketVoices) {
        if (voice.nextAt < now) voice.nextAt = now + Math.random() * 0.8;
        while (voice.nextAt < now + 1) {
          this.playCricketTrill(voice.nextAt, voice.base, voice.pan, this.cricketLevel);
          voice.nextAt += 0.5 + Math.random() * 1.1;
        }
      }
    }
    // Rain drumming on the deck overhead.
    if (this.rainLevel > 0.1 && this.aboardShip) {
      if (this.nextRainDropAt < now) this.nextRainDropAt = now;
      const rate = 10 + this.rainLevel * 15;
      while (this.nextRainDropAt < now + 0.5) {
        // Onto the bed bus so a broadside ducks the rain with the rest of the ambience.
        this.playNoise(
          this.nextRainDropAt, 0.004, 4500 + Math.random() * 2500, 1.2,
          (0.015 + Math.random() * 0.015) * this.rainLevel, 'highpass', this.busBed ?? undefined, 0,
        );
        this.nextRainDropAt += (0.5 + Math.random()) / rate;
      }
    } else {
      this.nextRainDropAt = 0;
    }
    // Bubbles rising past your ears underwater.
    if (this.submerged01 > 0.05) {
      if (this.nextBubbleAt < now) this.nextBubbleAt = now;
      while (this.nextBubbleAt < now + 1) {
        const at = this.nextBubbleAt;
        this.playTone(at, 220 + Math.random() * 120, 850, 0.06, 0.02, 'sine', 0.005, undefined, 0);
        this.nextBubbleAt += 0.25 + Math.random() * 0.6;
      }
    } else {
      this.nextBubbleAt = 0;
    }
  }

  /**
   * Crickets are discrete chirp trains, not amplitude-modulated hiss: one trill
   * is 6-10 chirps ~30ms apart, and each individual keeps its own pitch and side.
   */
  private setCrickets(amount: number): void {
    this.cricketLevel = THREE.MathUtils.clamp(amount, 0, 1);
  }

  private playCricketTrill(at: number, base: number, pan: number, level: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.busBed) return;
    if (!this.throttle('chirp')) return;
    const dest = this.makePanGroup(pan, 0.12, this.busBed);
    const chirps = 6 + Math.floor(Math.random() * 5);
    const spacing = 0.028 + Math.random() * 0.006;
    const freq = base + Math.random() * 700;
    const vol = (0.02 + Math.random() * 0.015) * level;
    for (let i = 0; i < chirps; i++) {
      this.playTone(at + i * spacing, freq, freq * 0.98, 0.018, vol, 'sine', 0.003, dest);
    }
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

  /**
   * Rain: a bright shimmering patter plus a mid body. Deck droplet ticks are
   * scheduled separately (see {@link tickSchedulers}) while you're aboard.
   */
  private setRain(amount: number): void {
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    this.rainLevel = THREE.MathUtils.clamp(amount, 0, 1);
    if (this.rainLevel <= 0.001) {
      if (this.rainPatter) this.ramp(this.rainPatter.gain.gain, 0, 0.8);
      if (this.rainBody) this.ramp(this.rainBody.gain.gain, 0, 0.8);
      return;
    }
    if (!this.rainPatter) {
      const v = this.makeNoiseLoop('highpass', 3200, 0.5, bed);
      const trem = this.addGainTremolo(v.gain, 7, 0.012); // droplet shimmer
      this.rainPatter = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain };
    }
    if (!this.rainBody) this.rainBody = this.makeNoiseLoop('bandpass', 850, 0.5, bed);
    this.ramp(this.rainPatter.gain.gain, this.rainLevel * 0.055, 0.8);
    this.ramp(this.rainBody.gain.gain, this.rainLevel * 0.04, 0.8);
  }

  /** Muffled underwater bed — the world above turns into pressure and hiss. */
  private setSubmergedBed(amount: number): void {
    const ctx = this.ctx;
    const bed = this.busBed;
    if (!ctx || !bed || !this.noise) return;
    if (amount <= 0.001) {
      if (this.submergedBed) this.ramp(this.submergedBed.gain.gain, 0, 0.2);
      return;
    }
    if (!this.submergedBed) {
      this.submergedBed = this.makeNoiseLoop('lowpass', 240, 0.7, bed);
      // Body-conducted pressure hum under the muffle.
      const hum = ctx.createOscillator();
      hum.type = 'sine';
      hum.frequency.value = 55;
      const humGain = ctx.createGain();
      humGain.gain.value = 0.3;
      hum.connect(humGain);
      humGain.connect(this.submergedBed.gain);
      hum.start();
    }
    this.ramp(this.submergedBed.gain.gain, amount * 0.06, 0.2);
  }

  /**
   * Gull cry — a vibrato'd carrier with a rise-then-fall pitch envelope and a
   * breathy top, so it reads as a bird rather than a sawtooth siren.
   */
  private playGullCry(): void {
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    const now = ctx.currentTime;
    const calls = 2 + Math.floor(Math.random() * 2);
    const dest = this.makePanGroup((Math.random() * 2 - 1) * 0.6, 0.32);
    for (let i = 0; i < calls; i++) {
      const at = now + i * (0.24 + Math.random() * 0.12);
      this.gullNote(at, 1500 + Math.random() * 600, dest);
    }
  }

  private gullNote(at: number, base: number, dest: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base, at);
    osc.frequency.exponentialRampToValueAtTime(base * 1.15, at + 0.06);
    osc.frequency.exponentialRampToValueAtTime(base * 0.6, at + 0.25);
    // Vibrato is what makes a bird call sound alive.
    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 5.5;
    const vibGain = ctx.createGain();
    vibGain.gain.value = base * 0.03;
    vib.connect(vibGain);
    vibGain.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.05, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 0.3);
    vib.start(at);
    vib.stop(at + 0.3);
    // Second harmonic + breath.
    this.playTone(at, base * 2, base * 1.2, 0.22, 0.018, 'sine', 0.012, dest);
    this.playNoise(at, 0.2, 3000, 2, 0.008, 'bandpass', dest);
  }

  /** THE GILDED WRECK'S BELL — three tolls off a drowned ship's bell, rolling in
   *  over the water from wherever she rose. A bell is the one sound that carries
   *  through weather and gunfire and still means "look at the chart".
   *
   *  Built as a bell, not a chime: a struck bell has inharmonic partials (the
   *  hum an octave under the strike note, the minor third, the fifth and the
   *  nominal), a bright strike transient, and a very long decay. Distance rolls
   *  the top off and pushes the tolls further apart. */
  playWreckBell(distance = 400): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const d = THREE.MathUtils.clamp(distance, 20, 1400);
    const gain = 0.5 / (1 + d / 460);
    const far = ctx.createBiquadFilter();
    far.type = 'lowpass';
    // Distant tolls lose their strike edge long before they lose their hum.
    far.frequency.value = 2600 - (d / 1400) * 1750;
    far.Q.value = 0.4;
    this.connectGroup(far, null, 0.55);
    for (let toll = 0; toll < 3; toll++) {
      const at = now + toll * (1.45 + (d / 1400) * 0.35);
      const swing = toll === 1 ? 1 : 0.86;  // the middle pull is the strongest
      this.wreckToll(at, gain * swing, far);
    }
  }

  /**
   * ONE strike of her bell, scheduled at `at` through `dest`. Split out of
   * {@link playWreckBell} so the standing proximity bed can ring the SAME bell
   * — a second bell built out of different partials would have read as a
   * different ship.
   */
  private wreckToll(at: number, level: number, dest: AudioNode): void {
    const strike = 262;                    // the nominal — a heavy ship's bell
    const partials: Array<[number, number, number]> = [
      [strike * 0.5, 3.6, 0.55],           // hum
      [strike, 2.6, 0.7],                  // nominal
      [strike * 1.19, 1.9, 0.32],          // minor third — what makes it a BELL
      [strike * 1.5, 1.5, 0.22],           // fifth
      [strike * 2.02, 1.1, 0.16],          // slightly sharp octave
    ];
    for (const [freq, length, weight] of partials) {
      this.playTone(at, freq, freq * 0.998, length, level * weight, 'sine', 0.004, dest);
    }
    // The clapper on the shoulder of the bell.
    this.playNoise(at, 0.06, 3200, 1.4, level * 0.3, 'bandpass', dest);
  }

  /**
   * THE GILDED WRECK, HEARD RATHER THAN CHARTED.
   *
   * She used to make exactly one sound in her whole life — three tolls at the
   * moment she rose — and then sat there in silence while the fleet fought over
   * her. So she now has a standing voice inside {@link WRECK_AMBIENCE_RANGE}:
   *
   *  · a HULL GROAN — a very low bandpass bed with a slow tremolo on it, which
   *    is what a flooded hull rolling on its beam ends actually sounds like;
   *  · a RIGGING CREAK — a dry, higher layer of rope and working timber;
   *  · her BELL, tolling once every {@link WRECK_TOLL_PERIOD} seconds, swung by
   *    the same swell. The bell is the part that steers you: a bed is a texture,
   *    but a bell is a bearing.
   *
   * Distance sets level and how much of the top end survives the crossing;
   * bearing sets the pan. The whole thing rides busBed, so a broadside ducks her
   * with the rest of the world's ambience instead of talking over it.
   *
   * @param distance metres from listener to the wreck, or null when none is up.
   */
  setWreckSource(distance: number | null, pos?: SoundPos | null): void {
    this.wreckDistance = distance === null || !Number.isFinite(distance) ? null : Math.max(0, distance);
    this.wreckPos = pos ?? null;
    const ctx = this.ctx;
    if (!ctx) return;
    const d = this.wreckDistance;
    if (d === null || d > WRECK_AMBIENCE_RANGE) {
      if (this.wreckChain) this.ramp(this.wreckChain.gain.gain, 0, 1.4);
      // Out of earshot. Clearing the mark means she rings the moment she comes
      // back into range, rather than staying mute for most of a toll period.
      this.nextWreckTollAt = 0;
      return;
    }
    const bed = this.busBed;
    if (!bed || !this.noise) return;
    if (!this.wreckChain) {
      const input = ctx.createBiquadFilter();
      input.type = 'lowpass';
      input.frequency.value = 900;
      input.Q.value = 0.4;
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      input.connect(panner);
      panner.connect(gain);
      gain.connect(bed);
      // One reverb send for the whole chain, tapped after the distance filter —
      // a far, dull wreck must send a far, dull signal to the tail as well.
      if (this.busReverb) {
        const send = ctx.createGain();
        send.gain.value = 0.4;
        gain.connect(send);
        send.connect(this.busReverb);
      }
      this.ownSendNodes.add(input);
      this.wreckChain = { input, panner, gain };
      this.wreckGroan = this.makeNoiseLoop('bandpass', 96, 2.6, input);
      const groanTrem = this.addGainTremolo(this.wreckGroan.gain, 0.21, 0.35);
      this.wreckGroan = { ...this.wreckGroan, lfo: groanTrem.lfo, lfoGain: groanTrem.lfoGain };
      this.wreckCreak = this.makeNoiseLoop('bandpass', 720, 5.5, input);
      const creakTrem = this.addGainTremolo(this.wreckCreak.gain, 0.34, 0.55);
      this.wreckCreak = { ...this.wreckCreak, lfo: creakTrem.lfo, lfoGain: creakTrem.lfoGain };
    }
    // Inverse-distance, then a fade across the last 25 m so she does not click
    // in and out at the edge of the range.
    const near = THREE.MathUtils.clamp(1 - d / WRECK_AMBIENCE_RANGE, 0, 1);
    const fade = THREE.MathUtils.clamp((WRECK_AMBIENCE_RANGE - d) / 25, 0, 1);
    const level = (1 / (1 + d / 26)) * fade;
    this.ramp(this.wreckChain.gain.gain, level, 0.7);
    // Across a hundred metres of water only the groan survives; alongside her,
    // the rope and the dry timber come back.
    this.ramp(this.wreckChain.input.frequency, 320 + 2600 * near * near, 0.7);
    this.ramp(this.wreckChain.panner.pan, this.panFor(this.wreckPos), 0.3);
    if (this.wreckGroan) this.ramp(this.wreckGroan.gain.gain, 0.5, 1.2);
    if (this.wreckCreak) this.ramp(this.wreckCreak.gain.gain, 0.12 + 0.2 * near, 1.2);

    // Her bell, swung by the swell. Scheduled off the audio clock (not a frame
    // timer), and only while the context is actually running, so a backgrounded
    // tab never queues a burst of catch-up tolls.
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.nextWreckTollAt === 0 || now - this.nextWreckTollAt > WRECK_TOLL_PERIOD) {
      this.nextWreckTollAt = now + 0.35;
    }
    if (now >= this.nextWreckTollAt) {
      const far = ctx.createBiquadFilter();
      far.type = 'lowpass';
      far.frequency.value = 900 + 2400 * near;
      far.Q.value = 0.4;
      this.connectGroup(far, this.wreckPos, 0.55);
      this.wreckToll(now + 0.02, 0.34 * level, far);
      // Never metronomic: a bell hung in a rolling hull comes round late.
      this.nextWreckTollAt = now + WRECK_TOLL_PERIOD * (0.85 + Math.random() * 0.3);
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
    this.connectGroup(filter, null, 0.35);
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

  /**
   * Land-ho fanfare when a new island is discovered — a bright four-note rise
   * with a little brass on the resolution.
   */
  playIslandDiscovery(): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 987.77];
    for (let i = 0; i < notes.length; i++) {
      const at = now + i * 0.11;
      this.playTone(at, notes[i], notes[i], 0.4, 0.09, 'triangle', 0.02);
      this.playTone(at, notes[i] * 2, notes[i] * 2, 0.3, 0.025, 'sine', 0.02);
    }
    this.brassNote(now + 0.33, 987.77, 0.7, 0.12);
    this.playNoise(now + 0.33, 0.5, 5200, 0.8, 0.03, 'highpass');
  }

  /** Tiny coin tick for animating a gold counter. Pitch rises with index for a run-up feel. */
  playGoldCount(index = 0): void {
    this.unlock();
    if (!this.ctx || !this.busDry) return;
    const now = this.ctx.currentTime;
    const freq = 1500 + THREE.MathUtils.clamp(index, 0, 24) * 40;
    this.playTone(now, freq, freq, 0.03, 0.1, 'sine', 0, undefined, 0);
    this.playTone(now + 0.004, freq * 1.5, freq * 1.5, 0.04, 0.06, 'sine', 0, undefined, 0);
    this.playNoise(now, 0.02, 6000, 1.6, 0.04, 'highpass', undefined, 0);
  }

  // ══ Music ════════════════════════════════════════════════════════
  // A pirate game with no tune is a pirate game with no flag. Everything here
  // is generated: a seeded phrase grammar writes the melody, the same synth
  // primitives the cannons use play it, and the whole score rides one bus that
  // sits UNDER the ambience and gets out of the way when anything happens.

  /**
   * Switch musical worlds. Safe to call before the first user gesture — nothing
   * is scheduled until the AudioContext actually reports `running`, which the
   * existing unlock path (body pointerdown/keydown → {@link unlock}) delivers.
   */
  setMusicContext(context: MusicContext): void {
    if (this.musicContext === context) return;
    this.musicContext = context;
    // Every phrase clock resets: a new context starts on its own downbeat
    // instead of inheriting a mark from the one that just ended.
    this.menuNextLoopAt = 0;
    this.tavernNextLoopAt = 0;
    this.sailNextAt = 0;
    this.nextHearthPopAt = 0;
    if (context === 'none') {
      if (this.busMusic && this.ctx) this.ramp(this.busMusic.gain, 0, 0.6);
      this.stopMusicTimer();
      return;
    }
    // Deliberately NOT calling unlock() here: constructing an AudioContext
    // before a gesture just makes a suspended one Chrome complains about. The
    // timer arms itself from unlock() the moment a real gesture arrives.
    if (this.ctx) this.startMusicTimer();
  }

  /** The music world currently selected (for tests and for the HUD's mute UI). */
  getMusicContext(): MusicContext {
    return this.musicContext;
  }

  /**
   * Point the tavern jig at a building. The tune comes from the DOOR, not from
   * your head: distance sets level and how much timber it's coming through,
   * bearing sets the pan, and stepping inside opens it up and lights the
   * fireplace bed.
   * @param distance metres from listener to tavern, or null when none is in reach.
   */
  setTavernSource(distance: number | null, pos?: SoundPos | null): void {
    this.tavernDistance = distance === null || !Number.isFinite(distance) ? null : Math.max(0, distance);
    this.tavernPos = pos ?? null;
    const ctx = this.ctx;
    if (!ctx) return;
    const d = this.tavernDistance;
    if (d === null || d > TAVERN_MUSIC_RANGE + 8) {
      if (this.tavernChain) this.ramp(this.tavernChain.gain.gain, 0, 0.7);
      if (this.tavernHearth) this.ramp(this.tavernHearth.gain.gain, 0, 0.7);
      return;
    }
    const bus = this.busMusic;
    if (!bus) return;
    if (!this.tavernChain) {
      const input = ctx.createBiquadFilter();
      input.type = 'lowpass';
      input.frequency.value = 1400;
      input.Q.value = 0.5;
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      input.connect(panner);
      panner.connect(gain);
      gain.connect(bus);
      // The music bus already sends to the reverb — a per-note send would double it.
      this.ownSendNodes.add(input);
      this.tavernChain = { input, panner, gain };
    }
    const inside = this.tavernInside01();
    // Inverse-distance like every other source in the engine, then a short fade
    // to nothing at the edge of the range. A pure linear falloff made the jig
    // −60 dB by 20 m, which is not "you can hear it from the beach".
    const fade = THREE.MathUtils.clamp((TAVERN_MUSIC_RANGE + 2 - d) / 8, 0, 1);
    const near = THREE.MathUtils.clamp(1 - d / TAVERN_MUSIC_RANGE, 0, 1);
    this.ramp(this.tavernChain.gain.gain, (1 / (1 + d / 9)) * fade * fade, 0.5);
    // Outside you hear a band through oak; inside the top end comes back.
    this.ramp(this.tavernChain.input.frequency, 620 + 1200 * near * near + 5400 * inside, 0.5);
    // Bearing pans the band — but once you're THROUGH the door the room is
    // around you, so the pan collapses to centre instead of pinning the fiddle
    // to one ear while you stand in the middle of it.
    this.ramp(this.tavernChain.panner.pan, this.panFor(this.tavernPos) * (1 - inside), 0.25);
    // Hearth is AMBIENCE, not music: it rides busBed so a broadside ducks it
    // with the rest of the room.
    if (inside > 0.02 && this.busBed && this.noise) {
      if (!this.tavernHearth) {
        const v = this.makeNoiseLoop('bandpass', 560, 1.0, this.busBed);
        const trem = this.addGainTremolo(v.gain, 5.5, 0.05);
        this.tavernHearth = { ...v, lfo: trem.lfo, lfoGain: trem.lfoGain };
      }
      this.ramp(this.tavernHearth.gain.gain, 0.085 * inside, 0.6);
      this.ramp(this.tavernHearth.filter.frequency, 460 + 260 * inside, 0.6);
    } else if (this.tavernHearth) {
      this.ramp(this.tavernHearth.gain.gain, 0, 0.6);
    }
  }

  /** 1 in the taproom, 0 a few metres off the porch. */
  private tavernInside01(): number {
    const d = this.tavernDistance;
    if (d === null) return 0;
    return THREE.MathUtils.clamp(1 - (d - 3) / 4, 0, 1);
  }

  /**
   * Two-bar minor sting for a bounty raised / a wreck sighted — the two moments
   * that turn a scattered lobby into a converging one. Both are on the wire now
   * (`bounty_raised`, `wreck_event`) and Game.ts fires this from each.
   */
  playEventSting(kind: 'bounty' | 'wreck' = 'bounty'): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    const now = ctx.currentTime;
    const beat = 0.32;
    const root = kind === 'wreck' ? 43 : 45;   // G2 / A2
    // Both figures FALL and neither resolves upward: a bounty is blood money
    // and a wreck is somebody's grave.
    const figure: ReadonlyArray<readonly [number, number, number]> = kind === 'wreck'
      ? [[0, 0, 1], [2, -2, 0.8], [4, -3, 0.9], [6, -7, 1]]
      : [[0, 4, 0.9], [1, 2, 0.7], [2, 0, 1], [5, -3, 0.95]];
    for (const [b, degree, weight] of figure) {
      const at = now + b * beat;
      this.brassNote(at, midiToFreq(degreeToMidi(root + 24, degree, 'aeolian')), beat * 1.7, 0.2 * weight, 0.42);
      const low = midiToFreq(degreeToMidi(root, degree, 'aeolian'));
      this.playTone(at, low, low, beat * 1.9, 0.14 * weight, 'triangle', 0.05);
    }
    // Dark toll over a low swell.
    this.metalClang(now, midiToFreq(root + 24), 0.4, undefined, 2.4);
    this.playNoise(now, 0.6, 300, 0.5, 0.1, 'lowpass');
    this.duckMusic(0.08, 1.6, 1.6);
  }

  // ── Scheduler ────────────────────────────────────────────────────
  private startMusicTimer(): void {
    if (this.musicTimer !== null || typeof window === 'undefined') return;
    this.musicTimer = window.setInterval(() => this.tickMusic(), 200);
  }

  private stopMusicTimer(): void {
    if (this.musicTimer === null || typeof window === 'undefined') return;
    window.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  /**
   * Batch the next phrase ~1.2 s ahead so nothing depends on frame timing.
   * Driven by an internal 200 ms timer, because the MENU has no game loop to
   * ride; also callable directly, which is how the offline render harness pumps
   * a whole tune into an OfflineAudioContext.
   */
  tickMusic(): void {
    const ctx = this.ctx;
    const bus = this.busMusic;
    if (!ctx || !bus || this.musicContext === 'none') return;
    // Pre-gesture, or a suspended tab: schedule NOTHING. currentTime is frozen
    // there, so anything queued would fire in one lump the instant it resumes.
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // A backgrounded tab freezes the timer, not the clock. Re-arm a mark that
    // fell far behind rather than firing a burst of catch-up phrases.
    const rearm = (mark: number): number => (mark !== 0 && now - mark > 4 ? 0 : mark);
    this.menuNextLoopAt = rearm(this.menuNextLoopAt);
    this.tavernNextLoopAt = rearm(this.tavernNextLoopAt);
    this.sailNextAt = rearm(this.sailNextAt);
    // Level. The menu is the loudest music ever gets and even that sits under
    // the SFX; at sea a storm swallows the score outright.
    const base = this.musicContext === 'menu' ? MUSIC_MENU_LEVEL : MUSIC_WORLD_LEVEL;
    this.ramp(bus.gain, base * (1 - THREE.MathUtils.clamp(this.stormLevel, 0, 1) * 0.9), 0.9);
    if (this.musicContext === 'menu') this.tickMenuMusic(now);
    else this.tickWorldMusic(now);
  }

  private tickMenuMusic(now: number): void {
    if (this.menuNextLoopAt === 0) this.menuNextLoopAt = now + 0.35;
    if (now < this.menuNextLoopAt - MUSIC_LOOKAHEAD) return;
    this.scheduleMenuAir(this.menuNextLoopAt);
  }

  private tickWorldMusic(now: number): void {
    const nearTavern = this.tavernDistance !== null && this.tavernDistance <= TAVERN_MUSIC_RANGE;
    if (nearTavern && this.tavernChain) {
      if (this.tavernNextLoopAt === 0) this.tavernNextLoopAt = now + 0.4;
      if (now >= this.tavernNextLoopAt - MUSIC_LOOKAHEAD) this.scheduleTavernJig(this.tavernNextLoopAt);
    } else {
      this.tavernNextLoopAt = 0;
    }
    // Fireplace spits, inside only.
    const inside = this.tavernInside01();
    if (inside > 0.35 && this.busBed) {
      if (this.nextHearthPopAt < now) this.nextHearthPopAt = now + 0.2;
      while (this.nextHearthPopAt < now + 1) {
        this.playNoise(
          this.nextHearthPopAt, 0.03 + Math.random() * 0.05, 900 + Math.random() * 1500, 1.7,
          (0.018 + Math.random() * 0.026) * inside, 'bandpass', this.busBed, 0.08,
        );
        this.nextHearthPopAt += 0.35 + Math.random() * 1.5;
      }
    } else {
      this.nextHearthPopAt = 0;
    }
    // The idle whistle. Never while anything is happening, never near the
    // tavern (the jig owns that mix), and never twice inside half a minute.
    const calm = now >= this.combatHeatUntil && this.stormLevel < 0.45;
    const underWay = this.underway01 > 0.35 && this.nearShore01 < 0.55;
    if (!calm || nearTavern) { this.sailNextAt = 0; return; }
    if (!underWay) return;
    if (this.sailNextAt === 0) { this.sailNextAt = now + 18 + Math.random() * 30; return; }
    if (now < this.sailNextAt) return;
    this.scheduleSailingMotif(now + 0.2);
    this.sailNextAt = now + 30 + Math.random() * 60;
  }

  // ── Phrase scheduling ────────────────────────────────────────────
  /** The menu air: 8 bars of wistful concertina over a bellows drone. */
  private scheduleMenuAir(at: number): void {
    const bus = this.busMusic;
    if (!bus) return;
    const index = this.menuLoopIndex++;
    // Fresh melody every pass over the SAME harmonic floor and register, so the
    // loop is recognisably one tune without ever being the same 15 seconds.
    const phrase = generateShantyPhrase((this.musicSeed ^ Math.imul(index + 1, 0x9e3779b1)) | 0, {
      style: 'air',
      mode: index % 2 === 0 ? 'dorian' : 'mixolydian',
      bars: 8,
      rootMidi: 62,                    // D — where a concertina lives
      pickup: index === 0 ? 0 : 2,     // the first pass has no bar before it to lean on
    });
    const beatSec = 0.30;              // dotted quarter ≈ 67 bpm
    this.scheduleMelody(phrase, at, beatSec, bus, 'concertina', 0.26);
    this.scheduleAirBacking(phrase, at, beatSec, bus, 0.075);
    // Two beats of breath between passes: a tune, not a carousel.
    this.menuNextLoopAt = at + phrase.bars * phrase.beatsPerBar * beatSec + beatSec * 2;
  }

  /** The tavern jig: same grammar, twice the tempo, fiddle + bodhrán + bass. */
  private scheduleTavernJig(at: number): void {
    const chain = this.tavernChain;
    if (!chain) return;
    const index = this.tavernLoopIndex++;
    const phrase = generateShantyPhrase(Math.imul(this.musicSeed, 31) + Math.imul(index + 1, 0x85ebca6b), {
      style: 'jig',
      mode: index % 3 === 2 ? 'dorian' : 'mixolydian',
      bars: 8,
      rootMidi: 67,                    // G — fiddle/whistle country
      pickup: index === 0 ? 0 : 1,
    });
    const beatSec = 0.152;             // dotted quarter ≈ 132 bpm
    this.scheduleMelody(phrase, at, beatSec, chain.input, 'fiddle', 0.2);
    this.scheduleJigBacking(phrase, at, beatSec, chain.input, 0.15);
    this.tavernNextLoopAt = at + phrase.bars * phrase.beatsPerBar * beatSec + beatSec * 3;
  }

  /**
   * A crewmate idly whistling: two bars, once, then nothing for half a minute
   * or more. The moment it loops it stops being a person and becomes a
   * soundtrack — so it never loops.
   */
  private scheduleSailingMotif(at: number): void {
    const bus = this.busMusic;
    if (!bus) return;
    const index = this.sailLoopIndex++;
    const phrase = generateShantyPhrase(Math.imul(this.musicSeed, 17) + Math.imul(index + 1, 0xc2b2ae35), {
      style: 'air', mode: 'dorian', bars: 2, rootMidi: 74, pickup: 1,
    });
    this.scheduleMelody(phrase, at, 0.34, bus, 'whistle', 0.13, true);
  }

  /** Lay a generated phrase onto the timeline with one melodic voice. */
  private scheduleMelody(
    phrase: ShantyPhrase,
    at: number,
    beatSec: number,
    dest: AudioNode,
    voice: 'concertina' | 'whistle' | 'fiddle',
    level: number,
    skipPickup = false,
  ): void {
    const floor = (this.ctx?.currentTime ?? 0) - 0.02;
    for (const note of phrase.notes) {
      if (skipPickup && note.beat < 0) continue;
      const when = at + note.beat * beatSec;
      if (when < floor) continue;                       // a pickup that fell before "now"
      const freq = midiToFreq(degreeToMidi(phrase.rootMidi, note.degree, phrase.mode));
      const duration = note.beats * beatSec * (voice === 'fiddle' ? 0.84 : 0.94);
      const volume = level * (0.6 + 0.4 * note.accent);
      if (voice === 'concertina') this.concertinaNote(when, freq, duration, volume, dest);
      else if (voice === 'whistle') this.tinWhistleNote(when, freq, duration, volume, dest);
      else this.fiddleNote(when, freq, duration, volume, dest);
    }
  }

  /** Menu backing: a bellows chord every two bars over a tonic drone. */
  private scheduleAirBacking(phrase: ShantyPhrase, at: number, beatSec: number, dest: AudioNode, level: number): void {
    const barSec = phrase.beatsPerBar * beatSec;
    for (let bar = 0; bar < phrase.bars; bar += 2) {
      const root = phrase.chords[bar];
      const when = at + bar * barSec;
      for (const [step, weight] of [[0, 1], [2, 0.6], [4, 0.7]] as const) {
        const freq = midiToFreq(degreeToMidi(phrase.rootMidi - 12, root + step, phrase.mode));
        this.concertinaNote(when, freq, barSec * 2 * 0.92, level * weight, dest, true);
      }
    }
    // The bellows never fully close: one tonic drone under the whole pass.
    this.reedVoice({
      when: at,
      freq: midiToFreq(degreeToMidi(phrase.rootMidi - 24, 0, phrase.mode)),
      duration: phrase.bars * barSec,
      volume: level * 0.9,
      type: 'triangle',
      detuneCents: [-6, 6],
      attack: 1.2,
      release: 2.2,
      vibRate: 0.22,
      vibCents: 4,
      vibDelay: 2,
      cutoffFrom: 300,
      cutoffTo: 620,
      q: 0.6,
      dest,
    });
  }

  /** Jig backing: bodhrán on the two dotted-quarter pulses, bass on the chord. */
  private scheduleJigBacking(phrase: ShantyPhrase, at: number, beatSec: number, dest: AudioNode, level: number): void {
    const half = phrase.beatsPerBar / 2;
    for (let bar = 0; bar < phrase.bars; bar++) {
      const barAt = at + bar * phrase.beatsPerBar * beatSec;
      const root = phrase.chords[bar];
      const bassA = midiToFreq(degreeToMidi(phrase.rootMidi - 24, root, phrase.mode));
      const bassB = midiToFreq(degreeToMidi(phrase.rootMidi - 24, root + 4, phrase.mode));
      this.pluckNote(barAt, bassA, beatSec * half * 0.9, level, dest);
      this.pluckNote(barAt + beatSec * half, bassB, beatSec * half * 0.9, level * 0.78, dest);
      this.bodhranHit(barAt, level * 1.15, dest, true);
      this.bodhranHit(barAt + beatSec * half, level * 0.7, dest, false);
      if (bar % 2 === 1) this.bodhranHit(barAt + beatSec * (half + 1.5), level * 0.42, dest, false);
    }
  }

  // ── Melodic voices ───────────────────────────────────────────────
  /**
   * One sustained melodic note: a small DETUNED oscillator stack under a shared,
   * fade-in vibrato LFO, through its own opening lowpass and a bellows-shaped
   * envelope. The detune makes the partials beat, the vibrato makes the pitch
   * breathe, and the droop across the sustain is what separates an instrument
   * being played from an organ stop being held.
   */
  private reedVoice(p: {
    when: number; freq: number; duration: number; volume: number;
    type: OscillatorType; detuneCents: number[];
    attack: number; release: number;
    vibRate: number; vibCents: number; vibDelay: number;
    cutoffFrom: number; cutoffTo: number; q: number;
    dest: AudioNode;
    /** Breath/bow hiss level, relative to the note. */
    noise?: number;
    /** Octave-up sine level, relative to the note (a whistle's sheen). */
    harmonic?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || p.duration <= 0.02 || p.volume <= 0.0005) return;
    const nyq = ctx.sampleRate * 0.5 - 200;
    const end = p.when + p.duration;
    const attack = Math.max(0.004, Math.min(p.attack, p.duration * 0.45));
    const release = Math.min(p.release, p.duration * 0.45);
    const peak = Math.max(0.0002, p.volume);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = p.q;
    lp.frequency.setValueAtTime(THREE.MathUtils.clamp(p.cutoffFrom, 60, nyq), p.when);
    lp.frequency.exponentialRampToValueAtTime(
      THREE.MathUtils.clamp(p.cutoffTo, 60, nyq),
      p.when + Math.max(0.02, Math.min(p.duration * 0.7, attack + 0.25)),
    );

    const amp = ctx.createGain();
    const sustainAt = Math.min(Math.max(p.when + attack + 0.005, end - release), end - 0.004);
    amp.gain.setValueAtTime(0.0001, p.when);
    amp.gain.exponentialRampToValueAtTime(peak, p.when + attack);
    amp.gain.exponentialRampToValueAtTime(peak * 0.72, sustainAt);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    lp.connect(amp);
    amp.connect(p.dest);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = p.vibRate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, p.when);
    lfoGain.gain.linearRampToValueAtTime(p.vibCents, p.when + Math.min(Math.max(p.vibDelay, 0.02), p.duration));
    lfo.connect(lfoGain);
    lfo.start(p.when);
    lfo.stop(end + 0.05);

    const stack = ctx.createGain();
    stack.gain.value = 1 / Math.max(1, p.detuneCents.length);
    stack.connect(lp);
    for (const cents of p.detuneCents) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = Math.min(p.freq, nyq);
      osc.detune.value = cents;
      lfoGain.connect(osc.detune);
      osc.connect(stack);
      osc.start(p.when);
      osc.stop(end + 0.05);
    }
    if (p.harmonic) {
      const octave = Math.min(p.freq * 2, nyq);
      this.playTone(p.when, octave, octave, p.duration, peak * p.harmonic, 'sine', attack, p.dest, 0);
    }
    if (p.noise) {
      this.playNoise(p.when, p.duration, Math.min(p.freq * 2.2, nyq), 3.5, peak * p.noise * 0.32, 'bandpass', p.dest, 0);
    }
  }

  /** Free-reed squeezebox. `pad` is the held bellows chord under the melody. */
  private concertinaNote(when: number, freq: number, duration: number, volume: number, dest: AudioNode, pad = false): void {
    this.reedVoice({
      when, freq, duration, volume,
      type: 'sawtooth',
      detuneCents: pad ? [-11, 0, 11] : [-9, 0, 4, 9],
      attack: pad ? 0.18 : 0.055,
      release: pad ? 0.4 : 0.14,
      vibRate: 5.1, vibCents: pad ? 5 : 12, vibDelay: 0.24,
      cutoffFrom: freq * 1.6 + 200,
      cutoffTo: freq * (pad ? 2.4 : 4.2) + 400,
      q: 0.9,
      dest,
    });
  }

  /** Tin whistle: nearly a sine, with breath across it and an octave sheen. */
  private tinWhistleNote(when: number, freq: number, duration: number, volume: number, dest: AudioNode): void {
    this.reedVoice({
      when, freq, duration, volume,
      type: 'triangle',
      detuneCents: [-4, 4],
      attack: 0.03, release: 0.09,
      vibRate: 5.7, vibCents: 17, vibDelay: 0.16,
      cutoffFrom: freq * 4, cutoffTo: freq * 7, q: 0.7,
      dest, noise: 0.5, harmonic: 0.18,
    });
  }

  /** Fiddle: fast bite, tight vibrato, a little bow hiss. */
  private fiddleNote(when: number, freq: number, duration: number, volume: number, dest: AudioNode): void {
    this.reedVoice({
      when, freq, duration, volume,
      type: 'sawtooth',
      detuneCents: [-6, 6],
      attack: 0.018, release: 0.06,
      vibRate: 6.2, vibCents: 9, vibDelay: 0.1,
      cutoffFrom: freq * 2.4 + 300, cutoffTo: freq * 5 + 600, q: 1.4,
      dest, noise: 0.22,
    });
  }

  /** Plucked bass note under the jig. */
  private pluckNote(when: number, freq: number, duration: number, volume: number, dest: AudioNode): void {
    this.playTone(when, freq, freq * 0.996, duration, volume, 'triangle', 0.006, dest);
    this.playTone(when, freq * 2, freq * 1.99, duration * 0.45, volume * 0.3, 'sine', 0.004, dest);
    this.playNoise(when, 0.02, 2600, 1.2, volume * 0.32, 'bandpass', dest);
  }

  /** Goatskin frame drum — deep on the pulse, lighter on the off. */
  private bodhranHit(when: number, volume: number, dest: AudioNode, deep: boolean): void {
    const f = deep ? 108 : 152;
    this.playTone(when, f, f * 0.52, deep ? 0.17 : 0.11, volume, 'sine', 0.003, dest);
    this.playNoise(when, deep ? 0.07 : 0.05, deep ? 420 : 900, 0.8, volume * 0.5, 'bandpass', dest);
  }

  /**
   * Push the whole score down under a bang. Deeper and slower to recover than
   * {@link duckBeds}: ambience is the world and should only dip, music is
   * flavour and should get right out of the way.
   */
  private duckMusic(depth = 0.12, hold = 0.9, recover = 1.4): void {
    const ctx = this.ctx;
    const duck = this.musicDuck;
    if (!ctx || !duck) return;
    const now = ctx.currentTime;
    const g = duck.gain;
    // A second bang must never RAISE a duck that's already in place.
    const target = Math.max(0.0001, Math.min(depth, g.value));
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(target, now + 0.05);
    g.setValueAtTime(target, now + hold);
    g.linearRampToValueAtTime(1, now + hold + recover);
  }

  /** Lead is in the air: the idle whistling keeps away for a while. */
  private markCombat(seconds = 8): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.combatHeatUntil = Math.max(this.combatHeatUntil, ctx.currentTime + seconds);
  }

  // ── Loop / mix helpers ───────────────────────────────────────────
  private makeNoiseLoop(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): LoopVoice {
    const ctx = this.ctx as AudioContext;
    const noise = this.noise as AudioBuffer;
    const source = ctx.createBufferSource();
    source.buffer = noise;
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
    // Random start offset so concurrent beds off the same buffer never phase-lock.
    source.start(0, Math.random() * Math.max(0.1, noise.duration - 0.2));
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
    // Anything loud enough to duck the world ducks the MUSIC harder and marks
    // the fight, so the idle whistling stays out of a firefight entirely.
    this.duckMusic(0.1, hold + 0.4, recover + 1.2);
    this.markCombat();
  }

  // ── Voice management ─────────────────────────────────────────────
  /**
   * Per-kind burst limiter. A four-ship broadside can ask for hundreds of voices
   * in one frame; past the cap the extras are dropped (the first few carry the
   * event and the compressor would have swallowed the rest anyway).
   */
  private throttle(kind: string): boolean {
    const limit = KIND_LIMITS[kind];
    if (!limit) return true;
    const [max, windowMs] = limit;
    const now = performance.now();
    let log = this.kindLog.get(kind);
    if (!log) {
      log = [];
      this.kindLog.set(kind, log);
    }
    while (log.length > 0 && now - log[0] > windowMs) log.shift();
    if (log.length >= max) return false;
    log.push(now);
    return true;
  }

  /** Global ceiling on primitive voices per window — the backstop against node floods. */
  private voiceBudgetOk(): boolean {
    const now = performance.now();
    const stamps = this.voiceStamps;
    while (stamps.length > 0 && now - stamps[0] > VOICE_WINDOW_MS) stamps.shift();
    if (stamps.length >= VOICE_BUDGET) return false;
    stamps.push(now);
    return true;
  }

  // ── Primitives ───────────────────────────────────────────────────
  /**
   * @param attack optional attack time in seconds (default 0). Use a small attack to soften
   *   transients on tonal sounds so they don't click; leave at 0 for percussive ones.
   * @param wet reverb send for this voice. Omit to inherit (0 inside a group that
   *   already sends, 0.35 otherwise); pass 0 explicitly for dry UI chrome.
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
    wet?: number,
  ): void {
    const ctx = this.ctx;
    const dry = this.busDry;
    const bus = this.busReverb;
    if (!ctx || !dry || !bus) return;
    if (!this.voiceBudgetOk()) return;
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
    const send = wet ?? (dest && this.ownSendNodes.has(dest) ? 0 : 0.35);
    if (send > 0) {
      const wetGain = ctx.createGain();
      wetGain.gain.value = send;
      gain.connect(wetGain);
      wetGain.connect(bus);
    }
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
    wet?: number,
  ): void {
    this.playNoiseCurve(when, duration, [[0, frequency]], q, volume, filterType, 0, dest, wet);
  }

  /**
   * Filtered-noise voice whose cutoff walks a curve of [offsetSeconds, Hz] points.
   * Automating the filter is what turns static hiss into motion — powder tails,
   * whooshes, creaks and squeals are all this primitive.
   */
  private playNoiseCurve(
    when: number,
    duration: number,
    curve: ReadonlyArray<readonly [number, number]>,
    q: number,
    volume: number,
    filterType: BiquadFilterType,
    attack = 0,
    dest?: AudioNode,
    wet?: number,
  ): void {
    const ctx = this.ctx;
    const dry = this.busDry;
    const bus = this.busReverb;
    const noise = this.noise;
    if (!ctx || !dry || !bus || !noise || curve.length === 0) return;
    if (!this.voiceBudgetOk()) return;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(Math.max(20, curve[0][1]), when);
    for (let i = 1; i < curve.length; i++) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, curve[i][1]), when + curve[i][0]);
    }
    filter.Q.value = q;
    const gain = ctx.createGain();
    if (attack > 0) {
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), when + Math.min(attack, duration * 0.5));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    } else {
      gain.gain.setValueAtTime(Math.max(0.0001, volume), when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    }
    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest ?? dry);
    const send = wet ?? (dest && this.ownSendNodes.has(dest) ? 0 : 0.25);
    if (send > 0) {
      const wetGain = ctx.createGain();
      wetGain.gain.value = send;
      gain.connect(wetGain);
      wetGain.connect(bus);
    }
    // Random read offset so repeated one-shots never reuse the same noise texture.
    const offset = Math.random() * Math.max(0, noise.duration - duration - 0.1);
    source.start(when, offset);
    source.stop(when + duration + 0.05);
  }

  /**
   * Struck metal: an inharmonic partial stack with staggered decays. Real metal
   * modes are non-integer multiples, which is why a harmonic stack sounds like a
   * tuning fork and this sounds like steel. Partials are detuned per hit so a
   * parry never repeats exactly.
   */
  private metalClang(when: number, f0: number, volume: number, dest?: AudioNode, decayScale = 1): void {
    const partials = [1, 1.34, 1.72, 2.15, 2.76];
    const gains = [0.26, 0.19, 0.13, 0.09, 0.06];
    const decays = [0.42, 0.32, 0.26, 0.18, 0.12];
    for (let i = 0; i < partials.length; i++) {
      const f = f0 * partials[i] * (1 + (Math.random() - 0.5) * 0.03);
      this.playTone(when, f, f * 0.995, decays[i] * decayScale, gains[i] * volume, 'sine', 0.002, dest);
    }
  }

  private brassNote(when: number, freq: number, duration: number, volume: number, wet = 0.3): void {
    const ctx = this.ctx;
    if (!ctx || !this.busDry) return;
    // Filter envelope opening across the note = the blare of a brass instrument.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(1400, when);
    lp.frequency.exponentialRampToValueAtTime(2600, when + Math.max(0.05, duration * 0.6));
    this.connectGroup(lp, null, wet);
    for (const cents of [-8, 0, 8]) {
      const f = freq * Math.pow(2, cents / 1200);
      this.playTone(when, f, f, duration, volume * 0.22, 'sawtooth', 0.02, lp);
    }
    this.playTone(when, freq, freq, duration, volume * 0.5, 'triangle', 0.02, lp);
    this.playTone(when, freq * 2, freq * 2, duration, volume * 0.16, 'sine', 0.02, lp);
  }

  /**
   * 6 s of STEREO noise (independent channels). Long and decorrelated so looped
   * beds have no audible repeat period and two beds off the same buffer don't
   * comb-filter each other.
   */
  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 6);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
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
