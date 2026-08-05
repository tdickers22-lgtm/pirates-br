// THE STANDS THE Z-FIGHTING GATE MEASURES, and the dolly it measures them along.
//
// Lifted out of `test-z-fighting.mjs` so the blame probe stands in exactly the
// same places as the gate. A fight found at a camera the gate never visits is a
// fight the gate cannot confirm fixed, and two copies of a stand list drift.
import { planScenes } from '../perf-probe.mjs';

export const VIEWPORT = { width: 960, height: 540 };
export const TIME_OF_DAY = { noon: 854, night: 374 };

/**
 * THE DOLLY. Metres along the view direction, from the stand's own position.
 *
 * They are deliberately not round numbers and deliberately sub-metre. Depth
 * quantisation is a grid; a coplanar pair drifts across it as the eye moves, so
 * what these have to do is land on DIFFERENT PHASES of that grid, and stepping
 * by a round 0.5 m at 100 m lands on the same phase over and over. Sub-metre
 * because the point is to re-measure the SAME view, not a different one.
 */
export const DOLLY = [0, 0.17, 0.41, 0.83, 1.29];

/**
 * THE STANDS. Every one is a place where two surfaces are coplanar or nearly so
 * by construction — which is the only place the artifact can live.
 */
export function planStands(world, filter = null) {
  const shared = planScenes(world);
  const byName = (n) => world.islands.find((i) => i.name === n) ?? null;
  const dockIsland = byName('Castaway Reach') ?? world.islands.find((i) => i.hasDock) ?? world.islands[0];
  const biggest = [...world.islands].sort((a, b) => b.radius - a.radius)[0];

  const stands = [
    // The shared perf stands, so a tie count and a draw count describe the same
    // frames. dock-vista and island-far are the DISTANCE cases — depth precision
    // falls off with the square of the distance and these are where it lands.
    { id: 'dock-vista', label: 'dock vista (island at 95 m + dock planks)', cam: shared['dock-vista'] },
    { id: 'island-interior', label: 'island interior, eye level in the scatter', cam: shared['island-interior'] },
    { id: 'cave-interior', label: 'cave interior (shell vs terrain, mouth cutout)', cam: shared['cave-interior'] },
    { id: 'deck-aft', label: 'on-deck aft (planking, patches, hull decals)', cam: shared['deck-aft'] },
    { id: 'open-sea', label: 'open sea (ocean plane + horizon)', cam: shared['open-sea'] },
  ];

  // THE WATERLINE, at eye height, from the water. Shore band, wet-sand band,
  // shallow disc and sand shelf are all authored as overlapping ramps against
  // the ocean plane, and this is the only stand that looks straight down the
  // seam where they meet.
  stands.push({
    id: 'shore-waterline',
    label: 'shore waterline (shore band / wet sand / ocean seam)',
    cam: {
      x: dockIsland.x + (dockIsland.radius + 26),
      y: 1.7,
      z: dockIsland.z,
      pitch: -0.06,
      aimAt: { x: dockIsland.x, z: dockIsland.z },
    },
  });

  // THE DISTANCE CASE, and the reason the near plane matters. A whole island at
  // 520 m: every coplanar pair on it is being resolved by the tail of the depth
  // buffer, where the levels are ~100x coarser than they are at the dock.
  stands.push({
    id: 'island-far',
    label: 'island at 520 m (the far tail of the depth buffer)',
    cam: {
      x: biggest.x + (biggest.radius + 520) * 0.707,
      y: 26,
      z: biggest.z + (biggest.radius + 520) * 0.707,
      pitch: -0.03,
      aimAt: { x: biggest.x, z: biggest.z },
    },
  });

  // LOOKING DOWN ON TERRAIN from above: terrace lips, contact shadows, ground
  // decals and the detail/proxy crossfade band all present their coplanar face
  // to a top-down eye and hide it from a level one.
  stands.push({
    id: 'island-overlook',
    label: 'island overlook (terraces, contact shadows, ground decals)',
    cam: {
      x: biggest.x + biggest.radius * 0.9,
      y: 96,
      z: biggest.z + biggest.radius * 0.9,
      pitch: -0.62,
      aimAt: { x: biggest.x, z: biggest.z },
    },
  });

  // ALONGSIDE THE HULL at water level: the waterline collar against the ocean
  // surface, plus the hole decals and plank patches at the distance a boarder
  // sees them.
  if (world.ship) {
    stands.push({
      id: 'hull-alongside',
      label: 'alongside the hull at water level (collar vs ocean, hole decals)',
      cam: {
        x: world.ship.x + Math.cos(world.ship.rot ?? 0) * 15,
        y: world.ship.y + 1.2,
        z: world.ship.z - Math.sin(world.ship.rot ?? 0) * 15,
        pitch: 0.02,
        aimAt: { x: world.ship.x, z: world.ship.z },
      },
    });
  }

  return stands.filter((s) => s.cam && (!filter || filter.includes(s.id)));
}
