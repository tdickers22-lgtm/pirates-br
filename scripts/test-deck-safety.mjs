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
import { getCannonDeckLocalPosition } from '../src/shared/interactions.ts';
import { getShipCompanionwayConfig, getShipDeckWalkHalfWidth } from '../src/shared/utils/index.ts';

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
  const liveDeckY = ship.position.y + stats.height + 0.1;
  const cw = getShipCompanionwayConfig(stats);
  const floorAt = (lx, lz) => match.physics.getShipFloorY(
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
}

console.log(failures === 0 ? '\nAll deck safety assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
