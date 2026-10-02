#!/usr/bin/env node
// Island relief gate (b4.4b; D29, PLAN 3.14, islands-01 / islands-12).
//
// Part A, ENFORCED now: the authored landform layer (src/shared/landforms.ts)
// through the real getIslandSurfaceY hook, on synthetic records over real
// roster islands:
//   1. scarp: a 6 m step with a face steeper than 60 deg; cut mode lowers.
//   2. valley/gorge: the stream bed along the centreline is monotone (never
//      rises toward the mouth) and equals the authored bed where it cuts.
//   3. basin: the floor sits `depth` below spillY and no ray escapes the rim
//      below spillY + 0.25 m (a pond plane at spillY never leaks).
//   4. mesa flat top + cliff + a ramp walkable under 40 deg; caldera floor, rim
//      and breach; rock shelf; terrace treads; headland crest; dunes raise only.
//   5. 16 m bucket hash: a sample evaluates at most 4 records (authored order),
//      and every roster island's densest bucket holds <= 4.
//   6. caves keep caveReliefWeight: no change at a cave mouth and none in the
//      baseRelief topography the cave generator reads; stamps stay authoritative.
//   7. zero rng: Math.random throws during index build and every sample;
//      evaluation is deterministic.
// Part B, REPORT mode (enforced from b4.4h with --enforce): the PLAN 3.14
// D-table per island on a 2 m grid (land = y > 0.3): % land > 35 / > 60 deg,
// peak, landform kinds, tiers split by >= 5 m measured steps, 60 x 60 m flat
// windows (< 2 m relief, authored meadows/mesa tops exempt), the archipelago
// row (islet sand band >= 6 m on >= 50% of each islet perimeter, cay tops >=
// calm crest + 0.3 m), a > 4 m sightline break within 40 m of every dock, and
// the grid build time (<= 25 ms per island).
//
//   node --import tsx scripts/test-island-relief.mjs [--enforce]
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import {
  getIslandSurfaceY, getIslandCays, gerstnerHeight, WAVE_PARAMS,
} from '../src/shared/utils/index.ts';
import {
  overrideIslandLandforms, getIslandLandforms, getLandformIndex, buildLandformIndex,
  landformStreamBedY, LANDFORM_MAX_PER_SAMPLE, LANDFORM_ROSTER,
} from '../src/shared/landforms.ts';

