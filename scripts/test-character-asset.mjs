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
import { readFileSync, existsSync, statSync } from 'node:fs';
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
    // R1 re-review F5: closing the lid must not tear the brows. Brow cards = brows-mesh islands (welded
    // positions + triangles) whose centroid sits more than half an eye radius above the eye centre; at closeDeg
    // none of their vertices moves > 0.5 mm, and no body vertex above eyeCentre + r + 4 mm moves > 1 mm.
    // Red (64788b33, reviewer lidleak.json): brows moved up to 25.4 mm, skin up to 25.8 mm above the eye.
    const P1 = posedAt(close);
    const skinHi = all.reduce((m, v, i) => (side(v.p) && v.p[1] - c[1] > rEye + 0.004 ? Math.max(m, len(sub(P1[i], sub(v.p, c)))) : m), 0);
    expect(`${lid}: no skin above the lid crease (eye + r + 4 mm) moves > 1 mm when closed (${(skinHi * 1000).toFixed(1)} mm)`, skinHi <= 0.001);
    if (browsI >= 0) {
      const bw = skinned(g, W, browsI, lid);
      const key = (p) => p.map((x) => x.toFixed(4)).join(',');
      const par = new Map(); const find = (k) => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
      for (const v of bw) if (!par.has(key(v.p))) par.set(key(v.p), key(v.p));
      for (const t of bw.tris ?? []) for (let a = 1; a < 3; a++) par.set(find(key(bw[t[a]].p)), find(key(bw[t[0]].p)));
      const isl = new Map();
      bw.forEach((v, i) => { if (!side(v.p)) return; const r = find(key(v.p)); (isl.get(r) ?? isl.set(r, []).get(r)).push(i); });
      let browMove = 0; let nBrow = 0;
      for (const ids of isl.values()) {
        const cy = ids.reduce((a, i) => a + bw[i].p[1], 0) / ids.length - c[1];
        if (cy <= 0.5 * rEye) continue;
        nBrow += ids.length;
        for (const i of ids) { const v = bw[i]; if (!(v.wj > 0)) continue; const d = sub(v.p, c); browMove = Math.max(browMove, v.wj * len(sub(rotX(d, close), d))); }
      }
      expect(`${lid}: brow cards (${nBrow} verts outside the lash islands) move <= 0.5 mm when the lid closes (${(browMove * 1000).toFixed(1)} mm)`, nBrow > 0 && browMove <= 0.0005);
    }
  }
}

