#!/usr/bin/env node
// THE SHADOW PASS RUNS WHEN THERE IS SOMETHING TO DRAW, AND ONLY THEN.
//
// The gate in Renderer skips the depth pass whenever it last drew zero casters:
// out on open water the 310 m ortho box is empty and the map was being cleared
// in full every frame for nothing. Skipping is only safe because a pass that
// drew nothing leaves the map at its clear value, which every lookup reads as
// lit wherever the light matrix has since moved.
//
// WHAT THIS GATE EXISTS TO CATCH, because it happened. `FullScreenQuad.render()`
// is `renderer.render(quadScene, quadCamera)`, and the post chain does fourteen
// of those a frame. Each arrives at `WebGLShadowMap.render` with an empty
// shadow-light array, "runs" a pass, draws nothing — and the first version of
// the gate counted that as "the world has no casters". Measured on a dock vista
// with 226 casters in the box: `lastCasterDraws` pinned at 0 forever and 12 of
// every 15 passes skipped. Nothing in the counts said so; the frame's draw
// total moved by the right order of magnitude for the wrong reason, and the
// only tell was a pass-split table that had put the shadow draws under `post`.
//
// So this asserts the two halves separately, on the live client:
//   1. at a stand that HAS casters, every frame runs a real pass and reports
//      them, and nothing is skipped;
//   2. at open water, the pass reports zero casters.
//
// It does NOT assert a skip count. The skip window is bounded in TIME as well
// as in frames (250 ms, so a machine mid-load cannot go ten of its one-second
// frames without shadows), and under software ANGLE a single frame is longer
// than that window — so on this backend the gate is correct and never gets to
// skip. That is a property of the rasteriser, not of the code, and a threshold
// invented to make it assertable here would be a threshold about SwiftShader.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8091 node scripts/test-shadow-gate.mjs
import { chromium } from 'playwright';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { planScenes, readWorld, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

const URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const FRAMES = 12;

let failures = 0;
function expect(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function main() {
  if (!await health()) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}.`);
    process.exit(2);
  }
  console.log(`Shadow-pass gate — GL: ${describeGl()}`);
  const client = await ensureDevClient(`${URL}/`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
    // 'high' on purpose: it is the tier with a shadow map AND a post chain, and
    // the defect above needs both in the same frame to appear at all.
    await page.goto(`${URL}/?${sessionQuery(['debug', 'quality=high'])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    const plan = planScenes(await readWorld(page));
    const sample = async (cam) => {
      await page.evaluate((c) => {
        const g = window.__piratesBR;
        const yaw = c.aimAt ? Math.atan2(c.aimAt.x - c.x, c.aimAt.z - c.z) : c.yaw;
        const y = c.y ?? ((g.sampleGroundY(c.x, c.z) ?? 0) + (c.groundOffset ?? 1.7));
        g.enableFreeCam(c.x, y, c.z, yaw, c.pitch);
        g.setDayNightOverride(854);
        g.settleLod?.();
      }, cam);
      return page.evaluate((frames) => new Promise((resolve) => {
        const g = window.__piratesBR;
        const first = g.renderer.getShadowPassStats();
        let i = 0;
        const step = () => {
          if (++i >= frames) {
            const last = g.renderer.getShadowPassStats();
            resolve({
              casters: last.lastCasterDraws,
              mapSize: last.mapSize,
              run: last.run - first.run,
              skipped: last.skipped - first.skipped,
              frames,
            });
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }), FRAMES);
    };

    console.log('\nA STAND WITH CASTERS — the pass runs, and reports them');
    const dock = await sample(plan['dock-vista']);
    console.log(`    dock-vista: ${dock.casters} casters, map ${dock.mapSize}, ${dock.run} passes run / ${dock.skipped} skipped over ${dock.frames} frames`);
    expect('the tier opens on a shadow map at all', dock.mapSize > 0, `mapSize ${dock.mapSize}`);
    expect('…and it is not the 4096 the fill pass cut', dock.mapSize <= 2048, `mapSize ${dock.mapSize}`);
    expect('the depth pass draws the island in front of the camera',
      dock.casters > 20, `lastCasterDraws ${dock.casters}`);
    expect('…and nothing is skipped where there is something to draw',
      dock.skipped === 0, `${dock.skipped} of ${dock.frames} frames skipped`);
    expect('…and the pass runs about once per rendered frame — not once per post-chain quad',
      dock.run >= 1 && dock.run <= dock.frames + 2, `${dock.run} passes over ${dock.frames} frames`);

    console.log('\nOPEN WATER — the box is empty and the gate can see that it is');
    const sea = await sample(plan['open-sea']);
    console.log(`    open-sea: ${sea.casters} casters, ${sea.run} passes run / ${sea.skipped} skipped over ${sea.frames} frames`);
    expect('the depth pass reports an empty box out at sea', sea.casters === 0, `lastCasterDraws ${sea.casters}`);
  } finally {
    await browser.close().catch(() => {});
    stopDevClient(client);
  }
  console.log(failures ? `\n${failures} shadow-gate check(s) FAILED` : '\nShadow-pass gate checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
