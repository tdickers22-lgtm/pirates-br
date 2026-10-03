#!/usr/bin/env node
// b5.2b WILDLIFE FLOATER PROBE: do the rigged walkers (crab, pig, chicken, and any other ground animal) stand on
// the ground the player SEES, mid-gait, with their animation mixers running?
//
// scripts/audit-live-floaters.mjs measures island scenery only (it walks islandMeshes; wildlife live under
// Game.environment). This probe joins a real solo match, lets every island build, waits for the seat easing
// (Game: drawn-minus-analytic seatOffset, eased at 8/s) to settle, then for every VISIBLE non-gull wildlife mesh:
//   origin gap = group world y (the GLB feet sit at local y 0) - rendered terrain under the animal
//   skin gap   = min y of the SKINNED bounds (SkinnedMesh.computeBoundingBox applies the bones, so a lifted
//                gait foot counts) - rendered terrain under the animal
// The rendered terrain is rebuilt from the island's own full-grid triangles (TerrainLodSwitch.fullGeometry), the
// same sampler audit-live-floaters uses. A floater: origin gap AND skin gap both > LIMIT (0.25 m, the audit's).
// A sunk animal (origin gap < -LIMIT) is reported, not graded (a crab half-buried in sand reads as burrowing).
//
// Self-test (the gate's RED): after the honest census, every measured animal is lifted 0.6 m and re-measured;
// the probe must then count every one of them as a floater, or the measurement is blind and the run fails.
// Coverage: the governor's dressing radius is widened in the page so every island's animals are shown and seated.
//
// Machine protection: its own 3101 (Vite) / 8091 (server) stack, one headless SwiftShader Chromium at 960x540
// via scripts/lib/browser-args.mjs, everything killed in finally. Refuses to start while ~/.vidlab/recording
// exists and waits while load1 > 8.
//
//   node scripts/probes/wildlife-floaters.mjs [outDir]      (exit 1 on a floater or a blind self-test)
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { browserArgs } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/wildlife-floaters';
const LIMIT = Number(process.env.PIRATES_BR_FLOAT_LIMIT ?? 0.25);
const SERVER_PORT = '8091', CLIENT_PORT = '3101', MAP_SEED = '20260801';
const URL_BASE = `http://127.0.0.1:${CLIENT_PORT}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(`${homedir()}/.vidlab/recording`)) { console.error('[wildlife] ~/.vidlab/recording exists: not starting a browser'); process.exit(2); }
const load1 = () => { try { return Number(execSync('sysctl -n vm.loadavg').toString().split(' ')[1]); } catch { return 0; } };
while (load1() > 8) { console.log(`[wildlife] load ${load1()} > 8, waiting 45 s`); await sleep(45_000); }

const started = [];
let browser = null;
function killStack() {
  for (const { name, child } of started.splice(0)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    console.log(`[wildlife] stopped ${name}`);
  }
}
const reapBrowser = () => { try { browser?.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', killStack);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reapBrowser(); killStack(); process.exit(130); });

async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; } }
async function ensure(name, cmd, url, env) {
  if (await isUp(url)) throw new Error(`${name} already up at ${url}: refusing to reuse a stack this probe does not own`);
  const log = createWriteStream(`${OUT}/stack-${name}.log`);
  const child = spawn(cmd, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, BROWSER: 'none' } });
  child.stdout.pipe(log); child.stderr.pipe(log);
  started.push({ name, child });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early (see ${OUT}/stack-${name}.log)`);
    if (await isUp(url)) { console.log(`[wildlife] ${name} up at ${url}`); return; }
    await sleep(500);
  }
  throw new Error(`${name} never answered ${url}`);
}

