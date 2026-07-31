// FINAL WAVE CROSS-SMOKE — ISLANDS (checks k, p, and a clear-weather retake of o).
//
//   (k) CAVE MOUTHS, the user's own complaint. 8521348 cut a per-fragment hole in
//       the heightfield (CaveMouthCutout.ts). The mouth has to read as a REAL dark
//       opening set into the hillside — not a decal painted on rock, not a patch of
//       visible rock you walk straight through — at 30 m and at 5 m, on a mountain,
//       a rocky island and a tropical one; and from INSIDE looking out, daylight
//       has to come through the hole.
//   (p) WATERFALL CHUTES close up (Crow's Perch by preference), noon and night:
//       ribbons seated on the terrain, crags seated, spray not fullbright at night.
//   (o′) The sea micro-POIs again, but photographed EARLY, under clear weather —
//       the first pass caught them under a live squall and everything in frame was
//       a silhouette, which cannot distinguish "black material" from "no light".
//
// Software ANGLE only (this box panics under GPU-headless Chromium), one browser,
// small viewport, and every capture's pixel variance is checked before any claim
// is made about it.
//
// WHY THE PHASES ARE SELECTABLE, AND WHY THE WAITS ARE SHORT. The first run of
// this probe photographed Crow's Perch under a clear noon sky and Skull Cove,
// four minutes later, under a live squall: the ring had shrunk onto the idle
// spawn, the rain came up, and the "is the mouth darker than its hillside"
// reading was being taken in the dark. Weather is not a constant a visual probe
// may assume, so every capture now records the storm context it was taken in, and
// the phases split so a run can be over before the first ring lands.
//
//   PHASES=k node scripts/finalwave-island-smoke.mjs   (cave mouths only)
//   PHASES=p node scripts/finalwave-island-smoke.mjs   (waterfalls only)
//   PHASES=o node scripts/finalwave-island-smoke.mjs   (sea micro-POIs only)
//
//   node scripts/finalwave-island-smoke.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PHASES = new Set((process.env.PHASES ?? 'o,k,p').split(',').map((x) => x.trim()).filter(Boolean));
const phase = (id) => PHASES.has(id);
/** Settle time before a capture. SwiftShader needs a few frames; nothing needs many. */
const SETTLE = Number(process.env.SETTLE_MS ?? 1500);
/** Which island kinds the cave phase visits, and how deep the inside sweep goes.
 *  A full sweep of three islands outruns the first storm ring on this rasteriser,
 *  and a mouth photographed in a squall cannot be judged for darkness. */
const CAVE_WANTS = (process.env.CAVE_WANTS ?? 'mountain,rocky,tropical').split(',').map((x) => x.trim()).filter(Boolean);
const CAVE_DEPTHS = (process.env.CAVE_DEPTHS ?? '3,6,10').split(',').map(Number).filter((n) => Number.isFinite(n));

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/finalwave/smoke/island';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter'],
});
let closed = false;
const reap = () => { if (closed) return; closed = true; try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); reap(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); reap(); process.exit(1); });

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const ok = (label, pass, detail = '') => { results.push({ label, pass, detail }); console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); };
const say = (m) => console.log(m);

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));
await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ } });

await page.goto('http://127.0.0.1:3000/?debug&peace&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
await wait(3000);
await page.evaluate(() => { document.getElementById('oc-skip')?.click(); });
await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue?.(40));
await page.waitForFunction(
  () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
  null, { timeout: 240_000 },
).catch(() => say('  (island build queue did not fully drain — continuing)'));
await page.evaluate(() => {
  const e = document.createElement('style');
  e.textContent = '#hud{visibility:hidden!important;} #onboard-cards{display:none!important;}';
  document.head.appendChild(e);
});
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(1000);

const look = (p, t) => page.evaluate(([a, b]) => {
  const g = window.__piratesBR;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  g.enableFreeCam(a[0], a[1], a[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
}, [p, t]);

/**
 * Capture and measure. `box` is a fractional rect of the frame — for a cave shot
 * it is the middle of the image, where the mouth is aimed, and what matters there
 * is how much of it is genuinely DARK (a hole) versus lit rock (a decal or a wall
 * the player walks through). `sd` guards against a flat non-render.
 */
/** The weather a frame was taken in, so a dark reading can be attributed. */
const weather = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const st = g.state.storm;
  const d = me ? Math.hypot(me.position.x - st.centerX, me.position.z - st.centerZ) : null;
  return {
    t: +(g.state.serverTime ?? 0).toFixed(0), stormPhase: st.phase,
    safe: +st.safeRadius.toFixed(0), playerD: d === null ? null : +d.toFixed(0),
    // The client draws rain off how far the PLAYER is outside the ring, not the
    // camera — a free-cam frame 700 m away is still wet if she is.
    outside: d === null ? null : +(d - st.safeRadius).toFixed(0),
  };
});

