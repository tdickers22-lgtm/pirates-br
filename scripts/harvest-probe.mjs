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

// Nearest palm on the spawn island.
const target = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  let best = null;
  for (const island of g.state.islands) {
    for (const prop of island.props) {
      if (!prop.type.startsWith('palm_') || prop.type === 'palm_ground' || prop.id === undefined) continue;
      const d = Math.hypot(prop.x - me.position.x, prop.z - me.position.z);
      if (!best || d < best.d) best = { d, x: prop.x, z: prop.z, id: prop.id, type: prop.type, islandId: island.id };
    }
  }
  return best;
});
console.log('target palm:', JSON.stringify(target));

// Walk to it.
for (let i = 0; i < 160; i++) {
  const d = await page.evaluate(([tx, tz]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const dx = tx - me.position.x;
    const dz = tz - me.position.z;
    g.input.setLook(Math.atan2(dx, dz), -0.05);
    g.input.keys.add('KeyW');
    if (me.state === 'swimming') g.input.jumpPressed = true;
    return Math.hypot(dx, dz);
  }, [target.x, target.z]);
  if (d < 2.4) break;
  await wait(120);
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
await wait(300);
await shot('0-at-tree');

// Hold LMB through the chop; sample visibility of the promoted clone.
await page.evaluate(() => window.__piratesBR.input.mouseButtons.add(0));
for (const [i, ms] of [400, 900, 900, 900].entries()) {
  await wait(ms);
  const st = await page.evaluate(([tid]) => {
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
      propStillListed: g.state.islands.some((isl) => isl.props.some((p) => p.id === tid && p.type.startsWith('palm_'))),
      falls: g.harvestFalls?.length ?? 0,
    };
  }, [target.id]);
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
