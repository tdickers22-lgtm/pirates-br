#!/usr/bin/env node
/**
 * WHAT A FIRST-TIME PIRATE IS TOLD — driven against the real DOM in a real match.
 *
 * Every case here is a line the game either never said or said wrongly:
 *
 *  1. [L] opened a full controls card that was advertised NOWHERE. There is now
 *     a chip beside the Battle Map header, and the card opens itself once on a
 *     player's first-ever voyage (localStorage, beside piratesBR.name).
 *  2. The whole kill-streak rewards table printed in BOTH always-on strips from
 *     second zero — a rules dump for a player with no kills who had not yet
 *     found their ship. The strips carry a compact badge; the table is legend
 *     material and a one-off feed line when a threshold actually lands.
 *  3. The ship panel gave ORDERS to a pirate standing on a beach ("hold [X] at
 *     the capstan") — where [X] digs, chops and opens chests instead. Ashore it
 *     reports state only.
 *  4. Wind read "Wind NW -> 138deg from starboard": two numbers, an ASCII arrow
 *     and nothing steerable. It is a sentence now, with a vane on the compass,
 *     and the numeric trim readout belongs to the helm.
 *  5. The death screen hardcoded "SHIP SUNK — Crew lost" for storm deaths,
 *     drownings and boarding kills alike.
 *  6. The menu had no how-to-play and never once stated the win condition.
 *  7. The horn now drops canvas to half on every hull — with the ANCHOR STILL
 *     DOWN, because an unanchored ship has no dock gangway (getShipGangwayPlan).
 *
 * node --import tsx scripts/test-onboarding-ux.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/onboarding-ux';
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
// Other agents editing this tree make vite full-reload the page mid-run, which
// wipes the match out from under us. Stub the HMR client so this tab never listens.
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
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 90_000 });

const menuHasCardsBtn = (ids) => ids.includes('howto-cards-btn');
/** Everything the three-card tour is showing right now. */
const readCard = (p) => p.evaluate(() => {
  const root = document.getElementById('onboard-cards');
  const dots = [...document.querySelectorAll('#oc-dots .oc-dot')];
  return {
    open: !!root?.classList.contains('visible'),
    title: document.getElementById('oc-title')?.textContent ?? '',
    body: document.getElementById('oc-body')?.textContent ?? '',
    paragraphs: document.querySelectorAll('#oc-body p').length,
    dots: dots.length,
    dotOn: dots.findIndex((d) => d.classList.contains('on')),
    next: document.getElementById('oc-next')?.textContent ?? '',
  };
});

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
// A FIRST-EVER VOYAGE: drop the onboarding flag so the auto-open path is real.
await page.evaluate(() => { localStorage.removeItem('piratesBR.seenControls'); });

// ── Menu: How to Play + the win condition ────────────────────
console.log('\nThe menu says how to win:');
await shot('01-menu');
const menuBtns = await page.evaluate(() =>
  [...document.querySelectorAll('#menu-panel-main .menu-btn')].map((b) => b.id));
expect('the main panel offers How to Play', menuBtns.includes('menu-howto-btn'), menuBtns.join(','));

await page.click('#menu-howto-btn');
const howto = await page.evaluate(() => {
  const panel = document.getElementById('menu-panel-howto');
  return {
    visible: panel?.classList.contains('visible'),
    mainHidden: !document.getElementById('menu-panel-main')?.classList.contains('visible'),
    text: panel?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    controlsCloned: (document.getElementById('howto-controls')?.textContent ?? '').length,
  };
});
await shot('02-menu-how-to-play');
expect('How to Play opens over the main panel', howto.visible && howto.mainHidden, JSON.stringify(howto));
expect('the gold win condition is stated', /9,?000\s*gold/i.test(howto.text), howto.text.slice(0, 240));
expect('the last-crew-standing win condition is stated', /last crew afloat/i.test(howto.text), howto.text.slice(0, 240));
expect('the controls card is mirrored in, not re-typed', howto.controlsCloned > 200 && /WASD/.test(howto.text),
  `clonedChars=${howto.controlsCloned}`);

// ── The three cards, on demand, from the menu ────────────────
// Onboarding used to be the whole legend card dumped once per BROWSER, forever,
// at the second the horn went. It is three cards now, and this is one of the
// two doors back to them.
console.log('\nThe three-card tour:');
expect('How to Play offers the card tour', menuHasCardsBtn(await page.evaluate(() =>
  [...document.querySelectorAll('#menu-panel-howto .menu-btn')].map((b) => b.id))));
