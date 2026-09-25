// test-audio-events (b2.4f, audio-01 + audio-09): the combat and foley one-shots are SAMPLES now,
// with the procedural voices kept only as fallback or a small sweetener. Logic tier, quick, ~0.3 s,
// pure: a fake Web Audio graph (no browser) and a SampleBank fed from the SHIPPED manifest.
//
//   static   every sample key literal in src/client (playSample('k'), sampleLayer('k'), key: 'k' in the
//            audio tables) resolves in public/assets/audio/manifest.json; every public play*/set*/
//            start*/stop*/update* method of SoundEngine has >= 1 caller in src/client (no dead
//            events) and a route (a sample call, a procedural primitive, or a delegate).
//   sampled  with every manifest key decoded, each combat/foley event plays >= 1 BufferSource of
//            ITS key(s), at most 3 sample layers, and at most 3 procedural primitives (sweetener)
//            instead of the old 5-25 per event.
//   fallback with no bank the same event still builds its procedural voice (never silent).
//   variety  12 cannon shots: never the same variant twice in a row, all 3 variants heard, pitch
//            and level jitter within their bounds and not constant.
//
//   node --import tsx scripts/test-audio-events.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

const manifest = JSON.parse(readFileSync(`${ROOT}public/assets/audio/manifest.json`, 'utf8'));
const KEYS = new Set(Object.keys(manifest.keys));

