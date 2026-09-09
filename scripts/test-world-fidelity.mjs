#!/usr/bin/env node
// THE WORLD IS GRADED ON WHAT IT LOOKS LIKE, NOT ON WHETHER A FILE APPEARED.
//
// This suite used to open http://127.0.0.1:3000 when nothing told it otherwise
// — the port a human plays on, proxying to the human's :8090 server — join a
// Solo match there, and grade every screenshot with `png.length > 20000`. A PNG
// of a grey rectangle is 20 KB. It ran only quality=high, on a world nobody had
// pinned, and it could not fail on the lattice and moiré it is named for; both
// were plainly visible in the shots it saved and it passed anyway.
//
// It now:
//   • defaults to the runner's OWN stack (:3101 / :8091) and REFUSES 3000/8090;
//   • runs the low tier as well as high, because the north star is a coherent
//     picture on a weak machine, not only on the tier nobody ships to;
//   • grades COHERENCE with a real metric (scripts/lib/coherence.mjs): the peak
//     normalised autocorrelation of a high-passed ground patch and of an
//     open-sea patch seen from altitude. A regular knit or a swell interference
//     grid correlates with a shifted copy of itself; broken-up detail does not;
//   • grades draw calls and triangles per tier per view, so "coherent" can never
//     be bought by spending the low tier's frame budget.
//
// RED ON 7ab30e09 (Astra's pass as reviewed, before the I.4 fixes), swiftshader,
// seed 20260801, high tier:
//   high  understory   ground spectral peak median 18.6  (ceiling 15.0)
//   high  bay-and-cays  open-sea contrast      0.099  (ceiling 0.085)
// A cliff face in the same frame (peak-bridge, same patch grid) reads 10.2 and
// the low tier's ground reads 12.6, so the ceiling sits between a lattice and
// real rock rather than at a round number. NOTE the low tier first measured
// 30.0 and that number was WRONG: the frame governor had dropped the render
// scale and the upscale's near-Nyquist comb was being graded, not the world.
// Captures now pin the pixel ratio and the metric ignores bins finer than 3 px.
// Those are the hex knit in the grass and the rhombus grid on the open sea the
// I.3 review photographed. The same metric on surfaces that are NOT defective
// reads 10.3 (the bridge's rock face, same grid, same shot) and 7.9 (water at
// eye level), so the ground ceiling sits between a lattice and a cliff rather
// than at an arbitrary round number.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';
import { surfaceScore, textureRms, shelfStep, GROUND_GRID, WATER_GRID } from './lib/coherence.mjs';
import { sessionQuery } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';

// The runner's client. NEVER the developer's :3000 — that one proxies to the
// :8090 server he is playing on, so a "test" would join his match, roll an
// unpinned world, and grade ceilings against a map nobody measured.
const DEFAULT_URL = 'http://127.0.0.1:3101';
const url = (process.env.PIRATES_BR_URL ?? DEFAULT_URL).replace(/\/$/, '');
const clientPort = new URL(url).port;
if (clientPort === '3000' || clientPort === '8090' || clientPort === '8080') {
  throw new Error(`world-fidelity refuses ${url}: 3000/8090 belong to the human at this machine, 8080 corrupts websockets here. `
    + `Boot the runner's stack (server :8091 seed 20260801, vite :3101) and set PIRATES_BR_URL=${DEFAULT_URL}.`);
}
if ((process.env.PIRATES_BR_SERVER_PORT ?? '') === '8090') {
  throw new Error('world-fidelity refuses PIRATES_BR_SERVER_PORT=8090 (the human\'s server).');
}

