#!/usr/bin/env node
// test-elimination-spectate (b1.5f, liveplay-06). Browser, one headless
// SwiftShader Chromium on the 3101/8091 stack (PIRATES_BR_URL), or --own-stack
// to boot and kill its own. Drives a Solo match, puts the local pirate OUT
// (eliminated, the death card raised the way Game does when the hull is gone),
// then within 8 s asserts:
//   - the spectate banner is visible and names a subject
//   - the death card collapsed to a bottom bar (panel in the lower 45 %, the
//     centre of the screen not covered) with a NEXT SHIP button
//   - the frame behind it is not >95 % black
//   - the next-target key changes the subject
// Run: node scripts/test-elimination-spectate.mjs [--own-stack]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { readPng } from './lib/png-read.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWN = process.argv.includes('--own-stack');
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
let fails = 0;
const expect = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails++;
};
const kids = [];
const start = (cmd, env) => {
  const c = spawn(cmd, { cwd: REPO, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  kids.push(c);
};
const killAll = () => { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } };

let browser = null;
try {
  if (OWN) {
    start('npx tsx src/server/index.ts', { PORT: '8091', PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV: '1' });
    start('npx vite --port 3101 --strictPort', { PIRATES_BR_SERVER_PORT: '8091' });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE_URL}/`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  browser = await chromium.launch({ args: browserArgs() });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => {
    const g = window.__piratesBR;
    return !!(g?.hud && g.getLocalPlayer?.() && g.state?.ships?.length && g.state.players?.length > 2);
  }, null, { timeout: 120_000 });
  expect('a Solo match with other crews is live', true);

  // OUT OF THE VOYAGE. Snapshots rewrite the local player every tick, so the
  // eliminated state is re-asserted each frame, exactly as the server would.
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const hold = () => { const p = g.getLocalPlayer(); if (p) p.state = 'eliminated'; requestAnimationFrame(hold); };
    hold();
    g.returnToLobbyAfterLoss(0, 0, 'Your ship went down');
  });
  const t0 = Date.now();
  const bannerUp = await page.waitForFunction(() => {
    const b = document.getElementById('spectate-banner');
    return !!b && getComputedStyle(b).display !== 'none' && /watching/i.test(b.textContent ?? '');
  }, null, { timeout: 8_000 }).then(() => true, () => false);
  const tBanner = Date.now() - t0;
  expect('spectate banner names a subject within 8 s', bannerUp, `${tBanner} ms`);
  await page.waitForTimeout(2500); // let the spectate camera lift off the corpse

  const layout = await page.evaluate(() => {
    const panel = document.getElementById('death-panel')?.getBoundingClientRect();
    const next = document.getElementById('death-next-btn');
    return {
      spectating: document.body.classList.contains('spectating'),
      panelTop: panel ? panel.top : -1,
      panelBottom: panel ? panel.bottom : -1,
      vh: innerHeight,
      nextVisible: !!next && getComputedStyle(next).display !== 'none',
      subject: document.getElementById('spectate-line')?.textContent ?? '',
    };
  });
  expect('body is in the spectating state', layout.spectating);
  expect('death card is a bottom bar (panel top in the lower 45 %)', layout.panelTop >= layout.vh * 0.55, JSON.stringify(layout));
  expect('NEXT SHIP button shows on the bar', layout.nextVisible);

  const png = readPng(await page.screenshot({ type: 'png' }));
  let dark = 0; let n = 0;
  for (let y = 0; y < png.height * 0.55; y += 6) {
    for (let x = 0; x < png.width; x += 6) {
      const i = (y * png.width + x) * png.channels;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (lum < 12) dark++;
      n++;
    }
  }
  const darkPct = (100 * dark) / n;
  expect('the world behind the bar is not >95 % black', darkPct <= 95, `${darkPct.toFixed(1)} % near-black`);
  await page.screenshot({ path: '/tmp/pbr-b15f-spectate.png' });

  const before = layout.subject;
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.getElementById('spectate-line')?.textContent ?? '');
  expect('the next-target key changes the subject', after !== before && /watching/i.test(after), `"${before}" -> "${after}"`);
} catch (err) {
  expect('run completed', false, String(err?.message ?? err).split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  killAll();
}
console.log(fails ? `\n${fails} failure(s)` : '\nelimination -> spectate holds');
process.exit(fails ? 1 : 0);
