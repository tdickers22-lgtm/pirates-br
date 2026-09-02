#!/usr/bin/env node
// PROBE, not a gate: Eye-level grounding shots: the dressing layer photographed the way the audit photographs it — noon, 3-5 m from the piece, camera at head height.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// Eye-level grounding shots: the dressing layer photographed the way the audit
// photographs it — noon, 3-5 m from the piece, camera at head height.
//
// Per island it frames (a) the boulder nearest the dock — the P1 floater — and
// (b) the densest patch of interior decor, so contact shadows, prop seating and
// the grass tint can be judged in one pass.
//
//   node scripts/decor-grounding-shots.mjs <outDir> [islandIndex,...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/decor-shots';
const PICK = (process.argv[3] ?? '').split(',').filter(Boolean).map(Number);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (err) => console.log(`  [pageerror] ${err}`));
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

await page.goto('http://127.0.0.1:3000/?debug', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  window.__piratesBR.setDayNightOverride(854);      // noon
  window.__piratesBR.drainIslandBuildQueue(40);
});
// Dismiss the ship's-orders card and shoot the CANVAS only, so the HUD chrome
// never covers the thing being audited.
await page.keyboard.press('KeyL');
// Element screenshots still composite the DOM on top of the canvas, so hide the
// HUD outright — this audit is about pixels of ground, not chrome.
await page.addStyleTag({ content: '#hud, #debug-perf, #interact-prompt, #crosshair, .hud-toast { display: none !important; }' });
await page.waitForTimeout(2500);
const canvas = page.locator('canvas').first();

/** Camera targets: {name, cam:{x,y,z}, yaw, pitch}. */
const shots = await page.evaluate((pick) => {
  const g = window.__piratesBR;
  const out = [];
  const islands = g.state.islands;
  const chosen = pick.length ? pick.map((i) => islands[i]).filter(Boolean) : islands;
  for (const island of chosen) {
    const ground = (x, z) => g.sampleGroundY(x, z);
    const dock = island.dock;
    const rocks = (island.props ?? []).filter((p) => p.type.startsWith('boulder_'));
    const aim = (tx, ty, tz, dist, bearing, eyeY = null) => {
      const cx = tx + Math.sin(bearing) * dist;
      const cz = tz + Math.cos(bearing) * dist;
      const cy = eyeY ?? (Math.max(ground(cx, cz), 0.4) + 1.62);
      const dx = tx - cx; const dy = ty - cy; const dz = tz - cz;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      return { cam: { x: cx, y: cy, z: cz }, yaw, pitch };
    };
    if (dock && rocks.length) {
      let best = null;
      for (const r of rocks) {
        const d = Math.hypot(r.x - dock.position.x, r.z - dock.position.z);
        if (!best || d < best.d) best = { d, rock: r };
      }
      if (best && best.d < 90) {
        const r = best.rock;
        const bearing = Math.atan2(dock.position.x - r.x, dock.position.z - r.z) + 0.9;
        out.push({
          name: `${island.id}-dock-boulder`,
          ...aim(r.x, ground(r.x, r.z) + 0.9, r.z, 4.6, bearing),
          note: `${r.type} scale=${r.scale.toFixed(2)} ${best.d.toFixed(0)}m from the dock`,
        });
      }
    }
    // Sea stacks: a SWIMMER's eye line (0.5 m over the swell), where a rock
    // that stops at the waterline shows open sea under itself.
    if (!out.some((s) => s.name.endsWith('-sea-rock'))) {
      const near = (g.state.seaRocks ?? [])
        .filter((rk) => Math.hypot(rk.position.x - island.position.x, rk.position.z - island.position.z) < 340)
        .sort((a, b) => a.radius - b.radius)[0];
      if (near) {
        out.push({
          name: `${island.id}-sea-rock`,
          ...aim(near.position.x, 1.0, near.position.z, near.radius * 1.5 + 11, 1.1, 0.5),
          note: `sea stack r=${near.radius.toFixed(1)} h=${near.height.toFixed(1)}`,
        });
      }
    }
    // Tavern floor: blades used to grow up through the floorboards.
    if (island.tavern) {
      const t = island.tavern;
      out.push({
        name: `${island.id}-tavern-floor`,
        cam: { x: t.position.x + Math.sin(t.rotation) * 2.2, y: t.position.y + 1.5, z: t.position.z + Math.cos(t.rotation) * 2.2 },
        yaw: t.rotation + Math.PI,
        pitch: -0.55,
        note: 'tavern floor',
      });
    }
    // Densest interior cluster: the prop with the most neighbours within 14 m.
    const props = (island.props ?? []).filter((p) => !p.type.startsWith('dock_'));
    let hub = null;
    for (const p of props) {
      let n = 0;
      for (const q of props) if (Math.hypot(p.x - q.x, p.z - q.z) < 14) n++;
      if (!hub || n > hub.n) hub = { n, p };
    }
    if (hub) {
      const p = hub.p;
      out.push({
        name: `${island.id}-decor-cluster`,
        ...aim(p.x, ground(p.x, p.z) + 1.1, p.z, 7.5, 2.1),
        note: `${hub.n} props within 14m of ${p.type}`,
      });
    }
  }
  return out;
}, PICK);

for (const shot of shots) {
  await page.evaluate((s) => {
    window.__piratesBR.enableFreeCam(s.cam.x, s.cam.y, s.cam.z, s.yaw, s.pitch);
  }, shot);
  await page.waitForTimeout(900);
  await canvas.screenshot({ path: `${OUT}/${shot.name}.png`, timeout: 90_000 });
  console.log(`  ${shot.name}  (${shot.note})`);
}
await page.evaluate(() => window.__piratesBR.disableFreeCam());
console.log(`\n${shots.length} shots → ${OUT}`);
await browser.close();
