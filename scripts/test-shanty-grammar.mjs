#!/usr/bin/env node
// THE TUNE IS A GRAMMAR, NOT A LOOP.
//
// The menu air, the tavern jig and the whistled sailing motif all come out of
// one seeded phrase generator. Nobody can hear a unit test, so this suite
// asserts the things that make generated music sound WRITTEN rather than
// random, and that a browser is not required to check any of them:
//
//   1. determinism — one seed is one tune, forever;
//   2. variation   — consecutive loops are genuinely different melodies;
//   3. modality    — every pitch is in the mode (no accidental leading tones);
//   4. metre       — bars are full, notes don't overlap, the phrase is exact;
//   5. cadence     — the last note is the tonic, held;
//   6. anacrusis   — pickups lean into bar 1 from BELOW, outside the bar count;
//   7. form        — A A′ B A″: the answering pair re-uses the opening's feet;
//   8. register    — nothing runs off the end of a concertina;
//   9. harmony     — the chord floor is the modal-folk i–VII–IV–i;
//  10. style       — a jig runs where an air breathes.
import {
  generateShantyPhrase, degreeToMidi, midiToFreq, SHANTY_MODES,
} from '../src/client/audio/SoundEngine.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const air = generateShantyPhrase(1234, { style: 'air', bars: 8, rootMidi: 62, pickup: 2 });
const jig = generateShantyPhrase(99, { style: 'jig', bars: 8, rootMidi: 67, pickup: 1 });

console.log('\n1. Determinism');
{
  const a = generateShantyPhrase(4242, { style: 'air' });
  const b = generateShantyPhrase(4242, { style: 'air' });
  expect('same seed → byte-identical phrase', JSON.stringify(a) === JSON.stringify(b));
  const c = generateShantyPhrase(4243, { style: 'air' });
  expect('one bit of seed → a different tune', JSON.stringify(a) !== JSON.stringify(c));
}

console.log('\n2. Variation across loops');
{
  // The menu re-seeds every pass exactly the way the engine does.
  const seed = 20260726 | 0;
  const shapes = new Set();
  for (let i = 0; i < 12; i++) {
    const p = generateShantyPhrase((seed ^ Math.imul(i + 1, 0x9e3779b1)) | 0, {
      style: 'air', mode: i % 2 === 0 ? 'dorian' : 'mixolydian', bars: 8, rootMidi: 62,
    });
    shapes.add(p.notes.map((n) => `${n.beat}:${n.degree}`).join(','));
  }
  expect('12 consecutive loops are 12 distinct melodies', shapes.size === 12, `distinct=${shapes.size}`);
}

console.log('\n3. Modality — no note outside the mode');
for (const [name, phrase] of [['air', air], ['jig', jig]]) {
  const scale = SHANTY_MODES[phrase.mode];
  const bad = phrase.notes.filter((n) => {
    const midi = degreeToMidi(phrase.rootMidi, n.degree, phrase.mode);
    const pc = ((midi - phrase.rootMidi) % 12 + 12) % 12;
    return !scale.includes(pc);
  });
  expect(`${name}: every pitch class is in ${phrase.mode}`, bad.length === 0,
    bad.length ? `offenders: ${JSON.stringify(bad.slice(0, 4))}` : '');
  // Neither mode may contain a leading tone (11 semitones) — that's what would
  // make a sea tune sound like a hymn.
  expect(`${name}: ${phrase.mode} has no leading tone`, !scale.includes(11));
}

