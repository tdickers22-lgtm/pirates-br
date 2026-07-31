// KILL-WAVE INTEGRATION SMOKE — the four cross-territory visuals, in one join.
//
// The territory suites each pin their own piece. This probe is the INTEGRATOR's
// check that the pieces still agree with each other inside one live client:
//
//   (c) fresh join → quarterdeck → ONE [X] takes the helm without ever putting
//       the crosshair on the wheel  (interactions + arbiter territory)
//   (f) a noon sky pan — no dome seam anywhere in the arc  (worlddetail)
//   (g) ?stormdemo — the ISLANDS darken under the storm sky, not just the sky
//   (h) the chart's glyph key paints, and the restaged onboarding cards deal
//
// It is a smoke, not a suite: it screenshots what a player sees and reports the
// numbers the fixes are supposed to move. Read the PNGs.
//
// WHY (f) USED TO BE INTERMITTENT, AND WHAT IT MEASURES NOW. Measured 5x on the
// old sweep: 3 passes, 2 failures, every failure one or two "full-width crease"
// rows at y≈218-220 of the 300-row resample, with |d2|/mad at 68-94 against a
// threshold of 8 — never a marginal read, and always at the same place, while
// nothing about the sky changed between a pass and a failure. The band bottom
// (skyFloor) walked ~10 rows between identical sweeps and sometimes stepped over
// that cliff, sometimes not.
//
// The predecessor's note blamed the sea horizon. It is not the horizon: project
// one through the live camera at pitch 0.75 and it lands at resampled row ~402,
// a hundred rows BELOW the frame. What was actually in shot was the ground. The
// pan flew from wherever the join dropped the player, which is a beach, so the
// bottom third of every frame held sand, palms, a tent and the viewmodel's own
// pistol. blue-minus-red does not call any of those sky, the floor was set by
// whichever column happened to contain the cannon, and the enormous
// discontinuity being flagged was that cannon's top edge against the sky. It
// walked because the player breathes.
//
// So the sweep now flies a FREE CAMERA over open water well inside the ring —
// nothing in frame but sky — and bounds the band twice, analytically (the sea
// horizon projected from camera parameters, which no swell or cloud can move)
// and by colour taken as the min over three frames. The 8x outlier threshold is
// untouched; it was always honest and nothing was failing on its merits. Two
// guards were added so the check can never pass by seeing nothing: one on flat
// captures, one on a band with no rows in it.
//
//   node scripts/killwave-integration-smoke.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/killwave-integration';
mkdirSync(OUT, { recursive: true });

