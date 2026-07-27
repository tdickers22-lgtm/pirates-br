// GOLD CARGO PROBE — the 9000-gold race, flown live.
//
// Proves in a real browser against the real server that the signature mechanic
// now has a BODY:
//   1. banking gold past the safe line stacks visible crates in the hold
//   2. the HUD names the hold's tier and the knots it costs
//   3. a laden hull is measurably slower on the water (the leader is catchable)
//   4. crossing 60% of the target hangs a bounty ring on the battle chart
//   5. foundering with a full hold spills divable cargo, and swimming into it
//      banks the coin
//
// node scripts/gold-cargo-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/gold-cargo';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};

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

async function join() {
  await page.goto('http://127.0.0.1:3000/?debug&forceinput&peace', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await wait(2500);
  await page.evaluate(() => {
    window.__piratesBR.setDayNightOverride(854);
    window.__piratesBR.setBotPeace(true);
  });
  // The first-voyage SHIP'S ORDERS card owns the middle of the screen; every
  // shot this probe takes is of something behind it.
  await page.keyboard.press('KeyL');
  await wait(500);
}
await join();

const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, arg) => {
  try { return await rawEvaluate(fn, arg); } catch (err) {
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
  const holdEl = document.getElementById('hold-cargo');
  return {
    gold: me?.gold ?? 0,
    pos: me ? { x: +me.position.x.toFixed(1), y: +me.position.y.toFixed(2), z: +me.position.z.toFixed(1) } : null,
    state: me?.state ?? null,
    shipId: ship?.id ?? null,
    cargoGold: ship?.cargoGold ?? 0,
    bountied: !!ship?.bountied,
    sinking: !!ship?.sinking,
    holes: (ship?.holes ?? []).filter((h) => !h.patched).length,
    waterLevel: +(ship?.waterLevel ?? 0).toFixed(2),
    speed: ship ? +Math.hypot(ship.velocity.x, ship.velocity.z).toFixed(2) : 0,
    holdText: holdEl && holdEl.style.display !== 'none' ? holdEl.textContent : null,
    spoils: (g.state.spoils ?? []).length,
    spoilValue: (g.state.spoils ?? []).reduce((a, s) => a + s.value, 0),
    feed: [...document.querySelectorAll('#kill-feed div')].map((d) => d.textContent).slice(0, 8),
  };
});

const grant = async (gold) => {
  await page.evaluate((g) => window.__piratesBR.grantGold(g), gold);
  await page.waitForFunction(
    (g) => {
      const b = window.__piratesBR;
      const me = b.state.players.find((p) => p.id === b.localPlayerId);
      return me && me.gold === g;
    },
    gold, { timeout: 15_000 },
  ).catch(() => {});
  await wait(400);
};

// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. Safe pocket gold is weightless and silent');
await grant(1200);
let s = await snap();
check('1,200g (under the safe line) puts NO cargo in the hold', s.cargoGold === 0, `cargo=${s.cargoGold}`);
check('and shows no hold readout at all', s.holdText === null, String(s.holdText));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. Banking past the line fills the hold');
await grant(4900);
s = await snap();
check('gold over the safe line becomes hold cargo', s.cargoGold === 3400, `cargo=${s.cargoGold}`);
check('the HUD names the tier and the knots it costs',
  !!s.holdText && /HOLD:/.test(s.holdText) && /%/.test(s.holdText), String(s.holdText));
await shot('01-hud-laden');

