#!/usr/bin/env node
// char-probe (b3.2g, characters-09): the probe that can SEE a character, and fails when it is wrong.
//
//   node scripts/probes/char-probe.mjs [outDir=/tmp/pbr-char-probe]
//
// Boots its OWN stack on 3101 (Vite) / 8091 (server, seed 20260801, dev hooks) unless one already
// answers there (never 3000/8090, never 8080), drives ONE headless software-GL Chromium
// (scripts/lib/browser-args.mjs) at 960x540, and for each tier high / balanced / low:
//   - starts a Solo voyage with ?debug&quality=<tier>, waits for the match and the pirates;
//   - counts, per REMOTE pirate body (island skeletons excluded), the kind (skinned rig vs
//     PlayerMeshFactory box body), the draws (visible meshes x material groups; nameplate sprite and
//     the hidden health bar excluded) and the triangles;
//   - draw census where a pirate is really drawn: the camera follows one remote body at 6 m
//     (re-aimed inside WebGLRenderer.render, because bots ride moving ships and one SwiftShader frame
//     is seconds long), every remote body within 40 m that draws counts;
//   - a 2 m 3/4 face shot, a 6 m full body front and side, and a 30 m line-up (the body's ship and
//     crew), HUD and debug panel hidden, into one sheet (sheet.png) plus numbers.json.
// Assertions (exit 1 on any):
//   - at least one remote pirate body on every tier, and one of them DRAWN 6 m from the camera (a
//     census of culled bodies reads 0 draws and passes anything: VACUOUS = FAIL);
//   - low tier: 0 PlayerMeshFactory pirate bodies while pirate_base.glb is loaded (fails until the
//     low tier draws skinned LODs, b3.2f2);
//   - draws per remote pirate <= 2 on low, <= 3 on balanced/high (fails until the atlas, b3.2e/f2).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { fpArmsInPage, handCoverageInPage } from '../lib/viewmodel-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] ?? '/tmp/pbr-char-probe');
mkdirSync(OUT, { recursive: true });
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
if (['3000', '8090', '8080'].includes(CLIENT_PORT) || ['3000', '8090', '8080'].includes(SERVER_PORT)) {
  console.error('char-probe: 3000/8090 are the owner\'s ports and 8080 corrupts WebSockets on this Mac');
  process.exit(2);
}
const TIERS = (process.env.CHAR_PROBE_TIERS ?? 'high,balanced,low').split(',');
const DRAW_CAP = { high: 3, balanced: 3, low: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── stack ──────────────────────────────────────────────────────────────────
const started = [];
async function up(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; }
}
async function ensure(name, command, url, env) {
  if (await up(url)) { console.log(`[char-probe] ${name} already up at ${url}, reusing it`); return; }
  const log = createWriteStream(`/tmp/pbr-char-probe-${name}.log`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stdout.pipe(log); child.stderr.pipe(log);
  started.push(child);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before listening (see /tmp/pbr-char-probe-${name}.log)`);
    if (await up(url)) return;
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
function teardown() {
  for (const child of started.splice(0)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

// ── in-page helpers ────────────────────────────────────────────────────────
function censusInPage(onlyNear = null) {
  const g = window.__piratesBR;
  const cam = g.renderer.camera.position;
  const localId = g.localPlayerId;
  const glbLoaded = performance.getEntriesByType('resource').some((e) => /pirate_base[^/]*\.glb/.test(e.name));
  const bodies = [];
  for (const [id, mesh] of g.playerMeshes) {
    if (id === localId) continue;
    if (mesh.userData?.animation?.variant === 'skeleton') continue;
    const kind = mesh.userData?.rig ? 'rig' : mesh.userData?.animation?.parts ? 'pmf' : 'other';
    const skip = new Set();
    if (mesh.userData?.healthBar?.root) skip.add(mesh.userData.healthBar.root);
    if (mesh.userData?.nameplate) skip.add(mesh.userData.nameplate);
    let draws = 0, tris = 0;
    const walk = (o) => {
      if (skip.has(o) || !o.visible) return;
      if (o.isMesh && !o.isSprite) {
        const groups = Array.isArray(o.material) ? Math.max(1, o.geometry.groups.length) : 1;
        draws += groups;
        const idx = o.geometry.index;
        tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      }
      for (const c of o.children) walk(c);
    };
    walk(mesh);
    const p = mesh.getWorldPosition(new mesh.position.constructor());
    const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
    if (onlyNear !== null && dist > onlyNear) continue;
    bodies.push({ id, kind, draws, tris: Math.round(tris), visible: mesh.visible, dist: Math.round(dist), x: p.x, y: p.y, z: p.z });
  }
  return { glbLoaded, bodies, quality: g.renderer?.getQuality?.() ?? null };
}

// Bots stand on moving ships and one SwiftShader frame is 2-7 s, so a camera placed from a census
// is tens of metres off by the time it renders. aimAt() wraps WebGLRenderer.render and re-aims the
// main camera (and the free cam, so culling/LOD in the next update use the same spot) at the body's
// CURRENT world transform right before every draw: offset (fwd, side, up) in the body's own frame.
async function aimAt(page, id, off, lookUp, frames = 3) {
  await page.evaluate(([id, off, lookUp]) => {
    const g = window.__piratesBR;
    const r = g.renderer.renderer;
    if (!r.__charProbeOrig) r.__charProbeOrig = r.render.bind(r);
    const cam = g.renderer.camera;
    window.__charProbeFrames = 0;
    r.render = (scene, camera) => {
      const m = g.playerMeshes.get(id);
      if (m && camera === cam) {
        m.updateWorldMatrix(true, false);
        const e = m.matrixWorld.elements;
        const fwd = [e[8], e[10]], side = [e[0], e[2]];
        const nf = Math.hypot(fwd[0], fwd[1]) || 1, ns = Math.hypot(side[0], side[1]) || 1;
        const bx = e[12], by = e[13], bz = e[14];
        const px = bx + fwd[0] / nf * off[0] + side[0] / ns * off[1], py = by + off[2], pz = bz + fwd[1] / nf * off[0] + side[1] / ns * off[1];
        cam.position.set(px, py, pz);
        cam.lookAt(bx, by + lookUp, bz);
        cam.updateMatrixWorld(true);
        const dx = bx - px, dy = by + lookUp - py, dz = bz - pz, len = Math.hypot(dx, dy, dz) || 1;
        g.enableFreeCam(px, py, pz, Math.atan2(dx / len, dz / len), Math.asin(dy / len));
        window.__charProbeFrames += 1;
      }
      return r.__charProbeOrig(scene, camera);
    };
  }, [id, off, lookUp]);
  await page.waitForFunction((n) => window.__charProbeFrames >= n, frames, { timeout: 90_000 });
}

// ── run ────────────────────────────────────────────────────────────────────
const report = { gl: describeGl(), tiers: {} };
const shots = [];
let browser;
try {
  await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });
  console.log(`[char-probe] stack ${CLIENT_URL} / :${SERVER_PORT}, gl ${describeGl()}`);
  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  for (const tier of TIERS) {
    console.log(`\n── ${tier}`);
    const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.route('**/@vite/client*', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: [
        `globalThis.__GAME_SERVER_PORT__ = ${JSON.stringify(SERVER_PORT)};`,
        'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
        'const sheets = new Map();',
        'export const updateStyle = (id, css) => { let s = sheets.get(id); if (!s) { s = document.createElement("style"); s.setAttribute("data-vite-dev-id", id); document.head.appendChild(s); sheets.set(id, s); } s.textContent = css; };',
        'export const removeStyle = (id) => { sheets.get(id)?.remove(); sheets.delete(id); };',
        'export const injectQuery = (u) => u;',
        'export default {};',
      ].join('\n'),
    }));
    await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
    await page.goto(`${CLIENT_URL}/?debug&quality=${tier}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn');
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 120_000 });
    // Bodies are built as players stream in; wait until some remote pirate exists (or give up at 60 s).
    await page.waitForFunction(() => {
      const g = window.__piratesBR;
      for (const [id, m] of g.playerMeshes) if (id !== g.localPlayerId && m.userData?.animation?.variant !== 'skeleton') return true;
      return false;
    }, null, { timeout: 60_000 }).catch(() => {});
    await sleep(4000);
    await page.evaluate(() => {
      const g = window.__piratesBR;
      g.setDayNightOverride?.(854);
      if (g.debugPerfPanel) g.debugPerfPanel.style.display = 'none';
      const e = document.createElement('style'); e.textContent = '#hud{visibility:hidden!important;}'; document.head.appendChild(e);
    });
    // First-person frame (b3.2h): the local view hands must be the character's fp_arms, <= 4k tris, and
    // cover <= 45 % of the screen on the live renderer. Before any aimAt, so the camera is the player's own.
    await page.waitForFunction(() => {
      const vm = window.__piratesBR.viewmodel;
      let n = 0;
      vm.localViewWeaponRoot.traverse((o) => { if (o.name === 'fp_arms') n += 1; });
      return n > 0 || window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId)?.state !== 'alive';
    }, null, { timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    const fp = await page.evaluate(fpArmsInPage);
    const fpCov = await page.evaluate(handCoverageInPage);
    const fpFile = path.join(OUT, `${tier}-first-person.png`);
    await page.screenshot({ path: fpFile, timeout: 90_000 });
    report.firstPerson = report.firstPerson ?? {};
    report.firstPerson[tier] = { ...fp, coverage: +fpCov.coverage.toFixed(4) };
    console.log(`  first person: weapon ${fp.weaponId} pocket ${fp.pocketKind}, hands ${fp.hands.map((h) => `${h.root}.${h.hand}:${h.fpArms ? 'fp_arms' : 'PRIMITIVE'}/${h.tris}t`).join(' ') || 'none'}, fp_arms loaded on ${fp.loadedArms} hands, ${(fpCov.coverage * 100).toFixed(1)}% of screen`);
    expect(`${tier}: first person draws hands and every one is fp_arms (non-vacuous)`,
      fp.hands.length > 0 && fp.hands.every((h) => h.fpArms), fp.hands.map((h) => `${h.hand}:${h.fpArms}`).join(' ') || 'no hands drawn');
    expect(`${tier}: first-person fp_arms <= 4000 tris`, fp.drawnFpTris > 0 && fp.drawnFpTris <= 4000, `${fp.drawnFpTris}`);
    expect(`${tier}: first-person hands cover <= 45% of the screen`, fpCov.coverage > 0 && fpCov.coverage <= 0.45, `${(fpCov.coverage * 100).toFixed(1)}%`);
    // Kind census over every remote pirate (independent of distance culling).
    const all = await page.evaluate(censusInPage, null);
    const pmf = all.bodies.filter((b) => b.kind === 'pmf').length;
    const kinds = all.bodies.reduce((o, b) => ((o[b.kind] = (o[b.kind] ?? 0) + 1), o), {});
    // Draw census where a pirate is actually drawn: camera 6 m in front of a body (following it),
    // every remote body within 40 m that draws at all. Try up to 4 bodies (one may be below deck).
    let target = null, near = [];
    for (const cand of all.bodies.slice(0, 4)) {
      await aimAt(page, cand.id, [6, 0, 1.2], 0.9);
      await page.evaluate(() => window.__piratesBR.settleLod?.());
      await aimAt(page, cand.id, [6, 0, 1.2], 0.9, 2);
      const c = await page.evaluate(censusInPage, 40);
      near = c.bodies.filter((b) => b.draws > 0);
      if (near.some((b) => b.id === cand.id)) { target = cand.id; break; }
    }
    const maxDraws = near.reduce((m, b) => Math.max(m, b.draws), 0);
    report.tiers[tier] = { quality: all.quality, glbLoaded: all.glbLoaded, kinds, target, maxDraws, near, bodies: all.bodies };
    console.log(`  quality ${all.quality}, pirate_base.glb fetched ${all.glbLoaded}, bodies ${JSON.stringify(kinds)}, drawn within 40 m: ${near.map((b) => `${b.kind}:${b.draws}d/${b.tris}t@${b.dist}m`).join(' ') || 'none'}`);
    expect(`${tier}: at least one remote pirate body to look at`, all.bodies.length > 0, `${all.bodies.length}`);
    expect(`${tier}: the tier really is ${tier}`, all.quality === tier, `${all.quality}`);
    expect(`${tier}: a remote pirate is DRAWN 6 m from the camera (non-vacuous draw count)`, target !== null, `${near.length} drawn`);
    if (tier === 'low') {
      expect('low: 0 PlayerMeshFactory pirate bodies while pirate_base.glb is loaded', all.glbLoaded && pmf === 0,
        `glb fetched ${all.glbLoaded}, ${pmf} of ${all.bodies.length} bodies are box bodies`);
    }
    expect(`${tier}: <= ${DRAW_CAP[tier]} draws per remote pirate`, near.length > 0 && maxDraws <= DRAW_CAP[tier],
      near.map((b) => `${b.kind}:${b.draws}`).join(' '));

    const tierShots = [{ label: 'first person', file: fpFile }];
    if (target) {
      const views = [
        ['face 2 m 3/4', [1.6, 0.9, 1.8], 1.62],
        ['body 6 m front', [6, 0, 1.2], 0.9],
        ['body 6 m side', [0, 6, 2.2], 0.9],
        ['line-up 30 m', [30, 0, 4], 1.0],
      ];
      for (const [label, off, lookUp] of views) {
        await aimAt(page, target, off, lookUp, 2);
        const file = path.join(OUT, `${tier}-${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
        await page.screenshot({ path: file, timeout: 90_000 });
        tierShots.push({ label, file });
      }
    }
    shots.push({ tier, shots: tierShots });
    await context.close();
  }

  // Sheet: one row per tier, four columns.
  const sheetCtx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const sheet = await sheetCtx.newPage();
  const cells = shots.map(({ tier, shots: s }) => `<div class="row"><div class="t">${tier}</div>${s.map((x) => `<figure><img src="data:image/png;base64,${readFileSync(x.file).toString('base64')}"><figcaption>${x.label}</figcaption></figure>`).join('')}</div>`).join('');
  await sheet.setContent(`<style>body{margin:0;background:#111;color:#ddd;font:11px sans-serif}.row{display:flex;align-items:flex-start}.t{width:40px;writing-mode:vertical-rl;padding:4px}figure{margin:2px}img{width:226px;height:127px;display:block}</style>${cells}`);
  await sheet.screenshot({ path: path.join(OUT, 'sheet.png'), fullPage: true });
  await sheetCtx.close();
} catch (e) {
  failures += 1;
  console.error(`  ✗ FAIL: probe crashed: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  teardown();
}
writeFileSync(path.join(OUT, 'numbers.json'), JSON.stringify(report, null, 2));
console.log(`\nchar-probe: ${failures ? `${failures} FAIL` : 'all green'}; sheet ${path.join(OUT, 'sheet.png')}`);
process.exit(failures ? 1 : 0);
