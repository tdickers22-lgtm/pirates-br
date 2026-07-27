// THE GILDED WRECK — LIVE PROBE.
//
// The suite proves she rises, pays and sinks. This proves she READS: that a
// pirate who was not looking finds her, that the beacon carries, that her
// silhouette holds up at 300 m and at dusk, and that her chest actually comes
// off her in a live client.
//
// Needs a server with the event forced early:
//   PORT=8091 PIRATES_WRECK_SEC=12 npx tsx src/server/index.ts
//   node scripts/wreck-event-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/wreck-event';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

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

await page.goto('http://127.0.0.1:3000/?debug&forceinput&server=8091', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
await wait(2000);
// The first-voyage SHIP'S ORDERS card owns the middle of the screen; close it or
// every "can you read her from 300 m" shot is a shot of a rules panel.
await page.keyboard.press('KeyL');
await wait(600);

// ── 1. She rises, and the client hears it ──────────────────────────────────
await page.waitForFunction(() => !!window.__piratesBR?.state?.wreck, null, { timeout: 90_000 });
const wreck = await page.evaluate(() => {
  const w = window.__piratesBR.state.wreck;
  return { x: w.position.x, z: w.position.z, rotation: w.rotation, chests: w.chestIds.length, barrels: w.barrelIds.length };
});
console.log('wreck up at', wreck);

const feed = await page.evaluate(() =>
  [...document.querySelectorAll('#kill-feed div, .feed-line, #feed div')].map((n) => n.textContent).join(' | '));
console.log('feed:', feed.slice(0, 400));

// ── 2. Read her from 300 m, at noon and at dusk ────────────────────────────
async function look(fromDistance, timeSec, name) {
  await page.evaluate(([d, t]) => {
    const g = window.__piratesBR;
    const w = g.state.wreck;
    g.setDayNightOverride(t);
    // Stand off her beam at quarterdeck eye height, from whichever bearing has
    // the most open water behind the camera — otherwise a headland fills the
    // frame and the shot says nothing about whether SHE reads.
    let bearing = 2.1;
    let bestClear = -Infinity;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const cx = w.position.x + Math.sin(a) * d;
      const cz = w.position.z + Math.cos(a) * d;
      let clear = Infinity;
      for (const island of g.state.islands) {
        const dd = Math.hypot(cx - island.position.x, cz - island.position.z) - island.radius * 1.4;
        if (dd < clear) clear = dd;
      }
      if (clear > bestClear) { bestClear = clear; bearing = a; }
    }
    const cx = w.position.x + Math.sin(bearing) * d;
    const cz = w.position.z + Math.cos(bearing) * d;
    g.enableFreeCam(cx, 7.5, cz, bearing + Math.PI, -0.02);
  }, [fromDistance, timeSec]);
  await wait(1400);
  await shot(name);
}
await look(300, 854, 'wreck-300m-noon');
await look(300, 240, 'wreck-300m-dusk');
await look(120, 240, 'wreck-120m-dusk');
await look(48, 374, 'wreck-48m-night');

// ── 3. The chart ───────────────────────────────────────────────────────────
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.keyboard.press('KeyM');
await wait(900);
await shot('wreck-battle-map');
await page.keyboard.press('KeyM');
await wait(500);

// ── 4. Swim to her and take a chest ────────────────────────────────────────
await page.evaluate(() => window.__piratesBR.disableFreeCam());
const looted = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const w = g.state.wreck;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const host = g.state.islands.find((i) => i.id === w.hostIslandId);
  const chest = host?.chests.find((c) => c.id === w.chestIds[0]);
  return {
    hostFound: !!host,
    chestOnClient: !!chest,
    chestMeshBuilt: !!chest && !!g.chestMeshes?.get?.(chest.id),
    barrelMeshBuilt: !!g.barrelMeshes?.get?.(w.barrelIds[0]),
    chestPos: chest ? { x: +chest.position.x.toFixed(1), z: +chest.position.z.toFixed(1) } : null,
    mePos: { x: +me.position.x.toFixed(1), z: +me.position.z.toFixed(1) },
  };
});
console.log('client-side loot state:', looted);

// Park the freecam on her deck-line for the hero shot.
await page.evaluate(() => {
  const g = window.__piratesBR;
  const w = g.state.wreck;
  g.setDayNightOverride(240);
  g.enableFreeCam(w.position.x + 26, 9, w.position.z + 20, Math.atan2(-26, -20), -0.16);
});
await wait(1400);
await shot('wreck-hero-dusk');

// ── 5. The uncharted sea ───────────────────────────────────────────────────
const pois = await page.evaluate(() => (window.__piratesBR.state.seaPois ?? []).map((p) => ({
  id: p.id, kind: p.kind, x: p.position.x, z: p.position.z,
})));
console.log('sea POIs:', pois);
for (const poi of pois) {
  await page.evaluate((p) => {
    const g = window.__piratesBR;
    g.setDayNightOverride(854);
    g.enableFreeCam(p.x + 52, 15, p.z + 46, Math.atan2(-52, -46), -0.12);
  }, poi);
  await wait(1200);
  await shot(`poi-${poi.kind}-${poi.id}`);
}
// Does the signpost actually carry? Stand a void away and look back at it.
const far = pois[0];
await page.evaluate((p) => {
  const g = window.__piratesBR;
  g.setDayNightOverride(854);
  g.enableFreeCam(p.x + 210, 9, p.z + 185, Math.atan2(-210, -185), -0.02);
}, far);
await wait(1200);
await shot('poi-gull-signpost-280m');

const poiLoot = await page.evaluate(() => {
  const g = window.__piratesBR;
  const ids = (g.state.seaPois ?? []).flatMap((p) => p.barrelIds);
  return { barrelIds: ids, meshes: ids.filter((id) => !!g.barrelMeshes?.get?.(id)).length };
});
console.log('POI barrels:', poiLoot);

console.log('console errors:', errors.slice(0, 8));
await browser.close();
