// AUDIO MODELS (logic tier, pure, b2.4b; audio-01, audio-09, audio-11, vm:performance:1).
//
// Grades the three b2.4b modules and the SoundEngine wiring on a fake Web Audio graph:
//   VoiceAllocator  the concurrent voice count never exceeds the tier cap (64/40/24) under a
//                   200-event burst; a full pool steals the LOWEST priority x gain first and
//                   refuses a newcomer that scores below everything playing; a tier drop sheds
//                   the lowest voices.
//   AudioCore       the ui bus reaches the destination WITHOUT passing the world filter (the
//                   submerged / below-deck muffle); sfx/ambience/music pass it; everything ends
//                   in master -> limiter -> destination. SoundEngine.playUiClick really lands on
//                   the ui path (procedural fallback AND sample), a world one-shot does not.
//   SampleBank      a missing manifest, a missing key, a 404 and a late decode all return null
//                   (caller falls back) without throwing; decodes in flight never exceed 3 and
//                   follow urgent > boot > match > zones; the decoded-PCM LRU never exceeds its
//                   cap (64 MB desktop / 40 MB phone) and evicts; per-kind duration caps refuse
//                   over-long buffers; decodeAudioData works in promise AND callback form; the
//                   shipped manifest fits the caps (no real file is refused, boot+match decoded
//                   PCM fits the phone cap so a match never thrashes).
//
//   Spatial (b2.4c; audio-04, audio-10, audio-15)
//                   per-category distance gain is monotonic non-increasing; a source behind the
//                   listener differs from one ahead (azimuth, panner position, equalpower rear
//                   shade); delay d/343 beyond 30 m with no cap and no 140 m step (139 vs 141 m
//                   < 10 ms, 600 m = 1.749 s) on EVERY positioned one-shot incl. samples; the
//                   cannon crack crossfades over 120-220 m; Doppler ratio within 1% and applied
//                   to the whistle's playbackRate; the AudioListener follows the pose.
//
//   Beds + foley (b2.4e; audio-06, vm:audio:3)
//                   wind by APPARENT wind: > 0 in clear weather under way, a downwind run at wind
//                   speed hears less than beating, rigging whistle only above 8 m/s aboard with
//                   rising pitch; hull creak 0 off-ship whatever the load; 3 ocean layers by sea
//                   state; surf by shore distance; luff flutter rate; sail fill thump at 10% trim;
//                   bow slap once per pitch peak; the director positions anchor/cannon foley at
//                   their stations; the engine's wind voice is audible on clear-weather beds.
//
//   node --import tsx scripts/test-audio-models.mjs
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const { VoiceAllocator, VOICE_CAPS } = await import('../src/client/audio/VoiceAllocator.ts');
const { buildAudioCore, AUDIO_BUSES, combatDuckGains } = await import('../src/client/audio/AudioCore.ts');
const { SampleBank, DECODED_CAP_BYTES, DURATION_CAP_S, MAX_CONCURRENT_DECODES, decodeAudioDataCompat, decodedBytes } =
  await import('../src/client/audio/SampleBank.ts');

// ── seeded rng ──────────────────────────────────────────────────────────────
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1. VoiceAllocator ───────────────────────────────────────────────────────
for (const tier of ['high', 'balanced', 'low']) {
  const alloc = new VoiceAllocator(tier);
  const rand = mulberry(20260801);
  const live = new Map(); // id -> score
  let maxActive = 0;
  let wrongVictim = 0;
  let steals = 0;
  let badRejects = 0;
  for (let i = 0; i < 200; i++) {
    const priority = 1 + Math.floor(rand() * 6);
    const gain = rand();
    const score = priority * gain;
    const minBefore = live.size ? Math.min(...live.values()) : null;
    const full = live.size >= alloc.cap;
    let stoppedScore = null;
    const id = alloc.acquire({
      priority, gain, now: i * 0.001, duration: 5,
      stop: () => { /* filled below via closure over the victim id */ },
    });
    // Identify the victim: the id that vanished from the allocator's accounting.
    if (full && id !== null) {
      steals += 1;
      // exactly one live voice left; it must have been a minimum-score one
      const victims = [...live.entries()].filter(([, s]) => s === minBefore);
      if (victims.length === 0) wrongVictim += 1;
      // remove the oldest minimum (tie rule: oldest)
      live.delete(victims[0][0]);
      stoppedScore = minBefore;
      if (!(stoppedScore < score)) wrongVictim += 1;
    }
    if (full && id === null && !(minBefore >= score)) badRejects += 1;
    if (id !== null) live.set(id, score);
    maxActive = Math.max(maxActive, alloc.active);
    if (alloc.active !== live.size) wrongVictim += 1;
  }
  check(`allocator ${tier}: 200-event burst never exceeds the cap ${VOICE_CAPS[tier]}`, maxActive <= VOICE_CAPS[tier] && maxActive === VOICE_CAPS[tier],
    `peak ${maxActive}, admitted ${alloc.stats.admitted}, stolen ${alloc.stats.stolen}, rejected ${alloc.stats.rejected}`);
  check(`allocator ${tier}: steals the lowest priority x gain, refuses a newcomer below every live voice`,
    wrongVictim === 0 && badRejects === 0 && steals > 0 && alloc.stats.rejected > 0,
    `steals ${steals}, wrong victims ${wrongVictim}, bad rejects ${badRejects}`);
}
{
  // stop callbacks: the stolen voice's own stop() runs; tier shrink sheds lowest first
  const alloc = new VoiceAllocator('high');
  const stopped = [];
  for (let i = 0; i < 64; i++) alloc.acquire({ priority: 1, gain: (i + 1) / 64, now: 0, duration: 10, stop: () => stopped.push(i) });
  alloc.acquire({ priority: 6, gain: 1, now: 0, duration: 10, stop: () => stopped.push('ui') });
  const firstSteal = stopped.slice();
  alloc.setTier('low', 0);
  check('allocator: steal calls the victim stop(); a high->low tier drop sheds to 24 lowest-first',
    firstSteal.length === 1 && firstSteal[0] === 0 && alloc.active === 24 && stopped.length === 1 + 40
      && stopped.slice(1).every((v, k) => v === k + 1) && !stopped.includes('ui'),
    `first ${JSON.stringify(firstSteal)}, active ${alloc.active}, shed ${stopped.length - 1}`);
  alloc.reap(11);
  check('allocator: finished voices free their slots', alloc.active === 0, `active after reap ${alloc.active}`);
}

