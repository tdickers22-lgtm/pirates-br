// MAP CHART PROBE — the live path from "M opens the battle map" to
// "I can inspect any island on it".
//
// Reproduces (and then verifies the fix for):
//   #1 fullscreen map cannot pan — zoom is hard-locked to the player, so a
//      distant island can never be brought into view.
//   #2 island chart bitmaps cap at 48-150px → blocky smear past ~3x zoom.
//   #3 treasure-chart panel + battle-map inset drew generic ellipses/rings
//      instead of the honest island bitmap.
//   #4 label collisions and near-black volcanic isles on navy ocean.
//
// node scripts/map-chart-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/map-chart';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const wait = (ms) => page.waitForTimeout(ms);

// Other agents editing this tree make vite full-reload the page mid-probe.
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

async function join() {
  await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await wait(2500);
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
}
await join();

const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, arg) => {
  try {
    return await rawEvaluate(fn, arg);
  } catch (err) {
    if (!/destroyed|navigation|Target closed/i.test(String(err))) throw err;
    console.log('  (page reloaded under the probe — rejoining)');
    await join();
    return await rawEvaluate(fn, arg);
  }
};

const shotPanel = async (name) => {
  const el = await page.$('#map-panel');
  if (el) await el.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
  else await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
  console.log(`  shot ${name}.png`);
};

/** Cheap fingerprint of the map canvas + whatever pan state the build exposes. */
const mapProbe = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  let land = 0;
  // Edge energy over a coarse stride — a proxy for how much real detail (vs a
  // smeared low-res blob) the land bitmaps carry at this zoom.
  let edge = 0;
  const W = canvas.width;
  for (let y = 2; y < canvas.height - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      const i = (y * W + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      sum = (sum * 31 + r + gg * 3 + b * 7) % 2147483647;
      if (r > 90 && gg > 70 && r > b * 1.12) land += 1;
      const j = (y * W + x + 4) * 4;
      edge += Math.abs(r - d[j]) + Math.abs(gg - d[j + 1]) + Math.abs(b - d[j + 2]);
    }
  }
  const m = g.map;
  return {
    hash: sum,
    land,
    edge,
    zoom: m?.mapZoom ?? null,
    panX: m?.panX ?? null,
    panZ: m?.panZ ?? null,
    hasPanApi: typeof m?.panBy === 'function',
    lodSizes: m?.debugChartBitmapSizes ? m.debugChartBitmapSizes() : null,
  };
});

const results = [];
const log = (label, value) => { console.log(`  ${label}: ${JSON.stringify(value)}`); results.push([label, value]); };

// ── Open the map ───────────────────────────────────────────────────────────
await page.keyboard.press('KeyM');
await wait(600);
const open = await page.evaluate(() => ({
  open: !!window.__piratesBR.map?.mapOpen,
  visible: getComputedStyle(document.getElementById('map-overlay')).display !== 'none',
}));
log('map opened', open);

// ── Zoom ladder ────────────────────────────────────────────────────────────
for (const z of [1, 3, 5.2]) {
  await page.evaluate((zz) => {
    const g = window.__piratesBR;
    g.map.mapZoom = zz;
    g.map.drawFullMap();
  }, z);
  // Past the LOD threshold the sharp bitmaps rasterize a few ms per frame —
  // give them a moment to land before judging the pixels.
  await wait(z > 2.5 ? 6000 : 250);
  const stats = await mapProbe();
  log(`zoom ${z}`, stats);
  await shotPanel(`zoom-${String(z).replace('.', 'p')}`);
}

// ── Pan attempt: drag the chart 260px left / 190px up ──────────────────────
const focusOf = () => page.evaluate(() => {
  const m = window.__piratesBR.map;
  const f = m.debugFocus ? m.debugFocus() : null;
  const me = window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId);
  return { focus: f, player: me ? { x: Math.round(me.position.x), z: Math.round(me.position.z) } : null, zoom: m.mapZoom };
});
await page.evaluate(() => { const g = window.__piratesBR; g.map.resetChartView(); g.map.mapZoom = 3; g.map.drawFullMap(); });
await wait(250);
const beforeDrag = await focusOf();
const box = await (await page.$('#map-panel')).boundingBox();
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let step = 1; step <= 8; step++) {
  await page.mouse.move(cx - 260 * step / 8, cy - 190 * step / 8);
  await wait(30);
}
await page.mouse.up();
await wait(300);
const afterDrag = await focusOf();
log('drag pans the chart', {
  before: beforeDrag,
  after: afterDrag,
  movedWorldUnits: afterDrag.focus && beforeDrag.focus
    ? Math.round(Math.hypot(afterDrag.focus.x - beforeDrag.focus.x, afterDrag.focus.z - beforeDrag.focus.z))
    : null,
});
await shotPanel('after-drag-pan');

