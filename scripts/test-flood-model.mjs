#!/usr/bin/env node
// b2.2a gate: the shared Torricelli flood model (D15) and the per-class
// fill-to-height table. Pure node, < 1 s. Every block can fail:
//  - section-7 windows: two waterline holes founder an untended sloop in 55-80 s
//    and a galleon in 82-115 s, with the settle closing the loop (the server's
//    own floodSettle drives position.y, exactly as PhysicsSystem does);
//  - sqrt law: Q(1 m) / Q(0.2 m) in 1.9-2.3;
//  - the calm-sea wash margin: a hole 0.3 m above calm water on a level hull is
//    DRY (Q 0); within the margin it weeps; under the surface it flows;
//  - the inside head reduces Q once the hold water covers the hole;
//  - the fill table: monotone, fill 0 = sole, fill 1 = deck underside, fill
//    0.5 at the loft's own half-volume height (independently integrated here);
//  - prints the time-to-founder table per class/size.
import { FLOODING, SHIP, SHIP_STATS, SHIP_UPGRADES } from '../src/shared/constants/index.ts';
import { evaluateHoleFlood, shipIngressRate, updateShipFlooding } from '../src/server/systems/PhysicsSystem.ts';
import {
  holeHeadFactor, holeIngress, holeInsideHead, holeSizeArea, floodSettle, waterlineHoleIngress,
} from '../src/shared/flooding/floodModel.ts';
import { getHullVolumeTable, fillToLocalY, localYToFill } from '../src/shared/flooding/hullVolume.ts';
import { getHullProfile, hullSurfacePointAt } from '../src/shared/hull.ts';
import { gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const DT = 1 / 60;
const CLASSES = ['sloop', 'brigantine', 'galleon'];

function makeShip(type, holes, extra = {}) {
  return {
    id: `flood-${type}`, type, position: { x: 0, y: 0, z: 0 }, rotation: 0, pitch: 0, roll: 0,
    holes, upgrades: [], waterLevel: 0, onFire: false, fireTimer: 0, fireDamageAccum: 0, ...extra,
  };
}
/** n holes on the calm waterline, alternating rails, spread along the hull. */
function waterlineHoles(type, n, size = 1, y = 0) {
  const { width, length } = SHIP_STATS[type];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const z = ((Math.floor(i / 2) % 3) - 1) * length * 0.2;
    const x = (i % 2 ? -1 : 1) * width * 0.5;
    // "On the waterline" means on the LOCAL calm surface: the t=0 swell varies
    // +-0.2 m across a hull, so each hole sits on its own sample (y is the
    // offset from it), and position.y rides the surface at the origin.
    const local = gerstnerHeight(x, z, 0, WAVE_PARAMS) - gerstnerHeight(0, 0, 0, WAVE_PARAMS);
    out.push({ id: i + 1, x, y: y + local, z, patched: false, size });
  }
  return out;
}
/** Closed-loop founder time (s): settle drags the holes down as she fills;
 *  `bail` is fill/s removed by hands before physics (Match order). */
function founderTime(type, holes, { bail = 0, limit = 3600 } = {}) {
  const ship = makeShip(type, holes);
  const s0 = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  let t = 0;
  let step = 0;
  let lastCheck = ship.waterLevel ?? 0;
  while ((ship.waterLevel ?? 0) < 1 && t < limit) {
    ship.position.y = s0 - floodSettle(type, ship.waterLevel);
    ship.waterLevel = Math.max(0, ship.waterLevel - bail * DT);
    updateShipFlooding(ship, 0, DT);
    t += DT;
    // Calm sea + settle from the fill alone = an autonomous 1-D system, so a
    // level that has not risen over 10 s sits at its equilibrium: held. Keeps
    // the suite inside the quick tier instead of walking 3600 s per hold.
    if (++step % 600 === 0) {
      if (ship.waterLevel <= lastCheck + 1e-7) return Infinity;
      lastCheck = ship.waterLevel;
    }
  }
  return t >= limit ? Infinity : t;
}

