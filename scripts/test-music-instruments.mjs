#!/usr/bin/env node
// SAMPLED SHANTY MUSIC (b3.5g, critique gap 10). Logic tier, no browser, ~10 s (ffmpeg decodes + R128).
//
//   node --import tsx scripts/test-music-instruments.mjs
//
// The shanty grammar now plays through CC0 sampled instruments (VSCO-2-CE violin as the fiddle, the
// VCSL harmonica free reed as the concertina, the VCSL soprano recorder as the tin whistle, VCSL frame
// drums as the bodhran and its muted lift), with the procedural voices as the fallback. This proves:
//   1. routing: sample voices when the manifest has the instrument keys, the procedural voice when
//      they are missing, not decoded yet (and then every miss is requested) or out of range;
//   2. coverage: every note the menu air, the tavern jig and the sailing whistle can generate routes
//      to a shipped sample within MAX_SAMPLE_SHIFT_SEMIS;
//   3. licences: every instrument row is CC0 with an https URL; the music tier is <= 1.0 MB;
//   4. pitch: each pitched sample SOUNDS the note its key names (measured, within 50 cents);
//   5. level: an offline render of one menu-air phrase and one tavern-jig phrase, built from the
//      shipped MP3s with the engine's own note plan and envelope, measures -26 +-1 LUFS (EBU R128,
//      ffmpeg), sample peak <= -1 dBFS, no NaN;
//   6. wiring: SoundEngine routes scheduleMelody / the air chords / the jig drums through the router
//      and keeps the procedural voices as the fallback.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, OUT_DIR, loadSources } from './audio/build-audio.mjs';
import { generateShantyPhrase, degreeToMidi } from '../src/client/audio/SoundEngine.ts';
import {
  buildInstrumentSet, routeNote, routePhrase, routeDrum, melodyEvents, airChordEvents, jigDrumEvents,
  sampleGain, noteNameToMidi, SAMPLE_ENVELOPE, MAX_SAMPLE_SHIFT_SEMIS, SAMPLED_INSTRUMENTS, DRUM_INSTRUMENTS,
} from '../src/client/audio/MusicInstruments.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(ok, label, detail = '') {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

// ── 1. routing ────────────────────────────────────────────────────────────────────────────────
console.log('routing');
const synthKeys = ['ui.click', 'music.fiddle.C4', 'music.fiddle.E4', 'music.fiddle.G4', 'music.concertina.C4', 'music.bodhran', 'music.framedrum', 'music.fiddle.Xs9'];
const synth = buildInstrumentSet(synthKeys);
check(synth.pitched.fiddle.map((s) => s.midi).join(',') === '60,64,67' && synth.drums.bodhran === 'music.bodhran',
  'buildInstrumentSet reads music.<instrument>.<note> keys (malformed names ignored)', JSON.stringify(synth));
check(noteNameToMidi('Fs5') === 78 && noteNameToMidi('F#5') === 78 && noteNameToMidi('Bb3') === 58 && noteNameToMidi('H2') === null, 'note names: Fs5 = F#5 = 78, Bb3 = 58, junk null');
const r62 = routeNote(synth, 'fiddle', 62);
check(r62 && r62.key === 'music.fiddle.C4' && Math.abs(r62.rate - 2 ** (2 / 12)) < 1e-9, 'D4 on the fiddle = C4 sample up 2 st', JSON.stringify(r62));
check(routeNote(synth, 'fiddle', 67 + MAX_SAMPLE_SHIFT_SEMIS + 1) === null, `a note > ${MAX_SAMPLE_SHIFT_SEMIS} st past the top sample is not sampled`);
const allReady = () => true;
const asked = [];
const sampled = routePhrase(synth, 'fiddle', [60, 62, 64, 66, 67], allReady);
check(Array.isArray(sampled) && sampled.length === 5 && sampled.every((p) => p.key.startsWith('music.fiddle.')), 'instrument keys present + decoded: the phrase is SAMPLED');
const none = buildInstrumentSet(['ui.click', 'bed.ocean']);
check(routePhrase(none, 'fiddle', [60, 62], allReady) === null && routePhrase(null, 'concertina', [60], allReady) === null
  && routeDrum(none, 'bodhran', allReady) === null, 'instrument keys missing (or no manifest): the phrase is PROCEDURAL');
