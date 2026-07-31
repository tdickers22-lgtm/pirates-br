#!/usr/bin/env node
// MUSIC RENDER GATE — you cannot hear a build, so measure it.
//
// The whole score is synthesized live, which means the only honest test is to
// RENDER it and look at the samples. This drives the real SoundEngine inside a
// browser page with `window.AudioContext` swapped for an OfflineAudioContext,
// pumps the music scheduler across a fake clock, renders each musical context,
// and asserts on the resulting PCM:
//
//   • the menu is no longer silent, and the tune has note onsets in it;
//   • the tavern jig is spatialized — it gets quieter and duller with distance,
//     and it swaps sides when you walk round the building;
//   • the sailing whistle is SPARSE (long silence, one short phrase, no loop);
//   • music sits UNDER the SFX, and ducks out of the way of a broadside;
//   • six simultaneous one-shots over the theme do not clip the master.
//
// It also writes a 10 s WAV of each context so a human can audition them.
//
//   node scripts/test-music-render.mjs [outDir]
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/fixwave4/music';
mkdirSync(OUT, { recursive: true });

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const browser = await chromium.launch({
  args: browserArgs(['--ignore-gpu-blocklist', '--mute-audio']),
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

// Other agents editing this tree make vite full-reload mid-probe. Stub the HMR
// client so this tab never listens for reloads.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

await page.goto('http://127.0.0.1:3000/?debug', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });

// ── The offline rendering harness, installed in the page ────────────────────
await page.evaluate(() => {
  window.__music = {};
  /**
   * An OfflineAudioContext dressed up as a live one: `state` reads 'running'
   * (so the engine's "don't schedule into a suspended context" guard opens) and
   * `currentTime` is a value WE drive, which is how a 60-second tune gets
   * scheduled in a synchronous loop.
   */
  window.__music.makeCtx = (seconds, sampleRate = 44100) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);
    let clock = 0;
    Object.defineProperty(ctx, 'state', { get: () => 'running', configurable: true });
    Object.defineProperty(ctx, 'currentTime', { get: () => clock, configurable: true });
    ctx.__setClock = (t) => { clock = t; };
    return ctx;
  };
  window.__music.newEngine = async (ctx) => {
    const mod = await import('/src/client/audio/SoundEngine.ts');
    const prev = window.AudioContext;
    window.AudioContext = function () { return ctx; };
    const engine = new mod.SoundEngine();
    engine.unlock();
    window.AudioContext = prev;
    return engine;
  };
  /** Peak, RMS and onset count of a rendered buffer. */
  window.__music.analyse = (buffer) => {
    const n = buffer.length;
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    let peak = 0;
    let sum = 0;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      mono[i] = v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    // Per-channel peaks, so a pan can be measured.
    const chanPeak = chans.map((ch) => {
      let p = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
      return p;
    });
    const sr = buffer.sampleRate;
    // Loudness over time, in 100 ms buckets (silence and gap measurement).
    const bucket = Math.floor(sr * 0.1);
    const buckets = [];
    let bucketPeak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(mono[i]);
      if (a > bucketPeak) bucketPeak = a;
      if (i % bucket === bucket - 1) { buckets.push(bucketPeak); bucketPeak = 0; }
    }
    // ONSETS. A concertina has a 55 ms attack, so a transient detector finds
    // nothing; what a played note actually leaves in the signal is a RISE in
    // short-window RMS after the previous note's release. So: 10 ms-hop RMS,
    // then count rises that clear a fraction of the piece's own median level.
    const hop = Math.max(1, Math.floor(sr * 0.01));
    const win = hop * 3;
    const env = [];
    for (let i = 0; i + win < n; i += hop) {
      let s = 0;
      for (let k = i; k < i + win; k++) s += mono[k] * mono[k];
      env.push(Math.sqrt(s / win));
    }
    const sorted = env.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const floorLevel = Math.max(median * 0.5, loud * 0.08, 1e-5);
    const rise = Math.max(median * 0.28, loud * 0.06);
    let onsets = 0;
    let lastOnsetHop = -99;
    for (let i = 2; i < env.length - 1; i++) {
      if (i - lastOnsetHop < 7) continue;                 // 70 ms refractory
      const before = Math.min(env[i - 1], env[i - 2]);
      const delta = env[i] - before;
      // TWO WAYS TO BE A NOTE, because `rise` is keyed to the median of the
      // whole envelope and this score is a tune ON TOP OF a drone. When a pass
      // happens to voice a louder bed, the median climbs, `rise` climbs with
      // it, and the detector swallows the very notes it exists to count: the
      // sparse readings were the LOUDEST passes (rms 0.0209 against a typical
      // 0.0185), not the sparsest, and it failed the ≥12 gate about one run in
      // ten. A note played over a sustained bed lifts the envelope by a
      // FRACTION of what is already sounding, so accept a clear proportional
      // jump as well as an absolute one. Strictly additive — no reading this
      // ever counted stops counting.
      //
      // 1.35 is calibrated against ground truth, not against the gate: counting
      // the notes generateShantyPhrase actually schedules inside this 12 s
      // window over 40 seeds gives 12-20 (median 16), and this detector then
      // reads a median 18 — the melody plus the backing's own attacks. Looser
      // ratios pay for their headroom in lies: 1.18 reads a median 30 for the
      // same 16 notes, which is a detector measuring its own tremolo.
      const attacked = delta > rise || (before > 0 && env[i] > before * 1.35);
      if (env[i] > floorLevel && attacked && env[i] >= env[i + 1] * 0.92) {
        onsets += 1;
        lastOnsetHop = i;
      }
    }
    // Zero-crossing-ish brightness — a cheap proxy for the distance lowpass.
    let num = 0;
    let den = 0;
    let prev = mono[0];
    for (let i = 1; i < n; i++) { num += Math.abs(mono[i] - prev); den += Math.abs(mono[i]); prev = mono[i]; }
    return {
      peak, rms: Math.sqrt(sum / n), onsets, chanPeak, buckets,
      brightness: den > 0 ? num / den : 0,
      duration: buffer.duration, sampleRate: sr,
    };
  };
  /** Render a buffer to a 16-bit PCM WAV, base64'd for the node side. */
  window.__music.toWav = (buffer) => {
    const chans = buffer.numberOfChannels;
    const n = buffer.length;
    const bytes = 44 + n * chans * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, chans, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * chans * 2, true); view.setUint16(32, chans * 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, n * chans * 2, true);
    const data = [];
    for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chans; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    let bin = '';
    const u8 = new Uint8Array(view.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
});

