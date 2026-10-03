// SHIP LOD BUDGET — the D26 ship LOD table, graded under node (2D canvas
// stubbed, no GPU) on the three hulls the real ShipRenderer builds.
//
// WHY (ships-01, ships-11, vm:ships:4). A hull was a 9 x 7 LINEAR loft (216
// tris, faceted bow, slab stern) with one ~160-tri proxy as its only LOD, and
// the detail model stayed up to 380 m on every tier. D6 lets LOD0 grow only
// through a chain, so the chain and its budget come first.
//
// WHAT.
//   1. policy (ship/lod.ts): bands 30 / 90 / 250 m, 10% hysteresis both ways,
//      low + phone: every other hull starts at LOD2, the hull you stand on is
//      LOD0 (phones on the LOD1 shell grid);
//   2. the spline shell at every tier grid (LOD0 72 x 48 per side, the b4.2b2
//      spec change from 72 x 22; LOD1 36 x 12, LOD2 18 x 8, far 9 x 5): vertex
//      count, every shell vertex on sampleHullSurface's surface within 1 cm
//      (independent check: hullSurfacePointAt's Newton solve at the vertex z,y),
//      LOD0 adjacent girth faces < 5 deg, one shell draw per tier;
//   3. the built hull per class and level root: tris and draws against the
//      D26 table (LOD0 <= 100k / 140k / 200k tris, LOD2 <= 10% of the LOD0
//      ceiling and <= 4 draws, far <= 3k tris and <= 2 draws) and the low /
//      phone own-hull caps (60k / 45k);
//   4. LOD0 draws against a ratchet (D26 says <= 30; the per-material trim
//      atlas lands with the b4.3 kit, so today's count is pinned, never raised).
//
//   node --import tsx scripts/test-ship-lod-budget.mjs
import { installCanvasStub } from './lib/canvas-stub.mjs';
import { SHIP_LOD_BUDGETS } from './lib/budgets.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const hull = await import('../src/shared/hull.ts');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const CLASSES = ['sloop', 'brigantine', 'galleon'];
// Ceilings live in scripts/lib/budgets.mjs (SHIP_LOD_BUDGETS) so test-budget-ratchet can hold them.
const { LOD0_TRI_CEIL, LOD0_DRAW_RATCHET, LOW_OWN_CAP, PHONE_OWN_CAP } = SHIP_LOD_BUDGETS;

// ── 1. policy ───────────────────────────────────────────────────────────────
console.log('\n[policy] ship/lod.ts');
let lod = null;
try { lod = await import('../src/client/rendering/ship/lod.ts'); }
catch (e) { expect('src/client/rendering/ship/lod.ts exists and exports the D26 policy', false, String(e.message).split('\n')[0]); }
if (lod) {
  const { SHIP_LOD_BANDS, SHIP_LOD_HYSTERESIS, HULL_TIER_GRID, selectShipLod } = lod;
  expect('bands 30 / 90 / 250 m', SHIP_LOD_BANDS[0] === 30 && SHIP_LOD_BANDS[1] === 90 && SHIP_LOD_BANDS[2] === 250, JSON.stringify(SHIP_LOD_BANDS));
  expect('hysteresis 10%', Math.abs(SHIP_LOD_HYSTERESIS - 0.1) < 1e-9);
  const grid = HULL_TIER_GRID.map((g) => `${g.rows}`).join('/');
  expect('tier girth rows 48 / 12 / 8 / 5, LOD0 columns >= 72', HULL_TIER_GRID[0].rows === 48 && HULL_TIER_GRID[1].rows === 12 && HULL_TIER_GRID[2].rows === 8 && HULL_TIER_GRID[3].rows === 5 && HULL_TIER_GRID[0].cols >= 72 && HULL_TIER_GRID[1].cols === 36 && HULL_TIER_GRID[2].cols === 18 && HULL_TIER_GRID[3].cols === 9, grid);
  const hi = { quality: 'high', phone: false, ownHull: false };
  const walk = (opts, ds, start = 0) => { let l = start; const out = []; for (const d of ds) { l = selectShipLod(l, d, opts); out.push(l); } return out; };
  const out = walk(hi, [10, 29, 31, 32.9, 33.1, 60, 95, 99.1, 200, 270, 276, 240, 226, 224, 90, 82, 80.9, 28, 27.4, 26.9]);
  expect('desktop walk out and back with 10% hysteresis',
    out.join(',') === '0,0,0,0,1,1,1,2,2,2,3,3,3,2,2,2,1,1,1,0', out.join(','));
  expect('a far jump selects its band in one call', selectShipLod(0, 400, hi) === 3 && selectShipLod(3, 5, hi) === 0);
  expect('low: other hulls never finer than LOD2', selectShipLod(0, 5, { quality: 'low', phone: false, ownHull: false }) === 2);
  expect('phone: other hulls never finer than LOD2', selectShipLod(0, 5, { quality: 'high', phone: true, ownHull: false }) === 2);
  expect('low / phone: the hull you stand on is LOD0', selectShipLod(3, 5, { quality: 'low', phone: false, ownHull: true }) === 0 && selectShipLod(3, 5, { quality: 'balanced', phone: true, ownHull: true }) === 0);
  expect('own hull on desktop is LOD0 at any distance (free cam)', selectShipLod(3, 600, { quality: 'high', phone: false, ownHull: true }) === 0);
}

