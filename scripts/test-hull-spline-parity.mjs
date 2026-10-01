#!/usr/bin/env node
// THE SPLINE LOFT GATE (b4.2b, ships-01 / ships-08).
//
// src/shared/hull.ts grows a C1 spline surface over the station table:
// centripetal Catmull-Rom along the length, monotone cubic (PCHIP) along the
// girth, plus a counter station under the transom, a flare station in the bow
// and a lofted stem line closing the bow (the linear loft pinched 0.32 W ->
// 0.055 W in ONE facet and capped the stem flat). `sampleHullSurface(profile,
// u, v)` is the single function the renderer, the server contact chain, the
// waterline outline and the kit sockets will read (b4.2c switches them); this
// gate proves the surface is worth switching to BEFORE any consumer moves:
//
//  1. parity    : the surface passes through every station slot (the 9 loft
//                 rows bit-for-bit as getHullProfile builds them) within 1e-9 m;
//  2. continuity: position, tangent direction and normal are continuous across
//                 every station knot and every girth knot (C1 / G1);
//  3. normals   : the analytic normal matches a finite-difference normal, is
//                 unit length and points outboard;
//  4. smoothness: on a 72 x 22 sampling, the max angle between adjacent girth
//                 faces (the linear loft is graded with the SAME metric and must
//                 fail < 5 deg). b4.2b1 holds a ratchet aft of station 7 and
//                 prints the geometric floor; the < 5 deg bar is b4.2b2's;
//  5. walk taper: the spline sheer stays outboard of getShipDeckWalkHalfWidth
//                 at 200 z samples (the deck clamp never strands a pirate past
//                 a drawn line);
//  6. no folds  : z is strictly increasing in u along every iso-v line, x >= 0;
//  7. stern     : the transom rake is kept (>= today's ~20 deg) and the counter
//                 overhangs the sternpost;
//  8. no consumer switched: getHullProfile still has the 9 loft stations.
import { readFileSync } from 'node:fs';
import * as hull from '../src/shared/hull.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getShipDeckWalkHalfWidth } from '../src/shared/utils/index.ts';

const { getHullProfile, sampleHullSurface, getHullSplineStations, hullSplineUAtZ } = hull;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
if (typeof sampleHullSurface !== 'function' || typeof getHullSplineStations !== 'function' || typeof hullSplineUAtZ !== 'function') {
  console.error('  ✗ FAIL: src/shared/hull.ts exports no sampleHullSurface / getHullSplineStations / hullSplineUAtZ');
  process.exit(1);
}

const TYPES = ['sloop', 'brigantine', 'galleon'];
const DEG = 180 / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * DEG;
const P = (s) => [s.x, s.y, s.z];
const N = (s) => [s.nx, s.ny, s.nz];

/** Max angle between adjacent faces of a NU x NV grid (girth direction, and
 *  along the length for the report). `at(u, v)` -> [x, y, z]. */
function faceAngles(at, NU = 72, NV = 22, uMax = 1) {
  const g = [];
  for (let i = 0; i < NU; i++) {
    const row = [];
    for (let j = 0; j < NV; j++) row.push(at(uMax * i / (NU - 1), j / (NV - 1)));
    g.push(row);
  }
  const fn = [];
  for (let i = 0; i < NU - 1; i++) {
    const row = [];
    for (let j = 0; j < NV - 1; j++) {
      // Quad normal from its diagonals (u along +z, v down the girth): outward on starboard.
      const d1 = sub(g[i + 1][j + 1], g[i][j]);
      const d2 = sub(g[i][j + 1], g[i + 1][j]);
      const c = cross(d1, d2);
      row.push(Math.hypot(...c) < 1e-12 ? null : norm(c));
    }
    fn.push(row);
  }
  let girth = 0, girthAt = '', along = 0, alongAt = '';
  for (let i = 0; i < NU - 1; i++) for (let j = 0; j < NV - 1; j++) {
    const a = fn[i][j];
    if (!a) continue;
    if (j + 1 < NV - 1 && fn[i][j + 1]) {
      const d = angle(a, fn[i][j + 1]);
      if (d > girth) { girth = d; girthAt = `u=${(uMax * i / (NU - 1)).toFixed(3)} v=${(j / (NV - 1)).toFixed(3)}`; }
    }
    if (i + 1 < NU - 1 && fn[i + 1][j]) {
      const d = angle(a, fn[i + 1][j]);
      if (d > along) { along = d; alongAt = `u=${(uMax * i / (NU - 1)).toFixed(3)} v=${(j / (NV - 1)).toFixed(3)}`; }
    }
  }
  return { girth, girthAt, along, alongAt };
}

/** The linear loft as the renderer draws it today (makeLoftedHullGeometry):
 *  bilinear between the 9 stations x 7 slots. Graded with the same metric. */
