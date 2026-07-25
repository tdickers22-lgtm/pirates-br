#!/usr/bin/env node
// DOCK FRAME CONTRACT — one canonical dock space, shared by the client mesh,
// server physics, the swim-up ladder and every berth.
//
//   world = dock.position + Ry(θ) · local          (+local-z points SEAWARD)
//
// Everything below runs against the REAL Match + shared utils over every dock in
// the fixed world (the Shattered Reach is authored, so this is the whole set):
//   (a) ladder point / climb prompt anchor / climb teleport target agree and sit
//       on the walkable deck,
//   (b) berthed hulls of all three classes lie ALONGSIDE the dock run — parallel,
//       1.0m rail gap, stern inside the dock span, never parked out at sea,
//   (c) dockLocalToWorld ∘ toDockLocal is the identity (the two frames are one).
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { dockLocalToWorld, getIslandDockSwimLadderPoint } from '../src/shared/utils/index.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const match = new Match({ matchId: 'dock-frame', botCount: 0 });
const state = match['state'];
const physics = new PhysicsSystem();
const docks = state.islands.filter((island) => island.dock).map((island) => ({ island, dock: island.dock }));

console.log(`Dock frame contract (${docks.length} docks in the fixed world)`);
expect('the fixed world has docks to check', docks.length >= 8, `${docks.length}`);

// ── (c) One frame: dockLocalToWorld is the exact inverse of toDockLocal ──────
{
  let worst = 0;
  let detail = '';
  for (const { dock } of docks) {
    for (const [lx, lz] of [[0, 0], [1.7, -4.2], [-2.3, 9.1], [0, dock.length * 0.44]]) {
      const world = dockLocalToWorld(dock, lx, 0.4, lz);
      const back = physics['toDockLocal'](world, dock);
      const err = Math.max(Math.abs(back.x - lx), Math.abs(back.z - lz));
      if (err > worst) { worst = err; detail = `dock θ=${dock.rotation.toFixed(3)} local=(${lx},${lz}) → back=(${back.x.toFixed(6)},${back.z.toFixed(6)})`; }
    }
  }
  expect('dockLocalToWorld ∘ toDockLocal round-trips to identity (<1e-9)', worst < 1e-9, `worst=${worst.toExponential(3)} ${detail}`);
}

