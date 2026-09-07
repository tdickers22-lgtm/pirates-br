#!/usr/bin/env node
// GLB CENSUS — the measuring tape every collider number in src/shared/props.ts
// is cut from, and the generator behind the counts in the models README.
//
// WHY WORLD SPACE. 7 of the 63 GLBs carry node transforms (creatures, boulders,
// rowboat). Reading accessor min/max — what the audit's first census did —
// reports a pig sunk 18 cm and a boulder_b footprint of 4.75 x 2.56 when the
// real numbers are feet-at-zero and 4.50 x 3.32 (assets-25). So every POSITION
// is pushed through its node chain before anything is measured.
//
// WHY PER PRIMITIVE. A 5.7 m log, a 12 m wreck hull and a 4.8 m tent are ONE
// sphere in props.ts, so their ends are walk-through (assets-02, assets-26).
// Sub-colliders have to be cut from the parts, not from the whole, and the
// parts are the glTF primitives (one per material) plus, for a single-material
// mesh, its slices along the long axis.
//
//   node scripts/glb-census.mjs                     # table of every file
//   node scripts/glb-census.mjs --primitives NAME   # per-primitive world AABBs
//   node scripts/glb-census.mjs --slices NAME[:n]   # n slices along the long axis
//   node scripts/glb-census.mjs --check             # README counts vs disk/code
//   node scripts/glb-census.mjs --write             # rewrite the README counts line
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = path.resolve('public/assets/models');
const README = path.join(DIR, 'README.md');
const ASSET_LIB = path.resolve('src/client/assets/AssetLibrary.ts');

// ── glTF node hierarchy → world-space positions ─────────────────────────────
function quatMat(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]; }
function nodeMat(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const m = quatMat(r);
  return [m[0] * s[0], m[1] * s[0], m[2] * s[0], 0, m[3] * s[1], m[4] * s[1], m[5] * s[1], 0, m[6] * s[2], m[7] * s[2], m[8] * s[2], 0, t[0], t[1], t[2], 1];
}
function mul(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
function xf(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]; }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function emptyBox() { return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity, verts: 0, reach: 0 }; }
function grow(b, w) {
  b.verts++;
  if (w[0] < b.minX) b.minX = w[0]; if (w[0] > b.maxX) b.maxX = w[0];
  if (w[1] < b.minY) b.minY = w[1]; if (w[1] > b.maxY) b.maxY = w[1];
  if (w[2] < b.minZ) b.minZ = w[2]; if (w[2] > b.maxZ) b.maxZ = w[2];
  const r = Math.hypot(w[0], w[2]); if (r > b.reach) b.reach = r;
}
function finish(b) {
  return { ...b, halfX: (b.maxX - b.minX) / 2, halfZ: (b.maxZ - b.minZ) / 2, cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2 };
}

/** Every primitive of a GLB, with its world-space vertices and AABB. */
export function readGlb(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bl = buf.readUInt32LE(20 + jl);
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  const acc = json.accessors || [], bv = json.bufferViews || [];
  const readPos = (ai) => {
    const a = acc[ai];
    if (a.componentType !== 5126) throw new Error(`${file}: POSITION is not float32`);
    const view = bv[a.bufferView];
    const stride = view.byteStride || 12;
    const off = (view.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Array(a.count);
    for (let i = 0; i < a.count; i++) { const b = off + i * stride; out[i] = [bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)]; }
    return out;
  };
  const prims = [];
  const whole = emptyBox();
  let xforms = 0, tris = 0;
  const walk = (ni, parentM) => {
    const n = json.nodes[ni];
    if (n.matrix || n.translation || n.rotation || n.scale) xforms++;
    const m = mul(parentM, nodeMat(n));
    if (n.mesh != null) {
      for (const prim of json.meshes[n.mesh].primitives) {
        const box = emptyBox();
        const pts = [];
        for (const p of readPos(prim.attributes.POSITION)) { const w = xf(m, p); pts.push(w); grow(box, w); grow(whole, w); }
        const idxCount = prim.indices != null ? acc[prim.indices].count : box.verts;
        tris += idxCount / 3;
        prims.push({ material: json.materials?.[prim.material]?.name ?? `prim${prims.length}`, box: finish(box), pts });
      }
    }
    for (const c of n.children || []) walk(c, m);
  };
  for (const r of json.scenes[json.scene || 0].nodes) walk(r, IDENTITY);
  return { name: file.replace(/\.glb$/, ''), json, prims, bounds: finish(whole), xforms, tris: Math.round(tris), bytes: buf.length };
}

