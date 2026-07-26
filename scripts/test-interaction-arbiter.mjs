#!/usr/bin/env node
// THE [X] CONTRACT — what the prompt says is what the press does.
//
// Guards the two halves of "X-key overload steals stations":
//   CLIENT: the look arbiter must give a station inside arm's reach to the
//     pirate standing at it, must hand the HUD and the input packet the SAME
//     winner, and must not flip between two near-tied candidates.
//   SERVER: [X] at a ladder LATCHES (a press is an intention, not a
//     single-frame assertion), feet on your own deck board you, and a captain
//     at the wheel can weigh anchor without leaving the helm.
import * as THREE from 'three';
import { InteractionPrompts } from '../src/client/systems/InteractionPrompts.ts';
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  getShipFloorYAt,
  isStandingOnShipDeck,
  isSwimBoardingOwnHull,
  toShipWorldPoint,
} from '../src/shared/interactions.ts';
import { getBraceStationLocals, getNearestShipBoardingLadder } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The look arbiter, on a real hull ───────────────────────────────────────
console.log('\nLook arbiter (client)');

function makeArbiter(shipType) {
  const ship = {
    id: 'ship-1', type: shipType, alive: true, sinking: false,
    position: { x: 40, y: 1.4, z: -12 }, rotation: 0.6,
    sailHeight: 0.4, sailAngle: 0, sailIntegrity: 1, anchored: true, anchorRaiseProgress: 0,
    waterLevel: 0, holes: [], upgrades: [], inventory: [], crewIds: [], cannonCooldowns: [],
  };
  const stats = SHIP_STATS[shipType];
  const player = {
    id: 'p1', shipId: ship.id, onShipId: ship.id, state: 'alive',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 },
    atHelm: false, atCannon: false, atCrowNest: false, mastClimb: null,
    weapons: [], activeSlot: 0, equippedTool: null, pocketWood: 0, pocketOre: 0,
    nearChestId: null, nearBarrelId: null, nearShipId: null, carryingChestId: null,
    bucketFilled: false, gold: 0, armor: 0, treasureMapIslandId: null, hasShovel: false,
  };
  const view = {
    ui: { interactPrompt: { style: {}, textContent: '', addEventListener() {} } },
    state: { players: [player], ships: [ship], islands: [], kegs: [] },
    barrelBrowse: null, tavernDoors: [], visibleInteractKind: null, lastInteractKind: null,
    mermaidAnchor: null, pendingInteractFromUi: false, pendingLaunchFromUi: false,
    createMermaidAnchor: () => ({ x: 0, z: 0, shipId: ship.id }),
    findChestById: () => null,
    findHarvestTarget: () => null,
    findNearbyKeg: () => null,
    findRepairableHole: () => null,
    getBarrelWorldPoint: () => null,
    getChestWorldPoint: () => null,
    getInventoryQty: () => 0,
    getLocalPlayer: () => player,
    getLookDirection: (p) => new THREE.Vector3(
      Math.sin(p.rotation.x) * Math.cos(p.rotation.y),
      Math.sin(p.rotation.y),
      Math.cos(p.rotation.x) * Math.cos(p.rotation.y),
    ).normalize(),
    getMermaidReturnShip: () => null,
    getNearbyGoldHoarder: () => null,
    getNearbyUpgradeStation: () => null,
    getRepairPlankCount: () => 0,
    getHoleRepairWorldPoint: () => new THREE.Vector3(),
    getShipWorldPoint: (s, lx, lz, worldY) => {
      const w = toShipWorldPoint({ x: lx, z: lz }, s);
      return new THREE.Vector3(w.x, s.position.y + worldY, w.z);
    },
    getTavernDoorWorldPoint: (door, out) => out,
    getTrackedShip: () => ship,
    getUpgradePresentation: () => ({ name: '', short: '', icon: '', color: '', hex: 0, effect: '' }),
  };
  const prompts = new InteractionPrompts(view);
  /** Stand at a ship-local spot on the weather deck. */
  const standAt = (lx, lz) => {
    const w = toShipWorldPoint({ x: lx, z: lz }, ship);
    player.position.x = w.x;
    player.position.z = w.z;
    player.position.y = getShipFloorYAt({ x: w.x, y: ship.position.y + stats.height + 4, z: w.z }, ship) + 0.02;
  };
  /** Aim the eye at a ship-local point `worldY` above the hull origin. */
  const lookAt = (lx, lz, worldY) => {
    const w = toShipWorldPoint({ x: lx, z: lz }, ship);
    const eyeY = player.position.y + 1.8 * 0.72;
    const dx = w.x - player.position.x;
    const dz = w.z - player.position.z;
    player.rotation.x = Math.atan2(dx, dz);
    player.rotation.y = Math.atan2(ship.position.y + worldY - eyeY, Math.hypot(dx, dz));
  };
  const resolve = () => prompts.getLookInteraction(player, ship, null, null);
  return { ship, stats, player, prompts, standAt, lookAt, resolve };
}

