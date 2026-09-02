#!/usr/bin/env node
// PROBE, not a gate: INPUT TO PIXEL — where the delay between pressing a key and the world moving actually goes.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
/**
 * INPUT TO PIXEL — where the delay between pressing a key and the world moving
 * actually goes.
 *
 * "It feels laggy" is not one number, it is a chain, and the chain has to be
 * taken apart before anyone can say which link to shorten. This probe splits a
 * movement press into the three that exist and times each of them:
 *
 *   press → wire     the keydown lands; the client sends it. THIS IS FRAME-BOUND.
 *                    Input is built and sent inside stepFrameCpu, so a press that
 *                    arrives just after a frame starts waits out that whole frame
 *                    before it is on the socket, however loudly it is flagged as
 *                    urgent (`hasForcedInput` forces a send THIS frame — it
 *                    cannot make the frame come sooner).
 *   wire → answer    the round trip: the server sees the input, moves the body,
 *                    and the first snapshot carrying that motion is applied here.
 *   press → picture  the whole thing, ending when the local pirate's rendered
 *                    position has actually moved a hand's breadth.
 *
 * WHAT LOOK COSTS, separately, because it is the one that must be zero: yaw and
 * pitch are read straight off the input layer by the camera every frame
 * (`this.input.getYaw()`), so a mouse move is on the screen in the next frame
 * with nothing on the wire in between. This probe checks that claim rather than
 * repeating it.
 *
 * MILLISECONDS HERE ARE ADVISORY, and on the software rasteriser they are mostly
 * a measurement of the frame length — which is the finding, not a flaw in the
 * measurement: the press→wire link IS a frame, so a client at three frames a
 * second has a third of a second of input delay before the network is involved
 * at all. What is NOT advisory is the SHAPE: which link owns the time, and
 * whether the local pirate moves before or after the server answers. The second
 * of those is the question of whether this client predicts, and it is answered
 * by comparing press→picture against wire→answer, not by reading either alone.
 *
 * Reports; it does not gate. There is no threshold here that would mean the same
 * thing on this machine and on a GPU.
 *
 * Usage:
 *   node scripts/input-latency-probe.mjs
 *   node scripts/input-latency-probe.mjs --url http://127.0.0.1:3101 --server 8091 --presses 12
 */
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT_URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const SERVER_PORT = arg('server', process.env.PIRATES_BR_SERVER_PORT ?? null);
const PRESSES = Number.parseInt(arg('presses', '10'), 10);
const VIEWPORT = { width: 480, height: 270 };

const sessionQuery = ['debug', ...(SERVER_PORT ? [`server=${SERVER_PORT}`] : []), 'quality=low'].join('&');

/**
 * Taps the three points the chain passes through, from inside the page.
 *
 * The keydown listener is registered in the CAPTURE phase on window, which is
 * the earliest point in the page any script can see the event — before the
 * input layer's own handler, so `press` is the press and not the press plus
 * whatever ran first.
 */