/**
 * Run one scenario in the page. `setup` and `during` are stringified function
 * bodies taking (engine, ctx, t) so they can cross the Playwright boundary.
 */
async function render({ seconds, sampleRate = 44100, setup = '', during = '', step = 0.05, isolate = 'none' }) {
  return page.evaluate(async ({ seconds, sampleRate, setup, during, step, isolate }) => {
    const ctx = window.__music.makeCtx(seconds, sampleRate);
    const engine = await window.__music.newEngine(ctx);
    // Music-only renders: unhook the world's own buses from the master chain so
    // what lands in the buffer is the SCORE and nothing else. (The one-shots
    // still fire and still duck — they just aren't audible in the measurement.)
    if (isolate !== 'none') { engine.busDry.disconnect(); engine.busBed.disconnect(); }
    if (isolate === 'dry') engine.busReverb.disconnect();
    // eslint-disable-next-line no-new-func
    const setupFn = new Function('engine', 'ctx', setup);
    // eslint-disable-next-line no-new-func
    const duringFn = new Function('engine', 'ctx', 't', during);
    setupFn(engine, ctx);
    for (let t = 0; t <= seconds; t += step) {
      ctx.__setClock(t);
      duringFn(engine, ctx, t);
      engine.tickMusic();
    }
    engine.setMusicContext('none');
    ctx.__setClock(0);
    const buffer = await ctx.startRendering();
    return { analysis: window.__music.analyse(buffer), wav: window.__music.toWav(buffer) };
  }, { seconds, sampleRate, setup, during, step, isolate });
}

