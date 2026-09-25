// THE CHARACTER ASSET'S CONTRACT (D25, b3.2a) — pure node, no browser, no GPU, no THREE.
//
// WHY. The pirate stops being a procedural blob (sphere head, no eyes, no UVs: characters-01) and
// becomes the Quaternius CC0 anatomy on the UE-style skeleton, normalised by
// scripts/blender/build_pirates.py (stage module _pirate_import.py). Everything downstream (clips,
// wardrobe, LODs, the face rig, the hitbox) assumes facts nobody can see once the GLB is a binary blob:
//
//   * the SKELETON is the 57-bone NAMED set (65 kit bones minus the 12 leaf bones, plus eye_l/eye_r and,
//     since R1 F4, lid_upper_l/lid_upper_r).
//     Named, not counted: a rig with 55 wrong bones must fail;
//   * the DRAWN HEAD CENTRE is PLAYER.HEAD_Y (1.62 +- 0.02). src/shared/constants documents HEAD_Y as
//     the centre of the drawn head AND of the server headshot sphere (AVATAR-01); the crown may not rise
//     more than 3 cm over PLAYER.HEIGHT and the soles sit on the origin;
//   * the head BONE is an anatomical pivot inside the head's lower half (between chin and centre), so the
//     look solver turns the skull, not the neck base or the crown;
//   * EYES: an eye mesh whose every vertex is weighted to eye_l (the +X eyeball) or eye_r, so the face
//     rig (b3.2g) can aim them;
//   * every mesh primitive has UV0 (textures and the b3.2e atlas need it);
//   * PROPORTIONS (D25, SoT family, not superhero): height / head height in [6.5, 7]; hand length
//     (wrist joint to fingertip) 1.1-1.2x a realistic hand (0.108 x height);
//   * BODY TYPES are real variety, not a rename: the stout's waist (between the pelvis joint and
//     spine_02, trunk-weighted vertices only, so the T-posed arms never count) is 1.3-1.7x the male's
//     width and >= 1.35x its depth, and <= 1.7x either (a sailor, not a balloon). R1 lineup, b3.2a2: the
//     first 3 cm inflate measured 1.15 / 1.20 and read as the same man;
//   * R1 review fixes (review-R1.json, 2026-09-25), each measured here so it cannot silently regress:
//     F1 the stout carries mass BEYOND the waist (upper arm, thigh and neck girth >= 1.22x the male's) and
//        (b3.2a2 red: 1.12 / 1.16 / 1.14, which R1 still read as the male: bar 1.22) and
//        its belly shows no printed abs (belly normal-map relief <= 0.15x the kit map at the same UVs);
//     F2 no superhero physique: torso normal relief <= 0.45x the kit map on every body; deltoid cap and lat
//        flare measured against the b3.2a2 ceilings (PHYSIQUE: deltoid -8%, V-taper -4%);
//     F3 hair, beard and brows carry a dark tint as their baseColorFactor (linear luma <= 0.12), the brows (lash cards)
//        cast no shadow, and every hair_* node says whether it is a default style (pirateDefault extras);
//     F4 lid bones: upper-lid skin + upper lash cards weighted to lid_upper_l/r; rotating them by the
//        reported closeDeg about +X covers >= 95% of the iris with skin and no lid vertex enters the eyeball;
//        at rest the lid covers < 50% (open).
//   * PROVENANCE (characters-10, D37): every third-party source the build reports has a row in
//     public/assets/models/LICENSES.md and its kit licence text (CC0) is vendored next to it; every
//     material has a normal map and none still points at the Godot export's missing *_png.png copies.
//
// Vertex positions are rest-pose SKINNED (sum of w * joint world * inverse bind), so a wrong bind
// matrix cannot hide behind a correct-looking POSITION accessor.
//
//   node --import tsx scripts/test-character-asset.mjs              # the three stage-1 bodies
//   node --import tsx scripts/test-character-asset.mjs --glb <file> # grade any GLB (red run: pirate_base.glb)
import { readFileSync, existsSync } from 'node:fs';
import { PLAYER } from '../src/shared/constants/index.ts';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_ARG = process.argv.indexOf('--out');   // red runs: grade a copy of an older out/ (GLBs + report)
const OUT = OUT_ARG > 0 ? process.argv[OUT_ARG + 1].replace(/\/$/, '') : `${ROOT}assets-src/quaternius/out`;
const BODIES = ['male', 'female', 'stout'];
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const SIDE = (s) => [`clavicle_${s}`, `upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`,
  ...FINGERS.flatMap((f) => [1, 2, 3].map((i) => `${f}_0${i}_${s}`)),
  `thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`, `eye_${s}`, `lid_upper_${s}`];
