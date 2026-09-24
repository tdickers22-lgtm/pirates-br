#!/usr/bin/env node
/**
 * WAN NETCODE — the real-internet bar at launch (b1.3e; critique gap 7; PLAN 3.2).
 *
 * Every other netcode suite runs on loopback, where a snapshot lands 0-2 ms after
 * it leaves and nothing is ever lost. A stranger on the launch URL is 150 ms away
 * with jitter, and his WebSocket rides TCP, so 1% loss is not a missing snapshot,
 * it is a stall followed by a burst (head-of-line blocking). This suite replays a
 * real bot match through that link, both directions, and grades what the client
 * would draw.
 *
 * WHAT IS REAL AND WHAT IS NOT.
 *  - Server: the real Match (bots, physics, the real snapshot encoder, the real
 *    per-client input_ack), fed the local player's inputs through the UPSTREAM
 *    link, ticked at its own 62.5 Hz on a virtual clock.
 *  - Wire: scripts/net-shim.mjs TcpLink, 150 ms RTT / 30 ms jitter / 1% loss,
 *    in-order delivery with retransmit stalls. Bytes are measured through the
 *    same permessage-deflate parameters the lobby installs (context takeover).
 *  - Client: the real ClientState (applyHotSnapshot, recordHotHistory,
 *    recordRemoteHistoryFromFull) and its RemoteInterpolator, with
 *    `performance.now` bound to the virtual clock; timeline.advance once per
 *    60 Hz frame exactly like Game; the render target sampled at ~111 Hz and
 *    composed against the interpolated hull like Game.getPlayerRenderPosition.
 *  - Local player: the shared PredictionRing + stepPirate reconciliation
 *    (src/shared/locomotion.ts) that the server's own movement runs through.
 *    The prediction clock (when the input sent now is applied, on the server's
 *    clock) is src/client/network/PredictionClock.ts, steered by every ack.
 *    NOTE: Game.ts does not consume input_ack yet (the live client draws its
 *    own body by dead reckoning); this grades the reconciliation path the
 *    client is meant to run, on the real acks the server sends.
 *
 * BARS.
 *  - remote pirates, split ashore / aboard (world path, aboard composed on the
 *    hull), unexplained step in VECTOR form: p99 <= 0.02 m and <= 1.0
 *    discontinuities per body-second, held/empty answers <= 3%: the
 *    test-remote-smoothness bound, both populations.
 *  - local reconciliation: correction at each ack p99 < 0.3 m.
 *  - downstream per client <= 120 KB/s hard (80 KB/s target printed).
 *  - mutation proof, same run: the interpolation buffer forced to 0 ms must FAIL
 *    the remote bar, and a client that snaps to the ack without replaying its
 *    inputs on a free-running clock must FAIL the local bar. A bar the broken
 *    arm clears cannot fail.
 *
 * Usage: node --import tsx scripts/test-wan-netcode.mjs [--seconds 30] [--seed 7]
 *        (deterministic per seed; WAN_STATS=1 prints p50/p90/p95/p99 per population)
 *        [--buffer-ms 0]   (runs ONLY the forced-0 arm and grades it: the red run)
 *        [--lan]           (control: clean link)
 */
import process from 'node:process';
import zlib from 'node:zlib';
import { TcpLink, WAN_PROFILE, LAN_PROFILE, makeRng } from './net-shim.mjs';
import { Match } from '../src/server/core/Match.ts';
import * as Lobby from '../src/server/core/LobbyServer.ts';
import { ClientState } from '../src/client/core/ClientState.ts';
import { PredictionRing, stepPirate } from '../src/shared/locomotion.ts';
import { PredictionClock } from '../src/client/network/PredictionClock.ts';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', '30'));
const WARMUP_S = 12;
const SEED = Number(arg('seed', '7'));
const FORCED_BUFFER = arg('buffer-ms', null);
const PROFILE = argv.includes('--lan') ? LAN_PROFILE : WAN_PROFILE;

