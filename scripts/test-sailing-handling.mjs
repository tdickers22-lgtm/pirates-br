#!/usr/bin/env node
// test-sailing-handling (b2.1, PLAN 3.7 / D16 / physics targetSpec).
// Sections implemented so far:
//   1  ships have mass (b2.1b): on the REAL PhysicsSystem at the 62.5 Hz tick,
//      t90 from rest with canvas set, sail-struck coast-down from top speed,
//      a hard-over tack from the beam through the no-go cone, and the world
//      edge (a soft inward current, never a bounce)
//   2  class identity: per-class polars vs the D16 table, ordering, and the
//      real PhysicsSystem sailing at the polar (steady speed / wind strength)
//   5  sail trim: idealBrace monotonic over 40-180 deg, <= 65 deg, bisecting
//      shape; physics / bots / first-sail assist / HUD / renderer read the ONE
//      shared function (source identity) and constants mirror sailing.ts
//   H  hull params: mass 1 : 1.9 : 3.6, drag solved to the D16 top speeds and
//      t90 targets, keel >= 25x, yaw inertia m(L^2+B^2)/12 (design analytics;
//      the force-based dynamics that consume them are b2.1b, section 1)
// Section 3 (turning: yaw inertia, rudder moment) lands with b2.1d.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CLASS_TOP_SPEED, HULL_PARAMS, KEEL_LATERAL_RATIO, MAX_BRACE, braceCatch,
  idealBrace, polarSpeed,
} from '../src/shared/sailing.ts';
import { PhysicsSystem, applyShipRudderSteering } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP, SHIP_STATS, WORLD } from '../src/shared/constants/index.ts';
import { angleWrap, sampleWind } from '../src/shared/utils/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEG = Math.PI / 180;
const CLASSES = ['sloop', 'brigantine', 'galleon'];
let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const within = (v, target, frac) => Math.abs(v - target) <= Math.abs(target) * frac;

// ── Section 2: class identity ────────────────────────────────────────────────
console.log('Section 2: per-class polars (D16)');
// D16 decided table (orchestrator): best point of sail and top speed per class,
// sloop usable from 40 deg, drift <= 1.5 m/s in irons, nothing above 14 m/s.
const D16 = {
  sloop: { best: [90], top: 14.0 },
  brigantine: { best: [135], top: 13.5 },
  galleon: { best: [135, 180], top: 13.0 },
};
const SAMPLE_DEG = [20, 35, 40, 45, 60, 90, 110, 135, 150, 180];
const table = {};
for (const t of CLASSES) table[t] = SAMPLE_DEG.map((d) => polarSpeed(t, d * DEG));
console.log(`     deg      ${SAMPLE_DEG.map((d) => String(d).padStart(5)).join('')}`);
for (const t of CLASSES) console.log(`     ${t.padEnd(10)} ${table[t].map((v) => v.toFixed(1).padStart(5)).join('')}`);
for (const t of CLASSES) {
  let peak = 0; let peakDeg = 0;
  for (let d = 0; d <= 180; d += 0.5) {
    const v = polarSpeed(t, d * DEG);
    if (v > peak + 1e-9) { peak = v; peakDeg = d; }
  }
  expect(`${t}: top speed within 10% of D16 ${D16[t].top}`, within(peak, D16[t].top, 0.10), `peak ${peak.toFixed(2)} m/s at ${peakDeg} deg`);
  expect(`${t}: top speed sits on its D16 best point of sail (${D16[t].best.join('/')} deg)`,
    D16[t].best.some((b) => within(polarSpeed(t, b * DEG), D16[t].top, 0.02)) && D16[t].best.some((b) => Math.abs(b - peakDeg) <= 10),
    `peak at ${peakDeg} deg`);
  expect(`${t}: CLASS_TOP_SPEED is the polar max`, Math.abs(peak - CLASS_TOP_SPEED[t]) < 1e-9, `${CLASS_TOP_SPEED[t]} vs ${peak}`);
  expect(`${t}: in irons is a drift <= 1.5 m/s`, polarSpeed(t, 20 * DEG) <= 1.5 && polarSpeed(t, 34 * DEG) <= 1.5);
  expect(`${t}: never above 14 m/s`, peak <= 14 + 1e-9);
}
const at = (t, d) => polarSpeed(t, d * DEG);
expect('45 deg: sloop > brig > galleon (sloop points highest)', at('sloop', 45) > at('brigantine', 45) && at('brigantine', 45) > at('galleon', 45),
  `${at('sloop', 45)} / ${at('brigantine', 45)} / ${at('galleon', 45)}`);
