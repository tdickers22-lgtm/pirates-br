// End-to-end chop probe: equips the axe, walks to the nearest palm, holds LMB
// through the full chop, screenshotting along the way — verifies the promoted
// tree STAYS VISIBLE while chopping, then topples, and wood is granted.
// node scripts/harvest-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/harvest';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Surface shader/JS errors — an instanceMatrix GLSL compile failure renders
// the promoted clone invisible while all Object3D telemetry still looks fine.
const seenErrors = new Set();
page.on('console', (msg) => {
  if (msg.type() !== 'error' && msg.type() !== 'warning') return;
  const text = msg.text().slice(0, 300);
  if (seenErrors.has(text)) return;
  seenErrors.add(text);
  if (/shader|webgl|three/i.test(text)) console.log(`[console.${msg.type()}]`, text);
});
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 30_000 });
const wait = (ms) => page.waitForTimeout(ms);
await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3000);

// Equip the axe (retry — the wheel one-shot can swallow rapid calls).
for (let i = 0; i < 10; i++) {
  const tool = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    if (me.equippedTool !== 'axe') g.input.queueWheelSlot(9);
    return me.equippedTool;
  });
  if (tool === 'axe') break;
  await wait(500);
}

// Walk to the nearest palm. Cliff/blocker-aware: strafe+hop when progress
// stalls, and blacklist a palm entirely after ~4s of no progress (cliffside
// palms can be unreachable on foot), re-targeting the next nearest.
const failed = [];
let target = null;
let arrived = false;
for (let attempt = 0; attempt < 4 && !arrived; attempt++) {
  target = await page.evaluate((skip) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    let best = null;
    for (const island of g.state.islands) {
      for (const prop of island.props) {
        if (!prop.type.startsWith('palm_') || prop.type === 'palm_ground' || prop.id === undefined) continue;
        const key = `${island.id}:${prop.id}`;
        if (skip.includes(key)) continue;
        const d = Math.hypot(prop.x - me.position.x, prop.z - me.position.z);
        if (!best || d < best.d) best = { d, x: prop.x, z: prop.z, id: prop.id, type: prop.type, islandId: island.id, key };
      }
    }
    return best;
  }, failed);
  if (!target) break;
  console.log('target palm:', JSON.stringify(target));
  let bestD = Infinity;
  let stuckTicks = 0;
  for (let i = 0; i < 140; i++) {
    const strafe = stuckTicks > 6 ? (Math.floor(stuckTicks / 7) % 2 ? 1 : -1) : 0;
    const hop = stuckTicks > 6 && stuckTicks % 3 === 0;
    const d = await page.evaluate(([tx, tz, str, jump]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const dx = tx - me.position.x;
      const dz = tz - me.position.z;
      g.input.setLook(Math.atan2(dx, dz), -0.05);
      g.input.keys.add('KeyW');
      g.input.keys.delete('KeyA');
      g.input.keys.delete('KeyD');
      if (str) g.input.keys.add(str > 0 ? 'KeyD' : 'KeyA');
      if (me.state === 'swimming' || jump) g.input.jumpPressed = true;
      return Math.hypot(dx, dz);
    }, [target.x, target.z, strafe, hop]);
    if (d < 2.4) { arrived = true; break; }
    if (d < bestD - 0.12) { bestD = d; stuckTicks = 0; } else stuckTicks++;
    if (stuckTicks > 33) break;
    await wait(120);
  }
  if (!arrived) {
    failed.push(target.key);
    console.log('unreachable, re-targeting:', target.key);
  }
}
await page.evaluate(() => {
  const k = window.__piratesBR.input.keys;
  k.delete('KeyW'); k.delete('KeyA'); k.delete('KeyD');
});
if (!arrived) {
  console.log('FAILED: could not reach any palm');
  await shot('0-at-tree');
  await browser.close();
  process.exit(1);
}
await wait(300);
await shot('0-at-tree');

// Hold LMB through the chop; sample visibility of the promoted clone.
await page.evaluate(() => window.__piratesBR.input.mouseButtons.add(0));
for (const [i, ms] of [400, 900, 900, 900].entries()) {
  await wait(ms);
  const st = await page.evaluate(([tid, tIsland]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const promoted = g.harvestPromoted;
    return {
      wood: me.pocketWood,
      promoted: promoted ? (() => {
        const w = promoted.node.getWorldPosition(new (promoted.node.position.constructor)());
        const parentName = promoted.node.parent?.name || promoted.node.parent?.type;
        return { id: promoted.propId, visible: promoted.node.visible, parentName, world: [+w.x.toFixed(1), +w.y.toFixed(1), +w.z.toFixed(1)], scale: +promoted.node.scale.x.toFixed(2) };
      })() : null,
      me: (() => { const m = g.state.players.find((p) => p.id === g.localPlayerId); return [+m.position.x.toFixed(1), +m.position.y.toFixed(1), +m.position.z.toFixed(1)]; })(),
      // Prop ids are island-local sequential — scope the check to the target
      // island or it false-positives on other islands' palms forever.
      propStillListed: !!g.state.islands.find((isl) => isl.id === tIsland)?.props.some((p) => p.id === tid),
      falls: g.harvestFalls?.length ?? 0,
    };
  }, [target.id, target.islandId]);
  console.log(`t+${(i + 1)}s:`, JSON.stringify(st));
  await shot(`chop-${i}`);
}
await page.evaluate(() => window.__piratesBR.input.mouseButtons.delete(0));
await wait(1600);
await shot('after-fall');
const final = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return { wood: me.pocketWood };
});
console.log('final:', JSON.stringify(final));
await browser.close();
