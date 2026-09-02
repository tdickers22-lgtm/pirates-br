// PROBE, not a gate: ONE SUNSET PER MATCH — visual probe for the match-hung day cycle.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// ONE SUNSET PER MATCH — visual probe for the match-hung day cycle.
//
// The sky used to run a free 960 s lap from a 0.47 start, so a match reached
// dusk at ~T+4:00 and new players learned the stations in night rain. The
// server now publishes GameState.matchProgress and the renderer hangs the sun
// on it (Renderer.MATCH_DAY_CYCLE_START/END).
//
// This probe proves three things against the LIVE stack:
//   1. the server really is publishing matchProgress, and it advances;
//   2. the client is consuming it (the sun direction tracks the mapping);
//   3. the arc is ONE transition — morning → noon → dusk → early night, with
//      the sun's elevation never rising again after it starts to fall.
//
// Requires the dev stack (vite :3000 + ws :8090). GPU-headless.
//   node --import tsx scripts/day-arc-probe.mjs <outDir>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/day-arc';
mkdirSync(OUT, { recursive: true });

console.log(`GL backend: ${describeGl()}`);
const browser = await chromium.launch({ args: browserArgs(['--ignore-gpu-blocklist']) });
// A failed sample must not leave a browser behind — this rig runs on a machine a
// stray headless Chromium has frozen before.
process.on('exit', () => { browser.close().catch(() => {}); });
for (const fault of ['uncaughtException', 'unhandledRejection']) {
  process.on(fault, (err) => {
    console.error(`\n${fault}: ${err?.stack ?? err}`);
    browser.close().catch(() => {}).finally(() => process.exit(1));
  });
}

async function session(query, attempts = 4) {
  for (let n = 1; n <= attempts; n++) {
    const page = await browser.newPage({
      viewport: IS_SOFTWARE_GL ? { width: 960, height: 540 } : { width: 1280, height: 720 },
    });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    // Other agents edit this tree while the probe walks a 10-frame arc, and a
    // vite HMR reload mid-walk destroys the execution context. The probe only
    // reads the sky, so the hot-reload client is stubbed out entirely.
    await page.route('**/@vite/client', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export {};' }));
    try {
      await page.goto(`http://127.0.0.1:3000/${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      // waitForFunction's options are the THIRD argument — passed second, the
      // 45 s was being handed to the page function as an ARG and the wait was
      // silently running on the 30 s default.
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 45_000 });
      await page.waitForTimeout(3500);
      // The onboarding cards sit over the scene behind a dimming backdrop —
      // this probe is reading the SKY, so send them away before shooting.
      // The two class/id selectors this used to lead with (.onboarding-skip,
      // #onboarding-skip) never existed in this codebase: the tour's skip
      // button is #oc-skip. When the tour DID open, the probe photographed its
      // dimming backdrop and called it a sky.
      for (let i = 0; i < 4; i++) {
        const open = await page.evaluate(
          () => !!document.getElementById('onboard-cards')?.classList.contains('visible'),
        );
        if (!open) break;
        await page.click('#oc-skip', { noWaitAfter: true, timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      // Belt and braces: whatever the buttons did, the backdrop must be gone
      // before a sky sample is worth anything.
      const stillOpen = await page.evaluate(
        () => !!document.getElementById('onboard-cards')?.classList.contains('visible'),
      );
      if (stillOpen) throw new Error('onboarding cards would not close — sky samples would read the backdrop');
      await page.waitForTimeout(600);
      return page;
    } catch (err) {
      console.log(`  join attempt ${n} failed: ${err.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      if (n === attempts) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw new Error('unreachable');
}

const page = await session('?debug&quality=high');

// ── 1. The server is publishing it, and it moves ───────────────────────────
const first = await page.evaluate(() => window.__piratesBR.state.matchProgress);
console.log('matchProgress on join:', first);
await page.waitForTimeout(6000);
const second = await page.evaluate(() => window.__piratesBR.state.matchProgress);
console.log('matchProgress 6s later:', second);
console.log(
  first !== undefined && second > first
    ? '  OK: server publishes it and it advances'
    : '  FAIL: matchProgress missing or frozen',
);

// ── 2/3. Walk the whole arc and record the sun ─────────────────────────────
// The override speaks in seconds, so the mapping is applied here exactly as
// Game.ts applies it — same constants, same code path shape.
const MATCH_DAY_CYCLE_START = 0.26;
const MATCH_DAY_CYCLE_END = 0.79;
const DAY_NIGHT_CYCLE_SECONDS = 960;
const DAY_NIGHT_START_OFFSET = 0.47;
const secondsFor = (p) =>
  (MATCH_DAY_CYCLE_START + (MATCH_DAY_CYCLE_END - MATCH_DAY_CYCLE_START) * p - DAY_NIGHT_START_OFFSET)
  * DAY_NIGHT_CYCLE_SECONDS;

// A fixed sea-level camera looking west, so every frame is comparable.
await page.evaluate(() => window.__piratesBR.enableFreeCam(0, 26, 240, Math.PI, -0.08));

const ARC_SECONDS = 755;
const samples = [];
for (const p of [0, 0.1, 0.19, 0.35, 0.5, 0.65, 0.8, 0.868, 0.94, 1]) {
  const sec = secondsFor(p);
  await page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
  await page.waitForTimeout(700);
  const sun = await page.evaluate(() => {
    const d = window.__piratesBR.renderer.getSunDirection();
    return { x: d.x, y: d.y, z: d.z };
  });
  const label = `p${String(Math.round(p * 100)).padStart(3, '0')}`;
  await page.screenshot({ path: `${OUT}/${label}.png`, timeout: 60_000 });
  samples.push({ p, t: Math.round(p * ARC_SECONDS), sec: Math.round(sec), elev: sun.y });
  console.log(
    `  p=${p.toFixed(3)} T+${String(Math.round(p * ARC_SECONDS)).padStart(3)}s ` +
    `override=${String(Math.round(sec)).padStart(5)}s sunY=${sun.y.toFixed(3)}`,
  );
}

// ONE transition: elevation rises to a single peak then falls monotonically.
const peak = samples.reduce((a, b) => (b.elev > a.elev ? b : a));
const afterPeak = samples.filter((s) => s.p > peak.p);
const monotonicFall = afterPeak.every((s, i, a) => i === 0 || s.elev <= a[i - 1].elev + 1e-3);
console.log(`\npeak sun at p=${peak.p} (T+${peak.t}s), elevation ${peak.elev.toFixed(3)}`);
console.log(monotonicFall ? '  OK: the sun never comes back up' : '  FAIL: sun rises again — more than one transition');
console.log(
  samples[0].elev > 0.05
    ? `  OK: the match opens in daylight (sunY=${samples[0].elev.toFixed(3)})`
    : `  FAIL: match opens dark (sunY=${samples[0].elev.toFixed(3)})`,
);
console.log(
  samples.at(-1).elev < samples[0].elev
    ? `  OK: it ends darker than it began (sunY=${samples.at(-1).elev.toFixed(3)})`
    : '  FAIL: the match does not get darker',
);

await browser.close();