/** Runs in the page: census of every visible ground animal against the rendered terrain. */
function census({ limit, lift }) {
  const g = window.__piratesBR;
  const samplers = new Map();
  function makeMeshSampler(mesh) {
    const geo = mesh.userData?.terrainLod?.fullGeometry ?? mesh.geometry;
    const p = geo.attributes.position.array;
    const index = geo.index ? geo.index.array : null;
    const triCount = Math.floor((index ? index.length : p.length / 3) / 3);
    const CELL = 6, buckets = new Map();
    const key = (ix, iz) => `${ix}|${iz}`;
    const tri = (t) => (index ? [index[t * 3] * 3, index[t * 3 + 1] * 3, index[t * 3 + 2] * 3] : [t * 9, t * 9 + 3, t * 9 + 6]);
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = tri(t);
      for (let ix = Math.floor(Math.min(p[a], p[b], p[c]) / CELL); ix <= Math.floor(Math.max(p[a], p[b], p[c]) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(p[a + 2], p[b + 2], p[c + 2]) / CELL); iz <= Math.floor(Math.max(p[a + 2], p[b + 2], p[c + 2]) / CELL); iz++) {
          const k = key(ix, iz); const l = buckets.get(k); if (l) l.push(t); else buckets.set(k, [t]);
        }
      }
    }
    return (x, z) => {
      const list = buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!list) return null;
      let best = null;
      for (const t of list) {
        const [a, b, c] = tri(t);
        const x1 = p[a], z1 = p[a + 2], x2 = p[b], z2 = p[b + 2], x3 = p[c], z3 = p[c + 2];
        const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(d) < 1e-9) continue;
        const w1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
        const w2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
        const y = w1 * p[a + 1] + w2 * p[b + 1] + w3 * p[c + 1];
        if (best === null || y > best) best = y;
      }
      return best;
    };
  }
  // Ground under a world point: highest rendered terrain of any island covering it (terrain-local sampling,
  // transformed back through the terrain's world matrix).
  function groundAt(wx, wz) {
    let best = null;
    for (const group of g.islandMeshes.values()) {
      const terrain = group.getObjectByName('island-terrain');
      if (!terrain) continue;
      let s = samplers.get(terrain); if (!s) { s = makeMeshSampler(terrain); samplers.set(terrain, s); }
      terrain.updateWorldMatrix(true, false);
      const m = terrain.matrixWorld.elements;
      // affine inverse for x/z only (islands are translated, never rotated about x/z)
      const inv = terrain.matrixWorld.clone().invert().elements;
      const lx = inv[0] * wx + inv[8] * wz + inv[12] + inv[4] * 0;
      const lz = inv[2] * wx + inv[10] * wz + inv[14];
      const ly = s(lx, lz);
      if (ly === null) continue;
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      if (best === null || wy > best) best = wy;
    }
    return best;
  }
  const rows = [], skipped = { invisible: 0, gull: 0, offIsland: 0, dead: 0 };
  const byType = {};
  for (const [id, group] of g.wildlifeMeshes) {
    const animal = (g.state.wildlife ?? []).find((a) => a.id === id);
    const type = animal?.type ?? 'unknown';
    if (type === 'gull') { skipped.gull++; continue; }
    if (!group.visible) { skipped.invisible++; continue; }
    if (animal?.dead) { skipped.dead++; continue; }
    if (lift) { group.position.y += lift; }
    group.updateWorldMatrix(true, true);
    const pos = group.getWorldPosition(new group.position.constructor());
    const ground = groundAt(pos.x, pos.z);
    if (ground === null) { skipped.offIsland++; if (lift) group.position.y -= lift; continue; }
    let minY = Infinity, skinned = false;
    group.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (o.isSkinnedMesh) { skinned = true; o.computeBoundingBox(); }
      else if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = (o.isSkinnedMesh ? o.boundingBox : o.geometry.boundingBox).clone().applyMatrix4(o.matrixWorld);
      if (bb.min.y < minY) minY = bb.min.y;
    });
    if (lift) { group.position.y -= lift; group.updateWorldMatrix(true, true); }
    const originGap = pos.y - ground, skinGap = minY - ground;
    const floater = originGap > limit && skinGap > limit;
    const sunk = originGap < -limit;
    const row = { id, type, skinned, x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), ground: +ground.toFixed(3),
      originGap: +originGap.toFixed(3), skinGap: +skinGap.toFixed(3), floater, sunk };
    rows.push(row);
    const t = byType[type] ??= { measured: 0, floaters: 0, sunk: 0, skinned: 0, maxOriginGap: -Infinity, minOriginGap: Infinity };
    t.measured++; if (floater) t.floaters++; if (sunk) t.sunk++; if (skinned) t.skinned++;
    t.maxOriginGap = Math.max(t.maxOriginGap, +originGap.toFixed(3)); t.minOriginGap = Math.min(t.minOriginGap, +originGap.toFixed(3));
  }
  return { total: g.wildlifeMeshes.size, measured: rows.length, floaters: rows.filter((r) => r.floater).length,
    sunk: rows.filter((r) => r.sunk).length, skipped, byType, rows };
}