// (f) reads pixels, so it is only as honest as the capture path. Metal is the
// default and the fast one; KW_ANGLE=swiftshader forces software WebGL for boots
// where the Metal compositor hands back one flat colour instead of a frame.
const ANGLE = process.env.KW_ANGLE ?? 'metal';
const browser = await chromium.launch({
  args: [
    ...(ANGLE === 'swiftshader'
      ? ['--use-angle=swiftshader']
      : ['--use-gl=angle', `--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist']),
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

/**
 * Read pixels out of a REAL rendered frame.
 *
 * The obvious way — drawImage() the game canvas into a 2D canvas and call
 * getImageData — returns solid black here: the WebGL context is created without
 * preserveDrawingBuffer, so its backbuffer is gone by the time any script can
 * look at it. That silently gave every sample luminance 0, which reads as "no
 * seam" and as "the land did not darken" at the same time — a false pass and a
 * false failure from the same bug.
 *
 * So go through the compositor instead: screenshot the clip (that is a real
 * capture of what was presented), hand the PNG back into the page as a data
 * URL, and decode it there where ImageBitmap and getImageData actually work.
 */
const samplePixels = async (clip, w, h) => {
  const png = await page.screenshot({ clip, timeout: 60_000 });
  return page.evaluate(async ([dataUrl, tw, th]) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, tw, th);
    return Array.from(ctx.getImageData(0, 0, tw, th).data);
  }, [`data:image/png;base64,${png.toString('base64')}`, w, h]);
};

// A neighbouring agent's save makes vite full-reload the tab mid-probe.
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

async function join(query, firstEver) {
  await page.goto(`http://127.0.0.1:3000/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
  await page.evaluate((fresh) => {
    try {
      if (fresh) localStorage.removeItem('piratesBR.seenControls');
      else localStorage.setItem('piratesBR.seenControls', '1');
    } catch { /* private mode */ }
  }, firstEver);
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 120_000 });
  await wait(3000);
}

const dismissCards = () => page.evaluate(() => {
  const el = document.getElementById('onboard-cards');
  if (el?.classList.contains('visible')) document.getElementById('oc-skip')?.click();
});

// ── (h) THE ONBOARDING CARDS, DEALT FRESH ───────────────────────────────────
console.log('\n(h) first voyage: the cards deal, and the chart carries a key');
await join('?debug&forceinput', true);

const cardTour = await page.evaluate(() => {
  const root = document.getElementById('onboard-cards');
  if (!root) return { present: false };
  const vis = root.classList.contains('visible');
  const dots = [...document.querySelectorAll('#oc-dots .oc-dot')];
  const body = root.innerText.replace(/\s+/g, ' ').trim();
  return {
    present: true, visible: vis, dots: dots.length,
    onDot: dots.findIndex((d) => d.classList.contains('on')),
    next: document.getElementById('oc-next')?.textContent?.trim() ?? null,
    chars: body.length,
    head: body.slice(0, 90),
  };
});
ok('the first-voyage cards open on a first-ever join', cardTour.present && cardTour.visible, JSON.stringify(cardTour));
ok('the tour is staged into more than one card', (cardTour.dots ?? 0) >= 2, `${cardTour.dots} dots, on #${cardTour.onDot}`);
await shot('h1-cards-open');

// Deal through the whole tour and confirm every card carries copy and the
// last one closes rather than dead-ending on "Next".
const pages = [];
for (let i = 0; i < 8; i++) {
  const p = await page.evaluate(() => {
    const root = document.getElementById('onboard-cards');
    if (!root?.classList.contains('visible')) return null;
    const dots = [...document.querySelectorAll('#oc-dots .oc-dot')];
    return {
      idx: dots.findIndex((d) => d.classList.contains('on')),
      next: document.getElementById('oc-next')?.textContent?.trim() ?? '',
      chars: root.innerText.replace(/\s+/g, ' ').trim().length,
    };
  });
  if (!p) break;
  pages.push(p);
  if (i < 3) await shot(`h1-card-${p.idx}`);
  await page.click('#oc-next');
  await wait(320);
}
ok('every card in the tour carries real copy', pages.length > 0 && pages.every((p) => p.chars > 120), JSON.stringify(pages.map((p) => `${p.idx}:${p.chars}c:${p.next}`)));
ok('dealing to the end CLOSES the tour (no dead-end Next)',
  await page.evaluate(() => !document.getElementById('onboard-cards')?.classList.contains('visible')),
  `${pages.length} cards dealt`);
await dismissCards();
await wait(300);

// The chart's glyph key
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.keyboard.press('KeyM');
await wait(1400);
const key = await page.evaluate(() => {
  const c = document.getElementById('map-key-canvas');
  if (!c) return { present: false };
  const box = c.getBoundingClientRect();
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  // ink = anything meaningfully off the parchment background
  let ink = 0;
  const bg = [img[0], img[1], img[2]];
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] > 8 && (Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2])) > 30) ink += 1;
  }
  return {
    present: true, w: c.width, h: c.height,
    cssW: Math.round(box.width), cssH: Math.round(box.height),
    visible: box.width > 40 && box.height > 12,
    inkRatio: +(ink / (c.width * c.height)).toFixed(4),
  };
});
ok('the chart carries a painted glyph key', key.present && key.visible && key.inkRatio > 0.005, JSON.stringify(key));
// A canvas whose backing store has a different ASPECT to its CSS box paints
// stretched glyphs — the key would show art the chart does not.
const keyAspectErr = key.present ? Math.abs((key.w / key.h) / (key.cssW / key.cssH) - 1) : 9;
ok('the key canvas matches its own CSS box aspect (no stretched glyphs)',
  keyAspectErr < 0.06,
  `backing ${key.w}x${key.h}, css ${key.cssW}x${key.cssH}, aspect err ${(keyAspectErr * 100).toFixed(1)}%`);
await shot('h2-chart-with-key');
await page.keyboard.press('KeyM');
await wait(600);

