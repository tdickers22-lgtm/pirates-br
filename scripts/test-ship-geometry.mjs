// SHIP GEOMETRY CENSUS — the three hulls built by the real ShipRenderer under
// node (2D canvas stubbed, no GPU), every vertex graded against the loft.
//
// WHY. Nothing in the harness read the renderer's geometry: the one probe that
// looked for parts outside the hull (ship-float-audit) needed a browser, was
// never wired, and its "touches a neighbour" test passes any floating cluster.
// So the hold floor was drawn wider than the hull at the bow, deck planks and
// iron ran past the stem, and the stern gallery hung nearly a metre aft of the
// transom for eight campaigns (ships-04/05/06/10; gate: ships-13).
//
// WHAT. For each hull class:
//   1. per material family, the fraction of vertices in the hull band
//      (keel-0.2 .. deck+0.6, between the aft and fore loft stations) that sit
//      more than 0.15 m OUTSIDE the lofted shell. Families that stay inside the
//      hull by construction are graded at ≤2%; families that legitimately leave
//      it (foam, wake, brass lanterns, the gallery timber, unnamed part
//      materials) are printed and not graded here;
//   2. the stern: nothing above 0.9·H may sit more than 0.2 m aft of the hull's
//      aftmost sheer station;
//   3. floating clusters: union-find over the visible mesh AABBs; every
//      component must touch the hull envelope. `--mutate` shoves one mesh 8 m
//      to starboard and the gate must then FAIL (its proof it can).
//
// RED ON HEAD (2026-09-02): hold-floor 24/24 outside on every hull, hold-inner-wall
// 99-108/144, ship-dark-trim 234/252, ship-iron 432 below-deck verts, stern 0.36 /
// 0.55 / 0.85 m aft. Green is HULLGEO-01's job. The loft table below is a copy of
// ShipRenderer's LOFT_STATIONS/HULL_SHAPES (not exported); DECK-01 moves it to
// src/shared/hull.ts and this gate should import it from there.
//
//   node --import tsx scripts/test-ship-geometry.mjs [--mutate]
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { getShipHoldHalfWidth } = await import('../src/shared/interactions.ts');
const interiorMod = await import('../src/client/rendering/ship/interior.ts');