console.log('\n4. Metre — bars are full and notes never overlap');
for (const [name, phrase] of [['air', air], ['jig', jig]]) {
  const body = phrase.notes.filter((n) => n.beat >= 0);
  let sorted = true;
  let overlap = false;
  for (let i = 1; i < body.length; i++) {
    if (body[i].beat < body[i - 1].beat) sorted = false;
    if (body[i].beat < body[i - 1].beat + body[i - 1].beats) overlap = true;
  }
  expect(`${name}: notes are in time order`, sorted);
  expect(`${name}: no two notes overlap`, !overlap);
  const span = phrase.bars * phrase.beatsPerBar;
  const last = body[body.length - 1];
  expect(`${name}: the phrase fills exactly ${span} beats`, last.beat + last.beats === span,
    `ends at ${last.beat + last.beats}`);
  // Every bar must be exactly full — otherwise the downbeats drift.
  for (let bar = 0; bar < phrase.bars; bar++) {
    const inBar = body.filter((n) => n.beat >= bar * phrase.beatsPerBar && n.beat < (bar + 1) * phrase.beatsPerBar);
    const sum = inBar.reduce((s, n) => s + n.beats, 0);
    if (sum !== phrase.beatsPerBar) {
      expect(`${name}: bar ${bar + 1} sums to ${phrase.beatsPerBar}`, false, `sum=${sum}`);
      break;
    }
    if (bar === phrase.bars - 1) expect(`${name}: all ${phrase.bars} bars sum to ${phrase.beatsPerBar}`, true);
  }
  // A bar always starts ON its downbeat.
  const downbeats = body.filter((n) => n.beat % phrase.beatsPerBar === 0);
  expect(`${name}: every bar starts with a note`, downbeats.length === phrase.bars);
  expect(`${name}: downbeats carry full accent`, downbeats.every((n) => n.accent === 1));
}

console.log('\n5. Cadence — it lands home');
for (let seed = 0; seed < 40; seed++) {
  const p = generateShantyPhrase(seed * 7919 + 3, { style: seed % 2 ? 'jig' : 'air', bars: 8 });
  const last = p.notes[p.notes.length - 1];
  if (last.degree !== 0) { expect(`seed ${seed}: final note is the tonic`, false, `degree=${last.degree}`); break; }
  if (seed === 39) expect('40 tunes all cadence on the tonic', true);
}
{
  const last = air.notes[air.notes.length - 1];
  const prev = air.notes[air.notes.length - 2];
  expect('air: the tonic is approached by step (2nd above or subtonic below)',
    prev.degree === 1 || prev.degree === -1, `approach degree=${prev.degree}`);
  expect('air: the final note is held (≥ 1 beat)', last.beats >= 1, `beats=${last.beats}`);
}

console.log('\n6. Anacrusis');
{
  expect('air: pickup is 2 notes', air.notes.filter((n) => n.beat < 0).length === 2);
  expect('air: pickup sits at beats -2 and -1',
    air.notes[0].beat === -2 && air.notes[1].beat === -1);
  const firstBody = air.notes.find((n) => n.beat === 0);
  expect('air: pickup leans UP into the downbeat',
    air.notes[0].degree < firstBody.degree && air.notes[1].degree <= firstBody.degree,
    `pickup=${air.notes[0].degree},${air.notes[1].degree} first=${firstBody.degree}`);
  expect('air: pickup is metrically weak', air.notes[0].accent < 0.5);
  expect('jig: pickup is 1 note at beat -1',
    jig.notes.filter((n) => n.beat < 0).length === 1 && jig.notes[0].beat === -1);
  const none = generateShantyPhrase(5, { style: 'air', pickup: 0 });
  expect('pickup:0 → no notes before bar 1', none.notes.every((n) => n.beat >= 0));
  expect('pickupBeats is reported', air.pickupBeats === 2 && none.pickupBeats === 0);
}

console.log('\n7. Form — A A′ B A″');
{
  const rhythmOf = (p, bar) => p.notes
    .filter((n) => n.beat >= bar * p.beatsPerBar && n.beat < (bar + 1) * p.beatsPerBar)
    .map((n) => n.beats).join('-');
  let reused = 0;
  let contoursDiffer = 0;
  for (let seed = 0; seed < 30; seed++) {
    const p = generateShantyPhrase(seed * 104729 + 11, { style: 'air', bars: 8 });
    if (rhythmOf(p, 2) === rhythmOf(p, 0) && rhythmOf(p, 3) === rhythmOf(p, 1)) reused += 1;
    const a = p.notes.filter((n) => n.beat >= 0 && n.beat < 2 * p.beatsPerBar).map((n) => n.degree).join(',');
    const a2 = p.notes.filter((n) => n.beat >= 2 * p.beatsPerBar && n.beat < 4 * p.beatsPerBar).map((n) => n.degree).join(',');
    if (a !== a2) contoursDiffer += 1;
  }
  expect("the answering pair re-uses the opening's rhythm in all 30 tunes", reused === 30, `reused=${reused}`);
  expect('…but re-walks the contour (A′ ≠ A) in at least 27/30', contoursDiffer >= 27, `differ=${contoursDiffer}`);
}

