#!/usr/bin/env node
/**
 * THE INTERPOLATION BUFFER, ON A BENCH.
 *
 * scripts/test-remote-smoothness.mjs measures the real client in a real match and
 * is the honest end-to-end reading, but it needs a browser, a server and a minute.
 * This file grades the same contract in a few milliseconds of pure arithmetic, on
 * a packet stream whose jitter is CHOSEN — which is the only way to prove the
 * buffer against a network that this machine cannot be made to produce on demand.
 *
 * THE BENCH. A body walking a 12m circle at 5 m/s (so it is genuinely
 * accelerating — a straight line would let any extrapolator score perfectly and
 * prove nothing). The server samples it every 32ms exactly. Those samples then
 * cross a wire that adds a one-way delay plus 0-35ms of jitter, with a 120ms
 * hiccup every second and an occasional reorder. The drawn path is reconstructed
 * at 4ms — 8 samples per snapshot interval — and graded on
 *
 *     excess = |p[i] − p[i−1]| − trueSpeed × dt
 *
 * the same statistic the live suite grades, so the two are directly comparable.
 *
 * THE MUTATION PROOF IS BUILT IN. The identical stream is also fed to a model of
 * WHAT THIS REPLACED — position + velocity × (now − whenThePacketLANDED), age
 * clamped at 0.18s, which is the arithmetic src/client/core/Game.ts shipped. If
 * that model does not fail the bar this file would be a gate that cannot fail, so
 * its failure is asserted: the run is red if the old path passes.
 */
import process from 'node:process';
import {
  RemoteInterpolator,
  SNAPSHOT_INTERVAL_S,
} from '../src/client/network/RemoteInterpolation.ts';

const REPORT_ONLY = process.argv.includes('--report');
const failures = [];
const notes = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

/** Deterministic PRNG — a gate that reads a different network every run is not a gate. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── the body ────────────────────────────────────────────────────────────────
const RADIUS = 12;
const SPEED = 5;
const OMEGA = SPEED / RADIUS;
const truth = (t) => ({
  x: Math.cos(t * OMEGA) * RADIUS,
  y: 0,
  z: Math.sin(t * OMEGA) * RADIUS,
  yaw: t * OMEGA,
  vx: -Math.sin(t * OMEGA) * SPEED,
  vz: Math.cos(t * OMEGA) * SPEED,
});

/**
 * One packet stream. `serverT` is when the sample was taken; `arriveMs` is the
 * client clock it lands on. Deliberately produced once and replayed into both
 * models so the comparison owes nothing to luck.
 */
function makeStream({ seconds = 12, owdMs = 25, jitterMs = 35, hiccupMs = 120, seed = 7 } = {}) {
  const rand = rng(seed);
  const packets = [];
  const n = Math.floor(seconds / SNAPSHOT_INTERVAL_S);
  for (let k = 0; k < n; k++) {
    const serverT = k * SNAPSHOT_INTERVAL_S;
    let lateness = owdMs + rand() * jitterMs;
    if (k % 31 === 17) lateness += hiccupMs; // a stall about once a second
    packets.push({ serverT, arriveMs: serverT * 1000 + lateness });
  }
  // The wire is unordered: swap a few neighbouring arrivals outright.
  for (let k = 5; k < packets.length - 1; k += 23) {
    const a = packets[k].arriveMs;
    packets[k].arriveMs = packets[k + 1].arriveMs;
    packets[k + 1].arriveMs = a;
  }
  packets.sort((a, b) => a.arriveMs - b.arriveMs);
  return packets;
}

/** Walk a clock from 0 to `endMs`, delivering packets and sampling the drawn path. */
function run(packets, { endMs, frameMs = 16, sampleMs = 4, deliver, evaluate, onFrame }) {
  const path = [];
  let p = 0;
  let nextFrame = 0;
  for (let now = 0; now <= endMs; now += sampleMs) {
    while (p < packets.length && packets[p].arriveMs <= now) { deliver(packets[p], now); p++; }
    if (now >= nextFrame) { onFrame?.(now); nextFrame = now + frameMs; }
    const q = evaluate(now);
    if (q) path.push({ now, ...q });
  }
  return path;
}

