// PROBE, not a gate: The two gaps in (h) that the wired suites do not cover as a PLAYER does them: * test-onboarding-ux proves the 'How to Play' door works, but it open...
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// The two gaps in (h) that the wired suites do not cover as a PLAYER does them:
//
//   * test-onboarding-ux proves the 'How to Play' door works, but it opens the
//     legend by setting style.display itself. Nothing proves the [L] KEY opens
//     the card the chip advertises.
//   * killwave-integration-smoke deals the tour to the end with Next. Nothing
//     asserts SKIP closes it.
//
// So: a first-ever join, SKIP the tour, press [L], click the door, and confirm
// the tour comes back at card one.
//
//   node scripts/endgame-onboard-keys.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/endgame-onboard-keys';
mkdirSync(OUT, { recursive: true });
console.log(`GL backend: ${describeGl()}`);
const browser = await chromium.launch({ args: browserArgs() });
// Every assertion in this rig is on the DOM, so the viewport only has to be big
// enough to lay the cards out — and on the software rasteriser a smaller frame is
// the difference between a probe that finishes and one that has to be killed.
const page = await browser.newPage({
  viewport: IS_SOFTWARE_GL ? { width: 960, height: 540 } : { width: 1280, height: 720 },
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// A throw anywhere below this line used to leave a headless Chromium running: the
// only `browser.close()` is the last statement, so any failed assertion, timeout or
// Ctrl-C abandoned the process. On the machine this is developed on an orphaned
// GPU-backed browser is not a tidiness problem — two of them have frozen the
// desktop outright — so the close is bound to every way this script can end.
const closeBrowser = () => browser.close().catch(() => { /* already gone */ });
process.on('exit', () => { closeBrowser(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { closeBrowser().finally(() => process.exit(130)); });
}
for (const fault of ['uncaughtException', 'unhandledRejection']) {
  process.on(fault, (err) => {
    console.error(`\n${fault}: ${err?.stack ?? err}`);
    closeBrowser().finally(() => process.exit(1));
  });
}
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.evaluate(() => { try { localStorage.removeItem('piratesBR.seenControls'); } catch { /* private mode */ } });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await afterCeremony('on the first-ever join');

const read = () => page.evaluate(() => {
  const cards = document.getElementById('onboard-cards');
  const legend = document.getElementById('controls-hint');
  return {
    cardsOpen: !!cards?.classList.contains('visible'),
    cardTitle: document.getElementById('oc-title')?.textContent ?? '',
    dotOn: [...document.querySelectorAll('#oc-dots .oc-dot')].findIndex((d) => d.classList.contains('on')),
    legendOpen: legend ? getComputedStyle(legend).display === 'block' : false,
    chip: document.getElementById('controls-toggle')?.textContent ?? '',
  };
});

/**
 * Wait for the moment the tour is ALLOWED to open, then a few frames past it.
 *
 * HudController.maybeAutoOpenLegend refuses to deal the cards while
 * `startCeremonyActive` is true — the opening horn owns the screen and a tutorial
 * card on top of it is exactly the wall this slice removed. So "has the tour
 * opened?" is only a real question after the ceremony, and the probe used to ask
 * it after a flat 3000 ms instead. On the GPU that sleep outlasts the ceremony
 * and the check happens to be right; on the software rasteriser, where one frame
 * can cost six seconds, 3000 ms does not even buy a whole frame and the check
 * fails against a game that is behaving perfectly.
 *
 * This matters MORE for the negative assertions than the positive one. "A second
 * voyage does not re-deal the tour" passes trivially if nothing has had a chance
 * to deal it — a vacuous pass is worse than a flake, because it never complains.
 * Waiting on the ceremony flag and then spending real frames means the auto-open
 * genuinely had its opportunity and genuinely declined to take it.
 *
 * WHERE THE FLAG ACTUALLY LIVES. `startCeremonyActive` is a getter on the HudView
 * object Game hands the HUD, NOT on the Game instance `window.__piratesBR` points
 * at — so the first cut of this gate read `undefined`, never matched `=== false`,
 * and burned its whole 120 s budget three times over on a game that had rung the
 * horn a minute earlier. It failed LOUDLY, which is the only reason it is being
 * fixed rather than believed. The reading now goes through the two hooks that do
 * exist — `isStartCeremonyActive()` (private to TypeScript, plain callable at
 * runtime) and the `match-ceremony` body class the ceremony puts on the document
 * — and if NEITHER resolves, the gate says so on the first frame instead of
 * sleeping for two minutes to say it.
 */
async function afterCeremony(what, { extraFrames = 6, giveUpMs = 60_000 } = {}) {
  const out = await page.evaluate(async ({ extraFrames, giveUpMs }) => {
    const start = performance.now();
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // true / false / null, where null means "no hook answered" — a probe fault,
    // not a game state, and worth saying immediately.
    const readCeremony = () => {
      const g = window.__piratesBR;
      if (g && typeof g.isStartCeremonyActive === 'function') return g.isStartCeremonyActive();
      if (typeof g?.startCeremonyActive === 'boolean') return g.startCeremonyActive;
      if (document.body.classList.contains('match-ceremony')) return true;
      // The class is only present DURING the ceremony, so its absence is a real
      // answer once the match is up — but only if the game handle is there at all.
      return g ? false : null;
    };
    if (readCeremony() === null) {
      return { ready: false, reason: 'no ceremony hook on window.__piratesBR', waitedMs: 0, framesAfter: 0 };
    }
    let ceremonyEndedAt = null;
    let frames = 0;
    while (performance.now() - start < giveUpMs) {
      await frame();
      frames += 1;
      const g = window.__piratesBR;
      if (g && g.state?.phase === 'playing' && readCeremony() === false) {
        if (ceremonyEndedAt === null) { ceremonyEndedAt = performance.now(); frames = 0; }
        // Spend real frames AFTER the gate opens: maybeAutoOpenLegend runs in the
        // HUD pass, so the cards need frames, not milliseconds, to appear.
        if (frames >= extraFrames) {
          return { ready: true, waitedMs: Math.round(performance.now() - start), framesAfter: frames };
        }
      }
    }
    return {
      ready: false,
      waitedMs: Math.round(performance.now() - start),
      framesAfter: frames,
      ceremony: readCeremony(),
      phase: window.__piratesBR?.state?.phase ?? 'unknown',
    };
  }, { extraFrames, giveUpMs });
  console.log(`  · ceremony over ${what}: ${JSON.stringify(out)}`);
  if (!out.ready) ok(`the start ceremony ends ${what}`, false, JSON.stringify(out));
  return out;
}

// Wait until the match is a match, not a start ceremony — and note that a fixed
// sleep here is not a slow assertion, it is a WRONG one. The legend card is
// DESIGNED to stand down while the player is doing the thing it teaches:
// HudController.updateLegendCard closes it the moment `onShipId` changes
// ("boarded"), and the opening ceremony is precisely when that field is still
// moving. Press [L] into that window and the card opens on one frame and is
// correctly shut on the next, so the probe photographs a closed legend and blames
// the key binding for a feature working as written.
//
// This gate therefore asks TWO questions, and neither of them is "is the machine
// fast".
//
// The first version asked for eight consecutive frames inside a fixed 400 ms and
// then, on software GL, simply burned its whole timeout and carried on — a
// sixty-second sleep wearing a check's clothes. Raising the budget to 1600 ms
// only moved the lie: the cold first match still throws 4972 ms frames often
// enough to keep resetting the streak, so the gate reported "not settled" for a
// world that was perfectly ready. Both readings were noise about the RASTERISER.
// A software rasteriser IS slow; that is not a defect and it is not what this
// probe is here to find. Widening the number again would only have hidden it a
// third time.
//
// So the speed threshold is gone. What actually has to be true before [L] is
// pressed is: (a) the frame loop is ALIVE, because the toggle is consumed inside
// it and a key pressed into a dead loop is never seen; and (b) the boarding
// state has stopped moving, because HudController.updateLegendCard deliberately
// shuts the card the moment `onShipId` changes, and the opening ceremony is
// exactly when it does. Liveness plus stability. Frame times are still reported,
// as diagnostics, so a genuinely stalled client is legible in the output — but
// nothing is graded against them.
async function settle(what, { holdMs = 1400, needFrames = 8, giveUpMs = 45_000 } = {}) {
  const out = await page.evaluate(async ({ holdMs, needFrames, giveUpMs }) => {
    const start = performance.now();
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let frames = 0;
    let prev = start;
    let worst = 0;
    let lastShip = Symbol('unset');
    let stableSince = start;
    while (performance.now() - start < giveUpMs) {
      await frame();
      const now = performance.now();
      worst = Math.max(worst, now - prev);
      prev = now;
      frames += 1;
      const me = window.__piratesBR?.getLocalPlayer?.() ?? null;
      const ship = me?.onShipId ?? null;
      // A pirate at a STATION is the other way the card legitimately shuts:
      // updateLegendCard closes it outright at the wheel, on a gun or up the
      // mast, because there it covers the very thing it explains. An idle probe
      // drifts, and pressing [L] into that state photographs a correct HUD and
      // calls it a broken key binding.
      const stationed = !!me && (me.atHelm || me.atCannon || me.atCrowNest || me.mastClimb !== null);
      if (ship !== lastShip || stationed) { lastShip = ship; stableSince = now; }
      if (!stationed && frames >= needFrames && now - stableSince >= holdMs) {
        return { settled: true, waitedMs: Math.round(now - start), frames, worstFrameMs: Math.round(worst), onShipId: ship };
      }
    }
    return {
      settled: false,
      waitedMs: Math.round(performance.now() - start),
      frames,
      worstFrameMs: Math.round(worst),
      onShipId: typeof lastShip === 'symbol' ? null : lastShip,
    };
  }, { holdMs, needFrames, giveUpMs });
  console.log(`  · settled ${what}: ${JSON.stringify(out)}`);
  // A gate that gives up is not a gate. Failing to see eight frames in 45 s means
  // the client is genuinely wedged, and that is worth a failed check, not a shrug.
  if (!out.settled) ok(`the world settles ${what}`, false, JSON.stringify(out));
  return out;
}

/**
 * Press [L] and WAIT for the card, instead of sampling 600 ms later and calling
 * the sample the answer.
 *
 * A second press is allowed, and only under one condition: the card is still
 * CLOSED. A toggle that was eaten before the frame loop consumed it leaves the
 * card exactly as it was, so pressing again cannot double-toggle anything —
 * whereas pressing again over an OPEN card would shut the thing being asserted.
 * That is why the retry re-reads the DOM instead of trusting a timeout.
 */
async function pressLegend(timeoutMs = 20_000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }));
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', key: 'l', bubbles: true })), 70);
    });
    const opened = await page.waitForFunction(() => {
      const legend = document.getElementById('controls-hint');
      return !!legend && getComputedStyle(legend).display === 'block';
    }, null, { timeout: timeoutMs }).then(() => true).catch(() => false);
    if (opened) return read();
    const state = await read();
    if (state.legendOpen) return state;
    console.log(`  · [L] did not land (attempt ${attempt + 1}) — pressing once more`);
  }
  return read();
}

