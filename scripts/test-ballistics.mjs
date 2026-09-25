#!/usr/bin/env node
// test-ballistics (b2.1f, D17, physics-06 / physics-07).
// One ballistic model (src/shared/ballistics.ts) for the gun, the server step,
// the bot gunner and the client extrapolation:
//   1. range/elevation table: the REAL WeaponSystem launch + the REAL PhysicsSystem
//      step land within 3% of the D17 analytic range (g 9.81, no kick, no drag);
//      max range at the top elevation 300-312 m
//   2. a 150 m broadside from a sloop making 14 m/s stays within 1 m of the analytic
//      arc WITH her velocity inherited (35 m off before b2.1f)
//   3. hull motion: omega x r matches the muzzle's finite difference; PhysicsSystem
//      records heave/roll/pitch rates the gun inherits
//   4. server step vs the client's closed-form extrapolation within 1 cm at 3 s
//   5. the bot solver with no noise lands >= 95% on a moving hull at 150 m
//   6. grazing skip: a 3 deg shot at 55 m/s skips and flies >= 20 m further; a
//      20 deg shot goes in
import { readFileSync } from 'node:fs';
import { WeaponSystem } from '../src/server/systems/WeaponSystem.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { computeCannonAim } from '../src/server/systems/bots/BotPirate.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import * as B from '../src/shared/ballistics.ts';
import { gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';

const G = 9.81;
const V = 56;
const DT = 0.016;
let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
function makeShip(type, over = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: over.id ?? `ship-${type}`, type, ownerId: 'owner', crewIds: [], crewId: null, position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [],
    inventory: [{ item: 'cannonball', qty: 999 }], repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc,
    alive: true, upgrades: [], rudderAngle: 0, ...over,
  };
}
const gunner = (ship) => ({ id: 'gunner', state: 'alive', atCannon: true, cannonIndex: 0, selectedCannonAmmo: 'cannonball',
  superCannonballs: 0, weapons: [], activeSlot: 0, onShipId: ship.id });
function fire(ship, yaw, pitch, cannonIndex = 0) {
  const ws = new WeaponSystem(() => 0.5, () => 1e9);
  ship.cannonCooldowns.fill(0);
  ws.tryFire(gunner(ship), ship, yaw, pitch, cannonIndex);
  const [p] = ws.flushProjectiles();
  return p;
}
/** Horizontal distance from `p0` to where the D17 arc from (p0, v0) meets y = yEnd, descending. */
function analyticRange(p0, v0, yEnd = 0, g = G) {
  const a = 0.5 * g, b = -v0.y, c = yEnd - p0.y; // a t^2 + b t + c = 0 after sign flip
  const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return { t, range: Math.hypot(v0.x * t, v0.z * t) };
}
/** Step the REAL server projectile path for `seconds` (no ships, no islands, calm sea).
 *  Returns the state it reached (or where the sea took it). */
