#!/usr/bin/env node
/**
 * A SLOW CLIENT MUST NEVER BE REPORTED AS A SLOW SERVER.
 *
 * The HUD carries a SERVER OVERLOADED chip. It is a good chip: it exists because
 * a sim that falls behind its tick budget dilates time instead of dropping it, so
 * CPU starvation on the server looks from inside like a game where everything has
 * simply become heavy, and there was nothing anywhere that said otherwise.
 *
 * It is also an accusation, and it is pointed at somebody else's machine. If it
 * can be raised by the CLIENT being slow, then the one situation in which it will
 * be seen most — a weak machine, a heavy scene, a player who is already unhappy —
 * is the situation in which it is a lie, and it sends everyone hunting a server
 * fault that does not exist. That is what this suite is for.
 *
 * HOW THE DETECTOR IS SUPPOSED TO SURVIVE A SLOW CLIENT. It reads `serverTime`
 * off the snapshot stream and compares its advance against the wall clock. While
 * the client is frozen, snapshots keep arriving and the newest is kept (both the
 * socket worker and the rAF coalescer hold only the latest of each kind), so when
 * the client comes back `serverTime` has jumped forward by the length of the
 * freeze and the ratio reads ~1. The deficit is measured against `now` rather
 * than against the newest sample, on purpose, so that a server which has gone
 * silent altogether owes as much as one that is crawling — and THAT is the term
 * a slow client can inflate, because a client which cannot get round to applying
 * a snapshot looks, from inside that arithmetic, exactly like a server which
 * never sent one.
 *
 * SO THIS GATE MAKES THE CLIENT SLOW AND WATCHES THE CHIP. CPU throttling through
 * CDP is the right instrument: it does not touch the socket, the server or the
 * network, so anything the chip says under it is being said about a machine that
 * is demonstrably fine. `/health` is read on both sides of the window as the
 * independent witness — `worstSimLagSec` and `droppedTicks` come from the sim's
 * own bookkeeping and are what an honest chip would have to be agreeing with.
 *
 * FAILURE IS THE CHIP APPEARING while the server's own numbers say it is keeping
 * up. Passing needs both: the chip stayed down AND the server really was fine, so
 * a run where the server genuinely fell behind cannot be scored as a pass.
 *
 * Usage:
 *   node scripts/test-sim-lag-honesty.mjs
 *   node scripts/test-sim-lag-honesty.mjs --url http://127.0.0.1:3101 --server 8091
 *   node scripts/test-sim-lag-honesty.mjs --throttle 24 --stall 1800 --seconds 25
 *   node scripts/test-sim-lag-honesty.mjs --mutate            # must FAIL
 */
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT_URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const SERVER_PORT = arg('server', process.env.PIRATES_BR_SERVER_PORT ?? null);
const HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL
  ?? `http://127.0.0.1:${SERVER_PORT ?? '8090'}/health`;
/**
 * Enough to put frames well past the chip's own one-second trip threshold. On the
 * software rasteriser this scene already runs at ~9fps at this viewport, so 20x
 * makes a frame roughly two seconds — twice what the detector calls overloaded,
 * held for ten times its dwell. If the arithmetic can be fooled by client slowness
 * at all, it is fooled here.
 */
const THROTTLE = Number.parseInt(arg('throttle', '20'), 10);
/**
 * …and a synchronous burn inside every frame on top of it, because throttling
 * alone did not get there. CPU throttling stretches JS but leaves the rasteriser
 * where it was, and 20x measured a longest frame of 445ms — under the chip's own
 * 1s threshold, so the run proved nothing. This is the blunt instrument: a
 * busy-loop in the frame, which is exactly the shape of the thing being simulated
 * (a machine that cannot get round to the picture) and is not negotiable with.
 */
const STALL_MS = Number.parseInt(arg('stall', '1400'), 10);
const SECONDS = Number.parseInt(arg('seconds', '25'), 10);
/**
 * MUTATION PROOF (`--mutate`). A gate that asserts a NEGATIVE — that something did
 * not happen — is the easiest kind to pass by accident, so it has to be shown
 * failing. The mutation freezes the SIM clock while snapshots keep arriving: the
 * wall advances, `serverTime` does not, and the deficit climbs at one second per
 * second. That is precisely the condition the chip exists for — a sim dilating
 * under load — so this run must go red, and a build in which it does not has lost
 * the warning altogether.
 *
 * Green under a 1.8s frame and red under a frozen sim clock is the whole point:
 * the chip fires on the server's clock and on nothing else.
 */
const MUTATE = argv.includes('--mutate');
const VIEWPORT = { width: 480, height: 270 };

const sessionQuery = ['debug', ...(SERVER_PORT ? [`server=${SERVER_PORT}`] : []), 'quality=low'].join('&');

