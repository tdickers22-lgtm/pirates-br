#!/usr/bin/env node
// SCUTTLE → SPILL → DIVE, end to end, in a real browser against the real server.
//
// scripts/test-gold-cargo.mjs pins the server half against a live Match, and
// scripts/gold-cargo-probe.mjs proves the DRAWING of spilled cargo — but it
// hands the client a hand-written `state.spoils` array and pins it in place.
// Nothing in the estate had ever taken one hull from "laden" to "on the bottom"
// to "the coin is in my purse" without a fixture somewhere in the middle.
//
// THE FIELD-REPAIR TRAP. A berthed hull auto-repairs. Blow holes in her at the
// dock and the planks close faster than she floods, and the run reads as "the
// flooding model is broken" when it is only the crew doing their job. So:
// WEIGH ANCHOR FIRST (hold W at the helm), THEN open her up.
//
//   node scripts/scuttle-spill-dive-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/finalwave/instruments/scuttle';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 }).catch((e) => console.log(`  (shot ${n} skipped: ${e.message.split('\n')[0]})`));
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));

await page.goto('http://127.0.0.1:3000/?debug&forceinput&peace', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await wait(2500);
await page.evaluate(() => { window.__piratesBR.setDayNightOverride(854); window.__piratesBR.setBotPeace(true); });
await page.keyboard.press('KeyL');
await wait(400);

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return {
    gold: me?.gold ?? 0,
    onShipId: me?.onShipId ?? null,
    atHelm: !!me?.atHelm,
    state: me?.state,
    py: +(me?.position.y ?? 0).toFixed(2),
    pos: me ? { x: +me.position.x.toFixed(1), z: +me.position.z.toFixed(1) } : null,
    ship: ship ? {
      anchored: !!ship.anchored, sinking: !!ship.sinking, alive: !!ship.alive,
      cargoGold: ship.cargoGold ?? 0,
      holes: ship.holes.filter((h) => !h.patched).length,
      water: +(ship.waterLevel ?? 0).toFixed(2),
      pos: { x: +ship.position.x.toFixed(1), z: +ship.position.z.toFixed(1) },
      sailHeight: ship.sailHeight,
    } : null,
    spoils: (g.state.spoils ?? []).map((s) => ({ id: s.id, v: s.value, y: +s.position.y.toFixed(1), x: +s.position.x.toFixed(1), z: +s.position.z.toFixed(1) })),
    prompt: document.getElementById('interact-prompt')?.textContent ?? '',
    feed: [...document.querySelectorAll('#kill-feed div')].map((d) => d.textContent),
  };
});

const pressKey = async (code, holdMs = 60) => {
  await page.evaluate(([c, h]) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), h);
  }, [code, holdMs]);
  await wait(holdMs + 200);
};

// ── 0. Laden ────────────────────────────────────────────────────────────────
console.log('\n0. A hold worth diving for');
await page.evaluate(() => window.__piratesBR.grantGold(8600));
await page.waitForFunction(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const sh = g.state.ships.find((s) => s.id === me?.shipId);
  return (sh?.cargoGold ?? 0) > 0;
}, null, { timeout: 20_000 }).catch(() => {});
let s = await snap();
check('the hold is laden before anything is broken', (s.ship?.cargoGold ?? 0) > 3000, `cargo=${s.ship?.cargoGold}`);

