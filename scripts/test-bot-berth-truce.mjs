#!/usr/bin/env node
// THE CLOCK IS NOT THE PEACE; LEAVING THE BERTH IS (liveplay-19).
//
// BOT_EARLY_PEACE_SECONDS (150) is a bare wall clock. In liveplay run 5 the
// human found the helm at 90 s and never the cannon; a bot sloop 80 m off the
// spawn dock opened fire the moment the clock lifted and holed the still-
// anchored hull fifteen times by 390 s. Nothing on the HUD said who.
//
// Contract: a hull ANCHORED within BOT_BERTH_TRUCE_RADIUS of a dock berth is
// off-limits to every bot cannon until BOT_BERTH_TRUCE_SECONDS (270 s), and a
// bot does not even SEEK her — unless she shoots first, in which case the bot
// answers inside the truce like any other provocation. After the truce lifts
// the same moored hull is fair game (which is also the proof the harness can
// fire at her at all).
//
// Deterministic: seeded 2-bot match, only the bot brain running. Hull B is
// moored at a real dock berth with its bot deregistered (an unmanned hull is
// "a learner who never touched the helm"); hull A is a bot pinned 100 m
// offshore with B square on its broadside.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
import { Match } from '../src/server/core/Match.ts';
import { BOT_EARLY_PEACE_SECONDS, SERVER_TICK_MS } from '../src/shared/constants/index.ts';
import { botMayFireCannons, isMooredAtBerth, BOT_BERTH_TRUCE_SECONDS } from '../src/server/systems/BotSystem.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const dt = SERVER_TICK_MS / 1000;

// ── The predicate itself ───────────────────────────────────────────────────
console.log('The berth-truce predicate');
{
  const islands = [{ position: { x: 0, y: 0, z: 0 }, dock: { berthPosition: { x: 100, y: 0, z: 0 } } }];
  const moored = { id: 'm', anchored: true, position: { x: 120, y: 0, z: 10 } };
  const sailing = { id: 's', anchored: false, position: { x: 120, y: 0, z: 10 } };
  const far = { id: 'f', anchored: true, position: { x: 400, y: 0, z: 0 } };
  expect('anchored 22 m off the berth is moored', isMooredAtBerth(moored, islands) === true);
  expect('the same spot with the anchor up is not', isMooredAtBerth(sailing, islands) === false);
  expect('anchored 300 m away is not', isMooredAtBerth(far, islands) === false);
  expect('after the lobby peace but inside the berth truce a moored hull is spared',
    botMayFireCannons(BOT_EARLY_PEACE_SECONDS + 10, 0, moored, islands) === false);
  expect('a sailing hull at the same clock is not', botMayFireCannons(BOT_EARLY_PEACE_SECONDS + 10, 0, sailing, islands) === true);
  expect('a moored hull that shot us is answered', botMayFireCannons(BOT_EARLY_PEACE_SECONDS + 10, 9999, moored, islands) === true);
  expect('but not when the shooter was somebody else',
    botMayFireCannons(BOT_EARLY_PEACE_SECONDS + 10, 9999, moored, islands, 'other-ship') === false);
  expect('the truce lifts at BOT_BERTH_TRUCE_SECONDS', botMayFireCannons(BOT_BERTH_TRUCE_SECONDS, 0, moored, islands) === true);
  expect('two-argument callers keep the old clock', botMayFireCannons(10, 0) === false && botMayFireCannons(200, 0) === true);
}

// ── The sim: a moored learner and a bot sloop 100 m off ────────────────────
/** Bot A pinned 100 m offshore of a dock berth where unmanned hull B lies
 *  anchored. Returns A's cannon shots by time. */
