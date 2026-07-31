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

const OUT = process.argv[2] ?? 'test-results/endgame-onboard-keys';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal', '--enable-gpu',
    // A headless Chromium that dies must not put a macOS crash dialog on the
    // user's screen — this rig runs while he is at the machine.
    '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
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
await wait(3000);

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
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }));
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', key: 'l', bubbles: true })), 70);
});
await wait(600);
const byKey = await read();
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
await page.click('#legend-howto-btn');
await wait(500);
const back = await read();
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
// Give the auto-open its whole window: it fires off the HUD frame loop once the
// start ceremony is done, so a short wait here would prove nothing.
await wait(9000);
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
await wait(9000);
const third = await read();
ok('a reloaded profile does NOT re-deal the tour', third.cardsOpen === false, JSON.stringify(third));
await shot('7-after-reload-no-tour');

// …but the door is still open. A one-shot tutorial you can never get back is
// what this whole slice exists to undo.
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }));
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', key: 'l', bubbles: true })), 70);
});
await wait(600);
await page.click('#legend-howto-btn');
await wait(500);
const reopened = await read();
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