expect('90 deg: sloop > brig > galleon (BR ladder kept at the beam)', at('sloop', 90) > at('brigantine', 90) && at('brigantine', 90) > at('galleon', 90),
  `${at('sloop', 90)} / ${at('brigantine', 90)} / ${at('galleon', 90)}`);
expect('180 deg: galleon > brig > sloop (galleon fastest downwind)', at('galleon', 180) > at('brigantine', 180) && at('brigantine', 180) > at('sloop', 180),
  `${at('galleon', 180)} / ${at('brigantine', 180)} / ${at('sloop', 180)}`);
expect('sloop is usable from 40 deg (>= 30% of top), the galleon is not', at('sloop', 40) >= 0.3 * 14 && at('galleon', 40) < 0.3 * 13,
  `sloop ${at('sloop', 40)} galleon ${at('galleon', 40)}`);
for (const t of CLASSES) {
  let mono = true;
  for (let d = 35; d < 90; d += 0.5) if (at(t, d + 0.5) < at(t, d) - 1e-9) mono = false;
  expect(`${t}: polar rises monotonically from the cone edge to the beam`, mono);
}

// The real PhysicsSystem sails at the polar: steady speed / wind strength with
// the ideal brace and full canvas lands within 10% of the table.
function makeShip(type) {
  const stats = SHIP_STATS[type];
  return {
    id: `ship-${type}`, type, ownerId: 'owner', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}
function steadySpeed(type, offDeg, seconds = 30) {
  const physics = new PhysicsSystem();
  const ship = makeShip(type);
  const DT = 1 / 60;
  let t = 0; let wind = sampleWind(0);
  for (let i = 0; i < seconds * 60; i++) {
    t += DT;
    wind = sampleWind(t);
    ship.rotation = angleWrap(wind.direction + Math.PI - offDeg * DEG);
    ship.angularVelocity = 0;
    ship.sailAngle = idealBrace(angleWrap(wind.direction - ship.rotation));
    physics.update(DT, t, [ship], [], [], [], []);
  }
  const fwd = Math.sin(ship.rotation) * ship.velocity.x + Math.cos(ship.rotation) * ship.velocity.z;
  return fwd / wind.strength;
}
for (const [t, d] of [['sloop', 90], ['sloop', 180], ['brigantine', 135], ['galleon', 180], ['galleon', 45]]) {
  const v = steadySpeed(t, d);
  expect(`PhysicsSystem ${t} at ${d} deg sails its polar (+-10%)`, within(v, at(t, d), 0.10), `sim ${v.toFixed(2)} / polar ${at(t, d).toFixed(2)} m/s per unit wind`);
}

// ── Section 1: ships have mass ───────────────────────────────────────────────
console.log('\nSection 1: force-based dynamics (t90, coast-down, tack, world edge)');
const TICK = 0.016; // the fixed 62.5 Hz server tick
const BEST = { sloop: 90, brigantine: 135, galleon: 135 };
const fwdOf = (s) => Math.sin(s.rotation) * s.velocity.x + Math.cos(s.rotation) * s.velocity.z;
const helmFor = (s) => ({ id: `helm-${s.id}`, atHelm: true, onShipId: s.id, state: 'eliminated', respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0 });
// Hold a heading `offDeg` off the wind on the side `side` (+1/-1) with the ideal brace.
function holdPointOfSail(ship, t, offDeg, side = 1) {
  const w = sampleWind(t);
  ship.rotation = angleWrap(w.direction + side * (Math.PI - offDeg * DEG));
  ship.angularVelocity = 0;
  ship.sailAngle = idealBrace(angleWrap(w.direction - ship.rotation));
  return w;
}
const T90_WIN = { sloop: [7, 9], brigantine: [10, 12], galleon: [14, 17] };
const COAST_WIN = { sloop: [6, 12], brigantine: [8, 15], galleon: [10, 18] };
const TACK_MAX = { sloop: 8, brigantine: 11, galleon: 16 };
for (const type of CLASSES) {
  // t90: from rest, canvas already set, the class's best point of sail.
  {
    const physics = new PhysicsSystem();
    const ship = makeShip(type);
    let t = 0; let t90 = null;
    for (let i = 0; i < 40 / TICK && t90 === null; i++) {
      const w = holdPointOfSail(ship, t, BEST[type]);
      t += TICK;
      physics.update(TICK, t, [ship], [], [], [], []);
      if (fwdOf(ship) >= 0.9 * polarSpeed(type, BEST[type] * DEG) * w.strength) t90 = t;
    }
    expect(`${type}: t90 from rest with sails set ${T90_WIN[type].join('-')} s`, t90 !== null && t90 >= T90_WIN[type][0] && t90 <= T90_WIN[type][1], `t90 ${t90 === null ? 'never' : t90.toFixed(2)} s`);
  }
  // Coast-down: at the class top speed, strike sail, time to < 1 m/s.
  {
    const physics = new PhysicsSystem();
    const ship = makeShip(type);
    let t = 0;
    holdPointOfSail(ship, t, BEST[type]);
    ship.velocity.x = Math.sin(ship.rotation) * CLASS_TOP_SPEED[type];
    ship.velocity.z = Math.cos(ship.rotation) * CLASS_TOP_SPEED[type];
    ship.sailHeight = 0;
    let tStop = null; let dist = 0;
    for (let i = 0; i < 60 / TICK && tStop === null; i++) {
      const x0 = ship.position.x; const z0 = ship.position.z;
      t += TICK;
      physics.update(TICK, t, [ship], [], [], [], []);
      dist += Math.hypot(ship.position.x - x0, ship.position.z - z0);
      if (Math.hypot(ship.velocity.x, ship.velocity.z) < 1) tStop = t;
    }
    expect(`${type}: sail-struck coast-down from ${CLASS_TOP_SPEED[type]} m/s to < 1 m/s in ${COAST_WIN[type].join('-')} s`, tStop !== null && tStop >= COAST_WIN[type][0] && tStop <= COAST_WIN[type][1], `${tStop === null ? 'never' : tStop.toFixed(2)} s over ${dist.toFixed(0)} m`);
  }
  // Tack: steady on the beam, hard over toward the wind, through the no-go
  // cone, done when she bears 60 deg off the wind on the other tack.
  {
    const physics = new PhysicsSystem();
    const ship = makeShip(type);
    ship.rudderAngle = 0;
    let t = 0;
    for (let i = 0; i < 45 / TICK; i++) { holdPointOfSail(ship, t, 90, 1); t += TICK; physics.update(TICK, t, [ship], [], [], [], []); }
    const entry = Math.hypot(ship.velocity.x, ship.velocity.z);
    const side0 = Math.sign(angleWrap(sampleWind(t).direction - ship.rotation));
    const helm = helmFor(ship);
    // physics targetSpec 1: she "keeps >= 45 % of entry speed THROUGH the 70 deg
    // no-go cone": vCone is the least speed from helm-over until the bow leaves
    // the cone on the new tack (momentum is all that carries her there). After
    // that the canvas draws again and she settles toward her close-hauled polar,
    // which for the galleon is itself ~31% of top; vMin (whole manoeuvre) is
    // printed for the record.
    let vMin = entry; let vCone = entry; let exited = false; let done = null; let crossed = false; let reversed = false;
    for (let i = 0; i < 40 / TICK && done === null; i++) {
      const w = sampleWind(t);
      const sr = angleWrap(w.direction - ship.rotation);
      ship.sailAngle = idealBrace(sr);
      applyShipRudderSteering(ship, TICK, side0, 1);
      t += TICK;
      physics.update(TICK, t, [ship], [helm], [], [], []);
      vMin = Math.min(vMin, Math.hypot(ship.velocity.x, ship.velocity.z));
      if (fwdOf(ship) < 0) reversed = true;
      const sr1 = angleWrap(sampleWind(t).direction - ship.rotation);
      if (!crossed && Math.sign(sr1) === -side0 && Math.PI - Math.abs(sr1) < 0.5) crossed = true;
      if (!exited) vCone = Math.min(vCone, Math.hypot(ship.velocity.x, ship.velocity.z));
      if (crossed && Math.PI - Math.abs(sr1) > SHIP.SAIL_NO_GO_ANGLE) exited = true;
      if (crossed && Math.PI - Math.abs(sr1) >= 60 * DEG) done = i * TICK + TICK;
    }
    expect(`${type}: hard-over tack completes within ${TACK_MAX[type]} s`, done !== null && done <= TACK_MAX[type], `${done === null ? 'never' : done.toFixed(2)} s`);
    expect(`${type}: the tack keeps >= 45% of entry speed through the no-go cone (way carried through irons)`, exited && vCone >= 0.45 * entry && !reversed,
      `entry ${entry.toFixed(2)} through-cone min ${vCone.toFixed(2)} m/s (${(100 * vCone / entry).toFixed(0)}%); whole-manoeuvre min ${vMin.toFixed(2)} (${(100 * vMin / entry).toFixed(0)}%)`);
  }
  // World edge: sail at the wall at full speed; no bounce, never past it.
  {
    const physics = new PhysicsSystem();
    const ship = makeShip(type);
    let t = 0;
    const boundary = WORLD.HALF - WORLD.SHIP_MARGIN;
    holdPointOfSail(ship, t, BEST[type]);
    // Start 180 m inside the wall the bow points at most squarely, at speed.
    const hx = Math.sin(ship.rotation); const hz = Math.cos(ship.rotation);
    const axisX = Math.abs(hx) >= Math.abs(hz);
    const s = Math.sign(axisX ? hx : hz);
    if (axisX) ship.position.x = s * (boundary - 180); else ship.position.z = s * (boundary - 180);
    ship.velocity.x = hx * CLASS_TOP_SPEED[type] * 0.9; ship.velocity.z = hz * CLASS_TOP_SPEED[type] * 0.9;
    let minFwd = Infinity; let minNormal = Infinity; let maxPos = 0;
    for (let i = 0; i < 40 / TICK; i++) {
      holdPointOfSail(ship, t, BEST[type]);
      t += TICK;
      physics.update(TICK, t, [ship], [], [], [], []);
      minFwd = Math.min(minFwd, fwdOf(ship));
      minNormal = Math.min(minNormal, s * (axisX ? ship.velocity.x : ship.velocity.z));
      maxPos = Math.max(maxPos, Math.abs(ship.position.x), Math.abs(ship.position.z));
    }
    expect(`${type}: at the world edge the heading velocity never reverses`, minFwd >= -1e-6, `min forward ${minFwd.toFixed(3)} m/s`);
    expect(`${type}: the edge is a soft current, not a bounce (inward normal speed <= 1 m/s)`, minNormal >= -1, `min outward-normal ${minNormal.toFixed(2)} m/s`);
    expect(`${type}: never past the boundary`, maxPos <= boundary + 1e-6, `max |pos| ${maxPos.toFixed(2)} / ${boundary}`);
  }
}

// ── Section 5: sail trim ─────────────────────────────────────────────────────
console.log('\nSection 5: the ideal brace');
let monotonic = true; let maxMag = 0; let prev = Infinity;
for (let off = 40; off <= 180; off += 0.25) {
  const sr = Math.PI - off * DEG; // wind on one side
  const mag = Math.abs(idealBrace(sr));
  if (mag > prev + 1e-12) monotonic = false;
  prev = mag; maxMag = Math.max(maxMag, mag);
}
expect('idealBrace is monotonic (non-increasing) from 40 to 180 deg off the wind', monotonic);
expect('idealBrace never exceeds 65 deg', maxMag <= 65 * DEG + 1e-12 && MAX_BRACE <= 65 * DEG + 1e-12, `max ${(maxMag / DEG).toFixed(1)} deg`);
const braceDeg = (off) => Math.abs(idealBrace(Math.PI - off * DEG)) / DEG;
expect('dead run: square yard (0 deg)', braceDeg(180) < 1e-9);
expect('broad reach (135): 20-30 deg', braceDeg(135) >= 20 && braceDeg(135) <= 30, `${braceDeg(135).toFixed(1)}`);
expect('beam (90): 40-50 deg', braceDeg(90) >= 40 && braceDeg(90) <= 50, `${braceDeg(90).toFixed(1)}`);
expect('close-hauled (45): braced to the limit', Math.abs(braceDeg(45) - MAX_BRACE / DEG) < 1e-9, `${braceDeg(45).toFixed(1)}`);
let signOk = true;
for (let sr = -3.1; sr <= 3.1; sr += 0.05) {
  if (Math.abs(sr) < 1e-6) continue;
  if (Math.sign(idealBrace(sr)) !== Math.sign(Math.sin(sr))) signOk = false;
  if (Math.sign(idealBrace(sr)) !== -Math.sign(idealBrace(-sr))) signOk = false;
}
expect('brace sign unchanged from the old convention (lee yardarm aft) and mirror-symmetric', signOk);
expect('braceCatch is 1.0 at the ideal brace, 0 a full range off', braceCatch(idealBrace(1.2), 1.2) === 1 && braceCatch(idealBrace(1.2) + MAX_BRACE, 1.2) === 0);

console.log('\nSection 5: one function, one number (import identity)');
expect('SHIP.MAX_SAIL_ANGLE mirrors sailing.MAX_BRACE (65 deg)', Math.abs(SHIP.MAX_SAIL_ANGLE - MAX_BRACE) < 1e-12, `${SHIP.MAX_SAIL_ANGLE} vs ${MAX_BRACE}`);
for (const t of CLASSES) {
  expect(`SHIP_STATS.${t}.maxSpeed mirrors CLASS_TOP_SPEED`, SHIP_STATS[t].maxSpeed === CLASS_TOP_SPEED[t], `${SHIP_STATS[t].maxSpeed} vs ${CLASS_TOP_SPEED[t]}`);
}
const readers = {
  'src/server/systems/PhysicsSystem.ts': ['idealBrace|trimEfficiency', 'polarSpeed|sailPolarFraction'],
  'src/server/systems/bots/BotPirate.ts': ['idealBrace'],
  'src/server/core/Match.ts': ['idealBrace'],
  'src/client/ui/HudController.ts': ['idealBrace|braceCatch'],
  'src/client/rendering/ShipRenderer.ts': ['idealBrace|braceCatch'],
};
const OLD_FORMULA = /Math\.sin\(\s*\w+\s*\)\s*\*\s*SHIP\.MAX_SAIL_ANGLE\s*\*\s*0\.9\d/;
for (const [file, names] of Object.entries(readers)) {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const importLine = src.match(/import\s*\{([^}]*)\}\s*from\s*'[./]*(?:shared\/)?sailing\.js'/);
  const imported = importLine ? importLine[1] : '';
  const missing = names.filter((alt) => !alt.split('|').some((n) => new RegExp(`\\b${n}\\b`).test(imported)));
  expect(`${file} imports ${names.join(', ')} from shared/sailing`, importLine && missing.length === 0, importLine ? `missing ${missing}` : 'no sailing.js import');
  expect(`${file} carries no private copy of the brace formula`, !OLD_FORMULA.test(src));
}
{
  const src = readFileSync(path.join(ROOT, 'src/client/rendering/ShipRenderer.ts'), 'utf8');
  expect('ShipRenderer draws the simulated brace 1:1 (no x0.6)', !/sailAngle\s*\*\s*0\.6\b/.test(src));
}

