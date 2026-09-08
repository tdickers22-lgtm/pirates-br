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
import { shouldDrawStrike } from '../src/client/rendering/stormWeather.ts';
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

// ── NO BOLT FALLS OUT OF A CLEAR SKY (review-8 P1) ──────────────────────────
//
// The roll used to start at t=0 with no phase gate at all, so the first strike
// of every match landed ~4 s in, just outside the opening 950 m circle, while
// the whole fleet was still in fair weather looting the middle of the map — and
// the client drew it, with its flash light and its thunder, because the guard
// that used to hold the bolt until phase 2 was deleted along with the local
// roll. The storm rolls nothing before it is a storm.
console.log('\nNo bolt falls before the storm is a storm');
{
  for (const phase of [0, 1]) {
    const { strikes } = run(600, 20260801, stormAt(950 - phase * 125, phase), [], []);
    expect(`phase ${phase} (fair weather over the ring) rolls 0 bolts`,
      strikes.length === 0, `${strikes.length} strikes at phase ${phase}`);
  }
  const { strikes } = run(600, 20260801, stormAt(825, STORM_LIGHTNING.MIN_PHASE), [], []);
  expect(`phase ${STORM_LIGHTNING.MIN_PHASE} (the sky the bolts belong to) still rolls them`,
    strikes.length >= 1, `${strikes.length} strikes`);
  // And the wait starts when the weather does: the held timer must not dump a
  // backlog of bolts the instant the phase flips.
  expect('the first bolt of the storm arrives no sooner than one INTERVAL_MIN in',
    strikes[0].t >= STORM_LIGHTNING.INTERVAL_MIN
      - STORM_LIGHTNING.INTERVAL_PER_PHASE * STORM_LIGHTNING.MIN_PHASE - DT,
    `first strike at t=${strikes[0].t.toFixed(2)}`);
}

console.log('\nNothing strikes inside the circle the game calls shelter');
{
  let inside = 0, total = 0, minBand = Infinity, maxBand = 0;
  for (const [radius, phase] of [[900, 2], [520, 3], [300, 4], [120, 6]]) {
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

// ── THE SECOND MATCH OF A SESSION GETS A SKY TOO (review-8 P1) ──────────────
//
// EnvironmentFx is built once per Game and survives "Play Again"; `strike.t` is
// Match.t, which every match counts from 0. The draw guard was `newest.t >
// lastDrawnStrikeT`, so after a 400 s match nothing under t=400 was ever drawn
// again: the entire storm arc of match two, and of every match after it, was
// silently refused. This replays two matches through ONE guard state.
console.log('\nOne sky per match, not one per session');
{
  const drawnIn = (strikes, state) => {
    let drawn = 0;
    for (const s of strikes) {
      if (shouldDrawStrike(s.t, state.last)) { drawn += 1; state.last = s.t; }
      else state.last = Math.max(state.last, s.t);
    }
    return drawn;
  };
  const first = run(420, 20260801, stormAt(300, 4), [], []).strikes;
  const second = run(420, 90210, stormAt(300, 4), [], []).strikes;
  expect('both matches roll bolts at all (the fixture is real)',
    first.length > 3 && second.length > 3, `${first.length} then ${second.length}`);

  const session = { last: -1 };
  const drawnFirst = drawnIn(first, session);
  // What "Play Again" does NOT do for us: no reset call here on purpose, so the
  // guard alone has to survive the clock going back to 0.
  const drawnSecond = drawnIn(second, session);
  expect('every bolt of match one is drawn',
    drawnFirst === first.length, `${drawnFirst}/${first.length}`);
  expect('every bolt of match two is drawn as well, with no reset in between',
    drawnSecond === second.length, `${drawnSecond}/${second.length} after a ${first.at(-1).t.toFixed(0)} s match`);

  const withReset = { last: -1 };
  drawnIn(first, withReset);
  withReset.last = -1; // EnvironmentFx.resetStrikeStateForMatch()
  expect('and the explicit per-match reset agrees with it',
    drawnIn(second, withReset) === second.length);
  // The guard still refuses a repeat: the newest entry of the ring buffer sits
  // there for every frame until the next bolt is rolled, and it is one flash.
  const held = { last: -1 };
  drawnIn(first, held);
  expect('but the newest bolt, held on the wire between strikes, is drawn once',
    drawnIn(new Array(30).fill(first.at(-1)), held) === 0,
    'the same strike fired again on later frames');
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

// The swimmer case storm-04 proposed (60 hp within 6 m of an open-water bolt)
// is NOT built: measured, it downed a crew at 11 s with the hull barely
// scratched, which re-opens the STORM-01 defect the storm's damage model was
// moved off. See the note in StormSystem.rollLightning. The bolt bills hulls.
{
  // Put one pirate exactly under the first open-water bolt and another the same
  // distance out on the far side, so the ordinary storm DoT is identical and
  // only the bolt could separate them.
  const probe = run(600, 5150, stormAt(300, 4), [], []);
  const open = probe.strikes.find((s) => s.shipId === null);
  const under = swimmer('under', open.x, open.z);
  const away = swimmer('away', -open.x, -open.z);
  const { strikes } = run(600, 5150, stormAt(300, 4), [], [under, away]);
  expect('the bolt itself never bills a pirate: hulls take the lightning',
    Math.abs(under.health - away.health) < 1e-6 && strikes.length > 0,
    `under ${under.health.toFixed(1)} vs away ${away.health.toFixed(1)} after ${strikes.length} strikes`);
}

console.log(failures === 0
  ? '\nAll storm-lightning checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