// ── fake Web Audio graph ────────────────────────────────────────────────────
const created = [];
function fakeParam(v = 0) {
  return { value: v, setValueAtTime() {}, linearRampToValueAtTime(v, at) { this.ramped = v; this.rampAt = at; }, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {},
    setValueCurveAtTime(curve, at, dur) { this.curve = Array.from(curve); this.curveAt = at; this.curveDur = dur; } };
}
function fakeNode(kind) {
  const outs = [];
  const target = { kind, outs, connect(to) { outs.push(to); return to; }, disconnect() { outs.length = 0; },
    start() {}, stop() {}, getChannelData: () => new Float32Array(16), length: 16, duration: 1, numberOfChannels: 2, sampleRate: 48000 };
  const node = new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'symbol' || p === 'then') return undefined;
      t[p] = fakeParam();
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  created.push(node);
  return node;
}
class FakeCtx {
  constructor() {
    this.destination = fakeNode('destination');
    this.currentTime = 1;
    this.state = 'running';
    this.sampleRate = 48000;
    this.listener = fakeNode('listener');
    return new Proxy(this, {
      get(t, p) {
        if (p in t) return t[p];
        if (typeof p === 'string' && p.startsWith('create')) return () => fakeNode(p.slice(6));
        return undefined;
      },
    });
  }
  resume() { return Promise.resolve(); }
  // Real sample storage, so the gate can grade the impulses the engine actually builds (b2.4g).
  createBuffer(ch, len, sr) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => data[c] };
  }
}
/** Every node reachable downstream of `from`. */
function downstream(from) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outs ?? []) stack.push(o);
  }
  return seen;
}

// ── 2. AudioCore topology ───────────────────────────────────────────────────
{
  const ctx = new FakeCtx();
  const core = buildAudioCore(ctx);
  const ui = downstream(core.levels.ui);
  check('core: the ui bus reaches the destination through master and the limiter, NOT the world filter',
    ui.has(ctx.destination) && ui.has(core.master) && ui.has(core.limiter) && !ui.has(core.worldFilter),
    `ui path ${[...ui].map((n) => n.kind).join('>')}`);
  const world = ['sfx', 'ambience', 'music'].every((b) => {
    const d = downstream(core.levels[b]);
    return d.has(core.worldFilter) && d.has(core.limiter) && d.has(ctx.destination);
  });
  check('core: sfx, ambience and music pass the world filter and the limiter', world && AUDIO_BUSES.length === 4);
  // b2.4h: the limiter overshoots on transients in a real render, so a half-scale WaveShaper
  // ceiling follows it (identity below 0.75, never reaching -1.05 dBFS): limiter -> half -> shaper -> out.
  const half = core.limiter.outs.length === 1 ? core.limiter.outs[0] : null;
  const shaper = half?.outs?.length === 1 ? half.outs[0] : null;
  const curve = shaper?.curve ?? null;
  const ceilOk = !!curve && curve.length >= 1024 && Math.max(...Array.from(curve, Math.abs)) < 10 ** (-1 / 20)
    && Math.abs(curve[Math.round((curve.length - 1) * 0.6)] - 0.4) < 2e-3;
  check('core: limiter -> half-scale peak ceiling -> destination (identity below the knee, max < -1 dBFS)',
    !!shaper && shaper.outs.length === 1 && shaper.outs[0] === ctx.destination && half.gain?.value === 0.5 && ceilOk
      && core.limiter.ratio.value >= 12 && core.limiter.threshold.value <= -1);
  const near = combatDuckGains(30);
  const far = combatDuckGains(41);
  check('core: combat within 40 m ducks ambience -6 dB and music -12 dB, never ui',
    Math.abs(20 * Math.log10(near.ambience) + 6) < 0.01 && Math.abs(20 * Math.log10(near.music) + 12) < 0.01 && near.ui === 1 && far.music === 1 && combatDuckGains(NaN).ambience === 1);
}

// ── 3. SoundEngine wiring on the fake context ───────────────────────────────
globalThis.window = { AudioContext: FakeCtx };
const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');
{
  const engine = new SoundEngine();
  engine.unlock();
  const core = engine.core;
  const ctx = engine.ctx;
  check('engine: unlock builds the AudioCore graph (not vacuous)', !!core && !!ctx && !!engine.busUi);
  // procedural UI click (no sample bank in node)
  const before = created.length;
  engine.playUiClick();
  const oscs = created.slice(before).filter((n) => n.kind === 'Oscillator');
  const uiOk = oscs.length > 0 && oscs.every((o) => { const d = downstream(o); return d.has(ctx.destination) && !d.has(core.worldFilter); });
  check('engine: procedural playUiClick reaches the output without the world filter', uiOk, `${oscs.length} oscillators`);
  // a world voice still goes through the world filter
  const worldMethod = ['playSplash', 'playWoodHit', 'playCannonFire', 'playImpact'].find((m) => typeof engine[m] === 'function');
  const b2 = created.length;
  engine[worldMethod]?.({ x: 3, y: 0, z: 3 });
  const worldSrc = created.slice(b2).filter((n) => n.kind === 'Oscillator' || n.kind === 'BufferSource');
  check(`engine: a world one-shot (${worldMethod}) still passes the world filter`,
    worldSrc.length > 0 && worldSrc.every((s) => downstream(s).has(core.worldFilter)), `${worldSrc.length} sources`);
  // bus sliders
  engine.setBusVolume('music', 0.25);
  engine.setBusVolume('ui', NaN);
  check('engine: setBusVolume writes the bus level; NaN keeps the last value',
    core.levels.music.gain.value === 0.25 && core.levels.ui.gain.value === 1 && engine.getBusVolume('music') === 0.25);

  // sample path: a bank with a decoded ui.click plays a BufferSource on the ui bus
  const buf = { duration: 0.12, length: 5760, numberOfChannels: 1 };
  const bank = new SampleBank({ fetchBytes: async () => new ArrayBuffer(8), decode: async () => buf }, { capBytes: DECODED_CAP_BYTES.desktop });
  bank.setManifest({ keys: { 'ui.click': { tier: 'boot', kind: 'ui', files: [{ file: 'boot/ui.click.1.mp3', bytes: 1, duration: 0.12, channels: 1 }] } } });
  engine.bank = bank;
  engine.playUiClick(); // first call: late -> procedural fallback, kicks the load
  await new Promise((r) => setTimeout(r, 5));
  const b3 = created.length;
  engine.playUiClick();
  const srcs = created.slice(b3).filter((n) => n.kind === 'BufferSource');
  const oscs3 = created.slice(b3).filter((n) => n.kind === 'Oscillator');
  check('engine: a decoded ui.click plays as ONE sample voice on the ui bus (no oscillators, no world filter)',
    srcs.length === 1 && oscs3.length === 0 && srcs[0].buffer === buf && !downstream(srcs[0]).has(core.worldFilter) && downstream(srcs[0]).has(ctx.destination),
    `${srcs.length} buffer sources, ${oscs3.length} oscillators`);
  let threw = null;
  let r1;
  let r2;
  try { r1 = engine.playSample('does.not.exist'); r2 = engine.playSample(undefined); } catch (e) { threw = e; }
  check('engine: playSample on a missing key returns false (caller falls back) and never throws', !threw && r1 === false && r2 === false);
  const b4 = created.length;
  bank.setManifest({ keys: {} });
  engine.playUiHover();
  check('engine: playUiHover with no ui.hover sample falls back to the procedural voice',
    created.slice(b4).some((n) => n.kind === 'Oscillator'));
}

