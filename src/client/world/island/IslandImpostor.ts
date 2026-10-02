import * as THREE from 'three';
import { ADDRESSED_NAMES, collapseStaticMeshes } from './StaticBatcher.js';
import { apparentDistanceScale } from './InstanceLod.js';
import { detectPacerForm } from '../../core/framePacer.js';

/**
 * ISLAND HLOD (b4.4a): the island's static kit split into 8 angular x 2 radial
 * SECTORS, each one a near / mid / far tier decided per frame by the renderer's
 * own LOD hook, so the cost of a far island stops being the cost of a near one.
 *
 * WHY SECTORS AND NOT THE WHOLE ISLAND. Game.ts already flips an island between
 * its detail tier and its terrain proxy at the island EDGE (950 m at high). That
 * is one switch for a two-hundred-metre landmass: standing on the beach, the
 * headland on the far side pays full price, and from a dock 400 m out every
 * crab trap on the island is still a draw call. A sector is small enough that
 * "how far away is it" has one answer, and big enough (an eighth of a ring) that
 * merging its pieces is worth it: every piece that lands in a sector tier is
 * collapsed with its neighbours, one draw per material family for the lot.
 *
 * THE TIERS (desktop / phone bands, apparent distance to the sector's bounding
 * sphere, 8% hysteresis on the way out):
 *   near  < 180 m / 120 m : everything, small pieces included (< MID_KEEP_SIZE).
 *   mid   < 450 m / 320 m : only pieces at least MID_KEEP_SIZE across, no shadow.
 *   far   beyond          : the sector draws nothing; the island's silhouette is
 *                           the terrain plus the landmark pieces (>= FAR_KEEP_SIZE),
 *                           which stay island-wide and merged (the baked impostor).
 * Shadow casting is a near-only privilege: a mid-tier piece never casts, and on a
 * phone only a sector within PHONE_CASTER_BAND casts at all.
 *
 * WHAT NEVER JOINS A SECTOR. Anything this codebase looks up (ADDRESSED_NAMES),
 * anything with userData (a system is attached), anything holding a light (the
 * light budget is Game's), the terrain and its skirt, instanced batches (already
 * one call and thinned by InstanceLod) and the cave groups Game toggles itself.
 * The served world is untouched: this is render-only, collisions read the shared
 * heightfield, and `?hlod=off` builds the island exactly as before this module
 * (no sectors, no cross-piece merge): the mutation that proves the perf rows fail.
 */

export type HlodBands = { readonly near: number; readonly mid: number; readonly caster: number };
export const HLOD_BANDS_DESKTOP: HlodBands = { near: 180, mid: 450, caster: 180 };
export const HLOD_BANDS_PHONE: HlodBands = { near: 120, mid: 320, caster: 30 };
export const HLOD_HYSTERESIS = 1.08;
export const HLOD_ANGULAR = 8;
export const HLOD_RADIAL = 2;
/** Pieces at least this big (largest bbox side, metres) survive into the mid tier. */
export const MID_KEEP_SIZE = 3.6;
/** Pieces at least this big are landmarks: never sectorised, always drawn with the island. */
export const FAR_KEEP_SIZE = 9;

const KEEP_NAMES = new Set(['island-terrain', 'island-shore-skirt', 'island-micro-root']);

let resolvedBands: HlodBands | null = null;
let resolvedEnabled: boolean | null = null;

/** Phone bands on a phone (the same verdict the frame pacer and ship LOD use). */
export function hlodBands(): HlodBands {
  if (!resolvedBands) resolvedBands = detectPacerForm() === 'phone' ? HLOD_BANDS_PHONE : HLOD_BANDS_DESKTOP;
  return resolvedBands;
}

/** False under `?hlod=off`: every sector stays near (the perf gate's mutation). */
export function hlodEnabled(): boolean {
  if (resolvedEnabled === null) {
    resolvedEnabled = !(typeof location !== 'undefined' && /(?:^|[?&])hlod=off(?:&|$)/.test(location.search));
  }
  return resolvedEnabled;
}

/** Sector index for a point in island-local XZ: angular slice + inner/outer ring. */
export function sectorOf(x: number, z: number, islandRadius: number): number {
  const a = Math.atan2(z, x);
  const slice = Math.min(HLOD_ANGULAR - 1, Math.floor(((a + Math.PI) / (Math.PI * 2)) * HLOD_ANGULAR));
  const ring = Math.hypot(x, z) < islandRadius * 0.5 ? 0 : 1;
  return ring * HLOD_ANGULAR + slice;
}

/** Pure tier rule, shared by the sector and the logic gate. 0 near, 1 mid, 2 far. */
export function hlodTier(apparent: number, previous: number, bands: HlodBands): number {
  const h = HLOD_HYSTERESIS;
  const nearEdge = previous === 0 ? bands.near * h : bands.near;
  const midEdge = previous <= 1 ? bands.mid * h : bands.mid;
  if (apparent < nearEdge) return 0;
  if (apparent < midEdge) return 1;
  return 2;
}

const _cam = new THREE.Vector3();
const _centre = new THREE.Vector3();

/**
 * One sector. Extends THREE.LOD only for the renderer's hook: WebGLRenderer calls
 * `update(camera)` on every visible `isLOD` node during projection, BEFORE the
 * shadow pass, so the tier is decided once per frame for both passes with no
 * call from Game.ts. `levels` stays empty, which keeps LOD.raycast inert.
 */
