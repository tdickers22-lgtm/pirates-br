#!/usr/bin/env node
// Axe harvest + upgrade material costs, end-to-end against the real Match:
//   1. wheel slot 9 equips the axe (and toggles it away again)
//   2. swinging at a palm for CHOP_TIME fells it: pocket wood granted in the
//      HARVEST band, the prop spliced out of island.props, and a prop_removed
//      broadcast (with the yield) queued to every client
//   3. same for a boulder → pocket ore
//   4. progress resets when the swing stops (no banked half-chops)
//   5. upgrade-station claims are gated on UPGRADE_COSTS and consume the
//      materials (pocket first, then ship stores) on success
import { Match } from '../src/server/core/Match.ts';
import { HARVEST, UPGRADE_COSTS } from '../src/shared/constants/index.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 60;

function makeFakeWs(sink = null) {
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send(data) { if (sink) sink.push(JSON.parse(data)); },
    close() {},
  };
}

function makeInput(seq, overrides = {}) {
  return {
    seq, ts: 0,
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, fire: false, useItem: false, aim: false,
    interact: false, interactHeld: false,
    anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
    trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
    slot: null, cannonAmmo: null, yaw: 0, pitch: 0,
    wheelIndex: null, useWheelItem: false, barrelTakeAll: false,
    interactIntent: null,
    ...overrides,
  };
}

const messages = [];
const match = new Match({ matchId: 'harvest-test', botCount: 0 });
const state = match.state;
state.phase = 'playing';
const joined = match.addHumanClient(makeFakeWs(messages), 'Harvester');
const client = match.clients.get(joined.playerId);
const player = state.players.find((p) => p.id === joined.playerId);
const homeShip = state.ships.find((s) => s.id === joined.shipId);
let seq = 1;

/** Drive one applyInput frame; sim time bumps past the one-shot min interval. */
function frame(overrides) {
  match.t += 0.5;
  match.applyInput(client, makeInput(seq++, overrides), DT);
}

function placeOnIslandAt(island, x, z) {
  player.state = 'alive';
  player.onShipId = null;
  player.atCannon = false; player.atHelm = false; player.atSails = false; player.atCrowNest = false;
  player.mastClimb = null;
  player.carryingChestId = null;
  player.position = { x, y: getIslandSurfaceY(island, x, z), z };
}

const findProp = (predicate) => {
  for (const island of state.islands) {
    for (const prop of island.props ?? []) {
      if (predicate(prop)) return { island, prop };
    }
  }
  return null;
};

// ────────────────────────────────────────────────────────────────────────────
console.log('1. Wheel slot 9 equips the axe');

frame({ useWheelItem: true, wheelIndex: 9 });
expect('slot 9 equips the axe', player.equippedTool === 'axe', `tool=${player.equippedTool}`);
match.t += 1; // clear the equip-toggle grace window
frame({ useWheelItem: true, wheelIndex: 9 });
expect('slot 9 again stows it', player.equippedTool === null, `tool=${player.equippedTool}`);
frame({ useWheelItem: true, wheelIndex: 9 });
expect('...and re-equips', player.equippedTool === 'axe');

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. Chopping a palm grants wood + removes the prop + broadcasts');