const INSTALL = `(() => {
  const g = window.__piratesBR;
  const s = window.__il = { press: 0, wire: 0, answer: 0, picture: 0, rows: [], frames: 0, look: [] };

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'w' || s.press) return;
    s.press = performance.now();
    s.wire = 0; s.answer = 0; s.picture = 0;
    const me = g.state && g.state.players.find((p) => p.id === g.localPlayerId);
    s.from = me ? { x: me.position.x, z: me.position.z } : null;
    const mesh = g.playerMeshes.get(g.localPlayerId);
    s.drawnFrom = mesh ? { x: mesh.position.x, z: mesh.position.z } : null;
  }, true);

  const send = g.network.sendInput.bind(g.network);
  g.network.sendInput = (input) => {
    if (s.press && !s.wire && input.forward) s.wire = performance.now();
    return send(input);
  };

  const watch = () => {
    s.frames++;
    if (s.press) {
      const me = g.state && g.state.players.find((p) => p.id === g.localPlayerId);
      if (me && !s.answer && Math.hypot(me.velocity.x, me.velocity.z) > 0.6) s.answer = performance.now();
      const mesh = g.playerMeshes.get(g.localPlayerId);
      if (mesh && s.drawnFrom && !s.picture
        && Math.hypot(mesh.position.x - s.drawnFrom.x, mesh.position.z - s.drawnFrom.z) > 0.2) {
        s.picture = performance.now();
      }
      if (s.answer && s.picture) {
        s.rows.push({
          wire: s.wire - s.press,
          answer: s.answer - s.press,
          picture: s.picture - s.press,
          predicted: s.picture < s.answer,
        });
        s.press = 0;
      }
    }
    s.raf = requestAnimationFrame(watch);
  };
  s.raf = requestAnimationFrame(watch);

  // LOOK, on its own. Record the camera's yaw before and after a synthetic mouse
  // move and count the frames it took to show up.
  window.__ilLook = () => {
    const before = g.input.getYaw();
    return { before, frames: s.frames };
  };
  window.__ilLookAfter = (before, frames) => ({
    moved: Math.abs(g.input.getYaw() - before) > 1e-4,
    framesTaken: s.frames - frames,
  });
})()`;

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const f = (v, d = 0) => (v === null || v === undefined ? '--' : v.toFixed(d));

async function main() {
  console.log(`input latency — ${describeGl()}`);
  console.log(`  client ${ROOT_URL}${SERVER_PORT ? `  server :${SERVER_PORT}` : ''}  presses ${PRESSES}`);
  const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message.slice(0, 160)}`));
    await page.goto(`${ROOT_URL}/?${sessionQuery}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', undefined, { timeout: 180_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(INSTALL);

    for (let i = 0; i < PRESSES; i++) {
      await page.keyboard.down(i % 2 ? 's' : 'w');
      await page.waitForTimeout(1_200);
      await page.keyboard.up(i % 2 ? 's' : 'w');
      await page.waitForTimeout(800);
    }
    // Look: one mouse move, then count the frames before the camera yaw follows.
    // Look has to be forced open: the handler ignores every mousemove unless the
    // pointer is LOCKED, and a headless page is never granted the lock. Only the
    // lock flag is forced — the event, the handler and the camera path are the
    // real ones, and in a real session the browser sets exactly this flag.
    const look = await page.evaluate(() => {
      window.__piratesBR.input.locked = true;
      return window.__ilLook();
    });
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 60, movementY: 0 }));
    });
    await page.waitForTimeout(600);
    const lookAfter = await page.evaluate(([b, fr]) => window.__ilLookAfter(b, fr), [look.before, look.frames]);

    const out = await page.evaluate(() => {
      const s = window.__il;
      cancelAnimationFrame(s.raf);
      return { rows: s.rows, frames: s.frames };
    });
    await page.close();

    const rows = out.rows;
    if (rows.length === 0) {
      console.log('  no completed presses — the run measured nothing');
      process.exitCode = 1;
      return;
    }
    const col = (k) => rows.map((r) => r[k]);
    console.log(`  completed presses ${rows.length}`);
    console.log(`  press -> wire    median ${f(pct(col('wire'), 0.5))}ms  p95 ${f(pct(col('wire'), 0.95))}ms   (frame-bound)`);
    console.log(`  press -> answer  median ${f(pct(col('answer'), 0.5))}ms  p95 ${f(pct(col('answer'), 0.95))}ms   `
      + `(round trip, quantised by a frame at BOTH ends — the send waits for one and the snapshot is applied in one)`);
    console.log(`  press -> picture median ${f(pct(col('picture'), 0.5))}ms  p95 ${f(pct(col('picture'), 0.95))}ms`);
    const predicted = rows.filter((r) => r.predicted).length;
    console.log(`  picture moved BEFORE the server answered: ${predicted}/${rows.length} presses`
      + ` — the lead terms in getPlayerRenderPosition, which are what this client has instead of prediction`);
    console.log(`  look (mouse -> yaw): ${lookAfter.moved ? `followed within ${lookAfter.framesTaken} frame(s), nothing on the wire` : 'DID NOT FOLLOW — investigate'}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
