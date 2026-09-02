#!/usr/bin/env node
// PROBE, not a gate: TERRAIN FORM PROBE — does the reshaped land actually READ from the sea? Shoots the four visual claims of the terrain-form wave: 1.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// TERRAIN FORM PROBE — does the reshaped land actually READ from the sea?
//
// Shoots the four visual claims of the terrain-form wave:
//   1. Kraken Tooth's TWIN FANGS from 320m of open water (sea-level eye).
//   2. Widow's Watch's massif+crest from 320m (a mass, not a needle).
//   3. Booty Bay's crescent from directly above (a meandering bay mouth,
//      not two razor-straight radial cuts).
//   4. A cliff coast at eye level (Skull Cove) — a real wall, not a lawn.
//
//   node scripts/terrain-form-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/terrain-form';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const wait = (ms) => page.waitForTimeout(ms);

// Neighbouring agents' edits make vite full-reload the page mid-probe; stub HMR.
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
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  await wait(2500);
  // The ship's-orders card opens over the whole viewport on join — [L] closes it,
  // and a silhouette shot behind it is worthless.
  await page.keyboard.press('l');
  await wait(500);
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
}
await join();

const islands = await page.evaluate(() => window.__piratesBR.state.islands.map((i) => ({
  id: i.id, name: i.name, x: i.position.x, z: i.position.z, r: i.radius,
})));
console.log(islands.map((i) => `${i.id} (${i.x},${i.z}) r=${i.r}`).join('\n'));

async function silhouette(name, id, { dist = 320, camY = 3.2, pitch = 0.06, bearing = null } = {}) {
  const isl = islands.find((i) => i.id === id);
  if (!isl) { console.log(`  ! no island ${id}`); return; }
  // Approach bearing: from world centre outward unless told otherwise.
  const b = bearing ?? Math.atan2(isl.z, isl.x);
  const cx = isl.x + Math.cos(b) * dist;
  const cz = isl.z + Math.sin(b) * dist;
  // Look back at the island. Game yaw convention: atan2(dx, dz) (see directionToYaw).
  const yaw = Math.atan2(isl.x - cx, isl.z - cz);
  await page.evaluate(([x, y, z, ya, pi]) => {
    window.__piratesBR.enableFreeCam(x, y, z, ya, pi);
  }, [cx, camY, cz, yaw, pitch]);
  // Terrain chunks stream in around a moved free cam; a 1.4 s settle caught the
  // island half-built (geom 744 vs 3958) and the silhouette read low.
  await page.waitForFunction(() => window.__piratesBR.debugStats?.geom === undefined
    || window.__piratesBR.debugStats.geom > 1200, null, { timeout: 15_000 }).catch(() => {});
  await wait(3000);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 90_000 });
  console.log(`  ${name}.png  cam(${cx.toFixed(0)},${camY},${cz.toFixed(0)}) yaw=${yaw.toFixed(2)}`);
}

await silhouette('kraken-tooth-320m', 'kraken-tooth');
await silhouette('kraken-tooth-200m', 'kraken-tooth', { dist: 200 });
await silhouette('widows-watch-320m', 'widow-s-watch');
await silhouette('widows-watch-200m', 'widow-s-watch', { dist: 200 });
await silhouette('booty-bay-aerial', 'booty-bay', { dist: 30, camY: 340, pitch: -1.42 });
// Skull Cove's cliff-weight-1.0 bearing (2.90 rad), where the plinth stands
// 14.3 m over the water — the band the coastBias axis was invisible on.
await silhouette('skull-cove-cliff-eye', 'skull-cove', { dist: 105, camY: 2.4, pitch: 0.14, bearing: 2.90 });
await silhouette('skull-cove-cliff-far', 'skull-cove', { dist: 190, camY: 2.4, pitch: 0.10, bearing: 2.90 });
await silhouette('castaway-reach-aerial', 'castaway-reach', { dist: 30, camY: 300, pitch: -1.42 });

await page.evaluate(() => window.__piratesBR.disableFreeCam());
if (errors.length) console.log(`console errors: ${errors.slice(0, 5).join(' | ')}`);
await browser.close();
console.log(`\nshots in ${OUT}`);