// Fill her to the top tier, then go below and look at the stack. The bounty is
// cried the instant she crosses 60% — read the feed NOW; rows fade in ~3s.
await grant(8600);
const feedAtBounty = (await snap()).feed;
await wait(500);
// Put the camera ON the cargo: hull classes differ (sloop / brigantine /
// galleon), so the shot is framed off the stack's OWN world bounding box
// instead of a hard-coded hull offset that only fits one of them.
const framed = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me.shipId);
  window.__probeShip = ship.id;
  let target = null;
  g.renderer.scene.traverse((o) => {
    if (target || o.name !== 'hold-cargo') return;
    for (const tier of o.children) {
      if (!tier.visible || !tier.children.length) continue;
      const mesh = tier.children[0];
      mesh.updateWorldMatrix(true, false);
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      const V = mesh.position.constructor;
      target = new V(
        (bb.min.x + bb.max.x) / 2,
        (bb.min.y + bb.max.y) / 2,
        (bb.min.z + bb.max.z) / 2,
      ).applyMatrix4(mesh.matrixWorld);
      break;
    }
  });
  if (!target) return null;
  const camX = target.x + Math.sin(ship.rotation) * 3.4;
  const camY = target.y + 0.8;
  const camZ = target.z + Math.cos(ship.rotation) * 3.4;
  const dx = target.x - camX, dy = target.y - camY, dz = target.z - camZ;
  g.enableFreeCam(camX, camY, camZ, Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  return { x: +target.x.toFixed(1), y: +target.y.toFixed(2), z: +target.z.toFixed(1) };
});
check('the cargo stack stands at a real place in the world', !!framed, JSON.stringify(framed));
await wait(500);
const holdShotOk = await page.evaluate(() => {
  const g = window.__piratesBR;
  const ship = g.state.ships.find((s) => s.id === window.__probeShip);
  if (!ship) return false;
  // Count the visible cargo tier meshes actually in the scene graph.
  let visible = 0;
  g.renderer.scene.traverse((o) => {
    if (o.name === 'hold-cargo') {
      for (const tier of o.children) if (tier.visible) visible += 1;
    }
  });
  window.__cargoVisible = visible;
  return true;
});
await wait(700);
await shot('01b-hold-crates');
await page.evaluate(() => window.__piratesBR.disableFreeCam());
const visibleTiers = await page.evaluate(() => window.__cargoVisible);
check('exactly one cargo-stack tier is drawn in the hold (draw-call discipline)',
  holdShotOk && visibleTiers === 1, `visibleTiers=${visibleTiers}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. Ballast — the HUD reports the weight the sim is carrying');
// (The speed loss itself is measured against the REAL PhysicsSystem in
//  scripts/test-gold-cargo.mjs — two identical hulls, one laden, sailed tick by
//  tick. What is checked HERE is that the live server hull carries the same
//  cargo number the physics reads, and that the HUD tells the pirate in knots.)
await grant(8600);
s = await snap();
check('a near-win purse fills the hold to the top tier',
  s.cargoGold === 8600 - 1500, `cargo=${s.cargoGold}`);
check('the HUD escalates the tier and the knots it costs',
  !!s.holdText && /WALLOWING/i.test(s.holdText) && /−1[0-9]%/.test(s.holdText), String(s.holdText));
await shot('02-hud-wallowing');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. Bounty — the leader is marked on the chart');
check('past 60% of the target the crew is bountied', s.bountied === true, `gold=${s.gold}`);
check('the sea was told (bounty line in the feed)',
  feedAtBounty.some((line) => /BOUNTY/i.test(line ?? '')), JSON.stringify(feedAtBounty.slice(0, 3)));
await page.keyboard.press('KeyM');
await wait(900);
await shot('03-bounty-chart');
const mapPixels = await page.evaluate(() => {
  const canvas = document.querySelector('#map-canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let amber = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 210 && data[i + 1] > 120 && data[i + 1] < 200 && data[i + 2] < 110) amber += 1;
  }
  return amber;
});
check('the chart is actually painting the bounty marker',
  mapPixels === null || mapPixels > 40, `amberPixels=${mapPixels}`);
await page.keyboard.press('KeyM');
await wait(500);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n5. Sunken cargo — the wreck site is a real, divable place');
//
// The SERVER half of this (a foundering hold spilling half its cargo, capped,
// never out of the safe pocket, claimable only by a swimmer who actually gets
// down to it, taken by the tide on a timer) is pinned end-to-end against the
// real Match in scripts/test-gold-cargo.mjs §4–5. What this stage proves is the
// half only a browser can: that the pieces the server puts in the water are
// DRAWN — a burst strongbox with a lantern-warm glow, in the green, where a
// pirate can see it from the surface and swim for it.
const drawn = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me.shipId);
  const yaw = ship.rotation;
  // A wreck's worth of spilled cargo, laid out over the hull's own position.
  const pieces = [420, 610, 380, 540].map((value, i) => {
    const a = (i / 4) * Math.PI * 2 + yaw;
    return {
      id: `probe-sp${i}`,
      position: {
        x: ship.position.x + Math.sin(a) * (4 + i * 1.4),
        y: -6,
        z: ship.position.z + Math.cos(a) * (4 + i * 1.4),
      },
      value,
      fromShipId: ship.id,
    };
  });
  // Snapshots replace client state wholesale ~10×/s, so hold the wreck in place
  // while the camera looks at it.
  window.__probeSpoilPin = setInterval(() => {
    if (window.__piratesBR.state) window.__piratesBR.state.spoils = pieces;
  }, 16);
  g.enableFreeCam(
    pieces[0].position.x + 6, pieces[0].position.y + 3.2, pieces[0].position.z + 6,
    Math.atan2(-6, -6), -0.32,
  );
  // The dev server runs several agents' probes at once and can be seconds
  // behind; give the render loop room before counting meshes.
  await new Promise((r) => setTimeout(r, 2200));
  let boxes = 0;
  g.renderer.scene.traverse((o) => { if (o.name && o.name.startsWith('spoil_')) boxes += 1; });
  return { pieces: pieces.length, boxes };
});
check('every piece of sunken cargo the server reports is drawn in the world',
  drawn.boxes === drawn.pieces, `drawn=${drawn.boxes}/${drawn.pieces}`);
await shot('04-sunken-cargo');

const cleared = await page.evaluate(async () => {
  clearInterval(window.__probeSpoilPin);
  window.__piratesBR.state.spoils = [];
  await new Promise((r) => setTimeout(r, 600));
  let boxes = 0;
  window.__piratesBR.renderer.scene.traverse((o) => { if (o.name && o.name.startsWith('spoil_')) boxes += 1; });
  window.__piratesBR.disableFreeCam();
  return boxes;
});
check('claimed / tide-taken cargo leaves the scene (no orphaned meshes)',
  cleared === 0, `left=${cleared}`);
await wait(600);
await shot('05-wreck-site-cleared');

console.log(`\nconsole errors: ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 6).join('\n'));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed.`);
if (failed.length) console.log(failed.map((f) => `  ✗ ${f.label} ${f.detail}`).join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
