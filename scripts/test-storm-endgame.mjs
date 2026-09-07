#!/usr/bin/env node
// THE MATCH HAS A LAST SECOND, AND THE LAST RING IS AN ARENA (END-01).
//
// Two defects, one endgame:
//
//   gameplay-06 — NO SUDDEN DEATH. Once the arc ran out, StormSystem pinned the
//     timer at 0 and the final circle held FOREVER. Two crews who did not sink
//     each other (a passive pair, a stalemate at anchor, a marooned pirate
//     inside the ring nobody could reach) produced a match with no end: sky
//     pinned at matchProgress 1, HUD clock reading 0, stats never persisted.
//
//   gameplay-22 — A DEMOLITION CIRCLE, NOT A DUEL. The final ring closed to
//     12 m: a 24 m disc that cannot contain one galleon (22 m), where cannon
//     are pointless at 10 m and the decider is whose bow pokes out first. And
//     the land check that was supposed to keep small rings wet accepted 40 %
//     dry land, measured on a 17-sample grid whose finest reading was 5.9 %.
//
// This suite grades the fix from both ends: the eye really closes (and the
// match really resolves), and the 35 m arena the endgame now happens in is
// water in at least 95 % of worlds the generator can produce.
//
//   node --import tsx scripts/test-storm-endgame.mjs
import { Match } from '../src/server/core/Match.ts';
import { StormSystem } from '../src/server/systems/StormSystem.ts';
import {
  SERVER_TICK_MS,
  SHIP_STATS,
  STORM_ARC_SECONDS,
  STORM_PHASES,
} from '../src/shared/constants/index.ts';
import { dist2D, getIslandSurfaceY, mulberry32 } from '../src/shared/utils/index.ts';
import { buildWireSnapshot, CHART_REVEAL_CREWS } from '../src/server/core/snapshot.ts';
import { warningLines } from '../src/client/ui/HudController.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
const makeFakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });

// ══ 1. The eye closes, and the match ends ════════════════════════════════════
console.log('A match that outlives the arc is closed by the eye, not left running');
{
  const match = new Match({ matchId: 'eye-collapse', botCount: 0 });
  match.state.phase = 'playing';
  const crews = ['Ahab', 'Nemo'].map((name) => {
    const joined = match.addHumanClient(makeFakeWs(), name);
    return {
      player: match.state.players.find((p) => p.id === joined.playerId),
      ship: match.state.ships.find((s) => s.id === joined.shipId),
    };
  });
  // Park a small terminal ring on the origin and lay both crews inside it,
  // anchored, undamaged, doing nothing — the stalemate the defect describes.
  const storm = match.state.storm;
  const finalRadius = STORM_PHASES[STORM_PHASES.length - 1].endRadius;
  storm.phase = STORM_PHASES.length;
  storm.centerX = 0; storm.centerZ = 0;
  storm.nextCenterX = 0; storm.nextCenterZ = 0;
  storm.shrinkStartCenterX = 0; storm.shrinkStartCenterZ = 0;
  storm.shrinkStartRadius = finalRadius;
  storm.safeRadius = finalRadius;
  storm.nextRadius = finalRadius;
  storm.shrinking = false;
  storm.shrinkTimer = 0;
  storm.damagePerSec = STORM_PHASES[STORM_PHASES.length - 1].dmgPerSec;
  crews.forEach(({ player, ship }, i) => {
    ship.position.x = i === 0 ? -8 : 8;
    ship.position.z = 0;
    ship.position.y = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.anchored = true;
    player.onShipId = ship.id;
    player.position = { x: ship.position.x, y: 2, z: ship.position.z };
  });
  match.t = STORM_ARC_SECONDS;

  let collapseAtPlus30 = null;
  let holesAtPlus90 = 0;
  let endedAt = null;
  for (let i = 0; i < Math.ceil(160 / DT); i++) {
    match.tick();
    if (collapseAtPlus30 === null && match.t >= STORM_ARC_SECONDS + 30) {
      collapseAtPlus30 = storm.eyeCollapse;
    }
    if (match.t <= STORM_ARC_SECONDS + 90) {
      holesAtPlus90 = Math.max(holesAtPlus90, ...crews.map((c) => c.ship.holes.length));
    }
    if (endedAt === null && match.state.phase === 'ended') { endedAt = match.t; break; }
  }
  // Sampled at +30 s, not at +60: at full ramp the eye kills a full-health crew
  // in well under a minute, so a match that is STILL RUNNING at +60 s would be
  // the defect. Half a ramp is the reading that exists in every honest run.
  expect('the eye is half closed 30 s after the arc and climbing',
    collapseAtPlus30 !== null && Math.abs(collapseAtPlus30 - 0.5) < 0.03,
    `eyeCollapse=${collapseAtPlus30}`);
  expect('and it is stoving in hulls that are sitting INSIDE the final circle',
    holesAtPlus90 > 0, `peak holes ${holesAtPlus90}`);
  expect('the match is over inside 160 s instead of running forever',
    match.state.phase === 'ended',
    `phase=${match.state.phase} at t=${match.t.toFixed(0)}s (arc ${STORM_ARC_SECONDS}s)`);
  expect('…and it says WHY it ended',
    match.state.phase === 'ended' && match['endReason'] !== null,
    `reason=${match['endReason']}`);
  // The collapse, not the backstop, is what did it: 150 s is the deterministic
  // floor, and a match that only ends there means the weather never bit.
  expect('the weather closed it, not the deterministic backstop',
    endedAt !== null && endedAt < STORM_ARC_SECONDS + 150,
    `endedAt=${endedAt === null ? 'never' : `${endedAt.toFixed(0)}s`}`);
  match.stop?.();
}

