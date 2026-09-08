#!/usr/bin/env node
// A shark is never left inside an island (SHARK-01 / bots-18, ANIMALSHOVE).
// The old shove was 60 m of pure radial push from the island CENTRE while
// islands reach a 157 m max radius, so on a lobed island a shark stayed buried
// under the terrain and crept there at a quarter speed, invisible, biting the
// swimmer from inside the rock.
//
// 5,000 points sampled inside the island footprints, one shark dropped on each,
// ONE tick of the real updateSharks: every one of them must end in open water.
import { Match } from '../src/server/core/Match.ts';
import { SHARK } from '../src/shared/constants/index.ts';
import { getIslandMaxRadius, isPointInsideIslandFootprint } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = 1 / 60;
const match = new Match({ matchId: 'shark-inland-shove-test', botCount: 1 });
const state = match.state;
// No swimmer anywhere: this suite grades the shove, not the hunt.
for (const p of state.players) p.state = 'alive';

/** Deterministic sampler — the same 5,000 points on every run and every machine. */
let seed = 0x5ea12ab1;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

const TOTAL = 5000;
const perIsland = Math.max(1, Math.floor(TOTAL / state.islands.length));
let sampled = 0;
let stuck = 0;
let despawned = 0;
let worstTravel = 0;
const stuckExamples = [];

for (const island of state.islands) {
  const reach = getIslandMaxRadius(island);
  let taken = 0;
  let guard = 0;
  while (taken < perIsland && guard++ < perIsland * 40) {
    // Rejection-sample the real footprint, so lobes and bays are represented in
    // proportion to their area instead of a disc approximation.
    const x = island.position.x + (rand() * 2 - 1) * reach;
    const z = island.position.z + (rand() * 2 - 1) * reach;
    if (!isPointInsideIslandFootprint(island, x, z, SHARK.SHORE_MARGIN)) continue;
    taken += 1;
    sampled += 1;

    state.sharks.length = 0;
    state.sharks.push({
      id: `inland-${sampled}`,
      position: { x, y: 0.38, z },
      rotation: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: SHARK.HEALTH,
      biteCooldown: 1e9,
      attackState: 'cruise',
      attackTimer: 0,
      lungeDirX: 0,
      lungeDirZ: 0,
      targetId: null,
      anchorX: x,
      anchorZ: z,
      idleTime: 0,
    });
    match.updateSharks(DT);
    const s = state.sharks[0];
    if (!s) { despawned += 1; continue; }
    if (s.despawnTimer !== undefined) despawned += 1;
    worstTravel = Math.max(worstTravel, Math.hypot(s.position.x - x, s.position.z - z));
    let inside = false;
    for (const other of state.islands) {
      if (isPointInsideIslandFootprint(other, s.position.x, s.position.z, 0)) { inside = true; break; }
    }
    if (inside) {
      stuck += 1;
      if (stuckExamples.length < 3) {
        stuckExamples.push(`(${x.toFixed(1)}, ${z.toFixed(1)}) → (${s.position.x.toFixed(1)}, ${s.position.z.toFixed(1)}) on ${island.name ?? island.id}`);
      }
    }
  }
}

console.log(`  sampled ${sampled} inland points across ${state.islands.length} islands; longest shove ${worstTravel.toFixed(1)} m`);
expect('the sampler really found inland points (control)', sampled >= TOTAL * 0.9, `sampled=${sampled}`);
expect('every inland shark exits the terrain in one tick', stuck === 0,
  `${stuck} of ${sampled} still under terrain\n     ${stuckExamples.join('\n     ')}`);
expect('no shark had to give up to get out', despawned === 0, `${despawned} despawned inside terrain`);

if (failures > 0) {
  console.error(`\n${failures} shark inland-shove assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll shark inland-shove assertions passed.');