const BAR = { p99: 0.02, rate: 1.0, held: 0.03 };
const RECON_P99_M = 0.3;
const DOWN_HARD = 120 * 1024;
const DOWN_TARGET = 80 * 1024;
const DISCONTINUITY_M = 0.02;
const TELEPORT_M = 2.0;
const MOVING_SPEED_MPS = 1.0;
const MAX_GRADEABLE_SPEED_MPS = 15;
const MIN_MOVING_SAMPLES = 250;
/**
 * THE b1.3e MISSES, FIXED IN b2.0d (the launch bar is graded on both populations,
 * no measured bound left). Seeds 1-7, 30 s, shipped arm vs mutants:
 *  - aboard 0.169-0.187 m p99 / 19-40 disc per body-s was the HARNESS, not the
 *    client: RemoteInterpolator.poseAt answers in one reused scratch, and the
 *    sampler asked for the hull before reading the pirate's deck pose, so it
 *    composed the hull's world position spun by the hull's yaw (0.0003 rad of
 *    yaw x 700 m = 0.2 m a sample). Game reads the drawn hull from ShipRenderer
 *    and never had it. Fixed, aboard reads like ashore (see the b2.0d report).
 *  - local reconciliation 3.8 m p99 was the prediction clock: seeded once from
 *    the first ack (in the countdown, when the sim clock stands still) and then
 *    free-run, so every replay started the inputs ~0.67 s early. PredictionClock
 *    re-derives it from the measured apply delay on every ack.
 */
const POPS = ['ashore', 'aboard'];
const GRADE = { ashore: { ...BAR }, aboard: { ...BAR } };

// ── virtual clock: the client's performance.now IS the sim's wall clock ──────
let VNOW = 0;
Object.defineProperty(performance, 'now', { value: () => VNOW, configurable: true, writable: true });
// ── DETERMINISM: one seed fixes the whole run, so arms (and runs) compare ────
// The Match reads PIRATES_BR_MAP_SEED at construction (map, spawns, its RNG-01
// gameplay stream, join docks); Date.now drives its wall-clock accounting
// (countdown, elapsed, bot timers), so it rides the virtual clock too; and
// Math.random (anything outside the seeded streams, client included) is
// re-seeded at the start of every arm. Same seed => bit-identical numbers.
process.env.PIRATES_BR_MAP_SEED = String(SEED);
const EPOCH_MS = 1_790_000_000_000;
Date.now = () => EPOCH_MS + Math.floor(VNOW);

const deflateCfg = Lobby.WS_PERMESSAGE_DEFLATE ?? null;
function makeCompressor() {
  if (!deflateCfg) return { bytes: async (t) => Buffer.byteLength(t), end() {} };
  const threshold = deflateCfg.threshold ?? 0;
  const stream = zlib.createDeflateRaw({ ...(deflateCfg.zlibDeflateOptions ?? {}) });
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  return {
    async bytes(text) {
      const raw = Buffer.from(text, 'utf8');
      if (raw.length < threshold) return raw.length;
      chunks.length = 0;
      stream.write(raw);
      await new Promise((r) => stream.flush(zlib.constants.Z_SYNC_FLUSH, r));
      return Math.max(1, Buffer.concat(chunks).length - 4);
    },
    end() { stream.end(); },
  };
}

const pct = (arr, q) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/**
 * One arm: a fresh match, a fresh client, the same seed.
 * @param {{bufferZero:boolean, replay:boolean, label:string}} arm
 */
