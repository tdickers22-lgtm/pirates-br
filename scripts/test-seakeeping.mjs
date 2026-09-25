// test-seakeeping.mjs: b2.1e (physics-09, physics-10, liveplay-02, PLAN 3.7 sea-keeping).
//
// The REAL PhysicsSystem at the 0.016 s server tick against the live Gerstner
// field. Every reference below is computed HERE, independently of the physics:
// the "wave plane" is an unweighted least-squares plane over a dense 13 x 7 grid
// covering the hull footprint, so a hull that only samples 5 points, or follows
// the centre, or lags the sea, is measured against the sea itself.
//
//   1  calm tracking: sails struck, drifting. Attitude RMS (roll and pitch) vs
//      the plane <= 0.5 deg, heave RMS vs the plane <= 0.08 m, every class.
//   2  free-decay roll after a blow: period sloop 3-4 / brig 4.5-5.5 /
//      galleon 6-8 s, damping ratio 0.2-0.4 (log decrement).
//   3  beam-reach heel (moment balance): sloop 7-9 / brig 5-7 / galleon 3-5 deg
//      to LEEWARD, mirror on the other tack; < 0.3 deg luffing or struck.
//   4  turn heel OUTWARD (sign of omega, +roll lifts +x) and <= 3 deg.
//   5  a hull anchored in her berth: drawn height (position.y + heave) within
//      +-0.35 m of its mean in weather 0 (liveplay-02 measured +-1 m).
//   6  applyPointLoad: sinkage and list / trim toward the load.
//   7  storm sea: attitude stays finite and inside the clamps, bow slams /
//      green water are published for a sloop in a full storm, none in calm.
//
// Quick tier (logic, no stack).
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import * as PS from '../src/server/systems/PhysicsSystem.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import { angleWrap, sampleWind, gerstnerHeight, WAVE_PARAMS, getStormWaveIntensity } from '../src/shared/utils/index.ts';
import { idealBrace } from '../src/shared/sailing.ts';
import { Match } from '../src/server/core/Match.ts';

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n       ${detail}` : ''}`); failures += 1; }
}
const DEG = Math.PI / 180;
const TICK = 0.016;
const TYPES = ['sloop', 'brigantine', 'galleon'];
const deg = (r) => (r / DEG).toFixed(2);

function makeShip(type, extra = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: `sk-${type}`, type, ownerId: 'owner', crewIds: [], position: { x: 310, y: 0, z: -220 }, rotation: 0.4,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], ...extra,
  };
}

/** Independent least-squares plane of the sea over the hull footprint (13 x 7,
 *  unweighted). Returns centre height and the roll / pitch it imposes in the
 *  hull's conventions (+roll lifts local +x, +pitch dips the bow = +z). */
function densePlane(ship, t, sea = 0) {
  const { length: L, width: B } = SHIP_STATS[ship.type];
  const c = Math.cos(ship.rotation); const s = Math.sin(ship.rotation);
  let n = 0; let sh = 0; let sxh = 0; let szh = 0; let sxx = 0; let szz = 0;
  for (let i = 0; i < 13; i++) {
    const z = (i / 12 - 0.5) * 0.9 * L;
    for (let j = 0; j < 7; j++) {
      const x = (j / 6 - 0.5) * 0.8 * B;
      const h = gerstnerHeight(ship.position.x + x * c + z * s, ship.position.z + z * c - x * s, t, WAVE_PARAMS, sea);
      n++; sh += h; sxh += x * h; szh += z * h; sxx += x * x; szz += z * z;
    }
  }
  return { y: sh / n, roll: Math.atan(sxh / sxx), pitch: -Math.atan(szh / szz) };
}

// ── 1 calm tracking ──────────────────────────────────────────────────────────
console.log('Section 1: calm tracking vs the least-squares wave plane (sails struck, drifting)');
for (const type of TYPES) {
  const physics = new PhysicsSystem();
  const ship = makeShip(type);
  let er = 0; let ep = 0; let eh = 0; let n = 0; let maxSlope = 0;
  for (let i = 0; i < 60 / TICK; i++) {
    const t = i * TICK;
    physics.update(TICK, t, [ship], [], [], [], []);
    if (t < 10) continue;
    const pl = densePlane(ship, t);
    er += (ship.roll - pl.roll) ** 2; ep += (ship.pitch - pl.pitch) ** 2; eh += (ship.position.y - pl.y) ** 2; n++;
    maxSlope = Math.max(maxSlope, Math.abs(pl.roll), Math.abs(pl.pitch));
  }
  const rr = Math.sqrt(er / n); const rp = Math.sqrt(ep / n); const rh = Math.sqrt(eh / n);
  expect(`${type} roll RMS vs plane <= 0.5 deg`, rr <= 0.5 * DEG, `${deg(rr)} deg, plane slope peak ${deg(maxSlope)} deg`);
  expect(`${type} pitch RMS vs plane <= 0.5 deg`, rp <= 0.5 * DEG, `${deg(rp)} deg`);
  expect(`${type} heave RMS vs plane <= 0.08 m`, rh <= 0.08, `${rh.toFixed(3)} m`);
}