export const BONES = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', ...SIDE('l'), ...SIDE('r')];
const HAND_REAL = 0.108;

let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── glTF plumbing ─────────────────────────────────────────────────────────
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  const jl = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const bin = buf.length > 28 + jl ? buf.subarray(28 + jl, 28 + jl + buf.readUInt32LE(20 + jl)) : Buffer.alloc(0);
  return { gltf, bin };
}
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor({ gltf, bin }, i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const n = NCOMP[a.type];
  const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
  const stride = bv.byteStride || n * size;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const rd = { 5126: (o) => bin.readFloatLE(o), 5125: (o) => bin.readUInt32LE(o), 5123: (o) => bin.readUInt16LE(o), 5121: (o) => bin.readUInt8(o) }[a.componentType];
  const norm = a.normalized ? { 5123: 65535, 5121: 255 }[a.componentType] : 1;
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(rd(base + k * stride + c * size) / norm);
    out.push(row);
  }
  return out;
}
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) { // column-major 4x4
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
const xf = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
function worlds(gltf) {
  const W = new Array(gltf.nodes.length);
  const visit = (i, parent) => { W[i] = mul(parent, trs(gltf.nodes[i])); for (const c of gltf.nodes[i].children ?? []) visit(c, W[i]); };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes.map((_, i) => i);
  for (const r of roots) visit(r, I4);
  return W;
}

// rest-pose skinned vertices of one mesh node + each vertex's dominant joint name
function skinned(g, W, nodeIdx, wantJoint = null) {
  const { gltf } = g;
  const node = gltf.nodes[nodeIdx];
  const skin = gltf.skins?.[node.skin];
  const out = [];
  for (const prim of gltf.meshes[node.mesh].primitives) {
    const P = accessor(g, prim.attributes.POSITION);
    const UV = prim.attributes.TEXCOORD_0 !== undefined ? accessor(g, prim.attributes.TEXCOORD_0) : null;
    const C = prim.attributes.COLOR_0 !== undefined ? accessor(g, prim.attributes.COLOR_0) : null;
    const base = out.length;
    if (!skin || prim.attributes.JOINTS_0 === undefined) { for (const p of P) out.push({ p: xf(W[nodeIdx], p), j: null }); continue; }
    const J = accessor(g, prim.attributes.JOINTS_0);
    const Wt = accessor(g, prim.attributes.WEIGHTS_0);
    const ibm = accessor(g, skin.inverseBindMatrices);
    const M = skin.joints.map((jn, k) => mul(W[jn], ibm[k]));
    for (let v = 0; v < P.length; v++) {
      const acc = [0, 0, 0];
      let best = -1; let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = Wt[v][k]; if (!w) continue;
        const q = xf(M[J[v][k]], P[v]);
        acc[0] += w * q[0]; acc[1] += w * q[1]; acc[2] += w * q[2];
        if (w > bw) { bw = w; best = J[v][k]; }
      }
      let wj = 0;
      if (wantJoint) for (let k = 0; k < 4; k++) if (gltf.nodes[skin.joints[J[v][k]]]?.name === wantJoint) wj += Wt[v][k];
      out.push({ p: acc, j: gltf.nodes[skin.joints[best]]?.name ?? null, wj });
    }
    if (prim.indices !== undefined) {
      const I = accessor(g, prim.indices);
      out.tris ??= [];
      for (let k = 0; k + 2 < I.length; k += 3) out.tris.push([base + I[k][0], base + I[k + 1][0], base + I[k + 2][0]]);
    }
    for (let v = 0; v < P.length; v++) { if (UV) out[base + v].uv = UV[v]; if (C) out[base + v].c = C[v]; out[base + v].mat = prim.material; }
  }
  return out;
}

