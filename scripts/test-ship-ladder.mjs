#!/usr/bin/env node
/**
 * THE MODE ROSTER AND THE SHIP LADDER (MODE-01 / SHIPLADDER, PLAN §2.1).
 *
 * Three things were true before this gate and each of them was invisible:
 *
 *  • ships-22 — SHIP_STATS was already *written* for crews (2 guns for one pair
 *    of hands, 8 for four) but nothing mapped a crew size to a hull outside one
 *    private helper in Match.ts that was called with a literal 1. There was no
 *    mode table at all, so "singles/duos/squads" existed only in the design.
 *  • gameplay-07 / bots-04 — `i < 5 ? 'easy' : i < 12 ? 'medium' : 'hard'` over
 *    a botCount that can never exceed MATCH_TOTAL_SHIPS-1 = 9 meant the 'hard'
 *    rung was UNREACHABLE in production: every lobby was 5 easy + 4 medium, and
 *    BotSystem's hard cadence/range/noise numbers were dead code.
 *  • netcode-22 — the ladder's own numbers were not a ladder: the brigantine
 *    was a sloop with two more guns and the classes' speed/turn spread was
 *    narrow enough that hull class barely read as a choice.
 *
 * This suite grades the SHAPE of the roster, not a feel: the mode table against
 * PLAN §2.1, the hull ladder's monotonicity, stations == crew size, and the
 * difficulty ladder's reachability across every lobby size the lobby can build.
 * Pure constants + pure functions — no server, no browser, no ports.
 */
import {
  MODES, MODE_IDS, BOT_TIERS, BOT_TIER_IDS, SHIP_STATS, FLOODING,
  MATCH_TOTAL_SHIPS, botFillFor, hullForCrewSize, botDifficultyLadder,
} from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// ── 1. The mode table is PLAN §2.1, exactly ──────────────────────────────
console.log('\nMode roster (PLAN §2.1)');
const EXPECTED = {
  solo:   { crewSize: 1, hull: 'sloop',      crews: 12, minCrews: 6 },
  duos:   { crewSize: 2, hull: 'brigantine', crews: 9,  minCrews: 4 },
  squads: { crewSize: 4, hull: 'galleon',    crews: 6,  minCrews: 3 },
};
expect('MODE_IDS is exactly solo, duos, squads (in ladder order)',
  Array.isArray(MODE_IDS) && MODE_IDS.join(',') === 'solo,duos,squads',
  `MODE_IDS=${JSON.stringify(MODE_IDS)}`);
for (const id of Object.keys(EXPECTED)) {
  const want = EXPECTED[id];
  const got = MODES[id];
  expect(`${id}: crew ${want.crewSize} on a ${want.hull}, ${want.crews} hulls, min ${want.minCrews} crews`,
    !!got && got.crewSize === want.crewSize && got.hull === want.hull
      && got.crews === want.crews && got.minCrews === want.minCrews,
    `got=${JSON.stringify(got)}`);
}
// The fleet has to fit the map's berths: 10 docks x 2 berths = 20 (netcode-V1).
for (const id of MODE_IDS) {
  expect(`${id}: every hull can be moored (${MODES[id].crews} <= 20 berths)`,
    MODES[id].crews <= 20, `crews=${MODES[id].crews}`);
  expect(`${id}: bot fill never exceeds the fleet`,
    MODES[id].botFillTo === MODES[id].crews,
    `botFillTo=${MODES[id].botFillTo} crews=${MODES[id].crews}`);
  expect(`${id}: minCrews is a real minimum (2..crews)`,
    MODES[id].minCrews >= 2 && MODES[id].minCrews <= MODES[id].crews);
}
// Squads at 4x6 = 24 humans exceeds the 35 KB full-snapshot cap until WIRE-01
// (PLAN §2.1). The table must say so out loud rather than ship a broken mode.
expect('squads is flagged as gated behind WIRE-01, solo and duos are not',
  MODES.squads.available === false && MODES.solo.available === true && MODES.duos.available === true,
  `available=${MODE_IDS.map((m) => `${m}:${MODES[m].available}`).join(' ')}`);

