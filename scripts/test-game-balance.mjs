#!/usr/bin/env node
import { ECONOMY, PLAYER, STORM_PHASES } from '../src/shared/constants/index.ts';

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

if (failures > 0) {
  console.error(`\n${failures} game-balance assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll game-balance assertions passed.');