// R1 re-review F3: the kit 'Dark' albedo paints a desaturated grey-green patch under and inside each eye. Mean hue
// (circular) and HSV saturation of the shipped albedo under the eye must sit near the cheek below it.
function hueSat(I, uvs) {
  let sx = 0; let sy = 0; let ss = 0; let n = 0;
  for (const [u, v] of uvs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = Math.min(I.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * I.w) + dx));
    const y = Math.min(I.h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * I.h) + dy));
    const o = (y * I.w + x) * I.ch; const r = I.data[o] / 255; const gg = I.data[o + 1] / 255; const b = I.data[o + 2] / 255;
    const mx = Math.max(r, gg, b); const mn = Math.min(r, gg, b); const d = mx - mn;
    let h = 0; if (d > 1e-6) h = mx === r ? ((gg - b) / d) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
    h *= Math.PI / 3; const s = mx > 0 ? d / mx : 0;
    sx += Math.cos(h) * s; sy += Math.sin(h) * s; ss += s; n++;
  }
  return { hue: ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360, sat: n ? ss / n : 0, n };
}
async function periocular(L, rep, bodyId) {
  const body = L.body; const mat = L.g.gltf.materials?.[body.find((v) => v.uv)?.mat]?.name;
  const I = rep?.materials?.[mat]?.a && await img(rep.materials[mat].a);
  if (!I) return null;
  const out = [];
  for (const s of ['l', 'r']) {
    const c = L.joint(`eye_${s}`); const r = rep?.bodies?.[bodyId]?.lids?.eyeRadius?.[s] ?? 0.019;
    const rel = body.filter((v) => v.uv && v.j === 'head').map((v) => ({ uv: v.uv, d: sub(v.p, c) })).filter(({ d }) => d[2] > 0);
    const under = rel.filter(({ d }) => Math.abs(d[0]) < 0.9 * r && d[1] < -0.45 * r && d[1] > -(r + 0.010)).map((x) => x.uv);
    const cheek = rel.filter(({ d }) => Math.abs(d[0]) < 1.2 * r && d[1] < -(r + 0.020) && d[1] > -(r + 0.035)).map((x) => x.uv);
    out.push({ s, under: hueSat(I, under), cheek: hueSat(I, cheek), file: rep.materials[mat].a });
  }
  return out;
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

  let lap = () => 0;
  console.log('\nR1 F1: the stout is heavier everywhere, not only at the waist');
  const Lm = loadGlb(`${OUT}/pirate_base_male.glb`); const Ls = loadGlb(`${OUT}/pirate_base_stout.glb`); const Lf = loadGlb(`${OUT}/pirate_base_female.glb`);
  if (Lm && Ls) {
    for (const [bone, child] of [['upperarm_l', 'lowerarm_l'], ['thigh_l', 'calf_l'], ['neck_01', 'head']]) {
      const gm = girth(Lm, bone, child); const gs = girth(Ls, bone, child);
      expect(`stout ${bone} girth ${(gs / gm).toFixed(2)}x the male's (${gs.toFixed(3)} vs ${gm.toFixed(3)} m, >= 1.22; b3.2a2 red 1.12-1.16)`, gm > 0 && gs >= 1.22 * gm);
    }
    const bl = await relief(Ls, rep0, 'stout', (v) => TRUNK.has(v.j) && v.p[1] > Ls.joint('pelvis')[1] + 0.05 && v.p[1] < Ls.joint('spine_02')[1] + 0.05 && v.p[2] > Ls.joint('spine_01')[2]);
    // sculpted relief: mean |p - mean(neighbours)| over the welded belly positions (the kit sculpts the abs)
    lap = (L) => {
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
    // R1 re-review: the male abdomen is now smoothed harder (2.55 mm) than a round gut can go without losing its
    // curvature, so the stout bar is the value the re-review graded PASS on the stout (3.72 mm, tighter than 4.16).
    expect(`stout belly sculpt relief ${(ls * 1000).toFixed(2)} mm <= 3.72 (R1 re-review pass; b3.2a2 red 8.32; male now ${(lm * 1000).toFixed(2)} mm): no 8-pack modelled into the gut`, lm > 0 && ls <= 0.00372);
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

  console.log('\nR1 re-review F2 (male) and F3 (every body)');
  if (Lm) {
    const lmx = lap(Lm);
    // red (64788b33): 4.29 mm, still a readable 8-pack at 4 m (tt-noon-front.png). Ceiling 3.2 mm (-25%).
    expect(`male abdomen sculpt relief ${(lmx * 1000).toFixed(2)} mm <= 3.20: no geometric 8-pack at 4 m`, lmx > 0 && lmx <= 0.0032);
    // R1 re-review F2, second pass (b3.2b): the Laplacian went green (2.55 mm) and the 8-pack still read, because the
    // kit 'Dark' albedo PAINTS the ab/pec shading and the 0.37x normal still carries the grooves. Three measures the
    // vertex metric cannot see: albedo luminance CV over the abdomen vs the kit albedo, abdomen normal relief vs the
    // kit map, and the rendered high-pass contrast inside the abdomen box of the fixed-camera torso shot.
    const abd = (v) => TRUNK.has(v.j) && v.p[1] > Lm.joint('pelvis')[1] + 0.05 && v.p[1] < Lm.joint('spine_03')[1] + 0.06 && v.p[2] > Lm.joint('spine_01')[2] + 0.03;
    const mat = Lm.g.gltf.materials?.[Lm.body.find((v) => v.uv)?.mat]?.name;
    const shippedA = rep0?.materials?.[mat]?.a; const kitA = rep0?.bodies?.male?.baseColor?.kit;
    const A = shippedA && await img(shippedA); const K = kitA && await img(kitA);
    // local contrast: each abdomen vertex's 5x5 luminance over the skin-only mean of a 49 px window around it
    // (shorts and padding excluded: the waistband sits inside the band and is not a painted ab), std across vertices
    const cv = (I) => {
      const at = (x, y) => { const o = (Math.min(I.h - 1, Math.max(0, y)) * I.w + Math.min(I.w - 1, Math.max(0, x))) * I.ch; return [I.data[o], I.data[o + 1], I.data[o + 2]]; };
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; const isSkin = (c) => c[0] - c[2] > 15;
      const rs = [];
      for (const v of Lm.body.filter((q) => q.uv && abd(q))) {
        const cx = Math.floor((v.uv[0] - Math.floor(v.uv[0])) * I.w); const cy = Math.floor((v.uv[1] - Math.floor(v.uv[1])) * I.h);
        if (!isSkin(at(cx, cy))) continue;
        let s = 0; let n = 0; let b = 0; let m = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = at(cx + dx, cy + dy); if (isSkin(c)) { s += lum(c); n++; } }
        for (let dy = -24; dy <= 24; dy += 3) for (let dx = -24; dx <= 24; dx += 3) { const c = at(cx + dx, cy + dy); if (isSkin(c)) { b += lum(c); m++; } }
        if (n && m) rs.push((s / n) / (b / m));
      }
      const mu = rs.reduce((a, x) => a + x, 0) / rs.length;
      return Math.sqrt(rs.reduce((a, x) => a + (x - mu) ** 2, 0) / rs.length);
    };
    if (A && K) {
      const ca = cv(A); const ck = cv(K);
      expect(`male abdomen albedo local contrast ${ca.toFixed(4)} <= 0.40x the kit's ${ck.toFixed(4)}: no 8-pack painted into the skin`, ca <= 0.4 * ck, `${shippedA} vs ${kitA}`);
    } else expect('male shipped + kit albedo readable for the abdomen check', false, `${shippedA} / ${kitA}`);
    const ar = await relief(Lm, rep0, 'male', abd);
    expect(`male abdomen normal relief ${ar.ratio.toFixed(2)}x the kit map (<= 0.15, as the stout gut)`, ar.ratio <= 0.15, ar.why);
    const shot = `${ROOT}docs/asset-sheets/characters/r1/torso-male-front-noon.png`;
    if (existsSync(shot)) {
      const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const W0 = info.width; const H0 = info.height; const L0 = new Float64Array(W0 * H0);
      for (let i = 0; i < W0 * H0; i++) L0[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
      // abdomen box of the fixed build camera (0,-2.2,1.15)->(0,0,1.1), 50 mm, 960x540: sternum to navel, inside the flanks
      const bx = [Math.round(W0 * 0.438), Math.round(W0 * 0.562)]; const by = [Math.round(H0 * 0.26), Math.round(H0 * 0.52)]; const R = 14;
      let s2 = 0; let n = 0; let mean = 0;
      for (let y = by[0]; y < by[1]; y++) for (let x = bx[0]; x < bx[1]; x++) {
        let b = 0; let c = 0;
        for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { b += L0[(y + dy) * W0 + x + dx]; c++; }
        const d = L0[y * W0 + x] - b / c; s2 += d * d; mean += L0[y * W0 + x]; n++;
      }
      const hp = Math.sqrt(s2 / n) / (mean / n);
      // red (e9b9b001 sheet, clear 8-pack): measured when this row landed, see b3.2.json
      expect(`rendered torso-male-front-noon abdomen high-pass contrast ${hp.toFixed(4)} <= 0.022: the 8-pack does not read in the lit render`, hp <= 0.022, shot);
    } else expect('torso-male-front-noon.png rendered (build_pirates.py -- --renders)', false);
  }
  for (const [b, L] of [['male', Lm], ['female', Lf], ['stout', Ls]]) {
    const pr = L && await periocular(L, rep0, b);
    if (!pr) { expect(`${b}: body albedo readable for the periocular check`, false); continue; }
    for (const { s, under, cheek, file } of pr) {
      const dh = Math.abs(((under.hue - cheek.hue + 540) % 360) - 180); const ds = cheek.sat - under.sat;
      expect(`${b} eye_${s}: under-eye albedo hue ${under.hue.toFixed(1)} vs cheek ${cheek.hue.toFixed(1)} (<= 6 deg; the build blends cheek and brow-ring chroma so no rosy halo) and saturation ${under.sat.toFixed(3)} vs ${cheek.sat.toFixed(3)} (>= cheek - 0.05; red 0.094-0.107 below): no grey-green bruise`,
        under.n > 0 && cheek.n > 0 && dh <= 6 && ds <= 0.05, file);
    }
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

// ── WARDROBE I (b3.2c, characters-01/03): rigid head-chain items and hat-safe hair ─────────────
// Every body GLB carries the head wardrobe as separate variant nodes the client toggles: hat_tricorn,
// hat_bicorn, hat_bandana, hat_headscarf, acc_eyepatch, acc_earring. Each is weighted 100% to the head
// joint (rigid on the head chain: a look or a nod carries it, nothing stretches). Every hair style except
// the beard has a hat-safe cut hair_<style>_hat that the client shows instead of the full style while a
// hat is on. "No hair vertex outside a hat at rest" is measured, not declared: from the head centre (mean
// of the head-weighted body vertices) a ray to every vertex of the cut (and of the head skin) may not
// cross the hat's surface before it reaches the vertex (1 mm slack). Negative control: at least one FULL
// style pokes through the tricorn on every body, so the ray test is able to fail.
// Crew colour (characters-03): the tricorn braid, the bicorn cockade and the bandana use a material whose
// extras.crewTint is true (a mask the client tints; the whole coat is no longer the crew colour).
// Red: before b3.2c (no wardrobe nodes, no cuts).
function pokeCount(hatV, pts, c, hits = null) {
  const S = 2; const NA = 180; const NE = 90; // 2 deg cells: azimuth x elevation from c
  const ang = (p) => { const d = sub(p, c); const r = len(d); return [((Math.atan2(d[2], d[0]) * 180 / Math.PI) + 360) % 360, Math.asin(d[1] / r) * 180 / Math.PI + 90, r]; };
  const grid = new Map(); const tris = hatV.tris ?? [];
  tris.forEach((t, k) => {
    const A = t.map((i) => ang(hatV[i].p));
    let az = A.map((a) => a[0]); if (Math.max(...az) - Math.min(...az) > 180) az = az.map((a) => (a < 180 ? a + 360 : a));
    const e0 = Math.max(0, Math.floor(Math.min(...A.map((a) => a[1])) / S) - 1); const e1 = Math.min(NE - 1, Math.floor(Math.max(...A.map((a) => a[1])) / S) + 1);
    const polar = Math.max(...A.map((a) => a[1])) > 170 || Math.min(...A.map((a) => a[1])) < 10;
    const a0 = polar ? 0 : Math.floor(Math.min(...az) / S) - 1; const a1 = polar ? NA - 1 : Math.floor(Math.max(...az) / S) + 1;
    for (let e = e0; e <= e1; e++) for (let a = a0; a <= a1; a++) { const key = e * NA + ((a % NA) + NA) % NA; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k); }
  });
  let n = 0;
  for (const p of pts) {
    const [az, el, r] = ang(p); const cell = grid.get(Math.min(NE - 1, Math.floor(el / S)) * NA + Math.floor(az / S) % NA); if (!cell) continue;
    const d = unit(sub(p, c));
    for (const k of cell) { // Moller-Trumbore from c along d
      const [a, b, e] = tris[k].map((i) => hatV[i].p); const e1 = sub(b, a); const e2 = sub(e, a);
      const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]; const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(c, a); const u = dot(s, h) / det; if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]; const v = dot(d, q) / det;
      if (v < 0 || u + v > 1) continue;
      const t = dot(e2, q) / det; if (t > 0 && t < r - 0.001) { n += 1; hits?.push(p.map((x) => +x.toFixed(3))); break; }
    }
  }
  return n;
}
if (!argv.includes('--glb')) {
  const HATS = ['hat_tricorn', 'hat_bicorn', 'hat_bandana', 'hat_headscarf'];
  const ACC = ['acc_eyepatch', 'acc_earring'];
  for (const b of BODIES) {
    console.log(`\nwardrobe I (b3.2c): ${b}`);
    const L = loadGlb(`${OUT}/pirate_base_${b}.glb`);
    if (!L) { expect(`${b}: body GLB present`, false); continue; }
    const { g, W } = L; const { gltf } = g;
    const nodeOf = (name) => gltf.nodes.findIndex((n) => n.mesh !== undefined && n.name === name);
    const verts = {};
    for (const name of [...HATS, ...ACC]) {
      const i = nodeOf(name);
      const v = i >= 0 && gltf.nodes[i].skin !== undefined ? skinned(g, W, i, 'head') : null;
      verts[name] = v;
      const off = v ? v.filter((x) => x.wj < 0.999).length : -1;
      expect(`${b}: ${name} is a skinned variant node weighted 100% to head (${v ? `${v.length - off}/${v.length}` : 'missing'})`, !!v && v.length > 0 && off === 0);
    }
    const hairs = gltf.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.mesh !== undefined && /^hair_/.test(n.name) && !/_hat$/.test(n.name) && !/beard/.test(n.name));
    const cuts = [];
    for (const { n } of hairs) {
      const i = nodeOf(`${n.name}_hat`);
      const v = i >= 0 ? skinned(g, W, i, 'head') : null;
      expect(`${b}: hat-safe cut ${n.name}_hat exists, is not a default style and follows the head (${v ? v.filter((x) => x.wj >= 0.999).length : 0}/${v?.length ?? 0})`,
        !!v && v.length > 0 && gltf.nodes[i].extras?.pirateDefault === false && v.every((x) => x.wj >= 0.999));
      if (v) cuts.push({ name: `${n.name}_hat`, v });
    }
    const headSkin = L.body.filter((v) => v.j === 'head');
    const c = headSkin.reduce((a, v) => [a[0] + v.p[0] / headSkin.length, a[1] + v.p[1] / headSkin.length, a[2] + v.p[2] / headSkin.length], [0, 0, 0]);
    for (const h of HATS) {
      if (!verts[h]) continue;
      const bad = cuts.map((cu) => [cu.name, pokeCount(verts[h], cu.v.map((x) => x.p), c)]).filter(([, k]) => k > 0);
      expect(`${b}: no hat-safe hair vertex outside ${h} at rest (${cuts.length} cuts)`, cuts.length === hairs.length && cuts.length > 0 && !bad.length, bad.map(([nm, k]) => `${nm} ${k}`).join(', '));
      const skin = pokeCount(verts[h], headSkin.map((x) => x.p), c);
      expect(`${b}: ${h} clears the head skin (${skin} vertices poke through)`, skin === 0);
    }
    if (verts.hat_tricorn) {
      const full = hairs.map(({ n, i }) => [n.name, pokeCount(verts.hat_tricorn, skinned(g, W, i).map((x) => x.p), c)]);
      expect(`${b}: negative control, a full style pokes through the tricorn (${full.map(([nm, k]) => `${nm} ${k}`).join(', ')})`, full.some(([, k]) => k > 0));
    }
    const crew = (name) => { const i = nodeOf(name); return i >= 0 && gltf.meshes[gltf.nodes[i].mesh].primitives.some((p) => gltf.materials?.[p.material]?.extras?.crewTint === true); };
    expect(`${b}: crew colour is a mask material (extras.crewTint) on the tricorn, the bicorn and the bandana`, ['hat_tricorn', 'hat_bicorn', 'hat_bandana'].every(crew));
  }
}

