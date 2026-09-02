#!/usr/bin/env node
// PROBE, not a gate: Shot sheet for the seating/grounding TAIL — the pieces the live floater audit reports as "unclaimed scenery with daylight under it", plus the two p...
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// Shot sheet for the seating/grounding TAIL — the pieces the live floater audit
// reports as "unclaimed scenery with daylight under it", plus the two polish
// leftovers they travel with.
//
// One join, one free-cam sweep, so a before/after pair is comparable frame for
// frame:
//   dock-under      a pier from the water — do its legs reach the sea, or stop
//                   half a metre above it?
//   reef-*          the offshore reef ring, above and below the waterline
//   bridge-span     Kraken Tooth's rope bridge between the fangs (sky scenery)
//   portal-*        a cave mouth's frame stones on the hillside
//   fall-basin      the plunge pool of the STEEPEST fall (stone basin ring)
//   thin-roof       the mouth whose hillside is thinnest over the throat
//
//   node scripts/seating-tail-shots.mjs <outDir> [tag]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/seating-tail';
const TAG = process.argv[3] ?? '';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${TAG ? `${TAG}-` : ''}${n}.png`, timeout: 90_000 });

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

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// The dev server is shared with every other agent's watch/probe traffic, so a
// join can time out through no fault of the world under test. Retry the whole
// handshake a few times before giving up.
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 45_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 90_000 });
    break;
  } catch (err) {
    if (attempt >= 4) throw err;
    console.log(`join attempt ${attempt} failed (${err.name}); retrying`);
  }
}
await wait(3000);
await page.evaluate(() => {
  const e = document.createElement('style');
  e.textContent = '#hud,#disconnect-overlay{visibility:hidden!important;}';
  document.head.appendChild(e);
});
await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue(40));
await page.waitForFunction(
  () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
  null,
  { timeout: 90_000 },
);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(1200);

async function look(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0]; const dy = t[1] - p[1]; const dz = t[2] - p[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
  }, [pos, target]);
  await wait(450);
}

/** Everything the framings are computed from, read once from the live world. */
const info = await page.evaluate(() => {
  const g = window.__piratesBR;
  const islands = g.state.islands ?? [];
  const dockIsland = islands.find((i) => i.dock) ?? null;
  // The reef rock the sea is most likely to show you: the one that breaks the
  // surface highest, anywhere on the map, reported in world space with the
  // drawn seabed under it so the shot can be checked against a number.
  let reefPick = null;
  let reefCount = 0;
  let reefAwash = 0;
  const box = { min: null, max: null };
  void box;
  for (const isl of islands) {
    const grp = g.islandMeshes?.get(isl.id);
    grp?.traverse((o) => {
      if (o.name !== 'decor-reef-rock') return;
      reefCount++;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const half = bb.max.y * o.scale.y;
      const top = isl.position.y + o.position.y + half;
      const base = isl.position.y + o.position.y - half;
      if (top > 0.1) reefAwash++;
      if (!reefPick || top > reefPick.top) {
        reefPick = {
          island: isl.name,
          x: isl.position.x + o.position.x, z: isl.position.z + o.position.z,
          top: +top.toFixed(2), base: +base.toFixed(2),
        };
      }
    });
  }
  const bridgeIsland = islands.find((i) => (i.bridges ?? []).length > 0) ?? null;

  // Steepest fall site across the map: the one whose lip→base run is most
  // vertical (that is the flank that never grew a stone basin).
  let steepest = null;
  let thinnest = null;
  for (const isl of islands) {
    const mesh = g.islandMeshes?.get(isl.id);
    mesh?.traverse((o) => {
      if (o.name !== 'waterfall-site') return;
      const u = o.userData;
      if (!u?.lip || !u?.base) return;
      const run = Math.hypot(u.base.x - u.lip.x, u.base.z - u.lip.z);
      const steep = u.drop / Math.max(1.5, run);
      if (!steepest || steep > steepest.steep) steepest = { steep, island: isl.name, ...u };
    });
    for (const cave of isl.caves ?? []) {
      if (!(cave.hasMouth ?? true)) continue;
      // Overburden = how much hill stands over the throat ceiling.
      const over = (g.getIslandSurfaceYAt?.(isl, cave.position.x, cave.position.z)
        ?? cave.position.y + cave.height) - (cave.floorY + cave.height);
      if (!thinnest || over < thinnest.over) {
        thinnest = { over, island: isl.name, x: cave.position.x, y: cave.position.y, z: cave.position.z, rot: cave.rotation, floorY: cave.floorY, height: cave.height, interiorRadius: cave.interiorRadius ?? 3 };
      }
    }
  }
  const anyMouth = (() => {
    for (const isl of islands) {
      for (const cave of isl.caves ?? []) {
        if (cave.hasMouth ?? true) {
          return { island: isl.name, x: cave.position.x, y: cave.position.y, z: cave.position.z, rot: cave.rotation, floorY: cave.floorY, height: cave.height };
        }
      }
    }
    return null;
  })();
  return {
    dock: dockIsland && {
      island: dockIsland.name,
      x: dockIsland.dock.position.x, y: dockIsland.dock.position.y, z: dockIsland.dock.position.z,
      rot: dockIsland.dock.rotation, len: dockIsland.dock.length, width: dockIsland.dock.width,
    },
    reef: reefPick && { ...reefPick, count: reefCount, awash: reefAwash },
    bridge: bridgeIsland && {
      island: bridgeIsland.name,
      ...bridgeIsland.bridges[0],
    },
    fall: steepest,
    thin: thinnest,
    mouth: anyMouth,
  };
});
console.log(JSON.stringify(info, null, 1));

// ── dock: from the water, eye just above the swell, looking along the pier ──
if (info.dock) {
  const d = info.dock;
  const ax = Math.sin(d.rot); const az = Math.cos(d.rot);   // dock's +Z (seaward)
  await look([d.x + ax * (d.len * 0.85), 1.1, d.z + az * (d.len * 0.85)], [d.x, 0.6, d.z]);
  await shot('dock-under');
  await look([d.x + az * 14 + ax * 4, 2.4, d.z - ax * 14 + az * 4], [d.x, 0.5, d.z]);
  await shot('dock-side');
}

// ── reef ring: sit on the water off the island's east flank, then duck under ──
if (info.reef) {
  const rr = info.reef;
  await look([rr.x + 11, 4.2, rr.z + 11], [rr.x, rr.top - 0.3, rr.z]);
  await shot('reef-surface');
  await look([rr.x + 5.5, 0.75, rr.z + 5.5], [rr.x, rr.top - 0.5, rr.z]);
  await shot('reef-low');
}

// ── the rope bridge between the fangs ──
if (info.bridge) {
  const b = info.bridge;
  const mx = (b.ax + b.bx) * 0.5; const mz = (b.az + b.bz) * 0.5;
  const my = (b.ay + b.by) * 0.5;
  const dx = b.bx - b.ax; const dz = b.bz - b.az;
  const span = Math.hypot(dx, dz) || 1;
  const px = -dz / span; const pz = dx / span;          // perpendicular
  await look([mx + px * span * 0.9, my + span * 0.25, mz + pz * span * 0.9], [mx, my - span * 0.12, mz]);
  await shot('bridge-span');
}

// ── a cave mouth's frame stones, read from the approach ──
if (info.mouth) {
  const m = info.mouth;
  const ox = Math.sin(m.rot); const oz = Math.cos(m.rot);
  await look([m.x + ox * 22, m.floorY + 7, m.z + oz * 22], [m.x, m.floorY + 2.6, m.z]);
  await shot('portal-22');
  await look([m.x + ox * 9 + oz * 7, m.floorY + 2.4, m.z + oz * 9 - ox * 7], [m.x, m.floorY + 2.0, m.z]);
  await shot('portal-oblique');
}

// ── the thinnest-roofed mouth: the brown collar plate over the opening ──
if (info.thin) {
  const t = info.thin;
  const ox = Math.sin(t.rot); const oz = Math.cos(t.rot);
  await look([t.x + ox * 26, t.floorY + 16, t.z + oz * 26], [t.x, t.floorY + 4, t.z]);
  await shot('thin-roof-high');
  await look([t.x + ox * 15, t.floorY + 8, t.z + oz * 15], [t.x, t.floorY + 3, t.z]);
  await shot('thin-roof');
}

// ── the steepest fall's plunge pool ──
if (info.fall) {
  const f = info.fall;
  const fx = f.dir.x; const fz = f.dir.z;
  await look([f.base.x + fx * 14 - fz * 7, f.base.y + 6.0, f.base.z + fz * 14 + fx * 7], [f.base.x, f.base.y + 0.4, f.base.z]);
  await shot('fall-basin');
  await look([f.base.x + fx * 8, f.base.y + 2.2, f.base.z + fz * 8], [f.base.x, f.base.y + 0.2, f.base.z]);
  await shot('fall-basin-low');
}

await page.evaluate(() => window.__piratesBR.disableFreeCam());
await browser.close();
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 8));
console.log(`shots → ${OUT}`);
