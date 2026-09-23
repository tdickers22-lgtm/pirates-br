// FRAME PACER (performance-06, b1.5c): a synthetic rAF clock drives the real
// FramePacer and the real FrameGovernor, no browser.
//
// Grades: a 120 Hz (and 144 Hz) display with cap 60 renders 60 +-1 fps, cap 30
// renders 30 +-1, uncapped renders the display rate; a 60 Hz display with rAF
// jitter and cap 60 drops nothing; the per-form defaults (desktop display rate,
// tablet 60, phone 30 with a 60 opt-in, Battery saver 30); the governor's
// targetFps equals the cap and, fed the RENDERED intervals of a fast machine
// under a 30 cap, it never spends quality.
//
// Mutations (each must FAIL):
//   --mutate=noskip     shouldRender always true (the pre-b1.5c loop)
//   --mutate=governor   FrameGovernor.setFrameCap ignored (grades 33 ms frames
//                       against 16.7 ms, the verifier's mis-grading)
//
//   node --import tsx scripts/test-frame-pacer.mjs [--mutate=noskip|governor]
import {
  FramePacer, framePacer, resolveFrameCap, parseFrameCapChoice, BATTERY_SAVER_FPS,
} from '../src/client/core/framePacer.js';
import { FrameGovernor } from '../src/client/rendering/FrameGovernor.js';

const mutate = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length);
if (mutate === 'noskip') FramePacer.prototype.shouldRender = function shouldRender() { return true; };
if (mutate === 'governor') FrameGovernor.prototype.setFrameCap = function setFrameCap() {};
if (mutate) console.log(`MUTATION: ${mutate}`);

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}
function section(name) { console.log(`\n${name}`); }

// Deterministic jitter (no Math.random): a fixed LCG.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Run `seconds` of rAF at `hz` through a pacer; returns rendered fps and the
 *  rendered intervals (what Game.frameBody hands the governor). */
function drive(pacer, hz, seconds, jitterMs = 0, seed = 1) {
  const rnd = lcg(seed);
  const period = 1000 / hz;
  const intervals = [];
  let last = null, rendered = 0;
  const frames = Math.round(seconds * hz);
  for (let i = 1; i <= frames; i += 1) {
    const now = 1000 + i * period + (jitterMs ? (rnd() - 0.5) * 2 * jitterMs : 0);
    if (!pacer.shouldRender(now)) continue;
    rendered += 1;
    if (last !== null) intervals.push(now - last);
    last = now;
  }
  return { fps: rendered / seconds, intervals };
}

section('CAPS HOLD ON FAST DISPLAYS');
{
  const rows = [
    [120, 60, 60], [120, 30, 30], [144, 60, 60], [144, 30, 30], [90, 60, 60], [90, 30, 30],
    [120, 0, 120], [60, 60, 60], [60, 30, 30],
  ];
  for (const [hz, cap, want] of rows) {
    const { fps } = drive(new FramePacer(cap), hz, 20);
    expect(`${hz} Hz rAF, cap ${cap || 'none'} -> ${want} +-1 fps (${fps.toFixed(2)})`, Math.abs(fps - want) <= 1);
  }
  const jittery = drive(new FramePacer(60), 60, 20, 1.2, 7);
  expect(`60 Hz rAF with +-1.2 ms jitter, cap 60 drops nothing (${jittery.fps.toFixed(2)} fps)`, Math.abs(jittery.fps - 60) <= 0.2);
  const slow = drive(new FramePacer(30), 24, 10);
  expect(`a device slower than the cap is never throttled further (24 Hz, cap 30 -> ${slow.fps.toFixed(2)})`, Math.abs(slow.fps - 24) <= 0.2);
  const p = new FramePacer(60);
  drive(p, 120, 5);
  p.setCap(0);
  const after = drive(p, 120, 5);
  expect(`a live cap change applies on the next callback (uncapped again: ${after.fps.toFixed(2)} fps)`, Math.abs(after.fps - 120) <= 1);
}

section('PER-FORM DEFAULTS AND OPTIONS');
{
  const auto = { choice: 'auto', batterySaver: false };
  expect('desktop defaults to the display rate (no cap)', resolveFrameCap('desktop', auto) === 0);
  expect('tablets default to 60', resolveFrameCap('tablet', auto) === 60);
  expect('phones default to 30', resolveFrameCap('phone', auto) === 30);
  expect('…with a 60 opt-in', resolveFrameCap('phone', { choice: '60', batterySaver: false }) === 60);
  expect('desktop options 30 / 60 / uncapped', resolveFrameCap('desktop', { choice: '30', batterySaver: false }) === 30
    && resolveFrameCap('desktop', { choice: '60', batterySaver: false }) === 60
    && resolveFrameCap('desktop', { choice: 'uncapped', batterySaver: false }) === 0);
  expect('Battery saver is 30 on every form, over any choice', BATTERY_SAVER_FPS === 30
    && ['phone', 'tablet', 'desktop'].every((f) => resolveFrameCap(f, { choice: 'uncapped', batterySaver: true }) === 30));
  expect('?fps= values parse; junk does not', parseFrameCapChoice('30') === '30' && parseFrameCapChoice('uncapped') === 'uncapped'
    && parseFrameCapChoice('45') === null && parseFrameCapChoice(null) === null);
  expect('outside a browser the session pacer is uncapped (every node suite byte-identical)', framePacer.getCap() === 0);
}

