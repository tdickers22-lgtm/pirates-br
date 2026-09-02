#!/usr/bin/env node
// WHICH PROGRAMS LINK DURING PLAY, AND WHAT PUT THEM ON THE SCREEN.
//
// Lever 1 of docs/FRAME_COST_MODEL.md, made specific. The profile already said
// shader links dominate the hitch census; this run names the programs, stamps
// each one against first control, and says which material and which object took
// the join — so a warm pass can be aimed rather than guessed.
//
//   PIRATES_GL=swiftshader PIRATES_BR_MAP_SEED=20260801 PIRATES_BR_SERVER_PORT=8091 \
//     node scripts/perf-program-census.mjs --quality high --seconds 120 \
//       --url http://127.0.0.1:3101 --out /tmp/programs-high.json
//
// The framebuffer is collapsed by default (pixel ratio 0.1). A program's cache
// key does not depend on how many pixels it covers, and on the software
// rasteriser a full-resolution frame is seconds long — a two-minute capture at
// ratio 1 is a hundred frames of play, which is not a session, it is a photo.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from '../perf-probe.mjs';
import { PROGRAM_CENSUS_SOURCE } from '../lib/program-census.mjs';
import { ensureDevClient, stopDevClient } from '../lib/dev-client.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3101')).replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const SECONDS = parseInt(arg('seconds', '120'), 10);
const RATIO = parseFloat(arg('ratio', '0.1'));
const OUT = arg('out', null);
const VIEWPORT = { width: 960, height: 540 };

/** The same pirate the frame profile drives, so the two captures describe one
 *  session: walk, sprint, strafe, jump, swing, and a yaw sweep every frame —
 *  turning is what brings new material into view, which is the whole subject. */
const DRIVE = `
window.__drive = {
  stop: false,
  async run(ms) {
    const g = window.__piratesBR;
    try { g.input.locked = true; } catch {}
    const key = (type, code) => document.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const look = (dx, dy) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }));
    const click = (down) => document.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: 0, bubbles: true }));
    const t0 = performance.now();
    let phase = -1;
    const held = new Set();
    const press = (code) => { if (!held.has(code)) { held.add(code); key('keydown', code); } };
    const release = (code) => { if (held.has(code)) { held.delete(code); key('keyup', code); } };
    while (!this.stop && performance.now() - t0 < ms) {
      const t = performance.now() - t0;
      look(Math.sin(t / 900) * 9, Math.sin(t / 2300) * 2.2);
      const seg = Math.floor(t / 4000) % 6;
      if (seg !== phase) {
        phase = seg;
        for (const c of [...held]) release(c);
        if (seg === 0) press('KeyW');
        if (seg === 1) { press('KeyW'); press('ShiftLeft'); }
        if (seg === 2) { press('KeyA'); }
        if (seg === 3) { press('KeyS'); }
        if (seg === 4) { press('KeyD'); press('Space'); }
        if (seg === 5) { press('KeyW'); }
      }
      if (Math.floor(t / 1500) % 4 === 0) { click(true); setTimeout(() => click(false), 140); }
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (const c of [...held]) release(c);
    return true;
  },
};
`;

