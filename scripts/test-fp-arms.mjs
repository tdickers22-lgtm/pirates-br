#!/usr/bin/env node
// FIRST-PERSON ARMS ARE THE CHARACTER'S OWN ARMS, AND THEY NEVER FILL THE SCREEN (b3.2h; characters-11, liveplay-12).
//
// WHY. The viewmodel gripped every weapon and tool with a box fist and a cylinder sleeve built in code
// (PlayerMeshFactory.makeViewHand): "cube fists with a flat green sleeve", and the bucket / plank poses
// covered half the frame. b3.2h bakes the male pirate's real forearm and five-finger hand, closed on a
// 32 mm handle under the coat_frock sleeve and crew cuff, into public/assets/models/pirate_fp_arms.glb
// (scripts/blender/_pirate_fp_arms.py) and ViewmodelController swaps it into every view hand.
//
// WHAT (pure node, no GL, < 2 s):
//   1. the GLB: nodes fp_arm_r + fp_arm_l, <= 4k tris for BOTH, five fingers, the skin carries COLOR_0
//      (the baked albedo), sleeve / cuff materials present, identity node TRS (the grip frame is the file's).
//   2. the swap: ViewmodelController names the swapped arm `fp_arms` and every makeHand reaches fitFpArm.
//   3. the SCREEN: every grip state (each weapon at hip and aimed, the cutlass at rest and mid-slash,
//      every pocket tool) is projected through the 70 deg / 16:9 camera and rasterised; both hands
//      together must cover <= 45 % of the screen, and every hand the state shows must be ON screen
//      (>= 0.3 %, the hands probe's "a fist off the bottom edge is a floating prop" rule).
//
//   node --import tsx scripts/test-fp-arms.mjs
//   PIRATES_BR_MUTATE_FPARMS=lens    -> 2x arms pulled at the lens (the liveplay-12 bucket blob; red on 45 %)
//   PIRATES_BR_MUTATE_FPARMS=noglb   -> grade a missing file (red: the tree before b3.2h)
//   PIRATES_BR_MUTATE_FPARMS=noswap  -> grade the controller without the swap (red)
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { installCanvasStub } from './lib/canvas-stub.mjs';

