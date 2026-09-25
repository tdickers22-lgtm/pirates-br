#!/usr/bin/env node
// b2.4d gate (audio-02): SoT-style flooding sound. Grades the pure laws in
// src/client/audio/floodAudioModel.ts, the FloodAudio voice manager on a fake host, and the
// SoundEngine wiring on a fake Web Audio graph (positioned gush loops, not one centred bed).
//   node --import tsx scripts/test-flood-audio.mjs
// Logic tier, < 1 s, no browser.
let fails = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const M = await import('../src/client/audio/floodAudioModel.ts');
const { FloodAudio } = await import('../src/client/audio/FloodAudio.ts');

// ── 1. gush law ─────────────────────────────────────────────────────────────
{
  const above = M.holeGush(-0.1, 2).level;
  const at = M.holeGush(0, 2).level;
  check('gush: 0 for a hole 0.1 m above the waterline and 0 at it', above === 0 && at === 0, `${above} ${at}`);
  let strict = true;
  let where = '';
  for (const size of [1, 2, 3]) for (const sub of [false, true]) {
    let prev = -1;
    for (let d = 0.02; d <= 4; d += 0.02) {
      const l = M.holeGush(d, size, sub).level;
      if (!(l > prev) || !(l < 1)) { strict = false; where = `size ${size} sub ${sub} d ${d.toFixed(2)} ${l} <= ${prev}`; break; }
      prev = l;
    }
  }
  check('gush: strictly increasing with depth 0.02..4 m for every size, jet and boil, and < 1', strict, where);
  const v1 = M.exitSpeed(1);
  check('gush: exit speed is sqrt(2 g h)', Math.abs(v1 - Math.sqrt(2 * 9.81)) < 1e-9, v1.toFixed(4));
  const s1 = M.holeGush(0.8, 1).level;
  const s3 = M.holeGush(0.8, 3).level;
  check('gush: a size-3 tear is louder than a size-1 at the same depth', s3 > s1 * 1.3, `${s1.toFixed(3)} vs ${s3.toFixed(3)}`);
  const jet = M.holeGush(0.8, 2, false);
  const boil = M.holeGush(0.8, 2, true);
  check('gush: under the hold water it is a quieter, darker boil', boil.level < jet.level && boil.cutoff < jet.cutoff * 0.5,
    `jet ${jet.level.toFixed(3)}/${jet.cutoff.toFixed(0)} Hz boil ${boil.level.toFixed(3)}/${boil.cutoff.toFixed(0)} Hz`);
  check('gush: deeper is brighter and faster', M.holeGush(1.5, 2).cutoff > M.holeGush(0.2, 2).cutoff && M.holeGush(1.5, 2).rate > M.holeGush(0.2, 2).rate);
  check('gush: non-finite input is silent, not NaN', M.gushFromSpeed(NaN, 2, false).level === 0 && M.holeGush(Infinity, 2).level <= 1);
}

// ── 2. voice cap, slosh, gurgle, distance ───────────────────────────────────
{
  const em = Array.from({ length: 10 }, (_, i) => ({ holeId: i, v: [1, 5, 2, 6, 0.5, 4, 3, 7, 0.2, 2.5][i], strength: 1 }));
  const kept = M.pickGushVoices(em).map((e) => e.holeId).sort((a, b) => a - b);
  check('cap: 10 breaches -> 6 voices, the 6 deepest (fastest) kept', M.FLOOD_GUSH_VOICES === 6 && kept.join() === '1,3,5,6,7,9', kept.join());
  check('slosh: 0 at fill 0 even rolling hard', M.sloshLevel(0, 1, 1).level === 0);
  const calm = M.sloshLevel(0.4, 0, 0).level;
  const rolling = M.sloshLevel(0.4, 0.25, 0.05).level;
  check('slosh: > 0 with water aboard, louder when the hull rolls', calm > 0 && rolling > calm * 2, `${calm.toFixed(3)} -> ${rolling.toFixed(3)}`);
  check('slosh: grows with fill', M.sloshLevel(0.8, 0.1, 0).level > M.sloshLevel(0.2, 0.1, 0).level);
  check('gurgle: 0 at or below half full, rises above it', M.gurgleLevel(0.5) === 0 && M.gurgleLevel(0.3) === 0 && M.gurgleLevel(0.6) > 0 && M.gurgleLevel(1) === 1);
  const own = M.floodDistanceGain(4, true);
  const far = M.floodDistanceGain(60, false);
  check('distance: a hull 60 m off is >= 12 dB under your own (4 m)', M.toDb(own) - M.toDb(far) >= 12, `${(M.toDb(own) - M.toDb(far)).toFixed(1)} dB`);
  const p1 = M.holePunchParams(1);
  const p3 = M.holePunchParams(3);
  check('hole punch: bigger tear is louder and lower', p3.volume > p1.volume && p3.rate < p1.rate);
}