const TRUNK = new Set(['pelvis', 'spine_01', 'spine_02', 'spine_03']);
function waist(path) { // [width (x), depth (z, glTF front)] of the trunk between the pelvis joint and spine_02
  if (!existsSync(path)) return null;
  const g = readGlb(path);
  const W = worlds(g.gltf);
  const skin = g.gltf.skins?.[0];
  const bodyI = g.gltf.nodes.findIndex((n) => n.mesh !== undefined && /^body$/i.test(n.name ?? ''));
  if (bodyI < 0 || !skin) return null;
  const at = (b) => { const k = skin.joints.findIndex((j) => g.gltf.nodes[j].name === b); return k < 0 ? null : xf(W[skin.joints[k]], [0, 0, 0])[1]; };
  const lo = at('pelvis') + 0.05; const hi = at('spine_02');
  const vs = skinned(g, W, bodyI).filter((v) => TRUNK.has(v.j) && v.p[1] >= lo && v.p[1] <= hi);
  const span = (k) => Math.max(...vs.map((v) => v.p[k])) - Math.min(...vs.map((v) => v.p[k]));
  return vs.length ? [span(0), span(2)] : null;
}


// ── R1 review metrics ─────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const rotX = (d, deg) => { const t = deg * Math.PI / 180; return [d[0], d[1] * Math.cos(t) - d[2] * Math.sin(t), d[1] * Math.sin(t) + d[2] * Math.cos(t)]; };
function loadGlb(path) {
  if (!existsSync(path)) return null;
  const g = readGlb(path); const W = worlds(g.gltf); const skin = g.gltf.skins?.[0];
  const joint = (b) => { const k = skin.joints.findIndex((j) => g.gltf.nodes[j].name === b); return k < 0 ? null : xf(W[skin.joints[k]], [0, 0, 0]); };
  const bodyI = g.gltf.nodes.findIndex((n) => n.mesh !== undefined && /^body$/i.test(n.name ?? ''));
  return { g, W, skin, joint, bodyI, body: skinned(g, W, bodyI) };
}
// p90 distance from a bone's axis of the vertices it dominates, between fractions t0..t1 of the bone
function girth(L, bone, child, t0 = 0.25, t1 = 0.65) {
  const a = L.joint(bone); const b = L.joint(child); if (!a || !b) return 0;
  const ax = sub(b, a); const l = len(ax); const u = unit(ax);
  const r = [];
  for (const v of L.body) {
    if (v.j !== bone) continue;
    const d = sub(v.p, a); const t = dot(d, u) / l;
    if (t < t0 || t > t1) continue;
    r.push(len(sub(d, [u[0] * t * l, u[1] * t * l, u[2] * t * l])));
  }
  r.sort((x, y) => x - y);
  return r.length ? r[Math.floor(r.length * 0.9)] : 0;
}
function heightOf(L) { const ys = L.body.map((v) => v.p[1]); return Math.max(...ys) - Math.min(...ys); }
// V-taper: trunk-dominated width at the armpit band / waist width (the T-posed arms never count)
function vTaper(L, path) {
  const lo = L.joint('spine_03')[1]; const hi = L.joint('upperarm_l')[1] - 0.03;
  const xs = L.body.filter((v) => TRUNK.has(v.j) && v.p[1] >= lo && v.p[1] <= hi).map((v) => v.p[0]);
  return xs.length ? (Math.max(...xs) - Math.min(...xs)) / waist(path)[0] : 0;
}
const imgCache = new Map();
async function img(rel) {
  if (!imgCache.has(rel)) {
    const p = `${ROOT}${rel}`;
    imgCache.set(rel, existsSync(p) ? await sharp(p).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => ({ data, w: info.width, h: info.height, ch: info.channels })) : null);
  }
  return imgCache.get(rel);
}
function devAt(I, u, v) { // mean |xy| of the tangent normal in a 5x5 texel patch = relief
  let s = 0; let n = 0;
  const cx = Math.floor((u - Math.floor(u)) * I.w); const cy = Math.floor((v - Math.floor(v)) * I.h);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = Math.min(I.w - 1, Math.max(0, cx + dx)); const y = Math.min(I.h - 1, Math.max(0, cy + dy));
    const o = (y * I.w + x) * I.ch;
    s += Math.hypot(I.data[o] / 127.5 - 1, I.data[o + 1] / 127.5 - 1); n++;
  }
  return s / n;
}
// relief of the shipped body normal map vs the kit map at the same UVs, over the vertices `keep` selects
async function relief(L, rep, bodyId, keep) {
  const vs = L.body.filter((v) => v.uv && keep(v));
  if (!vs.length) return { ratio: 1, why: 'no vertices' };
  const matName = L.g.gltf.materials?.[vs[0].mat]?.name;
  const shipped = rep?.materials?.[matName]?.normal;
  const kit = rep?.bodies?.[bodyId]?.normal?.kit ?? shipped;
  const A = shipped && await img(shipped); const K = kit && await img(kit);
  if (!A || !K) return { ratio: 1, why: `normal map missing (${shipped} / ${kit}); node assets-src/quaternius/fetch.mjs` };
  let a = 0; let k = 0;
  for (const v of vs) { a += devAt(A, v.uv[0], v.uv[1]); k += devAt(K, v.uv[0], v.uv[1]); }
  return { ratio: k ? a / k : 1, why: `${matName}: ${vs.length} vertices, relief ${(a / vs.length).toFixed(3)} vs kit ${(k / vs.length).toFixed(3)}` };
}

