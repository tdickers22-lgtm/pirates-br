#!/usr/bin/env node
// THE GEOMETRY GATES — the tripwires the draw-call budget cannot be.
//
// WHY THIS SUITE HAD TO EXIST. test-perf-budget grades a scene's TOTAL draws and
// triangles against a ceiling roughly 1.12x its measurement. That is the right
// shape for catching a content wave, and it is useless for catching the removal
// of a single geometry lever: the levers in this pass are each worth 1-5% of a
// frame. Deleting all three of them at once — the pebble ramp, the portal-rock
// thinning and the ocean's outer ring — puts about 104k triangles back on a
// dock vista that measures 1,784k, which is 5.8%, comfortably inside a 12%
// margin. A ceiling that a regression cannot fail is not guarding anything, and
// tightening the frame ceiling to 1.06 to catch it would put it inside the
// scene's own run-to-run spread and fail honest builds instead.
//
// So each lever gets a tripwire ON ITSELF, where the signal is not diluted by
// two million triangles of everything else:
//
//   1. THE OCEAN GRID IS AN EXACT NUMBER. Its triangle count is a pure function
//      of the LOD table — 24,608 / 44,448 / 177,792 — so it is asserted exactly,
//      not against a ceiling. Any edit to a cell size, a half-extent or a hole
//      fails this line and has to come and say so here.
//   2. PEBBLES REACH ZERO AND COME BACK. Empty and out of the render list at
//      range, whole and visible up close. This is the one ramp that ends at zero
//      and the one that can therefore leave a batch stranded invisible.
//   3. THE PORTAL FRAME THINS FROM THE BOTTOM. Whole up close; thinner at range;
//      and its scales still SORTED DESCENDING, which is the invariant the whole
//      scheme rests on — an unsorted batch silently drops the wrong stones and
//      no picture of it at a kilometre would show which.
//   4. THE GROUP CULL IS SOUND, NOT JUST EFFECTIVE. Looking away from the
//      archipelago, groups go invisible; and — the half that matters — NO group
//      whose bounding sphere is inside the view frustum is ever invisible. The
//      second assertion is the one that would catch a cull that is too eager,
//      which is the only way this lever can hurt anyone.
//
// Counts and flags only. Nothing here is timed, so it grades identically on the
// software rasteriser.
//
//   PIRATES_BR_SERVER_PORT=8091 node scripts/test-geometry-lod.mjs
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { SERVER_PORT, sessionQuery } from './perf-probe.mjs';

const ROOT_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/').replace(/\/$/, '');
const SERVER_HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL
  ?? `http://127.0.0.1:${SERVER_PORT ?? '8090'}/health`;
const VIEWPORT = { width: 960, height: 540 };
const READY_TIMEOUT_MS = 45_000;

/**
 * The whole `ocean-lod-grid` group, counted from the LOD table rather than
 * measured: 24,608 / 44,448 / 177,792 triangles of concentric rings, plus the
 * TWO of the deep-water underlayer — a single 2400m quad parked at -6.5m to hide
 * sub-pixel T-junction cracks at the LOD seams. It is in the total because it is
 * in the group, and a reading that quietly excluded it would drift the day
 * somebody tessellated it.
 *
 * Kept here as literals on purpose: a test that recomputes the number from the
 * same table the code uses cannot fail when the table changes, which is the only
 * failure this line exists to produce.
 */
const OCEAN_GRID_TRIANGLES = { low: 24_610, balanced: 44_450, high: 177_794 };

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) });
    return res.ok;
  } catch { return false; }
}

async function waitForReady(url, child) {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await isReady(url)) return;
    if (child && child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
    await sleep(350);
  }
  throw new Error(`not ready at ${url} within ${READY_TIMEOUT_MS}ms`);
}

function startNpmScript(scriptName) {
  return spawn('npm', ['run', scriptName], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      BROWSER: 'none',
      ...(SERVER_PORT ? { PORT: String(SERVER_PORT) } : {}),
    },
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* gone */ } }
}

/** Place the free camera and drive the world to its settled state — the same
 *  two-pass settle the budget census uses, for the same reason: a count taken
 *  mid-reveal is a lie in the cheap direction. */
