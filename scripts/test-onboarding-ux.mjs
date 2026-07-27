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
import { mkdirSync } from 'node:fs';

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
    sailHeight: ship?.sailHeight,
    legendOpen: legend ? getComputedStyle(legend).display === 'block' : false,
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
expect('the card opens itself on a first-ever voyage', spawn.legendOpen === true);
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
expect('a vane rides the compass strip', spawn.vaneText.length > 0 && /rotate\(/.test(spawn.vaneArrow),
  `text="${spawn.vaneText}" arrow="${spawn.vaneArrow}"`);

// The auto-open is ONCE, EVER: re-arm the per-session latch and confirm the
// persisted flag (not the latch) is what keeps the card shut.
const secondPass = await page.evaluate(() => {
  const g = window.__piratesBR;
  document.getElementById('controls-hint').style.display = 'none';
  g.hud.legendAutoOpenChecked = false;
  g.hud.maybeAutoOpenLegend();
  return {
    reopened: getComputedStyle(document.getElementById('controls-hint')).display === 'block',
    flag: localStorage.getItem('piratesBR.seenControls'),
  };
});
expect('a second voyage does not reopen it', secondPass.reopened === false && secondPass.flag === '1',
  JSON.stringify(secondPass));

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
expect('numeric trim shows at the helm', /Catch \d+%/.test(panels.helm.sail), panels.helm.sail);
expect('numeric trim stays off the panel away from the wheel',
  !/Catch \d+%/.test(panels.deck.sail), panels.deck.sail);

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
  expect(`${variant}: the wave-1 spectating prompt is intact`,
    /eliminated/i.test(out.prompt) && /spectating/i.test(out.prompt), out.prompt);
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