// Coherence ceilings. TIGHTEN ONLY — a lane that raises one says so in its
// commit and re-runs the mutation proof (PLAN §7).
// GROUND is graded on the spectral peak: it is stable to a tenth across runs
// (11.4, 11.5, 11.8, 12.2 at high; 8.5-9.0 at low) because the camera stands on
// the same metre of the same island every time.
//
// WATER IS NOT, and pretending otherwise would be the same sin this suite was
// written to undo. Once the altitude fade lands, the open sea has little
// broadband energy left, so the whitened peak is decided by whatever transient
// is in frame — a crest, a wake, a bot hull — and the wave clock is the
// server's uptime, never twice the same. Measured across five runs: 7.9, 9.4,
// 10.4, 14.4, 20.3. The peak is PRINTED for the water and graded only on the
// ground; the water's grade is its structure contrast, which held 0.035-0.05
// across those same runs against 0.099-0.103 before the fix.
const PATTERN_MAX = { ground: 15.0 };
/** How strongly the open sea may be PATTERNED when seen from altitude. */
const WATER_CONTRAST_MAX = 0.085;
// Per-tier draw/triangle ceilings, measured on the pinned world (seed 20260801)
// after the I.4 fixes and pinned with ~20% headroom for scatter jitter. The low
// tier's numbers are the ones that matter: they are the machine the north star
// names.
const VIEW_CEILINGS = {
  high: {
    'bay-and-cays': { triangles: 2_250_000 },
    'peak-bridge': { calls: 1750, triangles: 2_900_000 },
    understory: { calls: 360, triangles: 820_000 },
    // The open-water views get NO draw ceiling, and that is a measurement, not
    // a shrug: across five runs of this rig they read 648, 718, 793, 1006 and
    // 1016 draws for the same camera on the same seed. settleLod(3) settles
    // against a frame rate a software rasteriser does not hold steady, and bot
    // hulls are still under way. A number that swings 55% cannot be a ceiling —
    // it would either pass everything or fail at random, and both are worse
    // than not grading it. Their TRIANGLES are stable (1,107k-1,190k) and are
    // graded; the two coherence views' draw counts are stable and are graded.
    'calm-water': { triangles: 1_300_000 },
    'storm-water': { triangles: 1_300_000 },
  },
  balanced: {
    'bay-and-cays': { calls: 900, triangles: 1_700_000 },
    understory: { calls: 260, triangles: 620_000 },
    'calm-water': { calls: 820, triangles: 1_000_000 },
  },
  low: {
    'bay-and-cays': { calls: 620, triangles: 900_000 },
    understory: { calls: 95, triangles: 240_000 },
    'calm-water': { calls: 290, triangles: 330_000 },
  },
};
// Which views each tier captures. The high pass is the shader-compilation pass
// and takes the lot; the cheaper tiers take the two coherence views plus water.
const TIER_VIEWS = {
  high: null,
  balanced: ['understory', 'bay-and-cays', 'calm-water', 'waterline', 'hillside'],
  low: ['understory', 'bay-and-cays', 'calm-water', 'waterline', 'hillside'],
};
// ── GRAIN, SHEETS AND SHELVES (P.1 fixup, audit r1) ─────────────────────────
// Three non-periodic defects the spectral peak is blind to, see coherence.mjs.
// GRAIN: RMS of land pixels against their 3x3 mean at the hillside stand
// (terrain 40-150 m off, land mask). RED on b96ced82 (detail octaves
// evaluated under pixel frequency): low 10.09. With every octave faded once
// its cell is under ~2 px the same stand reads 7.6 at low; the residue is
// palm fronds and silhouettes, which are edges, not grain.
const GRAIN_MAX = { low: 8.6, balanced: 9.0, high: 9.0 };
const GRAIN_REGION = { x0: 40, y0: 150, x1: 920, y1: 420 };
// SHEET: the same number on the water at the waterline stand, graded from
// BELOW (water mask) — the last 30 m of lagoon at eye level must carry ripple
// shading, not be one flat cyan plate. RED on b96ced82: low 0.35. Reading the
// shore distance and the shelf tint through the ripple field lifts it to
// 0.87 at low.
const SHEET_MIN = { low: 0.6, balanced: 0.6, high: 0.6 };
const SHEET_REGION = { x0: 100, y0: 300, x1: 860, y1: 470 };
// SHELF: the largest luminance step between adjacent rings from 1.15 to 3.2
// island radii around the bay, seen from 2.9 radii up, over the profile's
// range, on the ELLIPSE FALLBACK — PRINTED, not graded: on this stand the
// largest step sits where the island's own beach meets the water and reads
// 0.3-0.5 with or without a disc. What IS graded is the HALO: how much
// brighter the water inside 1.15-1.9 radii is than the open sea at 2.6-3.2
// radii (peak minus mean). RED on b96ced82: low 46, balanced 37, high 33 —
// the pasted cyan ellipse. With the shelf tint fading from 30 m of eye
// height onto a linear fall-off the same stand reads 30 at low.
const SHELF_HALO_MAX = 32;
const SHELF_RADII = [1.15, 1.3, 1.45, 1.6, 1.75, 1.9, 2.05, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2];
const TIERS = (process.env.WORLD_FIDELITY_TIERS ?? 'high,low').split(',').map((s) => s.trim()).filter(Boolean);
const PIN = process.env.WORLD_FIDELITY_PIN === '1'; // print measurements, grade nothing new