installCanvasStub();
const MUT = process.env.PIRATES_BR_MUTATE_FPARMS ?? '';
let failures = 0;
const expect = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${name}${detail ? `  (${detail})` : ''}`);
};

const VM = await import('../src/client/rendering/ViewmodelController.ts');
const P = await import('../src/client/rendering/viewmodel/poses.ts');
const { WEAPONS } = await import('../src/shared/constants/index.ts');
const glbPath = path.resolve('public/assets/models', MUT === 'noglb' ? 'missing_fp_arms.glb' : VM.FP_ARMS_FILE);

console.log('First-person arms (fp_arms)');
// ── 1. the GLB ───────────────────────────────────────────────────────────────
const arms = {};
if (!fs.existsSync(glbPath)) {
  expect(`${path.basename(glbPath)} exists`, false, 'no file');
} else {
  const buf = fs.readFileSync(glbPath);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = buf.subarray(20 + jsonLen + 8);
  const read = (ai) => {
    const a = gltf.accessors[ai];
    const bv = gltf.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const Ctor = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const stride = (bv.byteStride ?? n * Ctor.BYTES_PER_ELEMENT) / Ctor.BYTES_PER_ELEMENT;
    const base = new Ctor(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), (a.count - 1) * stride + n);
    const out = new Array(a.count);
    for (let i = 0; i < a.count; i++) out[i] = Array.from(base.subarray(i * stride, i * stride + n));
    return out;
  };
  let totalTris = 0;
  for (const s of ['r', 'l']) {
    const node = gltf.nodes.find((x) => x.name === `fp_arm_${s}`);
    expect(`node fp_arm_${s} present`, !!node && node.mesh !== undefined);
    if (!node || node.mesh === undefined) continue;
    const identity = !node.translation && !node.rotation && !node.scale && !node.matrix;
    expect(`fp_arm_${s} carries no node transform (the grip frame is baked)`, identity);
    const info = node.extras?.fpArms ? JSON.parse(node.extras.fpArms) : {};
    expect(`fp_arm_${s}: five fingers, handle clearance recorded`, info.fingers === 5 && typeof info.handleClearMin === 'number', JSON.stringify({ fingers: info.fingers, clear: info.handleClearMin }));
    const tris = [];
    let triCount = 0;
    let skinHasColour = false;
    const colourWhy = [];
    const matNames = new Set();
    for (const prim of gltf.meshes[node.mesh].primitives) {
      const pos = read(prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? read(prim.indices).map((v) => v[0]) : pos.map((_, i) => i);
      const mat = gltf.materials?.[prim.material]?.name ?? '';
      matNames.add(mat.replace(/\.\d+$/, ''));
      // three.js multiplies the material colour by COLOR_0 (and ignores COLOR_1+), so COLOR_0 must BE the skin
      // albedo on the skin and white on the cloth. Red on fae3800e: the skin bake went out as COLOR_3 behind
      // three inherited body layers (COLOR_0 on the skin = pure white -> white-glove hands in the live frame,
      // COLOR_0 on sleeve / cuff / gold = black -> the crew tint multiplied to black).
      const extra = Object.keys(prim.attributes).filter((k) => /^COLOR_[1-9]/.test(k));
      if (extra.length) colourWhy.push(`${mat}: stray ${extra.join(',')}`);
      if (prim.attributes.COLOR_0 !== undefined) {
        const acc = gltf.accessors[prim.attributes.COLOR_0];
        const norm = acc.normalized ? (acc.componentType === 5121 ? 255 : 65535) : 1;
        const cols = read(prim.attributes.COLOR_0);
        const mean = [0, 1, 2].map((c) => cols.reduce((sum, v) => sum + v[c], 0) / cols.length / norm);
        if (mat.startsWith('fp_skin')) {
          const tone = mean[0] > mean[1] && mean[1] > mean[2] && mean[0] > 0.08 && mean[0] < 0.9;
          if (tone) skinHasColour = true;
          else colourWhy.push(`${mat} COLOR_0 mean ${mean.map((v) => v.toFixed(2)).join(',')} is not a skin tone`);
        } else if (Math.min(...mean) < 0.95) {
          colourWhy.push(`${mat} COLOR_0 mean ${mean.map((v) => v.toFixed(2)).join(',')} darkens its material (must be white)`);
        }
      }
      for (let i = 0; i + 2 < idx.length; i += 3) tris.push([pos[idx[i]], pos[idx[i + 1]], pos[idx[i + 2]]]);
      triCount += idx.length / 3;
    }
    totalTris += triCount;
    expect(`fp_arm_${s}: skin albedo baked to COLOR_0 (a skin tone), cloth COLOR_0 white, no stray COLOR_n`,
      skinHasColour && colourWhy.length === 0, colourWhy.join('; '));
    expect(`fp_arm_${s}: sleeve + cuff materials (crew-tinted at runtime)`, matNames.has('fp_sleeve') && matNames.has('fp_cuff'), [...matNames].join(','));
    const zs = tris.flat().map((p) => p[2]);
    expect(`fp_arm_${s}: forearm runs +Z out of frame (>= 0.25 m behind the grip)`, Math.max(...zs) >= 0.25, `z ${Math.min(...zs).toFixed(3)}..${Math.max(...zs).toFixed(3)}`);
    arms[s] = tris;
  }
  expect(`both arms <= 4000 tris (PLAN 3.11 row 4)`, totalTris > 0 && totalTris <= 4000, `${totalTris}`);
}

// ── 2. the swap ──────────────────────────────────────────────────────────────
let src = fs.readFileSync('src/client/rendering/ViewmodelController.ts', 'utf8');
if (MUT === 'noswap') src = src.replace(/fitFpArm\(hand, side, fpArmTemplates/g, 'void (hand, side, fpArmTemplates');
expect('ViewmodelController names the swapped arm fp_arms', /arm\.name = 'fp_arms'/.test(src));
expect('every makeHand reaches fitFpArm (loaded now or when the file lands)', /this\.allHands\.push\(\{ hand, side \}\);\s*\n\s*if \(fpArmTemplates\) fitFpArm\(hand, side, fpArmTemplates/.test(src) && /loadFpArms\(\)\.then/.test(src));

// ── 3. the screen ────────────────────────────────────────────────────────────
const FOV = 70, ASPECT = 16 / 9, W = 192, H = 108;
const t = Math.tan((FOV * Math.PI) / 360);
const scale = VM.FP_ARMS_SCALE * (MUT === 'lens' ? 2 : 1);
function coverage(rootPose, grips) {
  const root = new THREE.Object3D();
  root.position.set(rootPose[0], rootPose[1], rootPose[2]);
  root.rotation.set(rootPose[3], rootPose[4], rootPose[5]);
  root.updateMatrixWorld(true);
  const grid = new Uint8Array(W * H);
  const perHand = {};
  for (const [key, s] of [['right', 'r'], ['left', 'l']]) {
    const g = grips[key];
    if (!g || !arms[s]) continue;
    const hand = new THREE.Object3D();
    hand.position.set(...g.pos);
    if (MUT === 'lens') hand.position.set(g.pos[0] * 0.3, g.pos[1] * 0.3 + 0.1, g.pos[2] + 0.3);   // the old 'blob at the lens'
    hand.rotation.set(...g.rot);
    hand.scale.setScalar((g.scale ?? 1) * scale);
    root.add(hand);
    hand.updateMatrixWorld(true);
    const own = new Uint8Array(W * H);
    const v = new THREE.Vector3();
    for (const tri of arms[s]) {
      const sp = [];
      for (const p of tri) {
        v.set(p[0], p[1], p[2]).applyMatrix4(hand.matrixWorld);
        // Viewmodel materials are exempt from near-plane clipping, so a forearm running at the lens still
        // draws: clamp it just in front of the eye (conservative, it smears to the screen edge).
        if (v.z > -0.01) v.z = -0.01;
        sp.push([((v.x / -v.z) / (t * ASPECT) * 0.5 + 0.5) * W, ((v.y / -v.z) / t * 0.5 + 0.5) * H]);
      }
      if (sp.length < 3) continue;
      const [a, b, c] = sp;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) { own[y * W + x] = 1; grid[y * W + x] = 1; }
      }
    }
    perHand[key] = own.reduce((n, x) => n + x, 0) / (W * H);
  }
  return { total: grid.reduce((n, x) => n + x, 0) / (W * H), perHand };
}
const ZERO = [0, 0, 0, 0, 0, 0];
const states = [];
for (const id of Object.keys(WEAPONS)) {
  const grips = VM.ViewmodelController.weaponGrips(id);
  if (id === 'cutlass') {
    states.push([`cutlass rest`, P.cutlassRestPose(0), grips]);
    states.push([`cutlass mid-slash`, P.cutlassSlashPose(1, 0.3), grips]);
    continue;
  }
  for (const aimBlend of [0, 1]) {
    states.push([`${id} ${aimBlend ? 'aimed' : 'hip'}`, P.weaponPose(id, { aimBlend, bob: 0, sway: 0, strafeTilt: 0, travelSwing: 0, reload: ZERO, recoil: 0 }), grips]);
  }
}
const toolState = { bob: 0, sway: 0, time: 0, firing: false, bailScoopProgress: 0, bucketFilled: false };
for (const kind of ['bucket', 'lantern', 'compass', 'spyglass', 'shovel', 'axe']) {
  states.push([`tool ${kind}`, P.toolPose(kind, toolState), VM.ViewmodelController.pocketGrips(kind)]);
}
// Carried wood / food ride the pocket-preview root, whose rest pose is composed inline in ViewmodelController
// (bite arc, lantern lift, supply-wheel slot); they are graded by the viewmodel-states browser probe, not here.
let worst = 0;
for (const [name, pose, grips] of states) {
  if (pose.some((x) => !Number.isFinite(x))) { expect(`${name}: pose is finite`, false); continue; }
  const { total, perHand } = coverage(pose, grips);
  worst = Math.max(worst, total);
  const shown = Object.entries(perHand);
  const off = shown.filter(([, a]) => a < 0.003).map(([k, a]) => `${k} ${(a * 100).toFixed(2)}%`);
  expect(`${name}: hands cover ${(total * 100).toFixed(1)}% <= 45%, every gripping hand on screen`,
    total <= 0.45 && off.length === 0 && shown.length > 0,
    shown.map(([k, a]) => `${k} ${(a * 100).toFixed(1)}%`).join(', ') + (off.length ? `; OFF-SCREEN ${off.join(', ')}` : ''));
}
console.log(`  worst state ${(worst * 100).toFixed(1)}% of the screen over ${states.length} states`);
console.log(failures ? `test-fp-arms: ${failures} FAIL` : 'test-fp-arms: all green');
process.exit(failures ? 1 : 0);