// ══ 2. The endgame arena is water, and it fits two hulls ═════════════════════
console.log('\nThe 35 m arena fits the fleet and is not a beach');
{
  const longest = Math.max(...Object.values(SHIP_STATS).map((s) => s.length));
  const finalDiameter = STORM_PHASES[STORM_PHASES.length - 1].endRadius * 2;
  expect('the final circle is at least 1.5 x the longest hull in the game',
    finalDiameter >= longest * 1.5,
    `${finalDiameter} m across vs a ${longest} m hull`);
}
{
  // MONTE CARLO. The ring's centre sequence is a pure function of the storm's
  // own rng stream and the world's islands, so the honest sample is worlds x
  // streams. Land is measured on a DENSER grid than the one the picker rejects
  // on — grading a 33-sample chooser with its own 33 samples would only prove
  // it can count.
  const WORLDS = 5;
  const STREAMS = 40;
  const MAX_LAND = 0.2;
  const measure = (islands, cx, cz, radius) => {
    let dry = 0; let total = 0;
    for (const [fraction, steps] of [[0, 1], [0.25, 8], [0.5, 12], [0.75, 16], [0.95, 24]]) {
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2 + fraction;
        const x = cx + Math.cos(angle) * radius * fraction;
        const z = cz + Math.sin(angle) * radius * fraction;
        total += 1;
        for (const island of islands) {
          if (dist2D(island.position.x, island.position.z, x, z) > (island.radius ?? 0) + 40) continue;
          if (getIslandSurfaceY(island, x, z) > 0.2) { dry += 1; break; }
        }
      }
    }
    return dry / total;
  };
  const results = [];
  for (let w = 0; w < WORLDS; w++) {
    const match = new Match({ matchId: `ring-mc-${w}`, botCount: 0 });
    const islands = match.state.islands;
    for (let k = 0; k < STREAMS; k++) {
      const system = new StormSystem(mulberry32(0x51f3c7 + w * 977 + k));
      system.setIslands(islands);
      let cx = 0; let cz = 0;
      let radius = system.getFirstRingRadius();
      for (let i = 1; i < STORM_PHASES.length; i++) {
        const next = STORM_PHASES[i];
        const c = system['pickNextSafeCenter'](cx, cz, radius, next.endRadius, next.shrinkSec);
        cx = c.x; cz = c.z; radius = next.endRadius;
      }
      results.push(measure(islands, cx, cz, radius));
    }
    match.stop?.();
  }
  const wet = results.filter((land) => land < MAX_LAND).length;
  const share = wet / results.length;
  const worst = Math.max(...results);
  const median = [...results].sort((a, b) => a - b)[Math.floor(results.length / 2)];
  expect(`the final arena is under ${MAX_LAND * 100}% dry land in at least 95% of ${results.length} runs`,
    share >= 0.95,
    `${(share * 100).toFixed(1)}% wet (median land ${(median * 100).toFixed(1)}%, worst ${(worst * 100).toFixed(1)}%)`);
  console.log(`     ${results.length} rings over ${WORLDS} worlds: `
    + `${(share * 100).toFixed(1)}% under the line, median land ${(median * 100).toFixed(1)}%`);
}


