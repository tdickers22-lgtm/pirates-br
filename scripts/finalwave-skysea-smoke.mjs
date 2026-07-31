// FINAL WAVE CROSS-SMOKE — SKY AND SEA (checks l, m, o).
//
// Three graphics kills that were landed in the fix wave and have to be re-proved
// against the running dev stack, from the eye heights and the hours the audits
// photographed them at:
//
//   (l) DECK-HEIGHT HORIZON, noon / dusk / night. Two audits filed "a hard curved
//       arc across the sky at every hour" as the sky dome's lower rim. 19178a0
//       says it was the storm front's cylinder running out of quads at r≈700-830m,
//       y=294. From a 3 m deck the seam must be gone at all three hours.
//   (m) ALTITUDE 250 over open water, noon and dusk. 81acab9: from 120 m up the
//       sea became a periodic lattice of pale blotches, because foam breakup was
//       gated by the ripple horizon and collapsed to a constant past it.
//   (o) SEA MICRO-POIs. The audit's "flat black polygon sheets on the water" —
//       every seaPoi kind gets photographed from sailing range and from close to.
//
// HOW IT MUST BE RUN. This box is a fanless Air that has kernel-panicked under
// GPU-headless Chromium; every launch here is software ANGLE, one browser, and
// the viewport is small on purpose. SwiftShader renders REAL pixels — that is the
// whole reason it is worth the frame rate — and every capture below is checked
// for pixel variance before anything is claimed about what it shows, because the
// wedged Metal path returns a single flat colour and a probe in that state
// photographs nothing while reporting passes.
//
//   node scripts/finalwave-skysea-smoke.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/finalwave/smoke/skysea';
mkdirSync(OUT, { recursive: true });

const SOFT_ARGS = [
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter',
];

const browser = await chromium.launch({ headless: true, args: SOFT_ARGS });
let closed = false;
const reap = () => { if (closed) return; closed = true; try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); reap(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); reap(); process.exit(1); });

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const ok = (label, pass, detail = '') => { results.push({ label, pass, detail }); console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); };
const say = (m) => console.log(m);

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));
await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ } });

await page.goto('http://127.0.0.1:3000/?debug&peace', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
await wait(3000);
await page.evaluate(() => { document.getElementById('oc-skip')?.click(); });
await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue?.(40));
await page.waitForFunction(
  () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
  null, { timeout: 180_000 },
).catch(() => say('  (island build queue did not fully drain — continuing)'));
// The HUD is opaque chrome over the two thirds of the frame these checks live in.
await page.evaluate(() => {
  const e = document.createElement('style');
  e.textContent = '#hud{visibility:hidden!important;} #onboard-cards{display:none!important;}';
  document.head.appendChild(e);
});
await wait(800);

