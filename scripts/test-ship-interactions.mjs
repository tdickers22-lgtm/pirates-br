#!/usr/bin/env node
import * as THREE from 'three';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { InteractionPrompts } from '../src/client/systems/InteractionPrompts.ts';
import {
  findRepairableHole,
  getBilgePumpLocal,
  isNearBilgePump,
  findNearbyCannonIndex,
  getAnchorControlLocal,
  getCannonDeckLocalPosition,
  getSailControlLocal,
  isNearAnchor,
  isNearCrowNestLadder,
  isNearHelm,
  isNearSailStation,
  toShipWorldPoint,
} from '../src/shared/interactions.ts';
import { getMainMastLocalZ, getShipHoldFloorY } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const ship = {
  id: 'ship-test',
  type: 'galleon',
  position: { x: 120, y: 1.5, z: -80 },
  rotation: Math.PI * 0.18,
};
const stats = SHIP_STATS[ship.type];

function playerAt(local, extra = {}) {
  const world = toShipWorldPoint(local, ship);
  return {
    onShipId: ship.id,
    position: {
      x: world.x,
      y: ship.position.y + stats.height + 0.1,
      z: world.z,
    },
    ...extra,
  };
}

console.log('Shared ship interaction predicates');

expect('Helm prompt and server validation share one predicate', isNearHelm(playerAt({ x: 0, z: -stats.length * 0.37 }), ship));
expect('Sail ring predicate accepts the shared sail control point', isNearSailStation(playerAt(getSailControlLocal(stats)), ship));
expect('Anchor predicate accepts the shared capstan point', isNearAnchor(playerAt(getAnchorControlLocal(stats)), ship));
expect(
  'Crow ladder predicate accepts the main mast ladder band',
  isNearCrowNestLadder(playerAt({ x: 0.1, z: getMainMastLocalZ(stats) }), ship),
);

const cannonLocal = getCannonDeckLocalPosition(stats, 0);
expect('Cannon index resolves when standing at cannon deck point', findNearbyCannonIndex(playerAt(cannonLocal), ship) === 0);
expect('Wrong ship never validates helm', !isNearHelm({ ...playerAt({ x: 0, z: -stats.length * 0.37 }), onShipId: 'other' }, ship));
expect('Low/below-deck sail ring position is rejected', !isNearSailStation(playerAt(getSailControlLocal(stats), {
  position: {
    ...playerAt(getSailControlLocal(stats)).position,
    y: ship.position.y + stats.height - 0.5,
  },
}), ship));

// ────────────────────────────────────────────────────────────────────────────
// A STATION THE SERVER ACCEPTS HAS A PROMPT ON SCREEN.
//
// SINK-01 slice c shipped the bilge pump (Match.applyBilgePump + the shared
// isNearBilgePump reach) and the 3D repair reach with NO client affordance:
// nothing outside Match.ts and shared/interactions.ts called isNearBilgePump,
// so the one new reason to go below decks was invisible, and the deck-side [X]
// on a waterline breach stopped painting with no refusal in its place. Drive
// the REAL arbiter, not a copy of it.
console.log('\nThe below-decks stations are offered, and a refusal is painted where the offer used to be');

function resolveAt(player, shipFixture, repairHole = null) {
  const view = {
    ui: { interactPrompt: { style: {}, textContent: '', addEventListener() {} } },
    state: { players: [player], ships: [shipFixture], islands: [], kegs: [] },
    barrelBrowse: null, tavernDoors: [], visibleInteractKind: null, lastInteractKind: null,
    mermaidAnchor: null, pendingInteractFromUi: false, pendingLaunchFromUi: false,
    createMermaidAnchor: () => null,
    findChestById: () => null,
    findHarvestTarget: () => null,
    findNearbyKeg: () => null,
    findRepairableHole: () => repairHole,
    getBarrelWorldPoint: () => null,
    getChestWorldPoint: () => null,
    getInventoryQty: () => 0,
    getLocalPlayer: () => player,
    getLookDirection: () => new THREE.Vector3(0, -1, 0),
    getMermaidReturnShip: () => null,
    getNearbyGoldHoarder: () => null,
    getNearbyUpgradeStation: () => null,
    getRepairPlankCount: () => 0,
    getHoleRepairWorldPoint: () => new THREE.Vector3(),
    // The real thing: a hull-local point in the frame player.position is in.
    getShipReachPoint: (sh, lx, lz, worldY) => {
      const w = toShipWorldPoint({ x: lx, z: lz }, sh);
      return new THREE.Vector3(w.x, worldY, w.z);
    },
    getTavernDoorWorldPoint: (door, out) => out,
    getTrackedShip: () => shipFixture,
    getUpgradePresentation: () => ({ name: '', short: '', icon: '', color: '', hex: 0, effect: '' }),
  };
  return new InteractionPrompts(view).getLookInteraction(player, shipFixture, null, repairHole);
}

function crewman(worldX, worldY, worldZ, extra = {}) {
  return {
    id: 'p1', name: 'Hand', shipId: ship.id, onShipId: ship.id, state: 'alive',
    position: { x: worldX, y: worldY, z: worldZ }, rotation: { x: 0, y: 0 },
    atHelm: false, atCannon: false, atCrowNest: false, mastClimb: null,
    weapons: [], activeSlot: 0, equippedTool: null, pocketWood: 0, pocketOre: 0,
    nearChestId: null, nearBarrelId: null, nearShipId: null, carryingChestId: null,
    bucketFilled: false, gold: 0, armor: 0, treasureMapIslandId: null, hasShovel: false,
    ...extra,
  };
}

{
  const pumped = { ...ship, pitch: 0, roll: 0, alive: true, sinking: false, waterLevel: 0.42, holes: [], upgrades: [] };
  const pumpLocal = getBilgePumpLocal(stats);
  const pumpWorld = toShipWorldPoint(pumpLocal, pumped);
  const atPump = crewman(pumpWorld.x, getShipHoldFloorY(pumped.position.y) + 0.1, pumpWorld.z);
  expect('the fixture really is standing at the brake (the shared reach the SERVER validates)',
    isNearBilgePump(atPump, pumped));
  const offered = resolveAt(atPump, pumped);
  expect('...and [X] offers the pump there',
    offered?.kind === 'bail' && /Bilge Pump/.test(offered.prompt ?? ''),
    `got ${offered?.kind ?? 'nothing'}: ${offered?.prompt ?? ''}`);
}

{
  // A breach on the waterline strake, worked from the weather deck above it.
  const holed = {
    ...ship, pitch: 0, roll: 0, alive: true, sinking: false, waterLevel: 0, upgrades: [],
    holes: [{ id: 1, x: stats.width * 0.45, y: 0.05, z: 0, patched: false, tier: 0 }],
    nextHoleId: 2,
  };
  const onDeck = playerAt({ x: stats.width * 0.45, z: 0 });
  expect('a waterline breach is genuinely out of reach from the deck above it (the 3D reach)',
    findRepairableHole(onDeck.position, holed) === null);
  const refusal = resolveAt(crewman(onDeck.position.x, onDeck.position.y, onDeck.position.z), holed);
  expect('...so the prompt says where the work is instead of going blank',
    refusal?.kind === 'info' && /below the waterline/i.test(refusal.prompt ?? ''),
    `got ${refusal?.kind ?? 'nothing'}: ${refusal?.prompt ?? ''}`);
}

if (failures > 0) {
  console.error(`\n${failures} ship-interaction assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll ship-interaction assertions passed.');
