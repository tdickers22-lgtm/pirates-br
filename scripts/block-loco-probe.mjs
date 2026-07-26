#!/usr/bin/env node
// LIVE PROBE: is a held cutlass guard steady, and does on-foot walking stick?
//
// Two audit findings that only a real client can settle:
//   • BLOCK — hold RMB with the cutlass out and sample player.blocking every
//     frame. Reports WHICH condition was false on any frame the guard was down
//     (aim bit, swing recovery, swim state, hands full, station).
//   • LOCOMOTION — walk a fixed heading across the dock and the deck and report
//     the effective ground speed and the vertical wander (auditors reported
//     0.8 m/s against MOVE_SPEED and y oscillating while climbing invisible
//     clutter).
//
//   node scripts/block-loco-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/block-loco';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('#menu-solo-btn', { timeout: 90000, state: 'visible' });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 90000 });
await wait(3500);

// Sampler installed in page context: keeps a rolling log of the local player's
// guard/locomotion truth straight off the authoritative snapshot.
await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = () => {
    const st = g.state;
    const id = g.playerId ?? g.myId ?? g.localPlayerId ?? g.net?.playerId;
    return st.players?.find((p) => p.id === id) ?? null;
  };
  window.__probe = {
    id: g.playerId ?? g.myId ?? g.localPlayerId ?? g.net?.playerId ?? null,
    samples: [],
    timer: null,
    start() {
      this.samples = [];
      this.timer = setInterval(() => {
        const p = me();
        if (!p) return;
        const w = p.weapons?.[p.activeSlot];
        this.samples.push({
          t: performance.now() / 1000,
          x: p.position.x, y: p.position.y, z: p.position.z,
          state: p.state,
          blocking: !!p.blocking,
          slot: p.activeSlot,
          weapon: w?.weaponId ?? null,
          reloading: !!w?.reloading,
          hands: !!p.carryingChestId,
          station: !!(p.atCannon || p.atHelm || p.atCrowNest) || p.mastClimb !== null,
          onShip: p.onShipId ?? null,
          health: p.health,
          aimBit: !!(g.input?.mouseButtons?.has?.(2)),
        });
      }, 16);
    },
    stop() { clearInterval(this.timer); return this.samples; },
  };
  return window.__probe.id;
});

const look = (yaw, pitch = -0.02) => page.evaluate(([y, p]) => window.__piratesBR?.input?.setLook(y, p), [yaw, pitch]);

// ── BLOCK: cutlass out, RMB held for 5 s, nothing else touched ──
const cutlassSlot = await page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.state.players.find((q) => q.id === window.__probe.id);
  return p?.weapons?.findIndex((w) => w?.weaponId === 'cutlass') ?? -1;
});
console.log('cutlass slot =', cutlassSlot);
for (let i = 0; i < 6; i += 1) {
  await page.keyboard.press(String(cutlassSlot + 1));
  await wait(250);
  const held = await page.evaluate(() => {
    const g = window.__piratesBR;
    const p = g.state.players.find((q) => q.id === window.__probe.id);
    return p?.weapons?.[p.activeSlot]?.weaponId ?? null;
  });
  if (held === 'cutlass') break;
}
await wait(400);
await look(0.6);
await page.evaluate(() => window.__probe.start());
await page.evaluate(() => window.__piratesBR.input.mouseButtons.add(2));
await wait(5000);
await page.screenshot({ path: `${OUT}/block-held.png`, timeout: 60000 });
const blockSamples = await page.evaluate(() => window.__probe.stop());
await page.evaluate(() => window.__piratesBR.input.mouseButtons.delete(2));

// Health readout: a starved or time-dilated client invalidates every number
// below, so print it before the findings rather than after.
const health = async (tag) => {
  const h = await page.evaluate(() => ({
    debug: document.body.innerText.match(/fps [^\n]*/)?.[0] ?? null,
    snapshot: document.body.innerText.match(/snapshot [^\n|]*/)?.[0] ?? null,
    overloaded: /SERVER OVERLOADED|Lost connection/i.test(document.body.innerText),
  }));
  console.log(`HEALTH ${tag}: ${h.debug} | ${h.snapshot} | overloaded=${h.overloaded}`);
  return h;
};
await health('after block hold');

