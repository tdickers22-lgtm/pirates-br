// SOUND ENGINE NEVER THROWS ON A BAD NUMBER (logic tier, b1.1c).
//
// liveplay-05: a NaN distance reached makeSpatialDest -> filter.frequency.value
// = NaN, and a NaN gain reached setValueAtTime inside playNoiseCurve. Real
// AudioParams THROW on a non-finite value, and the throw unwound the network
// message handler, so whatever that message still had to apply (feed lines,
// state) was dropped: 18 "[Net] error handling server message" + 1 pageerror in
// one live match.
//
// This suite builds a fake AudioContext whose AudioParams throw exactly like
// Chromium/WebKit (TypeError on any non-finite value or time, RangeError on an
// exponential ramp to 0, TypeError on a negative time constant), unlocks the
// engine, then calls EVERY public play* / set* / start* / update* / stop* method
// (names read from the TS source, so a new method is covered automatically)
// with NaN, undefined, +Infinity and -Infinity in every numeric slot and in
// every field of every position / object argument. It fails on:
//   - any exception escaping a public method,
//   - any non-finite write that reached a param (the stub throws AND counts),
//   - any fault the engine's own backstop had to swallow (engine.audioFaults),
//     so the backstop cannot turn this gate vacuous.
//
//   node --import tsx scripts/test-sound-finite.mjs
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = readFileSync(`${ROOT}src/client/audio/SoundEngine.ts`, 'utf8');

// ── Fake Web Audio that throws like a browser ───────────────────────────────
let paramThrows = 0;
const throwLog = new Map();
function noteThrow(where) {
  paramThrows += 1;
  throwLog.set(where, (throwLog.get(where) ?? 0) + 1);
}
const PARAM_NAMES = new Set([
  'gain', 'frequency', 'Q', 'detune', 'pan', 'threshold', 'knee', 'ratio', 'attack', 'release',
  'playbackRate', 'delayTime', 'offset', 'positionX', 'positionY', 'positionZ',
  'orientationX', 'orientationY', 'orientationZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ',
]);
class FakeParam {
  constructor(name) { this.name = name; this._v = 0; this.minValue = -3.4e38; this.maxValue = 3.4e38; }
  get value() { return this._v; }
  set value(v) {
    if (!Number.isFinite(v)) { noteThrow(`${this.name}.value`); throw new TypeError(`Failed to set the 'value' property on 'AudioParam': The provided float value is non-finite.`); }
    this._v = v;
  }
  _chk(op, ...xs) {
    if (xs.some((x) => !Number.isFinite(x))) { noteThrow(`${this.name}.${op}`); throw new TypeError(`Failed to execute '${op}' on 'AudioParam': The provided float value is non-finite.`); }
  }
  setValueAtTime(v, t) { this._chk('setValueAtTime', v, t); if (t < 0) throw new RangeError('negative time'); this._v = v; return this; }
  linearRampToValueAtTime(v, t) { this._chk('linearRampToValueAtTime', v, t); if (t < 0) throw new RangeError('negative time'); return this; }
  exponentialRampToValueAtTime(v, t) {
    this._chk('exponentialRampToValueAtTime', v, t);
    if (v === 0) { noteThrow(`${this.name}.exponentialRampToValueAtTime(0)`); throw new RangeError('The float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).'); }
    return this;
  }
  setTargetAtTime(v, t, c) {
    this._chk('setTargetAtTime', v, t, c);
    if (c < 0) { noteThrow(`${this.name}.setTargetAtTime(tc<0)`); throw new RangeError('negative time constant'); }
    return this;
  }
  cancelScheduledValues(t) { this._chk('cancelScheduledValues', t); return this; }
  cancelAndHoldAtTime(t) { this._chk('cancelAndHoldAtTime', t); return this; }
  setValueCurveAtTime(curve, t, d) { this._chk('setValueCurveAtTime', t, d); return this; }
}
function fakeNode(kind) {
  const params = new Map();
  const store = { kind };
  const noop = (...a) => a[0];
  return new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p !== 'string') return undefined;
      if (PARAM_NAMES.has(p)) { if (!params.has(p)) params.set(p, new FakeParam(`${kind}.${p}`)); return params.get(p); }
      if (['connect', 'disconnect', 'start', 'stop', 'setPeriodicWave', 'addEventListener', 'removeEventListener'].includes(p)) {
        return (...a) => {
          if ((p === 'start' || p === 'stop') && a.some((x) => x !== undefined && !Number.isFinite(x))) { noteThrow(`${kind}.${p}`); throw new TypeError(`Failed to execute '${p}': non-finite`); }
          return noop(...a);
        };
      }
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
export let contextsBuilt = 0;
class FakeAudioContext {
  constructor() { contextsBuilt += 1; this.state = 'running'; this.sampleRate = 48000; this.currentTime = 1; this.destination = fakeNode('destination'); this.listener = fakeNode('listener'); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
  createBuffer(ch, len, rate) {
    const data = Array.from({ length: ch }, () => new Float32Array(Math.max(1, len | 0)));
    return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: (i) => data[i] };
  }
  createPeriodicWave() { return {}; }
}
for (const m of ['Gain', 'BiquadFilter', 'Oscillator', 'BufferSource', 'StereoPanner', 'Panner', 'Convolver', 'DynamicsCompressor', 'WaveShaper', 'Delay', 'ConstantSource', 'ChannelMerger', 'ChannelSplitter', 'Analyser', 'IIRFilter']) {
  FakeAudioContext.prototype[`create${m}`] = function () { return fakeNode(m); };
}
globalThis.window = globalThis;
globalThis.AudioContext = FakeAudioContext;
globalThis.document ??= { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
// The engine's burst limiters (throttle, voiceBudgetOk) read performance.now().
// On a fast host the 1096 calls land inside one window, the limiters drop most
// voices and the poisoned args never reach start()/stop(); on a loaded host the
// windows expire and they do. Step the clock 10 s per read so every limiter is
// always open and the verdict never depends on host speed.
let fakeNowMs = 0;
performance.now = () => (fakeNowMs += 10_000);

const THREE = await import('three');
const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');

// ── Public surface, read from the source ────────────────────────────────────
const classBody = SRC.slice(SRC.indexOf('export class SoundEngine'));
const methods = [];
for (const m of classBody.matchAll(/^ {2}([a-z]\w*)\(([^)]*)\)(?::[^{]+)?\{/gm)) {
  const name = m[1];
  if (!/^(play|set|start|update|stop)/.test(name)) continue;
  const params = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [lhs, dflt] = s.split('=').map((x) => x.trim());
    const [pname, type = ''] = lhs.split(':').map((x) => x.trim());
    return { name: pname.replace('?', ''), type, dflt };
  });
  methods.push({ name, params });
}

