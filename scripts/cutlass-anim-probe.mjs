// Frame-captures the first-person cutlass BASIC SLASH and the CHARGE DASH
// with ?forceinput, so the new keyframed animation can be eyeballed.
// node scripts/cutlass-anim-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/cutlass-anim';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 30_000 });
const wait = (ms) => page.waitForTimeout(ms);
// Poke the InputManager directly — its listeners sit on document/canvas and
// gate on pointer lock; ?forceinput opens the lockedOrForced path so the
// mouseButtons set is all we need to drive fire.
const key = (code, down) => page.evaluate(([c, d]) => {
  document.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
}, [code, down]);
const mouse = (down) => page.evaluate((d) => {
  const input = window.__piratesBR.input;
  if (d) input.mouseButtons.add(0);
  else input.mouseButtons.delete(0);
}, down);

await page.goto('http://127.0.0.1:3000/?debug&forceinput&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));

// Draw the cutlass (weapon slot 4).
await key('Digit4', true); await wait(60); await key('Digit4', false);
await wait(500);
await shot('0-rest');

// BASIC SLASH ×2 (alternating diagonals): tap fire, capture through the swing.
for (let n = 1; n <= 2; n++) {
  await mouse(true); await wait(90); await mouse(false);
  for (let f = 0; f < 4; f++) {
    await shot(`slash${n}-f${f}`);
    await wait(60);
  }
  await wait(700);
}

// CHARGE DASH: hold to full charge (auto-lunge), capture through the dash.
const before = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return { x: me.position.x, z: me.position.z };
});
await mouse(true);
await shot('dash-charging');
await wait(1250); // CUTLASS_CHARGE_TIME → auto lunge
for (let f = 0; f < 5; f++) {
  await shot(`dash-f${f}`);
  await wait(70);
}
await mouse(false);
await wait(900);
const after = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return { x: me.position.x, z: me.position.z };
});
const travelled = Math.hypot(after.x - before.x, after.z - before.z);
console.log(`dash travel: ${travelled.toFixed(1)}m`);
await browser.close();
console.log(`cutlass anim frames in ${OUT}/`);