// ══ 3. The endgame is legible: the chart names the fleet, the HUD names the clock
console.log('\nThe endgame announces itself on the chart and on the HUD');
{
  // The wire flag. `revealed` is written by the snapshot writer, never by the
  // sim, and never written false — a match with four crews left pays nothing.
  const hull = (id, alive = true, sinking = false) => ({
    id, type: 'sloop', alive, sinking, rotation: 0, holes: [], nextHoleId: 1,
    lastHostileShipId: null, position: { x: 1, y: 0, z: 2 },
  });
  const snapOf = (ships) => ({
    serverTime: 0, shipsAlive: ships.filter((s) => s.alive && !s.sinking).length,
    storm: { centerX: 0, centerZ: 0, safeRadius: 35, eyeCollapse: 0 },
    ships, players: [], projectiles: [], kegs: [], sharks: [], wildlife: [],
    islands: [], seaRocks: [], chestSync: [],
  });
  const four = buildWireSnapshot(snapOf([hull('a'), hull('b'), hull('c'), hull('d')]), false);
  expect(`four crews afloat: nobody is on the chart (${CHART_REVEAL_CREWS} is the line)`,
    four.ships.every((s) => s.revealed === undefined),
    JSON.stringify(four.ships.map((s) => s.revealed)));
  const three = buildWireSnapshot(snapOf([hull('a'), hull('b'), hull('c')]), false);
  expect('three crews afloat: every hull is revealed',
    three.ships.every((s) => s.revealed === true),
    JSON.stringify(three.ships.map((s) => s.revealed)));
  const withWreck = buildWireSnapshot(
    snapOf([hull('a'), hull('b'), hull('c', true, true), hull('d', false)]), false);
  expect('a sinking hull and a dead one are not crews, and are not revealed',
    withWreck.ships.filter((s) => s.revealed).length === 2,
    JSON.stringify(withWreck.ships.map((s) => [s.id, s.revealed])));
}
{
  // The banner. THE EYE CLOSES outranks OUTSIDE STORM ZONE: past the collapse
  // there is nowhere on the map that is not the storm, so telling a pirate to
  // sail inside the ring would be sending him somewhere that no longer exists.
  const base = {
    outsideStorm: true, shipMetresOutside: null,
    shipSinking: false, shipCritical: false, shipOnFire: false,
  };
  expect('before the arc runs out the ring line is unchanged',
    warningLines({ ...base, eyeCollapse: 0 }).storm === 'OUTSIDE STORM ZONE');
  expect('the moment the eye starts closing the banner says so',
    warningLines({ ...base, eyeCollapse: 0.01 }).storm === 'THE EYE CLOSES',
    JSON.stringify(warningLines({ ...base, eyeCollapse: 0.01 })));
  expect('…and it does not eat the ship alarm underneath it',
    warningLines({ ...base, eyeCollapse: 1, shipSinking: true }).ship === 'SHIP IS SINKING');
  expect('a caller that knows nothing about the collapse still reads as no collapse',
    warningLines(base).storm === 'OUTSIDE STORM ZONE');
}

console.log(failures === 0
  ? '\nAll storm-endgame checks passed.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
