#!/usr/bin/env node
// EVERY PROGRAM THE GAME DRAWS WITH MUST BE A LINKED PROGRAM, AND A LIVE SWIMMER
// MUST SEE THE WORLD.
//
// liveplay-04 (2026-09-22): a solo match logged "WebGL: INVALID_OPERATION:
// useProgram: program not valid" until Chrome's per-context cap (254) and then
// "too many errors". Renderer.ts keeps `checkShaderErrors` off by default (the
// join costs seconds), so a failed link was SILENT: three kept the broken
// program, bound it every frame and the material drew nothing.
// liveplay-06 / vm:liveplay:3: the 3D view went black behind a live HUD while
// the pirate was alive and swimming (70-swim-surface-eye.png).
//
// This suite is the census for both. It installs, before any game code runs,
// a pass-through on useProgram that asks LINK_STATUS once per program (and keeps
// its info log, both shader logs and the stack that bound it), counts every
// "useProgram" console line, and at the end walks renderer.info.programs asking
// LINK_STATUS of every live program. It then visits deck, hold, sea, a cave and
// under the surface with the debug free cam, and finally walks the real pirate
// off the shore into the water and grades the frames he sees while alive.
//
//   node scripts/test-program-validity.mjs [--quality balanced] [--mutate]
//
// GL is software (SwiftShader) by default through scripts/lib/browser-args.mjs,
// which is the point: SwiftShader has tighter limits than Metal and is where the
// failure was seen. --mutate injects one ShaderMaterial whose link must fail
// (a varying the vertex stage never writes, with a mismatched type): the census
// must go red on it, and the renderer's link-failure fallback must replace it.
//
// Needs a stack: server on PIRATES_BR_SERVER_PORT (8091) with the pinned map,
// Vite on PIRATES_BR_URL (3101; started here if absent).
import { chromium } from 'playwright';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import { PROGRAM_VALIDITY_SOURCE } from './lib/program-census.mjs';
import { readPng } from './lib/png-read.mjs';

const argv = process.argv.slice(2);
const arg = (n, f = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };
const MUTATE = argv.includes('--mutate');
const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3101')).replace(/\/$/, '');
const QUALITY = arg('quality', 'balanced');
const STOP_FRAMES = parseInt(arg('frames', '12'), 10);
const VIEWPORT = { width: 960, height: 540 };
/** A swim frame fails when more than this share of its 3D pixels is near-black. */
const BLACK_SHARE_MAX = 0.95;
/** Luma (0..255) below which a pixel counts as black. */
const BLACK_LUMA = 12;

const frames = (page, n) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const step = () => (++i >= k ? res(i) : requestAnimationFrame(step)); requestAnimationFrame(step);
}), n);

/** Share of near-black pixels in the 3D view, HUD edges trimmed (top 12%, bottom 22%, sides 8%). */
function blackShare(buf) {
  const png = readPng(buf);
  const { width, height, channels, data } = png;
  let black = 0, n = 0, sum = 0;
  for (let y = Math.floor(height * 0.12); y < Math.floor(height * 0.78); y += 2) {
    for (let x = Math.floor(width * 0.08); x < Math.floor(width * 0.92); x += 2) {
      const i = (y * width + x) * channels;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += l; n += 1; if (l < BLACK_LUMA) black += 1;
    }
  }
  return { share: black / Math.max(1, n), meanLuma: sum / Math.max(1, n) };
}