const capture = async (name, box = null) => {
  const wx = await weather();
  const png = await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120_000 });
  const stats = await page.evaluate(async ([dataUrl, b]) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = document.createElement('canvas');
    cv.width = 240; cv.height = 135;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 240, 135);
    const d = ctx.getImageData(0, 0, 240, 135).data;
    const lum = [];
    for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    const mean = lum.reduce((a, x) => a + x, 0) / lum.length;
    const sd = Math.sqrt(lum.reduce((a, l) => a + (l - mean) ** 2, 0) / lum.length);
    let boxStats = null;
    if (b) {
      const x0 = Math.round(b[0] * 240), x1 = Math.round(b[2] * 240);
      const y0 = Math.round(b[1] * 135), y1 = Math.round(b[3] * 135);
      const v = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(lum[y * 240 + x]);
      const bm = v.reduce((a, x) => a + x, 0) / v.length;
      v.sort((p, q) => p - q);
      boxStats = {
        mean: +bm.toFixed(2),
        p05: +v[Math.floor(v.length * 0.05)].toFixed(2),
        p50: +v[Math.floor(v.length * 0.5)].toFixed(2),
        p95: +v[Math.floor(v.length * 0.95)].toFixed(2),
        darkFrac: +(v.filter((x) => x < 30).length / v.length).toFixed(3),
        brightFrac: +(v.filter((x) => x > 150).length / v.length).toFixed(3),
      };
    }
    return { mean: +mean.toFixed(2), sd: +sd.toFixed(2), box: boxStats };
  }, [`data:image/png;base64,${png.toString('base64')}`, box]);
  stats.weather = wx;
  say(`  [${name}] sd=${stats.sd} mean=${stats.mean}${stats.box ? ` box=${JSON.stringify(stats.box)}` : ''} wx=${JSON.stringify(wx)}`);
  return stats;
};

const shots = {};
// Hoisted: the report at the bottom reads these whether or not the phase ran.
let poiShots = [];
let caveTargets = [];
let caveReads = [];
let walk = [];
let falls = [];

// ══ (o′) SEA MICRO-POIs, CLEAR WEATHER, EARLY ════════════════════════════════
// Done FIRST because the storm has not risen yet: whatever these look like now is
// what their materials look like, with nothing to blame the light for.
if (phase('o')) {
say('\n(o′) sea events under clear noon');
const pois = await page.evaluate(() => (window.__piratesBR.state.seaPois ?? [])
  .map((p) => ({ kind: p.kind, x: p.position.x, z: p.position.z })));
const seen = new Map();
for (const p of pois) if (!seen.has(p.kind)) seen.set(p.kind, p);
poiShots = [];
for (const [kind, p] of seen) {
  await look([p.x + 14, 4.0, p.z + 11], [p.x, 0.8, p.z]);
  await wait(SETTLE);
  const st = await capture(`o2-${kind}-near`, [0.3, 0.35, 0.7, 0.75]);
  shots[`o2-${kind}-near`] = st;
  poiShots.push({ kind, ...st.box });
}
// A raft of black silhouettes under a bright noon sun is an unlit material, and
// that is exactly the audit's "flat black sheets". Under clear noon the site must
// hold real tone: not a box whose 95th percentile is still in the dark.
ok('every sea event holds real tone under a clear noon sun (no unlit black sheet)',
  poiShots.length > 0 && poiShots.every((p) => p.p95 > 60 && p.darkFrac < 0.35),
  poiShots.map((p) => `${p.kind} p05=${p.p05} p50=${p.p50} p95=${p.p95} dark=${p.darkFrac}`).join(' | '));
}