await page.click('#howto-cards-btn');
const card1 = await readCard(page);
await shot('02b-cards-1-sail');
expect('card one is open and is about sailing', card1.open && /sail/i.test(card1.title), JSON.stringify(card1));
expect('card one carries copy, not a wall', card1.paragraphs >= 2 && card1.paragraphs <= 4, `${card1.paragraphs} lines`);
expect('three dots, the first lit', card1.dots === 3 && card1.dotOn === 0, JSON.stringify(card1));
await page.click('#oc-next');
const card2 = await readCard(page);
await shot('02c-cards-2-fight');
expect('card two is about fighting', /fight/i.test(card2.title), card2.title);
expect('the dots track the tour', card2.dotOn === 1, JSON.stringify(card2));
await page.click('#oc-next');
const card3 = await readCard(page);
await shot('02d-cards-3-win');
expect('card three is about winning', /win/i.test(card3.title), card3.title);
expect('card three states both win conditions',
  /9,?000/.test(card3.body) && /last crew afloat/i.test(card3.body), card3.body.slice(0, 200));
expect('the last card sends you to sea instead of saying Next',
  /set sail/i.test(card3.next), card3.next);
await page.click('#oc-next');
expect('finishing the tour closes it', !(await readCard(page)).open);
// Skip works from card one.
await page.click('#howto-cards-btn');
await page.click('#oc-skip');
expect('Skip closes it too', !(await readCard(page)).open);
await page.click('#howto-back-btn');

// ── Into a match ─────────────────────────────────────────────
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.waitForTimeout(1200);

console.log('\nSpawn HUD:');
const spawn = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  const ship = g.state.ships.find((s) => s.id === p.shipId);
  const t = (id) => document.getElementById(id)?.textContent ?? '';
  const legend = document.getElementById('controls-hint');
  return {
    anchored: ship?.anchored,
    shipType: ship?.type,
    sailHeight: ship?.sailHeight,
    legendOpen: legend ? getComputedStyle(legend).display === 'block' : false,
    cardsOpen: !!document.getElementById('onboard-cards')?.classList.contains('visible'),
    cardTitle: document.getElementById('oc-title')?.textContent ?? '',
    chip: t('controls-toggle'),
    chipVisible: !!document.getElementById('controls-toggle')?.getBoundingClientRect().width,
    pocketStrip: t('pocket-strip'),
    brProgress: t('br-progress-feed'),
    sailStatus: t('sail-status'),
    vaneText: t('wind-vane-text'),
    vaneArrow: document.getElementById('wind-vane-arrow')?.style.transform ?? '',
  };
});
console.log(`    strip:  "${spawn.pocketStrip}"`);
console.log(`    progress: "${spawn.brProgress}"`);
console.log(`    ship panel: "${spawn.sailStatus}"`);
await shot('03-spawn-hud-legend-open');

expect('an [L] chip advertises the controls card', /\[L\]/.test(spawn.chip) && spawn.chipVisible, spawn.chip);
// A FIRST VOYAGE GETS THE CARDS, NOT THE WALL. This assertion used to demand
// the 14-line legend open itself over the horn; that was the defect.
expect('the three cards open themselves on a first-ever voyage',
  spawn.cardsOpen === true && /sail/i.test(spawn.cardTitle), JSON.stringify({ o: spawn.cardsOpen, t: spawn.cardTitle }));
expect('and the fourteen-line wall does NOT dump itself on top of the horn',
  spawn.legendOpen === false, `legendOpen=${spawn.legendOpen}`);
// A LONE PIRATE SAILS A CUTTER. The spawn table rolls three hull classes for the
// world's variety; a solo crew handed a Man-o'-War inherits eight guns nobody
// can man and the worst turn rate in the Reach.
expect('a solo crew is berthed on a sloop', spawn.shipType === 'sloop', `type=${spawn.shipType}`);
expect('the powers table is gone from the pocket strip',
  !/super cannonball|mega keg|tsunami/i.test(spawn.pocketStrip), spawn.pocketStrip);
expect('the pocket strip carries the compact badge instead',
  /Streak \d+\/\d+ ⚡/.test(spawn.pocketStrip), spawn.pocketStrip);
expect('the powers table is gone from the progress feed',
  !/super cannonball|mega keg|tsunami/i.test(spawn.brProgress), spawn.brProgress);
expect('the progress feed carries the compact badge too',
  /Streak \d+\/\d+ ⚡/.test(spawn.brProgress), spawn.brProgress);

// Carry-forward: canvas set at the horn, anchor still down (gangway survives).
expect('the horn pre-hoists canvas to ~50%', Math.abs((spawn.sailHeight ?? 0) - 0.5) < 0.001,
  `sailHeight=${spawn.sailHeight}`);
expect('and the anchor stays DOWN so the dock gangway survives', spawn.anchored === true,
  `anchored=${spawn.anchored}`);

// Wind, in words.
expect('the wind line is a sentence, not a bearing dump',
  /Wind (dead ahead|astern|on the (port|starboard) (bow|beam|quarter))/.test(spawn.sailStatus), spawn.sailStatus);
expect('no ASCII arrows or raw degrees survive in the wind line',
  !/->|<-|deg/.test(spawn.sailStatus), spawn.sailStatus);