// ── 3a. HRTF follows the render tier (b2-device-02) ─────────────────────────
{
  const e = new SoundEngine();
  e.unlock();
  e.setListenerPose({ x: 0, y: 0, z: 0 }, 0);
  const fresh = () => { const b = created.length; e.playCannonFire(20, { x: 20, y: 0, z: 0 }); return created.slice(b).filter((n) => n.kind === 'Panner').map((n) => n.panningModel); };
  e.setAudioTier('balanced');
  const bal = fresh();
  e.setAudioTier('high');
  const hi = fresh();
  check('engine: balanced tier positions with equalpower, high-tier desktop with HRTF',
    bal.length > 0 && bal.every((m) => m === 'equalpower') && hi.length > 0 && hi.every((m) => m === 'HRTF'), `balanced ${bal.join()} / high ${hi.join()}`);
  const { readFileSync } = await import('node:fs');
  const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  check('wiring: Game hands the render tier to the audio engine (setAudioTier(renderer.getQuality()))',
    /this\.audio\.setAudioTier\(this\.renderer\.getQuality\(\)\)/.test(game));
}

// ── 3b. the combat duck is the ENGINE's, not just the helper's (b2-ask-07) ──
{
  const gainOf = (n) => (n?.gain?.ramped ?? n?.gain?.value);
  const near = new SoundEngine();
  near.unlock();
  near.setListenerPose({ x: 0, y: 0, z: 0 }, 0);
  near.playCannonFire(30, { x: 30, y: 0, z: 0 });
  const amb = near.combatDuckAmb;
  const mus = near.combatDuckMusic;
  const db = (g) => 20 * Math.log10(g);
  check('engine: a cannon 30 m away ducks the ambience bed -6 dB and the music -12 dB on the live nodes',
    !!amb && !!mus && Math.abs(db(gainOf(amb)) + 6) < 0.05 && Math.abs(db(gainOf(mus)) + 12) < 0.05,
    amb && mus ? `ambience ${db(gainOf(amb)).toFixed(2)} dB, music ${db(gainOf(mus)).toFixed(2)} dB` : 'no combat duck nodes');
  const d = amb ? downstream(near.occGain) : new Set();
  check('engine: the ambience bed and the music run through the combat duck nodes to the output',
    !!amb && d.has(amb) && d.has(near.ctx.destination) && downstream(near.musicDuck).has(mus) && !downstream(near.busUi).has(amb));
  near.ctx.currentTime += 6;
  near.setListenerPose({ x: 0, y: 0, z: 0 }, 0);
  check('engine: 6 s after the last shot the beds come back to 0 dB', !!amb && gainOf(amb) === 1 && gainOf(mus) === 1,
    amb ? `ambience ${gainOf(amb)}, music ${gainOf(mus)}` : 'no nodes');
  const far = new SoundEngine();
  far.unlock();
  far.playCannonFire(45, { x: 45, y: 0, z: 0 });
  check('engine: a cannon 45 m away does not engage the 40 m combat duck',
    !!far.combatDuckAmb && gainOf(far.combatDuckAmb) === 1 && gainOf(far.combatDuckMusic) === 1);
}

