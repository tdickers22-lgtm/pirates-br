// test-inland-water (b4.7a, islands-03 + vm:islands:5): water on land.
//   Stream rows: every stream surface descends monotonically head -> mouth,
//     stands 0.5-1.5 m over the terrain along the run (the delta excluded),
//     and reaches y < 0.2 at the coast on ground that is the shore (< 0.3 m).
//   Roster rows: >= 1 stream on every lush / tropical / crescent island,
//     >= 3 ponds world-wide (Old Maw's crater lake mandatory) that hold water,
//     >= 6 tide-pool shelves at 0.3-0.8 m.
//   Wading: < 0.9 m of inland water walks at 0.7x, dry ground at 1x, a pond
//     centre is swimming depth (>= 0.9 m); stepPirate applies the multiplier.
//   Program census (static): the inland water creates NO material of its own;
//     it is handed the waterfall water material (program key
//     'pirates-waterfall-water'), so streams add 0 programs; DecorScatter's
//     unlit MeshBasic tide-pool discs are gone.
// RED proof: --mutate=raw-bed floats the water on the authored bed line
// instead of the running-minimum bed (Smuggler's spring floats 2.4 m over its
// rapids) and must FAIL the depth rows.
//   node --import tsx scripts/test-inland-water.mjs [--mutate=raw-bed]
import { readFileSync } from 'node:fs';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { getIslandLandforms, getLandformPonds, landformStreamBedY } from '../src/shared/landforms.ts';
import {
  STREAM_DELTA_U, WADE_DEPTH_MAX_M, WADE_SPEED_MUL, getInlandStreams, getInlandWaterDepth,
  inlandWadeSpeedMul, streamDepthAt, streamSurfaceY,
  streamHalfWidth,
} from '../src/shared/locomotion.ts';
import * as THREE from 'three';
import { STREAM_BANK_TOLERANCE_M, buildInlandWater, fitStreamBanks } from '../src/client/world/island/StreamBuilder.ts';

const RAW = process.argv.includes('--mutate=raw-bed');
// b4.7a2 RED proof: --mutate=no-bank puts every edge at the nominal trapezoid
// width at the surface (the 930aafbb builder), which the live audit caught
// hanging up to 1.46 m over the banks.
const NO_BANK = process.argv.includes('--mutate=no-bank');
let passes = 0, fails = 0;
function expect(label, ok, detail = '') {
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}
const islands = new MapGenerator(20260801).generateIslands();
const surf = (s, u) => (RAW ? landformStreamBedY(s.rec, u) + streamDepthAt(s, u) : streamSurfaceY(s, u));
function at(s, u) {
  const t = u * s.length;
  let i = 1;
  while (i < s.path.length - 1 && s.cum[i] < t) i++;
  const [ax, az] = s.path[i - 1], [bx, bz] = s.path[i];
  const f = Math.max(0, Math.min(1, (t - s.cum[i - 1]) / (s.cum[i] - s.cum[i - 1])));
  return [ax + (bx - ax) * f, az + (bz - az) * f];
}

console.log(`Stream rows${RAW ? ' [mutate=raw-bed]' : ''}`);
let streamTotal = 0;
for (const isl of islands) for (const s of getInlandStreams(isl)) {
  streamTotal++;
  let rise = 0, prev = Infinity, dMin = Infinity, dMax = -Infinity;
  for (let k = 0; k <= 200; k++) {
    const u = k / 200, y = surf(s, u);
    rise = Math.max(rise, y - prev); prev = Math.min(prev, y);
    if (u <= 1 - STREAM_DELTA_U) {
      const [lx, lz] = at(s, u);
      const d = y - getIslandSurfaceY(isl, isl.position.x + lx, isl.position.z + lz);
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
    }
  }
  const [mx, mz] = at(s, 1);
  const shore = getIslandSurfaceY(isl, isl.position.x + mx, isl.position.z + mz);
  expect(`${isl.id}/${s.id}: surface monotone to the sea (rise <= 1 mm)`, rise <= 1e-3, `max rise ${(rise * 1000).toFixed(2)} mm`);
  expect(`${isl.id}/${s.id}: 0.5-1.5 m of water over the bed along the run`, dMin >= 0.5 && dMax <= 1.5, `${dMin.toFixed(2)}-${dMax.toFixed(2)} m`);
  expect(`${isl.id}/${s.id}: reaches y < 0.2 at the coast`, surf(s, 1) < 0.2 && shore < 0.3, `mouth surface ${surf(s, 1).toFixed(2)} m, shore ${shore.toFixed(2)} m`);
}