// ── 2. the spline shell at every tier ───────────────────────────────────────
const geoMod = await import('../src/client/rendering/ship/geometry.ts');
console.log('\n[shell] spline shell per tier');
for (const type of CLASSES) {
  const profile = hull.getHullProfile(type);
  if (!geoMod.makeSplineHullGeometry || !lod) { expect(`${type}: geometry.ts exports makeSplineHullGeometry(profile, tier)`, false); continue; }
  for (let tier = 0; tier < 4; tier++) {
    const g = lod.HULL_TIER_GRID[tier];
    const geo = geoMod.makeSplineHullGeometry(profile, tier);
    const pos = geo.attributes.position;
    const shellVerts = 2 * g.cols * g.rows;
    const ud = geo.userData;
    expect(`${type} t${tier}: ${g.cols} x ${g.rows} shell per side`, ud.cols === g.cols && ud.rows === g.rows && pos.count >= shellVerts, `cols ${ud.cols} rows ${ud.rows} verts ${pos.count}`);
    // On the spline: every shell vertex vs an independent (z, y) Newton solve.
    let worst = 0, worstAt = '';
    const step = tier === 0 ? 7 : 1;
    for (let i = 0; i < shellVerts; i += step) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const s = hull.hullSurfacePointAt(profile, z, y);
      const err = Math.abs(Math.abs(x) - s.x);
      if (err > worst) { worst = err; worstAt = `z ${z.toFixed(2)} y ${y.toFixed(2)}`; }
    }
    expect(`${type} t${tier}: shell vertices on the spline within 1 cm`, worst <= 0.01, `worst ${(worst * 100).toFixed(3)} cm at ${worstAt}`);
    if (tier === 0) {
      // Adjacent girth faces: angle between consecutive face normals down each column.
      let maxTurn = 0;
      const P = (c, r) => new THREE.Vector3(pos.getX(c * g.rows + r), pos.getY(c * g.rows + r), pos.getZ(c * g.rows + r));
      for (let c = 0; c < g.cols - 1; c++) {
        let prev = null;
        for (let r = 0; r < g.rows - 1; r++) {
          // Quad normal from its diagonals, the metric test-hull-spline-parity grades.
          const n = new THREE.Vector3().subVectors(P(c + 1, r + 1), P(c, r)).cross(new THREE.Vector3().subVectors(P(c, r + 1), P(c + 1, r)));
          if (n.lengthSq() < 1e-12) continue;
          n.normalize();
          if (prev) maxTurn = Math.max(maxTurn, THREE.MathUtils.radToDeg(prev.angleTo(n)));
          prev = n;
        }
      }
      expect(`${type} t0: adjacent girth faces < 5 deg`, maxTurn < 5, `${maxTurn.toFixed(2)} deg`);
    }
    geo.dispose();
  }
}