function sailBerth({ seconds, provokeAt = null }) {
  const match = new Match({ matchId: `berth-truce-${provokeAt}`, botCount: 2 });
  const state = match.state;
  state.phase = 'playing';
  const [a, b] = state.ships;
  const pirateB = state.players.find((p) => p.shipId === b.id);
  const weapons = match.weapons;

  // The dock whose berth has the most open water to seaward.
  let best = null;
  for (const island of state.islands) {
    const dock = island.dock;
    if (!dock) continue;
    const ox = dock.berthPosition.x - island.position.x;
    const oz = dock.berthPosition.z - island.position.z;
    const len = Math.hypot(ox, oz) || 1;
    const off = { x: ox / len, z: oz / len };
    const probe = { x: dock.berthPosition.x + off.x * 100, z: dock.berthPosition.z + off.z * 100 };
    let clear = Infinity;
    for (const other of state.islands) {
      clear = Math.min(clear, Math.hypot(other.position.x - probe.x, other.position.z - probe.z) - (other.radius ?? 0));
    }
    for (const rock of state.seaRocks ?? []) {
      clear = Math.min(clear, Math.hypot(rock.position.x - probe.x, rock.position.z - probe.z) - (rock.radius ?? 0));
    }
    if (!best || clear > best.clear) best = { dock, off, clear };
  }
  if (!best) throw new Error('no dock in the fixed world');
  const { dock, off } = best;

  // B: moored at the berth, unmanned (her bot leaves the brain).
  match.bots.bots.delete(pirateB.id);
  const pinB = () => {
    b.position.x = dock.berthPosition.x; b.position.z = dock.berthPosition.z; b.position.y = 0;
    b.rotation = dock.berthRotation; b.velocity = { x: 0, y: 0, z: 0 }; b.sailHeight = 0; b.anchored = true;
  };
  // A: 100 m to seaward, heading perpendicular so B is square on a broadside.
  const heading = Math.atan2(off.x, off.z) + Math.PI / 2;
  const pinA = () => {
    a.position.x = dock.berthPosition.x + off.x * 100; a.position.z = dock.berthPosition.z + off.z * 100; a.position.y = 0;
    a.rotation = heading; a.velocity = { x: 0, y: 0, z: 0 }; a.sailHeight = 0; a.anchored = false;
  };
  pinA(); pinB();
  state.storm.centerX = a.position.x; state.storm.centerZ = a.position.z;
  state.storm.safeRadius = 2000; state.storm.shrinking = false; state.storm.phase = 0;

  const shots = [];
  const realTryFire = weapons.tryFire.bind(weapons);
  weapons.tryFire = (player, ship, yaw, pitch, cannonIndex, options) => {
    const before = ship?.cannonCooldowns?.[cannonIndex] ?? 0;
    const trace = realTryFire(player, ship, yaw, pitch, cannonIndex, options);
    if (ship === a && ship.cannonCooldowns[cannonIndex] !== before) shots.push(t);
    return trace;
  };

  let t = 0;
  let provoked = false;
  for (let i = 0; i < Math.ceil(seconds / dt); i += 1) {
    t = i * dt;
    pinA(); pinB();
    if (provokeAt !== null && !provoked && t >= provokeAt) {
      // The moored hull fires first: a cannon hole in A (Match's projectile
      // pass opens exactly this; the shooter's identity is slice d's business).
      match.physics.openHoleAt(a, { x: 1.2, y: 0.1, z: 2 }, 2, 'cannon');
      provoked = true;
    }
    match.bots.update(dt, t, state.players, state.ships, state.islands, state.storm, weapons, state.seaRocks);
    for (let c = 0; c < a.cannonCooldowns.length; c += 1) a.cannonCooldowns[c] = Math.max(0, a.cannonCooldowns[c] - dt);
  }
  return { shots, behaviorA: match.bots.bots.get(state.players.find((p) => p.shipId === a.id).id).behavior };
}

console.log(`\nA learner moored at the berth, a bot sloop 100 m off, ${BOT_BERTH_TRUCE_SECONDS + 130} s`);
const quiet = sailBerth({ seconds: BOT_BERTH_TRUCE_SECONDS + 130 });
const duringTruce = quiet.shots.filter((s) => s < BOT_BERTH_TRUCE_SECONDS);
const afterTruce = quiet.shots.filter((s) => s >= BOT_BERTH_TRUCE_SECONDS);
console.log(`  · shots at the moored hull: ${duringTruce.length} inside the truce, ${afterTruce.length} after (first ${quiet.shots.length ? quiet.shots[0].toFixed(1) + ' s' : 'never'})`);
expect(`not one cannon shot at the moored hull before ${BOT_BERTH_TRUCE_SECONDS} s`, duringTruce.length === 0,
  duringTruce.length ? `${duringTruce.length} shots, first at ${duringTruce[0].toFixed(1)} s (lobby peace lifts at ${BOT_EARLY_PEACE_SECONDS} s)` : '');
expect('once the truce lifts the moored hull is fair game (the harness can fire)', afterTruce.length > 0,
  `shots after ${BOT_BERTH_TRUCE_SECONDS} s = ${afterTruce.length}, behaviour=${quiet.behaviorA}`);

console.log('\nThe moored hull shoots first at 60 s');
const answered = sailBerth({ seconds: 120, provokeAt: 60 });
console.log(`  · shots: ${answered.shots.length} (first ${answered.shots.length ? answered.shots[0].toFixed(1) + ' s' : 'never'})`);
expect('a moored hull that opens fire is answered inside the truce', answered.shots.some((s) => s < BOT_EARLY_PEACE_SECONDS),
  `shots=${answered.shots.length}`);
expect('and never before she fired', answered.shots.every((s) => s >= 60), answered.shots.length ? `first at ${answered.shots[0].toFixed(1)} s` : '');

if (failures > 0) {
  console.error(`\n${failures} berth-truce assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll berth-truce assertions passed.');