function lidChecks(g, W, gltf, names, skin, bodyI, eyesI, closeFromReport) {
  const nodeOf = (b) => gltf.nodes[skin.joints[names.indexOf(b)]];
  const browsI = gltf.nodes.findIndex((n) => n.mesh !== undefined && /^brows$/i.test(n.name ?? ''));
  for (const s of ['l', 'r']) {
    const lid = `lid_upper_${s}`;
    if (!names.includes(lid) || eyesI === undefined) { expect(`${lid} present with an eye mesh`, false); continue; }
    const c = xf(W[skin.joints[names.indexOf(`eye_${s}`)]], [0, 0, 0]);
    const side = (p) => (p[0] > 0) === (s === 'l');
    const all = skinned(g, W, bodyI, lid);
    const bv = all.filter((v) => side(v.p) && v.wj > 0.01);
    const lash = browsI >= 0 ? skinned(g, W, browsI, lid).filter((v) => v.wj > 0.5).length : 0;
    expect(`${lid}: upper-lid skin (${bv.filter((v) => v.wj > 0.3).length} verts) and upper lash cards (${lash}) follow it`,
      bv.filter((v) => v.wj > 0.3).length >= 15 && lash >= 6);
    const close = nodeOf(lid)?.extras?.closeDeg ?? closeFromReport?.[s]?.closeDeg;
    if (!(close > 0)) { expect(`${lid}: closeDeg reported (joint extras or build report)`, false); continue; }
    const eye = skinned(g, W, eyesI).filter((v) => side(v.p)).map((v) => sub(v.p, c));
    const rEye = Math.max(...eye.map(len));
    const cosI = Math.cos(25 * Math.PI / 180); const cosS = Math.cos(10 * Math.PI / 180);
    const iris = eye.filter((d) => len(d) > 1e-6 && unit(d)[2] > cosI);
    // the skin around this eye (every body triangle with a vertex within r + 1.5 cm), posed by the lid bone
    const near = new Set(all.map((v, i) => [v, i]).filter(([v]) => side(v.p) && len(sub(v.p, c)) < rEye + 0.015).map(([, i]) => i));
    const tris = (all.tris ?? []).filter((t) => t.some((i) => near.has(i)));
    const posedAt = (deg) => all.map((v) => { const d = sub(v.p, c); if (!(v.wj > 0)) return d; const q = rotX(d, deg); return [d[0] + (q[0] - d[0]) * v.wj, d[1] + (q[1] - d[1]) * v.wj, d[2] + (q[2] - d[2]) * v.wj]; });
    // ray from the eye centre through each iris vertex: covered when it hits skin at or beyond the iris
    const hitT = (u, P, [a, b, cc]) => { // Moller-Trumbore, origin 0
      const e1 = sub(P[b], P[a]); const e2 = sub(P[cc], P[a]);
      const px = [u[1] * e2[2] - u[2] * e2[1], u[2] * e2[0] - u[0] * e2[2], u[0] * e2[1] - u[1] * e2[0]];
      const det = dot(e1, px); if (Math.abs(det) < 1e-14) return -1;
      const tv = [-P[a][0], -P[a][1], -P[a][2]]; const uu = dot(tv, px) / det; if (uu < 0 || uu > 1) return -1;
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const vv = dot(u, qv) / det; if (vv < 0 || uu + vv > 1) return -1;
      return dot(e2, qv) / det;
    };
    const cover = (deg) => { const P = posedAt(deg); return iris.filter((d) => { const u = unit(d); const r = len(d); return tris.some((t) => hitT(u, P, t) >= r - 0.0003); }).length / (iris.length || 1); };
    const surf = (u) => { let b = 0; for (const e of eye) if (dot(unit(e), u) > cosS) b = Math.max(b, len(e)); return b; };
    const open = cover(0); const shut = cover(close);
    let poke = 0;
    for (const f of [0.5, 1]) { const P = posedAt(close * f); for (const v of bv) { const q = P[all.indexOf(v)]; if (unit(q)[2] > 0 && len(q) < surf(unit(q)) - 0.0005) poke++; } }
    expect(`${lid}: open at rest (iris covered ${(open * 100).toFixed(0)}% < 50%)`, open < 0.5);
    expect(`${lid}: closed by ${close} deg about +X covers ${(shut * 100).toFixed(0)}% of the iris (>= 95%)`, shut >= 0.95);
    expect(`${lid}: no lid vertex inside the eyeball at half and full close (${poke})`, poke === 0);
  }
}