// ── 1. static ───────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}
const files = walk(`${ROOT}src/client`).map((p) => ({ p, src: readFileSync(p, 'utf8') }));
{
  const literals = new Map();
  const re = /\b(?:playSample|sampleLayer|sample)\(\s*'([^']+)'|\bkey:\s*'([a-z]+\.[A-Za-z0-9.]+)'/g;
  for (const f of files) {
    if (!f.p.includes('/audio/')) continue;
    for (const m of f.src.matchAll(re)) {
      const k = m[1] ?? m[2];
      if (!literals.has(k)) literals.set(k, f.p.replace(ROOT, ''));
    }
  }
  const missing = [...literals].filter(([k]) => !KEYS.has(k));
  check('static: every sample key literal in src/client/audio resolves in the manifest',
    literals.size >= 20 && missing.length === 0, `${literals.size} literals${missing.length ? `, missing ${missing.map(([k, f]) => `${k} (${f})`).join(', ')}` : ''}`);
}
const engineSrc = readFileSync(`${ROOT}src/client/audio/SoundEngine.ts`, 'utf8');
/** name -> body text of every public play/set/start/stop/update method. */
const methods = new Map();
{
  const head = /^ {2}((?:play|set|start|stop|update)[A-Za-z]*)\(([^)]*(?:\([^)]*\)[^)]*)*)\)(?::[^{]+)?\{/gm;
  for (const m of engineSrc.matchAll(head)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < engineSrc.length && depth > 0; i++) {
      if (engineSrc[i] === '{') depth += 1;
      else if (engineSrc[i] === '}') depth -= 1;
    }
    methods.set(m[1], engineSrc.slice(m.index + m[0].length, i));
  }
}
{
  const all = files.map((f) => f.src).join('\n');
  const dead = [];
  for (const name of methods.keys()) {
    const uses = all.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    if (uses < 2) dead.push(name); // 1 = the definition itself
  }
  // Known unwired events, each owned by a later slice. The list must match EXACTLY: a new dead
  // event fails, and wiring one of these fails until its row is deleted (no stale allowances).
  const KNOWN_DEAD = {
    startFire: 'burning-ship fire loop: needs a Game/CombatFx caller (b2.3 hook)',
    playGoldCount: 'HUD gold tally counter (HUD lane)',
    playFootLanding: 'jump/fall landing (vy > 3 m/s): Game.ts updateFootsteps caller (b2.3 hook, handoff in b2.4.json)',
  };
  const unexpected = dead.filter((n) => !(n in KNOWN_DEAD));
  const stale = Object.keys(KNOWN_DEAD).filter((n) => !dead.includes(n));
  check('static: every public play*/set*/start*/stop*/update* of SoundEngine has >= 1 caller (no dead events beyond the owned list)',
    methods.size >= 60 && unexpected.length === 0 && stale.length === 0,
    `${methods.size} methods, known dead ${Object.keys(KNOWN_DEAD).length}${unexpected.length ? `, NEW dead: ${unexpected.join(', ')}` : ''}${stale.length ? `, stale allowance (now wired, delete the row): ${stale.join(', ')}` : ''}`);
  const PRIM = /\b(?:playSample|sampleLayer|playTone|playNoise|playNoiseCurve|metalClang|squeakTrain|plankHit|safeSet|ramp|this\.[a-zA-Z]+\()/;
  const noRoute = [...methods].filter(([n, body]) => n.startsWith('play') && !PRIM.test(body)).map(([n]) => n);
  check('static: every public play* event has a route (sample, procedural primitive or delegate)',
    noRoute.length === 0, noRoute.join(', '));
}

// Events migrated by b2.4f: [method, args, keys it must play (any of), min sample layers].
const EVENTS = [
  // b2.4g footsteps v2: every surface sample-first.
  ['playFootstep', ['deck'], ['footstep.wood']],
  ['playFootstep', ['dock'], ['footstep.dock']],
  ['playFootstep', ['sand'], ['footstep.sand']],
  ['playFootstep', ['stone'], ['footstep.stone']],
  ['playFootstep', ['grass'], ['footstep.grass']],
  ['playFootstep', ['water_shallow'], ['footstep.water']],
  ['playFootstep', ['ladder'], ['footstep.ladder']],
  ['playFootstep', ['rope'], ['footstep.rope']],
  ['playCannonFire', [10, { x: 0, y: 0, z: -10 }], ['cannon.fire']],
  ['playGunshot', ['flintlock', 5, { x: 5, y: 0, z: 0 }], ['gun.shot']],
  ['playGunshot', ['longRifle', 5, { x: 5, y: 0, z: 0 }], ['gun.shot']],
  ['playGunshot', ['blunderbuss', 5, { x: 5, y: 0, z: 0 }], ['gun.shot']],
  ['playGunshot', ['flintknock', 5, { x: 5, y: 0, z: 0 }], ['gun.shot']],
  ['playSwordBlock', [], ['sword.clash']],
  ['playCutlassSwing', [true], ['foley.drawBlade']],
  ['playProjectileImpact', ['cannonball', 20, { x: 20, y: 0, z: 0 }], ['cannon.hitRock']],
  ['playProjectileImpact', ['firebomb', 20, { x: 20, y: 0, z: 0 }], ['wood.break']],
  ['playProjectileImpact', ['bullet', 20, { x: 20, y: 0, z: 0 }], ['wood.hit']],
  ['playHullImpact', [15, { x: 0, y: 0, z: 15 }], ['cannon.hitWood']],
  ['playShipImpact', ['ram', 6, 10, { x: 10, y: 0, z: 0 }], ['wood.break']],
  ['playShipImpact', ['rock', 6, 10, { x: 10, y: 0, z: 0 }], ['cannon.hitRock', 'wood.break']],
  ['playSplash', [1.4, 30, { x: 0, y: 0, z: 30 }], ['splash.cannon']],
  ['playSplash', [0.4, 30, { x: 0, y: 0, z: 30 }], ['splash.small']],
  ['playKegExplosion', [20, { x: 20, y: 0, z: 0 }], ['cannon.fire']],
  ['playChestPickup', [], ['chest.coins']],
  ['playChestStow', [], ['chest.drop']],
  ['playChestOpen', [], ['chest.creak', 'chest.latch']],
  ['playDoorCreak', [true], ['door.open']],
  ['playDoorCreak', [false], ['door.close']],
  ['playGoldEarn', [], ['chest.coins']],
  ['playWoodPlank', [], ['hammer.hit']],
  ['playAxeChop', [], ['wood.chop']],
  ['playUiClick', [], ['ui.click']],
];

// ── fake Web Audio graph (same shape as test-audio-models) ─────────────────
const created = [];
function fakeParam(v = 0) {
  return { value: v, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {}, setValueCurveAtTime() {} };
}
function fakeNode(kind) {
  const outs = [];
  const target = { kind, outs, connect(to) { outs.push(to); return to; }, disconnect() { outs.length = 0; },
    start(at) { this.startedAt = at; }, stop() {}, getChannelData: () => new Float32Array(16), length: 16, duration: 1, numberOfChannels: 2, sampleRate: 48000 };
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
globalThis.window = { AudioContext: FakeCtx };
const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');
const { SampleBank, DECODED_CAP_BYTES } = await import('../src/client/audio/SampleBank.ts');

// A bank holding every shipped key; each decoded buffer carries its file so a voice is traceable.
const bank = new SampleBank({
  fetchBytes: async (url) => { const b = new ArrayBuffer(8); b.url = url; return b; },
  decode: async (bytes) => ({ duration: 0.4, length: 19200, numberOfChannels: 1, sampleRate: 48000, url: bytes.url }),
}, { capBytes: DECODED_CAP_BYTES.desktop, baseUrl: '/assets/audio/' });
bank.setManifest(manifest);
for (const k of KEYS) bank.request(k);
for (let i = 0; i < 400 && bank.decodesInFlight > 0; i++) await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 5));
const keyOf = (buf) => {
  const m = typeof buf?.url === 'string' ? /\/([a-z]+\.[A-Za-z]+)\.\d+\.mp3$/.exec(buf.url) : null;
  return m ? m[1] : null;
};