const MUTATE = process.argv.includes('--mutate');
let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── loft (copy of ShipRenderer LOFT_STATIONS / HULL_SHAPES / getHullProfile) ──
const HULL_SHAPES = { sloop: { bulge: 1.045, draftF: 0.365 }, brigantine: { bulge: 1.07, draftF: 0.36 }, galleon: { bulge: 1.10, draftF: 0.35 } };
const LOFT = [
  { zf: -0.50, dh: 0.300, sheer: 0.95, keel01: 0.32, wlF: 0.62, bilgeF: 0.34, mid: 0.15, ztF: -0.505, zbF: -0.415 },
  { zf: -0.36, dh: 0.500, sheer: 0.98, keel01: 0.74, wlF: 0.76, bilgeF: 0.48, mid: 0.75, ztF: -0.360, zbF: -0.350 },
  { zf: -0.22, dh: 0.530, sheer: 0.99, keel01: 0.90, wlF: 0.80, bilgeF: 0.52, mid: 0.95, ztF: -0.220, zbF: -0.220 },
  { zf: -0.08, dh: 0.560, sheer: 1.00, keel01: 1.00, wlF: 0.82, bilgeF: 0.54, mid: 1.00, ztF: -0.080, zbF: -0.080 },
  { zf: 0.07, dh: 0.520, sheer: 0.995, keel01: 1.00, wlF: 0.80, bilgeF: 0.52, mid: 1.00, ztF: 0.070, zbF: 0.070 },
  { zf: 0.22, dh: 0.480, sheer: 0.99, keel01: 0.92, wlF: 0.74, bilgeF: 0.46, mid: 0.90, ztF: 0.220, zbF: 0.220 },
  { zf: 0.32, dh: 0.390, sheer: 1.015, keel01: 0.78, wlF: 0.62, bilgeF: 0.36, mid: 0.60, ztF: 0.325, zbF: 0.310 },
  { zf: 0.42, dh: 0.320, sheer: 1.04, keel01: 0.55, wlF: 0.46, bilgeF: 0.24, mid: 0.30, ztF: 0.445, zbF: 0.405 },
  { zf: 0.50, dh: 0.055, sheer: 1.08, keel01: 0.18, wlF: 0.30, bilgeF: 0.14, mid: 0.00, ztF: 0.530, zbF: 0.415 },
];
function profile(type) {
  const { width: W, height: H, length: L } = SHIP_STATS[type];
  const { bulge, draftF } = HULL_SHAPES[type];
  const draft = H * draftF;
  const stations = LOFT.map((def) => {
    const sheerY = def.sheer * H, keelY = -draft * def.keel01, dh = def.dh * W;
    const wale = dh * (1 + (bulge - 1) * def.mid), wl = dh * def.wlF, bilge = dh * def.bilgeF, waleY = sheerY * 0.6;
    const slots = [[dh, sheerY], [dh + (wale - dh) * 0.72, sheerY - (sheerY - waleY) * 0.45], [wale, waleY], [wl + (wale - wl) * 0.62, waleY * 0.5], [wl, 0], [bilge, keelY * 0.52], [W * 0.015, keelY]];
    return { baseZ: def.zf * L, sheerY, keelY, slots, zt: def.ztF * L, zb: def.zbF * L };
  });
  return { W, H, L, draft, bulge, stations };
}
function stationX(st, y) {
  const s = st.slots; const yc = Math.min(s[0][1], Math.max(s[s.length - 1][1], y));
  let j = 0; while (j < s.length - 2 && yc < s[j + 1][1]) j++;
  const a = s[j], b = s[j + 1]; const t = Math.min(1, Math.max(0, (a[1] - yc) / Math.max(1e-4, a[1] - b[1])));
  return a[0] + (b[0] - a[0]) * t;
}
/** THE DRAWN SHELL at (z, y).
 *
 *  This used to interpolate the stations by their BASE z and read the section
 *  half-width there. That is not the surface the renderer draws: every station
 *  is RAKED (`ztF`/`zbF` in shared/hull.ts), so at the bow the shell's own
 *  vertices sit up to 1.9 m forward of the station they came from. Grading
 *  against the base-z curve therefore called the lofted hull itself 10% outside
 *  the hull — `ship-hull-shell`, built from these very numbers, failed at
 *  +0.90 m on the galleon — and any deck or rail correctly seated ON the sheer
 *  failed with it. So the reference is now the same polyline the renderer
 *  lofts: each station's surface point at height y, carrying that point's raked
 *  z, interpolated over z. Everything the gate caught for real (hold floor,
 *  hold walls, iron, ropes) still fails after the correction. */
function hullHalf(p, z, y) {
  const sts = p.stations;
  const xs = sts.map((st) => stationX(st, y));
  const zs = sts.map((st) => stationZ(st, y));
  if (z <= zs[0]) return xs[0];
  if (z >= zs[zs.length - 1]) return xs[xs.length - 1];
  let i = 0; while (i < zs.length - 2 && z > zs[i + 1]) i++;
  const t = Math.min(1, Math.max(0, (z - zs[i]) / Math.max(1e-4, zs[i + 1] - zs[i])));
  return xs[i] + (xs[i + 1] - xs[i]) * t;
}
/** The raked z of a station at height y: sheer z at the top, keel z at the
 *  bottom, on the same 1.35 power curve shared/hull.ts uses. */
function stationZ(st, y) {
  const span = Math.max(0.001, st.sheerY - st.keelY);
  const vf = Math.min(1, Math.max(0, (st.sheerY - y) / span));
  return st.zt + (st.zb - st.zt) * Math.pow(vf, 1.35);
}
function sheerYAt(p, z) {
  const sts = p.stations; let i = 0; while (i < sts.length - 2 && z > sts[i + 1].baseZ) i++;
  const a = sts[i], b = sts[i + 1]; const t = Math.min(1, Math.max(0, (z - a.baseZ) / (b.baseZ - a.baseZ)));
  return a.sheerY + (b.sheerY - a.sheerY) * t;
}

