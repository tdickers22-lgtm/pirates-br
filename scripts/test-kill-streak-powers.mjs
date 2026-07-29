#!/usr/bin/env node
/**
 * Kill-streak power regression.
 *
 * The ladder used to be 5/10/20, typed by hand in five places (the server twice,
 * the HUD badge, the HUD feed table, the legend card) — and its top rung was a
 * 20-kill streak without dying in a lobby of MATCH_TOTAL_SHIPS crews: content
 * no player in the game's history had ever seen. It is now one exported ladder
 * (KILL_STREAK_TIERS) sized to the lobby, and this suite pins BOTH halves:
 *
 *   · the award rule still grants exactly one special per rung, once;
 *   · every surface that quotes a threshold quotes the ladder's own numbers —
 *     the server branches, the badge's "next rung", and the legend copy in
 *     index.html.
 *
 * It runs under plain node (no tsx), so the sources are read as text.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// ── The ladder, as exported ──────────────────────────────────────────────────
const CONSTANTS = read('src/shared/constants/index.ts');
const tierBlock = CONSTANTS.slice(CONSTANTS.indexOf('export const KILL_STREAK_TIERS'));
const tiers = {};
for (const m of tierBlock.slice(0, tierBlock.indexOf('}')).matchAll(/(\w+):\s*(\d+)/g)) {
  tiers[m[1]] = Number(m[2]);
}
const lobbyMatch = CONSTANTS.match(/export const MATCH_TOTAL_SHIPS = (\d+)/);
const lobbySize = lobbyMatch ? Number(lobbyMatch[1]) : 0;

console.log('The ladder:');
expect('KILL_STREAK_TIERS names all three powers',
  ['super_cannonball', 'mega_keg', 'tsunami'].every((k) => Number.isInteger(tiers[k])),
  JSON.stringify(tiers));
const ladder = [tiers.super_cannonball, tiers.mega_keg, tiers.tsunami];
expect('the rungs climb', ladder[0] < ladder[1] && ladder[1] < ladder[2], ladder.join('/'));
// THE POINT OF THE RETIER: the first rung must land inside a single good fight,
// and the top rung must be reachable in a lobby this size (crews respawn, so a
// generous 2x of the lobby is the ceiling — 20 in a 10-crew lobby was not).
expect('the first rung is reachable in one good boarding', ladder[0] <= 5, `${ladder[0]}`);
expect(`the top rung is reachable in a ${lobbySize}-crew lobby`,
  lobbySize > 0 && ladder[2] <= lobbySize * 1.5, `${ladder[2]} vs lobby ${lobbySize}`);

// ── The award rule ───────────────────────────────────────────────────────────
function awardPlayerKillStreak(killer) {
  killer.playerKillStreak += 1;
  if (killer.playerKillStreak === tiers.super_cannonball) {
    killer.superCannonballs += 1;
    return 'super_cannonball';
  }
  if (killer.playerKillStreak === tiers.mega_keg) {
    killer.megaKegs += 1;
    return 'mega_keg';
  }
  if (killer.playerKillStreak === tiers.tsunami) {
    killer.tsunamiCharges += 1;
    return 'tsunami';
  }
  return null;
}

console.log('\nKill-streak power thresholds:');
const killer = {
  playerKillStreak: 0,
  superCannonballs: 0,
  megaKegs: 0,
  tsunamiCharges: 0,
};
const rewards = [];
for (let i = 0; i < tiers.tsunami + 4; i++) {
  const reward = awardPlayerKillStreak(killer);
  if (reward) rewards.push({ kill: i + 1, reward });
}

expect(`${tiers.super_cannonball} kills grants one super cannonball`, killer.superCannonballs === 1);
expect(`${tiers.mega_keg} kills grants one mega keg`, killer.megaKegs === 1);
expect(`${tiers.tsunami} kills grants one tsunami`, killer.tsunamiCharges === 1);
expect(
  `Rewards happen only at ${ladder.join(', ')}`,
  JSON.stringify(rewards) === JSON.stringify([
    { kill: tiers.super_cannonball, reward: 'super_cannonball' },
    { kill: tiers.mega_keg, reward: 'mega_keg' },
    { kill: tiers.tsunami, reward: 'tsunami' },
  ]),
  JSON.stringify(rewards),
);

// ── Nobody quotes a number of their own ──────────────────────────────────────
console.log('\nOne ladder, every surface:');
const MATCH = read('src/server/core/Match.ts');
const streakFn = MATCH.slice(MATCH.indexOf('private awardPlayerKillStreak'));
const streakBody = streakFn.slice(0, streakFn.indexOf('\n  }'));
expect('the server branches on KILL_STREAK_TIERS, not on literals',
  ['super_cannonball', 'mega_keg', 'tsunami'].every((k) => streakBody.includes(`KILL_STREAK_TIERS.${k}`))
  && !/playerKillStreak === \d+/.test(streakBody),
  streakBody.slice(0, 400));

const HUD = read('src/client/ui/HudController.ts');
expect('the HUD badge and feed table read the ladder',
  HUD.includes('KILL_STREAK_LADDER') && !/for \(const threshold of \[\d+/.test(HUD));

const HTML = read('index.html');
const legendLine = (HTML.split('\n').find((l) => /Kill streak rewards:/.test(l)) ?? '');
const legendNumbers = [...legendLine.matchAll(/(\d+)\s*(?:kills)?\s*·/g)].map((m) => Number(m[1]));
expect('the legend card quotes the live ladder',
  ladder.every((rung) => legendNumbers.includes(rung)),
  `legend="${legendLine.trim()}" ladder=${ladder.join('/')}`);
expect('no dead rung survives in the legend copy',
  !/\b20 · tsunami/.test(legendLine), legendLine.trim());

if (failures > 0) {
  console.error(`\n${failures} kill-streak assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll kill-streak assertions passed.');
