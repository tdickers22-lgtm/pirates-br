#!/usr/bin/env node
// Lifetime stats pipeline, unit + end-to-end against the real Match:
//   1. StatsStore: legacy records (pre-stats-panel JSON) zero-fill the new
//      fields; applyMatchResult sums counters, min-merges bestPlacement and
//      max-merges bestKillStreak / bestMatchGold; records survive a reload
//   5-8. b1.2f: device identity (same name, two devices = two records), a
//      legacy record claimed once, 10k set_name = 0 records + 0 writes, 50k LRU
//      cap, async flush p99 loop delay < 5 ms, <= 1 write per interval,
//      PIRATES_BR_STATS_PATH, in-match name dedupe
//   2. Match: a melee duel accumulates damageDealt swing-by-swing and the kill
//      path stamps bestKillStreak; the real axe-harvest path accumulates
//      woodChopped; the match-end result carries all deltas on MatchHumanResult
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { readFileSync, mkdtempSync } from 'node:fs';
// liveplay-14: the LobbyServer built in section 6 must never touch data/stats.json.
const TMP = mkdtempSync(join(tmpdir(), 'pbr-stats-'));
process.env.PIRATES_BR_STATS_PATH = join(TMP, 'lobby-stats.json');
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
  await store.flush();
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
  attacker.atCannon = false; attacker.atHelm = false; attacker.atCrowNest = false;
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


// ────────────────────────────────────────────────────────────────────────────
// b1.2f (online-07, liveplay-14): device identity, no records on set_name,
// 50k LRU cap, async chunked flush at most once per interval.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recordCount = (s) => (typeof s.size === 'number' ? s.size : Object.keys(s.data?.players ?? {}).length);
const devId = (i) => `dev${String(i).padStart(6, '0')}abcdefghijklmnop`;

console.log('\n5. Same name + different device -> separate records; a legacy record is claimed once');
{
  const p5 = join(TMP, 's5.json');
  writeFileSync(p5, JSON.stringify({ version: 1, players: { olddog: { name: 'OldDog', kills: 5, deaths: 3, wins: 1, matchesPlayed: 4, totalGold: 900 } } }));
  const s5 = new StatsStore(p5);
  const base = { name: 'Same Name', deaths: 0, gold: 10, placement: 2, isWinner: false };
  s5.applyMatchResult({ ...base, deviceId: devId(1), kills: 3 });
  s5.applyMatchResult({ ...base, deviceId: devId(2), kills: 5 });
  const a = s5.getByDevice?.(devId(1)), b = s5.getByDevice?.(devId(2));
  expect('two devices, one name: two records (kills 3 and 5)', a?.kills === 3 && b?.kills === 5,
    `a=${JSON.stringify(a)?.slice(0, 60)} b=${JSON.stringify(b)?.slice(0, 60)} (name-keyed store merges them)`);
  const c = s5.applyMatchResult({ name: 'OldDog', deviceId: devId(3), kills: 1, deaths: 0, gold: 0, placement: 0, isWinner: false });
  expect('first device finishing a match as OldDog claims the legacy record', c.kills === 6 && c.totalGold === 900, JSON.stringify(c));
  expect('the claimed legacy key is gone (claimed once)', s5.get('OldDog') === null, JSON.stringify(s5.get('OldDog')));
  const d = s5.applyMatchResult({ name: 'OldDog', deviceId: devId(4), kills: 1, deaths: 0, gold: 0, placement: 0, isWinner: false });
  expect('a second device named OldDog starts from zero', d.kills === 1 && d.totalGold === 0, JSON.stringify(d));
  await s5.flush();
  const text = readFileSync(p5, 'utf8');
  expect('the raw device id never reaches the file (sha256 only)', !text.includes(devId(1)) && /"d:[0-9a-f]{64}"/.test(text));
  expect('compact JSON (no pretty-print indentation)', !text.includes('\n  '));
}

