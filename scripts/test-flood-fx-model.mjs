#!/usr/bin/env node
// b2.3b gate (holes-08): the flood jets read the SHARED flood model. Pure node, < 1 s.
// Every block can fail:
//  - Torricelli exit speed v = sqrt(2 g h): 0.2 m -> 1.98 +- 0.05 m/s, 1.0 m -> 4.43 +- 0.05;
//  - the client's flooding predicate (floodFx.holeFloodState) equals the server's
//    (FloodSystem.evaluateHoleFlood) on 1,000 random hole / pose / wave samples,
//    including the 0.2-0.3 m band the old client margin (+0.2 vs the server's
//    wash) drew dry while the server flooded it;
//  - a hole under the HOLD water boils (bubbles + foam), it does not jet;
//    a hole above it jets; a dry hole does nothing;
//  - the ballistic arc lands where the parabola says, capped at the far side;
//  - a patched hole releases over 300 ms; jets run through the first 60% of the founder.
import { FLOODING } from '../src/shared/constants/index.ts';
import { evaluateHoleFlood } from '../src/server/systems/FloodSystem.ts';
import { getHullVolumeTable, fillToLocalY } from '../src/shared/flooding/hullVolume.ts';
import { gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';
import {
  jetExitSpeed, holeWorldPoint, holeFloodState, jetFlightTime, jetReleaseStrength, founderJetsOpen,
  FLOOD_JET_RELEASE_S, FLOOD_JET_FOUNDER_F,
} from '../src/client/rendering/ship/floodFx.ts';

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const G = 9.81;

console.log('\n[1] Torricelli exit speed');
const v02 = jetExitSpeed(0.2);
const v10 = jetExitSpeed(1.0);
expect('0.2 m head -> 1.98 +- 0.05 m/s', Math.abs(v02 - 1.98) <= 0.05, v02.toFixed(3));
expect('1.0 m head -> 4.43 +- 0.05 m/s', Math.abs(v10 - 4.43) <= 0.05, v10.toFixed(3));
expect('dry (negative head) -> 0', jetExitSpeed(-0.1) === 0);
expect('head capped at FLOODING.MAX_HEAD', Math.abs(jetExitSpeed(50) - Math.sqrt(2 * G * FLOODING.MAX_HEAD)) < 1e-9);

console.log('\n[2] client predicate == server predicate, 1,000 samples');
let seed = 20260925;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const CLASSES = ['sloop', 'brigantine', 'galleon'];
let mismatch = 0, flooding = 0, dry = 0, band = 0, legacyMiss = 0, qMismatch = 0;
let firstBad = '';
for (let i = 0; i < 1000; i += 1) {
  const type = CLASSES[i % 3];
  const vt = getHullVolumeTable(type);
  const hole = {
    id: i, patched: false, size: 1 + Math.floor(rnd() * 3),
    x: (rnd() * 2 - 1) * 2.2, y: vt.soleY - 0.4 + rnd() * (vt.deckY - vt.soleY + 0.4), z: (rnd() * 2 - 1) * 8,
  };
  const ship = {
    id: `s${i}`, type, holes: [hole], upgrades: [],
    position: { x: (rnd() * 2 - 1) * 400, y: -0.9 + rnd() * 1.4, z: (rnd() * 2 - 1) * 400 },
    rotation: rnd() * Math.PI * 2, pitch: (rnd() * 2 - 1) * 0.12, roll: (rnd() * 2 - 1) * 0.3,
    waterLevel: rnd() < 0.3 ? 0 : rnd(),
  };
  const t = rnd() * 600;
  const storm = rnd() < 0.5 ? 0 : rnd();
  const server = evaluateHoleFlood(ship, t, storm)[0];
  const p = holeWorldPoint(ship, hole);
  const surfaceY = gerstnerHeight(p.x, p.z, t, WAVE_PARAMS, storm);
  const client = holeFloodState(ship, hole, surfaceY);
  if (client.flooding !== server.flooding) {
    mismatch += 1;
    if (!firstBad) firstBad = `${type} depth ${server.depth.toFixed(3)} server ${server.flooding} client ${client.flooding}`;
  }
  if (Math.abs(client.q - server.ingress) > 1e-9) qMismatch += 1;
  if (server.flooding) flooding += 1; else dry += 1;
  if (server.depth > -0.3 && server.depth < -0.2) band += 1;
  // The retired client gate: jet only when holeY <= waveY + 0.2.
  const legacy = p.y <= surfaceY + 0.2;
  if (legacy !== server.flooding) legacyMiss += 1;
}
expect('client flooding == server flooding on every sample', mismatch === 0, mismatch ? `${mismatch} mismatches, first: ${firstBad}` : '0 / 1000');
expect('client q == server ingress (same shared law)', qMismatch === 0, `${qMismatch} differ`);
expect('the sample exercises both outcomes', flooding >= 150 && dry >= 150, `${flooding} flooding, ${dry} dry`);
expect('the sample exercises the 0.2-0.3 m band', band >= 10, `${band} in band`);
console.log(`     (the retired +0.2 client margin disagrees with the server on ${legacyMiss} / 1000)`);

console.log('\n[3] boil vs jet vs dry');
{
  const type = 'sloop';
  const vt = getHullVolumeTable(type);
  const low = { id: 1, patched: false, size: 2, x: 1.2, y: vt.soleY + 0.1, z: 0 };
  const ship = { id: 'b', type, holes: [low], upgrades: [], position: { x: 0, y: 0, z: 0 }, rotation: 0, pitch: 0, roll: 0, waterLevel: 0.6 };
  // Put the outside surface 1 m over the hole.
  const p = holeWorldPoint(ship, low);
  const boil = holeFloodState(ship, low, p.y + 1.0);
  expect('fill 0.6 over a hole at the sole: the hold water covers it', fillToLocalY(type, 0.6) > low.y);
  expect('submerged-inside hole -> boil, not jet', boil.flooding && boil.mode === 'boil' && boil.submergedInside, `mode ${boil.mode}`);
  const dryHold = holeFloodState({ ...ship, waterLevel: 0 }, low, p.y + 1.0);
  expect('same hole, dry hold -> jet', dryHold.mode === 'jet' && Math.abs(dryHold.v - jetExitSpeed(1.0)) < 1e-6, `mode ${dryHold.mode} v ${dryHold.v.toFixed(2)}`);
  const high = { ...low, y: vt.deckY - 0.1 };
  const pHigh = holeWorldPoint(ship, high);
  const jet = holeFloodState({ ...ship, holes: [high] }, high, pHigh.y + 0.5);
  expect('hole above the hold water -> jet', jet.mode === 'jet' && !jet.submergedInside, `mode ${jet.mode}`);
  const d = holeFloodState({ ...ship, holes: [high] }, high, pHigh.y - 0.5);
  expect('hole 0.5 m above the sea -> none', d.mode === 'none' && !d.flooding && d.v === 0);
}

console.log('\n[4] ballistic arc');
{
  const t1 = jetFlightTime(2, 0, 1.0, 99);
  expect('horizontal 2 m/s, 1 m drop -> t = sqrt(2 D / g)', Math.abs(t1 - Math.sqrt(2 / G)) < 1e-6, t1.toFixed(4));
  const t2 = jetFlightTime(4, 1, 0.5, 99);
  const y = 1 * t2 - 0.5 * G * t2 * t2;
  expect('upward exit lands at -D', Math.abs(y + 0.5) < 1e-6, y.toFixed(4));
  const t3 = jetFlightTime(4, 0, 1.0, 0.8);
  expect('reach capped at the far side', Math.abs(4 * t3 - 0.8) < 1e-6, (4 * t3).toFixed(3));
}

console.log('\n[5] release on patch, founder window');
expect('release is 300 ms', FLOOD_JET_RELEASE_S === 0.3);
expect('release: full at 0, half at 150 ms, gone at 300 ms',
  jetReleaseStrength(0) === 1 && Math.abs(jetReleaseStrength(0.15) - 0.5) < 1e-9 && jetReleaseStrength(0.3) === 0);
expect('founder window is the first 60%', FLOOD_JET_FOUNDER_F === 0.6);
expect('jets run at sinkProgress 0.5 and stop at 0.7',
  founderJetsOpen({ sinking: true, sinkProgress: 0.5 }) && !founderJetsOpen({ sinking: true, sinkProgress: 0.7 })
  && founderJetsOpen({ sinking: false, sinkProgress: 0 }));

if (failures) { console.error(`\n${failures} flood-fx model check(s) FAILED`); process.exit(1); }
console.log('\nAll flood-fx model checks passed');