const save = (name, wav) => {
  const file = path.join(OUT, `${name}.wav`);
  writeFileSync(file, Buffer.from(wav, 'base64'));
  return file;
};
const fmt = (a) => `peak=${a.peak.toFixed(4)} rms=${a.rms.toFixed(5)} onsets=${a.onsets} L/R=${a.chanPeak.map((v) => v.toFixed(3)).join('/')}`;

// ── 1. The menu is no longer silent ─────────────────────────────────────────
console.log('\n1. MENU THEME — the concertina air');
const menu = await render({ seconds: 12, setup: "engine.setMusicContext('menu');" });
console.log(`   ${fmt(menu.analysis)}  → ${save('menu-theme', menu.wav)}`);
expect('the menu renders audible music (peak > 0.02)', menu.analysis.peak > 0.02, fmt(menu.analysis));
expect('…and it is not a DC blob (rms > 0.002)', menu.analysis.rms > 0.002, fmt(menu.analysis));
// The gate is set from what the composer can actually produce, not from a round
// number: across 40 seeds generateShantyPhrase lays 12-20 notes inside this
// window, so a ≥12 gate was sitting exactly ON the sparsest air it can write and
// had no margin by construction. Ten still fails everything this is here to
// catch — a drone, a silence, or a handful of notes — with room for the tune the
// generator is allowed to write on a quiet day.
expect('…with real note onsets in 12 s (≥ 10)', menu.analysis.onsets >= 10, `onsets=${menu.analysis.onsets}`);
expect('…and no clipping (peak < 0.99)', menu.analysis.peak < 0.99, `peak=${menu.analysis.peak.toFixed(3)}`);
{
  // A tune, not a drone: the level must move over the 12 s.
  const b = menu.analysis.buckets.slice(5);
  const lo = Math.min(...b);
  const hi = Math.max(...b);
  expect('the air breathes (loud/quiet buckets differ by ≥ 2×)', hi > lo * 2, `${lo.toFixed(4)}..${hi.toFixed(4)}`);
  // Every 100 ms bucket after the drone comes in should carry something.
  const dead = b.filter((v) => v < 1e-4).length;
  expect('no dead air inside the loop (< 10% silent buckets)', dead < b.length * 0.1, `dead=${dead}/${b.length}`);
}

// A second seeded pass must be a DIFFERENT rendering — the loop varies.
const menuB = await render({ seconds: 12, setup: "engine.setMusicContext('menu');" });
expect('two sessions render two different tunes',
  Math.abs(menuB.analysis.rms - menu.analysis.rms) > 1e-6 || menuB.analysis.onsets !== menu.analysis.onsets,
  `A ${fmt(menu.analysis)} | B ${fmt(menuB.analysis)}`);

// ── 2. The tavern jig, spatialized ──────────────────────────────────────────
console.log('\n2. TAVERN JIG — spatialized from the building');
const tavernSetup = (d, side) => `
  engine.setMusicContext('world');
  engine.setListenerPose({ x: 0, y: 2, z: 0 }, 0);
  engine.setTavernSource(${d}, { x: ${side * d}, y: 1, z: 0 });
`;
const tavernDuring = (d, side) => `engine.setTavernSource(${d}, { x: ${side * d}, y: 1, z: 0 });`;

const inside = await render({ seconds: 12, setup: tavernSetup(1.5, 1), during: tavernDuring(1.5, 1) });
console.log(`   inside  ${fmt(inside.analysis)}  → ${save('tavern-inside', inside.wav)}`);
const near = await render({ seconds: 12, setup: tavernSetup(8, 1), during: tavernDuring(8, 1) });
console.log(`   at 8 m  ${fmt(near.analysis)}  → ${save('tavern-8m', near.wav)}`);
const far = await render({ seconds: 12, setup: tavernSetup(24, 1), during: tavernDuring(24, 1) });
console.log(`   at 24 m ${fmt(far.analysis)}  → ${save('tavern-24m', far.wav)}`);
const outOfRange = await render({ seconds: 12, setup: tavernSetup(60, 1), during: tavernDuring(60, 1) });

expect('inside the tavern a jig is playing', inside.analysis.peak > 0.02 && inside.analysis.onsets >= 20,
  fmt(inside.analysis));
