// GLB BOUNDS vs COLLIDERS — pure node, parses every public/assets/models/*.glb.
//
// WHY. Nothing tied a GLB's footprint to src/shared/props.ts: the kraken tableau
// grew 1.8x in Blender while its collider did not (props.ts says so in a
// comment), boulder_b blocks 0.35 m of air all round, the driftwood log's
// sphere covers a third of the log. Every rebuild can move a base or a
// footprint and no test notices until a player walks into air or through rock
// (assets-18). And the naive way to write this gate — accessor min/max — is
// wrong for 7 of the 63 files: creatures carry node transforms that put their
// feet at 0 while the accessor says -0.18, and the boulders carry the opposite
// (accessor -0.08, world +0.54). So every POSITION is transformed through the
// node hierarchy first (assets-25).
//
// WHAT. World-space bounds per file, then:
//   (a) a sphere/capsule collider is no wider than the mesh it stands for:
//       sphere radius ≤ 1.05 × the world AABB half-extent (a rounded mass never
//       fills its box); capsule radius ≤ 1.05 × the furthest XZ reach from the
//       prop origin (trunks and crates may reach their corners);
//       and for the SOLID_MASS set (rocks, log, wreck) no narrower than 0.5×;
//   (b) a 'none' scene with a spacing override reserves ≥ 0.9 × its half-extent;
//   (c) every file's world minY is pinned: within [-0.05, 0.03] of the ground,
//       or exactly the authored lift/skirt in PINNED_BASE ± 0.05 — a rebuild
//       that moves a base by more than that fails here first;
//   (d) walking creatures stand with their feet at 0 (±0.02).
// `PIRATES_BR_MUTATE_BASE=boulder_a:0.9` overrides one pinned value; the gate
// must then FAIL (its proof it can).
//
// RED ON HEAD (2026-09-02): boulder_b r 2.6 vs half-extent 2.25, boulder_c 1.1 vs 0.75,
// driftwood_log 1.1 vs 2.9 (0.38×), shipwreck 2.6 vs 6.1 (0.43×), whale_skeleton
// spacing 10 vs 13.3. Pig / chicken / crab PASS (world feet at 0.000).
//
//   node --import tsx scripts/test-asset-bounds.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PROP_COLLIDERS, getPropSpacingRadius } from '../src/shared/props.ts';

const DIR = path.resolve('public/assets/models');
let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── GLB reader with node TRS ────────────────────────────────────────────────
function quatMat(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]; }
function nodeMat(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1]; const m = quatMat(r);
  return [m[0] * s[0], m[1] * s[0], m[2] * s[0], 0, m[3] * s[1], m[4] * s[1], m[5] * s[1], 0, m[6] * s[2], m[7] * s[2], m[8] * s[2], 0, t[0], t[1], t[2], 1];
}
function mul(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
function xf(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]; }

function worldBounds(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bl = buf.readUInt32LE(20 + jl);
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  const acc = json.accessors || [], bv = json.bufferViews || [];
  const readPos = (ai) => {
    const a = acc[ai]; if (a.componentType !== 5126) throw new Error(`${file}: POSITION accessor is not float32 (componentType ${a.componentType})`);
    const view = bv[a.bufferView]; const stride = view.byteStride || 12; const off = (view.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Array(a.count);
    for (let i = 0; i < a.count; i++) { const b = off + i * stride; out[i] = [bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)]; }
    return out;
  };
  const W = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity, reach: 0, verts: 0, xforms: 0 };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const walk = (ni, parentM) => {
    const n = json.nodes[ni];
    if (n.matrix || n.translation || n.rotation || n.scale) W.xforms++;
    const m = mul(parentM, nodeMat(n));
    if (n.mesh != null) for (const prim of json.meshes[n.mesh].primitives) {
      for (const p of readPos(prim.attributes.POSITION)) {
        const w = xf(m, p); W.verts++;
        if (w[0] < W.minX) W.minX = w[0]; if (w[0] > W.maxX) W.maxX = w[0];
        if (w[1] < W.minY) W.minY = w[1]; if (w[1] > W.maxY) W.maxY = w[1];
        if (w[2] < W.minZ) W.minZ = w[2]; if (w[2] > W.maxZ) W.maxZ = w[2];
        const r = Math.hypot(w[0], w[2]); if (r > W.reach) W.reach = r;
      }
    }
    for (const c of n.children || []) walk(c, m);
  };
  for (const r of json.scenes[json.scene || 0].nodes) walk(r, I);
  return { ...W, halfX: (W.maxX - W.minX) / 2, halfZ: (W.maxZ - W.minZ) / 2 };
}

// ── rules ───────────────────────────────────────────────────────────────────
const GROUND_MIN = -0.05, GROUND_MAX = 0.03, PIN_TOL = 0.05;
const RADIUS_MAX_RATIO = 1.05, RADIUS_MIN_RATIO = 0.5, SPACING_MIN_RATIO = 0.9;
/** Compact solid masses whose sphere must cover the mesh, not just a core. */
const SOLID_MASS = new Set(['boulder_a', 'boulder_b', 'boulder_c', 'driftwood_log', 'shipwreck', 'campfire']);
const WALKERS = ['pig', 'chicken', 'crab'];
/** Authored lifts (boulders sit on a +0.62 Blender base that propBaseLift
 *  neutralises client-side) and skirts (pads / roots sunk into the terrain so
 *  slopes never show air). Measured world-space on 2026-09-02; a rebuild that
 *  moves one by more than PIN_TOL fails here. */
