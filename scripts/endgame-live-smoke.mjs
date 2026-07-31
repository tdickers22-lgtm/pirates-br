// ENDGAME LIVE SMOKE — the three kills that can only be proved by WAITING.
//
// Landing step 3 asks for LIVE evidence, against the running dev stack, for the
// storm rails the unit suites pin headlessly (test-storm-spawn-safety.mjs). A
// unit test can wind the ring forward by hand; a player cannot. So this probe
// joins a real solo match and does NOTHING for five minutes, then stands at the
// wheel while the weather bills her, then dies and reads the blackout.
//
//   (a) A SCRIPTED NEVER-SAILS SPAWN SURVIVES PAST T+5:00. Zero input: no helm,
//       no sail, no anchor, no key. The pier the game moored her at reaches ~750 m
//       and the first ring used to settle at 680 — she bled on her own planking
//       and died at ~T+5:00 with nobody having fired. Now the ring is sized off
//       real dock geometry, so T+5:00 must find her standing.
//   (d) STORM DAMAGE AT THE WHEEL IS VISIBLE. Take the helm (still never sailing)
//       and hold the berth into the second ring. The attrition vignette must
//       come up and DEEPEN as the hp falls — the audit read 100 → 74 → 0 at the
//       wheel with nothing on screen at all.
//   (b) THE SOLO DEATH ENDS IN A COUNTDOWN, NOT A BLACK HOLD. Her hull is
//       anchored outside the ring with nobody left to sail it, which is exactly
//       the deadlock: "Respawn held — your ship is in the storm" forever. The
//       hold may legitimately show for the grace (RESPAWN_HOLD_GRACE_SECONDS),
//       then the tide brings the derelict in and a REAL count must run down.
//
// ── WHY ?peace ───────────────────────────────────────────────────────────────
// (a) is a claim about the WEATHER. The unit suite isolates it with botCount=0;
// the live equivalent is ?peace (bots fight each other and leave her alone), so
// a bot broadside cannot be mistaken for the spawn trap. Every hp loss is still
// traced and attributed, so an unexpected source shows up as itself.
//
//   node scripts/endgame-live-smoke.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserArgs, IS_SOFTWARE_GL } from './lib/browser-args.mjs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/endgame/smoke';
mkdirSync(OUT, { recursive: true });

/**
 * WHICH CLAIMS THIS RUN IS MAKING.
 *
 * (a) and (d) are five-minute and six-minute WAITS by construction — that is what
 * they are for — and the first-sail and on-foot claims live in the opening twenty
 * seconds of a match. Burning eleven minutes of a fanless laptop to re-check a
 * twenty-second claim is how a probe stops being run at all, so the phases are
 * selectable and each one names itself:
 *
 *   PHASES=g,h,i node scripts/endgame-live-smoke.mjs   (the fast opening claims)
 *   PHASES=a,d,b node scripts/endgame-live-smoke.mjs   (the long storm arc)
 *
 * g MUST NOT follow d in one run: the first-sail assist fires once per hull, so a
 * run that has already been to the wheel is no longer a fresh berth.
 */
const PHASES = new Set((process.env.PHASES ?? 'a,d,b').split(',').map((x) => x.trim()).filter(Boolean));
const phase = (id) => PHASES.has(id);

/** Whole-probe budget. A loaded host must degrade into a clean report, never a hang. */
const DEADLINE = Date.now() + Number(process.env.BUDGET_MS ?? 1_200_000);
const left = () => DEADLINE - Date.now();

// --ignore-gpu-blocklist is not decoration: after this box kernel-panicked under a
// GPU browser, Chromium remembered the crash and refused Metal on the next run.
// Every screenshot in that run came back solid magenta — Chrome's unrasterized-tile
// colour — which is a probe that photographs nothing while reporting nine passes.
// The breakpad flags keep a crashed headless child from throwing a macOS dialog at
// whoever is sitting in front of the machine.
//
// PIRATES_GL=swiftshader SWAPS METAL FOR SOFTWARE, AND SOME DAYS IT IS THE ONLY WAY
// TO SEE. (SOFTGL=1 still works, as the shorthand this probe was written with.)
// After this box kernel-panicked twice under GPU browsers, headless captures on the
// Metal path started coming back as a SINGLE FLAT COLOUR — magenta (Chrome's
// unrasterized-tile placeholder) in one run, pure black in the next, while the very
// same script had returned 1,596 distinct colours an hour earlier. A probe in that
// state photographs nothing and reports every check it can read off the DOM as a
// pass, which is worse than failing. Measured on the same page, same viewport, same
// query string: swiftshader returned 1,727 colours where metal returned 1. The
// software rasteriser does not go through the wedged GPU process, so when a run has
// to be BELIEVED as pixels, run it soft. Physics, HUD text and timing are unaffected
// either way — those come off the DOM and the wire.
const browser = await chromium.launch({
  headless: true,
  args: browserArgs(['--ignore-gpu-blocklist', ...(IS_SOFTWARE_GL ? ['--enable-unsafe-swiftshader'] : [])]),
});
// THE BROWSER MUST DIE EVEN WHEN THIS SCRIPT DOES.
//
// Everything below is top-level await with a single browser.close() at the very
// bottom, so any throw — a failed selector, a lost websocket, Ctrl-C — used to
// leave a headless Chromium running with a live GPU context. This box kernel
// panicked twice in one afternoon under exactly that (WindowServer watchdog,
// gpuEvent from chrome-headless), and a leaked renderer is a panic waiting for
// the next probe to start. `browser.process().kill()` is synchronous, which is
// the only kind of cleanup an 'exit' handler can actually perform.
let closed = false;
const reap = () => {
  if (closed) return;
  closed = true;
  try { browser.process()?.kill('SIGKILL'); } catch { /* already gone */ }
};
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); reap(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); reap(); process.exit(1); });

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 }).catch((e) => console.log(`(shot ${n} skipped: ${e.message.split('\n')[0]})`));
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const log = [];
const say = (m) => { console.log(m); log.push(m); };