// …and the nautical phrase carries its own translation. "On the port quarter"
// is in voice and, at minute zero, is four words that mean nothing.
expect('port and starboard are glossed in plain hands',
  /dead ahead|from (behind|your (left|right)|ahead-(left|right)|behind-(left|right))/.test(spawn.sailStatus),
  spawn.sailStatus);
expect('a vane rides the compass strip', spawn.vaneText.length > 0 && /rotate\(/.test(spawn.vaneArrow),
  `text="${spawn.vaneText}" arrow="${spawn.vaneArrow}"`);

// The AUTO-open is ONCE, EVER: re-arm the per-session latch and confirm the
// persisted flag (not the latch) is what keeps the tour shut.
const secondPass = await page.evaluate(() => {
  const g = window.__piratesBR;
  document.getElementById('onboard-cards').classList.remove('visible');
  document.getElementById('controls-hint').style.display = 'none';
  g.hud.legendAutoOpenChecked = false;
  g.hud.maybeAutoOpenLegend();
  return {
    reopened: document.getElementById('onboard-cards').classList.contains('visible'),
    legendDumped: getComputedStyle(document.getElementById('controls-hint')).display === 'block',
    flag: localStorage.getItem('piratesBR.seenControls'),
  };
});
expect('a second voyage does not reopen it',
  secondPass.reopened === false && secondPass.legendDumped === false && secondPass.flag === '1',
  JSON.stringify(secondPass));

// ── …but it is re-openable FOREVER, from inside the match ────
// The old onboarding was a one-shot with no door back to it: a player who
// blinked never learned there were two ways to win.
console.log('\nThe way back in, mid-voyage:');
const reopened = await page.evaluate(async () => {
  const legend = document.getElementById('controls-hint');
  legend.style.display = 'block';
  const btn = document.getElementById('legend-howto-btn');
  const rect = btn?.getBoundingClientRect();
  btn?.click();
  await new Promise((r) => requestAnimationFrame(r));
  return {
    hasButton: !!btn,
    clickable: !!rect && rect.width > 20 && getComputedStyle(btn).pointerEvents !== 'none',
    label: btn?.textContent ?? '',
    open: !!document.getElementById('onboard-cards')?.classList.contains('visible'),
    title: document.getElementById('oc-title')?.textContent ?? '',
  };
});
await shot('03b-legend-footer-reopen');
expect("the [L] card carries a 'How to Play' door", reopened.hasButton && /how to play/i.test(reopened.label),
  reopened.label);
expect('and it is actually clickable through the legend overlay', reopened.clickable, JSON.stringify(reopened));
expect('it re-opens the tour at card one', reopened.open && /sail/i.test(reopened.title), JSON.stringify(reopened));
await page.evaluate(() => {
  document.getElementById('onboard-cards').classList.remove('visible');
  document.getElementById('controls-hint').style.display = 'none';
});

// ── Every key the game reads is on the card ──────────────────
// The legend omitted Q, C and B outright. This audits the LEGEND against the
// INPUT MANAGER: a binding the code reads but the card never mentions fails
// here, including bindings added after this was written.
console.log('\nThe legend against the real bindings:');
const legendText = await page.evaluate(() =>
  (document.getElementById('controls-hint')?.textContent ?? '').replace(/\s+/g, ' '));
const INPUT_SRC = readFileSync(new URL('../src/client/input/InputManager.ts', import.meta.url), 'utf8');
const GAME_SRC = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
const codes = new Set([
  ...INPUT_SRC.matchAll(/'(Key[A-Z]|Space|Digit[1-9]|Shift(?:Left|Right)|Arrow(?:Up|Down|Left|Right))'/g),
].map((m) => m[1]));
// Keys handled by Game rather than InputManager (map, bug snap, close).
for (const m of GAME_SRC.matchAll(/code === '(Key[A-Z]|F\d|Escape)'/g)) codes.add(m[1]);
/** What the legend must say for each binding the code reads. */
const LEGEND_TOKENS = {
  KeyW: /WASD/, KeyA: /WASD/, KeyS: /WASD/, KeyD: /WASD/,
  // The arrows steer a pirate exactly as WASD does, and "WASD · Move" is not a
  // mention of them — the card has to say so in its own words.
  ArrowUp: /arrow keys/i, ArrowDown: /arrow keys/i, ArrowLeft: /arrow keys/i, ArrowRight: /arrow keys/i,
  Space: /SPACE/i,
  KeyZ: /\bZ · /, KeyC: /\bC · /, KeyX: /\bX · /, KeyB: /\bB · /, KeyE: /\bE · /,
  KeyR: /\bR · /, KeyG: /\bG · /, KeyT: /\bT · /, KeyP: /\bP · /, KeyM: /\bM · /,
  KeyL: /\bL · /, KeyI: /Hold I · /, KeyQ: /Q\/F|Q flips/, KeyF: /Q\/F/,
  ShiftLeft: /SHIFT/, ShiftRight: /SHIFT/,
  Digit1: /1–4/, Digit2: /1–4/, Digit3: /1–4/, Digit4: /1–4/,
  Digit5: /5\/6\/7/, Digit6: /5\/6\/7/, Digit7: /5\/6\/7/,
  Digit8: /1–9/, Digit9: /1–9/,
  F8: /F8/, Escape: /Esc/i,
};
const unknown = [...codes].filter((c) => !(c in LEGEND_TOKENS));
expect('no binding exists that this audit has never heard of', unknown.length === 0,
  `add these to LEGEND_TOKENS: ${unknown.join(', ')}`);
const missing = [...codes].filter((c) => LEGEND_TOKENS[c] && !LEGEND_TOKENS[c].test(legendText));
expect('every key the game reads is named on the legend card', missing.length === 0,
  `missing: ${missing.join(', ')}\n     legend: ${legendText.slice(0, 400)}`);

// ── Ship panel: orders only where they can be obeyed ─────────
console.log('\nShip panel ashore vs aboard:');
const stage = (which) => page.evaluate((w) => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  const ship = g.state.ships.find((s) => s.id === p.shipId);
  // A breach is open for the ashore/aboard passes so the leak line is exercised.
  // Re-punched per stage: a snapshot landing between two stages restores the
  // server's (sound) hull, so staging it once is not enough.
  const breach = () => [{ id: 1, localX: 0, localY: 0, localZ: 0, size: 1, plugged: false, repairProgress: 0 }];
  if (w === 'ashore') { p.onShipId = null; p.atHelm = false; ship.anchored = true; ship.holes = breach(); }
  if (w === 'aboard') { p.onShipId = ship.id; p.atHelm = false; ship.anchored = true; ship.holes = breach(); }
  if (w === 'helm') { p.onShipId = ship.id; p.atHelm = true; ship.anchored = false; ship.holes = []; }
  if (w === 'deck') { p.onShipId = ship.id; p.atHelm = false; ship.anchored = false; ship.holes = []; }
  g.hud.updateHud();
  return {
    sail: document.getElementById('sail-status').textContent,
    leaks: document.getElementById('ship-leaks').textContent,
  };
}, which);
const panels = { ashore: await stage('ashore') };
await shot('05-ship-panel-ashore');
panels.aboard = await stage('aboard');
await shot('06-ship-panel-aboard');
panels.helm = await stage('helm');
await shot('07-ship-panel-helm');
panels.deck = await stage('deck');
console.log(`    ashore: "${panels.ashore.sail}" / "${panels.ashore.leaks}"`);
console.log(`    aboard: "${panels.aboard.sail}"`);
console.log(`    helm:   "${panels.helm.sail}"`);
console.log(`    deck:   "${panels.deck.sail}"`);

