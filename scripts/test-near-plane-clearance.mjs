#!/usr/bin/env node
// NEAR-PLANE CLEARANCE GATE — the near plane may only be raised as far as the
// closest thing the player can actually see.
//
// Raising the near plane is the biggest lever there is on depth precision: the
// usable range of a fixed-point depth buffer is set by the near:far RATIO, and
// this game shipped 0.05:3000 — 60,000:1 — which spends most of the buffer on
// the first few metres and leaves the rest of the world resolving at ten
// centimetres a level. See scripts/test-z-fighting.mjs for what that cost.
//
// It is also the one change that can put a HOLE in the picture: everything
// nearer than the plane is clipped away. So the raise is not allowed to stand on
// a precision argument. It stands on this: at every close-quarters stand and in
// every weapon and tool state, the number of PIXELS the raise took off the
// picture, measured against the 0.05 the game shipped before — and that number
// has to be zero.
//
// The instrument is in scripts/lib/nearplane-probe.mjs, which also records the
// two wrong instruments that came before it and why an ABSOLUTE clearance
// ("what is the closest thing in frame") cannot answer this question at all.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8094 PIRATES_BR_URL=http://127.0.0.1:3104 \
//     node scripts/test-near-plane-clearance.mjs --quality low
import { chromium } from 'playwright';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { readWorld, sessionQuery, planScenes, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import { CLIP_LOSS_CENSUS } from './lib/nearplane-probe.mjs';
import { PIN_PROBE_RESOLUTION, PLACE_AND_SETTLE } from './lib/zfight-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
const VIEWPORT = { width: 960, height: 540 };

/** The near plane the game shipped before this campaign — every measurement
 *  here is "what changed against 0.05", never an absolute clearance. */
const BASELINE_NEAR = 0.05;

let failures = 0;
const fail = (label, detail = '') => {
  console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
  failures += 1;
};
const pass = (label) => console.log(`  ✓ ${label}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const waitFrames = (page, n) => page.evaluate(
  (count) => new Promise((resolve) => {
    let i = 0;
    const step = () => { if (++i >= count) resolve(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }),
  n,
);

/**
 * THE CLOSE-QUARTERS STANDS. Every one is a place where the world comes within
 * arm's reach of the eye: inside the prop scatter (a palm frond at the face), on
 * the ground (crouched, terrain filling the lower frame), inside a cave (a
 * ceiling overhead, which no collider radius bounds), on a deck between the mast
 * and the rail, and at the waterline.
 */
function planStands(world) {
  const shared = planScenes(world);
  const byName = (n) => world.islands.find((i) => i.name === n) ?? null;
  const interior = byName('Old Maw Caldera') ?? world.islands[0];
  const dockIsland = byName('Castaway Reach') ?? world.islands.find((i) => i.hasDock) ?? world.islands[0];
  const caveIsland = world.islands.find((i) => i.caves.length > 0) ?? null;
  const cave = caveIsland?.caves[0] ?? null;

  const stands = [
    { id: 'deck-aft', cam: shared['deck-aft'] },
    { id: 'shore-waterline', cam: { x: dockIsland.x + (dockIsland.radius + 26), y: 1.7, z: dockIsland.z, pitch: -0.06, aimAt: { x: dockIsland.x, z: dockIsland.z } } },
  ];

  // THE SCATTER SWEEP. A single interior stand grades whichever square metre it
  // happens to land on; the prop scatter is not uniform and the case that
  // matters is standing INSIDE something. Eight stands on a ring through the
  // dressed band, plus four crouched, and the gate is scored on the worst.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    stands.push({
      id: `scatter-${i}`,
      cam: {
        x: interior.x + Math.cos(a) * interior.radius * 0.42,
        y: null,
        z: interior.z + Math.sin(a) * interior.radius * 0.42,
        groundOffset: 1.6,
        yaw: a + Math.PI,
        pitch: -0.05,
      },
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    stands.push({
      id: `crouched-${i}`,
      cam: {
        x: interior.x + Math.cos(a) * interior.radius * 0.3,
        y: null,
        z: interior.z + Math.sin(a) * interior.radius * 0.3,
        groundOffset: 0.85,
        yaw: a,
        pitch: -0.18,
      },
    });
  }

  // THE CAVE, along its axis: the ceiling is the one surface in the game that
  // can be directly overhead with no collider radius holding the eye off it.
  if (cave) {
    for (const t of [0.15, 0.4, 0.7]) {
      stands.push({
        id: `cave-${t}`,
        cam: {
          x: cave.x - Math.sin(cave.rotation) * (cave.length * t),
          y: (cave.floorY ?? cave.y) + 1.6,
          z: cave.z - Math.cos(cave.rotation) * (cave.length * t),
          yaw: cave.rotation + Math.PI,
          pitch: 0.35, // look UP at the ceiling on purpose
        },
      });
    }
  }
  return stands.filter((s) => s.cam);
}

/** Weapon slots and tool-wheel slices, by the names the probes already use. */
const TOOLS = [
  ['spyglass', 0], ['compass', 1], ['bucket', 2], ['shovel', 7], ['lantern', 8], ['axe', 9],
];

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port:\n`
      + '  PORT=8094 PIRATES_BR_MAP_SEED=20260801 PIRATES_BR_DEV_HOOKS=1 npx tsx src/server/index.ts');
    process.exit(2);
  }
  console.log(`Near-plane clearance gate — GL: ${describeGl()}  quality=${QUALITY}  seed ${h.mapSeed ?? 'UNPINNED'}`);
  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });

  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(PIN_PROBE_RESOLUTION);

    const near = await page.evaluate(() => window.__piratesBR.renderer.camera.near);
    const far = await page.evaluate(() => window.__piratesBR.renderer.camera.far);
    console.log(`  camera near ${near}  far ${far}  ratio ${Math.round(far / near).toLocaleString()}:1\n`);

    // ── 1. the viewmodel, per weapon and per tool, at rest and aiming ─────
    //
    // THE REAL PLAYER CAMERA, not a free cam: Game hides the weapon, hands and
    // pocket roots the moment a free cam is enabled, so a detached probe grades
    // a frame with no viewmodel in it and calls the weapon safe.
    console.log('── viewmodel: pixels the raise takes off the weapon/hands ──');
    const vmReadings = [];
    const unexemptFound = [];
    const readVm = async (label) => {
      await waitFrames(page, 2);
      const r = await page.evaluate(CLIP_LOSS_CENSUS, { baselineNear: BASELINE_NEAR });
      vmReadings.push({ label, ...r });
      console.log(`    ${label.padEnd(22)} lost ${String(r.lost).padStart(6)} px  `
        + `hole ${String(r.holePixels).padStart(6)}  self-noise ${String(r.selfNoise).padStart(6)}  `
        + `nearest ${r.nearestShippedM} m (was ${r.nearestBaselineM})`);
    };
    const equipSlot = async (slot) => {
      for (let i = 0; i < 14; i++) {
        const ok = await page.evaluate((s) => {
          const g = window.__piratesBR;
          const me = g.state.players.find((p) => p.id === g.localPlayerId);
          if (me?.activeSlot === s && me?.equippedTool == null) return true;
          g.input.slotPressed = s;
          return false;
        }, slot);
        await wait(280);
        if (ok) break;
      }
      await wait(400);
      return page.evaluate(() => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        return me?.weapons?.[me.activeSlot]?.weaponId ?? null;
      });
    };
    const setAim = (on) => page.evaluate((v) => {
      const input = window.__piratesBR.input;
      input.__origIsAiming ??= input.isAiming.bind(input);
      input.isAiming = v ? () => true : input.__origIsAiming;
    }, on);

    // WHICH CAMERA-ATTACHED MESHES THE EXEMPTION DID NOT REACH. A lost pixel in
    // this section can only come from viewmodel geometry whose material never
    // went through applyViewmodelMaterialSettings, so name those directly rather
    // than inferring them from a pixel count.
    const unexempt = () => page.evaluate(() => {
      const g = window.__piratesBR;
      const camera = g.renderer.camera;
      const vm = g.viewmodel;
      camera.updateMatrixWorld(true);
      const roots = [camera, vm?.localViewWeaponRoot, vm?.localViewHandsRoot, vm?.localViewPocketRoot]
        .filter(Boolean);
      const out = [];
      const seen = new Set();
      for (const root of roots) {
        root.updateMatrixWorld(true);
        root.traverse((o) => {
          if (seen.has(o) || !o.material) return;
          seen.add(o);
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (mats.every((m) => m?.__vmNoClip)) return;
          const pos = o.geometry?.getAttribute?.('position');
          let nearest = null;
          if (pos) {
            const m = camera.matrixWorldInverse.clone().multiply(o.matrixWorld).elements;
            for (let i = 0; i < pos.count; i++) {
              const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
              const d = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
              if (d > 0 && (nearest === null || d < nearest)) nearest = d;
            }
          }
          out.push({
            name: o.name || o.type,
            visible: o.visible,
            material: mats.map((m) => m?.type).join('+'),
            nearest: nearest === null ? null : Number(nearest.toFixed(4)),
          });
        });
      }
      return out;
    });

    for (const slot of [0, 1, 2, 3]) {
      const id = await equipSlot(slot);
      if (!id) { console.log(`    slot ${slot}: empty`); continue; }
      await readVm(`${id} rest`);
      await setAim(true);
      await readVm(`${id} aiming`);
      for (const m of await unexempt()) {
        if (!m.visible) continue;
        unexemptFound.push({ state: `${id} aiming`, ...m });
        console.log(`      ! NOT EXEMPT: ${m.name} (${m.material}) nearest ${m.nearest} m`);
      }
      await setAim(false);
    }
    for (const [tool, wheelSlot] of TOOLS) {
      for (let i = 0; i < 10; i++) {
        await page.evaluate((s) => { window.__piratesBR.input.queueWheelSlot(s); }, wheelSlot);
        await wait(300);
        const got = await page.evaluate(() => window.__piratesBR.state.players
          .find((p) => p.id === window.__piratesBR.localPlayerId)?.equippedTool ?? null);
        if (got === tool) break;
      }
      await readVm(`tool ${tool}`);
      for (const m of await unexempt()) {
        if (!m.visible) continue;
        unexemptFound.push({ state: `tool ${tool}`, ...m });
        console.log(`      ! NOT EXEMPT: ${m.name} (${m.material}) nearest ${m.nearest} m`);
      }
    }
    await equipSlot(0);

    // ── 2. the world, at every close-quarters stand ───────────────────────
    console.log('\n── world: pixels the raise takes off the scene ──');
    const world = await readWorld(page);
    const stands = planStands(world);
    const worldReadings = [];
    for (const stand of stands) {
      await page.evaluate(PLACE_AND_SETTLE, { ...stand.cam, tod: 854 });
      await waitFrames(page, 2);
      const r = await page.evaluate(CLIP_LOSS_CENSUS, { baselineNear: BASELINE_NEAR });
      worldReadings.push({ id: stand.id, ...r });
      console.log(`    ${stand.id.padEnd(22)} lost ${String(r.lost).padStart(6)} px  `
        + `hole ${String(r.holePixels).padStart(6)}  self-noise ${String(r.selfNoise).padStart(6)}  `
        + `nearest ${r.nearestShippedM} m (was ${r.nearestBaselineM})  `
        + `coverage ${(r.coverage * 100).toFixed(1)}%`);
    }

    // ── 3. the assertions ─────────────────────────────────────────────────
    console.log('');
    const worst = (rows) => rows.reduce((x, y) => (y.holePixels > x.holePixels ? y : x), { holePixels: -1 });
    const all = [...vmReadings, ...worldReadings];
    const noisiest = all.reduce((x, y) => (y.selfNoise > x.selfNoise ? y : x), { selfNoise: -1 });
    if (noisiest.selfNoise > 0) {
      fail(
        'the probe is quiet: two depth passes at the SAME near plane agree everywhere',
        `worst self-noise ${noisiest.selfNoise} px at ${noisiest.id ?? noisiest.label}; `
        + 'every lost-pixel count in this run is unreliable',
      );
    } else {
      pass(`the probe is quiet: self-noise is 0 across all ${all.length} readings`);
    }

    // THE POSITIVE PROOF THAT THE VIEWMODEL CANNOT BE CLIPPED. Its clip-space z
    // is pinned, so it passes both planes by construction — but only for the
    // materials the exemption actually reached, and a weapon mesh added by a
    // path that skips applyViewmodelMaterialSettings would be cut open with
    // nothing to say so. Every visible camera-attached material must carry it.
    if (unexemptFound.length === 0) {
      pass('every visible camera-attached material carries the near-plane clip exemption');
    } else {
      const worstMissed = unexemptFound.reduce((x, y) => ((y.nearest ?? 9e9) < (x.nearest ?? 9e9) ? y : x));
      fail(
        'every visible camera-attached material carries the near-plane clip exemption',
        `${unexemptFound.length} did not — closest is ${worstMissed.name} (${worstMissed.material}) at `
        + `${worstMissed.nearest} m in "${worstMissed.state}"`,
      );
    }

    if (vmReadings.length < 4) {
      fail('the viewmodel was measured at all', `only ${vmReadings.length} weapon/tool states were reached`);
    } else {
      const w = worst(vmReadings);
      const label = `near ${near} opens no hole in the viewmodel, over ${vmReadings.length} weapon and tool states`;
      if (w.holePixels === 0) pass(label);
      else {
        fail(label, `${w.holePixels} px of hole (${w.lost} lost in all) in "${w.label}" — worst pixel at `
          + `(${w.worstAt?.x},${w.worstAt?.y}) went from ${w.worstAt?.fromM} m to ${w.worstAt?.toM} m; `
          + 'the weapon is being cut open');
      }
    }

    const covered = worldReadings.filter((r) => r.coverage > 0.02);
    if (covered.length < 10) {
      fail('the world sweep measured enough stands', `${covered.length} stands had geometry in frame`);
    } else {
      const w = worst(worldReadings);
      const totalLost = worldReadings.reduce((n, r) => n + r.lost, 0);
      const label = `near ${near} opens no hole in the world, over ${worldReadings.length} close-quarters `
        + `stands (${totalLost} px of one-pixel clip edge in total, none of it a hole)`;
      if (w.holePixels === 0) pass(label);
      else {
        fail(label, `${w.holePixels} px of hole (${w.lost} lost in all) at ${w.id} — worst pixel at `
          + `(${w.worstAt?.x},${w.worstAt?.y}) went from ${w.worstAt?.fromM} m to ${w.worstAt?.toM} m`);
      }
    }
  } finally {
    await browser.close();
    stopDevClient(client);
  }

  if (failures) {
    console.error(`\n✗ ${failures} near-plane assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nAll near-plane clearance assertions passed.');
}

await main();