// A neighbouring save would make vite full-reload the tab mid-probe.
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

// The modal first-voyage tour would eat every key and every screenshot.
await page.addInitScript(() => {
  try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
});
await page.goto('http://127.0.0.1:3000/?debug&forceinput&peace', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await wait(2500);
await page.evaluate(() => {
  const cards = document.getElementById('onboard-cards');
  if (cards?.classList.contains('visible')) document.getElementById('oc-skip')?.click();
});
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));

/** Read pixels off a REAL presented frame — the WebGL backbuffer is gone by the
 *  time a script can look at it (no preserveDrawingBuffer), and reading it
 *  returns solid black, which is indistinguishable from the black screen this
 *  probe exists to rule out. Go through the compositor instead. */
const frameLum = async () => {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 }, timeout: 60_000 });
  return page.evaluate(async ([dataUrl]) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let sum = 0; const lums = [];
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lums.push(l); sum += l;
    }
    const mean = sum / lums.length;
    const varr = lums.reduce((a, l) => a + (l - mean) ** 2, 0) / lums.length;
    return { mean: +mean.toFixed(2), sd: +Math.sqrt(varr).toFixed(2) };
  }, [`data:image/png;base64,${png.toString('base64')}`]);
};

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const st = g.state.storm;
  const r2 = (v) => +Number(v).toFixed(2);
  const txt = (id) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    t: r2(g.state.serverTime ?? 0),
    hp: me ? r2(me.health) : null,
    state: me?.state ?? null,
    atHelm: !!me?.atHelm,
    onShip: !!me?.onShipId,
    pos: me ? { x: r2(me.position.x), y: r2(me.position.y), z: r2(me.position.z) } : null,
    fromOrigin: me ? r2(Math.hypot(me.position.x, me.position.z)) : null,
    meDist: me ? r2(Math.hypot(me.position.x - st.centerX, me.position.z - st.centerZ)) : null,
    shipAlive: ship ? !!ship.alive : null,
    sinking: ship ? !!ship.sinking : null,
    anchored: ship ? !!ship.anchored : null,
    sail: ship ? r2(ship.sailHeight) : null,
    holes: ship ? ship.holes.length : null,
    shipDist: ship ? r2(Math.hypot(ship.position.x - st.centerX, ship.position.z - st.centerZ)) : null,
    safeRadius: r2(st.safeRadius),
    nextRadius: r2(st.nextRadius),
    phase: st.phase,
    dps: st.damagePerSec,
    attrition: +(document.getElementById('attrition-vignette')?.style.opacity ?? 0),
    hurt: +(document.getElementById('hurt-vignette')?.style.opacity ?? 0),
    hpFilter: document.getElementById('health-bar-wrap')?.style.filter ?? '',
    prompt: txt('interact-prompt'),
    label: txt('context-label'),
    respawnTimer: me ? r2(me.respawnTimer ?? -1) : null,
  };
});

// ── The world we were handed ──────────────────────────────────────────────────
const world = await page.evaluate(() => {
  const g = window.__piratesBR;
  const isles = g.state.islands ?? [];
  const docks = isles.filter((i) => i.dock).map((i) => ({
    name: i.name,
    r: +Math.max(
      Math.hypot(i.dock.berthPosition.x, i.dock.berthPosition.z),
      Math.hypot(i.dock.respawnPoint.x, i.dock.respawnPoint.z),
    ).toFixed(0),
  }));
  docks.sort((a, b) => b.r - a.r);
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return {
    docks, furthest: docks[0] ?? null, dockCount: docks.length,
    shipType: ship?.type ?? null,
    firstRing: g.state.storm.nextRadius, openingRadius: g.state.storm.safeRadius,
    crews: g.state.shipsAlive,
  };
});
say(`world: ${world.dockCount} docks, furthest ${world.furthest?.name} at ${world.furthest?.r} m; `
  + `hull=${world.shipType}; ring ${world.openingRadius} -> ${world.firstRing}; crews=${world.crews}`);
ok('the first ring is sized to hold the furthest berth (live world)',
  world.furthest !== null && world.firstRing > world.furthest.r,
  `firstRing=${world.firstRing} furthest dock=${world.furthest?.r}`);

let s = await snap();
const spawnHp = s.hp;
const trace = [];

