#!/usr/bin/env node
// WHICH NODE IS PAYING — one level below perf-census.
//
// The census says a view costs 2588 draws and that 864 of them are "(scene
// child)" and ~200 apiece belong to five islands nobody is looking at. Neither
// figure names anything a person can go and change. This walks the same settled
// scene and reports, for the view it is given:
//
//   * every direct child of the scene, and of `environment`, with its visible
//     in-frustum draw calls — so the unattributed bulk gets a name;
//   * per island: its EDGE distance from the camera, its tier flags, and the
//     draw calls of every direct child of its detail root — so "a distant island
//     costs 200 draws" becomes a list of the specific dressing that is still on.
//
// One page, one join, one scene at a time. Counts only; nothing here is timed.
//
//   PIRATES_GL=swiftshader node scripts/perf-attribution.mjs --scene open-sea
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';
import { PIN_PIXEL_RATIO, planScenes, readWorld, measureScene, sessionQuery } from '../perf-probe.mjs';
import { FIND_WATERFALL_ISLAND, planWaterfallDeck, TALLY_TRAVERSAL } from '../lib/perf-scenes.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg('url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const QUALITY = arg('quality', 'high');
const OUT = arg('out', null);
const SCENES = (arg('scenes', 'dock-vista,open-sea')).split(',').map((s) => s.trim()).filter(Boolean);
/**
 * WHICH COST THE REPORT IS ORDERED BY.
 *
 * This rig was written to chase draw CALLS, so every list in it sorted by calls
 * and then cut the tail off — and the triangle column it was already computing
 * could not be read, because the rows that carry the triangles are not the rows
 * that carry the calls. One `props-palm_a` batch is ONE call and 40-58k
 * triangles; it sorted below a pier that is four calls and nine hundred. A
 * geometry pass reading this report saw the pier.
 */
const ORDER_BY = arg('by', 'calls') === 'tris' ? 'tris' : 'calls';
/** How many rows of each list survive. Deeper than the call report needed:
 *  a triangle tail is long and flat, and the point is to find all of it. */
const ROWS = Number.parseInt(arg('rows', '26'), 10);
const VIEWPORT = { width: 960, height: 540 };

/** Visible, in-frustum draw calls under a subtree, attributed to each of its
 *  DIRECT children. Same frustum arithmetic the census uses. */
