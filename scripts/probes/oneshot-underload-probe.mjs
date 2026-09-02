// PROBE, not a gate: ONE-SHOT UNDER LOAD — the live half of "presses 1-3 at the wheel were dead".
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// ONE-SHOT UNDER LOAD — the live half of "presses 1-3 at the wheel were dead".
//
// Starves the dev server with extra headless crews, then hammers [X] at the helm
// and counts how many presses actually flipped the station. Also proves a
// genuinely refused [X] now answers back (amber feed line + thud) instead of
// giving silent nothing.
//
// node scripts/oneshot-underload-probe.mjs [outDir] [loadClients]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/oneshot-underload';
const LOAD_CLIENTS = Number(process.argv[3] ?? 3);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const viteStub = (page) => page.route('**/@vite/client*', (route) => route.fulfill({
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

async function joinPage(page) {
  await viteStub(page);
  await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { state: 'attached', timeout: 90_000 });
  await page.waitForFunction(() => {
    const b = document.getElementById('menu-solo-btn');
    return !!b && b.offsetParent !== null;
  }, null, { timeout: 120_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  return page;
}

// ── Load: extra crews, each its own 9-bot match, all on one node process ────
const loaders = [];
for (let i = 0; i < LOAD_CLIENTS; i += 1) {
  const p = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await joinPage(p);
  loaders.push(p);
  console.log(`load client ${i + 1}/${LOAD_CLIENTS} sailing`);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
await joinPage(page);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 90_000 });
const wait = (ms) => page.waitForTimeout(ms);

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const r2 = (v) => +v.toFixed(2);
  let local = null;
  if (ship && me) {
    const dx = me.position.x - ship.position.x, dz = me.position.z - ship.position.z;
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    local = { x: r2(dx * cos - dz * sin), z: r2(dx * sin + dz * cos) };
  }
  const el = document.getElementById('interact-prompt');
  return {
    state: me?.state, onShip: !!me?.onShipId, atHelm: !!me?.atHelm, local,
    prompt: el?.style.display === 'none' ? '' : (el?.textContent ?? ''),
    feed: document.getElementById('kill-feed')?.textContent?.slice(0, 260) ?? '',
  };
});

const pressX = async () => {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 70);
  });
};

async function walkToLocal(lx, lz, maxSteps = 200, stopAt = 0.3, pitch = -0.25) {
  for (let i = 0; i < maxSteps; i += 1) {
    const d = await page.evaluate(([tx, tz, stop, p]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship || !me) return 999;
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
  await wait(200);
}

const report = { loadClients: LOAD_CLIENTS };

// ── Get aboard ─────────────────────────────────────────────────────────────
{
  let s = await snap();
  for (let i = 0; i < 140 && !s.onShip; i += 1) {
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      if (!sh || !me) return;
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
      g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), best.d < 6 ? -0.1 : 0.02);
      g.input.keys.add('KeyW');
      g.input.jumpPressed = true;
    });
    await wait(200);
    s = await snap();
    if (/Climb|Aboard/.test(s.prompt)) { await pressX(); await wait(300); s = await snap(); }
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  report.aboard = s.onShip;
  console.log('aboard:', s.onShip, JSON.stringify(s.local));
}

// ── THE PRESS COUNT: every [X] at the wheel must flip the station ───────────
if (report.aboard) {
  const helmZ = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    return -({ sloop: 12, brigantine: 16, galleon: 22 }[ship.type] ?? 12) * 0.37;
  });
  await walkToLocal(0, helmZ + 0.9, 220, 0.3);
  await page.evaluate(([hz]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const wx = ship.position.x + 0 * cos + hz * sin;
    const wz = ship.position.z + hz * cos - 0 * sin;
    g.input.setLook(Math.atan2(wx - me.position.x, wz - me.position.z), -0.12);
  }, [helmZ]);
  await wait(500);
  // Count what the CLIENT actually puts on the wire: a press the client never
  // sent is a client-side loss, not the server intake bug this probe is about.
  await page.evaluate(() => {
    const g = window.__piratesBR;
    window.__sentInteract = 0;
    const real = g.network.sendInput.bind(g.network);
    g.network.sendInput = (input) => { if (input.interact) window.__sentInteract += 1; return real(input); };
  });
  const before = await snap();
  console.log('at the wheel:', JSON.stringify(before.local), 'prompt:', JSON.stringify(before.prompt));
  await shot('1-at-the-wheel');

  const PRESSES = 16;
  let expected = before.atHelm;
  let flips = 0;
  let dead = 0;
  let refusedPresses = 0;
  const trace = [];
  /** Point the eye back at the wheel. Leaving the helm faces her down the deck,
   *  and a frame with no prompt sends no intent — that is AIM, not delivery, and
   *  it would masquerade as a lost press. */
  const aimAtWheel = async () => {
    await page.evaluate(([hz]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship || !me) return;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + hz * sin;
      const wz = ship.position.z + hz * cos;
      g.input.setLook(Math.atan2(wx - me.position.x, wz - me.position.z), -0.12);
    }, [helmZ]);
    await wait(260);
  };
  for (let i = 0; i < PRESSES; i += 1) {
    expected = !expected;
    // Re-anchor at the wheel before a "take": the deck moves under her, and a
    // press from 3 m aft with no prompt is out-of-range, not a lost press.
    if (!expected) await wait(120);
    else { await walkToLocal(0, helmZ + 0.8, 40, 0.35); await aimAtWheel(); }
    await pressX();
    // Poll for the flip rather than sleeping a fixed slice: under dilation the
    // round trip stretches, and we are measuring DELIVERY, not latency.
    const feedBefore = (await snap()).feed;
    let got = null;
    for (let w = 0; w < 24; w += 1) {
      await wait(120);
      got = await snap();
      if (got.atHelm === expected) break;
    }
    if (got.atHelm === expected) flips += 1; else dead += 1;
    // A press the server REFUSED is not a lost press — it now says so.
    const refused = got.atHelm !== expected && got.feed !== feedBefore;
    if (refused) refusedPresses += 1;
    trace.push({ press: i + 1, want: expected, got: got.atHelm, refused, prompt: got.prompt.slice(0, 34) });
    // The server's interact throttle is 0.2 SIM seconds; under dilation that is
    // far longer in wall time, so leave real room between presses.
    await wait(900);
  }
  report.helm = { presses: PRESSES, sentByClient: await page.evaluate(() => window.__sentInteract), flips, dead, refusedPresses, silentlyLost: dead - refusedPresses, trace };
  console.log(`HELM: client sent ${report.helm.sentByClient} interact packets; ${flips}/${PRESSES} presses landed, ${dead} did not flip (${refusedPresses} answered as refusals, ${dead - refusedPresses} silent)`);
  for (const t of trace) if (t.want !== t.got) console.log('   DEAD:', JSON.stringify(t));
  await shot('2-after-press-storm');
}

