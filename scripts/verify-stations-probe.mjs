// Live verification of the station-space pass:
//  1. deck overview — ammo crate visible aft of the (narrower) companionway,
//     cannons amidships on the sloop, nothing floating over the stair hole
//  2. cannon mount: walk to the gun, [X] via intent, MUST stay on deck (not water)
//  3. stairwell: walk onto the hole from the SIDE — must descend, not glass-floor
//  4. supply wheel page flip: I → items, Q → quest maps panel
// node scripts/verify-stations-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/verify-stations';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

await page.goto('http://127.0.0.1:3000/?debug&forceinput&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(400);

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return {
    me: { x: +me.position.x.toFixed(2), y: +me.position.y.toFixed(2), z: +me.position.z.toFixed(2), state: me.state, onShipId: me.onShipId, atCannon: me.atCannon },
    ship: ship ? { x: ship.position.x, y: ship.position.y, z: ship.position.z, rot: ship.rotation, type: ship.type } : null,
    prompt: document.getElementById('interact-prompt')?.textContent ?? '',
  };
});

// Helper: walk to a ship-local point via live world conversion each step.
async function walkToLocal(lx, lz, maxSteps = 120) {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(([tx, tz]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship) return 999;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + tx * cos + tz * sin;
      const wz = ship.position.z + tz * cos - tx * sin;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      g.input.setLook(Math.atan2(dx, dz), -0.35);
      if (Math.hypot(dx, dz) > 0.35) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
      return Math.hypot(dx, dz);
    }, [lx, lz]);
    if (d < 0.35) break;
    await wait(90);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(250);
}

// ── 1. Deck overview from above ──
const s0 = await snap();
await page.evaluate(([sx, sy, sz, rot]) => {
  const g = window.__piratesBR;
  g.enableFreeCam(sx + Math.sin(rot + 2.4) * 10, sy + 12, sz + Math.cos(rot + 2.4) * 10, rot + 2.4 + Math.PI, -0.85);
}, [s0.ship.x, s0.ship.y, s0.ship.z, s0.ship.rot]);
await wait(700); await shot('1-deck-overview');
await page.evaluate(([sx, sy, sz, rot]) => {
  const g = window.__piratesBR;
  // low from astern toward the hatch/ammo crate band
  g.enableFreeCam(sx - Math.sin(rot) * 7, sy + 4.5, sz - Math.cos(rot) * 7, rot, -0.28);
}, [s0.ship.x, s0.ship.y, s0.ship.z, s0.ship.rot]);
await wait(600); await shot('1b-deck-aft-band');
await page.evaluate(() => window.__piratesBR.disableFreeCam?.());
await wait(300);

// ── 2. Cannon mount from the STARBOARD gun (the historical overboard case) ──
const stats = { sloop: { w: 5, l: 12 } }[s0.ship.type] ?? { w: 5, l: 12 };
const cannonLocal = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return g.getCannonDeckLocalPosition
    ? g.getCannonDeckLocalPosition(ship.type, 0)
    : null;
});
// fall back to shared formula: sloop single-per-side → z=0, x=walkHalf(0)-0.45
const cx = cannonLocal?.x ?? 1.58;
const cz = cannonLocal?.z ?? 0;
await walkToLocal(cx - 0.4, cz);
const beforeMount = await snap();
console.log('before mount:', JSON.stringify(beforeMount));
await shot('2-at-cannon');
// press X with the cannon intent (mirrors the real client path)
await page.evaluate(() => {
  const g = window.__piratesBR;
  g.pendingInteractFromUi = true;
});
await wait(600);
const afterMount = await snap();
console.log('after mount:', JSON.stringify(afterMount));
await shot('2b-mounted');
const mountedOk = afterMount.me.atCannon && afterMount.me.state !== 'swimming';
console.log(mountedOk ? 'CANNON MOUNT OK (on deck, manning gun)' : 'CANNON MOUNT FAILED');
// dismount
await page.evaluate(() => { window.__piratesBR.pendingInteractFromUi = true; });
await wait(400);

// ── 3. Stairwell descent from the SIDE ──
// Stand beside the hatch (port of it), then strafe onto the hole: y must drop.
const hatch = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return { type: ship.type };
});
const cw = { cx: 5 * 0.05, cz: 12 * 0.08, halfZ: Math.max(1.4, 12 * 0.13) };
await walkToLocal(cw.cx, cw.cz + cw.halfZ + 0.8); // front lip
const atLip = await snap();
await walkToLocal(cw.cx, cw.cz - 0.4);            // into the well
await wait(500);
const inWell = await snap();
console.log('stair lip y:', atLip.me.y, '→ in well y:', inWell.me.y);
const descended = inWell.me.y < atLip.me.y - 0.5;
console.log(descended ? 'STAIR DESCENT OK' : 'STAIR DESCENT FAILED (glass floor)');
await shot('3-stairwell');

// ── 4. Supply wheel pages ──
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI', bubbles: true }));
});
await wait(350); await shot('4-wheel-items');
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
});
await wait(350); await shot('4b-wheel-maps');
const pages = await page.evaluate(() => ({
  items: document.getElementById('pocket-wheel')?.classList.contains('visible'),
  maps: document.getElementById('map-wheel')?.classList.contains('visible'),
  mapsHtml: document.getElementById('map-wheel-list')?.textContent ?? '',
}));
console.log('wheel pages:', JSON.stringify(pages));
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyI', bubbles: true }));
});

console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 6)) console.log('  ERR:', e);
await browser.close();
console.log(`shots in ${OUT}/`);