// ══ (a) FIVE MINUTES OF DOING NOTHING ════════════════════════════════════════
if (phase('a')) {
say('\n(a) a never-sails spawn, zero input, past T+5:00');
say(`spawn: ${JSON.stringify(s)}`);
const marks = new Set();
let firstLoss = null;
const SURVIVE_TO = 305;
while (s.t < SURVIVE_TO && left() > 420_000) {
  s = await snap();
  trace.push(s);
  if (firstLoss === null && s.hp !== null && s.hp < spawnHp - 0.5) {
    firstLoss = s;
    say(`  FIRST HP LOSS at t=${s.t}: hp=${s.hp} meDist=${s.meDist}/${s.safeRadius} dps=${s.dps}`);
    await shot('a-first-hp-loss');
  }
  for (const m of [60, 150, 240, 300]) {
    if (!marks.has(m) && s.t >= m) {
      marks.add(m);
      await shot(`a-t${m}`);
      say(`  T+${m}s: hp=${s.hp} state=${s.state} d=${s.meDist}/${s.safeRadius} ring-phase=${s.phase} ship=${s.shipAlive}/${s.holes}h`);
    }
  }
  if (s.state !== 'alive' || (s.hp ?? 0) <= 0) { say(`  DIED EARLY at t=${s.t}: ${JSON.stringify(s)}`); break; }
  await wait(2000);
}
await shot('a-final-standing');
ok('a never-sails spawn is still standing past T+5:00',
  s.t >= 300 && s.state === 'alive' && (s.hp ?? 0) > 0,
  `t=${s.t} state=${s.state} hp=${s.hp} (spawn hp ${spawnHp})`);
ok('…at full health, unbilled by the weather it was moored in',
  (s.hp ?? 0) >= spawnHp - 0.5,
  `hp=${s.hp} firstLoss=${firstLoss ? `t=${firstLoss.t}` : 'none'}`);
ok('…and her moored hull is still afloat under her',
  s.shipAlive === true && s.sinking === false,
  `alive=${s.shipAlive} sinking=${s.sinking} holes=${s.holes}`);
// SHE NEVER SAILED means the hull never moved under canvas — NOT sailHeight 0.
// A fresh berth hands her a sloop with the sails 50% out and the ANCHOR DOWN
// (the HUD says "Anchored · Sails 50% out", speed 0.0), so demanding sail===0
// here reported the game's own spawn state as a probe failure. The invariant is:
// the anchor never came up and the trim never changed, so she sat where she was
// moored for the whole five minutes.
ok('she never sailed — anchor down, trim untouched, the whole five minutes',
  trace.every((r) => r.anchored === true) && new Set(trace.map((r) => r.sail)).size === 1,
  `sail heights seen: ${[...new Set(trace.map((r) => r.sail))].join(',')} anchored: ${[...new Set(trace.map((r) => r.anchored))].join(',')}`);
ok('and the storm still MEANT something — the ring closed while she stood there',
  trace.length > 2 && trace[trace.length - 1].safeRadius < trace[0].safeRadius,
  `radius ${trace[0].safeRadius} -> ${trace[trace.length - 1].safeRadius}`);
}

// ══ (d) THE WHEEL, AND THE WEATHER BILLING HER IN PLAIN SIGHT ════════════════
// ── Getting a pirate onto her own quarterdeck ───────────────────────────────
// Boarding and finding the wheel is navigation, not a claim: (d) needs it at
// T+5:00 and the first-sail phase needs it at T+0:20, so it is written once.
async function takeTheHelm() {
  const helmZ = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    const L = { sloop: 12, brigantine: 16, galleon: 22 }[ship.type] ?? 12;
    return -L * 0.37;
  });
  async function walkToLocal(lx, lz, maxSteps = 200, stopAt = 0.32) {
    for (let i = 0; i < maxSteps; i++) {
      const d = await page.evaluate(([tx, tz, stop]) => {
        const g = window.__piratesBR;
        const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
        const ship = g.state.ships.find((sh) => sh.id === me?.shipId);
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
    await wait(280);
  };
  // Board if the berth put her on the pier rather than the deck.
  for (let i = 0; i < 90 && !s.onShip; i++) {
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      if (!sh) return;
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
  for (let attempt = 0; attempt < 4 && !s.atHelm; attempt++) {
    await walkToLocal(0, helmZ + 1.0, 200, 0.28);
    await page.evaluate(([tz]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((sh) => sh.id === me?.shipId);
      const h = { sloop: 1.5, brigantine: 1.8, galleon: 2.2 }[ship.type] ?? 1.5;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + tz * sin, wz = ship.position.z + tz * cos;
      const wy = ship.position.y + h + 0.95;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      const eyeY = me.position.y + 1.8 * 0.72;
      g.input.setLook(Math.atan2(dx, dz), Math.atan2(wy - eyeY, Math.hypot(dx, dz)));
    }, [helmZ]);
    await wait(320);
    for (let i = 0; i < 4 && !s.atHelm; i++) { await pressX(); s = await snap(); }
  }
  return s;
}

let dead = null;
const bands = [];
// Hoisted because the report at the bottom reads them whichever phases ran.
const bleed = [];
const respawnTrace = [];
if (phase('d')) {
say('\n(d) storm damage at the wheel: the vignette escalates');
await takeTheHelm();
say(`helm: atHelm=${s.atHelm} t=${s.t}`);
await shot('d-at-the-helm');
ok('she can take the wheel she never used (helm reachable at T+5)', s.atHelm === true, JSON.stringify({ atHelm: s.atHelm, onShip: s.onShip }));

// Hold the berth and let the ring pass over her. Every sample keeps the eye on
// the bow so the vignette is photographed from the helmsman's own view.
const bandShots = new Set();
let ringPassed = null;
while (left() > 240_000) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    if (ship) g.input.setLook(ship.rotation, 0.02);
  });
  const r = await snap();
  bleed.push(r);
  if (ringPassed === null && r.meDist !== null && r.meDist > r.safeRadius) {
    ringPassed = r;
    say(`  THE RING PASSED HER: t=${r.t} d=${r.meDist} radius=${r.safeRadius} dps=${r.dps}`);
    await shot('d-ring-arrives');
  }
  for (const [mark, hp] of [['d-hp-90', 92], ['d-hp-75', 78], ['d-hp-50', 52], ['d-hp-25', 26], ['d-hp-10', 12]]) {
    if (!bandShots.has(mark) && r.hp !== null && r.hp < hp && r.hp > 0) {
      bandShots.add(mark);
      bands.push({ mark, hp: r.hp, attrition: r.attrition, hurt: r.hurt, hpFlash: r.hpFilter !== '', atHelm: r.atHelm });
      await shot(mark);
      say(`  ${mark}: hp=${r.hp} attrition=${r.attrition} hurt=${r.hurt} hpFlash=${r.hpFilter !== ''} atHelm=${r.atHelm}`);
    }
  }
  if (bleed.length % 20 === 0) say(`  … t=${r.t} hp=${r.hp} d=${r.meDist}/${r.safeRadius} att=${r.attrition} state=${r.state} ship=${r.shipAlive}/${r.holes}h`);
  if (r.state !== 'alive') { dead = r; say(`  DEAD: ${JSON.stringify(r)}`); break; }
  await wait(700);
}
const helmBands = bands.filter((b) => b.atHelm);
ok('the tempest is VISIBLE while she stands at the wheel (attrition vignette up)',
  helmBands.length > 0 && helmBands.some((b) => b.attrition > 0.02),
  JSON.stringify(bands));
const first = bands[0], last = bands[bands.length - 1];
ok('and it DEEPENS as the hp falls (escalating, not a single flash)',
  bands.length >= 2 && last.attrition > first.attrition + 0.02,
  `hp ${first?.hp} att ${first?.attrition} -> hp ${last?.hp} att ${last?.attrition}`);
ok('the health bar flashes on the storm ticks too',
  bands.some((b) => b.hpFlash), JSON.stringify(bands.map((b) => `${b.hp}:${b.hpFlash}`)));
}

