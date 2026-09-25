// founder-probe (b2.3g, holes-09 + vm:physics:3). HEAVY: one headless
// SwiftShader Chromium, its OWN stack (server :8091 seed 20260801 with
// PIRATES_BR_DEV_HOOKS, Vite :3101), both killed in `finally`.
//
// A GATE (exit 1 on any FAIL). Joins a solo match, parks a FIXED free camera
// off her beam, scuttles our own hull through the server's solo-only
// dev_scuttle (the real startShipSinking + stepShipFounder path) and captures
// the founder at sinkProgress ~0.15 / 0.45 / 0.75 / 0.93, then the aftermath
// 4 s after she is gone. Grades:
//   - the drawn hull at >= 3 distinct depths (>= 0.4 m apart) over the 4 captures
//   - the hatch air-burst fired, the plunge fired and its vortex ring drew
//   - wreckage afloat (FounderFx debris > 0 and instanced pieces drawn) after
//     the burst and in the aftermath, with her hull gone (0 on HEAD before b2.3g)
//   - every piece older than 3 s rides the live sea (|y - surface| <= 0.6 m)
//   - the wreck moves on the water between the aftermath and +5 s (drift)
//   - draw calls with the founder in view vs before it (report: +<= 4)
// PNGs + JSON go to test-results/founder/.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const SERVER_PORT = '8091';
const CLIENT_PORT = '3101';
const SEED = '20260801';
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const OUT = 'test-results/founder';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; }
}
const started = [];
async function ensure(name, command, url, env, timeoutMs = 120_000) {
  if (await isUp(url)) { console.log(`[probe] ${name} already up at ${url}, reusing`); return; }
  const child = spawn(command, { shell: true, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  started.push(child);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
async function teardown() {
  for (const child of started.splice(0).reverse()) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(900);
    try { if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

/** Read the founder: the hull as drawn, FounderFx counts, debris vs the live sea. */
const READ = (shipId) => {
  const g = window.__piratesBR;
  const ship = g.state.ships.find((s) => s.id === shipId);
  const root = g.shipRenderer.getShipGroup(shipId);
  let hullY = null;
  if (root && ship && ship.sinkProgress < 1 && root.visible !== false) {
    const v = new root.position.constructor();
    root.getWorldPosition(v);
    hullY = v.y;
  }
  const fx = g.founderFx ?? null;
  const stats = fx ? fx.stats() : null;
  const debris = fx ? fx.getDebris() : [];
  let worstFloat = 0;
  let stranded = 0;
  let shallow = 0;
  let worstPiece = null;
  let graded = 0;
  let cx = 0;
  let cz = 0;
  for (const b of debris) {
    cx += b.x / debris.length;
    cz += b.z / debris.length;
    if (b.stranded) { stranded += 1; continue; }
    if (b.age < 3 || b.age > 26) continue;
    // Open water only: over the shelving shallows a piece grounds and lifts
    // off with the swell, which is the stranding model, not the float.
    const surf = g.ocean.getSurfaceY(b.x, b.z);
    const ground = g.founderFxSources?.groundY?.(b.x, b.z) ?? -Infinity;
    if (ground > surf - 1.2) { shallow += 1; continue; }
    graded += 1;
    const dev = Math.abs(b.y - surf);
    if (dev > worstFloat) { worstFloat = dev; worstPiece = { kind: b.kind, age: +b.age.toFixed(2), y: +b.y.toFixed(3), surf: +surf.toFixed(3), vy: +b.vy.toFixed(3) }; }
  }
  const info = g.renderer.renderer.info.render;
  return {
    progress: ship ? ship.sinkProgress : null, sinking: !!ship?.sinking, alive: ship ? ship.alive !== false : false,
    hullY, stats, debris: debris.length, stranded, shallow, graded, worstPiece, worstFloat, cx, cz, calls: info.calls, tris: info.triangles,
  };
};

async function main() {
  console.log(`founder-probe, GL: ${describeGl()}`);
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
    await page.goto(`${CLIENT_URL}/?debug&forceinput&peace&quality=low&server=${SERVER_PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await page.waitForTimeout(4000);
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });

    // A fixed camera 16 m off her, 4 m up, over OPEN WATER (the bearing whose
    // line to her crosses no island), aimed at her waterline.
    const cam = await page.evaluate(() => {
      const g = window.__piratesBR;
      g.setDayNightOverride(854);
      try { g.setBotPeace?.(true); } catch { /* optional */ }
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const shipId = me?.shipId;
      const root = g.shipRenderer.getShipGroup(shipId);
      if (!root) return { error: `no drawn hull for ${shipId}` };
      root.updateMatrixWorld(true);
      const C = root.position.constructor;
      const centre = root.localToWorld(new C(0, 0, 0));
      let eye = null;
      let bestGround = Infinity;
      for (let k = 0; k < 12; k += 1) {
        const a = (k / 12) * Math.PI * 2;
        const cand = new C(centre.x + Math.cos(a) * 16, 0, centre.z + Math.sin(a) * 16);
        let ground = -Infinity;
        for (let s = 0.3; s <= 1.0001; s += 0.1) {
          const x = centre.x + (cand.x - centre.x) * s;
          const z = centre.z + (cand.z - centre.z) * s;
          const gy = g.sampleGroundY(x, z);
          if (gy > ground) ground = gy;
        }
        if (ground < bestGround) { bestGround = ground; eye = cand; }
      }
      eye.y = 4;
      const d = centre.clone().sub(eye);
      const yaw = Math.atan2(d.x, d.z);
      const pitch = Math.atan2(centre.y - 0.5 - eye.y, Math.hypot(d.x, d.z));
      return { shipId, eye: [eye.x, eye.y, eye.z], yaw, pitch, bestGround };
    });
    if (cam.error) throw new Error(cam.error);
    const park = () => page.evaluate(({ eye, yaw, pitch }) => window.__piratesBR.enableFreeCam(eye[0], eye[1], eye[2], yaw, pitch), cam);
    await park();
    await page.waitForTimeout(1500);
    // Yaw convention check: the free camera must be looking at her.
    const aim = await page.evaluate((shipId) => {
      const g = window.__piratesBR;
      const root = g.shipRenderer.getShipGroup(shipId);
      const v = new root.position.constructor();
      root.getWorldPosition(v);
      v.project(g.renderer.camera);
      return { x: v.x, y: v.y, z: v.z };
    }, cam.shipId);
    if (!(Math.abs(aim.x) < 0.9 && aim.z < 1)) {
      cam.yaw += Math.PI;
      await park();
    }
    const before = await page.evaluate(READ, cam.shipId);
    await page.screenshot({ path: `${OUT}/0-before.png` });

    // In-page recorder: every rendered frame reads the founder and keeps the
    // FIRST sample at or past each target (progress < 1), so a slow poll from
    // here (SwiftShader ~3 fps, one screenshot can stall ~1 s, and the plunge
    // runs 0.7 -> 1 in well under a second) can no longer skip a capture.
    // The grades read these samples; the PNGs are best-effort at the next poll.
    const targets = [0.15, 0.45, 0.75, 0.93];
    await page.evaluate(({ src, shipId, targets }) => {
      // eslint-disable-next-line no-eval
      const read = (0, eval)(`(${src})`);
      const rec = { samples: [], frames: 0, stop: false };
      window.__founderRec = rec;
      const tick = () => {
        if (rec.stop) return;
        rec.frames += 1;
        try {
          const g = window.__piratesBR;
          const ship = g.state.ships.find((s) => s.id === shipId);
          const p = ship ? ship.sinkProgress : null;
          const next = targets[rec.samples.length];
          if (next !== undefined && p !== null && p !== undefined && p >= next && p < 1) {
            const r = read(shipId);
            // One frame may cross two targets (the plunge): it fills both.
            while (targets[rec.samples.length] !== undefined && p >= targets[rec.samples.length]) {
              rec.samples.push({ target: targets[rec.samples.length], frame: rec.frames, ...r });
            }
          }
        } catch (e) { rec.error = String(e); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { src: READ.toString(), shipId: cam.shipId, targets });

    const fps = await page.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { n += 1; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); };
      requestAnimationFrame(f);
    }));
    console.log(`  frame rate before the scuttle: ${fps.toFixed(2)} fps`);
    const t0 = Date.now();
    await page.evaluate(() => window.__piratesBR.network.send({ type: 'dev_scuttle', ts: Date.now(), payload: {} }));
    const shots = [];
    const deadline = Date.now() + 120_000;
    let goneAt = null;
    let lastPark = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastPark > 1000) { await park(); lastPark = Date.now(); }
      const r = await page.evaluate(() => {
        const g = window.__piratesBR;
        const rec = window.__founderRec;
        const ship = g.state.ships.find((s) => s.id === g.state.players.find((p) => p.id === g.localPlayerId)?.shipId)
          ?? null;
        return { n: rec.samples.length, error: rec.error ?? null, progress: ship ? ship.sinkProgress : null, alive: ship ? ship.alive !== false : false };
      });
      while (shots.length < r.n) {
        const name = `${shots.length + 1}-p${Math.round(targets[shots.length] * 100)}`;
        await page.screenshot({ path: `${OUT}/${name}.png` });
        shots.push(name);
      }
      if (r.progress === null || r.progress >= 1 || !r.alive) {
        if (goneAt === null) goneAt = Date.now();
        if (Date.now() - goneAt > 4000) break;
      }
      await page.waitForTimeout(60);
    }
    const recOut = await page.evaluate(() => { const rec = window.__founderRec; rec.stop = true; return { samples: rec.samples, frames: rec.frames, error: rec.error ?? null }; });
    if (recOut.error) console.log(`  [recorder] ${recOut.error}`);
    console.log(`  founder took ${((Date.now() - t0) / 1000 - 4).toFixed(1)} s over ${recOut.frames} rendered frames`);
    const caps = recOut.samples.map((c, k) => ({ name: shots[k] ?? `${k + 1}-p${Math.round(c.target * 100)}`, ...c }));
    for (const c of caps) {
      console.log(`  capture ${c.name}: frame ${c.frame} progress ${c.progress.toFixed(3)} hullY ${c.hullY?.toFixed(2)} debris ${c.debris} stats ${JSON.stringify(c.stats)} calls ${c.calls}`);
    }
    const after = await page.evaluate(READ, cam.shipId);
    await page.screenshot({ path: `${OUT}/5-aftermath.png` });
    // FounderFx's own draw cost, same frame and same camera: render the scene
    // with its debris and ring meshes shown, then hidden (perf-budget row for
    // "a founder in view": 2 instanced debris draws + <= 2 ring draws).
    const cost = await page.evaluate(() => {
      const g = window.__piratesBR;
      const fx = g.founderFx;
      const objs = [fx.barrels, fx.boxes, ...fx.rings.map((r) => r.mesh)];
      const vis = objs.map((o) => o.visible);
      const r = g.renderer.renderer;
      const auto = r.info.autoReset;
      r.info.autoReset = false;
      const count = () => { r.info.reset(); r.render(g.renderer.scene, g.renderer.camera); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
      const shown = count();
      objs.forEach((o) => { o.visible = false; });
      const hidden = count();
      objs.forEach((o, k) => { o.visible = vis[k]; });
      r.info.autoReset = auto;
      return { shown, hidden, visibleObjs: vis.filter(Boolean).length };
    });
    console.log(`  FounderFx draw cost: ${JSON.stringify(cost)}`);
    await page.waitForTimeout(5000);
    await park();
    const later = await page.evaluate(READ, cam.shipId);
    await page.screenshot({ path: `${OUT}/6-aftermath-5s.png` });
    console.log(`  aftermath: ${JSON.stringify(after)}`);
    console.log(`  +5 s: ${JSON.stringify(later)}`);

    const ys = caps.map((c) => c.hullY).filter((y) => typeof y === 'number');
    const distinct = [];
    for (const y of ys) if (!distinct.some((d) => Math.abs(d - y) < 0.4)) distinct.push(y);
    check('4 captures during the founder', caps.length === 4, `${caps.length}`);
    check('the drawn hull at >= 3 distinct depths (>= 0.4 m apart)', distinct.length >= 3, ys.map((y) => y.toFixed(2)).join(' / '));
    const fxOk = caps.every((c) => c.stats);
    check('FounderFx is live in the game', fxOk, fxOk ? '' : 'window.__piratesBR.founderFx absent');
    const last = caps[caps.length - 1]?.stats;
    check('the hatch air-burst fired', (last?.bursts ?? 0) >= 1, JSON.stringify(last));
    check('the plunge fired and its vortex ring drew', (last?.plunges ?? 0) >= 1 && (last?.rings ?? 0) >= 1, JSON.stringify(last));
    check('wreckage afloat after the burst (capture 2)', (caps[1]?.debris ?? 0) > 0 && (caps[1]?.stats?.drawn ?? 0) > 0, `${caps[1]?.debris ?? 0}`);
    check('wreckage afloat after she is gone (aftermath)', after.hullY === null && after.debris > 0 && (after.stats?.drawn ?? 0) > 0,
      `hull ${after.hullY} debris ${after.debris}`);
    // Non-vacuous: at least one open-water piece aged 3-26 s must be graded.
    check('every settled open-water piece rides the live sea (|y - surface| <= 0.6 m)',
      after.graded + later.graded > 0 && after.worstFloat <= 0.6 && later.worstFloat <= 0.6,
      `${after.worstFloat.toFixed(3)} / ${later.worstFloat.toFixed(3)} m over ${after.graded} / ${later.graded} graded pieces`);
    const moved = Math.hypot(later.cx - after.cx, later.cz - after.cz);
    check('the wreck drifts on the water (centroid moves over 5 s)', later.debris > 0 && moved > 0.05, `${moved.toFixed(2)} m`);
    const dCalls = cost.shown.calls - cost.hidden.calls;
    const dTris = cost.shown.tris - cost.hidden.tris;
    check('FounderFx with a founder in view costs 1-4 draws and < 20k tris (debris 2 instanced + <= 2 rings, no lights)',
      dCalls >= 1 && dCalls <= 4 && dTris < 20_000, `+${dCalls} draws, +${dTris} tris, ${cost.visibleObjs} fx meshes visible`);
    const peak = Math.max(...caps.map((c) => c.calls));
    console.log(`  draw calls: before ${before.calls}, founder peak ${peak}, aftermath ${after.calls} (FounderFx adds <= 2 debris + ${2} ring draws)`);
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ cam, before, caps, after, later, cost, results }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await teardown();
  }
  if (failures > 0) { console.log(`\n${failures} founder probe check(s) FAILED`); process.exitCode = 1; }
  else console.log('\nfounder-probe: all checks passed');
}
main().catch(async (e) => { console.error(e?.stack ?? e); await teardown(); process.exitCode = 1; });
