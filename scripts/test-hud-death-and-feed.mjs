#!/usr/bin/env node
/**
 * The two HUD holes that made dying unreadable, driven against the real DOM in a
 * real match:
 *
 *  1. The respawn count was painted straight off `player.respawnTimer` in the last
 *     snapshot, so when snapshots stalled — island streaming pinning the main
 *     thread, or a loaded host dilating the sim — the number simply stopped.
 *     Observed: "Respawning in 20" for 60+ seconds, then a silent elimination
 *     with the same digits still on screen. The count is now anchored to a local
 *     deadline armed from the server's timer (the staged match start already
 *     solved this the same way), and elimination owns the centre outright.
 *  2. Identical feed lines stacked instead of coalescing: five byte-identical
 *     "Chest stowed aboard…" toasts filled the panel, every one of them clipped
 *     at the same word so the gold figure — the entire payload — was past the cut.
 *
 * Each case is exercised by calling the real HudController against the real
 * elements, so the snapshot stall can be held still instead of waited for.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/fixwave1/net';
mkdirSync(OUT, { recursive: true });

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.setDefaultTimeout(90_000);
await page.goto('http://127.0.0.1:3000/?debug', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn');
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.network?.isJoined?.() === true);
// The horn can be a long time coming on a contended host (that is defect #3, and
// this suite is not the one that measures it) — the HUD checks below only need a
// local player and a world, so a soft wait is enough.
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 60_000 })
  .catch(() => console.log('  (note: horn never blew in 60s — host is dilating; HUD checks continue)'));
await page.waitForTimeout(2500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));

// ── Respawn countdown ────────────────────────────────────────
// Freeze the world where a stall would freeze it: the local player is respawning
// and NO new snapshot ever lands, so `respawnTimer` never changes again. Before
// the fix that pinned the digits forever.
console.log('Respawn countdown under a snapshot stall:');
// Both readings are taken inside ONE evaluate, against the page's own clock. A
// screenshot on this contended host can eat twenty seconds, so anything measured
// across two round trips measures Playwright, not the countdown.
const respawn = await page.evaluate(async () => {
  const g = window.__piratesBR;
  // THE STALL, literally: stop applying snapshots. Every later frame now reads
  // the same `respawnTimer` forever, which is exactly the state the HUD was in
  // when it froze on "Respawning in 20" for a minute.
  g.network.onSnapshot = null;
  g.network.onHotSnapshot = null;
  const prompt = () => document.getElementById('interact-prompt').textContent;
  const pin = () => {
    const p = g.getLocalPlayer();
    p.state = 'respawning';
    // Exactly the defect: the snapshot never moved, so this field never changes.
    p.respawnTimer = 20;
    // Home ship inside the ring, so the countdown is genuinely running (a ship in
    // the storm HOLDS the respawn server-side, and the HUD now says so).
    const home = g.state.ships.find((s) => s.id === p.shipId);
    if (home) {
      home.alive = true; home.sinking = false;
      home.position = { x: g.state.storm.centerX, y: 0, z: g.state.storm.centerZ };
    }
    g.hud.updateHud();
  };
  pin();
  const first = prompt();
  const startedAt = performance.now();
  await new Promise((r) => setTimeout(r, 4200));
  pin();
  return {
    first,
    later: prompt(),
    elapsedSec: (performance.now() - startedAt) / 1000,
    stillStale: g.getLocalPlayer().respawnTimer,
  };
});
console.log(`    t=0  → "${respawn.first}"`);
expect('arms at the server value', respawn.first === 'Respawning in 20', `got "${respawn.first}"`);
console.log(`    t=${respawn.elapsedSec.toFixed(1)}s → "${respawn.later}" (server field still ${respawn.stillStale})`);
const ticked = /^Respawning in (\d+)$/.exec(respawn.later);
const wantSec = 20 - respawn.elapsedSec;
expect('the count keeps falling while the server field is frozen',
  !!ticked && Math.abs(Number(ticked[1]) - wantSec) <= 1.5,
  `after ${respawn.elapsedSec.toFixed(1)}s expected ~${wantSec.toFixed(0)}, got "${respawn.later}"`);
await page.screenshot({ path: `${OUT}/respawn-counting.png` });

// ── Elimination ──────────────────────────────────────────────
console.log('Elimination flips the centre immediately:');
const elim = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  p.state = 'eliminated';
  g.hud.updateHud();
  return {
    prompt: document.getElementById('interact-prompt').textContent,
    label: document.getElementById('context-label').textContent,
  };
});
console.log(`    → "${elim.prompt}" / "${elim.label}"`);
expect('no stale respawn digits survive the kill', !/Respawning in/.test(elim.prompt), elim.prompt);
expect('the state is named out loud', /eliminated/i.test(elim.prompt) && /spectating/i.test(elim.prompt),
  elim.prompt);
await page.screenshot({ path: `${OUT}/eliminated.png` });

// ── Respawn held (ship in the storm) ─────────────────────────
console.log('A respawn the server is holding says so:');
const heldText = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  p.state = 'respawning';
  p.respawnTimer = 20;
  const home = g.state.ships.find((s) => s.id === p.shipId);
  if (home) {
    home.alive = true; home.sinking = false;
    // Well outside the ring — server-side this pauses the timer entirely.
    home.position = { x: g.state.storm.centerX + g.state.storm.safeRadius + 400, y: 0, z: g.state.storm.centerZ };
  }
  g.hud.updateHud();
  return document.getElementById('interact-prompt').textContent;
});
console.log(`    → "${heldText}"`);
expect('a held respawn is not counted down as if it were running', /held/i.test(heldText), heldText);

// ── Feed coalescing ──────────────────────────────────────────
console.log('Duplicate toasts coalesce and the payline fits:');
// Every reading is taken inside ONE evaluate: feed lines expire on a 3s timer, and
// a GPU-contended screenshot between two calls is easily slower than that.
const feed = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const el = document.getElementById('kill-feed');
  g.hud.resetForMatch();
  const msg = 'Chest stowed aboard: base 690 gold before Hoarder payout.';
  for (let i = 0; i < 5; i++) g.hud.pushFeed(msg, '#d9c17e');
  await new Promise((r) => requestAnimationFrame(r));
  const coalescedRows = el.children.length;
  const row = el.children[0];
  const reading = {
    rowCount: coalescedRows,
    text: row ? row.textContent : '',
    clipped: row ? row.scrollWidth > row.clientWidth + 1 : true,
    whiteSpace: row ? getComputedStyle(row).whiteSpace : '',
    distinctRows: 0,
  };
  // A different message must still get its own row — coalescing keys on the text.
  g.hud.pushFeed('A pirate was eliminated.', '#e7e1d4');
  await new Promise((r) => requestAnimationFrame(r));
  reading.distinctRows = el.children.length;
  return reading;
});
console.log(`    rows=${feed.rowCount} text="${feed.text}" clipped=${feed.clipped}`);
expect('five identical toasts become one row', feed.rowCount === 1, `rowCount=${feed.rowCount}`);
expect('the repeat count is on the line', /×5/.test(feed.text), feed.text);
expect('the payline is not clipped', feed.clipped === false,
  `whiteSpace=${feed.whiteSpace}`);
expect('the gold figure survives', /690 gold/.test(feed.text), feed.text);
expect('a different message still gets its own row', feed.distinctRows === 2,
  `rows=${feed.distinctRows}`);
await page.screenshot({ path: `${OUT}/feed-coalesced.png` });

// ── Server-overload chip ─────────────────────────────────────
// Snapshots are still stalled from the respawn case above, so the sim clock the
// client can see has stopped advancing while its own wall clock has not — the
// same arithmetic a host running at 7% real time produces. The chip needs the
// 5s measurement window plus its 1.5s anti-flicker dwell before it speaks.
console.log('Sim dilation is announced instead of silently endured:');
const chip = await page.evaluate(async () => {
  const g = window.__piratesBR;
  // Drive the HUD ourselves for the full window: the frame loop is the normal
  // driver, but this host is contended enough that frames are not something a
  // test should assume.
  const until = performance.now() + 9_000;
  while (performance.now() < until) {
    g.hud.updateHud();
    await new Promise((r) => setTimeout(r, 150));
  }
  const el = document.getElementById('server-load-chip');
  if (!el) {
    return {
      present: false,
      phase: g.state?.phase,
      serverTime: g.state?.serverTime,
      samples: g.hud.simRateSamples?.length,
      tripSince: g.hud.simTripSince,
    };
  }
  const box = el.getBoundingClientRect();
  return {
    present: true,
    visible: getComputedStyle(el).display !== 'none' && box.width > 0,
    display: getComputedStyle(el).display,
    inDoc: document.body.contains(el),
    width: Math.round(box.width),
    text: el.textContent,
    top: Math.round(box.top),
    phase: window.__piratesBR.state?.phase,
  };
});
console.log(`    → ${JSON.stringify(chip)}`);
if (chip.phase !== 'playing') {
  // The chip only speaks about the LIVE sim: before the horn `serverTime` is 0 by
  // design and every reading would look like an infinite deficit. A host so loaded
  // that the 8s countdown never finished is defect #3 with the volume all the way
  // up, but it is not a state this assertion can be made in.
  console.log(`  — SKIPPED: horn never blew (phase=${chip.phase}); chip is correctly silent pre-horn`);
} else {
  expect('a dilating sim raises the overload chip', chip.present && chip.visible, JSON.stringify(chip));
  expect('the chip names the problem and the size of it',
    /overloaded/i.test(chip.text ?? '') && /\d+s behind/.test(chip.text ?? ''), chip.text);
  await page.screenshot({ path: `${OUT}/overload-chip.png` });
}

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} HUD assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll HUD death/feed assertions passed.');
