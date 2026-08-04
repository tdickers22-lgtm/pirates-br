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
 *     p(t) = p_snapshot + v_snapshot × (t − t_snapshot)
 *
 * which is a ray. When the next snapshot arrives the ray is thrown away and a new
 * one starts from the new sample — and the new sample is NOT where the old ray had
 * got to, because the entity turned, or accelerated, or the packet was late. The
 * gap between the two is a position step in a single frame: a body that has been
 * gliding smoothly jumps, thirty-one times a second, by however much the server
 * disagreed with the guess. Carry reads 1.00 through all of it.
 *
 * HOW IT IS SAMPLED WITHOUT A FAST FRAME RATE. The render target is a pure
 * function of (world state, clock), and the world state advances on the WEBSOCKET
 * callback, not on the frame loop. So this does not sample once per drawn frame —
 * on SwiftShader that is 3-8Hz and could not see a 32ms event at all. It samples
 * on a ~4ms timer, ~250 times a second, calling the very function the renderer
 * calls. What comes back is the trajectory the renderer WOULD draw at any frame
 * rate, reconstructed at eight samples per snapshot interval, and it is exact:
 * nothing in it is a function of how fast this machine rasterises.
 *
 * THE METRIC. Between two consecutive samples dt apart, a body moving at `speed`
 * should advance `speed × dt`. Anything beyond that is a step the arithmetic put
 * in that the entity's own motion does not explain:
 *
 *     excess = |p[i] − p[i−1]| − speed × dt
 *
 * Reported in metres, and in PIXELS at the range the body was actually drawn (the
 * only unit in which "visible" means anything). A DISCONTINUITY is an excess over
 * DISCONTINUITY_M — 2cm, about a boot's width, and roughly the smallest step that
 * reads as a twitch rather than as motion at conversational range. The headline
 * number is discontinuities per body per second: how many times a second an
 * opponent you are looking at snaps.
 *
 * Steps over TELEPORT_M are counted separately and excluded from the excess
 * statistics: those are respawns, boardings and cannon launches, and they are
 * supposed to move a body a long way at once.
 *
 * POPULATIONS. Remote players (every bot, plus the local pirate routed down the
 * remote branch for the length of one evaluation — same trick and same reason as
 * test-motion-continuity.mjs: a bot match never produces a remote pirate on foot),
 * and sharks, whose hot payload carries no velocity at all and whose target is
 * therefore the raw snapshot position — a pure staircase.
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

/** A step this far beyond the body's own motion is a visible twitch. */
const DISCONTINUITY_M = 0.02;
/** …and this far is not a twitch, it is a teleport (respawn, board, launch). */
const TELEPORT_M = 2.0;
/** Below this speed the excess is division-by-noise and the body reads as still. */
const MOVING_SPEED_MPS = 1.5;

/**
 * THE TRIPWIRES. Set from the measured before/after in the commit that landed the
 * interpolation buffer; see the table in that message.
 *
 * A pure extrapolator on this bot fleet reads 20-30 snaps per body-second (it
 * corrects on essentially every snapshot that carries a turn) with a worst step in
 * the tens of centimetres. An interpolator that renders between two samples it
 * already holds cannot step at all except when the buffer starves, so the honest
 * bar is "almost never", not "less often".
 */
const MAX_SNAPS_PER_BODY_SECOND = 2.0;
const MAX_P99_EXCESS_M = 0.02;
/** A run that sampled almost nothing has not passed; it has failed to measure. */
const MIN_MOVING_SAMPLES = 2000;

const sessionQuery = (extra = []) => ['debug', ...(SERVER_PORT ? [`server=${SERVER_PORT}`] : []), ...extra].join('&');

/**
 * Installed in the page. One tick every ~4ms: for every remote body being drawn,
 * evaluate the render target and difference it against the previous evaluation.
 * Deliberately allocation-light — it runs 250 times a second beside the frame loop
 * it is measuring and must not be able to change what it measures.
 */
