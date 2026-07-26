// STATION ARBITER PROBE — the live path from "[X] Take Helm is on screen" to
// "the server put me at the helm".
//
// Reproduces (and then verifies the fix for):
//   #1 X-key overload: standing ~1m from the helm, looking at the wheel, [X]
//      braced the yard instead of taking the helm.
//   #2 boarding unreliable: presses at a visible '[X] Climb Ladder' swallowed.
//   #3 swim-boarding dead zone at 0.1–0.7m from the own hull.
//   #4 prompts lie: a stale/out-of-range prompt following the player.
//   #5 anchored helm dead-end: W at the helm with the anchor down.
//
// node scripts/station-arbiter-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/station-arbiter';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

// Other agents editing this tree make vite full-reload the page mid-probe, which
// wipes the match out from under us. Stub out the HMR client so this tab never
// listens for reloads (the modules it already loaded are the ones we test).
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

async function join() {
  await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  // Generous: with several agents' probes running matches on one dev server the
  // 8s start countdown can crawl.
  // (the 2nd arg is the page-function ARG — options are 3rd, or the 30s default
  // silently applies and a busy dev server times the join out)
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await wait(2500);
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
}
await join();

// Concurrent agents editing the tree trigger vite full reloads mid-probe; a
// destroyed execution context is their HMR, not a game bug — rejoin and carry on.
const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, arg) => {
  try {
    return await rawEvaluate(fn, arg);
  } catch (err) {
    if (!/destroyed|navigation|Target closed/i.test(String(err))) throw err;
    console.log('  (page reloaded under the probe — rejoining)');
    await join();
    return await rawEvaluate(fn, arg);
  }
};

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const r2 = (v) => +v.toFixed(2);
  let local = null;
  if (ship) {
    const dx = me.position.x - ship.position.x, dz = me.position.z - ship.position.z;
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    local = { x: r2(dx * cos - dz * sin), z: r2(dx * sin + dz * cos) };
  }
  const promptEl = document.getElementById('interact-prompt');
  return {
    me: {
      x: r2(me.position.x), y: r2(me.position.y), z: r2(me.position.z), state: me.state,
      onShipId: me.onShipId ? 'own' : null, atHelm: !!me.atHelm, atCannon: !!me.atCannon,
      nearShipId: me.nearShipId ? 'own' : null, nearChestId: me.nearChestId ?? null,
    },
    local,
    ship: ship ? {
      x: r2(ship.position.x), z: r2(ship.position.z), rot: r2(ship.rotation), type: ship.type,
      anchored: !!ship.anchored, sailAngleDeg: Math.round((ship.sailAngle * 180) / Math.PI),
      sailHeight: r2(ship.sailHeight), speed: r2(Math.hypot(ship.velocity?.x ?? 0, ship.velocity?.z ?? 0)),
    } : null,
    promptShown: promptEl?.style.display !== 'none',
    prompt: promptEl?.textContent ?? '',
    promptTextRaw: promptEl?.textContent ?? '',
    context: document.getElementById('context-label')?.textContent ?? '',
    kind: g.visibleInteractKind ?? null,
  };
});

/** Every candidate the arbiter considered this frame (accepted ones only). */
const candidates = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const ip = g.interactions;
  const proto = Object.getPrototypeOf(ip);
  const orig = proto.pushInteractionCandidate;
  const seen = [];
  ip.pushInteractionCandidate = function patched(cands, player, point, maxDistance, minDot, prompt, label, kind) {
    const before = cands.length;
    orig.call(this, cands, player, point, maxDistance, minDot, prompt, label, kind);
    const d = Math.hypot(point.x - player.position.x, point.z - player.position.z);
    if (cands.length > before) {
      const c = cands[cands.length - 1];
      seen.push({ kind, dist: +d.toFixed(2), score: +c.score.toFixed(3), prompt: c.prompt, tier: c.tier ?? null });
    } else {
      seen.push({ kind, dist: +d.toFixed(2), score: null, rejected: true });
    }
  };
  const kind = ip.resolveCurrentInteractKind();
  delete ip.pushInteractionCandidate;
  return { winner: kind, seen };
});