/**
 * Click the door in the [L] card's footer — but only once the card is on screen.
 *
 * Clicking it blind is how a run died: the press before it had not landed, the
 * button existed but was inside a hidden card, and Playwright spent thirty
 * seconds waiting for a button that was never going to be visible before
 * throwing out of the whole probe. A missing card is a CHECK, with the state
 * that explains it, not an exception four assertions early.
 */
async function openTourFromLegendDoor() {
  const before = await read();
  ok('the [L] card is on screen before its door is clicked', before.legendOpen === true, JSON.stringify(before));
  if (!before.legendOpen) return before;
  await page.click('#legend-howto-btn');
  await wait(500);
  return read();
}

console.log('\nA first voyage, then the way back in:');
const opened = await read();
ok('the tour opens itself on a first-ever join', opened.cardsOpen && /sail/i.test(opened.cardTitle), JSON.stringify(opened));
await shot('1-tour-open');

// SKIP, the way a player who wants the sea does it.
await page.click('#oc-skip');
await wait(400);
const skipped = await read();
ok('SKIP closes the tour outright', skipped.cardsOpen === false, JSON.stringify(skipped));
ok('and skipping does NOT dump the fourteen-line legend instead', skipped.legendOpen === false, `legendOpen=${skipped.legendOpen}`);
await shot('2-after-skip');

