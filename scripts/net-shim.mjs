#!/usr/bin/env node
/**
 * NET SHIM — a deterministic model of ONE direction of a real-internet TCP
 * connection, for replaying a match's wire through latency, jitter and loss
 * without a browser, a proxy or a kernel qdisc (b1.3e, critique gap 7).
 *
 * WHAT IT MODELS, AND WHY EACH PART IS THERE.
 *
 *  - Latency: every segment takes rtt/2 one way.
 *  - Jitter: each segment's one-way time moves by a normal draw (sd = jitter/2,
 *    clamped to +-jitter), so the round trip wanders by about the stated jitter.
 *  - Loss: a WebSocket rides TCP, so a lost segment is not a lost message. It is
 *    a message that shows up LATE: the sender notices after about one RTT when
 *    the stream keeps flowing (fast retransmit on dup-acks), or after the
 *    retransmission timeout (min 200 ms, doubling) when the retransmission is
 *    lost too.
 *  - Head-of-line blocking: TCP delivers in order, so every message queued behind
 *    a retransmission waits for it. This is what a 1% loss rate really does to a
 *    31 Hz snapshot stream: not one hole, a stall followed by a burst. Delivery
 *    time is max(own ready time, previous delivery), and the extra wait is
 *    counted in `stats.holMs`.
 *  - Segments: a message larger than one MSS is several segments, and it arrives
 *    when the last of them does, so a fat full snapshot is more exposed to loss
 *    than a hot one.
 *
 * WHAT IT DOES NOT MODEL: congestion control and bandwidth. A 150 ms / 1% link
 * with a multi-megabit pipe is the case the launch bar names; the per-client
 * downstream the caller measures is what decides whether the pipe matters.
 *
 * Usage (library): `const link = new TcpLink({ seed: 7 }); link.send(nowMs, data, bytes);
 * for (const m of link.deliver(nowMs)) ...`. CLI: `node scripts/net-shim.mjs --self-test`
 * grades the model itself (means, loss rate, order, stall accounting).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The launch bar's link (PLAN section 3.2): 150 ms RTT, 30 ms jitter, 1% loss. */
export const WAN_PROFILE = Object.freeze({ rttMs: 150, jitterMs: 30, loss: 0.01, mss: 1400, minRtoMs: 200 });
/** A clean LAN, for the control arm of a caller. */
export const LAN_PROFILE = Object.freeze({ rttMs: 2, jitterMs: 0, loss: 0, mss: 1400, minRtoMs: 200 });