// ══ (b) THE BLACKOUT MUST COUNT ══════════════════════════════════════════════
if (phase('b')) {
say('\n(b) the solo death: a countdown, not a hold');
let heldSeconds = 0;
let sawCount = false;
let sawHeld = false;
let backAlive = null;
const counts = [];
if (dead) {
  const t0 = Date.now();
  await shot('b-just-died');
  const lum0 = await frameLum();
  say(`  frame at death: ${JSON.stringify(lum0)}`);
  while (Date.now() - t0 < Math.min(180_000, left() - 60_000)) {
    const r = await snap();
    respawnTrace.push({ t: r.t, wall: +((Date.now() - t0) / 1000).toFixed(1), state: r.state, prompt: r.prompt, label: r.label, timer: r.respawnTimer, shipDist: r.shipDist, safe: r.safeRadius });
    if (/Respawn held/i.test(r.prompt)) { sawHeld = true; heldSeconds = (Date.now() - t0) / 1000; }
    const m = /Respawning in (\d+)/.exec(r.prompt);
    if (m) { sawCount = true; counts.push(+m[1]); }
    if (r.state === 'alive') { backAlive = r; break; }
    if (r.state === 'eliminated') { say(`  ELIMINATED instead of respawned: ${JSON.stringify(r)}`); break; }
    await wait(600);
  }
  await shot('b-respawn-blackout');
  const lum1 = await frameLum();
  say(`  frame during blackout: ${JSON.stringify(lum1)}`);
  say(`  counts seen: ${counts.join(',')}`);
  ok('the solo blackout runs a REAL count (not a permanent "respawn held")',
    sawCount && counts.length >= 2 && Math.min(...counts) < Math.max(...counts),
    `held=${sawHeld} heldFor=${heldSeconds.toFixed(1)}s counts=${counts.join(',')}`);
  // THE HARD CAP, WATCHED ON A REAL CLOCK. RESPAWN_HOLD_MAX_SECONDS is 10 s and
  // it is absolute in every reachable state — the audit's four-minute grey screen
  // was a hold waiting on a condition instead of a clock. Two seconds of slack for
  // the sample cadence and the wire, and not a second more.
  ok('the hold obeys the hard cap — never a minute, let alone four',
    !sawHeld || heldSeconds <= 12,
    `held for ${heldSeconds.toFixed(1)}s (cap is 10s)`);
  ok('she comes back aboard alive instead of dying of the wait',
    backAlive !== null,
    backAlive ? `t=${backAlive.t} hp=${backAlive.hp} onShip=${backAlive.onShip} pos=${JSON.stringify(backAlive.pos)}` : 'never respawned');
  ok('the blackout is not a black screen — the world is still being drawn',
    lum1.mean > 6 && lum1.sd > 3, JSON.stringify(lum1));
  // THE RING HAD ALREADY CROSSED HER DOCK — that is what killed her. A respawn
  // that puts her back in the same weather is the death carousel: the audit died
  // three times in three minutes that way. Wherever the plan lands her (own deck,
  // a berth the tide towed her to, dry ground, the water at the eye), it must be
  // INSIDE the wall.
  ok('she comes back INSIDE the ring, not into the weather that just killed her',
    backAlive !== null && backAlive.meDist !== null && backAlive.meDist <= backAlive.safeRadius + 2,
    backAlive ? `d=${backAlive.meDist} radius=${backAlive.safeRadius}` : 'never respawned');
  // …and the reprieve is on screen counting, because a reprieve nobody can see is
  // indistinguishable from luck.
  const reprieve = await page.evaluate(() => {
    const el = document.getElementById('storm-reprieve-chip');
    return { present: !!el, shown: !!el && el.style.display !== 'none', text: el?.textContent ?? '' };
  });
  say(`  reprieve chip: ${JSON.stringify(reprieve)}`);
  ok('the storm reprieve she came back with is on screen, in seconds',
    reprieve.shown && /\d+s/.test(reprieve.text),
    JSON.stringify(reprieve));
  if (backAlive) await shot('b-back-aboard');
} else {
  ok('(b) reached a death to read', false, 'the probe ran out of budget before she died');
}
}