expect('ashore the panel gives no key orders',
  !/\[X\]|\[W\]|\[Q\]|\[F\]/.test(panels.ashore.sail), panels.ashore.sail);
expect('ashore it still reports the ship\'s state',
  /Anchored/.test(panels.ashore.sail), panels.ashore.sail);
expect('ashore a breach is reported, not ordered',
  /LEAK/.test(panels.ashore.leaks) && !/\[X\]/.test(panels.ashore.leaks), panels.ashore.leaks);
expect('aboard her the capstan/helm order comes back',
  /\[X\] at the capstan/.test(panels.aboard.sail), panels.aboard.sail);
expect('aboard a breach names the key again',
  /hold \[X\]/.test(panels.aboard.leaks), panels.aboard.leaks);
// MINUTE-ZERO PLAIN ENGLISH. "Trim centered · Catch 62% · Trim Right [F]" was
// three pieces of sailing vocabulary for one idea; the readout is a sentence
// now, and the numbers still only appear where they can be acted on.
expect('the trim readout shows at the helm, in words',
  /catching \d+% of the wind/.test(panels.helm.sail), panels.helm.sail);
expect('the helm says which key gets more of the wind',
  /(turn sails (left|right) \[(Q|F)\]|best angle)/.test(panels.helm.sail), panels.helm.sail);
expect('the trim readout stays off the panel away from the wheel',
  !/catching \d+%/.test(panels.deck.sail), panels.deck.sail);
expect('no bare nautical jargon survives on the first-five-minutes panel',
  !/\bCatch \d+%|\bTrim (centered|port|starboard)\b|Rigging \d+%/.test(
    `${panels.helm.sail} ${panels.deck.sail} ${panels.ashore.sail}`),
  `${panels.helm.sail} | ${panels.deck.sail}`);
// [W] IS NOT A DECK KEY. "hold [X] at the capstan or [W] at the helm" read as
// though W worked from anywhere on the quarterdeck, and a new captain stood on
// the dais leaning on it watching nothing happen. The wheel is TAKEN first, and
// the line has to say so in that order.
expect('off the wheel the anchored line puts [X] at the wheel BEFORE the [W]',
  /hold \[X\] at the wheel, then \[W\]/.test(panels.aboard.sail), panels.aboard.sail);
