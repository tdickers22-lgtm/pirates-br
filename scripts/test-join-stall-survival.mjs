#!/usr/bin/env node
/**
 * A pinned main thread must never read to the server as a dead player.
 *
 * THE DEFECT. Loading into a match pins the client's main thread — the join
 * snapshot builds the whole world, and islands keep streaming in for tens of
 * seconds after. Two things stop happening while it is pinned, and both look
 * exactly like death from the server's side:
 *   1. the heartbeat timer (`ping` every 3s) never fires;
 *   2. Chromium's WebSocket applies receive backpressure, so a renderer that is
 *      not draining `onmessage` makes the network service stop reading the TCP
 *      socket — inbound frames including the server's ws PING are never parsed,
 *      so the "automatic" pong never goes out either. A live match pushes ~31 hot
 *      snapshots a second, so the pipe fills in well under a second of stall.
 * The server's silence sweep then terminates the socket: `[Net] Disconnected
 * (code 1006)`, match channel shut, reload the only way back. Reproduced twice in
 * the wild, and measured joins of 5.9s (prod) to 63.6s (dev under contention).
 *
 * THE FIX. The socket now lives in a Web Worker (src/client/network/
 * socket.worker.ts), so the beat comes from a thread that cannot be pinned and the
 * same thread drains the socket continuously, which keeps the flow-control pipe
 * from ever backing up.
 *
 * THE TEST. One bundle, one server, one stall length — the only variable is where
 * the socket lives. NO_WORKER makes `new Worker` throw, which drops the client
 * onto its pre-fix main-thread path, so the control arm is the actual old code
 * rather than an impression of it.
 *
 * Requires the dev stack up: vite on 3000, game server on 8090. NEVER 8080 — this
 * machine's content filter corrupts every websocket on that port.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/fixwave1/net';
mkdirSync(OUT, { recursive: true });

/** Stall length. Past HEARTBEAT_TIMEOUT_MS (15s) with room to spare. */
const STALL_MS = 25_000;
/**
 * Settle time before the stall. Must exceed LobbyServer's MATCH_BUILD_WINDOW_MS so
 * the session is held to the ordinary HEARTBEAT_TIMEOUT_MS rather than the much
 * larger world-build grace — otherwise the grace, not the worker, is what saves
 * the control arm and the test proves nothing. Keep in step with that constant.
 */
const SETTLE_MS = 95_000;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

async function runArm({ tag, noWorker }) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.setDefaultTimeout(120_000);
  if (noWorker) {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        get() { throw new Error('Worker disabled by probe'); },
      });
    });
  }
  try {
    await page.goto('http://127.0.0.1:3000/?debug', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn');
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.network?.isJoined?.() === true);
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing');
    console.log(`  [${tag}] in the match; settling ${SETTLE_MS / 1000}s to clear the build-grace window`);
    await page.waitForTimeout(SETTLE_MS);

    // The world-build freeze, distilled: a synchronous busy-loop. No timer fires,
    // no socket message is consumed, nothing on the page runs.
    console.log(`  [${tag}] pinning the main thread for ${STALL_MS / 1000}s`);
    await page.evaluate((ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { Math.sqrt(Math.random()); }
    }, STALL_MS);

    // Two passes of the server's 5s sweep, so its verdict is on the record.
    await page.waitForTimeout(7_000);
    const verdict = await page.evaluate(() => {
      const g = window.__piratesBR;
      return {
        connected: !!g?.network?.isConnected?.(),
        joined: !!g?.network?.isJoined?.(),
        phase: g?.state?.phase ?? null,
      };
    });
    await page.screenshot({ path: `${OUT}/stall-${tag}.png` });
    const disconnects = logs.filter((l) => /\[Net\] Disconnected/.test(l));
    // Survival means the MATCH survived: a client bounced back to the menu with a
    // fresh socket has still lost the round.
    const survived = disconnects.length === 0 && verdict.connected && verdict.joined && verdict.phase !== null;
    console.log(`  [${tag}] ${survived ? 'SURVIVED' : 'DIED'} — ${JSON.stringify(verdict)} closes=${JSON.stringify(disconnects)}`);
    return { survived, verdict, disconnects };
  } finally {
    await browser.close();
  }
}

console.log(`A 25s main-thread stall, ${SETTLE_MS / 1000}s after join:`);

console.log('\nControl arm — socket on the main thread (pre-fix path):');
const control = await runArm({ tag: 'A-noworker', noWorker: true });

console.log('\nFixed arm — socket owned by the worker:');
const fixed = await runArm({ tag: 'B-worker', noWorker: false });

console.log('\nVerdict:');
expect('a worker-owned socket survives a 25s main-thread stall mid-match',
  fixed.survived, JSON.stringify(fixed));
expect('the surviving client is still in ITS match, not a fresh session',
  fixed.verdict.joined && fixed.verdict.phase === 'playing', JSON.stringify(fixed.verdict));

if (control.survived) {
  // Not a failure: a server configured with a very long grace window can carry the
  // old path too. Say so out loud rather than banking a green that proved nothing.
  console.log('  — INCONCLUSIVE CONTROL: the main-thread path also survived, so this run'
    + ' did not exercise the sweep. Check that SETTLE_MS still exceeds'
    + ' LobbyServer.MATCH_BUILD_WINDOW_MS.');
} else {
  console.log(`  ✓ control confirms the defect is real (${control.disconnects.join(', ') || 'session lost'})`);
}

if (failures > 0) {
  console.error(`\n${failures} join-stall assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll join-stall survival assertions passed.');