function hairChecks(gltf, g, W) {
  const hairs = gltf.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.mesh !== undefined && /^hair_/i.test(n.name ?? ''));
  const tagged = hairs.filter(({ n }) => typeof n.extras?.pirateDefault === 'boolean');
  const defaults = hairs.filter(({ n }) => n.extras?.pirateDefault === true);
  expect(`every hair_* node says whether it is a default style (${tagged.length}/${hairs.length}, ${defaults.length} default)`,
    hairs.length > 0 && tagged.length === hairs.length && defaults.length >= 1 && defaults.length < hairs.length);
  const brows = gltf.nodes.map((n, i) => ({ n, i })).find(({ n }) => /^brows$/i.test(n.name ?? '') && n.mesh !== undefined);
  expect('brows (lash cards) cast no shadow (extras.castShadow === false)', brows?.n.extras?.castShadow === false);
  for (const { n } of [...defaults, ...(brows ? [brows] : [])]) {
    const mats = [...new Set(gltf.meshes[n.mesh].primitives.map((p) => p.material))].map((k) => gltf.materials[k]);
    const f = mats.map((m) => m?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]);
    const luma = Math.max(...f.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]));
    expect(`${n.name}: dark hair tint as baseColorFactor (linear luma ${luma.toFixed(3)} <= 0.12; the kit map is grey)`, luma <= 0.12);
  }
}

