// STORM DEATH PROBE — stand at the wheel until the ring arrives, die of the
// weather, and read the four things the audit said were broken while it happens:
//
//   1. what the death screen CALLS the death (it said DROWNED for a storm),
//   2. whether the spectate camera shows anything at all (it was a black void),
//   3. whether the elimination card collides with itself / the live HUD,
//   4. whether taking storm damage at the wheel is VISIBLE (vignette, hp flash).
//
// It plays a real match on real ticks — there is no dev teleport, and the point
// is to see what a player sees. The captain simply holds his berth: the storm
// ring shrinks on its own schedule (STORM_PHASES) and comes to him, which is
// exactly the death the audit reported (100 → 74 → 0 at the wheel).
//
// ── WHAT THIS NEEDS FROM THE HOST ────────────────────────────────────────────
// A quiet machine. It waits on SIM time, and the dev server sheds ticks under
// load: with four agents' probes on one box (load average 40+) the sim ran at
// roughly 7% of real time and no amount of wall-clock budget reached the death.
// Check /health first — `worstSimLagSec` near 0 means this will finish; a lag
// that climbs while you watch means it will not. `?server=<port>` (PROBE_SERVER
// here) points the tab at a private server so at least the sim is yours alone.
//
//   node scripts/storm-death-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/killwave/deathcam';
mkdirSync(OUT, { recursive: true });
const NIGHT = process.env.PROBE_NIGHT === '1';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 }).catch((e) => console.log(`(shot ${n} skipped: ${e.message.split('\n')[0]})`));
const wait = (ms) => page.waitForTimeout(ms);

// Other agents editing this tree make vite full-reload the page mid-probe.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

// The first-voyage card tour is modal and would eat every key this probe sends.
await page.addInitScript(() => {
  try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
});
await page.goto(`http://127.0.0.1:3000/?debug&forceinput${process.env.PROBE_SERVER ? `&server=${process.env.PROBE_SERVER}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await wait(2500);
// Belt and braces: dismiss the tour if it opened anyway.
await page.evaluate(() => {
  const cards = document.getElementById('onboard-cards');
  if (cards?.classList.contains('visible')) document.getElementById('oc-skip')?.click();
});
await wait(400);
await page.evaluate((sec) => window.__piratesBR.setDayNightOverride(sec), NIGHT ? 374 : 854);

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const st = g.state.storm;
  const r2 = (v) => +v.toFixed(2);
  return {
    t: r2(g.state.serverTime ?? 0),
    health: me ? r2(me.health) : null,
    state: me?.state ?? null,
    atHelm: !!me?.atHelm,
    onShip: !!me?.onShipId,
    shipAlive: ship ? !!ship.alive : null,
    sinking: ship ? !!ship.sinking : null,
    anchored: ship ? !!ship.anchored : null,
    sail: ship ? r2(ship.sailHeight) : null,
    speed: ship ? r2(Math.hypot(ship.velocity.x, ship.velocity.z)) : null,
    heading: ship ? r2(ship.rotation) : null,
    distFromCentre: ship ? r2(Math.hypot(ship.position.x - st.centerX, ship.position.z - st.centerZ)) : null,
    meDist: me ? r2(Math.hypot(me.position.x - st.centerX, me.position.z - st.centerZ)) : null,
    safeRadius: r2(st.safeRadius),
    dmgPerSec: st.damagePerSec,
    // the four overlays this wave owns
    attrition: +(document.getElementById('attrition-vignette')?.style.opacity ?? 0),
    hurt: +(document.getElementById('hurt-vignette')?.style.opacity ?? 0),
    splash: +(document.getElementById('water-entry-flash')?.style.opacity ?? 0),
    hpFilter: document.getElementById('health-bar-wrap')?.style.filter ?? '',
  };
});

async function walkToLocal(lx, lz, maxSteps = 200, stopAt = 0.35) {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(([tx, tz, stop]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship) return 999;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + tx * cos + tz * sin;
      const wz = ship.position.z + tz * cos - tx * sin;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      g.input.setLook(Math.atan2(dx, dz), -0.3);
      if (Math.hypot(dx, dz) > stop) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
      return Math.hypot(dx, dz);
    }, [lx, lz, stopAt]);
    if (d < stopAt) break;
    await wait(90);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(200);
}