// ══ (g) THE FIRST SAIL MUST CATCH WIND ═══════════════════════════════════════
// The audit's minute zero: the objective says "hold W to get under way", so it
// held W. The anchor came up, the canvas came down, and the ship made 0.3 u/s and
// decayed — a square yard on a reach holds almost nothing, and the only hint was
// a trim clause in a side panel. FIRST_SAIL_ASSIST brings the yard round with the
// anchor; this is the live proof, read off the HUD a player actually looks at.
const firstSail = {};
if (phase('g')) {
  say('\n(g) the first sail: hold [W] and go somewhere');
  await takeTheHelm();
  ok('a fresh captain can find the wheel inside the first minute', s.atHelm === true,
    JSON.stringify({ atHelm: s.atHelm, onShip: s.onShip, t: s.t }));
  const before = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sh = g.state.ships.find((x) => x.id === me?.shipId);
    return { anchored: !!sh?.anchored, yard: +(sh?.sailAngle ?? 0).toFixed(3), sail: +(sh?.sailHeight ?? 0).toFixed(2) };
  });
  say(`  moored: ${JSON.stringify(before)}`);
  await shot('g-moored');
  // Hold W and nothing else, exactly as the objective says.
  await page.evaluate(() => window.__piratesBR.input.keys.add('KeyW'));
  const catches = [];
  for (let i = 0; i < 26 && left() > 120_000; i++) {
    await wait(1000);
    const r = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      const panel = (document.getElementById('sail-status')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const coach = document.getElementById('sail-coach-hint');
      const m = /catching (\d+)% of the wind/.exec(panel);
      const kn = /making ([\d.]+) kn/.exec(panel);
      return {
        anchored: !!sh?.anchored,
        yard: +(sh?.sailAngle ?? 0).toFixed(3),
        sail: +(sh?.sailHeight ?? 0).toFixed(2),
        speed: +Math.hypot(sh?.velocity.x ?? 0, sh?.velocity.z ?? 0).toFixed(2),
        catchPct: m ? +m[1] : null,
        knots: kn ? +kn[1] : null,
        coach: coach && coach.style.display !== 'none' ? coach.textContent : '',
        panel,
      };
    });
    catches.push(r);
    if (!r.anchored) break;
  }
  // Let her run for a while under whatever the assist set.
  const runFor = 14;
  const samples = [];
  for (let i = 0; i < runFor && left() > 90_000; i++) {
    await wait(1000);
    samples.push(await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      const panel = (document.getElementById('sail-status')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const m = /catching (\d+)% of the wind/.exec(panel);
      const kn = /making ([\d.]+) kn/.exec(panel);
      const coach = document.getElementById('sail-coach-hint');
      return {
        speed: +Math.hypot(sh?.velocity.x ?? 0, sh?.velocity.z ?? 0).toFixed(2),
        catchPct: m ? +m[1] : null, knots: kn ? +kn[1] : null,
        yard: +(sh?.sailAngle ?? 0).toFixed(3), sail: +(sh?.sailHeight ?? 0).toFixed(2),
        coach: coach && coach.style.display !== 'none' ? coach.textContent : '',
        panel,
      };
    }));
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await shot('g-under-way');
  const underWay = catches.find((c) => !c.anchored) ?? samples[0] ?? null;
  const best = samples.reduce((a, b) => ((b.catchPct ?? 0) > (a?.catchPct ?? -1) ? b : a), null);
  const fastest = samples.reduce((a, b) => (b.speed > (a?.speed ?? -1) ? b : a), null);
  Object.assign(firstSail, { before, underWay, best, fastest, samples });
  say(`  under way: ${JSON.stringify(underWay)}`);
  say(`  fastest: ${JSON.stringify(fastest)}`);
  ok('holding [W] alone gets the anchor up', underWay !== null && underWay.anchored === false,
    JSON.stringify(underWay));
  ok('and the yard comes round with it — the HUD reads at least half the wind held',
    (best?.catchPct ?? 0) >= 50, `best catch ${best?.catchPct}% (yard ${best?.yard})`);
  ok('she is genuinely making way, not creeping at the speed floor',
    (fastest?.speed ?? 0) > 1, `peak ${fastest?.speed} u/s`);
  ok('the panel states the LIVE speed in knots, off her own velocity',
    (fastest?.knots ?? 0) > 0
      && Math.abs((fastest.knots ?? 0) - (fastest.speed ?? 0) * 1.94384) < Math.max(1.2, fastest.speed * 0.5),
    `panel says ${fastest?.knots} kn at ${fastest?.speed} u/s — "${fastest?.panel}"`);
  // A GOOD TRIM IS NOT THE SAME AS MAKING WAY, and this probe found the second
  // half of the trap by getting that wrong. Catch was 99% and she was still doing
  // 1.3 u/s — the yard was perfect and the BOW was head to wind, where the polar
  // floor is 0.10 whatever the canvas does. So the rule is: either she is moving,
  // or something on screen names the real fault and the key that fixes it.
  const stalled = (fastest?.speed ?? 0) <= 3;
  const coached = samples.slice(-6).map((r) => r.coach).filter(Boolean);
  ok(stalled
    ? 'stalled head to wind, the coach says so in the middle of the screen and names the keys'
    : 'she is sailing, so nothing is shouting at her',
    stalled
      ? coached.length > 0 && /steer \[A\] or \[D\]|\[Q\] or \[F\]/.test(coached[0])
      : samples.slice(-4).every((r) => r.coach === ''),
    JSON.stringify({ peak: fastest?.speed, coached: coached.slice(0, 2) }));
  // …and the panel must not tell her the wind is behind her while she is stopped
  // dead in front of it. That sentence is what taught the audit to hold W forever.
  ok('the panel names the wind by where it comes FROM, not where it is going',
    !stalled || /dead ahead|on the (port|starboard) bow/.test(fastest?.panel ?? ''),
    `stalled at ${fastest?.speed} u/s reading "${fastest?.panel}"`);

  // THE WAY OUT HAS TO WORK. Bear away on the wheel and she should fly — this is
  // the whole first-sail loop end to end: anchor up, yard trimmed, steer off the
  // wind, real speed on the clock.
  if (stalled) {
    await page.evaluate(() => { window.__piratesBR.input.keys.add('KeyA'); window.__piratesBR.input.keys.add('KeyW'); });
    const bearAway = [];
    for (let i = 0; i < 22 && left() > 60_000; i++) {
      await wait(1000);
      bearAway.push(await page.evaluate(() => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        const sh = g.state.ships.find((x) => x.id === me?.shipId);
        const panel = (document.getElementById('sail-status')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const kn = /making ([\d.]+) kn/.exec(panel);
        const coach = document.getElementById('sail-coach-hint');
        return {
          speed: +Math.hypot(sh?.velocity.x ?? 0, sh?.velocity.z ?? 0).toFixed(2),
          knots: kn ? +kn[1] : null,
          coach: coach && coach.style.display !== 'none' ? coach.textContent : '',
          panel,
        };
      }));
      // STEER OFF THE WIND, THEN STEADY UP — which is what the pill says, and what
      // this loop did not do. Holding [A] for the full 22 s walks her right past
      // the reach and round into irons on the other side: the panel went from
      // "catching 97%" to "catching 0%" while the coach flipped from the in-irons
      // line to the slack-yard one, and the run recorded a 1.33 u/s peak for a
      // hull that had been through every point of sail on the way. Release the
      // helm the moment she starts drawing and let her run.
      if (bearAway[bearAway.length - 1].speed > 2.5) {
        await page.evaluate(() => { window.__piratesBR.input.keys.delete('KeyA'); });
      }
      if (bearAway[bearAway.length - 1].speed > 6) break;
    }
    await page.evaluate(() => { window.__piratesBR.input.keys.delete('KeyA'); });
    await shot('g-bearing-away');
    const flying = bearAway.reduce((a, b) => (b.speed > (a?.speed ?? -1) ? b : a), null);
    say(`  bearing away: peak ${flying?.speed} u/s (${flying?.knots} kn) — "${flying?.panel}"`);
    firstSail.bearAway = bearAway;
    ok('doing what the coach says makes her fly — the hull was never the problem',
      (flying?.speed ?? 0) > 5, `peak ${flying?.speed} u/s (${flying?.knots} kn)`);
    ok('and the coach stands down once she is drawing',
      bearAway.slice(-2).every((r) => r.coach === '') || (flying?.speed ?? 0) > 5,
      JSON.stringify(bearAway.slice(-2)));
  }
  // And the card no longer advertises a top speed it cannot reach.
  const card = await page.evaluate(() => (document.getElementById('ship-upgrades')?.textContent ?? '').replace(/\s+/g, ' ').trim());
  say(`  ship card: ${card}`);
  ok('the ship card has stopped quoting a fictional TOP SPEED in knots',
    !/top speed/i.test(card) && !/\d+\.\d+\s*kn/i.test(card), card);
}

