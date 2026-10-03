// PROBE, not a gate: the STORY TOUR. One in-engine shot of each of the fifteen
// story tableaux (smuggler cache, wrecker tower, kraken wreck, ...) where the map
// actually puts it, so a rebuilt scene is judged in the world it lives in (seated
// on its island, under the game's light, fog and water) and not only on a Blender
// contact sheet. assets-12 / b5.1e.
//
// It stands up its OWN stack on 3101/8091 (never 3000/8090/8080: the owner plays
// there, and 8080 corrupts WebSockets on this Mac), launches ONE headless
// SwiftShader Chromium via scripts/lib/browser-args.mjs at 960x540, and kills
// all of it in `finally`. A stack already answering on those ports is refused,
// not borrowed.
//
//   node scripts/probes/story-tour-shots.mjs [outDir] [scene,scene,...]
//
// outDir defaults to docs/asset-sheets/story/ingame. Each scene writes
// <key>.jpg; tour.json records where the camera stood, whether the scene's GLB
// had arrived (the scenes are lazy: AssetLibrary.ensure() with priority, awaited
// before the shot, so a shot is never of the seated placeholder box), and a
// flat-frame flag (a one-colour grab compresses to almost nothing).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, process.argv[2] ?? 'docs/asset-sheets/story/ingame');
const ONLY = (process.argv[3] ?? '').split(',').filter(Boolean);
const SERVER_PORT = '8091';
const CLIENT_PORT = '3101';
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const LOG_DIR = path.join(ROOT, 'test-results', 'story-tour');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const STORY = [
  'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
  'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp',
  'kraken_wreck', 'dig_site', 'gallows', 'parley_table',
  'mine_head', 'widow_memorial', 'gibbet_cage',
];
// Camera distance (m) per scene: the big tableaux need the room.
const DIST = { gibbet_cage: 9, dig_site: 11, smuggler_cache: 11, kraken_wreck: 30, whale_skeleton: 22, wrecker_tower: 20, crow_roost: 18, mermaid_shrine: 20, mine_head: 18, widow_memorial: 17 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stack = [];
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; } }
async function standUp(name, command, url, env) {
  if (await isUp(url)) throw new Error(`${url} is already answering: this probe only drives a stack it started`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const log = createWriteStream(path.join(LOG_DIR, `stack-${name}.log`));
  child.stdout.pipe(log); child.stderr.pipe(log);
  stack.push(child);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(600)) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
  }
  throw new Error(`${name} never answered ${url}`);
}
function teardown() { for (const c of stack.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } } } }
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

