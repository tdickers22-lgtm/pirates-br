#!/usr/bin/env node
// Every [X]-interactable on deck must own its own space. Regression net for
// "the ships are too cramped — sometimes I don't know what I'm pressing X for"
// and "using the cannon dropped me in the water".
//
// The functional guarantee, checked with the REAL interaction functions:
//  1. Standing at any station's stand point, EXACTLY that station's action
//     matches — no ambiguity about what [X] does where you actually stand.
//  2. Every stand point is on the walkable deck taper.
//  3. Every stand point is clear of the companionway stairwell + coaming
//     colliders (inflated by player radius — the old overboard-eject bug).
//  4. Different-action stand points are at least 1.5 m apart.
import { SHIP_STATS, PLAYER } from '../src/shared/constants/index.ts';
import {
  findNearbyCannonIndex,
  findBraceStationDir,
  getAnchorControlLocal,
  getCannonDeckLocalPosition,
  isNearAnchor,
  isNearCrowNestLadder,
  isNearHelm,
  isNearSailStation,
  toShipWorldPoint,
} from '../src/shared/interactions.ts';
import {
  getSailRopeStationLocals,
  getBraceStationLocals,
  getCrowNestLadderInteractionBounds,
  getShipCompanionwayConfig,
  getShipDeckWalkHalfWidth,
} from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

for (const [type, stats] of Object.entries(SHIP_STATS)) {
  console.log(`\n${type} (W=${stats.width} L=${stats.length}):`);
  const ship = { id: 's1', type, position: { x: 0, y: 0, z: 0 }, rotation: 0 };
  const deckY = stats.height + 0.1;

  const stations = [];
  for (let i = 0; i < stats.cannonCount; i++) {
    const p = getCannonDeckLocalPosition(stats, i);
    stations.push({ name: `cannon${i}`, action: 'cannon', x: p.x, z: p.z });
  }
  const anchor = getAnchorControlLocal(stats);
  stations.push({ name: 'anchor', action: 'anchor', x: anchor.x, z: anchor.z });
  stations.push({ name: 'helm', action: 'helm', x: 0, z: -stats.length * 0.37 });
  for (const [i, s] of getSailRopeStationLocals(stats).entries()) {
    stations.push({ name: `sails${i}`, action: 'sails', x: s.x, z: s.z });
  }
  for (const [i, s] of getBraceStationLocals(stats).entries()) {
    stations.push({ name: `brace${i}`, action: 'brace', x: s.x, z: s.z });
  }
  const ladder = getCrowNestLadderInteractionBounds(stats);
  stations.push({ name: 'crowLadder', action: 'crow', x: 0, z: ladder.mastZ });

  const playerAt = (local) => {
    const w = toShipWorldPoint(local, ship);
    return { position: { x: w.x, y: deckY, z: w.z }, onShipId: ship.id };
  };
  const matchesAt = (local) => {
    const player = playerAt(local);
    const out = [];
    if (findNearbyCannonIndex(player, ship) !== null) out.push('cannon');
    if (isNearAnchor(player, ship)) out.push('anchor');
    if (isNearHelm(player, ship)) out.push('helm');
    if (isNearSailStation(player, ship)) out.push('sails');
    if (findBraceStationDir(player, ship) !== 0) out.push('brace');
    if (isNearCrowNestLadder(player, ship)) out.push('crow');
    return out;
  };

  // 1. Exactly one action matches at each stand point.
  for (const st of stations) {
    const matched = matchesAt(st);
    expect(
      `${st.name}: [X] unambiguous at its stand point`,
      matched.length === 1 && matched[0] === st.action,
      `matched [${matched.join(', ')}] at (${st.x.toFixed(2)}, ${st.z.toFixed(2)})`,
    );
  }

  // 2. Stand points on the walkable deck taper.
  for (const st of stations) {
    const half = getShipDeckWalkHalfWidth(stats, st.z);
    expect(`${st.name}: stand point on walkable deck`, Math.abs(st.x) <= half,
      `|x|=${Math.abs(st.x).toFixed(2)} > half-width ${half.toFixed(2)} at z=${st.z.toFixed(2)}`);
  }

  // 3. Stand points clear of the stairwell + coaming colliders.
  const cw = getShipCompanionwayConfig(stats);
  const reach = {
    minX: cw.cx - cw.stairHalfWidth - 0.05 - PLAYER.RADIUS,
    maxX: cw.cx + cw.stairHalfWidth + 0.05 + PLAYER.RADIUS,
    minZ: cw.stairBackZ - 0.05 - PLAYER.RADIUS,
    maxZ: cw.stairFrontZ,
  };
  for (const st of stations) {
    const inside = st.x > reach.minX && st.x < reach.maxX && st.z > reach.minZ && st.z < reach.maxZ;
    expect(`${st.name}: stand point clear of stairwell+coamings`, !inside,
      `(${st.x.toFixed(2)}, ${st.z.toFixed(2)}) inside x[${reach.minX.toFixed(2)}..${reach.maxX.toFixed(2)}] z[${reach.minZ.toFixed(2)}..${reach.maxZ.toFixed(2)}]`);
  }

  // 4. Different actions keep physical separation.
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i];
      const b = stations[j];
      if (a.action === b.action) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      expect(`${a.name} vs ${b.name}: stand points ≥ 1.5m apart`, d >= 1.5, `d=${d.toFixed(2)}`);
    }
  }

  // 5. Stairwell still walkable.
  expect('stairwell walkable width', cw.stairHalfWidth * 2 >= PLAYER.RADIUS * 2 + 0.5,
    `width ${(cw.stairHalfWidth * 2).toFixed(2)}`);
}

console.log(failures === 0 ? '\nAll station spacing assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
