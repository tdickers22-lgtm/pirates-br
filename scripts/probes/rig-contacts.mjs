#!/usr/bin/env node
// rig-contacts (b3.3c, animations-02): do the hands of a SKINNED pirate really close on the live
// station grips of a live ship? Fails when they do not.
//
//   node scripts/probes/rig-contacts.mjs [outDir=/tmp/pbr-rig-contacts]
//
// Boots its OWN stack on 3101 (Vite) / 8091 (server, seed 20260801, dev hooks) unless one already
// answers there (never 3000/8090, never 8080), drives ONE headless software-GL Chromium
// (scripts/lib/browser-args.mjs) at 960x540 on ?debug&quality=balanced (a skinned rig tier), starts a
// Solo voyage and, on the local player's own LIVE ship (the ShipRenderer group: heel, bob, spinning
// wheel, cannon yaw/pitch):
//   - helm: a bot helmsman the server put at the wheel (BotPirate.standStation) is measured as is,
//     nothing staged. If no bot holds the helm within 40 s, a rigged crewmate is staged there instead
//     (reported as staged).
//   - capstan, cannon, mast ladder: a rigged crewmate is STAGED at the station. The game's own
//     PlayerAnimator.animatePlayerMesh runs every frame (real clip, real mixer, real
//     applyStationContacts on nearestGripHolder of the live ship); the probe only overrides the
//     station flag on a copy of the player (atCapstan / atCannon / mastClimb) and the stand spot:
//       capstan: 1.0 m aft of the capstan centre, facing it, on the deck;
//       cannon:  getCannonDeckLocalPosition(stats, 0) on the deck (where Match.snapPlayerToCannon puts a gunner);
//       ladder:  PhysicsSystem's climb line (x 0.42, z mastZ - 0.12), boots on rung 2.
//     Stand spots are ship-local points taken through the ship group's world matrix, the body upright
//     in world like Game keeps it.
// For each station, after >= 24 animate calls and >= 1.2 s: each palm (hand bone + 0.07 m along the
// forearm, the solver's PALM) to the nearest grip point of that station's holder, in world.
// Assertions (exit 1 on any):
//   - the body is a skinned rig and the holder exists (VACUOUS = FAIL);
//   - both palms <= 0.08 m from a grip at the helm, capstan, cannon and ladder.
// Mutation that must turn it red: solveTwoBone in ikSolvers.ts returning before it writes.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] ?? '/tmp/pbr-rig-contacts');
mkdirSync(OUT, { recursive: true });
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
if (['3000', '8090', '8080'].includes(CLIENT_PORT) || ['3000', '8090', '8080'].includes(SERVER_PORT)) {
  console.error('rig-contacts: 3000/8090 are the owner\'s ports and 8080 corrupts WebSockets on this Mac');
  process.exit(2);
}
const TOL = 0.08;
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
  if (await up(url)) { console.log(`[rig-contacts] ${name} already up at ${url}, reusing it`); return; }
  const log = createWriteStream(`/tmp/pbr-rig-contacts-${name}.log`);
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stdout.pipe(log); child.stderr.pipe(log);
  started.push(child);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before listening (see /tmp/pbr-rig-contacts-${name}.log)`);
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
  const utils = await import('/src/shared/utils/index.ts');
  const inter = await import('/src/shared/interactions.ts');
  const consts = await import('/src/shared/constants/index.ts');
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me.shipId);
  const stats = consts.SHIP_STATS[ship.type];
  const group = g.shipRenderer.getShipGroup(ship.id);
  const V = group.position.constructor;
  const holders = [];
  group.traverse((o) => { if (o.userData?.ikGrips) holders.push(o); });
  const gripWorld = (h) => { h.updateWorldMatrix(true, false); return h.userData.ikGrips.points.map((p) => p.clone().applyMatrix4(h.matrixWorld)); };
  const nearestHolder = (kind, w) => {
    let best = null, bd = Infinity;
    for (const h of holders) {
      if (h.userData.ikGrips.kind !== kind) continue;
      const d = h.getWorldPosition(new V()).distanceToSquared(w);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  };
  const centroid = (pts) => pts.reduce((a, p) => a.add(p), new V()).multiplyScalar(1 / pts.length);
  const deckLocalY = (x, z) => utils.getShipDeckY(0, stats) + utils.getShipDeckRaiseAt({ x, z }, stats);
  const toWorld = (x, y, z) => { group.updateWorldMatrix(true, false); return group.localToWorld(new V(x, y, z)); };
  const toLocal = (w) => { group.updateWorldMatrix(true, false); return group.worldToLocal(w.clone()); };

  /** Stand spot (world) + holder for a staged station, recomputed every frame (the ship moves). */
  function stage(kind) {
    if (kind === 'helm') {
      const l = inter.getHelmControlLocal(stats);
      const w = toWorld(l.x, deckLocalY(l.x, l.z), l.z);
      return { stand: w, holder: nearestHolder('helm', w) };
    }
    if (kind === 'cannon') {
      const l = inter.getCannonDeckLocalPosition(stats, 0);
      const w = toWorld(l.x, deckLocalY(l.x, l.z), l.z);
      return { stand: w, holder: nearestHolder('cannon', w) };
    }
    if (kind === 'capstan') {
      const a = inter.getAnchorControlLocal(stats);
      const h = nearestHolder('capstan', toWorld(a.x, deckLocalY(a.x, a.z), a.z));
      if (!h) return { stand: null, holder: null };
      const c = toLocal(centroid(gripWorld(h)));
      const z = c.z - 1.0;
      return { stand: toWorld(c.x, deckLocalY(c.x, z), z), holder: h };
    }
    // ladder: PhysicsSystem's climb line, boots on rung 2
    const mastZ = utils.getMainMastLocalZ(stats);
    const w0 = toWorld(0.42, deckLocalY(0.42, mastZ - 0.12), mastZ - 0.12);
    const h = nearestHolder('ladder', w0);
    if (!h) return { stand: null, holder: null };
    const rung2 = toLocal(gripWorld(h)[4]);
    return { stand: toWorld(0.42, rung2.y + 0.03, mastZ - 0.12), holder: h };
  }

  function palms(mesh) {
    const rig = mesh.userData.rig;
    rig.root.updateWorldMatrix(true, true);
    const out = {};
    for (const s of ['l', 'r']) {
      const hand = rig.root.getObjectByName(`hand_${s}`);
      const fore = rig.root.getObjectByName(`lowerarm_${s}`) ?? rig.root.getObjectByName(`forearm_${s}`);
      if (!hand || !fore) { out[s] = null; continue; }
      const h = hand.getWorldPosition(new V()); const f = fore.getWorldPosition(new V());
      out[s] = h.clone().add(h.clone().sub(f).normalize().multiplyScalar(0.07));
    }
    return out;
  }
  function measure(mesh, holder) {
    const grips = gripWorld(holder);
    const p = palms(mesh);
    const res = {};
    for (const s of ['l', 'r']) res[s] = p[s] ? Math.min(...grips.map((gp) => gp.distanceTo(p[s]))) : null;
    const local = mesh.worldToLocal(centroid(grips));
    res.gripFromBody = { f: +local.z.toFixed(2), y: +local.y.toFixed(2) };
    return res;
  }

  const anim = g.anim;
  if (!anim.__rcOrig) anim.__rcOrig = anim.animatePlayerMesh.bind(anim);
  const st = { mode: null, id: null, calls: 0, last: null, t0: 0 };
  window.__rc = st;
  // The measured body is driven by the probe's own per-frame loop, through the game's own
  // animatePlayerMesh (Game skips culled bodies, and a staged body is somewhere else in the
  // world until the probe moves it); Game's own call for that one body is dropped.
  anim.animatePlayerMesh = (mesh, player, shp, dt, remote) => {
    if (st.mode && player.id === st.id) return;
    return anim.__rcOrig(mesh, player, shp, dt, remote);
  };
  const holdersOf = (grp) => { const l = []; grp?.traverse((o) => { if (o.userData?.ikGrips) l.push(o); }); return l; };
  let prev = performance.now();
  function drive() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    if (!st.mode) return;
    const mesh = g.playerMeshes.get(st.id);
    const player = g.state.players.find((q) => q.id === st.id);
    if (!mesh?.userData?.rig || !player) { st.last = { noBody: true }; return; }
    st.calls += 1;
    if (st.mode === 'live-helm') {
      const shp = g.state.ships.find((s) => s.id === player.onShipId);
      anim.__rcOrig(mesh, player, shp ?? null, dt, null);
      const grp = shp ? g.shipRenderer.getShipGroup(shp.id) : null;
      let holder = null, bd = Infinity;
      for (const h of holdersOf(grp)) {
        if (h.userData.ikGrips.kind !== 'helm') continue;
        const d = h.getWorldPosition(new V()).distanceTo(mesh.position);
        if (d < bd) { bd = d; holder = h; }
      }
      st.last = holder ? { ...measure(mesh, holder), atHelm: player.atHelm, ship: shp?.type ?? null, clip: mesh.userData.rig.upper?.name ?? null } : { noHolder: true };
      return;
    }
    const { stand, holder } = stage(st.mode);
    if (!stand || !holder) { st.last = { noHolder: true }; return; }
    const c = centroid(gripWorld(holder));
    mesh.position.copy(stand);
    mesh.rotation.set(0, Math.atan2(c.x - stand.x, c.z - stand.z), 0);
    mesh.visible = true;
    mesh.updateMatrixWorld(true);
    const p = Object.create(player);
    Object.assign(p, {
      atHelm: st.mode === 'helm', atCannon: st.mode === 'cannon', cannonIndex: st.mode === 'cannon' ? 0 : null,
      atCapstan: st.mode === 'capstan', mastClimb: st.mode === 'ladder' ? 0.3 : null,
      state: 'alive', velocity: { x: 0, y: 0, z: 0 }, onShipId: ship.id,
    });
    anim.__rcOrig(mesh, p, ship, dt, null);
    st.last = { ...measure(mesh, holder), clip: mesh.userData.rig.upper?.name ?? null };
  }
  const loop = () => { try { drive(); } catch (e) { st.last = { error: String(e?.stack ?? e) }; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // Skinned remote bodies, alive; crewmates of this ship first.
  const crew = [];
  for (const [id, m] of g.playerMeshes) {
    if (id === g.localPlayerId || !m.userData?.rig) continue;
    const pl = g.state.players.find((q) => q.id === id);
    if (pl && pl.state === 'alive') crew.push({ id, atHelm: !!pl.atHelm, mine: pl.onShipId === ship.id });
  }
  crew.sort((a, b) => Number(b.mine) - Number(a.mine));
  const counts = holders.reduce((o, h) => ((o[h.userData.ikGrips.kind] = (o[h.userData.ikGrips.kind] ?? 0) + 1), o), {});
  return { ship: ship.type, crew, holders: counts };
}

async function run(page, mode, id) {
  await page.evaluate(([m, i]) => { Object.assign(window.__rc, { mode: m, id: i, calls: 0, last: null, t0: performance.now() }); }, [mode, id]);
  await page.waitForFunction(() => window.__rc.calls >= 24 && performance.now() - window.__rc.t0 >= 1200, null, { timeout: 120_000 });
  const last = await page.evaluate(() => window.__rc.last);
  await page.evaluate(() => { window.__rc.mode = null; });
  return last;
}

// ── run ────────────────────────────────────────────────────────────────────
const report = { gl: describeGl(), tol: TOL, stations: {} };
let browser;
try {
  await ensure('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
  await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });
  console.log(`[rig-contacts] stack ${CLIENT_URL} / :${SERVER_PORT}, gl ${describeGl()}`);
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
  report.ship = info.ship; report.holders = info.holders; report.crew = info.crew;
  console.log(`  ship ${info.ship}, grip holders ${JSON.stringify(info.holders)}, rigged remote bodies ${info.crew.length} (${info.crew.filter((c) => c.mine).length} on this ship) (${info.crew.filter((c) => c.atHelm).length} at the helm)`);
  expect('a skinned remote pirate exists to drive (non-vacuous)', info.crew.length > 0, `${info.crew.length}`);
  for (const k of ['helm', 'capstan', 'cannon', 'ladder']) expect(`the live ship tags ${k} grips`, (info.holders[k] ?? 0) > 0, `${info.holders[k] ?? 0}`);

  if (info.crew.length > 0) {
    // helm: prefer the bot the server stood at the wheel.
    let helmsman = info.crew.find((c) => c.atHelm)?.id ?? null;
    if (!helmsman) {
      helmsman = await page.waitForFunction(() => {
        const g = window.__piratesBR;
        const pl = g.state.players.find((q) => q.atHelm && q.id !== g.localPlayerId && q.state === 'alive' && g.playerMeshes.get(q.id)?.userData?.rig);
        return pl?.id ?? false;
      }, null, { timeout: 40_000, polling: 1000 }).then((h) => h.jsonValue()).catch(() => null);
    }
    const bodyId = info.crew.find((c) => c.id !== helmsman)?.id ?? info.crew[0].id;
    // Every live helmsman (one per hull type seen): the wheel's stand-off differs per hull.
    const helmsmen = info.crew.filter((c) => c.atHelm).map((c) => c.id);
    if (helmsman && !helmsmen.includes(helmsman)) helmsmen.push(helmsman);
    const stations = [
      ...(helmsmen.length ? helmsmen.slice(0, 8).map((id, i) => [`helm#${i}`, 'live-helm', id]) : [['helm', 'helm', bodyId]]),
      ['capstan', 'capstan', bodyId],
      ['cannon', 'cannon', bodyId],
      ['ladder', 'ladder', bodyId],
    ];
    for (const [kind, mode, id] of stations) {
      const m = await run(page, mode, id);
      report.stations[kind] = { mode, id, ...m };
      if (!m || m.noHolder || m.noBody || m.error) { expect(`${kind}: holder found`, false, JSON.stringify(m)); continue; }
      if (m.ship) report.stations[kind].shipType = m.ship;
      const fmt = (v) => (v === null ? 'no hand' : v.toFixed(3));
      console.log(`  ${kind} [${mode === 'live-helm' ? `LIVE bot at the wheel of a ${m.ship}` : 'staged'}] clip ${m.clip}: palm l ${fmt(m.l)} r ${fmt(m.r)} m, grips f ${m.gripFromBody.f} y ${m.gripFromBody.y}`);
      expect(`${kind}: left palm <= ${TOL} m from a grip`, m.l !== null && m.l <= TOL, fmt(m.l));
      expect(`${kind}: right palm <= ${TOL} m from a grip`, m.r !== null && m.r <= TOL, fmt(m.r));
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
console.log(`\nrig-contacts: ${failures ? `${failures} FAIL` : 'all green'}; ${path.join(OUT, 'numbers.json')}`);
process.exit(failures ? 1 : 0);