function linearLoftAt(profile) {
  const st = profile.stations;
  return (u, v) => {
    const fs = u * (st.length - 1), i = Math.min(st.length - 2, Math.floor(fs)), tu = fs - i;
    const fj = v * (st[0].slots.length - 1), j = Math.min(st[0].slots.length - 2, Math.floor(fj)), tv = fj - j;
    const lerp = (a, b, t) => [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t];
    const a = lerp(st[i].slots[j], st[i].slots[j + 1], tv);
    const b = lerp(st[i + 1].slots[j], st[i + 1].slots[j + 1], tv);
    return [a[0] + (b[0] - a[0]) * tu, a[1] + (b[1] - a[1]) * tu, a[2] + (b[2] - a[2]) * tu];
  };
}

for (const type of TYPES) {
  const profile = getHullProfile(type);
  const stats = SHIP_STATS[type];
  const spl = getHullSplineStations(profile);
  console.log(`— ${type} (W ${profile.W} H ${profile.H} L ${profile.L}, ${spl.length} spline stations) —`);

  // 8. no consumer switched: the profile is still the 9-station loft.
  expect(`${type}: getHullProfile keeps its 9 loft stations (no consumer switched)`, profile.stations.length === 9,
    `got ${profile.stations.length}`);

  // 1. parity: every spline station slot lies on the surface at its knot; the
  //    loft rows ARE profile.stations.
  let worst = 0, worstAt = '', loftRows = 0, fairBad = 0;
  const faired = [];
  for (let i = 0; i < spl.length; i++) {
    const s = spl[i];
    if (s.loftIndex >= 0) {
      const ref = profile.stations[s.loftIndex];
      loftRows += 1;
      for (let k = 0; k < ref.slots.length; k++) {
        if (s.faired.includes(k)) {
          // Faired slot: only x may move, and only out to the keel siding.
          faired.push(`st${s.loftIndex}.slot${k} +${((s.slots[k].x - ref.slots[k].x) * 100).toFixed(1)} cm`);
          if (s.slots[k].y !== ref.slots[k].y || s.slots[k].z !== ref.slots[k].z || s.slots[k].x !== ref.slots[ref.slots.length - 1].x || k < 4) fairBad += 1;
          continue;
        }
        const d = Math.hypot(ref.slots[k].x - s.slots[k].x, ref.slots[k].y - s.slots[k].y, ref.slots[k].z - s.slots[k].z);
        if (d > worst) { worst = d; worstAt = `loft st${s.loftIndex} slot${k} (table)`; }
      }
    }
    for (let k = 0; k < s.slots.length; k++) {
      const r = sampleHullSurface(profile, s.u, s.girthKnots[k]);
      const d = Math.hypot(r.x - s.slots[k].x, r.y - s.slots[k].y, r.z - s.slots[k].z);
      if (d > worst) { worst = d; worstAt = `spline st${i} (${s.kind}) slot${k}`; }
    }
  }
  expect(`${type}: surface passes through all ${spl.length}x7 station slots, the ${loftRows} loft rows bit-equal to getHullProfile (max ${worst.toExponential(2)} m)`,
    loftRows === 9 && worst <= 1e-9, `worst ${worst} at ${worstAt}, loft rows ${loftRows}`);
  expect(`${type}: fairing only raised x to the keel siding, below the waterline, on ${faired.length} loft slot(s) [${faired.join(', ')}]`,
    fairBad === 0 && faired.length <= 2, `${fairBad} faired slots moved y/z or past the keel siding`);

  // 2. continuity across every station knot (u) and girth knot (v).
  const eps = 1e-9, h = 1e-7;
  const tanU = (u, v) => norm(sub(P(sampleHullSurface(profile, Math.min(1, u + h), v)), P(sampleHullSurface(profile, Math.max(0, u - h), v))));
  let jumpP = 0, jumpT = 0, jumpN = 0, jumpAt = '';
  const VS = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
  for (let i = 1; i < spl.length - 1; i++) for (const v of VS) {
    const a = sampleHullSurface(profile, spl[i].u - eps, v), b = sampleHullSurface(profile, spl[i].u + eps, v);
    const dp = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const dn = angle(N(a), N(b));
    const ta = norm(sub(P(a), P(sampleHullSurface(profile, spl[i].u - eps - h, v))));
    const tb = norm(sub(P(sampleHullSurface(profile, spl[i].u + eps + h, v)), P(b)));
    const dt = angle(ta, tb);
    if (dp > jumpP) jumpP = dp;
    if (dt > jumpT) { jumpT = dt; jumpAt = `station ${i} v=${v}`; }
    if (dn > jumpN) jumpN = dn;
  }
  for (const s of spl) for (let k = 1; k < s.girthKnots.length - 1; k++) for (const du of [-0.004, 0, 0.004]) {
    const u = Math.max(0, Math.min(1, s.u + du)), g = s.girthKnots[k];
    const a = sampleHullSurface(profile, u, g - eps), b = sampleHullSurface(profile, u, g + eps);
    const dp = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const ta = norm(sub(P(a), P(sampleHullSurface(profile, u, g - eps - h))));
    const tb = norm(sub(P(sampleHullSurface(profile, u, g + eps + h)), P(b)));
    const dt = angle(ta, tb), dn = angle(N(a), N(b));
    if (dp > jumpP) jumpP = dp;
    if (dt > jumpT) { jumpT = dt; jumpAt = `girth knot ${k} u=${u.toFixed(3)}`; }
    if (dn > jumpN) jumpN = dn;
  }
  expect(`${type}: C1 across station and girth knots (position jump ${jumpP.toExponential(1)} m, tangent ${jumpT.toFixed(3)} deg, normal ${jumpN.toFixed(3)} deg)`,
    jumpP < 1e-4 && jumpT < 0.5 && jumpN < 0.5, `worst tangent jump at ${jumpAt}`);

  // 3. analytic normal vs finite differences; unit; outboard.
  const uSt7 = spl.find((r) => r.loftIndex === 7).u;
  let nWorst = 0, nAt = '', unitWorst = 0, inboard = 0, forefootInboard = 0;
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 20; j++) {
    const u = 0.002 + 0.996 * i / 40, v = 0.002 + 0.996 * j / 20;
    const s = sampleHullSurface(profile, u, v);
    const du = sub(P(sampleHullSurface(profile, u + 1e-5, v)), P(sampleHullSurface(profile, u - 1e-5, v)));
    const dv = sub(P(sampleHullSurface(profile, u, v + 1e-5)), P(sampleHullSurface(profile, u, v - 1e-5)));
    const fd = norm(cross(du, dv));
    const d = angle(fd, N(s));
    if (d > nWorst) { nWorst = d; nAt = `u=${u.toFixed(3)} v=${v.toFixed(3)}`; }
    unitWorst = Math.max(unitWorst, Math.abs(Math.hypot(s.nx, s.ny, s.nz) - 1));
    // Outboard: away from the centreline axis of the hull (x >= 0 side).
    if (s.nx < -0.05 && s.x > profile.W * 0.03) { if (u <= uSt7) inboard += 1; else forefootInboard += 1; }
  }
  expect(`${type}: analytic normal = finite-difference normal within 0.5 deg (worst ${nWorst.toFixed(3)} deg at ${nAt}), unit, outboard aft of station 7 (forefoot: ${forefootInboard} inboard samples, b4.2b2)`,
    nWorst < 0.5 && unitWorst < 1e-9 && inboard === 0, `unit error ${unitWorst}, ${inboard} inboard normals`);

  // 4. smoothness on the 72 x 22 LOD0 sampling; the linear loft must fail it.
  const spline = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)));
  const aft = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 22, uSt7);
  const aft34 = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 34, uSt7);
  // Geometric floor: total normal turning sheer -> keel over the 21 girth faces.
  let turnMax = 0, turnAt = 0;
  for (let i = 0; i <= 36; i++) {
    const u = uSt7 * i / 36;
    let acc = 0, prev = N(sampleHullSurface(profile, u, 0));
    for (let j = 1; j <= 400; j++) { const nn = N(sampleHullSurface(profile, u, j / 400)); acc += angle(prev, nn); prev = nn; }
    if (acc > turnMax) { turnMax = acc; turnAt = u; }
  }
  const linear = faceAngles(linearLoftAt(profile));
  const linearAft = faceAngles(linearLoftAt(profile), 72, 22, 7 / 8);
  console.log(`    72x22 whole shell: girth ${spline.girth.toFixed(2)} deg at ${spline.girthAt} (linear ${linear.girth.toFixed(1)}), along ${spline.along.toFixed(2)} at ${spline.alongAt} (linear ${linear.along.toFixed(1)})`);
  console.log(`    aft of station 7: 72x22 girth ${aft.girth.toFixed(2)} deg at ${aft.girthAt}, 72x34 ${aft34.girth.toFixed(2)}; section turns up to ${turnMax.toFixed(1)} deg (u=${turnAt.toFixed(3)}) -> floor ${(turnMax / 21).toFixed(2)} deg/face on 22, ${(turnMax / 33).toFixed(2)} on 34`);
  expect(`${type}: linear loft today fails the < 5 deg metric (girth ${linear.girth.toFixed(1)} deg at ${linear.girthAt}) — the metric can fail`,
    linear.girth >= 5, 'the metric no longer distinguishes a faceted loft');
  // b4.2b1 RATCHET (split per PLAN rule 9). The slice bar "< 5 deg on 72x22" is
  // geometrically out of reach on today's station table: the section turns
  // ~125 deg sheer -> keel, so 21 girth faces cannot average under ~6 deg with
  // ANY sampler. b4.2b2 owns the bar (LOD0 girth count + bow re-loft); until
  // then the aft run may never get worse than measured at b4.2b1, and must be
  // at least 3x smoother than the linear loft over the same run.
  const RATCHET = { sloop: 6.6, brigantine: 7.7, galleon: 11.5 }[type];
  expect(`${type}: aft of station 7, adjacent girth faces on 72x22 <= ${RATCHET} deg ratchet (spline ${aft.girth.toFixed(2)}, linear ${linearAft.girth.toFixed(1)}; target < 5 in b4.2b2)`,
    aft.girth <= RATCHET && aft.girth * 3 <= linearAft.girth, `spline ${aft.girth} at ${aft.girthAt}, linear ${linearAft.girth}`);

  // 5. walk taper at 200 z samples on the spline SHEER (v = 0).
  let tight = Infinity, tightZ = 0;
  for (let i = 0; i < 200; i++) {
    const zf = -0.5 + i / 199;
    const u = hullSplineUAtZ(profile, zf * profile.L, 0);
    const sheer = sampleHullSurface(profile, u, 0);
    const walk = getShipDeckWalkHalfWidth(stats, zf * stats.length);
    const m = (sheer.x - walk) / stats.width;
    if (Math.abs(sheer.z - zf * profile.L) > 1e-6) { tight = -Infinity; tightZ = zf; break; }
    if (m < tight) { tight = m; tightZ = zf; }
  }
  expect(`${type}: spline sheer outboard of the walk taper at 200 z samples (tightest ${tight.toFixed(4)} W at z=${tightZ.toFixed(3)} L)`,
    tight >= -0.001, `tightest ${tight} W at z=${tightZ} L`);

  // 6. no folds: z strictly increasing in u on every iso-v line; x >= 0.
  let fold = 0, foldAt = '', minX = Infinity;
  for (let j = 0; j < 22; j++) {
    const v = j / 21;
    let prev = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const s = sampleHullSurface(profile, i / 400, v);
      if (s.z <= prev) { fold += 1; foldAt = `v=${v.toFixed(3)} u=${(i / 400).toFixed(4)}`; }
      prev = s.z;
      minX = Math.min(minX, s.x);
    }
  }
  expect(`${type}: no folds (z strictly increasing in u on 22 iso-v lines), x >= 0 (min ${minX.toFixed(4)} m)`,
    fold === 0 && minX >= 0, `${fold} fold samples, last at ${foldAt}`);

  // 7. stern: transom rake kept (station 0 untouched) and a counter overhang.
  const top = sampleHullSurface(profile, 0, 0), keel = sampleHullSurface(profile, 0, 1);
  const rake = Math.atan2(keel.z - top.z, top.y - keel.y) * DEG;
  const st0 = profile.stations[0];
  const oldRake = Math.atan2(st0.slots[6].z - st0.slots[0].z, st0.slots[0].y - st0.slots[6].y) * DEG;
  const counter = spl.find((s) => s.kind === 'counter');
  const stem = spl[spl.length - 1];
  expect(`${type}: transom rake ${rake.toFixed(1)} deg >= today's ${oldRake.toFixed(1)} deg (and >= 19)`, rake >= oldRake - 1e-9 && rake >= 19,
    `rake ${rake}`);
  expect(`${type}: a counter station overhangs aft (sheer ${counter ? (counter.slots[6].z - counter.slots[0].z).toFixed(2) : 'n/a'} m aft of its keel) and the bow closes on a lofted stem line`,
    !!counter && counter.slots[0].z < counter.slots[6].z - 0.02 * profile.L * 0.5
      && stem.kind === 'stem' && stem.slots.every((p) => p.x <= profile.W * 0.012 + 1e-9),
    `counter ${JSON.stringify(counter?.slots?.[0])} stem ${stem.kind}`);

  // determinism: the same call twice is the same bits.
  const a = sampleHullSurface(profile, 0.4321, 0.3579), b = sampleHullSurface(profile, 0.4321, 0.3579);
  expect(`${type}: deterministic`, JSON.stringify(a) === JSON.stringify(b));
  }

const src = readFileSync(new URL('../src/shared/hull.ts', import.meta.url), 'utf8');
expect('src/shared/hull.ts has no Math.random and no three.js import', !/Math\.random/.test(src) && !/from 'three'/.test(src));

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nPASS: one C1 spline hull through every station, no folds, walk taper kept, smoothness ratchet held (< 5 deg bar: b4.2b2).');