/** mulberry32: small, fast, and the same numbers on every machine. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TcpLink {
  /** @param {{rttMs?:number,jitterMs?:number,loss?:number,mss?:number,minRtoMs?:number,seed?:number}} opts */
  constructor(opts = {}) {
    const p = { ...WAN_PROFILE, ...opts };
    this.rttMs = p.rttMs;
    this.jitterMs = p.jitterMs;
    this.loss = p.loss;
    this.mss = p.mss;
    this.minRtoMs = p.minRtoMs;
    this.rng = makeRng(p.seed ?? 1);
    this.lastDeliverAt = 0;
    this.queue = [];
    this.stats = { messages: 0, bytes: 0, segments: 0, lost: 0, rto: 0, holMs: 0, holStalls: 0, maxHolMs: 0, oneWaySumMs: 0 };
  }

  /** One segment's one-way time. */
  oneWay() {
    if (this.jitterMs <= 0) return this.rttMs / 2;
    // Box-Muller; sd = jitter/2, clamped so a draw can never be absurd.
    const u = Math.max(1e-12, this.rng());
    const v = this.rng();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const j = Math.max(-this.jitterMs, Math.min(this.jitterMs, n * this.jitterMs / 2));
    return Math.max(1, this.rttMs / 2 + j);
  }

  /** Queue `data` (whatever the caller wants back) of `bytes` on the wire at `nowMs`. */
  send(nowMs, data, bytes) {
    const segs = Math.max(1, Math.ceil(bytes / this.mss));
    let ready = nowMs;
    for (let s = 0; s < segs; s += 1) {
      let sentAt = nowMs;
      let attempt = 0;
      // Each transmission of the segment is lost with probability `loss`.
      while (this.rng() < this.loss) {
        this.stats.lost += 1;
        // First loss: dup-acks from the segments behind it tell the sender after
        // about one RTT (the stream is a 31 Hz flow, so there always are some).
        // A lost retransmission has no dup-acks left to ride: RTO, doubling.
        const detect = attempt === 0
          ? this.rttMs + Math.abs(this.oneWay() - this.rttMs / 2)
          : Math.max(this.minRtoMs, 2 * this.rttMs) * 2 ** (attempt - 1);
        if (attempt > 0) this.stats.rto += 1;
        sentAt += detect;
        attempt += 1;
      }
      const ow = this.oneWay();
      this.stats.oneWaySumMs += ow;
      ready = Math.max(ready, sentAt + ow);
      this.stats.segments += 1;
    }
    // In-order delivery: nothing overtakes a message still waiting on a retransmit.
    const at = Math.max(ready, this.lastDeliverAt);
    const hol = at - ready;
    if (hol > 0.5) {
      this.stats.holStalls += 1;
      this.stats.holMs += hol;
      if (hol > this.stats.maxHolMs) this.stats.maxHolMs = hol;
    }
    this.lastDeliverAt = at;
    this.queue.push({ at, sentAt: nowMs, data, bytes });
    this.stats.messages += 1;
    this.stats.bytes += bytes;
  }

  /** Everything whose delivery time is <= nowMs, in order. */
  deliver(nowMs) {
    const out = [];
    while (this.queue.length > 0 && this.queue[0].at <= nowMs) out.push(this.queue.shift());
    return out;
  }
}

function selfTest() {
  let failures = 0;
  const expect = (label, ok, detail = '') => {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? ` [${detail}]` : ''}`); }
  };
  const link = new TcpLink({ seed: 42 });
  const N = 20000;
  const lat = [];
  let prevAt = -1;
  let ordered = true;
  for (let i = 0; i < N; i += 1) {
    const now = i * 32;
    link.send(now, i, i % 10 === 0 ? 6000 : 900);
    for (const m of link.deliver(now + 400)) {
      if (m.at < prevAt) ordered = false;
      prevAt = m.at;
      lat.push(m.at - m.sentAt);
    }
  }
  const s = link.stats;
  const meanOw = s.oneWaySumMs / s.segments;
  const lossRate = s.lost / (s.segments + s.lost);
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)];
  const p99 = lat[Math.floor(lat.length * 0.99)];
  console.log(`  one-way mean ${meanOw.toFixed(1)} ms, loss ${(lossRate * 100).toFixed(2)}%, message latency p50 ${p50.toFixed(0)} / p99 ${p99.toFixed(0)} ms, HOL stalls ${s.holStalls} (${s.holMs.toFixed(0)} ms total, worst ${s.maxHolMs.toFixed(0)} ms)`);
  expect('one-way mean is rtt/2 (72-78 ms)', meanOw > 72 && meanOw < 78, meanOw.toFixed(1));
  expect('segment loss rate is ~1% (0.7-1.3%)', lossRate > 0.007 && lossRate < 0.013, lossRate.toFixed(4));
  expect('delivery is in order (TCP)', ordered);
  expect('loss shows up as head-of-line stalls, not holes', s.holStalls > 50 && s.maxHolMs > 100, `${s.holStalls} stalls, worst ${s.maxHolMs.toFixed(0)} ms`);
  expect('p50 message latency is about one way (60-95 ms)', p50 > 60 && p50 < 95, String(p50));
  expect('p99 message latency carries the retransmits (> rtt)', p99 > 150, String(p99));
  const clean = new TcpLink({ ...LAN_PROFILE, seed: 1 });
  for (let i = 0; i < 1000; i += 1) clean.send(i * 32, i, 900);
  expect('the LAN profile never stalls', clean.stats.holStalls === 0 && clean.stats.lost === 0);
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — net-shim self-test (${failures} failure${failures === 1 ? '' : 's'})`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  console.log('net-shim is a library (TcpLink, WAN_PROFILE). Run with --self-test to grade the model.');
}
