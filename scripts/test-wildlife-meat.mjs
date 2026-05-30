#!/usr/bin/env node
/**
 * Wildlife meat regression.
 *
 * Mirrors the server contract: killing wildlife gives pocket meat, and the
 * fourth pocket-wheel slot eats meat before mango because meat is the better heal.
 */

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const PLAYER_MAX_HEALTH = 100;
const POCKET_MEAT_HEAL = 36;
const POCKET_FRUIT_HEAL = 22;
const MEAT_DROP = {
  crab: 1,
  chicken: 1,
  pig: 3,
  gull: 1,
};

function killWildlife(player, animal) {
  if (animal.health <= 0) return 0;
  animal.health = 0;
  const meat = MEAT_DROP[animal.type] ?? 0;
  player.pocketMeat += meat;
  return meat;
}

function usePocketSlotFour(player) {
  if (player.pocketMeat > 0) {
    player.pocketMeat -= 1;
    player.health = Math.min(PLAYER_MAX_HEALTH, player.health + POCKET_MEAT_HEAL);
    return 'meat';
  }
  if (player.pocketMango > 0) {
    player.pocketMango -= 1;
    player.health = Math.min(PLAYER_MAX_HEALTH, player.health + POCKET_FRUIT_HEAL);
    return 'mango';
  }
  return null;
}

console.log('Wildlife meat and pocket slot four');

const player = { health: 40, pocketMeat: 0, pocketMango: 2 };
expect('Pig kill grants three meat', killWildlife(player, { type: 'pig', health: 52 }) === 3);
expect('Chicken kill grants one meat', killWildlife(player, { type: 'chicken', health: 28 }) === 1);
expect('Pocket meat total is four', player.pocketMeat === 4, `pocketMeat=${player.pocketMeat}`);

const firstUse = usePocketSlotFour(player);
expect('Slot four consumes meat before mango', firstUse === 'meat', `used=${firstUse}`);
expect('Meat heals by the meat amount', player.health === 76, `health=${player.health}`);
expect('Mango is preserved while meat remains', player.pocketMango === 2, `mango=${player.pocketMango}`);

player.pocketMeat = 0;
player.health = 70;
const secondUse = usePocketSlotFour(player);
expect('Slot four falls back to mango when meat is empty', secondUse === 'mango', `used=${secondUse}`);
expect('Mango uses normal fruit heal', player.health === 92, `health=${player.health}`);

if (failures > 0) {
  console.error(`\n${failures} wildlife-meat assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll wildlife-meat assertions passed.');
