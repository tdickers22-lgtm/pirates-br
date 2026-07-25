#!/usr/bin/env node
// Deck safety, end-to-end against the real Match/PhysicsSystem:
//  1. Mounting EVERY cannon on every hull keeps the gunner ON DECK — no
//     coaming eject, no drop into the hold or the sea ("use cannon put me
//     in the water").
//  2. The companionway floor descends across its WHOLE footprint (no
//     glass floor over the stairwell), and only there — stand points and
//     open deck stay at deck level.
import { Match } from '../src/server/core/Match.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getCannonDeckLocalPosition, getHelmControlLocal, getShipFloorYAt } from '../src/shared/interactions.ts';
import {
  getCrowNestStandingY,
  getMainMastLocalZ,
  getShipCompanionwayConfig,
  getShipDeckRaiseAt,
  getShipDeckWalkHalfWidth,
  getShipDeckY,
  getShipHoldFloorY,
} from '../src/shared/utils/index.ts';

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

for (const type of Object.keys(SHIP_STATS)) {
  console.log(`\n${type}:`);
  const match = new Match({ matchId: `deck-${type}`, botCount: 2 });
  match.state.phase = 'playing';
  const player = match.state.players[0];
  const ship = match.state.ships.find((s) => s.id === player.shipId);
  ship.type = type;
  const stats = SHIP_STATS[type];
  ship.position = { x: 0, y: 0, z: 0 };
  ship.rotation = 0;
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.anchored = true;
  const deckY = ship.position.y + stats.height + 0.1;

  const putOnDeck = (lx, lz) => {
    player.state = 'alive';
    player.onShipId = ship.id;
    player.position = { x: lx, y: deckY, z: lz };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.knockbackVelocity = { x: 0, y: 0, z: 0 };
  };

  // ── 1. Cannon mounts stay on deck ──
  for (let index = 0; index < stats.cannonCount; index++) {
    const stand = getCannonDeckLocalPosition(stats, index);
    putOnDeck(stand.x - Math.sign(stand.x) * 0.4, stand.z);
    const entered = match.enterCannon(player, ship, index, 0, 0);
    expect(`cannon${index}: mount accepted`, entered === true);
    // Let physics chew on the snapped position — an eject shows up fast.
    for (let step = 0; step < 40; step++) {
      match.physics.update(DT, match.t + step * DT, [ship], [player], [], [], [], null);
    }
    const local = { x: player.position.x, z: player.position.z }; // ship at origin, rot 0
    const walkHalf = getShipDeckWalkHalfWidth(stats, local.z);
    const onDeckHeight = player.position.y > deckY - 0.6;
    const insideBulwark = Math.abs(local.x) <= walkHalf + 0.25;
    expect(
      `cannon${index}: gunner stays on deck`,
      player.state === 'alive' && onDeckHeight && insideBulwark,
      `state=${player.state} y=${player.position.y.toFixed(2)} (deckY=${deckY.toFixed(2)}) |x|=${Math.abs(local.x).toFixed(2)} walkHalf=${walkHalf.toFixed(2)}`,
    );
    player.atCannon = false;
    player.cannonIndex = 0;
  }

  // ── 2. Stairwell floor ──
  // The ship has settled to its floating draft during the physics steps above —
  // measure against the LIVE deck height, not the pre-float constant.
  const liveDeckY = getShipDeckY(ship.position.y, stats);
  const cw = getShipCompanionwayConfig(stats);
  const floorAt = (lx, lz) => getShipFloorYAt(
    { x: ship.position.x + lx, y: liveDeckY, z: ship.position.z + lz }, ship);
  const centerFloor = floorAt(cw.cx, cw.cz);
  expect('stairwell centre descends (no glass floor)', centerFloor < liveDeckY - 0.5,
    `floor=${centerFloor.toFixed(2)} deckY=${liveDeckY.toFixed(2)}`);
  // Side entry — one step inside the port edge of the well, halfway down its length.
  const sideFloor = floorAt(cw.cx - cw.stairHalfWidth + 0.15, cw.cz);
  expect('stairwell side entry descends', sideFloor < liveDeckY - 0.3, `floor=${sideFloor.toFixed(2)}`);
  // Open deck right OUTSIDE the well stays at deck level.
  const outsideFloor = floorAt(cw.cx - cw.stairHalfWidth - 0.6, cw.cz);
  expect('deck beside the well stays deck-level', Math.abs(outsideFloor - liveDeckY) < 0.3,
    `floor=${outsideFloor.toFixed(2)} deckY=${liveDeckY.toFixed(2)}`);
  // Every cannon stand point is solid, walkable deck (flat or quarterdeck rise).
  for (let index = 0; index < stats.cannonCount; index++) {
    const stand = getCannonDeckLocalPosition(stats, index);
    const standFloor = floorAt(stand.x, stand.z);
    expect(`cannon${index} stand is solid deck`, standFloor >= liveDeckY - 0.3 && standFloor <= liveDeckY + 1.6,
      `floor=${standFloor.toFixed(2)} deckY=${liveDeckY.toFixed(2)}`);
  }

  // ── 2b. ONE canonical floor function ──
  // Match used to keep its own getShipFloorY that returned the bare deck: it had
  // silently lost the quarterdeck dais and the hold footprint, so held-interact
  // context on the raised helm platform measured a floor ~0.45 m too low. Both
  // callers now read shared getShipFloorYAt — pin the two clauses that diverged.
  const helm = getHelmControlLocal(stats);
  const helmFloor = floorAt(helm.x, helm.z);
  const helmRaise = getShipDeckRaiseAt(helm, stats);
  expect('helm stand sits ON the quarterdeck dais', helmRaise > 0.1 && Math.abs(helmFloor - (liveDeckY + helmRaise)) < 1e-6,
    `floor=${helmFloor.toFixed(3)} deckY=${liveDeckY.toFixed(3)} raise=${helmRaise.toFixed(3)}`);
  // Below the deck line and inside the hold footprint → the hold floor, not the deck.
  const holdY = getShipHoldFloorY(ship.position.y);
  const belowDeck = getShipFloorYAt(
    { x: ship.position.x, y: liveDeckY - 1.2, z: ship.position.z + cw.stairBackZ - 1 }, ship);
  expect('under the deck, amidships, the floor is the HOLD', Math.abs(belowDeck - holdY) < 1e-6,
    `floor=${belowDeck.toFixed(3)} holdY=${holdY.toFixed(3)}`);
}