const half = routePhrase(synth, 'fiddle', [60, 64, 67], (k) => { asked.push(k); return k !== 'music.fiddle.E4'; });
check(half === null && asked.length === 3, 'one key not decoded: procedural for the whole phrase, and every needed key was asked for (so the next pass is sampled)', JSON.stringify(asked));
check(routePhrase(synth, 'fiddle', [60, 90], allReady) === null, 'one note out of range: procedural for the whole phrase');
check(routeDrum(synth, 'framedrum', allReady) === 'music.framedrum' && routeDrum(synth, 'bodhran', () => false) === null, 'drums: sampled when ready, procedural when not');

// ── 2. coverage against the real manifest ──────────────────────────────────────────────────────
console.log('coverage');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
const set = buildInstrumentSet(Object.keys(manifest.keys));
for (const inst of SAMPLED_INSTRUMENTS) check(set.pitched[inst].length >= 6, `manifest ships ${set.pitched[inst].length} ${inst} pitches (>= 6)`);
for (const d of DRUM_INSTRUMENTS) check(set.drums[d] && manifest.keys[set.drums[d]].files.length >= 3, `manifest ships ${d} with >= 3 round-robin hits`);
const uses = [
  { name: 'menu air', inst: 'concertina', opts: (i) => ({ style: 'air', mode: i % 2 ? 'mixolydian' : 'dorian', bars: 8, rootMidi: 62, pickup: 2 }), low: true },
  { name: 'tavern jig', inst: 'fiddle', opts: (i) => ({ style: 'jig', mode: i % 3 === 2 ? 'dorian' : 'mixolydian', bars: 8, rootMidi: 67, pickup: 1 }) },
  { name: 'sailing whistle', inst: 'whistle', opts: () => ({ style: 'air', mode: 'dorian', bars: 2, rootMidi: 74, pickup: 1 }) },
];
for (const u of uses) {
  let notes = 0, miss = [];
  for (let i = 0; i < 200; i++) {
    const p = generateShantyPhrase(Math.imul(i + 1, 0x9e3779b1) | 0, u.opts(i));
    const midis = p.notes.map((n) => degreeToMidi(p.rootMidi, n.degree, p.mode));
    if (u.low) for (let b = 0; b < p.bars; b += 2) for (const s of [0, 2, 4]) midis.push(degreeToMidi(p.rootMidi - 12, p.chords[b] + s, p.mode));
    for (const m of midis) { notes++; if (!routeNote(set, u.inst, m)) miss.push(m); }
  }
  check(miss.length === 0, `${u.name}: all ${notes} notes of 200 generated phrases route to a ${u.inst} sample`, `unrouted midi: ${[...new Set(miss)].join(',')}`);
}

