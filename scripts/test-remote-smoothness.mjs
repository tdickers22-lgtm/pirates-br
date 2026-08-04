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
const VIEWPORT = { width: 480, height: 270 };

/** A step this far beyond carrying on at the current speed is a visible twitch. */
const DISCONTINUITY_M = 0.02;
/** …and this far is not a twitch, it is a teleport (respawn, board, launch). */
const TELEPORT_M = 2.0;
/** Below this the body reads as still and the statistic is division by noise. */
const MOVING_SPEED_MPS = 1.0;
/** How long each arm runs before the lever flips. Long enough to hold a walking
 *  leg inside one arm, short enough that ten of them fit in a minute. */
const PHASE_MS = 4500;

/**
 * THE TRIPWIRES, set from the measured OFF arm (see the commit that landed the
 * buffer). The OFF arm on this bot fleet reads ~5 unexplained steps per body-
 * second with a p99 in the tens of centimetres; the ON arm reads a body's own
 * acceleration over 9ms, which is millimetres.
 */
const MAX_SNAPS_PER_BODY_SECOND = 1.0;
const MAX_P99_UNEXPLAINED_M = 0.02;
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
      samples: 0, moving: 0, unexplained: [], snaps: 0, teleports: 0,
      worstM: 0, worstPx: 0, bodySeconds: 0, speedSum: 0,
    });
  };
  // id -> { t, x, y, z, v }  — v is the speed over the PREVIOUS interval, which
  // is what the next step is predicted from.
  const prev = new Map();

  const record = (arm, popName, key, x, y, z, now, pxPerRad, cam) => {
    const pop = popOf(arm, popName);
    pop.samples++;
    const was = prev.get(key);
    prev.set(key, { t: now, x, y, z, v: was ? was.vNext : null, vNext: null });
    const cur = prev.get(key);
    if (!was) return;
    const dt = (now - was.t) / 1000;
    if (dt <= 0 || dt > 0.05) return; // a stalled timer is not evidence
    const step = Math.hypot(x - was.x, y - was.y, z - was.z);
    cur.vNext = step / dt;
    if (was.v === null) return;              // need two intervals to predict one
    if (was.v < ${MOVING_SPEED_MPS}) return; // a body at rest cannot be graded
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
      const arm = g.getRemoteInterpolationStats().enabled ? 'on' : 'off';
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
        record(arm, isLocal ? 'local-as-remote' : 'remote-player', 'P' + p.id, q.x, q.y, q.z, now, pxPerRad, cam);
      }

      // ── sharks ──────────────────────────────────────────────────────────
      for (const s of st.sharks ?? []) {
        if (s.health <= 0) continue;
        const q = g.getSharkRenderPosition(s);
        record(arm, 'shark', 'K' + s.id, q.x, q.y, q.z, now, pxPerRad, cam);
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
    await walkAbout(page, SECONDS * 1000);
    const r = await page.evaluate(() => {
      const a = window.__rs;
      clearInterval(a.timer);
      clearInterval(a.phase);
      window.__piratesBR.setRemoteInterpolation(true);
      const out = {
        ticks: a.ticks, err: a.err, elapsed: (performance.now() - a.started) / 1000,
        stats: window.__piratesBR.getRemoteInterpolationStats(), pop: {},
      };
      for (const [k, v] of Object.entries(a.pop)) {
        out.pop[k] = {
          samples: v.samples, moving: v.moving, snaps: v.snaps, teleports: v.teleports,
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
    console.log(`  buffer: delay ${f(r.stats.delayMs, 1)}ms  jitter ${f(r.stats.jitterMs, 1)}ms  `
      + `interval ${f(r.stats.intervalMs, 1)}ms  hard snaps ${r.stats.hardSnaps}  modes ${JSON.stringify(r.stats.modes)}`);

    const line = (label, p) => {
      if (!p || p.moving === 0) { console.log(`  ${label.padEnd(24)} — no moving samples`); return null; }
      const rate = p.bodySeconds > 0 ? p.snaps / p.bodySeconds : 0;
      const p99 = pct(p.unexplained, 0.99) ?? 0;
      console.log(`  ${label.padEnd(24)} n=${String(p.moving).padStart(5)} at ${f(p.meanSpeed, 1)} m/s  `
        + `snaps ${f(rate, 2)}/body-s  p50 ${f(pct(p.unexplained, 0.5))}  p95 ${f(pct(p.unexplained, 0.95))}  `
        + `p99 ${f(p99)}m  worst ${f(p.worstM)}m = ${f(p.worstPx, 1)}px`);
      return { rate, p99, moving: p.moving, worstM: p.worstM, worstPx: p.worstPx };
    };

    const populations = ['local-as-remote', 'remote-player', 'shark'];
    let gradedMoving = 0;
    for (const name of populations) {
      const off = line(`${name}  OFF (dead-reckoned)`, r.pop[`off/${name}`]);
      const on = line(`${name}  ON  (buffered)`, r.pop[`on/${name}`]);
      if (!on || on.moving < 120) {
        console.log(`  (${name} not graded: ${on ? on.moving : 0} moving samples in the ON arm)`);
        continue;
      }
      gradedMoving += on.moving;
      if (on.rate > MAX_SNAPS_PER_BODY_SECOND) {
        failures.push(`${name}: the buffered path snaps ${f(on.rate, 2)} times a body-second (max ${MAX_SNAPS_PER_BODY_SECOND}) `
          + `— worst ${f(on.worstM)}m = ${f(on.worstPx, 1)}px`);
      }
      if (on.p99 > MAX_P99_UNEXPLAINED_M) {
        failures.push(`${name}: p99 unexplained step is ${f(on.p99)}m (max ${MAX_P99_UNEXPLAINED_M}m)`);
      }
      // MUTATION PROOF, in the same run: a bar the replaced arithmetic clears is
      // not a bar. Only asserted when the OFF arm actually got a population.
      if (off && off.moving >= 120) {
        const beats = off.rate > MAX_SNAPS_PER_BODY_SECOND || off.p99 > MAX_P99_UNEXPLAINED_M;
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
      failures.push(`only ${gradedMoving} moving samples across graded populations (need ${MIN_MOVING_SAMPLES}) — the run measured nothing`);
    }
    if (r.stats.hardSnaps > 0) {
      failures.push(`the remote render clock was re-anchored ${r.stats.hardSnaps} times in ${SECONDS}s — `
        + `every one of those is every remote body teleporting at once`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length === 0) {
    console.log('\nPASS — remote bodies are drawn along a continuous path, and the arithmetic this replaced is not.');
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
