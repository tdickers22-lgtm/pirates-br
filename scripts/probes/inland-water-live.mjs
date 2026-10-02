// PROBE (b4.7a2): the inland water, live. Run from the repo root:
//   node scripts/probes/inland-water-live.mjs [outDir]
//
// What the logic gate (scripts/test-inland-water.mjs) cannot see, because it
// reads shared functions and source text, not a rendered world:
//   1. PROGRAMS. The inland water is handed the waterfall material, so it must
//      add 0 programs. Measured as renderer.compile(scene) with every
//      'inland-water' mesh hidden vs shown (expect +0), plus program identity:
//      the inland mesh's currentProgram must be the waterfall water's own.
//      Falsifiable in the same run: a clone of the material with one extra
//      define is compiled and must read +1, or the census is blind.
//   2. FLOATERS. Every BOUNDARY edge vertex of every 'inland-water' mesh (the
//      ribbon edges, the outer ring of each pond and tide-pool disc) against
//      the rendered terrain under it. A boundary vertex more than LIMIT over
//      the ground is a sheet of water hanging in the air at a bank. Vertices
//      over the sea (ground < 0) are counted apart: the sea covers them.
//   3. PIXELS. Aerial + waterline PNGs of Smuggler's Rest (spring valley,
//      delta), the Old Maw crater lake and the Skull Cove tide shelves.
//
// Machine protection: ONE headless SwiftShader Chromium at 960x540, its own
// stack on 3101/8091 (seed 20260801), everything killed in finally.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/inland-water-live';
const LIMIT = Number(process.env.INLAND_FLOAT_LIMIT ?? 0.25);
const SERVER_PORT = '8091';
const CLIENT_PORT = '3101';
const BASE = `http://127.0.0.1:${CLIENT_PORT}`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; }
}
const kids = [];
async function start(name, cmd, url, env) {
  if (await up(url)) throw new Error(`${url} already answering: refusing to grade someone else's stack`);
  const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  kids.push(child);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    if (await up(url)) { console.log(`  ${name} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`); return; }
    if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}`);
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url}`);
}
function stopAll() {
  for (const c of kids.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } } }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });

