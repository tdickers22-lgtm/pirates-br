#!/usr/bin/env node
// THE OPENING IS SUPPOSED TO BE QUIET.
//
// BOT_EARLY_PEACE_SECONDS exists so the first two and a half minutes are
// sailing, looting and finding your feet — the storm arc needs a lobby that is
// still alive when the first ring closes. The governor gated who bots SEEK, but
// never who they SHOOT: any hull loss counted as "under fire", so a bot that
// scraped a reef went hunting, and its broadside made the next crew "under
// fire" too. Cannon breaches were landing at t=78 s and t=120 s.
//
// Two halves:
//   DETERMINISTIC — two hulls parked in broadside range, provoked by a reef and
//     then by real powder, driven straight through BotSystem.update.
//   THE WHOLE LOBBY — a real 9-bot Match sailed past the window with
//     PhysicsSystem.openHoleAt and WeaponSystem.tryFire hooked.
import { Match } from '../src/server/core/Match.ts';
import { BOT_EARLY_PEACE_SECONDS, SERVER_TICK_MS } from '../src/shared/constants/index.ts';
import { botMayFireCannons } from '../src/server/systems/BotSystem.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

// ── The gate itself ────────────────────────────────────────────────────────
console.log('The gunnery gate');
expect('inside the window an unprovoked bot holds fire', botMayFireCannons(10, 0) === false);
expect('inside the window a bot that was shot may answer', botMayFireCannons(10, 20) === true);
expect('after the window every bot is free to fire',
  botMayFireCannons(BOT_EARLY_PEACE_SECONDS + 1, 0) === true);

// ── Deterministic: one reef scrape must not start a war ────────────────────
console.log('\nA reef is not an act of war');

/** Park two bot hulls in broadside range and run only the bot brain, at an
 *  arbitrary sim clock. Returns how many cannon shots the pair fired. */
function sailPair({ atTime, seconds, provoke }) {
  const match = new Match({ matchId: `peace-pair-${atTime}-${provoke}`, botCount: 2 });
  const state = match.state;
  state.phase = 'playing';
  const [a, b] = state.ships;
  const physics = match.physics;
  const weapons = match.weapons;

  // Broadside range, hove to: nothing to do but decide whether to shoot. Both
  // stay on a's spawn water (open sea, clear line of fire, no island in the way).
  const pinPair = () => {
    b.position.x = a.position.x + 95;
    b.position.z = a.position.z;
    for (const ship of [a, b]) {
      ship.position.y = 0;
      ship.velocity = { x: 0, y: 0, z: 0 };
      ship.anchored = false;
      ship.sailHeight = 0;
    }
  };
  b.rotation = a.rotation;
  pinPair();
  // Storm centred on them so nobody flees the ring instead of deciding.
  state.storm.centerX = a.position.x + 47; state.storm.centerZ = a.position.z;
  state.storm.safeRadius = 2000; state.storm.shrinking = false; state.storm.phase = 0;

  if (provoke) physics.openHoleAt(a, { x: 1.2, y: 0.1, z: 2 }, 3, provoke);

  let shots = 0;
  const realTryFire = weapons.tryFire.bind(weapons);
  weapons.tryFire = (player, ship, yaw, pitch, cannonIndex, options) => {
    const before = ship?.cannonCooldowns?.[cannonIndex] ?? 0;
    const trace = realTryFire(player, ship, yaw, pitch, cannonIndex, options);
    if (ship && ship.cannonCooldowns[cannonIndex] !== before) shots += 1;
    return trace;
  };

  for (let i = 0; i < Math.ceil(seconds / dt); i += 1) {
    const t = atTime + i * dt;
    pinPair();
    match.bots.update(dt, t, state.players, state.ships, state.islands, state.storm, weapons, state.seaRocks);
    for (const cooldowns of [a.cannonCooldowns, b.cannonCooldowns]) {
      for (let c = 0; c < cooldowns.length; c += 1) cooldowns[c] = Math.max(0, cooldowns[c] - dt);
    }
  }
  return shots;
}

const groundShots = sailPair({ atTime: 40, seconds: 60, provoke: 'ground' });
expect('a grounded bot does not open fire on its neighbour during the peace',
  groundShots === 0, `shots=${groundShots}`);

