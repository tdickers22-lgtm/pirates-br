// Visual verification probe for the intuitiveness pass: dock parking, station
// tags, tavern door open/close, hole markers + repair chips.
// node scripts/verify-fixes-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/verify-fixes';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
  }, [pos, target]);
}

await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854)); // noon
await wait(400);

// ── 1. Own ship parked at the dock (normalization + tags + halyard) ──
const park = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId) ?? g.state.ships[0];
  const island = (g.state.islands ?? []).find((i) => i.dock
    && Math.hypot(i.dock.berthPosition.x - ship.position.x, i.dock.berthPosition.z - ship.position.z) < 60);
  return {
    ship: { x: ship.position.x, y: ship.position.y, z: ship.position.z, rot: ship.rotation, type: ship.type },
    dock: island ? { x: island.dock.position.x, z: island.dock.position.z, rot: island.dock.rotation, len: island.dock.length } : null,
  };
});
console.log('park:', JSON.stringify(park));
if (park.dock) {
  const mx = (park.ship.x + park.dock.x) / 2;
  const mz = (park.ship.z + park.dock.z) / 2;
  await freeLook([mx + 26, 20, mz + 26], [mx, 1, mz]);
  await wait(700); await shot('dock-park-aerial');
  await freeLook([park.ship.x + Math.cos(park.ship.rot) * 14, 5.5, park.ship.z - Math.sin(park.ship.rot) * 14], [park.ship.x, 3.2, park.ship.z]);
  await wait(700); await shot('dock-park-side');
}
// Close-up of the deck: station tags (ANCHOR / SAILS / HELM) + halyards.
await freeLook(
  [park.ship.x + Math.sin(park.ship.rot) * -6 + 8, 7.5, park.ship.z + Math.cos(park.ship.rot) * -6 + 8],
  [park.ship.x, 4.2, park.ship.z],
);
await wait(700); await shot('ship-station-tags');

// ── 2. Hole markers + deck repair chips (client-forced hull state, reapplied
//       every 30ms so the 10Hz snapshots can't scrub it) ──
await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  window.__holeForce = setInterval(() => {
    const ship = g.state.ships.find((s) => s.id === me?.shipId) ?? g.state.ships[0];
    if (!ship) return;
    ship.holes.port = 2; ship.hull.port = 1 - 2 / 3;
    ship.holes.bow = 1; ship.hull.bow = 1 - 1 / 3;
  }, 30);
});
await wait(900);
await freeLook(
  [park.ship.x - Math.cos(park.ship.rot) * 12, 2.2, park.ship.z + Math.sin(park.ship.rot) * 12],
  [park.ship.x, 0.6, park.ship.z],
);
await wait(700); await shot('hole-markers-port');
// Repair one hole (2 → 1) so a plank patch spawns, then look again.
await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  clearInterval(window.__holeForce);
  window.__holeForce = setInterval(() => {
    const ship = g.state.ships.find((s) => s.id === me?.shipId) ?? g.state.ships[0];
    if (!ship) return;
    ship.holes.port = 1; ship.hull.port = 1 - 1 / 3;
    ship.holes.bow = 0; ship.hull.bow = 1;
  }, 30);
});
await wait(900); await shot('hole-patched-port');
await freeLook(
  [park.ship.x + Math.sin(park.ship.rot) * -9, 8, park.ship.z + Math.cos(park.ship.rot) * -9],
  [park.ship.x, 3.5, park.ship.z],
);
await wait(700); await shot('repair-chips-deck');
await page.evaluate(() => clearInterval(window.__holeForce));

// ── 3. Tavern door: closed → open ──
const tav = await page.evaluate(() => {
  const g = window.__piratesBR;
  const island = (g.state.islands ?? []).find((i) => i.tavern);
  if (!island) return null;
  const t = island.tavern;
  return { x: t.position.x, y: t.position.y, z: t.position.z, rot: t.rotation, island: island.name, doors: g.tavernDoors.length };
});
console.log('tavern:', JSON.stringify(tav));
if (tav) {
  const fx = Math.sin(tav.rot), fz = Math.cos(tav.rot); // GLB front faces +Z, rotated by tavern yaw
  const camPos = [tav.x + fx * 9, tav.y + 2.4, tav.z + fz * 9];
  const camTgt = [tav.x + fx * 1.2, tav.y + 1.5, tav.z + fz * 1.2];
  await freeLook(camPos, camTgt);
  await wait(900); await shot('tavern-door-closed');
  await page.evaluate(() => { window.__piratesBR.tavernDoors.forEach((d) => { d.open = true; }); });
  await wait(1000); await shot('tavern-door-open');
  // From inside looking out (door swings clear of the frame)
  await freeLook([tav.x - fx * 2.2, tav.y + 1.7, tav.z - fz * 2.2], [tav.x + fx * 8, tav.y + 1.2, tav.z + fz * 8]);
  await wait(500); await shot('tavern-door-open-inside');
}

console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log('  ERR:', e);
await browser.close();
console.log(`probe shots in ${OUT}/`);