console.log(`\nBank rows${NO_BANK ? ' [mutate=no-bank]' : ''}: every ribbon edge on its bank (<= ${STREAM_BANK_TOLERANCE_M} m over the ground, sea excluded)`);
for (const isl of islands) for (const s of getInlandStreams(isl)) {
  const ground = (lx, lz) => getIslandSurfaceY(isl, isl.position.x + lx, isl.position.z + lz);
  const n = Math.max(8, Math.ceil(s.length / 1.2));
  let worst = -Infinity, over = 0, edges = 0, at_ = '';
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const y = streamSurfaceY(s, u);
    if (y < 0.06 && k > 0) break;
    const [px, pz] = at(s, u);
    const t = Math.min(u * s.length, s.length - 1e-6);
    let i = 1; while (i < s.path.length - 1 && s.cum[i] < t) i++;
    const L = s.cum[i] - s.cum[i - 1];
    const dx = (s.path[i][0] - s.path[i - 1][0]) / L, dz = (s.path[i][1] - s.path[i - 1][1]) / L;
    const delta = Math.max(0, (u - (1 - STREAM_DELTA_U)) / STREAM_DELTA_U);
    const hw = streamHalfWidth(s, Math.min(u, 1 - STREAM_DELTA_U)) * 1.12 * (1 + 2.2 * delta);
    const bank = NO_BANK ? { w: [hw, hw], edgeY: [y, y] } : fitStreamBanks(ground, px, pz, -dz, dx, y, hw);
    for (const [side, a] of [[0, -1], [1, 1]]) {
      const ex = px - dz * a * bank.w[side], ez = pz + dx * a * bank.w[side];
      const g = ground(ex, ez);
      if (g < 0) continue;
      const gap = Math.min(y, bank.edgeY[side]) + 0.03 - g;
      edges++;
      if (gap > STREAM_BANK_TOLERANCE_M) over++;
      if (gap > worst) { worst = gap; at_ = `u=${u.toFixed(2)}`; }
    }
  }
  expect(`${isl.id}/${s.id}: 0 ribbon edges hanging over the bank`, over === 0, `${over}/${edges} over, worst ${worst.toFixed(2)} m at ${at_}`);
}

console.log('\nRoster rows');
const wet = islands.filter((i) => i.profile.terrainStyle === 'tropical' || i.profile.terrainStyle === 'crescent' || i.profile.biome === 'lush');
expect('lush/tropical/crescent roster resolved (>= 5 islands)', wet.length >= 5, wet.map((i) => i.id).join(', '));
for (const i of wet) expect(`${i.id}: >= 1 stream`, getInlandStreams(i).length >= 1, `${getInlandStreams(i).length}`);
expect('>= 6 streams world-wide', streamTotal >= 6, `${streamTotal}`);
const ponds = islands.flatMap((i) => getLandformPonds(i).map((p) => ({ i, p })));
expect('>= 3 ponds world-wide', ponds.length >= 3, ponds.map((x) => x.p.id).join(', '));
expect("Old Maw's crater lake is a pond", ponds.some((x) => x.p.id === 'old-maw-crater-lake'));
for (const { i, p } of ponds) {
  let lo = Infinity;
  for (let a = 0; a < 48; a++) lo = Math.min(lo, getIslandSurfaceY(i, i.position.x + p.x + Math.cos(a / 48 * Math.PI * 2) * (p.radius + 1.5), i.position.z + p.z + Math.sin(a / 48 * Math.PI * 2) * (p.radius + 1.5)));
  const centre = getInlandWaterDepth(i, i.position.x + p.x, i.position.z + p.z);
  expect(`${p.id}: holds water (rim >= spill + 0.2) and swims at the centre (>= ${WADE_DEPTH_MAX_M} m)`, lo - p.y >= 0.2 && centre >= WADE_DEPTH_MAX_M, `rim +${(lo - p.y).toFixed(2)} m, centre ${centre.toFixed(2)} m`);
}
const shelves = islands.flatMap((i) => getIslandLandforms(i).filter((r) => r.kind === 'rock_shelf' && r.y >= 0.3 && r.y <= 0.8));
expect('>= 6 tide-pool shelves', shelves.length >= 6, `${shelves.length}`);