expect('and it never offers a bare [W] from the deck',
  !/\[W\] at the helm/.test(panels.aboard.sail), panels.aboard.sail);
expect('with her hands actually on the wheel, [W] is the whole order',
  /hold \[W\] to weigh anchor/.test(await page.evaluate(() => {
    const g = window.__piratesBR;
    const p = g.getLocalPlayer();
    const ship = g.state.ships.find((s) => s.id === p.shipId);
    p.onShipId = ship.id; p.atHelm = true; ship.anchored = true;
    g.hud.updateHud();
    const line = document.getElementById('sail-status').textContent;
    p.atHelm = false; ship.anchored = false;
    return line;
  })));

// ── The first-sail funnel: the missing beat ──────────────────
// "Board your ship" used to hand straight over to "claim upgrades, raid ships"
// the instant a boot touched the planking — a pirate who had never sailed
// anything was sent raiding with the anchor down and nobody on the wheel.
console.log('\nThe first-sail funnel:');
const funnel = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  const ship = g.state.ships.find((s) => s.id === p.shipId);
  const line = () => {
    g.hud.updateHud();
    return document.getElementById('br-progress-feed').textContent;
  };
  // Re-arm the one-shot: this pass is a brand-new pirate's first deck.
  g.hud.firstSailDone = false;
  p.carryingChestId = null;
  p.treasureMapIslandId = null;
  p.gold = 0;
  ship.holes = [];
  ship.waterLevel = 0;
  // 1. Ashore, hull not yet boarded — the marker objective owns the line.
  p.onShipId = null; p.atHelm = false; ship.anchored = true; ship.sailHeight = 0;
  const ashore = line();
  // 2. Boots on her planking, anchor down, nobody on the wheel.
  p.onShipId = ship.id;
  const aboard = line();
  // 3. Hands on the wheel — the beat is spent.
  p.atHelm = true;
  const atHelm = line();
  // 4. …and it stays spent: dropping anchor in a bay later must not re-teach.
  p.atHelm = false; ship.anchored = true; ship.sailHeight = 0;
  const later = line();
  // 5. A different pirate, who never touched the wheel but is under way.
  g.hud.firstSailDone = false;
  ship.anchored = false; ship.sailHeight = 0.6;
  const underWay = line();
  ship.sailHeight = 0.5;
  return { ashore, aboard, atHelm, later, underWay };
});
console.log(`    ashore:   "${funnel.ashore.split(' · ')[0]}"`);
console.log(`    aboard:   "${funnel.aboard.split(' · ')[0]}"`);
console.log(`    at helm:  "${funnel.atHelm.split(' · ')[0]}"`);
const TAKE_HELM = /take the helm \[X\] at the wheel, then hold W/i;
expect('aboard with the anchor down, the objective is the wheel',
  TAKE_HELM.test(funnel.aboard), funnel.aboard);
expect('it does not fire before she is even aboard',
  !TAKE_HELM.test(funnel.ashore), funnel.ashore);
expect('the wheel in her hands spends the beat',
  !TAKE_HELM.test(funnel.atHelm), funnel.atHelm);
expect('and anchoring in a bay an hour later does not re-run the tutorial',
  !TAKE_HELM.test(funnel.later), funnel.later);
expect('a crew already under way is never sent back to the wheel',
  !TAKE_HELM.test(funnel.underWay), funnel.underWay);

// ── SHIP'S ORDERS is a card, not a curtain ───────────────────
// It parked over the WHOLE screen and stayed there: still over the view at 13
// knots at night, back again on a second join, and nothing but [L] took it off.
console.log("\nShip's Orders:");
const legendCard = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  const ship = g.state.ships.find((s) => s.id === p.shipId);
  const el = document.getElementById('controls-hint');
  const open = () => { el.style.display = 'block'; g.hud.updateHud(); };
  const shown = () => getComputedStyle(el).display === 'block';
  const box = () => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) }; };
  p.onShipId = ship.id; p.atHelm = false; p.atCannon = false; p.atCrowNest = false; p.mastClimb = null;
  ship.anchored = true; ship.sailHeight = 0.5;
  for (const w of p.weapons) if (w) w.ammo = 6;

  // 1. AT A STATION it is pure obstruction — it is covering the very wheel it
  //    is explaining.
  p.atHelm = true;
  open();
  const atStation = shown();
  p.atHelm = false;

  // 2. The FIRST MEANINGFUL VERB ends the reading. Making sail with her own
  //    hands is one (the opening horn's hoist is not — see below).
  open();
  const openedOnDeck = shown();
  ship.sailHeight = 0.5;
  g.hud.updateHud();               // …the horn's own canvas must NOT count
  const survivesTheHorn = shown();
  ship.sailHeight = 0.78;          // her hands on the rope
  g.hud.updateHud();
  const afterMakingSail = shown();

  // 3. Firing a shot is a verb too.
  ship.sailHeight = 0.5;
  open();
  p.weapons[0].ammo -= 1;
  g.hud.updateHud();
  const afterFiring = shown();

  // 4. After LEGEND_DOCK_MS it shrinks to a side panel and gives the sea back.
  open();
  const full = box();
  g.hud.legendOpenContext.at -= 11_000;
  g.hud.updateHud();
  const docked = box();
  const dockedClass = el.classList.contains('docked');
  // …and every word survives the shrink: the card is pointer-events:none, so a
  // cropped panel is text nobody can ever scroll to.
  const clipped = el.scrollHeight - el.clientHeight;
  el.style.display = 'none';
  g.hud.updateHud();
  return { atStation, openedOnDeck, survivesTheHorn, afterMakingSail, afterFiring, full, docked, dockedClass, clipped,
    viewport: { w: innerWidth, h: innerHeight } };
});
console.log(`    full ${JSON.stringify(legendCard.full)} → docked ${JSON.stringify(legendCard.docked)} (clip ${legendCard.clipped}px)`);
expect('the card refuses to sit over a station', legendCard.atStation === false);
expect('off the station it opens normally', legendCard.openedOnDeck === true);
expect("the opening horn's own canvas does not count as her verb",
  legendCard.survivesTheHorn === true);