let browser = null;
const results = [];
let code = 0;
try {
  console.log(`[story-tour] stack ${CLIENT_PORT}/${SERVER_PORT}, seed ${MAP_SEED}, ${describeGl()}`);
  await standUp('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await standUp('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });

  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio', '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));
  await page.goto(`${CLIENT_URL}/?debug`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 120_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  // GOTCHA: waitForFunction's options are the THIRD argument.
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 420_000 });
  await sleep(2000);
  await page.keyboard.press('KeyL');
  await page.evaluate(() => {
    const g = window.__piratesBR;
    g.setDayNightOverride(854); // noon: judge materials, not the night grade
    // Flat calm: a rolling storm phase greyed half the first tour (gibbet,
    // whale, wrecker shot under storm fog), which judges the weather, not the scene.
    g.setWeatherOverride?.(0);
    g.drainIslandBuildQueue(60);
    // The ?debug perf panel is styled inline and has no id the tag below reaches.
    g.debugPerfPanel?.style.setProperty('display', 'none', 'important');
  });
  await page.addStyleTag({ content: '#hud, #debug-perf, #interact-prompt, #crosshair, .hud-toast { display: none !important; }' });

  // Every story prop the map placed, with a camera standing seaward of it
  // (away from the island centre, so the hill behind it is the backdrop and
  // not the occluder), lifted above both the ground and the swell.
  const plan = await page.evaluate(({ STORY, DIST, ONLY }) => {
    const g = window.__piratesBR;
    const want = new Set(ONLY.length ? ONLY : STORY);
    const out = [];
    const seen = new Set();
    for (const island of g.state.islands ?? []) {
      for (const p of island.props ?? []) {
        if (!want.has(p.type) || seen.has(p.type)) continue;
        seen.add(p.type);
        const gy = g.sampleGroundY(p.x, p.z);
        const d = DIST[p.type] ?? 15;
        const out0 = Math.atan2(p.x - island.position.x, p.z - island.position.z);
        // Try a fan of bearings around "seaward"; keep the first whose eye is
        // not buried in a slope taller than the scene's own base.
        let best = null;
        for (const off of [0.55, -0.55, 0, 1.1, -1.1, 1.7, -1.7]) {
          const b = out0 + off;
          const cx = p.x + Math.sin(b) * d, cz = p.z + Math.cos(b) * d;
          const cg = g.sampleGroundY(cx, cz);
          const cy = Math.max(cg, 0.6, gy) + d * 0.32 + 1.6;
          if (cg < gy + d * 0.25) { best = { cx, cy, cz, b }; break; }
          if (!best) best = { cx, cy: cg + d * 0.32 + 1.6, cz, b };
        }
        const ty = gy + 1.8;
        const dx = p.x - best.cx, dy = ty - best.cy, dz = p.z - best.cz;
        out.push({
          key: p.type, island: island.name ?? island.id,
          at: { x: +p.x.toFixed(1), y: +gy.toFixed(2), z: +p.z.toFixed(1) },
          cam: { x: best.cx, y: best.cy, z: best.cz },
          yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)),
        });
      }
    }
    return out;
  }, { STORY, DIST, ONLY });
  const missing = (ONLY.length ? ONLY : STORY).filter((k) => !plan.some((s) => s.key === k));
  console.log(`[story-tour] ${plan.length} scenes placed on this map${missing.length ? `; not on this map: ${missing.join(', ')}` : ''}`);

  const canvas = page.locator('canvas').first();
  for (const s of plan) {
    const t0 = Date.now();
    await page.evaluate((s) => window.__piratesBR.enableFreeCam(s.cam.x, s.cam.y, s.cam.z, s.yaw, s.pitch), s);
    // The scene is lazy: ask for it with priority and wait for the real GLB,
    // so the shot is never the seated placeholder box.
    const loaded = await page.evaluate(async (key) => {
      try {
        const mod = await import('/src/client/assets/AssetLibrary.ts');
        await Promise.race([mod.assets.ensure(key, true), new Promise((r) => setTimeout(r, 90_000))]);
        return mod.assets.has(key);
      } catch (e) { return `unknown (${String(e).slice(0, 80)})`; }
    }, s.key);
    await sleep(1500);
    await page.evaluate(() => { const g = window.__piratesBR; g.drainIslandBuildQueue?.(10); g.settleLod?.(2); });
    await sleep(2500);
    const file = path.join(OUT, `${s.key}.jpg`);
    await canvas.screenshot({ path: file, type: 'jpeg', quality: 84, timeout: 120_000 });
    const bytes = statSync(file).size;
    const flat = bytes < 18_000;
    results.push({ ...s, loaded, bytes, flat, ms: Date.now() - t0 });
    console.log(`  ${s.key.padEnd(16)} ${String(s.island).padEnd(20)} loaded=${loaded} ${(bytes / 1024).toFixed(0).padStart(4)} KB ${((Date.now() - t0) / 1000).toFixed(0)}s${flat ? '  <-- SUSPECT FLAT' : ''}`);
  }
  await page.evaluate(() => window.__piratesBR.disableFreeCam());
  writeFileSync(path.join(OUT, 'tour.json'), JSON.stringify({ seed: MAP_SEED, gl: describeGl(), viewport: '960x540', missing, shots: results }, null, 1) + '\n');
  const bad = results.filter((r) => r.flat || r.loaded === false);
  console.log(`[story-tour] ${results.length} shots -> ${path.relative(ROOT, OUT)}${bad.length ? `; ${bad.length} suspect: ${bad.map((r) => r.key).join(', ')}` : ''}`);
  if (bad.length || !results.length) code = 1;
} catch (err) {
  console.error(`[story-tour] ${err?.stack ?? err}`);
  code = 1;
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  teardown();
}
process.exit(code);
