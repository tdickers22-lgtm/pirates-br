#!/usr/bin/env node
// THE LIGHTNING BELONGS TO THE SERVER (STORMUP-01 / storm-04).
//
// It used to be `Math.random` inside EnvironmentFx. Three things followed, and
// this suite is the three:
//
//   1. NOBODY SAW THE SAME SKY. Every client rolled its own timer, its own
//      angle, its own distance, so thunder, sky flash and sea glint were
//      private. The bolts are now rolled once, off the match-seeded stream,
//      into a replicated ring buffer — two runs of the same seed are identical.
//   2. A THIRD OF THE BOLTS CONTRADICTED THE RING. The old radius was
//      stormR * (0.88 + rand * 0.38), so 0.12/0.38 = 32 % of strikes fell
//      INSIDE the safe circle the whole game tells you is shelter. The band is
//      now [1.02, 1.35] and nothing lands in the eye.
//   3. NO BOLT COULD HIT ANYTHING. The mainmast is the conductor now: a hull in
//      the weather takes a hole at the mast step and burns — unless she bought
//      the lightning rod, which is the first thing in the game that makes the
//      storm a place a prepared crew CHOOSES to go.
//
//   node --import tsx scripts/test-storm-lightning.mjs
import { StormSystem } from '../src/server/systems/StormSystem.ts';
import {
  PLAYER,
  SERVER_TICK_MS,
  STORM_LIGHTNING,
  STORM_PHASES,
} from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
/** The match-seeded stream, in miniature (RNG-01's mulberry32). */
const seeded = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const stormAt = (radius, phase) => ({
  phase, centerX: 0, centerZ: 0, nextCenterX: 0, nextCenterZ: 0,
  shrinkStartCenterX: 0, shrinkStartCenterZ: 0, shrinkStartRadius: radius,
  safeRadius: radius, nextRadius: radius, shrinking: false, shrinkTimer: 9000,
  shrinkDuration: 1, shrinkProgress: 0, damagePerSec: STORM_PHASES[phase].dmgPerSec,
  eyeCollapse: 0, strikes: [],
});
const hull = (id, type, x, z, upgrades = []) => ({
  id, type, alive: true, sinking: false, rotation: 0, position: { x, y: 0, z },
  upgrades, onFire: false, fireTimer: 0,
});
const swimmer = (id, x, z) => ({
  id, state: 'alive', health: PLAYER.MAX_HEALTH, respawnProtectionTimer: 0,
  onShipId: null, position: { x, y: 0, z }, lastEnvDamage: null,
});

/** One seeded storm run. Returns every strike the ring buffer ever held and
 *  every hole the storm asked PhysicsSystem to stove, with its local point. */
function run(seconds, seed, storm, ships, players) {
  const system = new StormSystem(seeded(seed));
  const holes = [];
  const strikes = [];
  const hooks = { openHoleAt: (ship, local, count) => holes.push({ ship: ship.id, local, count }) };
  let deepest = 0;
  for (let i = 0; i < Math.ceil(seconds / DT); i++) {
    system.update(DT, storm, ships, players, hooks, i * DT);
    deepest = Math.max(deepest, storm.strikes.length);
    while (strikes.length < storm.strikes.length
      || (storm.strikes.length > 0 && (strikes.at(-1)?.t ?? -1) < storm.strikes.at(-1).t)) {
      const newest = storm.strikes.at(-1);
      if ((strikes.at(-1)?.t ?? -1) >= newest.t) break;
      strikes.push({ ...newest });
    }
  }
  return { strikes, holes, deepest };
}

console.log('\nOne sky, rolled once, replicated');
{
  const a = run(600, 20260801, stormAt(300, 3), [], []);
  const b = run(600, 20260801, stormAt(300, 3), [], []);
  const c = run(600, 90210, stormAt(300, 3), [], []);
  expect('600 s of storm produces bolts at all',
    a.strikes.length >= 1, `${a.strikes.length} strikes`);
  expect('two clients of the same seeded match receive an IDENTICAL strikes[]',
    a.strikes.length === b.strikes.length
    && a.strikes.every((s, i) => s.t === b.strikes[i].t && s.x === b.strikes[i].x && s.z === b.strikes[i].z),
    `${a.strikes.length} vs ${b.strikes.length} strikes`);
  expect('a different seed gets a different sky (the stream is real, not a constant)',
    a.strikes.some((s, i) => c.strikes[i] === undefined || s.x !== c.strikes[i].x));
  expect(`the wire carries at most ${STORM_LIGHTNING.MAX_REPLICATED} bolts at a time`,
    a.deepest <= STORM_LIGHTNING.MAX_REPLICATED && a.deepest >= 2,
    `deepest ring buffer ${a.deepest}`);
}