expect('her hands on the rope dismiss it', legendCard.afterMakingSail === false);
expect('so does firing a shot', legendCard.afterFiring === false);
expect('after ten seconds it docks to a side panel', legendCard.dockedClass === true);
expect('and the docked panel stops covering the screen',
  legendCard.docked.w < legendCard.full.w * 0.62 && legendCard.docked.left < 40,
  JSON.stringify(legendCard));
expect('every word of it survives the shrink — nothing can scroll a card that eats no clicks',
  legendCard.clipped <= 0, `${legendCard.clipped}px below the crop`);

// ── The chart explains its own language ──────────────────────
// The map speaks in fourteen hand-drawn gold marks and never once said what any
// of them meant, and the opening "sell treasure" objective was words on a strip
// with nothing on the chart to point at.
console.log('\nThe chart:');
await page.evaluate(() => {
  // Gold ink in the ring band around a chart point, ignoring the permanent
  // coin glyph at its centre.
  window.__firstGoldRingInk = (hoarder) => {
    const canvas = document.getElementById('map-canvas');
    const ctx = canvas.getContext('2d');
    const scale = Math.min(canvas.width, canvas.height) / 2000;
    const cx = Math.round(canvas.width / 2 + hoarder.npc.position.x * scale);
    const cy = Math.round(canvas.height / 2 + hoarder.npc.position.z * scale);
    const R = 30;
    const patch = ctx.getImageData(cx - R, cy - R, R * 2, R * 2).data;
    let ink = 0;
    for (let y = 0; y < R * 2; y += 1) {
      for (let x = 0; x < R * 2; x += 1) {
        const d = Math.hypot(x - R, y - R);
        if (d < 10 || d > 26) continue;
        const i = (y * R * 2 + x) * 4;
        // The ring's gold, composited over the chart's dark water.
        if (patch[i] > 120 && patch[i + 1] > 90 && patch[i + 2] < 110) ink += 1;
      }
    }
    return ink;
  };
  // …and the same reading on the MINIMAP, which is the chart a pirate actually
  // has open while sailing. A signpost that only exists on the [M] overlay is a
  // signpost for someone who already knows to look.
  window.__miniGoldRingInk = (hoarder) => {
    const canvas = document.getElementById('minimap-canvas');
    const ctx = canvas.getContext('2d');
    const scale = Math.min(canvas.width, canvas.height) / 2000;
    const cx = Math.round(canvas.width / 2 + hoarder.npc.position.x * scale);
    const cy = Math.round(canvas.height / 2 + hoarder.npc.position.z * scale);
    const R = 16;
    const patch = ctx.getImageData(cx - R, cy - R, R * 2, R * 2).data;
    let ink = 0;
    for (let y = 0; y < R * 2; y += 1) {
      for (let x = 0; x < R * 2; x += 1) {
        const d = Math.hypot(x - R, y - R);
        if (d < 6 || d > 13) continue;
        const i = (y * R * 2 + x) * 4;
        if (patch[i] > 120 && patch[i + 1] > 90 && patch[i + 2] < 110) ink += 1;
      }
    }
    return ink;
  };
});
const chart = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  // The FIRST beat: no chart in hand, nothing carried, nothing banked.
  p.treasureMapIslandId = null;
  p.carryingChestId = null;
  p.questMaps = [];
  g.map.mapOpen = true;
  document.getElementById('map-overlay').classList.add('visible');
  g.map.resetChartView();
  g.map.drawGlyphKey(true);
  const hoarder = g.getClosestGoldHoarder(p);

  // BASELINE FIRST. The annulus around a Tallyman is never blank water — the
  // isle's other NPC marks and its name label live in that band too — so
  // "the ring is on the chart" only means anything as a DELTA against the
  // same chart with the signpost stood down. Measuring the lit state alone
  // was how a passing ratio hid behind the isle's own furniture.
  p.gold = 9999;
  g.map.drawMaps();
  const baseline = window.__firstGoldRingInk(hoarder);
  const miniBaseline = window.__miniGoldRingInk(hoarder);

  // SIGNPOSTED, sampled across a full breath (~2.6 s). The mark pulses, so the
  // honest number is its WEAKEST frame, never a lucky one — a signpost that is
  // only visible half the time is not a signpost.
  p.gold = 0;
  const samples = [];
  const miniSamples = [];
  for (let i = 0; i < 12; i += 1) {
    g.map.drawMaps();
    samples.push(window.__firstGoldRingInk(hoarder));
    miniSamples.push(window.__miniGoldRingInk(hoarder));
    await new Promise((r) => setTimeout(r, 240));
  }

  const key = document.getElementById('map-key-canvas');
  const ctx = key?.getContext('2d');
  let inked = 0;
  if (ctx) {
    const data = ctx.getImageData(0, 0, key.width, key.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) inked += 1;
  }
  const keyRect = document.getElementById('map-key')?.getBoundingClientRect();
  const panelRect = document.getElementById('map-panel')?.getBoundingClientRect();
  const canvasRect = key?.getBoundingClientRect();
  return {
    inked,
    // Backing-store pixels per CSS pixel. Below 1 the key is being SQUEEZED by
    // CSS and every word shrinks with it — the first cut drew 17px type into an
    // 1800-wide store shown at 630, i.e. six-pixel text.
    keyPixelRatio: canvasRect && key.width
      ? +(canvasRect.width / key.width * (window.devicePixelRatio || 1)).toFixed(3)
      : 0,
    keyCssHeight: canvasRect ? Math.round(canvasRect.height) : 0,
    keyOnScreen: !!keyRect && keyRect.bottom <= window.innerHeight + 1 && keyRect.width > 200,
    keyBelowChart: !!keyRect && !!panelRect && keyRect.top >= panelRect.bottom - 1,
    baseline,
    weakest: Math.min(...samples),
    brightest: Math.max(...samples),
    miniBaseline,
    miniWeakest: Math.min(...miniSamples),
    hoarderIsland: hoarder?.island.name ?? '',
  };
});
await shot('08-chart-glyph-key');
console.log(`    key ink=${chart.inked}px · first-gold ring ${chart.weakest}–${chart.brightest}px over ${chart.baseline}px of chart at ${chart.hoarderIsland}`);
console.log(`    minimap first-gold ${chart.miniWeakest}px over ${chart.miniBaseline}px baseline`);
expect('the chart carries a painted glyph key', chart.inked > 4000, `${chart.inked} inked px`);
expect('the key sits under the chart, on screen', chart.keyOnScreen && chart.keyBelowChart, JSON.stringify(chart));
// A KEY NOBODY CAN READ IS NO KEY. It is laid out in the pixels a player looks
// at, never drawn huge and squeezed down by CSS.
expect('the key is drawn at display resolution, not squeezed',
  chart.keyPixelRatio >= 0.98, `${chart.keyPixelRatio} backing px per CSS px`);
