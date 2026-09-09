#!/usr/bin/env node
/**
 * REMOTE SMOOTHNESS — is the path a remote body is DRAWN along continuous, or is
 * it a straight line that gets yanked sideways every time a snapshot lands?
 *
 * WHAT THIS MEASURES THAT test-motion-continuity.mjs CANNOT.
 *
 * That suite grades CARRY: does the render target advance at the entity's own
 * velocity between snapshots. Carry answers "is the body frozen between updates"
 * and a pure extrapolator scores a perfect 1.00 on it — by construction, because
 * extrapolation IS "advance at the last known velocity". Carry is blind to the
 * defect that replaced the frozen one: the CORRECTION. An extrapolator draws
 *
 *     p(t) = p_snapshot + v_snapshot × (t − whenThatPacketLANDED)
 *
 * which is a ray anchored on ARRIVAL. When the next snapshot lands the ray is
 * thrown away and a new one starts from the new sample — and the new sample is
 * NOT where the old ray had got to, because the entity turned, or because the
 * packet was late and the ray had run further than one interval of real motion.
 * The gap between the two is a position step inside a single frame. Carry reads
 * 1.00 through all of it.
 *
 * HOW IT IS SAMPLED WITHOUT A FAST FRAME RATE. The render target is a pure
 * function of (world state, clock), and the world state advances on the WEBSOCKET
 * callback, not on the frame loop. So this does not sample once per drawn frame —
 * on SwiftShader that is 3-8Hz and could not see a 32ms event at all. It samples
 * on a timer at ~106Hz, calling the very functions the renderer calls. What comes
 * back is the trajectory the renderer WOULD draw at any frame rate, and it is
 * exact: nothing in it is a function of how fast this machine rasterises.
 *
 * THE METRIC: VELOCITY CONTINUITY, and nothing else.
 *
 *     unexplained = | step_i − (step_{i−1} / dt_{i−1}) × dt_i |
 *
 * — how far the body moved beyond simply carrying on at the speed it had over the
 * previous sample interval. On a smooth path this is the body's own acceleration
 * over a 9ms window, which for anything that walks or swims is single-digit
 * millimetres. On a corrected path it is the correction, in full.
 *
 * It is deliberately NOT graded against the entity's `velocity` field. Two
 * reasons, and both are load-bearing. Sharks HAVE no velocity on the wire (see
 * HotSharkState — id, position, rotation, health, attackState, attackTimer), so
 * a metric that needs one cannot grade the population that staircases worst. And
 * a buffered body is drawn where it was a delay ago, so differencing it against
 * the velocity it has NOW charges the metric for the delay rather than for any
 * discontinuity — which is measuring the wrong thing on purpose.
 *
 * Reported in metres and in PIXELS at the range the body was actually drawn (the
 * only unit in which "visible" means anything). A DISCONTINUITY is an unexplained
 * step over DISCONTINUITY_M — 2cm, about a boot's width.
 *
 * BOTH ARMS, ONE RUN. `setRemoteInterpolation` is toggled every PHASE_MS, so the
 * buffer and the arithmetic it replaced are measured on the same walker, the same
 * bot fleet and the same wire, alternating, for the whole window. That is the
 * mutation proof and it is ASSERTED: the run is red if the OFF arm passes the bar
 * the ON arm is held to, because a gate whose bar the old path clears is a gate
 * that cannot fail.
 *
 * Usage:
 *   node scripts/test-remote-smoothness.mjs
 *   node scripts/test-remote-smoothness.mjs --seconds 60 --report
 *   node scripts/test-remote-smoothness.mjs --url http://127.0.0.1:3101 --server 8091
 */
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const ROOT_URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const SERVER_PORT = arg('server', process.env.PIRATES_BR_SERVER_PORT ?? null);
const SECONDS = Number.parseInt(arg('seconds', '60'), 10);
const REPORT_ONLY = has('report');
/**
 * THE HOST-STALL RIG, and it is the reason this suite can be trusted on any
 * machine. `--stall-ms 1500 --stall-every 4000` busy-waits the page's main
 * thread for 1.5s out of every 4 — which is not a simulation of a slow host, it
 * IS one: the message callback cannot run, snapshots queue, and they arrive in a
 * burst that overruns a 24-deep ring exactly as a 1.4s island build does. Used
 * to prove that the numbers this suite grades stop moving when the HOST changes
 * and only move when the PRODUCT does. Off in a graded run.
 */
const STALL_MS = Number.parseInt(arg('stall-ms', '0'), 10);
const STALL_EVERY_MS = Number.parseInt(arg('stall-every', '4000'), 10);
const VIEWPORT = { width: 480, height: 270 };