// ── 4. SampleBank ───────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));
async function drain(bank) { for (let i = 0; i < 2000 && (bank.decodesInFlight > 0); i++) await tick(); await tick(); }
{
  // missing manifest / 404 / late
  const noManifest = new SampleBank({ fetchBytes: async () => { throw new Error('404'); }, decode: async () => ({}) }, { capBytes: 1e6 });
  let threw = null;
  let ok;
  try { ok = await noManifest.loadManifest('/assets/audio/manifest.json'); } catch (e) { threw = e; }
  check('bank: a missing manifest resolves false and every pick is null', !threw && ok === false && noManifest.pick('ui.click') === null);

  const man = { keys: { 'wood.crack': { tier: 'match', kind: 'oneshot', files: [{ file: 'a.mp3', duration: 1, channels: 1 }, { file: 'b.mp3', duration: 1, channels: 1 }] } } };
  const b404 = new SampleBank({ fetchBytes: async () => { throw new Error('HTTP 404'); }, decode: async () => ({}) }, { capBytes: 1e6 });
  b404.setManifest(man);
  const p1 = b404.pick('wood.crack');
  await drain(b404);
  const p2 = b404.pick('wood.crack');
  check('bank: a 404 sample falls back (null) without throwing and is not retried every frame',
    p1 === null && p2 === null && b404.stats.failed === 2 && b404.decodesInFlight === 0, `failed ${b404.stats.failed}`);

  let release;
  const gate = new Promise((r) => { release = r; });
  const late = new SampleBank({ fetchBytes: async () => new ArrayBuffer(4), decode: async () => { await gate; return { duration: 1, length: 48000, numberOfChannels: 1 }; } }, { capBytes: 1e7 });
  late.setManifest(man);
  const l1 = late.pick('wood.crack');
  await tick();
  const l2 = late.pick('wood.crack');
  release();
  await drain(late);
  const l3 = late.pick('wood.crack', () => 0);
  const l4 = late.pick('wood.crack', () => 0);
  check('bank: a late decode falls back until ready, then plays; variants do not repeat back to back',
    l1 === null && l2 === null && l3 && l4 && l3.file.file !== l4.file.file, `${l3?.file.file} then ${l4?.file.file}`);
}
{
  // concurrency + priority
  const order = [];
  let inflight = 0;
  let peak = 0;
  const waiters = [];
  const keys = {};
  for (const [tier, n] of [['zones', 5], ['boot', 3], ['match', 3]]) {
    for (let i = 0; i < n; i++) keys[`${tier}.${i}`] = { tier, kind: 'oneshot', files: [{ file: `${tier}.${i}.mp3`, duration: 1, channels: 1 }] };
  }
  const bank = new SampleBank({
    fetchBytes: async (url) => { order.push(url.replace('/assets/audio/', '').replace('.mp3', '')); inflight += 1; peak = Math.max(peak, inflight); await new Promise((r) => waiters.push(r)); inflight -= 1; return new ArrayBuffer(4); },
    decode: async () => ({ duration: 1, length: 48000, numberOfChannels: 1 }),
  }, { capBytes: 1e8 });
  bank.setManifest({ keys });
  bank.preloadTier('zones');
  bank.preloadTier('match');
  bank.preloadTier('boot');
  bank.request('zones.4');
  for (let i = 0; i < 400 && order.length < 11; i++) { await tick(); const w = waiters.shift(); if (w) w(); }
  while (waiters.length) waiters.shift()();
  await drain(bank);
  const after = order.slice(3);
  const want = ['zones.4', 'boot.0', 'boot.1', 'boot.2', 'match.0', 'match.1', 'match.2', 'zones.3'];
  check(`bank: at most ${MAX_CONCURRENT_DECODES} decodes in flight, taken urgent > boot > match > zones`,
    peak === MAX_CONCURRENT_DECODES && bank.stats.peakInFlight === MAX_CONCURRENT_DECODES && JSON.stringify(after) === JSON.stringify(want),
    `peak ${peak}; order after the first 3: ${after.join(',')}`);
}
{
  // LRU cap + duration caps
  const cap = DECODED_CAP_BYTES.phone;
  const keys = {};
  for (let k = 0; k < 60; k++) keys[`k${k}`] = { tier: 'match', kind: 'oneshot', files: [0, 1, 2].map((i) => ({ file: `k${k}.${i}.mp3`, duration: 3, channels: 2 })) };
  keys['long.shot'] = { tier: 'zones', kind: 'oneshot', files: [{ file: 'long.mp3', duration: 5, channels: 1 }] };
  keys['bed.ok'] = { tier: 'zones', kind: 'bed', loop: true, files: [{ file: 'bedok.mp3', duration: 10, channels: 2 }] };
  keys['bed.long'] = { tier: 'zones', kind: 'bed', loop: true, files: [{ file: 'bedlong.mp3', duration: 14, channels: 2 }] };
  let overCap = 0;
  let bank;
  bank = new SampleBank({
    fetchBytes: async (url) => new TextEncoder().encode(url).buffer,
    decode: async (bytes) => {
      if (bank.decodedBytes > cap) overCap += 1;
      const url = new TextDecoder().decode(bytes);
      const d = url.includes('long.mp3') && !url.includes('bed') ? 5 : url.includes('bedlong') ? 14 : url.includes('bedok') ? 10 : 3;
      return { duration: d, length: Math.round(d * 48000), numberOfChannels: url.includes('long.mp3') ? 1 : 2 };
    },
  }, { capBytes: cap });
  bank.setManifest({ keys });
  bank.preloadTier('match');
  bank.preloadTier('zones');
  await drain(bank);
  const requested = 60 * 3 * decodedBytes({ length: 3 * 48000, numberOfChannels: 2 });
  check(`bank: decoded PCM stays under the ${cap / 1048576} MB phone cap and evicts LRU`,
    bank.decodedBytes <= cap && overCap === 0 && bank.stats.evicted > 0 && requested > cap,
    `held ${(bank.decodedBytes / 1048576).toFixed(1)} MB of ${(requested / 1048576).toFixed(1)} MB requested, evicted ${bank.stats.evicted}`);
  check('bank: per-kind duration caps refuse a 5 s one-shot and a 14 s loop, keep a 10 s loop',
    bank.pick('long.shot') === null && bank.pick('bed.long') === null && bank.pick('bed.ok')?.loop === true && bank.stats.refusedDuration === 2,
    `refused ${bank.stats.refusedDuration}, caps ${JSON.stringify(DURATION_CAP_S)}`);
}
{
  // decodeAudioData, both signatures
  const buf = { duration: 1 };
  const cbOnly = { decodeAudioData(_b, ok) { setTimeout(() => ok(buf), 1); return undefined; } };
  const promOnly = { decodeAudioData() { return Promise.resolve(buf); } };
  let calls = 0;
  const both = { decodeAudioData(_b, ok) { ok(buf); calls += 1; return Promise.resolve(buf); } };
  const throws = { decodeAudioData() { throw new TypeError('bad data'); } };
  const cbErr = { decodeAudioData(_b, _ok, err) { setTimeout(() => err(new Error('EncodingError')), 1); } };
  const r = await Promise.all([cbOnly, promOnly, both].map((c) => decodeAudioDataCompat(c, new ArrayBuffer(1))));
  const rejects = await Promise.all([throws, cbErr].map((c) => decodeAudioDataCompat(c, new ArrayBuffer(1)).then(() => false, () => true)));
  check('bank: decodeAudioData works in callback-only, promise-only and dual form; errors reject',
    r.every((x) => x === buf) && calls === 1 && rejects.every(Boolean));
}
{
  // the shipped manifest fits the caps
  const man = JSON.parse(readFileSync(`${ROOT}public/assets/audio/manifest.json`, 'utf8'));
  const sr = man.sampleRate || 48000;
  let refused = [];
  const tierBytes = { boot: 0, match: 0, zones: 0 };
  for (const [key, e] of Object.entries(man.keys)) {
    for (const f of e.files) {
      if (!(f.duration <= DURATION_CAP_S[e.kind] + 0.05)) refused.push(`${key}:${f.duration}s`);
      tierBytes[e.tier] += decodedBytes({ length: Math.ceil(f.duration * sr), numberOfChannels: f.channels });
    }
  }
  const bootMatch = tierBytes.boot + tierBytes.match;
  const mb = (b) => (b / 1048576).toFixed(1);
  check('bank: every shipped file fits its kind duration cap; boot+match decoded PCM fits the phone cap',
    refused.length === 0 && bootMatch <= DECODED_CAP_BYTES.phone && Object.keys(man.keys).length > 0,
    `refused ${refused.join(',') || 'none'}; decoded boot ${mb(tierBytes.boot)} + match ${mb(tierBytes.match)} + zones ${mb(tierBytes.zones)} MB`);
}

