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

console.log('');
for (const n of notes) console.log(`  · ${n}`);
if (failures.length === 0) {
  console.log('\nPASS — the buffer draws a continuous path through a jittered wire, and the arithmetic it replaced does not.');
} else {
  console.log('');
  for (const m of failures) console.log(`FAIL — ${m}`);
  if (!REPORT_ONLY) process.exitCode = 1;
}
