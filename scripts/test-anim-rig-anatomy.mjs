#!/usr/bin/env node
// Clip anatomy gate (b3.2b, findings animations-01/02, characters-05): every clip of the pirate clip library,
// sampled at 21 phases with forward kinematics on its own node hierarchy (pure node, no three.js, < 2 s):
//   knees and elbows never hyperextend or bend backward: signed flexion about the anatomical hinge >= -0.05 rad
//   (margin = -flexion <= +0.05). The hinge is fixed to the PARENT bone and taken from the rest pose:
//   knee  = cross(thigh dir, back -Z)    (the calf folds behind the thigh)
//   elbow = cross(upper-arm dir, front +Z) (the forearm folds in front of the upper arm)
//   head look pitch +0.4 about the head's rest right axis (-X, the pirate faces +Z) raises the gaze in every clip.
//   every clip id the state machine plays exists, is non-empty and sits on an exact 30 fps grid.
// Red: node scripts/test-anim-rig-anatomy.mjs --glb public/assets/models/pirate_base.glb (the legacy 24-bone rig).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const FILE = argv.includes('--glb') ? argv[argv.indexOf('--glb') + 1] : `${ROOT}public/assets/models/pirate_clips.glb`;
const LEGACY = `${ROOT}public/assets/models/pirate_base.glb`;
let checks = 0; let failures = 0;
function expect(label, ok, detail = '') { checks++; if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`); }

function readGlb(p) {
  const b = readFileSync(p); const jl = b.readUInt32LE(12); const gltf = JSON.parse(b.subarray(20, 20 + jl).toString());
  const bl = b.readUInt32LE(20 + jl); return { gltf, bin: b.subarray(28 + jl, 28 + jl + bl) };
}
function acc({ gltf, bin }, i) {
  const a = gltf.accessors[i]; const v = gltf.bufferViews[a.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0); const st = v.byteStride ?? 4 * n; const out = [];
  for (let k = 0; k < a.count; k++) { const e = []; for (let c = 0; c < n; c++) e.push(bin.readFloatLE(off + k * st + c * 4)); out.push(e); }
  return out;
}
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => qmul(qmul(q, [...v, 0]), qinv(q)).slice(0, 3);
const qaxis = (ax, a) => { const s = Math.sin(a / 2) / Math.hypot(...ax); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)]; };
const sub = (a, b) => a.map((x, i) => x - b[i]); const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
function slerp(a, b, t) {
  let d = dot(a, b); if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) return unit(a.map((x, i) => x + (b[i] - x) * t));
  const th = Math.acos(d); const s = Math.sin(th); return a.map((x, i) => (Math.sin((1 - t) * th) * x + Math.sin(t * th) * b[i]) / s);
}
function sample([ts, vs], t) {
  if (t <= ts[0]) return vs[0]; if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
  let k = 0; while (ts[k + 1] < t) k++; const u = (t - ts[k]) / (ts[k + 1] - ts[k] || 1);
  return vs[0].length === 4 ? slerp(vs[k], vs[k + 1], u) : vs[k].map((x, i) => x + (vs[k + 1][i] - x) * u);
}

const G = readGlb(FILE); const { gltf } = G; const nodes = gltf.nodes;
const parent = new Map(); nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
const byName = new Map(nodes.map((n, i) => [n.name, i]));
const pick = (...names) => names.map((n) => byName.get(n)).find((i) => i !== undefined);
const B = { thigh_l: pick('thigh_l'), calf_l: pick('calf_l', 'shin_l'), foot_l: pick('foot_l'), thigh_r: pick('thigh_r'), calf_r: pick('calf_r', 'shin_r'), foot_r: pick('foot_r'),
  upperarm_l: pick('upperarm_l'), lowerarm_l: pick('lowerarm_l', 'forearm_l'), hand_l: pick('hand_l'), upperarm_r: pick('upperarm_r'), lowerarm_r: pick('lowerarm_r', 'forearm_r'), hand_r: pick('hand_r'),
  head: pick('head', 'Head') };
const missing = Object.entries(B).filter(([, i]) => i === undefined).map(([k]) => k);
expect(`limb and head bones present (${FILE.replace(ROOT, '')})`, !missing.length, missing.join(', '));
if (missing.length) { console.log(`\n${checks} checks, ${failures} failed`); process.exit(1); }

function fk(local) { // local: Map node -> {r, t}; returns world rotations and positions
  const wr = new Map(); const wp = new Map();
  const go = (i) => {
    if (wr.has(i)) return; const p = parent.get(i); const l = local.get(i);
    if (p === undefined) { wr.set(i, l.r); wp.set(i, l.t); return; }
    go(p); wr.set(i, qmul(wr.get(p), l.r)); wp.set(i, wp.get(p).map((x, k) => x + qrot(wr.get(p), l.t)[k]));
  };
  nodes.forEach((_, i) => go(i)); return { wr, wp };
}
const restLocal = new Map(nodes.map((n, i) => [i, { r: n.rotation ?? [0, 0, 0, 1], t: n.translation ?? [0, 0, 0] }]));
const REST = fk(restLocal);
const LIMBS = [['knee_l', 'thigh_l', 'calf_l', 'foot_l', [0, 0, -1]], ['knee_r', 'thigh_r', 'calf_r', 'foot_r', [0, 0, -1]],
  ['elbow_l', 'upperarm_l', 'lowerarm_l', 'hand_l', [0, 0, 1]], ['elbow_r', 'upperarm_r', 'lowerarm_r', 'hand_r', [0, 0, 1]]];
const hinge = {}; // in the parent (thigh / upper arm) bone's local frame
for (const [id, a, b, , fwd] of LIMBS) {
  const dir = unit(sub(REST.wp.get(B[b]), REST.wp.get(B[a])));
  hinge[id] = qrot(qinv(REST.wr.get(B[a])), unit(cross(dir, fwd)));
}
const headRight = qrot(qinv(REST.wr.get(B.head)), [-1, 0, 0]); const headGaze = qrot(qinv(REST.wr.get(B.head)), [0, 0, 1]); const headUp = qrot(qinv(REST.wr.get(B.head)), [0, 1, 0]);

const REQUIRED_GAPS = ['strafe_l', 'strafe_r', 'walk_back', 'run_back', 'climb', 'bail', 'hammer', 'spyglass', 'downed', 'revive', 'drown'];
const legacyIds = existsSync(LEGACY) ? readGlb(LEGACY).gltf.animations.map((a) => a.name) : [];
const isLibrary = !argv.includes('--glb');
console.log(`Clip anatomy (${gltf.animations.length} clips, 21 phases each)`);
let bad = 0; const worst = [];
for (const a of gltf.animations) {
  const ch = a.channels.map((c) => ({ node: c.target.node, path: c.target.path, s: [acc(G, a.samplers[c.sampler].input).map((x) => x[0]), acc(G, a.samplers[c.sampler].output)] }));
  const dur = Math.max(...ch.map((c) => c.s[0][c.s[0].length - 1]));
  let clipWorst = -Infinity; let where = ''; let gazeOk = true;
  for (let k = 0; k <= 20; k++) {
    const t = dur * k / 20; const local = new Map([...restLocal].map(([i, v]) => [i, { ...v }]));
    for (const c of ch) { const v = sample(c.s, t); if (c.path === 'rotation') local.get(c.node).r = v; else if (c.path === 'translation') local.get(c.node).t = v; }
    const P = fk(local);
    for (const [id, ja, jb, jc] of LIMBS) {
      const u = sub(P.wp.get(B[jb]), P.wp.get(B[ja])); const f = sub(P.wp.get(B[jc]), P.wp.get(B[jb]));
      const h = unit(qrot(P.wr.get(B[ja]), hinge[id]));
      const flexion = Math.atan2(dot(cross(unit(u), unit(f)), h), dot(unit(u), unit(f)));
      if (-flexion > clipWorst) { clipWorst = -flexion; where = `${id} at phase ${k}/20`; }
    }
    if (k === 10) { // head look pitch +0.4 must raise the gaze
      // toward the head's own up (a pirate lying on his back already gazes at +Y world)
      const g0 = qrot(P.wr.get(B.head), headGaze); const up = qrot(P.wr.get(B.head), headUp);
      const hl = local.get(B.head); hl.r = qmul(hl.r, qaxis(headRight, 0.4));
      const g1 = qrot(fk(local).wr.get(B.head), headGaze);
      gazeOk = dot(g1, up) > dot(g0, up) + 0.1;
    }
  }
  if (clipWorst > 0.05 || !gazeOk) { bad++; worst.push(`${a.name}: margin ${clipWorst.toFixed(3)} rad (${where})${gazeOk ? '' : ', head pitch +0.4 does not raise the gaze'}`); }
}
expect(`every clip: knee and elbow flexion margins <= +0.05 rad at 21 phases and head pitch +0.4 raises the gaze (${gltf.animations.length - bad}/${gltf.animations.length})`, bad === 0, worst.slice(0, 12).join('\n      '));

if (isLibrary) {
  const ids = new Map(gltf.animations.map((a) => [a.name, a]));
  const need = [...new Set([...legacyIds, ...REQUIRED_GAPS])];
  const absent = need.filter((id) => !ids.has(id));
  expect(`every clip id the state machine plays exists (${need.length - absent.length}/${need.length}: the legacy 33 + the b3.2b gap clips)`, need.length > 30 && !absent.length, absent.join(', '));
  const off = []; const thin = [];
  for (const a of gltf.animations) {
    const t = acc(G, a.samplers[a.channels[0].sampler].input).map((x) => x[0]);
    if (t.length < 2 || a.channels.filter((c) => c.target.path === 'rotation').length < 50) thin.push(a.name);
    if (t.some((x, i) => Math.abs(x - i / 30) > 1e-4)) off.push(a.name);
  }
  expect('every clip non-empty: >= 2 keys and >= 50 animated bones', !thin.length, thin.join(', '));
  expect('every clip on an exact 30 fps grid', !off.length, off.join(', '));
  const rm = gltf.animations.filter((a) => a.channels.some((c) => nodes[c.target.node].name === 'root')).map((a) => a.name).sort();
  expect(`root motion only on roll / vault / slide (${rm.join(', ')})`, rm.every((n) => /^(roll|vault|slide_start|slide_exit)$/.test(n)) && rm.includes('roll') && rm.includes('vault'));
}
console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
