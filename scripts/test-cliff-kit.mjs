#!/usr/bin/env node
// test-cliff-kit (b4.6; islands-02): the cliff kit graded from the SHIPPED GLBs, not from the build
// log. Run: node --import tsx scripts/test-cliff-kit.mjs
//
// b4.6b section (this file grows with b4.6c walker / ray gates):
//   [arch-mast]  sea_arch_a, every level (LOD0 + _lods.glb LOD1/LOD2/far): every triangle clipped to
//                the slab |x| <= 9 m (the 18 m span) lies above the galleon main truck + 1 m, and
//                every triangle clipped to |x| <= sail halfSpan + 1 m lies above that sail's head
//                + 1 m. The rig numbers come from src/shared/hull.ts getShipRigPlan(SHIP_STATS.galleon)
//                so a taller galleon turns this red. Exact polygon clipping, not vertex sampling.
//   [bridge]     sea_arch_b LOD0: the up-facing (slope < 37 deg) crown faces span >= 2.5 m across.
//   [canary]     the clipper itself: a triangle that dips into the channel must be reported.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getShipRigPlan } from '../src/shared/hull.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/assets/models');
let failed = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failed++;
};

/** {nodeName: Float64Array triangles (9 per tri)} in glTF (game) space, node TRS applied. */
export function glbTriangles(file) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);
  const acc = (i) => {
    const a = gltf.accessors[i];
    const bv = gltf.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC3: 3 }[a.type];
    const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    if (!C) throw new Error(`${file}: componentType ${a.componentType} (quantised source GLB?)`);
    const stride = bv.byteStride || comps * C.BYTES_PER_ELEMENT;
    const out = new Float64Array(a.count * comps);
    const dv = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0));
    const rd = { 5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true), 5123: (o) => dv.getUint16(o, true), 5121: (o) => dv.getUint8(o) }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < comps; c++) out[k * comps + c] = rd(k * stride + c * C.BYTES_PER_ELEMENT);
    return out;
  };
  const xf = (n, p) => { // scale, rotate (quaternion), translate
    const s = n.scale || [1, 1, 1], q = n.rotation || [0, 0, 0, 1], t = n.translation || [0, 0, 0];
    let [x, y, z] = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
    const [qx, qy, qz, qw] = q;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    x = ix * qw + iw * -qx + iy * -qz - iz * -qy; y = iy * qw + iw * -qy + iz * -qx - ix * -qz; z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return [x + t[0], y + t[1], z + t[2]];
  };
  const out = {};
  const walk = (ni, chain) => {
    const n = gltf.nodes[ni];
    const ch = [n, ...chain];
    if (n.mesh !== undefined) {
      const tris = [];
      for (const prim of gltf.meshes[n.mesh].primitives) {
        const pos = acc(prim.attributes.POSITION);
        const idx = prim.indices !== undefined ? acc(prim.indices) : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
        for (const i of idx) {
          let p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
          for (const m of ch) p = xf(m, p);
          tris.push(...p);
        }
      }
      out[n.name || `node${ni}`] = Float64Array.from(tris);
    }
    for (const c of n.children || []) walk(c, ch);
  };
  for (const r of gltf.scenes[gltf.scene || 0].nodes) walk(r, []);
  return out;
}

/** Lowest y of the parts of every triangle inside the slab |x| <= h (Infinity if none enters). */
export function slabFloor(tris, h) {
  let lo = Infinity;
  for (let t = 0; t < tris.length; t += 9) {
    let poly = [[tris[t], tris[t + 1]], [tris[t + 3], tris[t + 4]], [tris[t + 6], tris[t + 7]]];
    for (const [sgn, lim] of [[1, h], [-1, h]]) { // keep sgn * x <= lim
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = sgn * a[0] - lim, db = sgn * b[0] - lim;
        if (da <= 0) next.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const u = da / (da - db);
          next.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
        }
      }
      poly = next;
      if (!poly.length) break;
    }
    for (const p of poly) lo = Math.min(lo, p[1]);
  }
  return lo;
}

// [canary] a triangle from leg (x 12) to a point at x 3, y 5 must floor the 9 m slab at y <= 5.
const canary = slabFloor(Float64Array.from([12, 0, 0, 12, 30, 0, 3, 5, 0]), 9);
ok(canary <= 5.0001, '[canary] clipper sees a triangle dipping into the channel', `floor ${canary.toFixed(2)}`);
ok(slabFloor(Float64Array.from([12, 0, 0, 14, 30, 0, 13, 5, 1]), 9) === Infinity, '[canary] a leg triangle outside the slab is ignored');

const plan = getShipRigPlan(SHIP_STATS.galleon);
const truck = Math.max(...plan.map((m) => m.truckY));
const sails = plan.flatMap((m) => m.sails);
const archA = path.join(MODELS, 'sea_arch_a.glb');
ok(existsSync(archA), '[arch-mast] sea_arch_a.glb exists');
if (existsSync(archA)) {
  const levels = { ...glbTriangles(archA) };
  const lods = path.join(MODELS, 'sea_arch_a_lods.glb');
  ok(existsSync(lods), '[arch-mast] sea_arch_a_lods.glb exists');
  if (existsSync(lods)) Object.assign(levels, glbTriangles(lods));
  for (const [name, tris] of Object.entries(levels)) {
    const mast = slabFloor(tris, 9.0);
    ok(mast >= truck + 1.0, `[arch-mast] ${name}: 18 m span clear to the galleon truck + 1 m`,
      `span underside ${mast.toFixed(2)} m >= ${(truck + 1).toFixed(2)} m (${tris.length / 9} tris)`);
    const worst = Math.min(...sails.map((s) => slabFloor(tris, s.halfSpan + 1.0) - (s.headY + 1.0)));
    ok(worst >= 0, `[arch-mast] ${name}: every galleon yard (halfSpan + 1 m) passes under`, `worst margin ${worst.toFixed(2)} m`);
  }
}

const archB = path.join(MODELS, 'sea_arch_b.glb');
ok(existsSync(archB), '[bridge] sea_arch_b.glb exists');
if (existsSync(archB)) {
  const tris = Object.values(glbTriangles(archB)).find((t) => t.length) || new Float64Array();
  let top = -Infinity;
  const faces = [];
  for (let t = 0; t < tris.length; t += 9) {
    const c = [0, 1, 2].map((a) => (tris[t + a] + tris[t + 3 + a] + tris[t + 6 + a]) / 3);
    if (Math.abs(c[0]) > 2.0) continue;
    const u = [0, 1, 2].map((a) => tris[t + 3 + a] - tris[t + a]), v = [0, 1, 2].map((a) => tris[t + 6 + a] - tris[t + a]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    top = Math.max(top, c[1]);
    faces.push({ c, ny: n[1] / len });
  }
  const walk = faces.filter((f) => f.ny > 0.8 && f.c[1] > top - 1.0).map((f) => f.c[2]);
  const width = walk.length ? Math.max(...walk) - Math.min(...walk) : 0;
  ok(width >= 2.5, '[bridge] sea_arch_b crown walkable >= 2.5 m wide', `${width.toFixed(2)} m, deck top ${top.toFixed(2)} m`);
}

console.log(failed ? `test-cliff-kit: ${failed} FAILED` : 'test-cliff-kit: all passed');
process.exit(failed ? 1 : 0);