const cannonShots = sailPair({ atTime: 40, seconds: 60, provoke: 'cannon' });
expect('a bot that took a cannonball DOES answer during the peace',
  cannonShots > 0, `shots=${cannonShots}`);

const quietShots = sailPair({ atTime: 40, seconds: 60, provoke: null });
expect('two untouched bots in broadside range hold fire during the peace',
  quietShots === 0, `shots=${quietShots}`);

const afterShots = sailPair({ atTime: BOT_EARLY_PEACE_SECONDS + 5, seconds: 60, provoke: null });
expect('the same two bots fight once the window lifts', afterShots > 0, `shots=${afterShots}`);

// ── The whole lobby, sailed past the window ────────────────────────────────
const match = new Match({ matchId: 'bot-peace-window', botCount: 9 });
const state = match.state;
state.phase = 'playing';

const breaches = [];
const physics = match.physics;
const realOpenHoleAt = physics.openHoleAt.bind(physics);
physics.openHoleAt = (ship, local, count = 1, source) => {
  // riddleWreck stamps 'cannon' holes all over a FOUNDERING hull for the wreck
  // look — cosmetic, not gunnery. Record whether she was already going down.
  breaches.push({ t: match.t, source: source ?? 'unknown', sinking: !!ship.sinking || !ship.alive });
  return realOpenHoleAt(ship, local, count, source);
};

const shots = [];
const weapons = match.weapons;
const realTryFire = weapons.tryFire.bind(weapons);
weapons.tryFire = (player, ship, yaw, pitch, cannonIndex, options) => {
  const before = ship?.cannonCooldowns?.[cannonIndex] ?? 0;
  const trace = realTryFire(player, ship, yaw, pitch, cannonIndex, options);
  if (ship && ship.cannonCooldowns[cannonIndex] !== before) shots.push({ t: match.t });
  return trace;
};

const RUN_SECONDS = BOT_EARLY_PEACE_SECONDS + 45;
console.log(`\nSailing ${state.ships.length} bot crews for ${RUN_SECONDS}s…`);
for (let i = 0; i < Math.ceil(RUN_SECONDS / dt); i += 1) match.tick();

const early = (list) => list.filter((e) => e.t < BOT_EARLY_PEACE_SECONDS);
const earlyGunnery = early(breaches).filter((b) => b.source === 'cannon' && !b.sinking);
const earlyShots = early(shots);
const lateShots = shots.filter((e) => e.t >= BOT_EARLY_PEACE_SECONDS);
const sources = early(breaches).reduce((acc, b) => {
  const key = b.sinking ? `${b.source}/wreck` : b.source;
  acc[key] = (acc[key] ?? 0) + 1; return acc;
}, {});
console.log(`Breaches before the window lifts: ${JSON.stringify(sources)}`);
console.log(`Cannon shots: ${earlyShots.length} early / ${lateShots.length} late`);

console.log('\nThe early-peace window (9 crews, no humans)');
expect('no gunnery breach lands before the peace window lifts', earlyGunnery.length === 0,
  earlyGunnery.length ? `first at t=${earlyGunnery[0].t.toFixed(1)}s` : '');
expect('not one bot cannon speaks during the peace', earlyShots.length === 0,
  earlyShots.length ? `${earlyShots.length} shots, first t=${earlyShots[0].t.toFixed(1)}s` : '');
expect('the sim really ran past the window', match.t > BOT_EARLY_PEACE_SECONDS,
  `t=${match.t.toFixed(1)}s`);
expect('the lobby is still afloat when the peace lifts',
  state.ships.filter((s) => s.alive && !s.sinking).length >= 7,
  `afloat=${state.ships.filter((s) => s.alive && !s.sinking).length}`);
// The lobby run is unseeded (map + bot rolls), so post-peace contact inside 45 s
// is likely but not guaranteed — the deterministic pair above is what PINS the
// "guns come back" half of the contract. This line is a live sanity read.
console.log(lateShots.length > 0
  ? `  · the fleet opened fire ${lateShots.length}× after the window lifted`
  : '  · no contact after the window in this run (pair test pins the reopening)');

if (failures > 0) {
  console.error(`\n${failures} bot-peace assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll bot early-peace assertions passed.');