function grade(path, label, closeFromReport = null) {
  console.log(`\n${label} (${path.replace(ROOT, '')})`);
  if (!existsSync(path)) { expect(`${label} exists`, false, 'build: Blender -b --factory-startup -P scripts/blender/build_pirates.py'); return; }
  const g = readGlb(path);
  const { gltf } = g;
  const W = worlds(gltf);
  const skin = gltf.skins?.[0];
  const names = (skin?.joints ?? []).map((j) => gltf.nodes[j].name);
  const missing = BONES.filter((b) => !names.includes(b));
  const extra = names.filter((b) => !BONES.includes(b));
  expect(`skeleton is the 57-bone named set (has ${names.length})`, missing.length === 0 && extra.length === 0,
    `missing ${missing.length}: ${missing.slice(0, 12).join(' ')}${missing.length > 12 ? ' ...' : ''}; extra ${extra.length}: ${extra.slice(0, 8).join(' ')}`);

  const meshNodes = gltf.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.mesh !== undefined);
  const noUv = meshNodes.filter(({ n }) => gltf.meshes[n.mesh].primitives.some((p) => p.attributes.TEXCOORD_0 === undefined));
  expect(`every mesh has UV0 (${meshNodes.length - noUv.length}/${meshNodes.length})`, meshNodes.length > 0 && noUv.length === 0,
    `no UV0: ${noUv.map(({ n }) => n.name).join(', ')}`);

  const nodeIdx = (re) => meshNodes.find(({ n }) => re.test(n.name ?? ''))?.i;
  const eyesI = nodeIdx(/^eyes?$/i);
  expect('eye mesh present', eyesI !== undefined, `mesh nodes: ${meshNodes.map(({ n }) => n.name).join(', ')}`);
  const jointWorld = (b) => { const k = names.indexOf(b); return k < 0 ? null : xf(W[skin.joints[k]], [0, 0, 0]); };
  expect('eye bones eye_l / eye_r present', !!jointWorld('eye_l') && !!jointWorld('eye_r'));
  if (eyesI !== undefined && jointWorld('eye_l')) {
    const ev = skinned(g, W, eyesI);
    const wrong = ev.filter((v) => v.j !== (v.p[0] > 0 ? 'eye_l' : 'eye_r')).length;
    expect(`every eyeball vertex follows its own eye bone (${ev.length - wrong}/${ev.length})`, wrong === 0);
    const el = jointWorld('eye_l');
    expect(`eye_l is the +X eyeball, in front of the head (x ${el[0].toFixed(3)}, z ${el[2].toFixed(3)})`, el[0] > 0.01 && el[2] > 0.03);
  }

  const bodyI = nodeIdx(/^body$/i) ?? meshNodes[0]?.i;
  if (bodyI === undefined || !skin) { expect('skinned body mesh present', false); return; }
  const bv = skinned(g, W, bodyI);
  const ys = bv.map((v) => v.p[1]);
  const crown = Math.max(...ys); const sole = Math.min(...ys);
  const headV = bv.filter((v) => v.j === 'head' || v.j === 'eye_l' || v.j === 'eye_r');
  if (!headV.length) { expect('head-weighted body vertices exist', false); return; }
  const chin = Math.min(...headV.map((v) => v.p[1]));
  const centre = (crown + chin) / 2;
  const height = crown - sole;
  const headH = crown - chin;
  expect(`drawn head centre at PLAYER.HEAD_Y ${PLAYER.HEAD_Y} +- 0.02 (${centre.toFixed(3)})`, Math.abs(centre - PLAYER.HEAD_Y) <= 0.02);
  expect(`crown within 3 cm of PLAYER.HEIGHT ${PLAYER.HEIGHT} (${crown.toFixed(3)})`, crown <= PLAYER.HEIGHT + 0.03 && crown >= PLAYER.HEIGHT - 0.08);
  expect(`soles on the origin (${sole.toFixed(3)})`, sole >= -0.03 && sole <= 0.02);
  const hj = jointWorld('head');
  expect(`head bone is a pivot in the head's lower half (chin ${chin.toFixed(3)} <= ${hj?.[1].toFixed(3)} <= centre ${centre.toFixed(3)})`,
    !!hj && hj[1] >= chin - 0.01 && hj[1] <= centre);
  const ratio = height / headH;
  expect(`head:height 1:${ratio.toFixed(2)} in 1:6.5-7`, ratio >= 6.5 && ratio <= 7);
  const handSet = new Set(['hand_l', ...FINGERS.flatMap((f) => [1, 2, 3].map((i) => `${f}_0${i}_l`))]);
  const wrist = jointWorld('hand_l');
  const hv = bv.filter((v) => handSet.has(v.j));
  const hand = wrist && hv.length ? Math.max(...hv.map((v) => Math.hypot(v.p[0] - wrist[0], v.p[1] - wrist[1], v.p[2] - wrist[2]))) : 0;
  const hr = hand / (HAND_REAL * height);
  expect(`hands ${hr.toFixed(2)}x a real hand (${hand.toFixed(3)} m) in 1.1-1.2x`, hr >= 1.1 && hr <= 1.2);
  lidChecks(g, W, gltf, names, skin, bodyI, eyesI, closeFromReport);
  hairChecks(gltf, g, W);
}

