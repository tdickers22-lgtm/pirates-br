#!/usr/bin/env node
// THE FRAME GOVERNOR, GRADED WITHOUT A GPU.
//
// Every property this controller has to have is a property of its RESPONSE over
// time — does it converge, does it stop, does it come back, does it stay inside
// its clamps — and none of those can be measured on this machine's only GL
// backend, which draws this scene at one to five frames a second. So the
// controller was written GL-free (no THREE, no DOM, no `performance`) and this
// suite drives it against SIMULATED MACHINES: a frame-time model that responds
// to the quality scalar the way the cost model says a real one does.
//
// The machine model is deliberately crude and deliberately honest about it:
//
//   frameMs = fixedMs + fillMs × (pixelRatio / maxRatio)²
//             + dressingMs × lodRadiusScale
//             + shadowMs × (shadowMapSize / baseSize)
//
// — which is exactly the scaling law docs/FRAME_COST_MODEL.md §8.1 proves
// analytically (fragments go as ratio², draws/triangles/shadow texels do not).
// The absolute milliseconds are made up; the SHAPE is not, and the shape is
// what a controller is graded on.
//
//   node --import tsx scripts/test-frame-governor.mjs
import {
  FrameGovernor,
  GOVERNOR_TUNING,
  resolveLevers,
  describeGovernor,
  pixelRatioCaps,
  TIER_PIXEL_BUDGET,
  TIER_MAX_PIXEL_RATIO,
  TIER_NATIVE_FLOOR_MAX_PIXELS,
} from '../src/client/rendering/FrameGovernor.js';
import { budgeted, setFrameBudgetScale, resetFrameBudgetScale } from '../src/client/rendering/FrameBudget.js';
import { parseRenderQuality } from '../src/client/rendering/QualityPreference.js';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}
function section(name) { console.log(`\n${name}`); }

const CAPS = {
  low: { tier: 'low', maxPixelRatio: 0.62, minPixelRatio: 0.44, baseShadowMapSize: 0 },
  // The tiers' OPENING shadow maps, as Renderer.baseShadowMapSize sets them.
  balanced: { tier: 'balanced', maxPixelRatio: 1.15, minPixelRatio: 0.58, baseShadowMapSize: 1536 },
  high: { tier: 'high', maxPixelRatio: 1.25, minPixelRatio: 0.8, baseShadowMapSize: 2048 },
};

/** A machine whose frame time responds to the levers the way §8.1 says. */
function makeMachine(caps, { fixedMs, fillMs, dressingMs = 0, shadowMs = 0, jitter = 0 }) {
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return (scalar) => {
    const l = resolveLevers(scalar, caps);
    const fill = (l.pixelRatio / caps.maxPixelRatio) ** 2;
    const shadow = caps.baseShadowMapSize > 0 ? l.shadowMapSize / caps.baseShadowMapSize : 0;
    const ms = fixedMs + fillMs * fill + dressingMs * l.lodRadiusScale + shadowMs * shadow;
    return ms * (1 + (rand() * 2 - 1) * jitter);
  };
}

/** Run `seconds` of simulated play. Returns the scalar trace, sampled per step. */
function run(gov, machine, seconds, { startMs = 0, oneOffEvery = 0, oneOffMs = 0 } = {}) {
  let now = startMs;
  const end = startMs + seconds * 1000;
  const trace = [];
  let frames = 0;
  while (now < end) {
    const ms = machine(gov.getScalar());
    const hitch = oneOffEvery > 0 && frames > 0 && frames % oneOffEvery === 0;
    gov.pushFrame(hitch ? oneOffMs : ms, hitch);
    now += hitch ? oneOffMs : ms;
    gov.update(now);
    trace.push(gov.getScalar());
    frames += 1;
    if (frames > 200000) break;
  }
  return { trace, frames, now };
}

/** Sum of |Δ| over the tail of a trace — a limit cycle shows up here and a
 *  converged controller does not. */
function totalVariation(trace, fromFraction = 0.5) {
  let tv = 0;
  const from = Math.floor(trace.length * fromFraction);
  for (let i = from + 1; i < trace.length; i++) tv += Math.abs(trace[i] - trace[i - 1]);
  return tv;
}

// ═══════════════════════════════════════════════════════════════════════════
section('STEP RESPONSE — a machine that is too slow gets quality taken away');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A `low`-tier machine at ~45fps with the picture wide open. The only levers
  // that reach it are resolution (no shadows at this tier) and dressing — which
  // is exactly the situation §8.1 describes, and the reason the ladder at this
  // tier is resolution-first.
  const machine = makeMachine(CAPS.low, { fixedMs: 4, fillMs: 14, dressingMs: 4 });
  const gov = new FrameGovernor();
  const before = machine(1);
  const { trace } = run(gov, machine, 30);
  const after = machine(gov.getScalar());
  expect('an over-budget machine loses quality', gov.getScalar() < 1,
    `scalar stayed at ${gov.getScalar()}`);
  expect('…and the frame time actually comes down', after < before - 1,
    `${before.toFixed(1)}ms → ${after.toFixed(1)}ms`);
  expect('…and it reaches the 60fps budget it was chasing', after <= 1000 / 60 + 0.5,
    `settled at ${after.toFixed(2)}ms on scalar ${gov.getScalar().toFixed(3)}`);
  expect('…without spending the whole ladder to get there', gov.getScalar() > 0.05,
    `bottomed out at ${gov.getScalar()}`);
  expect('…and it is still in target mode, not floor mode', gov.getMode() === 'target', gov.getMode());
  expect('the descent is monotone — no quality is handed back on the way down',
    trace.every((v, i) => i === 0 || v <= trace[i - 1] + 1e-9));
}

