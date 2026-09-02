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
  { zf: -0.50, dh: 0.300, sheer: 0.95, keel01: 0.32, wlF: 0.62, bilgeF: 0.34, mid: 0.15, ztF: -0.505 },
  { zf: -0.36, dh: 0.500, sheer: 0.98, keel01: 0.74, wlF: 0.76, bilgeF: 0.48, mid: 0.75, ztF: -0.360 },
  { zf: -0.22, dh: 0.530, sheer: 0.99, keel01: 0.90, wlF: 0.80, bilgeF: 0.52, mid: 0.95, ztF: -0.220 },
  { zf: -0.08, dh: 0.560, sheer: 1.00, keel01: 1.00, wlF: 0.82, bilgeF: 0.54, mid: 1.00, ztF: -0.080 },
  { zf: 0.07, dh: 0.520, sheer: 0.995, keel01: 1.00, wlF: 0.80, bilgeF: 0.52, mid: 1.00, ztF: 0.070 },
  { zf: 0.22, dh: 0.480, sheer: 0.99, keel01: 0.92, wlF: 0.74, bilgeF: 0.46, mid: 0.90, ztF: 0.220 },
  { zf: 0.32, dh: 0.390, sheer: 1.015, keel01: 0.78, wlF: 0.62, bilgeF: 0.36, mid: 0.60, ztF: 0.325 },
  { zf: 0.42, dh: 0.320, sheer: 1.04, keel01: 0.55, wlF: 0.46, bilgeF: 0.24, mid: 0.30, ztF: 0.445 },
  { zf: 0.50, dh: 0.055, sheer: 1.08, keel01: 0.18, wlF: 0.30, bilgeF: 0.14, mid: 0.00, ztF: 0.530 },
];
function profile(type) {
  const { width: W, height: H, length: L } = SHIP_STATS[type];
  const { bulge, draftF } = HULL_SHAPES[type];
  const draft = H * draftF;
  const stations = LOFT.map((def) => {
    const sheerY = def.sheer * H, keelY = -draft * def.keel01, dh = def.dh * W;
    const wale = dh * (1 + (bulge - 1) * def.mid), wl = dh * def.wlF, bilge = dh * def.bilgeF, waleY = sheerY * 0.6;
    const slots = [[dh, sheerY], [dh + (wale - dh) * 0.72, sheerY - (sheerY - waleY) * 0.45], [wale, waleY], [wl + (wale - wl) * 0.62, waleY * 0.5], [wl, 0], [bilge, keelY * 0.52], [W * 0.015, keelY]];
    return { baseZ: def.zf * L, sheerY, keelY, slots, zt: def.ztF * L };
  });
  return { W, H, L, draft, bulge, stations };
}
function stationX(st, y) {
  const s = st.slots; const yc = Math.min(s[0][1], Math.max(s[s.length - 1][1], y));
  let j = 0; while (j < s.length - 2 && yc < s[j + 1][1]) j++;
  const a = s[j], b = s[j + 1]; const t = Math.min(1, Math.max(0, (a[1] - yc) / Math.max(1e-4, a[1] - b[1])));
  return a[0] + (b[0] - a[0]) * t;
}
function hullHalf(p, z, y) {
  const sts = p.stations; let i = 0; while (i < sts.length - 2 && z > sts[i + 1].baseZ) i++;
  const a = sts[i], b = sts[i + 1]; const t = Math.min(1, Math.max(0, (z - a.baseZ) / (b.baseZ - a.baseZ)));
  return stationX(a, y) + (stationX(b, y) - stationX(a, y)) * t;
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

console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