// ── 3. licences and budget ─────────────────────────────────────────────────────────────────────
console.log('licences + budget');
const cfg = loadSources();
const lic = new Map();
for (const line of fs.readFileSync(path.join(OUT_DIR, 'LICENSES.md'), 'utf8').split('\n')) {
  const c = line.split('|').map((x) => x.trim());
  if (c.length >= 8 && /\.mp3$/.test(c[1])) lic.set(c[1], { key: c[2], url: c[3], license: c[6] });
}
const musicKeys = Object.keys(manifest.keys).filter((k) => k.startsWith('music.'));
let bytes = 0, badRows = [];
for (const k of musicKeys) {
  const e = manifest.keys[k];
  if (e.tier !== 'music') badRows.push(`${k}: tier ${e.tier}`);
  for (const f of e.files) {
    bytes += fs.statSync(path.join(OUT_DIR, f.file)).size;
    const row = lic.get(f.file);
    const src = cfg.sources[f.source];
    if (!row || row.license !== 'CC0-1.0' || !/^https:\/\//.test(row.url) || src?.license !== 'CC0-1.0') badRows.push(`${f.file}: ${JSON.stringify(row)}`);
  }
}
check(musicKeys.length >= 20 && badRows.length === 0, `${musicKeys.length} instrument keys, every file tier music with a CC0-1.0 LICENSES row + https URL`, badRows.slice(0, 4).join('; '));
check(bytes <= 1.0e6, `music set ${(bytes / 1e6).toFixed(3)} MB <= 1.0 MB`);

// ── 4. measured pitch ──────────────────────────────────────────────────────────────────────────
const SR = 44100;
const pcmCache = new Map();
function decode(rel) {
  if (!pcmCache.has(rel)) {
    const b = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(OUT_DIR, rel), '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 26 });
    pcmCache.set(rel, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  return pcmCache.get(rel);
}
function f0Midi(x) {
  const start = Math.round(0.5 * SR), N = Math.round(0.35 * SR);
  const w = x.subarray(start, start + N);
  let r0 = 0; for (const v of w) r0 += v * v;
  const vals = new Float64Array(760);
  let best = 0;
  for (let lag = 18; lag < 740; lag++) { let s = 0; for (let i = 0; i + lag < w.length; i++) s += w[i] * w[i + lag]; vals[lag] = s / r0; best = Math.max(best, vals[lag]); }
  for (let lag = 19; lag < 739; lag++) {
    if (vals[lag] > 0.85 * best && vals[lag] >= vals[lag - 1] && vals[lag] >= vals[lag + 1]) {
      const a = vals[lag - 1], b = vals[lag], c = vals[lag + 1];
      const lagF = lag + (a - c) / (2 * (a - 2 * b + c) || 1); // parabolic refinement
      return 69 + 12 * Math.log2(SR / lagF / 440);
    }
  }
  return NaN;
}
console.log('pitch');
const pitchBad = [];
for (const inst of SAMPLED_INSTRUMENTS) for (const s of set.pitched[inst]) {
  const m = f0Midi(decode(manifest.keys[s.key].files[0].file));
  if (!(Math.abs(m - s.midi) <= 0.5)) pitchBad.push(`${s.key} sounds ${m.toFixed(2)}`);
}
check(pitchBad.length === 0, `every pitched sample sounds its key's note within 50 cents (${Object.values(set.pitched).flat().length} measured)`, pitchBad.join('; '));

// ── 5. offline render of one phrase per instrument family ──────────────────────────────────────
console.log('render');
function renderNotes(events, drums, seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (const e of events) {
    const x = decode(manifest.keys[e.key].files[0].file);
    const g = e.gain, t0 = Math.round(e.when * SR);
    const { attack, release } = e.env;
    const len = Math.min(Math.round((e.duration + release) * SR), Math.floor((x.length - 1) / e.rate));
    for (let i = 0; i < len && t0 + i < out.length; i++) {
      const t = i / SR;
      const env = t < attack ? t / attack : t < e.duration ? 1 : Math.max(0, 1 - (t - e.duration) / release);
      const p = i * e.rate, j = Math.floor(p), fr = p - j;
      out[t0 + i] += g * env * (x[j] * (1 - fr) + x[j + 1] * fr);
    }
  }
  for (const d of drums) {
    const x = decode(manifest.keys[d.key].files[d.variant % manifest.keys[d.key].files.length].file);
    const t0 = Math.round(d.when * SR);
    for (let i = 0; i < x.length && t0 + i < out.length; i++) out[t0 + i] += d.gain * x[i];
  }
  return out;
}
function planned(inst, evs) {
  const plans = routePhrase(set, inst, evs.map((e) => e.midi), () => true);
  if (!plans) throw new Error(`${inst}: phrase did not route`);
  return evs.map((e, i) => ({ ...e, key: plans[i].key, rate: plans[i].rate, gain: sampleGain(inst, e.volume), env: SAMPLE_ENVELOPE[inst] }));
}
function stats(pcm) {
  let peak = 0, nan = 0;
  for (const v of pcm) { if (!Number.isFinite(v)) nan++; else peak = Math.max(peak, Math.abs(v)); }
  const m = measure(pcm, 1);
  return { lufs: m.lufs, peakDb: 20 * Math.log10(peak), nan };
}
const at = 0.2;
const renders = [];
for (const seed of [20260801, 7, 1234]) {
  const air = generateShantyPhrase(seed, { style: 'air', mode: 'dorian', bars: 8, rootMidi: 62, pickup: 0 });
  const airBeat = 0.30;
  const melody = planned('concertina', melodyEvents(air, at, airBeat, 'concertina', 0.26, (d) => degreeToMidi(air.rootMidi, d, air.mode)));
  const chords = planned('concertina', airChordEvents(air, at, airBeat, 0.075, (d) => degreeToMidi(air.rootMidi - 12, d, air.mode)));
  renders.push({ name: `menu air (seed ${seed}, concertina melody + bellows chords)`, pcm: renderNotes([...melody, ...chords], [], at + air.bars * air.beatsPerBar * airBeat + 2.5) });
  const jig = generateShantyPhrase(seed, { style: 'jig', mode: 'mixolydian', bars: 8, rootMidi: 67, pickup: 0 });
  const jigBeat = 0.152;
  const fiddle = planned('fiddle', melodyEvents(jig, at, jigBeat, 'fiddle', 0.2, (d) => degreeToMidi(jig.rootMidi, d, jig.mode)));
  const drums = jigDrumEvents(jig, at, jigBeat, 0.15).map((h, i) => ({ ...h, key: set.drums[h.drum], variant: i, gain: sampleGain(h.drum, h.volume) }));
  renders.push({ name: `tavern jig (seed ${seed}, fiddle + bodhran + frame drum)`, pcm: renderNotes(fiddle, drums, at + jig.bars * jig.beatsPerBar * jigBeat + 2) });
}
for (const r of renders) {
  const s = stats(r.pcm);
  check(Number.isFinite(s.lufs) && Math.abs(s.lufs + 26) <= 1 && s.peakDb <= -1 && s.nan === 0,
    `${r.name}: ${s.lufs.toFixed(2)} LUFS (-26 +-1), peak ${s.peakDb.toFixed(2)} dBFS (<= -1), ${s.nan} NaN`);
}

// ── 6. wiring ──────────────────────────────────────────────────────────────────────────────────
console.log('wiring');
const se = fs.readFileSync(path.join(ROOT, 'src/client/audio/SoundEngine.ts'), 'utf8');
const body = (name) => { const i = se.indexOf(`private ${name}(`); return i < 0 ? '' : se.slice(i, se.indexOf('\n  }\n', i)); };
check(/from '\.\/MusicInstruments(\.js)?'/.test(se), 'SoundEngine imports MusicInstruments');
check(/routePhrase\(/.test(body('scheduleMelody')) && /melodyEvents\(/.test(body('scheduleMelody')), 'scheduleMelody plans with melodyEvents and routes through routePhrase');
check(/concertinaNote\(|tinWhistleNote\(|fiddleNote\(/.test(body('scheduleMelody')), 'scheduleMelody keeps the procedural voices as the fallback');
check(/airChordEvents\(/.test(body('scheduleAirBacking')) && /routePhrase\(/.test(body('scheduleAirBacking')), 'the menu bellows chords route through the concertina samples');
check(/jigDrumEvents\(/.test(body('scheduleJigBacking')) && /routeDrum\(/.test(body('scheduleJigBacking')) && /bodhranHit\(/.test(body('scheduleJigBacking')), 'the jig drums route through the frame-drum samples, procedural bodhran as the fallback');

console.log(failures === 0 ? '\nPASS: test-music-instruments' : `\nFAIL: test-music-instruments, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