// b4.7a3: the BUILT mesh, not a re-derivation. Every stream's open edges
// (both banks and the spring's head row across the channel) must lie on the
// ground. Live run 3 (b6acbf00) still had the head row standing at full depth
// over the ground: Booty 1.20 m, Crow 1.14, Castaway 1.13, Rumrunner 0.64.
// RED: the same check at b6acbf00 fails on the head rows.
console.log(`\nBuilt mesh: stream head rows and bank edges on the ground (<= ${STREAM_BANK_TOLERANCE_M} m over it)`);
for (const isl of islands) {
  const streams = getInlandStreams(isl);
  if (!streams.length) continue;
  const group = new THREE.Group();
  buildInlandWater({ island: isl, group, lowDetail: false }, () => new THREE.MeshBasicMaterial());
  const mesh = group.getObjectByName('inland-water');
  const pos = mesh.geometry.getAttribute('position');
  const gap = (v) => pos.getY(v) - getIslandSurfaceY(isl, isl.position.x + pos.getX(v), isl.position.z + pos.getZ(v));
  let v0 = 0;
  for (const s of streams) {
    const n = Math.max(8, Math.ceil(s.length / 1.2));
    let rows = 0;
    for (let k = 0; k <= n; k++) { rows++; if (streamSurfaceY(s, k / n) < 0.06 && k > 0) break; }
    let headWorst = -Infinity, edgeWorst = -Infinity, edgeOver = 0;
    for (let j = 0; j < 5; j++) headWorst = Math.max(headWorst, gap(v0 + j));
    for (let r = 0; r < rows; r++) for (const j of [0, 4]) {
      const v = v0 + r * 5;
      const x = isl.position.x + pos.getX(v + j), z = isl.position.z + pos.getZ(v + j);
      if (getIslandSurfaceY(isl, x, z) < 0.05) continue; // the delta runs out onto the wet beach
      const g = gap(v + j); edgeWorst = Math.max(edgeWorst, g); if (g > STREAM_BANK_TOLERANCE_M) edgeOver++;
    }
    expect(`${isl.id}/${s.id}: spring head row lies on the ground`, headWorst <= STREAM_BANK_TOLERANCE_M, `worst ${headWorst.toFixed(2)} m`);
    expect(`${isl.id}/${s.id}: built bank edges on the ground`, edgeOver === 0, `${edgeOver} over, worst ${edgeWorst.toFixed(2)} m`);
    v0 += rows * 5;
  }
}

console.log('\nWading');
const rk = islands.find((i) => i.id === 'rumrunner-key');
const rs = getInlandStreams(rk)[0];
const [wx, wz] = at(rs, 0.4);
const wd = getInlandWaterDepth(rk, rk.position.x + wx, rk.position.z + wz);
expect('valley stream is wading depth (0.05-0.9 m)', wd >= 0.05 && wd < WADE_DEPTH_MAX_M, `${wd.toFixed(2)} m`);
expect('wading walks at 0.7x', inlandWadeSpeedMul(islands, rk.position.x + wx, rk.position.z + wz) === WADE_SPEED_MUL);
expect('dry ground (8 m off the bank) walks at 1x', inlandWadeSpeedMul(islands, rk.position.x + wx + 8, rk.position.z + wz) === 1
  || inlandWadeSpeedMul(islands, rk.position.x + wx - 8, rk.position.z + wz) === 1);
const loco = readFileSync(new URL('../src/shared/locomotion.ts', import.meta.url), 'utf8');
const stepBody = loco.slice(loco.indexOf('export function stepPirate('));
expect('stepPirate scales the grounded stride by inlandWadeSpeedMul', /PLAYER\.MOVE_SPEED[^;]*inlandWadeSpeedMul\(env\.islands/s.test(stepBody.slice(0, stepBody.indexOf('if (moveX !== 0'))));

console.log('\nProgram census (static)');
const sb = readFileSync(new URL('../src/client/world/island/StreamBuilder.ts', import.meta.url), 'utf8');
const wf = readFileSync(new URL('../src/client/world/island/WaterfallBuilder.ts', import.meta.url), 'utf8');
const ds = readFileSync(new URL('../src/client/world/island/DecorScatter.ts', import.meta.url), 'utf8');
expect('StreamBuilder creates no material (0 new programs)', !/new THREE\.\w*Material\(|ShaderMaterial|onBeforeCompile/.test(sb));
expect('inland water is handed the waterfall water material', /buildInlandWater\(ctx, \(\) => ensureWater\(\)\.water\)/.test(wf) && /customProgramCacheKey = \(\) => 'pirates-waterfall-water'/.test(wf));
expect('DecorScatter has no unlit MeshBasic tide-pool discs', !/tidePoolMat|MeshBasicMaterial\(\{ color: 0x3a86a8/.test(ds));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