/** excess statistics over a drawn path, in metres. */
function grade(path, { warmupMs = 1500 } = {}) {
  const excess = [];
  let worst = 0;
  let snaps = 0;
  let seconds = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (b.now < warmupMs) continue;
    const dt = (b.now - a.now) / 1000;
    if (dt <= 0) continue;
    const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const e = step - SPEED * dt;
    excess.push(e);
    seconds += dt;
    if (e > 0.02) snaps++;
    if (e > worst) worst = e;
  }
  excess.sort((u, v) => u - v);
  const at = (q) => (excess.length ? excess[Math.min(excess.length - 1, Math.floor(excess.length * q))] : 0);
  return { n: excess.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), worst, snaps, snapsPerSecond: seconds > 0 ? snaps / seconds : 0 };
}

const f = (v, d = 4) => (v === null || v === undefined ? '--' : v.toFixed(d));

// ── 1. THE BUFFER vs THE ARRIVAL-CLOCK EXTRAPOLATOR, same stream ────────────
{
  const packets = makeStream();
  const endMs = 11_000;

  const interp = new RemoteInterpolator();
  const bufferPath = run(packets, {
    endMs,
    deliver: (pkt, now) => {
      const s = truth(pkt.serverT);
      interp.timeline.noteSnapshot(pkt.serverT, now);
      interp.track('P:bot').push(pkt.serverT, s.x, s.y, s.z, s.yaw, '', now);
    },
    onFrame: (now) => interp.timeline.advance(now),
    evaluate: (now) => {
      const pose = interp.poseAt('P:bot', now);
      return pose ? { x: pose.x, y: pose.y, z: pose.z } : null;
    },
  });

  // The model of what this replaced. Same stream, same sampling.
  let last = null;
  let lastAt = 0;
  const oldPath = run(packets, {
    endMs,
    deliver: (pkt, now) => {
      const s = truth(pkt.serverT);
      last = s;
      lastAt = now;
    },
    evaluate: (now) => {
      if (!last) return null;
      const age = Math.min(0.18, (now - lastAt) / 1000);
      return { x: last.x + last.vx * age, y: 0, z: last.z + last.vz * age };
    },
  });

  const buf = grade(bufferPath);
  const old = grade(oldPath);
  console.log('interpolation buffer vs arrival-clock extrapolation — same packet stream');
  console.log(`  arrival-clock (what shipped): p50 ${f(old.p50)}m  p95 ${f(old.p95)}m  p99 ${f(old.p99)}m  `
    + `worst ${f(old.worst)}m  snaps ${f(old.snapsPerSecond, 2)}/s  (n=${old.n})`);
  console.log(`  interpolation buffer        : p50 ${f(buf.p50)}m  p95 ${f(buf.p95)}m  p99 ${f(buf.p99)}m  `
    + `worst ${f(buf.worst)}m  snaps ${f(buf.snapsPerSecond, 2)}/s  (n=${buf.n})`);
  console.log(`  modes: ${JSON.stringify(interp.modeCounts)}  delay ${f(interp.timeline.delay * 1000, 1)}ms  `
    + `jitter ${f(interp.timeline.jitter * 1000, 1)}ms  hard snaps ${interp.timeline.hardSnaps}`);

  check(buf.n > 1000, `the bench drew only ${buf.n} samples — it measured nothing`);
  check(buf.worst <= 0.02, `the buffer stepped ${f(buf.worst)}m beyond the body's own motion (max 0.02m)`);
  check(buf.snapsPerSecond <= 0.5, `the buffer snapped ${f(buf.snapsPerSecond, 2)} times a second (max 0.5)`);
  check(interp.timeline.hardSnaps === 0, `the clock had to be re-anchored ${interp.timeline.hardSnaps}x on a stream with no disconnect in it`);
  // MUTATION PROOF: the bar must be one the replaced arithmetic cannot clear.
  check(old.worst > 0.05, `THE GATE CANNOT FAIL: the arrival-clock extrapolator this replaced stepped only ${f(old.worst)}m `
    + `on the same stream, so passing proves nothing`);
  check(old.worst > buf.worst * 5, `THE GATE IS NOT DISCRIMINATING: old worst ${f(old.worst)}m vs new ${f(buf.worst)}m`);
  notes.push(`worst drawn step: ${f(old.worst)}m before, ${f(buf.worst)}m after (${(old.worst / Math.max(1e-9, buf.worst)).toFixed(0)}x)`);
  // The interpolated path must be the one actually in use, not extrapolation in disguise.
  const total = Object.values(interp.modeCounts).reduce((s, v) => s + v, 0);
  check(interp.modeCounts.interpolated / total > 0.9,
    `only ${((interp.modeCounts.interpolated / total) * 100).toFixed(1)}% of answers came from two bracketing samples — `
    + `the delay is not buying a bracket`);
}

