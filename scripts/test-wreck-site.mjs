#!/usr/bin/env node
// WHERE THE GILDED WRECK RISES (ECON-01 / gameplay-05).
//
// The wreck is the one authored convergence beat in a 12.6-minute arc, and it
// rose at the ANNOUNCED NEXT RING CENTRE — a point the storm derives from the
// same fixed world every match. So the ghost galleon came up in the same water
// every single time: the second match in a row, every crew already knew where
// she would be and who would be there waiting.
//
// The fix is a SEEDED SITE LIST: 6-8 candidate wrecks drawn from the match seed,
// with the one nearest the announced ring centre chosen. The pacing (everyone
// sails toward the ring anyway) survives; the memorisation does not.
//
//   node --import tsx scripts/test-wreck-site.mjs
import { Match } from '../src/server/core/Match.ts';
import { WRECK_SITES } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY, dist2D } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

console.log('The Gilded Wreck rises somewhere you have to find');

// The storm's ring centres draw from the match RNG, which is Math.random unless
// the map seed is pinned — so without this the "same seed, same water" assertion
// is a coin flip and the variety count wanders run to run. Pinned here, restored
// at the end, exactly as test-wreck-event.mjs does.
const seedWas = process.env.PIRATES_BR_MAP_SEED;
process.env.PIRATES_BR_MAP_SEED = '20260801';

const SEEDS = 12;
const sites = [];
const matches = [];
for (let i = 0; i < SEEDS; i++) {
  const match = new Match({ matchId: `wreck-site-${i}`, botCount: 0 });
  match.state.phase = 'playing';
  const wreck = match.forceRaiseGildedWreck();
  if (!wreck) { console.error(`  seed ${i}: no wreck`); failures += 1; continue; }
  sites.push({ x: wreck.position.x, z: wreck.position.z, match });
  matches.push(match);
}

// 1. VARIETY. Two sites are "the same water" if they are within 60 m — a crew
//    parked on last match's mark would still be sitting on her.
const distinct = [];
for (const site of sites) {
  if (!distinct.some((seen) => dist2D(seen.x, seen.z, site.x, site.z) < 60)) distinct.push(site);
}
expect(`12 seeds raise her in at least 5 distinct places (got ${distinct.length})`,
  distinct.length >= 5,
  sites.map((s) => `${s.x.toFixed(0)},${s.z.toFixed(0)}`).join(' | '));

// 2. DETERMINISM. Same seed, same site — the world is fixed and a replay of the
//    same match must put her in the same water.
{
  const a = new Match({ matchId: 'wreck-site-3', botCount: 0 });
  a.state.phase = 'playing';
  const again = a.forceRaiseGildedWreck();
  expect('the same match seed raises her in the same water',
    !!again && dist2D(again.position.x, again.position.z, sites[3].x, sites[3].z) < 0.001,
    `${again?.position.x.toFixed(2)},${again?.position.z.toFixed(2)} vs ${sites[3].x.toFixed(2)},${sites[3].z.toFixed(2)}`);
}

// 3. STILL WATER, NOT DRY LAND. She is a half-sunk hull; a site on a hillside is
//    a bug the old ring-centre pick was already guarding against.
{
  let dry = 0;
  for (let i = 0; i < sites.length; i++) {
    for (const island of matches[i].state.islands) {
      if (getIslandSurfaceY(island, sites[i].x, sites[i].z) > 0.2) { dry += 1; break; }
    }
  }
  expect('every site is in open water', dry === 0, `${dry} of ${sites.length} on dry land`);
}

// 4. THE PACING PROMISE. She still rises near the ring the lobby is being told
//    to sail to — the site list is a choice AMONG places worth converging on,
//    not a random dot in the Reach.
{
  let far = 0;
  for (let i = 0; i < sites.length; i++) {
    const storm = matches[i].state.storm;
    if (dist2D(sites[i].x, sites[i].z, storm.nextCenterX, storm.nextCenterZ) > WRECK_SITES.MAX_RING_DISTANCE) far += 1;
  }
  expect(`every site is within ${WRECK_SITES.MAX_RING_DISTANCE} m of the announced ring centre`,
    far === 0, `${far} of ${sites.length} too far`);
}

// 5. The list itself is 6-8 sites — enough that a veteran cannot hold them all
//    as "the" spot, few enough that each one is authored water.
expect('the site list holds 6-8 candidate wrecks',
  WRECK_SITES.COUNT >= 6 && WRECK_SITES.COUNT <= 8, `count=${WRECK_SITES.COUNT}`);

if (seedWas === undefined) delete process.env.PIRATES_BR_MAP_SEED;
else process.env.PIRATES_BR_MAP_SEED = seedWas;

if (failures > 0) {
  console.error(`\n${failures} wreck-site assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll wreck-site assertions passed.');