// ══ (k) CAVE MOUTHS ══════════════════════════════════════════════════════════
if (phase('k')) {
say('\n(k) cave mouths: 30 m, 5 m, and from inside looking out');
caveTargets = await page.evaluate(([wants]) => {
  const g = window.__piratesBR;
  const out = [];
  for (const want of wants) {
    const isl = (g.state.islands ?? []).find((i) => {
      const style = (i.profile?.terrainStyle ?? '').toLowerCase();
      const biome = (i.profile?.biome ?? '').toLowerCase();
      return (style === want || biome === want) && (i.caves ?? []).some((c) => c.hasMouth)
        && !out.some((o) => o.island === i.name);
    });
    if (!isl) { out.push({ want, missing: true }); continue; }
    const m = isl.caves.find((c) => c.hasMouth);
    out.push({
      want, island: isl.name, style: isl.profile?.terrainStyle, biome: isl.profile?.biome,
      x: m.position.x, y: m.position.y, z: m.position.z, rot: m.rotation,
      w: m.width, h: m.height, len: m.length, floorY: m.floorY,
    });
  }
  return out;
}, [CAVE_WANTS]);
say(`  targets: ${JSON.stringify(caveTargets)}`);
caveReads = [];
for (const c of caveTargets) {
  if (c.missing) { say(`  (no ${c.want} island with a mouth in this world)`); continue; }
  const ox = Math.sin(c.rot), oz = Math.cos(c.rot);   // outward from the hillside
  const aim = [c.x, c.floorY + c.h * 0.42, c.z];
  // 30 m: the range the complaint was filed at — does it read as a hole in a hill?
  await look([c.x + ox * 30, c.floorY + 5.5, c.z + oz * 30], aim);
  await wait(SETTLE);
  const far = await capture(`k-${c.want}-30m`, [0.34, 0.35, 0.66, 0.78]);
  // 5 m: close enough that a decal would give itself away.
  await look([c.x + ox * 5.5, c.floorY + 2.0, c.z + oz * 5.5], aim);
  await wait(SETTLE);
  const near = await capture(`k-${c.want}-5m`, [0.25, 0.25, 0.75, 0.85]);
  // Three quarters, so the jamb is seen edge-on against the hillside.
  await look([c.x + ox * 15 + oz * 11, c.floorY + 3.4, c.z + oz * 15 - ox * 11], aim);
  await wait(SETTLE);
  const three = await capture(`k-${c.want}-threequarter`);
  // Inside, looking back out: daylight has to arrive through the hole.
  //
  // AT THREE DEPTHS, because one depth cannot tell "the mouth does not open from
  // the inside" from "the probe parked its camera in solid rock". The first pass
  // stood 9 m into Crow's Perch and photographed the inside of a hill; the eye
  // height rides the cave's own floor, and the shallowest depth that is genuinely
  // inside is the one the verdict reads.
  const insides = [];
  for (const depth of CAVE_DEPTHS) {
    const px = c.x - ox * depth, pz = c.z - oz * depth;
    const groundY = await page.evaluate(([x, z]) => +window.__piratesBR.sampleGroundY(x, z).toFixed(2), [px, pz]);
    await look([px, groundY + 1.6, pz], [c.x + ox * 60, c.floorY + 3, c.z + oz * 60]);
    await wait(SETTLE);
    const st = await capture(`k-${c.want}-inside-out-${depth}m`, [0.3, 0.25, 0.7, 0.8]);
    shots[`k-${c.want}-inside-out-${depth}m`] = st;
    insides.push({ depth, groundY, ...st.box });
  }
  // The best view out of the three: if ANY depth inside the tunnel shows daylight,
  // the hole opens from within.
  const inside = { box: insides.reduce((a, b) => (b.p95 > a.p95 ? b : a)) };
  say(`  inside-out sweep ${c.want}: ${JSON.stringify(insides)}`);
  shots[`k-${c.want}-30m`] = far; shots[`k-${c.want}-5m`] = near;
  shots[`k-${c.want}-threequarter`] = three;
  caveReads.push({ ...c, far: far.box, near: near.box, inside: inside.box, insides });
}
// A HOLE IS DARKER THAN THE ROCK AROUND IT. A decal on a lit hillside and a patch
// of ordinary rock both come out near the hillside's own tone; an opening reads a
// long way below it. Judged as the box's own contrast rather than an absolute,
// because a mountain flank at noon and a tropical slope are not the same rock.
ok('the mouth reads DARK against its own hillside at 30 m on every island type',
  caveReads.length > 0 && caveReads.every((c) => c.far.p05 < 45 && c.far.p95 - c.far.p05 > 40),
  caveReads.map((c) => `${c.want}/${c.island} p05=${c.far.p05} p95=${c.far.p95}`).join(' | '));
ok('and it is still an opening from 5 m, not a painted patch',
  caveReads.length > 0 && caveReads.every((c) => c.near.p05 < 40 && c.near.darkFrac > 0.10),
  caveReads.map((c) => `${c.want} p05=${c.near.p05} dark=${c.near.darkFrac}`).join(' | '));
ok('from inside, daylight comes through the hole (sky/sea visible out of the mouth)',
  caveReads.length > 0 && caveReads.every((c) => c.inside.p95 > 90 && c.inside.brightFrac > 0.05),
  caveReads.map((c) => `${c.want} p95=${c.inside.p95} bright=${c.inside.brightFrac}`).join(' | '));

// WALK-THROUGH. The hole must be walkable, and the ground under it must be the
// cave floor, not the hillside the cutout removed. Asked of the same physics the
// player uses, at the mouth and eight metres in.
walk = await page.evaluate(([targets]) => {
  const g = window.__piratesBR;
  return targets.filter((c) => !c.missing).map((c) => {
    const ox = Math.sin(c.rot), oz = Math.cos(c.rot);
    const at = (d) => {
      const x = c.x + ox * d, z = c.z + oz * d;
      return { d, y: +g.sampleGroundY(x, z).toFixed(2) };
    };
    return { want: c.want, island: c.island, floorY: +c.floorY.toFixed(2), h: +c.h.toFixed(1), samples: [at(6), at(1), at(-3), at(-8)] };
  });
}, [caveTargets]);
say(`  ground under the mouth: ${JSON.stringify(walk)}`);
ok('the ground inside the mouth is the cave floor, not the hill that was cut away',
  walk.length > 0 && walk.every((w) => w.samples.filter((s) => s.d <= 0).every((s) => s.y <= w.floorY + 1.2)),
  walk.map((w) => `${w.want} floorY=${w.floorY} ${w.samples.map((s) => `${s.d}m:${s.y}`).join(',')}`).join(' | '));
}