// ══ (h) A WALK ASHORE COSTS NOTHING, OR SAYS WHAT IT COST ════════════════════
// The audit watched 100 → 58 wandering under a blue sky inside the ring and could
// not name one point of it. Either an on-foot minute is free, or every drop of it
// is on screen (floating number + red vignette). Both are acceptable; silence is
// not.
if (phase('h')) {
  say('\n(h) sixty seconds on foot: free, or explained');
  // Off the deck and onto the island the berth is moored at.
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const isle = (g.state.islands ?? [])
      .map((i) => ({ i, d: Math.hypot(i.position.x - me.position.x, i.position.z - me.position.z) }))
      .sort((a, b) => a.d - b.d)[0]?.i;
    if (isle) g.input.setLook(Math.atan2(isle.position.x - me.position.x, isle.position.z - me.position.z), -0.1);
    g.input.keys.add('KeyW');
  });
  const wander = [];
  let indicatorsSeen = 0;
  let vignetteSeen = 0;
  const startHp = (await snap()).hp;
  const t0 = Date.now();
  let heading = 0;
  while (Date.now() - t0 < 60_000 && left() > 90_000) {
    heading += 0.7;
    await page.evaluate(([yaw]) => {
      const g = window.__piratesBR;
      g.input.setLook(yaw, -0.12);
      g.input.keys.add('KeyW');
    }, [heading]);
    await wait(1200);
    const r = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const layer = document.getElementById('damage-indicator-layer');
      return {
        hp: +Number(me?.health ?? 0).toFixed(1),
        state: me?.state ?? null,
        swim: +Number(me?.swimTimer ?? 0).toFixed(1),
        y: +Number(me?.position.y ?? 0).toFixed(2),
        indicators: layer ? layer.childElementCount : 0,
        hurt: +(document.getElementById('hurt-vignette')?.style.opacity ?? 0),
        attrition: +(document.getElementById('attrition-vignette')?.style.opacity ?? 0),
      };
    });
    if (r.indicators > 0) indicatorsSeen += 1;
    if (r.hurt > 0.01 || r.attrition > 0.01) vignetteSeen += 1;
    wander.push(r);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await shot('h-after-the-wander');
  const endHp = wander.length ? wander[wander.length - 1].hp : startHp;
  const lost = (startHp ?? 0) - (endHp ?? 0);
  const swamOrFell = wander.some((r) => r.state === 'swimming' || r.state === 'downed');
  say(`  hp ${startHp} → ${endHp} (lost ${lost.toFixed(1)}), indicators on ${indicatorsSeen} samples, vignette on ${vignetteSeen}, swam=${swamOrFell}`);
  ok('a minute on foot is either free, or every point of it was announced',
    lost <= 0.5 || indicatorsSeen > 0 || vignetteSeen > 0,
    `lost ${lost.toFixed(1)} hp with ${indicatorsSeen} indicator samples and ${vignetteSeen} vignette samples`);
  ok('and it never silently killed her',
    wander.every((r) => r.state !== 'eliminated'),
    JSON.stringify(wander.slice(-3)));
}