// ── 1. Board ────────────────────────────────────────────────────────────────
console.log('\n1. Aboard');
for (let i = 0; i < 140 && !(await snap()).onShipId; i++) {
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
  const now = await snap();
  if (/Climb|Aboard/.test(now.prompt)) await pressKey('KeyX');
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
s = await snap();
check('boarded her own hull', !!s.onShipId, `onShipId=${s.onShipId}`);

// ── 2. WEIGH ANCHOR FIRST ───────────────────────────────────────────────────
// The whole reason this stage exists: an ANCHORED hull runs field repair, and
// a keg blast at the dock closes before the water is ankle deep.
console.log('\n2. Weigh anchor (or the crew simply repairs everything you do)');
const helmZ = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const sh = g.state.ships.find((x) => x.id === me?.shipId);
  return -({ sloop: 12, brigantine: 16, galleon: 22 }[sh.type] ?? 12) * 0.37;
});
const walkToLocal = async (lx, lz, maxSteps = 180, stopAt = 0.3, pitch = -0.3) => {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(([tx, tz, stop, p]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      if (!sh) return 999;
      const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
      const wx = sh.position.x + tx * cos + tz * sin;
      const wz = sh.position.z + tz * cos - tx * sin;
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
};
await walkToLocal(0, helmZ + 1.0, 200, 0.3);
await page.evaluate((tz) => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const sh = g.state.ships.find((x) => x.id === me?.shipId);
  const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
  const wx = sh.position.x + tz * sin;
  const wz = sh.position.z + tz * cos;
  g.input.setLook(Math.atan2(wx - me.position.x, wz - me.position.z), -0.05);
}, helmZ);
await wait(300);
for (let i = 0; i < 5 && !(await snap()).atHelm; i++) await pressKey('KeyX');
s = await snap();
check('took the helm', s.atHelm, `atHelm=${s.atHelm}`);
await shot('01-at-helm-anchored');

// Hold W: at the wheel with the anchor down this is the capstan order.
await page.evaluate(() => window.__piratesBR.input.keys.add('KeyW'));
for (let i = 0; i < 26; i++) {
  await wait(600);
  s = await snap();
  if (s.ship && !s.ship.anchored) break;
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
s = await snap();
check('the anchor is up — field repair no longer shelters her', s.ship && !s.ship.anchored,
  `anchored=${s.ship?.anchored} sail=${s.ship?.sailHeight}`);
await shot('02-anchor-weighed');

// ── 3. Open her up ──────────────────────────────────────────────────────────
console.log('\n3. Powder kegs amidships');
await pressKey('KeyX'); // step off the wheel
await wait(400);
await walkToLocal(0, 0, 120, 0.5);
let blasts = 0;
for (let keg = 0; keg < 3; keg++) {
  const before = (await snap()).ship?.holes ?? 0;
  // G down / G up = pick up and place.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true }));
  });
  await wait(500);
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG', bubbles: true }));
  });
  await wait(700);
  // Back off along the deck and shoot it.
  await walkToLocal(0, 3.4, 60, 0.4);
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sh = g.state.ships.find((x) => x.id === me?.shipId);
    const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
    const wx = sh.position.x, wz = sh.position.z;
    g.input.setLook(Math.atan2(wx - me.position.x, wz - me.position.z), -0.22);
    void cos; void sin;
  });
  await wait(350);
  for (let f = 0; f < 6; f++) {
    await page.evaluate(() => { window.__piratesBR.input.firePressed = true; window.__piratesBR.input.fireHeld = true; });
    await wait(260);
    await page.evaluate(() => { window.__piratesBR.input.fireHeld = false; });
    await wait(200);
  }
  await wait(1200);
  const after = await snap();
  if ((after.ship?.holes ?? 0) > before) blasts++;
  console.log(`   keg ${keg + 1}: holes ${before} → ${after.ship?.holes}  water=${after.ship?.water}`);
  if ((after.ship?.holes ?? 0) >= 5 || after.ship?.sinking) break;
}
s = await snap();
check('the hull is genuinely breached with the anchor up', (s.ship?.holes ?? 0) > 0,
  `holes=${s.ship?.holes} blasts=${blasts}`);
await shot('03-breached');

// ── 4. She founders and spills ──────────────────────────────────────────────
console.log('\n4. Foundering, and the hold goes into the water');
let sawSinking = false;
for (let i = 0; i < 100; i++) {
  await wait(1000);
  s = await snap();
  if (s.ship?.sinking) sawSinking = true;
  if (s.spoils.length > 0) break;
  if (i % 10 === 0) console.log(`   t+${i}s water=${s.ship?.water} holes=${s.ship?.holes} sinking=${s.ship?.sinking} spoils=${s.spoils.length}`);
}
check('she founders', sawSinking || s.spoils.length > 0, `sinking=${s.ship?.sinking}`);
check('the hold spills divable cargo onto the seabed', s.spoils.length > 0,
  `${s.spoils.length} piece(s), ${s.spoils.reduce((a, p) => a + p.v, 0)}g`);