// ── Hull params (consumed by b2.1b/b2.1d/b2.1g) ──────────────────────────────
console.log('\nHull params: mass, drag solved to D16, keel, yaw inertia');
const ms = HULL_PARAMS.sloop.mass;
expect('mass ratio 1 : 1.9 : 3.6', within(HULL_PARAMS.brigantine.mass / ms, 1.9, 0.001) && within(HULL_PARAMS.galleon.mass / ms, 3.6, 0.001));
const T90 = { sloop: [7, 9], brigantine: [10, 12], galleon: [14, 17] };
const COAST = { sloop: [6, 12], brigantine: [8, 15], galleon: [10, 18] };
for (const t of CLASSES) {
  const h = HULL_PARAMS[t];
  const balance = h.c1 * h.topSpeed + h.c2 * h.topSpeed ** 2;
  expect(`${t}: full drive balances the drag exactly at the D16 top speed`, within(balance, h.maxDrive, 1e-9) && h.topSpeed === CLASS_TOP_SPEED[t]);
  expect(`${t}: quadratic drag present (c2 > 0)`, h.c2 > 0, `c1 ${h.c1.toFixed(0)} c2 ${h.c2.toFixed(1)}`);
  expect(`${t}: design t90 ${T90[t].join('-')} s`, h.t90 >= T90[t][0] && h.t90 <= T90[t][1], `${h.t90.toFixed(2)} s`);
  expect(`${t}: design coast-down to 1 m/s ${COAST[t].join('-')} s`, h.coastToOne >= COAST[t][0] && h.coastToOne <= COAST[t][1], `${h.coastToOne.toFixed(2)} s`);
  expect(`${t}: keel resists >= 25x the forward drag`, h.cLat1 >= 25 * h.c1 && h.cLat2 >= 25 * h.c2 && KEEL_LATERAL_RATIO >= 25);
  const st = SHIP_STATS[t];
  expect(`${t}: yaw inertia = m(L^2+B^2)/12`, within(h.yawInertia, (h.mass * (st.length ** 2 + st.width ** 2)) / 12, 1e-12));
}
expect('yaw inertia grows with the class', HULL_PARAMS.sloop.yawInertia < HULL_PARAMS.brigantine.yawInertia && HULL_PARAMS.brigantine.yawInertia < HULL_PARAMS.galleon.yawInertia);

if (failures > 0) { console.error(`\n✗ test-sailing-handling: ${failures} failure(s)`); process.exit(1); }
console.log('\n✓ test-sailing-handling: all checks passed');