// ── 3. FloodAudio on a fake host ────────────────────────────────────────────
function fakeHost() {
  const log = { opened: [], shots: [], stops: [] };
  const host = {
    openLoop(kind, pos) {
      const h = { kind, pos: { ...pos }, gain: 0, cutoff: 0, stopped: -1,
        set(p) { h.gain = p.gain; h.cutoff = p.cutoff; h.pos = { ...p.pos }; },
        stop(r) { h.stopped = r; log.stops.push({ kind, r }); } };
      log.opened.push(h);
      return h;
    },
    oneShot(kind, pos, volume, rate) { log.shots.push({ kind, pos, volume, rate }); },
  };
  return { host, log };
}
function hullWith(id, x, holes, extra = {}) {
  return { id, position: { x, y: 0, z: 0 }, waterLevel: 0.3, roll: 0, pitch: 0, holes, alive: true, ...extra };
}
{
  const { host, log } = fakeHost();
  const fa = new FloodAudio(host);
  const holes = Array.from({ length: 9 }, (_, i) => ({ id: i, x: 1, y: -1, z: i - 4, patched: false, size: 2 }));
  const vs = [1, 3, 2, 5, 0.5, 4, 6, 2.5, 0.3];
  const emitters = holes.map((h, i) => ({ holeId: h.id, worldPos: { x: 1, y: -1, z: h.z }, v: vs[i], submergedInside: false, strength: 1 }));
  const frame = { dt: 0.05, listener: { x: 0, y: 1.5, z: 0 }, aboardShipId: 'own', ships: [hullWith('own', 0, holes)], emitters: () => emitters };
  fa.update(frame);
  const gush = log.opened.filter((h) => h.kind === 'gush');
  check('FloodAudio: 9 flooding breaches -> exactly 6 gush loops', gush.length === 6 && fa.gushVoices === 6, `${gush.length}`);
  const posZ = gush.map((h) => h.pos.z).sort((a, b) => a - b).join();
  check('FloodAudio: the 6 are the deepest and each sits ON its breach', posZ === '-3,-2,-1,1,2,3', posZ);
  check('FloodAudio: first sight of a holed hull plays no punch crack', log.shots.length === 0, log.shots.map((s) => s.kind).join());
  // patch hole 6 (the fastest): knock, then its jet releases (strength fades), then the voice stops with 300 ms.
  holes[6].patched = true;
  const releasing = emitters.map((e) => (e.holeId === 6 ? { ...e, v: 0, strength: 0.5 } : e));
  fa.update({ ...frame, emitters: () => releasing });
  check('FloodAudio: patching plays a plank knock at the breach', log.shots.some((s) => s.kind === 'patchKnock' && s.pos.z === 2));
  const v6 = gush.find((h) => h.pos.z === 2);
  fa.update({ ...frame, emitters: () => releasing.filter((e) => e.holeId !== 6) });
  check('FloodAudio: its gush releases over 300 ms when the jet is gone', v6 && v6.stopped === 0.3, `${v6?.stopped}`);
  // a new size-3 breach after first sight -> hole punch crack
  holes.push({ id: 20, x: 1, y: -1.5, z: 5, patched: false, size: 3 });
  fa.update({ ...frame, emitters: () => releasing.filter((e) => e.holeId !== 6) });
  const punch = log.shots.find((s) => s.kind === 'holePunch');
  check('FloodAudio: a new breach cracks, sized by the tear', !!punch && Math.abs(punch.rate - M.holePunchParams(3).rate) < 1e-9);
  const slosh = log.opened.find((h) => h.kind === 'slosh');
  check('FloodAudio: slosh bed runs with water aboard, at the hull', !!slosh && slosh.gain > 0 && slosh.pos.x === 0);
}
{
  // own hull vs the same flooding hull 60 m off, listener 4 m from the breach
  const mk = (x) => ({ holes: [{ id: 1, x: 0, y: -1, z: 0, patched: false, size: 2 }], em: [{ holeId: 1, worldPos: { x, y: -1, z: 4 }, v: 4, submergedInside: false, strength: 1 }] });
  const a = new FloodAudio(fakeHost().host);
  const own = mk(0);
  a.update({ dt: 0.05, listener: { x: 0, y: -1, z: 0 }, aboardShipId: 'own', ships: [hullWith('own', 0, own.holes)], emitters: () => own.em });
  const b = new FloodAudio(fakeHost().host);
  const far = mk(60);
  b.update({ dt: 0.05, listener: { x: 0, y: -1, z: 0 }, aboardShipId: null, ships: [hullWith('far', 60, far.holes)], emitters: () => far.em });
  const go = a.lastGains.get('own');
  const gf = b.lastGains.get('far');
  const dG = M.toDb(go.gush[0]) - M.toDb(gf.gush[0]);
  const dS = M.toDb(go.slosh) - M.toDb(gf.slosh);
  check('FloodAudio: a ship 60 m away is >= 12 dB quieter than your own (gush and slosh)', dG >= 12 && dS >= 12, `gush ${dG.toFixed(1)} dB, slosh ${dS.toFixed(1)} dB`);
  const c = new FloodAudio(fakeHost().host);
  c.update({ dt: 0.05, listener: { x: 0, y: 0, z: 0 }, aboardShipId: null, ships: [hullWith('x', 90, far.holes)], emitters: () => far.em });
  check('FloodAudio: a hull beyond 70 m is not voiced', c.gushVoices === 0 && !c.lastGains.has('x'));
}
{
  const { host, log } = fakeHost();
  const fa = new FloodAudio(host);
  const pos = { x: 0, y: 0, z: 0 };
  for (let t = 0; t < 1.6; t += 0.05) fa.update({ dt: 0.05, listener: pos, aboardShipId: null, ships: [], emitters: () => [], repair: { progress: t / 1.6, pos } });
  fa.update({ dt: 0.05, listener: pos, aboardShipId: null, ships: [], emitters: () => [], repair: { progress: 0, pos } });
  const blows = log.shots.filter((s) => s.kind === 'hammer').length;
  check('FloodAudio: one mallet blow per 0.4 s of plank progress (1.6 s -> 4 or 5)', blows === 4 || blows === 5, `${blows}`);
  const ship = hullWith('s', 5, [], { waterLevel: 0.9 });
  fa.update({ dt: 0.05, listener: pos, aboardShipId: null, ships: [ship], emitters: () => [] });
  const cues = [];
  for (let p = 0; p <= 1.0001; p += 0.02) {
    const before = log.shots.length;
    fa.update({ dt: 0.05, listener: pos, aboardShipId: null, ships: [{ ...ship, sinking: true, sinkProgress: p }], emitters: () => [] });
    for (const s of log.shots.slice(before)) cues.push(s.kind);
  }
  check('FloodAudio: founder stages in order: groan, frame cracks, air bursting, suction',
    cues.join() === 'groan,frameCrack,frameCrack,airRelease,frameCrack,airRelease,suction', cues.join());
}

