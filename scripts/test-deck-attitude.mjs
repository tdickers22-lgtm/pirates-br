#!/usr/bin/env node
// THE DECK IS WHERE IT IS DRAWN (DECK-01: physics-01 / ships-03).
//
// The renderer has always rotated mesh.root by the replicated pitch and roll
// (Euler order YXZ), while every standing surface — weather deck, quarterdeck
// dais, hold sole, companionway ramp — was computed on a FLAT plane at
// ship.position.y + height. A galleon's bow station is 0.44·L = 9.7 m forward,
// so a 0.35 rad pitch put 3.3 m of daylight between a pirate's boots and the
// planking he was drawn standing on; a calm 0.09 rad swell is still ~0.9 m.
//
// This suite grades the SHARED answer (getShipFloorYAt, which the server walker
// and the client prediction both call) against an INDEPENDENT reference: the
// hull-local deck point pushed through a 3x3 matrix built as Ry·Rx·Rz, exactly
// the way three.js composes a YXZ Euler for mesh.root. Sign, order and axis all
// have to agree or the reference disagrees.
import { getShipFloorYAt, toShipLocal3, toShipWorld3, shipLocalUpY } from '../src/shared/interactions.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { getCrowNestStandingY, getMainMastLocalZ, getShipDeckWalkHalfWidth } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── Independent reference: full 3x3, no shared code ─────────────────────────
const mul = (A, B) => A.map((row, i) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
/** World point of a hull-local point the way the RENDERER draws it: mesh.root
 *  at ship.position with rotation.order 'YXZ' = Ry·Rx·Rz. */
function drawnWorldPoint(ship, lx, ly, lz) {
  // The engine's local Z is forward and the ship frame stores +z forward with
  // world x = x·cos + z·sin — that is Ry(yaw) with yaw measured this way.
  const R = mul(Ry(ship.rotation), mul(Rx(ship.pitch ?? 0), Rz(ship.roll ?? 0)));
  const v = [lx, ly, lz];
  return {
    x: ship.position.x + R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    y: ship.position.y + R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    z: ship.position.z + R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  };
}

const TYPES = ['sloop', 'brigantine', 'galleon'];
// Calm swell, a working sea, and the server's own hard clamps (±0.45 / ±0.55).
const ATTITUDES = [
  { name: 'calm swell', pitch: 0.09, roll: 0.10 },
  { name: 'working sea', pitch: 0.22, roll: -0.28 },
  { name: 'storm cap', pitch: 0.35, roll: 0.45 },
  { name: 'hard clamp', pitch: -0.45, roll: 0.55 },
];
const TOL = 0.1;

console.log('— the crew stand on the planking that is drawn under them —');
let worstAll = 0;
let worstWhere = '';
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const deckLocalY = stats.height + SHIP.DECK_STAND_OFFSET;
  const stations = [
    { name: 'bow', x: 0, z: stats.length * 0.44 },
    { name: 'stern', x: 0, z: -stats.length * 0.44 },
    { name: 'stbd rail', x: getShipDeckWalkHalfWidth(stats, 0) - 0.15, z: 0 },
    { name: 'port rail', x: -(getShipDeckWalkHalfWidth(stats, 0) - 0.15), z: 0 },
    { name: 'fore quarter', x: getShipDeckWalkHalfWidth(stats, stats.length * 0.3) - 0.2, z: stats.length * 0.3 },
  ];
  for (const att of ATTITUDES) {
    let worst = 0;
    let worstAt = '';
    for (const yaw of [0, 0.7, 2.4, -1.9]) {
      const ship = {
        id: 's', type, position: { x: 120, y: 0.4, z: -70 }, rotation: yaw,
        pitch: att.pitch, roll: att.roll,
      };
      for (const st of stations) {
        // Where the pirate IS: the flat plan position of the station (the deck
        // clamp is 2D by design), at whatever height the shared floor says.
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        const world = {
          x: ship.position.x + st.x * cos + st.z * sin,
          y: ship.position.y + deckLocalY,
          z: ship.position.z + st.z * cos - st.x * sin,
        };
        const standY = getShipFloorYAt(world, ship);
        const drawnY = drawnWorldPoint(ship, st.x, deckLocalY, st.z).y;
        const err = Math.abs(standY - drawnY);
        if (err > worst) { worst = err; worstAt = `${st.name} @ yaw ${yaw}`; }
        if (err > worstAll) { worstAll = err; worstWhere = `${type} ${att.name} ${st.name}`; }
      }
    }
    expect(`${type} / ${att.name}: |standY − drawnDeckY| = ${worst.toFixed(3)} m < ${TOL}`,
      worst < TOL, `worst at ${worstAt}: ${worst.toFixed(3)} m`);
  }
}
console.log(`  worst deck error anywhere: ${worstAll.toFixed(4)} m (${worstWhere})`);

