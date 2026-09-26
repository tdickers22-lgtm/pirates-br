// MusicInstruments: the shanty grammar played through CC0 sampled instruments (b3.5g, critique gap 10).
//
// PURE: no AudioContext, no engine state, so the router, the note planner and an offline render of a
// whole phrase can all be checked in node (scripts/test-music-instruments.mjs).
//
// The instrument set enters through scripts/audio/build-audio.mjs like every other sound (D31), as
// one manifest key per sampled pitch: `music.<instrument>.<sounding note>` ('s' = sharp, so
// music.whistle.Fs5), plus the two unpitched drums `music.bodhran` and `music.framedrum`
// (round-robin variants). The pitch in the key is MEASURED, not copied from the source file name
// (VCSL names its harmonica and recorder files an octave below what they sound).
//
//   fiddle     VSCO-2-CE solo violin, arco vibrato, forte          C4..E6, one sample per 2-4 semitones
//   concertina VCSL Hohner Super64 harmonica (a free reed)         C3..G5
//   whistle    VCSL baroque soprano recorder, sustain              C5..G6
//   bodhran    VCSL large frame drum, open hit                     (the jig's pulse)
//   framedrum  VCSL small frame drum, muted hit                    (the jig's off-beats)
//
// A note plays the nearest sample, re-pitched by playbackRate. The router answers per PHRASE: the whole
// phrase is sampled only when every note it needs has a sample within MAX_SAMPLE_SHIFT_SEMIS AND is
// decoded; otherwise the whole phrase stays on the procedural voice (a tune never changes instrument
// between two notes) and the missing keys are requested, so the next pass is sampled. No manifest,
// no instrument keys, a failed fetch or a note out of range: the procedural voice plays, as before.
// The b5.2 shanty band reuses this set and this router.

export type SampledInstrument = 'fiddle' | 'concertina' | 'whistle';
export type DrumInstrument = 'bodhran' | 'framedrum';
export const SAMPLED_INSTRUMENTS: readonly SampledInstrument[] = ['fiddle', 'concertina', 'whistle'];
export const DRUM_INSTRUMENTS: readonly DrumInstrument[] = ['bodhran', 'framedrum'];
export const MUSIC_KEY_PREFIX = 'music.';

/** Furthest a sample is re-pitched. Inside the sampled range the nearest sample is <= 2 st away;
 *  past either end a note may borrow the edge sample up to this far, then the phrase goes procedural
 *  (a violin sample pushed a fifth up sounds like a toy). */
export const MAX_SAMPLE_SHIFT_SEMIS = 4;

/**
 * Linear gain per instrument that puts a sampled note (each sample is normalised to -20 LUFS by the
 * build) where the mix wants it for a given procedural `volume`. Calibrated by the offline render in
 * test-music-instruments: the menu air (concertina melody + bellows chords) and the tavern jig
 * (fiddle + bodhran + frame drum) each render at -26 +-1 LUFS with the sample peak <= -1 dBFS,
 * BEFORE the music bus (MUSIC_MENU_LEVEL / MUSIC_WORLD_LEVEL) and the storm duck.
 */
export const SAMPLE_TRIM: Readonly<Record<SampledInstrument | DrumInstrument, number>> = {
  fiddle: 2.85,
  concertina: 2.4,
  whistle: 2.4, // no render row: the sailing motif keeps its designed level relative to the concertina
  bodhran: 1.35,
  framedrum: 1.35,
};

/** Envelope around a sampled note: a short fade-in over the sample's own attack, a release at the
 *  note's end. Drums ring out (no release shaping beyond the sample's tail). */
export const SAMPLE_ENVELOPE: Readonly<Record<SampledInstrument, { attack: number; release: number }>> = {
  fiddle: { attack: 0.012, release: 0.07 },
  concertina: { attack: 0.03, release: 0.14 },
  whistle: { attack: 0.02, release: 0.09 },
};

/** How much of its written length each melodic voice sounds (the fiddle bows short, as before). */
export const NOTE_LENGTH_FACTOR: Readonly<Record<SampledInstrument, number>> = {
  fiddle: 0.84, concertina: 0.94, whistle: 0.94,
};

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' -> 60, 'Fs5' / 'F#5' -> 78, 'Bb3' -> 58. Null for anything else. */
export function noteNameToMidi(name: string): number | null {
  const m = /^([A-G])(s|#|b)?(-?\d)$/.exec(typeof name === 'string' ? name : '');
  if (!m) return null;
  const acc = m[2] === 's' || m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + acc;
}

export interface PitchedSample { key: string; midi: number }
export interface InstrumentSet {
  pitched: Record<SampledInstrument, PitchedSample[]>;
  drums: Record<DrumInstrument, string | null>;
}

/** The instrument set a manifest offers, from its key names. Unknown instruments and malformed
 *  note names are ignored; every list is sorted by pitch. */
export function buildInstrumentSet(keys: Iterable<string>): InstrumentSet {
  const set: InstrumentSet = {
    pitched: { fiddle: [], concertina: [], whistle: [] },
    drums: { bodhran: null, framedrum: null },
  };
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith(MUSIC_KEY_PREFIX)) continue;
    const parts = key.slice(MUSIC_KEY_PREFIX.length).split('.');
    if (parts.length === 1 && (DRUM_INSTRUMENTS as readonly string[]).includes(parts[0])) {
      set.drums[parts[0] as DrumInstrument] = key;
    } else if (parts.length === 2 && (SAMPLED_INSTRUMENTS as readonly string[]).includes(parts[0])) {
      const midi = noteNameToMidi(parts[1]);
      if (midi !== null) set.pitched[parts[0] as SampledInstrument].push({ key, midi });
    }
  }
  for (const list of Object.values(set.pitched)) list.sort((a, b) => a.midi - b.midi);
  return set;
}

