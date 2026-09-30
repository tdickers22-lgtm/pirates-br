#!/usr/bin/env node
/**
 * ALLOCATION PROFILE (b3 gate): which call sites allocate per CPU frame.
 *
 * test-frame-allocation says HOW MUCH a settled frame allocates; this says WHO.
 * Joins a solo match at one quality tier, settles like the suite does, then
 * runs benchFrameCpu under the V8 sampling heap profiler (collected objects
 * included) and prints KB/frame per self call site with its two callers.
 *
 *   PIRATES_BR_URL=http://127.0.0.1:3101 PIRATES_BR_SERVER_PORT=8091 \
 *     node scripts/probes/alloc-profile.mjs [low|high] [frames]
 *
 * Needs a running client + server (the gate stack). One headless SwiftShader
 * browser, closed in finally.
 */
import { chromium } from 'playwright';
import process from 'node:process';
import { browserArgs } from '../lib/browser-args.mjs';
import { sessionQuery } from '../perf-probe.mjs';

const ROOT_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
const quality = process.argv[2] ?? 'low';
const FRAMES = Number(process.argv[3] ?? 600);

const browser = await chromium.launch({
  args: browserArgs(['--mute-audio', '--js-flags=--expose-gc', '--enable-precise-memory-info',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  await page.goto(`${ROOT_URL}/?${sessionQuery(['debug', `quality=${quality}`])}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
  await page.waitForTimeout(12_000);
  await page.evaluate(() => window.__piratesBR.setBotPeace(true));
  await page.evaluate(() => window.__piratesBR.settleLod(2));
  await page.waitForTimeout(4000);
  const WARM = Number(process.env.PBR_ALLOC_WARM ?? 120);
  if (WARM > 0) await page.evaluate((n) => window.__piratesBR.benchFrameCpu(n, 1 / 60), WARM);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  await page.evaluate((n) => window.__piratesBR.benchFrameCpu(n, 1 / 60), FRAMES);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');

  const short = (cf) => `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/src\//, '').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
  const rows = new Map();
  let total = 0;
  const walk = (node, stack) => {
    const here = [short(node.callFrame), ...stack];
    if (node.selfSize > 0 && node.callFrame.url) {
      const key = here.slice(0, 3).join('  <  ');
      rows.set(key, (rows.get(key) ?? 0) + node.selfSize);
      total += node.selfSize;
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  walk(profile.head, []);
  console.log(`[${quality}] PROFILE total ${(total / FRAMES / 1024).toFixed(1)} KB/frame over ${FRAMES} frames`);
  for (const [k, v] of [...rows].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${(v / FRAMES / 1024).toFixed(2).padStart(6)} KB/f  ${k}`);
  }
} finally {
  await browser.close();
}