const PLACE = async (page, stand) => {
  await page.evaluate((c) => {
    const g = window.__piratesBR;
    const yaw = Math.atan2(c.ax - c.x, c.az - c.z);
    g.enableFreeCam(c.x, c.y, c.z, yaw, -0.06);
    g.settleLod?.();
  }, stand);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__piratesBR.settleLod?.());
  await page.waitForTimeout(400);
};

/** Every instance-LOD batch of a named type on a named island, plus the island's
 *  edge distance, read straight off the live scene. */
const READ_BATCHES = ([islandName, batchName]) => {
  const g = window.__piratesBR;
  const island = g.state.islands.find((i) => i.name === islandName);
  if (!island) return null;
  const group = g.islandMeshes.get(island.id);
  if (!group) return null;
  const cam = g.renderer.camera.position;
  const out = [];
  // How many meshes of this name EXIST, counted off the graph — so "there is no
  // batch here" and "the batch here was never registered" are different answers.
  // They were the same answer once, and under mutation the second one skipped
  // the contract it was supposed to fail.
  let meshes = 0;
  group.traverse((o) => { if (o.name === batchName) meshes += 1; });
  for (const batch of group.userData.instanceLodBatches ?? []) {
    if (batch.mesh.name !== batchName) continue;
    let sorted = true;
    for (let i = 1; i < batch.scales.length; i++) {
      if (batch.scales[i] > batch.scales[i - 1] + 1e-6) { sorted = false; break; }
    }
    out.push({
      count: batch.mesh.count,
      full: batch.full,
      visible: batch.mesh.visible,
      hidden: batch.hidden,
      scaleCount: batch.scales.length,
      sorted,
    });
  }
  return {
    edgeDist: Math.round(Math.hypot(cam.x - island.position.x, cam.z - island.position.z) - island.radius),
    detailVisible: group.userData.detailRoot?.visible ?? null,
    meshes,
    batches: out,
  };
};

/** Triangles the ocean grid is submitting this frame, and every island group's
 *  cull verdict measured against the frustum the renderer is about to use. */
const READ_SCENE = () => {
  const g = window.__piratesBR;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  let oceanTris = 0;
  scene.traverse((o) => {
    if (o.name !== 'ocean-lod-grid') return;
    o.traverse((m) => {
      if (!m.isMesh || !m.visible) return;
      const geo = m.geometry;
      const count = geo?.index ? geo.index.count : (geo?.attributes?.position?.count ?? 0);
      oceanTris += Math.round(count / 3);
    });
  });

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
  const inside = (s) => planes.every((p) => p[0] * s.x + p[1] * s.y + p[2] * s.z + p[3] >= -s.r);

  let culled = 0; let groups = 0; let wronglyCulled = 0; const wrongNames = [];
  for (const [id, group] of g.islandMeshes ?? []) {
    groups += 1;
    if (group.visible) continue;
    // An island built THIS frame is held hidden until the next drain releases
    // it, and that is not a cull. Without this line the suite reports a
    // correctness failure whenever a build lands on the frame it samples — a
    // flake that would eventually be "fixed" by deleting the assertion that
    // matters most here.
    if (!group.userData.cullSphere) continue;
    culled += 1;
    const sphere = group.userData.cullSphere;
    // The sphere the cull tested is padded for the shadow pass; test the BARE
    // one here, so a group that is invisible while any part of it is in frame
    // is a failure no matter how the padding is tuned.
    if (sphere && inside(sphere)) {
      wronglyCulled += 1;
      wrongNames.push(g.state.islands.find((i) => i.id === id)?.name ?? id);
    }
  }
  return { oceanTris, culled, groups, wronglyCulled, wrongNames };
};

/** A stand-off point on the bearing from the archipelago's centre to `island`,
 *  `metres` clear of its footprint — so "far" is far from THIS island rather
 *  than far from the origin. */