export class HlodSector extends THREE.LOD {
  readonly near = new THREE.Group();
  readonly mid = new THREE.Group();
  /** Bounding sphere in THIS node's local space (island-local). */
  readonly centre = new THREE.Vector3();
  radius = 0;
  tier = 0;
  private midMeshes: THREE.Mesh[] = [];
  private midCasts: boolean[] = [];
  private casting = true;

  constructor(index: number) {
    super();
    this.name = `island-hlod-sector-${index}`;
    this.near.name = `island-hlod-near-${index}`;
    this.mid.name = `island-hlod-mid-${index}`;
    this.add(this.near, this.mid);
  }

  /** Called once after the pieces are in and collapsed. */
  seal(): void {
    const box = new THREE.Box3();
    for (const g of [this.near, this.mid]) {
      for (const c of g.children) box.expandByObject(c);
    }
    if (!box.isEmpty()) {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.centre.copy(sphere.center);
      this.radius = sphere.radius;
    }
    this.midMeshes = [];
    this.mid.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.midMeshes.push(o as THREE.Mesh); });
    this.midCasts = this.midMeshes.map((m) => m.castShadow);
  }

  override update(camera: THREE.Camera): void {
    if (!hlodEnabled()) return;
    const bands = hlodBands();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _centre.copy(this.centre).applyMatrix4(this.matrixWorld);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 74;
    const apparent = Math.max(0, _cam.distanceTo(_centre) - this.radius) / apparentDistanceScale(fov);
    const tier = hlodTier(apparent, this.tier, bands);
    this.tier = tier;
    this.near.visible = tier === 0;
    this.mid.visible = tier <= 1;
    const cast = tier === 0 && apparent < bands.caster * (this.casting ? HLOD_HYSTERESIS : 1);
    if (cast !== this.casting) {
      this.casting = cast;
      for (let i = 0; i < this.midMeshes.length; i++) this.midMeshes[i].castShadow = cast && this.midCasts[i];
    }
  }
}

function eligible(piece: THREE.Object3D, skip: ReadonlySet<THREE.Object3D>): boolean {
  if (KEEP_NAMES.has(piece.name) || ADDRESSED_NAMES.has(piece.name)) return false;
  if (skip.has(piece)) return false;
  if ((piece as THREE.InstancedMesh).isInstancedMesh) return false;
  let ok = true;
  piece.traverse((o) => {
    if (!ok) return;
    if ((o as THREE.Light).isLight || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) ok = false;
    else if (o.userData && Object.keys(o.userData).length > 0) ok = false;
    else if (o !== piece && ADDRESSED_NAMES.has(o.name)) ok = false;
  });
  return ok;
}

export type HlodStats = { sectors: number; pieces: number; near: number; mid: number; landmarks: number; saved: number };

/**
 * Sort the static pieces under `detailRoot` (and its micro tier) into sectors.
 * Coordinates are island-local: detailRoot sits at the island group's origin.
 * Must run BEFORE freezeStaticSubtree and before the group cull sphere is taken.
 */
export function buildIslandHlod(
  detailRoot: THREE.Object3D,
  microRoot: THREE.Object3D | null,
  islandRadius: number,
  skip: ReadonlySet<THREE.Object3D>,
): HlodStats {
  const stats: HlodStats = { sectors: 0, pieces: 0, near: 0, mid: 0, landmarks: 0, saved: 0 };
  // `?hlod=off` is the pre-HLOD island exactly: no sectors, no cross-piece merge.
  if (!hlodEnabled()) return stats;
  const sectors: (HlodSector | null)[] = new Array(HLOD_ANGULAR * HLOD_RADIAL).fill(null);
  const landmarks = new THREE.Group();
  landmarks.name = 'island-hlod-landmarks';
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  detailRoot.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(detailRoot.matrixWorld).invert();

  const candidates: { piece: THREE.Object3D; small: boolean }[] = [];
  for (const piece of detailRoot.children) {
    if (piece === microRoot) continue;
    candidates.push({ piece, small: false });
  }
  if (microRoot) for (const piece of microRoot.children) candidates.push({ piece, small: true });

  for (const { piece, small } of candidates) {
    if (!eligible(piece, skip)) continue;
    box.setFromObject(piece);
    if (box.isEmpty()) continue;
    box.applyMatrix4(inverse);
    box.getSize(size);
    box.getCenter(centre);
    const extent = Math.max(size.x, size.y, size.z);
    stats.pieces += 1;
    if (extent >= FAR_KEEP_SIZE) {
      landmarks.add(piece);
      stats.landmarks += 1;
      continue;
    }
    const s = sectorOf(centre.x, centre.z, islandRadius);
    let sector = sectors[s];
    if (!sector) {
      sector = new HlodSector(s);
      sectors[s] = sector;
    }
    if (small || extent < MID_KEEP_SIZE) {
      sector.near.add(piece);
      stats.near += 1;
    } else {
      sector.mid.add(piece);
      stats.mid += 1;
    }
  }

  if (landmarks.children.length > 0) {
    stats.saved += collapseStaticMeshes(landmarks);
    detailRoot.add(landmarks);
  }
  for (const sector of sectors) {
    if (!sector) continue;
    stats.saved += collapseStaticMeshes(sector.near) + collapseStaticMeshes(sector.mid);
    sector.near.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    sector.seal();
    detailRoot.add(sector);
    stats.sectors += 1;
  }
  return stats;
}