function serverStep(proj, seconds) {
  const physics = new PhysicsSystem();
  const n = Math.round(seconds / DT);
  const trace = [];
  for (let i = 0; i < n && proj.alive; i += 1) {
    physics.update(DT, 10 + i * DT, [], [], [proj], [], [], null);
    trace.push({ t: (i + 1) * DT, x: proj.position.x, y: proj.position.y, z: proj.position.z, alive: proj.alive });
  }
  return trace;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Range/elevation table (sloop at rest, port gun, real WeaponSystem + real PhysicsSystem 0.3 s, then the arc to the sea)');
{
  const rows = [];
  for (const pitch of [-0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, SHIP.CANNON_PITCH_MAX]) {
    const ship = makeShip('sloop');
    const proj = fire(ship, Math.PI / 2, pitch);
    const muzzle = { ...proj.position };
    const dir = B.barrelDirection(Math.PI / 2, pitch);
    const expected = analyticRange(muzzle, { x: dir.x * V, y: dir.y * V, z: dir.z * V }).range;
    const trace = serverStep(proj, 0.3);
    const last = trace[trace.length - 1];
    const vNow = proj.velocity;
    const rest = analyticRange(last, vNow);
    const got = Math.hypot(last.x - muzzle.x, last.z - muzzle.z) + rest.range;
    const err = Math.abs(got - expected) / expected;
    rows.push(`${(pitch * 180 / Math.PI).toFixed(1)}deg ${got.toFixed(1)}/${expected.toFixed(1)} m`);
    expect(`pitch ${(pitch * 180 / Math.PI).toFixed(1)} deg: server range within 3% of D17 analytic`, err <= 0.03,
      `server ${got.toFixed(1)} m vs analytic ${expected.toFixed(1)} m (${(err * 100).toFixed(1)}%)`);
    if (pitch === SHIP.CANNON_PITCH_MAX) {
      expect('max range at the top elevation is 300-312 m (storm spacing unchanged)', got >= 300 && got <= 312, `${got.toFixed(1)} m`);
      const flight = analyticRange(muzzle, proj.velocity).t;
      void flight;
    }
  }
  console.log(`     table: ${rows.join(' | ')}`);
  expect('the ball leaves along the barrel: launch pitch == barrel pitch at rest (no +5 m/s kick)', (() => {
    const p = fire(makeShip('sloop'), Math.PI / 2, 0);
    return Math.abs(Math.atan2(p.velocity.y, Math.hypot(p.velocity.x, p.velocity.z))) < 1e-6;
  })(), `vy at 0 pitch = ${fire(makeShip('sloop'), Math.PI / 2, 0).velocity.y.toFixed(3)}`);
  expect('muzzle speed at rest is 56 m/s', Math.abs(Math.hypot(...Object.values(fire(makeShip('sloop'), Math.PI / 2, 0.2).velocity)) - V) < 1e-6);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. A 150 m broadside from a sloop making 14 m/s follows the inherited-velocity arc');
{
  const ship = makeShip('sloop', { velocity: { x: 0, y: 0, z: 14 } });
  // Port gun (+x) laid so the analytic arc lands ~150 m abeam.
  const pitch = 0.5 * Math.asin(Math.min(1, 150 * G / (V * V))) - 0.01;
  const proj = fire(ship, Math.PI / 2, pitch);
  const muzzle = { ...proj.position };
  const d = B.barrelDirection(Math.PI / 2, pitch);
  const v0 = { x: d.x * V, y: d.y * V, z: d.z * V + 14 };
  const land = analyticRange(muzzle, v0);
  const trace = serverStep(proj, land.t + 0.5);
  let worst = 0;
  for (const s of trace) {
    if (s.y < 0.5) break; // the sea surface takes over below the waterline band
    const a = B.ballisticPositionAt(muzzle, v0, G, s.t);
    worst = Math.max(worst, Math.hypot(s.x - a.x, s.y - a.y, s.z - a.z));
  }
  const lastUp = trace.filter((s) => s.y >= 0.5).pop();
  expect('server flight stays within 1 m of the analytic inherited-velocity arc', worst <= 1,
    `worst ${worst.toFixed(2)} m over ${lastUp?.t.toFixed(2)} s; analytic landing ${land.range.toFixed(1)} m, ${(v0.z * land.t).toFixed(1)} m ahead of the muzzle`);
  expect('the ball carries the ship\'s way forward (lands >= 30 m ahead of where it left)', lastUp && lastUp.z - muzzle.z >= 30, `dz ${(lastUp?.z - muzzle.z).toFixed(1)} m`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. Hull motion is inherited: omega x r and heave/roll/pitch rates');
{
  const ship = makeShip('galleon', { rotation: 0.7, angularVelocity: 0.2, velocity: { x: 3, y: 0, z: -2 } });
  const idx = SHIP_STATS.galleon.cannonCount - 1;
  const m0 = B.cannonMuzzlePosition(ship, idx, 0, 0);
  const h = 1e-4;
  const m1 = B.cannonMuzzlePosition({ ...ship, rotation: ship.rotation + h, position: { x: 3 * h / 0.2, y: 0, z: -2 * h / 0.2 } }, idx, h, 0); // the laid barrel turns with her
  // Moving the yaw with the hull moves the barrel too; hold the barrel's own offset fixed by comparing base points.
  const u = B.hullPointVelocity(ship, m0);
  const fd = { x: (m1.x - m0.x) / (h / 0.2), z: (m1.z - m0.z) / (h / 0.2) };
  expect('omega x r + hull velocity == d(muzzle)/dt (finite difference)', Math.hypot(u.x - fd.x, u.z - fd.z) < 0.02,
    `analytic (${u.x.toFixed(3)}, ${u.z.toFixed(3)}) vs fd (${fd.x.toFixed(3)}, ${fd.z.toFixed(3)})`);
  const rates = { heaveRate: 0.8, rollRate: 0.1, pitchRate: -0.05 };
  const ur = B.hullPointVelocity(ship, m0, rates);
  const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
  const lx = (m0.x - ship.position.x) * c - (m0.z - ship.position.z) * s;
  const lz = (m0.x - ship.position.x) * s + (m0.z - ship.position.z) * c;
  expect('heave + roll + pitch rates lift the muzzle', Math.abs(ur.y - (0.8 + lx * 0.1 + lz * 0.05)) < 1e-9, `vy ${ur.y.toFixed(3)}`);
  // The live physics step records the rates the gun reads.
  const physics = new PhysicsSystem();
  const sailing = makeShip('brigantine', { id: 'rates' });
  let prevY = null, ok = true, detail = '';
  for (let i = 0; i < 200; i += 1) {
    physics.update(DT, 20 + i * DT, [sailing], [], [], [], [], null);
    const r = B.hullRatesOf(sailing);
    if (!r) { ok = false; detail = 'no rates recorded'; break; }
    if (prevY !== null && i > 5) {
      const fdHeave = (sailing.position.y - prevY) / DT;
      if (Math.abs(fdHeave - r.heaveRate) > 1e-6) { ok = false; detail = `tick ${i}: heaveRate ${r.heaveRate} vs fd ${fdHeave}`; break; }
    }
    prevY = sailing.position.y;
  }
  expect('PhysicsSystem records the hull heave rate each tick (== d position.y / dt)', ok, detail);
  const src = readFileSync(new URL('../src/server/systems/WeaponSystem.ts', import.meta.url), 'utf8');
  expect('WeaponSystem launches through cannonLaunchVelocity with the recorded hull rates',
    /cannonLaunchVelocity\([^)]*hullRatesOf\(ship\)/.test(src) && !/\+ 5; \/\/ slight upward arc/.test(src));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. Server step vs the client extrapolation at 3 s');
{
  const proj = { id: 'p', type: 'cannonball', ownerId: 'x', ownerShipId: 'none', position: { x: 0, y: 400, z: 0 },
    velocity: { x: 40, y: 30, z: 10 }, alive: true, age: 0, maxAge: 8, damage: 0, knockback: 0, visualOnly: false, showImpact: true };
  const p0 = { ...proj.position }, v0 = { ...proj.velocity };
  const trace = serverStep(proj, 3.008);
  const last = trace[trace.length - 1];
  const client = B.ballisticPositionAt(p0, v0, B.projectileGravity('cannonball'), last.t);
  const err = Math.hypot(last.x - client.x, last.y - client.y, last.z - client.z);
  expect('server step and client closed form agree within 1 cm at 3 s', err <= 0.01, `${(err * 100).toFixed(3)} cm at ${last.t.toFixed(3)} s`);
  const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  const fn = game.slice(game.indexOf('private getProjectileRenderPosition'), game.indexOf('private syncProjectiles'));
  expect('Game.getProjectileRenderPosition extrapolates with the shared model', /ballisticPositionAt\(/.test(fn) && /projectileGravity\(/.test(fn) && !/CANNON_GRAVITY_MULT/.test(fn));
  const bot = readFileSync(new URL('../src/server/systems/bots/BotPirate.ts', import.meta.url), 'utf8');
  expect('BotPirate solves with the shared solver (no private copy of the constants)', /solveCannonAim\(/.test(bot) && !/CANNON_VY_BOOST/.test(bot));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. Bot gunner, no noise, moving target at 150 m');
{
  let seed = 20260924;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let hits = 0; const N = 120; const misses = [];
  for (let k = 0; k < N; k += 1) {
    const heading = rnd() * Math.PI * 2;
    const speed = 6 + rnd() * 8;
    const shooter = makeShip('brigantine', { id: 'shooter', rotation: heading,
      velocity: { x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, angularVelocity: (rnd() - 0.5) * 0.1 });
    const side = rnd() < 0.5 ? 1 : -1;
    const bearing = heading + side * (Math.PI / 2 + (rnd() - 0.5) * 0.8);
    const th = rnd() * Math.PI * 2, ts = rnd() * 14;
    const target = makeShip('sloop', { id: 'target', position: { x: Math.sin(bearing) * 150, y: 0, z: Math.cos(bearing) * 150 },
      rotation: th, velocity: { x: Math.sin(th) * ts, y: 0, z: Math.cos(th) * ts } });
    const aim = computeCannonAim(() => 0.5, shooter, target, 'hard', 1);
    const cannonsPerSide = SHIP_STATS.brigantine.cannonCount / 2;
    const idx = side > 0 ? 0 : cannonsPerSide;
    const proj = fire(shooter, aim.yaw, aim.pitch, idx);
    const pos = { ...proj.position }, vel = { ...proj.velocity };
    const aimY = target.position.y + 0.5;
    let tt = 0, miss = Infinity;
    while (tt < 8) {
      const prevY = pos.y;
      B.stepBallistic(pos, vel, G, DT); tt += DT;
      if (prevY >= aimY && pos.y < aimY) {
        const tx = target.position.x + target.velocity.x * tt, tz = target.position.z + target.velocity.z * tt;
        miss = Math.hypot(pos.x - tx, pos.z - tz);
        break;
      }
    }
    if (miss <= 2.0) hits += 1; else misses.push(miss.toFixed(1));
  }
  expect('>= 95% of shots land within 2 m of the moving target\'s centre', hits / N >= 0.95,
    `${hits}/${N}${misses.length ? `; misses ${misses.slice(0, 8).join(', ')} m` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. Grazing skip (physics-07)');
{
  // Start 0.15 m above the live sea so the ball meets it at (about) its launch angle.
  const T0 = 10;
  const run = (deg, speed) => {
    const a = deg * Math.PI / 180;
    const y0 = gerstnerHeight(0, 0, T0, WAVE_PARAMS, 0) + 0.15;
    const proj = { id: 's', type: 'cannonball', ownerId: 'x', ownerShipId: 'none', position: { x: 0, y: y0, z: 0 },
      velocity: { x: speed * Math.cos(a), y: -speed * Math.sin(a), z: 0 }, alive: true, age: 0, maxAge: 8, damage: 0,
      knockback: 0, visualOnly: false, showImpact: true };
    const physics = new PhysicsSystem();
    let skips = 0, prevVy = proj.velocity.y, entryX = null;
    for (let i = 0; i < 400 && proj.alive; i += 1) {
      physics.update(DT, T0 + i * DT, [], [], [proj], [], [], null);
      if (prevVy < 0 && proj.velocity.y > 0) { skips += 1; if (entryX === null) entryX = proj.position.x; }
      prevVy = proj.velocity.y;
    }
    return { skips, entryX, endX: proj.position.x };
  };
  const skip = run(3, 55);
  const plunge = run(20, 55);
  expect('a 3 deg shot at 55 m/s skips and flies >= 20 m past the first sea contact',
    skip.skips >= 1 && skip.skips <= 2 && skip.endX - skip.entryX >= 20,
    `skips ${skip.skips}, first contact ${skip.entryX?.toFixed(1)} m, ended ${skip.endX.toFixed(1)} m`);
  expect('a 20 deg shot goes straight in (no skip)', plunge.skips === 0 && plunge.endX < 3, `${plunge.skips} skips, ended ${plunge.endX.toFixed(1)} m`);
  const v = { x: 30, y: -1, z: 0 };
  expect('a slow ball (<= 25 m/s) does not skip', B.trySkip({ x: 20, y: -1, z: 0 }, 0) === false);
  expect('at most 2 skips', B.trySkip(v, 2) === false);
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ test-ballistics: all checks passed');
process.exit(failures ? 1 : 0);