// ── PURE DELIVERY: presses buried in the 45 Hz stream ──────────────────────
// Ammo selection is a one-shot with no rate limit and a visible result, so a
// crafted press that survives being overwritten flips `selectedCannonAmmo` and
// a lost one does not — 100 % delivery, with none of the aim/range noise of
// driving a character around a moving deck.
{
  const BURIED = 14;
  let landed = 0;
  const misses = [];
  for (let i = 0; i < BURIED; i += 1) {
    const want = i % 2 === 0 ? 'firebomb' : 'chainshot';
    await page.evaluate(([ammo, n]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      g.network.sendInput({
        seq: 700000 + n * 37, ts: Date.now(),
        forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
        fire: false, useItem: false, crouch: false, aim: false,
        interact: false, interactHeld: false, interactIntent: null,
        anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
        trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
        slot: null, cannonAmmo: ammo, yaw: me?.rotation?.x ?? 0, pitch: 0,
        wheelIndex: null, useWheelItem: false, barrelTakeAll: false, selectMap: null,
      });
    }, [want, i]);
    let got = null;
    for (let w = 0; w < 20; w += 1) {
      await wait(140);
      got = await page.evaluate(() => {
        const g = window.__piratesBR;
        return g.state.players.find((p) => p.id === g.localPlayerId)?.selectedCannonAmmo ?? null;
      });
      if (got === want) break;
    }
    if (got === want) landed += 1; else misses.push({ press: i + 1, want, got });
    await wait(200);
  }
  report.buriedPresses = { sent: BURIED, landed, misses };
  console.log(`BURIED PRESSES: ${landed}/${BURIED} landed${misses.length ? ` — misses ${JSON.stringify(misses)}` : ''}`);
}

// ── A refused [X] answers back ─────────────────────────────────────────────
{
  // Ask for a station that is nowhere near her — exactly what a stale prompt or
  // a swell-shifted deck produces in play, minus the timing luck.
  const feedBefore = (await snap()).feed;
  const sentSeq = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const seq = 900000 + Math.floor(Math.random() * 1000);
    g.network.sendInput({
      seq, ts: Date.now(),
      forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
      fire: false, useItem: false, crouch: false, aim: false,
      interact: true, interactHeld: false, interactIntent: 'ammo',
      anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
      trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
      slot: null, cannonAmmo: null, yaw: me?.rotation?.x ?? 0, pitch: 0,
      wheelIndex: null, useWheelItem: false, barrelTakeAll: false, selectMap: null,
    });
    return seq;
  });
  // The crafted press is one packet in a 45 Hz stream — it is instantly
  // overwritten. Surviving that IS the fix.
  await wait(2500);
  const after = await snap();
  const fresh = after.feed.replace(feedBefore, '');
  report.refusal = {
    craftedSeq: sentSeq,
    feedDelta: fresh.slice(0, 220),
    sawRefusal: /ammo chest|Too far|Nothing to do|Get aboard|out of reach/i.test(fresh),
  };
  console.log('REFUSAL:', JSON.stringify(report.refusal));
  await shot('3-refused-press');
}

console.log('\n=== REPORT ===');
console.log(JSON.stringify(report, null, 1));
console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 6)) console.log('  ERR:', e);
await browser.close();
console.log(`shots in ${OUT}/`);