// ══ (p) WATERFALL CHUTES ═════════════════════════════════════════════════════
if (phase('p')) {
say('\n(p) waterfall chute close up, noon and night');
falls = await page.evaluate(() => {
  const g = window.__piratesBR;
  const out = [];
  g.renderer.scene.traverse((o) => {
    if (o.name === 'waterfall-site' && o.userData?.base) {
      out.push({
        island: o.userData.island, lip: o.userData.lip, base: o.userData.base,
        dir: o.userData.dir, drop: o.userData.drop,
      });
    }
  });
  return out;
});
say(`  ${falls.length} waterfall sites: ${falls.map((f) => `${f.island}(drop ${Math.round(f.drop)})`).join(', ')}`);
const pick = falls.find((f) => /Crow/i.test(f.island ?? '')) ?? falls.sort((a, b) => b.drop - a.drop)[0] ?? null;
const fallShots = [];
if (pick) {
  say(`  chosen: ${pick.island}, drop ${pick.drop.toFixed(1)} m`);
  // Stand off the plunge pool along the fall's own outward direction, eye level
  // with the middle of the drop: the ribbon, the crags it runs over and the pool
  // all in one frame, which is where a floating ribbon shows itself.
  const dx = pick.dir?.x ?? 0, dz = pick.dir?.z ?? 1;
  const nl = Math.hypot(dx, dz) || 1;
  const midY = (pick.base.y + pick.lip.y) / 2;
  for (const [hour, secs] of [['noon', 854], ['night', 374]]) {
    await page.evaluate(([s]) => window.__piratesBR.setDayNightOverride(s), [secs]);
    await look([pick.base.x + (dx / nl) * 22, midY, pick.base.z + (dz / nl) * 22],
      [pick.base.x, pick.base.y + 1.5, pick.base.z]);
    await wait(SETTLE);
    const st = await capture(`p-fall-${hour}`);
    // And the foot of it, where the ribbon meets rock.
    await look([pick.base.x + (dx / nl) * 9 + (dz / nl) * 6, pick.base.y + 3.2, pick.base.z + (dz / nl) * 9 - (dx / nl) * 6],
      [pick.base.x, pick.base.y + 0.6, pick.base.z]);
    await wait(SETTLE);
    const foot = await capture(`p-fall-foot-${hour}`, [0.25, 0.3, 0.75, 0.9]);
    shots[`p-fall-${hour}`] = st; shots[`p-fall-foot-${hour}`] = foot;
    fallShots.push({ hour, frame: st, foot: foot.box });
  }
  const night = fallShots.find((f) => f.hour === 'night');
  const noon = fallShots.find((f) => f.hour === 'noon');
  // FULLBRIGHT SPRAY IS SPRAY THAT IGNORES THE HOUR. If the foot of the fall is
  // as bright at 03:00 as it is at noon, the mist is an unlit additive sheet.
  ok('the spray at the foot of the fall obeys the hour (not fullbright at night)',
    !!night && !!noon && night.foot.p95 < noon.foot.p95 * 0.72,
    `noon p95=${noon?.foot.p95} night p95=${night?.foot.p95}`);
  ok('both waterfall frames rendered a real scene',
    fallShots.every((f) => f.frame.sd > 3), fallShots.map((f) => `${f.hour}:sd=${f.frame.sd}`).join(' '));
} else {
  ok('a waterfall site exists to photograph', false, 'no waterfall-site nodes in the scene');
}
}

writeFileSync(`${OUT}/island-report.json`, JSON.stringify({ caveTargets, caveReads, walk, falls, poiShots, shots, results, errors: errors.slice(0, 20) }, null, 1));
console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 4).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
closed = true;
process.exit(failed.length ? 1 : 0);