// ── 2 free decay ─────────────────────────────────────────────────────────────
console.log('\nSection 2: free-decay roll after a blow');
const PERIOD = { sloop: [3, 4], brigantine: [4.5, 5.5], galleon: [6, 8] };
for (const type of TYPES) {
  const physics = new PhysicsSystem();
  const ship = makeShip(type);
  let t = 0;
  for (; t < 8; t += TICK) physics.update(TICK, t, [ship], [], [], [], []);
  // A blow sized for ~8 deg of roll. Before b2.1e there was no API: the hull
  // is displaced directly instead, which is what a free-decay test does.
  const guess = 2 * Math.PI / (PERIOD[type][0] + PERIOD[type][1]) * 2;
  if (typeof physics.applyHullImpulse === 'function') physics.applyHullImpulse(ship, { rollRate: 14 * DEG * guess });
  else ship.roll = (ship.roll ?? 0) + 12 * DEG;
  const psi = [];
  for (let k = 0; k < 24 / TICK; k++, t += TICK) {
    physics.update(TICK, t, [ship], [], [], [], []);
    psi.push({ t, v: ship.roll - densePlane(ship, t).roll });
  }
  const crossings = [];
  for (let k = 1; k < psi.length; k++) {
    if (Math.sign(psi[k].v) !== Math.sign(psi[k - 1].v) && psi[k - 1].v !== 0) {
      const a = psi[k - 1]; const b = psi[k];
      crossings.push(a.t + (b.t - a.t) * (a.v / (a.v - b.v)));
    }
  }
  const peaks = [];
  for (let k = 1; k < psi.length - 1; k++) {
    if (Math.abs(psi[k].v) > Math.abs(psi[k - 1].v) && Math.abs(psi[k].v) >= Math.abs(psi[k + 1].v) && Math.abs(psi[k].v) > 0.4 * DEG) peaks.push(psi[k]);
  }
  const period = crossings.length >= 3 ? (crossings[2] - crossings[0]) : NaN;
  const samePeaks = peaks.filter((p) => Math.sign(p.v) === Math.sign(peaks[0]?.v));
  const delta = samePeaks.length >= 2 ? Math.log(Math.abs(samePeaks[0].v / samePeaks[1].v)) : NaN;
  const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
  expect(`${type} roll period ${PERIOD[type][0]}-${PERIOD[type][1]} s`, period >= PERIOD[type][0] && period <= PERIOD[type][1],
    `${period.toFixed(2)} s, first peak ${peaks[0] ? deg(peaks[0].v) : 'none'} deg`);
  expect(`${type} roll damping ratio 0.2-0.4`, zeta >= 0.2 && zeta <= 0.4, `zeta ${zeta.toFixed(3)} from ${samePeaks.length} same-sign peaks`);
}

// ── 3 beam-reach heel ────────────────────────────────────────────────────────
console.log('\nSection 3: steady heel under sail (moment balance)');
const HEEL = { sloop: [7, 9], brigantine: [5, 7], galleon: [3, 5] };
function steadyHeel(type, offDeg, side, sailHeight = 1) {
  const physics = new PhysicsSystem();
  const ship = makeShip(type, { sailHeight, position: { x: 0, y: 0, z: 0 } });
  let sum = 0; let n = 0; let sr = 0;
  for (let i = 0; i < 45 / TICK; i++) {
    const t = i * TICK;
    const w = sampleWind(t);
    ship.rotation = angleWrap(w.direction + side * (Math.PI - offDeg * DEG));
    ship.angularVelocity = 0;
    ship.sailAngle = idealBrace(angleWrap(w.direction - ship.rotation));
    physics.update(TICK, t, [ship], [], [], [], []);
    if (t < 37) continue;
    sum += ship.roll - densePlane(ship, t).roll; n++;
    sr = angleWrap(w.direction - ship.rotation);
  }
  return { heel: sum / n, leeward: -Math.sign(Math.sin(sr)), luffing: !!ship.luffing };
}
for (const type of TYPES) {
  const a = steadyHeel(type, 90, 1);
  const b = steadyHeel(type, 90, -1);
  const [lo, hi] = HEEL[type];
  expect(`${type} beam-reach heel ${lo}-${hi} deg`, Math.abs(a.heel) >= lo * DEG && Math.abs(a.heel) <= hi * DEG, `${deg(a.heel)} deg`);
  expect(`${type} heels to leeward on both tacks, mirror within 0.3 deg`,
    Math.sign(a.heel) === a.leeward && Math.sign(b.heel) === b.leeward && Math.abs(Math.abs(a.heel) - Math.abs(b.heel)) < 0.3 * DEG,
    `${deg(a.heel)} / ${deg(b.heel)} deg`);
  const luff = steadyHeel(type, 25, 1);
  expect(`${type} luffing in irons: no heel`, luff.luffing && Math.abs(luff.heel) < 0.3 * DEG, `${deg(luff.heel)} deg luffing=${luff.luffing}`);
  const struck = steadyHeel(type, 90, 1, 0);
  expect(`${type} canvas struck: no heel`, Math.abs(struck.heel) < 0.3 * DEG, `${deg(struck.heel)} deg`);
}