const ENFORCE = process.argv.includes('--enforce');
let fails = 0, passes = 0;
function expect(label, ok, detail = '') {
  if (ok) { passes++; console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`); }
  else { fails++; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const islands = new MapGenerator(20260801).generateIslands();
const byId = (id) => islands.find((i) => i.id === id);
const Y = (island, lx, lz, opts) => getIslandSurfaceY(island, island.position.x + lx, island.position.z + lz, opts);
function withRecords(island, recs, fn) {
  overrideIslandLandforms(island, recs);
  try { return fn(); } finally { overrideIslandLandforms(island, null); }
}

// A quiet interior spot: inside 0.45 R, as far as possible from every stamp.
function quietSpot(island) {
  let best = null, bestD = -1;
  for (let a = 0; a < 48; a++) for (const f of [0.2, 0.3, 0.4]) {
    const lx = Math.cos(a / 48 * Math.PI * 2) * island.radius * f;
    const lz = Math.sin(a / 48 * Math.PI * 2) * island.radius * f;
    let d = Infinity;
    for (const s of island.stamps ?? []) d = Math.min(d, Math.hypot(island.position.x + lx - s.x, island.position.z + lz - s.z) - s.radius);
    if (d > bestD) { bestD = d; best = [lx, lz]; }
  }
  return { p: best, clearance: bestD };
}

console.log('Part A: landform layer (enforced)');
const smug = byId('smuggler-s-rest');
const { p: P, clearance } = quietSpot(smug);
expect('synthetic site is clear of stamps by >= 20 m', clearance >= 20, `${clearance.toFixed(1)} m at ${P.map((v) => v.toFixed(1))}`);
const [px, pz] = P;
// The natural (record-free) surface, even when called inside withRecords.
const nat = (lx, lz) => {
  const prev = getIslandLandforms(smug);
  overrideIslandLandforms(smug, []);
  try { return Y(smug, lx, lz); } finally { overrideIslandLandforms(smug, prev.length ? prev : null); }
};

// 1. scarp (path along +x: high side is +z)
{
  const rec = { id: 't-scarp', kind: 'scarp', path: [[px - 18, pz], [px + 18, pz]], height: 6, face: 2 };
  const before = nat(px, pz + 4) - nat(px, pz - 4);
  const after = withRecords(smug, [rec], () => Y(smug, px, pz + 4) - Y(smug, px, pz - 4));
  expect('scarp raises the high side by ~6 m', after - before >= 5.5 && after - before <= 6.5, `step ${(after - before).toFixed(2)} m`);
  const maxSlope = withRecords(smug, [rec], () => {
    let m = 0;
    for (let s = -4; s < 4; s += 0.5) m = Math.max(m, Math.abs(Y(smug, px, pz + s + 0.5) - Y(smug, px, pz + s)) / 0.5);
    return m;
  });
  expect('scarp face is steeper than 60 deg', maxSlope >= Math.tan(Math.PI / 3), `${(Math.atan(maxSlope) * 180 / Math.PI).toFixed(1)} deg`);
  const farOk = withRecords(smug, [rec], () => Math.abs(Y(smug, px, pz + 40) - nat(px, pz + 40)) < 1e-9);
  expect('scarp leaves ground beyond its reach untouched', farOk);
  const cut = withRecords(smug, [{ ...rec, mode: 'cut' }], () => nat(px, pz - 5) - Y(smug, px, pz - 5));
  expect('scarp cut mode lowers the low side', cut >= 5.5, `${cut.toFixed(2)} m`);
}

// 2. valley + gorge: monotone bed
for (const kind of ['valley', 'gorge']) {
  const head = [px, pz - 22], mouth = [px, pz + 22];
  let lowest = Infinity;
  for (let s = 0; s <= 1; s += 0.02) lowest = Math.min(lowest, nat(px, pz - 22 + 44 * s));
  const rec = { id: `t-${kind}`, kind, path: [head, mouth], bedHeadY: lowest - 1.5, bedMouthY: lowest - 4, floorWidth: 3, topWidth: kind === 'gorge' ? 12 : 26 };
  const { mono, onBed, wall } = withRecords(smug, [rec], () => {
    let prev = Infinity, mono = true, onBed = true;
    for (let s = 0; s <= 44; s += 0.5) {
      const y = Y(smug, px, pz - 22 + s);
      if (y > prev + 1e-9) mono = false;
      if (Math.abs(y - landformStreamBedY(rec, s / 44)) > 1e-6) onBed = false;
      prev = y;
    }
    const wall = Y(smug, px + 4.5, pz) - Y(smug, px + 1.5, pz);
    return { mono, onBed, wall };
  });
  expect(`${kind}: stream bed is monotone head -> mouth`, mono);
  expect(`${kind}: centreline sits exactly on the authored bed`, onBed);
  expect(`${kind}: walls rise off the bed`, kind === 'gorge' ? wall >= 6 : wall >= 1.2, `${wall.toFixed(2)} m over 3 m`);
}

// 3. basin spill
{
  const spillY = nat(px, pz) - 1;
  const rec = { id: 't-basin', kind: 'basin', center: [px, pz], radius: 12, spillY, depth: 2.5 };
  const { floor, spill } = withRecords(smug, [rec], () => {
    let spill = Infinity;
    for (let a = 0; a < 72; a++) {
      let barrier = -Infinity;
      for (let d = 10; d <= 17; d += 0.25) barrier = Math.max(barrier, Y(smug, px + Math.cos(a / 72 * Math.PI * 2) * d, pz + Math.sin(a / 72 * Math.PI * 2) * d));
      spill = Math.min(spill, barrier);
    }
    return { floor: Y(smug, px, pz), spill };
  });
  expect('basin floor = spillY - depth', Math.abs(floor - (spillY - 2.5)) < 1e-6, `${floor.toFixed(2)} vs ${(spillY - 2.5).toFixed(2)}`);
  expect('basin rim holds >= spillY + 0.25 on every ray', spill >= spillY + 0.25, `lowest barrier ${(spill - spillY).toFixed(2)} m above spill`);
}

// 4. mesa, caldera, shelf, terraces, headland, dunes
{
  const topY = nat(px, pz) + 8;
  const rec = { id: 't-mesa', kind: 'mesa', center: [px, pz], radius: 14, topY, face: 2.5, ramps: [{ angle: 0, halfWidth: 3, run: 22 }] };
  const r = withRecords(smug, [rec], () => {
    let flat = true;
    for (let i = 0; i < 40; i++) {
      const a = i / 40 * Math.PI * 2, d = (i % 5) * 2.4;
      if (Math.abs(Y(smug, px + Math.cos(a) * d, pz + Math.sin(a) * d) - topY) > 1e-6) flat = false;
    }
    const cliff = Y(smug, px, pz - 12.5) - Y(smug, px, pz - 15.5);
    let rampMax = 0;
    for (let d = 10; d < 38; d += 0.5) rampMax = Math.max(rampMax, Math.abs(Y(smug, px + d + 0.5, pz) - Y(smug, px + d, pz)) / 0.5);
    return { flat, cliff, rampMax };
  });
  expect('mesa top is flat at topY', r.flat);
  expect('mesa ring is a cliff (>= 5 m over 3 m)', r.cliff >= 5, `${r.cliff.toFixed(2)} m`);
  expect('mesa ramp is walkable (< 40 deg)', r.rampMax < Math.tan(40 * Math.PI / 180), `${(Math.atan(r.rampMax) * 180 / Math.PI).toFixed(1)} deg`);
}
{
  const floorY = nat(px, pz) - 2, rimY = nat(px, pz) + 10;
  const rec = { id: 't-caldera', kind: 'caldera', center: [px, pz], rimRadius: 20, rimY, floorY, rimWidth: 10, outerRun: 25, breach: { angle: 0, halfWidth: 3, sillY: floorY + 1.5 } };
  const r = withRecords(smug, [rec], () => ({ floor: Y(smug, px, pz), rim: Y(smug, px - 20, pz), breach: Y(smug, px + 20, pz) }));
  expect('caldera floor at floorY', Math.abs(r.floor - floorY) < 1e-6);
  expect('caldera rim crest at rimY', Math.abs(r.rim - rimY) < 1e-6, `${r.rim.toFixed(2)} vs ${rimY.toFixed(2)}`);
  expect('caldera breach notch drops to the sill', r.breach <= floorY + 1.5 + 1e-6, `${r.breach.toFixed(2)} vs sill ${(floorY + 1.5).toFixed(2)}`);
}
{
  const r = withRecords(smug, [{ id: 't-shelf', kind: 'rock_shelf', center: [px, pz], radius: 8, y: 0.6 }], () => Y(smug, px, pz));
  expect('rock shelf flattens to its authored y', Math.abs(r - 0.6) < 1e-6, r.toFixed(3));
}
{
  // Lay the run down the island's radial slope (centre -> 0.75 R through P).
  const a = Math.atan2(pz, px), R = smug.radius;
  const path = [[Math.cos(a) * R * 0.1, Math.sin(a) * R * 0.1], [Math.cos(a) * R * 0.75, Math.sin(a) * R * 0.75]];
  const rec = { id: 't-terrace', kind: 'terrace_run', path, width: 20, stepHeight: 1.6 };
  const tread = (fn) => {
    let flat = 0, n = 0;
    for (let f = 0.2; f < 0.65; f += 0.005) {
      const d = R * f;
      const y0 = fn(Math.cos(a) * d, Math.sin(a) * d), y1 = fn(Math.cos(a) * (d + 0.5), Math.sin(a) * (d + 0.5));
      if (Math.abs(y1 - y0) < 0.02) flat++;
      n++;
    }
    return flat / n;
  };
  const before = tread((x, z) => nat(x, z));
  const after = withRecords(smug, [rec], () => tread((x, z) => Y(smug, x, z)));
  expect('terrace run turns a slope into treads', after >= 0.5 && after > before + 0.25, `tread share ${before.toFixed(2)} -> ${after.toFixed(2)}`);
}
{
  const base = nat(px, pz);
  const rec = { id: 't-head', kind: 'headland', path: [[px, pz], [px, pz + 30]], crestBaseY: base + 6, crestTipY: base + 2, topHalfWidth: 4 };
  const mid = withRecords(smug, [rec], () => Y(smug, px, pz + 15));
  expect('headland crest follows its authored line (raises only)', Math.abs(mid - Math.max(nat(px, pz + 15), base + 4)) < 1e-6, `${mid.toFixed(2)}`);
}
{
  const rec = { id: 't-dunes', kind: 'dune_field', path: [[px - 25, pz], [px + 25, pz]], width: 16, amplitude: 1.2, wavelength: 9 };
  const r = withRecords(smug, [rec], () => {
    let minD = Infinity, maxD = -Infinity;
    for (let x = -24; x <= 24; x += 0.5) for (let z = -7; z <= 7; z += 1) {
      const d = Y(smug, px + x, pz + z) - nat(px + x, pz + z);
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    return { minD, maxD };
  });
  expect('dune field only raises sand, crests near its amplitude', r.minD >= -1e-9 && r.maxD >= 0.9, `delta ${r.minD.toFixed(3)}..${r.maxD.toFixed(2)} m`);
}

// 5. bucket hash
{
  const recs = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2].map((y, i) => ({ id: `t-shelf-${i}`, kind: 'rock_shelf', center: [px, pz], radius: 6, y }));
  const idx = buildLandformIndex(recs);
  expect('index reports the densest bucket and overflow', idx.maxPerCell === 6 && idx.overflowCells >= 1, `max ${idx.maxPerCell}, overflow ${idx.overflowCells}`);
  const y = withRecords(smug, recs, () => Y(smug, px, pz));
  expect(`a sample evaluates at most ${LANDFORM_MAX_PER_SAMPLE} records, in authored order`, Math.abs(y - 0.8) < 1e-6, `y ${y.toFixed(3)} (4th record = 0.8)`);
  const lone = buildLandformIndex([recs[0]]);
  expect('bucket hash is 16 m cells (a 6 m disc spans <= 4 cells)', lone.cells.size <= 4 && lone.cells.size >= 1, `${lone.cells.size} cells`);
}
for (const island of islands) {
  const idx = getLandformIndex(island);
  if (idx.maxPerCell > LANDFORM_MAX_PER_SAMPLE) expect(`${island.id}: densest bucket <= ${LANDFORM_MAX_PER_SAMPLE}`, false, `${idx.maxPerCell}`);
}
expect(`every roster island's densest bucket <= ${LANDFORM_MAX_PER_SAMPLE}`, islands.every((i) => getLandformIndex(i).maxPerCell <= LANDFORM_MAX_PER_SAMPLE));
expect('roster keys are real island ids', Object.keys(LANDFORM_ROSTER).every((k) => islands.some((i) => i.id === k)), Object.keys(LANDFORM_ROSTER).join(',') || '(empty roster)');

// 6. caves and stamps
{
  const skull = byId('skull-cove');
  const cave = skull.caves[0];
  const cx = cave.position.x - skull.position.x, cz = cave.position.z - skull.position.z;
  const rec = { id: 't-cave-mesa', kind: 'mesa', center: [cx, cz], radius: 45, topY: Y(skull, cx, cz) + 10 };
  const atMouth = Y(skull, cx, cz);
  const baseGrid = [];
  for (let x = -40; x <= 40; x += 4) for (let z = -40; z <= 40; z += 4) baseGrid.push(Y(skull, cx + x, cz + z, { baseRelief: true }));
  const r = withRecords(skull, [rec], () => {
    let same = true, changed = 0, k = 0;
    for (let x = -40; x <= 40; x += 4) for (let z = -40; z <= 40; z += 4) {
      if (Math.abs(Y(skull, cx + x, cz + z, { baseRelief: true }) - baseGrid[k++]) > 1e-12) same = false;
      if (Math.abs(Y(skull, cx + x, cz + z) - Y(skull, cx + x, cz + z, { baseRelief: true })) > 0.5) changed++;
    }
    return { mouth: Y(skull, cx, cz), same, changed };
  });
  expect('caves keep caveReliefWeight: no change at a cave mouth', Math.abs(r.mouth - atMouth) < 1e-9);
  expect('baseRelief topography (cave generator input) is untouched', r.same);
  expect('the same record does move ground outside the cave collar', r.changed > 0, `${r.changed} samples`);
  const st = smug.stamps[0];
  const sx = st.x - smug.position.x, sz = st.z - smug.position.z;
  const s = withRecords(smug, [{ id: 't-stamp-mesa', kind: 'mesa', center: [sx, sz], radius: st.radius * 3, topY: st.targetY + 9 }],
    () => ({ c: Y(smug, sx, sz), out: Y(smug, sx + st.radius * 1.6, sz) - nat(sx + st.radius * 1.6, sz) }));
  expect('structure stamps stay authoritative over landforms', Math.abs(s.c - st.targetY) < 1e-9 && s.out > 1, `centre ${s.c.toFixed(3)} vs ${st.targetY.toFixed(3)}, outside +${s.out.toFixed(2)}`);
}

// 7. zero rng, determinism
{
  const realRandom = Math.random;
  let drew = false;
  Math.random = () => { drew = true; throw new Error('rng draw in the landform layer'); };
  let a, b;
  try {
    const recs = [
      { id: 'r1', kind: 'scarp', path: [[px - 18, pz], [px + 18, pz]], height: 6 },
      { id: 'r2', kind: 'dune_field', path: [[px - 25, pz + 20], [px + 25, pz + 20]], width: 16 },
    ];
    a = withRecords(smug, recs, () => { const o = []; for (let x = -30; x <= 30; x += 3) for (let z = -30; z <= 30; z += 3) o.push(Y(smug, px + x, pz + z)); return o; });
    b = withRecords(smug, recs, () => { const o = []; for (let x = -30; x <= 30; x += 3) for (let z = -30; z <= 30; z += 3) o.push(Y(smug, px + x, pz + z)); return o; });
  } catch { drew = true; } finally { Math.random = realRandom; }
  expect('zero rng draws (Math.random never called)', !drew);
  expect('evaluation is deterministic', !!a && a.every((v, i) => v === b[i]));
}

// ── Part B: the D-table, report mode ─────────────────────────────────────────
console.log(`\nPart B: PLAN 3.14 relief table (${ENFORCE ? 'ENFORCED' : 'REPORT mode, enforced in b4.4h'})`);
const STEP_KINDS = new Set(['scarp', 'mesa', 'terrace_run', 'caldera', 'headland']);
const tan35 = Math.tan(35 * Math.PI / 180), tan60 = Math.tan(60 * Math.PI / 180);
let calmCrest = -Infinity;
for (let t = 0; t < 600; t += 1.7) for (let k = 0; k < 8; k++) calmCrest = Math.max(calmCrest, gerstnerHeight(k * 37.1, k * -23.3, t, WAVE_PARAMS, 0));
const reportFails = [];
const rows = [];
const archRows = [];
for (const island of islands) {
  const R = island.radius, ext = R * 1.15, step = 2;
  const n = Math.floor((2 * ext) / step) + 1;
  const grid = new Float64Array(n * n);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const lx = -ext + i * step, lz = -ext + j * step;
    grid[i * n + j] = lx * lx + lz * lz <= ext * ext ? Y(island, lx, lz) : -10;
  }
  const buildMs = performance.now() - t0;
  const at = (i, j) => grid[i * n + j];
  let land = 0, s35 = 0, s60 = 0, peak = -Infinity;
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const y = at(i, j);
    if (y <= 0.3) continue;
    land++; peak = Math.max(peak, y);
    const g = Math.hypot((at(i + 1, j) - y) / step, (at(i, j + 1) - y) / step);
    if (g > tan35) s35++;
    if (g > tan60) s60++;
  }
  const recs = getIslandLandforms(island);
  const kinds = new Set(recs.filter((r) => r.kind !== 'meadow').map((r) => r.kind));
  // Tiers: 1 + authored step records whose MEASURED drop across the edge is >= 5 m.
  let tiers = 1;
  for (const r of recs) {
    if (!STEP_KINDS.has(r.kind)) continue;
    let drop = 0;
    if ('center' in r) {
      const rr = r.kind === 'caldera' ? r.rimRadius : r.radius;
      for (let a = 0; a < 16; a++) {
        const c = Math.cos(a / 16 * Math.PI * 2), s = Math.sin(a / 16 * Math.PI * 2);
        drop = Math.max(drop, Math.abs(Y(island, r.center[0] + c * (rr - 4), r.center[1] + s * (rr - 4)) - Y(island, r.center[0] + c * (rr + 4), r.center[1] + s * (rr + 4))));
      }
    } else {
      const [a, b] = [r.path[0], r.path[r.path.length - 1]];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      drop = Math.abs(Y(island, mx - dz / L * 4, mz + dx / L * 4) - Y(island, mx + dz / L * 4, mz - dx / L * 4));
    }
    if (drop >= 5) tiers++;
  }
  // 60 x 60 m flat windows (all-land, max - min < 2 m), exempt: meadows + mesa tops.
  const exempt = recs.filter((r) => r.kind === 'meadow' || r.kind === 'mesa');
  let flatWindows = 0, windows = 0;
  const w = 30;
  for (let i = 0; i + w < n; i += 5) for (let j = 0; j + w < n; j += 5) {
    let mn = Infinity, mx = -Infinity, allLand = true;
    for (let a = i; a <= i + w && allLand; a++) for (let b = j; b <= j + w; b++) {
      const y = at(a, b);
      if (y <= 0.3) { allLand = false; break; }
      mn = Math.min(mn, y); mx = Math.max(mx, y);
    }
    if (!allLand) continue;
    windows++;
    const cx = -ext + (i + w / 2) * step, cz = -ext + (j + w / 2) * step;
    if (exempt.some((r) => Math.hypot(cx - r.center[0], cz - r.center[1]) < r.radius)) continue;
    if (mx - mn < 2) flatWindows++;
  }
  // Dock sightline break: ground within 40 m of the dock (its whole run from
  // the root on the beach to the pier head) > 4 m above its deck.
  let dock = null;
  if (island.dock) {
    const dx = island.dock.position.x - island.position.x, dz = island.dock.position.z - island.position.z;
    const dl = Math.hypot(dx, dz) || 1, L = island.dock.length;
    const rx = dx - dx / dl * L, rz = dz - dz / dl * L; // landward root
    let hi = -Infinity;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const lx = -ext + i * step, lz = -ext + j * step;
      const t = Math.max(0, Math.min(1, ((lx - rx) * (dx - rx) + (lz - rz) * (dz - rz)) / (L * L || 1)));
      if (Math.hypot(lx - (rx + (dx - rx) * t), lz - (rz + (dz - rz) * t)) <= 40) hi = Math.max(hi, at(i, j));
    }
    dock = hi - Math.max(island.dock.position.y, 0.3);
  }
  const cls = R < 50 ? 'S' : R < 75 ? 'M' : 'L';
  const floors = { S: { p35: 4, p60: 0.8, peak: 10, kinds: 2, tiers: 2 }, M: { p35: 6, p60: 1.5, peak: 0.3 * R, kinds: 3, tiers: 2 }, L: { p35: 8, p60: 2, peak: 0.28 * R, kinds: 4, tiers: 3 } }[cls];
  const row = {
    id: island.id, r: R, cls, style: island.profile.terrainStyle,
    p35: land ? 100 * s35 / land : 0, p60: land ? 100 * s60 / land : 0, peak, kinds: kinds.size, tiers,
    flatWindows, windows, dock, buildMs, records: recs.length,
  };
  const misses = [];
  if (island.profile.terrainStyle === 'archipelago') {
    // Islets = 4-connected land components >= 30 cells; sand band = inland run
    // from each perimeter cell (away from its water neighbour) with y <= 1.2 m.
    const comp = new Int32Array(n * n).fill(-1);
    const islets = [];
    for (let s0 = 0; s0 < n * n; s0++) {
      if (comp[s0] !== -1 || grid[s0] <= 0.3) continue;
      const cells = [s0]; comp[s0] = islets.length;
      for (let q = 0; q < cells.length; q++) {
        const c = cells[q], i = Math.floor(c / n), j = c % n;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const k = a * n + b;
          if (comp[k] === -1 && grid[k] > 0.3) { comp[k] = islets.length; cells.push(k); }
        }
      }
      islets.push(cells);
    }
    const isletRows = [];
    for (const cells of islets) {
      if (cells.length < 30) continue;
      let perim = 0, sandy = 0;
      for (const c of cells) {
        const i = Math.floor(c / n), j = c % n;
        const wn = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([di, dj]) => { const a = i + di, b = j + dj; return a >= 0 && b >= 0 && a < n && b < n && grid[a * n + b] <= 0.3; });
        if (!wn) continue;
        perim++;
        const lx = -ext + i * step, lz = -ext + j * step;
        let band = 0;
        for (let d = 0.5; d <= 8; d += 0.5) { if (Y(island, lx - wn[0] * d, lz - wn[1] * d) > 1.2) break; band = d + 1; }
        if (band >= 6) sandy++;
      }
      isletRows.push(perim ? sandy / perim : 0);
    }
    const cayTops = getIslandCays(island).map((cay) => {
      let top = -Infinity;
      for (let a = -1; a <= 1; a += 0.25) for (let b = -1; b <= 1; b += 0.25) top = Math.max(top, Y(island, cay.x + a * cay.length, cay.z + b * cay.width));
      return top;
    });
    // Crown slope (b4.4d): the dry sand crown falls at most 1:12 across its
    // characteristic radius L = sqrt(length * width), sampled both ways along
    // the cay's long axis (samples under a structure stamp are skipped).
    const cayCrown = getIslandCays(island).map((cay) => {
      const L = Math.sqrt(cay.length * cay.width), c = Y(island, cay.x, cay.z);
      let worst = 0;
      for (const sgn of [-1, 1]) for (const f of [0.3, 0.6, 0.9]) {
        const d = f * L, lx = cay.x + sgn * d * cay.cos, lz = cay.z + sgn * d * cay.sin;
        // Structure stamps are authoritative (a pad flattened into a cay edge).
        if ((island.stamps ?? []).some((st) => Math.hypot(island.position.x + lx - st.x, island.position.z + lz - st.z) < st.radius)) continue;
        worst = Math.max(worst, (c - Y(island, lx, lz)) / d);
      }
      return worst;
    });
    row.isletSand = isletRows.map((v) => Math.round(v * 100));
    row.cayMargin = cayTops.map((v) => +(v - calmCrest).toFixed(2));
    row.cayCrown = cayCrown.map((v) => +(1 / Math.max(v, 1e-6)).toFixed(1));
    const archMisses = [];
    if (!isletRows.length || isletRows.some((v) => v < 0.5)) archMisses.push(`islet sand band ${row.isletSand.join('/')}% < 50%`);
    if (cayTops.some((v) => v < calmCrest + 0.3)) archMisses.push(`cay top below calm crest + 0.3 (${row.cayMargin.join('/')})`);
    if (cayTops.some((v) => v < calmCrest + 0.9 - 0.05 || v > calmCrest + 1.4 + 0.05)) archMisses.push(`cay freeboard outside 0.9-1.4 m over the calm crest (${row.cayMargin.join('/')})`);
    if (cayCrown.some((v) => v > 1 / 12 + 0.01)) archMisses.push(`cay crown steeper than 1:12 (1:${row.cayCrown.join('/1:')})`);
    misses.push(...archMisses);
    archRows.push({ id: island.id, archMisses });
  } else {
    if (row.p35 < floors.p35) misses.push(`>35deg ${row.p35.toFixed(1)}% < ${floors.p35}`);
    if (row.p60 < floors.p60) misses.push(`>60deg ${row.p60.toFixed(2)}% < ${floors.p60}`);
    if (row.peak < floors.peak) misses.push(`peak ${row.peak.toFixed(1)} < ${floors.peak.toFixed(1)}`);
    if (row.kinds < floors.kinds) misses.push(`kinds ${row.kinds} < ${floors.kinds}`);
    if (row.tiers < floors.tiers) misses.push(`tiers ${row.tiers} < ${floors.tiers}`);
    if (flatWindows > 0) misses.push(`${flatWindows}/${windows} flat 60 m windows`);
  }
  if (dock !== null && dock <= 4) misses.push(`dock sightline break ${dock.toFixed(1)} m <= 4`);
  if (buildMs > 25) misses.push(`grid build ${buildMs.toFixed(1)} ms > 25`);
  row.misses = misses;
  rows.push(row);
  if (misses.length) reportFails.push(island.id);
  const tag = misses.length ? (ENFORCE ? '✗ FAIL' : '· below') : '✓';
  console.log(`  ${tag} ${island.id.padEnd(16)} r${String(R).padStart(3)} ${cls} ${row.style.padEnd(11)} >35 ${row.p35.toFixed(1).padStart(5)}%  >60 ${row.p60.toFixed(2).padStart(5)}%  peak ${row.peak.toFixed(1).padStart(5)}  kinds ${row.kinds} tiers ${row.tiers} flat ${flatWindows}/${windows} dock ${dock === null ? '  -  ' : dock.toFixed(1).padStart(5)} build ${buildMs.toFixed(1)} ms${row.isletSand ? ` islets ${row.isletSand.join('/')}% cays ${row.cayMargin.join('/')} crown 1:${row.cayCrown.join('/1:')}` : ''}`);
  if (misses.length) console.log(`      ${misses.join('; ')}`);
}
console.log(`  calm crest ${calmCrest.toFixed(2)} m; ${reportFails.length}/14 islands below the D-table`);
if (ENFORCE) for (const id of reportFails) fails++;