/** The sim's own account of itself, which the chip has to be agreeing with. */
async function readHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function main() {
  console.log(`sim-lag honesty — ${describeGl()}`);
  console.log(`  client ${ROOT_URL}${SERVER_PORT ? `  server :${SERVER_PORT}` : ''}  throttle ${THROTTLE}x + ${STALL_MS}ms/frame burn for ${SECONDS}s`);

  const before = await readHealth();
  if (!before) {
    console.log(`FAIL — no /health at ${HEALTH_URL}; without the server's own numbers this gate cannot tell a lie from a fact`);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const failures = [];
  let seen = { chipEverShown: false, worstLabel: null, samples: 0, worstFrameMs: 0 };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message.slice(0, 160)}`));
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${ROOT_URL}/?${sessionQuery}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    // Watch the chip from inside the page: it is a DOM element the HUD shows and
    // hides, so the only honest witness is the element's own display state,
    // sampled every frame for the whole window.
    await page.evaluate(() => {
      const w = window.__slh = { chipEverShown: false, worstLabel: null, samples: 0, worstFrameMs: 0, last: performance.now() };
      const tick = () => {
        const now = performance.now();
        w.worstFrameMs = Math.max(w.worstFrameMs, now - w.last);
        w.last = now;
        w.samples++;
        // display, and ONLY display. The chip is position:fixed, and offsetParent
        // is null for a fixed element by specification — a visibility check built
        // on it can never see the chip and this gate would pass by construction.
        const chip = document.getElementById('server-load-chip');
        if (chip && chip.style.display === 'block') {
          w.chipEverShown = true;
          w.worstLabel = chip.textContent;
        }
        w.raf = requestAnimationFrame(tick);
      };
      w.raf = requestAnimationFrame(tick);
    });

    if (MUTATE) {
      await page.evaluate(() => {
        const net = window.__piratesBR.network;
        const real = net.getServerClock.bind(net);
        let frozen = null;
        net.getServerClock = () => {
          const c = real();
          if (!c) return c;
          if (frozen === null) frozen = c.server;
          return { server: frozen, at: c.at };
        };
      });
      console.log('  --mutate: the sim clock is frozen while snapshots keep arriving; this run MUST fail');
    }
    await page.evaluate((ms) => {
      const w = window.__slh;
      w.burn = ms;
      const burner = () => {
        if (w.burn <= 0) return;
        const until = performance.now() + w.burn;
        while (performance.now() < until) { /* the machine has stopped answering */ }
        requestAnimationFrame(burner);
      };
      requestAnimationFrame(burner);
    }, STALL_MS);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.waitForTimeout(SECONDS * 1_000);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.evaluate(() => { window.__slh.burn = 0; });
    // Let the detector settle out of the throttle before reading it, so the run
    // grades the throttled window and not the recovery from it.
    await page.waitForTimeout(2_000);

    seen = await page.evaluate(() => {
      const w = window.__slh;
      cancelAnimationFrame(w.raf);
      return { chipEverShown: w.chipEverShown, worstLabel: w.worstLabel, samples: w.samples, worstFrameMs: w.worstFrameMs };
    });
    await page.close();
  } finally {
    await browser.close();
  }

  const after = await readHealth();
  const worstSim = after?.worstSimLagSec ?? null;
  const dropped = (after?.droppedTicks ?? 0) - (before?.droppedTicks ?? 0);
  console.log(`  frames in the window ${seen.samples}, longest ${seen.worstFrameMs.toFixed(0)}ms`);
  console.log(`  server: worstSimLagSec ${worstSim === null ? '--' : worstSim.toFixed(3)}s, droppedTicks +${dropped}`);
  console.log(`  chip: ${seen.chipEverShown ? `SHOWN — "${seen.worstLabel}"` : 'never shown'}`);

  if (seen.samples < 4) {
    failures.push(`only ${seen.samples} frames in the window — the throttle stopped the page instead of slowing it, and nothing was watched`);
  }
  if (seen.worstFrameMs < 1_000) {
    failures.push(`longest frame was ${seen.worstFrameMs.toFixed(0)}ms — under the chip's own 1s trip threshold, so this run never `
      + `put the detector under the condition it is being tested for`);
  }
  const serverWasFine = worstSim !== null && worstSim < 0.5 && dropped === 0;
  if (!serverWasFine) {
    failures.push(`the server itself fell behind during the window (worstSimLagSec ${worstSim === null ? '--' : worstSim.toFixed(3)}, `
      + `+${dropped} dropped ticks) — this run cannot say whether the chip was honest, only that it had a reason`);
  } else if (seen.chipEverShown) {
    failures.push(`SERVER OVERLOADED was raised by a slow CLIENT: the sim never lagged (worstSimLagSec ${worstSim.toFixed(3)}, `
      + `0 dropped ticks) and the chip said "${seen.worstLabel}"`);
  }

  if (failures.length === 0) {
    console.log('\nPASS — the client was made two seconds a frame and the chip stayed down, with the sim keeping perfect time.');
    return;
  }
  console.log('');
  for (const msg of failures) console.log(`FAIL — ${msg}`);
  process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