let clock = 1000;
const realNow = performance.now.bind(performance);
performance.now = () => clock; // KIND_LIMITS throttles on performance.now: step past every window
function fire(engine, method, args) {
  clock += 1000;
  engine.ctx.currentTime += 1;
  const before = created.length;
  engine[method](...args);
  const nodes = created.slice(before);
  const srcs = nodes.filter((n) => n.kind === 'BufferSource');
  const samples = srcs.filter((n) => keyOf(n.buffer));
  const prim = nodes.filter((n) => n.kind === 'Oscillator').length + (srcs.length - samples.length);
  return { nodes, samples, prim };
}

// ── 1b. footstep surfaces (b2.4g, audio-13) ────────────────────────────────
{
  const SE = await import('../src/client/audio/SoundEngine.ts');
  const want = ['deck', 'dock', 'sand', 'stone', 'grass', 'water_shallow', 'ladder', 'rope'];
  const surf = Array.isArray(SE.FOOTSTEP_SURFACES) ? SE.FOOTSTEP_SURFACES : [];
  const missing = want.filter((x) => !surf.includes(x));
  const rows = surf.map((x) => `${x}=${SE.FOOTSTEP_SAMPLE?.[x]?.key}x${manifest.keys[SE.FOOTSTEP_SAMPLE?.[x]?.key]?.files?.length ?? 0}`);
  const thin = surf.filter((x) => (manifest.keys[SE.FOOTSTEP_SAMPLE?.[x]?.key]?.files?.length ?? 0) < 3);
  check('footsteps: every surface (deck, dock, sand, stone, grass, water_shallow, ladder, rope) has a manifest key with >= 3 variants',
    missing.length === 0 && thin.length === 0, `${rows.join(' ')}${missing.length ? ` MISSING ${missing.join(',')}` : ''}${thin.length ? ` THIN ${thin.join(',')}` : ''}`);
}