const argv = process.argv.slice(2);
if (argv.includes('--glb')) {
  console.log('Character asset contract (one file)');
  grade(argv[argv.indexOf('--glb') + 1], 'graded file');
} else {
  console.log('Character asset contract (stage 1: normalised CC0 base, three body types)');
  const rep0 = existsSync(`${OUT}/pirate_base.report.json`) ? JSON.parse(readFileSync(`${OUT}/pirate_base.report.json`, 'utf8')) : null;
  for (const b of BODIES) grade(`${OUT}/pirate_base_${b}.glb`, `body ${b}`, rep0?.bodies?.[b]?.lids);

  console.log('\nbody types');
  const wm = waist(`${OUT}/pirate_base_male.glb`); const ws = waist(`${OUT}/pirate_base_stout.glb`);
  const f = (w) => (w ? `${w[0].toFixed(3)} x ${w[1].toFixed(3)} m` : 'n/a');
  expect(`stout waist 1.3-1.7x the male's width and 1.35-1.7x its depth (male ${f(wm)}, stout ${f(ws)})`,
    !!wm && !!ws && ws[0] >= 1.3 * wm[0] && ws[1] >= 1.35 * wm[1] && ws[0] <= 1.7 * wm[0] && ws[1] <= 1.7 * wm[1],
    wm && ws ? `ratios ${(ws[0] / wm[0]).toFixed(2)} / ${(ws[1] / wm[1]).toFixed(2)}` : '');

  console.log('\nR1 F1: the stout is heavier everywhere, not only at the waist');
  const Lm = loadGlb(`${OUT}/pirate_base_male.glb`); const Ls = loadGlb(`${OUT}/pirate_base_stout.glb`); const Lf = loadGlb(`${OUT}/pirate_base_female.glb`);
  if (Lm && Ls) {
    for (const [bone, child] of [['upperarm_l', 'lowerarm_l'], ['thigh_l', 'calf_l'], ['neck_01', 'head']]) {
      const gm = girth(Lm, bone, child); const gs = girth(Ls, bone, child);
      expect(`stout ${bone} girth ${(gs / gm).toFixed(2)}x the male's (${gs.toFixed(3)} vs ${gm.toFixed(3)} m, >= 1.22; b3.2a2 red 1.12-1.16)`, gm > 0 && gs >= 1.22 * gm);
    }
    const bl = await relief(Ls, rep0, 'stout', (v) => TRUNK.has(v.j) && v.p[1] > Ls.joint('pelvis')[1] + 0.05 && v.p[1] < Ls.joint('spine_02')[1] + 0.05 && v.p[2] > Ls.joint('spine_01')[2]);
    // sculpted relief: mean |p - mean(neighbours)| over the welded belly positions (the kit sculpts the abs)
    const lap = (L) => {
      const key = (p) => p.map((x) => x.toFixed(4)).join(',');
      const nb = new Map(); const pos = new Map();
      for (const t of L.body.tris ?? []) for (let a = 0; a < 3; a++) {
        const ka = key(L.body[t[a]].p); const kb = key(L.body[t[(a + 1) % 3]].p); if (ka === kb) continue;
        pos.set(ka, L.body[t[a]].p); pos.set(kb, L.body[t[(a + 1) % 3]].p);
        (nb.get(ka) ?? nb.set(ka, new Set()).get(ka)).add(kb); (nb.get(kb) ?? nb.set(kb, new Set()).get(kb)).add(ka);
      }
      const lo = L.joint('pelvis')[1] + 0.05; const hi = L.joint('spine_03')[1]; const zf = L.joint('spine_01')[2] + 0.03;
      const sel = L.body.filter((v) => TRUNK.has(v.j) && v.p[1] > lo && v.p[1] < hi && v.p[2] > zf).map((v) => key(v.p));
      let s = 0; let n = 0;
      for (const k of new Set(sel)) { const ns = [...(nb.get(k) ?? [])]; if (!ns.length) continue; const m = [0, 1, 2].map((c) => ns.reduce((a, q) => a + pos.get(q)[c], 0) / ns.length); s += len(sub(pos.get(k), m)); n++; }
      return n ? s / n : 0;
    };
    const lm = lap(Lm); const ls = lap(Ls);
    // red (b3.2a2, 3ab60c66): stout 8.32 mm, male 5.46 mm. A round gut keeps some curvature Laplacian, so the
    // bar is half the reviewed stout AND no more relief than the (itself softened) male abdomen.
    expect(`stout belly sculpt relief ${(ls * 1000).toFixed(2)} mm <= 4.16 (half of b3.2a2's 8.32) and <= the male's ${(lm * 1000).toFixed(2)} mm: no 8-pack modelled into the gut`, lm > 0 && ls <= 0.00416 && ls <= lm);
    expect(`stout belly normal relief ${bl.ratio.toFixed(2)}x the kit map (<= 0.15: no abs printed on the gut)`, bl.ratio <= 0.15, bl.why);
  } else expect('male and stout GLBs present', false);

  console.log('\nR1 F2: SoT family, not superhero (every body)');
  // ceilings = the b3.2a2 (3ab60c66) value minus the R1 ask. Red: male deltoid 0.0542 x height, V-taper 1.316;
  // female 0.0351, 0.893. Ask: bi-deltoid -8-10% (ceiling -8%), lat flare softened (V-taper -4%).
  const PHYSIQUE = { male: { deltoid: 0.0499, vTaper: 1.263 }, female: { deltoid: 0.0323, vTaper: 0.857 } };
  for (const [b, L] of [['male', Lm], ['female', Lf]]) {
    if (!L) { expect(`${b} GLB present`, false); continue; }
    const d = girth(L, 'upperarm_l', 'lowerarm_l', 0.0, 0.25) / heightOf(L); const vt = vTaper(L, `${OUT}/pirate_base_${b}.glb`);
    console.log(`  (${b}: deltoid cap ${d.toFixed(4)} x height, V-taper ${vt.toFixed(3)})`);
    expect(`${b}: deltoid cap ${d.toFixed(4)} x height <= ${PHYSIQUE[b].deltoid}`, d <= PHYSIQUE[b].deltoid);
    expect(`${b}: V-taper (armpit / waist width) ${vt.toFixed(3)} <= ${PHYSIQUE[b].vTaper}`, vt <= PHYSIQUE[b].vTaper);
    const tr = await relief(L, rep0, b, (v) => TRUNK.has(v.j));
    expect(`${b}: torso normal relief ${tr.ratio.toFixed(2)}x the kit map (<= 0.45, strength ~0.35)`, tr.ratio <= 0.45, tr.why);
  }

  console.log('\nprovenance and materials');
  const repPath = `${OUT}/pirate_base.report.json`;
  const rep = existsSync(repPath) ? JSON.parse(readFileSync(repPath, 'utf8')) : null;
  expect('build report present', !!rep);
  const lic = existsSync(`${ROOT}public/assets/models/LICENSES.md`) ? readFileSync(`${ROOT}public/assets/models/LICENSES.md`, 'utf8') : '';
  for (const s of rep?.sources ?? []) expect(`LICENSES.md has a row for ${s}`, lic.includes(`| ${s} |`));
  for (const [dir, f] of [['ubc', 'License_Standard.txt'], ['mco', 'License_Standard.txt'], ['ual1', 'License.txt'], ['ual2', 'License.txt']]) {
    const p = `${ROOT}assets-src/quaternius/${dir}/${f}`;
    expect(`vendored licence text ${dir}/${f} is CC0`, existsSync(p) && /CC0/.test(readFileSync(p, 'utf8')));
  }
  const mats = Object.entries(rep?.materials ?? {});
  const noNormal = mats.filter(([, s]) => !s.normal).map(([m]) => m);
  expect(`every material has a normal map (${mats.length - noNormal.length}/${mats.length})`, mats.length > 0 && noNormal.length === 0, noNormal.join(', '));
  const stale = mats.filter(([, s]) => Object.values(s).some((p) => /_png\.png$/.test(p))).map(([m]) => m);
  expect('no material points at a missing *_png.png copy (re-pointed)', stale.length === 0, stale.join(', '));
  for (const b of BODIES) {
    const r = rep?.bodies?.[b];
    expect(`${b}: build reports no missing image`, !!r && !(r.missingImages?.length), (r?.missingImages ?? []).join(', '));
  }
}

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