// The [L] KEY — the binding the chip advertises.
await settle('before the first [L]');
const byKey = await pressLegend();
ok('the [L] key really opens the controls card the chip promises',
  byKey.legendOpen === true, JSON.stringify(byKey));
await shot('3-legend-by-L-key');

// …and the footer door on that card deals the tour again, from card one.
const door = await page.evaluate(() => {
  const btn = document.getElementById('legend-howto-btn');
  const r = btn?.getBoundingClientRect();
  return { present: !!btn, label: btn?.textContent ?? '', w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
});
ok("the card carries a visible 'How to Play' door", door.present && door.w > 20 && door.h > 8 && /how to play/i.test(door.label), JSON.stringify(door));
const back = await openTourFromLegendDoor();
ok('clicking it re-deals the tour at card one',
  back.cardsOpen === true && back.dotOn === 0 && /sail/i.test(back.cardTitle), JSON.stringify(back));
await shot('4-tour-reopened-from-footer');

// And Next still advances after a reopen (the tour is not a spent shell).
await page.click('#oc-next');
await wait(400);
const advanced = await read();
ok('NEXT still advances the re-dealt tour', advanced.cardsOpen === true && advanced.dotOn === 1, JSON.stringify(advanced));
await shot('5-second-card');

// ── A SECOND VOYAGE MUST NOT RE-TEACH THE FIRST ──────────────────────────────
// The fresh-eyes audit rejoined and got the three cards dealt at it again. The
// flag that stops that is `piratesBR.seenControls`, written the instant the
// tour opens ITSELF — so it must survive both a same-page rematch and a full
// page reload, and neither may re-deal the tour.
console.log('\nA second voyage on the same profile:');
await page.click('#oc-skip').catch(() => {});
await wait(300);

const flagAfterFirst = await page.evaluate(() => {
  try { return localStorage.getItem('piratesBR.seenControls'); } catch { return 'THREW'; }
});
ok('the first voyage persists a seen-the-tour flag', flagAfterFirst === '1', `piratesBR.seenControls=${flagAfterFirst}`);

// Back to port, then straight out again — the rematch a player actually does.
await page.evaluate(() => window.__piratesBR.goBackToMenuFromMatch());
await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 30_000 });
await wait(800);
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await afterCeremony('on the same-page rematch');
const second = await read();
ok('a same-page rematch does NOT re-deal the tour', second.cardsOpen === false, JSON.stringify(second));
ok('and it does not fall back to dumping the legend either', second.legendOpen === false, `legendOpen=${second.legendOpen}`);
await shot('6-second-match-no-tour');