// ── 2. Hull for crew size (ships-22) ─────────────────────────────────────
console.log('\nHull for crew size');
expect('1 pirate draws a Cutter', hullForCrewSize(1) === 'sloop', hullForCrewSize(1));
expect('2 draw a Corsair', hullForCrewSize(2) === 'brigantine', hullForCrewSize(2));
expect('3 draw a Man-o-War', hullForCrewSize(3) === 'galleon', hullForCrewSize(3));
expect('4 draw a Man-o-War', hullForCrewSize(4) === 'galleon', hullForCrewSize(4));
expect('an over-full crew still gets the biggest hull, never undefined',
  hullForCrewSize(9) === 'galleon');
expect('a zero/negative crew is still handed a hull (never undefined)',
  hullForCrewSize(0) === 'sloop' && hullForCrewSize(-3) === 'sloop');
for (const id of MODE_IDS) {
  expect(`${id}: the mode's crew size draws the mode's hull`,
    hullForCrewSize(MODES[id].crewSize) === MODES[id].hull);
}

// ── 3. Stations == crew size, and the ladder is monotone ─────────────────
console.log('\nShip ladder');
const LADDER = ['sloop', 'brigantine', 'galleon'];
for (const id of MODE_IDS) {
  expect(`${MODES[id].hull}: stations == crew size (${MODES[id].crewSize})`,
    SHIP_STATS[MODES[id].hull].crewStations === MODES[id].crewSize,
    `crewStations=${SHIP_STATS[MODES[id].hull].crewStations}`);
}
const mono = (key, dir) => {
  for (let i = 1; i < LADDER.length; i += 1) {
    const prev = SHIP_STATS[LADDER[i - 1]][key];
    const cur = SHIP_STATS[LADDER[i]][key];
    if (dir > 0 ? !(cur > prev) : !(cur < prev)) {
      return `${LADDER[i - 1]}.${key}=${prev} vs ${LADDER[i]}.${key}=${cur}`;
    }
  }
  return null;
};
for (const [key, dir, label] of [
  ['cannonCount', +1, 'guns rise with the crew'],
  ['maxHull', +1, 'hull points rise with the crew'],
  ['mastCount', +1, 'masts rise with the crew'],
  ['maxSpeed', -1, 'speed falls as the hull grows'],
  ['turnRate', -1, 'turn rate falls as the hull grows'],
]) {
  const bad = mono(key, dir);
  expect(label, bad === null, bad ?? '');
}
// PLAN §2.1 pins the spread itself: a Cutter must FEEL like a different ship
// from a Corsair, and 15/13/10 with 0.70/0.45/0.25 was too flat to read.
expect('speed spread is 15.5 / 14 / 11.5',
  SHIP_STATS.sloop.maxSpeed === 15.5 && SHIP_STATS.brigantine.maxSpeed === 14
    && SHIP_STATS.galleon.maxSpeed === 11.5,
  LADDER.map((t) => `${t}=${SHIP_STATS[t].maxSpeed}`).join(' '));
expect('turn spread is 0.72 / 0.52 / 0.32',
  SHIP_STATS.sloop.turnRate === 0.72 && SHIP_STATS.brigantine.turnRate === 0.52
    && SHIP_STATS.galleon.turnRate === 0.32,
  LADDER.map((t) => `${t}=${SHIP_STATS[t].turnRate}`).join(' '));
// Per-class ingress: the big hull is the slow, tanky one at the pumps too.
const ing = FLOODING.INGRESS_CLASS_SCALE;
expect('ingress per hole falls as the hull grows (sloop > brig > galleon)',
  ing.sloop > ing.brigantine && ing.brigantine > ing.galleon,
  JSON.stringify(ing));
