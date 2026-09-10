#!/usr/bin/env node
// FAR-LOD INTEGRITY — a far sibling must be the same SURFACE, cheaper.
//
// WHY THIS SUITE HAD TO EXIST. build_far_lods.py applied a Collapse decimate to
// the exported GLBs, and the rock exports are flat-shaded with SPLIT vertices:
// every triangle owns its own three vertices, so Collapse found no shared edge to
// collapse and simply deleted faces. boulder_a's far file kept 20% of the
// triangles and 42% of the surface, with 76 boundary loops where the source has
// none; searock_a 93 loops, bush half its leaf area. Nothing graded a far file
// as a surface: test-asset-merge counts triangles, glb-census counts files, and
// test-perf-budget only ever saw the far files as CHEAPER — which holes are. On
// the low tier, which drew the far mesh at every distance, the player looked
// through the rocks.
//
// WHAT IT GRADES. Each `<name>.glb` and its `<name>_far.glb` are parsed directly
// (12-byte header, JSON chunk, BIN chunk; POSITION and indices pushed through
// the node chain the way glb-census does), positions are welded at 1e-4 so a
// split vertex becomes a shared one, and then the things a picture would show
// are counted: boundary loops (edges with exactly one face, chained into
// loops), total triangle area, triangle count.
//
//   - a ROCK's far file has no boundary loop at all (its source has none);
//   - every decimated far file keeps at least 92% of its source's surface area
//     and at most 40% of its triangles;
//   - the shark's far file is not a decimation but a different puppet
//     (build_fauna_v2.py), so it is held to the triangle ceiling and reported.
//
// Pure file arithmetic — no browser, no stack, well under a second.
//
//   node scripts/test-far-lod-integrity.mjs            # grade + table
//   node scripts/test-far-lod-integrity.mjs --table    # table only, exit 0
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DIR = path.resolve('public/assets/models');
const ASSET_LIB = path.resolve('src/client/assets/AssetLibrary.ts');
const WELD = 1e-4;
/** A far file that keeps less surface than this is not the same shape. */
export const MIN_AREA_KEEP = 0.92;
/** …and one that keeps more triangles than this is not a far LOD. */
export const MAX_TRI_KEEP = 0.4;
const TABLE_ONLY = process.argv.includes('--table');

export const isRock = (name) => /^(boulder|searock)_/.test(name);
/** The shark's far file is a rigid puppet built from scratch, not a decimation
 *  of the skinned hero, so its area is a different animal's area. */
const isDecimated = (name) => name !== 'shark';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// ── glTF node hierarchy → world-space positions (same maths as glb-census) ──
function quatMat(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]; }
function nodeMat(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0]; const r = n.rotation || [0, 0, 0, 1]; const s = n.scale || [1, 1, 1];
  const m = quatMat(r);
  return [m[0] * s[0], m[1] * s[0], m[2] * s[0], 0, m[3] * s[1], m[4] * s[1], m[5] * s[1], 0, m[6] * s[2], m[7] * s[2], m[8] * s[2], 0, t[0], t[1], t[2], 1];
}
function mul(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const INDEX_BYTES = { 5121: 1, 5123: 2, 5125: 4 };

/**
 * Every triangle of a GLB as world-space corner positions.
 * Returns { positions: Float64Array (3 per vertex), triangles: Uint32Array (3 per
 * face, indices into positions), drawnTris } — `drawnTris` is what the GPU is
 * asked for (index count / 3), before any welding drops a degenerate.
 */
export function readGlbTriangles(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB (bad magic)`);
  const jl = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file}: first chunk is not JSON`);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bl = buf.readUInt32LE(20 + jl);
  if (buf.readUInt32LE(24 + jl) !== 0x004e4942) throw new Error(`${file}: second chunk is not BIN`);
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  const acc = json.accessors || []; const bv = json.bufferViews || [];

  const readPositions = (ai) => {
    const a = acc[ai];
    if (a.componentType !== 5126 || a.type !== 'VEC3') throw new Error(`${file}: POSITION is not float32 VEC3`);
    const view = bv[a.bufferView];
    const stride = view.byteStride || 12;
    const off = (view.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float64Array(a.count * 3);
    for (let i = 0; i < a.count; i++) {
      const b = off + i * stride;
      out[i * 3] = bin.readFloatLE(b); out[i * 3 + 1] = bin.readFloatLE(b + 4); out[i * 3 + 2] = bin.readFloatLE(b + 8);
    }
    return out;
  };
  const readIndices = (ai) => {
    const a = acc[ai];
    const size = INDEX_BYTES[a.componentType];
    if (!size || a.type !== 'SCALAR') throw new Error(`${file}: indices are not u8/u16/u32 SCALAR`);
    const view = bv[a.bufferView];
    const stride = view.byteStride || size;
    const off = (view.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Uint32Array(a.count);
    for (let i = 0; i < a.count; i++) {
      const b = off + i * stride;
      out[i] = size === 1 ? bin.readUInt8(b) : size === 2 ? bin.readUInt16LE(b) : bin.readUInt32LE(b);
    }
    return out;
  };

  const positions = []; const triangles = [];
  let drawnTris = 0;
  const walk = (ni, parentM) => {
    const n = json.nodes[ni];
    const m = mul(parentM, nodeMat(n));
    if (n.mesh != null) {
      for (const prim of json.meshes[n.mesh].primitives) {
        if (prim.mode != null && prim.mode !== 4) continue; // TRIANGLES only
        const base = positions.length / 3;
        const p = readPositions(prim.attributes.POSITION);
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i]; const y = p[i + 1]; const z = p[i + 2];
          positions.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
        }
        const idx = prim.indices != null ? readIndices(prim.indices) : Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
        drawnTris += Math.floor(idx.length / 3);
        for (let i = 0; i + 2 < idx.length; i += 3) triangles.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
      }
    }
    for (const c of n.children || []) walk(c, m);
  };
  for (const r of json.scenes[json.scene || 0].nodes) walk(r, IDENTITY);
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles), drawnTris };
}