const pressX = async () => {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 70);
  });
  await wait(260);
};

const log = [];
const say = (m) => { console.log(m); log.push(m); };

// ── Board (spawn is already on deck in solo, but be sure) ────────────────────
let s = await snap();
say(`spawn: ${JSON.stringify(s)}`);

// ── Board, if the berth put us on the pier ───────────────────────────────────
for (let i = 0; i < 90 && !s.onShip; i++) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sh = g.state.ships.find((x) => x.id === me?.shipId);
    const st = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type];
    const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
    let best = null;
    for (const lx of [st.w * 0.56, -st.w * 0.56]) {
      const lz = -st.l * 0.18;
      const x = sh.position.x + lx * cos + lz * sin;
      const z = sh.position.z + lz * cos - lx * sin;
      const d = Math.hypot(x - me.position.x, z - me.position.z);
      if (!best || d < best.d) best = { x, z, d };
    }
    g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), best.d < 6 ? -0.1 : 0.02);
    g.input.keys.add('KeyW');
    g.input.jumpPressed = true;
  });
  await wait(200);
  const prompt = await page.evaluate(() => document.getElementById('interact-prompt')?.textContent ?? '');
  if (/Climb|Aboard|Board/i.test(prompt)) await pressX();
  s = await snap();
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
say(`aboard: ${s.onShip}`);

// ── Take the helm ────────────────────────────────────────────────────────────
const helmZ = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((x) => x.id === me?.shipId);
  const L = { sloop: 12, brigantine: 16, galleon: 22 }[ship.type] ?? 12;
  return -L * 0.37;
});
/** Look at a ship-local point, eye height — the arbiter scores on the look ray. */
async function lookAtLocal(lx, lz, worldYOffset = 0.95) {
  await page.evaluate(([tx, tz, yo]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    const h = { sloop: 1.5, brigantine: 1.8, galleon: 2.2 }[ship.type] ?? 1.5;
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const wx = ship.position.x + tx * cos + tz * sin;
    const wz = ship.position.z + tz * cos - tx * sin;
    const wy = ship.position.y + h + yo;
    const dx = wx - me.position.x, dz = wz - me.position.z;
    const eyeY = me.position.y + 1.8 * 0.72;
    g.input.setLook(Math.atan2(dx, dz), Math.atan2(wy - eyeY, Math.hypot(dx, dz)));
  }, [lx, lz, worldYOffset]);
  await wait(320);
}

for (let attempt = 0; attempt < 4 && !s.atHelm; attempt++) {
  await walkToLocal(0, helmZ + 1.0, 200, 0.28);
  await lookAtLocal(0, helmZ, 0.95);
  for (let i = 0; i < 4; i++) {
    await pressX();
    s = await snap();
    if (s.atHelm) break;
    const p = await page.evaluate(() => document.getElementById('interact-prompt')?.textContent ?? '');
    say(`  helm press ${i + 1} did nothing (prompt "${p}")`);
  }
}
say(`helm: atHelm=${s.atHelm}`);
await shot('00-at-helm');

// ── HOLD STATION AT THE WHEEL AND LET THE RING COME ─────────────────────────
// The audit's death, exactly: a captain stands at the helm and the tempest
// bills him 100 → 74 → 0 while he watches. No sailing tricks — the ring shrinks
// on its own schedule (STORM_PHASES) and arrives. Anchor stays down so the hull
// holds the berth it was given and the reading is about the weather, not about
// whether a probe can sail.
const trace = [];
const bleed = [];
let firstLoss = null;
let outsideAt = null;
let startHp = s.health;
const t0 = Date.now();
const shots = new Set();
let dead = null;