console.log('Section-7 windows (KEPT, D15): two waterline holes, untended, settle in the loop');
{
  const sloop = founderTime('sloop', waterlineHoles('sloop', 2));
  const galleon = founderTime('galleon', waterlineHoles('galleon', 2));
  expect('sloop founders in 55-80 s', sloop >= 55 && sloop <= 80, `t=${sloop.toFixed(1)} s`);
  expect('galleon founders in 82-115 s', galleon >= 82 && galleon <= 115, `t=${galleon.toFixed(1)} s`);
  const brig = founderTime('brigantine', waterlineHoles('brigantine', 2));
  expect('brigantine sits between them', brig > sloop && brig < galleon, `t=${brig.toFixed(1)} s`);
}

console.log('\nTorricelli: Q = K A sqrt(2 g h_eff)');
{
  const q1 = holeIngress('sloop', 1, 1.0);
  const q02 = holeIngress('sloop', 1, 0.2);
  expect('Q(1 m) / Q(0.2 m) in 1.9-2.3 (sqrt law)', q1 / q02 >= 1.9 && q1 / q02 <= 2.3, `ratio=${(q1 / q02).toFixed(3)}`);
  let mono = true;
  for (let d = -0.2; d < 2.4; d += 0.05) if (holeHeadFactor(d + 0.05) < holeHeadFactor(d)) mono = false;
  expect('Q never falls as the hole goes deeper', mono);
  expect('the head is capped (a keel breach cannot gush infinitely)',
    holeHeadFactor(10) === holeHeadFactor(FLOODING.MAX_HEAD));
  expect('size 3 lets in 2.8x a size-1 hole', Math.abs(holeIngress('sloop', holeSizeArea(3), 0.4) / holeIngress('sloop', 1, 0.4) - 2.8) < 1e-9);
  expect('K falls as the hull grows', waterlineHoleIngress('sloop') > waterlineHoleIngress('brigantine')
    && waterlineHoleIngress('brigantine') > waterlineHoleIngress('galleon'));
}

console.log('\nThe calm-sea wash margin: holes above calm water');
{
  const s0 = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  const at = (y) => {
    const ship = makeShip('sloop', [{ id: 1, x: 0, y, z: 0, patched: false }]);
    ship.position.y = s0;
    return evaluateHoleFlood(ship, 0)[0];
  };
  const dry = at(0.3);
  expect('a hole 0.3 m above calm water on a level hull gives Q 0', dry.ingress === 0 && !dry.flooding, `Q=${dry.ingress}`);
  const weep = at(0.08);
  const line = at(0);
  expect('a hole inside the wash margin weeps (0 < Q < the waterline rate)', weep.ingress > 0 && weep.ingress < line.ingress,
    `weep=${weep.ingress.toExponential(3)} line=${line.ingress.toExponential(3)}`);
  const settled = makeShip('sloop', [{ id: 1, x: 0, y: 0.3, z: 0, patched: false }]);
  settled.position.y = s0 - 0.5;
  expect('the SAME hole floods once the settle takes it under', shipIngressRate(settled, 0) > 0);
  const listed = makeShip('sloop', [{ id: 1, x: -2.5, y: 0.3, z: 0, patched: false }], { roll: 0.3 });
  listed.position.y = s0;
  expect('...and once a list dips its rail under', shipIngressRate(listed, 0) > 0);
}

console.log('\nThe inside head: hold water over a hole pushes back');
{
  const holeY = 0.9; // above the sole, so the water reaches it part-way up
  const fillOver = localYToFill('sloop', holeY + 0.6);
  const dryHead = holeInsideHead('sloop', 0, holeY);
  const wetHead = holeInsideHead('sloop', fillOver, holeY);
  expect('no inside head until the water covers the hole', dryHead === 0 && holeInsideHead('sloop', localYToFill('sloop', holeY - 0.1), holeY) === 0);
  expect('the head grows once it is covered', wetHead > 0, `head=${wetHead.toFixed(3)} m at fill ${fillOver.toFixed(2)}`);
  const qDry = holeIngress('sloop', 1, 0.8, dryHead);
  const qWet = holeIngress('sloop', 1, 0.8, wetHead);
  expect('the inside head reduces Q at the same outside depth', qWet < qDry * 0.9, `dry=${qDry.toFixed(5)} wet=${qWet.toFixed(5)}`);
  const s0 = gerstnerHeight(0, 0, 0, WAVE_PARAMS);
  const a = makeShip('sloop', [{ id: 1, x: 0, y: holeY, z: 0, patched: false }], { waterLevel: 0 });
  const b = makeShip('sloop', [{ id: 1, x: 0, y: holeY, z: 0, patched: false }], { waterLevel: fillOver });
  a.position.y = b.position.y = s0 - 1.2;
  expect('FloodSystem reads it: a covered hole floods slower than a dry-hold one', shipIngressRate(b, 0) < shipIngressRate(a, 0),
    `dryHold=${shipIngressRate(a, 0).toFixed(5)} covered=${shipIngressRate(b, 0).toFixed(5)}`);
}