section('THE GOVERNOR TARGETS THE CAP AND GRADES RENDERED INTERVALS');
{
  // A FAST phone on a 120 Hz panel: 9 ms of real work per frame. Under a 30 cap
  // it renders every 33.3 ms with the GPU two-thirds idle. The governor must
  // chase 30, not 60, and must not spend a single rung on it.
  const run = (cap) => {
    framePacer.setCap(cap);
    const gov = new FrameGovernor({}, 0.85);
    const pacer = new FramePacer(cap);
    const { intervals } = drive(pacer, 120, 30);
    let t = 1000, minScalar = gov.getScalar();
    for (const ms of intervals) {
      t += ms;
      gov.pushFrame(ms);
      minScalar = Math.min(minScalar, gov.update(t));
    }
    framePacer.setCap(0);
    return { gov, minScalar };
  };
  for (const cap of [30, 60]) {
    const { gov, minScalar } = run(cap);
    expect(`cap ${cap}: governor targetFps == ${cap} (got ${gov.getTargetFps()}), budget ${(1000 / cap).toFixed(1)} ms (got ${gov.getTargetBudgetMs().toFixed(1)})`,
      gov.getTargetFps() === cap && Math.abs(gov.getTargetBudgetMs() - 1000 / cap) < 1e-9);
    expect(`cap ${cap}: a machine holding the cap never loses quality (scalar min ${minScalar.toFixed(3)}, stays 'target': ${gov.getMode()})`,
      minScalar >= 0.85 - 1e-9 && gov.getMode() === 'target');
  }
  // THE PHONE AUDITION UNDER A 30 CAP: mobile-gpu opens at the ladder floor and
  // must climb while its frames hold their slot, then stop where they go late.
  // Model: 120 Hz panel, cap 30; frame work = 18 + 20 x scalar ms, so a frame
  // fits its 33.3 ms slot up to scalar ~0.76 and lands one refresh late above.
  {
    framePacer.setCap(30);
    const gov = new FrameGovernor({}, 0);
    const period = 1000 / 120;
    let last = null, due = -Infinity, ready = 0;
    const scalars = [];
    for (let i = 1; i <= 120 * 90; i += 1) {
      const now = 1000 + i * period;
      if (now < ready) continue; // GPU still busy: this refresh shows nothing new
      if (now < due - 1.5) continue; // the pacer's skip
      due = now - due > 1000 / 30 ? now + 1000 / 30 : due + 1000 / 30;
      if (last !== null) {
        const ms = now - last;
        gov.pushFrame(ms);
        gov.update(now);
        scalars.push(gov.getScalar());
      }
      last = now;
      ready = now + 18 + 20 * gov.getScalar();
    }
    framePacer.setCap(0);
    const end = scalars.slice(-600);
    const settled = end.reduce((a, b) => a + b, 0) / end.length;
    let flips = 0;
    for (let i = 2; i < end.length; i += 1) {
      if (Math.sign(end[i] - end[i - 1]) !== 0 && Math.sign(end[i - 1] - end[i - 2]) !== 0
        && Math.sign(end[i] - end[i - 1]) !== Math.sign(end[i - 1] - end[i - 2])) flips += 1;
    }
    expect(`a paced phone opening at the floor climbs toward what it can hold (settled scalar ${settled.toFixed(3)}, fits up to ~0.76)`,
      settled >= 0.55 && settled <= 0.8);
    expect(`…and holds there instead of pumping (${flips} direction reversals in the last 20 s)`, flips <= 1);
  }
  // Uncapped on a 120 Hz desktop keeps the pre-b1.5c rule: target min(60, display).
  framePacer.setCap(0);
  const g = new FrameGovernor();
  g.setDisplayHz(120);
  g.update(1);
  expect(`uncapped 120 Hz desktop still chases 60 (got ${g.getTargetFps()})`, g.getTargetFps() === 60);
  framePacer.setCap(30);
  g.update(2);
  expect(`…and a live Battery saver retargets it to 30 on the next update (got ${g.getTargetFps()})`, g.getTargetFps() === 30);
  framePacer.setCap(0);
  g.update(3);
  expect(`…and back to 60 when it is switched off (got ${g.getTargetFps()})`, g.getTargetFps() === 60);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nFrame pacer checks passed.');