// ── what is graded ──────────────────────────────────────────────────────────
const OUT_TOL = 0.15;
const MAX_OUT_FRACTION = 0.02;
const STERN_OVERHANG_MAX = 0.2;
/** Material families that live INSIDE the loft by construction. */
const GRADED = ['hold-floor', 'hold-inner-wall', 'hold-hammock', 'ship-deck-planking', 'ship-dark-trim', 'ship-iron', 'ship-rope', 'ship-team-accent', 'ship-hull-shell', 'ship-barrel-wood'];
/** Families allowed outside the shell: water effects, lanterns, the gallery
 *  timber (graded by the stern rule instead), unnamed part materials. */
const ALLOWED = new Set(['waterline-foam', 'wake', 'ship-brass', 'ship-dark-timber', 'MeshBasicMaterial', 'MeshStandardMaterial']);

function fixtureShip(type) {
  return {
    id: `census-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'high');
const v = new THREE.Vector3();
const tmpBox = new THREE.Box3();

for (const type of ['sloop', 'brigantine', 'galleon']) {
  const stats = SHIP_STATS[type];
  const root = sr.buildShip(fixtureShip(type));
  const detail = root.children.find((c) => c.name === 'ship-detail-root') ?? root;
  if (MUTATE) {
    // The proof this gate can fail: one hammock (a small mesh with no
    // neighbours 8 m out) becomes a cluster floating off the starboard beam.
    let done = false;
    detail.traverse((o) => { if (!done && o.isMesh && (o.material?.name === 'hold-hammock')) { o.position.x += stats.width * 2.5; done = true; } });
    if (!done) detail.traverse((o) => { if (!done && o.isMesh && !o.isInstancedMesh) { o.position.x += stats.width * 2.5; done = true; } });
    console.log('  ! mutation: one mesh displaced 2.5 beams to starboard');
  }
  root.updateMatrixWorld(true);
  const p = profile(type);
  const zAft = p.stations[0].baseZ, zFore = p.stations[p.stations.length - 1].baseZ;
  console.log(`\n[${type}] W ${stats.width} L ${stats.length} H ${stats.height} draft ${p.draft.toFixed(2)}  loft z ${zAft.toFixed(2)}..${zFore.toFixed(2)}`);

  const perMat = new Map();
  const meshes = [];
  let sternMinZ = 0, sternMinName = '';
  detail.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    let vis = o.visible; for (let q = o.parent; q && q !== detail; q = q.parent) if (!q.visible) vis = false;
    if (!vis) return;
    const pos = o.geometry.attributes.position; if (!pos) return;
    const name = o.material?.name || o.name || o.material?.type || '?';
    const rec = perMat.get(name) ?? { verts: 0, out: 0, maxOver: 0, at: null };
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y > 0.9 * stats.height && v.z < sternMinZ) { sternMinZ = v.z; sternMinName = name; }
      const y = v.y, z = v.z, x = Math.abs(v.x);
      if (z < zAft || z > zFore) continue;                                   // beyond the loft: transom / stem, not gradeable here
      if (y < -p.draft - 0.2 || y > stats.height + 0.6) continue;           // keel .. just above deck
      rec.verts++;
      const over = x - hullHalf(p, z, Math.min(y, sheerYAt(p, z)));
      if (over > OUT_TOL) { rec.out++; if (over > rec.maxOver) { rec.maxOver = over; rec.at = [+v.x.toFixed(2), +y.toFixed(2), +z.toFixed(2)]; } }
    }
    perMat.set(name, rec);
    o.geometry.computeBoundingBox();
    meshes.push({ name, box: tmpBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).clone() });
  });

  // 1. per-family loft census
  for (const [name, r] of [...perMat].sort((a, b) => b[1].maxOver - a[1].maxOver)) {
    if (r.verts === 0) continue;
    const frac = r.out / r.verts;
    const line = `${name.padEnd(20)} out ${String(r.out).padStart(5)}/${String(r.verts).padStart(6)} (${(frac * 100).toFixed(1)}%)  max +${r.maxOver.toFixed(2)} m at ${JSON.stringify(r.at)}`;
    if (GRADED.includes(name)) {
      expect(`${type}: ${line}`, frac <= MAX_OUT_FRACTION, `${name} must stay inside the lofted shell (≤${MAX_OUT_FRACTION * 100}% of hull-band verts beyond ${OUT_TOL} m)`);
    } else if (r.out > 0) {
      console.log(`    · ${line}${ALLOWED.has(name) ? '  (allowed outside)' : '  (ungraded family)'}`);
    }
  }
  const missing = GRADED.filter((g) => !perMat.has(g) && g !== 'ship-barrel-wood' && g !== 'hold-hammock');
  expect(`${type}: every graded family present in the build (${missing.length ? `missing ${missing.join(', ')}` : 'all found'})`, missing.length === 0);

  // 2. stern gallery vs transom
  const aftmost = p.stations[0].zt;
  const overhang = aftmost - sternMinZ;
  expect(`${type}: nothing above 0.9H hangs more than ${STERN_OVERHANG_MAX} m aft of the transom (aftmost sheer z ${aftmost.toFixed(2)}, ${sternMinName} reaches ${sternMinZ.toFixed(2)}: ${overhang.toFixed(2)} m aft)`,
    overhang <= STERN_OVERHANG_MAX);

  // 2b. THE HOLD'S INNER SKIN vs THE SERVER'S CLAMP.
  //     The drawn wall must stand 3-12 cm OUTBOARD of getShipHoldHalfWidth:
  //     inboard of it and a pirate clips through her own bulkhead, far outboard
  //     and she is stopped by an invisible wall short of the timber she can see
  //     (the box hold was 1.1 m short fore-and-aft and 0.03 W inboard abeam).
  //     Measured on the port and starboard skin at five z through the hold, with
  //     the ends of the taper excluded: there the planking arrives before the
  //     footprint does and the hull, correctly, wins.
  {
    const holdVerts = [];
    detail.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.material?.name !== 'hold-inner-wall') return;
      const pos = o.geometry.attributes.position; if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        holdVerts.push([v.x, v.y, v.z]);
      }
    });
    // Per vertex, against the clamp AT THAT VERTEX'S z — a neighbourhood would
    // read the taper, not the skin.
    let minGap = Infinity, at = null;
    for (const [x, y, z] of holdVerts) {
      if (Math.abs(z) > stats.length * 0.28 || y < 0.3 || y > stats.height * 0.95) continue;
      const gap = Math.abs(x) - getShipHoldHalfWidth(stats, z);
      if (gap < minGap) { minGap = gap; at = [+x.toFixed(2), +z.toFixed(2)]; }
    }
    expect(`${type}: the drawn hold skin stands 3-12 cm outboard of the walk clamp (innermost ${isFinite(minGap) ? minGap.toFixed(3) : '-'} m at ${JSON.stringify(at)})`,
      isFinite(minGap) && minGap >= 0.03 && minGap <= 0.12);
  }

  // 2c. THE CEILING PLANKING follows the HULL, not the walk clamp (ships-10,
  //     b2.3e). Above the stowage lockers the hold's visible skin is the inner
  //     planking, 0.08-0.15 m inboard of the lofted shell at EVERY vertex
  //     (horizontal, graded against this file's own copy of the loft). It
  //     shares the sole's material (one draw), so it is found as the
  //     'hold-floor' family above the locker top. The walkable floor itself is
  //     pinned too: its top stays at 0.35 m and still covers the walk clamp.
  {
    const lockerTop = typeof interiorMod.holdLockerTopY === 'function' ? interiorMod.holdLockerTopY(stats) : 1.0;
    const holdZ = stats.length * 0.34;
    let n = 0, minGap = Infinity, maxGap = -Infinity, atMin = null, atMax = null, yTop = -Infinity, zLo = Infinity, zHi = -Infinity;
    let floorTopMax = 0, floorTopN = 0, floorOver = 0;
    detail.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.material?.name !== 'hold-floor') return;
      const pos = o.geometry.attributes.position; if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (Math.abs(v.y - 0.35) < 0.005) {
          floorTopN++;
          if (Math.abs(v.z) < 0.5) floorTopMax = Math.max(floorTopMax, Math.abs(v.x));
          if (Math.abs(v.x) > getShipHoldHalfWidth(stats, v.z) + 0.12) floorOver++;
          continue;
        }
        if (v.y < lockerTop + 0.005) continue;
        n++;
        const gap = hullHalf(p, v.z, Math.min(v.y, sheerYAt(p, v.z))) - Math.abs(v.x);
        if (gap < minGap) { minGap = gap; atMin = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; }
        if (gap > maxGap) { maxGap = gap; atMax = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; }
        yTop = Math.max(yTop, v.y); zLo = Math.min(zLo, v.z); zHi = Math.max(zHi, v.z);
      }
    });
    expect(`${type}: inner planking present above the lockers (${n} verts, y to ${isFinite(yTop) ? yTop.toFixed(2) : '-'}, z ${isFinite(zLo) ? zLo.toFixed(2) : '-'}..${isFinite(zHi) ? zHi.toFixed(2) : '-'})`,
      n >= 200 && yTop >= stats.height - 0.35 && zLo <= -holdZ * 0.9 && zHi >= holdZ * 0.9);
    expect(`${type}: inner planking 0.08-0.15 m inboard of the hull at every vertex (min ${isFinite(minGap) ? minGap.toFixed(3) : '-'} at ${JSON.stringify(atMin)}, max ${isFinite(maxGap) ? maxGap.toFixed(3) : '-'} at ${JSON.stringify(atMax)})`,
      n > 0 && minGap >= 0.08 && maxGap <= 0.15);
    const clamp0 = getShipHoldHalfWidth(stats, 0);
    expect(`${type}: walkable floor unchanged (top at 0.35 m, ${floorTopN} verts, reaches ${floorTopMax.toFixed(2)} >= clamp ${clamp0.toFixed(2)} amidships, ${floorOver} verts past clamp+0.12)`,
      floorTopN > 0 && floorTopMax >= clamp0 && floorOver === 0);
  }
  // 3. floating clusters: union-find over expanded AABBs
  const parent = meshes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grow = 0.06;
  const boxes = meshes.map((m) => m.box.clone().expandByScalar(grow));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxes[i].intersectsBox(boxes[j])) parent[find(i)] = find(j);
  const envelope = new THREE.Box3(
    new THREE.Vector3(-(stats.width / 2) * p.bulge - 0.3, -p.draft - 0.3, aftmost - 0.3),
    new THREE.Vector3((stats.width / 2) * p.bulge + 0.3, stats.height + 0.6, p.stations[p.stations.length - 1].zt + 0.3),
  );
  const comps = new Map();
  meshes.forEach((m, i) => { const r = find(i); const c = comps.get(r) ?? { box: new THREE.Box3(), names: new Set(), n: 0 }; c.box.union(m.box); c.names.add(m.name); c.n++; comps.set(r, c); });
  const floating = [...comps.values()].filter((c) => !c.box.intersectsBox(envelope));
  expect(`${type}: ${comps.size} mesh clusters, ${floating.length} floating clear of the hull envelope`, floating.length === 0,
    floating.map((c) => `${[...c.names].join('+')} (${c.n} meshes) at x ${c.box.min.x.toFixed(1)}..${c.box.max.x.toFixed(1)} y ${c.box.min.y.toFixed(1)}..${c.box.max.y.toFixed(1)} z ${c.box.min.z.toFixed(1)}..${c.box.max.z.toFixed(1)}`).join('; '));
}

// 4. ABOVE-LOCKER BREACH SEAT (b2.3e). A topside hole above the stowage
//    lockers must seat on the inner planking, not on the old lining: the
//    capsule end sits 0.13 m inboard of the shell (planking 0.12 + 1 cm past
//    it), the planking (the 'hold-floor' family above the lockers) is cut at
//    the seat by the same torn-outline test the shader runs, and planking
//    1.4 m along the hull is not. Galleon, starboard, y 1.6, amidships.
{
  const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');
  const breach = await import('../src/client/rendering/ship/breach.ts');
  const type = 'galleon';
  const stats = SHIP_STATS[type];
  const sr4 = new ShipRenderer();
  sr4.init(new THREE.Scene(), 'high');
  openFirstDrawBudgetForSettle();
  const ship = fixtureShip(type);
  ship.id = 'census-seat';
  ship.holes = [{ id: 61, x: 1, y: 1.6, z: 0, patched: false }];
  ship.nextHoleId = 62;
  const cam4 = new THREE.Vector3(10, 6, 10);
  for (let i = 0; i < 3; i++) sr4.update([ship], [], 24, 1 / 60, 0, cam4);
  const mesh = sr4.shipMeshes.get(ship.id);
  const vis = mesh?.holeVis?.get(61);
  const lockerTop = typeof interiorMod.holdLockerTopY === 'function' ? interiorMod.holdLockerTopY(stats) : 1.0;
  const inboard = vis?.point && vis?.inner ? Math.abs(vis.point.x) - Math.abs(vis.inner.x) : NaN;
  expect(`${type}: topside hole at y 1.6 seats ${Number.isFinite(inboard) ? inboard.toFixed(3) : '-'} m inboard of the shell (0.12-0.14, on the planking; locker top ${lockerTop.toFixed(2)})`,
    !!vis?.inner && vis.point.y > lockerTop && inboard >= 0.12 && inboard <= 0.14 && Math.sign(vis.inner.x) === Math.sign(vis.point.x));
  const uH = mesh?.hullHoleUniform?.value ?? [];
  const uE = mesh?.hullHoleEnds?.value ?? [];
  const cut = (q) => uH.some((c, i) => {
    if (!(c.w > 0) || !uE[i]) return false;
    const ab = new THREE.Vector3(uE[i].x - c.x, uE[i].y - c.y, uE[i].z - c.z);
    const ap = new THREE.Vector3(q.x - c.x, q.y - c.y, q.z - c.z);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(ab.lengthSq(), 1e-6)));
    const sh = mesh.hullHoleUniform.shape.value[i];
    return breach.breachCuts(ap.sub(ab.multiplyScalar(t)), new THREE.Vector3(sh.x, sh.y, sh.z), sh.w, c.w);
  });
  const tri = new THREE.Triangle();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3(), cp = new THREE.Vector3();
  const nearestPlanking = (target) => {
    let best = Infinity; const out = new THREE.Vector3();
    mesh?.detailRoot?.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.material?.name !== 'hold-floor') return;
      const pos = o.geometry.attributes.position; const idx = o.geometry.index;
      const n = idx ? idx.count / 3 : pos.count / 3;
      for (let i = 0; i < n; i++) {
        const i0 = idx ? idx.getX(i * 3) : i * 3, i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1, i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
        tri.set(a.fromBufferAttribute(pos, i0), b.fromBufferAttribute(pos, i1), c3.fromBufferAttribute(pos, i2));
        if (Math.min(a.y, b.y, c3.y) < lockerTop) continue;
        tri.closestPointToPoint(target, cp);
        const d = cp.distanceTo(target);
        if (d < best) { best = d; out.copy(cp); }
      }
    });
    return { d: best, p: out };
  };
  const at = vis?.inner ? nearestPlanking(vis.inner) : { d: Infinity, p: new THREE.Vector3() };
  expect(`${type}: the inner planking at the seat is cut by the breach (nearest planking ${Number.isFinite(at.d) ? at.d.toFixed(3) : '-'} m from the seat, cut ${cut(at.p)})`,
    at.d < 0.05 && cut(at.p));
  const far = vis?.inner ? nearestPlanking(new THREE.Vector3(vis.inner.x, vis.inner.y, vis.inner.z + 1.4)) : { d: Infinity, p: new THREE.Vector3() };
  expect(`${type}: control, the planking 1.4 m along is NOT cut (${Number.isFinite(far.d) ? far.d.toFixed(3) : '-'} m)`, far.d < 0.2 && !cut(far.p));
}

console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
