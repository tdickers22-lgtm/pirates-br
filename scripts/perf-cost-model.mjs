// RESIDENT GEOMETRY COST MODEL — the census perf-15 is graded against.
//
// WHY. docs/FRAME_COST_MODEL.md section 5 measured "ship 25.7 MB — more than a
// third of all geometry bytes, more than the five largest islands put
// together", because every hull merged and kept a PRIVATE copy of planking,
// rails, masts and deck furniture. Ten to twenty-four hulls of three classes,
// and the static half of each is byte-identical to every other hull of its
// class. Nothing in the frame budget notices: draw calls and triangles are
// unchanged, it is pure resident memory — which is exactly the thing that
// bites an integrated-GPU laptop and this fanless Air.
//
// WHAT IT MEASURES. Two fleets, built by the real ShipRenderer under the canvas
// stub, with every BufferGeometry counted ONCE by object identity so a shared
// buffer is billed once no matter how many hulls draw it.
//   1. The worst case any MODE can float: hull class is a pure function of crew
//      size and a match is one mode (PLAN section 2.1), so the most hulls at sea
//      at once is Solo's twelve cutters, one class. Budget: under 8 MB.
//   2. An over-provisioned twenty-four-hull fleet across all three classes, which
//      no mode can produce. Not the budget — a headroom tripwire that catches the
//      sharing breaking for one class only. Ceiling 12 MB.
//
//   node --import tsx scripts/perf-cost-model.mjs [--no-cache] [--json]
//
// `--no-cache` rebuilds each hull with the shared merge disabled — i.e. the
// behaviour before this lane — and the gate must FAIL. That is its red proof.
// It also runs the fleet with __shipMergeVerify set, which re-merges on every
// cache hit and throws if the shared buffer would draw a different shape from
// the one this hull asked for: the cache cannot silently be wrong.
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');

const NO_CACHE = process.argv.includes('--no-cache');
const JSON_OUT = process.argv.includes('--json');
// Disabling the cache is how the gate proves it can fail: mergeStaticMeshes
// reads this before it consults the shared map.
if (NO_CACHE) globalThis.__shipMergeNoCache = true;
else globalThis.__shipMergeVerify = true;

const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { sharedShipGeometryCensus, resetSharedShipGeometry } = await import('../src/client/rendering/ship/geometry.ts');