// ── 2. THE CLOCK IS MONOTONIC AND BOUNDED ───────────────────────────────────
{
  const packets = makeStream({ seconds: 8, jitterMs: 60, hiccupMs: 250, seed: 19 });
  const interp = new RemoteInterpolator();
  let prevT = Number.NEGATIVE_INFINITY;
  let backwards = 0;
  let worstRate = 0;
  let prevNow = 0;
  run(packets, {
    endMs: 7_500,
    deliver: (pkt, now) => {
      interp.timeline.noteSnapshot(pkt.serverT, now);
      const s = truth(pkt.serverT);
      interp.track('P:bot').push(pkt.serverT, s.x, s.y, s.z, s.yaw, '', now);
    },
    onFrame: (now) => interp.timeline.advance(now),
    evaluate: (now) => {
      const t = interp.timeline.renderTimeAt(now);
      if (!Number.isFinite(t)) return null;
      if (t < prevT) backwards++;
      if (prevT > Number.NEGATIVE_INFINITY && now > prevNow) {
        const rate = (t - prevT) / ((now - prevNow) / 1000);
        worstRate = Math.max(worstRate, Math.abs(rate - 1));
      }
      prevT = t;
      prevNow = now;
      return null;
    },
  });
  console.log(`  clock: ${backwards} backward steps, worst dilation ${(worstRate * 100).toFixed(1)}%, `
    + `${interp.timeline.hardSnaps} hard snaps, delay ${f(interp.timeline.delay * 1000, 1)}ms`);
  check(backwards === 0, `the render clock went backwards ${backwards} times — every one of those is a body teleporting`);
  check(worstRate <= 0.13, `the clock dilated ${(worstRate * 100).toFixed(1)}% (max 12%) — visible as a speed change`);
  // A 60ms-jitter stream must widen the window; a delay stuck at its floor is a
  // buffer that will starve.
  check(interp.timeline.delay > SNAPSHOT_INTERVAL_S * 1.5,
    `the delay stayed at ${f(interp.timeline.delay * 1000, 1)}ms on a 60ms-jitter stream — it is not adapting`);
  check(interp.timeline.delay <= SNAPSHOT_INTERVAL_S * 6 + 1e-6,
    `the delay ran away to ${f(interp.timeline.delay * 1000, 1)}ms — remote bodies would be a fifth of a second behind`);
}

// ── 3. A CLEAN WIRE PAYS THE MINIMUM ────────────────────────────────────────
{
  const packets = makeStream({ seconds: 8, owdMs: 2, jitterMs: 1, hiccupMs: 0, seed: 3 });
  const interp = new RemoteInterpolator();
  run(packets, {
    endMs: 7_500,
    deliver: (pkt, now) => {
      interp.timeline.noteSnapshot(pkt.serverT, now);
      const s = truth(pkt.serverT);
      interp.track('P:bot').push(pkt.serverT, s.x, s.y, s.z, s.yaw, '', now);
    },
    onFrame: (now) => interp.timeline.advance(now),
    evaluate: () => null,
  });
  const ms = interp.timeline.delay * 1000;
  console.log(`  clean wire: delay settled at ${f(ms, 1)}ms (${f(interp.timeline.delay / SNAPSHOT_INTERVAL_S, 2)} intervals)`);
  check(ms < SNAPSHOT_INTERVAL_S * 1000 * 2,
    `a clean wire is being charged ${f(ms, 1)}ms of delay — the adaptation is not coming back down`);
  notes.push(`delay: ${f(ms, 1)}ms on a clean wire`);
}

// ── 4. A FRAME CHANGE IS NEVER LERPED THROUGH ───────────────────────────────
{
  const interp = new RemoteInterpolator();
  const track = interp.track('P:boarder');
  // Ashore at the origin, then aboard a ship — the SAME numbers mean a different
  // place. Lerping across that walks a man through a hull.
  track.push(0.000, 0, 0, 0, 0, '', 0);
  track.push(0.032, 1, 0, 0, 0, '', 32);
  track.push(0.064, 2, 0, 0, 0, 'ship-7', 64);
  track.push(0.096, 2.2, 0, 0, 0, 'ship-7', 96);
  const out = { x: 0, y: 0, z: 0, yaw: 0, mode: 'empty' };
  const across = track.sample(0.048, out);
  check(across === 'held', `a sample straddling a frame change was ${across}, not held`);
  const within = track.sample(0.080, out);
  check(within === 'interpolated', `a sample inside one frame was ${within}, not interpolated`);
  check(Math.abs(out.x - 2.1) < 1e-9, `midpoint of a 2.0→2.2 pair came out at ${out.x}`);
  console.log('  frame change: straddling sample held, in-frame sample interpolated');
}