const down = blockSamples.filter((s) => !s.blocking);
const downIdx = blockSamples.map((s, i) => (s.blocking ? -1 : i)).filter((i) => i >= 0);
console.log(`BLOCK: ${blockSamples.length} samples over ~5s, guard down on ${down.length}`);
if (downIdx.length) {
  console.log(`BLOCK down sample indices: ${downIdx.slice(0, 40).join(',')}${downIdx.length > 40 ? '…' : ''}`);
  console.log(`BLOCK all drops inside the first 0.5s of the hold? ${downIdx[downIdx.length - 1] < 32}`);
}
if (down.length) {
  const why = {};
  for (const s of down) {
    const reasons = [];
    if (!s.aimBit) reasons.push('aim-bit-clear');
    if (s.reloading) reasons.push('weapon-reloading');
    if (s.state === 'swimming') reasons.push('swimming');
    if (s.hands) reasons.push('hands-full');
    if (s.station) reasons.push('at-station');
    if (s.weapon !== 'cutlass') reasons.push(`weapon=${s.weapon}`);
    const key = reasons.length ? reasons.join('+') : 'NO-VISIBLE-REASON';
    why[key] = (why[key] ?? 0) + 1;
  }
  console.log('BLOCK down reasons:', JSON.stringify(why));
  console.log('BLOCK first down sample:', JSON.stringify(down[0]));
}

// ── LOCOMOTION: walk one heading on the dock, then across the deck ──
async function walk(label, yaw, ms) {
  await look(yaw);
  await wait(250);
  await page.evaluate(() => window.__probe.start());
  await page.keyboard.down('KeyW');
  await wait(ms);
  await page.keyboard.up('KeyW');
  const s = await page.evaluate(() => window.__probe.stop());
  if (s.length < 4) { console.log(`LOCO ${label}: no samples`); return null; }
  const a = s[0]; const b = s[s.length - 1];
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const dur = b.t - a.t;
  let stalls = 0;
  let yMin = Infinity; let yMax = -Infinity;
  for (let i = 1; i < s.length; i += 1) {
    const dt = s[i].t - s[i - 1].t;
    const step = Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z);
    if (dt > 0.004 && step / dt < 0.5) stalls += 1;
    yMin = Math.min(yMin, s[i].y); yMax = Math.max(yMax, s[i].y);
  }
  console.log(`LOCO ${label}: ${dist.toFixed(2)}m in ${dur.toFixed(2)}s = ${(dist / dur).toFixed(2)} m/s | stall frames ${stalls}/${s.length} | y ${yMin.toFixed(2)}..${yMax.toFixed(2)} | onShip=${b.onShip ?? 'none'} state=${b.state}`);
  return { label, speed: dist / dur, stalls, frames: s.length, yMin, yMax };
}

const legs = [];
for (const yaw of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
  legs.push(await walk(`island yaw=${yaw.toFixed(2)}`, yaw, 2200));
  await health(`after island yaw=${yaw.toFixed(2)}`);
  await wait(300);
}
await page.screenshot({ path: `${OUT}/loco-island.png`, timeout: 60000 });

// ── Walk to my own ship and board her, then walk the deck past the mast ──
const target = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const id = window.__probe.id;
  const me = g.state.players.find((p) => p.id === id);
  const ship = g.state.ships.find((s) => s.id === (me?.shipId ?? me?.onShipId));
  if (!me || !ship) return null;
  return {
    me: { ...me.position }, onShip: me.onShipId ?? null, state: me.state,
    ship: { ...ship.position }, rot: ship.rotation,
    dist: Math.hypot(ship.position.x - me.position.x, ship.position.z - me.position.z),
  };
});

let ctx = await target();
console.log('BOARD start:', JSON.stringify(ctx));
// Crude autopilot: re-aim at the hull every 400 ms and hold W (plus a hop, which
// is how you mount the boarding ladder).
for (let i = 0; i < 60 && ctx && !ctx.onShip; i += 1) {
  await look(Math.atan2(ctx.ship.x - ctx.me.x, ctx.ship.z - ctx.me.z));
  await page.keyboard.down('KeyW');
  if (ctx.dist < 14) { await page.keyboard.press('Space'); }
  await wait(400);
  ctx = await target();
}
await page.keyboard.up('KeyW');
console.log('BOARD end:', JSON.stringify(ctx));
await page.screenshot({ path: `${OUT}/board.png`, timeout: 60000 });

if (ctx?.onShip) {
  // Deck walk: fore-aft along the centreline (straight past the mast) and
  // athwartships (across the deck clutter).
  for (const [label, yaw] of [
    ['deck fore', ctx.rot],
    ['deck aft', ctx.rot + Math.PI],
    ['deck starboard', ctx.rot + Math.PI * 0.5],
    ['deck port', ctx.rot - Math.PI * 0.5],
  ]) {
    legs.push(await walk(label, yaw, 1500));
    await wait(300);
  }
  await page.screenshot({ path: `${OUT}/loco-deck.png`, timeout: 60000 });
}

const worst = legs.filter(Boolean).sort((a, b) => a.speed - b.speed)[0];
console.log('SLOWEST leg:', JSON.stringify(worst));

await browser.close();
console.log('probe done ->', OUT);
