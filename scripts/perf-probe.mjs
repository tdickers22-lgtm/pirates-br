// Performance probe for Pirates BR — single build, or an interleaved A/B.
//
// Joins a solo match against a *production* build served by the game server's
// own static handler, then measures a fixed set of scenes with the free-cam.
//
// Why it is built the way it is:
//  - vsync is disabled (--disable-gpu-vsync --disable-frame-rate-limit) so the
//    rAF cadence reports real render cost instead of a 60Hz ceiling.
//  - the adaptive pixel-ratio scaler is PINNED so a slower build cannot quietly
//    buy its fps back with resolution and make the A/B lie.
//  - the day/night clock is pinned to noon, and PIRATES_BR_MAP_SEED pins the
//    world, so both builds see the same sea.
//  - A/B mode interleaves: scene by scene, A then B, repeated. The idle build is
//    PARKED (4x4 viewport + 20x CPU throttle) so it costs nothing while the
//    other one is being timed, and machine-wide drift hits both equally.
//  - the reported number per scene is the best repeat's MEDIAN frame time.
//    Interference only ever makes frames slower, so best-of-N median is the
//    robust estimator of what the machine can actually do.
//
// Usage (single):  node perf-probe.mjs --url http://127.0.0.1:8090 --label HEAD
// Usage (A/B):     node perf-probe.mjs --url <A> --label HEAD \
//                       --urlB <B> --labelB BASELINE --repeats 3 --out ab.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── args ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const URL_A = arg('url', 'http://127.0.0.1:8090').replace(/\/$/, '');
const URL_B = arg('urlB', null)?.replace(/\/$/, '') ?? null;
const LABEL_A = arg('label', 'HEAD');
const LABEL_B = arg('labelB', 'BASELINE');
const OUT = arg('out', null);
const REPEATS = parseInt(arg('repeats', '3'), 10);
const QUALITY = arg('quality', 'high');
const WARMUP_MS = parseInt(arg('warmup', '5000'), 10);
const CAPTURE_MS = parseInt(arg('capture', '6000'), 10);
const CPU_THROTTLE = parseFloat(arg('throttle', '1'));
const PARK_THROTTLE = 20;
const DPR = parseFloat(arg('dpr', '1'));
const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const HEADFUL = flag('headful');
const QUIET = flag('quiet');

const VIEWPORT = { width: 1600, height: 900 };
const PARKED = { width: 8, height: 8 };

// ─── scene table ───────────────────────────────────────────────
// Each scene names the URL session it needs; scenes sharing a session are
// measured back to back in one page load.
export const SCENES = [
  { id: 'dock-vista',      session: 'main',   label: 'dock vista (wide)' },
  { id: 'deck-aft',        session: 'main',   label: 'on-deck aft look' },
  { id: 'island-interior', session: 'main',   label: 'island interior eye-level' },
  { id: 'cave-interior',   session: 'main',   label: 'cave interior' },
  { id: 'open-sea',        session: 'main',   label: 'open-sea sail view' },
  { id: 'storm-sea',       session: 'storm',  label: 'storm at sea (?stormdemo)' },
  { id: 'combat-burst',    session: 'combat', label: 'combat burst (cannon + keg FX)' },
];

const sessionParams = (session) => ({
  main:   ['debug', `quality=${QUALITY}`],
  storm:  ['debug', `quality=${QUALITY}`, 'stormdemo'],
  combat: ['debug', `quality=${QUALITY}`, 'forceinput'],
}[session]);

const activeScenes = SCENES.filter((s) => !SCENE_FILTER || SCENE_FILTER.includes(s.id));
const activeSessions = [...new Set(activeScenes.map((s) => s.session))];

// ─── in-page helpers ───────────────────────────────────────────

/** Pin the adaptive resolution scaler so fps is the only free variable. */
const PIN_PIXEL_RATIO = () => {
  const r = window.__piratesBR?.renderer;
  if (!r) return false;
  r.minPixelRatio = 1;
  r.maxPixelRatio = 1;
  r.applyPixelRatio(1);
  return true;
};

