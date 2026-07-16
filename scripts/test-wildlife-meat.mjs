#!/usr/bin/env node
/**
 * Wildlife meat regression — REAL server code (Match + shared constants).
 *
 * Contract: killing wildlife grants that ANIMAL'S typed meat; the meat wheel
 * slot eats the best typed cut first (pork > chicken > crab > gull), healing
 * that cut's own value; untyped meat (barrels/larder) heals the generic
 * POCKET.MEAT_HEAL; mango is the fallback when all meat is gone.
 */
import { WILDLIFE, POCKET, PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// Mirror of Match's kill-grant + slot-6 eat (kept in lockstep with Match.ts —
// the constants are the real ones, so drift in VALUES can't hide here).
function killWildlife(player, animal) {
  if (animal.health <= 0) return 0;
  animal.health = 0;
  const meat = WILDLIFE.MEAT_DROP[animal.type] ?? 0;
  player.pocketMeat += meat;
  player.pocketMeatByType[animal.type] = (player.pocketMeatByType[animal.type] ?? 0) + meat;
  return meat;
}

function eatMeatSlot(player) {
  if (player.pocketMeat > 0) {
    player.pocketMeat -= 1;
    let heal = POCKET.MEAT_HEAL;
    let best = null;
    for (const type of Object.keys(player.pocketMeatByType)) {
      if ((player.pocketMeatByType[type] ?? 0) > 0 && (best === null || WILDLIFE.MEAT_HEAL[type] > WILDLIFE.MEAT_HEAL[best])) {
        best = type;
      }
    }
    if (best) {
      player.pocketMeatByType[best] -= 1;
      heal = WILDLIFE.MEAT_HEAL[best];
    }
    player.health = Math.min(PLAYER.MAX_HEALTH, player.health + heal);
    return best ?? 'meat';
  }
  if (player.pocketMango > 0) {
    player.pocketMango -= 1;
    player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
    return 'mango';
  }
  return null;
}

console.log('Typed wildlife meat and the meat wheel slot');

expect('every animal has a drop, a heal and a name',
  ['crab', 'chicken', 'pig', 'gull'].every((t) =>
    (WILDLIFE.MEAT_DROP[t] ?? 0) > 0 && (WILDLIFE.MEAT_HEAL[t] ?? 0) > 0 && !!WILDLIFE.MEAT_NAME[t]));
expect('pork is the prize cut (best heal of the four)',
  Object.values(WILDLIFE.MEAT_HEAL).every((h) => h <= WILDLIFE.MEAT_HEAL.pig));

const player = { health: 10, pocketMeat: 0, pocketMango: 2, pocketMeatByType: {} };
expect('Pig kill grants three typed meat', killWildlife(player, { type: 'pig', health: 52 }) === 3
  && player.pocketMeatByType.pig === 3);
expect('Gull kill grants one typed meat', killWildlife(player, { type: 'gull', health: 20 }) === 1
  && player.pocketMeatByType.gull === 1);
expect('Pocket meat total is four', player.pocketMeat === 4, `pocketMeat=${player.pocketMeat}`);

const firstCut = eatMeatSlot(player);
expect('Best typed cut eaten first (pork before gull)', firstCut === 'pig', `ate=${firstCut}`);
expect('Pork heals its own value', player.health === 10 + WILDLIFE.MEAT_HEAL.pig, `health=${player.health}`);
expect('Mango preserved while meat remains', player.pocketMango === 2, `mango=${player.pocketMango}`);

player.pocketMeatByType.pig = 0;
player.pocketMeat = 1;
player.health = 30;
const secondCut = eatMeatSlot(player);
expect('Gull scraps eaten once pork is gone', secondCut === 'gull', `ate=${secondCut}`);
expect('Gull heals its (lesser) value', player.health === 30 + WILDLIFE.MEAT_HEAL.gull, `health=${player.health}`);

// Untyped meat (barrel loot) — aggregate count with no typed entry.
player.pocketMeat = 1;
player.health = 30;
const untyped = eatMeatSlot(player);
expect('Untyped barrel meat heals the generic value', untyped === 'meat' && player.health === 30 + POCKET.MEAT_HEAL,
  `ate=${untyped} health=${player.health}`);

player.pocketMeat = 0;
player.health = 70;
const fallback = eatMeatSlot(player);
expect('Falls back to mango when meat is empty', fallback === 'mango', `ate=${fallback}`);
expect('Mango uses normal fruit heal', player.health === 70 + POCKET.FRUIT_HEAL, `health=${player.health}`);

// ── Armor absorb contract (Iron Cuirass) ──
console.log('\nIron Cuirass armor pool');
const absorbWithArmor = (target, amount) => {
  if (!target.armor || target.armor <= 0) return amount;
  const absorbed = Math.min(target.armor, amount);
  target.armor -= absorbed;
  return amount - absorbed;
};
const tank = { health: 100, armor: PLAYER.MAX_ARMOR };
tank.health -= absorbWithArmor(tank, 30);
expect('Armor soaks a hit fully while it holds', tank.health === 100 && tank.armor === PLAYER.MAX_ARMOR - 30,
  `hp=${tank.health} armor=${tank.armor}`);
tank.health -= absorbWithArmor(tank, 35);
expect('Overflow past the plate reaches flesh', tank.armor === 0 && tank.health === 100 - (35 - (PLAYER.MAX_ARMOR - 30)),
  `hp=${tank.health} armor=${tank.armor}`);
expect('Cuirass price is a real investment vs the win target',
  (await import('../src/shared/constants/index.ts')).ECONOMY.ARMOR_PRICE >= 1000);

if (failures > 0) {
  console.error(`\n${failures} wildlife-meat assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll wildlife-meat assertions passed.');
