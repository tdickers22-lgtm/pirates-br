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
  return { value: v, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {} };
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
  check('core: limiter is the last node (limiter -> destination only)',
    core.limiter.outs.length === 1 && core.limiter.outs[0] === ctx.destination && core.limiter.ratio.value >= 12 && core.limiter.threshold.value <= -1);
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

let failed = 0;
console.log('test-audio-models');
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(failed ? `FAIL (${failed})` : 'PASS');
process.exit(failed ? 1 : 0);