// ── (a) Ladder point, prompt anchor and climb target agree, on the deck ─────
{
  let worstSeparation = 0;
  let offDeck = 0;
  let climbFailures = 0;
  let shoreEndAccepted = 0;
  let detail = '';

  for (const { dock } of docks) {
    const ladder = getIslandDockSwimLadderPoint(dock);
    const ladderLocal = physics['toDockLocal'](ladder, dock);

    // The ladder must be at the SEAWARD end, on the deck's footprint.
    if (ladderLocal.z < dock.length * 0.3 || Math.abs(ladderLocal.x) > dock.width * 0.5 + 0.2) {
      offDeck += 1;
      detail += `\n     ladder off the seaward deck: local=(${ladderLocal.x.toFixed(2)}, ${ladderLocal.z.toFixed(2)}) L=${dock.length.toFixed(1)} W=${dock.width.toFixed(1)}`;
    }

    // Swim up beside the ladder and press [X] — the real server path.
    const swimmer = {
      state: 'swimming',
      position: { x: ladder.x, y: 0, z: ladder.z },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const climbed = match['tryClimbIslandDockFromWater'](swimmer);
    if (!climbed) {
      climbFailures += 1;
      detail += `\n     climb refused at the ladder point (dock L=${dock.length.toFixed(1)})`;
      continue;
    }
    const targetLocal = physics['toDockLocal'](swimmer.position, dock);
    const separation = Math.hypot(swimmer.position.x - ladder.x, swimmer.position.z - ladder.z);
    if (separation > worstSeparation) worstSeparation = separation;
    if (Math.abs(targetLocal.x) > dock.width * 0.5 || Math.abs(targetLocal.z) > dock.length * 0.5) {
      offDeck += 1;
      detail += `\n     climb target off the deck: local=(${targetLocal.x.toFixed(2)}, ${targetLocal.z.toFixed(2)}) half=(${(dock.width * 0.5).toFixed(2)}, ${(dock.length * 0.5).toFixed(2)})`;
    }
    if (Math.abs(swimmer.position.y - (dock.position.y + 0.52)) > 0.01) {
      offDeck += 1;
      detail += `\n     climb target not at deck height: y=${swimmer.position.y.toFixed(2)} expected=${(dock.position.y + 0.52).toFixed(2)}`;
    }

    // The MIRRORED (old-frame) spot at the shore end must NOT be a ladder.
    const mirrored = {
      state: 'swimming',
      position: {
        x: dock.position.x - (ladder.x - dock.position.x),
        y: 0,
        z: dock.position.z - (ladder.z - dock.position.z),
      },
      velocity: { x: 0, y: 0, z: 0 },
    };
    if (match['tryClimbIslandDockFromWater'](mirrored)) shoreEndAccepted += 1;
  }

  expect('every dock accepts the climb at its swim-ladder point', climbFailures === 0, detail);
  expect('climb target agrees with the ladder point within 1.5m', worstSeparation <= 1.5, `worst=${worstSeparation.toFixed(2)}m`);
  expect('ladder point + climb target sit on the walkable dock deck', offDeck === 0, detail);
  expect('the shore end is NOT a swim-up ladder (mirrored-frame regression)', shoreEndAccepted === 0, `${shoreEndAccepted} docks`);
}

// ── (b) Berths: alongside the dock run, parallel, 1.0m gap ──────────────────
{
  const rows = [];
  for (const { dock } of docks) {
    for (const type of ['sloop', 'brigantine', 'galleon']) {
      const stats = SHIP_STATS[type];
      const berth = match['computeShipBerth']({ id: 'probe', type, position: { x: 0, y: 0, z: 0 }, rotation: 0 }, dock);
      if (!berth) { rows.push({ type, dock, berth: null }); continue; }
      const local = physics['toDockLocal']({ x: berth.x, y: 0, z: berth.z }, dock);
      const half = stats.length * 0.5;
      const tip = dock.length * 0.5;
      rows.push({
        type, dock, berth,
        along: local.z,
        gap: Math.abs(local.x) - dock.width * 0.5 - stats.width * 0.5,
        sternInside: local.z - half <= tip,
        overlap: Math.max(0, Math.min(local.z + half, tip) - Math.max(local.z - half, -tip)) / stats.length,
      });
    }
  }

  const missing = rows.filter((r) => !r.berth);
  expect('every dock has a computed berth for every ship class', missing.length === 0,
    missing.map((r) => `${r.type} @ L=${r.dock.length.toFixed(1)}`).join(', '));

  const placed = rows.filter((r) => r.berth);
  const badGap = placed.filter((r) => Math.abs(r.gap - 1.0) > 0.05);
  expect('hull-to-dock-edge gap is 1.00m on every berth', badGap.length === 0,
    badGap.map((r) => `${r.type}: gap=${r.gap.toFixed(2)}`).join('\n     '));

  const parallel = placed.every((r) => Math.abs(r.dock.berthRotation - r.dock.rotation) < 1e-9);
  expect('berthed ships lie parallel to the dock (berthRotation === dock rotation)', parallel);

  const pastTip = placed.filter((r) => !r.sternInside);
  expect('every berthed hull still reaches the dock (stern inside the dock span)', pastTip.length === 0,
    pastTip.map((r) => `${r.type} @ L=${r.dock.length.toFixed(1)}: along=${r.along.toFixed(1)}`).join('\n     '));

  // Docks shorter than the hull cannot give 100% overlap without dredging the
  // shallows (MapGenerator's job); what must hold is that a real stretch of the
  // hull is abreast the deck at every dock.
  const thinOverlap = placed.filter((r) => r.overlap < 0.2);
  expect('at least 20% of every hull lies abreast the dock deck', thinOverlap.length === 0,
    thinOverlap.map((r) => `${r.type} @ L=${r.dock.length.toFixed(1)}: overlap=${(r.overlap * 100).toFixed(0)}%`).join('\n     '));

  const farOut = placed.filter((r) => r.along > r.dock.length * 0.5 + 14 || r.along < -r.dock.length * 0.5);
  expect('no berth is parked out in open water past the dock', farOut.length === 0,
    farOut.map((r) => `${r.type}: along=${r.along.toFixed(1)} L=${r.dock.length.toFixed(1)}`).join('\n     '));

  const overlaps = placed.map((r) => r.overlap);
  console.log(`     berths=${placed.length} minOverlap=${(Math.min(...overlaps) * 100).toFixed(0)}% medianOverlap=${(overlaps.sort((a, b) => a - b)[Math.floor(overlaps.length / 2)] * 100).toFixed(0)}%`);
}

if (failures > 0) {
  console.error(`\n${failures} dock-frame assertion(s) failed.`);
  process.exit(1);
}
console.log('\nOne dock frame, seaward ladders, hulls alongside the pier.');
