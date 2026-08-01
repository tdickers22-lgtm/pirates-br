#!/usr/bin/env node
// THE BUDGET CENSUS — every scene's COUNTS, on whatever GL backend is available.
//
// perf-probe.mjs answers "which build is faster"; this answers "what does each
// view COST", and it deliberately reports only the figures that are exact on a
// software rasteriser: draw calls, triangles, programs, and the geometry/texture
// residency out of renderer.info.memory. Those numbers come out of three's own
// bookkeeping — they are decided by the scene graph, the frustum and the LOD
// gates, none of which know or care which GL backend is underneath. Frame times
// are reported too but marked ADVISORY under SwiftShader, and nothing here
// grades them.
//
// It also reports the pixel ratio the CLIENT chose for itself, unpinned, before
// any measurement pins it — because "what tier did this machine land in and how
// many fragments is it asking for" is the other half of a budget and no draw
// count will ever show it.
//
//   PIRATES_GL=swiftshader node scripts/perf-census.mjs --url http://127.0.0.1:3000
//   node scripts/perf-census.mjs --out /tmp/census-before.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene } from './perf-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg('url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const SERVER_HEALTH_URL = arg('health', 'http://127.0.0.1:8090/health');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', null);
const LABEL = arg('label', 'HEAD');
// Small on purpose: the machine this runs on is fanless, SwiftShader is a CPU
// rasteriser, and a 16:9 viewport of any size produces the SAME frustum — so
// the counts at 960x540 are the counts at 1600x900.
const VIEWPORT = { width: 960, height: 540 };
const WARMUP_MS = parseInt(arg('warmup', IS_SOFTWARE_GL ? '2500' : '3500'), 10);
const CAPTURE_MS = parseInt(arg('capture', IS_SOFTWARE_GL ? '3500' : '3500'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch { return false; }
}

async function waitForReady(url, child, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReady(url)) return;
    if (child && child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
    await sleep(400);
  }
  throw new Error(`not ready at ${url} within ${timeoutMs}ms`);
}

function startNpmScript(scriptName) {
  return spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BROWSER: 'none' },
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
}

/** The pixel ratio, tier and shadow map the CLIENT picked for itself on this
 *  machine, read before anything pins it. */
const READ_CLIENT_TIER = () => {
  const r = window.__piratesBR?.renderer;
  if (!r) return null;
  return {
    quality: r.getQuality?.() ?? r.quality ?? null,
    devicePixelRatio: window.devicePixelRatio || 1,
    currentPixelRatio: r.currentPixelRatio ?? null,
    minPixelRatio: r.minPixelRatio ?? null,
    maxPixelRatio: r.maxPixelRatio ?? null,
    rendererPixelRatio: r.renderer?.getPixelRatio?.() ?? null,
    shadowsEnabled: r.areShadowsEnabled?.() ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    cssPixels: window.innerWidth * window.innerHeight,
    // Fragments the client is asking the GPU for, per frame, at this ratio.
    fragments: Math.round(
      window.innerWidth * window.innerHeight
      * Math.pow(r.renderer?.getPixelRatio?.() ?? 1, 2),
    ),
  };
};

/** A deck-height look at an island that actually HAS a fall on it. The July
 *  scene table has no such view, and the waterfall sheets/mist were a whole
 *  content wave that therefore never appeared in any budget. */
const FIND_WATERFALL_ISLAND = () => {
  const g = window.__piratesBR;
  for (const [id, group] of g.islandMeshes ?? []) {
    let site = null;
    group.traverse((o) => { if (!site && o.name === 'waterfall-site') site = o; });
    if (site) {
      const island = g.state.islands.find((i) => i.id === id);
      // The fall's own plunge pool, in island-local coords (WaterfallBuilder
      // bakes its geometry local and records the base in userData).
      const base = site.userData?.base ?? { x: site.position.x, z: site.position.z };
      return {
        id,
        name: island?.name ?? id,
        x: group.position.x,
        z: group.position.z,
        radius: island?.radius ?? 120,
        siteLocalX: base.x,
        siteLocalZ: base.z,
      };
    }
  }
  return null;
};

/**
 * WHERE THE DRAWS COME FROM.
 *
 * A draw-call total tells you a budget broke; it never tells you which content
 * wave broke it, and "3000 draws at deck view" is not something anyone can act
 * on. This walks the live scene the way three's renderer does — visible, in the
 * frustum, counting an InstancedMesh as the ONE call it actually is — and
 * attributes every call to the subsystem that owns it, keyed off the nearest
 * named ancestor. The keys are the node names the builders already set, so the
 * report reads as a list of modules, not of meshes.
 */