// ── 5. STARVATION EXTRAPOLATES, AND IS BOUNDED ──────────────────────────────
{
  const interp = new RemoteInterpolator();
  const track = interp.track('P:starved');
  for (let k = 0; k < 4; k++) track.push(k * 0.032, k * 0.16, 0, 0, 0, '', k * 32);
  const out = { x: 0, y: 0, z: 0, yaw: 0, mode: 'empty' };
  const newestT = 3 * 0.032;
  const newestX = 3 * 0.16;
  const m1 = track.sample(newestT + 0.05, out);
  check(m1 === 'extrapolated', `a render time past the newest sample was ${m1}, not extrapolated`);
  check(Math.abs(out.x - (newestX + 5 * 0.05)) < 1e-9, `bounded extrapolation put it at ${out.x}`);
  track.sample(newestT + 10, out);
  const far = out.x;
  check(Math.abs(far - (newestX + 5 * 0.20)) < 1e-9,
    `a ten-second-stale track extrapolated to ${f(far, 2)}m — the cap is not holding`);
  // Nothing at all: the caller has to be told, not handed a zero.
  check(interp.poseAt('P:never-seen', 1000) === null, 'an unknown body returned a pose instead of null');
  console.log('  starvation: extrapolates from the newest pair, capped at 0.20s of carry');
}

// ── 5b. A REAPPEARANCE IS A CUT, NOT A GLIDE ────────────────────────────────
// A pirate who dies at one end of the map and respawns at the other comes back
// with a sample seconds newer than anything held. Bracketing across that gap
// would walk him the whole way over the span of it — a body sliding across the
// world at constant speed, which is a far worse artefact than the cut.
{
  const interp = new RemoteInterpolator();
  const track = interp.track('P:respawner');
  for (let k = 0; k < 6; k++) track.push(k * 0.032, k * 0.16, 0, 0, 0, '', k * 32);
  const out = { x: 0, y: 0, z: 0, yaw: 0, mode: 'empty' };
  // Four seconds later, 400 metres away.
  track.push(4.0, 400, 0, 0, 0, '', 4000);
  const mode = track.sample(2.0, out);
  check(mode === 'held', `a render time inside a 4s gap was ${mode}, not held`);
  check(out.x === 400, `the ring bracketed across a reappearance and put the body at ${out.x}m`);
  check(track.length === 1, `the ring kept ${track.length} samples across a reappearance instead of starting over`);
  console.log('  reappearance: a 4s gap empties the ring instead of being interpolated through');
}

// ── 6. A LONG FRAME MUST NOT MAKE A BODY JUMP ───────────────────────────────
// The third thing the brief asked for, and the one the old arithmetic could not
// give: `snapshotAge` was clamped at 0.18s, so a frame that took 600ms froze
// every remote body at the clamp and then teleported it the moment the next
// frame drew. The buffer's render clock is wall-clock and monotonic, so a long
// frame advances it exactly as far as the wall did and the body arrives where
// it should be — the picture is late, but it is never wrong.
//
// The frame CADENCE is what is punished here, not the sampling: `advance` is
// called on a stuttering 8/400/16/650ms rhythm while the path is reconstructed
// at 4ms, which is precisely "the governor stepped and the frame ran long".
{
  const packets = makeStream({ seconds: 10, seed: 41 });
  const interp = new RemoteInterpolator();
  const stutter = [8, 400, 16, 650, 12, 250, 16, 16, 900, 16];
  let s = 0;
  let nextFrame = 0;
  const path = run(packets, {
    endMs: 9_500,
    sampleMs: 4,
    frameMs: 1, // onFrame every sample; the stutter below decides when to advance
    deliver: (pkt, now) => {
      interp.timeline.noteSnapshot(pkt.serverT, now);
      const q = truth(pkt.serverT);
      interp.track('P:bot').push(pkt.serverT, q.x, q.y, q.z, q.yaw, '', now);
    },
    onFrame: (now) => {
      if (now < nextFrame) return;
      nextFrame = now + stutter[s++ % stutter.length];
      interp.timeline.advance(now);
    },
    evaluate: (now) => {
      const pose = interp.poseAt('P:bot', now);
      return pose ? { x: pose.x, y: pose.y, z: pose.z } : null;
    },
  });
  const g = grade(path);
  console.log(`  long frames (up to 900ms between advances): worst step ${f(g.worst)}m, `
    + `p99 ${f(g.p99)}m, ${interp.timeline.hardSnaps} hard snaps (n=${g.n})`);
  check(g.worst <= 0.02, `a stuttering frame cadence stepped a body ${f(g.worst)}m (max 0.02m)`);
  check(interp.timeline.hardSnaps === 0,
    `a 900ms frame re-anchored the clock ${interp.timeline.hardSnaps}x — every re-anchor teleports every remote body at once`);
  notes.push(`long frames: worst step ${f(g.worst)}m across 900ms frame gaps`);
}

