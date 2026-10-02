import * as THREE from 'three';
import { apparentDistanceScale } from './InstanceLod.js';
import { detectPacerForm } from '../../core/framePacer.js';
import {
  terrainLodCapacity, writeTerrainLodIndex, type TerrainLodChunks,
} from '../../../shared/terrainLod.js';

/**
 * TERRAIN RENDER LOD (b4.4c). The island terrain stays ONE mesh and ONE draw;
 * what changes per frame is which triangles its index holds: chunks within the
 * near band draw the grid's own triangles (what the walker stands on), the rest
 * draw the coarse list over the same vertices (src/shared/terrainLod.ts proves
 * every mix is watertight). The index is rewritten only when a chunk crosses
 * its band (15% hysteresis), into one preallocated buffer with a draw range,
 * so no GL buffer is ever created or leaked by the switch.
 *
 * Raycasts never see the coarse list: the mesh raycasts against a sibling
 * geometry that shares the attributes and holds the full index.
 *
 * Bands: desktop 120 m, phone 40 m (b4.4c: 60 m left the 2 m grid at 321k on the phone island-interior row; islands-06: the phone draws the coarse
 * grid beyond 60 m). `?terrainlod=off` keeps every chunk fine (perf mutation).
 */
export const TERRAIN_LOD_NEAR_DESKTOP = 120;
export const TERRAIN_LOD_NEAR_PHONE = 40;
const HYSTERESIS = 1.15;

let resolvedEnabled: boolean | null = null;
export function terrainLodEnabled(): boolean {
  if (resolvedEnabled === null) {
    try {
      const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
      resolvedEnabled = q?.get('terrainlod') !== 'off';
    } catch { resolvedEnabled = true; }
  }
  return resolvedEnabled;
}

let resolvedNear: number | null = null;
export function terrainLodNearBand(): number {
  if (resolvedNear === null) resolvedNear = detectPacerForm() === 'phone' ? TERRAIN_LOD_NEAR_PHONE : TERRAIN_LOD_NEAR_DESKTOP;
  return resolvedNear;
}

const _cam = new THREE.Vector3();
const _inv = new THREE.Matrix4();

export class TerrainLodSwitch extends THREE.LOD {
  readonly near: Uint8Array;
  readonly fullGeometry: THREE.BufferGeometry;
  private readonly lodIndex: THREE.BufferAttribute;
  /** Triangles the index currently holds (perf report + tests). */
  drawnTris = 0;
  rewrites = 0;

  constructor(readonly mesh: THREE.Mesh, readonly lod: TerrainLodChunks, readonly nearBand = terrainLodNearBand()) {
    super();
    this.name = 'island-terrain-lod';
    const geometry = mesh.geometry;
    const full = geometry.getIndex();
    this.fullGeometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geometry.attributes)) this.fullGeometry.setAttribute(name, attr);
    if (full) this.fullGeometry.setIndex(full);
    this.fullGeometry.boundingSphere = geometry.boundingSphere;
    this.fullGeometry.boundingBox = geometry.boundingBox;
    this.near = new Uint8Array(lod.chunks.length);
    this.lodIndex = new THREE.BufferAttribute(new Uint32Array(terrainLodCapacity(lod.chunks)), 1);
    this.lodIndex.setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(this.lodIndex);
    this.rewrite();
    // The walkable truth is the full grid: rays (decor seating, camera, tests)
    // run against it, never against whatever the camera made coarse.
    const fullGeometry = this.fullGeometry;
    mesh.raycast = function (raycaster, intersects) {
      const drawn = this.geometry;
      this.geometry = fullGeometry;
      try { THREE.Mesh.prototype.raycast.call(this, raycaster, intersects); } finally { this.geometry = drawn; }
    };
    mesh.userData.terrainLod = this;
    mesh.add(this);
  }

  private rewrite(): void {
    const n = writeTerrainLodIndex(this.lod.chunks, this.near, this.lodIndex.array as Uint32Array);
    this.mesh.geometry.setDrawRange(0, n);
    this.lodIndex.needsUpdate = true;
    this.drawnTris = n / 3;
    this.rewrites++;
  }

  /** Decide every chunk's band for a camera at island-LOCAL `local`. */
  select(local: THREE.Vector3, distanceScale = 1): boolean {
    let changed = false;
    const chunks = this.lod.chunks;
    for (let c = 0; c < chunks.length; c++) {
      const k = chunks[c];
      const d = Math.max(0, Math.hypot(local.x - k.cx, local.y - k.cy, local.z - k.cz) - k.radius) / distanceScale;
      const wasNear = this.near[c] === 1;
      const isNear = !terrainLodEnabled() || (wasNear ? d < this.nearBand * HYSTERESIS : d < this.nearBand);
      if (isNear !== wasNear) { this.near[c] = isNear ? 1 : 0; changed = true; }
    }
    if (changed) this.rewrite();
    return changed;
  }

  override update(camera: THREE.Camera): void {
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _inv.copy(this.mesh.matrixWorld).invert();
    _cam.applyMatrix4(_inv);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 74;
    this.select(_cam, apparentDistanceScale(fov));
  }
}