const TALLY_DRAW_SOURCES = () => {
  const g = window.__piratesBR;
  const THREE = g.renderer.THREE ?? null;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  // Frustum, built by hand so this needs no THREE import of its own.
  const m = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const e = m.elements;
  const planes = [];
  const push = (a, b, c, d) => {
    const len = Math.hypot(a, b, c) || 1;
    planes.push([a / len, b / len, c / len, d / len]);
  };
  push(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
  push(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  push(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
  push(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  push(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
  push(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);

  const bucketFor = (node) => {
    // Nearest ancestor (including self) carrying a name a builder chose.
    for (let c = node; c; c = c.parent) {
      const n = c.name;
      if (!n) continue;
      if (n.startsWith('island-') && n !== 'island-detail-root') return n;
      if (n.startsWith('waterfall-')) return 'waterfall';
      if (n.startsWith('cave')) return 'cave';
      if (n.startsWith('ship') || n.startsWith('hull')) return 'ship';
      if (n.startsWith('sea-rock')) return 'sea-rock';
      if (n === 'environment') break;
    }
    for (let c = node; c; c = c.parent) {
      if (c.parent === scene) return c.name || '(scene child)';
    }
    return '(unnamed)';
  };

  const tally = {};
  const inFrustum = (mesh) => {
    const geo = mesh.geometry;
    if (!geo) return true;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (!bs) return true;
    const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
    const s = mesh.matrixWorld;
    const el = s.elements;
    const scale = Math.sqrt(Math.max(
      el[0] * el[0] + el[1] * el[1] + el[2] * el[2],
      el[4] * el[4] + el[5] * el[5] + el[6] * el[6],
      el[8] * el[8] + el[9] * el[9] + el[10] * el[10],
    ));
    const r = bs.radius * scale;
    for (const p of planes) {
      if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r) return false;
    }
    return true;
  };

  const walk = (node) => {
    if (!node.visible) return;
    if ((node.isMesh || node.isPoints || node.isLine || node.isSprite)) {
      const drawn = node.frustumCulled === false || inFrustum(node);
      if (drawn) {
        const groups = node.geometry?.groups ?? [];
        // A multi-material mesh is one call per group; everything else is one.
        const calls = Array.isArray(node.material) && groups.length > 0 ? groups.length : 1;
        const key = bucketFor(node);
        const t = (tally[key] ??= { calls: 0, meshes: 0 });
        t.calls += calls;
        t.meshes += 1;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(scene);
  void THREE;

  return Object.entries(tally)
    .map(([source, v]) => ({ source, calls: v.calls, meshes: v.meshes }))
    .sort((a, b) => b.calls - a.calls);
};

function planWaterfallDeck(w) {
  // Stand off the fall at deck height, framed the way a player approaching under
  // sail sees it: 150m out, eye ~6m above the water, looking straight at the site.
  const sx = w.x + w.siteLocalX;
  const sz = w.z + w.siteLocalZ;
  const len = Math.hypot(sx - w.x, sz - w.z) || 1;
  const ux = (sx - w.x) / len;
  const uz = (sz - w.z) / len;
  const stand = w.radius + 150;
  return {
    x: w.x + ux * stand,
    y: 6,
    z: w.z + uz * stand,
    yaw: 0,
    pitch: -0.03,
    aimAt: { x: sx, z: sz },
  };
}

const CENSUS_SCENES = [
  { id: 'dock-vista', session: 'main', label: 'dock vista (wide)' },
  { id: 'deck-aft', session: 'main', label: 'on-deck aft look' },
  { id: 'island-interior', session: 'main', label: 'island interior eye-level' },
  { id: 'cave-interior', session: 'main', label: 'cave interior' },
  { id: 'open-sea', session: 'main', label: 'open-sea sail view' },
  { id: 'waterfall-deck', session: 'main', label: 'deck view of a waterfall island' },
  { id: 'combat-burst', session: 'combat', label: 'combat burst (cannon + keg FX)' },
  { id: 'storm-sea', session: 'storm', label: 'storm at sea (?stormdemo)' },
];

const SCENE_FILTER = arg('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const activeScenes = CENSUS_SCENES.filter((s) => !SCENE_FILTER || SCENE_FILTER.includes(s.id));

const SESSION_PARAMS = {
  main: ['debug', `quality=${QUALITY}`],
  combat: ['debug', `quality=${QUALITY}`, 'forceinput'],
  storm: ['debug', `quality=${QUALITY}`, 'stormdemo'],
};

async function main() {
  console.log(`Budget census — GL: ${describeGl()}`);
  const started = [];
  let browser;
  const rows = [];
  let tier = null;

  try {
    const hadClient = await isReady(`${URL}/`);
    const hadServer = await isReady(SERVER_HEALTH_URL);
    if (!hadClient) { const c = startNpmScript('dev:client'); started.push(c); await waitForReady(`${URL}/`, c); }
    if (!hadServer) { const s = startNpmScript('dev:server'); started.push(s); await waitForReady(SERVER_HEALTH_URL, s); }

    browser = await chromium.launch({ args: browserArgs(['--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio']) });

    // ONE PAGE AT A TIME. A session's page is closed before the next opens: two
    // live rAF loops on a fanless CPU rasteriser is exactly the concurrency this
    // repo's crash history is made of, and it would also make both sets of
    // numbers a measurement of the other page.
    const sessions = [...new Set(activeScenes.map((s) => s.session))];
    for (const session of sessions) {
      const params = SESSION_PARAMS[session].join('&');
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 300)}`));
      page.on('console', (m) => { if (m.type() === 'error') console.error(`  [console] ${m.text().slice(0, 300)}`); });
      try {
        await page.goto(`${URL}/?${params}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
        await page.click('#menu-solo-btn', { noWaitAfter: true });
        await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
        await page.waitForTimeout(12_000); // streamed island / sea-rock build queues

        if (!tier) {
          tier = await page.evaluate(READ_CLIENT_TIER);
          console.log('\n  client tier (unpinned, as this machine would run it):');
          console.log(`    quality=${tier.quality}  devicePixelRatio=${tier.devicePixelRatio}  running dPR=${tier.rendererPixelRatio}`);
          console.log(`    min/max dPR=${tier.minPixelRatio}/${tier.maxPixelRatio}  shadows=${tier.shadowsEnabled}`);
          console.log(`    cores=${tier.hardwareConcurrency} deviceMemory=${tier.deviceMemory} cssPixels=${tier.cssPixels} fragments/frame=${tier.fragments}`);
        }

        await page.evaluate(() => window.__piratesBR.setBotPeace(true));
        const plan = planScenes(await readWorld(page));
        const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
        if (waterfall) {
          plan['waterfall-deck'] = planWaterfallDeck(waterfall);
          if (session === 'main') console.log(`    waterfall island: ${waterfall.name}\n`);
        }

        for (const scene of activeScenes.filter((s) => s.session === session)) {
          if (!plan[scene.id]) { console.log(`  ${scene.id}: (no placement)`); continue; }
          await page.evaluate(PIN_PIXEL_RATIO);
          const r = await measureScene(page, plan[scene.id], { warmupMs: WARMUP_MS, captureMs: CAPTURE_MS, settle: true });
          const sources = await page.evaluate(TALLY_DRAW_SOURCES).catch(() => []);
          const row = {
            sources: sources.slice(0, 14),
            scene: scene.id,
            label: scene.label,
            draws: Math.round(r.draws),
            peakDraws: r.peakDraws,
            tris: Math.round(r.tris),
            programs: r.programs,
            geometries: r.geometries,
            textures: r.textures,
            frames: r.frames,
            medianMs: r.medianMs,
            pixelRatio: r.pixelRatio,
          };
          rows.push(row);
          console.log(
            `  ${scene.id.padEnd(17)} draws ${String(row.draws).padStart(5)} (peak ${String(row.peakDraws).padStart(5)})  `
            + `tris ${String(Math.round(row.tris / 1000)).padStart(5)}k  progs ${String(row.programs).padStart(3)}  `
            + `geos ${String(row.geometries).padStart(5)}  texs ${String(row.textures).padStart(4)}  `
            + `[${row.frames} frames, med ${row.medianMs.toFixed(0)}ms${IS_SOFTWARE_GL ? ' ADVISORY' : ''}]`,
          );
          if (row.sources.length > 0) {
            console.log(`      by source: ${row.sources.slice(0, 9).map((s) => `${s.source}=${s.calls}`).join('  ')}`);
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    for (const c of started.reverse()) { stopChild(c); await sleep(900); try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* gone */ } }
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), label: LABEL, quality: QUALITY, gl: describeGl(), tier, rows }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