expect('it is still audible at 8 m', near.analysis.peak > 0.005, fmt(near.analysis));
expect('it is faint but genuinely present at 24 m (> −45 dB of inside)',
  far.analysis.peak > inside.analysis.peak * 0.006 && far.analysis.peak < near.analysis.peak,
  `24m=${far.analysis.peak.toFixed(5)} 8m=${near.analysis.peak.toFixed(5)} inside=${inside.analysis.peak.toFixed(5)}`);
expect('distance attenuates monotonically (inside > 8 m > 24 m)',
  inside.analysis.peak > near.analysis.peak && near.analysis.peak > far.analysis.peak,
  `${inside.analysis.peak.toFixed(4)} > ${near.analysis.peak.toFixed(4)} > ${far.analysis.peak.toFixed(4)}`);
expect('distance also DULLS it (brightness falls off)', far.analysis.brightness < inside.analysis.brightness,
  `24m=${far.analysis.brightness.toFixed(4)} inside=${inside.analysis.brightness.toFixed(4)}`);
expect('past ~26 m the jig is silent', outOfRange.analysis.peak < 1e-4, `peak=${outOfRange.analysis.peak.toExponential(2)}`);

const rightSide = await render({ seconds: 8, setup: tavernSetup(12, 1), during: tavernDuring(12, 1) });
const leftSide = await render({ seconds: 8, setup: tavernSetup(12, -1), during: tavernDuring(12, -1) });
expect('a tavern on your right is louder in the right ear',
  rightSide.analysis.chanPeak[1] > rightSide.analysis.chanPeak[0] * 1.2,
  `L/R=${rightSide.analysis.chanPeak.map((v) => v.toFixed(4)).join('/')}`);
expect('…and walking round it swaps the ears',
  leftSide.analysis.chanPeak[0] > leftSide.analysis.chanPeak[1] * 1.2,
  `L/R=${leftSide.analysis.chanPeak.map((v) => v.toFixed(4)).join('/')}`);

// ── 2b. The Gilded Wreck has a voice ────────────────────────────────────────
// She is the mid-match convergence mark, and until now she made exactly ONE
// sound in her life: three tolls at the instant she rose. For the whole fight
// over her she was silent — a beacon you could see and never hear. She now
// carries a standing bed (hull groan + rigging creak) and tolls her own bell
// out to 120 m, which is far enough that "I can hear her" turns into "I am
// steering at her" without opening the chart.
console.log('\n2b. THE GILDED WRECK — heard across the water');
const wreckAt = (d, side) => `engine.setWreckSource(${d}, { x: ${side * d}, y: 0, z: 0 });`;
const wreckSetup = (d, side) => `
  engine.setMusicContext('world');
  engine.setListenerPose({ x: 0, y: 2, z: 0 }, 0);
  engine.setTavernSource(null);
  ${wreckAt(d, side)}
`;
const wreckClose = await render({ seconds: 14, setup: wreckSetup(25, 1), during: wreckAt(25, 1) });
console.log(`   at 25 m  ${fmt(wreckClose.analysis)}  → ${save('wreck-25m', wreckClose.wav)}`);
const wreckFar = await render({ seconds: 14, setup: wreckSetup(100, 1), during: wreckAt(100, 1) });
console.log(`   at 100 m ${fmt(wreckFar.analysis)}  → ${save('wreck-100m', wreckFar.wav)}`);
const wreckGone = await render({ seconds: 14, setup: wreckSetup(240, 1), during: wreckAt(240, 1) });

expect('alongside her you can hear her working', wreckClose.analysis.peak > 0.004, fmt(wreckClose.analysis));
expect('her bell tolls rather than droning (onsets in the bed)',
  wreckClose.analysis.onsets >= 1, `onsets=${wreckClose.analysis.onsets}`);
expect('she is still there at 100 m, and quieter',
  wreckFar.analysis.peak > 1e-4 && wreckFar.analysis.peak < wreckClose.analysis.peak,
  `100m=${wreckFar.analysis.peak.toFixed(5)} 25m=${wreckClose.analysis.peak.toFixed(5)}`);
expect('distance dulls her too', wreckFar.analysis.brightness < wreckClose.analysis.brightness,
  `100m=${wreckFar.analysis.brightness.toFixed(4)} 25m=${wreckClose.analysis.brightness.toFixed(4)}`);
