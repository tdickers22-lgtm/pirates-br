#!/usr/bin/env node
// Lifetime stats pipeline, unit + end-to-end against the real Match:
//   1. StatsStore: legacy records (pre-stats-panel JSON) zero-fill the new
//      fields; applyMatchResult sums counters, min-merges bestPlacement and
//      max-merges bestKillStreak / bestMatchGold; records survive a reload
//   2. Match: a melee duel accumulates damageDealt swing-by-swing and the kill
//      path stamps bestKillStreak; the real axe-harvest path accumulates
//      woodChopped; the match-end result carries all deltas on MatchHumanResult
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StatsStore } from '../src/server/core/StatsStore.ts';
import { Match } from '../src/server/core/Match.ts';
import { WEAPONS, HARVEST } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const NEW_FIELDS = [
  'bestPlacement', 'shipsSunk', 'chestsSold', 'chestsDug', 'sharksKilled',
  'skeletonsKilled', 'bestKillStreak', 'bestMatchGold', 'woodChopped',
  'oreMined', 'damageDealt', 'headshots', 'playSeconds',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statsPath = join(root, 'test-results', `stats-test-${Math.random().toString(36).slice(2, 8)}.json`);
mkdirSync(dirname(statsPath), { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
console.log('1. Legacy record (old 6-field JSON) loads with new fields zeroed');

writeFileSync(statsPath, JSON.stringify({
  version: 1,
  players: {
    olddog: { name: 'OldDog', kills: 5, deaths: 3, wins: 1, matchesPlayed: 4, totalGold: 900 },
  },
}, null, 2), 'utf8');

const store = new StatsStore(statsPath);
{
  const rec = store.get('OldDog');
  expect('legacy record found by name', !!rec);
  expect('old fields preserved',
    rec.kills === 5 && rec.deaths === 3 && rec.wins === 1 && rec.matchesPlayed === 4 && rec.totalGold === 900,
    JSON.stringify(rec));
  const nonZero = NEW_FIELDS.filter((f) => rec[f] !== 0);
  expect('every new field zero-filled', nonZero.length === 0, `non-zero: ${nonZero.join(', ')}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. applyMatchResult sums counters and merges the bests');

{
  const rec = store.applyMatchResult({
    name: 'OldDog', kills: 2, deaths: 1, gold: 350, placement: 3, isWinner: false,
    shipsSunk: 1, chestsSold: 2, chestsDug: 1, sharksKilled: 1, skeletonsKilled: 4,
    bestKillStreak: 3, woodChopped: 7, oreMined: 5, damageDealt: 412.4, headshots: 2,
    playSeconds: 301.6,
  });
  expect('counters sum onto legacy totals',
    rec.kills === 7 && rec.deaths === 4 && rec.totalGold === 1250 && rec.matchesPlayed === 5 && rec.wins === 1,
    JSON.stringify(rec));
  expect('new counters accumulate',
    rec.shipsSunk === 1 && rec.chestsSold === 2 && rec.chestsDug === 1
      && rec.sharksKilled === 1 && rec.skeletonsKilled === 4
      && rec.woodChopped === 7 && rec.oreMined === 5 && rec.headshots === 2,
    JSON.stringify(rec));
  expect('damageDealt and playSeconds round to integers',
    rec.damageDealt === 412 && rec.playSeconds === 302,
    `damageDealt=${rec.damageDealt} playSeconds=${rec.playSeconds}`);
  expect('first placement/streak/matchGold seed the bests',
    rec.bestPlacement === 3 && rec.bestKillStreak === 3 && rec.bestMatchGold === 350,
    JSON.stringify(rec));

  // A worse match must not regress any best.
  const rec2 = store.applyMatchResult({
    name: 'OldDog', kills: 0, deaths: 2, gold: 120, placement: 5, isWinner: true,
    bestKillStreak: 1, damageDealt: 10, playSeconds: 60,
  });
  expect('win increments wins + matchesPlayed', rec2.wins === 2 && rec2.matchesPlayed === 6,
    `wins=${rec2.wins} matches=${rec2.matchesPlayed}`);
  expect('worse placement does not regress bestPlacement (min-wins)',
    rec2.bestPlacement === 3, `bestPlacement=${rec2.bestPlacement}`);
  expect('lower streak / gold keep the maxes',
    rec2.bestKillStreak === 3 && rec2.bestMatchGold === 350,
    `streak=${rec2.bestKillStreak} matchGold=${rec2.bestMatchGold}`);

  // A better match improves them.
  const rec3 = store.applyMatchResult({
    name: 'OldDog', kills: 6, deaths: 0, gold: 999, placement: 1, isWinner: true,
    bestKillStreak: 9,
  });
  expect('better placement/streak/matchGold overwrite the bests',
    rec3.bestPlacement === 1 && rec3.bestKillStreak === 9 && rec3.bestMatchGold === 999,
    JSON.stringify(rec3));

  // Fresh player edge cases: placement 0 (no placement) and negative playSeconds.
  const fresh = store.applyMatchResult({
    name: 'Newbie', kills: 0, deaths: 0, gold: 0, placement: 0, isWinner: false,
    playSeconds: -5,
  });
  expect('placement 0 leaves bestPlacement unset', fresh.bestPlacement === 0, `bestPlacement=${fresh.bestPlacement}`);
  expect('negative playSeconds clamps to 0', fresh.playSeconds === 0, `playSeconds=${fresh.playSeconds}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. flush() persists — a fresh store reloads the accumulated record');

{
  store.flush();
  const reloaded = new StatsStore(statsPath);
  const rec = reloaded.get('olddog'); // key is case-insensitive
  expect('reloaded record matches accumulated totals',
    !!rec && rec.kills === 13 && rec.matchesPlayed === 7 && rec.bestMatchGold === 999 && rec.bestKillStreak === 9,
    JSON.stringify(rec));
}
rmSync(statsPath, { force: true });
rmSync(statsPath + '.tmp', { force: true });

// ────────────────────────────────────────────────────────────────────────────
// Match e2e — same private-access style as test-block.mjs / test-harvest.mjs.
console.log('\n4. Melee duel accumulates damageDealt; the kill stamps bestKillStreak');

const DT = 1 / 60;
function makeFakeWs(sink = null) {
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send(data) { if (sink) sink.push(JSON.parse(data)); },
    close() {},
  };
}
function makeInput(seq, overrides = {}) {
  return {
    seq, ts: 0,
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, fire: false, useItem: false, aim: false,
    interact: false, interactHeld: false,
    anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
    trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
    slot: null, cannonAmmo: null, yaw: 0, pitch: 0,
    wheelIndex: null, useWheelItem: false, barrelTakeAll: false,
    interactIntent: null,
    ...overrides,
  };
}

const match = new Match({ matchId: `stats-${Math.random().toString(36).slice(2, 8)}`, botCount: 2 });
match.state.phase = 'playing';
const joined = match.addHumanClient(makeFakeWs(), 'StatHero');
const client = match.clients.get(joined.playerId);
const attacker = match.state.players.find((p) => p.id === joined.playerId);
const target = match.state.players.find((p) => p.isBot);
let seq = 1;

for (const p of [attacker, target]) {
  p.state = 'alive';
  p.health = 100;
  p.armor = 0;
  p.respawnProtectionTimer = 0;
  p.carryingChestId = null;
  p.onShipId = null;
  p.blocking = false;
  const slot = p.weapons.findIndex((w) => w && w.weaponId === 'cutlass');
  p.activeSlot = slot >= 0 ? slot : (p.weapons.push({ weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 }) - 1);
}
attacker.position = { x: 0, y: 0, z: 0 };
attacker.rotation.x = 0;
target.position = { x: 0, y: 0, z: 1.6 };

{
  const dmg = WEAPONS.cutlass.damage;
  match.performMeleeAttack(attacker, 0);
  const delta = match.statsDelta(attacker.id);
  expect('one swing accumulates exactly one swing of damageDealt',
    delta.damageDealt === dmg, `damageDealt=${delta.damageDealt}, swing=${dmg}`);
  expect('target health matches the accumulated damage',
    target.health === 100 - dmg, `health=${target.health}`);

  let swings = 1;
  while (target.health > 0 && swings < 40) {
    match.t += 0.4; // stay inside the kill-credit window, no melee cooldown to dodge
    match.performMeleeAttack(attacker, 0);
    swings += 1;
  }
  expect('duel drove the target to 0 hp', target.health <= 0, `health=${target.health} after ${swings} swings`);
  expect('damageDealt totals every swing (overkill included)',
    delta.damageDealt === swings * dmg, `damageDealt=${delta.damageDealt}, expected ${swings * dmg}`);

  // The per-tick death gate turns hp<=0 into the real kill-credit path.
  match.resolveHealthDeaths();
  expect('kill credited to the attacker', attacker.kills === 1, `kills=${attacker.kills}`);
  expect('solo-crew bot dies outright (respawning, not downed)',
    target.state === 'respawning' || target.state === 'eliminated', `state=${target.state}`);
  expect('cross-ship kill stamps bestKillStreak on the match delta',
    delta.bestKillStreak === 1, `bestKillStreak=${delta.bestKillStreak}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Real axe-harvest path accumulates woodChopped');

function frame(overrides) {
  match.t += 0.5;
  match.applyInput(client, makeInput(seq++, overrides), DT);
}

{
  let palmHit = null;
  for (const island of match.state.islands) {
    for (const prop of island.props ?? []) {
      if (prop.type.startsWith('palm_') && prop.type !== 'palm_ground' && prop.id !== undefined) {
        palmHit = { island, prop };
        break;
      }
    }
    if (palmHit) break;
  }
  expect('world has a standing palm to chop', !!palmHit);

  const { island, prop } = palmHit;
  attacker.state = 'alive';
  attacker.health = 100;
  attacker.onShipId = null;
  attacker.atCannon = false; attacker.atHelm = false; attacker.atSails = false; attacker.atCrowNest = false;
  attacker.mastClimb = null;
  attacker.carryingChestId = null;
  attacker.position = { x: prop.x + 1.2, y: getIslandSurfaceY(island, prop.x + 1.2, prop.z), z: prop.z };

  frame({ useWheelItem: true, wheelIndex: 9 });
  expect('wheel slot 9 equips the axe', attacker.equippedTool === 'axe', `tool=${attacker.equippedTool}`);

  const delta = match.statsDelta(attacker.id);
  const woodBefore = delta.woodChopped;
  const pocketBefore = attacker.pocketWood;
  const chopTicks = Math.ceil((HARVEST.CHOP_TIME + 0.1) / DT);
  for (let i = 0; i < chopTicks; i++) frame({ useItem: true });

  const gained = attacker.pocketWood - pocketBefore;
  expect('palm felled: pocket wood granted in the HARVEST band',
    gained >= HARVEST.WOOD_PER_TREE_MIN && gained <= HARVEST.WOOD_PER_TREE_MAX, `wood=${gained}`);
  expect('woodChopped delta accumulates the same yield',
    delta.woodChopped - woodBefore === gained,
    `delta ${woodBefore} → ${delta.woodChopped}, pocket gained ${gained}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n6. Match-end result carries the deltas on MatchHumanResult');

{
  const delta = match.statsDelta(attacker.id);
  let captured = null;
  match.onMatchEnd = (result) => { captured = result; };
  match.state.phase = 'ended';
  match.state.winnerId = attacker.id;
  match.emitMatchEnd();

  expect('match end emitted a result', !!captured);
  const human = captured.humans.find((h) => h.playerId === attacker.id);
  expect('human present in the result', !!human);
  expect('winner gets placement 1', human.isWinner === true && human.placement === 1,
    `isWinner=${human.isWinner} placement=${human.placement}`);
  expect('kills/gold ride the result', human.kills === 1 && human.gold === attacker.gold,
    `kills=${human.kills} gold=${human.gold} (live ${attacker.gold})`);
  expect('damageDealt delta rides the result', human.damageDealt === delta.damageDealt,
    `result=${human.damageDealt} delta=${delta.damageDealt}`);
  expect('woodChopped delta rides the result', human.woodChopped === delta.woodChopped,
    `result=${human.woodChopped} delta=${delta.woodChopped}`);
  expect('bestKillStreak delta rides the result', human.bestKillStreak === delta.bestKillStreak,
    `result=${human.bestKillStreak} delta=${delta.bestKillStreak}`);
  expect('playSeconds spans join → match end sim-time',
    human.playSeconds === Math.max(0, match.t - delta.joinedAtSimTime) && human.playSeconds > 0,
    `playSeconds=${human.playSeconds}, t=${match.t}, joined=${delta.joinedAtSimTime}`);
}

console.log(failures === 0 ? '\nAll stats assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