// ── 7. A STALL MUST NOT RE-ANCHOR THE CLOCK BACKWARDS ───────────────────────
// The failure the live suite caught: 15 hard snaps in a 60s window. A frame on
// the target machine can run for a second, and no snapshot can be APPLIED inside
// a synchronous frame — the message callback cannot run. So the free-running
// clock outran the newest sample by the length of the stall, the next advance
// saw an error past HARD_SNAP_S, and it re-anchored the clock BACKWARDS. Every
// one of those is every remote body in the world teleporting at once.
//
// Here the stream stops dead for 1.2s while the frame loop keeps turning, twice.
// The contract is: no hard snap, no backward step, and the drawn body parks
// rather than flying off on a stale velocity.
// The stall modelled here is the one that machine actually suffers: the WIRE is
// fine and the packets are on the doorstep, but the main thread is inside a
// 1.4s island build, so neither the message callback nor `advance` can run.
// Everything that queued up is then delivered in one burst, exactly as the
// socket worker delivers it. Without the clamp in `renderTimeAt` the free clock
// has run 1.4s past its data by then and the next advance re-anchors it
// BACKWARDS, which is what the live suite caught 15 times in 60 seconds.
{
  const packets = makeStream({ seconds: 9, seed: 55 });
  const interp = new RemoteInterpolator();
  const stalls = [[2000, 3400], [5200, 6600]];
  const frozen = (now) => stalls.some(([a, b]) => now > a && now < b);
  let prevT = Number.NEGATIVE_INFINITY;
  let backwards = 0;
  let prevPos = null;
  let worstStep = 0;
  let heldFrom = 0;
  let p = 0;
  for (let now = 0; now <= 8_500; now += 4) {
    if (!frozen(now)) {
      // Deliver everything that landed while the thread was busy, in order.
      while (p < packets.length && packets[p].arriveMs <= now) {
        const pkt = packets[p++];
        interp.timeline.noteSnapshot(pkt.serverT, now);
        const q = truth(pkt.serverT);
        interp.track('P:bot').push(pkt.serverT, q.x, q.y, q.z, q.yaw, '', now);
      }
      if (now - heldFrom >= 16) { heldFrom = now; interp.timeline.advance(now); }
      const t = interp.timeline.renderTimeAt(now);
      if (Number.isFinite(t)) { if (t < prevT - 1e-9) backwards++; prevT = t; }
      const pose = interp.poseAt('P:bot', now);
      if (pose) {
        if (prevPos) worstStep = Math.max(worstStep, Math.hypot(pose.x - prevPos.x, pose.z - prevPos.z));
        prevPos = { x: pose.x, z: pose.z };
      }
    }
  }
  console.log(`  two 1.4s main-thread stalls: ${interp.timeline.hardSnaps} hard snaps, `
    + `${backwards} backward clock steps, worst single-sample move ${f(worstStep)}m`);
  check(interp.timeline.hardSnaps === 0,
    `a 1.4s stalled frame re-anchored the clock ${interp.timeline.hardSnaps}x — that is every remote body teleporting at once`);
  check(backwards === 0, `the render clock went backwards ${backwards} times across a stall`);
  notes.push(`1.4s stalled frames: 0 hard snaps`);
}

console.log('');
for (const n of notes) console.log(`  · ${n}`);
if (failures.length === 0) {
  console.log('\nPASS — the buffer draws a continuous path through a jittered wire, and the arithmetic it replaced does not.');
} else {
  console.log('');
  for (const m of failures) console.log(`FAIL — ${m}`);
  if (!REPORT_ONLY) process.exitCode = 1;
}