// ── 5. Spatial (b2.4c) ──────────────────────────────────────────────────────
{
  const S = await import('../src/client/audio/Spatial.ts');
  // gain laws
  const bad = [];
  for (const [cat, c] of Object.entries(S.SPATIAL_CATEGORIES)) {
    let prev = Infinity;
    for (let d = 0; d <= 2000; d += 0.5) {
      const g = S.gainFor(cat, d);
      if (!(g <= prev + 1e-12) || !(g > 0) || !(g <= 1)) { bad.push(`${cat}@${d}`); break; }
      prev = g;
    }
    if (!(S.gainFor(cat, 0) === 1 && S.gainFor(cat, c.max) < 0.5)) bad.push(`${cat}:range`);
  }
  const oldDb = Math.max(...[0, 1, 5, 24, 100, 300].map((d) => Math.abs(20 * Math.log10(S.gainFor('default', d) * (1 + d / 24)))));
  check('spatial: gain monotonic non-increasing in distance for every category, 1 at 0 m, < -6 dB at max; default within 1 dB of the old 1/(1+d/24)',
    bad.length === 0 && Object.keys(S.SPATIAL_CATEGORIES).length >= 8 && oldDb < 1 && S.gainFor('footstep', 30) < S.gainFor('cannon', 30),
    `bad ${bad.join(',') || 'none'}; default vs old max ${oldDb.toFixed(2)} dB; footstep@30 ${S.gainFor('footstep', 30).toFixed(3)} cannon@30 ${S.gainFor('cannon', 30).toFixed(3)}`);
  let airOk = true;
  for (let d = 0; d < 2000; d += 1) if (!(S.airCutoffFor(d + 1) <= S.airCutoffFor(d)) || S.airCutoffFor(d + 1) / S.airCutoffFor(d) < 0.9) airOk = false;
  check('spatial: air absorption cutoff is continuous and monotonic (no steps)', airOk && S.airCutoffFor(30) > 7000 && S.airCutoffFor(600) < 2500,
    `30 m ${S.airCutoffFor(30).toFixed(0)} Hz, 120 m ${S.airCutoffFor(120).toFixed(0)}, 600 m ${S.airCutoffFor(600).toFixed(0)}`);
  // speed of sound
  const d139 = S.delayFor(139), d141 = S.delayFor(141), d600 = S.delayFor(600);
  let delayCont = true;
  for (let d = 0; d < 1000; d += 0.25) if (Math.abs(S.delayFor(d + 0.25) - S.delayFor(d)) > 0.002 || S.delayFor(d + 0.25) < S.delayFor(d)) delayCont = false;
  check('spatial: delayFor(139) vs delayFor(141) < 10 ms; delayFor(600) = 1.749 +- 0.005 s; no cap (2000 m = 5.83 s); continuous, 0 at 0 m, < 10 ms inside 10 m',
    Math.abs(d141 - d139) < 0.010 && Math.abs(d600 - 1.749) <= 0.005 && Math.abs(S.delayFor(2000) - 2000 / 343) < 1e-9 && delayCont && S.delayFor(0) === 0 && S.delayFor(10) < 0.010 && S.delayFor(NaN) === 0,
    `139 ${d139.toFixed(4)} 141 ${d141.toFixed(4)} 600 ${d600.toFixed(4)} s`);
  let crackCont = true;
  for (let d = 0; d < 400; d += 1) if (Math.abs(S.crackMix(d + 1) - S.crackMix(d)) > 0.02 || S.crackMix(d + 1) > S.crackMix(d)) crackCont = false;
  check('spatial: cannon crack crossfades out over 120-220 m (1 inside, 0 beyond, no step)',
    crackCont && S.crackMix(120) === 1 && S.crackMix(220) === 0 && S.crackMix(170) > 0.4 && S.crackMix(170) < 0.6, `170 m ${S.crackMix(170).toFixed(3)}`);
  // direction
  const L = { x: 0, y: 0, z: 0 }, F = { x: 0, y: 0, z: -1 };
  const ahead = S.listenerRelative(L, F, { x: 0, y: 0, z: -50 });
  const behind = S.listenerRelative(L, F, { x: 0, y: 0, z: 50 });
  const right = S.listenerRelative(L, F, { x: 50, y: 0, z: 0 });
  check('spatial: a source behind differs from one ahead (azimuth 0 vs 180, rear shade darker), right is +90',
    Math.abs(ahead.azimuthDeg) < 1e-6 && Math.abs(Math.abs(behind.azimuthDeg) - 180) < 1e-6 && Math.abs(right.azimuthDeg - 90) < 1e-6
      && S.rearShade(behind.cosFront).cutoffMul < S.rearShade(ahead.cosFront).cutoffMul && S.rearShade(ahead.cosFront).gainMul === 1,
    `ahead ${ahead.azimuthDeg.toFixed(1)} behind ${behind.azimuthDeg.toFixed(1)} right ${right.azimuthDeg.toFixed(1)}`);
  // Doppler
  const exact = (v) => 343 / (343 - v);
  const rDop = [5, 56, -56, 120].map((v) => Math.abs(S.dopplerRatio(v) / exact(v) - 1));
  const curve = S.flybyDopplerCurve(2, 56, 0.7, 0.35, 65);
  const vr0 = (56 * 56 * 0.35) / Math.hypot(2, 56 * 0.35);
  check('spatial: Doppler ratio within 1% (c/(c-v), 1+v/343 at walking speed); fly-by curve starts high, 1 at closest approach, ends low',
    Math.max(...rDop) < 0.01 && Math.abs(S.dopplerRatio(5) / (1 + 5 / 343) - 1) < 0.01 && Math.abs(curve[0] / exact(vr0) - 1) < 0.01
      && Math.abs(curve[32] - 1) < 1e-6 && curve[64] < 0.9 && Number.isFinite(S.dopplerRatio(1e9)),
    `56 m/s ${S.dopplerRatio(56).toFixed(4)} (exact ${exact(56).toFixed(4)}); curve ${curve[0].toFixed(3)} -> ${curve[32].toFixed(3)} -> ${curve[64].toFixed(3)}`);
  check('spatial: HRTF on high desktop only', S.panningModelFor('high', false) === 'HRTF' && S.panningModelFor('high', true) === 'equalpower' && S.panningModelFor('balanced', false) === 'equalpower');

  // engine wiring
  const engine = new SoundEngine();
  engine.unlock();
  const ctx = engine.ctx;
  engine.setListenerPose({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: -1 });
  const lis = ctx.listener;
  check('engine: setListenerPose drives the AudioListener (position, forward, up)',
    lis.positionX.value === 1 && lis.positionY.value === 2 && lis.positionZ.value === 3 && lis.forwardZ.value === -1 && lis.upY.value === 1);
  engine.setListenerPose({ x: 0, y: 0, z: 0 }, 0);
  const fire = (fn) => { const b = created.length; fn(); return created.slice(b); };
  const delayOf = (nodes) => nodes.filter((n) => n.kind === 'Delay').map((n) => n.delayTime.value);
  const near139 = fire(() => engine.playAt('cannonFire', 139, { pos: { x: 0, y: 0, z: -139 } }));
  const far141 = fire(() => engine.playKegExplosion(141, { x: 0, y: 0, z: -141 }));
  engine.lastPlayed?.clear?.();
  const far600 = fire(() => engine.playKegExplosion(600, { x: 0, y: 0, z: -600 }));
  const [e139] = delayOf(near139), [e141] = delayOf(far141), [e600] = delayOf(far600);
  check('engine: positioned one-shots are delayed d/343 in the graph (cannon 139 m vs keg 141 m < 10 ms apart; keg 600 m = 1.749 s, not the old 1.2 s cap)',
    Math.abs(e141 - e139) < 0.010 && Math.abs(e600 - 1.749) <= 0.005, `139 ${e139} 141 ${e141} 600 ${e600}`);
  const srcs139 = near139.filter((n) => n.kind === 'Oscillator' || n.kind === 'BufferSource');
  const panners = near139.filter((n) => n.kind === 'Panner');
  check('engine: a positioned one-shot runs through ONE world PannerNode at the source (HRTF on high desktop) and every voice passes it',
    panners.length === 1 && panners[0].positionZ.value === -139 && panners[0].panningModel === 'HRTF' && panners[0].rolloffFactor === 0
      && srcs139.length > 0 && srcs139.every((s) => downstream(s).has(panners[0])), `${panners.length} panners, ${srcs139.length} sources`);
  engine.setAudioTier('balanced');
  const lp = (nodes) => nodes.filter((n) => n.kind === 'BiquadFilter' && n.type === 'lowpass')[0]?.frequency.value;
  const fAhead = fire(() => engine.playSplash(1, 20, { x: 0, y: 0, z: -20 }));
  const fBehind = fire(() => engine.playSplash(1, 20, { x: 0, y: 0, z: 20 }));
  const pA = fAhead.find((n) => n.kind === 'Panner'), pB = fBehind.find((n) => n.kind === 'Panner');
  check('engine: equalpower off the high tier; a splash behind is placed behind and darker than the same splash ahead',
    pA?.panningModel === 'equalpower' && pA.positionZ.value === -20 && pB?.positionZ.value === 20 && lp(fBehind) < lp(fAhead),
    `ahead lp ${lp(fAhead)} behind lp ${lp(fBehind)}`);
  engine.setAudioTier('high');
  // samples pick up the same chain
  const sbuf = { duration: 0.5, length: 24000, numberOfChannels: 1 };
  const sbank = new SampleBank({ fetchBytes: async () => new ArrayBuffer(8), decode: async () => sbuf }, { capBytes: DECODED_CAP_BYTES.desktop });
  sbank.setManifest({ keys: { 'wood.crack': { tier: 'match', kind: 'oneshot', files: [{ file: 'match/wood.crack.1.mp3', bytes: 1, duration: 0.5, channels: 1 }] } } });
  sbank.preloadTier?.('match');
  engine.bank = sbank;
  engine.playSample('wood.crack', { pos: { x: 0, y: 0, z: -600 } });
  await new Promise((r) => setTimeout(r, 5));
  const sNodes = fire(() => engine.playSample('wood.crack', { pos: { x: 0, y: 0, z: 600 } }));
  const sSrc = sNodes.find((n) => n.kind === 'BufferSource');
  const sDelay = sNodes.find((n) => n.kind === 'Delay');
  const sPan = sNodes.find((n) => n.kind === 'Panner');
  check('engine: a positioned SAMPLE gets the same delay + panner chain (600 m behind -> 1.749 s, panner at +600)',
    !!sSrc && !!sDelay && !!sPan && Math.abs(sDelay.delayTime.value - 1.749) <= 0.005 && sPan.positionZ.value === 600 && downstream(sSrc).has(sDelay) && downstream(sSrc).has(sPan),
    `delay ${sDelay?.delayTime.value}`);
  // Doppler on the whistle
  engine.bank = null;
  const wNodes = fire(() => engine.playCannonballWhistle(3, { x: 3, y: 0, z: 0 }, 0));
  const wSrc = wNodes.find((n) => n.kind === 'BufferSource' && n.playbackRate.curve);
  const wc = wSrc?.playbackRate.curve ?? [];
  check('engine: the cannonball whistle rides a Doppler playbackRate curve (approach > 1.1, recede < 0.9)',
    wc.length > 8 && wc[0] > 1.1 && wc[wc.length - 1] < 0.9, `rate ${wc[0]?.toFixed(3)} -> ${wc[wc.length - 1]?.toFixed(3)}`);
}