// ── WARDROBE II (b3.2d, characters-01/03): deforming body garments ───────────────────────────
// Every body GLB carries the nine garment slots as variant nodes (pirateDefault false): coat_frock,
// coat_jacket, vest_waistcoat, sash, belt, breeches_knee, breeches_slops, boots_tall, boots_shoes. Each is
// skinned to the body's skeleton with real deformation (>= 2 joints, weights sum to 1, no eye/lid joint),
// has no vertex farther than 0.25 m from the body at rest (the first b3.2d build shot solidify spikes 1-6 m
// out), and CLEARS the skin at rest: from the midpoint of each covered bone a ray to every body vertex that
// bone dominates may not cross the garment before reaching the vertex (1 mm slack). Negative control: the
// same vertices pushed 40 mm outward along that ray DO cross it, so the ray test can fail. Crew colour
// (characters-03) is a mask channel: the frock coat (lining, lapels, cuffs), the jacket lining and the sash
// carry a material with extras.crewTint; the belt, breeches, boots and waistcoat do not (they keep their own
// colour). Weight QA: the posed Workbench sheets (idle, crouch, aim up, helm, walk, heavy swing; front + side)
// are committed under docs/asset-sheets/characters/wardrobe-ii/.
// Red: before b3.2d (no garment nodes, no sheets).
if (!argv.includes('--glb')) {
  const SLOTS = { coat_frock: ['spine_02', 'spine_03', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r'],
    coat_jacket: ['spine_02', 'spine_03', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r'],
    vest_waistcoat: ['spine_02', 'spine_03'], sash: ['pelvis', 'spine_01'], belt: ['pelvis', 'spine_01'],
    breeches_knee: ['thigh_l', 'thigh_r'], breeches_slops: ['thigh_l', 'thigh_r'],
    boots_tall: ['calf_l', 'calf_r'], boots_shoes: ['foot_l', 'foot_r'] };
  const CREW = new Set(['coat_frock', 'coat_jacket', 'sash']);
  for (const b of BODIES) {
    console.log(`\nwardrobe II (b3.2d): ${b}`);
    const L = loadGlb(`${OUT}/pirate_base_${b}.glb`);
    if (!L) { expect(`${b}: body GLB present`, false); continue; }
    const { g, W } = L; const { gltf } = g;
    const nodeOf = (name) => gltf.nodes.findIndex((n) => n.mesh !== undefined && n.name === name);
    const skin = gltf.skins[0];
    const jw = (name) => { const k = gltf.nodes.findIndex((n) => n.name === name); return k >= 0 ? [W[k][12], W[k][13], W[k][14]] : null; };
    const mid = (bone) => { const k = gltf.nodes.findIndex((n) => n.name === bone); const c = gltf.nodes[k]?.children?.find((x) => skin.joints.includes(x)); const h = jw(bone); const t = c !== undefined ? [W[c][12], W[c][13], W[c][14]] : h; return h && [(h[0] + t[0]) / 2, (h[1] + t[1]) / 2, (h[2] + t[2]) / 2]; };
    const cell = 0.05; const hash = new Map();
    for (const v of L.body) { const key = v.p.map((x) => Math.floor(x / cell)).join(); if (!hash.has(key)) hash.set(key, []); hash.get(key).push(v.p); }
    const nearBody = (p) => { let best = Infinity; const c = p.map((x) => Math.floor(x / cell)); for (let r = 0; r <= 6 && best > r * cell; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) { if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue; for (const q of hash.get([c[0] + i, c[1] + j, c[2] + k].join()) ?? []) best = Math.min(best, len(sub(p, q))); } return best; };
    for (const [slot, bones] of Object.entries(SLOTS)) {
      const i = nodeOf(slot);
      const node = gltf.nodes[i];
      if (i < 0 || node.skin === undefined) { expect(`${b}: ${slot} is a skinned garment node`, false, 'missing'); continue; }
      const v = skinned(g, W, i);
      const joints = new Set(); let badSum = 0; let nonDeform = 0;
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const J = accessor(g, prim.attributes.JOINTS_0); const Wt = accessor(g, prim.attributes.WEIGHTS_0);
        for (let k = 0; k < J.length; k++) {
          let sum = 0;
          for (let q = 0; q < 4; q++) { if (Wt[k][q] > 1e-4) { const nm = gltf.nodes[skin.joints[J[k][q]]].name; joints.add(nm); if (/^(eye|lid)_/.test(nm)) nonDeform += 1; } sum += Wt[k][q]; }
          if (Math.abs(sum - 1) > 0.01) badSum += 1;
        }
      }
      expect(`${b}: ${slot} deforms on the skeleton (${v.length} verts, ${joints.size} joints, ${badSum} bad weight sums, ${nonDeform} eye/lid)`,
        v.length > 0 && joints.size >= 2 && !badSum && !nonDeform && node.extras?.pirateDefault === false);
      let far = 0; let worst = 0;
      for (let k = 0; k < v.length; k += 3) { const d = nearBody(v[k].p); worst = Math.max(worst, d); if (d > 0.25) far += 1; }
      expect(`${b}: ${slot} stays on the body at rest (farthest vertex ${worst === Infinity ? '>0.3' : worst.toFixed(3)} m <= 0.25)`, !far);
      // rays start ON the bone, in 8 bins along it (a single midpoint sees the groin through the crotch gap:
      // a body that is not star-shaped from one point reads as a false poke); only the garment's height band
      const ys = v.map((x) => x.p[1]); const y0 = Math.min(...ys) + 0.01; const y1 = Math.max(...ys) - 0.02;
      let poke = 0; let tested = 0; let neg = 0; const hits = []; let hidden = 0; let probes = 0;
      for (const bone of bones) {
        const h = jw(bone); const m = mid(bone); if (!h || !m) continue;
        const t = [2 * m[0] - h[0], 2 * m[1] - h[1], 2 * m[2] - h[2]]; const ax = sub(t, h); const l2 = dot(ax, ax) || 1;
        const bins = Array.from({ length: 8 }, () => []);
        // the crotch seam (|x| < 3 cm on a thigh) is where the two leg shells meet between the legs: the bend
        // there is concave from every point on either femur, so it is not a star-shaped test region (excluded)
        const seam = (q) => /^thigh_/.test(bone) && Math.abs(q[0]) < 0.03;
        for (const x of L.body) if (x.j === bone && x.p[1] > y0 && x.p[1] < y1 && !seam(x.p)) bins[Math.min(7, Math.max(0, Math.floor(8 * dot(sub(x.p, h), ax) / l2)))].push(x.p);
        // a skin vertex hidden from the bone by the body's own skin (the stout's belly underside over the thigh,
        // the stout's armpit crease under the arm) is not a star-shaped probe either: the ray leaves the skin and
        // crosses the fold before it gets there, so any garment bridging the fold reads as a poke. Those probes
        // are dropped and counted (only poking probes are checked), at most 3% of a slot's probes (row below)
        bins.forEach((pts0, k) => {
          if (!pts0.length) return;
          const c = [h[0] + ax[0] * (k + 0.5) / 8, h[1] + ax[1] * (k + 0.5) / 8, h[2] + ax[2] * (k + 0.5) / 8];
          const pk = []; pokeCount(v, pts0, c, pk); const pks = new Set(pk.map((q) => q.join()));
          const hid = []; pokeCount(L.body, pts0.filter((p) => pks.has(p.map((x) => +x.toFixed(3)).join())), c, hid);
          const hk = new Set(hid.map((q) => q.join()));
          const pts = pts0.filter((p) => !hk.has(p.map((x) => +x.toFixed(3)).join()));
          hidden += pts0.length - pts.length; probes += pts0.length;
          if (!pts.length) return;
          tested += pts.length;
          poke += pokeCount(v, pts, c, hits);
          neg += pokeCount(v, pts.map((p) => { const d = unit(sub(p, c)); return [p[0] + 0.04 * d[0], p[1] + 0.04 * d[1], p[2] + 0.04 * d[2]]; }), c);
        });
      }
      expect(`${b}: ${slot} clears the skin at rest (${poke}/${tested} ${bones.join('/')} vertices poke through)`, tested > 0 && poke === 0, hits.slice(0, 4).map((q) => `(${q.join(',')})`).join(' '));
      expect(`${b}: negative control, the same vertices pushed 40 mm out cross ${slot} (${neg})`, neg > 0);
      expect(`${b}: ${slot} clearance probes hidden by a skin fold <= 3% (${hidden}/${probes})`, hidden <= 0.03 * probes);
      const crew = gltf.meshes[node.mesh].primitives.some((p) => gltf.materials?.[p.material]?.extras?.crewTint === true);
      expect(`${b}: ${slot} ${CREW.has(slot) ? 'carries' : 'has no'} crew-mask material`, crew === CREW.has(slot));
      // FOOTWEAR IS NOT A SOCK (b3.2d R2 own check: the skin-tight shells showed every toe in the posed sheets).
      // Toe box: vertical rays from above across the forefoot (3 lateral lines ahead of the ball, 17 samples each)
      // meet the footwear's top in a profile with no valley deeper than 1 mm between two higher points (a shell
      // of the toes has one per toe gap). Welt: at 4 mm above the lowest foot skin, the footwear outline stands
      // >= 15 mm (and < 45 mm, no clown shoe) clear of the foot's skin outline in all 16 horizontal directions (a sole,
      // not a lining). Red: the 7a3c0dbf shells (valley 1.8/5.5/1.8 mm, welt 9.8/13.3/7.9 mm male/female/stout).
      if (/^boots_/.test(slot)) {
        const hitT = (u, P) => { // Moller-Trumbore, origin 0
          const e1 = sub(P[1], P[0]); const e2 = sub(P[2], P[0]);
          const px = [u[1] * e2[2] - u[2] * e2[1], u[2] * e2[0] - u[0] * e2[2], u[0] * e2[1] - u[1] * e2[0]];
          const det = dot(e1, px); if (Math.abs(det) < 1e-14) return -1;
          const tv = [-P[0][0], -P[0][1], -P[0][2]]; const uu = dot(tv, px) / det; if (uu < 0 || uu > 1) return -1;
          const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
          const vv = dot(u, qv) / det; if (vv < 0 || uu + vv > 1) return -1;
          return dot(e2, qv) / det;
        };
        const firstHit = (M, tris, o, d) => { let best = Infinity; for (const t of tris) { const T = hitT(d, t.map((q) => sub(M[q].p, o))); if (T > 0 && T < best) best = T; } return best; };
        const lastHit = (M, tris, o, d) => { let best = -Infinity; for (const t of tris) { const T = hitT(d, t.map((q) => sub(M[q].p, o))); if (T > 0 && T > best) best = T; } return best; };
        const footTris = (L.body.tris ?? []).filter((t) => t.some((q) => /^(foot|ball)_/.test(L.body[q].j ?? '')));
        let valley = 0; let welt = Infinity;
        for (const s of ['l', 'r']) {
          const f = jw(`foot_${s}`); const bl = jw(`ball_${s}`); if (!f || !bl) continue;
          const fw = unit([bl[0] - f[0], 0, bl[2] - f[2]]); const lat = [fw[2], 0, -fw[0]];
          const foot = L.body.filter((x) => x.j === `foot_${s}` || x.j === `ball_${s}`).map((x) => x.p);
          const near = foot.filter((q) => dot(sub(q, bl), fw) > -0.01);
          if (!near.length) continue;
          const la = near.map((q) => dot(sub(q, bl), lat)); const fa = near.map((q) => dot(sub(q, bl), fw));
          const lmin = Math.min(...la) + 0.004; const lmax = Math.max(...la) - 0.004; const fmax = Math.max(...fa);
          for (const u of [0.25, 0.45, 0.65]) {
            const h = [];
            for (let k = 0; k <= 16; k++) {
              const l = lmin + (lmax - lmin) * k / 16; const fo = fmax * u;
              const o = [bl[0] + fw[0] * fo + lat[0] * l, 0.5, bl[2] + fw[2] * fo + lat[2] * l];
              const T = firstHit(v, v.tris ?? [], o, [0, -1, 0]); if (T < Infinity) h.push(0.5 - T);
            }
            for (let k = 1; k < h.length - 1; k++) valley = Math.max(valley, Math.min(Math.max(...h.slice(0, k)), Math.max(...h.slice(k + 1))) - h[k]);
          }
          const ymin = Math.min(...foot.map((q) => q[1])); const sole = foot.filter((q) => q[1] < ymin + 0.02);
          const c = [sole.reduce((a, q) => a + q[0], 0) / sole.length, ymin + 0.004, sole.reduce((a, q) => a + q[2], 0) / sole.length];
          for (let k = 0; k < 16; k++) {
            const a = 2 * Math.PI * k / 16; const d = [Math.cos(a), 0, Math.sin(a)];
            const sk = lastHit(L.body, footTris, c, d);
            const gw = lastHit(v, v.tris ?? [], c, d);
            if (sk > 0 && gw > 0) welt = Math.min(welt, gw - sk);
          }
        }
        expect(`${b}: ${slot} has a toe box, not toes (deepest valley across the forefoot ${(1000 * valley).toFixed(1)} mm <= 1)`, valley <= 0.001);
        expect(`${b}: ${slot} has a welted sole (outline 15-45 mm clear of the foot at the sole, min ${(1000 * welt).toFixed(1)} mm)`, welt >= 0.015 && welt < 0.045);
      }
    }
    const gold = ['coat_frock', 'coat_jacket', 'vest_waistcoat', 'belt', 'boots_shoes'].filter((s) => { const i = nodeOf(s); return i >= 0 && gltf.meshes[gltf.nodes[i].mesh].primitives.some((p) => gltf.materials?.[p.material]?.extras?.wardrobeClass === 'gold'); });
    expect(`${b}: buttons/buckles present on coat, jacket, waistcoat, belt and shoes (${gold.length}/5)`, gold.length === 5);
  }
  const QA = ['captain', 'deckhand', 'bosun', 'gunner'].map((o) => `docs/asset-sheets/characters/wardrobe-ii/qa-${o}-poses.png`);
  const missing = QA.filter((f) => !existsSync(`${ROOT}${f}`) || statSync(`${ROOT}${f}`).size < 50000);
  expect(`weight QA render sheets committed (${QA.length - missing.length}/${QA.length} posed sheets)`, !missing.length, missing.join(', '));
}

// ── R2 re-review fixes (b3.2d-R2fix) ─────────────────────────────────────────────────────────
// F9 tri budget AT SOURCE: the dressed LOD0 band is 16-22k tris (<= 3 draws); the R2 captain was 62.1k (a pair of
// tall boots 18.3k = 83% of the whole budget). Per-slot caps (tris, both sides): boots_tall 2400, boots_shoes 1800,
// coat_frock 6000, coat_jacket 5000, vest_waistcoat 3000, breeches 4300 (unchanged, not an R2 line), sash 2500, belt 900.
// F1 garment rims: every opening (coat and jacket fronts, waistcoat V and armholes, hems, cuffs) is the boundary of
// the garment's OUTER cloth primitive (the rim and lining are the second material). Welded by position, each
// boundary loop is resampled at 1 cm stations; the turning angle between successive 1 cm chords may exceed 35 deg
// only at the authored corners, by name: the coat/jacket opening loop (front + collar + hem) has six (hem x front
// l/r, collar foot x front l/r, collar top x front l/r); every other loop (cuffs, armholes, the waistcoat V + hem
// with its V point and two front points) at most four. A rim that follows the body's face grid is a staircase with a spike every 1-2 cm (R2: torn paper).
// Red: 3e017cda (boots_tall 18264, coat_frock 8876; coat fronts and vest V/armholes with dozens of spikes).
if (!argv.includes('--glb')) {
  const CAP = { boots_tall: 2400, boots_shoes: 1800, coat_frock: 6000, coat_jacket: 5000, vest_waistcoat: 3000,
    breeches_knee: 4300, breeches_slops: 4300, sash: 2500, belt: 900 };
  const RIMS = ['coat_frock', 'coat_jacket', 'vest_waistcoat'];
  const rimLoops = (v, outer) => { // outer = the material of the garment's first slot (the cloth face)
    const key = (p) => p.map((x) => Math.round(x * 5000)).join();
    const id = new Map(); const pos = []; const w = (i) => { const k = key(v[i].p); if (!id.has(k)) { id.set(k, pos.length); pos.push(v[i].p); } return id.get(k); };
    const cnt = new Map();
    for (const t of v.tris ?? []) {
      if (v[t[0]].mat !== outer) continue;
      const q = t.map(w); if (new Set(q).size < 3) continue;
      for (let a = 0; a < 3; a++) { const e = [q[a], q[(a + 1) % 3]].sort((x, y) => x - y).join(); cnt.set(e, (cnt.get(e) ?? 0) + 1); }
    }
    const adj = new Map();
    for (const [e, c] of cnt) if (c === 1) { const [a, b] = e.split(',').map(Number); for (const [x, y] of [[a, b], [b, a]]) { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(y); } }
    const used = new Set(); const loops = [];
    for (const s0 of adj.keys()) {
      if (used.has(s0)) continue;
      const L = [s0]; used.add(s0); let prev = -1; let cur = s0;
      for (;;) { const nx = (adj.get(cur) ?? []).find((n) => n !== prev && !used.has(n)); if (nx === undefined) break; used.add(nx); L.push(nx); prev = cur; cur = nx; }
      if (L.length >= 8) loops.push(L.map((i) => pos[i]));
    }
    return loops.map((L) => { // resample at 1 cm and count turning spikes > 35 deg
      const P = [...L, L[0]]; const st = [P[0]]; let carry = 0;
      for (let i = 1; i < P.length; i++) { const d = sub(P[i], P[i - 1]); const l = len(d); let s = 0.01 - carry;
        while (s <= l) { st.push(P[i - 1].map((x, k) => x + d[k] * s / l)); s += 0.01; } carry = l - (s - 0.01); }
      let spikes = 0; const n = st.length;
      for (let i = 0; i < n; i++) { const a = sub(st[i], st[(i - 1 + n) % n]); const b = sub(st[(i + 1) % n], st[i]);
        if (len(a) < 1e-4 || len(b) < 1e-4) continue;
        if (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b))))) > 35 * Math.PI / 180) spikes += 1; }
      return { n, spikes };
    });
  };
  for (const b of BODIES) {
    console.log(`\nR2 fixes (b3.2d-R2fix): ${b}`);
    const L = loadGlb(`${OUT}/pirate_base_${b}.glb`);
    if (!L) { expect(`${b}: body GLB present`, false); continue; }
    const { g, W } = L; const { gltf } = g;
    const nodeOf = (name) => gltf.nodes.findIndex((n) => n.mesh !== undefined && n.name === name);
    const over = []; let total = 0;
    for (const [slot, cap] of Object.entries(CAP)) {
      const i = nodeOf(slot); if (i < 0) { over.push(`${slot} missing`); continue; }
      const t = gltf.meshes[gltf.nodes[i].mesh].primitives.reduce((s, p) => s + gltf.accessors[p.indices].count / 3, 0);
      total += t; if (t > cap) over.push(`${slot} ${t} > ${cap}`);
    }
    expect(`${b}: wardrobe II per-slot tri caps (all nine slots ${total} tris)`, !over.length, over.join(', '));
    for (const slot of RIMS) {
      const i = nodeOf(slot); if (i < 0) { expect(`${b}: ${slot} present`, false); continue; }
      const loops = rimLoops(skinned(g, W, i), gltf.meshes[gltf.nodes[i].mesh].primitives[0].material);
      const bad = loops.filter((l, k) => l.spikes > (k === 0 && slot.startsWith('coat') ? 6 : 4));
      expect(`${b}: ${slot} rims are clean curves (${loops.length} loops, spikes per loop ${loops.map((l) => l.spikes).join('/')}; <= 6 on a coat opening, <= 4 elsewhere)`,
        loops.length > 0 && !bad.length);
    }
  }
}

