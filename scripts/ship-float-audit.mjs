// Floating-part hunt on the procedural ships: geometric isolation detector
// (per-ship AABB adjacency graph — flag meshes whose bounds touch nothing)
// + close-orbit screenshots of every hull type in both sail states.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = '/private/tmp/claude-501/-Users-tobiasdicker/050cdec7-6c22-46d0-9f92-8625309a876c/scratchpad/ships';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60000 });
async function freeLook(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2]; const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
  }, [pos, target]);
  await wait(650);
}
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await wait(4000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { const e = document.createElement('style'); e.textContent = '#hud{visibility:hidden!important;}'; document.head.appendChild(e); });

// ── Geometric isolation detector over EVERY ship in the match ──────────────
const report = await page.evaluate(() => {
  const g = window.__piratesBR;
  const sr = g.shipRenderer;
  const out = [];
  const expand = 0.06; // 6cm adjacency tolerance
  for (const [id, rec] of sr.shipMeshes) {
    const ship = (g.state.ships ?? []).find((s) => s.id === id);
    const boxes = [];
    rec.root.updateWorldMatrix(true, true);
    rec.root.traverse((o) => {
      if (!o.visible) return;
      let p = o.parent; while (p && p !== rec.root) { if (!p.visible) return; p = p.parent; }
      const isMesh = o.isMesh || o.isLine || o.isLineSegments;
      if (!isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      boxes.push({ o, bb });
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      const ea = a.bb.clone().expandByScalar(expand);
      let touches = 0;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        if (ea.intersectsBox(boxes[j].bb)) { touches++; break; }
      }
      if (touches === 0) {
        const size = a.bb.getSize(new a.bb.min.constructor());
        const c = a.bb.getCenter(new a.bb.min.constructor());
        const local = rec.root.worldToLocal(c.clone());
        out.push({
          ship: ship?.type ?? '?', shipId: id.slice(0, 8),
          name: a.o.name || a.o.parent?.name || '(unnamed)',
          kind: a.o.isLine ? 'line' : 'mesh',
          geo: a.o.geometry.type,
          sizeX: +size.x.toFixed(2), sizeY: +size.y.toFixed(2), sizeZ: +size.z.toFixed(2),
          localX: +local.x.toFixed(2), localY: +local.y.toFixed(2), localZ: +local.z.toFixed(2),
          color: a.o.material?.color ? '#' + a.o.material.color.getHexString() : '?',
        });
      }
    }
  }
  return out;
});
console.log('FLOATERS', JSON.stringify(report, null, 1));
writeFileSync(`${OUT}/floaters.json`, JSON.stringify(report, null, 2));

// ── Close-orbit shots: one ship of each type, plus a sails-set one ──────────
const ships = await page.evaluate(() => (window.__piratesBR.state.ships ?? []).map((s) => ({
  id: s.id, type: s.type, x: s.position.x, z: s.position.z, rot: s.rotation,
  anchored: s.anchored, sail: s.sailHeight ?? s.sailLevel ?? null, speed: Math.hypot(s.velocity?.x ?? 0, s.velocity?.z ?? 0),
})));
console.log('SHIPS', JSON.stringify(ships.map(s => `${s.type}@${Math.round(s.x)},${Math.round(s.z)} anchored=${s.anchored} v=${s.speed.toFixed(1)}`)));
const picks = [];
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const still = ships.filter((s) => s.type === type).sort((a, b) => a.speed - b.speed)[0];
  if (still) picks.push({ ...still, tag: `${type}-still` });
  const moving = ships.filter((s) => s.type === type && s.speed > 1.5).sort((a, b) => b.speed - a.speed)[0];
  if (moving) picks.push({ ...moving, tag: `${type}-sailing` });
}
for (const p of picks) {
  // refresh position right before each series (bots move)
  const live = await page.evaluate((id) => {
    const s = (window.__piratesBR.state.ships ?? []).find((x) => x.id === id);
    return s ? { x: s.position.x, y: s.position.y, z: s.position.z, rot: s.rotation } : null;
  }, p.id);
  if (!live) continue;
  const { x, z, rot } = live;
  const fwd = [Math.sin(rot), Math.cos(rot)]; const rt = [Math.cos(rot), -Math.sin(rot)];
  const L = p.type === 'galleon' ? 26 : p.type === 'brigantine' ? 21 : 16;
  await freeLook([x + fwd[0] * L + rt[0] * L * 0.7, 9, z + fwd[1] * L + rt[1] * L * 0.7], [x, 4.5, z]); await shot(`${p.tag}-bowq`);
  await freeLook([x + rt[0] * L * 1.15, 7, z + rt[1] * L * 1.15], [x, 5, z]); await shot(`${p.tag}-broadside`);
  await freeLook([x - fwd[0] * L - rt[0] * L * 0.5, 9, z - fwd[1] * L - rt[1] * L * 0.5], [x, 5, z]); await shot(`${p.tag}-sternq`);
  // deck-level look UP the rig (catches floating rigging/rope ends against sky)
  await freeLook([x - fwd[0] * 3, 4.2, z - fwd[1] * 3], [x + fwd[0] * 6, 14, z + fwd[1] * 6]); await shot(`${p.tag}-riglook`);
  // top-down (catches parts hovering beside the hull)
  await freeLook([x + 2, 34, z + 2], [x, 3, z]); await shot(`${p.tag}-top`);
}
await browser.close();
console.log('done');