// ── Pan clamp: shove the view far past the world edge ──────────────────────
for (let burst = 0; burst < 5; burst++) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) await page.mouse.move(cx + 460 * step / 6, cy + 460 * step / 6);
  await page.mouse.up();
}
await wait(250);
log('pan clamp holds at the world edge', await focusOf());
await shotPanel('pan-clamped');

// ── Click an island label to centre it ─────────────────────────────────────
await page.evaluate(() => { const g = window.__piratesBR; g.map.resetChartView(); g.map.drawFullMap(); });
await wait(300);
const labelHit = await page.evaluate(() => {
  const m = window.__piratesBR.map;
  if (typeof m.debugLabelHitTargets !== 'function') return { supported: false };
  return { supported: true, count: m.debugLabelHitTargets().length };
});
log('label hit targets', labelHit);
if (labelHit.supported && labelHit.count > 0) {
  const target = await page.evaluate(() => {
    const g = window.__piratesBR;
    const canvas = document.getElementById('map-canvas');
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    // The island furthest from the pirate — the one zoom alone could never reach.
    const inside = g.map.debugLabelHitTargets()
      .filter((t) => t.x > 10 && t.x < canvas.width - 10 && t.y > 10 && t.y < canvas.height - 10);
    let best = null;
    let bestD = -1;
    for (const t of inside) {
      const d = Math.hypot(t.worldX - (me?.position.x ?? 0), t.worldZ - (me?.position.z ?? 0));
      if (d > bestD) { bestD = d; best = t; }
    }
    return best ? { ...best, canvasW: canvas.width, canvasH: canvas.height, distanceFromPlayer: Math.round(bestD) } : null;
  });
  const canvasBox = await (await page.$('#map-canvas')).boundingBox();
  const sx = canvasBox.x + target.x / target.canvasW * canvasBox.width;
  const sy = canvasBox.y + target.y / target.canvasH * canvasBox.height;
  await page.mouse.click(sx, sy);
  await wait(400);
  const centred = await focusOf();
  log('label click centres island', {
    clicked: target.name,
    islandAt: { x: target.worldX, z: target.worldZ },
    distanceFromPlayer: target.distanceFromPlayer,
    ...centred,
  });
  await shotPanel('label-click-centred');
  // Let the sharp LOD finish for the island we just opened up.
  await wait(4000);
  await shotPanel('label-click-centred-sharp');
  log('chart LODs built', await page.evaluate(() => window.__piratesBR.map.debugChartBitmapSizes()));
}

// ── Treasure chart panel: drive the real render path with real world data ──
const chart = await page.evaluate(() => {
  const g = window.__piratesBR;
  const canvas = document.getElementById('treasure-chart-canvas');
  if (!canvas) return { present: false };
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  // Chart the island with the most buried chests — the interesting case.
  const island = [...g.state.islands].sort((a, b) => (
    b.chests.filter((c) => c.buried && !c.opened).length - a.chests.filter((c) => c.buried && !c.opened).length
  ))[0];
  g.map.renderTreasureInventoryChart(me, island, null);
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonblank = 0;
  let green = 0;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) nonblank += 1;
    if (d[i + 1] > d[i] && d[i + 1] > d[i + 2]) green += 1;
    colors.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
  }
  // Blow the 224x144 panel up into a static <img> so the screenshot can read it.
  const shot = document.createElement('img');
  shot.src = canvas.toDataURL();
  shot.style.cssText = 'position:fixed;left:24px;top:24px;width:672px;height:432px;z-index:9999;image-rendering:pixelated;border:2px solid #c9a84c';
  document.body.appendChild(shot);
  return {
    present: true,
    island: island.name,
    buriedChests: island.chests.filter((c) => c.buried && !c.opened).length,
    nonblank,
    green,
    colors: colors.size,
    w: canvas.width,
    h: canvas.height,
  };
});
log('treasure chart canvas', chart);
await page.screenshot({ path: `${OUT}/treasure-chart.png`, timeout: 60_000 });
console.log('  shot treasure-chart.png');
await page.evaluate(() => { document.querySelectorAll('img[style*="9999"]').forEach((el) => el.remove()); });