const PINNED_BASE = {
  boulder_a: 0.537, boulder_b: 0.137, boulder_c: 0.337,
  crag: -1.55, searock_a: -1.026, searock_b: -1.268, searock_c: -0.785,
  castaway_camp: -3.4, crow_roost: -0.342, dig_site: -0.541, fort: -5.006, gallows: -0.611,
  kraken_wreck: -2.503, mermaid_shrine: -0.151, mine_head: -3.028, parley_table: -0.217,
  rock_arch: -0.286, rum_still: -3.0, shipwreck: -0.078, signal_pyre: -0.15, skull_totem: -0.387,
  smuggler_cache: -3.0, standing_stones: -0.181, watchtower: -0.21, whale_skeleton: -1.238,
  wrecker_tower: -2.2, driftwood_log: -0.232, bone_pile: -0.113, tent_a: -0.063, tent_b: -0.132,
  tent_c: -0.131, flower_patch: -0.089, widow_memorial: -0.089, gibbet_cage: -0.066,
  rowboat: -0.092, shark: -0.48,
};
const mutate = process.env.PIRATES_BR_MUTATE_BASE ?? '';
if (mutate) {
  const [name, val] = mutate.split(':');
  PINNED_BASE[name] = Number(val);
  console.log(`  ! mutation: PINNED_BASE.${name} = ${val} (PIRATES_BR_MUTATE_BASE)`);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort();
console.log(`GLB bounds vs colliders — ${files.length} files, world-space (node TRS applied)`);
console.log('  file                  worldMinY  maxY   halfX  halfZ  reach  xforms');
const rows = new Map();
for (const f of files) {
  const b = worldBounds(f);
  const name = f.replace(/\.glb$/, '');
  rows.set(name, b);
  console.log(`  ${name.padEnd(20)} ${b.minY.toFixed(3).padStart(8)} ${b.maxY.toFixed(2).padStart(6)} ${b.halfX.toFixed(2).padStart(6)} ${b.halfZ.toFixed(2).padStart(6)} ${b.reach.toFixed(2).padStart(6)}  ${b.xforms}`);
}

console.log('\n[a] collider radius vs mesh reach');
for (const [type, col] of Object.entries(PROP_COLLIDERS)) {
  const b = rows.get(type);
  if (!b) { console.log(`  – ${type}: no GLB (procedural), skipped`); continue; }
  if (col.shape === 'none' || col.subColliders?.length) continue;
  // A SPHERE stands for a rounded mass that never fills its box, so its ceiling
  // is the box half-extent; a CAPSULE (trunk, post, crate) may reach the corner.
  const limit = col.shape === 'sphere' ? Math.max(b.halfX, b.halfZ) : b.reach;
  const ratio = col.radius / limit;
  expect(`${type}: ${col.shape} r ${col.radius} ≤ ${RADIUS_MAX_RATIO}× mesh ${col.shape === 'sphere' ? 'half-extent' : 'reach'} ${limit.toFixed(2)} (${ratio.toFixed(2)}×)`,
    ratio <= RADIUS_MAX_RATIO, `${(col.radius - limit).toFixed(2)} m of invisible blocking ground`);
  if (SOLID_MASS.has(type)) {
    const cover = col.radius / b.reach;
    expect(`${type}: solid mass — r ${col.radius} ≥ ${RADIUS_MIN_RATIO}× reach ${b.reach.toFixed(2)} (${cover.toFixed(2)}×)`,
      cover >= RADIUS_MIN_RATIO, 'players walk through the ends of the mesh');
  }
}

console.log('\n[b] scene spacing vs footprint');
for (const [type, col] of Object.entries(PROP_COLLIDERS)) {
  const b = rows.get(type);
  if (!b || col.shape !== 'none') continue;
  const spacing = getPropSpacingRadius(type, 1);
  if (spacing === 0) continue; // foliage: walk-through and unreserved by design
  const half = Math.max(b.halfX, b.halfZ);
  expect(`${type}: spacing ${spacing} ≥ ${SPACING_MIN_RATIO}× half-extent ${half.toFixed(2)}`, spacing >= SPACING_MIN_RATIO * half,
    'scatter can grow through the scene');
}

console.log('\n[c] bases: on the ground or pinned');
for (const [name, b] of rows) {
  if (WALKERS.includes(name) || name === 'gull') continue;
  if (name in PINNED_BASE) {
    const want = PINNED_BASE[name];
    expect(`${name}: pinned base ${want} (measured ${b.minY.toFixed(3)})`, Math.abs(b.minY - want) <= PIN_TOL,
      `authored lift/skirt moved by ${(b.minY - want).toFixed(3)} m — update PINNED_BASE only if the rebuild meant it`);
  } else {
    expect(`${name}: base ${b.minY.toFixed(3)} in [${GROUND_MIN}, ${GROUND_MAX}]`, b.minY >= GROUND_MIN && b.minY <= GROUND_MAX,
      b.minY > GROUND_MAX ? 'floats above its seat' : 'sinks below it; add to PINNED_BASE if that is an authored skirt');
  }
}

console.log('\n[d] walking creatures');
for (const name of WALKERS) {
  const b = rows.get(name);
  if (!b) { expect(`${name}.glb present`, false); continue; }
  expect(`${name}: feet at 0 in world space (${b.minY.toFixed(3)}; accessor-local would read lower)`, Math.abs(b.minY) <= 0.02);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
