// GATE (browser, b1.1b / correctness-06): the frame loop survives a throw.
//
// Before b1.1b the first exception in Game.frame() stopped requestAnimationFrame
// forever. This probe reaches the menu (the loop is already running there),
// calls __piratesBR.injectFrameFault(1) and asserts frames keep advancing with
// no overlay; then injectFrameFault(60) and asserts the reload overlay
// (#frame-fault-overlay, the spec copy) is shown, and frames still advance.
//
// usage: node scripts/probes/frame-fault-probe.mjs [--url http://127.0.0.1:3101]
// Needs a running stack (server 8091, vite 3101). Never 3000/8090/8080.
import { chromium } from 'playwright';
import { browserArgs } from '../lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101')).replace(/\/$/, '');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ headless: true, args: browserArgs() });
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  await page.goto(`${URL}/?debug&forceinput&quality=low`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const frames = () => page.evaluate(() => window.__piratesBR.frameGuard.frames);
  const state = () => page.evaluate(() => {
    const g = window.__piratesBR.frameGuard;
    const o = document.getElementById('frame-fault-overlay');
    return { frames: g.frames, faults: g.totalFaults, wedged: g.wedged, overlay: !!o && getComputedStyle(o).display !== 'none', text: o?.textContent ?? '' };
  });

  const f0 = await frames();
  await page.evaluate(() => window.__piratesBR.injectFrameFault(1));
  await page.waitForTimeout(2000);
  const s1 = await state();
  check('injectFrameFault(1): frames keep advancing', s1.frames > f0 + 10, `${f0} -> ${s1.frames}`);
  check('injectFrameFault(1): one fault, no overlay', s1.faults === 1 && !s1.overlay, `faults=${s1.faults} overlay=${s1.overlay}`);

  await page.evaluate(() => window.__piratesBR.injectFrameFault(60));
  await page.waitForTimeout(3000);
  const s2 = await state();
  check('injectFrameFault(60): reload overlay shown', s2.wedged && s2.overlay, `wedged=${s2.wedged} overlay=${s2.overlay}`);
  check('overlay carries the spec copy', s2.text.includes('Something broke on our side. Reload to rejoin'), s2.text.slice(0, 80));
  check('frames advance again after the streak', s2.frames > s1.frames, `${s1.frames} -> ${s2.frames}`);
  const unexpected = pageErrors.filter((m) => !m.includes('injected frame fault'));
  check('no page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  probe aborted: ${err.message.slice(0, 300)}`);
} finally {
  await browser.close();
}
if (failures) { console.log(`FAIL (${failures})`); process.exit(1); }
console.log('PASS');
