// PROBE, not a gate: FIRST WATER ENTRY: does the first swim of a match stall the main thread? Going under for the first time in a match touches a pile of things that ha...
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// FIRST WATER ENTRY: does the first swim of a match stall the main thread?
//
// Going under for the first time in a match touches a pile of things that have
// never run yet — the underwater post pass, the submerge/splash emitters, the
// muffled audio graph — and the bill for all of it used to land on one frame.
// This walks the local player off the nearest shore (heading away from the
// island centre, which is the shortest way wet) and reports the worst frame gap
// across the state change. Bar: under 200ms. Measured 2026-07 on an M1 at
// quality=high: 24ms here, 213ms on the pre-pass build.
//
// usage: node scripts/water-entry-probe.mjs --url http://127.0.0.1:8090
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { PROBE_BROWSER_ARGS, VIEWPORT, INSTALL_GAP_SAMPLER } from '../perf-probe.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = arg('url', 'http://127.0.0.1:8090').replace(/\/$/, '');
const LABEL = arg('label', 'HEAD');
const OUT = arg('out', null);

const browser = await chromium.launch({ args: PROBE_BROWSER_ARGS });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 200)));
await page.addInitScript(INSTALL_GAP_SAMPLER);
await page.goto(`${URL}/?debug&forceinput&quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 120_000 });
await page.waitForTimeout(9000);
await page.evaluate(() => {
  const r = window.__piratesBR.renderer;
  r.minPixelRatio = 1; r.maxPixelRatio = 1; r.applyPixelRatio(1);
  window.__piratesBR.setBotPeace(true);
  window.__piratesBR.setDayNightOverride(854);
});

const start = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.state.players.find((x) => x.id === g.localPlayerId);
  return p ? { x: p.position.x, y: p.position.y, z: p.position.z, state: p.state } : null;
});
console.log(`[${LABEL}] start`, JSON.stringify(start));

// Face away from the nearest island's centre — that is the shortest way wet.
await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.state.players.find((x) => x.id === g.localPlayerId);
  let best = null, bestD = Infinity;
  for (const isl of g.state.islands) {
    const d = (isl.position.x - p.position.x) ** 2 + (isl.position.z - p.position.z) ** 2;
    if (d < bestD) { bestD = d; best = isl; }
  }
  const dx = p.position.x - (best?.position.x ?? 0);
  const dz = p.position.z - (best?.position.z ?? 0);
  const yaw = Math.atan2(dx, dz);
  window.__waterYaw = yaw;
  g.input.setLook(yaw, -0.02);
});

await page.evaluate(() => {
  window.__gap.worst = 0; window.__gap.gaps = [];
  window.__gap.start = performance.now(); window.__gap.last = performance.now();
});
await page.keyboard.down('w');
let swam = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const g = window.__piratesBR;
    const p = g.state.players.find((x) => x.id === g.localPlayerId);
    // keep the heading pinned; a bump can spin the look
    g.input.setLook(window.__waterYaw + Math.sin(performance.now() / 3000) * 0.35, -0.02);
    return p ? { state: p.state, x: Math.round(p.position.x), y: +p.position.y.toFixed(1), z: Math.round(p.position.z) } : null;
  });
  if (st?.state === 'swimming') { swam = true; console.log(`  entered the water at t=${i + 1}s`, JSON.stringify(st)); break; }
  if (i % 10 === 9) console.log(`  ${i + 1}s`, JSON.stringify(st));
}
await page.waitForTimeout(4000);
await page.keyboard.up('w');
const gap = await page.evaluate(() => ({ worst: window.__gap.worst, gaps: window.__gap.gaps.slice(0, 12) }));
console.log(`[${LABEL}] swimming reached: ${swam}`);
console.log(`  worst frame gap across the entry: ${Math.round(gap.worst)}ms`);
for (const g of gap.gaps) console.log(`    +${(g.at / 1000).toFixed(1)}s  ${g.ms}ms`);
if (OUT) writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, start, swam, gap }, null, 2));
await browser.close();
