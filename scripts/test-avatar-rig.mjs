// THE PIRATE RIG'S CONTRACT — pure node, no browser, no GPU, no THREE.
//
// WHY. RIG-01 replaces a 22-26 primitive box pirate (nine per-instance
// materials, no skeleton, hand-lerped Eulers) with ONE skinned GLB built by
// scripts/blender/pirate_rig.py. Everything downstream of that file assumes
// four things that nothing else can check once the .glb is a binary blob:
//
//   * the SKELETON is the one PLAN §2.5 specifies, so PlayerAnimator can name
//     bones (`head` for the look-at solver, `foot_l`/`foot_r` for the sole
//     solve) and so the upper/lower body clip masks split at a bone that
//     exists;
//   * the HEAD BONE sits at PLAYER.HEAD_Y. The server's headshot sphere, the
//     first-person eye and the nameplate anchor all derive from that constant
//     (AVATAR-01). A rig authored 9 cm off would silently re-open the defect
//     the pose-invariants suite was written to close;
//   * the FEET sit on the origin. Game puts the group at the server's
//     player.position, which is the standing surface, so a rig whose lowest
//     bone is below ~0 stands ankle-deep in the deck;
//   * every CLIP the state machine can ask for is in the file and is not an
//     empty action. A missing clip is a pirate frozen in bind pose; an empty
//     one is a pirate frozen in bind pose that LOOKS present to a `findByName`.
//
// It also grades the two numbers the owner's north star turns on: the dressed
// triangle count (balanced budget 8k) and the dressed PRIMITIVE count, which is
// the draw calls a pirate costs. The old box pirate was 22-26 draws each; a
// dense fight put 700-1000 draws on the screen for figures two metres tall.
//
// The GLB is parsed straight out of its JSON chunk — no GLTFLoader, no canvas
// stub, no GPU — so this suite runs anywhere in about 60 ms.
//
//   node --import tsx scripts/test-avatar-rig.mjs
import { readFileSync, existsSync } from 'node:fs';
import { PLAYER } from '../src/shared/constants/index.ts';

const GLB = new URL('../public/assets/models/pirate_base.glb', import.meta.url).pathname;

let failures = 0;
let checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

console.log('Pirate rig contract (node, pirate_base.glb)');

if (!existsSync(GLB)) {
  console.error(`  ✗ FAIL: public/assets/models/pirate_base.glb exists\n     build it: /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/pirate_rig.py`);
  console.log('\n1 checks, 1 failed');
  process.exit(1);
}

// ── parse the GLB's JSON chunk ─────────────────────────────────────────────
const buf = readFileSync(GLB);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) { console.error('  ✗ FAIL: not a GLB'); process.exit(1); }
const chunkLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));

const nodes = gltf.nodes ?? [];
const meshes = gltf.meshes ?? [];
const accessors = gltf.accessors ?? [];
const skins = gltf.skins ?? [];
const animations = gltf.animations ?? [];