// ── 4 turn heel ──────────────────────────────────────────────────────────────
console.log('\nSection 4: turn heel is outward and <= 3 deg');
for (const type of TYPES) {
  for (const dir of [1, -1]) {
    const physics = new PhysicsSystem();
    const ship = makeShip(type, { rudderAngle: 0, position: { x: 0, y: 0, z: 0 }, rotation: 0, velocity: { x: 0, y: 0, z: SHIP_STATS[type].maxSpeed * 0.85 } });
    const helm = { id: `helm-${ship.id}`, atHelm: true, onShipId: ship.id, state: 'eliminated', respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0 };
    let heel = 0; let omega = 0; let maxAbs = 0; let steady = 0; let ns = 0;
    for (let i = 0; i < 6 / TICK; i++) {
      const t = i * TICK;
      PS.applyShipRudderSteering(ship, TICK, dir, 1);
      physics.update(TICK, t, [ship], [helm], [], [], []);
      const h = ship.roll - densePlane(ship, t).roll;
      maxAbs = Math.max(maxAbs, Math.abs(h));
      if (t > 3 && t < 4) { heel = h; omega = ship.angularVelocity; }
      if (t > 3 && t < 5) { steady += h; ns++; }
    }
    expect(`${type} helm ${dir > 0 ? '+' : '-'}: heel carries omega's sign (outward, +roll lifts +x)`,
      Math.abs(omega) > 0.02 && Math.sign(heel) === Math.sign(omega) && Math.abs(heel) > 0.3 * DEG, `heel ${deg(heel)} deg, omega ${omega.toFixed(3)} rad/s`);
    expect(`${type} helm ${dir > 0 ? '+' : '-'}: steady turn heel <= 3 deg`, Math.abs(steady / ns) <= 3 * DEG, `${deg(steady / ns)} deg`);
    expect(`${type} helm ${dir > 0 ? '+' : '-'}: peak incl. the sea riding on it <= 3.5 deg`, maxAbs <= 3.5 * DEG, `${deg(maxAbs)} deg`);
  }
}

// ── 5 berth heave ────────────────────────────────────────────────────────────
console.log('\nSection 5: a hull anchored in her berth, weather 0');
{
  const match = new Match({ matchId: 'seakeeping-berth', botCount: 0 });
  match.addHumanClient({ readyState: 1, send() {} }, 'Pirate_1');
  const hull = match.state.ships.find((s) => s.alive);
  const islands = match.state.islands;
  const physics = new PhysicsSystem();
  const ship = makeShip(hull.type, { position: { ...hull.position }, rotation: hull.rotation, anchored: true });
  const open = makeShip(hull.type, { id: 'sk-open', anchored: true, position: { x: hull.position.x, y: 0, z: hull.position.z } });
  const ys = []; const yo = [];
  for (let i = 0; i < 60 / TICK; i++) {
    const t = i * TICK;
    physics.update(TICK, t, [ship], [], [], islands, []);
    if (t > 5) { ys.push(ship.position.y + (ship.heave ?? 0)); }
  }
  // The same point with no pier around it (no islands): the open sea there.
  const physics2 = new PhysicsSystem();
  for (let i = 0; i < 60 / TICK; i++) {
    const t = i * TICK;
    physics2.update(TICK, t, [open], [], [], [], []);
    if (t > 5) yo.push(open.position.y + (open.heave ?? 0));
  }
  const dev = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.max(...arr.map((v) => Math.abs(v - m))); };
  expect('berthed hull drawn heave within +-0.35 m of its mean', dev(ys) <= 0.35, `${dev(ys).toFixed(3)} m (open sea at the same point ${dev(yo).toFixed(3)} m)`);
  expect('the open-sea twin really does heave more (the gate can fail)', dev(yo) > 0.35, `${dev(yo).toFixed(3)} m`);
}