// ── Damage feedback still reads after the dedupe (dusk) ────────────────────
// The hurt overlay fades in ~0.9s and a GPU screenshot costs ~18s, so the probe
// freezes a clone of the REAL overlay the instant real damage lands and shoots
// that. Nothing about the clone is synthesized — it is the live DOM the player
// saw, opacity and wedge rotation included.
await page.keyboard.press('KeyM');
await wait(300);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(240));
await wait(800);
await page.evaluate(() => {
  const g = window.__piratesBR;
  const state = { fired: false, source: null, health: null, opacity: null, wedge: null, arrows: 0, vignette: null };
  window.__hurtWatch = state;
  const me = () => g.state?.players.find((p) => p.id === g.localPlayerId) ?? null;
  let last = me()?.health ?? 100;
  const tick = () => {
    const player = me();
    if (!player) return;
    if (player.health < last - 0.5 && !state.fired) {
      state.fired = true;
      state.health = `${last.toFixed(0)} → ${player.health.toFixed(0)}`;
      state.source = 'live server damage';
      capture();
    }
    last = Math.max(last, player.health);
  };
  const capture = () => {
    const root = [...document.body.children].find((el) => el.style && el.style.zIndex === '92');
    const vignette = document.getElementById('damage-vignette');
    state.vignette = vignette ? getComputedStyle(vignette).opacity : null;
    state.arrows = document.querySelectorAll('.incoming-damage-arrow').length;
    if (!root) return;
    state.opacity = root.style.opacity;
    state.wedge = root.children[1]?.style.transform ?? null;
    const clone = root.cloneNode(true);
    clone.id = 'frozen-hurt-overlay';
    clone.style.opacity = root.style.opacity;
    document.body.appendChild(clone);
  };
  window.__hurtForce = () => { state.source = 'forced flashIncomingDamage'; state.fired = true; capture(); };
  window.__hurtTimer = setInterval(tick, 120);
});
// Sit still at dusk and let the island's skeleton wave find us. Waves are on a
// 120-190s cooldown and then have to walk to you, so this needs real patience.
await page.waitForFunction(() => window.__hurtWatch?.fired === true, null, { timeout: 300_000 }).catch(() => {});
const tookRealDamage = await page.evaluate(() => window.__hurtWatch.fired);
if (!tookRealDamage) {
  console.log('  (no skeleton reached us in 300s — driving the same two CombatFx entry points by hand)');
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const camera = g.renderer.camera;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    // A real enemy tracer past the left ear, through emitLaunch — the exact call
    // the network projectile path makes — so the wedge bearing is resolved for
    // real rather than poked in.
    const right = new (Object.getPrototypeOf(camera.position).constructor)(1, 0, 0).applyQuaternion(camera.quaternion);
    const origin = {
      x: me.position.x - right.x * 26,
      y: me.position.y + 1.6,
      z: me.position.z - right.z * 26,
    };
    g.combatFx.emitLaunch({
      id: 'probe-shot',
      type: 'bullet',
      weaponId: 'flintlock',
      position: origin,
      velocity: { x: right.x * 120, y: 0, z: right.z * 120 },
    }, camera.position, false);
    g.combatFx.flashIncomingDamage(0.9, camera.position, camera.quaternion);
    window.__hurtForce();
  });
}
await page.evaluate(() => clearInterval(window.__hurtTimer));
await page.screenshot({ path: `${OUT}/hurt-overlay-dusk.png`, timeout: 60_000 });
console.log('  shot hurt-overlay-dusk.png');
log('hurt feedback', await page.evaluate(() => window.__hurtWatch));

log('console errors', errors);
await browser.close();
console.log('\n--- summary ---');
for (const [k, v] of results) console.log(`${k} = ${JSON.stringify(v)}`);