console.log('\n8. Register — playable by a real instrument');
{
  let lo = Infinity;
  let hi = -Infinity;
  for (let seed = 0; seed < 60; seed++) {
    const p = generateShantyPhrase(seed * 7717 + 5, { style: seed % 2 ? 'jig' : 'air', bars: 8, rootMidi: 62 });
    for (const n of p.notes) {
      lo = Math.min(lo, n.degree);
      hi = Math.max(hi, n.degree);
    }
  }
  expect('degrees stay inside [-3, 10] (≈ two octaves)', lo >= -3 && hi <= 10, `range ${lo}..${hi}`);
  const fLo = midiToFreq(degreeToMidi(62, lo, 'dorian'));
  const fHi = midiToFreq(degreeToMidi(62, hi, 'dorian'));
  expect('…which is 200–1100 Hz off a D root', fLo > 200 && fHi < 1100, `${fLo.toFixed(0)}–${fHi.toFixed(0)} Hz`);
  expect('degreeToMidi wraps octaves the right way',
    degreeToMidi(62, 7, 'dorian') === 74 && degreeToMidi(62, -1, 'dorian') === 60 && degreeToMidi(62, -7, 'dorian') === 50,
    `${degreeToMidi(62, 7, 'dorian')}/${degreeToMidi(62, -1, 'dorian')}/${degreeToMidi(62, -7, 'dorian')}`);
  expect('midiToFreq: A4 = 440', Math.abs(midiToFreq(69) - 440) < 1e-9);
}

console.log('\n9. Harmony — the modal-folk chord floor');
{
  expect('8 bars carry 8 chords', air.chords.length === 8);
  expect('chords are i i VII VII IV IV V i', air.chords.join(',') === '0,0,6,6,3,3,4,0', air.chords.join(','));
  expect('the first and last bar are both the tonic chord',
    air.chords[0] === 0 && air.chords[air.chords.length - 1] === 0);
  const long = generateShantyPhrase(7, { style: 'air', bars: 16 });
  expect('a 16-bar tune cycles the same floor twice', long.chords.slice(8).join(',') === long.chords.slice(0, 8).join(','));
}

console.log('\n10. Style — a jig runs where an air breathes');
{
  const avg = (p) => p.notes.reduce((s, n) => s + n.beats, 0) / p.notes.length;
  let jigShorter = 0;
  for (let seed = 0; seed < 25; seed++) {
    const a = generateShantyPhrase(seed * 31337 + 1, { style: 'air', bars: 8 });
    const j = generateShantyPhrase(seed * 31337 + 1, { style: 'jig', bars: 8 });
    if (avg(j) < avg(a)) jigShorter += 1;
  }
  expect('jigs use shorter note values than airs in ≥ 20/25 seed pairs', jigShorter >= 20, `${jigShorter}/25`);
  expect('the jig defaults to mixolydian, the air to dorian',
    generateShantyPhrase(1, { style: 'jig' }).mode === 'mixolydian'
    && generateShantyPhrase(1, { style: 'air' }).mode === 'dorian');
}

console.log('\n11. Degenerate inputs never produce a broken phrase');
{
  for (const opts of [{ bars: 2 }, { bars: 1 }, { beatsPerBar: 4 }, { beatsPerBar: 2 }, { bars: 3, beatsPerBar: 8 }]) {
    const p = generateShantyPhrase(12345, { style: 'jig', ...opts });
    const body = p.notes.filter((n) => n.beat >= 0);
    const span = p.bars * p.beatsPerBar;
    const last = body[body.length - 1];
    const ok = body.length > 0 && last.beat + last.beats === span && body.every((n) => n.beats > 0);
    if (!ok) { expect(`opts ${JSON.stringify(opts)} yields a well-formed phrase`, false, `span=${span} end=${last?.beat + last?.beats}`); break; }
  }
  expect('bars/beatsPerBar edge cases all yield well-formed phrases', true);
}

console.log(failures === 0 ? '\nAll shanty-grammar checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