// ── 6 point loads ────────────────────────────────────────────────────────────
console.log('\nSection 6: applyPointLoad (the flood water enters here)');
if (typeof PhysicsSystem.prototype.applyPointLoad !== 'function') {
  expect('PhysicsSystem.applyPointLoad(ship, local, mass) exists', false, 'missing');
} else {
  for (const type of TYPES) {
    const { length: L, width: B } = SHIP_STATS[type];
    const mass = { sloop: 6000, brigantine: 12000, galleon: 24000 }[type];
    const run = (load) => {
      const physics = new PhysicsSystem();
      const ship = makeShip(type);
      let y = 0; let r = 0; let p = 0; let n = 0;
      for (let i = 0; i < 30 / TICK; i++) {
        const t = i * TICK;
        if (load) physics.applyPointLoad(ship, { x: 0.3 * B, y: -0.5, z: 0.3 * L }, mass);
        physics.update(TICK, t, [ship], [], [], [], []);
        if (t < 15) continue;
        const pl = densePlane(ship, t);
        y += ship.position.y - pl.y; r += ship.roll - pl.roll; p += ship.pitch - pl.pitch; n++;
      }
      return { y: y / n, r: r / n, p: p / n };
    };
    const dry = run(false); const wet = run(true);
    expect(`${type} ${mass / 1000} t on the port bow: sinks, lists to port (-roll), trims by the bow (+pitch)`,
      wet.y - dry.y < -0.02 && wet.r - dry.r < -0.5 * DEG && wet.p - dry.p > 0.2 * DEG,
      `sink ${(wet.y - dry.y).toFixed(3)} m, roll ${deg(wet.r - dry.r)} deg, pitch ${deg(wet.p - dry.p)} deg`);
  }
}

// ── 7 storm ──────────────────────────────────────────────────────────────────
console.log('\nSection 7: storm sea state, slams and green water');
{
  const storm = { centerX: 0, centerZ: 0, safeRadius: 20, phase: 6 };
  for (const [label, st] of [['storm', storm], ['calm', null]]) {
    const physics = new PhysicsSystem();
    const ship = makeShip('sloop', { sailHeight: 1 });
    let events = 0; let finite = true; let maxRoll = 0; let slams = 0;
    for (let i = 0; i < 60 / TICK; i++) {
      const t = i * TICK;
      const w = sampleWind(t);
      ship.sailAngle = idealBrace(angleWrap(w.direction - ship.rotation));
      physics.update(TICK, t, [ship], [], [], [], [], st);
      const ev = physics.seaEvents ?? [];
      events += ev.length; slams += ev.filter((e) => e.kind === 'slam').length;
      if (!Number.isFinite(ship.position.y) || !Number.isFinite(ship.roll) || !Number.isFinite(ship.pitch)) finite = false;
      maxRoll = Math.max(maxRoll, Math.abs(ship.roll));
    }
    if (label === 'storm') {
      const sea = getStormWaveIntensity(st, ship.position.x, ship.position.z);
      expect('storm: attitude finite and inside the clamps', finite && maxRoll <= 0.55, `max roll ${deg(maxRoll)} deg, sea ${sea.toFixed(2)}`);
      expect('storm: slam / green-water events published for a sloop', events > 0, `${events} events (${slams} slams)`);
    } else {
      expect('calm: no slam / green-water events', events === 0, `${events} events`);
    }
  }
}

if (typeof PS.SEAKEEPING === 'object') {
  for (const type of TYPES) {
    const sk = PS.SEAKEEPING[type];
    console.log(`  ${type}: ${sk.stations.length} stations, T heave ${(2 * Math.PI / sk.heaveOmega).toFixed(2)} s, roll ${(2 * Math.PI / sk.rollOmega).toFixed(2)} s, pitch ${(2 * Math.PI / sk.pitchOmega).toFixed(2)} s, heel arm ${sk.heelArm.toFixed(2)} m`);
  }
  expect('>= 21 buoyancy stations per hull', TYPES.every((ty) => PS.SEAKEEPING[ty].stations.length >= 21));
} else {
  expect('>= 21 buoyancy stations per hull (SEAKEEPING export)', false, 'missing');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