while (Date.now() - t0 < 720_000) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    if (ship) g.input.setLook(ship.rotation, 0.02);
  });
  const r = await snap();
  trace.push(r);
  bleed.push({ t: r.t, hp: r.health, att: r.attrition, hurt: r.hurt, hpFlash: r.hpFilter !== '', st: r.state, sink: r.sinking, d: r.meDist, safe: r.safeRadius });
  if (trace.length % 10 === 0) {
    say(`  waiting… t=${r.t} d=${r.meDist}/${r.safeRadius} hp=${r.health} att=${r.attrition} hurt=${r.hurt} hpFlash=${r.hpFilter !== ''} state=${r.state} sinking=${r.sinking}`);
  }
  if (outsideAt === null && r.meDist !== null && r.meDist > r.safeRadius) {
    outsideAt = r.t;
    startHp = r.health;
    say(`THE RING PASSED US: t=${r.t} d=${r.meDist} radius=${r.safeRadius}`);
    await shot('01-the-ring-arrives');
  }
  if (firstLoss === null && r.health !== null && r.health < 99.5) {
    firstLoss = r;
    say(`FIRST STORM DAMAGE: ${JSON.stringify(r)}`);
    await shot('02-first-storm-damage');
  }
  for (const [mark, hp] of [['03-storm-damage-75', 78], ['04-storm-damage-half', 52], ['05-storm-damage-critical', 22]]) {
    if (!shots.has(mark) && r.health !== null && r.health < hp) {
      shots.add(mark);
      await shot(mark);
      say(`  ${mark}: hp=${r.health} attritionVignette=${r.attrition} hurtVignette=${r.hurt} hpBarFlash="${r.hpFilter}"`);
    }
  }
  if (r.state === 'eliminated' || r.state === 'respawning' || r.state === 'downed') {
    dead = r;
    say(`DEAD: ${JSON.stringify(r)}`);
    break;
  }
  await wait(500);
}
say(`bleed done: outsideAt=${outsideAt} firstLoss=${firstLoss ? firstLoss.t : null} dead=${dead ? dead.state : 'never'}`);
await page.evaluate(() => {
  const k = window.__piratesBR.input.keys;
  k.delete('KeyA'); k.delete('KeyD'); k.delete('KeyW');
});

// If the first death was survivable, ride it out and keep going until the
// weather finishes the job for good — the elimination screen is the target.
if (dead && dead.state !== 'eliminated') {
  await wait(1500);
  await shot('10-respawn-blackout');
  const blackout = await page.evaluate(() => ({
    prompt: document.getElementById('interact-prompt')?.textContent ?? '',
    label: document.getElementById('context-label')?.textContent ?? '',
    serverCause: window.__piratesBR.hud.serverEliminationCause ?? null,
  }));
  say(`RESPAWN BLACKOUT: ${JSON.stringify(blackout)}`);
  const t1 = Date.now();
  while (Date.now() - t1 < 480_000) {
    const r = await snap();
    if (r.state === 'eliminated') { dead = r; say(`ELIMINATED: ${JSON.stringify(r)}`); break; }
    await wait(800);
  }
}

// ── The moment after ─────────────────────────────────────────────────────────
await wait(1200);
await shot('20-just-died');
await wait(4000);
await shot('21-spectate-4s');
await wait(6000);
await shot('22-spectate-10s');

const dom = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { text: (el.textContent ?? '').trim().slice(0, 200), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), visible: getComputedStyle(el).display !== 'none' && b.width > 0 };
  };
  const hud = document.getElementById('hud');
  return {
    state: me?.state ?? null,
    serverCause: g.hud.serverEliminationCause ?? null,
    deathScreen: box('death-screen'),
    title: box('death-title'),
    cause: box('death-cause'),
    stats: box('death-stats'),
    wait: box('death-wait'),
    actions: box('death-actions'),
    button: box('death-return-btn'),
    hudDisplay: hud ? getComputedStyle(hud).display : null,
    prompt: box('interact-prompt'),
    context: box('context-label'),
  };
});
say(`DEATH DOM: ${JSON.stringify(dom, null, 1)}`);

writeFileSync(`${OUT}/report.json`, JSON.stringify({ log, dom, bleed }, null, 1));
await browser.close();