console.log('\nNothing strikes inside the circle the game calls shelter');
{
  let inside = 0, total = 0, minBand = Infinity, maxBand = 0;
  for (const [radius, phase] of [[900, 0], [520, 2], [300, 4], [120, 6]]) {
    const { strikes } = run(600, 1234 + phase, stormAt(radius, phase), [], []);
    for (const s of strikes) {
      const band = Math.hypot(s.x, s.z) / radius;
      minBand = Math.min(minBand, band);
      maxBand = Math.max(maxBand, band);
      if (band < 1) inside += 1;
      total += 1;
    }
  }
  expect(`0 of ${total} bolts land inside the safe ring`,
    inside === 0, `${inside} inside (${((inside / total) * 100).toFixed(1)}%)`);
  expect('every bolt falls in the declared band [1.02, 1.35] x safeRadius',
    minBand >= STORM_LIGHTNING.BAND_MIN - 1e-9
    && maxBand <= STORM_LIGHTNING.BAND_MIN + STORM_LIGHTNING.BAND_RANGE + 1e-9,
    `band ${minBand.toFixed(3)} .. ${maxBand.toFixed(3)}`);
}

console.log('\nThe mainmast is the conductor');
const MAST_RUNS = [20260801, 4242, 777, 31337];
{
  // A hull hove to just outside a phase-4 wall, for the ten minutes storm-04
  // names. Sea-stove holes land on the seaward FACE; the mast strike lands on
  // the centreline at the step, which is how the two are told apart.
  let mastHoles = 0, ownedStrikes = 0, caughtFire = false, seed = 0;
  for (const s of MAST_RUNS) {
    const storm = stormAt(300, 4);
    const ship = hull('conductor', 'sloop', 0, 316);
    const { holes, strikes } = run(600, s, storm, [ship], []);
    const mast = holes.filter((h) => h.local.x === 0);
    if (mast.length > 0) { mastHoles += mast.length; caughtFire ||= ship.onFire || ship.fireTimer > 0; seed = s; }
    ownedStrikes += strikes.filter((k) => k.shipId === 'conductor').length;
  }
  expect('a hull left in the weather for 600 s takes a "storm" hole AT HER MAST',
    mastHoles >= 1, `${mastHoles} mast holes across ${MAST_RUNS.length} seeds`);
  expect('and the bolt that did it is on the wire, naming the hull it ran down',
    ownedStrikes >= 1, `${ownedStrikes} strikes carrying a shipId`);
  expect('and her mast is alight afterwards',
    caughtFire, `seed ${seed}`);
}
{
  // The rod: same seeds, same hull, same weather, one purchase.
  let rodMastHoles = 0, groundedStrikes = 0, rodFire = false;
  for (const s of MAST_RUNS) {
    const storm = stormAt(300, 4);
    const ship = hull('rodded', 'sloop', 0, 316, [{ type: 'lightning_rod' }]);
    const { holes, strikes } = run(600, s, storm, [ship], []);
    rodMastHoles += holes.filter((h) => h.local.x === 0).length;
    rodFire ||= ship.onFire || ship.fireTimer > 0;
    groundedStrikes += strikes.filter((k) => k.shipId === 'rodded' && k.grounded).length;
  }
  expect('a hull carrying the lightning rod takes 0 mast holes and never catches',
    rodMastHoles === 0 && !rodFire, `${rodMastHoles} mast holes, onFire ${rodFire}`);
  expect('but the bolt still falls, still on the wire, marked grounded (the client draws it)',
    groundedStrikes >= 1, `${groundedStrikes} grounded strikes`);
}

console.log('\nA swimmer under the bolt');
{
  // Find a bolt that hit open water, then put a pirate exactly under it. The
  // control swims the same radius on the far side, so the ordinary storm DoT
  // is identical and only the strike can separate them.
  const probe = run(600, 5150, stormAt(300, 4), [], []);
  const open = probe.strikes.find((s) => s.shipId === null);
  const storm = stormAt(300, 4);
  const struck = swimmer('struck', open.x, open.z);
  const control = swimmer('control', -open.x, -open.z);
  run(600, 5150, storm, [], [struck, control]);
  const extra = control.health - struck.health;
  expect('a pirate in the water under the strike takes the charge',
    extra >= STORM_LIGHTNING.SWIMMER_DAMAGE - 1e-6,
    `struck ${struck.health.toFixed(1)} vs control ${control.health.toFixed(1)} (delta ${extra.toFixed(1)})`);
}

console.log(failures === 0
  ? '\nAll storm-lightning checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