// Guns per pair of hands must not be a free lunch: a bigger hull carries more
// guns in total but never more guns PER CREWMATE than the cutter.
for (const id of MODE_IDS) {
  const perHand = SHIP_STATS[MODES[id].hull].cannonCount / MODES[id].crewSize;
  expect(`${id}: guns per crewmate <= the cutter's 2 (${perHand})`, perHand <= 2);
}

// ── 4. The difficulty ladder reaches 'hard' (gameplay-07 / bots-04) ──────
console.log('\nBot difficulty ladder');
expect('BOT_TIER_IDS is easy, medium, hard',
  Array.isArray(BOT_TIER_IDS) && BOT_TIER_IDS.join(',') === 'easy,medium,hard',
  JSON.stringify(BOT_TIER_IDS));
for (const t of BOT_TIER_IDS) {
  expect(`BOT_TIERS.${t} carries every outcome knob`,
    !!BOT_TIERS[t] && ['reactionDelay', 'rescanInterval', 'aimJitter', 'cadenceMult',
      'retreatHoles', 'perceptionRange', 'lootAppetite', 'boardingAllowed', 'trimLag']
      .every((k) => BOT_TIERS[t][k] !== undefined),
    JSON.stringify(BOT_TIERS[t]));
}
const tierMono = (key, dir) => {
  for (let i = 1; i < BOT_TIER_IDS.length; i += 1) {
    const prev = BOT_TIERS[BOT_TIER_IDS[i - 1]][key];
    const cur = BOT_TIERS[BOT_TIER_IDS[i]][key];
    if (dir > 0 ? !(cur > prev) : !(cur < prev)) return `${key}: ${prev} -> ${cur}`;
  }
  return null;
};
for (const [key, dir, label] of [
  ['reactionDelay', -1, 'a harder bot answers sooner'],
  ['rescanInterval', -1, 'a harder bot re-reads the sea more often'],
  ['aimJitter', -1, 'a harder bot lays her guns straighter'],
  ['cadenceMult', -1, 'a harder bot reloads faster'],
  ['retreatHoles', +1, 'a harder bot takes more water before she runs'],
  ['perceptionRange', +1, 'a harder bot sees further'],
  ['lootAppetite', -1, 'a harder bot is less distracted by loot'],
  ['trimLag', +1, 'a harder bot trims her sails closer to a human'],
]) {
  const bad = tierMono(key, dir);
  expect(label, bad === null, bad ?? '');
}
expect('easy never boards, normal and hard do (PLAN §2.3)',
  BOT_TIERS.easy.boardingAllowed === false && BOT_TIERS.medium.boardingAllowed === true
    && BOT_TIERS.hard.boardingAllowed === true);
expect("easy never picks up the Wrecker's Glass",
  BOT_TIERS.easy.takesWreckersGlass === false && BOT_TIERS.hard.takesWreckersGlass === true);

// The reachability proof: every lobby the modes can build must contain a hard.
for (const id of MODE_IDS) {
  const n = MODES[id].crews - 1; // the fullest bot fill: one human crew, rest bots
  const rungs = botDifficultyLadder(n);
  expect(`${id}: a full bot fill of ${n} produces ${rungs.filter((r) => r === 'hard').length} hard bot(s)`,
    rungs.filter((r) => r === 'hard').length >= 1, rungs.join(','));
  expect(`${id}: the ladder is a mix, not one rung`,
    new Set(rungs).size >= 2, rungs.join(','));
}
for (let n = 1; n <= 24; n += 1) {
  const rungs = botDifficultyLadder(n);
  if (rungs.length !== n || rungs.some((r) => !BOT_TIER_IDS.includes(r))) {
    expect(`ladder(${n}) is n known rungs`, false, rungs.join(','));
    break;
  }
  if (n === 24) expect('ladder(n) is n known rungs for every n in 1..24', true);
}
expect('the ladder is deterministic (same input, same rungs)',
  botDifficultyLadder(9).join(',') === botDifficultyLadder(9).join(','));