async function runArm(arm) {
  VNOW = 0;
  Math.random = makeRng(SEED * 104729 + 3);
  const rng = makeRng(SEED * 7919 + 1);
  const down = new TcpLink({ ...PROFILE, seed: SEED * 2 + 1 });
  const up = new TcpLink({ ...PROFILE, seed: SEED * 2 + 2 });
  const comp = makeCompressor();
  const outbox = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(d) { outbox.push(String(d)); }, on() {}, once() {}, close() {}, terminate() {} };
  const match = new Match({ matchId: `wan-${SEED}`, botCount: 9 });
  const join = match.createCrew([{ ws, name: 'Wan' }]).joins[0];
  const joined = join.send();
  const localId = joined.playerId;
  // start() arms the countdown and a real setInterval; the interval is cleared at
  // once so the virtual clock below is the only thing that ticks the sim.
  match.start();
  clearInterval(match.tickInterval);

  const cs = new ClientState();
  if (arm.bufferZero) {
    Object.defineProperty(cs.remote.timeline, 'delay', { get: () => 0, set() {}, configurable: true });
  }
  let joinBytes = 0;
  const pushDown = async (text) => {
    const b = await comp.bytes(text);
    down.send(VNOW, text, b);
    return b;
  };
  // The join travels first, as it does on a real socket.
  if (!outbox.some((m) => m.startsWith('{"type":"join"'))) {
    joinBytes = await pushDown(JSON.stringify({ type: 'join', payload: { playerId: localId, snapshot: joined.snapshot } }));
  }

  const applyFull = (snap) => {
    if (!cs.acceptSeq(snap.seq)) return;
    const prev = cs.state;
    const next = prev && (snap.islands?.length ?? 0) === 0 ? { ...snap, islands: prev.islands, seaRocks: prev.seaRocks, seaPois: prev.seaPois } : snap;
    cs.state = next;
    cs.rebuildStateIndexes(next);
    cs.recordRemoteHistoryFromFull(next.serverTime);
  };

  // ── local prediction ──
  const ring = new PredictionRing();
  const clock = new PredictionClock();
  const sentAt = new Map();
  let pred = null; // PirateMotionState
  let predT = 0;
  let rttEst = null;
  let lastAckSeq = -2;
  let lastAckT = null;
  const corrections = [];
  let transitions = 0;
  let acks = 0;
  let predPathM = 0;

  // ── the walker: holds forward and turns, stops now and then ──
  let seq = 0;
  let input = { seq: 0, forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false, crouch: false, sprint: false, fire: false, aim: false, interact: false, reload: false, sailLower: false, yaw: 0, pitch: 0 };
  let nextChangeMs = 0;

  // ── sampler state ──
  const measureFromMs = WARMUP_S * 1000;
  const endMs = (WARMUP_S + SECONDS) * 1000;
  const prevPose = new Map();
  const newSub = () => ({ u: [], disc: 0, bodyS: 0 });
  const pop = { samples: 0, moving: 0, mag: [], ashore: newSub(), aboard: newSub(), teleports: 0, frameChanges: 0 };
  const modeStart = { ...cs.remote.modeCounts };
  let downBytes = 0;
  let downMsgs = 0;
  let lastFrameIdx = -1;
  const shipPose = { x: 0, y: 0, z: 0, yaw: 0 };

  for (VNOW = 0; VNOW <= endMs; VNOW += 1) {
    const measuring = VNOW >= measureFromMs;
    // SERVER: upstream arrivals, then one tick every 16 ms.
    if (VNOW % 16 === 0) {
      for (const m of up.deliver(VNOW)) match.handleClientMessage(localId, m.data);
      match.tick(0.016);
      for (const text of outbox.splice(0)) {
        const b = await pushDown(text);
        if (measuring) { downBytes += b; downMsgs += 1; }
        if (text.startsWith('{"type":"join"')) joinBytes = b;
      }
    }
    // CLIENT: deliveries.
    for (const m of down.deliver(VNOW)) {
      let msg;
      try { msg = JSON.parse(m.data); } catch { continue; }
      if (msg.type === 'join') applyFull(msg.payload.snapshot);
      else if (msg.type === 'state_snapshot') applyFull(msg.payload);
      else if (msg.type === 'state_hot') { cs.applyHotSnapshot(msg.payload); cs.recordHotHistory(msg.payload); }
      else if (msg.type === 'input_ack') {
        const ack = msg.payload;
        acks += 1;
        if (ack.seq !== lastAckSeq && sentAt.has(ack.seq)) {
          const sample = VNOW - sentAt.get(ack.seq);
          rttEst = rttEst === null ? sample : Math.min(rttEst * 1.02, sample);
          // First ack carrying this seq: the server applied it in (last ack t, this ack t].
          const appliedS = lastAckT !== null && lastAckT <= ack.t ? (lastAckT + ack.t) / 2 : ack.t;
          clock.noteApplied(sentAt.get(ack.seq) / 1000, appliedS);
        }
        if (lastAckT === null || ack.t > lastAckT) lastAckT = ack.t;
        lastAckSeq = ack.seq;
        if (!clock.ready && clock.offsetS !== null) clock.anchor(VNOW / 1000);
        if (!clock.ready || ack.seq < 0) continue;
        ring.pruneTo(ack.seq);
        const s = { position: { ...ack.pos }, velocity: { ...ack.vel }, crouching: false, state: ack.state, atCrowNest: false, onShipId: ack.onShipId };
        // The shipped client steers its prediction clock on every ack from the
        // measured apply delay; the free-run mutant keeps the clock it seeded on
        // the first ack (b1.3e's harness, and the 3.8 m p99 it measured).
        if (!pred) { pred = s; predT = clock.t; continue; }
        clock.t = predT; // the clock was stepped with the prediction since the last ack
        if (arm.anchor) predT = clock.anchor(VNOW / 1000);
        if (arm.replay) {
          const env = { ship: s.onShipId ? cs.shipsById.get(s.onShipId) ?? null : null, islands: cs.state?.islands ?? [], jumpBlocked: false };
          ring.replay(s, ack.t, predT, 0.016, env);
        }
        const d = Math.hypot(s.position.x - pred.position.x, s.position.z - pred.position.z);
        if (s.state !== pred.state || s.onShipId !== pred.onShipId || d > TELEPORT_M * 4) transitions += 1;
        else if (measuring) corrections.push(d);
        pred = s;
      }
    }
    // CLIENT frame at 60 Hz: advance the clock, send input.
    const frameIdx = Math.floor(VNOW * 60 / 1000);
    if (frameIdx !== lastFrameIdx) {
      lastFrameIdx = frameIdx;
      cs.remote.timeline.advance(VNOW);
      let changed = false;
      if (VNOW >= nextChangeMs) {
        const r = rng();
        input = { ...input, forward: r > 0.2, left: r > 0.85, right: r < 0.1, jump: rng() < 0.08, yaw: input.yaw + (rng() - 0.5) * 2.4 };
        nextChangeMs = VNOW + 600 + rng() * 1400;
        changed = true;
      }
      if (changed || frameIdx % 2 === 0) {
        if (changed) seq += 1;
        input = { ...input, seq };
        const text = JSON.stringify({ type: 'player_input', ts: VNOW, payload: input });
        up.send(VNOW, { type: 'player_input', payload: input }, Buffer.byteLength(text));
        if (!sentAt.has(seq)) sentAt.set(seq, VNOW);
        if (changed && pred) ring.record(seq, predT, input);
      }
    }
    // CLIENT prediction: fixed 16 ms steps on the client clock.
    if (pred && VNOW % 16 === 8) {
      const env = { ship: pred.onShipId ? cs.shipsById.get(pred.onShipId) ?? null : null, islands: cs.state?.islands ?? [], jumpBlocked: false };
      const inp = ring.inputAt(predT);
      const bx = pred.position.x; const bz = pred.position.z;
      if (inp) stepPirate(pred, inp, 0.016, env);
      if (measuring) predPathM += Math.hypot(pred.position.x - bx, pred.position.z - bz);
      predT += 0.016;
    }
    // SAMPLER ~111 Hz: what the renderer would draw for every remote pirate.
    if (measuring && VNOW % 9 === 0 && cs.state) {
      for (const p of cs.state.players) {
        if (p.id === localId) continue;
        const pose = cs.remote.poseAt(`P:${p.id}`, VNOW);
        if (!pose) continue;
        // poseAt answers in ONE reused scratch object: read the pirate's pose out
        // BEFORE asking for the hull, or the hull's answer overwrites it and the
        // "deck pose" composed below is the hull's world position spun by its own
        // yaw (b2.0d: that aliasing was the whole aboard miss b1.3e recorded; Game
        // reads the hull from ShipRenderer, not poseAt, so it never had it).
        let x = pose.x; let y = pose.y; let z = pose.z;
        const frame = pose.frame || '';
        if (frame) {
          const lx = x; const ly = y; const lz = z;
          const hp = cs.remote.poseAt(`S:${frame}`, VNOW);
          if (!hp) continue;
          shipPose.x = hp.x; shipPose.y = hp.y; shipPose.z = hp.z; shipPose.yaw = hp.yaw;
          const c = Math.cos(shipPose.yaw); const sn = Math.sin(shipPose.yaw);
          x = shipPose.x + lx * c + lz * sn;
          z = shipPose.z + lz * c - lx * sn;
          y = shipPose.y + ly;
        }
        pop.samples += 1;
        const prev = prevPose.get(p.id);
        const same = prev && prev.frame === frame;
        prevPose.set(p.id, { x, y, z, t: VNOW, frame, step: same ? Math.hypot(x - prev.x, z - prev.z) : null, dx: same ? x - prev.x : null, dz: same ? z - prev.z : null, dt: prev ? VNOW - prev.t : null });
        if (!prev || prev.frame !== frame) { if (prev) pop.frameChanges += 1; continue; }
        const dt = VNOW - prev.t;
        if (dt > 50) continue;
        const step = Math.hypot(x - prev.x, z - prev.z);
        if (step > TELEPORT_M) { pop.teleports += 1; continue; }
        const speed = step / (dt / 1000);
        if (prev.step === null || prev.dt === null || prev.dt > 50) continue;
        if (speed < MOVING_SPEED_MPS || speed > MAX_GRADEABLE_SPEED_MPS) continue;
        // unexplained = | step_i − (step_{i−1}/dt_{i−1}) × dt_i |, as a vector would be
        // better, but the magnitude form is the smoothness suite's own definition.
        // GRADED: the vector form, |d_i - d_(i-1) * dt_i / dt_(i-1)|: the displacement
        // this frame minus the one the previous frame's VELOCITY explains. It sees a
        // direction wobble at constant speed, which the magnitude form (the
        // smoothness suite's |step_i - speed_(i-1) * dt_i|, kept as info) is blind to.
        // Split by population: a pirate ashore is one interpolated track; a pirate
        // aboard is his deck pose composed on the interpolated hull, two tracks.
        const k = dt / prev.dt;
        const uv = Math.hypot((x - prev.x) - prev.dx * k, (z - prev.z) - prev.dz * k);
        const sub = frame ? pop.aboard : pop.ashore;
        sub.u.push(uv);
        sub.bodyS += dt / 1000;
        if (uv > DISCONTINUITY_M) sub.disc += 1;
        pop.moving += 1;
        pop.mag.push(Math.abs(step - (prev.step / prev.dt) * dt));
      }
    }
  }
  comp.end();
  if (process.env.WAN_STATS) {
    const q = (a) => [0.5, 0.9, 0.95, 0.99].map((x) => +pct(a, x).toFixed(4));
    console.log('STATS', arm.label, JSON.stringify({ ashore: q(pop.ashore.u), aboard: q(pop.aboard.u) }));
  }
  const modes = {};
  for (const k of Object.keys(cs.remote.modeCounts)) modes[k] = cs.remote.modeCounts[k] - (modeStart[k] ?? 0);
  const answers = Object.values(modes).reduce((a, b) => a + b, 0);
  return {
    label: arm.label,
    remote: {
      samples: pop.samples, moving: pop.moving, magP99: pct(pop.mag, 0.99), teleports: pop.teleports,
      ashore: summarize(pop.ashore), aboard: summarize(pop.aboard),
      held: answers > 0 ? (modes.held + modes.empty) / answers : NaN, extrapolated: answers > 0 ? modes.extrapolated / answers : NaN,
      delayMs: cs.remote.timeline.delay * 1000, jitterMs: cs.remote.timeline.jitter * 1000, hardSnaps: cs.remote.timeline.hardSnaps,
    },
    local: { acks, graded: corrections.length, transitions, p99: pct(corrections, 0.99), p50: pct(corrections, 0.5), worst: pct(corrections, 1), pathM: predPathM, rttEstMs: rttEst },
    down: { bytesPerSec: downBytes / SECONDS, msgs: downMsgs, joinBytes },
    link: { down: down.stats, up: up.stats },
  };
}

