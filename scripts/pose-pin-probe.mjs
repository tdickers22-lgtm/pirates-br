// Deterministic weapon-pose captures: pins the cutlass reloadTimer (reapplied
// every 30ms so snapshots can't scrub it) at exact swing phases and screenshots
// each — no more racing a 0.55s animation with 200ms screenshot latency.
// node scripts/pose-pin-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/pose-pin';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 30_000 });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit4', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit4', bubbles: true })); });
await wait(500);

// Pin helper: force the local player's cutlass reload state at a given timer.
// Pin at the SOURCE: override the progress getter on the Game instance —
// re-writing weapon fields raced the 10Hz snapshot overwrites and half the
// rendered frames were unpinned.
const pin = (prog, kind) => page.evaluate(([t, k]) => {
  const g = window.__piratesBR;
  g.getCutlassSwingProgress = () => t;
  const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
  g.cutlassSwingKind.set(me.id, k);
}, [prog, kind]);

// BASIC SWING phases (0.55s total): progress = 1 - timer/0.55
for (const [name, prog] of [['cock', 0.1], ['cut', 0.3], ['through', 0.5], ['recover', 0.8]]) {
  await pin(prog, 'swing');
  await wait(150);
  // The pin's rising edge flips the side — force the side AFTER the flip.
  await page.evaluate(() => { window.__piratesBR.cutlassSlashSide = 1; });
  await wait(350);
  await shot(`slash-${name}`);
}
// Flip side and re-capture the cut.
await pin(0.3, 'swing');
await wait(150);
await page.evaluate(() => { window.__piratesBR.cutlassSlashSide = -1; });
await wait(350);
await shot('slash-cut-left');

// LUNGE phases
for (const [name, prog] of [['windup', 0.05], ['stab', 0.17], ['carry', 0.42]]) {
  await pin(prog, 'lunge');
  await wait(450);
  await shot(`dash-${name}`);
}
await page.evaluate(() => { delete window.__piratesBR.getCutlassSwingProgress; });
// Axe rest + chop midframe.
await page.evaluate(() => { window.__piratesBR.input.queueWheelSlot(9); });
await wait(800);
await shot('axe-rest');
await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
for (let f = 0; f < 5; f++) { await shot(`axe-f${f}`); await wait(90); }
await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
await browser.close();
console.log(`pose pins in ${OUT}/`);