async function walkToLocal(lx, lz, maxSteps = 160, stopAt = 0.3, pitch = -0.3) {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(([tx, tz, stop, p]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship) return 999;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + tx * cos + tz * sin;
      const wz = ship.position.z + tz * cos - tx * sin;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      g.input.setLook(Math.atan2(dx, dz), p);
      if (Math.hypot(dx, dz) > stop) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
      return Math.hypot(dx, dz);
    }, [lx, lz, stopAt, pitch]);
    if (d < stopAt) break;
    await wait(90);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(220);
}

/** Look at a ship-local point (aiming the eye at a given local height). */
async function lookAtLocal(lx, lz, worldYOffset = 0.95) {
  await page.evaluate(([tx, tz, yo]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    const stats = { sloop: { h: 1.5 }, brigantine: { h: 1.8 }, galleon: { h: 2.2 } }[ship.type] ?? { h: 1.5 };
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const wx = ship.position.x + tx * cos + tz * sin;
    const wz = ship.position.z + tz * cos - tx * sin;
    const wy = ship.position.y + stats.h + yo;
    const dx = wx - me.position.x, dz = wz - me.position.z;
    const eyeY = me.position.y + 1.8 * 0.72;
    const horiz = Math.hypot(dx, dz);
    g.input.setLook(Math.atan2(dx, dz), Math.atan2(wy - eyeY, horiz));
  }, [lx, lz, worldYOffset]);
  await wait(320);
}

const pressX = async () => {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 60);
  });
  await wait(240);
};

const report = {};

// ── 1. BOARDING: walk at the ship, press [X] whenever a prompt is up ────────
{
  let s = await snap();
  console.log('spawn:', JSON.stringify(s.me));
  const ship = s.ship;
  let presses = 0, promptFrames = 0, deadPresses = 0;
  const t0 = Date.now();
  void ship;
  for (let i = 0; i < 120 && !s.me.onShipId; i++) {
    // Head for the nearest boarding ladder on the own hull, not the hull centre.
    const near = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      const stats = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type];
      const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
      let best = null;
      for (const lx of [stats.w * 0.56, -stats.w * 0.56]) {
        const lz = -stats.l * 0.18;
        const x = sh.position.x + lx * cos + lz * sin;
        const z = sh.position.z + lz * cos - lx * sin;
        const d = Math.hypot(x - me.position.x, z - me.position.z);
        if (!best || d < best.d) best = { x, z, d };
      }
      const yaw = Math.atan2(best.x - me.position.x, best.z - me.position.z);
      g.input.setLook(yaw, best.d < 6 ? -0.1 : 0.02);
      g.input.keys.add('KeyW');
      g.input.jumpPressed = true;
      return { d: +best.d.toFixed(2), state: me.state };
    });
    await wait(200);
    s = await snap();
    if (/Climb|Aboard/.test(s.prompt)) {
      promptFrames += 1;
      presses += 1;
      await pressX();
      const after = await snap();
      if (!after.me.onShipId) deadPresses += 1;
      s = after;
    }
    if (i % 15 === 0) console.log(`  walking… d=${near.d} state=${near.state} prompt="${s.prompt}"`);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  report.boarding = {
    aboard: !!s.me.onShipId, presses, deadPresses,
    seconds: +((Date.now() - t0) / 1000).toFixed(1), promptFrames,
  };
  console.log('BOARDING:', JSON.stringify(report.boarding));
  await shot('1-boarded');
}

