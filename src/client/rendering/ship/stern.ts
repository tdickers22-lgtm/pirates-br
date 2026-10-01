import * as THREE from 'three';
import { stationSurfaceAt } from '../../../shared/hull.js';
import type { HullProfile, HullProfileStation } from '../../../shared/hull.js';
import { makeLoftedSlabGeometry, sheerHalfWidthAt } from './geometry.js';
import { makeWindowFrame } from './dressing.js';

/**
 * Stern of the procedural hull: the castle slab with its gallery windows and
 * rail, and the rudder hung on the sternpost. Moved out of
 * ShipRenderer.buildShip (b4.2a) so the kit lane can replace pieces of it
 * without touching a 4,700-line file. The castle code is byte-identical to the
 * block it replaced (test-ship-geometry-hash).
 */
export function buildSternCastle(
  group: THREE.Group,
  profile: HullProfile,
  sternStation: HullProfileStation,
  darkMat: THREE.Material,
  brassHardwareMat: THREE.Material,
): THREE.Mesh {
  const { W, H, L } = profile;
  const sternH = H * 0.28, sternL = L * 0.22;
  const castleBackZ = -L * 0.37 - sternL * 0.5;
  const castleFrontZ = -L * 0.37 + sternL * 0.5;
  // Clamped per station: the old W·0.88 box overhung the counter by up to
  // 2.5 m of open water on a galleon (ships-06).
  const sternW = sheerHalfWidthAt(profile, castleBackZ) * 2;
  const stern = new THREE.Mesh(
    makeLoftedSlabGeometry(profile, {
      topY: H + sternH, thickness: sternH, zFrom: castleBackZ, zTo: castleFrontZ, inset: 0.06, samples: 8,
    }),
    darkMat,
  );
  stern.castShadow = true;
  group.add(stern);

  // Stern windows. Keep the glass on the aft face, with separate bars instead of
  // one solid brass rectangle covering the pane.
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x8fc7d8,
    roughness: 0.08,
    metalness: 0.15,
    emissive: 0x24465a,
    emissiveIntensity: 0.18,
    transparent: true,
    opacity: 0.78,
  });
  const windowCount = Math.max(2, Math.round(W / 2.5));
  // The gallery used to be pinned to a fixed -0.51 L - 0.085, which on a
  // galleon put brass and glass 0.85 m aft of the transom with sky behind it
  // (ships-05). Seat it on the loft's own raked stern surface at that height.
  const sternFaceZ = stationSurfaceAt(sternStation, H + sternH * 0.55).z + 0.02;
  for (let w = 0; w < windowCount; w++) {
    const wx = -sternW * 0.35 + w * (sternW * 0.7 / Math.max(windowCount - 1, 1));
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.05), windowMat);
    win.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.012);
    group.add(win);
    const winFrame = makeWindowFrame(0.5, 0.35, 0.055, 0.045, brassHardwareMat);
    winFrame.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.04);
    group.add(winFrame);
  }

  const galleryRailY = H + sternH * 0.24;
  const galleryRail = new THREE.Group();
  galleryRail.position.set(0, galleryRailY, sternFaceZ - 0.1);
  const galleryTop = new THREE.Mesh(new THREE.BoxGeometry(sternW * 0.72, 0.06, 0.07), brassHardwareMat);
  galleryTop.position.y = 0.28;
  galleryRail.add(galleryTop);
  for (let p = 0; p < windowCount + 1; p++) {
    const px = -sternW * 0.36 + p * (sternW * 0.72 / windowCount);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.36, 6), brassHardwareMat);
    post.position.set(px, 0.1, 0);
    post.castShadow = true;
    galleryRail.add(post);
  }
  group.add(galleryRail);
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
