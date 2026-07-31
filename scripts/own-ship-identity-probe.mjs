#!/usr/bin/env node
/**
 * WHOSE DECK IS THIS.
 *
 * The fresh-eyes auditor fought half a match from a stranger's derelict cutter
 * with her own hull 876 m away, and every panel in the HUD called it hers,
 * because the hull card was titled from the ship CLASS and nothing else. The
 * fix gives the heading a possessive — YOUR / DERELICT / <crew>'S — and, when
 * the deck under your feet is not yours, a bearing line saying where your own
 * ship is.
 *
 * The YOUR case photographs itself: it is what a solo spawn shows. The other
 * two are the ones that mattered to the auditor and the ones a live probe
 * cannot reach cheaply — boarding an enemy hull is a five-minute sail at six
 * seconds a frame. So they are driven directly against the live HUD instance,
 * which is the same code the panel calls, on a real match's state.
 *
 *   PIRATES_GL=swiftshader node scripts/own-ship-identity-probe.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/own-ship-identity';
mkdirSync(OUT, { recursive: true });
console.log(`GL backend: ${describeGl()}`);
const browser = await chromium.launch({ args: browserArgs() });
const page = await browser.newPage({
  viewport: IS_SOFTWARE_GL ? { width: 960, height: 540 } : { width: 1280, height: 720 },
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const closeBrowser = () => browser.close().catch(() => {});
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
const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
const ready = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const start = performance.now();
  let after = 0;
  while (performance.now() - start < 90_000) {
    await frame();
    const g = window.__piratesBR;
    const ceremony = typeof g?.isStartCeremonyActive === 'function'
      ? g.isStartCeremonyActive()
      : document.body.classList.contains('match-ceremony');
    if (g?.state?.phase === 'playing' && ceremony === false) { after += 1; if (after > 8) return true; }
  }
  return false;
});
ok('the match is up and the ceremony is over', ready === true);
await page.evaluate(() => document.getElementById('oc-skip')?.click());

const out = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const hud = g.hud;
  const me = g.getLocalPlayer?.() ?? g.state.players.find((p) => p.id === g.localPlayerId);
  const own = g.state.ships.find((s) => s.id === me.shipId) ?? null;
  const other = g.state.ships.find((s) => s.id !== me.shipId) ?? null;

  // The live panel, as the solo spawn draws it.
  const liveTitle = document.getElementById('ship-status-title')?.textContent ?? '';
  const bearingEl = document.getElementById('ship-own-bearing');
  const liveBearing = {
    visible: !!bearingEl && bearingEl.classList.contains('visible'),
    text: bearingEl?.textContent ?? '',
  };

  // The three answers, off the same function the heading uses.
  const word = (ship, player) => hud.hullOwnershipWord(ship, player);
  const ownWord = own ? word(own, me) : null;

  // A hull whose whole crew is gone: take a real enemy ship and eliminate its
  // crew in the local mirror of the state, which is what a boarder sees.
  let derelictWord = null;
  let crewWord = null;
  if (other) {
    const crew = g.state.players.filter((p) => p.shipId === other.id);
    const before = crew.map((p) => p.state);
    crew.forEach((p) => { p.state = 'eliminated'; });
    derelictWord = word(other, me);
    crew.forEach((p, i) => { p.state = before[i]; });
    crewWord = crew.length ? word(other, me) : null;
  }

  // The bearing line only exists while the deck is not yours.
  let bearingWhenAway = { visible: false, text: '' };
  if (other) {
    hud.renderOwnShipBearing(other, me);
    bearingWhenAway = {
      visible: bearingEl.classList.contains('visible'),
      text: bearingEl.textContent ?? '',
    };
    // Put the panel back the way the match had it.
    if (own) hud.renderOwnShipBearing(own, me);
  }

  return {
    liveTitle, liveBearing, bearingWhenAway, ownWord, derelictWord, crewWord,
    crewNames: other ? g.state.players.filter((p) => p.shipId === other.id).map((p) => p.name) : [],
    restored: { visible: bearingEl?.classList.contains('visible') ?? false },
  };
});

console.log(`  · live hull card: "${out.liveTitle.trim()}"`);
console.log(`  · words: own=${out.ownWord} derelict=${out.derelictWord} crewed=${out.crewWord} (crew ${JSON.stringify(out.crewNames)})`);
console.log(`  · bearing off your own deck: ${JSON.stringify(out.liveBearing)} / aboard another: ${JSON.stringify(out.bearingWhenAway ?? null)}`);

ok('the spawn hull card is titled as YOURS', /YOUR/i.test(out.liveTitle), `"${out.liveTitle.trim()}"`);
ok('and the class name is still in it, so the panel did not lose its subject',
  /(cutter|sloop|brig|galleon|ship)/i.test(out.liveTitle), `"${out.liveTitle.trim()}"`);
ok('your own hull answers YOUR', out.ownWord === 'YOUR', String(out.ownWord));
ok('a hull whose whole crew is gone answers DERELICT', out.derelictWord === 'DERELICT', String(out.derelictWord));
ok('a crewed enemy hull answers with THEIR name, not yours',
  typeof out.crewWord === 'string' && /'S$/.test(out.crewWord) && out.crewWord !== 'YOUR' && out.crewWord !== 'DERELICT',
  String(out.crewWord));
ok('standing on your own deck shows no bearing line', out.liveBearing.visible === false, JSON.stringify(out.liveBearing));

await page.screenshot({ path: `${OUT}/1-own-hull-card.png`, timeout: 60_000 });

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 3).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
process.exit(failed.length ? 1 : 0);
