// Comprehensive SoT visual audit tour. Joins a solo match, then flies a
// free-cam to every island and key scenario, capturing screenshots for a
// visual audit. Requires the dev server (npm run dev).
//   node scripts/audit-tour.mjs [outDir] [tod]
//   tod = noon | dusk | night  (default noon)  — drives setDayNightOverride
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/audit';
const TOD = process.argv[3] ?? 'noon';
const TOD_SEC = { noon: 854, dusk: 240, night: 374, storm: 854 };
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

// Place the free-cam at pos looking at target (both [x,y,z]).
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const yaw = Math.atan2(dx / len, dz / len);
    const pitch = Math.asin(dy / len);
    g.enableFreeCam(p[0], p[1], p[2], yaw, pitch);
  }, [pos, target]);
}

const stormFlag = TOD === 'storm' ? '&stormdemo' : '';
await page.goto(`http://127.0.0.1:3000/?debug&quality=high${stormFlag}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3500);

// Force time-of-day.
await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), TOD_SEC[TOD]);
// Hide the DOM HUD so audit frames show only the world (viewmodels are hidden
// in-engine while the free-cam is active). Toggleable so the map shot restores it.
const setHudHidden = (hidden) => page.evaluate((h) => {
  let el = document.getElementById('audit-hide');
  if (h) {
    if (!el) { el = document.createElement('style'); el.id = 'audit-hide'; document.head.appendChild(el); }
    el.textContent = '#hud{opacity:0!important;visibility:hidden!important;}';
  } else if (el) { el.textContent = ''; }
}, hidden);
await setHudHidden(true);
await wait(600);

// Dump world state so we can frame each island + find ships/docks.
const world = await page.evaluate(() => {
  const g = window.__piratesBR;
  const s = g.state;
  const islands = (s.islands ?? []).map((i) => ({
    id: i.id, name: i.name,
    x: i.position.x, z: i.position.z, radius: i.radius,
    palette: i.profile?.palette ?? i.profile?.biome ?? '?',
    style: i.profile?.terrainStyle ?? '?',
    groundY: g.sampleGroundY(i.position.x, i.position.z),
    hasDock: !!i.dock, hasTavern: !!i.tavern,
    caves: (i.caves ?? []).length, geysers: (i.geysers ?? []).length,
    props: (i.props ?? []).length, npcs: (i.npcs ?? []).length,
  }));
  const ships = (s.ships ?? []).map((sh) => ({ id: sh.id, type: sh.type, x: sh.position.x, z: sh.position.z, rot: sh.rotation }));
  const me = g.getLocalPlayer?.();
  return { islands, ships, me: me ? { x: me.position.x, z: me.position.z, onShipId: me.onShipId } : null };
});
writeFileSync(`${OUT}/world.json`, JSON.stringify(world, null, 2));
console.log(`world: ${world.islands.length} islands, ${world.ships.length} ships, tod=${TOD}`);

// Per-island aerial 3/4 vista + an eye-level shore approach.
let n = 0;
for (const isl of world.islands) {
  const r = Math.max(30, isl.radius);
  const peak = Math.max(isl.groundY, 12);
  const label = `${String(++n).padStart(2, '0')}-${isl.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  // aerial 3/4
  await freeLook([isl.x + r * 1.7, peak + r * 0.85 + 34, isl.z + r * 1.7], [isl.x, peak * 0.45, isl.z]);
  await wait(650);
  await shot(`${label}-aerial`);
  // low shore approach from the sea (south)
  await freeLook([isl.x, 6.5, isl.z + r * 1.85], [isl.x, peak * 0.5 + 4, isl.z]);
  await wait(650);
  await shot(`${label}-shore`);
}

// Top-down diagnostic of the biggest mountain island (shadow vs shading check).
const mtn = [...world.islands].sort((a, b) => b.groundY - a.groundY)[0];
if (mtn) {
  await freeLook([mtn.x + 1, mtn.groundY + mtn.radius * 1.6 + 60, mtn.z + 1], [mtn.x, mtn.groundY, mtn.z]);
  await wait(650);
  await shot(`diag-topdown-${mtn.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
}

// Ships: exterior beauty + on-deck. Re-query live positions (bots sail away).
await setHudHidden(true);
const liveShips = await page.evaluate(() =>
  (window.__piratesBR.state.ships ?? []).map((s) => ({ id: s.id, type: s.type, x: s.position.x, z: s.position.z, rot: s.rotation })));
let si = 0;
for (const sh of liveShips.slice(0, 3)) {
  const label = `ship-${++si}-${sh.type}`;
  // frame from the ship's forward-quarter so masts/hull read
  await freeLook([sh.x + 20, 11, sh.z + 20], [sh.x, 4, sh.z]);
  await wait(650);
  await shot(`${label}-ext`);
  await freeLook([sh.x - 1, 7.5, sh.z - 3], [sh.x, 4.5, sh.z + 12]);
  await wait(550);
  await shot(`${label}-deck`);
}

// Underwater near the first island's shore.
if (world.islands[0]) {
  const i0 = world.islands[0];
  await freeLook([i0.x, -1.4, i0.z + i0.radius * 1.6], [i0.x, 1.5, i0.z]);
  await wait(700);
  await shot(`underwater-shore`);
  await freeLook([i0.x, -6, i0.z + i0.radius * 1.2], [i0.x, -2, i0.z]);
  await wait(600);
  await shot(`underwater-deep`);
}

// Wide ocean horizon (open sea, away from land).
await freeLook([0, 8, 0], [400, 6, 400]);
await wait(700);
await shot(`ocean-horizon`);

// Map overview.
await page.evaluate(() => window.__piratesBR.disableFreeCam());
await setHudHidden(false);
await wait(300);
await page.keyboard.press('m');
await wait(900);
await shot(`map`);
await page.keyboard.press('m');

await browser.close();
console.log(`screenshots in ${OUT}/`);