for (const type of ['sloop', 'brigantine', 'galleon']) {
  const rig = makeArbiter(type);
  const helmZ = -rig.stats.length * SHIP.HELM_LOCAL_Z_F;
  const brace = getBraceStationLocals(rig.stats)[0];

  // Standing a metre off the wheel, LOOKING AT THE WHEEL: the helm owns [X],
  // whatever the brace rails score. (Before: the brace 2 m away won on dot.)
  rig.standAt(0, helmZ + 1.0);
  rig.lookAt(0, helmZ, rig.stats.height + 0.95);
  await sleep(45);
  const atWheel = rig.resolve();
  expect(`${type}: 1m from the wheel looking at it → [X] takes the helm`,
    atWheel?.kind === 'helm', `got ${atWheel?.kind ?? 'nothing'} — "${atWheel?.prompt ?? ''}"`);

  // Standing AT a brace rail looking at it still braces — reach cuts both ways.
  rig.standAt(brace.x, brace.z + 0.3);
  rig.lookAt(brace.x, brace.z, rig.stats.height + 0.7);
  await sleep(45);
  const atBrace = rig.resolve();
  expect(`${type}: at the brace rail looking at it → [X] braces the yard`,
    atBrace?.kind === 'brace', `got ${atBrace?.kind ?? 'nothing'}`);

  // The HUD pass and the input pass of one frame must agree, always.
  rig.standAt(0, helmZ + 1.0);
  rig.lookAt(0, helmZ, rig.stats.height + 0.95);
  await sleep(45);
  const hudPass = rig.resolve();
  const inputPass = rig.prompts.resolveCurrentInteractKind();
  expect(`${type}: the HUD prompt and the wire intent name the same station`,
    hudPass?.kind === inputPass, `prompt=${hudPass?.kind} intent=${inputPass}`);

  // Hysteresis: a hair of look drift must not hand [X] to another station.
  let flips = 0;
  let previous = hudPass?.kind ?? null;
  for (let i = 0; i < 24; i++) {
    rig.player.rotation.x += (i % 2 === 0 ? 1 : -1) * 0.035;
    rig.player.rotation.y += (i % 2 === 0 ? 1 : -1) * 0.02;
    await sleep(42);
    const kind = rig.resolve()?.kind ?? null;
    if (kind !== previous) flips += 1;
    previous = kind;
  }
  expect(`${type}: jittering the look at the wheel never flips the offer`, flips === 0, `${flips} flips`);
}

// ── Boarding: the press is an intention (server) ───────────────────────────
console.log('\nBoarding grants (server)');

const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
const match = new Match({ matchId: 'arbiter-board', botCount: 0 });
const state = match['state'];
const { playerId, shipId } = match.addHumanClient(ws, 'Boarder');
const client = match['clients'].get(playerId);
const player = match['playersById'].get(playerId);
const ship = state.ships.find((s) => s.id === shipId);
const stats = SHIP_STATS[ship.type];

let seq = 0;
const input = (over = {}) => ({
  seq: (seq += 1), ts: 0,
  forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
  fire: false, useItem: false, crouch: false, aim: false, interact: false, interactHeld: false,
  anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
  trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
  slot: null, cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null, ...over,
});
const step = (over = {}, ticks = 1, dt = 1 / 62.5) => {
  for (let i = 0; i < ticks; i++) {
    match['t'] += dt;
    match['applyInput'](client, input(over), dt);
  }
};
/** Put the swimmer at a world XZ beside the hull. */
const placeSwimmer = (lx, lz) => {
  const w = toShipWorldPoint({ x: lx, z: lz }, ship);
  player.onShipId = null;
  player.state = 'swimming';
  player.atHelm = false;
  player.position.x = w.x;
  player.position.z = w.z;
  player.position.y = ship.position.y - 0.1;
  player.nearShipId = null;
};