async function main() {
  const port = SERVER_PORT ?? '8090';
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!h) { console.error(`no game server on :${port}`); process.exit(2); }
  console.log(`Program census — GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}`);
  if (!h.mapSeed) console.log('  WARNING: unpinned map — two runs will not be the same world');

  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);

  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  // A merged program is only a saving if it still COMPILES. checkShaderErrors is
  // off in play, but ProgramWarmer turns it on for every link it takes itself,
  // so any GLSL this run breaks is reported through the console — and a run that
  // silently rendered black would otherwise look like a very good result.
  const shaderErrors = [];
  page.on('console', (m) => {
    const text = m.text();
    if (!/WebGLProgram|WebGLShader|ERROR:|shader/i.test(text)) return;
    if (!/error/i.test(text)) return;
    shaderErrors.push(text.slice(0, 400));
    console.error(`  [shader] ${text.slice(0, 300)}`);
  });

  const report = { at: new Date().toISOString(), quality: QUALITY, gl: describeGl(), mapSeed: h.mapSeed, seconds: SECONDS, ratio: RATIO };
  try {
    // Before ANY page script: a program linked by the menu background must be
    // in the census too, and it is created before the game object exists.
    await page.addInitScript(PROGRAM_CENSUS_SOURCE);
    await page.goto(`${URL}/?${sessionQuery(['debug', 'forceinput', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.evaluate(() => window.__programCensus.setPhase('load'));
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    // The draw wrapper needs a renderer, and the renderer exists as soon as the
    // game does — installed the moment the match is up, which is well before the
    // capture window opens.
    console.log(`  draw attribution installed: ${await page.evaluate(() => window.__programCensus.installDraw())}`);
    await page.waitForTimeout(10_000);
    const pinned = await page.evaluate((r) => {
      const rend = window.__piratesBR?.renderer;
      if (!rend) return null;
      rend.minPixelRatio = r; rend.maxPixelRatio = r; rend.applyPixelRatio(r);
      return [rend.renderer.domElement.width, rend.renderer.domElement.height];
    }, RATIO);
    console.log(`  framebuffer ${pinned ? pinned.join('x') : '(unpinned)'}`);
    await page.waitForTimeout(3000);

    const preload = await page.evaluate(() => window.__programCensus.summary());
    console.log(`  before first control: ${preload.counters.joins} joins, ${preload.totalKeys} keys, ${preload.livePrograms} live programs`);

    await page.evaluate((src) => { (0, eval)(src); }, DRIVE);
    const controlAt = await page.evaluate(() => window.__programCensus.markControl());
    console.log(`\n── playing for ${SECONDS}s from first control (t=${Math.round(controlAt)}ms) ──`);
    await page.evaluate((ms) => window.__drive.run(ms), SECONDS * 1000);

    const summary = await page.evaluate(() => window.__programCensus.summary());
    report.preload = preload;
    report.summary = summary;
    report.shaderErrors = shaderErrors;
    if (shaderErrors.length > 0) console.error(`\n!! ${shaderErrors.length} shader errors — a merged program that does not compile is not a saving`);

    console.log(`\ntotal program keys: ${summary.totalKeys}   live programs: ${summary.livePrograms}`);
    console.log(`links issued: ${summary.counters.links}   joins: ${summary.counters.joins} (${summary.counters.joinsInDraw} inside a draw, ${summary.counters.joinsOutsideDraw} warmed)`);
    for (const [phase, row] of Object.entries(summary.byPhase)) {
      console.log(`  ${phase.padEnd(14)} joins ${String(row.joins).padStart(4)}  keys ${String(row.keys).padStart(4)}  ${String(row.ms).padStart(7)}ms  worst ${row.worstMs}ms`);
    }
    // The inventory, grouped by three's own custom cache key (the last field of
    // getProgramCacheKey) — which is where this codebase's material families
    // announce themselves, and where a family that mints one program per float
    // value shows up as a column of near-identical rows.
    const family = (key) => {
      const tail = String(key).split(',').pop() ?? '';
      return tail.startsWith('onBeforeCompile') ? '(none)' : tail;
    };
    const byFamily = new Map();
    for (const e of summary.all) {
      const f = `${String(e.cacheKey).split(',')[0]} · ${family(e.cacheKey)}`;
      const row = byFamily.get(f) ?? { keys: new Set(), joins: 0, ms: 0, materials: new Set() };
      row.keys.add(e.cacheKey); row.joins += 1; row.ms += e.ms + e.preMs; row.materials.add(e.materialName || e.material);
      byFamily.set(f, row);
    }
    console.log('\nPROGRAM INVENTORY by shader family (keys / joins / ms):');
    for (const [f, row] of [...byFamily.entries()].sort((a, b) => b[1].keys.size - a[1].keys.size)) {
      console.log(`  ${String(row.keys.size).padStart(3)} keys ${String(row.joins).padStart(3)} joins ${String(Math.round(row.ms)).padStart(6)}ms  ${f}`);
    }

    const play = summary.play;
    console.log(`\nLINKED DURING PLAY: ${play.length}  (${Math.round(play.reduce((s, e) => s + e.ms, 0))}ms of joins)`);
    for (const e of play.slice(0, 60)) {
      console.log(`  ${String(e.ms).padStart(8)}ms  t+${String(e.atMs).padStart(6)}ms  ${(e.material + ' ' + (e.materialName || '')).slice(0, 34).padEnd(35)} ${(e.object || '').slice(0, 26).padEnd(27)} ${e.why}`);
      console.log(`            in: ${e.parents}`);
      console.log(`            key: ${e.cacheKey.slice(0, 150)}`);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    stopDevClient(client);
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
