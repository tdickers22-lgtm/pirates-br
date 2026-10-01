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
//  4. smoothness: max angle between adjacent girth faces (the linear loft is
//                 graded with the SAME metric and must fail < 5 deg). b4.2b2
//                 SPEC CHANGE: the bar is < 5 deg on 72 x 40 (LOD0 >= 40 girth
//                 samples per side, ~11k shell tris, inside the D26 LOD0 band),
//                 because the section turns 113-128 deg sheer -> keel and 21
//                 faces cannot average under 5.4-6.1 deg with any sampler.
//                 b4.2b3: held over the WHOLE shell, the bow included (arc-
//                 length geometry rows + per-station v -> t maps measured on
//                 the surface normal; was 14.9-15.8 deg at the forefoot); the
//                 along-length faces hold a ratchet;
//  5. walk taper: the spline sheer stays outboard of getShipDeckWalkHalfWidth
//                 at 200 z samples (the deck clamp never strands a pirate past
//                 a drawn line);
//  6. no folds  : z is strictly increasing in u along every iso-v line, x >= 0;
//  7. stern     : the transom rake is kept (>= today's ~20 deg) and the counter
//                 overhangs the sternpost;
//  8. the station table: getHullProfile still has the 9 loft stations (the
//     spline reads them; the spline-only rows never enter the profile);
//  9. every consumer on the spline (b4.2c): the server's waterline outline
//     (one point per spline row, at y = 0) and contact chain (the widest point
//     of each spline row) lie on the surface within 1 cm; hullSurfacePointAt
//     (z, y) round-trips sampleHullSurface within 1 cm and its section normal
//     within 1 deg; stationSurfaceAt walks the spline row of its station.
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
  expect(`${type}: getHullProfile keeps its 9 loft stations`, profile.stations.length === 9,
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
  // b4.2b2: outboard over the WHOLE shell, the forefoot included (1-3 inboard
  // samples there before the stem head was re-lofted).
  expect(`${type}: analytic normal = finite-difference normal within 0.5 deg (worst ${nWorst.toFixed(3)} deg at ${nAt}), unit, outboard everywhere (${inboard} aft / ${forefootInboard} forward of station 7 inboard)`,
    nWorst < 0.5 && unitWorst < 1e-9 && inboard === 0 && forefootInboard === 0, `unit error ${unitWorst}, ${inboard} + ${forefootInboard} inboard normals`);

  // 4. smoothness on the 72 x 22 LOD0 sampling; the linear loft must fail it.
  const spline = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)));
  const aft = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 22, uSt7);
  const aft34 = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 34, uSt7);
  const aft40 = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 40, uSt7);
  const whole40 = faceAngles((u, v) => P(sampleHullSurface(profile, u, v)), 72, 40);
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
  console.log(`    aft of station 7: 72x40 girth ${aft40.girth.toFixed(2)} deg at ${aft40.girthAt}, 72x34 ${aft34.girth.toFixed(2)}, 72x22 ${aft.girth.toFixed(2)}; whole 72x40 girth ${whole40.girth.toFixed(2)} at ${whole40.girthAt}, along ${whole40.along.toFixed(2)} at ${whole40.alongAt}; section turns up to ${turnMax.toFixed(1)} deg (u=${turnAt.toFixed(3)}) -> floor ${(turnMax / 21).toFixed(2)} deg/face on 22, ${(turnMax / 33).toFixed(2)} on 34`);
  expect(`${type}: linear loft today fails the < 5 deg metric (girth ${linear.girth.toFixed(1)} deg at ${linear.girthAt}) — the metric can fail`,
    linear.girth >= 5, 'the metric no longer distinguishes a faceted loft');
  // b4.2b2 BAR (spec change, see header 4): aft of station 7, < 5 deg on
  // 72 x 40, and at least 3x smoother than the linear loft over the same run
  // on 72 x 22. RED at 3995a9e2 (mean shared knots): 4.57/4.52/6.22 deg.
  expect(`${type}: aft of station 7, adjacent girth faces on 72x40 < 5 deg (spline ${aft40.girth.toFixed(2)} at ${aft40.girthAt}; 72x22 ${aft.girth.toFixed(2)} vs linear ${linearAft.girth.toFixed(1)})`,
    aft40.girth < 5 && aft.girth * 3 <= linearAft.girth, `spline ${aft40.girth} at ${aft40.girthAt}, 72x22 ${aft.girth}, linear ${linearAft.girth}`);
  // b4.2b3 BOW BAR: the WHOLE shell (flare row, stem head, stem line, the
  // forefoot) < 5 deg between adjacent girth faces on 72 x 40. RED at e6026f41:
  // 14.93/15.52/15.83 deg at u 0.930 v 0.949 (turning-weighted rows blended
  // unlike girth positions: 244-278 deg of normal path turning for a net 60).
  // Along-length faces: ratchet at the b4.2b3 measurement (24.0-24.2 before);
  // the renderer may densify u forward of station 7 (b4.2c).
  const ALONG = { sloop: 20.0, brigantine: 20.3, galleon: 20.5 }[type];
  expect(`${type}: whole shell (bow included) adjacent girth faces on 72x40 < 5 deg (${whole40.girth.toFixed(2)} at ${whole40.girthAt}), along-length <= ${ALONG} deg ratchet (${whole40.along.toFixed(2)} at ${whole40.alongAt})`,
    whole40.girth < 5 && whole40.along <= ALONG, `girth ${whole40.girth} at ${whole40.girthAt}, along ${whole40.along} at ${whole40.alongAt}`);

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

  // 9. every consumer on the spline (b4.2c), within 1 cm.
  const CM = 0.01;
  const { L, W } = profile;
  const outline = hull.getHullWaterlineOutline(type), chain = hull.getHullContactChain(type);
  const ROW_N = 1200;
  let olWorst = 0, olAt = 'n/a', chWorst = 0, chAt = 'n/a';
  spl.forEach((s, i) => {
    let lo = 0, hi = 1;
    for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (sampleHullSurface(profile, s.u, m).y > 0) lo = m; else hi = m; }
    const wl = sampleHullSurface(profile, s.u, (lo + hi) / 2);
    // contact: the row's widest point fixes z (a plateau may take any z of its
    // widest band); the radius is the widest the z-section is over every height.
    const pts = [];
    for (let j = 0; j <= ROW_N; j++) pts.push(sampleHullSurface(profile, s.u, j / ROW_N));
    const rowMax = Math.max(...pts.map((p) => p.x));
    const band = pts.filter((p) => p.x >= rowMax - CM);
    const zLo = Math.min(...band.map((p) => p.z)) - CM, zHi = Math.max(...band.map((p) => p.z)) + CM;
    const cz = chain[i] ? chain[i].zF * L : 0;
    let maxX = 0;
    for (let k = 0; k <= 400; k++) maxX = Math.max(maxX, hull.hullSurfacePointAt(profile, cz, -profile.draft * 1.05 + (profile.H * 1.2 + profile.draft) * (k / 400)).x);
    const o = outline[i], c = chain[i];
    const dO = o ? Math.hypot(o.zF * L - wl.z, o.halfF * W - wl.x) : Infinity;
    const dC = c ? Math.max(Math.abs(c.halfF * W - maxX), c.zF * L < zLo ? zLo - c.zF * L : c.zF * L > zHi ? c.zF * L - zHi : 0) : Infinity;
    if (dO > olWorst) { olWorst = dO; olAt = `${s.kind} #${i} u ${s.u.toFixed(3)}`; }
    if (dC > chWorst) { chWorst = dC; chAt = `${s.kind} #${i} u ${s.u.toFixed(3)}`; }
  });
  expect(`${type}: waterline outline = the spline at y = 0 on all ${spl.length} rows (${outline.length} points, worst ${(olWorst * 100).toFixed(2)} cm at ${olAt})`,
    outline.length === spl.length && olWorst <= CM && Object.isFrozen(outline), `outline ${outline.length} rows ${spl.length}`);
  expect(`${type}: contact chain = one capsule per spline row at its widest z, radius = widest z-section (${chain.length} points, worst ${(chWorst * 100).toFixed(2)} cm at ${chAt})`,
    chain.length === spl.length && chWorst <= CM && Object.isFrozen(chain), `chain ${chain.length} rows ${spl.length}`);
  let rtWorst = 0, rtAt = '', rtN = 0, rtNAt = '';
  for (let iu = 1; iu < 40; iu++) {
    for (let iv = 1; iv < 24; iv++) {
      const u = iu / 40, v = iv / 24;
      const p = sampleHullSurface(profile, u, v);
      const r = hull.hullSurfacePointAt(profile, p.z, p.y);
      const d = Math.abs(r.x - p.x);
      if (d > rtWorst) { rtWorst = d; rtAt = `u ${u.toFixed(3)} v ${v.toFixed(3)}`; }
      const l = Math.hypot(p.nx, p.ny) || 1;
      const a = Math.acos(Math.max(-1, Math.min(1, (r.nx * p.nx + r.ny * p.ny) / l))) * DEG;
      if (a > rtN) { rtN = a; rtNAt = `u ${u.toFixed(3)} v ${v.toFixed(3)}`; }
    }
  }
  expect(`${type}: hullSurfacePointAt(z, y) is the spline (39x23 round trips: x worst ${(rtWorst * 100).toFixed(3)} cm at ${rtAt}, section normal ${rtN.toFixed(3)} deg at ${rtNAt})`,
    rtWorst <= CM && rtN <= 1);
  let stWorst = 0, stAt = '';
  profile.stations.forEach((st, i) => {
    const row = spl.find((s) => s.kind === 'loft' && s.loftIndex === i);
    for (let k = 0; k <= 30; k++) {
      const y = st.keelY + (st.sheerY - st.keelY) * (k / 30);
      const s = hull.stationSurfaceAt(st, y);
      let lo = 0, hi = 1;
      for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (sampleHullSurface(profile, row.u, m).y > y) lo = m; else hi = m; }
      const c = sampleHullSurface(profile, row.u, (lo + hi) / 2);
      const best = Math.hypot(c.x - s.x, c.y - y, c.z - s.z);
      if (best > stWorst) { stWorst = best; stAt = `station ${i} y ${y.toFixed(2)}`; }
    }
  });
  expect(`${type}: stationSurfaceAt walks the spline row of its station (worst ${(stWorst * 100).toFixed(3)} cm at ${stAt})`, stWorst <= CM);
  }

const src = readFileSync(new URL('../src/shared/hull.ts', import.meta.url), 'utf8');
expect('src/shared/hull.ts has no Math.random and no three.js import', !/Math\.random/.test(src) && !/from 'three'/.test(src));

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nPASS: one C1 spline hull through every station, no folds, walk taper kept, < 5 deg girth faces over the whole shell on 72x40 (bow included), along-length ratchet held.');
