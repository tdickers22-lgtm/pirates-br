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
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
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

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 3).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
process.exit(failed.length ? 1 : 0);
