import * as THREE from 'three';
import type { HullProfile } from '../../../shared/hull.js';
import { gerstnerHeight, WAVE_PARAMS } from '../../../shared/utils/index.js';
import { makeWaterlineFoamGeometry } from './geometry.js';

/**
 * Waterline contact collar, moved out of ShipRenderer (b4.2a). The wet foam
 * edge where the sea meets the planking. The hull's DRAFT is already correct
 * (the loft's y = 0 slot is the design waterline and the render root rides the
 * shared Gerstner surface within ~0.05 m), but with no contact treatment the
 * ocean just clipped the shell with a hard silhouette and the hull's own shadow
 * read as an air gap under the keel. This collar is what makes it sit IN the sea.
 */
export function buildWaterlineFoam(profile: HullProfile, map: THREE.Texture): THREE.Mesh {
  const waterlineFoam = new THREE.Mesh(
    makeWaterlineFoamGeometry(profile, Math.max(0.55, profile.W * 0.16)),
    new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  waterlineFoam.name = 'waterline-foam';
  waterlineFoam.renderOrder = 2;
  return waterlineFoam;
}

/**
 * Glue the collar to the sea for this frame.
 *
 * Cancel the hull's pitch/roll (previous frame's settled value — one frame of
 * lag is invisible) so the wet edge stays glued to the sea instead of riding
 * the ship's attitude out of the water. The collar ends up on a YAW-ONLY frame:
 * the root is Ry·Rx·Rz, so the exact inverse of its attitude (leaving the yaw
 * alone) is Rz(-roll)·Rx(-pitch), which is what Euler order 'ZXY' with y = 0
 * spells (ships-01).
 *
 * Then lift every collar vertex onto the LOCAL wave surface (world Gerstner
 * minus the hull's own heave). Without this the ribbon is a flat disc at the
 * hull's mean waterline and the very next crest buries it, which is exactly how
 * a correctly-drafted hull ends up reading as floating.
 */
export function seatWaterlineFoam(foam: THREE.Mesh, root: THREE.Object3D, waveT: number, storm01: number): void {
  foam.rotation.set(-root.rotation.x, 0, -root.rotation.z, 'ZXY');
  if (!foam.visible) return;
  const geo = foam.geometry;
  const baseXZ = geo.userData.baseXZ as Float32Array | undefined;
  const rest = geo.userData.rest as Float32Array | undefined;
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  if (!baseXZ || !rest) return;
  const cy = Math.cos(root.rotation.y);
  const sy = Math.sin(root.rotation.y);
  for (let i = 0; i < posAttr.count; i++) {
    const lx = baseXZ[i * 2];
    const lz = baseXZ[i * 2 + 1];
    const wx = root.position.x + lx * cy + lz * sy;
    const wz = root.position.z - lx * sy + lz * cy;
    posAttr.setY(i, gerstnerHeight(wx, wz, waveT, WAVE_PARAMS, storm01) - root.position.y + rest[i]);
  }
  posAttr.needsUpdate = true;
}