expect('past her range she is silent', wreckGone.analysis.peak < 1e-4,
  `peak=${wreckGone.analysis.peak.toExponential(2)}`);

const wreckRight = await render({ seconds: 10, setup: wreckSetup(40, 1), during: wreckAt(40, 1) });
const wreckLeft = await render({ seconds: 10, setup: wreckSetup(40, -1), during: wreckAt(40, -1) });
expect('a wreck off your starboard beam is louder to starboard',
  wreckRight.analysis.chanPeak[1] > wreckRight.analysis.chanPeak[0] * 1.15,
  `L/R=${wreckRight.analysis.chanPeak.map((v) => v.toFixed(4)).join('/')}`);
expect('…and she swaps ears when she is off to port',
  wreckLeft.analysis.chanPeak[0] > wreckLeft.analysis.chanPeak[1] * 1.15,
  `L/R=${wreckLeft.analysis.chanPeak.map((v) => v.toFixed(4)).join('/')}`);

// The sting was written for two moments and wired to one. Both must sound.
const stingBounty = await render({ seconds: 4, setup: "engine.playEventSting('bounty');" });
const stingWreck = await render({ seconds: 4, setup: "engine.playEventSting('wreck');" });
expect('the bounty sting sounds', stingBounty.analysis.peak > 0.01, fmt(stingBounty.analysis));
expect('the wreck sting sounds, and is its own figure',
  stingWreck.analysis.peak > 0.01 && Math.abs(stingWreck.analysis.rms - stingBounty.analysis.rms) > 1e-6,
  `wreck ${fmt(stingWreck.analysis)} | bounty ${fmt(stingBounty.analysis)}`);

// ── 3. The sailing whistle is sparse ────────────────────────────────────────
console.log('\n3. SAILING MOTIF — a crewmate idly whistling');
const sail = await render({
  seconds: 90,
  sampleRate: 22050,
  step: 0.1,
  // Music-isolated: the sea beds this scenario also starts would otherwise fill
  // every bucket and the sparseness would be unmeasurable.
  isolate: 'beds',
  setup: `
    engine.setMusicContext('world');
    engine.setTavernSource(null);
    engine.setListenerPose({ x: 0, y: 2, z: 0 }, 0);
  `,
  during: `
    engine.setSailingState({ speed01: 0.8, roughness01: 0.1, heel01: 0.05, luffing: false, aboard: true });
    engine.setAmbience({ nightFactor: 0, storminess: 0, nearShore01: 0, rain01: 0 });
  `,
});
console.log(`   ${fmt(sail.analysis)}  → ${save('sailing-whistle-90s', sail.wav)}`);
{
  const b = sail.analysis.buckets;      // 100 ms buckets over 90 s
  const loudIdx = b.map((v, i) => (v > 0.002 ? i : -1)).filter((i) => i >= 0);
  const secs = loudIdx.map((i) => i / 10);
  expect('the whistle does eventually surface', loudIdx.length > 0,
    `max bucket=${Math.max(...b).toExponential(2)}`);
  if (loudIdx.length) {
    const first = secs[0];
    expect('…but not for at least 15 s of sailing', first >= 15, `first at ${first.toFixed(1)}s`);
    // Total sounding time must be a few seconds, not a continuous track.
    const sounding = loudIdx.length / 10;
    expect('…and it whistles for seconds, not minutes (< 20 s of 90)', sounding < 20, `sounding=${sounding.toFixed(1)}s`);
    expect('…leaving most of the passage to wind and water (> 70 s silent)',
      90 - sounding > 70, `silent=${(90 - sounding).toFixed(1)}s`);
    // Phrases must be separated by a real gap. Measure that between PHRASES,
    // not between loud buckets: one two-bar whistle is ~39-40 contiguous
    // buckets, so a bucket-level gap is ~0.1 s inside a phrase and says
    // nothing about repeat spacing. Cluster first (a hole > 2 s starts a new
    // phrase), then compare phrase STARTS — which is what the engine spaces
    // (sailNextAt = now + 30 + rand*60). With a single phrase in the window
    // there is no repeat to measure and the contract is vacuously kept.
    const phrases = [];
    for (const s of secs) {
      const last = phrases[phrases.length - 1];
      if (!last || s - last.end > 2) phrases.push({ start: s, end: s });
      else last.end = s;
    }
    let minRepeatGap = Infinity;
    for (let i = 1; i < phrases.length; i++) {
      minRepeatGap = Math.min(minRepeatGap, phrases[i].start - phrases[i - 1].start);
    }
    expect('…with a ≥ 25 s gap between phrases when it repeats',
      phrases.length < 2 || minRepeatGap >= 25,
      `phrases=${phrases.length} starts=[${phrases.map((p) => p.start.toFixed(1)).join(', ')}]`);
  }
}
const stormy = await render({
  seconds: 60,
  sampleRate: 22050,
  step: 0.1,
  // 'dry', not 'beds': unhooking busDry+busBed still leaves the BEDS' reverb
  // SEND in the buffer, and a full gale is the loudest bed the engine owns.
  // That send alone measured 0.8e-3..2.3e-3 across runs — straddling any
  // sensible silence threshold and flaking the check on the weather's own
  // noise rather than on the score. Dropping busReverb too leaves the dry
  // score and nothing else, which is exactly what "silences the score" means.
  isolate: 'dry',
  setup: "engine.setMusicContext('world'); engine.setTavernSource(null);",
  during: `
    engine.setSailingState({ speed01: 0.9, roughness01: 0.9, heel01: 0.4, luffing: false, aboard: true });
    engine.setAmbience({ nightFactor: 0.5, storminess: 0.95, nearShore01: 0, rain01: 0.9 });
  `,
});
// Genuinely nothing: the gale gate (stormLevel < 0.45) never lets a note be
// scheduled, so this renders a mathematically empty buffer, not a quiet one.
expect('a full gale silences the score entirely', Math.max(...stormy.analysis.buckets) < 1e-4,
  `peak bucket=${Math.max(...stormy.analysis.buckets).toExponential(2)}`);