const palmHit = findProp((p) => p.type.startsWith('palm_') && p.type !== 'palm_ground' && p.id !== undefined);
expect('world has a standing palm with a prop id', !!palmHit);
{
  const { island, prop } = palmHit;
  const countBefore = island.props.length;
  placeOnIslandAt(island, prop.x + 1.2, prop.z);
  messages.length = 0;
  const woodBefore = player.pocketWood;
  const chopTicks = Math.ceil((HARVEST.CHOP_TIME + 0.1) / DT);
  for (let i = 0; i < chopTicks; i++) frame({ useItem: true });

  const gained = player.pocketWood - woodBefore;
  expect('palm yields wood in the HARVEST band',
    gained >= HARVEST.WOOD_PER_TREE_MIN && gained <= HARVEST.WOOD_PER_TREE_MAX, `wood=${gained}`);
  expect('felled palm removed from island.props',
    island.props.length === countBefore - 1 && !island.props.includes(prop),
    `props ${countBefore} → ${island.props.length}`);
  const removal = messages.find((m) => m.type === 'prop_removed');
  expect('prop_removed broadcast queued with the yield',
    !!removal
      && removal.payload.islandId === island.id
      && removal.payload.propId === prop.id
      && removal.payload.propType === prop.type
      && removal.payload.byPlayerId === player.id
      && removal.payload.wood === gained,
    JSON.stringify(removal?.payload ?? null));
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Released swing resets progress (no banked half-chops)');

const palmHit2 = findProp((p) => p.type.startsWith('palm_') && p.type !== 'palm_ground' && p.id !== undefined);
{
  const { island, prop } = palmHit2;
  placeOnIslandAt(island, prop.x + 1.2, prop.z);
  const halfTicks = Math.ceil((HARVEST.CHOP_TIME * 0.6) / DT);
  for (let i = 0; i < halfTicks; i++) frame({ useItem: true });
  expect('mid-chop the palm still stands', island.props.includes(prop));
  frame({ useItem: false }); // release — progress must reset
  for (let i = 0; i < halfTicks; i++) frame({ useItem: true });
  expect('a fresh 60% chop after releasing does NOT fell it (progress reset)',
    island.props.includes(prop));
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. Mining a boulder grants ore');

const boulderHit = findProp((p) => p.type.startsWith('boulder_') && p.id !== undefined);
expect('world has a boulder with a prop id', !!boulderHit);
{
  const { island, prop } = boulderHit;
  placeOnIslandAt(island, prop.x + 1.4, prop.z);
  messages.length = 0;
  const oreBefore = player.pocketOre;
  // CHOP_TIME of swinging must NOT crack it (boulders take MINE_TIME).
  for (let i = 0; i < Math.ceil(HARVEST.CHOP_TIME / DT); i++) frame({ useItem: true });
  expect('boulder outlasts CHOP_TIME (mining is slower)', island.props.includes(prop));
  for (let i = 0; i < Math.ceil((HARVEST.MINE_TIME - HARVEST.CHOP_TIME + 0.1) / DT); i++) frame({ useItem: true });

  const gained = player.pocketOre - oreBefore;
  expect('boulder yields ore in the HARVEST band',
    gained >= HARVEST.ORE_PER_BOULDER_MIN && gained <= HARVEST.ORE_PER_BOULDER_MAX, `ore=${gained}`);
  expect('cracked boulder removed from island.props', !island.props.includes(prop));
  const removal = messages.find((m) => m.type === 'prop_removed');
  expect('prop_removed broadcast carries the ore yield',
    !!removal && removal.payload.propId === prop.id && removal.payload.ore === gained,
    JSON.stringify(removal?.payload ?? null));
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Upgrade claims cost materials');

{
  const stationIsland = state.islands.find((i) => i.upgradeStations.length > 0);
  expect('world has an upgrade station', !!stationIsland);
  const station = stationIsland.upgradeStations[0];
  const cost = UPGRADE_COSTS[station.type];
  placeOnIslandAt(stationIsland, station.position.x + 0.8, station.position.z);
  player.equippedTool = null;
  player.pocketWood = 0;
  player.pocketOre = 0;
  homeShip.inventory = homeShip.inventory.filter((s) => s.item !== 'wood_plank' && s.item !== 'ore');

  messages.length = 0;
  frame({ interact: true, interactIntent: 'upgrade' });
  expect('claim with no materials is refused',
    station.claimedByShipId !== homeShip.id && homeShip.upgrades.length === 0,
    `claimedBy=${station.claimedByShipId}`);

  // Split the recipe across pocket and ship stores to prove both pools drain
  // (pocket first, remainder from the stacks).
  player.pocketWood = cost.wood - 1;
  player.pocketOre = 1;
  match.islands.addItemToShipInventory(homeShip, 'wood_plank', 3);
  match.islands.addItemToShipInventory(homeShip, 'ore', cost.ore - 1);

  frame({ interact: true, interactIntent: 'upgrade' });
  expect('funded claim succeeds', station.claimedByShipId === homeShip.id
    && homeShip.upgrades.some((u) => u.type === station.type));
  expect('pocket wood drained first', player.pocketWood === 0, `pocketWood=${player.pocketWood}`);
  expect('pocket ore drained first', player.pocketOre === 0, `pocketOre=${player.pocketOre}`);
  const planks = homeShip.inventory.find((s) => s.item === 'wood_plank')?.qty ?? 0;
  const shipOre = homeShip.inventory.find((s) => s.item === 'ore')?.qty ?? 0;
  expect('ship planks cover the remainder', planks === 3 - 1, `planks=${planks}`);
  expect('ship ore stack fully consumed', shipOre === 0, `ore=${shipOre}`);
  const upgraded = messages.find((m) => m.type === 'ship_upgraded');
  expect('ship_upgraded broadcast carries the cost',
    !!upgraded && upgraded.payload.costWood === cost.wood && upgraded.payload.costOre === cost.ore,
    JSON.stringify(upgraded?.payload ?? null));
}

if (failures > 0) {
  console.error(`\n${failures} harvest assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll harvest/upgrade-cost assertions passed.');