expect('a 9-bot lobby is roughly the 30/50/20 mix, not 5 easy + 4 medium',
  botDifficultyLadder(9).filter((r) => r === 'easy').length <= 4
    && botDifficultyLadder(9).filter((r) => r === 'hard').length >= 1,
  botDifficultyLadder(9).join(','));
// botSkill: the party setting shifts the whole ladder one rung.
const base = botDifficultyLadder(9);
const up = botDifficultyLadder(9, 'hard');
const down = botDifficultyLadder(9, 'easy');
const rank = (r) => BOT_TIER_IDS.indexOf(r);
expect("botSkill 'hard' never softens a rung and hardens at least one",
  up.every((r, i) => rank(r) >= rank(base[i])) && up.some((r, i) => rank(r) > rank(base[i])),
  `${base.join(',')} -> ${up.join(',')}`);
expect("botSkill 'easy' never hardens a rung and softens at least one",
  down.every((r, i) => rank(r) <= rank(base[i])) && down.some((r, i) => rank(r) < rank(base[i])),
  `${base.join(',')} -> ${down.join(',')}`);
expect("botSkill 'normal' is the base ladder",
  botDifficultyLadder(9, 'normal').join(',') === base.join(','));

// ── 5. THE FLEET A MODE ACTUALLY BUILDS (MODE-01 slice c) ────────────────
// The table above is a promise; this section makes a real Match keep it. Before
// slice c, setupWorld took a bot COUNT and built one pirate per hull with the
// class the spawn table happened to roll — so a Duos human crew of two fought
// eight single-handed ships, half of them Man-o'-Wars, and every station,
// revive and crew-gold path on the bot side was unreachable.
console.log('\nThe fleet a mode builds (real Match)');
process.env.PIRATES_BR_MAP_SEED ??= '20260801';
const { Match } = await import('../src/server/core/Match.ts');

/** Bot hulls, their class, and who is aboard each one. */
function fleetOf(match) {
  const state = match['state'];
  const byShip = new Map();
  for (const p of state.players) {
    if (!p.isBot || !p.shipId) continue;
    if (!byShip.has(p.shipId)) byShip.set(p.shipId, []);
    byShip.get(p.shipId).push(p);
  }
  return state.ships.map((ship) => ({ ship, hands: byShip.get(ship.id) ?? [] }));
}

for (const [mode, botCrews] of [['solo', 11], ['duos', 8], ['squads', 5]]) {
  const spec = MODES[mode];
  const match = new Match({ matchId: `ladder-${mode}`, botCount: botCrews, mode });
  const fleet = fleetOf(match);
  expect(`${mode}: ${botCrews} bot crews are ${botCrews} hulls, not ${botCrews * spec.crewSize}`,
    fleet.length === botCrews, `hulls=${fleet.length}`);
  expect(`${mode}: every bot hull is a ${spec.hull} (the mode IS the hull, ships-22)`,
    fleet.every((f) => f.ship.type === spec.hull),
    fleet.map((f) => f.ship.type).join(','));
  expect(`${mode}: every bot hull is crewed by ${spec.crewSize} hand(s)`,
    fleet.every((f) => f.hands.length === spec.crewSize),
    fleet.map((f) => f.hands.length).join(','));
  expect(`${mode}: the hull's crewIds are her whole crew, so a crewmate's shot passes through`,
    fleet.every((f) => f.ship.crewIds.length === spec.crewSize
      && f.hands.every((p) => f.ship.crewIds.includes(p.id))),
    fleet.map((f) => f.ship.crewIds.length).join(','));
  expect(`${mode}: total bot pirates = ${botCrews * spec.crewSize}`,
    fleet.reduce((n, f) => n + f.hands.length, 0) === botCrews * spec.crewSize);
  expect(`${mode}: no two hands start inside each other`,
    fleet.every((f) => new Set(f.hands.map((p) => `${p.position.x.toFixed(2)},${p.position.z.toFixed(2)}`)).size
      === f.hands.length));
  expect(`${mode}: every hand is registered with the bot brain, one 'helm' seed per hull`,
    fleet.every((f) => f.hands.every((p) => match['bots'].getRole(p.id) !== null)
      && f.hands.filter((p) => match['bots'].getRole(p.id) === 'helm').length === 1),
    fleet.map((f) => f.hands.map((p) => match['bots'].getRole(p.id)).join('+')).join(' '));
  expect(`${mode}: every bot hull carries her mode's guns (${SHIP_STATS[spec.hull].cannonCount})`,
    fleet.every((f) => f.ship.cannonCooldowns.length === SHIP_STATS[spec.hull].cannonCount),
    fleet.map((f) => f.ship.cannonCooldowns.length).join(','));
  match.stop?.();
}