let browser = null;
const shots = [];
let report = null;
let fail = [];
try {
  console.log(`inland-water live probe, ${describeGl()}`);
  await start('server', 'npm run dev:server', `http://127.0.0.1:${SERVER_PORT}/health`, {
    PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV_HOOKS: '1',
  });
  await start('client', `npx vite --port ${CLIENT_PORT} --strictPort`, BASE, { PIRATES_BR_SERVER_PORT: SERVER_PORT, BROWSER: 'none' });

  browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e}`));
  await page.routeWebSocket((u) => new URL(u).host === new URL(BASE).host, () => {});
  await page.goto(`${BASE}/?debug&quality=high`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 180_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const e = document.createElement('style');
    e.textContent = '#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}#hud{visibility:hidden!important;}'
      + '#disconnect-overlay,[class*="overload"]{visibility:hidden!important;}';
    document.head.appendChild(e);
    document.getElementById('oc-skip')?.click();
    const g = window.__piratesBR;
    g.setDayNightOverride(854);
    g.drainIslandBuildQueue?.(40);
    // Hide inland water in the same task the builds land in, so no frame can
    // compile its program before the "before" census.
    for (const grp of g.islandMeshes.values()) grp.traverse((o) => { if (o.name === 'inland-water') o.visible = false; });
  });
  await page.waitForFunction(
    () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99), null, { timeout: 120_000 },
  ).catch(() => {});
  await page.evaluate(() => {
    const g = window.__piratesBR;
    for (const grp of g.islandMeshes.values()) grp.traverse((o) => { if (o.name === 'inland-water') o.visible = false; });
    g.settleLod?.(2);
  });
  await page.waitForTimeout(3000);

  report = await page.evaluate(async (limit) => {
    const g = window.__piratesBR;
    const loco = await import('/src/shared/locomotion.ts');
    const lf = await import('/src/shared/landforms.ts');
    const R = g.renderer.renderer, scene = g.renderer.scene, cam = g.renderer.camera;
    const islands = g.state.islands ?? [];
    const out = { programs: {}, floaters: [], meshes: [], targets: {}, notes: [] };

    // ── 1. programs ──
    const inland = [];
    const falls = [];
    for (const grp of g.islandMeshes.values()) grp.traverse((o) => {
      if (o.name === 'inland-water' && o.isMesh) inland.push(o);
      if (o.name === 'waterfall-water' && o.isMesh) falls.push(o);
    });
    R.compile(scene, cam);
    const before = R.info.programs.length;
    for (const m of inland) m.visible = true;
    R.compile(scene, cam);
    const after = R.info.programs.length;
    const prog = (mat) => R.properties.get(mat)?.currentProgram ?? null;
    const inlandProgs = new Set(inland.map((m) => prog(m.material)));
    const fallProgs = new Set(falls.map((m) => prog(m.material)));
    const shared = [...inlandProgs].every((p) => p && fallProgs.has(p));
    const sameMaterial = inland.every((m) => falls.some((f) => f.material === m.material));
    // Falsify: a clone with one extra define MUST read +1.
    const m0 = inland[0];
    let mutantDelta = null;
    if (m0) {
      const orig = m0.material;
      const mut = orig.clone();
      mut.defines = { ...(orig.defines ?? {}), INLAND_CENSUS_MUTANT: 1 };
      if (orig.onBeforeCompile) mut.onBeforeCompile = orig.onBeforeCompile;
      if (orig.customProgramCacheKey) mut.customProgramCacheKey = () => orig.customProgramCacheKey() + '|mutant';
      m0.material = mut;
      R.compile(scene, cam);
      mutantDelta = R.info.programs.length - after;
      m0.material = orig;
      mut.dispose();
    }
    out.programs = {
      before, after, delta: after - before, inlandMeshes: inland.length, waterfallMeshes: falls.length,
      inlandProgramNames: [...inlandProgs].map((p) => p?.name ?? null), sharedWithWaterfall: shared, sameMaterial, mutantDelta,
    };

    // ── 2. floaters on boundary vertices ──
    function sampler(mesh) {
      const geo = mesh.userData?.terrainLod?.fullGeometry ?? mesh.geometry;
      const p = geo.attributes.position.array;
      const index = geo.index ? geo.index.array : null;
      const triCount = Math.floor((index ? index.length : p.length / 3) / 3);
      const CELL = 6, buckets = new Map(), key = (a, b) => `${a}|${b}`;
      const tri = (t) => (index ? [index[t * 3] * 3, index[t * 3 + 1] * 3, index[t * 3 + 2] * 3] : [t * 9, t * 9 + 3, t * 9 + 6]);
      for (let t = 0; t < triCount; t++) {
        const [a, b, c] = tri(t);
        for (let ix = Math.floor(Math.min(p[a], p[b], p[c]) / CELL); ix <= Math.floor(Math.max(p[a], p[b], p[c]) / CELL); ix++)
          for (let iz = Math.floor(Math.min(p[a + 2], p[b + 2], p[c + 2]) / CELL); iz <= Math.floor(Math.max(p[a + 2], p[b + 2], p[c + 2]) / CELL); iz++) {
            const k = key(ix, iz); const l = buckets.get(k); if (l) l.push(t); else buckets.set(k, [t]);
          }
      }
      return (x, z) => {
        const l = buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
        if (!l) return null;
        let best = null;
        for (const t of l) {
          const [a, b, c] = tri(t);
          const x1 = p[a], z1 = p[a + 2], x2 = p[b], z2 = p[b + 2], x3 = p[c], z3 = p[c + 2];
          const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
          if (Math.abs(d) < 1e-9) continue;
          const w1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
          const w2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
          const w3 = 1 - w1 - w2;
          if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
          const y = w1 * p[a + 1] + w2 * p[b + 1] + w3 * p[c + 1];
          if (best === null || y > best) best = y;
        }
        return best;
      };
    }
    for (const [id, grp] of g.islandMeshes.entries()) {
      const isl = islands.find((i) => i.id === id);
      const water = []; grp.traverse((o) => { if (o.name === 'inland-water' && o.isMesh) water.push(o); });
      if (!water.length) continue;
      const terrain = grp.getObjectByName('island-terrain');
      if (!terrain) { out.notes.push(`${isl?.name}: no island-terrain`); continue; }
      if (Math.abs(grp.rotation.y) > 1e-6) out.notes.push(`${isl?.name}: rotated group`);
      const ground = sampler(terrain);
      const ponds = isl ? lf.getLandformPonds(isl) : [];
      const shelves = isl ? lf.getIslandLandforms(isl).filter((r) => r.kind === 'rock_shelf') : [];
      const kindAt = (x, z) => {
        if (ponds.some((p) => Math.hypot(x - p.x, z - p.z) <= p.radius * 1.05)) return 'pond';
        if (shelves.some((s) => Math.hypot(x - s.center[0], z - s.center[1]) <= s.radius * 1.1)) return 'tidepool';
        return 'stream';
      };
      for (const w of water) {
        const geo = w.geometry, P = geo.attributes.position.array, I = geo.index.array;
        const edges = new Map();
        for (let t = 0; t < I.length; t += 3) for (const [a, b] of [[I[t], I[t + 1]], [I[t + 1], I[t + 2]], [I[t + 2], I[t]]]) {
          const k = a < b ? `${a}_${b}` : `${b}_${a}`; edges.set(k, (edges.get(k) ?? 0) + 1);
        }
        const bound = new Set();
        for (const [k, n] of edges) if (n === 1) { const [a, b] = k.split('_'); bound.add(+a); bound.add(+b); }
        const stat = { island: isl?.name, verts: P.length / 3, tris: I.length / 3, boundary: bound.size, overSea: 0, noGround: 0,
          byKind: {}, worst: [] };
        // terrain + water share the island group frame (both local, unrotated)
        const ty = terrain.position.y, wy = w.position.y;
        for (const v of bound) {
          const x = P[v * 3] + w.position.x, y = P[v * 3 + 1] + wy, z = P[v * 3 + 2] + w.position.z;
          const gy = ground(x - terrain.position.x, z - terrain.position.z);
          if (gy === null) { stat.noGround++; continue; }
          const gap = y - (gy + ty);
          if (gy + ty < 0) { stat.overSea++; continue; }
          const k = kindAt(x, z);
          const s = stat.byKind[k] ??= { n: 0, over: 0, maxGap: -1e9, sumGap: 0 };
          s.n++; s.sumGap += gap; if (gap > s.maxGap) s.maxGap = gap;
          if (gap > limit) { s.over++; stat.worst.push({ k, x: +(x + grp.position.x).toFixed(1), z: +(z + grp.position.z).toFixed(1), gap: +gap.toFixed(2) }); }
        }
        for (const s of Object.values(stat.byKind)) { s.meanGap = +(s.sumGap / s.n).toFixed(3); s.maxGap = +s.maxGap.toFixed(3); delete s.sumGap; }
        stat.worst = stat.worst.sort((a, b) => b.gap - a.gap).slice(0, 6);
        out.floaters.push(stat);
      }
    }

    // ── 3. camera targets (world space) ──
    // World = group position + yaw(group) * island-local (the subtree is frozen,
    // so matrixWorld is not trusted).
    const toWorld = (isl, lx, lz) => {
      const grp = g.islandMeshes.get(isl.id); const ry = grp?.rotation.y ?? 0, c = Math.cos(ry), s = Math.sin(ry);
      const bx = grp ? grp.position.x : isl.position.x, bz = grp ? grp.position.z : isl.position.z;
      return [bx + lx * c + lz * s, bz - lx * s + lz * c, ry];
    };
    out.frames = ["Smuggler's Rest", 'Old Maw', 'Skull Cove'].map((n) => {
      const i = islands.find((q) => String(q.name).startsWith(n)); const grp = i && g.islandMeshes.get(i.id);
      return i && { n: i.name, isl: [i.position.x, i.position.z], grp: grp && [grp.position.x, grp.position.y, grp.position.z, grp.rotation.y] };
    });
    const byName = (n) => islands.find((i) => i.name === n) ?? islands.find((i) => String(i.name).startsWith(n));
    const along = (s, u) => {
      const d = u * s.length; let i = 1;
      while (i < s.cum.length - 1 && s.cum[i] < d) i++;
      const t = (d - s.cum[i - 1]) / Math.max(1e-6, s.cum[i] - s.cum[i - 1]);
      const [ax, az] = s.path[i - 1], [bx, bz] = s.path[i];
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: bx - ax, dz: bz - az };
    };
    const sm = byName("Smuggler's Rest");
    if (sm) {
      const s = loco.getInlandStreams(sm).find((q) => q.id.includes('spring')) ?? loco.getInlandStreams(sm)[0];
      if (s) {
        const mk = (u) => { const a = along(s, u); const L = Math.hypot(a.dx, a.dz) || 1;
          const [x, z, ry] = toWorld(sm, a.x, a.z); const c = Math.cos(ry), sn = Math.sin(ry);
        const fx = a.dx / L, fz = a.dz / L;
        return { x, z, y: loco.streamSurfaceY(s, u), fx: fx * c + fz * sn, fz: -fx * sn + fz * c, hw: loco.streamHalfWidth(s, u) }; };
        out.targets.valley = mk(0.45); out.targets.valleyUp = mk(0.3); out.targets.mouth = mk(0.97);
      }
    }
    const om = byName('Old Maw');
    if (om) { const p = lf.getLandformPonds(om)[0]; if (p) { const [x, z] = toWorld(om, p.x, p.z); out.targets.lake = { x, z, y: p.y, r: p.radius }; } }
    const sk = byName('Skull Cove');
    if (sk) {
      const sh = lf.getIslandLandforms(sk).filter((r) => r.kind === 'rock_shelf');
      out.targets.shelves = sh.map((r) => { const [x, z] = toWorld(sk, r.center[0], r.center[1]); return { id: r.id, x, z, y: r.y, r: r.radius }; });
    }
    out.islandNames = islands.map((i) => i.name);
    return out;
  }, LIMIT);
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log('PROGRAMS', JSON.stringify(report.programs));
  for (const f of report.floaters) console.log('FLOAT', JSON.stringify(f));
  console.log('TARGETS', JSON.stringify(report.targets));
  console.log('FRAMES', JSON.stringify(report.frames));
  if (report.notes.length) console.log('NOTES', report.notes.join(' | '));

  // ── 3. pixels ──
  async function look(p, t) {
    await page.evaluate(([p, t]) => {
      const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2], L = Math.hypot(dx, dy, dz) || 1;
      const g = window.__piratesBR;
      g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / L, dz / L), Math.asin(dy / L));
      // Settle at EVERY placement: the waiting->playing transition re-raises the
      // load guard, which holds every unpaid material (island terrain included)
      // out of the frame while the already-paid waterfall program still draws.
      // Run 3 shot Smuggler's valley in that window: sea plus a bare ribbon,
      // 'state waiting', 72 draws. settleLod reads the camera and drops the guard.
      g.settleLod?.(2);
    }, [p, t]);
  }
  async function shoot(name) {
    await page.waitForTimeout(1500);
    const path = `${OUT}/${name}.png`;
    await page.screenshot({ path, timeout: 120_000 });
    const bytes = statSync(path).size;
    shots.push({ name, path, bytes, flat: bytes < 30_000 });
    console.log(`  ${name.padEnd(26)} ${(bytes / 1024).toFixed(0).padStart(5)} KB${bytes < 30_000 ? '  <-- SUSPECT FLAT' : ''}`);
  }
  const T = report.targets;
  if (T.valley) {
    const v = T.valley, sx = -v.fz, sz = v.fx; // side normal
    await look([v.x + sx * 28 - v.fx * 22, v.y + 30, v.z + sz * 28 - v.fz * 22], [v.x, v.y, v.z]);
    await shoot('smuggler-valley-aerial');
    const u = T.valleyUp;
    await look([u.x - u.fx * 0.5 + (-u.fz) * (u.hw * 0.4), u.y + 1.1, u.z - u.fz * 0.5 + u.fx * (u.hw * 0.4)], [u.x + u.fx * 12, u.y + 0.2, u.z + u.fz * 12]);
    await shoot('smuggler-valley-waterline');
  }
  if (T.mouth) {
    const m = T.mouth;
    await look([m.x + m.fx * 30 + (-m.fz) * 18, 26, m.z + m.fz * 30 + m.fx * 18], [m.x, m.y, m.z]);
    await shoot('smuggler-delta-aerial');
    await look([m.x + m.fx * 10, 1.2, m.z + m.fz * 10], [m.x - m.fx * 20, m.y + 1.5, m.z - m.fz * 20]);
    await shoot('smuggler-delta-waterline');
  }
  if (T.lake) {
    const l = T.lake;
    await look([l.x + l.r * 1.6, l.y + 26, l.z + l.r * 1.6], [l.x, l.y, l.z]);
    await shoot('oldmaw-lake-aerial');
    await look([l.x + l.r * 1.25, l.y + 1.3, l.z + l.r * 0.3], [l.x - l.r, l.y + 0.3, l.z]);
    await shoot('oldmaw-lake-waterline');
  }
  for (const s of (T.shelves ?? []).slice(0, 2)) {
    const dx = s.x, dz = s.z; // aim from the island's centre side, looking out
    await look([s.x + s.r * 2.2, s.y + 12, s.z + s.r * 2.2], [s.x, s.y, s.z]);
    await shoot(`skull-${s.id}-aerial`);
    await look([s.x + s.r * 1.6, s.y + 1.4, s.z + s.r * 0.6], [s.x, s.y + 0.1, s.z]);
    await shoot(`skull-${s.id}-waterline`);
    void dx; void dz;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  stopAll();
}

if (report) {
  const p = report.programs;
  if (p.inlandMeshes === 0) fail.push('no inland-water meshes in the scene');
  if (p.delta !== 0) fail.push(`inland water added ${p.delta} programs`);
  if (!p.sharedWithWaterfall) fail.push('inland-water program is not the waterfall program');
  if (!(p.mutantDelta >= 1)) fail.push(`census blind: mutant material read +${p.mutantDelta}`);
  for (const f of report.floaters) for (const [k, s] of Object.entries(f.byKind)) if (s.over > 0) fail.push(`${f.island} ${k}: ${s.over}/${s.n} boundary verts > ${LIMIT} m over ground (max ${s.maxGap})`);
} else fail.push('no report');
const flat = shots.filter((s) => s.flat);
if (flat.length) fail.push(`suspect-flat shots: ${flat.map((s) => s.name).join(', ')}`);
writeFileSync(`${OUT}/verdict.json`, JSON.stringify({ fail, shots }, null, 2));
console.log(`\n${shots.length} shots -> ${OUT}`);
console.log(fail.length ? `FAIL\n  ${fail.join('\n  ')}` : 'PASS');
process.exit(fail.length ? 1 : 0);
