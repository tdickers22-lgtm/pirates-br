#!/usr/bin/env node
// controls-page-smoke (b1-ask-08, b1.4g2). One headless SwiftShader Chromium
// on the 3101/8091 stack (PIRATES_BR_URL), or --own-stack to boot and kill its
// own. Opens Settings > Controls from the menu and asserts in the real DOM:
//   - the page mounted (#controls-settings) with keyboard rebind buttons
//   - rebinding Jump to Interact's key SWAPS the two (conflict = swap), the
//     buttons re-render, the status line says so, and it persists in storage
//   - Reset puts both back
//   - the Left-handed toggle flips #touch-controls.tc-lefty and persists
// Writes a 960x540 PNG of the page for the gate report.
// Run: node scripts/probes/controls-page-smoke.mjs [--own-stack] [--shot out.png]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserArgs } from '../lib/browser-args.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWN = process.argv.includes('--own-stack');
const shotIdx = process.argv.indexOf('--shot');
const SHOT = shotIdx > 0 ? process.argv[shotIdx + 1] : '/tmp/pbr-controls-page.png';
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
let failures = 0;
const expect = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const kids = [];
const start = (cmd, env) => {
  const c = spawn(cmd, { cwd: REPO, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  kids.push(c);
};
const killAll = () => { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } };

let browser;
try {
  if (OWN) {
    start('npx tsx src/server/index.ts', { PORT: '8091', PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV: '1' });
    start('npx vite --port 3101 --strictPort', { PIRATES_BR_SERVER_PORT: '8091' });
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      try { if ((await fetch(`${BASE_URL}/`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  browser = await chromium.launch({ args: browserArgs() });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e)));
  await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#menu-settings-btn', { timeout: 60_000 });
  await page.click('#menu-settings-btn');
  await page.waitForSelector('#controls-settings', { state: 'attached', timeout: 15_000 });
  const mounted = await page.evaluate(() => {
    const root = document.getElementById('controls-settings');
    const r = root?.getBoundingClientRect();
    return { buttons: document.querySelectorAll('[data-rebind$=":keyboard"]').length, w: r?.width ?? 0, h: r?.height ?? 0 };
  });
  expect('Settings > Controls mounted with keyboard rebind buttons', mounted.buttons >= 10 && mounted.w > 0 && mounted.h > 0, JSON.stringify(mounted));

  const label = (a) => page.$eval(`[data-rebind="${a}:keyboard"]`, (b) => b.textContent?.trim() ?? '');
  const before = { jump: await label('jump'), interact: await label('interact') };
  await page.$eval('[data-rebind="jump:keyboard"]', (b) => b.scrollIntoView({ block: 'center' }));
  await page.click('[data-rebind="jump:keyboard"]');
  const waiting = await label('jump');
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(150);
  const after = { jump: await label('jump'), interact: await label('interact') };
  const status = await page.$eval('#controls-rebind-status', (s) => s.textContent ?? '');
  expect('rebind capture shows "Press a key"', /press a key/i.test(waiting), waiting);
  expect('Jump -> the Interact key swaps the two (conflict = swap)', after.jump === before.interact && after.interact === before.jump,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  expect('the status line names the swap', status.length > 0, status);
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => /bind/i.test(k)).map((k) => localStorage.getItem(k) ?? '').join(' '));
  expect('the rebind persists in localStorage', /KeyX/.test(stored), stored.slice(0, 120));

  await page.$eval('#controls-settings', (r) => r.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: SHOT });
  console.log(`  shot ${SHOT}`);

  await page.click('#controls-reset-bindings');
  await page.waitForTimeout(150);
  const reset = { jump: await label('jump'), interact: await label('interact') };
  expect('Reset restores both bindings', reset.jump === before.jump && reset.interact === before.interact, JSON.stringify(reset));

  const lefty = await page.evaluate(async () => {
    const box = document.getElementById('controls-left-handed');
    if (!box) return { found: false };
    box.click();
    await new Promise((r) => setTimeout(r, 100));
    const tc = document.getElementById('touch-controls');
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join(' ');
    const out = { found: true, checked: box.checked, overlay: !!tc, lefty: !!tc?.classList.contains('tc-lefty'), stored: /"leftHanded":true/.test(stored) };
    box.click();
    return out;
  });
  expect('Left-handed toggle checks, persists, and (when the overlay exists) flips tc-lefty',
    lefty.found && lefty.checked && lefty.stored && (!lefty.overlay || lefty.lefty), JSON.stringify(lefty));
  expect('0 page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  uncaught: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  killAll();
}
console.log(failures ? `\ncontrols page smoke: ${failures} failure(s)` : '\ncontrols page smoke holds');
process.exit(failures ? 1 : 0);
