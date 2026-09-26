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
/** b1.1g: a story proxy stands in for a 25-48k tableau until the island is
 *  near, so it must be a real shape (same area/loop bar) AND a cheap one. */
export const STORY_TRIS = [2000, 4000];

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
export function readGlbTriangles(file, pickRoot = null) {
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
  const attrs = { TEXCOORD_0: 0, COLOR_0: 0, prims: 0 };
  const walk = (ni, parentM) => {
    const n = json.nodes[ni];
    const m = mul(parentM, nodeMat(n));
    if (n.mesh != null) {
      for (const prim of json.meshes[n.mesh].primitives) {
        if (prim.mode != null && prim.mode !== 4) continue; // TRIANGLES only
        attrs.prims += 1;
        if (prim.attributes.TEXCOORD_0 != null) attrs.TEXCOORD_0 += 1;
        if (prim.attributes.COLOR_0 != null) attrs.COLOR_0 += 1;
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
  for (const r of json.scenes[json.scene || 0].nodes) if (!pickRoot || pickRoot(json.nodes[r].name || '')) walk(r, IDENTITY);
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles), drawnTris, attrs };
}

/**
 * Weld at `WELD`, then count what a picture would show: boundary edges/loops,
 * non-manifold edges, and the total area. Degenerate triangles (two corners on
 * one welded vertex) carry no area and no edges, so they are dropped here.
 */
export function measureSurface({ positions, triangles, drawnTris }, { dedupe = false } = {}) {
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
  let area = 0; let degenerate = 0; let doubled = 0;
  // A triangle on the same three welded corners as one already seen (the back face of a
  // double-sided card, or an exporter's duplicate) is ONE surface on screen: counted once, so a
  // doubled card reads as the open sheet it is and its area is not counted twice. Blender's weld
  // (the build_lods census) removes such doubles; without this the lods section called a doubled
  // source card closed and its single-sided LOD "a hole" (grave_marker, gull, tavern). `dedupe`
  // is the lods-section census; the far-file section keeps its original (b1.1) census.
  const seenFace = new Set();
  for (let t = 0; t < triangles.length; t += 3) {
    const a = weldId[triangles[t]]; const b = weldId[triangles[t + 1]]; const c = weldId[triangles[t + 2]];
    if (a === b || b === c || a === c) { degenerate += 1; continue; }
    const fk = [a, b, c].sort((x, y) => x - y).join(',');
    if (dedupe && seenFace.has(fk)) { doubled += 1; continue; }
    seenFace.add(fk);
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
    drawnTris, rawVerts, welded, degenerate, doubled, area,
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

/** The story scenes whose `<name>_far.glb` proxy has shipped (AssetLibrary
 *  STORY_PROXY_NAMES): wired, so a missing file fails and the band applies. */
export function storyAssetNames() {
  const src = fs.readFileSync(ASSET_LIB, 'utf8');
  const block = src.match(/STORY_PROXY_NAMES[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('STORY_PROXY_NAMES not found in AssetLibrary.ts');
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

export function gradeAll() {
  const wired = [...farAssetNames(), ...storyAssetNames()];
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

// ── b3.4d: every asset x every level of `<key>_lods.glb` (build_lods.py) ─────────────────────
// Each level node (name ends in LOD1 / LOD2 / far, a scene root) is the same SURFACE as LOD0:
// no boundary loop the source does not have (a rock: none at all), 92%..130% of its area (130% =
// the rescale cap; more is folded spikes), and the UV / vertex-colour attributes LOD0 carries.
// Every tiered key whose tier asks for a chain has the file (skinned sources exempt: the
// character rebuild owns their chain). Mutation: PIRATES_BR_MUTATE=farlod:hole drops every 5th
// triangle of the first level graded; farlod:attr drops its COLOR_0/TEXCOORD_0 census.
export const LOD_LEVELS = ['LOD1', 'LOD2', 'far'];
export const MAX_AREA_KEEP = 1.3;
const MUTATE = (process.env.PIRATES_BR_MUTATE || '').replace(/^farlod:/, '');
const levelOf = (name) => { const m = /(?:^|[_\-.])(LOD1|LOD2|far)$/i.exec(name); return m ? (m[1].toLowerCase() === 'far' ? 'far' : m[1].toUpperCase()) : null; };

export async function lodChainKeys() {
  const { TIERS } = await import(pathToFileURL(path.resolve('scripts/test-asset-tiers.mjs')).href);
  const out = [];
  for (const t of Object.values(TIERS)) {
    if (!t.lods || t.noMesh) continue;
    for (const key of t.keys) {
      const j = JSON.parse((() => { const b = fs.readFileSync(path.join(DIR, `${key}.glb`)); return b.subarray(20, 20 + b.readUInt32LE(12)).toString(); })());
      out.push({ key, need: t.lods.need, skinned: !!(j.skins && j.skins.length) });
    }
  }
  return out;
}

export function gradeLodsFile(key, dir = DIR) {
  const src = readGlbTriangles(path.join(DIR, `${key}.glb`));
  const near = measureSurface(src, { dedupe: true });
  const file = path.join(dir, `${key}_lods.glb`);
  const buf = fs.readFileSync(file);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
  const levels = {};
  for (const r of json.scenes[json.scene || 0].nodes) {
    const n = json.nodes[r];
    const lvl = levelOf(n.name || '');
    if (lvl) levels[lvl] = { name: n.name, reuse: !!(n.extras && n.extras.lod_reuse) };
  }
  const out = [];
  let first = true;
  for (const lvl of LOD_LEVELS) {
    if (!levels[lvl]) continue;
    const tri = readGlbTriangles(file, (n) => n === levels[lvl].name);
    if (first && MUTATE === 'hole') tri.triangles = tri.triangles.filter((_, i) => Math.floor(i / 3) % 5 !== 0);
    if (first && MUTATE === 'attr') tri.attrs = { ...tri.attrs, TEXCOORD_0: 0, COLOR_0: 0 };
    first = false;
    out.push({ lvl, m: measureSurface(tri, { dedupe: true }), attrs: tri.attrs, reuse: levels[lvl].reuse });
  }
  return { key, near, srcAttrs: src.attrs, levels: out, images: (json.images || []).length };
}

/**
 * Per-level verdicts for one lods file — the ONE definition both this gate and build_lods.py
 * (which re-grades every exported file through `--lods-json` and rebuilds a level that fails)
 * use. A far level carrying `extras.lod_reuse` is the shipped `<key>_far.glb` proxy carried over
 * unwelded (flora cards, story proxies): like the shark's far puppet it is a different mesh, not
 * a decimation, so it is held to the triangle ceiling (cheaper than the level above, the story
 * band for a story key) and its area/loops are reported, not graded — the proxy itself is graded
 * as a surface by the far-file section above.
 */
export function lodVerdicts(g, stories = storyAssetNames()) {
  const rows = [];
  let above = g.near.drawnTris;
  for (const { lvl, m, attrs, reuse } of g.levels) {
    const keep = m.area / g.near.area;
    const label = `${g.key} ${lvl}: ${m.drawnTris} tris, area ${(100 * keep).toFixed(0)}%, loops ${m.boundaryLoops}/${g.near.boundaryLoops}${reuse ? ' (reused far proxy)' : ''}`;
    let why = '';
    if (m.drawnTris >= above) why += `not cheaper than the level above (${above}); `;
    if (reuse) {
      if (stories.includes(g.key) && (m.drawnTris < STORY_TRIS[0] || m.drawnTris > STORY_TRIS[1])) why += `outside the ${STORY_TRIS[0]}-${STORY_TRIS[1]} story band; `;
    } else {
      const loopsOk = isRock(g.key) ? m.boundaryLoops === 0 : m.boundaryLoops <= g.near.boundaryLoops;
      if (!loopsOk) why += 'opens a hole; ';
      if (keep < MIN_AREA_KEEP) why += 'lost surface; ';
      if (keep > MAX_AREA_KEEP) why += 'spiked surface; ';
    }
    const attrWhy = [];
    for (const a of ['TEXCOORD_0', 'COLOR_0']) {
      if (g.srcAttrs[a] > 0 && !(attrs[a] === attrs.prims && attrs.prims > 0)) attrWhy.push(`${a} on ${attrs[a]} of ${attrs.prims} primitive(s)`);
    }
    rows.push({ lvl, label, ok: !why, why: why.trim(), attrOk: attrWhy.length === 0, attrWhy: attrWhy.join('; '), reuse });
    above = m.drawnTris;
  }
  return rows;
}

async function gradeLodChains() {
  const keys = await lodChainKeys();
  const stories = storyAssetNames();
  let graded = 0; let levelsGraded = 0;
  for (const { key, need, skinned } of keys) {
    const file = path.join(DIR, `${key}_lods.glb`);
    if (skinned) { console.log(`  – ${key}: skinned source, its chain comes from the character rebuild (not graded here)`); continue; }
    expect(`${key}_lods.glb exists (tier asks for ${need.join(' + ')})`, fs.existsSync(file), 'run scripts/blender/build_lods.py');
    if (!fs.existsSync(file)) continue;
    const g = gradeLodsFile(key);
    graded += 1;
    expect(`${key}_lods.glb ships no image (levels bind LOD0's materials by name)`, g.images === 0, `${g.images} image(s)`);
    for (const v of lodVerdicts(g, stories)) {
      levelsGraded += 1;
      expect(v.label, v.ok, v.why);
      expect(`${key} ${v.lvl} keeps LOD0's TEXCOORD_0 / COLOR_0`, v.attrOk, v.attrWhy);
    }
  }
  expect(`LOD chains graded (not vacuous)`, graded >= 60 && levelsGraded >= 150, `${graded} files, ${levelsGraded} levels`);
  console.log(`  – ${graded} lods files, ${levelsGraded} levels graded`);
}

/** `--lods-json <key[,key]> [--lods-dir <dir>]`: the verdicts as JSON, for build_lods.py. */
function lodsJson() {
  const i = process.argv.indexOf('--lods-json');
  const d = process.argv.indexOf('--lods-dir');
  const dir = d > 0 ? path.resolve(process.argv[d + 1]) : DIR;
  const stories = storyAssetNames();
  const out = process.argv[i + 1].split(',').filter(Boolean).map((key) => {
    const g = gradeLodsFile(key, dir);
    return { key, levels: lodVerdicts(g, stories) };
  });
  console.log(JSON.stringify(out));
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

async function main() {
  console.log(`Far-LOD integrity — weld ${WELD}, area keep ≥ ${MIN_AREA_KEEP}, tris keep ≤ ${MAX_TRI_KEEP}`);
  const rows = gradeAll();
  printTable(rows);
  if (TABLE_ONLY) return;
  console.log('');
  console.log(`  – story proxies shipped: ${storyAssetNames().length}/15 (b1.1g2 ships the rest)`);
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
    if (storyAssetNames().includes(name)) {
      expect(`${name}_far is a ${STORY_TRIS[0]}-${STORY_TRIS[1]} triangle story proxy`,
        far.drawnTris >= STORY_TRIS[0] && far.drawnTris <= STORY_TRIS[1], `${far.drawnTris} triangles`);
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
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  if (process.argv.includes('--lods-json')) lodsJson();
  else main();
}
