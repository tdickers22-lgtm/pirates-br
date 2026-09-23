// GATE (browser, b1.1b / performance-03): WebGL context loss and restore mid-match.
//
// iOS drops the WebGL context when a tab is backgrounded or memory runs short.
// Before b1.1b nothing in the client listened: three skipped render() while
// lost, then recompiled every program at first draw mid-play, and the governor
// and audition read that stall as slowness. This probe joins a solo match,
// calls WEBGL_lose_context.loseContext(), waits 1 s, restoreContext(), and
// asserts:
//   - no pageerror;
//   - the "Restoring graphics" pill is visible while lost, and hidden again <= 6 s after restore;
//   - graphics are held (governor suspended, audition closed) while lost;
//   - draws resume <= 3 s after restore and the guarded frame loop kept advancing;
//   - renderer.info.programs is back to >= 95% of the pre-loss count <= 5 s after restore;
//   - the saved settings (where the auto-tier ceiling lives) are byte-identical.
// --mutate drops the client's own webglcontextrestored listener (three's stays):
// the probe must FAIL (programs stay at 0, the pill never hides).
//
// usage: node scripts/probes/context-loss-probe.mjs [--url http://127.0.0.1:3101] [--quality balanced] [--mutate]
// Needs a running stack (server 8091 with PIRATES_BR_DEV_HOOKS=1, vite 3101). Never 3000/8090/8080.
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101')).replace(/\/$/, '');
const QUALITY = arg('quality', 'balanced');
const MUTATE = argv.includes('--mutate');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const MUTATION = () => {
  // Keep three's own restore listener (added first, in the WebGLRenderer
  // constructor); drop every later one, i.e. the client's.
  const add = HTMLCanvasElement.prototype.addEventListener;
  HTMLCanvasElement.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'webglcontextrestored') {
      this.__restoredSeen = (this.__restoredSeen ?? 0) + 1;
      if (this.__restoredSeen > 1) return undefined;
    }
    return add.call(this, type, fn, opts);
  };
};

const browser = await chromium.launch({ headless: true, args: browserArgs() });
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  if (MUTATE) await page.addInitScript(MUTATION);
  console.log(`[context-loss] ${URL} quality=${QUALITY} gl=${describeGl()}${MUTATE ? ' MUTATED' : ''}`);
  await page.goto(`${URL}/?debug&forceinput&quality=${QUALITY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await page.waitForTimeout(8000);

  const read = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const r = g.renderer;
    const s = r.getGraphicsStatus();
    return {
      ...s,
      frames: g.frameGuard.frames,
      calls: r.renderer.info.render.calls,
      govSuspended: r.governor.isSuspended(),
      settings: localStorage.getItem('piratesBR.settings'),
      now: performance.now(),
    };
  });
  const before = await read();
  console.log(`  before: programs=${before.programs} frames=${before.frames} calls=${before.calls}`);
  check('pre-loss scene has programs', before.programs > 5, `programs=${before.programs}`);

  await page.evaluate(() => {
    const gl = window.__piratesBR.renderer.renderer.getContext();
    window.__loseExt = gl.getExtension('WEBGL_lose_context');
    window.__loseExt.loseContext();
  });
  await page.waitForTimeout(1000);
  const lost = await read();
  check('pill visible while lost', lost.pill && lost.lost, `pill=${lost.pill} lost=${lost.lost}`);
  check('graphics held + governor suspended while lost', lost.held && lost.govSuspended, `held=${lost.held} gov=${lost.govSuspended}`);
  check('frame loop kept running through the loss', lost.frames > before.frames, `${before.frames} -> ${lost.frames}`);

  const restoreAt = Date.now();
  await page.evaluate(() => window.__loseExt.restoreContext());
  let drawsAt = null; let programsAt = null; let pillHiddenAt = null; let heldDuringSettle = null; let last = null;
  while (Date.now() - restoreAt < 9000) {
    await page.waitForTimeout(150);
    last = await read();
    const t = Date.now() - restoreAt;
    if (heldDuringSettle === null && last.settling) heldDuringSettle = last.held && last.govSuspended;
    if (drawsAt === null && !last.lost && last.calls > 0) drawsAt = t;
    if (programsAt === null && last.programs >= Math.floor(before.programs * 0.95)) programsAt = t;
    if (pillHiddenAt === null && !last.pill && !last.lost) pillHiddenAt = t;
    if (drawsAt !== null && programsAt !== null && pillHiddenAt !== null) break;
  }
  console.log(`  after:  programs=${last.programs} calls=${last.calls} restores=${last.restores} drawsAt=${drawsAt}ms programsAt=${programsAt}ms pillHiddenAt=${pillHiddenAt}ms`);
  check('draws resume <= 3 s after restore', drawsAt !== null && drawsAt <= 3000, `${drawsAt} ms`);
  check('programs back to the pre-loss count <= 5 s', programsAt !== null && programsAt <= 5000,
    `${last.programs}/${before.programs} at ${programsAt} ms`);
  check('pill hidden after restore', pillHiddenAt !== null && pillHiddenAt <= 6500, `${pillHiddenAt} ms`);
  check('restore settle observed and held the governor', heldDuringSettle === true, `held=${heldDuringSettle}`);
  const endFrames = last.frames;
  await page.waitForTimeout(1000);
  const tail = await read();
  check('frames still advancing after restore', tail.frames > endFrames, `${endFrames} -> ${tail.frames}`);
  check('saved settings (auto-tier ceiling) unchanged', tail.settings === before.settings,
    `${String(before.settings).slice(0, 80)} vs ${String(tail.settings).slice(0, 80)}`);
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  probe aborted: ${err.message.slice(0, 300)}`);
} finally {
  await browser.close();
}
if (failures) { console.log(`FAIL (${failures})`); process.exit(1); }
console.log('PASS');
