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
  const sync = game.slice(game.indexOf('private syncPlayers'), game.indexOf('private syncPlayers') + 3600);
  expect('syncPlayers gates the skeleton body on the draw range',
    /playerIsSkeleton[\s\S]{0,900}skeletonDrawCulled\([\s\S]{0,600}continue;/.test(sync),
    'no range gate around the skeleton mesh build');
  // The mesh is HIDDEN, not demolished: the old fix did scene.remove +
  // playerMeshes.delete at the boundary, which is the rebuild this suite now
  // forbids. If that pair ever comes back inside the skeleton branch the
  // hysteresis below is decoration.
  const skeletonBranch = sync.slice(sync.indexOf('playerIsSkeleton'), sync.indexOf('const playerTeamColor'));
  expect('the culled body is hidden, not destroyed',
    /visible\s*=\s*false/.test(skeletonBranch) && !/playerMeshes\.delete/.test(skeletonBranch),
    skeletonBranch.includes('playerMeshes.delete')
      ? 'the cull still deletes the mesh — every re-entry rebuilds 98 THREE objects'
      : 'the cull never hides the mesh');
  // The reaper that runs when a player leaves the match is the only release
  // path left, so it is the only place a skeleton's GPU memory can be freed.
  expect('and the mesh the reaper releases is disposed',
    /livePlayerIds\.has\(playerId\)[\s\S]{0,600}disposeSceneObject/.test(sync),
    'playerMeshes entries are dropped without disposing their geometries/materials');
}

// ── 5. hysteresis: a shoreline walk cannot flip the body on and off ───────
{
  const {
    skeletonDrawCulled, SKELETON_DRAW_RANGE_M, SKELETON_DRAW_ARM_RANGE_M,
  } = await import('../src/client/core/skeletonCull.ts');

  expect('the arm radius is strictly inside the draw radius',
    SKELETON_DRAW_ARM_RANGE_M < SKELETON_DRAW_RANGE_M,
    `arm ${SKELETON_DRAW_ARM_RANGE_M} / draw ${SKELETON_DRAW_RANGE_M}`);

  // The boundary itself: a body that has never been built is culled, one that
  // is already drawn is kept, at the SAME distance. That is the whole point.
  const mid = ((SKELETON_DRAW_RANGE_M + SKELETON_DRAW_ARM_RANGE_M) / 2) ** 2;
  expect('a body already drawn survives the middle of the band',
    skeletonDrawCulled(mid, false) === false);
  expect('a body not yet built is not built in the middle of the band',
    skeletonDrawCulled(mid, true) === true);

  /** Walk the camera in and out across the boundary and count state flips. */
  function flips(centreM, amplitudeM, steps, startCulled) {
    let culled = startCulled;
    let transitions = 0;
    for (let i = 0; i < steps; i++) {
      const d = centreM + amplitudeM * Math.sin((i / steps) * Math.PI * 2 * 8);
      const next = skeletonDrawCulled(d * d, culled);
      if (next !== culled) transitions += 1;
      culled = next;
    }
    return transitions;
  }

  // A pirate pacing a garrison island's edge, 140 m to 152 m and back, eight
  // laps: he straddles the draw radius but never returns inside the arm
  // radius. One transition. Collapse the two radii into one and the same walk
  // is sixteen build/teardown pairs of ~980 GPU resources.
  const pacing = flips(SKELETON_DRAW_RANGE_M - 4, 6, 400, false);
  expect('eight laps across the draw radius cost at most one transition',
    pacing <= 1, `${pacing} transitions over 400 frames`);

  // And it is not a gate that cannot fail: a walk that genuinely leaves and
  // re-enters must still flip, or the body would never come back.
  const wide = flips(SKELETON_DRAW_RANGE_M - 20, 60, 400, true);
  expect('a genuine departure and return still arms and disarms',
    wide >= 2, `${wide} transitions over 400 frames`);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
