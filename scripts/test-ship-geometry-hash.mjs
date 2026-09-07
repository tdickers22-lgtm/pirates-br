// SHIP GEOMETRY HASH — the refactor seatbelt for HULLGEO-01.
//
// WHY. ShipRenderer is 5,100 lines and this campaign moves most of it into
// `src/client/rendering/ship/*`. A "pure move" that quietly changes a constant,
// drops a mesh from a merge set or reorders a group is invisible to every other
// gate: test-ship-geometry only grades vertices against the loft (a wrong-but-
// inside part passes), and no browser suite runs on a logic tier. So the moves
// get their own snapshot: the exact drawn geometry of all three hulls, hashed.
//
// WHAT. For each hull class the renderer builds under the canvas stub, the gate
// records, in traversal order, every visible mesh's material family, its vertex
// and index counts, and an FNV-1a hash of its WORLD-space positions quantised to
// 0.1 mm. Per family it also keeps a world AABB rounded to 1 mm. Those are
// compared against `scripts/fixtures/ship-geometry.snapshot.json`.
//
// HOW IT IS USED. A slice that intends no geometry change runs it and it must be
// green. A slice that intends change rebuilds the baseline with `--update` IN
// THE SAME COMMIT and says in the message which families moved and why; the diff
// of the snapshot is then a reviewable list of what the slice touched.
//
//   node --import tsx scripts/test-ship-geometry-hash.mjs [--update] [--mutate]
//
// `--mutate` nudges one deck vertex by 1 cm and the gate must FAIL: its proof it
// can. RED PROOF (2026-09-06, HEAD 90d23fa0): with --mutate, sloop digest
// 6f3a…≠ baseline and family ship-deck-planking reports a moved AABB.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');

const UPDATE = process.argv.includes('--update');
const MUTATE = process.argv.includes('--mutate');
const SNAPSHOT = new URL('./fixtures/ship-geometry.snapshot.json', import.meta.url);

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