/** A step this far beyond carrying on at the current speed is a visible twitch. */
const DISCONTINUITY_M = 0.02;
/** …and this far is not a twitch, it is a teleport (respawn, board, launch). */
const TELEPORT_M = 2.0;
/** Below this the body reads as still and the statistic is division by noise. */
const MOVING_SPEED_MPS = 1.0;
/**
 * …and above this nothing in the population is a body walking or swimming, so a
 * sample that claims it is came from a discontinuity, not from motion. A pirate
 * sprints at ~6 m/s and a shark at ~7; the first run of this suite graded a
 * "remote player" at 85 m/s, which is what a respawn teleport looks like when
 * the speed is measured off the path. Sampled out rather than clamped, because a
 * body that just teleported is not a body whose smoothness anyone can grade.
 */
const MAX_GRADEABLE_SPEED_MPS = 15;
/** How long each arm runs before the lever flips. Long enough to hold a walking
 *  leg inside one arm, short enough that ten of them fit in a minute. */
const PHASE_MS = 4500;

// ── WHAT THIS SUITE REFUSES TO GRADE, AND WHY IT HAD TO LEARN TO ────────────
//
// The header above is right that the SAMPLING is frame-rate-free: the render
// target is a pure function of (world state, clock) and this reads it on a
// 227Hz timer, not on a drawn frame. What that argument misses is that the
// HISTORY those answers come out of is destroyed by a main-thread stall, and a
// stall is exactly what a software rasteriser produces.
//
// A browser that spends 1.4s building an island runs no message callback while
// it does. Every snapshot that landed meanwhile is queued and delivered in one
// burst, and RemoteTrack is a ring TRACK_CAPACITY=24 deep — about 0.9s of
// history at the ~37ms interval this stack measures. A burst longer than that
// evicts the span the render clock is still standing in, so `sample()` takes
// the `renderT <= t[oldest]` branch and HOLDS the body: not because the delay
// was sized too small for the wire, which is the defect the 3% held bar exists
// to catch, but because the rasteriser stopped the client for a second and a
// half. Then the clock catches up and the held body moves in one step, which
// lands in the p99 as an unexplained one.
//
// That is why this suite was red on every baseline anyone tried while passing
// in isolation on the same commit (gate-4: "held 4.5% of answers (max 3%)"
// under the battery; 0.4-0.9% here on an idle machine). The bar was measuring
// the host. Neither number is widened: the run now SEPARATES the answers taken
// while the host was feeding the measurement from the ones taken in the wake of
// a stall, grades the first at the same bars, reports the second, and says
// NOT GRADED rather than FAIL when there is not enough of the first left.
//
/** A gap between sampler ticks this long is not a 9ms window a body moved
 *  through; it is a stall. Same 50ms the per-sample rule below already uses to
 *  refuse a differenced pair, so the two cannot disagree. */
const STALL_GAP_MS = 50;
/**
 * …and how long the wake of one lasts. MEASURED, not reasoned. Under the rig
 * below at `--stall-ms 1500 --stall-every 4000` — 30 stalls in a 60s window,
 * worst gap 1509ms, a quarter of the window frozen solid — the held answers
 * fell out by time since the last stall ended as
 *
 *     in-stall 48 · 0-100ms 1358 · 100-300ms 550 · 300-900ms 128 · settled 48
 *
 * against 30 / 611 / 1269 / 2448 / 4393 ticks: 91% of them inside 300ms of a
 * stall ending, on 21% of the ticks. This was first written as 900ms — one ring
 * of TRACK_CAPACITY=24 at the measured interval, reasoned from the code — and is
 * RE-PINNED TIGHTER to 300 against that census. Tighter is the safe direction
 * here: it excludes LESS of the run, so the bar is applied to more of it, and at
 * 900ms the suite threw away half the window and could not grade the held bar at
 * all on a stalling host (54.5% healthy against a 60% floor). What survives past
 * 300ms is graded, and it clears the unchanged 3% bar with room: 176 held
 * answers in ~44k under a rig far more brutal than any real frame stall.
 */
const STALL_SETTLE_MS = 300;
/**
 * THE HOST-SPEED FLOOR. Below this share of the window spent feeding the
 * measurement, the run has not measured the buffer badly — it has measured the
 * machine, and it says so instead of failing. Deliberately generous: two idle
 * runs on this Air spent 97-99% of their ticks healthy, and gate-4's battery
 * runs are the case this exists for.
 */
const MIN_HEALTHY_TICK_SHARE = 0.6;
/** …and the absolute one: a held rate is a ratio, and a ratio of a few hundred
 *  answers cannot resolve a 3% bar. One idle run makes ~87k. */
const MIN_HEALTHY_ANSWERS = 10_000;

/**
 * THE TRIPWIRES, set from the measured OFF arm (see the commit that landed the
 * buffer). The OFF arm on this bot fleet reads ~5 unexplained steps per body-
 * second with a p99 in the tens of centimetres; the ON arm reads a body's own
 * acceleration over 9ms, which is millimetres.
 */