// ── 4. SoundEngine wiring on a fake Web Audio graph ─────────────────────────
const created = [];
function fakeParam(v = 0) {
  return { value: v, setValueAtTime(x) { this.value = x; }, linearRampToValueAtTime(x) { this.value = x; }, exponentialRampToValueAtTime(x) { this.value = x; },
    setTargetAtTime(x) { this.value = x; }, cancelScheduledValues() {}, cancelAndHoldAtTime() {}, setValueCurveAtTime() {} };
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
globalThis.window = { AudioContext: FakeCtx, setTimeout, clearTimeout };
const { SoundEngine } = await import('../src/client/audio/SoundEngine.ts');
{
  const engine = new SoundEngine();
  engine.unlock();
  const ok = typeof engine.updateFlood === 'function';
  check('engine: SoundEngine drives FloodAudio (updateFlood)', ok);
  if (ok) {
    engine.setListenerPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    const before = created.length;
    const holes = [{ id: 1, x: 0, y: -1, z: 0, patched: false, size: 2 }, { id: 2, x: 0, y: -1, z: 3, patched: false, size: 1 }];
    const em = [{ holeId: 1, worldPos: { x: 7, y: -1, z: -2 }, v: 4, submergedInside: false, strength: 1 },
      { holeId: 2, worldPos: { x: -5, y: -1, z: 3 }, v: 2, submergedInside: false, strength: 1 }];
    engine.updateFlood({ dt: 0.05, listener: { x: 0, y: 0, z: 0 }, aboardShipId: 'own', ships: [hullWith('own', 0, holes)], emitters: () => em });
    const panners = created.slice(before).filter((n) => n.kind === 'Panner');
    const xs = panners.map((p) => p.positionX.value).sort((a, b) => a - b).join();
    check('engine: each gush is its own PannerNode at its breach (not one centred loop)', panners.length >= 2 && xs.includes('-5') && xs.includes('7'), `${panners.length} panners at x ${xs}`);
    const reachOut = panners.every((p) => {
      const seen = new Set();
      const st = [p];
      while (st.length) { const n = st.pop(); if (!n || seen.has(n)) continue; seen.add(n); for (const o of n.outs ?? []) st.push(o); }
      return seen.has(engine.ctx.destination);
    });
    check('engine: flood voices reach the output', reachOut);
    let threw = null;
    try {
      engine.playBucket('scoop', { x: 0, y: 0, z: 0 });
      engine.playBucket('fling', null);
      engine.stopFlooding();
      engine.updateFlood({ dt: NaN, listener: { x: NaN, y: 0, z: 0 }, aboardShipId: null, ships: [null, hullWith('z', 1, [])], emitters: () => [] });
    } catch (e) { threw = e; }
    check('engine: bucket scoop/fling, reset and junk frames never throw', threw === null, String(threw ?? ''));
  }
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} test-flood-audio: ${checks - fails}/${checks} checks`);
process.exit(fails === 0 ? 0 : 1);
