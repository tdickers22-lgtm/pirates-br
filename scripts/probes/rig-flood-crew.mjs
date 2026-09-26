#!/usr/bin/env node
// rig-flood-crew (b3.3d, flooding-crew motion): in a LIVE game, does a skinned pirate wade when the
// hold water is over his shins, and stagger when a breach hit lands behind him? Fails when not.
//
//   node scripts/probes/rig-flood-crew.mjs [outDir=/tmp/pbr-rig-flood-crew]
//
// Same stack contract as rig-contacts.mjs: its OWN 3101 (Vite) / 8091 (server, seed 20260801, dev
// hooks) unless one already answers there (never 3000/8090, never 8080), ONE headless software-GL
// Chromium at 960x540 on ?debug&quality=balanced, Solo voyage. A rigged remote crewmate of the live
// match is driven through the game's own PlayerAnimator.animatePlayerMesh -> updatePlayerRig ->
// driveRigLayers (real clips, real mixer) on the local player's live ship. STAGED: the hold
// immersion (mesh.userData.holdImmersion, what Game writes from sampleHoldWater each frame; 0.6 =
// water well over the shins, HOLD_WADE_IMMERSION is 0.35) and the stagger edge (the same
// locomotion.queueStagger Game.staggerCrew calls on a breach hit / anchor bite), plus the body's
// velocity (forward at PLAYER.MOVE_SPEED, or standing).
// Assertions (exit 1 on any):
//   - a skinned crewmate exists (VACUOUS = FAIL);
//   - dry at MOVE_SPEED the lower layer is the run blend, never 'wade' (control);
//   - flooded at MOVE_SPEED the lower layer is 'wade' on every sampled frame after 0.4 s;
//   - the flooded stride cadence (loco phase rate) is slower than the dry one;
//   - a stagger from behind plays hit_back within 0.5 s, dry and flooded, and the standing body is
//     back to idle within 2.5 s.
// Mutation that must turn it red: HOLD_WADE_IMMERSION raised to 9 (never wades).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] ?? '/tmp/pbr-rig-flood-crew');
mkdirSync(OUT, { recursive: true });
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
if (['3000', '8090', '8080'].includes(CLIENT_PORT) || ['3000', '8090', '8080'].includes(SERVER_PORT)) {
  console.error('rig-flood-crew: 3000/8090 are the owner\'s ports and 8080 corrupts WebSockets on this Mac');
  process.exit(2);
}
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
  if (await up(url)) { console.log(`[rig-flood-crew] ${name} already up at ${url}, reusing it`); return; }
  const log = createWriteStream(`/tmp/pbr-rig-flood-crew-${name}.log`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stdout.pipe(log); child.stderr.pipe(log);
  started.push(child);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before listening (see /tmp/pbr-rig-flood-crew-${name}.log)`);
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

// ── in-page: install the measuring wrapper around the game's own animatePlayerMesh ──
async function installInPage() {
  const g = window.__piratesBR;
  const L = await import('/src/client/rendering/character/locomotion.ts');
  const consts = await import('/src/shared/constants/index.ts');
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me.shipId);
  const anim = g.anim;
  if (!anim.__fcOrig) anim.__fcOrig = anim.animatePlayerMesh.bind(anim);
  const st = { id: null, imm: 0, speed: 0, stagger: false, frames: [], t0: 0, err: null };
  window.__fc = st;
  // Game's own call for the measured body is dropped; the probe's rAF loop drives it.
  anim.animatePlayerMesh = (mesh, player, shp, dt, remote) => {
    if (st.id && player.id === st.id) return;
    return anim.__fcOrig(mesh, player, shp, dt, remote);
  };
  let prev = performance.now();
  const loop = () => {
    try {
      const now = performance.now();
      const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
      const mesh = st.id ? g.playerMeshes.get(st.id) : null;
      const player = st.id ? g.state.players.find((q) => q.id === st.id) : null;
      if (mesh?.userData?.rig && player) {
        const yaw = mesh.rotation.y;
        const p = Object.create(player);
        Object.assign(p, {
          state: 'alive', atHelm: false, atCannon: false, atCapstan: false, mastClimb: null, bailing: false,
          hullRepairProgress: 0, onShipId: ship.id, rotation: { x: yaw, y: 0 },
          velocity: { x: Math.sin(yaw) * st.speed, y: 0, z: Math.cos(yaw) * st.speed },
        });
        mesh.userData.holdImmersion = st.imm;
        if (st.stagger) { L.queueStagger(mesh, true); st.stagger = false; }
        anim.__fcOrig(mesh, p, ship, dt, null);
        const rig = mesh.userData.rig; const loco = L.rigLocoState(rig);
        st.frames.push({ t: now - st.t0, lower: rig.lower?.name ?? null, upper: rig.upper?.name ?? null,
          phase: loco?.active ? loco.phase : null, dom: loco?.dominant?.name ?? null });
      }
    } catch (e) { st.err = String(e?.stack ?? e); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const crew = [];
  for (const [id, m] of g.playerMeshes) {
    if (id === g.localPlayerId || !m.userData?.rig) continue;
    const pl = g.state.players.find((q) => q.id === id);
    if (pl?.state === 'alive') crew.push({ id, mine: pl.onShipId === ship.id });
  }
  crew.sort((a, b) => Number(b.mine) - Number(a.mine));
  return { ship: ship.type, crew, moveSpeed: consts.PLAYER.MOVE_SPEED };
}

async function run(page, cfg, ms) {
  await page.evaluate((c) => { Object.assign(window.__fc, c, { frames: [], t0: performance.now() }); }, cfg);
  await page.waitForTimeout(ms);
  const out = await page.evaluate(() => ({ frames: window.__fc.frames.slice(), err: window.__fc.err }));
  return out;
}
/** Stride cadence: loco phase advance per second, unwrapped. */
function phaseRate(frames) {
  let sum = 0; let t = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]; const b = frames[i];
    if (a.phase === null || b.phase === null) continue;
    let d = b.phase - a.phase; if (d < -0.5) d += 1; if (d < 0) continue;
    sum += d; t += (b.t - a.t) / 1000;
  }
  return t > 0 ? sum / t : NaN;
}

// ── run ────────────────────────────────────────────────────────────────────
const report = { gl: describeGl(), cases: {} };
let browser;
try {
  await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });
  console.log(`[rig-flood-crew] stack ${CLIENT_URL} / :${SERVER_PORT}, gl ${describeGl()}`);
  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
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
  await page.goto(`${CLIENT_URL}/?debug&quality=balanced`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn');
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 120_000 });
  // Skinned crewmates stream in after the GLB loads.
  await page.waitForFunction(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    for (const [id, m] of g.playerMeshes) {
      const pl = g.state.players.find((q) => q.id === id);
      if (id !== g.localPlayerId && m.userData?.rig && pl?.state === 'alive') return true;
    }
    return false;
  }, null, { timeout: 60_000 }).catch(() => {});
  // A SwiftShader frame is seconds long and the numbers do not need pixels: skip the draw while measuring.
  await page.evaluate(() => {
    const r = window.__piratesBR.renderer.renderer;
    if (!r.__rcOrig) { r.__rcOrig = r.render.bind(r); r.render = () => {}; }
  });
  const info = await page.evaluate(installInPage);
  report.ship = info.ship; report.crew = info.crew.length;
  console.log(`  ship ${info.ship}, rigged remote bodies ${info.crew.length} (${info.crew.filter((c) => c.mine).length} on this ship)`);
  expect('a skinned remote pirate exists to drive (non-vacuous)', info.crew.length > 0, `${info.crew.length}`);
  if (info.crew.length > 0) {
    const id = info.crew[0].id;
    const V = info.moveSpeed;
    const after = (r, ms) => r.frames.filter((f) => f.t >= ms);
    const dry = await run(page, { id, imm: 0, speed: V }, 2500);
    const wet = await run(page, { id, imm: 0.6, speed: V }, 2500);
    for (const [k, r] of [['dry', dry], ['wet', wet]]) if (r.err) expect(`${k}: no in-page error`, false, r.err);
    const dryLow = [...new Set(after(dry, 400).map((f) => f.lower))];
    const wetLow = [...new Set(after(wet, 400).map((f) => f.lower))];
    const dryDom = [...new Set(after(dry, 400).map((f) => f.dom))];
    report.cases.dry = { lower: dryLow, dom: dryDom, rate: phaseRate(after(dry, 400)), frames: dry.frames.length };
    report.cases.wet = { lower: wetLow, dom: [...new Set(after(wet, 400).map((f) => f.dom))], rate: phaseRate(after(wet, 400)), frames: wet.frames.length };
    console.log(`  dry  @${V} m/s: lower ${dryLow.join('/')} dominant ${dryDom.join('/')} cadence ${report.cases.dry.rate.toFixed(3)}/s (${dry.frames.length} frames)`);
    console.log(`  wet  @${V} m/s: lower ${wetLow.join('/')} dominant ${report.cases.wet.dom.join('/')} cadence ${report.cases.wet.rate.toFixed(3)}/s (${wet.frames.length} frames)`);
    expect('dry control: at MOVE_SPEED the lower layer is the locomotion blend, never wade', dryLow.length > 0 && !dryLow.includes('wade') && dryDom.some((n) => /run|sprint/.test(n ?? '')), `${dryLow.join('/')} dom ${dryDom.join('/')}`);
    expect('flooded hold (immersion 0.6): the lower layer is wade on every frame after 0.4 s', wetLow.length === 1 && wetLow[0] === 'wade', wetLow.join('/'));
    expect('flooded stride cadence is slower than the dry one', report.cases.wet.rate < report.cases.dry.rate * 0.9, `${report.cases.wet.rate.toFixed(3)} vs ${report.cases.dry.rate.toFixed(3)}`);
    for (const [k, imm] of [['dry', 0], ['flooded', 0.6]]) {
      await run(page, { id, imm, speed: 0 }, 1200);
      const r = await run(page, { id, imm, speed: 0, stagger: true }, 3000);
      const hitAt = r.frames.find((f) => f.lower === 'hit_back' || f.upper === 'hit_back')?.t ?? null;
      const idleAt = hitAt === null ? null : r.frames.find((f) => f.t > hitAt && f.lower !== 'hit_back' && f.upper !== 'hit_back')?.t ?? null;
      const endLower = r.frames.at(-1)?.lower ?? null;
      report.cases[`stagger_${k}`] = { hitAt, idleAt, endLower, frames: r.frames.length, err: r.err };
      console.log(`  stagger ${k}: hit_back at ${hitAt?.toFixed(0) ?? '-'} ms, clear at ${idleAt?.toFixed(0) ?? '-'} ms, ends on ${endLower}`);
      expect(`stagger (${k}): hit_back plays within 0.5 s of the breach hit`, hitAt !== null && hitAt <= 500, `${hitAt}`);
      expect(`stagger (${k}): standing body is back to ${imm ? 'its wade/idle' : 'idle'} within 2.5 s`, idleAt !== null && idleAt <= 2500 && endLower !== 'hit_back', `${idleAt} end ${endLower}`);
    }
  }
} catch (e) {
  failures += 1;
  console.error(`  ✗ FAIL: probe crashed: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  teardown();
}
writeFileSync(path.join(OUT, 'numbers.json'), JSON.stringify(report, null, 2));
console.log(`\nrig-flood-crew: ${failures ? `${failures} FAIL` : 'all green'}; ${path.join(OUT, 'numbers.json')}`);
process.exit(failures ? 1 : 0);