export function listGlbs() { return fs.readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort(); }

/** Counts the README states as the contract: files on disk, names loaded, unwired. */
export function censusCounts() {
  const files = listGlbs().map((f) => f.replace(/\.glb$/, ''));
  const src = fs.readFileSync(ASSET_LIB, 'utf8');
  const names = [];
  for (const key of ['ASSET_NAMES', 'FAR_ASSET_NAMES']) {
    const block = src.match(new RegExp(`${key}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!block) continue;
    // A far LOD is loaded under `<name>_far`, not under its own list entry.
    const suffix = key === 'FAR_ASSET_NAMES' ? '_far' : '';
    for (const m of block[1].matchAll(/'([a-z0-9_]+)'/g)) names.push(m[1] + suffix);
  }
  const unwired = files.filter((f) => !names.includes(f));
  const missing = names.filter((n) => !files.includes(n));
  const far = names.filter((n) => n.endsWith('_far')).length;
  return { files: files.length, loaded: names.length, near: names.length - far, far, unwired, missing };
}

const COUNTS_LINE = (c) => `Counts (generated by \`node scripts/glb-census.mjs --write\`): **${c.files} GLBs on disk = ${c.near} in \`ASSET_NAMES\` + ${c.far} \`_far\` LODs from \`FAR_ASSET_NAMES\`, ${c.unwired.length} unwired${c.unwired.length ? ` (${c.unwired.join(', ')})` : ''}.** This line is the contract — code comments quoting a different number are stale.`;
const COUNTS_RE = /^Counts \(generated by .*$/m;

function cmdCheck() {
  const c = censusCounts();
  const readme = fs.readFileSync(README, 'utf8');
  const want = COUNTS_LINE(c);
  const found = readme.match(COUNTS_RE)?.[0] ?? null;
  let bad = 0;
  if (c.missing.length) { console.error(`  ✗ ASSET_NAMES lists ${c.missing.join(', ')} with no GLB on disk`); bad++; }
  if (found === null) { console.error('  ✗ README has no generated counts line — run --write'); bad++; }
  else if (found !== want) { console.error(`  ✗ README counts are stale\n     have: ${found}\n     want: ${want}`); bad++; }
  else console.log(`  ✓ ${want}`);
  console.log(bad === 0 ? 'glb-census --check: README counts match disk + ASSET_NAMES' : `glb-census --check: ${bad} mismatch(es)`);
  process.exit(bad === 0 ? 0 : 1);
}

function cmdWrite() {
  const c = censusCounts();
  const readme = fs.readFileSync(README, 'utf8');
  const line = COUNTS_LINE(c);
  const next = COUNTS_RE.test(readme)
    ? readme.replace(COUNTS_RE, line)
    : readme.replace(/^## Environment & props$/m, `${line}\n\n## Environment & props`);
  fs.writeFileSync(README, next);
  console.log(`wrote: ${line}`);
}

function cmdPrimitives(name) {
  const g = readGlb(`${name}.glb`);
  console.log(`${name}: ${g.prims.length} primitives, ${g.tris} tris, ${g.xforms} node transforms`);
  console.log(`  whole: X [${g.bounds.minX.toFixed(2)}, ${g.bounds.maxX.toFixed(2)}]  Y [${g.bounds.minY.toFixed(2)}, ${g.bounds.maxY.toFixed(2)}]  Z [${g.bounds.minZ.toFixed(2)}, ${g.bounds.maxZ.toFixed(2)}]  halfX ${g.bounds.halfX.toFixed(2)} halfZ ${g.bounds.halfZ.toFixed(2)} reach ${g.bounds.reach.toFixed(2)}`);
  for (const p of g.prims) {
    const b = p.box;
    console.log(`  ${p.material.padEnd(16)} c(${b.cx.toFixed(2)}, ${b.cz.toFixed(2)}) half(${b.halfX.toFixed(2)}, ${b.halfZ.toFixed(2)}) maxY ${b.maxY.toFixed(2)} verts ${b.verts}`);
  }
}

/** Slice the mesh along its LONG horizontal axis and report each slice's
 *  occupied disc — this is how the log/wreck/tent sub-collider chains are cut. */
function cmdSlices(spec) {
  const [name, nRaw] = spec.split(':');
  const n = Number(nRaw || 3);
  const g = readGlb(`${name}.glb`);
  const b = g.bounds;
  const alongZ = b.halfZ >= b.halfX;
  const lo = alongZ ? b.minZ : b.minX, hi = alongZ ? b.maxZ : b.maxX;
  console.log(`${name}: ${n} slices along ${alongZ ? 'Z' : 'X'} in [${lo.toFixed(2)}, ${hi.toFixed(2)}], other-axis half ${(alongZ ? b.halfX : b.halfZ).toFixed(2)}`);
  const step = (hi - lo) / n;
  for (let i = 0; i < n; i++) {
    const s0 = lo + i * step, s1 = s0 + step;
    let aMin = Infinity, aMax = -Infinity, oMin = Infinity, oMax = -Infinity, top = -Infinity, count = 0;
    for (const p of g.prims) for (const w of p.pts) {
      const a = alongZ ? w[2] : w[0];
      if (a < s0 || a > s1) continue;
      const o = alongZ ? w[0] : w[2];
      count++;
      if (a < aMin) aMin = a; if (a > aMax) aMax = a;
      if (o < oMin) oMin = o; if (o > oMax) oMax = o;
      if (w[1] > top) top = w[1];
    }
    if (!count) { console.log(`  slice ${i}: empty`); continue; }
    const centre = (aMin + aMax) / 2, half = Math.max((aMax - aMin) / 2, (oMax - oMin) / 2);
    const off = (oMin + oMax) / 2;
    console.log(`  slice ${i}: d${alongZ ? 'z' : 'x'} ${centre.toFixed(2)}  d${alongZ ? 'x' : 'z'} ${off.toFixed(2)}  disc r ${half.toFixed(2)}  (long ${((aMax - aMin) / 2).toFixed(2)} / wide ${((oMax - oMin) / 2).toFixed(2)})  top ${top.toFixed(2)}  verts ${count}`);
  }
}

function cmdTable() {
  const c = censusCounts();
  console.log(`GLB census — ${c.files} files, ${c.loaded} loaded, ${c.unwired.length} unwired (world space, node TRS applied)`);
  console.log('  file                   tris     KB   halfX  halfZ   minY   maxY  prims  xforms');
  for (const f of listGlbs()) {
    const g = readGlb(f);
    const b = g.bounds;
    console.log(`  ${g.name.padEnd(20)} ${String(g.tris).padStart(6)} ${(g.bytes / 1024).toFixed(0).padStart(6)}  ${b.halfX.toFixed(2).padStart(6)} ${b.halfZ.toFixed(2).padStart(6)} ${b.minY.toFixed(2).padStart(6)} ${b.maxY.toFixed(2).padStart(6)} ${String(g.prims.length).padStart(6)} ${String(g.xforms).padStart(7)}`);
  }
}

// CLI only when run directly — test-prop-colliders.mjs imports readGlb, and an
// import that printed a 78-row table into another suite's output would bury it.
const args = pathToFileURL(process.argv[1] ?? '').href === import.meta.url ? process.argv.slice(2) : null;
if (args === null) { /* imported as a library */ } else {
const flag = (f) => { const i = args.indexOf(f); return i === -1 ? null : (args[i + 1] ?? ''); };
if (args.includes('--check')) cmdCheck();
else if (args.includes('--write')) cmdWrite();
else if (args.includes('--primitives')) cmdPrimitives(flag('--primitives'));
else if (args.includes('--slices')) cmdSlices(flag('--slices'));
else cmdTable();
}