expect('and the band is tall enough to hold readable type',
  chart.keyCssHeight >= 110, `${chart.keyCssHeight}px tall`);
// A key that goes stale is worse than no key. Every mark drawPoiIcon can draw
// must be named in it, and the key must never claim a mark that does not exist.
const MAP_SRC = readFileSync(new URL('../src/client/ui/MapRenderer.ts', import.meta.url), 'utf8');
const iconBody = MAP_SRC.slice(MAP_SRC.indexOf('private drawPoiIcon'));
const drawable = new Set([...iconBody.slice(0, iconBody.indexOf('\n  private ')).matchAll(/case '(\w+)':/g)].map((m) => m[1]));
const keyBlock = MAP_SRC.slice(MAP_SRC.indexOf('GLYPH_KEY'));
const keyed = new Set([...keyBlock.slice(0, keyBlock.indexOf('];')).matchAll(/kind: '(\w+)'/g)].map((m) => m[1]));
expect('the key names every mark the chart can draw',
  [...drawable].every((k) => keyed.has(k)), `unlisted: ${[...drawable].filter((k) => !keyed.has(k)).join(', ')}`);
expect('and claims no mark the chart cannot draw',
  [...keyed].every((k) => drawable.has(k)), `phantom: ${[...keyed].filter((k) => !drawable.has(k)).join(', ')}`);
expect('the first objective is signposted ON the chart, not just in words',
  chart.weakest - chart.baseline > 60,
  `weakest ${chart.weakest}px vs ${chart.baseline}px baseline near ${chart.hoarderIsland}`);