/** Point the free camera at a target. */
const look = (p, t) => page.evaluate(([a, b]) => {
  const g = window.__piratesBR;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  g.enableFreeCam(a[0], a[1], a[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
}, [p, t]);

/**
 * Capture, then MEASURE what was captured.
 *
 * `sd` is the whole-frame luminance spread: a wedged GPU returns one flat colour
 * and sd collapses to ~0, which is the only way to tell "nothing rendered" from
 * "a calm sea rendered". `darkFrac` is the share of pixels under luminance 14 —
 * the audit's "flat black polygon sheets" are exactly that and nothing else in a
 * daylit frame is.
 */
const capture = async (name, opts = {}) => {
  const png = await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120_000 });
  const stats = await page.evaluate(async ([dataUrl, band]) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = document.createElement('canvas');
    cv.width = 240; cv.height = 135;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 240, 135);
    const d = ctx.getImageData(0, 0, 240, 135).data;
    const lum = [];
    for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const sd = Math.sqrt(lum.reduce((a, l) => a + (l - mean) ** 2, 0) / lum.length);
    // Rows of the band the caller cares about (fractional y0..y1 of the frame).
    const y0 = Math.round((band?.[0] ?? 0) * 135), y1 = Math.round((band?.[1] ?? 1) * 135);
    let dark = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < 240; x++) { if (lum[y * 240 + x] < 14) dark++; n++; }
    // ROW-TO-ROW STEP, the shape a dome rim seam actually makes: a bright curved
    // edge is a run of adjacent rows whose mean luminance jumps. Reported as the
    // largest single-row jump in the sky band and where it sits.
    let maxStep = 0, stepRow = -1;
    const rowMean = [];
    for (let y = y0; y < y1; y++) {
      let s = 0; for (let x = 0; x < 240; x++) s += lum[y * 240 + x];
      rowMean.push(s / 240);
    }
    for (let i = 1; i < rowMean.length; i++) {
      const step = Math.abs(rowMean[i] - rowMean[i - 1]);
      if (step > maxStep) { maxStep = step; stepRow = y0 + i; }
    }
    return {
      mean: +mean.toFixed(2), sd: +sd.toFixed(2),
      darkFrac: n ? +(dark / n).toFixed(4) : 0,
      maxRowStep: +maxStep.toFixed(2), stepRow,
    };
  }, [`data:image/png;base64,${png.toString('base64')}`, opts.band ?? null]);
  say(`  [${name}] ${JSON.stringify(stats)}`);
  return stats;
};

const world = await page.evaluate(() => {
  const g = window.__piratesBR;
  return {
    islands: (g.state.islands ?? []).map((i) => ({ name: i.name, x: i.position.x, z: i.position.z, r: i.radius })),
    pois: (g.state.seaPois ?? []).map((p) => ({ id: p.id, kind: p.kind, x: p.position.x, z: p.position.z, r: p.radius })),
    storm: { cx: g.state.storm.centerX, cz: g.state.storm.centerZ, safe: g.state.storm.safeRadius },
  };
});
say(`world: ${world.islands.length} islands, ${world.pois.length} sea POIs, ring r=${world.storm.safe.toFixed(0)}`);

// A patch of water with nothing on it — the sky and the sea have to be judged
// with no island in the frame to explain an edge away.
const openWater = (() => {
  let best = null;
  for (let a = 0; a < 24; a++) {
    for (const rad of [260, 400, 520]) {
      const x = world.storm.cx + Math.cos((a / 24) * Math.PI * 2) * rad;
      const z = world.storm.cz + Math.sin((a / 24) * Math.PI * 2) * rad;
      const d = Math.min(...world.islands.map((i) => Math.hypot(i.x - x, i.z - z) - i.r));
      if (!best || d > best.d) best = { x, z, d };
    }
  }
  return best;
})();
say(`open water at ${openWater.x.toFixed(0)},${openWater.z.toFixed(0)} — nearest shore ${openWater.d.toFixed(0)} m`);

const shotStats = {};

// ══ (l) DECK-HEIGHT HORIZON, THREE HOURS ═════════════════════════════════════
say('\n(l) deck height, looking at the horizon — no dome rim arc');
for (const [hour, secs] of [['noon', 854], ['dusk', 240], ['night', 374]]) {
  await page.evaluate(([s]) => window.__piratesBR.setDayNightOverride(s), [secs]);
  // Three metres of freeboard, eye on the horizon, and a second bearing 120° off
  // so a seam that only crosses one quadrant cannot hide behind the camera.
  await look([openWater.x, 3, openWater.z], [openWater.x + 900, 3, openWater.z]);
  await wait(2200);
  shotStats[`l-deck-${hour}-a`] = await capture(`l-deck-${hour}-a`, { band: [0, 0.55] });
  await look([openWater.x, 3, openWater.z], [openWater.x - 450, 3, openWater.z + 780]);
  await wait(1600);
  shotStats[`l-deck-${hour}-b`] = await capture(`l-deck-${hour}-b`, { band: [0, 0.55] });
}