// ── 5. Beds by physics + ship handling foley (b2.4e; audio-06, vm:audio:3) ─────
{
  const D = await import('../src/client/audio/AudioDirector.ts');
  const { hullCreakStrain } = await import('../src/client/audio/SoundEngine.ts');
  // True wind 0.9 strength (6.3 m/s) blowing toward +z (direction 0).
  const ship8Up = D.apparentWind(0, 0.9, 0, -8);            // beating straight into it at 8 m/s
  const runAtWind = D.apparentWind(0, 0.9, 0, 0.9 * D.WIND_MS_PER_STRENGTH); // dead run at wind speed
  const clearUnderway = D.windBedLevels({ apparentMs: D.apparentWind(0, 0.9, 8, 0).speed, storm01: 0, aboard: true });
  check('wind: clear weather under way (8 m/s beam reach, storm 0) has wind > 0 (breeze layer and total)',
    clearUnderway.breeze > 0.2 && clearUnderway.total > 0.2 && clearUnderway.gale === 0,
    `apparent ${D.apparentWind(0, 0.9, 8, 0).speed.toFixed(2)} m/s, breeze ${clearUnderway.breeze.toFixed(3)}, total ${clearUnderway.total.toFixed(3)}`);
  const beat = D.windBedLevels({ apparentMs: ship8Up.speed, storm01: 0, aboard: true });
  const run = D.windBedLevels({ apparentMs: runAtWind.speed, storm01: 0, aboard: true });
  check('wind: a downwind run at wind speed hears less than beating upwind (apparent, not true, wind)',
    runAtWind.speed < 0.01 && run.total < beat.total * 0.2 && beat.total > 0.5,
    `run ${runAtWind.speed.toFixed(3)} m/s total ${run.total.toFixed(3)} vs beat ${ship8Up.speed.toFixed(2)} m/s total ${beat.total.toFixed(3)}`);
  const r7 = D.windBedLevels({ apparentMs: 7.9, storm01: 0, aboard: true });
  const r12 = D.windBedLevels({ apparentMs: 12, storm01: 0, aboard: true });
  const r16 = D.windBedLevels({ apparentMs: 16, storm01: 0, aboard: true });
  const r12ashore = D.windBedLevels({ apparentMs: 12, storm01: 0, aboard: false });
  check('wind: rigging whistle 0 below 8 m/s apparent, rises above it with pitch, silent ashore; gale follows the storm',
    r7.rigging === 0 && r12.rigging > 0 && r16.rigging > r12.rigging && r16.riggingHz > r12.riggingHz && r12ashore.rigging === 0
      && D.windBedLevels({ apparentMs: 3, storm01: 0.8, aboard: false }).gale >= 0.8,
    `rigging 7.9=${r7.rigging} 12=${r12.rigging.toFixed(3)}@${r12.riggingHz}Hz 16=${r16.rigging.toFixed(3)}@${r16.riggingHz}Hz`);
  check('creak: 0 off-ship even under full heel and load; load raises it aboard',
    hullCreakStrain({ aboard: false, nearHullM: 300, heel01: 1, rough01: 1, load01: 1 }) === 0
      && hullCreakStrain({ aboard: false, heel01: 1, rough01: 1, load01: 1 }) === 0
      && hullCreakStrain({ aboard: true, heel01: 0.2, rough01: 0.1, load01: 0.8 }) > hullCreakStrain({ aboard: true, heel01: 0.2, rough01: 0.1, load01: 0 })
      && D.creakLoad01({ heel01: 0, apparentMs: 14, sailHeight: 1 }) > D.creakLoad01({ heel01: 0, apparentMs: 14, sailHeight: 0.2 }),
    `aboard load 0.8 ${hullCreakStrain({ aboard: true, heel01: 0.2, rough01: 0.1, load01: 0.8 }).toFixed(3)} vs 0 ${hullCreakStrain({ aboard: true, heel01: 0.2, rough01: 0.1, load01: 0 }).toFixed(3)}`);
  const seas = [0, 0.25, 0.5, 0.75, 1].map((sea) => D.oceanLayers({ sea01: sea, night01: 0, swimming: false, underway01: 0 }));
  check('ocean: three layers, swell and chop rise with sea state, calm sea has no chop but a lap',
    seas.every((l, i) => i === 0 || (l.swell > seas[i - 1].swell && l.chop >= seas[i - 1].chop)) && seas[0].chop === 0 && seas[0].lap > 0.3 && seas[4].chop > 0.8,
    seas.map((l) => `${l.swell.toFixed(2)}/${l.lap.toFixed(2)}/${l.chop.toFixed(2)}`).join(' '));
  const surf = [0, 4, 20, 45, 89, 90, 400, Infinity].map(D.surfLevel);
  check('surf: 1 on the beach, falling with shore distance, 0 past 90 m',
    surf[0] === 1 && surf[1] === 1 && surf[2] < 1 && surf[3] < surf[2] && surf[4] < surf[3] && surf[4] > 0 && surf[5] === 0 && surf[6] === 0 && surf[7] === 0,
    surf.map((v) => v.toFixed(3)).join(' '));
  check('luff: flutter rate rises with apparent wind, bounded 2..11 Hz',
    D.luffFlutterHz(2) < D.luffFlutterHz(8) && D.luffFlutterHz(8) < D.luffFlutterHz(16) && D.luffFlutterHz(0) >= 2 && D.luffFlutterHz(1e6) <= 11 && D.luffFlutterHz(NaN) >= 2,
    `2 m/s ${D.luffFlutterHz(2).toFixed(2)} Hz, 16 m/s ${D.luffFlutterHz(16).toFixed(2)} Hz`);
  const fd = new D.SailFillDetector();
  fd.update(0.8, 0, false, 8);
  const small = fd.update(0.85, 0, false, 8);
  const big = fd.update(0.92, 0, false, 8);                 // cumulative 12% -> thump
  const calm = new D.SailFillDetector(); calm.update(0.5, 0, false, 0); const noWind = calm.update(0.9, 0, false, 0);
  const lf = new D.SailFillDetector(); lf.update(0.9, 0, true, 8); const refill = lf.update(0.9, 0, false, 8);
  check('sail fill: a 5% trim step is silent, the step that reaches 10% thumps, no thump without wind, a luffing sail filling thumps',
    small === 0 && big > 0 && noWind === 0 && refill > 0, `small ${small} big ${big.toFixed(3)} noWind ${noWind} refill ${refill.toFixed(3)}`);
  const bs = new D.BowSlapDetector();
  let slaps = 0;
  for (let i = 0; i < 60 * 20; i++) if (bs.update(0.06 * Math.sin((i / 60) * 2 * Math.PI * 0.2), 1 / 60, 0.6) > 0) slaps += 1;
  const flat = new D.BowSlapDetector();
  let flatSlaps = 0;
  for (let i = 0; i < 60 * 20; i++) if (flat.update(0.004 * Math.sin((i / 60) * 2 * Math.PI * 0.2), 1 / 60, 0) > 0) flatSlaps += 1;
  check('bow slap: one slap per bow-dip peak on a 5 s pitch cycle (4 in 20 s), none on a flat sea',
    slaps === 4 && flatSlaps === 0, `pitching ${slaps}, flat ${flatSlaps}`);

  // Director on a fake sink: foley lands at its station.
  const calls = [];
  const sink = new Proxy({}, { get: (_t, name) => (...args) => calls.push({ name, args }) });
  const dir = new D.AudioDirector(sink);
  const ship = { id: 's1', type: 'sloop', position: { x: 100, y: 0, z: 50 }, rotation: 0, velocity: { x: 0, y: 0, z: 8 },
    angularVelocity: 0, sailHeight: 0.8, sailAngle: 0, anchored: false, anchorRaiseProgress: 0, cannonCooldowns: [2, 0], roll: 0.1, pitch: 0, luffing: false };
  const frame = (over = {}) => ({ dt: 1 / 60, time: 10, listener: { x: 100, y: 2, z: 50 }, nightFactor: 0, storminess: 0, rain01: 0, swimming: false,
    shoreDistM: Infinity, storm: null, aboardShip: ship, crewShip: ship, ships: [ship], atHelm: false, helmIntent: 0, ...over });
  dir.update(frame());
  const amb = calls.find((c) => c.name === 'setAmbience')?.args[0];
  const sail = calls.find((c) => c.name === 'setSailingState')?.args[0];
  check('director: drives setAmbience with apparent-wind beds (clear weather under way -> breeze > 0) and setSailingState with load + luff rate',
    !!amb?.beds && amb.beds.wind.breeze > 0 && amb.storminess === 0 && sail?.aboard === true && sail.load01 > 0 && sail.luffHz >= 2,
    `apparent ${dir.last.apparentMs.toFixed(2)} m/s breeze ${amb?.beds?.wind.breeze?.toFixed(3)}`);
  calls.length = 0;
  ship.anchored = true; ship.cannonCooldowns = [0, 0];
  dir.update(frame());
  const L = (await import('../src/shared/constants/index.ts')).SHIP_STATS.sloop.length;
  const anchor = calls.find((c) => c.name === 'playAnchorChange');
  const load = calls.find((c) => c.name === 'playCannonLoad');
  check('director: anchor run-out at the bow station (+0.42 L), cannon load/ram at the gun that just came ready, both positioned',
    anchor?.args[0] === true && Math.abs(anchor.args[1].z - (50 + L * 0.42)) < 1e-6 && Math.abs(anchor.args[1].x - 100) < 1e-6 && anchor.args[2] > 0
      && !!load && Number.isFinite(load.args[0]?.x) && calls.filter((c) => c.name === 'playCannonLoad').length === 1,
    `anchor ${JSON.stringify(anchor?.args[1])}, load ${JSON.stringify(load?.args[0])}`);

  // Engine on the fake graph.
  const engine = new SoundEngine();
  engine.unlock();
  engine.setAmbience({ nightFactor: 0, storminess: 0, nearShore01: 0, rain01: 0, beds: amb.beds });
  const windGain = engine.windLevel?.() ?? 0;
  check('engine: clear-weather beds from the director make the wind voice audible (old code stopped it at storm 0)',
    windGain > 0, `wind level ${windGain}`);
  engine.setListenerPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }); // no pose = no panner (by design)
  const before = created.length;
  engine.playAnchorChange(true, { x: 0, y: 0, z: -30 }, 30);
  const pan = created.slice(before).find((n) => n.kind === 'Panner');
  check('engine: station foley is positioned (anchor at z=-30 gets a world panner there)', !!pan && pan.positionZ.value === -30);
}