const BAD = [['NaN', NaN], ['undefined', undefined], ['+Infinity', Infinity], ['-Infinity', -Infinity]];
function badObject(bad) {
  return new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? bad : undefined) });
}
function argFor(param, bad) {
  const t = param.type;
  if (/Camera/.test(t)) { const cam = new THREE.PerspectiveCamera(); cam.position.set(bad, bad, bad); return cam; }
  if (/SoundPos|Vec3|\{ *x/.test(t) || /^pos/.test(param.name) || param.name === 'position') return { x: bad, y: bad, z: bad };
  if (t && !/number|boolean|string|'/.test(t) && /^[A-Z{]/.test(t)) return badObject(bad);
  return bad;
}

let escaped = 0;
const escapedLog = [];
let calls = 0;
const engine = new SoundEngine();
engine.unlock();
engine.setListenerPose({ x: 0, y: 0, z: 0 }, 0);
engine.setMusicContext('sailing');
for (const pass of ['cold', 'hot']) {
  for (const [label, bad] of BAD) {
    for (const m of methods) {
      const variants = [m.params.map((p) => argFor(p, bad))];
      // Also: only the position poisoned (distance fine) and only the distance poisoned.
      if (m.params.some((p) => p.name === 'distance')) {
        variants.push(m.params.map((p) => (p.name === 'distance' ? 40 : argFor(p, bad))));
        variants.push(m.params.map((p) => (p.name === 'distance' ? bad : p.name === 'pos' ? { x: 5, y: 0, z: 5 } : argFor(p, 1))));
      }
      for (const args of variants) {
        calls += 1;
        try { engine[m.name](...args); } catch (err) {
          escaped += 1;
          if (escapedLog.length < 12) escapedLog.push(`${m.name}(${label}): ${String(err?.message ?? err).slice(0, 110)}`);
        }
      }
    }
    // Let schedulers and ramps run against the poisoned state.
    try { engine.tickMusic?.(); } catch (err) { escaped += 1; escapedLog.push(`tickMusic after ${label}: ${err?.message}`); }
  }
  if (pass === 'cold') engine.setListenerPose({ x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: -1 });
}

const faults = Number(engine.audioFaults ?? 0);
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
console.log(`test-sound-finite: ${methods.length} public methods, ${calls} poisoned calls`);
check('public surface discovered (>= 60 play*/set* methods)', methods.length >= 60, `${methods.length}`);
check('0 exceptions escape a public method', escaped === 0, escaped ? `${escaped}: ${escapedLog.join(' | ')}` : '');
check('0 non-finite writes reach an AudioParam or start/stop', paramThrows === 0,
  paramThrows ? `${paramThrows}: ${[...throwLog].slice(0, 8).map(([k, v]) => `${k} x${v}`).join(', ')}` : '');
check('0 faults swallowed by the engine backstop', faults === 0, `${faults}`);
check('the engine really built a context and wired params (not vacuous)', contextsBuilt === 1, `contexts ${contextsBuilt}`);
// Static: the Net dispatcher runs every game callback inside its per-event guard,
// so a cosmetic throw can never unwind the rest of a server message.
const NET = readFileSync(`${ROOT}src/client/network/NetworkClient.ts`, 'utf8');
const hm = NET.slice(NET.indexOf('private handleMsg('), NET.indexOf('\n  }\n', NET.indexOf('private handleMsg(')));
const bare = hm.split('\n').filter((l) => /this\.on\w+\?\.\(/.test(l) && !/this\.emit\(/.test(l));
const guarded = (hm.match(/this\.emit\(/g) ?? []).length;
check('Net dispatcher: every callback runs inside the per-event guard', bare.length === 0 && guarded >= 40,
  bare.length ? `${bare.length} bare: ${bare[0].trim().slice(0, 80)}` : `${guarded} guarded`);
console.log(failures ? `FAIL (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
