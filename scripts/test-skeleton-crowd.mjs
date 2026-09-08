#!/usr/bin/env node
// THE DEAD DO NOT ALL RISE AT ONCE (review-6 P1, batch D fixup).
//
// bots-09 changed the garrison wake test from "a human is near" to "any crew is
// near", which was right — a bot crew used to dig Cutlass Cay unmolested while
// the one human on the map fought two waves for the same chest. What it did NOT
// come with was a ceiling. With 9-12 bot crews going ashore, 5-8 of the 14
// islands can be armed at the same time (2-4 skeletons each, ceiling ~45), and
// every skeleton is
//
//   * a Player in state.players, riding the full snapshot against the 35 KB cap;
//   * on the client, the ONLY body makePlayerRig refuses (the skeleton variant
//     keeps the procedural build), i.e. 22-26 draws and 9-14 materials each.
//
// 20 of them is ~500 draw calls against a low tier whose whole-scene ceiling is
// 380. So this suite pins the two halves of the fix:
//
//   1. SERVER: however many islands have a crew standing on them, live
//      skeletons never exceed SKELETON_LIVE_CAP; the garrison nearest a crew
//      gets the budget; and an island that missed out is not starved for ever.
//   2. CLIENT: syncPlayers has a draw-range gate for the skeleton body (source
//      assertion — Game.ts needs a WebGL context to instantiate, so this grades
//      the code, not a frame).
//
//   node --import tsx scripts/test-skeleton-crowd.mjs
import { readFileSync } from 'node:fs';
import { Match } from '../src/server/core/Match.ts';

let failures = 0;
let checks = 0;
function expect(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

console.log('Skeleton crowd (server cap + client draw range)');

/** A match with a living crew standing in the middle of EVERY garrison island —
 *  the worst case a map full of bot crews can produce. */
function stormEveryIsland(botCount = 16) {
  const match = new Match({ matchId: 'skeleton-crowd', botCount, seed: 20260801 });
  match.state.phase = 'playing';
  match.t = 400; // past SKELETON_WAVE_PEACE_SECONDS
  const garrisons = match.state.islands.filter((i) => match.getSkeletonWaveSize(i) > 0);
  const crew = match.state.players.filter((p) => !match.isSkeletonPlayer(p));
  for (let i = 0; i < garrisons.length && i < crew.length; i++) {
    const p = crew[i];
    p.state = 'alive';
    p.health = 100;
    p.position = { x: garrisons[i].position.x, y: 2, z: garrisons[i].position.z };
  }
  return { match, garrisons, crew };
}

function liveSkeletons(match) {
  return match.state.players.filter(
    (p) => match.skeletonHomes.has(p.id) && p.state !== 'eliminated' && p.state !== 'respawning' && p.health > 0,
  );
}

// ── 1. the cap holds over a long match ────────────────────────────────────
{
  const { match, garrisons, crew } = stormEveryIsland();
  expect('the fixed world has enough garrison islands to over-fill the cap',
    garrisons.length >= 8 && crew.length >= 8, `${garrisons.length} garrison islands, ${crew.length} crew`);
  const wouldBe = garrisons.reduce((n, i) => n + match.getSkeletonWaveSize(i), 0);
  expect('and enough garrison strength that an uncapped map would blow the budget',
    wouldBe > 20, `${wouldBe} skeletons if every island rose`);

  let peak = 0;
  for (let s = 0; s < 900; s++) {
    match.updateSkeletonWaves(1);
    peak = Math.max(peak, liveSkeletons(match).length);
  }
  expect(`live skeletons never exceed the cap over 900 s (peak ${peak})`, peak <= 10, `peak ${peak} live`);
  expect('and the garrisons DO rise (the cap is not a mute button)', peak >= 6, `peak ${peak} live`);
}

// ── 2. the budget goes to the garrison somebody is standing in ────────────
{
  const { match, garrisons } = stormEveryIsland(16);
  // Clear the map, then put ONE crew on the last garrison island in list order:
  // an unsorted spawn loop would fill the cap from the front of the list and
  // never reach her.
  for (const p of match.state.players) {
    if (!match.isSkeletonPlayer(p)) p.position = { x: 9000, y: 2, z: 9000 };
  }
  const mine = garrisons[garrisons.length - 1];
  const her = match.state.players.find((p) => !match.isSkeletonPlayer(p));
  her.state = 'alive';
  her.health = 100;
  her.position = { x: mine.position.x, y: 2, z: mine.position.z };
  let rose = false;
  for (let s = 0; s < 400 && !rose; s++) {
    match.updateSkeletonWaves(1);
    rose = liveSkeletons(match).some((p) => match.skeletonHomes.get(p.id) === mine.id);
  }
  expect('the island the crew is standing on gets its garrison', rose, `island ${mine.id}`);
}

// ── 3. an island that lost the budget is not starved for ever ─────────────
{
  const { match, garrisons } = stormEveryIsland();
  for (let s = 0; s < 600; s++) match.updateSkeletonWaves(1);
  const before = new Set(liveSkeletons(match).map((p) => match.skeletonHomes.get(p.id)));
  // Wipe the standing garrisons; the islands that were over budget must take
  // the opening on the very next ticks rather than waiting a fresh cooldown.
  for (const p of liveSkeletons(match)) { p.health = 0; p.state = 'eliminated'; }
  for (let s = 0; s < 12; s++) match.updateSkeletonWaves(1);
  const after = new Set(liveSkeletons(match).map((p) => match.skeletonHomes.get(p.id)));
  const fresh = [...after].filter((id) => !before.has(id));
  expect('an island that missed the budget rises within seconds of an opening',
    fresh.length > 0, `before ${[...before].join(',')} / after ${[...after].join(',')}`);
  expect('and the cap still holds after the hand-over', after.size > 0 && liveSkeletons(match).length <= 10,
    `${liveSkeletons(match).length} live`);
}

// ── 4. the client half: a distant garrison builds no body ─────────────────
{
  const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url).pathname, 'utf8');
  expect('Game.ts declares a skeleton draw range', /SKELETON_DRAW_RANGE_SQ\s*=/.test(game));
  const sync = game.slice(game.indexOf('private syncPlayers'), game.indexOf('private syncPlayers') + 3000);
  expect('syncPlayers skips the body for a skeleton past that range',
    /playerIsSkeleton[\s\S]{0,400}SKELETON_DRAW_RANGE_SQ[\s\S]{0,300}continue;/.test(sync),
    'no range gate around the skeleton mesh build');
  expect('and it drops the mesh it already built',
    /SKELETON_DRAW_RANGE_SQ[\s\S]{0,300}playerMeshes\.delete/.test(sync));
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