// ── world transforms (glTF is Y-up after export_yup) ───────────────────────
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation ?? [0, 0, 0];
  const q = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) { // column-major a*b (b applied first)
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const world = new Map();
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function walk(idx, parent) {
  const n = nodes[idx];
  const m = mul(parent, nodeMatrix(n));
  world.set(idx, m);
  for (const c of n.children ?? []) walk(c, m);
}
for (const scene of gltf.scenes ?? []) for (const r of scene.nodes ?? []) walk(r, IDENT);
const worldY = (idx) => world.get(idx)?.[13] ?? Number.NaN;

// ── skeleton ───────────────────────────────────────────────────────────────
const SPEC_BONES = [
  'hips', 'spine1', 'spine2', 'chest', 'neck', 'head',
  'clavicle_l', 'upperarm_l', 'forearm_l', 'hand_l',
  'clavicle_r', 'upperarm_r', 'forearm_r', 'hand_r',
  'thigh_l', 'shin_l', 'foot_l', 'toe_l',
  'thigh_r', 'shin_r', 'foot_r', 'toe_r',
];

expect('exactly one skin in the file', skins.length === 1, `skins=${skins.length}`);
const joints = skins[0]?.joints ?? [];
const jointNames = joints.map((j) => nodes[j]?.name ?? '?');
expect(`skeleton is ≤ 24 bones (PLAN §2.5)`, joints.length <= 24 && joints.length >= 22, `joints=${joints.length}: ${jointNames.join(',')}`);
const missing = SPEC_BONES.filter((b) => !jointNames.includes(b));
expect('every PLAN §2.5 bone is present, spelled the way the client names it', missing.length === 0, `missing: ${missing.join(', ')}`);

const boneIdx = (name) => joints.find((j) => nodes[j]?.name === name);
const headIdx = boneIdx('head');
const headY = headIdx === undefined ? Number.NaN : worldY(headIdx);
expect(`head bone sits at PLAYER.HEAD_Y (${PLAYER.HEAD_Y}) within 5 cm`,
  Math.abs(headY - PLAYER.HEAD_Y) <= 0.05, `head bone y=${headY.toFixed(3)}`);

let lowestBone = Infinity;
let lowestName = '?';
for (const j of joints) { const y = worldY(j); if (y < lowestBone) { lowestBone = y; lowestName = nodes[j]?.name ?? '?'; } }
expect('no bone hangs below the standing surface (≥ −0.02)', lowestBone >= -0.02, `lowest bone ${lowestName} at y=${lowestBone.toFixed(3)}`);

const footY = Math.min(worldY(boneIdx('foot_l')), worldY(boneIdx('foot_r')));
expect('the foot bones are on the ground, not floating (≤ 0.14)', footY <= 0.14, `foot y=${footY.toFixed(3)}`);

// ── clips ──────────────────────────────────────────────────────────────────
// PLAN §2.5's clip set. A pirate can be asked for any of these by the state
// machine; a name that is not here is a pirate stuck in bind pose.
const SPEC_CLIPS = [
  'idle', 'walk', 'run', 'strafe_l', 'strafe_r', 'jump', 'fall', 'land',
  'swim', 'tread', 'climb', 'helm', 'cannon_aim', 'cannon_fire',
  'capstan_push', 'bail', 'hammer', 'dig', 'spyglass',
  'aim_pistol', 'fire_pistol', 'reload',
  'cutlass_idle', 'cutlass_swing_a', 'cutlass_swing_b', 'block',
  'hit_front', 'hit_back', 'downed', 'revive',
  'death_shot', 'death_fall', 'death_drown',
];
const clipNames = animations.map((a) => a.name);
const missingClips = SPEC_CLIPS.filter((c) => !clipNames.includes(c));
expect(`all ${SPEC_CLIPS.length} PLAN §2.5 clips are in the file`, missingClips.length === 0, `missing: ${missingClips.join(', ')}`);

let emptyClips = [];
let zeroLength = [];
for (const a of animations) {
  if (!a.channels?.length || !a.samplers?.length) { emptyClips.push(a.name); continue; }
  // duration = max input accessor max
  let dur = 0;
  for (const s of a.samplers) {
    const acc = accessors[s.input];
    if (acc?.max?.[0] > dur) dur = acc.max[0];
  }
  if (!(dur > 0.001)) zeroLength.push(`${a.name}(${dur})`);
}
expect('no clip is an empty action', emptyClips.length === 0, `empty: ${emptyClips.join(', ')}`);
expect('no clip has zero duration', zeroLength.length === 0, `zero-length: ${zeroLength.join(', ')}`);

// A clip that only keys one bone is a clip nobody authored. The locomotion
// clips must move the legs AND the arms.
const jointSet = new Set(joints);
for (const name of ['walk', 'run', 'idle', 'swim', 'death_shot']) {
  const a = animations.find((x) => x.name === name);
  const targets = new Set((a?.channels ?? []).map((c) => c.target?.node).filter((n) => jointSet.has(n)));
  expect(`clip "${name}" poses at least 6 bones`, targets.size >= 6, `${targets.size} bones keyed`);
}

// ── modular meshes ─────────────────────────────────────────────────────────
const meshNodes = nodes.filter((n) => n.mesh !== undefined);
const meshNodeNames = meshNodes.map((n) => n.name);
const HEADS = ['head_a', 'head_b', 'head_c', 'head_d', 'head_e', 'head_f'];
const OUTFIT = ['hat_tricorn', 'hat_bandana', 'hat_bare', 'coat_long', 'coat_short'];
const missingParts = [...HEADS, ...OUTFIT, 'body'].filter((p) => !meshNodeNames.includes(p));
expect('the modular set is complete (body, 6 heads, 3 hats, 2 coats)', missingParts.length === 0, `missing: ${missingParts.join(', ')}`);

function trisOf(nodeName) {
  const n = meshNodes.find((x) => x.name === nodeName);
  if (!n) return 0;
  let t = 0;
  for (const p of meshes[n.mesh].primitives ?? []) {
    t += (p.indices !== undefined ? accessors[p.indices].count : accessors[p.attributes.POSITION].count) / 3;
  }
  return t;
}
function primsOf(nodeName) {
  const n = meshNodes.find((x) => x.name === nodeName);
  return n ? (meshes[n.mesh].primitives ?? []).length : 0;
}

// The DRESSED pirate = what one player actually costs: body + one head +
// one hat + one coat. Everything else in the file is a variant the dresser
// leaves invisible (and PlayerRigFactory removes from the clone).
const DRESSED = ['body', 'head_a', 'hat_tricorn', 'coat_long'];
const dressedTris = DRESSED.reduce((s, p) => s + trisOf(p), 0);
const dressedPrims = DRESSED.reduce((s, p) => s + primsOf(p), 0);
const fileTris = meshes.reduce((s, m) => s + (m.primitives ?? []).reduce(
  (t, p) => t + (p.indices !== undefined ? accessors[p.indices].count : accessors[p.attributes.POSITION].count) / 3, 0), 0);

expect('a dressed pirate is ≤ 8,000 tris (PLAN §2.5 balanced budget)', dressedTris <= 8000, `dressed=${dressedTris}`);
expect('the whole file is ≤ 15,000 tris (high budget, all variants)', fileTris <= 15000, `file=${fileTris}`);
// PINNED at the measured 7 (body Skin/Cloth/Leather, head Skin/Hair, hat
// Canvas, coat TeamTint). Six materials over four modular objects cannot go
// lower without dropping a material; tighten this, never loosen it.
expect('a dressed pirate is ≤ 7 draw calls (was 22-26, avatar-13)', dressedPrims <= 7, `prims=${dressedPrims}`);

// ── skinning actually reached the mesh ─────────────────────────────────────
let skinnedPrims = 0;
let unskinnedPrims = 0;
for (const m of meshes) for (const p of m.primitives ?? []) {
  if (p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) skinnedPrims += 1;
  else unskinnedPrims += 1;
}
expect('every primitive is skinned (export_skins actually fired)', unskinnedPrims === 0 && skinnedPrims > 0,
  `skinned=${skinnedPrims} unskinned=${unskinnedPrims}`);
expect('every mesh node is bound to the skin', meshNodes.every((n) => n.skin !== undefined),
  meshNodes.filter((n) => n.skin === undefined).map((n) => n.name).join(', '));

// ── the figure's silhouette ────────────────────────────────────────────────
const posMins = [];
const posMaxs = [];
for (const a of accessors) if (a.type === 'VEC3' && a.min?.length === 3 && a.max?.length === 3) { posMins.push(a.min); posMaxs.push(a.max); }
const bbMinY = Math.min(...posMins.map((v) => v[1]));
const bbMaxY = Math.max(...posMaxs.map((v) => v[1]));
expect('nothing is modelled below the soles (bbox min y ≥ −0.03)', bbMinY >= -0.03, `bbox min y=${bbMinY.toFixed(3)}`);
expect(`the crown clears PLAYER.HEIGHT (${PLAYER.HEIGHT}) by ≤ 25 cm even with the tricorn`,
  bbMaxY <= PLAYER.HEIGHT + 0.25, `bbox max y=${bbMaxY.toFixed(3)}`);

// ── team tint ──────────────────────────────────────────────────────────────
const matNames = (gltf.materials ?? []).map((m) => m.name);
expect('the coat carries the TeamTint material the client recolours per crew',
  matNames.includes('TeamTint'), `materials: ${matNames.join(', ')}`);
expect('the whole rig ships ≤ 6 materials (avatar-13: 9-14 per pirate today)',
  matNames.length <= 6, `${matNames.length}: ${matNames.join(', ')}`);

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