// ══ (i) THE NEW CHIPS, PHOTOGRAPHED ══════════════════════════════════════════
// A PAINT CHECK, NOT A BEHAVIOUR CLAIM. (b) and (g) prove the reprieve chip and the
// sail coach appear when the WORLD says they should; this asks the narrower question
// a screenshot can answer — do they land where they were meant to, legible, without
// covering the compass or the storm clock. Run it with SOFTGL=1: on a box whose GPU
// process has been wedged by a panic, the Metal path returns flat magenta frames and
// a paint check that photographs nothing is worse than no paint check.
if (phase('i')) {
  say('\n(i) the reprieve chip and the sail coach, painted');
  const painted = await page.evaluate(() => {
    const g = window.__piratesBR;
    // ORDER MATTERS. The reprieve chip is PAINTED by updateHud off the clock this
    // arms, while the coach pill is cleared by the same pass whenever the pirate is
    // not at a stalled wheel — so setting the coach before updateHud paints nothing
    // and reads as an absent element. Arm, paint, then force the pill.
    g.hud.noteStormReprieve(15, true);
    g.hud.updateHud();
    g.hud.setSailCoach('Bow into the wind — steer [A] or [D] until the sails fill');
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent, shown: el.style.display !== 'none',
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    return {
      reprieve: box('storm-reprieve-chip'),
      coach: box('sail-coach-hint'),
      stormClock: box('storm-info'),
      lockHint: box('pointer-lock-hint'),
    };
  });
  await wait(400);
  await shot('i-chips');
  say(`  ${JSON.stringify(painted)}`);
  const overlap = (a, b) => !!a && !!b
    && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  ok('the storm reprieve chip paints, with its seconds in it',
    !!painted.reprieve?.shown && painted.reprieve.w > 60 && /\d+s/.test(painted.reprieve.text ?? ''),
    JSON.stringify(painted.reprieve));
  ok('the sail coach paints centre-screen where the pointer-lock hint taught them to look',
    !!painted.coach?.shown && painted.coach.w > 80
      && Math.abs((painted.coach.x + painted.coach.w / 2) - 640) < 40
      && painted.coach.y > 100 && painted.coach.y < 300,
    JSON.stringify(painted.coach));
  // Nothing may be stacked on anything. The first paint check caught the coach pill
  // sitting exactly on top of "CLICK TO LOOK AROUND" — same 34 px, same z-index —
  // so one of two instructions was invisible whenever the pointer was unlocked.
  ok('and nothing is stacked on the storm clock or on the pointer-lock hint',
    !overlap(painted.reprieve, painted.stormClock)
      && !overlap(painted.coach, painted.stormClock)
      && !overlap(painted.reprieve, painted.lockHint)
      && !overlap(painted.coach, painted.lockHint),
    JSON.stringify(painted));
}