// ── CLIPS (b3.2b, animations-01/02, characters-05) ────────────────────────
// Every clip id the player state machine (PlayerRigFactory: lowerClip / upperClip / setLayer / the death
// clip per cause) can request exists in public/assets/models/pirate_clips.glb, is non-empty (>= 2 keys,
// >= 50 animated bones) and sits on an exact 30 fps grid, and every animated node is a bone of the body
// the clips drive. The id list is READ FROM THE SOURCE, so a new state that asks for a missing clip fails
// here. Anatomy of each clip (knees, elbows, head look) is test-anim-rig-anatomy.mjs.
// Red: --clips public/assets/models/pirate_base.glb (the legacy 24-bone rig).
if (!argv.includes('--glb')) {
  const CLIPS = argv.includes('--clips') ? argv[argv.indexOf('--clips') + 1] : `${ROOT}public/assets/models/pirate_clips.glb`;
  console.log(`\nclips (${CLIPS.replace(ROOT, '')})`);
  const src = readFileSync(`${ROOT}src/client/rendering/factories/PlayerRigFactory.ts`, 'utf8');
  const wanted = new Set();
  for (const line of src.split('\n')) {
    if (/\breturn\b|const clip = /.test(line)) for (const m of line.matchAll(/(?:return|\?|:)\s*'([a-z][a-z0-9_]*)'/g)) wanted.add(m[1]);
    for (const m of line.matchAll(/setLayer\(rig, '(?:lower|upper)', '([a-z][a-z0-9_]*)'\)/g)) wanted.add(m[1]);
  }
  const ids = [...wanted].sort();
  expect(`state-machine clip ids read from PlayerRigFactory.ts (${ids.length}: incl. idle, hit_front, death_shot, death_drown)`,
    ids.length >= 20 && ['idle', 'hit_front', 'death_shot', 'death_drown', 'cutlass_swing_b'].every((x) => wanted.has(x)), ids.join(', '));
  const L = existsSync(CLIPS) ? readGlb(CLIPS) : null;
  expect('clip library present', !!L);
  const anims = new Map((L?.gltf.animations ?? []).map((a) => [a.name, a]));
  const absent = ids.filter((id) => !anims.has(id));
  expect(`every requested clip id exists (${ids.length - absent.length}/${ids.length})`, !absent.length, absent.join(', '));
  const thin = []; const off = []; const foreign = new Set();
  const male = existsSync(`${OUT}/pirate_base_male.glb`) ? readGlb(`${OUT}/pirate_base_male.glb`).gltf : null;
  const bones = new Set((male?.skins?.[0]?.joints ?? []).map((j) => male.nodes[j].name));
  for (const id of ids.filter((x) => anims.has(x))) {
    const a = anims.get(id);
    const t = accessor(L, a.samplers[a.channels[0].sampler].input).map((x) => x[0]);
    const rot = new Set(a.channels.filter((c) => c.target.path === 'rotation').map((c) => c.target.node));
    if (t.length < 2 || rot.size < 50) thin.push(`${id} (${t.length} keys, ${rot.size} bones)`);
    if (t.some((x, i) => Math.abs(x - i / 30) > 1e-4)) off.push(id);
    for (const c of a.channels) { const nm = L.gltf.nodes[c.target.node].name; if (!bones.has(nm)) foreign.add(nm); }
  }
  expect('every requested clip is non-empty: >= 2 keys and >= 50 animated bones', !thin.length, thin.join(', '));
  expect('every requested clip on an exact 30 fps grid', !off.length, off.join(', '));
  expect(`every animated node is a bone of pirate_base_male (${bones.size} joints)`, bones.size >= 57 && !foreign.size, [...foreign].join(', '));
}

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