const BARS = {
  // Bodies that are somebody else's and are simply going about their business.
  // Nothing in this population starts, stops or walks into anything inside one
  // server tick, so its drawn path should be as continuous as the arithmetic can
  // make it. Measured: 0.00/body-s, p99 0.008m, worst 0.016m.
  'remote-player': { rate: 1.0, p99: 0.02 },
  // THE WALKER — RELATIVELY GRADED ONLY, and the reason is what he IS. He is the
  // LOCAL pirate routed down the remote branch for the length of one evaluation,
  // because a bot match never produces a remote pirate on foot. That makes him a
  // proxy, and the proxy carries something no genuinely remote body carries: the
  // server's reconciliation of HIS OWN INPUTS. On a client at six frames a
  // second the inputs arrive in clumps, and the authoritative position that
  // comes back has real steps in it that no remote body's has. Measured: p99
  // 0.027m against the genuinely-remote population's 0.007m, in the same runs,
  // after the steadiness filter had already taken out the start/stop.
  //
  // Holding a proxy to an absolute bar it cannot meet for reasons that are not
  // about the thing under test is how a suite ends up with a widened threshold
  // and a shrug. He is graded on the comparison instead, which is the one
  // statement he can support and a strong one: 5.3x to 20.9x better than the
  // dead-reckoned arm across every run in this campaign.
  'local-as-remote': null,
  // Sharks: the population the whole exercise was for, and the one a bot match
  // will not reliably produce (they spawn on a swimmer, on a cooldown, by
  // chance). Held to the steady-body bar for the runs that do get them.
  shark: { rate: 1.0, p99: 0.02 },
};
/**
 * …and the relative bar, which is the one that cannot be gamed. Both arms see the
 * same walker, the same fleet and the same wire, and the same irreducible floor
 * above, so the RATIO between them is a clean reading of what the buffer did.
 */
const MIN_P99_IMPROVEMENT = 4;
/** A run that sampled almost nothing has not passed; it has failed to measure.
 *  Low because the evidence is expensive: a bot match produces exactly one body
 *  on the move (bots hold stations, skeletons stand), it is moving about a third
 *  of the window, and half of what is left goes to the OFF arm. */
const MIN_MOVING_SAMPLES = 250;

const sessionQuery = (extra = []) => ['debug', ...(SERVER_PORT ? [`server=${SERVER_PORT}`] : []), ...extra].join('&');

/**
 * Installed in the page. One tick every ~9ms: for every remote body being drawn,
 * evaluate the render target and difference it against the previous two
 * evaluations. Deliberately allocation-light — it runs beside the frame loop it
 * is measuring and must not be able to change what it measures.
 */