// ── 3. The crow's nest is a walkable FLOOR: Space works up there ──
// PhysicsSystem already treats the basket as a floor (gravity + velocity.y run,
// WASD clamped to the disc). Match owns the other half: the nest must not be in
// `jumpBlocked`, and `grounded` must measure against the BASKET, not the deck
// ~15m below (getShipFloorYAt would report the lookout permanently airborne).
console.log("\ncrow's nest jump:");
{
  const makeFakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });
  const makeInput = (seq, overrides = {}) => ({
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
  });

  for (const type of Object.keys(SHIP_STATS)) {
    const match = new Match({ matchId: `nest-${type}`, botCount: 0 });
    match.state.phase = 'playing';
    const joined = match.addHumanClient(makeFakeWs(), 'Lookout');
    const client = match.clients.get(joined.playerId);
    const player = match.state.players.find((p) => p.id === joined.playerId);
    const ship = match.state.ships.find((s) => s.id === joined.shipId);
    ship.type = type;
    const stats = SHIP_STATS[type];
    ship.position = { x: 0, y: 0, z: 0 };
    ship.rotation = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.anchored = true;

    const mastZ = getMainMastLocalZ(stats);
    const nestY = () => ship.position.y + getCrowNestStandingY(stats);
    const standInNest = () => {
      player.state = 'alive';
      player.onShipId = ship.id;
      player.atCrowNest = true;
      player.atHelm = false; player.atCannon = false;
      player.mastClimb = null;
      player.position = { x: 0, y: nestY(), z: mastZ };
      player.velocity = { x: 0, y: 0, z: 0 };
      player.knockbackVelocity = { x: 0, y: 0, z: 0 };
    };

    // Settle the hull to its floating draft first so nestY() is the live height.
    standInNest();
    for (let i = 0; i < 60; i++) {
      match.physics.update(DT, match.t + i * DT, [ship], [player], [], [], [], null);
    }
    standInNest();

    let seq = 1;
    match.applyInput(client, makeInput(seq++, { jump: true, jumpPressed: true }), DT);
    expect(`${type}: Space at the nest gives upward velocity`, player.velocity.y > 1,
      `vy=${player.velocity.y.toFixed(3)} (nestY=${nestY().toFixed(2)}, y=${player.position.y.toFixed(2)})`);

    // …and the hop is a real arc that lands back on the basket.
    let apex = player.position.y;
    for (let i = 0; i < 240; i++) {
      match.physics.update(DT, match.t + i * DT, [ship], [player], [], [], [], null);
      if (player.position.y > apex) apex = player.position.y;
    }
    expect(`${type}: the hop actually leaves the basket`, apex > nestY() + 0.25,
      `apex-nestY=${(apex - nestY()).toFixed(3)}`);
    expect(`${type}: the lookout lands back on the basket`, Math.abs(player.position.y - nestY()) < 0.05,
      `y-nestY=${(player.position.y - nestY()).toFixed(4)}`);

    // The helm still blocks jumping — dropping atCrowNest from jumpBlocked must
    // not have opened the pinned stations.
    player.atCrowNest = false;
    player.atHelm = true;
    player.velocity = { x: 0, y: 0, z: 0 };
    match.applyInput(client, makeInput(seq++, { jump: true, jumpPressed: true }), DT);
    expect(`${type}: the helm still blocks jumping`, player.velocity.y === 0,
      `vy=${player.velocity.y.toFixed(3)}`);
  }
}

console.log(failures === 0 ? '\nAll deck safety assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