console.log(`   spoils: ${JSON.stringify(s.spoils)}`);

// THE AMBER SEABED GLOW, photographed where it lies.
if (s.spoils.length > 0) {
  const p0 = s.spoils[0];
  await page.evaluate(([x, y, z]) => {
    window.__piratesBR.enableFreeCam(x + 5.5, y + 3.0, z + 5.5, Math.atan2(-5.5, -5.5), -0.34);
  }, [p0.x, p0.y, p0.z]);
  await wait(1800);
  await shot('04-seabed-glow');
  await page.evaluate(() => window.__piratesBR.disableFreeCam());
  await wait(600);
}

// ── 5. Dive and bank it ─────────────────────────────────────────────────────
console.log('\n5. Swim down and take it');
const goldBefore = (await snap()).gold;
const spoilsToDiveFor = (await snap()).spoils.length;
let claimed = false;
for (let i = 0; i < 120 && spoilsToDiveFor > 0; i++) {
  const st = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sp = (g.state.spoils ?? [])[0];
    if (!me || !sp) return { done: true };
    const dx = sp.position.x - me.position.x;
    const dz = sp.position.z - me.position.z;
    const dy = sp.position.y - me.position.y;
    const horiz = Math.hypot(dx, dz);
    // The swim legend on screen is the spec: "W FOLLOWS LOOK · SPACE UP · Z DOWN".
    // Holding SPACE to dive does the exact opposite — it swims for the surface,
    // and a probe that does it reads as "the swimmer is stuck" while the engine
    // is faithfully obeying it.
    g.input.setLook(Math.atan2(dx, dz), Math.atan2(dy, Math.max(0.4, horiz)));
    g.input.keys.add('KeyW');
    g.input.keys.delete('Space');
    if (dy < -0.4) g.input.keys.add('KeyZ'); else g.input.keys.delete('KeyZ');
    return {
      done: false, horiz: +horiz.toFixed(2), dy: +dy.toFixed(2), state: me.state,
      py: +me.position.y.toFixed(2), hp: Math.round(me.health ?? 0),
    };
  });
  if (st.done) { claimed = true; break; }
  await wait(220);
  if (i % 15 === 0) console.log(`   swimming… horiz=${st.horiz} dy=${st.dy} state=${st.state} y=${st.py}`);
  const now = await snap();
  if (now.spoils.length === 0 || now.gold > goldBefore) { claimed = true; break; }
}
await page.evaluate(() => {
  const k = window.__piratesBR.input.keys;
  k.delete('KeyW'); k.delete('Space'); k.delete('KeyZ');
});
await wait(900);
s = await snap();
// NOT `|| claimed` alone, and never vacuous: with nothing in the water this
// stage has proved nothing, and a green tick there would be the instrument
// lying. No spill ⇒ the failure belongs to stage 4, said here too.
check('a swimmer who gets down to it banks the coin',
  spoilsToDiveFor > 0 && (s.gold > goldBefore || (claimed && s.spoils.length < spoilsToDiveFor)),
  spoilsToDiveFor === 0
    ? 'nothing spilled — nothing to dive for (see stage 4)'
    : `gold ${goldBefore} → ${s.gold}, spoils ${spoilsToDiveFor} → ${s.spoils.length}`);
console.log(`   feed: ${JSON.stringify(s.feed.slice(0, 6))}`);
await shot('05-claimed');

console.log(`\nconsole errors: ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 5).join('\n'));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed.`);
if (failed.length) console.log(failed.map((f) => `  ✗ ${f.label} ${f.detail}`).join('\n'));
console.log(`shots: ${OUT}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