function summarize(sub) {
  return { n: sub.u.length, p99: pct(sub.u, 0.99), worst: pct(sub.u, 1), rate: sub.bodyS > 0 ? sub.disc / sub.bodyS : NaN };
}

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}${detail ? `  [${detail}]` : ''}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `  [${detail}]` : ''}`); }
};
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const printArm = (r) => {
  const R = r.remote; const L = r.local;
  console.log(`\n[${r.label}] link ${PROFILE.rttMs} ms RTT / ${PROFILE.jitterMs} ms jitter / ${(PROFILE.loss * 100).toFixed(1)}% loss; down HOL stalls ${r.link.down.holStalls} (worst ${f(r.link.down.maxHolMs, 0)} ms), lost ${r.link.down.lost} down / ${r.link.up.lost} up`);
  console.log(`  remote pirates: ${R.moving} moving samples of ${R.samples}; held+empty ${f(R.held * 100, 2)}%, extrapolated ${f(R.extrapolated * 100, 2)}%; delay ${f(R.delayMs, 1)} ms, jitter est ${f(R.jitterMs, 1)} ms, hard snaps ${R.hardSnaps}; magnitude-form p99 ${f(R.magP99)} m (info)`);
  for (const k of POPS) console.log(`    ${k.padEnd(6)} ${String(R[k].n).padStart(5)} samples: unexplained p99 ${f(R[k].p99, 4)} m, worst ${f(R[k].worst)} m, ${f(R[k].rate, 2)} disc/body-s`);
  console.log(`  local reconciliation: ${L.graded} graded acks (${L.transitions} state/frame transitions skipped), correction p50 ${f(L.p50)} / p99 ${f(L.p99)} / worst ${f(L.worst)} m; predicted path ${f(L.pathM, 1)} m; rtt est ${f(L.rttEstMs, 0)} ms`);
  console.log(`  downstream ${f(r.down.bytesPerSec / 1024, 1)} KB/s per client (target <= ${DOWN_TARGET / 1024}, hard <= ${DOWN_HARD / 1024}); join ${f(r.down.joinBytes / 1024, 1)} KB compressed`);
};

console.log(`test-wan-netcode: seed ${SEED}, ${SECONDS} s measured after ${WARMUP_S} s warmup, 9 bot crews + 1 human`);
const t0 = Date.now();
if (FORCED_BUFFER !== null) {
  // THE RED RUN: grade the forced-0 arm against the real bar. It must FAIL.
  const r = await runArm({ bufferZero: Number(FORCED_BUFFER) === 0, replay: true, anchor: true, label: `buffer forced ${FORCED_BUFFER} ms` });
  printArm(r);
  for (const k of POPS) {
    expect(`${k}: sampling measured something (>= ${MIN_MOVING_SAMPLES})`, r.remote[k].n >= MIN_MOVING_SAMPLES, String(r.remote[k].n));
    expect(`${k}: unexplained step p99 <= ${GRADE[k].p99} m`, r.remote[k].p99 <= GRADE[k].p99, f(r.remote[k].p99, 4));
    expect(`${k}: discontinuities <= ${GRADE[k].rate}/body-s`, r.remote[k].rate <= GRADE[k].rate, f(r.remote[k].rate, 2));
  }
} else {
  const on = await runArm({ bufferZero: false, replay: true, anchor: true, label: 'shipped client' });
  printArm(on);
  const off = await runArm({ bufferZero: true, replay: false, label: 'mutants: buffer 0 ms, no replay, free-run clock' });
  printArm(off);
  console.log('\nBars (shipped client):');
  const miss = (ok) => (ok ? 'bar met' : 'launch bar MISSED');
  for (const k of POPS) {
    const R = on.remote[k];
    expect(`${k}: sampling measured something (>= ${MIN_MOVING_SAMPLES})`, R.n >= MIN_MOVING_SAMPLES, String(R.n));
    expect(`${k}: remote pirate unexplained step p99 <= ${GRADE[k].p99} m`, R.p99 <= GRADE[k].p99, `${f(R.p99, 4)}; bar ${BAR.p99}: ${miss(R.p99 <= BAR.p99)}`);
    expect(`${k}: remote discontinuities <= ${GRADE[k].rate}/body-s`, R.rate <= GRADE[k].rate, `${f(R.rate, 2)}; bar ${BAR.rate}: ${miss(R.rate <= BAR.rate)}`);
  }
  expect(`held/empty answers <= ${BAR.held * 100}%`, on.remote.held <= BAR.held, `${f(on.remote.held * 100, 2)}%`);
  expect('local body moved (the reconciliation had work to do)', on.local.pathM > 20 && on.local.graded > 200, `${f(on.local.pathM, 1)} m, ${on.local.graded} acks`);
  expect(`local reconciliation correction p99 < ${RECON_P99_M} m`, on.local.p99 < RECON_P99_M, f(on.local.p99));
  expect(`downstream <= ${DOWN_HARD / 1024} KB/s per client (hard)`, on.down.bytesPerSec <= DOWN_HARD, `${f(on.down.bytesPerSec / 1024, 1)} KB/s; target ${DOWN_TARGET / 1024}: ${on.down.bytesPerSec <= DOWN_TARGET ? 'met' : 'MISSED'}`);
  console.log('\nMutation proof (the bars must be ones the broken arms cannot clear):');
  // VACUOUS counts as FAIL: a mutant arm that measured nothing has proven nothing.
  // It must fail the SAME graded bounds the shipped arm passed, on every seed
  // (5-seed spread in the header), not by luck of one population.
  const clears = (R) => R.n >= MIN_MOVING_SAMPLES && R.p99 <= GRADE.aboard.p99 && R.rate <= GRADE.aboard.rate;
  expect('buffer forced to 0 ms FAILS the graded aboard bound', off.remote.aboard.n >= MIN_MOVING_SAMPLES && Number.isFinite(off.remote.aboard.p99) && !clears(off.remote.aboard), `p99 ${f(off.remote.aboard.p99, 4)} m, ${f(off.remote.aboard.rate, 2)}/body-s`);
  expect('buffer forced to 0 ms FAILS the graded ashore bound', off.remote.ashore.n >= MIN_MOVING_SAMPLES && Number.isFinite(off.remote.ashore.p99) && !(off.remote.ashore.p99 <= GRADE.ashore.p99 && off.remote.ashore.rate <= GRADE.ashore.rate), `p99 ${f(off.remote.ashore.p99, 4)} m, ${f(off.remote.ashore.rate, 2)}/body-s`);
  expect('snapping to the ack without replay FAILS the local bar', off.local.graded > 200 && Number.isFinite(off.local.p99) && !(off.local.p99 < RECON_P99_M), `p99 ${f(off.local.p99)} m`);
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — test-wan-netcode (${failures} failure${failures === 1 ? '' : 's'}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failures === 0 ? 0 : 1);
