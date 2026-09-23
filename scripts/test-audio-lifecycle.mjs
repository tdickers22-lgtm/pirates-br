// AUDIO LIFECYCLE ON EVERY DEVICE (logic tier, b1.1c).
//
// audio-08 / crossdevice-12 / D14: the context was created by the first
// per-frame setter (setAmbience, setSailingState ...) before any gesture, the
// unlock was bound to pointerdown (WebKit grants audio activation on
// pointerup/touchend/click/keydown, not pointerdown), nothing set
// navigator.audioSession (so the iOS silent switch muted the whole game), and
// nothing handled a hidden page or an iOS 'interrupted' context.
//
// A fake AudioContext that behaves like WebKit (starts 'suspended'; resume()
// outside a gesture is refused; statechange fires on every transition) and a
// fake window/document/navigator drive the real SoundEngine + AudioLifecycle:
//   - 100 setAmbience + per-frame setters + one-shots before any gesture -> 0 contexts
//   - pointerdown alone -> still 0 contexts; touchend -> 1 context, running,
//     a 1-sample silent buffer started inside the gesture, listeners disarmed
//   - navigator.audioSession.type = 'playback' by default, 'ambient' with mix
//   - hidden (visibilitychange twice + pagehide) -> suspend() exactly once;
//     visible -> resume
//   - 'interrupted' re-arms the gesture unlock; the next click brings it back
//   - static: Game.ts arms the lifecycle and no longer unlocks on pointerdown
//
//   node --import tsx scripts/test-audio-lifecycle.mjs
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ── Fakes ───────────────────────────────────────────────────────────────────
class FakeTarget {
  constructor() { this.map = new Map(); }
  addEventListener(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); }
  removeEventListener(type, fn) { this.map.get(type)?.delete(fn); }
  count(type) { return this.map.get(type)?.size ?? 0; }
  fire(type, ev = {}) { for (const fn of [...(this.map.get(type) ?? [])]) fn(ev); }
}
let inGesture = false;
const contexts = [];
const log = [];
const param = () => ({ value: 0, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; }, cancelScheduledValues() { return this; } });
function node(kind) {
  return new Proxy({ kind }, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p !== 'string') return undefined;
      if (['connect', 'disconnect', 'stop', 'addEventListener', 'setPeriodicWave'].includes(p)) return (a) => a;
      if (p === 'start') return (...a) => { log.push({ ev: 'start', kind, inGesture, buffer: t.buffer }); };
      if (/^(gain|frequency|Q|detune|pan|threshold|knee|ratio|attack|release|playbackRate|delayTime|offset)$/.test(p)) { t[p] = param(); return t[p]; }
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
class WebKitishContext extends FakeTarget {
  constructor() {
    super(); contexts.push(this); this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0;
    this.destination = node('destination'); this.resumes = 0; this.suspendCalls = 0;
  }
  setState(s) { if (this.state === s) return; this.state = s; this.fire('statechange'); }
  resume() {
    this.resumes += 1;
    if (!inGesture && this.state !== 'suspended-by-page') { return Promise.reject(new Error('NotAllowed: resume outside a gesture')); }
    this.setState('running');
    return Promise.resolve();
  }
  suspend() { this.suspendCalls += 1; this.setState('suspended'); return Promise.resolve(); }
  createBuffer(ch, len, rate) { const data = Array.from({ length: ch }, () => new Float32Array(Math.max(1, len | 0))); const b = { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: (i) => data[i] }; log.push({ ev: 'createBuffer', ch, len, inGesture }); return b; }
  createPeriodicWave() { return {}; }
}
for (const m of ['Gain', 'BiquadFilter', 'Oscillator', 'BufferSource', 'StereoPanner', 'Convolver', 'DynamicsCompressor', 'WaveShaper', 'Delay', 'ConstantSource']) {
  WebKitishContext.prototype[`create${m}`] = function () { return node(m); };
}
const win = new FakeTarget();
const doc = new FakeTarget();
doc.visibilityState = 'visible';
const nav = { audioSession: { type: 'auto' } };
globalThis.window = globalThis;
globalThis.AudioContext = WebKitishContext;
function gesture(type) { inGesture = true; try { win.fire(type, { type }); } finally { inGesture = false; } }
const flush = () => new Promise((r) => setTimeout(r, 0));

const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');
const engine = new SoundEngine();
// 100 frames of per-frame setters + a few one-shots, before any gesture.
for (let i = 0; i < 100; i++) {
  engine.setAmbience({ storm: 0.3, shore: 0.5, rain: 0.2, underway: 0.4, aboard: true, cave: 0, dt: 0.016, nowSec: i * 0.016 });
  engine.setWaveBed?.(0.5);
  engine.setWindIntensity?.(0.4);
  engine.setSailingState?.({ speed: 4, heel: 0.1, sailsOut: 1, aboard: true });
}
engine.playUiClick(); engine.playCannonFire(40, { x: 1, y: 0, z: 1 }); engine.setMusicContext('menu');
check('100 setAmbience (+ setters, one-shots) before a gesture construct 0 contexts', contexts.length === 0, `${contexts.length}`);
if (typeof engine.installLifecycle !== 'function') {
  check('SoundEngine.installLifecycle exists', false, 'missing');
} else {
  const lc = engine.installLifecycle(win, doc, nav);
  check("audioSession.type = 'playback' by default (D14)", nav.audioSession.type === 'playback', nav.audioSession.type);
  engine.setMixWithOthers(true);
  check("'Mix with other audio' -> 'ambient'", nav.audioSession.type === 'ambient', nav.audioSession.type);
  engine.setMixWithOthers(false);


  gesture('pointerdown');
  win.fire('touchstart');
  check('pointerdown / touchstart alone do not unlock (0 contexts)', contexts.length === 0, `${contexts.length}`);
  const armedTypes = ['pointerup', 'touchend', 'click', 'keydown'].filter((t) => win.count(t) > 0);
  check('armed on pointerup, touchend, click, keydown', armedTypes.length === 4, armedTypes.join(','));
  check('not armed on pointerdown', win.count('pointerdown') === 0);

  gesture('touchend');
  await flush();
  const ctx = contexts[0];
  check('touchend unlocks: exactly 1 context, running', contexts.length === 1 && ctx?.state === 'running', `${contexts.length} ${ctx?.state}`);
  const silent = log.find((e) => e.ev === 'createBuffer' && e.len === 1 && e.ch === 1);
  const started = log.find((e) => e.ev === 'start' && e.kind === 'BufferSource' && e.buffer?.length === 1);
  check('a 1-sample silent buffer is started inside the gesture', !!silent?.inGesture && !!started?.inGesture);
  check('gesture listeners disarmed once running', lc.armed === false && win.count('touchend') === 0, `armed=${lc.armed}`);

  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange'); doc.fire('visibilitychange'); doc.fire('pagehide');
  check('hidden -> suspend() exactly once', ctx.suspendCalls === 1, `${ctx.suspendCalls}`);
  check('hidden suspend does not re-arm the gesture unlock', lc.armed === false);
  doc.visibilityState = 'visible';
  const before = ctx.resumes;
  doc.fire('visibilitychange');
  await flush();
  check('visible -> resume() attempted', ctx.resumes === before + 1, `${ctx.resumes - before}`);
  check('refused resume outside a gesture re-arms the unlock', ctx.state === 'running' || lc.armed === true, `${ctx.state} armed=${lc.armed}`);
  gesture('click');
  await flush();
  check('next click brings it back to running and disarms', ctx.state === 'running' && lc.armed === false, `${ctx.state} armed=${lc.armed}`);

  ctx.setState('interrupted');
  check("'interrupted' re-arms the gesture unlock", lc.armed === true && win.count('touchend') === 1, `armed=${lc.armed}`);
  gesture('keydown');
  await flush();
  check('keydown after the interruption resumes it', ctx.state === 'running' && lc.armed === false, ctx.state);
  check('still exactly 1 context after all of it', contexts.length === 1, `${contexts.length}`);
}

// ── Static wiring: Game arms the lifecycle; pointerdown no longer "unlocks" ──
const game = readFileSync(`${ROOT}src/client/core/Game.ts`, 'utf8');
check('Game.ts calls audio.installLifecycle()', /this\.audio\.installLifecycle\(/.test(game));
check('Game.ts no longer unlocks audio on pointerdown', !/addEventListener\('pointerdown',\s*\(\)\s*=>\s*\{\s*this\.combatFx\.unlockAudio/.test(game));

console.log(failures ? `FAIL (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