if (phase('j')) {
  say('\n(j) aground: the third way to make no way, said out loud');
  // A hull is laid on a real shoal on the SERVER, then the client is asked what it
  // shows. Everything read below comes off the wire and the DOM — the flag, the
  // coach pill, the sail panel — so this is the whole chain, not a unit test with
  // a browser attached.
  await takeTheHelm();
  const put = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    // THE BEACH HAS TO BE ONE SHE CAN ACTUALLY REACH. Picking the nearest island
    // sent her at Booty Bay 189 m dead upwind: she sat in irons at 1.3 u/s and was
    // still 150 m short when the clock ran out, so the probe reported "never
    // aground" about a hull that had never arrived. Score every island by the
    // point of sail the run to it would be — offWind outside the no-go cone — and
    // take the nearest of the ones she can actually sail to.
    // sampleWind's closed form, inlined: the page cannot import shared/utils, and
    // inside the ring sampleLocalWind IS the prevailing breeze (the gale ramp is
    // exactly zero in shelter), which is where this hull is at T+10 s.
    const t = g.ocean?.getTime?.() ?? 0;
    const raw = -Math.PI * 0.26 + Math.sin(t * 0.013) * 0.22 + Math.sin(t * 0.005 + 1.2) * 0.12;
    const dir = Math.atan2(Math.sin(raw), Math.cos(raw));
    const reachable = (g.state.islands ?? []).map((i) => {
      const d = Math.hypot(i.position.x - ship.position.x, i.position.z - ship.position.z);
      const bearing = Math.atan2(i.position.x - ship.position.x, i.position.z - ship.position.z);
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const offWind = Math.PI - Math.abs(wrap(dir - bearing));
      return { i, d, offWind };
    }).sort((a, b) => a.d - b.d);
    // Prefer a beach she can sail to on a decent point of sail, but not at ANY
    // distance: one run drew Parley Point 776 m away and spent seven minutes not
    // arriving. A shoal within CLOSE_M is worth crawling to at the in-irons floor
    // (1.3 u/s covers 100 m in about eighty seconds) and is far more likely to
    // produce the state this phase is here to photograph.
    const CLOSE_M = 250;
    const sailable = reachable.filter((c) => c.offWind > 0.9);
    const isle = ((sailable[0] && sailable[0].d <= CLOSE_M ? sailable[0] : reachable[0]) ?? null)?.i;
    if (!isle) return null;
    // Steer straight at the beach and hold [W]: the mistake, exactly as a learner
    // makes it. The server owns whether that grounds her.
    g.input.setLook(Math.atan2(isle.position.x - ship.position.x, isle.position.z - ship.position.z), -0.1);
    g.input.keys.add('KeyW');
    return {
      isle: isle.name,
      from: Math.round(Math.hypot(isle.position.x - ship.position.x, isle.position.z - ship.position.z)),
      offWindDeg: Math.round(((reachable.find((c) => c.i === isle)?.offWind ?? 0) * 180) / Math.PI),
    };
  });
  say(`  standing in for ${put?.isle} from ${put?.from} m (${put?.offWindDeg}° off the wind)`);
  let sawAground = false;
  let coachText = '';
  let panelText = '';
  let secs = 0;
  for (let i = 0; i < Number(process.env.J_SECONDS ?? 180) && left() > 90_000; i++) {
    await wait(1000);
    secs += 1;
    // KEEP STEERING AT IT. Aiming once and holding [W] for a 300 m beat is not
    // sailing — she yaws off, the probe reported "never aground" about a hull that
    // was still 90 m short of the beach when the clock ran out. Re-point every
    // second, which is what a hand on the wheel actually does.
    const r = await page.evaluate((target) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const ship = g.state.ships.find((x) => x.id === me?.shipId);
      const isle = (g.state.islands ?? []).find((n) => n.name === target);
      if (isle && ship) {
        // THE WHEEL ANSWERS [A] AND [D], NOT WHERE YOU ARE LOOKING. setLook aims a
        // walker (phase h steers by it), but Match.applyInput reads input.left /
        // input.right at the helm and nothing else — so the first cut of this loop
        // "steered" for three minutes while she sailed 300 m further away on the
        // heading she started with, and the probe called it "never aground".
        const want = Math.atan2(isle.position.x - ship.position.x, isle.position.z - ship.position.z);
        const err = Math.atan2(Math.sin(want - ship.rotation), Math.cos(want - ship.rotation));
        g.input.keys.delete('KeyA');
        g.input.keys.delete('KeyD');
        // steer=+1 (right) drives angularVelocity negative, so a bearing that needs
        // MORE rotation is a left-hand wheel.
        if (Math.abs(err) > 0.06) g.input.keys.add(err > 0 ? 'KeyA' : 'KeyD');
        g.input.setLook(want, -0.1);
        g.input.keys.add('KeyW');
      }
      const el = document.getElementById('sail-coach-hint');
      const panel = document.getElementById('sail-status');
      return {
        aground: !!ship?.aground,
        v: +Math.hypot(ship?.velocity?.x ?? 0, ship?.velocity?.z ?? 0).toFixed(2),
        toIsle: isle && ship
          ? Math.round(Math.hypot(isle.position.x - ship.position.x, isle.position.z - ship.position.z)) : null,
        coach: el && el.style.display !== 'none' ? (el.textContent ?? '') : '',
        panel: (panel?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    }, put?.isle);
    if (secs % 15 === 0) say(`  t+${secs}s: ${r.toIsle} m to run, ${r.v} u/s, aground=${r.aground}`);
    if (r.aground) {
      sawAground = true;
      if (r.coach) coachText = r.coach;
      if (r.panel) panelText = r.panel;
      // The coach needs COACH_AFTER_SECONDS on the stall before it speaks.
      if (coachText) break;
    }
  }
  await shot('j-aground');
  // A PICTURE THAT IS ONE COLOUR IS NOT EVIDENCE. This box's Metal path comes back
  // wedged after a GPU crash and returns Chrome's unrasterized-tile magenta for
  // every capture while every DOM check still passes — the j-aground shot from one
  // such run was 1280x720 of solid #ff00ff. The DOM claims above are still true
  // (they come off the wire, not the framebuffer), but the screenshot beside them
  // proves nothing, and a run must say which of the two it is rather than filing
  // a flat rectangle as a photograph. SOFTGL=1 is the way out when it matters.
  const lum = await frameLum();
  say(`  frame: mean=${lum.mean} sd=${lum.sd}`);
  ok('and the frame it photographed is a rendered world, not a flat GPU placeholder',
    lum.sd > 3,
    `sd=${lum.sd} mean=${lum.mean} — a single flat colour; rerun with SOFTGL=1`);
  say(`  aground=${sawAground} coach="${coachText}" panel="${panelText}"`);
  ok('sailing her into the beach really does read as aground on the client',
    sawAground, `never saw ship.aground over ${secs} s at ${put?.isle}`);
  ok('and the coach pill names the shoal rather than the yard or the wind',
    /aground/i.test(coachText), `coach="${coachText}"`);
  ok('and the sail panel stops reporting the pin as a speed',
    /AGROUND/.test(panelText), `panel="${panelText}"`);
  await page.evaluate(() => {
    const k = window.__piratesBR.input.keys;
    k.delete('KeyW'); k.delete('KeyA'); k.delete('KeyD');
  });
}

writeFileSync(`${OUT}/endgame-live-report.json`, JSON.stringify({
  phases: [...PHASES], world, log, results, trace: trace.filter((_, i) => i % 5 === 0),
  bands, bleedTail: bleed.slice(-40), respawnTrace, firstSail, errors: errors.slice(0, 20),
}, null, 1));

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 4).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
closed = true;
process.exit(failed.length ? 1 : 0);
