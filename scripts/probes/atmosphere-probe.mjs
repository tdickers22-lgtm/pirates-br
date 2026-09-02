// PROBE, not a gate: Atmosphere / lighting visual probe: captures the frames the night, storm-wall, grazing-water, underwater, dusk-glow and distance-fog defects live in.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// Atmosphere / lighting visual probe: captures the frames the night, storm-wall,
// grazing-water, underwater, dusk-glow and distance-fog defects live in.
// Requires the dev stack (vite :3000 + ws :8090). GPU-headless; pointer lock
// never engages, so the camera is driven through enableFreeCam/setLook.
//   node --import tsx scripts/atmosphere-probe.mjs <outDir> [scene...]
// Scenes: night, dusk, storm, graze, under, fog  (default: all)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/atmosphere';
const WANT = process.argv.slice(3);
const want = (name) => WANT.length === 0 || WANT.includes(name);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

// Other agents edit this tree concurrently: vite HMR reloads and server
// restarts make a single join attempt flaky, so retry a few times.
async function session(query, attempts = 4) {
  for (let n = 1; n <= attempts; n++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    try {
      await page.goto(`http://127.0.0.1:3000/${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 45_000 });
      await page.waitForTimeout(3500);
      return page;
    } catch (err) {
      console.log(`  join attempt ${n} failed: ${err.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      if (n === attempts) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw new Error('unreachable');
}

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
const wait = (page, ms) => page.waitForTimeout(ms);
const cam = (page, pos, target) => page.evaluate(([p, t]) => {
  const g = window.__piratesBR;
  const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
}, [pos, target]);
const time = (page, sec) => page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);
const world = (page) => page.evaluate(() => {
  const g = window.__piratesBR;
  const p = g.state.players?.get?.(g.state.selfId) ?? null;
  return {
    self: p ? { x: p.position.x, y: p.position.y, z: p.position.z } : null,
    islands: (g.state.islands ?? []).map((i) => ({
      name: i.name, x: i.position.x, z: i.position.z, r: i.radius,
      biome: i.profile?.biome, style: i.profile?.terrainStyle,
    })),
    ships: (g.state.ships ? [...g.state.ships.values()] : []).map((s) => ({ x: s.position.x, z: s.position.z })),
    storm: g.state.storm ? { ...g.state.storm } : null,
  };
});

// ── night / dusk / fog: one session, free-cam tours ─────────────────────────
if (want('night') || want('dusk') || want('fog') || want('graze') || want('under')) {
  const page = await session('?debug&quality=high');
  const w = await world(page);
  console.log('self', JSON.stringify(w.self), 'islands', w.islands.length);
  console.log(w.islands.map((i, n) => `${n}:${i.name}@${i.x.toFixed(0)},${i.z.toFixed(0)} r${i.r.toFixed(0)} ${i.style}/${i.biome}`).join('\n'));
  const home = w.islands.reduce((best, i) => {
    if (!w.self) return best;
    const d = Math.hypot(i.x - w.self.x, i.z - w.self.z);
    return !best || d < best.d ? { ...i, d } : best;
  }, null) ?? w.islands[0];
  console.log('home island', home?.name, home?.x, home?.z, home?.r);

  const shore = [home.x + home.r * 1.15, 1.4, home.z];
  const shoreLook = [home.x, 8, home.z];
  const inland = [home.x + home.r * 0.25, null, home.z + home.r * 0.25];
  const groundY = await page.evaluate(([x, z]) => window.__piratesBR.sampleGroundY(x, z), [inland[0], inland[2]]);
  inland[1] = groundY + 1.7;
  const vista = [home.x + home.r * 3.2, 26, home.z + home.r * 3.2];

  for (const [tag, sec] of [['night', 374], ['dusk', 240], ['noon', 854]]) {
    if (!want(tag) && tag !== 'noon') continue;
    if (tag === 'noon' && !(want('fog') || want('graze'))) continue;
    await time(page, sec);
    await wait(page, 900);
    await cam(page, shore, shoreLook);
    await wait(page, 700);
    await shot(page, `${tag}-01-shore-eye`);
    await cam(page, [shore[0], 12, shore[2]], shoreLook);
    await wait(page, 500);
    await shot(page, `${tag}-02-shore-high`);
    await cam(page, inland, [home.x, groundY + 2, home.z]);
    await wait(page, 700);
    await shot(page, `${tag}-03-inland`);
    await cam(page, vista, [home.x, home.r * 0.2, home.z]);
    await wait(page, 700);
    await shot(page, `${tag}-04-vista`);
    // deck: nearest ship
    const ship = w.ships[0];
    if (ship) {
      await cam(page, [ship.x + 9, 6.5, ship.z + 9], [ship.x, 3.2, ship.z]);
      await wait(page, 700);
      await shot(page, `${tag}-05-deck`);
      await cam(page, [ship.x + 1.2, 4.2, ship.z + 4], [ship.x, 3.0, ship.z - 6]);
      await wait(page, 600);
      await shot(page, `${tag}-06-ondeck`);
    }
    // long-range silhouettes: look at the farthest island from a high sea cam
    const far = w.islands.reduce((best, i) => {
      const d = Math.hypot(i.x - home.x, i.z - home.z);
      return !best || d > best.d ? { ...i, d } : best;
    }, null);
    if (far) {
      const ux = (far.x - home.x) / far.d, uz = (far.z - home.z) / far.d;
      for (const dist of [500, 700]) {
        await cam(page, [far.x - ux * dist, 30, far.z - uz * dist], [far.x, far.r * 0.25, far.z]);
        await wait(page, 600);
        await shot(page, `${tag}-07-far${dist}`);
      }
    }
  }

  if (want('graze') || want('under')) {
    await time(page, 854);
    await wait(page, 800);
    // grazing eye-level water just off the white sand
    for (const [tag, y, pitch] of [['graze-a', 0.35, 0.0], ['graze-b', 0.2, 0.02], ['graze-c', 0.8, -0.03]]) {
      await cam(page, [home.x + home.r * 1.05, y, home.z], [home.x + home.r * 1.05 - 60, y + pitch * 60, home.z + 40]);
      await wait(page, 600);
      await shot(page, tag);
    }
    // underwater: below the surface looking at the island slope
    for (const [tag, y] of [['under-a', -1.6], ['under-b', -4.0]]) {
      await cam(page, [home.x + home.r * 1.15, y, home.z], [home.x, y + 1.5, home.z]);
      await wait(page, 700);
      await shot(page, tag);
    }
  }
  await page.close();
}

// ── storm wall, from inside and outside the ring ────────────────────────────
if (want('storm')) {
  const page = await session('?debug&quality=high&stormdemo');
  const w = await world(page);
  console.log('storm', JSON.stringify(w.storm));
  const s = w.storm ?? { centerX: 0, centerZ: 0, safeRadius: 900 };
  const r = Math.max(120, s.safeRadius);
  for (const [tag, mult, y, pitch] of [
    ['storm-01-inside-far', 0.25, 8, 0.10],
    ['storm-02-inside-near', 0.85, 8, 0.10],
    ['storm-03-at-wall', 1.0, 8, 0.12],
    ['storm-04-outside', 1.25, 8, 0.06],
    ['storm-05-outside-back', 1.6, 10, 0.08],
  ]) {
    const px = s.centerX + r * mult, pz = s.centerZ;
    await cam(page, [px, y, pz], [s.centerX + (mult > 1 ? -1 : 1) * 400 + px - px, y + pitch * 200, pz]);
    // aim outward for outside cams, inward-tangential for inside cams
    await page.evaluate(([p, yaw, pitch2]) => window.__piratesBR.enableFreeCam(p[0], p[1], p[2], yaw, pitch2),
      [[px, y, pz], mult > 1 ? Math.PI * 0.5 : Math.PI * 0.5, pitch]);
    await wait(page, 900);
    await shot(page, tag);
  }
  // tall aerial of the whole ring
  await page.evaluate(([c, r2]) => window.__piratesBR.enableFreeCam(c[0] + r2 * 1.5, 220, c[1] + r2 * 1.5, Math.PI * 1.25, -0.35),
    [[s.centerX, s.centerZ], r]);
  await wait(page, 900);
  await shot(page, 'storm-06-aerial');
  // on the sea, ship in storm
  const ship = w.ships[0];
  if (ship) {
    await page.evaluate(([sh]) => window.__piratesBR.enableFreeCam(sh[0] + 14, 7, sh[1] + 14, Math.PI * 1.25, -0.05), [[ship.x, ship.z]]);
    await wait(page, 900);
    await shot(page, 'storm-07-ship');
  }
  await page.close();
}

// ── storm wall up close: a late-phase small ring pinned client-side ─────────
if (want('wall')) {
  const page = await session('?debug&quality=high');
  const info = await page.evaluate(() => {
    const g = window.__piratesBR;
    const real = g.state.storm;
    const fake = { ...real, safeRadius: 170, nextRadius: 120, phase: 5, shrinking: true, shrinkProgress: 0.4 };
    Object.defineProperty(g.state, 'storm', { get: () => fake, set: () => {} });
    return { centerX: fake.centerX, centerZ: fake.centerZ, r: fake.safeRadius };
  });
  console.log('pinned ring', JSON.stringify(info));
  await wait(page, 1500);
  console.log('weather', JSON.stringify(await page.evaluate(() => {
    const g = window.__piratesBR;
    return {
      radius: g.state.storm.safeRadius,
      weather: g.envFx.computeStormWeatherIntensity(),
      rain: g.envFx.computeStormRainIntensity(),
      wallScale: g.stormWall.scale.x,
      wallOpacity: g.stormWall.material.opacity,
    };
  })));
  const { centerX: cx, centerZ: cz, r } = info;
  // Ring is pinned at the world origin (Old Maw), so aim from open water south
  // of it: camera on +Z, looking back toward the centre.
  const views = [
    ['wall-01-inside-level', cx, 6, cz + r * 0.5, [cx, 8, cz - 400]],
    ['wall-02-inside-up', cx, 6, cz + r * 0.5, [cx, 90, cz - 200]],
    ['wall-03-at-wall', cx, 6, cz + r * 0.98, [cx, 20, cz - 300]],
    ['wall-04-outside-in', cx, 8, cz + r * 1.9, [cx, 16, cz]],
    ['wall-05-outside-far', cx, 14, cz + r * 4.5, [cx, 30, cz]],
    ['wall-06-aerial', cx + r * 2.4, 150, cz + r * 2.4, [cx, 0, cz]],
  ];
  for (const [tag, x, y, z, target] of views) {
    await cam(page, [x, y, z], target);
    await wait(page, 900);
    await shot(page, tag);
  }
  // and the same wall at dusk / night, where the void reads worst
  for (const [tag, sec] of [['wall-07-dusk', 240], ['wall-08-night', 374]]) {
    await time(page, sec);
    await wait(page, 900);
    await cam(page, [cx, 8, cz + r * 1.9], [cx, 24, cz]);
    await wait(page, 700);
    await shot(page, tag);
  }
  await page.close();
}

await browser.close();
console.log(`shots in ${OUT}/`);