// ── 2. sampled path ─────────────────────────────────────────────────────────
const engine = new SoundEngine();
engine.unlock();
engine.setListenerPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
engine.bank = bank;
{
  const bad = [];
  const rows = [];
  for (const [method, args, want] of EVENTS) {
    if (typeof engine[method] !== 'function') { bad.push(`${method} missing`); continue; }
    const { samples, prim } = fire(engine, method, args);
    const keys = samples.map((s) => keyOf(s.buffer));
    const hit = want.every((k) => keys.includes(k)) || (want.length > 1 && keys.some((k) => want.includes(k)));
    const tag = `${method}(${typeof args[0] === 'string' || typeof args[0] === 'boolean' ? args[0] : ''})`;
    rows.push(`${tag} ${keys.join('+') || '-'} +${prim}p`);
    if (!hit) bad.push(`${tag} played [${keys.join(',')}] want ${want.join('|')}`);
    else if (samples.length > 3) bad.push(`${tag} ${samples.length} sample layers (> 3)`);
    else if (prim > 3) bad.push(`${tag} ${prim} procedural primitives beside the sample (> 3 sweetener)`);
  }
  check(`sampled: ${EVENTS.length} combat/foley events each play their sample(s), <= 3 sample layers and <= 3 procedural sweeteners`,
    bad.length === 0, bad.length ? bad.join('; ') : rows.join(' | '));
  const ui = fire(engine, 'playUiClick', []);
  check('sampled: a sampled event still rides its bus (ui click never through the world filter)',
    ui.samples.length === 1 && !(() => { const seen = new Set(); const st = [ui.samples[0]]; while (st.length) { const n = st.pop(); if (!n || seen.has(n)) continue; seen.add(n); if (n === engine.core?.worldFilter) return true; st.push(...(n.outs ?? [])); } return false; })());
}

// ── 3. fallback ─────────────────────────────────────────────────────────────
{
  const silent = [];
  const fb = new SoundEngine();
  fb.unlock();
  fb.bank = null;
  for (const [method, args] of EVENTS) {
    const { samples, prim } = fire(fb, method, args);
    if (samples.length > 0 || prim === 0) silent.push(`${method}(${args[0] ?? ''}) samples ${samples.length} prim ${prim}`);
  }
  check('fallback: with no sample bank every migrated event builds its procedural voice', silent.length === 0, silent.join('; '));
}

// ── 4. round robin + jitter ────────────────────────────────────────────────
{
  const files = [];
  const rates = [];
  const levels = [];
  for (let i = 0; i < 12; i++) {
    const { samples } = fire(engine, 'playCannonFire', [4, { x: 0, y: 0, z: -4 }]);
    const s = samples.find((n) => keyOf(n.buffer) === 'cannon.fire');
    files.push(s?.buffer.url ?? '-');
    rates.push(s?.playbackRate.value ?? NaN);
    levels.push(s?.outs[0]?.gain?.value ?? NaN);
  }
  const repeats = files.filter((f, i) => i > 0 && f === files[i - 1]).length;
  check('variety: 12 cannon shots never repeat a variant back to back and use all 3',
    repeats === 0 && new Set(files).size === 3 && !files.includes('-'), `${new Set(files).size} variants, ${repeats} repeats`);
  const semis = rates.map((r) => 12 * Math.log2(r));
  const spread = Math.max(...semis) - Math.min(...semis);
  check('variety: pitch jitter is live and bounded (|semitones| <= 1, spread > 0.2)',
    semis.every((s) => Math.abs(s) <= 1.0001) && spread > 0.2, `semis ${semis.map((s) => s.toFixed(2)).join(' ')}`);
  const db = levels.map((l) => 20 * Math.log10(l / Math.max(...levels)));
  const lspread = -Math.min(...db);
  check('variety: level jitter is live and bounded (spread 0.3..3.5 dB)', lspread > 0.3 && lspread <= 3.5, `spread ${lspread.toFixed(2)} dB`);
}
performance.now = realNow;

console.log(`\ntest-audio-events: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
