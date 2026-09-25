// THE CHARACTER ASSET'S CONTRACT (D25, b3.2a) — pure node, no browser, no GPU, no THREE.
//
// WHY. The pirate stops being a procedural blob (sphere head, no eyes, no UVs: characters-01) and
// becomes the Quaternius CC0 anatomy on the UE-style skeleton, normalised by
// scripts/blender/build_pirates.py (stage module _pirate_import.py). Everything downstream (clips,
// wardrobe, LODs, the face rig, the hitbox) assumes facts nobody can see once the GLB is a binary blob:
//
//   * the SKELETON is the 55-bone NAMED set (65 kit bones minus the 12 leaf bones, plus eye_l/eye_r).
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

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}assets-src/quaternius/out`;
const BODIES = ['male', 'female', 'stout'];
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const SIDE = (s) => [`clavicle_${s}`, `upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`,
  ...FINGERS.flatMap((f) => [1, 2, 3].map((i) => `${f}_0${i}_${s}`)),
  `thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`, `eye_${s}`];
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
function skinned(g, W, nodeIdx) {
  const { gltf } = g;
  const node = gltf.nodes[nodeIdx];
  const skin = gltf.skins?.[node.skin];
  const out = [];
  for (const prim of gltf.meshes[node.mesh].primitives) {
    const P = accessor(g, prim.attributes.POSITION);
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
      out.push({ p: acc, j: gltf.nodes[skin.joints[best]]?.name ?? null });
    }
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

function grade(path, label) {
  console.log(`\n${label} (${path.replace(ROOT, '')})`);
  if (!existsSync(path)) { expect(`${label} exists`, false, 'build: Blender -b --factory-startup -P scripts/blender/build_pirates.py'); return; }
  const g = readGlb(path);
  const { gltf } = g;
  const W = worlds(gltf);
  const skin = gltf.skins?.[0];
  const names = (skin?.joints ?? []).map((j) => gltf.nodes[j].name);
  const missing = BONES.filter((b) => !names.includes(b));
  const extra = names.filter((b) => !BONES.includes(b));
  expect(`skeleton is the 55-bone named set (has ${names.length})`, missing.length === 0 && extra.length === 0,
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
}

const argv = process.argv.slice(2);
if (argv.includes('--glb')) {
  console.log('Character asset contract (one file)');
  grade(argv[argv.indexOf('--glb') + 1], 'graded file');
} else {
  console.log('Character asset contract (stage 1: normalised CC0 base, three body types)');
  for (const b of BODIES) grade(`${OUT}/pirate_base_${b}.glb`, `body ${b}`);

  console.log('\nbody types');
  const wm = waist(`${OUT}/pirate_base_male.glb`); const ws = waist(`${OUT}/pirate_base_stout.glb`);
  const f = (w) => (w ? `${w[0].toFixed(3)} x ${w[1].toFixed(3)} m` : 'n/a');
  expect(`stout waist 1.3-1.7x the male's width and 1.35-1.7x its depth (male ${f(wm)}, stout ${f(ws)})`,
    !!wm && !!ws && ws[0] >= 1.3 * wm[0] && ws[1] >= 1.35 * wm[1] && ws[0] <= 1.7 * wm[0] && ws[1] <= 1.7 * wm[1],
    wm && ws ? `ratios ${(ws[0] / wm[0]).toFixed(2)} / ${(ws[1] / wm[1]).toFixed(2)}` : '');

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
