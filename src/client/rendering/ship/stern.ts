import * as THREE from 'three';
import type { HullProfile, HullProfileStation } from '../../../shared/hull.js';
import { stationSurfaceAt } from '../../../shared/hull.js';
import { makeLoftedSlabGeometry } from './geometry.js';

/**
 * Stern of the procedural hull: the castle slab (its gallery windows and rail
 * are the ship kit's since b4.3c), and the rudder hung on the sternpost. Moved out of
 * ShipRenderer.buildShip (b4.2a) so the kit lane can replace pieces of it
 * without touching a 4,700-line file. The castle code is byte-identical to the
 * block it replaced (test-ship-geometry-hash).
 */
export function buildSternCastle(
  group: THREE.Group,
  profile: HullProfile,
  _sternStation: HullProfileStation,
  darkMat: THREE.Material,
  _brassHardwareMat: THREE.Material,
): THREE.Mesh {
  const { H, L } = profile;
  const sternH = H * 0.28, sternL = L * 0.22;
  const castleBackZ = -L * 0.37 - sternL * 0.5;
  const castleFrontZ = -L * 0.37 + sternL * 0.5;
  const stern = new THREE.Mesh(
    makeLoftedSlabGeometry(profile, {
      topY: H + sternH, thickness: sternH, zFrom: castleBackZ, zTo: castleFrontZ, inset: 0.06, samples: 8,
    }),
    darkMat,
  );
  stern.castShadow = true;
  group.add(stern);

  // b4.3c: the stern windows and gallery rail are the Blender kit's
  // (stern_gallery_* / stern_transom_sloop on the transom socket, ship/kit.ts),
  // mounted at every LOD level; the castle slab stays the hull's.
  return stern;
}

/** Where the rudder hangs, from the shared loft (all ship-local metres). The
 *  stock axis is the chord of the raked sternpost (station 0's aft surface at
 *  x = 0) from just under the counter down to the post's foot at the keel.
 *  Exported for the gallery probe and tests: a blade that is not on this line
 *  is a floating rudder (vm:ships:1). */
export function rudderMount(profile: HullProfile): {
  top: { y: number; z: number }; foot: { y: number; z: number }; rake: number; length: number; chord: number;
} {
  const post = profile.stations[0];
  const yTop = profile.H * 0.32;
  const yFoot = post.keelY - 0.04; // a short heel just under the post's foot
  const top = { y: yTop, z: stationSurfaceAt(post, yTop).z };
  const foot = { y: yFoot, z: stationSurfaceAt(post, post.keelY).z };
  const dy = top.y - foot.y, dz = top.z - foot.z;
  return { top, foot, rake: Math.atan2(dz, dy), length: Math.hypot(dy, dz), chord: profile.L * 0.045 };
}

/**
 * The rudder blade on a stock it turns on; rotation.y of the returned pivot is
 * Ship.rudderAngle. The pivot sits on the sternpost chord and the blade's
 * leading edge lies along it, so at any helm angle the blade is hinged to the
 * post. The old blade hung 0.3 m aft of the post, 0.8 m below the stern's keel
 * line and leant FORWARD (rotation.x +0.1) against an aft-raked post, so on the
 * galleon it read as a slab floating behind the ship (vm:ships:1).
 */
export function buildRudder(profile: HullProfile, darkMat: THREE.Material): THREE.Group {
  const m = rudderMount(profile);
  const rudderPivot = new THREE.Group();
  rudderPivot.name = 'rudder-stock';
  rudderPivot.position.set(0, (m.top.y + m.foot.y) * 0.5, (m.top.z + m.foot.z) * 0.5);
  const rudder = new THREE.Mesh(
    // Leading edge 1 cm aft of the post line, blade trailing aft (-z).
    new THREE.BoxGeometry(0.09, m.length, m.chord).translate(0, 0, -m.chord * 0.5 - 0.01),
    darkMat,
  );
  rudder.name = 'rudder-blade';
  rudder.rotation.x = m.rake;
  rudderPivot.add(rudder);
  return rudderPivot;
}