// ── Part C: the archipelago row, ENFORCED now (b4.4d, islands-11) ────────────
// Islet sand band >= 6 m on >= 50% of every islet perimeter, cay tops >= calm
// crest + 0.3 m with 0.9-1.4 m freeboard, cay crowns no steeper than 1:12.
console.log('\nPart C: archipelago row (enforced)');
expect('both archipelagos present (Crooked Atoll, Dead Man Shoals)', ['the-crooked-atoll', 'dead-man-shoals'].every((id) => archRows.some((r) => r.id === id)), archRows.map((r) => r.id).join(', '));
for (const r of archRows) expect(`${r.id}: islet sand ring + dry 1:12 cays`, r.archMisses.length === 0, r.archMisses.join('; '));

// ── Part D: the archipelago + bone PAINT row (b4.4d d2, islands-11) ──────────
// The colour pass's own band/palette functions (TerrainMeshBuilder exports):
// dry islet beaches and cay crowns paint sand, not the ~2/3 grass the old
// heightNorm-vs-seaBase mask gave; bone isles bare pale limestone on slopes
// and bleach their turf toward the sand.
// --mutate=no-islet-sand / --mutate=no-bone must FAIL this part.
{
  const THREE = await import('three');
  const { terrainGroundBands, terrainBiomePalette, BONE_LIMESTONE } = await import('../src/client/world/island/TerrainMeshBuilder.ts');
  const MUT = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
  console.log(`\nPart D: archipelago sand + bone palette (enforced)${MUT ? ` [mutate=${MUT}]` : ''}`);
  for (const id of ['the-crooked-atoll', 'dead-man-shoals']) {
    const island = byId(id);
    const profile = MUT === 'no-islet-sand' ? { ...island.profile, terrainStyle: 'tropical' } : island.profile;
    const seaBase = 5.15 + island.radius * 0.0085;
    const peakEst = Math.max(4, island.radius * (0.10 + island.profile.heightProfile * 0.25 + (island.profile.peakBoost ?? 0) * 0.15));
    const ext = island.radius * 1.3;
    let beach = 0, beachGrass = 0, crown = 0, crownGrass = 0;
    for (let lx = -ext; lx <= ext; lx += 2) for (let lz = -ext; lz <= ext; lz += 2) {
      const y = Y(island, lx, lz);
      if (y < 0.3 || y > 3.1) continue;
      const hn = Math.min(1, Math.max(0, (y - seaBase) / peakEst));
      // distRatio 0.5 = the inland worst case (no shore berm suppression).
      const g = terrainGroundBands(profile, y, hn, 0.5).grass;
      if (y <= 1.2) { beach++; beachGrass += g; } else { crown++; crownGrass += g; }
    }
    const bg = beach ? beachGrass / beach : 1, cg = crown ? crownGrass / crown : 1;
    expect(`${id}: islet beaches (0.3-1.2 m) paint sand, grass <= 5%`, beach > 50 && bg <= 0.05, `${beach} samples, grass ${(bg * 100).toFixed(1)}%`);
    expect(`${id}: low dry ground / cay crowns (1.2-3.1 m) grass <= 25%`, crown > 20 && cg <= 0.25, `${crown} samples, grass ${(cg * 100).toFixed(1)}%`);
  }
  for (const id of ['dead-man-shoals', 'skull-cove', 'gallows-sands']) {
    const island = byId(id);
    if (!island) { expect(`${id}: present`, false); continue; }
    const biome = MUT === 'no-bone' ? 'lush' : island.profile.biome;
    const rock = new THREE.Color(0x6b665c).multiplyScalar(0.8), grass = new THREE.Color(0x5f7a3a), sand = new THREE.Color(0xd8c9a0);
    const pal = terrainBiomePalette(biome, rock, grass, grass.clone(), sand);
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
    const toward = dist(pal.grass, grass) / dist(sand, grass);
    expect(`${id} (bone): slopes bare pale limestone 0x${BONE_LIMESTONE.toString(16)}`, island.profile.biome === 'bone' && pal.slopeRock.getHex() === BONE_LIMESTONE && lum(pal.slopeRock) > 2 * lum(rock), `slope 0x${pal.slopeRock.getHexString()}`);
    expect(`${id} (bone): turf bleached >= 30% toward the sand`, toward >= 0.3, `${(toward * 100).toFixed(0)}%`);
  }
  const lushIsle = islands.find((i) => (i.profile.biome ?? 'lush') === 'lush');
  const lushPal = terrainBiomePalette(lushIsle.profile.biome, new THREE.Color(0x555555), new THREE.Color(0x00ff00), new THREE.Color(0x00aa00), new THREE.Color(0xffffff));
  expect('non-bone biomes keep their palette (no bleaching leak)', lushPal.grass.getHex() === 0x00ff00 && lushPal.slopeRock.getHex() === 0x555555, lushIsle.id);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