{
  // A machine that is already fast must not be touched at all.
  const machine = makeMachine(CAPS.high, { fixedMs: 4, fillMs: 5, shadowMs: 2, dressingMs: 1 });
  const gov = new FrameGovernor();
  const { trace } = run(gov, machine, 30);
  expect('a machine that is comfortably inside budget is left entirely alone',
    trace.every((v) => v === 1), `scalar reached ${gov.getScalar()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('NO OSCILLATION — the dead band has to make a limit cycle impossible');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The nastiest case for a closed loop: a machine sitting exactly ON the
  // target, where every step overshoots the trigger in the other direction.
  const machine = makeMachine(CAPS.low, { fixedMs: 5, fillMs: 12.5, dressingMs: 2 });
  const gov = new FrameGovernor();
  const { trace } = run(gov, machine, 120);
  const tv = totalVariation(trace, 0.5);
  expect('a machine parked on the threshold does not pump the quality scalar',
    tv <= 0.15, `total variation over the last minute was ${tv.toFixed(3)}`);
}
{
  // …and with 8% frame-to-frame jitter on top, which is what a real machine
  // does and what a naive controller mistakes for a signal.
  const machine = makeMachine(CAPS.balanced, { fixedMs: 6, fillMs: 14, shadowMs: 4, dressingMs: 3, jitter: 0.08 });
  const gov = new FrameGovernor();
  const { trace } = run(gov, machine, 180);
  const tv = totalVariation(trace, 0.6);
  expect('nor does jitter around the threshold', tv <= 0.25,
    `total variation over the tail was ${tv.toFixed(3)}`);
  const tail = trace.slice(Math.floor(trace.length * 0.6));
  const spread = Math.max(...tail) - Math.min(...tail);
  expect('…and the scalar stays inside a narrow band once settled', spread <= 0.12,
    `tail spread ${spread.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('HYSTERESIS — nothing inside the dead band moves anything');
// ═══════════════════════════════════════════════════════════════════════════
{
  const budget = 1000 / GOVERNOR_TUNING.targetFps;
  // Dead centre of the band: above the up trigger (0.80) and below the down
  // trigger (1.00), so BOTH directions must refuse.
  const inBand = budget * 0.9;
  const gov = new FrameGovernor();
  gov.pushFrame(budget * 3); // seed a down step so there is room to go up
  let now = 0;
  for (let i = 0; i < 2000; i++) { gov.pushFrame(inBand); now += inBand; gov.update(now); }
  expect('a frame time inside the dead band never moves the scalar, ever',
    gov.getScalar() === 1, `scalar drifted to ${gov.getScalar()}`);
}
{
  // Just outside on the fast side must move it, or the band is not a band, it
  // is a wall. (Same setup, run from a scalar that has room to rise.)
  const budget = 1000 / GOVERNOR_TUNING.targetFps;
  const gov = new FrameGovernor();
  let now = 0;
  for (let i = 0; i < 400; i++) { gov.pushFrame(budget * 2); now += budget * 2; gov.update(now); }
  const dropped = gov.getScalar();
  expect('a slow machine dropped below full quality first', dropped < 1, `scalar ${dropped}`);
  for (let i = 0; i < 4000; i++) { gov.pushFrame(budget * 0.7); now += budget * 0.7; gov.update(now); }
  expect('…and a frame time just outside the band on the fast side does move it',
    gov.getScalar() > dropped, `scalar stuck at ${gov.getScalar()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('RECOVERY — quality comes back when the machine does');
// ═══════════════════════════════════════════════════════════════════════════
{
  const caps = CAPS.balanced;
  const slow = makeMachine(caps, { fixedMs: 8, fillMs: 22, shadowMs: 8, dressingMs: 5 });
  const fast = makeMachine(caps, { fixedMs: 3, fillMs: 5, shadowMs: 2, dressingMs: 1 });
  const gov = new FrameGovernor();
  const first = run(gov, slow, 40);
  const sank = gov.getScalar();
  expect('a struggling machine gives quality away', sank < 0.9, `scalar ${sank}`);
  const second = run(gov, fast, 90, { startMs: first.now });
  expect('…and gets it back once the load lifts', gov.getScalar() > sank + 0.1,
    `recovered only to ${gov.getScalar().toFixed(3)} from ${sank.toFixed(3)}`);
  expect('recovery is gradual, not a jump back to full',
    second.trace.filter((v, i) => i > 0 && v > second.trace[i - 1]).length > 3,
    'quality came back in fewer than four steps');
  expect('…and it does climb all the way home on a machine that can hold it',
    gov.getScalar() > 0.98, `stopped at ${gov.getScalar().toFixed(3)}`);
}
{
  // Recovery must be SLOWER than the descent: being wrong upward costs a second
  // visible change, and a pair of those is the pump this design forbids.
  const caps = CAPS.low;
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  let downSteps = 0;
  let prev = gov.getScalar();
  for (let i = 0; i < 3000; i++) {
    gov.pushFrame(budget * 2.2); now += budget * 2.2; gov.update(now);
    if (gov.getScalar() < prev) downSteps += 1;
    prev = gov.getScalar();
  }
  const downElapsed = now;
  const sank = gov.getScalar();
  let upSteps = 0;
  const upStart = now;
  while (gov.getScalar() < sank + 0.1 && now - upStart < 600000) {
    gov.pushFrame(budget * 0.5); now += budget * 0.5; gov.update(now);
    if (gov.getScalar() > prev) upSteps += 1;
    prev = gov.getScalar();
  }
  expect('the ladder is asymmetric: coming back up takes more steps than going down',
    upSteps > downSteps || GOVERNOR_TUNING.maxUpStep < GOVERNOR_TUNING.maxDownStep,
    `${downSteps} down in ${(downElapsed / 1000).toFixed(1)}s, ${upSteps} up`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('CLAMPS — the scalar and every lever stay inside their bounds');
// ═══════════════════════════════════════════════════════════════════════════
{
  const machine = makeMachine(CAPS.low, { fixedMs: 400, fillMs: 100 }); // hopeless
  const gov = new FrameGovernor();
  const { trace } = run(gov, machine, 300);
  expect('the scalar never leaves [0,1]', trace.every((v) => v >= 0 && v <= 1));
  expect('a hopeless machine bottoms out at exactly 0', gov.getScalar() === 0, `${gov.getScalar()}`);
}
{
  for (const tier of ['low', 'balanced', 'high']) {
    const caps = CAPS[tier];
    let ok = true;
    let detail = '';
    for (let i = 0; i <= 1000; i++) {
      const l = resolveLevers(i / 1000, caps);
      if (l.pixelRatio < caps.minPixelRatio - 1e-9 || l.pixelRatio > caps.maxPixelRatio + 1e-9) {
        ok = false; detail = `pixelRatio ${l.pixelRatio} at q=${i / 1000}`; break;
      }
      if (l.lodRadiusScale < 0.7 - 1e-9 || l.lodRadiusScale > 1 + 1e-9) {
        ok = false; detail = `lodRadiusScale ${l.lodRadiusScale}`; break;
      }
      if (l.instanceDensityScale < 0.6 - 1e-9 || l.instanceDensityScale > 1 + 1e-9) {
        ok = false; detail = `instanceDensityScale ${l.instanceDensityScale}`; break;
      }
      if (l.particleScale < 0.5 - 1e-9 || l.particleScale > 1 + 1e-9) {
        ok = false; detail = `particleScale ${l.particleScale}`; break;
      }
      if (l.shadowMapSize > caps.baseShadowMapSize) {
        ok = false; detail = `shadowMapSize ${l.shadowMapSize} > base ${caps.baseShadowMapSize}`; break;
      }
      if (caps.baseShadowMapSize > 0 && l.shadowMapSize < 1024) {
        ok = false; detail = `shadowMapSize ${l.shadowMapSize} below the 1024 floor`; break;
      }
      if (l.shadowExtentScale < 0.6 - 1e-9 || l.shadowExtentScale > 1 + 1e-9) {
        ok = false; detail = `shadowExtentScale ${l.shadowExtentScale}`; break;
      }
    }
    expect(`every lever at '${tier}' stays inside its clamp across the whole ladder`, ok, detail);
  }
}
{
  // Shadows are NEVER switched off by the governor: that changes every
  // material's program key and re-links the scene, which is the hitch class the
  // whole campaign exists to remove.
  const off = resolveLevers(0, CAPS.high);
  expect('the governor never switches shadows off — that would re-link the scene',
    off.shadowMapSize > 0, `shadowMapSize ${off.shadowMapSize}`);
  const none = resolveLevers(0, CAPS.low);
  expect('…and a tier with no shadows reports none rather than inventing a map',
    none.shadowMapSize === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('LEVER ORDER — the invisible knobs are spent before the visible one');
// ═══════════════════════════════════════════════════════════════════════════
{
  // At `high`, one full shadow-map step must be taken before a single pixel of
  // resolution is given up (§8.1: the map is 32× the framebuffer and the
  // resolution ladder cannot touch a texel of it).
  const caps = CAPS.high;
  let firstShadowDrop = 1;
  let firstResolutionDrop = 1;
  for (let i = 1000; i >= 0; i--) {
    const q = i / 1000;
    const l = resolveLevers(q, caps);
    if (firstShadowDrop === 1 && l.shadowMapSize < caps.baseShadowMapSize) firstShadowDrop = q;
    if (firstResolutionDrop === 1 && l.pixelRatio < caps.maxPixelRatio - 1e-9) firstResolutionDrop = q;
  }
  expect("at 'high' the shadow map is cut before the resolution is",
    firstShadowDrop > firstResolutionDrop,
    `shadow at q=${firstShadowDrop}, resolution at q=${firstResolutionDrop}`);
}
{
  // At `low` there is no shadow map, so resolution IS the first lever — it is
  // the only thing at that tier that reaches the fill at all.
  const caps = CAPS.low;
  const nearFull = resolveLevers(0.99, caps);
  expect("at 'low' resolution moves from the very first step", nearFull.pixelRatio < caps.maxPixelRatio,
    `pixelRatio ${nearFull.pixelRatio} at q=0.99`);
}
{
  // Resolution is the fine adjustment: it must be CONTINUOUS, with no step
  // large enough to read as a resolution change rather than a drift.
  let worst = 0;
  for (let i = 1; i <= 1000; i++) {
    const a = resolveLevers((i - 1) / 1000, CAPS.low).pixelRatio;
    const b = resolveLevers(i / 1000, CAPS.low).pixelRatio;
    worst = Math.max(worst, Math.abs(a - b));
  }
  expect('resolution moves continuously — no jump anywhere on the ladder', worst < 0.002,
    `largest single-step jump was ${worst.toFixed(4)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('WARMUP AND ONE-OFFS — a match start is not a measurement');
// ═══════════════════════════════════════════════════════════════════════════
{
  const gov = new FrameGovernor();
  let now = 0;
  for (let i = 0; i < GOVERNOR_TUNING.warmupFrames; i++) { gov.pushFrame(900); now += 900; gov.update(now); }
  expect('the warmup frames cannot move the scalar', gov.getScalar() === 1, `${gov.getScalar()}`);
  expect('…and they are not in the window either', gov.getStats().samples === 0);
}
{
  // A 4,672 ms shader-link hitch (the worst single one in the census) once
  // every couple of seconds, flagged by the caller, must not sink the picture.
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  for (let i = 0; i < 4000; i++) {
    const hitch = i > 40 && i % 12 === 0;
    gov.pushFrame(hitch ? 4672 : budget * 0.7, hitch);
    now += hitch ? 4672 : budget * 0.7;
    gov.update(now);
  }
  expect('a flagged one-off hitch does not cost the player any quality',
    gov.getScalar() === 1, `scalar ${gov.getScalar()}`);
}
{
  // The same trace with the flag dropped is the control: if these frames were
  // counted they would sink the picture, which is what makes the flag load-
  // bearing rather than decorative.
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  for (let i = 0; i < 4000; i++) {
    const hitch = i > 40 && i % 12 === 0;
    gov.pushFrame(hitch ? 4672 : budget * 0.7);
    now += hitch ? 4672 : budget * 0.7;
    gov.update(now);
  }
  expect('…and the identical trace UNflagged does cost quality (the control)',
    gov.getScalar() < 1, `scalar ${gov.getScalar()}`);
}
{
  // RATE LIMITING. Two steps may never land closer together than the settle
  // window, because a frame rendered before a change says nothing about the
  // setting after it — and a controller stepping off stale frames is exactly
  // how a ladder overshoots and then has to pump its way back.
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  let prev = gov.getScalar();
  let lastStepAt = -1;
  let minGap = Infinity;
  // Only just over budget on purpose: at 17.5 ms a frame the window fills in
  // 210 ms and the down interval is 250 ms, so the ONLY thing that can hold two
  // steps apart here is the settle window itself.
  for (let i = 0; i < 6000; i++) {
    gov.pushFrame(budget * 1.05); now += budget * 1.05; gov.update(now);
    if (gov.getScalar() !== prev) {
      if (lastStepAt >= 0) minGap = Math.min(minGap, now - lastStepAt);
      lastStepAt = now;
      prev = gov.getScalar();
    }
  }
  // The bound is written out rather than read from GOVERNOR_TUNING on purpose:
  // an assertion that quotes the constant it is testing passes for any value of
  // it, which is how a settle window can be deleted without a test noticing.
  expect('consecutive steps are at least a settle window apart',
    minGap >= 400, `closest two steps were ${minGap.toFixed(0)}ms apart`);
}
{
  // THE REBOUND LOCKOUT. A machine that looks fast the instant after a down
  // step is usually looking fast BECAUSE of the down step; handing the quality
  // straight back is the first half of a pump.
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  const prevScalar = () => gov.getScalar();
  while (prevScalar() === 1 && now < 60000) { gov.pushFrame(budget * 2.5); now += budget * 2.5; gov.update(now); }
  const droppedAt = now;
  const dropped = gov.getScalar();
  expect('a down step was taken', dropped < 1);
  while (gov.getScalar() <= dropped && now - droppedAt < 60000) {
    gov.pushFrame(budget * 0.3); now += budget * 0.3; gov.update(now);
  }
  const gap = now - droppedAt;
  expect('quality is not handed back inside the rebound lockout',
    gap >= 3400,
    `an instantly-fast machine got quality back ${gap.toFixed(0)}ms after losing it`);
}
{
  // …but UNflagged sustained hitching is exactly what p95 exists to catch.
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  for (let i = 0; i < 4000; i++) {
    const hitch = i % 9 === 0;
    gov.pushFrame(hitch ? budget * 3 : budget * 0.6);
    now += hitch ? budget * 3 : budget * 0.6;
    gov.update(now);
  }
  expect('sustained unflagged hitching does cost quality — that is what p95 is for',
    gov.getScalar() < 1, `scalar ${gov.getScalar()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('SUSPENSION — frames during a world build are not evidence');
// ═══════════════════════════════════════════════════════════════════════════
{
  const gov = new FrameGovernor();
  gov.setSuspended(true);
  let now = 0;
  for (let i = 0; i < 3000; i++) { gov.pushFrame(2000); now += 2000; gov.update(now); }
  expect('a suspended governor learns nothing from the load', gov.getScalar() === 1);
  expect('…because those frames never entered the window at all',
    gov.getStats().samples === 0, `${gov.getStats().samples} samples`);
  expect('…and reports it', gov.isSuspended() && gov.getMode() === 'target');
  gov.setSuspended(false);
  expect('…and coming back out re-arms the warmup', gov.getStats().samples === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('FLOOR MODE — bottoming out and still missing means HOLD, not degrade');
// ═══════════════════════════════════════════════════════════════════════════
{
  const machine = makeMachine(CAPS.low, { fixedMs: 10, fillMs: 18 }); // 28ms at full, 19ms at the floor: over the 60fps budget everywhere
  const gov = new FrameGovernor();
  const { trace } = run(gov, machine, 240);
  expect('a machine that cannot reach 60 at any setting ends in floor mode',
    gov.getMode() === 'floor', `mode ${gov.getMode()}`);
  expect('…having spent the whole ladder first', gov.getScalar() === 0, `${gov.getScalar()}`);
  expect('…and it HOLDS there instead of pumping', totalVariation(trace, 0.6) === 0,
    `tail variation ${totalVariation(trace, 0.6)}`);
  expect('…chasing 30 rather than pretending about 60', gov.getTargetFps() === 30);
}
{
  // Floor mode must not become a ratchet: once it stops chasing 60, the 30fps
  // budget is easy and a naive controller would climb back to full quality and
  // start stuttering again. The ceiling is frozen where it was.
  const caps = CAPS.low;
  const gov = new FrameGovernor();
  const hopeless = makeMachine(caps, { fixedMs: 10, fillMs: 18 });
  const first = run(gov, hopeless, 240);
  expect('floor mode was reached', gov.getMode() === 'floor');
  const held = gov.getScalar();
  const second = run(gov, hopeless, 240, { startMs: first.now });
  expect('the frozen ceiling stops floor mode ratcheting quality back up',
    gov.getScalar() === held && totalVariation(second.trace, 0) === 0,
    `drifted from ${held} to ${gov.getScalar()}`);
}
{
  // …and a machine that genuinely gets faster is let back out of floor mode.
  const caps = CAPS.low;
  const gov = new FrameGovernor();
  const hopeless = makeMachine(caps, { fixedMs: 10, fillMs: 18 });
  const first = run(gov, hopeless, 240);
  expect('floor mode was reached before the recovery test', gov.getMode() === 'floor');
  const recovered = makeMachine(caps, { fixedMs: 3, fillMs: 4 });
  run(gov, recovered, 120, { startMs: first.now });
  expect('a machine that genuinely recovers is let back out of floor mode',
    gov.getMode() === 'target', `mode ${gov.getMode()}`);
  expect('…and its quality comes back with it', gov.getScalar() > 0.2, `${gov.getScalar()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('DISABLED — a probe pinning quality must get exactly what it pinned');
// ═══════════════════════════════════════════════════════════════════════════
{
  const gov = new FrameGovernor();
  gov.setEnabled(false);
  let now = 0;
  for (let i = 0; i < 5000; i++) { gov.pushFrame(2000); now += 2000; gov.update(now); }
  expect('a disabled governor never moves the scalar', gov.getScalar() === 1);
  expect('…and says so', gov.getMode() === 'off');
  expect('…and does not throttle streaming either', gov.getStreamingScale() === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('STREAMING BUDGET — one signal, floored so it can never deadlock');
// ═══════════════════════════════════════════════════════════════════════════
{
  const gov = new FrameGovernor();
  const budget = 1000 / 60;
  let now = 0;
  for (let i = 0; i < 400; i++) { gov.pushFrame(budget * 4); now += budget * 4; gov.update(now); }
  const overloaded = gov.getStreamingScale();
  expect('an overloaded frame backs streaming off', overloaded < 0.6, `${overloaded}`);
  const gov2 = new FrameGovernor();
  now = 0;
  for (let i = 0; i < 400; i++) { gov2.pushFrame(budget * 0.4); now += budget * 0.4; gov2.update(now); }
  expect('a frame with headroom streams FASTER, not merely normally',
    gov2.getStreamingScale() > 1.1, `${gov2.getStreamingScale()}`);
}
{
  resetFrameBudgetScale();
  expect('the default budget scale changes nothing', budgeted(48) === 48 && budgeted(6) === 6);
  setFrameBudgetScale(0.25);
  expect('a throttled frame still gets a whole island, never zero', budgeted(1, 1) === 1);
  expect('…and the mesh allowance is cut but not extinguished',
    budgeted(48, 8) === 12, `${budgeted(48, 8)}`);
  setFrameBudgetScale(0.01);
  expect('the floor is a hard floor, whatever the signal says', budgeted(48, 8) === 8);
  setFrameBudgetScale(1.4);
  expect('headroom raises the allowance', budgeted(6, 1) === 8, `${budgeted(6, 1)}`);
  setFrameBudgetScale(NaN);
  expect('a garbage signal falls back to 1 rather than stalling the world', budgeted(48, 8) === 48);
  resetFrameBudgetScale();
}

// ═══════════════════════════════════════════════════════════════════════════
section('THE HONEST LABEL — the panel says what is actually running');
// ═══════════════════════════════════════════════════════════════════════════
{
  expect('the player-facing medium URL maps to the proven middle engine tier',
    parseRenderQuality('medium') === 'balanced');
  const l = resolveLevers(0.5, CAPS.low);
  const auto = describeGovernor('low', false, 'target', l);
  expect('auto mode names the tier it landed on and the resolution it is running',
    auto.startsWith('Auto — Low,') && /\d\.\d\d× resolution/.test(auto), auto);
  const pinned = describeGovernor('high', true, 'target', resolveLevers(1, CAPS.high));
  expect('a pinned tier says it is pinned', pinned.startsWith('High (pinned)'), pinned);
  const medium = describeGovernor('balanced', true, 'target', resolveLevers(1, CAPS.balanced));
  expect('the internal balanced tier is named Medium for the player',
    medium.startsWith('Medium (pinned)'), medium);
  const floor = describeGovernor('low', false, 'floor', l);
  expect('floor mode says out loud that it stopped chasing 60',
    floor.includes('holding 30fps'), floor);
}

// ═══════════════════════════════════════════════════════════════════════════
section('THE BILL IS PIXELS, NOT A RATIO — pixelRatioCaps per viewport (perf-21)');
// ═══════════════════════════════════════════════════════════════════════════
// RED before this lane: the caps were `min(devicePixelRatio, MAX_PIXEL_RATIO[q])`
// with a `innerWidth < 900 -> 0.72` patch on top, so an iPhone 14 at 'low'
// opened at 0.62 x 390 = 242 device pixels wide and the ladder's floor took it
// to 172. Every row below that names a WIDTH failed.
{
  // 390x844 CSS at dPR 3 — an iPhone 14 in Safari.
  const phone = pixelRatioCaps('low', 390, 844, 3);
  const phoneOpenW = 390 * phone.maxPixelRatio;
  const phoneFloorW = 390 * phone.minPixelRatio;
  expect(`a dPR-3 phone at 'low' opens at least 640 device px wide (${phoneOpenW.toFixed(0)} px)`,
    phoneOpenW >= 640 - 0.5, `maxPixelRatio ${phone.maxPixelRatio.toFixed(3)}`);
  expect(`…and the ladder's floor never takes it below 480 px (${phoneFloorW.toFixed(0)} px)`,
    phoneFloorW >= 480 - 0.5, `minPixelRatio ${phone.minPixelRatio.toFixed(3)}`);
  expect('…and never asks a phone for more than its own panel',
    phone.maxPixelRatio <= 3 + 1e-9);

  // 1470x956 CSS at dPR 2 — the fanless Air this game was tuned on. The
  // budget must reproduce the numbers that calibration produced.
  const air = pixelRatioCaps('low', 1470, 956, 2);
  expect(`the tuned desktop is unchanged at 'low' (max ${air.maxPixelRatio.toFixed(3)}, min ${air.minPixelRatio.toFixed(3)})`,
    Math.abs(air.maxPixelRatio - 0.62) < 0.005 && Math.abs(air.minPixelRatio - 0.44) < 0.005);
  const airHigh = pixelRatioCaps('high', 1470, 956, 2);
  expect(`…and at 'high' (max ${airHigh.maxPixelRatio.toFixed(3)}, min ${airHigh.minPixelRatio.toFixed(3)})`,
    Math.abs(airHigh.maxPixelRatio - 1.25) < 0.005 && Math.abs(airHigh.minPixelRatio - 0.8) < 0.005);

  // Tighten, never loosen: no viewport may earn a ratio above the tier ceiling.
  const viewports = [[390, 844, 3], [412, 915, 2.625], [1366, 768, 1], [1470, 956, 2], [1920, 1080, 1], [2560, 1440, 2], [3840, 2160, 1]];
  let loosened = null, overBudget = null;
  for (const q of ['low', 'balanced', 'high']) {
    for (const [w, h, dpr] of viewports) {
      const caps = pixelRatioCaps(q, w, h, dpr);
      if (caps.maxPixelRatio > TIER_MAX_PIXEL_RATIO[q] + 1e-9 && w * caps.maxPixelRatio > 640.5) {
        loosened ??= `${q} ${w}x${h}@${dpr} -> ${caps.maxPixelRatio.toFixed(3)}`;
      }
      const px = (w * caps.maxPixelRatio) * (h * caps.maxPixelRatio);
      // Over budget is allowed at exactly two sanctioned floors: the 640 px
      // legibility floor, and the native floor (Medium/High do not render below
      // the panel's own grid on a panel small enough to afford it — review-2
      // P1). Both are BOUNDED: the native one only applies under
      // TIER_NATIVE_FLOOR_MAX_PIXELS, so a 1440p or 4K desktop is still billed
      // by the budget.
      const atNativeFloor = w * h <= TIER_NATIVE_FLOOR_MAX_PIXELS[q]
        && Math.abs(caps.maxPixelRatio - Math.min(dpr, 1)) < 1e-9;
      if (px > TIER_PIXEL_BUDGET[q] * 1.02 && w * caps.maxPixelRatio > 640.5 && !atNativeFloor) {
        overBudget ??= `${q} ${w}x${h}@${dpr} -> ${(px / 1e6).toFixed(2)} Mpx`;
      }
      if (caps.minPixelRatio > caps.maxPixelRatio + 1e-9) loosened ??= `${q} ${w}x${h}: floor above ceiling`;
    }
  }
  expect('no viewport is handed a ratio above its tier ceiling', loosened === null, loosened ?? '');
  expect('…and no viewport exceeds its tier framebuffer budget except at the 640 px / native floors',
    overBudget === null, overBudget ?? '');

  // THE NATIVE FLOOR, STATED AS ROWS (review-2 P1). Medium was taking the
  // commonest desktop there is BELOW native — 1920x1080 dPR 1 derived 0.761 and
  // shipped a 1461x822 buffer upscaled onto a native panel — and the owner's own
  // Air from 1.15 to 0.92, with no owner decision behind either. Fidelity is the
  // north star's first term; the floor is bounded by pixel count so it cannot
  // hand a big desktop the bill the budget exists to stop.
  const desk1080 = pixelRatioCaps('balanced', 1920, 1080, 1);
  expect(`Medium renders a 1080p dPR-1 desktop at native, not 0.761 (max ${desk1080.maxPixelRatio.toFixed(3)})`,
    Math.abs(desk1080.maxPixelRatio - 1) < 1e-9);
  const airBal = pixelRatioCaps('balanced', 1470, 956, 2);
  expect(`…and the Air's Medium is floored at its own grid too (max ${airBal.maxPixelRatio.toFixed(3)})`,
    Math.abs(airBal.maxPixelRatio - 1) < 1e-9);
  const uhdBal = pixelRatioCaps('balanced', 3840, 2160, 1);
  expect(`…but a 4K panel is over TIER_NATIVE_FLOOR_MAX_PIXELS and keeps the budget (max ${uhdBal.maxPixelRatio.toFixed(3)}, ${((3840 * uhdBal.maxPixelRatio) * (2160 * uhdBal.maxPixelRatio) / 1e6).toFixed(2)} Mpx)`,
    uhdBal.maxPixelRatio < 0.95
    && (3840 * uhdBal.maxPixelRatio) * (2160 * uhdBal.maxPixelRatio) <= TIER_PIXEL_BUDGET.balanced * 1.02);
  const phoneLow = pixelRatioCaps('low', 390, 844, 3);
  const deskLow = pixelRatioCaps('low', 1920, 1080, 1);
  expect(`the LOW tier gets no native floor at all — tighten, never loosen (phone ${phoneLow.maxPixelRatio.toFixed(3)}, 1080p ${deskLow.maxPixelRatio.toFixed(3)})`,
    TIER_NATIVE_FLOOR_MAX_PIXELS.low === 0 && deskLow.maxPixelRatio < 0.95);
  expect('and no floor ever becomes supersampling (never above dPR, never above 1.0)',
    [[1366, 768, 1], [1470, 956, 2], [1920, 1080, 1]].every(([w, h, d]) => {
      const c = pixelRatioCaps('balanced', w, h, d);
      return c.maxPixelRatio <= Math.max(TIER_MAX_PIXEL_RATIO.balanced, 1) + 1e-9 && c.maxPixelRatio <= d + 1e-9;
    }));

  // A 4K desktop is the case the ratio ladder was silently worst at: 1.25 of
  // 3840x2160 is 12.9 Mpx, five times what 'high' was ever measured against.
  const uhd = pixelRatioCaps('high', 3840, 2160, 1);
  const uhdPx = (3840 * uhd.maxPixelRatio) * (2160 * uhd.maxPixelRatio);
  expect(`a 4K panel at 'high' stays inside 2.4 Mpx (${(uhdPx / 1e6).toFixed(2)} Mpx at ${uhd.maxPixelRatio.toFixed(3)})`,
    uhdPx <= TIER_PIXEL_BUDGET.high * 1.02);

  // The ladder still has to be a ladder with the derived caps.
  const phoneCaps = { tier: 'low', ...phone, baseShadowMapSize: 0 };
  let outside = null;
  for (let i = 0; i <= 1000; i += 1) {
    const l = resolveLevers(i / 1000, phoneCaps);
    if (l.pixelRatio < phone.minPixelRatio - 1e-9 || l.pixelRatio > phone.maxPixelRatio + 1e-9) {
      outside ??= `scalar ${(i / 1000).toFixed(3)} -> ${l.pixelRatio}`;
    }
  }
  expect('the levers stay inside the derived caps across the whole ladder', outside === null, outside ?? '');
}

// ═══════════════════════════════════════════════════════════════════════════
section('A 30 Hz CAP IS NOT A SLOW MACHINE — setDisplayHz (perf-v-01)');
// ═══════════════════════════════════════════════════════════════════════════
// Low Power Mode on macOS/iOS, and some external monitors, cap requestAnimation-
// Frame at 30 Hz regardless of load: every frame arrives at ~33 ms with the GPU
// idle. Against a 16.7 ms budget that reads as 2x over on EVERY frame.
{
  // The machine's own work is 4 ms; the other 29 ms is the display waiting.
  const run = (hz) => {
    const gov = new FrameGovernor({}, 1);
    if (hz) gov.setDisplayHz(hz);
    let now = 0;
    for (let i = 0; i < 3000; i += 1) { gov.pushFrame(33.3); now += 33.3; gov.update(now); }
    return { scalar: gov.getScalar(), mode: gov.getMode() };
  };
  const capped = run(30);
  const control = run(0);
  expect(`33 ms frames on a 30 Hz display keep the picture whole (scalar ${capped.scalar.toFixed(3)})`,
    capped.scalar >= 0.999, `mode ${capped.mode}`);
  // THE CONTROL: without the display signal the very same trace is graded
  // against 60 Hz and the ladder is spent to the floor. If this ever passes,
  // setDisplayHz has become a no-op and the row above is vacuous.
  expect(`…and without it the same trace is stripped to the floor (scalar ${control.scalar.toFixed(3)})`,
    control.scalar <= 0.01, `mode ${control.mode}`);
  const gov = new FrameGovernor({}, 1);
  gov.setDisplayHz(30);
  expect(`the budget follows the display (${gov.getTargetBudgetMs().toFixed(1)} ms)`,
    Math.abs(gov.getTargetBudgetMs() - 1000 / 30) < 0.01);
  gov.setDisplayHz(144);
  expect('…but never above 60: the game is budgeted for 60, not for the panel',
    Math.abs(gov.getTargetBudgetMs() - 1000 / 60) < 0.01, `${gov.getTargetBudgetMs()} ms`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('A TIER IS A LOOK; A GPU CLASS IS A FILL CEILING — fillCeilingForGpu (airsafe)');
// ═══════════════════════════════════════════════════════════════════════════
// RED on HEAD 8d5cc8db: `decideRenderQuality` hands back a `?quality=` or a
// stored player choice FIRST and uncapped, so a manual High on the owner's
// fanless M2 Air opened at 1.25x on its 1470x956 dPR-2 panel — 3.37 M
// framebuffer pixels, a 2048² shadow map and 2x MSAA behind the post chain —
// and the GPU firmware locked up ("firmware-detected lockup", WindowServer
// watchdog, the whole desktop down; the same lockup hit this repo's own
// headless runs on 2026-09-08). pixelRatioCaps knew the tier and the viewport
// and nothing about the part. Every row below that names the Air failed.
{
  const mod = await import('../src/client/rendering/FrameGovernor.js');
  const has = (n) => typeof mod[n] === 'function';
  expect('fillCeilingForGpu is exported', has('fillCeilingForGpu'));
  expect('cappedShadowMapSize, composerMsaaSamples, fillCapReport and fillClassFor are exported',
    has('cappedShadowMapSize') && has('composerMsaaSamples') && has('fillCapReport') && has('fillClassFor'));
  const fb = (w, h, r) => Math.round(w * r) * Math.round(h * r);
  const shadow = (size, cls) => (has('cappedShadowMapSize') ? mod.cappedShadowMapSize(size, cls) : -1);
  const msaa = (q, cls) => (has('composerMsaaSamples') ? mod.composerMsaaSamples(q, cls) : -1);

  // THE OWNER'S MACHINE: Chrome, "Apple M2", 8 cores, 1470x956 @2, High pinned.
  const airHigh = pixelRatioCaps('high', 1470, 956, 2, 'apple-base');
  const airHighPx = fb(1470, 956, airHigh.maxPixelRatio);
  expect(`a High pin on an M2 Air opens at <= 1.45 Mpx (${(airHighPx / 1e6).toFixed(2)} Mpx at ${airHigh.maxPixelRatio.toFixed(3)}x)`,
    airHighPx <= 1_450_000 && airHigh.maxPixelRatio <= 1 + 1e-9);
  expect(`…with a 1536 shadow map, not 2048 (${shadow(2048, 'apple-base')})`, shadow(2048, 'apple-base') === 1536);
  expect(`…and keeps 2x MSAA — the resolve is tile memory there (${msaa('high', 'apple-base')})`, msaa('high', 'apple-base') === 2);
  expect(`…and its ladder floor is still High's 0.8 (${airHigh.minPixelRatio.toFixed(3)})`, Math.abs(airHigh.minPixelRatio - 0.8) < 0.005);

  // AN M2 MAX (12 cores, a fan) is today's numbers, untouched.
  const maxHigh = pixelRatioCaps('high', 1470, 956, 2, 'apple-pro');
  expect(`a High pin on an M2 Max stays at today's 1.25x (${maxHigh.maxPixelRatio.toFixed(3)}, ${(fb(1470, 956, maxHigh.maxPixelRatio) / 1e6).toFixed(2)} Mpx)`,
    Math.abs(maxHigh.maxPixelRatio - 1.25) < 0.005);
  expect(`…and today's 2048 shadow map (${shadow(2048, 'apple-pro')})`, shadow(2048, 'apple-pro') === 2048);
  expect('…and discrete / unknown are uncapped too',
    Math.abs(pixelRatioCaps('high', 1470, 956, 2, 'discrete').maxPixelRatio - 1.25) < 0.005
    && Math.abs(pixelRatioCaps('high', 1470, 956, 2, 'unknown').maxPixelRatio - 1.25) < 0.005
    && shadow(2048, 'discrete') === 2048 && shadow(2048, 'unknown') === 2048);

  // THE FOUR-ARGUMENT CALL IS BYTE-IDENTICAL: 'unknown' is the default.
  let drift = null;
  for (const q of ['low', 'balanced', 'high']) {
    for (const [w, h, d] of [[390, 844, 3], [1366, 768, 1], [1470, 956, 2], [1920, 1080, 1], [3840, 2160, 1]]) {
      const a = pixelRatioCaps(q, w, h, d);
      const b = pixelRatioCaps(q, w, h, d, 'unknown');
      if (a.maxPixelRatio !== b.maxPixelRatio || a.minPixelRatio !== b.minPixelRatio) drift ??= `${q} ${w}x${h}@${d}`;
    }
  }
  expect('every existing caller (four arguments) gets exactly what it got before', drift === null, drift ?? '');

  // MEDIUM ON THE AIR IS UNCHANGED — the tier the owner plays, and the one that
  // does not crash: ratio 1.0, 1536², 2x. That fill IS the apple-base ceiling.
  const airBal = pixelRatioCaps('balanced', 1470, 956, 2, 'apple-base');
  const airBalToday = pixelRatioCaps('balanced', 1470, 956, 2);
  expect(`Medium on the Air is byte-identical (${airBal.maxPixelRatio.toFixed(3)} / ${airBal.minPixelRatio.toFixed(3)}, shadow ${shadow(1536, 'apple-base')}, msaa ${msaa('balanced', 'apple-base')})`,
    airBal.maxPixelRatio === airBalToday.maxPixelRatio && airBal.minPixelRatio === airBalToday.minPixelRatio
    && shadow(1536, 'apple-base') === 1536 && msaa('balanced', 'apple-base') === 2);
  const airLow = pixelRatioCaps('low', 1470, 956, 2, 'apple-base');
  expect(`…and so is Low (${airLow.maxPixelRatio.toFixed(3)})`, Math.abs(airLow.maxPixelRatio - 0.62) < 0.005);

  // SAFARI'S OPAQUE "Apple GPU" gets the Air's numbers: it may be an Ultra, but
  // the cost of being wrong upward is a dead desktop.
  const opq = pixelRatioCaps('high', 1470, 956, 2, 'apple-opaque');
  expect(`apple-opaque is capped like apple-base (${opq.maxPixelRatio.toFixed(3)}, shadow ${shadow(2048, 'apple-opaque')})`,
    opq.maxPixelRatio === airHigh.maxPixelRatio && shadow(2048, 'apple-opaque') === 1536 && msaa('high', 'apple-opaque') === 2);

  // INTEGRATED (Intel UHD 620 ultrabook, 1536x864 @1.25) at High: <= 1.2 Mpx,
  // 1024² and NO samples — the resolve is main-memory traffic there.
  const uhd = pixelRatioCaps('high', 1536, 864, 1.25, 'integrated');
  const uhdPx = fb(1536, 864, uhd.maxPixelRatio);
  // The ceiling is a square root and the buffer is integer-sized, so the
  // rounded dimensions may overshoot the budget by up to one row plus one
  // column (1536 + 864 px here) — a rounding, not a loosening.
  expect(`a High pin on an Intel UHD 620 opens at <= 1.2 Mpx (${(uhdPx / 1e6).toFixed(2)} Mpx at ${uhd.maxPixelRatio.toFixed(3)}x)`,
    uhdPx <= 1_200_000 + 1536 + 864 && uhd.maxPixelRatio <= 1 + 1e-9);
  expect(`…shadow 1024 and 0 samples (${shadow(2048, 'integrated')}, ${msaa('high', 'integrated')})`,
    shadow(2048, 'integrated') === 1024 && msaa('high', 'integrated') === 0);

  // A PHONE (Adreno, 412x915 @2.625) at High: <= 0.9 Mpx, but never narrower
  // than the 640 px legibility floor — a 640 px buffer is not what locks a GPU
  // up, and pixelRatioCaps' own floor still wins.
  const phone = pixelRatioCaps('high', 412, 915, 2.625, 'mobile-gpu');
  const phonePx = fb(412, 915, phone.maxPixelRatio);
  expect(`a High pin on a phone opens at <= 0.9 Mpx (${(phonePx / 1e6).toFixed(2)} Mpx) and >= 640 px wide (${(412 * phone.maxPixelRatio).toFixed(0)} px)`,
    phonePx <= 900_000 * 1.02 && 412 * phone.maxPixelRatio >= 640 - 0.5);
  const narrow = pixelRatioCaps('low', 390, 844, 3, 'mobile-gpu');
  expect(`the legibility floor beats the class cap on a narrow panel (${(390 * narrow.maxPixelRatio).toFixed(0)} px wide)`,
    390 * narrow.maxPixelRatio >= 640 - 0.5);

  // SOFTWARE caps only the pixel count (0.6 Mpx) — never the shadow map or the
  // samples — and at the 960x540 @1 every rig in this repo uses nothing binds.
  const sw = pixelRatioCaps('high', 960, 540, 1, 'software');
  const swToday = pixelRatioCaps('high', 960, 540, 1);
  expect(`a 960x540 @1 software rig at High is byte-identical (${sw.maxPixelRatio.toFixed(3)})`,
    sw.maxPixelRatio === swToday.maxPixelRatio && sw.minPixelRatio === swToday.minPixelRatio);
  expect(`…and the software class never touches the shadow map or the samples (${shadow(2048, 'software')}, ${msaa('high', 'software')})`,
    shadow(2048, 'software') === 2048 && msaa('high', 'software') === 2);
  expect('…and a URL pin on the software rasteriser is a measurement rig: its fill class is uncapped',
    has('fillClassFor') && mod.fillClassFor('software', 'url') === 'unknown'
    && mod.fillClassFor('software', 'player') === 'software'
    && mod.fillClassFor('apple-base', 'url') === 'apple-base');

  // THE TABLE ITSELF, so a change to it is a visible change.
  if (has('fillCeilingForGpu')) {
    const t = (c) => mod.fillCeilingForGpu(c);
    expect('apple-base: 1.45 Mpx / ratio <= 1.0 / shadow <= 1536 / msaa <= 2 / opens at the floor',
      t('apple-base').maxFramebufferPixels === 1_450_000 && t('apple-base').maxPixelRatio === 1
      && t('apple-base').maxShadowMapSize === 1536 && t('apple-base').msaaSamplesCap === 2 && t('apple-base').openAtFloor === true);
    expect('integrated: 1.2 Mpx / 1.0 / 1024 / 0 / floor; mobile-gpu: 0.9 Mpx / 1.0 / 1024 / 0 / floor',
      t('integrated').maxFramebufferPixels === 1_200_000 && t('integrated').maxShadowMapSize === 1024 && t('integrated').msaaSamplesCap === 0 && t('integrated').openAtFloor === true
      && t('mobile-gpu').maxFramebufferPixels === 900_000 && t('mobile-gpu').maxShadowMapSize === 1024 && t('mobile-gpu').msaaSamplesCap === 0 && t('mobile-gpu').openAtFloor === true);
    expect('apple-pro / discrete / unknown: no cap beyond the tier\'s own, and they open where they always did',
      ['apple-pro', 'discrete', 'unknown'].every((c) => !Number.isFinite(t(c).maxFramebufferPixels) && !Number.isFinite(t(c).maxShadowMapSize) && t(c).openAtFloor === false));
  }

  // THE REPORT the renderer hands the settings panel: binds on the Air at High,
  // not on the Max, not on the Air's own Medium.
  if (has('fillCapReport')) {
    const r = (q, cls) => mod.fillCapReport(q, 1470, 956, 2, cls, q === 'low' ? 0 : q === 'high' ? 2048 : 1536);
    const airReport = r('high', 'apple-base');
    expect(`fillCapReport binds for High on the Air (px ${airReport.framebufferPixels} of ${airReport.tierFramebufferPixels}, shadow ${airReport.shadowMapSize} of ${airReport.tierShadowMapSize})`,
      airReport.binds === true && airReport.openAtFloor === true && airReport.framebufferPixels <= 1_450_000 && airReport.shadowMapSize === 1536);
    expect('…and not for High on an M2 Max, nor for Medium or Low on the Air',
      r('high', 'apple-pro').binds === false && r('balanced', 'apple-base').binds === false && r('low', 'apple-base').binds === false);
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nFrame governor checks passed.');