console.log('\nFill-to-height table from the loft (one per class)');
for (const type of CLASSES) {
  const t = getHullVolumeTable(type);
  let mono = true;
  for (let i = 1; i < t.fills.length; i += 1) if (!(t.fills[i] > t.fills[i - 1]) || !(t.ys[i] > t.ys[i - 1])) mono = false;
  expect(`${type}: table strictly monotone`, mono);
  expect(`${type}: fill 0 = the sole (${SHIP.HOLD_FLOOR_OFFSET})`, fillToLocalY(type, 0) === SHIP.HOLD_FLOOR_OFFSET);
  expect(`${type}: fill 1 = the deck underside (${SHIP_STATS[type].height})`, fillToLocalY(type, 1) === SHIP_STATS[type].height);
  // Independent brute-force integration of the loft (different sampling, midpoint rule).
  const profile = getHullProfile(type);
  const halfL = profile.L * 0.45;
  const area = (y) => { let a = 0; const n = 200; for (let i = 0; i < n; i += 1) { const z = -halfL + (i + 0.5) * (2 * halfL / n); a += 2 * Math.max(0, hullSurfacePointAt(profile, z, y).x) * (2 * halfL / n); } return a; };
  const ny = 300; const dy = (t.deckY - t.soleY) / ny; const cum = [0];
  for (let i = 0; i < ny; i += 1) cum.push(cum[i] + area(t.soleY + (i + 0.5) * dy) * dy);
  const half = cum[ny] * 0.5; let k = 0; while (cum[k + 1] < half) k += 1;
  const halfY = t.soleY + (k + (half - cum[k]) / (cum[k + 1] - cum[k])) * dy;
  const y05 = fillToLocalY(type, 0.5);
  const mid = (t.soleY + t.deckY) / 2;
  expect(`${type}: fill 0.5 sits at the loft's half-volume height, not a box's middle`,
    Math.abs(y05 - halfY) < 0.01 && Math.abs(y05 - mid) > 0.01,
    `fill0.5=${y05.toFixed(3)} loftHalf=${halfY.toFixed(3)} boxMiddle=${mid.toFixed(3)}`);
  let inv = 0;
  for (let f = 0.05; f < 1; f += 0.05) inv = Math.max(inv, Math.abs(localYToFill(type, fillToLocalY(type, f)) - f));
  expect(`${type}: localYToFill inverts fillToLocalY`, inv < 1e-6, `maxErr=${inv.toExponential(2)}`);
}

console.log('\nStock hulls never pump themselves dry; a reinforced hull keeps a slow pump');
{
  const stock = makeShip('sloop', [], { waterLevel: 0.5 });
  const reinf = makeShip('sloop', [], { waterLevel: 0.5, upgrades: [{ type: 'hull_reinforcement' }] });
  for (let i = 0; i < 60 * 60; i += 1) { updateShipFlooding(stock, 0, DT); updateShipFlooding(reinf, 0, DT); }
  expect('stock patched hull at 0.5 is still >= 0.5 after 60 s', stock.waterLevel >= 0.5, `water=${stock.waterLevel.toFixed(3)}`);
  const want = 0.5 - FLOODING.BAIL_RATE * SHIP_UPGRADES.REINFORCED_PUMP_FACTOR * 60;
  expect('reinforced hull drains at 0.25x BAIL_RATE', Math.abs(reinf.waterLevel - want) < 1e-6, `water=${reinf.waterLevel.toFixed(4)}`);
}

