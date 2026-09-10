#!/usr/bin/env node
// PROBE, not a gate: are the rocks SOLID on the low tier, photographed at arm's
// length — 3 m from a boulder, 6 m from a sea stack, at eye height, noon — plus
// the same boulder from 60 m so the far sibling is in the frame too.
//
// Boots its OWN stack (server :8091 seed 20260801, Vite :3101), ONE headless
// Chromium at 960x540 on whatever `scripts/lib/browser-args.mjs` decides (the
// software rasteriser by default), and kills both in `finally`. Never :3000 or
// :8090 — a human plays there. Reads the live LOD state alongside each shot so
// the picture and the batch's `farApplied` flag can be checked against each other.
//
//   node scripts/probes/rock-solidity-shots.mjs <outDir> <label>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/rock-shots';
const LABEL = process.argv[3] ?? 'shot';
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const ROOT = process.cwd();
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; }
}

const started = [];
async function ensure(name, command, url, env, timeoutMs = 120_000) {
  if (await isUp(url)) { console.log(`[probe] ${name} already up at ${url} — reusing`); return; }
  console.log(`[probe] starting ${name} → ${url}`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  started.push({ name, child });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
async function teardown() {
  for (const { name, child } of started.splice(0).reverse()) {
    console.log(`[probe] stopping ${name}`);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(900);
    try { if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Camera targets, planned in-page off the pinned world. */
const PLAN = () => {
  const g = window.__piratesBR;
  const ground = (x, z) => g.sampleGroundY(x, z);
  const aim = (tx, ty, tz, dist, bearing, eyeY = null) => {
    const cx = tx + Math.sin(bearing) * dist;
    const cz = tz + Math.cos(bearing) * dist;
    const cy = eyeY ?? (Math.max(ground(cx, cz), 0.4) + 1.62);
    const dx = tx - cx; const dy = ty - cy; const dz = tz - cz;
    return { cam: { x: cx, y: cy, z: cz }, yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  };
  const out = [];
  // The biggest boulder on the first island that has any: deterministic on the seed.
  let pick = null;
  for (const island of g.state.islands) {
    const rocks = (island.props ?? []).filter((p) => p.type.startsWith('boulder_'));
    if (!rocks.length) continue;
    const r = rocks.reduce((a, b) => (b.scale > a.scale ? b : a));
    pick = { island, rock: r };
    break;
  }
  if (pick) {
    const { island, rock } = pick;
    const bearing = Math.atan2(rock.x - island.position.x, rock.z - island.position.z);
    const ty = ground(rock.x, rock.z) + 0.9 * rock.scale;
    out.push({ name: 'boulder-3m', island: island.id, batch: `props-${rock.type}`, ...aim(rock.x, ty, rock.z, 3.0 + rock.scale * 0.6, bearing),
      note: `${rock.type} scale=${rock.scale.toFixed(2)} on ${island.name}` });
    out.push({ name: 'boulder-60m', island: island.id, batch: `props-${rock.type}`, ...aim(rock.x, ty, rock.z, 60, bearing, null),
      note: `${rock.type} from 60 m` });
    // The sea stack nearest that island, from a swimmer's eye line 6 m off its edge.
    const near = (g.state.seaRocks ?? [])
      .map((rk) => ({ rk, d: Math.hypot(rk.position.x - island.position.x, rk.position.z - island.position.z) }))
      .sort((a, b) => a.d - b.d)[0]?.rk;
    if (near) {
      const b2 = Math.atan2(island.position.x - near.position.x, island.position.z - near.position.z);
      out.push({ name: 'searock-6m', rockId: near.id, ...aim(near.position.x, Math.max(1.5, near.height * 0.35), near.position.z, near.radius + 6, b2, 1.6),
        note: `sea stack r=${near.radius.toFixed(1)} h=${near.height.toFixed(1)}` });
    }
  }
  return out;
};

/** The live LOD verdict for the thing in frame. */
const READ_LOD = (shot) => {
  const g = window.__piratesBR;
  if (shot.batch) {
    const group = g.islandMeshes?.get(shot.island);
    const batches = (group?.userData?.instanceLodBatches ?? []).filter((b) => b.mesh.name === shot.batch);
    return batches.map((b) => ({ batch: b.mesh.name, farApplied: b.farApplied, usesFar: !!b.far && b.mesh.geometry === b.far.geometry, count: b.mesh.count, full: b.full }));
  }
  const mesh = g.seaRockMeshes?.get(shot.rockId);
  const lod = mesh?.userData?.seaRockLod;
  return lod ? [{ seaRock: shot.rockId, farApplied: lod.farApplied, nearVisible: lod.near.visible, farVisible: lod.far.visible }] : [{ seaRock: shot.rockId, lod: 'unreadable' }];
};

async function main() {
  console.log(`Rock solidity shots [${LABEL}] — GL: ${describeGl()}`);
  let browser;
  try {
    await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: SEED, PIRATES_BR_DEV_HOOKS: '1' });
    await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, `${CLIENT_URL}/`, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.log(`  [pageerror] ${err}`));
    await page.route('**/@vite/client*', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export default {};',
    }));
    await page.goto(`${CLIENT_URL}/?debug&quality=low&server=${SERVER_PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      const g = window.__piratesBR;
      g.setBotPeace?.(true);
      g.setDayNightOverride(854); // noon
      g.drainIslandBuildQueue(40);
    });
    // The canvas is body's first child (Renderer mounts it with insertBefore);
    // everything else in body is chrome — the HUD, the debug panel, the
    // ship's-orders card — and this audit is about pixels of rock, so hide it
    // all rather than chase ids.
    await page.addStyleTag({ content: 'body > *:not(canvas) { display: none !important; }' });
    await page.waitForTimeout(2500);
    const canvas = page.locator('canvas').first();
    const shots = await page.evaluate(PLAN);
    console.log(`[probe] quality=low ${shots.length} shots`);
    for (const shot of shots) {
      await page.evaluate((s) => {
        const g = window.__piratesBR;
        g.enableFreeCam(s.cam.x, s.cam.y, s.cam.z, s.yaw, s.pitch);
        g.settleLod?.();
      }, shot);
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.__piratesBR.settleLod?.());
      await page.waitForTimeout(5000);
      const lod = await page.evaluate(READ_LOD, shot);
      const file = path.join(OUT, `${LABEL}-${shot.name}.png`);
      await canvas.screenshot({ path: file, timeout: 120_000 });
      console.log(`  ${shot.name}  (${shot.note})  cam=(${shot.cam.x.toFixed(1)}, ${shot.cam.y.toFixed(1)}, ${shot.cam.z.toFixed(1)})\n     lod=${JSON.stringify(lod)}\n     → ${file}`);
    }
    await page.evaluate(() => window.__piratesBR.disableFreeCam());
    await page.close().catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    await teardown();
  }
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