const BUDGET_BYTES = 8 * 1024 * 1024;
const HEADROOM_BYTES = 12 * 1024 * 1024;
/** The most hulls any mode can float at once: Solo's twelve cutters (PLAN 2.1). */
const MATCH_FLEET = [['sloop', 12]];
/** Deliberately impossible: every class at once, so every class pays a prototype. */
const WIDE_FLEET = [['sloop', 12], ['brigantine', 6], ['galleon', 6]];

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function fixtureShip(type, i) {
  const stats = SHIP_STATS[type];
  return {
    id: `${type}-${i}`, type,
    position: { x: i * 60, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    health: stats.maxHealth, maxHealth: stats.maxHealth,
    sailAngle: 0, sailOpen: 1, speed: 0, crew: [], holes: [],
    waterLevel: 0, sinking: false, anchored: false,
    repairCooldown: 0, autoRepairProgress: 0,
    // Distinct team colours on purpose: colour must NOT fork the geometry.
    teamColor: [0x3366cc, 0xcc5533, 0x33aa66, 0xaa33aa][i % 4],
    alive: true, upgrades: [],
  };
}

function geometryBytes(geo) {
  let bytes = 0;
  for (const name of Object.keys(geo.attributes)) bytes += geo.attributes[name].array?.byteLength ?? 0;
  if (geo.index) bytes += geo.index.array?.byteLength ?? 0;
  return bytes;
}

function census(fleet, label) {
  resetSharedShipGeometry();
  const scene = new THREE.Scene();
  const sr = new ShipRenderer();
  sr.init(scene, 'balanced');
  const ships = [];
  let n = 0;
  for (const [type, count] of fleet) {
    for (let i = 0; i < count; i++) { const s = fixtureShip(type, n++); ships.push(s); sr.buildShip(s); }
  }
  sr.update(ships, [], 0, 1 / 60, 0);

  // Unique BufferGeometry by object IDENTITY: a buffer shared by ten hulls is
  // billed once, which is the whole point of perf-15.
  const seen = new Set();
  let bytes = 0, geos = 0, meshes = 0;
  const perName = new Map();
  for (const ship of ships) {
    const root = sr.getShipGroup(ship.id);
    if (!root) continue;
    root.traverse((o) => {
      const geo = o.geometry;
      if (!geo || !geo.attributes?.position) return;
      meshes += 1;
      if (seen.has(geo)) return;
      seen.add(geo);
      const b = geometryBytes(geo);
      bytes += b; geos += 1;
      const key = (Array.isArray(o.material) ? o.material[0]?.name : o.material?.name) || o.name || '(unnamed)';
      perName.set(key, (perName.get(key) ?? 0) + b);
    });
  }
  const shared = sharedShipGeometryCensus();
  console.log(`\n[${label}] ${ships.length} hulls (${fleet.map(([t, c]) => `${c} ${t}`).join(', ')})`);
  console.log(`  drawn meshes   ${meshes}   unique geometries ${geos}`);
  console.log(`  ship geometry  ${mb(bytes)}`);
  console.log(`  shared merges  ${shared.entries} entries, ${mb(shared.bytes)}, refs ${shared.byKey.reduce((a, e) => a + e.refs, 0)}`);
  console.log('  heaviest surfaces: ' + [...perName].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, b]) => `${k} ${mb(b)}`).join(', '));
  return { sr, ships, bytes, geos, meshes, shared };
}

const mb = (b) => `${(b / (1024 * 1024)).toFixed(2)} MB`;
console.log(`RESIDENT GEOMETRY COST MODEL${NO_CACHE ? '  [--no-cache: the pre-perf-15 behaviour; this run must FAIL]' : ''}`);

// The mode's own worst case. PLAN section 2.1: hull class is a pure function of
// crew size and a match is ONE mode, so the most hulls that can be afloat at
// once is Solo's twelve cutters — twelve hulls of ONE class. This is the number
// the 8 MB budget is against.
const match = census(MATCH_FLEET, 'worst-case match');
expect(`resident ship geometry under ${mb(BUDGET_BYTES)} for a full match`, match.bytes < BUDGET_BYTES,
  `${mb(match.bytes)} across ${match.geos} unique geometries for ${match.ships.length} hulls`);
expect('the census is not vacuous (the fleet actually drew)',
  match.meshes > 200 && match.bytes > 512 * 1024, `${match.meshes} meshes, ${mb(match.bytes)}`);
if (!NO_CACHE) {
  expect('hulls of one class share one set of merged buffers',
    match.shared.entries > 0 && match.shared.byKey.some((e) => e.refs >= 6),
    `${match.shared.entries} shared entries, max refs ${Math.max(0, ...match.shared.byKey.map((e) => e.refs))}`);
  match.sr.clear();
  const after = sharedShipGeometryCensus();
  expect('clear() releases every shared buffer exactly once (no leak, no early free)',
    after.entries === 0, `${after.entries} entries still held, ${mb(after.bytes)}`);
}

// Headroom: a fleet no mode can produce — twenty-four hulls across all three
// classes, so every class pays its own prototype. Not the budget, but a
// regression here means the sharing stopped working for one of the classes.
const wide = census(WIDE_FLEET, 'over-provisioned (no mode can field this)');
expect(`over-provisioned three-class fleet under ${mb(HEADROOM_BYTES)}`, wide.bytes < HEADROOM_BYTES,
  `${mb(wide.bytes)} across ${wide.geos} unique geometries for ${wide.ships.length} hulls`);
if (JSON_OUT) console.log(JSON.stringify({ match: match.bytes, wide: wide.bytes, budget: BUDGET_BYTES }, null, 2));
wide.sr.clear();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