console.log('\nDesign race (PLAN 3.6): one bailer vs small holes, bailer + pump vs three small');
{
  const smallDeep = holeIngress('sloop', holeSizeArea(1), 0.2);
  expect('one bailer beats one small sloop hole 0.2 m under (live swell)', FLOODING.BAIL_RATE > smallDeep,
    `bail=${FLOODING.BAIL_RATE} Q(small, 0.2 m)=${smallDeep.toFixed(4)}`);
  expect('bucket cycle (scoop + heave) delivers BAIL_RATE within 5%',
    Math.abs(FLOODING.BAIL_SCOOP_VOLUME / (2 * FLOODING.BAIL_SCOOP_TIME) - FLOODING.BAIL_RATE) / FLOODING.BAIL_RATE < 0.05,
    `cycle=${(FLOODING.BAIL_SCOOP_VOLUME / (2 * FLOODING.BAIL_SCOOP_TIME)).toFixed(4)}/s`);
  for (const type of CLASSES) {
    expect(`${type}: one bailer holds one small waterline hole`, !Number.isFinite(founderTime(type, waterlineHoles(type, 1, 1), { bail: FLOODING.BAIL_RATE })));
    expect(`${type}: bailer + pump hold three small waterline holes`, !Number.isFinite(founderTime(type, waterlineHoles(type, 3, 1), { bail: FLOODING.BAIL_RATE + FLOODING.PUMP_RATE })));
  }
  const s3 = founderTime('sloop', waterlineHoles('sloop', 3, 1), { bail: FLOODING.BAIL_RATE });
  expect('sloop: one bailer still loses to three small waterline holes', Number.isFinite(s3), `t=${Number.isFinite(s3) ? s3.toFixed(0) : 'held'} s`);
}

// b2.2d3: the three-way race is judged at the same 0.2 m depth as the small row
// above. On the waterline the only head is the 0.15 m wash margin, so one
// bailer holds even a size-2 hole there on every class; below the surface the
// sqrt law bites. Judging at depth keeps the section-7 windows untouched.
console.log('\nDesign race at depth (PLAN 3.6): holes 0.2 m under, settle in the loop');
{
  const fmtT = (v) => (Number.isFinite(v) ? `${v.toFixed(0)} s` : 'held');
  for (const type of CLASSES) {
    const bail = FLOODING.BAIL_RATE;
    const small = founderTime(type, waterlineHoles(type, 1, 1, -0.2), { bail });
    const medium = founderTime(type, waterlineHoles(type, 1, 2, -0.2), { bail });
    const mediumUntended = founderTime(type, waterlineHoles(type, 1, 2, -0.2));
    const threeSmall = founderTime(type, waterlineHoles(type, 3, 1, -0.2), { bail });
    expect(`${type}: one bailer beats one small hole 0.2 m under`, !Number.isFinite(small), `t=${fmtT(small)}`);
    expect(`${type}: one bailer loses to one medium hole 0.2 m under`, Number.isFinite(medium), `t=${fmtT(medium)}`);
    expect(`${type}: ...slowly (>= 2x the untended medium time)`, Number.isFinite(medium) && medium >= 2 * mediumUntended,
      `bailed ${fmtT(medium)} vs untended ${fmtT(mediumUntended)}`);
    expect(`${type}: one bailer loses fast to three small 0.2 m under (sooner than the medium)`,
      Number.isFinite(threeSmall) && threeSmall < medium, `three small ${fmtT(threeSmall)} vs medium ${fmtT(medium)}`);
  }
}

console.log('\nTime-to-founder table (s; calm, holes on the waterline, settle in the loop)');
console.log('  class       size | untended 1 / 3 / 6    | 1 bailer 1 / 3 / 6     | bailer+pump 1 / 3 / 6');
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(0) : 'held').padStart(5);
for (const type of CLASSES) {
  for (const size of [1, 2, 3]) {
    const row = (bail) => [1, 3, 6].map((n) => fmt(founderTime(type, waterlineHoles(type, n, size), { bail }))).join(' /');
    console.log(`  ${type.padEnd(11)} ${size}   | ${row(0)} | ${row(FLOODING.BAIL_RATE)} | ${row(FLOODING.BAIL_RATE + FLOODING.PUMP_RATE)}`);
  }
}

if (failures > 0) { console.error(`\n${failures} flood-model check(s) failed`); process.exit(1); }
console.log('\nflood model: all checks passed');