const SAMPLER = `(() => {
  const g = window.__piratesBR;
  const acc = {
    started: performance.now(), ticks: 0, err: null,
    // per-population: { samples, moving, excess[], snaps, teleports, worstM, worstPx, bodySeconds }
    pop: {},
    dts: [],
  };
  window.__rs = acc;
  const popOf = (name) => (acc.pop[name] ||= {
    samples: 0, moving: 0, excess: [], snaps: 0, teleports: 0,
    worstM: 0, worstPx: 0, bodySeconds: 0, speedSum: 0,
  });
  const prev = new Map(); // id -> { t, x, y, z }

  const tick = () => {
    try {
      const st = g.state;
      if (!st || st.phase !== 'playing') return;
      acc.ticks++;
      const now = performance.now();
      const cam = g.renderer.camera;
      const fovRad = (cam.fov * Math.PI) / 180;
      const pxPerRad = window.innerHeight / (2 * Math.tan(fovRad / 2));

      const record = (key, popName, x, y, z, speed) => {
        const pop = popOf(popName);
        pop.samples++;
        const was = prev.get(key);
        prev.set(key, { t: now, x, y, z });
        if (!was) return;
        const dt = (now - was.t) / 1000;
        if (dt <= 0 || dt > 0.05) return; // a stalled timer is not evidence
        if (speed < ${MOVING_SPEED_MPS}) return;
        pop.moving++;
        pop.bodySeconds += dt;
        pop.speedSum += speed;
        const step = Math.hypot(x - was.x, y - was.y, z - was.z);
        const excess = step - speed * dt;
        if (step > ${TELEPORT_M}) { pop.teleports++; return; }
        pop.excess.push(excess);
        if (excess > ${DISCONTINUITY_M}) pop.snaps++;
        if (excess > pop.worstM) {
          pop.worstM = excess;
          const dist = Math.max(1, Math.hypot(x - cam.position.x, z - cam.position.z));
          pop.worstPx = (excess / dist) * pxPerRad;
        }
      };

      // ── remote players ──────────────────────────────────────────────────
      const idSaved = g.localPlayerId;
      for (const p of st.players) {
        if (p.state !== 'alive' || p.cannonBallistic) continue;
        const speed = Math.hypot(p.velocity.x, p.velocity.z);
        const isLocal = p.id === idSaved;
        if (isLocal) g.localPlayerId = null;
        let q = null;
        try { q = g.getPlayerRenderPosition(p, 0.035); } finally { if (isLocal) g.localPlayerId = idSaved; }
        record('P' + p.id, isLocal ? 'local-as-remote' : 'remote-player', q.x, q.y, q.z, speed);
      }

      // ── sharks ──────────────────────────────────────────────────────────
      for (const s of st.sharks ?? []) {
        if (s.health <= 0) continue;
        const q = g.getSharkRenderPosition ? g.getSharkRenderPosition(s) : s.position;
        // Sharks are the population whose payload carries no velocity, so the
        // speed the excess is graded against has to be MEASURED off the samples
        // rather than read off the entity. A per-id EMA of the observed step rate
        // is the honest stand-in: it is what the body is actually doing.
        const key = 'S' + s.id;
        const was = prev.get(key);
        let speed = 0;
        if (was) {
          const dt = (now - was.t) / 1000;
          if (dt > 0 && dt < 0.05) {
            const inst = Math.hypot(q.x - was.x, q.z - was.z) / dt;
            const ema = (acc.sharkSpeed ||= new Map());
            const prevS = ema.get(key) ?? inst;
            // Slow EMA: a correction step must not be allowed to inflate the very
            // speed it is being graded against.
            const sp = prevS + (Math.min(inst, prevS * 3 + 1) - prevS) * 0.02;
            ema.set(key, sp);
            speed = sp;
          }
        }
        record(key, 'shark', q.x, q.y, q.z, speed);
      }
    } catch (e) {
      acc.err = String(e && e.message ? e.message : e);
    }
  };

  acc.timer = setInterval(tick, 0);
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
  console.log(`  client ${ROOT_URL}${SERVER_PORT ? `  server :${SERVER_PORT}` : ''}  window ${SECONDS}s`);

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
      const out = { ticks: a.ticks, err: a.err, elapsed: (performance.now() - a.started) / 1000, pop: {} };
      for (const [k, v] of Object.entries(a.pop)) {
        out.pop[k] = {
          samples: v.samples, moving: v.moving, snaps: v.snaps, teleports: v.teleports,
          bodySeconds: v.bodySeconds, worstM: v.worstM, worstPx: v.worstPx,
          meanSpeed: v.moving ? v.speedSum / v.moving : 0,
          excess: v.excess,
        };
      }
      return out;
    });
    await page.close();

    if (r.err) console.log(`  sampler error: ${r.err}`);
    console.log(`  ticks ${r.ticks} over ${f(r.elapsed, 1)}s = ${f(r.ticks / Math.max(1e-6, r.elapsed), 0)}Hz sampling`);

    const graded = ['remote-player', 'local-as-remote', 'shark'];
    let gradedMoving = 0;
    for (const name of graded) {
      const p = r.pop[name];
      if (!p) { console.log(`  ${name.padEnd(16)} — no samples`); continue; }
      const rate = p.bodySeconds > 0 ? p.snaps / p.bodySeconds : 0;
      console.log(`  ${name.padEnd(16)} moving ${String(p.moving).padStart(6)} samples over ${f(p.bodySeconds, 1)} body-seconds `
        + `at ${f(p.meanSpeed, 1)} m/s`);
      console.log(`  ${''.padEnd(16)} discontinuities ${p.snaps} = ${f(rate, 2)}/body-second   teleports ${p.teleports}`);
      console.log(`  ${''.padEnd(16)} excess step  p50 ${f(pct(p.excess, 0.5))}m  p95 ${f(pct(p.excess, 0.95))}m  `
        + `p99 ${f(pct(p.excess, 0.99))}m  worst ${f(p.worstM)}m = ${f(p.worstPx, 1)}px`);
    }

    for (const name of ['remote-player', 'local-as-remote', 'shark']) {
      const p = r.pop[name];
      if (!p || p.moving < 200) {
        console.log(`  (${name} not graded: ${p ? p.moving : 0} moving samples)`);
        continue;
      }
      gradedMoving += p.moving;
      const rate = p.bodySeconds > 0 ? p.snaps / p.bodySeconds : 0;
      const p99 = pct(p.excess, 0.99) ?? 0;
      if (rate > MAX_SNAPS_PER_BODY_SECOND) {
        failures.push(`${name}: the drawn path snaps ${f(rate, 2)} times a body-second (max ${MAX_SNAPS_PER_BODY_SECOND}) `
          + `— worst step ${f(p.worstM)}m = ${f(p.worstPx, 1)}px beyond the body's own motion`);
      }
      if (p99 > MAX_P99_EXCESS_M) {
        failures.push(`${name}: p99 step is ${f(p99)}m beyond the body's own motion (max ${MAX_P99_EXCESS_M}m)`);
      }
    }
    if (gradedMoving < MIN_MOVING_SAMPLES) {
      failures.push(`only ${gradedMoving} moving samples across graded populations (need ${MIN_MOVING_SAMPLES}) — the run measured nothing`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length === 0) {
    console.log('\nPASS — remote bodies are drawn along a continuous path.');
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