console.log('\n6. 10k set_name through the real LobbyServer -> 0 new records, 0 writes; hostile name refused');
{
  const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
  const server = new LobbyServer();
  expect('LobbyServer honours PIRATES_BR_STATS_PATH (tmp, not data/stats.json)',
    server.stats.path === process.env.PIRATES_BR_STATS_PATH, `path=${server.stats.path}`);
  const p6 = join(TMP, 's6.json');
  const s6 = new StatsStore(p6);
  server.stats = s6;
  const sink = [];
  const session = { id: 'sess-1', token: 't', ws: makeFakeWs(sink), name: '', state: 'menu', lastSeenAt: Date.now() };
  for (let i = 0; i < 10_000; i++) {
    const name = `Rnd${Math.random().toString(36).slice(2, 10)}`;
    server.handleSetName(session, { type: 'set_name', ts: 0, payload: i % 2 ? { name, deviceId: devId(i) } : { name } });
  }
  await sleep(700);
  expect('0 records created by 10k set_name', recordCount(s6) === 0, `records=${recordCount(s6)}`);
  expect('0 file writes', !existsSync(p6) && (s6.writes ?? 0) === 0, `file=${existsSync(p6)} writes=${s6.writes}`);
  expect('every set_name still answered with a stats_update',
    sink.filter((m) => m.type === 'stats_update').length === 10_000);
  const r = (w) => w.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97));
  sink.length = 0;
  server.handleSetName(session, { type: 'set_name', ts: 0, payload: { name: `x${r('avttre')}x` } });
  expect('a blocked name sails as Pirate#### and the client is told why',
    /^Pirate\d{4}$/.test(session.name) && sink.some((m) => m.type === 'lobby_error' && /not allowed/.test(m.payload.reason)),
    `name=${session.name} msgs=${sink.map((m) => m.type).join(',')}`);
  server.handleSetName(session, { type: 'set_name', ts: 0, payload: { name: '\u202EAnne\u200BBonny' } });
  expect('bidi/zero-width stripped from an accepted name', session.name === 'AnneBonny', session.name);
}

console.log('\n7. 50k records: LRU cap, async flush p99 event-loop delay < 5 ms, at most one write per interval');
{
  const p7 = join(TMP, 's7.json');
  const s7 = new StatsStore(p7);
  const one = { deaths: 0, gold: 5, placement: 3, isWinner: false, kills: 1 };
  for (let i = 0; i < 50_010; i++) s7.applyMatchResult({ ...one, name: `P${i}`, deviceId: devId(i) });
  expect('capped at 50,000 records', recordCount(s7) === 50_000, `records=${recordCount(s7)}`);
  expect('the 10 least recently played were evicted, the 11th kept',
    s7.getByDevice?.(devId(0)) === null && s7.getByDevice?.(devId(9)) === null && !!s7.getByDevice?.(devId(10)));
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  await sleep(15); // the sampling timer must be running BEFORE the flush starts
  const t0 = performance.now();
  await s7.flush();
  await sleep(20); // let a blocked timer land its sample
  h.disable();
  const p99 = h.percentile(99) / 1e6, max = h.max / 1e6;
  console.log(`     flush of 50k: ${(performance.now() - t0).toFixed(0)} ms wall, loop delay p99 ${p99.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
  expect('flush p99 event-loop delay < 5 ms', p99 < 5, `p99=${p99.toFixed(2)} ms`);
  const reloaded = new StatsStore(p7);
  expect('reload keeps 50,000 records in LRU order', recordCount(reloaded) === 50_000 && !!reloaded.getByDevice?.(devId(10)));

  const p8 = join(TMP, 's8.json');
  const s8 = new StatsStore(p8, { flushIntervalMs: 400 });
  s8.applyMatchResult({ ...one, name: 'A1', deviceId: devId(1) });
  await sleep(150);
  expect('first result written promptly', s8.writes === 1, `writes=${s8.writes}`);
  for (let i = 0; i < 20; i++) s8.applyMatchResult({ ...one, name: 'A1', deviceId: devId(1) });
  await sleep(100);
  expect('20 more results inside the interval: still 1 write', s8.writes === 1, `writes=${s8.writes}`);
  await sleep(350);
  expect('exactly one more write once the interval passes', s8.writes === 2, `writes=${s8.writes}`);
}

console.log("\n8. Match: a second 'Pirate4821' in one match sails as 'Pirate4821 (2)'");
{
  const m8 = new Match({ matchId: `stats-dup-${Math.random().toString(36).slice(2, 8)}`, botCount: 0 });
  const j1 = m8.addHumanClient(makeFakeWs(), 'Pirate4821');
  const j2 = m8.addHumanClient(makeFakeWs(), 'pirate4821');
  const names = m8.state.players.filter((p) => p.id === j1.playerId || p.id === j2.playerId).map((p) => p.name);
  expect('duplicate display name deduped in-match', names.includes('Pirate4821') && names.includes('pirate4821 (2)'),
    JSON.stringify(names));
  m8.stop?.();
}
rmSync(TMP, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll stats assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