/** FNV-1a over quantised floats — order-sensitive, so a reordered merge shows. */
function hashInit() { return 0x811c9dc5; }
function hashNum(h, n) {
  const q = Math.round(n * 10000) | 0; // 0.1 mm
  for (let b = 0; b < 4; b++) {
    h ^= (q >>> (b * 8)) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function hashStr(h, s) {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

function fixtureShip(type) {
  return {
    id: `hash-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

// The renderer scatters barrels, rope coils and crate jitter with Math.random
// (client cosmetics — the determinism rule binds src/server and src/shared, not
// this). A snapshot of "the drawn geometry" cannot compare noise, so the gate
// PINS the stream: mulberry32 reseeded to the same value before every hull, in
// build order. Anything the renderer draws from that stream is then reproducible
// and a real change to it still shows up as a family diff.
const realRandom = Math.random;
function pinRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
pinRandom(0x51ED7A11);

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'high');
const v = new THREE.Vector3();

function censusHull(type) {
  pinRandom(0x51ED7A11);
  const root = sr.buildShip(fixtureShip(type));
  if (MUTATE) {
    let done = false;
    root.traverse((o) => {
      if (done || !o.isMesh || o.material?.name !== 'ship-deck-planking') return;
      const pos = o.geometry.attributes.position;
      pos.setY(0, pos.getY(0) + 0.01);
      pos.needsUpdate = true;
      done = true;
    });
    if (done) console.log('  ! mutation: one deck-planking vertex raised 1 cm');
  }
  root.updateMatrixWorld(true);

  let digest = hashInit();
  let meshCount = 0, vertTotal = 0;
  const families = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let vis = o.visible;
    for (let q = o.parent; q && q !== root; q = q.parent) if (!q.visible) vis = false;
    if (!vis) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;
    const family = o.material?.name || o.name || o.material?.type || '?';
    meshCount += 1;
    vertTotal += pos.count;
    digest = hashStr(digest, family);
    digest = hashNum(digest, pos.count);
    digest = hashNum(digest, o.geometry.index ? o.geometry.index.count : 0);
    const rec = families.get(family) ?? { meshes: 0, verts: 0, tris: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], h: hashInit() };
    rec.meshes += 1;
    rec.verts += pos.count;
    rec.tris += Math.floor((o.geometry.index ? o.geometry.index.count : pos.count) / 3) * (o.isInstancedMesh ? o.count : 1);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      digest = hashNum(hashNum(hashNum(digest, v.x), v.y), v.z);
      rec.h = hashNum(hashNum(hashNum(rec.h, v.x), v.y), v.z);
      if (v.x < rec.box[0]) rec.box[0] = v.x;
      if (v.y < rec.box[1]) rec.box[1] = v.y;
      if (v.z < rec.box[2]) rec.box[2] = v.z;
      if (v.x > rec.box[3]) rec.box[3] = v.x;
      if (v.y > rec.box[4]) rec.box[4] = v.y;
      if (v.z > rec.box[5]) rec.box[5] = v.z;
    }
    families.set(family, rec);
  });

  const out = { digest: hex(digest), meshCount, vertTotal, families: {} };
  for (const key of [...families.keys()].sort()) {
    const r = families.get(key);
    out.families[key] = {
      meshes: r.meshes, verts: r.verts, tris: r.tris, hash: hex(r.h),
      box: r.box.map((n) => +n.toFixed(3)),
    };
  }
  return out;
}

const current = {};
for (const type of ['sloop', 'brigantine', 'galleon']) current[type] = censusHull(type);
Math.random = realRandom;

if (UPDATE) {
  writeFileSync(SNAPSHOT, `${JSON.stringify({
    note: 'Baseline for scripts/test-ship-geometry-hash.mjs. Rebuild ONLY inside a slice that intends the geometry change, and name the moved families in the commit.',
    hulls: current,
  }, null, 2)}\n`);
  console.log(`\nbaseline written: ${SNAPSHOT.pathname}`);
  for (const t of Object.keys(current)) console.log(`  ${t}: digest ${current[t].digest}  ${current[t].meshCount} meshes  ${current[t].vertTotal} verts  ${Object.keys(current[t].families).length} families`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT)) {
  console.error('✗ FAIL: no baseline — run with --update inside the slice that owns the change');
  process.exit(1);
}
const base = JSON.parse(readFileSync(SNAPSHOT, 'utf8')).hulls;

for (const type of ['sloop', 'brigantine', 'galleon']) {
  const b = base[type], c = current[type];
  console.log(`\n[${type}] ${c.meshCount} meshes, ${c.vertTotal} verts, digest ${c.digest}`);
  if (!b) { expect(`${type}: present in the baseline`, false, 'baseline has no entry for this hull'); continue; }
  const famNames = [...new Set([...Object.keys(b.families), ...Object.keys(c.families)])].sort();
  const moved = [];
  for (const f of famNames) {
    const bf = b.families[f], cf = c.families[f];
    if (!bf) { moved.push(`+${f} (new family, ${cf.meshes} meshes)`); continue; }
    if (!cf) { moved.push(`-${f} (family gone, was ${bf.meshes} meshes)`); continue; }
    if (bf.hash !== cf.hash || bf.verts !== cf.verts || bf.meshes !== cf.meshes) {
      moved.push(`${f}: ${bf.meshes}m/${bf.verts}v ${bf.hash} → ${cf.meshes}m/${cf.verts}v ${cf.hash}  box ${JSON.stringify(bf.box)} → ${JSON.stringify(cf.box)}`);
    }
  }
  expect(`${type}: drawn geometry byte-identical to the baseline (${famNames.length} families)`, moved.length === 0 && b.digest === c.digest,
    moved.length ? moved.join('\n     ') : `digest ${b.digest} → ${c.digest} with no family diff (mesh ORDER changed: ${b.meshCount}→${c.meshCount} meshes)`);
}

console.log(`\n${checks} checks, ${failures} failed${MUTATE ? ' (mutated run: a failure is the expected outcome)' : ''}`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