/** Longest main-thread gap between rAF callbacks — a stall detector. */
const INSTALL_GAP_SAMPLER = () => {
  const w = window;
  w.__gap = { worst: 0, last: performance.now(), gaps: [], start: performance.now() };
  const step = () => {
    const now = performance.now();
    const dt = now - w.__gap.last;
    w.__gap.last = now;
    if (dt > w.__gap.worst) w.__gap.worst = dt;
    if (dt > 100) w.__gap.gaps.push({ at: Math.round(now - w.__gap.start), ms: Math.round(dt) });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// ─── world probing ─────────────────────────────────────────────
async function readWorld(page) {
  return page.evaluate(() => {
    const g = window.__piratesBR;
    const st = g?.state;
    if (!st) return null;
    const islands = st.islands.map((i) => ({
      id: i.id,
      name: i.name,
      x: i.position.x,
      z: i.position.z,
      radius: i.radius,
      hasDock: !!i.dock,
      caves: (i.caves ?? [])
        .filter((c) => c.hasMouth !== false)
        .map((c) => ({
          x: c.position.x, y: c.position.y, z: c.position.z,
          rotation: c.rotation, length: c.length, floorY: c.floorY,
        })),
    }));
    // The LOCAL player's ship: with the pinned match seed it spawns at the same
    // place in both builds, and — unlike a bot's ship, which sails off on its
    // own errands within a minute — nobody is at its helm, so it holds station
    // and the scene stays framed against the same water and the same islands.
    const ships = st.ships ?? [];
    const mine = g.localPlayerId;
    const ship = ships.find((s) => s.ownerId === mine) ?? ships[0];
    return {
      islands,
      ship: ship
        ? { id: ship.id, type: ship.type, x: ship.position.x, y: ship.position.y, z: ship.position.z, rot: ship.rotation ?? 0 }
        : null,
    };
  });
}

/** Fixed camera placements derived from the (identical, seeded) world layout. */
export function planScenes(world) {
  const byName = (n) => world.islands.find((i) => i.name === n) ?? null;
  const dockIsland = byName('Castaway Reach') ?? world.islands.find((i) => i.hasDock) ?? world.islands[0];
  const interiorIsland = byName('Old Maw Caldera') ?? world.islands[0];
  const caveIsland = world.islands.find((i) => i.caves.length > 0) ?? null;
  const cave = caveIsland?.caves[0] ?? null;

  const plan = {};

  // Wide vista onto a docked island from offshore, high enough to see the lot.
  plan['dock-vista'] = {
    x: dockIsland.x - (dockIsland.radius + 95),
    y: 30,
    z: dockIsland.z - (dockIsland.radius + 95),
    yaw: 0,
    pitch: -0.16,
    aimAt: { x: dockIsland.x, z: dockIsland.z },
  };

  // Standing on a deck, looking aft down the ship. The camera FOLLOWS the ship
  // so the hull frames identically no matter where the bot has sailed to.
  plan['deck-aft'] = world.ship
    ? {
        ship: true, dy: 4.2, yawOffset: Math.PI, pitch: -0.05,
        x: world.ship.x, y: world.ship.y + 4.2, z: world.ship.z, yaw: (world.ship.rot ?? 0) + Math.PI,
      }
    : { x: 0, y: 6, z: 0, yaw: 0, pitch: -0.05 };

  // Eye level inside the island, sampled onto the real heightfield.
  plan['island-interior'] = {
    x: interiorIsland.x + interiorIsland.radius * 0.28,
    y: null, // resolved via sampleGroundY at runtime
    z: interiorIsland.z + interiorIsland.radius * 0.18,
    yaw: 2.35,
    pitch: -0.04,
    groundOffset: 1.7,
  };

  // A few metres inside the cave mouth, looking down the tunnel.
  plan['cave-interior'] = cave
    ? {
        x: cave.x - Math.sin(cave.rotation) * (cave.length * 0.35),
        y: (cave.floorY ?? cave.y) + 1.6,
        z: cave.z - Math.cos(cave.rotation) * (cave.length * 0.35),
        yaw: cave.rotation + Math.PI,
        pitch: -0.02,
      }
    : { x: interiorIsland.x, y: 6, z: interiorIsland.z, yaw: 0, pitch: 0 };

  // Open water, clear of every island: pure ocean + sky + horizon cost.
  const seaPoint = { x: 980, z: 960 };
  plan['open-sea'] = { x: seaPoint.x, y: 8, z: seaPoint.z, yaw: 3.9, pitch: -0.02 };
  plan['storm-sea'] = { x: seaPoint.x, y: 8, z: seaPoint.z, yaw: 3.9, pitch: -0.02 };

  // Combat: alongside the same hull, with a scripted, build-identical FX burst.
  plan['combat-burst'] = world.ship
    ? {
        ship: true, dy: 5.0, dside: -14, yawOffset: Math.PI / 2, pitch: -0.03, fx: true,
        x: world.ship.x - 14, y: world.ship.y + 5, z: world.ship.z, yaw: Math.PI / 2,
      }
    : { x: 0, y: 6, z: 0, yaw: 0, pitch: 0, fx: true };

  return plan;
}

// ─── measurement ───────────────────────────────────────────────
async function measureScene(page, cam, { warmupMs, captureMs }) {
  await page.evaluate(
    ([c]) => {
      const g = window.__piratesBR;
      let y = c.y;
      if (y === null || y === undefined) {
        y = (g.sampleGroundY(c.x, c.z) ?? 0) + (c.groundOffset ?? 1.7);
      }
      let yaw = c.yaw;
      if (c.aimAt) yaw = Math.atan2(c.aimAt.x - c.x, c.aimAt.z - c.z);
      g.enableFreeCam(c.x, y, c.z, yaw, c.pitch);
      g.setDayNightOverride(854); // noon: identical sun/shader path in both builds
      window.__camY = y;
    },
    [cam],
  );

  return page.evaluate(
    async ([warmup, capture, c]) => {
      const g = window.__piratesBR;
      const info = g.renderer.renderer.info;
      const fire = !!c.fx;
      const fx = g.combatFx;
      // Resolve OUR OWN ship per build. Never key off a ship id captured from
      // the other build — the ids differ, and the silent fallback to ships[0]
      // parks one build's camera on a bot galleon out at sea.
      const findShip = () => {
        const ships = g.state?.ships ?? [];
        return ships.find((s) => s.ownerId === g.localPlayerId) ?? ships[0] ?? null;
      };
      const placeCamera = () => {
        if (!c.ship) return null;
        const ship = findShip();
        if (!ship) return null;
        const rot = ship.rotation ?? 0;
        const side = c.dside ?? 0;
        const px = ship.position.x + Math.cos(rot) * side;
        const pz = ship.position.z - Math.sin(rot) * side;
        const py = ship.position.y + (c.dy ?? 4.2);
        g.enableFreeCam(px, py, pz, rot + (c.yawOffset ?? 0), c.pitch ?? -0.05);
        return { x: px, y: py, z: pz };
      };
      return await new Promise((resolve) => {
        const frames = [];
        let sumDraws = 0, sumTris = 0, samples = 0, programs = 0, peakDraws = 0, lines = 0;
        const start = performance.now();
        let last = start;
        let firedAt = 0, fxAt = 0, fxSeq = 0;
        let anchor = null;
        const step = () => {
          const now = performance.now();
          const dt = now - last;
          last = now;
          const elapsed = now - start;
          anchor = placeCamera() ?? anchor;
          if (fire && now - firedAt > 900) {
            firedAt = now;
            window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
            setTimeout(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })), 120);
          }
          if (fire && now - fxAt > 420) {
            // Scripted, build-identical FX burst: keg breach + cannonball
            // impacts + hull splinters, all around the framed hull.
            fxAt = now;
            const base = anchor ?? { x: c.x, y: c.y ?? 6, z: c.z };
            const a = fxSeq * 0.9;
            const camPos = g.renderer.camera.position;
            const p = { x: base.x + Math.cos(a) * 9, y: base.y - 1.5, z: base.z + Math.sin(a) * 9 };
            try { fx.emitKegExplosion(p, camPos); } catch { /* build without the hook */ }
            for (let k = 0; k < 4; k++) {
              const q = { x: p.x + (k - 2) * 1.6, y: p.y + 0.6 + k * 0.4, z: p.z + (k - 2) * 1.1 };
              try { fx.emitImpact('cannonball', q, camPos); } catch { /* ditto */ }
              try { fx.emitWoodChips(q); } catch { /* ditto */ }
            }
            fxSeq++;
          }
          if (elapsed > warmup) {
            frames.push(dt);
            sumDraws += info.render.calls;
            peakDraws = Math.max(peakDraws, info.render.calls);
            sumTris += info.render.triangles;
            lines = info.render.lines;
            programs = info.programs?.length ?? 0;
            samples++;
          }
          if (elapsed >= warmup + capture) {
            frames.sort((a, b) => a - b);
            const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0;
            const avg = frames.reduce((s, v) => s + v, 0) / Math.max(1, frames.length);
            resolve({
              frames: frames.length,
              avgMs: avg,
              p25Ms: pct(0.25),
              medianMs: pct(0.5),
              p95Ms: pct(0.95),
              maxMs: frames[frames.length - 1] ?? 0,
              draws: sumDraws / Math.max(1, samples),
              peakDraws,
              tris: sumTris / Math.max(1, samples),
              lines,
              programs,
              pixelRatio: g.renderer.renderer.getPixelRatio(),
              quality: g.renderer.getQuality(),
              geometries: info.memory.geometries,
              textures: info.memory.textures,
              camAt: anchor ?? { x: c.x, y: window.__camY ?? c.y, z: c.z },
            });
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    [warmupMs, captureMs, cam],
  );
}

// ─── build sessions ────────────────────────────────────────────
async function openBuild(browser, url, session) {
  const params = sessionParams(session).join('&');
  const page = await browser.newPage({ viewport: PARKED, deviceScaleFactor: DPR });
  const cdp = await page.context().newCDPSession(page);
  page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message.slice(0, 200)}`));

  await page.addInitScript(INSTALL_GAP_SAMPLER);
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${url}/?${params}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });

  await page.evaluate(() => {
    window.__gap.worst = 0;
    window.__gap.gaps = [];
    window.__gap.start = performance.now();
    window.__gap.last = performance.now();
  });
  const joinStart = Date.now();
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 120_000 });
  const joinMs = Date.now() - joinStart;
  await page.waitForTimeout(6000); // let the streamed island build queue finish
  const joinStall = await page.evaluate(() => ({ worst: window.__gap.worst, gaps: window.__gap.gaps.slice(0, 25) }));

  await page.evaluate(() => window.__piratesBR.setBotPeace(true));
  const world = await readWorld(page);

  return { page, cdp, joinMs, joinStall, world };
}

async function park(build) {
  await build.page.setViewportSize(PARKED);
  await build.cdp.send('Emulation.setCPUThrottlingRate', { rate: PARK_THROTTLE });
}

async function activate(build) {
  await build.cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  await build.page.setViewportSize(VIEWPORT);
  await build.page.evaluate(PIN_PIXEL_RATIO);
}

/** The GPU-headless flags every measurement in this repo shares. Without
 *  --use-angle Chromium falls back to SwiftShader and grades a software
 *  rasteriser; without --disable-gpu-vsync every scene reports a flat 60fps. */
export const PROBE_BROWSER_ARGS = [
  '--use-gl=angle',
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

export { PIN_PIXEL_RATIO, INSTALL_GAP_SAMPLER, readWorld, measureScene, VIEWPORT };

// ─── main ──────────────────────────────────────────────────────
async function main() {
const browser = await chromium.launch({ headless: !HEADFUL, args: PROBE_BROWSER_ARGS });

const targets = [{ label: LABEL_A, url: URL_A }];
if (URL_B) targets.push({ label: LABEL_B, url: URL_B });

const samples = {}; // label -> scene -> [result...]
const meta = {};    // label -> { joinMs, joinStall }
for (const t of targets) { samples[t.label] = {}; meta[t.label] = { joinMs: [], joinStall: [] }; }

let sharedPlan = null;

for (const session of activeSessions) {
  const scenes = activeScenes.filter((s) => s.session === session);
  if (!QUIET) console.log(`\n── session ${session} ──`);

  const builds = [];
  for (const t of targets) {
    const b = await openBuild(browser, t.url, session);
    b.label = t.label;
    meta[t.label].joinMs.push(b.joinMs);
    meta[t.label].joinStall.push(b.joinStall);
    sharedPlan ??= planScenes(b.world);
    await park(b);
    builds.push(b);
    if (!QUIET) console.log(`  ${t.label}: joined in ${(b.joinMs / 1000).toFixed(1)}s (worst frame gap ${Math.round(b.joinStall.worst)}ms)`);
  }

  for (let rep = 1; rep <= REPEATS; rep++) {
    for (const scene of scenes) {
      for (const b of builds) {
        await activate(b);
        const r = await measureScene(b.page, sharedPlan[scene.id], { warmupMs: WARMUP_MS, captureMs: CAPTURE_MS });
        await park(b);
        (samples[b.label][scene.id] ??= []).push(r);
        if (!QUIET) {
          console.log(
            `  r${rep} ${scene.id.padEnd(16)} ${b.label.padEnd(9)} med ${r.medianMs.toFixed(2).padStart(6)}ms  ` +
            `(${(1000 / r.medianMs).toFixed(1).padStart(5)} fps)  p95 ${r.p95Ms.toFixed(1).padStart(6)}ms  ` +
            `draws ${String(Math.round(r.draws)).padStart(5)}  tris ${String(Math.round(r.tris)).padStart(7)}  progs ${r.programs}`,
          );
        }
      }
    }
  }

  for (const b of builds) await b.page.close();
}

await browser.close();

// Best repeat per scene = lowest median frame time (interference only ever
// makes frames slower, so the best repeat is the truest reading).
const best = {};
for (const label of Object.keys(samples)) {
  best[label] = {};
  for (const [scene, list] of Object.entries(samples[label])) {
    best[label][scene] = list.reduce((a, b) => (b.medianMs < a.medianMs ? b : a));
  }
}

const report = {
  at: new Date().toISOString(),
  quality: QUALITY,
  repeats: REPEATS,
  warmupMs: WARMUP_MS,
  captureMs: CAPTURE_MS,
  cpuThrottle: CPU_THROTTLE,
  dpr: DPR,
  targets,
  best,
  meta,
  samples,
};

// ─── table ─────────────────────────────────────────────────────
const labels = targets.map((t) => t.label);
const w = (s, n) => String(s).padEnd(n);
const p = (s, n) => String(s).padStart(n);
console.log('');
if (labels.length === 2) {
  const [A, B] = labels;
  console.log(`| ${w('scene', 17)} | ${p(`${A} fps`, 11)} | ${p(`${B} fps`, 13)} | ${p('Δ fps', 8)} | ${p(`${A} p95`, 10)} | ${p(`${B} p95`, 12)} | ${p(`${A} draws`, 11)} | ${p(`${B} draws`, 13)} |`);
  console.log(`|${'-'.repeat(19)}|${'-'.repeat(13)}|${'-'.repeat(15)}|${'-'.repeat(10)}|${'-'.repeat(12)}|${'-'.repeat(14)}|${'-'.repeat(13)}|${'-'.repeat(15)}|`);
  for (const scene of activeScenes) {
    const a = best[A]?.[scene.id];
    const b = best[B]?.[scene.id];
    if (!a || !b) continue;
    const fa = 1000 / a.medianMs, fb = 1000 / b.medianMs;
    const d = ((fa / fb - 1) * 100);
    console.log(
      `| ${w(scene.id, 17)} | ${p(fa.toFixed(1), 11)} | ${p(fb.toFixed(1), 13)} | ${p(`${d >= 0 ? '+' : ''}${d.toFixed(1)}%`, 8)} | ${p(a.p95Ms.toFixed(1), 10)} | ${p(b.p95Ms.toFixed(1), 12)} | ${p(Math.round(a.draws), 11)} | ${p(Math.round(b.draws), 13)} |`,
    );
  }
} else {
  const A = labels[0];
  for (const scene of activeScenes) {
    const a = best[A]?.[scene.id];
    if (!a) continue;
    console.log(
      `  ${w(scene.id, 17)} ${p((1000 / a.medianMs).toFixed(1), 7)} fps  med ${a.medianMs.toFixed(2)}ms  p95 ${a.p95Ms.toFixed(1)}ms  draws ${Math.round(a.draws)}  tris ${Math.round(a.tris)}  progs ${a.programs}`,
    );
  }
}
console.log('');
for (const label of labels) {
  const m = meta[label];
  console.log(`  ${label}: join ${m.joinMs.map((v) => (v / 1000).toFixed(1) + 's').join(', ')} | worst join frame gap ${m.joinStall.map((s) => Math.round(s.worst) + 'ms').join(', ')}`);
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);
}
}

// Importable: scripts/test-perf-budget.mjs reuses the scene plan and the
// measurement loop, and must not launch a browser just by importing this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