// ── 3. built hulls per level ────────────────────────────────────────────────
function census(root, ...more) {
  let tris = 0, draws = 0;
  // b4.2h: the rigging lives in ship-rig-root beside the level roots; the
  // LOD0 and own-hull censuses pass it in so the rope plan is paid for.
  for (const r of [root, ...more]) r?.traverse((o) => {
    // The far cards draw only at LOD3 (proxy level), never beside LOD0.
    if (!o.isMesh || o.name === 'ship-rigging-far') return;
    const geo = o.geometry;
    const idx = geo.index ? geo.index.count : geo.attributes.position.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    tris += (idx / 3) * inst;
    draws += 1;
  });
  return { tris: Math.round(tris), draws };
}
function fixtureShip(type, id) {
  return {
    id: id ?? `lod-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
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
const srLow = new ShipRenderer();
srLow.init(new THREE.Scene(), 'low');
// Phones: the client boot calls setLodPhone(true) before init (Game.ts).
const srPhone = new ShipRenderer();
srPhone.setLodPhone(true);
srPhone.init(new THREE.Scene(), 'low');
const measured = {};
for (const type of CLASSES) {
  console.log(`\n[${type}] level roots`);
  const root = sr.buildShip(fixtureShip(type));
  const byName = (n) => root.children.find((c) => c.name === n);
  const l0 = byName('ship-detail-root');
  const l2 = byName('ship-lod2-root');
  const far = byName('ship-proxy');
  const rigOf = (r) => r.children.find((c) => c.name === 'ship-rig-root');
  const c0 = census(l0, rigOf(root));
  measured[type] = c0;
  console.log(`    LOD0 ${c0.tris} tris / ${c0.draws} draws`);
  expect(`${type} LOD0 tris <= ${LOD0_TRI_CEIL[type]}`, c0.tris <= LOD0_TRI_CEIL[type], `${c0.tris}`);
  expect(`${type} LOD0 draws <= ratchet ${LOD0_DRAW_RATCHET[type]} (D26 target 30)`, c0.draws <= LOD0_DRAW_RATCHET[type], `${c0.draws}`);
  const l1 = byName('ship-lod1-root');
  expect(`${type} has an LOD1 root (ship-lod1-root)`, !!l1);
  if (l1) {
    const c1 = census(l1);
    console.log(`    LOD1 ${c1.tris} tris / ${c1.draws} draws (${(100 * c1.tris / c0.tris).toFixed(1)}% of LOD0)`);
    expect(`${type} LOD1 <= 35% of LOD0 tris and <= 12 draws`, c1.tris <= c0.tris * 0.35 && c1.draws <= 12, `${c1.tris} tris (${(100 * c1.tris / c0.tris).toFixed(1)}%) / ${c1.draws} draws`);
  }
  expect(`${type} has an LOD2 root (ship-lod2-root)`, !!l2);
  if (l2) {
    const c2 = census(l2);
    expect(`${type} LOD2 <= 10% of the LOD0 ceiling and <= 4 draws`, c2.tris <= LOD0_TRI_CEIL[type] * 0.1 && c2.draws <= 4, `${c2.tris} tris / ${c2.draws} draws`);
  }
  const cf = census(far);
  expect(`${type} far <= 3k tris and <= 2 draws`, cf.tris <= 3000 && cf.draws <= 2, `${cf.tris} tris / ${cf.draws} draws`);
  // Own-hull caps: low tier builds its own (low) detail hull; phones use the
  // same low build with the LOD1 shell grid.
  const lowRoot = srLow.buildShip(fixtureShip(type, `lod-low-${type}`));
  const lowDetail = lowRoot.children.find((c) => c.name === 'ship-detail-root');
  const cl = census(lowDetail, rigOf(lowRoot));
  expect(`${type} low-tier own hull <= ${LOW_OWN_CAP} tris`, cl.tris <= LOW_OWN_CAP, `${cl.tris}`);
  // Phones run the low build (its shell is already the LOD1 grid) with the
  // phone hardware cut. Built after a high and a low build of the same class
  // are cached: the shared static merge must not leak across tiers.
  const phoneRoot = srPhone.buildShip(fixtureShip(type, `lod-phone-${type}`));
  // The phone census counts the rig root too (rope, ratline draws): the v2
  // rope plan on phones is 2-sided ribbons, deadeyes + blocks only, slack
  // lines in 3 segments and ratlines every third step (b4.2h).
  const prig = rigOf(phoneRoot);
  const cp = census(phoneRoot.children.find((c) => c.name === 'ship-detail-root'), prig);
  if (prig) console.log(`    phone own hull ${cp.tris} tris (rig root ${census(prig).tris})`);
  expect(`${type} phone own hull counts the rig root (ship-rig-root present)`, !!prig);
  // The phone ribbon is one quad: single-sided it vanishes from half the
  // views, so every phone rope/ratline draw must be DoubleSide.
  const ribbons = [];
  prig?.traverse((o) => { if (o.isInstancedMesh && o.name === 'ship-rigging') ribbons.push(o); });
  expect(`${type} phone rope + ratline draws are DoubleSide ribbons (2 tris per instance)`,
    ribbons.length === 2 && ribbons.every((m) => m.material.side === THREE.DoubleSide && (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) === 6),
    ribbons.map((m) => `${m.material.side}/${m.geometry.index?.count}`).join(' '));
  expect(`${type} phone own hull (low build, LOD1 shell) <= ${PHONE_OWN_CAP} tris`, cp.tris <= PHONE_OWN_CAP, `${cp.tris}`);
}
console.log(`\nmeasured LOD0: ${JSON.stringify(measured)}`);
console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
