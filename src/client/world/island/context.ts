/**
 * The two seams the island builders share.
 *
 * `IslandBuilderCtx` is the OUTWARD seam — the live Game state (mesh
 * registries, wind uniforms, the environment group) handed in by reference so
 * nothing here duplicates it. `IslandBuildCtx` is the INWARD seam: the
 * per-island scratch — palette colours, the seeded rng, the surface samplers —
 * that `buildIsland` computes once and every sub-builder reads.
 */
import * as THREE from 'three';
import type { Island, IslandNpc, ShipUpgradeType } from '../../../shared/types/index.js';
import type { AssetName } from '../../assets/AssetLibrary.js';
import type { Renderer } from '../../rendering/Renderer.js';

export type ChestMeshRecord = {
  root: THREE.Group;
  glow: THREE.PointLight;
  /** Chest body — a GLB clone group, or the procedural box mesh fallback. */
  chestMesh: THREE.Object3D;
  /** Procedural lid (fallback only); a no-op placeholder group when the GLB body includes the lid. */
  lid: THREE.Object3D;
  mound: THREE.Mesh | null;
};

export type UpgradeStationMeshRecord = {
  root: THREE.Group;
  core: THREE.Mesh;
  halo: THREE.Mesh;
  sign: THREE.Mesh;
  light: THREE.PointLight;
  type: ShipUpgradeType;
};

export type NpcMeshRecord = {
  root: THREE.Group;
  body: THREE.Group;
  light: THREE.PointLight;
  baseY: number;
  role: IslandNpc['role'];
};

export type IslandBuilderCtx = {
  readonly renderer: Renderer;
  readonly islandPropInstances: Map<string, Map<number, { inst: THREE.InstancedMesh; index: number }>>;
  readonly foliageWind: { value: THREE.Vector2 };
  readonly foliageTime: { value: number };
  registerLanternEmitter(
    container: THREE.Object3D,
    localX: number,
    localY: number,
    localZ: number,
    kind: 'lantern' | 'campfire',
  ): void;
  readonly environment: THREE.Group;
  readonly islandMeshes: Map<string, THREE.Group>;
  readonly chestMeshes: Map<string, ChestMeshRecord>;
  readonly barrelMeshes: Map<string, THREE.Group>;
  readonly upgradeStationMeshes: Map<string, UpgradeStationMeshRecord>;
  readonly npcMeshes: Map<string, NpcMeshRecord>;
  readonly magmaPulseUniform: { value: number };
  pushVolcanicFx(fx: (dt: number, worldTime: number, camera: THREE.Vector3) => void): void;
  /** Replaces any door already registered for this island (rebuild-safe). */
  setTavernDoor(islandId: string, node: THREE.Object3D): void;
  getSoftParticleTexture(): THREE.Texture;
  getUpgradePresentation(type: ShipUpgradeType): {
    name: string;
    short: string;
    icon: string;
    color: string;
    hex: number;
    effect: string;
  };
};

/** How far a cave mouth has eaten into the hillside at one sample point. */
export type CaveMouthCarve = { y: number; carved: number };

/** Ground seat for a decor piece: the centre height, how far to sink it so the
 *  downhill edge stays buried, and the local slope normal. */
export type DecorSeat = { groundY: number; drop: number; normal: THREE.Vector3 };

/** Everything `buildIsland` computes once and hands to its sub-builders. */
export type IslandBuildCtx = {
  /** The outward Game seam (registries, uniforms, lantern budget). */
  readonly host: IslandBuilderCtx;
  readonly island: Island;
  /** The island's root group; every sub-builder adds into it, in call order. */
  readonly group: THREE.Group;
  readonly r: number;
  readonly islandHeading: number;
  readonly footprintX: number;
  readonly footprintZ: number;
  readonly islandSeed: number;
  /** Deterministic per-island hash → 0..1. */
  readonly rng: (seed: number) => number;
  readonly visualDetail: number;
  readonly lowDetail: boolean;
  readonly scaledCount: (base: number, min: number) => number;
  readonly islandMaxR: number;
  readonly isVolcanic: boolean;

  readonly paletteSand: THREE.Color;
  readonly paletteGrass: THREE.Color;
  readonly paletteRock: THREE.Color;
  readonly paletteFoliage: THREE.Color;
  readonly whiteSand: boolean;
  readonly beachColor: THREE.Color;
  readonly sandColor: THREE.Color;
  readonly grassColor: THREE.Color;
  readonly jungleColor: THREE.Color;
  readonly peakColor: THREE.Color;
  readonly cliffColor: THREE.Color;
  readonly mudColor: THREE.Color;

  readonly cliffMat: THREE.MeshStandardMaterial;
  readonly boulderMat: THREE.MeshStandardMaterial;
  readonly driftwoodMat: THREE.MeshStandardMaterial;
  readonly bambooMat: THREE.MeshStandardMaterial;
  readonly shrineMat: THREE.MeshStandardMaterial;
  readonly boulderGeo: THREE.DodecahedronGeometry;
  readonly bambooGeo: THREE.CylinderGeometry;

  /** Island-local point on the shared heightfield at (distRatio, angle). */
  readonly surfacePoint: (distRatio: number, angle: number, extraY?: number) => THREE.Vector3;
  readonly SURFACE_ABOVE_WATER: number;
  readonly seatDecor: (localX: number, localZ: number, footR: number, capSink?: number) => DecorSeat;
  readonly isSolidDecorPoint: (point: THREE.Vector3, minY?: number, margin?: number) => boolean;
  readonly carveCaveMouth: (worldX: number, worldZ: number, y: number) => CaveMouthCarve;

  readonly buildPropInstance: (type: AssetName, position: THREE.Vector3, yaw: number, scale?: number) => THREE.Group | null;
  readonly applyFoliageSway: (material: THREE.Material | THREE.Material[]) => void;
  readonly blendStoryPad: (mesh: THREE.Mesh, island: Island) => void;
};
