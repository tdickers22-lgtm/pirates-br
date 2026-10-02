// PROBE, not a gate (b4.2a, finding ships-12): the ship gallery. Read, never graded; its numbers feed the
// b4.2e/b4.2f gates. Promoted from the 2026-09-22 ships audit rig.
//
// Solo only ever spawns sloops and Squads is disabled, so a normal match never shows the brigantine or the
// galleon. This probe swaps the player's own ship for an AUDIT hull of each class inside ShipRenderer.update
// (anchored in open water, full sail, sailAngle 0 so the yards are pinned square), then renders 3 classes x
// 10 views and prints per-view metrics:
//   frameLuma    mean Rec.709 luma of the beauty frame (0..255)
//   hullLuma     mean luma of the beauty frame over the pixels the ID pass marks as hull (ship-hull-* materials)
//   white        fraction of the whole frame with luma > 235 (blown highlights)
//   sailWhite    fraction of sail pixels with luma > 235 (sails reading as flat paper white)
//   bandWhite    (band-15m view only) foam-white fraction of a 2 m band around the stationary hull at 15 m:
//                the ID-pass hull mask dilated by the projected 2 m, minus every ship pixel, counted where
//                luma > 200 and chroma (max-min) < 40. The grade caps highlights below 235, so frame `white`
//                reads 0 everywhere; this is the foam-tray metric (b4.2e gate < 8%).
//   sailPx/hullPx and sailHull = sailPx / hullPx, from a material-swap ID pass: every sail mesh (userData.sailKind
//                or material ship-sail-canvas) drawn pure red, every ship-hull-* mesh pure green, the rest of the
//                ship black, all MeshBasicMaterial without fog or tone mapping; originals restored right after.
//
// Machine protection: its own stack on 3101 (Vite) / 8091 (server), one headless SwiftShader Chromium at
// 960x540 via scripts/lib/browser-args.mjs, everything killed in finally. Refuses to start while
// ~/.vidlab/recording exists (a take is being recorded) and waits while load1 > 8.
//
//   node scripts/probes/ship-gallery.mjs [--quality high|balanced|low] [--only sloop,galleon] [--views near-bowq,band-15m]
//                                        [--out dir] [--recompute]
// Gates (b4.2e, printed and stored under report.gates): hullLuma >= 45/255 at noon on every outboard view
// (near-bowq, mid-broadside, stern); bandWhite < 0.08 on band-15m. Exit code 1 when one fails.
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { readPng } from '../lib/png-read.mjs';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const QUALITY = arg('quality', 'high');
const ONLY = arg('only', 'sloop,brigantine,galleon').split(',');
const OUT = arg('out', 'test-results/ship-gallery');
const VIEWS = arg('views', '') ? arg('views', '').split(',') : null;
const HULL_LUMA_MIN = 45, BAND_WHITE_MAX = 0.08, SAIL_HULL_MIN = 1.6;
// Trim per view (b4.2f). The ships-02 verifier: the sail/hull gate "must pin trim square TO THE CAMERA or it
// measures trim, not rig". sailAngle 0 squares the yards to the HULL, which a broadside camera sees edge-on
// (sail normal = ship forward), so mid-broadside braces the yards to the rig's visual limit (1.15 rad, the
// ShipRenderer clamp = MAX_BRACE 65 deg), canvas turned toward the +x camera: the nearest legal trim to
// square-to-camera. mid-broadside-square keeps the old sailAngle 0 frame as an ungraded diagnostic.
const BRACE_TO_CAMERA = 1.15;
// Shaded-hull luma is graded on the low outboard views; band-15m looks down on the sunlit deck (deck planks
// share the ship-hull material), so it is excluded from the luma gate.
const OUTBOARD_VIEWS = ['near-bowq', 'mid-broadside', 'stern'];
const SERVER_PORT = '8091', CLIENT_PORT = '3101', MAP_SEED = '20260801';
const URL_BASE = `http://127.0.0.1:${CLIENT_PORT}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(`${homedir()}/.vidlab/recording`)) { console.error('[gallery] ~/.vidlab/recording exists: a take is running, not starting a browser'); process.exit(2); }
const load1 = () => { try { return Number(execSync('sysctl -n vm.loadavg').toString().split(' ')[1]); } catch { return 0; } };
while (load1() > 8) { console.log(`[gallery] load ${load1()} > 8, waiting 45 s`); await sleep(45_000); }

const started = [];
let browser = null;
function killStack() {
  for (const { name, child } of started.splice(0)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    console.log(`[gallery] stopped ${name}`);
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
    if (await isUp(url)) { console.log(`[gallery] ${name} up at ${url}`); return; }
    await sleep(500);
  }
  throw new Error(`${name} never answered ${url}`);
}

const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
// ID classes after the grade: sail red ~(250,25,25), hull green ~(150,230,85), other black -> cream ~(230,215,185).
const isSail = (r, g, b) => r > 200 && g < 70 && b < 70;
const isHull = (r, g, b) => g > 190 && b < 130 && g - r > 40;
const isOther = (r, g, b) => r > 195 && g > 180 && b > 140 && b < 215 && r - b > 25 && r - b < 75;
// Foam-white ring: Euclidean dilation of the hull mask by bandPx (row distance pass, then a disc over rows).
function bandWhite(beauty, id, bandPx) {
  const W = beauty.width, H = beauty.height, R = Math.max(1, Math.round(bandPx));
  const hull = new Uint8Array(W * H), ship = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const j = p * id.channels, r = id.data[j], g = id.data[j + 1], b = id.data[j + 2];
    hull[p] = isHull(r, g, b) ? 1 : 0; ship[p] = hull[p] || isSail(r, g, b) || isOther(r, g, b) ? 1 : 0;
  }
  const dx = new Float32Array(W * H).fill(1e9);
  for (let y = 0; y < H; y++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) { if (hull[y * W + x]) last = x; dx[y * W + x] = x - last; }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (hull[y * W + x]) last = x; dx[y * W + x] = Math.min(dx[y * W + x], last - x); }
  }
  let ring = 0, foam = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (ship[p]) continue;
    let inside = false;
    for (let d = -R; d <= R && !inside; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; const h = dx[yy * W + x]; if (h * h + d * d <= R * R) inside = true; }
    if (!inside) continue;
    ring++;
    const i = p * beauty.channels, r = beauty.data[i], g = beauty.data[i + 1], b = beauty.data[i + 2];
    if (luma(beauty.data, i) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40) foam++;
  }
  return { bandWhite: ring ? +(foam / ring).toFixed(3) : null, bandPx: R, ringPx: ring };
}
function metrics(beauty, id, opts = {}) {
  const n = beauty.width * beauty.height;
  let frameL = 0, white = 0, hullL = 0, hullPx = 0, sailPx = 0, sailWhite = 0;
  for (let p = 0; p < n; p++) {
    const i = p * beauty.channels, j = p * id.channels;
    const l = luma(beauty.data, i);
    frameL += l; if (l > 235) white++;
    const r = id.data[j], g = id.data[j + 1], b = id.data[j + 2];
    // The game's final grade still runs over the flat ID colours (measured: red -> ~(250,25,25),
    // green -> ~(150,230,85), black -> cream ~(230,215,185)), so classify by hue margin, not by purity.
    if (isSail(r, g, b)) { sailPx++; if (l > 235) sailWhite++; }
    else if (isHull(r, g, b)) { hullPx++; hullL += l; }
  }
  const r3 = (v) => +v.toFixed(3);
  return { frameLuma: +(frameL / n).toFixed(1), hullLuma: hullPx ? +(hullL / hullPx).toFixed(1) : null, white: r3(white / n),
    sailWhite: sailPx ? r3(sailWhite / sailPx) : null, sailPx, hullPx, sailHull: hullPx ? r3(sailPx / hullPx) : null,
    ...(opts.bandPx ? bandWhite(beauty, id, opts.bandPx) : {}) };
}
const line = (v) => `[gallery] ${v.type.padEnd(10)} ${v.view.padEnd(16)} luma ${String(v.frameLuma).padStart(5)} hull ${String(v.hullLuma).padStart(5)} white ${v.white.toFixed(3)} sailWhite ${v.sailWhite ?? '-'} sail/hull ${v.sailHull ?? '-'} (${v.sailPx}/${v.hullPx} px)${v.bandWhite != null ? ` band2m ${v.bandWhite} (${v.ringPx} px, r ${v.bandPx})` : ''}`;
function grade(views, live) {
  const fails = [];
  for (const v of views) {
    if (OUTBOARD_VIEWS.includes(v.view) && v.hullLuma != null && v.hullLuma < HULL_LUMA_MIN) fails.push(`${v.type} ${v.view} hullLuma ${v.hullLuma} < ${HULL_LUMA_MIN}`);
    if (v.view === 'band-15m' && !(v.bandWhite != null && v.bandWhite < BAND_WHITE_MAX)) fails.push(`${v.type} band-15m bandWhite ${v.bandWhite} >= ${BAND_WHITE_MAX}`);
    if (v.view === 'mid-broadside' && !(v.sailHull != null && v.sailHull >= SAIL_HULL_MIN)) fails.push(`${v.type} mid-broadside sail/hull ${v.sailHull} < ${SAIL_HULL_MIN}`);
  }
  for (const [type, c] of Object.entries(live ?? {})) {
    if (c.helmCourse != null && Math.abs(c.helmCourse - 0.35) > 0.03) fails.push(`${type} helm first-person course opacity ${c.helmCourse} != 0.35`);
    if (c.offHelmCourse != null && c.offHelmCourse < 0.999) fails.push(`${type} course opacity off the helm ${c.offHelmCourse} != 1`);
    if (c.furl && !(c.furl.topsailsShown === 0 && c.furl.coursesShown === c.furl.courses)) fails.push(`${type} at sailHeight 0.3 topsails shown ${c.furl.topsailsShown}, courses shown ${c.furl.coursesShown}/${c.furl.courses} (topsail must furl first)`);
  }
  if (!views.some((v) => OUTBOARD_VIEWS.includes(v.view) && v.hullLuma != null)) fails.push('no outboard view with hull pixels was graded');
  for (const f of fails) console.log(`[gallery] GATE FAIL ${f}`);
  if (!fails.length) console.log(`[gallery] gates OK (hullLuma >= ${HULL_LUMA_MIN} on outboard views, band2m white < ${BAND_WHITE_MAX}, mid-broadside sail/hull >= ${SAIL_HULL_MIN}, helm course fade, topsail furls first)`);
  return { hullLumaMin: HULL_LUMA_MIN, bandWhiteMax: BAND_WHITE_MAX, sailHullMin: SAIL_HULL_MIN, fails };
}

// --recompute: re-derive the metrics from the PNG pairs a previous run saved (no stack, no browser).
if (process.argv.includes('--recompute')) {
  const file = `${OUT}/ship-gallery-${QUALITY}.json`;
  const prev = JSON.parse(readFileSync(file, 'utf8'));
  for (const v of prev.views) {
    Object.assign(v, metrics(readPng(readFileSync(`${OUT}/${v.file}`)), readPng(readFileSync(`${OUT}/${v.file.replace(/\.png$/, '.id.png')}`)), { bandPx: v.bandPx }));
    console.log(line(v));
  }
  prev.gates = grade(prev.views, prev.live); if (prev.gates.fails.length) process.exitCode = 1;
  writeFileSync(file, JSON.stringify(prev, null, 2));
  process.exit(process.exitCode ?? 0);
}

const report = { quality: QUALITY, gl: describeGl(), viewport: '960x540', trim: 'square (sailAngle 0)', census: {}, views: [] };
try {
  await ensure('server', 'npx tsx src/server/index.ts', `http://127.0.0.1:${SERVER_PORT}/health`, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, URL_BASE, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  // HMR client stubbed (keep /@vite/env: Vite 5 installs `define` globals from it).
  await page.route('**/@vite/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: [
    "import '/@vite/env';",
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export default {};'].join('\n') }));
  await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* */ } });
  await page.goto(`${URL_BASE}/?debug&forceinput&peace&quality=${QUALITY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
  await sleep(3000);
  await page.addStyleTag({ content: '#hud,#debug-perf-panel{visibility:hidden!important}' });
  await page.evaluate(() => {
    const g = window.__piratesBR; g.setDayNightOverride?.(854); g.setWeatherOverride?.(0); g.setBotPeace?.(true);
    const sr = g.shipRenderer; const orig = sr.update.bind(sr);
    window.__audit = { type: null };
    sr.update = (ships, players, t, dt, ...rest) => {
      const a = window.__audit; a.calls = (a.calls ?? 0) + 1; if (!a.type) return orig(ships, players, t, dt, ...rest);
      // Paired shots (b4.2e): while a.freeze is set the audit hull keeps one pose and one wave clock, so the
      // ID pass masks the hull the beauty frame drew (it used to bob between the two screenshots and the
      // stern view counted water as hull: sloop 185.9 on 2.4k px).
      if (a.freeze) { if (a.frozenT == null) a.frozenT = t; t = a.frozenT; dt = 1e-6; if (a.frozenFake) return orig(ships.filter((s) => s.id !== a.frozenOwn).concat([a.frozenFake]), players, t, dt, ...rest); }
      else { a.frozenT = null; a.frozenFake = null; }
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const own = ships.find((s) => s.id === me?.shipId) ?? ships[0];
      if (!a.spot) {
        // Open water: the nearest ring point around the berth with no ground over a 140 m disc.
        // Sea rocks are props, not terrain (sampleGroundY misses them) and carry their own foam ring.
        const rocks = g.state.seaRocks ?? [];
        const deep = (x, z) => { if (rocks.some((k) => Math.hypot(k.position.x - x, k.position.z - z) < k.radius + 70)) return false; for (let r = 0; r <= 140; r += 20) for (let k = 0; k < 12; k++) { const an = k * Math.PI / 6; if (g.sampleGroundY(x + Math.cos(an) * r, z + Math.sin(an) * r) > 0.001) return false; } return true; };
        outer: for (let R = 60; R <= 900; R += 40) for (let k = 0; k < 24; k++) { const an = k * Math.PI / 12; const x = own.position.x + Math.cos(an) * R, z = own.position.z + Math.sin(an) * R; if (deep(x, z)) { a.spot = { x, z }; break outer; } }
        a.spot = a.spot ?? { x: own.position.x, z: own.position.z };
      }
      const fake = { ...own, position: { ...own.position, x: a.spot.x, z: a.spot.z }, id: 'audit-' + a.type, type: a.type, sailHeight: a.sailHeight ?? 1, sailAngle: a.trim ?? 0,
        holes: a.holes, anchored: true, velocity: { x: 0, y: 0, z: 0 }, hull: 9999, maxHull: 9999, waterLevel: 0 };
      if (a.freeze) { a.frozenFake = fake; a.frozenOwn = own.id; }
      return orig(ships.filter((s) => s.id !== own.id).concat([fake]), players, t, dt, ...rest);
    };
  });
  const H = { sloop: 2.2, brigantine: 2.8, galleon: 3.5 }, L = { sloop: 12, brigantine: 16, galleon: 22 }, W = { sloop: 5, brigantine: 7, galleon: 10 };
  const camLocal = (id, p, t) => page.evaluate(([id, p, t]) => {
    const g = window.__piratesBR; const grp = g.shipRenderer.getShipGroup(id); if (!grp) return false;
    grp.updateMatrixWorld(true);
    const P = grp.localToWorld(grp.position.clone().set(...p)); const T = grp.localToWorld(grp.position.clone().set(...t));
    const dx = T.x - P.x, dy = T.y - P.y, dz = T.z - P.z; const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(P.x, P.y, P.z, Math.atan2(dx / len, dz / len), Math.asin(dy / len));
    return true;
  }, [id, p, t]);
  // ID pass: swap, wait two frames, shoot, restore (the restore runs even if the shot throws).
  const idSwap = (id, on) => page.evaluate(([id, on]) => new Promise((res) => {
    const g = window.__piratesBR; const grp = g.shipRenderer.getShipGroup(id); if (!grp) return res(false);
    if (on) {
      const saved = new Map();
      const Basic = window.__galleryBasic;
      grp.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const name = mats[0]?.name ?? '';
        const kind = o.userData?.sailKind || name === 'ship-sail-canvas' ? 'sail' : name.startsWith('ship-hull') ? 'hull' : 'other';
        saved.set(o, o.material);
        const m = Basic[kind];
        o.material = Array.isArray(o.material) ? mats.map(() => m) : m;
      });
      window.__gallerySaved = saved;
    } else {
      for (const [o, m] of window.__gallerySaved ?? []) o.material = m;
      window.__gallerySaved = null;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => res(true)));
  }), [id, on]);
  // The page exposes no THREE global, so the flat ID materials borrow the MeshBasicMaterial class from a
  // material already in the scene.
  await page.evaluate(() => {
    const g = window.__piratesBR; const scene = g.renderer.scene ?? g.scene;
    let Basic = null;
    scene.traverse((o) => { if (!Basic && o.material && !Array.isArray(o.material) && o.material.type === 'MeshBasicMaterial') Basic = o.material.constructor; });
    if (!Basic) throw new Error('no MeshBasicMaterial in the scene to borrow');
    const flat = (hex) => { const m = new Basic({ color: hex, fog: false, side: 2 /* DoubleSide: sails are seen from both faces */ }); m.toneMapped = false; return m; };
    window.__galleryBasic = { sail: flat(0xff0000), hull: flat(0x00ff00), other: flat(0x000000) };
  });

  for (const type of ONLY) {
    const h = H[type], l = L[type], w = W[type];
    await page.evaluate(([type, h, l, w]) => { const a = window.__audit; a.type = type;
      a.holes = [{ id: 1, x: w * 0.47, y: h * 0.25, z: l * 0.08, patched: false, tier: 1 }, { id: 2, x: w * 0.44, y: h * 0.25, z: -l * 0.12, patched: true, tier: 1 }]; }, [type, h, l, w]);
    const id = 'audit-' + type;
    // Hull builds are paced by the first-draw budget, and SwiftShader under load is slow: wait for the group.
    const built = await page.waitForFunction((id) => !!window.__piratesBR.shipRenderer.getShipGroup(id), id, { timeout: 90_000 }).then(() => true).catch(() => false);
    if (!built) {
      const diag = await page.evaluate(() => ({ audit: { ...window.__audit, holes: undefined }, ships: window.__piratesBR.state.ships.map((s) => s.id + ':' + s.type) }));
      throw new Error(`audit ${type} never built: ${JSON.stringify(diag)} errors ${JSON.stringify(errors.slice(0, 5))}`);
    }
    // ShipRenderer never drops a hull that leaves the ship list, so the previous class's audit hull stays parked on
    // the same open-water spot, frozen in its last pose: it was the second mast cluster over the galleon (b4.2f).
    // Hide every other audit hull; the ID pass only swaps this group, so a stale one in front stole its pixels.
    await page.evaluate((id) => { const sr = window.__piratesBR.shipRenderer; for (const k of ['sloop', 'brigantine', 'galleon']) { const o = sr.getShipGroup('audit-' + k); if (o && 'audit-' + k !== id) o.visible = false; } }, id);
    await sleep(2500);
    report.census[type] = await page.evaluate((id) => {
      const grp = window.__piratesBR.shipRenderer.getShipGroup(id); if (!grp) return null;
      let tris = 0, meshes = 0; const mats = new Set();
      grp.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.visible) return;
        const geo = o.geometry; const n = geo.index ? geo.index.count : geo.attributes.position.count;
        tris += (n / 3) * (o.isInstancedMesh ? o.count : 1); meshes++;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.uuid));
      });
      return { tris: Math.round(tris), meshes, materials: mats.size };
    }, id);
    console.log(`[gallery] ${type}`, JSON.stringify(report.census[type]));
    const sunSide = await page.evaluate((id) => {
      const g = window.__piratesBR; const grp = g.shipRenderer.getShipGroup(id); const scene = g.renderer.scene ?? g.scene;
      let sun = null; scene.traverse((o) => { if (o.isDirectionalLight && (!sun || o.intensity > sun.intensity)) sun = o; });
      if (!sun) return 1;
      grp.updateMatrixWorld(true);
      const d = sun.position.clone().sub(sun.target.position); const side = grp.localToWorld(grp.position.clone().set(1, 0, 0)).sub(grp.localToWorld(grp.position.clone().set(0, 0, 0)));
      return d.x * side.x + d.z * side.z >= 0 ? 1 : -1;
    }, id);
    const plan = [
      ['near-bowq', [w * 0.5 + 9, h + 2.5, l * 0.5 + 7], [0, h * 0.8, l * 0.1]],
      ['mid-broadside', [w * 0.5 + 38, h + 5, 0], [0, h, 0], BRACE_TO_CAMERA],
      ['mid-broadside-square', [w * 0.5 + 38, h + 5, 0], [0, h, 0], 0],
      ['far-quarter', [w + 90, 16, l + 70], [0, h, 0]],
      // ~290 m: past the 250 m band, LOD3 with the alpha-tested rig cards (b4.2h); ungraded diagnostic.
      ['far-290', [w + 215, 34, l + 185], [0, h + 4, 0]],
      // Low stern quarter aimed at the sternpost so the rudder hanging on it is in frame.
      ['stern', [3, h + 1.6, -(l * 0.5 + 9)], [0, h * 0.45, -l * 0.45]],
      ['hull-hole-close', [w * 0.5 + 3.5, h * 0.4, 0], [0, h * 0.25, 0]],
      ['deck-fwd', [0.4, h + 1.8, -l * 0.3], [0, h + 0.8, l * 0.5]],
      ['deck-aft', [0.4, h + 1.8, l * 0.25], [0, h + 1.2, -l * 0.5]],
      ['hold-fwd', [0.3, 1.9, -l * 0.18], [0, 1.2, l * 0.35]],
      ['hold-aft', [0.3, 1.9, l * 0.15], [0, 1.2, -l * 0.35]],
      ['rig-up', [w * 0.5 + 6, h + 1, 0], [0, h + 9, 0]],
      // Stationary hull from 15 m (9 m out from the side, 12 m up, 53 deg down: no sky in frame) for the
      // 2 m foam band around the waterline.
      // The camera sits on the sun's side of the hull (sun behind it), so specular glints do not land in the band.
      ['band-15m', [sunSide * (w * 0.5 + 9), 12, 0], [sunSide * w * 0.5, 0, 0]],
    ].filter(([name]) => !VIEWS || VIEWS.includes(name));
    for (const [name, p, t, trim = 0] of plan) {
      const retrim = await page.evaluate((trim) => { const a = window.__audit; const was = a.trim ?? 0; a.trim = trim; return was !== trim; }, trim);
      await camLocal(id, p, t); await sleep(1200);
      // The brace is a dt-driven lerp (Game clamps dt to 50 ms): under a loaded SwiftShader a fixed 2.5 s once
      // shot the sloop half-braced (sail/hull 1.315 vs 2.519 settled). Wait until every yard sits on the trim.
      if (retrim) await page.waitForFunction((id) => {
        const want = Math.max(-1.15, Math.min(1.15, window.__audit.trim ?? 0)); let ok = true;
        window.__piratesBR.shipRenderer.getShipGroup(id).traverse((o) => { const pv = o.userData?.trimPivot; if (o.userData?.sailKind === 'square' && pv && Math.abs(pv.rotation.y - want) > 0.02) ok = false; });
        return ok;
      }, id, { timeout: 60_000, polling: 250 }).catch(() => console.log(`[gallery] ${type} ${name}: yards did not settle on trim ${trim}`));
      // The audit hull copies the own ship's heading every frame, so a long settle lets it swing under a camera
      // placed in its old local frame (a brig "broadside" shot came out bow-quarter, hull 1237 px vs 3365):
      // re-aim in the current frame after the wait.
      if (retrim) { await camLocal(id, p, t); await sleep(1200); }
      // 2 m at the waterline beside the hull, projected to px (for the band metric).
      const bandPx = name !== 'band-15m' ? 0 : await page.evaluate(([id, x]) => {
        const g = window.__piratesBR; const grp = g.shipRenderer.getShipGroup(id); const cam = g.renderer.camera;
        grp.updateMatrixWorld(true); cam.updateMatrixWorld(true);
        const a = grp.localToWorld(grp.position.clone().set(x, 0, -1)).project(cam), b = grp.localToWorld(grp.position.clone().set(x, 0, 1)).project(cam);
        return Math.hypot((a.x - b.x) * 480, (a.y - b.y) * 270);
      }, [id, sunSide * w * 0.5]);
      await page.evaluate(() => window.__piratesBR.settleLod?.(2)).catch(() => {});
      const file = `${type}-${name}-${QUALITY}`;
      // Freeze the audit hull's pose for both shots, wait two frames so the frozen pose is the drawn one.
      await page.evaluate(() => new Promise((res) => { window.__audit.freeze = true; requestAnimationFrame(() => requestAnimationFrame(() => res(true))); }));
      let beautyBuf, idBuf;
      try {
        beautyBuf = await page.screenshot({ path: `${OUT}/${file}.png`, timeout: 120_000 });
        try { await idSwap(id, true); idBuf = await page.screenshot({ path: `${OUT}/${file}.id.png`, timeout: 120_000 }); }
        finally { await idSwap(id, false); }
      } finally { await page.evaluate(() => { window.__audit.freeze = false; }); }
      const m = metrics(readPng(beautyBuf), readPng(idBuf), { bandPx });
      const v = { type, view: name, trim, file: `${file}.png`, ...m };
      report.views.push(v);
      console.log(line(v));
    }
    // Live own-ship rig checks (b4.2f), numbers off the real update path: the audit hull carries the local crew,
    // so the helmsman's first-person course fade and the furl order run as in play. Skipped with --views.
    if (!VIEWS || VIEWS.includes('helm-fp')) {
      const courses = () => page.evaluate((id) => {
        const grp = window.__piratesBR.shipRenderer.getShipGroup(id); const r = { n: 0, op: 0, courses: 0, coursesShown: 0, topsails: 0, topsailsShown: 0 };
        grp.traverse((o) => { const k = o.userData?.sailKind ? o.userData.rigKind : null; /* canvas only, not the furled bundles */ if (k === 'course') { r.courses++; if (o.visible) r.coursesShown++; if (o.material) { r.n++; r.op += o.material.opacity; } } if (k === 'topsail') { r.topsails++; if (o.visible) r.topsailsShown++; } });
        return { ...r, op: r.n ? Math.round(r.op / r.n * 1000) / 1000 : null };
      }, id);
      await page.evaluate(() => { window.__audit.trim = 0; window.__audit.sailHeight = 1; });
      const hz = -l * 0.315 - 0.5;
      // The fade is a dt-driven lerp and Game clamps dt to 50 ms, so under SwiftShader (a few fps) it takes
      // seconds of wall clock: wait for the steady state instead of a fixed sleep (a 2.5 s sleep read 0.83).
      const settle = (pred) => page.waitForFunction(([id, pred]) => {
        let n = 0, op = 0; window.__piratesBR.shipRenderer.getShipGroup(id).traverse((o) => { if (o.userData?.sailKind && o.userData.rigKind === 'course' && o.material) { n++; op += o.material.opacity; } });
        return n > 0 && (pred === 'faded' ? op / n <= 0.36 : op / n >= 0.999);
      }, [id, pred], { timeout: 40_000, polling: 250 }).catch(() => {});
      await camLocal(id, [0, h + 2.4, hz], [0, h + 5, l * 0.5]); await sleep(1200); await settle('faded');
      const atHelm = await courses();
      if (atHelm.courses) await page.screenshot({ path: `${OUT}/${type}-helm-fp-${QUALITY}.png`, timeout: 120_000 });
      await camLocal(id, [w * 0.5 + 38, h + 5, 0], [0, h, 0]); await sleep(1200); await settle('solid');
      const offHelm = await courses();
      await page.evaluate(() => { window.__audit.sailHeight = 0.3; }); await sleep(1500);
      const furled = await courses();
      await page.evaluate(() => { window.__audit.sailHeight = 1; }); await sleep(1500);
      report.live = report.live ?? {};
      report.live[type] = atHelm.courses ? { helmCourse: atHelm.op, offHelmCourse: offHelm.op, furl: { courses: furled.courses, coursesShown: furled.coursesShown, topsails: furled.topsails, topsailsShown: furled.topsailsShown }, helmFrame: `${type}-helm-fp-${QUALITY}.png` } : { courses: 0 };
      console.log(`[gallery] ${type.padEnd(10)} live ${JSON.stringify(report.live[type])}`);
    }
  }
  report.gates = grade(report.views, report.live); if (report.gates.fails.length) process.exitCode = 1;
  report.info = await page.evaluate(() => { const r = window.__piratesBR.renderer.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, programs: r.programs?.length }; });
  report.pageErrors = errors.slice(0, 20);
} catch (e) {
  console.error('[gallery] ERROR', e); report.error = String(e); process.exitCode = 1;
  report.pageErrors = report.pageErrors ?? [];
} finally {
  writeFileSync(`${OUT}/ship-gallery-${QUALITY}.json`, JSON.stringify(report, null, 2));
  console.log(`[gallery] report ${OUT}/ship-gallery-${QUALITY}.json`);
  try { await browser?.close(); } catch { reapBrowser(); }
  reapBrowser(); killStack(); await sleep(1500);
}