async function main() {
  const port = SERVER_PORT ?? '8091';
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!h) { console.error(`[program-validity] no game server on :${port}`); process.exit(2); }
  console.log(`[program-validity] GL: ${describeGl()}  quality=${QUALITY}  map seed ${h.mapSeed ?? 'UNPINNED'}${MUTATE ? '  MUTATION ARMED: one unlinkable ShaderMaterial joins the scene, this run MUST fail' : ''}`);

  const client = await ensureDevClient(`${URL}/`);
  const browser = await chromium.launch({
    args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
  });
  let failures = 0;
  const fail = (m) => { failures += 1; console.error(`  x ${m}`); };
  const pass = (m) => console.log(`  ok ${m}`);
  const consoleUseProgram = [];
  const pageErrors = [];
  let mutantUnhandled = false;
  let linesAtSwim = 0;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
    page.on('console', (m) => {
      const t = m.text();
      if (/useProgram|too many errors/.test(t)) consoleUseProgram.push(t.slice(0, 200));
      if (/\[program-fallback\]/.test(t)) console.log(`  console: ${t.slice(0, 400)}`);
    });
    await page.addInitScript(PROGRAM_VALIDITY_SOURCE);
    await page.goto(`${URL}/?${sessionQuery(['debug', 'forceinput', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.evaluate(() => { window.__programValidity.phase = 'play'; window.__piratesBR.setBotPeace?.(true); window.__piratesBR.setDayNightOverride?.(700); });
    await page.waitForTimeout(8000);

    if (MUTATE) {
      const ok = await page.evaluate(() => {
        const g = window.__piratesBR; const scene = g?.renderer?.scene;
        let proto = null; scene?.traverse((o) => { if (!proto && o.isMesh && o.material?.isShaderMaterial) proto = o; });
        if (!proto) return false;
        const m = proto.clone();
        m.material = proto.material.clone();
        m.material.vertexShader = 'varying vec3 vBroken; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
        m.material.fragmentShader = 'varying vec2 vBroken; void main(){ gl_FragColor = vec4(vBroken, 0.0, 1.0); }';
        m.material.needsUpdate = true; m.name = 'mutation-unlinkable'; m.frustumCulled = false;
        const p = g.getLocalPlayer?.();
        if (p) m.position.set(p.position.x, p.position.y + 2, p.position.z);
        scene.add(m);
        window.__mutantMaterial = m.material;
        return true;
      });
      if (!ok) throw new Error('the mutation never took: no ShaderMaterial mesh to clone, so this run proves nothing');
    }

    // ── THE TOUR: deck, hold, sea, cave, under the surface (free cam) ─────────
    const stops = await page.evaluate(() => {
      const g = window.__piratesBR; const s = g.state;
      const p = g.getLocalPlayer?.();
      const ships = s.ships ?? [];
      const own = ships.find((x) => x.id === g.localShipId) ?? ships[0] ?? null;
      const px = p?.position.x ?? 0, pz = p?.position.z ?? 0;
      const out = [];
      if (own) {
        out.push({ name: 'deck', x: own.position.x, y: own.position.y + 3.2, z: own.position.z, yaw: own.rotation ?? 0, pitch: -0.25 });
        out.push({ name: 'hold', x: own.position.x, y: own.position.y + 0.2, z: own.position.z, yaw: own.rotation ?? 0, pitch: -0.1 });
      }
      out.push({ name: 'sea', x: px + 140, y: 6, z: pz + 140, yaw: 0.8, pitch: -0.08 });
      let cave = null;
      for (const isl of s.islands ?? []) for (const c of isl.caves ?? []) if (!cave) cave = c;
      if (cave) {
        const cx = cave.position?.x ?? cave.x, cz = cave.position?.z ?? cave.z;
        out.push({ name: 'cave', x: cx, y: (g.sampleGroundY?.(cx, cz) ?? 0) + 1.6, z: cz, yaw: 0, pitch: 0 });
      }
      out.push({ name: 'underwater', x: px + 60, y: -3.5, z: pz + 60, yaw: 1.2, pitch: -0.05 });
      out.push({ name: 'underwater-up', x: px + 60, y: -2.2, z: pz + 60, yaw: 1.2, pitch: 0.6 });
      return out;
    });
    const tourShots = [];
    for (const st of stops) {
      await page.evaluate((v) => window.__piratesBR.enableFreeCam(v.x, v.y, v.z, v.yaw, v.pitch), st);
      await frames(page, STOP_FRAMES);
      const b = blackShare(await page.screenshot({ type: 'png' }));
      tourShots.push({ ...st, ...b });
      console.log(`  stop ${st.name.padEnd(14)} black ${(b.share * 100).toFixed(1)}%  luma ${b.meanLuma.toFixed(0)}`);
    }
    await page.evaluate(() => window.__piratesBR.disableFreeCam());
    await frames(page, STOP_FRAMES);

    // ── THE SWIM: walk the live pirate off the nearest shore ─────────────────
    linesAtSwim = consoleUseProgram.length;
    const swim = await page.evaluate(async () => {
      const g = window.__piratesBR; const s = g.state;
      const me = () => s.players.find((x) => x.id === g.localPlayerId);
      let p = me(); if (!p) return { reason: 'no local player' };
      let best = null, bestD = Infinity;
      for (const isl of s.islands) {
        const d = (isl.position.x - p.position.x) ** 2 + (isl.position.z - p.position.z) ** 2;
        if (d < bestD) { bestD = d; best = isl; }
      }
      window.__swimYaw = Math.atan2(p.position.x - (best?.position.x ?? 0), p.position.z - (best?.position.z ?? 0));
      g.input.setLook(window.__swimYaw, -0.02);
      return { start: p.state };
    });
    await page.keyboard.down('w');
    let swimState = null;
    for (let i = 0; i < 75; i++) {
      await page.waitForTimeout(1000);
      swimState = await page.evaluate(() => {
        const g = window.__piratesBR; const p = g.state.players.find((x) => x.id === g.localPlayerId);
        g.input.setLook(window.__swimYaw + Math.sin(performance.now() / 2500) * 0.4, -0.02);
        return p ? p.state : null;
      });
      if (swimState === 'swimming') break;
    }
    await page.waitForTimeout(2500);
    await page.keyboard.up('w');
    const swimShots = [];
    if (swimState !== 'swimming') {
      fail(`the pirate never reached the water (state ${swimState}, start ${swim.start ?? swim.reason})`);
    } else {
      for (const [name, pitch] of [['swim-surface-eye', -0.02], ['swim-look-down', -1.1], ['swim-look-up', 0.5]]) {
        await page.evaluate((pt) => window.__piratesBR.input.setLook(window.__swimYaw, pt), pitch);
        await frames(page, STOP_FRAMES);
        const st = await page.evaluate(() => {
          const g = window.__piratesBR; const p = g.state.players.find((x) => x.id === g.localPlayerId);
          const cam = g.renderer?.camera?.position;
          return { state: p?.state, camY: cam ? +cam.y.toFixed(2) : null };
        });
        const b = blackShare(await page.screenshot({ type: 'png', path: `/tmp/pbr-program-validity-${name}.png` }));
        swimShots.push({ name, ...st, ...b });
        console.log(`  ${name.padEnd(18)} state ${st.state} camY ${st.camY} black ${(b.share * 100).toFixed(1)}%  luma ${b.meanLuma.toFixed(0)}`);
      }
    }

    // ── VERDICT ──────────────────────────────────────────────────────────────
    const census = await page.evaluate(() => window.__programValidity.finish());
    console.log(`\n  live programs ${census.live}, checked at bind ${census.checked}, unlinked at bind ${census.invalidAtBind.length}, unlinked live ${census.invalidLive.length}, fallbacks ${census.fallbacks}`);
    for (const e of [...census.invalidAtBind, ...census.invalidLive].slice(0, 8)) {
      console.log(`    [${e.where}] ${e.name || '(no wrapper)'} key=${String(e.cacheKey).slice(0, 90)}`);
      if (e.programLog) console.log(`      program log: ${e.programLog.slice(0, 400).replace(/\n/g, ' | ')}`);
      if (e.vsLog) console.log(`      vertex log: ${e.vsLog.slice(0, 300).replace(/\n/g, ' | ')}`);
      if (e.fsLog) console.log(`      fragment log: ${e.fsLog.slice(0, 300).replace(/\n/g, ' | ')}`);
      if (e.stack) console.log(`      bound from: ${e.stack.slice(0, 400).replace(/\n/g, ' | ')}`);
    }
    if (MUTATE) {
      const swapped = await page.evaluate(() => {
        const m = window.__mutantMaterial; return m ? { fallback: m.userData?.programFallback === true } : null;
      });
      const grew = consoleUseProgram.length - linesAtSwim;
      console.log(`  mutant material fallback engaged: ${swapped?.fallback}; useProgram lines after the tour: +${grew}`);
      if (!swapped?.fallback) { mutantUnhandled = true; console.error('  x the unlinkable mutant material was not given the fallback program'); }
      if (grew > 0) { mutantUnhandled = true; console.error(`  x the broken program was still bound after the fallback window (+${grew} lines)`); }
    }
    if (consoleUseProgram.length) fail(`${consoleUseProgram.length} useProgram console lines, first: ${consoleUseProgram[0]}`);
    else pass('0 useProgram INVALID_OPERATION console lines');
    if (census.invalidAtBind.length) fail(`${census.invalidAtBind.length} programs had LINK_STATUS false when bound`);
    else pass(`0 programs bound with LINK_STATUS false (${census.checked} checked)`);
    if (census.invalidLive.length) fail(`${census.invalidLive.length} live programs have LINK_STATUS false`);
    else pass(`0 of ${census.live} live programs unlinked`);
    for (const s of swimShots) {
      if (s.state !== 'swimming') fail(`${s.name}: pirate left the swimming state (${s.state}) before the sample`);
      else if (s.share > BLACK_SHARE_MAX) fail(`${s.name}: ${(s.share * 100).toFixed(1)}% of the 3D view is black while alive and swimming`);
      else pass(`${s.name}: ${(s.share * 100).toFixed(1)}% black (bar ${BLACK_SHARE_MAX * 100}%)`);
    }
    for (const t of tourShots) if (t.share > BLACK_SHARE_MAX) fail(`tour stop ${t.name}: ${(t.share * 100).toFixed(1)}% black`);
    if (pageErrors.length) fail(`${pageErrors.length} page errors, first: ${pageErrors[0]}`);
  } catch (e) {
    fail(`run aborted: ${String(e?.stack ?? e).slice(0, 600)}`);
  } finally {
    await browser.close().catch(() => {});
    await stopDevClient(client);
  }
  // --mutate passes only when the census SAW the broken program (red lines) AND
  // the renderer flattened it so it stopped being bound.
  const mutateOk = failures > 0 && !mutantUnhandled;
  const verdict = MUTATE ? (mutateOk ? 'PASS (mutation caught and flattened)' : (failures > 0 ? 'FAIL (seen but not flattened)' : 'FAIL (mutation NOT caught: the gate is blind)')) : (failures ? 'FAIL' : 'PASS');
  console.log(`\n[program-validity] ${verdict}${failures ? ` (${failures})` : ''}`);
  process.exit(MUTATE ? (mutateOk ? 0 : 1) : (failures ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