/**
 * Weld at `WELD`, then count what a picture would show: boundary edges/loops,
 * non-manifold edges, and the total area. Degenerate triangles (two corners on
 * one welded vertex) carry no area and no edges, so they are dropped here.
 */
export function measureSurface({ positions, triangles, drawnTris }) {
  const rawVerts = positions.length / 3;
  const weldId = new Int32Array(rawVerts);
  const keyToId = new Map();
  let welded = 0;
  const q = 1 / WELD;
  for (let v = 0; v < rawVerts; v++) {
    const key = `${Math.round(positions[v * 3] * q)},${Math.round(positions[v * 3 + 1] * q)},${Math.round(positions[v * 3 + 2] * q)}`;
    let id = keyToId.get(key);
    if (id === undefined) { id = welded++; keyToId.set(key, id); }
    weldId[v] = id;
  }
  const edgeFaces = new Map(); // undirected edge key → adjacent face count
  const edgeKey = (a, b) => (a < b ? a * welded + b : b * welded + a);
  let area = 0; let degenerate = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = weldId[triangles[t]]; const b = weldId[triangles[t + 1]]; const c = weldId[triangles[t + 2]];
    if (a === b || b === c || a === c) { degenerate += 1; continue; }
    const ax = positions[triangles[t] * 3]; const ay = positions[triangles[t] * 3 + 1]; const az = positions[triangles[t] * 3 + 2];
    const ux = positions[triangles[t + 1] * 3] - ax; const uy = positions[triangles[t + 1] * 3 + 1] - ay; const uz = positions[triangles[t + 1] * 3 + 2] - az;
    const vx = positions[triangles[t + 2] * 3] - ax; const vy = positions[triangles[t + 2] * 3 + 1] - ay; const vz = positions[triangles[t + 2] * 3 + 2] - az;
    const cx = uy * vz - uz * vy; const cy = uz * vx - ux * vz; const cz = ux * vy - uy * vx;
    area += Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
    for (const k of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) edgeFaces.set(k, (edgeFaces.get(k) ?? 0) + 1);
  }
  // Boundary edges chained into loops: union-find over welded vertices, joined
  // only along edges with exactly one face.
  const parent = new Int32Array(welded);
  for (let i = 0; i < welded; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let boundaryEdges = 0; let nonManifold = 0;
  const onBoundary = new Uint8Array(welded);
  for (const [k, faces] of edgeFaces) {
    if (faces > 2) nonManifold += 1;
    if (faces !== 1) continue;
    boundaryEdges += 1;
    const a = Math.floor(k / welded); const b = k - a * welded;
    onBoundary[a] = 1; onBoundary[b] = 1;
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const roots = new Set();
  for (let v = 0; v < welded; v++) if (onBoundary[v]) roots.add(find(v));
  return {
    drawnTris, rawVerts, welded, degenerate, area,
    boundaryEdges, boundaryLoops: roots.size, nonManifold,
  };
}

/** The names AssetLibrary loads a `_far` sibling for, read off the source. */
export function farAssetNames() {
  const src = fs.readFileSync(ASSET_LIB, 'utf8');
  const block = src.match(/FAR_ASSET_NAMES[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('FAR_ASSET_NAMES not found in AssetLibrary.ts');
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

export function gradeAll() {
  const wired = farAssetNames();
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('_far.glb')).map((f) => f.slice(0, -'_far.glb'.length));
  const names = [...new Set([...wired, ...onDisk])].sort();
  const rows = [];
  for (const name of names) {
    const nearFile = path.join(DIR, `${name}.glb`);
    const farFile = path.join(DIR, `${name}_far.glb`);
    if (!fs.existsSync(nearFile) || !fs.existsSync(farFile)) {
      rows.push({ name, missing: !fs.existsSync(nearFile) ? nearFile : farFile });
      continue;
    }
    const near = measureSurface(readGlbTriangles(nearFile));
    const far = measureSurface(readGlbTriangles(farFile));
    rows.push({ name, near, far, wired: wired.includes(name) });
  }
  return rows;
}

function printTable(rows) {
  const head = ['asset', 'near tris', 'far tris', 'keep', 'near loops', 'far loops', 'near area', 'far area', 'area%', 'far nonmani'];
  const widths = [14, 9, 8, 6, 10, 9, 9, 8, 6, 11];
  const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
  console.log(line(head));
  for (const r of rows) {
    if (r.missing) { console.log(line([r.name, 'MISSING', r.missing, '', '', '', '', '', '', ''])); continue; }
    console.log(line([
      r.name, r.near.drawnTris, r.far.drawnTris, `${(100 * r.far.drawnTris / r.near.drawnTris).toFixed(0)}%`,
      r.near.boundaryLoops, r.far.boundaryLoops,
      r.near.area.toFixed(2), r.far.area.toFixed(2), `${(100 * r.far.area / r.near.area).toFixed(0)}%`,
      r.far.nonManifold,
    ]));
  }
}

function main() {
  console.log(`Far-LOD integrity — weld ${WELD}, area keep ≥ ${MIN_AREA_KEEP}, tris keep ≤ ${MAX_TRI_KEEP}`);
  const rows = gradeAll();
  printTable(rows);
  if (TABLE_ONLY) return;
  console.log('');
  expect('every far file on disk has a source, and every wired far asset has a file', rows.every((r) => !r.missing),
    rows.filter((r) => r.missing).map((r) => `${r.name}: ${r.missing}`).join('; '));
  for (const r of rows) {
    if (r.missing) continue;
    const { name, near, far } = r;
    expect(`${name}_far draws ≤ ${Math.round(MAX_TRI_KEEP * 100)}% of the source's triangles`,
      far.drawnTris <= near.drawnTris * MAX_TRI_KEEP,
      `${far.drawnTris} of ${near.drawnTris} (${(100 * far.drawnTris / near.drawnTris).toFixed(0)}%)`);
    if (isRock(name)) {
      expect(`${name}_far is watertight (0 boundary loops after welding)`,
        far.boundaryLoops === 0,
        `${far.boundaryLoops} boundary loop(s) over ${far.boundaryEdges} open edge(s); source has ${near.boundaryLoops} — Collapse ran on split vertices and deleted faces`);
    } else {
      expect(`${name}_far opens no more boundary loops than its source`,
        far.boundaryLoops <= near.boundaryLoops,
        `${far.boundaryLoops} loop(s) vs source ${near.boundaryLoops}`);
    }
    if (isDecimated(name)) {
      expect(`${name}_far keeps ≥ ${Math.round(MIN_AREA_KEEP * 100)}% of the source's surface area`,
        far.area >= near.area * MIN_AREA_KEEP,
        `${far.area.toFixed(2)} of ${near.area.toFixed(2)} m² (${(100 * far.area / near.area).toFixed(0)}%) — the missing surface is the holes`);
    } else {
      console.log(`  – ${name}_far is a different puppet, not a decimation: area ${far.area.toFixed(2)} vs ${near.area.toFixed(2)} m² reported, not graded`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} far-LOD integrity failure(s).`);
    process.exit(1);
  }
  console.log('\nFar-LOD integrity passed.');
}

// The parser and the census are importable (build_far_lods.py mirrors them in
// Blender; one-off analyses reuse them); only a direct run grades.
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) main();
