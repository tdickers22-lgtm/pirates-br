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
 *    NOTE: Game.ts does not consume input_ack today (the live client draws its
 *    own body by dead reckoning); this grades the reconciliation path the
 *    client is meant to run, on the real acks the server sends.
 *
 * BARS.
 *  - remote pirates, split ashore / aboard (world path, aboard composed on the
 *    hull), unexplained step in VECTOR form: p99 <= 0.02 m and <= 1.0
 *    discontinuities per body-second, held/empty answers <= 3%: the
 *    test-remote-smoothness bound. Ashore is graded at it; aboard at its
 *    measured bound (see MEASURED) until b2.0d.
 *  - local reconciliation: correction at each ack p99 < 0.3 m.
 *  - downstream per client <= 120 KB/s hard (80 KB/s target printed).
 *  - mutation proof, same run: the interpolation buffer forced to 0 ms must FAIL
 *    the remote bar, and a client that snaps to the ack without replaying its
 *    inputs must FAIL the local bar. A bar the broken arm clears cannot fail.
 *
 * Usage: node --import tsx scripts/test-wan-netcode.mjs [--seconds 30] [--seed 7] [--strict]
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
 * THE RECORDED MISS (PLAN b1.3e gate: "a miss is fixed by a <= 20-line hook or
 * recorded as its measured bound with slice b2.0d filed, never a silently
 * loosened bound"). First run at 7a1 (seed 7, 20 s): remote pirate p99 0.137 m
 * at 10.95 disc/body-s against the 0.02 m / 1.0 bar; local reconciliation p99
 * 3.67 m against 0.3 m (and the no-replay control reads 0.72 m, so the replay
 * itself is what is wrong: it steps the deck-carry against the hull's NEWEST
 * pose instead of its pose at each replayed tick). Neither fits a 20-line hook,
 * so the default run grades the MEASURED bound below (it still fails a
 * regression) and prints the launch bar as MISSED; `--strict` grades the launch
 * bar itself and is what b2.0d must turn green, then delete this table.
 * The local miss has no honest measured bound (the no-replay mutant clears
 * anything above 3.7 m), so it is reported, not graded, until b2.0d.
 */
const STRICT = argv.includes('--strict');
// SEEDED, SPLIT, VECTOR (b1.3e finish). The run is deterministic per --seed (see
// DETERMINISM below), so the bounds are measured, not sampled. 30 s window,
// seeds 1-7, shipped arm vs buffer-0 mutant (vector form, p99 m / disc per body-s):
//                shipped                         buffer 0 ms
//   ashore  p99 0.0117-0.0171, 0.23-0.95/s   p99 0.0224-0.0446, 1.31-3.61/s
//   aboard  p99 0.169-0.187,  19.0-39.7/s    p99 0.489-0.641,  16.4-39.7/s
// Ashore the shipped client MEETS the launch bar and the mutant misses it on
// both clauses on every seed, so ashore is graded at the launch bar itself.
// Aboard (deck pose composed on the interpolated hull) is the recorded miss: the
// p99 bound 0.3 m sits 38% above the shipped worst and 39% below the mutant's
// best. The aboard RATE does not separate the arms (both 16-40/s), so its bound
// (60) only catches a gross regression. --strict grades both populations at the
// launch bar: that is b2.0d's exit gate and it is RED on aboard today.
const POPS = ['ashore', 'aboard'];
const MEASURED = { ashore: { p99: BAR.p99, rate: BAR.rate }, aboard: { p99: 0.3, rate: 60 } };
const GRADE = STRICT
  ? { ashore: { ...BAR }, aboard: { ...BAR } }
  : { ashore: { ...BAR, ...MEASURED.ashore }, aboard: { ...BAR, ...MEASURED.aboard } };

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
  const sentAt = new Map();
  let pred = null; // PirateMotionState
  let predT = 0;
  let rttEst = null;
  let lastAckSeq = -2;
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
        }
        lastAckSeq = ack.seq;
        if (rttEst === null || ack.seq < 0) continue;
        ring.pruneTo(ack.seq);
        const s = { position: { ...ack.pos }, velocity: { ...ack.vel }, crouching: false, state: ack.state, atCrowNest: false, onShipId: ack.onShipId };
        if (!pred) { pred = s; predT = ack.t + rttEst / 1000; continue; }
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
        let x = pose.x; let y = pose.y; let z = pose.z;
        const frame = pose.frame || '';
        if (frame) {
          const hp = cs.remote.poseAt(`S:${frame}`, VNOW);
          if (!hp) continue;
          shipPose.x = hp.x; shipPose.y = hp.y; shipPose.z = hp.z; shipPose.yaw = hp.yaw;
          const c = Math.cos(shipPose.yaw); const sn = Math.sin(shipPose.yaw);
          x = shipPose.x + pose.x * c + pose.z * sn;
          z = shipPose.z + pose.z * c - pose.x * sn;
          y = shipPose.y + pose.y;
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
  const r = await runArm({ bufferZero: Number(FORCED_BUFFER) === 0, replay: true, label: `buffer forced ${FORCED_BUFFER} ms` });
  printArm(r);
  for (const k of POPS) {
    expect(`${k}: sampling measured something (>= ${MIN_MOVING_SAMPLES})`, r.remote[k].n >= MIN_MOVING_SAMPLES, String(r.remote[k].n));
    expect(`${k}: unexplained step p99 <= ${GRADE[k].p99} m`, r.remote[k].p99 <= GRADE[k].p99, f(r.remote[k].p99, 4));
    expect(`${k}: discontinuities <= ${GRADE[k].rate}/body-s`, r.remote[k].rate <= GRADE[k].rate, f(r.remote[k].rate, 2));
  }
} else {
  const on = await runArm({ bufferZero: false, replay: true, label: 'shipped client' });
  printArm(on);
  const off = await runArm({ bufferZero: true, replay: false, label: 'mutants: buffer 0 ms, no replay' });
  printArm(off);
  console.log('\nBars (shipped client):');
  const miss = (ok) => (ok ? 'bar met' : 'launch bar MISSED -> b2.0d');
  const tag = (k, key) => (GRADE[k][key] === BAR[key] ? ' (launch bar)' : ' (measured bound)');
  for (const k of POPS) {
    const R = on.remote[k];
    expect(`${k}: sampling measured something (>= ${MIN_MOVING_SAMPLES})`, R.n >= MIN_MOVING_SAMPLES, String(R.n));
    expect(`${k}: remote pirate unexplained step p99 <= ${GRADE[k].p99} m${tag(k, 'p99')}`, R.p99 <= GRADE[k].p99, `${f(R.p99, 4)}; bar ${BAR.p99}: ${miss(R.p99 <= BAR.p99)}`);
    expect(`${k}: remote discontinuities <= ${GRADE[k].rate}/body-s${tag(k, 'rate')}`, R.rate <= GRADE[k].rate, `${f(R.rate, 2)}; bar ${BAR.rate}: ${miss(R.rate <= BAR.rate)}`);
  }
  expect(`held/empty answers <= ${BAR.held * 100}%`, on.remote.held <= BAR.held, `${f(on.remote.held * 100, 2)}%`);
  expect('local body moved (the reconciliation had work to do)', on.local.pathM > 20 && on.local.graded > 200, `${f(on.local.pathM, 1)} m, ${on.local.graded} acks`);
  if (STRICT) expect(`local reconciliation correction p99 < ${RECON_P99_M} m`, on.local.p99 < RECON_P99_M, f(on.local.p99));
  else console.log(`  - local reconciliation correction p99 ${f(on.local.p99)} m vs bar < ${RECON_P99_M} m: ${miss(on.local.p99 < RECON_P99_M)} (reported, not graded until b2.0d)`);
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