// ── (c) THE HELM ─────────────────────────────────────────────────────────────
// Deliberately NOT re-implemented here. scripts/helm-stance-probe.mjs already
// drives the newcomer's whole walk — spawn, swim, board, cross the deck, read
// [X] at four stances on the dais without ever gazing at the wheel — and this
// smoke's first cut at it only proved that a from-scratch boarding walk is hard
// to write (it never got aboard, and reported "[X] Climb Aboard" as a helm
// failure). Run the probe; it owns that kill.

// ── (f) NOON SKY PAN: NO DOME SEAM ──────────────────────────────────────────
//
// A dome seam is a FULL-WIDTH horizontal arc: a latitude ring of the sphere
// where the interpolated direction creases and the gradient changes character
// all at once. A cloud is not full width, and the sun's glow is smooth. So the
// discriminator is agreement ACROSS COLUMNS: take six well-separated columns of
// pure sky, find rows where the luminance profile's second difference is a
// robust outlier, and only call it a seam when the SAME row is an outlier in
// nearly every column at once.
//
// Pitch 0.75 rad puts the frame over roughly 13°–73° of elevation, which is
// where the seams have always sat: the old dome crease at ~18–29° up, and the
// storm ring's rim (the arc 19178a0 killed) at ~21° from a deck.
//
// WHERE THE BAND BOTTOM COMES FROM, AND WHY IT USED TO WANDER. The band is
// bounded twice, and neither bound is allowed to be a guess:
//
//   * ANALYTIC. The sea horizon is a camera fact, not a pixel fact — project a
//     point at sea level a hundred kilometres down the camera's own forward
//     bearing and read the row it lands on. Nothing in the world can move it:
//     not a swell, not a cloud, not a prop. It is the hard cap.
//   * COLOUR, taken as the MIN over three frames. Blue-minus-red still marks
//     what is sky, but a single frame's crossing is a moving read, so the
//     sweep takes the most conservative of three.
//
// And the pan is flown from a FREE CAMERA over the most open water in the
// world, not from wherever the join dropped the player. That is the change that
// mattered. Standing on a beach put sand, palms, a tent and the viewmodel's own
// pistol in the bottom third of frame; the colour floor was then set by whichever
// column happened to contain the cannon's silhouette, and the enormous
// discontinuity the sweep kept flagging at row ~218 was the top edge of that
// cannon against the sky. It walked ~10 rows because the player breathes. Over
// open water there is nothing in the frame but sky, which is the only thing this
// check was ever asking about.
console.log('\n(f) noon sky pan: the dome has no arc in it');
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
// The HUD is opaque chrome sitting on top of the sky; hide it while measuring.
await page.evaluate(() => {
  document.querySelectorAll('body > div').forEach((d) => { d.dataset.kwHid = d.style.visibility; d.style.visibility = 'hidden'; });
});
// Open water for the pan — and it has to be open water WELL INSIDE THE RING.
// "Furthest from any island" alone lands on the map edge, which by this point in
// the match is outside the storm: the first cut of this pan flew to (340,-820)
// and measured a downpour at noon, found no blue anywhere, and searched zero
// rows. A vacuous pass is worse than a flaky one.
const openWater = await page.evaluate(() => {
  const g = window.__piratesBR;
  const isles = g.state.islands ?? [];
  const storm = g.state.storm;
  const cx = storm?.centerX ?? 0, cz = storm?.centerZ ?? 0;
  const dry = storm ? Math.max(80, storm.safeRadius - 160) : 1e9;
  let best = { x: 0, z: 0, clear: -1e9, fromCentre: 0 };
  for (let x = -820; x <= 820; x += 40) {
    for (let z = -820; z <= 820; z += 40) {
      const fromCentre = Math.hypot(x - cx, z - cz);
      if (fromCentre > dry) continue;
      let clear = 1e9;
      for (const i of isles) {
        const ix = i.position?.x ?? i.x, iz = i.position?.z ?? i.z;
        clear = Math.min(clear, Math.hypot(x - ix, z - iz) - (i.radius ?? 0));
      }
      if (clear > best.clear) best = { x, z, clear: +clear.toFixed(1), fromCentre: +fromCentre.toFixed(0) };
    }
  }
  return { ...best, dryRadius: +dry.toFixed(0) };
});
console.log(`  open water for the pan: ${JSON.stringify(openWater)}`);
const REGION = { x: 40, y: 0, width: 1200, height: 600 };
const SW = 240, SH = 300;
// The haze immediately above the horizon is a legitimate gradient change; keep
// the searched band clear of it by this many resampled rows.
const HORIZON_GUARD = 8;
const seams = [];
// A flat capture has no second difference anywhere and would sail through (f)
// reporting a spotless sky. Never let the compositor pass this check for us.
let flatFrames = 0;
for (const yaw of [0, 1.05, 2.1, 3.15, 4.2, 5.25]) {
  await page.evaluate(([x, z, y]) => window.__piratesBR.enableFreeCam(x, 4, z, y, 0.75), [openWater.x, openWater.z, yaw]);
  await wait(750);
  await shot(`f-noon-yaw-${yaw.toFixed(2)}`);

  // ANALYTIC BOUND: project the sea horizon through the live camera. Camera
  // parameters only — no pixel, and so nothing the world animates, feeds this.
  const horizonRow = await page.evaluate(([regionY, regionH, rows]) => {
    const cam = window.__piratesBR.renderer.camera;
    cam.updateMatrixWorld(true);
    const m = cam.matrixWorld.elements;
    const fx = -m[8], fz = -m[10];
    const len = Math.hypot(fx, fz) || 1;
    const mul = (e, v) => {
      const o = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) o[r] = e[r] * v[0] + e[r + 4] * v[1] + e[r + 8] * v[2] + e[r + 12] * v[3];
      return o;
    };
    const far = [m[12] + (fx / len) * 1e5, 0, m[14] + (fz / len) * 1e5, 1];
    const clip = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, far));
    const screenY = (1 - clip[1] / clip[3]) / 2 * window.innerHeight;
    return (screenY - regionY) / regionH * rows;
  }, [REGION.y, REGION.height, SH]);
  const analyticFloor = Math.min(SH, Math.max(0, Math.floor(horizonRow) - HORIZON_GUARD));

  // COLOUR BOUND: three frames, most conservative crossing wins.
  const COLS = 6, cw = Math.floor(SW / COLS);
  let colourFloor = SH;
  let outlierRows = [];
  for (let frame = 0; frame < 3; frame++) {
    if (frame) await wait(220);
    const px = await samplePixels(REGION, SW, SH);
    let mean = 0, m2 = 0, seen = 0;
    for (let i = 0; i < SW * SH; i++) {
      const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      seen += 1; const d = l - mean; mean += d / seen; m2 += d * (l - mean);
    }
    if (Math.sqrt(m2 / seen) < 2) flatFrames += 1;
    const frameOutliers = [];
    let frameFloor = SH;
    for (let c = 0; c < COLS; c++) {
      const rows = [], sky = [];
      for (let y = 0; y < SH; y++) {
        let sum = 0, blue = 0, red = 0, n = 0;
        for (let x = c * cw; x < (c + 1) * cw; x++) {
          const i = (y * SW + x) * 4;
          sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          red += px[i]; blue += px[i + 2];
          n += 1;
        }
        rows.push(sum / n);
        // Sky is the only strongly blue thing up here. Over open water this
        // only ever trips on the haze band, and the min-of-three keeps the
        // frame-to-frame walk out of the searched rows.
        sky.push((blue - red) / n > 18);
      }
      let floor = SH;
      for (let y = SH - 1; y >= 0; y--) { if (!sky[y]) floor = y; else if (floor < SH) break; }
      frameFloor = Math.min(frameFloor, Math.max(0, floor - 4));
      // Second difference: a crease shows as a spike here, a smooth ramp does not.
      const d2 = [];
      for (let y = 1; y < SH - 1; y++) d2.push(rows[y + 1] - 2 * rows[y] + rows[y - 1]);
      const sorted = [...d2].map(Math.abs).sort((a, b) => a - b);
      const mad = sorted[Math.floor(sorted.length * 0.5)] || 1e-6;
      const hits = new Set();
      d2.forEach((v, i) => { if (Math.abs(v) / mad > 8) hits.add(i + 1); });
      frameOutliers.push(hits);
    }
    // The seam, if there is one, is in every frame; the outliers we judge on are
    // the last frame's, taken with the floor that all three agree is safe.
    colourFloor = Math.min(colourFloor, frameFloor);
    outlierRows = frameOutliers;
  }
  const skyFloor = Math.min(colourFloor, analyticFloor);

  // A seam row is one nearly every column agrees on.
  let agreed = 0, worstRow = -1;
  for (let y = 0; y < skyFloor; y++) {
    const votes = outlierRows.filter((h) => h.has(y) || h.has(y - 1) || h.has(y + 1)).length;
    if (votes >= 5) { agreed += 1; if (worstRow < 0) worstRow = y; }
  }
  seams.push({
    yaw: +yaw.toFixed(2), skyRowsSearched: skyFloor,
    analyticFloor, colourFloor, fullWidthOutlierRows: agreed, firstRow: worstRow,
  });
}
await page.evaluate(() => {
  window.__piratesBR.disableFreeCam();
  document.querySelectorAll('body > div').forEach((d) => { d.style.visibility = d.dataset.kwHid ?? ''; });
});
const seamRows = seams.reduce((a, s) => a + s.fullWidthOutlierRows, 0);
const thinnestBand = Math.min(...seams.map((s) => s.skyRowsSearched));
ok('the sky pan captured real frames', flatFrames === 0,
  flatFrames ? `${flatFrames} flat captures — this run cannot see a seam, GL=${ANGLE}` : `GL=${ANGLE}`);