/** One [X] with the board intent, clear of the server's one-shot throttle. */
const pressBoard = () => {
  match['t'] += 0.3;
  step({ interact: true, interactHeld: true, interactIntent: 'board' });
};

// A press 4.2m off the rungs — outside the instant grant, inside the latch —
// must still put her aboard as she drifts in, with no second press.
{
  placeSwimmer(stats.width * 0.56 + 4.2, -stats.length * 0.18);
  const ladderNow = getNearestShipBoardingLadder(ship, player.position);
  pressBoard();
  const boardedInstantly = player.onShipId !== null;
  // Drift onto the rungs while the latch is live — no further presses.
  const w = toShipWorldPoint({ x: stats.width * 0.56 + 2.6, z: -stats.length * 0.18 }, ship);
  player.position.x = w.x;
  player.position.z = w.z;
  step({}, 8);
  expect('a press just outside the rungs is queued, not eaten',
    !boardedInstantly && player.onShipId === ship.id,
    `pressDistance=${ladderNow.distance.toFixed(2)} instant=${boardedInstantly} onShip=${player.onShipId}`);
}

// The latch is not a free ride: it expires.
{
  placeSwimmer(0, stats.length * 0.9); // far off the bow, nothing boardable
  match['boardLatchUntil'].delete(player.id);
  pressBoard();
  expect('a press with no hull in reach queues nothing',
    !match['boardLatchUntil'].has(player.id), 'latched from open water');
}

// Own hull, anywhere along it: bow, stern and the far rail all answer.
{
  for (const [name, local] of [
    ['bow', { x: 0, z: stats.length * 0.5 }],
    ['stern', { x: 0, z: -stats.length * 0.5 }],
    ['port rail amidships', { x: -stats.width * 0.62, z: 0 }],
  ]) {
    placeSwimmer(local.x, local.z);
    expect(`swimmer at the ${name} of her own hull counts as at the ship`,
      isSwimBoardingOwnHull(player, ship), `local ${JSON.stringify(local)}`);
    pressBoard();
    expect(`[X] at the ${name} climbs aboard`, player.onShipId === ship.id, `onShip=${player.onShipId}`);
  }
}

// Gangway walk-on: feet on your own deck IS being aboard.
{
  const w = toShipWorldPoint({ x: 0.2, z: -stats.length * 0.1 }, ship);
  player.onShipId = null;
  player.state = 'alive';
  player.position.x = w.x;
  player.position.z = w.z;
  player.position.y = getShipFloorYAt({ x: w.x, y: ship.position.y + stats.height + 4, z: w.z }, ship) + 0.05;
  expect('the deck-footing predicate sees her on the planking', isStandingOnShipDeck(player, ship));
  step({}, 6, 0.1);
  expect('half a second on your own deck auto-boards you', player.onShipId === ship.id, `onShip=${player.onShipId}`);
}

// ── The anchored-helm dead end ─────────────────────────────────────────────
console.log('\nWeighing anchor from the wheel (server)');
{
  const helmWorld = toShipWorldPoint({ x: 0, z: -stats.length * SHIP.HELM_LOCAL_Z_F }, ship);
  player.onShipId = ship.id;
  player.state = 'alive';
  player.position.x = helmWorld.x;
  player.position.z = helmWorld.z;
  player.position.y = ship.position.y + stats.height + 0.4;
  ship.anchored = true;
  ship.anchorRaiseProgress = 0;
  step({ interact: true, interactHeld: false, interactIntent: 'helm' });
  expect('[X] at the wheel takes the helm', player.atHelm === true);

  const seconds = SHIP.ANCHOR_RAISE_TIME * 1.35 + 0.6;
  step({ forward: true }, Math.ceil(seconds / 0.05), 0.05);
  expect('holding [W] at the helm weighs the anchor', ship.anchored === false,
    `progress=${ship.anchorRaiseProgress?.toFixed(2)}`);
  expect('and the same key then makes sail', ship.sailHeight > 0.05, `sail=${ship.sailHeight.toFixed(2)}`);
}

console.log(failures === 0 ? '\nThe prompt and the press agree.' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
