#!/usr/bin/env node
import { CARGO, ECONOMY, PLAYER, LANDING_STORES_MIN, SHIP_SPAWN_STORES, SHOP_PRICES, STORM_PHASES, WRECK_EVENT } from '../src/shared/constants/index.ts';
import { bountyThresholdGold, cargoGoldFromBanked, cargoTier } from '../src/shared/cargo.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

console.log('Game balance contract');

const stormDuration = STORM_PHASES.reduce((sum, phase) => sum + phase.waitSec + phase.shrinkSec, 0);
const mapChestAverageSale = ((ECONOMY.CHEST_VALUE_MIN + ECONOMY.CHEST_VALUE_MAX) / 2)
  * ECONOMY.CHEST_SELL_MULTIPLIER
  * ECONOMY.HOARDER_QUEST_CHEST_BONUS;
const hitGoldForPlayerHealth = Math.max(
  ECONOMY.PLAYER_HIT_GOLD_MIN,
  Math.min(ECONOMY.PLAYER_HIT_GOLD_MAX, Math.round(PLAYER.MAX_HEALTH * ECONOMY.PLAYER_HIT_GOLD_RATIO)),
);

expect('Storm match clock stays in a 10-14 minute BR window', stormDuration >= 600 && stormDuration <= 840, `duration=${stormDuration}s`);
expect('First storm grace is under three minutes', STORM_PHASES[0].waitSec <= 150, `wait=${STORM_PHASES[0].waitSec}s`);
expect('Endgame storm is lethal enough to force closure', STORM_PHASES.at(-1)?.dmgPerSec >= 12, `damage=${STORM_PHASES.at(-1)?.dmgPerSec}`);
expect('PvP kill reward is meaningful gold', PLAYER.KILL_GOLD_REWARD >= 250, `killGold=${PLAYER.KILL_GOLD_REWARD}`);
expect('Five kills rival a good map chest sale', PLAYER.KILL_GOLD_REWARD * 5 >= mapChestAverageSale * 0.55, `kills=${PLAYER.KILL_GOLD_REWARD * 5}, chest=${mapChestAverageSale.toFixed(0)}`);
expect('Full-health damage earns visible hit gold', hitGoldForPlayerHealth >= 15, `hitGold=${hitGoldForPlayerHealth}`);
expect('Gold target still requires multiple objectives', ECONOMY.GOLD_WIN_TARGET >= mapChestAverageSale * 3.2, `target=${ECONOMY.GOLD_WIN_TARGET}, chest=${mapChestAverageSale.toFixed(0)}`);

// ── ECON-01 REACHABILITY ────────────────────────────────────────────────────
// The audit's finding was not "the numbers are wrong", it was that the hold-cargo
// economy was UNREACHABLE: with SAFE_GOLD 1500 and a bounty at 5400, a live match
// whose leader held 1,265 g at nine minutes never once entered the systems the
// game is built around. So the balance contract now asserts the ECONOMY IS
// ENTERED, in the units a player actually earns them in.
console.log('\nECON-01 reachability');

// 1. THE MEASURED SYMPTOM, made executable. A live 12.6-minute match ended with
//    the LEADER holding 1,265 g (liveplay-17). Under the old curve that purse was
//    still pocket coin: zero cargo, hold tier 0, no ballast, no spill, no bounty,
//    nothing to board her for. The whole hold economy was scenery. A purse that
//    large must be CARGO — visible in the hold and worth taking.
const LIVE_LEADER_PURSE_9MIN = 1265;
expect(
  "A live match's leading purse is actually CARGO, not pocket coin",
  cargoGoldFromBanked(LIVE_LEADER_PURSE_9MIN) > 0 && cargoTier(cargoGoldFromBanked(LIVE_LEADER_PURSE_9MIN)) >= 1,
  `purse=${LIVE_LEADER_PURSE_9MIN}, safe=${CARGO.SAFE_GOLD}, cargo=${cargoGoldFromBanked(LIVE_LEADER_PURSE_9MIN)}, tier=${cargoTier(cargoGoldFromBanked(LIVE_LEADER_PURSE_9MIN))}`,
);

// 2. Three kills plus one chest sale — an ordinary good five minutes — must put
//    a crew into the hold tiers rather than leaving them at trim.
const earlyPurse = PLAYER.KILL_GOLD_REWARD * 3 + mapChestAverageSale;
expect(
  'Three kills + one chest sale clear the pocket line and load the hold',
  earlyPurse > CARGO.SAFE_GOLD + CARGO.TIER_THRESHOLDS[1] && cargoTier(cargoGoldFromBanked(earlyPurse)) >= 2,
  `purse=${earlyPurse.toFixed(0)}, safe=${CARGO.SAFE_GOLD}, tiers=${CARGO.TIER_THRESHOLDS.join('/')}`,
);

// 3. The bounty must be raisable by the richest authored prize in the match. The
//    Gilded Strongbox is the one object the whole lobby converges on; if selling
//    it does not put a crew on the chart as the hunted, no 12-minute arc will.
const strongboxSale = WRECK_EVENT.STRONGBOX_VALUE * ECONOMY.CHEST_SELL_MULTIPLIER;
expect(
  'Selling the Gilded Strongbox alone raises the map-wide bounty',
  strongboxSale >= bountyThresholdGold(),
  `strongbox=${strongboxSale.toFixed(0)}, bounty=${bountyThresholdGold()}`,
);

// 4. The gear-up beat: a hull must NOT spawn holding a full magazine. The
//    landing stores ashore are the make-up, so the first minute has a reason
//    to touch land (LANDING_STORES_MIN guarantees the run is never dead).
expect('Spawn kit ships at most 16 cannonballs', SHIP_SPAWN_STORES.cannonball <= 16, `balls=${SHIP_SPAWN_STORES.cannonball}`);
expect('Spawn kit ships at most 8 planks', SHIP_SPAWN_STORES.wood_plank <= 8, `planks=${SHIP_SPAWN_STORES.wood_plank}`);
expect('Spawn kit carries no chainshot and no firebombs', SHIP_SPAWN_STORES.chainshot === 0 && SHIP_SPAWN_STORES.firebomb_ball === 0,
  `chain=${SHIP_SPAWN_STORES.chainshot}, firebomb=${SHIP_SPAWN_STORES.firebomb_ball}`);
expect('A hull sails with at most one powder keg', PLAYER.STARTING_KEGS <= 1, `kegs=${PLAYER.STARTING_KEGS}`);
expect('Landing stores make up what the spawn kit lacks',
  LANDING_STORES_MIN.cannonball >= 6 && LANDING_STORES_MIN.wood_plank >= 3,
  `balls=${LANDING_STORES_MIN.cannonball}, planks=${LANDING_STORES_MIN.wood_plank}`);

// 5. Gold needs a SECOND sink. Every Tallyman line must be affordable off one
//    good chest, or the shop is scenery and gold stays a scoreboard number.
const dearest = Object.entries(SHOP_PRICES).reduce((a, b) => (b[1] > a[1] ? b : a));
expect(
  'Every Tallyman line costs at most one mean chest sale',
  dearest[1] <= mapChestAverageSale,
  `dearest=${dearest[0]}@${dearest[1]}, chest=${mapChestAverageSale.toFixed(0)}`,
);
expect('The Tallyman stocks the nine-line table (consumables, hull, sails, armor)', Object.keys(SHOP_PRICES).length >= 9,
  `lines=${Object.keys(SHOP_PRICES).length}`);

if (failures > 0) {
  console.error(`\n${failures} game-balance assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll game-balance assertions passed.');