expect('the signpost never blinks out mid-pulse',
  chart.weakest > chart.brightest * 0.5, `${chart.weakest}–${chart.brightest}px across a full breath`);
// …and it is on the chart a sailing pirate already has open.
expect('the minimap carries the first-gold mark too',
  chart.miniWeakest - chart.miniBaseline > 8,
  `minimap ${chart.miniWeakest}px vs ${chart.miniBaseline}px baseline`);

// …and it stands down the moment the crew has an errand of their own: the
// annulus must come back to the untouched chart, not merely dim.
const afterFirstGold = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  p.gold = 4000;
  g.map.drawMaps();
  const ink = window.__firstGoldRingInk(g.getClosestGoldHoarder(p));
  p.gold = 0;
  g.map.mapOpen = false;
  document.getElementById('map-overlay').classList.remove('visible');
  return ink;
});
expect('the first-gold signpost stands down once the loop is found',
  afterFirstGold <= chart.baseline + 4,
  `${afterFirstGold} px still ringed (bare chart is ${chart.baseline})`);

// ── Death screen names the real cause ────────────────────────
console.log('\nDeath screen variants:');
const expected = {
  killed: /YOUR CREW WAS ELIMINATED/,
  ship_sunk: /SHIP SUNK/,
  storm: /STORM/,
  drowned: /DROWNED/,
};
for (const variant of ['killed', 'ship_sunk', 'storm', 'drowned']) {
  const out = await page.evaluate((v) => {
    const g = window.__piratesBR;
    const p = g.getLocalPlayer();
    const ship = g.state.ships.find((s) => s.id === p.shipId);
    p.atHelm = false;
    p.onShipId = null;
    // Stage the world the cause is read from, THEN die — the resolver samples
    // the frame before the flip, exactly as a real death does.
    if (v === 'ship_sunk') { p.state = 'respawning'; p.respawnTimer = 4; ship.alive = false; ship.sinking = true; }
    if (v === 'storm') { p.state = 'alive'; p.position.x = g.state.storm.centerX + g.state.storm.safeRadius + 300; }
    if (v === 'drowned') { p.state = 'swimming'; p.position.x = g.state.storm.centerX; p.position.z = g.state.storm.centerZ; }
    if (v === 'killed') { p.state = 'alive'; p.position.x = g.state.storm.centerX; p.position.z = g.state.storm.centerZ; }
    g.hud.updateHud();
    p.state = 'eliminated';
    g.hud.updateHud();
    return {
      title: document.getElementById('death-title')?.textContent ?? '',
      cause: document.getElementById('death-cause')?.textContent ?? '',
      stats: document.getElementById('death-stats')?.textContent ?? '',
      spectate: document.getElementById('context-label')?.textContent ?? '',
      prompt: document.getElementById('interact-prompt')?.textContent ?? '',
    };
  }, variant);
  console.log(`    ${variant}: "${out.title}" — ${out.cause}`);
  expect(`${variant}: the title names the real cause`, expected[variant].test(out.title), out.title);
  expect(`${variant}: a cause line explains it`, out.cause.length > 20, out.cause);
  // Wave 1 asked only that this line said "eliminated … spectating". It now
  // says something a spectator can use: WHERE the voyage put you, out of how
  // many crews — and, once the camera has flown to a living crew, whose deck it
  // is over. The standing is the load-bearing part, so that is what is pinned;
  // the fallback wording is still accepted for a frame that has no fleet yet.
  expect(`${variant}: the spectate line states the standing (or falls back honestly)`,
    /place:\s*#\d+\s*of\s*\d+/i.test(out.prompt)
    || (/eliminated/i.test(out.prompt) && /spectating/i.test(out.prompt)), out.prompt);
  {
    const m = /place:\s*#(\d+)\s*of\s*(\d+)/i.exec(out.prompt);
    // A standing outside its own fleet ("#10 of 11") is worse than no standing.
    expect(`${variant}: the standing sits inside the fleet it counts`,
      !m || (Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2])), out.prompt);
  }
  await shot(`04-death-${variant}`);
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const p = g.getLocalPlayer();
    p.state = 'alive';
    const ship = g.state.ships.find((s) => s.id === p.shipId);
    if (ship) { ship.alive = true; ship.sinking = false; }
    g.hud.noteEliminationCause(null);
    const screen = document.getElementById('death-screen');
    screen.style.display = 'none';
    screen.classList.remove('visible');
  });
}

// A server-supplied cause always wins over the local reading.
const served = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.getLocalPlayer();
  p.state = 'swimming'; // local reading would say "drowned"
  g.hud.updateHud();
  g.hud.noteEliminationCause('storm');
  p.state = 'eliminated';
  g.hud.updateHud();
  return document.getElementById('death-title')?.textContent ?? '';
});
expect('a server-supplied cause outranks the local reading', /STORM/.test(served), served);

await browser.close();
console.log(failures === 0 ? '\nA first voyage is legible.' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