console.log('— the crow nest and the mast head ride the same frame —');
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const mastZ = getMainMastLocalZ(stats);
  const nestY = getCrowNestStandingY(stats);
  let worst = 0;
  for (const att of ATTITUDES) {
    const ship = { position: { x: 0, y: 0, z: 0 }, rotation: 1.1, pitch: att.pitch, roll: att.roll };
    const lifted = ship.position.y + shipLocalUpY(0.42, nestY, mastZ - 0.12, ship);
    const drawn = drawnWorldPoint(ship, 0.42, nestY, mastZ - 0.12).y;
    worst = Math.max(worst, Math.abs(lifted - drawn));
  }
  expect(`${type}: nest standing height matches the drawn mast head (${worst.toExponential(1)} m)`, worst < 1e-9);
}

console.log('— the 3D frame is invertible (a stored hull-local point comes back) —');
let rt = 0;
for (const att of ATTITUDES) {
  const ship = { position: { x: -300, y: 1.2, z: 88 }, rotation: -2.2, pitch: att.pitch, roll: att.roll };
  for (const p of [{ x: 1.2, y: 3.4, z: -5.6 }, { x: -2.8, y: 0.2, z: 9.1 }, { x: 0, y: 0, z: 0 }]) {
    const back = toShipLocal3(toShipWorld3(p, ship), ship);
    rt = Math.max(rt, Math.abs(back.x - p.x), Math.abs(back.y - p.y), Math.abs(back.z - p.z));
  }
}
expect(`toShipLocal3(toShipWorld3(p)) === p (max drift ${rt.toExponential(1)} m)`, rt < 1e-9);

console.log('— toShipWorld3 agrees with the renderer matrix on all three axes —');
let axisWorst = 0;
for (const att of ATTITUDES) {
  const ship = { position: { x: 5, y: -0.7, z: 12 }, rotation: 0.9, pitch: att.pitch, roll: att.roll };
  for (const p of [{ x: 2.1, y: 3.2, z: -8.4 }, { x: -1.5, y: 0.9, z: 7.7 }]) {
    const mine = toShipWorld3(p, ship);
    const ref = drawnWorldPoint(ship, p.x, p.y, p.z);
    axisWorst = Math.max(axisWorst, Math.abs(mine.x - ref.x), Math.abs(mine.y - ref.y), Math.abs(mine.z - ref.z));
  }
}
expect(`toShipWorld3 === Ry·Rx·Rz (max ${axisWorst.toExponential(1)} m)`, axisWorst < 1e-9);

console.log('— a level hull is unchanged: no flat-sea regression —');
let flatWorst = 0;
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const ship = { id: 's', type, position: { x: 3, y: 0.5, z: -4 }, rotation: 0.4, pitch: 0, roll: 0 };
  for (const z of [-0.4, -0.2, 0, 0.2, 0.4]) {
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const lz = z * stats.length;
    const world = {
      x: ship.position.x + lz * sin, y: ship.position.y + stats.height + SHIP.DECK_STAND_OFFSET,
      z: ship.position.z + lz * cos,
    };
    flatWorst = Math.max(flatWorst, Math.abs(getShipFloorYAt(world, ship) - getShipFloorYAt(world, { ...ship, pitch: undefined, roll: undefined })));
  }
}
expect(`pitch=roll=0 returns exactly the old flat answer (${flatWorst.toExponential(1)} m)`, flatWorst === 0);

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nPASS: the deck a pirate stands on is the deck that is drawn.');