const out = 'test-results/nature-fidelity/live';
await mkdir(out, { recursive: true });
const client = await ensureDevClient(`${url}/`);
const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
const errors = [];
const views = [];
const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

try {
  console.log(`World fidelity — ${describeGl()} — ${url} — tiers ${TIERS.join(', ')}`);
  for (const quality of TIERS) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    try {
      page.setDefaultTimeout(300_000);
      page.on('pageerror', (e) => { errors.push(`[${quality}] ${e.message}`); console.error(e.message); });
      page.on('console', (m) => {
        if (/Shader Error|VALIDATE_STATUS|GL_INVALID|WebGL:.*error|failed to build island/i.test(m.text())) {
          errors.push(`[${quality}] ${m.text()}`); console.error(m.text());
        }
      });
      await page.goto(`${url}/?${sessionQuery(['debug', 'peace', `quality=${quality}`])}`, { waitUntil: 'domcontentloaded' });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing');
      console.log(`\n── ${quality} ──  joined a live match`);
      await page.evaluate(() => {
        const g = window.__piratesBR;
        g.setBotPeace(true);
        g.setDayNightOverride(854);
        g.setWeatherOverride(0);
        // Let the incremental build finish while looking at the sky. On software
        // GL, rasterising the dock between every 2ms atlas slice adds minutes of
        // irrelevant fill cost. The graded views below still draw the whole scene.
        g.enableFreeCam(0, 350, 0, 0, 1.3);
        document.querySelector('#oc-skip')?.click();
        if (g.debugPerfPanel) g.debugPerfPanel.style.visibility = 'hidden';
      });
      // PIN THE RENDER SCALE. The frame governor answers a slow frame by
      // dropping the pixel ratio, and under a software rasteriser it drops to
      // the floor and stays there — so every capture is an UPSCALE, and the
      // upscale's near-Nyquist comb is a lattice on every surface in the frame,
      // water included. Grading that would be grading SwiftShader.
      await page.evaluate(() => {
        const g = window.__piratesBR;
        g.renderer.setGovernorSuspended(true);
        g.renderer.applyPixelRatio(1, true);
      });
      // Grade the completed atlas, not an arbitrary number of slow software frames.
      await page.setViewportSize({ width: 320, height: 180 });
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const progress = await page.evaluate(() => {
          const g = window.__piratesBR;
          return { built: g.islandMeshes.size, islands: g.state.islands.length,
            atlasReady: g.ocean.material.uniforms.u_bathymetryReady.value >= 1,
            atlasComplete: !!g.ocean.bathymetry?.complete };
        });
        if (attempt % 6 === 0) console.log('World build:', JSON.stringify(progress));
        ready = progress.atlasComplete && progress.built === progress.islands;
        if (ready) break;
        assert.deepEqual(errors, [], 'world build/runtime errors');
        await page.waitForTimeout(5000);
      }
      assert.ok(ready, 'world and shoreline atlas failed to finish');
      // The shoreline cross-fade is deliberately not instant; let it land so the
      // captured water is the water a settled player sees.
      await page.waitForTimeout(2500);
      await page.setViewportSize({ width: 960, height: 540 });
      console.log(`PASS: [${quality}] all islands built and the shared-terrain shoreline atlas reached the GPU`);
      const plan = await page.evaluate(() => {
        const g = window.__piratesBR;
        const islands = g.state.islands;
        const bay = islands.find((i) => i.name === 'Booty Bay');
        const mountain = islands.find((i) => i.name === "Crow's Perch" && i.bridges?.length)
          ?? islands.find((i) => i.bridges?.length);
        const b = mountain.bridges[0];
        const mx = (b.ax + b.bx) / 2, mz = (b.az + b.bz) / 2;
        const span = Math.hypot(b.bx - b.ax, b.bz - b.az);
        const shrubIsland = islands.find((i) => i.props?.some((p) => p.type === 'bush'));
        const shrub = shrubIsland.props.find((p) => p.type === 'bush');
        const sx = shrub.x, sz = shrub.z;
        // The waterline stand: walk east from the bay's centre until the ground
        // drops under the sea, stand 3 m back up the beach at eye height and
        // look out over the lagoon, so the lower half of the frame is the
        // water a pirate sees from the sand.
        let shoreR = bay.radius * 0.5;
        while (shoreR < bay.radius * 1.6 && g.sampleGroundY(bay.position.x + shoreR, bay.position.z) > 0.15) shoreR += 1;
        const wx = bay.position.x + shoreR - 3, wz = bay.position.z;
        return [
          { id: 'waterline', x: wx, y: Math.max(0.2, g.sampleGroundY(wx, wz)) + 1.6, z: wz,
            target: { x: wx + 40, y: -0.2, z: wz }, grade: 'shore' },
          // The hillside stand: 55 m off the same beach at mast height, looking
          // back at the island, so the frame's middle band is terrain 40-150 m
          // away — the distance at which the detail octaves went sub-pixel.
          { id: 'hillside', x: bay.position.x + shoreR + 55, y: 7, z: bay.position.z,
            target: { x: bay.position.x + shoreR - 40, y: 9, z: bay.position.z }, grade: 'hill' },
          { id: 'bay-and-cays', x: bay.position.x, y: bay.radius * 2.9, z: bay.position.z - bay.radius * 0.7,
            target: { x: bay.position.x, y: 0, z: bay.position.z }, grade: 'water' },
          { id: 'peak-bridge', x: mx - (b.bz - b.az) / span * 26, y: Math.max(b.ay, b.by) + 14,
            z: mz + (b.bx - b.ax) / span * 26, target: { x: mx, y: (b.ay + b.by) / 2 - 1, z: mz } },
          { id: 'understory', x: sx - 1.8,
            y: Math.max(g.sampleGroundY(sx - 1.8, sz - 2.2), g.sampleGroundY(sx, sz)) + 1.0, z: sz - 2.2,
            target: { x: sx, y: g.sampleGroundY(sx, sz) + 0.45, z: sz }, grade: 'ground' },
          { id: 'calm-water', x: 310, y: 2.8, z: -220, target: { x: 470, y: -12, z: -140 } },
          { id: 'storm-water', x: 310, y: 4.5, z: -220, target: { x: 470, y: -12, z: -140 }, weather: 1 },
        ];
      });
      // The first-voyage cards can open after the initial join frame. Close them
      // after loading too, and make the capture immune to a deferred reopen.
      await page.evaluate(() => document.querySelector('#oc-skip')?.click());
      await page.addStyleTag({ content: '#hud, #onboard-cards, #minimap, #crosshair { visibility: hidden !important; }' });
      assert.equal(await page.locator('#onboard-cards').isVisible(), false, 'onboarding obscures the captured world');
      const wanted = TIER_VIEWS[quality];
      for (const cam of plan) {
        if (wanted && !wanted.includes(cam.id)) continue;
        await page.evaluate((c) => {
          const g = window.__piratesBR;
          const dx = c.target.x - c.x, dz = c.target.z - c.z;
          g.setWeatherOverride(c.weather ?? 0);
          // Weather tint alone deliberately does not relocate the real storm.
          // Use the existing storm-demo hook to exercise the storm wave geometry.
          g.debugStormDemo = (c.weather ?? 0) > 0;
          g.enableFreeCam(c.x, c.y, c.z, Math.atan2(dx, dz), Math.atan2(c.target.y - c.y, Math.hypot(dx, dz)));
          g.settleLod(3);
          // The governor is suspended, but a viewport change reapplies levers.
          g.renderer.applyPixelRatio(1, true);
        }, cam);
        const stats = await page.evaluate(() => new Promise((resolve) => {
          let frames = 0;
          const tick = () => {
            if (++frames < 5) return requestAnimationFrame(tick);
            const info = window.__piratesBR.renderer.renderer.info;
            resolve({ calls: info.render.calls, triangles: info.render.triangles, programs: info.programs.length,
              stormPhase: window.__piratesBR.ocean.material.uniforms.u_stormPhase01.value });
          };
          requestAnimationFrame(tick);
        }));
        const png = await page.screenshot({ path: `${out}/${quality}-${cam.id}.png` });
        assert.ok(png.length > 20_000, `${cam.id}: empty/flat screenshot`);
        assert.ok(stats.calls > 10 && stats.triangles > 1000, `${cam.id}: no rendered world`);
        if (cam.weather) assert.equal(stats.stormPhase, 1, 'storm view must include full storm swell, not just weather tint');

        // ── COHERENCE ──────────────────────────────────────────────────────
        let pattern = null;
        if (cam.grade === 'hill') {
          const grain = textureRms(png, GRAIN_REGION, { land: true });
          console.log(`   [${quality}] ${cam.id} grain: 3x3 high-pass rms ${grain.rms?.toFixed(2)} over ${grain.pixels} px (mean luma ${grain.meanLuma?.toFixed(0)})`);
          if (!PIN) {
            check(grain.rms !== null && grain.rms <= GRAIN_MAX[quality],
              `[${quality}] ${cam.id}: ground grain ${grain.rms?.toFixed(2)} ≤ ${GRAIN_MAX[quality]}`,
              'a detail octave is being evaluated under pixel frequency: the hillside is per-pixel speckle, not a surface');
          }
        }
        if (cam.grade === 'shore') {
          const sheet = textureRms(png, SHEET_REGION, { water: true });
          console.log(`   [${quality}] ${cam.id} sheet: 3x3 high-pass rms ${sheet.rms?.toFixed(2)} over ${sheet.pixels} px (mean luma ${sheet.meanLuma?.toFixed(0)})`);
          if (!PIN) {
            check(sheet.rms !== null && sheet.rms >= SHEET_MIN[quality],
              `[${quality}] ${cam.id}: near-shore water texture ${sheet.rms?.toFixed(2)} ≥ ${SHEET_MIN[quality]}`,
              'the lagoon at eye level is one flat plate: no ripple shading survives the shallow tint and the graze hand-over');
          }
        }
        if (cam.id === 'bay-and-cays') {
          // The shelf is graded on the ELLIPSE FALLBACK the shader paints until
          // the bathymetry atlas lands (and for good on a client whose worker
          // never does): that is the pasted cyan disc audit r1 photographed
          // from altitude. Force the uniform for one frame, capture, restore.
          await page.evaluate(() => { window.__piratesBR.ocean.material.uniforms.u_bathymetryReady.value = 0; });
          await page.waitForTimeout(400);
          const fallbackPng = await page.screenshot({ path: `${out}/${quality}-${cam.id}-fallback.png` });
          await page.evaluate(() => { window.__piratesBR.ocean.material.uniforms.u_bathymetryReady.value = 1; });
          const rings = await page.evaluate(([radii, target]) => {
            const g = window.__piratesBR;
            const camera = g.renderer.camera;
            camera.updateMatrixWorld(true);
            const R = g.state.islands.find((i) => i.name === 'Booty Bay').radius;
            const v = new g.renderer.camera.position.constructor();
            return radii.map((k) => {
              const pts = [];
              for (let a = 0; a < 16; a++) {
                const th = (a / 16) * Math.PI * 2;
                v.set(target.x + Math.cos(th) * R * k, 0, target.z + Math.sin(th) * R * k).project(camera);
                pts.push({ x: (v.x * 0.5 + 0.5) * 960, y: (0.5 - v.y * 0.5) * 540 });
              }
              return pts;
            });
          }, [SHELF_RADII, cam.target]);
          const shelf = shelfStep(fallbackPng, rings);
          const inner = shelf.means.slice(0, 6).filter((m) => m !== null);
          const outer = shelf.means.slice(-3).filter((m) => m !== null);
          const halo = inner.length && outer.length
            ? Math.max(...inner) - outer.reduce((a, b) => a + b, 0) / outer.length : null;
          console.log(`   [${quality}] ${cam.id} shelf (fallback): halo ${halo?.toFixed(1)} luma over the open sea, largest ring step ${shelf.step?.toFixed(3)} (advisory); profile ${shelf.means.map((m) => (m === null ? '-' : m.toFixed(0))).join(' ')}`);
          if (!PIN) {
            check(halo !== null && halo <= SHELF_HALO_MAX,
              `[${quality}] ${cam.id}: fallback shelf halo ${halo?.toFixed(1)} ≤ ${SHELF_HALO_MAX} luma`,
              'from altitude the island sits in a saturated tint disc: the shallow mix is at full strength at any eye height');
          }
        }
        if (cam.grade && cam.grade !== 'shore' && cam.grade !== 'hill') {
          const grid = cam.grade === 'ground' ? GROUND_GRID : WATER_GRID;
          pattern = surfaceScore(png, grid);
          console.log(`   [${quality}] ${cam.id} ${cam.grade}: spectral peak median ${pattern.peak.median} (max ${pattern.peak.max}),`
            + ` structure contrast median ${pattern.contrast.median}, ${pattern.used} patches,`
            + ` hottest bin ${JSON.stringify(pattern.worst?.lattice)}`);
          check(pattern.used >= 4, `[${quality}] ${cam.id}: at least 4 patches carry detail to grade (${pattern.used})`,
            'every patch was flat — the view is not looking at the surface it claims to grade');
          if (!PIN && pattern.used >= 4) {
            if (PATTERN_MAX[cam.grade] !== undefined) {
              check(pattern.peak.median <= PATTERN_MAX[cam.grade],
                `[${quality}] ${cam.id}: ${cam.grade} spectral peak ${pattern.peak.median} ≤ ${PATTERN_MAX[cam.grade]}`,
                'the surface repeats itself: a value-noise lattice, a tiling texture or a plaid of beating octaves');
            }
            if (cam.grade === 'water') {
              check(pattern.contrast.median <= WATER_CONTRAST_MAX,
                `[${quality}] ${cam.id}: open-sea structure contrast ${pattern.contrast.median} ≤ ${WATER_CONTRAST_MAX}`,
                'from altitude only the longest swell components survive, so this contrast IS their interference grid');
            }
          }
        }
        // ── BUDGET ───────────────────────────────────────
        const ceil = VIEW_CEILINGS[quality]?.[cam.id];
        if (ceil && !PIN) {
          if (ceil.calls) {
            check(stats.calls <= ceil.calls, `[${quality}] ${cam.id}: ${stats.calls} draws ≤ ${ceil.calls}`);
            if (stats.calls > ceil.calls) {
              // Who is drawing: visible meshes by name (an upper bound on draws,
              // no frustum), so a ceiling miss names its suspect.
              const census = await page.evaluate(() => {
                const counts = new Map();
                window.__piratesBR.renderer.scene.traverseVisible((o) => {
                  if (!o.isMesh && !o.isPoints && !o.isLine) return;
                  const key = (o.name || o.parent?.name || o.type) + (Array.isArray(o.material) ? `[x${o.material.length}]` : '');
                  counts.set(key, (counts.get(key) ?? 0) + 1);
                });
                return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
              });
              console.log(`     visible meshes by name: ${census.map(([k, n]) => `${k}=${n}`).join('  ')}`);
            }
          }
          check(stats.triangles <= ceil.triangles, `[${quality}] ${cam.id}: ${(stats.triangles / 1000).toFixed(0)}k triangles ≤ ${(ceil.triangles / 1000).toFixed(0)}k`);
        }
        views.push({ quality, ...cam, ...stats, bytes: png.length, pattern: pattern && { peak: pattern.peak, contrast: pattern.contrast, used: pattern.used } });
        console.log(`PASS: [${quality}] ${cam.id} rendered (${stats.calls} draws, ${stats.triangles} triangles)`);
      }
      assert.deepEqual(errors, [], 'runtime/shader errors');
      console.log(`PASS: [${quality}] ocean and foliage shaders compile and render without WebGL/runtime errors`);
    } finally {
      await page.close();
    }
  }
  if (PIN) console.log('\nWORLD_FIDELITY_PIN=1: measurements printed, coherence and budget ceilings NOT graded.');
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ url, tiers: TIERS, software: IS_SOFTWARE_GL, views, errors, failures }, null, 2));
  await browser.close();
  stopDevClient(client);
}
if (failures.length) { console.log(`\n${failures.length} world fidelity check(s) FAILED`); process.exit(1); }
console.log('\nWorld fidelity checks passed.');