// ══ (m) ALTITUDE 250 ═════════════════════════════════════════════════════════
say('\n(m) 250 m up over open water — no chequerboard');
for (const [hour, secs] of [['noon', 854], ['dusk', 240]]) {
  await page.evaluate(([s]) => window.__piratesBR.setDayNightOverride(s), [secs]);
  // Looking well down the slope of the sea is where the lattice appeared: the
  // band from the near water out to the vanishing point, all in one frame.
  await look([openWater.x, 250, openWater.z], [openWater.x + 620, 0, openWater.z + 180]);
  await wait(2600);
  shotStats[`m-alt250-${hour}`] = await capture(`m-alt250-${hour}`, { band: [0.35, 1] });
  // And straight down-ish, which is where a periodic foam grid is most legible.
  await look([openWater.x, 250, openWater.z], [openWater.x + 190, 0, openWater.z + 60]);
  await wait(1800);
  shotStats[`m-alt250-${hour}-steep`] = await capture(`m-alt250-${hour}-steep`, { band: [0.2, 1] });
}

// ══ (o) SEA MICRO-POIs ═══════════════════════════════════════════════════════
say('\n(o) sea events on the water — no flat black sheets');
await page.evaluate(([s]) => window.__piratesBR.setDayNightOverride(s), [854]);
const byKind = new Map();
for (const p of world.pois) if (!byKind.has(p.kind)) byKind.set(p.kind, p);
say(`  kinds present: ${[...byKind.keys()].join(', ') || '(none)'}`);
const poiStats = [];
for (const [kind, p] of byKind) {
  // Sailing range first — how a captain meets one — then close aboard.
  await look([p.x + 55, 9, p.z + 40], [p.x, 1, p.z]);
  await wait(2200);
  const far = await capture(`o-${kind}-far`, { band: [0.3, 1] });
  await look([p.x + 16, 4.5, p.z + 12], [p.x, 0.6, p.z]);
  await wait(1800);
  const near = await capture(`o-${kind}-near`, { band: [0.25, 1] });
  poiStats.push({ kind, far, near });
  shotStats[`o-${kind}-far`] = far; shotStats[`o-${kind}-near`] = near;
}

// ── Verdicts ─────────────────────────────────────────────────────────────────
const all = Object.entries(shotStats);
ok('every frame this run judged is a rendered world, not a flat GPU placeholder',
  all.every(([, s]) => s.sd > 3),
  all.filter(([, s]) => s.sd <= 3).map(([n, s]) => `${n} sd=${s.sd}`).join(', ') || `min sd=${Math.min(...all.map(([, s]) => s.sd)).toFixed(1)}`);

// A seam is a HARD edge: on the audit frames the rim jumped tens of luminance
// levels between adjacent rows of sky. Gradients (the sky's own falloff, the
// horizon haze) move a couple of levels per row at this resolution. The threshold
// is deliberately generous — this is a screening number, and the PNGs are read.
const deckShots = all.filter(([n]) => n.startsWith('l-deck-'));
ok('no hard horizontal edge across the sky band at deck height, any hour',
  deckShots.every(([, s]) => s.maxRowStep < 22),
  deckShots.map(([n, s]) => `${n}:${s.maxRowStep}@row${s.stepRow}`).join(' '));

const altShots = all.filter(([n]) => n.startsWith('m-alt250-'));
ok('the sea from 250 m is drawn (frames have real structure to judge)',
  altShots.every(([, s]) => s.sd > 3),
  altShots.map(([n, s]) => `${n}:sd=${s.sd}`).join(' '));

ok('no sea event photographs as a black sheet on the water',
  poiStats.length > 0 && poiStats.every((p) => p.far.darkFrac < 0.08 && p.near.darkFrac < 0.12),
  poiStats.map((p) => `${p.kind} far=${p.far.darkFrac} near=${p.near.darkFrac}`).join(' ') || 'no sea POIs in this world');

writeFileSync(`${OUT}/skysea-report.json`, JSON.stringify({ world, openWater, shotStats, poiStats, results, errors: errors.slice(0, 20) }, null, 1));
console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 4).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
closed = true;
process.exit(failed.length ? 1 : 0);