const DEEP_TALLY = ({ by, rows }) => {
  const g = window.__piratesBR;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

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

  const inFrustum = (mesh) => {
    const geo = mesh.geometry;
    if (!geo) return true;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (!bs) return true;
    const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
    const el = mesh.matrixWorld.elements;
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

  /** [calls, meshes, triangles] drawn under `node`, honouring visibility. */
  const cost = (node) => {
    let calls = 0; let meshes = 0; let tris = 0;
    const walk = (n) => {
      if (!n.visible) return;
      if (n.isMesh || n.isPoints || n.isLine || n.isSprite) {
        if (n.frustumCulled === false || inFrustum(n)) {
          const groups = n.geometry?.groups ?? [];
          const c = Array.isArray(n.material) && groups.length > 0 ? groups.length : 1;
          calls += c;
          meshes += 1;
          const geo = n.geometry;
          const count = geo?.index ? geo.index.count : (geo?.attributes?.position?.count ?? 0);
          const instances = n.isInstancedMesh ? n.count : 1;
          tris += Math.round((count / 3) * instances);
        }
      }
      for (const child of n.children) walk(child);
    };
    walk(node);
    return { calls, meshes, tris };
  };

  const label = (n) => n.name || `(${n.type})`;
  const heavier = (a, b) => b[by] - a[by];
  const listChildren = (node) => node.children
    .map((c) => ({ name: label(c), ...cost(c) }))
    .filter((r) => r.calls > 0)
    .sort(heavier);

  const camPos = camera.position;
  const dist2D = (x, z) => Math.hypot(camPos.x - x, camPos.z - z);

  // Islands: edge distance, tier flags, and what each detail root is still drawing.
  const islands = [];
  for (const [id, group] of g.islandMeshes ?? []) {
    const st = g.state.islands.find((i) => i.id === id);
    const total = cost(group);
    if (total.calls === 0) continue;
    const detailRoot = group.userData.detailRoot ?? null;
    const microRoot = group.userData.microRoot ?? null;
    const radius = st?.radius ?? 0;
    islands.push({
      id,
      name: st?.name ?? id,
      edgeDist: Math.round(dist2D(group.position.x, group.position.z) - radius),
      calls: total.calls,
      tris: total.tris,
      detailVisible: detailRoot ? detailRoot.visible : null,
      microVisible: microRoot ? microRoot.visible : null,
      children: detailRoot ? listChildren(detailRoot).slice(0, rows) : [],
    });
  }
  islands.sort(heavier);

  // The scene's own top level, and whatever unnamed group holds the world.
  const sceneChildren = scene.children
    .map((c) => ({ node: c, name: label(c), ...cost(c) }))
    .filter((r) => r.calls > 0)
    .sort(heavier);
  const environment = sceneChildren.find((r) => r.node.children.some((c) => c.name?.startsWith?.('island-')))
    ?? sceneChildren[0];
  const environmentChildren = environment
    ? environment.node.children
      .filter((c) => !c.name?.startsWith?.('island-'))
      .map((c) => ({ name: label(c), ...cost(c) }))
      .filter((r) => r.calls > 0)
      .sort(heavier)
      .slice(0, rows)
    : [];

  return {
    scene: sceneChildren.map(({ name, calls, meshes, tris }) => ({ name, calls, meshes, tris })),
    environment: environmentChildren,
    islands,
    camera: { x: Math.round(camPos.x), y: Math.round(camPos.y), z: Math.round(camPos.z) },
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Draw attribution — GL: ${describeGl()}`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const report = { at: new Date().toISOString(), quality: QUALITY, scenes: {} };
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 240)}`));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await sleep(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    const plan = planScenes(await readWorld(page));
    const waterfall = await page.evaluate(FIND_WATERFALL_ISLAND);
    if (waterfall) plan['waterfall-deck'] = planWaterfallDeck(waterfall);

    for (const scene of SCENES) {
      if (!plan[scene]) { console.log(`  ${scene}: (no placement)`); continue; }
      await page.evaluate(PIN_PIXEL_RATIO);
      await measureScene(page, plan[scene], { warmupMs: 300, captureMs: 300, settle: true });
      const deep = await page.evaluate(DEEP_TALLY, { by: ORDER_BY, rows: ROWS });
      const walk = await page.evaluate(TALLY_TRAVERSAL).catch(() => null);
      deep.traversal = walk;
      report.scenes[scene] = deep;

      console.log(`\n── ${scene}  (camera ${deep.camera.x}, ${deep.camera.y}, ${deep.camera.z})`);
      if (deep.traversal) {
        const t = deep.traversal;
        console.log(
          `  traversal: three reaches ${t.total.reached} nodes (${t.total.drawables} drawable, `
          + `${t.total.drawn} drawn) of ${t.inGraph} drawables in the graph`,
        );
        console.log(
          `             ${t.outsideIslands} island group(s) wholly outside the frustum cost `
          + `${t.outsideReached} of those reached nodes and ${t.outsideDrawn} drawn`,
        );
      }
      console.log('  scene top level:');
      for (const r of deep.scene) console.log(`    ${String(r.calls).padStart(5)} calls  ${String(Math.round(r.tris / 1000)).padStart(5)}k tris  ${r.name}`);
      console.log('  environment children (islands excluded):');
      for (const r of deep.environment) console.log(`    ${String(r.calls).padStart(5)} calls  ${String(Math.round(r.tris / 1000)).padStart(5)}k tris  ${r.name}`);
      console.log('  islands:');
      for (const isl of deep.islands) {
        console.log(`    ${String(isl.calls).padStart(5)} calls  ${String(Math.round(isl.tris / 1000)).padStart(5)}k tris  ${isl.name}  edge ${isl.edgeDist}m  detail=${isl.detailVisible} micro=${isl.microVisible}`);
        for (const c of isl.children) console.log(`        ${String(c.calls).padStart(5)}  ${String(Math.round(c.tris / 1000)).padStart(5)}k  ${c.name}`);
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