// ── 7. Spaces: below-deck occlusion + damped IRs (b2.4g; audio-05, audio-12) ─────────────
{
  const R = await import('../src/client/audio/reverb.ts');
  const hold = R.occlusionFor({ inHold: true, aboard: true });
  const open = R.occlusionFor({});
  const top = R.occlusionFor({ aboard: true });
  check('space: occlusionFor({inHold}) cutoff <= 1000 Hz, gain <= -6 dB over ~250 ms; own creak +6, own flood +4',
    hold.outsideCutoffHz <= 1000 && hold.outsideGainDb <= -6 && Math.abs(hold.rampS - 0.25) < 1e-9 && hold.ownCreakDb === 6 && hold.ownFloodDb === 4 && hold.space === 'hold',
    JSON.stringify(hold));
  check('space: outdoor is open (20 kHz, 0 dB); topside hears its own hold at 1.2 kHz -6 dB',
    open.outsideCutoffHz >= 20000 && open.outsideGainDb === 0 && open.ownFloodDb === 0
      && top.outsideCutoffHz >= 20000 && top.ownFloodCutoffHz === 1200 && top.ownFloodDb === -6,
    `open ${JSON.stringify(open)} topside ${JSON.stringify(top)}`);

  // Band energies of the LAST half of an IR (radix-2 FFT, zero-padded).
  const bands = (data, sr) => {
    const half = data.subarray(Math.floor(data.length / 2));
    let n = 1; while (n < half.length) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(half);
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    let lo = 0, hi = 0;
    for (let k = 1; k < n / 2; k++) { const f = (k * sr) / n, e = re[k] * re[k] + im[k] * im[k]; if (f < 1000) lo += e; else if (f > 4000) hi += e; }
    return { lo, hi, ratio: lo > 0 ? hi / lo : Infinity };
  };
  const rows = [];
  let pureOk = true;
  for (const [name, spec] of Object.entries(R.REVERB_SPACES)) {
    const [l] = R.generateImpulse(48000, spec, 1);
    const b = bands(l, 48000);
    // Early reflections: distinct taps inside the early window stand out of the tail.
    // Early reflections: the same seed without taps must carry clearly less energy in the early window.
    const ew = Math.ceil((spec.predelay + spec.earlyWindow) * 48000);
    const share = (x) => { let e = 0, t = 0; for (let i = 0; i < x.length; i++) { t += x[i] * x[i]; if (i < ew) e += x[i] * x[i]; } return t > 0 ? e / t : 0; };
    const [bare] = R.generateImpulse(48000, { ...spec, earlyTaps: 0 }, 1);
    const lift = share(l) / Math.max(1e-12, share(bare));
    rows.push(`${name} ${(l.length / 48000).toFixed(2)}s hf/lf ${(b.ratio * 100).toFixed(2)}% early x${lift.toFixed(2)} (${spec.earlyTaps} taps)`);
    if (!(b.ratio < 0.2) || !(spec.earlyTaps >= 6 && spec.earlyTaps <= 10) || !(lift > 1.5)) pureOk = false;
  }
  const holdLen = R.REVERB_SPACES.hold.duration;
  check('space: every generated IR has HF damping (energy > 4 kHz in the last half < 20% of < 1 kHz) and 6-10 early taps that lift the early window > 1.5x; hold IR 0.5 s',
    pureOk && Math.abs(holdLen - 0.5) < 1e-9, rows.join(' | '));

  // The engine's REAL convolver buffers (not just the law): outdoor, cave and hold all damped.
  const engine = new SoundEngine();
  const c0 = created.length;
  engine.unlock();
  const convs = created.slice(c0).filter((n) => n.kind === 'Convolver' && n.buffer?.getChannelData);
  const er = convs.map((c) => ({ dur: c.buffer.duration, ...bands(c.buffer.getChannelData(0), c.buffer.sampleRate) }));
  check('engine: >= 3 convolvers (outdoor, cave, hold) and every impulse passes the HF-damping bound; one is the 0.5 s hold',
    convs.length >= 3 && er.every((e) => e.ratio < 0.2) && er.some((e) => Math.abs(e.dur - 0.5) < 0.02),
    er.map((e) => `${e.dur.toFixed(2)}s ${(e.ratio * 100).toFixed(1)}%`).join(', ') || 'no convolver buffers');

  // Occlusion stage on the engine: the bed passes through it; a hold listener closes it.
  engine.setListenerPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  engine.setListenerSpace?.({ inHold: true, aboard: true });
  const occF = engine.occFilter, occG = engine.occGain;
  const bedThrough = !!occF && downstream(engine.busBed).has(occF) && downstream(occF).has(engine.core?.levels?.ambience);
  const shut = { f: occF?.frequency?.ramped, g: occG?.gain?.ramped, at: (occF?.frequency?.rampAt ?? 0) - engine.ctx.currentTime };
  check('engine: setListenerSpace({inHold}) ramps the bed occlusion to <= 1000 Hz and <= -6 dB over 0.25 s',
    bedThrough && shut.f <= 1000 && shut.g <= 10 ** (-6 / 20) && Math.abs(shut.at - 0.25) < 0.01, JSON.stringify({ bedThrough, ...shut }));
  // A distant cannon heard from the hold is muffled too; your own footstep is not.
  const c1 = created.length;
  engine.playCannonFire(40, { x: 0, y: 0, z: -40 });
  const cannonLp = created.slice(c1).find((n) => n.kind === 'BiquadFilter' && n.type === 'lowpass');
  const c2 = created.length;
  engine.playFootstep('deck', false, 0);
  const stepLp = created.slice(c2).find((n) => n.kind === 'BiquadFilter' && n.type === 'lowpass');
  check('engine: in the hold an outside one-shot is lowpassed <= 900 Hz, your own footstep is not',
    !!cannonLp && cannonLp.frequency.value <= 900 && !!stepLp && stepLp.frequency.value > 900,
    `cannon lp ${cannonLp?.frequency?.value}, step lp ${stepLp?.frequency?.value}`);
  engine.setListenerSpace?.({});
  check('engine: back on the open deck the stage reopens (20 kHz, 0 dB)',
    occF?.frequency?.ramped >= 20000 && occG?.gain?.ramped === 1, `f ${occF?.frequency?.ramped} g ${occG?.gain?.ramped}`);

  // Director: the listener's hold state comes from the shared hold predicate.
  const D = await import('../src/client/audio/AudioDirector.ts');
  const { isStandingInShipHold } = await import('../src/shared/interactions.ts');
  const { SHIP_STATS: SS } = await import('../src/shared/constants/index.ts');
  const ship = { id: 's', type: 'sloop', position: { x: 0, y: 0, z: 0 }, rotation: 0, pitch: 0, roll: 0 };
  let agree = 0, inHoldSeen = 0, disagree = [];
  for (let y = -2; y <= SS.sloop.height + 4; y += 0.1) {
    const L = { x: 0, y, z: 0 };
    const got = D.listenerInHold?.(L, ship);
    const want = isStandingInShipHold({ x: 0, y: y - D.LISTENER_FEET_BELOW_EAR, z: 0 }, ship);
    if (got === want) agree++; else disagree.push(y.toFixed(1));
    if (got) inHoldSeen++;
  }
  const onDeck = D.listenerInHold?.({ x: 0, y: SS.sloop.height + 0.2 + 1.7, z: 0 }, ship);
  check('director: listenerInHold agrees with the shared isStandingInShipHold, is true somewhere in the hold and false standing on deck',
    disagree.length === 0 && inHoldSeen > 0 && onDeck === false, `agree ${agree}, inHold at ${inHoldSeen} heights, deck ${onDeck}${disagree.length ? `, disagree at ${disagree.join(',')}` : ''}`);
}

let failed = 0;
console.log('test-audio-models');
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(failed ? `FAIL (${failed})` : 'PASS');
process.exit(failed ? 1 : 0);