const report = { limit: LIMIT, viewport: '960x540', seed: MAP_SEED };
let failed = false;
try {
  await ensure('server', 'npx tsx src/server/index.ts', `http://127.0.0.1:${SERVER_PORT}/health`, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, URL_BASE, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.route('**/@vite/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: [
    "import '/@vite/env';",
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export default {};'].join('\n') }));
  await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* */ } });
  await page.goto(`${URL_BASE}/?debug&forceinput&peace&quality=high`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 150_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
  await sleep(3000);
  await page.evaluate(() => { const g = window.__piratesBR; g.setDayNightOverride?.(854); g.setBotPeace?.(true); g.drainIslandBuildQueue(40); });
  await page.waitForFunction(() => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99), null, { timeout: 90_000 });
  await page.evaluate(() => window.__piratesBR.settleLod?.(2));
  // Coverage: wildlife beyond wildlifeRadius (520 m at high) is hidden and never seated, so the honest census
  // would only see the spawn island. Widen the governor's dressing bias for this probe so EVERY animal is shown
  // and the Game's own seat pass runs on it (the radius is the only thing patched; seating is the shipped code).
  await page.evaluate(() => {
    const r = window.__piratesBR.renderer; const orig = r.getFrameLevers.bind(r);
    r.getFrameLevers = () => ({ ...orig(), lodRadiusScale: 40 });
  });
  await sleep(6000);
  // Seat easing converges at 8/s (frame-rate independent); walkers keep walking, so sample three times a few seconds apart (mid-gait).
  report.samples = [];
  for (let i = 0; i < 3; i++) {
    await sleep(4000);
    report.samples.push(await page.evaluate(census, { limit: LIMIT, lift: 0 }));
  }
  report.selfTest = await page.evaluate(census, { limit: LIMIT, lift: 0.6 });
  report.pageErrors = errors;
  const measured = report.samples.reduce((n, s) => n + s.measured, 0);
  const floaters = report.samples.reduce((n, s) => n + s.floaters, 0);
  const blind = report.selfTest.measured === 0 || report.selfTest.floaters !== report.selfTest.measured;
  report.gates = { measured, floaters, selfTestBlind: blind, pass: measured > 0 && floaters === 0 && !blind };
  for (const [i, s] of report.samples.entries()) {
    console.log(`[wildlife] sample ${i + 1}: ${s.measured} measured of ${s.total} (skipped ${JSON.stringify(s.skipped)}), floaters ${s.floaters}, sunk ${s.sunk}`);
    for (const [t, v] of Object.entries(s.byType)) console.log(`   ${t.padEnd(8)} ${v.measured} measured, skinned ${v.skinned}, floaters ${v.floaters}, sunk ${v.sunk}, origin gap ${v.minOriginGap}..${v.maxOriginGap} m`);
    for (const r of s.rows.filter((x) => x.floater)) console.log(`   FLOATER ${r.type} ${r.id} at (${r.x}, ${r.z}) origin +${r.originGap} skin +${r.skinGap}`);
  }
  console.log(`[wildlife] self-test (+0.6 m lift): ${report.selfTest.floaters}/${report.selfTest.measured} flagged${blind ? ' BLIND' : ''}`);
  failed = !report.gates.pass;
  console.log(failed ? '[wildlife] FAIL' : `OK: ${measured} ground-animal readings, 0 floaters; the probe flags a 0.6 m lift on every animal`);
} catch (err) {
  report.error = String(err?.stack ?? err);
  console.error('[wildlife] error', report.error);
  failed = true;
} finally {
  writeFileSync(`${OUT}/wildlife-floaters.json`, JSON.stringify(report, null, 1));
  try { await browser?.close(); } catch { /* gone */ }
  reapBrowser(); killStack(); await sleep(1500);
}
process.exit(failed ? 1 : 0);