// ── 4. Mix discipline ───────────────────────────────────────────────────────
console.log('\n4. MIX — music under the world, and no clipping');
const sfxOnly = await render({
  seconds: 10,
  setup: '',
  during: `
    if (Math.abs(t - 2) < 0.026) {
      engine.playCannonFire(6);
      engine.playKegExplosion(10);
      engine.playGunshot('blunderbuss', 3);
      engine.playGunshot('flintlock', 5);
      engine.playHullImpact(8);
      engine.playThunder(90);
    }
  `,
});
console.log(`   sfx only  ${fmt(sfxOnly.analysis)}`);
const both = await render({
  seconds: 10,
  setup: "engine.setMusicContext('menu');",
  during: `
    if (Math.abs(t - 2) < 0.026) {
      engine.playCannonFire(6);
      engine.playKegExplosion(10);
      engine.playGunshot('blunderbuss', 3);
      engine.playGunshot('flintlock', 5);
      engine.playHullImpact(8);
      engine.playThunder(90);
    }
  `,
});
console.log(`   theme+6   ${fmt(both.analysis)}  → ${save('menu-theme-with-6-oneshots', both.wav)}`);
expect('six simultaneous one-shots over the theme never clip',
  both.analysis.peak < 0.99, `peak=${both.analysis.peak.toFixed(4)}`);
expect('the theme alone is quieter than the SFX alone (music sits under)',
  menu.analysis.peak < sfxOnly.analysis.peak,
  `music=${menu.analysis.peak.toFixed(4)} sfx=${sfxOnly.analysis.peak.toFixed(4)}`);