const SAMPLER = `(() => {
  const g = window.__piratesBR;
  const acc = { started: performance.now(), ticks: 0, err: null, pop: {} };
  window.__rs = acc;
  const popOf = (arm, name) => {
    const key = arm + '/' + name;
    return (acc.pop[key] ||= {
      samples: 0, moving: 0, unexplained: [], snaps: 0, teleports: 0, ungradeable: 0,
      stalled: 0, worstStalledM: 0,
      worstM: 0, worstPx: 0, bodySeconds: 0, speedSum: 0,
    });
  };
  // ── THE HOST-SPEED CENSUS (see the header block in the runner) ───────────
  // Answers are attributed to the interval they were made in, and an interval
  // that straddles or follows a main-thread stall is reported rather than
  // graded. Nothing here is a frame time: it is a tick gap, which is what the
  // measurement itself was starved by.
  const host = {
    ticks: 0, healthyTicks: 0, stalls: 0, worstGapMs: 0, stalledMs: 0,
    healthy: { interpolated: 0, extrapolated: 0, held: 0, empty: 0 },
    stalled: { interpolated: 0, extrapolated: 0, held: 0, empty: 0 },
    // Held answers against how long ago the last stall ended, printed every run
    // so "held tracks the stall, not the wire" stays a reading and not a claim.
    heldBy: { inStall: 0, ms0_100: 0, ms100_300: 0, ms300_900: 0, settled: 0 },
    ticksBy: { inStall: 0, ms0_100: 0, ms100_300: 0, ms300_900: 0, settled: 0 },
  };
  acc.host = host;
  let lastTickAt = -1;
  let lastStallEndAt = -Infinity;
  let prevModes = null;
  // id -> { t, x, y, z, v }  — v is the speed over the PREVIOUS interval, which
  // is what the next step is predicted from.
  const prev = new Map();
  /** Per-body server speed at the previous tick — the steadiness test above. */
  const serverSpeed = new Map();
  /** …and the shark's only equivalent: its telegraphed attack state. */
  const sharkState = new Map();
  // The state is current-snapshot data while the pose is intentionally drawn
  // from buffered history. Keep the transition quarantined until even the
  // maximum 192ms render delay plus the 200ms bounded fallback is behind us.
  const SHARK_TRANSITION_SETTLE_MS = 450;

  const record = (arm, popName, id, x, y, z, now, pxPerRad, cam, healthy) => {
    const pop = popOf(arm, popName);
    pop.samples++;
    // KEYED BY POPULATION AS WELL AS BY BODY. A pirate who steps off a gangway
    // moves from 'deck-crew' to 'local-as-remote' and his placement changes with
    // him — hull-composed one sample, world-buffered the next. Differencing
    // across that boundary charges the ashore population for a change of
    // arithmetic, which is how the first scoped run reported a 0.21m step on a
    // walker who had merely disembarked.
    const key = popName + '|' + id;
    const was = prev.get(key);
    prev.set(key, { t: now, x, y, z, v: was ? was.vNext : null, vNext: null });
    const cur = prev.get(key);
    if (!was) return;
    const dt = (now - was.t) / 1000;
    if (dt <= 0 || dt > 0.05) return; // a stalled timer is not evidence
    const step = Math.hypot(x - was.x, y - was.y, z - was.z);
    // A teleport is not a speed. Leaving vNext null after one means the NEXT
    // sample has nothing to be predicted from and is skipped instead of being
    // charged the teleport's velocity — which is how the first run of this suite
    // reported a 3.3m "step" on a shark that had merely respawned.
    cur.vNext = step > ${TELEPORT_M} ? null : step / dt;
    if (was.v === null) return;              // need two intervals to predict one
    if (was.v < ${MOVING_SPEED_MPS}) return; // a body at rest cannot be graded
    if (was.v > ${MAX_GRADEABLE_SPEED_MPS}) { pop.ungradeable++; return; }
    // NOT IN THE WAKE OF A STALL. Both of the guards above drop a sample for
    // something the BODY did; this one drops it for something the HOST did, and
    // it has to come before bodySeconds so the excluded sample leaves neither a
    // snap in the numerator nor a body-second in the denominator. The step it
    // would have contributed is kept as worstStalledM and printed, because a
    // suite that silently swallows its largest numbers is not honest either.
    if (!healthy) {
      pop.stalled++;
      if (step <= ${TELEPORT_M}) {
        const u = Math.abs(step - was.v * dt);
        if (u > pop.worstStalledM) pop.worstStalledM = u;
      }
      return;
    }
    pop.moving++;
    pop.bodySeconds += dt;
    pop.speedSum += was.v;
    if (step > ${TELEPORT_M}) { pop.teleports++; return; }
    const unexplained = Math.abs(step - was.v * dt);
    pop.unexplained.push(unexplained);
    if (unexplained > ${DISCONTINUITY_M}) pop.snaps++;
    if (unexplained > pop.worstM) {
      pop.worstM = unexplained;
      const dist = Math.max(1, Math.hypot(x - cam.position.x, z - cam.position.z));
      pop.worstPx = (unexplained / dist) * pxPerRad;
    }
  };

  const tick = () => {
    try {
      const st = g.state;
      if (!st || st.phase !== 'playing') return;
      acc.ticks++;
      const now = performance.now();
      const stats = g.getRemoteInterpolationStats();
      const arm = stats.enabled ? 'on' : 'off';

      // ── was the host feeding this tick? ──────────────────────────────────
      const gap = lastTickAt < 0 ? 0 : now - lastTickAt;
      lastTickAt = now;
      if (gap > ${STALL_GAP_MS}) { lastStallEndAt = now; host.stalls++; host.stalledMs += gap; }
      if (gap > host.worstGapMs) host.worstGapMs = gap;
      const sinceStall = now - lastStallEndAt;
      const healthy = gap <= ${STALL_GAP_MS} && sinceStall >= ${STALL_SETTLE_MS};
      // Finer than the settle window on purpose: the bands either side of it are
      // the evidence that it is pinned where the held answers actually stop.
      const bucket = gap > ${STALL_GAP_MS} ? 'inStall'
        : sinceStall < 100 ? 'ms0_100'
        : sinceStall < 300 ? 'ms100_300'
        : sinceStall < 900 ? 'ms300_900' : 'settled';
      host.ticks++;
      if (healthy) host.healthyTicks++;
      host.ticksBy[bucket]++;
      // The mode census is CUMULATIVE in the client, so the answers made since
      // the last tick are its delta — and they belong to the interval that just
      // elapsed, which is the one whose health was just decided. Only the ON arm
      // produces any: poseAt returns null with the buffer off.
      const modes = stats.modes;
      if (prevModes) {
        const bin = healthy ? host.healthy : host.stalled;
        const dHeld = modes.held - prevModes.held;
        bin.interpolated += modes.interpolated - prevModes.interpolated;
        bin.extrapolated += modes.extrapolated - prevModes.extrapolated;
        bin.held += dHeld;
        bin.empty += modes.empty - prevModes.empty;
        host.heldBy[bucket] += dHeld;
      }
      prevModes = modes;
      const cam = g.renderer.camera;
      const fovRad = (cam.fov * Math.PI) / 180;
      const pxPerRad = window.innerHeight / (2 * Math.tan(fovRad / 2));

      // ── remote players ──────────────────────────────────────────────────
      // The local pirate is routed down the REMOTE branch for the length of one
      // evaluation: a bot match never produces a remote pirate on foot (bots man
      // stations, skeletons stand), so without this the population that matters
      // goes ungraded for want of a moving body. Same trick, same reason, as
      // test-motion-continuity.mjs.
      const idSaved = g.localPlayerId;
      for (const p of st.players) {
        if (p.state !== 'alive' || p.cannonBallistic) continue;
        const isLocal = p.id === idSaved;
        if (isLocal) g.localPlayerId = null;
        let q = null;
        try { q = g.getPlayerRenderPosition(p, 0.035); } finally { if (isLocal) g.localPlayerId = idSaved; }
        // WHICH BODIES CAN BE GRADED AT 108Hz, AND WHY THE OTHERS CANNOT.
        //
        // A body ashore is placed by the buffer and the render clock and nothing
        // else, so its drawn path is a pure function of the arithmetic under
        // test and can be sampled as fast as you like. A body ON A DECK is
        // composed against readShipRenderPose() — the hull that is ON THE SCREEN,
        // which is the whole point of the deck weld — and that transform is
        // written once per FRAME. A swimmer's height is pulled onto the Gerstner
        // surface off the ocean clock, which is also per frame. Sampling either
        // at 108Hz on a 6fps rasteriser measures the FRAME RATE: the composed
        // quantity is frozen for 170ms and then steps, twenty times per sample
        // window, and the reading says far more about SwiftShader than about the
        // buffer. They are counted and reported, never graded.
        const pop = p.onShipId ? 'deck-crew' : p.state === 'swimming' ? 'swimmer'
          : isLocal ? 'local-as-remote' : 'remote-player';
        // A BODY THAT IS GENUINELY ACCELERATING CANNOT BE GRADED FOR CONTINUITY.
        //
        // The rig presses a key and lets go of it every 2.5s, and the server
        // stops a pirate inside one or two 16ms ticks — a real 5 m/s change of
        // velocity. Drawn faithfully, that is a 5cm step at a 9ms sample that
        // nothing in the renderer put there, and it is what held the walking
        // population's p99 at 0.03-0.05m in both arms while the steady one read
        // 0.006m.
        //
        // The test is made on the SERVER's velocity field, not on the drawn
        // path, and that is the whole point: a correction does not change the
        // entity's velocity, so this cannot hide one. It only drops the samples
        // where the body itself changed what it was doing.
        const sp = Math.hypot(p.velocity.x, p.velocity.z);
        const key = 'P' + p.id;
        const wasSp = serverSpeed.get(key);
        serverSpeed.set(key, sp);
        if (wasSp !== undefined && Math.abs(sp - wasSp) > 1.0) { prev.delete(pop + '|' + key); continue; }
        record(arm, pop, key, q.x, q.y, q.z, now, pxPerRad, cam, healthy);
      }

      // ── sharks ──────────────────────────────────────────────────────────
      for (const s of st.sharks ?? []) {
        if (s.health <= 0) continue;
        const q = g.getSharkRenderPosition(s);
        // The same steadiness test the walkers get, made on the only field a
        // shark HAS. A telegraphed attack is three deliberate changes of motion
        // in under a second — rear back, lunge, droop — and the server does each
        // of them inside a tick or two. Drawn faithfully that is a large step at
        // a 9ms sample, and it is the animation working, not the netcode
        // failing. Cruise and recover are graded; the burst and every transition
        // into or out of it are dropped, and the state comes off the SNAPSHOT,
        // so a correction cannot hide behind it.
        const key = 'K' + s.id;
        const state = s.attackState || 'cruise';
        const wasState = sharkState.get(key);
        const changedAt = !wasState || wasState.state !== state ? now : wasState.changedAt;
        sharkState.set(key, { state, changedAt });
        if (state === 'windup' || state === 'lunge' || now - changedAt < SHARK_TRANSITION_SETTLE_MS) {
          prev.delete('shark|' + key);
          continue;
        }
        record(arm, 'shark', key, q.x, q.y, q.z, now, pxPerRad, cam, healthy);
      }
    } catch (e) {
      acc.err = String(e && e.message ? e.message : e);
    }
  };

  acc.timer = setInterval(tick, 0);
  // The lever. Flipped on its own clock so neither arm can be handed the good
  // half of the window.
  let on = true;
  acc.phase = setInterval(() => {
    on = !on;
    g.setRemoteInterpolation(on);
    // A body's history is per-id and survives the flip, so the first sample after
    // a flip differences a buffered position against a dead-reckoned one. That
    // step is the LEVER, not the path, so drop the pair that straddles it.
    prev.clear();
  }, ${PHASE_MS});
})()`;