const aboard = (await snap()).me.onShipId;
if (!aboard) {
  console.log('!! never boarded — aborting station tests');
} else {
  // ── 2. HELM ARBITER: stand ~1m forward of the wheel and look at it ────────
  const helmZ = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    const L = { sloop: 12, brigantine: 16, galleon: 22 }[ship.type] ?? 12;
    return -L * 0.37;
  });
  await walkToLocal(0, helmZ + 1.0, 200, 0.28);
  await lookAtLocal(0, helmZ, 0.95);
  const before = await snap();
  const cand = await candidates();
  console.log('at helm-1m:', JSON.stringify(before.local), 'prompt:', JSON.stringify(before.prompt), 'kind:', before.kind);
  console.log('candidates:', JSON.stringify(cand, null, 1));
  await shot('2-looking-at-wheel');
  const sailBefore = before.ship.sailAngleDeg;
  // Count presses: a station press must not need a second try either.
  let helmPresses = 0;
  let after = before;
  for (let i = 0; i < 4; i++) {
    helmPresses += 1;
    await pressX();
    await wait(360);
    after = await snap();
    if (after.me.atHelm) break;
    console.log(`  helm press ${helmPresses} did nothing (prompt "${after.prompt}", local ${JSON.stringify(after.local)})`);
  }
  report.helmPresses = helmPresses;
  console.log('after X:', 'atHelm=', after.me.atHelm, 'sailAngleDeg', sailBefore, '->', after.ship.sailAngleDeg, 'prompt:', JSON.stringify(after.prompt));
  await shot('2b-after-x');
  report.helm = {
    promptBefore: before.prompt, kindBefore: before.kind, winner: cand.winner,
    candidates: cand.seen, atHelm: after.me.atHelm,
    sailAngleDelta: after.ship.sailAngleDeg - sailBefore,
  };

  // ── 3. ANCHORED HELM: hold W at the wheel with the anchor down ────────────
  if (after.me.atHelm) {
    const b = await snap();
    await page.evaluate(() => window.__piratesBR.input.keys.add('KeyW'));
    const trace = [];
    for (let i = 0; i < 8; i++) {
      await wait(900);
      const s = await snap();
      trace.push({ t: +((i + 1) * 0.9).toFixed(1), anchored: s.ship.anchored, sail: s.ship.sailHeight, speed: s.ship.speed, ctx: s.context.slice(0, 46) });
    }
    console.log('W-at-helm trace:', JSON.stringify(trace, null, 1));
    const h = await snap();
    await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
    report.anchoredHelm = {
      anchored: h.ship.anchored, sailHeight: h.ship.sailHeight, speed: h.ship.speed,
      context: h.context, prompt: h.prompt,
      feed: await page.evaluate(() => document.getElementById('event-feed')?.textContent?.slice(0, 400) ?? ''),
    };
    console.log('ANCHORED HELM:', JSON.stringify(report.anchoredHelm));
    await shot('3-anchored-helm');
    // Can the helmsman raise the anchor from here?
    await pressX();
    await wait(600);
    const afterHold = await snap();
    report.anchoredHelm.afterXatHelm = { atHelm: afterHold.me.atHelm, anchored: afterHold.ship.anchored };
    void b;
  }
}

// ── 4. STALE PROMPT + swim-boarding dead zone ─────────────────────────────
{
  // Step off the station, walk to the middle of the deck (nothing in reach),
  // look at the sky and read the element: hidden AND blank.
  await page.evaluate(() => { window.__piratesBR.input.interactPressed = true; });
  await wait(500);
  await walkToLocal(0.1, 1.2, 60, 0.4);
  await page.evaluate(() => window.__piratesBR.input.setLook(0, -1.4));
  await wait(600);
  const hidden = await page.evaluate(() => {
    const el = document.getElementById('interact-prompt');
    return { display: el?.style.display, text: el?.textContent ?? '', kind: window.__piratesBR.visibleInteractKind ?? null };
  });
  report.stalePrompt = hidden;
  console.log('prompt element while nothing is offered:', JSON.stringify(hidden));

  // Swim-boarding: hop over the side and read the prompt while hugging the hull.
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    // Look outboard over the BOW quarter (the old dead zone) and run.
    g.input.setLook(ship.rotation, 0.1);
    g.input.keys.add('KeyW');
    g.input.jumpPressed = true;
  });
  await wait(2600);
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(900);
  const inWater = await snap();
  console.log('overboard:', JSON.stringify({ state: inWater.me.state, local: inWater.local, prompt: inWater.prompt }));
  let boardBack = null;
  if (inWater.me.state === 'swimming') {
    await shot('4-swim-at-hull');
    await pressX();
    await wait(900);
    boardBack = await snap();
    console.log('after [X] at the hull:', JSON.stringify({ onShip: boardBack.me.onShipId, state: boardBack.me.state }));
  }
  report.swimBoarding = {
    swamOff: inWater.me.state === 'swimming',
    localAtHull: inWater.local,
    promptInWater: inWater.prompt,
    boardedFromHull: boardBack?.me.onShipId ?? null,
  };
}

console.log('\n=== REPORT ===');
console.log(JSON.stringify(report, null, 1));
console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log('  ERR:', e);
await browser.close();
console.log(`shots in ${OUT}/`);