export function hasInstrument(set: InstrumentSet | null, instrument: SampledInstrument | DrumInstrument): boolean {
  if (!set) return false;
  return (DRUM_INSTRUMENTS as readonly string[]).includes(instrument)
    ? set.drums[instrument as DrumInstrument] !== null
    : set.pitched[instrument as SampledInstrument].length > 0;
}

export interface SampleNotePlan { key: string; rate: number; shift: number }

/** The nearest sample for `midi` and the playbackRate that re-pitches it; null when the instrument
 *  has no samples or the nearest one is more than MAX_SAMPLE_SHIFT_SEMIS away. */
export function routeNote(set: InstrumentSet | null, instrument: SampledInstrument, midi: number): SampleNotePlan | null {
  const list = set?.pitched[instrument];
  if (!list || list.length === 0 || !Number.isFinite(midi)) return null;
  let best = list[0];
  for (const s of list) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  const shift = midi - best.midi;
  if (Math.abs(shift) > MAX_SAMPLE_SHIFT_SEMIS) return null;
  return { key: best.key, rate: 2 ** (shift / 12), shift };
}

/**
 * Route a whole phrase: one plan per midi when EVERY note routes and every key it needs is ready,
 * else null (the phrase plays procedurally). `isReady(key)` is the bank's decoded check; in the
 * engine a miss also requests the key, so the next pass of the tune is sampled.
 */
export function routePhrase(
  set: InstrumentSet | null,
  instrument: SampledInstrument,
  midis: readonly number[],
  isReady: (key: string) => boolean,
): SampleNotePlan[] | null {
  if (!hasInstrument(set, instrument) || midis.length === 0) return null;
  const plans: SampleNotePlan[] = [];
  for (const m of midis) {
    const p = routeNote(set, instrument, m);
    if (!p) return null;
    plans.push(p);
  }
  let ready = true;
  for (const key of new Set(plans.map((p) => p.key))) if (!isReady(key)) ready = false; // ask for every miss
  return ready ? plans : null;
}

/** The drum key for a hit, or null (procedural hit). */
export function routeDrum(set: InstrumentSet | null, drum: DrumInstrument, isReady: (key: string) => boolean): string | null {
  const key = set?.drums[drum] ?? null;
  return key && isReady(key) ? key : null;
}

// ── Note planning (shared by SoundEngine and the offline render gate) ──────────────────────

/** Minimal phrase shape (SoundEngine's ShantyPhrase satisfies it). */
export interface PhraseLike {
  notes: ReadonlyArray<{ beat: number; beats: number; degree: number; accent: number }>;
  bars: number;
  beatsPerBar: number;
  chords: readonly number[];
}

export interface MusicNoteEvent { when: number; midi: number; duration: number; volume: number }
export interface DrumHitEvent { when: number; drum: DrumInstrument; volume: number }

/** The melody of `phrase` as timed notes, exactly as SoundEngine.scheduleMelody lays it down. */
export function melodyEvents(
  phrase: PhraseLike, at: number, beatSec: number, voice: SampledInstrument, level: number,
  toMidi: (degree: number) => number, opts: { skipPickup?: boolean; floor?: number } = {},
): MusicNoteEvent[] {
  const floor = opts.floor ?? -Infinity;
  const out: MusicNoteEvent[] = [];
  for (const note of phrase.notes) {
    if (opts.skipPickup && note.beat < 0) continue;
    const when = at + note.beat * beatSec;
    if (when < floor) continue; // a pickup that fell before "now"
    out.push({
      when,
      midi: toMidi(note.degree),
      duration: note.beats * beatSec * NOTE_LENGTH_FACTOR[voice],
      volume: level * (0.6 + 0.4 * note.accent),
    });
  }
  return out;
}

/** The menu air's bellows chords: root, third, fifth an octave down, every two bars. */
export function airChordEvents(
  phrase: PhraseLike, at: number, beatSec: number, level: number, toMidiLow: (degree: number) => number,
): MusicNoteEvent[] {
  const barSec = phrase.beatsPerBar * beatSec;
  const out: MusicNoteEvent[] = [];
  for (let bar = 0; bar < phrase.bars; bar += 2) {
    const root = phrase.chords[bar];
    for (const [step, weight] of [[0, 1], [2, 0.6], [4, 0.7]] as const) {
      out.push({ when: at + bar * barSec, midi: toMidiLow(root + step), duration: barSec * 2 * 0.92, volume: level * weight });
    }
  }
  return out;
}

/** The jig's drum pattern: the big drum on both dotted-quarter pulses of a bar, a muted lift on
 *  every second bar. Same weights as the procedural bodhran it replaces. */
export function jigDrumEvents(phrase: PhraseLike, at: number, beatSec: number, level: number): DrumHitEvent[] {
  const half = phrase.beatsPerBar / 2;
  const out: DrumHitEvent[] = [];
  for (let bar = 0; bar < phrase.bars; bar++) {
    const barAt = at + bar * phrase.beatsPerBar * beatSec;
    out.push({ when: barAt, drum: 'bodhran', volume: level * 1.15 });
    out.push({ when: barAt + beatSec * half, drum: 'framedrum', volume: level * 0.7 });
    if (bar % 2 === 1) out.push({ when: barAt + beatSec * (half + 1.5), drum: 'framedrum', volume: level * 0.42 });
  }
  return out;
}

/** Output gain of a sampled note: the note's procedural volume times the instrument trim. */
export function sampleGain(instrument: SampledInstrument | DrumInstrument, volume: number): number {
  const v = Number.isFinite(volume) ? Math.max(0, volume) : 0;
  return v * SAMPLE_TRIM[instrument];
}
