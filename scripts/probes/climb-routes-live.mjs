import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
// b4.7b live look at the climb routes: one headless SwiftShader Chromium on
// 3101/8091 (seed 20260801), everything killed in finally. Counts the merged
// route meshes per island (2 draws max) and frames a ladder, a rope and a
// mast-free cliff route from 9 m off the face in daylight.
// Usage: node scripts/probes/climb-routes-live.mjs [outDir]
const OUT = process.argv[2] ?? 'test-results/climb-routes-live';
const LIMIT = Number(process.env.INLAND_FLOAT_LIMIT ?? 0.25);
const SERVER_PORT = '8091';
const CLIENT_PORT = '3101';
const BASE = `http://127.0.0.1:${CLIENT_PORT}`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; }
}
const kids = [];
async function start(name, cmd, url, env) {
  if (await up(url)) throw new Error(`${url} already answering: refusing to grade someone else's stack`);
  const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  kids.push(child);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    if (await up(url)) { console.log(`  ${name} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`); return; }
    if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}`);
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
function stopAll() {
  for (const c of kids.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } } }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });

let browser = null;
const shots = [];
let report = null;
let fail = [];
try {
  console.log(`climb-routes live probe, ${describeGl()}`);
  await start('server', 'npm run dev:server', `http://127.0.0.1:${SERVER_PORT}/health`, {
    PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV_HOOKS: '1',
  });
  await start('client', `npx vite --port ${CLIENT_PORT} --strictPort`, BASE, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });

  browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e}`));
  await page.routeWebSocket((u) => new URL(u).host === new URL(BASE).host, () => {});
  await page.goto(`${BASE}/?debug&quality=high`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 180_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const e = document.createElement('style');
    e.textContent = '#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}#hud{visibility:hidden!important;}'
      + '#disconnect-overlay,[class*="overload"]{visibility:hidden!important;}';
    document.head.appendChild(e);
    document.getElementById('oc-skip')?.click();
    const g = window.__piratesBR;
    g.setDayNightOverride(854);
    g.drainIslandBuildQueue?.(40);
  });
  await page.waitForFunction(
    () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99), null, { timeout: 120_000 },
  ).catch(() => {});
  await page.evaluate(() => window.__piratesBR.settleLod?.(2));
  await page.waitForTimeout(2000);
  report = await page.evaluate(() => {
    const g = window.__piratesBR;
    const islands = g.state.islands;
    const perIsland = [];
    const targets = [];
    for (const isl of islands) {
      const grp = g.islandMeshes.get(isl.id);
      const meshes = [];
      grp?.traverse((o) => { if (o.name === 'climb-routes' || o.name === 'climb-ropes') meshes.push({ name: o.name, tris: (o.geometry.index?.count ?? 0) / 3, visible: o.visible }); });
      const climbs = isl.climbs ?? [];
      perIsland.push({ id: isl.id, routes: climbs.length, meshes });
      for (const c of climbs) targets.push({ island: isl.id, id: c.id, kind: c.kind, pts: c.pts, nx: c.nx, nz: c.nz, ay: c.ay, by: c.by });
    }
    return { perIsland, targets };
  });
  const pick = [];
  for (const k of ['ladder', 'rope']) {
    const list = report.targets.filter((t) => t.kind === k).sort((a, b) => (b.by - b.ay) - (a.by - a.ay));
    pick.push(...list.slice(0, 2));
  }
  for (const t of pick) {
    await page.evaluate((c) => {
      const g = window.__piratesBR;
      const n = c.pts.length / 3; const m = (n >> 1) * 3;
      const mx = c.pts[m], my = c.pts[m + 1], mz = c.pts[m + 2];
      const px = mx + c.nx * 9 + -c.nz * 3, py = my + 2, pz = mz + c.nz * 9 + c.nx * 3;
      const dx = mx - px, dy = my - py, dz = mz - pz; const L = Math.hypot(dx, dy, dz);
      g.enableFreeCam(px, py, pz, Math.atan2(dx / L, dz / L), Math.asin(dy / L));
      g.settleLod?.(2);
    }, t);
    await page.waitForTimeout(1800);
    const path = `${OUT}/${t.id}.png`;
    await page.screenshot({ path, timeout: 120_000 });
    shots.push({ id: t.id, kind: t.kind, rise: +(t.by - t.ay).toFixed(1), path, bytes: statSync(path).size });
  }
  const withRoutes = report.perIsland.filter((p) => p.routes > 0);
  for (const p of withRoutes) {
    if (p.meshes.length === 0) fail.push(`${p.id}: ${p.routes} routes, no route mesh`);
    if (p.meshes.length > 2) fail.push(`${p.id}: ${p.meshes.length} route meshes (> 2 draws)`);
  }
  if (withRoutes.length === 0) fail.push('no island has routes');
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ perIsland: report.perIsland, shots, fail }, null, 1));
  console.log(JSON.stringify(report.perIsland.filter((p) => p.routes)));
  console.log(JSON.stringify(shots));
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopAll();
}
console.log(fail.length ? `FAIL\n${fail.join('\n')}` : 'PASS');
process.exit(fail.length ? 1 : 0);