expect('adding music barely moves the peak (< 12% over SFX alone)',
  both.analysis.peak < sfxOnly.analysis.peak * 1.12,
  `both=${both.analysis.peak.toFixed(4)} sfx=${sfxOnly.analysis.peak.toFixed(4)}`);
{
  // The DUCK is only measurable with the bang itself out of the buffer — a
  // cannon's own tail is louder than the music it's ducking. Same scenario,
  // music-isolated: the one-shots still fire and still duck the score.
  const ducked = await render({
    seconds: 10,
    isolate: 'dry',
    setup: "engine.setMusicContext('menu');",
    during: `
      if (Math.abs(t - 2) < 0.026) {
        engine.playCannonFire(6);
        engine.playKegExplosion(10);
        engine.playGunshot('blunderbuss', 3);
        engine.playGunshot('flintlock', 5);
        engine.playHullImpact(8);
        engine.playThunder(90);
      }
    `,
  });
  console.log(`   music alone, ducked  ${fmt(ducked.analysis)}  → ${save('menu-theme-ducked-by-broadside', ducked.wav)}`);
  const b = ducked.analysis.buckets;
  const mean = (from, to) => b.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
  const beforeBang = mean(5, 19);      // 0.5–1.9 s
  const afterBang = mean(25, 40);      // 2.5–4.0 s
  const recovered = mean(75, 99);      // 7.5–9.9 s
  expect('the broadside ducks the music out of the way',
    afterBang < beforeBang * 0.5, `before=${beforeBang.toFixed(5)} after=${afterBang.toFixed(5)}`);
  expect('…and it comes back up afterwards',
    recovered > afterBang * 1.8, `after=${afterBang.toFixed(5)} recovered=${recovered.toFixed(5)}`);
}

// ── 5. The event sting ──────────────────────────────────────────────────────
console.log('\n5. EVENT STING — bounty / wreck');
const sting = await render({
  seconds: 6,
  setup: '',
  during: "if (Math.abs(t - 0.5) < 0.026) engine.playEventSting('wreck');",
});
console.log(`   ${fmt(sting.analysis)}  → ${save('event-sting-wreck', sting.wav)}`);
expect('playEventSting renders a real 2-bar figure',
  sting.analysis.peak > 0.05 && sting.analysis.onsets >= 3, fmt(sting.analysis));
expect('…and does not clip', sting.analysis.peak < 0.99, `peak=${sting.analysis.peak.toFixed(3)}`);

// ── 6. The live graph on the real app ───────────────────────────────────────
console.log('\n6. LIVE — the real menu, after a real gesture');
{
  const before = await page.evaluate(() => {
    const e = window.__piratesBR?.audio;
    return { context: e?.getMusicContext?.() ?? null, ctxExists: !!e?.ctx };
  });
  expect('the menu arms the air before any gesture', before.context === 'menu', JSON.stringify(before));
  expect('…without constructing an AudioContext yet (no autoplay warning)', before.ctxExists === false,
    JSON.stringify(before));
  // A real user gesture — this is the existing unlock path (body pointerdown).
  await page.mouse.click(20, 20);
  await page.waitForTimeout(1500);
  const live = await page.evaluate(() => {
    const e = window.__piratesBR.audio;
    return {
      state: e.ctx?.state ?? null,
      music: e.getMusicContext(),
      busMusicGain: e.busMusic?.gain?.value ?? null,
      duck: e.musicDuck?.gain?.value ?? null,
      sendGain: e.musicSend?.gain?.value ?? null,
      loops: e.menuLoopIndex,
      timer: e.musicTimer !== null,
      destChannels: e.ctx?.destination?.channelCount ?? null,
    };
  });
  console.log(`   ${JSON.stringify(live)}`);
  expect('the gesture resumed the context', live.state === 'running', JSON.stringify(live));
  expect('the music scheduler is running', live.timer === true);
  expect('the air is playing (≥ 1 loop scheduled)', live.loops >= 1, `loops=${live.loops}`);
  expect('the music bus is open but nowhere near unity',
    live.busMusicGain > 0.05 && live.busMusicGain <= 0.6, `gain=${live.busMusicGain}`);
  expect('nothing is ducking the menu', live.duck > 0.9, `duck=${live.duck}`);
  expect('the score has its reverb send', live.sendGain > 0, `send=${live.sendGain}`);
}

if (pageErrors.length) {
  console.error(`\n  page errors:\n${pageErrors.slice(0, 6).map((e) => `    ${e}`).join('\n')}`);
  failures += pageErrors.length;
}

await browser.close();
console.log(failures === 0
  ? `\nAll music-render checks passed. WAVs in ${OUT}\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
