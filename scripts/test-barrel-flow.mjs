#!/usr/bin/env node
/**
 * Barrel browse/take-all regression.
 *
 * First [X] opens a barrel for inspection, which marks it opened but keeps loot
 * inside. The player must still be considered near it so the next [X] can take
 * all. The world mesh should also remain visible until the loot is actually
 * emptied.
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

function isNearInteractableBarrel(player, barrel, interactRange) {
  if (barrel.opened && barrel.loot.length === 0) return false;
  const dx = player.position.x - barrel.position.x;
  const dz = player.position.z - barrel.position.z;
  return Math.sqrt(dx * dx + dz * dz) < interactRange;
}

function shouldShowBarrelMesh(barrel) {
  return !barrel.opened || barrel.loot.length > 0;
}

console.log('Barrel browse/take-all flow');

const player = { position: { x: 0.6, y: 0, z: 0.4 } };
const barrel = {
  id: 'barrel_1',
  position: { x: 0, y: 0, z: 0 },
  opened: false,
  loot: [{ item: 'banana', qty: 2 }],
};
const range = 3;

expect('Closed barrel is interactable nearby', isNearInteractableBarrel(player, barrel, range));
expect('Closed barrel mesh is visible', shouldShowBarrelMesh(barrel));

barrel.opened = true;
expect('Opened barrel with loot remains interactable for Take All', isNearInteractableBarrel(player, barrel, range));
expect('Opened barrel with loot remains visible', shouldShowBarrelMesh(barrel));

barrel.loot = [];
expect('Emptied barrel is no longer interactable', !isNearInteractableBarrel(player, barrel, range));
expect('Emptied barrel mesh hides', !shouldShowBarrelMesh(barrel));

if (failures > 0) {
  console.error(`\n${failures} barrel-flow assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll barrel-flow assertions passed.');