// A band of zero rows reports a spotless sky on every heading. Whatever else
// (f) says, it has to have looked at some sky to say it.
ok('the pan had sky to search on every heading', thinnestBand >= 120,
  `thinnest band ${thinnestBand} of ${SH} rows: ${JSON.stringify(seams.map((s) => s.skyRowsSearched))}`);
ok('no full-width crease anywhere in the noon sky (dome seam)',
  seamRows === 0 && flatFrames === 0 && thinnestBand >= 120,
  `${seamRows} agreed rows across 6 headings: ${JSON.stringify(seams)}`);

// ── (g) ?stormdemo: THE ISLANDS DARKEN WITH THE SKY ─────────────────────────
console.log('\n(g) stormdemo: the land goes under the weather too');
await join('?debug&forceinput', false);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(1200);
// Point the camera at land, and hold that heading across the weather change.
const aim = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const isles = g.state.islands ?? g.world?.islands ?? [];
  let best = null, bd = 1e9;
  for (const i of isles) {
    const d = Math.hypot(i.x - me.position.x, i.z - me.position.z);
    if (d < bd) { bd = d; best = i; }
  }
  if (!best) return null;
  const yaw = Math.atan2(best.x - me.position.x, best.z - me.position.z);
  g.input.setLook(yaw, 0.02);
  return { dist: +bd.toFixed(1), yaw: +yaw.toFixed(3) };
});
await wait(1200);
const landLum = async () => {
  // The band the horizon sits in at pitch ~0, off a real presented frame.
  const d = await samplePixels({ x: 240, y: 300, width: 800, height: 260 }, 200, 120);
  let sum = 0, sat = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g3 = d[i + 1], b = d[i + 2];
    sum += 0.2126 * r + 0.7152 * g3 + 0.0722 * b;
    const mx = Math.max(r, g3, b), mn = Math.min(r, g3, b);
    sat += mx === 0 ? 0 : (mx - mn) / mx;
    n += 1;
  }
  return { lum: +(sum / n).toFixed(2), sat: +(sat / n).toFixed(4) };
};
const clear = await landLum();
await shot('g1-land-clear');
// Flip the SAME flag ?stormdemo sets, in place: same world, same seed, same
// camera, same frame — so the two readings differ only by the weather. (A
// reload into ?stormdemo would hand us a different island to measure.)
const stormed = await page.evaluate(() => {
  const g = window.__piratesBR;
  if (!('debugStormDemo' in g)) return null;
  g.debugStormDemo = true;
  return 'debugStormDemo';
});
await wait(3000);
const under = await landLum();
await shot('g2-land-stormed');
ok('the land itself darkens under the storm sky',
  under.lum < clear.lum * 0.92,
  `clear lum ${clear.lum} → storm lum ${under.lum} (via ${stormed ?? '?stormdemo reload'})`);
// NOT an assertion. Relative chroma ((max-min)/max) RISES here — the clear
// frame's lagoon is a pale, washed-out turquoise (bright, so low relative
// chroma) and the stormed one is a deeper teal (darker, so higher). That is a
// property of the measure, not of the weather; the darkening above is the claim
// worth gating, and g1/g2 are in the shot folder to be looked at.
console.log(`  · chroma, for the record: clear ${clear.sat} → storm ${under.sat} (see g1/g2 PNGs)`);

console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`);
await browser.close();
if (failed.length) { console.log('FAILED:', failed.map((f) => f.label)); process.exit(1); }
