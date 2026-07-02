// Quick visual tour: joins a solo bot match and captures screenshots at
// several moments. Requires the dev server to be running (npm run dev).
// Pointer lock never engages under Playwright, so the tour drives the camera
// through the InputManager.setLook debug hook instead of mouse deltas.
// Usage: node scripts/screenshot-tour.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/tour';
const GAME_URL = 'http://127.0.0.1:3000/?debug&quality=high';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const look = (yaw, pitch = -0.06) =>
  page.evaluate(([y, p]) => window.__piratesBR?.input?.setLook(y, p), [yaw, pitch]);

await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15_000 });
await shot('01-menu');
await page.click('#menu-solo-btn');
await page.waitForFunction(() => {
  const g = window.__piratesBR;
  return g?.state?.phase === 'playing';
}, { timeout: 30_000 });
await page.waitForTimeout(3000);
await shot('02-spawn');

// full look-around from the spawn point
for (let i = 0; i < 4; i++) {
  await look((i * Math.PI) / 2);
  await page.waitForTimeout(700);
  await shot(`03-look-${['a', 'b', 'c', 'd'][i]}`);
}

// walk toward the most open-looking heading, then re-survey
await look(Math.PI / 2);
await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
await shot('04-walked');

// board ship if possible via interact spam
for (let i = 0; i < 4; i++) { await page.keyboard.press('f'); await page.waitForTimeout(300); }
await page.waitForTimeout(2000);
await shot('05-after-interact');

await page.waitForTimeout(6000);
await look(Math.PI, -0.02);
await page.waitForTimeout(500);
await shot('06-later');

// zoom out via scroll for a wider shot, looking down slightly
await page.mouse.wheel(0, 600);
await look(Math.PI * 1.5, -0.25);
await page.waitForTimeout(800);
await shot('07-zoomed');

await browser.close();
console.log(`screenshots in ${OUT}/`);