/** Keep one pirate genuinely on the move — same reason as test-motion-continuity. */
async function walkAbout(page, totalMs) {
  const end = Date.now() + totalMs;
  const legs = ['w', 'w', 's', 's'];
  let i = 0;
  while (Date.now() < end) {
    const key = legs[i++ % legs.length];
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(2500, Math.max(0, end - Date.now())));
    await page.keyboard.up(key);
    await page.waitForTimeout(Math.min(400, Math.max(0, end - Date.now())));
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
const f = (v, d = 3) => (v === null || v === undefined ? '--' : v.toFixed(d));

async function main() {
  console.log(`remote smoothness — ${describeGl()}`);
  console.log(`  client ${ROOT_URL}${SERVER_PORT ? `  server :${SERVER_PORT}` : ''}  window ${SECONDS}s  `
    + `arms alternate every ${PHASE_MS}ms`);

  const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const failures = [];
  /** Bars this run could not put a number behind. Never silent, never a FAIL:
   *  each one is printed with the measurement that disqualified it, and if
   *  NOTHING was graded the run tells the runner so rather than exiting 0. */
  const notGraded = [];
  let graded = 0;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message.slice(0, 160)}`));
    await page.goto(`${ROOT_URL}/?${sessionQuery(['quality=low'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(SAMPLER);
    if (STALL_MS > 0) {
      console.log(`  ** host-stall rig: freezing the main thread ${STALL_MS}ms out of every ${STALL_EVERY_MS}ms **`);
      await page.evaluate(([ms, every]) => {
        window.__rs.stallTimer = setInterval(() => {
          const until = performance.now() + ms;
          while (performance.now() < until) { /* the island build, without the island */ }
        }, every);
      }, [STALL_MS, STALL_EVERY_MS]);
    }
    await walkAbout(page, SECONDS * 1000);
    const r = await page.evaluate(() => {
      const a = window.__rs;
      clearInterval(a.timer);
      clearInterval(a.phase);
      if (a.stallTimer) clearInterval(a.stallTimer);
      window.__piratesBR.setRemoteInterpolation(true);
      const out = {
        ticks: a.ticks, err: a.err, elapsed: (performance.now() - a.started) / 1000,
        stats: window.__piratesBR.getRemoteInterpolationStats(), host: a.host, pop: {},
      };
      for (const [k, v] of Object.entries(a.pop)) {
        out.pop[k] = {
          samples: v.samples, moving: v.moving, snaps: v.snaps, teleports: v.teleports,
          ungradeable: v.ungradeable, stalled: v.stalled, worstStalledM: v.worstStalledM,
          bodySeconds: v.bodySeconds, worstM: v.worstM, worstPx: v.worstPx,
          meanSpeed: v.moving ? v.speedSum / v.moving : 0,
          unexplained: v.unexplained,
        };
      }
      return out;
    });
    await page.close();

    if (r.err) console.log(`  sampler error: ${r.err}`);
    console.log(`  ticks ${r.ticks} over ${f(r.elapsed, 1)}s = ${f(r.ticks / Math.max(1e-6, r.elapsed), 0)}Hz sampling`);
    const answersTotal = Object.values(r.stats.modes).reduce((a, b) => a + b, 0);
    const modeTotal = answersTotal || 1;
    console.log(`  buffer: delay ${f(r.stats.delayMs, 1)}ms  jitter ${f(r.stats.jitterMs, 1)}ms  `
      + `interval ${f(r.stats.intervalMs, 1)}ms  hard snaps ${r.stats.hardSnapsBack} back / ${r.stats.hardSnapsForward} forward  `
      + `starved ${(((modeTotal - r.stats.modes.interpolated) / modeTotal) * 100).toFixed(1)}%  `
      + `modes ${JSON.stringify(r.stats.modes)}`);

    // ── THE HOST-SPEED READING, before a single bar is applied ───────────────
    const h = r.host;
    const healthyShare = h.ticks > 0 ? h.healthyTicks / h.ticks : 0;
    const healthyAnswers = h.healthy.interpolated + h.healthy.extrapolated + h.healthy.held + h.healthy.empty;
    const stalledAnswers = h.stalled.interpolated + h.stalled.extrapolated + h.stalled.held + h.stalled.empty;
    console.log(`  host: ${h.stalls} stalls over ${STALL_GAP_MS}ms (${(h.stalledMs / 1000).toFixed(1)}s of the window, `
      + `worst gap ${h.worstGapMs.toFixed(0)}ms); ${(healthyShare * 100).toFixed(1)}% of ticks were feeding the `
      + `measurement (outside a stall and ${STALL_SETTLE_MS}ms of its wake)`);
    console.log(`  held answers by time since the last stall: `
      + `in-stall ${h.heldBy.inStall} of ${h.ticksBy.inStall} ticks, `
      + `0-100ms ${h.heldBy.ms0_100}/${h.ticksBy.ms0_100}, `
      + `100-300ms ${h.heldBy.ms100_300}/${h.ticksBy.ms100_300}, `
      + `300-900ms ${h.heldBy.ms300_900}/${h.ticksBy.ms300_900}, `
      + `settled ${h.heldBy.settled}/${h.ticksBy.settled}`);

    const line = (label, p) => {
      if (!p || p.moving === 0) { console.log(`  ${label.padEnd(24)} — no moving samples`); return null; }
      const rate = p.bodySeconds > 0 ? p.snaps / p.bodySeconds : 0;
      const p99 = pct(p.unexplained, 0.99) ?? 0;
      console.log(`  ${label.padEnd(24)} n=${String(p.moving).padStart(5)} at ${f(p.meanSpeed, 1)} m/s  `
        + `snaps ${f(rate, 2)}/body-s  p50 ${f(pct(p.unexplained, 0.5))}  p95 ${f(pct(p.unexplained, 0.95))}  `
        + `p99 ${f(p99)}m  worst ${f(p.worstM)}m = ${f(p.worstPx, 1)}px`
        + (p.teleports || p.ungradeable ? `  (${p.teleports} teleports, ${p.ungradeable} above ${MAX_GRADEABLE_SPEED_MPS} m/s, not graded)` : ''));
      return { rate, p99, moving: p.moving, worstM: p.worstM, worstPx: p.worstPx };
    };

    // Graded: bodies the buffer alone places. Reported but not graded: bodies
    // whose placement composes a per-frame transform (see the sampler).
    const populations = ['local-as-remote', 'remote-player', 'shark'];
    for (const name of ['deck-crew', 'swimmer']) {
      const off = r.pop[`off/${name}`];
      const on = r.pop[`on/${name}`];
      if (!off && !on) continue;
      console.log(`  ── ${name}: composes a per-frame transform, reported only ──`);
      line(`${name}  OFF`, off);
      line(`${name}  ON `, on);
    }
    let gradedMoving = 0;
    for (const name of populations) {
      const off = line(`${name}  OFF (dead-reckoned)`, r.pop[`off/${name}`]);
      const on = line(`${name}  ON  (buffered)`, r.pop[`on/${name}`]);
      if (!on || on.moving < 120) {
        console.log(`  (${name} not graded: ${on ? on.moving : 0} moving samples in the ON arm)`);
        continue;
      }
      gradedMoving += on.moving;
      const bar = BARS[name];
      if (bar) graded += 2;
      if (bar && on.rate > bar.rate) {
        failures.push(`${name}: the buffered path snaps ${f(on.rate, 2)} times a body-second (max ${bar.rate}) `
          + `— worst ${f(on.worstM)}m = ${f(on.worstPx, 1)}px`);
      }
      if (bar && on.p99 > bar.p99) {
        failures.push(`${name}: p99 unexplained step is ${f(on.p99)}m (max ${bar.p99}m)`);
      }
      // MUTATION PROOF, in the same run: a bar the replaced arithmetic clears is
      // not a bar. Only asserted when the OFF arm actually got a population.
      if (off && off.moving >= 100) {
        graded += 2;
        const ratio = off.p99 / Math.max(1e-9, on.p99);
        if (ratio < MIN_P99_IMPROVEMENT) {
          failures.push(`${name}: the buffer only improved p99 ${ratio.toFixed(1)}x over the arithmetic it replaced `
            + `(need ${MIN_P99_IMPROVEMENT}x) — OFF ${f(off.p99)}m, ON ${f(on.p99)}m in the same run`);
        }
        const beats = bar ? (off.rate > bar.rate || off.p99 > bar.p99) : ratio >= MIN_P99_IMPROVEMENT;
        if (!beats) {
          failures.push(`THE GATE CANNOT FAIL for ${name}: with the buffer OFF the drawn path still cleared the bar `
            + `(${f(off.rate, 2)}/body-s, p99 ${f(off.p99)}m) — either the lever is not wired or the bar is meaningless`);
        } else {
          console.log(`  ${''.padEnd(24)} → OFF fails the bar (${f(off.rate, 2)}/body-s, p99 ${f(off.p99)}m, `
            + `worst ${f(off.worstM)}m = ${f(off.worstPx, 1)}px); ON clears it. `
            + `p99 improved ${(off.p99 / Math.max(1e-9, on.p99)).toFixed(1)}x, worst ${(off.worstM / Math.max(1e-9, on.worstM)).toFixed(1)}x`);
        }
      } else {
        console.log(`  ${''.padEnd(24)} (mutation arm not graded: ${off ? off.moving : 0} moving samples with the buffer off)`);
      }
    }
    if (gradedMoving < MIN_MOVING_SAMPLES) {
      // A RUN THAT MEASURED NOTHING IS NOT A RUN THAT MEASURED A DEFECT, and
      // which of the two it is depends on WHY the samples are missing. A host
      // that spent the window stalling starved the sampler; that is a fact about
      // this machine and it is said, not failed on. A host that fed the sampler
      // and still produced no moving body is a broken rig, and that IS a failure.
      const why = `only ${gradedMoving} moving samples across graded populations (need ${MIN_MOVING_SAMPLES})`;
      if (healthyShare < MIN_HEALTHY_TICK_SHARE) {
        notGraded.push(`${why} — and only ${(healthyShare * 100).toFixed(1)}% of ticks were outside a stall `
          + `(floor ${(MIN_HEALTHY_TICK_SHARE * 100).toFixed(0)}%): this host could not feed the measurement`);
      } else {
        failures.push(`${why} — the run measured nothing, on a host that was ${(healthyShare * 100).toFixed(1)}% healthy`);
      }
    }
    // BACKWARD re-anchors only. A backward one moves the clock to an earlier
    // server time and redraws every remote body where it already was; nothing
    // legitimate does that. A FORWARD one is a data gap that has been survived —
    // this machine measures snapshot arrivals up to 2.1 SECONDS apart, because a
    // frame spent building an island cannot run the message callback, and after a
    // gap that long the world has genuinely moved on. Reported, not graded.
    // A COUNT, not a frame time: backend-independent and gradeable on any host
    // that got as far as buffering a body at all. Zero answers means the client
    // never connected, and "no backward re-anchors" is then vacuously true.
    if (answersTotal > 0) graded += 1;
    if (r.stats.hardSnapsBack > 0) {
      failures.push(`the remote render clock was re-anchored BACKWARDS ${r.stats.hardSnapsBack} times in ${SECONDS}s — `
        + `every one of those redraws every remote body where it already was`);
    }
    // STARVED MEANS 'held', NOT 'extrapolated', and the difference is the whole
    // design. Extrapolation from the newest real pair is the FALLBACK this was
    // built with, and on this rasteriser it is mostly a reading of the frame
    // loop: during a 1.4s island build the render clock parks a bounded distance
    // past its newest sample and every answer taken there is an extrapolated
    // one. Grading that would grade SwiftShader. `held` is the real thing —
    // the ring had nothing usable and the body stopped — and it is what a delay
    // sized too small for the wire actually produces.
    //
    // …AND IT IS GRADED ON THE ANSWERS THE HOST LET IT MEASURE. A stall does not
    // just make the client slow: it queues every snapshot that lands during it
    // and then delivers them in one burst, which evicts the span of history the
    // render clock is standing in and makes the buffer hold every body until the
    // clock walks forward again. Those answers say nothing about whether the
    // delay is buying a bracket, which is the only thing this bar is about. The
    // BAR IS UNCHANGED at 3%; what changed is that the denominator is now the
    // answers taken while the host was feeding the measurement.
    const held = healthyAnswers > 0 ? h.healthy.held / healthyAnswers : 0;
    const extrap = healthyAnswers > 0 ? h.healthy.extrapolated / healthyAnswers : 0;
    const heldAll = r.stats.modes.held / modeTotal;
    console.log(`  of the ${healthyAnswers} answers taken while the host was feeding: `
      + `two real samples ${(((healthyAnswers - h.healthy.held - h.healthy.extrapolated) / Math.max(1, healthyAnswers)) * 100).toFixed(1)}%, `
      + `carried forward ${(extrap * 100).toFixed(1)}%, held ${(held * 100).toFixed(1)}%`);
    console.log(`  (${stalledAnswers} more answers were taken inside a stall or its ${STALL_SETTLE_MS}ms wake: `
      + `${(((h.stalled.held) / Math.max(1, stalledAnswers)) * 100).toFixed(1)}% held there, `
      + `${(heldAll * 100).toFixed(1)}% held over the whole window — reported, not graded)`);
    if (healthyAnswers < MIN_HEALTHY_ANSWERS || healthyShare < MIN_HEALTHY_TICK_SHARE) {
      notGraded.push(`the held-answer bar: only ${healthyAnswers} answers (need ${MIN_HEALTHY_ANSWERS}) came from `
        + `${(healthyShare * 100).toFixed(1)}% of ticks outside a stall (floor ${(MIN_HEALTHY_TICK_SHARE * 100).toFixed(0)}%) — `
        + `${h.stalls} stalls, worst gap ${h.worstGapMs.toFixed(0)}ms. Held over the whole window was `
        + `${(heldAll * 100).toFixed(1)}%, which on this host is a reading of the rasteriser, not of the delay`);
    } else if (++graded && held > 0.03) {
      failures.push(`the buffer held a body still on ${(held * 100).toFixed(1)}% of the ${healthyAnswers} answers `
        + `taken while the host was feeding (max 3%) — `
        + `delay ${f(r.stats.delayMs, 1)}ms against a measured ${f(r.stats.intervalMs, 1)}ms interval `
        + `and ${f(r.stats.jitterMs, 1)}ms of jitter is not buying a bracket`);
    }
  } finally {
    await browser.close();
  }

  if (notGraded.length) {
    console.log('');
    for (const msg of notGraded) console.log(`NOT GRADED — ${msg}`);
  }
  // NOTHING SURVIVED. Exiting 0 here would be read as a pass by the runner, and
  // a suite that exits 0 having asserted nothing is the most expensive failure
  // mode this repo has. The sentinel line is the runner's SKIPPED channel
  // (scripts/run-all-tests.mjs), so the tally says NOT GRADED with the reason.
  if (graded === 0) {
    console.log(`\nSUITE-NOT-GRADED: this host could not feed the measurement — ${notGraded[0] ?? 'no gradeable population'}`);
    return;
  }
  if (failures.length === 0) {
    console.log(`\nPASS — remote bodies are drawn along a continuous path, and the arithmetic this replaced is not. `
      + `(${graded} bars graded${notGraded.length ? `, ${notGraded.length} not gradeable on this host` : ''})`);
    return;
  }
  console.log('');
  for (const msg of failures) console.log(`FAIL — ${msg}`);
  if (REPORT_ONLY) {
    console.log('(--report: not failing the run)');
    return;
  }
  process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