// The reload is the real test of the flag: a fresh HudController, a fresh
// everything, with only localStorage carrying the memory across.
console.log('\nA third voyage after a full reload (the flag alone remembers):');
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
const flagSurvived = await page.evaluate(() => {
  try { return localStorage.getItem('piratesBR.seenControls'); } catch { return 'THREW'; }
});
ok('the flag survives a page reload', flagSurvived === '1', `piratesBR.seenControls=${flagSurvived}`);
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await afterCeremony('after the reload');
const third = await read();
ok('a reloaded profile does NOT re-deal the tour', third.cardsOpen === false, JSON.stringify(third));
await shot('7-after-reload-no-tour');

// …but the door is still open. A one-shot tutorial you can never get back is
// what this whole slice exists to undo.
await settle('before the veteran re-deal');
await pressLegend();
const reopened = await openTourFromLegendDoor();
ok('and a veteran can still re-deal it from the [L] card forever',
  reopened.cardsOpen === true && reopened.dotOn === 0, JSON.stringify(reopened));
await shot('8-veteran-reopen');
await page.click('#oc-skip').catch(() => {});
await wait(300);

// ── ONE END SCREEN, NOT TWO STACKED ──────────────────────────────────────────
// The audit photographed DEFEATED sitting on top of a still-visible SHIP SUNK,
// each with its own RETURN TO PORT, one of them unclickable behind the other.
// Raise the elimination card, then hand the match-end card the fleet, and count
// what is on screen and how many RETURN buttons a mouse could actually hit.
console.log('\nThe end of the match is ONE card:');
const rows = Array.from({ length: 10 }, (_, i) => ({
  placement: i + 1,
  name: i === 5 ? 'You' : `Crew ${i + 1}`,
  kills: 10 - i, deaths: i, gold: (10 - i) * 400,
  you: i === 5, winner: i === 0, bot: i !== 5, alive: i < 2,
}));
const stacked = await page.evaluate((boardRows) => {
  const g = window.__piratesBR;
  // The elimination card, exactly as a sinking raises it.
  const death = document.getElementById('death-screen');
  death.style.display = 'flex';
  death.classList.add('visible');
  document.body.classList.add('showing-death-screen');
  // …and then the match ends under it.
  g.menu.showEndmatch({
    isWinner: false,
    title: 'DEFEATED',
    subtitle: 'The Reach belongs to another crew.',
    standing: 'Place: #6 of 10',
    rows: boardRows,
  });
  const shown = (id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 && r.width > 4 && r.height > 4;
  };
  // A button only counts if a click at its centre would land ON it.
  const clickable = ['death-return-btn', 'win-return-btn', 'endmatch-return-btn'].filter((id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  return {
    death: shown('death-screen'),
    win: shown('win-screen'),
    endmatch: shown('endmatch-screen'),
    bodyClass: document.body.classList.contains('showing-death-screen'),
    clickable,
    boardRows: document.querySelectorAll('#endmatch-board .board-row:not(.head)').length,
    standing: document.getElementById('endmatch-standing')?.textContent ?? '',
  };
}, rows);
ok('the match-end card DISMISSES the elimination card instead of landing on it',
  stacked.endmatch === true && stacked.death === false && stacked.win === false, JSON.stringify(stacked));
ok('exactly ONE reachable RETURN TO PORT button is on screen',
  stacked.clickable.length === 1 && stacked.clickable[0] === 'endmatch-return-btn', JSON.stringify(stacked.clickable));
ok('and the HUD-hiding body class goes with it',
  stacked.bodyClass === false, `showing-death-screen=${stacked.bodyClass}`);
ok('the board lists the whole fleet, not one row',
  stacked.boardRows === 10, `rows=${stacked.boardRows}`);
ok('with a standing line saying where the voyage put you',
  /#6\s*of\s*10/i.test(stacked.standing), `standing="${stacked.standing}"`);
await shot('9-one-end-card');

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 3).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
process.exit(failed.length ? 1 : 0);