// An absent or junk mode is the legacy Solo world, not a throw on the lobby's
// hot path (LobbyServer.spawnMatch builds one of these per dispatch).
const legacy = new Match({ matchId: 'ladder-legacy', botCount: 3 });
expect('a Match built with no mode is Solo (Cutters, one hand each)',
  legacy.modeId() === 'solo' && legacy.crewSize() === 1
    && legacy['state'].ships.every((s) => s.type === 'sloop'),
  `${legacy.modeId()} ${legacy['state'].ships.map((s) => s.type).join(',')}`);
legacy.stop?.();

// ── 6. NO FLEET SIZE IS SPELLED OUT ANYWHERE (netcode-17 / DEADTYPES) ────
// "9" was typed into four places that all had to agree with a table none of
// them read: the solo button sent soloStart(9), the private-lobby slider
// offered 0-9, its readout printed 9, and the lobby subtracted 1 from a
// MATCH_TOTAL_SHIPS that was 10. The server built a different number of hulls
// from the one the menu promised, and nobody could see it. This section fails
// the moment a literal creeps back in or index.html stops agreeing with MODES.
console.log('\nNo hardcoded fleet sizes (netcode-17)');
const { readFileSync } = await import('node:fs');
const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
/** Source with comments stripped — a gate that greps for a pattern must not be
 *  satisfied (or broken) by prose ABOUT the pattern. */
const code = (rel) => src(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const menu = code('src/client/menu/MenuController.ts');
expect('the solo button asks the constants for its bot fill, not the literal 9',
  !/soloStart\(\s*\d/.test(menu),
  (menu.match(/soloStart\([^)]*\)/g) ?? []).join(' '));

const lobby = code('src/server/core/LobbyServer.ts');
expect('the lobby sizes its bot fill off MODES, not off a fleet-size subtraction',
  !/MATCH_TOTAL_SHIPS\s*-\s*\w/.test(lobby) && /botFillFor\(/.test(lobby));

const html = src('index.html');
const slider = (html.match(/<input[^>]*id="lobby-bot-slider"[^>]*>/) ?? [''])[0];
const sliderMax = Number((slider.match(/max="(\d+)"/) ?? [])[1]);
const fullFill = MODES.solo.botFillTo - 1;
expect(`the bot-crew slider's ceiling is the Solo fleet less the host's own hull (${fullFill})`,
  sliderMax === fullFill, `index.html max="${sliderMax}"`);

// MATCH_TOTAL_SHIPS is the menu's pre-mode fallback; it must BE a mode's fleet,
// never a number of its own.
expect('MATCH_TOTAL_SHIPS is derived from MODES, not a literal of its own',
  MATCH_TOTAL_SHIPS === MODES.solo.crews, `${MATCH_TOTAL_SHIPS} vs ${MODES.solo.crews}`);
expect('botFillFor fills the rest of the fleet behind the human crews',
  botFillFor('solo', 1) === 11 && botFillFor('duos', 2) === 7
    && botFillFor('squads', 6) === 0 && botFillFor('nonsense', 1) === 11,
  `${botFillFor('solo', 1)},${botFillFor('duos', 2)},${botFillFor('squads', 6)},${botFillFor('nonsense', 1)}`);

if (failures > 0) {
  console.error(`\n${failures} ship-ladder assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll ship-ladder assertions passed.');
process.exit(0);