const PLAN_STAND = ([islandName, metres]) => {
  const g = window.__piratesBR;
  const island = g.state.islands.find((i) => i.name === islandName);
  if (!island) return null;
  let cx = 0; let cz = 0;
  for (const i of g.state.islands) { cx += i.position.x; cz += i.position.z; }
  cx /= g.state.islands.length; cz /= g.state.islands.length;
  let dx = island.position.x - cx; let dz = island.position.z - cz;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const stand = island.radius + metres;
  return {
    x: island.position.x + dx * stand,
    y: 14,
    z: island.position.z + dz * stand,
    ax: island.position.x,
    az: island.position.z,
    // …and the point diametrically opposite the island, for the turn-away shot.
    awayX: island.position.x + dx * (stand + 4000),
    awayZ: island.position.z + dz * (stand + 4000),
  };
};

async function run(browser, quality) {
  console.log(`\n── quality=${quality}`);
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${ROOT_URL}/?${sessionQuery(['debug', `quality=${quality}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 40_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await page.waitForTimeout(12_000);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));

    // The island under test is whichever one carries a cave portal, since two of
    // the four contracts are about the portal frame. Pebbles exist only on
    // full-detail islands, which is a build-time decision, so the batch
    // assertions below are skipped rather than failed where there are none.
    // THE SUBJECT IS CHOSEN OFF THE SCENE GRAPH, NOT OFF THE REGISTRY. Picking
    // the island whose `instanceLodBatches` contains a portal frame is picking
    // it off the exact list the contract is about: delete the registration and
    // this search finds nothing, falls through to some other island, and the
    // suite reports a missing batch on an island that never had one instead of a
    // broken lever on the island that did. Watched happening, under mutation.
    // The mesh NAME is in the graph whether or not anything registered it.
    const subject = await page.evaluate(() => {
      const g = window.__piratesBR;
      for (const island of g.state.islands) {
        const group = g.islandMeshes.get(island.id);
        if (!group) continue;
        let found = false;
        group.traverse((o) => { if (o.name === 'cave-portal-rock') found = true; });
        if (found) return island.name;
      }
      return null;
    });
    expect(`[${quality}] found an island carrying a cave portal to grade`, !!subject, 'no island had a cave-portal-rock mesh in its subtree');
    if (!subject) return;
    console.log(`     subject island: ${subject}`);

    // ── close in ───────────────────────────────────────────────────────────
    const near = await page.evaluate(PLAN_STAND, [subject, 30]);
    await PLACE(page, near);
    const nearScene = await page.evaluate(READ_SCENE);
    const nearPortal = await page.evaluate(READ_BATCHES, [subject, 'cave-portal-rock']);
    const nearPebbles = await page.evaluate(READ_BATCHES, [subject, 'island-pebbles']);

    expect(
      `[${quality}] the ocean grid submits exactly ${OCEAN_GRID_TRIANGLES[quality]} triangles`,
      nearScene.oceanTris === OCEAN_GRID_TRIANGLES[quality],
      `submitted ${nearScene.oceanTris}; the LOD table in OceanRenderer decides this number exactly`,
    );
    expect(
      `[${quality}] no island group is culled while its bounding sphere is in frame`,
      nearScene.wronglyCulled === 0,
      `culled in frame: ${nearScene.wrongNames.join(', ')}`,
    );
    expect(
      `[${quality}] every portal-frame mesh on ${subject} is registered for instance LOD`,
      nearPortal.meshes > 0 && nearPortal.batches.length === nearPortal.meshes,
      `${nearPortal.meshes} cave-portal-rock mesh(es) in the graph, ${nearPortal.batches.length} registered`,
    );
    expect(
      `[${quality}] the portal frame is whole at ${nearPortal.edgeDist}m`,
      nearPortal.batches.length > 0 && nearPortal.batches.every((b) => b.count === b.full && b.visible),
      JSON.stringify(nearPortal.batches),
    );
    expect(
      `[${quality}] every portal batch's scales are sorted descending`,
      nearPortal.batches.every((b) => b.sorted && b.scaleCount === b.full),
      'an unsorted batch drops the wrong stones and nothing downstream can tell',
    );
    expect(
      `[${quality}] every pebble mesh on ${subject} is registered for instance LOD`,
      nearPebbles.batches.length === nearPebbles.meshes,
      `${nearPebbles.meshes} island-pebbles mesh(es) in the graph, ${nearPebbles.batches.length} registered`,
    );
    if (nearPebbles.batches.length > 0) {
      expect(
        `[${quality}] pebbles are whole and drawn at ${nearPebbles.edgeDist}m`,
        nearPebbles.batches.every((b) => b.count === b.full && b.visible && !b.hidden),
        JSON.stringify(nearPebbles.batches),
      );
    } else {
      console.log(
        nearPebbles.meshes > 0
          ? `  – [${quality}] ${subject}'s ${nearPebbles.meshes} pebble mesh(es) are UNREGISTERED (see the failure above); range contracts skipped`
          : `  – [${quality}] ${subject} carries no pebble mesh at all (built lowDetail); pebble contracts skipped`,
      );
    }

    // ── stand off ──────────────────────────────────────────────────────────
    const far = await page.evaluate(PLAN_STAND, [subject, 820]);
    await PLACE(page, far);
    const farPortal = await page.evaluate(READ_BATCHES, [subject, 'cave-portal-rock']);
    const farPebbles = await page.evaluate(READ_BATCHES, [subject, 'island-pebbles']);

    // At 'low' the detail radius is 420m, so at 820m the island is on its proxy
    // and the LOD pass does not run on it at all — there is nothing to thin and
    // nothing to assert. That is the tier working, not the contract failing.
    if (farPortal.detailVisible) {
      expect(
        `[${quality}] the portal frame is thinner at ${farPortal.edgeDist}m than at ${nearPortal.edgeDist}m`,
        farPortal.batches.some((b) => b.count < b.full),
        `${JSON.stringify(farPortal.batches)} — the pixel floor's threshold out here is a 1.5m stone`,
      );
      if (farPebbles.batches.length > 0) {
        expect(
          `[${quality}] pebbles are empty AND out of the render list at ${farPebbles.edgeDist}m`,
          farPebbles.batches.every((b) => b.count === 0 && !b.visible && b.hidden),
          JSON.stringify(farPebbles.batches),
        );
      }
    } else {
      console.log(`  – [${quality}] ${subject} is on its proxy at ${farPortal.edgeDist}m; range contracts skipped`);
    }

    // ── turn away ──────────────────────────────────────────────────────────
    await PLACE(page, { x: far.x, y: far.y, z: far.z, ax: far.awayX, az: far.awayZ });
    const away = await page.evaluate(READ_SCENE);
    expect(
      `[${quality}] looking away from the archipelago culls island groups outright`,
      away.culled > 0,
      `${away.culled} of ${away.groups} groups invisible — the group cull is not firing at all`,
    );
    expect(
      `[${quality}] …and still culls nothing whose bounding sphere is in frame`,
      away.wronglyCulled === 0,
      `culled in frame: ${away.wrongNames.join(', ')}`,
    );
    console.log(`     culled ${away.culled}/${away.groups} groups looking away`);

    expect(`[${quality}] no page errors`, errors.length === 0, errors.join('\n'));
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  console.log(`Geometry LOD gates — GL: ${describeGl()}`);
  let browser;
  try {
    browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  } catch (error) {
    console.log(`  – skipped: could not launch a browser (${error?.message ?? error})`);
    return;
  }
  const started = [];
  try {
    if (!await isReady(ROOT_URL)) {
      const c = startNpmScript('dev:client');
      started.push(c);
      await waitForReady(ROOT_URL, c);
    }
    if (!await isReady(SERVER_HEALTH_URL)) {
      const s = startNpmScript('dev:server');
      started.push(s);
      await waitForReady(SERVER_HEALTH_URL, s);
    }
    // ONE page at a time — two live rAF loops on a CPU rasteriser is exactly the
    // concurrency this repo's crash history is made of.
    await run(browser, 'high');
    await run(browser, 'low');
  } finally {
    await browser.close().catch(() => {});
    for (const c of started.reverse()) {
      stopChild(c);
      await sleep(900);
      try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
  if (failures > 0) process.exit(1);
  console.log('\nGeometry LOD gates passed.');
}

main().catch((error) => { console.error(error?.stack ?? error); process.exit(1); });
